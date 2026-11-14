// 客户部「有没有变化」的指纹（整合进主线时加的）：页面每 3 秒只读这一条，变了才重读各块较重的统计。
//   · 没有变化时指纹不变；前台挂账与撤销、充值、来访、客户部自己的记录之后会变；
//   · 要客户部的查看权限；只读（不写任何东西）。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

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

  it('充值、来访、前台挂账与撤销挂账、客户部记录服务、绑定申请与审核之后都会变', async () => {
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
    // 维护绑定：提交申请（多一条）、驳回（待审核的少一条）、再申请并通过（多一条生效记录）
    const managerId = await createStaff(ctx.sql, { username: 'rev-manager', displayName: '指纹合成经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
    const request = (version: number) =>
      api(ctx.app, ctx.owner, 'POST', '/api/customer/bindings/requests', { requestKey: randomUUID(), memberId, toStaffId: managerId, expectedVersion: version, reason: '指纹用例申请' });
    const review = (id: number, decision: 'approve' | 'reject') =>
      api(ctx.app, ctx.owner, 'POST', `/api/customer/bindings/requests/${id}/review`, { requestKey: randomUUID(), expectedVersion: 1, decision, reason: '指纹用例审核' });
    const first = await request(0);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await changed('提交绑定申请');
    expect((await review(first.body.id, 'reject')).status).toBe(200);
    await changed('驳回绑定申请');
    const second = await request(0);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    await changed('再次申请');
    expect((await review(second.body.id, 'approve')).status).toBe(200);
    await changed('通过绑定申请');
    // 之后没有变化：稳定
    const last = await revision();
    expect(await revision()).toBe(last);
  });
});

// 「在店与到店」列表整合时改成先用索引圈出候选（在店的、当天有有效结账的、离店时刻在当天前后的），再按原规则判断：
// 结账离店那一路由 customer-trial-reads 的用例盖住，这里补上没有结账的那一路（撤销来访按离店时刻所在的营业日算）。
describe('客户部在店与到店列表', () => {
  it('撤销的来访算在撤销当天离店，不出现在别的营业日；单看一位不受筛选影响', async () => {
    const visits = async (query: string) => {
      const r = await api(ctx.app, ctx.owner, 'GET', `/api/customer/visits?${query}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as { businessDate: string; filteredTotal: number; rows: { id: number; status: string }[] };
    };
    const checkin = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'R002', zone: 'male' }, { tagCode: 'R003', zone: 'male' }] });
    expect(checkin.status, JSON.stringify(checkin.body)).toBe(201);
    const [gone, staying] = checkin.body.visits.map((v: { id: number }) => v.id) as [number, number];
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${gone}/cancel`, { reason: '列表用例撤销' })).status).toBe(200);
    const today = (await visits('status=all')).businessDate;
    const all = await visits(`day=${today}&status=all`);
    expect(all.rows.find((r) => r.id === gone)?.status).toBe('cancelled');
    expect(all.rows.find((r) => r.id === staying)?.status).toBe('open');
    expect((await visits(`day=${today}&status=cancelled`)).rows.map((r) => r.id)).toContain(gone);
    expect((await visits(`day=${today}&status=left`)).rows.map((r) => r.id)).toContain(gone);
    expect((await visits(`day=${today}&status=open`)).rows.map((r) => r.id)).not.toContain(gone);
    // 别的营业日：撤销的不在，还在店的照样在（在店不分日子）
    const other = await visits('day=1900-01-01&status=all');
    expect(other.rows.map((r) => r.id)).not.toContain(gone);
    expect(other.rows.map((r) => r.id)).toContain(staying);
    // 单看一位：不看日子与筛选
    const detail = await api(ctx.app, ctx.owner, 'GET', `/api/customer/visits/${gone}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.visit.status).toBe('cancelled');
  });
});
