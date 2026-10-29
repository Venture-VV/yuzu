// Batch 2.4c：赠金有效期（店主 2026-10-27 #2）。
//   · 套餐设赠金有效期（天），不设为长期有效；自定义赠金按经营规则的默认有效期；
//   · 赠金按批次记账：消费先用最早到期的批次，撤销回到原批次；到期未用完的赠金作废，记一张过期单和一条只减赠金的流水；
//   · 会员余额 = 流水之和，赠金余额 = 批次剩余之和，日结逐项核对。
// 用 ctx.at 指定业务发生时间来模拟「过了 N 天」。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bonusExpiryAt, businessDateOf, businessDayStart } from '../src/shared/business-date';
import { shiftDate } from '../src/shared/labels';
import type { Actor } from '../src/server/lib/context';
import { expireMemberBonus, restoreToLots, sweepExpiredBonus } from '../src/server/modules/bonus';
import { consume, recharge, reverse, type ConsumeInputData, type RechargeInputData } from '../src/server/modules/wallet';
import { api, balanceOf, createMember, setRule, setup, type TestContext } from './helpers';

const DAY = 86_400_000;
const TZ = 'Asia/Shanghai';
let ctx: TestContext;
let owner: Actor;
let clerk: Actor;
let deps: { sql: TestContext['sql']; config: TestContext['config'] };
let plan30: number;
let today: string;

const at = (days: number, base = Date.now()) => new Date(base + days * DAY);
const planRecharge = (memberId: number, planId: number, pay: number, bonus: number, extra: Partial<RechargeInputData> = {}): RechargeInputData => ({
  idempotencyKey: randomUUID(),
  memberId,
  planId,
  paidAmount: pay,
  bonusAmount: bonus,
  paymentMethod: 'cash',
  paymentConfirmed: true,
  ...extra,
});
const customRecharge = (memberId: number, pay: number, bonus: number): RechargeInputData => ({
  idempotencyKey: randomUUID(),
  memberId,
  planId: null,
  paidAmount: pay,
  bonusAmount: bonus,
  paymentMethod: 'cash',
  paymentConfirmed: true,
});
const spend = (memberId: number, amount: number, extra: Partial<ConsumeInputData> = {}): ConsumeInputData => ({
  idempotencyKey: randomUUID(),
  memberId,
  customLines: [{ name: '测试消费', amount }],
  expectedTotal: amount,
  ...extra,
});
const lotsOf = (memberId: number) =>
  ctx.sql<{ source: string; amount: number; remaining: number; expiresAt: string | null }[]>`
    SELECT source, amount, remaining, expires_at FROM bonus_lots WHERE member_id = ${memberId} ORDER BY id`;
const checksOf = async (date: string) => (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body.checks as { key: string; ok: boolean; label: string }[];
const allChecksOk = async (date: string) => {
  for (const c of await checksOf(date)) expect(c.ok, c.label).toBe(true);
};

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  owner = { id: ctx.ownerId, username: 'owner', displayName: '测试店主', role: 'owner', duties: [], mustChangePassword: false };
  clerk = { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false };
  const created = await api(ctx.app, ctx.owner, 'POST', '/api/plans', { name: '三十天赠金', payAmount: 50000, bonusAmount: 5000, bonusValidDays: 30 });
  expect(created.status).toBe(200);
  plan30 = created.body.plans.find((p: { name: string }) => p.name === '三十天赠金').id;
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  // 先扣赠金，便于观察批次的使用顺序
  await setRule(ctx, 'bonus_first');
});
afterAll(async () => ctx.close());

describe('有效期的设置与计算', () => {
  it('套餐有效期 30 天：从充值的营业日算起 30 个营业日可用，第 31 天营业日开始时作废', async () => {
    const m = await createMember(ctx, '三十天', '19900007001');
    const catalog = (await api(ctx.app, ctx.clerk, 'GET', '/api/catalog')).body;
    expect(catalog.plans.find((p: { id: number }) => p.id === plan30)).toMatchObject({ bonusValidDays: 30 });
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', planRecharge(m.id, plan30, 50000, 5000, { bonusValidDays: 30 }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const expected = businessDayStart(shiftDate(today, 30), TZ, 6);
    expect(new Date(r.body.recharge.bonusExpiresAt).getTime()).toBe(expected.getTime());
    expect(await lotsOf(m.id)).toEqual([{ source: 'recharge', amount: 5000, remaining: 5000, expiresAt: expected.toISOString() }]);
    const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body;
    expect(detail.bonusLots).toEqual([{ remaining: 5000, expiresAt: expected.toISOString() }]);
  });

  it('员工确认时看到的有效期与当前不一致时拒绝；不带有效期的旧请求不核对', async () => {
    const m = await createMember(ctx, '有效期变动', '19900007002');
    const stale = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', planRecharge(m.id, plan30, 50000, 5000, { bonusValidDays: null }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'PLAN_CHANGED', details: { bonusValidDays: 30 } });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', planRecharge(m.id, plan30, 50000, 5000))).status).toBe(200);
  });

  it('自定义赠金按经营规则的默认有效期；默认长期有效；无赠金的充值不建批次', async () => {
    const m = await createMember(ctx, '自定义赠金', '19900007003');
    await recharge(deps, customRecharge(m.id, 10000, 1000), { actor: owner });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { customBonusValidDays: 7 })).status).toBe(200);
    try {
      const r = await recharge(deps, customRecharge(m.id, 10000, 2000), { actor: owner });
      if (r.type !== 'recharge') throw new Error('unexpected');
      expect(new Date(r.recharge.bonusExpiresAt!).getTime()).toBe(businessDayStart(shiftDate(today, 7), TZ, 6).getTime());
      await recharge(deps, customRecharge(m.id, 10000, 0), { actor: owner });
    } finally {
      await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { customBonusValidDays: null });
    }
    expect((await lotsOf(m.id)).map((l) => [l.amount, l.expiresAt === null])).toEqual([
      [1000, true],
      [2000, false],
    ]);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { customBonusValidDays: 0 })).status).toBe(400);
  });

  it('套餐有效期可改为长期有效；编辑套餐不带有效期时保持原值', async () => {
    const created = await api(ctx.app, ctx.owner, 'POST', '/api/plans', { name: '临时套餐', payAmount: 30000, bonusAmount: 1000, bonusValidDays: 90 });
    const plan = created.body.plans.find((p: { name: string }) => p.name === '临时套餐');
    const kept = await api(ctx.app, ctx.owner, 'PUT', `/api/plans/${plan.id}`, { name: '临时套餐', payAmount: 30000, bonusAmount: 1000 });
    expect(kept.body.plans.find((p: { id: number }) => p.id === plan.id).bonusValidDays).toBe(90);
    const cleared = await api(ctx.app, ctx.owner, 'PUT', `/api/plans/${plan.id}`, { name: '临时套餐', payAmount: 30000, bonusAmount: 1000, bonusValidDays: null });
    expect(cleared.body.plans.find((p: { id: number }) => p.id === plan.id).bonusValidDays).toBeNull();
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/plans/${plan.id}`, { name: '临时套餐', payAmount: 30000, bonusAmount: 1000, bonusValidDays: 0 })).status).toBe(400);
  });

  it('营业日口径：凌晨 2 点仍属前一营业日，有效 1 天的赠金当天营业日结束（次日 06:00）作废', () => {
    const early = new Date('2026-10-29T02:00:00+08:00');
    expect(businessDateOf(early, TZ, 6)).toBe('2026-10-28');
    expect(bonusExpiryAt(early, 1, TZ, 6).toISOString()).toBe('2026-10-28T22:00:00.000Z');
  });
});

describe('先用最早到期的批次；到期作废', () => {
  it('三个批次（10 天、长期、3 天）：消费 120 先扣 3 天的 50、再扣 10 天的 70，长期的最后用', async () => {
    const m = await createMember(ctx, '先到期先用', '19900007101');
    const base = Date.now() - 2 * DAY;
    const set = (days: number | null) => api(ctx.app, ctx.owner, 'PUT', '/api/settings', { customBonusValidDays: days });
    await set(10);
    await recharge(deps, customRecharge(m.id, 100, 100), { actor: owner, at: at(0, base) });
    await set(null);
    await recharge(deps, customRecharge(m.id, 100, 200), { actor: owner, at: at(0, base) });
    await set(3);
    await recharge(deps, customRecharge(m.id, 100, 50), { actor: owner, at: at(0, base) });
    await set(null);
    // 先赠金后本金：消费 120 全部扣赠金
    const c = await consume(deps, spend(m.id, 120, { expectedSplit: { principal: 0, bonus: 120 } }), { actor: clerk, at: at(1, base) });
    if (c.type !== 'consume') throw new Error('unexpected');
    expect((await lotsOf(m.id)).map((l) => [l.amount, l.remaining])).toEqual([
      [100, 30],
      [200, 200],
      [50, 0],
    ]);
    // 第 10 天之后：10 天批次剩下的 30 作废；长期批次不受影响
    const later = at(11, base);
    expect(await expireMemberBonus(deps, m.id, later)).toBe(true);
    expect(await expireMemberBonus(deps, m.id, later)).toBe(false);
    expect((await lotsOf(m.id)).map((l) => l.remaining)).toEqual([0, 200, 0]);
    const [entry] = await ctx.sql<{ entryType: string; principalDelta: number; bonusDelta: number; operatorId: number | null; docNo: string }[]>`
      SELECT entry_type, principal_delta, bonus_delta, operator_id, doc_no FROM ledger_entries WHERE member_id = ${m.id} AND entry_type = 'expire'`;
    expect(entry).toMatchObject({ entryType: 'expire', principalDelta: 0, bonusDelta: -30, operatorId: null });
    expect(entry!.docNo).toMatch(/^GQ\d{8}-\d{4}$/);
    expect((await balanceOf(ctx, m.id)).bonus).toBe(200);
    // 流水里显示为「赠金过期」，经办为系统
    const rows = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${m.id}/activity`)).body as { entryType: string; operatorName: string; summary: string }[];
    expect(rows[0]).toMatchObject({ entryType: 'expire', operatorName: '系统', summary: '赠金到期作废' });
    // 过期那天的日结：赠金过期 30，单据与流水一致
    const date = businessDateOf(later, TZ, 6);
    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body;
    expect(st.expiry).toEqual({ count: 1, bonus: 30 });
    await allChecksOk(date);
  });

  it('到期作废在记账前先处理：员工按含到期赠金的余额确认时要求重新确认，按新余额确认后入账', async () => {
    const m = await createMember(ctx, '记账前作废', '19900007102');
    const base = Date.now() - 40 * DAY;
    await recharge(deps, planRecharge(m.id, plan30, 50000, 5000), { actor: clerk, at: at(0, base) });
    // 员工看到的还是 50000 + 5000（到期的赠金尚未作废）
    const stale = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', spend(m.id, 1000, {
      expectedBalance: { principal: 50000, bonus: 5000 },
      expectedSplit: { principal: 0, bonus: 1000 },
    }));
    expect(stale.body.error.code).toBe('BALANCE_CHANGED');
    // 记账前的单独事务已把到期赠金作废并提交：刷新后余额只剩本金
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 50000, bonus: 0 });
    const ok = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', spend(m.id, 1000, {
      expectedBalance: { principal: 50000, bonus: 0 },
      expectedSplit: { principal: 1000, bonus: 0 },
    }));
    expect(ok.status).toBe(200);
    await allChecksOk(today);
  });

  it('打开会员详情时作废到期赠金；后台扫描处理其余会员，再扫一次没有新的作废', async () => {
    const base = Date.now() - 31 * DAY;
    const a = await createMember(ctx, '详情触发', '19900007103');
    const b = await createMember(ctx, '扫描触发一', '19900007104');
    const c = await createMember(ctx, '扫描触发二', '19900007105');
    for (const m of [a, b, c]) await recharge(deps, planRecharge(m.id, plan30, 50000, 5000), { actor: clerk, at: at(0, base) });
    const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${a.id}`)).body;
    expect(detail).toMatchObject({ bonusBalance: 0, bonusLots: [] });
    expect(await sweepExpiredBonus(deps)).toBe(2);
    expect(await sweepExpiredBonus(deps)).toBe(0);
    for (const m of [b, c]) expect((await balanceOf(ctx, m.id)).bonus).toBe(0);
    const [expiries] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bonus_expiries WHERE member_id IN ${ctx.sql([a.id, b.id, c.id])}`;
    expect(expiries!.n).toBe(3);
    await allChecksOk(today);
  });

  it('并发：扫描、打开详情与消费同时处理同一位会员，只作废一次，余额与批次一致', async () => {
    const m = await createMember(ctx, '并发作废', '19900007106');
    await recharge(deps, planRecharge(m.id, plan30, 50000, 5000), { actor: clerk, at: at(-35) });
    await Promise.all([
      sweepExpiredBonus(deps),
      api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`),
      api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', spend(m.id, 2000, { expectedSplit: { principal: 2000, bonus: 0 } })),
      expireMemberBonus(deps, m.id),
    ]);
    const [expiries] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bonus_expiries WHERE member_id = ${m.id}`;
    expect(expiries!.n).toBe(1);
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 48000, bonus: 0 });
    await allChecksOk(today);
  });
});

describe('撤销消费时赠金回到原批次', () => {
  it('批次未到期：赠金回到原批次，剩余恢复', async () => {
    const m = await createMember(ctx, '撤销回批次', '19900007201');
    await recharge(deps, planRecharge(m.id, plan30, 50000, 5000), { actor: clerk });
    const c = await consume(deps, spend(m.id, 3000, { expectedSplit: { principal: 0, bonus: 3000 } }), { actor: clerk });
    if (c.type !== 'consume') throw new Error('unexpected');
    expect((await lotsOf(m.id))[0]!.remaining).toBe(2000);
    const r = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${c.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '项目选错' });
    expect(r.status).toBe(200);
    expect(r.body.reversal.expiredBonus).toBeNull();
    expect(r.body.balanceAfter).toEqual({ principal: 50000, bonus: 5000 });
    expect((await lotsOf(m.id))[0]!.remaining).toBe(5000);
    await allChecksOk(today);
  });

  it('批次已到期：撤销恢复的赠金随即作废，回执说明并显示作废后的余额；本金照常恢复', async () => {
    const m = await createMember(ctx, '撤销遇到期', '19900007202');
    const base = Date.now() - 31 * DAY;
    await recharge(deps, planRecharge(m.id, plan30, 50000, 5000), { actor: clerk, at: at(0, base) });
    // 先赠金后本金：消费 6000 = 赠金 5000 + 本金 1000
    const c = await consume(deps, spend(m.id, 6000, { expectedSplit: { principal: 1000, bonus: 5000 } }), { actor: clerk, at: at(1, base) });
    if (c.type !== 'consume') throw new Error('unexpected');
    const r = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${c.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '金额录入错误' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reversal.expiredBonus).toMatchObject({ amount: 5000 });
    expect(r.body.reversal.expiredBonus.docNo).toMatch(/^GQ/);
    expect(r.body.balanceBefore).toEqual({ principal: 49000, bonus: 0 });
    expect(r.body.balanceAfter).toEqual({ principal: 50000, bonus: 0 });
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 50000, bonus: 0 });
    const types = (await ctx.sql<{ entryType: string; bonusDelta: number }[]>`
      SELECT entry_type, bonus_delta FROM ledger_entries WHERE member_id = ${m.id} ORDER BY id`).map((e) => `${e.entryType}:${e.bonusDelta}`);
    expect(types).toEqual(['recharge:5000', 'consume:-5000', 'reversal:5000', 'expire:-5000']);
    const rows = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${m.id}/activity`)).body as { entryType: string; summary: string }[];
    expect(rows[0]).toMatchObject({ entryType: 'expire', summary: '赠金到期作废（撤销恢复时已过期）' });
    await allChecksOk(today);
  });

  it('升级前的消费没有批次记录：恢复为长期有效的批次', async () => {
    const m = await createMember(ctx, '升级前消费', '19900007203');
    await recharge(deps, customRecharge(m.id, 10000, 0), { actor: owner });
    const c = await consume(deps, spend(m.id, 1000, { expectedSplit: { principal: 1000, bonus: 0 } }), { actor: clerk });
    if (c.type !== 'consume') throw new Error('unexpected');
    // 直接调用（在回滚的事务里）：这张消费单没有扣用批次的记录，恢复 800 赠金
    await ctx.sql
      .begin(async (tx) => {
        const [rv] = await tx<{ id: number }[]>`
          INSERT INTO reversals (doc_no, consumption_id, member_id, principal_amount, bonus_amount, reason, business_date, operator_id)
          VALUES ('CX-TEST', ${c.consumption.id}, ${m.id}, 0, 0, '测试', ${today}, ${owner.id}) RETURNING id`;
        await restoreToLots(tx, { memberId: m.id, consumptionId: c.consumption.id, reversalId: rv!.id, amount: 800, at: new Date() });
        const lots = await tx<{ source: string; amount: number; expiresAt: string | null }[]>`SELECT source, amount, expires_at FROM bonus_lots WHERE member_id = ${m.id}`;
        expect(lots).toEqual([{ source: 'restored', amount: 800, expiresAt: null }]);
        throw new Error('rollback');
      })
      .catch((e: Error) => expect(e.message).toBe('rollback'));
  });
});

describe('数据库兜底与日结快照', () => {
  it('批次只能改剩余、不能删除；批次变动与过期单只追加', async () => {
    const m = await createMember(ctx, '兜底', '19900007301');
    await recharge(deps, planRecharge(m.id, plan30, 50000, 5000), { actor: clerk });
    const [lot] = await ctx.sql<{ id: number }[]>`SELECT id FROM bonus_lots WHERE member_id = ${m.id}`;
    await expect(ctx.sql`UPDATE bonus_lots SET amount = 9999 WHERE id = ${lot!.id}`).rejects.toThrow(/只能修改剩余金额/);
    await expect(ctx.sql`UPDATE bonus_lots SET expires_at = NULL WHERE id = ${lot!.id}`).rejects.toThrow(/只能修改剩余金额/);
    await expect(ctx.sql`DELETE FROM bonus_lots WHERE id = ${lot!.id}`).rejects.toThrow(/禁止删除/);
    const [move] = await ctx.sql<{ id: number }[]>`SELECT id FROM bonus_lot_moves LIMIT 1`;
    await expect(ctx.sql`UPDATE bonus_lot_moves SET amount = -1 WHERE id = ${move!.id}`).rejects.toThrow();
    const [exp] = await ctx.sql<{ id: number }[]>`SELECT id FROM bonus_expiries LIMIT 1`;
    await expect(ctx.sql`DELETE FROM bonus_expiries WHERE id = ${exp!.id}`).rejects.toThrow();
    // 「赠金过期」流水必须只减赠金
    await expect(ctx.sql`
      INSERT INTO ledger_entries (member_id, entry_type, expiry_id, doc_no, principal_delta, bonus_delta, principal_after, bonus_after, business_date)
      VALUES (${m.id}, 'expire', ${exp!.id}, 'GQ-X', -1, 0, 0, 0, ${today})`).rejects.toThrow(/ledger_entries_check/);
  });

  it('改了赠金余额却没有对应批次时，自检发现不一致', async () => {
    const m = await createMember(ctx, '篡改赠金', '19900007302');
    await recharge(deps, customRecharge(m.id, 10000, 0), { actor: owner });
    await ctx.sql`UPDATE members SET bonus_balance = bonus_balance + 100 WHERE id = ${m.id}`;
    const check = (await checksOf(today)).find((c) => c.key === 'bonus_lots')!;
    expect(check.ok).toBe(false);
    await ctx.sql`UPDATE members SET bonus_balance = bonus_balance - 100 WHERE id = ${m.id}`;
    expect((await checksOf(today)).find((c) => c.key === 'bonus_lots')!.ok).toBe(true);
  });

  it('升级前确认的日结快照没有「赠金过期」口径：不误报日结后有变动；导出包含赠金过期', async () => {
    const date = shiftDate(today, -100);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/settlements/${date}/close`, { note: '旧快照' })).status).toBe(200);
    await ctx.sql`UPDATE daily_settlements SET snapshot = snapshot - 'expiry' WHERE business_date = ${date}`;
    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body;
    expect(st.closed.changedSinceClose).toBe(false);
    const csv = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}/export`)).body as string;
    expect(csv).toContain('赠金过期');
  });
});
