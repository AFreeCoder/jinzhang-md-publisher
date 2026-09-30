import { App, ButtonComponent, FuzzySuggestModal, Modal, TFile } from 'obsidian';
import type { ImageRef } from '@jinzhang/core';
import { baseName, coverUrl } from './render';
const IMAGE = /^(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
class ImagePicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private choose: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder('搜索 vault 里的图片');
  }
  getItems() {
    return this.app.vault.getFiles().filter((file) => IMAGE.test(file.extension));
  }
  getItemText(file: TFile) {
    return file.path;
  }
  onChooseItem(file: TFile) {
    this.choose(file);
  }
}
export interface CoverChoice {
  /** 单独设置的封面（绝对路径），没有为 undefined。 */
  explicit?: string;
  /** 当前生效的封面：单独设置的图或正文首图。 */
  effective: ImageRef | null;
  /** 选中 vault 图片时保存它；传 undefined 表示清除、回到正文首图。 */
  save(file: TFile | undefined): Promise<void>;
}
/** 封面选择（设计第 9 节）：显示当前生效的封面，可在 vault 图片里搜索一张，或清除回到首图。 */
export class CoverModal extends Modal {
  private urls: string[] = [];
  constructor(
    app: App,
    private choice: CoverChoice,
  ) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('jinzhang-modal');
    contentEl.createEl('h2', { text: '设置本文封面' });
    const { explicit, effective } = this.choice;
    const src = coverUrl(effective, this.urls);
    if (src) contentEl.createEl('img', { cls: 'jinzhang-cover-large', attr: { src } });
    contentEl.createEl('p', {
      text: explicit
        ? `当前是单独设置的封面：${baseName(explicit)}`
        : effective
          ? `当前取正文首图：${baseName(effective.original)}`
          : '当前没有封面：正文里没有图片，公众号推送需要先设置封面。',
    });
    if (effective?.source.kind === 'missing')
      contentEl.createEl('p', {
        cls: 'jinzhang-warning',
        text: `封面图片无法读取：${effective.source.reason}`,
      });
    contentEl.createEl('p', {
      cls: 'jinzhang-muted',
      text: '封面不做裁剪，公众号后台可以调整。设置保存在配置目录，命令行推送同一篇时同样生效。',
    });
    const buttons = contentEl.createDiv({ cls: 'jinzhang-buttons' });
    new ButtonComponent(buttons)
      .setButtonText('从 vault 选择图片')
      .setCta()
      .onClick(() => {
        new ImagePicker(this.app, async (file) => {
          await this.choice.save(file);
          this.close();
        }).open();
      });
    if (explicit)
      new ButtonComponent(buttons).setButtonText('清除，改回正文首图').onClick(async () => {
        await this.choice.save(undefined);
        this.close();
      });
    new ButtonComponent(buttons).setButtonText('关闭').onClick(() => this.close());
  }
  onClose() {
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.contentEl.empty();
  }
}
