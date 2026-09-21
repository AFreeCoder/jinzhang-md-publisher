import type { Platform, ThemeId } from '@jinzhang/core';
export const STORAGE_KEY = 'jinzhang.document.v1';
export interface FixedContent {
  header: boolean;
  footer: boolean;
  headerStyle: string;
  footerStyle: string;
  author: string;
  slogan: string;
  closing: string;
  collection: string;
}
export interface DocumentState {
  markdown: string;
  title: string;
  theme: ThemeId;
  platform: Platform;
  fixed: Record<Platform, FixedContent>;
}
export function freshDocument(): DocumentState {
  const fixed = () => ({
    header: false,
    footer: false,
    headerStyle: '简约署名',
    footerStyle: '一句寄语',
    author: '',
    slogan: '',
    closing: '愿每一次认真表达，都被好好看见。',
    collection: '',
  });
  return {
    markdown: '',
    title: '',
    theme: 'sspai',
    platform: 'wechat',
    fixed: { wechat: fixed(), zhihu: fixed() },
  };
}
export function restoreDocument(raw: string | null, origin = ''): DocumentState {
  if (!raw) return initialDocument(origin);
  const d = JSON.parse(raw);
  if (
    !d ||
    typeof d.markdown !== 'string' ||
    typeof d.title !== 'string' ||
    !['wechat', 'zhihu'].includes(d.platform) ||
    !['sspai', 'native', 'mac'].includes(d.theme)
  )
    throw new Error('本地文档格式无效。');
  for (const platform of ['wechat', 'zhihu']) {
    const f = d.fixed?.[platform];
    if (
      !f ||
      typeof f.header !== 'boolean' ||
      typeof f.footer !== 'boolean' ||
      ['headerStyle', 'footerStyle', 'author', 'slogan', 'closing', 'collection'].some(
        (k) => typeof f[k] !== 'string',
      )
    )
      throw new Error('本地设置格式无效。');
  }
  return {
    markdown: d.markdown,
    title: d.title,
    theme: d.theme,
    platform: d.platform,
    fixed: d.fixed,
  };
}
export function normalizeCollectionLink(value: string): string | null {
  const input = value.trim();
  if (!input) return '';
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      /\s/.test(input) ||
      !url.hostname.includes('.')
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function templates(f: FixedContent) {
  const safe = (s: string) => s.replace(/[\\`*_{}[\]()#+.!<>|~=:$/?&@%,;"'-]/g, '\\$&');
  const link = normalizeCollectionLink(f.collection);
  const collection = link ? `\n[继续阅读](${link.replace(/[()\s]/g, encodeURIComponent)})` : '';
  return {
    header: `${f.headerStyle === '留白分隔' ? '---\n' : ''}${safe(f.author)}\n\n${safe(f.slogan)}`,
    footer: `${f.footerStyle === '细线落款' ? '---\n' : ''}${safe(f.closing)}${collection}`,
  };
}
export const sampleTitle = '把写作还给写作';
/** 示例稿覆盖常用 Markdown 语法；配图跟随当前站点，本地与线上都能直接显示。 */
export function sampleMarkdown(origin: string) {
  return `# ${sampleTitle}

写完一篇文章，应该是松一口气的时刻，而不是另一场排版工作的开始。

这份示例用到了常见的 Markdown 语法。改一改左边的原文，右边就是粘贴到平台后的样子。

## 01 文字与强调

**好的工具，应该把琐碎接过去**。正文里可以有*斜体的语气*、~~删掉的想法~~和 \`行内代码\`，也可以放一个[链接](https://jinzhang.ink)。

### 小标题用三级

标题层级建议控制在三级以内，读者更容易跟上。

## 02 引用

> 少一些来回复制，多一些认真表达。

> 引用可以有多段。
>
> 第二段同样支持**加粗**与 \`代码\`。

## 03 列表

- 在公众号，让样式与文字相得益彰
- 在知乎，让内容结构清楚完整
  - 嵌套条目会缩进显示
  - 层级不宜太深
- 发布之前，始终由你做最后的确认

1. 贴入 Markdown
2. 选择平台与主题
3. 复制到平台编辑器

- [x] 写完正文
- [ ] 检查排版

## 04 代码与表格

\`\`\`typescript
// 一份原文，两种呈现
const article = await prepare(markdown);
const result = render(article, { theme: 'sspai' });
\`\`\`

| 平台 | 呈现方式 | 图片 |
| :--- | :---: | ---: |
| 微信公众号 | 主题与样式 | 随正文内嵌 |
| 知乎 | 内容结构 | 平台自动转存 |

## 05 图片、分隔线与脚注

![锦章示例配图](${origin}/sample-cover.jpg)

---

写作的下一步，可以很轻[^1]。

[^1]: 脚注会整理到文末的「注释」里。
`;
}
/** 首次打开（本浏览器没有保存过内容）时的文档：预置示例稿，让成品预览立刻可见。 */
export function initialDocument(origin: string): DocumentState {
  return { ...freshDocument(), markdown: sampleMarkdown(origin), title: sampleTitle };
}
