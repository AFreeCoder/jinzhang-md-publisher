import { describe, expect, it } from 'vitest';
import {
  compactDate,
  defaultConfig,
  linkRefValue,
  normalizeConfig,
  parseDomains,
  tagLinks,
  tagZhihuLinks,
} from '../../src/publish';
import { prepare, render } from '../../src/index';
const DOMAINS = ['example.org'];
const tag = (html: string, domains = DOMAINS) => tagLinks(html, domains, 'zhihu_123');
describe('链接来源标记', () => {
  it('只改 href，显示的文字不动；没有路径时补斜杠', () => {
    expect(tag('<p>见：<a href="https://example.org">https://example.org</a></p>')).toEqual({
      html: '<p>见：<a href="https://example.org/?ref=zhihu_123">https://example.org</a></p>',
      count: 1,
    });
  });
  it('保留原有路径、参数与锚点，ref 追加在最后；http 与子域名同样处理', () => {
    const { html, count } = tag(
      [
        '<a href="https://example.org/pricing?utm_source=x&#x26;a=%E4%B8%AD#faq">价格</a>',
        '<a href="http://www.example.org/a">a</a>',
        '<a href="https://app.example.org">b</a>',
      ].join(''),
    );
    expect(count).toBe(3);
    expect(html).toContain(
      'href="https://example.org/pricing?utm_source=x&amp;a=%E4%B8%AD&amp;ref=zhihu_123#faq"',
    );
    expect(html).toContain('href="http://www.example.org/a?ref=zhihu_123"');
    expect(html).toContain('href="https://app.example.org/?ref=zhihu_123"');
  });
  it('已带 ref 的不动，处理两次结果相同', () => {
    const own = '<a href="https://example.org/?ref=other">x</a>';
    expect(tag(own)).toEqual({ html: own, count: 0 });
    const once = tag('<a href="https://example.org">x</a>').html;
    expect(tag(once)).toEqual({ html: once, count: 0 });
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
    expect(html).toContain('data-url="https://example.org/a?ref=zhihu_123"');
  });
  it('域名或标记为空时原样返回', () => {
    const html = '<a href="https://example.org">x</a>';
    expect(tagLinks(html, [], 'zhihu_1')).toEqual({ html, count: 0 });
    expect(tagLinks(html, DOMAINS, '')).toEqual({ html, count: 0 });
  });
  it('多个域名：配上第二个域名才处理它', () => {
    const html = '<a href="https://example.org">a</a><a href="http://app.example.com">b</a>';
    expect(tag(html).count).toBe(1);
    const both = tag(html, ['example.org', 'example.com']);
    expect(both.count).toBe(2);
    expect(both.html).toContain('href="http://app.example.com/?ref=zhihu_123"');
  });
  it('标记模板：{{id}} 用文章 ID，拿不到时用日期；{{date}} 是 YYYYMMDD', () => {
    const now = new Date(2026, 10, 6, 9, 30);
    expect(compactDate(now)).toBe('20261106');
    expect(linkRefValue('zhihu_afc_{{id}}', '2101121274567210869', now)).toBe(
      'zhihu_afc_2101121274567210869',
    );
    expect(linkRefValue('zhihu_afc_{{id}}', undefined, now)).toBe('zhihu_afc_20261106');
    expect(linkRefValue('zh_{{date}}_{{id}}', '9', now)).toBe('zh_20261106_9');
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
    const config = normalizeConfig({
      zhihu: { linkRef: { domains: ['example.org'], value: 'zhihu_afc_{{id}}' } },
    });
    const { html, count, ref } = tagZhihuLinks(render(prepared).html, config, '42', new Date());
    expect(ref).toBe('zhihu_afc_42');
    expect(count).toBe(2);
    expect(html.match(/href="https:\/\/example\.org\/\?ref=zhihu_afc_42">https:\/\/example\.org</g))
      .toHaveLength(2);
    expect(html).toContain('href="https://docs.test"');
    expect(html).toContain('href="https://app.example.com"');
  });
});
describe('来源标记配置', () => {
  it('默认不加；读取时规范化域名，标记为空回到默认', () => {
    expect(defaultConfig().zhihu.linkRef).toEqual({ domains: [], value: 'zhihu_{{id}}' });
    expect(
      normalizeConfig({
        zhihu: {
          linkRef: {
            domains: ['https://WWW.Example.org/path', 'example.org', 'app.example.com:8080', 'bad', 3],
            value: '  ',
          },
        },
      }).zhihu.linkRef,
    ).toEqual({ domains: ['example.org', 'app.example.com'], value: 'zhihu_{{id}}' });
    expect(normalizeConfig({ zhihu: { linkRef: { domains: 'example.org' } } }).zhihu.linkRef)
      .toEqual({ domains: [], value: 'zhihu_{{id}}' });
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
