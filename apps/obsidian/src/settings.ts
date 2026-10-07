import { App, Notice, PluginSettingTab, Setting, TextAreaComponent } from 'obsidian';
import { themes, type Platform } from '@jinzhang/core';
import {
  probeEgressIp,
  readCredentials,
  WHITELIST_PATH,
  zhihuStatus,
  type JinzhangConfig,
} from '@jinzhang/core/publish';
import type JinzhangPlugin from './main';
import { PLATFORM_NAMES } from './push';
const FAKEID_GUIDE = 'https://github.com/doocs/md/blob/main/docs/mp-card.md';
/**
 * 设置页（设计第 10 节）：除界面偏好外读写的都是配置目录里的文件，每次打开重新读取，
 * 与命令行的修改互通。凭证只写不回显。
 */
export class JinzhangSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: JinzhangPlugin,
  ) {
    super(app, plugin);
  }
  private rendering = 0;
  async display() {
    // 先读完配置目录再同步绘制；重复调用时只保留最后一次，避免界面重复。
    const token = ++this.rendering;
    const { containerEl } = this;
    const files = this.plugin.files;
    let config: JinzhangConfig;
    let credentials: Awaited<ReturnType<typeof readCredentials>>;
    const footers = { wechat: '', zhihu: '' };
    try {
      config = await files.config.read();
      credentials = await readCredentials(this.plugin.host);
      for (const platform of ['wechat', 'zhihu'] as const)
        footers[platform] = await files.templates.read(platform, 'footer');
    } catch (error) {
      if (token !== this.rendering) return;
      containerEl.empty();
      containerEl.createEl('p', {
        cls: 'jinzhang-warning',
        text: `读取配置失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (token !== this.rendering) return;
    containerEl.empty();
    containerEl.addClass('jinzhang-settings');
    const update = async (patch: Parameters<typeof files.config.update>[0]) => {
      config = await files.config.update(patch);
      this.plugin.refreshViews();
    };
    const timers = new Map<string, number>();
    /** 文本框停止输入后再写配置，避免每个按键都写一次文件。 */
    const later = (key: string, run: () => Promise<void>) => {
      window.clearTimeout(timers.get(key));
      timers.set(
        key,
        window.setTimeout(() => void run(), 600),
      );
    };
    containerEl.createEl('h3', { text: '公众号' });
    let appId = credentials?.appId ?? '';
    let appSecret = '';
    new Setting(containerEl)
      .setName('AppID')
      .setDesc('公众号后台「设置与开发 → 基本配置」里的开发者 ID')
      .addText((text) => text.setValue(appId).onChange((value) => (appId = value.trim())));
    new Setting(containerEl)
      .setName('AppSecret')
      .setDesc(
        credentials ? '已设置。输入新值后保存即可替换，界面不会显示已保存的值。' : '尚未设置',
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder(credentials ? '已设置' : '')
          .onChange((value) => (appSecret = value.trim()));
      });
    new Setting(containerEl)
      .setDesc(
        '凭证只保存在本机配置目录的 credentials.json（仅当前用户可读写），与命令行共用，不随 vault 同步。',
      )
      .addButton((button) =>
        button
          .setButtonText('保存凭证')
          .setCta()
          .onClick(async () => {
            const secret = appSecret || credentials?.appSecret || '';
            if (!appId || !secret) {
              new Notice('请同时填写 AppID 与 AppSecret。');
              return;
            }
            await files.secrets.set('credentials', {
              ...((await files.secrets.get('credentials')) ?? {}),
              wechat: { appId, appSecret: secret },
            });
            await files.secrets.remove('wechat-token');
            new Notice('公众号凭证已保存。');
            void this.display();
          }),
      );
    const ipSetting = new Setting(containerEl)
      .setName('出口 IP 与白名单')
      .setDesc(
        `把探测到的出口 IP 加到${WHITELIST_PATH}。家庭宽带的 IP 会变，变化后推送前体检会提示。`,
      );
    ipSetting.addButton((button) =>
      button.setButtonText('探测出口 IP').onClick(async () => {
        button.setDisabled(true);
        try {
          this.plugin.host.setProxy(config.wechat.proxy);
          const ip = await probeEgressIp(this.plugin.host);
          ipSetting.setDesc(`当前出口 IP：${ip}（已复制）。把它加到${WHITELIST_PATH}。`);
          await navigator.clipboard.writeText(ip).catch(() => {});
        } catch {
          new Notice('探测出口 IP 失败，请检查网络或代理设置。');
        } finally {
          button.setDisabled(false);
        }
      }),
    );
    new Setting(containerEl)
      .setName('代理地址')
      .setDesc('只用于公众号请求，用来固定出口 IP；支持 http://、https:// 与 socks5://，留空直连。')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:7890')
          .setValue(config.wechat.proxy)
          .onChange((value) => later('proxy', () => update({ wechat: { proxy: value.trim() } }))),
      );
    containerEl.createEl('h3', { text: '知乎' });
    const zhihu = new Setting(containerEl).setName('登录状态').setDesc('检查中…');
    void zhihuStatus(this.plugin.host).then((status) => {
      zhihu.setDesc(
        status.loggedIn
          ? `已登录：${status.user.name}`
          : status.user
            ? `登录已失效（${status.user.name}），请重新登录`
            : '未登录',
      );
    });
    zhihu.addButton((button) =>
      button.setButtonText('登录').onClick(() => this.plugin.loginZhihu(() => void this.display())),
    );
    zhihu.addButton((button) =>
      button.setButtonText('退出').onClick(async () => {
        await this.plugin.logoutZhihu();
        new Notice('已退出知乎；命令行用的也是这份登录态，同样需要重新登录。');
        void this.display();
      }),
    );
    containerEl.createDiv({
      cls: 'setting-item-description',
      text: '退出会删除配置目录里的知乎登录态，命令行也在用这一份。',
    });
    containerEl.createEl('h3', { text: '排版' });
    new Setting(containerEl)
      .setName('默认主题')
      .setDesc('只作用于公众号')
      .addDropdown((dropdown) => {
        for (const theme of themes) dropdown.addOption(theme.id, theme.name);
        dropdown
          .setValue(config.theme)
          .onChange(async (value) => update({ theme: value as JinzhangConfig['theme'] }));
      });
    for (const platform of ['wechat', 'zhihu'] as const)
      new Setting(containerEl)
        .setName(`默认推送到${PLATFORM_NAMES[platform]}`)
        .setDesc('「推送到默认平台」一次推送所有选中的平台')
        .addToggle((toggle) =>
          toggle.setValue(config.targets.includes(platform)).onChange(async (value) => {
            const targets = (['wechat', 'zhihu'] as Platform[]).filter((p) =>
              p === platform ? value : config.targets.includes(p),
            );
            await update({ targets });
          }),
        );
    /** 单行文字设置：停止输入后写进公共配置。 */
    const field = (
      name: string,
      desc: string | DocumentFragment,
      value: string,
      patch: (value: string) => Parameters<typeof files.config.update>[0],
    ) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text.setValue(value).onChange((next) => later(name, () => update(patch(next.trim())))),
        );
    /** 结尾 Markdown 保存在配置目录的模板文件里，与命令行共用。 */
    const footer = (platform: Platform) => {
      const area = new TextAreaComponent(containerEl);
      area.inputEl.addClass('jinzhang-template');
      area.setValue(footers[platform]);
      area.onChange((value) =>
        later(`${platform}-footer`, async () => {
          await files.templates.write(platform, 'footer', value);
          this.plugin.refreshViews();
        }),
      );
    };
    containerEl.createEl('h3', { text: '公众号文章样式' });
    containerEl.createDiv({
      cls: 'setting-item-description',
      text: '公众号正文按「开头样式 → 正文 → 结尾样式」组合，预览、复制与推送共用。',
    });
    new Setting(containerEl)
      .setName('开头样式一')
      .setDesc('依次显示顶部宣言、账号名片、作者、出品公众号和分隔线；没填的行不显示。')
      .addToggle((toggle) =>
        toggle
          .setValue(config.fixed.wechat.header)
          .onChange(async (value) => update({ fixed: { wechat: { header: value } } })),
      );
    field('顶部宣言', '居中显示在文章最上方的一句话', config.wechat.start.slogan, (slogan) => ({
      wechat: { start: { slogan } },
    }));
    field('作者', '显示为「作者｜…」，也是结尾里 {{author}} 的取值', config.author, (author) => ({
      author,
    }));
    field(
      '出品公众号',
      '显示为「出品｜公众号：…」',
      config.wechat.start.producerName,
      (producerName) => ({ wechat: { start: { producerName } } }),
    );
    new Setting(containerEl)
      .setName('结尾样式一')
      .setDesc(
        '先显示下面的结尾 Markdown，再显示账号名片。允许内嵌 HTML；可以用 {{title}}、{{date}}、{{author}}，缺值的行不显示。',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(config.fixed.wechat.footer)
          .onChange(async (value) => update({ fixed: { wechat: { footer: value } } })),
      );
    footer('wechat');
    new Setting(containerEl)
      .setName('账号名片')
      .setDesc(
        '在已启用的开头、结尾样式里显示名片。位置由样式决定：两种样式都启用时各显示一张，都不启用时不插入。公众号 ID 与名称必填，预览里用占位块示意。',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(config.wechat.card.enabled)
          .onChange(async (value) => update({ wechat: { card: { enabled: value } } })),
      );
    field(
      '公众号 ID（fakeid）',
      createFragment((fragment) => {
        fragment.createEl('a', { text: '如何从公众号后台获取 fakeid', href: FAKEID_GUIDE });
      }),
      config.wechat.card.mpId,
      (mpId) => ({ wechat: { card: { mpId } } }),
    );
    field('公众号名称', '', config.wechat.card.nickname, (nickname) => ({
      wechat: { card: { nickname } },
    }));
    field('头像地址', '', config.wechat.card.headImg, (headImg) => ({
      wechat: { card: { headImg } },
    }));
    field('公众号简介', '', config.wechat.card.signature, (signature) => ({
      wechat: { card: { signature } },
    }));
    new Setting(containerEl).setName('账号类型').addDropdown((dropdown) =>
      dropdown
        .addOption('1', '公众号')
        .addOption('2', '服务号')
        .setValue(config.wechat.card.serviceType === 2 ? '2' : '1')
        .onChange(async (value) => update({ wechat: { card: { serviceType: Number(value) } } })),
    );
    new Setting(containerEl).setName('认证状态').addDropdown((dropdown) =>
      dropdown
        .addOption('0', '未认证')
        .addOption('1', '个人认证')
        .addOption('2', '企业认证')
        .setValue(
          ['1', '2'].includes(String(config.wechat.card.verifyStatus))
            ? String(config.wechat.card.verifyStatus)
            : '0',
        )
        .onChange(async (value) => update({ wechat: { card: { verifyStatus: Number(value) } } })),
    );
    containerEl.createEl('h3', { text: '知乎文章样式' });
    new Setting(containerEl)
      .setName('默认结尾')
      .setDesc(
        '追加在知乎正文之后，只保留文字、图片与链接；可以用 {{title}}、{{date}}、{{author}}，缺值的行不显示。',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(config.fixed.zhihu.footer)
          .onChange(async (value) => update({ fixed: { zhihu: { footer: value } } })),
      );
    footer('zhihu');
    containerEl.createEl('h3', { text: '高级' });
    new Setting(containerEl)
      .setName('模板目录')
      .setDesc('两段结尾 Markdown 保存在这里的 wechat/footer.md 与 zhihu/footer.md。')
      .addButton((button) =>
        button.setButtonText('打开模板目录').onClick(() => this.plugin.openTemplatesDir()),
      );
    new Setting(containerEl)
      .setName('配置目录')
      .setDesc(
        '配置、凭证、登录态与草稿映射都在这里，命令行与插件共用；可用环境变量 JINZHANG_HOME 改到别处。',
      )
      .addText((text) => {
        text.setValue(files.dir);
        text.inputEl.readOnly = true;
      });
  }
}
