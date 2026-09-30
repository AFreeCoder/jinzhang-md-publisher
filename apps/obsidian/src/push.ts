import type { Platform } from '@jinzhang/core';
import {
  ImageCache,
  publishers,
  toJinzhangError,
  type JinzhangConfig,
  type JinzhangError,
  type PreflightReport,
  type PublishContext,
  type PublishHost,
  type Publisher,
  type PushResult,
} from '@jinzhang/core/publish';
import type { BuiltArticle, Snapshot } from './article';
export const PLATFORM_NAMES: Record<Platform, string> = { wechat: '公众号', zhihu: '知乎' };
export interface PlatformPlan {
  platform: Platform;
  article: BuiltArticle;
  report: PreflightReport;
  /** ready 可执行；confirm 只差确认「草稿箱里没有对应草稿」；blocked 有其他阻塞，跳过。 */
  status: 'ready' | 'confirm' | 'blocked';
  context: PublishContext;
}
export interface PushOutcome {
  platform: Platform;
  status: 'completed' | 'failed' | 'uncertain' | 'skipped';
  result?: PushResult;
  blockers?: JinzhangError[];
}
export interface FlowDeps {
  snapshot: Snapshot;
  host: PublishHost;
  config: JinzhangConfig;
  build(platform: Platform): Promise<BuiltArticle>;
  publisher?(platform: Platform): Publisher;
  progress?(message: string): void;
}
export interface PushUi {
  /** 返回本次执行的平台（含已勾选确认的结果不确定平台）；取消返回 null。 */
  confirm(plans: PlatformPlan[]): Promise<Set<Platform> | null>;
  progress(message: string): void;
  finish(outcomes: PushOutcome[]): void;
}
const publisherOf = (deps: FlowDeps, platform: Platform) =>
  deps.publisher?.(platform) ?? publishers[platform];
/** 逐平台体检（architecture.md 第 11 节）：同一次操作共用一份图片缓存，推送时不再重复规范化。 */
export async function planPush(deps: FlowDeps, platforms: Platform[]): Promise<PlatformPlan[]> {
  const images = new ImageCache(deps.host);
  const plans: PlatformPlan[] = [];
  for (const platform of platforms) {
    deps.progress?.(`${PLATFORM_NAMES[platform]}：体检中…`);
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
    const status = !report.blockers.length
      ? 'ready'
      : report.blockers.every((b) => b.code === 'OUTCOME_UNCERTAIN')
        ? 'confirm'
        : 'blocked';
    plans.push({ platform, article, report, status, context });
  }
  return plans;
}
/** 逐个平台执行：一个平台失败不影响也不重发已成功的平台；被阻塞或未勾选的标为未执行。 */
export async function executePush(
  deps: FlowDeps,
  plans: PlatformPlan[],
  selected: Set<Platform>,
  progress: (message: string) => void,
): Promise<PushOutcome[]> {
  const outcomes: PushOutcome[] = [];
  for (const plan of plans) {
    const { platform } = plan;
    if (plan.status === 'blocked' || !selected.has(platform)) {
      outcomes.push({ platform, status: 'skipped', blockers: plan.report.blockers });
      continue;
    }
    let result: PushResult;
    try {
      result = await publisherOf(deps, platform).push(plan.article.result, {
        ...plan.context,
        confirmUncertain: plan.status === 'confirm',
        onProgress: (message) => progress(`${PLATFORM_NAMES[platform]}：${message}`),
      });
    } catch (error) {
      result = {
        outcome: 'failed',
        error: toJinzhangError(error, { code: 'PUSH_FAILED', stage: 'push', platform }),
      };
    }
    outcomes.push({
      platform,
      status:
        result.outcome === 'created' || result.outcome === 'updated' ? 'completed' : result.outcome,
      result,
    });
  }
  return outcomes;
}
export async function runPush(deps: FlowDeps, platforms: Platform[], ui: PushUi) {
  const plans = await planPush({ ...deps, progress: ui.progress }, platforms);
  const selected = await ui.confirm(plans);
  if (!selected) return null;
  const outcomes = await executePush(deps, plans, selected, ui.progress);
  ui.finish(outcomes);
  return outcomes;
}
