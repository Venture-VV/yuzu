// 登录按来源 IP 限次（Z4，店主 2026-11-07 按默认，8.0.1，docs/PURCHASING_V801.md 末节）：
// 同一来源 10 分钟失败 30 次拦 15 分钟；同一账号在同一来源 15 分钟内错 5 次锁 5 分钟，别的来源照常。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/server/app';
import { checkLock, clearFailures, recordFailure, resetLoginThrottle } from '../src/server/auth/lockout';
import { PASSWORD, setup, type TestContext } from './helpers';

const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
};

describe('计数规则（只在内存里）', () => {
  beforeEach(() => {
    resetLoginThrottle();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('同一账号在同一来源错 5 次锁 5 分钟，换一个来源照常', () => {
    for (let i = 0; i < 4; i++) recordFailure('owner', '203.0.113.1');
    expect(codeOf(() => checkLock('owner', '203.0.113.1'))).toBeNull();
    recordFailure('owner', '203.0.113.1');
    expect(codeOf(() => checkLock('owner', '203.0.113.1'))).toBe('LOGIN_LOCKED');
    expect(codeOf(() => checkLock('owner', '203.0.113.2'))).toBeNull();
    expect(codeOf(() => checkLock('clerk', '203.0.113.1'))).toBeNull();
    vi.setSystemTime(new Date('2026-11-07T10:05:01Z'));
    expect(codeOf(() => checkLock('owner', '203.0.113.1'))).toBeNull();
  });

  it('15 分钟以前的失败不算：窗口过了从头数', () => {
    for (let i = 0; i < 4; i++) recordFailure('owner', '203.0.113.1');
    vi.setSystemTime(new Date('2026-11-07T10:15:01Z'));
    recordFailure('owner', '203.0.113.1');
    expect(codeOf(() => checkLock('owner', '203.0.113.1'))).toBeNull();
  });

  it('同一来源 10 分钟失败 30 次（换着账号试）拦 15 分钟，任何账号都不行；别的来源照常', () => {
    for (let i = 0; i < 29; i++) recordFailure(`guess-${i}`, '198.51.100.7');
    expect(codeOf(() => checkLock('owner', '198.51.100.7'))).toBeNull();
    recordFailure('guess-29', '198.51.100.7');
    expect(codeOf(() => checkLock('owner', '198.51.100.7'))).toBe('LOGIN_SOURCE_BLOCKED');
    expect(codeOf(() => checkLock('owner', '198.51.100.8'))).toBeNull();
    vi.setSystemTime(new Date('2026-11-07T10:15:01Z'));
    expect(codeOf(() => checkLock('owner', '198.51.100.7'))).toBeNull();
  });

  it('10 分钟窗口：过了窗口的失败不累计到 30', () => {
    for (let i = 0; i < 20; i++) recordFailure(`guess-${i}`, '198.51.100.7');
    vi.setSystemTime(new Date('2026-11-07T10:10:01Z'));
    for (let i = 0; i < 20; i++) recordFailure(`guess-${i}`, '198.51.100.7');
    expect(codeOf(() => checkLock('owner', '198.51.100.7'))).toBeNull();
  });

  it('登录成功只清这个账号在这个来源的计数，来源的计数照样算', () => {
    for (let i = 0; i < 4; i++) recordFailure('owner', '203.0.113.1');
    for (let i = 0; i < 24; i++) recordFailure(`guess-${i}`, '203.0.113.1');
    clearFailures('owner', '203.0.113.1');
    // 账号从头数（1 次），来源接着数（29 次）
    recordFailure('owner', '203.0.113.1');
    expect(codeOf(() => checkLock('owner', '203.0.113.1'))).toBeNull();
    recordFailure('guess-x', '203.0.113.1');
    expect(codeOf(() => checkLock('clerk', '203.0.113.1'))).toBe('LOGIN_SOURCE_BLOCKED');
  });
});

describe('登录接口（信任代理时按真实来源算）', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => ctx.close());
  beforeEach(() => resetLoginThrottle());

  const login = async (app: Awaited<ReturnType<typeof buildApp>>, ip: string, username: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': ip }, payload: { username, password } });
    return { status: res.statusCode, code: (res.json() as { error?: { code?: string } }).error?.code ?? null };
  };

  it('店主账号在一个地址被试错 5 次锁住，别的地址（店里的电脑）照常登录', async () => {
    const app = await buildApp(ctx.sql, { ...ctx.config, trustProxy: ['127.0.0.1'] });
    try {
      for (let i = 0; i < 5; i++) expect((await login(app, '203.0.113.50', 'owner', `wrong-${i}`)).status).toBe(401);
      expect(await login(app, '203.0.113.50', 'owner', PASSWORD)).toEqual({ status: 429, code: 'LOGIN_LOCKED' });
      expect((await login(app, '192.168.1.20', 'owner', PASSWORD)).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('一个地址换着账号试错 30 次，这个地址谁都登不了；别的地址照常', async () => {
    const app = await buildApp(ctx.sql, { ...ctx.config, trustProxy: ['127.0.0.1'] });
    try {
      for (let i = 0; i < 30; i++) expect((await login(app, '198.51.100.9', `nobody-${i}`, 'whatever-1')).status).toBe(401);
      expect(await login(app, '198.51.100.9', 'owner', PASSWORD)).toEqual({ status: 429, code: 'LOGIN_SOURCE_BLOCKED' });
      expect((await login(app, '198.51.100.10', 'owner', PASSWORD)).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
