import type { Platform, ThemeId } from '@jinzhang/core';
import { legacySamples } from './legacy-samples';
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
  // 浏览器里存着原样未改的旧版示例时换成当前示例，平台与排版设置保留；改过的稿子不动。
  const outdated = d.title === sampleTitle && legacySamples(origin).includes(d.markdown);
  return {
    markdown: outdated ? sampleMarkdown(origin) : d.markdown,
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
/** 示例稿是一份常用 Markdown 语法速览；配图跟随当前站点，本地与线上都能直接显示。 */
export function sampleMarkdown(origin: string) {
  return `# ${sampleTitle}

写完一篇文章，应该是松一口气的时刻，而不是另一场排版工作的开始。

这是一份常用 Markdown 语法的示例：左边是原文，右边是粘贴到平台后的样子。随手改几个字，或者清空后贴入你自己的文章，预览会立刻跟着变。

## 01 标题

用 \`#\` 的个数表示层级：一个 \`#\` 是文章标题，正文从 \`##\` 开始。

### 三级标题：小节

#### 四级标题：更细的层次

层级最好不超过三级，读者更容易跟上。知乎会把四级及更深的标题转成加粗段落。

## 02 段落与强调

段落之间空一行。同一段里直接换行会被合并成一行；想强制换行，在行尾加一个反斜杠：\\
像这样，另起一行但不分段。

**加粗**用来标出重点，*斜体*适合语气和术语，***加粗斜体***偶尔用一次就好，~~删除线~~表示改掉的想法。\`行内代码\`用来写命令、文件名或变量名，比如 \`pnpm dev\`。

链接写成 [锦章](https://jinzhang.ink) 这样；直接贴网址 https://jinzhang.ink 也会自动识别。公众号会去掉普通外链的地址、只留文字，重要的网址可以直接写出来。

## 03 引用

> 少一些来回复制，多一些认真表达。

> 引用里也可以有多个段落和列表：
>
> - 摘录别人的原话
> - 标出需要读者留意的提示
>
> 最后一段同样支持**加粗**与 \`代码\`。

## 04 列表

- 无序列表用短横线开头
- 缩进两个空格，就是下一级
  - 第二级条目
  - 层级不宜太深
- 条目之间不需要空行

1. 有序列表用数字加点
2. 编号按顺序排列
   - 有序列表里也能嵌套无序条目
3. 第三步

- [x] 任务列表：已完成
- [ ] 任务列表：待处理

## 05 代码

大段代码用三个反引号围起来，并注明语言，就会按语法着色；缩进会原样保留，过长时可以左右滑动：

\`\`\`typescript
// 一份原文，两种呈现
const article = await prepare(markdown);
const result = render(article, { theme: 'sspai' });
if (result.warnings.length > 0) {
  console.log(result.warnings);
}
\`\`\`

终端命令也一样：

\`\`\`bash
pnpm install && pnpm dev
\`\`\`

## 06 表格

用竖线分隔单元格，第二行里冒号的位置决定对齐：靠左、居中、靠右。

| 写法 | 效果 | 适合 |
| :--- | :---: | ---: |
| \`**文字**\` | **加粗** | 重点 |
| \`*文字*\` | *斜体* | 语气、术语 |
| \`~~文字~~\` | ~~删除线~~ | 改掉的想法 |
| \`\` \`文字\` \`\` | \`代码\` | 命令、变量 |

## 07 图片与分隔线

图片写成 \`![说明](图片地址)\`。也可以把图片直接粘贴或拖进左边的编辑区，或者点上方的「插入图片」。

![锦章示例配图](${origin}/sample-cover.jpg)

单独一行的三个短横线是分隔线，适合在同一篇文章里切换话题：

---

像这样，分隔线之后开始新的话题。

## 08 脚注

需要补充出处或解释时用脚注[^1]，正文保持干净；脚注会统一整理到文末[^2]。

## 写在最后

排版交给工具。写作的下一步，可以很轻。

[^1]: 正文里写 \`[^1]\`，文末写 \`[^1]: 内容\`。
[^2]: 公众号在文末列出「注释」，知乎会转成平台自带的参考文献。
`;
}
/** 首次打开（本浏览器没有保存过内容）时的文档：预置示例稿，让成品预览立刻可见。 */
export function initialDocument(origin: string): DocumentState {
  return { ...freshDocument(), markdown: sampleMarkdown(origin), title: sampleTitle };
}
