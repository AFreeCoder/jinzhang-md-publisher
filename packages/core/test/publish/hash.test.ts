import { describe, expect, it } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { base64, hmacSha1Base64, md5Hex, sha256Hex } from '../../src/publish/hash';
describe('投递用的哈希与签名', () => {
  it('MD5 与 Node crypto 一致，覆盖分块边界', () => {
    for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const bytes = randomBytes(size);
      expect(md5Hex(new Uint8Array(bytes))).toBe(createHash('md5').update(bytes).digest('hex'));
    }
  });
  it('SHA-256、HMAC-SHA1 与 base64 与 Node crypto 一致', async () => {
    const bytes = randomBytes(3000);
    expect(await sha256Hex(new Uint8Array(bytes))).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(await hmacSha1Base64('密钥', 'PUT\n\nimage/png\n日期')).toBe(
      createHmac('sha1', '密钥').update('PUT\n\nimage/png\n日期').digest('base64'),
    );
    expect(base64(new Uint8Array(bytes))).toBe(bytes.toString('base64'));
  });
});
