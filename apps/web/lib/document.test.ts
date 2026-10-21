import { it, expect } from 'vitest';
import {
  STORAGE_TTL,
  freshDocument,
  initialDocument,
  restoreDocument,
  templates,
} from './document';
import { prepare, render } from '@jinzhang/core';
it('兼容旧封面数据，但不再在网页文档中保留', () => {
  expect(
    restoreDocument(JSON.stringify({ ...freshDocument(), cover: 'old.png' }))!,
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
it('没有可用暂存时预置示例稿，示例覆盖常见语法且不触发排版警告', async () => {
  expect(restoreDocument(null)).toBeNull();
  const doc = initialDocument('https://jinzhang.ink');
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
it('暂存 1 天内原样恢复；超过 1 天、旧版本留下的（没有时间戳）或已损坏的一律作废', () => {
  const now = Date.UTC(2026, 9, 21);
  const saved = (change: object) =>
    JSON.stringify({ ...freshDocument(now), markdown: '我的文章', theme: 'mac', ...change });
  expect(restoreDocument(saved({ updatedAt: now - STORAGE_TTL + 1 }), now)).toEqual({
    ...freshDocument(now - STORAGE_TTL + 1),
    markdown: '我的文章',
    theme: 'mac',
  });
  for (const change of [
    { updatedAt: now - STORAGE_TTL },
    { updatedAt: undefined },
    { updatedAt: Infinity },
    { theme: 'unknown' },
    { fixed: {} },
  ])
    expect(restoreDocument(saved(change), now)).toBeNull();
  expect(restoreDocument('{broken-json', now)).toBeNull();
});
