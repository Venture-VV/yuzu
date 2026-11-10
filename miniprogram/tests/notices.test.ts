// 会员端提醒（RQ-014）：首页问到的提醒、看过记已读（先记在手机上；门店系统回了才删；断网、出错时留着，下次先补发、补发前不再弹；
// 明确拒绝的不再发；存不了也照样发；一次最多 20 条）。哪位会员的由门店系统按绑定核对，这里只管发、留、删。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MpNotice } from '../../src/shared/mp';

type Reply = { status: number; data: unknown } | 'fail';

function installWx(
  routes: Record<string, Reply | ((data: unknown) => Reply)>,
  opts: { storageBroken?: boolean; removeBroken?: boolean; storage?: Record<string, unknown> } = {},
) {
  const storage: Record<string, unknown> = opts.storage ?? {};
  const sent: { path: string; data: unknown }[] = [];
  vi.stubGlobal('wx', {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0', appId: 'wx0' } }),
    getStorageSync: (k: string) => (k in storage ? storage[k] : ''),
    setStorageSync: (k: string, v: unknown) => {
      if (opts.storageBroken && k === 'tq_notice_read_pending') throw new Error('存储空间已满');
      storage[k] = JSON.parse(JSON.stringify(v));
    },
    removeStorageSync: (k: string) => {
      if (opts.removeBroken && k === 'tq_notice_read_pending') throw new Error('removeStorageSync:fail');
      delete storage[k];
    },
    login: (o: { success: (r: { code: string }) => void }) => o.success({ code: 'wxcode' }),
    request: (o: { url: string; data: unknown; success: (r: unknown) => void; fail: (e: unknown) => void }) => {
      const path = o.url.replace(/^https?:\/\/[^/]+/, '');
      if (path !== '/v1/login') sent.push({ path, data: o.data });
      const route = path === '/v1/login' ? { status: 200, data: { token: 'v1.t', expiresAt: new Date(Date.now() + 7 * 86400e3).toISOString() } } : routes[path];
      const r = typeof route === 'function' ? route(o.data) : route;
      setTimeout(() => (!r || r === 'fail' ? o.fail({ errMsg: 'request:fail' }) : o.success({ statusCode: r.status, data: r.data, header: {} })), 0);
    },
  });
  return { storage, sent };
}

const load = async () => {
  vi.resetModules();
  return import('../src/utils/notices');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const N = (id: number, kind = 'coupon_issued'): MpNotice => ({ id, kind, title: `提醒 ${id}`, body: `正文 ${id}` });
const LIST = (...n: MpNotice[]) => ({ status: 200, data: { notices: n } });
const READ = (data: unknown) => ({ status: 200, data: { read: (data as { ids: number[] }).ids } });

describe('问提醒', () => {
  it('有就给出标题、正文；券的提醒标出来（多一个「看我的券」）；别的种类照样显示', async () => {
    installWx({ '/v1/notices': LIST(N(3), N(2, 'coupon_expiring'), N(1, 'something_new')) });
    const m = await load();
    expect(await m.loadNotices()).toEqual([
      { id: 3, title: '提醒 3', body: '正文 3', coupon: true },
      { id: 2, title: '提醒 2', body: '正文 2', coupon: true },
      { id: 1, title: '提醒 1', body: '正文 1', coupon: false },
    ]);
  });

  it('没绑定、会员功能没开：没有（不弹、不报错）；门店连不上、出错、断网：问不到（null，页面上弹着的照旧）', async () => {
    for (const [reply, expected] of [
      [{ status: 403, data: { error: { code: 'MP_NOT_BOUND', message: '请先绑定会员' } } }, []],
      [{ status: 403, data: { error: { code: 'MP_DISABLED', message: '小程序会员功能还没开放' } } }, []],
      [{ status: 503, data: { error: { code: 'STORE_OFFLINE', message: '门店系统连接中' } } }, null],
      [{ status: 500, data: { error: { code: 'INTERNAL', message: '出错了' } } }, null],
      ['fail' as const, null],
    ] as const) {
      installWx({ '/v1/notices': reply as Reply });
      const m = await load();
      expect(await m.loadNotices()).toEqual(expected);
    }
  });
});

describe('记已读', () => {
  it('先记在手机上再发；记上了就删', async () => {
    const { storage, sent } = installWx({ '/v1/notices/read': READ });
    const m = await load();
    await m.markRead([5, 4]);
    expect(sent).toEqual([{ path: '/v1/notices/read', data: { ids: [5, 4] } }]);
    expect(storage.tq_notice_read_pending).toBeUndefined();
  });

  it('断网、门店出错：留在手机上；下次问之前先补发，补发前这几条不再弹；补发成功才删', async () => {
    let up = false;
    const { storage, sent } = installWx({
      '/v1/notices/read': (data) => (up ? READ(data) : 'fail'),
      '/v1/notices': LIST(N(5), N(4), N(9)),
    });
    const m = await load();
    await m.markRead([5, 4]);
    expect(storage.tq_notice_read_pending).toEqual([5, 4]);
    // 补发还是失败：只弹没看过的那条
    expect((await m.loadNotices())!.map((n) => n.id)).toEqual([9]);
    expect(storage.tq_notice_read_pending).toEqual([5, 4]);
    // 网络好了（下次打开）：先补发，再问
    up = true;
    sent.length = 0;
    const next = await load();
    expect((await next.loadNotices())!.map((n) => n.id)).toEqual([5, 4, 9]);
    expect(sent.map((x) => x.path)).toEqual(['/v1/notices/read', '/v1/notices']);
    expect(sent[0]!.data).toEqual({ ids: [5, 4] });
    expect(storage.tq_notice_read_pending).toBeUndefined();
  });

  it('门店出错（5xx）也留着，和之前没确认的放在一起', async () => {
    const { storage } = installWx({ '/v1/notices/read': { status: 500, data: { error: { code: 'INTERNAL', message: '出错了' } } } }, { storage: { tq_notice_read_pending: [7] } });
    const m = await load();
    await m.markRead([8, 7]);
    expect(storage.tq_notice_read_pending).toEqual([7, 8]);
  });

  it('门店系统明确拒绝（已经解绑、编号不对）：不再发，删掉', async () => {
    const { storage, sent } = installWx(
      { '/v1/notices/read': { status: 403, data: { error: { code: 'MP_NOT_BOUND', message: '请先绑定会员' } } }, '/v1/notices': LIST() },
      { storage: { tq_notice_read_pending: [11, 12] } },
    );
    const m = await load();
    expect(await m.loadNotices()).toEqual([]);
    expect(storage.tq_notice_read_pending).toBeUndefined();
    expect(sent.filter((x) => x.path === '/v1/notices/read')).toHaveLength(1);
    // 太频繁（429）不算回了：留着
    const { storage: s2 } = installWx({ '/v1/notices/read': { status: 429, data: { error: { code: 'TOO_MANY', message: '操作太频繁' } } } });
    const m2 = await load();
    await m2.markRead([13]);
    expect(s2.tq_notice_read_pending).toEqual([13]);
  });

  it('一次最多 20 条：多的分几次发；手机上存不了也照样发这一次', async () => {
    const { sent, storage } = installWx({ '/v1/notices/read': READ });
    const m = await load();
    const ids = Array.from({ length: 45 }, (_, i) => i + 1);
    await m.markRead(ids);
    expect(sent.map((x) => (x.data as { ids: number[] }).ids.length)).toEqual([20, 20, 5]);
    expect(storage.tq_notice_read_pending).toBeUndefined();

    const broken = installWx({ '/v1/notices/read': READ }, { storageBroken: true });
    const m2 = await load();
    await m2.markRead([30, 31]);
    expect(broken.sent).toEqual([{ path: '/v1/notices/read', data: { ids: [30, 31] } }]);
  });

  it('手机上的记录改不了（存储写坏了）：补发每批只发一次，不把同一批一直重发，接着照常问提醒（Codex 审查 53df24f 的 P2）', async () => {
    const stored = Array.from({ length: 21 }, (_, i) => i + 1);
    for (const opts of [{ storageBroken: true }, { storageBroken: true, removeBroken: true }]) {
      const { sent, storage } = installWx({ '/v1/notices/read': READ, '/v1/notices': LIST(N(30)) }, { ...opts, storage: { tq_notice_read_pending: stored.slice() } });
      const m = await load();
      expect((await m.loadNotices())!.map((n) => n.id)).toEqual([30]);
      expect(sent.map((x) => [x.path, x.path === '/v1/notices/read' ? (x.data as { ids: number[] }).ids.length : 0])).toEqual([
        ['/v1/notices/read', 20],
        ['/v1/notices/read', 1],
        ['/v1/notices', 0],
      ]);
      // 改不了、删不掉的照旧留着（下次打开再补一次，还是每批一次）；最后一批发完能整个删掉的就删了
      if (opts.removeBroken) expect(storage.tq_notice_read_pending).toEqual(stored);
      else expect(storage.tq_notice_read_pending).toBeUndefined();
    }
  });

  it('补发与这一次同时：这一次的编号也发出去，不会漏', async () => {
    let calls = 0;
    const { sent, storage } = installWx({ '/v1/notices/read': (data) => (calls++, READ(data)), '/v1/notices': LIST() }, { storage: { tq_notice_read_pending: [1] } });
    const m = await load();
    await Promise.all([m.loadNotices(), m.markRead([2])]);
    const all = sent.filter((x) => x.path === '/v1/notices/read').flatMap((x) => (x.data as { ids: number[] }).ids);
    expect(all.sort()).toEqual([1, 2]);
    expect(storage.tq_notice_read_pending).toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
