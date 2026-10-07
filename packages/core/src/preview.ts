import { escapeHtml } from './index';
import type { RenderResult } from './types';
// 知乎成品不带样式，表格与代码块的观感由预览壳给；公众号成品自带样式与表格属性，壳不再覆盖。
const ZHIHU_STYLE =
  'table{border-collapse:collapse;max-width:100%}td,th{padding:8px;border:1px solid #ddd}article h2{font-size:22px}article h3{font-size:19px}article pre{padding:16px;background:#f6f6f6;font-size:13px}';
// 名片是公众号编辑器才渲染的组件，预览里用占位块示意，不进入成品。
const CARD_STYLE =
  'mp-common-profile{display:block;margin:8px 0;padding:14px 16px;border:1px solid #e7e7e7;border-radius:8px;background:#fafafa}mp-common-profile::before{content:attr(data-nickname);display:block;font-size:15px;font-weight:600;color:#333}mp-common-profile::after{content:attr(data-signature) "（公众号名片，预览示意）";display:block;margin-top:4px;font-size:12px;color:#999}';
export function previewDocument(
  result: RenderResult,
  html: string,
  options: {
    coverSrc?: string;
    hideCover?: boolean;
    account?: string;
    date?: string;
    bodyOnly?: boolean;
  } = {},
) {
  const zhihu = result.platform === 'zhihu';
  const csp =
    "default-src 'none'; img-src blob: data: https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{margin:0;padding:26px 22px;background:#fff;color:#343a34;font:15px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;overflow-wrap:anywhere}@media(max-width:480px){body{padding:20px 16px}}header h1{font-size:22px;line-height:1.5;margin:0 0 12px;font-weight:600}header small{color:#8e9387;font-size:11px}header img{display:block;max-width:100%;margin:20px auto}header{margin-bottom:25px}.missing{border:1px dashed #b89856;background:#fff9ef;padding:22px;font-size:12px;color:#8c713d}img{max-width:100%;height:auto}pre{white-space:pre;overflow:auto}.diagnostic{font-size:11px;color:#8b754e;background:#faf6ed;padding:10px;margin-top:20px}a{color:#596f8c}blockquote{border-left:3px solid #ddd;margin:18px 0;padding:0 15px;color:#777}${zhihu ? ZHIHU_STYLE : CARD_STYLE}</style>${options.bodyOnly ? '' : `<header><h1>${escapeHtml(result.title || '未命名文章')}</h1><small>${escapeHtml(options.account || '账号名（预览示意）')}　${escapeHtml(options.date || '')}</small>${options.hideCover ? '' : options.coverSrc ? `<img alt="文章封面，仅预览" src="${escapeHtml(options.coverSrc)}">` : '<p><small>未设置封面</small></p>'}</header>`}<article id="jz-body">${html}</article>${options.bodyOnly ? '' : result.degraded.map((w) => `<aside class="diagnostic">${escapeHtml(w.message)}</aside>`).join('')}</html>`;
}
