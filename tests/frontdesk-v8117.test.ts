// 8.1.17 前台（docs/FRONTDESK_V8117.md）：
//   · BW-12「流水」的订单详情：与结账单同一个部件——接口带上「优惠与赠送」与经办人、每一行的「赠」「券」「折」、所属部门与摊到的优惠；
//     「流水」的权限照旧（查看当日流水、历史营业日）；
//   · BW-1 超时加收按小时先填好（前台规则「每超 1 小时 ¥X」），到 12 / 24 / 72 小时每分钟的任务在「异常待办」里记「超时提醒」（经办人「系统」）。
// 退菜按出品口在 tests/dining-voids-v8117.test.ts，桌台提醒在 tests/tables-reminders-v8117.test.ts，本店价在 tests/store-prices-v8117.test.ts。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutPreview } from '../src/shared/checkout';
import type { FrontdeskBoard, VisitDetail } from '../src/shared/frontdesk';
import { isOpenTodo, type IncidentTodoList } from '../src/shared/frontdesk-risk';
import { overtimeSurchargeOf } from '../src/shared/frontdesk-v8117';
import type { CheckoutOrderDetail } from '../src/shared/orders';
import { sweepOvertimeReminders } from '../src/server/modules/frontdesk/overtime';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;
let footId = 0;
let rubId = 0;

/** 接待一位客人、挂几个项目，返回来访 id 与牌号 */
const enter = async (memberId: number | null, items: { id: number; price: number }[]) => {
  tagNo += 1;
  const code = `F${String(tagNo).padStart(3, '0')}`;
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male', memberId }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.visits[0].id as number;
  if (items.length > 0) {
    const p = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${id}/charges`, {
      clientKey: randomUUID(),
      lines: items.map((i) => ({ itemId: i.id, quantity: 1 })),
      expectedTotal: items.reduce((s, i) => s + i.price, 0),
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  }
  return { id, code };
};

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'F', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
  const a = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '流水足疗', category: '流水足疗部', price: 12800 });
  footId = a.body.items.find((i: { name: string }) => i.name === '流水足疗').id;
  const b = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '流水搓澡', category: '流水洗浴部', price: 6800 });
  rubId = b.body.items.find((i: { name: string }) => i.name === '流水搓澡').id;
});
afterAll(async () => {
  await ctx?.close();
});

describe('BW-12「流水」的订单详情与结账单同一写法', () => {
  let checkoutId = 0;

  it('接口带「优惠与赠送」与经办人；抵到的行标「券」，每一行有所属部门与摊到的优惠，合起来等于这笔优惠', async () => {
    const tpl = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '流水代金券', kind: 'cash', faceValue: 3000, validity: 'days', validDays: 30 });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    const m = await createMember(ctx, '流水会员甲');
    const sent = await api(ctx.app, ctx.owner, 'POST', `/api/members/${m.id}/coupons`, { clientKey: randomUUID(), templateId: tpl.body.id, quantity: 1, reason: '投诉补偿' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const v = await enter(m.id, [
      { id: footId, price: 12800 },
      { id: rubId, price: 6800 },
    ]);
    const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v.id}`)).body as CheckoutPreview;
    const opt = pre.storeCoupons!.find((c) => c.templateName === '流水代金券')!;
    const done = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v.id],
      expectedTotal: pre.totalAmount,
      payments: [
        { method: 'store_coupon', code: opt.code, amount: 3000 },
        { method: 'cash', amount: pre.totalAmount - 3000 },
      ],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    checkoutId = done.body.id;

    const r = await api<CheckoutOrderDetail>(ctx.app, ctx.clerk, 'GET', `/api/ledger/orders/checkouts/${checkoutId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { doc, source } = r.body;
    expect(source).toBe('lines');
    // 结账单部件要的：收银、「优惠与赠送」（名称、事由、经办人）
    expect(doc.operatorName).toBe('测试店员');
    expect(doc.perks).toEqual([expect.objectContaining({ kind: 'coupon', name: '流水代金券', amount: 3000, detail: '投诉补偿', operators: [{ role: '发券', name: '测试店主' }] })]);
    const perk = doc.perks[0]!;
    const lines = doc.bills.flatMap((b) => b.lines);
    expect(
      lines
        .filter((l) => l.category !== '门票')
        .map((l) => l.name)
        .sort(),
    ).toEqual(['流水搓澡', '流水足疗']);
    // 行上的标记：券抵到的行标「券」，别的行不标
    for (const l of lines) expect(l.perks).toEqual(perk.lineIds.includes(l.id) ? ['coupon'] : []);
    expect(lines.some((l) => l.perks.includes('coupon'))).toBe(true);
    // 所属部门、摊到这一行的优惠（与「流水」原来的逐行一致，合起来等于这笔券）
    expect(Object.fromEntries(lines.filter((l) => l.category !== '门票').map((l) => [l.name, l.category]))).toEqual({ 流水足疗: '流水足疗部', 流水搓澡: '流水洗浴部' });
    expect(lines.filter((l) => l.category === '门票')).toHaveLength(1);
    expect(lines.reduce((s, l) => s + (l.discount ?? 0), 0)).toBe(3000);
    expect(r.body.discount).toBe(3000);
  });

  it('「流水」的权限照旧：没有「查看当日流水」的岗位看不到；打印的那一份不带「流水」才有的两项', async () => {
    await createStaff(ctx.sql, { username: 'fkitchen', displayName: '后厨甲', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
    const kitchen = await login(ctx.app, 'fkitchen');
    expect((await api(ctx.app, kitchen, 'GET', `/api/ledger/orders/checkouts/${checkoutId}`)).status).toBe(403);
    const p = await api(ctx.app, ctx.clerk, 'GET', `/api/print/checkouts/${checkoutId}`);
    expect(p.status).toBe(200);
    for (const l of p.body.bills.flatMap((b: { lines: Record<string, unknown>[] }) => b.lines)) {
      expect(l).not.toHaveProperty('category');
      expect(l).not.toHaveProperty('discount');
    }
  });
});

describe('BW-1 超时加收按小时先填好', () => {
  it('不足 1 小时按 1 小时（超 1 分钟算 1 小时）× 每小时的价；没设价、没超过 12 小时不填；一笔最多 ¥10,000', () => {
    expect(overtimeSurchargeOf(12 * 60, 2000)).toBeNull();
    expect(overtimeSurchargeOf(12 * 60 + 1, 2000)).toEqual({ hours: 1, amount: 2000, capped: false });
    expect(overtimeSurchargeOf(13 * 60, 2000)).toEqual({ hours: 1, amount: 2000, capped: false });
    expect(overtimeSurchargeOf(13 * 60 + 1, 2000)).toEqual({ hours: 2, amount: 4000, capped: false });
    expect(overtimeSurchargeOf(30 * 60, 0)).toBeNull();
    expect(overtimeSurchargeOf(100 * 60, 50_000)).toEqual({ hours: 88, amount: 1_000_000, capped: true });
  });

  it('后台「前台规则」设每小时的价（默认 0 = 不算价）：只有店主能改，范围核对；看板带给客人卡', async () => {
    const get = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/rules')).body as { overtimeSurchargeHourlyCents: number };
    expect((await get()).overtimeSurchargeHourlyCents).toBe(0);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/frontdesk/rules', { overtimeSurchargeHourlyCents: 2000 })).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { overtimeSurchargeHourlyCents: -1 })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { overtimeSurchargeHourlyCents: 100_001 })).status).toBe(400);
    const ok = await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { overtimeSurchargeHourlyCents: 2000 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ overtimeSurchargeHourlyCents: 2000, selfVoidMinutes: 15 });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body.rules.overtimeSurchargeHourlyCents).toBe(2000);
  });
});

describe('BW-1 超时提醒：12 / 24 / 72 小时进「异常待办」', () => {
  const at = (hours: number) => new Date(Date.now() + hours * 3_600_000);
  const sweep = (hours: number) => sweepOvertimeReminders({ sql: ctx.sql, config: ctx.config }, at(hours));
  const todos = async () => (await api<IncidentTodoList>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/incidents/todos')).body.todos;
  const incidentsOf = async (visitId: number) => (await api<VisitDetail>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${visitId}`)).body.incidents;
  let first = { id: 0, code: '' };
  let second = { id: 0, code: '' };

  it('到 12 小时记一条「超时提醒」，经办人写「系统」；再跑、几个进程同时跑都只记一次', async () => {
    // 只数这两位的（别的用例留下的在店客人也会被记，所以总数用「至少」）
    first = await enter(null, []);
    second = await enter(null, []);
    expect(await sweep(11.9)).toBe(0);
    const counted = await sweep(12.5);
    expect(counted).toBeGreaterThanOrEqual(2);
    const mine = (await todos()).filter((t) => t.visitId === first.id || t.visitId === second.id);
    expect(mine.map((t) => [t.tagCode, t.kind, t.overtimeHours, t.createdByName])).toEqual([
      [first.code, 'overtime', 12, '系统'],
      [second.code, 'overtime', 12, '系统'],
    ]);
    expect(mine[0]!.note).toContain('12 小时');
    expect(await sweep(12.5)).toBe(0);
    const both = await Promise.all([sweep(12.6), sweep(12.6)]);
    expect(both).toEqual([0, 0]);
    const [rows] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM visit_incidents WHERE visit_id = ${first.id} AND kind = 'overtime'`;
    expect(rows!.n).toBe(1);
    // 系统账号：不能登录、不在员工名单里
    const [sys] = await ctx.sql<{ active: boolean; system: boolean; displayName: string }[]>`SELECT active, system, display_name FROM staff WHERE username = 'system.auto'`;
    expect(sys).toEqual({ active: false, system: true, displayName: '系统' });
    // 手牌板与发卡台顶上的待办数都算上
    const board = (await api<FrontdeskBoard>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
    expect(board.tags.find((t) => t.code === first.code)!.visit!.openTodos).toBe(1);
    expect(board.risk.openTodos).toBeGreaterThanOrEqual(2);
    // 审计里是「系统」记的
    const [audit] = await ctx.sql<{ name: string; detail: Record<string, unknown> }[]>`
      SELECT s.display_name AS name, a.detail FROM audit_logs a JOIN staff s ON s.id = a.staff_id
      WHERE a.action = 'visit_incident' AND a.target_id = ${String(first.id)} AND a.detail ->> 'kind' = 'overtime'`;
    expect(audit).toMatchObject({ name: '系统', detail: { hours: 12, auto: true } });
  });

  it('跨到 24 小时：两个进程同时跑只记一条，12 小时那条被盖过、不再算待办；停机后一下子到 72 小时只记 72 小时那一级', async () => {
    const runs = await Promise.all([sweep(24.5), sweep(24.5)]);
    expect(runs.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);
    const list = await ctx.sql<{ visitId: number; hours: number }[]>`
      SELECT visit_id, overtime_hours AS hours FROM visit_incidents WHERE kind = 'overtime' AND visit_id IN ${ctx.sql([first.id, second.id])} ORDER BY visit_id, overtime_hours`;
    expect(list.map((r) => [Number(r.visitId), r.hours])).toEqual([
      [first.id, 12],
      [first.id, 24],
      [second.id, 12],
      [second.id, 24],
    ]);
    const mine = (await todos()).filter((t) => t.visitId === first.id);
    expect(mine.map((t) => t.overtimeHours)).toEqual([24]);
    const inc = await incidentsOf(first.id);
    expect(inc.filter((i) => i.kind === 'overtime').map((i) => [i.overtimeHours, isOpenTodo(i, inc, true)])).toEqual([
      [12, false],
      [24, true],
    ]);
    // 一下子到 100 小时：只记 72 小时这一级
    expect(await sweep(100)).toBeGreaterThanOrEqual(2);
    const levels = await ctx.sql<{ hours: number }[]>`SELECT overtime_hours AS hours FROM visit_incidents WHERE kind = 'overtime' AND visit_id = ${first.id} ORDER BY id`;
    expect(levels.map((l) => l.hours)).toEqual([12, 24, 72]);
  });

  it('超时提醒能指派、写处理结果（只写一次）；客人离店以后自动不算待办；页面上不能自己登记这一种', async () => {
    const t72 = (await todos()).find((t) => t.visitId === first.id)!;
    expect(t72.overtimeHours).toBe(72);
    const assigned = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/incidents/${t72.id}/assign`, { assigneeId: ctx.clerkId });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const resolved = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/incidents/${t72.id}/resolve`, { note: '客人续住，已提醒结账时间' });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/incidents/${t72.id}/resolve`, { note: '再写一次' })).status).toBe(409);
    expect((await todos()).some((t) => t.visitId === first.id)).toBe(false);
    // 第二位结账离店：他的超时提醒不再算待办
    expect((await todos()).some((t) => t.visitId === second.id)).toBe(true);
    const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${second.id}`)).body as CheckoutPreview;
    const done = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [second.id],
      expectedTotal: pre.totalAmount,
      payments: pre.totalAmount > 0 ? [{ method: 'cash', amount: pre.totalAmount }] : [],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await todos()).some((t) => t.visitId === second.id)).toBe(false);
    // 页面上不能登记「超时提醒」
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${first.id}/incidents`, { clientKey: randomUUID(), kind: 'overtime', note: '自己记' });
    expect(r.status).toBe(400);
    // 前台自检照旧全部通过
    expect(((await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean }[]).filter((c) => !c.ok)).toEqual([]);
  });
});
