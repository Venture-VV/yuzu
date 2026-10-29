// R1.2 资金轨（店主 2026-10-29 签认，见 docs/PENDING_DECISIONS.md「2026-10-29 店主答复」）：
//   · 收款（充值、结账、反结账）前必须先开班，经营规则可关闭；
//   · 优惠 / 免单：值班经理及以上当场授权（绑定客人与金额、只能用一次），一张结账单最多一笔；「其他」收款必须填备注；
//   · 改成更便宜的票种或免票（接待时直接选免票也算）要当场授权并填原因，同一次接待只授权一次；
//   · 会员持有在店手牌时不在会员工作台扣储值；
//   · 撤销与反结账时限默认 48 小时，超过只有店主；反结账后重结的门票按第一次结账的时刻计算；跳档宽限默认 15 分钟；
//   · 反结账退款：现金扣减反结账人当班的应有现金，扫码等只列提醒；原收银员的班次仍算这笔收款；
//   · 日结分列应收、优惠、净营业额、实收；异常清单列出优惠、降档 / 免票、超时撤销误开的牌、作废明细。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessBreakdown } from '../src/shared/checkout';
import { shiftDate } from '../src/shared/labels';
import type { Actor } from '../src/server/lib/context';
import { checkout } from '../src/server/modules/frontdesk/checkout';
import { checkin } from '../src/server/modules/frontdesk/visits';
import { createStaff } from '../src/server/modules/staff';
import { api, balanceOf, consumeBody, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

const H = 3_600_000;
let ctx: TestContext;
let duty: string;
let dutyId: number;
let tickets: Record<string, number>;
let today: string;

const clerkActor = (): Actor => ({ id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false });
const deps = () => ({ sql: ctx.sql, config: ctx.config });
const openShift = async (cookie: string, openingCash = 0) => (await api(ctx.app, cookie, 'POST', '/api/shifts', { openingCash })).body as { id: number };
const currentShift = async (cookie: string) => (await api(ctx.app, cookie, 'GET', '/api/shifts/current')).body.shift;
const enter = (tagCode: string, guest: Record<string, unknown> = {}, body: Record<string, unknown> = {}) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', ...guest }], ...body });
const visitOf = async (tagCode: string, guest: Record<string, unknown> = {}) => (await enter(tagCode, guest)).body.visits[0].id as number;
/** 在 at 时刻接待（直接调用模块，便于制造在店时长） */
const enterAt = async (tagCode: string, at: Date) =>
  (await checkin(deps(), { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male' }] }, { actor: clerkActor(), at })).visits[0]!.id;
const authorize = (cookie: string, approver: string, purpose: string, scope: unknown) =>
  api(ctx.app, cookie, 'POST', '/api/auth/authorize', { username: approver, password: PASSWORD, purpose, scope });
const pay = (cookie: string, visitIds: number[], expectedTotal: number, payments: unknown[]) =>
  api(ctx.app, cookie, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds, expectedTotal, payments });
const voidCheckout = (cookie: string, id: number, reason: string) => api(ctx.app, cookie, 'POST', `/api/frontdesk/checkouts/${id}/void`, { reason });
const settlement = async () => (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;

beforeAll(async () => {
  ctx = await setup();
  // 本文件按新库的默认：收款前必须先开班（tests/helpers 为之前的用例关闭了这条规则）
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { requireOpenShift: true })).status).toBe(200);
  dutyId = await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 80, width: 3, zone: 'male' })).status).toBe(200);
  const types = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/ticket-types')).body as { id: number; name: string }[];
  tickets = Object.fromEntries(types.map((t) => [t.name, t.id]));
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
});
afterAll(async () => ctx.close());

describe('收款前必须先开班（默认开）', () => {
  it('没有开班时充值、结账、反结账整笔拒绝（SHIFT_REQUIRED）；开班后原样重提入账，记到这个班次', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.rules.requireOpenShift).toBe(true);
    const m = await createMember(ctx, '先开班', '19900007001');
    const body = rechargeBody(m.id, 10000, 0, { paymentMethod: 'cash' });
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SHIFT_REQUIRED');
    const [n] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM recharges WHERE member_id = ${m.id}`;
    expect(n!.n).toBe(0);
    const v = await visitOf('R001');
    expect((await pay(ctx.clerk, [v], 49900, [{ method: 'cash', amount: 49900 }])).body.error.code).toBe('SHIFT_REQUIRED');

    const shift = await openShift(ctx.clerk, 10000);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', body)).status).toBe(200);
    const done = await pay(ctx.clerk, [v], 49900, [{ method: 'cash', amount: 49900 }]);
    expect(done.status).toBe(200);
    const [k] = await ctx.sql<{ shiftId: number }[]>`SELECT shift_id FROM checkouts WHERE id = ${done.body.id}`;
    expect(k!.shiftId).toBe(shift.id);
    // 反结账同样要先开班
    expect((await voidCheckout(duty, done.body.id, '测试先开班')).body.error.code).toBe('SHIFT_REQUIRED');
    await openShift(duty);
    expect((await voidCheckout(duty, done.body.id, '测试先开班')).status).toBe(200);
  });

  it('经营规则里关闭后，没开班也能收款，不记班次', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { requireOpenShift: false })).status).toBe(200);
    try {
      const m = await createMember(ctx, '规则关闭', '19900007002');
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 5000));
      expect(r.status).toBe(200);
      const [k] = await ctx.sql<{ shiftId: number | null }[]>`SELECT shift_id FROM recharges WHERE id = ${r.body.recharge.id}`;
      expect(k!.shiftId).toBeNull();
    } finally {
      await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { requireOpenShift: true });
    }
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.rules.requireOpenShift).toBe(true);
  });
});

describe('优惠 / 免单：值班经理及以上当场授权', () => {
  it('不带授权不能登记；店员不能授权；授权绑定客人与金额、只能用一次；免单时优惠等于应收', async () => {
    const v = await visitOf('R010');
    expect((await pay(ctx.clerk, [v], 49900, [{ method: 'discount', amount: 2100 }, { method: 'cash', amount: 47800 }])).status).toBe(400);
    const byClerk = await authorize(ctx.clerk, 'clerk', 'checkout_discount', { visitIds: [v], amount: 2100, reason: '抹零' });
    expect(byClerk.status).toBe(403);
    expect(byClerk.body.error.code).toBe('AUTH_NOT_ALLOWED');
    const g = await authorize(ctx.clerk, 'duty', 'checkout_discount', { visitIds: [v], amount: 2100, reason: '抹零' });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ purpose: 'checkout_discount', approverName: '值班经理', scope: { visitIds: [v], amount: 2100, reason: '抹零' } });

    // 金额与授权不一致：整笔拒绝，客人仍在店，授权没有用掉
    const wrong = await pay(ctx.clerk, [v], 49900, [{ method: 'discount', amount: 3000, grantId: g.body.grantId }, { method: 'cash', amount: 46900 }]);
    expect(wrong.body.error.code).toBe('GRANT_SCOPE');
    const [st] = await ctx.sql<{ status: string }[]>`SELECT status FROM visits WHERE id = ${v}`;
    expect(st!.status).toBe('open');
    const ok = await pay(ctx.clerk, [v], 49900, [{ method: 'discount', amount: 2100, grantId: g.body.grantId }, { method: 'cash', amount: 47800 }]);
    expect(ok.status).toBe(200);
    expect(ok.body.payments.find((p: { method: string }) => p.method === 'discount')).toMatchObject({ amount: 2100, ref: '抹零', approvedByName: '值班经理' });
    const [used] = await ctx.sql<{ usedRef: string }[]>`SELECT used_ref FROM auth_grants WHERE id = ${g.body.grantId}`;
    expect(used!.usedRef).toMatch(/^checkout:/);

    // 同一个授权不能再用
    const v2 = await visitOf('R011');
    const reuse = await pay(ctx.clerk, [v2], 49900, [{ method: 'discount', amount: 2100, grantId: g.body.grantId }, { method: 'cash', amount: 47800 }]);
    expect(reuse.body.error.code).toBe('GRANT_USED');
    // 授权的客人不一致
    const g2 = await authorize(ctx.clerk, 'duty', 'checkout_discount', { visitIds: [v], amount: 49900, reason: '投诉补偿' });
    expect((await pay(ctx.clerk, [v2], 49900, [{ method: 'discount', amount: 49900, grantId: g2.body.grantId }])).body.error.code).toBe('GRANT_SCOPE');
    // 免单：优惠等于应收，没有其他收款
    const g3 = await authorize(ctx.clerk, 'duty', 'checkout_discount', { visitIds: [v2], amount: 49900, reason: '投诉补偿' });
    expect((await pay(ctx.clerk, [v2], 49900, [{ method: 'discount', amount: 49900, grantId: g3.body.grantId }])).status).toBe(200);
  });

  it('一张结账单最多一笔优惠；「其他」收款必须填备注', async () => {
    const v = await visitOf('R012');
    const two = await pay(ctx.clerk, [v], 49900, [
      { method: 'discount', amount: 100, grantId: randomUUID() },
      { method: 'discount', amount: 100, grantId: randomUUID() },
      { method: 'cash', amount: 49700 },
    ]);
    expect(two.status).toBe(400);
    const noNote = await pay(ctx.clerk, [v], 49900, [{ method: 'other', amount: 49900 }]);
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.message).toContain('其他');
    expect((await pay(ctx.clerk, [v], 49900, [{ method: 'other', amount: 49900, ref: '老客户挂账，明天转账' }])).status).toBe(200);
    // 数据库兜底：没有授权人的优惠、没有备注的「其他」都写不进去
    const [c] = await ctx.sql<{ id: number }[]>`SELECT id FROM checkouts ORDER BY id DESC LIMIT 1`;
    await expect(ctx.sql`INSERT INTO checkout_payments (checkout_id, method, amount, ref) VALUES (${c!.id}, 'discount', 100, '抹零')`).rejects.toThrow(/discount_check/);
    await expect(ctx.sql`INSERT INTO checkout_payments (checkout_id, method, amount, ref) VALUES (${c!.id}, 'other', 100, ' ')`).rejects.toThrow(/other_note_check/);
  });

  it('日结分列应收、优惠、净营业额、实收；交班表单列优惠、不计入应有现金；异常清单列出优惠', async () => {
    const s = await settlement();
    for (const c of s.checks) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    const b = businessBreakdown(s.business);
    expect(b.discount).toBe(2100 + 49900);
    expect(b.netRevenue).toBe(b.receivable - b.discount);
    const received = s.business.byMethod
      .filter((m: { method: string }) => ['cash', 'wechat', 'alipay', 'bank_card', 'other'].includes(m.method))
      .reduce((n: number, m: { amount: number }) => n + m.amount, 0);
    expect(b.received).toBe(received);
    const discounts = s.anomalies.filter((a: { kind: string }) => a.kind === 'discount');
    expect(discounts.map((a: { amount: number }) => a.amount).sort((x: number, y: number) => x - y)).toEqual([2100, 49900]);
    expect(discounts.find((a: { amount: number }) => a.amount === 2100).description).toContain('抹零');
    expect(discounts[0].description).toContain('值班经理当场授权');
    const shift = (await currentShift(ctx.clerk)).summary;
    expect(shift.checkoutByMethod.find((m: { method: string }) => m.method === 'discount')).toMatchObject({ amount: 2100 + 49900 });
    expect(shift.cash.expected).toBe(shift.cash.opening + shift.cash.checkout + shift.cash.recharge - shift.cash.refund);
    // CSV 导出同样分列
    const csv = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}/export`)).body as string;
    for (const label of ['应收（结账 − 反结账）', '优惠 / 免单', '净营业额', '实收（现金类）']) expect(csv).toContain(label);
  });
});

describe('降低票种与免票：值班经理及以上当场授权并填原因', () => {
  it('改成更便宜的票种要授权，授权必须覆盖这张手牌与票种；改贵不用；授权人与原因记在改票种记录上', async () => {
    const v = await visitOf('R020', { ticketTypeId: tickets['全日自助餐'] });
    const url = `/api/frontdesk/visits/${v}/ticket`;
    const down = await api(ctx.app, ctx.clerk, 'POST', url, { ticketTypeId: tickets['不含餐'] });
    expect(down.status).toBe(422);
    expect(down.body.error).toMatchObject({ code: 'TICKET_AUTH_REQUIRED', details: { items: [{ tagCode: 'R020', ticketTypeId: tickets['不含餐'] }] } });
    const other = await authorize(ctx.clerk, 'duty', 'ticket_discount', { items: [{ tagCode: 'R099', ticketTypeId: tickets['不含餐'] }], reason: '选错票种' });
    expect((await api(ctx.app, ctx.clerk, 'POST', url, { ticketTypeId: tickets['不含餐'], grantId: other.body.grantId })).body.error.code).toBe('GRANT_SCOPE');
    const g = await authorize(ctx.clerk, 'duty', 'ticket_discount', { items: [{ tagCode: 'R020', ticketTypeId: tickets['不含餐'] }], reason: '接待时选错票种' });
    expect((await api(ctx.app, ctx.clerk, 'POST', url, { ticketTypeId: tickets['不含餐'], grantId: g.body.grantId })).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', url, { ticketTypeId: tickets['含餐门票'] })).status).toBe(200);
    const rows = await ctx.sql<{ toTypeId: number; approvedBy: number | null; reason: string | null }[]>`
      SELECT to_type_id, approved_by, reason FROM visit_ticket_changes WHERE visit_id = ${v} ORDER BY id`;
    expect(rows).toEqual([
      { toTypeId: tickets['不含餐'], approvedBy: dutyId, reason: '接待时选错票种' },
      { toTypeId: tickets['含餐门票'], approvedBy: null, reason: null },
    ]);
  });

  it('接待时直接选儿童免票也要授权，同一次接待的几位儿童只授权一次', async () => {
    const child = tickets['儿童免票（1 米以下）']!;
    const guests = [
      { tagCode: 'R021', zone: 'male', ticketTypeId: tickets['不含餐'] },
      { tagCode: 'R022', zone: 'male', ticketTypeId: child },
      { tagCode: 'R023', zone: 'male', ticketTypeId: child },
    ];
    const no = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests });
    expect(no.body.error).toMatchObject({
      code: 'TICKET_AUTH_REQUIRED',
      details: { items: [{ tagCode: 'R022', ticketTypeId: child }, { tagCode: 'R023', ticketTypeId: child }] },
    });
    const g = await authorize(ctx.clerk, 'duty', 'ticket_discount', { items: [{ tagCode: 'R022', ticketTypeId: child }, { tagCode: 'R023', ticketTypeId: child }], reason: '1 米以下儿童' });
    const key = randomUUID();
    const ok = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: key, guests, ticketGrantId: g.body.grantId });
    expect(ok.status).toBe(201);
    const rows = await ctx.sql<{ code: string; approvedBy: number; reason: string }[]>`
      SELECT t.code, c.approved_by, c.reason FROM visit_ticket_changes c JOIN visits v ON v.id = c.visit_id JOIN hand_tags t ON t.id = v.tag_id
      WHERE v.checkin_key = ${key} ORDER BY t.code`;
    expect(rows).toEqual([
      { code: 'R022', approvedBy: dutyId, reason: '1 米以下儿童' },
      { code: 'R023', approvedBy: dutyId, reason: '1 米以下儿童' },
    ]);
    // 同一个授权不能再给别的接待用
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', {
      clientKey: randomUUID(),
      guests: [{ tagCode: 'R024', zone: 'male', ticketTypeId: child }],
      ticketGrantId: g.body.grantId,
    });
    expect(again.body.error.code).toBe('GRANT_USED');
  });

  it('结账时补选免票不行：要先在手牌详情里改票种并授权', async () => {
    const v = await visitOf('R025');
    await ctx.sql`UPDATE visits SET ticket_type_id = NULL, ticket_price_12h = NULL, ticket_price_24h = NULL WHERE id = ${v}`;
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [v],
      tickets: [{ visitId: v, ticketTypeId: tickets['儿童免票（1 米以下）'] }],
      expectedTotal: 0,
      payments: [],
    });
    expect(r.body.error.code).toBe('TICKET_AUTH_REQUIRED');
  });

  it('异常清单列出降档 / 免票（含授权人与原因）', async () => {
    const overrides = (await settlement()).anomalies.filter((a: { kind: string }) => a.kind === 'ticket_override');
    expect(overrides.some((a: { description: string }) => a.description.includes('接待时选错票种') && a.description.includes('值班经理当场授权'))).toBe(true);
    expect(overrides.some((a: { description: string }) => a.description.includes('接待时选免票') && a.description.includes('R022、R023'))).toBe(true);
  });
});

describe('会员持有在店手牌时不在会员工作台扣储值', () => {
  it('在店时会员消费被拒（MEMBER_IN_STORE），余额不变；结账离店后照常', async () => {
    const m = await createMember(ctx, '在店会员', '19900007003');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 20000))).status).toBe(200);
    const v = await visitOf('R030', { memberId: m.id });
    const blocked = await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 1000));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'MEMBER_IN_STORE', details: { tagCode: 'R030' } });
    expect(await balanceOf(ctx, m.id)).toEqual({ principal: 20000, bonus: 0 });
    expect((await pay(ctx.clerk, [v], 49900, [{ method: 'cash', amount: 49900 }])).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/consumptions', consumeBody(m.id, 1000))).status).toBe(200);
  });
});

describe('撤销与反结账时限、反结账后重结、跳档宽限', () => {
  it('结账超过 48 小时：值班经理不能反结账（REVERSAL_WINDOW），店主可以', async () => {
    const v = await enterAt('R040', new Date(Date.now() - 50 * H));
    const c = await checkout(deps(), { clientKey: randomUUID(), visitIds: [v], expectedTotal: 49900, payments: [{ method: 'cash', amount: 49900 }] }, { actor: clerkActor(), at: new Date(Date.now() - 49 * H) });
    const late = await voidCheckout(duty, c.id, '超过时限');
    expect(late.status).toBe(422);
    expect(late.body.error).toMatchObject({ code: 'REVERSAL_WINDOW', details: { windowHours: 48 } });
    await openShift(ctx.owner);
    expect((await voidCheckout(ctx.owner, c.id, '店主处理')).status).toBe(200);
  });

  it('在店 11 小时结账，反结账后过了 2 小时重结：仍是 12 小时档；多次反结账仍按第一次结账的时刻；这个时刻不能改', async () => {
    const v = await enterAt('R050', new Date(Date.now() - 13 * H));
    const first = await checkout(deps(), { clientKey: randomUUID(), visitIds: [v], expectedTotal: 49900, payments: [{ method: 'cash', amount: 49900 }] }, { actor: clerkActor(), at: new Date(Date.now() - 2 * H) });
    expect((await voidCheckout(duty, first.id, '收款方式记错')).status).toBe(200);
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${v}`)).body;
    expect(preview.visits[0].ticket).toMatchObject({ segments: 1, amount: 49900 });
    expect(new Date(preview.visits[0].ticket.endAt).getTime()).toBe(new Date(first.createdAt).getTime());
    const detail = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${v}`)).body;
    expect(detail.ticket).toMatchObject({ amount: 49900, endAt: preview.visits[0].ticket.endAt });
    await expect(ctx.sql`UPDATE visits SET ticket_end_at = now() WHERE id = ${v}`).rejects.toThrow(/门票计到的时间/);
    const second = await pay(ctx.clerk, [v], 49900, [{ method: 'wechat', amount: 49900 }]);
    expect(second.status).toBe(200);
    expect((await voidCheckout(duty, second.body.id, '再次更正')).status).toBe(200);
    const [row] = await ctx.sql<{ ticketEndAt: string }[]>`SELECT ticket_end_at FROM visits WHERE id = ${v}`;
    expect(new Date(row!.ticketEndAt).getTime()).toBe(new Date(first.createdAt).getTime());
  });

  it('跳档宽限默认 15 分钟：在店 12 小时 10 分仍是 12 小时档，12 小时 20 分是 24 小时档', async () => {
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body.rules.overtimeGraceMinutes).toBe(15);
    const a = await enterAt('R060', new Date(Date.now() - (12 * H + 10 * 60_000)));
    const b = await enterAt('R061', new Date(Date.now() - (12 * H + 20 * 60_000)));
    const p = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${a},${b}`)).body;
    expect(p.visits.map((x: { ticket: { amount: number } }) => x.ticket.amount)).toEqual([49900, 59900]);
  });
});

describe('反结账退款的交班口径与结账记录', () => {
  it('退款按原收款方式列在反结账人的班次：现金扣减应有现金，扫码只列提醒；收银员的班次仍算这笔收款', async () => {
    const v = await visitOf('R070');
    const c = await pay(ctx.clerk, [v], 49900, [{ method: 'cash', amount: 9900 }, { method: 'wechat', amount: 40000, ref: '尾号 1234' }]);
    expect(c.status).toBe(200);
    const mineBefore = (await currentShift(ctx.clerk)).summary;
    const before = (await currentShift(duty)).summary;
    expect((await voidCheckout(duty, c.body.id, '客人投诉退款')).status).toBe(200);
    const after = (await currentShift(duty)).summary;
    const by = (s: { refunds: { byMethod: { method: string; amount: number }[] } }, m: string) => s.refunds.byMethod.find((x) => x.method === m)?.amount ?? 0;
    expect(after.cash.refund - before.cash.refund).toBe(9900);
    expect(after.cash.expected - before.cash.expected).toBe(-9900);
    expect(by(after, 'wechat') - by(before, 'wechat')).toBe(40000);
    expect(after.voids.find((x: { checkoutNo: string }) => x.checkoutNo === c.body.checkoutNo)).toMatchObject({ amount: 49900, cashRefund: 9900 });
    const mine = (await currentShift(ctx.clerk)).summary;
    expect(mine.cash.expected).toBe(mineBefore.cash.expected);
    expect(mine.checkouts).toEqual(mineBefore.checkouts);
  });

  it('结账记录可以切换营业日：店员只看本营业日，值班经理可以看之前的营业日', async () => {
    const yesterday = shiftDate(today, -1);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkouts?date=${yesterday}`)).status).toBe(403);
    expect((await api(ctx.app, duty, 'GET', `/api/frontdesk/checkouts?date=${yesterday}`)).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/checkouts')).status).toBe(200);
  });

  it('异常清单列出超时撤销误开的牌与作废明细；前台自检与日结核对全部通过', async () => {
    const late = await enterAt('R075', new Date(Date.now() - 20 * 60_000));
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/visits/${late}/cancel`, { reason: '开错了牌' })).status).toBe(200);
    const v = await visitOf('R076');
    const posted = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${v}/charges`, { clientKey: randomUUID(), lines: [], customLines: [{ name: '挂错的饮料', amount: 1800 }], expectedTotal: 1800 });
    expect(posted.status).toBe(200);
    const lineId = posted.body.lines.find((l: { name: string }) => l.name === '挂错的饮料').id;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/lines/${lineId}/void`, { reason: '挂错手牌' })).status).toBe(200);
    // 刚开的牌马上撤销（15 分钟内）不进异常清单
    const quick = await visitOf('R077');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${quick}/cancel`, { reason: '客人改主意' })).status).toBe(200);
    const s = await settlement();
    const kinds = s.anomalies.map((a: { kind: string; description: string }) => a.kind);
    expect(kinds).toContain('line_void');
    const cancels = s.anomalies.filter((a: { kind: string }) => a.kind === 'visit_cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].description).toContain('开错了牌');
    for (const c of s.checks) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    const fd = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[];
    for (const c of fd) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  });
});
