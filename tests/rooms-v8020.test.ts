// 8.0.20 客房点餐与会员联动房价（docs/ERP_V8020.md 第 5、6 节，JX-F / JX-G / JX7 / JX8；迁移 139）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BenefitCatalog } from '../src/shared/benefits';
import type { CheckoutPreview } from '../src/shared/checkout';
import { rechargeOutcome, type MemberGradeInfo, type MembershipRules } from '../src/shared/membership';
import type { RoomQuote, StayDetail } from '../src/shared/rooms';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let typeId: number;
const room: Record<string, number> = {};
let dishId: number;
const yuan = (n: number) => Math.round(n * 100);
const off = (base: number, rate: number) => Math.floor((base * (100 - rate) + 50) / 100);

const rules = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
let phoneNo = 0;
/** 新会员充到给定金额（L3 = 3 万、L5 = 10 万） */
const member = async (name: string, paidYuan: number) => {
  phoneNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone: `1994444${String(phoneNo).padStart(4, '0')}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id as number;
  if (paidYuan > 0) {
    const info = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${id}/grade`)).body as MemberGradeInfo;
    const bonus = rechargeOutcome(await rules(), info.state.grade, info.rollingRechargeCents, yuan(paidYuan)).bonusCents;
    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', { idempotencyKey: randomUUID(), memberId: id, planId: null, paidAmount: yuan(paidYuan), bonusAmount: bonus, paymentMethod: 'wechat', paymentConfirmed: true, bonusMode: 'auto' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  }
  return id;
};
let tagNo = 0;
const enter = async (memberId: number | null) => {
  tagNo += 1;
  const tagCode = `H${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', memberId }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const visitId = r.body.visits[0].id as number;
  const [v] = await ctx.sql<{ billId: number }[]>`SELECT bill_id FROM visits WHERE id = ${visitId}`;
  return { visitId, billId: Number(v!.billId), tagCode };
};
const quote = async (roomNo: string, tag = '') => (await api(ctx.app, ctx.clerk, 'GET', `/api/rooms/quote?roomId=${room[roomNo]}&tag=${tag}`)).body as RoomQuote;
const checkin = (roomNo: string, tagCode: string, expectedRate: number) => api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', { clientKey: randomUUID(), roomId: room[roomNo], expectedRate, tagCode, guests: 1 });
const closeStay = async (stayId: number) => {
  const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/rooms/stays/${stayId}/checkout-preview`)).body as { dueAmount: number; depositByMethod: unknown[] };
  const c = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${stayId}/close`, { clientKey: randomUUID(), expectedDue: pre.dueAmount, expectedDeposits: pre.depositByMethod });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
};
const roomLines = (billId: number) => ctx.sql<{ id: number; amount: number }[]>`SELECT id, amount FROM bill_lines WHERE bill_id = ${billId} AND status = 'active' AND source = 'room' ORDER BY id`;
const preview = async (visitId: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body as CheckoutPreview;
const saveType = (body: Record<string, unknown>) => api(ctx.app, ctx.owner, 'PUT', `/api/admin/rooms/types/${typeId}`, { name: '会员价大床房', kind: 'daily', price: 30000, ...body });

beforeAll(async () => {
  ctx = await setup();
  const r = await rules();
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(1000), topUpMinCents: yuan(1000) })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/benefits/import')).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '会员价大床房', kind: 'daily', price: 30000 });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  typeId = t.body.types.find((x: { name: string }) => x.name === '会员价大床房').id;
  for (const roomNo of ['H501', 'H502', 'H503', 'H504', 'H505']) {
    const rm = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo, floor: '5', roomTypeId: typeId });
    expect(rm.status, JSON.stringify(rm.body)).toBe(200);
    room[roomNo] = rm.body.rooms.find((x: { roomNo: string }) => x.roomNo === roomNo).id;
  }
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'H', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  // 餐饮：一个档口、一道菜
  const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '客房送餐' });
  const item = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '客房简餐', category: '热菜', price: 4800 });
  dishId = item.body.items.find((i: { name: string }) => i.name === '客房简餐').id;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: dishId, stationId: st.body.stations.find((s: { name: string }) => s.name === '客房送餐').id }] })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
}, 60_000);
afterAll(async () => ctx.close());

describe('会员联动房价', () => {
  it('房型的会员价：某一档起的价，要低于门市价、同一档只能一个；不传不动、传空清掉；门市价不能降到会员价以下', async () => {
    expect((await saveType({ memberPrices: [{ grade: 3, price: 30000 }] })).status).toBe(400);
    expect((await saveType({ memberPrices: [{ grade: 3, price: 26000 }, { grade: 3, price: 25000 }] })).status).toBe(400);
    expect((await saveType({ memberPrices: [{ grade: 7, price: 100 }] })).status).toBe(400);
    const ok = await saveType({ memberPrices: [{ grade: 5, price: 20000 }, { grade: 3, price: 26000 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const mine = ok.body.types.find((x: { id: number }) => x.id === typeId);
    expect(mine.memberPrices).toEqual([
      { grade: 3, price: 26000 },
      { grade: 5, price: 20000 },
    ]);
    // 不传会员价：原来的不动；但门市价降到会员价以下不行
    expect((await saveType({})).body.types.find((x: { id: number }) => x.id === typeId).memberPrices).toHaveLength(2);
    expect((await saveType({ price: 25000 })).body.error.code).toBe('MEMBER_PRICE_NOT_LOWER');
    // 店员不能改
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/admin/rooms/types/${typeId}`, { name: '会员价大床房', kind: 'daily', price: 30000, memberPrices: [] })).status).toBe(403);
  });

  it('报价：散客与没到那一档的会员是门市价；L3、L4 用 L3 起的价，L5 用 L5 起的价；入住按报价，对不上拒绝并给出现在的价', async () => {
    const guest = await enter(null);
    const l1 = await enter(await member('一档会员', 1000));
    const l3id = await member('三档会员', 30000);
    const l3 = await enter(l3id);
    const l5 = await enter(await member('五档会员', 100000));
    expect(await quote('H501')).toEqual({ listRate: 30000, rate: 30000, memberGrade: null, reason: null });
    expect(await quote('H501', guest.tagCode)).toMatchObject({ rate: 30000, memberGrade: null });
    expect(await quote('H501', l1.tagCode)).toMatchObject({ rate: 30000, memberGrade: null });
    expect(await quote('H501', l3.tagCode)).toEqual({ listRate: 30000, rate: 26000, memberGrade: 3, reason: null });
    expect(await quote('H501', l5.tagCode)).toMatchObject({ rate: 20000, memberGrade: 5 });
    // 按门市价提交：拒绝，告诉现在的价
    const stale = await checkin('H501', l3.tagCode, 30000);
    expect(stale.body.error).toMatchObject({ code: 'PRICE_CHANGED', details: { rate: 26000 } });
    const s = await checkin('H501', l3.tagCode, 26000);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body as StayDetail).toMatchObject({ rate: 26000, listRate: 30000, memberGrade: 3 });
    expect((await roomLines(l3.billId)).map((l) => l.amount)).toEqual([26000]);
    // 散客按门市价入住：不记会员价档
    const g = await checkin('H502', guest.tagCode, 30000);
    expect(g.body).toMatchObject({ rate: 30000, listRate: 30000, memberGrade: null });
    // 散客拿会员价来提交：拒绝
    const g2 = await enter(null);
    expect((await checkin('H503', g2.tagCode, 26000)).body.error).toMatchObject({ code: 'PRICE_CHANGED', details: { rate: 30000 } });
  });

  it('不叠加、取低的：发布了客房折扣以后，折后价更低的不用会员价；已经按会员价入住的房费结账时不再打会员折扣', async () => {
    // 之前按会员价入住的三档会员：现在发布 QY-011（客房房费 L3 7.5 折）
    const catalog = (await api(ctx.app, ctx.owner, 'GET', '/api/benefits')).body as BenefitCatalog;
    const qy = catalog.items.find((b) => b.code === 'QY-011')!;
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/benefits/${qy.id}/status`, { expectedVersion: qy.version, status: 'published' })).status).toBe(200);
    const [stay] = await ctx.sql<{ id: number; visitId: number; billId: number }[]>`SELECT id, visit_id, bill_id FROM room_stays WHERE member_grade = 3 AND status = 'open'`;
    await closeStay(Number(stay!.id));
    const priced = await preview(Number(stay!.visitId));
    // 这位会员账单上只有按会员价的房费（与门票）：没有能打的客房折扣
    expect((priced.memberDiscounts ?? []).filter((d) => d.code === 'QY-011')).toEqual([]);
    // 新来的三档会员：7.5 折后 225.00 比会员价 260.00 低 → 不用会员价，按门市价入住，结账时照常打折
    const l3 = await enter(await member('三档会员乙', 30000));
    const q = await quote('H504', l3.tagCode);
    expect(q).toMatchObject({ listRate: 30000, rate: 30000, memberGrade: null });
    expect(q.reason).toContain('7.5 折');
    const s = await checkin('H504', l3.tagCode, 30000);
    expect(s.body).toMatchObject({ rate: 30000, memberGrade: null });
    await closeStay(s.body.id);
    const base = (await roomLines(l3.billId)).reduce((a, l) => a + l.amount, 0);
    const p = await preview(l3.visitId);
    expect(p.memberDiscounts!.find((d) => d.code === 'QY-011')).toMatchObject({ rate: 75, base, amount: off(base, 75) });
    // 五档会员：5.5 折后 165.00 比 L5 的会员价 200.00 低 → 同样不用会员价
    const l5 = await enter(await member('五档会员乙', 100000));
    expect(await quote('H505', l5.tagCode)).toMatchObject({ rate: 30000, memberGrade: null });
    // 把 L5 的会员价降到 150.00：比折后价低 → 用会员价
    expect((await saveType({ memberPrices: [{ grade: 3, price: 26000 }, { grade: 5, price: 15000 }] })).status).toBe(200);
    expect(await quote('H505', l5.tagCode)).toMatchObject({ rate: 15000, memberGrade: 5 });
    const s5 = await checkin('H505', l5.tagCode, 15000);
    expect(s5.body).toMatchObject({ rate: 15000, listRate: 30000, memberGrade: 5 });
    await closeStay(s5.body.id);
    expect(((await preview(l5.visitId)).memberDiscounts ?? []).filter((d) => d.code === 'QY-011')).toEqual([]);
  });
});

describe('客房点餐', () => {
  it('按房号找到在住的客人；勾了「送到客房」出品单上写房号；没住店的不能送到客房；按手牌找到的也看得到房号', async () => {
    const g = await enter(null);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/rooms/${room['H501']}/housekeeping`, { status: 'clean' })).status).toBe(200);
    const s = await checkin('H501', g.tagCode, 30000);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const byRoom = await api(ctx.app, ctx.clerk, 'GET', '/api/dining/guest?tag=h501');
    expect(byRoom.body).toMatchObject({ visitId: g.visitId, tagCode: g.tagCode, roomNo: 'H501', via: 'room' });
    const byTag = await api(ctx.app, ctx.clerk, 'GET', `/api/dining/guest?tag=${g.tagCode}`);
    expect(byTag.body).toMatchObject({ visitId: g.visitId, roomNo: 'H501', via: 'tag' });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/dining/guest?tag=H999')).status).toBe(404);
    // 送到客房
    const ordered = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId: g.visitId, lines: [{ itemId: dishId, quantity: 2 }], expectedTotal: 9600, toRoom: true });
    expect(ordered.status, JSON.stringify(ordered.body)).toBe(200);
    // 不送到客房（客人在餐厅吃）
    const here = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId: g.visitId, lines: [{ itemId: dishId, quantity: 1 }], expectedTotal: 4800 });
    expect(here.status).toBe(200);
    const tickets = await ctx.sql<{ deliverTo: string; quantity: number }[]>`SELECT deliver_to, quantity FROM kitchen_items WHERE visit_id = ${g.visitId} ORDER BY id`;
    expect(tickets.map((t) => [t.deliverTo, t.quantity])).toEqual([
      ['客房 H501', 2],
      ['', 1],
    ]);
    // 挂在这位客人的手牌账单上，退房后随手牌结账
    const [bill] = await ctx.sql<{ n: number }[]>`SELECT coalesce(sum(amount), 0)::int AS n FROM bill_lines WHERE bill_id = ${g.billId} AND status = 'active' AND source = 'dining'`;
    expect(bill!.n).toBe(14400);
    // 没住店的客人：不能送到客房
    const walkIn = await enter(null);
    const no = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId: walkIn.visitId, lines: [{ itemId: dishId, quantity: 1 }], expectedTotal: 4800, toRoom: true });
    expect(no.body.error.code).toBe('ROOM_NOT_STAYING');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/dining/guest?tag=${walkIn.tagCode}`)).body).toMatchObject({ roomNo: null, via: 'tag' });
    // 同一个操作编号、换了「送到客房」再提交：拒绝（不是同一个请求）
    const key = randomUUID();
    const first = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: key, visitId: g.visitId, lines: [{ itemId: dishId, quantity: 1 }], expectedTotal: 4800, toRoom: true });
    expect(first.status).toBe(200);
    const changed = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: key, visitId: g.visitId, lines: [{ itemId: dishId, quantity: 1 }], expectedTotal: 4800 });
    expect(changed.status).toBe(409);
    // 点单已经生效、回复丢了，之后客人换了房：按原样重提认得出是同一笔（摘要只算「送到客房」，不算房号），
    // 不多挂一道，出品单上还是下单时的房号（合并前 Codex 审查 b850838）
    const rm = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo: 'H506', floor: '5', roomTypeId: typeId });
    const h506 = rm.body.rooms.find((x: { roomNo: string }) => x.roomNo === 'H506').id;
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/rooms/${h506}/housekeeping`, { status: 'clean' })).status).toBe(200);
    const moved = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.body.id}/move`, { toRoomId: h506, reason: '客人嫌吵' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const count = async () => Number((await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM kitchen_items WHERE visit_id = ${g.visitId}`)[0]!.n);
    const before = await count();
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: key, visitId: g.visitId, lines: [{ itemId: dishId, quantity: 1 }], expectedTotal: 4800, toRoom: true });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await count()).toBe(before);
    // 换房以后新下的单写新房号
    const fresh = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/orders', { clientKey: randomUUID(), visitId: g.visitId, lines: [{ itemId: dishId, quantity: 1 }], expectedTotal: 4800, toRoom: true });
    expect(fresh.status).toBe(200);
    const last = await ctx.sql<{ deliverTo: string }[]>`SELECT deliver_to FROM kitchen_items WHERE visit_id = ${g.visitId} ORDER BY id DESC LIMIT 2`;
    expect(last.map((t) => t.deliverTo)).toEqual(['客房 H506', '客房 H501']);
  });
});
