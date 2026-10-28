import { App, ButtonComponent, Modal, Setting, TextComponent, ToggleComponent } from 'obsidian';
import { SLUG_PATTERN, type Target } from '@jinzhang/core/publish';
import type { Choice, PlatformPlan } from '../push';
import { baseName, coverUrl, renderErrors, renderWarnings } from './render';
/** 推送前确认（设计第 7 节第 3 步）：确认后才出站。 */
export class ConfirmModal extends Modal {
  private decided = false;
  private urls: string[] = [];
  private timers: number[] = [];
  constructor(
    app: App,
    private plans: PlatformPlan[],
    private resolve: (choices: Map<Target, Choice> | null) => void,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('jinzhang-modal');
    const runnable = this.plans.filter((p) => p.status !== 'blocked');
    contentEl.createEl('h2', { text: runnable.length ? '确认推送' : '无法推送' });
    const first = this.plans[0];
    contentEl.createEl('p', { cls: 'jinzhang-title', text: first.title });
    const cover = this.plans.find((p) => p.cover)?.cover ?? null;
    const coverSrc = coverUrl(cover, this.urls);
    const coverRow = contentEl.createDiv({ cls: 'jinzhang-cover-row' });
    if (coverSrc)
      coverRow.createEl('img', { cls: 'jinzhang-cover-thumb', attr: { src: coverSrc } });
    coverRow.createSpan({ text: cover ? `封面：${baseName(cover.original)}` : '没有封面' });
    const choices = new Map<Target, Choice>();
    let confirm: ButtonComponent | undefined;
    const refresh = () => confirm?.setDisabled(!choices.size);
    for (const plan of this.plans) {
      const section = contentEl.createDiv({ cls: `jinzhang-plan is-${plan.status}` });
      const head = section.createDiv({ cls: 'jinzhang-plan-head' });
      head.createEl('strong', { text: plan.name });
      head.createSpan({ text: plan.account ? `　账号：${plan.account}` : '' });
      if (plan.status === 'blocked') {
        section.createDiv({ cls: 'jinzhang-skip', text: '因以下问题本次跳过：' });
        renderErrors(section, plan.blockers);
        continue;
      }
      section.createDiv({ text: plan.action });
      section.createDiv({ cls: 'jinzhang-muted', text: plan.details });
      if (plan.slug?.editable) this.slugInput(section, plan, choices, refresh);
      else {
        if (plan.status === 'ready') choices.set(plan.target, { slug: plan.slug?.value });
        if (plan.slug?.value && plan.slug.prefix)
          section.createDiv({ cls: 'jinzhang-muted', text: `文章地址：${plan.slug.prefix}${plan.slug.value}` });
      }
      if (plan.status === 'confirm' && plan.confirm) {
        renderErrors(section, plan.blockers);
        new Setting(section)
          .setName(plan.confirm.name)
          .setDesc(plan.confirm.desc)
          .addToggle((toggle) =>
            toggle.setValue(false).onChange((value) => {
              if (value) choices.set(plan.target, { slug: plan.slug?.value });
              else choices.delete(plan.target);
              refresh();
            }),
          );
      }
      renderWarnings(section, plan.warnings);
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
          this.resolve(new Map(choices));
          this.close();
        });
      refresh();
    }
  }
  /**
   * 博客首次推送填写文章地址：停止输入后查网站上是否已有同名文章。没有就可以推送；
   * 已有（比如笔记改过名、换了电脑）要勾选覆盖才推送。
   */
  private slugInput(
    section: HTMLElement,
    plan: PlatformPlan,
    choices: Map<Target, Choice>,
    refresh: () => void,
  ) {
    const field = plan.slug!;
    /** checking 与 error 时不推送；taken 要勾选覆盖。 */
    let state: 'empty' | 'invalid' | 'checking' | 'free' | 'taken' | 'error' = 'empty';
    let version = 0;
    let overwrite = false;
    let input!: TextComponent;
    let toggle!: ToggleComponent;
    new Setting(section)
      .setName('文章地址（slug）')
      .setDesc(field.prefix)
      .addText((text) => {
        input = text;
        text.setPlaceholder('how-to-use-chatgpt').setValue(field.value);
      })
      .settingEl.addClass('jinzhang-slug');
    const status = section.createDiv({ cls: 'jinzhang-muted' });
    const overwriteSetting = new Setting(section)
      .setName('覆盖网站上的这篇文章')
      .setDesc('只有那篇就是这篇笔记时才勾选，比如笔记改过名或换了电脑。')
      .addToggle((t) => {
        toggle = t.setValue(false).onChange((value) => {
          overwrite = value;
          update();
        });
      });
    overwriteSetting.settingEl.hide();
    const slugOf = () => input.getValue().trim().toLowerCase();
    const update = () => {
      if (state === 'free' || (state === 'taken' && overwrite))
        choices.set(plan.target, { slug: slugOf(), overwrite: state === 'taken' });
      else choices.delete(plan.target);
      overwriteSetting.settingEl.toggle(state === 'taken');
      refresh();
    };
    const check = () => {
      const current = ++version;
      const slug = slugOf();
      overwrite = false;
      toggle.setValue(false);
      state = !slug ? 'empty' : SLUG_PATTERN.test(slug) ? 'checking' : 'invalid';
      status.setText(
        state === 'empty'
          ? '填写后才会推送到这里：小写字母、数字、-、_。'
          : state === 'invalid'
            ? '只能用小写字母、数字、-、_，并以字母或数字开头。'
            : '检查网站上是否已有这个地址…',
      );
      update();
      if (state !== 'checking') return;
      this.timers.push(
        window.setTimeout(async () => {
          try {
            const result = await field.check(slug);
            if (current !== version) return;
            if (result.state === 'free') {
              state = 'free';
              status.setText(`可以使用：${field.prefix}${slug}`);
            } else {
              state = 'taken';
              const published = result.remote.status === 'published' ? '已发布' : '未发布';
              status.setText(`网站上已有这个地址的文章《${result.remote.title}》（${published}）。`);
            }
          } catch (error) {
            if (current !== version) return;
            state = 'error';
            status.setText(`检查失败：${error instanceof Error ? error.message : String(error)}`);
          }
          update();
        }, 400),
      );
    };
    input.onChange(check);
    check();
  }
  onClose() {
    this.timers.forEach((timer) => window.clearTimeout(timer));
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.contentEl.empty();
    if (!this.decided) this.resolve(null);
  }
}
