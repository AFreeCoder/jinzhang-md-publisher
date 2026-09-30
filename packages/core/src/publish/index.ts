import { readCredentials, wechatPublisher, estimateChars } from './wechat';
import { readZhihuSession, zhihuPublisher } from './zhihu';
import { draftMapping, maskAppId, summaryBase } from './common';
import type { PlatformSummary, PublishContext, RenderedArticle } from './types';
export * from './types';
export * from './errors';
export * from './host';
export * from '../local';
export {
  downloadImage,
  ImageCache,
  isPlatformHosted,
  isPrivateHost,
  type PreparedImage,
} from './images';
export {
  wechatPublisher,
  probeEgressIp,
  readCredentials,
  estimateChars,
  WechatApi,
  WechatApiError,
  WECHAT_ENTRY_URL,
  WHITELIST_PATH,
} from './wechat';
export {
  zhihuPublisher,
  parseZhihuCookies,
  readZhihuSession,
  saveZhihuLogin,
  zhihuStatus,
  createZhihuCopyStore,
  ZhihuImageStore,
  ZHIHU_REQUIRED_COOKIES,
} from './zhihu';
export const publishers = { wechat: wechatPublisher, zhihu: zhihuPublisher };
/** 确认摘要：平台与账号、标题、封面、图片数、字符数、开头结尾、创建还是更新；不联网。 */
export async function describe(
  article: RenderedArticle,
  ctx: PublishContext,
): Promise<PlatformSummary> {
  const state = await ctx.host.store.read();
  if (article.platform === 'wechat') {
    const credentials = await readCredentials(ctx.host);
    const summary = summaryBase(
      article,
      ctx,
      draftMapping(state, ctx, 'wechat', credentials?.appId).entry,
    );
    summary.account =
      ctx.config.wechat.card.nickname || (credentials && maskAppId(credentials.appId));
    summary.estimatedChars = estimateChars(article);
    return summary;
  }
  const session = await readZhihuSession(ctx.host);
  const summary = summaryBase(
    article,
    ctx,
    draftMapping(state, ctx, 'zhihu', session?.user?.id).entry,
  );
  summary.account = session?.user?.name;
  return summary;
}
