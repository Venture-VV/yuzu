// 小程序第三期 3d：预约技师与派对房（小程序线，docs/MP_PHASE3.md 第 4 节；MP34–MP37；接主线 v0.7.28 的 bookings）：
//   · 设置：默认关着；店主、店总能开、勾可约的项目与房间；「我的」的入口跟着开关；
//   · 预约页：没绑定写原因；能约哪几天、时长、规则；时段只能查勾了的、能约的那几天，技师只给号；
//   · 预约：「待确认」、同一个编号重提返回第一次、每人同时最多 2 个、绑定刚变过拒绝；没勾的拒绝；
//   · 取消：自己的、同一个编号重提返回第一次；别人的拒绝；取消以后又能约；
//   · 确认作废：已经办了回那一张；没办的登记作废，原请求再到也不办；两边同时到只有一个结论；别的微信用不了这个编号；
//   · 到店提醒：门店确认了才排、取消了不发，字段写项目、技师号与几点；预约记录只追加；后台看得到；自检照常全过。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BookingDetail } from '../src/shared/bookings';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpBookingAdminData, type MpBookingHome, type MpBookingSlot, type MpBookingView } from '../src/shared/mp';
import type { Deps } from '../src/server/lib/context';
import { bookingChecks } from '../src/server/modules/bookings';
import { buildMpApp } from '../src/server/modules/mp/app';
import { leaseReminders, planReminders } from '../src/server/modules/mp/reminders';
import { consistencyChecks } from '../src/server/ops/consistency';
import { api, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
let ctx: TestContext;
let deps: Deps;
let mp: FastifyInstance;
let tomorrow: string;
const tech: Record<string, number> = {};
let itemId = 0;
let otherItemId = 0;
let spaceId = 0;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay: null, sweepMs: 0 });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
  const me = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body;
  tomorrow = new Date(Date.parse(`${me.today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  // 两个需要技师的项目（一个勾、一个不勾）与两位技师
  const ids: Record<string, number> = {};
  for (const name of ['合成足疗', '合成采耳']) {
    const it = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category: '足疗', price: 16800, durationMinutes: 60 });
    expect(it.status, JSON.stringify(it.body)).toBe(200);
    ids[name] = it.body.items.find((i: { name: string }) => i.name === name).id;
  }
  itemId = ids['合成足疗']!;
  otherItemId = ids['合成采耳']!;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/items', { items: [{ id: itemId, required: true }, { id: otherItemId, required: true }] })).status).toBe(200);
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
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});

const call = (method: 'GET' | 'POST', url: string, openid: string, payload?: unknown) =>
  Promise.resolve(mp.inject({ method, url, headers: { [MP_GATEWAY_HEADER]: KEY, [MP_OPENID_HEADER]: openid }, ...(payload === undefined ? {} : { payload: payload as object }) }));
const versionOf = async (openid: string) => (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
let n = 0;
async function member(name: string, bind = true): Promise<{ id: number; phone: string; openid: string }> {
  n += 1;
  const phone = `1366600${String(1000 + n)}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const openid = `openid-booking-${n}-${randomUUID().slice(0, 8)}`;
  if (bind) {
    const b = await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: await versionOf(openid), mock: true });
    expect(b.statusCode, b.body).toBe(200);
  }
  return { id: r.body.id as number, phone, openid };
}
const home = async (openid: string) => {
  const r = await call('GET', '/api/mp/bookings', openid);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as MpBookingHome;
};
const slots = async (openid: string, q: Record<string, string | number>) =>
  call('GET', `/api/mp/bookings/slots?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`, openid);
const techSlots = async (openid: string, date = tomorrow) => {
  const r = await slots(openid, { kind: 'technician', date, itemId });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as MpBookingSlot[];
};
const book = async (openid: string, body: Record<string, unknown>, clientKey = randomUUID(), bindVersion?: number) =>
  call('POST', '/api/mp/bookings', openid, { clientKey, ...body, bindVersion: bindVersion ?? (await versionOf(openid)) });
const cancel = async (openid: string, id: number, clientKey = randomUUID(), bindVersion?: number) =>
  call('POST', `/api/mp/bookings/${id}/cancel`, openid, { clientKey, bindVersion: bindVersion ?? (await versionOf(openid)) });
const abandon = (openid: string, clientKey: string) => call('POST', '/api/mp/bookings/abandon', openid, { clientKey });
const adminData = async () => {
  const r = await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp/bookings');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as MpBookingAdminData;
};
const saveRules = async (enabled: boolean, itemIds: number[], spaceIds: number[]) => {
  const { rules } = await adminData();
  return api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/bookings/rules', { enabled, itemIds, spaceIds, version: rules.version });
};
const allChecksOk = async () => {
  for (const c of await consistencyChecks(ctx.sql, ctx.config.timezone)) {
    if (c.label.includes('自动任务')) continue;
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
  expect((await bookingChecks(ctx.sql)).ok).toBe(true);
};
/** 每次用一个没约过的时段（同一个技师项目、明天；项目 60 分钟，隔两格就不重叠） */
let slotNo = 2;
const nextSlot = async (openid: string) => {
  slotNo += 2;
  const s = (await techSlots(openid))[slotNo];
  expect(s, '明天的时段不够用').toBeTruthy();
  return s!;
};

describe('小程序预约', () => {
  it('默认关着：写没开放、约不了；「我的」没有入口；没有权限的岗位看不了、改不了后台；开了以后版本号对不上拒绝', async () => {
    const a = await member('演示·预约关着');
    const h = await home(a.openid);
    expect(h).toMatchObject({ open: false, canBook: false, notice: '小程序预约还没开放，请打电话给门店', items: [], spaces: [] });
    const r = await book(a.openid, { kind: 'technician', itemId, startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect([r.statusCode, r.json().error.code]).toEqual([403, 'MP_BOOKING_DISABLED']);
    expect((await slots(a.openid, { kind: 'technician', date: tomorrow, itemId })).statusCode).toBe(403);
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.bookingOpen).toBe(false);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/mp/bookings')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'PUT', '/api/admin/mp/bookings/rules', { enabled: true, itemIds: [], spaceIds: [] })).status).toBe(403);
    // 开了但一个都没勾：照样没开放
    expect((await saveRules(true, [], [])).status).toBe(200);
    expect((await home(a.openid)).open).toBe(false);
    expect((await saveRules(true, [itemId, itemId], [spaceId])).status).toBe(200);
    expect((await call('GET', '/api/mp/me', a.openid)).json().member.bookingOpen).toBe(true);
    const stale = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/bookings/rules', { enabled: true, itemIds: [], spaceIds: [], version: 0 });
    expect(stale.status).toBe(409);
    const d = await adminData();
    expect(d.rules).toMatchObject({ enabled: true, itemIds: [itemId], spaceIds: [spaceId] });
    expect(d.items.map((x) => [x.name, x.minutes, x.open])).toEqual([
      ['合成足疗', 60, true],
      ['合成采耳', 60, false],
    ]);
    expect(d.spaces).toEqual([{ id: spaceId, name: '合成派对房', code: 'X501', open: true }]);
    expect(d.bookingRules).toMatchObject({ openTime: '11:00', closeTime: '02:00', slotMinutes: 30, maxDaysAhead: 7, mpMaxOpen: 2 });
  });

  it('预约页：没绑定写原因；能约哪几天、时长、规则；时段只能查勾了的、能约的那几天，技师只给号', async () => {
    const stranger = `openid-booking-stranger-${randomUUID().slice(0, 8)}`;
    expect(await home(stranger)).toMatchObject({ open: true, bound: false, canBook: false, notice: '绑定会员后才能预约：请到「我的」绑定，或打电话给门店', bookings: [] });
    const a = await member('演示·预约页');
    const h = await home(a.openid);
    expect(h).toMatchObject({
      open: true,
      bound: true,
      canBook: true,
      notice: null,
      bookNotice: null,
      items: [{ id: itemId, name: '合成足疗', minutes: 60 }],
      spaces: [{ id: spaceId, name: '合成派对房' }],
      durations: [120, 180, 240],
      rules: { maxOpen: 2, cancelLeadMinutes: 120, confirmLeadMinutes: 60, noShowMinutes: 30 },
      bookings: [],
    });
    expect(h.dates).toHaveLength(8);
    expect(h.dates[1]).toBe(tomorrow);
    const s = await techSlots(a.openid);
    expect(s.length).toBeGreaterThan(10);
    expect(s[0]).toMatchObject({ free: 2 });
    expect(s[0]!.technicians.map((t) => t.techNo).sort()).toEqual(['B1', 'B2']);
    expect(JSON.stringify(s)).not.toContain('甲');
    const sp = await slots(a.openid, { kind: 'space', date: tomorrow, spaceId, durationMinutes: 180 });
    expect(sp.statusCode, sp.body).toBe(200);
    expect((sp.json() as MpBookingSlot[])[0]).toMatchObject({ free: 1, technicians: [] });
    // 没勾的项目、不能约的日子、不对的时长
    expect((await slots(a.openid, { kind: 'technician', date: tomorrow, itemId: otherItemId })).json().error.code).toBe('BOOKING_NOT_OPEN');
    expect((await slots(a.openid, { kind: 'technician', date: '2099-01-01', itemId })).json().error.code).toBe('BOOKING_RANGE');
    expect((await slots(a.openid, { kind: 'space', date: tomorrow, spaceId, durationMinutes: 90 })).json().error.code).toBe('BOOKING_DURATION');
  });

  it('预约：「待确认」、技师只写号；同一个编号重提返回第一次；每人同时最多 2 个；取消以后又能约；后台看得到', async () => {
    const a = await member('演示·小程序预约');
    const slot = await nextSlot(a.openid);
    const key = randomUUID();
    const r = await book(a.openid, { kind: 'technician', itemId, technicianId: tech.B1, startsAt: slot.startsAt, note: '要力道轻一点' }, key);
    expect(r.statusCode, r.body).toBe(201);
    const b = (r.json() as { booking: MpBookingView }).booking;
    expect(b).toMatchObject({ kind: 'technician', status: 'pending', title: '合成足疗 · B1 号技师', startsAt: slot.startsAt, guests: 1, cancellable: true });
    const again = await book(a.openid, { kind: 'technician', itemId, technicianId: tech.B1, startsAt: slot.startsAt, note: '要力道轻一点' }, key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, booking: { id: b.id, status: 'pending' } });
    // 前台看板上是小程序来的、待确认的
    const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/${b.id}`)).body as BookingDetail;
    expect(detail).toMatchObject({ source: 'mp', status: 'pending', memberId: a.id, note: '要力道轻一点' });
    // 派对房：3 小时
    const sp = (await slots(a.openid, { kind: 'space', date: tomorrow, spaceId, durationMinutes: 180 })).json() as MpBookingSlot[];
    const party = await book(a.openid, { kind: 'space', spaceId, durationMinutes: 180, startsAt: sp[2]!.startsAt, guests: 8 });
    expect(party.statusCode, party.body).toBe(201);
    const pb = (party.json() as { booking: MpBookingView }).booking;
    expect(pb).toMatchObject({ kind: 'space', title: '合成派对房', guests: 8 });
    expect(Date.parse(pb.endsAt) - Date.parse(pb.startsAt)).toBe(180 * 60_000);
    // 第三个：同时最多 2 个
    const h = await home(a.openid);
    expect(h).toMatchObject({ canBook: false });
    expect(h.bookNotice).toMatch(/同时最多 2 个/);
    expect(h.bookings.map((x) => x.id).sort()).toEqual([b.id, pb.id].sort());
    const third = await book(a.openid, { kind: 'technician', itemId, technicianId: null, startsAt: (await nextSlot(a.openid)).startsAt });
    expect([third.statusCode, third.json().error.code]).toEqual([422, 'BOOKING_LIMIT']);
    // 自己取消派对房：同一个编号重提返回第一次
    const ck = randomUUID();
    const c = await cancel(a.openid, pb.id, ck);
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ replayed: false, booking: { id: pb.id, status: 'cancelled', cancellable: false, cancelReason: '顾客在小程序取消' } });
    expect((await cancel(a.openid, pb.id, ck)).json()).toMatchObject({ replayed: true, booking: { status: 'cancelled' } });
    // 再取消一次（新的编号）：已经取消了
    expect((await cancel(a.openid, pb.id)).json().error.code).toBe('BOOKING_CLOSED');
    expect((await home(a.openid)).canBook).toBe(true);
    // 后台：小程序来的待确认 1 张；最近的预约、取消
    const d = await adminData();
    expect(d.pending).toBeGreaterThanOrEqual(1);
    expect(d.recent.slice(0, 3).map((x) => [x.action, x.memberName, x.title, x.status])).toEqual([
      ['cancel', '演示·小程序预约', '合成派对房', 'cancelled'],
      ['create', '演示·小程序预约', '合成派对房', 'cancelled'],
      ['create', '演示·小程序预约', '合成足疗 · B1 号技师', 'pending'],
    ]);
    // 预约记录只追加
    await expect(ctx.sql`UPDATE mp_booking_ops SET action = 'cancel' WHERE client_key = ${key}`).rejects.toThrow(/只追加/);
    await expect(ctx.sql`DELETE FROM mp_booking_ops WHERE client_key = ${key}`).rejects.toThrow(/只追加/);
    await allChecksOk();
  });

  it('拒绝：没勾的项目、绑定刚变过、别人的预约、没绑定，什么都不留', async () => {
    const a = await member('演示·预约拒绝');
    const slot = await nextSlot(a.openid);
    const r1 = await book(a.openid, { kind: 'technician', itemId: otherItemId, startsAt: slot.startsAt });
    expect([r1.statusCode, r1.json().error.code]).toEqual([422, 'BOOKING_NOT_OPEN']);
    const v = await versionOf(a.openid);
    const r2 = await book(a.openid, { kind: 'technician', itemId, startsAt: slot.startsAt }, randomUUID(), v + 1);
    expect([r2.statusCode, r2.json().error.code]).toEqual([409, 'BIND_STALE']);
    const stranger = `openid-booking-nobody-${randomUUID().slice(0, 8)}`;
    const r3 = await book(stranger, { kind: 'technician', itemId, startsAt: slot.startsAt }, randomUUID(), 0);
    expect([r3.statusCode, r3.json().error.code]).toEqual([403, 'MP_NOT_BOUND']);
    expect((await ctx.sql`SELECT 1 FROM bookings WHERE member_id = ${a.id}`).length).toBe(0);
    // 别人的预约不能取消
    const b = await member('演示·别人');
    const mine = await book(b.openid, { kind: 'technician', itemId, technicianId: null, startsAt: slot.startsAt });
    expect(mine.statusCode, mine.body).toBe(201);
    const r4 = await cancel(a.openid, (mine.json() as { booking: MpBookingView }).booking.id);
    expect([r4.statusCode, r4.json().error.code]).toEqual([422, 'BOOKING_NOT_YOURS']);
    expect((await cancel(a.openid, 99_999_999)).statusCode).toBe(404);
  });

  it('确认作废：已经办了回那一张；没办的登记作废，原请求再到也不办；别的微信用不了这个编号；同时到只有一个结论', async () => {
    const a = await member('演示·预约作废');
    const slot = await nextSlot(a.openid);
    const done = randomUUID();
    expect((await book(a.openid, { kind: 'technician', itemId, technicianId: null, startsAt: slot.startsAt }, done)).statusCode).toBe(201);
    const ab1 = await abandon(a.openid, done);
    expect(ab1.json()).toMatchObject({ status: 'done', action: 'create', booking: { status: 'pending' } });
    const lost = randomUUID();
    expect((await abandon(a.openid, lost)).json()).toEqual({ status: 'abandoned' });
    expect((await abandon(a.openid, lost)).json()).toEqual({ status: 'abandoned' });
    const late = await book(a.openid, { kind: 'technician', itemId, technicianId: null, startsAt: (await nextSlot(a.openid)).startsAt }, lost);
    expect([late.statusCode, late.json().error.code]).toEqual([409, 'OP_ABANDONED']);
    // 取消的编号也一样
    const id = (ab1.json() as { booking: MpBookingView }).booking.id;
    const lostCancel = randomUUID();
    expect((await abandon(a.openid, lostCancel)).json()).toEqual({ status: 'abandoned' });
    expect((await cancel(a.openid, id, lostCancel)).json().error.code).toBe('OP_ABANDONED');
    expect((await home(a.openid)).bookings.find((x) => x.id === id)!.status).toBe('pending');
    // 别的微信
    const b = await member('演示·预约别的微信');
    expect((await abandon(b.openid, done)).json().error.code).toBe('CLIENT_KEY_REUSED');
    expect((await abandon(b.openid, lost)).json().error.code).toBe('CLIENT_KEY_REUSED');
    expect((await book(b.openid, { kind: 'technician', itemId, technicianId: null, startsAt: slot.startsAt }, done)).json().error.code).toBe('CLIENT_KEY_REUSED');
    // 同时到：预约与确认作废只有一个结论
    const c = await member('演示·预约并发');
    const version = await versionOf(c.openid);
    for (let i = 0; i < 3; i++) {
      const k = randomUUID();
      const s = await nextSlot(c.openid);
      const [o, ab] = await Promise.all([book(c.openid, { kind: 'technician', itemId, technicianId: null, startsAt: s.startsAt }, k, version), abandon(c.openid, k)]);
      const verdict = ab.json() as { status: string };
      if (verdict.status === 'done') expect(o.statusCode).toBe(201);
      else expect([o.statusCode, o.json().error.code]).toEqual([409, 'OP_ABANDONED']);
      expect((await ctx.sql`SELECT 1 FROM mp_booking_ops WHERE client_key = ${k}`).length).toBe(verdict.status === 'done' ? 1 : 0);
      // 留着的取消掉，下一轮还能约（每人同时 2 个）
      if (verdict.status === 'done') expect((await cancel(c.openid, (o.json() as { booking: MpBookingView }).booking.id)).statusCode).toBe(200);
    }
    await allChecksOk();
  });

  it('到店提醒：门店确认了才排、字段写项目、技师号与几点；取消了的不发', async () => {
    const tpl = 'tplBookingArrive-0123456789';
    const rr = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/mp/reminders')).body.rules as { version: number };
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/admin/mp/reminders/rules', {
      enabled: true,
      coupon: null,
      membership: null,
      bonus: null,
      booking: {
        templateId: tpl,
        fields: [
          { key: 'thing1', source: 'name' },
          { key: 'time2', source: 'date' },
          { key: 'thing3', source: 'tip' },
        ],
      },
      version: rr.version,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const a = await member('演示·到店提醒');
    const slot = await nextSlot(a.openid);
    const made = await book(a.openid, { kind: 'technician', itemId, technicianId: tech.B2, startsAt: slot.startsAt });
    expect(made.statusCode, made.body).toBe(201);
    const bookingId = (made.json() as { booking: MpBookingView }).booking.id;
    const opts = (await call('GET', '/api/mp/reminders', a.openid)).json();
    expect(opts.templates.booking).toBe(tpl);
    const consent = await call('POST', '/api/mp/reminders', a.openid, { clientKey: randomUUID(), kind: 'booking', bookingId, templateId: tpl, bindVersion: await versionOf(a.openid) });
    expect(consent.statusCode, consent.body).toBe(201);
    expect(consent.json()).toMatchObject({ kind: 'booking', targetDate: tomorrow, dueDate: tomorrow });
    // 第二张预约（不指定技师），提醒以后取消
    const slot2 = await nextSlot(a.openid);
    const made2 = await book(a.openid, { kind: 'technician', itemId, technicianId: null, startsAt: slot2.startsAt });
    const id2 = (made2.json() as { booking: MpBookingView }).booking.id;
    expect((await call('POST', '/api/mp/reminders', a.openid, { clientKey: randomUUID(), kind: 'booking', bookingId: id2, templateId: tpl, bindVersion: await versionOf(a.openid) })).statusCode).toBe(201);
    // 别人的预约不能设
    const b = await member('演示·别人的提醒');
    const other = await call('POST', '/api/mp/reminders', b.openid, { clientKey: randomUUID(), kind: 'booking', bookingId, templateId: tpl, bindVersion: await versionOf(b.openid) });
    expect(other.statusCode).toBe(404);
    // 明天 10:30：还待确认的先等（不排）
    const at = new Date(`${tomorrow}T10:30:00+08:00`);
    await planReminders(deps, at);
    const msgOf = async (id: number) =>
      (await ctx.sql<{ status: string; data: Record<string, { value: string }> | null; reason: string | null }[]>`
        SELECT m.status, m.data, m.reason FROM mp_reminder_messages m JOIN mp_reminder_consents c ON c.id = m.consent_id WHERE c.booking_id = ${id}`)[0] ?? null;
    expect(await msgOf(bookingId)).toBeNull();
    // 门店确认第一张、取消第二张
    const d1 = (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/${bookingId}`)).body as BookingDetail;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/bookings/${bookingId}/change`, { clientKey: randomUUID(), action: 'confirm', expectedVersion: d1.version })).status).toBe(200);
    expect((await cancel(a.openid, id2)).statusCode).toBe(200);
    await planReminders(deps, at);
    const m1 = (await msgOf(bookingId))!;
    expect(m1.status).toBe('queued');
    const hhmm = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(slot.startsAt));
    const [y, mo, dd] = tomorrow.split('-');
    expect(m1.data).toEqual({
      thing1: { value: '合成足疗 · B2 号技师' },
      time2: { value: `${y}年${Number(mo)}月${Number(dd)}日 ${hhmm}` },
      thing3: { value: '请准时到店，到前台报手机号' },
    });
    expect(await msgOf(id2)).toMatchObject({ status: 'skipped', reason: '预约已经取消' });
    const lease = await leaseReminders(deps, {}, at);
    expect(lease.messages.find((x) => x.templateId === tpl)).toMatchObject({ page: 'pages/bookings/index' });
  });
});
