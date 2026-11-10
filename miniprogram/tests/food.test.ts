// 扫码点餐（第三期 3c）：桌码怎么认（一串数字、链接里带着、打开页面的参数）；菜单分组与购物车（估清、剩的份数、一单的上限）；
// 下单的「结果待确认」（存不了不发；明确的结果删记录；结果不确定时请门店系统确认作废，已经下了就回那一单；连作废都发不出去时保留、
// 确认之前不发新的；手机上的记录读不出来不发）；下单结果与「我的账单」的字。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MpFoodDish, MpFoodOrdered } from '../../src/shared/mp';

type Reply = { status: number; data: unknown } | 'fail';
/** 先不回：测试调 onHold 给的函数时才回（请求还在发） */
type Held = { hold: Reply; onHold: (release: () => void) => void };

function installWx(routes: Record<string, Reply | Held | (() => Reply)>, opts: { storageBroken?: string; storage?: Record<string, unknown>; readFails?: string } = {}) {
  const storage: Record<string, unknown> = opts.storage ?? {};
  const sent: { path: string; data: unknown }[] = [];
  vi.stubGlobal('wx', {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0', appId: 'wx0' } }),
    getStorageSync: (k: string) => {
      if (opts.readFails === k) throw new Error('getStorageSync:fail');
      return k in storage ? storage[k] : '';
    },
    setStorageSync: (k: string, v: unknown) => {
      if (opts.storageBroken === k) throw new Error('存储空间已满');
      storage[k] = JSON.parse(JSON.stringify(v));
    },
    removeStorageSync: (k: string) => {
      delete storage[k];
    },
    login: (o: { success: (r: { code: string }) => void }) => o.success({ code: 'wxcode' }),
    request: (o: { url: string; method?: string; data: unknown; success: (r: unknown) => void; fail: (e: unknown) => void }) => {
      const path = o.url.replace(/^https?:\/\/[^/]+/, '');
      if (path !== '/v1/login') sent.push({ path: (o.method ?? 'GET') + ' ' + path, data: o.data });
      const route = path === '/v1/login' ? { status: 200, data: { token: 'v1.t', expiresAt: new Date(Date.now() + 7 * 86400e3).toISOString() } } : routes[(o.method ?? 'GET') + ' ' + path];
      const r0 = typeof route === 'function' ? route() : route;
      const answer = (r: Reply | undefined) => (!r || r === 'fail' ? o.fail({ errMsg: 'request:fail' }) : o.success({ statusCode: r.status, data: r.data, header: {} }));
      if (r0 && typeof r0 === 'object' && 'hold' in r0) r0.onHold(() => answer(r0.hold));
      else setTimeout(() => answer(r0), 0);
    },
  });
  return { storage, sent };
}

const load = async () => {
  vi.resetModules();
  return import('../src/utils/food');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = '3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f';
const TABLE = '710000081234567890';
const DISHES: MpFoodDish[] = [
  { id: 1, name: '宫保鸡丁', group: '热菜', price: 4800, remaining: null },
  { id: 2, name: '龙虾', group: '热菜', price: 38800, remaining: 2 },
  { id: 3, name: '柠檬茶', group: '水吧', price: 1500, remaining: 0 },
];
const LIMITS = { maxQuantity: 20, maxTotal: 50000, maxLineQuantity: 99, maxLines: 20 };
const ORDERED: MpFoodOrdered = {
  orderNo: 'CD20261104-0012',
  tagCode: 'F001',
  deliverTo: 'A8',
  total: 11100,
  lines: [
    { name: '宫保鸡丁', quantity: 2, amount: 9600, note: '少辣' },
    { name: '柠檬茶', quantity: 1, amount: 1500, note: '' },
  ],
  createdAt: '2026-11-04T06:00:00.000Z',
  replayed: false,
};
const BODY = { items: [{ itemId: 1, quantity: 2 }], table: TABLE, expectedTotal: 9600, bindVersion: 2 };

describe('桌码', () => {
  it('认出 71 开头的 18 位数字：单独一串、链接里带着；会员码、手机号、长短不对的都认不出', async () => {
    installWx({});
    const f = await load();
    expect(f.tableCodeOf(TABLE)).toBe(TABLE);
    expect(f.tableCodeOf(' ' + TABLE + '\n')).toBe(TABLE);
    expect(f.tableCodeOf('https://mp.example.cn/t/' + TABLE)).toBe(TABLE);
    expect(f.tableCodeOf('https://mp.example.cn/t?c=' + TABLE + '&x=1')).toBe(TABLE);
    expect(f.tableCodeOf('8000012123456789')).toBe('');
    expect(f.tableCodeOf('9' + TABLE)).toBe('');
    expect(f.tableCodeOf(TABLE + '0')).toBe('');
    expect(f.tableCodeOf('13800138000')).toBe('');
    expect(f.tableCodeOf(undefined)).toBe('');
    // 打开页面的参数：t、小程序码的 scene、扫普通链接二维码的 q（微信给的是编码过的整条链接）
    expect(f.tableFromOptions({ t: TABLE })).toBe(TABLE);
    expect(f.tableFromOptions({ scene: encodeURIComponent('t=' + TABLE) })).toBe(TABLE);
    expect(f.tableFromOptions({ q: encodeURIComponent('https://mp.example.cn/t/' + TABLE) })).toBe(TABLE);
    expect(f.tableFromOptions({ q: '%E0%A4%A' })).toBe('');
    expect(f.tableFromOptions({})).toBe('');
  });
});

describe('菜单与购物车', () => {
  it('按档口分组；估清的写「今天没有了」、剩得少的写份数；合计不算估清的；一单的份数、金额、剩的份数都拦住', async () => {
    installWx({});
    const f = await load();
    let cart = f.changeCount({}, 1, 1);
    cart = f.changeCount(cart, 1, 1);
    cart = f.setNote(cart, 1, '  少辣  ');
    const groups = f.menuGroups(DISHES, cart);
    expect(groups.map((g) => g.name)).toEqual(['热菜', '水吧']);
    expect(groups[0]!.dishes[0]).toMatchObject({ name: '宫保鸡丁', price: '¥48', stock: '', count: 2, note: '少辣' });
    expect(groups[0]!.dishes[1]).toMatchObject({ name: '龙虾', price: '¥388', stock: '今天还剩 2 份', soldOut: false, count: 0 });
    expect(groups[1]!.dishes[0]).toMatchObject({ name: '柠檬茶', stock: '今天没有了', soldOut: true });
    expect(f.cartSum(cart, DISHES)).toEqual({ quantity: 2, total: 9600, items: [{ itemId: 1, quantity: 2, note: '少辣' }] });
    // 估清的不算进合计
    expect(f.cartSum({ ...cart, '3': { quantity: 1, note: '' } }, DISHES).total).toBe(9600);
    expect(f.addProblem(cart, DISHES[2]!, DISHES, LIMITS)).toBe('「柠檬茶」今天没有了');
    // 冰粉今天只剩 2 份
    const few: MpFoodDish[] = [{ id: 9, name: '冰粉', group: '甜品', price: 800, remaining: 2 }];
    let jelly = f.changeCount({}, 9, 1);
    expect(f.addProblem(jelly, few[0]!, few, LIMITS)).toBe('');
    jelly = f.changeCount(jelly, 9, 1);
    expect(f.addProblem(jelly, few[0]!, few, LIMITS)).toBe('「冰粉」今天只剩 2 份');
    // 一单最多 ¥500：一只龙虾 ¥388，再加三份宫保鸡丁就超了
    let big = f.changeCount({}, 2, 1);
    big = f.changeCount(big, 1, 2);
    expect(f.addProblem(big, DISHES[0]!, DISHES, LIMITS)).toBe('一单最多 ¥500，多的请服务员点');
    // 一单最多 20 份
    const many = { '1': { quantity: 20, note: '' } };
    expect(f.addProblem(many, DISHES[0]!, DISHES, { ...LIMITS, maxTotal: 10000000 })).toBe('一单最多 20 份，多的请服务员点');
    // 店主把一单的上限调到 200 份：一道菜最多 99 份（账单明细能存的上限），最多 20 道菜（点单记录能存的上限）（小程序线测试 3c2612b 的 P2）
    const roomy = { ...LIMITS, maxQuantity: 200, maxTotal: 10000000 };
    expect(f.addProblem({ '1': { quantity: 98, note: '' } }, DISHES[0]!, DISHES, roomy)).toBe('');
    expect(f.addProblem({ '1': { quantity: 99, note: '' } }, DISHES[0]!, DISHES, roomy)).toBe('一道菜一单最多 99 份，多的请服务员点');
    const menu20: MpFoodDish[] = Array.from({ length: 21 }, (_, i) => ({ id: 100 + i, name: '小菜' + (i + 1), group: '小吃', price: 100, remaining: null }));
    const twenty: Record<string, { quantity: number; note: string }> = {};
    for (const d of menu20.slice(0, 20)) twenty[String(d.id)] = { quantity: 1, note: '' };
    expect(f.addProblem(twenty, menu20[0]!, menu20, roomy)).toBe('');
    expect(f.addProblem(twenty, menu20[20]!, menu20, roomy)).toBe('一单最多 20 道菜，多的请服务员点');
    // 减到 0 从购物车拿掉
    expect(f.changeCount(f.changeCount({}, 1, 1), 1, -1)).toEqual({});
    expect(f.setNote({}, 1, '少辣')).toEqual({});
    expect(f.setNote(cart, 1, 'x'.repeat(60))['1']!.note).toHaveLength(40);
  });

  it('下单结果与我的账单的字', async () => {
    installWx({});
    const f = await load();
    expect(f.orderedView(ORDERED)).toEqual({
      where: '送到 A8 桌',
      no: '出品单 CD20261104-0012',
      total: '¥111.00',
      lines: [
        { key: '0', name: '宫保鸡丁', qty: '×2', amount: '¥96.00', note: '少辣' },
        { key: '1', name: '柠檬茶', qty: '×1', amount: '¥15.00', note: '' },
      ],
    });
    expect(f.orderedView({ ...ORDERED, deliverTo: '' }).where).toBe('服务员按手牌 F001 送');
    const lines = f.billLines({
      open: true,
      notice: null,
      tagCode: 'F001',
      checkedInAt: '2026-11-04T05:00:00.000Z',
      lines: [
        { name: '浴资', quantity: 1, amount: 16800, postedAt: '2026-11-04T05:00:00.000Z', status: null },
        { name: '宫保鸡丁', quantity: 2, amount: 9600, postedAt: '2026-11-04T06:00:00.000Z', status: 'cooking' },
        { name: '柠檬茶', quantity: 1, amount: 1500, postedAt: '2026-11-04T06:00:00.000Z', status: 'served' },
      ],
      total: 27900,
    });
    expect(lines.map((l) => [l.name, l.qty, l.amount, l.status, l.waiting])).toEqual([
      ['浴资', '×1', '¥168.00', '', false],
      ['宫保鸡丁', '×2', '¥96.00', '制作中', true],
      ['柠檬茶', '×1', '¥15.00', '已上菜', false],
    ]);
  });
});

describe('下单的「结果待确认」', () => {
  it('存不了不发；下了删记录；门店系统明确拒绝删记录、把原因给顾客看', async () => {
    const w0 = installWx({ 'POST /v1/food/orders': { status: 201, data: ORDERED } }, { storageBroken: 'tq_food_order_pending' });
    const f0 = await load();
    expect(await f0.sendOrder(BODY, KEY)).toMatchObject({ kind: 'rejected', code: 'PENDING_STORE_FAILED' });
    expect(w0.sent).toEqual([]);
    const w = installWx({ 'POST /v1/food/orders': { status: 201, data: ORDERED } });
    const f = await load();
    expect(await f.sendOrder(BODY, KEY)).toEqual({ kind: 'ordered', ordered: ORDERED });
    expect(w.sent).toEqual([{ path: 'POST /v1/food/orders', data: { clientKey: KEY, items: BODY.items, expectedTotal: 9600, bindVersion: 2, table: TABLE } }]);
    expect(w.storage.tq_food_order_pending).toBeUndefined();
    // 没扫桌码：不带 table
    const w1 = installWx({ 'POST /v1/food/orders': { status: 201, data: ORDERED } });
    const f1 = await load();
    await f1.sendOrder({ ...BODY, table: '' }, KEY);
    expect((w1.sent[0]!.data as Record<string, unknown>).table).toBeUndefined();
    const w2 = installWx({ 'POST /v1/food/orders': { status: 409, data: { error: { code: 'DISH_SOLD_OUT', message: '「宫保鸡丁」今天已估清（卖完了），请换一道菜' } } } });
    const f2 = await load();
    expect(await f2.sendOrder(BODY, KEY)).toEqual({ kind: 'rejected', code: 'DISH_SOLD_OUT', message: '「宫保鸡丁」今天已估清（卖完了），请换一道菜' });
    expect(w2.storage.tq_food_order_pending).toBeUndefined();
  });

  it('结果不确定：马上请门店系统确认作废——已经下了回那一单；连作废都发不出去时保留、不发新的；之后作废了可以重新下', async () => {
    let abandon: Reply = { status: 200, data: { status: 'ordered', ordered: { ...ORDERED, replayed: true } } };
    const w = installWx({ 'POST /v1/food/orders': 'fail', 'POST /v1/food/orders/abandon': () => abandon });
    const f = await load();
    expect(await f.sendOrder(BODY, KEY)).toMatchObject({ kind: 'ordered', ordered: { replayed: true } });
    expect(w.storage.tq_food_order_pending).toBeUndefined();
    abandon = 'fail';
    expect((await f.sendOrder(BODY, KEY)).kind).toBe('pending');
    expect(w.storage.tq_food_order_pending).toMatchObject({ clientKey: KEY });
    // 还有待确认的：先确认上一单、告诉顾客结果，这一单不下（购物车留着）
    const before = w.sent.length;
    abandon = { status: 200, data: { status: 'abandoned' } };
    expect(await f.sendOrder(BODY, 'b0b0b0b0-9b8a-4c7d-8e6f-5a4b3c2d1e0f')).toEqual({ kind: 'earlier', message: '上一单没有下成；这一单还没下，请再点一次「下单」' });
    expect(w.sent.slice(before).map((s) => s.path)).toEqual(['POST /v1/food/orders/abandon']);
    expect(w.storage.tq_food_order_pending).toBeUndefined();
    // 门店（5xx）、门店连不上也算不确定
    const w2 = installWx({ 'POST /v1/food/orders': { status: 503, data: { error: { code: 'STORE_OFFLINE', message: '门店系统连接中' } } }, 'POST /v1/food/orders/abandon': { status: 200, data: { status: 'abandoned' } } });
    const f2 = await load();
    expect(await f2.sendOrder(BODY, KEY)).toEqual({ kind: 'abandoned' });
    expect(w2.sent.map((s) => s.path)).toEqual(['POST /v1/food/orders', 'POST /v1/food/orders/abandon']);
  });

  it('上一单已经下了：告诉顾客出品单号，这一单不下；请求还在发时不去作废它，回来以后照常', async () => {
    const w = installWx({ 'POST /v1/food/orders/abandon': { status: 200, data: { status: 'ordered', ordered: { ...ORDERED, replayed: true } } } }, { storage: { tq_food_order_pending: { clientKey: KEY, at: 1 } } });
    const f = await load();
    expect(await f.sendOrder(BODY, 'c0c0c0c0-9b8a-4c7d-8e6f-5a4b3c2d1e0f')).toEqual({
      kind: 'earlier',
      message: '上一单已经下好了（出品单 CD20261104-0012，¥111.00）；这一单还没下，看一下「我的账单」，要的话再点一次「下单」',
    });
    expect(w.sent.map((s) => s.path)).toEqual(['POST /v1/food/orders/abandon']);
    let release: () => void = () => undefined;
    const w2 = installWx({ 'POST /v1/food/orders': { hold: { status: 201, data: ORDERED }, onHold: (go) => (release = go) } });
    const f2 = await load();
    const p = f2.sendOrder(BODY, KEY);
    await new Promise((ok) => setTimeout(ok, 5));
    expect(await f2.resolveOrderPending()).toEqual({ kind: 'pending', message: '这一单还在提交，请稍候再点「再确认一次」' });
    expect(w2.sent.map((s) => s.path)).toEqual(['POST /v1/food/orders']);
    release();
    expect(await p).toEqual({ kind: 'ordered', ordered: ORDERED });
    expect(w2.storage.tq_food_order_pending).toBeUndefined();
    expect(await f2.resolveOrderPending()).toBeNull();
  });

  it('手机上的记录读不出来：不发；认不出的记录也当读不出来', async () => {
    const w = installWx({ 'POST /v1/food/orders': { status: 201, data: ORDERED } }, { readFails: 'tq_food_order_pending' });
    const f = await load();
    expect(await f.sendOrder(BODY, KEY)).toEqual({ kind: 'unreadable' });
    expect(await f.resolveOrderPending()).toEqual({ kind: 'unreadable' });
    expect(w.sent).toEqual([]);
    const w2 = installWx({ 'POST /v1/food/orders': { status: 201, data: ORDERED } }, { storage: { tq_food_order_pending: { at: 1 } } });
    const f2 = await load();
    expect(f2.readOrderPending()).toEqual({ state: 'unreadable' });
    expect(await f2.sendOrder(BODY, KEY)).toEqual({ kind: 'unreadable' });
    expect(w2.sent).toEqual([]);
  });
});
