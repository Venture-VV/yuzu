// 8.1.17 平板电子菜单选做法、加料（BW9）与按出品口核对（BW3 平板那一半），docs/DISHES_V8117.md 第 5 节：
//   · 菜单的规格带做法（分组、加价、必选）与加料（各自的价、能不能点）；
//   · 下单带做法、加料挂在主菜上：与点单页同一个核对（必选、同一组、加价按份进单价、加料要是主菜配的）；加料不用排在电子菜单上；
//     出品单写「特辣 +¥2，不加香菜」「配 水煮鱼，不加香菜」；同一道菜做法不同的另起一行；
//   · 出品口：「点餐平板」岗位默认三处都能下单；店里去掉一处，菜单上那一处的菜写「请找服务员点」、下单被拒绝；
//     开着「点单密码」时输密码的服务员也要能在那一处下单；
//   · 套餐换菜（BW7）：菜单的规格带可换的几样（差价、今天还有没有）、套餐还能卖几份按子项里最少的；下单带换菜，差价进单价、
//     出品单写「可乐换橙汁 +¥3」；换法不同的另起一行。
// 全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dishBlock, type EmenuAdmin, type EmenuMenu, type EmenuSpecView } from '../src/shared/emenu';
import { resetLoginThrottle } from '../src/server/auth/lockout';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let pad: string;
let visitId = 0;
const item: Record<string, number> = {};
const station: Record<string, number> = {};

const admin = async () => (await api<EmenuAdmin>(ctx.app, ctx.owner, 'GET', '/api/admin/emenu')).body;
const rules = async (patch: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', '/api/admin/emenu/rules', { rev: (await admin()).rulesRev, ...patch });
const menu = async () => (await api<EmenuMenu>(ctx.app, pad, 'GET', '/api/emenu/menu')).body;
const specOf = async (itemId: number): Promise<EmenuSpecView> => {
  for (const c of (await menu()).categories) for (const p of c.pages) for (const d of p.dishes) for (const s of d?.specs ?? []) if (s.itemId === itemId) return s;
  throw new Error(`菜单上没有 ${itemId}`);
};
type Line = { itemId: number; quantity: number; methods?: string[]; addonOf?: number; swaps?: { from: number; to: number }[] };
const order = (lines: Line[], expectedTotal: number, o: { avoid?: string[]; pin?: string; key?: string } = {}) =>
  api(ctx.app, pad, 'POST', '/api/emenu/orders', {
    clientKey: o.key ?? randomUUID(),
    visitId,
    tagCode: 'A8001',
    tableName: 'A01',
    guests: 2,
    lines,
    avoid: o.avoid ?? [],
    serve: null,
    customNote: '',
    expectedTotal,
    ...(o.pin ? { pin: o.pin } : {}),
  });
const linesOf = () =>
  ctx.sql<{ id: number; name: string; unitPrice: number; quantity: number; amount: number; addonOf: number | null; note: string; status: string }[]>`
    SELECT l.id, l.name, l.unit_price, l.quantity, l.amount, l.addon_of, k.note, l.status
    FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id JOIN kitchen_items k ON k.bill_line_id = l.id WHERE v.id = ${visitId} ORDER BY l.id`;
const overrides = (value: Record<string, unknown>) =>
  ctx.sql`INSERT INTO settings (key, value) VALUES ('role_permissions', ${ctx.sql.json(value as never)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'pad8117', displayName: '一号桌平板', role: 'tablet', password: PASSWORD, mustChangePassword: false });
  pad = await login(ctx.app, 'pad8117');
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
  expect((await rules({ enabled: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'A', from: 8001, to: 8003, width: 4, zone: 'male' })).status).toBe(200);
  for (const name of ['厨房', '水吧']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name });
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  const dish = async (body: Record<string, unknown>) => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes', { clientKey: randomUUID(), category: '餐饮', ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    item[r.body.dish.name] = r.body.dish.id;
  };
  await dish({ name: '加蛋', slot: 'restaurant:餐饮', stationId: station['厨房'], prices: { standard: 300 } });
  await dish({
    name: '水煮鱼',
    slot: 'restaurant:餐饮',
    stationId: station['厨房'],
    prices: { standard: 3800 },
    methods: [
      { name: '微辣', group: '辣度', price: 0 },
      { name: '特辣', group: '辣度', price: 200 },
      { name: '免葱', group: '', price: 0 },
    ],
    methodGroups: [{ name: '辣度', required: true }],
    addons: [item['加蛋']],
  });
  await dish({ name: '柠檬茶', category: '饮品', slot: 'water:手作饮料', stationId: station['水吧'], prices: { standard: 1500 } });
  // 电子菜单：水煮鱼、柠檬茶排在一页上（加蛋不排）
  const em: Record<string, number> = {};
  for (const name of ['水煮鱼', '柠檬茶']) {
    const r = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', { name, specs: [{ itemId: item[name] }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    em[name] = r.body.dishes.find((d) => d.name === name)!.id;
  }
  const c = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/categories', { name: '午餐' });
  const cat = c.body.categories.find((x) => x.name === '午餐')!;
  const p = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/categories/${cat.id}/pages`, { version: cat.version, pages: [{ layout: 'duo_row', dishIds: [em['水煮鱼'], em['柠檬茶']] }] });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'A8001', zone: 'male' }] });
  visitId = v.body.visits[0].id;
});
afterAll(async () => ctx.close());
beforeEach(() => resetLoginThrottle());

describe('BW9 平板上选做法、加料', () => {
  it('菜单的规格带做法（分组、加价、必选）与加料；没有的规格不带', async () => {
    const fish = await specOf(item['水煮鱼']!);
    expect(fish.options).toEqual({
      methods: [
        { name: '微辣', group: '辣度', price: 0 },
        { name: '特辣', group: '辣度', price: 200 },
        { name: '免葱', group: '', price: 0 },
      ],
      groups: [{ name: '辣度', required: true }],
      addons: [{ itemId: item['加蛋'], name: '加蛋', price: 300, state: 'ok', remaining: null }],
    });
    expect(await specOf(item['柠檬茶']!)).not.toHaveProperty('options');
  });

  it('下单与点单页同一个核对：必选没选、同一组两个拒绝；加价进单价，加料另起一行挂在主菜上（不用排在电子菜单上），出品单写做法与整单备注', async () => {
    const missing = await order([{ itemId: item['水煮鱼']!, quantity: 1 }], 3800);
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('DISH_METHOD_REQUIRED');
    const two = await order([{ itemId: item['水煮鱼']!, quantity: 1, methods: ['微辣', '特辣'] }], 4000);
    expect(two.body.error.code).toBe('DISH_METHOD_GROUP');
    // 加料单点（没挂在主菜上）不在电子菜单上：照旧拒绝
    const alone = await order([{ itemId: item['加蛋']!, quantity: 1 }], 300);
    expect(alone.body.error.code).toBe('DISH_NOT_ON_MENU');
    const r = await order(
      [
        { itemId: item['水煮鱼']!, quantity: 1, methods: ['特辣', '免葱'] },
        { itemId: item['加蛋']!, quantity: 2, addonOf: 0 },
        { itemId: item['水煮鱼']!, quantity: 1, methods: ['微辣'] },
      ],
      3800 + 200 + 600 + 3800,
      { avoid: ['不加香菜'] },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.total).toBe(8400);
    const lines = await linesOf();
    expect(lines.map((l) => `${l.name}|${l.unitPrice}|${l.amount}|${l.note}`)).toEqual([
      '水煮鱼|4000|4000|特辣 +¥2，免葱，不加香菜',
      '加蛋|300|600|配 水煮鱼，不加香菜',
      '水煮鱼|3800|3800|微辣，不加香菜',
    ]);
    expect(lines[1]!.addonOf).toBe(lines[0]!.id);
    // 已下单里照样列出来、合计对得上
    expect(r.body.guest.orderedTotal).toBe(8400);
  });

  it('同一道菜同样的做法要合成一行；价格以门店系统为准', async () => {
    const dup = await order(
      [
        { itemId: item['水煮鱼']!, quantity: 1, methods: ['微辣'] },
        { itemId: item['水煮鱼']!, quantity: 1, methods: ['微辣'] },
      ],
      7600,
    );
    expect(dup.status).toBe(400);
    const stale = await order([{ itemId: item['水煮鱼']!, quantity: 1, methods: ['特辣'] }], 3800);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PRICE_CHANGED');
  });
});

describe('BW3 平板下单按出品口核对', () => {
  it('「点餐平板」岗位默认三处都能下单', async () => {
    const me = (await api(ctx.app, pad, 'GET', '/api/auth/me')).body;
    expect(me.permissions).toEqual(expect.arrayContaining(['dining.orderRestaurant', 'dining.orderWater', 'dining.orderFruit']));
    expect((await specOf(item['柠檬茶']!)).state).toBe('ok');
  });

  it('店里给「点餐平板」去掉水吧：菜单上水吧的菜写「请找服务员点」、下单被拒绝；餐厅的照常', async () => {
    await overrides({ tablet: { add: [], remove: ['dining.orderWater'] } });
    const tea = await specOf(item['柠檬茶']!);
    expect(tea.state).toBe('unavailable');
    expect(dishBlock({ specs: [tea] }, true)).toBe('unavailable');
    expect((await specOf(item['水煮鱼']!)).state).toBe('ok');
    const r = await order([{ itemId: item['柠檬茶']!, quantity: 1 }], 1500);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('OUTLET_FORBIDDEN');
    expect(r.body.error.message).toContain('这台平板不能点「柠檬茶」');
    // 加料在不能下单的出品口：菜单上标出来（这里加蛋在餐厅，照常能点）
    expect((await specOf(item['水煮鱼']!)).options!.addons[0]!.state).toBe('ok');
    expect((await order([{ itemId: item['水煮鱼']!, quantity: 1, methods: ['微辣'] }], 3800)).status).toBe(200);
    // 后台预览（店主）不受平板岗位的限制
    const preview = (await api<EmenuMenu>(ctx.app, ctx.owner, 'GET', '/api/emenu/menu')).body;
    const teaForOwner = preview.categories.flatMap((c) => c.pages.flatMap((p) => p.dishes)).find((d) => d?.name === '柠檬茶')!;
    expect(teaForOwner.specs[0]!.state).toBe('ok');
  });

  it('开着「点单密码」：输密码的服务员也要能在那一处下单', async () => {
    await overrides({ clerk: { add: [], remove: ['dining.orderRestaurant'] } });
    expect((await rules({ requirePin: true })).status).toBe(200);
    const pin = (await api(ctx.app, ctx.owner, 'POST', `/api/staff/${ctx.clerkId}/order-pin`)).body.pin as string;
    const r = await order([{ itemId: item['水煮鱼']!, quantity: 1, methods: ['微辣'] }], 3800, { pin });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('OUTLET_FORBIDDEN');
    expect(r.body.error.message).toContain('测试店员不能在这一处下单');
    await overrides({});
    expect((await order([{ itemId: item['水煮鱼']!, quantity: 1, methods: ['微辣'] }], 3800, { pin })).status).toBe(200);
    expect((await rules({ requirePin: false })).status).toBe(200);
  });
});

describe('BW7 平板上换菜', () => {
  beforeAll(async () => {
    const dish = async (body: Record<string, unknown>) => {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes', { clientKey: randomUUID(), category: '餐饮', ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      item[r.body.dish.name] = r.body.dish.id;
    };
    await dish({ name: '米饭', slot: 'restaurant:餐饮', stationId: station['厨房'], prices: { standard: 200 } });
    await dish({ name: '可乐', category: '饮品', slot: 'water:手作饮料', stationId: station['水吧'], prices: { standard: 800 } });
    await dish({ name: '橙汁', category: '饮品', slot: 'water:手作饮料', stationId: station['水吧'], prices: { standard: 1200 } });
    await dish({
      name: '快餐套餐',
      slot: 'restaurant:餐饮',
      stationId: station['厨房'],
      prices: { standard: 4800 },
      combo: [
        { itemId: item['米饭'], quantity: 1 },
        { itemId: item['可乐'], quantity: 1, swappable: true, swaps: [{ itemId: item['橙汁'], priceDiff: 300 }] },
      ],
    });
    const r = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', { name: '快餐套餐', specs: [{ itemId: item['快餐套餐'] }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const set = r.body.dishes.find((d) => d.name === '快餐套餐')!.id;
    const a = await admin();
    const cat = a.categories.find((x) => x.name === '午餐')!;
    const p = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/categories/${cat.id}/pages`, {
      version: cat.version,
      pages: [...cat.pages.map((x) => ({ layout: x.layout, dishIds: x.dishIds })), { layout: 'single_wide', dishIds: [set] }],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  });

  it('菜单的规格带可换的几样（差价、今天还有没有）；套餐还能卖几份按子项里最少的', async () => {
    const set = await specOf(item['快餐套餐']!);
    expect(set.options).toEqual({
      methods: [],
      groups: [],
      addons: [],
      swaps: [{ itemId: item['可乐'], name: '可乐', quantity: 1, state: 'ok', choices: [{ itemId: item['橙汁'], name: '橙汁', priceDiff: 300, state: 'ok' }] }],
    });
    expect(set.remaining).toBeNull();
    const limit = (id: number, remaining: number | null) => api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${id}`, { remaining });
    expect((await limit(item['米饭']!, 2)).status).toBe(200);
    expect((await specOf(item['快餐套餐']!)).remaining).toBe(2);
    expect((await limit(item['米饭']!, 0)).status).toBe(200);
    expect((await specOf(item['快餐套餐']!)).state).toBe('sold_out');
    expect((await limit(item['米饭']!, null)).status).toBe(200);
    // 可乐卖完了：可以换橙汁，套餐照卖；可乐那一项标售罄
    expect((await limit(item['可乐']!, 0)).status).toBe(200);
    const noCola = await specOf(item['快餐套餐']!);
    expect(noCola.state).toBe('ok');
    expect(noCola.options!.swaps![0]!.state).toBe('sold_out');
    const plain = await order([{ itemId: item['快餐套餐']!, quantity: 1 }], 4800);
    expect(plain.status).toBe(409);
    expect(plain.body.error.code).toBe('DISH_SOLD_OUT');
    expect((await limit(item['可乐']!, null)).status).toBe(200);
  });

  it('下单带换菜：差价进单价、出品单写换了什么；换法不同的另起一行，一样的要合成一行', async () => {
    const before = (await linesOf()).length;
    const swap = [{ from: item['可乐']!, to: item['橙汁']! }];
    const dup = await order(
      [
        { itemId: item['快餐套餐']!, quantity: 1, swaps: swap },
        { itemId: item['快餐套餐']!, quantity: 1, swaps: swap },
      ],
      10200,
    );
    expect(dup.status).toBe(400);
    const r = await order(
      [
        { itemId: item['快餐套餐']!, quantity: 1, swaps: swap },
        { itemId: item['快餐套餐']!, quantity: 2 },
      ],
      5100 + 4800 * 2,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await linesOf()).slice(before).map((l) => `${l.name}|${l.unitPrice}|${l.quantity}|${l.note}`)).toEqual(['快餐套餐|5100|1|可乐换橙汁 +¥3', '快餐套餐|4800|2|']);
    // 子项单：可乐 / 橙汁在水吧单独出
    const parts = await ctx.sql<{ name: string; split: boolean; quantity: number }[]>`
      SELECT p.name, p.split, p.quantity FROM kitchen_item_parts p JOIN kitchen_items k ON k.id = p.kitchen_item_id JOIN bill_lines l ON l.id = k.bill_line_id
      JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${visitId} ORDER BY p.id`;
    expect(parts.map((p) => `${p.name}|${p.split}|${p.quantity}`)).toEqual(['米饭|false|1', '橙汁|true|1', '米饭|false|2', '可乐|true|2']);
  });
});
