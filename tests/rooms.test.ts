// S7 客房（v0.7.4，见 docs/ROOMS.md）：后台房型与房间、入住（住客都是在店的洗浴客人：门票必选，店主 2026-10-31 定）、
// 房费（入住、夜审、退房补挂，都挂在住客的手牌账单上）、续住、换房、押金（收、退，退房时原路退回）、退房后随手牌结账与反结账、
// 撤销入住、打扫与维修、权限、幂等、交班 / 日结 / 对账包 / 看板 / 自检。用 ctx.at 指定业务发生时间来模拟「昨天入住」「今晚夜审」。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localMinuteAt, type StayDetail } from '../src/shared/rooms';
import { shiftDate } from '../src/shared/labels';
import type { Actor } from '../src/server/lib/context';
import { checkinRoom, closeStay, runNightAudit } from '../src/server/modules/rooms';
import { buildDailyRecon } from '../src/server/ops/recon';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

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
/** 前台接待一位男宾（门票必选），返回来访 */
const guest = async (tagCode: string) => {
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male' }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  return v.body.visits[0].id as number;
};
/** 手牌结账：按核对的应收全部收现金 */
const settle = async (visitId: number) => {
  const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body as { totalAmount: number };
  return api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: pre.totalAmount, payments: [{ method: 'cash', amount: pre.totalAmount }] });
};
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
    expect((await api(ctx.app, boss, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(403);
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
    expect((await checkin({ roomId: room['301'], expectedRate: 38800, tagCode: 'R001' })).body.error.code).toBe('ROOMS_DISABLED');
    const rules = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 });
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.rooms).toBe(true);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 600, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(400);
    // 规则总表列出客房规则：开关不是默认值，其余按默认（待确认）；最近修改记在店主名下
    const catalog = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as { key: string; group: string; isDefault: boolean; pending: boolean; section: string; updatedBy: string | null }[];
    const roomRules = catalog.filter((r) => r.group === 'rooms');
    expect(roomRules.map((r) => [r.key, r.isDefault, r.pending, r.section])).toEqual([
      ['room_rules.enabled', false, false, 'rooms'],
      ['room_rules.checkout', true, true, 'rooms'],
      ['room_rules.hourlyGraceMinutes', true, true, 'rooms'],
      ['room_rules.defaultDeposit', true, true, 'rooms'],
    ]);
    expect(roomRules[0]!.updatedBy).toBeTruthy();
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
    expect((await checkin({ roomId: room['303'], expectedRate: 28800, tagCode: 'R010' }, cleaner)).status).toBe(403);
    expect((await housekeep('303', 'dirty', undefined, cleaner)).status).toBe(200);
    expect((await housekeep('303', 'maintenance', undefined, cleaner)).status).toBe(400);
    expect((await housekeep('303', 'maintenance', '空调不制冷', cleaner)).status).toBe(200);
    expect((await tile('303')).status).toBe('maintenance');
    expect((await checkin({ roomId: room['303'], expectedRate: 28800, tagCode: 'R010' })).body.error.code).toBe('ROOM_NOT_READY');
    expect((await housekeep('303', 'clean', undefined, cleaner)).status).toBe(200);
    expect((await tile('303')).status).toBe('vacant');
  });
});

describe('入住：住客要有在店的手牌（门票必选）', () => {
  it('没填手牌、手牌不在店都拒绝；入住挂第一晚到手牌账单上、收押金；同一编号重提只入住一次；房间有人住、房价刚改都拒绝', async () => {
    const visitId = await guest('R001');
    const noTag = await checkin({ roomId: room['301'], expectedRate: 38800 });
    expect(noTag.status).toBe(400);
    expect(noTag.body.error.message).toContain('手牌');
    expect((await checkin({ roomId: room['301'], expectedRate: 38800, tagCode: 'R009' })).body.error.code).toBe('TAG_NOT_IN_STORE');
    expect((await checkin({ roomId: room['301'], expectedRate: 30000, tagCode: 'R001' })).body.error.code).toBe('PRICE_CHANGED');
    const key = randomUUID();
    const body = { roomId: room['301'], expectedRate: 38800, tagCode: 'r001', guestLabel: '李先生', guests: 2, deposit: { method: 'cash', amount: 20000 } };
    const first = await checkin(body, ctx.clerk, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const s = first.body as StayDetail;
    expect(s).toMatchObject({ roomNo: '301', kind: 'daily', rate: 38800, status: 'open', guests: 2, tagCode: 'R001', visitId, chargedAmount: 38800, depositBalance: 20000 });
    expect(s.charges).toEqual([expect.objectContaining({ kind: 'night', nightDate: today, amount: 38800, source: 'checkin', lineStatus: 'active' })]);
    expect(s.depositByMethod).toEqual([{ method: 'cash', balance: 20000 }]);
    expect((await checkin(body, ctx.clerk, key)).body.id).toBe(s.id);
    expect((await checkin({ roomId: room['301'], expectedRate: 38800, tagCode: 'R001' })).body.error.code).toBe('ROOM_TAKEN');
    const [count] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM room_stays WHERE room_id = ${room['301']!}`;
    expect(count!.n).toBe(1);
    // 房费是手牌账单上的明细（来源「客房」）
    const visit = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${visitId}`)).body as { bill: { id: number }; lines: { name: string; source: string; amount: number }[] };
    expect(s.billId).toBe(visit.bill.id);
    expect(visit.lines.filter((l) => l.source === 'room').map((l) => [l.name, l.amount])).toEqual([[`房费 301 ${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日`, 38800]]);
    expect(await tile('301')).toMatchObject({ status: 'occupied', stay: { id: s.id, chargedAmount: 38800, depositBalance: 20000 } });
    await checks();
  });
});

describe('押金：收、退', () => {
  it('收现金、微信、「其他」押金；按原收款方式退一部分（「其他」也能退）；超过余额、方式不对都拒绝', async () => {
    const s = (await tile('301')).stay!;
    const receive = (method: string, amount: number, ref = '') =>
      api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/deposits`, { clientKey: randomUUID(), method, amount, ref });
    expect((await receive('wechat', 30000, '尾号 1234')).status).toBe(200);
    expect((await receive('other', 5000)).status).toBe(400);
    const other = await receive('other', 5000, '代金卡 0088');
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    const refund = (method: string, amount: number) =>
      api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/refunds`, { clientKey: randomUUID(), method, amount, reason: '客人要回一部分' });
    expect((await refund('cash', 30000)).body.error.code).toBe('DEPOSIT_INSUFFICIENT');
    expect((await refund('alipay', 100)).body.error.code).toBe('DEPOSIT_INSUFFICIENT');
    expect((await refund('wechat', 5000)).status).toBe(200);
    const r = await refund('other', 1000);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await stay(s.id);
    expect(after.depositBalance).toBe(20000 + 30000 + 5000 - 5000 - 1000);
    expect([...after.depositByMethod].sort((a, b) => a.method.localeCompare(b.method))).toEqual([
      { method: 'cash', balance: 20000 },
      { method: 'other', balance: 4000 },
      { method: 'wechat', balance: 25000 },
    ]);
    await checks();
  });
});

describe('退房：补齐房费、押金原路退回，房费随手牌结账', () => {
  it('手牌结账前要先退房；退房后押金全部退回、房间待打扫；手牌结账连房费一起结；反结账后客人恢复在店、入住单仍是已退房', async () => {
    const s = await stay((await tile('301')).stay!.id);
    const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${s.visitId}`)).body;
    expect(pre.rooms).toEqual([{ stayId: s.id, tagCode: 'R001', roomNo: '301', stayNo: s.stayNo }]);
    expect((await settle(s.visitId)).body.error.code).toBe('ROOM_OPEN');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${s.visitId}/cancel`, { reason: '开错牌' })).body.error.code).toBe('ROOM_OPEN');
    // 只读核对：今天入住、今天退房，房费已经挂齐
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/rooms/stays/${s.id}/checkout-preview`)).body;
    expect(preview).toMatchObject({ dues: [], dueAmount: 0, billAmount: 38800, depositBalance: 49000 });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/close`, { clientKey: randomUUID(), expectedDue: 100 })).body.error.code).toBe('ROOM_DUE_CHANGED');
    const key = randomUUID();
    const close = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/close`, { clientKey: key, expectedDue: 0 });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(close.body).toMatchObject({ status: 'checked_out', depositBalance: 0 });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/close`, { clientKey: key, expectedDue: 0 })).body.id).toBe(s.id);
    const refunds = (close.body as StayDetail).deposits.filter((d) => d.kind === 'refund' && d.reason === '退房，押金原路退回');
    expect(refunds.map((d) => [d.method, d.amount]).sort()).toEqual([
      ['cash', 20000],
      ['other', 4000],
      ['wechat', 25000],
    ]);
    expect((await tile('301')).status).toBe('dirty');
    // 退房之后：结账核对没有在住的客房，应收里有房费
    const pre2 = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${s.visitId}`)).body;
    expect(pre2.rooms).toEqual([]);
    const ok = await settle(s.visitId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.bills).toEqual([expect.objectContaining({ tagCode: 'R001', amount: ok.body.totalAmount })]);
    expect(ok.body.totalAmount).toBeGreaterThan(38800);
    // 反结账：客人恢复在店（房费留在手牌账单上），入住单仍是已退房；重新结账照常
    const v = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${ok.body.id}/void`, { reason: '收款方式记错' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect((await stay(s.id)).status).toBe('checked_out');
    const visit = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${s.visitId}`)).body as { status: string; lines: { source: string; status: string }[] };
    expect(visit.status).toBe('open');
    expect(visit.lines.filter((l) => l.source === 'room' && l.status === 'active')).toHaveLength(1);
    expect((await settle(s.visitId)).status).toBe(200);
    await checks();
  });
});

describe('夜审与超时加收', () => {
  it('昨天入住：夜审给今晚挂一晚，同一晚不重复挂；18:00 前不能做；第二天 12:00–18:00 退房加收半天', async () => {
    expect((await housekeep('302', 'clean')).status).toBe(200);
    const yesterday = shiftDate(today, -1);
    await guest('R002');
    const s = await checkinRoom(deps(), { clientKey: randomUUID(), roomId: room['302'], expectedRate: 38800, tagCode: 'R002' }, { actor: clerk, at: at(yesterday, 22) });
    expect(s).toMatchObject({ businessDate: yesterday, chargedAmount: 38800 });
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

describe('钟点房、续住、换房、改登记与撤销入住', () => {
  it('钟点房入住挂第一段，续住加一段；全天房续住只改预计离店；换房只能换到空房，原房间待打扫；撤销入住要先在前台作废房费', async () => {
    await guest('R003');
    const s = (await checkin({ roomId: room['8A'], expectedRate: 12800, tagCode: 'R003' })).body as StayDetail;
    expect(s.charges.map((c) => [c.kind, c.blockNo])).toEqual([['block', 1]]);
    const ext = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/extend`, { clientKey: randomUUID(), addBlock: true });
    expect(ext.status, JSON.stringify(ext.body)).toBe(200);
    expect((ext.body as StayDetail).charges.map((c) => c.blockNo)).toEqual([1, 2]);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/extend`, { clientKey: randomUUID(), expectedCheckoutDate: today })).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/rooms/stays/${s.id}`, { guestLabel: '王女士', guests: 2 })).body).toMatchObject({ guestLabel: '王女士', guests: 2 });
    // 撤销入住：房费要先在前台手牌账单上作废
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/cancel`, { reason: '开错房' })).body.error.code).toBe('ROOM_CHARGED');
    for (const c of (await stay(s.id)).charges) {
      expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${c.lineId}/void`, { reason: '开错房' })).status).toBe(200);
    }
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/cancel`, { reason: '开错房' })).status).toBe(200);
    expect((await stay(s.id)).status).toBe('cancelled');
    expect((await tile('8A')).status).toBe('dirty');
    // 全天房：续住只改预计离店；换房
    expect((await housekeep('301', 'clean')).status).toBe(200);
    await guest('R004');
    const d = (await checkin({ roomId: room['301'], expectedRate: 38800, tagCode: 'R004' })).body as StayDetail;
    const tomorrow = shiftDate(today, 1);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${d.id}/extend`, { clientKey: randomUUID(), expectedCheckoutDate: tomorrow })).body.expectedCheckoutDate).toBe(tomorrow);
    expect((await housekeep('303', 'dirty')).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${d.id}/move`, { toRoomId: room['303'], reason: '客人嫌吵' })).body.error.code).toBe('ROOM_NOT_READY');
    expect((await housekeep('303', 'clean')).status).toBe(200);
    const moved = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${d.id}/move`, { toRoomId: room['303'], reason: '客人嫌吵' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ roomNo: '303', rate: 38800, tagCode: 'R004', moves: [expect.objectContaining({ fromRoom: '301', toRoom: '303', reason: '客人嫌吵' })] });
    expect((await tile('301')).status).toBe('dirty');
    expect((await housekeep('303', 'maintenance', '漏水')).body.error.code).toBe('ROOM_IN_USE');
    await checks();
  });
});

describe('交班、日结、对账包与看板', () => {
  type Shift = { summary: { cash: { expected: number; checkout: number; deposit?: number }; deposits?: { received: { method: string; count: number; amount: number }[]; refunded: { method: string; count: number; amount: number }[] } } };
  type Settlement = { deposits: { received: { method: string; amount: number }[]; refunded: { method: string; amount: number }[]; held: number }; checks: { key: string; ok: boolean; label: string; detail: string }[] };
  const sum = (list: { method: string; amount: number }[], method: string) => list.filter((x) => x.method === method).reduce((t, x) => t + x.amount, 0);

  it('现金押金计入交班应有现金（收 − 退）；日结单列押金；对账包第 07 个文件；看板「客房」与部门「客房」', async () => {
    const r = await api(ctx.app, boss, 'POST', '/api/admin/rooms/rooms', { roomNo: '305', floor: '3', roomTypeId: type['豪华单间'] });
    room['305'] = r.body.rooms.find((x: { roomNo: string }) => x.roomNo === '305').id;
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 })).status).toBe(200);
    const shift = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/shifts/current')).body.shift as Shift;
    const settlement = async () => (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body as Settlement;
    const before = await settlement();
    // 收现金押金 500、在住时退 100、退房时余下 400 原路退回：钱箱的押金净额回到 0；房费随手牌结账收现金
    const visitId = await guest('R006');
    const s = (await checkin({ roomId: room['305'], expectedRate: 38800, tagCode: 'R006', deposit: { method: 'cash', amount: 50000 } })).body as StayDetail;
    expect((await shift()).summary.cash.deposit).toBe(50000);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/refunds`, { clientKey: randomUUID(), method: 'cash', amount: 10000, reason: '客人要回一部分' })).status).toBe(200);
    expect((await shift()).summary.cash.deposit).toBe(40000);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.id}/close`, { clientKey: randomUUID(), expectedDue: 0 })).status).toBe(200);
    const paid = await settle(visitId);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const sh = await shift();
    expect(sh.summary.cash.deposit ?? 0).toBe(0);
    expect(sh.summary.deposits!.received).toEqual([{ method: 'cash', count: 1, amount: 50000 }]);
    expect(sh.summary.deposits!.refunded).toEqual([{ method: 'cash', count: 2, amount: 50000 }]);
    expect(sh.summary.cash.checkout).toBe(paid.body.totalAmount);
    expect(sh.summary.cash.expected).toBe(paid.body.totalAmount);
    const after = await settlement();
    expect(sum(after.deposits.received, 'cash') - sum(before.deposits.received, 'cash')).toBe(50000);
    expect(sum(after.deposits.refunded, 'cash') - sum(before.deposits.refunded, 'cash')).toBe(50000);
    expect(after.deposits.held).toBe(before.deposits.held);
    for (const c of after.checks) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    await checks();
    // 对账包：07 客房与押金；结账单里是住客的手牌
    const recon = await buildDailyRecon(ctx.sql, ctx.config, today);
    expect(recon.ok).toBe(true);
    const f07 = recon.files.find((f) => f.name === '07-客房与押金.csv')!.content;
    for (const text of [s.stayNo, 'R006', '入住', '收押金', '退押金', '退房', '当天结束时在住押金余额']) expect(f07).toContain(text);
    expect(f07).not.toContain('押金抵扣');
    expect(recon.files.find((f) => f.name === '02-结账单.csv')!.content).toContain('R006');
    // 看板「客房」：经营总览的岗位看；店员看不到
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/reports/rooms?from=${today}&to=${today}`)).status).toBe(403);
    const rep = await api(ctx.app, boss, 'GET', `/api/reports/rooms?from=${today}&to=${today}`);
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect(rep.body.now.rooms).toBe(5);
    expect(rep.body.deposits).toEqual({ received: expect.any(Number), refunded: expect.any(Number) });
    expect(rep.body.revenue.byKind.map((k: { name: string }) => k.name)).toContain('房费（全天房）');
    expect(rep.body.revenue.total).toBeGreaterThanOrEqual(38800);
    expect(rep.body.days).toHaveLength(1);
    const exec = (await api(ctx.app, boss, 'GET', `/api/reports/executive?from=${today}&to=${today}`)).body as { departments: { category: string; amount: number }[] };
    expect(exec.departments.find((d) => d.category === '客房')!.amount).toBe(rep.body.revenue.total);
  });
});
