// 邀请好友（第三期 3b）：邀请列表的字；发邀请码的「结果待确认」（存不了不发；结果不确定时原样重提同一个编号）；
// 好友领取的「结果待确认」（存不了、读不出来都不发；明确的结果删记录；结果不确定时请门店系统确认作废，已经领到了就回那一次；
// 连作废都发不出去时保留）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MpInviteClaimed, MpInviteItem } from '../../src/shared/mp';

type Reply = { status: number; data: unknown } | 'fail';

function installWx(routes: Record<string, Reply | (() => Reply)>, opts: { storageBroken?: string; storage?: Record<string, unknown>; readFails?: string } = {}) {
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
      const r = typeof route === 'function' ? route() : route;
      setTimeout(() => (!r || r === 'fail' ? o.fail({ errMsg: 'request:fail' }) : o.success({ statusCode: r.status, data: r.data, header: {} })), 0);
    },
  });
  return { storage, sent };
}

const load = async () => {
  vi.resetModules();
  return import('../src/utils/invites');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEY = '3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f';
const CODE = 'K7M2Q9X4PA';
const CLAIMED: MpInviteClaimed = { code: CODE, trial: { label: 'L1 云涧 · 初', startsOn: '2026-11-04', endsOn: '2026-11-11', status: 'active' }, bound: true, notice: null, replayed: false };

describe('邀请列表的字', () => {
  it('待领取写有效期、好友能体验什么；领了的写好友（只露第一个字）与体验到哪天', async () => {
    installWx({});
    const r = await load();
    const open: MpInviteItem = { code: CODE, state: 'open', label: 'L1 云涧 · 初', createdAt: '2026-11-04T02:00:00.000Z', expiresAt: '2026-11-11T02:00:00.000Z', friend: null };
    expect(r.inviteItemView(open)).toEqual({ code: CODE, state: 'open', stateText: '待领取', line: '好友能体验 L1 云涧 · 初', when: '11月11日前有效', open: true });
    const used: MpInviteItem = { ...open, state: 'used', friend: { name: '王*', trial: CLAIMED.trial } };
    expect(r.inviteItemView(used)).toMatchObject({ stateText: '已领取', line: '王* · 体验中，L1 云涧 · 初 至 11月11日', when: '11月4日发出', open: false });
    expect(r.claimedText(CLAIMED)).toBe('L1 云涧 · 初，体验到 11月11日');
  });
});

describe('发邀请码的「结果待确认」', () => {
  it('存不了不发；发出了删记录；结果不确定时保留，下次原样重提同一个编号', async () => {
    const w0 = installWx({ 'POST /v1/invites': { status: 201, data: { code: CODE, label: 'L1', expiresAt: '2026-11-11T00:00:00.000Z', replayed: false } } }, { storageBroken: 'tq_invite_create_pending' });
    const r0 = await load();
    expect(await r0.sendCreate(KEY, 3)).toMatchObject({ kind: 'rejected', code: 'PENDING_STORE_FAILED' });
    expect(w0.sent).toEqual([]);
    let reply: Reply = 'fail';
    const w = installWx({ 'POST /v1/invites': () => reply });
    const r = await load();
    expect((await r.sendCreate(KEY, 3)).kind).toBe('pending');
    expect(w.storage.tq_invite_create_pending).toMatchObject({ clientKey: KEY, bindVersion: 3 });
    reply = { status: 200, data: { code: CODE, label: 'L1', expiresAt: '2026-11-11T00:00:00.000Z', replayed: true } };
    expect(await r.retryCreate()).toMatchObject({ kind: 'created', created: { code: CODE } });
    expect(w.storage.tq_invite_create_pending).toBeUndefined();
    expect(w.sent.map((s) => (s.data as { clientKey: string }).clientKey)).toEqual([KEY, KEY]);
    // 没有待确认的：不发
    expect(await r.retryCreate()).toBeNull();
  });
});

describe('好友领取的「结果待确认」', () => {
  it('领到了删记录；门店系统明确拒绝（要填姓名）删记录、把原因给顾客看', async () => {
    const w = installWx({ ['POST /v1/invites/' + CODE + '/claim']: { status: 201, data: CLAIMED } });
    const r = await load();
    expect(await r.sendClaim(CODE, 'phone-code-1', ' 王小明 ', KEY, 2)).toEqual({ kind: 'claimed', claimed: CLAIMED });
    expect(w.sent).toEqual([{ path: 'POST /v1/invites/' + CODE + '/claim', data: { clientKey: KEY, phoneCode: 'phone-code-1', bindVersion: 2, name: '王小明' } }]);
    expect(w.storage.tq_invite_claim_pending).toBeUndefined();
    const w2 = installWx({ ['POST /v1/invites/' + CODE + '/claim']: { status: 400, data: { error: { code: 'NAME_REQUIRED', message: '你还不是会员：填一下姓名，就能开卡体验' } } } });
    const r2 = await load();
    expect(await r2.sendClaim(CODE, 'phone-code-2', '', KEY, 2)).toEqual({ kind: 'rejected', code: 'NAME_REQUIRED', message: '你还不是会员：填一下姓名，就能开卡体验' });
    expect(w2.storage.tq_invite_claim_pending).toBeUndefined();
    expect((w2.sent[0]!.data as Record<string, unknown>).name).toBeUndefined();
  });

  it('结果不确定：马上请门店系统确认作废——已经领到了回那一次；还没有就作废，可以重新领；连作废都发不出去时保留、不能再领', async () => {
    let abandon: Reply = { status: 200, data: { status: 'claimed', claimed: { ...CLAIMED, replayed: true } } };
    const w = installWx({ ['POST /v1/invites/' + CODE + '/claim']: 'fail', 'POST /v1/invites/claim/abandon': () => abandon });
    const r = await load();
    expect(await r.sendClaim(CODE, 'phone-code-1', '', KEY, 2)).toMatchObject({ kind: 'claimed', claimed: { replayed: true } });
    expect(w.storage.tq_invite_claim_pending).toBeUndefined();
    abandon = 'fail';
    expect((await r.sendClaim(CODE, 'phone-code-2', '', KEY, 2)).kind).toBe('pending');
    expect(w.storage.tq_invite_claim_pending).toMatchObject({ clientKey: KEY, code: CODE });
    // 还有待确认的：不发新的领取，先确认
    const before = w.sent.length;
    abandon = { status: 200, data: { status: 'abandoned' } };
    expect(await r.sendClaim(CODE, 'phone-code-3', '', 'b0b0b0b0-9b8a-4c7d-8e6f-5a4b3c2d1e0f', 2)).toEqual({ kind: 'abandoned' });
    expect(w.sent.slice(before).map((s) => s.path)).toEqual(['POST /v1/invites/claim/abandon']);
    expect(w.storage.tq_invite_claim_pending).toBeUndefined();
  });

  it('手机上的记录读不出来、存不了：不发', async () => {
    const w = installWx({ ['POST /v1/invites/' + CODE + '/claim']: { status: 201, data: CLAIMED } }, { readFails: 'tq_invite_claim_pending' });
    const r = await load();
    expect(await r.sendClaim(CODE, 'phone-code-1', '', KEY, 2)).toEqual({ kind: 'unreadable' });
    expect(w.sent).toEqual([]);
    const w2 = installWx({ ['POST /v1/invites/' + CODE + '/claim']: { status: 201, data: CLAIMED } }, { storageBroken: 'tq_invite_claim_pending' });
    const r2 = await load();
    expect(await r2.sendClaim(CODE, 'phone-code-1', '', KEY, 2)).toMatchObject({ kind: 'rejected', code: 'PENDING_STORE_FAILED' });
    expect(w2.sent).toEqual([]);
  });
});
