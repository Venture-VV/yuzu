// 小程序第二期 2b：对账（docs/MP_RECHARGE.md 第 8 节）。用模拟的微信支付出交易账单，逐笔与线上充值单核对：
//   · 都对上；微信有、门店还没记的先查单补上；门店没有这张单、门店记了微信账单里没有、金额对不上都标红；
//   · 同一个商户号下不是小程序的交易不核对；那天没有交易按 0 笔；结论只追加；
//   · 每天北京时间 10 点半以后自动对前一天、一天一次，下不了账单 30 分钟后再试；
//   · 后台按天重新核对（店主、店总），只能核对昨天及以前。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MembershipRules } from '../src/shared/membership';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpRechargeAdminData } from '../src/shared/mp';
import type { Deps } from '../src/server/lib/context';
import { buildMpApp } from '../src/server/modules/mp/app';
import type { PayRuntime } from '../src/server/modules/mp/pay';
import { beijingDate, maybeReconcileYesterday, reconcileDay, resetReconBackoff } from '../src/server/modules/mp/recharge-recon';
import { createMockWxPay, type MockWxPay } from '../src/server/modules/mp/wxpay-mock';
import { api, createMember, setup, type TestContext } from './helpers';

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
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(100), topUpMinCents: yuan(100) })).status).toBe(
    200,
  );
  const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/recharge/rules', {
    enabled: true,
    planIds: [],
    customEnabled: true,
    maxCents: yuan(10000),
    dailyLimit: 20,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

const call = (method: 'GET' | 'POST', url: string, openid: string, payload?: unknown) =>
  Promise.resolve(
    mp.inject({
      method,
      url,
      headers: { [MP_GATEWAY_HEADER]: KEY, [MP_OPENID_HEADER]: openid },
      ...(payload === undefined ? {} : { payload: payload as object }),
    }),
  );
let n = 0;
async function bound(name: string) {
  n += 1;
  const phone = `1366700${String(1000 + n)}`;
  const m = await createMember(ctx, name, phone);
  const openid = `openid-recon-${n}-${randomUUID().slice(0, 8)}`;
  const version = (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
  expect((await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: version, mock: true })).statusCode).toBe(200);
  return { memberId: m.id, openid };
}
/** 下一张单（自定义金额），返回单号 */
async function order(openid: string, amount: number): Promise<string> {
  const r = await call('POST', '/api/mp/recharge/orders', openid, { clientKey: randomUUID(), amount });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().order.orderNo as string;
}
const today = () => beijingDate(new Date());

describe('逐笔核对', () => {
  it('都对上：微信账单里的每一笔门店都入了账、金额一样；门店入账的每一笔账单里都有', async () => {
    const a = await bound('演示·对账甲');
    const b = await bound('演示·对账乙');
    for (const [who, amount] of [
      [a, yuan(300)],
      [b, yuan(500)],
    ] as const) {
      const no = await order(who.openid, amount);
      expect((await call('POST', `/api/mp/recharge/orders/${no}/mock-pay`, who.openid, {})).json().status).toBe('paid');
    }
    const r = await reconcileDay(deps, pay, today(), { source: 'auto' });
    expect(r).toMatchObject({
      billDate: today(),
      ok: true,
      wxCount: 2,
      wxAmount: yuan(800),
      storeCount: 2,
      storeAmount: yuan(800),
      issues: [],
      source: 'auto',
    });
  });

  it('微信有、门店还没记（到账通知没送到）：先去微信查单补上，补上了就不算没对上', async () => {
    const c = await bound('演示·对账丙');
    const no = await order(c.openid, yuan(200));
    wx.pay(no); // 微信那边付了，到账通知没送到门店
    const r = await reconcileDay(deps, pay, today(), { source: 'auto' });
    expect(r.issues).toEqual([]);
    const [o] = await ctx.sql<{ status: string }[]>`SELECT status FROM mp_recharge_orders WHERE order_no = ${no}`;
    expect(o!.status).toBe('paid');
  });

  it('门店没有这张单、金额对不上、门店记了微信账单里没有：标红；不是小程序的交易不核对', async () => {
    const d = await bound('演示·对账丁');
    const no = await order(d.openid, yuan(100));
    expect((await call('POST', `/api/mp/recharge/orders/${no}/mock-pay`, d.openid, {})).json().status).toBe('paid');
    const [paid] = await ctx.sql<{ transactionId: string }[]>`SELECT transaction_id FROM mp_recharge_orders WHERE order_no = ${no}`;
    // 同一笔交易在账单里又出现一行、金额不一样
    wx.addBillRow(today(), { outTradeNo: no, transactionId: paid!.transactionId, amount: yuan(99) });
    // 门店系统里没有的一张单
    wx.addBillRow(today(), { outTradeNo: 'MPR20261104ZZZZZZZZZZ', transactionId: '4200000000000000000000009999', amount: yuan(50) });
    // 前台扫码收款等别的交易：不是 MPR 开头的单号，不核对
    wx.addBillRow(today(), { outTradeNo: 'POS20261104000001', transactionId: '4200000000000000000000008888', amount: yuan(30) });
    // 门店记了、微信这天的账单里没有：到账通知里的付款时间是另一天（例如跨零点）
    const e = await bound('演示·对账戊');
    const no2 = await order(e.openid, yuan(100));
    const notice = wx.notification({
      appid: wx.config.appId,
      mchid: wx.config.mchId,
      out_trade_no: no2,
      transaction_id: '4200000000000000000000007777',
      trade_state: 'SUCCESS',
      success_time: `${today()}T00:03:00+08:00`,
      payer: { openid: e.openid },
      amount: { total: yuan(100) },
    });
    expect((await call('POST', '/api/mp/pay/notify', '', { headers: notice.headers, body: Buffer.from(notice.body).toString('base64') })).statusCode).toBe(204);
    const r = await reconcileDay(deps, pay, today(), { source: 'auto' });
    expect(r.ok).toBe(false);
    const kinds = r.issues.map((i) => [i.kind, i.outTradeNo]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['AMOUNT_MISMATCH', no],
        ['UNKNOWN_ORDER', 'MPR20261104ZZZZZZZZZZ'],
        ['NOT_IN_BILL', no2],
      ]),
    );
    expect(kinds.some(([, o]) => o === 'POS20261104000001')).toBe(false);
    expect(r.issues.find((i) => i.kind === 'NOT_IN_BILL')!.note).toContain('零点前后');
  });

  it('那天没有交易：按 0 笔算、都对上；结论只追加，后台每天取最后一次', async () => {
    const r1 = await reconcileDay(deps, pay, '2026-01-01', { source: 'auto' });
    expect(r1).toMatchObject({ ok: true, wxCount: 0, storeCount: 0 });
    const r2 = await reconcileDay(deps, pay, '2026-01-01', { source: 'manual', staffId: ctx.ownerId });
    expect(r2.id).toBeGreaterThan(r1.id);
    const data = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp/recharge')).body as MpRechargeAdminData;
    expect(data.recons.filter((x) => x.billDate === '2026-01-01')).toEqual([expect.objectContaining({ id: r2.id, source: 'manual' })]);
    await expect(ctx.sql`UPDATE mp_recharge_recons SET ok = false WHERE id = ${r1.id}`).rejects.toThrow();
  });
});

describe('每天自动对前一天、后台重新核对', () => {
  it('北京时间 10 点半以前不对；之后对前一天、一天只自动对一次；下不了账单 30 分钟后再试', async () => {
    resetReconBackoff();
    const at = (bj: string) => new Date(`${bj}+08:00`);
    expect(await maybeReconcileYesterday(deps, pay, at('2026-03-02T10:20:00'))).toBeNull();
    const r = await maybeReconcileYesterday(deps, pay, at('2026-03-02T10:31:00'));
    expect(r).toMatchObject({ billDate: '2026-03-01', source: 'auto' });
    expect(await maybeReconcileYesterday(deps, pay, at('2026-03-02T10:32:00'))).toBeNull();
    expect(await maybeReconcileYesterday(deps, null, at('2026-03-03T11:00:00'))).toBeNull();
    wx.setDown(true);
    await expect(maybeReconcileYesterday(deps, pay, at('2026-03-03T11:00:00'))).rejects.toThrow('30 分钟后再试');
    wx.setDown(false);
    expect(await maybeReconcileYesterday(deps, pay, at('2026-03-03T11:10:00'))).toBeNull();
    expect(await maybeReconcileYesterday(deps, pay, at('2026-03-03T11:31:00'))).toMatchObject({ billDate: '2026-03-02' });
  });

  it('后台按天重新核对：店主、店总能点；只能核对昨天及以前；店员不行', async () => {
    const ok = await api(ctx.app, ctx.owner, 'POST', '/api/admin/mp/recharge/recon', { date: '2026-02-01' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ billDate: '2026-02-01', source: 'manual', staffName: expect.any(String) });
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/mp/recharge/recon', { date: today() })).body.error.code).toBe('BILL_NOT_READY');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/mp/recharge/recon', { date: '2026/02/01' })).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/mp/recharge/recon', { date: '2026-02-01' })).status).toBe(403);
  });
});
