// 线上充值（第二期 2a）：充值页的字（数字都由门店系统算好）、自定义金额只收整元、建单的「结果待确认」
// （存不了不发；明确的结果删记录；结果不确定时请门店系统确认作废，已经建了就接着付那张；连作废都发不出去时保留、不能下新单；
// 手机上的记录读不出来不当作没有）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MpRechargeOptions, MpRechargeOrder } from '../../src/shared/mp';

type Reply = { status: number; data: unknown } | 'fail';

function installWx(routes: Record<string, Reply | (() => Reply)>, opts: { storageBroken?: boolean; storage?: Record<string, unknown>; readFails?: { on: boolean } } = {}) {
  const storage: Record<string, unknown> = opts.storage ?? {};
  const sent: { path: string; data: unknown }[] = [];
  vi.stubGlobal('wx', {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0', appId: 'wx0' } }),
    getStorageSync: (k: string) => {
      if (opts.readFails?.on && k === 'tq_recharge_pending') throw new Error('getStorageSync:fail');
      return k in storage ? storage[k] : '';
    },
    setStorageSync: (k: string, v: unknown) => {
      if (opts.storageBroken && k === 'tq_recharge_pending') throw new Error('存储空间已满');
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
  return import('../src/utils/recharge');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ORDER: MpRechargeOrder = {
  orderNo: 'MPR20261104ABCDEFGH12',
  status: 'pending',
  amount: 300000,
  planName: '线上三千',
  estBonus: 15000,
  estLabel: 'L2 潭影 · 初',
  expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
  createdAt: new Date().toISOString(),
  result: null,
  notice: null,
};
const OPTIONS: MpRechargeOptions = {
  open: true,
  notice: null,
  plans: [
    { planId: 1, name: '线上三百', amount: 30000, bonus: 0, label: 'L0 青溪', upgraded: false, coupons: [], blocked: '首充单笔最低 ¥500.00' },
    { planId: 2, name: '线上三千', amount: 300000, bonus: 15000, label: 'L2 潭影 · 初', upgraded: true, coupons: ['线上搓澡券 × 2'], blocked: null },
  ],
  custom: { minCents: 50000, maxCents: 1000000 },
  first: true,
  minimum: 50000,
  dailyLimit: 3,
  usedToday: 1,
  pending: null,
  mock: false,
};

describe('充值页的字', () => {
  it('套餐：实付、预估赠金与充完的档阶、挂的券；首充最低挡住的写原因；规则与今天还能充几笔', async () => {
    installWx({});
    const m = await load();
    const v = m.optionsView(OPTIONS);
    expect(v.plans).toEqual([
      { planId: 1, name: '线上三百', amount: '¥300.00', bonus: '', label: '充完 L0 青溪', coupons: '', blocked: '首充单笔最低 ¥500.00' },
      { planId: 2, name: '线上三千', amount: '¥3,000.00', bonus: '预估赠 ¥150.00', label: '充完 L2 潭影 · 初', coupons: '另送 线上搓澡券 × 2', blocked: '' },
    ]);
    expect(v.custom).toEqual({ min: '¥500.00', max: '¥10,000.00', hint: '整元，¥500.00 起，最多 ¥10,000.00' });
    expect(v.rules).toBe('首充单笔最低 ¥500.00 · 今天还能充 2 笔');
    expect(m.optionsView({ ...OPTIONS, open: false, notice: '线上充值还没开通，请到前台充值', custom: null })).toMatchObject({ open: false, notice: '线上充值还没开通，请到前台充值', custom: null });
  });

  it('单子：待支付写还有几分钟；已入账写本金赠金与档阶；待处理、关闭照门店系统的话', async () => {
    installWx({});
    const m = await load();
    const now = Date.parse(ORDER.createdAt);
    expect(m.orderCard({ ...ORDER, expiresAt: new Date(now + 9.5 * 60000).toISOString() }, now)).toMatchObject({
      status: '待支付',
      amount: '¥3,000.00',
      what: '线上三千',
      estimate: '预估赠 ¥150.00，充完 L2 潭影 · 初（以到账时为准）',
      expires: '10 分钟内付完有效',
    });
    expect(m.orderCard({ ...ORDER, status: 'paid', result: { principal: 300000, bonus: 15000, label: 'L2 潭影 · 初' } })).toMatchObject({
      status: '充值成功',
      expires: '',
      result: { principal: '¥3,000.00', bonus: '¥150.00', label: 'L2 潭影 · 初' },
    });
    expect(m.orderCard({ ...ORDER, status: 'held', notice: '已付款，门店系统没能自动入账，门店正在核对' })).toMatchObject({
      status: '已付款，门店正在核对',
      notice: '已付款，门店系统没能自动入账，门店正在核对',
    });
    expect(m.orderCard({ ...ORDER, planName: null }).what).toBe('自定义金额');
  });

  it('自定义金额：只收整元，不低于最低、不超过线上单笔上限', async () => {
    installWx({});
    const m = await load();
    const c = { minCents: 50000, maxCents: 1000000 };
    expect(m.parseCustomAmount('', c)).toEqual({ ok: false, message: '请填金额' });
    expect(m.parseCustomAmount('800.5', c)).toEqual({ ok: false, message: '金额请填整元' });
    expect(m.parseCustomAmount('300', c)).toEqual({ ok: false, message: '最少充 ¥500.00' });
    expect(m.parseCustomAmount('20000', c)).toEqual({ ok: false, message: '线上单笔最多 ¥10,000.00，更多请到前台充值' });
    expect(m.parseCustomAmount(' 1,000 ', c)).toEqual({ ok: true, cents: 100000 });
    expect(m.parseCustomAmount('¥800', c)).toEqual({ ok: true, cents: 80000 });
  });
});

describe('建单的结果待确认', () => {
  const created = { order: ORDER, payment: { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=wx1', signType: 'RSA', paySign: 's' }, mock: false, replayed: false };

  it('手机存不下操作编号：不发请求', async () => {
    const { sent } = installWx({}, { storageBroken: true });
    const m = await load();
    expect(await m.sendCreate({ planId: 2, amount: null }, KEY)).toMatchObject({ kind: 'rejected', code: 'PENDING_STORE_FAILED' });
    expect(sent).toEqual([]);
  });

  it('建好了、门店系统明确拒绝：删掉待确认记录', async () => {
    let env = installWx({ '/v1/recharge/orders': { status: 201, data: created } });
    let m = await load();
    expect(await m.sendCreate({ planId: 2, amount: null }, KEY)).toEqual({ kind: 'created', created });
    expect(env.sent).toEqual([{ path: '/v1/recharge/orders', data: { clientKey: KEY, planId: 2, amount: null } }]);
    expect(env.storage.tq_recharge_pending).toBeUndefined();

    env = installWx({ '/v1/recharge/orders': { status: 409, data: { error: { code: 'ORDER_PENDING', message: '还有一张待支付的充值单，请先付完或取消' } } } });
    m = await load();
    expect(await m.sendCreate({ planId: null, amount: 80000 }, KEY)).toEqual({ kind: 'rejected', code: 'ORDER_PENDING', message: '还有一张待支付的充值单，请先付完或取消' });
    expect(env.storage.tq_recharge_pending).toBeUndefined();
  });

  it('断网、门店出错：请门店系统作废这个编号；没建就是没建，建了就接着付那张', async () => {
    let env = installWx({ '/v1/recharge/orders': 'fail', '/v1/recharge/abandon': { status: 200, data: { status: 'abandoned' } } });
    let m = await load();
    expect(await m.sendCreate({ planId: 2, amount: null }, KEY)).toEqual({ kind: 'abandoned' });
    expect(env.sent.map((s) => s.path)).toEqual(['/v1/recharge/orders', '/v1/recharge/abandon']);
    expect(env.sent[1]!.data).toEqual({ clientKey: KEY });
    expect(env.storage.tq_recharge_pending).toBeUndefined();

    env = installWx({
      '/v1/recharge/orders': { status: 503, data: { error: { code: 'STORE_OFFLINE', message: '门店系统连接中，请稍后再试' } } },
      '/v1/recharge/abandon': { status: 200, data: { status: 'created', order: ORDER } },
    });
    m = await load();
    expect(await m.sendCreate({ planId: 2, amount: null }, KEY)).toEqual({ kind: 'existing', order: ORDER });
    expect(env.storage.tq_recharge_pending).toBeUndefined();
  });

  it('连作废都发不出去：保留记录，不能下新单；网络好了按原编号确认', async () => {
    const storage: Record<string, unknown> = {};
    let env = installWx({ '/v1/recharge/orders': 'fail', '/v1/recharge/abandon': 'fail' }, { storage });
    let m = await load();
    expect(await m.sendCreate({ planId: 2, amount: null }, KEY)).toMatchObject({ kind: 'pending' });
    expect(storage.tq_recharge_pending).toMatchObject({ clientKey: KEY, planId: 2, amount: null });
    // 再点下单：不发新的，先确认原来那次
    env = installWx({ '/v1/recharge/orders': { status: 201, data: created }, '/v1/recharge/abandon': 'fail' }, { storage });
    m = await load();
    expect(await m.sendCreate({ planId: null, amount: 80000 }, 'another-key')).toMatchObject({ kind: 'pending' });
    expect(env.sent.map((s) => s.path)).toEqual(['/v1/recharge/abandon']);
    env = installWx({ '/v1/recharge/abandon': { status: 200, data: { status: 'abandoned' } } }, { storage });
    m = await load();
    expect(await m.resolveRechargePending()).toEqual({ kind: 'abandoned' });
    expect(env.sent).toEqual([{ path: '/v1/recharge/abandon', data: { clientKey: KEY } }]);
    expect(storage.tq_recharge_pending).toBeUndefined();
  });

  it('手机上的记录读不出来：不当作没有，不发新的、不改写；存着的内容认不出也一样', async () => {
    const storage: Record<string, unknown> = { tq_recharge_pending: { clientKey: KEY, planId: 2, amount: null, at: 1 } };
    const readFails = { on: true };
    const env = installWx({ '/v1/recharge/orders': { status: 201, data: created } }, { storage, readFails });
    const m = await load();
    expect(await m.sendCreate({ planId: 2, amount: null }, 'another-key')).toEqual({ kind: 'unreadable' });
    expect(await m.resolveRechargePending()).toEqual({ kind: 'unreadable' });
    expect(env.sent).toEqual([]);
    expect(storage.tq_recharge_pending).toMatchObject({ clientKey: KEY });
    readFails.on = false;
    storage.tq_recharge_pending = { nonsense: true };
    expect(m.readRechargePending()).toEqual({ state: 'unreadable' });
  });
});
