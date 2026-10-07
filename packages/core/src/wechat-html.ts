import * as css from 'css-tree';
import type { Element } from 'hast';
import type { WechatCard } from './types';
// 公众号成品的结构后处理：代码块圆点、表格属性、去掉与根容器重复的文字声明、名片。
// 做法取自 my-toolbox 的 applyTheme 与 makeWeChatDomCompatible，在 hast 上实现，不依赖 DOM。
type Declarations = Map<string, { value: string; important: boolean }>;
const element = (
  tagName: string,
  children: Element['children'] = [],
  properties: Element['properties'] = {},
): Element => ({ type: 'element', tagName, properties, children });
function read(node: Element): Declarations {
  const declarations: Declarations = new Map();
  const style = node.properties.style;
  if (typeof style !== 'string' || !style) return declarations;
  css.walk(css.parse(style, { context: 'declarationList' }), (d) => {
    if (d.type === 'Declaration')
      declarations.set(d.property, { value: css.generate(d.value), important: !!d.important });
  });
  return declarations;
}
function write(node: Element, declarations: Declarations) {
  if (declarations.size)
    node.properties.style = [...declarations]
      .map(([name, d]) => `${name}:${d.value}${d.important ? '!important' : ''}`)
      .join(';');
  else delete node.properties.style;
}
/** 代码块顶部的红黄绿圆点，放在 `pre` 的最前面。 */
export function codeDots(): Element {
  const dot = (color: string, last = false) =>
    element('span', [], {
      style: `display:inline-block;width:12px;height:12px;border-radius:50%;background:${color}${last ? '' : ';margin-right:6px'}`,
    });
  return element('section', [dot('#ff5f56'), dot('#ffbd2e'), dot('#27c93f', true)], {
    style: 'margin-bottom:12px;white-space:nowrap',
  });
}
const TABLE_COLUMN_MIN_WIDTH = 140;
const HEX = /#[0-9a-f]{3,8}\b/i;
/**
 * 表格逐格内联样式又长又重复：把主题给单元格的边框、内边距、表头底色与对齐读出来，
 * 写成表格属性，单元格自身不再带样式。外边距留在 `table` 上，由滚动容器接走。
 */
export function compactTable(table: Element) {
  const headers: Element[] = [];
  const body: Element[] = [];
  const rows: Element[] = [];
  const codes: Element[] = [];
  const collect = (parent: Element, inPre: boolean) => {
    for (const node of parent.children) {
      if (node.type !== 'element') continue;
      if (node.tagName === 'th') headers.push(node);
      else if (node.tagName === 'td') body.push(node);
      else if (node.tagName === 'tr') rows.push(node);
      else if (node.tagName === 'code' && !inPre) codes.push(node);
      collect(node, inPre || node.tagName === 'pre');
    }
  };
  collect(table, false);
  const cells = [...headers, ...body];
  const styles = new Map(cells.map((cell) => [cell, read(cell)]));
  const first = (list: Element[], pick: (d: Declarations) => string | undefined) => {
    for (const cell of list) {
      const value = pick(styles.get(cell)!);
      if (value) return value;
    }
    return '';
  };
  const pixels = (value: string, fallback: number) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
  };
  const borderColor =
    first(cells, (d) => (d.get('border-color') ?? d.get('border'))?.value.match(HEX)?.[0]) ||
    '#e0e0e0';
  const borderWidth = pixels(
    first(cells, (d) => (d.get('border-width') ?? d.get('border'))?.value.match(/[\d.]+px/)?.[0]),
    1,
  );
  const padding = pixels(
    first(cells, (d) => (d.get('padding-top') ?? d.get('padding'))?.value.split(' ')[0]),
    12,
  );
  const headBackground =
    first(
      headers,
      (d) => (d.get('background-color') ?? d.get('background'))?.value.match(HEX)?.[0],
    ) || '#f5f5f7';
  const align = first(headers, (d) => d.get('text-align')?.value);
  const color =
    first(body, (d) => d.get('color')?.value) || first(cells, (d) => d.get('color')?.value);
  const own = read(table);
  const columns = rows[0]?.children.filter((c) => c.type === 'element').length || 1;
  const next: Declarations = new Map();
  const set = (name: string, value: string | undefined) => {
    if (value) next.set(name, { value, important: false });
  };
  set('width', '100%');
  for (const [name, d] of own) if (/^margin(-top|-bottom)?$/.test(name)) next.set(name, d);
  set('border-collapse', 'collapse');
  set('font-size', own.get('font-size')?.value);
  set('table-layout', 'fixed');
  set('min-width', `${columns * TABLE_COLUMN_MIN_WIDTH}px`);
  set('color', color);
  set('white-space', 'normal');
  set('word-break', 'normal');
  set('overflow-wrap', 'anywhere');
  write(table, next);
  Object.assign(table.properties, {
    border: borderWidth,
    cellPadding: String(padding),
    cellSpacing: '0',
    borderColor,
  });
  for (const node of [...rows, ...cells]) delete node.properties.style;
  for (const header of headers) {
    if (align && !header.properties.align) header.properties.align = align;
    header.properties.bgColor = headBackground;
  }
  // 行内代码保持整体不拆行，其余装饰随单元格样式一起省掉。
  for (const code of codes) code.properties.style = 'white-space:nowrap';
}
const INHERITED = ['font-family', 'font-size', 'line-height', 'color'];
const TEXT_NODE = /^(p|li|h[1-6]|blockquote|span)$/;
/**
 * 文字节点上与根容器相同、且沿途没有被祖先改写的字体、字号、行高、颜色不再重复声明，
 * 交给继承；链接、行内代码与高亮片段不动。标题的字号不算重复：浏览器给标题自带字号，
 * 删掉后 h5、h6 会缩成小字。
 */
export function dropInherited(root: Element) {
  const base = read(root);
  const walk = (parent: Element, chain: Declarations[], inCode: boolean) => {
    for (const node of parent.children) {
      if (node.type !== 'element') continue;
      const own = read(node);
      if (TEXT_NODE.test(node.tagName) && !(node.tagName === 'span' && inCode)) {
        let changed = false;
        for (const property of INHERITED) {
          if (property === 'font-size' && /^h[1-6]$/.test(node.tagName)) continue;
          const rootValue = base.get(property)?.value;
          if (!rootValue || own.get(property)?.value !== rootValue) continue;
          let inherited: string | undefined;
          for (let i = chain.length - 1; i >= 0 && inherited === undefined; i--)
            inherited = chain[i].get(property)?.value;
          if (inherited !== rootValue) continue;
          own.delete(property);
          changed = true;
        }
        if (changed) write(node, own);
      }
      walk(node, [...chain, own], inCode || node.tagName === 'pre' || node.tagName === 'code');
    }
  };
  walk(root, [base], false);
}
/** 名片是公众号编辑器识别的原生组件，类名与 data-* 必须原样保留，属性清理时按 `data.keepAttributes` 跳过。 */
export function wechatCard(card: WechatCard): Element {
  const keep = (node: Element) => ({ ...node, data: { keepAttributes: true } });
  return keep(
    element(
      'section',
      [
        keep(
          element('mp-common-profile', [], {
            className: ['mpprofile', 'js_uneditable', 'custom_select_card', 'mp_profile_iframe'],
            dataPluginname: 'mpprofile',
            dataId: card.mpId,
            dataNickname: card.nickname,
            dataHeadimg: card.headImg,
            dataSignature: card.signature,
            dataService_type: String(card.serviceType),
            dataVerify_status: String(card.verifyStatus),
          }),
        ),
        keep(element('br', [], { className: ['ProseMirror-trailingBreak'] })),
      ],
      { className: ['mp_profile_iframe_wrp', 'custom_select_card_wrp'], nodeleaf: '' },
    ),
  );
}
export const hasCard = (card: WechatCard | null | undefined): card is WechatCard =>
  !!card?.mpId && !!card.nickname;
