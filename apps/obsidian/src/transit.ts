import {
  NORMALIZE_PROFILES,
  type ImageRef,
  type ImageStore,
  type PlacedImage,
  type Warning,
} from '@jinzhang/core';
import { digest } from '@jinzhang/core/browser';
import { responseJson, type HttpResponse, type PublishHost } from '@jinzhang/core/publish';
/** 网页版的图片中转（web.md 4.3）。接口只认本站 Origin，插件经 requestUrl 发请求，可以带上。 */
export const TRANSIT_ORIGIN = 'https://jinzhang.ink';
/** 读取地址 24 小时有效，缓存提前 4 小时失效，与网页版相同。 */
const CACHE_MS = 20 * 60 * 60 * 1000;
const cache = new Map<string, { src: string; expires: number }>();
interface Signed {
  url: string;
  fields: Record<string, string | number>;
  ticket: string;
}
/** PostObject 表单：签名字段在前，文件放最后。 */
function postObjectForm(fields: Signed['fields'], bytes: Uint8Array, mime: string) {
  const boundary = `----jinzhang${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const encoder = new TextEncoder();
  const parts = [
    ...Object.entries(fields).map(([name, value]) =>
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    ),
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    bytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  ];
  const body = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
/**
 * 复制到知乎的图片归位：本地图片规范化后传到锦章中转，拿 24 小时有效的地址，知乎编辑器粘贴时会转存到自己的图床；
 * 网络图片保留原地址，与网页版相同。复制不经过知乎账号，不需要登录。
 */
export class TransitImageStore implements ImageStore {
  warnings: Warning[] = [];
  private done = 0;
  constructor(
    private host: PublishHost,
    private total: number,
    private progress: (message: string) => void,
    private origin = TRANSIT_ORIGIN,
  ) {}
  async put(image: ImageRef): Promise<PlacedImage> {
    const source = image.source;
    if (source.kind === 'remote' || source.kind === 'hosted') {
      this.warnings.push({
        code: 'IMAGE_REMOTE_KEPT',
        ref: image.original,
        message: '网络图片保留原地址，粘贴后请在知乎里核对。',
      });
      return { src: source.url };
    }
    if (!('bytes' in source)) throw new Error(`图片缺失：${image.original}`);
    this.progress(`上传图片 ${++this.done}/${this.total}`);
    const normalized = await this.host.codec.normalize(source.bytes, NORMALIZE_PROFILES.clipboard);
    if (normalized.animated)
      this.warnings.push({
        code: 'GIF_FIRST_FRAME',
        ref: image.original,
        message: '动图已转为静态首帧。',
      });
    const key = await digest(normalized.bytes);
    const hit = cache.get(key);
    if (hit && hit.expires > this.host.now().getTime()) return { src: hit.src };
    try {
      const src = await this.upload(normalized.bytes, normalized.mime);
      cache.set(key, { src, expires: this.host.now().getTime() + CACHE_MS });
      return { src };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`图片「${image.original}」上传到锦章中转失败：${reason}`);
    }
  }
  private async upload(bytes: Uint8Array, mime: string) {
    const signed = (await this.json('/api/transit/sign', { mime, size: bytes.length })) as Signed;
    const form = postObjectForm(signed.fields, bytes, mime);
    const stored = await this.host.http.request({
      url: signed.url,
      method: 'POST',
      headers: { 'Content-Type': form.contentType },
      body: form.body,
      timeoutMs: 60_000,
    });
    if (stored.status < 200 || stored.status >= 300)
      throw new Error(`图片存储返回 HTTP ${stored.status}`);
    const completed = (await this.json('/api/transit/complete', { ticket: signed.ticket })) as {
      url?: unknown;
    };
    if (typeof completed.url !== 'string' || !completed.url)
      throw new Error('中转没有返回图片地址');
    return completed.url;
  }
  private async json(path: string, payload: unknown) {
    const response: HttpResponse = await this.host.http.request({
      url: `${this.origin}${path}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: this.origin },
      body: JSON.stringify(payload),
      timeoutMs: 30_000,
    });
    const body = responseJson(response) as { message?: unknown } | undefined;
    if (response.status < 200 || response.status >= 300)
      throw new Error(
        typeof body?.message === 'string' && body.message
          ? body.message
          : `中转服务返回 HTTP ${response.status}`,
      );
    if (!body) throw new Error('中转服务返回的不是 JSON');
    return body;
  }
}
