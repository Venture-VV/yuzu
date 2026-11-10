// 会员端提醒（RQ-014，接主线 8.0.4 批量发券的「会员端弹窗」，member-notices.ts；小程序线 src/server/modules/mp/notices.ts）：
//   · 小程序接口按这个微信此刻的绑定、门店营业日读：到账当天有「收到 N 张券」，到期前 N 天（营业日）起才有「券快到期了」；
//     只给标题、正文；新的在前、最多 20 条；券都用掉、作废的不再给；
//   · 记已读：只记这位会员自己的、只记一次；原样重提、同时重提不报错；别的会员的编号记不上；
//   · 解绑以后看不了、记不了；换绑到别的会员以后只看那位会员的，旧编号记不上；原来那位会员的提醒留着给之后绑上的人；
//   · 和解绑、换绑同时（小程序线测试 29aa0cc 的 P1）：读绑定与读、记提醒拿着同一把绑定状态的共享锁——请求先拿到锁的，解绑等它做完；
//     解绑、换绑先拿到的，请求等它提交、读到之后的绑定；记已读带看到提醒时的版本号，换绑以后才到的旧请求拒绝（BIND_STALE）、旧会员照旧没读；
//   · 参数核对（一次 1–20 条、编号不重复、要带绑定状态版本号）。网关的整条链路在 tests/gateway.test.ts。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CouponTemplate } from '../src/shared/coupons';
import { MP_GATEWAY_HEADER, MP_OPENID_HEADER, type MpNoticeRead, type MpNotices } from '../src/shared/mp';
import { buildMpApp } from '../src/server/modules/mp/app';
import { mpToday } from '../src/server/modules/mp/public';
import { api, createMember, setup, type TestContext } from './helpers';

const KEY = 'test-gateway-key-0123456789abcdef-0123';
let ctx: TestContext;
let mp: FastifyInstance;
let cash: CouponTemplate;

beforeAll(async () => {
  ctx = await setup();
  mp = await buildMpApp(ctx.sql, { ...ctx.config, mp: { ...ctx.config.mp, gatewayKey: KEY } }, { pay: null, sweepMs: 0 });
  await ctx.sql`INSERT INTO settings (key, value) VALUES ('mp_rules', ${ctx.sql.json({ enabled: true })})`;
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '提醒代金券', kind: 'cash', faceValue: 2000, validity: 'days', validDays: 10 });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  cash = t.body as CouponTemplate;
});
afterAll(async () => {
  await mp.close();
  await ctx.close();
});
afterEach(() => {
  vi.useRealTimers();
});

const call = (method: 'GET' | 'POST', url: string, openid: string, payload?: unknown) =>
  Promise.resolve(mp.inject({ method, url, headers: { [MP_GATEWAY_HEADER]: KEY, [MP_OPENID_HEADER]: openid }, ...(payload === undefined ? {} : { payload: payload as object }) }));
const listed = async (openid: string) => {
  const r = await call('GET', '/api/mp/notices', openid);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as MpNotices;
};
const notices = async (openid: string) => (await listed(openid)).notices;
/** 这个微信现在的绑定状态版本号 */
const versionOf = async (openid: string) => (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
/** 记已读：默认带这个微信现在的版本号（与小程序看到提醒时带回来的一样） */
const read = async (openid: string, ids: number[], bindVersion?: number) => {
  const r = await call('POST', '/api/mp/notices/read', openid, { ids, bindVersion: bindVersion ?? (await versionOf(openid)) });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as MpNoticeRead).read;
};

let n = 0;
async function bindPhone(openid: string, phone: string) {
  const version = (await call('GET', '/api/mp/me', openid)).json().bindVersion as number;
  const b = await call('POST', '/api/mp/bind', openid, { clientKey: randomUUID(), phone, bindVersion: version, mock: true });
  expect(b.statusCode, b.body).toBe(200);
}
async function bound(name: string): Promise<{ memberId: number; openid: string; phone: string }> {
  n += 1;
  const phone = `1377701${String(1000 + n)}`;
  const m = await createMember(ctx, name, phone);
  const openid = `openid-notice-${n}-${randomUUID().slice(0, 8)}`;
  await bindPhone(openid, phone);
  return { memberId: m.id, openid, phone };
}
const bindingIdOf = async (openid: string) =>
  (await ctx.sql<{ id: number }[]>`SELECT id FROM mp_bindings WHERE openid = ${openid} AND unbound_at IS NULL`)[0]!.id;
/** 前台解绑（不等结果）：员工端口 */
const unbindRequest = (bindingId: number) => api(ctx.app, ctx.owner, 'POST', `/api/admin/mp/bindings/${bindingId}/unbind`, { clientKey: randomUUID(), reason: '换微信' });
const unbind = async (openid: string) => {
  const r = await unbindRequest(await bindingIdOf(openid));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
/** 等到这个库里有 n 个会话在等锁：证明请求确实卡在预期的位置 */
async function waitForLockWaiters(count: number) {
  for (let i = 0; i < 150; i++) {
    const [row] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (row!.n >= count) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`等待 ${count} 个锁等待者超时`);
}
/** 在单独连接里开一个事务持锁，返回释放函数 */
async function hold(statement: (tx: typeof ctx.sql) => Promise<unknown>) {
  const conn = await ctx.sql.reserve();
  await conn.unsafe('BEGIN');
  await statement(conn as unknown as typeof ctx.sql);
  return async () => {
    await conn.unsafe('ROLLBACK');
    conn.release();
  };
}
/** 主线的批量发券：圈一个标签，每人 quantity 张，开会员端弹窗 */
async function campaign(memberIds: number[], quantity = 2, remindDays = 7) {
  const tag = await api(ctx.app, ctx.owner, 'POST', '/api/member-tags', { groupName: '提醒测试', name: `圈选${randomUUID().slice(0, 6)}` });
  expect(tag.status, JSON.stringify(tag.body)).toBeLessThan(300);
  await ctx.sql`INSERT INTO member_tag_links ${ctx.sql(memberIds.map((id) => ({ member_id: id, tag_id: tag.body.id, created_by: ctx.ownerId })))}`;
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/campaigns', {
    clientKey: randomUUID(),
    templateId: cash.id,
    quantity,
    audience: { tagIds: [tag.body.id] },
    reason: '小程序提醒测试',
    notifySms: false,
    notifyPopup: true,
    remindDays,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: number };
}
const noticeRows = (memberId: number) =>
  ctx.sql<{ id: number; kind: string; showFrom: string; readAt: Date | null }[]>`
    SELECT id, kind, show_from::text AS show_from, read_at FROM member_notices WHERE member_id = ${memberId} ORDER BY id`;
/** 门店时间（东八区）某天几点 */
const shopTime = (date: string, hour: number) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`);

describe('看提醒', () => {
  it('到账当天有「收到 N 张券」，只给标题与正文；到期前 7 天按门店营业日起才有「券快到期了」，新的在前', async () => {
    const a = await bound('演示·提醒甲');
    await campaign([a.memberId], 2, 7);
    const first = await notices(a.openid);
    expect(first).toEqual([{ id: expect.any(Number), kind: 'coupon_issued', title: '收到 2 张券', body: expect.stringContaining('「提醒代金券」×2') }]);
    expect(Object.keys(first[0]!).sort()).toEqual(['body', 'id', 'kind', 'title']);

    const expiring = (await noticeRows(a.memberId)).find((r) => r.kind === 'coupon_expiring')!;
    expect(expiring.showFrom > (await mpToday(ctx.sql, ctx.config.timezone))).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    // 那天早上 5 点还没到营业日切换（6 点）：营业日还是前一天，不给
    vi.setSystemTime(shopTime(expiring.showFrom, 5));
    expect((await notices(a.openid)).map((x) => x.kind)).toEqual(['coupon_issued']);
    vi.setSystemTime(shopTime(expiring.showFrom, 7));
    expect((await notices(a.openid)).map((x) => [x.kind, x.title])).toEqual([
      ['coupon_expiring', '券快到期了'],
      ['coupon_issued', '收到 2 张券'],
    ]);
  });

  it('券都用掉或作废了不再给；最多 20 条、新的在前', async () => {
    const b = await bound('演示·提醒乙');
    await campaign([b.memberId], 2);
    expect(await notices(b.openid)).toHaveLength(1);
    const coupons = await ctx.sql<{ id: number }[]>`SELECT id FROM coupons WHERE member_id = ${b.memberId} AND template_id = ${cash.id}`;
    // 作废一张：还有一张能用，照给
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/coupons/${coupons[0]!.id}/void`, { reason: '测试作废' })).status).toBe(200);
    expect(await notices(b.openid)).toHaveLength(1);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/coupons/${coupons[1]!.id}/void`, { reason: '测试作废' })).status).toBe(200);
    expect(await notices(b.openid)).toEqual([]);

    // 22 条不挂券的提醒：给最新的 20 条
    const today = await mpToday(ctx.sql, ctx.config.timezone);
    await ctx.sql`
      INSERT INTO member_notices (member_id, kind, title, body, show_from, show_until, dedupe_key)
      SELECT ${b.memberId}, 'coupon_issued', '第 ' || g || ' 条', '正文', ${today}::date, ${today}::date, 'mp-notice-test:' || ${b.memberId}::text || ':' || g
      FROM generate_series(1, 22) g`;
    const list = await notices(b.openid);
    expect(list).toHaveLength(20);
    expect(list[0]!.title).toBe('第 22 条');
    expect(list[19]!.title).toBe('第 3 条');
  });
});

describe('记已读', () => {
  it('只记一次：原样重提、同时重提都不报错；记过的不再给；别的会员的编号记不上', async () => {
    const c = await bound('演示·提醒丙');
    const d = await bound('演示·提醒丁');
    await campaign([c.memberId, d.memberId]);
    const [mine] = await notices(c.openid);
    const [theirs] = await notices(d.openid);
    expect(await read(c.openid, [mine!.id])).toEqual([mine!.id]);
    expect(await read(c.openid, [mine!.id])).toEqual([]);
    const together = await Promise.all([read(c.openid, [mine!.id]), read(c.openid, [mine!.id]), read(c.openid, [mine!.id])]);
    expect(together.flat()).toEqual([]);
    expect(await notices(c.openid)).toEqual([]);
    expect((await noticeRows(c.memberId)).find((r) => r.id === mine!.id)!.readAt).not.toBeNull();
    // 拿别人的编号来记：记不上，那位会员照样能看到
    expect(await read(c.openid, [theirs!.id, 999_999_999])).toEqual([]);
    expect((await noticeRows(d.memberId)).find((r) => r.id === theirs!.id)!.readAt).toBeNull();
    expect((await notices(d.openid)).map((x) => x.id)).toEqual([theirs!.id]);
  });

  it('解绑以后看不了、记不了；换绑到别的会员只看那位的，旧编号记不上；原来那位会员的提醒留给之后绑上的人', async () => {
    const e = await bound('演示·提醒戊');
    const f = await bound('演示·提醒己');
    await campaign([e.memberId]);
    await campaign([f.memberId], 3);
    const seen = await listed(e.openid);
    const [old] = seen.notices;
    await unbind(e.openid);
    for (const r of [await call('GET', '/api/mp/notices', e.openid), await call('POST', '/api/mp/notices/read', e.openid, { ids: [old!.id], bindVersion: seen.bindVersion })]) {
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('MP_NOT_BOUND');
    }
    // 同一个微信换绑到己：只看己的，版本号变了；带着看到戊的提醒时的版本号补发已读：拒绝，戊的照旧没读
    await unbind(f.openid);
    await bindPhone(e.openid, f.phone);
    const now = await listed(e.openid);
    expect(now.notices.map((x) => x.title)).toEqual(['收到 3 张券']);
    expect(now.bindVersion).toBeGreaterThan(seen.bindVersion);
    const stale = await call('POST', '/api/mp/notices/read', e.openid, { ids: [old!.id], bindVersion: seen.bindVersion });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('BIND_STALE');
    // 带现在的版本号拿戊的编号：按会员核对，也记不上
    expect(await read(e.openid, [old!.id], now.bindVersion)).toEqual([]);
    expect((await noticeRows(e.memberId)).find((r) => r.id === old!.id)!.readAt).toBeNull();
    // 之后有人绑上戊：戊的提醒还在
    const next = `openid-notice-next-${randomUUID().slice(0, 8)}`;
    await bindPhone(next, e.phone);
    expect((await notices(next)).map((x) => x.id)).toEqual([old!.id]);
  });

  it('参数：一次 1–20 条、编号是正整数、不重复；没开小程序会员功能时拒绝', async () => {
    const g = await bound('演示·提醒庚');
    const v = await versionOf(g.openid);
    for (const body of [
      {},
      { ids: [], bindVersion: v },
      { ids: Array.from({ length: 21 }, (_, i) => i + 1), bindVersion: v },
      { ids: [1, 1], bindVersion: v },
      { ids: [0], bindVersion: v },
      { ids: [1.5], bindVersion: v },
      { ids: ['1'], bindVersion: v },
      { ids: [1] },
      { ids: [1], bindVersion: -1 },
    ]) {
      const r = await call('POST', '/api/mp/notices/read', g.openid, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    await ctx.sql`UPDATE settings SET value = ${ctx.sql.json({ enabled: false })} WHERE key = 'mp_rules'`;
    try {
      const r = await call('GET', '/api/mp/notices', g.openid);
      expect(r.statusCode).toBe(403);
    } finally {
      await ctx.sql`UPDATE settings SET value = ${ctx.sql.json({ enabled: true })} WHERE key = 'mp_rules'`;
    }
  });
});

describe('和解绑、换绑同时（小程序线测试 29aa0cc 的 P1）', () => {
  it('请求先拿到绑定状态的锁：看、记都按这一刻的会员做完，解绑等它们做完才生效', async () => {
    const a = await bound('演示·提醒并发甲');
    await campaign([a.memberId]);
    await campaign([a.memberId], 3);
    const seen = await listed(a.openid);
    // 记已读的是「收到 2 张券」那条；「收到 3 张券」那条留着（看与记谁先跑完都一样能看到它）
    const id = seen.notices.find((x) => x.title === '收到 2 张券')!.id;
    const other = seen.notices.find((x) => x.title === '收到 3 张券')!.id;
    // 请求拿到绑定状态的锁、读了绑定以后，卡在提醒表上
    const release = await hold((tx) => tx`LOCK TABLE member_notices IN ACCESS EXCLUSIVE MODE`);
    const getting = call('GET', '/api/mp/notices', a.openid);
    const reading = call('POST', '/api/mp/notices/read', a.openid, { ids: [id], bindVersion: seen.bindVersion });
    await waitForLockWaiters(2);
    // 这时解绑：等在绑定状态的锁上
    const unbinding = unbindRequest(await bindingIdOf(a.openid));
    await waitForLockWaiters(3);
    expect((await ctx.sql`SELECT 1 FROM mp_bindings WHERE openid = ${a.openid} AND unbound_at IS NULL`).length).toBe(1);
    await release();
    const [g, r, u] = await Promise.all([getting, reading, unbinding]);
    // 看：按解绑之前的会员与版本号回答（记已读与它谁先跑完不一定，记过的那条可能已经不在）
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json().bindVersion).toBe(seen.bindVersion);
    expect(g.json().notices.map((x: { id: number }) => x.id)).toContain(other);
    // 记：解绑之前记的，照记
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ read: [id] });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    // 解绑之后：看不了、记不了
    expect((await call('GET', '/api/mp/notices', a.openid)).json().error.code).toBe('MP_NOT_BOUND');
  });

  it('解绑先拿到锁：请求等它提交，读到的是解绑以后（看不了、记不了），旧会员的提醒照旧没读', async () => {
    const b = await bound('演示·提醒并发乙');
    await campaign([b.memberId]);
    const seen = await listed(b.openid);
    const id = seen.notices[0]!.id;
    const bindingId = await bindingIdOf(b.openid);
    // 解绑拿到绑定状态的锁以后，卡在绑定记录一行上
    const release = await hold((tx) => tx`SELECT id FROM mp_bindings WHERE id = ${bindingId} FOR UPDATE`);
    const unbinding = unbindRequest(bindingId);
    await waitForLockWaiters(1);
    const getting = call('GET', '/api/mp/notices', b.openid);
    const reading = call('POST', '/api/mp/notices/read', b.openid, { ids: [id], bindVersion: seen.bindVersion });
    await waitForLockWaiters(3);
    await release();
    const [u, g, r] = await Promise.all([unbinding, getting, reading]);
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    for (const res of [g, r]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('MP_NOT_BOUND');
    }
    expect((await noticeRows(b.memberId)).find((x) => x.id === id)!.readAt).toBeNull();
  });

  it('换绑先拿到锁：请求等它提交，看的是换绑以后那位会员的（版本号新）；带旧版本号的记已读拒绝，旧会员照旧没读', async () => {
    const c = await bound('演示·提醒并发丙');
    const d = await bound('演示·提醒并发丁');
    await campaign([c.memberId]);
    await campaign([d.memberId], 3);
    const seen = await listed(c.openid);
    const id = seen.notices[0]!.id;
    await unbind(c.openid);
    await unbind(d.openid);
    // 同一个微信换绑到丁：绑定拿到绑定状态的锁以后，卡在作废登记表上
    const release = await hold((tx) => tx`LOCK TABLE mp_op_fences IN ACCESS EXCLUSIVE MODE`);
    const version = await versionOf(c.openid);
    const binding = call('POST', '/api/mp/bind', c.openid, { clientKey: randomUUID(), phone: d.phone, bindVersion: version, mock: true });
    await waitForLockWaiters(1);
    const getting = call('GET', '/api/mp/notices', c.openid);
    const reading = call('POST', '/api/mp/notices/read', c.openid, { ids: [id], bindVersion: seen.bindVersion });
    await waitForLockWaiters(3);
    await release();
    const [bd, g, r] = await Promise.all([binding, getting, reading]);
    expect(bd.statusCode, bd.body).toBe(200);
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json().notices.map((x: { title: string }) => x.title)).toEqual(['收到 3 张券']);
    expect(g.json().bindVersion).toBeGreaterThan(seen.bindVersion);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe('BIND_STALE');
    expect((await noticeRows(c.memberId)).find((x) => x.id === id)!.readAt).toBeNull();
  });
});
