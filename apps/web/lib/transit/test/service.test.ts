import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import {
  issueUpload,
  verifyTicket,
  completeUpload,
  createTransitHandlers,
  type TransitConfig,
  type ObjectStore,
} from '../service';
const config: TransitConfig = {
  origin: 'https://jinzhang.test',
  bucket: 'test-bucket',
  region: 'cn-hangzhou',
  accessKeyId: 'test-id',
  accessKeySecret: 'test-secret',
  ticketSecret: 'test-only-secret-at-least-32-characters',
};
const png = async () =>
  new Uint8Array(
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } })
      .png()
      .toBuffer(),
  );
function storage(bytes: Uint8Array): ObjectStore {
  return {
    head: vi.fn(async () => ({ size: bytes.length, mime: 'image/png' })),
    get: vi.fn(async () => bytes),
    delete: vi.fn(async () => {}),
    readUrl: vi.fn(async () => 'https://images.test/read'),
  };
}
describe('私有图片中转', () => {
  it('签名单对象、精确大小、类型、禁止覆盖及五分钟有效期', () => {
    const signed = issueUpload(config, 'image/png', 123, 1000000);
    const p = JSON.parse(Buffer.from(signed.fields.policy, 'base64').toString());
    expect(p.conditions).toContainEqual({ 'x-oss-forbid-overwrite': 'true' });
    expect(p.conditions).toContainEqual(['content-length-range', 123, 123]);
    expect(p.conditions).toContainEqual({ key: signed.fields.key });
    expect(verifyTicket(config.ticketSecret, signed.ticket, 1000001).size).toBe(123);
    expect(() => verifyTicket(config.ticketSecret, signed.ticket, 1300000)).toThrow('过期');
    expect(() => verifyTicket(config.ticketSecret, signed.ticket + 'x', 1000001)).toThrow('签名');
  });
  it('超限与非图片 MIME 不签发', () => {
    expect(() => issueUpload(config, 'text/html', 1)).toThrow();
    expect(() => issueUpload(config, 'image/png', 11 * 1024 * 1024)).toThrow();
  });
  it('通过 HEAD、魔数、尺寸与解码才发 24 小时读取链接', async () => {
    const bytes = await png();
    const signed = issueUpload(config, 'image/png', bytes.length);
    const store = storage(bytes);
    const result = await completeUpload(config, store, signed.ticket);
    expect(result.url).toBe('https://images.test/read');
    expect(store.readUrl).toHaveBeenCalledWith(signed.fields.key, 86400);
    expect(store.delete).not.toHaveBeenCalled();
  });
  it('伪造和过期票据不访问 OSS，伪装图片删除后拒绝', async () => {
    const bytes = new TextEncoder().encode('<script>x</script>');
    const store = storage(bytes);
    const signed = issueUpload(config, 'image/png', bytes.length);
    await expect(completeUpload(config, store, 'forged')).rejects.toThrow();
    expect(store.head).not.toHaveBeenCalled();
    await expect(completeUpload(config, store, signed.ticket)).rejects.toThrow('校验失败');
    expect(store.delete).toHaveBeenCalled();
    expect(store.readUrl).not.toHaveBeenCalled();
  });
  it('实际大小不一致拒绝', async () => {
    const bytes = await png();
    const store = storage(bytes);
    await expect(
      completeUpload(config, store, issueUpload(config, 'image/png', bytes.length + 1).ticket),
    ).rejects.toThrow('不一致');
    expect(store.delete).toHaveBeenCalled();
  });
  it('跨站请求不发票据，错误输出不含配置密钥', async () => {
    const api = createTransitHandlers(
      () => config,
      () => storage(new Uint8Array()),
    );
    const response = await api.sign(
      new Request('https://jinzhang.test/api/transit/sign', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(config.accessKeySecret);
  });
});

it('POST V4 签名与 OSS 官方 SDK 对照一致', async () => {
  const { default: OSS } = await import('ali-oss');
  const now = Date.UTC(2026, 8, 10, 12);
  const signed = issueUpload(config, 'image/png', 100, now);
  const client = new OSS({
    region: 'oss-cn-hangzhou',
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    authorizationV4: true,
  });
  const expected = (
    client as typeof client & { signPostObjectPolicyV4(policy: object, date: Date): string }
  ).signPostObjectPolicyV4(
    JSON.parse(Buffer.from(signed.fields.policy, 'base64').toString()),
    new Date(now),
  );
  expect(signed.fields['x-oss-signature']).toBe(expected);
});

it('拒绝 MIME 数组或对象，避免签名类型与扩展名不一致', () => {
  expect(() => issueUpload(config, ['image/png'], 123)).toThrow();
  expect(() => issueUpload(config, { toString: () => 'image/png' }, 123)).toThrow();
});
