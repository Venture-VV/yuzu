// 小程序第三期 3c：扫码点餐（小程序线，docs/MP_PHASE3.md 第 3 节；MP32、MP33；接主线 v0.7.28 的 orderFoodFromMp）：
//   · 设置：默认关着；店主、店总能开、勾小程序可点的菜；「我的」的入口跟着开关；
//   · 点餐页：没绑定、没有在店手牌、会员卡停用都写原因、不能点；只列勾了的菜、这张手牌能点的男宾 / 女宾项目；桌码对的写桌名，不对的写原因；
//   · 下单：挂在会员在店手牌的账单上、进厨房出品单、写送到哪张桌，经办人「小程序」；同一个编号重提返回第一次；
//     没勾的菜、桌码不对、价格变了、绑定刚变过都拒绝、什么都不留；
//   · 确认作废：已经下了回那一单；没下的登记作废，之后原请求再到也不下；两边同时到只有一个结论；别的微信用不了这个编号；
//   · 「我的账单」：在店手牌的明细与出品状态，结账以后没有；点单记录只追加；后台看得到；自检照常全过。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { MP_FOOD_DUPLICATE_DISH, MP_FOOD_LINE_MAX_QUANTITY, MP_FOOD_MAX_LINES, MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpFoodAdminData, type MpFoodBill, type MpFoodMenu, type MpFoodOrdered } from '../src/shared/mp';
import { buildMpApp } from '../src/server/modules/mp/app';
import { foodAdminData, foodMenu, makeTableCode, orderFood, tableIdOf } from '../src/server/modules/mp/food';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
const SECRET = 'test-code-secret-0123456789abcdef-0123456789';
let ctx: TestContext;
let mp: FastifyInstance;
const item: Record<string, number> = {};
let tableId = 0;
let offTableId = 0;

beforeAll(async () => {
  ctx = await setup();
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY, codeSecret: SECRET } }, { pay: null, sweepMs: 0 });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
  // 餐饮：三道进厨房的菜（一道只限女宾）、一样不进厨房的、一道进厨房但没勾的；两张桌台（一张停用）
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'F', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price, gender] of [
    ['宫保鸡丁', '热菜', 4800, null],
    ['柠檬茶', '水吧', 1500, null],
    ['玫瑰花茶', '水吧', 1800, 'female'],
    ['龙虾', '热菜', 38800, null],
    ['一次性拖鞋', '洗浴用品', 500, null],
  ] as const) {
    const ri = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price, gender });
    expect(ri.status, JSON.stringify(ri.body)).toBe(200);
    item[name] = ri.body.items.find((i: { name: string }) => i.name === name).id;
  }
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '厨房' });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  const stationId = st.body.stations.find((s: { name: string }) => s.name === '厨房').id as number;
  const mapped = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', {
    items: ['宫保鸡丁', '柠檬茶', '玫瑰花茶', '龙虾'].map((n) => ({ id: item[n], stationId })),
  });
  expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
  for (const name of ['A8', 'B2']) {
    const tb = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name, area: '餐厅', seats: 4 });
    expect(tb.status, JSON.stringify(tb.body)).toBe(200);
  }
  const tables = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/dining/tables')).body.tables as { id: number; name: string }[];
  tableId = tables.find((t) => t.name === 'A8')!.id;
  offTableId = tables.find((t) => t.name === 'B2')!.id;
  expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/dining/tables/${offTableId}`, { name: 'B2', area: '餐厅', seats: 4, active: false })).status).toBe(200);
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

const call = (method: 'GET' | 'POST', url: string, openid: string, payload?: unknown) =>
  Promise.resolve(mp.inject({ method, url, headers: { [MP_GATEWAY_HEADER]: KEY, [MP_OPENID_HEADER]: openid }, ...(payload === undefined ? {} : { payload: payload as object }) }));
const versionOf = async (openid: string) => (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
let n = 0;
/** 一位会员、一个绑上的微信 */
async function member(name: string, bind = true): Promise<{ id: number; phone: string; openid: string }> {
  n += 1;
  const phone = `1355500${String(1000 + n)}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const openid = `openid-food-${n}-${randomUUID().slice(0, 8)}`;
  if (bind) {
    const b = await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: await versionOf(openid), mock: true });
    expect(b.statusCode, b.body).toBe(200);
  }
  return { id: r.body.id as number, phone, openid };
}
let tagNo = 0;
async function checkIn(memberId: number, zone: 'male' | 'female' = 'male') {
  tagNo += 1;
  const code = `F${String(tagNo).padStart(3, '0')}`;
  if (zone === 'female') expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'W', from: tagNo, to: tagNo, width: 3, zone: 'female' })).status).toBe(200);
  const tag = zone === 'female' ? `W${String(tagNo).padStart(3, '0')}` : code;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone, memberId }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { visitId: r.body.visits[0].id as number, code: tag };
}
const menu = async (openid: string, table?: string) => {
  const r = await call('GET', `/api/mp/food/menu${table ? `?table=${table}` : ''}`, openid);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as MpFoodMenu;
};
const bill = async (openid: string) => {
  const r = await call('GET', '/api/mp/food/bill', openid);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as MpFoodBill;
};
type Item = { itemId: number; quantity: number; note?: string };
const order = async (openid: string, items: Item[], opts: { clientKey?: string; table?: string; expectedTotal?: number; bindVersion?: number } = {}) =>
  call('POST', '/api/mp/food/orders', openid, {
    clientKey: opts.clientKey ?? randomUUID(),
    items,
    ...(opts.table ? { table: opts.table } : {}),
    expectedTotal: opts.expectedTotal ?? (await priceOf(items)),
    bindVersion: opts.bindVersion ?? (await versionOf(openid)),
  });
const PRICE: Record<string, number> = { 宫保鸡丁: 4800, 柠檬茶: 1500, 玫瑰花茶: 1800, 龙虾: 38800, 一次性拖鞋: 500 };
const priceOf = async (items: Item[]) => items.reduce((s, i) => s + PRICE[Object.keys(item).find((k) => item[k] === i.itemId)!]! * i.quantity, 0);
const abandon = (openid: string, clientKey: string) => call('POST', '/api/mp/food/orders/abandon', openid, { clientKey });
const adminData = async () => {
  const r = await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp/food');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as MpFoodAdminData;
};
const saveRules = async (enabled: boolean, names: string[]) => {
  const { rules } = await adminData();
  return api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/food/rules', { enabled, itemIds: names.map((x) => item[x]), version: rules.version });
};
/** 签名的最后一位换一个数：签名不对的桌码 */
const flipLast = (c: string) => c.slice(0, 17) + String((Number(c[17]) + 1) % 10);
const allChecksOk = async () => {
  for (const c of await consistencyChecks(ctx.sql, ctx.config.timezone)) {
    if (c.label.includes('自动任务')) continue;
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
};
const billLines = async (visitId: number) =>
  (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bill_lines bl JOIN visits v ON v.bill_id = bl.bill_id WHERE v.id = ${visitId} AND bl.status = 'active'`)[0]!.n;

describe('桌码', () => {
  it('71 + 桌台编号 + 签名，18 位数字；签名不对、换了密钥、编号不对都认不出', () => {
    const code = makeTableCode(SECRET, 12)!;
    expect(code).toMatch(/^71000012\d{10}$/);
    expect(tableIdOf(SECRET, code)).toBe(12);
    expect(tableIdOf('another-secret-0123456789abcdef-0123456789', code)).toBeNull();
    const forged = code.slice(0, 7) + '3' + code.slice(8);
    expect(tableIdOf(SECRET, forged)).toBeNull();
    expect(tableIdOf(SECRET, code.slice(0, 17))).toBeNull();
    expect(tableIdOf(SECRET, '8' + code.slice(1))).toBeNull();
    expect(makeTableCode(SECRET, 1_000_000)).toBeNull();
  });
});

describe('扫码点餐', () => {
  it('默认关着：点餐页写没开放、下不了单；「我的」没有入口；没有权限的岗位看不了、改不了', async () => {
    const a = await member('演示·点餐关着');
    await checkIn(a.id);
    expect(await menu(a.openid)).toMatchObject({ open: false, canOrder: false, notice: '扫码点餐还没开放，请服务员点单', dishes: [] });
    const r = await order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 1 }]);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('MP_FOOD_DISABLED');
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.foodOpen).toBe(false);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/mp/food')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/mp/food/rules', { enabled: true, itemIds: [] })).status).toBe(403);
    // 开了扫码点餐、餐饮功能还关着：照样没开放
    expect((await saveRules(true, ['宫保鸡丁', '柠檬茶', '玫瑰花茶'])).status).toBe(200);
    expect((await menu(a.openid)).open).toBe(false);
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.foodOpen).toBe(false);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.foodOpen).toBe(true);
    // 版本号对不上拒绝；勾的菜去重、排好
    const stale = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/food/rules', { enabled: true, itemIds: [], version: 0 });
    expect(stale.status).toBe(409);
    const d = await adminData();
    expect(d.rules).toMatchObject({ enabled: true, itemIds: [item['宫保鸡丁'], item['柠檬茶'], item['玫瑰花茶']].sort((x, y) => x! - y!) });
    expect(d.diningEnabled).toBe(true);
    expect(d.dishes.map((x) => [x.name, x.open])).toEqual([
      ['宫保鸡丁', true],
      ['柠檬茶', true],
      ['玫瑰花茶', true],
      ['龙虾', false],
    ]);
  });

  it('点餐页：没绑定、没有在店手牌写原因；有手牌的只列勾了的菜、这张手牌能点的；桌码对的写桌名，不对、停用的写原因', async () => {
    const stranger = `openid-food-stranger-${randomUUID().slice(0, 8)}`;
    expect(await menu(stranger)).toMatchObject({ open: true, canOrder: false, notice: '绑定会员后才能自己点：请到「我的」绑定，或请服务员点单', tagCode: null });
    const a = await member('演示·点餐没手牌');
    const m0 = await menu(a.openid);
    expect(m0).toMatchObject({ open: true, canOrder: false, tagCode: null });
    expect(m0.notice).toMatch(/^开了手牌才能点/);
    const v = await checkIn(a.id);
    const m = await menu(a.openid, makeTableCode(SECRET, tableId)!);
    expect(m).toMatchObject({ open: true, canOrder: true, notice: null, tagCode: v.code, table: { name: 'A8' }, tableNotice: null, limits: { maxQuantity: 20, maxTotal: 50_000 } });
    // 玫瑰花茶只限女宾：男宾手牌不列；龙虾没勾、拖鞋不进厨房都不列
    expect(m.dishes.map((d) => [d.name, d.group, d.price, d.remaining])).toEqual([
      ['宫保鸡丁', '厨房', 4800, null],
      ['柠檬茶', '厨房', 1500, null],
    ]);
    const w = await member('演示·女宾点餐');
    await checkIn(w.id, 'female');
    expect((await menu(w.openid)).dishes.map((d) => d.name)).toEqual(['宫保鸡丁', '柠檬茶', '玫瑰花茶']);
    // 桌码：签名不对、停用的桌、不是桌码
    expect(await menu(a.openid, flipLast(makeTableCode(SECRET, tableId)!))).toMatchObject({ canOrder: true, table: null, tableNotice: '这不是本店的桌码，请扫桌上的码' });
    expect(await menu(a.openid, makeTableCode(SECRET, offTableId)!)).toMatchObject({ table: null, tableNotice: '这张桌现在不能扫码点餐，请服务员点单' });
    expect((await menu(a.openid, 'hello')).tableNotice).toBe('这不是本店的桌码，请扫桌上的码');
  });

  it('下单：挂在手牌的账单上、进厨房、写送到哪张桌，经办人「小程序」；同一个编号重提返回第一次；「我的账单」看得到', async () => {
    const a = await member('演示·扫码点餐');
    const v = await checkIn(a.id);
    const key = randomUUID();
    const items = [
      { itemId: item['宫保鸡丁']!, quantity: 2, note: ' 少辣 ' },
      { itemId: item['柠檬茶']!, quantity: 1 },
    ];
    const r = await order(a.openid, items, { clientKey: key, table: makeTableCode(SECRET, tableId)! });
    expect(r.statusCode, r.body).toBe(201);
    const o = r.json() as MpFoodOrdered;
    expect(o).toMatchObject({ tagCode: v.code, deliverTo: 'A8', total: 11100, replayed: false });
    expect(o.orderNo).toMatch(/^CD/);
    expect(o.lines).toEqual([
      { name: '宫保鸡丁', quantity: 2, amount: 9600, note: '少辣' },
      { name: '柠檬茶', quantity: 1, amount: 1500, note: '' },
    ]);
    const kitchen = (await api(ctx.app, ctx.owner, 'GET', '/api/kitchen')).body.items as { orderNo: string; deliverTo: string; postedByName: string; tagCode: string }[];
    const mine = kitchen.filter((k) => k.orderNo === o.orderNo);
    expect(mine).toHaveLength(2);
    expect(mine.every((k) => k.deliverTo === 'A8' && k.postedByName === '小程序' && k.tagCode === v.code)).toBe(true);
    // 原样重提：200，回第一次那一单，不多下
    const again = await order(a.openid, items, { clientKey: key, table: makeTableCode(SECRET, tableId)! });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ orderNo: o.orderNo, total: 11100, replayed: true });
    expect(await billLines(v.visitId)).toBe(2);
    // 没扫桌码：不写桌号
    const plain = await order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 1 }]);
    expect(plain.statusCode, plain.body).toBe(201);
    expect(plain.json()).toMatchObject({ deliverTo: '', total: 1500 });
    const b = await bill(a.openid);
    expect(b).toMatchObject({ open: true, notice: null, tagCode: v.code, total: 12600 });
    expect(b.lines.map((l) => [l.name, l.quantity, l.amount, l.status])).toEqual([
      ['宫保鸡丁', 2, 9600, 'queued'],
      ['柠檬茶', 1, 1500, 'queued'],
      ['柠檬茶', 1, 1500, 'queued'],
    ]);
    // 后台：今天两单、最近的点单
    const d = await adminData();
    expect(d.recent.slice(0, 2).map((x) => [x.memberName, x.tagCode, x.deliverTo, x.total])).toEqual([
      ['演示·扫码点餐', v.code, '', 1500],
      ['演示·扫码点餐', v.code, 'A8', 11100],
    ]);
    expect(d.today.orders).toBeGreaterThanOrEqual(2);
    // 点单记录只追加
    await expect(ctx.sql`UPDATE mp_food_orders SET total = 0 WHERE client_key = ${key}`).rejects.toThrow(/只追加/);
    await expect(ctx.sql`DELETE FROM mp_food_orders WHERE client_key = ${key}`).rejects.toThrow(/只追加/);
    await allChecksOk();
  });

  it('拒绝：没勾的菜、桌码签名不对、价格变了、份数超了、绑定刚变过、没有在店手牌、没绑定，账单不变、什么都不留', async () => {
    const a = await member('演示·点餐拒绝');
    const v = await checkIn(a.id);
    const before = await billLines(v.visitId);
    const code = async (r: Promise<{ statusCode: number; json: () => { error: { code: string } } }>) => {
      const x = await r;
      return [x.statusCode, x.json().error.code];
    };
    expect(await code(order(a.openid, [{ itemId: item['龙虾']!, quantity: 1 }]))).toEqual([422, 'DISH_NOT_OPEN']);
    expect(await code(order(a.openid, [{ itemId: item['一次性拖鞋']!, quantity: 1 }]))).toEqual([422, 'DISH_NOT_OPEN']);
    expect(await code(order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 1 }], { table: flipLast(makeTableCode(SECRET, tableId)!) }))).toEqual([422, 'TABLE_CODE_INVALID']);
    expect(await code(order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 1 }], { table: makeTableCode(SECRET, offTableId)! }))).toEqual([422, 'TABLE_CODE_INVALID']);
    expect(await code(order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 1 }], { table: 'A8' }))).toEqual([400, 'BAD_REQUEST']);
    expect(await code(order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 1 }], { expectedTotal: 1400 }))).toEqual([409, 'PRICE_CHANGED']);
    expect(await code(order(a.openid, [{ itemId: item['宫保鸡丁']!, quantity: 11 }]))).toEqual([422, 'MP_ORDER_LIMIT']);
    // 一单最多几份按后台的设置（N1，默认 20 份）在下单时核对；格式上按账单明细能存的上限挡（一道菜最多 99 份）
    expect(await code(order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 21 }]))).toEqual([422, 'MP_ORDER_LIMIT']);
    expect(await code(order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 100 }]))).toEqual([400, 'BAD_REQUEST']);
    const version = await versionOf(a.openid);
    expect(await code(order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 1 }], { bindVersion: version + 1 }))).toEqual([409, 'BIND_STALE']);
    expect(await billLines(v.visitId)).toBe(before);
    expect((await ctx.sql`SELECT 1 FROM mp_food_orders WHERE member_id = ${a.id}`).length).toBe(0);
    // 没有在店手牌、没绑定
    const lonely = await member('演示·点餐没开手牌');
    const r1 = await order(lonely.openid, [{ itemId: item['柠檬茶']!, quantity: 1 }]);
    expect([r1.statusCode, r1.json().error.code]).toEqual([422, 'NO_OPEN_VISIT']);
    expect(r1.json().error.message).toMatch(/^开了手牌才能点/);
    const stranger = `openid-food-nobody-${randomUUID().slice(0, 8)}`;
    const r2 = await order(stranger, [{ itemId: item['柠檬茶']!, quantity: 1 }], { bindVersion: 0 });
    expect([r2.statusCode, r2.json().error.code]).toEqual([403, 'MP_NOT_BOUND']);
  });

  it('确认作废：已经下了回那一单；没下的登记作废，原请求再到也不下；别的微信用不了这个编号', async () => {
    const a = await member('演示·点餐作废');
    const v = await checkIn(a.id);
    const items = [{ itemId: item['柠檬茶']!, quantity: 1 }];
    const done = randomUUID();
    expect((await order(a.openid, items, { clientKey: done })).statusCode).toBe(201);
    const ab1 = await abandon(a.openid, done);
    expect(ab1.statusCode).toBe(200);
    expect(ab1.json()).toMatchObject({ status: 'ordered', ordered: { total: 1500, tagCode: v.code, replayed: true } });
    const lost = randomUUID();
    const ab2 = await abandon(a.openid, lost);
    expect(ab2.json()).toEqual({ status: 'abandoned' });
    // 再确认一次：照样是作废
    expect((await abandon(a.openid, lost)).json()).toEqual({ status: 'abandoned' });
    const late = await order(a.openid, items, { clientKey: lost });
    expect([late.statusCode, late.json().error.code]).toEqual([409, 'OP_ABANDONED']);
    expect(await billLines(v.visitId)).toBe(1);
    // 别的微信：已下的、作废了的编号都用不了
    const b = await member('演示·别的微信');
    expect((await abandon(b.openid, done)).json().error.code).toBe('CLIENT_KEY_REUSED');
    expect((await abandon(b.openid, lost)).json().error.code).toBe('CLIENT_KEY_REUSED');
    await checkIn(b.id);
    const steal = await order(b.openid, items, { clientKey: done });
    expect([steal.statusCode, steal.json().error.code]).toEqual([409, 'CLIENT_KEY_REUSED']);
  });

  it('同时到：两次同一个编号只下一单；下单与确认作废只有一个结论', async () => {
    const a = await member('演示·点餐并发');
    const v = await checkIn(a.id);
    const items = [{ itemId: item['柠檬茶']!, quantity: 1 }];
    const version = await versionOf(a.openid);
    const key = randomUUID();
    const [x, y] = await Promise.all([order(a.openid, items, { clientKey: key, bindVersion: version, expectedTotal: 1500 }), order(a.openid, items, { clientKey: key, bindVersion: version, expectedTotal: 1500 })]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 201]);
    expect(x.json().orderNo).toBe(y.json().orderNo);
    expect(await billLines(v.visitId)).toBe(1);
    for (let i = 0; i < 4; i++) {
      const k = randomUUID();
      const [o, ab] = await Promise.all([order(a.openid, items, { clientKey: k, bindVersion: version, expectedTotal: 1500 }), abandon(a.openid, k)]);
      const verdict = ab.json() as { status: string };
      if (verdict.status === 'ordered') {
        expect(o.statusCode).toBe(201);
      } else {
        expect(verdict.status).toBe('abandoned');
        expect([o.statusCode, o.json().error.code]).toEqual([409, 'OP_ABANDONED']);
      }
      const rows = await ctx.sql`SELECT 1 FROM mp_food_orders WHERE client_key = ${k}`;
      expect(rows.length).toBe(verdict.status === 'ordered' ? 1 : 0);
    }
    await allChecksOk();
  });

  it('解绑以后：原编号重提拒绝、不能再点；结账离店以后「我的账单」没有了', async () => {
    const a = await member('演示·点餐解绑');
    const v = await checkIn(a.id);
    const items = [{ itemId: item['宫保鸡丁']!, quantity: 1 }];
    const key = randomUUID();
    expect((await order(a.openid, items, { clientKey: key })).statusCode).toBe(201);
    // 结账：前台照旧
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v.visitId}`)).body;
    const paid = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v.visitId],
      expectedTotal: preview.totalAmount,
      payments: [{ method: 'cash', amount: preview.totalAmount }],
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const b = await bill(a.openid);
    expect(b).toMatchObject({ open: false, tagCode: null, lines: [], total: 0 });
    // 结账以后原编号重提：照样回第一次那一单
    expect((await order(a.openid, items, { clientKey: key })).statusCode).toBe(200);
    const bindings = (await api(ctx.app, ctx.owner, 'GET', `/api/admin/mp/members/${a.id}/bindings`)).body as { id: number }[];
    const un = await api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/bindings/${bindings[0]!.id}/unbind`, { clientKey: randomUUID(), reason: '测试解绑' });
    expect(un.status, JSON.stringify(un.body)).toBe(200);
    const after = await order(a.openid, items, { clientKey: key, bindVersion: await versionOf(a.openid) });
    expect([after.statusCode, after.json().error.code]).toEqual([409, 'CLIENT_KEY_REUSED']);
    expect(await bill(a.openid)).toMatchObject({ open: false, notice: '请先绑定会员' });
  });

  it('门店系统没配签名密钥：带着桌码下单照点餐页说的，不写桌号、服务员按手牌送', async () => {
    const a = await member('演示·没配密钥');
    const v = await checkIn(a.id);
    const noSecret = { sql: ctx.sql, config: { ...ctx.config, mp: { ...ctx.config.mp, codeSecret: null } } };
    const m = await foodMenu(noSecret, a.openid, { table: makeTableCode(SECRET, tableId)! });
    expect(m).toMatchObject({ canOrder: true, table: null, tableNotice: '门店系统还没配好桌码，这一单不写桌号，服务员按手牌送' });
    const o = await orderFood(noSecret, a.openid, {
      clientKey: randomUUID(),
      items: [{ itemId: item['柠檬茶']!, quantity: 1 }],
      table: makeTableCode(SECRET, tableId)!,
      expectedTotal: 1500,
      bindVersion: await versionOf(a.openid),
    });
    expect(o).toMatchObject({ deliverTo: '', tagCode: v.code, total: 1500, replayed: false });
  });

  it('后台：桌码要配了签名密钥才有；配了的每张启用的桌一个码、认得出', async () => {
    const d = await adminData();
    expect(d.tables.map((t) => t.name)).toEqual(['A8']);
    if (!ctx.config.mp.codeSecret) {
      expect(d.tableCodeReady).toBe(false);
      expect(d.tables[0]!.code).toBeNull();
    }
    const withSecret = await foodAdminData({ sql: ctx.sql, config: { ...ctx.config, mp: { ...ctx.config.mp, codeSecret: SECRET } } });
    expect(withSecret.tableCodeReady).toBe(true);
    expect(withSecret.tables).toEqual([{ id: tableId, name: 'A8', area: '餐厅', code: makeTableCode(SECRET, tableId) }]);
    expect(tableIdOf(SECRET, withSecret.tables[0]!.code!)).toBe(tableId);
    // 关掉：点餐页没开放、「我的」没有入口
    expect((await saveRules(false, ['宫保鸡丁'])).status).toBe(200);
    const a = await member('演示·关掉以后');
    expect((await menu(a.openid)).open).toBe(false);
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.foodOpen).toBe(false);
  });
});

describe('一单的上限按后台的设置（N1，主线 8.0.7「经营规则 → 可调的数值」）', () => {
  const setLimits = async (patch: { mpFoodMaxQuantity?: number; mpFoodMaxTotalCents?: number }) => {
    const r = await api(ctx.app, ctx.owner, 'PUT', '/api/settings', patch);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const code = async (r: Promise<{ statusCode: number; json: () => { error: { code: string; message: string } } }>) => {
    const x = await r;
    return [x.statusCode, x.json().error.code];
  };
  const LINE = { maxLineQuantity: MP_FOOD_LINE_MAX_QUANTITY, maxLines: MP_FOOD_MAX_LINES };

  it('菜单上给的上限、下单时的核对都跟着设置走：调大能多点、调小就拦，金额也一样', async () => {
    // 用完改回默认（20 份、¥500），不影响别的用例
    onTestFinished(() => setLimits({ mpFoodMaxQuantity: 20, mpFoodMaxTotalCents: 50_000 }));
    // 前面的用例关过扫码点餐：这里自己打开、勾上柠檬茶
    expect((await saveRules(true, ['宫保鸡丁', '柠檬茶', '玫瑰花茶'])).status).toBe(200);
    const a = await member('演示·点餐上限');
    await checkIn(a.id);
    const tea = (quantity: number) => [{ itemId: item['柠檬茶']!, quantity }];
    // 调大到 30 份：菜单写 30，25 份能下
    await setLimits({ mpFoodMaxQuantity: 30 });
    expect((await menu(a.openid)).limits).toEqual({ maxQuantity: 30, maxTotal: 50_000, ...LINE });
    // 后台「微信小程序 → 扫码点餐」写的也是这一份
    expect((await adminData()).limits).toEqual({ maxQuantity: 30, maxTotal: 50_000, ...LINE });
    const big = await order(a.openid, tea(25));
    expect(big.statusCode, big.body).toBe(201);
    // 调小到 10 份：15 份不让下
    await setLimits({ mpFoodMaxQuantity: 10 });
    expect((await menu(a.openid)).limits.maxQuantity).toBe(10);
    expect(await code(order(a.openid, tea(15)))).toEqual([422, 'MP_ORDER_LIMIT']);
    // 金额调到 ¥30：正好 ¥30 能下，再多一份不行
    await setLimits({ mpFoodMaxQuantity: 20, mpFoodMaxTotalCents: 3000 });
    expect((await menu(a.openid)).limits).toEqual({ maxQuantity: 20, maxTotal: 3000, ...LINE });
    const edge = await order(a.openid, tea(2));
    expect(edge.statusCode, edge.body).toBe(201);
    expect(await code(order(a.openid, tea(3)))).toEqual([422, 'MP_ORDER_LIMIT']);
  });

  it('上限调到 200 份：一道菜最多 99 份、最多 20 道菜（账单明细、点单记录能存的上限），同一道菜只写一行，超过的格式上就挡，不报 500（小程序线测试 3c2612b 的 P2、721174d 的 P3）', async () => {
    // 两个数与数据库的约束一致：账单明细一行的份数、点单记录的行数
    const defs = await ctx.sql<{ name: string; def: string }[]>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('bill_lines_quantity_check', 'mp_food_orders_lines_check')`;
    expect(defs.find((d) => d.name === 'bill_lines_quantity_check')?.def).toContain(`(quantity <= ${MP_FOOD_LINE_MAX_QUANTITY})`);
    expect(defs.find((d) => d.name === 'mp_food_orders_lines_check')?.def).toContain(`(jsonb_array_length(lines) <= ${MP_FOOD_MAX_LINES})`);
    onTestFinished(() => setLimits({ mpFoodMaxQuantity: 20, mpFoodMaxTotalCents: 50_000 }));
    // 再上 21 道一块钱的小菜，进厨房、勾上
    const [station] = await ctx.sql<{ id: number }[]>`SELECT id FROM kitchen_stations WHERE name = '厨房'`;
    const snacks: number[] = [];
    for (let i = 1; i <= 21; i++) {
      const name = `小菜${String(i).padStart(2, '0')}`;
      const ri = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category: '小吃', price: 100, gender: null });
      expect(ri.status, JSON.stringify(ri.body)).toBe(200);
      const id = ri.body.items.find((x: { name: string }) => x.name === name).id as number;
      item[name] = id;
      PRICE[name] = 100;
      snacks.push(id);
    }
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: snacks.map((id) => ({ id, stationId: station!.id })) })).status).toBe(200);
    expect((await saveRules(true, ['宫保鸡丁', '柠檬茶', ...snacks.map((_, i) => `小菜${String(i + 1).padStart(2, '0')}`)])).status).toBe(200);
    await setLimits({ mpFoodMaxQuantity: 200, mpFoodMaxTotalCents: 500_000 });
    const a = await member('演示·点餐上限 200');
    const v = await checkIn(a.id);
    expect((await menu(a.openid)).limits).toEqual({ maxQuantity: 200, maxTotal: 500_000, ...LINE });
    // 一道菜：99 份能下，100 份格式上就挡（原来 100、200 份撞账单明细的约束报 500）
    const ok99 = await order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 99 }]);
    expect(ok99.statusCode, ok99.body).toBe(201);
    const r100 = await order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 100 }]);
    expect([r100.statusCode, r100.json().error.code]).toEqual([400, 'BAD_REQUEST']);
    expect(r100.json().error.message).toContain('一道菜一单最多 99 份');
    expect(await code(order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 200 }]))).toEqual([400, 'BAD_REQUEST']);
    // 20 道菜能下，21 道格式上就挡（原来撞点单记录的约束报 500）
    const ok20 = await order(a.openid, snacks.slice(0, 20).map((itemId) => ({ itemId, quantity: 1 })));
    expect(ok20.statusCode, ok20.body).toBe(201);
    const r21 = await order(a.openid, snacks.map((itemId) => ({ itemId, quantity: 1 })));
    expect([r21.statusCode, r21.json().error.code]).toEqual([400, 'BAD_REQUEST']);
    expect(r21.json().error.message).toContain('一单最多 20 道菜');
    // 同一道菜写成两行（60 + 60，每行都不到 99 份、合计也在 200 份以内）：格式上就挡，一道菜只写一行（721174d 的 P3）
    const dup = await order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 60 }, { itemId: item['柠檬茶']!, quantity: 60 }]);
    expect([dup.statusCode, dup.json().error.code, dup.json().error.message]).toEqual([400, 'BAD_REQUEST', MP_FOOD_DUPLICATE_DISH]);
    // 口味备注不同也一样（小程序一道菜一条备注）
    const dupNote = await order(a.openid, [{ itemId: item['柠檬茶']!, quantity: 1, note: '少冰' }, { itemId: item['柠檬茶']!, quantity: 1, note: '去冰' }]);
    expect([dupNote.statusCode, dupNote.json().error.message]).toEqual([400, MP_FOOD_DUPLICATE_DISH]);
    // 账单上只有成功的两单：99 份柠檬茶 + 20 道小菜各 1 份
    expect(await billLines(v.visitId)).toBe(21);
  });
});
