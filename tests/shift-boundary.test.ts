// G3 复测：交班与收款以班次为界（迁移 016）。用可控的锁等待制造确定的交错顺序。
//   · 充值、结账记到经办人当时未交班的班次，没开班的不记；交班表按班次汇总，不按单据时间；
//   · 正在入账、已拿到班次（共享锁）的收款：交班等它提交后再汇总，计入本班次（员工看到的应有现金已过期时 SHIFT_CHANGED）；
//   · 交班之后才拿到班次的收款，即使单据时间早于交班，也不记到已交的班次；
//   · 反结账提醒记到反结账人的班次，原收银员的班次不再计入被反结账的单。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/server/lib/context';
import { startShift } from '../src/server/modules/shifts';
import { api, createMember, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let memberId: number;

beforeAll(async () => {
  ctx = await setup();
  await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'A', from: 1, to: 20, width: 3, zone: 'male' });
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  memberId = (await createMember(ctx, '交班会员', '19900006001')).id;
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
/** 卡住同一操作编号的「写编号」一步：收款已拿到班次、写完单据，停在提交之前 */
const holdKey = (key: string) => hold((tx) => tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

const cashRecharge = (cookie: string, amount: number, key = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/recharges', { ...rechargeBody(memberId, amount, 0, { paymentMethod: 'cash' }), idempotencyKey: key });
const enter = async (code: string) =>
  (await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] })).body.visits[0].id as number;
/** 刚入场的散客：不含餐 12 小时档 ¥499，现金结清 */
const cashCheckout = (visitId: number, key = randomUUID()) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: key, visitIds: [visitId], expectedTotal: 49900, payments: [{ method: 'cash', amount: 49900 }] });
const open = async (cookie: string, openingCash = 0) => (await api(ctx.app, cookie, 'POST', '/api/shifts', { openingCash })).body as { id: number };
const current = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/shifts/current')).body.shift;
const close = (cookie: string, id: number, expectedCash: number) =>
  api(ctx.app, cookie, 'POST', `/api/shifts/${id}/close`, { countedCash: expectedCash, expectedCash });
const shiftOfRecharge = async (id: number) =>
  (await ctx.sql<{ shiftId: number | null; createdAt: string }[]>`SELECT shift_id, created_at FROM recharges WHERE id = ${id}`)[0]!;

describe('交班与收款以班次为界', () => {
  it('充值、结账记到经办人未交班的班次；没开班的不记；交班后的收款不再记到已交的班次', async () => {
    const shift = await open(ctx.clerk, 10000);
    const r = await cashRecharge(ctx.clerk, 30000);
    const c = await cashCheckout(await enter('A001'));
    expect([r.status, c.status]).toEqual([200, 200]);
    const o = await cashRecharge(ctx.owner, 20000);
    expect((await shiftOfRecharge(r.body.recharge.id)).shiftId).toBe(shift.id);
    expect((await shiftOfRecharge(o.body.recharge.id)).shiftId).toBeNull();
    const [k] = await ctx.sql<{ shiftId: number }[]>`SELECT shift_id FROM checkouts WHERE id = ${c.body.id}`;
    expect(k!.shiftId).toBe(shift.id);

    const cur = await current(ctx.clerk);
    expect(cur.summary.recharges).toMatchObject({ count: 1, paid: 30000 });
    expect(cur.summary.checkouts).toEqual({ count: 1, total: 49900 });
    expect(cur.summary.cash).toEqual({ opening: 10000, checkout: 49900, recharge: 30000, expected: 89900 });
    const closed = await close(ctx.clerk, shift.id, 89900);
    expect(closed.body).toMatchObject({ status: 'closed', expectedCash: 89900 });

    // 交班之后的收款：没有未交班的班次，不记班次；已交班的快照不变
    const after = await cashRecharge(ctx.clerk, 5000);
    expect((await shiftOfRecharge(after.body.recharge.id)).shiftId).toBeNull();
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/shifts/${shift.id}`)).body.summary.recharges).toMatchObject({ count: 1, paid: 30000 });
  });

  it('正在入账、已拿到班次的充值与结账：交班等它们提交后再汇总，计入本班次；员工看到的应有现金已过期时 SHIFT_CHANGED', async () => {
    const shift = await open(ctx.clerk);
    const visitId = await enter('A002');
    const k1 = randomUUID();
    const k2 = randomUUID();
    const release1 = await holdKey(k1);
    const release2 = await holdKey(k2);
    const recharging = cashRecharge(ctx.clerk, 30000, k1);
    await waitForLockWaiters(1);
    const paying = cashCheckout(visitId, k2);
    await waitForLockWaiters(2);
    // 两笔都还没提交：页面上的应有现金只有备用金；此时交班要等两笔收款放开班次
    expect((await current(ctx.clerk)).summary.cash.expected).toBe(0);
    const closing = close(ctx.clerk, shift.id, 0);
    await waitForLockWaiters(3);
    await release1();
    await release2();
    const [r, c, cl] = await Promise.all([recharging, paying, closing]);
    expect([r.status, c.status]).toEqual([200, 200]);
    expect(cl.status).toBe(409);
    expect(cl.body.error).toMatchObject({ code: 'SHIFT_CHANGED', details: { expectedCash: 79900 } });
    expect((await shiftOfRecharge(r.body.recharge.id)).shiftId).toBe(shift.id);

    // 刷新后按新的应有现金交班：快照包含这两笔
    const done = await close(ctx.clerk, shift.id, 79900);
    expect(done.status).toBe(200);
    expect(done.body.summary.recharges).toMatchObject({ count: 1, paid: 30000 });
    expect(done.body.summary.checkouts).toEqual({ count: 1, total: 49900 });
    expect(done.body.summary.cash.expected).toBe(79900);
  });

  it('结账刚查到班次、还没写结账单时交班到达（店主替交）：交班同样等它提交，不会漏记', async () => {
    const shift = await open(ctx.clerk);
    const visitId = await enter('A004');
    const key = randomUUID();
    // 另一个事务先占用同一操作编号的结账单（未提交）：结账查到班次后，写结账单时卡在唯一约束上
    const release = await hold((tx) => tx`
      INSERT INTO checkouts (checkout_no, client_key, total_amount, paid_amount, business_date, operator_id, created_at)
      VALUES ('JZ-HOLD', ${key}, 0, 0, ${today}, ${ctx.ownerId}, now())`);
    const paying = cashCheckout(visitId, key);
    await waitForLockWaiters(1);
    const closing = close(ctx.owner, shift.id, 0);
    await waitForLockWaiters(2);
    await release();
    const [c, cl] = await Promise.all([paying, closing]);
    expect(c.status).toBe(200);
    expect(cl.body.error).toMatchObject({ code: 'SHIFT_CHANGED', details: { expectedCash: 49900 } });
    const [k] = await ctx.sql<{ shiftId: number }[]>`SELECT shift_id FROM checkouts WHERE id = ${c.body.id}`;
    expect(k!.shiftId).toBe(shift.id);
    expect((await close(ctx.owner, shift.id, 49900)).body.summary.checkouts).toEqual({ count: 1, total: 49900 });
  });

  it('交班之后才拿到班次的收款：单据时间早于交班，也不记到已交的班次', async () => {
    const shift = await open(ctx.clerk);
    // 充值已取了时间、锁了会员，卡在当日充值单号上（还没查班次）
    const release = await hold((tx) => tx`
      INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES ('recharge', ${today}, 0)
      ON CONFLICT (doc_type, business_date) DO UPDATE SET last_no = doc_counters.last_no`);
    const late = cashRecharge(ctx.clerk, 20000);
    await waitForLockWaiters(1);
    const closed = await close(ctx.clerk, shift.id, 0);
    expect(closed.status).toBe(200);
    await release();
    const r = await late;
    expect(r.status).toBe(200);
    const row = await shiftOfRecharge(r.body.recharge.id);
    expect(row.shiftId).toBeNull();
    // 单据时间落在已交班次的开班到交班之间：按原来的时间窗口会算进这个班次、却不在快照里
    expect(new Date(row.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(closed.body.startedAt).getTime());
    expect(new Date(row.createdAt).getTime()).toBeLessThan(new Date(closed.body.endedAt).getTime());
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/shifts/${shift.id}`)).body.summary.recharges.count).toBe(0);
  });

  it('反结账提醒记到反结账人的班次；原收银员的班次不再计入被反结账的单', async () => {
    const clerkShift = await open(ctx.clerk);
    const ownerShift = await open(ctx.owner);
    const c = await cashCheckout(await enter('A003'));
    expect((await current(ctx.clerk)).summary.cash.expected).toBe(49900);
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${c.body.id}/void`, { reason: '收款方式记错' });
    expect(v.status).toBe(200);
    const [k] = await ctx.sql<{ shiftId: number; voidShiftId: number }[]>`SELECT shift_id, void_shift_id FROM checkouts WHERE id = ${c.body.id}`;
    expect(k).toEqual({ shiftId: clerkShift.id, voidShiftId: ownerShift.id });
    const mine = await current(ctx.clerk);
    expect(mine.summary.checkouts).toEqual({ count: 0, total: 0 });
    expect(mine.summary.voids).toEqual([]);
    const boss = await current(ctx.owner);
    expect(boss.summary.voids).toEqual([{ checkoutNo: c.body.checkoutNo, amount: 49900, reason: '收款方式记错', voidedAt: expect.any(String) }]);
    expect((await close(ctx.owner, ownerShift.id, 0)).body.summary.voids).toHaveLength(1);
    expect((await close(ctx.clerk, clerkShift.id, 0)).status).toBe(200);
    // 反结账字段之外，结账单记下的班次不能改
    await expect(ctx.sql`UPDATE checkouts SET shift_id = NULL WHERE id = ${c.body.id}`).rejects.toThrow(/只能反结账/);
  });

  it('升级后开的班次只按班次汇总：没有记班次的单据即使在开班之后，也不算进来', async () => {
    const r = await cashRecharge(ctx.clerk, 7000);
    expect((await shiftOfRecharge(r.body.recharge.id)).shiftId).toBeNull();
    const clerk: Actor = { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false };
    const s = await startShift({ sql: ctx.sql, config: ctx.config }, { openingCash: 0 }, { actor: clerk, at: new Date(Date.now() - 3_600_000) });
    expect(s.summary.recharges.count).toBe(0);
    expect((await close(ctx.clerk, s.id, 0)).status).toBe(200);
  });
});
