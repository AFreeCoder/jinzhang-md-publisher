import { createHash } from 'node:crypto';
import type { App, TFile } from 'obsidian';
/** 封面可用的图片格式：扩展名对应的 MIME。 */
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};
/** 文件选择框里列出的扩展名。 */
export const IMAGE_ACCEPT = Object.keys(TYPES)
  .map((ext) => `.${ext}`)
  .join(',');
/** 本地选择或粘贴得到的图片：字节，加上用来判断格式的文件名或 MIME。 */
export interface PickedImage {
  bytes: Uint8Array;
  name?: string;
  type?: string;
}
/** 由文件名或 MIME 定扩展名（小写）；不是支持的图片返回 null。 */
export function imageExtension(name?: string, type?: string): string | null {
  const ext = name?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (ext && ext in TYPES) return ext;
  const mime = type?.toLowerCase().split(';')[0].trim();
  return Object.keys(TYPES).find((key) => TYPES[key] === mime) ?? null;
}
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex').toUpperCase();
const pad = (value: number) => String(value).padStart(2, '0');
/**
 * 附件的规范命名：本地时间 YYYY-MM-DD-HHmmss，加内容 MD5（大写）与扩展名，
 * 与 Attachment Management 的 `${date}-${md5}` 一致。
 */
export function coverFileName(bytes: Uint8Array, ext: string, now: Date) {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${md5(bytes)}.${ext}`;
}
const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/**
 * 把选中或粘贴的图片存进附件目录（跟随 Obsidian 的附件位置设置）并按规范命名。
 * 目录里已有同一内容的规范命名文件时直接复用，不重复存。
 */
export async function saveCoverImage(
  app: App,
  image: PickedImage,
  notePath: string,
  now = new Date(),
): Promise<TFile> {
  const ext = imageExtension(image.name, image.type);
  if (!ext) throw new Error('只支持 PNG、JPG、GIF、WebP、SVG、BMP、AVIF 图片');
  if (!image.bytes.length) throw new Error('图片是空的');
  const name = coverFileName(image.bytes, ext, now);
  const target = await app.fileManager.getAvailablePathForAttachment(name, notePath);
  const folder = folderOf(target);
  const same = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-\\d{6}-${md5(image.bytes)}\\.${ext}$`, 'i');
  const existing = app.vault
    .getFiles()
    .find((file) => folderOf(file.path) === folder && same.test(file.name));
  if (existing) return existing;
  const file = await app.vault.createBinary(target, image.bytes.slice().buffer);
  releaseFromAttachmentQueue(app, file);
  return file;
}
/**
 * Attachment Management 把新建的文件排进待处理队列，等某篇笔记写入它的链接后再改名，且只看队首。
 * 封面不进笔记，留在队首会挡住之后粘贴图片的自动改名，所以存完从它的队列里拿掉。
 */
function releaseFromAttachmentQueue(app: App, file: TFile) {
  const plugins = (app as App & { plugins?: { plugins?: Record<string, unknown> } }).plugins;
  const queue = (plugins?.plugins?.['attachment-management'] as { createdQueue?: unknown })
    ?.createdQueue;
  if (!Array.isArray(queue)) return;
  const index = queue.findIndex((item: { path?: string } | null) => item?.path === file.path);
  if (index >= 0) queue.splice(index, 1);
}
