// 网关到 yuzu 小程序端口的请求（经 Tailscale）：每个请求都带网关密钥；会员相关的另带 openid。
// 连不上（门店断外网、yuzu 没开）时抛 UpstreamDown，由网关决定给缓存还是提示「门店系统连接中」。

import { MP_GATEWAY_HEADER, MP_OPENID_HEADER } from '@shared/mp';

export class UpstreamDown extends Error {}

export interface UpstreamResponse {
  status: number;
  contentType: string;
  cacheControl: string | null;
  body: Buffer;
}

export interface Upstream {
  call(method: 'GET' | 'POST', path: string, o?: { openid?: string; body?: unknown }): Promise<UpstreamResponse>;
}

export function createUpstream(baseUrl: string, gatewayKey: string, timeoutMs = 8_000): Upstream {
  return {
    async call(method, path, o = {}) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            [MP_GATEWAY_HEADER]: gatewayKey,
            ...(o.openid ? { [MP_OPENID_HEADER]: o.openid } : {}),
            ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return {
          status: res.status,
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
          cacheControl: res.headers.get('cache-control'),
          body: Buffer.from(await res.arrayBuffer()),
        };
      } catch {
        throw new UpstreamDown('门店系统连不上');
      }
    },
  };
}
