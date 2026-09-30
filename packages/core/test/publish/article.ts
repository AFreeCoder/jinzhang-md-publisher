import { prepare, render } from '../../src/index';
import type { AssetResolver, Platform } from '../../src/types';
import { defaultConfig, type PublishContext, type PublishHost } from '../../src/publish';
const SOURCE = '/notes/测试文章.md';
/** 本地图片按首字节区分格式：0x89 PNG、0xff JPEG、0x47 动图、0xee 无法转换的 SVG。 */
const LOCAL: Record<string, number[]> = {
  './a.png': [0x89, 1],
  './same.png': [0x89, 1],
  './b.jpg': [0xff, 2],
  './anim.gif': [0x47, 3],
  './bad.svg': [0xee],
};
export const resolver: AssetResolver = {
  resolve: async (ref) => {
    if (ref.startsWith('https://')) return { kind: 'remote', url: ref };
    const bytes = LOCAL[ref];
    return bytes
      ? { kind: 'blob', bytes: new Uint8Array(bytes), mime: 'image/png', assetId: ref }
      : { kind: 'missing', reason: `找过 /notes/${ref.slice(2)}` };
  },
};
export async function article(markdown: string, platform: Platform = 'wechat', cover?: string) {
  const prepared = await prepare(
    { markdown, title: '测试文章' },
    { platform, fixed: { header: false, footer: false }, resolver, cover },
  );
  return render(prepared, { theme: 'sspai' });
}
export const context = (
  host: PublishHost,
  extra: Partial<PublishContext> = {},
): PublishContext => ({
  host,
  source: SOURCE,
  config: defaultConfig(),
  fixed: { header: false, footer: false },
  ...extra,
});
