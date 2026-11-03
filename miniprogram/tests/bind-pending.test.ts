// 绑定会员的「结果待确认」（Codex 审查 PR #42 的 P1）：存不了不发；明确的结果删记录；
// 结果不确定时请门店系统确认作废，以它的回答为准；连作废都发不出去时保留记录，之后再确认。
import { afterEach, describe, expect, it, vi } from 'vitest';

type Reply = { status: number; data: unknown } | 'fail';

function installWx(routes: Record<string, Reply | (() => Reply)>, opts: { storageBroken?: boolean } = {}) {
  const storage: Record<string, unknown> = {};
  const sent: { path: string; data: unknown }[] = [];
  vi.stubGlobal('wx', {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0', appId: 'wx0' } }),
    getStorageSync: (k: string) => (k in storage ? storage[k] : ''),
    setStorageSync: (k: string, v: unknown) => {
      if (opts.storageBroken && k === 'tq_bind_pending') throw new Error('存储空间已满');
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
  return import('../src/utils/bind-pending');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = '3f2b0d6e-1c4a-4b8e-9f0a-0c1d2e3f4a5b';

describe('绑定的结果待确认', () => {
  it('手机存不下操作编号：不发请求', async () => {
    const { sent } = installWx({}, { storageBroken: true });
    const m = await load();
    const r = await m.sendBind('code-1', KEY);
    expect(r).toMatchObject({ kind: 'rejected', code: 'PENDING_STORE_FAILED' });
    expect(sent).toEqual([]);
  });

  it('绑上了、门店系统明确拒绝：删掉待确认记录', async () => {
    let env = installWx({ '/v1/bind': { status: 200, data: { status: 'bound', member: { name: '沈先生' }, replayed: false } } });
    let m = await load();
    expect(await m.sendBind('code-1', KEY)).toEqual({ kind: 'bound' });
    expect(env.storage.tq_bind_pending).toBeUndefined();
    expect(env.sent).toEqual([{ path: '/v1/bind', data: { phoneCode: 'code-1', clientKey: KEY } }]);

    env = installWx({ '/v1/bind': { status: 404, data: { error: { code: 'NOT_MEMBER', message: '这个手机号还不是会员，请到前台开卡' } } } });
    m = await load();
    expect(await m.sendBind('code-2', KEY)).toEqual({ kind: 'rejected', code: 'NOT_MEMBER', message: '这个手机号还不是会员，请到前台开卡' });
    expect(env.storage.tq_bind_pending).toBeUndefined();
  });

  it('断网：请门店系统作废这个编号；没绑上就是没绑上（作废了），绑上了就是绑上', async () => {
    let env = installWx({ '/v1/bind': 'fail', '/v1/bind/abandon': { status: 200, data: { status: 'abandoned' } } });
    let m = await load();
    expect(await m.sendBind('code-1', KEY)).toEqual({ kind: 'abandoned' });
    expect(env.sent.map((s) => s.path)).toEqual(['/v1/bind', '/v1/bind/abandon']);
    expect(env.sent[1]!.data).toEqual({ clientKey: KEY });
    expect(env.storage.tq_bind_pending).toBeUndefined();

    // 门店出错（5xx，可能已经绑上了）：作废时门店系统回「已绑定」
    env = installWx({
      '/v1/bind': { status: 500, data: { error: { code: 'INTERNAL', message: '门店系统出了点问题，请稍后再试' } } },
      '/v1/bind/abandon': { status: 200, data: { status: 'bound', member: { name: '沈先生' }, replayed: true } },
    });
    m = await load();
    expect(await m.sendBind('code-1', KEY)).toEqual({ kind: 'bound' });
    expect(env.storage.tq_bind_pending).toBeUndefined();
  });

  it('作废也发不出去：记录保留（确认之前不能再绑），网络好了再确认', async () => {
    let online = false;
    const env = installWx({
      '/v1/bind': 'fail',
      '/v1/bind/abandon': () => (online ? { status: 200, data: { status: 'abandoned' } } : { status: 503, data: { error: { code: 'STORE_OFFLINE', message: '门店系统连接中，请稍后再试' } } }),
    });
    const m = await load();
    expect(await m.sendBind('code-1', KEY)).toEqual({ kind: 'pending', message: '门店系统连接中，请稍后再试' });
    expect(m.readBindPending()).toMatchObject({ clientKey: KEY });
    online = true;
    expect(await m.resolveBindPending()).toEqual({ kind: 'abandoned' });
    expect(m.readBindPending()).toBeNull();
    expect(env.sent.filter((s) => s.path === '/v1/bind/abandon').every((s) => (s.data as { clientKey: string }).clientKey === KEY)).toBe(true);
    // 没有待确认的：不用确认
    expect(await m.resolveBindPending()).toBeNull();
  });
});
