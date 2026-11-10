// 8.0.8 前台整改 · 餐饮（docs/FRONTDESK_V808.md 第 5 节）：桌台点单下架（A05）、退菜按金额分级与当场授权（B02）、
// 餐饮台账按日期与分类筛选、导出（B06）。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let today: string;
let tagNo = 0;
const item: Record<string, number> = {};
let tableId = 0;

const enter = async () => {
  tagNo += 1;
  const code = `D${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const order = (visitId: number, lines: { itemId: number; quantity: number }[], expectedTotal: number, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines, expectedTotal });
const lineOf = async (visitId: number, name: string) =>
  ((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${visitId}`)).body.lines as { id: number; name: string; status: string }[]).find((l) => l.name === name && l.status === 'active')!;
const voidLine = (lineId: number, body: Record<string, unknown>, cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', `/api/frontdesk/lines/${lineId}/void`, body);
const rules = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', body);

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  today = (await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'D', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['鲜榨橙汁', '饮品', 2800],
    ['海鲜拼盘', '热菜', 16800],
    ['炒饭', '主食', 3800],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '厨房' });
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '厨房').id;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: Object.values(item).map((id) => ({ id, stationId })) })).status).toBe(200);
  expect((await rules({ enabled: true })).status).toBe(200);
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: '1号桌', area: '大厅', seats: 4 });
  expect(t.status, JSON.stringify(t.body)).toBeLessThan(300);
  tableId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM dining_tables WHERE name = '1号桌'`)[0]!.id);
});
afterAll(async () => ctx.close());

describe('桌台点单下架（A05）', () => {
  it('默认下架：开台、给桌台加菜都拒绝；打开后能开台，再下架时开着的这桌照常结账、退菜，不能再加菜', async () => {
    const r0 = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/dining')).body.rules;
    expect(r0).toMatchObject({ tablesEnabled: false, voidFreeCents: 5000 });
    // 菜单带上桌台开关、小额上限与「本人多少分钟内」，前台挂账（不一定有点单权限）也读得到
    const menu = await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu');
    expect(menu.status).toBe(200);
    expect(menu.body).toMatchObject({ rules: { tablesEnabled: false, voidFreeCents: 5000 }, selfVoidMinutes: 15 });
    const closed = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('TABLES_DISABLED');
    expect((await rules({ tablesEnabled: true })).status).toBe(200);
    const opened = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const sid = opened.body.id as number;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${sid}/orders`, { clientKey: randomUUID(), lines: [{ itemId: item['炒饭'], quantity: 1 }], expectedTotal: 3800 })).status).toBe(200);
    expect((await rules({ tablesEnabled: false })).status).toBe(200);
    const more = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${sid}/orders`, { clientKey: randomUUID(), lines: [{ itemId: item['炒饭'], quantity: 1 }], expectedTotal: 3800 });
    expect(more.body.error.code).toBe('TABLES_DISABLED');
    // 开着的这桌照常结账
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/checkout-preview?ids=${sid}`)).body as { totalAmount: number };
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/checkout', {
      clientKey: randomUUID(),
      sessionIds: [sid],
      expectedTotal: preview.totalAmount,
      payments: [{ method: 'cash', amount: preview.totalAmount }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  });
});

describe('退菜按金额分级（B02）', () => {
  it('小额（≤ ¥50）直接退、不受「本人 15 分钟内」限制；大额要经理或当场授权，授权绑定这一条和金额；退菜记录写明怎么批的', async () => {
    const v = await enter();
    // 店主点的单：店员不是登记人
    expect((await order(v, [{ itemId: item['鲜榨橙汁']!, quantity: 1 }, { itemId: item['海鲜拼盘']!, quantity: 1 }], 19600, ctx.owner)).status).toBe(200);
    const juice = await lineOf(v, '鲜榨橙汁');
    const seafood = await lineOf(v, '海鲜拼盘');
    // 小额：店员写原因直接退
    expect((await voidLine(juice.id, { reason: '客人点错了' })).status).toBe(200);
    // 大额：店员不能直接退，提示请经理当场授权
    const denied = await voidLine(seafood.id, { reason: '客人不要了' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('VOID_NEEDS_GRANT');
    // 小额的不用授权
    const notNeeded = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: 'duty', password: PASSWORD, purpose: 'line_void', scope: { lineId: juice.id, reason: '再退一次' } });
    expect(notNeeded.status).toBeGreaterThanOrEqual(400);
    // 值班经理当场授权：授权绑定这一条
    const g = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: 'duty', password: PASSWORD, purpose: 'line_void', scope: { lineId: seafood.id, reason: '客人不要了' } });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.scope).toMatchObject({ lineId: seafood.id, amount: 16800, name: '海鲜拼盘', reason: '客人不要了' });
    // 拿去退别的明细不行
    const v2 = await enter();
    expect((await order(v2, [{ itemId: item['海鲜拼盘']!, quantity: 1 }], 16800, ctx.owner)).status).toBe(200);
    const other = await lineOf(v2, '海鲜拼盘');
    expect((await voidLine(other.id, { reason: '客人不要了', grantId: g.body.grantId })).body.error.code).toBe('GRANT_SCOPE');
    expect((await voidLine(seafood.id, { reason: '客人不要了', grantId: g.body.grantId })).status).toBe(200);
    // 授权只能用一次
    expect((await voidLine(other.id, { reason: '客人不要了', grantId: g.body.grantId })).body.error.code).toMatch(/GRANT_/);
    // 经理自己退大额的直接退
    expect((await voidLine(other.id, { reason: '经理处理' }, duty)).status).toBe(200);

    const log = (await api(ctx.app, ctx.owner, 'GET', `/api/dining/voids?from=${today}&to=${today}`)).body as { name: string; approvalText: string; voidReason: string }[];
    const byName = (n: string, reason: string) => log.find((x) => x.name === n && x.voidReason === reason)!.approvalText;
    expect(byName('鲜榨橙汁', '客人点错了')).toBe('小额直接退');
    expect(byName('海鲜拼盘', '客人不要了')).toBe('当场授权（值班经理）');
    expect(byName('海鲜拼盘', '经理处理')).toBe('经理');
    // 退菜记录导出：一条一行，最后一行合计
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/dining/voids/export?from=${today}&to=${today}`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    const rows = csv.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(rows.length).toBe(log.length + 2);
    expect(rows.some((r) => r.includes('当场授权（值班经理）'))).toBe(true);
    expect(rows.at(-1)!.startsWith('合计')).toBe(true);
  });

  it('上限可改：设成 0 不分级（照旧本人 15 分钟内或经理）', async () => {
    expect((await rules({ voidFreeCents: 0 })).status).toBe(200);
    const v = await enter();
    expect((await order(v, [{ itemId: item['鲜榨橙汁']!, quantity: 1 }], 2800, ctx.owner)).status).toBe(200);
    const juice = await lineOf(v, '鲜榨橙汁');
    expect((await voidLine(juice.id, { reason: '客人点错了' })).body.error.code).toBe('VOID_NEEDS_GRANT');
    // 自己点的 15 分钟内照旧能退
    expect((await order(v, [{ itemId: item['炒饭']!, quantity: 1 }], 3800)).status).toBe(200);
    expect((await voidLine((await lineOf(v, '炒饭')).id, { reason: '点错了' })).status).toBe(200);
    expect((await rules({ voidFreeCents: 5000 })).status).toBe(200);
  });
});

describe('餐饮台账（B06）', () => {
  it('按起止日期、分类、状态筛选；合计与逐行一致；导出只含所选范围、最后一行是合计', async () => {
    const all = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/ledger?from=${today}&to=${today}`)).body as {
      categories: string[];
      rows: { category: string; status: string; amount: number; quantity: number }[];
      totals: { lines: number; quantity: number; amount: number; voidedLines: number; voidedAmount: number };
    };
    expect(all.categories).toEqual(expect.arrayContaining(['饮品', '热菜', '主食']));
    const active = all.rows.filter((r) => r.status === 'active');
    expect(all.totals.amount).toBe(active.reduce((n, r) => n + r.amount, 0));
    expect(all.totals.voidedLines).toBe(all.rows.filter((r) => r.status === 'voided').length);
    const drinks = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/ledger?from=${today}&to=${today}&categories=${encodeURIComponent('饮品')}`)).body as typeof all;
    expect(drinks.rows.length).toBeGreaterThan(0);
    expect(drinks.rows.every((r) => r.category === '饮品')).toBe(true);
    const onlyActive = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/ledger?from=${today}&to=${today}&status=active`)).body as typeof all;
    expect(onlyActive.rows.every((r) => r.status === 'active')).toBe(true);
    // 导出
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/dining/ledger/export?from=${today}&to=${today}&categories=${encodeURIComponent('饮品')}`, headers: { cookie: ctx.clerk } });
    expect(csv.statusCode).toBe(200);
    const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines.length).toBe(drinks.rows.length + 2);
    expect(lines.at(-1)!.startsWith('合计')).toBe(true);
    expect(lines.at(-1)).toContain((drinks.totals.amount / 100).toFixed(2));
    // 超过 92 天拒绝
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/dining/ledger?from=2026-01-01&to=2026-06-30`)).status).toBe(400);
  });
});
