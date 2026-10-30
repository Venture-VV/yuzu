import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app';
import { loadConfig, type AppConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { createStaff } from '../src/server/modules/staff';
import { demoSeedWindow } from '../src/server/ops/demo-time';

export const TEST_DB =
  process.env.TEST_DATABASE_URL ?? 'postgres://yuzu:yuzu_dev_only@127.0.0.1:5432/yuzu_test';
export const PASSWORD = 'test-pass-2026';

export interface TestContext {
  app: FastifyInstance;
  sql: Sql;
  config: AppConfig;
  owner: string;
  clerk: string;
  ownerId: number;
  clerkId: number;
  close: () => Promise<void>;
}

/** 清空测试库、执行迁移、建好店主与店员，返回已登录的 cookie。 */
export async function setup(): Promise<TestContext> {
  process.env.APP_ENV = 'test';
  const config = loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent' });
  const sql = createSql(TEST_DB, { max: 20 });
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql);
  // 「收款前必须先开班」（R1.2）默认开启；之前的用例按开班可选的口径编写，这里关闭，
  // 开启时的行为由 tests/r1-funds.test.ts 单独验证（openShiftRequired(ctx) 重新开启）
  await sql`INSERT INTO settings (key, value) VALUES ('require_open_shift', 'false'::jsonb)`;
  const ownerId = await createStaff(sql, { username: 'owner', displayName: '测试店主', role: 'owner', password: PASSWORD, mustChangePassword: false });
  const clerkId = await createStaff(sql, { username: 'clerk', displayName: '测试店员', role: 'clerk', password: PASSWORD, mustChangePassword: false });
  const app = await buildApp(sql, config);
  const owner = await login(app, 'owner');
  const clerk = await login(app, 'clerk');
  return {
    app,
    sql,
    config,
    owner,
    clerk,
    ownerId,
    clerkId,
    close: async () => {
      await app.close();
      await sql.end({ timeout: 5 });
    },
  };
}

export async function login(app: FastifyInstance, username: string, password = PASSWORD): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`登录失败 ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'yuzu_sid');
  return `yuzu_sid=${cookie!.value}`;
}

export async function api<T = any>(
  app: FastifyInstance,
  cookie: string | null,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const body = res.headers['content-type']?.toString().includes('json') ? res.json() : res.body;
  return { status: res.statusCode, body: body as T };
}

export async function createMember(ctx: TestContext, name = '测试会员', phone?: string) {
  const res = await api(ctx.app, ctx.clerk, 'POST', '/api/members', {
    name,
    phone: phone ?? `1990000${String(Math.floor(Math.random() * 9000) + 1000)}`,
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: number; principalBalance: number; bonusBalance: number };
}

export function rechargeBody(memberId: number, paid: number, bonus = 0, extra: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    memberId,
    planId: null,
    paidAmount: paid,
    bonusAmount: bonus,
    paymentMethod: 'wechat',
    paymentConfirmed: true,
    ...extra,
  };
}

/** 默认假设会员只有本金（扣款构成 = 全部扣本金）；有赠金的场景通过 extra.expectedSplit 指定 */
export function consumeBody(memberId: number, amount: number, extra: Record<string, unknown> = {}) {
  return {
    idempotencyKey: randomUUID(),
    memberId,
    customLines: [{ name: '测试消费', amount }],
    expectedTotal: amount,
    expectedSplit: { principal: amount, bonus: 0 },
    ...extra,
  };
}

export async function balanceOf(ctx: TestContext, memberId: number) {
  const res = await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}`);
  return { principal: res.body.principalBalance as number, bonus: res.body.bonusBalance as number };
}

export async function setRule(ctx: TestContext, deductionRule: string) {
  const current = await api(ctx.app, ctx.owner, 'GET', '/api/settings');
  const res = await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { ...current.body, deductionRule });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
}

/**
 * 灌演示数据（前台、结账）用的时刻：演示里收银员的班次在灌数据前 5 小时开班，结账在 1 小时之内。
 * 在营业日切换（06:00，上海时间）之后 5 个半小时内灌数据时，班次会落在结账单的前一个营业日，按营业日核对的用例对不上；
 * 这段时间把灌数据的时刻挪到 05:30，演示数据整体落在前一个营业日、彼此一致。
 */
export function demoSeedTime(now = new Date()): Date {
  // 与命令行 --previous-day 同一规则（src/server/ops/demo-time.ts）
  return demoSeedWindow(now, 'Asia/Shanghai', 6)?.anchor ?? now;
}
