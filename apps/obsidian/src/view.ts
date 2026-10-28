import {
  DropdownComponent,
  getFrontMatterInfo,
  ItemView,
  MarkdownView,
  setIcon,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { escapeHtml, placeImages, themes, type ImageRef, type Platform } from '@jinzhang/core';
import { previewDocument } from '@jinzhang/core/preview';
import type JinzhangPlugin from './main';
import { baseName, displayRef } from './modals/render';
import { buildAnchors, headingKey, scrollTarget, sourceOutline } from './scroll-sync';
export const VIEW_TYPE = 'jinzhang-preview';
/** 右侧栏预览（设计第 5 节）：跟随当前笔记，500 毫秒防抖，晚返回的旧结果丢弃，不可见时不排版；滚动跟随编辑器。 */
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
  /** 预览当前应显示的整页文档；就地更新后与 iframe 的 `srcdoc` 属性不再一致。 */
  private markup = '';
  /** 整页重设 `srcdoc` 后、加载完成前为 true，期间的改动仍整页重设。 */
  private loading = false;
  /** 按图片来源缓存的 blob 地址：字节没变就沿用，就地更新时图片不用重新加载。 */
  private blobs = new Map<string, CachedBlob>();
  /** 整页重设前的滚动位置，编辑器里没打开这篇笔记、无从跟随时用它恢复。 */
  private restore = 0;
  private syncFrame = 0;
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
    // 工具栏三个动作都跟随当前选中的平台；同时推两个平台用命令「推送到默认平台」。
    action(
      'list-checks',
      '推送前体检（当前平台，只检查不推送）',
      () => this.file && this.plugin.preflightNote(this.file, [this.plugin.prefs.platform]),
    );
    action(
      'send',
      '推送到当前平台',
      () => this.file && this.plugin.pushNote(this.file, [this.plugin.prefs.platform]),
    );
    // 博客不在预览里切换：网站用自己的样式渲染 Markdown，锦章只负责提交。
    action('globe', '推送到博客', () => this.file && void this.plugin.pushBlog(this.file));
    this.frame = root.createEl('iframe', {
      cls: 'jinzhang-frame',
      attr: { sandbox: 'allow-same-origin', title: '锦章预览' },
    });
    this.frame.addEventListener('load', () => {
      this.loading = false;
      const doc = this.frame.contentDocument;
      // 链接在 iframe 里跳转会把预览换成外站页面，改为交给系统浏览器打开。
      doc?.addEventListener('click', (event) => this.openLink(event));
      // 后加载的图片会撑开页面，标题位置变了要重新对齐。
      doc?.addEventListener('load', () => this.queueSync(), true);
      // 视图挪到别的面板时 iframe 会按 srcdoc 属性重载，就地更新过的正文要补回来。
      if (doc && this.frame.srcdoc !== this.markup) this.patch(doc, this.markup);
      if (!this.syncScroll() && this.restore) this.frame.contentWindow?.scrollTo(0, this.restore);
      this.restore = 0;
    });
    // 编辑器滚动不冒泡，在捕获阶段统一接住，只理会正在预览的这篇笔记。
    this.registerDomEvent(
      document,
      'scroll',
      (event) => {
        const target = event.target;
        if (target instanceof Node && this.sourceView()?.contentEl.contains(target))
          this.queueSync();
      },
      { capture: true, passive: true },
    );
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
    // 启动时从工作区恢复的预览先于布局就绪打开，那时还取不到当前笔记，就绪后再取一次。
    this.app.workspace.onLayoutReady(() => {
      if (this.file) return;
      const recent = this.app.workspace.getMostRecentLeaf()?.view;
      this.file = recent instanceof MarkdownView ? recent.file : this.app.workspace.getActiveFile();
      if (this.file) this.schedule(0);
    });
  }
  /** 页内锚点照常跳转；http(s) 链接用系统浏览器打开，其余链接不响应。 */
  private openLink(event: MouseEvent) {
    const link = (event.target as Element | null)?.closest?.('a[href]');
    const href = link?.getAttribute('href') ?? '';
    if (!link || href.startsWith('#')) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(href)) window.open(href);
  }
  async onClose() {
    window.clearTimeout(this.timer);
    window.cancelAnimationFrame(this.syncFrame);
    this.version++;
    this.blobs.forEach((blob) => URL.revokeObjectURL(blob.url));
    this.blobs.clear();
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
  private blobOf(image: ImageRef, used: Map<string, CachedBlob>, allocated: string[]) {
    const source = image.source;
    if (source.kind === 'missing') return '';
    if (!('bytes' in source)) return source.url;
    const key = source.assetId ?? image.original;
    const cached = used.get(key) ?? this.blobs.get(key);
    if (cached?.mime === source.mime && sameBytes(cached.bytes, source.bytes)) {
      used.set(key, cached);
      return cached.url;
    }
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(source.bytes)], { type: source.mime }),
    );
    allocated.push(url);
    used.set(key, { bytes: source.bytes, mime: source.mime, url });
    return url;
  }
  /**
   * 同一篇笔记、页面样式不变时就地换掉正文，不重载 iframe：编辑时预览不白屏、图片不重新加载、滚动位置不跳。
   * 换笔记、换平台或页面还在加载时整页重设 `srcdoc`。
   */
  private show(markup: string, sameNote: boolean) {
    const doc = this.frame.contentDocument;
    if (markup === this.markup && doc) return;
    this.markup = markup;
    if (sameNote && !this.loading && doc && this.patch(doc, markup)) {
      this.syncScroll();
      return;
    }
    // iframe 被导航到别处（跨域）时 contentDocument 为 null，读不到滚动位置就从顶部开始，重设 srcdoc 后预览恢复。
    this.restore = sameNote ? (doc?.defaultView?.scrollY ?? 0) : 0;
    this.loading = true;
    this.frame.srcdoc = markup;
  }
  /** 把整页文档的正文换进已加载的预览；头部（样式与安全策略）不同时返回 false，由调用方整页重设。 */
  private patch(doc: Document, markup: string) {
    const next = new DOMParser().parseFromString(markup, 'text/html');
    if (!doc.body || next.head.innerHTML !== doc.head.innerHTML) return false;
    doc.body.innerHTML = next.body.innerHTML;
    return true;
  }
  /** 正在预览的笔记所在的编辑器，优先当前活动的那个。 */
  private sourceView() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active && active.file === this.file) return active;
    return (
      this.app.workspace
        .getLeavesOfType('markdown')
        .map((leaf) => leaf.view)
        .find(
          (view): view is MarkdownView => view instanceof MarkdownView && view.file === this.file,
        ) ?? null
    );
  }
  private queueSync() {
    if (this.syncFrame) return;
    this.syncFrame = window.requestAnimationFrame(() => {
      this.syncFrame = 0;
      this.syncScroll();
    });
  }
  /**
   * 把预览滚到与编辑器对应的位置（单向，预览自己滚动不影响编辑器）：编辑器顶部所在行按标题锚点插值，
   * 编辑器滚到底时预览也到底。编辑器里没打开这篇笔记或预览还没就绪时返回 false。
   */
  private syncScroll() {
    const view = this.sourceView();
    const doc = this.frame.contentDocument;
    const win = doc?.defaultView;
    if (!view?.file || view.file.path !== this.shown || !doc?.body || !win || this.loading)
      return false;
    if (!this.containerEl.isShown()) return false;
    const max = Math.max(0, doc.documentElement.scrollHeight - win.innerHeight);
    const scroller = view.contentEl.querySelector<HTMLElement>(
      view.getMode() === 'source' ? '.cm-scroller' : '.markdown-preview-view',
    );
    const room = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
    if (scroller && room > 2 && scroller.scrollTop >= room - 2) {
      win.scrollTo(0, max);
      return true;
    }
    const text = view.editor.getValue();
    const targets = [...doc.querySelectorAll('#jz-body :is(h1, h2, h3, h4, h5, h6)')].map((el) => ({
      key: headingKey(el.textContent ?? ''),
      y: el.getBoundingClientRect().top + win.scrollY,
    }));
    const anchors = buildAnchors(
      sourceOutline(text, getFrontMatterInfo(text).contentStart),
      targets,
      max,
    );
    win.scrollTo(0, scrollTarget(view.currentMode.getScroll(), anchors));
    return true;
  }
  private async refresh() {
    const file = this.file;
    if (!file || file.extension !== 'md') {
      this.show('', false);
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
    const used = new Map<string, CachedBlob>();
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
        put: async (image) => ({ src: this.blobOf(image, used, allocated) }),
      });
      let html = placed.html;
      const missing = result.images.filter((image) => image.source.kind === 'missing');
      for (const image of missing)
        html = html.replace(
          /<img\b[^>]*src=""[^>]*>/,
          `<section class="missing">图片缺失：${escapeHtml(displayRef(image.original))}</section>`,
        );
      const coverSrc = result.cover
        ? this.blobOf(result.cover, used, allocated) || undefined
        : undefined;
      const account = await this.plugin.accountName(platform, config);
      if (version !== this.version) {
        allocated.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      const sameNote = this.shown === file.path;
      this.shown = file.path;
      this.show(
        previewDocument(result, html, { coverSrc, account, date: built.variables.date }),
        sameNote,
      );
      const kept = new Set([...used.values()].map((blob) => blob.url));
      const stale = [...this.blobs.values()]
        .map((blob) => blob.url)
        .concat(allocated)
        .filter((url) => !kept.has(url));
      this.blobs = used;
      window.setTimeout(() => stale.forEach((url) => URL.revokeObjectURL(url)), 1500);
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
          text: `${displayRef(image.original)}：${image.source.kind === 'missing' ? image.source.reason : ''}`,
        });
    }
    const notes = warnings.filter((w) => w.code !== 'IMAGE_MISSING');
    if (notes.length) {
      el.createDiv({ cls: 'jinzhang-diagnostics-title', text: '提示' });
      const list = el.createEl('ul');
      for (const warning of notes)
        list.createEl('li', {
          text: warning.ref ? `${warning.message}（${displayRef(warning.ref)}）` : warning.message,
        });
    }
  }
}
interface CachedBlob {
  bytes: Uint8Array;
  mime: string;
  url: string;
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
