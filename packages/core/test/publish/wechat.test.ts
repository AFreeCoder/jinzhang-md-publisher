import { describe, expect, it } from 'vitest';
import { describe as describeArticle, TransportError, wechatPublisher } from '../../src/publish';
import { article, context } from './article';
import { sha256Hex } from '../../src/publish/hash';
import { bodyText, mockHost, type Reply, type Route } from './mock-host';
import W from './fixtures/wechat.json';
const API = 'https://api.weixin.qq.com/cgi-bin';
const SOURCE = '/notes/测试文章.md';
const APP_ID = 'wx0123456789abcdef';
const APP_SECRET = '<APP_SECRET>';
let media = 0;
function routes(
  o: Partial<
    Record<'ipify' | 'token' | 'count' | 'upload' | 'material' | 'add' | 'update' | 'get', Reply[]>
  > = {},
): Route[] {
  return [
    { match: 'https://api.ipify.org', replies: o.ipify ?? [{ json: W.ipify }] },
    {
      method: 'POST',
      match: `${API}/stable_token`,
      replies: o.token ?? [{ json: W.stable_token }],
    },
    { match: `${API}/draft/count`, replies: o.count ?? [{ json: W.draft_count }] },
    {
      method: 'POST',
      match: `${API}/media/uploadimg`,
      replies: o.upload ?? [
        () => ({ json: { url: `http://mmbiz.qpic.cn/mmbiz_png/<MEDIA_${++media}>/0?wx_fmt=png` } }),
      ],
    },
    {
      method: 'POST',
      match: `${API}/material/add_material`,
      replies: o.material ?? [{ json: W.add_material }],
    },
    { method: 'POST', match: `${API}/draft/add`, replies: o.add ?? [{ json: W.draft_add }] },
    {
      method: 'POST',
      match: `${API}/draft/update`,
      replies: o.update ?? [{ json: W.draft_update }],
    },
    {
      method: 'POST',
      match: `${API}/draft/get`,
      replies: o.get ?? [{ json: readback('测试文章') }],
    },
    { match: 'https://img.example.test/', replies: [{ bytes: new Uint8Array([0xff, 9]) }] },
  ];
}
const readback = (title: string) => ({
  ...W.draft_get,
  news_item: [{ ...W.draft_get.news_item[0], title }],
});
function setup(o?: Parameters<typeof routes>[0]) {
  const m = mockHost(routes(o));
  m.secrets.credentials = { wechat: { appId: APP_ID, appSecret: APP_SECRET } };
  return m;
}
const BODY =
  '![图](./a.png)\n\n正文段落\n\n![同一张](./same.png)\n\n![另一张](./b.jpg)\n\n![远程](https://img.example.test/r.png)';
describe('公众号体检', () => {
  it('凭证、白名单、封面与图片都通过，只读不上传，记下出口 IP 与 token 缓存', async () => {
    const m = setup();
    const report = await wechatPublisher.preflight(await article(BODY), context(m.host));
    expect(report.blockers).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      platform: 'wechat',
      account: 'wx0123…cdef',
      draft: 'create',
      images: 4,
      cover: './a.png',
      egressIp: '203.0.113.7',
      uncertain: false,
    });
    expect(m.calls('POST', /uploadimg|add_material|draft\/add/)).toHaveLength(0);
    expect(m.state.wechatEgressIp).toBe('203.0.113.7');
    expect(m.secrets['wechat-token']).toMatchObject({
      appId: APP_ID,
      accessToken: '<ACCESS_TOKEN>',
    });
    const apiRequests = m.requests.filter((r) => /weixin|ipify/.test(r.url));
    expect(apiRequests.every((r) => r.platform === 'wechat')).toBe(true);
    expect(m.calls('GET', 'https://img.example.test/')[0].platform).toBeUndefined();
  });
  it('40164 给出被拒 IP、本机出口 IP 与白名单路径，出口变化提前警告', async () => {
    const m = setup({ token: [{ json: W.ip_not_whitelisted }] });
    m.state = { ...m.state, wechatEgressIp: '192.0.2.1' };
    const report = await wechatPublisher.preflight(await article(BODY), context(m.host));
    expect(report.ok).toBe(false);
    expect(report.blockers[0]).toMatchObject({
      code: 'WECHAT_IP_NOT_WHITELISTED',
      stage: 'preflight',
      platform: 'wechat',
      ref: '198.51.100.23',
    });
    expect(report.blockers[0].message).toContain('203.0.113.7');
    expect(report.blockers[0].action).toContain('设置与开发 → 基本配置 → IP 白名单');
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: 'EGRESS_IP_CHANGED', ref: '203.0.113.7' }),
    );
    expect(m.state.wechatEgressIp).toBe('192.0.2.1');
  });
  it('缺凭证、缺封面、缺图、无法转换与动图逐条列出', async () => {
    const m = mockHost(routes());
    const plain = await wechatPublisher.preflight(await article('没有图片的正文'), context(m.host));
    expect(plain.blockers.map((b) => b.code)).toEqual(['CONFIG_MISSING', 'COVER_MISSING']);
    const broken = await wechatPublisher.preflight(
      await article('![](./missing.png)\n\n![](./bad.svg)\n\n![](./anim.gif)'),
      context(m.host),
    );
    expect(broken.blockers.map((b) => [b.code, b.ref])).toEqual([
      ['CONFIG_MISSING', undefined],
      ['IMAGE_MISSING', './missing.png'],
      ['IMAGE_UNCONVERTIBLE', './bad.svg'],
    ]);
    expect(broken.blockers[1].message).toContain('找过 /notes/missing.png');
    expect(broken.warnings).toContainEqual(
      expect.objectContaining({ code: 'GIF_FIRST_FRAME', ref: './anim.gif' }),
    );
  });
  it('正文长度按每张图 512 字符的地址预算预估，达到 2 万阻止', async () => {
    const m = setup();
    const base = await article('![图](./a.png)');
    const padded = (length: number) => ({
      ...base,
      html: base.html + 'x'.repeat(length - base.html.length),
    });
    const blocked = await wechatPublisher.preflight(padded(19_900), context(m.host));
    expect(blocked.summary.estimatedChars).toBe(19_900 + 512 - 'jz-img:0'.length);
    expect(blocked.blockers.map((b) => b.code)).toEqual(['WECHAT_CONTENT_TOO_LONG']);
    const fine = await wechatPublisher.preflight(padded(19_000), context(m.host));
    expect(fine.ok).toBe(true);
  });
  it('模板变量缺值时提示整行不显示', async () => {
    const m = setup();
    const report = await wechatPublisher.preflight(
      await article(BODY),
      context(m.host, {
        fixed: { header: true, footer: false },
        templates: { header: '作者 {{author}}\n标题 {{title}}\n{{slogan}} {{foo}}' },
        variables: { date: '2026-09-30' },
      }),
    );
    expect(report.warnings).toContainEqual({
      code: 'TEMPLATE_VARIABLE_MISSING',
      message: '开头里的作者、顶部宣言、 {{foo}} 没有取值，所在行不会显示。',
    });
  });
});
describe('公众号推送', () => {
  it('首次推送：正文图按内容去重上传、封面走永久素材、建草稿后回读确认', async () => {
    const m = setup();
    const ctx = context(m.host);
    const a = await article(BODY);
    expect((await wechatPublisher.preflight(a, ctx)).ok).toBe(true);
    const result = await wechatPublisher.push(a, ctx);
    expect(result).toMatchObject({
      outcome: 'created',
      draftRef: '<DRAFT_MEDIA_ID>',
      entryUrl: 'https://mp.weixin.qq.com/',
      verification: 'confirmed',
      uploadedImages: 3,
    });
    expect(m.calls('POST', /uploadimg/)).toHaveLength(3);
    expect(m.calls('GET', 'https://img.example.test/')).toHaveLength(1);
    const upload = m.calls('POST', /uploadimg/)[0];
    expect(upload.headers?.['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(bodyText(upload)).toContain('name="media"; filename="image.png"');
    expect(m.calls('POST', /add_material/)[0].url).toContain('type=image');
    const add = JSON.parse(bodyText(m.calls('POST', /draft\/add/)[0])).articles[0];
    expect(add).toMatchObject({
      article_type: 'news',
      title: '测试文章',
      thumb_media_id: '<COVER_MEDIA_ID>',
    });
    expect(Object.keys(add).sort()).toEqual(['article_type', 'content', 'thumb_media_id', 'title']);
    expect(add.content).not.toContain('jz-img:');
    expect(add.content.match(/src="http:\/\/mmbiz\.qpic\.cn/g)).toHaveLength(4);
    expect(m.state.drafts[SOURCE].wechat).toMatchObject({
      account: APP_ID,
      mediaId: '<DRAFT_MEDIA_ID>',
      status: 'confirmed',
      title: '测试文章',
    });
    const hash = await sha256Hex(new Uint8Array([0x89, 1]));
    expect(m.state.images[hash].wechat?.[APP_ID]).toMatch(/^http:\/\/mmbiz\.qpic\.cn/);
    expect(m.state.covers[hash].wechat?.[APP_ID]).toBe('<COVER_MEDIA_ID>');
  });
  it('重推更新原草稿，图片与封面走缓存不再上传', async () => {
    const m = setup();
    const a = await article(BODY);
    await wechatPublisher.push(a, context(m.host));
    const before = m.requests.length;
    const again = await wechatPublisher.push(a, context(m.host));
    expect(again).toMatchObject({
      outcome: 'updated',
      draftRef: '<DRAFT_MEDIA_ID>',
      uploadedImages: 0,
    });
    const later = m.requests.slice(before);
    expect(later.filter((r) => /uploadimg|add_material|draft\/add/.test(r.url))).toHaveLength(0);
    const update = JSON.parse(bodyText(m.calls('POST', /draft\/update/)[0]));
    expect(update).toMatchObject({ media_id: '<DRAFT_MEDIA_ID>', index: 0 });
    expect(update.articles.title).toBe('测试文章');
    expect(m.calls('POST', /stable_token/)).toHaveLength(1);
  });
  it('更新报 40007 且回读也是 40007：原草稿已删除或已发布，新建并提示', async () => {
    const m = setup({
      update: [{ json: W.invalid_media_id }],
      get: [{ json: W.invalid_media_id }, { json: readback('测试文章') }],
    });
    m.state = {
      ...m.state,
      drafts: {
        [SOURCE]: {
          wechat: { account: APP_ID, mediaId: 'OLD', status: 'confirmed', updatedAt: '' },
        },
      },
    };
    const result = await wechatPublisher.push(await article(BODY), context(m.host));
    expect(result).toMatchObject({ outcome: 'created', draftRef: '<DRAFT_MEDIA_ID>' });
    expect(result.outcome === 'created' && result.warnings.map((w) => w.code)).toContain(
      'WECHAT_DRAFT_GONE',
    );
    expect(m.calls('POST', /draft\/add/)).toHaveLength(1);
  });
  it('更新报 40007 但草稿还在：缓存的封面素材失效，重传封面后再更新', async () => {
    const m = setup({
      update: [{ json: W.invalid_media_id }, { json: W.draft_update }],
      material: [{ json: { ...W.add_material, media_id: '<NEW_COVER>' } }],
    });
    const hash = await sha256Hex(new Uint8Array([0x89, 1]));
    m.state = {
      ...m.state,
      drafts: {
        [SOURCE]: {
          wechat: { account: APP_ID, mediaId: 'OLD', status: 'confirmed', updatedAt: '' },
        },
      },
      covers: { [hash]: { wechat: { [APP_ID]: '<STALE_COVER>' } } },
    };
    const result = await wechatPublisher.push(await article(BODY), context(m.host));
    expect(result).toMatchObject({ outcome: 'updated', draftRef: 'OLD' });
    const updates = m.calls('POST', /draft\/update/).map((r) => JSON.parse(bodyText(r)));
    expect(updates.map((u) => u.articles.thumb_media_id)).toEqual(['<STALE_COVER>', '<NEW_COVER>']);
    expect(m.state.covers[hash].wechat?.[APP_ID]).toBe('<NEW_COVER>');
    expect(m.calls('POST', /draft\/add/)).toHaveLength(0);
  });
  it('建草稿超时记为结果不确定，确认前不再创建，确认后才重建', async () => {
    const m = setup({ add: [new TransportError('timeout'), { json: W.draft_add }] });
    const a = await article(BODY);
    const first = await wechatPublisher.push(a, context(m.host));
    expect(first).toMatchObject({ outcome: 'uncertain', error: { code: 'OUTCOME_UNCERTAIN' } });
    expect(m.state.drafts[SOURCE].wechat).toMatchObject({ status: 'uncertain', account: APP_ID });
    expect(m.state.drafts[SOURCE].wechat?.mediaId).toBeUndefined();
    const report = await wechatPublisher.preflight(a, context(m.host));
    expect(report.summary.uncertain).toBe(true);
    expect(report.blockers.map((b) => b.code)).toContain('OUTCOME_UNCERTAIN');
    const blocked = await wechatPublisher.push(a, context(m.host));
    expect(blocked).toMatchObject({ outcome: 'failed', error: { code: 'OUTCOME_UNCERTAIN' } });
    expect(m.calls('POST', /draft\/add/)).toHaveLength(1);
    const confirmed = await wechatPublisher.push(a, context(m.host, { confirmUncertain: true }));
    expect(confirmed).toMatchObject({ outcome: 'created', draftRef: '<DRAFT_MEDIA_ID>' });
    expect(m.calls('POST', /draft\/add/)).toHaveLength(2);
  });
  it('45002 报出实际字符数，图片上传中断不建草稿', async () => {
    const m = setup({ add: [{ json: W.content_too_long }] });
    const result = await wechatPublisher.push(await article(BODY), context(m.host));
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'WECHAT_CONTENT_TOO_LONG' } });
    expect(result.outcome === 'failed' && result.error.message).toMatch(/实际 \d+ 字符/);
    const broken = setup({ upload: [new TransportError('network')] });
    const failed = await wechatPublisher.push(await article(BODY), context(broken.host));
    expect(failed).toMatchObject({ outcome: 'failed', error: { code: 'NETWORK_ERROR' } });
    expect(broken.calls('POST', /draft\/add/)).toHaveLength(0);
    expect(broken.state.drafts[SOURCE]).toBeUndefined();
  });
  it('token 落盘复用，过期或被作废时重新获取', async () => {
    const m = setup({ count: [{ json: W.invalid_credential }, { json: W.draft_count }] });
    const a = await article(BODY);
    await wechatPublisher.preflight(a, context(m.host));
    expect(m.calls('POST', /stable_token/)).toHaveLength(2);
    await wechatPublisher.preflight(a, context(m.host));
    expect(m.calls('POST', /stable_token/)).toHaveLength(2);
    await m.host.sleep!(7200 * 1000);
    await wechatPublisher.preflight(a, context(m.host));
    expect(m.calls('POST', /stable_token/)).toHaveLength(3);
    const token = JSON.parse(bodyText(m.calls('POST', /stable_token/)[0]));
    expect(token).toEqual({
      grant_type: 'client_credential',
      appid: APP_ID,
      secret: APP_SECRET,
      force_refresh: false,
    });
  });
  it('凭证无效与无权限按错误码翻译，其余错误码原样透出', async () => {
    for (const [reply, code] of [
      [W.invalid_appsecret, 'WECHAT_BAD_CREDENTIALS'],
      [W.no_permission, 'WECHAT_NO_PERMISSION'],
      [{ errcode: 61024, errmsg: 'other' }, 'WECHAT_API_61024'],
    ] as const) {
      const m = setup({ token: [{ json: reply }] });
      const report = await wechatPublisher.preflight(await article(BODY), context(m.host));
      expect(report.blockers[0].code).toBe(code);
    }
  });
  it('映射属于另一个 AppID 时视为没有映射，新建并提示', async () => {
    const m = setup();
    m.state = {
      ...m.state,
      drafts: {
        [SOURCE]: {
          wechat: { account: 'wxOTHER', mediaId: 'X', status: 'confirmed', updatedAt: '' },
        },
      },
    };
    const a = await article(BODY);
    const report = await wechatPublisher.preflight(a, context(m.host));
    expect(report.summary.draft).toBe('create');
    expect(report.warnings.map((w) => w.code)).toContain('DRAFT_ACCOUNT_CHANGED');
    expect(await wechatPublisher.push(a, context(m.host))).toMatchObject({ outcome: 'created' });
    expect(m.calls('POST', /draft\/update/)).toHaveLength(0);
  });
  it('体检、摘要与结果里都不出现 AppSecret 与 token', async () => {
    const m = setup({ add: [{ json: W.content_too_long }] });
    const a = await article(BODY);
    const outputs = [
      await wechatPublisher.preflight(a, context(m.host)),
      await wechatPublisher.push(a, context(m.host)),
      await describeArticle(a, context(m.host)),
    ];
    const text = JSON.stringify(outputs);
    expect(text).not.toContain(APP_SECRET);
    expect(text).not.toContain('<ACCESS_TOKEN>');
    expect(JSON.stringify(m.state)).not.toContain('<ACCESS_TOKEN>');
  });
  it('确认摘要不联网：账号、封面、图片数、开头结尾、创建还是更新', async () => {
    const m = setup();
    const summary = await describeArticle(
      await article(BODY),
      context(m.host, { fixed: { header: true, footer: false } }),
    );
    expect(summary).toMatchObject({
      account: 'wx0123…cdef',
      cover: './a.png',
      images: 4,
      header: true,
      footer: false,
      draft: 'create',
    });
    expect(m.requests).toHaveLength(0);
  });
});
