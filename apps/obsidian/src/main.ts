import {
  FileSystemAdapter,
  getFrontMatterInfo,
  MarkdownView,
  Notice,
  Plugin,
  type TFile,
} from 'obsidian';
import { mkdir } from 'node:fs/promises';
import type { Platform } from '@jinzhang/core';
import {
  jinzhangHome,
  localFiles,
  normalizeSourcePath,
  type LocalFiles,
} from '@jinzhang/core/node';
import {
  readZhihuSession,
  saveZhihuLogin,
  type JinzhangConfig,
  type ZhihuUser,
} from '@jinzhang/core/publish';
import { buildArticle, type BuildEnv, type Snapshot } from './article';
import { COPIED, copyTarget, placeForCopy, writeClipboard, type Placed } from './copy';
import { createHost, ObsidianVault } from './host';
import { ConfirmModal } from './modals/confirm';
import { CoverModal } from './modals/cover';
import { ManualCopyModal } from './modals/manual-copy';
import { PreflightModal, ResultModal } from './modals/report';
import { clearZhihuPartition, ZhihuLoginModal } from './modals/zhihu-login';
import { planPush, runPush } from './push';
import { joinDisk } from './resolver';
import { JinzhangSettingTab } from './settings';
import { PreviewView, VIEW_TYPE } from './view';
const IMAGE = /^(png|jpe?g|gif|webp|svg|bmp|avif|tiff?)$/i;
/** 插件自己的 data.json 只放界面偏好，不放凭证，避免随 vault 同步。 */
interface Prefs {
  platform: Platform;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export default class JinzhangPlugin extends Plugin {
  prefs: Prefs = { platform: 'wechat' };
  files!: LocalFiles;
  host!: ReturnType<typeof createHost>;
  private vault!: ObsidianVault;
  private basePath = '';
  private pushing = new Set<string>();
  async onload() {
    const saved = await this.loadData();
    if (saved?.platform === 'zhihu') this.prefs.platform = 'zhihu';
    const adapter = this.app.vault.adapter;
    this.basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
    this.files = localFiles(jinzhangHome());
    this.vault = new ObsidianVault(this.app);
    this.host = createHost(this.app, this.files, this.vault, this.basePath);
    this.registerView(VIEW_TYPE, (leaf) => new PreviewView(leaf, this));
    const note = (run: (file: TFile) => void) => (checking: boolean) => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) run(file);
      return true;
    };
    this.addCommand({ id: 'open-preview', name: '打开预览', callback: () => this.openPreview() });
    this.addCommand({
      id: 'push-default',
      name: '推送到默认平台',
      checkCallback: note((file) => this.pushNote(file)),
    });
    this.addCommand({
      id: 'push-wechat',
      name: '推送到公众号',
      checkCallback: note((file) => this.pushNote(file, ['wechat'])),
    });
    this.addCommand({
      id: 'push-zhihu',
      name: '推送到知乎',
      checkCallback: note((file) => this.pushNote(file, ['zhihu'])),
    });
    this.addCommand({
      id: 'preflight',
      name: '推送前体检',
      checkCallback: note((file) => this.preflightNote(file)),
    });
    this.addCommand({
      id: 'copy-wechat',
      name: '复制为公众号格式',
      checkCallback: note((file) => this.copyNote(file, 'wechat')),
    });
    this.addCommand({
      id: 'copy-zhihu',
      name: '复制为知乎格式',
      checkCallback: note((file) => this.copyNote(file, 'zhihu')),
    });
    this.addCommand({
      id: 'set-cover',
      name: '设置本文封面',
      checkCallback: note((file) => this.openCover(file)),
    });
    this.addCommand({ id: 'zhihu-login', name: '登录知乎', callback: () => this.loginZhihu() });
    this.addSettingTab(new JinzhangSettingTab(this.app, this));
  }
  async savePrefs() {
    await this.saveData(this.prefs);
  }
  /** 在右侧栏打开预览，已打开则切过去。 */
  async openPreview() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const right = this.app.workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: VIEW_TYPE, active: true });
      leaf = right;
    }
    this.app.workspace.revealLeaf(leaf);
  }
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE))
      if (leaf.view instanceof PreviewView) leaf.view.schedule(0);
  }
  /** 当前笔记在编辑器里的文本（含未保存的改动），编辑器里没打开时读文件。 */
  async snapshotOf(file: TFile): Promise<Snapshot> {
    const editor = this.app.workspace
      .getLeavesOfType('markdown')
      .map((leaf) => leaf.view)
      .find((view): view is MarkdownView => view instanceof MarkdownView && view.file === file);
    const content = editor ? editor.editor.getValue() : await this.app.vault.cachedRead(file);
    const info = getFrontMatterInfo(content);
    return {
      path: file.path,
      source: normalizeSourcePath(joinDisk(this.basePath, file.path)),
      title: file.basename,
      content,
      contentStart: info.exists ? info.contentStart : 0,
    };
  }
  async buildEnv(snapshot: Snapshot, current?: JinzhangConfig): Promise<BuildEnv> {
    const config = current ?? (await this.files.config.read());
    this.host.setProxy(config.wechat.proxy);
    const cover = (await this.files.state.read()).articles[snapshot.source]?.cover;
    return {
      vault: this.vault,
      basePath: this.basePath,
      config,
      footers: {
        wechat: await this.files.templates.read('wechat', 'footer'),
        zhihu: await this.files.templates.read('zhihu', 'footer'),
      },
      cover: typeof cover === 'string' && cover ? cover : undefined,
      resolveEmbed: (linkpath, notePath) => {
        const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, notePath);
        return file ? { path: file.path, isImage: IMAGE.test(file.extension) } : null;
      },
    };
  }
  build(snapshot: Snapshot, platform: Platform, env: BuildEnv) {
    return buildArticle(snapshot, platform, env);
  }
  async accountName(platform: Platform, config: JinzhangConfig) {
    if (platform === 'zhihu') return (await readZhihuSession(this.host))?.user?.name;
    return config.wechat.card.nickname || undefined;
  }
  private async prepareFlow(file: TFile) {
    const snapshot = await this.snapshotOf(file);
    const config = await this.files.config.read();
    const env = await this.buildEnv(snapshot, config);
    return {
      snapshot,
      config,
      host: this.host,
      build: (platform: Platform) => this.build(snapshot, platform, env),
    };
  }
  /** 推送（设计第 7 节）：体检、确认、逐平台投递、结果；同一篇笔记推送期间不允许重复触发。 */
  async pushNote(file: TFile, platforms?: Platform[]) {
    if (this.pushing.has(file.path)) {
      new Notice('这篇笔记正在推送，请等本次结束。');
      return;
    }
    this.pushing.add(file.path);
    let notice: Notice | undefined;
    const progress = (text: string) => {
      notice ??= new Notice('', 0);
      notice.setMessage(`锦章：${text}`);
    };
    try {
      const flow = await this.prepareFlow(file);
      const targets = platforms ?? flow.config.targets;
      if (!targets.length) {
        new Notice('还没有选默认推送平台，请在设置 → 锦章 → 排版里打开。');
        return;
      }
      await runPush(flow, targets, {
        progress,
        confirm: (plans) => {
          notice?.hide();
          notice = undefined;
          return new Promise((resolve) => new ConfirmModal(this.app, plans, resolve).open());
        },
        finish: (outcomes) => {
          notice?.hide();
          notice = undefined;
          new ResultModal(this.app, outcomes).open();
        },
      });
    } catch (error) {
      new Notice(`推送没有完成：${message(error)}`, 10_000);
    } finally {
      notice?.hide();
      this.pushing.delete(file.path);
      this.refreshViews();
    }
  }
  async preflightNote(file: TFile, platforms?: Platform[]) {
    const notice = new Notice('锦章：体检中…', 0);
    try {
      const flow = await this.prepareFlow(file);
      const plans = await planPush(
        { ...flow, progress: (text) => notice.setMessage(`锦章：${text}`) },
        platforms ?? (flow.config.targets.length ? flow.config.targets : ['wechat', 'zhihu']),
      );
      notice.hide();
      new PreflightModal(this.app, plans).open();
    } catch (error) {
      notice.hide();
      new Notice(`体检没有完成：${message(error)}`, 10_000);
    }
  }
  private async tryWrite(placed: Placed) {
    try {
      await writeClipboard(placed);
      const warnings = placed.warnings.map((w) => w.message).join(' ');
      new Notice(warnings ? `${COPIED}。${warnings}` : COPIED, 8000);
      return true;
    } catch {
      return false;
    }
  }
  /** 复制粘贴兜底（设计第 8 节）：写入失败时打开手动复制，重试复用已上传的图片。 */
  async copyNote(file: TFile, platform: Platform) {
    const notice = new Notice(`锦章：正在准备${copyTarget(platform)}正文…`, 0);
    try {
      const flow = await this.prepareFlow(file);
      const built = await flow.build(platform);
      const placed = await placeForCopy(
        built.result,
        {
          host: this.host,
          source: flow.snapshot.source,
          config: flow.config,
          fixed: built.fixed,
        },
        (text) => notice.setMessage(`锦章：${text}`),
      );
      notice.hide();
      if (!(await this.tryWrite(placed)))
        new ManualCopyModal(this.app, built.result, placed.html, () =>
          this.tryWrite(placed),
        ).open();
    } catch (error) {
      notice.hide();
      new Notice(`复制没有完成：${message(error)}`, 10_000);
    }
  }
  /** 封面选择（设计第 9 节）：按源文件绝对路径存进共享状态，命令行推送同一篇时同样生效。 */
  async openCover(file: TFile) {
    try {
      const flow = await this.prepareFlow(file);
      const env = await this.buildEnv(flow.snapshot, flow.config);
      const built = await flow.build('wechat');
      const source = flow.snapshot.source;
      new CoverModal(this.app, {
        explicit: env.cover,
        effective: built.result.cover,
        save: async (image) => {
          await this.files.state.update((state) => {
            const article = (state.articles[source] ??= {});
            if (image) article.cover = normalizeSourcePath(joinDisk(this.basePath, image.path));
            else {
              delete article.cover;
              if (!Object.keys(article).length) delete state.articles[source];
            }
          });
          new Notice(image ? `已设置封面：${image.name}` : '已清除单独设置的封面，改用正文首图');
          this.refreshViews();
        },
      }).open();
    } catch (error) {
      new Notice(`读取封面失败：${message(error)}`, 10_000);
    }
  }
  loginZhihu(done?: (user: ZhihuUser) => void) {
    new ZhihuLoginModal(
      this.app,
      (cookies) => saveZhihuLogin(this.host, cookies),
      (user) => {
        done?.(user);
        this.refreshViews();
      },
    ).open();
  }
  async logoutZhihu() {
    await this.files.secrets.remove('zhihu-session');
    await clearZhihuPartition().catch(() => {});
    this.refreshViews();
  }
  async openTemplatesDir() {
    const dir = this.files.templates
      .path('wechat', 'header')
      .replace(/[\\/]wechat[\\/]header\.md$/, '');
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const { shell } = (window as unknown as { require: (id: string) => any }).require('electron');
      const failed: string = await shell.openPath(dir);
      if (failed) throw new Error(failed);
    } catch {
      new Notice(`模板目录：${dir}`, 10_000);
    }
  }
}
