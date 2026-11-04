import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app';
import { loadConfig, type AppConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { createStaff } from '../src/server/modules/staff';
import { demoSeedWindow } from '../src/server/ops/demo-time';

import { recreateFromTemplate, testDbUrl } from './test-db';

/** 测试库：并行跑时每个进程一个库（见 tests/test-db.ts、vitest.config.ts） */
export const TEST_DB = testDbUrl();
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
  // 并行时从迁移好的模板库整库复制一份新的；不并行时照旧清空、迁移（见 tests/test-db.ts）
  const fresh = await recreateFromTemplate();
  const sql = createSql(TEST_DB, { max: 20 });
  if (!fresh) await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql);
  // 「收款前必须先开班」（R1.2）默认开启；之前的用例按开班可选的口径编写，这里关闭，
  // 开启时的行为由 tests/r1-funds.test.ts 单独验证（openShiftRequired(ctx) 重新开启）
  await sql`INSERT INTO settings (key, value) VALUES ('require_open_shift', 'false'::jsonb)`;
  // 会员体系 v2（v0.7.23）的首充 / 续充最低默认 5,000 元；之前的用例按小额充值编写，这里设成不限，
  // 最低充值的行为由 tests/membership.test.ts 单独验证（那里按需改回）
  await sql`INSERT INTO settings (key, value) VALUES ('membership_rules', ${sql.json({ firstRechargeMinCents: 0, topUpMinCents: 0 })})`;
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

/**
 * 全部迁移（按号排好；v0.7.25 起只维护这一处）：两条开发线各加迁移时只在这里加一行，升级用例用 migrationsFrom 取
 * 「从某个迁移起应该应用哪些」，不再各写一份。tests/migrations-list.test.ts 核对这份清单与 src/server/migrations 一致、编号不撞。
 */
export const ALL_MIGRATIONS: readonly string[] = [
  '001_init.sql',
  '002_inventory.sql',
  '003_purchasing.sql',
  '004_frontdesk.sql',
  '005_frontdesk_g2.sql',
  '006_op_fences.sql',
  '007_manager_roles.sql',
  '008_locker_pool.sql',
  '009_price_tiers.sql',
  '010_wallet_limits.sql',
  '011_member_fields.sql',
  '012_bonus_expiry.sql',
  '013_opening_balances.sql',
  '014_checkout.sql',
  '015_shifts.sql',
  '016_shift_boundary.sql',
  '017_r1_funds.sql',
  '018_backfill.sql',
  '019_admin_members.sql',
  '020_technicians.sql',
  '021_clockroom.sql',
  '022_dining.sql',
  '023_dining_tables.sql',
  '024_rooms.sql',
  '025_cashier.sql',
  '026_expenses.sql',
  '027_requisitions.sql',
  '028_legacy_ledger.sql',
  '029_warehouses.sql',
  '030_supplier_settlement.sql',
  '031_stock_cycles.sql',
  '032_spaces.sql',
  '033_floorplans.sql',
  '034_floormap.sql',
  '035_locations.sql',
  '036_floorplan_finish.sql',
  '037_refunds_coupons.sql',
  '038_devices.sql',
  '039_payment_fences.sql',
  '040_membership_v2.sql',
  '041_benefits.sql',
  '042_member_discounts_trials.sql',
  '043_miniprogram.sql',
  '044_miniprogram_fences.sql',
  '045_ticket_extension.sql',
  '047_membership_finish.sql',
];

/** 从 first（含）起到最后一个迁移：升级用例从某个版本的库升级时应该应用的迁移 */
export function migrationsFrom(first: string): string[] {
  const i = ALL_MIGRATIONS.indexOf(first);
  if (i < 0) throw new Error(`迁移清单里没有 ${first}`);
  return ALL_MIGRATIONS.slice(i);
}
