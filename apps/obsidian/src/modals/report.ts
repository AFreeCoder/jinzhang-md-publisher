import { App, ButtonComponent, Modal } from 'obsidian';
import { WECHAT_ENTRY_URL } from '@jinzhang/core/publish';
import { PLATFORM_NAMES, type PlatformPlan, type PushOutcome } from '../push';
import { draftText, renderErrors, renderWarnings, summaryText } from './render';
/** 体检结果：逐平台列出状态，阻塞项写明原因与下一步。 */
export class PreflightModal extends Modal {
  constructor(
    app: App,
    private plans: PlatformPlan[],
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('jinzhang-modal');
    contentEl.createEl('h2', { text: '推送前体检' });
    for (const plan of this.plans) {
      const section = contentEl.createDiv({ cls: `jinzhang-plan is-${plan.status}` });
      const { summary } = plan.report;
      const head = section.createDiv({ cls: 'jinzhang-plan-head' });
      head.createEl('strong', { text: PLATFORM_NAMES[plan.platform] });
      head.createSpan({
        text:
          plan.status === 'ready'
            ? '　可以推送'
            : plan.status === 'confirm'
              ? '　需要先核对草稿箱'
              : '　有阻塞项',
      });
      if (summary.account) section.createDiv({ text: `账号：${summary.account}` });
      section.createDiv({ text: draftText(summary) });
      section.createDiv({ cls: 'jinzhang-muted', text: summaryText(summary) });
      renderErrors(section, plan.report.blockers);
      renderWarnings(section, plan.report.warnings);
    }
    contentEl.createDiv({
      cls: 'jinzhang-muted',
      text: '体检通过不保证推送一定成功，网络、登录态或平台规则变化时会在结果里说明。',
    });
    new ButtonComponent(contentEl.createDiv({ cls: 'jinzhang-buttons' }))
      .setButtonText('关闭')
      .onClick(() => this.close());
  }
  onClose() {
    this.contentEl.empty();
  }
}
/** 推送结果（设计第 7 节第 5 步）：成功给入口与警告，失败给原因与下一步，结果不确定先去草稿箱核对。 */
export class ResultModal extends Modal {
  constructor(
    app: App,
    private outcomes: PushOutcome[],
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('jinzhang-modal');
    contentEl.createEl('h2', { text: '推送结果' });
    for (const outcome of this.outcomes) {
      const section = contentEl.createDiv({ cls: `jinzhang-plan is-${outcome.status}` });
      const head = section.createDiv({ cls: 'jinzhang-plan-head' });
      head.createEl('strong', { text: PLATFORM_NAMES[outcome.platform] });
      const result = outcome.result;
      if (outcome.status === 'skipped') {
        head.createSpan({ text: '　未执行' });
        renderErrors(section, outcome.blockers ?? []);
        continue;
      }
      if (!result) continue;
      if (result.outcome === 'created' || result.outcome === 'updated') {
        head.createSpan({ text: result.outcome === 'created' ? '　已创建草稿' : '　已更新草稿' });
        const where =
          outcome.platform === 'wechat'
            ? '在公众号后台「内容管理 → 草稿箱」里找到这篇'
            : '也可以在知乎创作中心的草稿箱里找到';
        section.createDiv({ cls: 'jinzhang-muted', text: where });
        if (result.verification === 'unverified')
          section.createDiv({ text: '草稿已写入，但回读校验没有通过，请到草稿箱核对。' });
        new ButtonComponent(section.createDiv())
          .setButtonText('打开草稿')
          .onClick(() => window.open(result.entryUrl || WECHAT_ENTRY_URL));
        renderWarnings(section, result.warnings);
      } else if (result.outcome === 'uncertain') {
        head.createSpan({ text: '　结果不确定，先去草稿箱确认' });
        renderErrors(section, [result.error]);
      } else if (result.outcome === 'failed') {
        head.createSpan({ text: '　失败' });
        renderErrors(section, [result.error]);
      }
    }
    new ButtonComponent(contentEl.createDiv({ cls: 'jinzhang-buttons' }))
      .setButtonText('关闭')
      .onClick(() => this.close());
  }
  onClose() {
    this.contentEl.empty();
  }
}
