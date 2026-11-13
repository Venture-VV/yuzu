// 经营总览的部门 × 项目明细（8.0.15，docs/ORDERS_V8015.md 第 3 节）：
//   · 与「部门构成」同一份快照：每个部门各项相加 = 部门构成里这个部门的数（数量、销售金额、优惠、退款逐项相同）；
//   · 全表销售金额合计 = 应收，全表净额合计 = 净营业额（= 每日净营业额相加）；
//   · 反结账的冲回、退款单冲减数量与净额、作废的退款单不算；
//   · 导出的 CSV：一行一个项目，部门小计与合计，带 BOM，记审计；权限同经营总览。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { departmentItemTable, sharePercent, type DepartmentItem, type ExecutiveReport } from '../src/shared/reports';
import { createStaff } from '../src/server/modules/staff';
import { shiftDate } from '../src/shared/labels';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let boss: string;
let today: string;
let tagNo = 0;
const item: Record<string, number> = {};
const prices: Record<number, number> = {};

const exec = async (from = today, to = today) => {
  const r = await api<ExecutiveReport>(ctx.app, ctx.owner, 'GET', `/api/reports/executive?from=${from}&to=${to}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const csv = async (cookie = ctx.owner, q = `from=${today}&to=${today}`) => {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/reports/executive/items.csv?${q}`, headers: { cookie } });
  return { status: res.statusCode, type: String(res.headers['content-type']), disposition: String(res.headers['content-disposition'] ?? ''), text: res.body };
};
/** CSV 拆成格子（这里的内容没有逗号、引号、换行，直接按逗号拆） */
const cells = (text: string) =>
  text
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n')
    .map((l) => l.split(','));
const yuan = (c: number) => `${c < 0 ? '-' : ''}${Math.trunc(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
const checks = async () => {
  for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
};
/** 接待一位客人、挂项目、结账（可带一笔当场授权的优惠），返回结账单 */
const sale = async (lines: { itemId: number; quantity: number }[], discount = 0) => {
  tagNo += 1;
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: `D${String(tagNo).padStart(3, '0')}`, zone: 'male' }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.visits[0].id as number;
  if (lines.length) {
    const amount = lines.reduce((s, l) => s + l.quantity * prices[l.itemId]!, 0);
    const p = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${id}/charges`, { clientKey: randomUUID(), lines, expectedTotal: amount });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  }
  const total = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${id}`)).body.totalAmount as number;
  const payments: Record<string, unknown>[] = [{ method: 'cash', amount: total - discount }];
  if (discount) {
    const grant = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: 'duty', password: PASSWORD, purpose: 'checkout_discount', scope: { visitIds: [id], amount: discount, reason: '老客人抹零' } });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    payments.unshift({ method: 'discount', amount: discount, grantId: grant.body.grantId });
  }
  const c = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [id], expectedTotal: total, payments });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return c.body as { id: number; checkoutNo: string; totalAmount: number };
};
const refund = (checkoutId: number, body: Record<string, unknown>) =>
  api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${checkoutId}/refunds`, { clientKey: randomUUID(), reason: '客人投诉服务', ...body });

/** 三方对账：逐部门 = 部门构成；合计 = 应收、净营业额；每日净营业额相加 = 净营业额 */
function expectReconciled(r: ExecutiveReport) {
  const table = departmentItemTable(r.items);
  expect(table.groups.map((g) => g.category)).toEqual(r.departments.map((d) => d.category));
  for (const d of r.departments) {
    const g = table.groups.find((x) => x.category === d.category)!;
    expect({ category: g.category, quantity: g.quantity, amount: g.amount, discount: g.discount, refund: g.refund }, d.category).toEqual(d);
  }
  expect(table.total.amount).toBe(r.kpis.receivable);
  expect(table.total.discount).toBe(r.kpis.discount + r.kpis.coupon + r.kpis.memberDiscount);
  expect(table.total.refund).toBe(r.kpis.refund);
  expect(table.total.net).toBe(r.kpis.net);
  expect(r.trend.reduce((s, t) => s + t.net, 0)).toBe(r.kpis.net);
  return table;
}

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  boss = await login(ctx.app, 'boss');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'D', from: 1, to: 20, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['明细搓澡', '明细洗浴', 6800],
    ['明细修脚', '明细洗浴', 9800],
    ['明细按摩', '明细按摩', 19800],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    prices[item[name]!] = price;
  }
});
afterAll(async () => ctx.close());

describe('分组、小计与占比（页面与 CSV 共用的算法）', () => {
  const rows: DepartmentItem[] = [
    { category: '洗浴', name: '搓澡', quantity: 3, amount: 20400, discount: 100, refund: 3000 },
    { category: '按摩', name: '精油', quantity: 1, amount: 19800, discount: 0, refund: 0 },
    { category: '洗浴', name: '修脚', quantity: 1, amount: 9800, discount: 0, refund: 0 },
    { category: '按摩', name: '足疗', quantity: 2, amount: 19800, discount: 0, refund: 0 },
    { category: '冲回', name: '只有反结账', quantity: -1, amount: -5000, discount: 0, refund: 0 },
  ];

  it('部门按销售金额从大到小、部门内按金额（同额按数量）；小计、净额、占比、合计', () => {
    const t = departmentItemTable(rows);
    expect(t.groups.map((g) => [g.category, g.items.map((i) => i.name)])).toEqual([
      ['按摩', ['足疗', '精油']],
      ['洗浴', ['搓澡', '修脚']],
      ['冲回', ['只有反结账']],
    ]);
    const bath = t.groups[1]!;
    expect([bath.quantity, bath.amount, bath.discount, bath.refund, bath.net]).toEqual([4, 30200, 100, 3000, 27100]);
    expect(bath.items.map((i) => [i.net, sharePercent(i.share)])).toEqual([
      [17300, '67.5%'],
      [9800, '32.5%'],
    ]);
    expect(t.total).toEqual({ quantity: 6, amount: 64800, discount: 100, refund: 3000, net: 61700 });
    expect(sharePercent(t.groups[0]!.share)).toBe('61.1%');
    // 只有冲回的部门：金额是负数，占比不写
    expect(t.groups[2]!.share).toBeNull();
    expect(t.groups[2]!.items[0]!.share).toBeNull();
    expect(sharePercent(null)).toBe('—');
  });

  it('没有数据：空表、合计为 0', () => {
    expect(departmentItemTable([])).toEqual({ groups: [], total: { quantity: 0, amount: 0, discount: 0, refund: 0, net: 0 } });
  });
});

describe('经营总览的部门项目明细', () => {
  let a: { id: number; totalAmount: number };

  it('结账以后：每个部门各项相加 = 部门构成，合计 = 应收与净营业额；优惠按项目分摊', async () => {
    a = await sale([{ itemId: item['明细搓澡']!, quantity: 2 }, { itemId: item['明细修脚']!, quantity: 1 }, { itemId: item['明细按摩']!, quantity: 1 }], 1000);
    await sale([{ itemId: item['明细搓澡']!, quantity: 1 }]);
    const r = await exec();
    const t = expectReconciled(r);
    expect(r.kpis.discount).toBe(1000);
    const bath = t.groups.find((g) => g.category === '明细洗浴')!;
    expect(bath.items.map((i) => [i.name, i.quantity, i.amount])).toEqual([
      ['明细搓澡', 3, 20400],
      ['明细修脚', 1, 9800],
    ]);
    expect(bath.items.map((i) => sharePercent(i.share))).toEqual(['67.5%', '32.5%']);
    expect(bath.discount).toBeGreaterThan(0);
    const ticket = t.groups.find((g) => g.category === '门票')!;
    expect(ticket.quantity).toBe(2);
    // 排好序交给页面：部门按销售金额从大到小，部门内也是
    expect(r.items.map((i) => i.category).filter((c, i, all) => all.indexOf(c) === i)).toEqual(r.departments.map((d) => d.category));
    for (const g of t.groups) expect(g.items.map((i) => i.amount)).toEqual([...g.items.map((i) => i.amount)].sort((x, y) => y - x));
  });

  it('退款单：冲减这个项目的数量与净额，销售金额不变；作废的退款单不算', async () => {
    const before = await exec();
    const r1 = await refund(a.id, { items: [{ category: '明细洗浴', name: '明细搓澡', quantity: 1, amount: 3000 }], payments: [{ method: 'cash', amount: 3000 }] });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const r2 = await refund(a.id, { items: [{ category: '明细按摩', name: '明细按摩', quantity: 0, amount: 500 }], payments: [{ method: 'cash', amount: 500 }] });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/refunds/${r2.body.id}/void`, { reason: '登记错了' })).status).toBe(200);
    const r = await exec();
    expectReconciled(r);
    const row = (x: ExecutiveReport, name: string) => x.items.find((i) => i.name === name)!;
    expect(row(r, '明细搓澡')).toEqual({ ...row(before, '明细搓澡'), quantity: 2, refund: 3000 });
    expect(row(r, '明细按摩')).toEqual(row(before, '明细按摩'));
    expect(r.kpis.net).toBe(before.kpis.net - 3000);
    expect(r.kpis.receivable).toBe(before.kpis.receivable);
  });

  it('反结账：这张单的各项整项冲回（同一天结、同一天反，抵成 0 的项目不列）', async () => {
    const before = await exec();
    const c = await sale([{ itemId: item['明细修脚']!, quantity: 2 }]);
    const mid = await exec();
    expect(mid.items.find((i) => i.name === '明细修脚')!.quantity).toBe(3);
    const v = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${c.id}/void`, { reason: '结错了' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const r = await exec();
    expectReconciled(r);
    expect(r.items).toEqual(before.items);
    expect(r.kpis.net).toBe(before.kpis.net);
    await checks();
  });

  it('没有结账的时段：空表', async () => {
    const y = shiftDate(today, -1);
    const r = await exec(y, y);
    expect(r.items).toEqual([]);
    expectReconciled(r);
  });
});

describe('导出 CSV', () => {
  it('一行一个项目、部门小计、合计，与页面同一份数；带 BOM；记审计', async () => {
    const r = await exec();
    const t = departmentItemTable(r.items);
    const out = await csv();
    expect(out.status).toBe(200);
    expect(out.type).toContain('text/csv');
    expect(out.disposition).toContain(encodeURIComponent(`部门项目明细_${today}_${today}.csv`));
    expect(out.text.charCodeAt(0)).toBe(0xfeff);
    const rows = cells(out.text);
    expect(rows[0]).toEqual(['部门', '项目', '销售数量', '销售金额（应收，元）', '占该部门金额比', '优惠（元）', '退款（元）', '净额（元）']);
    const expected: string[][] = [];
    for (const g of t.groups) {
      for (const i of g.items) expected.push([g.category, i.name, String(i.quantity), yuan(i.amount), sharePercent(i.share), yuan(i.discount), yuan(i.refund), yuan(i.net)]);
      expected.push([g.category, '小计', String(g.quantity), yuan(g.amount), '100.0%', yuan(g.discount), yuan(g.refund), yuan(g.net)]);
    }
    expected.push(['合计', '', String(t.total.quantity), yuan(t.total.amount), '', yuan(t.total.discount), yuan(t.total.refund), yuan(t.total.net)]);
    expect(rows.slice(1, 1 + expected.length)).toEqual(expected);
    // 对照行：应收、净营业额（与合计行一分不差）
    const tail = rows.slice(1 + expected.length);
    expect(tail).toEqual([
      [`对照：应收（${today} 至 ${today}）`, '', '', yuan(r.kpis.receivable), '', '', '', ''],
      [`对照：净营业额（${today} 至 ${today}）`, '', '', '', '', '', '', yuan(r.kpis.net)],
    ]);
    expect(tail[0]![3]).toBe(yuan(t.total.amount));
    expect(tail[1]![7]).toBe(yuan(t.total.net));
    // 各项目行的销售金额相加 = 合计行
    const itemRows = rows.slice(1, 1 + expected.length).filter((x) => x[1] !== '小计' && x[0] !== '合计');
    expect(itemRows).toHaveLength(r.items.length);
    const [audit] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_logs WHERE action = 'export' AND target_type = 'executive_items' AND target_id = ${`${today}~${today}`} AND staff_id = ${ctx.ownerId}`;
    expect(audit!.n).toBe(1);
  });

  it('没有数据的时段：只有表头、合计与对照行', async () => {
    const y = shiftDate(today, -1);
    const out = await csv(ctx.owner, `from=${y}&to=${y}`);
    expect(out.status).toBe(200);
    expect(cells(out.text).map((x) => x[0])).toEqual(['部门', '合计', `对照：应收（${y} 至 ${y}）`, `对照：净营业额（${y} 至 ${y}）`]);
  });

  it('权限与时段：同经营总览（店主、店总能导；值班经理、店员不能；时段不对拒绝）', async () => {
    expect((await csv(boss)).status).toBe(200);
    expect((await csv(duty)).status).toBe(403);
    expect((await csv(ctx.clerk)).status).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/reports/executive/items.csv?from=${today}&to=${today}` })).statusCode).toBe(401);
    expect((await csv(ctx.owner, `from=${today}&to=2020-01-01`)).status).toBe(400);
    expect((await csv(ctx.owner, `from=${today}&to=2099-01-01`)).status).toBe(400);
    expect((await csv(ctx.owner, `from=2020-01-01&to=${today}`)).status).toBe(400);
  });
});
