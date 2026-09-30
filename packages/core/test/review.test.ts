import { it, expect } from 'vitest';
import { prepare, render, template, extractMarkdownTitle } from '../src/index';
import { replaceImageReference } from '../src/references';
const make = (markdown: string, platform: 'wechat' | 'zhihu' = 'wechat', title = '') =>
  prepare(
    { markdown, title },
    {
      platform,
      fixed: { header: false, footer: false },
      resolver: { resolve: async () => ({ kind: 'missing', reason: 'missing' }) },
    },
  );
it('分隔线之间的普通正文与错误 YAML 不得丢失', async () => {
  for (const source of ['---\n普通正文\n---\n# 标题', '---\nkey: [broken\n---\n正文'])
    expect(render(await make(source)).text).toContain(
      source.includes('普通正文') ? '普通正文' : 'broken',
    );
  expect(render(await make('---\ntitle: 元数据\n---\n正文')).text).not.toContain('元数据');
});
it('保留图片原始地址以精确补图，不混淆编码路径', async () => {
  for (const ref of ['图 片.png', '图.png', 'a%2Fb.png', 'a%b.png']) {
    const source = `![图](<${ref}>)\n\n![重复][asset]\n\n[asset]: <${ref}>`;
    const result = render(await make(source));
    expect(result.images[0].original).toBe(ref);
    expect(replaceImageReference(source, result.images[0].original, 'new.png')).not.toContain(
      `<${ref}>`,
    );
  }
});
it('脚注只有一层上标且不会产生清洗误报', async () => {
  for (const platform of ['wechat', 'zhihu'] as const) {
    const result = render(await make('正文[^1]\n\n[^1]: 注释正文', platform));
    expect(result.html).not.toMatch(/<sup[^>]*><sup/);
    expect(result.html).not.toContain('↩');
    expect(result.warnings.some((w) => w.code === 'HTML_STRIPPED')).toBe(false);
    if (platform === 'zhihu') expect(result.html).toContain('data-text="注释正文"');
    else expect(result.text).toContain('注释');
  }
});
it('模板原型键和尾部换行标题安全处理', async () => {
  expect(template('{{constructor}}', {})).toBe('');
  expect(await extractMarkdownTitle('# 标题<br>')).toBe('标题');
  expect(render(await make('# 标题<br>\n\n正文', 'wechat', '标题')).html).not.toContain('<h1');
});
it('链接及代码显式样式不能按祖先继承删除', async () => {
  const result = render(await make('## [链接](https://example.test)\n\n```js\nconst a = 1\n```'));
  expect(result.html).toMatch(/<a[^>]*style="[^"]*color:/);
  expect(result.html).toMatch(/<code[^>]*style="[^"]*font-family:/);
});

it('HTML 图片补图支持中文、实体及无引号地址', async () => {
  for (const source of [
    '<img src="图 片.png">',
    '<img src=图片.png>',
    '<img src="图&amp;片.png">',
  ]) {
    const result = render(await make(source));
    expect(replaceImageReference(source, result.images[0].original, 'new.png')).toBe(
      '<img src="new.png">',
    );
  }
});
it('编辑器私有写法只在正文文字里识别，代码里的 [[ 与 > [! 不算', async () => {
  const codes = async (source: string) => render(await make(source)).warnings.map((w) => w.code);
  expect(await codes('正文 [[双链]]')).toContain('UNSUPPORTED_SYNTAX');
  expect(await codes('> [!note] 标题\n> 内容')).toContain('UNSUPPORTED_SYNTAX');
  expect(await codes('```md\n[[双链]]\n> [!note]\n```\n\n行内 `![[a.png]]`')).not.toContain(
    'UNSUPPORTED_SYNTAX',
  );
  expect(await codes('普通引用\n\n> 引用 [!不是 callout]')).not.toContain('UNSUPPORTED_SYNTAX');
});
