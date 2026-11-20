// 8.1.15《浴族系统需求汇总》块 B2、B3（docs/DINING_V8115.md 第 3、4 节）：台账合并退菜（类型筛选、退菜的审批与责任岗位、退菜率、导出），
// 按出品口下单（逐行核对、康美部、原样重提）、房号找客人（找得到 / 找不到 / 都填 / 换了房）、整单备注进出品单与点菜单。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutPreview } from '../src/shared/checkout';
import type { DiningGuest, DiningLedger, DiningReceipt, KitchenBoard } from '../src/shared/dining';
import { addonNote } from '../src/shared/dishes';
import type { GiftIssueResult, GiftType } from '../src/shared/gifts';
import { permissionsOf } from '../src/shared/permissions';
import { findGuestByRoom } from '../src/server/modules/dining-order-v8115';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let km: string; // 康美部（后勤 + 康美部职责）
let butler: string;
let dutyId = 0;
let today = '';
let tagNo = 0;
const item: Record<string, number> = {};
const price: Record<string, number> = { 宫保鸡丁: 4800, 柠檬茶: 1800, 果盘: 3800 };
const room: Record<string, number> = {};
const station: Record<string, number> = {};
let tableId = 0;

const enter = async (memberId: number | null = null) => {
  tagNo += 1;
  const tagCode = `G${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', memberId }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { visitId: r.body.visits[0].id as number, tagCode };
};
const lines = (names: string[]) => names.map((n) => ({ itemId: item[n]!, quantity: 1 }));
const total = (names: string[]) => names.reduce((s, n) => s + price[n]!, 0);
const order = (visitId: number, names: string[], extra: Record<string, unknown> = {}, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/dining/orders', { clientKey, visitId, lines: lines(names), expectedTotal: total(names), ...extra });
const guest = (q: string) => api<DiningGuest & { error: { code: string } }>(ctx.app, ctx.clerk, 'GET', `/api/dining/guest?${q}`);
const kitchen = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/kitchen')).body as KitchenBoard;
const lineOf = async (visitId: number, name: string) =>
  ((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${visitId}`)).body.lines as { id: number; name: string; status: string }[]).find((l) => l.name === name && l.status === 'active')!;
const ledger = async (q = '') => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/dining/ledger?from=${today}&to=${today}${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as DiningLedger;
};
const setClerkPermissions = (drop: string[]) =>
  api(ctx.app, ctx.owner, 'PUT', '/api/admin/permissions', { roles: { clerk: permissionsOf({ position: null, role: 'clerk' }).filter((p) => !drop.includes(p)) } });

beforeAll(async () => {
  ctx = await setup();
  dutyId = await createStaff(ctx.sql, { username: 'gduty', displayName: '值班乙', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'gkm', displayName: '康美小林', role: 'backoffice', duties: ['kangmei'], password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'gbutler', displayName: '管家丁', role: 'backoffice', duties: ['concierge'], password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'gduty');
  km = await login(ctx.app, 'gkm');
  butler = await login(ctx.app, 'gbutler');
  today = (await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'G', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  for (const name of ['热菜', '水吧', '果吧']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name });
    station[name] = r.body.stations.find((s: { name: string }) => s.name === name).id;
  }
  for (const [name, category, st] of [
    ['宫保鸡丁', '热菜', '热菜'],
    ['柠檬茶', '饮品', '水吧'],
    ['果盘', '水果', '果吧'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price: price[name] });
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: item[name], stationId: station[st] }] })).status).toBe(200);
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true, tablesEnabled: true })).status).toBe(200);
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: '水吧1', area: '休闲水吧区', seats: 2 });
  tableId = t.body.tables.find((x: { name: string }) => x.name === '水吧1').id;
  // 客房：两间（只填房号时按在住的客房找客人）
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
  const rt = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '大床房', kind: 'daily', price: 30000 });
  const typeId = rt.body.types.find((x: { name: string }) => x.name === '大床房').id;
  for (const roomNo of ['H601', 'H602']) {
    const rm = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo, floor: '6', roomTypeId: typeId });
    room[roomNo] = rm.body.rooms.find((x: { roomNo: string }) => x.roomNo === roomNo).id;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/rooms/${room[roomNo]}/housekeeping`, { status: 'clean' })).status).toBe(200);
  }
});
afterAll(async () => ctx.close());

describe('按出品口下单（B3）', () => {
  it('康美部只有水吧、果吧：点餐厅的菜整单拒绝；不用「前台挂账」也能下单；店员三处都能点', async () => {
    const me = (await api(ctx.app, km, 'GET', '/api/auth/me')).body as { permissions: string[] };
    expect(me.permissions).toEqual(expect.arrayContaining(['dining.order', 'dining.orderWater', 'dining.orderFruit']));
    expect(me.permissions).not.toContain('dining.orderRestaurant');
    expect(me.permissions).not.toContain('frontdesk.operate');
    const g = await enter();
    expect((await order(g.visitId, ['柠檬茶'], {}, km)).status).toBe(200);
    expect((await order(g.visitId, ['果盘'], {}, km)).status).toBe(200);
    const denied = await order(g.visitId, ['柠檬茶', '宫保鸡丁'], {}, km);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: 'OUTLET_FORBIDDEN', details: { items: ['宫保鸡丁'] } });
    expect(denied.body.error.message).toContain('餐厅');
    const [count] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${g.visitId}`;
    expect(count!.n).toBe(2);
    expect((await order(g.visitId, ['宫保鸡丁', '柠檬茶', '果盘'])).status).toBe(200);
    // 康美部不能开台、不能给桌台点单（桌台照旧要「前台挂账」）
    expect((await api(ctx.app, km, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 1 })).status).toBe(403);
  });

  it('后台去掉店员的「在水吧下单」：点单页、桌台都逐行拒绝；原样重提照原样返回第一次的结果', async () => {
    const g = await enter();
    const key = randomUUID();
    expect((await order(g.visitId, ['柠檬茶'], {}, ctx.clerk, key)).status).toBe(200);
    const open = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect((await setClerkPermissions(['dining.orderWater'])).status).toBe(200);
    try {
      expect((await order(g.visitId, ['柠檬茶'])).body.error.code).toBe('OUTLET_FORBIDDEN');
      // 同一编号原样重提：第一次已经生效，照原样返回
      expect((await order(g.visitId, ['柠檬茶'], {}, ctx.clerk, key)).status).toBe(200);
      const tablePost = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${open.body.id}/orders`, { clientKey: randomUUID(), lines: lines(['柠檬茶']), expectedTotal: 1800 });
      expect(tablePost.body.error.code).toBe('OUTLET_FORBIDDEN');
      expect((await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${open.body.id}/orders`, { clientKey: randomUUID(), lines: lines(['果盘']), expectedTotal: 3800 })).status).toBe(200);
    } finally {
      expect((await setClerkPermissions([])).status).toBe(200);
    }
    expect((await order(g.visitId, ['柠檬茶'])).status).toBe(200);
  });
});

describe('点单的结果待确认（康美部没有前台权限，Codex 审查 f6327a4）', () => {
  it('按餐饮的地址查回、确认作废自己点的单；前台的地址照旧要前台权限；别的前台业务的编号这里查不到、不作废', async () => {
    const me = (await api(ctx.app, km, 'GET', '/api/auth/me')).body as { permissions: string[] };
    expect(me.permissions).not.toContain('frontdesk.read');
    expect(me.permissions).not.toContain('frontdesk.operate');
    const g = await enter();
    // 下单其实成功了、页面没收到响应：按原编号查回。只说生效了、记在哪次来访上，不给整张账单
    const key = randomUUID();
    expect((await order(g.visitId, ['柠檬茶'], {}, km, key)).status).toBe(200);
    expect((await api(ctx.app, km, 'GET', `/api/frontdesk/ops/${key}?type=bill_post`)).status).toBe(403);
    const found = await api(ctx.app, km, 'GET', `/api/dining/ops/${key}`);
    expect([found.status, found.body]).toEqual([200, { found: true, type: 'dining_order', visitId: g.visitId }]);
    // 已经生效的作废不了：照样答生效了
    expect((await api(ctx.app, km, 'POST', `/api/dining/ops/${key}/abandon`, {})).body).toEqual({ found: true, type: 'dining_order', visitId: g.visitId });

    // 原请求没到（或还在路上）：确认作废以后它再到也不会生效；留一条作废的审计
    const lost = randomUUID();
    expect((await api(ctx.app, km, 'GET', `/api/dining/ops/${lost}`)).body).toEqual({ found: false, abandoned: false });
    expect((await api(ctx.app, km, 'POST', `/api/frontdesk/ops/${lost}/abandon`, { type: 'bill_post' })).status).toBe(403);
    expect((await api(ctx.app, km, 'POST', `/api/dining/ops/${lost}/abandon`, {})).body).toEqual({ found: false, abandoned: true });
    const late = await order(g.visitId, ['果盘'], {}, km, lost);
    expect(late.body.error?.code).toBe('OP_ABANDONED');
    expect((await api(ctx.app, km, 'GET', `/api/dining/ops/${lost}`)).body).toEqual({ found: false, abandoned: true });
    const [abandons] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'frontdesk_abandon' AND detail->>'key' = ${lost}`;
    expect(abandons!.n).toBe(1);
    const [count] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${g.visitId}`;
    expect(count!.n).toBe(1);

    // 编号属于别的前台业务（发牌）：这里只答没查到、不说是什么，也不作废
    tagNo += 1;
    const checkinKey = randomUUID();
    const other = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', {
      clientKey: checkinKey,
      guests: [{ tagCode: `G${String(tagNo).padStart(3, '0')}`, zone: 'male', memberId: null }],
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect((await api(ctx.app, km, 'GET', `/api/dining/ops/${checkinKey}`)).body).toEqual({ found: false, abandoned: false });
    expect((await api(ctx.app, km, 'POST', `/api/dining/ops/${checkinKey}/abandon`, {})).body).toEqual({ found: false, abandoned: false });
    const [fences] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM op_fences WHERE key = ${checkinKey}`;
    expect(fences!.n).toBe(0);

    // 同一台设备上前台的同事（有前台权限）也能从这里处理；两样都没有的不行
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/dining/ops/${key}`)).body).toEqual({ found: true, type: 'dining_order', visitId: g.visitId });
    const bm = (await api(ctx.app, butler, 'GET', '/api/auth/me')).body as { permissions: string[] };
    expect(bm.permissions.filter((p) => ['dining.order', 'frontdesk.read', 'frontdesk.operate'].includes(p))).toEqual([]);
    expect((await api(ctx.app, butler, 'GET', `/api/dining/ops/${key}`)).status).toBe(403);
    expect((await api(ctx.app, butler, 'POST', `/api/dining/ops/${randomUUID()}/abandon`, {})).status).toBe(403);
  });
});

describe('房号找客人与送达（B3）', () => {
  it('只填房号：找到在住的客人、出品单写送到哪；找不到拒绝；都填时记在手牌上、房号写在送达位置；换了房按原房号下单拒绝', async () => {
    const g = await enter();
    const s = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', { clientKey: randomUUID(), roomId: room['H601'], expectedRate: 30000, tagCode: g.tagCode, guests: 1 });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(await findGuestByRoom(ctx.sql, 'h601')).toEqual({ visitId: g.visitId, tagCode: g.tagCode });
    expect(await findGuestByRoom(ctx.sql, 'H602')).toBeNull();

    const byRoom = await guest('room=h601');
    expect(byRoom.body).toMatchObject({ visitId: g.visitId, tagCode: g.tagCode, via: 'room', deliverRoom: 'H601' });
    expect((await guest('room=H602')).status).toBe(404);
    expect((await guest('tag=&room=')).status).toBe(400);
    // 只带 tag 的照旧：手牌找不到时当房号找在住的客人
    expect((await guest('tag=H601')).body).toMatchObject({ visitId: g.visitId, via: 'room', deliverRoom: 'H601' });

    const k1 = randomUUID();
    const r1 = await order(g.visitId, ['柠檬茶'], { deliverRoom: 'h601', roomOnly: true }, ctx.clerk, k1);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    const [k] = await ctx.sql<{ deliverTo: string; deliverRoom: string }[]>`SELECT deliver_to, deliver_room FROM kitchen_items WHERE visit_id = ${g.visitId} ORDER BY id DESC LIMIT 1`;
    expect(k).toEqual({ deliverTo: '房 H601', deliverRoom: 'H601' });
    expect((await order(g.visitId, ['柠檬茶'], { roomOnly: true })).status).toBe(400);
    expect((await order(g.visitId, ['柠檬茶'], { deliverRoom: 'H601', roomOnly: true, toRoom: true })).status).toBe(400);

    // 都填：账记在手牌上，房号写在送达位置（不核对房号是不是这位客人的）
    const other = await enter();
    const both = await guest(`tag=${other.tagCode}&room=SPA3`);
    expect(both.body).toMatchObject({ visitId: other.visitId, via: 'tag', deliverRoom: 'SPA3' });
    expect((await guest('tag=G999&room=SPA3')).status).toBe(404);
    expect((await order(other.visitId, ['果盘'], { deliverRoom: 'SPA3' })).status).toBe(200);
    const items = (await kitchen()).items.filter((i) => i.visitId === other.visitId);
    expect(items[0]).toMatchObject({ deliverRoom: 'SPA3', deliverTo: '房 SPA3', tagCode: other.tagCode });
    expect((await order(other.visitId, ['果盘'], { deliverRoom: '12345678901' })).status).toBe(400);

    // 换了房：按原来的房号下单拒绝（下单时在挂账的事务里再核对一次）；原样重提第一次那一单照样返回
    const moved = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.body.id}/move`, { toRoomId: room['H602'], reason: '客人嫌吵' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await order(g.visitId, ['柠檬茶'], { deliverRoom: 'H601', roomOnly: true })).body.error.code).toBe('ROOM_GUEST_CHANGED');
    expect((await order(g.visitId, ['柠檬茶'], { deliverRoom: 'h601', roomOnly: true }, ctx.clerk, k1)).status).toBe(200);
    expect((await order(g.visitId, ['柠檬茶'], { deliverRoom: 'H602', roomOnly: true })).status).toBe(200);
  });
});

describe('整单备注（B3）', () => {
  it('写进这一单每道菜的出品单（厨房屏）与点菜单；桌台点单也有；太长拒绝；同一编号换了备注拒绝', async () => {
    const g = await enter();
    const key = randomUUID();
    const r = await order(g.visitId, ['宫保鸡丁', '柠檬茶'], { orderNote: '一起上，先上饮料' }, ctx.clerk, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await order(g.visitId, ['宫保鸡丁', '柠檬茶'], { orderNote: '一起上，先上饮料' }, ctx.clerk, key)).status).toBe(200);
    expect((await order(g.visitId, ['宫保鸡丁', '柠檬茶'], { orderNote: '分开上' }, ctx.clerk, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const mine = (await kitchen()).items.filter((i) => i.visitId === g.visitId);
    expect(mine.map((i) => i.orderNote)).toEqual(['一起上，先上饮料', '一起上，先上饮料']);
    const receipt = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/receipt?visit=${g.visitId}`)).body as DiningReceipt;
    expect(receipt.orders).toHaveLength(1);
    expect(receipt.orders[0]).toMatchObject({ orderNote: '一起上，先上饮料', deliverRoom: '' });
    expect((await order(g.visitId, ['柠檬茶'], { orderNote: '长'.repeat(61) })).status).toBe(400);
    // 不带备注的照旧（出品单上是空的）
    expect((await order(g.visitId, ['柠檬茶'])).status).toBe(200);
    expect((await kitchen()).items.filter((i) => i.visitId === g.visitId).map((i) => i.orderNote)).toEqual(['一起上，先上饮料', '一起上，先上饮料', '']);

    const sessions = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/tables')).body.tables.find((t: { id: number }) => t.id === tableId).session;
    const tp = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${sessions.id}/orders`, {
      clientKey: randomUUID(),
      lines: lines(['果盘']),
      expectedTotal: 3800,
      orderNote: '果盘切小块',
    });
    expect(tp.status, JSON.stringify(tp.body)).toBe(200);
    expect((await kitchen()).items.filter((i) => i.tableSessionId === sessions.id).at(-1)).toMatchObject({ orderNote: '果盘切小块', tableName: '水吧1' });
  });
});

describe('台账合并退菜（B2）', () => {
  let gift: GiftType;
  it('类型筛选：正常 / 退菜 / 赠送 / 折扣；退菜带原因、审批方式与审批人、责任岗位；退菜率；导出跟着筛选', async () => {
    // 退菜：店员小额直接退（责任岗位：厨房）；桌台的菜经理退（责任岗位：水吧）；不选责任岗位的照旧能退（记「—」）
    const g = await enter();
    expect((await order(g.visitId, ['柠檬茶', '果盘'])).status).toBe(200);
    const tea = await lineOf(g.visitId, '柠檬茶');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${tea.id}/void`, { reason: '做错了', blame: 'nobody' })).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${tea.id}/void`, { reason: '做错了', blame: 'kitchen' })).status).toBe(200);
    const fruit = await lineOf(g.visitId, '果盘');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${fruit.id}/void`, { reason: '客人不要了' })).status).toBe(200);
    const sid = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/tables')).body.tables.find((t: { id: number }) => t.id === tableId).session.id as number;
    const tl = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/tables/sessions/${sid}`)).body.lines.find((l: { name: string; status: string }) => l.name === '果盘' && l.status === 'active');
    expect((await api(ctx.app, duty, 'POST', `/api/dining/tables/lines/${tl.id}/void`, { reason: '果吧缺货', blame: 'fruit' })).status).toBe(200);

    // 赠送：签赠券（换一份果盘）；折扣：代金券
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/gifts/types', {
      clientKey: randomUUID(),
      name: '果盘体验券',
      kind: 'exchange',
      exchangeItemId: item['果盘'],
      segment: '餐饮',
      content: '送果盘一份',
      rules: '',
      validity: 'days',
      validDays: 30,
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    gift = t.body as GiftType;
    const m1 = (await createMember(ctx, '台账会员甲')).id;
    const issued = await api(ctx.app, butler, 'POST', '/api/gifts/issues', {
      clientKey: randomUUID(),
      memberId: m1,
      templateId: gift.id,
      quantity: 1,
      channel: '管家部',
      reason: '生日',
      authorizedBy: dutyId,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const v1 = await enter(m1);
    expect((await order(v1.visitId, ['果盘', '宫保鸡丁'])).status).toBe(200);
    const pre1 = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v1.visitId}`)).body as CheckoutPreview;
    const code = (issued.body as GiftIssueResult).coupons[0]!.code;
    const opt = pre1.storeCoupons!.find((c) => c.code === code)!;
    expect(opt.usable).toBe(true);
    const c1 = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v1.visitId],
      expectedTotal: pre1.totalAmount,
      payments: [
        { method: 'store_coupon', code, amount: opt.amount },
        { method: 'cash', amount: pre1.totalAmount - opt.amount },
      ],
    });
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);

    const tpl = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '台账代金券', kind: 'cash', faceValue: 1000, validity: 'days', validDays: 30 });
    expect(tpl.status, JSON.stringify(tpl.body)).toBeLessThan(300);
    const m2 = (await createMember(ctx, '台账会员乙')).id;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${m2}/coupons`, { clientKey: randomUUID(), templateId: tpl.body.id, quantity: 1, reason: '回馈' })).status).toBeLessThan(300);
    const v2 = await enter(m2);
    expect((await order(v2.visitId, ['柠檬茶'])).status).toBe(200);
    const pre2 = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v2.visitId}`)).body as CheckoutPreview;
    const opt2 = pre2.storeCoupons!.find((c) => c.usable)!;
    const c2 = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v2.visitId],
      expectedTotal: pre2.totalAmount,
      payments: [
        { method: 'store_coupon', code: opt2.code, amount: opt2.amount },
        { method: 'cash', amount: pre2.totalAmount - opt2.amount },
      ],
    });
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);

    const all = await ledger();
    const kinds = (l: DiningLedger) => new Set(l.rows.map((r) => r.kind));
    expect(kinds(all)).toEqual(new Set(['normal', 'voided', 'gift', 'discount']));
    const voided = await ledger('&type=voided');
    expect(voided.rows.length).toBeGreaterThanOrEqual(3);
    expect(voided.rows.every((r) => r.kind === 'voided' && r.status === 'voided')).toBe(true);
    const row = (reason: string) => voided.rows.find((r) => r.voidReason === reason)!;
    expect(row('做错了')).toMatchObject({ blame: 'kitchen', approvalText: '小额直接退' });
    expect(row('客人不要了')).toMatchObject({ blame: null, approvalText: '小额直接退' });
    expect(row('果吧缺货')).toMatchObject({ blame: 'fruit', approvalText: '小额直接退', tableName: '水吧1' });
    const gifts = await ledger('&type=gift');
    expect(gifts.rows.map((r) => [r.name, r.tagCode])).toEqual([['果盘', v1.tagCode]]);
    expect(gifts.rows[0]).toMatchObject({ approvalText: null, blame: null, status: 'active' });
    const discounts = await ledger('&type=discount');
    expect(discounts.rows.map((r) => [r.name, r.tagCode])).toEqual([['柠檬茶', v2.tagCode]]);
    const normal = await ledger('&type=normal');
    expect(normal.rows.find((r) => r.tagCode === v1.tagCode)).toMatchObject({ name: '宫保鸡丁', kind: 'normal' });
    expect(normal.rows.length + voided.rows.length + gifts.rows.length + discounts.rows.length).toBe(all.rows.length);

    // 退菜率：份数比、金额比，按类型筛之前的那一批算（选了「退菜」也一样）
    const q = all.rows.reduce((n, r) => n + r.quantity, 0);
    const vq = all.rows.filter((r) => r.status === 'voided').reduce((n, r) => n + r.quantity, 0);
    expect(all.voidRate).toMatchObject({ quantity: q, voidedQuantity: vq });
    expect(voided.voidRate).toEqual(all.voidRate);
    expect(voided.totals).toMatchObject({ lines: voided.rows.length, voidedLines: voided.rows.length, quantity: 0, amount: 0 });
    // 只看水吧：退菜率跟着分类筛
    const water = await ledger('&outlet=water');
    expect(water.voidRate.quantity).toBe(water.rows.reduce((n, r) => n + r.quantity, 0));
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/dining/ledger?from=${today}&to=${today}&type=refund`)).status).toBe(400);

    // 导出：跟着筛选；多三列（类型、审批、责任岗位）；合计一行写退菜率
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/dining/ledger/export?from=${today}&to=${today}&type=voided`, headers: { cookie: ctx.clerk } });
    expect(csv.statusCode).toBe(200);
    expect(decodeURIComponent(String(csv.headers['content-disposition']))).toContain(`餐饮台账-${today}至${today}-退菜.csv`);
    const rows = csv.body
      .replace(/^﻿/, '')
      .trim()
      .split('\r\n')
      .map((r) => r.split(','));
    expect(rows[0]!.slice(-3)).toEqual(['类型', '审批', '责任岗位']);
    expect(rows.length).toBe(voided.rows.length + 2);
    expect(rows.slice(1, -1).every((r) => r[14] === '退菜')).toBe(true);
    expect(rows.find((r) => r[11] === '做错了')!.slice(-3)).toEqual(['退菜', '小额直接退', '厨房']);
    expect(rows.at(-1)![0]).toBe('合计');
    expect(rows.at(-1)![12]).toMatch(/^退菜率 \d+\.\d%（金额 \d+\.\d%）$/);
  });

  it('反结账以后不再算赠送、折扣（券退回了）', async () => {
    const before = await ledger('&type=discount');
    const [c] = await ctx.sql<{ id: number }[]>`
      SELECT c.id FROM checkouts c JOIN checkout_payments p ON p.checkout_id = c.id
      WHERE p.method = 'store_coupon' AND c.status = 'completed' ORDER BY c.id DESC LIMIT 1`;
    const v = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${c!.id}/void`, { reason: '收错了' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const after = await ledger('&type=discount');
    expect(after.rows.length).toBe(before.rows.length - 1);
  });
});

describe('加料、套餐与出品口（块 B 与菜品管理的接头，ZT26–ZT28）', () => {
  it('加料单独一行、按它自己的出品口核对：只能在餐厅下单的人配水吧的加料整单拒绝、写明是那道加料；两处都能下的照常。套餐按套餐自己的出品口核对，不看含的几样', async () => {
    const make = async (body: Record<string, unknown>) => {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/dining/dishes', { clientKey: randomUUID(), category: '餐饮', ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.dish.id as number;
    };
    const noodle = await make({ name: '牛肉面', slot: 'restaurant:餐饮', stationId: station['热菜'], prices: { standard: 3800 }, methods: ['微辣'], addons: [item['柠檬茶']] });
    const combo = await make({
      name: '双人套餐',
      slot: 'restaurant:餐饮',
      stationId: station['热菜'],
      prices: { standard: 8800 },
      combo: [
        { itemId: item['柠檬茶'], quantity: 2 },
        { itemId: item['果盘'], quantity: 1 },
      ],
    });
    const drinks = await make({
      name: '饮品套餐',
      category: '饮品',
      slot: 'water:手作饮料',
      stationId: station['水吧'],
      prices: { standard: 5800 },
      combo: [{ itemId: item['宫保鸡丁'], quantity: 1 }],
    });
    // 点单页的菜单：加料带上自己的 id，点单页按菜单里这道菜的出品口标「不能在水吧下单」（ZT26）
    const menu = (await api(ctx.app, ctx.clerk, 'GET', '/api/dining/menu')).body as { dishes: { id: number; outlet: string; addons?: { id: number }[] }[] };
    expect(menu.dishes.find((d) => d.id === noodle)!.addons).toEqual([expect.objectContaining({ id: item['柠檬茶'] })]);
    expect(menu.dishes.find((d) => d.id === item['柠檬茶'])!.outlet).toBe('water');

    const g = await enter();
    const withAddon = [
      { itemId: noodle, quantity: 1, note: '微辣' },
      { itemId: item['柠檬茶']!, quantity: 1, note: addonNote('牛肉面') },
    ];
    const post = (cookie: string, body: { lines: { itemId: number; quantity: number; note?: string }[]; expectedTotal: number; orderNote?: string }) =>
      api(ctx.app, cookie, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId: g.visitId, ...body });
    expect((await setClerkPermissions(['dining.orderWater', 'dining.orderFruit'])).status).toBe(200);
    try {
      const denied = await post(ctx.clerk, { lines: withAddon, expectedTotal: 3800 + 1800 });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatchObject({ code: 'OUTLET_FORBIDDEN', details: { items: ['柠檬茶'] } });
      expect(denied.body.error.message).toContain('水吧');
      // 套餐按套餐自己的出品口：餐厅的套餐含水吧、果吧的几样，只能在餐厅下单的照样能点；水吧的套餐含餐厅的菜，照样拒绝
      expect((await post(ctx.clerk, { lines: [{ itemId: combo, quantity: 1 }], expectedTotal: 8800 })).status).toBe(200);
      const drinksDenied = await post(ctx.clerk, { lines: [{ itemId: drinks, quantity: 1 }], expectedTotal: 5800 });
      expect(drinksDenied.body.error).toMatchObject({ code: 'OUTLET_FORBIDDEN', details: { items: ['饮品套餐'] } });
    } finally {
      expect((await setClerkPermissions([])).status).toBe(200);
    }
    // 康美部（水吧、果吧）：水吧的套餐能点（含的宫保鸡丁不另核对），餐厅的套餐拒绝
    expect((await post(km, { lines: [{ itemId: drinks, quantity: 1 }], expectedTotal: 5800 })).status).toBe(200);
    expect((await post(km, { lines: [{ itemId: combo, quantity: 1 }], expectedTotal: 8800 })).body.error).toMatchObject({ code: 'OUTLET_FORBIDDEN', details: { items: ['双人套餐'] } });
    // 两处都能下：照常，整单备注与这一行的备注分开存（ZT28）
    expect((await post(ctx.clerk, { lines: withAddon, expectedTotal: 3800 + 1800, orderNote: '一起上' })).status).toBe(200);

    const mine = (await kitchen()).items.filter((i) => i.visitId === g.visitId);
    expect(mine.map((i) => [i.name, i.note, i.orderNote, i.parts])).toEqual([
      [
        '双人套餐',
        '',
        '',
        [
          { name: '柠檬茶', quantity: 2 },
          { name: '果盘', quantity: 1 },
        ],
      ],
      ['饮品套餐', '', '', [{ name: '宫保鸡丁', quantity: 1 }]],
      ['牛肉面', '微辣', '一起上', []],
      ['柠檬茶', '配 牛肉面', '一起上', []],
    ]);
    // 点菜单：整单备注写在那一次下单上，这一行的备注、套餐含的几样写在各自的行上
    const receipt = (await api(ctx.app, ctx.clerk, 'GET', `/api/dining/receipt?visit=${g.visitId}`)).body as DiningReceipt;
    expect(receipt.orders.map((o) => [o.orderNote, o.lines.map((l) => [l.name, l.note, l.parts.length])])).toEqual([
      ['', [['双人套餐', '', 2]]],
      ['', [['饮品套餐', '', 1]]],
      [
        '一起上',
        [
          ['牛肉面', '微辣', 0],
          ['柠檬茶', '配 牛肉面', 0],
        ],
      ],
    ]);
  });
});
