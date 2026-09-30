import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import { BrowserAssetResolver, DataUrlImageStore } from '../src/browser';
import {
  NORMALIZE_PROFILES,
  type ImageRef,
  type NormalizeProfile,
  type Warning,
} from '../src/types';
describe('本地图片与引用绑定', () => {
  it('内容去重不导致不同目录同名图片错绑，刷新后能恢复', async () => {
    const store = new BrowserAssetResolver();
    await store.clear();
    const a = await store.add(new Blob(['abc'], { type: 'image/png' }), './one/a.png');
    const b = await store.add(new Blob(['abc'], { type: 'image/png' }), './two/a.png');
    expect(a).not.toBe(b);
    const fresh = new BrowserAssetResolver();
    expect((await fresh.resolve('./one/a.png')).kind).toBe('blob');
    expect((await fresh.resolve('./missing/a.png')).kind).toBe('missing');
    expect((await fresh.resolve(a)).kind).toBe('blob');
    await fresh.clear();
    expect((await fresh.resolve(a)).kind).toBe('missing');
  });
  it('超大资源与无效 data URL 拒绝', async () => {
    const store = new BrowserAssetResolver();
    await expect(store.add(new Blob([new Uint8Array(13 * 1024 * 1024)]))).rejects.toThrow('12 MB');
    expect((await store.resolve('data:image/png;base64,!!!!')).kind).toBe('missing');
  });
});
describe('data URL 归位', () => {
  const codec = {
    probe: async () => ({ mime: 'image/png', width: 1, height: 1, animated: false }),
    normalize: vi.fn(async (bytes: Uint8Array, _profile: NormalizeProfile) => ({
      bytes: new Uint8Array([...bytes, 9]),
      mime: 'image/png' as const,
      width: 1,
      height: 1,
      animated: bytes[0] === 71,
    })),
  };
  const ref = (source: ImageRef['source'], original = './a.png'): ImageRef => ({
    id: '0',
    original,
    source,
    inFixedContent: false,
  });
  it('按 clipboard 档规范化后内嵌，同一内容只处理一次，警告与计数写入外层对象', async () => {
    codec.normalize.mockClear();
    const warnings: Warning[] = [];
    const counts = { embedded: 0, remote: 0 };
    const store = new DataUrlImageStore({ codec, warnings, counts });
    const bytes = new Uint8Array([1, 2]);
    const first = await store.put(ref({ kind: 'blob', bytes, mime: 'image/png' }));
    const again = await store.put(ref({ kind: 'data', bytes, mime: 'image/png' }, './b.png'));
    expect(first.src).toBe(`data:image/png;base64,${btoa(String.fromCharCode(1, 2, 9))}`);
    expect(again).toEqual(first);
    expect(codec.normalize).toHaveBeenCalledTimes(1);
    expect(codec.normalize.mock.calls[0][1]).toEqual(NORMALIZE_PROFILES.clipboard);
    await store.put(ref({ kind: 'blob', bytes: new Uint8Array([71, 73]), mime: 'image/gif' }));
    expect(counts).toEqual({ embedded: 2, remote: 0 });
    expect(warnings.map((w) => w.code)).toEqual(['GIF_FIRST_FRAME']);
  });
  it('远程图片能读取就内嵌，读取失败或没有读取方式时保留原地址并警告', async () => {
    const fetchRemote = vi.fn(async (url: string) => {
      if (url.includes('bad')) throw new Error('404');
      return new Uint8Array([5]);
    });
    const store = new DataUrlImageStore({ codec, fetchRemote });
    const ok = await store.put(ref({ kind: 'remote', url: 'https://x.test/ok.png' }));
    expect(ok.src.startsWith('data:image/png;base64,')).toBe(true);
    const bad = await store.put(ref({ kind: 'remote', url: 'https://x.test/bad.png' }, 'bad'));
    expect(bad.src).toBe('https://x.test/bad.png');
    const plain = new DataUrlImageStore({ codec });
    expect((await plain.put(ref({ kind: 'hosted', url: 'https://h.test/a.png' }))).src).toBe(
      'https://h.test/a.png',
    );
    expect(store.warnings).toEqual([
      expect.objectContaining({ code: 'IMAGE_REMOTE_KEPT', ref: 'bad' }),
    ]);
    expect(store.counts).toEqual({ embedded: 1, remote: 1 });
  });
  it('缺图报出原始引用，任务过期或取消时中止', async () => {
    const store = new DataUrlImageStore({ codec });
    await expect(store.put(ref({ kind: 'missing', reason: '找不到' }, './缺.png'))).rejects.toThrow(
      '图片缺失：./缺.png',
    );
    const stale = new DataUrlImageStore({
      codec,
      check: () => {
        throw new Error('已过期');
      },
    });
    await expect(
      stale.put(ref({ kind: 'blob', bytes: new Uint8Array([3]), mime: 'image/png' })),
    ).rejects.toThrow('已过期');
    const controller = new AbortController();
    controller.abort();
    const aborted = new DataUrlImageStore({ codec, signal: controller.signal });
    await expect(
      aborted.put(ref({ kind: 'blob', bytes: new Uint8Array([4]), mime: 'image/png' })),
    ).rejects.toThrow();
  });
});
