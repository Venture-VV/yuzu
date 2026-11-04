// 储值退回（v0.7.26，docs/MEMBERSHIP_FINISH.md 第 1 节；PENDING_DECISIONS M69–M74）：
//   · 退本金余额以内；按最近的充值先退、每一行用那一笔的收款方式（期初余额按员工选的方式）；赠金按比例扣回，本金退到 0 时全部扣回；
//   · 店主或店总当场授权（授权绑定会员与本金），店员不能授权；扫码、银行卡要登记退款单号；
//   · 提交时按此刻的余额重新分配，与页面核对的不一致拒绝；同一编号重提返回原来那张，内容不同拒绝；确认作废后原请求不生效；
//   · 现金从所选钱箱退、扣减那个班次的应有现金；日结「储值退回」与单据推算、流水一致；自检照常全过；
//   · 靠充值升上来、扣完够不上这一档的当场降档（连续退回接着降），最多降到靠充值升上来之前的档级；靠上线定档、手动调整等留在这一档的不降。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocateRefund, attributeBalance, refundBonus, type MemberRefundDetail, type MemberRefundPlan } from '../src/shared/member-refunds';
import { createStaff } from '../src/server/modules/staff';
import { consistencyChecks } from '../src/server/ops/consistency';
import { buildDailyRecon } from '../src/server/ops/recon';
import { api, balanceOf, consumeBody, createMember, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '测试店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
});
afterAll(async () => ctx.close());

const recharge = async (memberId: number, paid: number, bonus: number, method = 'wechat') => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(memberId, paid, bonus, { paymentMethod: method, bonusMode: 'custom' }));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.recharge as { id: number; docNo: string };
};
const plan = async (memberId: number, amount?: number) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/refund-plan${amount ? `?amount=${amount}` : ''}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as MemberRefundPlan;
};
const grant = async (memberId: number, amount: number, approver = 'owner') =>
  api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: approver, password: PASSWORD, purpose: 'member_refund', scope: { memberId, amount } });
const body = (p: MemberRefundPlan, grantId: string, extra: Record<string, unknown> = {}) => ({
  clientKey: randomUUID(),
  amount: p.amount,
  expectedBonus: p.bonus,
  lines: p.lines.map((l) => ({ source: l.source, id: l.id, method: l.method ?? 'cash', amount: l.amount, ref: l.method && l.method !== 'cash' ? `REF-${l.id}` : '' })),
  reason: '会员不来了，退卡',
  grantId,
  ...extra,
});
const refund = (memberId: number, payload: unknown, cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', `/api/members/${memberId}/refunds`, payload);

describe('分配与赠金扣回（纯函数）', () => {
  it('剩下的本金算作最近的几笔：最近的先退；赠金按比例四舍五入，退到 0 全部扣回', () => {
    const sources = attributeBalance(
      [
        { source: 'recharge', id: 1, docNo: 'CZ1', date: '2026-11-01', at: '2026-11-01T02:00:00.000Z', method: 'cash', channel: 'counter', amount: 10000, refunded: 0 },
        { source: 'recharge', id: 2, docNo: 'CZ2', date: '2026-11-02', at: '2026-11-02T02:00:00.000Z', method: 'wechat', channel: 'counter', amount: 20000, refunded: 0 },
        { source: 'opening', id: 7, docNo: 'QC1', date: '2026-10-31', at: '2026-10-31T02:00:00.000Z', method: null, channel: null, amount: 3000, refunded: 0 },
      ],
      25000,
    );
    expect(sources.map((s) => [s.docNo, s.remaining])).toEqual([
      ['CZ2', 20000],
      ['CZ1', 5000],
      ['QC1', 0],
    ]);
    expect(allocateRefund(sources, 22000).map((l) => [l.docNo, l.method, l.amount])).toEqual([
      ['CZ2', 'wechat', 20000],
      ['CZ1', 'cash', 2000],
    ]);
    expect(refundBonus(25000, 3000, 15000)).toBe(1800);
    expect(refundBonus(25000, 3000, 25000)).toBe(3000);
    // 3 × 1 / 2 = 1.5 → 2（四舍五入）；大数不丢精度
    expect(refundBonus(2, 3, 1)).toBe(2);
    expect(refundBonus(30_000_000_00, 9_000_000_00, 10_000_000_00)).toBe(3_000_000_00);
  });
});

describe('退储值', () => {
  let memberId: number;
  let cashRecharge: { id: number; docNo: string };
  let wechatRecharge: { id: number; docNo: string };

  it('核对：最近的充值先退、按原收款方式；部分退的赠金按比例；没有授权、授权人不够、没登记单号的拒绝', async () => {
    memberId = (await createMember(ctx, '退储值会员', '19911110001')).id;
    cashRecharge = await recharge(memberId, 10000, 1000, 'cash');
    wechatRecharge = await recharge(memberId, 20000, 2000, 'wechat');
    const spent = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(memberId, 5000));
    expect(spent.status, JSON.stringify(spent.body)).toBe(200);

    const full = await plan(memberId);
    expect(full).toMatchObject({ principalBalance: 25000, bonusBalance: 3000, amount: 25000, bonus: 3000, blocked: null, grade: null });
    expect(full.lines.map((l) => [l.docNo, l.method, l.amount])).toEqual([
      [wechatRecharge.docNo, 'wechat', 20000],
      [cashRecharge.docNo, 'cash', 5000],
    ]);
    const part = await plan(memberId, 15000);
    expect(part).toMatchObject({ amount: 15000, bonus: 1800 });
    expect(part.lines.map((l) => [l.docNo, l.amount])).toEqual([[wechatRecharge.docNo, 15000]]);

    // 店员不能授权；授权的金额与这次的不一致拒绝
    expect((await grant(memberId, 15000, 'clerk')).body.error.code).toBe('AUTH_NOT_ALLOWED');
    const wrong = await grant(memberId, 14000);
    expect(wrong.status).toBe(200);
    const scope = await refund(memberId, body(part, wrong.body.grantId));
    expect(scope.status).toBe(422);
    expect(scope.body.error.code).toBe('GRANT_SCOPE');
    // 微信退的要登记退款单号
    const g = await grant(memberId, 15000);
    const noRef = await refund(memberId, { ...body(part, g.body.grantId), lines: [{ source: 'recharge', id: wechatRecharge.id, method: 'wechat', amount: 15000, ref: '' }] });
    expect(noRef.status).toBe(400);
    expect(noRef.body.error.message).toContain('退款单号');
    // 原收款方式不能改（微信那一笔不能退现金）
    const wrongMethod = await refund(memberId, { ...body(part, g.body.grantId), lines: [{ source: 'recharge', id: wechatRecharge.id, method: 'cash', amount: 15000, ref: '' }] });
    expect(wrongMethod.status).toBe(409);
    expect(wrongMethod.body.error.code).toBe('REFUND_ALLOCATION_CHANGED');
  });

  it('部分退：本金、赠金按比例扣回；流水、赠金批次、授权人都记下；同一编号重提返回原来那张，内容不同拒绝', async () => {
    const part = await plan(memberId, 15000);
    const g = await grant(memberId, 15000, 'boss');
    const payload = body(part, g.body.grantId);
    const done = await refund(memberId, payload);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const r = done.body.refund as MemberRefundDetail;
    expect(r).toMatchObject({ principal: 15000, bonus: 1800, approverName: '测试店总', operatorName: '测试店员', reason: '会员不来了，退卡', grade: null });
    expect(r.refundNo).toMatch(/^TC\d{8}-\d{4}$/);
    expect(r.lines).toEqual([expect.objectContaining({ source: 'recharge', docNo: wechatRecharge.docNo, method: 'wechat', amount: 15000, ref: `REF-${wechatRecharge.id}` })]);
    expect(await balanceOf(ctx, memberId)).toEqual({ principal: 10000, bonus: 1200 });
    const [le] = await ctx.sql<{ entryType: string; principalDelta: number; bonusDelta: number }[]>`
      SELECT entry_type, principal_delta, bonus_delta FROM ledger_entries WHERE member_refund_id = ${r.id}`;
    expect(le).toEqual({ entryType: 'refund', principalDelta: -15000, bonusDelta: -1800 });
    // 赠金先扣微信那一笔自己的批次（2000 → 200），不够才扣别的
    const lots = await ctx.sql<{ rechargeId: number; remaining: number }[]>`SELECT recharge_id, remaining FROM bonus_lots WHERE member_id = ${memberId} ORDER BY id`;
    expect(lots.map((l) => [Number(l.rechargeId), Number(l.remaining)])).toEqual([
      [cashRecharge.id, 1000],
      [wechatRecharge.id, 200],
    ]);

    const again = await refund(memberId, payload);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, refund: { id: r.id } });
    const other = await refund(memberId, { ...payload, reason: '换了一个原因' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 授权用过一次就不能再用
    const reuse = await refund(memberId, { ...body(await plan(memberId, 100), g.body.grantId) });
    expect(reuse.status).toBe(422);
  });

  it('核对之后余额变了：提交时重新分配，与核对时不同就拒绝（不按旧的明细退）', async () => {
    const stale = await plan(memberId);
    expect(stale.lines.map((l) => [l.docNo, l.amount])).toEqual([
      [wechatRecharge.docNo, 5000],
      [cashRecharge.docNo, 5000],
    ]);
    const spent = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(memberId, 1000));
    expect(spent.status).toBe(200);
    const g = await grant(memberId, stale.amount);
    const res = await refund(memberId, body(stale, g.body.grantId));
    expect(res.status).toBe(409);
    expect(['REFUND_EXCEEDS', 'REFUND_ALLOCATION_CHANGED']).toContain(res.body.error.code);
  });

  it('全部退、现金从所选钱箱退：本金、赠金清零；那个班次的应有现金减去退的现金；日结与自检一致', async () => {
    const shift = await api(ctx.app, ctx.owner, 'POST', '/api/shifts', { openingCash: 50000 });
    expect(shift.status, JSON.stringify(shift.body)).toBe(200);
    const full = await plan(memberId);
    expect(full).toMatchObject({ amount: 9000, bonus: 1200 });
    expect(full.lines.map((l) => [l.method, l.amount])).toEqual([
      ['wechat', 5000],
      ['cash', 4000],
    ]);
    const g = await grant(memberId, 9000);
    // 店员从店主的钱箱退现金
    const done = await refund(memberId, body(full, g.body.grantId, { refundShiftId: shift.body.id }));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.refund).toMatchObject({ principal: 9000, bonus: 1200, shiftNo: shift.body.shiftNo, shiftStaffName: '测试店主' });
    expect(await balanceOf(ctx, memberId)).toEqual({ principal: 0, bonus: 0 });

    const s = (await api(ctx.app, ctx.owner, 'GET', `/api/shifts/${shift.body.id}`)).body;
    expect(s.summary.memberRefunds).toMatchObject({ count: 1, total: 9000 });
    expect(s.summary.memberRefunds.list[0]).toMatchObject({ amount: 9000, cash: 4000, memberName: '退储值会员', operatorName: '测试店员' });
    expect(s.summary.cash).toMatchObject({ opening: 50000, memberRefund: 4000, expected: 46000 });

    const date = done.body.refund.businessDate as string;
    const settle = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body;
    expect(settle.memberRefund).toMatchObject({ count: 2, principal: 24000, bonus: 3000 });
    expect(settle.checks.every((c: { ok: boolean }) => c.ok), JSON.stringify(settle.checks.filter((c: { ok: boolean }) => !c.ok))).toBe(true);
    expect(settle.anomalies.filter((a: { kind: string }) => a.kind === 'member_refund')).toHaveLength(2);

    // 对账包：11-储值退回.csv 每一行一笔原收款（第一行带本单合计与经办人），说明里写净充值
    const pack = await buildDailyRecon(ctx.sql, ctx.config, date);
    expect(pack.ok).toBe(true);
    const list = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/refunds`)).body as MemberRefundDetail[];
    const csv = pack.files.find((f) => f.name === '11-储值退回.csv')!.content.trim().split('\n');
    expect(csv).toHaveLength(1 + list.reduce((t, r) => t + r.lines.length, 0));
    expect(csv.find((l) => l.startsWith(done.body.refund.refundNo))).toContain('90.00');
    expect(pack.files[0]!.content).toContain('储值退回 ¥240.00（2 张，扣回赠金 ¥30.00）');
    // 看板、经营总览、会员总览、ERP 营业数据：充值旁边单列储值退回
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/dashboard')).body.todayStats).toMatchObject({ memberRefund: 24000, memberRefundCount: 2 });
    const q = `?from=${date}&to=${date}`;
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/reports/executive${q}`)).body.kpis).toMatchObject({ memberRefund: 24000, memberRefundCount: 2 });
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/reports/members${q}`)).body.period).toMatchObject({ memberRefund: 24000, memberRefundCount: 2 });
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/revenue${q}`)).body.kpis).toMatchObject({ memberRefund: 24000 });

    // 没有本金了：不能再退
    expect((await plan(memberId)).blocked).toContain('没有本金余额');
    const checks = await consistencyChecks(ctx.sql, ctx.config.timezone);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.filter((c) => c.label.startsWith('储值退回'))).toHaveLength(2);
  });

  it('结果待确认：确认作废以后，原请求再到也不生效', async () => {
    const m = (await createMember(ctx, '作废退储值', '19911110002')).id;
    await recharge(m, 8000, 0, 'cash');
    const p = await plan(m);
    const g = await grant(m, p.amount);
    const payload = body(p, g.body.grantId);
    const abandon = await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${payload.clientKey}/abandon`, { type: 'member_refund', summary: '退储值 ¥80' });
    expect(abandon.status, JSON.stringify(abandon.body)).toBe(200);
    expect(abandon.body).toMatchObject({ found: false, abandoned: true });
    const late = await refund(m, payload);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    expect(await balanceOf(ctx, m)).toEqual({ principal: 8000, bonus: 0 });
  });
});

describe('对档阶的影响（M73）', () => {
  it('靠这一笔充值升上来的：扣完够不上就当场降档（会籍周期不变）；核对时先写明会降到哪一档', async () => {
    const m = (await createMember(ctx, '充值升档又退', '19911110003')).id;
    // 1 万元：升到 L2（初阶），赠金按档 5%
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m, 1_000_000, 50_000, { paymentMethod: 'bank_card', bonusMode: 'auto' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const before = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${m}/grade`)).body;
    expect(before.state).toMatchObject({ grade: 2, tier: 0 });
    const p = await plan(m, 600_000);
    expect(p.grade).not.toBeNull();
    expect(p.grade!.to).toContain('L0');
    const g = await grant(m, 600_000);
    const done = await refund(m, body(p, g.body.grantId));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.refund.grade).toEqual(p.grade);
    const after = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${m}/grade`)).body;
    expect(after.state).toMatchObject({ grade: 0, tier: null });
    const [e] = await ctx.sql<{ kind: string; memberRefundId: number }[]>`
      SELECT kind, member_refund_id FROM member_grade_events WHERE member_id = ${m} ORDER BY id DESC LIMIT 1`;
    expect(e).toEqual({ kind: 'refund_down', memberRefundId: done.body.refund.id });
    // 滚动累计按「充值 − 退回」算
    expect(after.rollingRechargeCents).toBe(400_000);
  });

  it('连续退回：L3 退一部分降到 L2，再退清降到 L0（核对时也写明）——测试会话 c938e79 的 P2', async () => {
    const m = (await createMember(ctx, '连续退回', '19911110005')).id;
    // 3 万元：升到 L3（初阶），赠金按档 8%
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m, 3_000_000, 240_000, { paymentMethod: 'wechat', bonusMode: 'auto' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/members/${m}/grade`)).body.state).toMatchObject({ grade: 3, tier: 0 });
    const first = await plan(m, 2_000_000);
    expect(first.grade!.to).toContain('L2');
    expect((await refund(m, body(first, (await grant(m, 2_000_000)).body.grantId))).status).toBe(200);
    const mid = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${m}/grade`)).body;
    expect(mid.state).toMatchObject({ grade: 2, tier: 0 });
    // 第二次退清：剩下的 L2 仍是那次充值升上来的，滚动累计 0 → L0
    const second = await plan(m);
    expect(second.amount).toBe(1_000_000);
    expect(second.grade).not.toBeNull();
    expect(second.grade!.from).toContain('L2');
    expect(second.grade!.to).toContain('L0');
    const done = await refund(m, body(second, (await grant(m, 1_000_000)).body.grantId));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.refund.grade).toEqual(second.grade);
    const after = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${m}/grade`)).body;
    expect(after.state).toMatchObject({ grade: 0, tier: null });
    expect(after.rollingRechargeCents).toBe(0);
    const kinds = await ctx.sql<{ kind: string; fromGrade: number; toGrade: number }[]>`
      SELECT kind, from_grade, to_grade FROM member_grade_events WHERE member_id = ${m} ORDER BY id`;
    expect(kinds).toEqual([
      { kind: 'recharge_up', fromGrade: 0, toGrade: 3 },
      { kind: 'refund_down', fromGrade: 3, toGrade: 2 },
      { kind: 'refund_down', fromGrade: 2, toGrade: 0 },
    ]);
  });

  it('最多降到靠充值升上来之前的档级：手动调到 L2 再充到 L3，退清回到 L2；只靠手动调整的不降', async () => {
    const m = (await createMember(ctx, '先手动再充值', '19911110006')).id;
    const info = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${m}/grade`)).body as { version: number };
    const adj = await api(ctx.app, ctx.owner, 'POST', `/api/members/${m}/grade`, { clientKey: randomUUID(), grade: 2, tier: 0, reason: '老客户补定档', expectedVersion: info.version });
    expect(adj.status, JSON.stringify(adj.body)).toBe(200);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m, 3_000_000, 240_000, { paymentMethod: 'cash', bonusMode: 'auto' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/members/${m}/grade`)).body.state).toMatchObject({ grade: 3 });
    const p = await plan(m);
    expect(p.grade!.to).toContain('L2');
    expect((await refund(m, body(p, (await grant(m, p.amount)).body.grantId))).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/members/${m}/grade`)).body.state).toMatchObject({ grade: 2, tier: 0 });

    // 只靠手动调整的 L4：充一笔不升档的，退清也不降
    const k = (await createMember(ctx, '只手动调整', '19911110007')).id;
    const kinfo = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${k}/grade`)).body as { version: number };
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${k}/grade`, { clientKey: randomUUID(), grade: 4, tier: 0, reason: '老客户补定档', expectedVersion: kinfo.version })).status).toBe(200);
    expect((await recharge(k, 600_000, 0, 'cash')).id).toBeGreaterThan(0);
    const kp = await plan(k);
    expect(kp.grade).toBeNull();
    expect((await refund(k, body(kp, (await grant(k, kp.amount)).body.grantId))).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/members/${k}/grade`)).body.state).toMatchObject({ grade: 4 });
  });

  it('退得少、扣完还够得上的不降', async () => {
    const m = (await createMember(ctx, '退一点不降', '19911110004')).id;
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m, 1_200_000, 60_000, { paymentMethod: 'cash', bonusMode: 'auto' }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = await plan(m, 100_000);
    expect(p.grade).toBeNull();
    const g = await grant(m, 100_000);
    expect((await refund(m, body(p, g.body.grantId))).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/members/${m}/grade`)).body.state).toMatchObject({ grade: 2 });
  });
});
