// 小程序第二期 2d：原路退回（小程序线，docs/MP_RECHARGE.md 第 9 节；MP21）。用模拟的微信支付走：
//   · 开关：门店系统的微信支付配好、开着「原路退回」，主线的退储值才给选「门店系统原路退回」；关掉后主线拒绝，已经交给门店系统的照样退完；
//   · 主线退储值里交给门店系统的那一行：每分钟按行号取、按行号唯一建原路退回单（重复取不再建），申请退款（同一个退款单号）；
//     退款通知到了记已退到；没收到通知的处理中每 5 分钟查一次；
//   · 连不上微信、余额不够：过一会儿再试，同一个退款单号，店主可以马上再试；微信明确拒绝（例如店里已在商户平台退过、退超了）记没能退；
//   · 关闭、没能退的店主重试：先查旧单号，没退到才换新单号再退；退款异常、关闭、没能退的可以记已另行处理（写怎么处理的）；
//   · 找不到原来那笔线上充值单的行记没能退；不认识的退款通知记一条、回收到；对不上的退款通知不改状态；原路退回单不能删、金额不能改。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemberRefundPlan } from '../src/shared/member-refunds';
import type { MembershipRules } from '../src/shared/membership';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpRechargeAdminData, type MpRefundOrderAdmin } from '../src/shared/mp';
import type { Deps } from '../src/server/lib/context';
import { buildMpApp } from '../src/server/modules/mp/app';
import type { PayRuntime } from '../src/server/modules/mp/pay';
import { beijingDate, reconcileDay } from '../src/server/modules/mp/recharge-recon';
import { processRefunds, pullRefundLines } from '../src/server/modules/mp/refund';
import { createMockWxPay, type MockWxPay } from '../src/server/modules/mp/wxpay-mock';
import { rechargeOnline } from '../src/server/modules/wallet-online';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, createMember, PASSWORD, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const yuan = (n: number) => n * 100;
let ctx: TestContext;
let deps: Deps;
let mp: FastifyInstance;
let wx: MockWxPay;
let pay: PayRuntime;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  wx = createMockWxPay();
  pay = { mode: 'mock', config: wx.config, client: wx.client, mock: wx };
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay, sweepMs: 0 });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
  const r = (await api(ctx.app, ctx.owner, 'GET', '/api/membership/rules')).body as MembershipRules;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(100), topUpMinCents: yuan(100) })).status).toBe(200);
  expect((await rules({ refundAuto: true })).status).toBe(200);
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

function rules(patch: Record<string, unknown> = {}) {
  return api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/recharge/rules', { enabled: true, planIds: [], customEnabled: true, maxCents: yuan(10000), dailyLimit: 9, ...patch });
}
const call = (method: 'GET' | 'POST', url: string, openid: string | null, payload?: unknown) =>
  Promise.resolve(
    mp.inject({
      method,
      url,
      headers: { [MP_GATEWAY_HEADER]: KEY, ...(openid ? { [MP_OPENID_HEADER]: openid } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    }),
  );
const notify = (msg: { headers: unknown; body: string }) =>
  call('POST', '/api/mp/pay/notify', null, { headers: msg.headers, body: Buffer.from(msg.body, 'utf8').toString('base64') });

let n = 0;
/** 一位会员在小程序上线上充值（模拟支付），返回会员与那张线上充值单 */
async function paidOnline(name: string, amount: number): Promise<{ memberId: number; orderNo: string; openid: string }> {
  n += 1;
  const phone = `1388800${String(1000 + n)}`;
  const m = await createMember(ctx, name, phone);
  const openid = `openid-refund-${n}-${randomUUID().slice(0, 8)}`;
  const v0 = (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
  expect((await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: v0, mock: true })).statusCode).toBe(200);
  const v1 = (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
  const c = await call('POST', '/api/mp/recharge/orders', openid, { clientKey: randomUUID(), amount, bindVersion: v1 });
  expect(c.statusCode, c.body).toBe(201);
  const orderNo = c.json().order.orderNo as string;
  expect((await call('POST', `/api/mp/recharge/orders/${orderNo}/mock-pay`, openid, {})).json().status).toBe('paid');
  return { memberId: m.id, orderNo, openid };
}

const plan = async (memberId: number, amount?: number) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/refund-plan${amount ? `?amount=${amount}` : ''}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as MemberRefundPlan;
};
/** 主线退储值：线上充值那一行交给门店系统原路退回（店主当场授权） */
async function refundOnline(memberId: number, amount?: number) {
  const p = await plan(memberId, amount);
  const g = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: 'owner', password: PASSWORD, purpose: 'member_refund', scope: { memberId, amount: p.amount } });
  expect(g.status, JSON.stringify(g.body)).toBe(200);
  const r = await api(ctx.app, ctx.clerk, 'POST', `/api/members/${memberId}/refunds`, {
    clientKey: randomUUID(),
    amount: p.amount,
    expectedBonus: p.bonus,
    lines: p.lines.map((l) => ({ source: l.source, id: l.id, method: l.method ?? 'cash', amount: l.amount, ref: '', ...(l.channel === 'mp' ? { route: 'mp_auto' } : {}) })),
    reason: '会员不来了，退卡',
    grantId: g.body.grantId,
  });
  return r;
}
const orders = (memberId: number) =>
  ctx.sql<{ id: number; status: string; outRefundNo: string; amount: number; failCode: string | null; attempts: number; wxRefundId: string | null }[]>`
    SELECT id, status, out_refund_no, amount, fail_code, attempts, wx_refund_id FROM mp_refund_orders WHERE member_id = ${memberId} ORDER BY id`;
const adminRefunds = async () => ((await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp/recharge')).body as MpRechargeAdminData).refunds;
const act = (id: number, what: 'retry' | 'handle', body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/refunds/${id}/${what}`, body);
const sweep = (at = new Date()) => processRefunds(deps, pay, at);
const minutes = (m: number) => new Date(Date.now() + m * 60_000);

describe('开关', () => {
  it('门店系统的微信支付配好、开着原路退回：主线的退储值给选；关掉以后主线拒绝「交给门店系统」', async () => {
    const a = await paidOnline('演示·开关', yuan(300));
    expect((await plan(a.memberId)).onlineRoute).toBe(true);
    expect((await rules({ refundAuto: false })).status).toBe(200);
    expect((await plan(a.memberId)).onlineRoute).toBe(false);
    const r = await refundOnline(a.memberId);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ONLINE_REFUND_UNAVAILABLE');
    expect((await rules({ refundAuto: true })).status).toBe(200);
    expect((await plan(a.memberId)).onlineRoute).toBe(true);
    // 2d 以前的后台页面不带 refundAuto：照旧，不会被改掉
    expect((await rules({ refundAuto: false })).status).toBe(200);
    const { refundAuto: _omit, ...old } = { enabled: true, planIds: [], customEnabled: true, maxCents: yuan(10000), dailyLimit: 9, refundAuto: undefined };
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/recharge/rules', old)).body.refundAuto).toBe(false);
    expect((await rules({ refundAuto: true })).status).toBe(200);
  });
});

describe('原路退回', () => {
  it('取到交给门店系统的行、建原路退回单、申请退款（处理中）；退款通知到了记已退到；重复取不再建', async () => {
    const a = await paidOnline('演示·原路退回', yuan(300));
    const r = await refundOnline(a.memberId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await sweep()).toMatchObject({ created: 1, applied: 1 });
    const [o] = await orders(a.memberId);
    expect(o).toMatchObject({ status: 'processing', amount: yuan(300), attempts: 1 });
    expect(o!.outRefundNo).toMatch(/^MPRF\d{8}[0-9A-Z]{10}$/);
    expect(wx.refundState(o!.outRefundNo)).toBe('PROCESSING');
    expect(await sweep()).toMatchObject({ created: 0, applied: 0 });
    expect(await orders(a.memberId)).toHaveLength(1);
    const msg = wx.settleRefund(o!.outRefundNo, 'SUCCESS');
    expect((await notify(msg)).statusCode).toBe(204);
    expect((await notify(msg)).statusCode).toBe(204);
    const [done] = await orders(a.memberId);
    expect(done).toMatchObject({ status: 'success' });
    expect(done!.wxRefundId).toMatch(/^50/);
    const row = (await adminRefunds()).find((x) => x.id === o!.id)!;
    expect(row).toMatchObject({ status: 'success', memberId: a.memberId, outTradeNo: a.orderNo, receivedAccount: '支付用户零钱' });
    expect(row.succeededAt).not.toBeNull();
  });

  it('没收到退款通知：处理中的每 5 分钟查一次，查到成功记已退到', async () => {
    const a = await paidOnline('演示·查退款', yuan(200));
    expect((await refundOnline(a.memberId)).status).toBe(200);
    await sweep();
    const [o] = await orders(a.memberId);
    wx.settleRefund(o!.outRefundNo, 'SUCCESS');
    expect(await sweep(minutes(1))).toMatchObject({ queried: 0 });
    expect(await sweep(minutes(6))).toMatchObject({ queried: 1 });
    expect((await orders(a.memberId))[0]).toMatchObject({ status: 'success' });
  });

  it('连不上微信、余额不够：过一会儿再试（同一个退款单号）；店主可以马上再试', async () => {
    const a = await paidOnline('演示·连不上', yuan(200));
    expect((await refundOnline(a.memberId)).status).toBe(200);
    wx.setDown(true);
    await sweep();
    wx.setDown(false);
    const [o1] = await orders(a.memberId);
    expect(o1).toMatchObject({ status: 'new', attempts: 1, failCode: 'WXPAY_UNREACHABLE' });
    expect(await sweep()).toMatchObject({ applied: 0 });
    wx.setNotEnough(true);
    await sweep(minutes(3));
    const [o2] = await orders(a.memberId);
    expect(o2).toMatchObject({ status: 'new', attempts: 2, failCode: 'NOT_ENOUGH', outRefundNo: o1!.outRefundNo });
    expect(await sweep(minutes(10))).toMatchObject({ applied: 0 });
    wx.setNotEnough(false);
    // 店主充了钱，点「马上再试」：同一个退款单号
    const r = await act(o1!.id, 'retry', { outRefundNo: o1!.outRefundNo });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as MpRefundOrderAdmin).status).toBe('processing');
    expect((await orders(a.memberId))[0]).toMatchObject({ outRefundNo: o1!.outRefundNo, status: 'processing' });
  });

  it('微信明确拒绝（店里已在商户平台退过、退超了）：记没能退；店主重试先查旧单号，没退到才换新单号；或者已另行处理', async () => {
    const a = await paidOnline('演示·退超了', yuan(300));
    // 店员先在商户平台把这笔全退了（模拟的退款接口，另一个退款单号）
    wx.setRefundMode('success');
    await wx.client.refund({ outTradeNo: a.orderNo, outRefundNo: `MANUAL${n}X`, reason: '', refundCents: yuan(300), totalCents: yuan(300) });
    wx.setRefundMode('processing');
    expect((await refundOnline(a.memberId)).status).toBe(200);
    await sweep();
    const [o] = await orders(a.memberId);
    expect(o).toMatchObject({ status: 'failed', failCode: 'INVALID_REQUEST' });
    const shown = (await adminRefunds()).find((x) => x.id === o!.id)!;
    expect(shown.failMessage).toContain('超过');
    // 店主重试：查旧单号（微信那边没有这一笔），换新单号再退——还是退超了，照样没能退
    const retried = await act(o!.id, 'retry', { outRefundNo: o!.outRefundNo });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const after = (retried.body as MpRefundOrderAdmin);
    expect(after.outRefundNo).not.toBe(o!.outRefundNo);
    expect(after.status).toBe('failed');
    // 旧单号的重试、另行处理晚到：单号对不上，拒绝、不再动它（独立审查 2d 的 P2）
    const late = await act(o!.id, 'retry', { outRefundNo: o!.outRefundNo });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('REFUND_CHANGED');
    const lateHandle = await act(o!.id, 'handle', { outRefundNo: o!.outRefundNo, note: '页面没刷新' });
    expect(lateHandle.status).toBe(409);
    expect(lateHandle.body.error.code).toBe('REFUND_CHANGED');
    expect((await orders(a.memberId))[0]).toMatchObject({ status: 'failed', outRefundNo: after.outRefundNo });
    // 已另行处理：要写怎么处理的
    expect((await act(o!.id, 'handle', { outRefundNo: after.outRefundNo, note: '' })).status).toBe(400);
    const h = await act(o!.id, 'handle', { outRefundNo: after.outRefundNo, note: '店员已在商户平台全额退过，不再退' });
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ status: 'handled', handledNote: '店员已在商户平台全额退过，不再退' });
    expect((await act(o!.id, 'retry', { outRefundNo: after.outRefundNo })).status).toBe(409);
  });

  it('退款关闭：店主重试换新单号再退；退款异常：只能已另行处理（还在退的、已退到的不能另行处理）', async () => {
    const a = await paidOnline('演示·关闭了', yuan(200));
    expect((await refundOnline(a.memberId)).status).toBe(200);
    await sweep();
    const [o] = await orders(a.memberId);
    expect((await act(o!.id, 'handle', { outRefundNo: o!.outRefundNo, note: '还在退' })).status).toBe(409);
    expect((await notify(wx.settleRefund(o!.outRefundNo, 'CLOSED'))).statusCode).toBe(204);
    expect((await orders(a.memberId))[0]).toMatchObject({ status: 'closed', failCode: 'REFUND_CLOSED' });
    const r = await act(o!.id, 'retry', { outRefundNo: o!.outRefundNo });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const fresh = r.body as MpRefundOrderAdmin;
    expect(fresh.outRefundNo).not.toBe(o!.outRefundNo);
    expect(fresh.status).toBe('processing');
    expect((await notify(wx.settleRefund(fresh.outRefundNo, 'SUCCESS'))).statusCode).toBe(204);
    expect((await orders(a.memberId))[0]).toMatchObject({ status: 'success', outRefundNo: fresh.outRefundNo });
    expect((await act(o!.id, 'handle', { outRefundNo: fresh.outRefundNo, note: '已退到' })).status).toBe(409);

    const b = await paidOnline('演示·退款异常', yuan(200));
    expect((await refundOnline(b.memberId)).status).toBe(200);
    await sweep();
    const [ob] = await orders(b.memberId);
    expect((await notify(wx.settleRefund(ob!.outRefundNo, 'ABNORMAL'))).statusCode).toBe(204);
    expect((await orders(b.memberId))[0]).toMatchObject({ status: 'abnormal', failCode: 'REFUND_ABNORMAL' });
    expect((await act(ob!.id, 'retry', { outRefundNo: ob!.outRefundNo })).status).toBe(409);
    const h = await act(ob!.id, 'handle', { outRefundNo: ob!.outRefundNo, note: '顾客的卡注销了，商户平台转到顾客新卡' });
    expect(h.body).toMatchObject({ status: 'handled' });
  });

  it('找不到原来那笔线上充值单的行：记没能退，只能已另行处理；不认识的退款通知记一条、回收到；对不上的通知不改状态', async () => {
    const m = await createMember(ctx, '演示·没有线上单', `13888009${String(100 + n).slice(-3)}`);
    await ctx.sql.begin((tx) => rechargeOnline(tx, deps, { memberId: m.id, paidAmount: yuan(150), planId: null, paymentRef: '4200000000000000000000123456', orderNo: 'MPX-NO-ORDER-1' }));
    expect((await refundOnline(m.id)).status).toBe(200);
    await sweep();
    const [o] = await orders(m.id);
    expect(o).toMatchObject({ status: 'failed', failCode: 'ORDER_NOT_FOUND' });
    expect((await act(o!.id, 'retry', { outRefundNo: o!.outRefundNo })).status).toBe(422);
    expect((await act(o!.id, 'handle', { outRefundNo: o!.outRefundNo, note: '商户平台按交易单号退了' })).body).toMatchObject({ status: 'handled' });

    // 商户平台上手动退的、退款通知也配到了这个地址：记一条，回收到
    const a = await paidOnline('演示·手动退的通知', yuan(100));
    await wx.client.refund({ outTradeNo: a.orderNo, outRefundNo: `HAND${n}Y`, reason: '', refundCents: yuan(100), totalCents: yuan(100) });
    const unknown = wx.settleRefund(`HAND${n}Y`, 'SUCCESS');
    expect((await notify(unknown)).statusCode).toBe(204);
    expect((await notify(unknown)).statusCode).toBe(204);
    const [seen] = await ctx.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM mp_refund_events WHERE order_id IS NULL AND code = 'UNKNOWN_REFUND'`;
    expect(seen!.c).toBe(1);
  });

  it('同一张单一张一张办：店主的操作拿着这一张时，每分钟的扫描跳过它、下一分钟再来（独立审查 2d 的 P1）', async () => {
    const a = await paidOnline('演示·拿着锁', yuan(200));
    expect((await refundOnline(a.memberId)).status).toBe(200);
    expect(await pullRefundLines(deps, pay)).toBe(1);
    const [o] = await orders(a.memberId);
    expect(o).toMatchObject({ status: 'new' });
    const conn = await ctx.sql.reserve();
    try {
      await conn`SELECT pg_advisory_lock(hashtext(${`mp_refund:${o!.id}`}))`;
      expect(await sweep()).toMatchObject({ applied: 0, errors: 0 });
      expect(wx.refundState(o!.outRefundNo)).toBeNull();
      // 店主的操作等不到锁：回稍后再试，不动它
      const busy = act(o!.id, 'retry', { outRefundNo: o!.outRefundNo });
      await new Promise((r) => setTimeout(r, 300));
      await conn`SELECT pg_advisory_unlock(hashtext(${`mp_refund:${o!.id}`}))`;
      expect((await busy).status).toBe(200);
    } finally {
      conn.release();
    }
    expect(wx.refundState(o!.outRefundNo)).toBe('PROCESSING');
    expect(await sweep()).toMatchObject({ applied: 0 });
  });

  it('没能退的、微信那边其实有现在这个单号：另行处理前先查，在退的不让另行处理；之后的通知照样记已退到（独立审查 2d 的 P1）', async () => {
    const b = await paidOnline('演示·其实在退', yuan(200));
    expect((await refundOnline(b.memberId)).status).toBe(200);
    // 申请时余额不够：还是待申请，申请过一次
    wx.setNotEnough(true);
    await sweep();
    wx.setNotEnough(false);
    const [ob] = await orders(b.memberId);
    expect(ob).toMatchObject({ status: 'new', attempts: 1, failCode: 'NOT_ENOUGH' });
    // 微信那边用现在这个单号受理了，门店这边却记成了没能退（例如以为被拒了）
    const [row] = await ctx.sql<{ outTradeNo: string }[]>`SELECT out_trade_no FROM mp_refund_orders WHERE id = ${ob!.id}`;
    await wx.client.refund({ outTradeNo: row!.outTradeNo, outRefundNo: ob!.outRefundNo, reason: '', refundCents: yuan(200), totalCents: yuan(200) });
    await ctx.sql`UPDATE mp_refund_orders SET status = 'failed', fail_code = 'INVALID_REQUEST', fail_message = '测试：以为被拒了' WHERE id = ${ob!.id}`;
    const h = await act(ob!.id, 'handle', { outRefundNo: ob!.outRefundNo, note: '前台退了现金' });
    expect(h.status).toBe(409);
    expect(h.body.error.code).toBe('REFUND_IN_WECHAT');
    expect((await orders(b.memberId))[0]).toMatchObject({ status: 'processing' });
    expect((await notify(wx.settleRefund(ob!.outRefundNo, 'SUCCESS'))).statusCode).toBe(204);
    expect((await orders(b.memberId))[0]).toMatchObject({ status: 'success' });
  });

  it('行号小的晚提交：比已经建了单的行号小、还没建单的行照样取到（独立审查 2d 的 P2）', async () => {
    const a = await paidOnline('演示·晚提交一', yuan(100));
    const b = await paidOnline('演示·晚提交二', yuan(100));
    expect((await refundOnline(a.memberId)).status).toBe(200);
    expect((await refundOnline(b.memberId)).status).toBe(200);
    const lines = await ctx.sql<{ id: number; memberId: number }[]>`
      SELECT l.id, r.member_id FROM member_refund_lines l JOIN member_refunds r ON r.id = l.refund_id
      WHERE l.route = 'mp_auto' AND r.member_id IN (${a.memberId}, ${b.memberId}) ORDER BY l.id`;
    expect(lines.map((l) => Number(l.memberId))).toEqual([a.memberId, b.memberId]);
    // 模拟：行号大的那一行先被取到建了单（行号小的那一行当时还没提交）
    const [rc] = await ctx.sql<{ id: number; orderNo: string; rechargeId: number; transactionId: string }[]>`
      SELECT id, order_no, recharge_id, transaction_id FROM mp_recharge_orders WHERE member_id = ${b.memberId}`;
    const [refundRow] = await ctx.sql<{ id: number }[]>`SELECT refund_id AS id FROM member_refund_lines WHERE id = ${lines[1]!.id}`;
    await ctx.sql`
      INSERT INTO mp_refund_orders (line_id, member_refund_id, member_id, recharge_id, recharge_order_id, out_trade_no, transaction_id, out_refund_no, amount, total, mock, status)
      VALUES (${lines[1]!.id}, ${refundRow!.id}, ${b.memberId}, ${rc!.rechargeId}, ${rc!.id}, ${rc!.orderNo}, ${rc!.transactionId}, ${'MPRF20261104LATECOMMIT'}, ${yuan(100)}, ${yuan(100)}, true, 'new')`;
    expect(await orders(a.memberId)).toHaveLength(0);
    await sweep();
    expect(await orders(a.memberId)).toHaveLength(1);
    expect(await orders(b.memberId)).toHaveLength(1);
  });

  it('2b 对账核对退款行：微信退了、门店还没记的先查一次补上；门店没有这张单的、门店记了已退到账单里没有的标出来；商户平台手动退的不核对', async () => {
    const today = beijingDate(new Date());
    // 微信那边退到了，到账通知却没送到（门店还在处理中）：对账先查一次，补上了就不算没对上
    const a = await paidOnline('演示·对账补记', yuan(100));
    expect((await refundOnline(a.memberId)).status).toBe(200);
    await sweep();
    const [oa] = await orders(a.memberId);
    wx.settleRefund(oa!.outRefundNo, 'SUCCESS');
    expect((await orders(a.memberId))[0]).toMatchObject({ status: 'processing' });
    let r = await reconcileDay(deps, pay, today, { source: 'manual', staffId: ctx.ownerId });
    expect((await orders(a.memberId))[0]).toMatchObject({ status: 'success' });
    expect(r.issues.filter((i) => i.kind.startsWith('REFUND_'))).toEqual([]);
    // 门店系统里没有的原路退回单（商户退款单号是门店的格式）：标出来；商户平台手动退的（别的单号）不核对
    const b = await paidOnline('演示·对账没有的单', yuan(100));
    wx.setRefundMode('success');
    await wx.client.refund({ outTradeNo: b.orderNo, outRefundNo: 'MPRF20261104ZZZZZZZZZZ', reason: '', refundCents: yuan(50), totalCents: yuan(100) });
    await wx.client.refund({ outTradeNo: b.orderNo, outRefundNo: `HANDMADE${n}`, reason: '', refundCents: yuan(50), totalCents: yuan(100) });
    wx.setRefundMode('processing');
    // 门店记了已退到、微信账单里没有（例如记错了）
    const c = await paidOnline('演示·对账记错', yuan(100));
    expect((await refundOnline(c.memberId)).status).toBe(200);
    await sweep();
    const [oc] = await orders(c.memberId);
    await ctx.sql`UPDATE mp_refund_orders SET status = 'success', succeeded_at = now(), fail_code = NULL, fail_message = NULL WHERE id = ${oc!.id}`;
    r = await reconcileDay(deps, pay, today, { source: 'manual', staffId: ctx.ownerId });
    const refundIssues = r.issues.filter((i) => i.kind.startsWith('REFUND_'));
    expect(refundIssues.map((i) => [i.kind, i.outTradeNo])).toEqual([
      ['REFUND_UNKNOWN', b.orderNo],
      ['REFUND_NOT_IN_BILL', c.orderNo],
    ]);
    expect(refundIssues[0]!.note).toContain('MPRF20261104ZZZZZZZZZZ');
    expect(r.ok).toBe(false);
  });

  it('原路退回单不能删、金额与原单不能改；自检照常全过', async () => {
    const [o] = await ctx.sql<{ id: number }[]>`SELECT id FROM mp_refund_orders ORDER BY id LIMIT 1`;
    await expect(ctx.sql`DELETE FROM mp_refund_orders WHERE id = ${o!.id}`).rejects.toThrow();
    await expect(ctx.sql`UPDATE mp_refund_orders SET amount = amount + 1 WHERE id = ${o!.id}`).rejects.toThrow();
    await expect(ctx.sql`UPDATE mp_refund_events SET ok = NOT ok`).rejects.toThrow();
    expect((await consistencyChecks(ctx.sql, ctx.config.timezone)).filter((c) => !c.ok)).toEqual([]);
  });
});
