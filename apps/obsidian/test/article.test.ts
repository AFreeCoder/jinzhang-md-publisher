import { describe, expect, it } from 'vitest';
import { getFrontMatterInfo } from 'obsidian';
import { defaultConfig } from '@jinzhang/core/publish';
import { buildArticle, type BuildEnv, type Snapshot } from '../src/article';
import type { VaultAccess, VaultFile } from '../src/resolver';
const file = (path: string): VaultFile => ({ path, extension: 'png', stat: { mtime: 1, size: 1 } });
const vault: VaultAccess = {
  getFileByPath: (path) => (path === 'assets/a.png' ? file(path) : null),
  getFirstLinkpathDest: (link) => (link === 'a.png' ? file('assets/a.png') : null),
  readBinary: async () => new Uint8Array([0x89, 1]).buffer,
  readDisk: async (path) => {
    if (path === '/Users/me/封面.png') return new Uint8Array([0xff, 2]);
    throw new Error('ENOENT');
  },
};
const snapshot = (content: string): Snapshot => ({
  path: 'posts/测试文章.md',
  source: '/vault/posts/测试文章.md',
  title: '测试文章',
  content,
  contentStart: getFrontMatterInfo(content).contentStart,
});
const env = (extra: Partial<BuildEnv> = {}): BuildEnv => ({
  vault,
  basePath: '/vault',
  config: (() => {
    const config = defaultConfig();
    config.author = '作者甲';
    config.wechat.start = { slogan: '持续更新', producerName: '示例号' };
    config.wechat.card = { ...config.wechat.card, enabled: true, mpId: 'Mz==', nickname: '示例号' };
    return config;
  })(),
  footers: { wechat: '感谢阅读《{{title}}》，{{date}}', zhihu: '知乎结尾 {{author}}' },
  resolveEmbed: (link) => (link === 'a.png' ? { path: 'assets/a.png', isImage: true } : null),
  today: '2026-09-30',
  ...extra,
});
describe('从编辑器快照排版', () => {
  it('属性区静默去掉，嵌入图读出字节，标题取文件名并去重首个同名 H1，拼上开头结尾', async () => {
    const built = await buildArticle(
      snapshot('---\ntags: [x]\n---\n# 测试文章\n\n![[a.png]]\n\n正文 [[别的笔记|链接]]'),
      'wechat',
      env(),
    );
    const { result } = built;
    expect(result.title).toBe('测试文章');
    expect(result.html).not.toContain('<h1');
    // 开头样式一：宣言、名片、作者、出品；结尾样式一：结尾文字再跟一张名片。
    expect(result.text).toMatch(/^持续更新\s*作者｜作者甲\s*出品｜公众号：示例号/);
    expect(result.text).toContain('感谢阅读《测试文章》，2026-09-30');
    expect(result.html.match(/<mp-common-profile [^>]*data-id="Mz=="/g)).toHaveLength(2);
    expect(result.html).not.toContain('font-size:12px;letter-spacing:1px');
    expect(result.text).toContain('正文 链接');
    expect(result.warnings.map((w) => w.code)).not.toContain('FRONTMATTER_IGNORED');
    expect(result.warnings.map((w) => w.code)).not.toContain('UNSUPPORTED_SYNTAX');
    expect(result.images).toHaveLength(1);
    expect(result.images[0].source).toMatchObject({ kind: 'blob', assetId: 'assets/a.png' });
    expect(result.cover?.original).toBe('jz-local://vault/assets/a.png');
    expect(built.fixed).toEqual({ header: true, footer: true });
    expect(built.variables).toEqual({
      date: '2026-09-30',
      author: '作者甲',
      slogan: '持续更新',
      producer: '示例号',
    });
  });
  it('共享状态里以绝对路径保存的封面走磁盘分支；知乎按自己的开关与模板', async () => {
    const built = await buildArticle(
      snapshot('![[a.png]]'),
      'zhihu',
      env({ cover: '/Users/me/封面.png' }),
    );
    expect(built.result.cover).toMatchObject({
      original: '/Users/me/封面.png',
      source: { kind: 'blob', assetId: '/Users/me/封面.png' },
    });
    expect(built.fixed).toEqual({ header: false, footer: true });
    expect(built.result.text).not.toContain('感谢阅读');
    expect(built.result.text).not.toContain('持续更新');
    expect(built.result.text).toContain('知乎结尾 作者甲');
    expect(built.result.html).not.toContain('mp-common-profile');
    const missing = await buildArticle(snapshot('![[缺.png]]'), 'wechat', env());
    expect(missing.result.warnings).toContainEqual(
      expect.objectContaining({ code: 'IMAGE_MISSING', ref: '缺.png' }),
    );
  });
});
