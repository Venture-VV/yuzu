// 需求文档第 7 节的合成验收案例：充值本金 100 → 消费 30 → 余额 70 → 撤销 → 恢复 100。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, balanceOf, consumeBody, createMember, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

describe('验收：充值 100 → 消费 30 → 撤销', () => {
  it('完整走通，余额与流水一致', async () => {
    const member = await createMember(ctx, '验收会员', '19900000001');

    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 10000));
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('recharge');
    expect(r.body.replayed).toBe(false);
    expect(r.body.balanceBefore).toEqual({ principal: 0, bonus: 0 });
    expect(r.body.balanceAfter).toEqual({ principal: 10000, bonus: 0 });
    expect(r.body.recharge.docNo).toMatch(/^CZ\d{8}-0001$/);

    const c = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(member.id, 3000));
    expect(c.status).toBe(200);
    expect(c.body.consumption.principalAmount).toBe(3000);
    expect(c.body.consumption.bonusAmount).toBe(0);
    expect(c.body.balanceAfter).toEqual({ principal: 7000, bonus: 0 });
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 7000, bonus: 0 });

    // 店员不能撤销
    const denied = await api(ctx.app, ctx.clerk, 'POST', `/api/consumptions/${c.body.consumption.id}/reverse`, {
      idempotencyKey: randomUUID(),
      reason: '项目选错',
    });
    expect(denied.status).toBe(403);

    const v = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${c.body.consumption.id}/reverse`, {
      idempotencyKey: randomUUID(),
      reason: '项目选错',
    });
    expect(v.status).toBe(200);
    expect(v.body.type).toBe('reversal');
    expect(v.body.reversal.consumptionDocNo).toBe(c.body.consumption.docNo);
    expect(v.body.consumption.status).toBe('reversed');
    expect(v.body.balanceAfter).toEqual({ principal: 10000, bonus: 0 });
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 10000, bonus: 0 });

    // 再次撤销（新的操作编号）被拒绝，余额不变
    const again = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${c.body.consumption.id}/reverse`, {
      idempotencyKey: randomUUID(),
      reason: '再次撤销',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REVERSED');
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 10000, bonus: 0 });

    // 原单、撤销单都保留在流水里
    const activity = await api(ctx.app, ctx.owner, 'GET', `/api/members/${member.id}/activity`);
    expect(activity.body.map((row: { entryType: string }) => row.entryType)).toEqual(['reversal', 'consume', 'recharge']);
    expect(activity.body[1].consumptionStatus).toBe('reversed');
    expect(activity.body[1].relatedDocNo).toBe(v.body.reversal.docNo);

    // 日结核对全部通过
    const me = await api(ctx.app, ctx.owner, 'GET', '/api/auth/me');
    const s = await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${me.body.today}`);
    expect(s.status).toBe(200);
    expect(s.body.recharge).toMatchObject({ count: 1, paid: 10000, bonus: 0 });
    expect(s.body.consume).toMatchObject({ count: 1, total: 3000, reversedCount: 1 });
    expect(s.body.reversal).toMatchObject({ count: 1, principal: 3000, bonus: 0, crossDayCount: 0 });
    expect(s.body.net).toEqual({ principal: 10000, bonus: 0 });
    expect(s.body.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
    expect(s.body.anomalies.map((a: { kind: string }) => a.kind)).toContain('reversal');
  });

  it('余额不足时拒绝扣款，且不产生任何单据', async () => {
    const member = await createMember(ctx, '余额不足会员', '19900000002');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 2000));
    const res = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(member.id, 2500));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(res.body.error.details).toMatchObject({ available: 2000, shortfall: 500 });
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 2000, bonus: 0 });
    const [row] = await ctx.sql<{ count: number }[]>`SELECT count(*) AS count FROM consumptions WHERE member_id = ${member.id}`;
    expect(row!.count).toBe(0);
  });

  it('充值必须确认已收款', async () => {
    const member = await createMember(ctx, '未确认收款', '19900000003');
    const res = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 5000, 0, { paymentConfirmed: false }));
    expect(res.status).toBe(400);
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 0, bonus: 0 });
  });
});
