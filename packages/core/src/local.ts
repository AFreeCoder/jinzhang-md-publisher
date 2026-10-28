import type { Platform, ThemeId, WechatCard } from './types';
export type { WechatCard } from './types';
/** 本地形态（命令行与插件）共用的配置、状态与凭证结构，读写实现见 `./node`。 */
export const PLATFORMS: Platform[] = ['wechat', 'zhihu'];
/** 通过文章接口推送的博客（与 gpt101.org 的 `/api/v1/articles` 同一套协议）。 */
export interface BlogConfig {
  /** 默认推送目标与凭证都按它对应，写成 `blog:<id>`。 */
  id: string;
  name: string;
  /** 站点地址，不带结尾斜杠，例如 `https://gpt101.org`。 */
  url: string;
}
export type BlogTarget = `blog:${string}`;
/** 推送目标：两个排版平台，或某个博客。 */
export type Target = Platform | BlogTarget;
export const blogTarget = (id: string): BlogTarget => `blog:${id}`;
export const isBlogTarget = (target: string): target is BlogTarget => target.startsWith('blog:');
export const DEFAULT_BLOGS: BlogConfig[] = [
  { id: 'gpt101', name: 'GPT101', url: 'https://gpt101.org' },
];
const BLOG_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** 博客地址只认 http(s)，去掉结尾斜杠；无效返回空串。 */
export function normalizeBlogUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return '';
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}
function normalizeBlogs(raw: unknown): BlogConfig[] {
  if (!Array.isArray(raw)) return DEFAULT_BLOGS.map((blog) => ({ ...blog }));
  const blogs: BlogConfig[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || !BLOG_ID.test(item.id)) continue;
    if (blogs.some((blog) => blog.id === item.id)) continue;
    blogs.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id,
      url: normalizeBlogUrl(item.url),
    });
  }
  return blogs;
}
export interface JinzhangConfig {
  version: 1;
  /** 作者名：开头样式一的「作者」一行，也是模板变量 `{{author}}` 的取值。 */
  author: string;
  theme: ThemeId;
  /** 「推送到默认平台」的目标；博客写成 `blog:<id>`。 */
  targets: Target[];
  blogs: BlogConfig[];
  /** 公众号的 `header`、`footer` 是开头样式一、结尾样式一的开关；知乎只有结尾，`header` 不生效。 */
  fixed: Record<Platform, { header: boolean; footer: boolean }>;
  wechat: {
    /** `enabled` 决定已启用的开头、结尾样式里是否带名片。 */
    card: WechatCard & { enabled: boolean };
    /** 开头样式一的顶部宣言与出品公众号。 */
    start: { slogan: string; producerName: string };
    proxy: string;
  };
}
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};
export function defaultConfig(): JinzhangConfig {
  return {
    version: 1,
    author: '',
    theme: 'sspai',
    targets: ['wechat', 'zhihu'],
    blogs: DEFAULT_BLOGS.map((blog) => ({ ...blog })),
    fixed: { wechat: { header: true, footer: true }, zhihu: { header: true, footer: true } },
    wechat: {
      card: {
        enabled: false,
        mpId: '',
        nickname: '',
        headImg: '',
        signature: '',
        serviceType: 1,
        verifyStatus: 1,
      },
      start: { slogan: '', producerName: '' },
      proxy: '',
    },
  };
}
export const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const pick = <T>(value: unknown, fallback: T): T =>
  typeof value === typeof fallback ? (value as T) : fallback;
/** 缺失或类型不对的字段取默认值，未知字段不影响读取。 */
export function normalizeConfig(raw: unknown): JinzhangConfig {
  const base = defaultConfig();
  const source = isRecord(raw) ? raw : {};
  const fixed = isRecord(source.fixed) ? source.fixed : {};
  const wechat = isRecord(source.wechat) ? source.wechat : {};
  const card = isRecord(wechat.card) ? wechat.card : {};
  const start = isRecord(wechat.start) ? wechat.start : {};
  const blogs = normalizeBlogs(source.blogs);
  const targets: Target[] = Array.isArray(source.targets)
    ? [
        ...PLATFORMS.filter((p) => source.targets.includes(p)),
        ...blogs.map((blog) => blogTarget(blog.id)).filter((t) => source.targets.includes(t)),
      ]
    : base.targets;
  return {
    version: 1,
    author: pick(source.author, base.author),
    theme: ['sspai', 'native', 'mac'].includes(source.theme) ? source.theme : base.theme,
    targets,
    blogs,
    fixed: Object.fromEntries(
      PLATFORMS.map((p) => {
        const item = isRecord(fixed[p]) ? fixed[p] : {};
        return [
          p,
          {
            header: pick(item.header, base.fixed[p].header),
            footer: pick(item.footer, base.fixed[p].footer),
          },
        ];
      }),
    ) as JinzhangConfig['fixed'],
    wechat: {
      card: Object.fromEntries(
        Object.entries(base.wechat.card).map(([key, value]) => [key, pick(card[key], value)]),
      ) as unknown as JinzhangConfig['wechat']['card'],
      start: {
        slogan: pick(start.slogan, base.wechat.start.slogan).trim(),
        producerName: pick(start.producerName, base.wechat.start.producerName).trim(),
      },
      proxy: pick(wechat.proxy, base.wechat.proxy).trim(),
    },
  };
}
/**
 * 开头样式一：顶部宣言、账号名片、作者、出品公众号、分隔线。是一份内置模板，
 * 走与用户模板相同的变量规则：没有取值的行整行不显示。名片一行由调用方按开关决定是否保留。
 */
const START_STYLE_1 = [
  '<section style="margin:0 0 12px;font-weight:400;color:inherit">',
  '<section style="margin:0 0 6px;text-align:center;font-size:13px;line-height:1.5;font-weight:400;letter-spacing:0.02em;color:inherit">{{slogan}}</section>',
  ':::card',
  '<section style="margin:0;font-size:12px;line-height:1.5;font-weight:400;color:inherit">作者｜{{author}}</section>',
  '<section style="margin:4px 0 0;font-size:12px;line-height:1.5;font-weight:400;color:inherit">出品｜公众号：<span style="font-size:inherit;line-height:inherit;font-weight:inherit;color:#0b83c7">{{producer}}</span></section>',
  '<section style="margin:12px 0 0;height:1px;line-height:1px;background-color:#e5e5e5">&#8203;</section>',
  '</section>',
];
const CARD_BLOCK = ':::card\n:::';
export interface FixedContent {
  fixed: { header: boolean; footer: boolean };
  templates: { header: string; footer: string };
  /** 模板变量：`date`、`author`，公众号另有开头样式用的 `slogan`、`producer`。 */
  variables: Record<string, string>;
  card: WechatCard | null;
}
/**
 * 本地形态的固定内容（做法取自 my-toolbox）：公众号是「开头样式一 → 正文 → 结尾样式一」，
 * 结尾样式一先放结尾 Markdown 再放名片；知乎只有结尾 Markdown。名片的位置由两种样式决定，
 * 都启用时各出现一张。开了开关但没有任何内容可显示时，视为未启用。
 */
export function localFixed(
  platform: Platform,
  config: JinzhangConfig,
  footers: Record<Platform, string>,
  today: string,
): FixedContent {
  const footer = (footers[platform] || '').trim();
  const variables: Record<string, string> = { date: today };
  if (config.author) variables.author = config.author;
  if (platform === 'zhihu')
    return {
      fixed: { header: false, footer: config.fixed.zhihu.footer && !!footer },
      templates: { header: '', footer },
      variables,
      card: null,
    };
  const { enabled, ...data } = config.wechat.card;
  const card = enabled && data.mpId && data.nickname ? data : null;
  const { slogan, producerName } = config.wechat.start;
  if (slogan) variables.slogan = slogan;
  if (producerName) variables.producer = producerName;
  return {
    fixed: {
      header: config.fixed.wechat.header && !!(slogan || config.author || producerName || card),
      footer: config.fixed.wechat.footer && !!(footer || card),
    },
    templates: {
      header: START_STYLE_1.map((line) => (line === ':::card' ? (card ? CARD_BLOCK : '') : line))
        .filter(Boolean)
        .join('\n\n'),
      footer: [footer, card ? CARD_BLOCK : ''].filter(Boolean).join('\n\n'),
    },
    variables,
    card,
  };
}
export type DraftStatus = 'confirmed' | 'unverified' | 'uncertain';
export interface WechatDraftEntry {
  account: string;
  mediaId?: string;
  status: DraftStatus;
  title?: string;
  updatedAt: string;
}
export interface ZhihuDraftEntry {
  account: string;
  draftId?: string;
  status: DraftStatus;
  title?: string;
  updatedAt: string;
}
/** 博客文章的映射：按 slug 更新，记下上次推送的内容摘要，用来发现网站上的改动。 */
export interface BlogPostEntry {
  /** 博客地址；地址变了视为另一个站点，映射不沿用。 */
  account: string;
  slug: string;
  /** 上次推送的标题与正文的 SHA-256：网站上这两项变了才要用户确认覆盖（分类、标签等改动不算）。 */
  hash?: string;
  status: DraftStatus;
  title?: string;
  updatedAt: string;
}
export interface ZhihuImageEntry {
  md5: string;
  src: string;
  originalSrc: string;
  watermark: string;
  watermarkSrc: string;
  width: number;
  height: number;
}
export interface JinzhangState {
  version: 1;
  /** 键是源文件规范化后的绝对路径。 */
  articles: Record<string, { cover?: string }>;
  drafts: Record<
    string,
    { wechat?: WechatDraftEntry; zhihu?: ZhihuDraftEntry; blogs?: Record<string, BlogPostEntry> }
  >;
  /** 键是规范化后图片内容的 SHA-256，平台下再按账号区分。 */
  images: Record<
    string,
    { wechat?: Record<string, string>; zhihu?: Record<string, ZhihuImageEntry> }
  >;
  covers: Record<string, { wechat?: Record<string, string> }>;
  wechatEgressIp?: string;
}
/** 只保证顶层容器形状，条目由使用方逐项校验；未知字段原样保留，避免新版写入的内容被旧版抹掉。 */
export function normalizeState(raw: unknown): JinzhangState {
  const state = (isRecord(raw) ? raw : {}) as JinzhangState;
  state.version = 1;
  for (const key of ['articles', 'drafts', 'images', 'covers'] as const)
    if (!isRecord(state[key])) state[key] = {};
  if (state.wechatEgressIp !== undefined && typeof state.wechatEgressIp !== 'string')
    delete state.wechatEgressIp;
  return state;
}
/** 长期图床（阿里云 OSS），字段与 my-toolbox 的 oss.config 相同；对象可公开读，经 `publicBaseUrl` 访问。 */
export interface OssCredentials {
  /** 如 `oss-cn-shanghai`。 */
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** 公开访问地址（CDN 或 Bucket 域名），不带结尾斜杠。 */
  publicBaseUrl: string;
  /** 对象名前缀，不带首尾斜杠。 */
  keyPrefix: string;
  /** 上传用的接入地址，如 `https://oss-cn-shanghai.aliyuncs.com`；缺省按地域拼。 */
  endpoint?: string;
  /** `endpoint` 是绑定到 Bucket 的自定义域名。 */
  cname?: boolean;
}
export interface Credentials {
  wechat?: { appId: string; appSecret: string };
  oss?: OssCredentials;
  /** 键是博客 id。 */
  blogs?: Record<string, { apiKey: string }>;
}
export interface WechatToken {
  appId: string;
  accessToken: string;
  /** 毫秒时间戳，已提前 5 分钟。 */
  expiresAt: number;
}
export interface ZhihuUser {
  id: string;
  name: string;
  avatarUrl?: string;
}
export interface ZhihuSession {
  cookies: Record<string, string>;
  user?: ZhihuUser;
  updatedAt: string;
}
export interface SecretFiles {
  credentials: Credentials;
  'wechat-token': WechatToken;
  'zhihu-session': ZhihuSession;
}
export type SecretName = keyof SecretFiles;
export interface StateStore {
  read(): Promise<JinzhangState>;
  /** 持锁后重读磁盘内容，再应用本次修改写回；修改函数必须是同步的。 */
  update(mutate: (state: JinzhangState) => void): Promise<JinzhangState>;
}
export interface SecretStore {
  get<K extends SecretName>(name: K): Promise<SecretFiles[K] | null>;
  set<K extends SecretName>(name: K, value: SecretFiles[K]): Promise<void>;
  remove(name: SecretName): Promise<void>;
}
