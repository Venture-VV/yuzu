// 线上充值与「充值当日的储值消费比例」（RQ-014 ③；主线 8.0.4 需求表 04，docs/MEMBERSHIP_V804.md 第 4 节，HY01–HY03）。用模拟的微信支付：
//   · 线上充值按入账那个营业日算进「当天充值」：会员详情的今日储值可用、前台用储值付款的额度都算上；小程序充值本身不是储值消费；
//   · 同一笔的到账通知重复、同时到，只算一次；同一天几笔（线上、前台）加在一起，「充值前的余额」按当天第一笔之前；
//   · 跨营业日晚到的入账：付款在前一个营业日（早上 6 点前），到账通知 6 点以后才到（门店先去微信查单）——
//     算入账那天（余额那天才多出来），付款那天不算。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MembershipRules } from '../src/shared/membership';
import { shiftDate } from '../src/shared/labels';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpRechargeOrder } from '../src/shared/mp';
import { buildMpApp } from '../src/server/modules/mp/app';
import type { PayRuntime } from '../src/server/modules/mp/pay';
import { mpToday } from '../src/server/modules/mp/public';
import { createMockWxPay, type MockWxPay } from '../src/server/modules/mp/wxpay-mock';
import { spendQuotaOf } from '../src/server/modules/spend-quota';
import { api, consumeBody, createMember, rechargeBody, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const yuan = (n: number) => n * 100;
let ctx: TestContext;
let mp: FastifyInstance;
let wx: MockWxPay;

beforeAll(async () => {
  ctx = await setup();
  wx = createMockWxPay();
  const pay: PayRuntime = { mode: 'mock', config: wx.config, client: wx.client, mock: wx };
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay, sweepMs: 0 });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
  // 首充、续充 100 元起，不送赠金（只看本金与额度）
  const r = (await api(ctx.app, ctx.owner, 'GET', '/api/membership/rules')).body as MembershipRules;
  const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', {
    ...r,
    firstRechargeMinCents: yuan(100),
    topUpMinCents: yuan(100),
    grades: r.grades.map((g) => ({ ...g, bonusBp: 0 })),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const rules = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/recharge/rules', { enabled: true, planIds: [], customEnabled: true, maxCents: yuan(10000), dailyLimit: 5 });
  expect(rules.status, JSON.stringify(rules.body)).toBe(200);
  // 店主默认的 70%（测试库默认不限）
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { rechargeSpendPct: 70 })).status).toBe(200);
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});
afterEach(() => {
  vi.useRealTimers();
});

const call = (method: 'GET' | 'POST', url: string, openid: string | null, payload?: unknown) =>
  Promise.resolve(
    mp.inject({
      method,
      url,
      headers: { [MP_GATEWAY_HEADER]: KEY, ...(openid ? { [MP_OPENID_HEADER]: openid } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    }),
  );
let n = 0;
async function bound(name: string): Promise<{ memberId: number; openid: string }> {
  n += 1;
  const phone = `1366601${String(1000 + n)}`;
  const m = await createMember(ctx, name, phone);
  const openid = `openid-quota-${n}-${randomUUID().slice(0, 8)}`;
  const version = (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
  const b = await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: version, mock: true });
  expect(b.statusCode, b.body).toBe(200);
  return { memberId: m.id, openid };
}
/** 建一张线上充值单（自定义金额） */
async function order(openid: string, amount: number): Promise<string> {
  const version = (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
  const r = await call('POST', '/api/mp/recharge/orders', openid, { clientKey: randomUUID(), bindVersion: version, amount });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return (r.json() as { order: MpRechargeOrder }).order.orderNo;
}
const notify = (msg: { headers: unknown; body: string }) =>
  call('POST', '/api/mp/pay/notify', null, { headers: msg.headers, body: Buffer.from(msg.body, 'utf8').toString('base64') });
const quotaOf = async (memberId: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}`)).body.spendQuota;
const rechargesOf = (memberId: number) =>
  ctx.sql<{ paidAmount: number; channel: string; businessDate: string }[]>`
    SELECT paid_amount, channel, business_date::text AS business_date FROM recharges WHERE member_id = ${memberId} ORDER BY id`;
/** 门店时间（东八区）某天几点几分 */
const shopTime = (date: string, hm: string) => new Date(`${date}T${hm}:00+08:00`);

describe('线上充值算进当天的充值', () => {
  it('到账通知重复、同时到只算一次；同一天线上两笔、前台一笔加在一起；前台用储值按额度拦；小程序充值不是储值消费', async () => {
    const a = await bound('演示·额度线上');
    const first = await order(a.openid, yuan(1000));
    const msg = wx.pay(first);
    expect((await notify(msg)).statusCode).toBe(204);
    expect((await notify(msg)).statusCode).toBe(204);
    expect((await Promise.all([notify(msg), notify(msg)])).map((r) => r.statusCode)).toEqual([204, 204]);
    expect(await quotaOf(a.memberId)).toMatchObject({ recharged: yuan(1000), priorBalance: 0, pct: 70, cap: yuan(700), spent: 0, remaining: yuan(700) });
    // 小程序充值不是储值消费：没有消费记录，额度里「已用」是 0
    const [c0] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM consumptions WHERE member_id = ${a.memberId}`;
    expect(c0!.n).toBe(0);

    // 同一天再充：线上 500、前台 200，一起算
    const second = await order(a.openid, yuan(500));
    expect((await notify(wx.pay(second))).statusCode).toBe(204);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(a.memberId, yuan(200)))).status).toBe(200);
    const today = await mpToday(ctx.sql, ctx.config.timezone);
    const rows = await rechargesOf(a.memberId);
    expect(rows.map((r) => [r.channel === 'mp', r.paidAmount, r.businessDate])).toEqual([
      [true, yuan(1000), today],
      [true, yuan(500), today],
      [false, yuan(200), today],
    ]);
    expect(await quotaOf(a.memberId)).toMatchObject({ recharged: yuan(1700), priorBalance: 0, cap: yuan(1190), remaining: yuan(1190) });

    // 前台用储值：超过额度拦下，带剩余额度；额度以内照常
    const over = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(a.memberId, yuan(1190) + 1));
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: 'RECHARGE_SPEND_CAP', details: { remaining: yuan(1190), recharged: yuan(1700) } });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(a.memberId, yuan(1000)))).status).toBe(200);
    expect(await quotaOf(a.memberId)).toMatchObject({ spent: yuan(1000), remaining: yuan(190) });

    // 用了储值以后再线上充：充值前的余额仍按当天第一笔之前（0），额度按新的合计算
    const third = await order(a.openid, yuan(300));
    expect((await notify(wx.pay(third))).statusCode).toBe(204);
    expect(await quotaOf(a.memberId)).toMatchObject({ recharged: yuan(2000), priorBalance: 0, cap: yuan(1400), spent: yuan(1000), remaining: yuan(400) });
  });
});

describe('跨营业日晚到的入账', () => {
  it('前一天有余额；付款在营业日切换（6 点）之前，到账通知 6 点以后才到：算到账那天，「充值前的余额」是前一天的余额；付款那天不算', async () => {
    const b = await bound('演示·额度晚到');
    const today = await mpToday(ctx.sql, ctx.config.timezone);
    const yesterday = shiftDate(today, -1);
    vi.useFakeTimers({ toFake: ['Date'] });
    // 前一个营业日晚上：线上充 800，当场到账
    vi.setSystemTime(shopTime(yesterday, '20:00'));
    const earlier = await order(b.openid, yuan(800));
    expect((await notify(wx.pay(earlier))).statusCode).toBe(204);
    // 今天早上 5:50（营业日还是前一天）付了 1,000，到账通知没到
    vi.setSystemTime(shopTime(today, '05:50'));
    const late = await order(b.openid, yuan(1000));
    wx.pay(late, shopTime(today, '05:50'));
    // 6:10 通知才到（微信重发）：门店先去微信查单，查到已付才入账，入账那一刻已经是今天的营业日
    vi.setSystemTime(shopTime(today, '06:10'));
    expect((await notify(wx.pay(late, shopTime(today, '06:10')))).statusCode).toBe(204);
    // 重发的同一条再到：不再入账
    expect((await notify(wx.pay(late, shopTime(today, '06:11')))).statusCode).toBe(204);
    vi.useRealTimers();

    expect((await rechargesOf(b.memberId)).map((r) => [r.paidAmount, r.businessDate])).toEqual([
      [yuan(800), yesterday],
      [yuan(1000), today],
    ]);
    const [o] = await ctx.sql<{ paidAt: string; businessDate: string }[]>`SELECT paid_at, business_date::text AS business_date FROM mp_recharge_orders WHERE order_no = ${late}`;
    expect(Date.parse(String(o!.paidAt))).toBe(shopTime(today, '05:50').getTime());
    expect(o!.businessDate).toBe(yesterday);
    // 付款那天（前一个营业日）只算那天到账的 800；今天算晚到的 1,000，充值前的余额是前一天的 800
    expect(await spendQuotaOf(ctx.sql, b.memberId, yesterday, 70)).toMatchObject({ recharged: yuan(800), priorBalance: 0, cap: yuan(560) });
    expect(await spendQuotaOf(ctx.sql, b.memberId, today, 70)).toMatchObject({ recharged: yuan(1000), priorBalance: yuan(800), cap: yuan(1500), spent: 0 });
    expect(await quotaOf(b.memberId)).toMatchObject({ recharged: yuan(1000), priorBalance: yuan(800), cap: yuan(1500), remaining: yuan(1500) });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(b.memberId, yuan(1500) + 1))).body.error.code).toBe('RECHARGE_SPEND_CAP');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(b.memberId, yuan(1500)))).status).toBe(200);
  });
});
