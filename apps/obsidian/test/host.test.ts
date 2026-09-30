import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { TransportError } from '@jinzhang/core/publish';
const requestUrl = vi.fn();
vi.mock('obsidian', () => ({ requestUrl: (...args: unknown[]) => requestUrl(...args) }));
const { ObsidianHttp } = await import('../src/host');
const servers: Server[] = [];
afterEach(() => {
  requestUrl.mockReset();
  vi.useRealTimers();
  servers.splice(0).forEach((server) => server.close());
});
const listen = (server: Server) =>
  new Promise<number>((done) => {
    servers.push(server);
    server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port));
  });
describe('Obsidian 宿主的 http', () => {
  it('默认走 requestUrl：Content-Type 走 contentType 参数，字节体转 ArrayBuffer，响应头转小写', async () => {
    requestUrl.mockResolvedValue({
      status: 201,
      headers: { 'Content-Type': 'application/json' },
      arrayBuffer: new TextEncoder().encode('{"ok":1}').buffer,
    });
    const http = new ObsidianHttp(() => '');
    const response = await http.request({
      url: 'https://api.weixin.qq.com/x',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=b', Cookie: 'a=1' },
      body: new Uint8Array([1, 2, 3]),
      platform: 'wechat',
    });
    const param = requestUrl.mock.calls[0][0];
    expect(param).toMatchObject({
      url: 'https://api.weixin.qq.com/x',
      method: 'POST',
      contentType: 'multipart/form-data; boundary=b',
      headers: { Cookie: 'a=1' },
      throw: false,
    });
    expect([...new Uint8Array(param.body)]).toEqual([1, 2, 3]);
    expect(response.status).toBe(201);
    expect(response.headers['content-type']).toBe('application/json');
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":1}');
  });
  it('requestUrl 没有超时参数，宿主自包超时；连接失败归为中断', async () => {
    vi.useFakeTimers();
    requestUrl.mockReturnValue(new Promise(() => {}));
    const http = new ObsidianHttp(() => '');
    const pending = http.request({ url: 'https://example.test', timeoutMs: 1000 });
    const check = expect(pending).rejects.toMatchObject({
      name: 'TransportError',
      kind: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    vi.useRealTimers();
    requestUrl.mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'));
    await expect(http.request({ url: 'https://example.test' })).rejects.toBeInstanceOf(
      TransportError,
    );
  });
  it('配置了代理时公众号请求经代理（CONNECT）发出，知乎请求仍走 requestUrl', async () => {
    const target = await listen(
      createServer((req, res) => {
        res.setHeader('X-Seen', req.headers['x-token'] ?? '');
        res.end(`${req.method} ${req.url}`);
      }),
    );
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (req, socket, head) => {
      tunnels.push(req.url ?? '');
      const [host, port] = (req.url ?? '').split(':');
      const upstream = connect(Number(port), host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
    });
    const proxyPort = await listen(proxy);
    const http = new ObsidianHttp(() => `http://127.0.0.1:${proxyPort}`);
    const response = await http.request({
      url: `http://127.0.0.1:${target}/cgi-bin/token?x=1`,
      method: 'POST',
      headers: { 'x-token': 't' },
      body: '{}',
      platform: 'wechat',
    });
    expect(new TextDecoder().decode(response.body)).toBe('POST /cgi-bin/token?x=1');
    expect(response.headers['x-seen']).toBe('t');
    expect(tunnels).toEqual([`127.0.0.1:${target}`]);
    requestUrl.mockResolvedValue({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) });
    await http.request({ url: 'https://www.zhihu.com/api/v4/me', platform: 'zhihu' });
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(tunnels).toHaveLength(1);
  });
  it('代理不可达时归为连接中断，代理协议不支持时报错', async () => {
    const http = new ObsidianHttp(() => 'http://127.0.0.1:1');
    await expect(
      http.request({ url: 'http://127.0.0.1:2/x', platform: 'wechat', timeoutMs: 3000 }),
    ).rejects.toMatchObject({ name: 'TransportError', kind: 'network' });
    const bad = new ObsidianHttp(() => 'ftp://127.0.0.1:1');
    await expect(bad.request({ url: 'http://127.0.0.1:2/x', platform: 'wechat' })).rejects.toThrow(
      '代理地址只支持',
    );
  });
});
