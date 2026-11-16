// 小程序端口过载保护与数据库忙（8.1.3，docs/RESILIENCE_V813.md 第 3.3、3.5 节）及网关衔接：
//   · 小程序端口：超过同时处理上限回 503 OVERLOADED + Retry-After（确定没处理），/api/mp/health 探活不受影响；
//     密钥不对、处理报错不占名额；等锁超时（55P03）、语句超时（57014）、死锁（40P01）、串行化冲突（40001）回 409 BUSY；
//   · 网关：展示内容遇到 OVERLOADED / BUSY 时优先回旧缓存（没有缓存时照实转回并带 Retry-After）；
//     带一次性微信手机号 code（/v1/bind、/v1/invites/:code/claim）换完手机号后遇到 OVERLOADED / BUSY 时，
//     网关带原操作编号短暂重发（不再调第二次微信换手机号），其余接口原样转回由小程序单层重发。

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../src/gateway/app';
import { ShowCache } from '../src/gateway/cache';
import type { GatewayConfig } from '../src/gateway/config';
import { createUpstream, type Upstream, type UpstreamResponse } from '../src/gateway/upstream';
import { createMockWechat, WechatError, type WechatClient } from '../src/gateway/wechat';
import { DEFAULT_PROTECTION, type ProtectionConfig } from '../src/server/lib/protect';
import { buildMpApp } from '../src/server/modules/mp/app';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER } from '../src/shared/mp';
import { createMember, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const SESSION = 'test-session-secret-0123456789abcdef-0123';
const CODE_SECRET = 'test-code-secret-0123456789abcdef-0123456';

let ctx: TestContext;
const extra: FastifyInstance[] = [];

beforeAll(async () => {
  ctx = await setup();
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
});

afterAll(async () => {
  for (const app of extra) await app.close();
  await ctx.close();
});

async function mpWith(protection: Partial<ProtectionConfig> = {}) {
  const app = await buildMpApp(
    ctx.sql,
    {
      ...ctx.config,
      protection: { ...DEFAULT_PROTECTION, maxLagMs: 0, ...protection },
      mp: { ...ctx.config.mp, gatewayKey: KEY, codeSecret: CODE_SECRET },
    },
    { sweepMs: 0 },
  );
  extra.push(app);
  return app;
}

const gatewayConfig = (upstreamUrl: string, over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  host: '127.0.0.1',
  port: 0,
  trustProxy: false,
  upstreamUrl,
  gatewayKey: KEY,
  sessionSecret: SESSION,
  sessionDays: 7,
  mockWechat: true,
  wechat: null,
  reminderSeconds: 0,
  subscribeState: 'developer',
  logLevel: 'silent',
  ...over,
});

describe('小程序端口：过载保护与数据库忙（8.1.3）', () => {
  it('同时在处理的请求到了上限：新请求回 503 OVERLOADED + Retry-After（确定没处理）；/api/mp/health 不受影响；完成后恢复', async () => {
    const mp = await mpWith({ maxInFlight: 1 });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    mp.get('/api/mp/test/slow', async () => {
      await hold;
      return { ok: true };
    });
    await createMember(ctx, '演示·过载保护', '13688880001');

    const slow = mp.inject({ method: 'GET', url: '/api/mp/test/slow', headers: { [MP_GATEWAY_HEADER]: KEY } });
    await new Promise((r) => setTimeout(r, 40));

    const openid = `mp_overload_${randomUUID().slice(0, 8)}`;
    const shed = await mp.inject({
      method: 'POST',
      url: '/api/mp/bind',
      headers: { [MP_GATEWAY_HEADER]: KEY, [MP_OPENID_HEADER]: openid },
      payload: { clientKey: randomUUID(), phone: '13688880001', mock: true, bindVersion: 0 },
    });
    expect(shed.statusCode).toBe(503);
    expect(shed.headers['retry-after']).toBe('2');
    expect(shed.json().error.code).toBe('OVERLOADED');

    // 确定没处理：没有建绑定
    const [bound] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mp_bindings WHERE openid = ${openid}`;
    expect(bound!.n).toBe(0);

    // 网关探活不受过载保护影响（包括编码过的路径）
    const health = await mp.inject({ method: 'GET', url: '/api/mp/health', headers: { [MP_GATEWAY_HEADER]: KEY } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    release();
    expect((await slow).statusCode).toBe(200);

    const after = await mp.inject({
      method: 'POST',
      url: '/api/mp/bind',
      headers: { [MP_GATEWAY_HEADER]: KEY, [MP_OPENID_HEADER]: openid },
      payload: { clientKey: randomUUID(), phone: '13688880001', mock: true, bindVersion: 0 },
    });
    expect(after.statusCode).toBe(200);
  });

  it('网关密钥不对的请求与处理出错的请求都不占着名额', async () => {
    const mp = await mpWith({ maxInFlight: 2 });
    mp.get('/api/mp/test/boom', async () => {
      throw new Error('boom');
    });
    for (let i = 0; i < 8; i++) {
      expect((await mp.inject({ method: 'GET', url: '/api/mp/home', headers: { [MP_GATEWAY_HEADER]: 'wrong' } })).statusCode).toBe(401);
      expect((await mp.inject({ method: 'GET', url: '/api/mp/test/boom', headers: { [MP_GATEWAY_HEADER]: KEY } })).statusCode).toBe(500);
    }
    expect((await mp.inject({ method: 'GET', url: '/api/mp/home', headers: { [MP_GATEWAY_HEADER]: KEY } })).statusCode).toBe(200);
  });

  it('55P03、57014、40P01、40001 回 409 BUSY（不再回 500 INTERNAL）；真实死锁回滚后回 BUSY', async () => {
    const mp = await mpWith();
    const codes = ['55P03', '57014', '40P01', '40001'] as const;
    for (const code of codes) {
      mp.get(`/api/mp/test/pg-${code}`, async () => {
        throw Object.assign(new Error(`pg ${code}`), { code });
      });
    }
    const lockOrder = (first: string, second: string) => async () =>
      ctx.sql.begin(async (tx) => {
        await tx`SELECT 1 FROM settings WHERE key = ${first} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 150));
        await tx`SELECT 1 FROM settings WHERE key = ${second} FOR UPDATE`;
        return { ok: true };
      });
    mp.get('/api/mp/test/dl-ab', lockOrder('mp_deadlock_a', 'mp_deadlock_b'));
    mp.get('/api/mp/test/dl-ba', lockOrder('mp_deadlock_b', 'mp_deadlock_a'));

    for (const code of codes) {
      const res = await mp.inject({ method: 'GET', url: `/api/mp/test/pg-${code}`, headers: { [MP_GATEWAY_HEADER]: KEY } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toEqual({ code: 'BUSY', message: '门店系统正忙，这次没有生效，请稍后再试' });
    }

    await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_deadlock_a', '1'::jsonb), ('mp_deadlock_b', '1'::jsonb) ON CONFLICT (key) DO NOTHING`;
    const [x, y] = await Promise.all([
      mp.inject({ method: 'GET', url: '/api/mp/test/dl-ab', headers: { [MP_GATEWAY_HEADER]: KEY } }),
      mp.inject({ method: 'GET', url: '/api/mp/test/dl-ba', headers: { [MP_GATEWAY_HEADER]: KEY } }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    const loser = x.statusCode === 409 ? x : y;
    expect(loser.json().error.code).toBe('BUSY');
  });
});

describe('网关衔接：展示缓存兜底与一次性 phoneCode 单层重发', () => {
  it('展示内容（含工作台版面 freshMs=0）遇到门店 OVERLOADED / BUSY：有旧缓存给 stale，没缓存转回并保留 Retry-After', async () => {
    let mode: 'ok' | 'overloaded' | 'busy' = 'ok';
    const upstream: Upstream = {
      async call(_method, path): Promise<UpstreamResponse> {
        if (mode === 'overloaded') {
          return {
            status: 503,
            contentType: 'application/json; charset=utf-8',
            cacheControl: null,
            retryAfter: '2',
            body: Buffer.from(JSON.stringify({ error: { code: 'OVERLOADED', message: '系统正忙，这次没有处理，页面会自动稍后再试' } })),
          };
        }
        if (mode === 'busy') {
          return {
            status: 409,
            contentType: 'application/json; charset=utf-8',
            cacheControl: null,
            body: Buffer.from(JSON.stringify({ error: { code: 'BUSY', message: '门店系统正忙，这次没有生效，请稍后再试' } })),
          };
        }
        return {
          status: 200,
          contentType: 'application/json; charset=utf-8',
          cacheControl: null,
          body: Buffer.from(JSON.stringify(path.startsWith('/api/mp/studio') ? { version: 3 } : { stores: [{ code: 'baoan' }], banners: [] })),
        };
      },
    };
    const cache = new ShowCache();
    const gw = await buildGateway({ config: gatewayConfig('http://127.0.0.1:9'), wechat: createMockWechat(), upstream, cache, retryDelayMs: () => 1 });
    extra.push(gw);

    // 还没缓存过时遇到过载：原样转回 503 OVERLOADED 并带 Retry-After
    mode = 'overloaded';
    const cold = await gw.inject({ method: 'GET', url: '/v1/home' });
    expect(cold.statusCode).toBe(503);
    expect(cold.headers['retry-after']).toBe('2');
    expect(cold.json().error.code).toBe('OVERLOADED');

    // 取成功一次以后，即使工作台版面 freshMs=0 每次去问门店，遇到过载或锁忙也回缓存里的上一版
    mode = 'ok';
    const first = await gw.inject({ method: 'GET', url: '/v1/studio' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('miss');

    mode = 'overloaded';
    const stale1 = await gw.inject({ method: 'GET', url: '/v1/studio' });
    expect(stale1.statusCode).toBe(200);
    expect(stale1.headers['x-cache']).toBe('stale');
    expect(stale1.headers['retry-after']).toBeUndefined();
    expect(stale1.json()).toEqual({ version: 3 });

    mode = 'busy';
    const stale2 = await gw.inject({ method: 'GET', url: '/v1/studio' });
    expect(stale2.statusCode).toBe(200);
    expect(stale2.headers['x-cache']).toBe('stale');
    expect(stale2.json()).toEqual({ version: 3 });
  });

  it('一次性 phoneCode（绑定、领邀请）换出手机号后门店正忙：网关用同一个 clientKey 短暂重发，不调第二次微信换手机号；其余接口不叠层重发', async () => {
    await createMember(ctx, '演示·单次手机号绑定', '13688880002');
    const mp = await mpWith();
    await mp.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(mp.server.address() as AddressInfo).port}`;
    const real = createUpstream(url, KEY);

    const usedCodes = new Set<string>();
    const baseWechat = createMockWechat();
    const singleUseWechat: WechatClient = {
      ...baseWechat,
      async phoneNumber(code: string) {
        if (usedCodes.has(code)) throw new WechatError('WX_PHONE_FAILED', 'code been used');
        usedCodes.add(code);
        return baseWechat.phoneNumber(code);
      },
    };

    let bindAttempts = 0;
    let meAttempts = 0;
    const flakyUpstream: Upstream = {
      async call(method, path, o) {
        if (path === '/api/mp/bind') {
          bindAttempts += 1;
          if (bindAttempts === 1) {
            return {
              status: 503,
              contentType: 'application/json; charset=utf-8',
              cacheControl: null,
              retryAfter: '1',
              body: Buffer.from(JSON.stringify({ error: { code: 'OVERLOADED', message: '系统正忙' } })),
            };
          }
          if (bindAttempts === 2) {
            return {
              status: 409,
              contentType: 'application/json; charset=utf-8',
              cacheControl: null,
              body: Buffer.from(JSON.stringify({ error: { code: 'BUSY', message: '门店系统正忙' } })),
            };
          }
        }
        if (path === '/api/mp/me') {
          meAttempts += 1;
          return {
            status: 409,
            contentType: 'application/json; charset=utf-8',
            cacheControl: null,
            body: Buffer.from(JSON.stringify({ error: { code: 'BUSY', message: '门店系统正忙，这次没有生效，请稍后再试' } })),
          };
        }
        return real.call(method, path, o);
      },
    };

    const gw = await buildGateway({ config: gatewayConfig(url), wechat: singleUseWechat, upstream: flakyUpstream, retryDelayMs: () => 1 });
    extra.push(gw);

    const loginRes = await gw.inject({ method: 'POST', url: '/v1/login', payload: { code: 'mock-singlephone' } });
    const token = loginRes.json().token as string;
    const clientKey = randomUUID();
    const bindRes = await gw.inject({
      method: 'POST',
      url: '/v1/bind',
      headers: { authorization: `Bearer ${token}` },
      payload: { phoneCode: 'mock-phone-13688880002', clientKey, bindVersion: 0 },
    });
    expect(bindRes.statusCode).toBe(200);
    expect(bindRes.json()).toMatchObject({ status: 'bound', member: { name: '演示·单次手机号绑定' } });
    expect(bindAttempts).toBe(3);
    expect(usedCodes.size).toBe(1);

    // 非 phoneCode 接口网关不重发（只调 1 次），交给小程序单层重发
    const meRes = await gw.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(meRes.statusCode).toBe(409);
    expect(meRes.json().error.code).toBe('BUSY');
    expect(meAttempts).toBe(1);
  });
});
