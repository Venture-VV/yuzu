// 会员记账「确认作废」：用可控的锁等待制造确定的交错顺序。
// 只读查回查不到不代表原请求不会入账；作废后原请求即使随后到达也整笔回滚，同编号重提被拒绝。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, balanceOf, consumeBody, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
beforeAll(async () => {
  ctx = await setup();
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
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

/** 在单独连接里开一个事务持锁，返回提交 / 回滚函数 */
async function hold(statement: (tx: typeof ctx.sql) => Promise<unknown>) {
  const conn = await ctx.sql.reserve();
  await conn.unsafe('BEGIN');
  await statement(conn as unknown as typeof ctx.sql);
  const end = async (sql: 'COMMIT' | 'ROLLBACK') => {
    await conn.unsafe(sql);
    conn.release();
  };
  return { release: () => end('ROLLBACK'), commit: () => end('COMMIT') };
}

const abandon = (key: string, body: Record<string, unknown> = {}, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', `/api/operations/${key}/abandon`, body);
const lookup = (key: string) => api(ctx.app, ctx.clerk, 'GET', `/api/operations/${key}`);

async function walletRows(memberId: number) {
  const [row] = await ctx.sql<{ ledger: number; consumptions: number; recharges: number; reversals: number }[]>`
    SELECT (SELECT count(*) FROM ledger_entries WHERE member_id = ${memberId}) AS ledger,
           (SELECT count(*) FROM consumptions WHERE member_id = ${memberId}) AS consumptions,
           (SELECT count(*) FROM recharges WHERE member_id = ${memberId}) AS recharges,
           (SELECT count(*) FROM reversals WHERE member_id = ${memberId}) AS reversals`;
  return row!;
}

async function settlementChecks() {
  const s = await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`);
  return s.body.checks as { key: string; ok: boolean; detail: string }[];
}

describe('结果待确认的会员记账：查回与作废', () => {
  it('消费请求还在等会员锁：查回「未找到」不能当作没扣款；作废后原请求整笔回滚，同编号重提也被拒绝', async () => {
    const m = await createMember(ctx, '作废等锁', '19900009101');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 20000));
    const before = await walletRows(m.id);
    const body = consumeBody(m.id, 5800);
    const lock = await hold((tx) => tx`SELECT id FROM members WHERE id = ${m.id} FOR UPDATE`);
    const original = api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', body);
    await waitForLockWaiters(1);

    expect((await lookup(body.idempotencyKey)).body).toEqual({ found: false, abandoned: false });
    const a = await abandon(body.idempotencyKey, { type: 'consume', memberId: m.id, amount: 5800, summary: '搓背' });
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ found: false, abandoned: true });

    await lock.release();
    const r = await original;
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('OP_ABANDONED');
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 20000, bonus: 0 });
    expect(await walletRows(m.id)).toEqual(before);

    // 原样重提同一编号：仍然拒绝，查回为已作废
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', body);
    expect(again.body.error.code).toBe('OP_ABANDONED');
    expect((await lookup(body.idempotencyKey)).body).toEqual({ found: false, abandoned: true });
    // 用新编号重新登记：只扣这一次
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 5800))).status).toBe(200);
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 14200, bonus: 0 });
    for (const c of await settlementChecks()) expect(c, c.detail).toMatchObject({ ok: true });
  });

  it('充值请求已过编号检查、卡在单号计数上：作废后写编号冲突，整笔回滚，余额不变', async () => {
    const m = await createMember(ctx, '作废已过检查', '19900009102');
    const body = rechargeBody(m.id, 50000, 5000, { planId: null });
    // 先让当日充值计数行存在，再锁住它：原请求拿到会员锁、查过编号后卡在这里
    await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 100));
    const before = await walletRows(m.id);
    const counter = await hold((tx) => tx`SELECT last_no FROM doc_counters WHERE doc_type = 'recharge' AND business_date = ${today} FOR UPDATE`);
    const original = api(ctx.app, ctx.owner, 'POST', '/api/recharges', body);
    await waitForLockWaiters(1);

    // 作废不需要会员锁，原请求还持有会员锁时也能立即完成
    expect((await abandon(body.idempotencyKey, { type: 'recharge', memberId: m.id, amount: 50000 })).body).toEqual({ found: false, abandoned: true });
    await counter.release();
    const r = await original;
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('OP_ABANDONED');
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 100, bonus: 0 });
    expect(await walletRows(m.id)).toEqual(before);
    for (const c of await settlementChecks()) expect(c, c.detail).toMatchObject({ ok: true });
  });

  it('原操作已经入账时，作废返回查回的结果，不会作废；同编号重提仍是同一张单', async () => {
    const m = await createMember(ctx, '作废已入账', '19900009103');
    const body = rechargeBody(m.id, 30000);
    const first = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body);
    expect(first.status).toBe(200);
    const a = await abandon(body.idempotencyKey, { type: 'recharge', memberId: m.id, amount: 30000 });
    expect(a.body).toMatchObject({ found: true, type: 'recharge', replayed: true });
    expect(a.body.recharge.docNo).toBe(first.body.recharge.docNo);
    const replay = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body);
    expect(replay.body.recharge.docNo).toBe(first.body.recharge.docNo);
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 30000, bonus: 0 });
    const [k] = await ctx.sql<{ opType: string }[]>`SELECT op_type FROM idempotency_keys WHERE key = ${body.idempotencyKey}`;
    expect(k!.opType).toBe('recharge');
  });

  it('原请求已写下编号但还没提交：作废等它结束再答复（提交 → 返回已入账；回滚 → 作废成功）', async () => {
    const m = await createMember(ctx, '作废等提交', '19900009104');
    const done = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 8800));
    const rechargeId = done.body.recharge.id as number;

    // 用单独连接模拟「原请求刚写下编号、还没提交」：与正式流程一样，先取编号的咨询锁再写编号
    const writeKey = (key: string) => async (tx: typeof ctx.sql) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      await tx`
        INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id)
        VALUES (${key}, 'recharge', 'h', ${rechargeId}, ${ctx.clerkId})`;
    };
    const committedKey = randomUUID();
    const inflight = await hold(writeKey(committedKey));
    const waiting = abandon(committedKey, { type: 'recharge' });
    await waitForLockWaiters(1);
    await inflight.commit();
    expect((await waiting).body).toMatchObject({ found: true, type: 'recharge' });

    const rolledBackKey = randomUUID();
    const aborted = await hold(writeKey(rolledBackKey));
    const waiting2 = abandon(rolledBackKey, { type: 'recharge' });
    await waitForLockWaiters(1);
    await aborted.release();
    expect((await waiting2).body).toEqual({ found: false, abandoned: true });
  });

  it('撤销请求在等会员锁时被作废：消费单保持已完成，之后仍可正常撤销一次', async () => {
    const m = await createMember(ctx, '作废撤销', '19900009105');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 10000));
    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 3000));
    const consumptionId = c.body.consumption.id as number;
    const key = randomUUID();
    const lock = await hold((tx) => tx`SELECT id FROM members WHERE id = ${m.id} FOR UPDATE`);
    const original = api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${consumptionId}/reverse`, { idempotencyKey: key, reason: '项目选错' });
    await waitForLockWaiters(1);
    expect((await abandon(key, { type: 'reversal', memberId: m.id, amount: 3000 }, ctx.owner)).body).toEqual({ found: false, abandoned: true });
    await lock.release();
    expect((await original).body.error.code).toBe('OP_ABANDONED');
    const [doc] = await ctx.sql<{ status: string }[]>`SELECT status FROM consumptions WHERE id = ${consumptionId}`;
    expect(doc!.status).toBe('completed');
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 7000, bonus: 0 });
    const ok = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${consumptionId}/reverse`, { idempotencyKey: randomUUID(), reason: '项目选错' });
    expect(ok.status).toBe(200);
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 10000, bonus: 0 });
  });

  it('重复作废只登记一次；作废记入审计与日结提醒', async () => {
    const m = await createMember(ctx, '作废留痕', '19900009106');
    const key = randomUUID();
    const body = { type: 'recharge', memberId: m.id, amount: 50000, summary: '常泡 500 · 微信' };
    expect((await abandon(key, body)).body).toEqual({ found: false, abandoned: true });
    expect((await abandon(key, body)).body).toEqual({ found: false, abandoned: true });
    const audits = await ctx.sql<{ detail: { idempotencyKey: string; amount: number; summary: string } }[]>`
      SELECT detail FROM audit_logs WHERE action = 'operation_abandoned' AND detail->>'idempotencyKey' = ${key}`;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ amount: 50000, summary: '充值 · 常泡 500 · 微信' });
    const s = await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`);
    const anomaly = (s.body.anomalies as { kind: string; memberName: string | null; amount: number | null; description: string }[]).find(
      (a) => a.kind === 'abandoned' && a.memberName === '作废留痕',
    );
    expect(anomaly).toMatchObject({ amount: 50000 });
    expect(anomaly!.description).toContain('常泡 500 · 微信');
  });

  it('权限与编号隔离：必须写明原业务类型；店员不能作废撤销；后勤岗位不能作废；不能作废前台已生效的编号', async () => {
    const key = randomUUID();
    expect((await abandon(key, {})).status).toBe(400);
    const clerkReversal = await abandon(key, { type: 'reversal' });
    expect(clerkReversal.status).toBe(403);
    await createStaff(ctx.sql, { username: 'backoffice1', displayName: '后勤', role: 'backoffice', duties: ['stock'], password: PASSWORD, mustChangePassword: false });
    const backoffice = await login(ctx.app, 'backoffice1');
    expect((await abandon(key, { type: 'recharge' }, backoffice)).status).toBe(403);
    expect((await lookup(key)).body).toEqual({ found: false, abandoned: false });

    await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'A', from: 1, to: 6, width: 3, zone: 'male' });
    const checkinKey = randomUUID();
    const checkin = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: checkinKey, guests: [{ tagCode: 'A001', zone: 'male' }] });
    expect(checkin.status).toBe(201);
    const cross = await abandon(checkinKey, { type: 'consume' });
    expect(cross.status).toBe(409);
    expect(cross.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const [k] = await ctx.sql<{ opType: string }[]>`SELECT op_type FROM idempotency_keys WHERE key = ${checkinKey}`;
    expect(k!.opType).toBe('checkin');
  });
});

describe('作废只对原业务类型生效（G2 第 2 轮复测意见 2）', () => {
  /** 店主有一张待撤销的消费；撤销请求卡在会员锁上（已到服务器、还没写编号） */
  async function pendingReversal(name: string, phone: string) {
    const m = await createMember(ctx, name, phone);
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 10000));
    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 3000));
    const consumptionId = c.body.consumption.id as number;
    const key = randomUUID();
    const lock = await hold((tx) => tx`SELECT id FROM members WHERE id = ${m.id} FOR UPDATE`);
    const original = api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${consumptionId}/reverse`, { idempotencyKey: key, reason: '项目选错' });
    await waitForLockWaiters(1);
    return { m, key, consumptionId, lock, original };
  }

  async function expectReversed(p: Awaited<ReturnType<typeof pendingReversal>>) {
    await p.lock.release();
    const r = await p.original;
    expect(r.status).toBe(200);
    const [doc] = await ctx.sql<{ status: string }[]>`SELECT status FROM consumptions WHERE id = ${p.consumptionId}`;
    expect(doc!.status).toBe('reversed');
    expect(await balanceOf(ctx, p.m.id)).toEqual({ principal: 10000, bonus: 0 });
    expect((await lookup(`${p.key}?type=reversal`)).body).toMatchObject({ found: true, type: 'reversal' });
  }

  it('店员把店主待处理的撤销伪报成「消费」作废：登记不生效，撤销照常完成；按原类型查回不显示已作废', async () => {
    const p = await pendingReversal('伪报类型', '19900009201');
    const forged = await abandon(p.key, { type: 'consume', memberId: p.m.id });
    expect(forged.status).toBe(200);
    // 店主那边按原类型查回：不会被误导成「已作废」而另起一笔
    expect((await lookup(`${p.key}?type=reversal`)).body).toEqual({ found: false, abandoned: false });
    await expectReversed(p);
  });

  it('从前台接口作废会员撤销的编号（在途）：只能登记前台类型，拦不下撤销', async () => {
    const p = await pendingReversal('跨模块在途', '19900009202');
    const cross = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${p.key}/abandon`, { type: 'bill_post' });
    expect(cross.status).toBe(200);
    expect((await lookup(`${p.key}?type=reversal`)).body).toEqual({ found: false, abandoned: false });
    await expectReversed(p);
  });

  it('同一终端切换为店员后：按真实类型作废店主的撤销被拒绝（403）；店主本人可以作废，撤销随后整笔回滚', async () => {
    const p = await pendingReversal('切换店员', '19900009203');
    expect((await abandon(p.key, { type: 'reversal' })).status).toBe(403);
    expect((await abandon(p.key, { type: 'reversal' }, ctx.owner)).body).toEqual({ found: false, abandoned: true });
    await p.lock.release();
    expect((await p.original).body.error.code).toBe('OP_ABANDONED');
    const [doc] = await ctx.sql<{ status: string }[]>`SELECT status FROM consumptions WHERE id = ${p.consumptionId}`;
    expect(doc!.status).toBe('completed');
    expect(await balanceOf(ctx, p.m.id)).toEqual({ principal: 7000, bonus: 0 });
  });

  it('反方向：用会员接口作废前台在途的挂账，挂账照常生效；前台按原类型作废才会拦下', async () => {
    await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'F', from: 1, to: 3, width: 3, zone: 'male' });
    const items = (await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '跨模块搓背', category: '护理', price: 5800 })).body.items;
    const itemId = items.find((i: { name: string }) => i.name === '跨模块搓背').id as number;
    const visitId = (await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'F001', zone: 'male' }] })).body.visits[0].id as number;
    const post = (key: string) =>
      api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: key, lines: [{ itemId, quantity: 1 }], expectedTotal: 5800 });
    const amount = async () =>
      (await ctx.sql<{ amountCents: number }[]>`SELECT b.amount_cents FROM bills b JOIN visits v ON v.bill_id = b.id WHERE v.id = ${visitId}`)[0]!.amountCents;

    // ① 会员接口伪报类型：登记不生效
    const key1 = randomUUID();
    let lock = await hold((tx) => tx`SELECT id FROM visits WHERE id = ${visitId} FOR UPDATE`);
    let original = post(key1);
    await waitForLockWaiters(1);
    expect((await abandon(key1, { type: 'consume' })).status).toBe(200);
    await lock.release();
    expect((await original).status).toBe(200);
    expect(await amount()).toBe(5800);

    // ② 前台接口、原类型：拦下
    const key2 = randomUUID();
    lock = await hold((tx) => tx`SELECT id FROM visits WHERE id = ${visitId} FOR UPDATE`);
    original = post(key2);
    await waitForLockWaiters(1);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${key2}/abandon`, { type: 'bill_post' })).body).toEqual({ found: false, abandoned: true });
    await lock.release();
    expect((await original).body.error.code).toBe('OP_ABANDONED');
    expect(await amount()).toBe(5800);
  });
});
