import { describe, expect, it } from 'vitest';
import type { ImageRef, RenderResult } from '@jinzhang/core';
import {
  defaultConfig,
  type HttpRequest,
  type HttpResponse,
  type PublishContext,
  type PublishHost,
} from '@jinzhang/core/publish';
import { placeForCopy } from '../src/copy';
const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify(body)),
});
/** 模拟锦章中转的签名、OSS 直传与完成校验；没有知乎登录态。 */
function transitHost(respond?: (request: HttpRequest) => HttpResponse | undefined) {
  const requests: HttpRequest[] = [];
  const host = {
    secrets: { get: async () => null },
    now: () => new Date('2026-10-20T00:00:00Z'),
    codec: {
      normalize: async (bytes: Uint8Array) => ({
        bytes,
        mime: 'image/png',
        width: 1,
        height: 1,
        animated: false,
      }),
    },
    http: {
      request: async (request: HttpRequest) => {
        requests.push(request);
        const custom = respond?.(request);
        if (custom) return custom;
        if (request.url.endsWith('/api/transit/sign'))
          return json(200, {
            url: 'https://bucket.oss.test',
            fields: { key: `transit/${requests.length}.png`, policy: 'p' },
            ticket: `t${requests.length}`,
          });
        if (request.url === 'https://bucket.oss.test') return json(201, {});
        if (request.url.endsWith('/api/transit/complete'))
          return json(200, {
            url: `https://read.oss.test/${JSON.parse(String(request.body)).ticket}`,
          });
        throw new Error(`意外的请求 ${request.url}`);
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
const local = (id: string, byte: number): ImageRef => ({
  id,
  original: `assets/${id}.png`,
  source: { kind: 'blob', bytes: new Uint8Array([byte, 1, 2]), mime: 'image/png' },
  inFixedContent: false,
});
const zhihu = (images: ImageRef[]) =>
  ({
    platform: 'zhihu',
    html: images.map((image) => `<p><img src="jz-img:${image.id}"></p>`).join(''),
    images,
  }) as unknown as RenderResult;
describe('复制到知乎（不需要登录）', () => {
  it('没有图片时不发任何请求', async () => {
    const { context, requests } = transitHost();
    const placed = await placeForCopy(zhihu([]), context, () => {});
    expect(placed.html).toBe('');
    expect(requests).toEqual([]);
  });
  it('网络图片保留原地址并提示核对，不上传', async () => {
    const { context, requests } = transitHost();
    const placed = await placeForCopy(zhihu([remote]), context, () => {});
    expect(placed.html).toContain('src="https://example.com/a.png"');
    expect(placed.warnings.map((w) => w.code)).toEqual(['IMAGE_REMOTE_KEPT']);
    expect(requests).toEqual([]);
  });
  it('本地图片经锦章中转上传，换成中转地址；接口请求带本站 Origin', async () => {
    const { context, requests } = transitHost();
    const progress: string[] = [];
    const placed = await placeForCopy(zhihu([local('b', 10), remote]), context, (m) =>
      progress.push(m),
    );
    expect(requests.map((r) => r.url)).toEqual([
      'https://jinzhang.ink/api/transit/sign',
      'https://bucket.oss.test',
      'https://jinzhang.ink/api/transit/complete',
    ]);
    expect(requests[0].headers?.Origin).toBe('https://jinzhang.ink');
    expect(JSON.parse(String(requests[0].body))).toEqual({ mime: 'image/png', size: 3 });
    const form = new TextDecoder().decode(requests[1].body as Uint8Array);
    expect(form.indexOf('name="policy"')).toBeLessThan(form.indexOf('name="file"'));
    expect(placed.html).toContain('src="https://read.oss.test/t1"');
    expect(placed.html).toContain('src="https://example.com/a.png"');
    expect(progress).toEqual(['上传图片 1/1']);
  });
  it('同一张图在有效期内复用中转地址', async () => {
    const { context, requests } = transitHost();
    await placeForCopy(zhihu([local('c', 20)]), context, () => {});
    const again = await placeForCopy(zhihu([local('d', 20)]), context, () => {});
    expect(requests.filter((r) => r.url.endsWith('/sign'))).toHaveLength(1);
    expect(again.html).toContain('src="https://read.oss.test/');
  });
  it('中转失败时报出哪张图和原因', async () => {
    const { context } = transitHost((request) =>
      request.url.endsWith('/sign')
        ? json(429, { code: 'RATE_LIMITED', message: '请求太频繁，请稍后再试' })
        : undefined,
    );
    await expect(placeForCopy(zhihu([local('e', 30)]), context, () => {})).rejects.toThrow(
      '图片「assets/e.png」上传到锦章中转失败：请求太频繁，请稍后再试',
    );
  });
});
