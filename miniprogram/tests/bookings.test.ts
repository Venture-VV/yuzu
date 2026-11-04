// 预约（第三期 3d）：日子、时段、「我的预约」的字；预约与取消的「结果待确认」（存不了不发；明确的结果删记录；结果不确定时请门店系统
// 确认作废，已经办了就回那一张；连作废都发不出去时保留；还有上一次没确认的先确认那一次、这一次不办；请求还在发时不去作废它）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MpBookingView } from '../../src/shared/mp';

type Reply = { status: number; data: unknown } | 'fail';
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
  return import('../src/utils/bookings');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = '3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f';
// 2026-11-06（周五）北京时间 14:00–15:00
const BOOKING: MpBookingView = {
  id: 7,
  bookingNo: 'YY20261106-0003',
  kind: 'technician',
  status: 'pending',
  title: '合成足疗 · B1 号技师',
  startsAt: '2026-11-06T06:00:00.000Z',
  endsAt: '2026-11-06T07:00:00.000Z',
  guests: 1,
  cancelReason: null,
  cancellable: true,
};
const BODY = { kind: 'technician' as const, itemId: 3, technicianId: null, startsAt: BOOKING.startsAt, guests: 1, note: '', bindVersion: 2 };

describe('预约页与「我的预约」的字', () => {
  it('日子写今天、明天、月/日与周几；时段写钟点与空几位；一张预约写日子、钟点、状态、人数与取消的原因', async () => {
    installWx({});
    const b = await load();
    // 北京时间 11-04 14:00
    expect(b.dayChips(['2026-11-04', '2026-11-05', '2026-11-06'], Date.parse('2026-11-04T06:00:00Z'))).toEqual([
      { date: '2026-11-04', label: '今天', sub: '周三' },
      { date: '2026-11-05', label: '明天', sub: '周四' },
      { date: '2026-11-06', label: '11/6', sub: '周五' },
    ]);
    // 北京时间 11-05 02:00，营业日还是 11-04：按日历写，营业日 11-05 是「今天」（独立审查 3d 的 P3）
    expect(b.dayChips(['2026-11-04', '2026-11-05', '2026-11-06'], Date.parse('2026-11-04T18:00:00Z')).map((d) => d.label)).toEqual(['11/4', '今天', '明天']);
    // 过了半夜的时段：格子写「次日」，确认时写日历上的那一天
    expect(b.slotViews('technician', [{ startsAt: '2026-11-06T16:30:00.000Z', endsAt: '2026-11-06T17:30:00.000Z', free: 1, technicians: [] }], '2026-11-06')[0]).toEqual({
      startsAt: '2026-11-06T16:30:00.000Z',
      time: '00:30',
      full: false,
      text: '次日 · 空 1 位',
    });
    expect(b.slotWhen('2026-11-06T16:30:00.000Z')).toBe('11月7日 周六 00:30');
    expect(b.doneTitle('pending')).toBe('提交好了，等门店确认');
    expect(b.doneTitle('cancelled')).toBe('这张预约已经取消了');
    expect(b.dateText('2026-11-08')).toBe('11月8日 周日');
    expect(
      b.slotViews('technician', [
        { startsAt: '2026-11-06T06:00:00.000Z', endsAt: '2026-11-06T07:00:00.000Z', free: 2, technicians: [] },
        { startsAt: '2026-11-06T06:30:00.000Z', endsAt: '2026-11-06T07:30:00.000Z', free: 0, technicians: [] },
      ]),
    ).toEqual([
      { startsAt: '2026-11-06T06:00:00.000Z', time: '14:00', full: false, text: '空 2 位' },
      { startsAt: '2026-11-06T06:30:00.000Z', time: '14:30', full: true, text: '约满' },
    ]);
    expect(b.slotViews('space', [{ startsAt: '2026-11-06T06:00:00.000Z', endsAt: '2026-11-06T09:00:00.000Z', free: 1, technicians: [] }])[0]!.text).toBe('可约');
    expect(b.durationText(180)).toBe('3 小时');
    expect(b.durationText(90)).toBe('90 分钟');
    expect(b.bookingItemView(BOOKING)).toEqual({
      id: 7,
      bookingNo: 'YY20261106-0003',
      title: '合成足疗 · B1 号技师',
      status: 'pending',
      statusText: '待门店确认',
      when: '11月6日 周五 14:00–15:00',
      guests: '',
      open: true,
      cancellable: true,
      reason: '',
    });
    expect(b.bookingItemView({ ...BOOKING, kind: 'space', guests: 8, status: 'cancelled', cancelReason: '开始前 60 分钟还没确认，自动取消', cancellable: false })).toMatchObject({
      statusText: '已取消',
      guests: '8 位',
      open: false,
      reason: '开始前 60 分钟还没确认，自动取消',
    });
  });
});

describe('预约与取消的「结果待确认」', () => {
  it('存不了不发；约上了删记录；门店系统明确拒绝删记录、把原因给顾客看；取消也一样', async () => {
    const w0 = installWx({ 'POST /v1/bookings': { status: 201, data: { booking: BOOKING, replayed: false } } }, { storageBroken: 'tq_booking_pending' });
    const b0 = await load();
    expect(await b0.sendBooking(BODY, KEY)).toMatchObject({ kind: 'rejected', code: 'PENDING_STORE_FAILED' });
    expect(w0.sent).toEqual([]);
    const w = installWx({ 'POST /v1/bookings': { status: 201, data: { booking: BOOKING, replayed: false } } });
    const b = await load();
    expect(await b.sendBooking(BODY, KEY)).toEqual({ kind: 'done', action: 'create', booking: BOOKING });
    expect(w.sent).toEqual([{ path: 'POST /v1/bookings', data: { clientKey: KEY, ...BODY } }]);
    expect(w.storage.tq_booking_pending).toBeUndefined();
    const w2 = installWx({ 'POST /v1/bookings': { status: 409, data: { error: { code: 'BOOKING_TAKEN', message: '这个时段能做「合成足疗」的技师都约满了，请换一个时段' } } } });
    const b2 = await load();
    expect(await b2.sendBooking(BODY, KEY)).toEqual({ kind: 'rejected', code: 'BOOKING_TAKEN', message: '这个时段能做「合成足疗」的技师都约满了，请换一个时段' });
    expect(w2.storage.tq_booking_pending).toBeUndefined();
    const cancelled = { ...BOOKING, status: 'cancelled', cancellable: false, cancelReason: '顾客在小程序取消' };
    const w3 = installWx({ 'POST /v1/bookings/7/cancel': { status: 200, data: { booking: cancelled, replayed: false } } });
    const b3 = await load();
    expect(await b3.sendCancel(7, 2, KEY)).toEqual({ kind: 'done', action: 'cancel', booking: cancelled });
    expect(w3.sent).toEqual([{ path: 'POST /v1/bookings/7/cancel', data: { clientKey: KEY, bindVersion: 2 } }]);
    const w4 = installWx({ 'POST /v1/bookings/7/cancel': { status: 422, data: { error: { code: 'BOOKING_TOO_LATE', message: '开始前 2 小时以内不能在小程序取消，请打电话给门店' } } } });
    const b4 = await load();
    expect(await b4.sendCancel(7, 2, KEY)).toMatchObject({ kind: 'rejected', code: 'BOOKING_TOO_LATE' });
    expect(w4.storage.tq_booking_pending).toBeUndefined();
  });

  it('结果不确定：马上请门店系统确认作废——已经约上了回那一张；连作废都发不出去时保留；之后点的先确认上一次、这一次不办', async () => {
    let abandon: Reply = { status: 200, data: { status: 'done', action: 'create', booking: BOOKING } };
    const w = installWx({ 'POST /v1/bookings': 'fail', 'POST /v1/bookings/abandon': () => abandon });
    const b = await load();
    expect(await b.sendBooking(BODY, KEY)).toEqual({ kind: 'done', action: 'create', booking: BOOKING });
    expect(w.storage.tq_booking_pending).toBeUndefined();
    abandon = 'fail';
    expect(await b.sendBooking(BODY, KEY)).toMatchObject({ kind: 'pending', action: 'create' });
    expect(w.storage.tq_booking_pending).toMatchObject({ clientKey: KEY, action: 'create' });
    const before = w.sent.length;
    abandon = { status: 200, data: { status: 'abandoned' } };
    expect(await b.sendCancel(7, 2, 'b0b0b0b0-9b8a-4c7d-8e6f-5a4b3c2d1e0f')).toEqual({ kind: 'earlier', message: '上一次的预约没有办成；这一次还没办，请再点一次' });
    expect(w.sent.slice(before).map((s) => s.path)).toEqual(['POST /v1/bookings/abandon']);
    expect(w.storage.tq_booking_pending).toBeUndefined();
    // 上一次其实约上了：告诉顾客，这一次不办
    const w2 = installWx({ 'POST /v1/bookings/abandon': { status: 200, data: { status: 'done', action: 'create', booking: BOOKING } } }, { storage: { tq_booking_pending: { clientKey: KEY, action: 'create', at: 1 } } });
    const b2 = await load();
    expect(await b2.sendBooking(BODY, 'c0c0c0c0-9b8a-4c7d-8e6f-5a4b3c2d1e0f')).toEqual({
      kind: 'earlier',
      message: '上一次的预约已经办好了（合成足疗 · B1 号技师，待门店确认）；这一次还没办，看一下「我的预约」，要的话再点一次',
    });
    expect(w2.sent.map((s) => s.path)).toEqual(['POST /v1/bookings/abandon']);
  });

  it('请求还在发：确认作废不发，等它回来；手机上的记录读不出来、认不出来：不发', async () => {
    let release: () => void = () => undefined;
    const w = installWx({ 'POST /v1/bookings': { hold: { status: 201, data: { booking: BOOKING, replayed: false } }, onHold: (go) => (release = go) } });
    const b = await load();
    const p = b.sendBooking(BODY, KEY);
    await new Promise((ok) => setTimeout(ok, 5));
    expect(await b.resolveBookingPending()).toMatchObject({ kind: 'pending', action: 'create', flying: true });
    expect(w.sent.map((s) => s.path)).toEqual(['POST /v1/bookings']);
    release();
    expect(await p).toEqual({ kind: 'done', action: 'create', booking: BOOKING });
    expect(w.storage.tq_booking_pending).toBeUndefined();
    const w2 = installWx({ 'POST /v1/bookings': { status: 201, data: { booking: BOOKING, replayed: false } } }, { readFails: 'tq_booking_pending' });
    const b2 = await load();
    expect(await b2.sendBooking(BODY, KEY)).toEqual({ kind: 'unreadable' });
    expect(await b2.resolveBookingPending()).toEqual({ kind: 'unreadable' });
    expect(w2.sent).toEqual([]);
    const w3 = installWx({ 'POST /v1/bookings/7/cancel': { status: 200, data: { booking: BOOKING, replayed: false } } }, { storage: { tq_booking_pending: { clientKey: KEY, action: 'reschedule' } } });
    const b3 = await load();
    expect(b3.readBookingPending()).toEqual({ state: 'unreadable' });
    expect(await b3.sendCancel(7, 2, KEY)).toEqual({ kind: 'unreadable' });
    expect(w3.sent).toEqual([]);
  });

  it('两处同时确认同一个编号：后回来的那处不删之后新存的记录（独立审查 3d 的 P2）', async () => {
    let release: () => void = () => undefined;
    const K2 = 'd0d0d0d0-9b8a-4c7d-8e6f-5a4b3c2d1e0f';
    const w = installWx(
      { 'POST /v1/bookings/abandon': { hold: { status: 200, data: { status: 'abandoned' } }, onHold: (go) => (release = go) } },
      { storage: { tq_booking_pending: { clientKey: KEY, action: 'create', at: 1 } } },
    );
    const b = await load();
    const late = b.resolveBookingPending();
    await new Promise((ok) => setTimeout(ok, 5));
    // 这期间另一处已经确认完上一次、顾客又提交了一次（新的编号还没回来）
    w.storage.tq_booking_pending = { clientKey: K2, action: 'create', at: 2 };
    release();
    expect(await late).toEqual({ kind: 'abandoned', action: 'create' });
    expect(w.storage.tq_booking_pending).toMatchObject({ clientKey: K2 });
  });
});
