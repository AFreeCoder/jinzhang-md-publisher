import { describe, expect, it, vi } from 'vitest';
import type { Platform } from '@jinzhang/core';
import {
  defaultConfig,
  type JinzhangError,
  type PreflightReport,
  type Publisher,
  type PublishContext,
  type PublishHost,
  type PushResult,
} from '@jinzhang/core/publish';
import { runPush, type PlatformPlan, type PushUi } from '../src/push';
import type { BuiltArticle, Snapshot } from '../src/article';
const snapshot: Snapshot = {
  path: 'posts/a.md',
  source: '/vault/posts/a.md',
  title: '标题',
  content: '正文',
  contentStart: 0,
};
const built = (platform: Platform): BuiltArticle =>
  ({
    platform,
    result: { platform, title: '标题', images: [], cover: null, stats: {} },
    notes: [{ code: 'OBSIDIAN_EMBED', message: '嵌入的笔记不会展开' }],
    fixed: { header: true, footer: false },
    templates: { header: '', footer: '' },
    variables: { date: '2026-09-30' },
  }) as unknown as BuiltArticle;
const blocker = (code: string): JinzhangError => ({ code, stage: 'preflight', message: code });
function fakePublisher(
  platform: Platform,
  blockers: JinzhangError[],
  push: () => Promise<PushResult>,
) {
  const contexts: PublishContext[] = [];
  const publisher: Publisher = {
    platform,
    preflight: vi.fn(async (_article, ctx) => {
      contexts.push(ctx);
      return {
        platform,
        ok: !blockers.length,
        blockers,
        warnings: [],
        summary: { platform, draft: 'create', uncertain: false } as PreflightReport['summary'],
      };
    }),
    push: vi.fn(async (_article, ctx) => {
      contexts.push(ctx);
      return push();
    }),
  };
  return { publisher, contexts };
}
const created = (draftRef: string): PushResult => ({
  outcome: 'created',
  draftRef,
  entryUrl: 'https://example.test',
  warnings: [],
  verification: 'confirmed',
  uploadedImages: 0,
});
function flow(
  publishers: Record<Platform, Publisher>,
  choose: (plans: PlatformPlan[]) => Set<Platform> | null,
) {
  const finished: unknown[] = [];
  const confirm = vi.fn(async (plans: PlatformPlan[]) => choose(plans));
  const ui: PushUi = { confirm, progress: vi.fn(), finish: (outcomes) => finished.push(outcomes) };
  const deps = {
    snapshot,
    host: {} as PublishHost,
    config: defaultConfig(),
    build: async (platform: Platform) => built(platform),
    publisher: (platform: Platform) => publishers[platform],
  };
  return { deps, ui, confirm, finished };
}
describe('推送流程', () => {
  it('一个平台被阻塞时另一个照常推送，结果里标出未执行的平台与原因', async () => {
    const wechat = fakePublisher('wechat', [blocker('COVER_MISSING')], async () => created('W'));
    const zhihu = fakePublisher('zhihu', [], async () => created('Z'));
    const { deps, ui, confirm } = flow(
      { wechat: wechat.publisher, zhihu: zhihu.publisher },
      (plans) => {
        expect(plans.map((p) => [p.platform, p.status])).toEqual([
          ['wechat', 'blocked'],
          ['zhihu', 'ready'],
        ]);
        return new Set(['zhihu']);
      },
    );
    const outcomes = await runPush(deps, ['wechat', 'zhihu'], ui);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(wechat.publisher.push).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      { platform: 'wechat', status: 'skipped', blockers: [blocker('COVER_MISSING')] },
      { platform: 'zhihu', status: 'completed', result: created('Z') },
    ]);
  });
  it('确认前不出站；取消则什么都不推', async () => {
    const wechat = fakePublisher('wechat', [], async () => created('W'));
    const zhihu = fakePublisher('zhihu', [], async () => created('Z'));
    const { deps, ui, finished } = flow(
      { wechat: wechat.publisher, zhihu: zhihu.publisher },
      () => null,
    );
    expect(await runPush(deps, ['wechat', 'zhihu'], ui)).toBeNull();
    expect(wechat.publisher.push).not.toHaveBeenCalled();
    expect(zhihu.publisher.push).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
  });
  it('结果不确定的平台要勾选「草稿箱里没有对应草稿」才执行，并带上确认', async () => {
    const wechat = fakePublisher('wechat', [blocker('OUTCOME_UNCERTAIN')], async () =>
      created('W'),
    );
    const zhihu = fakePublisher('zhihu', [], async () => created('Z'));
    const skipped = flow({ wechat: wechat.publisher, zhihu: zhihu.publisher }, (plans) => {
      expect(plans[0].status).toBe('confirm');
      return new Set(['zhihu']);
    });
    const first = await runPush(skipped.deps, ['wechat', 'zhihu'], skipped.ui);
    expect(first?.[0]).toMatchObject({ platform: 'wechat', status: 'skipped' });
    expect(wechat.publisher.push).not.toHaveBeenCalled();
    const confirmed = flow(
      { wechat: wechat.publisher, zhihu: zhihu.publisher },
      () => new Set(['wechat']),
    );
    const second = await runPush(confirmed.deps, ['wechat', 'zhihu'], confirmed.ui);
    expect(second?.[0]).toMatchObject({ platform: 'wechat', status: 'completed' });
    expect(wechat.contexts.at(-1)?.confirmUncertain).toBe(true);
    expect(second?.[1]).toMatchObject({ platform: 'zhihu', status: 'skipped' });
  });
  it('一个平台失败或抛错不影响后面的平台；两平台共用一次操作的图片缓存与同一份快照', async () => {
    const wechat = fakePublisher('wechat', [], async () => {
      throw new Error('意外错误');
    });
    const zhihu = fakePublisher('zhihu', [], async () => ({
      outcome: 'uncertain',
      message: '超时',
      error: blocker('OUTCOME_UNCERTAIN'),
    }));
    const { deps, ui } = flow(
      { wechat: wechat.publisher, zhihu: zhihu.publisher },
      () => new Set(['wechat', 'zhihu']),
    );
    const outcomes = await runPush(deps, ['wechat', 'zhihu'], ui);
    expect(outcomes?.map((o) => o.status)).toEqual(['failed', 'uncertain']);
    expect(outcomes?.[0].result).toMatchObject({
      error: { code: 'PUSH_FAILED', message: '意外错误' },
    });
    const [w] = wechat.contexts;
    const [z] = zhihu.contexts;
    expect(w.images).toBeDefined();
    expect(w.images).toBe(z.images);
    expect(w.source).toBe('/vault/posts/a.md');
    expect(w.fixed).toEqual({ header: true, footer: false });
  });
  it('预处理的提示并入体检警告', async () => {
    const wechat = fakePublisher('wechat', [], async () => created('W'));
    const { deps, ui } = flow(
      { wechat: wechat.publisher } as Record<Platform, Publisher>,
      (plans) => {
        expect(plans[0].report.warnings[0].code).toBe('OBSIDIAN_EMBED');
        return new Set();
      },
    );
    await runPush(deps, ['wechat'], ui);
  });
});
