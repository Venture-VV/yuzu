// 营业日切换后 5 个半小时内灌结账演示（v0.7.25，打印用例在这个时段也能跑）：
// 收银班次原来在 5 小时前开班、落在前一个营业日；现在开班到交班这一段按比例压进当天营业日，
// 班次与全部演示结账单（含反结账）落在同一个营业日，金额、交班与 billing-expected.json 的固定预期一致，自检全过。
// 用前一个营业日的 07:10（切换后 70 分钟）灌，不依赖跑用例的时刻。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDayStart, businessDateOf } from '../src/shared/business-date';
import { shiftDate } from '../src/shared/labels';
import expected from '../src/server/demo/billing-expected.json';
import { seedBillingDemo } from '../src/server/seed-billing';
import { seedFrontdeskDemo } from '../src/server/seed-frontdesk';
import { api, login, setup, type TestContext } from './helpers';

const TZ = 'Asia/Shanghai';
let ctx: TestContext;
let owner: string;
let day: string;

beforeAll(async () => {
  ctx = await setup();
  day = shiftDate(businessDateOf(new Date(), TZ, 6), -1);
  const at = new Date(businessDayStart(day, TZ, 6).getTime() + 70 * 60_000);
  await seedFrontdeskDemo(ctx.sql, ctx.config, { now: at });
  expect(await seedBillingDemo(ctx.sql, ctx.config, { now: at })).toEqual({ skipped: false, checkouts: 6, voided: 1 });
  owner = await login(ctx.app, 'linlan', 'yuzu2026');
});
afterAll(async () => ctx?.close());

describe('切换后 70 分钟灌结账演示', () => {
  it('班次、结账单、反结账都落在当天营业日（不跨营业日）', async () => {
    const dates = await ctx.sql<{ date: string }[]>`
      SELECT DISTINCT business_date::text AS date FROM checkouts WHERE note = '结账演示'
      UNION SELECT DISTINCT void_business_date::text FROM checkouts WHERE note = '结账演示' AND void_business_date IS NOT NULL
      UNION SELECT DISTINCT s.business_date::text FROM shifts s JOIN staff t ON t.id = s.staff_id WHERE t.username IN ('chenyin', 'zhangjl')`;
    expect(dates.map((d) => d.date)).toEqual([day]);
  });

  it('金额与交班照固定预期；日结核对全部通过', async () => {
    const s = (await api(ctx.app, owner, 'GET', `/api/settlements/${day}`)).body;
    expect({ checkouts: s.business.checkouts, voids: s.business.voids, net: s.business.net, ticket: s.business.ticket }).toEqual({
      checkouts: expected.business.checkouts,
      voids: expected.business.voids,
      net: expected.business.net,
      ticket: expected.business.ticket,
    });
    for (const c of s.checks) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    const shifts = (await api(ctx.app, owner, 'GET', `/api/shifts?date=${day}`)).body as { staffName: string; status: string; expectedCash: number; countedCash: number }[];
    expect(shifts.find((x) => x.status === 'closed')).toMatchObject({ staffName: '陈茵', expectedCash: expected.shift.expectedCash, countedCash: expected.shift.countedCash });
  });
});
