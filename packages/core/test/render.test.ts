import { describe, it, expect } from 'vitest';
import { prepare, render, placeImages, template, themes, extractMarkdownTitle } from '../src/index';
import type { AssetResolver } from '../src/types';
const resolver: AssetResolver = {
  resolve: async (ref) =>
    ref.startsWith('https:') ? { kind: 'remote', url: ref } : { kind: 'missing', reason: '缺图' },
};
const make = async (markdown: string, platform: 'wechat' | 'zhihu' = 'wechat', title = '') =>
  prepare({ markdown, title }, { platform, fixed: { header: false, footer: false }, resolver });
describe('共享渲染', () => {
  it('预览定位保留原文行号，复制内容不带定位标记', async () => {
    const source = '---\nname: test\n---\n\n# 标题\n\n重复正文\n\n重复正文';
    for (const platform of ['wechat', 'zhihu'] as const) {
      const prepared = await make(source, platform, '标题');
      const preview = render(prepared, { sourceLocations: true }).html;
      expect(preview).toContain('data-source-line="7"');
      expect(preview).toContain('data-source-line="9"');
      expect(render(prepared).html).not.toContain('data-source-line');
    }
  });
  it('提取真实一级标题，忽略代码、引用和 frontmatter，保留标题可见文本', async () => {
    expect(
      await extractMarkdownTitle('```sh\n# 代码注释\n```\n\n    # 缩进代码\n\n> # 引用标题'),
    ).toBe('');
    expect(
      await extractMarkdownTitle(
        '---\n# 元数据注释\n---\n\n# **真正**的 [标题](https://example.test) `code`\n\n# 后续标题',
      ),
    ).toBe('真正的 标题 code');
    expect(await extractMarkdownTitle('Setext 标题\n===\n\n正文')).toBe('Setext 标题');
    expect(await extractMarkdownTitle('## 二级标题')).toBe('');
  });
  it('裸网址末尾中文句读留在正文，显式链接目标保持原样', async () => {
    const source =
      '网址：https://github.com/。\n\nhttps://example.test/路径！？\n\n[显式链接](https://example.test/。)';
    for (const platform of ['wechat', 'zhihu'] as const) {
      const { html, text } = render(await make(source, platform));
      expect(html).toContain('href="https://github.com/"');
      expect(html).toContain('href="https://example.test/%E8%B7%AF%E5%BE%84"');
      expect(text).toContain('https://github.com/。');
      expect(text).toContain('https://example.test/路径！？');
      expect(html).toContain('href="https://example.test/%E3%80%82"');
    }
  });
  it('清理恶意 HTML 与协议，收集原始 HTML 图片', async () => {
    const p = await make(
      '<script>alert(1)</script><img src="./a.png" onerror="alert(2)"><iframe src="https://evil.test"></iframe>\n\n[x](javascript:alert)',
    );
    const r = render(p);
    expect(r.html).not.toMatch(/<script|onerror|<iframe|javascript:/);
    expect(r.images).toHaveLength(1);
    expect(r.warnings.some((w) => w.code === 'HTML_STRIPPED')).toBe(true);
  });
  it('不自动把 H1 当标题，明确相同标题时才移除首个 H1', async () => {
    expect(render(await make('# 一级标题')).html).toContain('<h1');
    expect(render(await make('# 一级标题', 'wechat', '一级标题')).html).not.toContain('<h1');
  });
  it('去 frontmatter、私有语法警告、缺变量删整行', async () => {
    expect(
      render(await make('---\ntitle: 私有\n---\n\n正文 [[双链]]')).warnings.map((w) => w.code),
    ).toEqual(expect.arrayContaining(['FRONTMATTER_IGNORED', 'UNSUPPORTED_SYNTAX']));
    expect(template('作者 {{author}}\n标题 {{title}}', { author: '某人' })).toBe('作者 某人');
  });
  it('固定开头首图不成为默认封面', async () => {
    const p = await prepare(
      { markdown: '![正文](body.png)', title: '', templates: { header: '![开头](header.png)' } },
      { platform: 'wechat', fixed: { header: true, footer: false }, resolver },
    );
    expect(p.images).toHaveLength(2);
    expect(p.cover?.original).toBe('body.png');
  });
  it('知乎不含主题 style，降级深标题、转换代码与表格', async () => {
    const p = await make(
      '#### 深标题\n\n```js\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |',
      'zhihu',
    );
    const r = render(p);
    expect(r.html).not.toContain('style=');
    expect(r.html).toContain('<p><strong>深标题');
    expect(r.html).toContain('lang="js"');
    expect(r.html).toContain('data-draft-type="table"');
    expect(r.degraded).toHaveLength(1);
  });
  it('公众号任务列表、代码、三套主题输出稳定', async () => {
    const p = await make(
      '## 标题\n\n- [x] 完成\n- [ ] 未完成\n\n```js\n  const x = 1;\n  console.log(x);\n```',
    );
    for (const theme of themes) {
      const r = render(p, { theme: theme.id });
      expect(r.html).not.toContain('<input');
      expect(r.html).toContain('☑');
      expect(r.html).toContain('overflow-x:auto');
      expect(r.html).not.toContain('class=');
      expect(r.html).toContain('<br>');
      expect(r.html).toMatchSnapshot(theme.id);
    }
  });
  it('图片归位只替换 src，占位相似正文不被改变', async () => {
    const r = render(await make('jz-img:0\n\n![x](https://example.test/a.png)'));
    const p = await placeImages(r, { put: async () => ({ src: 'https://cdn.test/a?x=1&y=2' }) });
    expect(p.html).toContain('jz-img:0');
    expect(p.html).toContain('src="https://cdn.test/a?x=1&#x26;y=2"'.replace('&#x26;', '&amp;'));
    expect(p.bytes).toBe(new TextEncoder().encode(p.html).byteLength);
  });
});

describe('精确补图重写', () => {
  it('相似路径、alt 和正文中的同名文本不被改动', async () => {
    const { replaceImageReference } = await import('../src/references');
    const source =
      '文字 ./a.png\n\n![./a.png](./a.png)\n\n![其他](./a.png.backup)\n\n<img src="./a.png">';
    const value = replaceImageReference(source, './a.png', 'jz-local://new');
    expect(value).toContain('文字 ./a.png');
    expect(value).toContain('![./a.png](<jz-local://new>)');
    expect(value).toContain('(./a.png.backup)');
    expect(value).toContain('src="jz-local://new"');
  });
});

describe('平台规则补充', () => {
  it('知乎相邻代码围栏保留独立边界与语言，避免保存草稿后合并', async () => {
    const markdown = '```typescript\nconst x = 1;\n```\n\n```json\n{"x":1}\n```';
    const html = render(await make(markdown, 'zhihu')).html;
    expect(html).toContain('</pre><p><br></p><pre lang="json">');
    expect(html).toContain('<pre lang="typescript">const x = 1;\n</pre>');
  });
  it('知乎脚注包含内容与链接，移除文末脚注列表', async () => {
    const r = render(await make('正文[^1]\n\n[^1]: 参考 [出处](https://example.test)', 'zhihu'));
    expect(r.html).toContain('data-text="参考 出处"');
    expect(r.html).toContain('data-url="https://example.test"');
    expect(r.html).not.toContain('Footnotes');
  });
  it('只保留允许的内联 CSS，知乎逐条报告样式降级', async () => {
    const source =
      '<p style="color:red;position:fixed;background-image:url(https://evil.test/x)">正文</p>';
    const r = render(await make(source));
    expect(r.html).toContain('color:red');
    expect(r.html).not.toContain('position');
    expect(r.html).not.toContain('evil.test');
    const z = render(await make(source, 'zhihu'));
    expect(z.html).not.toContain('style=');
    expect(z.degraded[0].message).toContain('装饰样式');
  });
  it('公众号扁平化深层列表，强调后中文标点进入强调节点', async () => {
    const r = render(await make('- 一级\n  - 二级\n\n**重点**。'));
    expect(r.html.match(/<ul/g) || []).toHaveLength(1);
    expect(r.html).toContain('• 二级');
    expect(r.html).toContain('重点。</strong>');
  });
  it('链接与行内代码后的中文标点留在元素外，不被下划线或底色一起装饰', async () => {
    const r = render(await make('见[链接](https://example.test)。再看 `code`，结束。'));
    expect(r.html).toContain('链接</a>。');
    expect(r.html).toContain('code</code>，');
  });
  it('中文软换行不产生空格，西文软换行保留词间空格', async () => {
    for (const platform of ['wechat', 'zhihu'] as const) {
      const r = render(await make('第一行，\n第二行。\n\nhello\nworld', platform));
      expect(r.text).toContain('第一行，第二行。');
      expect(r.text).toMatch(/hello\sworld/);
    }
  });
  it('引用首末段不叠加外边距，代码块与表格的外边距交给滚动容器', async () => {
    const r = render(
      await make('> 第一段\n>\n> 第二段\n\n```js\nconst x = 1;\n```\n\n| a |\n| - |\n| 1 |'),
    );
    expect(r.html).toMatch(/<blockquote[^>]*>\s*<p style="[^"]*margin-top:0[^"]*">第一段/);
    expect(r.html).toMatch(/<p style="[^"]*margin-bottom:0[^"]*">第二段/);
    expect(r.html).toContain('<section style="overflow-x:auto;max-width:100%;margin:20px 0"><pre');
    expect(r.html).toContain(
      '<section style="overflow-x:auto;max-width:100%;margin:18px 0"><table',
    );
    expect(r.html).toMatch(/<pre style="[^"]*margin:0[^"]*">/);
    expect(r.html).toMatch(/<table[^>]*style="[^"]*margin:0[^"]*">/);
    expect(r.html).not.toContain('<br></code>');
  });
  it('任务条目不显示圆点，同一列表里的普通条目不受影响，复选框后只留一个空格', async () => {
    const r = render(await make('- 普通条目\n- [x] 完成\n- [ ] 未完成'));
    expect(r.html).toMatch(/<li style="[^"]*list-style:none[^"]*">☑/);
    expect(r.html).toMatch(/<li style="margin:7px 0">普通条目/);
    expect(r.html).toContain('☑ 完成');
    expect(r.html).toContain('☐ 未完成');
  });
  it('Mac 主题深色代码块使用浅色高亮，行内代码有底色且不影响代码块', async () => {
    const r = render(await make('行内 `code`\n\n```js\nconst x = "a"; // 注释\n```'), {
      theme: 'mac',
    });
    expect(r.html).toContain('background:#eef1f5;color:#44586f">code</code>');
    expect(r.html).toMatch(/<pre style="[^"]*background:#282d35[^"]*">/);
    expect(r.html).toMatch(/<code style="[^"]*background:transparent;color:#e2e5ea[^"]*">/);
    expect(r.html).toContain('<span style="color:#e892a0">const</span>');
    expect(r.html).not.toContain('color:#a04b57');
  });
});

describe('标准文章跨主题与平台基线', () => {
  it('同一份 core 输入在各宿主中不依赖 DOM 或 Node 环境', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../../fixtures/article.md', import.meta.url), 'utf8');
    for (const platform of ['wechat', 'zhihu'] as const) {
      const p = await make(source, platform, '标准验收文章');
      for (const t of themes) {
        expect(render(p, { theme: t.id }).html).toMatchSnapshot(`${platform}-${t.id}`);
      }
    }
  });
});
