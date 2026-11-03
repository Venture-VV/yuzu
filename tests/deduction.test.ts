// 本金与赠金场景：三种候选扣款规则分别验证，撤销按原单构成恢复。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitDeduction } from '../src/shared/deduction';
import { api, balanceOf, consumeBody, createMember, rechargeBody, setRule, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

describe('splitDeduction 纯函数', () => {
  const bal = { principal: 50000, bonus: 5000 };
  it('先本金', () => {
    expect(splitDeduction(10000, bal, 'principal_first')).toEqual({ ok: true, principal: 10000, bonus: 0 });
    expect(splitDeduction(52000, bal, 'principal_first')).toEqual({ ok: true, principal: 50000, bonus: 2000 });
  });
  it('先赠金', () => {
    expect(splitDeduction(3000, bal, 'bonus_first')).toEqual({ ok: true, principal: 0, bonus: 3000 });
    expect(splitDeduction(10000, bal, 'bonus_first')).toEqual({ ok: true, principal: 5000, bonus: 5000 });
  });
  it('按比例，赠金向下取整、零头计入本金', () => {
    expect(splitDeduction(11000, bal, 'proportional')).toEqual({ ok: true, principal: 10000, bonus: 1000 });
    expect(splitDeduction(101, { principal: 100, bonus: 1 }, 'proportional')).toEqual({ ok: true, principal: 100, bonus: 1 });
    expect(splitDeduction(1, { principal: 1, bonus: 1 }, 'proportional')).toEqual({ ok: true, principal: 1, bonus: 0 });
  });
  it('余额不足', () => {
    expect(splitDeduction(55001, bal, 'principal_first')).toEqual({ ok: false, reason: 'insufficient', available: 55000, shortfall: 1 });
  });
});

describe('接口：本金 + 赠金', () => {
  const cases = [
    { rule: 'principal_first', consume: 52000, expect: { principal: 50000, bonus: 2000 } },
    { rule: 'bonus_first', consume: 10000, expect: { principal: 5000, bonus: 5000 } },
    { rule: 'proportional', consume: 11000, expect: { principal: 10000, bonus: 1000 } },
  ] as const;

  for (const [i, c] of cases.entries()) {
    it(`${c.rule}：充 500 送 50，消费后撤销恢复原构成`, async () => {
      await setRule(ctx, c.rule);
      const member = await createMember(ctx, `赠金会员${i}`, `1990000100${i}`);
      // 自定义赠金需要店主权限
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(member.id, 50000, 5000));
      expect(r.status).toBe(200);
      expect(r.body.balanceAfter).toEqual({ principal: 50000, bonus: 5000 });

      const cr = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(member.id, c.consume, { expectedSplit: c.expect }));
      expect(cr.status).toBe(200);
      expect(cr.body.consumption.deductionRule).toBe(c.rule);
      expect({ principal: cr.body.consumption.principalAmount, bonus: cr.body.consumption.bonusAmount }).toEqual(c.expect);
      expect(await balanceOf(ctx, member.id)).toEqual({ principal: 50000 - c.expect.principal, bonus: 5000 - c.expect.bonus });

      // 撤销前把规则改掉，撤销仍按原单构成恢复
      await setRule(ctx, 'principal_first');
      const rv = await api(ctx.app, ctx.owner, 'POST', `/api/consumptions/${cr.body.consumption.id}/reverse`, {
        idempotencyKey: randomUUID(),
        reason: '金额录入错误',
      });
      expect(rv.status).toBe(200);
      expect({ principal: rv.body.reversal.principalAmount, bonus: rv.body.reversal.bonusAmount }).toEqual(c.expect);
      expect(await balanceOf(ctx, member.id)).toEqual({ principal: 50000, bonus: 5000 });
    });
  }

  it('店员不能自定义赠金；套餐只是常用金额，赠金按充值后所在档的比例（会员体系 v2）', async () => {
    const member = await createMember(ctx, '套餐会员', '19900002001');
    const denied = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 50000, 5000, { bonusMode: 'custom' }));
    expect(denied.status).toBe(403);
    // 不说明赠金方式的旧请求：与按档的赠金（500 元在 L0，没有赠金）不一致，要求重新确认
    const stale = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 50000, 5000));
    expect(stale.body.error).toMatchObject({ code: 'BONUS_CHANGED', details: { bonusCents: 0 } });

    const [plan] = await ctx.sql<{ id: number }[]>`
      INSERT INTO recharge_plans (name, pay_amount, bonus_amount) VALUES ('常泡 500', 50000, 5000) RETURNING id`;
    // 套餐上原来写的赠金不再用
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 50000, 5000, { planId: plan!.id, bonusMode: 'auto' }))).body.error.code).toBe('BONUS_CHANGED');
    const ok = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 50000, 0, { planId: plan!.id, bonusMode: 'auto' }));
    expect(ok.status).toBe(200);
    expect(ok.body.recharge).toMatchObject({ planName: '常泡 500', bonusAmount: 0 });

    // 套餐金额与提交不一致（例如刚被修改）时拒绝
    const mismatch = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 60000, 0, { planId: plan!.id, bonusMode: 'auto' }));
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('PLAN_CHANGED');
  });

  it('项目价格以服务端为准，价格变动时要求重新确认', async () => {
    const member = await createMember(ctx, '项目会员', '19900002002');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 100000));
    const [item] = await ctx.sql<{ id: number }[]>`INSERT INTO service_items (name, price) VALUES ('汤泉入场', 12800) RETURNING id`;
    const ok = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', {
      idempotencyKey: randomUUID(),
      memberId: member.id,
      lines: [{ itemId: item!.id, quantity: 2 }],
      expectedTotal: 25600,
      expectedSplit: { principal: 25600, bonus: 0 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.consumption.lines[0]).toMatchObject({ name: '汤泉入场', unitPrice: 12800, quantity: 2, amount: 25600 });

    const stale = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', {
      idempotencyKey: randomUUID(),
      memberId: member.id,
      lines: [{ itemId: item!.id, quantity: 1 }],
      expectedTotal: 9900,
      expectedSplit: { principal: 9900, bonus: 0 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PRICE_CHANGED');
  });
});

describe('确认后扣款规则被修改', () => {
  it('实际扣款构成与确认不一致时拒绝，按新构成重新确认后才入账', async () => {
    await setRule(ctx, 'principal_first');
    const member = await createMember(ctx, '规则变更会员', '19900002101');
    await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(member.id, 10000, 5000));
    // 店员按「先本金」确认：扣本金 60、赠金 0
    const confirmed = splitDeduction(6000, { principal: 10000, bonus: 5000 }, 'principal_first');
    expect(confirmed).toEqual({ ok: true, principal: 6000, bonus: 0 });
    // 确认期间另一位店主把规则改成「先赠金」
    await setRule(ctx, 'bonus_first');
    const body = consumeBody(member.id, 6000, {
      expectedBalance: { principal: 10000, bonus: 5000 },
      expectedSplit: { principal: 6000, bonus: 0 },
    });
    const stale = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', body);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('SPLIT_CHANGED');
    expect(stale.body.error.details).toMatchObject({ rule: 'bonus_first', split: { principal: 1000, bonus: 5000 } });
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 10000, bonus: 5000 });

    // 按新构成重新确认（新的操作编号）
    const ok = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', {
      ...body,
      idempotencyKey: randomUUID(),
      expectedSplit: { principal: 1000, bonus: 5000 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.consumption).toMatchObject({ principalAmount: 1000, bonusAmount: 5000, deductionRule: 'bonus_first' });
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 9000, bonus: 0 });
    await setRule(ctx, 'principal_first');
  });

  it('页面提交缺少确认的扣款构成时拒绝', async () => {
    const member = await createMember(ctx, '缺少构成会员', '19900002102');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(member.id, 10000));
    const { expectedSplit: _omit, ...body } = consumeBody(member.id, 1000);
    const res = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', body);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('扣款构成');
    expect(await balanceOf(ctx, member.id)).toEqual({ principal: 10000, bonus: 0 });
  });
});
