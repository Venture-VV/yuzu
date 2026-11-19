// 8.1.15 菜品管理（docs/DISHES_V8115.md，默认做法 CP1–CP12）：
//   · 菜品表：就是餐饮价目项目（挂了出品档口、不需要技师的），能搜、能按出品口与状态筛；有菜品权限的才看得到；
//   · 新增、编辑：名称、分类、出品口与小类、档口、图片、做法、加料、套餐内容；带操作编号，同号重提返回第一次的结果；版本对不上拒绝；
//   · 加料、套餐的规矩：只能选菜品、不能选自己、套餐不套套餐、套餐不能当加料（数据库触发器兜底）；
//   · 上下架一点就生效：点单页的菜单马上没有、下单被拒绝；
//   · 改价：单独一项权限 + 出品口的维护权限，写改价记录（改前、改后、谁、原因、从哪里改的）；以前的订单照下单时的价；
//     后台价目里改到菜品价格的两处也进改价记录；
//   · 维护权限按出品口分三项：没有的看得到、改不了，挪出品口两边都要有；
//   · 点单带做法（写进出品备注）、加料（另起一行、备注「配 某菜」）、套餐（一行，出品单上列出含的几样，记的是下单当时的）。
// 导入、导出在 tests/dishes-import.test.ts。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { slotKey, type DiningMenu, type DiningReceipt, type KitchenItem } from '../src/shared/dining';
import { addonNote, composeDishNote, type DishPriceChange, type DishRow, type DishesBoard } from '../src/shared/dishes';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
/** 水吧主管：只有水吧的维护权限（没有改价）；厨师长：餐厅的维护权限 + 改价 */
let water: string;
let chef: string;
let today: string;
let tagNo = 0;
const station: Record<string, number> = {};
const legacy: Record<string, number> = {};

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const board = async (cookie = ctx.owner, query = '') => {
  const r = await api(ctx.app, cookie, 'GET', `/api/dining/dishes${query}`);
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
const create = (body: Record<string, unknown>, cookie = ctx.owner, key: string = randomUUID()) => api(ctx.app, cookie, 'POST', '/api/dining/dishes', { clientKey: key, ...body });
const update = (d: DishRow, patch: Record<string, unknown>, cookie = ctx.owner, key: string = randomUUID()) =>
  api(ctx.app, cookie, 'PUT', `/api/dining/dishes/${d.id}`, { clientKey: key, rev: d.rev, ...fieldsOf(d), ...patch });
const setActive = (id: number, active: boolean, cookie = ctx.owner, key: string = randomUUID()) => api(ctx.app, cookie, 'POST', `/api/dining/dishes/${id}/active`, { clientKey: key, active });
const pricesOf = (d: DishRow) => Object.fromEntries(d.prices.map((p) => [p.tier, p.price]));
const reprice = (d: DishRow, prices: Record<string, number | null>, reason: string, cookie = ctx.owner, key: string = randomUUID()) =>
  api(ctx.app, cookie, 'POST', `/api/dining/dishes/${d.id}/price`, { clientKey: key, prices, expected: pricesOf(d), reason });
const history = async (itemId?: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/dining/dishes/price-changes${itemId ? `?itemId=${itemId}` : ''}`)).body as DishPriceChange[];
const menu = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body as DiningMenu;
const menuDish = async (name: string) => (await menu()).dishes.find((d) => d.name === name);
const enter = async () => {
  tagNo += 1;
  const code = `M${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.visits[0].id as number, code };
};
const orderTag = (visitId: number, lines: { itemId: number; quantity: number; note?: string }[], expectedTotal: number, key: string = randomUUID()) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: key, visitId, lines, expectedTotal });
const kitchen = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/kitchen')).body.items as KitchenItem[];
const base = (name: string, at: string, slot: string, price = 3800) => ({ name, category: '餐饮', slot, stationId: station[at], prices: { standard: price } });
const audits = (action: string) => ctx.sql<{ summary: string; staffId: number }[]>`SELECT detail->>'summary' AS summary, staff_id FROM audit_logs WHERE action = ${action} ORDER BY id`;

beforeAll(async () => {
  ctx = await setup();
  today = (await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body.today;
  await createStaff(ctx.sql, { username: 'water', displayName: '水吧主管', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'chef', displayName: '厨师长', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  // 岗位权限：水吧主管加「维护水吧的菜品」，厨师长加「维护餐厅的菜品」与「定价与改价」
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('role_permissions', ${ctx.sql.json({
    duty_manager: { add: ['dish.water'], remove: [] },
    backoffice: { add: ['dish.restaurant', 'dish.price'], remove: [] },
  })})`;
  water = await login(ctx.app, 'water');
  chef = await login(ctx.app, 'chef');
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true, tablesEnabled: true, trackServed: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'M', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
  for (const name of ['热菜', '水吧', '果吧档', '旧档口']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  // 升级前就有的价目：三道菜（按档口默认归到餐厅 / 水吧 / 果吧）与一个不是菜品的项目（没挂档口）
  for (const [name, category, price, at] of [
    ['宫保鸡丁', '餐饮', 4800, '热菜'],
    ['柠檬茶', '饮品', 1500, '水吧'],
    ['鲜切果盘', '果吧', 3800, '果吧档'],
    ['汤泉门票', '门票', 12800, null],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    legacy[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    if (at) expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: legacy[name], stationId: station[at] }] })).status).toBe(200);
  }
  // 档口停用：已经挂在上面的菜照旧，新挂的不行
  expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/dining/stations/${station['旧档口']}`, { name: '旧档口', sortOrder: 9, active: false })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('菜品表', () => {
  it('菜品就是挂了出品档口的价目项目：出品口与小类没设的按默认归、标没设过；不是菜品的不在表里；带档口清单与已有的分类', async () => {
    const b = await board();
    expect(b.businessDate).toBe(today);
    expect(b.dishes.map((d) => `${d.name}|${d.outlet}|${d.group}|${d.slotAssigned}|${d.stationName}|${d.price}|${d.active}|${d.remaining}`)).toEqual([
      '宫保鸡丁|restaurant|餐饮|false|热菜|4800|true|null',
      '柠檬茶|water|手作饮料|false|水吧|1500|true|null',
      '鲜切果盘|fruit||false|果吧档|3800|true|null',
    ]);
    expect(b.dishes[0]).toMatchObject({ prices: [{ tier: 'standard', price: 4800 }], methods: [], addons: [], combo: [], usedBy: [], imageId: null, imageUrl: null, emenuDish: null });
    expect(b.stations.map((s) => `${s.name}:${s.active}`)).toEqual(['热菜:true', '水吧:true', '果吧档:true', '旧档口:false']);
    expect(b.categories).toEqual(expect.arrayContaining(['餐饮', '饮品', '果吧', '门票']));
  });

  it('有任一项菜品权限就看得到全部（含自己改不了的出品口）；没有的看不到', async () => {
    expect((await board(water)).dishes.map((d) => d.name)).toEqual(['宫保鸡丁', '柠檬茶', '鲜切果盘']);
    expect((await board(chef)).dishes.length).toBe(3);
    for (const url of ['/api/dining/dishes', '/api/dining/dishes/price-changes', '/api/dining/dishes/export.xlsx']) {
      expect((await api(ctx.app, ctx.clerk, 'GET', url)).status, url).toBe(403);
      expect((await api(ctx.app, null, 'GET', url)).status, url).toBe(401);
    }
  });

  it('搜索与筛选：名称、出品口、状态（上架 / 下架 / 今日沽清）；今天的沽清带出来', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${legacy['柠檬茶']}`, { remaining: 0 })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${legacy['鲜切果盘']}`, { remaining: 6 })).status).toBe(200);
    const names = async (query: string) => (await board(ctx.owner, query)).dishes.map((d) => d.name);
    expect((await board()).dishes.map((d) => d.remaining)).toEqual([null, 0, 6]);
    expect(await names('?q=' + encodeURIComponent('茶'))).toEqual(['柠檬茶']);
    expect(await names('?outlet=fruit')).toEqual(['鲜切果盘']);
    expect(await names('?status=soldout')).toEqual(['柠檬茶']);
    expect(await names('?status=on&outlet=restaurant')).toEqual(['宫保鸡丁']);
    expect(await names('?status=off')).toEqual([]);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes?outlet=bar')).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/dining/dishes?status=gone')).status).toBe(400);
    for (const name of ['柠檬茶', '鲜切果盘']) expect((await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${legacy[name]}`, { remaining: null })).status).toBe(200);
  });
});

describe('新增与编辑', () => {
  it('新增：写进价目（各档价格、默认档的价）、带做法；定价记一条改价记录；记审计；点单页的菜单马上有', async () => {
    const r = await create({ ...base('牛肉面', '热菜', 'restaurant:餐饮'), prices: { standard: 3800, premium: 5800 }, methods: ['微辣', '中辣', '免葱'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.replayed).toBe(false);
    const d = r.body.dish as DishRow;
    expect(d).toMatchObject({
      name: '牛肉面',
      category: '餐饮',
      outlet: 'restaurant',
      group: '餐饮',
      slotAssigned: true,
      stationName: '热菜',
      price: 3800,
      active: true,
      methods: ['微辣', '中辣', '免葱'],
      prices: [
        { tier: 'standard', price: 3800 },
        { tier: 'premium', price: 5800 },
      ],
    });
    const [item] = await ctx.sql<{ price: number; technicianRequired: boolean; diningOutlet: string }[]>`SELECT price, technician_required, dining_outlet FROM service_items WHERE id = ${d.id}`;
    expect(item).toEqual({ price: 3800, technicianRequired: false, diningOutlet: 'restaurant' });
    expect((await history(d.id)).map((c) => `${c.tier}:${c.oldPrice}→${c.newPrice}:${c.reason}:${c.source}:${c.staffName}`)).toEqual([
      'premium:null→5800:新建菜品:dishes:测试店主',
      'standard:null→3800:新建菜品:dishes:测试店主',
    ]);
    expect((await audits('dish_saved')).at(-1)!.summary).toBe('新建菜品「牛肉面」（餐厅 · 餐饮，标准 ¥38.00 / 优选 ¥58.00）');
    expect(await menuDish('牛肉面')).toMatchObject({ price: 3800, outlet: 'restaurant', group: '餐饮', methods: ['微辣', '中辣', '免葱'] });
    // 后台价目里也是同一个项目
    const catalog = (await api(ctx.app, ctx.owner, 'GET', '/api/catalog?all=1')).body.items as { id: number; name: string }[];
    expect(catalog.find((i) => i.name === '牛肉面')?.id).toBe(d.id);
  });

  it('同一个操作编号重提：内容一样返回第一次那道菜、不会多建一道；内容不同拒绝', async () => {
    const key = randomUUID();
    const body = base('葱油拌面', '热菜', 'restaurant:餐饮', 2200);
    const first = await create(body, ctx.owner, key);
    expect(first.status).toBe(201);
    const again = await create(body, ctx.owner, key);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.dish.id).toBe(first.body.dish.id);
    expect((await ctx.sql`SELECT 1 FROM service_items WHERE name = '葱油拌面'`).length).toBe(1);
    expect((await history(first.body.dish.id)).length).toBe(1);
    const other = await create({ ...body, name: '葱油拌面（大）' }, ctx.owner, key);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 同时来两次（连点）：一个新建、一个拿到同一道
    const twin = randomUUID();
    const both = await Promise.all([create(base('阳春面', '热菜', 'restaurant:餐饮', 1800), ctx.owner, twin), create(base('阳春面', '热菜', 'restaurant:餐饮', 1800), ctx.owner, twin)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 201]);
    expect(both[0]!.body.dish.id).toBe(both[1]!.body.dish.id);
    expect((await ctx.sql`SELECT 1 FROM service_items WHERE name = '阳春面'`).length).toBe(1);
  });

  it('新增被拒绝的：没有价格、出品口与小类配不上、档口不存在或已停用、重名、做法写得不对、没有操作编号', async () => {
    const ok = base('试菜', '热菜', 'restaurant:餐饮');
    const cases: [Record<string, unknown>, number, string][] = [
      [{ ...ok, prices: {} }, 400, '请至少填写一档价格'],
      [{ ...ok, prices: { standard: 0 } }, 400, '价格必须大于 0'],
      [{ ...ok, slot: 'restaurant:调酒' }, 400, '出品口与小类不对'],
      [{ ...ok, slot: 'fruit:鲜果' }, 400, '出品口与小类不对'],
      [{ ...ok, stationId: 999_999 }, 404, '出品档口不存在'],
      [{ ...ok, stationId: station['旧档口'] }, 422, '档口「旧档口」已停用'],
      [{ ...ok, name: '宫保鸡丁' }, 409, '价目里已经有「宫保鸡丁」了'],
      [{ ...ok, name: '汤泉门票' }, 409, '价目里已经有「汤泉门票」了'],
      [{ ...ok, name: '  ' }, 400, '请填写菜名'],
      [{ ...ok, methods: ['微辣', '微辣'] }, 400, '做法重复了'],
      [{ ...ok, methods: ['一二三四五六七八九'] }, 400, '一种做法最多 8 个字'],
      [{ ...ok, methods: ['微辣，中辣'] }, 400, '做法里不要带逗号'],
      [{ ...ok, imageId: 999_999 }, 404, '图片不存在'],
    ];
    for (const [body, status, message] of cases) {
      const r = await create(body);
      expect(r.status, `${message} ${JSON.stringify(r.body)}`).toBe(status);
      expect(r.body.error.message).toContain(message);
    }
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes', ok)).status).toBe(400);
    expect((await ctx.sql`SELECT 1 FROM service_items WHERE name = '试菜'`).length).toBe(0);
  });

  it('编辑：改名称、分类、出品口与小类、档口、做法、图片；改了什么写进审计；什么都没改不动这一行', async () => {
    const img = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes/images', { mime: 'image/png', data: PNG });
    expect(img.status, JSON.stringify(img.body)).toBe(201);
    const d = await dishOf('葱油拌面');
    const r = await update(d, { name: '葱油拌面（招牌）', category: '面点', slot: 'water:糖水', stationId: station['水吧'], methods: ['加辣'], imageId: img.body.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.dish).toMatchObject({
      name: '葱油拌面（招牌）',
      category: '面点',
      outlet: 'water',
      group: '糖水',
      stationName: '水吧',
      methods: ['加辣'],
      imageId: img.body.id,
      imageUrl: `/api/dining/dishes/images/${img.body.id}`,
    });
    expect(r.body.dish.rev).not.toBe(d.rev);
    expect((await audits('dish_saved')).at(-1)!.summary).toBe(
      '修改菜品「葱油拌面（招牌）」：名称 葱油拌面 → 葱油拌面（招牌）；分类 餐饮 → 面点；出品口与小类 餐厅 · 餐饮 → 水吧 · 糖水；档口 热菜 → 水吧；图片 没有 → 有；做法 （没有） → 加辣',
    );
    // 图片能取回来（有菜品权限的）；没有权限的不行
    expect((await api(ctx.app, water, 'GET', r.body.dish.imageUrl)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', r.body.dish.imageUrl)).status).toBe(403);
    // 什么都没改：不动这一行（版本不变）、不记审计
    const before = (await audits('dish_saved')).length;
    const same = await update(r.body.dish, {});
    expect(same.status).toBe(200);
    expect(same.body.dish.rev).toBe(r.body.dish.rev);
    expect((await audits('dish_saved')).length).toBe(before);
    // 改回去，后面的用例还用原来的名字
    expect((await update(same.body.dish, { name: '葱油拌面', category: '餐饮', slot: 'restaurant:餐饮', stationId: station['热菜'], methods: [], imageId: null })).status).toBe(200);
  });

  it('按默认归的出品口：保存时选的还是默认那一处，不把「按默认」写成设过；真的换了才写', async () => {
    const d = await dishOf('柠檬茶');
    expect(d.slotAssigned).toBe(false);
    const r = await update(d, { methods: ['去冰', '少冰', '热'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.dish).toMatchObject({ outlet: 'water', group: '手作饮料', slotAssigned: false, methods: ['去冰', '少冰', '热'] });
    const moved = await update(r.body.dish, { slot: 'water:糖水' });
    expect(moved.body.dish).toMatchObject({ group: '糖水', slotAssigned: true });
    expect((await update(moved.body.dish, { slot: 'water:手作饮料' })).body.dish).toMatchObject({ group: '手作饮料', slotAssigned: true });
  });

  it('版本对不上（别人先改过）拒绝；同一个操作编号重提返回第一次的结果、不再改一遍', async () => {
    const d = await dishOf('阳春面');
    const key = randomUUID();
    const first = await update(d, { methods: ['加蛋位'] }, ctx.owner, key);
    expect(first.status).toBe(200);
    // 用打开时的旧版本再改：拒绝
    const stale = await update(d, { methods: ['不要葱'] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('DISH_CHANGED');
    expect((await dishOf('阳春面')).methods).toEqual(['加蛋位']);
    // 同一个编号原样重提：返回第一次的结果（版本虽然已经变了）
    const before = (await audits('dish_saved')).length;
    const again = await update(d, { methods: ['加蛋位'] }, ctx.owner, key);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect((await audits('dish_saved')).length).toBe(before);
    // 后台价目里改了这一项，版本也跟着变
    const now = await dishOf('阳春面');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/items/${now.id}`, { name: '阳春面', category: '餐饮', price: 1800, note: '后台改了说明' })).status).toBe(200);
    expect((await update(now, { methods: [] })).body.error?.code).toBe('DISH_CHANGED');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/dining/dishes/999999', { clientKey: randomUUID(), rev: '1', ...fieldsOf(now) })).status).toBe(404);
    // 不是菜品的价目项目不在这里维护
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/dining/dishes/${legacy['汤泉门票']}`, { clientKey: randomUUID(), rev: '1', ...fieldsOf(now), name: '汤泉门票' })).status).toBe(404);
  });
});

describe('加料与套餐的规矩', () => {
  it('加料、套餐内容只能选菜品，不能选自己；存下来按选的顺序；被谁用在菜品表上看得到', async () => {
    const egg = (await create(base('加蛋', '热菜', 'restaurant:餐饮', 300))).body.dish as DishRow;
    const beef = (await create(base('加牛肉', '热菜', 'restaurant:餐饮', 1500))).body.dish as DishRow;
    const noodle = await dishOf('牛肉面');
    const r = await update(noodle, { addons: [beef.id, egg.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.dish.addons).toEqual([
      { itemId: beef.id, name: '加牛肉', price: 1500, available: true },
      { itemId: egg.id, name: '加蛋', price: 300, available: true },
    ]);
    expect((await dishOf('加蛋')).usedBy).toEqual(['「牛肉面」的加料']);
    const d = r.body.dish as DishRow;
    for (const [patch, status, message] of [
      [{ addons: [d.id] }, 422, '不能选这道菜自己'],
      [{ combo: [{ itemId: d.id, quantity: 1 }] }, 422, '不能选这道菜自己'],
      [{ addons: [legacy['汤泉门票']] }, 422, '「汤泉门票」不是菜品'],
      [{ combo: [{ itemId: legacy['汤泉门票'], quantity: 1 }] }, 422, '「汤泉门票」不是菜品'],
      [{ addons: [999_999] }, 404, '已经不存在'],
      [{ addons: [egg.id, egg.id] }, 400, '加料重复了'],
      [
        {
          combo: [
            { itemId: egg.id, quantity: 1 },
            { itemId: egg.id, quantity: 2 },
          ],
        },
        400,
        '同一道菜写了两次',
      ],
      [{ combo: [{ itemId: egg.id, quantity: 0 }] }, 400, '份数至少 1'],
    ] as const) {
      const bad = await update(d, patch);
      expect(bad.status, `${message} ${JSON.stringify(bad.body)}`).toBe(status);
      expect(bad.body.error.message).toContain(message);
    }
    expect((await dishOf('牛肉面')).addons.map((a) => a.name)).toEqual(['加牛肉', '加蛋']);
  });

  it('套餐：含哪几样、每样几份；套餐不套套餐，套餐不能当加料，当了加料、进了套餐的菜不能再做成套餐（数据库也兜底）', async () => {
    const tea = await dishOf('柠檬茶');
    const noodle = await dishOf('牛肉面');
    const combo = await create({
      ...base('牛肉面套餐', '热菜', 'restaurant:餐饮', 4800),
      combo: [
        { itemId: noodle.id, quantity: 1 },
        { itemId: tea.id, quantity: 2 },
      ],
    });
    expect(combo.status, JSON.stringify(combo.body)).toBe(201);
    const set = combo.body.dish as DishRow;
    expect(set.combo).toEqual([
      { itemId: noodle.id, name: '牛肉面', quantity: 1, available: true },
      { itemId: tea.id, name: '柠檬茶', quantity: 2, available: true },
    ]);
    expect((await dishOf('柠檬茶')).usedBy).toEqual(['套餐「牛肉面套餐」']);
    // 套餐里不能再放套餐
    const nested = await create({ ...base('大套餐', '热菜', 'restaurant:餐饮', 9800), combo: [{ itemId: set.id, quantity: 1 }] });
    expect(nested.status).toBe(422);
    expect(nested.body.error.message).toBe('「牛肉面套餐」本身是套餐，套餐里不能再放套餐');
    // 套餐不能当加料
    const asAddon = await update(await dishOf('阳春面'), { addons: [set.id] });
    expect(asAddon.status).toBe(422);
    expect(asAddon.body.error.message).toBe('「牛肉面套餐」是套餐，不能当加料');
    // 已经在套餐里的菜、当了加料的菜，不能再做成套餐
    const plain = await dishOf('阳春面');
    const inCombo = await update(await dishOf('牛肉面'), { combo: [{ itemId: plain.id, quantity: 1 }] });
    expect(inCombo.status).toBe(422);
    expect(inCombo.body.error.message).toBe('这道菜已经在套餐「牛肉面套餐」里，不能再做成套餐');
    const addonToCombo = await update(await dishOf('加蛋'), { combo: [{ itemId: plain.id, quantity: 1 }] });
    expect(addonToCombo.status).toBe(422);
    expect(addonToCombo.body.error.message).toBe('这道菜是「牛肉面」的加料，不能做成套餐');
    // 数据库兜底：绕过接口直接写也不行
    await expect(ctx.sql`INSERT INTO dish_combo_items (combo_item_id, item_id, quantity) VALUES (${plain.id}, ${set.id}, 1)`).rejects.toThrow('套餐里不能再放套餐');
    await expect(ctx.sql`INSERT INTO dish_combo_items (combo_item_id, item_id, quantity) VALUES (${noodle.id}, ${plain.id}, 1)`).rejects.toThrow('已经在别的套餐里');
    await expect(ctx.sql`INSERT INTO dish_combo_items (combo_item_id, item_id, quantity) VALUES (${plain.id}, ${plain.id}, 1)`).rejects.toThrow(/dish_combo_items_not_self/);
    await expect(ctx.sql`INSERT INTO dish_addons (item_id, addon_item_id) VALUES (${plain.id}, ${plain.id})`).rejects.toThrow(/dish_addons_not_self/);
    // 改套餐内容：整批换
    const changed = await update(set, {
      combo: [
        { itemId: tea.id, quantity: 1 },
        { itemId: noodle.id, quantity: 1 },
      ],
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await audits('dish_saved')).at(-1)!.summary).toBe('修改菜品「牛肉面套餐」：套餐内容 牛肉面×1、柠檬茶×2 → 柠檬茶×1、牛肉面×1');
  });
});

describe('上下架', () => {
  it('下架一点就生效：点单页的菜单马上没有、下单被拒绝；再上架照常；同号重提不重复记', async () => {
    const d = await dishOf('葱油拌面');
    const v = await enter();
    expect((await orderTag(v.id, [{ itemId: d.id, quantity: 1 }], 2200)).status).toBe(200);
    const key = randomUUID();
    const off = await setActive(d.id, false, ctx.owner, key);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.dish.active).toBe(false);
    expect(await menuDish('葱油拌面')).toBeUndefined();
    const denied = await orderTag(v.id, [{ itemId: d.id, quantity: 1 }], 2200);
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('ITEM_UNAVAILABLE');
    expect((await board(ctx.owner, '?status=off')).dishes.map((x) => x.name)).toEqual(['葱油拌面']);
    // 已经点了的不受影响（账上、出品单都在）
    expect((await kitchen()).filter((k) => k.name === '葱油拌面' && k.status === 'queued').length).toBe(1);
    const again = await setActive(d.id, false, ctx.owner, key);
    expect(again.body.replayed).toBe(true);
    // 本来就是下架：不再记一条
    expect((await setActive(d.id, false)).status).toBe(200);
    expect((await audits('dish_active_set')).map((a) => a.summary)).toEqual(['菜品「葱油拌面」下架']);
    expect((await setActive(d.id, true)).body.dish.active).toBe(true);
    expect(await menuDish('葱油拌面')).toMatchObject({ price: 2200 });
    expect((await orderTag(v.id, [{ itemId: d.id, quantity: 1 }], 2200)).status).toBe(200);
    expect((await audits('dish_active_set')).map((a) => a.summary)).toEqual(['菜品「葱油拌面」下架', '菜品「葱油拌面」上架']);
  });

  it('加料下架：点单页不再列出这一种加料；套餐里的一样下架：套餐照卖，菜品表上标出来', async () => {
    const egg = await dishOf('加蛋');
    expect((await menuDish('牛肉面'))!.addons!.map((a) => a.name)).toEqual(['加牛肉', '加蛋']);
    expect((await setActive(egg.id, false)).status).toBe(200);
    expect((await menuDish('牛肉面'))!.addons!.map((a) => a.name)).toEqual(['加牛肉']);
    expect((await dishOf('牛肉面')).addons.map((a) => `${a.name}:${a.available}`)).toEqual(['加牛肉:true', '加蛋:false']);
    expect((await setActive(egg.id, true)).status).toBe(200);
    const tea = await dishOf('柠檬茶');
    expect((await setActive(tea.id, false)).status).toBe(200);
    expect((await dishOf('牛肉面套餐')).combo.map((c) => `${c.name}:${c.available}`)).toEqual(['柠檬茶:false', '牛肉面:true']);
    expect(await menuDish('牛肉面套餐')).toMatchObject({
      combo: [
        { name: '柠檬茶', quantity: 1 },
        { name: '牛肉面', quantity: 1 },
      ],
    });
    expect((await setActive(tea.id, true)).status).toBe(200);
  });
});

describe('改价', () => {
  it('写改价记录（改前、改后、谁、原因）；默认档的价跟着走；以前的订单照下单时的价，之后的按新价', async () => {
    const d = await dishOf('宫保鸡丁');
    const v = await enter();
    expect((await orderTag(v.id, [{ itemId: d.id, quantity: 2 }], 9600)).status).toBe(200);
    const r = await reprice(d, { standard: 5200, professional: 6200 }, '食材涨价');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.dish).toMatchObject({
      price: 5200,
      prices: [
        { tier: 'standard', price: 5200 },
        { tier: 'professional', price: 6200 },
      ],
    });
    expect((await history(d.id)).map((c) => `${c.itemName}|${c.tier}|${c.oldPrice}→${c.newPrice}|${c.reason}|${c.source}|${c.staffName}`)).toEqual([
      '宫保鸡丁|professional|null→6200|食材涨价|dishes|测试店主',
      '宫保鸡丁|standard|4800→5200|食材涨价|dishes|测试店主',
    ]);
    expect((await audits('dish_price_changed')).at(-1)!.summary).toBe('菜品「宫保鸡丁」改价：标准 ¥48.00 → ¥52.00；新加 专业 ¥62.00（食材涨价）');
    // 以前的订单：明细上的单价、金额不动
    const lines = await ctx.sql<{ unitPrice: number; amount: number }[]>`SELECT unit_price, amount FROM bill_lines WHERE item_id = ${d.id}`;
    expect(lines).toEqual([{ unitPrice: 4800, amount: 9600 }]);
    // 之后的：按旧价确认的被拒绝，按新价的照常；多档以后明细名带档名
    const old = await orderTag(v.id, [{ itemId: d.id, quantity: 1 }], 4800);
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('PRICE_CHANGED');
    expect((await orderTag(v.id, [{ itemId: d.id, quantity: 1 }], 5200)).status).toBe(200);
    const after = await ctx.sql<{ name: string; unitPrice: number }[]>`SELECT name, unit_price FROM bill_lines WHERE item_id = ${d.id} ORDER BY id`;
    expect(after).toEqual([
      { name: '宫保鸡丁', unitPrice: 4800 },
      { name: '宫保鸡丁（标准）', unitPrice: 5200 },
    ]);
    // 去掉一档
    const now = r.body.dish as DishRow;
    const drop = await reprice(now, { standard: 5200, professional: null }, '不卖专业档了');
    expect(drop.status, JSON.stringify(drop.body)).toBe(200);
    expect((await history(d.id))[0]).toMatchObject({ tier: 'professional', oldPrice: 6200, newPrice: null, reason: '不卖专业档了' });
    expect((await ctx.sql`SELECT tier FROM service_item_prices WHERE item_id = ${d.id}`).map((x) => x.tier)).toEqual(['standard']);
    // 改价记录只追加
    await expect(ctx.sql`UPDATE dish_price_changes SET reason = '改一下' WHERE item_id = ${d.id}`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM dish_price_changes WHERE item_id = ${d.id}`).rejects.toThrow();
  });

  it('被拒绝的：没写原因、价格没变、一档都不留、页面上看到的价已经不是现在的；同号重提不多记', async () => {
    const d = await dishOf('宫保鸡丁');
    const count = async () => (await history(d.id)).length;
    const before = await count();
    expect((await reprice(d, { standard: 5600 }, ' ')).body.error.message).toContain('请填写改价原因');
    const same = await reprice(d, { standard: 5200 }, '没变');
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('DISH_PRICE_SAME');
    expect((await reprice(d, { standard: null }, '全去掉')).body.error.message).toContain('请至少留一档价格');
    const stale = await api(ctx.app, ctx.owner, 'POST', `/api/dining/dishes/${d.id}/price`, {
      clientKey: randomUUID(),
      prices: { standard: 5600 },
      expected: { standard: 4800 },
      reason: '按旧价看的',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('DISH_PRICE_STALE');
    expect(stale.body.error.message).toContain('现在是 ¥52.00');
    expect(await count()).toBe(before);
    const key = randomUUID();
    expect((await reprice(d, { standard: 5600 }, '调价', ctx.owner, key)).status).toBe(200);
    const again = await reprice(d, { standard: 5600 }, '调价', ctx.owner, key);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(await count()).toBe(before + 1);
    expect((await reprice(await dishOf('宫保鸡丁'), { standard: 4800 }, '改回原价')).status).toBe(200);
  });

  it('后台价目里改到菜品价格的两处也进改价记录（单个项目、价目表导入）；不是菜品的项目不记', async () => {
    const d = await dishOf('鲜切果盘');
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/items/${d.id}`, { name: '鲜切果盘', category: '果吧', prices: { standard: 4200, premium: 6800 } })).status).toBe(200);
    expect((await history(d.id)).map((c) => `${c.tier}|${c.oldPrice}→${c.newPrice}|${c.reason}|${c.source}`)).toEqual([
      'premium|null→6800|在后台价目里修改|catalog',
      'standard|3800→4200|在后台价目里修改|catalog',
    ]);
    // 只改了名称、说明，价格没变：不记
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/items/${d.id}`, { name: '鲜切果盘', category: '果吧', prices: { standard: 4200, premium: 6800 }, note: '当季水果' })).status).toBe(200);
    expect((await history(d.id)).length).toBe(2);
    // 不是菜品的项目改价不进这份记录
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/items/${legacy['汤泉门票']}`, { name: '汤泉门票', category: '门票', price: 13800 })).status).toBe(200);
    expect((await history(legacy['汤泉门票'])).length).toBe(0);
    // 价目表导入
    const rows = [
      { category: '果吧', name: '鲜切果盘', durationMinutes: null, gender: null, prices: [{ tier: 'standard', price: 3800 }] },
      { category: '门票', name: '汤泉门票', durationMinutes: null, gender: null, prices: [{ tier: 'standard', price: 12800 }] },
    ];
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/items/import', { rows, dryRun: false })).status).toBe(200);
    expect((await history(d.id)).slice(0, 2).map((c) => `${c.tier}|${c.oldPrice}→${c.newPrice}|${c.reason}|${c.source}`)).toEqual([
      'premium|6800→null|按价目表导入|price_list',
      'standard|4200→3800|按价目表导入|price_list',
    ]);
    expect((await history(legacy['汤泉门票'])).length).toBe(0);
    // 价目表导入会按清单重排、把出品口这些留着：菜品还是菜品
    expect(await dishOf('鲜切果盘')).toMatchObject({ price: 3800, outlet: 'fruit', stationName: '果吧档' });
    // 全部菜品的改价记录：新的在前
    const all = await history();
    expect(all[0]!.itemName).toBe('鲜切果盘');
    expect(all.length).toBeGreaterThan(8);
  });
});

describe('维护权限按出品口分三项，改价另一项', () => {
  it('水吧主管（只有水吧）：能改水吧的菜、上下架；餐厅的菜改不了；挪到餐厅不行；不能新建（没有定价权限）、不能改价', async () => {
    const tea = await dishOf('柠檬茶');
    const ok = await update(tea, { methods: ['去冰', '少冰', '热', '少糖'] }, water);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await audits('dish_saved')).at(-1)!.summary).toContain('做法 去冰、少冰、热 → 去冰、少冰、热、少糖');
    expect((await setActive(tea.id, false, water)).status).toBe(200);
    expect((await setActive(tea.id, true, water)).status).toBe(200);
    const kungpao = await dishOf('宫保鸡丁');
    const denied = await update(kungpao, { methods: ['微辣'] }, water);
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toBe('没有餐厅的菜品维护权限，不能改「宫保鸡丁」');
    expect((await setActive(kungpao.id, false, water)).status).toBe(403);
    expect((await dishOf('宫保鸡丁')).active).toBe(true);
    const move = await update(await dishOf('柠檬茶'), { slot: 'restaurant:酒水' }, water);
    expect(move.status).toBe(403);
    expect(move.body.error.message).toBe('没有餐厅的菜品维护权限，不能把「柠檬茶」挪到餐厅');
    const made = await create(base('杨枝甘露', '水吧', 'water:糖水', 3200), water);
    expect(made.status).toBe(403);
    expect(made.body.error.message).toContain('定价与改价');
    expect((await reprice(tea, { standard: 1800 }, '想涨价', water)).status).toBe(403);
    expect((await dishOf('柠檬茶')).price).toBe(1500);
  });

  it('厨师长（餐厅 + 改价）：能新建、改餐厅的菜、改餐厅的价；水吧的菜改不了、价也改不了、不能在水吧新建', async () => {
    const made = await create(base('酸辣土豆丝', '热菜', 'restaurant:餐饮', 2200), chef);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await history(made.body.dish.id))[0]).toMatchObject({ staffName: '厨师长', reason: '新建菜品' });
    expect((await reprice(made.body.dish, { standard: 2400 }, '定价调整', chef)).status).toBe(200);
    const tea = await dishOf('柠檬茶');
    expect((await update(tea, { methods: [] }, chef)).status).toBe(403);
    const price = await reprice(tea, { standard: 1800 }, '水吧不归我', chef);
    expect(price.status).toBe(403);
    expect(price.body.error.message).toBe('没有水吧的菜品维护权限，不能改「柠檬茶」的价格');
    const inWater = await create(base('杨枝甘露', '水吧', 'water:糖水', 3200), chef);
    expect(inWater.status).toBe(403);
    expect(inWater.body.error.message).toBe('没有水吧的菜品维护权限，不能在这里新建菜品');
    // 果吧的菜两个人都改不了，店主可以
    const fruit = await dishOf('鲜切果盘');
    expect((await update(fruit, { methods: ['去皮'] }, chef)).status).toBe(403);
    expect((await update(fruit, { methods: ['去皮'] }, water)).status).toBe(403);
    expect((await update(fruit, { methods: ['去皮'] })).status).toBe(200);
  });

  it('按默认归的菜换了档口、分类：出品口照页面上选的那一处写明，不跟着跑；没有另一处权限的不能借换档口把菜挪过去', async () => {
    // 价目里建的两道老菜，都没设过点单分类：冰红茶（分类「饮品」、水吧出）按默认归水吧 · 手作饮料；花雕酒（分类「酒水」、热菜档出）归餐厅 · 酒水
    const legacyDish = async (name: string, category: string, at: string) => {
      const made = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price: 1200 });
      const id = made.body.items.find((i: { name: string }) => i.name === name).id as number;
      expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id, stationId: station[at] }] })).status).toBe(200);
      return dishOf(name);
    };
    const tea = await legacyDish('冰红茶', '饮品', '水吧');
    expect(tea).toMatchObject({ outlet: 'water', group: '手作饮料', slotAssigned: false, stationName: '水吧' });
    // 水吧主管把它挪到热菜档口出，出品口没动（页面上还是水吧 · 手作饮料）：保存以后还在水吧，并且写明了
    //（不写明的话，「饮品」又不在水吧做，会按默认归到餐厅 · 酒水——他没有餐厅的权限）
    const moved = await update(tea, { stationId: station['热菜'] }, water);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.dish).toMatchObject({ outlet: 'water', group: '手作饮料', slotAssigned: true, stationName: '热菜' });
    expect((await menuDish('冰红茶'))!).toMatchObject({ outlet: 'water', group: '手作饮料' });
    // 餐厅的人照旧改不了它；水吧的人想连出品口一起挪到餐厅被拒绝
    expect((await update(moved.body.dish, { methods: ['去冰'] }, chef)).status).toBe(403);
    expect((await update(moved.body.dish, { slot: 'restaurant:酒水' }, water)).status).toBe(403);
    // 只改分类（默认归类也看分类）：花雕酒的分类从「酒水」改成「餐饮」，页面上选的还是餐厅 · 酒水，保存以后也是
    const wine = await legacyDish('花雕酒', '酒水', '热菜');
    expect(wine).toMatchObject({ outlet: 'restaurant', group: '酒水', slotAssigned: false });
    const recat = await update(wine, { category: '餐饮' });
    expect(recat.status, JSON.stringify(recat.body)).toBe(200);
    expect(recat.body.dish).toMatchObject({ outlet: 'restaurant', group: '酒水', slotAssigned: true, category: '餐饮' });
    // 没动分类、档口的保存：按默认归的还是按默认（不把「按默认」写成设过）
    const fruit = await dishOf('鲜切果盘');
    expect(fruit.slotAssigned).toBe(false);
    expect((await update(fruit, { methods: ['去皮', '切块'] })).body.dish).toMatchObject({ outlet: 'fruit', slotAssigned: false });
  });

  it('没有任何菜品权限的（店员）：维护、改价、传图都进不来', async () => {
    const tea = await dishOf('柠檬茶');
    expect((await update(tea, { methods: [] }, ctx.clerk)).status).toBe(403);
    expect((await setActive(tea.id, false, ctx.clerk)).status).toBe(403);
    expect((await reprice(tea, { standard: 1800 }, '店员改价', ctx.clerk)).status).toBe(403);
    expect((await create(base('店员的菜', '热菜', 'restaurant:餐饮'), ctx.clerk)).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/dining/dishes/images', { mime: 'image/png', data: PNG })).status).toBe(403);
    // 厨师长没有传图以外的限制：维护权限就能传图
    expect((await api(ctx.app, chef, 'POST', '/api/dining/dishes/images', { mime: 'image/png', data: PNG })).status).toBe(201);
  });
});

describe('点单带做法、加料、套餐', () => {
  it('手牌点单：做法写进出品备注，加料另起一行、备注「配 某菜」各算各的钱，套餐一行、出品单上列出含的几样；账上的金额对', async () => {
    const m = await menu();
    const noodle = m.dishes.find((d) => d.name === '牛肉面')!;
    const set = m.dishes.find((d) => d.name === '牛肉面套餐')!;
    expect(noodle).toMatchObject({
      methods: ['微辣', '中辣', '免葱'],
      addons: [
        { name: '加牛肉', price: 1500 },
        { name: '加蛋', price: 300 },
      ],
    });
    expect(set.combo).toEqual([
      { name: '柠檬茶', quantity: 1 },
      { name: '牛肉面', quantity: 1 },
    ]);
    // 没有做法、加料、套餐的菜不带这三项（与以前的菜单一样）
    expect(m.dishes.find((d) => d.name === '宫保鸡丁')).not.toHaveProperty('methods');
    const [beef, egg] = noodle.addons!;
    const v = await enter();
    const lines = [
      { itemId: noodle.id, quantity: 1, note: composeDishNote(['微辣', '免葱'], '面硬一点') },
      { itemId: beef!.id, quantity: 1, note: addonNote(noodle.name) },
      { itemId: egg!.id, quantity: 2, note: addonNote(noodle.name) },
      { itemId: set.id, quantity: 2 },
    ];
    const total = 3800 + 1500 + 300 * 2 + 4800 * 2;
    const key = randomUUID();
    const r = await orderTag(v.id, lines, total, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const mine = (await kitchen()).filter((k) => k.visitId === v.id);
    expect(mine.map((k) => `${k.name}×${k.quantity}|${k.note}|${JSON.stringify(k.parts)}`)).toEqual([
      '牛肉面×1|微辣，免葱，面硬一点|[]',
      '加牛肉×1|配 牛肉面|[]',
      '加蛋×2|配 牛肉面|[]',
      '牛肉面套餐×2||[{"name":"柠檬茶","quantity":1},{"name":"牛肉面","quantity":1}]',
    ]);
    // 账上：四条明细，套餐一行按套餐自己的价，合计与确认时一样
    const bill = await ctx.sql<{ name: string; quantity: number; unitPrice: number; amount: number }[]>`
      SELECT l.name, l.quantity, l.unit_price, l.amount FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${v.id} ORDER BY l.id`;
    expect(bill).toEqual([
      { name: '牛肉面（标准）', quantity: 1, unitPrice: 3800, amount: 3800 },
      { name: '加牛肉', quantity: 1, unitPrice: 1500, amount: 1500 },
      { name: '加蛋', quantity: 2, unitPrice: 300, amount: 600 },
      { name: '牛肉面套餐', quantity: 2, unitPrice: 4800, amount: 9600 },
    ]);
    const [b] = await ctx.sql<{ amountCents: number }[]>`SELECT b.amount_cents FROM bills b JOIN visits v ON v.bill_id = b.id WHERE v.id = ${v.id}`;
    expect(b!.amountCents).toBe(total);
    // 同一个操作编号重提：不重复下单
    expect((await orderTag(v.id, lines, total, key)).status).toBe(200);
    expect((await kitchen()).filter((k) => k.visitId === v.id).length).toBe(4);
    // 点菜单上也列出套餐含的几样
    const receipt = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/receipt?visit=${v.id}`)).body as DiningReceipt;
    const all = receipt.orders.flatMap((o) => o.lines);
    expect(all.find((l) => l.name === '牛肉面套餐')!.parts).toEqual([
      { name: '柠檬茶', quantity: 1 },
      { name: '牛肉面', quantity: 1 },
    ]);
    expect(all.find((l) => l.name === '加蛋')).toMatchObject({ note: '配 牛肉面', parts: [] });
  });

  it('出品单上的套餐内容是下单当时的：以后改了套餐，已经下的单不变、新下的按新的；这一项写入以后不可改', async () => {
    const set = await dishOf('牛肉面套餐');
    const egg = await dishOf('加蛋');
    const old = (await kitchen()).filter((k) => k.name === '牛肉面套餐');
    expect(old.length).toBe(1);
    expect((await update(set, { combo: [{ itemId: egg.id, quantity: 3 }] })).status).toBe(200);
    const v = await enter();
    expect((await orderTag(v.id, [{ itemId: set.id, quantity: 1 }], 4800)).status).toBe(200);
    const now = (await kitchen()).filter((k) => k.name === '牛肉面套餐');
    expect(now.find((k) => k.id === old[0]!.id)!.parts).toEqual([
      { name: '柠檬茶', quantity: 1 },
      { name: '牛肉面', quantity: 1 },
    ]);
    expect(now.find((k) => k.visitId === v.id)!.parts).toEqual([{ name: '加蛋', quantity: 3 }]);
    await expect(ctx.sql`UPDATE kitchen_items SET parts = '[]'::jsonb WHERE id = ${old[0]!.id}`).rejects.toThrow('出品单上的套餐内容不可修改');
    // 出品状态照常能改（保护只管套餐内容）
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/kitchen/items/${old[0]!.id}/start`)).status).toBe(200);
  });

  it('桌台点单同一套：备注与套餐内容照样到出品单；金额记在这桌的账上', async () => {
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: 'A1', seats: 4 });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const tableId = t.body.tables.find((x: { name: string }) => x.name === 'A1').id;
    const open = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const noodle = await dishOf('牛肉面');
    const set = await dishOf('牛肉面套餐');
    const egg = await dishOf('加蛋');
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${open.body.id}/orders`, {
      clientKey: randomUUID(),
      lines: [
        { itemId: noodle.id, quantity: 1, note: composeDishNote(['中辣'], '') },
        { itemId: egg.id, quantity: 1, note: addonNote(noodle.name) },
        { itemId: set.id, quantity: 1 },
      ],
      expectedTotal: 3800 + 300 + 4800,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.amount).toBe(8900);
    const mine = (await kitchen()).filter((k) => k.tableSessionId === open.body.id);
    expect(mine.map((k) => `${k.name}|${k.note}|${JSON.stringify(k.parts)}`)).toEqual(['牛肉面|中辣|[]', '加蛋|配 牛肉面|[]', '牛肉面套餐||[{"name":"加蛋","quantity":3}]']);
  });
});

describe('操作记录只追加', () => {
  it('操作编号写入以后不可改、不可删', async () => {
    const [op] = await ctx.sql<{ clientKey: string }[]>`SELECT client_key FROM dish_ops LIMIT 1`;
    await expect(ctx.sql`UPDATE dish_ops SET request_hash = repeat('0', 64) WHERE client_key = ${op!.clientKey}`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM dish_ops WHERE client_key = ${op!.clientKey}`).rejects.toThrow();
  });
});
