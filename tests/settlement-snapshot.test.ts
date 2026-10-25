// 日结在有人记账时读取：所有汇总必须来自同一时刻的数据快照，不能出现假差异。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, consumeBody, createMember, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => ctx.close());

describe('日结快照一致性', () => {
  it('连续充值 / 消费的同时反复查询日结，每次核对都一致', async () => {
    const members = [];
    for (let i = 0; i < 4; i++) {
      const m = await createMember(ctx, `快照会员${i}`, `1990000600${i}`);
      await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 100000));
      members.push(m);
    }
    const me = await api(ctx.app, ctx.owner, 'GET', '/api/auth/me');
    const today = me.body.today as string;
    const methods = ['wechat', 'alipay', 'cash', 'bank_card'];

    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 60; i++) {
        const m = members[i % members.length]!;
        const res =
          i % 3 === 2
            ? await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 100 + i))
            : await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 100 + i, 0, { paymentMethod: methods[i % 4] }));
        expect(res.status).toBe(200);
      }
      writing = false;
    })();

    const problems: string[] = [];
    let reads = 0;
    const readLoop = async () => {
      while (writing) {
        const s = await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`);
        reads++;
        for (const c of s.body.checks as { ok: boolean; label: string; detail: string }[]) {
          if (!c.ok) problems.push(`${c.label}：${c.detail}`);
        }
        const byMethod = (s.body.recharge.byMethod as { amount: number; count: number }[]).reduce(
          (acc, m) => ({ amount: acc.amount + m.amount, count: acc.count + m.count }),
          { amount: 0, count: 0 },
        );
        if (byMethod.amount !== s.body.recharge.paid || byMethod.count !== s.body.recharge.count) {
          problems.push(`渠道分项 ${byMethod.amount}/${byMethod.count} ≠ 实收 ${s.body.recharge.paid}/${s.body.recharge.count}`);
        }
      }
    };

    // 营业中确认日结：保存的快照本身必须自洽（渠道分项 = 实收，单据推算 = 流水净变动）
    let closes = 0;
    const closeLoop = async () => {
      while (writing) {
        const res = await api(ctx.app, ctx.owner, 'POST', `/api/settlements/${today}/close`, { note: '营业中确认' });
        expect(res.status).toBe(200);
        closes++;
        const [row] = await ctx.sql<{ snapshot: any }[]>`SELECT snapshot FROM daily_settlements WHERE business_date = ${today}`;
        const t = row!.snapshot;
        const methodSum = t.recharge.byMethod.reduce((a: number, m: { amount: number }) => a + m.amount, 0);
        if (methodSum !== t.recharge.paid) problems.push(`日结快照渠道分项 ${methodSum} ≠ 实收 ${t.recharge.paid}`);
        const principal = t.recharge.paid - t.consume.principal + t.reversal.principal;
        if (principal !== t.net.principal) problems.push(`日结快照单据推算 ${principal} ≠ 流水 ${t.net.principal}`);
      }
    };

    await Promise.all([writer, readLoop(), readLoop(), closeLoop()]);
    expect(reads).toBeGreaterThan(5);
    expect(closes).toBeGreaterThan(2);
    expect(problems).toEqual([]);
  });
});
