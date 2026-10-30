// S5 餐饮第二步：桌台、开台（不洗浴客人的桌台账单）、桌台点单与退菜、转台、撤台、桌台结账与反结账，以及报表、自检口径。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let duty: string;
let cook: string;
let am: string;
let today: string;
const item: Record<string, number> = {};
const table: Record<string, number> = {};

type Detail = { id: number; sessionNo: string; status: string; tableName: string; guests: number; amount: number; lines: { id: number; name: string; status: string; source: string; kitchen: { status: string; note: string } | null }[]; moves: { fromTable: string; toTable: string; reason: string }[] };

const open = (tableId: number, body: Record<string, unknown> = {}, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/dining/tables/open', { clientKey, tableId, guests: 2, ...body });
const order = (sessionId: number, lines: { itemId: number; quantity: number; note?: string }[], expectedTotal: number, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', `/api/dining/tables/sessions/${sessionId}/orders`, { clientKey, lines, expectedTotal });
const detail = async (id: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/sessions/${id}`)).body as Detail;
const board = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/tables')).body as { tables: { id: number; name: string; session: { id: number; guests: number; amount: number; pendingDishes: number } | null }[] };
const pay = (sessionIds: number[], expectedTotal: number, payments: unknown[], cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/dining/tables/checkout', { clientKey, sessionIds, expectedTotal, payments });
const voidCheckout = (id: number, reason = '收错桌了') => api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${id}/void`, { reason });
const authorize = (scope: unknown) => api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: 'duty', password: PASSWORD, purpose: 'checkout_discount', scope });
const limit = (itemId: number, remaining: number | null) => api(ctx.app, ctx.clerk, 'PUT', `/api/kitchen/limits/${itemId}`, { remaining });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'cook', displayName: '厨房', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  duty = await login(ctx.app, 'duty');
  cook = await login(ctx.app, 'cook');
  am = await login(ctx.app, 'am');
  today = (await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.today;
  const station: Record<string, number> = {};
  for (const name of ['热菜', '水吧']) {
    const r = await api(ctx.app, boss, 'POST', '/api/admin/dining/stations', { name });
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  for (const [name, category, price] of [
    ['宫保鸡丁', '热菜', 4800],
    ['柠檬茶', '饮品', 1500],
    ['一次性拖鞋', '洗浴用品', 500],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  expect(
    (await api(ctx.app, boss, 'PUT', '/api/admin/dining/items', { items: [{ id: item['宫保鸡丁'], stationId: station['热菜'] }, { id: item['柠檬茶'], stationId: station['水吧'] }] })).status,
  ).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('后台桌台', () => {
  it('能管理价目的岗位建桌台、改名、停用；重名拒绝；店员不能改；看板只列启用的桌台', async () => {
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/dining/tables', { name: 'A1' })).status).toBe(403);
    for (const [name, area, seats] of [
      ['A1', '大厅', 4],
      ['A2', '大厅', 4],
      ['A3', '大厅', 6],
      ['包1', '包间', 10],
      ['停用桌', '大厅', 2],
    ] as const) {
      const r = await api(ctx.app, boss, 'POST', '/api/admin/dining/tables', { name, area, seats });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      table[name] = r.body.tables.find((t: { name: string }) => t.name === name).id;
    }
    expect((await api(ctx.app, boss, 'POST', '/api/admin/dining/tables', { name: ' a1 ' })).body.error.code).toBe('TABLE_NAME_TAKEN');
    expect((await api(ctx.app, boss, 'PUT', `/api/admin/dining/tables/${table['停用桌']}`, { name: '停用桌', active: false })).status).toBe(200);
    expect((await board()).tables.map((t) => t.name)).toEqual(['A1', 'A2', 'A3', '包1']);
    expect((await api(ctx.app, am, 'GET', '/api/dining/tables')).status).toBe(403);
    expect((await api(ctx.app, cook, 'GET', '/api/dining/tables')).status).toBe(200);
  });
});

describe('开台、点单、转台、退菜、撤台', () => {
  it('开台：同一编号重提不重复；桌台在用、停用都拒绝；餐饮关闭时不能开台；后勤不能开台', async () => {
    const key = randomUUID();
    const a = await open(table['A1']!, { guests: 3, guestLabel: '张总' }, ctx.clerk, key);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ tableName: 'A1', guests: 3, guestLabel: '张总', status: 'open', amount: 0 });
    expect((await open(table['A1']!, { guests: 3, guestLabel: '张总' }, ctx.clerk, key)).body.id).toBe(a.body.id);
    expect((await open(table['A1']!)).body.error.code).toBe('TABLE_TAKEN');
    expect((await open(table['停用桌']!)).body.error.code).toBe('TABLE_INACTIVE');
    expect((await open(table['A2']!, {}, cook)).status).toBe(403);
    const look = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=table_open`)).body;
    expect(look).toMatchObject({ found: true, type: 'table_open', session: { id: a.body.id, tableName: 'A1' } });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: false })).status).toBe(200);
    try {
      expect((await open(table['A2']!)).body.error.code).toBe('DINING_DISABLED');
    } finally {
      expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
    }
    expect((await board()).tables.find((t) => t.name === 'A1')!.session).toMatchObject({ id: a.body.id, guests: 3 });
    // 两台终端同时开同一张空桌：只有一台成功
    const both = await Promise.all([open(table['A3']!), open(table['A3']!, {}, duty)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const won = both.find((r) => r.status === 200)!.body;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${won.id}/cancel`, { reason: '测试并发' })).status).toBe(200);
  });

  it('点单到桌台：记在这桌的账单（餐饮），出品单显示桌号；只能点进厨房的菜；估清同样扣减；同一编号只下一次', async () => {
    const s = (await board()).tables.find((t) => t.name === 'A1')!.session!;
    const key = randomUUID();
    const r = await order(s.id, [{ itemId: item['宫保鸡丁']!, quantity: 2, note: '少辣' }, { itemId: item['柠檬茶']!, quantity: 1 }], 4800 * 2 + 1500, ctx.clerk, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.amount).toBe(11100);
    expect(r.body.lines.map((l: Detail['lines'][number]) => [l.name, l.source, l.kitchen?.status, l.kitchen?.note])).toEqual([
      ['宫保鸡丁', 'dining', 'queued', '少辣'],
      ['柠檬茶', 'dining', 'queued', ''],
    ]);
    expect((await order(s.id, [{ itemId: item['宫保鸡丁']!, quantity: 2, note: '少辣' }, { itemId: item['柠檬茶']!, quantity: 1 }], 11100, ctx.clerk, key)).body.lines).toHaveLength(2);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=table_post`)).body).toMatchObject({ found: true, type: 'table_post', session: { id: s.id } });
    expect((await order(s.id, [{ itemId: item['一次性拖鞋']!, quantity: 1 }], 500)).body.error.code).toBe('DISH_NOT_KITCHEN');
    const kds = (await api(ctx.app, cook, 'GET', '/api/kitchen')).body.items as { tableName: string | null; tagCode: string | null; guest: string; name: string }[];
    expect(kds.filter((k) => k.tableName === 'A1').map((k) => [k.name, k.tagCode, k.guest])).toEqual([
      ['宫保鸡丁', null, '张总'],
      ['柠檬茶', null, '张总'],
    ]);
    expect((await limit(item['柠檬茶']!, 1)).status).toBe(200);
    expect((await order(s.id, [{ itemId: item['柠檬茶']!, quantity: 2 }], 3000)).body.error.code).toBe('DISH_SOLD_OUT');
    expect((await limit(item['柠檬茶']!, null)).status).toBe(200);
    expect((await board()).tables.find((t) => t.name === 'A1')!.session).toMatchObject({ amount: 11100, pendingDishes: 3 });
  });

  it('转台：账单跟着走，记原因；转去的桌在用时拒绝；厨房屏显示新桌号', async () => {
    const s = (await board()).tables.find((t) => t.name === 'A1')!.session!;
    const other = (await open(table['A3']!)).body;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s.id}/move`, { toTableId: table['A3'], reason: '客人想换桌' })).body.error.code).toBe('TABLE_TAKEN');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s.id}/move`, { toTableId: table['A2'] })).status).toBe(400);
    const moved = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s.id}/move`, { toTableId: table['A2'], reason: '客人想靠窗' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ tableName: 'A2', amount: 11100, moves: [{ fromTable: 'A1', toTable: 'A2', reason: '客人想靠窗' }] });
    const b = await board();
    expect(b.tables.find((t) => t.name === 'A1')!.session).toBeNull();
    expect(b.tables.find((t) => t.name === 'A2')!.session!.id).toBe(s.id);
    const kds = (await api(ctx.app, cook, 'GET', '/api/kitchen')).body.items as { tableName: string | null }[];
    expect(kds.filter((k) => k.tableName === 'A2')).toHaveLength(2);
    // 改人数、称呼
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/dining/tables/sessions/${s.id}`, { guests: 4, guestLabel: '张总一行' })).body).toMatchObject({ guests: 4, guestLabel: '张总一行' });
    // 撤掉刚开的空台
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${other.id}/cancel`, { reason: '开错桌' })).body.status).toBe('cancelled');
  });

  it('退菜：作废明细、出品单已退、估清加回；有没结的菜不能撤台，退完可以撤', async () => {
    const s = (await open(table['包1']!, { guests: 6 })).body;
    expect((await limit(item['宫保鸡丁']!, 5)).status).toBe(200);
    const r = await order(s.id, [{ itemId: item['宫保鸡丁']!, quantity: 2 }], 9600);
    expect(r.status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s.id}/cancel`, { reason: '客人走了' })).body.error.code).toBe('BILL_UNSETTLED');
    const line = r.body.lines[0];
    const v = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/lines/${line.id}/void`, { reason: '客人不要了' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.lines[0]).toMatchObject({ status: 'voided', kitchen: { status: 'cancelled' } });
    expect(v.body.amount).toBe(0);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/lines/${line.id}/void`, { reason: '再退一次' })).body.error.code).toBe('ALREADY_VOIDED');
    const menu = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body.dishes as { id: number; remaining: number | null }[];
    expect(menu.find((d) => d.id === item['宫保鸡丁'])!.remaining).toBe(5);
    expect((await limit(item['宫保鸡丁']!, null)).status).toBe(200);
    // 前台的作废接口不处理桌台账单
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/void`, { reason: '前台作废' })).status).toBe(404);
    const c = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s.id}/cancel`, { reason: '客人走了' });
    expect(c.body).toMatchObject({ status: 'cancelled', closeReason: '客人走了' });
    expect((await order(s.id, [{ itemId: item['柠檬茶']!, quantity: 1 }], 1500)).body.error.code).toBe('TABLE_CLOSED');
  });
});

describe('桌台结账与反结账', () => {
  it('核对、收款：应收变了拒绝、少收拒绝；结清后桌台空出来，结账单写桌号与人数；同一编号只结一次', async () => {
    const s = (await board()).tables.find((t) => t.name === 'A2')!.session!;
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/checkout-preview?ids=${s.id}`)).body;
    expect(preview).toMatchObject({ totalAmount: 11100, sessions: [{ sessionId: s.id, tableName: 'A2', guests: 4, amount: 11100 }] });
    expect(preview.dishes.map((d: { name: string; status: string }) => [d.name, d.status])).toEqual([
      ['宫保鸡丁', 'queued'],
      ['柠檬茶', 'queued'],
    ]);
    expect((await pay([s.id], 10000, [{ method: 'cash', amount: 10000 }])).body.error.code).toBe('PRICE_CHANGED');
    expect((await pay([s.id], 11100, [{ method: 'cash', amount: 10000 }])).body.error.code).toBe('NOT_SETTLED');
    const key = randomUUID();
    const paid = await pay([s.id], 11100, [{ method: 'wechat', amount: 11100 }], ctx.clerk, key);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toMatchObject({ status: 'completed', totalAmount: 11100 });
    expect(paid.body.bills).toEqual([
      expect.objectContaining({ tableName: 'A2', guests: 4, visitId: null, tagCode: null, ticketName: null, ticketAmount: null, amount: 11100, guestLabel: '张总一行' }),
    ]);
    expect((await pay([s.id], 11100, [{ method: 'wechat', amount: 11100 }], ctx.clerk, key)).body.id).toBe(paid.body.id);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=table_checkout`)).body).toMatchObject({ found: true, type: 'table_checkout', checkout: { id: paid.body.id } });
    expect((await detail(s.id)).status).toBe('settled');
    expect((await board()).tables.find((t) => t.name === 'A2')!.session).toBeNull();
    const list = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts?date=${today}`)).body as { id: number; tableNames: string[]; tagCodes: string[] }[];
    expect(list.find((c) => c.id === paid.body.id)).toMatchObject({ tableNames: ['A2'], tagCodes: [] });
    const print = (await api(ctx.app, ctx.clerk, 'GET', `/api/print/checkouts/${paid.body.id}`)).body;
    expect(print.bills[0].lines.map((l: { name: string }) => l.name)).toEqual(['宫保鸡丁', '柠檬茶']);
    // 厨房屏：这桌已结账
    const kds = (await api(ctx.app, cook, 'GET', '/api/kitchen')).body.items as { tableName: string | null; visitClosed: boolean }[];
    expect(kds.filter((k) => k.tableName === 'A2').every((k) => k.visitClosed)).toBe(true);
  });

  it('储值只能由这桌登记的会员付，消费单写桌号；优惠授权的对象是这几桌，手牌的授权不能用', async () => {
    const m = await createMember(ctx, '桌台会员', '19900008801');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 50000))).status).toBe(200);
    const other = await createMember(ctx, '旁人', '19900008802');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(other.id, 50000))).status).toBe(200);
    const s = (await open(table['A1']!, { guests: 2, memberId: m.id })).body;
    expect((await order(s.id, [{ itemId: item['宫保鸡丁']!, quantity: 1 }], 4800)).status).toBe(200);
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/checkout-preview?ids=${s.id}`)).body;
    expect(preview.members.map((x: { id: number }) => x.id)).toEqual([m.id]);
    const outsider = await pay([s.id], 4800, [{ method: 'wallet', memberId: other.id, amount: 4800, expectedSplit: { principal: 4800, bonus: 0 } }]);
    expect(outsider.body.error.code).toBe('WALLET_MEMBER_NOT_IN_CHECKOUT');
    // 手牌结账的授权不能拿来结桌台
    const wrong = await authorize({ visitIds: [999999], amount: 800, reason: '抹零' });
    expect(wrong.status).toBe(200);
    expect((await pay([s.id], 4800, [{ method: 'discount', amount: 800, grantId: wrong.body.grantId }, { method: 'cash', amount: 4000 }])).body.error.code).toBe('GRANT_SCOPE');
    const g = await authorize({ tableSessionIds: [s.id], amount: 800, reason: '抹零' });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.scope).toMatchObject({ visitIds: [], tableSessionIds: [s.id], amount: 800 });
    const r = await pay([s.id], 4800, [
      { method: 'discount', amount: 800, grantId: g.body.grantId },
      { method: 'wallet', memberId: m.id, amount: 4000, expectedSplit: { principal: 4000, bonus: 0 } },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.payments.map((p: { method: string; amount: number }) => [p.method, p.amount]).sort()).toEqual([
      ['discount', 800],
      ['wallet', 4000],
    ]);
    const [k] = await ctx.sql<{ note: string }[]>`SELECT note FROM consumptions WHERE checkout_id = ${r.body.id}`;
    expect(k!.note).toContain('桌台 A1');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body.principalBalance).toBe(46000);
  });

  it('反结账：开台与账单恢复，储值退回；桌台已开给别人时拒绝，撤掉那一桌后可以反结账，再结一次', async () => {
    const list = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts?date=${today}`)).body as { id: number; tableNames: string[]; status: string }[];
    const target = list.find((c) => c.tableNames.includes('A1') && c.status === 'completed')!;
    const newcomer = (await open(table['A1']!)).body;
    expect((await voidCheckout(target.id)).body.error.code).toBe('TABLE_TAKEN');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${newcomer.id}/cancel`, { reason: '开错桌' })).status).toBe(200);
    const v = await voidCheckout(target.id);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.status).toBe('voided');
    const s = (await board()).tables.find((t) => t.name === 'A1')!.session!;
    expect(s.amount).toBe(4800);
    const member = (await api(ctx.app, ctx.clerk, 'GET', '/api/members?q=19900008801')).body[0];
    expect(member.principalBalance).toBe(50000);
    // 再结一次（现金）
    expect((await pay([s.id], 4800, [{ method: 'cash', amount: 4800 }])).status).toBe(200);
  });

  it('收款前先开班的规则对桌台结账同样生效，结账单记在班次上', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { requireOpenShift: true })).status).toBe(200);
    try {
      const s = (await open(table['A3']!)).body;
      expect((await order(s.id, [{ itemId: item['柠檬茶']!, quantity: 2 }], 3000)).status).toBe(200);
      expect((await pay([s.id], 3000, [{ method: 'cash', amount: 3000 }])).body.error.code).toBe('SHIFT_REQUIRED');
      const shift = (await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 })).body as { id: number };
      const r = await pay([s.id], 3000, [{ method: 'cash', amount: 3000 }]);
      expect(r.status).toBe(200);
      const [c] = await ctx.sql<{ shiftId: number }[]>`SELECT shift_id FROM checkouts WHERE id = ${r.body.id}`;
      expect(c!.shiftId).toBe(shift.id);
      const cur = (await api(ctx.app, ctx.clerk, 'GET', '/api/shifts/current')).body.shift;
      expect(cur.summary.cash.expected).toBe(3000);
      expect((await api(ctx.app, ctx.clerk, 'POST', `/api/shifts/${shift.id}/close`, { countedCash: 3000, expectedCash: 3000, note: '' })).status).toBe(200);
    } finally {
      expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { requireOpenShift: false })).status).toBe(200);
    }
  });
});

describe('报表与自检', () => {
  it('结账客人按人数计入桌台；门票只算手牌；日结与前台自检全部通过', async () => {
    const dash = (await api(ctx.app, ctx.owner, 'GET', '/api/dashboard')).body;
    // A2 4 人（微信）+ A1 2 人（反结账冲回后重结）+ A3 2 人
    expect(dash.todayStats.guests).toBe(4 + 2 - 2 + 2 + 2);
    expect(dash.tickets.every((t: { name: string | null }) => t.name !== null)).toBe(true);
    const exec = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/executive?from=${today}&to=${today}`)).body;
    expect(exec.kpis.guests).toBe(8);
    expect(exec.tickets.every((t: { name: string | null }) => t.name !== null)).toBe(true);
    const s = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    for (const c of s.checks) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    expect(s.anomalies.some((a: { kind: string; description: string }) => a.kind === 'line_void' && a.description.includes('宫保鸡丁'))).toBe(true);
    const fd = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; detail: string }[];
    for (const c of fd) expect(c.ok, `${c.key}：${c.detail}`).toBe(true);
  });
});
