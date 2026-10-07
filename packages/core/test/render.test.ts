import { describe, it, expect } from 'vitest';
import { prepare, render, placeImages, template, themes, extractMarkdownTitle } from '../src/index';
import type { AssetResolver } from '../src/types';
import { defaultConfig, localFixed } from '../src/local';
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
  it('公众号嵌套列表保留原生结构并按层级换圆点，强调后中文标点进入强调节点', async () => {
    const r = render(await make('- 一级\n  - 二级\n    - 三级\n\n1. 有序\n\n**重点**。'));
    expect(r.html.match(/<ul/g) || []).toHaveLength(3);
    expect(r.html).not.toContain('•');
    expect(r.html.match(/list-style-type:(\w+)!important/g)).toEqual([
      'list-style-type:disc!important',
      'list-style-type:circle!important',
      'list-style-type:square!important',
      'list-style-type:decimal!important',
    ]);
    // 微信保存草稿时会把列表里的空白文本变成空条目。
    expect(r.html).not.toMatch(/<ul[^>]*>\s+<li|<\/li>\s+<(li|\/ul)/);
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
    expect(r.html).toMatch(/<blockquote[^>]*>\s*<p style="margin:0 0 20px!important[^"]*">第一段/);
    expect(r.html).toMatch(/<p style="margin:20px 0 0!important[^"]*">第二段/);
    expect(render(await make('> 只有一段')).html).toMatch(
      /<p style="margin:0!important[^"]*">只有一段/,
    );
    expect(r.html).toContain('<section style="overflow-x:auto;max-width:100%;margin:24px 0"><pre');
    expect(r.html).toContain(
      '<section style="overflow-x:auto;max-width:100%;margin:24px 0"><table',
    );
    expect(r.html).toMatch(/<pre style="[^"]*margin:0[^"]*">/);
    expect(r.html).toMatch(/<table style="[^"]*margin:0"/);
    expect(r.html).not.toContain('<br></code>');
  });
  it('任务条目不显示圆点，同一列表里的普通条目不受影响，复选框后只留一个空格', async () => {
    const r = render(await make('- 普通条目\n- [x] 完成\n- [ ] 未完成'));
    expect(r.html).toMatch(/<li style="[^"]*list-style:none[^"]*">☑/);
    expect(r.html).toMatch(/<li style="margin:8px 0">普通条目/);
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

describe('少数派与公众号原生主题的成品细节', () => {
  it('代码块带红黄绿圆点，Mac 主题不带；代码不沿用行内代码的底色与字色', async () => {
    const p = await make('行内 `code`\n\n```js\nconst x = 1;\n```');
    for (const theme of ['sspai', 'native'] as const) {
      const { html } = render(p, { theme });
      expect(html).toMatch(
        /<pre style="[^"]*"><section style="margin-bottom:12px;white-space:nowrap">(<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#[0-9a-f]{6}(;margin-right:6px)?"><\/span>){3}<\/section><code/,
      );
      expect(html).toMatch(
        /<code style="[^"]*font-family:monospace[^"]*background-color:transparent!important;color:inherit!important[^"]*">/,
      );
    }
    expect(render(p, { theme: 'mac' }).html).not.toContain('border-radius:50%');
  });
  it('表格的边框、内边距与表头底色写成属性，单元格不带样式，列对齐保留', async () => {
    const source = '| 左 | 中 | 默认 |\n| :-- | :-: | --- |\n| `a` | b | c |';
    const { html } = render(await make(source));
    expect(html).toContain(
      '<table style="width:100%;border-collapse:collapse;font-size:15px;table-layout:fixed;min-width:420px;color:#333;white-space:normal;word-break:normal;overflow-wrap:anywhere;margin:0" border="1" cellpadding="12" cellspacing="0" bordercolor="#f0e0e0">',
    );
    expect(html).toContain('<th align="left" bgcolor="#fef7f7">左</th>');
    expect(html).toContain('<th align="center" bgcolor="#fef7f7">中</th>');
    expect(html).toContain('<th align="left" bgcolor="#fef7f7">默认</th>');
    expect(html).toContain('<td align="left"><code style="white-space:nowrap">a</code></td>');
    expect(html).toContain('<td>c</td>');
    expect(html).not.toMatch(/<(tr|th|td)[^>]*style=/);
    const native = render(await make(source), { theme: 'native' }).html;
    expect(native).toContain('bordercolor="#d8e8dc"');
    expect(native).toContain('bgcolor="#f0f7f2"');
    const mac = render(await make(source), { theme: 'mac' }).html;
    expect(mac).toContain('border="1" cellpadding="8" cellspacing="0" bordercolor="#dddddd"');
    expect(mac).toContain('<th bgcolor="#f2f3f0">默认</th>');
  });
  it('主题的 !important 带到成品；与根容器相同的文字声明交给继承，引用里的段落保留自己的颜色', async () => {
    const { html } = render(await make('正文\n\n> 引用\n\n#### 四级\n\n- 条目'));
    expect(html).toMatch(/^<section style="[^"]*line-height:1.8!important;color:#333!important/);
    expect(html).toContain('<p style="margin:20px 0!important">正文</p>');
    expect(html).toContain('<p style="margin:0!important;color:#333!important">引用</p>');
    expect(html).toContain('<li style="margin:8px 0">条目</li>');
    // 标题的字号即使与正文相同也要写明，否则落回浏览器给标题的默认字号。
    expect(html).toMatch(/<h4 style="font-size:16px;font-weight:600;line-height:1.4!important/);
  });
  it('标题里的强调、链接与代码跟随标题颜色，图片带圆角与阴影', async () => {
    const { html } = render(
      await make('## **粗** [链](https://example.test) `码`\n\n![图](https://example.test/a.png)'),
    );
    expect(html).toMatch(
      /<strong style="font-weight:700;color:inherit!important;background-color:transparent!important">粗/,
    );
    expect(html).toMatch(
      /<a [^>]*style="color:inherit!important;text-decoration:none!important;border-bottom:1px solid currentColor!important/,
    );
    expect(html).toMatch(
      /<code style="[^"]*padding:0!important;background-color:transparent!important;color:inherit!important/,
    );
    expect(html).toMatch(
      /<img [^>]*style="[^"]*margin:30px auto!important;border-radius:14px!important;width:100%;padding:8px!important;box-sizing:border-box;box-shadow:/,
    );
  });
  it('原始 HTML 里作者写的内联样式高于主题的 !important', async () => {
    const { html } = render(await make('<p style="color:red;margin:0">正文</p>'));
    expect(html).toContain('<p style="color:red;margin:0">正文</p>');
  });
});

describe('名片与本地形态的固定内容', () => {
  const card = {
    mpId: 'MzTEST==',
    nickname: '示例"号"',
    headImg: 'https://example.test/a.png',
    signature: '简介 & 说明',
    serviceType: 1,
    verifyStatus: 2,
  };
  const options = (platform: 'wechat' | 'zhihu', extra = {}) => ({
    platform,
    fixed: { header: true, footer: true },
    resolver,
    ...extra,
  });
  it(':::card 输出公众号编辑器识别的名片组件，类名与 data 属性原样保留', async () => {
    const p = await prepare(
      { markdown: '正文\n\n:::card\n:::', title: '' },
      options('wechat', { card }),
    );
    const { html, warnings } = render(p);
    expect(html).toContain(
      '<section class="mp_profile_iframe_wrp custom_select_card_wrp" nodeleaf=""><mp-common-profile class="mpprofile js_uneditable custom_select_card mp_profile_iframe" data-pluginname="mpprofile" data-id="MzTEST==" data-nickname="示例&#x22;号&#x22;" data-headimg="https://example.test/a.png" data-signature="简介 &#x26; 说明" data-service_type="1" data-verify_status="2"></mp-common-profile><br class="ProseMirror-trailingBreak"></section>',
    );
    expect(html.match(/class=/g)).toHaveLength(3);
    expect(warnings).toEqual([]);
  });
  it('没有名片资料时 :::card 不输出并警告；正文里手写的名片标签被清理', async () => {
    const p = await prepare({ markdown: '正文\n\n:::card\n:::', title: '' }, options('wechat'));
    const r = render(p);
    expect(r.html).not.toContain('mp-common-profile');
    expect(r.warnings.map((w) => w.code)).toEqual(['CARD_NOT_CONFIGURED']);
    const raw = render(
      await make(
        '<mp-common-profile data-id="x"></mp-common-profile>\n\n<section data-jz="other">x</section>',
      ),
    );
    expect(raw.html).not.toMatch(/mp-common-profile|data-jz/);
  });
  it('知乎整块移除名片并记降级', async () => {
    const p = await prepare(
      { markdown: '正文\n\n:::card\n:::', title: '' },
      options('zhihu', { card }),
    );
    const r = render(p);
    expect(r.html.trim()).toBe('<p>正文</p>');
    expect(r.degraded).toEqual([
      { code: 'ZHIHU_DEGRADED', message: '公众号名片已移除，知乎不支持。' },
    ]);
  });
  it('plainFixed 时开头结尾不包主题容器，按正文排版', async () => {
    const input = { markdown: '正文', title: '', templates: { header: '开头', footer: '结尾' } };
    const themed = render(await prepare(input, options('wechat'))).html;
    expect(themed).toMatch(
      /<section style="font-size:12px;letter-spacing:1px[^"]*"><p style="margin:6px 0!important;color:#8a7162!important">开头<\/p><\/section>/,
    );
    const plain = render(await prepare(input, options('wechat', { plainFixed: true }))).html;
    expect(plain).toContain(
      '<p style="margin:20px 0!important">开头</p><p style="margin:20px 0!important">正文</p><p style="margin:20px 0!important">结尾</p>',
    );
  });
  it('开头样式一依次是宣言、名片、作者、出品与分隔线，结尾样式一先结尾文字再名片', async () => {
    const config = defaultConfig();
    config.author = '作者 <名>';
    config.wechat.start = { slogan: '持续更新', producerName: '示例号' };
    config.wechat.card = { ...card, enabled: true };
    const fixed = localFixed(
      'wechat',
      config,
      { wechat: '***结尾***\n', zhihu: '知乎结尾' },
      '2026-10-07',
    );
    expect(fixed.fixed).toEqual({ header: true, footer: true });
    expect(fixed.card).toEqual(card);
    expect(fixed.templates.footer).toBe('***结尾***\n\n:::card\n:::');
    const p = await prepare(
      { markdown: '正文', title: '', templates: fixed.templates },
      {
        platform: 'wechat',
        fixed: fixed.fixed,
        plainFixed: true,
        card: fixed.card,
        config: fixed.variables,
        resolver,
      },
    );
    const { html, warnings } = render(p);
    expect(warnings).toEqual([]);
    const profile = '<section class="mp_profile_iframe_wrp custom_select_card_wrp" nodeleaf="">';
    const order = [
      '<section style="margin:0 0 12px;font-weight:400;color:inherit">',
      '<section style="margin:0 0 6px;text-align:center;font-size:13px;line-height:1.5;font-weight:400;letter-spacing:0.02em;color:inherit">持续更新</section>',
      profile,
      '<section style="margin:0;font-size:12px;line-height:1.5;font-weight:400;color:inherit">作者｜作者 &#x3C;名></section>',
      '<section style="margin:4px 0 0;font-size:12px;line-height:1.5;font-weight:400;color:inherit">出品｜公众号：<span style="font-size:inherit;line-height:inherit;font-weight:inherit;color:#0b83c7">示例号</span></section>',
      '<section style="margin:12px 0 0;height:1px;line-height:1px;background-color:#e5e5e5">\u200b</section>',
      '<p style="margin:20px 0!important">正文</p>',
      '结尾</strong></em></p>',
      profile,
    ];
    let at = 0;
    for (const piece of order) {
      const found = html.indexOf(piece, at);
      expect(found, piece).toBeGreaterThanOrEqual(at);
      at = found + piece.length;
    }
    expect(html.match(/<mp-common-profile/g)).toHaveLength(2);
  });
  it('没填的行不显示，名片关闭或资料不全时不带名片，全空等于没启用', () => {
    const config = defaultConfig();
    const footers = { wechat: '', zhihu: '' };
    expect(localFixed('wechat', config, footers, '2026-10-07').fixed).toEqual({
      header: false,
      footer: false,
    });
    config.author = '作者';
    config.wechat.card = { ...card, enabled: false };
    const onlyAuthor = localFixed('wechat', config, { ...footers, wechat: '结尾' }, '2026-10-07');
    expect(onlyAuthor.fixed).toEqual({ header: true, footer: true });
    expect(onlyAuthor.card).toBeNull();
    expect(onlyAuthor.templates.header).not.toContain(':::card');
    expect(onlyAuthor.templates.footer).toBe('结尾');
    expect(onlyAuthor.variables).toEqual({ date: '2026-10-07', author: '作者' });
    expect(template(onlyAuthor.templates.header, onlyAuthor.variables)).not.toMatch(/出品|\{\{/);
    config.wechat.card = { ...card, enabled: true, mpId: '' };
    expect(localFixed('wechat', config, footers, '2026-10-07').card).toBeNull();
    config.wechat.card = { ...card, enabled: true };
    config.fixed.wechat = { header: false, footer: true };
    const cardOnly = localFixed('wechat', config, footers, '2026-10-07');
    expect(cardOnly.fixed).toEqual({ header: false, footer: true });
    expect(cardOnly.templates.footer).toBe(':::card\n:::');
  });
  it('知乎只有结尾 Markdown，不带名片也没有开头', () => {
    const config = defaultConfig();
    config.wechat.card = { ...card, enabled: true };
    const footers = { wechat: '公众号结尾', zhihu: ' 知乎结尾 {{author}} ' };
    const zhihu = localFixed('zhihu', config, footers, '2026-10-07');
    expect(zhihu).toEqual({
      fixed: { header: false, footer: true },
      templates: { header: '', footer: '知乎结尾 {{author}}' },
      variables: { date: '2026-10-07' },
      card: null,
    });
    config.fixed.zhihu.footer = false;
    expect(localFixed('zhihu', config, footers, '2026-10-07').fixed.footer).toBe(false);
    expect(
      localFixed('zhihu', defaultConfig(), { wechat: '', zhihu: ' ' }, '2026-10-07').fixed.footer,
    ).toBe(false);
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
