import type { Platform, RenderResult, Warning } from '../types';
import type { JinzhangConfig } from '../local';
import type { JinzhangError } from './errors';
import type { PublishHost } from './host';
import type { ImageCache } from './images';
export type RenderedArticle = RenderResult;
export interface PublishContext {
  host: PublishHost;
  /** 源文件规范化后的绝对路径，草稿映射的键。 */
  source: string;
  config: JinzhangConfig;
  /** 本次生效的开头结尾开关，只用于摘要。 */
  fixed: { header: boolean; footer: boolean };
  /** 本次使用的模板原文，体检据此检查变量与知乎可用的元素。 */
  templates?: { header?: string; footer?: string };
  /** 模板变量的取值（不含 title），缺值的行会被整行删除。 */
  variables?: Record<string, string>;
  /** 用户已核对草稿箱里没有上次结果不确定的草稿。 */
  confirmUncertain?: boolean;
  /** 显式新建草稿，不沿用映射；不能消掉结果不确定。 */
  newDraft?: boolean;
  onProgress?: (message: string) => void;
  /** 同一次操作的体检与推送共用，避免重复读取与规范化图片。 */
  images?: ImageCache;
}
export interface PlatformSummary {
  platform: Platform;
  /** 展示用的账号名；公众号取名片昵称或 AppID，知乎取用户名。 */
  account?: string;
  title: string;
  visibleTextChars: number;
  htmlChars: number;
  /** 公众号：图片换成接口地址后的预估字符数。 */
  estimatedChars?: number;
  images: number;
  /** 封面的原始引用；没有封面为 null。 */
  cover: string | null;
  header: boolean;
  footer: boolean;
  egressIp?: string;
  draft: 'create' | 'update';
  draftRef?: string;
  /** 上次创建草稿的结果不确定，需要用户核对草稿箱后确认。 */
  uncertain: boolean;
}
export interface PreflightReport {
  platform: Platform;
  ok: boolean;
  blockers: JinzhangError[];
  warnings: Warning[];
  summary: PlatformSummary;
}
export type Verification = 'confirmed' | 'unverified' | 'not_run';
export type PushResult =
  | {
      outcome: 'created' | 'updated';
      draftRef: string;
      entryUrl: string;
      warnings: Warning[];
      verification: Verification;
      uploadedImages: number;
    }
  | { outcome: 'uncertain'; message: string; error: JinzhangError }
  | { outcome: 'failed'; error: JinzhangError };
export interface Publisher {
  platform: Platform;
  /** 只读检查：不上传、不建草稿（获取公众号 token 除外）。 */
  preflight(article: RenderedArticle, ctx: PublishContext): Promise<PreflightReport>;
  push(article: RenderedArticle, ctx: PublishContext): Promise<PushResult>;
}
