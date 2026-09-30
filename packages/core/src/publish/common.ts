import type { Platform, Warning } from '../types';
import type { JinzhangState, WechatDraftEntry, ZhihuDraftEntry } from '../local';
import { PublishError, type JinzhangError } from './errors';
import { ImageCache } from './images';
import type { PlatformSummary, PublishContext, RenderedArticle } from './types';
export const WECHAT_URL_BUDGET = 512;
export const TEMPLATE_PARTS = ['header', 'footer'] as const;
const PART_NAMES = { header: '开头', footer: '结尾' };
export const images = (ctx: PublishContext) => (ctx.images ??= new ImageCache(ctx.host));
export const progress = (ctx: PublishContext, message: string) => ctx.onProgress?.(message);
/** 当前账号下的草稿映射；映射属于另一个账号时视为没有，并给出诊断。 */
export function draftMapping<P extends Platform>(
  state: JinzhangState,
  ctx: PublishContext,
  platform: P,
  account: string | undefined,
) {
  const entry = state.drafts[ctx.source]?.[platform] as
    | (P extends 'wechat' ? WechatDraftEntry : ZhihuDraftEntry)
    | undefined;
  const valid =
    entry && typeof entry === 'object' && typeof entry.account === 'string' ? entry : undefined;
  if (!valid || !account) return { entry: undefined, otherAccount: !!valid && !account };
  if (valid.account !== account) return { entry: undefined, otherAccount: true };
  return { entry: valid, otherAccount: false };
}
export function draftRef(entry: WechatDraftEntry | ZhihuDraftEntry | undefined) {
  if (!entry || entry.status === 'uncertain') return undefined;
  const ref = 'mediaId' in entry ? entry.mediaId : (entry as ZhihuDraftEntry).draftId;
  return typeof ref === 'string' && ref ? ref : undefined;
}
export function summaryBase(
  article: RenderedArticle,
  ctx: PublishContext,
  entry: WechatDraftEntry | ZhihuDraftEntry | undefined,
): PlatformSummary {
  const ref = ctx.newDraft ? undefined : draftRef(entry);
  return {
    platform: article.platform,
    title: article.title,
    visibleTextChars: article.stats.visibleTextChars,
    htmlChars: article.stats.htmlChars,
    images: article.images.length,
    cover: article.cover?.original ?? null,
    header: ctx.fixed.header,
    footer: ctx.fixed.footer,
    draft: ref ? 'update' : 'create',
    draftRef: ref,
    uncertain: entry?.status === 'uncertain',
  };
}
export const uncertainBlocker = (platform: Platform): JinzhangError => ({
  code: 'OUTCOME_UNCERTAIN',
  stage: 'preflight',
  platform,
  message: '上次创建草稿时请求超时或中断，不知道草稿是否已经建好',
  action:
    '先到草稿箱核对：没有对应草稿就勾选「草稿箱里没有对应草稿」后重推；已经有了就先在平台删掉那份再重推',
});
export const otherAccountWarning = (platform: Platform): Warning => ({
  code: 'DRAFT_ACCOUNT_CHANGED',
  message: `这篇文章的${platform === 'wechat' ? '公众号' : '知乎'}草稿记录属于另一个账号，本次会在当前账号新建草稿。`,
});
/** 逐张读取并规范化正文图与封面（本地解码，不上传）；阻塞项带原始引用。 */
export async function checkImages(
  article: RenderedArticle,
  ctx: PublishContext,
  platform: Platform,
  hosted: (url: string) => boolean,
) {
  const blockers: JinzhangError[] = [];
  const warnings: Warning[] = [];
  const seen = new Set<string>();
  const refs = [...article.images];
  if (article.cover && !refs.some((image) => image.id === article.cover!.id))
    refs.push(article.cover);
  for (const image of refs) {
    if (seen.has(image.original)) continue;
    seen.add(image.original);
    const source = image.source;
    if ((source.kind === 'remote' || source.kind === 'hosted') && hosted(source.url)) continue;
    try {
      const prepared = await images(ctx).prepare(image);
      if (prepared.animated)
        warnings.push({
          code: 'GIF_FIRST_FRAME',
          ref: image.original,
          message: '动图会转成静态首帧。',
        });
    } catch (error) {
      if (!(error instanceof PublishError)) throw error;
      blockers.push({ ...error.detail, platform, stage: 'preflight' });
    }
  }
  return { blockers, warnings };
}
/** 模板里缺值的变量会让整行消失，体检时提示；title 总有值。 */
export function templateWarnings(ctx: PublishContext, platform: Platform): Warning[] {
  const warnings: Warning[] = [];
  for (const part of TEMPLATE_PARTS) {
    const source = ctx.fixed[part] ? ctx.templates?.[part] : undefined;
    if (!source?.trim()) continue;
    const missing = [
      ...new Set(
        [...source.matchAll(/\{\{(\w+)\}\}/g)]
          .map((m) => m[1])
          .filter((key) => key !== 'title' && !ctx.variables?.[key]),
      ),
    ];
    if (missing.length)
      warnings.push({
        code: 'TEMPLATE_VARIABLE_MISSING',
        message: `${PART_NAMES[part]}模板里的 ${missing.map((k) => `{{${k}}}`).join('、')} 没有取值，所在行不会显示。`,
      });
    if (platform === 'zhihu') {
      const tags = [...source.matchAll(/<([a-z][\w-]*)/gi)]
        .map((m) => m[1].toLowerCase())
        .filter((tag) => !['a', 'img', 'br', 'p', 'strong', 'em', 'b', 'i'].includes(tag));
      if (tags.length || /^:::card\b/m.test(source))
        warnings.push({
          code: 'TEMPLATE_UNSUPPORTED',
          message: `知乎只支持文字、图片与链接，${PART_NAMES[part]}模板里的其他元素会被去掉。`,
        });
    }
  }
  return warnings;
}
export const maskAppId = (appId: string) =>
  appId.length > 10 ? `${appId.slice(0, 6)}…${appId.slice(-4)}` : appId;
