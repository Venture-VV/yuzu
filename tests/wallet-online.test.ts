// 钱包的线上收款入口（v0.7.26，docs/MEMBERSHIP_FINISH.md 第 2 节；给小程序第二期 MP_RECHARGE.md 第 5 节第 1–3 条）：
//   · 在调用方的事务里入账，与前台充值同一条（流水、赠金批次、升档、套餐赠券）；调用方回滚时一起回滚；
//   · 经办人是系统账号「小程序」：第一次入账时建，不能登录，不出现在员工名单里，不能改；
//   · 渠道 'mp'、不记班次：不进任何收银员的交班；日结、看板单列「线上（小程序）」；
//   · 同一个交易单号只入账一次，再调用返回第一次的充值单；金额或会员对不上拒绝；
//   · 赠金按档自动算；首充 / 续充最低、单笔上限、套餐停用或改价都拒绝；
//   · 到账时会员已停用：照样入账、标出 frozen；来源会员已合并：记到合并进去的那位；
//   · 只读预估不写任何东西；储值退回按最近的先退，线上那一笔标「小程序」、原收款方式微信。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemberRefundPlan } from '../src/shared/member-refunds';
import type { MembershipRules } from '../src/shared/membership';
import type { Deps } from '../src/server/lib/context';
import { consistencyChecks } from '../src/server/ops/consistency';
import { previewOnlineRecharge, rechargeOnline, type OnlineRechargeInput } from '../src/server/modules/wallet-online';
import { api, balanceOf, createMember, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let deps: Deps;
const yuan = (n: number) => n * 100;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  const r = (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
  // 首充 5,000 元起、续充 1,000 元起（与会员体系 v2 的默认一样，续充放低一点好测）
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(5000), topUpMinCents: yuan(1000) })).status).toBe(200);
});
afterAll(async () => ctx.close());

const online = (o: Partial<OnlineRechargeInput> & { memberId: number; paidAmount: number }) =>
  ctx.sql.begin((tx) => rechargeOnline(tx, deps, { planId: null, paymentRef: `WX${randomUUID().replace(/-/g, '').slice(0, 24)}`, orderNo: `MP${Date.now()}`, ...o }));
const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error('应该拒绝');
};

describe('线上收款入账', () => {
  let memberId: number;
  let ref: string;

  it('与前台充值同一条入账：渠道小程序、不记班次、经办人「小程序」、赠金按档自动算、升档', async () => {
    memberId = (await createMember(ctx, '线上会员', '19922220001')).id;
    ref = 'WX4200000001202611040001';
    const r = await online({ memberId, paidAmount: yuan(10000), paymentRef: ref, orderNo: 'MP20261104001' });
    expect(r).toMatchObject({ replayed: false, memberId, mergedFrom: null, frozen: false, grade: { before: 0, after: 2 } });
    // L2 潭影：赠 5%
    expect(r.recharge).toMatchObject({
      paidAmount: yuan(10000),
      bonusAmount: yuan(500),
      paymentMethod: 'wechat',
      paymentRef: ref,
      channel: 'mp',
      operatorName: '小程序',
      note: '小程序充值单 MP20261104001',
    });
    expect(await balanceOf(ctx, memberId)).toEqual({ principal: yuan(10000), bonus: yuan(500) });
    const [row] = await ctx.sql<{ shiftId: number | null; channel: string }[]>`SELECT shift_id, channel FROM recharges WHERE id = ${r.recharge.id}`;
    expect(row).toEqual({ shiftId: null, channel: 'mp' });
    const grade = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/grade`)).body;
    expect(grade.state).toMatchObject({ grade: 2, tier: 0 });
    const [audit] = await ctx.sql<{ action: string }[]>`SELECT action FROM audit_logs WHERE target_type = 'recharge' AND target_id = ${String(r.recharge.id)}`;
    expect(audit).toEqual({ action: 'recharge_online' });
  });

  it('同一个交易单号再到：返回第一次的充值单、不重复入账；金额或会员对不上拒绝', async () => {
    const again = await online({ memberId, paidAmount: yuan(10000), paymentRef: ref });
    expect(again).toMatchObject({ replayed: true, memberId, grade: null });
    expect(await balanceOf(ctx, memberId)).toEqual({ principal: yuan(10000), bonus: yuan(500) });
    expect((await errorOf(online({ memberId, paidAmount: yuan(9000), paymentRef: ref }))).code).toBe('ONLINE_REF_CONFLICT');
    const other = (await createMember(ctx, '别的会员', '19922220002')).id;
    expect((await errorOf(online({ memberId: other, paidAmount: yuan(10000), paymentRef: ref }))).code).toBe('ONLINE_REF_CONFLICT');
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM recharges WHERE payment_ref = ${ref}`;
    expect(n!.n).toBe(1);
  });

  it('调用方的事务回滚时一起回滚（包括第一次建的系统账号以外的一切）', async () => {
    const m = (await createMember(ctx, '回滚会员', '19922220003')).id;
    await expect(
      ctx.sql.begin(async (tx) => {
        await rechargeOnline(tx, deps, { memberId: m, paidAmount: yuan(5000), planId: null, paymentRef: 'WX-ROLLBACK-1', orderNo: 'MP-RB-1' });
        throw new Error('小程序线的充值单记「已到账」失败');
      }),
    ).rejects.toThrow('已到账');
    expect(await balanceOf(ctx, m)).toEqual({ principal: 0, bonus: 0 });
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM recharges WHERE payment_ref = 'WX-ROLLBACK-1'`;
    expect(n!.n).toBe(0);
  });

  it('系统账号「小程序」：不能登录、员工名单里没有、不能改、不能重置密码', async () => {
    const [s] = await ctx.sql<{ id: number; active: boolean; system: boolean; role: string }[]>`SELECT id, active, system, role FROM staff WHERE username = 'system.mp'`;
    expect(s).toMatchObject({ active: false, system: true, role: 'clerk' });
    const login = await api(ctx.app, '', 'POST', '/api/auth/login', { username: 'system.mp', password: PASSWORD });
    expect(login.status).toBe(401);
    const list = (await api(ctx.app, ctx.owner, 'GET', '/api/staff')).body as { username: string }[];
    expect(list.map((x) => x.username)).not.toContain('system.mp');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${s!.id}`, { displayName: '改名', role: 'owner', duties: [], active: true })).status).toBe(404);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/staff/${s!.id}/reset-password`)).status).toBe(404);
  });

  it('不进任何收银员的交班；日结与看板单列「线上（小程序）」；自检照常全过', async () => {
    const shift = await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 20000 });
    expect(shift.status, JSON.stringify(shift.body)).toBe(200);
    const counter = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(memberId, yuan(1000), yuan(50), { paymentMethod: 'cash', bonusMode: 'auto' }));
    expect(counter.status, JSON.stringify(counter.body)).toBe(200);
    const extra = await online({ memberId, paidAmount: yuan(2000) });
    const s = (await api(ctx.app, ctx.clerk, 'GET', `/api/shifts/${shift.body.id}`)).body;
    expect(s.summary.recharges).toMatchObject({ count: 1, paid: yuan(1000) });

    const date = extra.recharge.businessDate;
    const settle = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body;
    expect(settle.recharge.online).toEqual({ count: 2, paid: yuan(12000), bonus: yuan(500) + extra.recharge.bonusAmount });
    expect(settle.recharge.byMethod).toEqual(
      expect.arrayContaining([
        { method: 'cash', count: 1, amount: yuan(1000) },
        { method: 'wechat', count: 2, amount: yuan(12000) },
      ]),
    );
    expect(settle.checks.every((c: { ok: boolean }) => c.ok), JSON.stringify(settle.checks.filter((c: { ok: boolean }) => !c.ok))).toBe(true);
    // 按经办人：线上的记在「小程序」名下
    expect(settle.byStaff.find((x: { name: string }) => x.name === '小程序')).toMatchObject({ rechargeCount: 2, rechargePaid: yuan(12000) });
    const csv = await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}/export`);
    expect(csv.body).toContain('其中线上（小程序）');
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/dashboard')).body.todayStats).toMatchObject({ rechargeOnline: yuan(12000), rechargeOnlineCount: 2 });
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((c) => !c.ok)).toEqual([]);
  });

  it('首充 / 续充最低、单笔上限照旧（线上没有当场授权）', async () => {
    const m = (await createMember(ctx, '线上首充', '19922220004')).id;
    const low = await errorOf(online({ memberId: m, paidAmount: yuan(1000) }));
    expect(low.code).toBe('RECHARGE_BELOW_MIN');
    await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { maxRechargeCents: yuan(8000) });
    try {
      expect((await errorOf(online({ memberId: m, paidAmount: yuan(9000) }))).code).toBe('RECHARGE_OVER_LIMIT');
    } finally {
      await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { maxRechargeCents: 50_000_000 });
    }
    expect(await balanceOf(ctx, m)).toEqual({ principal: 0, bonus: 0 });
  });

  it('套餐：金额与启用照前台核对，套餐上挂的券照发', async () => {
    const plan = await api(ctx.app, ctx.owner, 'POST', '/api/plans', { name: '线上六千', payAmount: yuan(6000), bonusAmount: 0 });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const [p] = await ctx.sql<{ id: number }[]>`SELECT id FROM recharge_plans WHERE name = '线上六千'`;
    const tpl = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '线上礼券', kind: 'cash', faceValue: 2000, validity: 'days', validDays: 30 });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/coupons/rules', { clientKey: randomUUID(), kind: 'recharge', planId: p!.id, templateId: tpl.body.id, quantity: 2 })).status).toBe(200);
    const m = (await createMember(ctx, '线上套餐', '19922220005')).id;
    expect((await errorOf(online({ memberId: m, paidAmount: yuan(5000), planId: p!.id }))).code).toBe('PLAN_CHANGED');
    const r = await online({ memberId: m, paidAmount: yuan(6000), planId: p!.id });
    expect(r.recharge).toMatchObject({ planName: '线上六千', channel: 'mp' });
    const coupons = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${m}/coupons`)).body.coupons as { templateName: string; issueKind: string }[];
    expect(coupons.filter((c) => c.issueKind === 'recharge').map((c) => c.templateName)).toEqual(['线上礼券', '线上礼券']);
    await ctx.sql`UPDATE recharge_plans SET active = false WHERE id = ${p!.id}`;
    expect((await errorOf(online({ memberId: m, paidAmount: yuan(6000), planId: p!.id }))).code).toBe('PLAN_UNAVAILABLE');
  });

  it('到账时已停用：钱已经付了，照样入账、标出 frozen；来源会员已合并：记到合并进去的那位', async () => {
    const frozen = (await createMember(ctx, '线上停用', '19922220006')).id;
    await ctx.sql`UPDATE members SET status = 'frozen' WHERE id = ${frozen}`;
    const f = await online({ memberId: frozen, paidAmount: yuan(5000) });
    expect(f).toMatchObject({ frozen: true, memberId: frozen, mergedFrom: null });
    expect(await balanceOf(ctx, frozen)).toEqual({ principal: yuan(5000), bonus: 0 });

    // 合并的流程在会员合并里测；这里只模拟「来源会员已并进目标会员」的结果
    const source = (await createMember(ctx, '线上来源', '19922220007')).id;
    const target = (await createMember(ctx, '线上目标', '19922220008')).id;
    await ctx.sql`UPDATE members SET status = 'frozen', merged_into_id = ${target} WHERE id = ${source}`;
    const g = await online({ memberId: source, paidAmount: yuan(5000), paymentRef: 'WX-MERGED-1' });
    expect(g).toMatchObject({ frozen: false, memberId: target, mergedFrom: source });
    expect(await balanceOf(ctx, source)).toEqual({ principal: 0, bonus: 0 });
    expect(await balanceOf(ctx, target)).toEqual({ principal: yuan(5000), bonus: 0 });
    // 同一个交易单号按来源会员再到：认得出是同一笔
    expect(await online({ memberId: source, paidAmount: yuan(5000), paymentRef: 'WX-MERGED-1' })).toMatchObject({ replayed: true, memberId: target, mergedFrom: source });
  });

  it('只读预估：赠金与档阶按此刻的规则，不写任何东西', async () => {
    const m = (await createMember(ctx, '线上预估', '19922220009')).id;
    const [before] = await ctx.sql<{ n: number }[]>`SELECT (SELECT count(*) FROM member_grade_events) + (SELECT count(*) FROM recharges) AS n`;
    const p = await previewOnlineRecharge(ctx.sql, deps, m, yuan(30000));
    expect(p).toMatchObject({ bonus: yuan(2400), gradeBefore: 0, gradeAfter: 3, upgraded: true, label: 'L3 观澜 · 初', first: true, minimum: yuan(5000), frozen: false, mergedInto: null });
    const [after] = await ctx.sql<{ n: number }[]>`SELECT (SELECT count(*) FROM member_grade_events) + (SELECT count(*) FROM recharges) AS n`;
    expect(after!.n).toBe(before!.n);
  });

  it('储值退回：线上那一笔标「小程序」、原收款方式微信，按最近的先退', async () => {
    const plan = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/refund-plan`)).body as MemberRefundPlan;
    const mp = plan.sources.filter((s) => s.channel === 'mp');
    expect(mp.length).toBeGreaterThanOrEqual(2);
    expect(mp.every((s) => s.method === 'wechat')).toBe(true);
    // 最近的一笔是线上的 ¥2,000（在前台 ¥1,000 之后到账）
    expect(plan.lines[0]).toMatchObject({ channel: 'mp', method: 'wechat', amount: yuan(2000) });
  });
});
