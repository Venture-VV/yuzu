// 小程序网关（小程序线，docs/MINIPROGRAM.md 第 1、12 节）：网关 → 真实的 yuzu 小程序端口（测试库）整条链路，模拟微信；
// 会话（签名、过期、篡改）；展示内容缓存与门店断外网时给旧的；会员接口要会话、连不上 503；微信真接口的请求格式（替身 fetch）；配置。

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../src/gateway/app';
import { ShowCache } from '../src/gateway/cache';
import { loadGatewayConfig, type GatewayConfig } from '../src/gateway/config';
import { issueSession, verifySession } from '../src/gateway/session';
import { createUpstream } from '../src/gateway/upstream';
import { createMockWechat, createWechat, WechatError } from '../src/gateway/wechat';
import { buildMpApp } from '../src/server/modules/mp/app';
import { createMember, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const SESSION = 'test-session-secret-0123456789abcdef-0123';
const CODE_SECRET = 'test-code-secret-0123456789abcdef-0123456';
let ctx: TestContext;
let yuzuMp: FastifyInstance;
let upstreamUrl: string;
let gw: FastifyInstance;

const gatewayConfig = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  host: '127.0.0.1',
  port: 0,
  trustProxy: false,
  upstreamUrl,
  gatewayKey: KEY,
  sessionSecret: SESSION,
  sessionDays: 7,
  mockWechat: true,
  wechat: null,
  logLevel: 'silent',
  ...over,
});

beforeAll(async () => {
  ctx = await setup();
  yuzuMp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY, codeSecret: CODE_SECRET } });
  await yuzuMp.listen({ host: '127.0.0.1', port: 0 });
  upstreamUrl = `http://127.0.0.1:${(yuzuMp.server.address() as AddressInfo).port}`;
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
  gw = await buildGateway({ config: gatewayConfig(), wechat: createMockWechat(), upstream: createUpstream(upstreamUrl, KEY) });
});
afterAll(async () => {
  await gw.close();
  await yuzuMp.close();
  await ctx.close();
});

const login = async (app: FastifyInstance, name: string) => {
  const res = await app.inject({ method: 'POST', url: '/v1/login', payload: { code: `mock-${name}` } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
};
const authed = (app: FastifyInstance, token: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });

describe('登录与会话', () => {
  it('微信登录换网关会话；code 不对拒绝', async () => {
    const res = await gw.inject({ method: 'POST', url: '/v1/login', payload: { code: 'mock-alice' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toMatch(/^v1\./);
    expect(Date.parse(res.json().expiresAt)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(res.headers['cache-control']).toBe('no-store');
    const bad = await gw.inject({ method: 'POST', url: '/v1/login', payload: { code: 'not-mock' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('WX_LOGIN_FAILED');
    expect((await gw.inject({ method: 'POST', url: '/v1/login', payload: {} })).statusCode).toBe(400);
  });

  it('会话只认网关签的、没过期的；里面只有 openid', () => {
    const { token } = issueSession(SESSION, 'openid-abc', 7);
    expect(verifySession(SESSION, token)).toBe('openid-abc');
    expect(verifySession('another-secret-0123456789abcdef-0123', token)).toBeNull();
    const [v, payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ o: 'someone-else', e: 9_999_999_999 })).toString('base64url');
    expect(verifySession(SESSION, `${v}.${forged}.${sig}`)).toBeNull();
    expect(verifySession(SESSION, `${v}.${payload}.${sig}x`)).toBeNull();
    expect(verifySession(SESSION, 'garbage')).toBeNull();
    const expired = issueSession(SESSION, 'openid-abc', 1, Date.now() - 2 * 86_400_000).token;
    expect(verifySession(SESSION, expired)).toBeNull();
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ o: 'openid-abc', e: expect.any(Number) });
  });
});

describe('整条链路：小程序 → 网关 → yuzu', () => {
  it('不登录也能看门店信息、价目、导览', async () => {
    const home = await gw.inject({ method: 'GET', url: '/v1/home' });
    expect(home.statusCode).toBe(200);
    expect(home.json().stores.map((s: { code: string }) => s.code)).toEqual(['baoan', 'futian']);
    expect((await gw.inject({ method: 'GET', url: '/v1/prices' })).json().tickets.length).toBeGreaterThan(0);
    expect((await gw.inject({ method: 'GET', url: '/v1/guide' })).statusCode).toBe(200);
  });

  it('绑定（模拟手机号验证）、会员卡、流水、券、会员码', async () => {
    await createMember(ctx, '演示·网关会员', '13700002001');
    const token = await login(gw, 'bob');
    expect((await authed(gw, token, 'GET', '/v1/me')).json()).toEqual({ bound: false, member: null });
    const bad = await authed(gw, token, 'POST', '/v1/bind', { phoneCode: 'not-a-mock-code', clientKey: randomUUID() });
    expect(bad.json().error.code).toBe('WX_PHONE_FAILED');
    const notMember = await authed(gw, token, 'POST', '/v1/bind', { phoneCode: 'mock-phone-13900000000', clientKey: randomUUID() });
    expect(notMember.statusCode).toBe(404);
    expect(notMember.json().error).toEqual({ code: 'NOT_MEMBER', message: '这个手机号还不是会员，请到前台开卡' });
    const bound = await authed(gw, token, 'POST', '/v1/bind', { phoneCode: 'mock-phone-13700002001', clientKey: randomUUID() });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toMatchObject({ status: 'bound', member: { name: '演示·网关会员' } });
    // 网关转给 yuzu 时标了模拟微信
    const [row] = await ctx.sql<{ openid: string; mock: boolean }[]>`SELECT openid, mock FROM mp_bindings WHERE phone = '13700002001'`;
    expect(row).toEqual({ openid: 'mock_bob', mock: true });
    expect((await authed(gw, token, 'GET', '/v1/me')).json().member).toMatchObject({ name: '演示·网关会员', principalBalance: 0 });
    expect((await authed(gw, token, 'GET', '/v1/ledger?limit=10')).json()).toEqual([]);
    expect((await authed(gw, token, 'GET', '/v1/coupons')).json()).toEqual([]);
    const code = await authed(gw, token, 'POST', '/v1/code');
    expect(code.statusCode).toBe(200);
    expect(code.json().code).toMatch(/^8\d{15}$/);
  });

  it('绑定结果不确定时确认作废：网关带上会话里的微信转给 yuzu', async () => {
    await createMember(ctx, '演示·网关作废', '13700002002');
    const token = await login(gw, 'carol');
    const clientKey = randomUUID();
    const a = await authed(gw, token, 'POST', '/v1/bind/abandon', { clientKey });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toEqual({ status: 'abandoned' });
    const [fence] = await ctx.sql<{ openid: string }[]>`SELECT openid FROM mp_op_fences WHERE key = ${clientKey}`;
    expect(fence).toEqual({ openid: 'mock_carol' });
    const late = await authed(gw, token, 'POST', '/v1/bind', { phoneCode: 'mock-phone-13700002002', clientKey });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('OP_ABANDONED');
    expect((await authed(gw, token, 'POST', '/v1/bind/abandon', { clientKey: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await authed(gw, null, 'POST', '/v1/bind/abandon', { clientKey })).statusCode).toBe(401);
  });

  it('会员接口要会话；伪造、过期的会话拒绝', async () => {
    for (const [method, url] of [['GET', '/v1/me'], ['GET', '/v1/ledger'], ['GET', '/v1/coupons'], ['POST', '/v1/code'], ['POST', '/v1/bind']] as const) {
      const res = await authed(gw, null, method, url, method === 'POST' ? {} : undefined);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SESSION_REQUIRED');
    }
    const expired = issueSession(SESSION, 'mock_bob', 1, Date.now() - 2 * 86_400_000).token;
    expect((await authed(gw, expired, 'GET', '/v1/me')).statusCode).toBe(401);
    const otherSecret = issueSession('another-secret-0123456789abcdef-0123', 'mock_bob', 7).token;
    expect((await authed(gw, otherSecret, 'GET', '/v1/me')).statusCode).toBe(401);
  });

  it('网关密钥不对时 yuzu 拒绝，网关不会冒充', async () => {
    const wrong = await buildGateway({ config: gatewayConfig(), wechat: createMockWechat(), upstream: createUpstream(upstreamUrl, 'x'.repeat(40)) });
    const res = await wrong.inject({ method: 'GET', url: '/v1/home' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MP_GATEWAY_REJECTED');
    await wrong.close();
  });
});

describe('门店断外网', () => {
  it('展示内容给旧的；会员接口 503；没缓存过的也 503', async () => {
    // 单独起一个 yuzu 小程序端口，之后关掉，模拟门店连不上
    const mp2 = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } });
    await mp2.listen({ host: '127.0.0.1', port: 0 });
    const url2 = `http://127.0.0.1:${(mp2.server.address() as AddressInfo).port}`;
    const cache = new ShowCache();
    const g = await buildGateway({ config: gatewayConfig({ upstreamUrl: url2 }), wechat: createMockWechat(), upstream: createUpstream(url2, KEY, 1_000), cache });
    const first = await g.inject({ method: 'GET', url: '/v1/prices' });
    expect(first.headers['x-cache']).toBe('miss');
    expect((await g.inject({ method: 'GET', url: '/v1/prices' })).headers['x-cache']).toBe('fresh');
    await mp2.close();
    // 让缓存过期但还在保留期内
    const hit = cache.get('prices')!;
    cache.set('prices', hit.value, 1, 7 * 86_400_000, Date.now() - 10);
    const stale = await g.inject({ method: 'GET', url: '/v1/prices' });
    expect(stale.statusCode).toBe(200);
    expect(stale.headers['x-cache']).toBe('stale');
    expect(stale.json()).toEqual(first.json());
    const token = await login(g, 'carol');
    const me = await authed(g, token, 'GET', '/v1/me');
    expect(me.statusCode).toBe(503);
    expect(me.json().error.code).toBe('STORE_OFFLINE');
    expect((await g.inject({ method: 'GET', url: '/v1/home' })).json().error.code).toBe('STORE_OFFLINE');
    expect((await g.inject({ method: 'GET', url: '/v1/health' })).json()).toMatchObject({ ok: true, store: 'offline', mockWechat: true });
    await g.close();
  });

  it('正式、演练的 yuzu 拒绝模拟绑定（网关原样转回）', async () => {
    const prod = await buildMpApp(ctx.sql, { ...ctx.config, env: 'production', mp: { ...ctx.config.mp, gatewayKey: KEY } });
    await prod.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(prod.server.address() as AddressInfo).port}`;
    const g = await buildGateway({ config: gatewayConfig({ upstreamUrl: url }), wechat: createMockWechat(), upstream: createUpstream(url, KEY) });
    const token = await login(g, 'dave');
    const res = await authed(g, token, 'POST', '/v1/bind', { phoneCode: 'mock-phone-13700002001', clientKey: randomUUID() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MP_MOCK_REFUSED');
    await g.close();
    await prod.close();
  });
});

describe('微信真接口（替身 fetch）', () => {
  it('code2Session、手机号验证的请求格式；只认中国大陆手机号；凭据缓存', async () => {
    const calls: { url: string; body?: string }[] = [];
    const replies: Record<string, unknown> = {
      jscode2session: { openid: 'o-real-1', session_key: 'secret-session-key' },
      stable_token: { access_token: 'AT-1', expires_in: 7200 },
      getuserphonenumber: { errcode: 0, phone_info: { purePhoneNumber: '13700002002', countryCode: '86' } },
    };
    const fakeFetch = async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body });
      const key = Object.keys(replies).find((k) => url.includes(k))!;
      return { ok: true, status: 200, json: async () => replies[key] };
    };
    const wx = createWechat('wx-app-id', 'wx-app-secret', fakeFetch);
    expect(await wx.login('code-123')).toEqual({ openid: 'o-real-1' });
    const q = new URL(calls[0]!.url).searchParams;
    expect(Object.fromEntries(q)).toEqual({ appid: 'wx-app-id', secret: 'wx-app-secret', js_code: 'code-123', grant_type: 'authorization_code' });
    expect(await wx.phoneNumber('phone-code-1')).toEqual({ phone: '13700002002' });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ grant_type: 'client_credential', appid: 'wx-app-id', secret: 'wx-app-secret' });
    expect(calls[2]!.url).toContain('access_token=AT-1');
    expect(JSON.parse(calls[2]!.body!)).toEqual({ code: 'phone-code-1' });
    await wx.phoneNumber('phone-code-2');
    expect(calls.filter((c) => c.url.includes('stable_token'))).toHaveLength(1);
    replies.getuserphonenumber = { errcode: 0, phone_info: { purePhoneNumber: '91234567', countryCode: '852' } };
    await expect(wx.phoneNumber('phone-code-3')).rejects.toBeInstanceOf(WechatError);
    replies.jscode2session = { errcode: 40029, errmsg: 'invalid code' };
    await expect(wx.login('code-456')).rejects.toMatchObject({ code: 'WX_LOGIN_FAILED' });
  });
});

describe('配置', () => {
  const base = { MP_UPSTREAM_URL: 'http://100.64.0.10:8081', MP_GATEWAY_KEY: KEY, MP_SESSION_SECRET: SESSION };
  it('缺密钥、密钥太短、没配微信也没开模拟都不启动', () => {
    expect(() => loadGatewayConfig({ ...base, MP_GATEWAY_KEY: 'short', MP_MOCK_WECHAT: 'true' })).toThrow(/MP_GATEWAY_KEY/);
    expect(() => loadGatewayConfig({ ...base, MP_SESSION_SECRET: '', MP_MOCK_WECHAT: 'true' })).toThrow(/MP_SESSION_SECRET/);
    expect(() => loadGatewayConfig(base)).toThrow(/WX_APPID/);
    expect(() => loadGatewayConfig({ ...base, MP_UPSTREAM_URL: 'ftp://x', MP_MOCK_WECHAT: 'true' })).toThrow(/MP_UPSTREAM_URL/);
    const ok = loadGatewayConfig({ ...base, WX_APPID: 'wxid', WX_APPSECRET: 'wxsecret' });
    expect(ok).toMatchObject({ host: '127.0.0.1', port: 8300, mockWechat: false, sessionDays: 7, wechat: { appId: 'wxid', appSecret: 'wxsecret' } });
  });
});
