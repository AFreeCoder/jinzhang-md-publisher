import { App, ButtonComponent, Modal, Setting } from 'obsidian';
import type { Platform } from '@jinzhang/core';
import { PLATFORM_NAMES, type PlatformPlan } from '../push';
import { baseName, coverUrl, draftText, renderErrors, renderWarnings, summaryText } from './render';
/** 推送前确认（设计第 7 节第 3 步）：确认后才出站。 */
export class ConfirmModal extends Modal {
  private decided = false;
  private urls: string[] = [];
  constructor(
    app: App,
    private plans: PlatformPlan[],
    private resolve: (selected: Set<Platform> | null) => void,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('jinzhang-modal');
    const runnable = this.plans.filter((p) => p.status !== 'blocked');
    contentEl.createEl('h2', { text: runnable.length ? '确认推送' : '无法推送' });
    const first = this.plans[0];
    contentEl.createEl('p', { cls: 'jinzhang-title', text: first.report.summary.title });
    const cover = this.plans.find((p) => p.article.result.cover)?.article.result.cover ?? null;
    const coverSrc = coverUrl(cover, this.urls);
    const coverRow = contentEl.createDiv({ cls: 'jinzhang-cover-row' });
    if (coverSrc)
      coverRow.createEl('img', { cls: 'jinzhang-cover-thumb', attr: { src: coverSrc } });
    coverRow.createSpan({ text: cover ? `封面：${baseName(cover.original)}` : '没有封面' });
    const selected = new Set<Platform>(
      this.plans.filter((p) => p.status === 'ready').map((p) => p.platform),
    );
    let confirm: ButtonComponent | undefined;
    const refresh = () => confirm?.setDisabled(!selected.size);
    for (const plan of this.plans) {
      const section = contentEl.createDiv({ cls: `jinzhang-plan is-${plan.status}` });
      const { summary } = plan.report;
      const head = section.createDiv({ cls: 'jinzhang-plan-head' });
      head.createEl('strong', { text: PLATFORM_NAMES[plan.platform] });
      head.createSpan({ text: summary.account ? `　账号：${summary.account}` : '' });
      if (plan.status === 'blocked') {
        section.createDiv({ cls: 'jinzhang-skip', text: '因以下问题本次跳过：' });
        renderErrors(section, plan.report.blockers);
        continue;
      }
      section.createDiv({ text: draftText(summary) });
      section.createDiv({ cls: 'jinzhang-muted', text: summaryText(summary) });
      if (plan.status === 'confirm') {
        renderErrors(section, plan.report.blockers);
        new Setting(section)
          .setName('草稿箱里没有对应草稿')
          .setDesc('已去平台草稿箱核对；如果草稿其实已经建好，先在平台删掉那份再勾选。')
          .addToggle((toggle) =>
            toggle.setValue(false).onChange((value) => {
              if (value) selected.add(plan.platform);
              else selected.delete(plan.platform);
              refresh();
            }),
          );
      }
      renderWarnings(section, plan.report.warnings);
    }
    const buttons = contentEl.createDiv({ cls: 'jinzhang-buttons' });
    new ButtonComponent(buttons)
      .setButtonText(runnable.length ? '取消' : '关闭')
      .onClick(() => this.close());
    if (runnable.length) {
      confirm = new ButtonComponent(buttons)
        .setButtonText('确认推送')
        .setCta()
        .onClick(() => {
          this.decided = true;
          this.resolve(new Set(selected));
          this.close();
        });
      refresh();
    }
  }
  onClose() {
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.contentEl.empty();
    if (!this.decided) this.resolve(null);
  }
}
