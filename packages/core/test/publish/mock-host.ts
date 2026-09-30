import {
  normalizeState,
  TransportError,
  type HttpRequest,
  type HttpResponse,
  type JinzhangState,
  type PublishHost,
  type SecretFiles,
  type SecretName,
} from '../../src/publish';
import type { ImageCodec, NormalizeProfile } from '../../src/types';
export type Reply =
  | {
      status?: number;
      json?: unknown;
      text?: string;
      bytes?: Uint8Array;
      headers?: Record<string, string>;
    }
  | TransportError
  | ((request: HttpRequest) => Reply);
export interface Route {
  method?: string;
  match: string | RegExp;
  /** 按顺序回放；最后一个重复使用。 */
  replies: Reply[];
}
const encoder = new TextEncoder();
/** 回放响应样本的宿主：记录全部请求，状态与凭证存在内存里，等待只推进假时钟。 */
export function mockHost(routes: Route[], options: { codec?: ImageCodec } = {}) {
  const requests: HttpRequest[] = [];
  const times: number[] = [];
  const used = new Map<Route, number>();
  let clock = Date.parse('2026-09-30T08:00:00.000Z');
  let state: JinzhangState = normalizeState({});
  const secrets: Partial<SecretFiles> = {};
  const sleeps: number[] = [];
  const codec: ImageCodec = options.codec ?? {
    probe: async () => ({ mime: 'image/png', width: 100, height: 50, animated: false }),
    normalize: async (bytes: Uint8Array, _profile: NormalizeProfile) => {
      if (bytes[0] === 0xee) throw new Error('SVG 无法栅格化');
      return {
        bytes: new Uint8Array([...bytes, 1]),
        mime: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg',
        width: 800,
        height: 600,
        animated: bytes[0] === 0x47,
      };
    },
  };
  const host: PublishHost = {
    codec,
    now: () => new Date(clock),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    readFile: async () => new Uint8Array(),
    store: {
      read: async () => structuredClone(state),
      update: async (mutate) => {
        const next = structuredClone(state);
        mutate(next);
        state = next;
        return structuredClone(state);
      },
    },
    secrets: {
      get: async <K extends SecretName>(name: K) =>
        (secrets[name] ? structuredClone(secrets[name]) : null) as SecretFiles[K] | null,
      set: async (name, value) => {
        secrets[name] = structuredClone(value) as never;
      },
      remove: async (name) => {
        delete secrets[name];
      },
    },
    http: {
      request: async (request) => {
        requests.push(request);
        times.push(clock);
        clock += 5;
        const method = request.method ?? 'GET';
        const route = routes.find(
          (r) =>
            (r.method ?? 'GET') === method &&
            (typeof r.match === 'string'
              ? request.url.startsWith(r.match)
              : r.match.test(request.url)),
        );
        if (!route) throw new Error(`未预期的请求：${method} ${request.url}`);
        const index = used.get(route) ?? 0;
        used.set(route, index + 1);
        let reply = route.replies[Math.min(index, route.replies.length - 1)];
        while (typeof reply === 'function') reply = reply(request);
        if (reply instanceof TransportError) throw reply;
        const body =
          reply.bytes ??
          encoder.encode(
            reply.text !== undefined
              ? reply.text
              : reply.json !== undefined
                ? JSON.stringify(reply.json)
                : '',
          );
        return {
          status: reply.status ?? 200,
          headers: {
            'content-type': reply.text !== undefined ? 'text/html' : 'application/json',
            ...reply.headers,
          },
          body,
        } satisfies HttpResponse;
      },
    },
  };
  return {
    host,
    requests,
    times,
    sleeps,
    secrets,
    get state() {
      return state;
    },
    set state(value: JinzhangState) {
      state = value;
    },
    calls: (method: string, pattern: string | RegExp) =>
      requests.filter(
        (r) =>
          (r.method ?? 'GET') === method &&
          (typeof pattern === 'string' ? r.url.startsWith(pattern) : pattern.test(r.url)),
      ),
    clock: () => clock,
  };
}
export const bodyText = (request: HttpRequest) =>
  typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body);
