import { describe, expect, it } from 'vitest';
import {
  newspicPublisher,
  prepareNewspic,
  TransportError,
  wechatPublisher,
  type NewspicArticle,
} from '../../src/publish';
import { previewNewspic } from '../../src/preview';
import { article as newsArticle, context, resolver } from './article';
import { sha256Hex } from '../../src/publish/hash';
import { bodyText, mockHost, type Reply, type Route } from './mock-host';
import W from './fixtures/wechat.json';
const API = 'https://api.weixin.qq.com/cgi-bin';
const SOURCE = '/notes/测试文章.md';
const APP_ID = 'wx0123456789abcdef';
let material = 0;
const readback = (title: string, images: number) => ({
  news_item: [
    {
      article_type: 'newspic',
      title,
      content: '<CONTENT>',
      image_info: {
        image_list: Array.from({ length: images }, (_, i) => ({ image_media_id: `<M${i}>` })),
      },
      url: 'http://mp.weixin.qq.com/s?__biz=<BIZ>&tempkey=<TEMPKEY>',
    },
  ],
});
function routes(
  o: Partial<Record<'token' | 'material' | 'add' | 'update' | 'get', Reply[]>> = {},
): Route[] {
  return [
    { match: 'https://api.ipify.org', replies: [{ json: W.ipify }] },
    {
      method: 'POST',
      match: `${API}/stable_token`,
      replies: o.token ?? [{ json: W.stable_token }],
    },
    { match: `${API}/draft/count`, replies: [{ json: W.draft_count }] },
    {
      method: 'POST',
      match: `${API}/media/uploadimg`,
      replies: [{ json: W.uploadimg }],
    },
    {
      method: 'POST',
      match: `${API}/material/add_material`,
      replies: o.material ?? [() => ({ json: { media_id: `<IMG_${++material}>`, url: 'x' } })],
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
      replies: o.get ?? [{ json: readback('测试文章', 3) }],
    },
    { match: 'https://img.example.test/', replies: [{ bytes: new Uint8Array([0xff, 9]) }] },
  ];
}
function setup(o?: Parameters<typeof routes>[0]) {
  material = 0;
  const m = mockHost(routes(o));
  m.secrets.credentials = { wechat: { appId: APP_ID, appSecret: '<APP_SECRET>' } };
  return m;
}
const newspic = (markdown: string, cover?: string) =>
  prepareNewspic({ markdown, title: '测试文章', cover }, resolver);
const BODY =
  '# 测试文章\n\n![图](./a.png)\n\n第一段，有[链接](https://example.test)。\n\n![同一张](./a.png)\n\n![另一张](./b.jpg)\n\n第二段\n\n![远程](https://img.example.test/r.png)';
const sentDraft = (m: ReturnType<typeof setup>, kind: 'add' | 'update', index = 0) => {
  const body = JSON.parse(bodyText(m.calls('POST', new RegExp(`draft/${kind}`))[index]));
  return kind === 'add' ? body.articles[0] : body.articles;
};

describe('贴图的内容', () => {
  it('图片按出现顺序去重，文字转成纯文本，标题相同的一级标题去掉', async () => {
    const a = await newspic(BODY);
    expect(a.images.map((i) => i.original)).toEqual([
      './a.png',
      './b.jpg',
      'https://img.example.test/r.png',
    ]);
    expect(a.text).toBe('第一段，有链接。\n\n第二段');
    expect(a.stats).toEqual({ visibleTextChars: 11, imageCount: 3 });
    expect(a.warnings.map((w) => w.code)).toEqual(['NEWSPIC_LINKS_DROPPED']);
  });
  it('列表留下符号与序号，小标题、引用、代码、表格按普通文字，HTML 图片也算', async () => {
    const a = await newspic(
      '## 三个要点\n\n- 第一\n- **第二**\n\n1. 甲\n2. 乙\n\n> 引用的话\n\n```\ncode line\n```\n\n| 列 | 值 |\n| - | - |\n| a | 1 |\n\n<p>段落<br>换行 &amp; 符号</p>\n\n<img src="./b.jpg">\n\n---\n\n收尾',
    );
    expect(a.text).toBe(
      '三个要点\n\n• 第一\n• 第二\n\n1. 甲\n2. 乙\n\n引用的话\n\ncode line\n\n列　值\na　1\n\n段落\n换行 & 符号\n\n收尾',
    );
    expect(a.images.map((i) => i.original)).toEqual(['./b.jpg']);
    expect(a.warnings.map((w) => w.code)).toEqual(['NEWSPIC_FORMAT_DROPPED']);
  });
  it('单独设置的封面排第一；就是正文里的某张图时不重复', async () => {
    const separate = await newspic(BODY, './b.jpg');
    expect(separate.images.map((i) => i.original)).toEqual([
      './b.jpg',
      './a.png',
      'https://img.example.test/r.png',
    ]);
    const outside = await newspic('只有文字', './a.png');
    expect(outside.images.map((i) => i.original)).toEqual(['./a.png']);
  });
  it('标题超过 32 字、缺图都提示', async () => {
    const a = await prepareNewspic(
      { markdown: '文字\n\n![](./missing.png)', title: '标'.repeat(33) },
      resolver,
    );
    expect(a.warnings.map((w) => [w.code, w.ref])).toEqual([
      ['TITLE_TOO_LONG', undefined],
      ['IMAGE_MISSING', './missing.png'],
    ]);
  });
  it('预览：图片横向翻页，第一张标封面，文字原样换行并转义', () => {
    const html = previewNewspic(
      {
        title: '标<题>',
        text: '一行\n两行 <b>',
        images: ['data:image/png;base64,AA', 'https://x.test/a.png'],
      },
      { account: '码农', date: '11月2日' },
    );
    expect(html).toContain('1/2 · 封面');
    expect(html).toContain('共 2 张，左右滑动查看');
    expect(html).toContain('一行\n两行 &lt;b&gt;');
    expect(html).toContain('标&lt;题&gt;');
    expect(html).not.toContain('<script');
    expect(previewNewspic({ title: '', text: '', images: [] })).toContain('贴图还没有图片');
  });
});

describe('贴图体检', () => {
  it('通过时只读不上传：账号、首图当封面、图片数、新建', async () => {
    const m = setup();
    const report = await newspicPublisher.preflight(await newspic(BODY), context(m.host));
    expect(report.blockers).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      platform: 'wechat',
      account: 'wx0123…cdef',
      draft: 'create',
      images: 3,
      cover: './a.png',
      header: false,
      footer: false,
      egressIp: '203.0.113.7',
      visibleTextChars: 11,
    });
    expect(m.calls('POST', /add_material|draft\/add/)).toHaveLength(0);
  });
  it('没图、超过 20 张、只有图没有字、缺凭证、图片坏了逐条列出', async () => {
    const m = mockHost(routes());
    const empty = await newspicPublisher.preflight(await newspic('只有文字'), context(m.host));
    expect(empty.blockers.map((b) => b.code)).toEqual(['CONFIG_MISSING', 'NEWSPIC_NO_IMAGE']);
    const onlyImages = await newspicPublisher.preflight(
      await newspic('![](./a.png)\n\n![](./missing.png)\n\n![](./bad.svg)\n\n![](./anim.gif)'),
      context(m.host),
    );
    expect(onlyImages.blockers.map((b) => [b.code, b.ref])).toEqual([
      ['CONFIG_MISSING', undefined],
      ['NEWSPIC_TEXT_EMPTY', undefined],
      ['IMAGE_MISSING', './missing.png'],
      ['IMAGE_UNCONVERTIBLE', './bad.svg'],
    ]);
    expect(onlyImages.warnings).toContainEqual(
      expect.objectContaining({ code: 'GIF_FIRST_FRAME', ref: './anim.gif' }),
    );
    const many = await newspic(
      `文字\n\n${Array.from({ length: 21 }, (_, i) => `![](https://img.example.test/${i}.png)`).join('\n\n')}`,
    );
    const crowded = await newspicPublisher.preflight(many, context(setup().host));
    expect(crowded.blockers.map((b) => b.code)).toEqual(['NEWSPIC_TOO_MANY_IMAGES']);
    expect(crowded.blockers[0].message).toContain('21 张');
  });
  it('文字超过 1000 字提示，不阻止', async () => {
    const report = await newspicPublisher.preflight(
      await newspic(`![](./a.png)\n\n${'字'.repeat(1001)}`),
      context(setup().host),
    );
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => w.code)).toContain('NEWSPIC_TEXT_LONG');
  });
});

describe('贴图推送', () => {
  it('首次推送：每张图传一次永久素材，建贴图草稿，记下类型与素材缓存', async () => {
    const m = setup();
    const a = await newspic(BODY);
    const result = await newspicPublisher.push(a, context(m.host));
    expect(result).toMatchObject({
      outcome: 'created',
      draftRef: '<DRAFT_MEDIA_ID>',
      entryUrl: 'https://mp.weixin.qq.com/',
      verification: 'confirmed',
      uploadedImages: 3,
    });
    const uploads = m.calls('POST', /add_material/);
    expect(uploads).toHaveLength(3);
    expect(uploads.every((r) => r.url.includes('type=image'))).toBe(true);
    expect(m.calls('POST', /uploadimg/)).toHaveLength(0);
    const draft = sentDraft(m, 'add');
    expect(draft).toEqual({
      article_type: 'newspic',
      title: '测试文章',
      content: '第一段，有链接。\n\n第二段',
      image_info: {
        image_list: [
          { image_media_id: '<IMG_1>' },
          { image_media_id: '<IMG_2>' },
          { image_media_id: '<IMG_3>' },
        ],
      },
    });
    expect(m.state.drafts[SOURCE].wechat).toMatchObject({
      account: APP_ID,
      articleType: 'newspic',
      mediaId: '<DRAFT_MEDIA_ID>',
      status: 'confirmed',
    });
    const hash = await sha256Hex(new Uint8Array([0x89, 1]));
    expect(m.state.covers[hash].wechat?.[APP_ID]).toBe('<IMG_1>');
  });
  it('内容相同的两张图只传一次、只占一个位置', async () => {
    const m = setup({ get: [{ json: readback('测试文章', 1) }] });
    const result = await newspicPublisher.push(
      await newspic('文字\n\n![](./a.png)\n\n![](./same.png)'),
      context(m.host),
    );
    expect(result).toMatchObject({ outcome: 'created', uploadedImages: 1 });
    expect(sentDraft(m, 'add').image_info.image_list).toHaveLength(1);
  });
  it('重推更新原草稿，图片走缓存不再上传', async () => {
    const m = setup();
    const a = await newspic(BODY);
    await newspicPublisher.push(a, context(m.host));
    const report = await newspicPublisher.preflight(a, context(m.host));
    expect(report.summary).toMatchObject({ draft: 'update', draftRef: '<DRAFT_MEDIA_ID>' });
    const again = await newspicPublisher.push(a, context(m.host));
    expect(again).toMatchObject({ outcome: 'updated', uploadedImages: 0 });
    expect(m.calls('POST', /add_material/)).toHaveLength(3);
    const update = JSON.parse(bodyText(m.calls('POST', /draft\/update/)[0]));
    expect(update).toMatchObject({ media_id: '<DRAFT_MEDIA_ID>', index: 0 });
    expect(update.articles.article_type).toBe('newspic');
  });
  it('之前推过图文草稿：新建贴图草稿并提示，反过来也一样', async () => {
    const m = setup();
    await wechatPublisher.push(await newsArticle('![图](./a.png)\n\n正文'), context(m.host, {}));
    expect(m.state.drafts[SOURCE].wechat?.articleType).toBeUndefined();
    const a = await newspic(BODY);
    const report = await newspicPublisher.preflight(a, context(m.host));
    expect(report.summary.draft).toBe('create');
    expect(report.warnings.map((w) => w.code)).toContain('DRAFT_TYPE_CHANGED');
    const pushed = await newspicPublisher.push(a, context(m.host));
    expect(pushed).toMatchObject({ outcome: 'created' });
    expect(pushed.outcome === 'created' && pushed.warnings[0].message).toBe(
      '这篇之前推过图文草稿，这次会新建一份贴图草稿，旧草稿留在草稿箱里。',
    );
    expect(m.calls('POST', /draft\/update/)).toHaveLength(0);
    const news = await wechatPublisher.preflight(
      await newsArticle('![图](./a.png)\n\n正文'),
      context(m.host),
    );
    expect(news.summary.draft).toBe('create');
    expect(news.warnings.map((w) => w.code)).toContain('DRAFT_TYPE_CHANGED');
  });
  it('更新报 40007 但草稿还在：缓存的素材失效，重传全部图片再更新', async () => {
    const m = setup({ update: [{ json: W.invalid_media_id }, { json: W.draft_update }] });
    const hash = await sha256Hex(new Uint8Array([0x89, 1]));
    m.state = {
      ...m.state,
      drafts: {
        [SOURCE]: {
          wechat: {
            account: APP_ID,
            articleType: 'newspic',
            mediaId: 'OLD',
            status: 'confirmed',
            updatedAt: '',
          },
        },
      },
      covers: { [hash]: { wechat: { [APP_ID]: '<STALE>' } } },
    };
    const result = await newspicPublisher.push(await newspic(BODY), context(m.host));
    expect(result).toMatchObject({ outcome: 'updated', draftRef: 'OLD' });
    const updates = m.calls('POST', /draft\/update/).map((r) => JSON.parse(bodyText(r)));
    expect(updates.map((u) => u.articles.image_info.image_list[0].image_media_id)).toEqual([
      '<STALE>',
      '<IMG_3>',
    ]);
    expect(m.state.covers[hash].wechat?.[APP_ID]).toBe('<IMG_3>');
  });
  it('建草稿超时记为结果不确定，确认后才重建', async () => {
    const m = setup({ add: [new TransportError('timeout'), { json: W.draft_add }] });
    const a = await newspic(BODY);
    expect(await newspicPublisher.push(a, context(m.host))).toMatchObject({
      outcome: 'uncertain',
      error: { code: 'OUTCOME_UNCERTAIN' },
    });
    expect(m.state.drafts[SOURCE].wechat).toMatchObject({
      status: 'uncertain',
      articleType: 'newspic',
    });
    expect(await newspicPublisher.push(a, context(m.host))).toMatchObject({
      outcome: 'failed',
      error: { code: 'OUTCOME_UNCERTAIN' },
    });
    expect(
      await newspicPublisher.push(a, context(m.host, { confirmUncertain: true })),
    ).toMatchObject({ outcome: 'created' });
    expect(m.calls('POST', /draft\/add/)).toHaveLength(2);
  });
  it('回读的图片张数或类型不对时标为未核对；内容不合格时不上传', async () => {
    const m = setup({ get: [{ json: readback('测试文章', 2) }] });
    const result = await newspicPublisher.push(await newspic(BODY), context(m.host));
    expect(result).toMatchObject({ outcome: 'created', verification: 'unverified' });
    expect(result.outcome === 'created' && result.warnings[0].message).toContain('有 2 张图');
    expect(m.state.drafts[SOURCE].wechat?.status).toBe('unverified');
    const blank = setup();
    const failed = await newspicPublisher.push(
      (await newspic('![](./a.png)')) as NewspicArticle,
      context(blank.host),
    );
    expect(failed).toMatchObject({ outcome: 'failed', error: { code: 'NEWSPIC_TEXT_EMPTY' } });
    expect(blank.calls('POST', /add_material|draft/)).toHaveLength(0);
  });
  it('45002 时提示把文字删短', async () => {
    const m = setup({ add: [{ json: W.content_too_long }] });
    const result = await newspicPublisher.push(await newspic(BODY), context(m.host));
    expect(result).toMatchObject({
      outcome: 'failed',
      error: { code: 'WECHAT_CONTENT_TOO_LONG', action: '把文字删短一些再推' },
    });
  });
});
