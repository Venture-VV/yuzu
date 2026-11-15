// 8.1.3 服务端防护（docs/RESILIENCE_V813.md 第 3.5 节，WL8–WL11）：/api/ping、过载保护、频率限制、访问网段、
// 死锁与串行化冲突当「系统忙」、页面报错接口。防护的拒绝都发生在处理之前，页面据此原样自动重发。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { createSql } from '../src/server/db';
import { DEFAULT_PROTECTION, TokenBuckets, buildAllowList, ipAllowed, loadProtectionConfig, type ProtectionConfig } from '../src/server/lib/protect';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
const extra: FastifyInstance[] = [];

beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  for (const app of extra) await app.close();
  await ctx.close();
});

/** 用同一个库另起一个应用，防护的数字按这次的设 */
async function appWith(protection: Partial<ProtectionConfig>, more: Parameters<typeof loadConfig>[0] = {}) {
  const config = loadConfig({
    databaseUrl: ctx.config.databaseUrl,
    env: 'test',
    logLevel: 'silent',
    integrations: { mock: true, liveConfigured: [] },
    protection: { ...DEFAULT_PROTECTION, maxLagMs: 0, ...protection },
    ...more,
  });
  const app = await buildApp(ctx.sql, config);
  extra.push(app);
  return app;
}

describe('页面问「连不连得上」：/api/ping', () => {
  it('不读会话、不查库：数据库断了以后 /api/ping 照常回版本，/api/health 报错', async () => {
    const own = createSql(ctx.config.databaseUrl, { max: 1 });
    const config = loadConfig({ databaseUrl: ctx.config.databaseUrl, env: 'test', logLevel: 'silent', integrations: { mock: true, liveConfigured: [] } });
    const app = await buildApp(own, config);
    try {
      await app.ready();
      await own.end({ timeout: 1 }); // 之后再查库都会失败
      const ping = await app.inject({ method: 'GET', url: '/api/ping', headers: { cookie: 'yuzu_sid=whatever' } });
      expect(ping.statusCode).toBe(200);
      const body = ping.json();
      expect(body).toMatchObject({ ok: true, version: config.version, instance: config.instance });
      expect(body.client === null || /^\/assets\/[^/]+\.js$/.test(body.client)).toBe(true);
      expect(ping.headers['cache-control']).toBe('no-store');
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});

describe('过载保护（WL8）', () => {
  it('同时在处理的请求到了上限：新来的回 503 OVERLOADED + Retry-After（没处理）；/api/ping 不受影响；处理完以后恢复', async () => {
    const app = await appWith({ maxInFlight: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.get('/api/test/slow', async () => {
      await gate;
      return { ok: true };
    });
    const owner = await login(app, 'owner');
    const slow = app.inject({ method: 'GET', url: '/api/test/slow', headers: { cookie: owner } });
    await new Promise((r) => setTimeout(r, 50));
    const shed = await app.inject({ method: 'POST', url: '/api/members', headers: { cookie: owner }, payload: { name: '过载时', phone: '16612340001' } });
    expect(shed.statusCode).toBe(503);
    expect(shed.headers['retry-after']).toBe('2');
    expect(shed.json().error.code).toBe('OVERLOADED');
    // 确定没处理：会员没建
    const [found] = await ctx.sql`SELECT count(*)::int AS n FROM members WHERE phone = '16612340001'`;
    expect(found!.n).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/ping' })).statusCode).toBe(200);
    release();
    expect((await slow).statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner } });
    expect(after.statusCode).toBe(200);
  });

  it('出错的请求、被拒的请求都不会占着名额（上限 2，连发 10 个出错的以后照常能用）', async () => {
    const app = await appWith({ maxInFlight: 2 });
    app.get('/api/test/boom', async () => {
      throw new Error('boom');
    });
    const owner = await login(app, 'owner');
    for (let i = 0; i < 10; i++) expect((await app.inject({ method: 'GET', url: '/api/test/boom', headers: { cookie: owner } })).statusCode).toBe(500);
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'GET', url: '/api/members?q=x', headers: { cookie: 'yuzu_sid=bad' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner } })).statusCode).toBe(200);
  });
});

describe('频率限制（WL9）', () => {
  it('登录了的按会话算：超了回 429 RATE_LIMITED + Retry-After，另一位不受影响', async () => {
    const app = await appWith({ sessionPerMin: 5 });
    const owner = await login(app, 'owner');
    const clerk = await login(app, 'clerk');
    for (let i = 0; i < 5; i++) expect((await api(app, owner, 'GET', '/api/auth/me')).status).toBe(200);
    const limited = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await api(app, clerk, 'GET', '/api/auth/me')).status).toBe(200);
    // 问「连不连得上」不算次数
    for (let i = 0; i < 10; i++) expect((await app.inject({ method: 'GET', url: '/api/ping', headers: { cookie: owner } })).statusCode).toBe(200);
  });

  it('没登录的按 IP 算；写请求被限时确定没处理', async () => {
    const app = await appWith({ ipPerMin: 3 });
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: 'GET', url: '/api/public/info', remoteAddress: '10.1.2.3' })).statusCode).toBe(200);
    const limited = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.1.2.3', payload: { username: 'owner', password: 'x' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    // 别的地址不受影响
    expect((await app.inject({ method: 'GET', url: '/api/public/info', remoteAddress: '10.1.2.4' })).statusCode).toBe(200);
  });

  it('令牌桶：按时间补、算出要等几秒；早就补满的会被清掉；键太多先丢最早的', () => {
    const b = new TokenBuckets(2, 1);
    expect(b.take('a', 0).ok).toBe(true);
    expect(b.take('a', 0).ok).toBe(true);
    const no = b.take('a', 0);
    expect(no).toEqual({ ok: false, retryAfterSec: 1 });
    expect(b.take('a', 1000).ok).toBe(true);
    b.sweep(10_000);
    expect(b.size).toBe(0);
    const small = new TokenBuckets(1, 1, 10);
    for (let i = 0; i < 25; i++) small.take(`k${i}`, 0);
    expect(small.size).toBeLessThanOrEqual(10);
  });
});

describe('访问网段（WL10）', () => {
  it('设了以后：网段外的接口回 403 ACCESS_DENIED；/api/ping、/api/health、供应商与对账链接照常；网段里的照常', async () => {
    const app = await appWith({ allowCidrs: ['10.9.0.0/16', '100.64.0.0/10'] });
    const out = await app.inject({ method: 'GET', url: '/api/public/info', remoteAddress: '203.0.113.9' });
    expect(out.statusCode).toBe(200); // /api/public/* 对外
    const denied = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.9', payload: { username: 'owner', password: 'x' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('ACCESS_DENIED');
    expect((await app.inject({ method: 'GET', url: '/api/ping', remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
    // 编码过的路径一样拦
    expect((await app.inject({ method: 'GET', url: '/%61pi/auth/session', remoteAddress: '203.0.113.9' })).statusCode).toBe(403);
    const inside = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.9.8.7', payload: { username: 'owner', password: 'password-123' } });
    expect(inside.statusCode).not.toBe(403);
    const tailscale = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '100.101.1.2' });
    expect(tailscale.statusCode).toBe(401); // 进来了，只是没登录
  });

  it('前面有反向代理时按它转来的地址认（TRUST_PROXY）', async () => {
    const app = await appWith({ allowCidrs: ['10.9.0.0/16'] }, { trustProxy: ['127.0.0.1'] });
    const via = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '10.9.1.1' } });
    expect(via.statusCode).toBe(401);
    const spoofed = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '198.51.100.7', headers: { 'x-forwarded-for': '10.9.1.1' } });
    expect(spoofed.statusCode).toBe(403); // 不信任的来源自己写的转发头不算
  });

  it('网段的写法：单个地址、IPv6、IPv4 映射；写错的启动就报错', () => {
    const list = buildAllowList(['192.168.1.0/24', '10.0.0.5', 'fd7a:115c:a1e0::/48'])!;
    expect(ipAllowed(list, '192.168.1.77')).toBe(true);
    expect(ipAllowed(list, '::ffff:192.168.1.77')).toBe(true);
    expect(ipAllowed(list, '192.168.2.1')).toBe(false);
    expect(ipAllowed(list, '10.0.0.5')).toBe(true);
    expect(ipAllowed(list, '10.0.0.6')).toBe(false);
    expect(ipAllowed(list, 'fd7a:115c:a1e0:ab12::1')).toBe(true);
    expect(ipAllowed(list, 'not-an-ip')).toBe(false);
    expect(() => buildAllowList(['192.168.1.0/33'])).toThrow(/前缀长度/);
    expect(() => buildAllowList(['store-lan'])).toThrow(/不是地址或网段/);
    expect(() => loadProtectionConfig({ ACCESS_ALLOW_CIDRS: '10.0.0.0/8, oops' }, 'production')).toThrow(/oops/);
    expect(() => loadProtectionConfig({ RATE_LIMIT_IP_PER_MIN: '-1' }, 'production')).toThrow(/RATE_LIMIT_IP_PER_MIN/);
    expect(loadProtectionConfig({}, 'production')).toEqual(DEFAULT_PROTECTION);
    expect(loadProtectionConfig({}, 'test').maxLagMs).toBe(0);
    expect(loadProtectionConfig({ OVERLOAD_MAX_INFLIGHT: '0', RATE_LIMIT_SESSION_PER_MIN: '0' }, 'production')).toMatchObject({ maxInFlight: 0, sessionPerMin: 0 });
  });
});

describe('死锁、串行化冲突当「系统忙」（WL5）', () => {
  it('40P01、40001 与等锁超时一样回 409 BUSY（事务已回滚，页面带原编号自动重发）', async () => {
    const app = await appWith({});
    app.get('/api/test/deadlock', async () => {
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    });
    app.get('/api/test/serialization', async () => {
      throw Object.assign(new Error('could not serialize access'), { code: '40001' });
    });
    for (const url of ['/api/test/deadlock', '/api/test/serialization']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('BUSY');
    }
  });

  it('真的死锁：两个事务反着顺序锁两行，数据库判一个死锁、回滚，接口回 BUSY', async () => {
    const app = await appWith({});
    const [a, b] = await ctx.sql<{ id: number }[]>`INSERT INTO settings (key, value) VALUES ('test_deadlock_a', '1'::jsonb), ('test_deadlock_b', '1'::jsonb) RETURNING 1 AS id`;
    expect(a && b).toBeTruthy();
    const both = (first: string, second: string) => async () =>
      ctx.sql.begin(async (tx) => {
        await tx`SELECT 1 FROM settings WHERE key = ${first} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 200));
        await tx`SELECT 1 FROM settings WHERE key = ${second} FOR UPDATE`;
        return { ok: true };
      });
    app.get('/api/test/ab', both('test_deadlock_a', 'test_deadlock_b'));
    app.get('/api/test/ba', both('test_deadlock_b', 'test_deadlock_a'));
    const [x, y] = await Promise.all([app.inject({ method: 'GET', url: '/api/test/ab' }), app.inject({ method: 'GET', url: '/api/test/ba' })]);
    const codes = [x.statusCode, y.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = x.statusCode === 409 ? x : y;
    expect(loser.json().error.code).toBe('BUSY');
  });
});

describe('页面报错（WL7）', () => {
  it('不用登录也能报；店主看得到（地址去掉查询参数、带上是谁），店员看不到；格式不对、太长的不收', async () => {
    const app = await appWith({});
    const sent = await app.inject({
      method: 'POST',
      url: '/api/client-errors',
      remoteAddress: '10.20.30.40',
      payload: { kind: 'render', message: 'Cannot read properties of undefined', stack: 'at X (a.js:1:2)', path: '/frontdesk?tag=A001', entry: '/assets/index-old.js' },
    });
    expect(sent.statusCode).toBe(200);
    const owner = await login(app, 'owner');
    await api(app, owner, 'POST', '/api/client-errors', { kind: 'chunk', message: 'Failed to fetch dynamically imported module', path: '/admin/studio' });
    const list = await api(app, owner, 'GET', '/api/client-errors');
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({ kind: 'chunk', path: '/admin/studio', staff: { name: '测试店主' } });
    expect(list.body[1]).toMatchObject({ kind: 'render', path: '/frontdesk', entry: '/assets/index-old.js', staff: null, ip: '10.20.30.40' });
    const clerk = await login(app, 'clerk');
    expect((await api(app, clerk, 'GET', '/api/client-errors')).status).toBe(403);
    expect((await api(app, null, 'POST', '/api/client-errors', { kind: 'nope', message: 'x', path: '/' })).status).toBe(400);
    expect((await api(app, null, 'POST', '/api/client-errors', { kind: 'error', message: 'x'.repeat(501), path: '/' })).status).toBe(400);
    const tooBig = await app.inject({ method: 'POST', url: '/api/client-errors', payload: { kind: 'error', message: 'x', path: '/', stack: 'y'.repeat(9000) } });
    expect(tooBig.statusCode).toBe(413);
    // 别的网站发来的不收（修改类请求的来源检查）
    const cross = await app.inject({ method: 'POST', url: '/api/client-errors', headers: { origin: 'https://evil.example' }, payload: { kind: 'error', message: 'x', path: '/' } });
    expect(cross.statusCode).toBe(403);
  });

  it('每个 IP 每分钟最多 20 条', async () => {
    const app = await appWith({});
    const send = () => app.inject({ method: 'POST', url: '/api/client-errors', remoteAddress: '10.20.30.41', payload: { kind: 'error', message: 'x', path: '/' } });
    for (let i = 0; i < 20; i++) expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(429);
  });
});
