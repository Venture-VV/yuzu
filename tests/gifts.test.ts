// 8.1.9 全局签赠（docs/GIFTS_V819.md，PENDING_DECISIONS「8.1.9 签赠」SZ1–SZ8）：
//   · 知识库：签赠券类型只能是兑换券或代金券、板块从配置里选；普通券的接口看不到、改不了它；发过以后送什么不能改，说明随时能改；
//   · 发放：必选授权人（要有「签赠授权」）、渠道（配置里的）、事由；操作编号原样重提返回原记录；开关关了不能发；
//   · 普通发券、发券规则、无记名、批量发券、会员权益都不能用签赠类型，数据库触发器兜底；
//   · 前台结账：券列表上写券种、授权人、渠道；用掉、反结账退回；作废；
//   · 台账：明细（核销记录）、按授权人、按个人、占比；手机号按会员查看权限打码；
//   · 结果待确认：查回、确认作废；权限。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutCouponOption, CouponTemplate } from '../src/shared/coupons';
import type { GiftAuthorizer, GiftIssueResult, GiftLedger, GiftRules, GiftType } from '../src/shared/gifts';
import { shiftDate } from '../src/shared/labels';
import type { Actor, Deps } from '../src/server/lib/context';
import { issueGift } from '../src/server/modules/gifts';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let am: string; // 客户经理：发放、看台账；不能做授权人
let duty: string; // 值班经理：能做授权人
let butler: string; // 管家（职责）：发放、看台账；没有查看会员的权限，手机号打码
let dutyId = 0;
let amId = 0;
let today = '';
let tagNo = 0;
let rubId = 0; // 价目：签赠搓澡
const types: Record<string, GiftType> = {};

const giftType = async (body: Record<string, unknown>, cookie = ctx.owner) =>
  api(ctx.app, cookie, 'POST', '/api/gifts/types', { clientKey: randomUUID(), validity: 'days', validDays: 30, segment: '浴区', content: '', rules: '', ...body });
const issue = (body: Record<string, unknown>, cookie = butler) =>
  api(ctx.app, cookie, 'POST', '/api/gifts/issues', { clientKey: randomUUID(), quantity: 1, channel: '管家部', reason: '老客户生日', authorizedBy: dutyId, ...body });
const ledger = async (query = '', cookie = ctx.owner) => {
  const r = await api(ctx.app, cookie, 'GET', `/api/gifts/ledger?from=${shiftDate(today, -30)}&to=${today}${query}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as GiftLedger;
};
/** 接待一位会员客人、挂一个项目，返回来访 id */
const enter = async (memberId: number, itemId: number, price: number) => {
  tagNo += 1;
  const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: `S${String(tagNo).padStart(3, '0')}`, zone: 'male', memberId }] });
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const id = v.body.visits[0].id as number;
  const p = await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${id}/charges`, { clientKey: randomUUID(), lines: [{ itemId, quantity: 1 }], expectedTotal: price });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return id;
};
const preview = async (visitId: number) =>
  (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body as { totalAmount: number; storeCoupons: CheckoutCouponOption[] };
const pay = (visitId: number, total: number, payments: Record<string, unknown>[]) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: total, payments });
const checks = async () => {
  for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
};

beforeAll(async () => {
  ctx = await setup();
  dutyId = await createStaff(ctx.sql, { username: 'gduty', displayName: '值班甲', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  amId = await createStaff(ctx.sql, { username: 'gam', displayName: '客户经理乙', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'gbutler', displayName: '管家丙', role: 'backoffice', duties: ['concierge'], password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'gduty');
  am = await login(ctx.app, 'gam');
  butler = await login(ctx.app, 'gbutler');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'S', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '签赠搓澡', category: '签赠洗浴', price: 6800 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  rubId = r.body.items.find((i: { name: string }) => i.name === '签赠搓澡').id;
});
afterAll(async () => {
  await ctx?.close();
});

describe('签赠知识库与配置', () => {
  it('默认配置：开着，板块、渠道有默认选项；店主改总则；没有维护权限的改不了', async () => {
    const rules = (await api(ctx.app, butler, 'GET', '/api/gifts/rules')).body as GiftRules;
    expect(rules).toMatchObject({ enabled: true, segments: ['浴区', '技师', '餐饮', '客房', '其他'], channels: ['管家部', '客户部', '前台', '其他'] });
    expect((await api(ctx.app, butler, 'PUT', '/api/gifts/rules', { ...rules, generalRules: '管家改' })).status).toBe(403);
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/gifts/rules', { ...rules, generalRules: '签赠只送会员；同一位会员一个月最多两次', segments: [...rules.segments, '浴区'] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // 重复的选项去掉
    expect(saved.body).toMatchObject({ generalRules: '签赠只送会员；同一位会员一个月最多两次', segments: ['浴区', '技师', '餐饮', '客房', '其他'] });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/gifts/rules', { ...rules, channels: [] })).status).toBe(400);
  });

  it('建签赠券类型：兑换券、代金券；折扣券不行；板块要从配置里选；普通券的接口看不到也改不了', async () => {
    const rub = await giftType({ name: '签赠搓澡券', kind: 'exchange', exchangeItemId: rubId, segment: '浴区', content: '送搓澡一次（含拖鞋）', rules: '店总以上授权' });
    expect(rub.status, JSON.stringify(rub.body)).toBe(201);
    types.rub = rub.body as GiftType;
    expect(types.rub).toMatchObject({ gift: true, kind: 'exchange', giftSegment: '浴区', giftContent: '送搓澡一次（含拖鞋）', giftRules: '店总以上授权', issued: 0, validityText: '发放当天起 30 天' });
    const cash = await giftType({ name: '签赠餐饮券', kind: 'cash', faceValue: 8800, segment: '餐饮', validity: 'fixed', validFrom: today, validTo: shiftDate(today, 60) });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    types.cash = cash.body as GiftType;
    expect((await giftType({ name: '签赠九折', kind: 'discount', ratePercent: 90 })).body.error.details?.field).toBe('kind');
    expect((await giftType({ name: '签赠搓澡二', kind: 'exchange', exchangeItemId: rubId, segment: '不存在的板块' })).body.error.details?.field).toBe('segment');
    expect((await giftType({ name: '没权限', kind: 'exchange', exchangeItemId: rubId }, am)).status).toBe(403);

    // 知识库里有，普通券的模板列表里没有
    const list = (await api(ctx.app, am, 'GET', '/api/gifts/types')).body as GiftType[];
    expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(['签赠搓澡券', '签赠餐饮券']));
    const plain = (await api(ctx.app, ctx.owner, 'GET', '/api/coupons/templates')).body as CouponTemplate[];
    expect(plain.some((t) => t.gift)).toBe(false);
    const viaCoupons = await api(ctx.app, ctx.owner, 'PUT', `/api/coupons/templates/${types.rub.id}`, { ...types.rub, name: '改名', expectedVersion: types.rub.version });
    expect(viaCoupons.body.error.code).toBe('GIFT_TEMPLATE');
  });

  it('改签赠券类型：名称、板块、内容随时能改（带版本号）；发过以后送什么不能改', async () => {
    const t = types.rub!;
    const ok = await api(ctx.app, ctx.owner, 'PUT', `/api/gifts/types/${t.id}`, { ...t, segment: t.giftSegment, content: '送搓澡一次', rules: t.giftRules, expectedVersion: t.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ giftContent: '送搓澡一次', version: t.version + 1 });
    const stale = await api(ctx.app, ctx.owner, 'PUT', `/api/gifts/types/${t.id}`, { ...t, segment: t.giftSegment, content: '旧版本', rules: '', expectedVersion: t.version });
    expect(stale.body.error.code).toBe('TEMPLATE_STALE');
    types.rub = ok.body as GiftType;
  });
});

describe('签赠发放', () => {
  let memberId = 0;
  let issued: GiftIssueResult;

  it('授权人：店主、值班经理能选；客户经理不能；收银员看不到这个列表', async () => {
    const list = (await api(ctx.app, butler, 'GET', '/api/gifts/authorizers')).body as GiftAuthorizer[];
    expect(list.map((a) => a.id)).toEqual(expect.arrayContaining([ctx.ownerId, dutyId]));
    expect(list.some((a) => a.id === amId)).toBe(false);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/gifts/authorizers')).status).toBe(403);
  });

  it('发放：授权人、渠道、事由都要；授权人要有「签赠授权」；成功后原样重提返回原记录', async () => {
    const m = await createMember(ctx, '签赠会员甲');
    memberId = m.id;
    // 找会员：管家没有查看会员的权限，手机号打码
    const found = await api(ctx.app, butler, 'GET', `/api/gifts/members?q=${encodeURIComponent('签赠会员甲')}`);
    expect(found.status).toBe(200);
    expect(found.body[0]).toMatchObject({ id: memberId, usable: true });
    expect(found.body[0].phone).toMatch(/\*/);
    expect((await api(ctx.app, am, 'GET', `/api/gifts/members?q=${encodeURIComponent('签赠会员甲')}`)).body[0].phone).not.toMatch(/\*/);

    expect((await issue({ memberId, templateId: types.rub!.id, authorizedBy: undefined })).status).toBe(400);
    expect((await issue({ memberId, templateId: types.rub!.id, authorizedBy: amId })).body.error.code).toBe('AUTHORIZER_INVALID');
    const badChannel = await issue({ memberId, templateId: types.rub!.id, channel: '路边' });
    expect(badChannel.body.error?.details?.field, JSON.stringify(badChannel.body)).toBe('channel');
    expect((await issue({ memberId, templateId: types.rub!.id, reason: '送' })).status).toBe(400);
    expect((await issue({ memberId, templateId: types.rub!.id }, ctx.clerk)).status).toBe(403);

    const key = randomUUID();
    const r = await issue({ clientKey: key, memberId, templateId: types.rub!.id, quantity: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    issued = r.body as GiftIssueResult;
    expect(issued.coupons).toHaveLength(2);
    const again = await issue({ clientKey: key, memberId, templateId: types.rub!.id, quantity: 2 });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ issueId: issued.issueId, replayed: true });
    expect((await issue({ clientKey: key, memberId, templateId: types.rub!.id, quantity: 1 })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 结果待确认时查回
    const byKey = await api(ctx.app, butler, 'GET', `/api/gifts/issues/by-key/${key}`);
    expect(byKey.body).toMatchObject({ issueId: issued.issueId });
    const lookup = await api(ctx.app, butler, 'GET', `/api/erp/ops/${key}?type=gift_issue`);
    expect(lookup.body).toEqual({ found: true, abandoned: false, refId: issued.issueId });
    // 发出去的券在发券记录上记着授权人、渠道
    const [row] = await ctx.sql<{ kind: string; authorizedBy: number; giftChannel: string }[]>`SELECT kind, authorized_by, gift_channel FROM coupon_issues WHERE id = ${issued.issueId}`;
    expect(row).toEqual({ kind: 'manual', authorizedBy: dutyId, giftChannel: '管家部' });
  });

  it('确认作废的编号不会再发；开关关了不能发，已发的照常能用', async () => {
    const key = randomUUID();
    const ab = await api(ctx.app, butler, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'gift_issue', summary: '测试' });
    expect(ab.body).toEqual({ found: false, abandoned: true });
    expect((await issue({ clientKey: key, memberId, templateId: types.rub!.id })).body.error.code).toBe('OP_ABANDONED');

    const rules = (await api(ctx.app, ctx.owner, 'GET', '/api/gifts/rules')).body as GiftRules;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/gifts/rules', { ...rules, enabled: false })).status).toBe(200);
    expect((await issue({ memberId, templateId: types.rub!.id })).body.error.code).toBe('GIFT_OFF');
    expect((await ledger()).totals.issued).toBeGreaterThan(0);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/gifts/rules', { ...rules, enabled: true })).status).toBe(200);
  });

  it('普通发券、无记名、发券规则、批量发券都不能用签赠类型；数据库触发器兜底', async () => {
    const t = types.rub!.id;
    expect((await api(ctx.app, am, 'POST', `/api/members/${memberId}/coupons`, { clientKey: randomUUID(), templateId: t, quantity: 1, reason: '普通发' })).body.error.code).toBe('GIFT_TEMPLATE');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/coupons/batches', { clientKey: randomUUID(), templateId: t, quantity: 5 })).body.error.code).toBe('GIFT_TEMPLATE');
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/coupons/rules', { clientKey: randomUUID(), kind: 'open_card', templateId: t, quantity: 1 })).body.error.code).toBe('GIFT_TEMPLATE');
    const camp = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/campaigns/preview', { templateId: t, audience: {} });
    expect(camp.body.error?.code).toBe('GIFT_TEMPLATE');
    // 直接写库：签赠类型不带授权人、普通券带授权人，都被触发器拒绝
    const plain = (await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '普通代金', kind: 'cash', faceValue: 1000, validity: 'days', validDays: 10 }))
      .body as CouponTemplate;
    await expect(
      ctx.sql`INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, reason, issued_by, issued_at, business_date)
              VALUES ('FQ-T1', 'manual', ${t}, ${memberId}, 1, '绕过', ${ctx.ownerId}, now(), ${today})`,
    ).rejects.toThrow(/签赠券只能经「签赠发放」发/);
    await expect(
      ctx.sql`INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, reason, issued_by, issued_at, business_date, authorized_by, gift_channel)
              VALUES ('FQ-T2', 'manual', ${plain.id}, ${memberId}, 1, '绕过', ${ctx.ownerId}, now(), ${today}, ${dutyId}, '前台')`,
    ).rejects.toThrow(/只有签赠券类型的发券记录才有授权人/);
    // 发过券以后不能改送什么，也不能改成普通券
    const cur = (await api(ctx.app, ctx.owner, 'GET', '/api/gifts/types')).body.find((x: GiftType) => x.id === t) as GiftType;
    const locked = await api(ctx.app, ctx.owner, 'PUT', `/api/gifts/types/${t}`, {
      ...cur,
      validDays: 60,
      segment: cur.giftSegment,
      content: cur.giftContent,
      rules: cur.giftRules,
      expectedVersion: cur.version,
    });
    expect(locked.body.error.code).toBe('TEMPLATE_LOCKED');
    await expect(ctx.sql`UPDATE coupon_templates SET gift = false WHERE id = ${t}`).rejects.toThrow(/已经发过券/);
  });

  it('前台结账：券列表上写券种、授权人、渠道；用掉后台账是已使用、记着结账单；反结账退回', async () => {
    const visit = await enter(memberId, rubId, 6800);
    const pre = await preview(visit);
    const opt = pre.storeCoupons.find((c) => c.code === issued.coupons[0]!.code)!;
    expect(opt).toMatchObject({ usable: true, amount: 6800, gift: { segment: '浴区', authorizerName: '值班甲', channel: '管家部', reason: '老客户生日' } });
    const done = await pay(visit, pre.totalAmount, [{ method: 'store_coupon', code: opt.code, amount: 6800 }, ...(pre.totalAmount > 6800 ? [{ method: 'cash', amount: pre.totalAmount - 6800 }] : [])]);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const pmt = done.body.payments.find((p: { method: string }) => p.method === 'store_coupon');
    expect(pmt.ref).toMatch(/^签赠·签赠搓澡券/);
    expect(pmt.ref).toContain('授权 值班甲');
    let l = await ledger();
    let row = l.rows.find((r) => r.couponId === opt.couponId)!;
    expect(row).toMatchObject({ status: 'used', checkoutNo: done.body.checkoutNo, usedCents: 6800, authorizer: { id: dutyId, name: '值班甲' }, channel: '管家部', segment: '浴区' });
    await checks();

    const back = await api(ctx.app, duty, 'POST', `/api/frontdesk/checkouts/${done.body.id}/void`, { reason: '收错了' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    l = await ledger();
    row = l.rows.find((r) => r.couponId === opt.couponId)!;
    expect(row).toMatchObject({ status: 'available', checkoutNo: null, usedCents: null });
    // 再结一次：用掉
    const pre2 = await preview(visit);
    const again = await pay(visit, pre2.totalAmount, [
      { method: 'store_coupon', code: opt.code, amount: 6800 },
      ...(pre2.totalAmount > 6800 ? [{ method: 'cash', amount: pre2.totalAmount - 6800 }] : []),
    ]);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    await checks();
  });

  it('作废：维护签赠的人能作废签赠券（不能作废普通券）；用过的不能作废', async () => {
    const second = issued.coupons[1]!;
    expect((await api(ctx.app, butler, 'POST', `/api/gifts/coupons/${second.id}/void`, { reason: '客人不要了' })).status).toBe(403);
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/gifts/coupons/${second.id}/void`, { reason: '客人不要了' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/gifts/coupons/${issued.coupons[0]!.id}/void`, { reason: '想作废' })).body.error.code).toBe('COUPON_USED');
    const plainMember = await createMember(ctx, '普通券会员');
    const plainTpl = (
      await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '普通兑换', kind: 'exchange', exchangeItemId: rubId, validity: 'days', validDays: 10 })
    ).body as CouponTemplate;
    const plainIssue = await api(ctx.app, am, 'POST', `/api/members/${plainMember.id}/coupons`, { clientKey: randomUUID(), templateId: plainTpl.id, quantity: 1, reason: '普通发' });
    expect(plainIssue.status, JSON.stringify(plainIssue.body)).toBe(201);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/gifts/coupons/${plainIssue.body.coupons[0].id}/void`, { reason: '经签赠作废' })).status).toBe(404);
    const row = (await ledger()).rows.find((r) => r.couponId === second.id)!;
    expect(row).toMatchObject({ status: 'voided', voidReason: '客人不要了', voidedByName: expect.any(String) });
  });
});

describe('签赠台账', () => {
  it('按授权人、按个人、占比；过期的单独数；筛选；打码；权限', async () => {
    // 再发几张：客户部发给另一位会员（店主授权，代金券），以及一张已经过期的（30 天前发的、有效 1 天）
    const m2 = await createMember(ctx, '签赠会员乙');
    const r2 = await issue({ memberId: m2.id, templateId: types.cash!.id, authorizedBy: ctx.ownerId, channel: '客户部', reason: '大客户维护', quantity: 1 }, am);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    const short = await giftType({ name: '签赠一日券', kind: 'exchange', exchangeItemId: rubId, segment: '技师', validDays: 1 });
    expect(short.status, JSON.stringify(short.body)).toBe(201);
    const deps = { sql: ctx.sql, config: ctx.config } as unknown as Deps;
    const past = new Date(Date.now() - 20 * 86400_000);
    await issueGift(
      deps,
      { clientKey: randomUUID(), memberId: m2.id, templateId: short.body.id, quantity: 1, authorizedBy: ctx.ownerId, channel: '前台', reason: '补录旧的' },
      { actor: { id: ctx.ownerId } as Actor, ip: '127.0.0.1', at: past },
    );

    const l = await ledger();
    // 甲：搓澡 2 张（1 用、1 作废）；乙：代金 1 张没用、一日券 1 张过期
    expect(l.totals).toMatchObject({ issued: 4, used: 1, voided: 1, available: 1, expired: 1, usedCents: 6800 });
    const byDuty = l.byAuthorizer.find((a) => a.authorizer.id === dutyId)!;
    expect(byDuty).toMatchObject({ issued: 2, used: 1, voided: 1, available: 0, expired: 0 });
    const byOwner = l.byAuthorizer.find((a) => a.authorizer.id === ctx.ownerId)!;
    expect(byOwner).toMatchObject({ issued: 2, used: 0, available: 1, expired: 1 });
    expect(l.byPerson[0]).toMatchObject({ member: { name: '签赠会员甲' }, issued: 2, used: 1, usedCents: 6800 });
    expect(l.byPerson.find((p) => p.member.id === m2.id)).toMatchObject({ issued: 2, used: 0 });
    expect(l.shares.authorizer).toEqual([{ label: '值班甲', count: 1, pct: 100 }]);
    expect(l.shares.segment).toEqual([{ label: '浴区', count: 1, pct: 100 }]);
    expect(l.shares.type).toEqual([{ label: '签赠搓澡券', count: 1, pct: 100 }]);
    expect(l.shares.channel.map((s) => s.label).sort()).toEqual(['前台', '客户部', '管家部'].sort());
    expect(l.shares.channel.find((s) => s.label === '管家部')).toMatchObject({ count: 2, pct: 50 });
    expect(l.truncated).toBe(false);

    // 筛选
    expect((await ledger(`&authorizerId=${dutyId}`)).totals.issued).toBe(2);
    expect((await ledger('&channel=' + encodeURIComponent('客户部'))).rows.map((r) => r.channel)).toEqual(['客户部']);
    expect((await ledger('&status=expired')).rows).toHaveLength(1);
    expect((await ledger(`&templateId=${types.cash!.id}`)).rows[0]).toMatchObject({ type: { name: '签赠餐饮券' }, status: 'available' });

    // 手机号：店主看全的，管家看打码的；收银员看不到台账
    expect(l.rows.find((r) => r.member?.id === m2.id)!.member!.phone).not.toMatch(/\*/);
    const masked = await ledger('', butler);
    expect(masked.rows.every((r) => !r.member || r.member.phone.includes('*'))).toBe(true);
    expect(masked.byPerson.every((p) => p.member.phone.includes('*'))).toBe(true);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/gifts/ledger?from=${today}&to=${today}`)).status).toBe(403);

    // 导出：店主能导，管家（只看台账）不能
    const csv = await api(ctx.app, ctx.owner, 'GET', `/api/gifts/ledger/export?from=${shiftDate(today, -30)}&to=${today}`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('签赠搓澡券');
    expect((await api(ctx.app, butler, 'GET', `/api/gifts/ledger/export?from=${today}&to=${today}`)).status).toBe(403);
  });

  it('新建类型的结果待确认：查回、确认作废后不会再建', async () => {
    const key = randomUUID();
    const r = await giftType({ clientKey: key, name: '签赠果盘', kind: 'cash', faceValue: 3800, segment: '餐饮' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await api(ctx.app, ctx.owner, 'GET', `/api/erp/ops/${key}?type=gift_type`)).body).toEqual({ found: true, abandoned: false, refId: r.body.id });
    // 原样重提：返回原来那个
    const again = await giftType({ clientKey: key, name: '签赠果盘', kind: 'cash', faceValue: 3800, segment: '餐饮' });
    expect(again.body.id).toBe(r.body.id);
    const late = randomUUID();
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/erp/ops/${late}/abandon`, { type: 'gift_type', summary: '测试' })).body).toEqual({ found: false, abandoned: true });
    expect((await giftType({ clientKey: late, name: '签赠作废了', kind: 'cash', faceValue: 100 })).body.error.code).toBe('OP_ABANDONED');
  });
});
