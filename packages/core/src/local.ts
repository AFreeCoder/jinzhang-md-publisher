import type { Platform, ThemeId } from './types';
/** 本地形态（命令行与插件）共用的配置、状态与凭证结构，读写实现见 `./node`。 */
export const PLATFORMS: Platform[] = ['wechat', 'zhihu'];
export interface WechatCard {
  mpId: string;
  nickname: string;
  headImg: string;
  signature: string;
  serviceType: number;
  verifyStatus: number;
}
export interface JinzhangConfig {
  version: 1;
  author: string;
  theme: ThemeId;
  targets: Platform[];
  fixed: Record<Platform, { header: boolean; footer: boolean }>;
  wechat: { card: WechatCard; proxy: string };
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
    fixed: { wechat: { header: true, footer: true }, zhihu: { header: true, footer: true } },
    wechat: {
      card: { mpId: '', nickname: '', headImg: '', signature: '', serviceType: 1, verifyStatus: 1 },
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
  const targets = Array.isArray(source.targets)
    ? PLATFORMS.filter((p) => source.targets.includes(p))
    : base.targets;
  return {
    version: 1,
    author: pick(source.author, base.author),
    theme: ['sspai', 'native', 'mac'].includes(source.theme) ? source.theme : base.theme,
    targets,
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
      ) as unknown as WechatCard,
      proxy: pick(wechat.proxy, base.wechat.proxy).trim(),
    },
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
  drafts: Record<string, { wechat?: WechatDraftEntry; zhihu?: ZhihuDraftEntry }>;
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
export interface Credentials {
  wechat?: { appId: string; appSecret: string };
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
