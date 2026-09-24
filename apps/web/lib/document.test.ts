import { it, expect } from 'vitest';
import {
  freshDocument,
  initialDocument,
  restoreDocument,
  sampleMarkdown,
  sampleTitle,
  templates,
} from './document';
import { legacySamples } from './legacy-samples';
import { prepare, render } from '@jinzhang/core';
it('兼容旧封面数据，但不再在网页文档中保留', () => {
  expect(
    restoreDocument(JSON.stringify({ ...freshDocument(), cover: 'old.png' })),
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
  const doc = restoreDocument(null, 'https://jinzhang.ink');
  expect(doc).toEqual(initialDocument('https://jinzhang.ink'));
  expect(restoreDocument(JSON.stringify(freshDocument())).markdown).toBe('');
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
    const doc = restoreDocument(saved(markdown), origin);
    expect(doc.markdown).toBe(sampleMarkdown(origin));
    expect(doc.title).toBe(sampleTitle);
    expect(doc.theme).toBe('mac');
    expect(doc.platform).toBe('zhihu');
    expect(restoreDocument(saved(markdown + '\n我的补充'), origin).markdown).toBe(
      markdown + '\n我的补充',
    );
    expect(restoreDocument(saved(markdown, '我自己的标题'), origin).markdown).toBe(markdown);
  }
  // 当前示例原样保存时保持不变。
  expect(restoreDocument(saved(sampleMarkdown(origin)), origin).markdown).toBe(
    sampleMarkdown(origin),
  );
});
