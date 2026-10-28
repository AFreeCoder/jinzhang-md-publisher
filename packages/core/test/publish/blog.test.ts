import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  blogMarkdown,
  blogPublisher,
  defaultConfig,
  normalizeConfig,
  prepareBlog,
  signV4,
  suggestSlug,
  TransportError,
  type BlogContext,
  type OssCredentials,
} from '../../src/publish';
import type { AssetResolver } from '../../src/types';
import { bodyText, mockHost, type Reply, type Route } from './mock-host';
import { fakeArticleApi } from './fake-article-api';

const BLOG = { id: 'gpt101', name: 'GPT101', url: 'https://blog.test' };
const SOURCE = '/vault/posts/如何升级.md';
const OSS: OssCredentials = {
  region: 'oss-cn-shanghai',
  bucket: 'demo',
  accessKeyId: 'AK',
  accessKeySecret: 'SK',
  publicBaseUrl: 'https://img.example.com',
  keyPrefix: 'posts',
};
const BYTES: Record<string, number[]> = {
  'jz-local://vault/assets/a b.png': [1, 2, 3],
  'jz-local://vault/assets/c.gif': [4, 5],
  '/vault/cover.jpg': [6],
};
const resolver: AssetResolver = {
  resolve: async (ref) => {
    if (/^https?:/.test(ref)) return { kind: 'remote', url: ref };
    if (ref.startsWith('data:image/png;base64,'))
      return { kind: 'data', bytes: new Uint8Array([9, 9]), mime: 'image/png' };
    const bytes = BYTES[ref];
    if (!bytes) return { kind: 'missing', reason: `找不到 ${ref}` };
    const ext = ref.split('.').pop()!;
    return {
      kind: 'blob',
      bytes: new Uint8Array(bytes),
      mime: ext === 'gif' ? 'image/gif' : ext === 'jpg' ? 'image/jpeg' : 'image/png',
      assetId: ref.replace('jz-local://vault/', ''),
    };
  },
};
const sha = (bytes: number[]) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const url = (bytes: number[], ext: string) => `https://img.example.com/posts/${sha(bytes)}${ext}`;

const MARKDOWN = [
  '# 如何升级',
  '',
  '开头一段，**加粗**与[链接](https://x.test)。',
  '',
  '![示意 [1]](<jz-local://vault/assets/a b.png> "标题")',
  '',
  '> 引用里的图 ![动图][g]',
  '',
  '<p><img alt="x" src="jz-local://vault/assets/c.gif"></p>',
  '',
  '![网络图](https://cdn.test/n.png)',
  '',
  '```md',
  '![代码里的图](jz-local://vault/assets/a b.png)',
  '```',
  '',
  '[g]: jz-local://vault/assets/c.gif',
].join('\n');

describe('博客 Markdown', () => {
  it('去掉与标题相同的一级标题；本地图片（行内、引用式、HTML）换成长期地址，网络图片与代码不动', async () => {
    const article = await prepareBlog({ markdown: MARKDOWN, title: '如何升级' }, resolver);
    expect(article.images.map((i) => i.original)).toEqual([
      'jz-local://vault/assets/a b.png',
      'jz-local://vault/assets/c.gif',
      'https://cdn.test/n.png',
    ]);
    expect(article.cover?.original).toBe('jz-local://vault/assets/a b.png');
    expect(article.description).toBe('开头一段，加粗与链接。 引用里的图');
    const urls = new Map([
      ['jz-local://vault/assets/a b.png', url([1, 2, 3], '.png')],
      ['jz-local://vault/assets/c.gif', url([4, 5], '.gif')],
    ]);
    expect(blogMarkdown(article, urls)).toBe(
      [
        '开头一段，**加粗**与[链接](https://x.test)。',
        '',
        `![示意 \\[1\\]](${url([1, 2, 3], '.png')} "标题")`,
        '',
        '> 引用里的图 ![动图][g]',
        '',
        `<p><img alt="x" src="${url([4, 5], '.gif')}"></p>`,
        '',
        '![网络图](https://cdn.test/n.png)',
        '',
        '```md',
        '![代码里的图](jz-local://vault/assets/a b.png)',
        '```',
        '',
        `[g]: ${url([4, 5], '.gif')}`,
        '',
      ].join('\n'),
    );
  });
  it('一级标题与标题不同就保留；单独设置的封面优先', async () => {
    const article = await prepareBlog(
      { markdown: '# 别的标题\n\n正文', title: '如何升级', cover: '/vault/cover.jpg' },
      resolver,
    );
    expect(blogMarkdown(article)).toBe('# 别的标题\n\n正文\n');
    expect(article.cover?.source).toMatchObject({ kind: 'blob', mime: 'image/jpeg' });
  });
  it('只有英文文件名才建议 slug', () => {
    expect(suggestSlug('How to Use ChatGPT Plus?')).toBe('how-to-use-chatgpt-plus');
    expect(suggestSlug('如何升级 ChatGPT')).toBe('');
  });
});

describe('长期图床签名', () => {
  it('OSS V4 签名与 ali-oss 6.23 对同一输入的结果一致（含中文与括号的对象名）', async () => {
    const config = {
      region: 'oss-cn-shanghai',
      bucket: 'demo-bucket',
      accessKeyId: 'LTAI-test-id',
      accessKeySecret: 'test-secret-value',
    };
    const headers = {
      'x-oss-date': '20261028T080910Z',
      'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    };
    expect(
      await signV4(config, {
        method: 'PUT',
        key: 'article-publish-assistant/abc123.png',
        headers: { ...headers, 'Content-Type': 'image/png' },
      }),
    ).toBe(
      'OSS4-HMAC-SHA256 Credential=LTAI-test-id/20261028/cn-shanghai/oss/aliyun_v4_request,Signature=ff1acdf13ef3b4f28773e0fc4d81ade058b5d7417aa2b6f4cac1c54a0e8ffb53',
    );
    expect(await signV4(config, { method: 'HEAD', key: 'prefix/中文 (1)!.jpg', headers })).toBe(
      'OSS4-HMAC-SHA256 Credential=LTAI-test-id/20261028/cn-shanghai/oss/aliyun_v4_request,Signature=7b393b53fdc952fc222e59f364e7b10661f09a34445a42cfec7a59f967e8021c',
    );
  });
});

describe('博客配置', () => {
  it('默认带 GPT101；默认目标只保留存在的博客', () => {
    expect(defaultConfig().blogs).toEqual([
      { id: 'gpt101', name: 'GPT101', url: 'https://gpt101.org' },
    ]);
    const config = normalizeConfig({
      targets: ['blog:gpt101', 'zhihu', 'blog:gone'],
      blogs: [
        { id: 'gpt101', name: 'GPT101', url: 'https://gpt101.org/' },
        { id: 'Bad Id', name: 'x', url: 'https://x.test' },
      ],
    });
    expect(config.targets).toEqual(['zhihu', 'blog:gpt101']);
    expect(config.blogs).toEqual([{ id: 'gpt101', name: 'GPT101', url: 'https://gpt101.org' }]);
  });
});

function setup(options: { oss?: boolean; key?: boolean; extra?: Route[] } = {}) {
  const api = fakeArticleApi(BLOG.url);
  const stored = new Set<string>();
  const oss: Route[] = [
    {
      method: 'HEAD',
      match: 'https://demo.oss-cn-shanghai.aliyuncs.com/',
      replies: [(r) => ({ status: stored.has(r.url) ? 200 : 404 })],
    },
    {
      method: 'PUT',
      match: 'https://demo.oss-cn-shanghai.aliyuncs.com/',
      replies: [
        (r) => {
          stored.add(r.url);
          return { status: 200 };
        },
      ],
    },
  ];
  const m = mockHost([...(options.extra ?? []), ...oss, ...api.routes]);
  m.secrets.credentials = {
    ...(options.oss === false ? {} : { oss: OSS }),
    ...(options.key === false ? {} : { blogs: { gpt101: { apiKey: 'sk-test' } } }),
  };
  const ctx: BlogContext = { host: m.host, source: SOURCE, blog: BLOG };
  return { m, api, ctx, stored };
}
const article = (markdown = MARKDOWN) => prepareBlog({ markdown, title: '如何升级' }, resolver);

describe('推送到博客', () => {
  it('体检：缺 API Key、缺图床、缺图都给出下一步；不上传也不写入', async () => {
    const { m, ctx } = setup({ oss: false, key: false });
    const report = await blogPublisher.preflight(
      await article(`${MARKDOWN}\n\n![缺](jz-local://vault/none.png)`),
      ctx,
    );
    expect(report.blockers.map((b) => b.code)).toEqual([
      'IMAGE_MISSING',
      'OSS_MISSING',
      'CONFIG_MISSING',
    ]);
    expect(report.warnings.map((w) => w.code)).toEqual(['IMAGE_REMOTE_KEPT']);
    expect(m.requests).toHaveLength(0);
  });
  it('首次推送：体检只读校验 Key；推送时上传本地图片、新建并发布，记下映射', async () => {
    const { m, api, ctx, stored } = setup();
    const a = await article();
    const report = await blogPublisher.preflight(a, ctx);
    expect(report).toMatchObject({ ok: true, mode: 'create', suggestion: '' });
    expect(report.summary).toMatchObject({ localImages: 2, remoteImages: 1 });
    expect(m.requests.map((r) => `${r.method ?? 'GET'} ${r.url}`)).toEqual([
      'GET https://blog.test/api/v1/articles?limit=1',
    ]);
    expect(await blogPublisher.check('ru-he-sheng-ji', ctx)).toEqual({ state: 'free' });
    const progress: string[] = [];
    const result = await blogPublisher.push(
      a,
      { ...ctx, onProgress: (p) => progress.push(p) },
      { slug: 'Ru-He-Sheng-Ji', overwrite: false },
    );
    expect(result).toMatchObject({
      outcome: 'created',
      draftRef: 'ru-he-sheng-ji',
      entryUrl: 'https://blog.test/tutorials/ru-he-sheng-ji',
      verification: 'confirmed',
      uploadedImages: 2,
    });
    expect(stored.size).toBe(2);
    const saved = api.articles.get('ru-he-sheng-ji')!;
    expect(saved).toMatchObject({
      title: '如何升级',
      status: 'published',
      description: '开头一段，加粗与链接。 引用里的图',
      image: url([1, 2, 3], '.png'),
    });
    expect(saved.content).toContain(`](${url([1, 2, 3], '.png')} "标题")`);
    expect(saved.content).not.toContain('# 如何升级');
    const post = m.calls('POST', 'https://blog.test/api/v1/articles')[0];
    expect(post.headers).toMatchObject({ Authorization: 'Bearer sk-test' });
    expect(Object.keys(JSON.parse(bodyText(post))).sort()).toEqual(
      ['content', 'description', 'image', 'slug', 'status', 'title'].sort(),
    );
    expect(progress).toEqual(['上传图片 1/2', '上传图片 2/2', '读取网站上的版本', '发布文章']);
    const entry = m.state.drafts[SOURCE].blogs!.gpt101;
    expect(entry).toMatchObject({ account: BLOG.url, slug: 'ru-he-sheng-ji', status: 'confirmed' });
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('改稿再推：按映射带 If-Match 更新，不动摘要；网站上只改了分类不算冲突', async () => {
    const { m, api, ctx } = setup();
    await blogPublisher.push(await article(), ctx, { slug: 'post', overwrite: false });
    api.edit('post', { categories: 'abc', description: '人工摘要' });
    const next = await article(`${MARKDOWN}\n\n新增一段。`);
    const report = await blogPublisher.preflight(next, ctx);
    expect(report).toMatchObject({ ok: true, mode: 'update', slug: 'post' });
    const result = await blogPublisher.push(next, ctx, { slug: 'post', overwrite: false });
    expect(result).toMatchObject({ outcome: 'updated', draftRef: 'post' });
    const patch = m.calls('PATCH', 'https://blog.test/api/v1/articles/post')[0];
    expect(patch.headers?.['If-Match']).toMatch(/^"[0-9a-f]{64}"$/);
    expect(Object.keys(JSON.parse(bodyText(patch))).sort()).toEqual(
      ['content', 'image', 'status', 'title'].sort(),
    );
    expect(api.articles.get('post')).toMatchObject({
      description: '人工摘要',
      categories: 'abc',
      status: 'published',
    });
    expect(api.articles.get('post')!.content).toContain('新增一段。');
  });
  it('网站上改过正文：体检要求确认覆盖，未确认推送时不写入，确认后覆盖', async () => {
    const { api, ctx } = setup();
    await blogPublisher.push(await article(), ctx, { slug: 'post', overwrite: false });
    api.edit('post', { content: '后台改过的正文' });
    const a = await article();
    const report = await blogPublisher.preflight(a, ctx);
    expect(report.blockers.map((b) => b.code)).toEqual(['BLOG_REMOTE_CHANGED']);
    const refused = await blogPublisher.push(a, ctx, { slug: 'post', overwrite: false });
    expect(refused).toMatchObject({ outcome: 'failed', error: { code: 'BLOG_REMOTE_CHANGED' } });
    expect(api.articles.get('post')!.content).toBe('后台改过的正文');
    const forced = await blogPublisher.push(a, ctx, { slug: 'post', overwrite: true });
    expect(forced.outcome).toBe('updated');
    expect(api.articles.get('post')!.content).not.toBe('后台改过的正文');
  });
  it('slug 已被别的文章占用：检查时给出那篇的标题，不勾选覆盖就不推', async () => {
    const { api, ctx } = setup();
    api.articles.set('taken', { slug: 'taken', title: '别的文章', content: 'x', status: 'draft' });
    expect(await blogPublisher.check('taken', ctx)).toMatchObject({
      state: 'taken',
      remote: { title: '别的文章', status: 'draft' },
    });
    const result = await blogPublisher.push(await article(), ctx, {
      slug: 'taken',
      overwrite: false,
    });
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'BLOG_SLUG_TAKEN' } });
    expect(api.articles.get('taken')!.title).toBe('别的文章');
  });
  it('发布请求超时：读回一致算成功；读不到记为不确定，下次体检要求确认', async () => {
    const timeout = (saved: boolean): Route => ({
      method: 'POST',
      match: 'https://blog.test/api/v1/articles',
      replies: [
        (request): Reply => {
          if (saved) {
            const input = JSON.parse(bodyText(request));
            ok.api.articles.set(input.slug, { ...input });
          }
          return new TransportError('timeout');
        },
      ],
    });
    const ok = setup({ extra: [timeout(true)] });
    const saved = await blogPublisher.push(await article(), ok.ctx, { slug: 'post', overwrite: false });
    expect(saved).toMatchObject({ outcome: 'created', verification: 'confirmed' });
    expect(ok.m.state.drafts[SOURCE].blogs!.gpt101.status).toBe('confirmed');
    const lost = setup({ extra: [timeout(false)] });
    const result = await blogPublisher.push(await article(), lost.ctx, {
      slug: 'post',
      overwrite: false,
    });
    expect(result).toMatchObject({ outcome: 'uncertain', error: { code: 'OUTCOME_UNCERTAIN' } });
    expect(lost.m.state.drafts[SOURCE].blogs!.gpt101).toMatchObject({ slug: 'post', status: 'uncertain' });
    // 网站上其实没有：下次按原地址重新发布，不需要确认。
    const report = await blogPublisher.preflight(await article(), lost.ctx);
    expect(report).toMatchObject({ ok: true, mode: 'recreate', slug: 'post' });
  });
  it('Key 失效时体检给出重建入口', async () => {
    const { m, ctx } = setup();
    m.secrets.credentials = { oss: OSS, blogs: { gpt101: { apiKey: 'sk-wrong' } } };
    const report = await blogPublisher.preflight(await article(), ctx);
    expect(report.blockers).toMatchObject([
      { code: 'BLOG_AUTH', action: expect.stringContaining('https://blog.test/settings/apikeys/create') },
    ]);
  });
});
