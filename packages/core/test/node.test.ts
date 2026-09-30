import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  jinzhangHome,
  localFiles,
  normalizeSourcePath,
  withLock,
  LOCK_STALE_MS,
  type LocalFiles,
} from '../src/node';
let dir: string;
let files: LocalFiles;
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'jinzhang-node-')), 'home');
  files = localFiles(dir);
});
afterEach(async () => {
  await rm(join(dir, '..'), { recursive: true, force: true });
});
const posix = process.platform !== 'win32';
describe('配置目录位置', () => {
  it('默认在 ~/.config/jinzhang，JINZHANG_HOME 覆盖并展开 ~', () => {
    expect(jinzhangHome({})).toBe(join(homedir(), '.config', 'jinzhang'));
    expect(jinzhangHome({ JINZHANG_HOME: '/tmp/jz' })).toBe('/tmp/jz');
    expect(jinzhangHome({ JINZHANG_HOME: '~/jz' })).toBe(join(homedir(), 'jz'));
    expect(jinzhangHome({ JINZHANG_HOME: '  ' })).toBe(join(homedir(), '.config', 'jinzhang'));
  });
  it('源文件键是规范化的绝对路径，组合字符统一为 NFC', () => {
    const decomposed = '/笔记/café.md';
    expect(normalizeSourcePath(decomposed)).toBe('/笔记/café.md');
    expect(normalizeSourcePath('/a/b/../c.md')).toBe('/a/c.md');
  });
});
describe('公共配置', () => {
  it('没有文件时取默认值，类型不对的字段回落默认', async () => {
    const config = await files.config.read();
    expect(config.theme).toBe('sspai');
    expect(config.targets).toEqual(['wechat', 'zhihu']);
    await mkdir(dir, { recursive: true });
    await writeFile(
      files.config.file,
      JSON.stringify({ theme: 'unknown', targets: ['zhihu', 'x'], fixed: { wechat: 'x' } }),
    );
    const broken = await files.config.read();
    expect(broken.theme).toBe('sspai');
    expect(broken.targets).toEqual(['zhihu']);
    expect(broken.fixed.wechat).toEqual({ header: true, footer: true });
  });
  it('更新深合并到原始内容，保留命令行写入的未知字段', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(files.config.file, JSON.stringify({ future: { a: 1 }, author: '旧' }));
    const next = await files.config.update({
      author: '新作者',
      fixed: { zhihu: { header: false } },
      targets: ['zhihu'],
    });
    expect(next.author).toBe('新作者');
    expect(next.fixed.zhihu).toEqual({ header: false, footer: true });
    const raw = JSON.parse(await readFile(files.config.file, 'utf8'));
    expect(raw.future).toEqual({ a: 1 });
    expect(raw.targets).toEqual(['zhihu']);
    expect(raw.version).toBe(1);
  });
  it('配置文件损坏时报错但不带出内容，也不覆盖原文件', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(files.config.file, '{"appSecret": "不该出现在错误里"');
    await expect(files.config.read()).rejects.toThrow('config.json 不是合法的 JSON');
    await expect(files.config.update({ author: 'x' })).rejects.not.toThrow('不该出现');
    expect(await readFile(files.config.file, 'utf8')).toContain('不该出现在错误里');
  });
});
describe('状态文件', () => {
  it('并发更新全部保留，写入原子替换且不残留临时文件', async () => {
    const other = localFiles(dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? files : other).state.update((state) => {
          state.articles[`/notes/${i}.md`] = { cover: `/c/${i}.png` };
        }),
      ),
    );
    const state = await files.state.read();
    expect(Object.keys(state.articles)).toHaveLength(20);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await readdir(dir)).includes('state.lock')).toBe(false);
  });
  it('保留未知字段，修复形状不对的顶层容器', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(files.state.file, JSON.stringify({ drafts: [], extra: { keep: true } }));
    const state = await files.state.update((s) => {
      s.wechatEgressIp = '1.2.3.4';
    });
    expect(state.drafts).toEqual({});
    const raw = JSON.parse(await readFile(files.state.file, 'utf8'));
    expect(raw.extra).toEqual({ keep: true });
    expect(raw.wechatEgressIp).toBe('1.2.3.4');
  });
  it('另一进程持有锁时等待其释放，陈旧锁直接接管', async () => {
    await mkdir(dir, { recursive: true });
    const lock = join(dir, 'state.lock');
    await writeFile(lock, JSON.stringify({ pid: 99999, time: Date.now(), token: 'other' }));
    const started = Date.now();
    setTimeout(() => rm(lock, { force: true }), 300);
    await files.state.update((s) => {
      s.articles['/a.md'] = {};
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await writeFile(
      lock,
      JSON.stringify({ pid: 99999, time: Date.now() - LOCK_STALE_MS - 1000, token: 'dead' }),
    );
    await files.state.update((s) => {
      s.articles['/b.md'] = {};
    });
    expect(Object.keys((await files.state.read()).articles)).toEqual(['/a.md', '/b.md']);
  });
  it('锁一直被占用时超时报错，不改写状态', async () => {
    await mkdir(dir, { recursive: true });
    const lock = join(dir, 'state.lock');
    await writeFile(lock, JSON.stringify({ pid: 99999, time: Date.now(), token: 'other' }));
    await expect(withLock(lock, async () => 'never', 200)).rejects.toThrow('另一个锦章进程');
    expect(JSON.parse(await readFile(lock, 'utf8')).token).toBe('other');
  });
});
describe('凭证与模板', () => {
  it('凭证文件 0600、目录 0700，没有时返回 null，删除后消失', async () => {
    expect(await files.secrets.get('credentials')).toBeNull();
    await files.secrets.set('credentials', { wechat: { appId: 'wx-test', appSecret: 's' } });
    expect(await files.secrets.get('credentials')).toEqual({
      wechat: { appId: 'wx-test', appSecret: 's' },
    });
    if (posix) {
      expect((await stat(files.secrets.path('credentials'))).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
    await files.secrets.set('zhihu-session', {
      cookies: { z_c0: 'x' },
      updatedAt: '2026-09-30T00:00:00.000Z',
    });
    await files.secrets.remove('zhihu-session');
    expect(await files.secrets.get('zhihu-session')).toBeNull();
    await files.secrets.remove('zhihu-session');
  });
  it('模板按平台与位置存放，缺失时为空串', async () => {
    expect(await files.templates.read('wechat', 'header')).toBe('');
    await files.templates.write('zhihu', 'footer', '感谢阅读 {{title}}\n');
    expect(files.templates.path('zhihu', 'footer')).toBe(
      join(dir, 'templates', 'zhihu', 'footer.md'),
    );
    expect(await files.templates.readAll('zhihu')).toEqual({
      header: '',
      footer: '感谢阅读 {{title}}\n',
    });
  });
});
