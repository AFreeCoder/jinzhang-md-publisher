import {
  DEFAULT_LINK_QUERY,
  linkQuery,
  normalizeLinkQuery,
  parseDomains,
  tagLinks,
  type Platform,
  type ThemeId,
} from '@jinzhang/core';
export const STORAGE_KEY = 'jinzhang.document.v1';
/** 开头结尾与链接来源参数是长期设置，单独保存，不随原文 1 天清理；「清除」时一并删除。 */
export const SETTINGS_KEY = 'jinzhang.settings.v1';
/** 已下线的上一稿备份，打开页面时删除。 */
export const LEGACY_PREVIOUS_KEY = 'jinzhang.previous-article.v1';
/** 网页只是临时排版：当前原文暂存在本浏览器供刷新恢复，从最后一次修改起保留 1 天。 */
export const STORAGE_TTL = 24 * 3600_000;
export const DEFAULT_CLOSING = '愿每一次认真表达，都被好好看见。';
export interface FixedContent {
  header: boolean;
  footer: boolean;
  headerStyle: string;
  author: string;
  slogan: string;
  /** 结尾按 Markdown 排版，与插件一致；可用 `{{date}}`、`{{author}}`。 */
  footerMarkdown: string;
}
/** 复制到知乎时给链接加的来源参数；按输入原样保存，用的时候再整理。 */
export interface LinkRefSettings {
  domains: string;
  query: string;
}
export interface Settings {
  fixed: Record<Platform, FixedContent>;
  linkRef: LinkRefSettings;
}
export interface DocumentState extends Settings {
  markdown: string;
  title: string;
  theme: ThemeId;
  platform: Platform;
  /** 原文或设置最后一次修改的时间，毫秒时间戳。 */
  updatedAt: number;
}
export type ArticleState = Omit<DocumentState, keyof Settings>;
export function freshSettings(): Settings {
  const fixed = (): FixedContent => ({
    header: false,
    footer: false,
    headerStyle: '简约署名',
    author: '',
    slogan: '',
    footerMarkdown: DEFAULT_CLOSING,
  });
  return {
    fixed: { wechat: fixed(), zhihu: fixed() },
    linkRef: { domains: '', query: DEFAULT_LINK_QUERY },
  };
}
export function freshDocument(now = Date.now()): DocumentState {
  return {
    markdown: '',
    title: '',
    theme: 'sspai',
    platform: 'wechat',
    ...freshSettings(),
    updatedAt: now,
  };
}
const PLATFORM_KEYS = ['wechat', 'zhihu'] as const;
function parse(raw: string | null) {
  try {
    return JSON.parse(raw || 'null');
  } catch {
    return null;
  }
}
const isText = (value: unknown): value is string => typeof value === 'string';
/** 表单里的文字按字面输出：转义 Markdown 标点。 */
const safe = (s: string) => s.replace(/[\\`*_{}[\]()#+.!<>|~=:$/?&@%,;"'-]/g, '\\$&');
/** 读取暂存的原文；没有、格式无效、超过 1 天或是旧版本留下的（没有时间戳）都返回 null。 */
export function restoreDocument(raw: string | null, now = Date.now()): ArticleState | null {
  const d = parse(raw);
  if (
    !d ||
    !isText(d.markdown) ||
    !isText(d.title) ||
    !PLATFORM_KEYS.includes(d.platform) ||
    !['sspai', 'native', 'mac'].includes(d.theme) ||
    !Number.isFinite(d.updatedAt) ||
    now - d.updatedAt >= STORAGE_TTL
  )
    return null;
  return {
    markdown: d.markdown,
    title: d.title,
    theme: d.theme,
    platform: d.platform,
    updatedAt: d.updatedAt,
  };
}
/** 旧版结尾是「寄语 + 落款样式 + 合集链接」表单，换成排版结果相同的 Markdown。 */
function legacyFooter(f: Record<string, unknown>) {
  const link = normalizeCollectionLink(isText(f.collection) ? f.collection : '');
  const collection = link ? `\n[继续阅读](${link.replace(/[()\s]/g, encodeURIComponent)})` : '';
  const closing = isText(f.closing) ? f.closing : '';
  return `${f.footerStyle === '细线落款' ? '---\n' : ''}${safe(closing)}${collection}`;
}
function readFixed(f: unknown, legacy: boolean): FixedContent | null {
  if (!f || typeof f !== 'object') return null;
  const v = f as Record<string, unknown>;
  if (
    typeof v.header !== 'boolean' ||
    typeof v.footer !== 'boolean' ||
    !isText(v.headerStyle) ||
    !isText(v.author) ||
    !isText(v.slogan)
  )
    return null;
  const footerMarkdown = legacy ? legacyFooter(v) : v.footerMarkdown;
  if (!isText(footerMarkdown)) return null;
  return {
    header: v.header,
    footer: v.footer,
    headerStyle: v.headerStyle,
    author: v.author,
    slogan: v.slogan,
    footerMarkdown,
  };
}
function readAllFixed(fixed: unknown, legacy: boolean) {
  const result = {} as Record<Platform, FixedContent>;
  for (const platform of PLATFORM_KEYS) {
    const f = readFixed((fixed as Record<string, unknown> | null)?.[platform], legacy);
    if (!f) return null;
    result[platform] = f;
  }
  return result;
}
/**
 * 读取长期设置；没有时从 1 天内的旧版暂存里迁移开头结尾（旧版设置跟原文存在一起），
 * 再没有返回 null。
 */
export function restoreSettings(
  raw: string | null,
  legacyDocument: string | null = null,
  now = Date.now(),
): Settings | null {
  const s = parse(raw);
  const fixed = s && readAllFixed(s.fixed, false);
  if (fixed && isText(s.linkRef?.domains) && isText(s.linkRef?.query))
    return { fixed, linkRef: { domains: s.linkRef.domains, query: s.linkRef.query } };
  if (s || !restoreDocument(legacyDocument, now)) return null;
  const old = readAllFixed(parse(legacyDocument).fixed, true);
  return old && { fixed: old, linkRef: freshSettings().linkRef };
}
export function articlePart({ fixed: _f, linkRef: _l, ...article }: DocumentState): ArticleState {
  return article;
}
export function settingsPart({ fixed, linkRef }: DocumentState): Settings {
  return { fixed, linkRef };
}
/** 复制到知乎时按设置给链接加来源参数：网页拿不到知乎文章 ID，`{{id}}` 用当天日期代替。 */
export function tagCopyLinks(html: string, settings: LinkRefSettings, now = new Date()) {
  const query = normalizeLinkQuery(settings.query) || DEFAULT_LINK_QUERY;
  return tagLinks(html, parseDomains(settings.domains), linkQuery(query, undefined, now));
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
  return {
    header: `${f.headerStyle === '留白分隔' ? '---\n' : ''}${safe(f.author)}\n\n${safe(f.slogan)}`,
    footer: f.footerMarkdown,
  };
}
/** 交给 core 的开头结尾开关：结尾是空的就不加。 */
export function fixedFlags(f: FixedContent) {
  return { header: f.header, footer: f.footer && !!f.footerMarkdown.trim() };
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
/** 没有可用暂存（首次打开、超过 1 天或清除后）时的原文：预置示例稿，让成品预览立刻可见。 */
export function initialDocument(origin: string): DocumentState {
  return { ...freshDocument(), markdown: sampleMarkdown(origin), title: sampleTitle };
}
