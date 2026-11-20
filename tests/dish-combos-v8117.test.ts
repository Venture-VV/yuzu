// 8.1.17 BW7 套餐按子项出品、扣沽清与用料，可换菜（docs/DISHES_V8117.md 第 7 节，默认做法 docs/PENDING_DECISIONS.md BW7；迁移 197）：
//   · 维护：套餐的一样标「可换」、能换成哪几样与每份补的差价；换成的要是菜品、不是套餐、不是它自己；只交份数的老写法保留原来的可换设置；
//   · 点单：选的换菜按维护时设好的核对，差价按份加进套餐那一行的单价，出品单与账单上写「可乐换橙汁 +¥3」；
//   · 出品：套餐每一样一行子项单，档口与套餐不一样的在自己的档口单独出（开始做、出餐、撤回），一样的跟着套餐那一张；
//   · 沽清：子项各扣各的（换过的扣换成的），不够整笔拒绝；菜单上套餐还能卖几份按子项里最少的；退菜时子项单一起退、沽清加回；
//   · 用料：子项出餐时按它自己的用料记「该扣多少」（与套餐自己的分开），撤回出餐冲回；
//   · 没设可换的老套餐照旧（价钱、出品单上的内容不变）。
// 全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { slotKey, type DiningMenu, type KitchenBoard } from '../src/shared/dining';
import type { DishRow, DishesBoard } from '../src/shared/dishes';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;
const station: Record<string, number> = {};
const dish: Record<string, number> = {};
const mat: Record<string, number> = {};
/** 这道菜现在的版本（上下架要带页面看到的版本，8.1.16） */
const revOf = async (id: number): Promise<string> => ((await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes')).body as DishesBoard).dishes.find((d) => d.id === id)!.rev;
const q = (n: number) => Math.round(n * 1000);

const board = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes')).body as DishesBoard;
const dishOf = async (name: string) => {
  const d = (await board()).dishes.find((x) => x.name === name);
  if (!d) throw new Error(`菜品表里没有「${name}」`);
  return d;
};
const fieldsOf = (d: DishRow) => ({
  name: d.name,
  category: d.category,
  slot: slotKey(d),
  stationId: d.stationId,
  imageId: d.imageId,
  methods: d.methods,
  addons: d.addons.map((a) => a.itemId),
  combo: d.combo.map((c) => ({ itemId: c.itemId, quantity: c.quantity })),
});
const create = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes', { clientKey: randomUUID(), ...body });
const update = (d: DishRow, patch: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', `/api/dining/dishes/${d.id}`, { clientKey: randomUUID(), rev: d.rev, ...fieldsOf(d), ...patch });
const menu = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body as DiningMenu;
const kitchen = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/kitchen')).body as KitchenBoard;
const enter = async () => {
  tagNo += 1;
  const code = `C${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.visits[0].id as number, code };
};
type OrderLine = { itemId: number; quantity: number; swaps?: { from: number; to: number }[] };
const orderTag = (visitId: number, lines: OrderLine[], expectedTotal: number) => api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines, expectedTotal });
const lineOf = async (visitId: number, name: string) =>
  (
    await ctx.sql<{ id: number; unitPrice: number; amount: number }[]>`
    SELECT l.id, l.unit_price, l.amount FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${visitId} AND l.name = ${name} ORDER BY l.id DESC LIMIT 1`
  )[0]!;
const partsOf = (billLineId: number) =>
  ctx.sql<{ id: number; name: string; swappedFrom: string | null; perCombo: number; quantity: number; stationId: number; split: boolean; limitTaken: boolean; status: string }[]>`
    SELECT p.id, p.name, p.swapped_from, p.per_combo, p.quantity, p.station_id, p.split, p.limit_taken, p.status
    FROM kitchen_item_parts p JOIN kitchen_items k ON k.id = p.kitchen_item_id WHERE k.bill_line_id = ${billLineId} ORDER BY p.id`;
const kitchenOf = async (billLineId: number) => (await ctx.sql<{ id: number }[]>`SELECT id FROM kitchen_items WHERE bill_line_id = ${billLineId}`)[0]!.id;
const remaining = async (itemId: number) => (await ctx.sql<{ remaining: number }[]>`SELECT remaining FROM dish_limits WHERE item_id = ${itemId}`)[0]?.remaining ?? null;
const setLimit = async (itemId: number, left: number | null) => expect((await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${itemId}`, { remaining: left })).status).toBe(200);
const partAct = (id: number, action: string, body: Record<string, unknown> = {}) => api(ctx.app, ctx.owner, 'POST', `/api/kitchen/parts/${id}/${action}`, body);
const itemAct = (id: number, action: string) => api(ctx.app, ctx.owner, 'POST', `/api/kitchen/items/${id}/${action}`);
const events = () =>
  ctx.sql<{ sign: number; itemName: string; material: number; qty: number; part: boolean }[]>`
    SELECT sign, item_name, material_id AS material, qty_milli AS qty, kitchen_part_id IS NOT NULL AS part FROM stock_usage_events WHERE kind = 'recipe' ORDER BY id`;

/** 午餐套餐：牛肉面（热菜）×1 + 可乐（水吧）×1，可乐可换橙汁（每份补 ¥3）或雪碧（同价） */
const LUNCH = 4800;

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true, tablesEnabled: true, trackServed: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'C', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const name of ['热菜', '水吧']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  for (const [name, at, slot, price] of [
    ['牛肉面', '热菜', 'restaurant:餐饮', 3800],
    ['可乐', '水吧', 'water:手作饮料', 800],
    ['橙汁', '水吧', 'water:手作饮料', 1200],
    ['雪碧', '水吧', 'water:手作饮料', 800],
    ['小菜', '热菜', 'restaurant:餐饮', 600],
  ] as const) {
    const r = await create({ name, category: '餐饮', slot, stationId: station[at], prices: { standard: price } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    dish[name] = r.body.dish.id;
  }
  // 用料：牛肉面 0.15 千克牛肉，橙汁 0.3 千克橙子，套餐自己一个餐盒
  for (const [code, name, unit, decimals] of [
    ['C-BEEF', '牛肉', '千克', 3],
    ['C-ORANGE', '橙子', '千克', 3],
    ['C-BOX', '餐盒', '个', 0],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/inventory/materials', { code, name, inventoryUnit: unit, decimals, purchaseUnit: '箱', purchaseFactorMilli: q(10), refPriceCents: 1000 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    mat[name] = r.body.id;
  }
  for (const [item, material, qty] of [
    ['牛肉面', '牛肉', q(0.15)],
    ['橙汁', '橙子', q(0.3)],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'PUT', `/api/inventory/recipes/${dish[item]}`, { expectedVersion: 0, lines: [{ materialId: mat[material], qtyMilli: qty }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
}, 60_000);
afterAll(async () => ctx.close());

describe('BW7 维护：可换的子项与差价', () => {
  it('建套餐时标「可换」、能换成哪几样与差价；菜品表带出来，被换成的菜写「套餐里可换成的菜」；审计写可换的内容', async () => {
    const r = await create({
      name: '午餐套餐',
      category: '餐饮',
      slot: 'restaurant:餐饮',
      stationId: station['热菜'],
      prices: { standard: LUNCH },
      combo: [
        { itemId: dish['牛肉面'], quantity: 1 },
        {
          itemId: dish['可乐'],
          quantity: 1,
          swappable: true,
          swaps: [
            { itemId: dish['橙汁'], priceDiff: 300 },
            { itemId: dish['雪碧'], priceDiff: 0 },
          ],
        },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    dish['午餐套餐'] = r.body.dish.id;
    const set = r.body.dish as DishRow;
    expect(set.combo).toEqual([
      { itemId: dish['牛肉面'], name: '牛肉面', quantity: 1, available: true, swappable: false, swaps: [] },
      {
        itemId: dish['可乐'],
        name: '可乐',
        quantity: 1,
        available: true,
        swappable: true,
        swaps: [
          { itemId: dish['橙汁'], name: '橙汁', priceDiff: 300, available: true },
          { itemId: dish['雪碧'], name: '雪碧', priceDiff: 0, available: true },
        ],
      },
    ]);
    expect((await dishOf('橙汁')).usedBy).toEqual(['套餐「午餐套餐」里可换成的菜']);
    // 用套餐的餐盒（套餐自己的用料照旧在套餐那一张出餐时记）
    const box = await api(ctx.app, ctx.owner, 'PUT', `/api/inventory/recipes/${set.id}`, { expectedVersion: 0, lines: [{ materialId: mat['餐盒'], qtyMilli: q(1) }] });
    expect(box.status, JSON.stringify(box.body)).toBe(200);
    // 改差价：审计写可换的内容
    const changed = await update(set, {
      combo: [
        { itemId: dish['牛肉面'], quantity: 1 },
        {
          itemId: dish['可乐'],
          quantity: 1,
          swappable: true,
          swaps: [
            { itemId: dish['橙汁'], priceDiff: 400 },
            { itemId: dish['雪碧'], priceDiff: 0 },
          ],
        },
      ],
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const [audit] = await ctx.sql<{ summary: string }[]>`SELECT detail->>'summary' AS summary FROM audit_logs WHERE action = 'dish_saved' ORDER BY id DESC LIMIT 1`;
    expect(audit!.summary).toContain('套餐内容 牛肉面×1、可乐×1（可换：橙汁 +¥3、雪碧） → 牛肉面×1、可乐×1（可换：橙汁 +¥4、雪碧）');
    // 改回 ¥3
    const back = await update(changed.body.dish, {
      combo: [
        { itemId: dish['牛肉面'], quantity: 1 },
        {
          itemId: dish['可乐'],
          quantity: 1,
          swappable: true,
          swaps: [
            { itemId: dish['橙汁'], priceDiff: 300 },
            { itemId: dish['雪碧'], priceDiff: 0 },
          ],
        },
      ],
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
  });

  it('只交份数的老写法（8.1.15 的页面、导入）：保留原来的可换设置，什么都没改不动这一行；标了不可换的清掉换成的菜', async () => {
    const set = await dishOf('午餐套餐');
    const same = await update(set, {});
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body.dish.rev).toBe(set.rev);
    expect(same.body.dish.combo[1].swaps.map((w: { name: string }) => w.name)).toEqual(['橙汁', '雪碧']);
    // 只带 swaps 的按有没有换成的算可不可换
    const off = await update(set, {
      combo: [
        { itemId: dish['牛肉面'], quantity: 1 },
        { itemId: dish['可乐'], quantity: 1, swappable: false },
      ],
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.dish.combo[1]).toMatchObject({ swappable: false, swaps: [] });
    const on = await update(off.body.dish, {
      combo: [
        { itemId: dish['牛肉面'], quantity: 1 },
        {
          itemId: dish['可乐'],
          quantity: 1,
          swaps: [
            { itemId: dish['橙汁'], priceDiff: 300 },
            { itemId: dish['雪碧'], priceDiff: 0 },
          ],
        },
      ],
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.dish.combo[1]).toMatchObject({ swappable: true, swaps: [{ name: '橙汁', priceDiff: 300 }, { name: '雪碧' }] });
  });

  it('换成的菜的规矩：至少一样、不换成它自己、不是这个套餐自己、要是菜品、不能是套餐；被换成的菜不能再做成套餐（数据库也兜底）', async () => {
    const set = await dishOf('午餐套餐');
    const keep = { itemId: dish['牛肉面'], quantity: 1 };
    const tryCombo = (cola: Record<string, unknown>) => update(set, { combo: [keep, { itemId: dish['可乐'], quantity: 1, ...cola }] });
    const empty = await tryCombo({ swappable: true, swaps: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('DISH_SWAP_EMPTY');
    const self = await tryCombo({ swappable: true, swaps: [{ itemId: dish['可乐'], priceDiff: 0 }] });
    expect(self.body.error.code).toBe('DISH_SWAP_SAME');
    const own = await tryCombo({ swappable: true, swaps: [{ itemId: set.id, priceDiff: 0 }] });
    expect(own.body.error.code).toBe('DISH_SELF_REF');
    const dup = await tryCombo({
      swappable: true,
      swaps: [
        { itemId: dish['橙汁'], priceDiff: 0 },
        { itemId: dish['橙汁'], priceDiff: 100 },
      ],
    });
    expect(dup.status).toBe(400);
    const tooMuch = await tryCombo({ swappable: true, swaps: [{ itemId: dish['橙汁'], priceDiff: 100_000 }] });
    expect(tooMuch.status).toBe(400);
    // 换成套餐
    const other = await create({ name: '早餐套餐', category: '餐饮', slot: 'restaurant:餐饮', stationId: station['热菜'], prices: { standard: 2000 }, combo: [{ itemId: dish['小菜'], quantity: 1 }] });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const nested = await tryCombo({ swappable: true, swaps: [{ itemId: other.body.dish.id, priceDiff: 0 }] });
    expect(nested.status).toBe(422);
    expect(nested.body.error.message).toBe('「早餐套餐」本身是套餐，不能当套餐里可换成的菜');
    // 不是菜品（不进厨房的价目项目）
    const towel = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '毛巾', category: '零售', price: 500 });
    const towelId = towel.body.items.find((i: { name: string }) => i.name === '毛巾').id;
    const notDish = await tryCombo({ swappable: true, swaps: [{ itemId: towelId, priceDiff: 0 }] });
    expect(notDish.body.error.code).toBe('DISH_REF_NOT_DISH');
    // 被换成的菜不能再做成套餐
    const orange = await dishOf('橙汁');
    const asCombo = await update(orange, { combo: [{ itemId: dish['小菜'], quantity: 1 }] });
    expect(asCombo.status).toBe(422);
    expect(asCombo.body.error.message).toBe('这道菜是套餐「午餐套餐」里可换成的菜，不能做成套餐');
    // 数据库兜底：换成的不能是套餐
    await expect(ctx.sql`INSERT INTO dish_combo_swaps (combo_item_id, item_id, to_item_id) VALUES (${set.id}, ${dish['可乐']!}, ${other.body.dish.id as number})`).rejects.toThrow(
      '套餐里不能换成套餐',
    );
    // 什么都没写进去
    expect((await dishOf('午餐套餐')).combo[1]!.swaps.map((w) => `${w.name}+${w.priceDiff}`)).toEqual(['橙汁+300', '雪碧+0']);
  });
});

describe('BW7 点单：换菜与差价、子项出品单', () => {
  it('菜单上套餐带每一样与能换成的；点单按维护时的核对，差价按份加进单价，出品单写「可乐换橙汁 +¥3」，子项各一行', async () => {
    const m = await menu();
    const set = m.dishes.find((d) => d.name === '午餐套餐')!;
    expect(set.combo).toEqual([
      { itemId: dish['牛肉面'], name: '牛肉面', quantity: 1 },
      {
        itemId: dish['可乐'],
        name: '可乐',
        quantity: 1,
        swaps: [
          { itemId: dish['橙汁'], name: '橙汁', priceDiff: 300, available: true },
          { itemId: dish['雪碧'], name: '雪碧', priceDiff: 0, available: true },
        ],
      },
    ]);
    const v = await enter();
    // 价格以服务端为准：没算上差价的拒绝
    const cheap = await orderTag(v.id, [{ itemId: set.id, quantity: 2, swaps: [{ from: dish['可乐']!, to: dish['橙汁']! }] }], LUNCH * 2);
    expect(cheap.status).toBe(409);
    expect(cheap.body.error.code).toBe('PRICE_CHANGED');
    const r = await orderTag(v.id, [{ itemId: set.id, quantity: 2, swaps: [{ from: dish['可乐']!, to: dish['橙汁']! }] }], (LUNCH + 300) * 2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const line = await lineOf(v.id, '午餐套餐');
    expect(line).toMatchObject({ unitPrice: LUNCH + 300, amount: (LUNCH + 300) * 2 });
    const board = await kitchen();
    const kid = await kitchenOf(line.id);
    const k = board.items.find((x) => x.id === kid)!;
    expect(k.note).toBe('可乐换橙汁 +¥3');
    expect(k.parts).toEqual([
      { name: '牛肉面', quantity: 1 },
      { name: '橙汁', quantity: 1, from: '可乐' },
    ]);
    // 子项：牛肉面跟着套餐在热菜出；橙汁换过、在水吧单独出一张
    expect((await partsOf(line.id)).map((p) => `${p.name}|${p.swappedFrom ?? ''}|${p.perCombo}|${p.quantity}|${p.stationId === station['水吧'] ? '水吧' : '热菜'}|${p.split}|${p.status}`)).toEqual([
      '牛肉面||1|2|热菜|false|queued',
      '橙汁|可乐|1|2|水吧|true|queued',
    ]);
    expect(k.partTickets).toEqual([{ id: expect.any(Number), name: '橙汁', quantity: 2, stationId: station['水吧'], stationName: '水吧', status: 'queued' }]);
    const ticket = board.parts!.find((p) => p.kitchenItemId === k.id)!;
    expect(ticket).toMatchObject({ comboName: '午餐套餐', name: '橙汁', swappedFrom: '可乐', quantity: 2, stationName: '水吧', status: 'queued', tagCode: v.code, note: '可乐换橙汁 +¥3' });
    // 账单上看得到换了什么（出品单的备注）、点菜单上列出套餐当时的内容
    const receipt = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/receipt?visit=${v.id}`)).body;
    const printed = receipt.orders.flatMap((o: { lines: unknown[] }) => o.lines).find((l: { name: string }) => l.name === '午餐套餐');
    expect(printed).toMatchObject({
      note: '可乐换橙汁 +¥3',
      parts: [
        { name: '牛肉面', quantity: 1 },
        { name: '橙汁', quantity: 1, from: '可乐' },
      ],
    });
  });

  it('换菜的规矩：不可换的、没设过的、不是套餐的、换成的下架了的都拒绝；同价的换不加钱', async () => {
    const v = await enter();
    const set = dish['午餐套餐']!;
    const noodleSwap = await orderTag(v.id, [{ itemId: set, quantity: 1, swaps: [{ from: dish['牛肉面']!, to: dish['小菜']! }] }], LUNCH);
    expect(noodleSwap.status).toBe(422);
    expect(noodleSwap.body.error.code).toBe('DISH_SWAP_INVALID');
    const unknown = await orderTag(v.id, [{ itemId: set, quantity: 1, swaps: [{ from: dish['可乐']!, to: dish['小菜']! }] }], LUNCH);
    expect(unknown.body.error.code).toBe('DISH_SWAP_INVALID');
    const twice = await orderTag(
      v.id,
      [
        {
          itemId: set,
          quantity: 1,
          swaps: [
            { from: dish['可乐']!, to: dish['橙汁']! },
            { from: dish['可乐']!, to: dish['雪碧']! },
          ],
        },
      ],
      LUNCH + 300,
    );
    expect(twice.body.error.code).toBe('DISH_SWAP_INVALID');
    const notCombo = await orderTag(v.id, [{ itemId: dish['牛肉面']!, quantity: 1, swaps: [{ from: dish['可乐']!, to: dish['橙汁']! }] }], 3800);
    expect(notCombo.body.error.code).toBe('DISH_SWAP_INVALID');
    // 换成的下架了
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/dining/dishes/${dish['橙汁']}/active`, { clientKey: randomUUID(), active: false, rev: await revOf(dish['橙汁']!) })).status).toBe(200);
    const off = await orderTag(v.id, [{ itemId: set, quantity: 1, swaps: [{ from: dish['可乐']!, to: dish['橙汁']! }] }], LUNCH + 300);
    expect(off.status).toBe(422);
    expect(off.body.error.message).toBe('「橙汁」现在点不了（下架或档口停用），「午餐套餐」请换别的');
    expect((await menu()).dishes.find((d) => d.name === '午餐套餐')!.combo![1]!.swaps!.map((w) => `${w.name}:${w.available}`)).toEqual(['橙汁:false', '雪碧:true']);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/dining/dishes/${dish['橙汁']}/active`, { clientKey: randomUUID(), active: true, rev: await revOf(dish['橙汁']!) })).status).toBe(200);
    // 同价的换：不加钱，备注写「可乐换雪碧」
    const same = await orderTag(v.id, [{ itemId: set, quantity: 1, swaps: [{ from: dish['可乐']!, to: dish['雪碧']! }] }], LUNCH);
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    const line = await lineOf(v.id, '午餐套餐');
    expect(line.unitPrice).toBe(LUNCH);
    expect((await kitchen()).items.find((k) => k.parts.some((p) => p.from === '可乐' && p.name === '雪碧'))!.note).toBe('可乐换雪碧');
  });

  it('子项单在自己的档口：开始做、出餐、撤回一步；页面上看到的状态不对拒绝；跟着套餐的子项随套餐那一张出餐、撤回', async () => {
    const v = await enter();
    expect((await orderTag(v.id, [{ itemId: dish['午餐套餐']!, quantity: 1 }], LUNCH)).status).toBe(200);
    const line = await lineOf(v.id, '午餐套餐');
    const [noodle, cola] = await partsOf(line.id);
    expect(cola).toMatchObject({ name: '可乐', split: true, status: 'queued' });
    // 跟着套餐的（同一个档口）不能在子项单上点
    expect((await partAct(noodle!.id, 'start')).status).toBe(404);
    expect((await partAct(cola!.id, 'undo')).status).toBe(409);
    const started = await partAct(cola!.id, 'start', { from: 'queued' });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect((started.body as KitchenBoard).parts!.find((p) => p.id === cola!.id)!.status).toBe('cooking');
    expect((await partAct(cola!.id, 'start', { from: 'queued' })).body.error.code).toBe('DISH_CHANGED');
    expect((await partAct(cola!.id, 'done')).status).toBe(200);
    expect((await partAct(cola!.id, 'undo', { from: 'done' })).status).toBe(200);
    expect((await partsOf(line.id))[1]!.status).toBe('cooking');
    expect((await partAct(cola!.id, 'done')).status).toBe(200);
    // 套餐那一张出餐：跟着它的牛肉面一起出餐，水吧那张不动
    const k = await kitchenOf(line.id);
    expect((await itemAct(k, 'done')).status).toBe(200);
    expect((await partsOf(line.id)).map((p) => `${p.name}:${p.status}`)).toEqual(['牛肉面:done', '可乐:done']);
    // 撤回套餐的出餐：跟着的回到待做
    expect((await itemAct(k, 'undo')).status).toBe(200);
    expect((await partsOf(line.id)).map((p) => `${p.name}:${p.status}`)).toEqual(['牛肉面:queued', '可乐:done']);
    // 上菜以后出了餐的子项单不再列在屏上
    expect((await itemAct(k, 'done')).status).toBe(200);
    expect((await itemAct(k, 'serve')).status).toBe(200);
    const after = await kitchen();
    expect(after.parts!.some((p) => p.id === cola!.id)).toBe(false);
    expect(after.items.find((x) => x.id === k)!.partTickets).toEqual([expect.objectContaining({ name: '可乐', status: 'done' })]);
  });
});

describe('BW7 子项的沽清与用料', () => {
  it('子项各扣各的沽清（换过的扣换成的），不够整笔拒绝；菜单上套餐还能卖几份按子项里最少的', async () => {
    await setLimit(dish['牛肉面']!, 3);
    await setLimit(dish['可乐']!, 1);
    // 可乐可以换：可乐只剩 1，橙汁、雪碧不限量，套餐还能卖几份看牛肉面
    expect((await menu()).dishes.find((d) => d.name === '午餐套餐')!.remaining).toBe(3);
    const v = await enter();
    const short = await orderTag(v.id, [{ itemId: dish['午餐套餐']!, quantity: 2 }], LUNCH * 2);
    expect(short.status).toBe(409);
    expect(short.body.error.code).toBe('DISH_SOLD_OUT');
    expect(short.body.error.message).toBe('「午餐套餐」里的「可乐」今天只剩 1 份，请改份数或换一道菜');
    expect(await remaining(dish['牛肉面']!)).toBe(3);
    // 一份不换、一份换橙汁：可乐扣 1，牛肉面扣 2
    const ok = await orderTag(
      v.id,
      [
        { itemId: dish['午餐套餐']!, quantity: 1 },
        { itemId: dish['午餐套餐']!, quantity: 1, swaps: [{ from: dish['可乐']!, to: dish['橙汁']! }] },
      ],
      LUNCH * 2 + 300,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await remaining(dish['可乐']!)).toBe(0);
    expect(await remaining(dish['牛肉面']!)).toBe(1);
    // 单点的同一道菜与套餐里的合起来算
    const both = await orderTag(
      v.id,
      [
        { itemId: dish['牛肉面']!, quantity: 1 },
        { itemId: dish['午餐套餐']!, quantity: 1, swaps: [{ from: dish['可乐']!, to: dish['雪碧']! }] },
      ],
      3800 + LUNCH,
    );
    expect(both.status).toBe(409);
    expect(both.body.error.message).toBe('「牛肉面」今天只剩 1 份，请改份数或换一道菜');
    // 可乐卖完了，换成的都限量卖完：套餐沽清
    await setLimit(dish['橙汁']!, 0);
    await setLimit(dish['雪碧']!, 0);
    expect((await menu()).dishes.find((d) => d.name === '午餐套餐')!.remaining).toBe(0);
    await setLimit(dish['雪碧']!, 5);
    expect((await menu()).dishes.find((d) => d.name === '午餐套餐')!.remaining).toBe(1);
    // 退套餐：子项单一起退，扣过的沽清按原份数加回
    const [first, second] = await ctx.sql<{ id: number }[]>`
      SELECT l.id FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${v.id} AND l.name = '午餐套餐' ORDER BY l.id`;
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${first!.id}/void`, { reason: '客人不要了' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await partsOf(first!.id)).map((p) => `${p.name}:${p.status}:${p.limitTaken}`)).toEqual(['牛肉面:cancelled:true', '可乐:cancelled:true']);
    expect(await remaining(dish['可乐']!)).toBe(1);
    expect(await remaining(dish['牛肉面']!)).toBe(2);
    // 退了的子项单不再列在屏上
    const firstKitchen = await kitchenOf(first!.id);
    expect((await kitchen()).parts!.some((p) => p.kitchenItemId === firstKitchen)).toBe(false);
    // 第二份（换了橙汁，橙汁当时不限量）：退了只加回牛肉面
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${second!.id}/void`, { reason: '客人不要了' })).status).toBe(200);
    expect((await partsOf(second!.id)).map((p) => `${p.name}:${p.status}:${p.limitTaken}`)).toEqual(['牛肉面:cancelled:true', '橙汁:cancelled:false']);
    expect(await remaining(dish['牛肉面']!)).toBe(3);
    expect(await remaining(dish['橙汁']!)).toBe(0);
    for (const name of ['牛肉面', '可乐', '橙汁', '雪碧']) await setLimit(dish[name]!, null);
    expect((await menu()).dishes.find((d) => d.name === '午餐套餐')!.remaining).toBeNull();
  });

  it('用料：套餐自己的与跟着出的子项在套餐出餐时记，单独出的子项在自己出餐时记（分开记），撤回出餐冲回', async () => {
    const before = (await events()).length;
    const v = await enter();
    expect((await orderTag(v.id, [{ itemId: dish['午餐套餐']!, quantity: 2, swaps: [{ from: dish['可乐']!, to: dish['橙汁']! }] }], (LUNCH + 300) * 2)).status).toBe(200);
    const line = await lineOf(v.id, '午餐套餐');
    const k = await kitchenOf(line.id);
    const [, orange] = await partsOf(line.id);
    expect((await itemAct(k, 'done')).status).toBe(200);
    const mine = async () =>
      (await events()).slice(before).map((e) => `${e.sign}|${e.itemName}|${e.material === mat['牛肉'] ? '牛肉' : e.material === mat['橙子'] ? '橙子' : '餐盒'}|${e.qty}|${e.part}`);
    expect(await mine()).toEqual(['1|午餐套餐|餐盒|2000|false', '1|牛肉面|牛肉|300|true']);
    expect((await partAct(orange!.id, 'done')).status).toBe(200);
    expect(await mine()).toEqual(['1|午餐套餐|餐盒|2000|false', '1|牛肉面|牛肉|300|true', '1|橙汁|橙子|600|true']);
    // 撤回水吧那张：只冲回橙子
    expect((await partAct(orange!.id, 'undo')).status).toBe(200);
    expect((await mine()).slice(3)).toEqual(['-1|橙汁|橙子|600|true']);
    // 撤回套餐那张：套餐自己的与跟着出的牛肉面一起冲回
    expect((await itemAct(k, 'undo')).status).toBe(200);
    expect((await mine()).slice(4).sort()).toEqual(['-1|午餐套餐|餐盒|2000|false', '-1|牛肉面|牛肉|300|true']);
    // 再出餐：重新记（同一张出品单、同一样物料同时只有一条没冲回的）
    expect((await itemAct(k, 'done')).status).toBe(200);
    expect((await partAct(orange!.id, 'done')).status).toBe(200);
    const live = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_usage_events WHERE kind = 'recipe' AND sign = 1 AND reversed_at IS NULL AND kitchen_item_id = ${k}`;
    expect(live[0]!.n).toBe(3);
  });
});

describe('BW7 桌台与老套餐', () => {
  it('桌台点单同一套：换菜加差价，子项单按档口拆', async () => {
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: 'C1', seats: 4 });
    const tableId = t.body.tables.find((x: { name: string }) => x.name === 'C1').id;
    const open = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${open.body.id}/orders`, {
      clientKey: randomUUID(),
      lines: [{ itemId: dish['午餐套餐'], quantity: 1, swaps: [{ from: dish['可乐'], to: dish['橙汁'] }] }],
      expectedTotal: LUNCH + 300,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lineId = (r.body.lines as { id: number; name: string }[]).find((l) => l.name === '午餐套餐')!.id;
    expect((await partsOf(lineId)).map((p) => `${p.name}|${p.split}`)).toEqual(['牛肉面|false', '橙汁|true']);
    const ticket = (await kitchen()).parts!.find((p) => p.name === '橙汁' && p.tableName === 'C1')!;
    expect(ticket).toMatchObject({ comboName: '午餐套餐', swappedFrom: '可乐', guest: expect.any(String) });
    // 退菜：子项单一起退
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/dining/tables/lines/${lineId}/void`, { reason: '客人不要了' })).status).toBe(200);
    expect((await partsOf(lineId)).every((p) => p.status === 'cancelled')).toBe(true);
    expect((await kitchen()).parts!.some((p) => p.id === ticket.id)).toBe(false);
  });

  it('没设可换的套餐、子项都在同一个档口的套餐：价钱、出品单上的内容与以前一样，没有单独的子项单', async () => {
    const v = await enter();
    const breakfast = (await dishOf('早餐套餐')).id;
    expect((await orderTag(v.id, [{ itemId: breakfast, quantity: 1 }], 2000)).status).toBe(200);
    const line = await lineOf(v.id, '早餐套餐');
    expect(line.unitPrice).toBe(2000);
    const k = (await kitchen()).items.find((x) => x.name === '早餐套餐')!;
    expect(k).toMatchObject({ note: '', parts: [{ name: '小菜', quantity: 1 }] });
    expect(k.partTickets).toBeUndefined();
    expect((await partsOf(line.id)).map((p) => `${p.name}|${p.split}`)).toEqual(['小菜|false']);
    // 子项单写入以后不能改菜、不能删
    const [p] = await partsOf(line.id);
    await expect(ctx.sql`UPDATE kitchen_item_parts SET quantity = 5 WHERE id = ${p!.id}`).rejects.toThrow('子项单的菜品、份数与下单信息不可修改');
    await expect(ctx.sql`DELETE FROM kitchen_item_parts WHERE id = ${p!.id}`).rejects.toThrow('子项单禁止删除');
  });
});
