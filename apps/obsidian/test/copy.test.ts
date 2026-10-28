import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ImageRef, RenderResult } from '@jinzhang/core';
import {
  defaultConfig,
  type HttpRequest,
  type HttpResponse,
  type OssCredentials,
  type PublishContext,
  type PublishHost,
} from '@jinzhang/core/publish';
import { placeForCopy } from '../src/copy';
const OSS: OssCredentials = {
  region: 'oss-cn-shanghai',
  bucket: 'demo',
  accessKeyId: 'AK',
  accessKeySecret: 'SK',
  publicBaseUrl: 'https://img.example.com',
  keyPrefix: 'posts',
};
const reply = (status: number, body = ''): HttpResponse => ({
  status,
  headers: {},
  body: new TextEncoder().encode(body),
});
/** 模拟长期图床：HEAD 查对象、PUT 上传；没有知乎登录态。 */
function ossHost(
  options: { oss?: OssCredentials | null; existing?: string[]; put?: HttpResponse } = {},
) {
  const requests: HttpRequest[] = [];
  const stored = new Set(options.existing ?? []);
  const host = {
    secrets: {
      get: async (name: string) =>
        name === 'credentials' && options.oss !== null ? { oss: options.oss ?? OSS } : null,
    },
    now: () => new Date('2026-10-28T00:00:00Z'),
    http: {
      request: async (request: HttpRequest) => {
        requests.push(request);
        const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
        if (request.method === 'HEAD') return reply(stored.has(key) ? 200 : 404);
        if (request.method === 'PUT') {
          if (options.put) return options.put;
          stored.add(key);
          return reply(200);
        }
        throw new Error(`意外的请求 ${request.method} ${request.url}`);
      },
    },
  } as unknown as PublishHost;
  const context = {
    host,
    source: '/vault/posts/a.md',
    config: defaultConfig(),
    fixed: { header: false, footer: false },
  } satisfies PublishContext;
  return { context, requests };
}
const remote: ImageRef = {
  id: 'r',
  original: 'https://example.com/a.png',
  source: { kind: 'remote', url: 'https://example.com/a.png' },
  inFixedContent: false,
};
const local = (id: string, byte: number, ext = 'png'): ImageRef => ({
  id,
  original: `jz-local://vault/assets/${id}.${ext}`,
  source: {
    kind: 'blob',
    bytes: new Uint8Array([byte, 1, 2]),
    mime: ext === 'gif' ? 'image/gif' : 'image/png',
    assetId: `assets/${id}.${ext}`,
  },
  inFixedContent: false,
});
const sha = (byte: number) =>
  createHash('sha256')
    .update(new Uint8Array([byte, 1, 2]))
    .digest('hex');
const zhihu = (images: ImageRef[]) =>
  ({
    platform: 'zhihu',
    html: images.map((image) => `<p><img src="jz-img:${image.id}"></p>`).join(''),
    images,
  }) as unknown as RenderResult;
describe('复制到知乎（不需要登录）', () => {
  it('没有图片时不发任何请求，也不要求配置图床', async () => {
    const { context, requests } = ossHost({ oss: null });
    const placed = await placeForCopy(zhihu([remote]), context, () => {});
    expect(placed.html).toContain('src="https://example.com/a.png"');
    expect(placed.warnings.map((w) => w.code)).toEqual(['IMAGE_REMOTE_KEPT']);
    expect(requests).toEqual([]);
  });
  it('本地图片原样传到长期图床，按内容哈希命名，换成公开地址；不再经过锦章中转', async () => {
    const { context, requests } = ossHost();
    const progress: string[] = [];
    const placed = await placeForCopy(zhihu([local('b', 10, 'gif'), remote]), context, (m) =>
      progress.push(m),
    );
    const key = `posts/${sha(10)}.gif`;
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `HEAD https://demo.oss-cn-shanghai.aliyuncs.com/${key}`,
      `PUT https://demo.oss-cn-shanghai.aliyuncs.com/${key}`,
    ]);
    expect(requests.some((r) => r.url.includes('jinzhang.ink'))).toBe(false);
    expect(requests[1].headers).toMatchObject({
      'Content-Type': 'image/gif',
      'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    });
    expect(requests[1].headers?.Authorization).toMatch(
      /^OSS4-HMAC-SHA256 Credential=AK\/20261028\/cn-shanghai\/oss\/aliyun_v4_request,Signature=[0-9a-f]{64}$/,
    );
    expect(requests[1].body).toEqual(new Uint8Array([10, 1, 2]));
    expect(placed.html).toContain(`src="https://img.example.com/${key}"`);
    expect(placed.html).toContain('src="https://example.com/a.png"');
    expect(progress).toEqual(['上传图片 1/1']);
  });
  it('图床里已有的对象不重传', async () => {
    const { context, requests } = ossHost({ existing: [`posts/${sha(20)}.png`] });
    const placed = await placeForCopy(zhihu([local('c', 20)]), context, () => {});
    expect(requests.map((r) => r.method)).toEqual(['HEAD']);
    expect(placed.html).toContain(`src="https://img.example.com/posts/${sha(20)}.png"`);
  });
  it('有本地图片但没配图床时提示先去设置', async () => {
    const { context, requests } = ossHost({ oss: null });
    await expect(placeForCopy(zhihu([local('d', 30)]), context, () => {})).rejects.toThrow(
      '复制到知乎要先配置长期图床',
    );
    expect(requests).toEqual([]);
  });
  it('上传失败时报出哪张图和原因', async () => {
    const { context } = ossHost({
      put: reply(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>'),
    });
    await expect(placeForCopy(zhihu([local('e', 40)]), context, () => {})).rejects.toThrow(
      '图片上传到长期图床失败：AccessKey Secret 不对，签名校验失败（assets/e.png）',
    );
  });
});
