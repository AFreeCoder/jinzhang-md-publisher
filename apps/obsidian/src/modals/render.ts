import type { ImageRef, Warning } from '@jinzhang/core';
import type { JinzhangError, PlatformSummary } from '@jinzhang/core/publish';
export function renderErrors(parent: HTMLElement, errors: JinzhangError[]) {
  if (!errors.length) return;
  const list = parent.createEl('ul', { cls: 'jinzhang-errors' });
  for (const error of errors) {
    const item = list.createEl('li');
    item.createSpan({ text: error.message });
    if (error.ref) item.createSpan({ cls: 'jinzhang-ref', text: `（${error.ref}）` });
    if (error.action) item.createDiv({ cls: 'jinzhang-action', text: `下一步：${error.action}` });
  }
}
export function renderWarnings(parent: HTMLElement, warnings: Warning[]) {
  if (!warnings.length) return;
  const list = parent.createEl('ul', { cls: 'jinzhang-warnings' });
  for (const warning of warnings)
    list.createEl('li', {
      text: warning.ref ? `${warning.message}（${warning.ref}）` : warning.message,
    });
}
const onOff = (value: boolean) => (value ? '开' : '关');
export function summaryText(summary: PlatformSummary) {
  const parts = [
    `图片 ${summary.images} 张`,
    `可见字数 ${summary.visibleTextChars}`,
    `接口正文 ${summary.estimatedChars ?? summary.htmlChars} 字符${summary.estimatedChars ? '（按图片地址预估）' : ''}`,
    `开头 ${onOff(summary.header)}、结尾 ${onOff(summary.footer)}`,
  ];
  if (summary.egressIp) parts.push(`出口 IP ${summary.egressIp}`);
  return parts.join('；');
}
export const draftText = (summary: PlatformSummary) =>
  summary.draft === 'update' ? `更新已有草稿（${summary.draftRef}）` : '创建新草稿';
/** 封面缩略图地址：本地字节转 blob 地址，远程图片用原地址；由调用方负责回收。 */
export function coverUrl(cover: ImageRef | null, allocated: string[]) {
  const source = cover?.source;
  if (!source || source.kind === 'missing') return undefined;
  if (!('bytes' in source)) return source.url;
  const url = URL.createObjectURL(new Blob([new Uint8Array(source.bytes)], { type: source.mime }));
  allocated.push(url);
  return url;
}
export const baseName = (path: string) => path.split(/[\\/]/).pop() || path;
