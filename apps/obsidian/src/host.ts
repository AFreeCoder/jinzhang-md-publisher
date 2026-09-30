import { requestUrl, type App, type TFile } from 'obsidian';
import { readFile, stat } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { Buffer } from 'node:buffer';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { CanvasImageCodec } from '@jinzhang/core/browser';
import {
  TransportError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type PublishHost,
} from '@jinzhang/core/publish';
import type { LocalFiles } from '@jinzhang/core/node';
import type { VaultAccess, VaultFile } from './resolver';
const lower = (headers: Record<string, string | string[] | undefined>) =>
  Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value!]),
  );
/** requestUrl 没有超时与取消参数，这里包一层；到时后平台侧可能仍在处理。 */
export function withTimeout<T>(task: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TransportError('timeout')), ms);
    }),
  ]);
}
export function proxyAgent(proxy: string) {
  const { protocol } = new URL(proxy);
  if (/^socks[45]?h?:$/.test(protocol)) return new SocksProxyAgent(proxy);
  if (protocol === 'http:' || protocol === 'https:') return new HttpsProxyAgent(proxy);
  throw new Error('代理地址只支持 http://、https:// 与 socks5://');
}
/** 配置了代理时公众号请求走 Node https 加代理 agent：requestUrl 没有代理参数。 */
function viaProxy(request: HttpRequest, proxy: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const body =
      request.body === undefined
        ? undefined
        : typeof request.body === 'string'
          ? Buffer.from(request.body)
          : Buffer.from(request.body);
    let agent;
    try {
      agent = proxyAgent(proxy);
    } catch (error) {
      reject(error);
      return;
    }
    const client = url.protocol === 'http:' ? http : https;
    const outgoing = client.request(
      url,
      {
        method: request.method ?? 'GET',
        agent,
        headers: { ...request.headers, ...(body ? { 'Content-Length': String(body.length) } : {}) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', (error) => reject(new TransportError('network', error.message)));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: lower(response.headers),
            body: new Uint8Array(Buffer.concat(chunks)),
          }),
        );
      },
    );
    outgoing.setTimeout(request.timeoutMs ?? 30_000, () => {
      outgoing.destroy();
      reject(new TransportError('timeout'));
    });
    outgoing.on('error', (error) => reject(new TransportError('network', error.message)));
    if (body) outgoing.write(body);
    outgoing.end();
  });
}
/** 默认走 Obsidian 的 requestUrl：在主进程发请求，没有跨域限制，可以带 Cookie、Origin、Referer。 */
export class ObsidianHttp implements HttpClient {
  constructor(private proxy: () => string) {}
  async request(request: HttpRequest): Promise<HttpResponse> {
    const proxy = request.platform === 'wechat' ? this.proxy() : '';
    if (proxy) return viaProxy(request, proxy);
    const headers = { ...request.headers };
    const typeKey = Object.keys(headers).find((key) => key.toLowerCase() === 'content-type');
    const contentType = typeKey ? headers[typeKey] : undefined;
    if (typeKey) delete headers[typeKey];
    const body =
      request.body instanceof Uint8Array
        ? request.body.buffer.slice(
            request.body.byteOffset,
            request.body.byteOffset + request.body.byteLength,
          )
        : request.body;
    try {
      const response = await withTimeout(
        requestUrl({
          url: request.url,
          method: request.method ?? 'GET',
          headers,
          contentType,
          body: body as string | ArrayBuffer | undefined,
          throw: false,
        }),
        request.timeoutMs ?? 30_000,
      );
      return {
        status: response.status,
        headers: lower(response.headers),
        body: new Uint8Array(response.arrayBuffer),
      };
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError('network', error instanceof Error ? error.message : '网络错误');
    }
  }
}
/** vault 与磁盘文件的读取，按修改时间缓存字节，预览跟着编辑器反复排版时不重复读图。 */
export class ObsidianVault implements VaultAccess {
  private cache = new Map<string, { mtime: number; bytes: Uint8Array }>();
  constructor(private app: App) {}
  getFileByPath(path: string) {
    return this.app.vault.getFileByPath(path);
  }
  getFirstLinkpathDest(linkpath: string, sourcePath: string) {
    return this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
  }
  private remember(key: string, mtime: number, bytes: Uint8Array) {
    this.cache.set(key, { mtime, bytes });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return bytes;
  }
  async readBinary(file: VaultFile) {
    const hit = this.cache.get(`vault:${file.path}`);
    if (hit && hit.mtime === file.stat.mtime) return hit.bytes.slice().buffer;
    const bytes = new Uint8Array(await this.app.vault.readBinary(file as TFile));
    return this.remember(`vault:${file.path}`, file.stat.mtime, bytes).slice().buffer;
  }
  async readDisk(absPath: string) {
    const info = await stat(absPath);
    if (!info.isFile()) throw new Error('不是文件');
    const hit = this.cache.get(`disk:${absPath}`);
    if (hit && hit.mtime === info.mtimeMs) return hit.bytes.slice();
    return this.remember(
      `disk:${absPath}`,
      info.mtimeMs,
      new Uint8Array(await readFile(absPath)),
    ).slice();
  }
}
export function createHost(app: App, files: LocalFiles, vault: ObsidianVault, basePath: string) {
  let proxy = '';
  const host: PublishHost & { setProxy(value: string): void } = {
    http: new ObsidianHttp(() => proxy || process.env.HTTPS_PROXY || process.env.https_proxy || ''),
    codec: new CanvasImageCodec(),
    store: files.state,
    secrets: files.secrets,
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    readFile: async (absPath) => {
      const normalized = absPath.replace(/\\/g, '/');
      const base = basePath.replace(/\\/g, '/').replace(/\/$/, '');
      if (normalized.startsWith(`${base}/`)) {
        const file = vault.getFileByPath(normalized.slice(base.length + 1));
        if (file) return new Uint8Array(await vault.readBinary(file));
      }
      return vault.readDisk(absPath);
    },
    setProxy: (value) => {
      proxy = value.trim();
    },
  };
  return host;
}
