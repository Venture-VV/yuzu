// 退储值里线上充值那一行的原路退回（v0.7.27，MP21；docs/MP_RECHARGE.md 第 9 节、docs/MEMBERSHIP_FINISH.md 第 6 节）：
//   · 小程序线没注册原路退回（或注册了但没开、出错）时：页面不给选，接口拒绝「交给门店系统」，与 v0.7.26 一样要填退款单号；
//   · 开着时：来源是线上充值、微信付的那一行可以交给门店系统原路退回（不填退款单号）；填了单号的、不是线上充值的、不是那一行的都拒绝；
//   · 员工已在商户平台退过的照旧填退款单号（员工退）；
//   · 小程序线按行号取「交给门店系统」的行（含微信支付的交易单号）；日结单列「其中退线上充值」，对账包写明；
//   · 员工退的行不带 route 进请求摘要：v0.7.26 的请求原样重提仍是同一笔；自检照常全过。

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MemberRefundDetail, MemberRefundPlan } from '../src/shared/member-refunds';
import type { MembershipRules } from '../src/shared/membership';
import type { Deps } from '../src/server/lib/context';
import { listOnlineRefundLines, registerOnlineRefundRoute } from '../src/server/modules/member-refunds';
import { rechargeOnline } from '../src/server/modules/wallet-online';
import { consistencyChecks } from '../src/server/ops/consistency';
import { buildDailyRecon } from '../src/server/ops/recon';
import { api, createMember, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let deps: Deps;
const yuan = (n: number) => n * 100;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  const r = (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(100), topUpMinCents: yuan(100) })).status).toBe(200);
});
afterEach(() => registerOnlineRefundRoute(null));
afterAll(async () => ctx?.close());

const online = (memberId: number, paidAmount: number, paymentRef: string) =>
  ctx.sql.begin((tx) => rechargeOnline(tx, deps, { memberId, paidAmount, planId: null, paymentRef, orderNo: `MP${paymentRef.slice(-6)}` }));
const counter = async (memberId: number, paid: number, method: string) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(memberId, paid, 0, { paymentMethod: method, bonusMode: 'custom' }));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.recharge as { id: number; docNo: string };
};
const plan = async (memberId: number) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/refund-plan`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as MemberRefundPlan;
};
const grant = async (memberId: number, amount: number) => {
  const g = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: 'owner', password: PASSWORD, purpose: 'member_refund', scope: { memberId, amount } });
  expect(g.status, JSON.stringify(g.body)).toBe(200);
  return g.body.grantId as string;
};
type LineIn = { route?: 'manual' | 'mp_auto'; ref?: string };
const body = (p: MemberRefundPlan, grantId: string, lines: LineIn[], clientKey = randomUUID()) => ({
  clientKey,
  amount: p.amount,
  expectedBonus: p.bonus,
  lines: p.lines.map((l, i) => ({
    source: l.source,
    id: l.id,
    method: l.method ?? 'cash',
    amount: l.amount,
    ref: lines[i]?.ref ?? (l.method && l.method !== 'cash' ? `REF-${l.id}` : ''),
    ...(lines[i]?.route ? { route: lines[i]!.route } : {}),
  })),
  reason: '会员搬家，退卡',
  grantId,
});
const refund = (memberId: number, payload: unknown) => api(ctx.app, ctx.clerk, 'POST', `/api/members/${memberId}/refunds`, payload);

describe('线上充值那一行的原路退回', () => {
  let memberId: number;
  let p: MemberRefundPlan;

  it('没注册原路退回：核对写「没开」；交给门店系统的拒绝，授权不浪费', async () => {
    memberId = (await createMember(ctx, '线上退卡会员', '19988880001')).id;
    await counter(memberId, yuan(200), 'wechat');
    await online(memberId, yuan(1000), 'WX4200000001202611049001');
    p = await plan(memberId);
    expect(p.onlineRoute).toBe(false);
    expect(p.lines.map((l) => [l.channel, l.method, l.amount])).toEqual([
      ['mp', 'wechat', yuan(1000)],
      ['counter', 'wechat', yuan(200)],
    ]);
    const g = await grant(memberId, p.amount);
    const r = await refund(memberId, body(p, g, [{ route: 'mp_auto', ref: '' }]));
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error.code).toBe('ONLINE_REFUND_UNAVAILABLE');
    expect(r.body.error.message).toContain('退款单号');
    // 注册了但没开、或者出错：一样按没开处理
    registerOnlineRefundRoute({ available: async () => false });
    expect((await plan(memberId)).onlineRoute).toBe(false);
    registerOnlineRefundRoute({
      available: async () => {
        throw new Error('微信支付没配好');
      },
    });
    expect((await plan(memberId)).onlineRoute).toBe(false);
    expect((await refund(memberId, body(p, g, [{ route: 'mp_auto', ref: '' }]))).body.error.code).toBe('ONLINE_REFUND_UNAVAILABLE');
  });

  it('开着时：只有线上充值、微信付的那一行能交给门店系统，不能带单号', async () => {
    registerOnlineRefundRoute({ available: async () => true });
    expect((await plan(memberId)).onlineRoute).toBe(true);
    const g = await grant(memberId, p.amount);
    const withRef = await refund(memberId, body(p, g, [{ route: 'mp_auto', ref: 'WXR-1' }]));
    expect(withRef.status).toBe(400);
    expect(withRef.body.error.message).toContain('不用填退款单号');
    // 前台微信充的那一笔（第二行）不能交给门店系统
    const counterLine = await refund(memberId, body(p, g, [{}, { route: 'mp_auto', ref: '' }]));
    expect(counterLine.status, JSON.stringify(counterLine.body)).toBe(422);
    expect(counterLine.body.error.code).toBe('ONLINE_ROUTE_NOT_ALLOWED');
  });

  it('交给门店系统：线上那一行不填单号、标「门店系统原路退回」；小程序线按行号取到交易单号；日结单列、对账包写明', async () => {
    registerOnlineRefundRoute({ available: async () => true });
    const g = await grant(memberId, p.amount);
    const r = await refund(memberId, body(p, g, [{ route: 'mp_auto', ref: '' }, { ref: 'WXR-COUNTER-1' }]));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const doc = r.body.refund as MemberRefundDetail;
    expect(doc.lines.map((l) => [l.channel, l.method, l.amount, l.ref, l.route])).toEqual([
      ['mp', 'wechat', yuan(1000), '', 'mp_auto'],
      ['counter', 'wechat', yuan(200), 'WXR-COUNTER-1', 'manual'],
    ]);
    const rows = await listOnlineRefundLines(ctx.sql);
    expect(rows).toEqual([
      expect.objectContaining({ refundId: doc.id, refundNo: doc.refundNo, memberId, paymentRef: 'WX4200000001202611049001', amount: yuan(1000) }),
    ]);
    expect(await listOnlineRefundLines(ctx.sql, { afterId: rows[0]!.lineId })).toEqual([]);

    const date = doc.businessDate;
    const settle = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body;
    expect(settle.memberRefund).toMatchObject({ count: 1, principal: yuan(1200), online: { count: 1, amount: yuan(1000), auto: yuan(1000) } });
    expect(settle.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    const anomaly = (settle.anomalies as { kind: string; description: string }[]).find((a) => a.kind === 'member_refund')!;
    expect(anomaly.description).toContain('门店系统原路退回');
    const pack = await buildDailyRecon(ctx.sql, ctx.config, date);
    expect(pack.ok).toBe(true);
    const csv = pack.files.find((f) => f.name === '11-储值退回.csv')!.content;
    expect(csv).toContain('门店系统原路退回（小程序）');
    expect(csv).toContain('WXR-COUNTER-1');
  });

  it('员工已在商户平台退过：线上那一行照旧填单号（员工退）；v0.7.26 的请求原样重提仍是同一笔', async () => {
    registerOnlineRefundRoute({ available: async () => true });
    const m = (await createMember(ctx, '手动退的线上会员', '19988880002')).id;
    await online(m, yuan(500), 'WX4200000001202611049002');
    const q = await plan(m);
    const g = await grant(m, q.amount);
    // v0.7.26 的页面不带 route；之后按「员工退」原样重提（带 route: manual）是同一笔
    const key = randomUUID();
    const old = await refund(m, body(q, g, [{ ref: 'WXR-MANUAL-9' }], key));
    expect(old.status, JSON.stringify(old.body)).toBe(200);
    const again = await refund(m, body(q, g, [{ route: 'manual', ref: 'WXR-MANUAL-9' }], key));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, refund: { id: old.body.refund.id } });
    expect((again.body.refund as MemberRefundDetail).lines[0]).toMatchObject({ route: 'manual', ref: 'WXR-MANUAL-9' });
    // 员工退的不在小程序线要取的行里
    expect((await listOnlineRefundLines(ctx.sql)).map((x) => x.memberId)).not.toContain(m);
  });

  it('升级前已有线上退储值、已日结：旧快照没有「其中退线上充值」，升级后不误报「有变动」；真实变化照样报（测试会话 fa2dc12 的 P2）', async () => {
    const m = (await createMember(ctx, '旧日结的线上会员', '19988880003')).id;
    await online(m, yuan(100), 'WX4200000001202611049003');
    const q = await plan(m);
    const g = await grant(m, q.amount);
    const r = await refund(m, body(q, g, [{ ref: 'WXR-OLD-1' }]));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const date = (r.body.refund as MemberRefundDetail).businessDate;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/settlements/${date}/close`, { note: '升级前确认' })).status).toBe(200);
    const read = async () => (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${date}`)).body;
    expect((await read()).closed.changedSinceClose).toBe(false);

    // 做成 v0.7.26 确认时的快照：没有 memberRefund.online（此刻按同一批单据算出来的不是 0）
    await ctx.sql`UPDATE daily_settlements SET snapshot = snapshot #- '{memberRefund,online}' WHERE business_date = ${date}`;
    const [snap] = await ctx.sql<{ hasOnline: boolean }[]>`
      SELECT (snapshot -> 'memberRefund') ? 'online' AS has_online FROM daily_settlements WHERE business_date = ${date}`;
    expect(snap!.hasOnline).toBe(false);
    const now = await read();
    expect(now.memberRefund.online.count).toBeGreaterThan(0);
    expect(now.closed.changedSinceClose).toBe(false);

    // 真实的账务变化照样报「有变动」
    await counter(m, yuan(200), 'wechat');
    expect((await read()).closed.changedSinceClose).toBe(true);
  });

  it('数据库兜底：交给门店系统的行只能是充值、微信、不带单号；自检照常全过', async () => {
    const checks = await consistencyChecks(ctx.sql, ctx.config.timezone);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    const [l] = await ctx.sql<{ refundId: number; rechargeId: number }[]>`SELECT refund_id, recharge_id FROM member_refund_lines WHERE route = 'mp_auto' LIMIT 1`;
    await expect(
      ctx.sql`INSERT INTO member_refund_lines (refund_id, source, recharge_id, method, amount, ref, route)
              VALUES (${l!.refundId}, 'recharge', ${l!.rechargeId}, 'wechat', 1, 'X', 'mp_auto')`,
    ).rejects.toThrow(/member_refund_lines_route_scope_check/);
    await expect(
      ctx.sql`INSERT INTO member_refund_lines (refund_id, source, recharge_id, method, amount, ref, route)
              VALUES (${l!.refundId}, 'recharge', ${l!.rechargeId}, 'cash', 1, '', 'mp_auto')`,
    ).rejects.toThrow(/member_refund_lines_route_scope_check/);
  });
});
