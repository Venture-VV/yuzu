// 8.1.7 餐饮分区与点菜单（docs/DINING_V817.md，PENDING_DECISIONS.md CF1–CF9）：
//   · 点单分类（餐厅 / 水吧 / 果吧 与小分类）的默认归类、编码与筛选（纯函数）；
//   · 后台给菜设点单分类（与出品档口同一个接口）、点单页菜单带分类；
//   · 餐饮台账、退菜记录按点单分类筛，导出多一列「价目分类」；
//   · 点菜单（小票可视化）：一桌 / 一位手牌客人点过的菜，按每次下单分段，每道菜已上 / 未上 / 制作中 / 已出餐 / 已退。
// 全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_DINING_SLOTS,
  diningSlotOf,
  isValidSlot,
  parseSlotKey,
  receiptLineState,
  slotKey,
  slotLabel,
  slotMatches,
  slotOrder,
  type DiningLedger,
  type DiningReceipt,
  type DishVoidRow,
  type MenuDish,
} from '../src/shared/dining';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

describe('点单分类：默认归类、编码与筛选（纯函数）', () => {
  const def = (category: string | null, stationName: string | null = null) => {
    const { assigned, ...s } = diningSlotOf({ outlet: null, group: null, category, stationName });
    expect(assigned).toBe(false);
    return slotLabel(s);
  };

  it('后台设过的照设的；存的小分类配不上（以后改了名单）归到这一处的第一个', () => {
    expect(diningSlotOf({ outlet: 'water', group: '糖水', category: '热菜', stationName: '热菜' })).toEqual({ outlet: 'water', group: '糖水', assigned: true });
    expect(diningSlotOf({ outlet: 'fruit', group: '', category: '酒水', stationName: null })).toEqual({ outlet: 'fruit', group: '', assigned: true });
    expect(diningSlotOf({ outlet: 'water', group: '奶茶', category: null, stationName: null })).toEqual({ outlet: 'water', group: '手作饮料', assigned: true });
    expect(diningSlotOf({ outlet: 'fruit', group: '鲜果', category: null, stationName: null })).toEqual({ outlet: 'fruit', group: '', assigned: true });
    // 库里不认识的入口按没设算
    expect(diningSlotOf({ outlet: 'bar', group: '', category: '酒水', stationName: null })).toMatchObject({ outlet: 'restaurant', group: '酒水', assigned: false });
  });

  it('没设的按 CF3 从上往下：价目分类正好是小分类名（餐饮不算）→ 带果吧 / 调酒 / 糖水 / 酒 → 档口名 → 饮品饮料 → 餐厅 · 餐饮', () => {
    // ① 正好是小分类的名字
    expect(def('酒水')).toBe('餐厅 · 酒水');
    expect(def('手作饮料', '热菜')).toBe('水吧 · 手作饮料');
    expect(def('糖水')).toBe('水吧 · 糖水');
    expect(def('调酒')).toBe('水吧 · 调酒');
    // 「餐饮」是统称：往下看档口
    expect(def('餐饮', '水吧')).toBe('水吧 · 手作饮料');
    expect(def('餐饮', '演示果吧')).toBe('果吧');
    expect(def('餐饮', '热菜')).toBe('餐厅 · 餐饮');
    expect(def('餐饮')).toBe('餐厅 · 餐饮');
    // ② 价目分类里带的字
    expect(def('果吧鲜果', '热菜')).toBe('果吧');
    expect(def('鸡尾酒', '热菜')).toBe('水吧 · 调酒');
    expect(def('特调酒')).toBe('水吧 · 调酒');
    expect(def('港式糖水', '热菜')).toBe('水吧 · 糖水');
    expect(def('啤酒', '水吧')).toBe('餐厅 · 酒水');
    expect(def('红酒')).toBe('餐厅 · 酒水');
    // ③ 档口名
    expect(def('甜品', '水吧')).toBe('水吧 · 手作饮料');
    expect(def('饮品', '果吧')).toBe('果吧');
    // ④ 不在水吧、果吧做的饮品饮料多是瓶装的
    expect(def('饮品', '吧台')).toBe('餐厅 · 酒水');
    expect(def('饮料')).toBe('餐厅 · 酒水');
    // ⑤ 其余
    expect(def('热菜', '热菜')).toBe('餐厅 · 餐饮');
    expect(def('', null)).toBe('餐厅 · 餐饮');
    expect(def(null, null)).toBe('餐厅 · 餐饮');
  });

  it('编码、显示与排序：入口和小分类配得上才算；果吧不分小类', () => {
    expect(ALL_DINING_SLOTS.map(slotKey)).toEqual(['restaurant:餐饮', 'restaurant:酒水', 'water:手作饮料', 'water:糖水', 'water:调酒', 'fruit']);
    expect(ALL_DINING_SLOTS.map(slotLabel)).toEqual(['餐厅 · 餐饮', '餐厅 · 酒水', '水吧 · 手作饮料', '水吧 · 糖水', '水吧 · 调酒', '果吧']);
    for (const s of ALL_DINING_SLOTS) expect(parseSlotKey(slotKey(s))).toEqual(s);
    for (const bad of ['', 'bar', 'fruit:鲜果', 'water:餐饮', 'restaurant', 'restaurant:', 'water:手作饮料:冰']) expect(parseSlotKey(bad), bad).toBeNull();
    expect(isValidSlot({ outlet: 'fruit', group: '' })).toBe(true);
    expect(isValidSlot({ outlet: 'restaurant', group: '调酒' })).toBe(false);
    expect(slotOrder({ outlet: 'restaurant', group: '餐饮' })).toBeLessThan(slotOrder({ outlet: 'water', group: '调酒' }));
    expect(slotOrder({ outlet: 'water', group: '调酒' })).toBeLessThan(slotOrder({ outlet: 'fruit', group: '' }));
  });

  it('筛选：不带入口为全部；带入口、小分类为空为这一处全部；小分类可多选', () => {
    const tea = { outlet: 'water' as const, group: '手作饮料' };
    expect(slotMatches(tea, null, [])).toBe(true);
    expect(slotMatches(tea, null, ['糖水'])).toBe(true);
    expect(slotMatches(tea, 'water', [])).toBe(true);
    expect(slotMatches(tea, 'water', ['糖水', '手作饮料'])).toBe(true);
    expect(slotMatches(tea, 'water', ['糖水'])).toBe(false);
    expect(slotMatches(tea, 'fruit', [])).toBe(false);
  });

  it('点菜单每道菜的状态（CF9）：退了的另计；出餐后还要点上菜时「已出餐」不算已上；没进厨房的算已上', () => {
    expect(receiptLineState('voided', 'served', true)).toBe('voided');
    expect(receiptLineState('active', 'cancelled', true)).toBe('voided');
    expect(receiptLineState('active', 'served', true)).toBe('served');
    expect(receiptLineState('active', null, true)).toBe('served');
    expect(receiptLineState('active', 'done', true)).toBe('done');
    expect(receiptLineState('active', 'done', false)).toBe('served');
    expect(receiptLineState('active', 'cooking', true)).toBe('cooking');
    expect(receiptLineState('active', 'queued', false)).toBe('waiting');
  });
});

let ctx: TestContext;
let kitchenOnly: string;
let today: string;
let tagNo = 0;
const item: Record<string, number> = {};
const station: Record<string, number> = {};
const PRICES: Record<string, number> = {};

const enter = async () => {
  tagNo += 1;
  const code = `C${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.visits[0].id as number, code };
};
const total = (lines: { itemId: number; quantity: number }[]) => lines.reduce((n, l) => n + PRICES[Object.keys(item).find((k) => item[k] === l.itemId)!]! * l.quantity, 0);
const dish = (name: string, quantity = 1, note?: string) => ({ itemId: item[name]!, quantity, ...(note ? { note } : {}) });
const orderTag = async (visitId: number, lines: ReturnType<typeof dish>[]) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines, expectedTotal: total(lines) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const orderTable = async (sessionId: number, lines: ReturnType<typeof dish>[]) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${sessionId}/orders`, { clientKey: randomUUID(), lines, expectedTotal: total(lines) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const kitchenItems = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/kitchen')).body.items as { id: number; name: string; status: string; tableName: string | null; visitId: number | null }[];
const act = async (id: number, action: 'start' | 'done' | 'serve') => expect((await api(ctx.app, ctx.owner, 'POST', `/api/kitchen/items/${id}/${action}`)).status).toBe(200);
const admin = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/dining')).body as { items: { id: number; name: string; slot: { outlet: string; group: string }; slotAssigned: boolean }[] };
const putItems = (items: Record<string, unknown>[], cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', '/api/admin/dining/items', { items });
const rules = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', body);
const receipt = async (q: string, cookie = ctx.clerk) => {
  const r = await api(ctx.app, cookie, 'GET', `/api/dining/receipt?${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as DiningReceipt;
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'kitchen', displayName: '后厨', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  kitchenOnly = await login(ctx.app, 'kitchen');
  today = (await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body.today;
  expect((await rules({ enabled: true, tablesEnabled: true, trackServed: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'C', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
  for (const name of ['热菜', '水吧', '果吧', '吧台']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  // 价目分类多半都写「餐饮」（统称），按档口归；有的写得细
  for (const [name, category, price, at] of [
    ['宫保鸡丁', '餐饮', 4800, '热菜'],
    ['青岛啤酒', '餐饮', 1800, '吧台'],
    ['可乐', '饮品', 800, '吧台'],
    ['柠檬茶', '餐饮', 2600, '水吧'],
    ['杨枝甘露', '甜品', 3200, '水吧'],
    ['莫吉托', '鸡尾酒', 6800, '水吧'],
    ['鲜切果盘', '果吧', 3800, '果吧'],
    ['西瓜汁', '饮品', 2800, '果吧'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    PRICES[name] = price;
    expect((await putItems([{ id: item[name], stationId: station[at] }])).status).toBe(200);
  }
});
afterAll(async () => ctx.close());

describe('后台：菜的点单分类（与出品档口同一个接口）', () => {
  it('没设的按默认归、标没设过；设、清掉、只改档口不动分类；配不上的编码与什么都不带的拒绝；记审计；能管价目的才能改', async () => {
    const slots = async () => Object.fromEntries((await admin()).items.filter((i) => item[i.name]).map((i) => [i.name, `${slotLabel(i.slot as never)}${i.slotAssigned ? '' : '（默认）'}`]));
    expect(await slots()).toEqual({
      宫保鸡丁: '餐厅 · 餐饮（默认）',
      青岛啤酒: '餐厅 · 餐饮（默认）',
      可乐: '餐厅 · 酒水（默认）',
      柠檬茶: '水吧 · 手作饮料（默认）',
      杨枝甘露: '水吧 · 手作饮料（默认）',
      莫吉托: '水吧 · 调酒（默认）',
      鲜切果盘: '果吧（默认）',
      西瓜汁: '果吧（默认）',
    });

    // 设：啤酒归酒水、甘露归糖水；同一次还改了莫吉托的档口（分类不带、不动）
    const saved = await putItems([
      { id: item['青岛啤酒'], slot: 'restaurant:酒水' },
      { id: item['杨枝甘露'], slot: 'water:糖水' },
      { id: item['莫吉托'], stationId: station['吧台'] },
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const after = await slots();
    expect(after).toMatchObject({ 青岛啤酒: '餐厅 · 酒水', 杨枝甘露: '水吧 · 糖水', 莫吉托: '水吧 · 调酒（默认）' });
    // 只改档口：甘露挪到吧台，分类照设的
    expect((await putItems([{ id: item['杨枝甘露'], stationId: station['吧台'] }])).status).toBe(200);
    expect((await slots())['杨枝甘露']).toBe('水吧 · 糖水');
    expect(
      (
        await putItems([
          { id: item['杨枝甘露'], stationId: station['水吧'] },
          { id: item['莫吉托'], stationId: station['水吧'] },
        ])
      ).status,
    ).toBe(200);

    // 清掉：回到默认
    expect((await putItems([{ id: item['青岛啤酒'], slot: null }])).status).toBe(200);
    expect((await slots())['青岛啤酒']).toBe('餐厅 · 餐饮（默认）');
    expect((await putItems([{ id: item['青岛啤酒'], slot: 'restaurant:酒水' }])).status).toBe(200);

    // 配不上的编码、什么都不带的拒绝，一条都不改
    for (const bad of ['fruit:鲜果', 'water:餐饮', 'bar', 'restaurant']) {
      const r = await putItems([
        { id: item['宫保鸡丁'], slot: 'restaurant:酒水' },
        { id: item['柠檬茶'], slot: bad },
      ]);
      expect(r.status, bad).toBe(400);
    }
    expect((await putItems([{ id: item['宫保鸡丁'] }])).status).toBe(400);
    expect((await slots())['宫保鸡丁']).toBe('餐厅 · 餐饮（默认）');

    // 审计：一次保存一条，写明谁改成了什么
    const audits = await ctx.sql<{ summary: string }[]>`SELECT detail->>'summary' AS summary FROM audit_logs WHERE action = 'items_slot_updated' ORDER BY id`;
    expect(audits.map((a) => a.summary)).toEqual(['青岛啤酒 → 餐厅 · 酒水；杨枝甘露 → 水吧 · 糖水', '青岛啤酒 → 按默认', '青岛啤酒 → 餐厅 · 酒水']);
    // 原样再存一次不记
    expect((await putItems([{ id: item['青岛啤酒'], slot: 'restaurant:酒水' }])).status).toBe(200);
    expect((await ctx.sql`SELECT 1 FROM audit_logs WHERE action = 'items_slot_updated'`).length).toBe(3);

    // 前台店员不能改
    expect((await putItems([{ id: item['宫保鸡丁'], slot: 'fruit' }], ctx.clerk)).status).toBe(403);
  });

  it('数据库兜底：入口只能是三处之一，没入口时小分类为空，小分类不超过 8 个字', async () => {
    const id = item['宫保鸡丁']!;
    await expect(ctx.sql`UPDATE service_items SET dining_outlet = 'bar' WHERE id = ${id}`).rejects.toThrow(/dining_slot/);
    await expect(ctx.sql`UPDATE service_items SET dining_outlet = NULL, dining_group = '餐饮' WHERE id = ${id}`).rejects.toThrow(/dining_slot/);
    await expect(ctx.sql`UPDATE service_items SET dining_outlet = 'water', dining_group = '一二三四五六七八九' WHERE id = ${id}`).rejects.toThrow(/dining_slot/);
  });

  it('点单页的菜单带每道菜的点单分类（设过的照设的，没设的按默认）', async () => {
    const menu = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body as { dishes: MenuDish[] };
    const of = (name: string) => {
      const d = menu.dishes.find((x) => x.name === name)!;
      return slotLabel({ outlet: d.outlet, group: d.group });
    };
    expect(of('宫保鸡丁')).toBe('餐厅 · 餐饮');
    expect(of('青岛啤酒')).toBe('餐厅 · 酒水');
    expect(of('杨枝甘露')).toBe('水吧 · 糖水');
    expect(of('莫吉托')).toBe('水吧 · 调酒');
    expect(of('鲜切果盘')).toBe('果吧');
  });
});

describe('餐饮台账、退菜记录按点单分类筛（CF7）', () => {
  it('台账：全部 / 一处 / 一处里的几个小类，合计与逐行一致；导出多一列「价目分类」，文件名写明筛的哪一处；退菜记录同样能筛', async () => {
    const v = await enter();
    await orderTag(v.id, [dish('宫保鸡丁'), dish('青岛啤酒', 2), dish('柠檬茶', 2, '少冰'), dish('杨枝甘露'), dish('莫吉托'), dish('鲜切果盘'), dish('西瓜汁')]);
    // 退掉莫吉托（大额要经理：店主退）与柠檬茶（小额直接退）
    const lines = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v.id}`)).body.lines as { id: number; name: string; status: string }[];
    const lineOf = (name: string) => lines.find((l) => l.name === name && l.status === 'active')!.id;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${lineOf('莫吉托')}/void`, { reason: '客人不要了' })).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${lineOf('柠檬茶')}/void`, { reason: '点错了' })).status).toBe(200);

    const ledger = async (q = '') => {
      const r = await api(ctx.app, ctx.clerk, 'GET', `/api/dining/ledger?from=${today}&to=${today}${q}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as DiningLedger;
    };
    const names = (l: DiningLedger) => l.rows.map((r) => r.name).sort();
    const all = await ledger();
    expect(all.rows.find((r) => r.name === '杨枝甘露')).toMatchObject({ outlet: 'water', group: '糖水', category: '甜品' });
    expect(all.rows.find((r) => r.name === '宫保鸡丁')).toMatchObject({ outlet: 'restaurant', group: '餐饮', category: '餐饮' });

    const water = await ledger('&outlet=water');
    expect(names(water)).toEqual(['杨枝甘露', '柠檬茶', '莫吉托'].sort());
    expect(water.totals).toEqual({ lines: 3, quantity: 1, amount: 3200, voidedLines: 2, voidedAmount: 2600 * 2 + 6800 });
    expect(names(await ledger(`&outlet=water&groups=${encodeURIComponent('糖水,调酒')}`))).toEqual(['杨枝甘露', '莫吉托'].sort());
    expect(names(await ledger('&outlet=fruit'))).toEqual(['西瓜汁', '鲜切果盘'].sort());
    const restaurant = await ledger(`&outlet=restaurant&groups=${encodeURIComponent('酒水')}&status=active`);
    expect(restaurant.rows.map((r) => [r.name, r.quantity])).toEqual([['青岛啤酒', 2]]);
    // 不带入口时小分类不起作用；入口写错拒绝
    expect(names(await ledger(`&groups=${encodeURIComponent('糖水')}`))).toEqual(names(all));
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/dining/ledger?from=${today}&to=${today}&outlet=bar`)).status).toBe(400);

    // 导出：与页面同一个查询；多一列「价目分类」；文件名写明筛的哪一处
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/dining/ledger/export?from=${today}&to=${today}&outlet=water`, headers: { cookie: ctx.clerk } });
    expect(csv.statusCode).toBe(200);
    expect(decodeURIComponent(String(csv.headers['content-disposition']))).toContain(`餐饮台账-${today}至${today}-水吧.csv`);
    const rows = csv.body
      .replace(/^﻿/, '')
      .trim()
      .split('\r\n')
      .map((r) => r.split(','));
    expect(rows[0]).toEqual(['营业日', '时间', '手牌', '桌台', '菜名', '分类', '价目分类', '数量', '单价', '金额', '状态', '退菜原因', '出品', '点单人']);
    expect(rows.length).toBe(water.rows.length + 2);
    const sweet = rows.find((r) => r[4] === '杨枝甘露')!;
    expect([sweet[5], sweet[6]]).toEqual(['水吧 · 糖水', '甜品']);
    expect(rows.at(-1)![0]).toBe('合计');
    expect(rows.at(-1)![9]).toBe('32.00');

    // 退菜记录：带点单分类，能筛
    const voids = async (q = '') => {
      const r = await api(ctx.app, ctx.owner, 'GET', `/api/dining/voids?from=${today}&to=${today}${q}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as DishVoidRow[];
    };
    const allVoids = await voids();
    expect(allVoids.find((r) => r.name === '莫吉托')).toMatchObject({ outlet: 'water', group: '调酒' });
    expect((await voids('&outlet=water')).map((r) => r.name).sort()).toEqual(['柠檬茶', '莫吉托'].sort());
    expect((await voids(`&outlet=water&groups=${encodeURIComponent('调酒')}`)).map((r) => r.name)).toEqual(['莫吉托']);
    expect(await voids('&outlet=fruit')).toEqual([]);
    const vcsv = await ctx.app.inject({ method: 'GET', url: `/api/dining/voids/export?from=${today}&to=${today}&outlet=water`, headers: { cookie: ctx.owner } });
    expect(vcsv.statusCode).toBe(200);
    expect(decodeURIComponent(String(vcsv.headers['content-disposition']))).toContain('-水吧.csv');
    const vrows = vcsv.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(vrows[0]!.split(',')).toEqual(['退菜时间', '手牌', '桌台', '菜名', '分类', '数量', '金额', '原因', '谁退的', '谁点的', '怎么批的']);
    expect(vrows.some((r) => r.includes('莫吉托') && r.includes('水吧 · 调酒'))).toBe(true);
    expect(vrows.length).toBe(4);
  });
});

describe('点菜单（小票可视化，CF8、CF9）', () => {
  it('一桌：按每次下单分段，每道菜已上 / 未上 / 制作中 / 已出餐 / 已退，合计；关了「还要点上菜」时出餐即已上；结账以后还能看', async () => {
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: '观澜厅', area: '景观包厢', seats: 10 });
    expect(t.status, JSON.stringify(t.body)).toBeLessThan(300);
    const tableId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM dining_tables WHERE name = '观澜厅'`)[0]!.id);
    const opened = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 6, guestLabel: '陈先生' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const sid = opened.body.id as number;

    // 还没点：空的
    const empty = await receipt(`session=${sid}`);
    expect(empty).toMatchObject({ kind: 'table', title: '观澜厅', zone: '景观包厢', guest: '陈先生', guests: 6, closed: false, trackServed: true, orders: [] });
    expect(empty.totals).toEqual({ quantity: 0, served: 0, waiting: 0, voided: 0, amount: 0 });

    await orderTable(sid, [dish('宫保鸡丁', 1, '少辣'), dish('青岛啤酒', 2)]);
    await orderTable(sid, [dish('柠檬茶', 2), dish('杨枝甘露')]);
    await orderTable(sid, [dish('鲜切果盘')]);

    // 出品：宫保鸡丁上了；啤酒出餐了没上；柠檬茶在做；甘露待做；果盘退了
    const k = async (name: string) => (await kitchenItems()).find((x) => x.tableName === '观澜厅' && x.name === name)!.id;
    const kungpao = await k('宫保鸡丁');
    await act(kungpao, 'start');
    await act(kungpao, 'done');
    await act(kungpao, 'serve');
    const beer = await k('青岛啤酒');
    await act(beer, 'start');
    await act(beer, 'done');
    await act(await k('柠檬茶'), 'start');
    const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/sessions/${sid}`)).body as { lines: { id: number; name: string; status: string }[] };
    const fruitLine = detail.lines.find((l) => l.name === '鲜切果盘' && l.status === 'active')!.id;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/lines/${fruitLine}/void`, { reason: '客人不要了' })).status).toBe(200);

    const r = await receipt(`session=${sid}`);
    expect(r.orders.map((o) => o.seq)).toEqual([1, 2, 3]);
    expect(r.orders.map((o) => o.lines.map((l) => `${l.name}×${l.quantity}:${l.state}`))).toEqual([
      ['宫保鸡丁×1:served', '青岛啤酒×2:done'],
      ['柠檬茶×2:cooking', '杨枝甘露×1:waiting'],
      ['鲜切果盘×1:voided'],
    ]);
    expect(r.orders.every((o) => o.orderNo && o.postedByName)).toBe(true);
    const kp = r.orders[0]!.lines[0]!;
    expect(kp).toMatchObject({ note: '少辣', outlet: 'restaurant', group: '餐饮', unitPrice: 4800, amount: 4800, kitchenStatus: 'served' });
    expect(r.orders[1]!.lines[1]).toMatchObject({ outlet: 'water', group: '糖水' });
    expect(r.orders[2]!.lines[0]).toMatchObject({ outlet: 'fruit', group: '' });
    expect(r.totals).toEqual({ quantity: 6, served: 1, waiting: 5, voided: 1, amount: 4800 + 1800 * 2 + 2600 * 2 + 3200 });

    // 关了「出餐后还要点上菜」：出餐即已上
    expect((await rules({ trackServed: false })).status).toBe(200);
    const relaxed = await receipt(`session=${sid}`);
    expect(relaxed.trackServed).toBe(false);
    expect(relaxed.orders[0]!.lines[1]!.state).toBe('served');
    expect(relaxed.totals).toMatchObject({ served: 3, waiting: 3 });
    expect((await rules({ trackServed: true })).status).toBe(200);

    // 结账以后照样看得到（只读）
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/checkout-preview?ids=${sid}`)).body as { totalAmount: number };
    expect(preview.totalAmount).toBe(r.totals.amount);
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/checkout', {
      clientKey: randomUUID(),
      sessionIds: [sid],
      expectedTotal: preview.totalAmount,
      payments: [{ method: 'cash', amount: preview.totalAmount }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const closed = await receipt(`session=${sid}`);
    expect(closed.closed).toBe(true);
    expect(closed.totals).toEqual(r.totals);
  });

  it('手牌客人：标题是牌号，没有分区和人数；只有餐饮的菜，前台挂的洗浴项目不算', async () => {
    const v = await enter();
    const bath = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '搓背', category: '洗浴', price: 3800 });
    const rub = bath.body.items.find((i: { name: string }) => i.name === '搓背').id;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/charges`, { clientKey: randomUUID(), lines: [{ itemId: rub, quantity: 1 }], expectedTotal: 3800 })).status).toBe(200);
    await orderTag(v.id, [dish('西瓜汁', 2)]);
    const r = await receipt(`visit=${v.id}`);
    expect(r).toMatchObject({ kind: 'tag', title: v.code, zone: '', guests: null, closed: false });
    expect(r.orders.map((o) => o.lines.map((l) => `${l.name}×${l.quantity}:${l.state}`))).toEqual([['西瓜汁×2:waiting']]);
    expect(r.totals).toEqual({ quantity: 2, served: 0, waiting: 2, voided: 0, amount: 5600 });
  });

  it('参数与权限：一桌、一位客人只能指定一样；不存在的 404；只有厨房出品权限的看不到', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/receipt')).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/receipt?session=1&visit=1')).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/receipt?session=abc')).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/receipt?session=999999')).status).toBe(404);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/receipt?visit=999999')).status).toBe(404);
    const v = await enter();
    expect((await api(ctx.app, kitchenOnly, 'GET', `/api/dining/receipt?visit=${v.id}`)).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/dining/receipt?visit=${v.id}`)).status).toBe(200);
  });
});
