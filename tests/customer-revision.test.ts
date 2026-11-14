// 客户部「有没有变化」的指纹（整合进主线时加的）：页面每 3 秒只读这一条，变了才重读各块较重的统计。
//   · 没有变化时指纹不变；前台挂账与撤销、充值、来访、客户部自己的记录之后会变；
//   · 要客户部的查看权限；只读（不写任何东西）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createMember, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let memberId: number;
const revision = async (cookie = ctx.owner) => {
  const r = await api(ctx.app, cookie, 'GET', '/api/customer/revision');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.revision as string;
};

beforeAll(async () => {
  ctx = await setup();
  memberId = (await createMember(ctx, '指纹合成会员', '19900009901')).id;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 5, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('客户部同步指纹', () => {
  it('要客户部的查看权限；没有变化时不变', async () => {
    expect((await api(ctx.app, '', 'GET', '/api/customer/revision')).status).toBe(401);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/customer/revision')).status).toBe(403);
    const a = await revision();
    expect(typeof a).toBe('string');
    expect(await revision()).toBe(a);
    // 读别的客户部接口不改变它
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/customer/overview')).status).toBe(200);
    expect(await revision()).toBe(a);
  });

  it('充值、来访、前台挂账与撤销挂账、客户部记录服务之后都会变', async () => {
    const seen = new Set<string>([await revision()]);
    const changed = async (what: string) => {
      const next = await revision();
      expect(seen.has(next), `${what}之后指纹应该变`).toBe(false);
      seen.add(next);
    };
    // 充值：会员账本多一行
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(memberId, 10_000))).status).toBe(200);
    await changed('充值');
    // 来访：在店手牌多一个
    const checkin = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'R001', zone: 'male' }] });
    expect(checkin.status, JSON.stringify(checkin.body)).toBe(201);
    const visitId = checkin.body.visits[0].id as number;
    await changed('来访');
    // 挂账：明细多一行、账单金额变
    const item = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '指纹合成项目', category: '零售', price: 500 });
    const itemId = item.body.items.find((i: { name: string }) => i.name === '指纹合成项目').id as number;
    const charge = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines: [{ itemId, quantity: 2 }], expectedTotal: 1000 });
    expect(charge.status, JSON.stringify(charge.body)).toBe(200);
    await changed('挂账');
    // 撤销一行挂账：没有新行，但开着的账单金额变了
    const [line] = await ctx.sql<{ id: number }[]>`SELECT l.id FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE v.id = ${visitId} AND l.status = 'active' ORDER BY l.id DESC LIMIT 1`;
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/lines/${line!.id}/void`, { reason: '指纹用例撤销' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    await changed('撤销挂账');
    // 客户部记录一条服务
    const note = await api(ctx.app, ctx.owner, 'POST', '/api/customer/notes', {
      requestKey: randomUUID(), memberId, kind: 'maintenance', occurredAt: new Date().toISOString(), outcome: '已联系', content: '指纹用例的合成记录',
    });
    expect(note.status, JSON.stringify(note.body)).toBe(200);
    await changed('客户部记录服务');
    // 之后没有变化：稳定
    const last = await revision();
    expect(await revision()).toBe(last);
  });
});
