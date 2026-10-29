// G3 复测：交班与收款以班次为界（迁移 016）。用可控的锁等待制造确定的交错顺序。
//   · 充值、结账记到经办人当时未交班的班次，没开班的不记；交班表按班次汇总，不按单据时间；
//   · 收款先拿到班次（共享锁）：交班等它提交后再汇总，计入本班次（员工看到的应有现金已过期时 SHIFT_CHANGED）；
//   · 交班先拿到班次（排他锁）：收款开始处理时在这个班次上的，等交班提交后整笔拒绝（SHIFT_CLOSED），不入账——
//     不会出现「开班期间发起、交班之后完成、哪个班次都不算」的收款；开新班后原样重提记到新班次；
//   · 升级时仍未交班的旧班次（迁移 016 前开班）同样适用；
//   · 反结账退款记到反结账人的班次、现金扣减应有现金；原收银员的班次仍算这笔收款（R1.2，店主 2026-10-29 签认）；
//     规则关闭、反结账的人没有开班时退款没有记到任何班次，原单也不再计入收款时的班次。
// 注意：收款持有班次共享锁时被测试卡住，交班会等这笔收款——测试先发出交班请求、确认在等锁，再放开，不能同步等交班返回。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/server/lib/context';
import { startShift } from '../src/server/modules/shifts';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

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
/** 占住当日充值单号：充值已拿到班次，卡在取号上 */
const holdRechargeNo = () =>
  hold((tx) => tx`
    INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES ('recharge', ${today}, 0)
    ON CONFLICT (doc_type, business_date) DO UPDATE SET last_no = doc_counters.last_no`);
/** 卡住审计写入：交班已对班次加排他锁、算好快照、改了状态，写交班审计时停在提交之前 */
const holdAudit = () => hold((tx) => tx`LOCK TABLE audit_logs IN SHARE MODE`);

const cashRecharge = (cookie: string, amount: number, key = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/recharges', { ...rechargeBody(memberId, amount, 0, { paymentMethod: 'cash' }), idempotencyKey: key });
const enter = async (code: string) =>
  (await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] })).body.visits[0].id as number;
/** 刚入场的散客：不含餐 12 小时档 ¥499，现金结清 */
const cashCheckout = (visitId: number, key = randomUUID(), cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', '/api/frontdesk/checkouts', { clientKey: key, visitIds: [visitId], expectedTotal: 49900, payments: [{ method: 'cash', amount: 49900 }] });
const open = async (cookie: string, openingCash = 0) => (await api(ctx.app, cookie, 'POST', '/api/shifts', { openingCash })).body as { id: number };
const current = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/shifts/current')).body.shift;
/** 交班：实点等于应有现金（应有现金为负时实点 0，例如备用金为 0 的值班经理反结账了别人的现金单） */
const close = (cookie: string, id: number, expectedCash: number) =>
  api(ctx.app, cookie, 'POST', `/api/shifts/${id}/close`, { countedCash: Math.max(0, expectedCash), expectedCash });
const shiftOfRecharge = async (id: number) =>
  (await ctx.sql<{ shiftId: number | null; createdAt: string }[]>`SELECT shift_id, created_at FROM recharges WHERE id = ${id}`)[0]!;
/** ¥499 结账：现金 100 + 美团券 399 */
const couponCheckout = (visitId: number, code: string) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: 49900,
    payments: [
      { method: 'cash', amount: 10000 },
      { method: 'coupon', platform: 'meituan', code, dealName: '不含餐门票', amount: 39900 },
    ],
  });
/**
 * 交班表各项互相一致：收款方式合计 = 结账合计，团购平台合计 = 团购券收款，现金 = 现金收款，充值方式合计 = 充值实收，
 * 退款方式合计 = 反结账合计，应有现金 = 备用金 + 结账现金 + 充值现金 − 反结账退现金
 */
function expectConsistent(s: {
  checkouts: { total: number };
  checkoutByMethod: { method: string; amount: number }[];
  coupons: { amount: number }[];
  recharges: { paid: number; byMethod: { amount: number }[] };
  refunds: { total: number; byMethod: { method: string; amount: number }[] };
  cash: { opening: number; checkout: number; recharge: number; refund: number; expected: number };
}) {
  const by = (method: string) => s.checkoutByMethod.find((m) => m.method === method)?.amount ?? 0;
  expect(s.checkoutByMethod.reduce((n, m) => n + m.amount, 0)).toBe(s.checkouts.total);
  expect(s.coupons.reduce((n, c) => n + c.amount, 0)).toBe(by('coupon'));
  expect(s.cash.checkout).toBe(by('cash'));
  expect(s.recharges.byMethod.reduce((n, m) => n + m.amount, 0)).toBe(s.recharges.paid);
  expect(s.refunds.byMethod.reduce((n, m) => n + m.amount, 0)).toBe(s.refunds.total);
  expect(s.cash.refund).toBe(s.refunds.byMethod.find((m) => m.method === 'cash')?.amount ?? 0);
  expect(s.cash.expected).toBe(s.cash.opening + s.cash.checkout + s.cash.recharge - s.cash.refund);
}
const wallet = async () => {
  const [m] = await ctx.sql<{ principalBalance: number; bonusBalance: number }[]>`SELECT principal_balance, bonus_balance FROM members WHERE id = ${memberId}`;
  const [n] = await ctx.sql<{ recharges: number; entries: number }[]>`
    SELECT (SELECT count(*)::int FROM recharges WHERE member_id = ${memberId}) AS recharges,
           (SELECT count(*)::int FROM ledger_entries WHERE member_id = ${memberId}) AS entries`;
  return { ...m!, ...n! };
};

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
    expect(cur.summary.cash).toEqual({ opening: 10000, checkout: 49900, recharge: 30000, refund: 0, expected: 89900 });
    const closed = await close(ctx.clerk, shift.id, 89900);
    expect(closed.body).toMatchObject({ status: 'closed', expectedCash: 89900 });

    // 交班之后才开始的收款：没有未交班的班次，按未开班收款（开班是可选的），不记班次；已交班的快照不变
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

  it('复测复现顺序：现金充值卡在取充值单号时交班到达——充值已先拿到班次，交班等它提交，计入本班次', async () => {
    const shift = await open(ctx.clerk);
    const release = await holdRechargeNo();
    const paying = cashRecharge(ctx.clerk, 10000);
    await waitForLockWaiters(1);
    const closing = close(ctx.clerk, shift.id, 0);
    await waitForLockWaiters(2);
    await release();
    const [r, cl] = await Promise.all([paying, closing]);
    expect(r.status).toBe(200);
    expect((await shiftOfRecharge(r.body.recharge.id)).shiftId).toBe(shift.id);
    expect(cl.body.error).toMatchObject({ code: 'SHIFT_CHANGED', details: { expectedCash: 10000 } });
    const done = await close(ctx.clerk, shift.id, 10000);
    expect(done.status).toBe(200);
    expect(done.body.summary.recharges).toMatchObject({ count: 1, paid: 10000 });
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

  it('交班先拿到班次（还没提交）时到达的现金充值：等交班提交后整笔拒绝（SHIFT_CLOSED），余额与流水不变；开新班后原样重提记到新班次', async () => {
    const shift = await open(ctx.clerk);
    const before = await wallet();
    const release = await holdAudit();
    const closing = close(ctx.clerk, shift.id, 0);
    await waitForLockWaiters(1);
    const key = randomUUID();
    const paying = cashRecharge(ctx.clerk, 20000, key);
    await waitForLockWaiters(2);
    await release();
    const [cl, r] = await Promise.all([closing, paying]);
    expect(cl.status).toBe(200);
    expect(cl.body.summary.cash.expected).toBe(0);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'SHIFT_CLOSED', details: { shiftNo: cl.body.shiftNo } });
    expect(await wallet()).toEqual(before);
    expect(await ctx.sql`SELECT 1 FROM idempotency_keys WHERE key = ${key}`).toHaveLength(0);

    // 开新班后按原内容重提（同一操作编号）：记到新班次，只入账一次
    const next = await open(ctx.clerk);
    const again = await cashRecharge(ctx.clerk, 20000, key);
    expect(again.status).toBe(200);
    expect((await shiftOfRecharge(again.body.recharge.id)).shiftId).toBe(next.id);
    expect((await cashRecharge(ctx.clerk, 20000, key)).body.recharge.id).toBe(again.body.recharge.id);
    expect((await wallet()).recharges).toBe(before.recharges + 1);
    expect((await current(ctx.clerk)).summary.cash.expected).toBe(20000);
    expect((await close(ctx.clerk, next.id, 20000)).status).toBe(200);
  });

  it('交班先拿到班次时到达的现金结账：同样整笔拒绝，客人仍在店、账单未结；开新班后原样重提记到新班次', async () => {
    const shift = await open(ctx.clerk);
    const visitId = await enter('A005');
    const release = await holdAudit();
    const closing = close(ctx.clerk, shift.id, 0);
    await waitForLockWaiters(1);
    const key = randomUUID();
    const paying = cashCheckout(visitId, key);
    await waitForLockWaiters(2);
    await release();
    const [cl, c] = await Promise.all([closing, paying]);
    expect(cl.status).toBe(200);
    expect(c.status).toBe(409);
    expect(c.body.error).toMatchObject({ code: 'SHIFT_CLOSED', details: { shiftNo: cl.body.shiftNo } });
    const [v] = await ctx.sql<{ status: string; billStatus: string }[]>`
      SELECT v.status, b.status AS bill_status FROM visits v JOIN bills b ON b.id = v.bill_id WHERE v.id = ${visitId}`;
    expect(v).toEqual({ status: 'open', billStatus: 'open' });
    expect(await ctx.sql`SELECT 1 FROM checkouts WHERE client_key = ${key}`).toHaveLength(0);

    const next = await open(ctx.clerk);
    const again = await cashCheckout(visitId, key);
    expect(again.status).toBe(200);
    const [k] = await ctx.sql<{ shiftId: number }[]>`SELECT shift_id FROM checkouts WHERE id = ${again.body.id}`;
    expect(k!.shiftId).toBe(next.id);
    expect((await close(ctx.clerk, next.id, 49900)).body.summary.checkouts).toEqual({ count: 1, total: 49900 });
  });

  it('收款还在等会员锁时交班已经完成：拿到班次时整笔拒绝；员工交班后不开新班再收，按未开班收款（不记班次）', async () => {
    const shift = await open(ctx.clerk);
    // 会员行被其他事务占用：充值已记下开始时的班次，卡在会员锁上（还没拿班次）
    const release = await hold((tx) => tx`SELECT id FROM members WHERE id = ${memberId} FOR UPDATE`);
    const key = randomUUID();
    const paying = cashRecharge(ctx.clerk, 3000, key);
    await waitForLockWaiters(1);
    const cl = await close(ctx.clerk, shift.id, 0);
    expect(cl.status).toBe(200);
    await release();
    const r = await paying;
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SHIFT_CLOSED');

    const again = await cashRecharge(ctx.clerk, 3000, key);
    expect(again.status).toBe(200);
    expect((await shiftOfRecharge(again.body.recharge.id)).shiftId).toBeNull();
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/shifts/${shift.id}`)).body.summary.recharges.count).toBe(0);
  });

  it('反结账退款记到反结账人的班次、现金扣减应有现金；原收银员的班次仍算这笔收款（R1.2）', async () => {
    const clerkShift = await open(ctx.clerk);
    const ownerShift = await open(ctx.owner);
    const c = await cashCheckout(await enter('A003'));
    expect((await current(ctx.clerk)).summary.cash.expected).toBe(49900);
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${c.body.id}/void`, { reason: '收款方式记错' });
    expect(v.status).toBe(200);
    const [k] = await ctx.sql<{ shiftId: number; voidShiftId: number }[]>`SELECT shift_id, void_shift_id FROM checkouts WHERE id = ${c.body.id}`;
    expect(k).toEqual({ shiftId: clerkShift.id, voidShiftId: ownerShift.id });
    // 收款算在收款时的班次：之后被反结账也不减
    const mine = await current(ctx.clerk);
    expect(mine.summary.checkouts).toEqual({ count: 1, total: 49900 });
    expect(mine.summary.cash).toMatchObject({ checkout: 49900, refund: 0, expected: 49900 });
    expect(mine.summary.voids).toEqual([]);
    expectConsistent(mine.summary);
    // 反结账人的班次：退的现金扣减应有现金（备用金 0 → 应有现金为负，同一钱箱的人合并核对时与收银员的班次相抵）
    const boss = await current(ctx.owner);
    expect(boss.summary.voids).toEqual([{ checkoutNo: c.body.checkoutNo, amount: 49900, reason: '收款方式记错', voidedAt: expect.any(String), cashRefund: 49900 }]);
    expect(boss.summary.refunds).toEqual({ count: 1, total: 49900, byMethod: [{ method: 'cash', amount: 49900 }] });
    expect(boss.summary.cash).toMatchObject({ checkout: 0, refund: 49900, expected: -49900 });
    expectConsistent(boss.summary);
    const bossClosed = await close(ctx.owner, ownerShift.id, -49900);
    expect(bossClosed.body).toMatchObject({ status: 'closed', expectedCash: -49900, countedCash: 0 });
    expect(bossClosed.body.summary.voids).toHaveLength(1);
    expect((await close(ctx.clerk, clerkShift.id, 49900)).status).toBe(200);
    // 反结账字段之外，结账单记下的班次不能改
    await expect(ctx.sql`UPDATE checkouts SET shift_id = NULL WHERE id = ${c.body.id}`).rejects.toThrow(/只能反结账/);
  });

  it('交班先拿到班次时到达的反结账：整笔拒绝，结账单仍有效；开新班后反结账提醒记到新班次', async () => {
    const c = await cashCheckout(await enter('A006'));
    expect(c.status).toBe(200);
    const ownerShift = await open(ctx.owner);
    const release = await holdAudit();
    const closing = close(ctx.owner, ownerShift.id, 0);
    await waitForLockWaiters(1);
    const voiding = api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${c.body.id}/void`, { reason: '收款方式记错' });
    await waitForLockWaiters(2);
    await release();
    const [cl, v] = await Promise.all([closing, voiding]);
    expect(cl.status).toBe(200);
    expect(v.status).toBe(409);
    expect(v.body.error.code).toBe('SHIFT_CLOSED');
    const [k] = await ctx.sql<{ status: string }[]>`SELECT status FROM checkouts WHERE id = ${c.body.id}`;
    expect(k!.status).toBe('completed');

    const next = await open(ctx.owner);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${c.body.id}/void`, { reason: '收款方式记错' })).status).toBe(200);
    const [k2] = await ctx.sql<{ voidShiftId: number }[]>`SELECT void_shift_id FROM checkouts WHERE id = ${c.body.id}`;
    expect(k2!.voidShiftId).toBe(next.id);
    // 退的 499 元现金扣减新班次的应有现金
    expect((await close(ctx.owner, next.id, -49900)).body.summary.voids).toHaveLength(1);
  });

  it('复测复现：交班汇总到一半时另一位员工（在班上）反结账本班次的单——收款仍算在本班次（R1.2），退款记到反结账人的班次，保存的交班表各项互相一致', async () => {
    const shift = await open(ctx.clerk);
    const ownerShift = await open(ctx.owner);
    const c = await couponCheckout(await enter('A008'), 'MT2026SHIFT0001');
    expect(c.status).toBe(200);
    expectConsistent((await current(ctx.clerk)).summary);
    // 充值表被占用：交班已拿到班次排他锁，汇总卡在读充值上
    const release = await hold((tx) => tx`LOCK TABLE recharges IN ACCESS EXCLUSIVE MODE`);
    const closing = close(ctx.clerk, shift.id, 10000);
    await waitForLockWaiters(1);
    // 店主（另一位员工，在自己的班上）此时反结账这张单
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${c.body.id}/void`, { reason: '收款方式记错' });
    expect(v.status).toBe(200);
    await release();
    // 收款算在收款时的班次：反结账不改本班次的汇总（退款记在反结账人的班次），交班照常完成，快照里仍有这张单和它的券
    const cl = await closing;
    expect(cl.status).toBe(200);
    expect(cl.body.summary.checkouts).toEqual({ count: 1, total: 49900 });
    expect(cl.body.summary.coupons).toEqual([{ platform: 'meituan', count: 1, amount: 39900 }]);
    expect(cl.body.summary.refunds).toEqual({ count: 0, total: 0, byMethod: [] });
    expectConsistent(cl.body.summary);
    expectConsistent((await api(ctx.app, ctx.clerk, 'GET', `/api/shifts/${shift.id}`)).body.summary);
    // 退的 100 元现金扣减店主班次的应有现金，两张交班表合起来相抵
    const boss = await close(ctx.owner, ownerShift.id, -10000);
    expect(boss.status).toBe(200);
    expect(boss.body.summary.refunds).toEqual({ count: 1, total: 49900, byMethod: [{ method: 'cash', amount: 10000 }, { method: 'coupon', amount: 39900 }] });
    expectConsistent(boss.body.summary);
  });

  it('同上，但规则关闭、反结账的人没有开班：退款没有记到任何班次，原单不再计入本班次——交班看到应有现金变了（SHIFT_CHANGED），按新的应有现金交班后各项一致', async () => {
    expect(await current(ctx.owner)).toBeNull();
    const shift = await open(ctx.clerk);
    const c = await couponCheckout(await enter('A010'), 'MT2026SHIFT0003');
    expect(c.status).toBe(200);
    const release = await hold((tx) => tx`LOCK TABLE recharges IN ACCESS EXCLUSIVE MODE`);
    const closing = close(ctx.clerk, shift.id, 10000);
    await waitForLockWaiters(1);
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${c.body.id}/void`, { reason: '收款方式记错' });
    expect(v.status).toBe(200);
    await release();
    const cl = await closing;
    expect(cl.status).toBe(409);
    expect(cl.body.error).toMatchObject({ code: 'SHIFT_CHANGED', details: { expectedCash: 0 } });
    const again = await close(ctx.clerk, shift.id, 0);
    expect(again.status).toBe(200);
    expect(again.body.summary.checkouts).toEqual({ count: 0, total: 0 });
    expect(again.body.summary.coupons).toEqual([]);
    expectConsistent(again.body.summary);
  });

  it('反结账在交班汇总之后、交班提交之前完成：交班表是反结账之前的同一时刻，各项一致', async () => {
    const shift = await open(ctx.clerk);
    const c = await couponCheckout(await enter('A009'), 'MT2026SHIFT0002');
    expect(c.status).toBe(200);
    // 交班已汇总、改了状态，写交班审计时停住；反结账做完、也停在写审计上
    const release = await holdAudit();
    const closing = close(ctx.clerk, shift.id, 10000);
    await waitForLockWaiters(1);
    const voiding = api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${c.body.id}/void`, { reason: '收款方式记错' });
    await waitForLockWaiters(2);
    await release();
    const [cl, v] = await Promise.all([closing, voiding]);
    expect([cl.status, v.status]).toEqual([200, 200]);
    expect(cl.body.summary.checkouts).toEqual({ count: 1, total: 49900 });
    expect(cl.body.summary.coupons).toEqual([{ platform: 'meituan', count: 1, amount: 39900 }]);
    expectConsistent(cl.body.summary);
    expectConsistent((await api(ctx.app, ctx.clerk, 'GET', `/api/shifts/${shift.id}`)).body.summary);
  });

  it('升级时仍未交班的旧班次（迁移 016 前开班）：先拿到班次的收款计入，先交班时到达的收款整笔拒绝；升级前的单据仍按时间窗口补算', async () => {
    // 单独的员工，避免其他用例没有记班次的单据落进时间窗口
    const staffId = await createStaff(ctx.sql, { username: 'legacy', displayName: '旧班次店员', role: 'clerk', password: PASSWORD, mustChangePassword: false });
    const cookie = await login(ctx.app, 'legacy');
    // 升级前（单据没有记班次）开的班：开班之后本人经办的一笔充值
    const pre = await cashRecharge(cookie, 1000);
    expect(pre.status).toBe(200);
    const startedAt = new Date(new Date((await shiftOfRecharge(pre.body.recharge.id)).createdAt).getTime() - 60_000);
    const [legacy] = await ctx.sql<{ id: number }[]>`
      INSERT INTO shifts (shift_no, staff_id, business_date, started_at, opening_cash, legacy_window)
      VALUES ('BC-LEGACY', ${staffId}, ${today}, ${startedAt}, 0, true) RETURNING id`;
    expect((await current(cookie)).summary.cash.expected).toBe(1000);

    // ① 充值先拿到班次、卡在取号上：交班等它提交 → SHIFT_CHANGED，充值记到旧班次
    const releaseNo = await holdRechargeNo();
    const paying = cashRecharge(cookie, 2000);
    await waitForLockWaiters(1);
    const closing = close(cookie, legacy!.id, 1000);
    await waitForLockWaiters(2);
    await releaseNo();
    const [r, cl] = await Promise.all([paying, closing]);
    expect(r.status).toBe(200);
    expect((await shiftOfRecharge(r.body.recharge.id)).shiftId).toBe(legacy!.id);
    expect(cl.body.error).toMatchObject({ code: 'SHIFT_CHANGED', details: { expectedCash: 3000 } });

    // ② 交班先拿到班次：之后拿到锁的结账整笔拒绝
    const visitId = await enter('A007');
    const releaseAudit = await holdAudit();
    const closing2 = close(cookie, legacy!.id, 3000);
    await waitForLockWaiters(1);
    const late = cashCheckout(visitId, randomUUID(), cookie);
    await waitForLockWaiters(2);
    await releaseAudit();
    const [cl2, c2] = await Promise.all([closing2, late]);
    expect(cl2.status).toBe(200);
    expect(c2.body.error.code).toBe('SHIFT_CLOSED');
    // 快照：升级前的 10 元（时间窗口补算）+ 计入的 20 元；被拒绝的结账不在其中，客人仍在店
    expect(cl2.body.summary.recharges).toMatchObject({ count: 2, paid: 3000 });
    expect(cl2.body.summary.checkouts).toEqual({ count: 0, total: 0 });
    expect(cl2.body.expectedCash).toBe(3000);
    const [v] = await ctx.sql<{ status: string }[]>`SELECT status FROM visits WHERE id = ${visitId}`;
    expect(v!.status).toBe('open');
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
