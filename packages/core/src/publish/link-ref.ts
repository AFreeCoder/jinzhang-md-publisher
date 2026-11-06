import { linkQuery, tagLinks } from '../link-ref';
import type { JinzhangConfig } from '../local';
/** 按配置给知乎正文加来源参数；`id` 是知乎文章 ID，复制时拿不到，传空。 */
export function tagZhihuLinks(
  html: string,
  config: JinzhangConfig,
  id: string | undefined,
  now: Date,
) {
  const { domains, query } = config.zhihu.linkRef;
  const filled = linkQuery(query, id, now);
  return { ...tagLinks(html, domains, filled), query: filled };
}
