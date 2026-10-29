// Batch 2.4a：单笔上限 50 万与超限当场授权（店主 2026-10-27 #9、❓4）、撤销时限（#10）、营业时间（#4）。
//   · 充值、消费单笔上限默认 50 万元，可配置；超过上限需店主或店总在当前弹窗输入账号密码当场授权；
//   · 授权绑定申请的员工、会员、业务类型与金额，5 分钟内一次有效，在入账的同一事务里核销；
//   · 撤销时限：超过时限只有店主可以撤销（待确认）；营业时间只用于显示与提醒。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeBusinessHours, isOpenAt } from '../src/shared/business-date';
import type { Actor } from '../src/server/lib/context';
import { createStaff } from '../src/server/modules/staff';
import { consume, recharge, type RechargeInputData } from '../src/server/modules/wallet';
import { api, balanceOf, consumeBody, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

const WAN = 1_000_000; // 1 万元（分）
let ctx: TestContext;
let boss: string;
let duty: string;
let clerk2: string;
let backoffice: string;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'clerk2', displayName: '另一位店员', role: 'clerk', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'back', displayName: '后勤', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  duty = await login(ctx.app, 'duty');
  clerk2 = await login(ctx.app, 'clerk2');
  backoffice = await login(ctx.app, 'back');
});
afterAll(async () => ctx.close());

type Kind = 'recharge' | 'consume';
const authorize = (cookie: string, approver: string, scope: { kind: Kind; memberId: number; amount: number }, password = PASSWORD) =>
  api(ctx.app, cookie, 'POST', '/api/auth/authorize', { username: approver, password, purpose: 'over_limit', scope });
const grantOf = async (cookie: string, scope: { kind: Kind; memberId: number; amount: number }, approver = 'boss') => {
  const r = await authorize(cookie, approver, scope);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.grantId as string;
};
const grantRow = async (id: string) =>
  (await ctx.sql<{ usedAt: string | null; usedRef: string | null }[]>`SELECT used_at, used_ref FROM auth_grants WHERE id = ${id}`)[0]!;

describe('单笔上限默认 50 万元', () => {
  it('新库默认值：充值、消费上限都是 50 万；撤销时限 48 小时（2026-10-29 签认）、全天营业', async () => {
    const s = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body;
    expect(s).toMatchObject({ maxRechargeCents: 50 * WAN, maxConsumeCents: 50 * WAN, reversalWindowHours: 48, businessHours: null });
    const me = (await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body;
    expect(me.rules).toMatchObject({ maxRechargeCents: 50 * WAN, maxConsumeCents: 50 * WAN, reversalWindowHours: 48, businessHours: null });
  });

  it('正好 50 万不需要授权；多 1 分就要授权，没有授权时整笔不入账', async () => {
    const m = await createMember(ctx, '上限会员', '19900005001');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 50 * WAN))).status).toBe(200);
    const over = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 50 * WAN + 1));
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: 'OVER_LIMIT_AUTH_REQUIRED', details: { limit: 50 * WAN, amount: 50 * WAN + 1 } });
    expect(over.body.error.message).toContain('店主或店总当场授权');
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 50 * WAN, bonus: 0 });
    // 消费同理
    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 50 * WAN));
    expect(c.status).toBe(200);
    expect(c.body.consumption.overLimitApproverName).toBeNull();
  });
});

describe('超过上限的当场授权', () => {
  let memberId: number;
  beforeAll(async () => {
    memberId = (await createMember(ctx, '大额会员', '19900005002')).id;
  });

  it('只有店总、店主能授权；值班经理不能；密码错误 403；金额没超上限不签发；后勤不能申请', async () => {
    const scope = { kind: 'recharge' as const, memberId, amount: 60 * WAN };
    const dutyTry = await authorize(ctx.clerk, 'duty', scope);
    expect(dutyTry.status).toBe(403);
    expect(dutyTry.body.error).toMatchObject({ code: 'AUTH_NOT_ALLOWED' });
    expect(dutyTry.body.error.message).toContain('请店总或店主授权');
    expect((await authorize(ctx.clerk, 'boss', scope, 'wrong-pass')).body.error.code).toBe('AUTH_FAILED');
    const small = await authorize(ctx.clerk, 'boss', { ...scope, amount: 50 * WAN });
    expect(small.status).toBe(409);
    expect(small.body.error.code).toBe('GRANT_NOT_NEEDED');
    expect((await authorize(backoffice, 'boss', scope)).status).toBe(403);
    // 店主同样可以授权
    expect((await authorize(ctx.clerk, 'owner', scope)).status).toBe(200);
  });

  it('店总授权后充值 60 万入账，单据与审计记下授权人；同一编号重提不重复入账，也不再核销授权', async () => {
    const before = await balanceOf(ctx, memberId);
    const grantId = await grantOf(ctx.clerk, { kind: 'recharge', memberId, amount: 60 * WAN });
    const body = rechargeBody(memberId, 60 * WAN, 0, { overLimitGrantId: grantId });
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.recharge).toMatchObject({ paidAmount: 60 * WAN, overLimitApproverName: '店总' });
    expect(await balanceOf(ctx, memberId)).toEqual({ principal: before.principal + 60 * WAN, bonus: 0 });
    expect(await grantRow(grantId)).toMatchObject({ usedRef: `recharge:${body.idempotencyKey}` });
    const [audit] = await ctx.sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM audit_logs WHERE action = 'recharge_created' AND target_id = ${String(r.body.recharge.id)}`;
    expect(audit!.detail).toMatchObject({ overLimitApproverName: '店总' });

    const replay = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, recharge: { id: r.body.recharge.id } });
    expect(await balanceOf(ctx, memberId)).toEqual({ principal: before.principal + 60 * WAN, bonus: 0 });
    // 授权只能用一次：换一个编号再用
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', { ...body, idempotencyKey: randomUUID() });
    expect(again.body.error.code).toBe('GRANT_USED');
  });

  it('授权只覆盖申请时的会员、业务类型与金额；只给申请的员工用', async () => {
    const other = await createMember(ctx, '另一位会员', '19900005003');
    const grantId = await grantOf(ctx.clerk, { kind: 'recharge', memberId, amount: 70 * WAN });
    const use = (cookie: string, extra: { memberId?: number; amount?: number }) =>
      api(ctx.app, cookie, 'POST', '/api/recharges', rechargeBody(extra.memberId ?? memberId, extra.amount ?? 70 * WAN, 0, { overLimitGrantId: grantId }));
    expect((await use(ctx.clerk, { amount: 70 * WAN + 100 })).body.error.code).toBe('GRANT_SCOPE');
    expect((await use(ctx.clerk, { memberId: other.id })).body.error.code).toBe('GRANT_SCOPE');
    expect((await use(clerk2, {})).body.error.code).toBe('GRANT_INVALID');
    // 充值的授权不能用来消费（会员余额 60 万，消费 55 万超过上限）
    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(memberId, 55 * WAN, { overLimitGrantId: grantId }));
    expect(c.body.error.code).toBe('GRANT_SCOPE');
    // 以上都没有核销授权，金额一致时仍可使用
    expect((await grantRow(grantId)).usedAt).toBeNull();
    expect((await use(ctx.clerk, {})).status).toBe(200);
  });

  it('过期的授权、其他用途的授权不能用', async () => {
    const [ids] = await ctx.sql<{ clerkId: number; bossId: number }[]>`
      SELECT (SELECT id FROM staff WHERE username = 'clerk') AS clerk_id, (SELECT id FROM staff WHERE username = 'boss') AS boss_id`;
    const { clerkId, bossId } = ids!;
    const scope = { kind: 'recharge', memberId, amount: 80 * WAN };
    const [expired] = await ctx.sql<{ id: string }[]>`
      INSERT INTO auth_grants (purpose, requested_by, approved_by, scope, created_at, expires_at)
      VALUES ('over_limit', ${clerkId}, ${bossId}, ${ctx.sql.json(scope)}, now() - interval '10 minutes', now() - interval '5 minutes')
      RETURNING id`;
    const r1 = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(memberId, 80 * WAN, 0, { overLimitGrantId: expired!.id }));
    expect(r1.body.error.code).toBe('GRANT_EXPIRED');
    const [vip] = await ctx.sql<{ id: string }[]>`
      INSERT INTO auth_grants (purpose, requested_by, approved_by, scope, expires_at)
      VALUES ('vip_tag', ${clerkId}, ${bossId}, ${ctx.sql.json({ tags: [{ code: '9058', memberId }] })}, now() + interval '5 minutes')
      RETURNING id`;
    const r2 = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(memberId, 80 * WAN, 0, { overLimitGrantId: vip!.id }));
    expect(r2.body.error.code).toBe('GRANT_INVALID');
    // 授权人之后被停用或改成不能授权的岗位：授权失效
    const grantId = await grantOf(ctx.clerk, { kind: 'recharge', memberId, amount: 80 * WAN });
    await ctx.sql`UPDATE staff SET role = 'duty_manager' WHERE username = 'boss'`;
    const r3 = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(memberId, 80 * WAN, 0, { overLimitGrantId: grantId }));
    await ctx.sql`UPDATE staff SET role = 'store_manager' WHERE username = 'boss'`;
    expect(r3.body.error.code).toBe('GRANT_INVALID');
  });

  it('大额消费同样需要授权；余额不足或扣款构成变化时整笔回滚，授权没有被用掉', async () => {
    const m = await createMember(ctx, '大额消费会员', '19900005004');
    const g1 = await grantOf(ctx.clerk, { kind: 'recharge', memberId: m.id, amount: 90 * WAN });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 90 * WAN, 0, { overLimitGrantId: g1 }))).status).toBe(200);

    const amount = 95 * WAN; // 超过余额
    const g2 = await grantOf(ctx.clerk, { kind: 'consume', memberId: m.id, amount });
    const short = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, amount, { overLimitGrantId: g2 }));
    expect(short.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await grantRow(g2)).usedAt).toBeNull();

    const ok = 60 * WAN;
    const noGrant = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, ok));
    expect(noGrant.body.error.code).toBe('OVER_LIMIT_AUTH_REQUIRED');
    const g3 = await grantOf(ctx.clerk, { kind: 'consume', memberId: m.id, amount: ok });
    const wrongSplit = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, ok, { overLimitGrantId: g3, expectedSplit: { principal: ok - 1, bonus: 1 } }));
    expect(wrongSplit.body.error.code).toBe('SPLIT_CHANGED');
    expect((await grantRow(g3)).usedAt).toBeNull();
    const done = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, ok, { overLimitGrantId: g3 }));
    expect(done.status).toBe(200);
    expect(done.body.consumption.overLimitApproverName).toBe('店总');
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 30 * WAN, bonus: 0 });
  });

  it('并发：同一个授权同时用于两笔（不同编号），只有一笔入账', async () => {
    const m = await createMember(ctx, '并发授权会员', '19900005005');
    const grantId = await grantOf(ctx.clerk, { kind: 'recharge', memberId: m.id, amount: 55 * WAN });
    const results = await Promise.all(
      [0, 1].map(() => api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 55 * WAN, 0, { overLimitGrantId: grantId }))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(results.find((r) => r.status === 422)!.body.error.code).toBe('GRANT_USED');
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 55 * WAN, bonus: 0 });
  });

  it('上限可调：店主把消费上限改为 1 万后，1 万零 1 分的消费需要授权；不带授权的旧请求不受影响', async () => {
    const m = await createMember(ctx, '调上限会员', '19900005006');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 5 * WAN));
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { maxConsumeCents: WAN })).status).toBe(200);
    try {
      expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, WAN + 1))).body.error.code).toBe('OVER_LIMIT_AUTH_REQUIRED');
      const g = await grantOf(ctx.clerk, { kind: 'consume', memberId: m.id, amount: WAN + 1 });
      expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, WAN + 1, { overLimitGrantId: g }))).status).toBe(200);
      // 不超过上限时带着授权编号也照常入账，授权不被核销
      const g2 = await grantOf(ctx.clerk, { kind: 'consume', memberId: m.id, amount: 2 * WAN });
      expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 100, { overLimitGrantId: g2 }))).status).toBe(200);
      expect((await grantRow(g2)).usedAt).toBeNull();
    } finally {
      await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { maxConsumeCents: 50 * WAN });
    }
  });
});

describe('撤销时限（待确认：超过后只有店主可以撤销）', () => {
  const actorOf = async (username: string): Promise<Actor> => {
    const [s] = await ctx.sql<Actor[]>`SELECT id, username, display_name, role, coalesce(duties, '{}') AS duties, false AS must_change_password FROM staff WHERE username = ${username}`;
    return s!;
  };

  it('默认 48 小时：值班经理不能撤销 30 天前的消费；改为「不限」后可以', async () => {
    const m = await createMember(ctx, '不限时限', '19900005101');
    const deps = { sql: ctx.sql, config: ctx.config };
    const clerk = await actorOf('clerk');
    await recharge(deps, rechargeBody(m.id, 10000) as RechargeInputData, { actor: clerk, at: new Date(Date.now() - 30 * 86_400_000) });
    const old = await consume(deps, consumeBody(m.id, 3000), { actor: clerk, at: new Date(Date.now() - 30 * 86_400_000) });
    if (old.type !== 'consume') throw new Error('unexpected');
    const late = await api(ctx.app, duty, 'POST', `/api/consumptions/${old.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '项目选错' });
    expect(late.body.error).toMatchObject({ code: 'REVERSAL_WINDOW', details: { windowHours: 48 } });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { reversalWindowHours: null })).status).toBe(200);
    try {
      const r = await api(ctx.app, duty, 'POST', `/api/consumptions/${old.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '项目选错' });
      expect(r.status).toBe(200);
    } finally {
      await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { reversalWindowHours: 48 });
    }
  });

  it('设为 24 小时：超过时限值班经理被拒绝，店主可以；时限内照常撤销', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { reversalWindowHours: 24 })).status).toBe(200);
    try {
      expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.rules.reversalWindowHours).toBe(24);
      const m = await createMember(ctx, '撤销时限', '19900005102');
      const deps = { sql: ctx.sql, config: ctx.config };
      const clerk = await actorOf('clerk');
      await recharge(deps, rechargeBody(m.id, 10000) as RechargeInputData, { actor: clerk, at: new Date(Date.now() - 26 * 3_600_000) });
      const old = await consume(deps, consumeBody(m.id, 3000), { actor: clerk, at: new Date(Date.now() - 25 * 3_600_000) });
      const recent = await consume(deps, consumeBody(m.id, 2000), { actor: clerk, at: new Date(Date.now() - 23 * 3_600_000) });
      if (old.type !== 'consume' || recent.type !== 'consume') throw new Error('unexpected');

      const byDuty = await api(ctx.app, duty, 'POST', `/api/consumptions/${old.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '项目选错' });
      expect(byDuty.status).toBe(422);
      expect(byDuty.body.error).toMatchObject({ code: 'REVERSAL_WINDOW', details: { windowHours: 24 } });
      expect(byDuty.body.error.message).toContain('1 天');
      expect((await api(ctx.app, boss, 'POST', `/api/consumptions/${old.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '项目选错' })).status).toBe(422);
      expect((await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${old.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '项目选错' })).status).toBe(200);
      expect((await api(ctx.app, duty, 'POST', `/api/consumptions/${recent.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '金额录入错误' })).status).toBe(200);
      expect(await balanceOf(ctx, m.id)).toEqual({ principal: 10000, bonus: 0 });
    } finally {
      await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { reversalWindowHours: 48 });
    }
  });

  it('设置校验：至少 1 小时、最多 90 天，可设为不限', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { reversalWindowHours: 0 })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { reversalWindowHours: 24 * 90 + 1 })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { reversalWindowHours: 1.5 })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { reversalWindowHours: null })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body.reversalWindowHours).toBeNull();
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { reversalWindowHours: 48 })).status).toBe(200);
  });
});

describe('营业时间（只用于显示与提醒）与按项保存设置', () => {
  it('可设为跨夜营业时间或全天营业；开门与打烊相同、格式不对时拒绝；只提交的项被修改', async () => {
    const before = (await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body;
    const set = await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { businessHours: { open: '10:00', close: '02:00' } });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ ...before, businessHours: { open: '10:00', close: '02:00' } });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.rules.businessHours).toEqual({ open: '10:00', close: '02:00' });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { businessHours: { open: '10:00', close: '10:00' } })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { businessHours: { open: '25:00', close: '02:00' } })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { businessHours: null })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/settings')).body).toEqual(before);
    // 店员不能改规则
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/settings', { businessHours: null })).status).toBe(403);
  });

  it('营业时间判断：跨夜、当天、全天', () => {
    const overnight = { open: '10:00', close: '02:00' };
    expect(isOpenAt(9 * 60 + 59, overnight)).toBe(false);
    expect(isOpenAt(10 * 60, overnight)).toBe(true);
    expect(isOpenAt(23 * 60, overnight)).toBe(true);
    expect(isOpenAt(60, overnight)).toBe(true);
    expect(isOpenAt(2 * 60, overnight)).toBe(false);
    const day = { open: '09:00', close: '22:30' };
    expect(isOpenAt(22 * 60 + 29, day)).toBe(true);
    expect(isOpenAt(22 * 60 + 30, day)).toBe(false);
    expect(isOpenAt(3 * 60, null)).toBe(true);
    expect(describeBusinessHours(overnight)).toBe('10:00–次日 02:00');
    expect(describeBusinessHours(day)).toBe('09:00–22:30');
    expect(describeBusinessHours(null)).toBe('全天 24 小时营业');
  });
});
