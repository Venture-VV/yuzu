// Batch 3 · S3.1–S3.3：门票 12 小时跳档、单牌与同行合并结账、结清才能离店、会员储值同事务扣款、团购券防重、反结账。
// 用 ctx.at 指定业务发生时间来模拟「在店 N 小时」。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitDeduction } from '../src/shared/deduction';
import { ticketPrice, ticketSegments, ticketTierLabel } from '../src/shared/checkout';
import type { Actor } from '../src/server/lib/context';
import { checkout, type CheckoutInputData } from '../src/server/modules/frontdesk/checkout';
import { checkin } from '../src/server/modules/frontdesk/visits';
import { api, createMember, rechargeBody, setup, type TestContext } from './helpers';

const H = 3_600_000;
let ctx: TestContext;
let clerk: Actor;
let deps: { sql: TestContext['sql']; config: TestContext['config'] };
let tickets: Record<string, number>;
let scrub: number;

const checks = async () => {
  const fd = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { key: string; ok: boolean; label: string; detail: string }[];
  for (const c of fd) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  const today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
  for (const c of st.checks as { ok: boolean; label: string; detail: string }[]) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};
/** 在 at 时刻接待一位客人，返回来访 id */
const enter = async (tagCode: string, at: Date, extra: Record<string, unknown> = {}) => {
  const r = await checkin(deps, { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male', ...extra }] }, { actor: clerk, at });
  return r.visits[0]!.id;
};
const pay = (visitIds: number[], expectedTotal: number, payments: CheckoutInputData['payments'], at = new Date(), extra: Partial<CheckoutInputData> = {}) =>
  checkout(deps, { clientKey: randomUUID(), visitIds, expectedTotal, payments, ...extra }, { actor: clerk, at });
const tagState = async (code: string) =>
  (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${code} AND v.status = 'open'`)[0]!.n;

beforeAll(async () => {
  ctx = await setup();
  deps = { sql: ctx.sql, config: ctx.config };
  clerk = { id: ctx.clerkId, username: 'clerk', displayName: '测试店员', role: 'clerk', duties: [], mustChangePassword: false };
  const res = await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'A', from: 1, to: 40, width: 3, zone: 'male' });
  expect(res.status).toBe(200);
  const types = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/ticket-types')).body as { id: number; name: string }[];
  tickets = Object.fromEntries(types.map((t) => [t.name, t.id]));
  const item = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '搓澡', category: '洗浴', price: 6800 });
  scrub = item.body.items.find((i: { name: string }) => i.name === '搓澡').id;
});
afterAll(async () => ctx.close());

describe('门票 12 小时跳档（附录 B）', () => {
  it('段数与票价：不含餐 499 → 599 → 1098 → 1198 → 1697', () => {
    const t = { price12h: 49900, price24h: 59900 };
    const at = (h: number) => ticketPrice(t, ticketSegments(h * H, 0));
    expect([at(0), at(11.99), at(12), at(12.01), at(24), at(24.5), at(36), at(36.1), at(48), at(48.1)]).toEqual([
      49900, 49900, 49900, 59900, 59900, 109800, 109800, 119800, 119800, 169700,
    ]);
    expect(ticketTierLabel(3)).toBe('24 小时档 + 12 小时档');
    expect(ticketTierLabel(4)).toBe('24 小时档 × 2');
    // 宽限 15 分钟：12 小时 10 分仍是 12 小时档，12 小时 16 分跳档
    expect(ticketSegments(12 * H + 10 * 60_000, 15)).toBe(1);
    expect(ticketSegments(12 * H + 16 * 60_000, 15)).toBe(2);
  });

  it('内置店主确认的票种；接待默认「不含餐」，可改票种（留痕）', async () => {
    expect(Object.keys(tickets)).toEqual(['不含餐', '含餐门票', '全日自助餐', '儿童免票（1 米以下）']);
    const id = await enter('A001', new Date());
    const v = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${id}`)).body;
    expect(v.ticket).toMatchObject({ name: '不含餐', price12h: 49900, price24h: 59900, segments: 1, amount: 49900 });
    const changed = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${id}/ticket`, { ticketTypeId: tickets['全日自助餐'] });
    expect(changed.body.ticket).toMatchObject({ name: '全日自助餐', amount: 99900 });
    expect(changed.body.history.some((h: { kind: string }) => h.kind === 'ticket')).toBe(true);
  });

  it('改票价只影响之后选定的客人（接待时留存票价）', async () => {
    const before = await enter('A002', new Date());
    const put = await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/ticket-types/${tickets['不含餐']}`, { name: '不含餐', price12h: 52900, price24h: 62900, isDefault: true, sortOrder: 10 });
    expect(put.status).toBe(200);
    const after = await enter('A003', new Date());
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${before}`)).body.ticket.amount).toBe(49900);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${after}`)).body.ticket.amount).toBe(52900);
    await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/ticket-types/${tickets['不含餐']}`, { name: '不含餐', price12h: 49900, price24h: 59900, isDefault: true, sortOrder: 10 });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/ticket-types', { name: '店员不能加', price12h: 1, price24h: 1 })).status).toBe(403);
  });
});

describe('结账', () => {
  it('单牌现金结账：门票按在店 13 小时跳到 24 小时档，账单结清、手牌释放', async () => {
    const t0 = new Date(Date.now() - 13 * H);
    const id = await enter('A010', t0);
    const post = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${id}/charges`, { clientKey: randomUUID(), lines: [{ itemId: scrub, quantity: 1 }], expectedTotal: 6800 });
    expect(post.status).toBe(200);
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${id}`)).body;
    expect(preview.visits[0].ticket).toMatchObject({ segments: 2, amount: 59900, tierLabel: '24 小时档' });
    expect(preview.totalAmount).toBe(66700);

    // 少收、多收、应收与确认时不同：都拒绝
    await expect(pay([id], 66700, [{ method: 'cash', amount: 60000 }])).rejects.toMatchObject({ code: 'NOT_SETTLED' });
    await expect(pay([id], 60000, [{ method: 'cash', amount: 60000 }])).rejects.toMatchObject({ code: 'PRICE_CHANGED' });

    const done = await pay([id], 66700, [{ method: 'wechat', amount: 66700, ref: '尾号 1234' }]);
    expect(done).toMatchObject({ status: 'completed', totalAmount: 66700 });
    expect(done.bills[0]).toMatchObject({ ticketName: '不含餐', ticketSegments: 2, ticketAmount: 59900, amount: 66700 });
    expect(await tagState('A010')).toBe(0);
    const v = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${id}`)).body;
    expect(v.status).toBe('settled');
    expect(v.lines.find((l: { name: string }) => l.name.startsWith('门票'))).toMatchObject({ amount: 59900 });
    // 已结束的来访不能再挂账、不能再结账
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${id}/charges`, { clientKey: randomUUID(), lines: [{ itemId: scrub, quantity: 1 }], expectedTotal: 6800 })).status).toBe(409);
    await expect(pay([id], 0, [])).rejects.toMatchObject({ code: 'VISIT_CLOSED' });
    await checks();
  });

  it('同一操作编号重提返回同一张结账单', async () => {
    const id = await enter('A011', new Date(Date.now() - H));
    const key = randomUUID();
    const body = { clientKey: key, visitIds: [id], expectedTotal: 49900, payments: [{ method: 'cash' as const, amount: 49900 }] };
    const a = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', body);
    const b = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', body);
    expect(a.status).toBe(200);
    expect(b.body.checkoutNo).toBe(a.body.checkoutNo);
    const look = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=checkout`)).body;
    expect(look).toMatchObject({ found: true, type: 'checkout', checkout: { checkoutNo: a.body.checkoutNo } });
  });

  it('儿童免票：门票 0 元不挂明细，应收 0 也能结账', async () => {
    const id = await enter('A012', new Date(Date.now() - 2 * H), { ticketTypeId: tickets['儿童免票（1 米以下）'] });
    const done = await pay([id], 0, []);
    expect(done.bills[0]).toMatchObject({ ticketAmount: 0, amount: 0 });
    expect(done.payments).toEqual([]);
  });

  it('同行合并结账：会员储值 + 团购券 + 现金；储值在同一事务生成消费单；券码不能重复登记', async () => {
    const m = await createMember(ctx, '合并结账', '19900003001');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/recharges', rechargeBody(m.id, 100000, 10000))).status).toBe(200);
    const r = await checkin(
      deps,
      { clientKey: randomUUID(), guests: [{ tagCode: 'A020', zone: 'male', memberId: m.id }, { tagCode: 'A021', zone: 'male' }] },
      { actor: clerk, at: new Date(Date.now() - 2 * H) },
    );
    const [a, b] = r.visits.map((v) => v.id) as [number, number];
    const preview = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${a},${b}`)).body;
    expect(preview.totalAmount).toBe(99800);
    expect(preview.members).toHaveLength(1);
    const split = splitDeduction(50000, { principal: 100000, bonus: 10000 }, 'principal_first');
    if (!split.ok) throw new Error('余额不足');
    const coupon = { method: 'coupon' as const, platform: 'meituan' as const, code: '1234 5678 9012', dealName: '不含餐 12 小时', amount: 39900 };
    const done = await pay([a, b], 99800, [
      { method: 'wallet', memberId: m.id, amount: 50000, expectedSplit: { principal: split.principal, bonus: split.bonus } },
      coupon,
      { method: 'cash', amount: 9900 },
    ]);
    expect(done.bills).toHaveLength(2);
    const wallet = done.payments.find((p) => p.method === 'wallet')!;
    expect(wallet.consumption).toMatchObject({ principal: 50000, bonus: 0, status: 'completed' });
    expect(done.payments.find((p) => p.method === 'coupon')!.coupon).toMatchObject({ code: '123456789012', status: 'active' });
    const [k] = await ctx.sql<{ checkoutId: number; totalAmount: number }[]>`SELECT checkout_id, total_amount FROM consumptions WHERE id = ${wallet.consumption!.id}`;
    expect(k).toMatchObject({ checkoutId: done.id, totalAmount: 50000 });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body.principalBalance).toBe(50000);
    // 同一张券再登记：拒绝
    const again = await enter('A022', new Date(Date.now() - H));
    await expect(pay([again], 49900, [{ ...coupon, amount: 49900 }])).rejects.toMatchObject({ code: 'COUPON_USED' });
    expect(await tagState('A022')).toBe(1);
    await checks();
  });

  it('储值扣款构成与确认时不同、余额不足、店员以外的岗位权限', async () => {
    const m = await createMember(ctx, '构成变化', '19900003002');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 30000, 0));
    const id = await enter('A023', new Date(Date.now() - H), { memberId: m.id });
    await expect(pay([id], 49900, [{ method: 'wallet', memberId: m.id, amount: 49900, expectedSplit: { principal: 49900, bonus: 0 } }])).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    await expect(
      pay([id], 49900, [
        { method: 'wallet', memberId: m.id, amount: 20000, expectedSplit: { principal: 10000, bonus: 10000 } },
        { method: 'cash', amount: 29900 },
      ]),
    ).rejects.toMatchObject({ code: 'SPLIT_CHANGED' });
    expect(await tagState('A023')).toBe(1);
  });
});

describe('反结账', () => {
  it('撤销结账单：储值按原单恢复、团购券可重新登记、门票明细作废，客人恢复在店后可重新结账', async () => {
    const m = await createMember(ctx, '反结账', '19900003101');
    await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 100000, 0));
    const id = await enter('A030', new Date(Date.now() - 3 * H), { memberId: m.id });
    const coupon = { method: 'coupon' as const, platform: 'douyin' as const, code: 'DY20261029AB', amount: 20000 };
    const done = await pay([id], 49900, [{ method: 'wallet', memberId: m.id, amount: 29900, expectedSplit: { principal: 29900, bonus: 0 } }, coupon]);
    expect(await tagState('A030')).toBe(0);

    // 店员不能反结账
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/checkouts/${done.id}/void`, { reason: '收款方式记错' })).status).toBe(403);
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${done.id}/void`, { reason: '收款方式记错' });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ status: 'voided', voidReason: '收款方式记错' });
    expect(v.body.payments.find((p: { method: string }) => p.method === 'wallet').consumption.status).toBe('reversed');
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m.id}`)).body.principalBalance).toBe(100000);
    expect(await tagState('A030')).toBe(1);
    const visit = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${id}`)).body;
    expect(visit.status).toBe('open');
    expect(visit.bill.amountCents).toBe(0);
    expect(visit.history.some((h: { kind: string }) => h.kind === 'reopen')).toBe(true);
    // 重复反结账被拒绝
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${done.id}/void`, { reason: '再来一次' })).status).toBe(409);
    await checks();

    // 更正后重新结账：同一张券可以再登记
    const redo = await pay([id], 49900, [{ ...coupon }, { method: 'alipay', amount: 29900 }]);
    expect(redo.status).toBe('completed');
    await checks();
  });

  it('手牌已发给其他客人时不能反结账', async () => {
    const id = await enter('A031', new Date(Date.now() - H));
    const done = await pay([id], 49900, [{ method: 'cash', amount: 49900 }]);
    await enter('A031', new Date());
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${done.id}/void`, { reason: '测试' });
    expect(v.status).toBe(409);
    expect(v.body.error.code).toBe('TAG_REISSUED');
    await checks();
  });

  it('结账单、团购券登记只能作废不能删改（数据库保护）', async () => {
    const [c] = await ctx.sql<{ id: number }[]>`SELECT id FROM checkouts LIMIT 1`;
    await expect(ctx.sql`UPDATE checkouts SET total_amount = total_amount + 1 WHERE id = ${c!.id}`).rejects.toThrow(/只能反结账/);
    await expect(ctx.sql`DELETE FROM checkouts WHERE id = ${c!.id}`).rejects.toThrow(/禁止删除/);
    await expect(ctx.sql`UPDATE bills SET status = 'open', closed_at = NULL WHERE status = 'settled'`).rejects.toThrow(/已结束的账单/);
  });
});
