// 8.0.8 前台整改 · 收银（A02）：结账记录的合计与日结同一个口径、没开班时收的结账单列；当前营业日接口。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let tagNo = 0;
let item: number;

const enter = async () => {
  tagNo += 1;
  const code = `S${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] });
  expect(r.status).toBe(201);
  return r.body.visits[0].id as number;
};
const charge = async (visitId: number, quantity: number) =>
  expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines: [{ itemId: item, quantity }], expectedTotal: 5000 * quantity })).status).toBe(200);
const pay = async (visitId: number) => {
  const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: preview.totalAmount,
    payments: preview.totalAmount > 0 ? [{ method: 'cash', amount: preview.totalAmount }] : [],
  });
  expect(r.status).toBe(200);
  return r.body as { id: number; totalAmount: number };
};

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'S', from: 1, to: 30, width: 3, zone: 'male' })).status).toBe(200);
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '搓背', category: '洗浴', price: 5000 });
  expect(r.status).toBe(200);
  item = r.body.items.find((i: { name: string }) => i.name === '搓背').id;
});
afterAll(async () => ctx.close());

describe('结账记录的合计（A02）', () => {
  it('与日结的营业额同一个口径；没开班时收的结账单列；当前营业日接口', async () => {
    const day = (await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body as { today: string; calendarToday: string };
    expect(day.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.today).toBe(day.today);

    const empty = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts/summary?date=${day.today}`)).body;
    expect(empty).toMatchObject({ businessDate: day.today, checkouts: { count: 0, total: 0 }, net: 0, unshifted: { count: 0, total: 0 } });

    // 没开班收的一笔
    const v1 = await enter();
    await charge(v1, 2);
    const c1 = await pay(v1);
    // 开班后再收一笔
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 })).status).toBeLessThan(300);
    const v2 = await enter();
    await charge(v2, 1);
    const c2 = await pay(v2);

    const sum = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts/summary?date=${day.today}`)).body;
    const settlement = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${day.today}`)).body;
    expect(sum.checkouts).toEqual({ count: 2, total: c1.totalAmount + c2.totalAmount });
    expect(sum.net).toBe(settlement.business.net);
    expect(sum.unshifted).toEqual({ count: 1, total: c1.totalAmount });
    // 逐笔相加与合计一致
    const rows = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts?date=${day.today}`)).body as { totalAmount: number }[];
    expect(rows.reduce((n, r) => n + r.totalAmount, 0)).toBe(sum.checkouts.total);
    // 没有前台权限的看不到
    const noRead = await api(ctx.app, '', 'GET', `/api/frontdesk/checkouts/summary?date=${day.today}`);
    expect(noRead.status).toBeGreaterThanOrEqual(401);
  });
});

describe('预约到店一键派钟、入住（A04）', () => {
  let foot808: number;
  let techId: number;
  let roomTypeId: number;
  let roomId: number;
  let staffId: number;
  const insertBooking = async (b: { kind: 'technician' | 'room'; itemId?: number; technicianId?: number | null; roomTypeId?: number }) => {
    const today = (await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body.today as string;
    const [row] = await ctx.sql<{ id: number }[]>`
      INSERT INTO bookings (booking_no, kind, source, status, guest_name, guests, item_id, technician_id, room_type_id, starts_at, ends_at, hold_until,
                            business_date, created_by, client_key, request_hash, confirmed_by, confirmed_at)
      VALUES (${`YY${randomUUID().slice(0, 8)}`}, ${b.kind}, 'phone', 'confirmed', '电话客人', 2, ${b.itemId ?? null}, ${b.technicianId ?? null}, ${b.roomTypeId ?? null},
              now(), now() + interval '1 hour', ${b.kind === 'room' ? ctx.sql`now() + interval '2 hours'` : null}, ${today}, ${staffId}, ${randomUUID()}, ${'0'.repeat(64)}, ${staffId}, now())
      RETURNING id`;
    return Number(row!.id);
  };
  const arrive = async (id: number, tagCode: string) => {
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/bookings/${id}/change`, { clientKey: randomUUID(), action: 'arrive', tagCode });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { service: unknown; arrivalTagCode: string };
  };
  const booking = async (id: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/${id}`)).body as { service: { kind: string; no: string } | null; memberOpenTag: string | null };

  beforeAll(async () => {
    staffId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM staff ORDER BY id LIMIT 1`)[0]!.id);
    const it = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '预约足疗', category: '足疗', price: 16800, durationMinutes: 60, technicianRequired: true });
    foot808 = it.body.items.find((i: { name: string }) => i.name === '预约足疗').id;
    const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: '31', name: '预约技师', gender: 'female', grade: 'standard' });
    techId = t.body.technicians.find((x: { techNo: string }) => x.techNo === '31').id;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${techId}/state`, { action: 'sign_in' })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
    const rt = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '预约大床房', kind: 'daily', price: 38800 });
    roomTypeId = rt.body.types?.find?.((x: { name: string }) => x.name === '预约大床房')?.id ?? rt.body.id;
    if (!roomTypeId) roomTypeId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM room_types WHERE name = '预约大床房'`)[0]!.id);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo: '801', floor: '8', roomTypeId })).status).toBeLessThan(300);
    roomId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM rooms WHERE room_no = '801'`)[0]!.id);
  });

  it('技师预约：到店后按预约派钟，钟单记预约；同一张预约不能再派；取消了能再派', async () => {
    const v = await enter();
    const tag = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body.tag.code as string;
    const id = await insertBooking({ kind: 'technician', itemId: foot808, technicianId: techId });
    // 没到店不能按预约派
    const early = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', { clientKey: randomUUID(), visitId: v, itemId: foot808, quantity: 1, technicianId: techId, callType: 'designated', startNow: true, bookingId: id, expectedTotal: 16800 });
    expect(early.body.error.code).toBe('BOOKING_NOT_ARRIVED');
    expect((await arrive(id, tag)).service).toBeNull();
    const d = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', { clientKey: randomUUID(), visitId: v, itemId: foot808, quantity: 1, technicianId: techId, callType: 'designated', startNow: true, bookingId: id, expectedTotal: 16800 });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const linked = await booking(id);
    expect(linked.service).toMatchObject({ kind: 'session' });
    // 同一张预约再派：拒绝
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', { clientKey: randomUUID(), visitId: v, itemId: foot808, quantity: 1, technicianId: techId, callType: 'designated', startNow: false, bookingId: id, expectedTotal: 16800 });
    expect(again.body.error.code).toBe('BOOKING_DISPATCHED');
    // 退钟以后能再派
    const sid = ((await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom')).body.sessions as { id: number; visitId: number }[]).find((s) => s.visitId === v)!.id;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/clockroom/sessions/${sid}/void`, { reason: '客人要换项目' })).status).toBe(200);
    expect((await booking(id)).service).toBeNull();
    const re = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', { clientKey: randomUUID(), visitId: v, itemId: foot808, quantity: 1, technicianId: techId, callType: 'designated', startNow: true, bookingId: id, expectedTotal: 16800 });
    expect(re.status).toBe(200);
    // 别的手牌不能用这张预约
    const v2 = await enter();
    const wrong = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', { clientKey: randomUUID(), visitId: v2, itemId: foot808, quantity: 1, technicianId: techId, callType: 'designated', startNow: false, bookingId: id, expectedTotal: 16800 });
    expect(wrong.body.error.code).toBe('BOOKING_VISIT_MISMATCH');
  });

  it('客房预约：到店后入住记到预约（没带编号的自动记上）；同一张预约不能再入住；已到店没入住的占着房型名额', async () => {
    const v = await enter();
    const tag = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body.tag.code as string;
    const id = await insertBooking({ kind: 'room', roomTypeId });
    await arrive(id, tag);
    const today = (await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body.today as string;
    // 已到店、还没入住：照样占着名额（这个房型只有一间）
    const slots = (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/slots?kind=room&date=${today}&roomTypeId=${roomTypeId}`)).body as { free: number }[];
    expect(slots[0]?.free ?? 0).toBe(0);
    // 不带预约编号入住：自动记到这张预约
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', { clientKey: randomUUID(), roomId, tagCode: tag, guests: 2, expectedRate: 38800 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await booking(id)).service).toMatchObject({ kind: 'stay', no: r.body.stayNo });
    const dup = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', { clientKey: randomUUID(), roomId, tagCode: tag, guests: 2, expectedRate: 38800, bookingId: id });
    expect(dup.status).toBe(409);
  });
});
