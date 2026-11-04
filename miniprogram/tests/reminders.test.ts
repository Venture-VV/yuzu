// 到期提醒（第三期 3a）：「提醒我」的字（没配模板不显示、已设的写已设提醒）、微信弹窗的回答、设提醒的「结果待确认」
// （存不了不发；门店系统记下了或明确拒绝才删；结果不确定时保留，下次打开页面原样重提同一个编号；手机上的记录读不出来不发）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MpReminderConsented, MpReminderOptions } from '../../src/shared/mp';

type Reply = { status: number; data: unknown } | 'fail';

function installWx(
  routes: Record<string, Reply | (() => Reply)>,
  opts: { storageBroken?: boolean; storage?: Record<string, unknown>; readFails?: boolean; subscribe?: Record<string, string> | 'fail' } = {},
) {
  const storage: Record<string, unknown> = opts.storage ?? {};
  const sent: { path: string; data: unknown }[] = [];
  const toasts: string[] = [];
  const modals: { title: string; content: string }[] = [];
  vi.stubGlobal('wx', {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0', appId: 'wx0' } }),
    getStorageSync: (k: string) => {
      if (opts.readFails && k === 'tq_reminder_pending') throw new Error('getStorageSync:fail');
      return k in storage ? storage[k] : '';
    },
    setStorageSync: (k: string, v: unknown) => {
      if (opts.storageBroken && k === 'tq_reminder_pending') throw new Error('存储空间已满');
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
      const r = typeof route === 'function' ? route() : route;
      setTimeout(() => (!r || r === 'fail' ? o.fail({ errMsg: 'request:fail' }) : o.success({ statusCode: r.status, data: r.data, header: {} })), 0);
    },
    requestSubscribeMessage: (o: { tmplIds: string[]; success: (r: Record<string, string>) => void; fail: (e: unknown) => void }) => {
      if (opts.subscribe === 'fail') o.fail({ errMsg: 'requestSubscribeMessage:fail' });
      else o.success({ errMsg: 'requestSubscribeMessage:ok', ...(opts.subscribe ?? { [o.tmplIds[0]!]: 'accept' }) });
    },
    showToast: (o: { title: string }) => toasts.push(o.title),
    showModal: (o: { title: string; content: string }) => modals.push({ title: o.title, content: o.content }),
  });
  return { storage, sent, toasts, modals };
}

const load = async () => {
  vi.resetModules();
  return import('../src/utils/reminders');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const TPL = 'tplCoupon-0123456789abcdefABCDEF';
const OPTIONS: MpReminderOptions = {
  open: true,
  bindVersion: 3,
  templates: { coupon: TPL, membership: 'tplMember-0123456789abcdefABCDEF', bonus: null },
  leadDays: { coupon: 3, membership: 7, bonus: 7 },
  sendHours: { from: 10, to: 20 },
  set: [
    { kind: 'coupon', couponCode: 'Q7K29XM4ABCD', targetDate: '2026-11-20', dueDate: '2026-11-17', state: 'waiting' },
    { kind: 'coupon', couponCode: 'DONE2345ABCD', targetDate: '2026-11-20', dueDate: '2026-11-17', state: 'done' },
    { kind: 'membership', couponCode: null, targetDate: '2027-03-31', dueDate: '2027-03-24', state: 'sent' },
  ],
  membership: { cycleEnd: '2027-03-31', inGrace: false, label: 'L3 观澜 · 享' },
  bonus: { amount: 5000, lastDay: '2026-11-19' },
};
const CONSENTED: MpReminderConsented = { consentId: 9, kind: 'coupon', targetDate: '2026-11-20', dueDate: '2026-11-17', replayed: false };
const KEY = '3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f';

describe('「提醒我」的字', () => {
  it('没配模板的不显示；已经设了（还没发、已发）的写已设提醒；不用发了的可以再设', async () => {
    installWx({});
    const r = await load();
    expect(r.remindButton(null, { kind: 'coupon', couponCode: 'X' })).toEqual({ show: false, set: false, text: '' });
    expect(r.remindButton(OPTIONS, { kind: 'bonus', targetDate: '2026-11-20' }).show).toBe(false);
    expect(r.remindButton(OPTIONS, { kind: 'coupon', couponCode: 'Q7K29XM4ABCD' })).toEqual({ show: true, set: true, text: '已设提醒' });
    expect(r.remindButton(OPTIONS, { kind: 'coupon', couponCode: 'DONE2345ABCD' })).toEqual({ show: true, set: false, text: '到期提醒我' });
    expect(r.remindButton(OPTIONS, { kind: 'coupon', couponCode: 'NEW23456ABCD' })).toEqual({ show: true, set: false, text: '到期提醒我' });
    expect(r.remindButton(OPTIONS, { kind: 'membership', targetDate: '2027-03-31' })).toEqual({ show: true, set: true, text: '已设提醒' });
    // 补充期用会籍的模板
    expect(r.remindButton(OPTIONS, { kind: 'grace', targetDate: '2027-03-31' })).toEqual({ show: true, set: false, text: '进补充期也提醒我' });
    expect(r.remindHint(OPTIONS, 'coupon')).toBe('到期前 3 天 10:00–20:00 之间发一条微信消息');
    expect(r.remindHint(OPTIONS, 'grace')).toBe('进补充期当天 10:00–20:00 之间发一条微信消息');
    expect(r.setText(CONSENTED, OPTIONS)).toBe('已设提醒：11月17日 10:00 以后发一条微信消息');
  });

  it('微信弹窗的回答：同意、拒绝、关掉了消息、弹不出来', async () => {
    for (const [reply, want] of [
      [{ [TPL]: 'accept' }, 'accept'],
      [{ [TPL]: 'reject' }, 'reject'],
      [{ [TPL]: 'ban' }, 'ban'],
      [{ [TPL]: 'filter' }, 'ban'],
      ['fail', 'fail'],
    ] as const) {
      installWx({}, { subscribe: reply });
      const r = await load();
      expect(await r.askConsent(TPL)).toBe(want);
    }
    installWx({});
    const r = await load();
    expect(r.refusedText('reject')).toBe('没有同意，不会发提醒');
    expect(r.refusedText('ban')).toMatch(/设置/);
  });
});

describe('设提醒的「结果待确认」', () => {
  it('记下了：先存后发，记下了删记录；同一个编号带当初的内容', async () => {
    const w = installWx({ 'POST /v1/reminders': { status: 201, data: CONSENTED } });
    const r = await load();
    const out = await r.sendConsent(KEY, { kind: 'coupon', couponCode: 'Q7K29XM4ABCD' }, TPL, 3);
    expect(out).toEqual({ kind: 'set', consented: CONSENTED });
    expect(w.sent).toEqual([{ path: 'POST /v1/reminders', data: { clientKey: KEY, kind: 'coupon', couponCode: 'Q7K29XM4ABCD', templateId: TPL, bindVersion: 3 } }]);
    expect(w.storage.tq_reminder_pending).toBeUndefined();
  });

  it('存不了不发；手机上的记录读不出来也不发', async () => {
    const w = installWx({ 'POST /v1/reminders': { status: 201, data: CONSENTED } }, { storageBroken: true });
    const r = await load();
    expect(await r.sendConsent(KEY, { kind: 'coupon', couponCode: 'Q7K29XM4ABCD' }, TPL, 3)).toMatchObject({ kind: 'rejected', code: 'PENDING_STORE_FAILED' });
    expect(w.sent).toEqual([]);
    const w2 = installWx({ 'POST /v1/reminders': { status: 201, data: CONSENTED } }, { readFails: true });
    const r2 = await load();
    expect(await r2.sendConsent(KEY, { kind: 'coupon', couponCode: 'Q7K29XM4ABCD' }, TPL, 3)).toMatchObject({ kind: 'rejected', code: 'PENDING_UNREADABLE' });
    expect(w2.sent).toEqual([]);
    // 存着的内容认不出：也不发
    const w3 = installWx({ 'POST /v1/reminders': { status: 201, data: CONSENTED } }, { storage: { tq_reminder_pending: { what: 1 } } });
    const r3 = await load();
    expect((await r3.sendConsent(KEY, { kind: 'coupon', couponCode: 'Q7K29XM4ABCD' }, TPL, 3)).kind).toBe('rejected');
    expect(w3.sent).toEqual([]);
    expect(await r3.retryPendingReminders()).toBe(0);
  });

  it('门店系统明确拒绝（绑定刚变过）：删记录、把原因给顾客看', async () => {
    const w = installWx({ 'POST /v1/reminders': { status: 409, data: { error: { code: 'BIND_STALE', message: '会员绑定刚变过，这次没有设提醒，请刷新后再点' } } } });
    const r = await load();
    expect(await r.sendConsent(KEY, { kind: 'membership', targetDate: '2027-03-31' }, 'tplMember-0123456789abcdefABCDEF', 3)).toEqual({
      kind: 'rejected',
      code: 'BIND_STALE',
      message: '会员绑定刚变过，这次没有设提醒，请刷新后再点',
    });
    expect(w.storage.tq_reminder_pending).toBeUndefined();
  });

  it('结果不确定（断网、门店出错）：记录保留；下次打开原样重提同一个编号，记下了才删', async () => {
    let reply: Reply = 'fail';
    const w = installWx({ 'POST /v1/reminders': () => reply });
    const r = await load();
    expect((await r.sendConsent(KEY, { kind: 'bonus', targetDate: '2026-11-20' }, 'tplBonus_0123456789abcdefABCDEF0', 3)).kind).toBe('pending');
    expect(w.storage.tq_reminder_pending).toEqual([{ clientKey: KEY, body: { kind: 'bonus', targetDate: '2026-11-20', templateId: 'tplBonus_0123456789abcdefABCDEF0', bindVersion: 3 }, at: expect.any(Number) }]);
    reply = { status: 502, data: { error: { code: 'INTERNAL', message: '网络出了点问题' } } };
    expect(await r.retryPendingReminders()).toBe(0);
    expect((w.storage.tq_reminder_pending as unknown[]).length).toBe(1);
    reply = { status: 200, data: { ...CONSENTED, kind: 'bonus', replayed: true } };
    expect(await r.retryPendingReminders()).toBe(1);
    expect(w.storage.tq_reminder_pending).toBeUndefined();
    // 三次发的都是同一个编号、同样的内容
    const posts = w.sent.filter((s) => s.path === 'POST /v1/reminders');
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((p) => JSON.stringify(p.data))).size).toBe(1);
  });

  it('点「提醒我」：没同意的不发请求；同意了记下来、提示哪天发', async () => {
    const w = installWx({ 'POST /v1/reminders': { status: 201, data: CONSENTED } }, { subscribe: { [TPL]: 'reject' } });
    const r = await load();
    expect(await r.remindTap(OPTIONS, { kind: 'coupon', couponCode: 'NEW23456ABCD' })).toBe(false);
    expect(w.sent).toEqual([]);
    expect(w.toasts).toEqual(['没有同意，不会发提醒']);
    const w2 = installWx({ 'POST /v1/reminders': { status: 201, data: CONSENTED } });
    const r2 = await load();
    expect(await r2.remindTap(OPTIONS, { kind: 'coupon', couponCode: 'NEW23456ABCD' })).toBe(true);
    expect(w2.sent.map((s) => s.path)).toEqual(['POST /v1/reminders']);
    expect(w2.modals).toEqual([{ title: '设好了', content: '已设提醒：11月17日 10:00 以后发一条微信消息' }]);
    // 没配模板的：什么都不做
    const w3 = installWx({});
    const r3 = await load();
    expect(await r3.remindTap(OPTIONS, { kind: 'bonus', targetDate: '2026-11-20' })).toBe(false);
    expect(w3.sent).toEqual([]);
  });
});
