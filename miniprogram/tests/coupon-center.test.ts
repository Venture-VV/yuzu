// 领券中心（第二期 2c）：列表的字（能不能领、领过几张都由门店系统算好）、领取的「结果待确认」
// （存不了不发；明确的结果删记录；结果不确定时请门店系统确认作废，已经领到了就回那一张；连作废都发不出去时保留、不能再领；
// 手机上的记录读不出来不当作没有）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MpCouponCenter, MpCouponClaimed } from '../../src/shared/mp';

type Reply = { status: number; data: unknown } | 'fail';

function installWx(routes: Record<string, Reply | (() => Reply)>, opts: { storageBroken?: boolean; storage?: Record<string, unknown>; readFails?: { on: boolean } } = {}) {
  const storage: Record<string, unknown> = opts.storage ?? {};
  const sent: { path: string; data: unknown }[] = [];
  vi.stubGlobal('wx', {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0', appId: 'wx0' } }),
    getStorageSync: (k: string) => {
      if (opts.readFails?.on && k === 'tq_coupon_pending') throw new Error('getStorageSync:fail');
      return k in storage ? storage[k] : '';
    },
    setStorageSync: (k: string, v: unknown) => {
      if (opts.storageBroken && k === 'tq_coupon_pending') throw new Error('存储空间已满');
      storage[k] = JSON.parse(JSON.stringify(v));
    },
    removeStorageSync: (k: string) => {
      delete storage[k];
    },
    login: (o: { success: (r: { code: string }) => void }) => o.success({ code: 'wxcode' }),
    request: (o: { url: string; data: unknown; success: (r: unknown) => void; fail: (e: unknown) => void }) => {
      const path = o.url.replace(/^https?:\/\/[^/]+/, '');
      if (path !== '/v1/login') sent.push({ path, data: o.data });
      const route = path === '/v1/login' ? { status: 200, data: { token: 'v1.t', expiresAt: new Date(Date.now() + 7 * 86400e3).toISOString() } } : routes[path];
      const r = typeof route === 'function' ? route() : route;
      setTimeout(() => (!r || r === 'fail' ? o.fail({ errMsg: 'request:fail' }) : o.success({ statusCode: r.status, data: r.data, header: {} })), 0);
    },
  });
  return { storage, sent };
}

const load = async () => {
  vi.resetModules();
  return import('../src/utils/coupon-center');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = '3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f';
const CLAIMED: MpCouponClaimed = {
  claimId: 7,
  templateId: 3,
  replayed: false,
  coupon: { code: 'Q7K29XM4', name: '新客领三十', summary: '代金券 ¥30.00 · 满 ¥50.00 可用', validFrom: '2026-11-04', validTo: '2026-11-18' },
};
const CENTER: MpCouponCenter = {
  open: true,
  notice: null,
  items: [
    { templateId: 3, name: '新客领三十', kind: 'cash', summary: '代金券 ¥30.00 · 满 ¥50.00 可用', validity: '领取后 15 天内有效', limitText: '每人限领 1 张', claimed: 0, canClaim: true, reason: null },
    { templateId: 4, name: '饮品九折', kind: 'discount', summary: '9 折', validity: '领取后 30 天内有效', limitText: '不限领', claimed: 2, canClaim: true, reason: null },
    { templateId: 5, name: '搓澡券', kind: 'cash', summary: '代金券 ¥20.00', validity: '2026-11-01 至 2026-12-31 有效', limitText: '每人限领 1 张', claimed: 1, canClaim: false, reason: '每人限领 1 张，已经领满了' },
    { templateId: 6, name: '尊享代金券', kind: 'cash', summary: '代金券 ¥50.00', validity: '领取后 30 天内有效', limitText: '每人限领 1 张', claimed: 0, canClaim: false, reason: '只给 L3–L6 的会员领' },
    { templateId: 7, name: '拿铁买一赠一', kind: 'bogo', summary: '买一赠一 · 买 拿铁 送 拿铁 1 份 · 最多抵 ¥30.00', validity: '领取后 30 天内有效', limitText: '每人限领 1 张', claimed: 0, canClaim: true, reason: null },
  ],
  bindVersion: 1,
};

describe('领券中心的字', () => {
  it('券面的大字与说明照「我的券」；领过的写已领几张；领满的按钮写已领满，别的原因写领不了', async () => {
    installWx({});
    const m = await load();
    const v = m.centerView(CENTER);
    expect(v).toMatchObject({ open: true, notice: '', bindVersion: 1 });
    expect(v.items.map((i) => [i.big, i.kind, i.terms, i.limit, i.button, i.reason])).toEqual([
      ['¥30', '代金券', '满 ¥50 可用', '每人限领 1 张', '领取', ''],
      ['9 折', '折扣券', '', '不限领 · 已领 2 张', '领取', ''],
      ['¥20', '代金券', '', '每人限领 1 张 · 已领 1 张', '已领满', '每人限领 1 张，已经领满了'],
      ['¥50', '代金券', '', '每人限领 1 张', '领不了', '只给 L3–L6 的会员领'],
      ['买一赠一', '买一赠一券', '买 拿铁 送 拿铁 1 份 · 最多抵 ¥30', '每人限领 1 张', '领取', ''],
    ]);
    expect(v.items.map((i) => i.bigLong)).toEqual([false, false, false, false, true]);
    expect(m.centerView({ open: false, notice: '领券中心还没开放', items: [], bindVersion: 2 })).toEqual({ open: false, notice: '领券中心还没开放', items: [], bindVersion: 2 });
    expect(m.claimedText(CLAIMED)).toBe('新客领三十（Q7K2-9XM4）已放进「我的券」，2026-11-04 至 2026-11-18');
  });
});

describe('领取的结果待确认', () => {
  it('手机存不下操作编号：不发请求', async () => {
    const { sent } = installWx({}, { storageBroken: true });
    const m = await load();
    expect(await m.sendClaim(3, KEY, 1)).toMatchObject({ kind: 'rejected', code: 'PENDING_STORE_FAILED' });
    expect(sent).toEqual([]);
  });

  it('领到了、门店系统明确拒绝：删掉待确认记录', async () => {
    let env = installWx({ '/v1/coupon-claims': { status: 201, data: CLAIMED } });
    let m = await load();
    expect(await m.sendClaim(3, KEY, 1)).toEqual({ kind: 'claimed', claimed: CLAIMED });
    expect(env.sent).toEqual([{ path: '/v1/coupon-claims', data: { clientKey: KEY, templateId: 3, bindVersion: 1 } }]);
    expect(env.storage.tq_coupon_pending).toBeUndefined();

    env = installWx({ '/v1/coupon-claims': { status: 422, data: { error: { code: 'CLAIM_LIMIT', message: '每人限领 1 张，已经领满了' } } } });
    m = await load();
    expect(await m.sendClaim(3, KEY, 1)).toEqual({ kind: 'rejected', code: 'CLAIM_LIMIT', message: '每人限领 1 张，已经领满了' });
    expect(env.storage.tq_coupon_pending).toBeUndefined();
  });

  it('断网、门店出错：请门店系统作废这个编号；没领到就是没领到，领到了就回那一张', async () => {
    let env = installWx({ '/v1/coupon-claims': 'fail', '/v1/coupon-claims/abandon': { status: 200, data: { status: 'abandoned' } } });
    let m = await load();
    expect(await m.sendClaim(3, KEY, 1)).toEqual({ kind: 'abandoned' });
    expect(env.sent.map((s) => s.path)).toEqual(['/v1/coupon-claims', '/v1/coupon-claims/abandon']);
    expect(env.sent[1]!.data).toEqual({ clientKey: KEY });
    expect(env.storage.tq_coupon_pending).toBeUndefined();

    env = installWx({
      '/v1/coupon-claims': { status: 503, data: { error: { code: 'STORE_OFFLINE', message: '门店系统连接中，请稍后再试' } } },
      '/v1/coupon-claims/abandon': { status: 200, data: { status: 'claimed', claimed: { ...CLAIMED, replayed: true } } },
    });
    m = await load();
    expect(await m.sendClaim(3, KEY, 1)).toEqual({ kind: 'claimed', claimed: { ...CLAIMED, replayed: true } });
    expect(env.storage.tq_coupon_pending).toBeUndefined();
  });

  it('连作废都发不出去：保留记录，不能再领；网络好了按原编号确认；编号被别的微信用过的当作没领到', async () => {
    const storage: Record<string, unknown> = {};
    let env = installWx({ '/v1/coupon-claims': 'fail', '/v1/coupon-claims/abandon': 'fail' }, { storage });
    let m = await load();
    expect(await m.sendClaim(3, KEY, 1)).toMatchObject({ kind: 'pending' });
    expect(storage.tq_coupon_pending).toMatchObject({ clientKey: KEY, templateId: 3, bindVersion: 1 });
    // 再点领取：不发新的，先确认原来那次
    env = installWx({ '/v1/coupon-claims': { status: 201, data: CLAIMED }, '/v1/coupon-claims/abandon': 'fail' }, { storage });
    m = await load();
    expect(await m.sendClaim(4, 'another-key', 1)).toMatchObject({ kind: 'pending' });
    expect(env.sent.map((s) => s.path)).toEqual(['/v1/coupon-claims/abandon']);
    env = installWx({ '/v1/coupon-claims/abandon': { status: 409, data: { error: { code: 'CLIENT_KEY_REUSED', message: '这次领取的编号已经用过，请重新点领取' } } } }, { storage });
    m = await load();
    expect(await m.resolveCouponPending()).toEqual({ kind: 'abandoned' });
    expect(env.sent).toEqual([{ path: '/v1/coupon-claims/abandon', data: { clientKey: KEY } }]);
    expect(storage.tq_coupon_pending).toBeUndefined();
  });

  it('手机上的记录读不出来：不当作没有，不发新的、不改写；存着的内容认不出也一样', async () => {
    const storage: Record<string, unknown> = { tq_coupon_pending: { clientKey: KEY, templateId: 3, at: 1 } };
    const readFails = { on: true };
    const env = installWx({ '/v1/coupon-claims': { status: 201, data: CLAIMED } }, { storage, readFails });
    const m = await load();
    expect(await m.sendClaim(3, 'another-key', 1)).toEqual({ kind: 'unreadable' });
    expect(await m.resolveCouponPending()).toEqual({ kind: 'unreadable' });
    expect(env.sent).toEqual([]);
    expect(storage.tq_coupon_pending).toMatchObject({ clientKey: KEY });
    readFails.on = false;
    storage.tq_coupon_pending = { clientKey: KEY };
    expect(m.readCouponPending()).toEqual({ state: 'unreadable' });
  });
});
