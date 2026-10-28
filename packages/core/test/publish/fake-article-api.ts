import { createHash } from 'node:crypto';
import type { HttpRequest } from '../../src/publish';
import { bodyText, type Reply, type Route } from './mock-host';

/**
 * 按 gpt101 仓库 `src/shared/services/article-api*.ts` 的行为模拟文章接口：Bearer Key、slug 唯一（409）、
 * 更新必须带读取时的 ETag（412/428），响应 `{ data: {..., etag} }` 且 ETag 头相同。
 */
export function fakeArticleApi(origin = 'https://blog.test', key = 'sk-test') {
  const articles = new Map<string, Record<string, unknown>>();
  let tick = 0;
  const etagOf = (article: Record<string, unknown>) =>
    `"${createHash('sha256').update(JSON.stringify(article)).digest('hex')}"`;
  const data = (article: Record<string, unknown>) => ({
    ...article,
    url: `/tutorials/${article.slug}`,
    etag: etagOf(article),
  });
  const ok = (status: number, article: Record<string, unknown>): Reply => ({
    status,
    json: { data: data(article) },
    headers: { etag: etagOf(article) },
  });
  const error = (status: number, code: string, message = code): Reply => ({
    status,
    json: { error: { code, message } },
  });
  const authorized = (request: HttpRequest) => request.headers?.Authorization === `Bearer ${key}`;
  const slugOf = (request: HttpRequest) =>
    decodeURIComponent(new URL(request.url).pathname.replace(/^\/api\/v1\/articles\/?/, ''));
  const routes: Route[] = [
    {
      method: 'GET',
      match: `${origin}/api/v1/articles`,
      replies: [
        (request) => {
          if (!authorized(request)) return error(401, 'unauthorized');
          const slug = slugOf(request);
          if (!slug)
            return { json: { data: { items: [], total: articles.size, page: 1, limit: 1 } } };
          const article = articles.get(slug);
          return article ? ok(200, article) : error(404, 'not_found');
        },
      ],
    },
    {
      method: 'POST',
      match: `${origin}/api/v1/articles`,
      replies: [
        (request) => {
          if (!authorized(request)) return error(401, 'unauthorized');
          const input = JSON.parse(bodyText(request));
          if (articles.has(input.slug)) return error(409, 'slug_conflict');
          const article = {
            description: '',
            image: '',
            categories: '',
            tags: '',
            status: 'draft',
            ...input,
            updatedAt: ++tick,
          };
          articles.set(input.slug, article);
          return ok(201, article);
        },
      ],
    },
    {
      method: 'PATCH',
      match: `${origin}/api/v1/articles/`,
      replies: [
        (request) => {
          if (!authorized(request)) return error(401, 'unauthorized');
          const current = articles.get(slugOf(request));
          if (!current) return error(404, 'not_found');
          const version = request.headers?.['If-Match'];
          if (!version) return error(428, 'version_required');
          if (version !== etagOf(current)) return error(412, 'version_conflict');
          const next = { ...current, ...JSON.parse(bodyText(request)), updatedAt: ++tick };
          articles.set(next.slug as string, next);
          return ok(200, next);
        },
      ],
    },
  ];
  /** 模拟有人在网站后台改过。 */
  const edit = (slug: string, patch: Record<string, unknown>) =>
    articles.set(slug, { ...articles.get(slug)!, ...patch, updatedAt: ++tick });
  return { routes, articles, edit };
}
