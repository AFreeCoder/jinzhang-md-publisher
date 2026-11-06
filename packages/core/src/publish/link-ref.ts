import { decodeHTMLAttribute } from 'entities';
import { escapeHtml } from '../place';
import type { JinzhangConfig } from '../local';
/** 来源参数名固定为 `ref`。 */
export const LINK_REF_PARAM = 'ref';
/** 本地日期，写成 `YYYYMMDD`。 */
export function compactDate(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}
/** 标记模板换成本次的值：`{{id}}` 是知乎文章 ID，拿不到时（复制）用日期代替；`{{date}}` 是日期。 */
export function linkRefValue(template: string, id: string | undefined, now: Date) {
  const date = compactDate(now);
  return template.replace(/\{\{id\}\}/g, id || date).replace(/\{\{date\}\}/g, date);
}
function tagUrl(raw: string, domains: string[], value: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(url.protocol)) return undefined;
  const host = url.hostname.toLowerCase();
  if (!domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return undefined;
  if (url.searchParams.has(LINK_REF_PARAM)) return undefined;
  // 原有参数按原样保留，ref 追加在最后。
  const extra = `${LINK_REF_PARAM}=${encodeURIComponent(value)}`;
  url.search = url.search ? `${url.search}&${extra}` : extra;
  return url.href;
}
/** 成品 HTML 由 hast-util-to-html 生成，属性值一律用双引号；只在标签内找，代码块里的 `href="…"` 是文字。 */
const TAG = /<[a-zA-Z][\w-]*(?:\s+[\w:.-]+(?:="[^"]*")?)*\s*\/?>/g;
const LINK_ATTR = /(\s(?:href|data-url)=")([^"]*)"/g;
/**
 * 给成品 HTML 里指定域名（含子域名）的链接加来源参数：只改 `href` 与知乎引用的 `data-url`，
 * 显示的文字不动；已带 ref 的链接不动。域名或标记为空时原样返回。
 */
export function tagLinks(html: string, domains: string[], value: string) {
  let count = 0;
  if (!domains.length || !value) return { html, count };
  const result = html.replace(TAG, (tag) =>
    tag.replace(LINK_ATTR, (whole, head: string, raw: string) => {
      const next = tagUrl(decodeHTMLAttribute(raw), domains, value);
      if (!next) return whole;
      count++;
      return `${head}${escapeHtml(next)}"`;
    }),
  );
  return { html: result, count };
}
/** 按配置给知乎正文加来源标记；`id` 是知乎文章 ID，复制时拿不到，传空。 */
export function tagZhihuLinks(
  html: string,
  config: JinzhangConfig,
  id: string | undefined,
  now: Date,
) {
  const { domains, value } = config.zhihu.linkRef;
  const ref = linkRefValue(value, id, now);
  return { ...tagLinks(html, domains, ref), ref };
}
