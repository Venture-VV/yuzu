// 「我的」页：手机上的绑定记录读不出来时（本地 AI 预检 PR #42 的 P1）不当作没有。
// 用页面真实的代码（Page 的选项）与真实的绑定模块，wx 换成假的：存储可以让接下来几次读出错，网络按路径给回答。
// 原来的问题：页面加载、点绑定时各读出错一次，页面就显示「没绑定」、发了另一个手机号的绑定，原来没确认的那条被盖掉；
// 原来那次请求晚到时就绑上了，页面却说「不是会员」。
import { afterEach, describe, expect, it, vi } from 'vitest';

type Opts = Record<string, unknown> & { data: Record<string, unknown> };
type Reply = { status: number; data: unknown };

const ORIGINAL = '3f2b0d6e-1c4a-4b8e-9f0a-0c1d2e3f4a5b';
const MEMBER = {
  memberNo: '1024',
  name: '沈先生',
  frozen: false,
  principalBalance: 500000,
  bonusBalance: 0,
  deductionRule: '先本金，后赠金',
  availableCoupons: 0,
  grade: {
    label: 'L1 云涧 · 初',
    grade: 1,
    gradeName: '云涧',
    tier: 0,
    tierName: '初',
    cycleEnd: '2027-11-03',
    daysLeft: 365,
    inGrace: false,
    cycleSpendCents: 0,
    targets: { enjoy: 300000, honor: 600000 },
    next: { grade: 2, name: '潭影', needCents: 1000000, bonusBp: 500 },
    ladder: ['青溪', '云涧', '潭影', '观澜', '望岳', '山海', '归墟'],
  },
};

async function loadPage(opts: { storage: Record<string, unknown>; routes: Record<string, Reply | (() => Reply)> }) {
  let options: Opts | null = null;
  vi.stubGlobal('Page', (o: Opts) => (options = o));
  const failReads = { n: 0 };
  const sent: { path: string; data: unknown }[] = [];
  const storage = opts.storage;
  vi.stubGlobal('wx', {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0', appId: 'wx0' } }),
    getStorageSync: (k: string) => {
      if (k === 'tq_bind_pending' && failReads.n > 0) {
        failReads.n -= 1;
        throw new Error('getStorageSync:fail');
      }
      return k in storage ? storage[k] : '';
    },
    setStorageSync: (k: string, v: unknown) => {
      storage[k] = JSON.parse(JSON.stringify(v));
    },
    removeStorageSync: (k: string) => {
      delete storage[k];
    },
    login: (o: { success: (r: { code: string }) => void }) => o.success({ code: 'wxcode' }),
    request: (o: { url: string; data: unknown; success: (r: unknown) => void; fail: (e: unknown) => void }) => {
      const path = o.url.replace(/^https?:\/\/[^/]+/, '');
      if (path !== '/v1/login') sent.push({ path, data: o.data });
      const route = path === '/v1/login' ? { status: 200, data: { token: 'v1.t', expiresAt: new Date(Date.now() + 7 * 86400e3).toISOString() } } : opts.routes[path];
      const r = typeof route === 'function' ? route() : route;
      setTimeout(() => (!r ? o.fail({ errMsg: 'request:fail' }) : o.success({ statusCode: r.status, data: r.data, header: {} })), 0);
    },
    showToast: () => undefined,
    showModal: () => undefined,
    stopPullDownRefresh: () => undefined,
  });
  vi.resetModules();
  await import('../src/pages/me/index');
  const o = options as unknown as Opts;
  const page: Record<string, unknown> & { data: Record<string, unknown> } = { ...o, data: { ...o.data } };
  page.setData = (d: Record<string, unknown>) => Object.assign(page.data, d);
  for (const k of Object.keys(o)) if (typeof o[k] === 'function') page[k] = (o[k] as (...a: unknown[]) => unknown).bind(page);
  return { page: page as unknown as { data: Record<string, unknown> } & Record<string, (...a: unknown[]) => Promise<void>>, failReads, sent, storage };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('「我的」页：绑定记录读不出来', () => {
  it('页面加载、点绑定时读存储出错：不显示绑定按钮、不发新的绑定、原来的记录还在；读得出来后按原来的编号确认', async () => {
    let abandonOnline = false;
    const { page, failReads, sent, storage } = await loadPage({
      storage: { tq_bind_pending: { clientKey: ORIGINAL, at: 1 } },
      routes: {
        '/v1/me': { status: 200, data: { bound: false, bindVersion: 0, member: null } },
        '/v1/bind': { status: 404, data: { error: { code: 'NOT_MEMBER', message: '这个手机号还不是会员，请到前台开卡' } } },
        '/v1/bind/abandon': () => (abandonOnline ? { status: 200, data: { status: 'abandoned' } } : { status: 503, data: { error: { code: 'STORE_OFFLINE', message: '门店系统连接中，请稍后再试' } } }),
      },
    });
    // 页面加载：读两次都出错
    failReads.n = 2;
    await page.load!();
    expect(page.data.state).toBe('unreadable');
    // 点绑定（另一个手机号）时又读出错一次：不发新的绑定
    failReads.n = 1;
    await page.bind!('code-other-phone');
    expect(page.data.state).toBe('unreadable');
    expect(sent.filter((s) => s.path === '/v1/bind')).toEqual([]);
    expect(storage.tq_bind_pending).toEqual({ clientKey: ORIGINAL, at: 1 });
    // 读得出来了：先按原来的编号请门店系统确认；门店还连不上时显示「绑定结果待确认」，不能绑定
    await page.load!();
    expect(page.data.state).toBe('pending');
    await page.bind!('code-other-phone');
    expect(sent.filter((s) => s.path === '/v1/bind')).toEqual([]);
    // 门店连上了：确认作废原来那次，才能重新绑定
    abandonOnline = true;
    await page.onConfirmPending!();
    expect(page.data.state).toBe('unbound');
    expect(sent.filter((s) => s.path === '/v1/bind/abandon').every((s) => (s.data as { clientKey: string }).clientKey === ORIGINAL)).toBe(true);
    expect(storage.tq_bind_pending).toBeUndefined();
    await page.bind!('code-other-phone');
    expect(sent.filter((s) => s.path === '/v1/bind')).toHaveLength(1);
    expect(page.data.state).toBe('notmember');
  });

  it('存着的内容认不出：没绑定时先不能绑定；已经绑定的照常显示会员卡，并删掉这条', async () => {
    let bound = false;
    const { page, sent, storage } = await loadPage({
      storage: { tq_bind_pending: 'garbled' },
      routes: { '/v1/me': () => ({ status: 200, data: bound ? { bound: true, bindVersion: 1, member: MEMBER } : { bound: false, bindVersion: 0, member: null } }) },
    });
    await page.load!();
    expect(page.data.state).toBe('unreadable');
    await page.bind!('code-1');
    expect(sent.filter((s) => s.path === '/v1/bind')).toEqual([]);
    expect(storage.tq_bind_pending).toBe('garbled');
    bound = true;
    await page.load!();
    expect(page.data.state).toBe('bound');
    expect(storage.tq_bind_pending).toBeUndefined();
  });
});

describe('「我的」页：绑定状态版本号（小程序线测试预检 #44 的 P1）', () => {
  it('点绑定带上 /v1/me 给的版本号；期间绑定状态变过被拒（BIND_STALE）时刷新、用新的版本号再绑', async () => {
    let version = 2;
    let stale = true;
    const toasts: string[] = [];
    const { page, sent, storage } = await loadPage({
      storage: {},
      routes: {
        '/v1/me': () => ({ status: 200, data: { bound: false, bindVersion: version, member: null } }),
        '/v1/bind': () => (stale ? { status: 409, data: { error: { code: 'BIND_STALE', message: '绑定状态刚刚变过，请刷新后再绑定' } } } : { status: 200, data: { status: 'bound', member: { name: '沈先生' }, replayed: false } }),
      },
    });
    (globalThis as unknown as { wx: { showToast: (o: { title: string }) => void } }).wx.showToast = (o) => toasts.push(o.title);
    await page.load!();
    expect(page.data.state).toBe('unbound');
    expect(page.data.bindVersion).toBe(2);
    // 打开页面之后别处解绑过一次：门店系统已经是 3，这次带的 2 被拒
    version = 3;
    await page.bind!('code-1');
    const binds = () => sent.filter((s) => s.path === '/v1/bind').map((s) => s.data as { bindVersion: number; clientKey: string });
    expect(binds()).toHaveLength(1);
    expect(binds()[0]!.bindVersion).toBe(2);
    expect(toasts).toContain('绑定状态刚刚变过，已刷新');
    expect(page.data.state).toBe('unbound');
    expect(page.data.bindVersion).toBe(3);
    // 明确被拒：手机上不留待确认的记录
    expect(storage.tq_bind_pending).toBeUndefined();
    // 再点一次：带新的版本号、新的编号
    stale = false;
    await page.bind!('code-2');
    expect(binds()).toHaveLength(2);
    expect(binds()[1]!.bindVersion).toBe(3);
    expect(binds()[1]!.clientKey).not.toBe(binds()[0]!.clientKey);
  });

  it('还没读到版本号（门店连不上）时不发绑定', async () => {
    let online = false;
    const { page, sent } = await loadPage({
      storage: {},
      routes: { '/v1/me': () => (online ? { status: 200, data: { bound: false, bindVersion: 0, member: null } } : { status: 503, data: { error: { code: 'STORE_OFFLINE', message: '门店系统连接中，请稍后再试' } } }) },
    });
    await page.load!();
    expect(page.data.state).toBe('offline');
    await page.bind!('code-1');
    expect(sent.filter((s) => s.path === '/v1/bind')).toEqual([]);
    online = true;
    await page.load!();
    expect(page.data.bindVersion).toBe(0);
  });
});
