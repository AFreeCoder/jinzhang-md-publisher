import { describe, expect, it, vi } from 'vitest';
import { VaultAssetResolver, joinDisk, type VaultAccess, type VaultFile } from '../src/resolver';
const file = (path: string): VaultFile => ({
  path,
  extension: path.split('.').pop()!,
  stat: { mtime: 1, size: 1 },
});
/** 假 vault：根目录与笔记目录下各有一张同名 a.png，链接解析交给传入的规则。 */
function fakeVault(disk: Record<string, number[]> = {}) {
  const files: Record<string, number[]> = {
    'a.png': [1],
    'posts/a.png': [2],
    'assets/图 片.png': [3],
    'posts/sub/c.png': [4],
  };
  const getFirstLinkpathDest = vi.fn((link: string, source: string) => {
    const dir = source.replace(/\/[^/]*$/, '');
    const candidate = `${dir}/${link}`;
    if (files[candidate]) return file(candidate);
    if (files[link]) return file(link);
    const byName = Object.keys(files).find((p) => p.endsWith(`/${link}`));
    return byName ? file(byName) : null;
  });
  const access: VaultAccess = {
    getFileByPath: (path) => (files[path] ? file(path) : null),
    getFirstLinkpathDest,
    readBinary: async (f) => new Uint8Array(files[f.path]).buffer,
    readDisk: async (path) => {
      if (!disk[path]) throw new Error('ENOENT');
      return new Uint8Array(disk[path]);
    },
  };
  return { access, getFirstLinkpathDest };
}
const bytesOf = (asset: Awaited<ReturnType<VaultAssetResolver['resolve']>>) =>
  'bytes' in asset ? [...asset.bytes] : asset;
describe('VaultAssetResolver', () => {
  it('远程地址返回 remote，带账号的地址拒绝；data URL 直接解码', async () => {
    const r = new VaultAssetResolver(fakeVault().access, '/vault', 'posts/note.md');
    expect(await r.resolve('https://example.test/a.png')).toEqual({
      kind: 'remote',
      url: 'https://example.test/a.png',
    });
    expect((await r.resolve('https://u:p@example.test/a.png')).kind).toBe('missing');
    expect(await r.resolve('data:image/png;base64,AQID')).toMatchObject({
      kind: 'data',
      mime: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });
  });
  it('嵌入图的 jz-local://vault/ 按 vault 路径读取，assetId 是 vault 内路径', async () => {
    const r = new VaultAssetResolver(fakeVault().access, '/vault', 'posts/note.md');
    const asset = await r.resolve('jz-local://vault/assets/%E5%9B%BE%20%E7%89%87.png');
    expect(asset).toMatchObject({ kind: 'blob', mime: 'image/png', assetId: 'assets/图 片.png' });
    expect(await r.resolve('jz-local://vault/none.png')).toEqual({
      kind: 'missing',
      reason: 'vault 里找不到 none.png',
    });
  });
  it('相对引用先解码再交给 getFirstLinkpathDest，笔记目录与根目录同名时与 Obsidian 一致', async () => {
    const { access, getFirstLinkpathDest } = fakeVault();
    const r = new VaultAssetResolver(access, '/vault', 'posts/note.md');
    expect(bytesOf(await r.resolve('a.png'))).toEqual([2]);
    expect(getFirstLinkpathDest).toHaveBeenLastCalledWith('a.png', 'posts/note.md');
    await r.resolve('assets/%E5%9B%BE%20%E7%89%87.png');
    expect(getFirstLinkpathDest).toHaveBeenLastCalledWith('assets/图 片.png', 'posts/note.md');
    expect(bytesOf(await r.resolve('sub/c.png'))).toEqual([4]);
    const root = new VaultAssetResolver(access, '/vault', 'note.md');
    expect(bytesOf(await root.resolve('a.png'))).toEqual([1]);
  });
  it('vault 里找不到的相对路径按笔记所在磁盘目录解析，覆盖指向 vault 外的 ../', async () => {
    const { access } = fakeVault({ '/outside/x.png': [9], '/vault/posts/local.png': [8] });
    const r = new VaultAssetResolver(access, '/vault', 'posts/note.md');
    expect(bytesOf(await r.resolve('../../outside/x.png'))).toEqual([9]);
    expect(await r.resolve('../../outside/x.png')).toMatchObject({ assetId: '/outside/x.png' });
    const missing = await r.resolve('nope.png');
    expect(missing).toEqual({
      kind: 'missing',
      reason: '找过 vault 链接「nope.png」与磁盘上的 /vault/posts/nope.png',
    });
  });
  it('以 / 开头先按 vault 根路径找，没有再按磁盘绝对路径；盘符路径与 jz-local://file/ 读磁盘', async () => {
    const { access } = fakeVault({
      '/Users/me/cover.png': [7],
      'C:/pics/a.png': [6],
      'C:\\pics\\b.png': [5],
    });
    const r = new VaultAssetResolver(access, '/vault', 'posts/note.md');
    expect(bytesOf(await r.resolve('/posts/a.png'))).toEqual([2]);
    expect(bytesOf(await r.resolve('/Users/me/cover.png'))).toEqual([7]);
    expect(bytesOf(await r.resolve('jz-local://file/Users/me/cover.png'))).toEqual([7]);
    expect(bytesOf(await r.resolve('jz-local://file/C%3A/pics/a.png'))).toEqual([6]);
    expect(bytesOf(await r.resolve('C:\\pics\\b.png'))).toEqual([5]);
    expect((await r.resolve('/nowhere.png')).kind).toBe('missing');
    const literal = new VaultAssetResolver(
      fakeVault({ '/pics/100%25 done.png': [3], '/pics/a b.png': [4] }).access,
      '/vault',
      'posts/note.md',
    );
    expect(bytesOf(await literal.resolve('/pics/100%25 done.png'))).toEqual([3]);
    expect(bytesOf(await literal.resolve('/pics/a%20b.png'))).toEqual([4]);
  });
  it('拼接磁盘路径处理 ..，Windows 路径保留盘符', () => {
    expect(joinDisk('/vault', 'posts/../a.png')).toBe('/vault/a.png');
    expect(joinDisk('/vault', '../../../x.png')).toBe('/x.png');
    expect(joinDisk('C:\\vault', 'posts\\a.png')).toBe('C:/vault/posts/a.png');
  });
});
