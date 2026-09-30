import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Platform } from './types';
import {
  isRecord,
  normalizeConfig,
  normalizeState,
  type DeepPartial,
  type JinzhangConfig,
  type JinzhangState,
  type SecretFiles,
  type SecretName,
  type SecretStore,
  type StateStore,
} from './local';
export * from './local';
/** 命令行与插件共用的配置目录：`JINZHANG_HOME` 优先，否则三个系统都是 `~/.config/jinzhang`。 */
export function jinzhangHome(env: Record<string, string | undefined> = process.env) {
  const custom = env.JINZHANG_HOME?.trim();
  if (custom) return resolve(custom.replace(/^~(?=$|[\\/])/, homedir()));
  return join(homedir(), '.config', 'jinzhang');
}
/** 草稿映射与文章设置的键：规范化后的绝对路径，两个入口推同一篇文章得到同一个键。 */
export function normalizeSourcePath(path: string) {
  return resolve(path).normalize('NFC');
}
export const LOCK_STALE_MS = 30_000;
const SECRET_FILES: Record<SecretName, string> = {
  credentials: 'credentials.json',
  'wechat-token': 'wechat-token.json',
  'zhihu-session': 'zhihu-session.json',
};
const errorCode = (error: unknown) => (error as { code?: string } | null)?.code;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function writeAtomic(file: string, content: string, mode: number) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await writeFile(temp, content, { mode });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await chmod(file, mode);
}
async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // 不带文件内容，凭证文件损坏时也不会把内容带进错误信息。
    throw new Error(`${basename(file)} 不是合法的 JSON，请修正或删除后重试。`);
  }
}
async function lockTime(lockFile: string) {
  try {
    const holder = JSON.parse(await readFile(lockFile, 'utf8'));
    if (typeof holder?.time === 'number') return holder.time as number;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
  }
  // 另一进程刚创建、尚未写完内容时按修改时间判断。
  try {
    return (await stat(lockFile)).mtimeMs;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}
async function acquire(lockFile: string, timeoutMs: number) {
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await writeFile(lockFile, JSON.stringify({ pid: process.pid, time: Date.now(), token }), {
        flag: 'wx',
        mode: 0o600,
      });
      return token;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const time = await lockTime(lockFile);
    if (time === undefined) continue;
    if (Date.now() - time > LOCK_STALE_MS) {
      await rm(lockFile, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error('配置目录正被另一个锦章进程写入，请稍后重试。');
    await sleep(40 + Math.random() * 60);
  }
}
async function release(lockFile: string, token: string) {
  try {
    const holder = JSON.parse(await readFile(lockFile, 'utf8'));
    if (holder?.token === token) await rm(lockFile, { force: true });
  } catch {
    /* 锁已被当作陈旧锁清理。 */
  }
}
const queues = new Map<string, Promise<unknown>>();
/** 同一进程内按锁文件排队，跨进程用锁文件互斥；锁超过 30 秒视为陈旧。 */
export async function withLock<T>(lockFile: string, action: () => Promise<T>, timeoutMs = 10_000) {
  const previous = queues.get(lockFile) ?? Promise.resolve();
  const run = previous.then(async () => {
    const token = await acquire(lockFile, timeoutMs);
    try {
      return await action();
    } finally {
      await release(lockFile, token);
    }
  });
  const tail = run.catch(() => {});
  queues.set(lockFile, tail);
  try {
    return await run;
  } finally {
    if (queues.get(lockFile) === tail) queues.delete(lockFile);
  }
}
function merge(target: Record<string, any>, patch: Record<string, any>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    target[key] = isRecord(value) ? merge(isRecord(target[key]) ? target[key] : {}, value) : value;
  }
  return target;
}
export class FileConfigStore {
  constructor(readonly dir: string) {}
  get file() {
    return join(this.dir, 'config.json');
  }
  async read(): Promise<JinzhangConfig> {
    return normalizeConfig(await readJson(this.file));
  }
  /** 深合并到磁盘上的原始内容再写回，未知字段保留，数组整体替换。 */
  update(patch: DeepPartial<JinzhangConfig>) {
    return withLock(join(this.dir, 'state.lock'), async () => {
      const raw = await readJson(this.file);
      const next = merge(isRecord(raw) ? raw : {}, patch);
      next.version = 1;
      await writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`, 0o644);
      return normalizeConfig(next);
    });
  }
}
export class FileStateStore implements StateStore {
  constructor(readonly dir: string) {}
  get file() {
    return join(this.dir, 'state.json');
  }
  async read() {
    return normalizeState(await readJson(this.file));
  }
  update(mutate: (state: JinzhangState) => void) {
    return withLock(join(this.dir, 'state.lock'), async () => {
      const state = normalizeState(await readJson(this.file));
      mutate(state);
      await writeAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
      return state;
    });
  }
}
export class FileSecretStore implements SecretStore {
  constructor(readonly dir: string) {}
  path(name: SecretName) {
    return join(this.dir, SECRET_FILES[name]);
  }
  async get<K extends SecretName>(name: K) {
    const raw = await readJson(this.path(name));
    return isRecord(raw) ? (raw as SecretFiles[K]) : null;
  }
  async set<K extends SecretName>(name: K, value: SecretFiles[K]) {
    await writeAtomic(this.path(name), `${JSON.stringify(value, null, 2)}\n`, 0o600);
  }
  async remove(name: SecretName) {
    await rm(this.path(name), { force: true });
  }
}
export type TemplatePart = 'header' | 'footer';
export class FileTemplateStore {
  constructor(readonly dir: string) {}
  path(platform: Platform, part: TemplatePart) {
    return join(this.dir, 'templates', platform, `${part}.md`);
  }
  async read(platform: Platform, part: TemplatePart) {
    try {
      return await readFile(this.path(platform, part), 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return '';
      throw error;
    }
  }
  async readAll(platform: Platform) {
    return {
      header: await this.read(platform, 'header'),
      footer: await this.read(platform, 'footer'),
    };
  }
  async write(platform: Platform, part: TemplatePart, content: string) {
    await writeAtomic(this.path(platform, part), content, 0o644);
  }
}
/** 配置目录下全部文件的读写入口。 */
export function localFiles(dir = jinzhangHome()) {
  return {
    dir,
    config: new FileConfigStore(dir),
    state: new FileStateStore(dir),
    secrets: new FileSecretStore(dir),
    templates: new FileTemplateStore(dir),
  };
}
export type LocalFiles = ReturnType<typeof localFiles>;
