import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Nodes, Root } from 'mdast';
import type { AssetResolver, ResolvedAsset, Warning } from '../types';
import { stripFrontmatter } from '../frontmatter';
import { PublishError, type JinzhangError } from './errors';
import { TransportError } from './host';
import type { PreparedImage } from './images';
import {
  draftRef,
  images,
  maskAppId,
  otherAccountWarning,
  progress,
  uncertainBlocker,
} from './common';
import {
  checkWechatAccount,
  missingConfig,
  readCredentials,
  WECHAT_ENTRY_URL,
  WechatApi,
  WechatApiError,
  wechatDraftEntry,
  wechatError,
  type WechatNewspic,
} from './wechat';
import type { PlatformSummary, PreflightReport, PublishContext, PushResult } from './types';

/**
 * 公众号贴图（接口里叫图片消息，`article_type: newspic`）：一组图片加一段纯文字。
 * 图片传成永久素材，第一张就是封面；没有正文 HTML、开头结尾与名片。
 */

export const NEWSPIC_MAX_IMAGES = 20;
/** 接口文档没写贴图文字的上限；后台的贴图文字限 1000 字，超过时提示。 */
export const NEWSPIC_TEXT_HINT = 1000;

export interface NewspicImage {
  original: string;
  source: ResolvedAsset;
}
export interface NewspicArticle {
  title: string;
  /** 纯文字：段落之间空一行，列表保留「•」或序号，图片与格式去掉。 */
  text: string;
  /** 按出现顺序去重；单独设置的封面排第一（贴图的第一张就是封面）。 */
  images: NewspicImage[];
  warnings: Warning[];
  stats: { visibleTextChars: number; imageCount: number };
}

const stripTags = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

/** 同一张图的判断：本地图按解析出的文件，网络图按地址，解析不了的按原始引用。 */
function identity(image: NewspicImage) {
  const source = image.source;
  if (source.kind === 'remote' || source.kind === 'hosted') return `url:${source.url}`;
  if ('bytes' in source && source.assetId) return `asset:${source.assetId}`;
  return `ref:${image.original}`;
}

/** Markdown 转成贴图的纯文字；记下丢掉了哪些东西，体检时提示。 */
function toText(tree: Root, skip: Nodes | undefined) {
  let links = false;
  let formats = false;
  const inline = (node: Nodes): string => {
    switch (node.type) {
      case 'text':
        return node.value;
      case 'inlineCode':
        return node.value;
      case 'break':
        return '\n';
      case 'image':
      case 'imageReference':
      case 'footnoteReference':
        return '';
      case 'html':
        return stripTags(node.value);
      case 'link':
      case 'linkReference':
        links = true;
        break;
      case 'strong':
      case 'emphasis':
      case 'delete':
        formats = true;
        break;
    }
    return 'children' in node ? node.children.map((child) => inline(child as Nodes)).join('') : '';
  };
  const blocks = (nodes: Nodes[]): string[] => {
    const out: string[] = [];
    for (const node of nodes) {
      if (node === skip) continue;
      switch (node.type) {
        case 'heading':
          formats = true;
          out.push(inline(node).trim());
          break;
        case 'paragraph':
          out.push(inline(node).trim());
          break;
        case 'list':
          out.push(
            node.children
              .map((item, index) => {
                const marker = node.ordered ? `${(node.start ?? 1) + index}. ` : '• ';
                return marker + blocks(item.children as Nodes[]).join('\n');
              })
              .join('\n'),
          );
          break;
        case 'blockquote':
          out.push(...blocks(node.children as Nodes[]));
          break;
        case 'code':
          formats = true;
          out.push(node.value);
          break;
        case 'table':
          formats = true;
          out.push(
            node.children
              .map((row) => row.children.map((cell) => inline(cell).trim()).join('　'))
              .join('\n'),
          );
          break;
        case 'html':
          out.push(stripTags(node.value).trim());
          break;
        case 'thematicBreak':
        case 'definition':
        case 'footnoteDefinition':
        case 'yaml':
          break;
        default:
          if ('children' in node) out.push(...blocks(node.children as Nodes[]));
      }
    }
    return out.filter((block) => block.trim());
  };
  const text = blocks(tree.children as Nodes[]).join('\n\n');
  return { text, links, formats };
}

/**
 * 解析 Markdown 得到贴图：图片（行内、引用式、HTML `<img>`）按出现顺序去重，文字转成纯文本。
 * 第一个一级标题与标题相同时去掉（标题单独提交）。
 */
export async function prepareNewspic(
  input: { markdown: string; title: string; cover?: string },
  resolver: AssetResolver,
): Promise<NewspicArticle> {
  const { source } = stripFrontmatter(input.markdown);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Root;
  const title = input.title.trim();
  const warnings: Warning[] = [];
  if (Array.from(title).length > 32)
    warnings.push({ code: 'TITLE_TOO_LONG', message: '标题超过 32 字，公众号可能不收。' });

  const refs: string[] = [];
  const add = (ref: string | undefined) => {
    const value = ref?.trim();
    if (value && !refs.includes(value)) refs.push(value);
  };
  const definitions = new Map<string, string>();
  visit(tree, 'definition', (node) => {
    definitions.set(node.identifier, node.url);
  });
  visit(tree, (node) => {
    if (node.type === 'image') add(node.url);
    else if (node.type === 'imageReference') add(definitions.get(node.identifier));
    else if (node.type === 'html')
      for (const match of node.value.matchAll(
        /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      ))
        add(match[1] ?? match[2] ?? match[3]);
  });

  const resolved: NewspicImage[] = [];
  for (const original of refs)
    resolved.push({ original, source: await resolver.resolve(original) });
  let list = resolved;
  if (input.cover) {
    const cover = { original: input.cover, source: await resolver.resolve(input.cover) };
    list = [cover, ...resolved];
  }
  const seen = new Set<string>();
  const unique = list.filter((image) => {
    const key = identity(image);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const image of unique)
    if (image.source.kind === 'missing')
      warnings.push({ code: 'IMAGE_MISSING', message: image.source.reason, ref: image.original });

  const heading = tree.children.find((node) => node.type === 'heading' && node.depth === 1);
  const skip =
    heading && title && toText({ type: 'root', children: [heading] }, undefined).text === title
      ? heading
      : undefined;
  const { text, links, formats } = toText(tree, skip);
  if (links)
    warnings.push({
      code: 'NEWSPIC_LINKS_DROPPED',
      message: '贴图的文字放不了链接，只保留了链接上的字。',
    });
  if (formats)
    warnings.push({
      code: 'NEWSPIC_FORMAT_DROPPED',
      message: '贴图只有纯文字，小标题、加粗、代码和表格都按普通文字发出。',
    });
  return {
    title,
    text,
    images: unique,
    warnings,
    stats: {
      visibleTextChars: Array.from(text.replace(/\s/g, '')).length,
      imageCount: unique.length,
    },
  };
}

const noImage: JinzhangError = {
  code: 'NEWSPIC_NO_IMAGE',
  stage: 'preflight',
  platform: 'wechat',
  message: '贴图至少要有一张图，这篇里没有图片',
  action: '在正文里放几张图（第一张就是封面），或设置封面',
};
const tooManyImages = (count: number): JinzhangError => ({
  code: 'NEWSPIC_TOO_MANY_IMAGES',
  stage: 'preflight',
  platform: 'wechat',
  message: `贴图最多 ${NEWSPIC_MAX_IMAGES} 张图，这篇有 ${count} 张`,
  action: `删到 ${NEWSPIC_MAX_IMAGES} 张以内`,
});
const noText: JinzhangError = {
  code: 'NEWSPIC_TEXT_EMPTY',
  stage: 'preflight',
  platform: 'wechat',
  message: '贴图要有一段文字，这篇只有图片',
  action: '在图片前后写几句话',
};

/** 内容本身的阻塞项：体检与推送都先过这一关。 */
function contentBlockers(article: NewspicArticle) {
  const blockers: JinzhangError[] = [];
  if (!article.images.length) blockers.push(noImage);
  else if (article.images.length > NEWSPIC_MAX_IMAGES)
    blockers.push(tooManyImages(article.images.length));
  if (!article.text.trim()) blockers.push(noText);
  return blockers;
}
function contentWarnings(article: NewspicArticle): Warning[] {
  const length = Array.from(article.text).length;
  return length > NEWSPIC_TEXT_HINT
    ? [
        {
          code: 'NEWSPIC_TEXT_LONG',
          message: `贴图文字有 ${length} 字，超过后台的 ${NEWSPIC_TEXT_HINT} 字，公众号可能不收或截断。`,
        },
      ]
    : [];
}

function summaryOf(
  article: NewspicArticle,
  ctx: PublishContext,
  entry: Parameters<typeof draftRef>[0],
): PlatformSummary {
  const ref = ctx.newDraft ? undefined : draftRef(entry);
  return {
    platform: 'wechat',
    title: article.title,
    visibleTextChars: article.stats.visibleTextChars,
    htmlChars: article.text.length,
    images: article.images.length,
    cover: article.images[0]?.original ?? null,
    header: false,
    footer: false,
    draft: ref ? 'update' : 'create',
    draftRef: ref,
    uncertain: entry?.status === 'uncertain',
  };
}

function verify(saved: Record<string, unknown> | undefined, draft: WechatNewspic) {
  const warnings: Warning[] = [];
  if (!saved)
    return {
      verified: false,
      warnings: [
        { code: 'DRAFT_UNVERIFIED', message: '草稿已写入，但回读缺少内容，请到草稿箱核对。' },
      ],
    };
  if (saved.title !== draft.title)
    warnings.push({
      code: 'DRAFT_UNVERIFIED',
      message: '草稿回读的标题与提交的不一致，请到草稿箱核对。',
    });
  if (typeof saved.article_type === 'string' && saved.article_type !== 'newspic')
    warnings.push({
      code: 'DRAFT_UNVERIFIED',
      message: '草稿回读的类型不是贴图，请到草稿箱核对。',
    });
  const list = (saved.image_info as { image_list?: unknown } | undefined)?.image_list;
  if (Array.isArray(list) && list.length !== draft.image_info.image_list.length)
    warnings.push({
      code: 'DRAFT_UNVERIFIED',
      message: `草稿回读有 ${list.length} 张图，提交的是 ${draft.image_info.image_list.length} 张，请到草稿箱核对。`,
    });
  return { verified: warnings.length === 0, warnings };
}

export const newspicPublisher = {
  platform: 'wechat' as const,
  /** 只读检查：读取并规范化图片，不上传、不建草稿（会取一次 access token）。 */
  async preflight(article: NewspicArticle, ctx: PublishContext): Promise<PreflightReport> {
    const blockers: JinzhangError[] = [];
    const warnings: Warning[] = [...article.warnings];
    const credentials = await readCredentials(ctx.host);
    const state = await ctx.host.store.read();
    const {
      entry,
      otherAccount,
      warning: typeChanged,
    } = wechatDraftEntry(state, ctx, credentials?.appId, 'newspic');
    if (otherAccount) warnings.push(otherAccountWarning('wechat'));
    if (typeChanged) warnings.push(typeChanged);
    const summary = summaryOf(article, ctx, entry);
    summary.account =
      ctx.config.wechat.card.nickname || (credentials && maskAppId(credentials.appId));
    const account = await checkWechatAccount(ctx, state, credentials, summary);
    blockers.push(...account.blockers);
    warnings.push(...account.warnings);
    if (entry?.status === 'uncertain' && !ctx.confirmUncertain)
      blockers.push(uncertainBlocker('wechat'));
    blockers.push(...contentBlockers(article));
    for (const image of article.images) {
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
        blockers.push({ ...error.detail, platform: 'wechat', stage: 'preflight' });
      }
    }
    warnings.push(...contentWarnings(article));
    return { platform: 'wechat', ok: !blockers.length, blockers, warnings, summary };
  },

  /** 推到草稿箱：图片逐张传成永久素材（按内容哈希跨次复用），建或更新贴图草稿，再回读核对。 */
  async push(article: NewspicArticle, ctx: PublishContext): Promise<PushResult> {
    const credentials = await readCredentials(ctx.host);
    if (!credentials) return { outcome: 'failed', error: { ...missingConfig, stage: 'push' } };
    const blocked = contentBlockers(article)[0];
    if (blocked) return { outcome: 'failed', error: { ...blocked, stage: 'push' } };
    const api = new WechatApi(ctx.host, credentials);
    const account = credentials.appId;
    const state = await ctx.host.store.read();
    const { entry, warning: typeChanged } = wechatDraftEntry(state, ctx, account, 'newspic');
    if (entry?.status === 'uncertain' && !ctx.confirmUncertain)
      return { outcome: 'failed', error: { ...uncertainBlocker('wechat'), stage: 'push' } };
    const warnings: Warning[] = typeChanged ? [typeChanged] : [];
    const save = (patch: { mediaId?: string; status: 'confirmed' | 'unverified' | 'uncertain' }) =>
      ctx.host.store.update((s) => {
        (s.drafts[ctx.source] ??= {}).wechat = {
          account,
          articleType: 'newspic',
          title: article.title,
          ...patch,
          updatedAt: ctx.host.now().toISOString(),
        };
      });
    try {
      // 内容相同的图只传一次、只占一个位置。
      const prepared: PreparedImage[] = [];
      for (const image of article.images) {
        const item = await images(ctx).prepare(image);
        if (item.animated)
          warnings.push({
            code: 'GIF_FIRST_FRAME',
            ref: image.original,
            message: '动图已转为静态首帧。',
          });
        if (!prepared.some((p) => p.hash === item.hash)) prepared.push(item);
      }
      let uploaded = 0;
      let cachedUsed = false;
      // 永久图片素材与公众号封面是同一种素材，共用封面的缓存。
      const materialIds = async (force = false) => {
        const cache = (await ctx.host.store.read()).covers;
        const ids: string[] = [];
        for (const [index, image] of prepared.entries()) {
          const cached = cache[image.hash]?.wechat?.[account];
          if (!force && typeof cached === 'string' && cached) {
            cachedUsed = true;
            ids.push(cached);
            continue;
          }
          progress(ctx, `上传图片 ${index + 1}/${prepared.length}`);
          const mediaId = await api.addMaterial(image);
          uploaded++;
          await ctx.host.store.update((s) => {
            const item = (s.covers[image.hash] ??= {});
            (item.wechat ??= {})[account] = mediaId;
          });
          ids.push(mediaId);
        }
        return ids;
      };
      const draftOf = (ids: string[]): WechatNewspic => ({
        article_type: 'newspic',
        title: article.title,
        content: article.text,
        image_info: { image_list: ids.map((id) => ({ image_media_id: id })) },
      });
      let draft = draftOf(await materialIds());
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
          // 40007 可能是草稿不在了，也可能是缓存的图片素材被删了：先回读确认。
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
            draft = draftOf(await materialIds(true));
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
          if (!(error instanceof WechatApiError && error.errcode === 40007) || !cachedUsed)
            throw error;
          draft = draftOf(await materialIds(true));
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
        warnings: [...warnings, ...checked.warnings],
        verification: checked.verified ? 'confirmed' : 'unverified',
        uploadedImages: uploaded,
      };
    } catch (error) {
      const detail = wechatError(error, { chars: article.text.length });
      if (detail.code === 'WECHAT_CONTENT_TOO_LONG') detail.action = '把文字删短一些再推';
      return { outcome: 'failed', error: detail };
    }
  },
};
