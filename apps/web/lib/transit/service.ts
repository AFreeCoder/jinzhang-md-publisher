import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
export const MAX_UPLOAD = 10 * 1024 * 1024;
export const READ_SECONDS = 24 * 60 * 60;
export interface TransitConfig {
  origin: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  ticketSecret: string;
}
export interface ObjectStore {
  head(key: string): Promise<{ size: number; mime: string }>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  readUrl(key: string, seconds: number): Promise<string>;
}
interface Ticket {
  key: string;
  size: number;
  mime: string;
  expires: number;
}
export class TransitError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function invalid(message = '图片参数无效。'): never {
  throw new TransitError(400, 'INVALID_IMAGE', message);
}
function mac(secret: string | Buffer, value: string) {
  return createHmac('sha256', secret).update(value).digest();
}
export function issueUpload(config: TransitConfig, mime: unknown, size: unknown, now = Date.now()) {
  if (
    typeof mime !== 'string' ||
    !['image/jpeg', 'image/png'].includes(mime) ||
    !Number.isSafeInteger(size) ||
    Number(size) < 1 ||
    Number(size) > MAX_UPLOAD
  )
    invalid('只支持 10 MB 以内的 JPEG 或 PNG。');
  const date = new Date(now);
  const stamp = date.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const key = `transit/${day}/${randomUUID()}.${mime === 'image/png' ? 'png' : 'jpg'}`;
  const expires = now + 5 * 60 * 1000;
  const fields: Record<string, string> = {
    key,
    'Content-Type': String(mime),
    'x-oss-signature-version': 'OSS4-HMAC-SHA256',
    'x-oss-credential': `${config.accessKeyId}/${day}/${config.region}/oss/aliyun_v4_request`,
    'x-oss-date': stamp,
    'x-oss-forbid-overwrite': 'true',
    success_action_status: '201',
  };
  const policy = {
    expiration: new Date(expires).toISOString(),
    conditions: [
      { bucket: config.bucket },
      ...Object.entries(fields).map(([k, v]) => ({ [k]: v })),
      ['content-length-range', Number(size), Number(size)],
    ],
  };
  const encoded = Buffer.from(JSON.stringify(policy)).toString('base64');
  let signingKey = mac(`aliyun_v4${config.accessKeySecret}`, day);
  for (const part of [config.region, 'oss', 'aliyun_v4_request'])
    signingKey = mac(signingKey, part);
  fields.policy = encoded;
  fields['x-oss-signature'] = mac(signingKey, encoded).toString('hex');
  const payload = Buffer.from(
    JSON.stringify({ key, size: Number(size), mime: String(mime), expires } satisfies Ticket),
  ).toString('base64url');
  const ticket = `${payload}.${mac(config.ticketSecret, payload).toString('base64url')}`;
  return {
    url: `https://${config.bucket}.oss-${config.region}.aliyuncs.com`,
    fields,
    ticket,
    expiresAt: expires,
  };
}
export function verifyTicket(secret: string, value: unknown, now = Date.now()): Ticket {
  if (typeof value !== 'string' || value.length > 2048) invalid('上传票据无效。');
  const parts = value.split('.');
  if (parts.length !== 2) invalid('上传票据无效。');
  const expected = mac(secret, parts[0]);
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    invalid('上传票据签名无效。');
  let t: Ticket;
  try {
    t = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  } catch {
    invalid('上传票据无效。');
  }
  if (
    !/^transit\/\d{8}\/[a-f0-9-]{36}\.(png|jpg)$/.test(t.key) ||
    !Number.isSafeInteger(t.size) ||
    t.size < 1 ||
    t.size > MAX_UPLOAD ||
    !['image/jpeg', 'image/png'].includes(t.mime)
  )
    invalid();
  if (!Number.isFinite(t.expires) || t.expires <= now || t.expires > now + 5 * 60 * 1000)
    throw new TransitError(410, 'TICKET_EXPIRED', '上传票据已过期，请重新复制。');
  return t;
}
export async function completeUpload(
  config: TransitConfig,
  store: ObjectStore,
  value: unknown,
  now = Date.now(),
) {
  const t = verifyTicket(config.ticketSecret, value, now);
  // 网络故障不能被当成文件损坏；仅在确认内容无效后删除本次对象。
  const metadata = await store.head(t.key);
  let content: Uint8Array;
  if (metadata.size !== t.size || metadata.mime.split(';')[0] !== t.mime) {
    await store.delete(t.key);
    invalid('上传图片大小或类型与声明不一致。');
  }
  content = await store.get(t.key);
  try {
    if (content.length !== t.size) invalid();
    const b = Buffer.from(content);
    const png = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = b[0] === 255 && b[1] === 216 && b[2] === 255;
    if (t.mime === 'image/png' ? !png : !jpeg) invalid('上传内容不是有效图片。');
    const decoder = sharp(b, { limitInputPixels: 40_000_000, failOn: 'warning' });
    const meta = await decoder.metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > 40_000_000)
      invalid('图片像素超过限制。');
    await decoder.raw().toBuffer();
  } catch {
    await store.delete(t.key);
    invalid('图片校验失败，请换一张图片后重试。');
  }
  return { url: await store.readUrl(t.key, READ_SECONDS), expiresAt: now + READ_SECONDS * 1000 };
}
export function createTransitHandlers(
  getConfig: () => TransitConfig,
  getStore: (c: TransitConfig) => ObjectStore,
) {
  async function handle(request: Request, action: 'sign' | 'complete') {
    try {
      const config = getConfig();
      if (request.headers.get('origin') !== config.origin)
        throw new TransitError(403, 'ORIGIN_DENIED', '图片中转只允许本站请求。');
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        throw new TransitError(415, 'INVALID_REQUEST', '请使用 JSON 请求。');
      const reader = request.body?.getReader();
      if (!reader) invalid('请求内容为空。');
      let body = '';
      let size = 0;
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          throw new TransitError(413, 'REQUEST_TOO_LARGE', '请求过大。');
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        invalid('请求格式错误。');
      }
      const result =
        action === 'sign'
          ? issueUpload(config, data?.mime, data?.size)
          : await completeUpload(config, getStore(config), data?.ticket);
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const e =
        error instanceof TransitError
          ? error
          : new TransitError(502, 'TRANSIT_UNAVAILABLE', '图片中转暂时不可用，请稍后重试。');
      return Response.json(
        { code: e.code, message: e.message },
        { status: e.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }
  return {
    sign: (r: Request) => handle(r, 'sign'),
    complete: (r: Request) => handle(r, 'complete'),
  };
}
