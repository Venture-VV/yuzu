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
import { api, setup, type TestContext } from './helpers';

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
