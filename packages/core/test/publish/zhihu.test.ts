import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createZhihuCopyStore,
  parseZhihuCookies,
  saveZhihuLogin,
  TransportError,
  zhihuPublisher,
} from '../../src/publish';
import { md5Hex, sha256Hex } from '../../src/publish/hash';
import { placeImages } from '../../src/index';
import { bodyText, mockHost, type Reply, type Route } from './mock-host';
import { article, context } from './article';
import Z from './fixtures/zhihu.json';
const SOURCE = '/notes/测试文章.md';
const ZHUANLAN = 'https://zhuanlan.zhihu.com';
const PATCH_URL = /^https:\/\/zhuanlan\.zhihu\.com\/api\/articles\/[^/]+\/draft$/;
function routes(
  o: Partial<Record<'me' | 'images' | 'oss' | 'status' | 'create' | 'patch', Reply[]>> = {},
): Route[] {
  return [
    { match: 'https://www.zhihu.com/api/v4/me', replies: o.me ?? [{ json: Z.me }] },
    {
      method: 'POST',
      match: 'https://api.zhihu.com/images',
      replies: o.images ?? [{ json: Z.image_new }],
    },
    {
      method: 'PUT',
      match: 'https://zhihu-pics-upload.zhimg.com/',
      replies: o.oss ?? [{ bytes: new Uint8Array() }],
    },
    {
      match: /^https:\/\/api\.zhihu\.com\/images\//,
      replies: o.status ?? [{ json: Z.image_processing }, { json: Z.image_success }],
    },
    {
      method: 'POST',
      match: `${ZHUANLAN}/api/articles/drafts`,
      replies: o.create ?? [{ json: Z.draft_created }],
    },
    { method: 'PATCH', match: PATCH_URL, replies: o.patch ?? [{ json: {} }] },
  ];
}
function setup(o?: Parameters<typeof routes>[0]) {
  const m = mockHost(routes(o));
  m.secrets['zhihu-session'] = {
    cookies: { z_c0: '<Z_C0>', _xsrf: '<XSRF>', d_c0: '<D_C0>', BEC: '<BEC>' },
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
  return m;
}
const BODY = '![图](./a.png)\n\n正文\n\n#### 四级标题\n\n![另一张](./b.jpg)';
describe('知乎体检', () => {
  it('没登录、登录失效、风控、验证页分别给出可操作的阻塞项', async () => {
    const none = mockHost(routes());
    const a = await article(BODY, 'zhihu');
    const missing = await zhihuPublisher.preflight(a, context(none.host));
    expect(missing.blockers.map((b) => b.code)).toEqual(['CONFIG_MISSING']);
    expect(none.requests).toHaveLength(0);
    for (const [reply, code] of [
      [{ status: 401, json: Z.unauthorized }, 'ZHIHU_LOGIN_REQUIRED'],
      [{ status: 403, json: Z.risk_control }, 'ZHIHU_RISK_CONTROL'],
      [{ status: 400, json: Z.risk_control_10001 }, 'ZHIHU_RISK_CONTROL'],
      [{ json: Z.me_anonymous }, 'ZHIHU_LOGIN_REQUIRED'],
      [{ text: Z.verification_page }, 'ZHIHU_LOGIN_REQUIRED'],
      [new TransportError('network'), 'NETWORK_ERROR'],
    ] as const) {
      const m = setup({ me: [reply] });
      const report = await zhihuPublisher.preflight(a, context(m.host));
      expect(report.blockers.map((b) => b.code)).toEqual([code]);
    }
  });
  it('登录有效时列出账号；没有封面只警告；降级内容汇总提示；不检查标题与长度', async () => {
    const m = setup();
    const long = await article(`正文\n\n#### 四级标题\n\n${'字'.repeat(10)}`, 'zhihu');
    const report = await zhihuPublisher.preflight(
      {
        ...long,
        title: '很长'.repeat(20),
        warnings: [...long.warnings, { code: 'TITLE_TOO_LONG', message: 'x' }],
      },
      context(m.host, {
        fixed: { header: true, footer: false },
        templates: { header: '<section>装饰</section>' },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ account: '示例作者', cover: null, draft: 'create' });
    expect(report.warnings.map((w) => w.code)).toEqual([
      'COVER_MISSING',
      'TEMPLATE_UNSUPPORTED',
      'ZHIHU_DEGRADED',
    ]);
    expect(m.calls('POST', 'https://api.zhihu.com/images')).toHaveLength(0);
  });
});
describe('知乎推送', () => {
  it('首次推送：MD5 申请、OSS 签名直传、轮询取地址、建草稿、写正文与题图', async () => {
    const m = setup();
    const ctx = context(m.host);
    const a = await article(BODY, 'zhihu');
    expect((await zhihuPublisher.preflight(a, ctx)).ok).toBe(true);
    const result = await zhihuPublisher.push(a, ctx);
    expect(result).toMatchObject({
      outcome: 'created',
      draftRef: '<DRAFT_ID>',
      entryUrl: `${ZHUANLAN}/p/%3CDRAFT_ID%3E/edit`,
      verification: 'not_run',
      uploadedImages: 2,
    });
    const normalized = new Uint8Array([0x89, 1, 1]);
    const md5 = md5Hex(normalized);
    const apply = m.calls('POST', 'https://api.zhihu.com/images')[0];
    expect(JSON.parse(bodyText(apply))).toEqual({ image_hash: md5, source: 'article' });
    const put = m.calls('PUT', 'https://zhihu-pics-upload.zhimg.com/')[0];
    expect(put.url).toBe(`https://zhihu-pics-upload.zhimg.com/v2-${md5}`);
    const date = put.headers!['x-oss-date'];
    const expected = createHmac('sha1', '<ACCESS_KEY>')
      .update(
        `PUT\n\nimage/png\n${date}\nx-oss-date:${date}\nx-oss-security-token:<SECURITY_TOKEN>\nx-oss-user-agent:${put.headers!['x-oss-user-agent']}\n/zhihu-pics/v2-${md5}`,
      )
      .digest('base64');
    expect(put.headers).toMatchObject({
      Authorization: `OSS <ACCESS_ID>:${expected}`,
      'Content-Type': 'image/png',
      'x-oss-security-token': '<SECURITY_TOKEN>',
    });
    expect(put.body).toEqual(normalized);
    expect(m.sleeps).toContain(1000);
    const [content, cover] = m.calls('PATCH', PATCH_URL).map((r) => JSON.parse(bodyText(r)));
    expect(content).toMatchObject({
      title: '测试文章',
      table_of_contents: false,
      delta_time: 30,
      can_reward: false,
    });
    expect(content.content).toContain('src="https://pic1.zhimg.com/v2-&lt;MD5&gt;.png"');
    expect(content.content).toContain('data-rawwidth="800" data-rawheight="600"');
    expect(content.content).toContain(
      'data-original-src="https://pic1.zhimg.com/v2-&lt;MD5&gt;.png"',
    );
    expect(content.content).toContain('data-size="normal"');
    expect(content.content).not.toContain('jz-img:');
    expect(cover).toEqual({
      titleImage: 'https://pic1.zhimg.com/v2-<MD5>',
      isTitleImageFullScreen: false,
      delta_time: 30,
    });
    const create = m.calls('POST', `${ZHUANLAN}/api/articles/drafts`)[0];
    expect(JSON.parse(bodyText(create))).toEqual({
      title: '测试文章',
      delta_time: 0,
      can_reward: false,
    });
    expect(create.headers).toMatchObject({
      'x-xsrftoken': '<XSRF>',
      'x-requested-with': 'fetch',
      Origin: ZHUANLAN,
      Referer: `${ZHUANLAN}/write`,
    });
    expect(create.headers!.Cookie).toBe('z_c0=<Z_C0>; _xsrf=<XSRF>; d_c0=<D_C0>; BEC=<BEC>');
    expect(
      m.requests.filter((r) => r.url.includes('zhihu')).every((r) => r.platform === 'zhihu'),
    ).toBe(true);
    expect(m.state.drafts[SOURCE].zhihu).toMatchObject({
      account: '<USER_ID>',
      draftId: '<DRAFT_ID>',
      status: 'confirmed',
    });
    const hash = await sha256Hex(new Uint8Array([0x89, 1]));
    expect(m.state.images[hash].zhihu?.['<USER_ID>']).toMatchObject({
      md5,
      width: 800,
      height: 600,
    });
  });
  it('请求间隔不少于 300 毫秒', async () => {
    const m = setup();
    await zhihuPublisher.push(await article(BODY, 'zhihu'), context(m.host));
    const times = m.requests
      .map((r, i) => ({ r, at: m.times[i] }))
      .filter(({ r }) => !r.url.startsWith('https://zhihu-pics-upload'))
      .map(({ at }) => at);
    for (let i = 1; i < times.length; i++)
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(300);
  });
  it('重推：沿用映射 PATCH 原草稿，图片走缓存，提示已发布文章只改草稿', async () => {
    const m = setup();
    const a = await article(BODY, 'zhihu');
    await zhihuPublisher.push(a, context(m.host));
    const applied = m.calls('POST', 'https://api.zhihu.com/images').length;
    const again = await zhihuPublisher.push(a, context(m.host));
    expect(again).toMatchObject({ outcome: 'updated', draftRef: '<DRAFT_ID>', uploadedImages: 0 });
    expect(again.outcome === 'updated' && again.warnings.map((w) => w.code)).toContain(
      'ZHIHU_DRAFT_UPDATED',
    );
    expect(m.calls('POST', 'https://api.zhihu.com/images')).toHaveLength(applied);
    expect(m.calls('POST', `${ZHUANLAN}/api/articles/drafts`)).toHaveLength(1);
  });
  it('PATCH 404 视为草稿不可用，新建并提示；403 按风控处理，绝不新建', async () => {
    const gone = setup({ patch: [{ status: 404, json: Z.draft_not_found }, { json: {} }] });
    gone.state = {
      ...gone.state,
      drafts: {
        [SOURCE]: {
          zhihu: { account: '<USER_ID>', draftId: 'OLD', status: 'confirmed', updatedAt: '' },
        },
      },
    };
    const recreated = await zhihuPublisher.push(await article(BODY, 'zhihu'), context(gone.host));
    expect(recreated).toMatchObject({ outcome: 'created', draftRef: '<DRAFT_ID>' });
    expect(recreated.outcome === 'created' && recreated.warnings.map((w) => w.code)).toContain(
      'ZHIHU_DRAFT_GONE',
    );
    const risky = setup({ patch: [{ status: 403, json: Z.risk_control }] });
    risky.state = {
      ...risky.state,
      drafts: {
        [SOURCE]: {
          zhihu: { account: '<USER_ID>', draftId: 'OLD', status: 'confirmed', updatedAt: '' },
        },
      },
    };
    const blocked = await zhihuPublisher.push(await article(BODY, 'zhihu'), context(risky.host));
    expect(blocked).toMatchObject({ outcome: 'failed', error: { code: 'ZHIHU_RISK_CONTROL' } });
    expect(risky.calls('POST', `${ZHUANLAN}/api/articles/drafts`)).toHaveLength(0);
    expect(risky.state.drafts[SOURCE].zhihu?.draftId).toBe('OLD');
  });
  it('建草稿超时记为结果不确定，确认后才重建', async () => {
    const m = setup({ create: [new TransportError('timeout'), { json: Z.draft_created }] });
    const a = await article(BODY, 'zhihu');
    expect(await zhihuPublisher.push(a, context(m.host))).toMatchObject({ outcome: 'uncertain' });
    expect(m.state.drafts[SOURCE].zhihu).toMatchObject({ status: 'uncertain' });
    expect(await zhihuPublisher.push(a, context(m.host))).toMatchObject({
      outcome: 'failed',
      error: { code: 'OUTCOME_UNCERTAIN' },
    });
    expect(await zhihuPublisher.push(a, context(m.host, { confirmUncertain: true }))).toMatchObject(
      { outcome: 'created' },
    );
    expect(m.calls('POST', `${ZHUANLAN}/api/articles/drafts`)).toHaveLength(2);
  });
  it('知乎已有同一张图时不直传；处理迟迟未完成时用固定地址且不写缓存', async () => {
    const existing = setup({ images: [{ json: Z.image_existing }] });
    await zhihuPublisher.push(await article(BODY, 'zhihu'), context(existing.host));
    expect(existing.calls('PUT', 'https://zhihu-pics-upload.zhimg.com/')).toHaveLength(0);
    const slow = setup({ status: [{ json: Z.image_processing }] });
    const result = await zhihuPublisher.push(await article(BODY, 'zhihu'), context(slow.host));
    expect(result.outcome).toBe('created');
    const md5 = md5Hex(new Uint8Array([0x89, 1, 1]));
    expect(bodyText(slow.calls('PATCH', PATCH_URL)[0])).toContain(
      `https://picx.zhimg.com/v2-${md5}.png`,
    );
    expect(Object.keys(slow.state.images)).toHaveLength(0);
  });
  it('超出安全整数的草稿 id 与图片 id 按原文保留', async () => {
    const m = setup({
      create: [
        {
          text: '{"id":1986773875875403109,"url":"https://zhuanlan.zhihu.com/p/1986773875875403109","author":{"id":"a"}}',
          headers: { 'content-type': 'application/json' },
        },
      ],
      images: [
        {
          text: '{"upload_file":{"state":1,"image_id":1986773875875409999}}',
          headers: { 'content-type': 'application/json' },
        },
      ],
    });
    const result = await zhihuPublisher.push(await article(BODY, 'zhihu'), context(m.host));
    expect(result).toMatchObject({ outcome: 'created', draftRef: '1986773875875403109' });
    expect(
      m.calls('GET', 'https://api.zhihu.com/images/1986773875875409999').length,
    ).toBeGreaterThan(0);
  });
  it('复制路径要求已登录，上传后只给 src', async () => {
    const none = mockHost(routes());
    const a = await article(BODY, 'zhihu');
    await expect(createZhihuCopyStore(context(none.host), a.images.length)).rejects.toThrow(
      '还没有登录知乎',
    );
    const m = setup();
    const store = await createZhihuCopyStore(context(m.host), a.images.length);
    const placed = await placeImages(a, store);
    expect(placed.html).toContain('src="https://pic1.zhimg.com/v2-&lt;MD5&gt;.png"');
    expect(placed.html).not.toContain('data-rawwidth');
    expect(m.calls('POST', `${ZHUANLAN}/api/articles/drafts`)).toHaveLength(0);
  });
});
describe('知乎登录态', () => {
  it('解析 cookie 串与开发者工具表格，只保留草稿链路需要的项并报出缺项', () => {
    expect(parseZhihuCookies('Cookie: z_c0="abc"; _xsrf=x; other=1; d_c0=d')).toEqual({
      cookies: { z_c0: 'abc', _xsrf: 'x', d_c0: 'd' },
      missing: [],
    });
    expect(parseZhihuCookies('z_c0\tabc\t.zhihu.com\n_xsrf\tx\t.zhihu.com').missing).toEqual([
      'd_c0',
    ]);
    expect(parseZhihuCookies('').missing).toEqual(['z_c0', '_xsrf', 'd_c0']);
  });
  it('登录校验通过才写共享登录态，缺项时报出缺哪个', async () => {
    const m = mockHost(routes());
    const user = await saveZhihuLogin(m.host, { z_c0: 'a', _xsrf: 'b', d_c0: 'c', extra: 'x' });
    expect(user).toEqual({
      id: '<USER_ID>',
      name: '示例作者',
      avatarUrl: 'https://picx.zhimg.com/<AVATAR>_l.jpg',
    });
    expect(m.secrets['zhihu-session']).toMatchObject({
      cookies: { z_c0: 'a', _xsrf: 'b', d_c0: 'c' },
      user,
    });
    expect(m.secrets['zhihu-session']?.cookies).not.toHaveProperty('extra');
    await expect(saveZhihuLogin(m.host, { z_c0: 'a' })).rejects.toThrow('缺少 _xsrf、d_c0');
    const rejected = mockHost(routes({ me: [{ status: 401, json: Z.unauthorized }] }));
    await expect(
      saveZhihuLogin(rejected.host, { z_c0: 'a', _xsrf: 'b', d_c0: 'c' }),
    ).rejects.toThrow();
    expect(rejected.secrets['zhihu-session']).toBeUndefined();
  });
});
