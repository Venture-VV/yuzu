// 打印数据（R1.3）：结账单带上结账那一刻的明细与储值扣前扣后余额；反结账的单照样打出当时的门票，
// 重新结账的单只含新的门票。建在 seed-frontdesk-demo + seed-billing-demo 上。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { minuteOfDay } from '../src/shared/business-date';
import type { CheckoutPrint } from '../src/shared/print';
import expected from '../src/server/demo/billing-expected.json';
import { createStaff } from '../src/server/modules/staff';
import { seedBillingDemo } from '../src/server/seed-billing';
import { seedFrontdeskDemo } from '../src/server/seed-frontdesk';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
let cashier: string;
let prints: CheckoutPrint[];

const byTags = (tags: string[], status: 'completed' | 'voided') =>
  prints.find((p) => p.status === status && p.bills.map((b) => b.tagCode).join() === tags.join())!;

async function printAll() {
  const [row] = await ctx.sql<{ date: string }[]>`SELECT DISTINCT business_date::text AS date FROM checkouts WHERE note = '结账演示'`;
  const list = (await api(ctx.app, cashier, 'GET', `/api/frontdesk/checkouts?date=${row!.date}`)).body as { id: number }[];
  return Promise.all(list.map(async (c) => (await api<CheckoutPrint>(ctx.app, cashier, 'GET', `/api/print/checkouts/${c.id}`)).body));
}

beforeAll(async () => {
  ctx = await setup();
  // 与 billing-seed.test 相同：避开营业日切换（06:00）附近
  let now = new Date();
  const m = minuteOfDay(now, 'Asia/Shanghai');
  if (m >= 360 && m < 450) now = new Date(now.getTime() - 2 * 3_600_000);
  await seedFrontdeskDemo(ctx.sql, ctx.config, { now });
  await seedBillingDemo(ctx.sql, ctx.config, { now });
  cashier = await login(ctx.app, expected.accounts.cashier, expected.accounts.password);
  prints = await printAll();
});
afterAll(async () => ctx.close());

describe('结账单打印数据', () => {
  it('每张结账单、每个手牌的明细合计等于结账时的金额', () => {
    expect(prints).toHaveLength(expected.checkouts.length);
    for (const p of prints) {
      for (const b of p.bills) expect(b.linesTotal, `${p.checkoutNo} ${b.tagCode}`).toBe(b.amount);
      expect(p.bills.reduce((s, b) => s + b.amount, 0)).toBe(p.totalAmount);
    }
  });

  it('储值支付带上这笔消费前后的会员余额（先扣本金）', () => {
    const e = expected.checkouts[1]!;
    const wallet = byTags(e.tags, 'completed').payments.find((x) => x.method === 'wallet')!;
    const { paid, bonus } = expected.member.recharge;
    expect(wallet.balance).toEqual({
      before: { principal: paid, bonus },
      after: { principal: expected.member.principalBalance, bonus: expected.member.bonusBalance },
    });
    // 其他收款方式没有余额
    expect(byTags(e.tags, 'completed').payments.filter((x) => x.method !== 'wallet').every((x) => x.balance === null)).toBe(true);
  });

  it('明细含门票与挂账项目：过夜客 24 小时档 + 12 小时档，山野简餐 ×2', () => {
    const p = byTags(expected.checkouts[3]!.tags, 'completed');
    const lines = p.bills[0]!.lines;
    expect(lines.find((l) => l.name.startsWith('门票 · 不含餐'))?.amount).toBe(expected.checkouts[3]!.tickets[0]!.amount);
    expect(lines.find((l) => l.name === '山野简餐')).toMatchObject({ quantity: 2 });
    // 免票不挂明细
    const kid = byTags(expected.checkouts[2]!.tags, 'completed').bills.find((b) => b.ticketAmount === 0)!;
    expect(kid.lines.filter((l) => l.name.startsWith('门票'))).toEqual([]);
  });

  it('反结账的单照样打出当时的门票；重新结账的单只含新的门票', () => {
    const tags = expected.checkouts[4]!.tags;
    const voided = byTags(tags, 'voided');
    const again = byTags(tags, 'completed');
    const tickets = (p: CheckoutPrint) => p.bills[0]!.lines.filter((l) => l.name.startsWith('门票'));
    expect(tickets(voided)).toHaveLength(1);
    expect(tickets(again)).toHaveLength(1);
    expect(voided.voidReason).toBe(expected.checkouts[4]!.voidReason);
    expect(voided.payments[0]).toMatchObject({ method: 'cash', balance: null });
  });

  it('同一账单上前后两条门票（反结账时作废的、重新结账时挂的）各归各的结账单', async () => {
    const tags = expected.checkouts[4]!.tags;
    const voided = byTags(tags, 'voided');
    const again = byTags(tags, 'completed');
    const rows = await ctx.sql<{ amount: number; status: string }[]>`
      SELECT amount, status FROM bill_lines WHERE bill_id = ${again.bills[0]!.billId} AND ticket_type_id IS NOT NULL ORDER BY id`;
    expect(rows.map((r) => r.status)).toEqual(['voided', 'active']);
    const ticketOf = (p: CheckoutPrint) => p.bills[0]!.lines.find((l) => l.name.startsWith('门票'))!.amount;
    expect(ticketOf(voided)).toBe(voided.bills[0]!.ticketAmount);
    expect(ticketOf(again)).toBe(again.bills[0]!.ticketAmount);
    // 已结束的账单不能再挂账（数据库拦下），已结的单不会多出明细
    await expect(ctx.sql`
      INSERT INTO bill_lines (bill_id, source, name, unit_price, quantity, amount, post_key, business_date, posted_by)
      SELECT ${again.bills[0]!.billId}, 'other', '结账后补挂', 100, 1, 100, gen_random_uuid(), business_date, operator_id
      FROM checkouts WHERE id = ${again.id}`).rejects.toThrow(/账单已结束/);
  });

  it('没有前台查看权限的后勤人员不能取打印数据；结账单不存在时 404', async () => {
    await createStaff(ctx.sql, { username: 'houqin', displayName: '后勤', role: 'backoffice', password: 'yuzu-test-2026', mustChangePassword: false });
    const backoffice = await login(ctx.app, 'houqin', 'yuzu-test-2026');
    expect((await api(ctx.app, backoffice, 'GET', `/api/print/checkouts/${prints[0]!.id}`)).status).toBe(403);
    expect((await api(ctx.app, cashier, 'GET', '/api/print/checkouts/999999')).status).toBe(404);
  });
});
