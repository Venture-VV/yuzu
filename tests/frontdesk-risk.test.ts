// 8.1.15《浴族系统需求汇总》块 A（docs/FRONTDESK_RISK_V8115.md）：前台 NFC 发牌、发牌前风控、发牌后异常处置。
//   · 手牌芯片号：绑定 / 解绑（权限、格式、一个芯片号只绑一张牌、并发绑同一张卡）、按芯片号查牌与现在的状态；
//   · 发牌前风控：黑名单（登记、解除、只追加、命中拒绝并留痕）、未结离店（当场授权、授权范围、留痕在来访上、处理完不再拦）、
//     当日重复到店（只提示）、预约带出并在发牌成功后核销（派对房不自动）、同一编号重提、并发发同一张牌、开关关掉与以前一样；
//   · 发牌后的异常：提醒、外出 / 返回、超时加收（值班经理直接加、店员凭授权；就是一条手动金额的明细）、上报与未结离店的待办
//     （指派、处理结果只能写一次）、同一编号重提、按编号查回与作废、已离店的不能再记、数据库只追加。
// 别的用例从「发牌前风控关着」开始（tests/helpers.ts 的 legacySwitchesOff）；这里一开始就打开。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckoutPreview } from '../src/shared/checkout';
import type { CheckinResult, FrontdeskBoard, FrontdeskCheck, VisitDetail } from '../src/shared/frontdesk';
import type { BlacklistEntry, IncidentTodoList, MemberRisk, TagByCard } from '../src/shared/frontdesk-risk';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let duty: string; // 值班经理：维护黑名单、当场授权、处理未结离店
let dutyId = 0;
let back: string; // 后勤：没有前台权限
let tagNo = 0;
const tagIds = new Map<string, number>();

const err = (r: { body: { error?: { code?: string } } }) => r.body.error?.code;
const nextTag = () => `R${String((tagNo += 1)).padStart(3, '0')}`;
const checkinRaw = (cookie: string, body: Record<string, unknown>, key = randomUUID()) => api(ctx.app, cookie, 'POST', '/api/frontdesk/checkins', { clientKey: key, ...body });
/** 接待一位（会员或散客），返回来访 id 与牌号 */
const enter = async (memberId: number | null, extra: Record<string, unknown> = {}) => {
  const code = nextTag();
  const r = await checkinRaw(ctx.clerk, { guests: [{ tagCode: code, zone: 'male', memberId }], ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: (r.body as CheckinResult).visits[0]!.id, code, result: r.body as CheckinResult };
};
const visit = async (id: number) => (await api<VisitDetail>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${id}`)).body;
const board = async () => (await api<FrontdeskBoard>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
const risk = async (memberId: number) => (await api<MemberRisk>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/members/${memberId}/risk`)).body;
const incident = (cookie: string, visitId: number, body: Record<string, unknown>, key = randomUUID()) =>
  api(ctx.app, cookie, 'POST', `/api/frontdesk/visits/${visitId}/incidents`, { clientKey: key, ...body });
const todos = async () => (await api<IncidentTodoList>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/incidents/todos')).body;
/** 请值班经理当场授权（店员申请） */
const grant = (scope: Record<string, unknown>, by: { cookie?: string; username?: string } = {}) =>
  api(ctx.app, by.cookie ?? ctx.clerk, 'POST', '/api/auth/authorize', { username: by.username ?? 'rduty', password: PASSWORD, purpose: 'checkin_risk', scope });
/** 现金结清一张手牌 */
const settle = async (visitId: number) => {
  const pre = (await api<CheckoutPreview>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: pre.totalAmount,
    payments: pre.totalAmount > 0 ? [{ method: 'cash', amount: pre.totalAmount }] : [],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return pre.totalAmount;
};
const blacklist = (cookie: string, body: Record<string, unknown>) => api(ctx.app, cookie, 'POST', '/api/frontdesk/blacklist', body);
const lift = (cookie: string, id: number, reason = '误登记') => api(ctx.app, cookie, 'POST', `/api/frontdesk/blacklist/${id}/lift`, { reason });
const audits = (action: string) => ctx.sql<{ detail: Record<string, any>; targetId: string | null }[]>`SELECT detail, target_id FROM audit_logs WHERE action = ${action} ORDER BY id`;
const selfCheck = async () => (await api<FrontdeskCheck[]>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/checks')).body;

beforeAll(async () => {
  ctx = await setup();
  // 发牌前风控：这里打开（基线里关着）
  await ctx.sql`UPDATE settings SET value = ${ctx.sql.json({ enabled: true })} WHERE key = 'frontdesk_risk_rules'`;
  dutyId = await createStaff(ctx.sql, { username: 'rduty', displayName: '值班乙', role: 'duty_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'rback', displayName: '后勤丁', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  duty = await login(ctx.app, 'rduty');
  back = await login(ctx.app, 'rback');
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'R', from: 1, to: 80, width: 3, zone: 'male' })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'W', from: 1, to: 3, width: 3, zone: 'female' })).status).toBe(200);
  for (const t of (await api<{ id: number; code: string }[]>(ctx.app, ctx.owner, 'GET', '/api/frontdesk/tags')).body) tagIds.set(t.code, t.id);
});
afterAll(async () => ctx?.close());

describe('手牌芯片号', () => {
  const bind = (cookie: string, code: string, cardUid: string | null) => api(ctx.app, cookie, 'PUT', `/api/frontdesk/tags/${tagIds.get(code)}/card`, { cardUid });
  const byCard = async (uid: string) => (await api<TagByCard>(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/tags/by-card?uid=${encodeURIComponent(uid)}`)).body;

  it('绑定要「维护手牌池」；读卡器报的写法不一，存的是去掉分隔符的大写；清单带出芯片号；留审计', async () => {
    expect((await bind(ctx.clerk, 'R070', '04A1B2C3')).status).toBe(403);
    const r = await bind(duty, 'R070', ' 04:a1:b2:c3 ');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ code: 'R070', cardUid: '04A1B2C3' });
    const list = (await api<{ code: string; cardUid: string | null }[]>(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/tags')).body;
    expect(list.find((t) => t.code === 'R070')!.cardUid).toBe('04A1B2C3');
    expect(list.find((t) => t.code === 'R071')!.cardUid).toBeNull();
    expect((await audits('hand_tag_card')).at(-1)!.detail).toMatchObject({ code: 'R070', before: null, after: '04A1B2C3' });
    // 同样的再绑一次：不重复记
    expect((await bind(duty, 'R070', '04a1b2c3')).status).toBe(200);
    expect(await audits('hand_tag_card')).toHaveLength(1);
  });

  it('一个芯片号只绑一张牌：绑到别的牌上拒绝并写明是哪张；格式不对拒绝；解绑以后才能绑到别的牌', async () => {
    const taken = await bind(duty, 'R071', '04A1B2C3');
    expect([taken.status, err(taken), taken.body.error.details]).toEqual([409, 'CARD_BOUND', { code: 'R070' }]);
    expect(taken.body.error.message).toContain('R070');
    for (const bad of ['12', '卡号', 'A'.repeat(33)]) expect((await bind(duty, 'R071', bad)).status).toBe(400);
    expect((await bind(duty, 'R070', null)).body).toMatchObject({ cardUid: null });
    expect((await bind(duty, 'R071', '04A1B2C3')).status).toBe(200);
    expect((await bind(duty, 'R070', '0012345678')).status).toBe(200);
  });

  it('两张牌同时绑同一张卡：只有一张绑上', async () => {
    const [a, b] = await Promise.all([bind(duty, 'R072', 'RACE0001'), bind(duty, 'R073', 'RACE0001')]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const [count] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM hand_tags WHERE card_uid = 'RACE0001'`;
    expect(count!.n).toBe(1);
  });

  it('按芯片号查牌：没绑、空闲、已在店（带来访）、已锁定、已停用', async () => {
    expect(await byCard('FFFF0000')).toEqual({ found: false, cardUid: 'FFFF0000' });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/tags/by-card?uid=1')).status).toBe(400);
    expect((await api(ctx.app, back, 'GET', '/api/frontdesk/tags/by-card?uid=0012345678')).status).toBe(403);
    const free = await byCard('00-1234-5678');
    expect(free).toMatchObject({ found: true, cardUid: '0012345678', state: 'free', visit: null, tag: { code: 'R070', zone: 'male', kind: 'normal' } });
    const v = await checkinRaw(ctx.clerk, { guests: [{ tagCode: 'R070', zone: 'male' }] });
    expect(v.status).toBe(201);
    expect(await byCard('0012345678')).toMatchObject({ state: 'in_use', visit: { id: v.body.visits[0].id, visitNo: v.body.visits[0].visitNo } });
    // 在店的牌也能解绑、再绑：只是「刷卡带出牌号」用的，不动来访
    expect((await bind(duty, 'R070', null)).status).toBe(200);
    expect((await bind(duty, 'R070', '0012345678')).status).toBe(200);
    expect((await visit(v.body.visits[0].id)).status).toBe('open');
    expect((await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/tags/${tagIds.get('R071')}/lock`, { reason: '柜锁故障' })).status).toBe(200);
    expect(await byCard('04A1B2C3')).toMatchObject({ state: 'locked', tag: { code: 'R071', locked: true, lockReason: '柜锁故障' } });
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/frontdesk/tags/${tagIds.get('R072')}`, { zone: 'male', active: false })).status).toBe(200);
    const raced = await byCard('RACE0001');
    if (raced.found && raced.tag.code === 'R072') expect(raced.state).toBe('inactive');
  });
});

describe('发牌前风控 · 黑名单', () => {
  it('加入、解除要「维护黑名单」；命中的会员发牌被拒绝、不产生来访、留一条审计；解除以后照常发牌', async () => {
    const m = await createMember(ctx, '黑名单甲');
    expect((await blacklist(ctx.clerk, { memberId: m.id, reason: '多次逃单' })).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/blacklist')).status).toBe(403);
    expect((await blacklist(duty, { memberId: m.id, reason: '逃' })).status).toBe(400);
    const added = await blacklist(duty, { memberId: m.id, reason: '多次逃单' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body as BlacklistEntry).toMatchObject({ memberId: m.id, phone: null, name: '黑名单甲', reason: '多次逃单', createdByName: '值班乙', liftedAt: null });
    expect(err(await blacklist(duty, { memberId: m.id, reason: '再记一次' }))).toBe('ALREADY_BLACKLISTED');
    // 页面预先看得到；会员详情里（能看会员的人）也看得到
    expect((await risk(m.id)).blacklist).toMatchObject({ id: added.body.id, reason: '多次逃单', createdByName: '值班乙' });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/blacklist/member/${m.id}`)).body.entry).toMatchObject({ id: added.body.id });

    const code = nextTag();
    const key = randomUUID();
    const refused = await checkinRaw(ctx.clerk, { guests: [{ tagCode: code, zone: 'male', memberId: m.id }] }, key);
    expect([refused.status, err(refused)]).toEqual([422, 'GUEST_BLACKLISTED']);
    expect(refused.body.error.message).toContain('多次逃单');
    expect(refused.body.error.message).toContain('值班乙');
    expect((await board()).tags.find((t) => t.code === code)!.visit).toBeNull();
    const blocked = (await audits('checkin_blocked')).at(-1)!;
    expect(blocked.detail).toMatchObject({ memberId: m.id, blacklistId: added.body.id, tags: [code], key });
    // 值班经理自己发牌也一样拒绝（要先解除）
    expect(err(await checkinRaw(duty, { guests: [{ tagCode: code, zone: 'male', memberId: m.id }] }))).toBe('GUEST_BLACKLISTED');

    expect((await lift(ctx.clerk, added.body.id)).status).toBe(403);
    expect((await lift(duty, added.body.id, '解')).status).toBe(400);
    const lifted = await lift(duty, added.body.id, '已和客人谈妥');
    expect(lifted.body as BlacklistEntry).toMatchObject({ liftedByName: '值班乙', liftReason: '已和客人谈妥' });
    expect(err(await lift(duty, added.body.id, '已和客人谈妥'))).toBe('ALREADY_LIFTED');
    expect((await risk(m.id)).blacklist).toBeNull();
    expect((await checkinRaw(ctx.clerk, { guests: [{ tagCode: code, zone: 'male', memberId: m.id }] }, key)).status).toBe(201);
    // 清单：默认只看没解除的，all 连解除的一起
    const active = (await api<BlacklistEntry[]>(ctx.app, duty, 'GET', '/api/frontdesk/blacklist')).body;
    expect(active.some((e) => e.id === added.body.id)).toBe(false);
    const all = (await api<BlacklistEntry[]>(ctx.app, duty, 'GET', '/api/frontdesk/blacklist?all=1')).body;
    expect(all.find((e) => e.id === added.body.id)).toMatchObject({ liftReason: '已和客人谈妥' });
    // 解除以后可以再登记一条新的（原来那条留着）
    expect((await blacklist(duty, { memberId: m.id, reason: '又一次逃单' })).status).toBe(201);
    expect((await audits('blacklist_added')).length).toBeGreaterThanOrEqual(2);
    expect((await audits('blacklist_lifted')).at(-1)!.detail).toMatchObject({ reason: '已和客人谈妥' });
  });

  it('黑名单跟着人走：在黑名单上的会员合并到另一位以后，那一位发牌照样被拒、看得到这一条；解除以后照常发牌（Codex 审查 35c4338）', async () => {
    const a = await createMember(ctx, '合并甲');
    const b = await createMember(ctx, '合并乙');
    const added = await blacklist(duty, { memberId: a.id, reason: '多次逃单' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    // 店主把甲合并到乙（同一个人的两份档案）；合并不转移黑名单（登记只追加、不能改）
    const check = (await api(ctx.app, ctx.owner, 'GET', `/api/members/${a.id}/merge-check?targetId=${b.id}`)).body as { principal: number; bonus: number };
    const merged = await api(ctx.app, ctx.owner, 'POST', `/api/members/${a.id}/merge`, {
      clientKey: randomUUID(),
      targetId: b.id,
      reason: '同一个人建了两份档案',
      expectedPrincipal: check.principal,
      expectedBonus: check.bonus,
    });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    // 合并到的乙：发牌被拒，写明是合并前的甲登记的；页面预先看、会员详情里都看得到这一条
    const refused = await checkinRaw(ctx.clerk, { guests: [{ tagCode: nextTag(), zone: 'male', memberId: b.id }] });
    expect([refused.status, err(refused)]).toEqual([422, 'GUEST_BLACKLISTED']);
    expect(refused.body.error.message).toContain('合并前的「合并甲」');
    expect((await risk(b.id)).blacklist).toMatchObject({ id: added.body.id, name: '合并乙（合并前的「合并甲」）', reason: '多次逃单' });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/blacklist/member/${b.id}`)).body.entry).toMatchObject({ id: added.body.id, memberId: a.id });
    // 甲已合并：新的登记要记在乙身上
    expect(err(await blacklist(duty, { memberId: a.id, reason: '又一次逃单' }))).toBe('MEMBER_MERGED');
    // 解除那一条以后乙照常发牌
    expect((await lift(duty, added.body.id, '已和客人谈妥')).status).toBe(200);
    expect((await risk(b.id)).blacklist).toBeNull();
    await enter(b.id);
  });

  it('按手机号登记：号码是会员的记成那位会员；不是会员的要写称呼，这个号码以后办了会员照样拦', async () => {
    const m = await createMember(ctx, '黑名单乙', '13811110001');
    const byPhone = await blacklist(duty, { phone: '13811110001', reason: '醉酒闹事' });
    expect(byPhone.body as BlacklistEntry).toMatchObject({ memberId: m.id, phone: null, name: '黑名单乙' });
    expect(err(await checkinRaw(ctx.clerk, { guests: [{ tagCode: nextTag(), zone: 'male', memberId: m.id }] }))).toBe('GUEST_BLACKLISTED');

    expect((await blacklist(duty, { phone: '13811110002', reason: '偷拿物品' })).status).toBe(400);
    expect((await blacklist(duty, { memberId: m.id, phone: '13811110002', reason: '两样都填' })).status).toBe(400);
    expect((await blacklist(duty, { reason: '都不填' })).status).toBe(400);
    const walkin = await blacklist(duty, { phone: '13811110002', name: '王某', reason: '偷拿物品' });
    expect(walkin.body as BlacklistEntry).toMatchObject({ memberId: null, phone: '13811110002', name: '王某' });
    expect(err(await blacklist(duty, { phone: '13811110002', name: '王某', reason: '偷拿物品' }))).toBe('ALREADY_BLACKLISTED');
    const later = await createMember(ctx, '王某本人', '13811110002');
    expect((await risk(later.id)).blacklist).toMatchObject({ id: walkin.body.id, reason: '偷拿物品' });
    expect(err(await checkinRaw(ctx.clerk, { guests: [{ tagCode: nextTag(), zone: 'male', memberId: later.id }] }))).toBe('GUEST_BLACKLISTED');
    // 同行的散客不受影响；同一次接待里有一位命中，整笔拒绝
    const mixed = await checkinRaw(ctx.clerk, {
      guests: [
        { tagCode: nextTag(), zone: 'male', memberId: later.id },
        { tagCode: nextTag(), zone: 'male' },
      ],
    });
    expect(err(mixed)).toBe('GUEST_BLACKLISTED');
  });

  it('黑名单只能「登记 → 解除」：数据库不许改登记内容、不许删、解除了的不许再改', async () => {
    const [row] = await ctx.sql<{ id: number }[]>`SELECT id FROM guest_blacklist WHERE lifted_at IS NOT NULL LIMIT 1`;
    const [open] = await ctx.sql<{ id: number }[]>`SELECT id FROM guest_blacklist WHERE lifted_at IS NULL LIMIT 1`;
    await expect(ctx.sql`UPDATE guest_blacklist SET reason = '改掉原因' WHERE id = ${open!.id}`).rejects.toThrow(/不可修改/);
    await expect(ctx.sql`DELETE FROM guest_blacklist WHERE id = ${open!.id}`).rejects.toThrow(/禁止删除/);
    await expect(ctx.sql`UPDATE guest_blacklist SET lift_reason = '再改一次' WHERE id = ${row!.id}`).rejects.toThrow(/不可修改/);
  });
});

describe('发牌前风控 · 未结离店、重复到店、预约', () => {
  it('未结离店：下次发牌要当场授权；授权人、时间、原因记在来访上；授权只能用一次、只管授权的那几位', async () => {
    const m = await createMember(ctx, '未结甲');
    const first = await enter(m.id);
    expect(
      (await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${first.id}/charges`, { clientKey: randomUUID(), customLines: [{ name: '合成消费', amount: 8800 }], expectedTotal: 8800 })).status,
    ).toBe(200);
    // 没有未结离店时不需要授权：申请被拒绝
    expect(err(await grant({ kind: 'checkin', memberIds: [m.id], reason: '先申请一下' }))).toBe('GRANT_NOT_NEEDED');
    const marked = await incident(ctx.clerk, first.id, { kind: 'unsettled', amount: 8800, note: '客人没结账就走了', assigneeId: dutyId });
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    expect(err(await incident(ctx.clerk, first.id, { kind: 'unsettled', amount: 8800, note: '再记一条' }))).toBe('ALREADY_UNSETTLED');
    expect((await risk(m.id)).unsettled).toMatchObject([{ visitId: first.id, tagCode: first.code, amountCents: 8800, note: '客人没结账就走了', createdByName: '测试店员', assigneeName: '值班乙' }]);
    // 原来那张牌结清以后，待办还在：这位下次来要授权
    await settle(first.id);
    const code = nextTag();
    const key = randomUUID();
    const body = { guests: [{ tagCode: code, zone: 'male', memberId: m.id }] };
    const refused = await checkinRaw(ctx.clerk, body, key);
    expect([refused.status, err(refused)]).toEqual([422, 'CHECKIN_RISK_AUTH_REQUIRED']);
    expect(refused.body.error.details.members).toMatchObject([{ memberId: m.id, memberName: '未结甲', debts: [{ tagCode: first.code, amountCents: 8800 }] }]);
    // 值班经理自己发牌也要走一次授权（再输一次自己的密码）
    expect(err(await checkinRaw(duty, body))).toBe('CHECKIN_RISK_AUTH_REQUIRED');

    // 授权人岗位不够、密码不对、范围不对
    expect(err(await grant({ kind: 'checkin', memberIds: [m.id], reason: '客人答应补交' }, { username: 'clerk' }))).toBe('AUTH_NOT_ALLOWED');
    expect((await grant({ kind: 'checkin', memberIds: [m.id], reason: '补' })).status).toBe(400);
    expect((await grant({ kind: 'checkin', memberIds: [m.id], reason: '客人答应补交' }, { cookie: back })).status).toBe(403);
    const other = await createMember(ctx, '未结乙');
    const o1 = await enter(other.id);
    expect((await incident(ctx.clerk, o1.id, { kind: 'unsettled', amount: 100, note: '另一位也欠着' })).status).toBe(200);
    const wrong = await grant({ kind: 'checkin', memberIds: [other.id], reason: '授权的是另一位' });
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(200);
    expect(err(await checkinRaw(ctx.clerk, { ...body, riskGrantId: wrong.body.grantId }, key))).toBe('GRANT_SCOPE');

    const ok = await grant({ kind: 'checkin', memberIds: [m.id], reason: '客人答应今天补交' });
    expect(ok.body).toMatchObject({ purpose: 'checkin_risk', approverName: '值班乙', scope: { kind: 'checkin', memberIds: [m.id], reason: '客人答应今天补交' } });
    // 别人申请的授权不能拿来用
    expect(err(await checkinRaw(duty, { ...body, riskGrantId: ok.body.grantId }))).toBe('GRANT_INVALID');
    const done = await checkinRaw(ctx.clerk, { ...body, riskGrantId: ok.body.grantId }, key);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const v = await visit(done.body.visits[0].id);
    expect(v.riskApproval).toMatchObject({ byName: '值班乙', reason: '客人答应今天补交' });
    expect(v.history.find((h) => h.kind === 'checkin')!.text).toContain('由值班乙当场授权放行：客人答应今天补交');
    const [row] = await ctx.sql<{ riskApprovedBy: number; riskReason: string; usedRef: string }[]>`
      SELECT v.risk_approved_by, v.risk_reason, g.used_ref FROM visits v JOIN auth_grants g ON g.id = ${ok.body.grantId} WHERE v.id = ${v.id}`;
    expect(row).toMatchObject({ riskApprovedBy: dutyId, riskReason: '客人答应今天补交', usedRef: `checkin:${key}` });
    const audit = (await audits('frontdesk_checkin')).find((a) => Number(a.targetId) === v.id)!;
    expect(audit.detail.risk.unsettled).toMatchObject({ members: [m.id], approverId: dutyId, approverName: '值班乙', reason: '客人答应今天补交', grantId: ok.body.grantId });
    // 同一编号重提：返回第一次的结果，不再核销授权
    const again = await checkinRaw(ctx.clerk, { ...body, riskGrantId: ok.body.grantId }, key);
    expect([again.status, again.body.replayed, again.body.visits[0].id]).toEqual([200, true, v.id]);
    // 授权只能用一次
    await settle(v.id);
    expect(err(await checkinRaw(ctx.clerk, { guests: [{ tagCode: nextTag(), zone: 'male', memberId: m.id }], riskGrantId: ok.body.grantId }))).toBe('GRANT_USED');
  });

  it('未结离店的待办由值班经理及以上写处理结果；处理完这位会员发牌不再拦', async () => {
    const list = await todos();
    const mine = list.todos.find((t) => t.kind === 'unsettled' && t.memberName === '未结甲')!;
    expect(mine).toMatchObject({ amountCents: 8800, assigneeName: '值班乙', visitStatus: 'settled', resolved: null });
    expect(list.assignees.map((a) => a.name)).toEqual(expect.arrayContaining(['测试店主', '测试店员', '值班乙']));
    expect(list.assignees.some((a) => a.name === '后勤丁')).toBe(false);
    const resolve = (cookie: string, note: string) => api(ctx.app, cookie, 'POST', `/api/frontdesk/incidents/${mine.id}/resolve`, { note });
    expect((await resolve(ctx.clerk, '客人已补交')).status).toBe(403);
    expect((await resolve(duty, '补')).status).toBe(400);
    const done = await resolve(duty, '客人已补交 88 元');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((done.body as IncidentTodoList).todos.some((t) => t.id === mine.id)).toBe(false);
    expect(err(await resolve(duty, '再写一次'))).toBe('ALREADY_RESOLVED');
    expect(err(await api(ctx.app, duty, 'POST', `/api/frontdesk/incidents/${mine.id}/assign`, { assigneeId: ctx.ownerId }))).toBe('ALREADY_RESOLVED');
    const [m] = await ctx.sql<{ id: number }[]>`SELECT id FROM members WHERE name = '未结甲'`;
    expect((await risk(Number(m!.id))).unsettled).toEqual([]);
    const v = await enter(Number(m!.id));
    expect((await visit(v.id)).riskApproval).toBeNull();
    // 处理结果进了原来那次来访的经办记录
    const old = await visit(mine.visitId);
    expect(old.incidents.find((i) => i.id === mine.id)!.resolved).toMatchObject({ note: '客人已补交 88 元', byName: '值班乙' });
    expect(old.history.some((h) => h.kind === 'incident' && h.text.includes('处理结果：客人已补交 88 元'))).toBe(true);
  });

  it('当日重复到店：只提示（今天第几次、上一次的牌号与离店时间），不拦；审计里留痕', async () => {
    const m = await createMember(ctx, '常客甲');
    expect((await risk(m.id)).visitsToday).toEqual({ count: 0, last: null });
    const a = await enter(m.id);
    expect((await risk(m.id)).visitsToday).toMatchObject({ count: 1, last: { tagCode: a.code, closedAt: null } });
    await settle(a.id);
    const r = await risk(m.id);
    expect(r.visitsToday.count).toBe(1);
    expect(r.visitsToday.last).toMatchObject({ tagCode: a.code });
    expect(r.visitsToday.last!.closedAt).toBeTruthy();
    const b = await enter(m.id);
    const audit = (await audits('frontdesk_checkin')).find((x) => Number(x.targetId) === b.id)!;
    expect(audit.detail.risk.repeats).toEqual([{ memberId: m.id, nth: 2 }]);
    // 撤销的不算
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/visits/${b.id}/cancel`, { reason: '开错牌' })).status).toBe(200);
    expect((await risk(m.id)).visitsToday.count).toBe(1);
  });

  it('预约：今天待到店的带出来；发牌成功后技师预约自动标「已到店」并挂上这张牌，派对房的不自动；重提不重复', async () => {
    const me = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body;
    const tomorrow = new Date(Date.parse(`${me.today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const it = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '风控足疗', category: '足疗', price: 16800, durationMinutes: 60 });
    const itemId = it.body.items.find((i: { name: string }) => i.name === '风控足疗').id as number;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/items', { items: [{ id: itemId, required: true }] })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: 'F1', name: '风控技师', gender: 'female', grade: 'standard' })).status).toBe(200);
    const csv = (rows: string[]) => rows.join('\r\n');
    for (const [kind, rows] of [
      ['zones', ['楼层,区域名(中文),区域名(英文),备注', 'L2,风控娱乐区,Risk Fun,合成样例']],
      ['spaces', ['楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注', 'L2,X,X701,派对房,12,风控派对房,,风控派对房 X701,']],
    ] as const) {
      const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv: csv([...rows]), encoding: 'UTF-8', clientKey: randomUUID() });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const spaceId = ((await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body.spaces as { id: number; code: string }[]).find((s) => s.code === 'X701')!.id;
    const m = await createMember(ctx, '预约甲');
    const slotsOf = async (q: Record<string, string | number>) =>
      (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/slots?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`)).body as { startsAt: string; free: number }[];
    const techSlot = (await slotsOf({ kind: 'technician', date: tomorrow, itemId })).find((s) => s.free > 0)!;
    const spaceSlot = (await slotsOf({ kind: 'space', date: tomorrow, spaceId })).find((s) => s.free > 0)!;
    const book = async (body: Record<string, unknown>) => {
      const r = await api(ctx.app, ctx.clerk, 'POST', '/api/bookings', { clientKey: randomUUID(), memberId: m.id, ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // 用例里约的是明天的时段（今天剩下的时段随钟点变），把这张预约挪到今天这个营业日：只改归属的营业日
      await ctx.sql`UPDATE bookings SET business_date = ${me.today} WHERE id = ${r.body.id}`;
      return r.body.id as number;
    };
    const techBooking = await book({ kind: 'technician', itemId, technicianId: null, startsAt: techSlot.startsAt, note: '要靠窗' });
    const spaceBooking = await book({ kind: 'space', spaceId, startsAt: spaceSlot.startsAt, guests: 6 });
    const cancelled = await book({
      kind: 'technician',
      itemId,
      technicianId: null,
      startsAt: (await slotsOf({ kind: 'technician', date: tomorrow, itemId })).filter((s) => s.free > 0).at(-1)!.startsAt,
    });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/bookings/${cancelled}/change`, { clientKey: randomUUID(), action: 'cancel', reason: '客人改期' })).status).toBe(200);

    const before = await risk(m.id);
    expect(before.bookings.map((b) => [b.id, b.kind, b.what, b.autoArrive, b.note]).sort((x, y) => Number(x[0]) - Number(y[0]))).toEqual([
      [techBooking, 'technician', '风控足疗', true, '要靠窗'],
      [spaceBooking, 'space', '风控派对房', false, ''],
    ]);
    expect(before.bookings.find((b) => b.id === techBooking)!.technicianText).toBe('不指定');

    const code = nextTag();
    const key = randomUUID();
    const body = { guests: [{ tagCode: code, zone: 'male', memberId: m.id }] };
    const done = await checkinRaw(ctx.clerk, body, key);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const [t] = await ctx.sql<{ bookingNo: string }[]>`SELECT booking_no FROM bookings WHERE id = ${techBooking}`;
    expect((done.body as CheckinResult).arrivedBookings).toEqual([{ bookingNo: t!.bookingNo, tagCode: code }]);
    const state = await ctx.sql<{ id: number; status: string; arrivalVisitId: number | null; arrivedBy: number | null; version: number }[]>`
      SELECT id, status, arrival_visit_id, arrived_by, version FROM bookings WHERE id IN ${ctx.sql([techBooking, spaceBooking, cancelled])} ORDER BY id`;
    expect(state.find((b) => Number(b.id) === techBooking)).toMatchObject({ status: 'arrived', arrivalVisitId: done.body.visits[0].id, arrivedBy: ctx.clerkId, version: 2 });
    expect(state.find((b) => Number(b.id) === spaceBooking)).toMatchObject({ status: 'confirmed', arrivalVisitId: null });
    expect(state.find((b) => Number(b.id) === cancelled)).toMatchObject({ status: 'cancelled' });
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/${techBooking}`)).body).toMatchObject({ status: 'arrived', arrivalTagCode: code });
    expect((await audits('booking_arrive')).at(-1)!.detail).toMatchObject({ bookingNo: t!.bookingNo, tagCode: code, via: 'checkin' });
    expect((await audits('frontdesk_checkin')).find((a) => Number(a.targetId) === done.body.visits[0].id)!.detail.risk.bookings).toEqual([t!.bookingNo]);
    // 同一编号重提：第一次的结果，预约没有再改一次
    const again = await checkinRaw(ctx.clerk, body, key);
    expect([again.status, again.body.replayed, again.body.arrivedBookings]).toEqual([200, true, [{ bookingNo: t!.bookingNo, tagCode: code }]]);
    const [v2] = await ctx.sql<{ version: number }[]>`SELECT version FROM bookings WHERE id = ${techBooking}`;
    expect(v2!.version).toBe(2);
    // 已经到店的，「预约」页再点到店被拒绝；派对房的照旧在那里点到店
    expect(err(await api(ctx.app, ctx.clerk, 'POST', `/api/bookings/${techBooking}/change`, { clientKey: randomUUID(), action: 'arrive', tagCode: code }))).toBe('BOOKING_CLOSED');
    expect((await risk(m.id)).bookings.map((b) => b.id)).toEqual([spaceBooking]);
  });

  it('预约改期与发牌同时来：发牌等改期提交以后按最新的营业日核对，改到明天的不标到店、不挂这张牌（Codex 审查 f6327a4）', async () => {
    const me = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body as { today: string };
    const tomorrow = new Date(Date.parse(`${me.today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const it = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '改期足疗', category: '足疗', price: 16800, durationMinutes: 60 });
    const itemId = it.body.items.find((i: { name: string }) => i.name === '改期足疗').id as number;
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/items', { items: [{ id: itemId, required: true }] })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: 'F8', name: '改期技师', gender: 'female', grade: 'standard' })).status).toBe(200);
    const m = await createMember(ctx, '改期乙');
    const slots = (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/slots?kind=technician&date=${tomorrow}&itemId=${itemId}`)).body as { startsAt: string; free: number }[];
    const made = await api(ctx.app, ctx.clerk, 'POST', '/api/bookings', {
      clientKey: randomUUID(),
      memberId: m.id,
      kind: 'technician',
      itemId,
      technicianId: null,
      startsAt: slots.find((s) => s.free > 0)!.startsAt,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const bookingId = made.body.id as number;
    // 约的是明天的时段，先挪到今天这个营业日：发牌读到的是「今天待到店」
    await ctx.sql`UPDATE bookings SET business_date = ${me.today} WHERE id = ${bookingId}`;
    expect((await risk(m.id)).bookings.map((b) => b.id)).toEqual([bookingId]);
    const [row] = await ctx.sql<{ status: string }[]>`SELECT status FROM bookings WHERE id = ${bookingId}`;
    const before = row!.status;
    expect(['pending', 'confirmed']).toContain(before);

    // 改期的事务先拿着这张预约的行锁（只改营业日、状态照旧，与预约页改期一样），发牌读到的还是今天的、卡在锁预约上
    let updated!: () => void;
    let release!: () => void;
    const didUpdate = new Promise<void>((r) => (updated = r));
    const gate = new Promise<void>((r) => (release = r));
    const reschedule = ctx.sql.begin(async (t1) => {
      await t1`UPDATE bookings SET business_date = ${tomorrow}, version = version + 1 WHERE id = ${bookingId}`;
      updated();
      await gate;
    });
    await didUpdate;
    const code = nextTag();
    const pending = checkinRaw(ctx.clerk, { guests: [{ tagCode: code, zone: 'male', memberId: m.id }] });
    for (let i = 0; ; i++) {
      const rows = await ctx.sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${'%FROM bookings%FOR UPDATE%'}`;
      if (rows.length > 0) break;
      if (i > 100) throw new Error('发牌没有卡在锁预约上');
      await new Promise((r) => setTimeout(r, 30));
    }
    release();
    await reschedule;
    const done = await pending;
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect((done.body as CheckinResult).arrivedBookings).toEqual([]);
    const [b] = await ctx.sql<{ status: string; businessDate: string; arrivalVisitId: number | null }[]>`
      SELECT status, business_date::text AS business_date, arrival_visit_id FROM bookings WHERE id = ${bookingId}`;
    // 预约原样不动：状态还是原来的（没有标到店），营业日是改到的明天，没有挂上这张牌
    expect(b).toEqual({ status: before, businessDate: tomorrow, arrivalVisitId: null });
  });

  it('同一编号并发两次：只发一次牌；两位客人同时发同一张牌：一位成功、一位被告知已在店', async () => {
    const m = await createMember(ctx, '并发甲');
    const code = nextTag();
    const key = randomUUID();
    const body = { guests: [{ tagCode: code, zone: 'male', memberId: m.id }] };
    const [a, b] = await Promise.all([checkinRaw(ctx.clerk, body, key), checkinRaw(ctx.clerk, body, key)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.visits[0].id).toBe(b.body.visits[0].id);
    const same = nextTag();
    const m2 = await createMember(ctx, '并发乙');
    const [x, y] = await Promise.all([checkinRaw(ctx.clerk, { guests: [{ tagCode: same, zone: 'male', memberId: m2.id }] }), checkinRaw(duty, { guests: [{ tagCode: same, zone: 'male' }] })]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(err(x.status === 409 ? x : y)).toBe('TAG_OCCUPIED');
    const [count] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${same} AND v.status = 'open'`;
    expect(count!.n).toBe(1);
  });

  it('登记黑名单与发牌同时来：要么发牌在前（照常发出），要么黑名单在前（发牌被拒绝），不会登记成功了还发出去', async () => {
    for (let i = 0; i < 4; i++) {
      const m = await createMember(ctx, `赛跑${i}`);
      const code = nextTag();
      const [b, c] = await Promise.all([blacklist(duty, { memberId: m.id, reason: '同时登记' }), checkinRaw(ctx.clerk, { guests: [{ tagCode: code, zone: 'male', memberId: m.id }] })]);
      expect(b.status).toBe(201);
      if (c.status === 201) {
        // 发牌先提交：黑名单在它之后登记，登记时刻不早于发牌时刻
        const [row] = await ctx.sql<{ ok: boolean }[]>`
          SELECT b.created_at >= v.checked_in_at AS ok FROM guest_blacklist b, visits v WHERE b.id = ${b.body.id} AND v.id = ${c.body.visits[0].id}`;
        expect(row!.ok).toBe(true);
      } else {
        expect(err(c)).toBe('GUEST_BLACKLISTED');
      }
    }
  });

  it('补录纸质单不查风控（客人早已按纸质单进过店）', async () => {
    const m = await createMember(ctx, '补录甲');
    expect((await blacklist(duty, { memberId: m.id, reason: '补录前登记' })).status).toBe(201);
    const r = await checkinRaw(duty, { guests: [{ tagCode: nextTag(), zone: 'male', memberId: m.id }], backfill: { slipNo: 'RK-0001', at: new Date(Date.now() - 30 * 60_000).toISOString() } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('开关关掉：发牌与以前一样（不查黑名单、不拦未结离店、不带预约）；只有店主能改开关', async () => {
    expect((await api(ctx.app, duty, 'PUT', '/api/frontdesk/risk-rules', { enabled: false })).status).toBe(403);
    const off = await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/risk-rules', { enabled: false });
    expect(off.body).toEqual({ enabled: false });
    expect((await board()).risk.enabled).toBe(false);
    const m = await createMember(ctx, '关着甲');
    expect((await blacklist(duty, { memberId: m.id, reason: '关着也能登记' })).status).toBe(201);
    expect(await risk(m.id)).toMatchObject({ enabled: false, blacklist: null, unsettled: [], bookings: [] });
    expect(err(await grant({ kind: 'checkin', memberIds: [m.id], reason: '关着不用授权' }))).toBe('GRANT_NOT_NEEDED');
    const v = await enter(m.id);
    expect((await visit(v.id)).status).toBe('open');
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/frontdesk/risk-rules', { enabled: true })).body).toEqual({ enabled: true });
    expect((await board()).risk.enabled).toBe(true);
    expect((await risk(m.id)).blacklist).toBeTruthy();
  });
});

describe('发牌后的异常处置', () => {
  it('提醒：记一条「已提醒」，进经办记录；同一编号重提不重复；编号用在别的内容上拒绝；没有发牌挂账权限的不能记', async () => {
    const v = await enter(null);
    const key = randomUUID();
    expect((await incident(back, v.id, { kind: 'remind', note: '已电话提醒' })).status).toBe(403);
    const a = await incident(ctx.clerk, v.id, { kind: 'remind', note: '已到休息区当面提醒' }, key);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect((a.body as VisitDetail).incidents).toMatchObject([{ kind: 'remind', note: '已到休息区当面提醒', createdByName: '测试店员', amountCents: null, resolved: null }]);
    expect((a.body as VisitDetail).history.some((h) => h.kind === 'incident' && h.text === '异常 · 已提醒（已到休息区当面提醒）')).toBe(true);
    const again = await incident(ctx.clerk, v.id, { kind: 'remind', note: '已到休息区当面提醒' }, key);
    expect(again.status).toBe(200);
    expect((again.body as VisitDetail).incidents).toHaveLength(1);
    expect(err(await incident(ctx.clerk, v.id, { kind: 'remind', note: '换了内容' }, key))).toBe('IDEMPOTENCY_CONFLICT');
    // 备注可以不写；种类不对、上报不写情况都拒绝
    expect((await incident(ctx.clerk, v.id, { kind: 'remind' })).status).toBe(200);
    expect((await incident(ctx.clerk, v.id, { kind: 'lost' })).status).toBe(400);
    expect((await incident(ctx.clerk, v.id, { kind: 'report', note: '' })).status).toBe(400);
    expect((await audits('visit_incident')).at(-1)!.detail).toMatchObject({ kind: 'remind', tagCode: v.code });
  });

  it('临时外出 / 返回：手牌板上写着外出，牌照旧占着、不能发给别人；回来点返回', async () => {
    const v = await enter(null);
    const away = await incident(ctx.clerk, v.id, { kind: 'away', note: '出去吃饭' });
    expect(away.status, JSON.stringify(away.body)).toBe(200);
    expect((away.body as VisitDetail).awaySince).toBeTruthy();
    expect((await board()).tags.find((t) => t.code === v.code)!.visit!.awaySince).toBeTruthy();
    expect(err(await incident(ctx.clerk, v.id, { kind: 'away' }))).toBe('ALREADY_AWAY');
    expect(err(await checkinRaw(ctx.clerk, { guests: [{ tagCode: v.code, zone: 'male' }] }))).toBe('TAG_OCCUPIED');
    const back2 = await incident(ctx.clerk, v.id, { kind: 'return' });
    expect((back2.body as VisitDetail).awaySince).toBeNull();
    expect((await board()).tags.find((t) => t.code === v.code)!.visit!.awaySince).toBeNull();
    expect(err(await incident(ctx.clerk, v.id, { kind: 'return' }))).toBe('NOT_AWAY');
    expect((back2.body as VisitDetail).incidents.map((i) => i.kind)).toEqual(['away', 'return']);
    // 外出着也能照常结账离店
    expect((await incident(ctx.clerk, v.id, { kind: 'away' })).status).toBe(200);
    await settle(v.id);
    expect(err(await incident(ctx.clerk, v.id, { kind: 'return' }))).toBe('VISIT_CLOSED');
  });

  it('超时加收：值班经理直接加，店员要当场授权；就是一条手动金额的明细，结账时一起收；重提不重复挂', async () => {
    const v = await enter(null);
    const noAuth = await incident(ctx.clerk, v.id, { kind: 'surcharge', amount: 5000, note: '超 12 小时加收' });
    expect([noAuth.status, err(noAuth)]).toEqual([422, 'SURCHARGE_AUTH_REQUIRED']);
    expect((await incident(duty, v.id, { kind: 'surcharge', amount: 0, note: '金额不对' })).status).toBe(400);
    expect((await incident(duty, v.id, { kind: 'surcharge', amount: 5000, note: '' })).status).toBe(400);
    expect((await incident(duty, v.id, { kind: 'surcharge', amount: 1_000_001_00, note: '太大了' })).status).toBe(400);

    const key = randomUUID();
    const direct = await incident(duty, v.id, { kind: 'surcharge', amount: 5000, note: '超 12 小时加收' }, key);
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);
    const d = direct.body as VisitDetail;
    expect(d.bill.amountCents).toBe(5000);
    const line = d.lines.find((l) => l.status === 'active')!;
    expect(line).toMatchObject({ name: '超时加收', source: 'bath', itemId: null, amount: 5000, quantity: 1, postedByName: '值班乙', postKey: key });
    expect(d.incidents).toMatchObject([{ kind: 'surcharge', amountCents: 5000, note: '超 12 小时加收', approvedByName: null, createdByName: '值班乙' }]);
    expect((await incident(duty, v.id, { kind: 'surcharge', amount: 5000, note: '超 12 小时加收' }, key)).status).toBe(200);
    expect((await visit(v.id)).bill).toMatchObject({ amountCents: 5000, lineCount: 1 });
    const [row] = await ctx.sql<{ billLineId: number; opType: string }[]>`
      SELECT i.bill_line_id, k.op_type FROM visit_incidents i JOIN idempotency_keys k ON k.key = i.op_key WHERE i.op_key = ${key}`;
    expect(row).toMatchObject({ billLineId: line.id, opType: 'visit_incident' });

    // 店员：先请值班经理授权（绑定这次来访与金额）
    expect(err(await grant({ kind: 'surcharge', visitId: v.id, amount: 3000, reason: '再加收' }, { cookie: duty }))).toBe('GRANT_NOT_NEEDED');
    const g = await grant({ kind: 'surcharge', visitId: v.id, amount: 3000, reason: '超 24 小时再加收' });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(err(await incident(ctx.clerk, v.id, { kind: 'surcharge', amount: 3500, note: '金额改了', grantId: g.body.grantId }))).toBe('GRANT_SCOPE');
    expect((await visit(v.id)).bill.amountCents).toBe(5000);
    const granted = await incident(ctx.clerk, v.id, { kind: 'surcharge', amount: 3000, note: '超 24 小时再加收', grantId: g.body.grantId });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect((granted.body as VisitDetail).bill).toMatchObject({ amountCents: 8000, lineCount: 2 });
    expect((granted.body as VisitDetail).incidents.at(-1)).toMatchObject({ kind: 'surcharge', amountCents: 3000, approvedByName: '值班乙', createdByName: '测试店员' });
    expect((granted.body as VisitDetail).history.some((h) => h.text === '异常 · 超时加收（¥30.00，超 24 小时再加收，由值班乙当场授权）')).toBe(true);
    expect(err(await incident(ctx.clerk, v.id, { kind: 'surcharge', amount: 3000, note: '授权用过了', grantId: g.body.grantId }))).toBe('GRANT_USED');
    // 发牌用的授权不能拿来加收
    for (const k of await selfCheck()) expect(k, k.detail).toMatchObject({ ok: true });
    // 结账时一起收：应收里有这两笔
    const total = await settle(v.id);
    expect(total).toBeGreaterThanOrEqual(8000);
    for (const k of await selfCheck()) expect(k, k.detail).toMatchObject({ ok: true });
  });

  it('上报：指给一位责任人，进「异常待办」；能改派、能写处理结果（只能写一次）；手牌板上数得出', async () => {
    const v = await enter(null);
    const before = (await board()).risk.openTodos;
    const r = await incident(ctx.clerk, v.id, { kind: 'report', note: '客人在大厅睡了一夜，叫不醒', assigneeId: dutyId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(err(await incident(ctx.clerk, v.id, { kind: 'report', note: '指给不存在的人', assigneeId: 999999 }))).toBe('ASSIGNEE_INVALID');
    const b = await board();
    expect(b.risk.openTodos).toBe(before + 1);
    expect(b.tags.find((t) => t.code === v.code)!.visit!.openTodos).toBe(1);
    expect((await api(ctx.app, back, 'GET', '/api/frontdesk/incidents/todos')).status).toBe(403);
    const todo = (await todos()).todos.find((t) => t.visitId === v.id)!;
    expect(todo).toMatchObject({ kind: 'report', tagCode: v.code, visitStatus: 'open', note: '客人在大厅睡了一夜，叫不醒', assigneeId: dutyId, assigneeName: '值班乙', createdByName: '测试店员' });

    const assign = (cookie: string, id: number, to: number) => api(ctx.app, cookie, 'POST', `/api/frontdesk/incidents/${id}/assign`, { assigneeId: to });
    expect((await assign(back, todo.id, ctx.ownerId)).status).toBe(403);
    expect(err(await assign(ctx.clerk, todo.id, 999999))).toBe('ASSIGNEE_INVALID');
    const moved = await assign(ctx.clerk, todo.id, ctx.ownerId);
    expect((moved.body as IncidentTodoList).todos.find((t) => t.id === todo.id)).toMatchObject({ assigneeId: ctx.ownerId, assigneeName: '测试店主' });
    // 已经是这位：不重复记
    expect((await assign(ctx.clerk, todo.id, ctx.ownerId)).status).toBe(200);
    const [count] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM visit_incident_events WHERE incident_id = ${todo.id} AND action = 'assign'`;
    expect(count!.n).toBe(1);
    // 提醒不是待办：不能指派
    const [remind] = await ctx.sql<{ id: number }[]>`SELECT id FROM visit_incidents WHERE kind = 'remind' LIMIT 1`;
    expect(err(await assign(ctx.clerk, Number(remind!.id), ctx.ownerId))).toBe('NOT_TODO');
    expect((await assign(ctx.clerk, 99999999, ctx.ownerId)).status).toBe(404);

    // 上报的处理结果店员就能写；两个人同时写只有一个成
    const resolve = (cookie: string, note: string) => api(ctx.app, cookie, 'POST', `/api/frontdesk/incidents/${todo.id}/resolve`, { note });
    const [x, y] = await Promise.all([resolve(ctx.clerk, '已叫醒，客人去结账了'), resolve(duty, '已处理')]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(err(x.status === 409 ? x : y)).toBe('ALREADY_RESOLVED');
    expect((await todos()).todos.some((t) => t.id === todo.id)).toBe(false);
    const after = await board();
    expect(after.risk.openTodos).toBe(before);
    expect(after.tags.find((t) => t.code === v.code)!.visit!.openTodos).toBe(0);
    const detail = await visit(v.id);
    expect(detail.incidents.find((i) => i.id === todo.id)!.resolved).toBeTruthy();
    expect(detail.history.filter((h) => h.kind === 'incident').map((h) => h.text)).toEqual(expect.arrayContaining(['异常 · 上报（客人在大厅睡了一夜，叫不醒）', '异常 · 上报指给测试店主']));
    expect((await audits('incident_assigned')).at(-1)!.detail).toMatchObject({ incidentId: todo.id, assigneeId: ctx.ownerId });
    expect((await audits('incident_resolved')).at(-1)!.detail).toMatchObject({ incidentId: todo.id, kind: 'report' });
  });

  it('结果待确认：按编号查回这次来访；作废过的编号再登记被拒绝；没有前台权限的人不能作废', async () => {
    const v = await enter(null);
    const key = randomUUID();
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=visit_incident`)).body).toEqual({ found: false, abandoned: false });
    expect((await incident(ctx.clerk, v.id, { kind: 'remind', note: '查回用' }, key)).status).toBe(200);
    const found = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=visit_incident`);
    expect(found.body).toMatchObject({ found: true, type: 'visit_incident', visit: { id: v.id } });
    // 已经生效的编号作废不了：返回查回的结果
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${key}/abandon`, { type: 'visit_incident' })).body).toMatchObject({ found: true, type: 'visit_incident' });
    const dead = randomUUID();
    expect((await api(ctx.app, back, 'POST', `/api/frontdesk/ops/${dead}/abandon`, { type: 'visit_incident' })).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${dead}/abandon`, { type: 'visit_incident' })).body).toEqual({ found: false, abandoned: true });
    expect(err(await incident(ctx.clerk, v.id, { kind: 'remind', note: '作废以后再提' }, dead))).toBe('OP_ABANDONED');
    // 加收也一样：作废以后原请求迟到不会挂上账
    const dead2 = randomUUID();
    expect((await api(ctx.app, duty, 'POST', `/api/frontdesk/ops/${dead2}/abandon`, { type: 'visit_incident' })).body).toEqual({ found: false, abandoned: true });
    expect(err(await incident(duty, v.id, { kind: 'surcharge', amount: 2000, note: '作废以后再提' }, dead2))).toBe('OP_ABANDONED');
    expect((await visit(v.id)).bill.amountCents).toBe(0);
    // 别的类型的作废拦不住这一类（类型要对得上）
    const other = randomUUID();
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/frontdesk/ops/${other}/abandon`, { type: 'bill_post' })).body).toEqual({ found: false, abandoned: true });
    expect((await incident(ctx.clerk, v.id, { kind: 'remind', note: '类型对不上的作废不拦' }, other)).status).toBe(200);
  });

  it('来访不存在、已离店的不能再记；异常与处理记录数据库只追加', async () => {
    expect((await incident(ctx.clerk, 99999999, { kind: 'remind' })).status).toBe(422);
    const v = await enter(null);
    await settle(v.id);
    expect(err(await incident(ctx.clerk, v.id, { kind: 'remind' }))).toBe('VISIT_CLOSED');
    expect(err(await incident(duty, v.id, { kind: 'surcharge', amount: 1000, note: '离店以后' }))).toBe('VISIT_CLOSED');
    const [i] = await ctx.sql<{ id: number }[]>`SELECT id FROM visit_incidents ORDER BY id LIMIT 1`;
    await expect(ctx.sql`UPDATE visit_incidents SET note = '改掉' WHERE id = ${i!.id}`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM visit_incidents WHERE id = ${i!.id}`).rejects.toThrow();
    const [e] = await ctx.sql<{ id: number }[]>`SELECT id FROM visit_incident_events ORDER BY id LIMIT 1`;
    await expect(ctx.sql`UPDATE visit_incident_events SET note = '改掉' WHERE id = ${e!.id}`).rejects.toThrow();
    await expect(ctx.sql`DELETE FROM visit_incident_events WHERE id = ${e!.id}`).rejects.toThrow();
    for (const k of await selfCheck()) expect(k, k.detail).toMatchObject({ ok: true });
  });
});
