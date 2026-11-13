// 8.0.10 点餐系统 · 平板电子菜单（docs/EMENU.md）：岗位「点餐平板」与开关、后台编排（菜品图文、分类、版面、设置、图片、初稿）、
// 平板上的菜单与状态（售罄、下架、时段）、手牌与桌号的输入、点单密码、下单（与点单页同一条挂账路径）、结果待确认、并发与自检。
// 全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { minuteOfDay, type EmenuAdmin, type EmenuMenu } from '../src/shared/emenu';
import { resetLoginThrottle } from '../src/server/auth/lockout';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

/** 1×1 的 PNG */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** 另一张 1×1 的 PNG（内容不同） */
const PNG2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let ctx: TestContext;
let pad: string;
let cook: string;
let padId = 0;
let cookId = 0;
let clerkPin = '';
const item: Record<string, number> = {};
const dish: Record<string, number> = {};
const cat: Record<string, number> = {};
const visit: Record<string, number> = {};

const admin = async () => (await api<EmenuAdmin>(ctx.app, ctx.owner, 'GET', '/api/admin/emenu')).body;
const menu = async (cookie = pad) => (await api<EmenuMenu>(ctx.app, cookie, 'GET', '/api/emenu/menu')).body;
const rules = async (patch: Record<string, unknown>) => {
  const rev = (await admin()).rulesRev;
  return api(ctx.app, ctx.owner, 'PUT', '/api/admin/emenu/rules', { rev, ...patch });
};
const enter = async (code: string, zone: 'male' | 'female' = 'male') => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  visit[code] = r.body.visits[0].id as number;
  return visit[code]!;
};
interface OrderOpts {
  key?: string;
  tag?: string;
  visitId?: number;
  table?: string;
  guests?: number;
  avoid?: string[];
  serve?: string | null;
  customNote?: string;
  pin?: string;
  cookie?: string;
}
const order = (lines: { itemId: number; quantity: number }[], expectedTotal: number, o: OrderOpts = {}) =>
  api(ctx.app, o.cookie ?? pad, 'POST', '/api/emenu/orders', {
    clientKey: o.key ?? randomUUID(),
    visitId: o.visitId ?? visit[o.tag ?? 'A8001'],
    tagCode: o.tag ?? 'A8001',
    tableName: o.table ?? 'A01',
    guests: o.guests ?? 2,
    lines,
    avoid: o.avoid ?? [],
    serve: o.serve ?? null,
    customNote: o.customNote ?? '',
    expectedTotal,
    pin: o.pin ?? clerkPin,
  });
const pinFor = async (staffId: number) => {
  const r = await api(ctx.app, ctx.owner, 'POST', `/api/staff/${staffId}/order-pin`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.pin as string;
};
/** 一定不对的点单密码：与给出的几个都不同 */
const wrongPin = (...taken: string[]) => {
  for (let n = 100001; ; n += 7) {
    const p = String(n);
    if (!taken.some((t) => t.slice(0, 3) === p.slice(0, 3))) return p;
  }
};
const dishLinesOf = async (visitId: number) =>
  ctx.sql<{ name: string; quantity: number; amount: number; postedBy: number; status: string; deliverTo: string | null; note: string | null }[]>`
    SELECT l.name, l.quantity, l.amount, l.posted_by, l.status, k.deliver_to, k.note
    FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id LEFT JOIN kitchen_items k ON k.bill_line_id = l.id
    WHERE v.id = ${visitId} AND l.source = 'dining' ORDER BY l.id`;

beforeAll(async () => {
  ctx = await setup();
  padId = await createStaff(ctx.sql, { username: 'pad1', displayName: '一号桌平板', role: 'tablet', password: PASSWORD, mustChangePassword: false });
  cookId = await createStaff(ctx.sql, { username: 'cook', displayName: '后厨', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  pad = await login(ctx.app, 'pad1');
  cook = await login(ctx.app, 'cook');
  for (const prefix of ['A', 'B']) {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix, from: 8001, to: 8012, width: 4, zone: 'male' })).status).toBe(200);
  }
  for (const [name, category, price] of [
    ['砂锅焗溪鳗（大份）', '中式午餐', 8800],
    ['砂锅焗溪鳗（小份）', '中式午餐', 4800],
    ['龙虾班尼迪蛋', '西式午餐', 4200],
    ['华夫牛角', '西式午餐', 3800],
    ['小梦若奇白葡萄酒', '酒水', 28800],
    ['搓澡', '洗浴', 6800],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '厨房' });
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '厨房').id;
  const kitchen = Object.entries(item).filter(([n]) => n !== '搓澡').map(([, id]) => ({ id, stationId }));
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: kitchen })).status).toBe(200);
  await enter('A8001');
  clerkPin = await pinFor(ctx.clerkId);
});
afterAll(async () => ctx.close());
beforeEach(() => resetLoginThrottle());

describe('岗位「点餐平板」与开关', () => {
  it('平板账号只有「打开平板点餐」：门店系统别的接口都拒绝；不能带职责', async () => {
    const me = await api(ctx.app, pad, 'GET', '/api/auth/me');
    expect(me.body.staff.role).toBe('tablet');
    expect(me.body.permissions).toEqual(['emenu.view']);
    expect(me.body.emenu).toBe(false);
    for (const url of ['/api/frontdesk/board', '/api/members?q=1', '/api/dining/menu', '/api/kitchen', '/api/admin/emenu', '/api/catalog', '/api/staff']) {
      expect((await api(ctx.app, pad, 'GET', url)).status, url).toBe(403);
    }
    expect((await api(ctx.app, pad, 'POST', '/api/auth/order-pin')).status).toBe(403);
    expect((await api(ctx.app, pad, 'PUT', '/api/admin/emenu/rules', { enabled: true })).status).toBe(403);
    const withDuty = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username: 'pad2', displayName: '二号', role: 'tablet', duties: ['stock'] });
    expect(withDuty.status).toBe(422);
    expect(withDuty.body.error.code).toBe('DUTY_CONFLICT');
    const ok = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username: 'pad2', displayName: '二号', role: 'tablet' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('默认关着：菜单 enabled=false，找客人、核对桌号、下单都拒绝；开了平板点餐、没开餐饮功能也不行', async () => {
    expect((await menu()).enabled).toBe(false);
    for (const r of [await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=8001'), await api(ctx.app, pad, 'GET', '/api/emenu/table?table=1'), await order([{ itemId: item['华夫牛角']!, quantity: 1 }], 3800)]) {
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('EMENU_DISABLED');
    }
    expect((await rules({ enabled: true })).status).toBe(200);
    expect((await menu()).enabled).toBe(false);
    expect((await admin()).diningEnabled).toBe(false);
    expect((await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=8001')).body.error.code).toBe('EMENU_DISABLED');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
    expect((await menu()).enabled).toBe(true);
    expect((await api(ctx.app, pad, 'GET', '/api/auth/me')).body.emenu).toBe(true);
  });
});

describe('后台「电子菜单」', () => {
  it('图片：按内容去重、认文件头；平板账号传不了、看得了', async () => {
    const a = await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/images', { mime: 'image/png', data: PNG });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.url).toBe(`/api/emenu/images/${a.body.id}`);
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/images', { mime: 'image/png', data: PNG });
    expect(again.body.id).toBe(a.body.id);
    const fake = await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/images', { mime: 'image/jpeg', data: PNG });
    expect(fake.status).toBe(422);
    expect(fake.body.error.code).toBe('IMAGE_INVALID');
    expect((await api(ctx.app, pad, 'POST', '/api/admin/emenu/images', { mime: 'image/png', data: PNG })).status).toBe(403);
    const got = await ctx.app.inject({ method: 'GET', url: a.body.url, headers: { cookie: pad } });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toContain('immutable');
    expect((await ctx.app.inject({ method: 'GET', url: a.body.url })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: a.body.url, headers: { cookie: cook } })).statusCode).toBe(403);
  });

  it('菜品图文：一个规格不用规格名、几个规格都要写；一个价目项目只能在一道菜里；修改带版本号', async () => {
    const img = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/images', { mime: 'image/png', data: PNG })).body.id as number;
    const detail = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/images', { mime: 'image/png', data: PNG2 })).body.id as number;
    const noLabel = await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', {
      name: '砂锅黄椒酱焗溪鳗',
      specs: [{ itemId: item['砂锅焗溪鳗（大份）'] }, { itemId: item['砂锅焗溪鳗（小份）'] }],
    });
    expect(noLabel.status).toBe(422);
    expect(noLabel.body.error.code).toBe('SPEC_LABEL_REQUIRED');
    const eel = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', {
      name: '砂锅黄椒酱焗溪鳗',
      nameEn: 'Baked Eel With Casserole Yellow Pepper Sauce',
      tagline: '煎档',
      description: '黄椒酱的加入不仅增添了鲜辣馥郁的独特风味。',
      imageId: img,
      detailImageId: detail,
      specs: [
        { itemId: item['砂锅焗溪鳗（大份）'], label: '大份' },
        { itemId: item['砂锅焗溪鳗（小份）'], label: '小份' },
      ],
    });
    expect(eel.status, JSON.stringify(eel.body)).toBe(200);
    dish.eel = eel.body.dishes.find((d) => d.name === '砂锅黄椒酱焗溪鳗')!.id;
    // 重复提交（没收到结果又点了一次）：规格的唯一索引拦下，不会建出两道
    const dup = await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', { name: '砂锅黄椒酱焗溪鳗', specs: [{ itemId: item['砂锅焗溪鳗（大份）'] }] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ITEM_IN_OTHER_DISH');
    expect(dup.body.error.message).toContain('砂锅黄椒酱焗溪鳗');
    for (const [key, name, itemName, extra] of [
      ['benedict', '龙虾班尼迪蛋', '龙虾班尼迪蛋', { nameEn: 'Lobster Benedict' }],
      ['waffle', '华夫牛角', '华夫牛角', { nameEn: 'Waffle Croissant', tagline: '蓝莓，草莓，相印提子' }],
      ['wine', '小梦若奇白葡萄酒', '小梦若奇白葡萄酒', { nameEn: 'MOUNT ROZIER WHITE', attrs: ['产地：法国', '年份：NV'], unit: '瓶' }],
    ] as const) {
      const r = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', { name, ...extra, specs: [{ itemId: item[itemName], label: '多余的' }] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const d = r.body.dishes.find((x) => x.name === name)!;
      dish[key] = d.id;
      // 只有一个规格：规格名不存
      expect(d.specs).toEqual([{ itemId: item[itemName], label: '', labelEn: '', itemName, price: expect.any(Number), orderable: true }]);
    }
    // 不存在的项目
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/dishes', { name: '没有的菜', specs: [{ itemId: 999999 }] })).body.error.code).toBe('DISH_REF_NOT_FOUND');
    // 修改：版本号对不上拒绝
    const cur = (await admin()).dishes.find((d) => d.id === dish.waffle)!;
    const body = { ...cur, specs: cur.specs.map((s) => ({ itemId: s.itemId, label: s.label })), description: '现烤' };
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/dishes/${cur.id}`, body)).status).toBe(200);
    const stale = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/dishes/${cur.id}`, body);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('EMENU_CHANGED');
    // 能选的价目项目：进厨房的才在，已经进了菜的带上是哪道
    const a = await admin();
    expect(a.items.map((i) => i.name)).not.toContain('搓澡');
    expect(a.items.find((i) => i.name === '龙虾班尼迪蛋')!.dishId).toBe(dish.benedict);
  });

  it('分类与各页：名称不重复、时段、版本号；一页至少一道菜、不超过版面的位置数、同一页不重复', async () => {
    const lunch = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/categories', { name: '中式午餐', nameEn: 'CHINESE LUNCH', sortOrder: 2 });
    expect(lunch.status, JSON.stringify(lunch.body)).toBe(200);
    cat.lunch = lunch.body.categories.find((c) => c.name === '中式午餐')!.id;
    const dupName = await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/categories', { name: ' 中式午餐 ' });
    expect(dupName.status).toBe(409);
    expect(dupName.body.error.code).toBe('CATEGORY_NAME_TAKEN');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/categories', { name: '坏时段', window: { start: 600, end: 600 } })).status).toBe(400);
    const west = await api<EmenuAdmin>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/categories', { name: '西式午餐', nameEn: 'WESTERN LUNCH', sortOrder: 1 });
    cat.west = west.body.categories.find((c) => c.name === '西式午餐')!.id;

    const save = (id: number, version: number, pages: unknown[]) => api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/categories/${id}/pages`, { version, pages });
    const v0 = (await admin()).categories.find((c) => c.id === cat.lunch)!.version;
    expect((await save(cat.lunch!, v0, [{ layout: 'single_wide', dishIds: [dish.eel, dish.wine] }])).body.error.code).toBe('PAGE_TOO_MANY');
    expect((await save(cat.lunch!, v0, [{ layout: 'trio_row', dishIds: [null, null] }])).body.error.code).toBe('PAGE_EMPTY');
    expect((await save(cat.lunch!, v0, [{ layout: 'duo_row', dishIds: [dish.eel, dish.eel] }])).body.error.code).toBe('PAGE_DUPLICATE_DISH');
    expect((await save(cat.lunch!, v0, [{ layout: 'duo_row', dishIds: [dish.eel, 999999] }])).body.error.code).toBe('DISH_NOT_FOUND');
    const ok = await save(cat.lunch!, v0, [
      { layout: 'cover', dishIds: [dish.eel], title: '不该存', titleEn: 'NOPE' },
      { layout: 'list_text', title: '酒水', titleEn: 'BEVERAGE', dishIds: [dish.wine, null, dish.eel, null] },
    ]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const saved = (ok.body as EmenuAdmin).categories.find((c) => c.id === cat.lunch)!;
    expect(saved.version).toBe(v0 + 1);
    // 没有竖排小标题的版面不存小标题；末尾的空位去掉、中间的留着
    expect(saved.pages).toEqual([
      { layout: 'cover', title: '', titleEn: '', dishIds: [dish.eel] },
      { layout: 'list_text', title: '酒水', titleEn: 'BEVERAGE', dishIds: [dish.wine, null, dish.eel] },
    ]);
    const stale = await save(cat.lunch!, v0, [{ layout: 'cover', dishIds: [dish.eel] }]);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('EMENU_CHANGED');
    const vw = (await admin()).categories.find((c) => c.id === cat.west)!.version;
    expect((await save(cat.west!, vw, [{ layout: 'duo_row', dishIds: [dish.benedict, dish.waffle] }])).status).toBe(200);
    expect((await admin()).dishes.find((d) => d.id === dish.eel)!.usedIn).toEqual(['中式午餐']);
    // 改名、改时段也带版本号
    const c = (await admin()).categories.find((x) => x.id === cat.west)!;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/categories/${c.id}`, { ...c, nameEn: 'WESTERN LUNCH ' })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/categories/${c.id}`, { ...c, name: '中式午餐' })).body.error.code).toBe('EMENU_CHANGED');
  });

  it('设置：只交改过的项、带版本；选项太长放不进口味备注时拒绝', async () => {
    const a = await admin();
    expect(a.rules).toMatchObject({ enabled: true, idleMinutes: 10, offHours: 'hide', avoidOptions: ['不加香菜', '不加辣椒', '少辣', '不加洋葱', '不加香葱', '重辣'], serveOptions: ['即起', '慢起'] });
    const stale = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/emenu/rules', { rev: 'old', idleMinutes: 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('EMENU_CHANGED');
    const ok = await rules({ idleMinutes: 5 });
    expect(ok.status).toBe(200);
    expect(ok.body.rules).toMatchObject({ idleMinutes: 5, enabled: true });
    expect(ok.body.rulesRev).not.toBe(a.rulesRev);
    const long = await rules({ avoidOptions: Array.from({ length: 12 }, (_, i) => `不要忌口${String(i).padStart(2, '0')}`) });
    expect(long.status).toBe(422);
    expect(long.body.error.code).toBe('REMARK_OPTIONS_TOO_LONG');
    expect((await rules({ avoidOptions: ['少辣', '少辣'] })).status).toBe(400);
    expect((await rules({ coverImageId: 999999 })).body.error.code).toBe('IMAGE_NOT_FOUND');
    // 规则总表有「点餐系统」一组（不混进「餐饮」那一组）；改过的那一项标出来，改回默认以后不标
    type Entry = { key: string; group: string; isDefault: boolean; value: string; section: string; updatedBy: string | null };
    let catalog = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as Entry[];
    expect(catalog.filter((r) => r.group === 'emenu').map((r) => r.key)).toEqual(['emenu_rules.enabled', 'emenu_rules.avoidOptions', 'emenu_rules.serveOptions', 'emenu_rules.idleMinutes', 'emenu_rules.offHours']);
    expect(catalog.find((r) => r.key === 'emenu_rules.idleMinutes')).toMatchObject({ isDefault: false, value: '5 分钟没人动回到起始页、清掉没下单的菜', section: 'emenu' });
    expect(catalog.find((r) => r.key === 'emenu_rules.idleMinutes')!.updatedBy).not.toBeNull();
    expect(catalog.find((r) => r.key === 'emenu_rules.offHours')).toMatchObject({ isDefault: true, value: '平板上不显示' });
    expect((await rules({ idleMinutes: 10 })).status).toBe(200);
    catalog = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as Entry[];
    expect(catalog.find((r) => r.key === 'emenu_rules.idleMinutes')).toMatchObject({ isDefault: true });
  });

  it('从价目表生成初稿：只补还没进电子菜单的菜，再点一次什么都不加', async () => {
    const extra = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '干锅杂菌', category: '中式午餐', price: 4200 });
    item['干锅杂菌'] = extra.body.items.find((i: { name: string }) => i.name === '干锅杂菌').id;
    const tea = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '陈皮普洱', category: '茶', price: 6800 });
    item['陈皮普洱'] = tea.body.items.find((i: { name: string }) => i.name === '陈皮普洱').id;
    const stationId = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/dining')).body.stations[0].id;
    await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: item['干锅杂菌'], stationId }, { id: item['陈皮普洱'], stationId }] });
    const before = await admin();
    const r = await api<EmenuAdmin & { draft: { dishes: number; categories: number; pages: number } }>(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/draft');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.draft).toEqual({ dishes: 2, categories: 1, pages: 2 });
    const lunch = r.body.categories.find((c) => c.id === cat.lunch)!;
    // 接在已有的页后面，原来排好的不动
    expect(lunch.pages.slice(0, 2)).toEqual(before.categories.find((c) => c.id === cat.lunch)!.pages);
    expect(lunch.pages[2]).toMatchObject({ layout: 'list_text', title: '中式午餐' });
    expect(lunch.version).toBe(before.categories.find((c) => c.id === cat.lunch)!.version + 1);
    const teaCat = r.body.categories.find((c) => c.name === '茶')!;
    expect(teaCat.pages).toHaveLength(1);
    dish.mushroom = r.body.dishes.find((d) => d.name === '干锅杂菌')!.id;
    dish.tea = r.body.dishes.find((d) => d.name === '陈皮普洱')!.id;
    cat.tea = teaCat.id;
    const again = await api(ctx.app, ctx.owner, 'POST', '/api/admin/emenu/draft');
    expect(again.body.draft).toEqual({ dishes: 0, categories: 0, pages: 0 });
  });
});

describe('平板上的菜单', () => {
  it('按排序列出分类与各页；规格的价格读价目表；估清、下架、停用都跟着变', async () => {
    const m = await menu();
    expect(m.enabled).toBe(true);
    expect(m.categories.map((c) => c.name)).toEqual(['西式午餐', '中式午餐', '茶']);
    expect(m.categories.every((c) => c.open && c.window === null)).toBe(true);
    const lunch = m.categories.find((c) => c.name === '中式午餐')!;
    expect(lunch.pages[0]!.layout).toBe('cover');
    const eel = lunch.pages[0]!.dishes[0]!;
    expect(eel).toMatchObject({ name: '砂锅黄椒酱焗溪鳗', tagline: '煎档', unit: '份' });
    expect(eel.imageUrl).toMatch(/^\/api\/emenu\/images\/\d+$/);
    expect(eel.detailUrl).not.toBe(eel.imageUrl);
    expect(eel.specs).toEqual([
      { itemId: item['砂锅焗溪鳗（大份）'], label: '大份', labelEn: '', price: 8800, state: 'ok', remaining: null },
      { itemId: item['砂锅焗溪鳗（小份）'], label: '小份', labelEn: '', price: 4800, state: 'ok', remaining: null },
    ]);
    // 中间的空位是 null
    expect(lunch.pages[1]!.dishes.map((d) => d?.name ?? null)).toEqual(['小梦若奇白葡萄酒', null, '砂锅黄椒酱焗溪鳗']);

    const specOf = async (itemId: number) => (await menu()).categories.flatMap((c) => c.pages).flatMap((p) => p.dishes).flatMap((d) => d?.specs ?? []).find((s) => s.itemId === itemId)!;
    // 估清
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${item['砂锅焗溪鳗（小份）']}`, { remaining: 0 })).status).toBe(200);
    expect(await specOf(item['砂锅焗溪鳗（小份）']!)).toMatchObject({ state: 'sold_out', remaining: 0 });
    expect((await specOf(item['砂锅焗溪鳗（大份）']!)).state).toBe('ok');
    await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${item['砂锅焗溪鳗（小份）']}`, { remaining: null });
    // 改价
    const cur = (await api(ctx.app, ctx.owner, 'GET', '/api/catalog?all=1')).body.items.find((i: { id: number }) => i.id === item['陈皮普洱']);
    await api(ctx.app, ctx.owner, 'PUT', `/api/items/${cur.id}`, { name: cur.name, category: cur.category, price: 7800 });
    expect((await specOf(item['陈皮普洱']!)).price).toBe(7800);
    // 价目项目停用 → 已下架
    await api(ctx.app, ctx.owner, 'PUT', `/api/items/${cur.id}`, { name: cur.name, category: cur.category, price: 7800, active: false });
    expect((await specOf(item['陈皮普洱']!)).state).toBe('off');
    await api(ctx.app, ctx.owner, 'PUT', `/api/items/${cur.id}`, { name: cur.name, category: cur.category, price: 7800, active: true });
    expect((await specOf(item['陈皮普洱']!)).state).toBe('ok');
    // 不再挂出品档口 → 已下架
    const stationId = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/dining')).body.stations[0].id;
    await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: item['陈皮普洱'], stationId: null }] });
    expect((await specOf(item['陈皮普洱']!)).state).toBe('off');
    await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: item['陈皮普洱'], stationId }] });
  });

  it('供应时段：不在时段的分类默认不显示（列在 later 里），设置成显示以后在、但 open=false', async () => {
    const now = minuteOfDay(new Date(), ctx.config.timezone);
    const closed = { start: (now + 120) % 1440, end: (now + 180) % 1440 };
    const c = (await admin()).categories.find((x) => x.id === cat.tea)!;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/categories/${c.id}`, { ...c, window: closed })).status).toBe(200);
    let m = await menu();
    expect(m.categories.map((x) => x.name)).toEqual(['西式午餐', '中式午餐']);
    expect(m.later).toEqual([{ name: '茶', nameEn: '', window: closed }]);
    expect((await rules({ offHours: 'show' })).status).toBe(200);
    m = await menu();
    expect(m.categories.find((x) => x.name === '茶')).toMatchObject({ open: false, window: closed });
    expect(m.later).toEqual([]);
    // 正在时段里（跨零点的也认）
    const c2 = (await admin()).categories.find((x) => x.id === cat.tea)!;
    const open = { start: (now + 1380) % 1440, end: (now + 60) % 1440 };
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/categories/${c2.id}`, { ...c2, window: open });
    expect((await menu()).categories.find((x) => x.name === '茶')!.open).toBe(true);
    const c3 = (await admin()).categories.find((x) => x.id === cat.tea)!;
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/categories/${c3.id}`, { ...c3, window: closed });
    await rules({ offHours: 'hide' });
  });
});

describe('手牌与桌号', () => {
  it('只输数字找得到；数字对得上两张在店的牌让选；不在店的提示；只给餐饮明细', async () => {
    const byDigits = await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=8001');
    expect(byDigits.status, JSON.stringify(byDigits.body)).toBe(200);
    expect(byDigits.body).toEqual({ visitId: visit.A8001, tagCode: 'A8001', ordered: [], orderedTotal: 0 });
    expect((await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=a8001')).body.tagCode).toBe('A8001');
    await enter('B8001');
    const two = await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=8001');
    expect(two.status).toBe(409);
    expect(two.body.error.code).toBe('TAG_AMBIGUOUS');
    expect(two.body.error.details.candidates).toEqual(['A8001', 'B8001']);
    expect((await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=B8001')).body.visitId).toBe(visit.B8001);
    const none = await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=8002');
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('TAG_NOT_IN_STORE');
    expect((await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=')).status).toBe(400);
    expect((await api(ctx.app, cook, 'GET', '/api/emenu/guest?tag=8001')).status).toBe(403);
    // 别的消费（浴资）不出现在已下单里
    await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visit.A8001}/charges`, { clientKey: randomUUID(), lines: [{ itemId: item['搓澡'], quantity: 1 }], expectedTotal: 6800 });
    expect((await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=A8001')).body.ordered).toEqual([]);
  });

  it('桌号：没建桌台照输入的记；建了以后只能填建过的，只输数字也行，重了让选', async () => {
    expect((await api(ctx.app, pad, 'GET', '/api/emenu/table?table=12')).body).toEqual({ tableName: '12' });
    for (const name of ['A01', 'A02', 'B01', '包间 8']) {
      expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name, area: '大厅', seats: 4 })).status).toBeLessThan(300);
    }
    expect((await menu()).tables.map((t) => t.name)).toEqual(['A01', 'A02', 'B01', '包间 8']);
    expect((await api(ctx.app, pad, 'GET', '/api/emenu/table?table=a02')).body).toEqual({ tableName: 'A02' });
    expect((await api(ctx.app, pad, 'GET', '/api/emenu/table?table=2')).body).toEqual({ tableName: 'A02' });
    expect((await api(ctx.app, pad, 'GET', '/api/emenu/table?table=8')).body).toEqual({ tableName: '包间 8' });
    const two = await api(ctx.app, pad, 'GET', '/api/emenu/table?table=01');
    expect(two.status).toBe(409);
    expect(two.body.error.details.candidates).toEqual(['A01', 'B01']);
    const none = await api(ctx.app, pad, 'GET', '/api/emenu/table?table=99');
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('TABLE_NOT_FOUND');
  });
});

describe('点单密码', () => {
  it('系统生成 6 位、当场显示一次；店主给人生成与收回，本人也能自己重新生成；平板账号、停用的不发', async () => {
    expect(clerkPin).toMatch(/^[0-9]{6}$/);
    const staff = (await api(ctx.app, ctx.owner, 'GET', '/api/staff')).body as { id: number; orderPinSetAt: string | null }[];
    expect(staff.find((s) => s.id === ctx.clerkId)!.orderPinSetAt).toBeTruthy();
    expect(staff.find((s) => s.id === cookId)!.orderPinSetAt).toBeNull();
    // 库里没有明文
    const [row] = await ctx.sql<{ slot: string; pinHash: string }[]>`SELECT slot, pin_hash FROM staff_order_pins WHERE staff_id = ${ctx.clerkId}`;
    expect(row!.slot).toBe(clerkPin.slice(0, 3));
    expect(row!.pinHash).toMatch(/^scrypt\$/);
    expect(row!.pinHash).not.toContain(clerkPin);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/staff/${ctx.clerkId}/order-pin`)).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/order-pin')).body).toMatchObject({ has: true });
    const mine = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/order-pin');
    expect(mine.status).toBe(200);
    expect(mine.body.pin).toMatch(/^[0-9]{6}$/);
    expect(mine.body.pin).not.toBe(clerkPin);
    // 旧的马上不能用了
    const old = await order([{ itemId: item['华夫牛角']!, quantity: 1 }], 3800);
    expect(old.status).toBe(403);
    expect(old.body.error.code).toBe('PIN_INVALID');
    clerkPin = mine.body.pin;
    // 后厨没有「餐饮点单」：自己生成不了
    expect((await api(ctx.app, cook, 'POST', '/api/auth/order-pin')).status).toBe(403);
    const tabletPin = await api(ctx.app, ctx.owner, 'POST', `/api/staff/${padId}/order-pin`);
    expect(tabletPin.status).toBe(422);
    expect(tabletPin.body.error.code).toBe('PIN_NOT_FOR_TABLET');
    // 审计里没有密码
    const logs = await ctx.sql<{ detail: unknown }[]>`SELECT detail FROM audit_logs WHERE action = 'order_pin_set'`;
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs)).not.toContain(clerkPin);
  });

  it('输错 5 次这台平板锁 5 分钟，别的平板不受影响；没有点单权限的密码被拒（不算输错）；收回、停用以后不能用', async () => {
    const line = [{ itemId: item['华夫牛角']!, quantity: 1 }];
    const bad = wrongPin(clerkPin);
    for (let i = 0; i < 4; i += 1) {
      const r = await order(line, 3800, { pin: bad });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('PIN_INVALID');
    }
    const fifth = await order(line, 3800, { pin: bad });
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('PIN_LOCKED');
    // 锁着的时候对的密码也不行
    expect((await order(line, 3800)).body.error.code).toBe('PIN_LOCKED');
    // 同一来源的另一台平板（另一个账号）照常
    const pad2 = await login(ctx.app, 'pad2', (await api(ctx.app, ctx.owner, 'POST', `/api/staff/${(await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'pad2'`)[0]!.id}/reset-password`)).body.temporaryPassword);
    // pad2 首次登录要改密码：直接在库里放行，测的是限次
    await ctx.sql`UPDATE staff SET must_change_password = false WHERE username = 'pad2'`;
    const other = await order(line, 3800, { cookie: pad2, pin: bad });
    expect(other.body.error.code).toBe('PIN_INVALID');
    resetLoginThrottle();
    const failures = async () => (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'order_pin_failed'`)[0]!.n;
    expect(await failures()).toBeGreaterThanOrEqual(6);
    // 同时发来一大批错的：同一台平板一个一个核对，也是错满 5 次就锁，后面的不再核对（审计里只多 5 条）
    const before = await failures();
    const burst = await Promise.all(Array.from({ length: 40 }, () => order(line, 3800, { pin: bad })));
    const codes = burst.map((r) => r.body.error?.code as string);
    expect(codes.filter((c) => c === 'PIN_INVALID')).toHaveLength(4);
    expect(codes.filter((c) => c === 'PIN_LOCKED')).toHaveLength(36);
    expect((await failures()) - before).toBe(5);
    // 锁着的时候对的密码回的与错的一样（分不出哪个是对的），没有下成单
    const lockedRight = await order(line, 3800);
    expect([lockedRight.status, lockedRight.body.error.code]).toEqual([429, 'PIN_LOCKED']);
    // 点单密码单独计数：平板上错了这么多次，这个来源照常能登录；换个来源地址也还是锁着（只按平板的账号记）
    expect(await login(ctx.app, 'clerk')).toContain('yuzu_sid=');
    const elsewhere = await ctx.app.inject({ method: 'POST', url: '/api/emenu/orders', remoteAddress: '10.9.8.7', headers: { cookie: pad }, payload: { clientKey: randomUUID(), visitId: visit.A8001, tagCode: 'A8001', tableName: 'A01', guests: 2, lines: line, avoid: [], serve: null, customNote: '', expectedTotal: 3800, pin: clerkPin } });
    expect(elsewhere.json().error.code).toBe('PIN_LOCKED');
    resetLoginThrottle();
    // 格式不对不算输错
    expect((await order(line, 3800, { pin: '12345' })).status).toBe(400);
    expect((await order(line, 3800, { pin: 'abcdef' })).status).toBe(400);

    // 后厨有密码（店主给的）但没有点单权限
    const cookPin = await pinFor(cookId);
    const noPerm = await order(line, 3800, { pin: cookPin });
    expect(noPerm.status).toBe(403);
    expect(noPerm.body.error.code).toBe('PIN_NO_PERMISSION');
    expect(noPerm.body.error.message).toContain('后厨');
    // 收回
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/staff/${cookId}/order-pin/clear`)).status).toBe(200);
    expect((await order(line, 3800, { pin: cookPin })).body.error.code).toBe('PIN_INVALID');
    // 停用的员工
    const tempId = await createStaff(ctx.sql, { username: 'temp', displayName: '临时工', role: 'clerk', password: PASSWORD, mustChangePassword: false });
    const tempPin = await pinFor(tempId);
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${tempId}`;
    expect((await order(line, 3800, { pin: tempPin })).body.error.code).toBe('PIN_INVALID');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/staff/${tempId}/order-pin`)).body.error.code).toBe('STAFF_INACTIVE');
    // 都没有下成单
    expect(await dishLinesOf(visit.A8001!)).toHaveLength(0);
  });
});

describe('下单', () => {
  it('服务员输密码确认：菜挂到手牌账单上（经办人是服务员）、进厨房带桌号与整单备注、写点餐单；原样重提只生效一次', async () => {
    const key = randomUUID();
    const lines = [
      { itemId: item['砂锅焗溪鳗（大份）']!, quantity: 1 },
      { itemId: item['华夫牛角']!, quantity: 2 },
    ];
    const r = await order(lines, 8800 + 7600, { key, table: 'a01', guests: 3, avoid: ['少辣', '不加香菜'], serve: '慢起', customNote: ' 老人牙口不好 ' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ tableName: 'A01', guests: 3, total: 16400, quantity: 3, waiterName: '测试店员', replayed: false });
    expect(r.body.orderNo).toMatch(/^CD/);
    expect(r.body.guest.orderedTotal).toBe(16400);
    expect(r.body.guest.ordered.map((l: { name: string; nameEn: string; quantity: number; amount: number }) => [l.name, l.nameEn, l.quantity, l.amount])).toEqual([
      ['砂锅焗溪鳗（大份）', 'Baked Eel With Casserole Yellow Pepper Sauce', 1, 8800],
      ['华夫牛角', 'Waffle Croissant', 2, 7600],
    ]);
    // 备注按设置里的顺序拼
    const note = '不加香菜，少辣，慢起，老人牙口不好';
    expect(await dishLinesOf(visit.A8001!)).toEqual([
      { name: '砂锅焗溪鳗（大份）', quantity: 1, amount: 8800, postedBy: ctx.clerkId, status: 'active', deliverTo: 'A01', note },
      { name: '华夫牛角', quantity: 2, amount: 7600, postedBy: ctx.clerkId, status: 'active', deliverTo: 'A01', note },
    ]);
    const [o] = await ctx.sql<{ tagCode: string; tableName: string; guests: number; avoid: string[]; serve: string; customNote: string; note: string; total: number; lineCount: number; quantity: number; waiterId: number; deviceStaffId: number }[]>`
      SELECT tag_code, table_name, guests, avoid, serve, custom_note, note, total, line_count, quantity, waiter_id, device_staff_id FROM emenu_orders WHERE client_key = ${key}`;
    expect(o).toEqual({ tagCode: 'A8001', tableName: 'A01', guests: 3, avoid: ['不加香菜', '少辣'], serve: '慢起', customNote: '老人牙口不好', note, total: 16400, lineCount: 2, quantity: 3, waiterId: ctx.clerkId, deviceStaffId: padId });
    // 厨房屏看得到桌号与备注
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/kitchen')).body.items as { name: string; deliverTo: string; note: string; tagCode: string }[];
    expect(board.find((k) => k.name === '华夫牛角')).toMatchObject({ deliverTo: 'A01', note, tagCode: 'A8001' });
    // 前台这张手牌的账单上有这两道
    const v = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${visit.A8001}`)).body;
    expect(v.lines.filter((l: { source: string }) => l.source === 'dining')).toHaveLength(2);
    // 审计：经办人是服务员，记下哪台平板
    const [log] = await ctx.sql<{ staffId: number; detail: { deviceUsername: string; summary: string } }[]>`SELECT staff_id, detail FROM audit_logs WHERE action = 'emenu_order' ORDER BY id DESC LIMIT 1`;
    expect(Number(log!.staffId)).toBe(ctx.clerkId);
    expect(log!.detail.deviceUsername).toBe('pad1');
    expect(log!.detail.summary).toContain('桌 A01');

    // 原样重提：返回第一次的结果，不多记
    const again = await order(lines, 16400, { key, table: 'a01', guests: 3, avoid: ['少辣', '不加香菜'], serve: '慢起', customNote: ' 老人牙口不好 ' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ total: 16400, replayed: true, orderNo: r.body.orderNo });
    expect(await dishLinesOf(visit.A8001!)).toHaveLength(2);
    // 同一个编号换了内容：拒绝
    const other = await order(lines, 16400, { key, table: 'a01', guests: 4 });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 重提也要输对密码
    expect((await order(lines, 16400, { key, table: 'a01', guests: 3, avoid: ['少辣', '不加香菜'], serve: '慢起', customNote: ' 老人牙口不好 ', pin: wrongPin(clerkPin) })).body.error.code).toBe('PIN_INVALID');
    // 已下单里看得到；别的渠道点的也在
    await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId: visit.A8001, lines: [{ itemId: item['龙虾班尼迪蛋'], quantity: 1 }], expectedTotal: 4200 });
    const g = (await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=A8001')).body;
    expect(g.ordered.map((l: { name: string }) => l.name)).toEqual(['砂锅焗溪鳗（大份）', '华夫牛角', '龙虾班尼迪蛋']);
    expect(g.orderedTotal).toBe(20600);
  });

  it('各种拒绝：价格变了、估清、不在电子菜单、不在时段、桌号、手牌换了人、备注选项、格式', async () => {
    const waffle = [{ itemId: item['华夫牛角']!, quantity: 1 }];
    const code = async (p: Promise<{ status: number; body: { error?: { code: string } } }>) => (await p).body.error?.code;
    expect(await code(order(waffle, 3900))).toBe('PRICE_CHANGED');
    // 估清
    await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${item['华夫牛角']}`, { remaining: 1 });
    expect(await code(order([{ itemId: item['华夫牛角']!, quantity: 2 }], 7600))).toBe('DISH_SOLD_OUT');
    await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${item['华夫牛角']}`, { remaining: null });
    // 进厨房、但不在电子菜单上的菜；不进厨房的项目
    const off = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '隐藏菜', category: '中式午餐', price: 100 });
    const offId = off.body.items.find((i: { name: string }) => i.name === '隐藏菜').id as number;
    const stationId = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/dining')).body.stations[0].id;
    await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: offId, stationId }] });
    expect(await code(order([{ itemId: offId, quantity: 1 }], 100))).toBe('DISH_NOT_ON_MENU');
    expect(await code(order([{ itemId: item['搓澡']!, quantity: 1 }], 6800))).toBe('DISH_NOT_ON_MENU');
    // 菜品图文停用
    const d = (await admin()).dishes.find((x) => x.id === dish.mushroom)!;
    await api(ctx.app, ctx.owner, 'PUT', `/api/admin/emenu/dishes/${d.id}`, { ...d, specs: d.specs.map((s) => ({ itemId: s.itemId, label: s.label })), active: false });
    expect(await code(order([{ itemId: item['干锅杂菌']!, quantity: 1 }], 4200))).toBe('DISH_NOT_ON_MENU');
    // 不在供应时段（「茶」现在关着）
    expect(await code(order([{ itemId: item['陈皮普洱']!, quantity: 1 }], 7800))).toBe('DISH_NOT_AVAILABLE_NOW');
    // 桌号
    expect(await code(order(waffle, 3800, { table: '99' }))).toBe('TABLE_NOT_FOUND');
    expect(await code(order(waffle, 3800, { table: '01' }))).toBe('TABLE_AMBIGUOUS');
    expect((await order(waffle, 3800, { table: '' })).status).toBe(400);
    // 手牌：页面上的牌号与这次来访对不上
    expect(await code(order(waffle, 3800, { tag: 'B8001', visitId: visit.A8001 }))).toBe('TAG_CHANGED');
    // 备注的选项不在设置里
    expect(await code(order(waffle, 3800, { avoid: ['不要葱'] }))).toBe('REMARK_OPTION_INVALID');
    expect(await code(order(waffle, 3800, { serve: '快点' }))).toBe('REMARK_OPTION_INVALID');
    // 格式
    expect((await order([], 3800)).status).toBe(400);
    expect((await order([{ itemId: item['华夫牛角']!, quantity: 1 }, { itemId: item['华夫牛角']!, quantity: 1 }], 7600)).status).toBe(400);
    expect((await order([{ itemId: item['华夫牛角']!, quantity: 100 }], 380000)).status).toBe(400);
    expect((await order(waffle, 3800, { guests: 0 })).status).toBe(400);
    expect((await order(waffle, 3800, { customNote: '字'.repeat(31) })).status).toBe(400);
    // 没登录、没有「打开平板点餐」
    expect((await order(waffle, 3800, { cookie: cook })).status).toBe(403);
    expect((await api(ctx.app, null, 'POST', '/api/emenu/orders', {})).status).toBe(401);
    // 客人已结账离店
    await enter('A8005');
    await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visit.A8005}/cancel`, { reason: '登记错了' });
    const gone = await order(waffle, 3800, { tag: 'A8005' });
    expect(gone.status).toBe(409);
    expect(gone.body.error.code).toBe('VISIT_CLOSED');
    // 上面这些都没有下成
    expect(await dishLinesOf(visit.A8001!)).toHaveLength(3);
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM emenu_orders`)[0]!.n).toBe(1);
  });

  it('整单备注最长的情形（选项全选 + 30 字自定义）放得进出品单；口味备注放宽到 100 字', async () => {
    const all = (await admin()).rules.avoidOptions;
    const custom = '备'.repeat(30);
    const r = await order([{ itemId: item['龙虾班尼迪蛋']!, quantity: 1 }], 4200, { tag: 'B8001', avoid: all, serve: '即起', customNote: custom });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [k] = await dishLinesOf(visit.B8001!);
    expect(k!.note).toBe(`${all.join('，')}，即起，${custom}`);
    expect(k!.note!.length).toBeGreaterThan(40);
    expect(k!.note!.length).toBeLessThanOrEqual(100);
  });
});

describe('结果待确认', () => {
  it('查回：查不到不等于没生效；确认作废（要密码）以后原请求不再生效；已经生效的不作废、返回结果', async () => {
    const key = randomUUID();
    const lines = [{ itemId: item['华夫牛角']!, quantity: 1 }];
    expect((await api(ctx.app, pad, 'GET', `/api/emenu/orders/by-key/${key}`)).body).toEqual({ found: false, abandoned: false });
    expect((await api(ctx.app, pad, 'GET', '/api/emenu/orders/by-key/not-a-key')).status).toBe(400);
    // 作废要对的点单密码
    const noPin = await api(ctx.app, pad, 'POST', `/api/emenu/orders/by-key/${key}/abandon`, { pin: wrongPin(clerkPin) });
    expect(noPin.status).toBe(403);
    expect(noPin.body.error.code).toBe('PIN_INVALID');
    const done = await api(ctx.app, pad, 'POST', `/api/emenu/orders/by-key/${key}/abandon`, { pin: clerkPin });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({ found: false, abandoned: true });
    expect((await api(ctx.app, pad, 'GET', `/api/emenu/orders/by-key/${key}`)).body).toEqual({ found: false, abandoned: true });
    // 迟到的原请求：整笔拒绝
    const late = await order(lines, 3800, { key, tag: 'B8001' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    expect(await dishLinesOf(visit.B8001!)).toHaveLength(1);
    // 作废记在审计里，经办人是输密码的服务员
    const [log] = await ctx.sql<{ staffId: number }[]>`SELECT staff_id FROM audit_logs WHERE action = 'frontdesk_abandon' AND target_id = ${key}`;
    expect(Number(log!.staffId)).toBe(ctx.clerkId);

    // 已经生效的：查回、作废都返回那一单
    const key2 = randomUUID();
    expect((await order(lines, 3800, { key: key2, tag: 'B8001', table: 'B01' })).status).toBe(200);
    const found = await api(ctx.app, pad, 'GET', `/api/emenu/orders/by-key/${key2}`);
    expect(found.body).toMatchObject({ found: true, order: { total: 3800, tableName: 'B01', replayed: true } });
    const keep = await api(ctx.app, pad, 'POST', `/api/emenu/orders/by-key/${key2}/abandon`, { pin: clerkPin });
    expect(keep.body).toMatchObject({ found: true, order: { total: 3800 } });
    expect(await dishLinesOf(visit.B8001!)).toHaveLength(2);
    // 前台别的挂账的编号不能在平板上当点餐单作废
    const key3 = randomUUID();
    await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: key3, visitId: visit.B8001, lines: [{ itemId: item['龙虾班尼迪蛋'], quantity: 1 }], expectedTotal: 4200 });
    const foreign = await api(ctx.app, pad, 'POST', `/api/emenu/orders/by-key/${key3}/abandon`, { pin: clerkPin });
    expect(foreign.status).toBe(409);
    expect(foreign.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await api(ctx.app, pad, 'GET', `/api/emenu/orders/by-key/${key3}`)).body).toEqual({ found: false, abandoned: false });
  });
});

describe('并发与自检', () => {
  it('最后一份：两台平板同时下单只有一台成功', async () => {
    await enter('A8006');
    await enter('A8007');
    await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${item['龙虾班尼迪蛋']}`, { remaining: 1 });
    const line = [{ itemId: item['龙虾班尼迪蛋']!, quantity: 1 }];
    const results = await Promise.all([order(line, 4200, { tag: 'A8006', table: 'A02' }), order(line, 4200, { tag: 'A8007', table: 'B01' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('DISH_SOLD_OUT');
    await api(ctx.app, ctx.owner, 'PUT', `/api/kitchen/limits/${item['龙虾班尼迪蛋']}`, { remaining: null });
  });

  it('同一个操作编号同时提交两次：只下一单', async () => {
    const key = randomUUID();
    const line = [{ itemId: item['华夫牛角']!, quantity: 1 }];
    const results = await Promise.all([order(line, 3800, { key, tag: 'A8006', table: 'A02' }), order(line, 3800, { key, tag: 'A8006', table: 'A02' })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.replayed).sort()).toEqual([false, true]);
    expect((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bill_lines WHERE post_key = ${key}`)[0]!.n).toBe(1);
  });

  it('退菜以后点餐单照旧对得上；前台自检全部通过，点餐单那一条数得出张数；改坏了能查出来', async () => {
    const [line] = await ctx.sql<{ id: number }[]>`
      SELECT l.id FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${visit.A8006!} AND l.name = '华夫牛角' AND l.status = 'active' LIMIT 1`;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${line!.id}/void`, { reason: '客人不要了' })).status).toBe(200);
    const g = (await api(ctx.app, pad, 'GET', '/api/emenu/guest?tag=A8006')).body;
    expect(g.ordered.map((l: { name: string }) => l.name)).not.toContain('华夫牛角');
    const checks = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; label: string; detail: string }[];
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    const mine = checks.find((c) => c.key === 'emenu_orders')!;
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM emenu_orders`;
    expect(mine.detail).toContain(`${n!.n} 张`);
    expect(checks.map((c) => c.key)).toContain('emenu_orders');
    // 点餐单只追加
    await expect(ctx.sql`UPDATE emenu_orders SET guests = 9`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM emenu_orders`).rejects.toThrow();
    // 出品单的桌号被改掉（绕过保护）时自检能查出来
    await ctx.sql.begin(async (tx) => {
      await tx`ALTER TABLE kitchen_items DISABLE TRIGGER kitchen_items_guard`;
      await tx`UPDATE kitchen_items SET deliver_to = '改了' WHERE bill_line_id = ${line!.id}`;
      await tx`ALTER TABLE kitchen_items ENABLE TRIGGER kitchen_items_guard`;
    });
    const broken = ((await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean }[]).find((c) => c.key === 'emenu_orders')!;
    expect(broken.ok).toBe(false);
  });
});
