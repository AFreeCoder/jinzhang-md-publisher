import { NORMALIZE_PROFILES, type ImageRef, type Platform } from '../types';
import { fail } from './errors';
import { TransportError, type PublishHost } from './host';
import { sha256Hex } from './hash';
export const MAX_REMOTE_BYTES = 12 * 1024 * 1024;
export interface PreparedImage {
  /** 原始字节的 SHA-256，跨次推送的图片与封面缓存按它查。 */
  hash: string;
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  animated: boolean;
}
/** 已在目标平台存储上的地址直接使用，不下载也不上传。 */
export function isPlatformHosted(url: string, platform: Platform) {
  try {
    const { protocol, hostname } = new URL(url);
    if (!/^https?:$/.test(protocol)) return false;
    const host = hostname.toLowerCase();
    return platform === 'wechat'
      ? host === 'mmbiz.qpic.cn' || host.endsWith('.mmbiz.qpic.cn')
      : host === 'zhimg.com' || host.endsWith('.zhimg.com');
  } catch {
    return false;
  }
}
/** 只按字面判断回环、私网与链路本地地址；本地形态不做 DNS 解析。 */
export function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (host.includes(':'))
    return (
      host === '::1' ||
      host === '::' ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      /^::ffff:(127|10|192\.168)\./.test(host)
    );
  return false;
}
/** 下载远程图片：拒绝本机与私网地址，限制 12MB 与 20 秒；失败带上原始引用。 */
export async function downloadImage(host: PublishHost, url: string, ref: string) {
  const failure = (reason: string) =>
    fail({
      code: 'IMAGE_DOWNLOAD_FAILED',
      stage: 'image',
      message: `远程图片下载失败：${reason}`,
      action: '检查图片地址是否可访问，或改用本地图片',
      ref,
    });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw failure('地址无效');
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password)
    throw failure('只支持不带账号的 http(s) 地址');
  if (isPrivateHost(parsed.hostname)) throw failure('不能读取本机或内网地址');
  let response;
  try {
    response = await host.http.request({
      url: parsed.href,
      headers: { Accept: 'image/*' },
      timeoutMs: 20_000,
    });
  } catch (error) {
    throw failure(error instanceof TransportError ? error.message : '网络错误');
  }
  if (response.status < 200 || response.status >= 300) throw failure(`HTTP ${response.status}`);
  if (!response.body.length) throw failure('内容为空');
  if (response.body.length > MAX_REMOTE_BYTES) throw failure('超过 12MB');
  return response.body;
}
/** 一次操作内共用：体检与推送、两个平台对同一张图只读取、规范化一次。 */
export class ImageCache {
  private items = new Map<string, Promise<PreparedImage>>();
  constructor(private host: PublishHost) {}
  prepare(image: Pick<ImageRef, 'original' | 'source'>): Promise<PreparedImage> {
    const source = image.source;
    if (source.kind === 'missing')
      return Promise.reject(
        fail({
          code: 'IMAGE_MISSING',
          stage: 'image',
          message: `图片无法解析：${source.reason}`,
          action: '检查图片路径，或把图片放进 vault 后重试',
          ref: image.original,
        }),
      );
    const key =
      source.kind === 'remote' || source.kind === 'hosted' ? `url:${source.url}` : undefined;
    if (key && this.items.has(key)) return this.items.get(key)!;
    const task = (async () => {
      const bytes =
        'bytes' in source
          ? source.bytes
          : await downloadImage(this.host, source.url, image.original);
      const hash = await sha256Hex(bytes);
      const byHash = `sha:${hash}`;
      if (!this.items.has(byHash))
        this.items.set(byHash, this.normalize(bytes, hash, image.original));
      return this.items.get(byHash)!;
    })();
    if (key) this.items.set(key, task);
    task.catch(() => key && this.items.delete(key));
    return task;
  }
  private async normalize(bytes: Uint8Array, hash: string, ref: string): Promise<PreparedImage> {
    try {
      const image = await this.host.codec.normalize(bytes, NORMALIZE_PROFILES.platform);
      return { hash, ...image };
    } catch (error) {
      throw fail({
        code: 'IMAGE_UNCONVERTIBLE',
        stage: 'image',
        message: `图片无法转成 JPG 或 PNG 并压到 1MB 以内：${error instanceof Error ? error.message : '未知原因'}`,
        action: '换一张图，或先导出为 PNG、JPG',
        ref,
      });
    }
  }
}
