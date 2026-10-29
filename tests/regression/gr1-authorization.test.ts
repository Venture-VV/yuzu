// 测试会话 · G-R1 回归：HANDOFF_GR1 第 6.3、6.4 节里开发自测没有覆盖的条目（店主 2026-10-29 签认的授权规则）。
//   D5 授权一次有效：同一授权两笔同时提交只入账一笔；过期（5 分钟）、授权人已停用、给别的员工的授权、用途不对都拒绝；
//   D6 优惠超过应收结不了，授权不会因此用掉；
//   D7 反结账含优惠的单后重结：原授权已用过，要重新授权；营业口径按重结后的优惠；
//   D10 数据库兜底：同一授权两笔、原因不足 2 个字写不进去；
//   T5 改票种的授权只覆盖授权时的手牌。
// 收款前必须先开班（新库默认）：本文件开启这条规则，收银员与值班经理先开班。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessBreakdown } from '../../src/shared/checkout';
import { createStaff } from '../../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from '../helpers';

let ctx: TestContext;
let duty: string;
let dutyId: number;
let today: string;
let childTicketId: number;

const enter = async (tagCode: string) => {
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.visits[0].id as number;
};
const authorize = (cookie: string, approver: string, purpose: string, scope: unknown) =>
  api(ctx.app, cookie, 'POST', '/api/auth/authorize', { username: approver, password: PASSWORD, purpose, scope });
const discountGrant = async (visitIds: number[], amount: number, approver = 'duty', reason = '抹零') => {
  const g = await authorize(ctx.clerk, approver, 'checkout_discount', { visitIds, amount, reason });
  expect(g.status, JSON.stringify(g.body)).toBe(200);
  return g.body.grantId as string;
};
const checkoutBody = (visitIds: number[], discount: number, grantId: string, cash = 49900 - discount) => ({
  clientKey: randomUUID(),
  visitIds,
  expectedTotal: 49900,
  payments: [{ method: 'discount', amount: discount, grantId }, ...(cash > 0 ? [{ method: 'cash', amount: cash }] : [])],
});
const pay = (cookie: string, body: unknown) => api(ctx.app, cookie, 'POST', '/api/frontdesk/checkouts', body);
const grantRow = async (id: string) =>
  (await ctx.sql<{ usedAt: string | null; usedRef: string | null }[]>`SELECT used_at, used_ref FROM auth_grants WHERE id = ${id}`)[0]!;
const visitStatus = async (id: number) => (await ctx.sql<{ status: string }[]>`SELECT status FROM visits WHERE id = ${id}`)[0]!.status;
const breakdown = async () => businessBreakdown((await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body.business);

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { requireOpenShift: true })).status).toBe(200);
  dutyId = await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'G', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const cookie of [ctx.clerk, duty]) expect((await api(ctx.app, cookie, 'POST', '/api/shifts', { openingCash: 0 })).status).toBe(200);
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  const types = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/ticket-types')).body as { id: number; name: string }[];
  childTicketId = types.find((t) => t.name.startsWith('儿童免票'))!.id;
});
afterAll(async () => ctx.close());

describe('D5 授权一次有效', () => {
  it('同一授权两笔同时提交：只入账一笔，授权只核销一次，另一笔不是服务器错误', async () => {
    const v = await enter('G001');
    const grant = await discountGrant([v], 2100);
    const [a, b] = await Promise.all([pay(ctx.clerk, checkoutBody([v], 2100, grant)), pay(ctx.clerk, checkoutBody([v], 2100, grant))]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    const loser = a.status === 200 ? b : a;
    expect(loser.status, JSON.stringify(loser.body)).toBeLessThan(500);
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM checkout_payments WHERE grant_id = ${grant}`;
    expect(n!.n).toBe(1);
    expect((await grantRow(grant)).usedRef).toMatch(/^checkout:/);
  });

  it('授权过期（签发 5 分钟后）：GRANT_EXPIRED，客人仍在店', async () => {
    const v = await enter('G002');
    const clerkId = ctx.clerkId;
    const [g] = await ctx.sql<{ id: string }[]>`
      INSERT INTO auth_grants (purpose, requested_by, approved_by, scope, created_at, expires_at)
      VALUES ('checkout_discount', ${clerkId}, ${dutyId}, ${ctx.sql.json({ visitIds: [v], amount: 2100, reason: '抹零' })},
              now() - interval '10 minutes', now() - interval '5 minutes')
      RETURNING id`;
    const r = await pay(ctx.clerk, checkoutBody([v], 2100, g!.id));
    expect(r.body.error?.code, JSON.stringify(r.body)).toBe('GRANT_EXPIRED');
    expect(await visitStatus(v)).toBe('open');
    expect((await grantRow(g!.id)).usedAt).toBeNull();
  });

  it('授权人在使用前已停用：GRANT_INVALID', async () => {
    const id = await createStaff(ctx.sql, { username: 'duty2', displayName: '已离职经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
    const v = await enter('G003');
    const grant = await discountGrant([v], 2100, 'duty2');
    await ctx.sql`UPDATE staff SET active = false WHERE id = ${id}`;
    const r = await pay(ctx.clerk, checkoutBody([v], 2100, grant));
    expect(r.body.error?.code, JSON.stringify(r.body)).toBe('GRANT_INVALID');
    expect(await visitStatus(v)).toBe('open');
  });

  it('给别的员工的授权不能用；用途不对（改票种的授权拿来结账）也不能用', async () => {
    const v = await enter('G004');
    const grant = await discountGrant([v], 2100);
    // 店主（在班上）拿收银员申请的授权结账
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/shifts', { openingCash: 0 })).status).toBe(200);
    expect((await pay(ctx.owner, checkoutBody([v], 2100, grant))).body.error?.code).toBe('GRANT_INVALID');
    const ticket = await authorize(ctx.clerk, 'duty', 'ticket_discount', { items: [{ tagCode: 'G004', ticketTypeId: childTicketId }], reason: '1 米以下儿童' });
    expect(ticket.status).toBe(200);
    expect((await pay(ctx.clerk, checkoutBody([v], 2100, ticket.body.grantId))).body.error?.code).toBe('GRANT_INVALID');
    expect((await grantRow(grant)).usedAt).toBeNull();
    expect((await pay(ctx.clerk, checkoutBody([v], 2100, grant))).status).toBe(200);
  });
});

describe('D6 优惠超过应收', () => {
  it('优惠 500 元结 499 元的单：NOT_SETTLED，授权没有用掉', async () => {
    const v = await enter('G006');
    const grant = await discountGrant([v], 50000);
    const r = await pay(ctx.clerk, { clientKey: randomUUID(), visitIds: [v], expectedTotal: 49900, payments: [{ method: 'discount', amount: 50000, grantId: grant }] });
    expect(r.body.error?.code, JSON.stringify(r.body)).toBe('NOT_SETTLED');
    expect((await grantRow(grant)).usedAt).toBeNull();
    expect(await visitStatus(v)).toBe('open');
  });
});

describe('D7 反结账含优惠的单后重结', () => {
  it('原授权已用过要重新授权；营业口径：优惠只算重结的那笔，净营业额只多一笔「应收 − 优惠」', async () => {
    const before = await breakdown();
    const v = await enter('G007');
    const first = await discountGrant([v], 2100);
    const c1 = await pay(ctx.clerk, checkoutBody([v], 2100, first));
    expect(c1.status).toBe(200);
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${c1.body.id}/void`, { reason: '收款方式记错' })).status).toBe(200);
    expect(await visitStatus(v)).toBe('open');
    expect((await pay(ctx.clerk, checkoutBody([v], 2100, first))).body.error?.code).toBe('GRANT_USED');
    const second = await discountGrant([v], 2100);
    expect((await pay(ctx.clerk, checkoutBody([v], 2100, second))).status).toBe(200);
    const after = await breakdown();
    expect(after.discount - before.discount).toBe(2100);
    expect(after.netRevenue - before.netRevenue).toBe(49900 - 2100);
    expect(after.receivable - before.receivable).toBe(49900);
  });
});

describe('D10 数据库兜底', () => {
  it('同一授权写两笔、优惠原因不足 2 个字：约束拒绝', async () => {
    const [p] = await ctx.sql<{ grantId: string; approvedBy: number }[]>`
      SELECT grant_id, approved_by FROM checkout_payments WHERE method = 'discount' ORDER BY id LIMIT 1`;
    // 一张没有优惠的结账单（一张单最多一笔优惠的约束不会先拦下）
    const cash = await pay(ctx.clerk, { clientKey: randomUUID(), visitIds: [await enter('G013')], expectedTotal: 49900, payments: [{ method: 'cash', amount: 49900 }] });
    expect(cash.status).toBe(200);
    const other = { id: cash.body.id as number };
    await expect(ctx.sql`
      INSERT INTO checkout_payments (checkout_id, method, amount, ref, approved_by, grant_id)
      VALUES (${other!.id}, 'discount', 100, '抹零', ${p!.approvedBy}, ${p!.grantId})`).rejects.toThrow(/grant_uq/);
    const v = await enter('G010');
    const grant = await discountGrant([v], 100);
    await expect(ctx.sql`
      INSERT INTO checkout_payments (checkout_id, method, amount, ref, approved_by, grant_id)
      VALUES (${other!.id}, 'discount', 100, '抹', ${dutyId}, ${grant})`).rejects.toThrow(/discount_check/);
  });
});

describe('T5 改票种的授权只覆盖授权时的手牌', () => {
  it('授权 G011 改儿童免票，拿去改 G012：GRANT_SCOPE；G011 照常可用', async () => {
    const a = await enter('G011');
    const b = await enter('G012');
    const g = await authorize(ctx.clerk, 'duty', 'ticket_discount', { items: [{ tagCode: 'G011', ticketTypeId: childTicketId }], reason: '1 米以下儿童' });
    expect(g.status).toBe(200);
    const wrong = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${b}/ticket`, { ticketTypeId: childTicketId, grantId: g.body.grantId });
    expect(wrong.body.error?.code, JSON.stringify(wrong.body)).toBe('GRANT_SCOPE');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${a}/ticket`, { ticketTypeId: childTicketId, grantId: g.body.grantId })).status).toBe(200);
  });
});
