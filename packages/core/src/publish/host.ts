import type { ImageCodec, Platform } from '../types';
import type { SecretStore, StateStore } from '../local';
export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** 到时由宿主以 `TransportError('timeout')` 失败；请求可能仍在平台侧完成。 */
  timeoutMs?: number;
  /** 请求所属平台，宿主据此选传输：配置了代理时公众号请求走代理。 */
  platform?: Platform;
}
export interface HttpResponse {
  status: number;
  /** 键为小写。 */
  headers: Record<string, string>;
  body: Uint8Array;
}
/** fetch 风格的传输，需能带 Cookie、Origin、Referer 等任意头；HTTP 错误码照常返回，不抛错。 */
export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}
/** 超时或连接中断：不知道平台是否已处理这次请求。 */
export class TransportError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network',
    message = kind === 'timeout' ? '请求超时' : '网络连接中断',
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
export interface PublishHost {
  http: HttpClient;
  codec: ImageCodec;
  readFile(absPath: string): Promise<Uint8Array>;
  store: StateStore;
  secrets: SecretStore;
  now(): Date;
  /** 轮询与限速用的等待；测试可替换为立即返回。 */
  sleep?(ms: number): Promise<void>;
}
export const wait = (host: PublishHost, ms: number) =>
  host.sleep ? host.sleep(ms) : new Promise<void>((done) => setTimeout(done, ms));
export const responseText = (response: HttpResponse) => new TextDecoder().decode(response.body);
export function responseJson(response: HttpResponse): unknown {
  try {
    return JSON.parse(responseText(response));
  } catch {
    return undefined;
  }
}
