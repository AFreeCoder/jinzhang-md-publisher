import { placeImages, type Platform, type RenderResult, type Warning } from '@jinzhang/core';
import { DataUrlImageStore } from '@jinzhang/core/browser';
import {
  createZhihuCopyStore,
  downloadImage,
  ImageCache,
  PublishError,
  type PublishContext,
} from '@jinzhang/core/publish';
export interface Placed {
  html: string;
  text: string;
  warnings: Warning[];
}
/** 复制只含正文与启用的固定内容（设计第 8 节）：公众号内嵌 data URL，知乎先上传到知乎图片接口。 */
export async function placeForCopy(
  result: RenderResult,
  context: PublishContext,
  progress: (message: string) => void,
): Promise<Placed> {
  const missing = result.images.filter((image) => image.source.kind === 'missing');
  if (missing.length)
    throw new Error(
      `图片缺失：${missing.map((image) => image.original).join('、')}，请先补齐再复制。`,
    );
  if (result.platform === 'wechat') {
    const store = new DataUrlImageStore({
      fetchRemote: (url) => downloadImage(context.host, url, url),
      onProgress: progress,
    });
    const placed = await placeImages(result, store);
    return { ...placed, warnings: store.warnings };
  }
  let store;
  try {
    store = await createZhihuCopyStore(
      { ...context, images: context.images ?? new ImageCache(context.host), onProgress: progress },
      result.images.length,
    );
  } catch (error) {
    if (error instanceof PublishError && /LOGIN|CONFIG_MISSING/.test(error.detail.code))
      throw new Error(
        '复制到知乎要先登录知乎（设置 → 锦章 → 知乎），图片会上传到你的知乎账号；也可以改用网页版复制。',
      );
    throw error;
  }
  const placed = await placeImages(result, store);
  return { ...placed, warnings: store.warnings };
}
/** 同时写入成品 HTML 与可见文本。 */
export async function writeClipboard(placed: Pick<Placed, 'html' | 'text'>) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    throw new Error('当前环境不支持写入富文本剪贴板');
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([placed.html], { type: 'text/html' }),
      'text/plain': new Blob([placed.text], { type: 'text/plain' }),
    }),
  ]);
}
export const COPIED = '已复制，请到平台编辑器粘贴后核对；封面请单独设置';
export const copyTarget = (platform: Platform) => (platform === 'wechat' ? '公众号' : '知乎');
