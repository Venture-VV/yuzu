// S5 餐饮第一步：出品档口、点单（挂在手牌账单上）、厨房出品屏（KDS）与估清。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diningGuest, diningGuestOf } from '../src/server/modules/dining';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let duty: string;
let cook: string;
let am: string;
let tagNo = 0;
const item: Record<string, number> = {};
const station: Record<string, number> = {};

const enter = async () => {
  tagNo += 1;
  const code = `K${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.visits[0].id as number, code };
};
const order = (visitId: number, lines: { itemId: number; quantity: number; note?: string }[], expectedTotal: number, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/dining/orders', { clientKey, visitId, lines, expectedTotal });
const board = async (cookie = cook) => (await api(ctx.app, cookie, 'GET', '/api/kitchen')).body;
type KItem = { id: number; orderNo: string; visitId: number; name: string; quantity: number; note: string; status: string; rushCount: number; visitClosed: boolean };
const itemsOf = async (visitId: number) => ((await board()).items as KItem[]).filter((k) => k.visitId === visitId);
const act = (id: number, action: string, cookie = cook, from?: string) => api(ctx.app, cookie, 'POST', `/api/kitchen/items/${id}/${action}`, from ? { from } : undefined);
const limit = (itemId: number, remaining: number | null, cookie = cook) => api(ctx.app, cookie, 'PUT', `/api/kitchen/limits/${itemId}`, { remaining });
const rules = (body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', '/api/admin/dining/rules', body);
const remainingOf = async (itemId: number) => ((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body.dishes as { id: number; remaining: number | null }[]).find((d) => d.id === itemId)?.remaining;

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
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['宫保鸡丁', '热菜', 4800],
    ['拍黄瓜', '凉菜', 1800],
    ['柠檬茶', '水吧', 1500],
    ['一次性拖鞋', '洗浴用品', 500],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
});
afterAll(async () => ctx.close());

describe('餐饮功能关闭（默认）', () => {
  it('前台照常挂账，记在「门票与洗浴项目」，不进厨房；点单页与口味备注都不可用', async () => {
    const v = await enter();
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/charges`, { clientKey: randomUUID(), lines: [{ itemId: item['宫保鸡丁'], quantity: 1 }], expectedTotal: 4800 });
    expect(r.status).toBe(200);
    expect(r.body.lines.at(-1)).toMatchObject({ source: 'bath', kitchen: null });
    expect((await order(v.id, [{ itemId: item['宫保鸡丁']!, quantity: 1 }], 4800)).body.error.code).toBe('DISH_NOT_KITCHEN');
    const noted = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/charges`, { clientKey: randomUUID(), lines: [{ itemId: item['宫保鸡丁'], quantity: 1, note: '少辣' }], expectedTotal: 4800 });
    expect(noted.body.error.code).toBe('DISH_NOTE_NOT_ALLOWED');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.dining).toBe(false);
  });
});

describe('后台「餐饮」', () => {
  it('档口与菜品的档口由能管理价目的岗位维护；规则只有店主能改；规则总表有餐饮一组', async () => {
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/dining/stations', { name: '热菜' })).status).toBe(403);
    for (const name of ['热菜', '凉菜', '水吧']) {
      const r = await api(ctx.app, boss, 'POST', '/api/admin/dining/stations', { name });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
    }
    expect((await api(ctx.app, boss, 'POST', '/api/admin/dining/stations', { name: ' 热菜 ' })).body.error.code).toBe('STATION_NAME_TAKEN');
    const mapped = await api(ctx.app, boss, 'PUT', '/api/admin/dining/items', {
      items: [
        { id: item['宫保鸡丁'], stationId: station['热菜'] },
        { id: item['拍黄瓜'], stationId: station['凉菜'] },
        { id: item['柠檬茶'], stationId: station['水吧'] },
      ],
    });
    expect(mapped.status).toBe(200);
    expect(mapped.body.stations.find((s: { name: string }) => s.name === '热菜').itemCount).toBe(1);
    // 需要技师的项目不进厨房：不能挂到档口
    const foot = (await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '足疗', category: '按摩', price: 12800 })).body.items.find((i: { name: string }) => i.name === '足疗').id;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/items', { items: [{ id: foot, required: true }] })).status).toBe(200);
    const tech = await api(ctx.app, boss, 'PUT', '/api/admin/dining/items', { items: [{ id: foot, stationId: station['热菜'] }] });
    expect(tech.body.error.code).toBe('ITEM_NEEDS_TECHNICIAN');
    expect(mapped.body.items.find((i: { name: string }) => i.name === '宫保鸡丁')).toMatchObject({ stationId: station['热菜'], technicianRequired: false });
    expect((await rules({ enabled: true }, boss)).status).toBe(403);
    expect((await rules({ enabled: true })).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.dining).toBe(true);
    const catalog = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as { key: string; group: string }[];
    expect(catalog.filter((r) => r.group === 'dining').map((r) => r.key)).toEqual(['dining_rules.enabled', 'dining_rules.trackServed', 'dining_rules.warnMinutes', 'mp_food_max_quantity', 'mp_food_max_total_cents']); // 8.0.7：扫码点餐的上限（N1）可调
  });
});

describe('点单与厨房出品', () => {
  it('点单挂到客人的账单（记在餐饮），同一次下单一张出品单，口味备注进厨房；不进厨房的菜只能到前台登记', async () => {
    const v = await enter();
    const r = await order(v.id, [{ itemId: item['宫保鸡丁']!, quantity: 2, note: '少辣' }, { itemId: item['柠檬茶']!, quantity: 1 }], 4800 * 2 + 1500);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pending.map((p: { name: string; quantity: number; note: string; status: string; rushCount: number }) => [p.name, p.quantity, p.note, p.status, p.rushCount])).toEqual([
      ['宫保鸡丁', 2, '少辣', 'queued', 0],
      ['柠檬茶', 1, '', 'queued', 0],
    ]);
    expect(r.body.pending.every((p: { billLineId: number }) => Number.isInteger(p.billLineId))).toBe(true);
    const ks = await itemsOf(v.id);
    expect(ks.map((k) => [k.name, k.quantity, k.note, k.status])).toEqual([
      ['宫保鸡丁', 2, '少辣', 'queued'],
      ['柠檬茶', 1, '', 'queued'],
    ]);
    expect(new Set(ks.map((k) => k.orderNo)).size).toBe(1);
    const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v.id}`)).body;
    expect(detail.lines.map((l: { source: string; kitchen: { status: string; note: string } | null }) => [l.source, l.kitchen?.status, l.kitchen?.note])).toEqual([
      ['dining', 'queued', '少辣'],
      ['dining', 'queued', ''],
    ]);
    const bad = await order(v.id, [{ itemId: item['一次性拖鞋']!, quantity: 1 }], 500);
    expect(bad.body.error.code).toBe('DISH_NOT_KITCHEN');
    // 前台加项目点了进厨房的菜，同样进厨房
    const fd = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/charges`, { clientKey: randomUUID(), lines: [{ itemId: item['拍黄瓜'], quantity: 1 }], expectedTotal: 1800 });
    expect(fd.status).toBe(200);
    expect((await itemsOf(v.id)).map((k) => k.name)).toContain('拍黄瓜');
  });

  it('同一操作编号重提不重复下单；同一编号改了口味备注按不同请求拒绝', async () => {
    const v = await enter();
    const key = randomUUID();
    const lines = [{ itemId: item['拍黄瓜']!, quantity: 1, note: '多放蒜' }];
    expect((await order(v.id, lines, 1800, ctx.clerk, key)).status).toBe(200);
    expect((await order(v.id, lines, 1800, ctx.clerk, key)).status).toBe(200);
    expect(await itemsOf(v.id)).toHaveLength(1);
    expect((await order(v.id, [{ ...lines[0]!, note: '不要蒜' }], 1800, ctx.clerk, key)).status).toBe(409);
  });

  it('厨房：开始做 → 出餐 → 上菜，可以撤回一步；催单记次数；服务员只能上菜，客户经理看不到厨房', async () => {
    const v = await enter();
    await order(v.id, [{ itemId: item['宫保鸡丁']!, quantity: 1 }], 4800);
    const [k] = await itemsOf(v.id);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/items/${k!.id}/rush`)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/items/${k!.id}/rush`)).status).toBe(200);
    expect((await itemsOf(v.id))[0]!.rushCount).toBe(2);
    expect((await act(k!.id, 'start')).status).toBe(200);
    expect((await act(k!.id, 'undo')).status).toBe(200);
    expect((await itemsOf(v.id))[0]!.status).toBe('queued');
    expect((await act(k!.id, 'start')).status).toBe(200);
    expect((await act(k!.id, 'start')).body.error.code).toBe('DISH_CHANGED');
    expect((await act(k!.id, 'done')).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/items/${k!.id}/rush`)).body.error.code).toBe('DISH_CHANGED');
    expect((await act(k!.id, 'serve')).status).toBe(200);
    expect((await itemsOf(v.id))[0]!.status).toBe('served');
    // 后勤（厨房）不能点单；客户经理看不到厨房、不能点单
    expect((await order(v.id, [{ itemId: item['宫保鸡丁']!, quantity: 1 }], 4800, cook)).status).toBe(403);
    expect((await api(ctx.app, am, 'GET', '/api/kitchen')).status).toBe(403);
    expect((await order(v.id, [{ itemId: item['宫保鸡丁']!, quantity: 1 }], 4800, am)).status).toBe(403);
    // 数据库兜底：出品单的菜品与数量不能改，状态不能乱跳，不能删
    await expect(ctx.sql`UPDATE kitchen_items SET quantity = 5 WHERE id = ${k!.id}`).rejects.toThrow('不可修改');
    await expect(ctx.sql`UPDATE kitchen_items SET status = 'queued', done_at = NULL, served_at = NULL WHERE id = ${k!.id}`).rejects.toThrow('出品状态不能');
    await expect(ctx.sql`DELETE FROM kitchen_items WHERE id = ${k!.id}`).rejects.toThrow('禁止删除');
  });

  it('连点两下「撤回」只退一步；只有点单权限的岗位只能上菜与撤回上菜（在锁内判断）', async () => {
    const v = await enter();
    await order(v.id, [{ itemId: item['柠檬茶']!, quantity: 1 }, { itemId: item['拍黄瓜']!, quantity: 1 }], 3300);
    const [a, b] = await itemsOf(v.id);
    // 没开始做就出餐：撤回回到待做；第二下带着旧状态（已出餐）被拒绝
    expect((await act(a!.id, 'done', cook, 'queued')).status).toBe(200);
    expect((await act(a!.id, 'undo', cook, 'done')).status).toBe(200);
    expect((await act(a!.id, 'undo', cook, 'done')).body.error.code).toBe('DISH_CHANGED');
    expect((await itemsOf(v.id)).find((k) => k.id === a!.id)!.status).toBe('queued');
    // 值班经理去掉「厨房出品屏」权限后只能上菜
    const before = ((await api(ctx.app, ctx.owner, 'GET', '/api/admin/permissions')).body.effective.duty_manager as string[]);
    const setDuty = (list: string[]) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/permissions', { roles: { duty_manager: list } });
    expect((await setDuty(before.filter((p) => p !== 'dining.kitchen'))).status).toBe(200);
    try {
      expect((await act(b!.id, 'start', duty)).body.error.code).toBe('KITCHEN_ONLY');
      expect((await act(b!.id, 'done', cook)).status).toBe(200);
      expect((await act(b!.id, 'undo', duty)).body.error.code).toBe('KITCHEN_ONLY');
      expect((await act(b!.id, 'serve', duty, 'done')).status).toBe(200);
      expect((await act(b!.id, 'undo', duty, 'served')).status).toBe(200);
      expect((await act(b!.id, 'undo', duty, 'done')).body.error.code).toBe('KITCHEN_ONLY');
      expect((await itemsOf(v.id)).find((k) => k.id === b!.id)!.status).toBe('done');
      expect((await api(ctx.app, duty, 'PUT', `/api/kitchen/limits/${item['拍黄瓜']}`, { remaining: 3 })).status).toBe(403);
    } finally {
      expect((await setDuty(before)).status).toBe(200);
    }
  });

  it('规则「出餐即算上菜」：出餐直接记为已上菜', async () => {
    expect((await rules({ trackServed: false })).status).toBe(200);
    try {
      const v = await enter();
      await order(v.id, [{ itemId: item['柠檬茶']!, quantity: 1 }], 1500);
      const [k] = await itemsOf(v.id);
      expect((await act(k!.id, 'done')).status).toBe(200);
      expect((await itemsOf(v.id))[0]!.status).toBe('served');
    } finally {
      expect((await rules({ trackServed: true })).status).toBe(200);
    }
  });
});

describe('估清与退菜', () => {
  it('限量份数下单时扣减，不够整笔拒绝；退菜按原份数加回；估清后不能点；取消估清不限量；只有厨房的岗位能设', async () => {
    const dish = item['宫保鸡丁']!;
    expect((await limit(dish, 3, ctx.clerk)).status).toBe(200); // 店员默认也能在厨房屏上设
    expect((await limit(dish, 3, am)).status).toBe(403);
    expect((await limit(item['一次性拖鞋']!, 0)).body.error.code).toBe('DISH_NOT_KITCHEN');
    const v = await enter();
    expect((await order(v.id, [{ itemId: dish, quantity: 2 }], 9600)).status).toBe(200);
    expect(await remainingOf(dish)).toBe(1);
    const over = await order(v.id, [{ itemId: dish, quantity: 2 }], 9600);
    expect(over.body.error.code).toBe('DISH_SOLD_OUT');
    expect(over.body.error.message).toContain('只剩 1 份');
    // 退菜（作废这条明细）：出品单已退，份数加回
    const line = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v.id}`)).body.lines.find((l: { itemId: number; status: string }) => l.itemId === dish && l.status === 'active');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line.id}/void`, { reason: '客人不要了' })).status).toBe(200);
    expect(await remainingOf(dish)).toBe(3);
    const cancelled = ((await board()).items as KItem[]).find((k) => k.visitId === v.id && k.name === '宫保鸡丁');
    expect(cancelled!.status).toBe('cancelled');
    // 估清：0 份不能点；取消估清后不限量
    expect((await limit(dish, 0)).status).toBe(200);
    expect((await order(v.id, [{ itemId: dish, quantity: 1 }], 4800)).body.error.message).toContain('已估清');
    expect((await limit(dish, null)).status).toBe(200);
    expect(await remainingOf(dish)).toBeNull();
    expect((await order(v.id, [{ itemId: dish, quantity: 5 }], 24000)).status).toBe(200);
  });

  it('最后一份两台同时点：只有一台成功', async () => {
    const dish = item['拍黄瓜']!;
    expect((await limit(dish, 1)).status).toBe(200);
    const [a, b] = [await enter(), await enter()];
    const results = await Promise.all([order(a.id, [{ itemId: dish, quantity: 1 }], 1800), order(b.id, [{ itemId: dish, quantity: 1 }], 1800, duty)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await remainingOf(dish)).toBe(0);
    expect((await limit(dish, null)).status).toBe(200);
  });
});

describe('结账与补录', () => {
  it('结账核对列出还没上的菜（只提醒）；结账后厨房屏标出客人已离店', async () => {
    const v = await enter();
    await order(v.id, [{ itemId: item['柠檬茶']!, quantity: 1 }], 1500);
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v.id}`)).body;
    expect(preview.dishes).toEqual([{ tagCode: v.code, name: '柠檬茶', quantity: 1, status: 'queued' }]);
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v.id],
      expectedTotal: preview.totalAmount,
      payments: [{ method: 'cash', amount: preview.totalAmount }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect((await itemsOf(v.id))[0]).toMatchObject({ status: 'queued', visitClosed: true });
    // 下单的回复按来访取：客人在下单与回复之间结账离店，已生效的点单不会被说成「没有在店客人」（Codex 审查 PR #18）
    expect(await diningGuestOf(ctx.sql, v.id)).toMatchObject({ visitId: v.id, tagCode: v.code, pending: [expect.objectContaining({ name: '柠檬茶', status: 'queued' })] });
    await expect(diningGuest(ctx.sql, v.code)).rejects.toMatchObject({ status: 404 });
  });

  it('按纸质单补录的菜早已上过：出品单直接记为已上菜，不扣估清', async () => {
    const dish = item['柠檬茶']!;
    expect((await limit(dish, 5)).status).toBe(200);
    // 纸质单：2 小时前接待、半小时前点了两杯柠檬茶
    tagNo += 1;
    const code = `K${String(tagNo).padStart(3, '0')}`;
    const inAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const checkin = await api(ctx.app, duty, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }], backfill: { slipNo: 'P-0901', at: inAt } });
    expect(checkin.status, JSON.stringify(checkin.body)).toBe(201);
    const v = { id: checkin.body.visits[0].id as number };
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await api(ctx.app, duty, 'POST', `/api/frontdesk/visits/${v.id}/charges`, {
      clientKey: randomUUID(),
      lines: [{ itemId: dish, quantity: 2 }],
      expectedTotal: 3000,
      backfill: { slipNo: 'P-0901', at },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [k] = await ctx.sql<{ status: string; limitTaken: boolean }[]>`SELECT status, limit_taken FROM kitchen_items WHERE visit_id = ${v.id}`;
    expect(k).toEqual({ status: 'served', limitTaken: false });
    expect(await remainingOf(dish)).toBe(5);
    expect((await limit(dish, null)).status).toBe(200);
    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string }[];
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});

describe('自检', () => {
  it('点单、退菜、补录、结账之后：出品单与餐饮明细一致', async () => {
    const fd = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; detail: string }[];
    const k = fd.find((c) => c.key === 'kitchen_items')!;
    expect(k.ok, k.detail).toBe(true);
    expect(k.detail).toMatch(/出品单 \d+ 道/);
    for (const c of fd) expect(c.ok, `${c.key}：${c.detail}`).toBe(true);
  });
});
