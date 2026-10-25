// 重复提交、请求超时重试与多人同时操作：账务结果明确、可查询且不重复。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, balanceOf, consumeBody, createMember, login, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

const ledgerCount = async (memberId: number) => {
  const [row] = await ctx.sql<{ count: number }[]>`SELECT count(*) AS count FROM ledger_entries WHERE member_id = ${memberId}`;
  return row!.count;
};

describe('幂等：重复点击与超时重试', () => {
  it('同一操作编号重复提交只入账一次，返回同一张单', async () => {
    const member = await createMember(ctx, '重复点击', '19900003001');
    const body = rechargeBody(member.id, 10000);
    const first = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body);
    const second = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.recharge.docNo).toBe(first.body.recharge.docNo);
    expect(second.body.balanceAfter).toEqual(first.body.balanceAfter);
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 10000, bonus: 0 });
    expect(await ledgerCount(member.id)).toBe(1);
  });

  it('同一操作编号并发提交 10 次，只生成一张单', async () => {
    const member = await createMember(ctx, '并发同键', '19900003002');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 10000));
    const body = consumeBody(member.id, 3000);
    const results = await Promise.all(Array.from({ length: 10 }, () => api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', body)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.consumption.docNo)).size).toBe(1);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 7000, bonus: 0 });
    expect(await ledgerCount(member.id)).toBe(2);
  });

  it('同一操作编号用于不同内容时拒绝', async () => {
    const member = await createMember(ctx, '编号冲突', '19900003003');
    const body = rechargeBody(member.id, 10000);
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body);
    const conflict = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', { ...body, paidAmount: 20000 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 10000, bonus: 0 });
  });

  it('超时后可按操作编号查回原单结果', async () => {
    const member = await createMember(ctx, '超时查询', '19900003004');
    const body = rechargeBody(member.id, 8800);
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body);
    const found = await api(ctx.app, ctx.clerk, 'GET', `/api/operations/${body.idempotencyKey}`);
    expect(found.body.found).toBe(true);
    expect(found.body.type).toBe('recharge');
    expect(found.body.recharge.paidAmount).toBe(8800);
    const missing = await api(ctx.app, ctx.clerk, 'GET', `/api/operations/${randomUUID()}`);
    expect(missing.body).toEqual({ found: false });
  });

  it('重复提交会记入日结异常', async () => {
    const me = await api(ctx.app, ctx.owner, 'GET', '/api/auth/me');
    const s = await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${me.body.today}`);
    expect(s.body.anomalies.some((a: { kind: string }) => a.kind === 'duplicate_blocked')).toBe(true);
  });
});

describe('多人同时操作', () => {
  it('两台终端同时扣款，不会透支', async () => {
    const member = await createMember(ctx, '并发扣款', '19900003101');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 10000));
    const other = await login(ctx.app, 'owner');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => api(ctx.app, i % 2 ? ctx.clerk : other, 'POST', '/api/consumptions', consumeBody(member.id, 3000))),
    );
    const ok = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status === 422);
    expect(ok).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    expect(rejected.every((r) => r.body.error.code === 'INSUFFICIENT_BALANCE')).toBe(true);
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 1000, bonus: 0 });
    // 每笔成功扣款的变动后余额依次递减、互不重叠
    const afters = ok.map((r) => r.body.balanceAfter.principal).sort((a: number, b: number) => b - a);
    expect(afters).toEqual([7000, 4000, 1000]);
  });

  it('两位店主同时撤销同一张单，只恢复一次', async () => {
    const member = await createMember(ctx, '并发撤销', '19900003102');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 10000));
    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(member.id, 4000));
    const owner2 = await login(ctx.app, 'owner');
    const results = await Promise.all(
      [ctx.owner, owner2, ctx.owner].map((cookie) =>
        api(ctx.app, cookie, 'POST', `/api/consumptions/${c.body.consumption.id}/reverse`, { idempotencyKey: randomUUID(), reason: '重复登记' }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'ALREADY_REVERSED')).toHaveLength(2);
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 10000, bonus: 0 });
  });

  it('确认期间余额被其他终端改动时，要求重新确认', async () => {
    const member = await createMember(ctx, '余额变动', '19900003103');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 10000));
    const seen = await balanceOf(ctx, member.id);
    await api(ctx.app, ctx.owner, 'POST', '/api/consumptions', consumeBody(member.id, 1000));
    const res = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(member.id, 2000, { expectedBalance: seen }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BALANCE_CHANGED');
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 9000, bonus: 0 });
  });

  it('会员被长时间锁住时，记账在 5 秒内明确失败且不入账', async () => {
    const member = await createMember(ctx, '锁等待', '19900003104');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 10000));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const locker = ctx.sql.begin(async (tx) => {
      await tx`SELECT id FROM members WHERE id = ${member.id} FOR UPDATE`;
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const res = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(member.id, 1000));
    const waited = Date.now() - started;
    release();
    await locker;
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BUSY');
    expect(waited).toBeLessThan(9000);
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 10000, bonus: 0 });
    expect(await ledgerCount(member.id)).toBe(1);
  });

  it('单号按营业日连续编号，不会重复', async () => {
    const rows = await ctx.sql<{ docNo: string }[]>`SELECT doc_no FROM recharges ORDER BY id`;
    const numbers = rows.map((r) => r.docNo);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe('只追加保护', () => {
  it('数据库层面禁止修改或删除流水与单据', async () => {
    await expect(ctx.sql`UPDATE ledger_entries SET principal_delta = 0`).rejects.toThrow(/只追加/);
    await expect(ctx.sql`DELETE FROM recharges`).rejects.toThrow(/只追加/);
    await expect(ctx.sql`UPDATE consumptions SET total_amount = total_amount + 1`).rejects.toThrow(/消费单/);
    await expect(ctx.sql`UPDATE members SET principal_balance = -1`).rejects.toThrow();
  });
});
