import { App, ButtonComponent, Modal, Notice, TextAreaComponent } from 'obsidian';
import { parseZhihuCookies, type ZhihuUser } from '@jinzhang/core/publish';
export const ZHIHU_PARTITION = 'persist:jinzhang-zhihu';
const SIGNIN = 'https://www.zhihu.com/signin';
interface ElectronCookie {
  name: string;
  value: string;
}
interface ElectronSession {
  cookies: { get(filter: { url: string }): Promise<ElectronCookie[]> };
  clearStorageData(options?: unknown): Promise<void>;
}
/** 取 `@electron/remote`；不可用时返回 undefined，登录退化为粘贴 cookie。 */
function remote(): { session: { fromPartition(partition: string): ElectronSession } } | undefined {
  try {
    return (window as unknown as { require?: (id: string) => any }).require?.('@electron/remote');
  } catch {
    return undefined;
  }
}
/** 退出时清掉插件登录页的独立会话，不影响 Obsidian 内置网页查看器。 */
export async function clearZhihuPartition() {
  await remote()?.session.fromPartition(ZHIHU_PARTITION).clearStorageData();
}
/**
 * 知乎登录（设计第 11 节）：弹窗里用 webview 打开登录页，独立 partition；扫码登录回到首页后
 * 经 `@electron/remote` 读这个会话的 cookie。webview 或 remote 不可用时改为粘贴 cookie。
 */
export class ZhihuLoginModal extends Modal {
  private finished = false;
  private timer?: number;
  constructor(
    app: App,
    private save: (cookies: Record<string, string>) => Promise<ZhihuUser>,
    private done: (user: ZhihuUser) => void,
  ) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass('jinzhang-login-modal');
    this.contentEl.addClass('jinzhang-modal', 'jinzhang-zhihu-login');
    this.titleEl.setText('登录知乎');
    const electron = remote();
    if (!electron) {
      this.showPaste('当前环境读不到登录页的 cookie，请改用粘贴。');
      return;
    }
    this.showWebview(electron);
  }
  private async finish(cookies: Record<string, string>) {
    if (this.finished) return false;
    const { missing } = parseZhihuCookies(
      Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; '),
    );
    if (missing.length) return false;
    this.finished = true;
    try {
      const user = await this.save(cookies);
      new Notice(`已登录知乎：${user.name}`);
      this.done(user);
      this.close();
      return true;
    } catch (error) {
      this.finished = false;
      new Notice(error instanceof Error ? error.message : '登录校验失败，请重试。');
      return false;
    }
  }
  private showWebview(electron: NonNullable<ReturnType<typeof remote>>) {
    const { contentEl } = this;
    contentEl.createEl('p', {
      cls: 'jinzhang-muted',
      text: '用知乎 App 扫码或在下面完成登录；需要滑动验证时就在这里完成。登录后回到知乎首页会自动读取登录态。',
    });
    const webview = document.createElement('webview') as HTMLElement & {
      getURL?: () => string;
    };
    webview.setAttribute('partition', ZHIHU_PARTITION);
    webview.setAttribute('src', SIGNIN);
    webview.addClass('jinzhang-webview');
    const session = electron.session.fromPartition(ZHIHU_PARTITION);
    const check = async () => {
      const url = webview.getURL?.() ?? '';
      if (!url.startsWith('https://www.zhihu.com/') || url.startsWith(SIGNIN)) return;
      const cookies = await session.cookies.get({ url: 'https://www.zhihu.com' });
      await this.finish(Object.fromEntries(cookies.map((c) => [c.name, c.value])));
    };
    for (const event of ['did-navigate', 'did-navigate-in-page', 'did-finish-load'])
      webview.addEventListener(event, () => void check().catch(() => {}));
    webview.addEventListener('did-fail-load', () => {
      if (!this.finished) this.showPaste('登录页加载失败，可以改用粘贴 cookie。');
    });
    contentEl.appendChild(webview);
    // 部分环境里 webview 标签不生效（不会触发任何事件），给出粘贴入口。
    this.timer = window.setTimeout(() => {
      if (!webview.getURL) this.showPaste('登录页没能在弹窗里打开，请改用粘贴 cookie。');
    }, 8000);
    new ButtonComponent(contentEl.createDiv({ cls: 'jinzhang-buttons' }))
      .setButtonText('改用粘贴 cookie')
      .onClick(() => this.showPaste());
  }
  private showPaste(reason?: string) {
    window.clearTimeout(this.timer);
    const { contentEl } = this;
    contentEl.empty();
    if (reason) contentEl.createEl('p', { text: reason });
    contentEl.createEl('p', {
      cls: 'jinzhang-muted',
      text: '在浏览器里登录知乎，打开开发者工具，把 www.zhihu.com 请求头里的 Cookie（或 Application 面板里的 cookie 表格）整段复制过来，至少要有 z_c0、_xsrf、d_c0。',
    });
    const input = new TextAreaComponent(contentEl);
    input.inputEl.addClass('jinzhang-cookie-input');
    input.setPlaceholder('z_c0=…; _xsrf=…; d_c0=…');
    new ButtonComponent(contentEl.createDiv({ cls: 'jinzhang-buttons' }))
      .setButtonText('保存并校验')
      .setCta()
      .onClick(async () => {
        const { cookies, missing } = parseZhihuCookies(input.getValue());
        if (missing.length) {
          new Notice(`缺少 ${missing.join('、')}，请复制完整的 cookie。`);
          return;
        }
        await this.finish(cookies);
      });
  }
  onClose() {
    window.clearTimeout(this.timer);
    this.contentEl.empty();
  }
}
