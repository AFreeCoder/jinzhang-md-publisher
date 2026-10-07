import type { Root } from 'hast';
export type Platform = 'wechat' | 'zhihu';
export type ThemeId = 'sspai' | 'native' | 'mac';
export interface Warning {
  code: string;
  message: string;
  ref?: string;
}
export type ResolvedAsset =
  | { kind: 'remote' | 'hosted'; url: string }
  | { kind: 'blob' | 'data'; bytes: Uint8Array; mime: string; assetId?: string }
  | { kind: 'missing'; reason: string };
export interface AssetResolver {
  resolve(ref: string): Promise<ResolvedAsset>;
}
export interface ImageRef {
  id: string;
  original: string;
  source: ResolvedAsset;
  inFixedContent: boolean;
}
export interface ArticleInput {
  markdown: string;
  title: string;
  templates?: { header?: string; footer?: string };
}
/** 公众号名片的资料，`:::card` 据此输出编辑器原生的名片组件。 */
export interface WechatCard {
  mpId: string;
  nickname: string;
  headImg: string;
  signature: string;
  serviceType: number;
  verifyStatus: number;
}
export interface PrepareOptions {
  platform: Platform;
  fixed: { header: boolean; footer: boolean };
  /** 开头结尾不包主题容器，按模板自带的样式与正文排版（本地形态）；缺省时包进 `jz-header`、`jz-footer` 由主题着色（网页版）。 */
  plainFixed?: boolean;
  /** `:::card` 用的名片资料；缺 `mpId` 或 `nickname` 时名片不输出并警告。 */
  card?: WechatCard | null;
  cover?: string;
  resolver: AssetResolver;
  config?: Record<string, string>;
  version?: string;
}
export interface PreparedArticle {
  platform: Platform;
  title: string;
  tree: Root;
  images: ImageRef[];
  cover: ImageRef | null;
  warnings: Warning[];
  version: string;
}
export interface RenderResult {
  platform: Platform;
  title: string;
  html: string;
  images: ImageRef[];
  cover: ImageRef | null;
  warnings: Warning[];
  degraded: Warning[];
  placeholders: Warning[];
  version: string;
  stats: { visibleTextChars: number; htmlChars: number; imageCount: number };
  text: string;
}
export interface NormalizeProfile {
  maxEdge: number;
  maxBytes: number;
}
export const NORMALIZE_PROFILES: Record<'clipboard' | 'platform', NormalizeProfile> = {
  clipboard: { maxEdge: 1600, maxBytes: 1024 * 1024 },
  platform: { maxEdge: 2000, maxBytes: 1024 * 1024 },
};
export interface NormalizedImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  animated: boolean;
}
export interface ImageCodec {
  probe(
    bytes: Uint8Array,
  ): Promise<{ mime: string; width: number; height: number; animated: boolean }>;
  normalize(bytes: Uint8Array, profile: NormalizeProfile): Promise<NormalizedImage>;
}
export interface PlacedImage {
  src: string;
  attrs?: Record<string, string>;
}
export interface ImageStore {
  put(image: ImageRef, ctx: { platform: Platform; role: 'body' | 'cover' }): Promise<PlacedImage>;
}
export const HTML_LIMIT = 20000;
export const HTML_WARNING = 18000;
