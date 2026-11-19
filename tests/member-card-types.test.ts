// 8.1.15 会员中心（docs/MEMBERS_V8115.md）：建档先选卡类型、表单字段补全、实体卡押金。全部是合成数据。
//   · 三种卡的校验：电子卡要手机号、不发卡；实体卡要手机号、卡号、操作编号；匿名卡手机号可以不留、要操作编号；
//   · 手机号：留了的全公司不重复（三种卡都是）；没留手机号的匿名卡可以有很多位，查找时不会排到前面；
//   · 实体卡建档：同一事务里发卡、收押金——押金金额对不上、卡号被占、手机号重复时什么都没建；
//   · 押金是负债：记到经办人的班次、现金进应有现金，日结单列；不进会员储值、不算营业额；
//   · 发卡（已有会员）按规则收押金；挂失不退、补卡沿用；退卡全额退；确认作废后原请求晚到整笔拒绝；
//   · 手动指定等级要权限，走手动调整那条路；推荐人、偏好项目；后台设的字段显隐、必填服务端核对，按门店各一份；
//   · 匿名卡补登手机号算改号（要原因、要权限或授权），可以转成实名；还押着押金的会员不能合并。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ShiftRecord } from '../src/shared/checkout';
import type { MemberCard } from '../src/shared/member-cards';
import { DEFAULT_MEMBER_FORM_RULES, type MemberCardDeposits, type MemberFormRules } from '../src/shared/member-form';
import type { MemberDetail, MemberSummary, SettlementSummary } from '../src/shared/types';
import { cardDepositChecks } from '../src/server/modules/member-card-deposits';
import { consistencyChecks } from '../src/server/ops/consistency';
import { buildDailyRecon } from '../src/server/ops/recon';
import { api, createMember, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
const DEPOSIT = 2000;

/** 自动取的手机号：155 号段，不与别处写死的号相撞 */
let phoneSeq = 0;
const nextPhone = () => `1550${String(2_000_000 + phoneSeq++)}`;
let cardSeq = 0;
const nextCard = () => `KT${String(100_000 + cardSeq++)}`;

const create = (body: Record<string, unknown>, cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', '/api/members', body);
const detail = async (id: number) => (await api(ctx.app, ctx.owner, 'GET', `/api/members/${id}`)).body as MemberDetail;
const cardsOf = async (id: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${id}/cards`)).body as MemberCard[];
const depositsOf = async (id: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${id}/card-deposits`)).body as MemberCardDeposits;
const search = async (q: string) => (await api(ctx.app, ctx.clerk, 'GET', `/api/members?q=${encodeURIComponent(q)}`)).body as MemberSummary[];
const issue = (memberId: number, body: Record<string, unknown>, cookie = ctx.clerk) => api(ctx.app, cookie, 'POST', `/api/members/${memberId}/cards`, { clientKey: randomUUID(), ...body });
const giveBack = (memberId: number, body: Record<string, unknown>, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', `/api/members/${memberId}/cards/return`, { clientKey: randomUUID(), reason: '客人不再用卡了', ...body });
const cash = { amount: DEPOSIT, method: 'cash', ref: '' };
const physical = (extra: Record<string, unknown> = {}) => ({
  clientKey: randomUUID(),
  cardType: 'physical',
  name: '实体卡会员',
  phone: nextPhone(),
  card: { cardNo: nextCard(), deposit: cash },
  ...extra,
});
const currentShift = async (cookie = ctx.clerk) => (await api(ctx.app, cookie, 'GET', '/api/shifts/current')).body.shift as ShiftRecord;
const settlement = async () => {
  const today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today as string;
  return (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body as SettlementSummary;
};
const setForm = async (rules: MemberFormRules, cookie = ctx.owner) => api(ctx.app, cookie, 'PUT', '/api/settings', { memberForm: rules });
const countMembers = async (phone: string) => (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM members WHERE phone = ${phone}`)[0]!.n;

beforeAll(async () => {
  ctx = await setup();
  // 用例基线里押金是 0（之前的用例发卡不收押金）；这里按默认的 20 元
  await ctx.sql`UPDATE settings SET value = ${ctx.sql.json(DEFAULT_MEMBER_FORM_RULES as never)} WHERE key = 'member_form_rules'`;
  // 店员开班：押金记到这个班次
  expect((await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 10000 })).status).toBe(200);
});
afterAll(async () => ctx?.close());

describe('三种卡的校验与手机号', () => {
  it('原来只带姓名、手机号的建档照旧是电子卡；电子卡要手机号、不发卡', async () => {
    const phone = nextPhone();
    const r = await create({ name: '电子卡甲', phone });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ cardType: 'ecard', phone, referrerMemberId: null, preferredItems: [] });
    const noPhone = await create({ name: '电子卡乙', cardType: 'ecard' });
    expect(noPhone.status).toBe(400);
    expect(noPhone.body.error).toMatchObject({ message: '请输入 11 位手机号', details: { field: 'phone' } });
    expect((await create({ name: '电子卡乙', phone: '12345' })).body.error.message).toBe('请输入 11 位手机号');
    const withCard = await create({ clientKey: randomUUID(), name: '电子卡丙', phone: nextPhone(), cardType: 'ecard', card: { cardNo: nextCard(), deposit: cash } });
    expect(withCard.status).toBe(400);
    expect(withCard.body.error.details).toEqual({ field: 'cardType' });
    expect((await create({ name: '没选对', phone: nextPhone(), cardType: 'gold' })).body.error.message).toBe('请选择卡类型');
  });

  it('匿名卡：手机号可以不留、要操作编号；没留手机号的可以有很多位；同一编号重提返回原来那位', async () => {
    expect((await create({ name: '匿名会员', cardType: 'anonymous' })).body.error.details).toEqual({ field: 'clientKey' });
    const key = randomUUID();
    const a = await create({ clientKey: key, name: '匿名会员', cardType: 'anonymous' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ cardType: 'anonymous', phone: null });
    // 原样重提：200、同一位，不多建
    const again = await create({ clientKey: key, name: '匿名会员', cardType: 'anonymous' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(a.body.id);
    // 同一编号换了内容：拒绝
    expect((await create({ clientKey: key, name: '匿名会员二', cardType: 'anonymous' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 第二位没留手机号的匿名卡：不撞唯一约束
    const b = await create({ clientKey: randomUUID(), name: '匿名会员', cardType: 'anonymous', phone: '' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
    // 查回：编号记在会员上
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${key}?type=member_create`)).body).toEqual({ found: true, abandoned: false, refId: a.body.id });
    // 会员详情：没留手机号；钱包、充值照常能用
    expect(await detail(a.body.id)).toMatchObject({ phone: null, cardType: 'anonymous', cardDepositHeld: 0, referrer: null });
    const rc = await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(a.body.id, 30000));
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    expect((await detail(a.body.id)).principalBalance).toBe(30000);
  });

  it('留了手机号的全公司不重复：电子卡、匿名卡、实体卡都是；实体卡手机号重复时卡与押金都没建', async () => {
    const phone = nextPhone();
    const first = await create({ name: '先登记的', phone });
    expect(first.status).toBe(201);
    const dupE = await create({ name: '后来的', phone });
    expect(dupE.status).toBe(409);
    expect(dupE.body.error).toMatchObject({ code: 'PHONE_EXISTS', details: { memberId: first.body.id } });
    const dupA = await create({ clientKey: randomUUID(), name: '匿名会员', cardType: 'anonymous', phone });
    expect(dupA.body.error.code).toBe('PHONE_EXISTS');
    const cardNo = nextCard();
    const dupP = await create(physical({ phone, card: { cardNo, deposit: cash } }));
    expect(dupP.body.error.code).toBe('PHONE_EXISTS');
    expect(await countMembers(phone)).toBe(1);
    expect((await ctx.sql`SELECT 1 FROM member_cards WHERE card_no = ${cardNo}`).length).toBe(0);
    // 这张卡没被占：别人照样能用
    expect((await create(physical({ card: { cardNo, deposit: cash } }))).status).toBe(201);
  });

  it('查找：没留手机号的按姓名、会员号找得到；按手机号片段找时不会排到前面', async () => {
    const anon = (await create({ clientKey: randomUUID(), name: '查找匿名客', cardType: 'anonymous' })).body as MemberSummary;
    const named = (await create({ name: '查找实名客', phone: '15509998877' })).body as MemberSummary;
    expect((await search('查找匿名客')).map((m) => m.id)).toEqual([anon.id]);
    expect((await search(anon.memberNo))[0]?.id).toBe(anon.id);
    // 「查找」两位都对得上名字；带上手机号片段只剩留了号的那位，而且排第一
    expect((await search('15509998877'))[0]?.id).toBe(named.id);
    expect((await search('9988')).map((m) => m.id)).toEqual([named.id]);
    const both = await search('查找');
    expect(both.map((m) => m.id).sort()).toEqual([anon.id, named.id].sort());
  });
});

describe('实体卡建档：同一笔里发卡、收押金', () => {
  it('建档成功：实体卡、在用的卡、押着押金；押金记到班次、进应有现金与日结，不进储值、不算营业额', async () => {
    const before = await currentShift();
    const beforeDay = await settlement();
    const body = physical({ name: '押金甲' });
    const r = await create(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const m = r.body as MemberSummary;
    expect(m).toMatchObject({ cardType: 'physical', principalBalance: 0, bonusBalance: 0 });
    const cards = await cardsOf(m.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ cardNo: body.card.cardNo, status: 'active', issuedByName: '测试店员' });
    const dep = await depositsOf(m.id);
    expect(dep.held).toBe(DEPOSIT);
    expect(dep.rows).toHaveLength(1);
    expect(dep.rows[0]).toMatchObject({ kind: 'receive', method: 'cash', amount: DEPOSIT, cardNo: body.card.cardNo, operatorName: '测试店员' });
    expect(dep.rows[0]!.docNo).toMatch(/^KY\d{8}-\d{4}$/);
    // 钱包一分没动：余额 0、没有储值流水
    expect(await detail(m.id)).toMatchObject({ principalBalance: 0, bonusBalance: 0, cardDepositHeld: DEPOSIT });
    expect((await ctx.sql`SELECT 1 FROM ledger_entries WHERE member_id = ${m.id}`).length).toBe(0);
    // 班次：会员卡押金单列，现金进应有现金；结账、充值的数不变
    const after = await currentShift();
    const got = (after.summary!.cardDeposits?.received.find((x) => x.method === 'cash')?.amount ?? 0) - (before.summary!.cardDeposits?.received.find((x) => x.method === 'cash')?.amount ?? 0);
    expect(got).toBe(DEPOSIT);
    expect(after.summary!.cash.expected - before.summary!.cash.expected).toBe(DEPOSIT);
    expect((after.summary!.cash.cardDeposit ?? 0) - (before.summary!.cash.cardDeposit ?? 0)).toBe(DEPOSIT);
    expect(after.summary!.checkouts).toEqual(before.summary!.checkouts);
    expect(after.summary!.recharges.paid).toBe(before.summary!.recharges.paid);
    // 押金行记着班次
    const [row] = await ctx.sql<{ shiftId: number | null }[]>`SELECT shift_id FROM member_card_deposits WHERE member_id = ${m.id}`;
    expect(Number(row!.shiftId)).toBe(after.id);
    // 日结：会员卡押金单列（负债），营业口径与储值口径都不变
    const day = await settlement();
    expect(day.cardDeposits.held - beforeDay.cardDeposits.held).toBe(DEPOSIT);
    expect(day.cardDeposits.received.find((x) => x.method === 'cash')!.amount - (beforeDay.cardDeposits.received.find((x) => x.method === 'cash')?.amount ?? 0)).toBe(DEPOSIT);
    expect(day.business).toEqual(beforeDay.business);
    expect(day.recharge).toEqual(beforeDay.recharge);
    expect(day.net).toEqual(beforeDay.net);
    for (const c of day.checks) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    // 原样重提：还是这一位，押金没有多收
    const again = await create(body);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(m.id);
    expect((await depositsOf(m.id)).held).toBe(DEPOSIT);
  });

  it('实体卡要卡号、要操作编号；押金金额对不上、没带押金、「其他」方式没写备注：整笔拒绝，什么都没建', async () => {
    expect((await create({ clientKey: randomUUID(), cardType: 'physical', name: '没卡号', phone: nextPhone() })).body.error.details).toEqual({ field: 'card.cardNo' });
    const noKey = physical();
    expect((await create({ ...noKey, clientKey: undefined })).body.error.details).toEqual({ field: 'clientKey' });
    const wrong = physical({ card: { cardNo: nextCard(), deposit: { ...cash, amount: 1000 } } });
    const r1 = await create(wrong);
    expect(r1.status).toBe(409);
    expect(r1.body.error).toMatchObject({ code: 'CARD_DEPOSIT_CHANGED', details: { deposit: DEPOSIT } });
    const none = physical({ card: { cardNo: nextCard(), deposit: null } });
    const r2 = await create(none);
    expect(r2.body.error).toMatchObject({ code: 'CARD_DEPOSIT_REQUIRED', details: { deposit: DEPOSIT } });
    const other = physical({ card: { cardNo: nextCard(), deposit: { ...cash, method: 'other' } } });
    expect((await create(other)).status).toBe(400);
    for (const b of [wrong, none, other]) {
      expect(await countMembers(b.phone as string)).toBe(0);
      expect((await ctx.sql`SELECT 1 FROM member_cards WHERE card_no = ${(b.card as { cardNo: string }).cardNo}`).length).toBe(0);
    }
    // 「其他」方式写明了收的是什么：可以
    const ok = await create(physical({ card: { cardNo: nextCard(), deposit: { ...cash, method: 'other', ref: '抵用券抵押金' } } }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await depositsOf(ok.body.id)).rows[0]).toMatchObject({ method: 'other', ref: '抵用券抵押金' });
  });

  it('卡号已经发给别人、已挂失：整笔拒绝，会员没有建、押金没有收', async () => {
    const holder = await create(physical({ name: '先拿到卡的' }));
    const cardNo = (await cardsOf(holder.body.id))[0]!.cardNo;
    const late = physical({ name: '后来的', card: { cardNo, deposit: cash } });
    const before = await currentShift();
    const r = await create(late);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CARD_TAKEN');
    expect(await countMembers(late.phone as string)).toBe(0);
    expect((await currentShift()).summary!.cash.expected).toBe(before.summary!.cash.expected);
    // 挂失的卡号也不能再发
    const card = (await cardsOf(holder.body.id))[0]!;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/member-cards/${card.id}/lost`, { reason: '客人说卡丢了' })).status).toBe(200);
    const lost = physical({ name: '捡到卡的', card: { cardNo, deposit: cash } });
    expect((await create(lost)).body.error.code).toBe('CARD_LOST');
    expect(await countMembers(lost.phone as string)).toBe(0);
  });

  it('匿名卡可以配一张实体卡（同样收押金）；刷卡找得到这份档案', async () => {
    const cardNo = nextCard();
    const r = await create({ clientKey: randomUUID(), cardType: 'anonymous', name: '匿名会员', card: { cardNo, deposit: { ...cash, method: 'wechat' } } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ cardType: 'anonymous', phone: null });
    expect((await depositsOf(r.body.id)).rows[0]).toMatchObject({ kind: 'receive', method: 'wechat', amount: DEPOSIT });
    expect((await search(cardNo))[0]?.id).toBe(r.body.id);
    // 微信收的押金不进应有现金，但在班次的会员卡押金里
    const s = await currentShift();
    expect(s.summary!.cardDeposits!.received.find((x) => x.method === 'wechat')!.amount).toBeGreaterThanOrEqual(DEPOSIT);
  });

  it('后台设成不收押金（0）：实体卡建档不带押金；带了押金的拒绝', async () => {
    expect((await setForm({ ...DEFAULT_MEMBER_FORM_RULES, cardDeposit: 0 })).status).toBe(200);
    try {
      const free = await create(physical({ card: { cardNo: nextCard(), deposit: null } }));
      expect(free.status, JSON.stringify(free.body)).toBe(201);
      expect(await depositsOf(free.body.id)).toEqual({ held: 0, rows: [] });
      expect((await create(physical())).body.error).toMatchObject({ code: 'CARD_DEPOSIT_CHANGED', details: { deposit: 0 } });
    } finally {
      await setForm(DEFAULT_MEMBER_FORM_RULES);
    }
  });

  it('要先开班的门店：没开班的人收押金整笔拒绝（SHIFT_REQUIRED），什么都没建', async () => {
    await ctx.sql`UPDATE settings SET value = 'true'::jsonb WHERE key = 'require_open_shift'`;
    try {
      // 店主没有开班
      const body = physical();
      const r = await create(body, ctx.owner);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('SHIFT_REQUIRED');
      expect(await countMembers(body.phone as string)).toBe(0);
      // 开着班的店员照常
      expect((await create(physical())).status).toBe(201);
      // 不收钱的建档（电子卡）不要求开班
      expect((await create({ name: '不收钱', phone: nextPhone() }, ctx.owner)).status).toBe(201);
    } finally {
      await ctx.sql`UPDATE settings SET value = 'false'::jsonb WHERE key = 'require_open_shift'`;
    }
  });
});

describe('发卡、挂失、补卡、退卡与押金', () => {
  it('给电子卡会员发卡：要收押金，发完是实体卡；换下在用的卡不另收；挂失不退、补卡沿用', async () => {
    const m = await createMember(ctx, '后来发卡', nextPhone());
    const first = nextCard();
    // 没带押金、金额不对：拒绝，卡没发
    expect((await issue(m.id, { cardNo: first })).body.error).toMatchObject({ code: 'CARD_DEPOSIT_REQUIRED', details: { deposit: DEPOSIT } });
    expect((await issue(m.id, { cardNo: first, deposit: { ...cash, amount: 500 } })).body.error.code).toBe('CARD_DEPOSIT_CHANGED');
    expect(await cardsOf(m.id)).toHaveLength(0);
    const ok = await issue(m.id, { cardNo: first, deposit: cash });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await detail(m.id)).toMatchObject({ cardType: 'physical', cardDepositHeld: DEPOSIT });
    // 卡坏了当场换：不另收押金（带了押金的拒绝）
    const second = nextCard();
    expect((await issue(m.id, { cardNo: second, replace: true, replaceReason: '卡坏了', deposit: cash })).body.error.code).toBe('CARD_DEPOSIT_CHANGED');
    expect((await issue(m.id, { cardNo: second, replace: true, replaceReason: '卡坏了' })).status).toBe(200);
    expect((await depositsOf(m.id)).held).toBe(DEPOSIT);
    // 挂失：押金照旧押着
    const active = (await cardsOf(m.id)).find((c) => c.status === 'active')!;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/member-cards/${active.id}/lost`, { reason: '客人来电说卡丢了' })).status).toBe(200);
    expect(await detail(m.id)).toMatchObject({ cardType: 'physical', cardDepositHeld: DEPOSIT });
    // 补卡：沿用原来的押金，不另收
    const third = nextCard();
    expect((await issue(m.id, { cardNo: third, replace: true })).status).toBe(200);
    const dep = await depositsOf(m.id);
    expect(dep.held).toBe(DEPOSIT);
    expect(dep.rows).toHaveLength(1);
    expect((await cardsOf(m.id)).map((c) => c.status).sort()).toEqual(['active', 'canceled', 'lost']);
  });

  it('退卡：在用的卡记「已退卡」、押金全额退、记到班次；退完记回电子卡，卡号可以再发；同一编号重提不多退', async () => {
    const body = physical({ name: '退卡甲' });
    const m = (await create(body)).body as MemberSummary;
    const before = await currentShift();
    // 页面看到的押金不对、非现金没登记退款单号：拒绝
    expect((await giveBack(m.id, { expectedDeposit: 1000, method: 'cash' })).body.error).toMatchObject({ code: 'CARD_DEPOSIT_CHANGED', details: { deposit: DEPOSIT } });
    expect((await giveBack(m.id, { expectedDeposit: DEPOSIT, method: 'wechat' })).status).toBe(400);
    expect((await giveBack(m.id, { expectedDeposit: DEPOSIT })).body.error.details).toEqual({ field: 'method' });
    expect((await giveBack(m.id, { expectedDeposit: DEPOSIT, method: 'cash', reason: '退' })).status).toBe(400);
    const key = randomUUID();
    const r = await giveBack(m.id, { clientKey: key, expectedDeposit: DEPOSIT, method: 'cash' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ memberId: m.id, refunded: DEPOSIT, replayed: false });
    expect((await giveBack(m.id, { clientKey: key, expectedDeposit: DEPOSIT, method: 'cash' })).body).toEqual({ memberId: m.id, refunded: DEPOSIT, replayed: true });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${key}?type=member_card_return`)).body).toEqual({ found: true, abandoned: false, refId: m.id });
    const card = (await cardsOf(m.id))[0]!;
    expect(card).toMatchObject({ status: 'returned', endReason: '客人不再用卡了', endedByName: '测试店员' });
    const dep = await depositsOf(m.id);
    expect(dep.held).toBe(0);
    expect(dep.rows.map((x) => x.kind)).toEqual(['refund', 'receive']);
    expect(dep.rows[0]).toMatchObject({ method: 'cash', amount: DEPOSIT, reason: '客人不再用卡了', cardNo: body.card.cardNo });
    expect(dep.rows[0]!.docNo).toMatch(/^KT\d{8}-\d{4}$/);
    expect(await detail(m.id)).toMatchObject({ cardType: 'ecard', cardDepositHeld: 0, principalBalance: 0 });
    // 班次：退的现金从应有现金里扣
    const after = await currentShift();
    expect(after.summary!.cash.expected - before.summary!.cash.expected).toBe(-DEPOSIT);
    expect(after.summary!.cardDeposits!.refunded.find((x) => x.method === 'cash')!.amount).toBeGreaterThanOrEqual(DEPOSIT);
    // 没有卡、也没有押金了：不用退
    expect((await giveBack(m.id, { expectedDeposit: 0 })).body.error.code).toBe('CARD_NOTHING_TO_RETURN');
    // 退回来的卡号可以再发；刷这张卡找到的是新卡主
    const next = await create(physical({ name: '退卡乙', card: { cardNo: body.card.cardNo, deposit: cash } }));
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect((await search(body.card.cardNo))[0]?.id).toBe(next.body.id);
  });

  it('卡丢了不补了：挂失以后在「退卡」里把押金退掉（没卡可退）；扫码退的登记退款单号', async () => {
    const m = (await create(physical({ name: '丢卡不补' }))).body as MemberSummary;
    const card = (await cardsOf(m.id))[0]!;
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/member-cards/${card.id}/lost`, { reason: '卡丢了' })).status).toBe(200);
    const r = await giveBack(m.id, { expectedDeposit: DEPOSIT, method: 'alipay', ref: 'TK20261119001', reason: '卡丢了不补了' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const dep = await depositsOf(m.id);
    expect(dep.held).toBe(0);
    expect(dep.rows[0]).toMatchObject({ kind: 'refund', method: 'alipay', ref: 'TK20261119001', cardNo: null });
    // 卡照旧是挂失的（卡号不能再发）；人记回电子卡
    expect((await cardsOf(m.id))[0]!.status).toBe('lost');
    expect((await detail(m.id)).cardType).toBe('ecard');
    // 之后再补卡：名下没有押金了，要重新收
    expect((await issue(m.id, { cardNo: nextCard(), replace: true })).body.error.code).toBe('CARD_DEPOSIT_REQUIRED');
    expect((await issue(m.id, { cardNo: nextCard(), replace: true, deposit: cash })).status).toBe(200);
    expect(await detail(m.id)).toMatchObject({ cardType: 'physical', cardDepositHeld: DEPOSIT });
  });

  it('确认作废以后，原来的建档、退卡请求晚到：整笔拒绝，没有建档、没有退钱', async () => {
    const body = physical({ name: '作废了的建档' });
    const fenced = await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${body.clientKey}/abandon`, { type: 'member_create', summary: '新建会员' });
    expect(fenced.body).toMatchObject({ found: false, abandoned: true });
    const late = await create(body);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    expect(await countMembers(body.phone as string)).toBe(0);
    // 退卡同理
    const m = (await create(physical({ name: '作废了的退卡' }))).body as MemberSummary;
    const key = randomUUID();
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${key}/abandon`, { type: 'member_card_return', summary: '退卡' })).body.abandoned).toBe(true);
    expect((await giveBack(m.id, { clientKey: key, expectedDeposit: DEPOSIT, method: 'cash' })).body.error.code).toBe('OP_ABANDONED');
    expect((await depositsOf(m.id)).held).toBe(DEPOSIT);
    // 已经办成的不能作废：查回原来那位
    const done = physical({ name: '办成了的' });
    const ok = await create(done);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${done.clientKey}/abandon`, { type: 'member_create', summary: '新建会员' })).body).toEqual({
      found: true,
      abandoned: false,
      refId: ok.body.id,
    });
  });

  it('还押着押金的会员不能合并到别人：先退卡、退押金', async () => {
    const src = (await create(physical({ name: '合并来源' }))).body as MemberSummary;
    const dst = await createMember(ctx, '合并目标', nextPhone());
    const check = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${src.id}/merge-check?targetId=${dst.id}`)).body;
    expect(check.problems.join('；')).toContain('还押着实体卡押金');
    const merge = { clientKey: randomUUID(), targetId: dst.id, reason: '同一个人建了两份', expectedPrincipal: 0, expectedBonus: 0 };
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${src.id}/merge`, merge)).body.error.code).toBe('MERGE_BLOCKED');
    expect((await giveBack(src.id, { expectedDeposit: DEPOSIT, method: 'cash' })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/members/${src.id}/merge`, { ...merge, clientKey: randomUUID() })).status).toBe(200);
  });
});

describe('会员等级、推荐人、偏好项目', () => {
  it('等级默认按规则自动（L0）；手动指定要「手动调整会员档阶」权限，走手动调整那条路、留记录', async () => {
    const auto = (await create({ name: '自动等级', phone: nextPhone() })).body as MemberSummary;
    expect(auto).toMatchObject({ grade: 0, tier: null });
    // 店员没有调整档阶的权限
    const denied = await create({ clientKey: randomUUID(), name: '想指定等级', phone: nextPhone(), grade: { grade: 3, tier: 1, reason: '老客户' } });
    expect(denied.status).toBe(403);
    // 指定 L0 等于自动：谁都可以
    expect((await create({ clientKey: randomUUID(), name: '指定 L0', phone: nextPhone(), grade: { grade: 0, tier: null, reason: '按规则' } })).status).toBe(201);
    // 店主指定：要写原因；只有 L0 没有阶位
    const phone = nextPhone();
    expect((await create({ name: '店主指定', phone, grade: { grade: 3, tier: 1, reason: '' } }, ctx.owner)).status).toBe(400);
    expect((await create({ name: '店主指定', phone, grade: { grade: 3, tier: null, reason: '老客户' } }, ctx.owner)).status).toBe(400);
    const r = await create({ clientKey: randomUUID(), name: '店主指定', phone, grade: { grade: 3, tier: 1, reason: '老客户迁过来' } }, ctx.owner);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ grade: 3, tier: 1 });
    const info = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${r.body.id}/grade`)).body;
    expect(info.events[0]).toMatchObject({ kind: 'manual', fromGrade: 0, toGrade: 3, toTier: 1, reason: '老客户迁过来', staffName: '测试店主' });
    expect(info.state).toMatchObject({ grade: 3, tier: 1, graceUntil: null });
    expect(info.state.cycleEnd).toBeTruthy();
    const checks = await consistencyChecks(ctx.sql, ctx.config.timezone);
    for (const c of checks.filter((x) => x.label.includes('档阶'))) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  });

  it('推荐人是一位已有的会员（不能是自己、不能是合并过的）；偏好项目去重、最多 10 个', async () => {
    const referrer = (await create({ name: '介绍人', phone: nextPhone() })).body as MemberSummary;
    const r = await create({ name: '被介绍的', phone: nextPhone(), referrerMemberId: referrer.id, preferredItems: ['足疗', ' 汗蒸 ', '足疗'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ referrerMemberId: referrer.id, preferredItems: ['足疗', '汗蒸'] });
    expect(await detail(r.body.id)).toMatchObject({ referrer: { id: referrer.id, name: '介绍人', memberNo: referrer.memberNo }, preferredItems: ['足疗', '汗蒸'] });
    expect((await create({ name: '推荐人不存在', phone: nextPhone(), referrerMemberId: 99_999_999 })).body.error.details).toEqual({ field: 'referrerMemberId' });
    expect((await create({ name: '偏好太多', phone: nextPhone(), preferredItems: Array.from({ length: 11 }, (_, i) => `项目${i}`) })).status).toBe(400);
    // 编辑：推荐人不能改成自己；不带就保持原样；null 清空
    const edit = (body: Record<string, unknown>) => api(ctx.app, ctx.clerk, 'PUT', `/api/members/${r.body.id}`, { name: '被介绍的', phone: r.body.phone, ...body });
    expect((await edit({ referrerMemberId: r.body.id })).body.error.details).toEqual({ field: 'referrerMemberId' });
    expect((await edit({ note: '只改备注' })).body).toMatchObject({ referrer: { id: referrer.id }, preferredItems: ['足疗', '汗蒸'], note: '只改备注' });
    expect((await edit({ referrerMemberId: null, preferredItems: ['搓背'] })).body).toMatchObject({ referrer: null, preferredItems: ['搓背'] });
  });
});

describe('后台设的建档表单：服务端核对，按门店各一份', () => {
  it('必填的没填就拒绝；不显示的字段建档时不收、编辑时保持原样；店员改不了设置', async () => {
    const rules: MemberFormRules = {
      cardDeposit: DEPOSIT,
      fields: { ...DEFAULT_MEMBER_FORM_RULES.fields, birthday: { show: true, required: true }, note: { show: false, required: false } },
    };
    expect((await setForm(rules, ctx.clerk)).status).toBe(403);
    // 先在默认设置下建一位带备注的
    const old = (await create({ name: '原来有备注', phone: nextPhone(), note: '对花生过敏' })).body as MemberSummary;
    const saved = await setForm(rules);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.memberForm).toEqual(rules);
    try {
      // 会话里带着这份设置（页面按它显示）
      expect((await api(ctx.app, ctx.clerk, 'GET', '/api/auth/me')).body.rules.memberForm).toEqual(rules);
      const missing = await create({ name: '没填生日', phone: nextPhone() });
      expect(missing.status).toBe(400);
      expect(missing.body.error.details).toEqual({ field: 'birthday' });
      expect(missing.body.error.message).toContain('生日');
      const ok = await create({ name: '填了生日', phone: nextPhone(), birthday: '1990-05-06', note: '这条备注不该收' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body).toMatchObject({ birthday: '1990-05-06', note: '' });
      // 编辑：不显示的备注保持原样；必填的生日没填拒绝
      const put = (body: Record<string, unknown>) => api(ctx.app, ctx.clerk, 'PUT', `/api/members/${old.id}`, { name: '原来有备注', phone: old.phone, ...body });
      expect((await put({ note: '想改掉' })).body.error.details).toEqual({ field: 'birthday' });
      expect((await put({ note: '想改掉', birthday: '1988-01-02' })).body).toMatchObject({ note: '对花生过敏', birthday: '1988-01-02' });
      // 期初导入、邀请体验这类不经页面的建档不按这份设置核对：演示数据的那条路（enforceRequired: false）在别的用例里
    } finally {
      await setForm(DEFAULT_MEMBER_FORM_RULES);
    }
    // 不显示的字段不会是必填；缺项的整份拒绝
    const odd = await setForm({ cardDeposit: 0, fields: { ...DEFAULT_MEMBER_FORM_RULES.fields, gender: { show: false, required: true } } });
    expect(odd.body.memberForm.fields.gender).toEqual({ show: false, required: false });
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { memberForm: { cardDeposit: 100, fields: { gender: { show: true, required: false } } } })).status).toBe(400);
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/settings', { memberForm: { ...DEFAULT_MEMBER_FORM_RULES, cardDeposit: 100_001 } })).status).toBe(400);
    await setForm(DEFAULT_MEMBER_FORM_RULES);
  });

  it('第二家店单独设的只管它自己：存在门店的设置里，本店照旧', async () => {
    const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '会员用例二店有限公司', taxNo: '91440300MA5XXXXXX9' });
    const store = await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'm2', name: '会员二店', entityId: entity.body.id });
    expect(store.status, JSON.stringify(store.body)).toBe(201);
    const second: MemberFormRules = { cardDeposit: 5000, fields: { ...DEFAULT_MEMBER_FORM_RULES.fields, referrer: { show: false, required: false } } };
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: store.body.id })).status).toBe(200);
    try {
      expect((await setForm(second)).status).toBe(200);
      expect((await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.rules.memberForm).toEqual(second);
      const [own] = await ctx.sql<{ value: MemberFormRules }[]>`SELECT value FROM store_settings WHERE store_id = ${store.body.id} AND key = 'member_form_rules'`;
      expect(own?.value.cardDeposit).toBe(5000);
    } finally {
      expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: 1 })).status).toBe(200);
    }
    expect((await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.rules.memberForm).toEqual(DEFAULT_MEMBER_FORM_RULES);
  });
});

describe('匿名卡补登手机号与转实名', () => {
  it('补登手机号算改号：要原因、要权限或授权；登记以后不能清空；转实名记成电子卡', async () => {
    const anon = (await create({ clientKey: randomUUID(), name: '匿名会员', cardType: 'anonymous' })).body as MemberSummary;
    const phone = nextPhone();
    const put = (body: Record<string, unknown>, cookie = ctx.clerk) => api(ctx.app, cookie, 'PUT', `/api/members/${anon.id}`, { name: '匿名会员', ...body });
    // 不留手机号照样能改别的
    expect((await put({ note: '常来' })).body).toMatchObject({ phone: null, note: '常来', cardType: 'anonymous' });
    // 没留手机号的转不了实名
    expect((await put({ convertToNamed: true })).body.error.details).toEqual({ field: 'phone' });
    // 补登：要原因；店员没有「改会员手机号」权限，要当场授权
    expect((await put({ phone })).body.error.details).toEqual({ field: 'phoneReason' });
    expect((await put({ phone, phoneReason: '客人愿意留号了' })).body.error.code).toBe('PHONE_AUTH_REQUIRED');
    const ok = await put({ phone, phoneReason: '客人愿意留号了' }, ctx.owner);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ phone, cardType: 'anonymous' });
    const history = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${anon.id}/account-history`)).body;
    expect(history.phoneChanges[0]).toMatchObject({ oldPhone: null, newPhone: phone, reason: '客人愿意留号了' });
    // 登记以后不能清空
    expect((await put({ phone: null }, ctx.owner)).body.error.details).toEqual({ field: 'phone' });
    // 转实名：记成电子卡；之后手机号必填
    const named = await put({ phone, convertToNamed: true }, ctx.owner);
    expect(named.body).toMatchObject({ phone, cardType: 'ecard' });
    expect((await put({ phone: '' }, ctx.owner)).body.error.message).toBe('请输入 11 位手机号');
    // 实名的会员手机号不能空着
    const e = await createMember(ctx, '实名会员', nextPhone());
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/members/${e.id}`, { name: '实名会员', phone: null })).status).toBe(400);
  });
});

describe('交班与自检', () => {
  it('交班：应有现金里有会员卡押金（收 − 退），快照里单列；自检全部通过', async () => {
    const shift = await currentShift();
    const sum = shift.summary!;
    const received = sum.cardDeposits!.received.find((x) => x.method === 'cash')?.amount ?? 0;
    const refunded = sum.cardDeposits!.refunded.find((x) => x.method === 'cash')?.amount ?? 0;
    expect(received).toBeGreaterThan(0);
    expect(sum.cash.cardDeposit).toBe(received - refunded);
    // 应有现金 = 备用金 + 结账现金 + 充值现金 + 会员卡押金现金（这个班次没有别的现金往来）
    expect(sum.cash.expected).toBe(sum.cash.opening + sum.cash.checkout + sum.cash.recharge + (sum.cash.cardDeposit ?? 0));
    // 台账里记到这个班次的现金与交班表一致
    const [row] = await ctx.sql<{ net: number }[]>`
      SELECT coalesce(sum(CASE WHEN kind = 'receive' THEN amount ELSE -amount END), 0)::int AS net FROM member_card_deposits WHERE shift_id = ${shift.id} AND method = 'cash'`;
    expect(row!.net).toBe(sum.cash.cardDeposit);
    // 日结导出：会员卡押金单列一段（负债），与日结页同一组数
    const day = await settlement();
    const csv = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${day.businessDate}/export`)).body as string;
    expect(csv).toContain('会员卡押金（负债，不算营业额、不进储值）');
    expect(csv).toContain('当天结束时押着的会员卡押金');
    const closed = await api(ctx.app, ctx.clerk, 'POST', `/api/shifts/${shift.id}/close`, { countedCash: sum.cash.expected, expectedCash: sum.cash.expected });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.summary.cardDeposits).toEqual(sum.cardDeposits);
    expect(closed.body.expectedCash).toBe(sum.cash.expected);
    // 交班以后没有开班的人收押金：不要求开班的门店照常办，押金不记班次
    const m = await create(physical({ name: '交班以后' }));
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    const [late] = await ctx.sql<{ shiftId: number | null }[]>`SELECT shift_id FROM member_card_deposits WHERE member_id = ${m.body.id}`;
    expect(late!.shiftId).toBeNull();
    for (const c of await cardDepositChecks(ctx.sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    for (const c of await consistencyChecks(ctx.sql, ctx.config.timezone)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    // 每日对账包：会员卡押金逐笔列出（收、退各有），汇总与日结一致；交班表的押金现金一列里有它
    const recon = await buildDailyRecon(ctx.sql, ctx.config, day.businessDate);
    expect(recon.ok).toBe(true);
    const file = recon.files.find((f) => f.name === '14-会员卡押金.csv')!.content;
    const lines = file.split('\n');
    const paid = await ctx.sql<{ kind: string; n: number }[]>`SELECT kind, count(*)::int AS n FROM member_card_deposits GROUP BY kind`;
    expect(lines.filter((l) => /,收押金,/.test(l)).length).toBe(paid.find((p) => p.kind === 'receive')!.n);
    expect(lines.filter((l) => /,退押金,/.test(l)).length).toBe(paid.find((p) => p.kind === 'refund')!.n);
    expect(file).toContain('当天结束时押着的押金');
    expect(recon.files.find((f) => f.name === '00-说明.txt')!.content).toContain('会员卡押金：收 ');
  });
});
