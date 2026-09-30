import {
  DropdownComponent,
  ItemView,
  MarkdownView,
  setIcon,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { escapeHtml, placeImages, themes, type ImageRef, type Platform } from '@jinzhang/core';
import { previewDocument } from '@jinzhang/core/preview';
import type JinzhangPlugin from './main';
import { baseName } from './modals/render';
export const VIEW_TYPE = 'jinzhang-preview';
/** 右侧栏预览（设计第 5 节）：跟随当前笔记，500 毫秒防抖，晚返回的旧结果丢弃，不可见时不排版。 */
export class PreviewView extends ItemView {
  private file: TFile | null = null;
  private frame!: HTMLIFrameElement;
  private diagnostics!: HTMLElement;
  private platformButtons = new Map<Platform, HTMLButtonElement>();
  private theme!: DropdownComponent;
  private coverButton!: HTMLButtonElement;
  private version = 0;
  private timer?: number;
  private dirty = false;
  /** 上一次排版的笔记；同一篇重新排版时保留预览的滚动位置。 */
  private shown?: string;
  private urls: string[] = [];
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: JinzhangPlugin,
  ) {
    super(leaf);
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return '锦章预览';
  }
  getIcon() {
    return 'newspaper';
  }
  get currentFile() {
    return this.file;
  }
  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('jinzhang-preview');
    const bar = root.createDiv({ cls: 'jinzhang-toolbar' });
    const segment = bar.createDiv({ cls: 'jinzhang-segment' });
    for (const platform of ['wechat', 'zhihu'] as const) {
      const button = segment.createEl('button', {
        text: platform === 'wechat' ? '公众号' : '知乎',
      });
      button.addEventListener('click', () => void this.setPlatform(platform));
      this.platformButtons.set(platform, button);
    }
    this.theme = new DropdownComponent(bar);
    for (const theme of themes) this.theme.addOption(theme.id, theme.name);
    this.theme.onChange(async (value) => {
      await this.plugin.files.config.update({ theme: value as (typeof themes)[number]['id'] });
      this.schedule(0);
    });
    this.coverButton = bar.createEl('button', { cls: 'jinzhang-cover-button' });
    this.coverButton.addEventListener('click', () => this.file && this.plugin.openCover(this.file));
    bar.createDiv({ cls: 'jinzhang-spacer' });
    const action = (icon: string, label: string, run: () => void) => {
      const button = bar.createEl('button', {
        cls: 'clickable-icon',
        attr: { 'aria-label': label },
      });
      setIcon(button, icon);
      button.addEventListener('click', run);
    };
    action(
      'copy',
      '复制到当前平台',
      () => this.file && this.plugin.copyNote(this.file, this.plugin.prefs.platform),
    );
    action('list-checks', '推送前体检', () => this.file && this.plugin.preflightNote(this.file));
    action('send', '推送到默认平台', () => this.file && this.plugin.pushNote(this.file));
    this.frame = root.createEl('iframe', {
      cls: 'jinzhang-frame',
      attr: { sandbox: 'allow-same-origin', title: '锦章预览' },
    });
    this.diagnostics = root.createDiv({ cls: 'jinzhang-diagnostics' });
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView && view.file && view.file !== this.file) {
          this.file = view.file;
          this.schedule(0);
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on('editor-change', (_editor, info) => {
        if (info.file && info.file === this.file) this.schedule();
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file === this.file) this.schedule();
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file) => {
        if (file === this.file) this.schedule(0);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file !== this.file) return;
        this.file = null;
        this.schedule(0);
      }),
    );
    this.file =
      this.app.workspace.getActiveViewOfType(MarkdownView)?.file ??
      this.app.workspace.getActiveFile();
    this.syncControls();
    this.schedule(0);
  }
  async onClose() {
    window.clearTimeout(this.timer);
    this.version++;
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.urls = [];
  }
  onResize() {
    if (this.dirty) this.schedule(0);
  }
  private syncControls() {
    const platform = this.plugin.prefs.platform;
    for (const [key, button] of this.platformButtons)
      button.toggleClass('is-active', key === platform);
    this.theme.selectEl.toggle(platform === 'wechat');
  }
  async setPlatform(platform: Platform) {
    if (this.plugin.prefs.platform === platform) return;
    this.plugin.prefs.platform = platform;
    await this.plugin.savePrefs();
    this.syncControls();
    this.schedule(0);
  }
  /** 编辑器改动 500 毫秒防抖；切换笔记、平台与设置时立即排版。 */
  schedule(delay = 500) {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.refresh(), delay);
  }
  private blobOf(image: ImageRef, allocated: string[]) {
    const source = image.source;
    if (source.kind === 'missing') return '';
    if (!('bytes' in source)) return source.url;
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(source.bytes)], { type: source.mime }),
    );
    allocated.push(url);
    return url;
  }
  private async refresh() {
    const file = this.file;
    if (!file || file.extension !== 'md') {
      this.frame.srcdoc = '';
      this.diagnostics.empty();
      this.diagnostics.createDiv({ text: '打开一篇 Markdown 笔记后在这里预览。' });
      return;
    }
    if (!this.containerEl.isShown()) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const version = ++this.version;
    const allocated: string[] = [];
    try {
      const config = await this.plugin.files.config.read();
      this.theme.setValue(config.theme);
      const snapshot = await this.plugin.snapshotOf(file);
      const platform = this.plugin.prefs.platform;
      const env = await this.plugin.buildEnv(snapshot, config);
      const built = await this.plugin.build(snapshot, platform, env);
      if (version !== this.version) return;
      const { result } = built;
      const placed = await placeImages(result, {
        put: async (image) => ({ src: this.blobOf(image, allocated) }),
      });
      let html = placed.html;
      const missing = result.images.filter((image) => image.source.kind === 'missing');
      for (const image of missing)
        html = html.replace(
          /<img\b[^>]*src=""[^>]*>/,
          `<section class="missing">图片缺失：${escapeHtml(image.original)}</section>`,
        );
      const coverSrc = result.cover ? this.blobOf(result.cover, allocated) || undefined : undefined;
      const account = await this.plugin.accountName(platform, config);
      if (version !== this.version) {
        allocated.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      const scroll = this.shown === file.path ? (this.frame.contentWindow?.scrollY ?? 0) : 0;
      this.shown = file.path;
      if (scroll)
        this.frame.addEventListener('load', () => this.frame.contentWindow?.scrollTo(0, scroll), {
          once: true,
        });
      this.frame.srcdoc = previewDocument(result, html, {
        coverSrc,
        account,
        date: built.variables.date,
      });
      const previous = this.urls;
      this.urls = allocated;
      window.setTimeout(() => previous.forEach((url) => URL.revokeObjectURL(url)), 1500);
      this.coverButton.setText(
        env.cover ? `封面：${baseName(env.cover)}` : result.cover ? '封面：正文首图' : '未设置封面',
      );
      this.renderDiagnostics(result.cover, missing, [...built.notes, ...result.warnings]);
    } catch (error) {
      allocated.forEach((url) => URL.revokeObjectURL(url));
      if (version !== this.version) return;
      this.diagnostics.empty();
      this.diagnostics.createDiv({
        cls: 'jinzhang-warning',
        text: `排版失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  private renderDiagnostics(
    cover: ImageRef | null,
    missing: ImageRef[],
    warnings: { code: string; message: string; ref?: string }[],
  ) {
    const el = this.diagnostics;
    el.empty();
    const unresolved = [...missing];
    if (cover?.source.kind === 'missing' && !missing.includes(cover)) unresolved.unshift(cover);
    if (unresolved.length) {
      el.createDiv({ cls: 'jinzhang-diagnostics-title', text: '无法解析的图片' });
      const list = el.createEl('ul');
      for (const image of unresolved)
        list.createEl('li', {
          text: `${image.original}：${image.source.kind === 'missing' ? image.source.reason : ''}`,
        });
    }
    const notes = warnings.filter((w) => w.code !== 'IMAGE_MISSING');
    if (notes.length) {
      el.createDiv({ cls: 'jinzhang-diagnostics-title', text: '提示' });
      const list = el.createEl('ul');
      for (const warning of notes)
        list.createEl('li', {
          text: warning.ref ? `${warning.message}（${warning.ref}）` : warning.message,
        });
    }
  }
}
