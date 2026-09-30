import {
  NORMALIZE_PROFILES,
  placeImages,
  type ImageRef,
  type ImageStore,
  type PlacedImage,
  type Warning,
} from '@jinzhang/core';
import { CanvasImageCodec, dataUrl, digest, MAX_INPUT_BYTES } from '@jinzhang/core/browser';
export class StaleTaskError extends Error {
  constructor() {
    super('文章或设置已变化，请重新复制。');
  }
}
export class TaskVersion {
  private value = 0;
  change() {
    return ++this.value;
  }
  current() {
    return this.value;
  }
  assert(version: number) {
    if (this.value !== version) throw new StaleTaskError();
  }
}
export async function fetchBytes(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok || !response.body) throw new Error('无法读取远程图片。');
  if (Number(response.headers.get('content-length')) > MAX_INPUT_BYTES)
    throw new Error('图片超过 12 MB。');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_INPUT_BYTES) {
      await reader.cancel();
      throw new Error('图片超过 12 MB。');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return bytes;
}
// 同一张图在插入、切平台及复制时共用中转结果；过期后由本地原图重新上传。
// 缓存 20 小时，早于 24 小时的读取地址失效；旧键条目按 6 天写入，对象可能已删除，不再读取。
const TRANSIT_CACHE = 'jinzhang.transit-cache.v2';
const LEGACY_TRANSIT_CACHE = 'jinzhang-transit-cache';
const TRANSIT_CACHE_MS = 20 * 3600_000;
const transitPending = new Map<string, Promise<PlacedImage>>();
const transitSaved = new Map<string, { src: string; expires: number }>();
export function clearTransitCache() {
  transitSaved.clear();
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(TRANSIT_CACHE);
  localStorage.removeItem(LEGACY_TRANSIT_CACHE);
}
function savedTransits() {
  localStorage.removeItem(LEGACY_TRANSIT_CACHE);
  return JSON.parse(localStorage.getItem(TRANSIT_CACHE) || '{}');
}
async function transitCached(key: string, upload: () => Promise<PlacedImage>) {
  if (!transitSaved.has(key)) {
    try {
      const saved = savedTransits()[key];
      if (saved?.src && saved.expires > Date.now()) transitSaved.set(key, saved);
    } catch {
      /* 存储不可用时仍可上传与复制。 */
    }
  }
  const cached = transitSaved.get(key);
  if (cached && cached.expires > Date.now()) return { src: cached.src };
  const pending = transitPending.get(key);
  if (pending) return pending;
  const task = upload()
    .then((placed) => {
      transitSaved.set(key, { src: placed.src, expires: Date.now() + TRANSIT_CACHE_MS });
      try {
        const saved = savedTransits();
        saved[key] = transitSaved.get(key);
        for (const k of Object.keys(saved)) if (saved[k].expires <= Date.now()) delete saved[k];
        localStorage.setItem(TRANSIT_CACHE, JSON.stringify(saved));
      } catch {
        /* 内存缓存仍可复用。 */
      }
      return placed;
    })
    .finally(() => transitPending.delete(key));
  transitPending.set(key, task);
  return task;
}
export class CopyImageStore implements ImageStore {
  warnings: Warning[] = [];
  counts = { embedded: 0, uploaded: 0, remote: 0 };
  private codec = new CanvasImageCodec();
  private cache = new Map<string, Promise<PlacedImage>>();
  constructor(
    private platform: 'wechat' | 'zhihu',
    private signal: AbortSignal,
    private assertCurrent: () => void,
    private onProgress: (message: string) => void = () => {},
  ) {}
  async put(ref: ImageRef): Promise<PlacedImage> {
    this.assertCurrent();
    this.signal.throwIfAborted();
    const source = ref.source;
    if (source.kind === 'missing') throw new Error(`图片缺失：${ref.original}`);
    if (source.kind === 'remote' || source.kind === 'hosted') {
      if (this.platform === 'zhihu') {
        this.counts.remote++;
        this.warnings.push({
          code: 'IMAGE_REMOTE_KEPT',
          ref: ref.original,
          message: '保留远程图片地址，粘贴后请在平台里核对。',
        });
        return { src: source.url };
      }
      try {
        const bytes = await fetchBytes(source.url, this.signal);
        return await this.bytes(bytes, ref.original);
      } catch (error) {
        this.assertCurrent();
        this.signal.throwIfAborted();
        this.counts.remote++;
        this.warnings.push({
          code: 'IMAGE_REMOTE_KEPT',
          ref: ref.original,
          message: '远程图片未能处理，已保留原地址，粘贴后请在平台里核对。',
        });
        return { src: source.url };
      }
    }
    if ('bytes' in source) return this.bytes(source.bytes, ref.original);
    throw new Error('图片来源无效。');
  }
  private async bytes(bytes: Uint8Array, ref: string) {
    const key = await digest(bytes);
    if (this.cache.has(key)) return this.cache.get(key)!;
    const task = this.process(bytes, ref);
    this.cache.set(key, task);
    try {
      return await task;
    } catch (error) {
      this.cache.delete(key);
      throw error;
    }
  }
  private async process(bytes: Uint8Array, ref: string) {
    this.assertCurrent();
    this.onProgress('正在处理图片…');
    const image = await this.codec.normalize(bytes, NORMALIZE_PROFILES.clipboard);
    this.assertCurrent();
    if (image.animated)
      this.warnings.push({ code: 'GIF_FIRST_FRAME', ref, message: '动图已转换为静态首帧。' });
    if (this.platform === 'wechat') {
      this.counts.embedded++;
      return { src: dataUrl(image.bytes, image.mime) };
    }
    return transitCached(await digest(image.bytes), async () => {
      const json = async (url: string, body: unknown) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: this.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || '图片中转失败。');
        return result;
      };
      this.onProgress('正在上传图片…');
      const signed = await json('/api/transit/sign', {
        mime: image.mime,
        size: image.bytes.length,
      });
      this.assertCurrent();
      const form = new FormData();
      for (const [k, v] of Object.entries(signed.fields)) form.append(k, String(v));
      form.append('file', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), 'image');
      const response = await fetch(signed.url, {
        method: 'POST',
        body: form,
        signal: this.signal,
        credentials: 'omit',
      });
      if (!response.ok) throw new Error('图片上传失败，请重试。');
      this.assertCurrent();
      const completed = await json('/api/transit/complete', { ticket: signed.ticket });
      this.assertCurrent();
      this.counts.uploaded++;
      return { src: completed.url };
    });
  }
}
export type CopyPayload = Awaited<ReturnType<typeof placeImages>>;
export function writeClipboard(payload: Promise<CopyPayload>) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    throw new Error('浏览器不支持富文本剪贴板，请全选预览正文复制。');
  // 调用保持在用户手势的同步栈中，两种 MIME 共用同一份异步结果。
  return navigator.clipboard.write([
    new ClipboardItem({
      'text/html': payload.then((p) => new Blob([p.html], { type: 'text/html' })),
      'text/plain': payload.then((p) => new Blob([p.text], { type: 'text/plain' })),
    }),
  ]);
}
