import { placeImages } from '../place';
import { HTML_LIMIT, type ImageRef, type ImageStore, type Warning } from '../types';
import type { WechatToken } from '../local';
import { fail, PublishError, toJinzhangError, type JinzhangError } from './errors';
import { responseJson, TransportError, type HttpRequest, type PublishHost } from './host';
import { isPlatformHosted, type PreparedImage } from './images';
import {
  checkImages,
  draftMapping,
  images,
  maskAppId,
  otherAccountWarning,
  progress,
  summaryBase,
  templateWarnings,
  uncertainBlocker,
  WECHAT_URL_BUDGET,
} from './common';
import type {
  PreflightReport,
  Publisher,
  PublishContext,
  PushResult,
  RenderedArticle,
} from './types';
const API = 'https://api.weixin.qq.com';
export const WECHAT_ENTRY_URL = 'https://mp.weixin.qq.com/';
export const WHITELIST_PATH = '公众号后台「设置与开发 → 基本配置 → IP 白名单」';
const TOKEN_ERRORS = new Set([40001, 40014, 42001]);
/** 公众号接口返回的业务错误。 */
export class WechatApiError extends Error {
  /** errcode 为 undefined 表示响应本身异常（非 JSON、缺字段）。 */
  constructor(
    readonly errcode: number | undefined,
    readonly errmsg: string,
  ) {
    super(errcode === undefined ? errmsg : `公众号接口返回错误 ${errcode}`);
    this.name = 'WechatApiError';
  }
}
export function rejectedIp(errmsg: string) {
  return errmsg.match(/invalid ip ([0-9a-f.:]+)/i)?.[1];
}
/** 平台错误码翻译成 JinzhangError；未翻译的按 WECHAT_API_<errcode> 透出。 */
export function wechatError(error: unknown, extra: { egressIp?: string; chars?: number } = {}) {
  const base = { stage: 'push' as const, platform: 'wechat' as const };
  if (error instanceof PublishError) return error.detail;
  if (error instanceof TransportError)
    return {
      ...base,
      code: 'NETWORK_ERROR',
      message: `连接公众号接口失败：${error.message}`,
      action: '检查网络或代理设置后重试',
    };
  if (!(error instanceof WechatApiError))
    return toJinzhangError(error, { ...base, code: 'PUSH_FAILED' });
  const { errcode, errmsg } = error;
  if (errcode === undefined)
    return {
      ...base,
      code: 'WECHAT_BAD_RESPONSE',
      message: `公众号接口响应异常：${errmsg}`,
      action: '稍后重试；反复出现时检查代理设置',
    };
  switch (errcode) {
    case 40164: {
      const rejected = rejectedIp(errmsg);
      const ip = rejected || extra.egressIp;
      return {
        ...base,
        code: 'WECHAT_IP_NOT_WHITELISTED',
        stage: 'auth' as const,
        message: `出口 IP ${ip ?? '（未知）'} 不在公众号 IP 白名单里${extra.egressIp && rejected && extra.egressIp !== rejected ? `（本机探测到的出口 IP 为 ${extra.egressIp}）` : ''}`,
        action: `在${WHITELIST_PATH}加入 ${ip ?? '当前出口 IP'}；家庭宽带的 IP 会变，也可以在设置里配置固定出口的代理`,
        ref: ip,
      };
    }
    case 40013:
    case 40125:
    case 40243:
      return {
        ...base,
        code: 'WECHAT_BAD_CREDENTIALS',
        stage: 'auth' as const,
        message: 'AppID 或 AppSecret 无效',
        action: '检查设置里的公众号 AppID 与 AppSecret',
      };
    case 48001:
      return {
        ...base,
        code: 'WECHAT_NO_PERMISSION',
        message: '当前公众号没有草稿或素材接口的权限',
        action: '确认账号类型支持草稿与素材接口',
      };
    case 45009:
    case 45011:
      return {
        ...base,
        code: 'WECHAT_RATE_LIMITED',
        message: '公众号接口调用频率已达上限',
        action: '稍后重试',
      };
    case 45002:
      return {
        ...base,
        code: 'WECHAT_CONTENT_TOO_LONG',
        message: `正文超过公众号接口的长度上限${extra.chars ? `（实际 ${extra.chars} 字符）` : ''}`,
        action: '换用简洁主题、拆分文章或减少图片',
      };
    case 45166:
      return {
        ...base,
        code: 'WECHAT_CONTENT_INVALID',
        message: '正文或图片不符合微信的规则',
        action: '可能是名片或非标准属性，关闭固定内容后重试以定位',
      };
    default:
      return {
        ...base,
        code: `WECHAT_API_${errcode}`,
        message: `公众号接口返回错误 ${errcode}${errmsg ? `：${errmsg.replace(/\s*rid:.*$/i, '').slice(0, 120)}` : ''}`,
      };
  }
}
/** multipart 手工拼装：宿主只负责发送字节，命令行与插件共用。 */
export function multipart(field: string, filename: string, mime: string, bytes: Uint8Array) {
  const boundary = `----jinzhang${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
export async function readCredentials(host: PublishHost) {
  const wechat = (await host.secrets.get('credentials'))?.wechat;
  return wechat &&
    typeof wechat.appId === 'string' &&
    typeof wechat.appSecret === 'string' &&
    wechat.appId.trim() &&
    wechat.appSecret.trim()
    ? { appId: wechat.appId.trim(), appSecret: wechat.appSecret.trim() }
    : undefined;
}
/** 经公众号同一传输探测出口 IP（配置代理时即代理的出口）。 */
export async function probeEgressIp(host: PublishHost) {
  const response = await host.http.request({
    url: 'https://api.ipify.org?format=json',
    platform: 'wechat',
    timeoutMs: 10_000,
  });
  const ip = (responseJson(response) as { ip?: unknown } | undefined)?.ip;
  if (response.status !== 200 || typeof ip !== 'string' || !ip) throw new Error('无法探测出口 IP');
  return ip;
}
export class WechatApi {
  constructor(
    private host: PublishHost,
    readonly credentials: { appId: string; appSecret: string },
  ) {}
  private async fetchToken() {
    const response = await this.host.http.request({
      url: `${API}/cgi-bin/stable_token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid: this.credentials.appId,
        secret: this.credentials.appSecret,
        force_refresh: false,
      }),
      timeoutMs: 30_000,
      platform: 'wechat',
    });
    const body = this.parse(response.status, responseJson(response));
    if (typeof body.access_token !== 'string' || !body.access_token)
      throw new WechatApiError(undefined, '响应缺少 access_token');
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 7200;
    const token: WechatToken = {
      appId: this.credentials.appId,
      accessToken: body.access_token,
      expiresAt: this.host.now().getTime() + Math.max(60, expiresIn - 300) * 1000,
    };
    await this.host.secrets.set('wechat-token', token);
    return token.accessToken;
  }
  /** stable_token 普通模式，落盘缓存并提前 5 分钟过期，多次调用之间复用。 */
  async token(refresh = false) {
    if (!refresh) {
      const cached = await this.host.secrets.get('wechat-token');
      if (
        cached?.appId === this.credentials.appId &&
        typeof cached.accessToken === 'string' &&
        typeof cached.expiresAt === 'number' &&
        cached.expiresAt > this.host.now().getTime()
      )
        return cached.accessToken;
    }
    return this.fetchToken();
  }
  private parse(status: number, body: unknown) {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
    if (typeof record.errcode === 'number' && record.errcode !== 0)
      throw new WechatApiError(
        record.errcode,
        typeof record.errmsg === 'string' ? record.errmsg : '',
      );
    if (status < 200 || status >= 300 || !body || typeof body !== 'object')
      throw new WechatApiError(undefined, `HTTP ${status}`);
    return record;
  }
  async call(path: string, init: Omit<HttpRequest, 'url'> & { query?: Record<string, string> }) {
    for (let attempt = 0; ; attempt++) {
      const url = new URL(path, API);
      url.searchParams.set('access_token', await this.token(attempt > 0));
      for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
      const response = await this.host.http.request({
        ...init,
        url: url.href,
        platform: 'wechat',
        timeoutMs: init.timeoutMs ?? 30_000,
      });
      try {
        return this.parse(response.status, responseJson(response));
      } catch (error) {
        // 缓存的 token 被其他入口作废时重新获取一次。
        if (
          attempt === 0 &&
          error instanceof WechatApiError &&
          TOKEN_ERRORS.has(error.errcode ?? 0)
        )
          continue;
        throw error;
      }
    }
  }
  private json(path: string, body: unknown, timeoutMs?: number) {
    return this.call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs,
    });
  }
  private upload(path: string, image: PreparedImage, query?: Record<string, string>) {
    const form = multipart(
      'media',
      image.mime === 'image/png' ? 'image.png' : 'image.jpg',
      image.mime,
      image.bytes,
    );
    return this.call(path, {
      method: 'POST',
      headers: { 'Content-Type': form.contentType },
      body: form.body,
      query,
      timeoutMs: 60_000,
    });
  }
  async uploadImage(image: PreparedImage) {
    const body = await this.upload('/cgi-bin/media/uploadimg', image);
    if (typeof body.url !== 'string' || !body.url)
      throw new WechatApiError(undefined, '响应缺少图片地址');
    return body.url;
  }
  async addMaterial(image: PreparedImage) {
    const body = await this.upload('/cgi-bin/material/add_material', image, { type: 'image' });
    if (typeof body.media_id !== 'string' || !body.media_id)
      throw new WechatApiError(undefined, '响应缺少 media_id');
    return body.media_id;
  }
  draftCount() {
    return this.call('/cgi-bin/draft/count', { method: 'GET' });
  }
  async addDraft(article: WechatArticle) {
    const body = await this.json('/cgi-bin/draft/add', { articles: [article] });
    if (typeof body.media_id !== 'string' || !body.media_id)
      throw new WechatApiError(undefined, '响应缺少 media_id');
    return body.media_id;
  }
  async updateDraft(mediaId: string, article: WechatArticle) {
    await this.json('/cgi-bin/draft/update', { media_id: mediaId, index: 0, articles: article });
  }
  async getDraft(mediaId: string) {
    const body = await this.json('/cgi-bin/draft/get', { media_id: mediaId });
    return Array.isArray(body.news_item)
      ? (body.news_item[0] as Record<string, unknown>)
      : undefined;
  }
}
export interface WechatArticle {
  article_type: 'news';
  title: string;
  content: string;
  thumb_media_id: string;
}
/** 正文图走 uploadimg，按内容哈希跨次复用；已在 mmbiz 上的地址直通。 */
class WechatImageStore implements ImageStore {
  uploaded = 0;
  warnings: Warning[] = [];
  private done = 0;
  constructor(
    private api: WechatApi,
    private ctx: PublishContext,
    private total: number,
  ) {}
  async put(image: ImageRef) {
    const source = image.source;
    this.done++;
    if (
      (source.kind === 'remote' || source.kind === 'hosted') &&
      isPlatformHosted(source.url, 'wechat')
    )
      return { src: source.url };
    const prepared = await images(this.ctx).prepare(image);
    if (prepared.animated)
      this.warnings.push({
        code: 'GIF_FIRST_FRAME',
        ref: image.original,
        message: '动图已转为静态首帧。',
      });
    const account = this.api.credentials.appId;
    const cached = (await this.ctx.host.store.read()).images[prepared.hash]?.wechat?.[account];
    if (typeof cached === 'string' && isPlatformHosted(cached, 'wechat')) return { src: cached };
    progress(this.ctx, `上传图片 ${this.done}/${this.total}`);
    const url = await this.api.uploadImage(prepared);
    this.uploaded++;
    await this.ctx.host.store.update((state) => {
      const entry = (state.images[prepared.hash] ??= {});
      (entry.wechat ??= {})[account] = url;
    });
    return { src: url };
  }
}
/** 图片占位换成接口地址后的预估长度：已在 mmbiz 上的按实际地址，其余每张按 512 字符。 */
export function estimateChars(article: RenderedArticle) {
  return article.images.reduce((length, image) => {
    const source = image.source;
    const replacement =
      (source.kind === 'remote' || source.kind === 'hosted') &&
      isPlatformHosted(source.url, 'wechat')
        ? source.url.length
        : WECHAT_URL_BUDGET;
    const occurrences = article.html.split(`src="jz-img:${image.id}"`).length - 1;
    return length + occurrences * (replacement - `jz-img:${image.id}`.length);
  }, article.html.length);
}
const tooLong = (chars: number, estimated: boolean): JinzhangError => ({
  code: 'WECHAT_CONTENT_TOO_LONG',
  stage: 'preflight',
  platform: 'wechat',
  message: `正文${estimated ? '换成图片地址后预计' : ''}为 ${chars} 字符，公众号接口要求少于 ${HTML_LIMIT}`,
  action: '换用简洁主题、拆分文章或减少图片',
});
const missingConfig: JinzhangError = {
  code: 'CONFIG_MISSING',
  stage: 'config',
  platform: 'wechat',
  message: '还没有填写公众号 AppID 与 AppSecret',
  action: '在锦章插件设置或命令行 jinzhang config wechat 中填写',
};
const missingCover: JinzhangError = {
  code: 'COVER_MISSING',
  stage: 'preflight',
  platform: 'wechat',
  message: '公众号草稿必须有封面，这篇没有单独设置封面，正文里也没有图片',
  action: '设置本文封面，或在正文里加一张图',
};
function verify(saved: Record<string, unknown> | undefined, article: WechatArticle) {
  const warnings: Warning[] = [];
  if (!saved)
    return {
      verified: false,
      warnings: [
        { code: 'DRAFT_UNVERIFIED', message: '草稿已写入，但回读缺少内容，请到草稿箱核对。' },
      ],
    };
  if (saved.title !== article.title)
    warnings.push({
      code: 'DRAFT_UNVERIFIED',
      message: '草稿回读的标题与提交的不一致，请到草稿箱核对。',
    });
  const cards = (html: unknown) =>
    typeof html === 'string' ? (html.match(/<mp-common-profile\b/gi) || []).length : 0;
  if (cards(saved.content) < cards(article.content))
    warnings.push({ code: 'CARD_FILTERED', message: '公众号保存草稿时过滤了名片。' });
  return { verified: warnings.length === 0, warnings };
}
export const wechatPublisher: Publisher = {
  platform: 'wechat',
  async preflight(article, ctx) {
    const blockers: JinzhangError[] = [];
    const warnings: Warning[] = [...article.warnings];
    const credentials = await readCredentials(ctx.host);
    const state = await ctx.host.store.read();
    const { entry, otherAccount } = draftMapping(state, ctx, 'wechat', credentials?.appId);
    if (otherAccount) warnings.push(otherAccountWarning('wechat'));
    const summary = summaryBase(article, ctx, entry);
    summary.account =
      ctx.config.wechat.card.nickname || (credentials && maskAppId(credentials.appId));
    let egressIp: string | undefined;
    try {
      egressIp = summary.egressIp = await probeEgressIp(ctx.host);
      if (state.wechatEgressIp && state.wechatEgressIp !== egressIp)
        warnings.push({
          code: 'EGRESS_IP_CHANGED',
          message: `出口 IP 已从 ${state.wechatEgressIp} 变为 ${egressIp}，白名单可能需要更新。`,
          ref: egressIp,
        });
    } catch {
      warnings.push({ code: 'EGRESS_IP_UNKNOWN', message: '未能探测出口 IP。' });
    }
    if (!credentials) blockers.push(missingConfig);
    else {
      // 取 token 并读草稿总数：顺带验证 IP 白名单与草稿接口权限。
      try {
        await new WechatApi(ctx.host, credentials).draftCount();
        if (egressIp && state.wechatEgressIp !== egressIp)
          await ctx.host.store.update((s) => {
            s.wechatEgressIp = egressIp;
          });
      } catch (error) {
        blockers.push({ ...wechatError(error, { egressIp }), stage: 'preflight' });
      }
    }
    if (entry?.status === 'uncertain' && !ctx.confirmUncertain)
      blockers.push(uncertainBlocker('wechat'));
    if (!article.cover) blockers.push(missingCover);
    const checked = await checkImages(article, ctx, 'wechat', (url) =>
      isPlatformHosted(url, 'wechat'),
    );
    blockers.push(...checked.blockers);
    warnings.push(...checked.warnings, ...templateWarnings(ctx, 'wechat'));
    summary.estimatedChars = estimateChars(article);
    if (summary.estimatedChars >= HTML_LIMIT) blockers.push(tooLong(summary.estimatedChars, true));
    return {
      platform: 'wechat',
      ok: !blockers.length,
      blockers,
      warnings,
      summary,
    } satisfies PreflightReport;
  },
  async push(article, ctx): Promise<PushResult> {
    const credentials = await readCredentials(ctx.host);
    if (!credentials) return { outcome: 'failed', error: { ...missingConfig, stage: 'push' } };
    if (!article.cover) return { outcome: 'failed', error: { ...missingCover, stage: 'push' } };
    const api = new WechatApi(ctx.host, credentials);
    const account = credentials.appId;
    const state = await ctx.host.store.read();
    const { entry } = draftMapping(state, ctx, 'wechat', account);
    if (entry?.status === 'uncertain' && !ctx.confirmUncertain)
      return { outcome: 'failed', error: { ...uncertainBlocker('wechat'), stage: 'push' } };
    const warnings: Warning[] = [];
    let chars: number | undefined;
    const save = (patch: Omit<NonNullable<typeof entry>, 'account' | 'updatedAt'>) =>
      ctx.host.store.update((s) => {
        (s.drafts[ctx.source] ??= {}).wechat = {
          account,
          title: article.title,
          ...patch,
          updatedAt: ctx.host.now().toISOString(),
        };
      });
    try {
      const store = new WechatImageStore(api, ctx, article.images.length);
      const placed = await placeImages(article, store);
      for (const match of placed.html.matchAll(/<img\b[^>]*\ssrc="([^"]*)"/g))
        if (!isPlatformHosted(match[1].replace(/&amp;/g, '&'), 'wechat'))
          throw new Error('正文里还有没上传到微信的图片');
      chars = placed.html.length;
      if (chars >= HTML_LIMIT)
        return { outcome: 'failed', error: { ...tooLong(chars, false), stage: 'push' } };
      const cover = await images(ctx).prepare(article.cover);
      let coverUploaded = false;
      const coverId = async (force = false) => {
        const cached = (await ctx.host.store.read()).covers[cover.hash]?.wechat?.[account];
        if (!force && typeof cached === 'string' && cached) return cached;
        progress(ctx, '上传封面');
        const mediaId = await api.addMaterial(cover);
        coverUploaded = true;
        await ctx.host.store.update((s) => {
          const item = (s.covers[cover.hash] ??= {});
          (item.wechat ??= {})[account] = mediaId;
        });
        return mediaId;
      };
      let draft: WechatArticle = {
        article_type: 'news',
        title: article.title,
        content: placed.html,
        thumb_media_id: await coverId(),
      };
      let mediaId = ctx.newDraft
        ? undefined
        : entry?.status !== 'uncertain'
          ? entry?.mediaId
          : undefined;
      let outcome: 'created' | 'updated' = 'updated';
      if (mediaId) {
        progress(ctx, '更新草稿');
        try {
          await api.updateDraft(mediaId, draft);
        } catch (error) {
          if (!(error instanceof WechatApiError && error.errcode === 40007)) throw error;
          // 40007 可能是草稿不在了，也可能是缓存的封面素材失效：先回读确认。
          try {
            await api.getDraft(mediaId);
          } catch (readError) {
            if (!(readError instanceof WechatApiError && readError.errcode === 40007))
              throw readError;
            mediaId = undefined;
            warnings.push({
              code: 'WECHAT_DRAFT_GONE',
              message: '原草稿已删除或已发布，已新建草稿，请核对。',
            });
          }
          if (mediaId) {
            draft = { ...draft, thumb_media_id: await coverId(true) };
            await api.updateDraft(mediaId, draft);
          }
        }
      }
      if (!mediaId) {
        outcome = 'created';
        progress(ctx, '写入草稿');
        try {
          mediaId = await api.addDraft(draft);
        } catch (error) {
          if (error instanceof TransportError) {
            await save({ status: 'uncertain' });
            const detail: JinzhangError = {
              code: 'OUTCOME_UNCERTAIN',
              stage: 'push',
              platform: 'wechat',
              message: `创建草稿时${error.kind === 'timeout' ? '请求超时' : '连接中断'}，不知道草稿是否已经建好`,
              action: '先到公众号草稿箱确认；没有对应草稿再勾选确认后重推',
            };
            return { outcome: 'uncertain', message: detail.message, error: detail };
          }
          if (!(error instanceof WechatApiError && error.errcode === 40007) || coverUploaded)
            throw error;
          draft = { ...draft, thumb_media_id: await coverId(true) };
          mediaId = await api.addDraft(draft);
        }
        await save({ mediaId, status: 'unverified' });
      }
      progress(ctx, '回读校验');
      let checked: ReturnType<typeof verify>;
      try {
        checked = verify(await api.getDraft(mediaId), draft);
      } catch {
        checked = {
          verified: false,
          warnings: [
            { code: 'DRAFT_UNVERIFIED', message: '草稿已写入，但回读校验失败，请到草稿箱核对。' },
          ],
        };
      }
      await save({ mediaId, status: checked.verified ? 'confirmed' : 'unverified' });
      return {
        outcome,
        draftRef: mediaId,
        entryUrl: WECHAT_ENTRY_URL,
        warnings: [...store.warnings, ...warnings, ...checked.warnings],
        verification: checked.verified ? 'confirmed' : 'unverified',
        uploadedImages: store.uploaded,
      };
    } catch (error) {
      return { outcome: 'failed', error: wechatError(error, { chars }) };
    }
  },
};
