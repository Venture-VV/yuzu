// 订单查询与逐行明细（8.0.15，docs/ORDERS_V8015.md 第 2 节）：前台「流水」页的「订单查询」。
//   · 按结账单号、退款单号、手牌号（整号或只输数字）、桌号、会员手机号（后 4 位或全号）、会员姓名、客人称呼查；通配符当普通字；
//   · 已反结账、有退款的标得出来；退款单跟着原结账单一起列；
//   · 没有「查看历史营业日」的岗位只查得到当天的，之前的单明细接口拒绝；
//   · 明细与打印的结账单同一个取法，另加所属部门与摊到每一行的优惠——各行相加 = 结账时记下的项目快照；
//   · 每一张结账单（前一天的结账演示 + 今天的手牌、桌台）按行算出来的「部门 × 项目」与快照一致；
//   · 导出：一行一个消费项目，金额相加 = 这些结账单的金额相加；退款单的行是负数；记审计。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocateLineDiscounts, linesFromItems, orderPhoneQuery, orderStatusLabel, type CheckoutOrderDetail, type OrderSearchResult, type RawOrderLine } from '../src/shared/orders';
import type { CheckoutPrint } from '../src/shared/print';
import type { RefundDetail } from '../src/shared/checkout';
import expected from '../src/server/demo/billing-expected.json';
import { createStaff } from '../src/server/modules/staff';
import { seedBillingDemo } from '../src/server/seed-billing';
import { seedFrontdeskDemo } from '../src/server/seed-frontdesk';
import { api, createMember, demoSeedTime, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let manager: string;
let backoffice: string;
let today: string;
const item: Record<string, number> = {};
const prices: Record<number, number> = {};
const PHONE = '13800005566';

const search = async (params: { q?: string; date?: string }, cookie = duty) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  const r = await api<OrderSearchResult>(ctx.app, cookie, 'GET', `/api/ledger/orders?${qs}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const docNos = (r: OrderSearchResult) => r.rows.map((x) => x.docNo);
const detail = async (id: number, cookie = duty) => {
  const r = await api<CheckoutOrderDetail>(ctx.app, cookie, 'GET', `/api/ledger/orders/checkouts/${id}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

const enter = async (tagCode: string, extra: Record<string, unknown> = {}) => {
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', ...extra }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return v.body.visits[0].id as number;
};
const post = async (visitId: number, lines: { itemId: number; quantity: number }[]) => {
  const amount = lines.reduce((s, l) => s + l.quantity * prices[l.itemId]!, 0);
  const p = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines, expectedTotal: amount });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
};
const pay = async (visitId: number, payments: (total: number) => Record<string, unknown>[]) => {
  const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const c = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: pre.totalAmount, payments: payments(pre.totalAmount) });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return c.body as { id: number; checkoutNo: string; totalAmount: number };
};

/** 今天的四张结账单：张先生（两次搓澡 + 按摩，抹零 10 元，之后退一份搓澡）、会员王查询、之后反结账的散客、一张桌台 */
let zhang: { id: number; checkoutNo: string; totalAmount: number };
let wang: { id: number; checkoutNo: string; totalAmount: number };
let voided: { id: number; checkoutNo: string; totalAmount: number };
let table: { id: number; checkoutNo: string };
let refund: RefundDetail;

beforeAll(async () => {
  ctx = await setup();
  // 前一个营业日：前台演示 + 结账演示（之前的单，店员查不到）
  const yesterday = new Date(demoSeedTime().getTime() - 24 * 3600_000);
  await seedFrontdeskDemo(ctx.sql, ctx.config, { now: yesterday });
  await seedBillingDemo(ctx.sql, ctx.config, { now: yesterday });

  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'manager', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'office', displayName: '后台同事', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  manager = await login(ctx.app, 'manager');
  backoffice = await login(ctx.app, 'office');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'Q', from: 9001, to: 9010, width: 4, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['查询搓澡', '查询洗浴', 6800],
    ['查询按摩', '查询按摩', 19800],
    ['查询炒饭', '查询餐饮', 2800],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    prices[item[name]!] = price;
  }

  // ① 张先生：搓澡分两次挂（同一个项目两行）+ 按摩，抹零 10 元
  const v1 = await enter('Q9001', { guestLabel: '张先生' });
  await post(v1, [{ itemId: item['查询搓澡']!, quantity: 1 }, { itemId: item['查询按摩']!, quantity: 1 }]);
  await post(v1, [{ itemId: item['查询搓澡']!, quantity: 2 }]);
  const grant = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: 'duty', password: PASSWORD, purpose: 'checkout_discount', scope: { visitIds: [v1], amount: 1000, reason: '老客人抹零' } });
  expect(grant.status, JSON.stringify(grant.body)).toBe(200);
  zhang = await pay(v1, (t) => [{ method: 'discount', amount: 1000, grantId: grant.body.grantId }, { method: 'cash', amount: t - 1000 }]);

  // ② 会员王查询：微信
  const m = await createMember(ctx, '王查询', PHONE);
  const v2 = await enter('Q9002', { memberId: m.id });
  wang = await pay(v2, (t) => [{ method: 'wechat', amount: t }]);

  // ③ 散客：结账后反结账
  const v3 = await enter('Q9003');
  voided = await pay(v3, (t) => [{ method: 'cash', amount: t }]);
  const vd = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${voided.id}/void`, { reason: '收款方式记错' });
  expect(vd.status, JSON.stringify(vd.body)).toBe(200);

  // ④ 桌台：查1 号桌，炒饭 ×2
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true, tablesEnabled: true })).status).toBe(200);
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '查询热菜' });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '查询热菜').id;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: item['查询炒饭']!, stationId }] })).status).toBe(200);
  const tb = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: '查1' });
  const tableId = tb.body.tables.find((t: { name: string }) => t.name === '查1').id;
  const open = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
  expect(open.status, JSON.stringify(open.body)).toBe(200);
  const order = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${open.body.id}/orders`, { clientKey: randomUUID(), lines: [{ itemId: item['查询炒饭']!, quantity: 2 }], expectedTotal: 5600 });
  expect(order.status, JSON.stringify(order.body)).toBe(200);
  const done = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/checkout', { clientKey: randomUUID(), sessionIds: [open.body.id], expectedTotal: 5600, payments: [{ method: 'wechat', amount: 5600 }] });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  table = done.body;

  // ⑤ 张先生退一份搓澡 60 元（现金；这一份分摊掉优惠以后实收 67.24）
  const r = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${zhang.id}/refunds`, {
    clientKey: randomUUID(),
    reason: '客人投诉服务',
    items: [{ category: '查询洗浴', name: '查询搓澡', quantity: 1, amount: 6000 }],
    payments: [{ method: 'cash', amount: 6000 }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  refund = r.body;
});
afterAll(async () => ctx.close());

describe('摊优惠与搜索词（不连数据库）', () => {
  const line = (lineId: number, name: string, quantity: number, unitPrice: number, category = '洗浴'): RawOrderLine => ({
    lineId, itemName: name, holder: '手牌 A1', name, category, technician: null, quantity, unitPrice, amount: quantity * unitPrice,
  });

  it('同一个项目的优惠按金额比例摊到行，尾差按舍去的部分从大到小补 1 分；各行相加 = 这个项目的优惠', () => {
    const lines = [line(1, '搓澡', 1, 6800), line(2, '搓澡', 2, 6800), line(3, '按摩', 1, 19800, '按摩')];
    const out = allocateLineDiscounts(lines, [
      { category: '洗浴', name: '搓澡', quantity: 3, amount: 20400, discount: 100 },
      { category: '按摩', name: '按摩', quantity: 1, amount: 19800, discount: 7 },
    ])!;
    // 100 × 6800 / 20400 = 33.33、100 × 13600 / 20400 = 66.67：先取 33、66，差的 1 分补给舍去多的那一行
    expect(out.map((l) => l.discount)).toEqual([33, 67, 7]);
    expect(out[0]).toEqual({ holder: '手牌 A1', name: '搓澡', category: '洗浴', technician: null, quantity: 1, unitPrice: 6800, amount: 6800, discount: 33 });
  });

  it('房费按种类合并的项目：行上的名称照账单，按它归到的项目摊', () => {
    const lines: RawOrderLine[] = [
      { ...line(1, '山景大床房 11-12', 1, 39900, '客房'), itemName: '房费（全天房）' },
      { ...line(2, '山景大床房 11-13', 1, 39900, '客房'), itemName: '房费（全天房）' },
    ];
    const out = allocateLineDiscounts(lines, [{ category: '客房', name: '房费（全天房）', quantity: 2, amount: 79800, discount: 801 }])!;
    expect(out.map((l) => [l.name, l.discount])).toEqual([
      ['山景大床房 11-12', 401],
      ['山景大床房 11-13', 400],
    ]);
  });

  it('按行算出来的与快照对不上（多一项、少一项、数量或金额不一样）：返回 null，改按快照显示', () => {
    const lines = [line(1, '搓澡', 1, 6800)];
    expect(allocateLineDiscounts(lines, [])).toBeNull();
    expect(allocateLineDiscounts(lines, [{ category: '洗浴', name: '搓澡', quantity: 2, amount: 13600, discount: 0 }])).toBeNull();
    expect(allocateLineDiscounts(lines, [{ category: '洗浴', name: '修脚', quantity: 1, amount: 6800, discount: 0 }])).toBeNull();
    expect(allocateLineDiscounts([], [{ category: '洗浴', name: '搓澡', quantity: 1, amount: 6800, discount: 0 }])).toBeNull();
    expect(allocateLineDiscounts([], [])).toEqual([]);
    // 按快照显示：快照里没有单价，只有 1 份的才显示
    expect(linesFromItems([
      { category: '按摩', name: '按摩', quantity: 1, amount: 19800, discount: 100 },
      { category: '门票', name: '门票 · 不含餐', quantity: 2, amount: 109800 + 49900, discount: 0 },
    ]).map((l) => [l.holder, l.name, l.technician, l.quantity, l.unitPrice, l.amount, l.discount])).toEqual([
      ['', '按摩', null, 1, 19800, 19800, 100],
      ['', '门票 · 不含餐', null, 2, null, 159700, 0],
    ]);
  });

  it('只有 4 位数字、1 开头的 11 位数字按手机号找；状态文字', () => {
    expect(orderPhoneQuery('5566')).toBe('tail');
    expect(orderPhoneQuery('13800005566')).toBe('full');
    for (const q of ['556', '55667', '0000556', '23800005566', 'A8067', '']) expect(orderPhoneQuery(q)).toBeNull();
    expect(orderStatusLabel({ kind: 'checkout', status: 'completed', refundedAmount: 0 })).toBe('已结账');
    expect(orderStatusLabel({ kind: 'checkout', status: 'completed', refundedAmount: 100 })).toBe('已结账 · 有退款');
    expect(orderStatusLabel({ kind: 'checkout', status: 'voided', refundedAmount: 0 })).toBe('已反结账');
    expect(orderStatusLabel({ kind: 'refund', status: 'completed', refundedAmount: 0 })).toBe('退款单');
    expect(orderStatusLabel({ kind: 'refund', status: 'voided', refundedAmount: 0 })).toBe('退款单 · 已作废');
  });
});

describe('订单查询', () => {
  it('不输搜索词：列所选营业日的全部结账单（含这一天反结账的）与退款单，时间倒序', async () => {
    const r = await search({});
    expect(r).toMatchObject({ q: '', date: today, historyAllowed: true, truncated: false });
    expect(docNos(r)).toEqual([refund.refundNo, table.checkoutNo, voided.checkoutNo, wang.checkoutNo, zhang.checkoutNo]);
    const z = r.rows.find((x) => x.docNo === zhang.checkoutNo)!;
    expect(z).toMatchObject({
      kind: 'checkout', id: zhang.id, checkoutId: zhang.id, checkoutNo: zhang.checkoutNo, businessDate: today, status: 'completed',
      amount: 49900 + 6800 * 3 + 19800, refundedAmount: 6000, tagCodes: ['Q9001'], tableNames: [], guests: ['张先生'], operatorName: '测试店员',
    });
    expect([...z.methods].sort()).toEqual(['cash', 'discount']);
    expect(orderStatusLabel(z)).toBe('已结账 · 有退款');
    expect(r.rows.find((x) => x.docNo === voided.checkoutNo)).toMatchObject({ status: 'voided', guests: [], tagCodes: ['Q9003'] });
    expect(r.rows.find((x) => x.docNo === wang.checkoutNo)).toMatchObject({ guests: ['王查询'], methods: ['wechat'], refundedAmount: 0 });
    expect(r.rows.find((x) => x.docNo === table.checkoutNo)).toMatchObject({ tagCodes: [], tableNames: ['查1'], amount: 5600 });
    expect(r.rows[0]).toMatchObject({
      kind: 'refund', id: refund.id, checkoutId: zhang.id, checkoutNo: zhang.checkoutNo, status: 'completed', amount: 6000, refundedAmount: 0,
      tagCodes: ['Q9001'], guests: ['张先生'], methods: ['cash'], operatorName: '值班经理',
    });
    // 翻到前一个营业日：结账演示的单
    const [d] = await ctx.sql<{ date: string }[]>`SELECT DISTINCT to_char(business_date, 'YYYY-MM-DD') AS date FROM checkouts WHERE note = '结账演示'`;
    const y = await search({ date: d!.date });
    expect(y.date).toBe(d!.date);
    expect(y.rows.filter((x) => x.kind === 'checkout')).toHaveLength(expected.checkouts.length);
    expect(y.rows.some((x) => x.docNo === zhang.checkoutNo)).toBe(false);
  });

  it('手牌号：整号不分大小写，或只输数字；别的手牌不带出来', async () => {
    for (const q of ['Q9001', 'q9001', '9001', '  Q9001 ']) {
      const r = await search({ q });
      expect(r.q).toBe(q.trim());
      expect(r.date).toBeNull();
      // 退款单跟着原结账单一起列
      expect(docNos(r), q).toEqual([refund.refundNo, zhang.checkoutNo]);
    }
    expect(docNos(await search({ q: 'Q900' }))).toEqual([]);
    expect(docNos(await search({ q: '900' }))).toEqual([]);
  });

  it('结账单号、退款单号：整号或一部分', async () => {
    expect(docNos(await search({ q: wang.checkoutNo }))).toEqual([wang.checkoutNo]);
    expect(docNos(await search({ q: wang.checkoutNo.toLowerCase() }))).toEqual([wang.checkoutNo]);
    expect(docNos(await search({ q: refund.refundNo }))).toEqual([refund.refundNo]);
    // 单号的前半截（JZ + 今天的日期）：今天的结账单都在，退款单跟着原单
    const part = zhang.checkoutNo.slice(0, zhang.checkoutNo.indexOf('-'));
    expect(docNos(await search({ q: part }))).toEqual([refund.refundNo, table.checkoutNo, voided.checkoutNo, wang.checkoutNo, zhang.checkoutNo]);
  });

  it('会员手机号后 4 位或 11 位全号、会员姓名、客人称呼、桌号；中间几位不算', async () => {
    expect(docNos(await search({ q: '5566' }))).toEqual([wang.checkoutNo]);
    expect(docNos(await search({ q: PHONE }))).toEqual([wang.checkoutNo]);
    expect(docNos(await search({ q: '0000556' }))).toEqual([]);
    expect(docNos(await search({ q: '138000055' }))).toEqual([]);
    expect(docNos(await search({ q: '王查询' }))).toEqual([wang.checkoutNo]);
    expect(docNos(await search({ q: '查询' }))).toEqual([wang.checkoutNo]);
    expect(docNos(await search({ q: '张先生' }))).toEqual([refund.refundNo, zhang.checkoutNo]);
    expect(docNos(await search({ q: '张' }))).toEqual([refund.refundNo, zhang.checkoutNo]);
    expect(docNos(await search({ q: '查1' }))).toEqual([table.checkoutNo]);
    // 储值支付的会员也算（结账演示：沈先生给同行的朋友一起付）
    const shen = await search({ q: expected.member.phone.slice(-4) });
    expect(shen.rows.length).toBeGreaterThan(0);
    expect(shen.rows.every((x) => x.kind === 'refund' || x.tagCodes.includes('A8066'))).toBe(true);
  });

  it('通配符当普通字；搜索词太长被拒', async () => {
    expect(docNos(await search({ q: '%' }))).toEqual([]);
    expect(docNos(await search({ q: '_' }))).toEqual([]);
    expect(docNos(await search({ q: 'Q9%' }))).toEqual([]);
    expect((await api(ctx.app, duty, 'GET', `/api/ledger/orders?q=${'x'.repeat(33)}`)).status).toBe(400);
    expect((await api(ctx.app, duty, 'GET', '/api/ledger/orders?date=2026-13')).status).toBe(400);
  });

  it('没有「查看历史营业日」的岗位：只查得到当天的；之前的营业日、之前的单的明细被拒', async () => {
    const [old] = await ctx.sql<{ id: number; checkoutNo: string; date: string }[]>`
      SELECT c.id, c.checkout_no, to_char(c.business_date, 'YYYY-MM-DD') AS date FROM checkouts c
      JOIN checkout_bills cb ON cb.checkout_id = c.id JOIN visits v ON v.id = cb.visit_id JOIN hand_tags t ON t.id = v.tag_id
      WHERE c.note = '结账演示' AND t.code = 'A8065'`;
    expect(old!.date).not.toBe(today);
    // 值班经理查得到
    expect(docNos(await search({ q: 'A8065' }))).toEqual([old!.checkoutNo]);
    expect((await detail(old!.id)).doc.checkoutNo).toBe(old!.checkoutNo);
    for (const cookie of [ctx.clerk, manager]) {
      const mine = await search({ q: 'A8065' }, cookie);
      expect(mine).toMatchObject({ date: today, historyAllowed: false, rows: [] });
      expect(docNos(await search({ q: 'Q9001' }, cookie))).toEqual([refund.refundNo, zhang.checkoutNo]);
      expect(docNos(await search({}, cookie))).toHaveLength(5);
      expect((await api(ctx.app, cookie, 'GET', `/api/ledger/orders?date=${old!.date}`)).status).toBe(403);
      expect((await api(ctx.app, cookie, 'GET', `/api/ledger/orders/checkouts/${old!.id}`)).status).toBe(403);
      expect((await detail(zhang.id, cookie)).doc.checkoutNo).toBe(zhang.checkoutNo);
      expect((await api(ctx.app, cookie, 'GET', `/api/ledger/orders/refunds/${refund.id}`)).status).toBe(200);
      // 导出要「导出流水与日结」
      expect((await api(ctx.app, cookie, 'GET', '/api/ledger/orders/export')).status).toBe(403);
    }
    // 没有「查看当日流水」的岗位都不行；没登录 401
    for (const url of ['/api/ledger/orders', `/api/ledger/orders/checkouts/${zhang.id}`, `/api/ledger/orders/refunds/${refund.id}`, '/api/ledger/orders/export']) {
      expect((await api(ctx.app, backoffice, 'GET', url)).status, url).toBe(403);
      expect((await api(ctx.app, null, 'GET', url)).status, url).toBe(401);
    }
    expect((await api(ctx.app, duty, 'GET', '/api/ledger/orders/checkouts/99999999')).status).toBe(404);
    expect((await api(ctx.app, duty, 'GET', '/api/ledger/orders/refunds/99999999')).status).toBe(404);
  });
});

describe('逐行明细', () => {
  it('与打印的结账单同一批行，另加所属部门与摊到每一行的优惠；各行相加 = 这张单的优惠', async () => {
    const d = await detail(zhang.id);
    expect(d.source).toBe('lines');
    expect(d.amount).toBe(zhang.totalAmount);
    expect(d.discount).toBe(1000);
    const posted = d.lines.filter((l) => l.category !== '门票');
    expect(posted.map((l) => [l.holder, l.name, l.category, l.quantity, l.unitPrice, l.amount])).toEqual([
      ['手牌 Q9001', '查询搓澡', '查询洗浴', 1, 6800, 6800],
      ['手牌 Q9001', '查询按摩', '查询按摩', 1, 19800, 19800],
      ['手牌 Q9001', '查询搓澡', '查询洗浴', 2, 6800, 13600],
    ]);
    expect(d.lines.filter((l) => l.category === '门票').map((l) => [l.holder, l.quantity, l.unitPrice, l.amount])).toEqual([['手牌 Q9001', 1, 49900, 49900]]);
    expect(d.lines.reduce((s, l) => s + l.discount, 0)).toBe(1000);
    // 与结账时记下的项目快照一分不差；同一个项目的两行按金额比例
    const items = await ctx.sql<{ category: string; name: string; discount: number }[]>`SELECT category, name, discount FROM checkout_items WHERE checkout_id = ${zhang.id}`;
    for (const i of items) {
      expect(d.lines.filter((l) => l.category === i.category && l.name === i.name).reduce((s, l) => s + l.discount, 0), i.name).toBe(Number(i.discount));
    }
    const [one, , two] = posted;
    expect(Math.abs(two!.discount - one!.discount * 2)).toBeLessThanOrEqual(1);
    // 打印的结账单：同样的行、同样的顺序
    const print = (await api<CheckoutPrint>(ctx.app, ctx.clerk, 'GET', `/api/print/checkouts/${zhang.id}`)).body;
    expect(d.doc).toEqual(print);
    expect(d.lines.map((l) => [l.name, l.unitPrice, l.quantity, l.amount, l.technician])).toEqual(
      print.bills.flatMap((b) => b.lines.map((l) => [l.name, l.unitPrice, l.quantity, l.amount, l.technician])),
    );
    expect(d.doc.refunds.map((r) => r.refundNo)).toEqual([refund.refundNo]);
  });

  it('桌台结账单的行记在桌台上；已反结账的单照样看得到当时的门票', async () => {
    const t = await detail(table.id);
    expect(t.lines).toEqual([{ holder: '桌台 查1', name: '查询炒饭', category: '查询餐饮', technician: null, quantity: 2, unitPrice: 2800, amount: 5600, discount: 0 }]);
    const v = await detail(voided.id);
    expect(v.doc.status).toBe('voided');
    expect(v.doc.voidReason).toBe('收款方式记错');
    expect(v.lines).toHaveLength(1);
    expect(v.lines[0]).toMatchObject({ holder: '手牌 Q9003', category: '门票', amount: 49900, discount: 0 });
  });

  it('退款单：退了哪几项、退款方式、原因', async () => {
    const r = await api<RefundDetail>(ctx.app, duty, 'GET', `/api/ledger/orders/refunds/${refund.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      refundNo: refund.refundNo, checkoutNo: zhang.checkoutNo, amount: 6000, reason: '客人投诉服务',
      items: [{ category: '查询洗浴', name: '查询搓澡', quantity: 1, amount: 6000 }], payments: [{ method: 'cash', amount: 6000 }],
    });
  });

  it('每一张结账单（前一天的结账演示 + 今天的）：按行算出来的「部门 × 项目」与结账时记下的快照一致，优惠合计相同', async () => {
    const all = await ctx.sql<{ id: number; checkoutNo: string; totalAmount: number }[]>`SELECT id, checkout_no, total_amount FROM checkouts ORDER BY id`;
    expect(all.length).toBeGreaterThanOrEqual(expected.checkouts.length + 4);
    for (const c of all) {
      const d = await detail(c.id);
      expect(d.source, c.checkoutNo).toBe('lines');
      expect(d.amount, c.checkoutNo).toBe(Number(c.totalAmount));
      const [snap] = await ctx.sql<{ amount: number; discount: number }[]>`
        SELECT coalesce(sum(amount), 0)::bigint AS amount, coalesce(sum(discount), 0)::bigint AS discount FROM checkout_items WHERE checkout_id = ${c.id}`;
      expect([d.amount, d.discount], c.checkoutNo).toEqual([Number(snap!.amount), Number(snap!.discount)]);
      // 这张单的优惠 + 券抵扣 + 会员折扣
      const off = d.doc.payments.filter((p) => ['discount', 'store_coupon', 'member_discount'].includes(p.method)).reduce((s, p) => s + p.amount, 0);
      expect(d.discount, c.checkoutNo).toBe(off);
      for (const b of d.doc.bills) expect(b.linesTotal, c.checkoutNo).toBe(b.amount);
    }
  });
});

describe('导出明细 CSV', () => {
  const parseCsv = (text: string) =>
    text.replace(/^﻿/, '').trim().split('\r\n').map((row) => row.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.slice(0, -1).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')));
  const cents = (s: string) => Math.round(Number(s.replace(/,/g, '')) * 100);

  it('一行一个消费项目；金额相加 = 这些结账单的金额相加；退款单的行是负数；记审计', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/ledger/orders/export', headers: { cookie: duty } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(decodeURIComponent(String(res.headers['content-disposition']))).toContain(`浴族订单明细-${today}.csv`);
    expect(res.body.startsWith('﻿')).toBe(true);
    const [header, ...rows] = parseCsv(res.body);
    expect(header).toEqual(['营业日', '时间', '单号', '类型', '状态', '手牌 / 桌号', '会员 / 称呼', '部门', '项目', '技师', '数量', '单价', '金额', '优惠', '实收', '整单收款方式', '经办人', '原结账单号']);
    const col = (name: string) => header!.indexOf(name);
    const list = await search({});
    const checkoutRows = rows.filter((r) => r[col('类型')] === '结账单');
    // 一行一个消费项目：张先生 4 行、王查询 1 行、反结账的 1 行、桌台 1 行；退款单 1 行
    expect(checkoutRows).toHaveLength(7);
    expect(rows.filter((r) => r[col('类型')] === '退款单')).toHaveLength(1);
    expect(checkoutRows.reduce((s, r) => s + cents(r[col('金额')]!), 0)).toBe(list.rows.filter((x) => x.kind === 'checkout').reduce((s, x) => s + x.amount, 0));
    expect(checkoutRows.reduce((s, r) => s + cents(r[col('优惠')]!), 0)).toBe(1000);
    for (const r of checkoutRows) expect(cents(r[col('实收')]!)).toBe(cents(r[col('金额')]!) - cents(r[col('优惠')]!));
    // 按时间从早到晚：第一行是张先生的单
    expect(rows[0]).toEqual(expect.arrayContaining([today, zhang.checkoutNo, '结账单', '已结账 · 有退款', 'Q9001', '张先生', '查询洗浴', '查询搓澡', '68.00', '测试店员']));
    expect(rows[0]![col('整单收款方式')]!.split('、').sort()).toEqual(['优惠 / 免单', '现金'].sort());
    expect(rows.find((r) => r[col('单号')] === table.checkoutNo)).toEqual(expect.arrayContaining(['查1', '查询餐饮', '查询炒饭', '2', '28.00', '56.00']));
    expect(rows.find((r) => r[col('单号')] === voided.checkoutNo)![col('状态')]).toBe('已反结账');
    const back = rows.find((r) => r[col('类型')] === '退款单')!;
    expect([back[col('单号')], back[col('部门')], back[col('项目')], back[col('数量')], back[col('金额')], back[col('实收')], back[col('原结账单号')], back[col('经办人')]]).toEqual([
      refund.refundNo, '查询洗浴', '查询搓澡', '-1', '-60.00', '-60.00', zhang.checkoutNo, '值班经理',
    ]);

    const [audit] = await ctx.sql<{ targetId: string; detail: { q: string; orders: number; lines: number } }[]>`
      SELECT target_id, detail FROM audit_logs WHERE action = 'export' AND target_type = 'orders' ORDER BY id DESC LIMIT 1`;
    expect(audit).toMatchObject({ targetId: today, detail: { q: '', orders: 5, lines: 8 } });
  });

  it('带搜索词：导出的就是页面上列出来的那几张', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/ledger/orders/export?q=${encodeURIComponent('张先生')}`, headers: { cookie: duty } });
    expect(res.statusCode).toBe(200);
    expect(decodeURIComponent(String(res.headers['content-disposition']))).toContain('浴族订单明细-搜索结果.csv');
    const [, ...rows] = parseCsv(res.body);
    expect(new Set(rows.map((r) => r[2]))).toEqual(new Set([zhang.checkoutNo, refund.refundNo]));
    expect(rows).toHaveLength(5);
  });
});
