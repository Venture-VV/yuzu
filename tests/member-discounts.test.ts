// 会员体系 v2 第三期（v0.7.25，docs/MEMBERSHIP_P3.md 第 2 节）：会员折扣在手牌结账时自动算。
//   · QY-011 导入时按会员文档预填（客房房费；L3 7.5 折、L4 6.5 折、L5 5.5 折、L6 5 折），发布前不算、发布后自动列出；
//   · 必须带上省得最多的一种（MEMBER_DISCOUNT_REQUIRED），金额对不上拒绝（MEMBER_DISCOUNT_CHANGED），与券、优惠 / 免单二选一；
//   · 只打会员本人账单上的适用明细；几位会员合并结账取省得最多的；按档阶取折扣；每周几 / 每月几号；
//   · 入账：收款「会员折扣」、部门快照只分摊到适用明细、退款单不能退这部分、反结账后重结照样算；
//   · 到期没处理的先按规则处理再算；桌台结账不算；自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discountOff, type Benefit, type BenefitCatalog } from '../src/shared/benefits';
import type { CheckoutPreview } from '../src/shared/checkout';
import { shiftDate } from '../src/shared/labels';
import { rechargeOutcome, type MemberGradeInfo, type MembershipRules } from '../src/shared/membership';
import { benefitChecks } from '../src/server/modules/benefits';
import { createStaff } from '../src/server/modules/staff';
import { api, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let today: string;
let roomId: number;

const yuan = (n: number) => Math.round(n * 100);
/** 省下的 = 合计 × (100 − 付几成) ÷ 100，对省下的金额四舍五入到分（M47） */
const off = (base: number, rate: number) => Math.floor((base * (100 - rate) + 50) / 100);

const catalog = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/benefits')).body as BenefitCatalog;
const byCode = async (code: string) => (await catalog()).items.find((b) => b.code === code)!;
const edit = async (code: string, patch: Partial<Benefit>) => {
  const b = await byCode(code);
  const { id, version, name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, discountTarget, weekdays, monthDays, content, conditions } =
    b;
  const r = await api(ctx.app, ctx.owner, 'PUT', `/api/benefits/${id}`, {
    expectedVersion: version,
    ...{ name, category, startGrade, startTier, period, quantity, tierQuantities, templateId, events, festivalDates, discountTarget, weekdays, monthDays, content, conditions },
    ...patch,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Benefit;
};
const setStatus = async (code: string, status: 'published' | 'paused') => {
  const b = await byCode(code);
  const r = await api(ctx.app, ctx.owner, 'POST', `/api/benefits/${b.id}/status`, { expectedVersion: b.version, status });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const rules = async () => (await api(ctx.app, ctx.clerk, 'GET', '/api/membership/rules')).body as MembershipRules;
const gradeOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/grade`)).body as MemberGradeInfo;
const recharge = async (memberId: number, paid: number) => {
  const info = await gradeOf(memberId);
  const bonus = rechargeOutcome(await rules(), info.state.grade, info.rollingRechargeCents, paid).bonusCents;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', {
    idempotencyKey: randomUUID(),
    memberId,
    planId: null,
    paidAmount: paid,
    bonusAmount: bonus,
    paymentMethod: 'wechat',
    paymentConfirmed: true,
    bonusMode: 'auto',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
let phoneNo = 0;
/** 新会员充到给定金额（L3 = 3 万、L4 = 5 万） */
const member = async (name: string, paidYuan: number) => {
  phoneNo += 1;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone: `1993333${String(phoneNo).padStart(4, '0')}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id as number;
  if (paidYuan > 0) await recharge(id, yuan(paidYuan));
  return id;
};
let tagNo = 0;
/** 前台接待（可带会员），返回来访与账单 */
const enter = async (memberId: number | null, groupWith?: number) => {
  tagNo += 1;
  const tagCode = `D${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', {
    clientKey: randomUUID(),
    guests: [{ tagCode, zone: 'male', memberId }],
    ...(groupWith ? { groupWithVisitId: groupWith } : {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const visitId = r.body.visits[0].id as number;
  const [v] = await ctx.sql<{ billId: number }[]>`SELECT bill_id FROM visits WHERE id = ${visitId}`;
  return { visitId, billId: Number(v!.billId), tagCode };
};
/** 入住钟点房、马上退房：房费挂到这位客人的手牌账单上；返回房费合计 */
const roomFee = async (tagCode: string, billId: number) => {
  const s = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', { clientKey: randomUUID(), roomId, expectedRate: 12810, tagCode, guests: 1 });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  const pre = (await api(ctx.app, ctx.clerk, 'GET', `/api/rooms/stays/${s.body.id}/checkout-preview`)).body as { dueAmount: number; depositByMethod: unknown[] };
  const c = await api(ctx.app, ctx.clerk, 'POST', `/api/rooms/stays/${s.body.id}/close`, {
    clientKey: randomUUID(),
    expectedDue: pre.dueAmount,
    expectedDeposits: pre.depositByMethod,
  });
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', `/api/rooms/${roomId}/housekeeping`, { status: 'clean' })).status).toBe(200);
  const [r] = await ctx.sql<{ n: number }[]>`SELECT coalesce(sum(amount), 0)::int AS n FROM bill_lines WHERE bill_id = ${billId} AND status = 'active' AND source = 'room'`;
  return r!.n;
};
const preview = async (visitIds: number[]) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitIds.join(',')}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as CheckoutPreview;
};
const checkout = (visitIds: number[], total: number, payments: unknown[]) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds, expectedTotal: total, payments });
/** 按核对的会员折扣（第一项）结清：其余收现金 */
const settleWithDiscount = async (visitIds: number[]) => {
  const p = await preview(visitIds);
  const d = p.memberDiscounts![0]!;
  const r = await checkout(visitIds, p.totalAmount, [
    { method: 'member_discount', memberId: d.memberId, benefitId: d.benefitId, amount: d.amount },
    { method: 'cash', amount: p.totalAmount - d.amount },
  ]);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { checkout: r.body as { id: number; payments: { method: string; amount: number; memberName: string | null; ref: string }[] }, preview: p, discount: d };
};
const allChecksOk = async () => {
  for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
  for (const c of await benefitChecks(ctx.sql)) {
    if (c.label.includes('自动发放')) continue;
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  // 首充、续充最低放到 1,000（只为凑档方便）
  const r = await rules();
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...r, firstRechargeMinCents: yuan(1000), topUpMinCents: yuan(1000) })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/benefits/import')).status).toBe(200);
  // 客房：开启、一间钟点房（128 元 / 3 小时）
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
  // 房费 128.10 元：7.5 折省 32.025 元、6.5 折省 44.835 元——都落在半分上，核对对省下的金额四舍五入（M47）
  const t = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '钟点包房', kind: 'hourly', price: 12810, blockMinutes: 180 });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  const rm = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo: '901', floor: '9', roomTypeId: t.body.types.find((x: { name: string }) => x.name === '钟点包房').id });
  expect(rm.status, JSON.stringify(rm.body)).toBe(200);
  roomId = rm.body.rooms.find((x: { roomNo: string }) => x.roomNo === '901').id;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'D', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
});
afterAll(async () => {
  await ctx?.close();
});

describe('折后的分（M47）：对省下的金额四舍五入到分', () => {
  it('半分进一（1.01 元 5 折省 0.51 元；1.26 元、0.30 元 7.5 折各省 0.32、0.08 元）；整数分不变；没有金额为 0', () => {
    expect([discountOff(101, 50), discountOff(126, 75), discountOff(30, 75), discountOff(400, 75), discountOff(1, 50), discountOff(1, 99)]).toEqual([51, 32, 8, 100, 1, 0]);
    expect([discountOff(0, 75), discountOff(-10, 75)]).toEqual([0, 0]);
    // 逐个核对：省下的 r 满足 100r − 50 ≤ 合计 × (100 − 折扣) < 100r + 50（四舍五入、半分进一）
    for (let base = 1; base <= 600; base++) {
      for (let rate = 10; rate <= 99; rate++) {
        const exact = base * (100 - rate);
        const r = discountOff(base, rate);
        if (!(100 * r - 50 <= exact && exact < 100 * r + 50)) throw new Error(`合计 ${base} 分、付 ${rate} 成：省 ${r} 分不对`);
      }
    }
  });
});

describe('包房房费折扣（QY-011）', () => {
  let l3: number;
  let firstCheckout: number;
  /** 第一项里发布后开的那张牌（还没结），第二项接着结 */
  let open: { visitId: number; billId: number; tagCode: string; base: number };

  it('还没发布：结账不列会员折扣，照常结；发布后 L3 会员只打本人的客房房费 7.5 折，四舍五入到分', async () => {
    l3 = await member('观澜会员', 30000);
    expect((await gradeOf(l3)).state.grade).toBe(3);
    const a = await enter(l3);
    await roomFee(a.tagCode, a.billId);
    expect((await preview([a.visitId])).memberDiscounts).toEqual([]);
    const plain = await preview([a.visitId]);
    expect((await checkout([a.visitId], plain.totalAmount, [{ method: 'cash', amount: plain.totalAmount }])).status).toBe(200);

    await setStatus('QY-011', 'published');
    const b = await enter(l3);
    const base = await roomFee(b.tagCode, b.billId);
    expect(base).toBeGreaterThan(0);
    const p = await preview([b.visitId]);
    expect(p.memberDiscounts).toEqual([
      expect.objectContaining({ memberId: l3, code: 'QY-011', rate: 75, target: 'room', base, amount: off(base, 75), tagCode: b.tagCode }),
    ]);
    // 半分：128.10 元 × 25% = 32.025 元 → 省 32.03 元（对折后应付取整会只省 32.02 元）
    expect([base, p.memberDiscounts![0]!.amount]).toEqual([12810, 3203]);
    open = { ...b, base };
  });

  it('没带会员折扣被拒（不能漏）；金额对不上被拒；与优惠 / 免单一起提交被拒；带上省得最多的那一种结清', async () => {
    const b = open;
    const base = open.base;
    const p = await preview([b.visitId]);
    const d = p.memberDiscounts![0]!;
    const missing = await checkout([b.visitId], p.totalAmount, [{ method: 'cash', amount: p.totalAmount }]);
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('MEMBER_DISCOUNT_REQUIRED');
    expect(missing.body.error.message).toContain('派对房及包房折扣');
    const wrong = await checkout([b.visitId], p.totalAmount, [
      { method: 'member_discount', memberId: l3, benefitId: d.benefitId, amount: d.amount - 1 },
      { method: 'cash', amount: p.totalAmount - d.amount + 1 },
    ]);
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('MEMBER_DISCOUNT_CHANGED');
    const both = await checkout([b.visitId], p.totalAmount, [
      { method: 'member_discount', memberId: l3, benefitId: d.benefitId, amount: d.amount },
      { method: 'discount', amount: 100, grantId: randomUUID() },
      { method: 'cash', amount: p.totalAmount - d.amount - 100 },
    ]);
    expect(both.status).toBe(400);
    expect(both.body.error.message).toContain('二选一');

    const { checkout: c } = await settleWithDiscount([b.visitId]);
    firstCheckout = c.id;
    const md = c.payments.find((x) => x.method === 'member_discount')!;
    expect([md.amount, md.memberName, md.ref]).toEqual([off(base, 75), '观澜会员', expect.stringContaining('7.5 折')]);
    // 部门快照：会员折扣只分摊到客房，门票不分
    const items = await ctx.sql<{ category: string; discount: number }[]>`
      SELECT category, sum(discount)::int AS discount FROM checkout_items WHERE checkout_id = ${c.id} GROUP BY 1 ORDER BY 1`;
    expect(items).toEqual(expect.arrayContaining([{ category: '客房', discount: off(base, 75) }, { category: '门票', discount: 0 }]));
    // ERP「营业数据」与经营总览同一口径：今天的会员折扣 = 今天结了的会员折扣合计（测试会话预检 b49f23b）
    const today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today as string;
    const q = `?from=${today}&to=${today}`;
    const erp = (await api(ctx.app, ctx.owner, 'GET', `/api/erp/revenue${q}`)).body as { kpis: { memberDiscount: number; net: number } };
    const exec = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/executive${q}`)).body as { kpis: { memberDiscount: number; net: number } };
    const [sum] = await ctx.sql<{ n: number }[]>`
      SELECT coalesce(sum(p.amount), 0)::int AS n FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
      WHERE p.method = 'member_discount' AND c.status = 'completed' AND c.business_date = ${today}`;
    expect(sum!.n).toBe(off(base, 75));
    expect([erp.kpis.memberDiscount, exec.kpis.memberDiscount]).toEqual([sum!.n, sum!.n]);
    expect(erp.kpis.net).toBe(exec.kpis.net);
    await allChecksOk();
  });

  it('退款单不能退会员折扣；反结账以后重新结账照样算', async () => {
    const opts = (await api(ctx.app, ctx.owner, 'GET', `/api/frontdesk/checkouts/${firstCheckout}/refund-options`)).body as { nonRefundable: { method: string; amount: number }[] };
    expect(opts.nonRefundable.map((n) => n.method)).toContain('member_discount');
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${firstCheckout}/void`, { reason: '收错了重结' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const visitId = (await ctx.sql<{ visitId: number }[]>`SELECT visit_id FROM checkout_bills WHERE checkout_id = ${firstCheckout}`)[0]!.visitId;
    const again = await settleWithDiscount([Number(visitId)]);
    expect(again.discount.code).toBe('QY-011');
    await allChecksOk();
  });

  it('按档阶取一行：L4 会员 6.5 折；两位会员合并结账只用省得最多的一种、只打那位会员本人的房费', async () => {
    const l4 = await member('望岳会员', 50000);
    expect((await gradeOf(l4)).state.grade).toBe(4);
    const a = await enter(l3);
    const baseA = await roomFee(a.tagCode, a.billId);
    const b = await enter(l4, a.visitId);
    const baseB = await roomFee(b.tagCode, b.billId);
    const p = await preview([a.visitId, b.visitId]);
    expect(p.memberDiscounts!.map((d) => [d.memberId, d.rate, d.base, d.amount])).toEqual([
      [l4, 65, baseB, off(baseB, 65)],
      [l3, 75, baseA, off(baseA, 75)],
    ]);
    // 带省得少的那一种被拒
    const lesser = p.memberDiscounts![1]!;
    const r = await checkout([a.visitId, b.visitId], p.totalAmount, [
      { method: 'member_discount', memberId: lesser.memberId, benefitId: lesser.benefitId, amount: lesser.amount },
      { method: 'cash', amount: p.totalAmount - lesser.amount },
    ]);
    expect(r.body.error?.code).toBe('MEMBER_DISCOUNT_CHANGED');
    const { checkout: c } = await settleWithDiscount([a.visitId, b.visitId]);
    expect(c.payments.find((x) => x.method === 'member_discount')!.amount).toBe(off(baseB, 65));
  });

  it('用了优惠 / 免单（经理授权）就不算会员折扣，也不要求带上', async () => {
    const b = await enter(l3);
    await roomFee(b.tagCode, b.billId);
    const p = await preview([b.visitId]);
    expect(p.memberDiscounts!.length).toBe(1);
    const grant = await api(ctx.app, ctx.clerk, 'POST', '/api/auth/authorize', {
      username: 'duty',
      password: PASSWORD,
      purpose: 'checkout_discount',
      scope: { visitIds: [b.visitId], amount: 500, reason: '客人投诉补偿' },
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    const r = await checkout([b.visitId], p.totalAmount, [
      { method: 'discount', amount: 500, grantId: grant.body.grantId },
      { method: 'cash', amount: p.totalAmount - 500 },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body.payments as { method: string }[]).map((x) => x.method).sort()).toEqual(['cash', 'discount']);
  });

  it('到期没处理的先按规则处理：L3 会员周期与补充期都过了（该降到 L2）就不再享 L3 起的包房折扣', async () => {
    const m = await member('该降档会员', 30000);
    // 模拟到期处理这一位没跑：周期与补充期都已经过去
    await ctx.sql`
      UPDATE members SET cycle_start = ${shiftDate(today, -485)}, cycle_end = ${shiftDate(today, -121)}, grace_until = ${shiftDate(today, -1)} WHERE id = ${m}`;
    const v = await enter(m);
    await roomFee(v.tagCode, v.billId);
    expect((await preview([v.visitId])).memberDiscounts).toEqual([]);
    const p = await preview([v.visitId]);
    const r = await checkout([v.visitId], p.totalAmount, [{ method: 'cash', amount: p.totalAmount }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await gradeOf(m)).state.grade).toBe(2);
  });
});

describe('会员日、整张账单、按日期', () => {
  it('会员日（QY-054）：填好「整张账单 9 折、每月今天」才能发布、才算；改成别的日子就不算', async () => {
    const m = await member('会员日会员', 5000);
    const day = Number(today.slice(8, 10));
    await edit('QY-054', { discountTarget: 'bill', quantity: 90, monthDays: [day] });
    await setStatus('QY-054', 'published');
    const v = await enter(m);
    const p = await preview([v.visitId]);
    expect(p.memberDiscounts).toEqual([expect.objectContaining({ code: 'QY-054', rate: 90, target: 'bill', base: p.totalAmount, amount: off(p.totalAmount, 90) })]);
    await edit('QY-054', { monthDays: [day === 1 ? 2 : day - 1] });
    expect((await preview([v.visitId])).memberDiscounts).toEqual([]);
    // 每周几：今天是周几就算
    const weekday = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    await edit('QY-054', { monthDays: [], weekdays: [weekday] });
    expect((await preview([v.visitId])).memberDiscounts!.map((d) => d.code)).toEqual(['QY-054']);
    await setStatus('QY-054', 'paused');
    expect((await preview([v.visitId])).memberDiscounts).toEqual([]);
  });

  it('非会员不算；桌台结账不能用会员折扣', async () => {
    const v = await enter(null);
    expect((await preview([v.visitId])).memberDiscounts).toEqual([]);
    const t = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/checkout', {
      clientKey: randomUUID(),
      sessionIds: [1],
      expectedTotal: 100,
      payments: [{ method: 'member_discount', memberId: 1, benefitId: 1, amount: 100 }],
    });
    expect(t.status).toBe(400);
    expect(t.body.error.message).toContain('桌台结账不算会员折扣');
  });

  it('自检全部一致；会员详情「本月可享」列出折扣（结账时自动）', async () => {
    await allChecksOk();
    const m = await member('看折扣的会员', 30000);
    const b = (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${m}/benefits`)).body as { items: { code: string; discount: { rate: number; text: string } | null }[] };
    expect(b.items.find((i) => i.code === 'QY-011')?.discount).toEqual({ rate: 75, text: '结账时自动 · 7.5 折 · 客房房费 · 每天' });
    expect(duty).toBeTruthy();
  });
});
