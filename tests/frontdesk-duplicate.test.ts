// 同一操作编号的两次提交并发（网络重试时同时提交两次）：后到的那次返回第一次的结果，
// 不再提示「被其他终端发出 / 开台」「刚刚已换过牌」「已结账」等（店主 2026-10-30 的观察；见 frontdesk/common.ts runIdempotent）。
// 用可控的锁等待制造确定的交错顺序：第一次拿到手牌 / 桌台 / 来访 / 开台的锁之后，卡在单号计数行（或来访行、估清行）上；
// 第二次（同一编号、同一内容）开头查编号时第一次还没提交，接着排在第一次的锁后面。放行后第一次提交，第二次拿到锁。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let boss: string;
let today: string;
let dish: number;
const table: Record<string, number> = {};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'boss', displayName: '店总', role: 'store_manager', password: PASSWORD, mustChangePassword: false });
  boss = await login(ctx.app, 'boss');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'D', from: 1, to: 20, width: 3, zone: 'male' })).status).toBe(200);
  // 餐饮：一个档口、一道进厨房的菜、三张桌
  const station = (await api(ctx.app, boss, 'POST', '/api/admin/dining/stations', { name: '热菜' })).body.stations.find((s: { name: string }) => s.name === '热菜').id;
  dish = (await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '宫保鸡丁', category: '热菜', price: 4800 })).body.items.find((i: { name: string }) => i.name === '宫保鸡丁').id;
  expect((await api(ctx.app, boss, 'PUT', '/api/admin/dining/items', { items: [{ id: dish, stationId: station }] })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
  for (const name of ['B1', 'B2', 'B3']) {
    const r = await api(ctx.app, boss, 'POST', '/api/admin/dining/tables', { name, area: '大厅', seats: 4 });
    table[name] = r.body.tables.find((t: { name: string }) => t.name === name).id;
  }
});
afterAll(async () => ctx.close());

/** 等到有 n 个会话在等锁，证明请求确实卡在预期的位置 */
async function waitForLockWaiters(n: number) {
  for (let i = 0; i < 100; i++) {
    const [row] = await ctx.sql<{ n: number }[]>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (row!.n >= n) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`等待 ${n} 个锁等待者超时`);
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

/** 占住今天某类单号的计数行：第一次拿到业务行的锁之后卡在取单号上 */
const holdCounter = (docType: string) =>
  hold((tx) => tx`
    INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES (${docType}, ${today}, 0)
    ON CONFLICT (doc_type, business_date) DO UPDATE SET last_no = doc_counters.last_no`);

/** 第一次卡在 release 之前，第二次排在第一次的锁后面；放行后两次都返回 */
async function race<T>(release: () => Promise<void>, first: () => Promise<T>, second = first): Promise<[T, T]> {
  const a = first();
  await waitForLockWaiters(1);
  const b = second();
  await waitForLockWaiters(2);
  await release();
  return Promise.all([a, b]);
}

const checkinBody = (tagCode: string, extra: Record<string, unknown> = {}) => ({ clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', ...extra }] });
const openOnTag = async (code: string) =>
  (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${code} AND v.status = 'open'`)[0]!.n;
const selfCheck = async () => {
  for (const k of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
    expect(k.ok, `${k.label}：${k.detail}`).toBe(true);
  }
};

describe('同一编号同时提交两次：后到的那次返回第一次的结果', () => {
  it('接待：只发一张牌，两次拿到同一来访（不提示手牌已在店）', async () => {
    const body = checkinBody('D001');
    const [a, b] = await race(await holdCounter('bill'), () => api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', body));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.visits[0].visitNo).toBe(a.body.visits[0].visitNo);
    expect(await openOnTag('D001')).toBe(1);
    await selfCheck();
  });

  it('不同编号（真的是另一台终端）照旧提示手牌已在店；同一编号换了内容提示编号已用于另一笔', async () => {
    const [a, b] = await race(
      await holdCounter('bill'),
      () => api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', checkinBody('D002')),
      () => api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', checkinBody('D002')),
    );
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('TAG_OCCUPIED');

    const body = checkinBody('D003');
    const [c, d] = await race(
      await holdCounter('bill'),
      () => api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', body),
      () => api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { ...body, guests: [{ ...body.guests[0], guestLabel: '王先生' }] }),
    );
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await openOnTag('D002')).toBe(1);
    expect(await openOnTag('D003')).toBe(1);
  });

  it('换牌：只换一次，后到的那次也返回成功（不提示刚刚已换过牌）', async () => {
    const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', checkinBody('D004'));
    const visitId = v.body.visits[0].id as number;
    const body = { clientKey: randomUUID(), toTagCode: 'D005', reason: '柜门坏了' };
    // 第一次锁上新旧两张手牌后，卡在来访行上；第二次排在手牌锁后面
    const release = await hold((tx) => tx`SELECT id FROM visits WHERE id = ${visitId} FOR UPDATE`);
    const [a, b] = await race(release, () => api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/swap`, body));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    // 两次返回同一位客人的同一份详情（serverTime 是各自的响应时间）
    expect({ ...b.body, serverTime: null }).toEqual({ ...a.body, serverTime: null });
    expect(await openOnTag('D004')).toBe(0);
    expect(await openOnTag('D005')).toBe(1);
    const [swaps] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM visit_tag_changes WHERE visit_id = ${visitId}`;
    expect(swaps!.n).toBe(1);
    await selfCheck();
  });

  it('结账：只结一次，两次拿到同一结账单（不提示客人已结账）', async () => {
    const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', checkinBody('D006'));
    const visitId = v.body.visits[0].id as number;
    const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
    const body = { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: pre.totalAmount, payments: [{ method: 'wechat', amount: pre.totalAmount }] };
    const [a, b] = await race(await holdCounter('checkout'), () => api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', body));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    const [checkouts] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM checkouts WHERE client_key = ${body.clientKey}`;
    expect(checkouts!.n).toBe(1);
    await selfCheck();
  });

  it('开台：只开一桌，两次拿到同一开台（不提示桌台正在用餐）', async () => {
    const body = { clientKey: randomUUID(), tableId: table.B1, guests: 2 };
    const [a, b] = await race(await holdCounter('bill'), () => api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', body));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    const [sessions] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM table_sessions WHERE table_id = ${table.B1!}`;
    expect(sessions!.n).toBe(1);
  });

  it('桌台点单（最后一份）：只下一次单，后到的那次不提示已估清；桌台结账只结一次', async () => {
    const s = (await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId: table.B2, guests: 2 })).body as { id: number };
    expect((await api(ctx.app, ctx.clerk, 'PUT', `/api/kitchen/limits/${dish}`, { remaining: 1 })).status).toBe(200);
    const orderBody = { clientKey: randomUUID(), lines: [{ itemId: dish, quantity: 1 }], expectedTotal: 4800 };
    // 第一次锁上开台、账单之后卡在估清行上；第二次排在开台锁后面
    const releaseLimit = await hold((tx) => tx`SELECT item_id FROM dish_limits WHERE item_id = ${dish} AND business_date = ${today} FOR UPDATE`);
    const [a, b] = await race(releaseLimit, () => api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${s.id}/orders`, orderBody));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const [limit] = await ctx.sql<{ remaining: number }[]>`SELECT remaining FROM dish_limits WHERE item_id = ${dish} AND business_date = ${today}`;
    expect(limit!.remaining).toBe(0);
    const [lines] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bill_lines l JOIN table_sessions s ON s.bill_id = l.bill_id WHERE s.id = ${s.id}`;
    expect(lines!.n).toBe(1);

    const payBody = { clientKey: randomUUID(), sessionIds: [s.id], expectedTotal: 4800, payments: [{ method: 'wechat', amount: 4800 }] };
    const [c, d] = await race(await holdCounter('checkout'), () => api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/checkout', payBody));
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.id).toBe(c.body.id);
    const [checkouts] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM checkouts WHERE client_key = ${payBody.clientKey}`;
    expect(checkouts!.n).toBe(1);
    await selfCheck();
  });
});
