/** 预览跟随编辑器滚动（设计第 5 节）：两边都有的标题做锚点，锚点之间按行号线性插值。 */
export interface Anchor {
  line: number;
  y: number;
}
export interface SourceOutline {
  /** 正文第一行（属性区之后），从 0 起。 */
  first: number;
  last: number;
  headings: { line: number; key: string }[];
}
/** 去掉链接地址、wiki 链接目标与一切标点空白，只留文字与数字，用来比对源码标题与渲染后的标题。 */
export function headingKey(text: string) {
  return text
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}
/** 源码里的 ATX 标题及其行号，跳过属性区与代码块；`contentStart` 是属性区之后正文的字符偏移。 */
export function sourceOutline(text: string, contentStart = 0): SourceOutline {
  const lines = text.split('\n');
  const first = text.slice(0, contentStart).split('\n').length - 1;
  const headings: SourceOutline['headings'] = [];
  let fence = '';
  for (let line = first; line < lines.length; line++) {
    const raw = lines[line];
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = '';
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (open) {
      fence = open;
      continue;
    }
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(raw);
    const key = heading ? headingKey(heading[1]) : '';
    if (key) headings.push({ line, key });
  }
  return { first, last: lines.length - 1, headings };
}
/**
 * 按顺序把源码标题对到预览标题上（文字相同才算，对不上的跳过），首尾补上正文开头与文末。
 * `targets` 是预览里各标题的文字与纵向位置，`max` 是预览能滚到的最大位置。
 */
export function buildAnchors(
  outline: SourceOutline,
  targets: { key: string; y: number }[],
  max: number,
): Anchor[] {
  const anchors: Anchor[] = [{ line: outline.first, y: 0 }];
  let from = 0;
  for (const heading of outline.headings) {
    const index = targets.findIndex((target, i) => i >= from && target.key === heading.key);
    if (index < 0) continue;
    from = index + 1;
    const previous = anchors[anchors.length - 1];
    const y = Math.min(max, targets[index].y);
    if (heading.line > previous.line && y >= previous.y) anchors.push({ line: heading.line, y });
  }
  if (outline.last > anchors[anchors.length - 1].line) anchors.push({ line: outline.last, y: max });
  return anchors;
}
/** 编辑器顶部所在行（可带小数）换算成预览的滚动位置。 */
export function scrollTarget(line: number, anchors: Anchor[]) {
  let i = 0;
  while (i < anchors.length - 2 && anchors[i + 1].line <= line) i++;
  const a = anchors[i];
  const b = anchors[i + 1];
  if (!b) return a.y;
  const t = Math.min(1, Math.max(0, (line - a.line) / (b.line - a.line)));
  return a.y + t * (b.y - a.y);
}
