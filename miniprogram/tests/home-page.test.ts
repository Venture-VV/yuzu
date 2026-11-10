// 首页的会员端提醒（RQ-014）与换绑同时（小程序线测试 29aa0cc 的 P1）：用页面真实的代码（Page 的选项）与真实的提醒、网关模块，wx 换成假的。
//   · 换绑以前发出去、换绑以后才回来的旧回答（版本号比别的页面已经见过的旧）：丢掉，不放进弹窗；
//   · 弹着的是换绑以前那位会员的：回到首页时先关上、重新问，换成那位会员的；
//   · 点「知道了」：记已读带着看到这些提醒时的版本号。
import { afterEach, describe, expect, it, vi } from 'vitest';

type Opts = Record<string, unknown> & { data: Record<string, unknown> };
type Reply = { status: number; data: unknown };
interface HomePage {
  data: Record<string, unknown>;
  onLoad(): void;
  loadNotices(): Promise<void>;
  onShow(): void;
  onHide(): void;
  onNoticeOk(): void;
}

/** 可以晚一点再回答的请求 */
function later() {
  let resolve: (r: Reply) => void = () => undefined;
  const promise = new Promise<Reply>((r) => (resolve = r));
  return { promise, resolve };
}

async function loadPage(routes: Record<string, (data: unknown) => Reply | Promise<Reply>>) {
  let options: Opts | null = null;
  vi.stubGlobal('Page', (o: Opts) => (options = o));
  const storage: Record<string, unknown> = {};
  const sent: { path: string; data: unknown }[] = [];
  vi.stubGlobal('wx', {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0', appId: 'wx0' } }),
    getStorageSync: (k: string) => (k in storage ? storage[k] : ''),
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
      const reply =
        path === '/v1/login'
          ? Promise.resolve({ status: 200, data: { token: 'v1.t', expiresAt: new Date(Date.now() + 7 * 86400e3).toISOString() } })
          : routes[path]
            ? Promise.resolve(routes[path]!(o.data))
            : Promise.resolve(null);
      reply.then((r) => setTimeout(() => (!r ? o.fail({ errMsg: 'request:fail' }) : o.success({ statusCode: r.status, data: r.data, header: {} })), 0));
    },
    navigateTo: () => undefined,
  });
  vi.resetModules();
  await import('../src/pages/home/index');
  const api = await import('../src/utils/api');
  const o = options as unknown as Opts;
  const page: Record<string, unknown> & { data: Record<string, unknown> } = { ...o, data: { ...o.data } };
  page.setData = (d: Record<string, unknown>) => Object.assign(page.data, d);
  for (const k of Object.keys(o)) if (typeof o[k] === 'function') page[k] = (o[k] as (...a: unknown[]) => unknown).bind(page);
  // 页面加载（与微信一样先 onLoad：登记看绑定状态的变化、取门店信息）
  (page as unknown as HomePage).onLoad();
  return { page: page as unknown as HomePage, sent, api };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const notice = (id: number) => ({ id, kind: 'coupon_issued', title: `收到券 ${id}`, body: `正文 ${id}` });
const ids = (page: { data: Record<string, unknown> }) => (page.data.notices as { id: number }[]).map((n) => n.id);

/** 按调用的先后给回答：每次调用取下一个（可以是晚一点才回答的） */
function queue(...replies: (Reply | Promise<Reply>)[]) {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)]!;
}

describe('首页的会员端提醒与换绑同时', () => {
  it('旧会员的提醒先弹出来、更新的绑定状态晚一点才到：马上关上、重新问（小程序线测试 50ee567 的 P1 余项）', async () => {
    const firstNotices = later();
    const lateMe = later();
    const { page, api } = await loadPage({
      '/v1/me': queue({ status: 200, data: { bound: true, bindVersion: 1, member: null } }, lateMe.promise),
      '/v1/notices': queue(firstNotices.promise, { status: 403, data: { error: { code: 'MP_NOT_BOUND', message: '请先绑定会员' } } }),
    });
    await api.member('GET', '/v1/me');
    expect(api.latestBindVersion()).toBe(1);
    // 首页开始问会员 A 的提醒（回答晚一点）
    const asking = page.loadNotices();
    // 前台解绑；顾客进「我的」，「我的」的回答也晚一点；顾客先回到首页
    const meAsking = api.member('GET', '/v1/me');
    // A 的提醒先回来：这时还没见过更新的绑定状态，弹出来
    firstNotices.resolve({ status: 200, data: { notices: [notice(1)], bindVersion: 1 } });
    await asking;
    expect(page.data.noticeOpen).toBe(true);
    expect(ids(page)).toEqual([1]);
    // 「我的」晚到的回答（版本号 2，已经解绑）：首页马上关上、重新问；重新问是没绑定
    lateMe.resolve({ status: 200, data: { bound: false, bindVersion: 2, member: null } });
    await meAsking;
    expect(page.data.noticeOpen).toBe(false);
    await vi.waitFor(() => expect(ids(page)).toEqual([]));
    expect(page.data.noticeOpen).toBe(false);
  });

  it('换绑以前发出去、换绑以后才回来的旧回答：丢掉，不放进弹窗', async () => {
    const pending = later();
    const { page, api } = await loadPage({
      '/v1/notices': () => pending.promise,
      '/v1/me': () => ({ status: 200, data: { bound: true, bindVersion: 5, member: null } }),
      '/v1/notices/read': (data) => ({ status: 200, data: { read: (data as { ids: number[] }).ids } }),
    });
    const asking = page.loadNotices();
    // 问还没回来：在「我的」里解绑、换绑到另一位会员（「我的」看到的版本号是 5）
    await api.member('GET', '/v1/me');
    expect(api.latestBindVersion()).toBe(5);
    // 旧回答（版本号 3，换绑以前那位会员的）这时才到
    pending.resolve({ status: 200, data: { notices: [notice(1)], bindVersion: 3 } });
    await asking;
    expect(page.data.noticeOpen).toBe(false);
    expect(ids(page)).toEqual([]);
  });

  it('弹着的是换绑以前那位会员的：回到首页先关上、重新问，换成那位会员的；「知道了」带看到它们时的版本号', async () => {
    let version = 3;
    const { page, sent, api } = await loadPage({
      '/v1/notices': () => ({ status: 200, data: { notices: version === 3 ? [notice(1)] : [notice(2)], bindVersion: version } }),
      '/v1/me': () => ({ status: 200, data: { bound: true, bindVersion: version, member: null } }),
      '/v1/notices/read': (data) => ({ status: 200, data: { read: (data as { ids: number[] }).ids } }),
    });
    await page.loadNotices();
    expect(page.data.noticeOpen).toBe(true);
    expect(ids(page)).toEqual([1]);
    // 换绑（「我的」看到新的版本号 5），回到首页
    version = 5;
    await api.member('GET', '/v1/me');
    page.onShow();
    // 先关上：旧会员的提醒不再显示
    expect(page.data.noticeOpen).toBe(false);
    await vi.waitFor(() => expect(ids(page)).toEqual([2]));
    expect(page.data.noticeOpen).toBe(true);
    page.onNoticeOk();
    await vi.waitFor(() => expect(sent.some((x) => x.path === '/v1/notices/read')).toBe(true));
    expect(sent.filter((x) => x.path === '/v1/notices/read').map((x) => x.data)).toEqual([{ ids: [2], bindVersion: 5 }]);
  });
});

describe('离开首页再回来（小程序线测试 280b08a 的 P1）：回来以后弹的都是回来以后才问到的', () => {
  const unbound: Reply = { status: 403, data: { error: { code: 'MP_NOT_BOUND', message: '请先绑定会员' } } };
  const meReply = (bindVersion: number, bound = true): Reply => ({ status: 200, data: { bound, bindVersion, member: null } });

  for (const order of ['旧提醒先到', '新的绑定状态先到'] as const) {
    it(`去「我的」期间解绑了，离开之前发出去的旧提醒（${order}）：作废、不弹；回来重新问，没绑定就不弹`, async () => {
      const oldNotices = later();
      const lateMe = later();
      const { page, api } = await loadPage({
        '/v1/me': queue(meReply(1), lateMe.promise),
        '/v1/notices': queue(oldNotices.promise, unbound),
      });
      await api.member('GET', '/v1/me');
      const asking = page.loadNotices();
      // 离开首页去「我的」（前台这时解绑了）；「我的」的回答晚一点；顾客回到首页
      page.onHide();
      const meAsking = api.member('GET', '/v1/me');
      page.onShow();
      if (order === '新的绑定状态先到') {
        lateMe.resolve(meReply(2, false));
        await meAsking;
      }
      oldNotices.resolve({ status: 200, data: { notices: [notice(1)], bindVersion: 1 } });
      await asking;
      // 旧会员的提醒一刻也不弹
      expect(page.data.noticeOpen).toBe(false);
      expect(ids(page)).toEqual([]);
      if (order === '旧提醒先到') {
        lateMe.resolve(meReply(2, false));
        await meAsking;
      }
      await vi.waitFor(() => expect(page.data.noticeOpen).toBe(false));
      expect(ids(page)).toEqual([]);
    });
  }

  it('「我的」的绑定状态没取到（断网），也没解绑：回来重新问到的照常弹', async () => {
    const oldNotices = later();
    const { page, api } = await loadPage({
      '/v1/me': queue(meReply(1), { status: 503, data: { error: { code: 'STORE_OFFLINE', message: '门店系统连接中' } } }),
      '/v1/notices': queue(oldNotices.promise, { status: 200, data: { notices: [notice(1)], bindVersion: 1 } }),
    });
    await api.member('GET', '/v1/me');
    const asking = page.loadNotices();
    page.onHide();
    await expect(api.member('GET', '/v1/me')).rejects.toMatchObject({ code: 'STORE_OFFLINE' });
    page.onShow();
    oldNotices.resolve({ status: 200, data: { notices: [notice(1)], bindVersion: 1 } });
    await asking;
    await vi.waitFor(() => expect(page.data.noticeOpen).toBe(true));
    expect(ids(page)).toEqual([1]);
  });

  it('没换绑：弹着的离开时收起来，回来重新问到照旧弹；换绑了：回来弹的是新会员的', async () => {
    let version = 1;
    const { page, api } = await loadPage({
      '/v1/me': () => meReply(version),
      '/v1/notices': () => ({ status: 200, data: { notices: version === 1 ? [notice(1)] : [notice(2)], bindVersion: version } }),
    });
    await page.loadNotices();
    expect(ids(page)).toEqual([1]);
    page.onHide();
    expect(page.data.noticeOpen).toBe(false);
    page.onShow();
    await vi.waitFor(() => expect(page.data.noticeOpen).toBe(true));
    expect(ids(page)).toEqual([1]);
    // 离开期间换绑到另一位会员（版本号 3）
    page.onHide();
    version = 3;
    await api.member('GET', '/v1/me');
    page.onShow();
    await vi.waitFor(() => expect(ids(page)).toEqual([2]));
    expect(page.data.noticeOpen).toBe(true);
  });
});
