import { placeImages } from '../place';
import type { ImageRef, ImageStore, Warning } from '../types';
import { isRecord, type ZhihuImageEntry, type ZhihuSession, type ZhihuUser } from '../local';
import { fail, PublishError, toJinzhangError, type JinzhangError } from './errors';
import {
  responseJson,
  responseText,
  TransportError,
  wait,
  type HttpRequest,
  type HttpResponse,
  type PublishHost,
} from './host';
import { hmacSha1Base64, md5Hex } from './hash';
import { isPlatformHosted, type PreparedImage } from './images';
import {
  checkImages,
  draftMapping,
  images,
  otherAccountWarning,
  progress,
  summaryBase,
  templateWarnings,
  uncertainBlocker,
} from './common';
import type { PreflightReport, Publisher, PublishContext, PushResult } from './types';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const OSS_UA = 'aliyun-sdk-js/6.8.0 Chrome 140.0.0.0 on OS X 10.15.7';
const ZHUANLAN = 'https://zhuanlan.zhihu.com';
/** 草稿链路的最小集；其余几个有则带上。 */
export const ZHIHU_REQUIRED_COOKIES = ['z_c0', '_xsrf', 'd_c0'];
export const ZHIHU_COOKIE_KEYS = [
  ...ZHIHU_REQUIRED_COOKIES,
  'BEC',
  '_zap',
  'q_c1',
  'captcha_session_v2',
];
/** 解析浏览器里复制的 cookie：`a=1; b=2` 串或开发者工具表格里的「名称 Tab 值」行。 */
export function parseZhihuCookies(input: string) {
  const cookies: Record<string, string> = {};
  for (const line of input.replace(/^\s*cookie:\s*/i, '').split(/\r?\n/)) {
    const parts =
      line.includes('\t') && !/^[^\t]*=/.test(line)
        ? [line.split('\t').slice(0, 2).join('=')]
        : line.split(';');
    for (const part of parts) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const name = part.slice(0, index).trim();
      const value = part
        .slice(index + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1');
      if (ZHIHU_COOKIE_KEYS.includes(name) && value) cookies[name] = value;
    }
  }
  return { cookies, missing: ZHIHU_REQUIRED_COOKIES.filter((name) => !cookies[name]) };
}
export async function readZhihuSession(host: PublishHost) {
  const session = await host.secrets.get('zhihu-session');
  if (!session || !isRecord(session.cookies)) return undefined;
  return ZHIHU_REQUIRED_COOKIES.every(
    (name) => typeof session.cookies[name] === 'string' && session.cookies[name],
  )
    ? session
    : undefined;
}
const loginRequired = (message = '知乎登录已失效'): JinzhangError => ({
  code: 'ZHIHU_LOGIN_REQUIRED',
  stage: 'auth',
  platform: 'zhihu',
  message,
  action: '在锦章插件设置里重新登录知乎，或运行 jinzhang zhihu login',
});
const notLoggedIn: JinzhangError = {
  code: 'CONFIG_MISSING',
  stage: 'config',
  platform: 'zhihu',
  message: '还没有登录知乎',
  action: '在锦章插件设置里登录知乎，或运行 jinzhang zhihu login',
};
const isHtml = (response: HttpResponse) =>
  /text\/html/i.test(response.headers['content-type'] || '') ||
  /^\s*</.test(responseText(response).slice(0, 64));
/** 401、验证页归为需重新登录；403 与 10001、10003 归为风控，绝不因此新建草稿。 */
export function classifyZhihu(response: HttpResponse): JinzhangError | undefined {
  const ok = response.status >= 200 && response.status < 300;
  if (ok && !isHtml(response)) return undefined;
  const body = responseJson(response) as
    | { error?: { code?: unknown; message?: unknown; need_login?: unknown } }
    | undefined;
  const code = body?.error?.code;
  if (response.status === 401 || body?.error?.need_login === true) return loginRequired();
  if (response.status === 403 || code === 10001 || code === 10003)
    return {
      code: 'ZHIHU_RISK_CONTROL',
      stage: 'push',
      platform: 'zhihu',
      message: '知乎要求安全验证，本次请求被拦截',
      action: '先在浏览器里正常访问知乎完成验证再重试；反复出现就重新登录',
    };
  if (isHtml(response)) return loginRequired('知乎返回了验证页，需要重新登录');
  return {
    code: `ZHIHU_API_${typeof code === 'number' ? code : response.status}`,
    stage: 'push',
    platform: 'zhihu',
    message: `知乎接口返回错误 ${typeof code === 'number' ? code : `HTTP ${response.status}`}${typeof body?.error?.message === 'string' ? `：${body.error.message.slice(0, 120)}` : ''}`,
  };
}
export function zhihuError(error: unknown): JinzhangError {
  if (error instanceof PublishError) return error.detail;
  if (error instanceof TransportError)
    return {
      code: 'NETWORK_ERROR',
      stage: 'push',
      platform: 'zhihu',
      message: `连接知乎失败：${error.message}`,
      action: '检查网络后重试',
    };
  return toJinzhangError(error, { code: 'PUSH_FAILED', stage: 'push', platform: 'zhihu' });
}
/** 知乎的数字 id 可能超出安全整数，JSON.parse 会截断，这时从响应原文取。 */
function idField(value: unknown, text: string, name: string) {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'number') return text.match(new RegExp(`"${name}"\\s*:\\s*(\\d+)`))?.[1];
  return undefined;
}
interface ImageStatus {
  status?: string;
  src?: string;
  original_src?: string;
  watermark?: string;
  watermark_src?: string;
}
export class ZhihuApi {
  private last = 0;
  constructor(
    private host: PublishHost,
    private session: Pick<ZhihuSession, 'cookies'>,
  ) {}
  /** 单篇串行，请求间隔不少于 300 毫秒。 */
  private async send(request: HttpRequest, referer = `${ZHUANLAN}/`) {
    const gap = this.last + 300 - this.host.now().getTime();
    if (this.last && gap > 0) await wait(this.host, gap);
    this.last = this.host.now().getTime();
    const cookies = this.session.cookies;
    return this.host.http.request({
      timeoutMs: 30_000,
      ...request,
      platform: 'zhihu',
      headers: {
        'User-Agent': UA,
        'x-requested-with': 'fetch',
        'x-xsrftoken': cookies._xsrf,
        Origin: new URL(referer).origin,
        Referer: referer,
        Cookie: ZHIHU_COOKIE_KEYS.filter((name) => cookies[name])
          .map((name) => `${name}=${cookies[name]}`)
          .join('; '),
        ...request.headers,
      },
    });
  }
  private async json(request: HttpRequest, referer?: string) {
    const response = await this.send(request, referer);
    const failure = classifyZhihu(response);
    if (failure) throw fail(failure);
    return {
      body: (responseJson(response) ?? {}) as Record<string, any>,
      text: responseText(response),
    };
  }
  /** 校验登录态：401、403 或名字为「知乎用户」视为未登录。 */
  async me(): Promise<ZhihuUser> {
    const { body } = await this.json(
      { url: 'https://www.zhihu.com/api/v4/me', timeoutMs: 15_000 },
      'https://www.zhihu.com/',
    );
    if (!body.id || typeof body.name !== 'string' || !body.name || body.name === '知乎用户')
      throw fail(loginRequired());
    return {
      id: String(body.id),
      name: body.name,
      ...(typeof body.avatar_url === 'string' ? { avatarUrl: body.avatar_url } : {}),
    };
  }
  async createDraft(title: string) {
    const { body, text } = await this.json(
      {
        url: `${ZHUANLAN}/api/articles/drafts`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, delta_time: 0, can_reward: false }),
      },
      `${ZHUANLAN}/write`,
    );
    // 文章地址里的 id 是字符串，优先用它，避免从原文里匹配到嵌套对象的 id。
    const fromUrl = String(body.url ?? '').match(/\/p\/(\d+)/)?.[1];
    const id =
      typeof body.id === 'number' && !Number.isSafeInteger(body.id)
        ? (fromUrl ?? idField(body.id, text, 'id'))
        : (idField(body.id, text, 'id') ?? fromUrl);
    if (!id) throw new Error('知乎没有返回草稿 id');
    return id;
  }
  /** 写入草稿；404 表示草稿已不可用。 */
  async patchDraft(id: string, patch: Record<string, unknown>) {
    const response = await this.send(
      {
        url: `${ZHUANLAN}/api/articles/${encodeURIComponent(id)}/draft`,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
      `${ZHUANLAN}/p/${encodeURIComponent(id)}/edit`,
    );
    if (response.status === 404) return 'gone' as const;
    const failure = classifyZhihu(response);
    if (failure) throw fail(failure);
    return 'ok' as const;
  }
  /** MD5 → 申请上传 → 需要时按 OSS V1 签名直传 → 轮询处理结果。 */
  async uploadImage(image: PreparedImage): Promise<ZhihuImageEntry & { fallback?: boolean }> {
    const md5 = md5Hex(image.bytes);
    const { body: info, text } = await this.json({
      url: 'https://api.zhihu.com/images',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_hash: md5, source: 'article' }),
    });
    const file = info.upload_file ?? {};
    const imageId = idField(file.image_id, text, 'image_id');
    if (!imageId) throw new Error('知乎没有返回图片 id');
    if (file.state === 2) await this.putObject(md5, image, info.upload_token ?? {});
    let status: ImageStatus = {};
    for (let attempt = 0; attempt < 10; attempt++) {
      status = (await this.json({ url: `https://api.zhihu.com/images/${imageId}` })).body;
      if (status.status === 'success' && status.original_src) break;
      await wait(this.host, 1000);
    }
    const base = { md5, width: image.width, height: image.height };
    if (status.status !== 'success' || !status.original_src) {
      // 处理还没完成：对象已在存储上，按固定地址引用，不写缓存。
      const src = `https://picx.zhimg.com/v2-${md5}`;
      return {
        ...base,
        src,
        originalSrc: src,
        watermark: 'original',
        watermarkSrc: src,
        fallback: true,
      };
    }
    return {
      ...base,
      src: status.src || status.original_src,
      originalSrc: status.original_src,
      watermark: status.watermark || 'original',
      watermarkSrc: status.watermark_src || status.original_src,
    };
  }
  private async putObject(
    md5: string,
    image: PreparedImage,
    token: { access_id?: string; access_key?: string; access_token?: string },
  ) {
    if (!token.access_id || !token.access_key || !token.access_token)
      throw new Error('知乎没有返回图片上传凭据');
    const date = this.host.now().toUTCString();
    const signature = await hmacSha1Base64(
      token.access_key,
      `PUT\n\n${image.mime}\n${date}\nx-oss-date:${date}\nx-oss-security-token:${token.access_token}\nx-oss-user-agent:${OSS_UA}\n/zhihu-pics/v2-${md5}`,
    );
    const response = await this.host.http.request({
      url: `https://zhihu-pics-upload.zhimg.com/v2-${md5}`,
      method: 'PUT',
      platform: 'zhihu',
      timeoutMs: 60_000,
      headers: {
        'User-Agent': UA,
        'Content-Type': image.mime,
        'x-oss-date': date,
        'x-oss-user-agent': OSS_UA,
        'x-oss-security-token': token.access_token,
        Authorization: `OSS ${token.access_id}:${signature}`,
      },
      body: image.bytes,
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error(`知乎图片上传失败：HTTP ${response.status}`);
  }
}
/** 推送路径返回知乎要求的图片属性；复制路径只给 src。 */
export class ZhihuImageStore implements ImageStore {
  uploaded = 0;
  warnings: Warning[] = [];
  private done = 0;
  constructor(
    private api: ZhihuApi,
    private ctx: PublishContext,
    private account: string,
    private total: number,
    private withAttrs: boolean,
  ) {}
  async entry(prepared: PreparedImage, label: string) {
    const cached = (await this.ctx.host.store.read()).images[prepared.hash]?.zhihu?.[this.account];
    if (isRecord(cached) && typeof cached.originalSrc === 'string' && cached.originalSrc)
      return cached as ZhihuImageEntry;
    progress(this.ctx, label);
    const uploaded = await this.api.uploadImage(prepared);
    this.uploaded++;
    if (!uploaded.fallback) {
      const { fallback, ...entry } = uploaded;
      await this.ctx.host.store.update((state) => {
        const item = (state.images[prepared.hash] ??= {});
        (item.zhihu ??= {})[this.account] = entry;
      });
    }
    return uploaded;
  }
  async put(image: ImageRef) {
    this.done++;
    const source = image.source;
    if (
      (source.kind === 'remote' || source.kind === 'hosted') &&
      isPlatformHosted(source.url, 'zhihu')
    )
      return { src: source.url };
    const prepared = await images(this.ctx).prepare(image);
    if (prepared.animated)
      this.warnings.push({
        code: 'GIF_FIRST_FRAME',
        ref: image.original,
        message: '动图已转为静态首帧。',
      });
    const entry = await this.entry(prepared, `上传图片 ${this.done}/${this.total}`);
    const ext = prepared.mime === 'image/png' ? 'png' : 'jpg';
    const src = `${entry.originalSrc}.${ext}`;
    if (!this.withAttrs) return { src };
    return {
      src,
      attrs: {
        'data-caption': '',
        'data-size': 'normal',
        'data-rawwidth': String(entry.width),
        'data-rawheight': String(entry.height),
        'data-watermark': entry.watermark,
        'data-original-src': src,
        'data-watermark-src': `${entry.watermarkSrc}.${ext}`,
      },
    };
  }
}
/** 知乎复制路径：要求已登录，图片经知乎图片接口上传后复制。 */
export async function createZhihuCopyStore(ctx: PublishContext, total: number) {
  const session = await readZhihuSession(ctx.host);
  if (!session) throw fail(notLoggedIn);
  const api = new ZhihuApi(ctx.host, session);
  const user = await api.me();
  return new ZhihuImageStore(api, ctx, user.id, total, false);
}
/** 校验 cookie 并写入共享登录态，命令行与插件任一处登录另一处即可用。 */
export async function saveZhihuLogin(host: PublishHost, cookies: Record<string, string>) {
  const kept = Object.fromEntries(
    ZHIHU_COOKIE_KEYS.filter((name) => cookies[name]).map((name) => [name, cookies[name]]),
  );
  const missing = ZHIHU_REQUIRED_COOKIES.filter((name) => !kept[name]);
  if (missing.length) throw fail(loginRequired(`登录信息缺少 ${missing.join('、')}`));
  const user = await new ZhihuApi(host, { cookies: kept }).me();
  await host.secrets.set('zhihu-session', {
    cookies: kept,
    user,
    updatedAt: host.now().toISOString(),
  });
  return user;
}
export async function zhihuStatus(host: PublishHost) {
  const session = await readZhihuSession(host);
  if (!session) return { loggedIn: false as const };
  try {
    return { loggedIn: true as const, user: await new ZhihuApi(host, session).me() };
  } catch (error) {
    return { loggedIn: false as const, user: session.user, error: zhihuError(error) };
  }
}
const nonZhihu = new Set(['TITLE_TOO_LONG', 'CONTENT_NEAR_LIMIT']);
export const zhihuPublisher: Publisher = {
  platform: 'zhihu',
  async preflight(article, ctx) {
    const blockers: JinzhangError[] = [];
    const warnings: Warning[] = article.warnings.filter((w) => !nonZhihu.has(w.code));
    const session = await readZhihuSession(ctx.host);
    let user: ZhihuUser | undefined;
    if (!session) blockers.push(notLoggedIn);
    else
      try {
        user = await new ZhihuApi(ctx.host, session).me();
      } catch (error) {
        blockers.push({ ...zhihuError(error), stage: 'preflight' });
      }
    const state = await ctx.host.store.read();
    const { entry, otherAccount } = draftMapping(
      state,
      ctx,
      'zhihu',
      user?.id ?? session?.user?.id,
    );
    if (otherAccount) warnings.push(otherAccountWarning('zhihu'));
    const summary = summaryBase(article, ctx, entry);
    summary.account = user?.name ?? session?.user?.name;
    if (entry?.status === 'uncertain' && !ctx.confirmUncertain)
      blockers.push(uncertainBlocker('zhihu'));
    if (!article.cover)
      warnings.push({ code: 'COVER_MISSING', message: '没有封面，知乎草稿不会设置题图。' });
    const checked = await checkImages(article, ctx, 'zhihu', (url) =>
      isPlatformHosted(url, 'zhihu'),
    );
    blockers.push(...checked.blockers);
    warnings.push(...checked.warnings, ...templateWarnings(ctx, 'zhihu'));
    if (article.degraded.length)
      warnings.push({
        code: 'ZHIHU_DEGRADED',
        message: `${article.degraded.length} 处内容在知乎会降级或丢弃，预览末尾有逐条标注。`,
      });
    return {
      platform: 'zhihu',
      ok: !blockers.length,
      blockers,
      warnings,
      summary,
    } satisfies PreflightReport;
  },
  async push(article, ctx): Promise<PushResult> {
    const session = await readZhihuSession(ctx.host);
    if (!session) return { outcome: 'failed', error: { ...notLoggedIn, stage: 'push' } };
    const api = new ZhihuApi(ctx.host, session);
    const warnings: Warning[] = [];
    try {
      const user = await api.me();
      const state = await ctx.host.store.read();
      const { entry } = draftMapping(state, ctx, 'zhihu', user.id);
      if (entry?.status === 'uncertain' && !ctx.confirmUncertain)
        return { outcome: 'failed', error: { ...uncertainBlocker('zhihu'), stage: 'push' } };
      const save = (patch: {
        draftId?: string;
        status: 'confirmed' | 'unverified' | 'uncertain';
      }) =>
        ctx.host.store.update((s) => {
          (s.drafts[ctx.source] ??= {}).zhihu = {
            account: user.id,
            title: article.title,
            ...patch,
            updatedAt: ctx.host.now().toISOString(),
          };
        });
      const store = new ZhihuImageStore(api, ctx, user.id, article.images.length, true);
      const placed = await placeImages(article, store);
      let titleImage: string | undefined;
      if (article.cover)
        titleImage = (await store.entry(await images(ctx).prepare(article.cover), '上传封面'))
          .originalSrc;
      const content = {
        title: article.title,
        content: placed.html,
        table_of_contents: false,
        delta_time: 30,
        can_reward: false,
      };
      let draftId = ctx.newDraft
        ? undefined
        : entry?.status !== 'uncertain'
          ? entry?.draftId
          : undefined;
      let outcome: 'created' | 'updated' = 'updated';
      if (draftId) {
        progress(ctx, '更新草稿');
        if ((await api.patchDraft(draftId, content)) === 'gone') {
          draftId = undefined;
          warnings.push({
            code: 'ZHIHU_DRAFT_GONE',
            message: '原草稿已不可用，已新建草稿，请核对。',
          });
        } else
          warnings.push({
            code: 'ZHIHU_DRAFT_UPDATED',
            message: '如果这篇已在知乎发布，更新只写进草稿，不改线上内容。',
          });
      }
      if (!draftId) {
        outcome = 'created';
        progress(ctx, '创建草稿');
        try {
          draftId = await api.createDraft(article.title);
        } catch (error) {
          if (!(error instanceof TransportError)) throw error;
          await save({ status: 'uncertain' });
          const detail: JinzhangError = {
            code: 'OUTCOME_UNCERTAIN',
            stage: 'push',
            platform: 'zhihu',
            message: `创建草稿时${error.kind === 'timeout' ? '请求超时' : '连接中断'}，不知道草稿是否已经建好`,
            action: '先到知乎创作中心的草稿箱确认；没有对应草稿再勾选确认后重推',
          };
          return { outcome: 'uncertain', message: detail.message, error: detail };
        }
        await save({ draftId, status: 'unverified' });
        progress(ctx, '写入草稿');
        if ((await api.patchDraft(draftId, content)) === 'gone')
          throw new Error('新建的知乎草稿写入失败，请稍后重试');
      }
      if (titleImage)
        await api.patchDraft(draftId, {
          titleImage,
          isTitleImageFullScreen: false,
          delta_time: 30,
        });
      await save({ draftId, status: 'confirmed' });
      if (!session.user || session.user.id !== user.id || session.user.name !== user.name)
        await ctx.host.secrets.set('zhihu-session', { ...session, user });
      return {
        outcome,
        draftRef: draftId,
        entryUrl: `${ZHUANLAN}/p/${encodeURIComponent(draftId)}/edit`,
        warnings: [...store.warnings, ...warnings],
        verification: 'not_run',
        uploadedImages: store.uploaded,
      };
    } catch (error) {
      return { outcome: 'failed', error: zhihuError(error) };
    }
  },
};
