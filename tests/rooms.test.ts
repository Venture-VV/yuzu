// S7 客房（v0.7.4，见 docs/ROOMS.md）：后台房型与房间、入住（只住房 / 洗浴客人）、房费（入住、夜审、退房补挂）、续住、换房、
// 押金（收、退、退房结账时抵扣、反结账恢复）、洗浴客人退房、只住房的客人退房结账与反结账、撤销入住、打扫与维修、权限、幂等。
// 用 ctx.at 指定业务发生时间来模拟「昨天入住」「今晚夜审」。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localMinuteAt, type StayDetail } from '../src/shared/rooms';
import { shiftDate } from '../src/shared/labels';
import type { Actor } from '../src/server/lib/context';
import { checkinRoom, closeStay, runNightAudit } from '../src/server/modules/rooms';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let duty: string;
let cleaner: string;
let am: string;
let today: string;
let clerk: Actor;
const type: Record<string, number> = {};
const room: Record<string, number> = {};
const deps = () => ({ sql: ctx.sql, config: ctx.config });
const tz = 'Asia/Shanghai';
/** 门店时区某天的几点几分 */
const at = (date: string, hh: number, mm = 0) => localMinuteAt(date, hh * 60 + mm, tz);

const checkin = (body: Record<string, unknown>, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/rooms/checkin', { clientKey, guests: 1, ...body });
const stay = async (id: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/rooms/stays/${id}`)).body as StayDetail;
const board = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/rooms')).body as { rooms: { roomNo: string; status: string; stay: { id: number; chargedAmount: number; depositBalance: number } | null }[]; audit: { pending: number } };
const tile = async (roomNo: string) => (await board()).rooms.find((r) => r.roomNo === roomNo)!;
const housekeep = (roomNo: string, status: string, note?: string, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'PUT', `/api/rooms/${room[roomNo]}/housekeeping`, { status, ...(note ? { note } : {}) });
const checks = async () => {
  for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
};

beforeAll(async () => {
  ctx = await setup();
  for (const [username, displayName, role] of [
    ['boss', '店总', 'store_manager'],
    ['duty', '值班经理', 'duty_manager'],
    ['cleaner', '客房服务员', 'backoffice'],
    ['am', '客户经理', 'account_manager'],
  ] as const) {
    await createStaff(ctx.sql, { username, displayName, role, password: PASSWORD, mustChangePassword: false });
  }
  boss = await login(ctx.app, 'boss');
  duty = await login(ctx.app, 'duty');
  cleaner = await login(ctx.app, 'cleaner');
  am = await login(ctx.app, 'am');
  clerk = { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false };
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 20, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('后台：客房规则、房型、房间', () => {
  it('客房功能默认关闭：入住拒绝；店主开启；店总能建房型、房间，不能改规则；店员不能建', async () => {
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.rooms).toBe(false);
    expect((await api(ctx.app, boss, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 20000 })).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/rooms/types', { name: '豪华单间', kind: 'daily', price: 38800 })).status).toBe(403);
    for (const [name, kind, price, blockMinutes] of [
      ['豪华单间', 'daily', 38800, null],
      ['标准间', 'daily', 28800, null],
      ['钟点房', 'hourly', 12800, 180],
    ] as const) {
      const r = await api(ctx.app, boss, 'POST', '/api/admin/rooms/types', { name, kind, price, blockMinutes });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      type[name] = r.body.types.find((t: { name: string }) => t.name === name).id;
    }
    expect((await api(ctx.app, boss, 'POST', '/api/admin/rooms/types', { name: ' 豪华单间 ', kind: 'daily', price: 1 })).body.error.code).toBe('ROOM_TYPE_NAME_TAKEN');
    expect((await api(ctx.app, boss, 'POST', '/api/admin/rooms/types', { name: '午休房', kind: 'hourly', price: 5000 })).status).toBe(400);
    for (const [roomNo, floor, t] of [
      ['301', '3', '豪华单间'],
      ['302', '3', '豪华单间'],
      ['303', '3', '标准间'],
      ['8A', '8', '钟点房'],
    ] as const) {
      const r = await api(ctx.app, boss, 'POST', '/api/admin/rooms/rooms', { roomNo, floor, roomTypeId: type[t] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      room[roomNo] = r.body.rooms.find((x: { roomNo: string }) => x.roomNo === roomNo).id;
    }
    expect((await api(ctx.app, boss, 'POST', '/api/admin/rooms/rooms', { roomNo: '301', roomTypeId: type['标准间'] })).body.error.code).toBe('ROOM_NO_TAKEN');
    expect((await checkin({ roomId: room['301'], expectedRate: 38800 })).body.error.code).toBe('ROOMS_DISABLED');
    const rules = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 20000 });
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.rooms).toBe(true);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 600, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(400);
    expect((await board()).rooms.map((r) => [r.roomNo, r.status])).toEqual([
      ['301', 'vacant'],
      ['302', 'vacant'],
      ['303', 'vacant'],
      ['8A', 'vacant'],
    ]);
  });

  it('权限：客户经理看不到客房；后勤（客房服务员）能看房态、打扫，不能入住', async () => {
    expect((await api(ctx.app, am, 'GET', '/api/rooms')).status).toBe(403);
    expect((await api(ctx.app, cleaner, 'GET', '/api/rooms')).status).toBe(200);
    expect((await checkin({ roomId: room['303'], expectedRate: 28800 }, cleaner)).status).toBe(403);
    expect((await housekeep('303', 'dirty', undefined, cleaner)).status).toBe(200);
    expect((await housekeep('303', 'maintenance', undefined, cleaner)).status).toBe(400);
    expect((await housekeep('303', 'maintenance', '空调不制冷', cleaner)).status).toBe(200);
    expect((await tile('303')).status).toBe('maintenance');
    expect((await checkin({ roomId: room['303'], expectedRate: 28800 })).body.error.code).toBe('ROOM_NOT_READY');
    expect((await housekeep('303', 'clean', undefined, cleaner)).status).toBe(200);
    expect((await tile('303')).status).toBe('vacant');
  });
});

describe('只住房的客人：入住、押金、退房结账、反结账', () => {
  it('入住挂第一晚、收押金；同一编号重提只入住一次；房间有人住、房价刚改都拒绝', async () => {
    const key = randomUUID();
    expect((await checkin({ roomId: room['301'], expectedRate: 30000 })).body.error.code).toBe('PRICE_CHANGED');
    const first = await checkin({ roomId: room['301'], expectedRate: 38800, guestLabel: '李先生', guests: 2, deposit: { method: 'cash', amount: 20000 } }, ctx.clerk, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const s = first.body as StayDetail;
    expect(s).toMatchObject({ roomNo: '301', kind: 'daily', rate: 38800, status: 'open', guests: 2, tagCode: null, chargedAmount: 38800, depositBalance: 20000, billAmount: 38800 });
    expect(s.charges).toEqual([expect.objectContaining({ kind: 'night', nightDate: today, amount: 38800, source: 'checkin', lineStatus: 'active' })]);
    expect(s.depositByMethod).toEqual([{ method: 'cash', balance: 20000 }]);
    const again = await checkin({ roomId: room['301'], expectedRate: 38800, guestLabel: '李先生', guests: 2, deposit: { method: 'cash', amount: 20000 } }, ctx.clerk, key);
    expect(again.body.id).toBe(s.id);
    expect((await checkin({ roomId: room['301'], expectedRate: 38800 })).body.error.code).toBe('ROOM_TAKEN');
    const [count] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM room_stays WHERE room_id = ${room['301']!}`;
    expect(count!.n).toBe(1);
    expect(await tile('301')).toMatchObject({ status: 'occupied', stay: { id: s.id, chargedAmount: 38800, depositBalance: 20000 } });
    await checks();
  });

  it('退房结账：押金抵扣 + 现金；结清后入住单已结账、房间待打扫、押金清零；储值只能用登记的会员', async () => {
    const s = (await tile('301')).stay!;
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/rooms/stays/${s.id}/checkout-preview`)).body;
    expect(preview).toMatchObject({ dues: [], billAmount: 38800, total: 38800, depositBalance: 20000 });
    const m = await createMember(ctx, '外来会员', '19900077001');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 100000))).status).toBe(200);
    const pay = (payments: unknown[], expectedTotal = 38800, clientKey = randomUUID()) =>
      api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkout', { clientKey, stayIds: [s.id], expectedTotal, payments });
    expect((await pay([{ method: 'cash', amount: 38800 }], 30000)).body.error.code).toBe('PRICE_CHANGED');
    expect((await pay([{ method: 'deposit', amount: 30000 }, { method: 'cash', amount: 8800 }])).body.error.code).toBe('DEPOSIT_INSUFFICIENT');
    expect((await pay([{ method: 'wallet', memberId: m.id, amount: 38800, expectedSplit: { principal: 38800, bonus: 0 } }])).body.error.code).toBe('WALLET_MEMBER_NOT_IN_CHECKOUT');
    // 手牌结账不能用押金抵扣
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [1], expectedTotal: 0, payments: [{ method: 'deposit', amount: 1 }] })).status).toBe(400);
    const key = randomUUID();
    const done = await pay([{ method: 'deposit', amount: 20000 }, { method: 'cash', amount: 18800 }], 38800, key);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed', totalAmount: 38800 });
    expect(done.body.bills).toEqual([expect.objectContaining({ roomNo: '301', guests: 2, tagCode: null, tableName: null, amount: 38800 })]);
    expect(done.body.payments.map((p: { method: string; amount: number }) => [p.method, p.amount])).toEqual([
      ['deposit', 20000],
      ['cash', 18800],
    ]);
    expect((await pay([{ method: 'deposit', amount: 20000 }, { method: 'cash', amount: 18800 }], 38800, key)).body.id).toBe(done.body.id);
    const after = await stay(s.id);
    expect(after).toMatchObject({ status: 'settled', depositBalance: 0 });
    expect(after.deposits.map((d) => [d.kind, d.method, d.amount])).toEqual([
      ['receive', 'cash', 20000],
      ['apply', 'cash', 20000],
    ]);
    expect((await tile('301')).status).toBe('dirty');
    const list = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts?date=${today}`)).body as { id: number; roomNos: string[] }[];
    expect(list.find((c) => c.id === done.body.id)!.roomNos).toEqual(['301']);
    await checks();
  });

  it('反结账：入住单恢复在住、押金抵扣恢复为押金；房间已有别人入住时不能反结账', async () => {
    const [c] = await ctx.sql<{ id: number }[]>`SELECT checkout_id AS id FROM room_deposits WHERE kind = 'apply' ORDER BY id DESC LIMIT 1`;
    const [s] = await ctx.sql<{ id: number }[]>`SELECT id FROM room_stays WHERE room_id = ${room['301']!} ORDER BY id DESC LIMIT 1`;
    expect((await housekeep('301', 'clean')).status).toBe(200);
    const other = await checkin({ roomId: room['301'], expectedRate: 38800 });
    expect(other.status).toBe(200);
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${c!.id}/void`, { reason: '收错了' })).body.error.code).toBe('ROOM_TAKEN');
    // 先给那位客人换到 302，再反结账
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${other.body.id}/move`, { toRoomId: room['302'], reason: '房间搞错了' })).status).toBe(200);
    expect((await tile('301')).status).toBe('dirty');
    const v = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${c!.id}/void`, { reason: '收错了' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const back = await stay(s!.id);
    expect(back).toMatchObject({ status: 'open', depositBalance: 20000, billAmount: 38800 });
    expect(back.deposits.map((d) => d.kind)).toEqual(['receive', 'apply', 'unapply']);
    expect((await tile('301')).status).toBe('occupied');
    // 重结：全部现金，押金原路退回
    const redo = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkout', { clientKey: randomUUID(), stayIds: [s!.id], expectedTotal: 38800, payments: [{ method: 'cash', amount: 38800 }] });
    expect(redo.status, JSON.stringify(redo.body)).toBe(200);
    expect((await stay(s!.id)).deposits.map((d) => [d.kind, d.method, d.amount])).toEqual([
      ['receive', 'cash', 20000],
      ['apply', 'cash', 20000],
      ['unapply', 'cash', 20000],
      ['refund', 'cash', 20000],
    ]);
    // 302 那位客人：撤销入住要先作废房费、退押金
    const o = (await stay(other.body.id)) as StayDetail;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${o.id}/cancel`, { reason: '开错房' })).body.error.code).toBe('ROOM_CHARGED');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/lines/${o.charges[0]!.lineId}/void`, { reason: '开错房' })).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${o.id}/cancel`, { reason: '开错房' })).status).toBe(200);
    expect((await stay(o.id)).status).toBe('cancelled');
    expect((await tile('302')).status).toBe('dirty');
    await checks();
  });
});

describe('押金：收、退', () => {
  it('在住期间收押金、按原收款方式退一部分；超过余额、方式不对都拒绝', async () => {
    expect((await housekeep('302', 'clean')).status).toBe(200);
    const s = (await checkin({ roomId: room['302'], expectedRate: 38800, deposit: { method: 'wechat', amount: 30000, ref: '尾号 1234' } })).body as StayDetail;
    const receive = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/deposits`, { clientKey: randomUUID(), method: 'cash', amount: 10000 });
    expect(receive.status, JSON.stringify(receive.body)).toBe(200);
    expect(receive.body.depositByMethod).toEqual([
      { method: 'wechat', balance: 30000 },
      { method: 'cash', balance: 10000 },
    ]);
    const refund = (method: string, amount: number) =>
      api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/refunds`, { clientKey: randomUUID(), method, amount, reason: '客人要回一部分' });
    expect((await refund('cash', 20000)).body.error.code).toBe('DEPOSIT_INSUFFICIENT');
    expect((await refund('alipay', 100)).body.error.code).toBe('DEPOSIT_INSUFFICIENT');
    expect((await refund('wechat', 5000)).status).toBe(200);
    expect((await stay(s.id)).depositBalance).toBe(35000);
    // 退房结账：押金抵扣先用非现金（微信），余下现金原路退回
    const done = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkout', {
      clientKey: randomUUID(),
      stayIds: [s.id],
      expectedTotal: 38800,
      payments: [{ method: 'deposit', amount: 30000 }, { method: 'cash', amount: 8800 }],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await stay(s.id)).deposits.map((d) => [d.kind, d.method, d.amount])).toEqual([
      ['receive', 'wechat', 30000],
      ['receive', 'cash', 10000],
      ['refund', 'wechat', 5000],
      ['apply', 'wechat', 25000],
      ['apply', 'cash', 5000],
      ['refund', 'cash', 5000],
    ]);
    await checks();
  });
});

describe('洗浴客人：房费挂手牌账单，先退房再结账', () => {
  it('入住挂在手牌账单上；手牌结账前要先退房；退房退押金、房间待打扫，房费随手牌结账', async () => {
    const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'R001', zone: 'male' }] });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const visitId = v.body.visits[0].id as number;
    expect((await checkin({ roomId: room['303'], expectedRate: 28800, tagCode: 'R009' })).body.error.code).toBe('TAG_NOT_IN_STORE');
    const s = (await checkin({ roomId: room['303'], expectedRate: 28800, tagCode: 'r001', deposit: { method: 'cash', amount: 5000 } })).body as StayDetail;
    expect(s).toMatchObject({ tagCode: 'R001', visitId, chargedAmount: 28800 });
    const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
    expect(pre.rooms).toEqual([{ tagCode: 'R001', roomNo: '303', stayNo: s.stayNo }]);
    expect(pre.visits[0].lines.map((l: { name: string }) => l.name)).toContain(`房费 303 ${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日`);
    const pay = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: pre.totalAmount, payments: [{ method: 'cash', amount: pre.totalAmount }] });
    expect(pay.body.error.code).toBe('ROOM_OPEN');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/cancel`, { reason: '开错牌' })).body.error.code).toBe('ROOM_OPEN');
    // 只住房的客人才能退房结账
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkout', { clientKey: randomUUID(), stayIds: [s.id], expectedTotal: 28800, payments: [] })).body.error.code).toBe('BATH_GUEST_ROOM');
    const close = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/close`, { clientKey: randomUUID(), expectedDue: 0 });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(close.body).toMatchObject({ status: 'checked_out', depositBalance: 0 });
    expect((await tile('303')).status).toBe('dirty');
    const pre2 = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
    expect(pre2.rooms).toEqual([]);
    const ok = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: pre2.totalAmount, payments: [{ method: 'cash', amount: pre2.totalAmount }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await checks();
  });
});

describe('夜审与超时加收', () => {
  it('昨天入住：夜审给今晚挂一晚，同一晚不重复挂；18:00 前不能做；第二天 12:00–18:00 退房加收半天', async () => {
    expect((await housekeep('302', 'clean')).status).toBe(200);
    const yesterday = shiftDate(today, -1);
    const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'R002', zone: 'male' }] });
    const s = await checkinRoom(deps(), { clientKey: randomUUID(), roomId: room['302'], expectedRate: 38800, tagCode: 'R002' }, { actor: clerk, at: at(yesterday, 22) });
    expect(s).toMatchObject({ businessDate: yesterday, chargedAmount: 38800 });
    expect(v.status).toBe(201);
    await expect(runNightAudit(deps(), { actor: clerk, at: at(today, 17) })).rejects.toMatchObject({ code: 'AUDIT_TOO_EARLY' });
    const report = await runNightAudit(deps(), { actor: clerk, at: at(today, 19) });
    expect(report.posted).toEqual([{ stayNo: s.stayNo, roomNo: '302', nightDate: today, amount: 38800 }]);
    expect((await runNightAudit(deps(), { actor: clerk, at: at(today, 23) })).posted).toEqual([]);
    expect((await stay(s.id)).charges.map((c) => [c.kind, c.nightDate, c.source])).toEqual([
      ['night', yesterday, 'checkin'],
      ['night', today, 'audit'],
    ]);
    // 第二天 15:00 退房：加收半天；按旧的核对金额提交拒绝
    const tomorrow = shiftDate(today, 1);
    await expect(closeStay(deps(), s.id, { clientKey: randomUUID(), expectedDue: 0 }, { actor: clerk, at: at(tomorrow, 15) })).rejects.toMatchObject({ code: 'ROOM_DUE_CHANGED' });
    const closed = await closeStay(deps(), s.id, { clientKey: randomUUID(), expectedDue: 19400 }, { actor: clerk, at: at(tomorrow, 15) });
    expect(closed.charges.map((c) => [c.kind, c.nightDate, c.amount])).toEqual([
      ['night', yesterday, 38800],
      ['night', today, 38800],
      ['half_day', tomorrow, 19400],
    ]);
    await checks();
  });
});

describe('钟点房与换房、改登记', () => {
  it('钟点房入住挂第一段，续住加一段；全天房续住只改预计离店；换房只能换到空房，原房间待打扫', async () => {
    const s = (await checkin({ roomId: room['8A'], expectedRate: 12800 })).body as StayDetail;
    expect(s.charges.map((c) => [c.kind, c.blockNo])).toEqual([['block', 1]]);
    const ext = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/extend`, { clientKey: randomUUID(), addBlock: true });
    expect(ext.status, JSON.stringify(ext.body)).toBe(200);
    expect((ext.body as StayDetail).charges.map((c) => c.blockNo)).toEqual([1, 2]);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/extend`, { clientKey: randomUUID(), expectedCheckoutDate: today })).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/rooms/stays/${s.id}`, { guestLabel: '王女士', guests: 2 })).body).toMatchObject({ guestLabel: '王女士', guests: 2 });
    expect((await housekeep('301', 'clean')).status).toBe(200);
    const d = (await checkin({ roomId: room['301'], expectedRate: 38800 })).body as StayDetail;
    const tomorrow = shiftDate(today, 1);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${d.id}/extend`, { clientKey: randomUUID(), expectedCheckoutDate: tomorrow })).body.expectedCheckoutDate).toBe(tomorrow);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${d.id}/move`, { toRoomId: room['303'], reason: '客人嫌吵' })).body.error.code).toBe('ROOM_NOT_READY');
    expect((await housekeep('303', 'clean')).status).toBe(200);
    const moved = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${d.id}/move`, { toRoomId: room['303'], reason: '客人嫌吵' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ roomNo: '303', rate: 38800, moves: [expect.objectContaining({ fromRoom: '301', toRoom: '303', reason: '客人嫌吵' })] });
    expect((await tile('301')).status).toBe('dirty');
    expect((await housekeep('303', 'maintenance', '漏水')).body.error.code).toBe('ROOM_IN_USE');
    await checks();
  });
});
