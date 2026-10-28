import { App, ButtonComponent, Modal, Notice, Platform } from 'obsidian';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ImageRef } from '@jinzhang/core';
import { IMAGE_ACCEPT, imageExtension, type PickedImage } from '../cover-image';
import { baseName, coverUrl } from './render';
interface ElectronClipboard {
  read(format: string): string;
  readImage(): { isEmpty(): boolean; toPNG(): Uint8Array };
}
const electronClipboard = (): ElectronClipboard | undefined => {
  try {
    return (window as unknown as { require?: (id: string) => any }).require?.('electron')
      ?.clipboard;
  } catch {
    return undefined;
  }
};
/** 读剪贴板里的图片：在访达里复制的图片文件取原字节，否则取图片数据（PNG）。 */
async function readClipboardImage(): Promise<PickedImage | null> {
  const clipboard = electronClipboard();
  if (!clipboard) {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((value) => value.startsWith('image/'));
      if (type)
        return { bytes: new Uint8Array(await (await item.getType(type)).arrayBuffer()), type };
    }
    return null;
  }
  // 复制的是文件时剪贴板里还有它的图标，先取文件本身，免得把图标当成封面。
  const url = clipboard.read('public.file-url');
  if (url.startsWith('file://')) {
    const path = fileURLToPath(url);
    if (!imageExtension(path)) throw new Error(`复制的文件不是图片：${baseName(path)}`);
    return { bytes: new Uint8Array(await readFile(path)), name: path };
  }
  const image = clipboard.readImage();
  return image.isEmpty() ? null : { bytes: new Uint8Array(image.toPNG()), type: 'image/png' };
}
/** 打开系统文件选择框选一张图片；取消返回 null。 */
function pickLocalImage(doc: Document): Promise<PickedImage | null> {
  return new Promise((resolve, reject) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = IMAGE_ACCEPT;
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        file
          .arrayBuffer()
          .then(
            (buffer) =>
              resolve({ bytes: new Uint8Array(buffer), name: file.name, type: file.type }),
            reject,
          );
      },
      { once: true },
    );
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export interface CoverChoice {
  /** 单独设置的封面（绝对路径），没有为 undefined。 */
  explicit?: string;
  /** 当前生效的封面：单独设置的图或正文首图。 */
  effective: ImageRef | null;
  /** 存下选中或粘贴的图片并设为封面；传 undefined 表示清除、回到正文首图。 */
  save(image: PickedImage | undefined): Promise<void>;
}
/** 封面选择（设计第 9 节）：显示当前生效的封面，可从本地选图或粘贴剪贴板图片，或清除回到首图。 */
export class CoverModal extends Modal {
  private urls: string[] = [];
  private buttons: ButtonComponent[] = [];
  private busy = false;
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
      text: `从本地选择图片，或粘贴剪贴板里的图片（在这里直接按 ${Platform.isMacOS ? '⌘V' : 'Ctrl+V'} 也可以）。图片存进附件目录，按「日期-内容摘要」命名。封面不做裁剪，公众号后台可以调整。设置保存在配置目录，命令行推送同一篇时同样生效。`,
    });
    const buttons = contentEl.createDiv({ cls: 'jinzhang-buttons' });
    this.buttons.push(
      new ButtonComponent(buttons)
        .setButtonText('从本地选择图片')
        .setCta()
        .onClick(() => this.use(() => pickLocalImage(this.modalEl.ownerDocument))),
      new ButtonComponent(buttons)
        .setButtonText('粘贴剪贴板图片')
        .onClick(() => this.use(readClipboardImage, '剪贴板里没有图片')),
    );
    if (explicit)
      this.buttons.push(
        new ButtonComponent(buttons)
          .setButtonText('清除，改回正文首图')
          .onClick(() => this.use(async () => undefined)),
      );
    new ButtonComponent(buttons).setButtonText('关闭').onClick(() => this.close());
    this.modalEl.ownerDocument.addEventListener('paste', this.onPaste);
  }
  /** 弹窗开着时按 ⌘V：取剪贴板里的第一个图片文件（截图、在访达或网页里复制的图片都在这里）。 */
  private onPaste = (event: ClipboardEvent) => {
    event.preventDefault();
    const file = [...(event.clipboardData?.files ?? [])].find((item) =>
      imageExtension(item.name, item.type),
    );
    void this.use(
      async () =>
        file
          ? { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name, type: file.type }
          : null,
      '剪贴板里没有图片',
    );
  };
  /**
   * 取图并保存。取图结果为 undefined 表示清除；为 null 表示没取到（选择框取消时不提示）。
   * 保存期间按钮不可用，避免重复写入。
   */
  private async use(get: () => Promise<PickedImage | null | undefined>, empty?: string) {
    if (this.busy) return;
    let image: PickedImage | null | undefined;
    try {
      image = await get();
    } catch (error) {
      new Notice(`设置封面失败：${message(error)}`, 10_000);
      return;
    }
    if (image === null) {
      if (empty) new Notice(empty);
      return;
    }
    if (this.busy) return;
    this.setBusy(true);
    try {
      await this.choice.save(image);
      this.close();
    } catch (error) {
      new Notice(`设置封面失败：${message(error)}`, 10_000);
    } finally {
      this.setBusy(false);
    }
  }
  private setBusy(busy: boolean) {
    this.busy = busy;
    this.buttons.forEach((button) => button.setDisabled(busy));
  }
  onClose() {
    this.modalEl.ownerDocument.removeEventListener('paste', this.onPaste);
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.contentEl.empty();
  }
}
