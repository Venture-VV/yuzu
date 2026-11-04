// v0.7.28 ③（docs/SCHEDULE_FINISH.md 第 4 节，N4；小程序第三期 3d，MP34–MP37；客房电话预订，Q17）：预约——
//   · 可约时段：技师按在职、能做这个项目、不和已有的预约重叠；「不指定」按空着的技师数；派对房按预约与开着的使用单；客房按房型的房间数；
//   · 前台、电话新建直接「已预约」，同一编号重提返回原来那张；时段冲突拒绝（BOOKING_TAKEN）；
//   · 确认、改时间（带版本号）、取消、爽约、到店（派对房直接开使用单；手牌不在店拒绝）；「结果待确认」能按编号查回；
//   · 小程序：「待确认」、要对齐时段、每人同时最多 2 个、爽约 3 次后限制、开始前 2 小时以内不能自己取消、claimKey 去重；
//   · 每分钟的自动处理：没确认的自动取消、过时间没到店的记爽约、客房过了保留时间记爽约；自检。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BookingBoard, BookingDetail, BookingSlot } from '../src/shared/bookings';
import type { Deps } from '../src/server/lib/context';
import { bookingChecks, cancelBookingFromMp, createBookingFromMp, memberBookings, monthDayTime, mpBookingBan, sweepBookings, type MpBookingInput } from '../src/server/modules/bookings';
import { signInAll } from '../src/server/modules/clockroom';
import { postCharges } from '../src/server/modules/frontdesk/bills';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let deps: Deps;
let tomorrow: string;
const tech: Record<string, number> = {};
let itemId = 0;
let spaceId = 0;
let roomTypeId = 0;

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error('应该拒绝');
};
const slots = async (q: Record<string, string | number>) =>
  (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/slots?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`)).body as BookingSlot[];
const create = (body: Record<string, unknown>, clientKey = randomUUID()) => api(ctx.app, ctx.clerk, 'POST', '/api/bookings', { clientKey, guestName: '电话客人', guestPhone: '13900000001', ...body });
const change = (id: number, body: Record<string, unknown>, clientKey = randomUUID()) => api(ctx.app, ctx.clerk, 'POST', `/api/bookings/${id}/change`, { clientKey, ...body });
const board = async (date = tomorrow) => (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings?date=${date}`)).body as BookingBoard;
let phoneNo = 0;
const member = async (name: string) => {
  phoneNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone: `1996666${String(phoneNo).padStart(4, '0')}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as number;
};
const mp = (input: MpBookingInput) => ctx.sql.begin((tx) => createBookingFromMp(tx, deps, input));
let tagNo = 0;
const checkIn = async () => {
  tagNo += 1;
  const code = `Y${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return code;
};

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  const me = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body;
  tomorrow = new Date(Date.parse(`${me.today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  // 需要技师的项目（60 分钟）与三位技师
  const it = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '合成足疗', category: '足疗', price: 16800, durationMinutes: 60 });
  expect(it.status, JSON.stringify(it.body)).toBe(200);
  itemId = it.body.items.find((i: { name: string }) => i.name === '合成足疗').id;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/items', { items: [{ id: itemId, required: true }] })).status).toBe(200);
  for (const [techNo, name] of [
    ['B1', '甲'],
    ['B2', '乙'],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo, name, gender: 'female', grade: 'standard' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  for (const t of (await api(ctx.app, ctx.owner, 'GET', '/api/admin/technicians')).body.technicians as { id: number; techNo: string }[]) tech[t.techNo] = t.id;
  // 派对房（开单即占用）
  const csv = (rows: string[]) => rows.join('\r\n');
  for (const [kind, rows] of [
    ['zones', ['楼层,区域名(中文),区域名(英文),备注', 'L2,合成娱乐区,Sample Fun,合成样例']],
    ['spaces', ['楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注', 'L2,X,X501,派对房,12,合成派对房,,合成派对房 X501,']],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv: csv([...rows]), encoding: 'UTF-8', clientKey: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  spaceId = ((await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body.spaces as { id: number; code: string }[]).find((s) => s.code === 'X501')!.id;
  // 客房：一个房型、两间房
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
  const rt = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '合成大床房', kind: 'daily', price: 26800 });
  expect(rt.status, JSON.stringify(rt.body)).toBe(200);
  roomTypeId = rt.body.types.find((t: { name: string }) => t.name === '合成大床房').id;
  for (const roomNo of ['Y801', 'Y802']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo, floor: '8', roomTypeId, sortOrder: 0, active: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'Y', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('可约时段与前台新建', () => {
  let first: BookingDetail;

  it('技师：半小时一格；指定了技师的占掉那一位；「不指定」按空着的技师数；冲突拒绝', async () => {
    const s = await slots({ kind: 'technician', date: tomorrow, itemId });
    expect(s.length).toBeGreaterThan(10);
    expect(s[0]).toMatchObject({ free: 2 });
    expect(Date.parse(s[1]!.startsAt) - Date.parse(s[0]!.startsAt)).toBe(30 * 60_000);
    const at = s[4]!.startsAt;
    const r = await create({ kind: 'technician', itemId, technicianId: tech.B1, startsAt: at });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    first = r.body as BookingDetail;
    expect(first).toMatchObject({ status: 'confirmed', source: 'front', technicianText: 'B1 号 甲', itemName: '合成足疗' });
    expect(Date.parse(first.endsAt) - Date.parse(first.startsAt)).toBe(60 * 60_000);
    const after = await slots({ kind: 'technician', date: tomorrow, itemId });
    expect(after.find((x) => x.startsAt === at)).toMatchObject({ free: 1, technicianIds: [tech.B2] });
    expect((await create({ kind: 'technician', itemId, technicianId: tech.B1, startsAt: at })).body.error.code).toBe('BOOKING_TAKEN');
    // 不指定：还剩一位，约一个；再约就满了
    expect((await create({ kind: 'technician', itemId, technicianId: null, startsAt: at })).status).toBe(200);
    expect((await create({ kind: 'technician', itemId, technicianId: null, startsAt: at })).body.error.code).toBe('BOOKING_TAKEN');
    expect((await slots({ kind: 'technician', date: tomorrow, itemId })).find((x) => x.startsAt === at)!.free).toBe(0);
    // 同一个编号重提返回原来那张
    const key = randomUUID();
    const once = await create({ kind: 'technician', itemId, technicianId: tech.B2, startsAt: s[8]!.startsAt }, key);
    const twice = await create({ kind: 'technician', itemId, technicianId: tech.B2, startsAt: s[8]!.startsAt }, key);
    expect(twice.body.id).toBe(once.body.id);
    const lookup = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=booking_create`);
    expect(lookup.body).toMatchObject({ found: true, type: 'booking_create', booking: { id: once.body.id } });
    expect((await bookingChecks(ctx.sql)).ok).toBe(true);
  });

  it('派对房：按时长；已有预约的时段不能再约；客房：按房型的房间数', async () => {
    const s = await slots({ kind: 'space', date: tomorrow, spaceId, durationMinutes: 120 });
    const r = await create({ kind: 'space', spaceId, startsAt: s[2]!.startsAt, durationMinutes: 120, guests: 8 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ kind: 'space', spaceCode: 'X501', guests: 8 });
    expect((await slots({ kind: 'space', date: tomorrow, spaceId, durationMinutes: 120 })).filter((x) => x.free === 0).length).toBeGreaterThan(0);
    expect((await create({ kind: 'space', spaceId, startsAt: s[3]!.startsAt, durationMinutes: 120 })).body.error.code).toBe('BOOKING_TAKEN');
    const room = await slots({ kind: 'room', date: tomorrow, roomTypeId });
    expect(room[0]!.free).toBe(2);
    for (let i = 0; i < 2; i += 1) expect((await create({ kind: 'room', roomTypeId, startsAt: room[0]!.startsAt })).status).toBe(200);
    expect((await create({ kind: 'room', roomTypeId, startsAt: room[0]!.startsAt })).body.error.code).toBe('BOOKING_FULL');
    const b = await board();
    expect(b.bookings.filter((x) => x.kind === 'room')[0]).toMatchObject({ roomTypeName: '合成大床房', status: 'confirmed' });
    expect(b.bookings.filter((x) => x.kind === 'room')[0]!.holdUntil).toBeTruthy();
  });

  it('改时间带版本号；取消；记爽约；到店：派对房开使用单，手牌不在店拒绝', async () => {
    const s = await slots({ kind: 'technician', date: tomorrow, itemId });
    const stale = first.version;
    const moved = await change(first.id, { action: 'reschedule', expectedVersion: stale, startsAt: s[12]!.startsAt });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ startsAt: s[12]!.startsAt, version: stale + 1 });
    expect((await change(first.id, { action: 'reschedule', expectedVersion: stale, startsAt: s[14]!.startsAt })).body.error.code).toBe('BOOKING_CHANGED');
    expect((await change(first.id, { action: 'cancel', reason: '客人改天' })).body).toMatchObject({ status: 'cancelled', cancelReason: '客人改天' });
    expect((await change(first.id, { action: 'cancel', reason: '再取消' })).body.error.code).toBe('BOOKING_CLOSED');
    const party = (await board()).bookings.find((x) => x.kind === 'space')!;
    expect((await change(party.id, { action: 'arrive', tagCode: 'Y099' })).body.error.code).toBe('TAG_NOT_IN_STORE');
    const tag = await checkIn();
    const arrived = await change(party.id, { action: 'arrive', tagCode: tag });
    expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
    expect(arrived.body).toMatchObject({ status: 'arrived', arrivalTagCode: tag });
    expect(arrived.body.arrivalRef).toMatch(/^SY/);
    const usage = (await api(ctx.app, ctx.clerk, 'GET', `/api/usages?date=${(await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.today}`)).body as { usageNo: string; note: string; guests: number }[];
    expect(usage.find((u) => u.usageNo === arrived.body.arrivalRef)).toMatchObject({ note: `预约 ${party.bookingNo}`, guests: 8 });
    const ns = (await board()).bookings.find((x) => x.kind === 'room' && x.status === 'confirmed')!;
    expect((await change(ns.id, { action: 'no_show' })).body.status).toBe('no_show');
    expect((await bookingChecks(ctx.sql)).ok).toBe(true);
  });
});

describe('小程序（3d）', () => {
  it('「待确认」、对齐时段、claimKey 去重；每人同时最多 2 个；前台确认；开始前 2 小时以内不能自己取消、只能取消自己的', async () => {
    const m = await member('小程序预约会员');
    const s = await slots({ kind: 'technician', date: tomorrow, itemId });
    const free = s.filter((x) => x.free > 0);
    const a = await mp({ memberId: m, kind: 'technician', itemId, technicianId: null, startsAt: free[0]!.startsAt, claimKey: 'b-1' });
    expect(a).toMatchObject({ replayed: false, booking: { status: 'pending', source: 'mp', memberId: m } });
    expect((await mp({ memberId: m, kind: 'technician', itemId, technicianId: null, startsAt: free[0]!.startsAt, claimKey: 'b-1' })).replayed).toBe(true);
    // 不对齐时段
    const off = new Date(Date.parse(free[1]!.startsAt) + 10 * 60_000).toISOString();
    expect((await errorOf(mp({ memberId: m, kind: 'technician', itemId, startsAt: off, claimKey: 'b-off' }))).code).toBe('BOOKING_TIME');
    await mp({ memberId: m, kind: 'technician', itemId, startsAt: free[2]!.startsAt, claimKey: 'b-2' });
    expect((await errorOf(mp({ memberId: m, kind: 'technician', itemId, startsAt: free[3]!.startsAt, claimKey: 'b-3' }))).code).toBe('BOOKING_LIMIT');
    // 前台确认
    const conf = await change(a.booking.id, { action: 'confirm', expectedVersion: a.booking.version });
    expect(conf.body.status).toBe('confirmed');
    // 自己取消：别人的不行；明天的可以
    const other = await member('另一位会员');
    expect((await errorOf(ctx.sql.begin((tx) => cancelBookingFromMp(tx, deps, { memberId: other, bookingId: a.booking.id, claimKey: 'c-x' })))).code).toBe('BOOKING_NOT_YOURS');
    const c = await ctx.sql.begin((tx) => cancelBookingFromMp(tx, deps, { memberId: m, bookingId: a.booking.id, claimKey: 'c-1' }));
    expect(c.booking).toMatchObject({ status: 'cancelled', cancelReason: '顾客在小程序取消' });
    // 开始前 2 小时以内：用「此刻」接近开始来合成
    const late = (await memberBookings(ctx.sql, m)).find((x) => x.status === 'pending')!;
    const near = new Date(Date.parse(late.startsAt) - 30 * 60_000);
    expect((await errorOf(ctx.sql.begin((tx) => cancelBookingFromMp(tx, deps, { memberId: m, bookingId: late.id, claimKey: 'c-2', at: near })))).code).toBe('BOOKING_TOO_LATE');
    expect((await memberBookings(ctx.sql, m, near)).find((x) => x.id === late.id)!.cancellable).toBe(false);
  });

  it('爽约 3 次后 30 天内不能在小程序预约（MP37）', async () => {
    const m = await member('常爽约会员');
    for (let i = 0; i < 3; i += 1) {
      const s = (await slots({ kind: 'space', date: tomorrow, spaceId, durationMinutes: 120 })).filter((x) => x.free > 0);
      const b = await mp({ memberId: m, kind: 'space', spaceId, startsAt: s[s.length - 1 - i]!.startsAt, durationMinutes: 120, claimKey: `ns-${i}` });
      expect((await change(b.booking.id, { action: 'no_show' })).body.status).toBe('no_show');
    }
    expect(await mpBookingBan(ctx.sql, m)).toMatchObject({ banned: true, noShows: 3 });
    const s = (await slots({ kind: 'technician', date: tomorrow, itemId })).filter((x) => x.free > 0);
    expect((await errorOf(mp({ memberId: m, kind: 'technician', itemId, startsAt: s[0]!.startsAt, claimKey: 'ns-x' }))).code).toBe('BOOKING_BANNED');
  });

  it('爽约限制的提示按门店时间写到哪天几点：北京时间 0–8 点记的爽约不会早一天（小程序线 #55 的独立审查）', async () => {
    expect(monthDayTime(new Date('2026-12-03T18:30:00Z'), 'Asia/Shanghai')).toBe('12月4日 02:30');
    expect(monthDayTime(new Date('2026-12-03T16:00:00Z'), 'Asia/Shanghai')).toBe('12月4日 00:00');
    const m = await member('凌晨爽约会员');
    for (let i = 0; i < 3; i += 1) {
      const s = (await slots({ kind: 'space', date: tomorrow, spaceId, durationMinutes: 120 })).filter((x) => x.free > 0);
      const b = await mp({ memberId: m, kind: 'space', spaceId, startsAt: s[s.length - 1 - i]!.startsAt, durationMinutes: 120, claimKey: `early-ns-${i}` });
      expect((await change(b.booking.id, { action: 'no_show' })).body.status).toBe('no_show');
    }
    // 三次爽约都挪到北京时间 11-04 02:30（UTC 还是 11-03）：限制到 30 天后的北京时间 12-04 02:30，UTC 是 12-03
    await ctx.sql`UPDATE bookings SET no_show_at = ${new Date('2026-11-03T18:30:00Z')} WHERE member_id = ${m}`;
    const s = (await slots({ kind: 'space', date: tomorrow, spaceId, durationMinutes: 120 })).filter((x) => x.free > 0);
    const refused = await errorOf(mp({ memberId: m, kind: 'space', spaceId, startsAt: s[0]!.startsAt, durationMinutes: 120, claimKey: 'early-x', at: new Date('2026-11-04T18:30:00Z') }));
    expect(refused.code).toBe('BOOKING_BANNED');
    expect(refused.message).toContain('12月4日 02:30 以后才能在小程序预约');
  });

  it('开始前「自动取消的提前分钟」（默认 60）以内的时段不收（BOOKING_TOO_SOON），免得约上马上被自动取消；早一点的照常「待确认」', async () => {
    const day = new Date(Date.parse(`${tomorrow}T12:00:00Z`) + 4 * 86_400_000).toISOString().slice(0, 10);
    const m = await member('临时约的会员');
    const s = (await slots({ kind: 'technician', date: day, itemId })).filter((x) => x.free > 0);
    const start = Date.parse(s[2]!.startsAt);
    const soon = await errorOf(mp({ memberId: m, kind: 'technician', itemId, startsAt: s[2]!.startsAt, claimKey: 'soon-1', at: new Date(start - 30 * 60_000) }));
    expect(soon.code).toBe('BOOKING_TOO_SOON');
    const ok = await mp({ memberId: m, kind: 'technician', itemId, startsAt: s[2]!.startsAt, claimKey: 'soon-2', at: new Date(start - 3 * 3_600_000) });
    expect(ok.booking).toMatchObject({ status: 'pending', source: 'mp' });
  });

  it('「我的预约」带指定技师的工号 techNo（不指定的为 null；小程序线 2026-11-04 要的）', async () => {
    // 用三天以后的一天，不占别的用例要用的明天、后天
    const day = new Date(Date.parse(`${tomorrow}T12:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
    const m = await member('看工号的会员');
    const s = (await slots({ kind: 'technician', date: day, itemId })).filter((x) => x.technicianIds?.includes(tech['B2']!));
    const named = await mp({ memberId: m, kind: 'technician', itemId, technicianId: tech['B2']!, startsAt: s[0]!.startsAt, claimKey: 'tn-1' });
    const any = await mp({ memberId: m, kind: 'technician', itemId, technicianId: null, startsAt: s[4]!.startsAt, claimKey: 'tn-2' });
    const mine = await memberBookings(ctx.sql, m);
    expect(mine.find((x) => x.id === named.booking.id)).toMatchObject({ techNo: 'B2', technicianText: 'B2 号 乙' });
    expect(mine.find((x) => x.id === any.booking.id)).toMatchObject({ techNo: null, technicianText: '不指定' });
    // 前台看板、单张预约的形状不变（不带 techNo）
    expect(named.booking).not.toHaveProperty('techNo');
    expect((await board(day)).bookings.find((x) => x.id === named.booking.id)).not.toHaveProperty('techNo');
  });
});

describe('每分钟的自动处理', () => {
  it('小程序预约开始前 60 分钟还没确认的自动取消；过了开始时间 30 分钟没到店的记爽约；客房过了保留时间记爽约', async () => {
    const m = await member('自动处理会员');
    const s = (await slots({ kind: 'space', date: tomorrow, spaceId, durationMinutes: 120 })).filter((x) => x.free > 0);
    const pending = await mp({ memberId: m, kind: 'space', spaceId, startsAt: s[0]!.startsAt, durationMinutes: 120, claimKey: 'auto-1' });
    const front = await create({ kind: 'technician', itemId, technicianId: tech.B2, startsAt: (await slots({ kind: 'technician', date: tomorrow, itemId })).filter((x) => x.free > 0).at(-1)!.startsAt });
    expect(front.status, JSON.stringify(front.body)).toBe(200);
    // 小程序那张开始前 50 分钟：自动取消；前台那张还没到时间：不动
    const r1 = await sweepBookings(ctx.sql, new Date(Date.parse(pending.booking.startsAt) - 50 * 60_000));
    expect(r1.cancelled).toBeGreaterThanOrEqual(1);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/${pending.booking.id}`)).body).toMatchObject({ status: 'cancelled' });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/${front.body.id}`)).body.status).toBe('confirmed');
    // 前台那张过了开始 31 分钟：记爽约；客房过了保留时间的也记
    const r2 = await sweepBookings(ctx.sql, new Date(Date.parse(front.body.startsAt) + 31 * 60_000));
    expect(r2.noShow).toBeGreaterThanOrEqual(1);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/${front.body.id}`)).body.status).toBe('no_show');
    const rooms = (await board()).bookings.filter((x) => x.kind === 'room');
    expect(rooms.every((x) => x.status !== 'confirmed')).toBe(true);
    expect((await bookingChecks(ctx.sql)).ok).toBe(true);
  });

  it('停机后才跑：没确认的小程序预约过了开始时间也是自动取消，不记顾客爽约；刚改到以后的不动', async () => {
    const m = await member('停机会员');
    const s = (await slots({ kind: 'technician', date: tomorrow, itemId })).filter((x) => x.free > 0);
    const late = await mp({ memberId: m, kind: 'technician', itemId, startsAt: s[0]!.startsAt, claimKey: 'down-1' });
    const r = await sweepBookings(ctx.sql, new Date(Date.parse(late.booking.startsAt) + 45 * 60_000));
    expect(r.cancelled).toBeGreaterThanOrEqual(1);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/${late.booking.id}`)).body).toMatchObject({ status: 'cancelled' });
    expect((await mpBookingBan(ctx.sql, m)).noShows).toBe(0);
  });

  it('权限：没有「预约」权限的岗位看不到', async () => {
    const { createStaff } = await import('../src/server/modules/staff');
    const { login, PASSWORD } = await import('./helpers');
    await createStaff(ctx.sql, { username: 'bo', displayName: '后勤', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
    const bo = await login(ctx.app, 'bo');
    expect((await api(ctx.app, bo, 'GET', `/api/bookings?date=${tomorrow}`)).status).toBe(403);
  });
});

describe('前台派钟、加钟与技师预约不重叠（测试会话 ded1958 的 P2）', () => {
  it('这位技师有预约的时段派钟、加钟拒绝（TECHNICIAN_BOOKED）；别的技师、预约之后、约了这位技师的会员本人不拦；到店之后不再占时段', async () => {
    const owner = { id: ctx.ownerId, username: 'owner', displayName: '测试店主', role: 'owner' as const, duties: [], mustChangePassword: false };
    // 后天北京 13:00（05:00Z）乙有 60 分钟的预约；钟房按那一天上牌
    const day = new Date(Date.parse(`${tomorrow}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const startsAt = `${day}T05:00:00.000Z`;
    const booked = await create({ kind: 'technician', itemId, technicianId: tech['B2'], startsAt });
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);
    // 派钟要先开技师功能（预约本身不要）
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
    await signInAll(deps, { actor: owner, at: new Date(`${day}T02:00:00Z`) });
    const visitOf = async (memberId?: number) => {
      tagNo += 1;
      const code = `Y${String(tagNo).padStart(3, '0')}`;
      const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male', ...(memberId ? { memberId } : {}) }] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.visits[0].id as number;
    };
    const dispatchAt = (visitId: number, technicianId: number, at: string, quantity = 1) =>
      postCharges(
        deps,
        visitId,
        { clientKey: randomUUID(), lines: [{ itemId, quantity, tier: 'standard', technicianId, callType: 'designated' }], expectedTotal: 16800 * quantity },
        { actor: owner, at: new Date(at) },
        { session: { dispatch: { startNow: true } } },
      );
    // 04:30 派乙 60 分钟：和 05:00 的预约重叠，拒绝，什么都不写
    const v1 = await visitOf();
    const refused = await errorOf(dispatchAt(v1, tech['B2']!, `${day}T04:30:00Z`));
    expect(refused).toMatchObject({ code: 'TECHNICIAN_BOOKED' });
    expect(refused.message).toContain(booked.body.bookingNo);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM technician_sessions WHERE visit_id = ${v1}`;
    expect(n!.n).toBe(0);
    // 别的技师照常；03:00 派乙到 04:00 不重叠；加钟到 05:00 不重叠，再加一钟到 06:00 和预约重叠，拒绝
    await dispatchAt(v1, tech['B1']!, `${day}T04:30:00Z`);
    const v2 = await visitOf();
    await dispatchAt(v2, tech['B2']!, `${day}T03:00:00Z`);
    const [s] = await ctx.sql<{ id: number }[]>`SELECT id FROM technician_sessions WHERE visit_id = ${v2}`;
    const extend = (at: string) =>
      postCharges(
        deps,
        v2,
        { clientKey: randomUUID(), lines: [{ itemId, quantity: 1, tier: 'standard', technicianId: tech['B2']!, callType: 'designated' }], expectedTotal: 16800 },
        { actor: owner, at: new Date(at) },
        { session: { extendId: Number(s!.id) } },
      );
    await extend(`${day}T03:50:00Z`);
    expect(await errorOf(extend(`${day}T04:50:00Z`))).toMatchObject({ code: 'TECHNICIAN_BOOKED' });
    // 约了乙的会员本人：派给乙不拦
    const m = await member('约乙的会员');
    const mine = await create({ kind: 'technician', itemId, technicianId: tech['B2'], startsAt: `${day}T07:00:00.000Z`, memberId: m });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const v3 = await visitOf(m);
    await dispatchAt(v3, tech['B2']!, `${day}T06:45:00Z`);
    // 到店之后预约不再占时段：05:00 那张点到店以后，别的客人这时派给乙不再因为它拒绝
    const v4 = await visitOf();
    const [t4] = await ctx.sql<{ code: string }[]>`SELECT h.code FROM visits v JOIN hand_tags h ON h.id = v.tag_id WHERE v.id = ${v4}`;
    const arrived = await change(booked.body.id, { action: 'arrive', tagCode: t4!.code });
    expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
    await dispatchAt(v4, tech['B2']!, `${day}T04:58:00Z`);
    const [n4] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM technician_sessions WHERE visit_id = ${v4}`;
    expect(n4!.n).toBe(1);
  });
});

describe('后台「预约」规则（N4）', () => {
  it('店主改规则：校验、合并保存；规则总表显示改过；店员只能看', async () => {
    const before = (await api(ctx.app, ctx.clerk, 'GET', '/api/admin/booking-rules')).body;
    expect(before).toMatchObject({ openTime: '11:00', closeTime: '02:00', slotMinutes: 30 });
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/booking-rules', before)).status).toBe(403);
    const bad = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/booking-rules', { ...before, slotMinutes: 20 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('15 / 30 / 60');
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/booking-rules', { ...before, spaceDurations: [240, 120, 120], noShowBanDays: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ spaceDurations: [120, 240], noShowBanDays: 0 });
    const rules = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rules')).body as { key: string; isDefault: boolean; section: string; value: string; updatedBy: string | null }[];
    expect(rules.find((r) => r.key === 'booking_rules.window')).toMatchObject({ section: 'bookings', isDefault: true });
    expect(rules.find((r) => r.key === 'booking_rules.noShow')).toMatchObject({ isDefault: false, updatedBy: '测试店主' });
    expect(rules.find((r) => r.key === 'booking_rules.lengths')!.value).toContain('派对房等可约 2 小时、4 小时');
    const o = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/overview')).body;
    expect(o.recentChanges[0]).toMatchObject({ summary: '修改了预约规则' });
    // 改回默认，免得影响别的用例
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/booking-rules', before)).status).toBe(200);
  });
});
