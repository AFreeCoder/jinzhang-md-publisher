import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Root, Nodes } from 'mdast';
import type { AssetResolver, ResolvedAsset, Warning } from '../types';
import {
  blogTarget,
  type BlogConfig,
  type BlogPostEntry,
  type BlogTarget,
  type JinzhangState,
} from '../local';
import { stripFrontmatter } from '../frontmatter';
import { fail, PublishError, toJinzhangError, type JinzhangError } from './errors';
import { responseJson, TransportError, type HttpResponse, type PublishHost } from './host';
import { sha256Hex } from './hash';
import { LongTermImageStore, readOssConfig } from './oss';
import type { PushResult } from './types';

/**
 * 博客（文章接口，协议同 gpt101.org 的 `/api/v1/articles`）：提交 Markdown，由网站自己渲染。
 * 本地图片原样传到长期图床再改写地址，网络图片保留原地址；推送即发布。
 */

export interface BlogImage {
  original: string;
  source: ResolvedAsset;
}
interface Edit {
  start: number;
  end: number;
  text(url: (ref: string) => string): string;
}
export interface BlogArticle {
  title: string;
  /** 去掉属性区后的原文，`edits` 的位置都相对它。 */
  source: string;
  /** 按出现顺序去重。 */
  images: BlogImage[];
  cover: BlogImage | null;
  /** 正文前 120 字，新建文章时作为摘要。 */
  description: string;
  warnings: Warning[];
  edits: Edit[];
}

const escapeAlt = (alt: string) => alt.replace(/[\\[\]]/g, '\\$&');
const escapeTitle = (title: string) => `"${title.replace(/["\\]/g, '\\$&')}"`;
/** 地址里的括号与空白会截断 Markdown 链接，编码掉。 */
const safeUrl = (url: string) =>
  url.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

function plainText(node: Nodes): string {
  if (node.type === 'code' || node.type === 'html' || node.type === 'image') return '';
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (!('children' in node)) return '';
  const inner = node.children.map((child) => plainText(child as Nodes)).join('');
  return node.type === 'root' || node.type === 'link' || node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete'
    ? inner
    : `${inner} `;
}

/**
 * 解析 Markdown，收集要改写的图片：行内图片、引用式图片的定义、HTML `<img src>`。
 * 第一个一级标题与标题相同时去掉（业务规则 6.1，网站另有标题字段）。
 */
export async function prepareBlog(
  input: { markdown: string; title: string; cover?: string },
  resolver: AssetResolver,
): Promise<BlogArticle> {
  const { source } = stripFrontmatter(input.markdown);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Root;
  const edits: Edit[] = [];
  const refs: string[] = [];
  const add = (ref: string) => {
    if (ref && !refs.includes(ref)) refs.push(ref);
  };
  const title = input.title.trim();
  const heading = tree.children.find((node) => node.type === 'heading' && node.depth === 1);
  let skip: Nodes | undefined;
  if (heading?.position && title && plainText(heading).trim() === title) {
    skip = heading;
    edits.push({
      start: heading.position.start.offset!,
      end: heading.position.end.offset!,
      text: () => '',
    });
  }
  const imageLabels = new Set<string>();
  visit(tree, 'imageReference', (node) => {
    imageLabels.add(node.identifier);
  });
  visit(tree, (node) => {
    const at = node.position;
    if (!at || at.start.offset === undefined || at.end.offset === undefined) return;
    if (node.type === 'image') {
      add(node.url);
      const { alt, url, title: hint } = node;
      edits.push({
        start: at.start.offset,
        end: at.end.offset,
        text: (map) => `![${escapeAlt(alt ?? '')}](${map(url)}${hint ? ` ${escapeTitle(hint)}` : ''})`,
      });
    } else if (node.type === 'definition' && imageLabels.has(node.identifier)) {
      add(node.url);
      const { label, identifier, url, title: hint } = node;
      edits.push({
        start: at.start.offset,
        end: at.end.offset,
        text: (map) => `[${label ?? identifier}]: ${map(url)}${hint ? ` ${escapeTitle(hint)}` : ''}`,
      });
    } else if (node.type === 'html') {
      // 只换 src 的值，引用块与列表里的 HTML 也不会碰到行首的前缀。
      const slice = source.slice(at.start.offset, at.end.offset);
      for (const match of slice.matchAll(/(<img\b[^>]*?\ssrc\s*=\s*)(["'])(.*?)\2/gis)) {
        const ref = match[3];
        add(ref);
        const start = at.start.offset + match.index! + match[1].length + 1;
        edits.push({ start, end: start + ref.length, text: (map) => map(ref) });
      }
    }
  });
  const resolved = new Map<string, ResolvedAsset>();
  for (const ref of refs) resolved.set(ref, await resolver.resolve(ref));
  const images = refs.map((original) => ({ original, source: resolved.get(original)! }));
  let cover: BlogImage | null = null;
  if (input.cover) cover = { original: input.cover, source: await resolver.resolve(input.cover) };
  else cover = images[0] ?? null;
  const text = tree.children
    .filter((node) => node !== skip)
    .map((node) => plainText(node))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title,
    source,
    images,
    cover,
    description: Array.from(text).slice(0, 120).join(''),
    warnings: [],
    edits: edits.sort((a, b) => a.start - b.start),
  };
}

/** 按图片地址表生成要提交的 Markdown；表里没有的引用保持原样。 */
export function blogMarkdown(article: BlogArticle, urls: Map<string, string> = new Map()) {
  const map = (ref: string) => {
    const url = urls.get(ref);
    return url ? safeUrl(url) : ref;
  };
  let out = '';
  let cursor = 0;
  for (const edit of article.edits) {
    if (edit.start < cursor) continue;
    out += article.source.slice(cursor, edit.start) + edit.text(map);
    cursor = edit.end;
  }
  out += article.source.slice(cursor);
  return `${out.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()}\n`;
}

const hasBytes = (image: BlogImage): image is BlogImage & { source: { bytes: Uint8Array; mime: string; assetId?: string } } =>
  'bytes' in image.source;
const localImages = (article: BlogArticle) => {
  const all = [...article.images];
  if (article.cover && !all.some((image) => image.original === article.cover!.original))
    all.push(article.cover);
  return all.filter(hasBytes);
};
const imageInput = (image: BlogImage & { source: { bytes: Uint8Array; mime: string; assetId?: string } }) => ({
  bytes: image.source.bytes,
  mime: image.source.mime,
  name: image.source.assetId ?? image.original,
  ref: image.original,
});

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,159}$/;
/** 文件名全是英文字母、数字与常见符号时转成 slug；含中文等时不猜，由用户填写。 */
export function suggestSlug(title: string) {
  if (!/^[\x20-\x7e]+$/.test(title)) return '';
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 160);
  return SLUG_PATTERN.test(slug) ? slug : '';
}

export interface BlogRemote {
  slug: string;
  title: string;
  content: string;
  status: string;
  etag: string;
  /** 前台相对地址，如 `/tutorials/<slug>`。 */
  url: string;
}
export interface BlogContext {
  host: PublishHost;
  /** 源文件规范化后的绝对路径，映射的键。 */
  source: string;
  blog: BlogConfig;
  /** 同一次操作共用：多个博客、体检与推送对同一张图只算一次。 */
  store?: LongTermImageStore;
  onProgress?: (message: string) => void;
}
export interface BlogSummary {
  title: string;
  /** 要传到长期图床的本地图片数（含封面）。 */
  localImages: number;
  remoteImages: number;
  cover: string | null;
  chars: number;
}
export interface BlogPreflight {
  target: BlogTarget;
  blog: BlogConfig;
  ok: boolean;
  /** `BLOG_REMOTE_CHANGED` 可以在确认时勾选覆盖，其余必须先处理。 */
  blockers: JinzhangError[];
  warnings: Warning[];
  /** create：首次推送，需要填写 slug；update：按映射更新；recreate：网站上已没有，按原 slug 重新发布。 */
  mode: 'create' | 'update' | 'recreate';
  slug?: string;
  suggestion: string;
  remote: BlogRemote | null;
  summary: BlogSummary;
}
export type SlugCheck = { state: 'free' } | { state: 'taken'; remote: BlogRemote };

const contentHash = (title: string, content: string) =>
  sha256Hex(new TextEncoder().encode(JSON.stringify([title, content])));

function entryOf(state: JinzhangState, ctx: BlogContext) {
  const entry = state.drafts[ctx.source]?.blogs?.[ctx.blog.id];
  return entry && entry.account === ctx.blog.url && typeof entry.slug === 'string' && entry.slug
    ? entry
    : undefined;
}

async function apiKeyOf(ctx: BlogContext) {
  const key = (await ctx.host.secrets.get('credentials'))?.blogs?.[ctx.blog.id]?.apiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : undefined;
}

/** 文章接口的读写；错误统一成带下一步的 PublishError。 */
class ArticleApi {
  constructor(
    private ctx: BlogContext,
    private apiKey: string,
  ) {}
  private get blog() {
    return this.ctx.blog;
  }
  private error(response: HttpResponse, stage: 'preflight' | 'push'): PublishError {
    const body = responseJson(response) as { error?: { code?: unknown; message?: unknown } } | undefined;
    const code = typeof body?.error?.code === 'string' ? body.error.code : '';
    const said = typeof body?.error?.message === 'string' ? body.error.message : '';
    const platform = blogTarget(this.blog.id);
    const detail = (c: string, message: string, action?: string) =>
      fail({ code: c, stage, platform, message, action });
    switch (response.status) {
      case 401:
        return detail(
          'BLOG_AUTH',
          `${this.blog.name} 的 API Key 无效或已删除`,
          `到 ${this.blog.url}/settings/apikeys/create 重新创建，填进设置 → 锦章 → 博客`,
        );
      case 403:
        return detail(
          'BLOG_FORBIDDEN',
          `${this.blog.name} 的 API Key 所属账号没有文章读写权限`,
          '用有文章管理权限的账号创建 API Key',
        );
      case 409:
        return detail(
          'BLOG_SLUG_TAKEN',
          code === 'local_article'
            ? '这个文章地址属于网站仓库里的 MDX 文章，接口不能改'
            : '网站上已有这个地址的文章',
          '换一个文章地址（slug）重推',
        );
      case 412:
        return detail(
          'BLOG_REMOTE_CHANGED',
          '推送期间网站上的这篇又被改过',
          '重新推送：确认框里会再次显示网站上的状态',
        );
      case 413:
        return detail('BLOG_TOO_LARGE', '正文超过接口上限 1 MiB', '拆成多篇，或删减正文');
      default:
        return detail(
          response.status >= 500 ? 'BLOG_SERVER_ERROR' : 'BLOG_API_ERROR',
          `${this.blog.name} 返回 HTTP ${response.status}${said ? `：${said}` : ''}`,
          response.status >= 500 ? '稍后重试' : undefined,
        );
    }
  }
  async request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    etag?: string,
  ): Promise<HttpResponse> {
    return this.ctx.host.http.request({
      url: `${this.blog.url}/api/v1/articles${path}`,
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(etag ? { 'If-Match': etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: 30_000,
    });
  }
  private remote(response: HttpResponse): BlogRemote {
    const data = (responseJson(response) as { data?: Record<string, unknown> } | undefined)?.data;
    const etag =
      (typeof data?.etag === 'string' && data.etag) || response.headers.etag || '';
    if (!data || typeof data.slug !== 'string' || !etag)
      throw fail({
        code: 'BLOG_API_ERROR',
        stage: 'push',
        platform: blogTarget(this.blog.id),
        message: `${this.blog.name} 返回的内容无法识别`,
        action: '确认博客地址填的是站点首页地址',
      });
    return {
      slug: data.slug,
      title: typeof data.title === 'string' ? data.title : '',
      content: typeof data.content === 'string' ? data.content : '',
      status: typeof data.status === 'string' ? data.status : '',
      etag,
      url: typeof data.url === 'string' ? data.url : `/tutorials/${data.slug}`,
    };
  }
  async get(slug: string, stage: 'preflight' | 'push' = 'push') {
    const response = await this.request('GET', `/${encodeURIComponent(slug)}`);
    if (response.status === 404) return null;
    if (response.status !== 200) throw this.error(response, stage);
    return this.remote(response);
  }
  /** 只读校验 Key 与读取权限。 */
  async verify() {
    const response = await this.request('GET', '?limit=1');
    if (response.status !== 200) throw this.error(response, 'preflight');
  }
  async save(method: 'POST' | 'PATCH', path: string, payload: unknown, etag?: string) {
    const response = await this.request(method, path, payload, etag);
    if (response.status !== 200 && response.status !== 201) throw this.error(response, 'push');
    const saved = (responseJson(response) as { warnings?: unknown } | undefined)?.warnings;
    return { remote: this.remote(response), cacheWarning: Array.isArray(saved) && saved.length > 0 };
  }
}

const networkError = (ctx: BlogContext, error: unknown, stage: 'preflight' | 'push'): JinzhangError => ({
  code: 'NETWORK_ERROR',
  stage,
  platform: blogTarget(ctx.blog.id),
  message: `连不上 ${ctx.blog.name}：${error instanceof Error ? error.message : '网络错误'}`,
  action: '检查网络与博客地址后重试',
});

/** 要提交的正文：本地图片换成长期图床地址（按内容哈希，不联网就能算出）。 */
async function plannedContent(article: BlogArticle, store: LongTermImageStore | undefined) {
  const urls = new Map<string, string>();
  if (store)
    for (const image of localImages(article))
      urls.set(image.original, (await store.locate(imageInput(image))).url);
  return { content: blogMarkdown(article, urls), urls };
}

async function storeOf(ctx: BlogContext) {
  if (ctx.store) return ctx.store;
  const config = await readOssConfig(ctx.host);
  return config ? (ctx.store = new LongTermImageStore(ctx.host, config)) : undefined;
}

const CONTENT_LIMIT = 500_000;

export const blogPublisher = {
  /** 只读：查凭证、图片、正文长度与网站上的现状；不上传、不写入。 */
  async preflight(article: BlogArticle, ctx: BlogContext): Promise<BlogPreflight> {
    const platform = blogTarget(ctx.blog.id);
    const blockers: JinzhangError[] = [];
    const warnings: Warning[] = [...article.warnings];
    const block = (code: string, message: string, action?: string, ref?: string) =>
      blockers.push({ code, stage: 'preflight', platform, message, action, ref });
    const local = localImages(article);
    const all = [...article.images, ...(article.cover && !article.images.includes(article.cover) ? [article.cover] : [])];
    for (const image of all)
      if (image.source.kind === 'missing')
        block('IMAGE_MISSING', `图片无法解析：${image.source.reason}`, '检查图片路径，或把图片放进 vault 后重试', image.original);
    for (const image of local)
      if (!image.source.mime.startsWith('image/'))
        block('IMAGE_UNSUPPORTED', `不是图片文件（${image.source.mime}）`, '换成 PNG、JPG、GIF、WebP 或 SVG', image.original);
    const remoteImages = all.filter((image) => image.source.kind === 'remote' || image.source.kind === 'hosted');
    const store = await storeOf(ctx);
    if (local.length && !store)
      block(
        'OSS_MISSING',
        '还没有配置长期图床，本地图片无法上传',
        '在设置 → 锦章 → 长期图床里填写 OSS 配置',
      );
    const { content } = await plannedContent(article, store);
    const summary: BlogSummary = {
      title: article.title,
      localImages: local.length,
      remoteImages: remoteImages.length,
      cover: article.cover?.original ?? null,
      chars: content.length,
    };
    if (remoteImages.length)
      warnings.push({
        code: 'IMAGE_REMOTE_KEPT',
        message: `${remoteImages.length} 张网络图片保留原地址，原站失效或防盗链时会显示不出来。`,
      });
    if (!article.title) block('TITLE_MISSING', '标题为空', '给笔记起个文件名');
    else if (article.title.length > 300) block('TITLE_TOO_LONG', '标题超过 300 字', '缩短文件名');
    if (!content.trim()) block('CONTENT_EMPTY', '正文为空，不能发布');
    else if (content.length > CONTENT_LIMIT)
      block('BLOG_TOO_LARGE', '正文超过 50 万字符', '拆成多篇，或删减正文');
    const entry = entryOf(await ctx.host.store.read(), ctx);
    const base = { target: platform, blog: ctx.blog, warnings, summary, suggestion: suggestSlug(article.title) };
    const apiKey = await apiKeyOf(ctx);
    if (!ctx.blog.url) block('CONFIG_MISSING', `还没有填 ${ctx.blog.name} 的地址`, '在设置 → 锦章 → 博客里填写');
    if (!apiKey)
      block(
        'CONFIG_MISSING',
        `还没有填 ${ctx.blog.name} 的 API Key`,
        `到 ${ctx.blog.url || '博客'}/settings/apikeys/create 创建，填进设置 → 锦章 → 博客`,
      );
    if (!apiKey || !ctx.blog.url)
      return { ...base, ok: false, blockers, mode: entry ? 'update' : 'create', slug: entry?.slug, remote: null };
    const api = new ArticleApi(ctx, apiKey);
    let remote: BlogRemote | null = null;
    try {
      if (entry) remote = await api.get(entry.slug, 'preflight');
      else await api.verify();
    } catch (error) {
      blockers.push(
        error instanceof PublishError ? { ...error.detail, stage: 'preflight' } : networkError(ctx, error, 'preflight'),
      );
      return { ...base, ok: false, blockers, mode: entry ? 'update' : 'create', slug: entry?.slug, remote: null };
    }
    if (!entry) return { ...base, ok: !blockers.length, blockers, mode: 'create', remote: null };
    if (!remote) {
      warnings.push({
        code: 'BLOG_REMOTE_GONE',
        message: `网站上已找不到这篇（${entry.slug}），本次按原地址重新发布。`,
      });
      return { ...base, ok: !blockers.length, blockers, mode: 'recreate', slug: entry.slug, remote };
    }
    const now = await contentHash(remote.title, remote.content);
    const changed =
      (entry.status === 'uncertain' || now !== entry.hash) &&
      now !== (await contentHash(article.title, content));
    if (changed)
      block(
        'BLOG_REMOTE_CHANGED',
        entry.status === 'uncertain'
          ? '上次推送结果不确定，网站上这篇的标题或正文与笔记不同'
          : '网站上这篇的标题或正文在上次推送后被改过',
        '要用笔记覆盖网站上的版本，就在确认框勾选「覆盖网站上的版本」；否则先把网站上的改动合并回笔记',
      );
    return { ...base, ok: !blockers.length, blockers, mode: 'update', slug: entry.slug, remote };
  },

  /** 确认框里检查用户填的 slug：网站上没有，或已有哪篇。 */
  async check(slug: string, ctx: BlogContext): Promise<SlugCheck> {
    const apiKey = await apiKeyOf(ctx);
    if (!apiKey) throw new Error(`还没有填 ${ctx.blog.name} 的 API Key`);
    try {
      const remote = await new ArticleApi(ctx, apiKey).get(slug, 'preflight');
      return remote ? { state: 'taken', remote } : { state: 'free' };
    } catch (error) {
      if (error instanceof PublishError) throw error;
      throw new PublishError(networkError(ctx, error, 'preflight'));
    }
  },

  /**
   * 上传本地图片后发布：网站上没有就新建，有就带 If-Match 更新。网站上的版本被改过、或 slug 已被别的文章占用时，
   * 只有 `overwrite` 才覆盖。请求超时按 slug 读回核对，对不上记为结果不确定。
   */
  async push(
    article: BlogArticle,
    ctx: BlogContext,
    choice: { slug: string; overwrite: boolean },
  ): Promise<PushResult> {
    const platform = blogTarget(ctx.blog.id);
    const failed = (error: unknown): PushResult => ({
      outcome: 'failed',
      error:
        error instanceof TransportError
          ? networkError(ctx, error, 'push')
          : toJinzhangError(error, { code: 'PUSH_FAILED', stage: 'push', platform }),
    });
    const slug = choice.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug))
      return failed(
        fail({
          code: 'SLUG_INVALID',
          stage: 'push',
          platform,
          message: '文章地址只能用小写字母、数字、-、_，并以字母或数字开头',
        }),
      );
    const apiKey = await apiKeyOf(ctx);
    if (!apiKey)
      return failed(fail({ code: 'CONFIG_MISSING', stage: 'push', platform, message: `还没有填 ${ctx.blog.name} 的 API Key` }));
    const api = new ArticleApi(ctx, apiKey);
    const store = await storeOf(ctx);
    const local = localImages(article);
    const urls = new Map<string, string>();
    try {
      if (local.length && !store)
        throw fail({
          code: 'OSS_MISSING',
          stage: 'push',
          platform,
          message: '还没有配置长期图床，本地图片无法上传',
          action: '在设置 → 锦章 → 长期图床里填写 OSS 配置',
        });
      for (const [index, image] of local.entries()) {
        ctx.onProgress?.(`上传图片 ${index + 1}/${local.length}`);
        urls.set(image.original, await store!.upload(imageInput(image)));
      }
    } catch (error) {
      return failed(error);
    }
    const content = blogMarkdown(article, urls);
    const cover = article.cover
      ? urls.get(article.cover.original) ??
        (article.cover.source.kind === 'remote' || article.cover.source.kind === 'hosted'
          ? article.cover.source.url
          : '')
      : '';
    const hash = await contentHash(article.title, content);
    const state = await ctx.host.store.read();
    const entry = entryOf(state, ctx);
    const record = (patch: Omit<BlogPostEntry, 'account' | 'slug' | 'updatedAt' | 'title'>) =>
      ctx.host.store.update((next) => {
        const drafts = (next.drafts[ctx.source] ??= {});
        const blogs = (drafts.blogs ??= {});
        blogs[ctx.blog.id] = {
          account: ctx.blog.url,
          slug,
          title: article.title,
          updatedAt: ctx.host.now().toISOString(),
          ...patch,
        };
      });
    ctx.onProgress?.('读取网站上的版本');
    let remote: BlogRemote | null;
    try {
      remote = await api.get(slug);
    } catch (error) {
      return failed(error);
    }
    const ours = entry?.slug === slug;
    if (remote && !choice.overwrite) {
      if (!ours)
        return failed(
          fail({
            code: 'BLOG_SLUG_TAKEN',
            stage: 'push',
            platform,
            message: `网站上已有这个地址的文章《${remote.title}》`,
            action: '换一个文章地址；如果那篇就是这篇笔记，在确认框勾选覆盖',
          }),
        );
      const now = await contentHash(remote.title, remote.content);
      if ((entry!.status === 'uncertain' || now !== entry!.hash) && now !== hash)
        return failed(
          fail({
            code: 'BLOG_REMOTE_CHANGED',
            stage: 'push',
            platform,
            message: '网站上这篇的标题或正文在上次推送后被改过',
            action: '重新推送，在确认框勾选「覆盖网站上的版本」',
          }),
        );
    }
    ctx.onProgress?.(remote ? '更新文章' : '发布文章');
    const payload = remote
      ? { title: article.title, content, status: 'published', ...(cover ? { image: cover } : {}) }
      : {
          slug,
          title: article.title,
          content,
          description: article.description,
          image: cover,
          status: 'published',
        };
    const warnings: Warning[] = [];
    const done = async (saved: BlogRemote, cacheWarning: boolean, verified: boolean): Promise<PushResult> => {
      await record({ hash, status: 'confirmed' });
      if (cacheWarning)
        warnings.push({
          code: 'BLOG_CACHE_STALE',
          message: '网站已保存，但页面缓存刷新失败，前台可能稍后才显示新内容。',
        });
      return {
        outcome: remote ? 'updated' : 'created',
        draftRef: saved.slug,
        entryUrl: `${ctx.blog.url}${saved.url}`,
        warnings,
        verification: verified ? 'confirmed' : 'unverified',
        uploadedImages: store?.uploaded ?? 0,
      };
    };
    try {
      const saved = remote
        ? await api.save('PATCH', `/${encodeURIComponent(slug)}`, payload, remote.etag)
        : await api.save('POST', '', payload);
      return await done(saved.remote, saved.cacheWarning, true);
    } catch (error) {
      if (!(error instanceof TransportError)) return failed(error);
      // 超时或断线：网站可能已经保存，按同一 slug 读回核对，不重放写入。
      try {
        const after = await api.get(slug);
        if (after && after.title === article.title && after.content === content)
          return await done(after, false, true);
      } catch {
        /* 读回也失败时按结果不确定处理。 */
      }
      await record({ status: 'uncertain' });
      const detail: JinzhangError = {
        code: 'OUTCOME_UNCERTAIN',
        stage: 'push',
        platform,
        message: `${error.message}，不确定 ${ctx.blog.name} 是否已保存`,
        action: '直接重新推送：会先读取网站上的版本，与笔记不同时再让你确认是否覆盖',
      };
      return { outcome: 'uncertain', message: detail.message, error: detail };
    }
  },
};
