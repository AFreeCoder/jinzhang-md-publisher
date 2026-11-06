import { decodeHTMLAttribute } from 'entities';
import { escapeHtml } from './place';
/**
 * 链接来源参数：给指定域名的链接追加查询参数，统计从哪篇文章来的访问。
 * 不依赖 Node，网页版与插件共用；按配置给知乎正文加参数的入口在 `./publish`。
 */
/** 默认参数用 GA4 等统计工具能直接识别的 UTM；`{{id}}` 是知乎文章 ID。 */
export const DEFAULT_LINK_QUERY = 'utm_source=zhihu&utm_medium=social&utm_content={{id}}';
/** 本地日期，写成 `YYYYMMDD`。 */
export function compactDate(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** 域名列表：接受数组或逗号、空白、顿号分隔的文字；去掉协议、路径、端口与开头的 `www.`，去重。 */
export function parseDomains(raw: unknown): string[] {
  const items = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string')
    : typeof raw === 'string'
      ? raw.split(/[\s,，、;；]+/)
      : [];
  const domains: string[] = [];
  for (const item of items) {
    const domain = item
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[/:?#].*$/, '')
      .replace(/^www\./, '');
    if (DOMAIN.test(domain) && !domains.includes(domain)) domains.push(domain);
  }
  return domains;
}
/** 参数模板整理成 `a=1&b=2`：去掉开头的 `?`、空白与没有参数名的项，模板变量原样保留。 */
export function normalizeLinkQuery(raw: unknown) {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/^[?&]+/, '')
    .split('&')
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith('='))
    .join('&');
}
/**
 * 参数模板换成本次的参数：`{{id}}` 是知乎文章 ID，拿不到时（复制）用日期代替；
 * `{{date}}` 是日期。返回编码好的查询串，没有参数时为空串。
 */
export function linkQuery(template: string, id: string | undefined, now: Date) {
  const date = compactDate(now);
  const filled = normalizeLinkQuery(template)
    .replace(/\{\{id\}\}/g, encodeURIComponent(id || date))
    .replace(/\{\{date\}\}/g, date);
  return new URLSearchParams(filled).toString();
}
function tagUrl(raw: string, domains: string[], params: URLSearchParams, extra: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(url.protocol)) return undefined;
  const host = url.hostname.toLowerCase();
  if (!domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return undefined;
  // 已带其中任一参数的链接是作者自己写的，不覆盖也不混加。
  if ([...params.keys()].some((key) => url.searchParams.has(key))) return undefined;
  // 原有参数按原样保留，来源参数追加在最后。
  url.search = url.search ? `${url.search}&${extra}` : extra;
  return url.href;
}
/** 成品 HTML 由 hast-util-to-html 生成，属性值一律用双引号；只在标签内找，代码块里的 `href="…"` 是文字。 */
const TAG = /<[a-zA-Z][\w-]*(?:\s+[\w:.-]+(?:="[^"]*")?)*\s*\/?>/g;
const LINK_ATTR = /(\s(?:href|data-url)=")([^"]*)"/g;
/**
 * 给成品 HTML 里指定域名（含子域名）的链接追加查询参数 `query`（编码好的 `a=1&b=2`）：
 * 只改 `href` 与知乎引用的 `data-url`，显示的文字不动。域名或参数为空时原样返回。
 */
export function tagLinks(html: string, domains: string[], query: string) {
  let count = 0;
  const params = new URLSearchParams(query);
  if (!domains.length || ![...params.keys()].length) return { html, count };
  const extra = params.toString();
  const result = html.replace(TAG, (tag) =>
    tag.replace(LINK_ATTR, (whole, head: string, raw: string) => {
      const next = tagUrl(decodeHTMLAttribute(raw), domains, params, extra);
      if (!next) return whole;
      count++;
      return `${head}${escapeHtml(next)}"`;
    }),
  );
  return { html: result, count };
}
