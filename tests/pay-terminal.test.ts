// 8.0.21 支付直连 · 扫码收款（docs/INTEGRATIONS_V8021.md 第 2 节，CW-G / CW7；迁移 148）。用的是模拟实现（tests/helpers.ts 的配置）：
// 付款码尾号 0000 失败、1111 第二次查询成功、2222 一直在等、3333 退款失败，其余直接成功。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepPaying } from '../src/server/modules/pay-terminal';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let tagNo = 0;
const code = (tail = '8888') => `1345${String(Date.now()).slice(-10)}${tail}`;

const enter = async () => {
  tagNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: `P${String(tagNo).padStart(3, '0')}`, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const total = async (visitIds: number[]) => (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitIds.join(',')}`)).body.totalAmount as number;
const scan = (body: Record<string, unknown>, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', '/api/pay/terminal', { clientKey: randomUUID(), provider: 'wechat', purpose: 'checkout', authCode: code(), ...body });
const checkout = (visitIds: number[], expectedTotal: number, payments: unknown[], cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds, expectedTotal, payments });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'pduty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'pduty');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'P', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  // 收款前要开班
  expect((await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 })).status).toBe(200);
  expect((await api(ctx.app, duty, 'POST', '/api/shifts', { openingCash: 0 })).status).toBe(200);
}, 60_000);
afterAll(async () => ctx.close());

describe('扫码收款', () => {
  it('模拟模式、门店开关默认开；扫码到账 → 结账带交易编号入账（参考号记支付方单号）→ 同一笔不能再用；方式、金额对不上拒绝', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/pay/terminal/status')).body).toEqual({ mode: 'mock', enabled: true });
    const v1 = await enter();
    const amount = await total([v1]);
    const key = randomUUID();
    const paid = await scan({ clientKey: key, amountCents: amount });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body).toMatchObject({ status: 'paid', amountCents: amount, consumed: null });
    expect(paid.body.providerTradeNo).toMatch(/^MOCKYZP/);
    // 原样重提：同一笔
    const again = await scan({ clientKey: key, amountCents: amount });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(paid.body.id);
    // 同一个编号、不同金额拒绝
    expect((await scan({ clientKey: key, amountCents: amount + 1 })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 付款码不存
    const calls = await ctx.sql<{ request: { authCode: string } }[]>`SELECT request_summary AS request FROM integration_calls WHERE kind = 'pay_terminal' AND action = 'pay' ORDER BY id DESC LIMIT 1`;
    expect(calls[0]!.request.authCode).toMatch(/^\*+8888$/);

    // 金额、方式对不上
    expect((await checkout([v1], amount, [{ method: 'wechat', amount: amount - 100, payTxId: paid.body.id }, { method: 'cash', amount: 100 }])).body.error.code).toBe('PAY_TX_MISMATCH');
    expect((await checkout([v1], amount, [{ method: 'alipay', amount, payTxId: paid.body.id }])).body.error.code).toBe('PAY_TX_MISMATCH');
    expect((await checkout([v1], amount, [{ method: 'cash', amount, payTxId: paid.body.id }])).status).toBe(400);
    const done = await checkout([v1], amount, [{ method: 'wechat', amount, payTxId: paid.body.id }]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.payments[0]).toMatchObject({ method: 'wechat', amount, ref: paid.body.providerTradeNo });
    const tx = (await api(ctx.app, ctx.clerk, 'GET', `/api/pay/terminal/${paid.body.id}`)).body;
    expect(tx.consumed).toMatchObject({ kind: 'checkout', id: done.body.id, docNo: done.body.checkoutNo });
    // 同一笔再用：拒绝
    const v2 = await enter();
    expect((await checkout([v2], amount, [{ method: 'wechat', amount, payTxId: paid.body.id }])).body.error.code).toBe('PAY_TX_USED');
    expect((await checkout([v2], amount, [{ method: 'cash', amount }])).status).toBe(200);
  });

  it('要输密码：先「支付中」、查一次还在等、再查到账；余额不足没付成；一直没结果的超过 5 分钟撤单', async () => {
    const p = await scan({ amountCents: 1_000, authCode: code('1111') });
    expect(p.body.status).toBe('paying');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/pay/terminal/${p.body.id}`)).body.status).toBe('paying');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/pay/terminal/${p.body.id}`)).body.status).toBe('paid');
    // 没入账的这一笔（之后原路退回）
    const failed = await scan({ amountCents: 1_000, authCode: code('0000') });
    expect(failed.body).toMatchObject({ status: 'failed', failReason: '余额不足（模拟）' });
    const stuck = await scan({ amountCents: 2_000, authCode: code('2222') });
    expect(stuck.body.status).toBe('paying');
    expect(await sweepPaying({ sql: ctx.sql, config: ctx.config }, new Date())).toBe(0);
    expect(await sweepPaying({ sql: ctx.sql, config: ctx.config }, new Date(Date.now() + 6 * 60_000))).toBe(1);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/pay/terminal/${stuck.body.id}`)).body).toMatchObject({ status: 'closed', failReason: expect.stringContaining('撤单') });
    // 状态只往前走
    await expect(ctx.sql`UPDATE pay_transactions SET status = 'paying' WHERE id = ${p.body.id}`).rejects.toThrow(/只能从/);
  });

  it('收了钱没入账：前台看得到；交班拦着；原路退回以后能交班', async () => {
    const open = (await api(ctx.app, ctx.clerk, 'GET', '/api/pay/terminal/open')).body as { id: number; status: string; consumed: unknown }[];
    const waiting = open.filter((t) => t.status === 'paid' && !t.consumed);
    expect(waiting).toHaveLength(1);
    const shift = (await api(ctx.app, ctx.clerk, 'GET', '/api/shifts/current')).body.shift;
    const summary = (await api(ctx.app, ctx.clerk, 'GET', `/api/shifts/${shift.id}`)).body;
    const close = () => api(ctx.app, ctx.clerk, 'POST', `/api/shifts/${shift.id}/close`, { countedCash: summary.summary?.cash?.expected ?? 0, expectedCash: summary.summary?.cash?.expected ?? 0 });
    const blocked = await close();
    expect(blocked.body.error?.code, JSON.stringify(blocked.body)).toBe('PAY_UNSETTLED');
    // 店员没有「开退款单」
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/pay/terminal/${waiting[0]!.id}/refund`, { clientKey: randomUUID(), reason: '客人不要了' })).status).toBe(403);
    const refundKey = randomUUID();
    const refunded = await api(ctx.app, duty, 'POST', `/api/pay/terminal/${waiting[0]!.id}/refund`, { clientKey: refundKey, reason: '客人不要了' });
    expect(refunded.status, JSON.stringify(refunded.body)).toBe(200);
    expect(refunded.body.refunds).toMatchObject([{ status: 'done', amountCents: 1_000, reason: '客人不要了' }]);
    // 重提同一个编号：还是那一条
    expect((await api(ctx.app, duty, 'POST', `/api/pay/terminal/${waiting[0]!.id}/refund`, { clientKey: refundKey, reason: '客人不要了' })).body.refunds).toHaveLength(1);
    // 退过款的不能再入账
    const v = await enter();
    expect((await checkout([v], await total([v]), [{ method: 'wechat', amount: 1_000, payTxId: waiting[0]!.id }, { method: 'cash', amount: (await total([v])) - 1_000 }])).body.error.code).toBe('PAY_TX_REFUNDED');
    const fresh = (await api(ctx.app, ctx.clerk, 'GET', `/api/shifts/${shift.id}`)).body;
    const ok = await api(ctx.app, ctx.clerk, 'POST', `/api/shifts/${shift.id}/close`, { countedCash: fresh.summary.cash.expected, expectedCash: fresh.summary.cash.expected });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 });
    // 那位客人用现金结掉
    expect((await checkout([v], await total([v]), [{ method: 'cash', amount: await total([v]) }])).status).toBe(200);
  });

  it('反结账解开用过的扫码收款（不自动退钱），挂到重新结账；退款单原路退回、退款失败的改线下已退；有原路退回的退款单不能作废', async () => {
    const v = await enter();
    const amount = await total([v]);
    const p = (await scan({ amountCents: amount, authCode: code('3333') })).body;
    const c = (await checkout([v], amount, [{ method: 'wechat', amount, payTxId: p.id }])).body;
    const voided = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${c.id}/void`, { clientKey: randomUUID(), reason: '结错了账', expectedTotal: amount });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/pay/terminal/${p.id}`)).body).toMatchObject({ status: 'paid', consumed: null, refundCents: 0 });
    const events = await ctx.sql<{ action: string }[]>`SELECT action FROM pay_tx_events WHERE tx_id = ${p.id} ORDER BY id`;
    expect(events.map((e) => e.action)).toEqual(['consume', 'release']);
    // 重新结账：挂这一笔
    const c2 = await checkout([v], amount, [{ method: 'wechat', amount, payTxId: p.id }]);
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);

    // 退款单：扫码收的部分默认原路退回
    const opts = (await api(ctx.app, duty, 'GET', `/api/frontdesk/checkouts/${c2.body.id}/refund-options`)).body;
    expect(opts.terminal).toEqual([{ method: 'wechat', refundable: amount }]);
    const item = opts.items[0];
    const refund = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${c2.body.id}/refunds`, {
      clientKey: randomUUID(),
      items: [{ category: item.category, name: item.name, quantity: 0, amount: 1_000 }],
      payments: [{ method: 'wechat', amount: 1_000, viaTerminal: true }],
      reason: '服务补偿',
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    // 尾号 3333：支付方退款失败 → 留在待办
    let tx = (await api(ctx.app, ctx.clerk, 'GET', `/api/pay/terminal/${p.id}`)).body;
    expect(tx.refundCents).toBe(1_000);
    expect(tx.refunds).toMatchObject([{ status: 'failed', amountCents: 1_000, refundNo: refund.body.refundNo }]);
    expect(((await api(ctx.app, ctx.clerk, 'GET', '/api/pay/terminal/open')).body as { id: number }[]).some((t) => t.id === p.id)).toBe(true);
    // 有原路退回的退款单不能作废
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/refunds/${refund.body.id}/void`, { reason: '开错了' })).body.error.code).toBe('REFUND_VIA_TERMINAL');
    // 线下已退
    expect((await api(ctx.app, duty, 'POST', `/api/pay/refunds/${tx.refunds[0].id}/resolve`, { action: 'offline', note: '' })).status).toBe(400);
    tx = (await api(ctx.app, duty, 'POST', `/api/pay/refunds/${tx.refunds[0].id}/resolve`, { action: 'offline', note: '商户后台手工退了' })).body;
    expect(tx.refunds[0]).toMatchObject({ status: 'offline', offlineNote: '商户后台手工退了' });
    // 原路退回超过扫码收的：拒绝
    const over = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${c2.body.id}/refunds`, {
      clientKey: randomUUID(),
      items: [{ category: item.category, name: item.name, quantity: 0, amount: amount }],
      payments: [{ method: 'wechat', amount: amount, viaTerminal: true }],
      reason: '全退',
    });
    expect(over.body.error.code).toMatch(/REFUND_METHOD_EXCEEDS|REFUND_EXCEEDS|PAY_REFUND_OVER/);
  });

  it('充值带交易编号入账；确认作废以后原请求不生效', async () => {
    const m = await createMember(ctx);
    const p = (await scan({ amountCents: 50_000, purpose: 'recharge' })).body;
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 50_000, 0, { payTxId: p.id }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [row] = await ctx.sql<{ paymentRef: string; payTxId: number }[]>`SELECT payment_ref, pay_tx_id FROM recharges WHERE member_id = ${m.id}`;
    expect(row).toMatchObject({ paymentRef: p.providerTradeNo, payTxId: p.id });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/pay/terminal/${p.id}`)).body.consumed).toMatchObject({ kind: 'recharge' });

    // 请求没到：查不到 → 确认作废 → 原请求晚到也不生效
    const key = randomUUID();
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/pay/terminal/by-key/${key}`)).status).toBe(404);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/pay/terminal/by-key/${key}/abandon`, {})).body).toEqual({ abandoned: true, tx: null });
    expect((await scan({ clientKey: key, amountCents: 1_000 })).body.error.code).toBe('OP_ABANDONED');
    // 已经有结果的作废不了，返回那一笔
    const k2 = randomUUID();
    const p2 = (await scan({ clientKey: k2, amountCents: 1_000 })).body;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/pay/terminal/by-key/${k2}/abandon`, {})).body).toMatchObject({ abandoned: false, tx: { id: p2.id } });
  });
});
