// 8.1.17 菜品补完（docs/DISHES_V8117.md，默认做法 docs/PENDING_DECISIONS.md BW5、BW6、BW8、BW10）：
//   · BW6 做法分组、加价、必选：维护（分组、加价、必选的组，只交名字的保留原来的分组与加价）；点单页、桌台按同一套核对
//     （不认识的、同一组两个、必选没选），加价按份加进这一行的单价，出品单与账单上写「特辣 +¥2」；价格以服务端为准；
//     前台「加项目」不查必选；结账、台账、点菜单的金额对得上；Excel 一格的写法能原样导出导回；
//   · BW5 点单选规格（档）：多档的菜菜单上带各档的价，下单按选的档计价，账单与出品单写档名；没有的档拒绝。
// 全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { slotKey, type DiningLedger, type DiningMenu, type DiningReceipt, type KitchenItem } from '../src/shared/dining';
import { methodsCellText, parseMethodsCell, type DishRow, type DishesBoard } from '../src/shared/dishes';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let tagNo = 0;
const station: Record<string, number> = {};

const board = async () => {
  const r = await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as DishesBoard;
};
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
const enter = async () => {
  tagNo += 1;
  const code = `N${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.visits[0].id as number, code };
};
type OrderLine = { itemId: number; quantity: number; note?: string; tier?: string; methods?: string[]; addonOf?: number };
const orderTag = (visitId: number, lines: OrderLine[], expectedTotal: number, key: string = randomUUID()) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: key, visitId, lines, expectedTotal });
const kitchen = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/kitchen')).body.items as KitchenItem[];
const billLines = (visitId: number) => ctx.sql<{ id: number; name: string; tier: string | null; unitPrice: number; quantity: number; amount: number; addonOf: number | null; status: string }[]>`
  SELECT l.id, l.name, l.tier, l.unit_price, l.quantity, l.amount, l.addon_of, l.status FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${visitId} ORDER BY l.id`;
const billAmount = async (visitId: number) => (await ctx.sql<{ amountCents: number }[]>`SELECT b.amount_cents FROM bills b JOIN visits v ON v.bill_id = b.id WHERE v.id = ${visitId}`)[0]!.amountCents;

/** 水煮鱼：辣度（必选）微辣 / 中辣 / 特辣 +¥2；冰量 少冰 / 去冰；不分组的免葱、加芝士 +¥5 */
const FISH_METHODS = [
  { name: '微辣', group: '辣度', price: 0 },
  { name: '中辣', group: '辣度', price: 0 },
  { name: '特辣', group: '辣度', price: 200 },
  { name: '少冰', group: '冰量', price: 0 },
  { name: '去冰', group: '冰量', price: 0 },
  { name: '免葱', group: '', price: 0 },
  { name: '加芝士', group: '', price: 500 },
];
const FISH_GROUPS = [
  { name: '辣度', required: true },
  { name: '冰量', required: false },
];

beforeAll(async () => {
  ctx = await setup();
  today = (await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body.today;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true, tablesEnabled: true, trackServed: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'N', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const name of ['热菜', '水吧']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  const fish = await create({
    name: '水煮鱼',
    category: '餐饮',
    slot: 'restaurant:餐饮',
    stationId: station['热菜'],
    prices: { standard: 3800, premium: 5800 },
    methods: FISH_METHODS,
    methodGroups: FISH_GROUPS,
  });
  expect(fish.status, JSON.stringify(fish.body)).toBe(201);
  const tea = await create({ name: '柠檬茶', category: '饮品', slot: 'water:手作饮料', stationId: station['水吧'], prices: { standard: 1500 }, methods: ['少冰', '去冰'] });
  expect(tea.status, JSON.stringify(tea.body)).toBe(201);
});
afterAll(async () => ctx.close());

describe('BW6 做法分组、加价、必选：维护', () => {
  it('菜品表带出做法的分组、加价与必选；做法的名字照旧按顺序；审计按 Excel 一格的写法记', async () => {
    const d = await dishOf('水煮鱼');
    expect(d.methods).toEqual(FISH_METHODS.map((m) => m.name));
    expect(d.methodOptions).toEqual(FISH_METHODS);
    expect(d.methodGroups).toEqual(FISH_GROUPS);
    expect(methodsCellText(d.methodOptions, d.methodGroups)).toBe('辣度（必选）：微辣、中辣、特辣+2；冰量：少冰、去冰；免葱、加芝士+5');
    // 只写名字的老写法：不分组、不加钱
    const tea = await dishOf('柠檬茶');
    expect(tea.methodOptions).toEqual([
      { name: '少冰', group: '', price: 0 },
      { name: '去冰', group: '', price: 0 },
    ]);
    expect(tea.methodGroups).toEqual([]);
  });

  it('只交做法名字的保存（8.1.15 的页面、旧的导入）：同名的保留原来的分组与加价，新的不分组不加钱；没改什么不动这一行', async () => {
    const d = await dishOf('水煮鱼');
    const same = await update(d, {});
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body.dish.rev).toBe(d.rev);
    const r = await update(d, { methods: [...d.methods, '加饭'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.dish.methodOptions).toEqual([...FISH_METHODS, { name: '加饭', group: '', price: 0 }]);
    expect(r.body.dish.methodGroups).toEqual(FISH_GROUPS);
    const [audit] = await ctx.sql<{ summary: string }[]>`SELECT detail->>'summary' AS summary FROM audit_logs WHERE action = 'dish_saved' ORDER BY id DESC LIMIT 1`;
    expect(audit!.summary).toContain('做法 辣度（必选）：微辣、中辣、特辣+2；冰量：少冰、去冰；免葱、加芝士+5 → 辣度（必选）：微辣、中辣、特辣+2；冰量：少冰、去冰；免葱、加芝士+5、加饭');
    // 改回去：带分组交（新页面的写法）
    const back = await update(r.body.dish, { methods: FISH_METHODS, methodGroups: FISH_GROUPS });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.dish.methodOptions).toEqual(FISH_METHODS);
  });

  it('分组的规矩：做法的组要写在分组里、每组至少一种、组名不重复；加价不超过 ¥999、不为负；名字里不能带加号、冒号', async () => {
    const d = await dishOf('柠檬茶');
    const stray = await update(d, { methods: [{ name: '少冰', group: '冰量', price: 0 }], methodGroups: [] });
    expect(stray.status).toBe(422);
    expect(stray.body.error.code).toBe('DISH_METHOD_GROUP_UNKNOWN');
    const empty = await update(d, { methods: [{ name: '少冰', group: '', price: 0 }], methodGroups: [{ name: '冰量', required: true }] });
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('DISH_METHOD_GROUP_EMPTY');
    const dupGroup = await update(d, {
      methods: [{ name: '少冰', group: '冰量', price: 0 }],
      methodGroups: [
        { name: '冰量', required: true },
        { name: '冰量', required: false },
      ],
    });
    expect(dupGroup.status).toBe(400);
    const pricey = await update(d, { methods: [{ name: '少冰', group: '', price: 100_000 }], methodGroups: [] });
    expect(pricey.status).toBe(400);
    const negative = await update(d, { methods: [{ name: '少冰', group: '', price: -100 }], methodGroups: [] });
    expect(negative.status).toBe(400);
    const plus = await update(d, { methods: ['加+冰'] });
    expect(plus.status).toBe(400);
    expect((await dishOf('柠檬茶')).rev).toBe(d.rev);
  });

  it('Excel「做法」一格：分组、必选、加价原样写出、读回；只写名字的照样认；写错的给出原因', () => {
    const d = { options: FISH_METHODS, groups: FISH_GROUPS };
    const text = methodsCellText(d.options, d.groups);
    expect(parseMethodsCell(text)).toEqual(d);
    expect(parseMethodsCell('微辣、免葱')).toEqual({
      options: [
        { name: '微辣', group: '', price: 0 },
        { name: '免葱', group: '', price: 0 },
      ],
      groups: [],
    });
    expect(parseMethodsCell('甜度(必选): 少糖+1.5 / 无糖')).toEqual({
      options: [
        { name: '少糖', group: '甜度', price: 150 },
        { name: '无糖', group: '甜度', price: 0 },
      ],
      groups: [{ name: '甜度', required: true }],
    });
    expect(parseMethodsCell('辣度：微辣；辣度：中辣')).toEqual({ error: '做法的组「辣度」写了两次' });
    expect(parseMethodsCell('辣度：')).toEqual({ error: '做法的组「辣度」里还没有做法' });
    expect(parseMethodsCell('微辣、微辣')).toEqual({ error: '做法「微辣」写了两次' });
  });

  it('导出的「做法」是新写法，原样导回什么都不改；改一格的预览里写出改了什么', async () => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/import/preview', {
      fileName: '菜品.csv',
      csv: `编号,名称,做法\n${(await dishOf('水煮鱼')).id},水煮鱼,"${methodsCellText(FISH_METHODS, FISH_GROUPS)}"\n`,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ unchangedCount: 1, updateCount: 0, issues: [] });
    const changed = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/import/preview', {
      fileName: '菜品.csv',
      csv: `编号,名称,做法\n${(await dishOf('水煮鱼')).id},水煮鱼,"辣度（必选）：微辣、特辣+3；免葱"\n`,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.updateCount).toBe(1);
    expect(changed.body.changes[0].fields[0]).toBe('做法 辣度（必选）：微辣、中辣、特辣+2；冰量：少冰、去冰；免葱、加芝士+5 → 辣度（必选）：微辣、特辣+3；免葱');
    const bad = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/import/preview', {
      fileName: '菜品.csv',
      csv: `编号,名称,做法\n${(await dishOf('水煮鱼')).id},水煮鱼,"辣度：；免葱"\n`,
    });
    expect(bad.body.issues[0].message).toContain('做法的组「辣度」里还没有做法');
  });
});

describe('BW6 做法分组、加价、必选：点单', () => {
  it('菜单带做法的分组与加价（只有名字的菜照旧只带名字与 methodOptions）', async () => {
    const m = await menu();
    const fish = m.dishes.find((d) => d.name === '水煮鱼')!;
    expect(fish.methods).toEqual(FISH_METHODS.map((x) => x.name));
    expect(fish.methodOptions).toEqual(FISH_METHODS);
    expect(fish.methodGroups).toEqual(FISH_GROUPS);
    const tea = m.dishes.find((d) => d.name === '柠檬茶')!;
    expect(tea).not.toHaveProperty('methodGroups');
  });

  it('点单页：必选的组没选、同一组选两个、不认识的做法都拒绝，什么都没记', async () => {
    const fish = await dishOf('水煮鱼');
    const v = await enter();
    const missing = await orderTag(v.id, [{ itemId: fish.id, quantity: 1, methods: ['少冰'] }], 3800);
    expect(missing.status).toBe(422);
    expect(missing.body.error).toMatchObject({ code: 'DISH_METHOD_REQUIRED', message: '「水煮鱼」要先选「辣度」' });
    const two = await orderTag(v.id, [{ itemId: fish.id, quantity: 1, methods: ['微辣', '中辣'] }], 3800);
    expect(two.status).toBe(422);
    expect(two.body.error.code).toBe('DISH_METHOD_GROUP');
    const unknown = await orderTag(v.id, [{ itemId: fish.id, quantity: 1, methods: ['微辣', '麻辣'] }], 3800);
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('DISH_METHOD_INVALID');
    expect(await billLines(v.id)).toEqual([]);
  });

  it('加价按份加进单价（价格以服务端为准）；出品单、账单上写「特辣 +¥2」；合计、台账、点菜单对得上', async () => {
    const fish = await dishOf('水煮鱼');
    const tea = await dishOf('柠檬茶');
    const v = await enter();
    const lines = [
      { itemId: fish.id, quantity: 2, methods: ['加芝士', '特辣', '去冰'], note: '鱼片厚一点' },
      { itemId: tea.id, quantity: 1, methods: ['去冰'] },
    ];
    // 页面按菜单原价算的合计：对不上拒绝
    const stale = await orderTag(v.id, lines, 3800 * 2 + 1500);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PRICE_CHANGED');
    const total = (3800 + 200 + 500) * 2 + 1500;
    const r = await orderTag(v.id, lines, total);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await billLines(v.id)).toMatchObject([
      { name: '水煮鱼（标准）', tier: 'standard', unitPrice: 4500, quantity: 2, amount: 9000, addonOf: null },
      { name: '柠檬茶', unitPrice: 1500, quantity: 1, amount: 1500 },
    ]);
    expect(await billAmount(v.id)).toBe(total);
    // 出品单：做法按维护时的顺序，带加价的写「+¥2」，手写的接在后面
    const mine = (await kitchen()).filter((k) => k.visitId === v.id);
    expect(mine.map((k) => `${k.name}|${k.note}`)).toEqual(['水煮鱼（标准）|特辣 +¥2，去冰，加芝士 +¥5，鱼片厚一点', '柠檬茶|去冰']);
    // 前台账单上的这一行：单价、金额就是收的钱，备注写着加价
    const visit = (await api(ctx.app, ctx.owner, 'GET', `/api/frontdesk/visits/${v.id}`)).body;
    const line = visit.lines.find((l: { name: string }) => l.name === '水煮鱼（标准）');
    expect(line).toMatchObject({ unitPrice: 4500, amount: 9000, kitchen: { note: '特辣 +¥2，去冰，加芝士 +¥5，鱼片厚一点' } });
    // 台账与点菜单：金额对得上
    const ledger = (await api(ctx.app, ctx.owner, 'GET', `/api/dining/ledger?from=${today}&to=${today}`)).body as DiningLedger;
    const rows = ledger.rows.filter((x) => x.tagCode === v.code);
    expect(rows.map((x) => `${x.name}|${x.unitPrice}|${x.amount}`)).toEqual(['水煮鱼（标准）|4500|9000', '柠檬茶|1500|1500']);
    const receipt = (await api(ctx.app, ctx.owner, 'GET', `/api/dining/receipt?visit=${v.id}`)).body as DiningReceipt;
    expect(receipt.totals.amount).toBe(total);
    // 结账核对的应收与账单一致
    const preview = await api(ctx.app, ctx.owner, 'GET', `/api/frontdesk/checkout-preview?ids=${v.id}`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.visits[0].linesAmount).toBe(total);
  });

  it('同一个操作编号原样重提只记一次；前台「加项目」不查必选（还选不了做法），带了做法照样核对', async () => {
    const fish = await dishOf('水煮鱼');
    const v = await enter();
    const key = randomUUID();
    const lines = [{ itemId: fish.id, quantity: 1, methods: ['微辣'] }];
    expect((await orderTag(v.id, lines, 3800, key)).status).toBe(200);
    expect((await orderTag(v.id, lines, 3800, key)).status).toBe(200);
    expect((await billLines(v.id)).length).toBe(1);
    const desk = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/charges`, { clientKey: randomUUID(), lines: [{ itemId: fish.id, quantity: 1 }], expectedTotal: 3800 });
    expect(desk.status, JSON.stringify(desk.body)).toBe(200);
    const deskTwo = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/charges`, {
      clientKey: randomUUID(),
      lines: [{ itemId: fish.id, quantity: 1, methods: ['微辣', '特辣'] }],
      expectedTotal: 4000,
    });
    expect(deskTwo.status).toBe(422);
    expect(deskTwo.body.error.code).toBe('DISH_METHOD_GROUP');
    // 不进厨房的项目不能带做法
    const item = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '浴巾', category: '用品', price: 1000 });
    const towel = item.body.items.find((i: { name: string }) => i.name === '浴巾').id as number;
    const bad = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v.id}/charges`, {
      clientKey: randomUUID(),
      lines: [{ itemId: towel, quantity: 1, methods: ['微辣'] }],
      expectedTotal: 1000,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('DISH_OPTIONS_NOT_ALLOWED');
  });

  it('桌台点单同一套：必选核对、加价进单价；规格按选的档', async () => {
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: 'B1', seats: 4 });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const tableId = t.body.tables.find((x: { name: string }) => x.name === 'B1').id;
    const open = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const fish = await dishOf('水煮鱼');
    const url = `/api/dining/tables/sessions/${open.body.id}/orders`;
    const missing = await api(ctx.app, ctx.clerk, 'POST', url, { clientKey: randomUUID(), lines: [{ itemId: fish.id, quantity: 1 }], expectedTotal: 3800 });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('DISH_METHOD_REQUIRED');
    const r = await api(ctx.app, ctx.clerk, 'POST', url, { clientKey: randomUUID(), lines: [{ itemId: fish.id, quantity: 1, tier: 'premium', methods: ['特辣'] }], expectedTotal: 6000 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.lines.map((l: { name: string; unitPrice: number; amount: number }) => `${l.name}|${l.unitPrice}|${l.amount}`)).toEqual(['水煮鱼（优选）|6000|6000']);
    expect(r.body.amount).toBe(6000);
  });
});

describe('BW5 点单选规格（档）', () => {
  it('多档的菜菜单上带各档的价，只有一档的不带', async () => {
    const m = await menu();
    expect(m.dishes.find((d) => d.name === '水煮鱼')!.prices).toEqual([
      { tier: 'standard', price: 3800 },
      { tier: 'premium', price: 5800 },
    ]);
    expect(m.dishes.find((d) => d.name === '柠檬茶')).not.toHaveProperty('prices');
  });

  it('按选的档计价：账单与出品单写档名；这道菜没有的档拒绝；不带档的照旧按默认档', async () => {
    const fish = await dishOf('水煮鱼');
    const v = await enter();
    const r = await orderTag(v.id, [{ itemId: fish.id, quantity: 1, tier: 'premium', methods: ['中辣'] }], 5800);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await billLines(v.id)).toMatchObject([{ name: '水煮鱼（优选）', tier: 'premium', unitPrice: 5800 }]);
    expect((await kitchen()).filter((k) => k.visitId === v.id).map((k) => k.name)).toEqual(['水煮鱼（优选）']);
    // 点单页「还没上的菜」也写档名
    const guest = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/guest?tag=${v.code}`)).body;
    expect(guest.pending.map((p: { name: string }) => p.name)).toEqual(['水煮鱼（优选）']);
    const none = await orderTag(v.id, [{ itemId: fish.id, quantity: 1, tier: 'professional', methods: ['中辣'] }], 3800);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('ITEM_UNAVAILABLE');
    const plain = await orderTag(v.id, [{ itemId: fish.id, quantity: 1, methods: ['中辣'] }], 3800);
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect((await billLines(v.id)).map((l) => `${l.name}|${l.unitPrice}`)).toEqual(['水煮鱼（优选）|5800', '水煮鱼（标准）|3800']);
  });
});

describe('BW8 加料挂在主菜上、退主菜带加料', () => {
  let noodle: DishRow;
  let egg: DishRow;
  let beef: DishRow;
  let duty: string;
  beforeAll(async () => {
    await createStaff(ctx.sql, { username: 'duty8117', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
    duty = await login(ctx.app, 'duty8117');
    expect((await create({ name: '加蛋', category: '餐饮', slot: 'restaurant:餐饮', stationId: station['热菜'], prices: { standard: 300 } })).status).toBe(201);
    expect((await create({ name: '加牛肉', category: '餐饮', slot: 'restaurant:餐饮', stationId: station['热菜'], prices: { standard: 6000 } })).status).toBe(201);
    egg = await dishOf('加蛋');
    beef = await dishOf('加牛肉');
    const r = await create({ name: '牛肉面', category: '餐饮', slot: 'restaurant:餐饮', stationId: station['热菜'], prices: { standard: 6800 }, addons: [egg.id, beef.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    noodle = await dishOf('牛肉面');
    // 加蛋今天限量 10 份（退的时候按原份数加回）
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${egg.id}`, { remaining: 10 })).status).toBe(200);
  });
  const remainingOf = async (id: number) => (await menu()).dishes.find((d) => d.id === id)!.remaining;
  const voidFront = (lineId: number, body: Record<string, unknown>, cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', `/api/frontdesk/lines/${lineId}/void`, body);

  it('下单时加料挂在主菜那一行上（addonOf 是同一次下单里主菜的下标），出品单写「配 主菜」；不是主菜配的加料、写在主菜前面、配在加料上的都拒绝', async () => {
    const v = await enter();
    const wrongOrder = await orderTag(
      v.id,
      [
        { itemId: egg.id, quantity: 1, addonOf: 1 },
        { itemId: noodle.id, quantity: 1 },
      ],
      7100,
    );
    expect(wrongOrder.status).toBe(400);
    const notAddon = await orderTag(
      v.id,
      [
        { itemId: noodle.id, quantity: 1 },
        { itemId: (await dishOf('柠檬茶')).id, quantity: 1, addonOf: 0 },
      ],
      8300,
    );
    expect(notAddon.status).toBe(422);
    expect(notAddon.body.error.code).toBe('DISH_ADDON_INVALID');
    const nested = await orderTag(
      v.id,
      [
        { itemId: noodle.id, quantity: 1 },
        { itemId: egg.id, quantity: 1, addonOf: 0 },
        { itemId: beef.id, quantity: 1, addonOf: 1 },
      ],
      13100,
    );
    expect(nested.status).toBe(422);
    expect(nested.body.error.code).toBe('DISH_ADDON_INVALID');
    const r = await orderTag(
      v.id,
      [
        { itemId: noodle.id, quantity: 1, note: '面硬一点' },
        { itemId: egg.id, quantity: 2, addonOf: 0 },
      ],
      6800 + 600,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [main, add] = await billLines(v.id);
    expect(add).toMatchObject({ name: '加蛋', addonOf: main!.id, amount: 600 });
    expect((await kitchen()).filter((k) => k.visitId === v.id).map((k) => `${k.name}|${k.note}`)).toEqual(['牛肉面|面硬一点', '加蛋|配 牛肉面']);
    // 前台账单的明细带 addonOf；点单页「还没上的菜」主菜带它的加料
    const visit = (await api(ctx.app, ctx.owner, 'GET', `/api/frontdesk/visits/${v.id}`)).body;
    expect(visit.lines.map((l: { addonOf: number | null }) => l.addonOf)).toEqual([null, main!.id]);
    const guest = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/guest?tag=${v.code}`)).body;
    expect(guest.pending[0]).toMatchObject({ name: '牛肉面', addonOf: null, addons: [{ billLineId: add!.id, name: '加蛋', quantity: 2, amount: 600 }] });
    expect(guest.pending[1]).toMatchObject({ addonOf: main!.id, addons: [] });
  });

  it('退主菜勾上「加料一起退」：同一个事务里一起退，照主菜的原因；出品单改已退、沽清加回、账单冲减，各记一条审计；不勾的只退主菜', async () => {
    const v = await enter();
    const before = await remainingOf(egg.id);
    expect(
      (
        await orderTag(
          v.id,
          [
            { itemId: noodle.id, quantity: 1 },
            { itemId: egg.id, quantity: 2, addonOf: 0 },
          ],
          7400,
        )
      ).status,
    ).toBe(200);
    expect(await remainingOf(egg.id)).toBe(before! - 2);
    const [main, add] = await billLines(v.id);
    // 主菜 ¥68 超过小额上限：店员退要经理授权；值班经理自己退直接退
    const r = await voidFront(main!.id, { reason: '客人不要了', blame: 'guest', withAddons: true }, duty);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await billLines(v.id)).map((l) => `${l.name}|${l.status}`)).toEqual(['牛肉面|voided', '加蛋|voided']);
    expect(await billAmount(v.id)).toBe(0);
    expect((await kitchen()).filter((k) => k.visitId === v.id).map((k) => k.status)).toEqual(['cancelled', 'cancelled']);
    expect(await remainingOf(egg.id)).toBe(before);
    const reasons = await ctx.sql<{ voidReason: string }[]>`SELECT void_reason FROM bill_lines WHERE id IN ${ctx.sql([main!.id, add!.id])} ORDER BY id`;
    expect(reasons.map((x) => x.voidReason)).toEqual(['客人不要了', '客人不要了']);
    const audits = await ctx.sql<
      { detail: Record<string, unknown> }[]
    >`SELECT detail FROM audit_logs WHERE action = 'frontdesk_void' AND (detail->>'lineId')::bigint IN ${ctx.sql([main!.id, add!.id])} ORDER BY id`;
    // 每一行照退菜原来的核对：主菜 ¥68 是经理退的，¥6 的加料本来就是小额直接退
    expect(audits.map((a) => [a.detail.lineId, a.detail.addonOf ?? null, a.detail.approval, a.detail.blame])).toEqual([
      [main!.id, null, 'manager', 'guest'],
      [add!.id, main!.id, 'small', 'guest'],
    ]);
    // 台账：加料那一行也写着怎么批的
    const ledger = (await api(ctx.app, ctx.owner, 'GET', `/api/dining/ledger?from=${today}&to=${today}&type=voided`)).body as DiningLedger;
    expect(ledger.rows.filter((x) => x.tagCode === v.code).map((x) => `${x.name}|${x.approvalText}|${x.blame}`)).toEqual(['牛肉面|经理|guest', '加蛋|小额直接退|guest']);

    // 不勾：只退主菜，加料照旧
    const v2 = await enter();
    expect(
      (
        await orderTag(
          v2.id,
          [
            { itemId: noodle.id, quantity: 1 },
            { itemId: egg.id, quantity: 1, addonOf: 0 },
          ],
          7100,
        )
      ).status,
    ).toBe(200);
    const [main2] = await billLines(v2.id);
    expect((await voidFront(main2!.id, { reason: '客人不要了' }, duty)).status).toBe(200);
    expect((await billLines(v2.id)).map((l) => `${l.name}|${l.status}`)).toEqual(['牛肉面|voided', '加蛋|active']);
  });

  it('授权：主菜用当场授权退的，加料照这一次授权；主菜不用授权、加料要的整笔拒绝（先只退主菜、再单独退加料）', async () => {
    // 店主下的单：店员退大额的菜不是「本人 15 分钟内」，要授权
    const byOwner = (visitId: number, lines: OrderLine[], expectedTotal: number) => api(ctx.app, ctx.owner, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines, expectedTotal });
    const v = await enter();
    expect(
      (
        await byOwner(
          v.id,
          [
            { itemId: noodle.id, quantity: 1 },
            { itemId: beef.id, quantity: 1, addonOf: 0 },
            { itemId: egg.id, quantity: 1, addonOf: 0 },
          ],
          6800 + 6000 + 300,
        )
      ).status,
    ).toBe(200);
    const [main, big, small] = await billLines(v.id);
    const denied = await voidFront(main!.id, { reason: '上错了', withAddons: true });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('VOID_NEEDS_GRANT');
    const g = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', { username: 'duty8117', password: PASSWORD, purpose: 'line_void', scope: { lineId: main!.id, reason: '上错了' } });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const r = await voidFront(main!.id, { reason: '上错了', withAddons: true, grantId: g.body.grantId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await billLines(v.id)).map((l) => l.status)).toEqual(['voided', 'voided', 'voided']);
    const audits = await ctx.sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM audit_logs WHERE action = 'frontdesk_void' AND (detail->>'lineId')::bigint IN ${ctx.sql([main!.id, big!.id, small!.id])} ORDER BY (detail->>'lineId')::bigint`;
    // 大额的加料照主菜的授权；小额的加料本来就能直接退
    expect(audits.map((a) => `${a.detail.approval}|${a.detail.approverName ?? ''}`)).toEqual(['grant|值班经理', 'grant|值班经理', 'small|']);

    // 主菜小额（¥18 的鸡蛋面）、加料大额（¥60 的加牛肉）：小额的主菜申请不到授权，整笔拒绝，请先只退主菜、再单独退加料
    expect((await create({ name: '鸡蛋面', category: '餐饮', slot: 'restaurant:餐饮', stationId: station['热菜'], prices: { standard: 1800 }, addons: [beef.id] })).status).toBe(201);
    const cheap = await dishOf('鸡蛋面');
    const v3 = await enter();
    expect(
      (
        await byOwner(
          v3.id,
          [
            { itemId: cheap.id, quantity: 1 },
            { itemId: beef.id, quantity: 1, addonOf: 0 },
          ],
          7800,
        )
      ).status,
    ).toBe(200);
    const [main3] = await billLines(v3.id);
    const blocked = await voidFront(main3!.id, { reason: '上错了', withAddons: true });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ADDON_NEEDS_GRANT');
    expect((await billLines(v3.id)).map((l) => l.status)).toEqual(['active', 'active']);
    expect((await voidFront(main3!.id, { reason: '上错了' })).status).toBe(200);
    // 本人下的、15 分钟内：主菜与加料都是「本人」，一起退
    const v2 = await enter();
    expect(
      (
        await orderTag(
          v2.id,
          [
            { itemId: cheap.id, quantity: 1 },
            { itemId: beef.id, quantity: 1, addonOf: 0 },
          ],
          7800,
        )
      ).status,
    ).toBe(200);
    const [main2, beef2] = await billLines(v2.id);
    expect(beef2!.addonOf).toBe(main2!.id);
    expect((await voidFront(main2!.id, { reason: '上错了', withAddons: true })).status).toBe(200);
    expect((await billLines(v2.id)).map((l) => l.status)).toEqual(['voided', 'voided']);
  });

  it('桌台退菜同一套：勾上一起退、照主菜的原因与授权', async () => {
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: 'B2', seats: 4 });
    const tableId = t.body.tables.find((x: { name: string }) => x.name === 'B2').id;
    const open = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${open.body.id}/orders`, {
      clientKey: randomUUID(),
      lines: [
        { itemId: noodle.id, quantity: 1 },
        { itemId: egg.id, quantity: 1, addonOf: 0 },
      ],
      expectedTotal: 7100,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [main, add] = r.body.lines as { id: number; addonOf: number | null }[];
    expect(add!.addonOf).toBe(main!.id);
    expect(r.body.pending[0].addons.map((a: { name: string }) => a.name)).toEqual(['加蛋']);
    const v = await api(ctx.app, duty, 'POST', `/api/dining/tables/lines/${main!.id}/void`, { reason: '客人不要了', blame: 'kitchen', withAddons: true });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.lines.map((l: { status: string }) => l.status)).toEqual(['voided', 'voided']);
    expect(v.body.amount).toBe(0);
    const audits = await ctx.sql<{ detail: Record<string, unknown> }[]>`SELECT detail FROM audit_logs WHERE action = 'table_void' ORDER BY id`;
    expect(audits.map((a) => `${a.detail.name}|${a.detail.addonOf ?? ''}|${a.detail.blame}`)).toEqual(['牛肉面||kitchen', `加蛋|${main!.id}|kitchen`]);
  });
});

describe('BW10 菜品排序、批量上下架、删除', () => {
  let waterLead: string;
  beforeAll(async () => {
    // 水吧主管：只有水吧的维护权限
    await createStaff(ctx.sql, { username: 'water8117', displayName: '水吧主管', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
    await ctx.sql`INSERT INTO settings (key, value) VALUES ('role_permissions', ${ctx.sql.json({ backoffice: { add: ['dish.water'], remove: [] } })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    waterLead = await login(ctx.app, 'water8117');
    for (const [name, price] of [
      ['橙汁', 1800],
      ['西瓜汁', 1600],
    ] as const) {
      expect((await create({ name, category: '饮品', slot: 'water:手作饮料', stationId: station['水吧'], prices: { standard: price } })).status).toBe(201);
    }
  });
  const slotIds = async (slot: string) => (await board()).dishes.filter((d) => !d.deleted && slotKey(d) === slot).map((d) => d);
  const sort = (slot: string, ids: number[], cookie = ctx.owner, key: string = randomUUID()) => api(ctx.app, cookie, 'POST', '/api/dining/dishes/sort', { clientKey: key, slot, ids });

  it('排序：一个小类里全部的菜按交上来的先后；点单页、菜品表按这个排；同一个编号重提不重复记；少交、多交的拒绝', async () => {
    const before = await slotIds('water:手作饮料');
    expect(before.map((d) => d.name)).toEqual(['柠檬茶', '橙汁', '西瓜汁']);
    const [tea, orange, melon] = before;
    const wanted = [melon!.id, tea!.id, orange!.id];
    const key = randomUUID();
    const r = await sort('water:手作饮料', wanted, ctx.owner, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ count: 3, replayed: false });
    expect((await sort('water:手作饮料', wanted, ctx.owner, key)).body).toEqual({ count: 3, replayed: true });
    expect((await slotIds('water:手作饮料')).map((d) => `${d.name}|${d.sort}`)).toEqual(['西瓜汁|2001', '柠檬茶|2002', '橙汁|2003']);
    // 点单页：同一个小类里按排的先后
    expect((await menu()).dishes.filter((d) => d.outlet === 'water').map((d) => d.name)).toEqual(['西瓜汁', '柠檬茶', '橙汁']);
    const audits = await ctx.sql<{ summary: string }[]>`SELECT detail->>'summary' AS summary FROM audit_logs WHERE action = 'dishes_sorted'`;
    expect(audits.map((a) => a.summary)).toEqual(['「水吧 · 手作饮料」排序：西瓜汁、柠檬茶、橙汁']);
    // 少交一道、交了别的小类的菜：拒绝
    const missing = await sort('water:手作饮料', [melon!.id, tea!.id]);
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('DISH_SORT_STALE');
    const fish = await dishOf('水煮鱼');
    expect((await sort('water:手作饮料', [...wanted, fish.id])).body.error.code).toBe('DISH_SORT_STALE');
    // 没有那一处的维护权限：拒绝
    expect((await sort('restaurant:餐饮', [fish.id], waterLead)).status).toBe(403);
    // 挪到别的小类：原来排的先后不再算（排在新小类的最后）
    const moved = await update(await dishOf('柠檬茶'), { slot: 'water:糖水' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.dish.sort).toBeNull();
    expect((await update(moved.body.dish, { slot: 'water:手作饮料' })).status).toBe(200);
    expect((await slotIds('water:手作饮料')).map((d) => d.name)).toEqual(['西瓜汁', '橙汁', '柠檬茶']);
  });

  it('批量上下架：一次几道，本来就是这个状态的不动；有一道没有权限整批拒绝；同一个编号重提不重复', async () => {
    const [melon, orange] = await slotIds('water:手作饮料');
    const key = randomUUID();
    const off = await api(ctx.app, waterLead, 'POST', '/api/dining/dishes/active-bulk', { clientKey: key, ids: [melon!.id, orange!.id], active: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toEqual({ changed: 2, replayed: false });
    expect((await api(ctx.app, waterLead, 'POST', '/api/dining/dishes/active-bulk', { clientKey: key, ids: [orange!.id, melon!.id], active: false })).body).toEqual({ changed: 2, replayed: true });
    expect((await menu()).dishes.map((d) => d.name)).not.toContain('橙汁');
    const fish = await dishOf('水煮鱼');
    const denied = await api(ctx.app, waterLead, 'POST', '/api/dining/dishes/active-bulk', { clientKey: randomUUID(), ids: [melon!.id, fish.id], active: true });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain('「水煮鱼」');
    expect((await dishOf('西瓜汁')).active).toBe(false);
    const on = await api(ctx.app, waterLead, 'POST', '/api/dining/dishes/active-bulk', { clientKey: randomUUID(), ids: [melon!.id, orange!.id, (await dishOf('柠檬茶')).id], active: true });
    expect(on.body).toEqual({ changed: 2, replayed: false });
    const audits = await ctx.sql<{ summary: string }[]>`SELECT detail->>'summary' AS summary FROM audit_logs WHERE action = 'dishes_active_bulk' ORDER BY id`;
    expect(audits.map((a) => a.summary)).toEqual([
      `批量下架 2 道：${[melon!, orange!]
        .sort((a, b) => a.id - b.id)
        .map((d) => d.name)
        .join('、')}`,
      `批量上架 2 道：${[melon!, orange!]
        .sort((a, b) => a.id - b.id)
        .map((d) => d.name)
        .join('、')}`,
    ]);
  });

  it('删除：下架并从菜品表默认隐藏（显示已删除时看得到）、以前的订单不受影响；恢复回到菜品表（还是下架的）；重新上架就不再算删除', async () => {
    const orange = await dishOf('橙汁');
    const v = await enter();
    expect((await orderTag(v.id, [{ itemId: orange.id, quantity: 1 }], 1800)).status).toBe(200);
    const del = await api(ctx.app, waterLead, 'POST', `/api/dining/dishes/${orange.id}/delete`, { clientKey: randomUUID() });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.dish).toMatchObject({ deleted: true, active: false });
    // 菜品表：默认不列（带筛选条件的接口也一样），勾「显示已删除」才列；点单页没有；导出不导
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes?outlet=water')).body.dishes.map((d: DishRow) => d.name)).not.toContain('橙汁');
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes?outlet=water&deleted=1')).body.dishes.map((d: DishRow) => d.name)).toContain('橙汁');
    expect((await menu()).dishes.map((d) => d.name)).not.toContain('橙汁');
    // 以前的订单照旧：账单明细、出品单都在
    expect((await billLines(v.id)).map((l) => `${l.name}|${l.status}|${l.amount}`)).toEqual(['橙汁|active|1800']);
    // 排序时不算删除了的
    expect(
      (
        await sort(
          'water:手作饮料',
          (await slotIds('water:手作饮料')).map((d) => d.id),
        )
      ).status,
    ).toBe(200);
    // 恢复：回到菜品表，还是下架的
    const back = await api(ctx.app, waterLead, 'POST', `/api/dining/dishes/${orange.id}/restore`, { clientKey: randomUUID() });
    expect(back.body.dish).toMatchObject({ deleted: false, active: false });
    // 再删一次，然后从后台价目重新上架：不再算删除
    expect((await api(ctx.app, waterLead, 'POST', `/api/dining/dishes/${orange.id}/delete`, { clientKey: randomUUID() })).status).toBe(200);
    expect((await api(ctx.app, waterLead, 'POST', `/api/dining/dishes/${orange.id}/active`, { clientKey: randomUUID(), active: true })).status).toBe(200);
    expect(await dishOf('橙汁')).toMatchObject({ deleted: false, active: true });
    const audits = await ctx.sql<{ action: string }[]>`SELECT action FROM audit_logs WHERE action IN ('dish_deleted', 'dish_restored') ORDER BY id`;
    expect(audits.map((a) => a.action)).toEqual(['dish_deleted', 'dish_restored', 'dish_deleted']);
    // 删除了的一定是下架的（约束）
    await expect(ctx.sql`UPDATE service_items SET dish_deleted_at = now(), dish_deleted_by = ${ctx.ownerId} WHERE id = ${orange.id}`).rejects.toThrow();
    // 没有那一处的维护权限：拒绝
    expect((await api(ctx.app, waterLead, 'POST', `/api/dining/dishes/${(await dishOf('水煮鱼')).id}/delete`, { clientKey: randomUUID() })).status).toBe(403);
  });
});
