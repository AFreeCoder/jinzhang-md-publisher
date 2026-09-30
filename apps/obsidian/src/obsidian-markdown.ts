import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Warning } from '@jinzhang/core';
/** 嵌入的解析结果：vault 内路径与是否为图片。 */
export interface EmbedTarget {
  path: string;
  isImage: boolean;
}
export interface PreprocessOptions {
  /** 属性区结束的位置（`getFrontMatterInfo(content).contentStart`），没有属性区为 0。 */
  contentStart: number;
  /** 按 Obsidian 链接规则解析 `![[…]]` 的目标，找不到返回 null。 */
  resolveEmbed(linkpath: string): EmbedTarget | null;
}
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?)$/i;
/** 每段路径分别编码，嵌进 `<…>` 目标里也不会被尖括号、空格、括号截断。 */
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
export const vaultRef = (path: string) => `jz-local://vault/${encodePath(path)}`;
export const fileRef = (absPath: string) =>
  `jz-local://file/${encodePath(absPath.replace(/\\/g, '/').replace(/^\/+/, ''))}`;
/** `file://` 与 Windows 盘符路径会被 core 当成未放行的协议清掉，改写为 jz-local://file/…。 */
export function localFileRef(url: string) {
  if (/^[a-z]:[\\/]/i.test(url)) return fileRef(url);
  if (!/^file:\/\//i.test(url)) return undefined;
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    return fileRef(/^\/[a-z]:\//i.test(path) ? path.slice(1) : path);
  } catch {
    return undefined;
  }
}
interface Edit {
  start: number;
  end: number;
  value: string;
}
const overlaps = (ranges: [number, number][], start: number, end: number) =>
  ranges.some(([a, b]) => start < b && end > a);
function splitTarget(raw: string) {
  const [target, ...rest] = raw.split(/\\?\|/);
  return { target: target.trim(), alias: rest.join('|').trim() };
}
/** Obsidian 链接的显示文字：别名优先；标题链接显示为「笔记 > 标题」，块引用只留笔记名。 */
function displayText(raw: string) {
  const { target, alias } = splitTarget(raw);
  if (alias) return alias;
  const [note, ...sub] = target.split('#');
  const heading = sub.join('#').trim();
  if (!heading || heading.startsWith('^')) return note.trim();
  return note.trim() ? `${note.trim()} > ${heading}` : heading;
}
function imageMarkdown(alt: string, url: string, title?: string | null) {
  const safeAlt = alt.replace(/[[\]\\]/g, '\\$&');
  const safeTitle = title ? ` "${title.replace(/["\\]/g, '\\$&')}"` : '';
  return `![${safeAlt}](<${url}>${safeTitle})`;
}
/**
 * 把 Obsidian 的私有写法转成 core 认得的标准 Markdown（设计第 4 节）。只改写引用、不读文件；
 * 按语法位置进行，代码块与行内代码里的内容不动。
 */
export function preprocessObsidian(content: string, options: PreprocessOptions) {
  const source = content.slice(options.contentStart);
  const warnings: Warning[] = [];
  const tree = fromMarkdown(source);
  const code: [number, number][] = [];
  const nodes: any[] = [];
  const walk = (node: any) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ((node.type === 'code' || node.type === 'inlineCode') && start !== undefined)
      code.push([start, end]);
    if (['image', 'definition', 'html'].includes(node.type)) nodes.push(node);
    node.children?.forEach(walk);
  };
  walk(tree);
  const inCode = (index: number) => code.some(([a, b]) => index >= a && index < b);
  // %%注释%%：开头与结尾都要在代码之外；没有结尾时注释到文末，与 Obsidian 一致。
  const comments: [number, number][] = [];
  const marks: number[] = [];
  for (const match of source.matchAll(/%%/g)) if (!inCode(match.index)) marks.push(match.index);
  for (let i = 0; i < marks.length; i += 2)
    comments.push([marks[i], i + 1 < marks.length ? marks[i + 1] + 2 : source.length]);
  const blocked = [...code, ...comments];
  const edits: Edit[] = comments.map(([start, end]) => ({ start, end, value: '' }));
  for (const match of source.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlaps(blocked, start, end)) continue;
    if (!match[1]) {
      edits.push({ start, end, value: displayText(match[2]) });
      continue;
    }
    const { target, alias } = splitTarget(match[2]);
    const linkpath = target.split('#')[0].trim();
    const found = options.resolveEmbed(linkpath);
    if (found?.isImage || (!found && IMAGE_EXTENSION.test(linkpath))) {
      // 宽度参数丢弃；非尺寸的别名作为替代文字。找不到时保留原引用，由 core 报缺图。
      const alt = /^\d+(x\d+)?$/.test(alias) ? '' : alias;
      edits.push({
        start,
        end,
        value: imageMarkdown(alt, found ? vaultRef(found.path) : linkpath),
      });
      continue;
    }
    const name = displayText(match[2]);
    edits.push({ start, end, value: `嵌入笔记：${name}` });
    warnings.push({
      code: 'OBSIDIAN_EMBED',
      message: `嵌入的笔记不会展开，已替换为文字：${name}`,
      ref: match[0],
    });
  }
  // callout：首行 `> [!type] 标题` 转成普通引用，标题加粗；没写标题时用类型名。
  for (const match of source.matchAll(/^([ \t]*(?:>[ \t]?)+)\[!([\w-]+)\][+-]?[ \t]*(.*)$/gm)) {
    const marker = match.index + match[1].length;
    const end = match.index + match[0].length;
    if (overlaps(blocked, marker, end)) continue;
    const title = match[3].trimEnd();
    if (!title) {
      edits.push({
        start: marker,
        end,
        value: `**${match[2].charAt(0).toUpperCase()}${match[2].slice(1)}**`,
      });
      continue;
    }
    // 只替换标记并在标题两端加粗，标题里的双链等写法照常转换。
    const titleEnd = end - (match[3].length - title.length);
    edits.push({ start: marker, end: end - match[3].length, value: '**' });
    edits.push({ start: titleEnd, end: titleEnd, value: '**' });
  }
  for (const node of nodes) {
    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (overlaps(comments, start, end)) continue;
    if (node.type === 'html') {
      const value = String(node.value).replace(
        /(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
        (all, prefix, a, b, c) => {
          const rewritten = localFileRef(a ?? b ?? c);
          return rewritten ? `${prefix}"${rewritten}"` : all;
        },
      );
      if (value !== node.value) edits.push({ start, end, value });
      continue;
    }
    const rewritten = localFileRef(node.url);
    if (!rewritten) continue;
    edits.push({
      start,
      end,
      value:
        node.type === 'image'
          ? imageMarkdown(node.alt ?? '', rewritten, node.title)
          : `[${node.label ?? node.identifier}]: <${rewritten}>${node.title ? ` "${node.title.replace(/["\\]/g, '\\$&')}"` : ''}`,
    });
  }
  let markdown = source;
  let last = Infinity;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    // 与已应用的改写重叠的（比如注释里的图片）跳过。
    if (edit.end > last) continue;
    markdown = markdown.slice(0, edit.start) + edit.value + markdown.slice(edit.end);
    last = edit.start;
  }
  return { markdown, warnings };
}
