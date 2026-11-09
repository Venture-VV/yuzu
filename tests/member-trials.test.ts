// 会员体系 v2 第三期（v0.7.25，docs/MEMBERSHIP_P3.md 第 3 节）：邀请体验与赠送会籍（临时身份）。
//   · 邀请体验：L2 起、每月 1 次（会员规则），给对方「自己的档级 − 1」的初阶 7 天；同一编号重提返回原来那条；
//   · 受邀人：档级要低于体验的、同一时间一个、12 个月内一次（撤销的不算）、不能邀请自己；还不是会员的当场建档；
//   · 享什么：服务类与登记使用、折扣、VIP 柜按取高的；券类、事件礼只按自己的；
//   · 赠送会籍：QY-042 发布后按起点（L3·尊）、周期与上限占次数，同一事务登记一次使用；不能单独登记、不能单独作废；
//   · 结束：撤销（店主、店总，赠送的一并作废使用登记、次数腾出来）、到期（每天的到期处理）、转正（自己充值升到体验的档级）；
//   · 结果待确认：查回、确认作废后原请求不生效；自检。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Benefit, BenefitCatalog, MemberBenefits } from '../src/shared/benefits';
import { shiftDate } from '../src/shared/labels';
import { rechargeOutcome, type MemberGradeBadge, type MemberGradeInfo, type MembershipRules } from '../src/shared/membership';
import { inviteeAgainFrom, trialEndsOn, type MemberTrials, type TrialOptions, type TrialRow } from '../src/shared/trials';
import { membershipChecks, runMembershipDaily } from '../src/server/modules/membership';
import { trialChecks, trialOptions } from '../src/server/modules/member-trials';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let today: string;
/** 第一组邀请的受邀人（后面几组接着用） */
let guest: number;

const yuan = (n: number) => Math.round(n * 100);

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
const publish = async (code: string) => {
  const b = await byCode(code);
  const r = await api(ctx.app, ctx.owner, 'POST', `/api/benefits/${b.id}/status`, { expectedVersion: b.version, status: 'published' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Benefit;
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
const phones = new Map<number, string>();
/** 新会员充到给定金额（L1 = 5 千、L2 = 1 万、L3 = 3 万、L4 = 5 万） */
const member = async (name: string, paidYuan: number) => {
  phoneNo += 1;
  const phone = `1994444${String(phoneNo).padStart(4, '0')}`;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/members', { name, phone });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.id as number;
  phones.set(id, phone);
  if (paidYuan > 0) await recharge(id, yuan(paidYuan));
  return id;
};
const phoneOf = (id: number) => phones.get(id)!;
const options = async (inviterId: number, phone?: string) => {
  const r = await api(ctx.app, ctx.clerk, 'GET', `/api/members/${inviterId}/trial-options${phone ? `?phone=${phone}` : ''}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as TrialOptions;
};
const create = (inviterId: number, body: { kind: 'invite' | 'gift'; phone: string; clientKey?: string; name?: string; channel?: string }, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', `/api/members/${inviterId}/trials`, { clientKey: body.clientKey ?? randomUUID(), ...body });
const trialsOf = async (memberId: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/trials`)).body as MemberTrials;
const benefitsOf = async (memberId: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/members/${memberId}/benefits`)).body as MemberBenefits;
const cancel = (trialId: number, reason: string, cookie = ctx.owner) => api(ctx.app, cookie, 'POST', `/api/member-trials/${trialId}/cancel`, { reason });
const allChecksOk = async () => {
  for (const c of [...(await trialChecks(ctx.sql)), ...(await membershipChecks(ctx.sql))]) {
    if (c.label.includes('自动任务')) continue;
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
};

beforeAll(async () => {
  ctx = await setup();
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  // 首充、续充最低放到 1,000（只为凑档方便）；VIP 柜按档级 0–5 级（看得出临时身份取高的）
  const r = await rules();
  const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', {
    ...r,
    firstRechargeMinCents: yuan(1000),
    topUpMinCents: yuan(1000),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  // VIP 柜 8.0.4 起归「会员权益 → VIP 柜」
  const vip = await api(ctx.app, ctx.owner, 'PUT', '/api/vip-lockers', { levels: [0, 1, 2, 3, 4, 5, 5], overrideEnabled: false });
  expect(vip.status, JSON.stringify(vip.body)).toBe(200);
  expect(saved.body).toMatchObject({ trialInviteDays: 7, trialInvitesPerMonth: 1, trialInviteeMonths: 12 });
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/benefits/import')).status).toBe(200);
});
afterAll(async () => {
  await ctx?.close();
});

describe('邀请体验（M52）', () => {
  let l3: number;
  let trial: TrialRow;

  it('L2 起才能邀请；给对方「自己的档级 − 1」的初阶 7 天；同一编号重提返回原来那条；本月第二次被拒', async () => {
    const l1 = await member('云涧会员', 5000);
    l3 = await member('观澜邀请人', 30000);
    guest = await member('受邀客人', 0);
    expect((await gradeOf(l1)).state.grade).toBe(1);
    expect((await gradeOf(l3)).state.grade).toBe(3);

    const no = await options(l1, phoneOf(guest));
    expect(no.invite.allowed).toBe(false);
    expect(no.invite.reason).toContain('L2 起');
    const refused = await create(l1, { kind: 'invite', phone: phoneOf(guest) });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('TRIAL_NOT_ALLOWED');

    const o = await options(l3, phoneOf(guest));
    expect(o.own.grade).toBe(3);
    expect(o.invite).toMatchObject({ allowed: true, grade: 2, endsOn: shiftDate(today, 6), used: 0, limit: 1 });
    expect(o.invitee).toMatchObject({ exists: true, memberId: guest, problems: { invite: null } });

    const key = randomUUID();
    const c = await create(l3, { clientKey: key, kind: 'invite', phone: phoneOf(guest) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    trial = c.body.trial as TrialRow;
    expect(trial).toMatchObject({ kind: 'invite', grade: 2, tier: 0, startsOn: today, endsOn: shiftDate(today, 6), memberId: guest, inviterId: l3, status: 'active', benefitUseId: null });
    expect(trial.label).toContain('L2');
    const again = await create(l3, { clientKey: key, kind: 'invite', phone: phoneOf(guest) });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, trial: { id: trial.id } });
    expect((await create(l3, { clientKey: key, kind: 'gift', phone: phoneOf(guest) })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    expect((await trialsOf(guest)).active).toMatchObject({ id: trial.id });
    expect((await trialsOf(l3)).sent.map((t) => t.id)).toEqual([trial.id]);

    const other = await member('另一位客人', 0);
    const second = await create(l3, { kind: 'invite', phone: phoneOf(other) });
    expect(second.status).toBe(422);
    expect(second.body.error.message).toContain('本月已邀请 1 次');
    expect((await options(l3)).invite).toMatchObject({ allowed: false, used: 1, limit: 1 });
  });

  it('享什么：服务类按体验的档阶（QY-001 L2·初 能登记）；券类只按自己的；VIP 柜取高的、徽标仍是自己的档阶', async () => {
    await publish('QY-001');
    const qy001 = await byCode('QY-001');
    const use = await api(ctx.app, ctx.clerk, 'POST', `/api/members/${guest}/benefit-uses`, { clientKey: randomUUID(), benefitId: qy001.id });
    expect(use.status, JSON.stringify(use.body)).toBe(201);
    const mine = await benefitsOf(guest);
    expect(mine.state.grade).toBe(2);
    expect(mine.items.map((i) => i.code)).toContain('QY-001');

    // 券类按自己的档阶（L0）：L2·初 起的月度券不发、不列
    const tpl = await api(ctx.app, ctx.owner, 'POST', '/api/coupons/templates', { clientKey: randomUUID(), name: '按摩券', kind: 'cash', faceValue: 5000, validity: 'days', validDays: 30 });
    expect(tpl.status, JSON.stringify(tpl.body)).toBe(200);
    await edit('QY-040', { templateId: tpl.body.id, quantity: 1 });
    await publish('QY-040');
    const [g] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM benefit_grants WHERE member_id = ${guest}`;
    expect(g!.n).toBe(0);
    const after = await benefitsOf(guest);
    expect(after.items.map((i) => i.code)).not.toContain('QY-040');
    expect(after.upcoming.map((i) => i.code)).toContain('QY-040');

    const badge = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/members/${guest}/grade`)).body as MemberGradeBadge;
    expect(badge).toMatchObject({ grade: 0, lockerLevel: 2, trial: { grade: 2, kind: 'invite', endsOn: shiftDate(today, 6) } });
  });
});

describe('受邀人的限制', () => {
  let l4: number;

  it('档级不低于体验的、已在体验中、自己，都被拒；还不是会员的当场建档（L0、渠道），只问姓名', async () => {
    l4 = await member('望岳邀请人', 50000);
    const strong = await member('观澜受邀', 30000);
    const o = await options(l4, phoneOf(strong));
    expect(o.invite.grade).toBe(3);
    expect(o.invitee).toMatchObject({ exists: true, problems: { invite: expect.stringContaining('不低于体验的') } });
    expect((await create(l4, { kind: 'invite', phone: phoneOf(strong) })).body.error.code).toBe('TRIAL_INVITEE');

    const busy = await options(l4, phoneOf(guest));
    expect(busy.invitee).toMatchObject({ exists: true, problems: { invite: expect.stringContaining('已经在体验中') } });

    const self = await create(l4, { kind: 'invite', phone: phoneOf(l4) });
    expect(self.body.error.code).toBe('TRIAL_SELF');

    const newPhone = '19955550001';
    expect((await options(l4, newPhone)).invitee).toEqual({ exists: false, problems: { invite: null, gift: null } });
    const noName = await create(l4, { kind: 'invite', phone: newPhone });
    expect(noName.status).toBe(400);
    expect(noName.body.error.message).toContain('请填写姓名');
    const made = await create(l4, { kind: 'invite', phone: newPhone, name: '新客人', channel: 'c5' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.trial).toMatchObject({ grade: 3, memberName: '新客人' });
    const [m] = await ctx.sql<{ grade: number; channel: string; principalBalance: number }[]>`
      SELECT grade, channel, principal_balance FROM members WHERE phone = ${newPhone}`;
    expect(m).toMatchObject({ grade: 0, channel: 'c5', principalBalance: 0 });
  });

  it('撤销（店主、店总）：写原因，之后能再被邀请；到期的（每天的到期处理）仍算 12 个月内一次', async () => {
    const guestId = guest;
    const active = (await trialsOf(guestId)).active!;
    expect((await cancel(active.id, '登记错了人', ctx.clerk)).status).toBe(403);
    const done = await cancel(active.id, '登记错了人');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: 'cancelled', endedOn: today, endReason: '登记错了人' });
    expect((await cancel(active.id, '再撤一次')).status).toBe(200);
    expect((await trialsOf(guestId)).active).toBeNull();
    // VIP 柜回到自己的档级
    expect(((await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/members/${guestId}/grade`)).body as MemberGradeBadge).lockerLevel).toBe(0);

    // 撤销的不算：另一位邀请人再邀请
    const l2 = await member('潭影邀请人', 10000);
    const again = await create(l2, { kind: 'invite', phone: phoneOf(guestId) });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.trial.grade).toBe(1);

    // 到期：一条 20 天前开始、14 天前结束的（直接写库），每天的到期处理记「体验到期」（结束日的下一天）
    const old = await member('早先受邀', 0);
    await ctx.sql`
      INSERT INTO member_trials (member_id, kind, grade, tier, starts_on, ends_on, inviter_id, business_date, staff_id, client_key, request_hash)
      VALUES (${old}, 'invite', 2, 0, ${shiftDate(today, -20)}, ${shiftDate(today, -14)}, ${l2}, ${shiftDate(today, -20)}, ${ctx.ownerId}, ${randomUUID()}, ${'a'.repeat(64)})`;
    expect((await benefitsOf(old)).state.grade).toBe(0);
    const run = await runMembershipDaily({ sql: ctx.sql, config: ctx.config });
    expect(run?.trialsExpired).toBe(1);
    const [t] = await ctx.sql<{ status: string; endedOn: string }[]>`SELECT status, ended_on FROM member_trials WHERE member_id = ${old}`;
    expect(t).toEqual({ status: 'expired', endedOn: shiftDate(today, -13) });
    const l3b = await member('观澜邀请人二', 30000);
    const o = await options(l3b, phoneOf(old));
    expect(o.invitee).toMatchObject({ exists: true, problems: { invite: expect.stringContaining('12 个月内已被邀请或赠送过') } });
    expect((await create(l3b, { kind: 'invite', phone: phoneOf(old) })).body.error.code).toBe('TRIAL_INVITEE');
    await allChecksOk();
  });
});

// 受邀间隔（Codex 评审 24f6862）：发起时的核对与页面写的「X 起才能再次」用同一个日期——上一次开始那天加 N 个月，
// 月底落在那个月的最后一天。原来按「今天减 N 个月」反推，月底开始的要比写的日期多等一天
describe('受邀间隔：上一次开始那天加 N 个月起才能再次', () => {
  it('月底落在那个月的最后一天；平常的日子是同一天', () => {
    expect(inviteeAgainFrom('2027-01-31', 1)).toBe('2027-02-28');
    expect(inviteeAgainFrom('2028-01-31', 1)).toBe('2028-02-29');
    expect(inviteeAgainFrom('2027-03-31', 1)).toBe('2027-04-30');
    expect(inviteeAgainFrom('2028-02-29', 12)).toBe('2029-02-28');
    expect(inviteeAgainFrom('2027-01-15', 1)).toBe('2027-02-15');
  });

  it('间隔 1 个月、上一次在月底开始：页面写的那一天就能再次邀请，前一天仍被拒并写明那一天', async () => {
    // 今天以后第一个「下个月没有这一天」的月底（例如 10 月 31 日，下个月只到 30 日），那天开始过一次体验（已到期）
    const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    let start = today;
    for (;;) {
      const [y, m] = start.split('-').map(Number) as [number, number];
      if (Number(monthEnd(y, m + 1).slice(8)) < Number(monthEnd(y, m).slice(8))) {
        start = monthEnd(y, m);
        break;
      }
      start = shiftDate(monthEnd(y, m), 1);
    }
    const [sy, sm] = start.split('-').map(Number) as [number, number];
    const againOn = monthEnd(sy, sm + 1);
    const inviter = await member('月底邀请人', 30000);
    const friend = await member('月底受邀', 0);
    await ctx.sql`
      INSERT INTO member_trials (member_id, kind, grade, tier, starts_on, ends_on, inviter_id, business_date, staff_id, client_key, request_hash, status, ended_on)
      VALUES (${friend}, 'invite', 2, 0, ${start}, ${shiftDate(start, 6)}, ${inviter}, ${start}, ${ctx.ownerId}, ${randomUUID()}, ${'b'.repeat(64)},
              'expired', ${shiftDate(start, 7)})`;
    const saved = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...(await rules()), trialInviteeMonths: 1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    try {
      const before = await trialOptions(ctx.sql, inviter, shiftDate(againOn, -1), phoneOf(friend));
      expect(before.invite.allowed).toBe(true);
      expect(before.invitee?.problems.invite).toBe(`1 个月内已被邀请或赠送过（${start} 开始），${againOn} 起才能再次`);
      const onDay = await trialOptions(ctx.sql, inviter, againOn, phoneOf(friend));
      expect(onDay.invite.allowed).toBe(true);
      expect(onDay.invitee?.problems.invite).toBeNull();
    } finally {
      const back = await api(ctx.app, ctx.owner, 'PUT', '/api/membership/rules', { ...(await rules()), trialInviteeMonths: 12 });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
    }
  });
});

describe('赠送会籍（QY-042，M53）', () => {
  let giver: number;
  let friend: number;
  let gift: TrialRow;

  it('QY-042 没发布不能赠送；起点 L3·尊；按周期与上限，同一事务给赠送人登记一次使用；一个月', async () => {
    giver = await member('望岳赠送人', 50000);
    friend = await member('受赠客人', 0);
    expect((await options(giver, phoneOf(friend))).gift.reason).toContain('还没发布');

    await edit('QY-042', { period: 'year', quantity: 1 });
    await publish('QY-042');
    const l3 = await member('观澜赠送人', 30000);
    expect((await options(l3)).gift.reason).toContain('L3·尊');

    const o = await options(giver, phoneOf(friend));
    expect(o.gift).toMatchObject({ allowed: true, grade: 3, endsOn: trialEndsOn('gift', today, 7), used: 0, limit: 1, limitText: '今年' });
    const c = await create(giver, { kind: 'gift', phone: phoneOf(friend) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    gift = c.body.trial as TrialRow;
    expect(gift).toMatchObject({ kind: 'gift', grade: 3, memberId: friend, inviterId: giver, endsOn: trialEndsOn('gift', today, 7) });
    expect(gift.benefitUseId).not.toBeNull();
    const [u] = await ctx.sql<{ memberId: number; code: string; periodKey: string; limitAt: number; note: string; status: string }[]>`
      SELECT u.member_id, b.code, u.period_key, u.limit_at, u.note, u.status FROM benefit_uses u JOIN benefits b ON b.id = u.benefit_id WHERE u.id = ${gift.benefitUseId}`;
    expect(u).toEqual({ memberId: giver, code: 'QY-042', periodKey: today.slice(0, 4), limitAt: 1, note: '赠送会籍：受赠客人', status: 'active' });
    // 受赠人本月可享按 L3·初
    expect((await benefitsOf(friend)).state.grade).toBe(3);

    const next = await member('第二位受赠', 0);
    const second = await create(giver, { kind: 'gift', phone: phoneOf(next) });
    expect(second.status).toBe(422);
    expect(second.body.error.message).toContain('今年已用 1 次');
  });

  it('QY-042 不能单独登记、赠送的使用登记不能单独作废；撤销赠送一并作废、次数腾出来', async () => {
    const qy042 = await byCode('QY-042');
    const direct = await api(ctx.app, ctx.clerk, 'POST', `/api/members/${giver}/benefit-uses`, { clientKey: randomUUID(), benefitId: qy042.id });
    expect(direct.body.error.code).toBe('BENEFIT_VIA_TRIAL');
    const voidUse = await api(ctx.app, ctx.owner, 'POST', `/api/benefit-uses/${gift.benefitUseId}/void`, { reason: '想腾次数' });
    expect(voidUse.body.error.code).toBe('USE_OF_TRIAL');

    const done = await cancel(gift.id, '客人不要了');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const [u] = await ctx.sql<{ status: string; voidReason: string }[]>`SELECT status, void_reason FROM benefit_uses WHERE id = ${gift.benefitUseId}`;
    expect(u).toEqual({ status: 'voided', voidReason: '撤销赠送会籍：客人不要了' });
    expect((await options(giver)).gift).toMatchObject({ allowed: true, used: 0 });
    await allChecksOk();
  });
});

describe('转正、结果待确认', () => {
  it('受邀人自己充值升到体验的档级：临时身份记「转正」，升档照常', async () => {
    const inviter = await member('潭影邀请人二', 10000);
    const p = await member('想转正的客人', 0);
    const c = await create(inviter, { kind: 'invite', phone: phoneOf(p) });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.trial.grade).toBe(1);
    await recharge(p, yuan(5000));
    expect((await gradeOf(p)).state.grade).toBe(1);
    const t = (await trialsOf(p)).received[0]!;
    expect(t).toMatchObject({ id: c.body.trial.id, status: 'converted', endedOn: today });
    expect((await trialsOf(p)).active).toBeNull();
    await allChecksOk();
  });

  it('查回找到已发起的；确认作废后原请求晚到拒绝', async () => {
    const inviter = await member('潭影邀请人三', 10000);
    const p = await member('网络不好的客人', 0);
    const key = randomUUID();
    const c = await create(inviter, { clientKey: key, kind: 'invite', phone: phoneOf(p) });
    expect(c.status).toBe(201);
    const found = await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${key}?type=member_trial`);
    expect(found.body).toMatchObject({ found: true, refId: c.body.trial.id });

    const inviter2 = await member('潭影邀请人四', 10000);
    const q = await member('另一位网络不好的客人', 0);
    const lost = randomUUID();
    const abandon = await api(ctx.app, ctx.clerk, 'POST', `/api/erp/ops/${lost}/abandon`, { type: 'member_trial', summary: '邀请体验' });
    expect(abandon.status, JSON.stringify(abandon.body)).toBe(200);
    const late = await create(inviter2, { clientKey: lost, kind: 'invite', phone: phoneOf(q) });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OP_ABANDONED');
    expect((await trialsOf(q)).received).toEqual([]);
  });

  it('发起后受邀人改了手机号：原编号、原请求原样重提仍返回原来那条；手机号或别的内容不同的拒绝（按原请求的摘要核对）', async () => {
    const inviter = await member('潭影邀请人五', 10000);
    const p = await member('改手机号的客人', 0);
    const key = randomUUID();
    const original = { clientKey: key, kind: 'invite' as const, phone: phoneOf(p) };
    const c = await create(inviter, original);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const id = (c.body.trial as TrialRow).id;

    // 正常编辑会员档案更正手机号
    const corrected = '19966660001';
    // 改手机号要写原因（v0.7.26，M77；店主有「改会员手机号」权限，不用授权）
    const edit = await api(ctx.app, ctx.owner, 'PUT', `/api/members/${p}`, { name: '改手机号的客人', phone: corrected, phoneReason: '登记时手机号写错了' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    // 结果待确认时原样重提：返回原来那条，不看档案此刻的手机号
    const again = await create(inviter, original);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, trial: { id, memberId: p } });
    // 同一编号、内容不同（换成新手机号、补了姓名、换了类型、换了邀请人）的不当作原来那次
    const other = await member('潭影邀请人六', 10000);
    for (const [who, body] of [
      [inviter, { ...original, phone: corrected }],
      [inviter, { ...original, name: '改手机号的客人' }],
      [inviter, { ...original, kind: 'gift' as const }],
      [other, original],
    ] as const) {
      const r = await create(who, body);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    }
    expect((await trialsOf(p)).received.map((t) => t.id)).toEqual([id]);
    expect((await api(ctx.app, ctx.clerk, 'GET', `/api/erp/ops/${key}?type=member_trial`)).body).toMatchObject({ found: true, refId: id });
    await allChecksOk();
  });

  it('看板：体验中、本月发起、到期、转正、撤销', async () => {
    const r = await api(ctx.app, ctx.owner, 'GET', '/api/membership/trials?scope=month');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.summary).toMatchObject({ converted: 1, cancelled: 2 });
    expect(r.body.summary.started).toBeGreaterThanOrEqual(6);
    const active = await api(ctx.app, ctx.owner, 'GET', '/api/membership/trials');
    expect(active.body.rows.every((t: TrialRow) => t.status === 'active')).toBe(true);
    expect(active.body.rows.length).toBe(active.body.summary.active);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/membership/trials')).status).toBe(403);
  });
});
