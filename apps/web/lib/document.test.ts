import { describe, it, expect } from 'vitest';
import {
  STORAGE_TTL,
  articlePart,
  fixedFlags,
  freshDocument,
  freshSettings,
  initialDocument,
  restoreDocument,
  restoreSettings,
  settingsPart,
  tagCopyLinks,
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
it('原文暂存 1 天内原样恢复；超过 1 天、旧版本留下的（没有时间戳）或已损坏的一律作废', () => {
  const now = Date.UTC(2026, 9, 21);
  const saved = (change: object) =>
    JSON.stringify({
      ...articlePart(freshDocument(now)),
      markdown: '我的文章',
      theme: 'mac',
      ...change,
    });
  expect(restoreDocument(saved({ updatedAt: now - STORAGE_TTL + 1 }), now)).toEqual({
    ...articlePart(freshDocument(now - STORAGE_TTL + 1)),
    markdown: '我的文章',
    theme: 'mac',
  });
  for (const change of [
    { updatedAt: now - STORAGE_TTL },
    { updatedAt: undefined },
    { updatedAt: Infinity },
    { theme: 'unknown' },
  ])
    expect(restoreDocument(saved(change), now)).toBeNull();
  expect(restoreDocument('{broken-json', now)).toBeNull();
});
describe('长期设置', () => {
  const now = Date.UTC(2026, 10, 6);
  it('开头结尾与来源参数单独保存，不看原文的 1 天期限；损坏时作废', () => {
    const doc = freshDocument(now - 30 * STORAGE_TTL);
    doc.fixed.zhihu = { ...doc.fixed.zhihu, footer: true, footerMarkdown: '升级：https://example.org' };
    doc.linkRef = { domains: 'example.org', query: 'utm_source=zhihu&utm_content={{id}}' };
    expect(Object.keys(articlePart(doc))).not.toContain('fixed');
    const raw = JSON.stringify(settingsPart(doc));
    expect(restoreSettings(raw, null, now)).toEqual({ fixed: doc.fixed, linkRef: doc.linkRef });
    for (const broken of ['{broken', '{}', JSON.stringify({ ...settingsPart(doc), linkRef: {} })])
      expect(restoreSettings(broken, null, now)).toBeNull();
  });
  it('旧版设置跟原文存在一起：1 天内的迁移过来，寄语、落款与合集链接换成同样效果的 Markdown', () => {
    const legacyFixed = (change: object) => ({
      header: true,
      footer: true,
      headerStyle: '留白分隔',
      footerStyle: '一句寄语',
      author: '作者',
      slogan: '口号',
      closing: '愿每一次认真表达，都被好好看见。',
      collection: '',
      ...change,
    });
    const legacy = (updatedAt: number) =>
      JSON.stringify({
        ...articlePart(freshDocument(updatedAt)),
        fixed: {
          wechat: legacyFixed({ footerStyle: '细线落款', closing: '见 a.b', collection: 'example.com/x' }),
          zhihu: legacyFixed({ footer: false }),
        },
      });
    const migrated = restoreSettings(null, legacy(now - 1000), now)!;
    expect(migrated.fixed.wechat).toEqual({
      header: true,
      footer: true,
      headerStyle: '留白分隔',
      author: '作者',
      slogan: '口号',
      footerMarkdown: '---\n见 a\\.b\n[继续阅读](https://example.com/x)',
    });
    expect(migrated.fixed.zhihu).toMatchObject({
      footer: false,
      footerMarkdown: '愿每一次认真表达，都被好好看见。',
    });
    expect(migrated.linkRef).toEqual(freshSettings().linkRef);
    expect(restoreSettings(null, legacy(now - STORAGE_TTL), now)).toBeNull();
    expect(restoreSettings(null, null, now)).toBeNull();
  });
  it('结尾按 Markdown 排版并替换日期与作者；结尾是空的就不加', async () => {
    const f = {
      ...freshSettings().fixed.zhihu,
      footer: true,
      author: '锦章',
      footerMarkdown: '**{{author}}** 写于 {{date}}\n\n[往期](https://example.com)',
    };
    const p = await prepare(
      { markdown: '正文', title: '', templates: templates(f) },
      {
        platform: 'zhihu',
        fixed: fixedFlags(f),
        resolver: { resolve: async () => ({ kind: 'missing', reason: '' }) },
        config: { date: '2026-11-06', author: f.author },
      },
    );
    const html = render(p).html;
    expect(html).toContain('<strong>锦章</strong> 写于 2026-11-06');
    expect(html).toContain('href="https://example.com"');
    expect(fixedFlags({ ...f, footerMarkdown: '  \n' })).toEqual({ header: false, footer: false });
  });
  it('复制到知乎的链接按设置加来源参数：域名按文字拆分，参数留空用默认 UTM，{{id}} 用日期', () => {
    const html = '<a href="https://www.example.org/a">a</a><a href="https://other.test">b</a>';
    const date = new Date(2026, 10, 6);
    expect(tagCopyLinks(html, { domains: 'example.org， app.test', query: '' }, date)).toEqual({
      html: '<a href="https://www.example.org/a?utm_source=zhihu&amp;utm_medium=social&amp;utm_content=20261106">a</a><a href="https://other.test">b</a>',
      count: 1,
    });
    expect(tagCopyLinks(html, freshSettings().linkRef, date)).toEqual({ html, count: 0 });
  });
});
