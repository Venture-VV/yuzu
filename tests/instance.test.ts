// 实例标识与版本：YUZU_INSTANCE 的校验与按环境推断、版本去掉 v 前缀、提交 SHA 校验；登录页与会话里的标识；
// 演示账号提示只在开发环境出现；会员演示数据在试用、正式环境一律拒绝（--force 也不能绕过）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { loadConfig, resolveInstance, type AppConfig } from '../src/server/config';
import { seedDemo } from '../src/server/seed';
import { api, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

describe('实例标识（YUZU_INSTANCE）', () => {
  it('没设置时按 APP_ENV 推出；正式环境不推断', () => {
    expect(resolveInstance('development', undefined)).toBe('dev');
    expect(resolveInstance('test', '')).toBe('dev');
    expect(resolveInstance('trial', undefined)).toBe('trial');
    expect(resolveInstance('production', '  ')).toBe('unset');
  });

  it('只接受 prod / shadow / test / demo；prod 只能用于正式环境', () => {
    expect(resolveInstance('production', 'prod')).toBe('prod');
    expect(resolveInstance('production', 'shadow')).toBe('shadow');
    expect(resolveInstance('production', ' test ')).toBe('test');
    expect(resolveInstance('development', 'demo')).toBe('demo');
    expect(() => resolveInstance('production', 'staging')).toThrow(/YUZU_INSTANCE/);
    expect(() => resolveInstance('development', 'prod')).toThrow(/APP_ENV=production/);
    expect(() => resolveInstance('trial', 'prod')).toThrow(/APP_ENV=production/);
  });
});

describe('版本与提交 SHA', () => {
  const keys = ['APP_VERSION', 'APP_COMMIT', 'YUZU_INSTANCE'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const load = (env: AppConfig['env'] = 'test') => loadConfig({ databaseUrl: ctx.config.databaseUrl, env, logLevel: 'silent' });

  it('update.sh 写入的 v 前缀去掉；合法的提交 SHA 保留，其他丢弃', () => {
    process.env.APP_VERSION = 'v0.3.2';
    process.env.APP_COMMIT = 'a'.repeat(40);
    expect(load()).toMatchObject({ version: '0.3.2', commit: 'a'.repeat(40) });
    process.env.APP_VERSION = 'v0.3.2-3-g1234567';
    process.env.APP_COMMIT = 'not-a-sha';
    expect(load()).toMatchObject({ version: '0.3.2-3-g1234567', commit: '' });
  });

  it('设错的 YUZU_INSTANCE 启动即报错；正式环境按设置显示', () => {
    process.env.YUZU_INSTANCE = 'prod';
    expect(() => load('development')).toThrow(/APP_ENV=production/);
    expect(load('production').instance).toBe('prod');
    process.env.YUZU_INSTANCE = 'test';
    expect(load('production').instance).toBe('test');
  });
});

describe('外网正式服在反向代理后面（8.0.0，docs/RELEASE_V800.md）', () => {
  it('TRUST_PROXY 读成地址清单；没设时不信任转发头', () => {
    const saved = process.env.TRUST_PROXY;
    try {
      process.env.TRUST_PROXY = ' 127.0.0.1 , 100.64.0.0/10 ';
      expect(loadConfig({ databaseUrl: ctx.config.databaseUrl, env: 'test', logLevel: 'silent' }).trustProxy).toEqual(['127.0.0.1', '100.64.0.0/10']);
      delete process.env.TRUST_PROXY;
      expect(loadConfig({ databaseUrl: ctx.config.databaseUrl, env: 'test', logLevel: 'silent' }).trustProxy).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = saved;
    }
  });

  it('信任代理时登录记下真实来源 IP、Cookie 加 Secure；不信任时转发头不算', async () => {
    const login = async (config: AppConfig) => {
      const app = await buildApp(ctx.sql, config);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
          payload: { username: 'owner', password: PASSWORD },
        });
        expect(res.statusCode, res.body).toBe(200);
        const [row] = await ctx.sql<{ ip: string | null }[]>`SELECT ip FROM audit_logs WHERE action = 'login' ORDER BY id DESC LIMIT 1`;
        return { ip: row?.ip ?? null, secure: res.cookies.find((c) => c.name === 'yuzu_sid')?.secure ?? false };
      } finally {
        await app.close();
      }
    };
    expect(await login({ ...ctx.config, trustProxy: ['127.0.0.1'], cookieSecure: true })).toEqual({ ip: '203.0.113.9', secure: true });
    expect((await login({ ...ctx.config, trustProxy: [], cookieSecure: false })).ip).not.toBe('203.0.113.9');
  });
});

describe('会员演示数据（seed-demo）', () => {
  it('试用、正式环境一律拒绝，--force 也不能绕过', async () => {
    for (const env of ['trial', 'production'] as const) {
      const label = env === 'trial' ? /试用/ : /正式/;
      await expect(seedDemo(ctx.sql, { ...ctx.config, env })).rejects.toThrow(label);
      await expect(seedDemo(ctx.sql, { ...ctx.config, env }, { force: true })).rejects.toThrow(label);
    }
    const { n } = (await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM members WHERE is_synthetic`)[0]!;
    expect(n).toBe(0);
  });
});

describe('登录页与会话里的实例标识', () => {
  async function publicInfo(config: AppConfig) {
    const app = await buildApp(ctx.sql, config);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/public/info' });
      return res.json() as { instance: string; version: string; commit: string; demoHint: boolean };
    } finally {
      await app.close();
    }
  }

  it('库里有演示数据时，只有开发环境提示演示账号', async () => {
    await seedDemo(ctx.sql, ctx.config, { days: 1 });
    const sha = 'b'.repeat(40);
    expect(await publicInfo({ ...ctx.config, env: 'development', instance: 'demo', commit: sha })).toMatchObject({ instance: 'demo', commit: sha, demoHint: true });
    expect(await publicInfo({ ...ctx.config, env: 'trial', instance: 'trial' })).toMatchObject({ instance: 'trial', demoHint: false });
    expect(await publicInfo({ ...ctx.config, env: 'production', instance: 'test' })).toMatchObject({ instance: 'test', demoHint: false });
  });

  it('会话带上实例标识、版本与提交 SHA', async () => {
    const me = await api(ctx.app, ctx.owner, 'GET', '/api/auth/me');
    expect(me.body).toMatchObject({ instance: ctx.config.instance, version: ctx.config.version, commit: ctx.config.commit });
  });
});
