import { describe, expect, it } from 'vitest';
import type { ImageRef, RenderResult } from '@jinzhang/core';
import { defaultConfig, type PublishContext, type PublishHost } from '@jinzhang/core/publish';
import { placeForCopy } from '../src/copy';
// 未登录：凭证里没有知乎登录态。
const context = {
  host: { secrets: { get: async () => null } } as unknown as PublishHost,
  source: '/vault/posts/a.md',
  config: defaultConfig(),
  fixed: { header: false, footer: false },
} satisfies PublishContext;
const remote: ImageRef = {
  id: 'img1',
  original: 'https://example.com/a.png',
  source: { kind: 'remote', url: 'https://example.com/a.png' },
  inFixedContent: false,
};
const local: ImageRef = {
  id: 'img2',
  original: 'assets/b.png',
  source: { kind: 'blob', bytes: new Uint8Array([1]), mime: 'image/png' },
  inFixedContent: false,
};
const zhihu = (images: ImageRef[]) =>
  ({
    platform: 'zhihu',
    html: images.map((image) => `<p><img src="jz-img:${image.id}"></p>`).join(''),
    images,
  }) as unknown as RenderResult;
describe('复制到知乎', () => {
  it('未登录、正文没有图片时照常复制', async () => {
    const placed = await placeForCopy(zhihu([]), context, () => {});
    expect(placed.html).toBe('');
  });
  it('未登录、只有网络图片时保留原地址，由知乎编辑器粘贴时抓取', async () => {
    const placed = await placeForCopy(zhihu([remote]), context, () => {});
    expect(placed.html).toContain('src="https://example.com/a.png"');
    expect(placed.warnings).toEqual([]);
  });
  it('未登录、有本地图片时提示登录', async () => {
    await expect(placeForCopy(zhihu([remote, local]), context, () => {})).rejects.toThrow(
      /本地图片.*先登录知乎/,
    );
  });
});
