// v0.7.28 ④（docs/SCHEDULE_FINISH.md 第 5 节，N5）：次卡。全部是合成数据。
//   · 卡种：校验、版本号、权限；
//   · 售卡：现金类收款、记到班次（交班应有现金）、刚改过的卡种拒绝、同一编号重提、「确认作废」后原请求不生效；
//   · 结账用次卡：结账核对列出能抵几份；一次一份、单价高的先抵；金额对不上拒绝；不和券、会员折扣、优惠同用；桌台不能用；
//     反结账退回次数；退了卡的不能反结账；
//   · 退卡：只有值班经理以上、按售价折算的上限、退款单号；过期作废；旧次卡期初（有一行不对整批不写）；
//   · 日结、交班、自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutCountCardOption, CountCard, CountCardType } from '../src/shared/count-cards';
import { allocateCountCards } from '../src/shared/count-cards';
import { createStaff } from '../src/server/modules/staff';
import { expireCountCards, importOpeningCountCards } from '../src/server/modules/count-cards';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string;
let today: string;
let tagNo = 0;
const item: Record<string, number> = {};
let foot: CountCardType;

const checks = async () => {
  for (const c of (await api(ctx.app, ctx.owner, 'GET', '/api/frontdesk/checks')).body as { ok: boolean; label: string; detail: string }[]) {
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
  const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
  for (const c of st.checks as { ok: boolean; label: string; detail: string }[]) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  return st;
};
const sell = (memberId: number, t: CountCardType, extra: Record<string, unknown> = {}, cookie = ctx.clerk, clientKey = randomUUID()) =>
  api(ctx.app, cookie, 'POST', '/api/count-cards', { clientKey, memberId, typeId: t.id, expectedVersion: t.version, expectedPrice: t.price, method: 'cash', ...extra });
const cardsOf = async (memberId: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/count-cards`)).body as CountCard[];
const enter = async (lines: { itemId: number; quantity: number; price: number }[], memberId?: number) => {
  tagNo += 1;
  const code = `K${String(tagNo).padStart(3, '0')}`;
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
    countCards: CheckoutCountCardOption[];
    countCardLines: { id: number; itemId: number | null; ticketTypeId: number | null; name: string; unitPrice: number; quantity: number; amount: number }[];
    memberDiscounts: unknown[];
  };
const pay = (visitId: number, total: number, payments: Record<string, unknown>[]) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: total, payments });

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'duty', displayName: '值班经理', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'duty');
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  // 8.0.4 起次卡默认停售（需求表 03，HY05）；这里的用例要售卡，先打开（停售的行为见 tests/membership-v804.test.ts）
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { countCardSales: true })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'K', from: 1, to: 40, width: 3, zone: 'male' })).status).toBe(200);
  for (const [name, category, price] of [
    ['次卡足疗', '次卡足疗', 19800],
    ['次卡果盘', '次卡水吧', 3800],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name, category, price });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    item[name] = r.body.items.find((i: { name: string }) => i.name === name).id;
  }
});
afterAll(async () => ctx?.close());

describe('分配算法', () => {
  it('一次一份、单价高的先抵；几张卡按 id 依次抵，前面抵掉的后面不再抵', () => {
    const lines = [
      { id: 1, itemId: 10, ticketTypeId: null, name: '足疗', unitPrice: 19800, quantity: 2, amount: 39600 },
      { id: 2, itemId: 11, ticketTypeId: null, name: '果盘', unitPrice: 3800, quantity: 1, amount: 3800 },
      { id: -7, itemId: null, ticketTypeId: 3, name: '门票', unitPrice: 9800, quantity: 1, amount: 9800 },
    ];
    const [a, b] = allocateCountCards(
      [
        { cardId: 9, itemIds: [10, 11], ticketTypeIds: [], uses: 5 },
        { cardId: 4, itemIds: [10], ticketTypeIds: [3], uses: 2 },
      ],
      lines,
    );
    // 卡 4 在前：先抵足疗两份（单价高），卡 9 只剩果盘
    expect(a).toMatchObject({ cardId: 4, amount: 39600 });
    expect(b).toMatchObject({ cardId: 9, amount: 3800, units: [{ lineId: 2 }] });
  });
});

describe('卡种', () => {
  it('店主建卡种：要有能抵的项目；店员不能建；改的时候带版本号', async () => {
    const body = { name: '足疗 3 次卡', itemIds: [item['次卡足疗']!], uses: 3, price: 45000, validDays: 365 };
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/admin/count-card-types', body)).status).toBe(403);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/count-card-types', { ...body, itemIds: [] })).status).toBe(400);
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/count-card-types', body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    foot = (r.body as CountCardType[]).find((t) => t.name === '足疗 3 次卡')!;
    expect(foot).toMatchObject({ uses: 3, price: 45000, validDays: 365, targetNames: ['次卡足疗'], version: 1 });
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/count-card-types', body)).body.error.code).toBe('COUNT_CARD_TYPE_NAME_TAKEN');
    const up = await api(ctx.app, ctx.owner, 'PUT', `/api/admin/count-card-types/${foot.id}`, { ...body, note: '常规', expectedVersion: 1 });
    expect(up.status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/count-card-types/${foot.id}`, { ...body, expectedVersion: 1 })).body.error.code).toBe('COUNT_CARD_TYPE_CHANGED');
    foot = (up.body as CountCardType[]).find((t) => t.id === foot.id)!;
    expect(foot.version).toBe(2);
  });
});

describe('售卡与结账', () => {
  let member: number;
  let card: CountCard;

  it('售卡：现金类收款记到班次；卡种刚改过拒绝；同一编号重提返回原来那张、内容不同拒绝；确认作废后原请求不生效', async () => {
    member = (await createMember(ctx, '次卡会员', '13955550001')).id;
    const shift = await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 10000 });
    expect(shift.status, JSON.stringify(shift.body)).toBe(200);
    expect((await sell(member, { ...foot, version: 1 })).body.error.code).toBe('COUNT_CARD_TYPE_CHANGED');
    expect((await sell(member, foot, { method: 'other' })).status).toBe(400);
    const key = randomUUID();
    const r = await sell(member, foot, {}, ctx.clerk, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    card = r.body.card;
    expect(r.body.replayed).toBe(false);
    expect(card).toMatchObject({ memberId: member, name: '足疗 3 次卡', totalUses: 3, remaining: 3, price: 45000, status: 'active', source: 'sale', paymentMethod: 'cash' });
    expect(card.expiresOn).toBeTruthy();
    const again = await sell(member, foot, {}, ctx.clerk, key);
    expect(again.body).toMatchObject({ replayed: true, card: { id: card.id } });
    expect((await sell(member, foot, { method: 'wechat', ref: 'WX1' }, ctx.clerk, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 确认作废：之后原请求晚到也不生效
    const lost = randomUUID();
    const ab = await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'count_card_sale', summary: '售次卡' });
    expect(ab.body).toMatchObject({ found: false, abandoned: true });
    expect((await sell(member, foot, {}, ctx.clerk, lost)).body.error.code).toBe('OP_ABANDONED');
    // 交班：卖卡的现金计入应有现金
    const s = (await api(ctx.app, ctx.clerk, 'GET', `/api/shifts/${shift.body.id}`)).body;
    expect(s.summary.countCards.sales).toMatchObject({ count: 1, total: 45000 });
    expect(s.summary.cash).toMatchObject({ countCard: 45000, expected: 10000 + 45000 });
  });

  it('结账用次卡：核对列出能抵几份；抵两份足疗，其余现金；金额对不上、和券或优惠同用都拒绝；反结账退回', async () => {
    const visit = await enter([{ itemId: item['次卡足疗']!, quantity: 2, price: 19800 }, { itemId: item['次卡果盘']!, quantity: 1, price: 3800 }], member);
    const p = await preview(visit);
    const opt = p.countCards.find((c) => c.cardId === card.id)!;
    expect(opt).toMatchObject({ remaining: 3, coverable: 2, reason: null });
    const [alloc] = allocateCountCards([{ cardId: card.id, itemIds: opt.itemIds, ticketTypeIds: opt.ticketTypeIds, uses: 2 }], p.countCardLines);
    expect(alloc!.amount).toBe(39600);
    const rest = p.totalAmount - 39600;
    // 金额对不上（页面算错）
    expect((await pay(visit, p.totalAmount, [{ method: 'count_card', cardId: card.id, uses: 2, amount: 30000 }, { method: 'cash', amount: p.totalAmount - 30000 }])).body.error.code).toBe(
      'COUNT_CARD_CHANGED',
    );
    // 抵 3 次：能抵的只有 2 份
    expect((await pay(visit, p.totalAmount, [{ method: 'count_card', cardId: card.id, uses: 3, amount: 39600 }, { method: 'cash', amount: rest }])).body.error.code).toBe('COUNT_CARD_CHANGED');
    // 不和优惠 / 免单同用
    expect(
      (await pay(visit, p.totalAmount, [{ method: 'count_card', cardId: card.id, uses: 2, amount: 39600 }, { method: 'discount', amount: rest, grantId: randomUUID() }])).status,
    ).toBe(400);
    const ok = await pay(visit, p.totalAmount, [{ method: 'count_card', cardId: card.id, uses: 2, amount: 39600 }, { method: 'cash', amount: rest }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.payments.find((x: { method: string }) => x.method === 'count_card')).toMatchObject({ amount: 39600 });
    expect((await cardsOf(member)).find((c) => c.id === card.id)).toMatchObject({ remaining: 1, status: 'active' });
    await checks();
    // 日结：营业口径里的「次卡」、次卡一节
    const st = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    expect(st.business.byMethod.find((m: { method: string }) => m.method === 'count_card')).toMatchObject({ amount: 39600 });
    expect(st.countCards).toMatchObject({ sales: { count: 1, amount: 45000 }, uses: { count: 2, amount: 39600 }, outstanding: { cards: 1, uses: 1 } });
    // 反结账：次数退回
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${ok.body.id}/void`, { reason: '收错了' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect((await cardsOf(member)).find((c) => c.id === card.id)).toMatchObject({ remaining: 3, status: 'active' });
    // 重新结：这次全部用现金
    const p2 = await preview(visit);
    expect((await pay(visit, p2.totalAmount, [{ method: 'cash', amount: p2.totalAmount }])).status).toBe(200);
    await checks();
  });

  it('不是这位会员结账时不能用别人的卡；桌台结账不能用次卡', async () => {
    const visit = await enter([{ itemId: item['次卡足疗']!, quantity: 1, price: 19800 }]);
    const p = await preview(visit);
    expect(p.countCards).toEqual([]);
    const r = await pay(visit, p.totalAmount, [{ method: 'count_card', cardId: card.id, uses: 1, amount: 19800 }, { method: 'cash', amount: p.totalAmount - 19800 }]);
    expect(r.body.error.code).toBe('COUNT_CARD_NOT_IN_CHECKOUT');
    expect((await pay(visit, p.totalAmount, [{ method: 'cash', amount: p.totalAmount }])).status).toBe(200);
    const t = await api(ctx.app, ctx.clerk, 'POST', '/api/dining/tables/checkout', {
      clientKey: randomUUID(),
      sessionIds: [1],
      expectedTotal: 19800,
      payments: [{ method: 'count_card', cardId: card.id, uses: 1, amount: 19800 }],
    });
    expect(t.status).toBe(400);
    expect(t.body.error.message).toContain('桌台结账不能用次卡');
  });

  it('退卡：店员不能退；按售价折算的上限；扫码退要退款单号；退了卡的结账单不能反结账', async () => {
    // 先用掉一次，再退卡
    const visit = await enter([{ itemId: item['次卡足疗']!, quantity: 1, price: 19800 }], member);
    const p = await preview(visit);
    const used = await pay(visit, p.totalAmount, [{ method: 'count_card', cardId: card.id, uses: 1, amount: 19800 }, { method: 'cash', amount: p.totalAmount - 19800 }]);
    expect(used.status, JSON.stringify(used.body)).toBe(200);
    const now = (await cardsOf(member)).find((c) => c.id === card.id)!;
    expect(now.remaining).toBe(2);
    const body = { expectedVersion: now.version, amount: 30000, method: 'cash', reason: '客人搬家' };
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/count-cards/${card.id}/refund`, { clientKey: randomUUID(), ...body })).status).toBe(403);
    // 45000 × 2 ÷ 3 = 30000 是上限
    expect((await api(ctx.app, duty, 'POST', `/api/count-cards/${card.id}/refund`, { clientKey: randomUUID(), ...body, amount: 30001 })).body.error.code).toBe('COUNT_CARD_REFUND_EXCEEDS');
    expect((await api(ctx.app, duty, 'POST', `/api/count-cards/${card.id}/refund`, { clientKey: randomUUID(), ...body, method: 'wechat' })).status).toBe(400);
    const r = await api(ctx.app, duty, 'POST', `/api/count-cards/${card.id}/refund`, { clientKey: randomUUID(), ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.card).toMatchObject({ remaining: 0, status: 'refunded', refund: { amount: 30000, uses: 2, method: 'cash' } });
    const v = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${used.body.id}/void`, { reason: '想退回次数' });
    expect(v.body.error.code).toBe('COUNT_CARD_REFUNDED');
    const st = await checks();
    expect(st.countCards.refunds).toMatchObject({ count: 1, amount: 30000 });
  });
});

describe('过期与旧次卡期初', () => {
  it('过了有效期没用完的次数作废；期初有一行不对整批不写，都对才写', async () => {
    const m = (await createMember(ctx, '过期会员', '13955550002')).id;
    const sold = await sell(m, foot);
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    await ctx.sql`UPDATE count_cards SET expires_on = ${today}::date - 1 WHERE id = ${sold.body.card.id}`;
    expect(await expireCountCards(ctx.sql, { config: ctx.config })).toBe(1);
    expect((await cardsOf(m))[0]).toMatchObject({ status: 'expired', remaining: 0 });
    expect(await expireCountCards(ctx.sql, { config: ctx.config })).toBe(0);

    const rows = [
      { line: 2, phone: '13955550002', memberNo: '', name: '旧足疗卡', items: '次卡足疗', tickets: '', totalUses: 10, remaining: 4, price: 150000, expiresOn: null },
      { line: 3, phone: '13900009999', memberNo: '', name: '旧卡', items: '不存在的项目', tickets: '', totalUses: 5, remaining: 6, price: 0, expiresOn: null },
    ];
    const bad = await importOpeningCountCards({ sql: ctx.sql, config: ctx.config }, rows, { operatorId: ctx.ownerId, apply: true, batch: 'T1' });
    expect(bad).toMatchObject({ ok: 1, bad: 1 });
    expect(bad.rows[1]!.problem).toContain('找不到会员');
    expect((await cardsOf(m)).length).toBe(1);
    const good = await importOpeningCountCards({ sql: ctx.sql, config: ctx.config }, [rows[0]!], { operatorId: ctx.ownerId, apply: true, batch: 'T1' });
    expect(good).toMatchObject({ ok: 1, bad: 0 });
    expect((await cardsOf(m)).find((c) => c.source === 'opening')).toMatchObject({ name: '旧足疗卡', totalUses: 10, remaining: 4, price: 150000 });
    const st = await checks();
    expect(st.countCards.expired).toMatchObject({ cards: 1, uses: 3 });
    expect(st.countCards.opening).toMatchObject({ cards: 1, uses: 4 });
  });
});
