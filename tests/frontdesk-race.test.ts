// G2 复审回归：用可控的锁等待制造确定的交错顺序。
// ① 发牌与锁定 / 停用 / 改分区同一张手牌并发（正反两种顺序）；
// ② 结果待确认的操作：只读查回查不到不代表不会生效；作废后原请求即使随后到达也整笔回滚。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, rechargeBody, createMember, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
let itemId: number;
const tagId = new Map<string, number>();

beforeAll(async () => {
  ctx = await setup();
  await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'A', from: 1, to: 20, width: 3, zone: 'male' });
  for (const t of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/tags')).body) tagId.set(t.code, t.id);
  const items = (await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '搓背', category: '护理', price: 5800 })).body.items;
  itemId = items.find((i: { name: string }) => i.name === '搓背').id;
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

const checkin = (code: string, key = randomUUID()) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: key, guests: [{ tagCode: code, zone: 'male' }] });

const selfCheck = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; detail: string }[];

describe('发牌与锁定 / 停用 / 改分区并发', () => {
  // 让发牌拿到手牌锁后，卡在账单单号计数行上；随后的锁定请求排在手牌锁后面
  const holdBillCounter = () =>
    hold((tx) => tx`
      INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES ('bill', ${today}, 0)
      ON CONFLICT (doc_type, business_date) DO UPDATE SET last_no = doc_counters.last_no`);

  for (const [name, code, change] of [
    ['锁定', 'A001', (id: number) => api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${id}/lock`, { reason: '柜锁故障' })],
    ['停用', 'A002', (id: number) => api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${id}`, { zone: 'male', active: false })],
    ['改分区', 'A003', (id: number) => api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${id}`, { zone: 'female', active: true })],
  ] as const) {
    it(`发牌先拿到手牌锁、${name}随后到达：${name}被拒绝，手牌保持可用`, async () => {
      const release = await holdBillCounter();
      const issuing = checkin(code);
      await waitForLockWaiters(1);
      const changing = change(tagId.get(code)!);
      await waitForLockWaiters(2);
      await release();
      const [c, l] = await Promise.all([issuing, changing]);
      expect(c.status).toBe(201);
      expect(l.status).toBe(409);
      expect(l.body.error.code).toBe('TAG_IN_USE');
      const [t] = await ctx.sql<{ locked: boolean; active: boolean; zone: string }[]>`SELECT locked, active, zone FROM hand_tags WHERE code = ${code}`;
      expect(t).toMatchObject({ locked: false, active: true, zone: 'male' });
      for (const k of await selfCheck()) expect(k, k.detail).toMatchObject({ ok: true });
    });
  }

  it('反向顺序：锁定先拿到手牌锁、发牌随后到达：发牌被拒绝', async () => {
    const release = await hold((tx) => tx`SELECT id FROM hand_tags WHERE code = 'A004' FOR UPDATE`);
    const changing = api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${tagId.get('A004')}/lock`, { reason: '手牌丢失' });
    await waitForLockWaiters(1);
    const issuing = checkin('A004');
    await waitForLockWaiters(2);
    await release();
    const [l, c] = await Promise.all([changing, issuing]);
    expect(l.status).toBe(200);
    expect(c.status).toBe(422);
    expect(c.body.error.code).toBe('TAG_LOCKED');
    const { n } = (await ctx.sql<{ n: number }[]>`
      SELECT count(*) AS n FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = 'A004' AND v.status = 'open'`)[0]!;
    expect(n).toBe(0);
    for (const k of await selfCheck()) expect(k, k.detail).toMatchObject({ ok: true });
  });
});

describe('结果待确认：查回与作废', () => {
  const post = (visitId: number, key: string) =>
    api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: key, lines: [{ itemId, quantity: 1 }], expectedTotal: 5800 });

  it('原请求还在等锁时：查回为「未找到」但不能当作没生效；作废后原请求整笔回滚、同编号重提也被拒绝', async () => {
    const visitId = (await checkin('A010')).body.visits[0].id as number;
    const key = randomUUID();
    const release = await hold((tx) => tx`SELECT id FROM visits WHERE id = ${visitId} FOR UPDATE`);
    const original = post(visitId, key);
    await waitForLockWaiters(1);
    const look = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}`);
    expect(look.body).toEqual({ found: false, abandoned: false });
    const abandon = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${key}/abandon`);
    expect(abandon.body).toEqual({ found: false, abandoned: true });
    await release();
    const r = await original;
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('OP_ABANDONED');
    const [bill] = await ctx.sql<{ amountCents: number; lineCount: number }[]>`
      SELECT b.amount_cents, b.line_count FROM bills b JOIN visits v ON v.bill_id = b.id WHERE v.id = ${visitId}`;
    expect(bill).toEqual({ amountCents: 0, lineCount: 0 });
    expect((await post(visitId, key)).body.error.code).toBe('OP_ABANDONED');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}`)).body).toEqual({ found: false, abandoned: true });
    // 用新编号重新挂账：只有这一笔
    expect((await post(visitId, randomUUID())).body.bill).toMatchObject({ amountCents: 5800, lineCount: 1 });
  });

  it('原操作已经生效时，作废返回查回的结果，不会作废', async () => {
    const visitId = (await checkin('A011')).body.visits[0].id as number;
    const key = randomUUID();
    expect((await post(visitId, key)).status).toBe(200);
    const abandon = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${key}/abandon`);
    expect(abandon.body).toMatchObject({ found: true, type: 'bill_post' });
    expect(abandon.body.visit.bill.amountCents).toBe(5800);
    // 重复点击「按原内容重新提交」仍只有一笔
    expect((await post(visitId, key)).body.bill).toMatchObject({ amountCents: 5800, lineCount: 1 });
  });

  it('接待：发牌请求在等待时被作废，手牌保持空闲，原请求回滚', async () => {
    const key = randomUUID();
    const release = await hold((tx) => tx`
      INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES ('bill', ${today}, 0)
      ON CONFLICT (doc_type, business_date) DO UPDATE SET last_no = doc_counters.last_no`);
    const original = checkin('A012', key);
    await waitForLockWaiters(1);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${key}/abandon`)).body).toEqual({ found: false, abandoned: true });
    await release();
    expect((await original).body.error.code).toBe('OP_ABANDONED');
    const { n } = (await ctx.sql<{ n: number }[]>`SELECT count(*) AS n FROM visits WHERE checkin_key = ${key}`)[0]!;
    expect(n).toBe(0);
    expect((await checkin('A012')).status).toBe(201);
  });

  it('不能用前台接口作废会员记账的操作编号；后勤岗位不能作废', async () => {
    const m = await createMember(ctx, '编号隔离', '19900007701');
    const body = rechargeBody(m.id, 10000);
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body);
    const r = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${body.idempotencyKey}/abandon`);
    expect(r.status).toBe(409);
    const [k] = await ctx.sql<{ opType: string }[]>`SELECT op_type FROM idempotency_keys WHERE key = ${body.idempotencyKey}`;
    expect(k!.opType).toBe('recharge');
  });
});
