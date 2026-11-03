// 连网关：登录与会话、会话失效重新登录、展示内容断网时用本机存的旧内容、模拟微信只在开发版与体验版
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (req: { url: string; method: string; data: unknown; header: Record<string, string> }) => { status: number; data: unknown; header?: Record<string, string> } | 'fail';

interface FakeWx {
  storage: Record<string, unknown>;
  requests: { url: string; method: string; data: unknown; header: Record<string, string> }[];
  loginCodes: number;
}

function installWx(handler: Handler, env: 'develop' | 'trial' | 'release' = 'release'): FakeWx {
  const fake: FakeWx = { storage: {}, requests: [], loginCodes: 0 };
  vi.stubGlobal('wx', {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: env, version: '', appId: 'wx0' } }),
    getStorageSync: (k: string) => (k in fake.storage ? fake.storage[k] : ''),
    setStorageSync: (k: string, v: unknown) => {
      fake.storage[k] = JSON.parse(JSON.stringify(v));
    },
    removeStorageSync: (k: string) => {
      delete fake.storage[k];
    },
    login: (o: { success: (r: { code: string }) => void }) => {
      fake.loginCodes++;
      o.success({ code: 'wxcode' + fake.loginCodes });
    },
    request: (o: { url: string; method: string; data: unknown; header: Record<string, string>; success: (r: unknown) => void; fail: (e: unknown) => void }) => {
      const req = { url: o.url, method: o.method, data: o.data, header: o.header };
      fake.requests.push(req);
      const r = handler(req);
      setTimeout(() => (r === 'fail' ? o.fail({ errMsg: 'request:fail' }) : o.success({ statusCode: r.status, data: r.data, header: r.header || {} })), 0);
    },
  });
  return fake;
}

const loadApi = async () => {
  vi.resetModules();
  return import('../src/utils/api');
};

const future = () => new Date(Date.now() + 7 * 86400 * 1000).toISOString();
const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('登录与会话', () => {
  it('第一次用会员接口时登录，会话存在本机，之后直接用；同时几个请求只登录一次', async () => {
    let logins = 0;
    const fake = installWx((req) => {
      const p = path(req.url);
      if (p === '/v1/login') {
        logins++;
        expect(req.data).toEqual({ code: 'wxcode' + logins });
        return { status: 200, data: { token: 'v1.tok', expiresAt: future() } };
      }
      if (p === '/v1/me') {
        expect(req.header.authorization).toBe('Bearer v1.tok');
        return { status: 200, data: { bound: false, member: null } };
      }
      return { status: 404, data: {} };
    });
    const api = await loadApi();
    const [a, b] = await Promise.all([api.member('GET', '/v1/me'), api.member('GET', '/v1/me')]);
    expect(a).toEqual({ bound: false, member: null });
    expect(b).toEqual({ bound: false, member: null });
    expect(logins).toBe(1);
    expect((fake.storage.tq_session as { token: string }).token).toBe('v1.tok');
    await api.member('GET', '/v1/me');
    expect(logins).toBe(1);
    // 正式版不问网关是不是模拟微信
    expect(fake.requests.some((r) => path(r.url) === '/v1/health')).toBe(false);
  });

  it('会话失效（401 SESSION_REQUIRED）：重新登录、重发一次', async () => {
    let tokens = 0;
    installWx((req) => {
      const p = path(req.url);
      if (p === '/v1/login') return { status: 200, data: { token: 'v1.t' + ++tokens, expiresAt: future() } };
      if (p === '/v1/coupons') {
        if (req.header.authorization === 'Bearer v1.t1') return { status: 401, data: { error: { code: 'SESSION_REQUIRED', message: '请重新打开小程序登录' } } };
        return { status: 200, data: [] };
      }
      return { status: 404, data: {} };
    });
    const api = await loadApi();
    expect(await api.member('GET', '/v1/coupons')).toEqual([]);
    expect(tokens).toBe(2);
  });

  it('门店系统的错误原样给页面；POST 一律带 JSON', async () => {
    installWx((req) => {
      const p = path(req.url);
      if (p === '/v1/login') return { status: 200, data: { token: 'v1.tok', expiresAt: future() } };
      if (p === '/v1/bind') {
        expect(req.method).toBe('POST');
        expect(req.header['content-type']).toBe('application/json');
        return { status: 404, data: { error: { code: 'NOT_MEMBER', message: '这个手机号还不是会员，请到前台开卡' } } };
      }
      if (p === '/v1/code') {
        expect(req.data).toEqual({});
        return { status: 503, data: { error: { code: 'STORE_OFFLINE', message: '门店系统连接中，请稍后再试' } } };
      }
      return { status: 404, data: {} };
    });
    const api = await loadApi();
    const e1 = await api.member('POST', '/v1/bind', { phoneCode: 'x', clientKey: 'k' }).catch((e: unknown) => e);
    expect(api.isApiError(e1)).toBe(true);
    expect(e1).toMatchObject({ code: 'NOT_MEMBER', status: 404, message: '这个手机号还不是会员，请到前台开卡' });
    expect(api.isOffline(e1)).toBe(false);
    const e2 = await api.member('POST', '/v1/code').catch((e: unknown) => e);
    expect(api.isOffline(e2)).toBe(true);
    expect(api.messageOf(e2)).toBe('门店系统连接中，请稍后再试');
  });

  it('连不上网关：NETWORK，算「连不上」', async () => {
    installWx(() => 'fail');
    const api = await loadApi();
    const e = await api.member('GET', '/v1/me').catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'NETWORK', status: 0 });
    expect(api.isOffline(e)).toBe(true);
  });
});

describe('展示内容', () => {
  it('成功时存一份；之后连不上时给存的（标「之前的信息」）；网关给的旧内容也标出来', async () => {
    let mode: 'ok' | 'stale' | 'down' = 'ok';
    const fake = installWx((req) => {
      if (path(req.url) !== '/v1/home') return { status: 404, data: {} };
      expect(req.header.authorization).toBeUndefined();
      if (mode === 'down') return 'fail';
      return { status: 200, data: { stores: [{ code: 'baoan' }], banners: [] }, header: mode === 'stale' ? { 'x-cache': 'stale' } : { 'x-cache': 'miss' } };
    });
    const api = await loadApi();
    expect(await api.show('/v1/home')).toEqual({ data: { stores: [{ code: 'baoan' }], banners: [] }, stale: false });
    mode = 'stale';
    expect((await api.show('/v1/home')).stale).toBe(true);
    mode = 'down';
    expect(await api.show('/v1/home')).toEqual({ data: { stores: [{ code: 'baoan' }], banners: [] }, stale: true });
    // 存的超过 7 天不用
    (fake.storage['tq_show:/v1/home'] as { at: number }).at = Date.now() - 8 * 86400 * 1000;
    await expect(api.show('/v1/home')).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('门店明确拒绝（如小程序还没开放）不拿旧内容顶', async () => {
    let open = true;
    installWx(() => (open ? { status: 200, data: { tickets: [], items: [] } } : { status: 403, data: { error: { code: 'MP_DISABLED', message: '小程序还没开放，请到前台咨询' } } }));
    const api = await loadApi();
    await api.show('/v1/prices');
    open = false;
    await expect(api.show('/v1/prices')).rejects.toMatchObject({ code: 'MP_DISABLED' });
  });

  it('图片地址走网关', async () => {
    installWx(() => ({ status: 200, data: {} }), 'develop');
    const api = await loadApi();
    expect(api.imageUrl(12)).toBe('http://127.0.0.1:8300/v1/images/12');
  });
});

describe('模拟微信', () => {
  it('开发版连模拟微信的网关：登录用 mock-<名字>，名字存在本机；换一个就是换了一个微信', async () => {
    const codes: string[] = [];
    const fake = installWx((req) => {
      const p = path(req.url);
      if (p === '/v1/health') return { status: 200, data: { ok: true, mockWechat: true, store: 'online' } };
      if (p === '/v1/login') {
        codes.push((req.data as { code: string }).code);
        return { status: 200, data: { token: 'v1.m' + codes.length, expiresAt: future() } };
      }
      return { status: 200, data: { bound: false, member: null } };
    }, 'develop');
    const api = await loadApi();
    expect(await api.mockWechat()).toBe(true);
    await api.member('GET', '/v1/me');
    expect(codes[0]).toMatch(/^mock-dev[a-z0-9]{8}$/);
    expect(fake.loginCodes).toBe(0);
    const before = codes[0];
    api.switchMockUser();
    await api.member('GET', '/v1/me');
    expect(codes[1]).toMatch(/^mock-dev[a-z0-9]{8}$/);
    expect(codes[1]).not.toBe(before);
  });

  it('正式版一律不用模拟：不问网关，用 wx.login 的 code', async () => {
    const fake = installWx((req) => {
      const p = path(req.url);
      if (p === '/v1/health') return { status: 200, data: { ok: true, mockWechat: true } };
      if (p === '/v1/login') return { status: 200, data: { token: 'v1.r', expiresAt: future() } };
      return { status: 200, data: { bound: false, member: null } };
    }, 'release');
    const api = await loadApi();
    expect(await api.mockWechat()).toBe(false);
    await api.member('GET', '/v1/me');
    expect(fake.loginCodes).toBe(1);
    expect(fake.requests.map((r) => path(r.url))).toEqual(['/v1/login', '/v1/me']);
  });

  it('体验版连真微信的网关：用 wx.login', async () => {
    const fake = installWx((req) => {
      const p = path(req.url);
      if (p === '/v1/health') return { status: 200, data: { ok: true, mockWechat: false } };
      if (p === '/v1/login') return { status: 200, data: { token: 'v1.t', expiresAt: future() } };
      return { status: 200, data: { bound: false, member: null } };
    }, 'trial');
    const api = await loadApi();
    await api.member('GET', '/v1/me');
    expect(fake.loginCodes).toBe(1);
    expect(fake.requests[0]!.url).toBe('https://api-test.domain.invalid/v1/health');
  });
});
