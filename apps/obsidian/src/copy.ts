import {
  placeImages,
  type ImageRef,
  type ImageStore,
  type PlacedImage,
  type Platform,
  type RenderResult,
  type Warning,
} from '@jinzhang/core';
import { DataUrlImageStore } from '@jinzhang/core/browser';
import {
  downloadImage,
  LongTermImageStore,
  readOssConfig,
  type PublishContext,
} from '@jinzhang/core/publish';
import { displayRef } from './modals/render';
const NEED_OSS = '正文里有本地图片，复制到知乎要先配置长期图床：设置 → 锦章 → 长期图床。';
export interface Placed {
  html: string;
  text: string;
  warnings: Warning[];
}
/**
 * 复制到知乎的图片归位：本地图片原样传到长期图床（与博客共用同一份对象），知乎编辑器粘贴时会转存到自己的图床；
 * 网络图片保留原地址。复制不经过知乎账号，不需要登录。
 */
export class LongTermCopyStore implements ImageStore {
  warnings: Warning[] = [];
  private done = 0;
  constructor(
    private store: LongTermImageStore | null,
    private total: number,
    private progress: (message: string) => void,
  ) {}
  async put(image: ImageRef): Promise<PlacedImage> {
    const source = image.source;
    if (source.kind === 'remote' || source.kind === 'hosted') {
      this.warnings.push({
        code: 'IMAGE_REMOTE_KEPT',
        ref: image.original,
        message: '网络图片保留原地址，粘贴后请在知乎里核对。',
      });
      return { src: source.url };
    }
    if (!('bytes' in source)) throw new Error(`图片缺失：${displayRef(image.original)}`);
    if (!this.store) throw new Error(NEED_OSS);
    this.progress(`上传图片 ${++this.done}/${this.total}`);
    try {
      return {
        src: await this.store.upload({
          bytes: source.bytes,
          mime: source.mime,
          name: source.assetId ?? image.original,
          ref: image.original,
        }),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}（${displayRef(image.original)}）`);
    }
  }
}
/**
 * 复制只含正文与启用的固定内容（设计第 8 节）：公众号内嵌 data URL；知乎的本地图片传到长期图床，网络图片保留原地址。
 * 复制不经过平台账号，两个平台都不需要登录。
 */
export async function placeForCopy(
  result: RenderResult,
  context: PublishContext,
  progress: (message: string) => void,
): Promise<Placed> {
  const missing = result.images.filter((image) => image.source.kind === 'missing');
  if (missing.length)
    throw new Error(
      `图片缺失：${missing.map((image) => displayRef(image.original)).join('、')}，请先补齐再复制。`,
    );
  if (result.platform === 'wechat') {
    const store = new DataUrlImageStore({
      fetchRemote: (url) => downloadImage(context.host, url, url),
      onProgress: progress,
    });
    const placed = await placeImages(result, store);
    return { ...placed, warnings: store.warnings };
  }
  const local = result.images.filter((image) => 'bytes' in image.source).length;
  const config = local ? await readOssConfig(context.host) : null;
  if (local && !config) throw new Error(NEED_OSS);
  const store = new LongTermCopyStore(
    config && new LongTermImageStore(context.host, config),
    local,
    progress,
  );
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
