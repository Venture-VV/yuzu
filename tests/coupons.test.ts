// 券与会员权益（v0.7.20，飞书 RQ-006 后半；docs/COUPONS.md）：
//   · 券模板：三种券、条件校验、发过券后条件锁定（只能改名称、备注、停用）、版本号；
//   · 发券：手动（操作编号、限定等级、停用模板）、无记名批次（导出、按批作废）、开卡礼、升级礼、生日礼、充值赠券（去重）；
//   · 结账用券：会员的券在结账核对里列出能抵多少；抵扣按适用明细分摊进部门快照；不与优惠同用、每单 1 张；
//     金额对不上、别人的券、用过的券都拒绝；反结账退回；桌台结账输入无记名券码；
//   · 作废、统计、对账包、自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CouponRow, CouponTemplate, MemberCoupons } from '../src/shared/coupons';
import { issueBirthdayCoupons } from '../src/server/modules/coupons';
import { buildDailyRecon } from '../src/server/ops/recon';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let am: string;
let duty: string;
let today: string;
let tagNo = 0;
const item: Record<string, number> = {};
const tpl: Record<string, CouponTemplate> = {};

const checks = async () => {
  for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
  const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
  for (const c of st.checks as { ok: boolean; label: string; detail: string }[]) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
};
const template = async (body: Record<string, unknown>) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { validity: 'days', validDays: 30, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as CouponTemplate;
};
const issue = (memberId: number, templateId: number, quantity = 1, cookie = am, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', `/api/members/${memberId}/coupons`, { clientKey, templateId, quantity, reason: '老客人回馈' });
const couponsOf = async (memberId: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${memberId}/coupons`)).body as MemberCoupons;
const rule = async (body: Record<string, unknown>) => {
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/rules', { quantity: 1, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
/** 接待一位客人（可带会员）、挂项目，返回来访 id 与结账前核对 */
const enter = async (lines: { itemId: number; quantity: number; price: number }[] = [], memberId?: number) => {
  tagNo += 1;
  const code = `Q${String(tagNo).padStart(3, '0')}`;
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male', ...(memberId ? { memberId } : {}) }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.visits[0].id as number;
  if (lines.length) {
    const p = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${id}/charges`, {
      clientKey: randomUUID(),
      lines: lines.map(({ itemId, quantity }) => ({ itemId, quantity })),
      expectedTotal: lines.reduce((s, l) => s + l.price * l.quantity, 0),
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  }
  return id;
};
const preview = async (visitId: number) =>
  (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body as {
    totalAmount: number;
    storeCoupons: { code: string; usable: boolean; amount: number; reason: string | null; templateName: string }[];
  };
const pay = (visitId: number, total: number, payments: Record<string, unknown>[]) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: total, payments });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  am = await login(ctx.app, 'am');
  duty = await login(ctx.app, 'duty');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'Q', from: 1, to: 60, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['券搓澡', '券洗浴', 6800],
    ['券果盘', '券水吧', 3800],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
  // 等级门槛调低：第 1 级 0、第 2 级 ¥1,000、第 3 级 ¥3,000
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/rules', { vipLevelThresholds: [0, 100000, 300000] })).status).toBe(200);
});
afterAll(async () => ctx.close());

describe('券模板', () => {
  it('三种券：代金券、折扣券、兑换券；条件不全时拒绝；没有维护权限的岗位不能建', async () => {
    tpl.cash = await template({ name: '洗浴代金券', kind: 'cash', faceValue: 3000, threshold: 5000, scope: 'categories', scopeCategories: ['券洗浴'] });
    expect(tpl.cash.summary).toBe('代金券 ¥30.00 · 满 ¥50.00 可用 · 限券洗浴');
    tpl.discount = await template({ name: '八八折', kind: 'discount', ratePercent: 88, maxOff: 1000 });
    expect(tpl.discount.summary).toBe('8.8 折 · 最多减 ¥10.00');
    const types = (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/ticket-types')).body as { id: number; name: string; isDefault: boolean }[];
    const ticket = types.find((t) => t.isDefault) ?? types[0]!;
    tpl.ticket = await template({ name: '门票兑换券', kind: 'exchange', exchangeTicketTypeId: ticket.id, maxOff: 39900 });
    expect(tpl.ticket.summary).toContain('兑换');
    tpl.anon = await template({ name: '无记名二十元', kind: 'cash', faceValue: 2000, validity: 'fixed', validFrom: today, validTo: '2099-12-31' });
    tpl.vip = await template({ name: '金卡专享', kind: 'cash', faceValue: 5000, levels: [3] });

    const bad = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { name: '缺面额', kind: 'cash', validity: 'days', validDays: 7 });
    expect(bad.status).toBe(400);
    const bad2 = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { name: '日期反了', kind: 'cash', faceValue: 100, validity: 'fixed', validFrom: '2026-12-31', validTo: '2026-01-01' });
    expect(bad2.status).toBe(400);
    expect((await api(ctx.app, am, 'POST', '/api/coupons/templates', { name: 'x', kind: 'cash', faceValue: 100, validity: 'days', validDays: 1 })).status).toBe(403);
    // 发券的岗位能看到模板（选券），不能改
    expect((await api(ctx.app, am, 'GET', '/api/coupons/templates')).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/coupons/templates')).status).toBe(403);
  });

  it('发过券的模板：面额等条件不能改，名称、停用可以改；版本号对不上拒绝', async () => {
    const m = await createMember(ctx, '模板锁定', '19900008001');
    expect((await issue(m.id, tpl.discount!.id)).status).toBe(201);
    const t = (await api(ctx.app, ctx.owner, 'GET', '/api/coupons/templates')).body.find((x: CouponTemplate) => x.id === tpl.discount!.id) as CouponTemplate;
    expect(t.issued).toBe(1);
    const base = { ...t, expectedVersion: t.version };
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/coupons/templates/${t.id}`, { ...base, ratePercent: 80 })).body.error.code).toBe('TEMPLATE_LOCKED');
    const renamed = await api(ctx.app, ctx.owner, 'PUT', `/api/coupons/templates/${t.id}`, { ...base, name: '八八折（老客）' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/coupons/templates/${t.id}`, { ...base, name: '又改' })).body.error.code).toBe('TEMPLATE_STALE');
    tpl.discount = renamed.body;
  });
});

describe('发券', () => {
  it('手动发：客户经理可以发；同一操作编号重提不重复发；限定等级的券只发给对应等级；店员不能发', async () => {
    const m = await createMember(ctx, '手动发券', '19900008002');
    const key = randomUUID();
    const a = await issue(m.id, tpl.cash!.id, 2, am, key);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.coupons).toHaveLength(2);
    expect(a.body.coupons[0].code).toMatch(/^[2-9A-HJ-NP-Z]{12}$/);
    expect(a.body.coupons[0].validTo).toBe(new Date(Date.parse(`${today}T00:00:00Z`) + 29 * 86_400_000).toISOString().slice(0, 10));
    const b = await issue(m.id, tpl.cash!.id, 2, am, key);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect((await couponsOf(m.id)).counts.available).toBe(2);
    expect((await issue(m.id, tpl.cash!.id, 3, am, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await issue(m.id, tpl.vip!.id)).body.error.code).toBe('COUPON_LEVEL');
    expect((await issue(m.id, tpl.cash!.id, 1, ctx.clerk)).status).toBe(403);
  });

  it('开卡礼：建档时按规则发；期初导入、演示数据不走这条路', async () => {
    await rule({ kind: 'open_card', templateId: tpl.discount!.id });
    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name: '新会员', phone: '19900008003' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const mine = await couponsOf(r.body.id);
    expect(mine.coupons.map((c) => [c.templateName, c.issueKind, c.state])).toEqual([['八八折（老客）', 'open_card', 'available']]);
  });

  it('充值赠券与升级礼：套餐挂的券随充值发；新达到的每一级发一次升级礼，不重复', async () => {
    const plan = await api(ctx.app, ctx.owner, 'POST', '/api/plans', { name: '充一千', payAmount: 100000, bonusAmount: 10000 });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const [p] = await ctx.sql<{ id: number }[]>`SELECT id FROM recharge_plans WHERE name = '充一千'`;
    await rule({ kind: 'recharge', planId: p!.id, templateId: tpl.cash!.id, quantity: 2 });
    await rule({ kind: 'level_up', level: 2, templateId: tpl.discount!.id });
    await rule({ kind: 'level_up', level: 3, templateId: tpl.vip!.id });
    const m = await createMember(ctx, '升级会员', '19900008004');
    const before = (await couponsOf(m.id)).coupons.length;
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 100000, 10000, { planId: p!.id }))).status).toBe(200);
    let mine = (await couponsOf(m.id)).coupons;
    expect(mine.length - before).toBe(3);
    expect(mine.filter((c) => c.issueKind === 'recharge')).toHaveLength(2);
    expect(mine.filter((c) => c.issueKind === 'level_up').map((c) => c.templateId)).toEqual([tpl.discount!.id]);
    // 再充 ¥2,500：累计 ¥3,500 到第 3 级，发第 3 级的升级礼；第 2 级不再发
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 250000, 0))).status).toBe(200);
    mine = (await couponsOf(m.id)).coupons;
    expect(mine.filter((c) => c.issueKind === 'level_up').map((c) => c.templateId).sort()).toEqual([tpl.discount!.id, tpl.vip!.id].sort());
    // 一次跨两级：两级的升级礼都发
    const m2 = await createMember(ctx, '跨两级', '19900008005');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m2.id, 500000, 0))).status).toBe(200);
    expect((await couponsOf(m2.id)).coupons.filter((c) => c.issueKind === 'level_up')).toHaveLength(2);
  });

  it('生日礼：生日当月发，每年每条规则一次；没填生日、不是这个月的不发', async () => {
    await rule({ kind: 'birthday', level: 1, templateId: tpl.cash!.id });
    const month = today.slice(5, 7);
    const other = String((Number(month) % 12) + 1).padStart(2, '0');
    const yes = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name: '寿星', phone: '19900008006', birthday: `1990-${month}-15` });
    const no = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name: '下个月', phone: '19900008007', birthday: `1990-${other}-15` });
    expect(yes.status).toBe(201);
    expect(no.status).toBe(201);
    const deps = { sql: ctx.sql, config: ctx.config };
    expect(await issueBirthdayCoupons(deps)).toBeGreaterThanOrEqual(1);
    expect(await issueBirthdayCoupons(deps)).toBe(0);
    expect((await couponsOf(yes.body.id)).coupons.filter((c) => c.issueKind === 'birthday')).toHaveLength(1);
    expect((await couponsOf(no.body.id)).coupons.filter((c) => c.issueKind === 'birthday')).toHaveLength(0);
  });

  it('无记名券：生成一批、导出券码、按批作废没用的；限定等级的模板不能做无记名券', async () => {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/batches', { clientKey: randomUUID(), templateId: tpl.anon!.id, quantity: 3, note: '开业派发' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.counts.available).toBe(3);
    const csv = await ctx.app.inject({ method: 'GET', url: `/api/coupons/batches/${r.body.id}/codes.csv`, headers: { cookie: ctx.owner } });
    expect(csv.statusCode).toBe(200);
    const codes = [...csv.body.matchAll(/([2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4})/g)].map((m) => m[1]!.replaceAll('-', ''));
    expect(codes).toHaveLength(3);
    tpl.anonCodes = codes as never;
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/coupons/batches', { clientKey: randomUUID(), templateId: tpl.vip!.id, quantity: 1 })).body.error.code).toBe('COUPON_LEVEL');
    const b2 = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/batches', { clientKey: randomUUID(), templateId: tpl.anon!.id, quantity: 2 });
    const voided = await api(ctx.app, ctx.owner, 'POST', `/api/coupons/batches/${b2.body.id}/void`, { reason: '印错了' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.counts).toMatchObject({ available: 0, voided: 2 });
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/coupons/batches/${b2.body.id}/void`, { reason: '再作废' })).body.error.code).toBe('NOTHING_TO_VOID');
  });
});

describe('结账用券', () => {
  let member: { id: number };
  let cash: CouponRow;
  let visitId: number;
  let checkoutId: number;

  it('结账核对列出会员能用的券与能抵多少；用券后抵扣只分摊到适用的部门，日结单列券抵扣，自检一致', async () => {
    member = await createMember(ctx, '用券会员', '19900008010');
    cash = (await issue(member.id, tpl.cash!.id)).body.coupons[0];
    await issue(member.id, tpl.discount!.id);
    visitId = await enter([{ itemId: item['券搓澡']!, quantity: 1, price: 6800 }], member.id);
    const pre = await preview(visitId);
    const opt = pre.storeCoupons.find((c) => c.code === cash.code)!;
    expect(opt).toMatchObject({ usable: true, amount: 3000 });
    const dis = pre.storeCoupons.find((c) => c.templateName === '八八折（老客）')!;
    expect(dis).toMatchObject({ usable: true, amount: 1000 });
    // 与优惠同用、两张券、金额对不上：拒绝
    const grant = randomUUID();
    expect((await pay(visitId, pre.totalAmount, [{ method: 'store_coupon', code: cash.code, amount: 3000 }, { method: 'discount', amount: 100, grantId: grant }, { method: 'cash', amount: pre.totalAmount - 3100 }])).status).toBe(400);
    expect(
      (await pay(visitId, pre.totalAmount, [{ method: 'store_coupon', code: cash.code, amount: 3000 }, { method: 'store_coupon', code: pre.storeCoupons[1]!.code, amount: 1000 }, { method: 'cash', amount: pre.totalAmount - 4000 }]))
        .status,
    ).toBe(400);
    expect((await pay(visitId, pre.totalAmount, [{ method: 'store_coupon', code: cash.code, amount: 2900 }, { method: 'cash', amount: pre.totalAmount - 2900 }])).body.error.code).toBe(
      'COUPON_AMOUNT_CHANGED',
    );
    const done = await pay(visitId, pre.totalAmount, [{ method: 'store_coupon', code: cash.code, amount: 3000 }, { method: 'cash', amount: pre.totalAmount - 3000 }]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    checkoutId = done.body.id;
    expect(done.body.payments.find((p: { method: string }) => p.method === 'store_coupon')).toMatchObject({ amount: 3000 });
    const items = await ctx.sql<{ category: string; discount: number }[]>`
      SELECT category, discount::int AS discount FROM checkout_items WHERE checkout_id = ${checkoutId} ORDER BY category COLLATE "C"`;
    expect(items).toEqual([
      { category: '券洗浴', discount: 3000 },
      { category: '门票', discount: 0 },
    ]);
    const mine = await couponsOf(member.id);
    expect(mine.coupons.find((c) => c.id === cash.id)).toMatchObject({ state: 'used', checkoutNo: done.body.checkoutNo, usedAmount: 3000 });
    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    expect(st.business.byMethod.find((m: { method: string }) => m.method === 'store_coupon').amount).toBe(3000);
    await checks();
  });

  it('用过的券不能再用、不能作废；部分退款最多退实收（扣掉券抵扣）；反结账退回券，可以再用', async () => {
    const v2 = await enter([{ itemId: item['券搓澡']!, quantity: 1, price: 6800 }]);
    const pre2 = await preview(v2);
    expect((await pay(v2, pre2.totalAmount, [{ method: 'store_coupon', code: cash.code, amount: 3000 }, { method: 'cash', amount: pre2.totalAmount - 3000 }])).body.error.code).toMatch(
      /COUPON_USED|COUPON_NOT_USABLE/,
    );
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/coupons/${cash.id}/void`, { reason: '想作废' })).body.error.code).toBe('COUPON_USED');
    const opts = (await api(ctx.app, duty, 'GET', `/api/frontdesk/checkouts/${checkoutId}/refund-options`)).body;
    expect(opts.items.find((i: { category: string }) => i.category === '券洗浴')).toMatchObject({ discount: 3000, remainingAmount: 3800 });
    expect(opts.nonRefundable).toEqual([{ method: 'store_coupon', amount: 3000 }]);
    const back = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${checkoutId}/void`, { reason: '收错了' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await couponsOf(member.id)).coupons.find((c) => c.id === cash.id)!.state).toBe('available');
    await checks();
    // 别人的券：这位客人不是券的主人
    const pre3 = await preview(v2);
    const r = await pay(v2, pre3.totalAmount, [{ method: 'store_coupon', code: cash.code, amount: 3000 }, { method: 'cash', amount: pre3.totalAmount - 3000 }]);
    expect(r.body.error.code).toBe('COUPON_NOT_USABLE');
    // 重新结账：券又能用
    const pre4 = await preview(visitId);
    const again = await pay(visitId, pre4.totalAmount, [{ method: 'store_coupon', code: cash.code, amount: 3000 }, { method: 'cash', amount: pre4.totalAmount - 3000 }]);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    await checks();
  });

  it('门票兑换券：抵一位客人的门票，不超过「最多抵」；折扣券按适用合计打折、分以下舍去', async () => {
    const m = await createMember(ctx, '兑换会员', '19900008011');
    const t = (await issue(m.id, tpl.ticket!.id)).body.coupons[0] as CouponRow;
    const v = await enter([], m.id);
    const pre = await preview(v);
    expect(pre.storeCoupons.find((c) => c.code === t.code)).toMatchObject({ usable: true, amount: Math.min(39900, pre.totalAmount) });
    const done = await pay(v, pre.totalAmount, [{ method: 'store_coupon', code: t.code, amount: 39900 }, { method: 'cash', amount: pre.totalAmount - 39900 }]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // 折扣：8.8 折、最多减 ¥10 的模板这里用一个不封顶的
    const nine = await template({ name: '九折不封顶', kind: 'discount', ratePercent: 90 });
    const c = (await issue(m.id, nine.id)).body.coupons[0] as CouponRow;
    const v2 = await enter([{ itemId: item['券果盘']!, quantity: 1, price: 3800 }], m.id);
    const pre2 = await preview(v2);
    expect(pre2.storeCoupons.find((x) => x.code === c.code)!.amount).toBe(Math.floor((pre2.totalAmount * 10) / 100));
    await checks();
  });

  it('桌台结账输入无记名券码：核对能抵多少、结账用掉；对账包 10-券.csv 只显示券码后 4 位', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/rules', { enabled: true })).status).toBe(200);
    const st = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/stations', { name: '券热菜' });
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    const stationId = st.body.stations.find((s: { name: string }) => s.name === '券热菜').id;
    const dish = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '券炒饭', category: '券餐饮', price: 2800 });
    const dishId = dish.body.items.find((i: { name: string }) => i.name === '券炒饭').id;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/dining/items', { items: [{ id: dishId, stationId }] })).status).toBe(200);
    const table = await api(ctx.app, ctx.owner, 'POST', '/api/admin/dining/tables', { name: '券1' });
    const tableId = table.body.tables.find((t: { name: string }) => t.name === '券1').id;
    const open = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/open', { clientKey: randomUUID(), tableId, guests: 2 });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const sessionId = open.body.id;
    const order = await api(ctx.app, ctx.clerk, 'POST', `/api/dining/tables/sessions/${sessionId}/orders`, { clientKey: randomUUID(), lines: [{ itemId: dishId, quantity: 2 }], expectedTotal: 5600 });
    expect(order.status, JSON.stringify(order.body)).toBe(200);
    const code = (tpl.anonCodes as unknown as string[])[0]!;
    const check = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkout-coupon', { tableSessionIds: [sessionId], code: code.replace(/(.{4})/g, '$1 ') });
    expect(check.body).toMatchObject({ found: true, option: { usable: true, amount: 2000 } });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkout-coupon', { tableSessionIds: [sessionId], code: '23456789ABCD' })).body).toEqual({ found: false });
    const done = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/checkout', {
      clientKey: randomUUID(),
      sessionIds: [sessionId],
      expectedTotal: 5600,
      payments: [{ method: 'store_coupon', code, amount: 2000 }, { method: 'wechat', amount: 3600 }],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const pack = await buildDailyRecon(ctx.sql, ctx.config, today);
    const file = pack.files.find((f) => f.name === '10-券.csv')!.content;
    expect(file).toContain(`••••-••••-${code.slice(-4)}`);
    expect(file).not.toContain(code);
    expect(file).toContain('无记名券');
    expect(pack.files.find((f) => f.name === '03-部门参考表.csv')!.content).toMatch(/核对,一致/);
    expect(pack.ok).toBe(true);
    await checks();
  });
});

describe('作废与统计', () => {
  it('店主、店总可以作废没用的券；客户经理不能；统计按模板列发券、用券、作废', async () => {
    const m = await createMember(ctx, '作废券', '19900008020');
    const c = (await issue(m.id, tpl.cash!.id)).body.coupons[0] as CouponRow;
    expect((await api(ctx.app, am, 'POST', `/api/coupons/${c.id}/void`, { reason: '发错了' })).status).toBe(403);
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/coupons/${c.id}/void`, { reason: '发错了' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.state).toBe('voided');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/coupons/${c.id}/void`, { reason: '再来' })).body.error.code).toBe('ALREADY_VOIDED');
    const stats = (await api(ctx.app, ctx.owner, 'GET', `/api/coupons/stats?from=${today}&to=${today}`)).body;
    const row = stats.rows.find((r: { templateId: number }) => r.templateId === tpl.cash!.id);
    expect(row.used).toBeGreaterThanOrEqual(1);
    expect(row.usedAmount).toBe(3000 * row.used);
    expect(row.voided).toBe(1);
    expect(stats.totals.issued).toBeGreaterThan(0);
    // 客户经理能看统计（会员总览的权限）
    expect((await api(ctx.app, am, 'GET', `/api/coupons/stats?from=${today}&to=${today}`)).status).toBe(200);
    await checks();
  });
});
