import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { App, TFile } from 'obsidian';
import { coverFileName, imageExtension, saveCoverImage } from '../src/cover-image';
const bytes = new TextEncoder().encode('cover');
const MD5 = createHash('md5').update(bytes).digest('hex').toUpperCase();
const now = new Date(2026, 9, 28, 9, 5, 7);
const file = (path: string) => ({ path, name: path.split('/').pop()! }) as TFile;
/** 只模拟用到的接口：附件路径按 Obsidian 的「指定文件夹」设置给出，同名时加序号。 */
function fakeApp(paths: string[] = [], queue?: TFile[]) {
  const files = paths.map(file);
  const writes: { path: string; data: ArrayBuffer }[] = [];
  const app = {
    fileManager: {
      getAvailablePathForAttachment: async (name: string) => {
        const taken = (path: string) => files.some((item) => item.path === path);
        let path = `assets/${name}`;
        for (let n = 1; taken(path); n++) path = `assets/${name.replace(/(\.\w+)$/, ` ${n}$1`)}`;
        return path;
      },
    },
    vault: {
      getFiles: () => files,
      createBinary: async (path: string, data: ArrayBuffer) => {
        writes.push({ path, data });
        const created = file(path);
        files.push(created);
        // 与 Obsidian 一样，新建文件时 Attachment Management 会把它排进队列。
        queue?.push(created);
        return created;
      },
    },
    plugins: { plugins: queue ? { 'attachment-management': { createdQueue: queue } } : {} },
  } as unknown as App;
  return { app, writes };
}
describe('封面图片的格式与命名', () => {
  it('按文件名或 MIME 取扩展名，不认识的格式返回 null', () => {
    expect(imageExtension('Cover.PNG')).toBe('png');
    expect(imageExtension('/tmp/a.jpeg', 'image/jpeg')).toBe('jpeg');
    expect(imageExtension('image', 'image/jpeg')).toBe('jpg');
    expect(imageExtension(undefined, 'image/webp')).toBe('webp');
    expect(imageExtension('a.heic', 'image/heic')).toBeNull();
    expect(imageExtension('a.pdf')).toBeNull();
  });
  it('命名是本地时间 YYYY-MM-DD-HHmmss 加内容 MD5 大写', () => {
    expect(coverFileName(bytes, 'png', now)).toBe(`2026-10-28-090507-${MD5}.png`);
  });
});
describe('saveCoverImage', () => {
  it('存进附件目录并按规范命名', async () => {
    const { app, writes } = fakeApp();
    const saved = await saveCoverImage(app, { bytes, name: '封面.png' }, 'posts/a.md', now);
    expect(saved.path).toBe(`assets/2026-10-28-090507-${MD5}.png`);
    expect(writes).toHaveLength(1);
    expect(new Uint8Array(writes[0].data)).toEqual(bytes);
  });
  it('附件目录里已有同一内容的规范命名文件时复用，不重复存', async () => {
    const existing = `assets/2026-01-02-030405-${MD5}.png`;
    const { app, writes } = fakeApp([existing]);
    const saved = await saveCoverImage(app, { bytes, type: 'image/png' }, 'a.md', now);
    expect(saved.path).toBe(existing);
    expect(writes).toHaveLength(0);
  });
  it('内容相同但在别的目录或扩展名不同的文件不算', async () => {
    const { app, writes } = fakeApp([
      `other/2026-01-02-030405-${MD5}.png`,
      `assets/2026-01-02-030405-${MD5}.jpg`,
    ]);
    await saveCoverImage(app, { bytes, type: 'image/png' }, 'a.md', now);
    expect(writes.map((write) => write.path)).toEqual([`assets/2026-10-28-090507-${MD5}.png`]);
  });
  it('存完把文件从 Attachment Management 的待处理队列里移掉，队列里别的文件不动', async () => {
    const pasted = file('assets/Pasted image 1.png');
    const queue = [pasted];
    const { app } = fakeApp([], queue);
    const saved = await saveCoverImage(app, { bytes, name: 'a.png' }, 'a.md', now);
    expect(queue).toEqual([pasted]);
    expect(queue).not.toContain(saved);
  });
  it('不是支持的图片或内容为空时报错，不写文件', async () => {
    const { app, writes } = fakeApp();
    await expect(saveCoverImage(app, { bytes, name: 'a.heic' }, 'a.md')).rejects.toThrow('只支持');
    await expect(
      saveCoverImage(app, { bytes: new Uint8Array(), name: 'a.png' }, 'a.md'),
    ).rejects.toThrow('图片是空的');
    expect(writes).toHaveLength(0);
  });
});
