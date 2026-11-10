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

  it('客房预约到店了没入住、客人离店（手牌撤销）以后不再占房型名额（Codex 审查 fb67dca）', async () => {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '预约标准间', kind: 'daily', price: 28800 })).status).toBeLessThan(300);
    const typeId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM room_types WHERE name = '预约标准间'`)[0]!.id);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo: '802', floor: '8', roomTypeId: typeId })).status).toBeLessThan(300);
    const today = (await api(ctx.app, ctx.clerk, 'GET', '/api/business-day')).body.today as string;
    const free = async () =>
      ((await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/slots?kind=room&date=${today}&roomTypeId=${typeId}`)).body as { free: number }[])[0]?.free ?? 0;
    expect(await free()).toBe(1);
    const v = await enter();
    const tag = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body.tag.code as string;
    await arrive(await insertBooking({ kind: 'room', roomTypeId: typeId }), tag);
    // 到店了、还在店里：照样占着
    expect(await free()).toBe(0);
    // 客人没入住就走了：作废门票、撤销来访以后不再占
    const lines = (await api(ctx.app, ctx.owner, 'GET', `/api/frontdesk/visits/${v}`)).body.lines as { id: number; status: string }[];
    for (const l of lines.filter((x) => x.status === 'active')) {
      expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${l.id}/void`, { reason: '客人没入住走了' })).status).toBe(200);
    }
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/visits/${v}/cancel`, { reason: '客人没入住走了' })).status).toBe(200);
    expect(await free()).toBe(1);
  });
});

describe('派对房、宠物轰趴房（A03）', () => {
  const sid: Record<string, number> = {};
  let feeItem: number;
  let openItem: number;
  beforeAll(async () => {
    const zones = ['楼层,区域名(中文),区域名(英文),备注', 'L3,合成派对区,Sample Party,合成样例'].join('\r\n');
    const spaces = [
      '楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注',
      'L3,P,P301,派对房,12,合成派对房,,合成派对房 P301,',
      'L3,P,P302,宠物轰趴房,10,合成宠物轰趴房,,合成宠物轰趴房 P302,',
      'L3,P,P303,娱乐室,6,合成娱乐室,,合成娱乐室 P303,',
    ].join('\r\n');
    for (const [kind, csv] of [
      ['zones', zones],
      ['spaces', spaces],
    ] as const) {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv, encoding: 'UTF-8', clientKey: randomUUID() });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    for (const s of (await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body.spaces as { id: number; code: string }[]) sid[s.code] = s.id;
    // 一个计费项目给两种房共用（店里常这么设）：账单名称、部门仍按房间分开
    const add = async (name: string, price: number) => {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category: '包房', price });
      return r.body.items.find((i: { name: string }) => i.name === name).id as number;
    };
    feeItem = await add('包房房费', 20000);
    openItem = await add('包房开台费', 10000);
    const p = { feeItemId: feeItem, minMinutes: 60, stepMinutes: 30, openFeeItemId: openItem };
    const r = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/usage-rules', { businessTypes: ['派对房', '宠物轰趴房', '娱乐室'], pricing: { 派对房: p, 宠物轰趴房: p } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('看板列出各业态的房间（不需要底图），没设计费的标出来；结束后账单名称带房型和房间，结账后部门按业态', async () => {
    const board = (await api(ctx.app, ctx.clerk, 'GET', '/api/usages/board')).body as {
      businessTypes: string[];
      spaces: { code: string; businessType: string; priced: boolean; usage: { id: number; usageNo: string } | null }[];
    };
    expect(board.spaces.map((s) => [s.code, s.businessType, s.priced, s.usage])).toEqual([
      ['P301', '派对房', true, null],
      ['P302', '宠物轰趴房', true, null],
      ['P303', '娱乐室', false, null],
    ]);
    const v = await enter();
    const tag = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body.tag.code as string;
    const open = await api(ctx.app, ctx.clerk, 'POST', '/api/usages', { clientKey: randomUUID(), spaceId: sid['P302'], tagCode: tag, guests: 5 });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(((await api(ctx.app, ctx.clerk, 'GET', '/api/usages/board')).body.spaces as { code: string; usage: { id: number } | null }[]).find((s) => s.code === 'P302')!.usage).toMatchObject({ id: open.body.id });
    // 用了 70 分钟：起步 60 + 1 个 30 分钟 → 3 × ¥100
    const { endUsage } = await import('../src/server/modules/usages');
    await endUsage({ sql: ctx.sql, config: ctx.config }, open.body.id, { clientKey: randomUUID() }, {
      actor: { id: ctx.clerkId, username: 'clerk', displayName: '店员', role: 'clerk', duties: [], mustChangePassword: false },
      at: new Date(new Date(open.body.openedAt).getTime() + 70 * 60_000),
    });
    const lines = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body.lines as { name: string; quantity: number; amount: number }[];
    expect(lines.map((l) => [l.name, l.quantity, l.amount])).toEqual([
      ['宠物轰趴房 P302 房费（每 30 分钟）', 3, 30000],
      ['宠物轰趴房 P302 开台费', 1, 10000],
    ]);
    const c = await pay(v);
    const dept = await ctx.sql<{ category: string; name: string; amount: number }[]>`
      SELECT category, name, amount FROM checkout_items WHERE checkout_id = ${c.id} AND category <> '门票' ORDER BY name`;
    expect(dept).toEqual([
      { category: '宠物轰趴房', name: '开台费', amount: 10000 },
      { category: '宠物轰趴房', name: '房费', amount: 30000 },
    ]);
  });
});
