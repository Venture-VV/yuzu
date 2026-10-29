// seed-billing-demo：结账、反结账与交班合成演示数据与固定预期（src/server/demo/billing-expected.json）逐项一致，
// 双口径日结与前台自检全部通过；交班规则（一人一个未交班班次、应有现金变化时拒绝交班、只能交自己的班）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { minuteOfDay } from '../src/shared/business-date';
import expected from '../src/server/demo/billing-expected.json';
import { seedBillingDemo } from '../src/server/seed-billing';
import { seedFrontdeskDemo } from '../src/server/seed-frontdesk';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
let owner: string;
let date: string;

beforeAll(async () => {
  ctx = await setup();
  // 演示单据在执行前 30 分钟内结账：避开营业日切换（06:00）附近，保证都落在同一个营业日
  let now = new Date();
  const m = minuteOfDay(now, 'Asia/Shanghai');
  if (m >= 360 && m < 450) now = new Date(now.getTime() - 2 * 3_600_000);
  await seedFrontdeskDemo(ctx.sql, ctx.config, { now });
  const r = await seedBillingDemo(ctx.sql, ctx.config, { now });
  expect(r).toEqual({ skipped: false, checkouts: 5, voided: 1 });
  owner = await login(ctx.app, 'linlan', 'yuzu2026');
  const dates = await ctx.sql<{ date: string }[]>`SELECT DISTINCT business_date::text AS date FROM checkouts WHERE note = '结账演示'`;
  expect(dates).toHaveLength(1);
  date = dates[0]!.date;
});
afterAll(async () => ctx.close());

describe('结账演示数据', () => {
  it('每张结账单的手牌、门票、收款与预期一致', async () => {
    const list = (await api(ctx.app, owner, 'GET', `/api/frontdesk/checkouts?date=${date}`)).body as { id: number }[];
    const details = await Promise.all(list.map(async (c) => (await api(ctx.app, owner, 'GET', `/api/frontdesk/checkouts/${c.id}`)).body));
    expect(details).toHaveLength(expected.checkouts.length);
    for (const e of expected.checkouts) {
      const d = details.find((x) => x.status === e.status && x.bills.map((b: { tagCode: string }) => b.tagCode).join() === e.tags.join());
      expect(d, e.scenario).toBeTruthy();
      expect(d.totalAmount, e.scenario).toBe(e.total);
      expect(d.bills.map((b: { tagCode: string; ticketName: string; ticketSegments: number; ticketAmount: number }) => ({ tag: b.tagCode, ticket: b.ticketName, segments: b.ticketSegments, amount: b.ticketAmount })), e.scenario).toEqual(e.tickets);
      expect(d.payments.map((p: { method: string; amount: number }) => ({ method: p.method, amount: p.amount })), e.scenario).toEqual(e.payments.map((p) => ({ method: p.method, amount: p.amount })));
      for (const p of e.payments) {
        const got = d.payments.find((x: { method: string }) => x.method === p.method);
        if ('principal' in p) expect(got.consumption).toMatchObject({ principal: p.principal, bonus: p.bonus, status: e.status === 'voided' ? 'reversed' : 'completed' });
        if ('code' in p) expect(got.coupon).toMatchObject({ platform: p.platform, code: p.code, status: e.status === 'voided' ? 'voided' : 'active' });
      }
      if ('voidReason' in e) expect(d.voidReason).toBe(e.voidReason);
    }
  });

  it('会员余额：充值后用储值支付 1200（先本金）', async () => {
    const [m] = await ctx.sql<{ principalBalance: number; bonusBalance: number }[]>`SELECT principal_balance, bonus_balance FROM members WHERE phone = ${expected.member.phone}`;
    expect(m).toEqual({ principalBalance: expected.member.principalBalance, bonusBalance: expected.member.bonusBalance });
  });

  it('双口径日结：营业口径与预期一致，全部核对项通过', async () => {
    const s = (await api(ctx.app, owner, 'GET', `/api/settlements/${date}`)).body;
    const b = s.business;
    expect({ checkouts: b.checkouts, voids: b.voids, net: b.net, ticket: b.ticket, items: b.items }).toEqual({
      checkouts: expected.business.checkouts,
      voids: expected.business.voids,
      net: expected.business.net,
      ticket: expected.business.ticket,
      items: expected.business.items,
    });
    expect(Object.fromEntries(b.byMethod.map((m: { method: string; amount: number }) => [m.method, m.amount]))).toEqual(expected.business.byMethod);
    expect(Object.fromEntries(b.coupons.map((c: { platform: string; amount: number }) => [c.platform, c.amount]))).toEqual(expected.business.coupons);
    expect(s.checks.map((c: { key: string }) => c.key)).toEqual(expected.settlementChecks);
    for (const c of s.checks) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    expect(s.anomalies.some((a: { kind: string }) => a.kind === 'checkout_void')).toBe(true);
    const fd = (await api(ctx.app, owner, 'GET', '/api/frontdesk/checks')).body;
    expect(fd.map((c: { key: string }) => c.key)).toEqual(expected.frontdeskChecks);
    for (const c of fd) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    // 前台演示的在店客人不受影响
    const board = (await api(ctx.app, owner, 'GET', '/api/frontdesk/board')).body;
    expect(board.stats.inStore).toBe(13);
  });

  it('交班：陈茵已交班（短款 10 元）；张经理当班中，记有他做的反结账', async () => {
    const shifts = (await api(ctx.app, owner, 'GET', `/api/shifts?date=${date}`)).body as {
      staffName: string; status: string; openingCash: number; expectedCash: number; countedCash: number;
      summary: { checkouts: { count: number; total: number }; checkoutByMethod: { method: string; amount: number }[]; voids: unknown[] };
    }[];
    const closed = shifts.find((s) => s.status === 'closed')!;
    expect(closed).toMatchObject({ staffName: '陈茵', openingCash: expected.shift.openingCash, expectedCash: expected.shift.expectedCash, countedCash: expected.shift.countedCash });
    expect(closed.countedCash - closed.expectedCash).toBe(expected.shift.diff);
    expect(closed.summary.checkouts).toEqual(expected.shift.checkouts);
    expect(Object.fromEntries(closed.summary.checkoutByMethod.map((m) => [m.method, m.amount]))).toEqual(expected.shift.byMethod);
    const open = shifts.find((s) => s.status === 'open')!;
    expect(open.staffName).toBe('张经理');
    expect(open.summary.voids).toHaveLength(expected.openShift.voids);
  });

  it('重复执行跳过；试用环境拒绝', async () => {
    expect(await seedBillingDemo(ctx.sql, ctx.config)).toEqual({ skipped: true });
    await expect(seedBillingDemo(ctx.sql, { ...ctx.config, env: 'trial' })).rejects.toThrow(/试用/);
  });
});

describe('交班规则', () => {
  it('一人只能有一个未交班的班次；应有现金变化时拒绝交班；只能交自己的班', async () => {
    const duty = await login(ctx.app, 'zhangjl', 'yuzu2026');
    const again = await api(ctx.app, duty, 'POST', '/api/shifts', { openingCash: 0 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SHIFT_OPEN');
    const clerk = await login(ctx.app, 'xiaozhou', 'yuzu2026');
    const mine = await api(ctx.app, clerk, 'POST', '/api/shifts', { openingCash: 20000 });
    expect(mine.status).toBe(200);
    // 店员不能替张经理交班
    const cur = (await api(ctx.app, duty, 'GET', '/api/shifts/current')).body.shift;
    expect((await api(ctx.app, clerk, 'POST', `/api/shifts/${cur.id}/close`, { countedCash: 0, expectedCash: cur.summary.cash.expected })).status).toBe(403);
    // 看到的应有现金与此刻不一致：拒绝
    const stale = await api(ctx.app, clerk, 'POST', `/api/shifts/${mine.body.id}/close`, { countedCash: 20000, expectedCash: 99 });
    expect(stale.body.error.code).toBe('SHIFT_CHANGED');
    const ok = await api(ctx.app, clerk, 'POST', `/api/shifts/${mine.body.id}/close`, { countedCash: 20000, expectedCash: 20000 });
    expect(ok.body).toMatchObject({ status: 'closed', expectedCash: 20000, countedCash: 20000 });
    expect((await api(ctx.app, clerk, 'POST', `/api/shifts/${mine.body.id}/close`, { countedCash: 20000, expectedCash: 20000 })).status).toBe(409);
    await expect(ctx.sql`UPDATE shifts SET counted_cash = 1 WHERE id = ${mine.body.id}`).rejects.toThrow(/交班后不能修改/);
  });
});
