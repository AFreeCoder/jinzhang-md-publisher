import { it, expect } from 'vitest';
import {
  ARTICLE_TTL,
  PREVIOUS_TTL,
  freshDocument,
  initialDocument,
  restoreDocument,
  restorePrevious,
  sampleMarkdown,
  sampleTitle,
  templates,
} from './document';
import { legacySamples } from './legacy-samples';
import { prepare, render } from '@jinzhang/core';
it('兼容旧封面数据，但不再在网页文档中保留', () => {
  expect(
    restoreDocument(JSON.stringify({ ...freshDocument(), cover: 'old.png' })).doc,
  ).not.toHaveProperty('cover');
});
it('署名与寄语中的 Markdown 标点作为正文呈现', async () => {
  for (const author of ['~~~', '---', '===', '# 作者', '[作者](x)']) {
    const f = { ...freshDocument().fixed.wechat, author, slogan: '寄语仍在' };
    const p = await prepare(
      { markdown: templates(f).header, title: '' },
      {
        platform: 'wechat',
        fixed: { header: false, footer: false },
        resolver: { resolve: async () => ({ kind: 'missing', reason: '' }) },
      },
    );
    const r = render(p);
    expect(r.text).toContain(author);
    expect(r.text).toContain('寄语仍在');
    expect(r.html).not.toMatch(/<pre|<hr|<h1/);
  }
});
it('没有保存过内容时预置示例稿，示例覆盖常见语法且不触发排版警告', async () => {
  const { doc } = restoreDocument(null, 'https://jinzhang.ink', 1000);
  expect(doc).toEqual(initialDocument('https://jinzhang.ink', 1000));
  expect(restoreDocument(JSON.stringify(freshDocument())).doc.markdown).toBe('');
  const seen: string[] = [];
  const p = await prepare(
    { markdown: doc.markdown, title: doc.title },
    {
      platform: 'wechat',
      fixed: { header: false, footer: false },
      resolver: {
        resolve: async (ref) => {
          seen.push(ref);
          return { kind: 'remote', url: ref };
        },
      },
    },
  );
  const r = render(p);
  expect(seen).toEqual(['https://jinzhang.ink/sample-cover.jpg']);
  expect(r.warnings).toEqual([]);
  for (const tag of [
    'h2',
    'h3',
    'h4',
    'strong',
    'em',
    'del',
    'code',
    'a',
    'blockquote',
    'ul',
    'ol',
    'pre',
    'table',
    'img',
    'hr',
    'sup',
  ])
    expect(r.html).toContain(`<${tag}`);
  expect(r.html).toContain('☑');
  expect(r.html).not.toContain('<h1');
});
it('浏览器里原样未改的旧版示例升级为当前示例，设置保留；改过的稿子不动', () => {
  const origin = 'https://jinzhang.ink';
  const saved = (markdown: string, title = sampleTitle) =>
    JSON.stringify({ ...freshDocument(), markdown, title, theme: 'mac', platform: 'zhihu' });
  const legacy = legacySamples(origin);
  expect(legacy).toHaveLength(2);
  for (const markdown of legacy) {
    expect(markdown).not.toBe(sampleMarkdown(origin));
    const { doc } = restoreDocument(saved(markdown), origin);
    expect(doc.markdown).toBe(sampleMarkdown(origin));
    expect(doc.title).toBe(sampleTitle);
    expect(doc.theme).toBe('mac');
    expect(doc.platform).toBe('zhihu');
    expect(restoreDocument(saved(markdown + '\n我的补充'), origin).doc.markdown).toBe(
      markdown + '\n我的补充',
    );
    expect(restoreDocument(saved(markdown, '我自己的标题'), origin).doc.markdown).toBe(markdown);
  }
  // 当前示例原样保存时保持不变。
  expect(restoreDocument(saved(sampleMarkdown(origin)), origin).doc.markdown).toBe(
    sampleMarkdown(origin),
  );
});
it('文章 1 天内原样恢复；超过 1 天换成示例稿、设置保留，原文交给上一稿', () => {
  const origin = 'https://jinzhang.ink';
  const now = Date.UTC(2026, 9, 21);
  const saved = (change: object) =>
    JSON.stringify({
      ...freshDocument(),
      theme: 'mac',
      platform: 'zhihu',
      markdown: '我的文章',
      title: '标题',
      ...change,
    });
  const sample = { ...initialDocument(origin, now), theme: 'mac', platform: 'zhihu' };
  const recent = restoreDocument(saved({ updatedAt: now - ARTICLE_TTL + 1 }), origin, now);
  expect(recent.doc.markdown).toBe('我的文章');
  expect(recent.doc.updatedAt).toBe(now - ARTICLE_TTL + 1);
  expect(recent.expired).toBeUndefined();
  expect(restoreDocument(saved({ updatedAt: now - ARTICLE_TTL }), origin, now)).toEqual({
    doc: sample,
    expired: { markdown: '我的文章', title: '标题', updatedAt: now - ARTICLE_TTL },
  });
  // 已超过上一稿的保留期，直接丢弃。
  expect(restoreDocument(saved({ updatedAt: now - PREVIOUS_TTL }), origin, now)).toEqual({
    doc: sample,
  });
  // 升级前没有时间戳：收进上一稿，保留期从本次打开起算。
  expect(restoreDocument(saved({ updatedAt: undefined }), origin, now)).toEqual({
    doc: sample,
    expired: { markdown: '我的文章', title: '标题', updatedAt: now },
  });
  // 空白稿与原样示例过期不进上一稿。
  for (const change of [
    { markdown: '', title: '', updatedAt: 0 },
    { markdown: legacySamples(origin)[0], title: sampleTitle, updatedAt: 0 },
  ])
    expect(restoreDocument(saved(change), origin, now).expired).toBeUndefined();
});
it('上一稿从最后修改起保留 7 天，旧数据从本次打开起算，无效内容忽略', () => {
  const now = Date.UTC(2026, 9, 21);
  const raw = (updatedAt?: number) =>
    JSON.stringify({ markdown: '上一篇', title: '旧题', updatedAt });
  expect(restorePrevious(raw(now - PREVIOUS_TTL + 1), now)).toEqual({
    markdown: '上一篇',
    title: '旧题',
    updatedAt: now - PREVIOUS_TTL + 1,
  });
  expect(restorePrevious(raw(now - PREVIOUS_TTL), now)).toBeNull();
  expect(restorePrevious(raw(), now)?.updatedAt).toBe(now);
  for (const bad of [null, '{broken', '{"markdown":1,"title":""}'])
    expect(restorePrevious(bad, now)).toBeNull();
});
