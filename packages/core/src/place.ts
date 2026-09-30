import type { ImageStore, RenderResult } from './types';
// 归位与转义不依赖渲染管线，投递入口单独引用，避免把整条管线打进去。
export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export async function placeImages(result: RenderResult, store: ImageStore) {
  let html = result.html;
  for (const image of result.images) {
    const placed = await store.put(image, { platform: result.platform, role: 'body' });
    const attrs = Object.entries(placed.attrs || {})
      .filter(([key]) => /^data-[a-z-]+$/.test(key))
      .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
      .join('');
    html = html.split(`src="jz-img:${image.id}"`).join(`src="${escapeHtml(placed.src)}"${attrs}`);
  }
  return { html, bytes: new TextEncoder().encode(html).byteLength, text: result.text };
}
