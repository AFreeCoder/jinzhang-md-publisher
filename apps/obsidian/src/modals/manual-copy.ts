import { App, ButtonComponent, Modal } from 'obsidian';
import type { RenderResult } from '@jinzhang/core';
import { previewDocument } from '@jinzhang/core/preview';
/**
 * 剪贴板写入失败时的手动复制（设计第 8 节）：用本次图片已归位的成品重建只含正文的视图并全选。
 * 不能直接全选预览：预览里的图片是 blob: 临时地址，粘到平台编辑器里无法访问。
 */
export class ManualCopyModal extends Modal {
  private frame?: HTMLIFrameElement;
  constructor(
    app: App,
    private result: RenderResult,
    private html: string,
    private retry: () => Promise<boolean>,
  ) {
    super(app);
  }
  private select() {
    const doc = this.frame?.contentDocument;
    const body = doc?.querySelector('article');
    if (!doc || !body) return;
    const range = doc.createRange();
    range.selectNodeContents(body);
    const selection = doc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.frame?.contentWindow?.focus();
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('jinzhang-modal', 'jinzhang-manual-copy');
    contentEl.createEl('h2', { text: '手动复制' });
    contentEl.createEl('p', {
      text: '写入剪贴板失败。下面是图片已归位的正文，已经全选，按 ⌘C 或 Ctrl+C 复制后到平台编辑器粘贴；封面请在平台里单独设置。',
    });
    this.frame = contentEl.createEl('iframe', {
      cls: 'jinzhang-manual-frame',
      attr: { sandbox: 'allow-same-origin' },
    });
    this.frame.addEventListener('load', () => this.select());
    this.frame.srcdoc = previewDocument(this.result, this.html, { bodyOnly: true });
    const buttons = contentEl.createDiv({ cls: 'jinzhang-buttons' });
    new ButtonComponent(buttons).setButtonText('重新全选').onClick(() => this.select());
    new ButtonComponent(buttons).setButtonText('再试一次写入剪贴板').onClick(async () => {
      if (await this.retry()) this.close();
    });
    new ButtonComponent(buttons).setButtonText('关闭').onClick(() => this.close());
  }
  onClose() {
    this.contentEl.empty();
  }
}
