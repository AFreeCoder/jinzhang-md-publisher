import type { OssCredentials } from '../local';
import { isRecord } from '../local';
import { fail } from './errors';
import { TransportError, responseText, type PublishHost } from './host';
import { sha256Hex } from './hash';

/**
 * 长期图床：阿里云 OSS，原始字节按内容哈希命名（`<keyPrefix>/<SHA-256><扩展名>`，与 my-toolbox 相同），
 * 已存在就不重传。签名用 OSS V4，WebCrypto 实现，插件产物里不带 ali-oss。
 */

const REQUIRED = [
  'region',
  'bucket',
  'accessKeyId',
  'accessKeySecret',
  'publicBaseUrl',
  'keyPrefix',
] as const;
export const OSS_FIELD_NAMES: Record<(typeof REQUIRED)[number], string> = {
  region: '地域',
  bucket: 'Bucket',
  accessKeyId: 'AccessKey ID',
  accessKeySecret: 'AccessKey Secret',
  publicBaseUrl: '公开访问地址',
  keyPrefix: '目录前缀',
};

/** 缺了哪些必填项；全齐返回空数组。 */
export function missingOssFields(raw: unknown) {
  const source = isRecord(raw) ? raw : {};
  return REQUIRED.filter((key) => typeof source[key] !== 'string' || !source[key].trim());
}

/** 校验并规范化：去首尾空白、公开地址去结尾斜杠、前缀去首尾斜杠；必填项不全返回 null。 */
export function normalizeOss(raw: unknown): OssCredentials | null {
  if (!isRecord(raw) || missingOssFields(raw).length) return null;
  const config: OssCredentials = {
    region: raw.region.trim(),
    bucket: raw.bucket.trim(),
    accessKeyId: raw.accessKeyId.trim(),
    accessKeySecret: raw.accessKeySecret.trim(),
    publicBaseUrl: raw.publicBaseUrl.trim().replace(/\/+$/, ''),
    keyPrefix: raw.keyPrefix.trim().replace(/^\/+|\/+$/g, ''),
  };
  if (typeof raw.endpoint === 'string' && raw.endpoint.trim()) config.endpoint = raw.endpoint.trim();
  if (typeof raw.cname === 'boolean') config.cname = raw.cname;
  return config;
}

export async function readOssConfig(host: PublishHost) {
  return normalizeOss((await host.secrets.get('credentials'))?.oss);
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|tiff?)$/i;
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
};
/** 扩展名优先取文件名（与 my-toolbox 一致，同一张图得到同一个对象），没有再按类型。 */
export function imageExtension(name: string | undefined, mime: string) {
  const fromName = name?.split(/[?#]/)[0].match(IMAGE_EXT)?.[0];
  return fromName ? fromName.toLowerCase() : (MIME_EXT[mime.toLowerCase()] ?? '.bin');
}

export const objectKey = (config: OssCredentials, hash: string, ext: string) =>
  `${config.keyPrefix ? `${config.keyPrefix}/` : ''}${hash}${ext}`;

const encodePath = (key: string) => key.split('/').map(encodeURIComponent).join('/');

export const publicUrl = (config: OssCredentials, key: string) =>
  `${config.publicBaseUrl}/${encodePath(key)}`;

/** 上传请求的地址：自定义域名直接用；否则 `https://<bucket>.<endpoint 或 region.aliyuncs.com>`。 */
export function uploadOrigin(config: OssCredentials) {
  const endpoint = config.endpoint
    ? new URL(/^https?:\/\//i.test(config.endpoint) ? config.endpoint : `https://${config.endpoint}`)
    : new URL(`https://${config.region}.aliyuncs.com`);
  const protocol = endpoint.protocol === 'http:' ? 'http:' : 'https:';
  return config.cname
    ? `${protocol}//${endpoint.host}`
    : `${protocol}//${config.bucket}.${endpoint.host}`;
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
async function hmac(key: Uint8Array | string, message: string) {
  const secret = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? encoder.encode(key) : new Uint8Array(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', secret, encoder.encode(message)));
}
/** 与 ali-oss 的 encodeString 相同：encodeURIComponent 再编码 `!'()*`。 */
const encodeStrict = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `20261028T080000Z` */
export const ossDate = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

/**
 * OSS V4 头部签名（OSS4-HMAC-SHA256）：规范请求只含 content-type、content-md5 与 x-oss-* 头，
 * 负载不签名（UNSIGNED-PAYLOAD）。返回 Authorization 的值。
 */
export async function signV4(
  config: Pick<OssCredentials, 'region' | 'bucket' | 'accessKeyId' | 'accessKeySecret'>,
  request: { method: string; key: string; headers: Record<string, string> },
) {
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value.trim()]),
  );
  const timestamp = headers['x-oss-date'];
  if (!timestamp) throw new Error('缺少 x-oss-date');
  const day = timestamp.slice(0, 8);
  const region = config.region.replace(/^oss-/, '');
  const scope = `${day}/${region}/oss/aliyun_v4_request`;
  const signed = Object.keys(headers)
    .filter((name) => name === 'content-type' || name === 'content-md5' || name.startsWith('x-oss-'))
    .sort();
  const canonical = [
    request.method.toUpperCase(),
    encodeStrict(`/${config.bucket}/${request.key}`).replace(/%2F/g, '/'),
    '',
    signed.map((name) => `${name}:${headers[name]}\n`).join(''),
    '',
    headers['x-oss-content-sha256'] || 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'OSS4-HMAC-SHA256',
    timestamp,
    scope,
    await sha256Hex(encoder.encode(canonical)),
  ].join('\n');
  let key = await hmac(`aliyun_v4${config.accessKeySecret}`, day);
  for (const part of [region, 'oss', 'aliyun_v4_request']) key = await hmac(key, part);
  const signature = hex((await hmac(key, stringToSign)).buffer as ArrayBuffer);
  return `OSS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope},Signature=${signature}`;
}

const ossFailure = (reason: string, ref?: string) =>
  fail({
    code: 'OSS_UPLOAD_FAILED',
    stage: 'image',
    message: `图片上传到长期图床失败：${reason}`,
    action: '检查设置 → 锦章 → 长期图床里的 AccessKey、Bucket、地域与接入地址',
    ref,
  });

function errorReason(status: number, body: string) {
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const known: Record<string, string> = {
    InvalidAccessKeyId: 'AccessKey ID 无效',
    SignatureDoesNotMatch: 'AccessKey Secret 不对，签名校验失败',
    AccessDenied: '这个 AccessKey 没有该 Bucket 的写权限',
    NoSuchBucket: 'Bucket 不存在，或与地域不匹配',
  };
  return (code && known[code]) || `HTTP ${status}${code ? ` ${code}` : ''}`;
}

/** 签名后的 HEAD 与 PUT；HTTP 错误码照常返回给调用方判断。 */
export class OssClient {
  constructor(
    private host: PublishHost,
    readonly config: OssCredentials,
  ) {}
  private async send(method: 'HEAD' | 'PUT', key: string, body?: Uint8Array, mime?: string) {
    const headers: Record<string, string> = {
      'x-oss-date': ossDate(this.host.now()),
      'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    };
    if (mime) headers['Content-Type'] = mime;
    headers.Authorization = await signV4(this.config, { method, key, headers });
    return this.host.http.request({
      url: `${uploadOrigin(this.config)}/${encodePath(key)}`,
      method,
      headers,
      body,
      timeoutMs: method === 'PUT' ? 120_000 : 20_000,
    });
  }
  /** 对象是否已存在：200 是、404 否，其余（多为凭证或 Bucket 配置问题）抛错。 */
  async exists(key: string, ref?: string) {
    let response;
    try {
      response = await this.send('HEAD', key);
    } catch (error) {
      throw ossFailure(error instanceof TransportError ? error.message : '网络错误', ref);
    }
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    // HEAD 没有响应体，403 时按最常见的原因说明。
    throw ossFailure(
      response.status === 403 ? 'AccessKey 或签名被拒绝（HTTP 403）' : `HTTP ${response.status}`,
      ref,
    );
  }
  async put(key: string, bytes: Uint8Array, mime: string, ref?: string) {
    let response;
    try {
      response = await this.send('PUT', key, bytes, mime);
    } catch (error) {
      throw ossFailure(error instanceof TransportError ? error.message : '网络错误', ref);
    }
    if (response.status < 200 || response.status >= 300)
      throw ossFailure(errorReason(response.status, responseText(response)), ref);
  }
}

/** 同一进程里传过的对象：复制与推送反复用到同一张图时不再 HEAD。 */
const known = new Set<string>();

export interface LongTermImage {
  bytes: Uint8Array;
  mime: string;
  /** 文件名或路径，用来取扩展名。 */
  name?: string;
  /** 报错时指向的原始引用。 */
  ref?: string;
}

export class LongTermImageStore {
  uploaded = 0;
  private client: OssClient;
  constructor(
    host: PublishHost,
    readonly config: OssCredentials,
  ) {
    this.client = new OssClient(host, config);
  }
  /** 不联网算出对象名与公开地址：同样的字节总是同一个地址。 */
  async locate(image: LongTermImage) {
    const key = objectKey(this.config, await sha256Hex(image.bytes), imageExtension(image.name, image.mime));
    return { key, url: publicUrl(this.config, key) };
  }
  /** 只接受图片；已存在的对象不重传。返回长期可访问的地址。 */
  async upload(image: LongTermImage) {
    if (!image.mime.startsWith('image/'))
      throw fail({
        code: 'IMAGE_UNSUPPORTED',
        stage: 'image',
        message: `不是图片文件（${image.mime}）`,
        action: '换成 PNG、JPG、GIF、WebP 或 SVG',
        ref: image.ref,
      });
    const { key, url } = await this.locate(image);
    const id = `${this.config.bucket}/${key}`;
    if (known.has(id)) return url;
    if (!(await this.client.exists(key, image.ref))) {
      await this.client.put(key, image.bytes, image.mime, image.ref);
      this.uploaded++;
    }
    known.add(id);
    return url;
  }
}

/** 用一个不存在的对象检查凭证与 Bucket：HEAD 得到 404 说明能访问。 */
export async function checkOss(host: PublishHost, config: OssCredentials) {
  await new OssClient(host, config).exists(objectKey(config, 'jinzhang-connection-check', '.txt'));
}
