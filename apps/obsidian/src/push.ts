import type { ImageRef, Platform, Warning } from '@jinzhang/core';
import {
  blogPublisher,
  blogTarget,
  ImageCache,
  isBlogTarget,
  LongTermImageStore,
  publishers,
  readOssConfig,
  toJinzhangError,
  type BlogArticle,
  type BlogConfig,
  type BlogContext,
  type BlogPreflight,
  type JinzhangConfig,
  type JinzhangError,
  type PreflightReport,
  type PublishContext,
  type PublishHost,
  type Publisher,
  type PushResult,
  type SlugCheck,
  type Target,
} from '@jinzhang/core/publish';
import type { BuiltArticle, Snapshot } from './article';
import { draftText, summaryText } from './modals/render';
export const PLATFORM_NAMES: Record<Platform, string> = { wechat: '公众号', zhihu: '知乎' };
export const blogOf = (config: JinzhangConfig, target: Target) =>
  config.blogs.find((blog) => blogTarget(blog.id) === target);
export const targetName = (config: JinzhangConfig, target: Target) =>
  isBlogTarget(target) ? (blogOf(config, target)?.name ?? target.slice(5)) : PLATFORM_NAMES[target];
/** 确认时用户的选择：博客首次推送填的 slug，以及是否覆盖网站上已有的那篇。 */
export interface Choice {
  slug?: string;
  overwrite?: boolean;
}
/** 博客的文章地址：首次推送由用户填写并检查网站上是否已有同名文章；之后沿用映射里的。 */
export interface SlugField {
  editable: boolean;
  value: string;
  /** 网站地址前缀，例如 `https://gpt101.org/tutorials/`，只用于展示。 */
  prefix: string;
  check(slug: string): Promise<SlugCheck>;
}
export interface PlatformPlan {
  target: Target;
  name: string;
  /** ready 可执行；confirm 要勾选 `confirm` 说明的那一项；blocked 有其他阻塞，跳过。 */
  status: 'ready' | 'confirm' | 'blocked';
  title: string;
  account?: string;
  cover: Pick<ImageRef, 'original' | 'source'> | null;
  /** 创建还是更新、发布到哪里。 */
  action: string;
  details: string;
  blockers: JinzhangError[];
  warnings: Warning[];
  confirm?: { name: string; desc: string };
  slug?: SlugField;
  run(choice: Choice, progress: (message: string) => void): Promise<PushResult>;
}
export interface PushOutcome {
  target: Target;
  name: string;
  status: 'completed' | 'failed' | 'uncertain' | 'skipped';
  result?: PushResult;
  blockers?: JinzhangError[];
}
export interface FlowDeps {
  snapshot: Snapshot;
  host: PublishHost;
  config: JinzhangConfig;
  build(platform: Platform): Promise<BuiltArticle>;
  buildBlog(): Promise<BlogArticle>;
  publisher?(platform: Platform): Publisher;
  blog?: typeof blogPublisher;
  progress?(message: string): void;
}
export interface PushUi {
  /** 返回本次执行的目标与各自的选择；取消返回 null。 */
  confirm(plans: PlatformPlan[]): Promise<Map<Target, Choice> | null>;
  progress(message: string): void;
  finish(outcomes: PushOutcome[]): void;
}
const publisherOf = (deps: FlowDeps, platform: Platform) =>
  deps.publisher?.(platform) ?? publishers[platform];
const statusOf = (blockers: JinzhangError[], confirmable: string) =>
  !blockers.length
    ? 'ready'
    : blockers.every((b) => b.code === confirmable)
      ? 'confirm'
      : 'blocked';
async function platformPlan(
  deps: FlowDeps,
  platform: Platform,
  images: ImageCache,
): Promise<PlatformPlan> {
  const article = await deps.build(platform);
  const context: PublishContext = {
    host: deps.host,
    source: deps.snapshot.source,
    config: deps.config,
    fixed: article.fixed,
    templates: article.templates,
    variables: article.variables,
    images,
  };
  let report: PreflightReport;
  try {
    report = await publisherOf(deps, platform).preflight(article.result, context);
  } catch (error) {
    report = {
      platform,
      ok: false,
      blockers: [
        toJinzhangError(error, { code: 'PREFLIGHT_FAILED', stage: 'preflight', platform }),
      ],
      warnings: [],
      summary: {
        platform,
        title: article.result.title,
        visibleTextChars: article.result.stats.visibleTextChars,
        htmlChars: article.result.stats.htmlChars,
        images: article.result.images.length,
        cover: article.result.cover?.original ?? null,
        header: article.fixed.header,
        footer: article.fixed.footer,
        draft: 'create',
        uncertain: false,
      },
    };
  }
  report.warnings.unshift(...article.notes);
  const status = statusOf(report.blockers, 'OUTCOME_UNCERTAIN');
  return {
    target: platform,
    name: PLATFORM_NAMES[platform],
    status,
    title: report.summary.title,
    account: report.summary.account,
    cover: article.result.cover,
    action: draftText(report.summary),
    details: summaryText(report.summary),
    blockers: report.blockers,
    warnings: report.warnings,
    confirm:
      status === 'confirm'
        ? {
            name: '草稿箱里没有对应草稿',
            desc: '已去平台草稿箱核对；如果草稿其实已经建好，先在平台删掉那份再勾选。',
          }
        : undefined,
    run: (_choice, progress) =>
      publisherOf(deps, platform).push(article.result, {
        ...context,
        confirmUncertain: status === 'confirm',
        onProgress: progress,
      }),
  };
}
function blogAction(report: BlogPreflight) {
  const at = (slug: string) => `${report.blog.url}/tutorials/${slug}`;
  if (report.mode === 'update' && report.remote)
    return `更新已发布的文章（${report.blog.url}${report.remote.url}）`;
  if (report.mode === 'recreate' && report.slug) return `重新发布（${at(report.slug)}）`;
  return '发布新文章（推送即发布）';
}
async function blogPlan(
  deps: FlowDeps,
  blog: BlogConfig,
  article: BlogArticle,
  store: LongTermImageStore | undefined,
): Promise<PlatformPlan> {
  const publisher = deps.blog ?? blogPublisher;
  const context: BlogContext = { host: deps.host, source: deps.snapshot.source, blog, store };
  const target = blogTarget(blog.id);
  let report: BlogPreflight;
  try {
    report = await publisher.preflight(article, context);
  } catch (error) {
    report = {
      target,
      blog,
      ok: false,
      blockers: [
        toJinzhangError(error, { code: 'PREFLIGHT_FAILED', stage: 'preflight', platform: target }),
      ],
      warnings: [],
      mode: 'create',
      suggestion: '',
      remote: null,
      summary: {
        title: article.title,
        localImages: 0,
        remoteImages: 0,
        cover: article.cover?.original ?? null,
        chars: 0,
      },
    };
  }
  const status = statusOf(report.blockers, 'BLOG_REMOTE_CHANGED');
  const { summary } = report;
  const host = (() => {
    try {
      return new URL(blog.url).host;
    } catch {
      return undefined;
    }
  })();
  return {
    target,
    name: blog.name,
    status,
    title: summary.title,
    account: host,
    cover: article.cover,
    action: blogAction(report),
    details: [
      `本地图片 ${summary.localImages} 张（传到长期图床）`,
      `网络图片 ${summary.remoteImages} 张`,
      `正文 ${summary.chars} 字符`,
      summary.cover ? '带封面' : '没有封面',
    ].join('；'),
    blockers: report.blockers,
    warnings: report.warnings,
    confirm:
      status === 'confirm'
        ? {
            name: '覆盖网站上的版本',
            desc: '网站上的标题或正文与上次推送时不同，勾选后用笔记内容覆盖；分类、标签与摘要不受影响。',
          }
        : undefined,
    slug: {
      editable: report.mode === 'create',
      value: report.slug ?? report.suggestion,
      prefix: `${blog.url}/tutorials/`,
      check: (slug) => publisher.check(slug, context),
    },
    run: (choice, progress) =>
      publisher.push(
        article,
        { ...context, onProgress: progress },
        {
          slug: choice.slug ?? report.slug ?? '',
          overwrite: status === 'confirm' || !!choice.overwrite,
        },
      ),
  };
}
/** 逐目标体检（architecture.md 第 11 节）：同一次操作共用图片缓存与长期图床，推送时不再重复处理。 */
export async function planPush(deps: FlowDeps, targets: Target[]): Promise<PlatformPlan[]> {
  const images = new ImageCache(deps.host);
  let blogArticle: Promise<BlogArticle> | undefined;
  let store: Promise<LongTermImageStore | undefined> | undefined;
  const plans: PlatformPlan[] = [];
  for (const target of targets) {
    if (isBlogTarget(target)) {
      const blog = blogOf(deps.config, target);
      if (!blog) continue;
      deps.progress?.(`${blog.name}：体检中…`);
      store ??= readOssConfig(deps.host).then((config) =>
        config ? new LongTermImageStore(deps.host, config) : undefined,
      );
      plans.push(await blogPlan(deps, blog, await (blogArticle ??= deps.buildBlog()), await store));
      continue;
    }
    deps.progress?.(`${PLATFORM_NAMES[target]}：体检中…`);
    plans.push(await platformPlan(deps, target, images));
  }
  return plans;
}
/** 逐个目标执行：一个失败不影响也不重发已成功的；被阻塞或未选中的标为未执行。 */
export async function executePush(
  plans: PlatformPlan[],
  choices: Map<Target, Choice>,
  progress: (message: string) => void,
): Promise<PushOutcome[]> {
  const outcomes: PushOutcome[] = [];
  for (const plan of plans) {
    const { target, name } = plan;
    const choice = choices.get(target);
    if (plan.status === 'blocked' || !choice) {
      outcomes.push({ target, name, status: 'skipped', blockers: plan.blockers });
      continue;
    }
    let result: PushResult;
    try {
      result = await plan.run(choice, (message) => progress(`${name}：${message}`));
    } catch (error) {
      result = {
        outcome: 'failed',
        error: toJinzhangError(error, { code: 'PUSH_FAILED', stage: 'push', platform: target }),
      };
    }
    outcomes.push({
      target,
      name,
      status:
        result.outcome === 'created' || result.outcome === 'updated' ? 'completed' : result.outcome,
      result,
    });
  }
  return outcomes;
}
export async function runPush(deps: FlowDeps, targets: Target[], ui: PushUi) {
  const plans = await planPush({ ...deps, progress: ui.progress }, targets);
  const choices = await ui.confirm(plans);
  if (!choices) return null;
  const outcomes = await executePush(plans, choices, ui.progress);
  ui.finish(outcomes);
  return outcomes;
}
