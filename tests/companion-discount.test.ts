// 同行优惠（v0.7.26，QY-041，docs/MEMBERSHIP_FINISH.md 第 5 节；PENDING_DECISIONS M80、M81）：
//   · 导入时预填「同行的门票」、L3·初 带 1 位、L6·初 起带 2 位，不填折扣——发布不了，填了折扣才能发布；
//   · 同行 = 合并结账里这位会员以外、不是会员的客人；每位能享的会员最多带「同行几位」，按适用明细多的先挑、相同时按手牌号；
//   · 金额 = 挑中几位的适用明细合计打折，省下的四舍五入到分；与本人的折扣比，用省得多的那一种（一单一种）；
//   · 入账：收款「会员折扣」写明同行的手牌、适用明细只记那几位同行的，部门快照照此分摊；停用的会员不享；自检照常全过。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discountOff, type Benefit, type BenefitCatalog } from '../src/shared/benefits';
import type { CheckoutPreview } from '../src/shared/checkout';
import type { MemberGradeInfo, MembershipRules } from '../src/shared/membership';
import { benefitChecks } from '../src/server/modules/benefits';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
const yuan = (n: number) => Math.round(n * 100);

const catalog = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/benefits')).body as BenefitCatalog;
const byCode = async (code: string) => (await catalog()).items.find((b) => b.code === code)!;
const editRaw = async (code: string, patch: Partial<Benefit>) => {
  const b = await byCode(code);
  const { id, version, name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, discountTarget, companionCount, companionCounts, weekdays, monthDays, content, conditions } = b;
  return api(ctx.app, ctx.owner, 'PUT', `/api/benefits/${id}`, {
    expectedVersion: version,
    ...{ name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, discountTarget, companionCount, companionCounts, weekdays, monthDays, content, conditions },
    ...patch,
  });
};
const setStatus = async (code: string, status: 'published' | 'paused') => {
  const b = await byCode(code);
  return api(ctx.app, ctx.owner, 'POST', `/api/benefits/${b.id}/status`, { expectedVersion: b.version, status });
};
const gradeOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/grade`)).body as MemberGradeInfo;
let phoneNo = 0;
/** 新会员，按「手动调整会员档阶」调到给定档阶 */
const member = async (name: string, grade: number, tier: number | null = grade === 0 ? null : 0) => {
  phoneNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone: `1996666${String(phoneNo).padStart(4, '0')}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id as number;
  const info = await gradeOf(id);
  const a = await api(ctx.app, ctx.owner, 'POST', `/api/members/${id}/grade`, { clientKey: randomUUID(), grade, tier, reason: '同行优惠用例', expectedVersion: info.version });
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  return id;
};
let tagNo = 0;
/** 一起接待几位客人（同一个同行组）：第一位可带会员，其余是散客或给定的会员 */
const enterGroup = async (memberIds: (number | null)[]) => {
  const guests = memberIds.map((memberId) => {
    tagNo += 1;
    return { tagCode: `G${String(tagNo).padStart(3, '0')}`, zone: 'male', memberId };
  });
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body.visits as { id: number; tagCode: string }[]).map((v) => ({ visitId: v.id, tagCode: v.tagCode }));
};
const preview = async (visitIds: number[]) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitIds.join(',')}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as CheckoutPreview;
};
const ticketOf = (p: CheckoutPreview, tagCode: string) => p.visits.find((v) => v.tagCode === tagCode)!.ticket!.amount;

beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'G', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  const r = (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(1000), topUpMinCents: yuan(1000) })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/benefits/import')).status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('同行优惠（QY-041）', () => {
  it('导入时预填同行的门票、L3 带 1 位、L6 起 2 位，不填折扣：发布不了；填了折扣能发布', async () => {
    const q = await byCode('QY-041');
    expect(q).toMatchObject({ category: 'discount', status: 'draft', discountTarget: 'companion_ticket', companionCount: 1, companionCounts: [{ grade: 6, tier: 0, quantity: 2 }], quantity: null });
    const no = await setStatus('QY-041', 'published');
    expect(no.status).toBe(422);
    expect(no.body.error.details.problems).toEqual([expect.stringContaining('折扣')]);
    // 「同行的」明细要填同行几位
    const missing = await editRaw('QY-041', { quantity: 80, companionCount: null });
    expect(missing.status, JSON.stringify(missing.body)).toBe(200);
    expect((await setStatus('QY-041', 'published')).body.error.details.problems).toEqual([expect.stringContaining('同行几位')]);
    expect((await editRaw('QY-041', { quantity: 80, companionCount: 1 })).status).toBe(200);
    expect((await setStatus('QY-041', 'published')).status).toBe(200);
    // 别的明细不留同行几位
    const other = await byCode('QY-011');
    expect(other.companionCount).toBeNull();
  });

  it('L3 会员带 1 位同行：打门票 8 折，挑手牌号在前的一位（一样多时）；会员客人不算同行', async () => {
    const m = await member('同行会员', 3);
    const other = await member('另一位会员', 0);
    const [a, b, c, d] = await enterGroup([m, null, null, other]);
    const p = await preview([a!.visitId, b!.visitId, c!.visitId, d!.visitId]);
    const md = p.memberDiscounts![0]!;
    expect(md).toMatchObject({ memberId: m, code: 'QY-041', target: 'companion_ticket', rate: 80, companions: [b!.tagCode] });
    expect(md.base).toBe(ticketOf(p, b!.tagCode));
    expect(md.amount).toBe(discountOff(md.base, 80));
    // 结账：会员折扣带上，收款明细写明同行的手牌；部门快照只分摊到那位同行的门票
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [a!.visitId, b!.visitId, c!.visitId, d!.visitId],
      expectedTotal: p.totalAmount,
      payments: [
        { method: 'member_discount', memberId: md.memberId, benefitId: md.benefitId, amount: md.amount },
        { method: 'cash', amount: p.totalAmount - md.amount },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const pay = (r.body.payments as { method: string; ref: string }[]).find((x) => x.method === 'member_discount')!;
    expect(pay.ref).toContain(b!.tagCode);
    // 收款明细的适用明细就是那位同行的门票一条；部门快照里门票分到的优惠正好是会员折扣
    const [cp] = await ctx.sql<{ couponLines: number[] }[]>`
      SELECT coupon_lines::bigint[] AS coupon_lines FROM checkout_payments WHERE checkout_id = ${r.body.id} AND method = 'member_discount'`;
    const ticketLines = await ctx.sql<{ id: number; tagCode: string }[]>`
      SELECT l.id, t.code AS tag_code FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id JOIN hand_tags t ON t.id = v.tag_id
      WHERE v.id IN ${ctx.sql([a!.visitId, b!.visitId, c!.visitId, d!.visitId])} AND l.ticket_type_id IS NOT NULL AND l.status = 'active'`;
    expect(ticketLines).toHaveLength(4);
    expect(cp!.couponLines.map(Number)).toEqual(ticketLines.filter((x) => x.tagCode === b!.tagCode).map((x) => Number(x.id)));
    const items = await ctx.sql<{ category: string; discount: number }[]>`
      SELECT category, sum(discount)::int AS discount FROM checkout_items WHERE checkout_id = ${r.body.id} GROUP BY category`;
    expect(items.filter((x) => x.discount !== 0)).toEqual([{ category: '门票', discount: md.amount }]);
    for (const x of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
      expect(x.ok, `${x.label}：${x.detail}`).toBe(true);
    }
    for (const x of await benefitChecks(ctx.sql)) if (!x.label.includes('自动发放')) expect(x.ok, `${x.label}：${x.detail}`).toBe(true);
  });

  it('L6 会员带 2 位；只有自己没有同行时不列；停用的会员不享', async () => {
    const m = await member('山海会员', 6);
    const [a, b, c, d] = await enterGroup([m, null, null, null]);
    const p = await preview([a!.visitId, b!.visitId, c!.visitId, d!.visitId]);
    const md = p.memberDiscounts![0]!;
    expect(md.companions).toEqual([b!.tagCode, c!.tagCode]);
    expect(md.base).toBe(ticketOf(p, b!.tagCode) + ticketOf(p, c!.tagCode));
    expect(md.amount).toBe(discountOff(md.base, 80));
    // 只结会员自己：没有同行，不列同行优惠
    expect((await preview([a!.visitId])).memberDiscounts!.filter((x) => x.code === 'QY-041')).toEqual([]);
    // 停用：不享（VIP 柜等也按散客）
    await ctx.sql`UPDATE members SET status = 'frozen' WHERE id = ${m}`;
    expect((await preview([a!.visitId, b!.visitId])).memberDiscounts).toEqual([]);
  });

  it('与本人的折扣比：用省得多的那一种（一单一种）', async () => {
    // 再加一项本人门票 9 折（QY-011 改成门票、L3 起）：本人一张门票省 10%，同行优惠一位省 20%——同行优惠省得多
    expect((await editRaw('QY-011', { discountTarget: 'ticket', quantity: 90, tierQuantities: [] })).status).toBe(200);
    expect((await setStatus('QY-011', 'published')).status).toBe(200);
    const m = await member('比较会员', 3);
    const [a, b] = await enterGroup([m, null]);
    const p = await preview([a!.visitId, b!.visitId]);
    expect(p.memberDiscounts!.map((x) => x.code)).toEqual(['QY-041', 'QY-011']);
    expect(p.memberDiscounts![0]!.amount).toBeGreaterThan(p.memberDiscounts![1]!.amount);
  });
});
