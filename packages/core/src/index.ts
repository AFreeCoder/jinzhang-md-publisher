import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkDirective from 'remark-directive';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options } from 'rehype-sanitize';
import { visit } from 'unist-util-visit';
import { toHtml } from 'hast-util-to-html';
import { toText } from 'hast-util-to-text';
import { common, createLowlight } from 'lowlight';
import type { Root, Element, RootContent } from 'hast';
declare module 'hast' {
  interface ElementData {
    sourceLine?: number;
  }
}
import type {
  ArticleInput,
  PrepareOptions,
  PreparedArticle,
  RenderResult,
  ThemeId,
  ImageStore,
  Warning,
  ImageRef,
} from './types';
import { HTML_WARNING } from './types';
import { inlineTheme } from './theme';
import { safeStyle } from './sanitize-style';
import { compactStyles } from './compact-styles';
import { stripFrontmatter } from './frontmatter';
export * from './types';
export { themes } from './theme';
const lowlight = createLowlight(common);
const schema: Options = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img || []), 'src', 'alt', 'title'],
    code: [['className', /^language-./]],
    '*': [...(defaultSchema.attributes?.['*'] || []), 'title', 'style'],
  },
  protocols: { ...defaultSchema.protocols, src: ['http', 'https', 'data', 'jz-local'] },
};
function rawText(node: RootContent | Root): string {
  return node.type === 'text'
    ? node.value
    : 'children' in node
      ? node.children.map(rawText).join('')
      : '';
}
const element = (
  tagName: string,
  children: RootContent[] = [],
  properties: Element['properties'] = {},
): Element => ({ type: 'element', tagName, properties, children: children as Element['children'] });
export function template(source: string, values: Record<string, string>) {
  const value = (key: string) =>
    Object.hasOwn(values, key) && typeof values[key] === 'string' ? values[key] : '';
  return source
    .split('\n')
    .filter((line) => ![...line.matchAll(/\{\{(\w+)\}\}/g)].some((m) => !value(m[1])))
    .map((line) => line.replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(value(key))))
    .join('\n');
}
async function parse(markdown: string, warnings: Warning[]): Promise<Root> {
  const imageUrls = new Map<number, string>();
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(() => (tree) => {
      const definitions = new Map<string, string>();
      visit(tree, 'definition', (node: any) => {
        definitions.set(node.identifier, node.url);
      });
      visit(tree, (node: any) => {
        const url =
          node.type === 'image'
            ? node.url
            : node.type === 'imageReference'
              ? definitions.get(node.identifier)
              : undefined;
        if (url !== undefined && node.position) imageUrls.set(node.position.start.offset, url);
      });
      // 中文段落里的软换行不是词间空格；保留会在成品里多出一个空隙。
      visit(tree, 'text', (node: any) => {
        node.value = node.value.replace(
          /([\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]) *\n *(?=[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef])/g,
          '$1',
        );
      });
      visit(tree, 'link', (node: any, index, parent: any) => {
        if (index === undefined || !parent || !node.position) return;
        const source = markdown.slice(node.position.start.offset, node.position.end.offset);
        // 仅修正裸网址的句尾中文标点，保留用户显式指定的链接目标。
        if (
          !/^https?:\/\//i.test(source) ||
          node.children.length !== 1 ||
          node.children[0].value !== source
        )
          return;
        const suffix = source.match(/[，。；：！？、]+$/)?.[0];
        if (!suffix) return;
        const url = source.slice(0, -suffix.length);
        node.url = url;
        node.children[0].value = url;
        parent.children.splice(index + 1, 0, { type: 'text', value: suffix });
        return index + 2;
      });
      visit(tree, (node: any) => {
        if (!/Directive$/.test(node.type)) return;
        if (node.name === 'divider') {
          node.data = { hName: 'hr' };
        } else if (node.name === 'recent') {
          node.data = { hName: 'section' };
        } else {
          warnings.push({ code: 'UNSUPPORTED_SYNTAX', message: `不支持的样式块：${node.name}` });
          node.type = 'text';
          node.value = markdown.slice(node.position.start.offset, node.position.end.offset);
          delete node.children;
          delete node.data;
        }
      });
    })
    .use(remarkRehype, { allowDangerousHtml: true, footnoteLabel: '注释' })
    .use(rehypeRaw);
  const raw = (await processor.run(processor.parse(markdown))) as Root;
  const comparable = (tree: Root) => {
    const copy = structuredClone(tree);
    visit(copy, 'element', (node) => {
      if (typeof node.properties.id === 'string')
        node.properties.id = node.properties.id.replace(/^(?:user-content-)+/, '');
    });
    return toHtml(copy).replace(
      /aria-describedby="(?:user-content-)*footnote-label"/g,
      'aria-describedby="footnote-label"',
    );
  };
  const before = comparable(raw);
  visit(raw, 'element', (node) => {
    if (node.properties.style) {
      const style = safeStyle(String(node.properties.style));
      if (style) node.properties.style = style;
      else delete node.properties.style;
    }
  });
  const clean = (await unified().use(rehypeSanitize, schema).run(raw)) as Root;
  if (before !== comparable(clean))
    warnings.push({ code: 'HTML_STRIPPED', message: '已清理不支持或不安全的 HTML 标签、属性。' });
  visit(clean, 'element', (node) => {
    if (
      node.tagName === 'img' &&
      node.position &&
      node.properties.src &&
      imageUrls.has(node.position.start.offset!)
    )
      node.properties.src = imageUrls.get(node.position.start.offset!);
  });
  return clean;
}
export async function extractMarkdownTitle(markdown: string): Promise<string> {
  const { source } = stripFrontmatter(markdown);
  const body = await parse(source, []);
  const heading = body.children.find((node) => node.type === 'element' && node.tagName === 'h1');
  return heading ? toText(heading).trim() : '';
}
export async function prepare(input: ArticleInput, opts: PrepareOptions): Promise<PreparedArticle> {
  const warnings: Warning[] = [];
  const { source, ignored } = stripFrontmatter(input.markdown);
  if (ignored) {
    warnings.push({
      code: 'FRONTMATTER_IGNORED',
      message: '已忽略 frontmatter，文章信息由当前入口单独设置。',
    });
  }
  if (/!?\[\[|^>\s*\[!/m.test(source))
    warnings.push({
      code: 'UNSUPPORTED_SYNTAX',
      message: '编辑器私有语法将按普通文本显示，请改用标准 Markdown。',
    });
  if (input.title && Array.from(input.title).length > 32)
    warnings.push({ code: 'TITLE_TOO_LONG', message: '标题超过 32 字，请在平台核对展示效果。' });
  const body = await parse(source, warnings);
  const lineOffset = input.markdown.split('\n').length - source.split('\n').length;
  visit(body, 'element', (node) => {
    if (node.position)
      node.data = { ...node.data, sourceLine: node.position.start.line + lineOffset };
  });
  const first = body.children.findIndex((n) => n.type === 'element' && n.tagName === 'h1');
  if (first >= 0 && input.title && toText(body.children[first]).trim() === input.title.trim())
    body.children.splice(first, 1);
  const values = { ...opts.config, title: input.title };
  const header = opts.fixed.header
    ? await parse(template(input.templates?.header || '', values), warnings)
    : { type: 'root' as const, children: [] };
  const footer = opts.fixed.footer
    ? await parse(template(input.templates?.footer || '', values), warnings)
    : { type: 'root' as const, children: [] };
  const images: ImageRef[] = [];
  for (const [part, fixed] of [
    [header, true],
    [body, false],
    [footer, true],
  ] as const) {
    const nodes: Element[] = [];
    visit(part, 'element', (n) => {
      if (n.tagName === 'img') nodes.push(n);
    });
    for (const n of nodes) {
      const original = String(n.properties.src || '');
      const id = String(images.length);
      let resolved;
      try {
        resolved = await opts.resolver.resolve(original);
      } catch {
        resolved = { kind: 'missing' as const, reason: '无法读取图片' };
      }
      images.push({ id, original, source: resolved, inFixedContent: fixed });
      n.properties.src = `jz-img:${id}`;
      if (resolved.kind === 'missing')
        warnings.push({ code: 'IMAGE_MISSING', message: resolved.reason, ref: original });
    }
  }
  let cover = opts.cover
    ? images.find((i) => i.original === opts.cover) || null
    : images.find((i) => !i.inFixedContent) || null;
  if (opts.cover && !cover) {
    cover = {
      id: 'cover',
      original: opts.cover,
      source: await opts.resolver.resolve(opts.cover),
      inFixedContent: false,
    };
  }
  return {
    platform: opts.platform,
    title: input.title,
    tree: {
      type: 'root',
      children: [
        ...(header.children.length
          ? [element('section', header.children, { className: ['jz-header'] })]
          : []),
        ...body.children,
        ...(footer.children.length
          ? [element('section', footer.children, { className: ['jz-footer'] })]
          : []),
      ],
    },
    images,
    cover,
    warnings,
    version:
      opts.version || JSON.stringify([input, opts.platform, opts.fixed, opts.cover, opts.config]),
  };
}
function compact(tree: Root, platform: 'wechat' | 'zhihu') {
  visit(tree, 'element', (node) => {
    for (const key of Object.keys(node.properties)) {
      if (
        key === 'className' ||
        key === 'id' ||
        (key.startsWith('data') &&
          ![
            'dataDraftNode',
            'dataDraftType',
            'dataSize',
            'dataNumero',
            'dataText',
            'dataUrl',
          ].includes(key))
      )
        delete node.properties[key];
      if (platform === 'zhihu' && key === 'style') delete node.properties[key];
    }
  });
}
function flattenLists(parent: Root | Element, depth = 0) {
  for (const node of parent.children) {
    if (node.type !== 'element') continue;
    const list = node.tagName === 'ul' || node.tagName === 'ol';
    if (list && depth > 0) {
      const ordered = node.tagName === 'ol';
      let n = Number(node.properties.start || 1);
      node.tagName = 'section';
      node.properties.style = 'margin-left:1em';
      node.properties.className = ['jz-sublist'];
      for (const child of node.children) {
        if (child.type !== 'element' || child.tagName !== 'li') continue;
        child.tagName = 'section';
        child.properties.className = ['jz-subitem'];
        child.children.unshift({ type: 'text', value: ordered ? `${n++}. ` : '• ' });
      }
    }
    flattenLists(node, depth + (list ? 1 : 0));
  }
}
function movePunctuation(parent: Root | Element) {
  for (let i = 0; i < parent.children.length - 1; i++) {
    const a = parent.children[i],
      b = parent.children[i + 1];
    // 链接与行内代码自带下划线、底色，标点移进去会一起被装饰，故只处理纯强调。
    if (a.type === 'element' && ['strong', 'em', 'span'].includes(a.tagName) && b.type === 'text') {
      const mark = b.value.match(/^[，。！？；：、）】》]/)?.[0];
      if (mark) {
        a.children.push({ type: 'text', value: mark });
        b.value = b.value.slice(mark.length);
      }
    }
  }
  for (const c of parent.children) if (c.type === 'element') movePunctuation(c);
}
function dialect(tree: Root, platform: 'wechat' | 'zhihu', degraded: Warning[]) {
  const footnotes = new Map<string, Element>();
  visit(tree, 'element', (node) => {
    if (node.tagName === 'li' && node.properties.id) {
      const id = String(node.properties.id);
      footnotes.set(id, node);
      footnotes.set(id.replace(/^user-content-/, ''), node);
    }
  });
  visit(tree, 'element', (node, index, parent) => {
    if (!parent || index === undefined) return;
    if (node.tagName === 'input') {
      // 原文在复选框后已有一个空格，这里不再补，避免出现两个空格。
      const next = parent.children[index + 1];
      const spaced = next?.type === 'text' && /^\s/.test(next.value);
      parent.children[index] = {
        type: 'text',
        value: (node.properties.checked ? '☑' : '☐') + (spaced ? '' : ' '),
      };
      return;
    }
    if (node.tagName === 'a' && node.properties.dataFootnoteRef !== undefined) {
      const id = String(node.properties.href || '').slice(1);
      const note = footnotes.get(id);
      const number = toText(node);
      const attrs =
        platform === 'zhihu'
          ? {
              dataDraftNode: 'inline',
              dataDraftType: 'reference',
              dataNumero: number,
              dataText: note ? toText(note).replace(/↩/g, '').trim() : '',
              dataUrl: (() => {
                let href = '';
                if (note)
                  visit(note, 'element', (n) => {
                    if (
                      n.tagName === 'a' &&
                      /^https?:/.test(String(n.properties.href || '')) &&
                      !href
                    )
                      href = String(n.properties.href);
                  });
                return href;
              })(),
            }
          : {};
      if (parent.type === 'element' && parent.tagName === 'sup') {
        parent.properties = { ...parent.properties, ...attrs };
        parent.children[index] = { type: 'text', value: `[${number}]` };
      } else
        parent.children[index] = element('sup', [{ type: 'text', value: `[${number}]` }], attrs);
      return;
    }
    if (platform === 'wechat') {
      if (node.properties.dataFootnoteBackref !== undefined) {
        parent.children[index] = { type: 'text', value: '' };
        const before = parent.children[index - 1];
        if (before?.type === 'text') before.value = before.value.replace(/\s+$/, '');
        return;
      }
      if (node.tagName === 'div') node.tagName = 'section';
      if (node.tagName === 'ul' || node.tagName === 'ol')
        node.children = node.children.filter((c) => c.type !== 'text' || !!c.value.trim());
      if (node.tagName === 'p' && parent.type === 'element' && parent.tagName === 'li')
        node.tagName = 'span';
      if (node.tagName === 'table') {
        node.properties = { ...node.properties, border: 1, cellPadding: '8', bgColor: '#ffffff' };
        const row = node.children
          .flatMap((c) => (c.type === 'element' ? c.children : []))
          .find((c) => c.type === 'element' && c.tagName === 'tr') as Element | undefined;
        node.properties.style = `min-width:${Math.max(280, (row?.children.filter((c) => c.type === 'element').length || 1) * 100)}px`;
      }
    } else {
      if (node.tagName === 'h1') node.tagName = 'h2';
      if (/^h[4-6]$/.test(node.tagName)) {
        degraded.push({
          code: 'ZHIHU_DEGRADED',
          message: `${node.tagName} 标题已转换为加粗段落：${toText(node)}`,
        });
        node.tagName = 'p';
        node.children = [element('strong', node.children)];
      }
      if (node.properties.style)
        degraded.push({ code: 'ZHIHU_DEGRADED', message: '装饰样式已移除，使用知乎原生排版。' });
      if (node.tagName === 'pre') {
        const code = node.children.find((c) => c.type === 'element' && c.tagName === 'code') as
          | Element
          | undefined;
        node.properties.lang = String(code?.properties.className || '').replace(/^language-/, '');
        node.children = [{ type: 'text', value: rawText(code || node) }];
      }
      if (node.tagName === 'table') {
        node.properties = { dataDraftNode: 'block', dataDraftType: 'table', dataSize: 'normal' };
        const rows = node.children.flatMap((n) =>
          n.type === 'element' && ['thead', 'tbody'].includes(n.tagName) ? n.children : [n],
        );
        node.children = [element('tbody', rows)];
      }
      if (node.tagName === 'section' && node.properties.dataFootnotes !== undefined) {
        parent.children[index] = { type: 'text', value: '' };
        return;
      }
    }
  });
}
export function render(
  prepared: PreparedArticle,
  opts: { theme?: ThemeId; sourceLocations?: boolean } = {},
): RenderResult {
  const tree = structuredClone(prepared.tree);
  const degraded: Warning[] = [];
  dialect(tree, prepared.platform, degraded);
  if (prepared.platform === 'wechat') {
    flattenLists(tree);
    movePunctuation(tree);
  }
  if (prepared.platform === 'wechat') {
    visit(tree, 'element', (node) => {
      if (node.tagName !== 'pre') return;
      const code = node.children.find((n) => n.type === 'element' && n.tagName === 'code') as
        | Element
        | undefined;
      if (!code) return;
      const lang = String(code.properties.className || '').replace(/^language-/, '');
      if (lowlight.registered(lang))
        code.children = lowlight.highlight(lang, rawText(code)).children as Element['children'];
    });
    tree.children = [element('section', tree.children, { className: ['jz'] })];
    inlineTheme(tree, opts.theme || 'sspai');
    // 微信保留预格式行首空格，并用独立滚动容器承载代码/表格。
    visit(tree, 'element', (node, index, parent) => {
      if (!parent || index === undefined || !['pre', 'table'].includes(node.tagName)) return;
      if (parent.type === 'element' && parent.properties.dataScroll) return;
      // 滚动容器自成格式化上下文，内部外边距不再与前后段落合并；把外边距交给容器，间距才与其他块一致。
      let margin = '';
      node.properties.style = [
        ...String(node.properties.style || '')
          .split(';')
          .filter((declaration) => {
            if (!/^margin(-top|-bottom)?:/.test(declaration)) return !!declaration;
            margin += `;${declaration}`;
            return false;
          }),
        'margin:0',
      ].join(';');
      parent.children[index] = element('section', [node], {
        style: `overflow-x:auto;max-width:100%${margin}`,
        dataScroll: true,
      });
      if (node.tagName === 'pre') {
        // 围栏末尾的换行不是一行代码，留着会在代码块底部多出一个空行。
        const texts: { value: string }[] = [];
        visit(node, 'text', (text) => {
          texts.push(text);
        });
        const last = texts.at(-1);
        if (last) last.value = last.value.replace(/\n+$/, '');
        visit(node, 'text', (text, i, p) => {
          if (!p || i === undefined) return;
          const chunks = text.value.replace(/^ +/gm, (s) => '\u00a0'.repeat(s.length)).split('\n');
          if (chunks.length === 1) {
            text.value = chunks[0];
            return;
          }
          const nodes: RootContent[] = [];
          chunks.forEach((s, n) => {
            if (n) nodes.push(element('br'));
            nodes.push({ type: 'text', value: s });
          });
          p.children.splice(i, 1, ...(nodes as Element['children']));
          return i + nodes.length;
        });
      }
      return 'skip';
    });
  }
  if (prepared.platform === 'zhihu') {
    const allowed = new Set([
      'h2',
      'h3',
      'p',
      'strong',
      'em',
      'del',
      'a',
      'blockquote',
      'ul',
      'ol',
      'li',
      'pre',
      'code',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'img',
      'hr',
      'br',
      'sup',
    ]);
    const unwrap = (parent: Root | Element) => {
      parent.children = (parent.children as RootContent[]).flatMap<RootContent>((node) => {
        if (node.type !== 'element') return [node];
        unwrap(node);
        return allowed.has(node.tagName) ? [node] : node.children;
      }) as Element['children'];
      // 知乎保存草稿时会合并相邻 pre；用空段落保留 Markdown 代码围栏边界。
      let previous: RootContent | undefined;
      parent.children = parent.children.flatMap((node) => {
        const adjacentCode =
          node.type === 'element' &&
          node.tagName === 'pre' &&
          previous?.type === 'element' &&
          previous.tagName === 'pre';
        if (node.type !== 'text' || node.value.trim()) previous = node;
        return adjacentCode ? [element('p', [element('br')]), node] : [node];
      }) as Element['children'];
    };
    unwrap(tree);
  }
  if (prepared.platform === 'wechat') compactStyles(tree);
  compact(tree, prepared.platform);
  if (opts.sourceLocations)
    visit(tree, 'element', (node) => {
      if (node.data?.sourceLine && /^(p|h[1-6]|pre|table|li|blockquote|img)$/.test(node.tagName))
        node.properties.dataSourceLine = node.data.sourceLine as number;
    });
  let html = toHtml(tree);
  if (prepared.platform === 'zhihu') html = html.replace(/>\n+</g, '><');
  const text = toText(tree);
  const warnings = [...prepared.warnings];
  if (html.length > HTML_WARNING)
    warnings.push({
      code: 'CONTENT_NEAR_LIMIT',
      message:
        '接口正文接近 20,000 字符，建议换用简洁主题、拆分文章或减少图片。复制不受此接口阈值限制。',
    });
  return {
    platform: prepared.platform,
    title: prepared.title,
    html,
    text,
    images: prepared.images,
    cover: prepared.cover,
    warnings,
    degraded,
    placeholders: [],
    version: prepared.version,
    stats: {
      visibleTextChars: Array.from(text.replace(/\s/g, '')).length,
      htmlChars: html.length,
      imageCount: prepared.images.length,
    },
  };
}
export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export async function placeImages(result: RenderResult, store: ImageStore) {
  let html = result.html;
  for (const image of result.images) {
    const placed = await store.put(image, { platform: result.platform, role: 'body' });
    const attrs = Object.entries(placed.attrs || {})
      .filter(([key]) => /^data-[a-z-]+$/.test(key))
      .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
      .join('');
    html = html.split(`src="jz-img:${image.id}"`).join(`src="${escapeHtml(placed.src)}"${attrs}`);
  }
  return { html, bytes: new TextEncoder().encode(html).byteLength, text: result.text };
}

export { replaceImageReference } from './references';
