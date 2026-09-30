import { describe, expect, it } from 'vitest';
import { getFrontMatterInfo } from 'obsidian';
import { fileRef, localFileRef, preprocessObsidian, vaultRef } from '../src/obsidian-markdown';
const vault: Record<string, string> = {
  'a.png': 'assets/a.png',
  '图 片.png': 'assets/图 片.png',
  'b(1).png': 'b(1).png',
  笔记: '笔记.md',
};
const run = (content: string, contentStart = 0) =>
  preprocessObsidian(content, {
    contentStart,
    resolveEmbed: (link) => {
      const path = vault[link];
      return path ? { path, isImage: !path.endsWith('.md') } : null;
    },
  });
describe('属性区', () => {
  it('按编辑器文本的 contentStart 去掉属性区，连续增删属性行后正文不丢', () => {
    let content = '---\ntags: [a]\n---\n# 正文\n\n第一段';
    for (const line of ['title: x', 'aliases: [y]', 'cssclasses: z']) {
      content = content.replace('---\n# 正文', `${line}\n---\n# 正文`);
      const out = run(content, getFrontMatterInfo(content).contentStart).markdown;
      expect(out).toBe('# 正文\n\n第一段');
      content = content.replace(`${line}\n`, '');
      expect(run(content, getFrontMatterInfo(content).contentStart).markdown).toBe(
        '# 正文\n\n第一段',
      );
    }
    expect(run('没有属性区的正文').markdown).toBe('没有属性区的正文');
  });
});
describe('Obsidian 私有写法', () => {
  it('%%注释%% 整段删除，可跨行，未闭合时注释到文末；代码里的 %% 不动', () => {
    expect(run('前%%给自己的话%%后').markdown).toBe('前后');
    expect(run('第一段\n\n%%\n多行\n注释\n%%\n\n第二段').markdown).toBe('第一段\n\n\n\n第二段');
    expect(run('`a %% b` 与 %%注释%%').markdown).toBe('`a %% b` 与 ');
    expect(run('```\n%% 代码 %%\n```\n\n正文 %%没写完').markdown).toBe(
      '```\n%% 代码 %%\n```\n\n正文 ',
    );
  });
  it('图片嵌入按 vault 路径改写，宽度丢弃，找不到时改成标准写法交给 core 报缺图', () => {
    expect(run('![[a.png]]').markdown).toBe(`![](<${vaultRef('assets/a.png')}>)`);
    expect(run('![[a.png|300]]').markdown).toBe(`![](<${vaultRef('assets/a.png')}>)`);
    expect(run('![[a.png|示意图]]').markdown).toBe(`![示意图](<${vaultRef('assets/a.png')}>)`);
    expect(run('![[图 片.png]]').markdown).toBe(
      '![](<jz-local://vault/assets/%E5%9B%BE%20%E7%89%87.png>)',
    );
    expect(run('![[b(1).png]]').markdown).toBe('![](<jz-local://vault/b(1).png>)');
    expect(run('![[缺.png]]').markdown).toBe('![](<缺.png>)');
  });
  it('嵌入笔记不展开并警告，双链只留显示文字', () => {
    const embed = run('![[笔记#小节]]');
    expect(embed.markdown).toBe('嵌入笔记：笔记 > 小节');
    expect(embed.warnings).toEqual([expect.objectContaining({ code: 'OBSIDIAN_EMBED' })]);
    expect(run('见 [[笔记]]、[[笔记|别名]]、[[笔记#标题]]、[[笔记#^块]]').markdown).toBe(
      '见 笔记、别名、笔记 > 标题、笔记',
    );
    expect(run('| 列 |\n| - |\n| [[笔记\\|别名]] |').markdown).toBe('| 列 |\n| - |\n| 别名 |');
  });
  it('代码块与行内代码里的写法原样保留', () => {
    const source =
      '```md\n![[a.png]] [[笔记]] > [!note]\n```\n\n    [[缩进代码]]\n\n行内 `[[笔记]]`';
    expect(run(source).markdown).toBe(source);
  });
  it('callout 转成普通引用，首行标题加粗，标题里的双链照常转换', () => {
    expect(run('> [!tip] 小技巧\n> 正文').markdown).toBe('> **小技巧**\n> 正文');
    expect(run('> [!warning]-\n> 折叠').markdown).toBe('> **Warning**\n> 折叠');
    expect(run('> [!note] 参见 [[笔记|别名]]').markdown).toBe('> **参见 别名**');
    expect(run('> > [!info] 嵌套').markdown).toBe('> > **嵌套**');
  });
  it('file:// 地址与盘符路径改写成 jz-local://file/…，远程与相对路径不动', () => {
    expect(run('![图](file:///Users/me/图片/a%20b.png "标题")').markdown).toBe(
      `![图](<${fileRef('/Users/me/图片/a b.png')}> "标题")`,
    );
    expect(localFileRef('file:///Users/me/a%20b.png')).toBe('jz-local://file/Users/me/a%20b.png');
    expect(localFileRef('C:\\Users\\me\\a.png')).toBe('jz-local://file/C%3A/Users/me/a.png');
    expect(localFileRef('file:///C:/Users/me/a.png')).toBe('jz-local://file/C%3A/Users/me/a.png');
    expect(run('<img src="file:///tmp/a.png" width="10">').markdown).toBe(
      '<img src="jz-local://file/tmp/a.png" width="10">',
    );
    expect(run('![x][ref]\n\n[ref]: C:/pics/a.png').markdown).toBe(
      '![x][ref]\n\n[ref]: <jz-local://file/C%3A/pics/a.png>',
    );
    const untouched = '![远程](https://example.test/a.png)\n\n![相对](../assets/a.png)';
    expect(run(untouched).markdown).toBe(untouched);
  });
  it('注释里的图片与双链随注释一起删除', () => {
    expect(run('前 %%![[a.png]] [[笔记]] ![](file:///a.png)%% 后').markdown).toBe('前  后');
  });
});
