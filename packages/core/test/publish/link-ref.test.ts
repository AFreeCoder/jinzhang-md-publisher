import { describe, expect, it } from 'vitest';
import { defaultConfig, normalizeConfig, tagZhihuLinks } from '../../src/publish';
import {
  compactDate,
  DEFAULT_LINK_QUERY,
  linkQuery,
  normalizeLinkQuery,
  parseDomains,
  prepare,
  render,
  tagLinks,
} from '../../src/index';
const DOMAINS = ['example.org'];
const UTM = 'utm_source=zhihu&utm_medium=social&utm_content=123';
const tag = (html: string, domains = DOMAINS) => tagLinks(html, domains, UTM);
describe('链接来源参数', () => {
  it('只改 href，显示的文字不动；没有路径时补斜杠', () => {
    expect(tag('<p>见：<a href="https://example.org">https://example.org</a></p>')).toEqual({
      html: '<p>见：<a href="https://example.org/?utm_source=zhihu&amp;utm_medium=social&amp;utm_content=123">https://example.org</a></p>',
      count: 1,
    });
  });
  it('保留原有路径、参数与锚点，来源参数追加在最后；http 与子域名同样处理', () => {
    const { html, count } = tag(
      [
        '<a href="https://example.org/pricing?a=1&#x26;b=%E4%B8%AD#faq">价格</a>',
        '<a href="http://www.example.org/a">a</a>',
        '<a href="https://app.example.org">b</a>',
      ].join(''),
    );
    expect(count).toBe(3);
    const query = UTM.replace(/&/g, '&amp;');
    expect(html).toContain(`href="https://example.org/pricing?a=1&amp;b=%E4%B8%AD&amp;${query}#faq"`);
    expect(html).toContain(`href="http://www.example.org/a?${query}"`);
    expect(html).toContain(`href="https://app.example.org/?${query}"`);
  });
  it('已带其中任一参数的不动，处理两次结果相同', () => {
    for (const own of [
      '<a href="https://example.org/?utm_source=other">x</a>',
      '<a href="https://example.org/?a=1&#x26;utm_content=mine">x</a>',
    ])
      expect(tag(own)).toEqual({ html: own, count: 0 });
    const once = tag('<a href="https://example.org">x</a>').html;
    expect(tag(once)).toEqual({ html: once, count: 0 });
    // 旧版的 ref 参数不在这次的参数里，照常追加。
    expect(tag('<a href="https://example.org/?ref=old">x</a>').count).toBe(1);
  });
  it('相似域名、其他协议、站内锚点、图片地址与代码里的文字都不动', () => {
    const html = [
      '<a href="https://example.org.evil.test">a</a>',
      '<a href="https://notexample.org">b</a>',
      '<a href="mailto:me@example.org">c</a>',
      '<a href="#user-content-fn-1">d</a>',
      '<img src="https://example.org/a.png">',
      '<pre><code>&#x3C;a href="https://example.org">x&#x3C;/a></code></pre>',
      '<p>href="https://example.org"</p>',
    ].join('');
    expect(tag(html)).toEqual({ html, count: 0 });
  });
  it('知乎脚注引用的 data-url 也加，data-text 是显示文字不动', () => {
    const sup =
      '<sup data-draft-node="inline" data-draft-type="reference" data-numero="1" data-text="见 https://example.org" data-url="https://example.org/a">[1]</sup>';
    const { html, count } = tag(sup);
    expect(count).toBe(1);
    expect(html).toContain('data-text="见 https://example.org"');
    expect(html).toContain(`data-url="https://example.org/a?${UTM.replace(/&/g, '&amp;')}"`);
  });
  it('域名或参数为空时原样返回', () => {
    const html = '<a href="https://example.org">x</a>';
    expect(tagLinks(html, [], UTM)).toEqual({ html, count: 0 });
    expect(tagLinks(html, DOMAINS, '')).toEqual({ html, count: 0 });
  });
  it('多个域名：配上第二个域名才处理它', () => {
    const html = '<a href="https://example.org">a</a><a href="http://app.example.com">b</a>';
    expect(tag(html).count).toBe(1);
    const both = tag(html, ['example.org', 'example.com']);
    expect(both.count).toBe(2);
    expect(both.html).toContain('href="http://app.example.com/?utm_source=zhihu');
  });
  it('参数模板：{{id}} 用文章 ID，拿不到时用日期；{{date}} 是 YYYYMMDD；值按查询串编码', () => {
    const now = new Date(2026, 10, 6, 9, 30);
    expect(compactDate(now)).toBe('20261106');
    expect(linkQuery(DEFAULT_LINK_QUERY, '2101121274567210869', now)).toBe(
      'utm_source=zhihu&utm_medium=social&utm_content=2101121274567210869',
    );
    expect(linkQuery(DEFAULT_LINK_QUERY, undefined, now)).toBe(
      'utm_source=zhihu&utm_medium=social&utm_content=20261106',
    );
    expect(linkQuery('?utm_campaign=知乎 {{date}}&utm_content={{id}}', 'a&b', now)).toBe(
      'utm_campaign=%E7%9F%A5%E4%B9%8E+20261106&utm_content=a%26b',
    );
    expect(linkQuery('', '1', now)).toBe('');
  });
  it('整理参数模板：去掉开头的 ?、空白与没有参数名的项，变量原样保留', () => {
    expect(normalizeLinkQuery('  ?utm_source=zhihu& &=x&&utm_content={{id}} ')).toBe(
      'utm_source=zhihu&utm_content={{id}}',
    );
    expect(normalizeLinkQuery(3)).toBe('');
  });
  it('对真实渲染结果生效：结尾与正文里的链接都加，其他链接不动', async () => {
    const prepared = await prepare(
      {
        markdown: '正文看下：https://example.org ，再看 [文档](https://docs.test)。',
        title: '',
        templates: { footer: '升级：https://example.org\n\n接口：https://app.example.com' },
      },
      {
        platform: 'zhihu',
        fixed: { header: false, footer: true },
        plainFixed: true,
        resolver: { resolve: async () => ({ kind: 'missing', reason: '无' }) },
      },
    );
    const config = normalizeConfig({ zhihu: { linkRef: { domains: ['example.org'] } } });
    const { html, count, query } = tagZhihuLinks(render(prepared).html, config, '42', new Date());
    expect(query).toBe('utm_source=zhihu&utm_medium=social&utm_content=42');
    expect(count).toBe(2);
    const tagged =
      'href="https://example.org/?utm_source=zhihu&amp;utm_medium=social&amp;utm_content=42">https://example.org<';
    expect(html.split(tagged)).toHaveLength(3);
    expect(html).toContain('href="https://docs.test"');
    expect(html).toContain('href="https://app.example.com"');
  });
});
describe('来源参数配置', () => {
  it('默认不加、参数是 UTM；读取时规范化域名，参数为空回到默认，旧版的 value 不再读取', () => {
    expect(defaultConfig().zhihu.linkRef).toEqual({ domains: [], query: DEFAULT_LINK_QUERY });
    expect(
      normalizeConfig({
        zhihu: {
          linkRef: {
            domains: ['https://WWW.Example.org/path', 'example.org', 'app.example.com:8080', 'bad', 3],
            query: '  ',
            value: 'zhihu_{{id}}',
          },
        },
      }).zhihu.linkRef,
    ).toEqual({ domains: ['example.org', 'app.example.com'], query: DEFAULT_LINK_QUERY });
    expect(normalizeConfig({ zhihu: { linkRef: { domains: 'example.org' } } }).zhihu.linkRef)
      .toEqual({ domains: [], query: DEFAULT_LINK_QUERY });
    expect(
      normalizeConfig({ zhihu: { linkRef: { query: '?utm_source=zh&utm_content={{id}}' } } }).zhihu
        .linkRef.query,
    ).toBe('utm_source=zh&utm_content={{id}}');
  });
  it('设置页的文本按逗号、空白与顿号拆分', () => {
    expect(parseDomains('example.org, app.example.com，example.net、 example.org')).toEqual([
      'example.org',
      'app.example.com',
      'example.net',
    ]);
    expect(parseDomains('')).toEqual([]);
  });
});
