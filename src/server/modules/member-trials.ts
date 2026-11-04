// 临时身份（v0.7.25，docs/MEMBERSHIP_P3.md 第 3 节；PENDING_DECISIONS M51–M56）：低一档邀请体验、赠送记名会籍（QY-042）。
//
//   · 享什么（M51）：本月可享的服务类与登记使用、结账会员折扣、VIP 柜按「自己的与临时身份的取高的」（benefitState）；
//     每月券类与事件礼只按自己的档阶，不进升档、升阶、保级的判断，他店查询显示自己的档阶；
//   · 发起（M52、M53、M56，「登记权益使用」的岗位）：邀请人按自己的档阶（临时身份不能再邀请、赠送别人），给对方「自己的档级 − 1」的初阶；
//     邀请体验 L2 起，天数、每月次数按会员规则；赠送会籍按 QY-042 的起点、周期与上限，同一事务里给邀请人登记一次 QY-042 的使用；
//     受邀人现在的档级要低于体验的档级、同一时间只有一个、N 个月内只能被邀请或赠送一次（撤销的不算）；还不是会员的当场建档；
//   · 结束：到期（每天的到期处理，结束日的下一天记「体验到期」，停机补跑结果一样）；转正（自己的档级升到体验的档级或更高，
//     在记状态变化的同一事务，升档与升级礼照常）；撤销（「维护会员权益」的岗位，写原因；赠送会籍一并作废那次 QY-042 的使用登记，
//     次数腾出来；邀请体验的每月次数不退）。
// 锁：发起：操作编号的咨询锁（与「确认作废」串行）→ 两位会员一行（id 升序）→ QY-042 权益一行（共享锁）；
//     撤销：受邀人会员一行 → 临时身份一行 → 那次使用登记；到期处理一位一个事务、只锁受邀人一行；转正在调用方已锁的会员一行之后。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import {
  benefitEligible,
  benefitQuantity,
  periodKey,
  startLabel,
  stateRank,
  type BenefitCategory,
  type BenefitPeriod,
  type BenefitStatus,
  type TierQuantity,
} from '@shared/benefits';
import { shiftDate } from '@shared/labels';
import { MEMBER_CHANNEL_KEY } from '@shared/members';
import { asGrade, gradeLabel, type Grade, type MembershipRules, type Tier } from '@shared/membership';
import {
  GIFT_BENEFIT_CODE,
  INVITE_MIN_GRADE,
  inviteeAgainFrom,
  TRIAL_KIND_LABELS,
  TRIAL_KINDS,
  TRIAL_STATUS_LABELS,
  trialEndsOn,
  type MemberTrials,
  type TrialInvitee,
  type TrialKind,
  type TrialKindOption,
  type TrialOptions,
  type TrialRow,
  type TrialStatus,
  type TrialSummary,
} from '@shared/trials';
import { can } from '@shared/permissions';
import { guard } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db, type Sql, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { idParam, parse } from '../lib/validate';
import { setTxTimeouts } from '../lib/tx';
import { onMemberSaved } from './benefits';
import { issueOpenCardCoupons } from './coupons';
import { erpOpAbandoned } from './erp-ops';
import { insertMember } from './members';
import { loadMembershipRules, projectedGrade, settleMemberDue } from './membership';
import { loadSettings } from './settings';

export interface ActiveTrial {
  id: number;
  kind: TrialKind;
  grade: Grade;
  tier: Tier;
  startsOn: string;
  endsOn: string;
  inviterId: number;
}

/** 这一天生效中的临时身份（没有为空；到期还没处理的，过了结束日就不算） */
export async function activeTrialOf(db: Db, memberId: number, date: string): Promise<ActiveTrial | null> {
  const [t] = await db<ActiveTrial[]>`
    SELECT id, kind, grade, tier, starts_on, ends_on, inviter_id FROM member_trials
    WHERE member_id = ${memberId} AND status = 'active' AND starts_on <= ${date}::date AND ends_on >= ${date}::date`;
  return t ? { ...t, id: Number(t.id), inviterId: Number(t.inviterId) } : null;
}

/** 享权益用的档阶（M51）：自己的与生效中的临时身份取高的 */
export async function benefitState(
  db: Db,
  memberId: number,
  own: { grade: Grade; tier: Tier | null },
  date: string,
): Promise<{ grade: Grade; tier: Tier | null; trial: ActiveTrial | null }> {
  const trial = await activeTrialOf(db, memberId, date);
  if (trial && stateRank(trial.grade, trial.tier) > stateRank(own.grade, own.tier)) return { grade: trial.grade, tier: trial.tier, trial };
  return { grade: own.grade, tier: own.tier, trial };
}

/** 几位会员今天生效中的临时身份（前台徽标、VIP 柜核对用；不加锁） */
export async function activeTrialsOf(db: Db, memberIds: number[], date: string): Promise<Map<number, ActiveTrial>> {
  const ids = [...new Set(memberIds)];
  if (!ids.length) return new Map();
  const rows = await db<(ActiveTrial & { memberId: number })[]>`
    SELECT id, kind, grade, tier, starts_on, ends_on, inviter_id, member_id FROM member_trials
    WHERE member_id IN ${db(ids)} AND status = 'active' AND starts_on <= ${date}::date AND ends_on >= ${date}::date`;
  return new Map(rows.map(({ memberId, ...t }) => [Number(memberId), { ...t, id: Number(t.id), inviterId: Number(t.inviterId) }]));
}

// ───────────────────────── 读 ─────────────────────────

const TRIAL_SELECT = (db: Db) => db`
  SELECT t.id, t.kind, t.grade, t.tier, t.starts_on, t.ends_on, t.member_id, m.member_no, m.name AS member_name,
         t.inviter_id, i.member_no AS inviter_no, i.name AS inviter_name, t.benefit_use_id, t.business_date, s.display_name AS staff_name,
         t.created_at, t.status, t.ended_on, e.display_name AS ended_by_name, t.end_reason
  FROM member_trials t JOIN members m ON m.id = t.member_id JOIN members i ON i.id = t.inviter_id
  JOIN staff s ON s.id = t.staff_id LEFT JOIN staff e ON e.id = t.ended_by`;

type TrialDbRow = Omit<TrialRow, 'label'>;

const toRow = (rules: MembershipRules, r: TrialDbRow): TrialRow => ({
  ...r,
  id: Number(r.id),
  memberId: Number(r.memberId),
  inviterId: Number(r.inviterId),
  benefitUseId: r.benefitUseId === null ? null : Number(r.benefitUseId),
  label: gradeLabel(rules, r.grade, r.tier),
  createdAt: new Date(r.createdAt).toISOString(),
});

export async function getTrial(db: Db, id: number): Promise<TrialRow> {
  const [r] = await db<TrialDbRow[]>`${TRIAL_SELECT(db)} WHERE t.id = ${id}`;
  if (!r) throw notFound('临时身份不存在');
  return toRow(await loadMembershipRules(db), r);
}

/** 会员详情：今天生效中的临时身份、收到过的、发起过的（各最近 20 条） */
export async function memberTrials(db: Db, memberId: number, date: string): Promise<MemberTrials> {
  const [m] = await db`SELECT 1 FROM members WHERE id = ${memberId}`;
  if (!m) throw notFound('会员不存在');
  const rules = await loadMembershipRules(db);
  const received = (await db<TrialDbRow[]>`${TRIAL_SELECT(db)} WHERE t.member_id = ${memberId} ORDER BY t.id DESC LIMIT 20`).map((r) => toRow(rules, r));
  const sent = (await db<TrialDbRow[]>`${TRIAL_SELECT(db)} WHERE t.inviter_id = ${memberId} ORDER BY t.id DESC LIMIT 20`).map((r) => toRow(rules, r));
  const active = received.find((r) => r.status === 'active' && r.startsOn <= date && r.endsOn >= date) ?? null;
  return { memberId, today: date, active, received, sent };
}

// ───────────────────────── 发起前的核对 ─────────────────────────

interface GiftDef {
  id: number;
  code: string;
  name: string;
  category: BenefitCategory;
  startGrade: number | null;
  startTier: number | null;
  period: BenefitPeriod;
  quantity: number | null;
  tierQuantities: TierQuantity[];
  status: BenefitStatus;
}

const PERIOD_SPAN: Record<BenefitPeriod, string> = { none: '', day: '今天', month: '本月', year: '今年' };
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/** 赠送会籍这一次登记的上限（不计次为空）：与登记使用同一个算法（按邀请人自己的档阶） */
const giftLimit = (g: GiftDef, grade: number, tier: number | null): number | null => (g.period === 'none' ? null : benefitQuantity(g, grade, tier));

interface InviterFacts {
  status: string;
  grade: Grade;
  tier: Tier | null;
  label: string;
  invitesThisMonth: number;
  gift: GiftDef | null;
  /** QY-042 本期已用几次（不计次时为本月登记的） */
  giftUsed: number;
}

async function inviterFacts(
  db: Db,
  inviterId: number,
  own: { grade: Grade; tier: Tier | null },
  date: string,
  rules: MembershipRules,
  opts: { lockGift?: boolean } = {},
): Promise<InviterFacts> {
  const [m] = await db<{ status: string }[]>`SELECT status FROM members WHERE id = ${inviterId}`;
  if (!m) throw notFound('会员不存在');
  // 本月发起过的邀请体验（撤销的也算：每月次数不退，M55）
  const [inv] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM member_trials WHERE inviter_id = ${inviterId} AND kind = 'invite' AND business_date >= ${monthStart(date)}`;
  const [gift] = await db<GiftDef[]>`
    SELECT id, code, name, category, start_grade, start_tier, period, quantity, tier_quantities, status FROM benefits
    WHERE code = ${GIFT_BENEFIT_CODE} ${opts.lockGift ? db`FOR SHARE` : db``}`;
  let giftUsed = 0;
  if (gift) {
    const limit = giftLimit(gift, own.grade, own.tier);
    const pk = limit === null ? null : periodKey(gift.period, date);
    const [u] =
      pk === null
        ? await db<{ n: number }[]>`
            SELECT coalesce(sum(quantity), 0)::int AS n FROM benefit_uses
            WHERE member_id = ${inviterId} AND benefit_id = ${gift.id} AND status = 'active' AND business_date >= ${monthStart(date)}`
        : await db<{ n: number }[]>`
            SELECT coalesce(sum(quantity), 0)::int AS n FROM benefit_uses
            WHERE member_id = ${inviterId} AND benefit_id = ${gift.id} AND status = 'active' AND period_key = ${pk}`;
    giftUsed = u!.n;
  }
  return {
    status: m.status,
    grade: own.grade,
    tier: own.tier,
    label: gradeLabel(rules, own.grade, own.tier),
    invitesThisMonth: inv!.n,
    gift: gift ? { ...gift, id: Number(gift.id) } : null,
    giftUsed,
  };
}

function inviteOption(rules: MembershipRules, f: InviterFacts, date: string): TrialKindOption {
  const base = { used: f.invitesThisMonth, limit: rules.trialInvitesPerMonth, limitText: '本月' };
  const no = (reason: string): TrialKindOption => ({ allowed: false, reason, grade: null, label: null, endsOn: null, ...base });
  if (f.status !== 'active') return no('该会员已停用，不能邀请');
  if (rules.trialInvitesPerMonth <= 0) return no('邀请体验没有开放（后台「会员规则」里每月次数是 0）');
  if (f.grade < INVITE_MIN_GRADE) return no(`自己现在是「${f.label}」，L${INVITE_MIN_GRADE} 起的会员才能邀请体验`);
  if (f.invitesThisMonth >= rules.trialInvitesPerMonth) {
    return no(`本月已邀请 ${f.invitesThisMonth} 次，每位会员每月 ${rules.trialInvitesPerMonth} 次`);
  }
  const grade = asGrade(f.grade - 1);
  return { allowed: true, reason: null, grade, label: gradeLabel(rules, grade, 0), endsOn: trialEndsOn('invite', date, rules.trialInviteDays), ...base };
}

function giftOption(rules: MembershipRules, f: InviterFacts, date: string): TrialKindOption {
  const g = f.gift;
  const limit = g ? giftLimit(g, f.grade, f.tier) : null;
  const base = { used: f.giftUsed, limit, limitText: limit === null || !g ? '不限次数' : PERIOD_SPAN[g.period] };
  const no = (reason: string): TrialKindOption => ({ allowed: false, reason, grade: null, label: null, endsOn: null, ...base });
  if (f.status !== 'active') return no('该会员已停用，不能赠送');
  if (!g) return no(`本店权益清单里没有「${GIFT_BENEFIT_CODE} 会籍赠送」，请先在后台「会员权益」导入清单、核对后发布`);
  if (g.status !== 'published') return no(`「${g.code} ${g.name}」${g.status === 'paused' ? '已暂缓' : '还没发布'}，发布后才能赠送`);
  if (g.category !== 'service') return no(`「${g.code} ${g.name}」要是服务类（按次数登记），请在后台「会员权益」改回服务类`);
  if (!benefitEligible(g, f.grade, f.tier)) {
    return no(`自己现在是「${f.label}」，「${g.name}」从「${startLabel(g.startGrade, g.startTier)}」起才能用`);
  }
  if (f.grade < 2) return no('赠送的是低一档的会籍，自己要 L2 起');
  if (limit !== null && f.giftUsed >= limit) return no(`「${g.name}」${PERIOD_SPAN[g.period]}已用 ${f.giftUsed} 次，上限 ${limit} 次`);
  const grade = asGrade(f.grade - 1);
  return { allowed: true, reason: null, grade, label: gradeLabel(rules, grade, 0), endsOn: trialEndsOn('gift', date, rules.trialInviteDays), ...base };
}

interface InviteeFacts {
  id: number;
  memberNo: string;
  name: string;
  status: string;
  grade: Grade;
  label: string;
  /** 今天生效中的临时身份 */
  active: { label: string; endsOn: string } | null;
  /** N 个月内开始的（撤销的不算） */
  recent: { startsOn: string } | null;
}

async function inviteeFacts(db: Db, memberId: number, own: { grade: Grade; tier: Tier | null }, date: string, rules: MembershipRules): Promise<InviteeFacts> {
  const [m] = await db<{ memberNo: string; name: string; status: string }[]>`SELECT member_no, name, status FROM members WHERE id = ${memberId}`;
  if (!m) throw notFound('会员不存在');
  const [active] = await db<{ grade: number; tier: number; endsOn: string }[]>`
    SELECT grade, tier, ends_on FROM member_trials
    WHERE member_id = ${memberId} AND status = 'active' AND starts_on <= ${date}::date AND ends_on >= ${date}::date`;
  // 最近一次（撤销的不算）：它开始那天加上受邀间隔之前都不能再次——与页面写的「X 起才能再次」同一个日期（月底不多等一天）
  const [last] = await db<{ startsOn: string }[]>`
    SELECT starts_on FROM member_trials
    WHERE member_id = ${memberId} AND status <> 'cancelled'
    ORDER BY starts_on DESC LIMIT 1`;
  const recent = last && date < inviteeAgainFrom(last.startsOn, rules.trialInviteeMonths) ? last : null;
  return {
    id: memberId,
    memberNo: m.memberNo,
    name: m.name,
    status: m.status,
    grade: own.grade,
    label: gradeLabel(rules, own.grade, own.tier),
    active: active ? { label: gradeLabel(rules, active.grade, active.tier), endsOn: active.endsOn } : null,
    recent: recent ?? null,
  };
}

/** 受邀人能不能接受这一种（这一种本身不能发起时为空，页面先显示那一种的原因） */
function inviteeProblem(rules: MembershipRules, inviterId: number, invitee: InviteeFacts, option: TrialKindOption): string | null {
  if (!option.allowed || option.grade === null) return null;
  if (invitee.id === inviterId) return '不能邀请自己';
  if (invitee.status !== 'active') return '这位会员已停用';
  if (invitee.active) return `已经在体验中（${invitee.active.label}，至 ${invitee.active.endsOn}），同一时间只能有一个`;
  if (invitee.recent) {
    return `${rules.trialInviteeMonths} 个月内已被邀请或赠送过（${invitee.recent.startsOn} 开始），${inviteeAgainFrom(invitee.recent.startsOn, rules.trialInviteeMonths)} 起才能再次`;
  }
  if (invitee.grade >= option.grade) return `这位会员现在是「${invitee.label}」，不低于体验的「${option.label}」`;
  return null;
}

export const PhoneField = z
  .string('请输入受邀人的手机号')
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^1\d{10}$/, '请输入 11 位手机号'));

const OptionsQuery = z.object({ phone: PhoneField.optional() });

/** 发起前的核对：邀请人能发起哪种、给对方什么、到哪天；带了手机号时核对受邀人（只读） */
export async function trialOptions(db: Db, inviterId: number, date: string, phone?: string): Promise<TrialOptions> {
  const rules = await loadMembershipRules(db);
  const own = await projectedGrade(db, inviterId, date);
  if (!own) throw notFound('会员不存在');
  const f = await inviterFacts(db, inviterId, own, date, rules);
  const invite = inviteOption(rules, f, date);
  const gift = giftOption(rules, f, date);
  let invitee: TrialInvitee | null = null;
  if (phone) {
    const [m] = await db<{ id: number }[]>`SELECT id FROM members WHERE phone = ${phone}`;
    if (m) {
      const id = Number(m.id);
      const facts = await inviteeFacts(db, id, (await projectedGrade(db, id, date))!, date, rules);
      invitee = {
        exists: true,
        memberId: id,
        memberNo: facts.memberNo,
        name: facts.name,
        label: facts.label,
        problems: { invite: inviteeProblem(rules, inviterId, facts, invite), gift: inviteeProblem(rules, inviterId, facts, gift) },
      };
    } else {
      invitee = { exists: false, problems: { invite: null, gift: null } };
    }
  }
  return { inviterId, today: date, own: { grade: own.grade, tier: own.tier, label: f.label }, invite, gift, invitee };
}

// ───────────────────────── 发起、撤销 ─────────────────────────

const TrialInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  kind: z.enum(TRIAL_KINDS, '请选择邀请体验或赠送会籍'),
  phone: PhoneField,
  /** 受邀人还不是会员时当场建档（M54）：姓名、渠道来源 */
  name: z.string().trim().max(32, '姓名最多 32 个字').default(''),
  channel: z.string().regex(MEMBER_CHANNEL_KEY, '渠道来源不正确').nullable().optional(),
});

const today = async (db: Db, timezone: string, at = new Date()) => businessDateOf(at, timezone, (await loadSettings(db)).businessDayStartHour);

/** 过了结束日还生效的记「体验到期」（结束日的下一天）；调用方已锁这几位会员一行 */
async function expireOverdue(tx: Tx, memberIds: number[], date: string): Promise<number> {
  const rows = await tx`
    UPDATE member_trials SET status = 'expired', ended_on = ends_on + 1
    WHERE member_id IN ${tx(memberIds)} AND status = 'active' AND ends_on < ${date}::date
    RETURNING id`;
  return rows.length;
}

/** 发起需要的内容（前台按校验整理后的请求；小程序入口 mp-entries.ts 照同一套规则） */
export interface TrialCreateArgs {
  inviterId: number;
  kind: TrialKind;
  phone: string;
  name: string;
  channel: string | null | undefined;
  clientKey: string;
  requestHash: string;
}

/**
 * 发起一笔（调用方的事务里；调用方已取操作编号的锁、核对过重提）：返回新的临时身份编号。
 * 锁：两位会员一行（id 升序）→ QY-042 权益一行（共享锁，赠送会籍时）
 */
export async function createTrialTx(tx: Tx, deps: Deps, args: TrialCreateArgs, ctx: OpContext, date: string): Promise<number> {
  const { inviterId } = args;
  const rules = await loadMembershipRules(tx);
  const [found] = await tx<{ id: number }[]>`SELECT id FROM members WHERE phone = ${args.phone}`;
  const existingId = found ? Number(found.id) : null;
  if (existingId === inviterId) throw unprocessable('TRIAL_SELF', '不能邀请自己：请输入受邀人的手机号');
  // 两位会员按 id 升序锁（与充值、消费、登记使用同一把锁）
  const ids = existingId === null ? [inviterId] : [inviterId, existingId].sort((a, b) => a - b);
  const locked = await tx<{ id: number; status: string; phone: string; name: string }[]>`
    SELECT id, status, phone, name FROM members WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
  const inviter = locked.find((m) => Number(m.id) === inviterId);
  if (!inviter) throw notFound('会员不存在');
  const existing = existingId === null ? null : (locked.find((m) => Number(m.id) === existingId) ?? null);
  if (existingId !== null && (!existing || existing.phone !== args.phone)) {
    throw conflict('MEMBER_CHANGED', '受邀人的会员档案刚刚有变化，请重新发起');
  }
  // 到期没处理的先按规则处理（两位都是，按 id 升序），再按处理完的档阶判断（与充值、消费、登记使用一样）
  const settled = new Map<number, { grade: Grade; tier: Tier | null }>();
  for (const id of ids) settled.set(id, (await settleMemberDue(tx, id, date))!);
  const f = await inviterFacts(tx, inviterId, settled.get(inviterId)!, date, rules, { lockGift: args.kind === 'gift' });
  const option = args.kind === 'invite' ? inviteOption(rules, f, date) : giftOption(rules, f, date);
  if (!option.allowed) throw unprocessable('TRIAL_NOT_ALLOWED', option.reason!);
  const grade = option.grade!;
  let inviteeId: number;
  let inviteeName: string;
  let created = false;
  if (existing) {
    inviteeId = existingId!;
    inviteeName = existing.name;
    // 过了结束日还没处理的先记到期，不占「同一时间一个」
    await expireOverdue(tx, [inviteeId], date);
    const problem = inviteeProblem(rules, inviterId, await inviteeFacts(tx, inviteeId, settled.get(inviteeId)!, date, rules), option);
    if (problem) throw unprocessable('TRIAL_INVITEE', problem);
  } else {
    if (!args.name) throw badRequest('受邀人还不是会员，请填写姓名（当场建档）', { field: 'name' });
    // 必填的自定义字段可以先空着（只问姓名、手机号），之后编辑会员时再补
    inviteeId = await insertMember(tx, { name: args.name, phone: args.phone, channel: args.channel }, ctx, { enforceRequired: false });
    // 与在建档页建档一样：按发券规则发开卡礼，「L0·会员」起点的权益当场发（这些按自己的档阶，与临时身份无关）
    await issueOpenCardCoupons(tx, deps, inviteeId, ctx);
    await onMemberSaved(tx, deps, inviteeId, ctx);
    inviteeName = args.name;
    created = true;
  }
  let use: { id: number; code: string; name: string; period: string | null; limit: number | null; note: string } | null = null;
  if (args.kind === 'gift') {
    const g = f.gift!;
    const limit = option.limit;
    const pk = limit === null ? null : periodKey(g.period, date);
    const note = `赠送会籍：${inviteeName}`.slice(0, 200);
    const [u] = await tx<{ id: number }[]>`
      INSERT INTO benefit_uses (benefit_id, member_id, business_date, period_key, quantity, limit_at, note, staff_id, client_key)
      VALUES (${g.id}, ${inviterId}, ${date}, ${pk}, 1, ${limit}, ${note}, ${ctx.actor.id}, ${randomUUID()})
      RETURNING id`;
    use = { id: Number(u!.id), code: g.code, name: g.name, period: pk, limit, note };
  }
  const endsOn = option.endsOn!;
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO member_trials (member_id, kind, grade, tier, starts_on, ends_on, inviter_id, benefit_use_id, business_date, staff_id, client_key, request_hash)
    VALUES (${inviteeId}, ${args.kind}, ${grade}, 0, ${date}, ${endsOn}, ${inviterId}, ${use?.id ?? null}, ${date}, ${ctx.actor.id}, ${args.clientKey}, ${args.requestHash})
    RETURNING id`;
  const trialId = Number(row!.id);
  if (use) {
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'benefit_used',
      targetType: 'member',
      targetId: inviterId,
      detail: { useId: use.id, code: use.code, name: use.name, quantity: 1, period: use.period, limit: use.limit, note: use.note, trialId },
      ip: ctx.ip,
      businessDate: date,
    });
  }
  await writeAudit(tx, {
    staffId: ctx.actor.id,
    action: 'member_trial_created',
    targetType: 'member',
    targetId: inviteeId,
    detail: {
      trialId,
      kind: TRIAL_KIND_LABELS[args.kind],
      label: option.label,
      startsOn: date,
      endsOn,
      inviterId,
      inviter: inviter.name,
      useId: use?.id,
      newMember: created || undefined,
    },
    ip: ctx.ip,
    businessDate: date,
  });
  return trialId;
}

/** 发起时撞上唯一约束：翻译成店员看得懂的提示（不是这几种返回空） */
export function trialUniqueError(error: unknown) {
  if (isUniqueViolation(error, 'members_phone_key')) {
    return conflict('PHONE_EXISTS', '这个手机号刚刚登记为会员，请重新发起（会按已有会员邀请）');
  }
  if (isUniqueViolation(error, 'member_trials_active_uq')) return conflict('TRIAL_ACTIVE', '受邀人刚刚有了一个临时身份，请刷新后再看');
  return null;
}

/** 发起时的营业日 */
export const trialToday = (db: Db, timezone: string, at?: Date) => today(db, timezone, at);

/**
 * 发起邀请体验或赠送会籍（M52–M54）。同一编号重提返回原来那条；结果待确认时可以「确认作废」，之后原请求晚到也不生效。
 * 受邀人按手机号找；还不是会员的当场建档（L0、没有余额，与建档页一样发开卡礼）
 */
export async function createTrial(deps: Deps, inviterId: number, raw: unknown, ctx: OpContext): Promise<{ trial: TrialRow; replayed: boolean }> {
  const input = parse(TrialInput, raw);
  // 原请求的摘要（按校验整理后的内容）：重提按它核对，不看受邀人档案此刻的手机号——发起后改了手机号，原样重提仍返回原来那条
  const requestHash = hashRequest({ inviterId, kind: input.kind, phone: input.phone, name: input.name, channel: input.channel ?? null });
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM member_trials WHERE client_key = ${input.clientKey}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次邀请，请刷新页面后重新发起');
    return Number(p.id);
  };
  const date = await today(deps.sql, deps.config.timezone, ctx.at);
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 先取操作编号的咨询锁、核对没有被「确认作废」（与作废串行）
      await assertNotFenced(tx, input.clientKey, 'member_trial', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      const args = { inviterId, kind: input.kind, phone: input.phone, name: input.name, channel: input.channel, clientKey: input.clientKey, requestHash };
      return { id: await createTrialTx(tx, deps, args, ctx, date), replayed: false };
    });
    return { trial: await getTrial(deps.sql, out.id), replayed: out.replayed };
  } catch (error) {
    // 同一编号并发提交：后到的一笔撞上唯一约束，按原来那条返回
    if (isUniqueViolation(error, 'member_trials_client_key_key')) {
      const id = await replay(deps.sql);
      if (id !== null) return { trial: await getTrial(deps.sql, id), replayed: true };
    }
    throw trialUniqueError(error) ?? error;
  }
}

const CancelInput = z.object({ reason: z.string('请填写撤销原因').trim().min(2, '请填写撤销原因（至少 2 个字）').max(200, '原因最多 200 字') });

/**
 * 撤销临时身份（M55，「维护会员权益」）：写原因；赠送会籍一并作废那次 QY-042 的使用登记（次数腾出来），邀请体验的每月次数不退。
 * 已撤销的原样返回；已到期、已转正的不能撤销
 */
export async function cancelTrial(deps: Deps, trialId: number, raw: unknown, ctx: OpContext): Promise<TrialRow> {
  const { reason } = parse(CancelInput, raw);
  const date = await today(deps.sql, deps.config.timezone, ctx.at);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [peek] = await tx<{ memberId: number }[]>`SELECT member_id FROM member_trials WHERE id = ${trialId}`;
    if (!peek) throw notFound('临时身份不存在');
    // 受邀人会员一行 → 临时身份一行（与发起、转正、到期处理同一顺序）
    await tx`SELECT id FROM members WHERE id = ${peek.memberId} FOR UPDATE`;
    const [t] = await tx<{ status: TrialStatus; kind: TrialKind; endsOn: string; benefitUseId: number | null; inviterId: number }[]>`
      SELECT status, kind, ends_on, benefit_use_id, inviter_id FROM member_trials WHERE id = ${trialId} FOR UPDATE`;
    if (t!.status === 'cancelled') return;
    if (t!.status !== 'active') throw unprocessable('TRIAL_ENDED', `这个临时身份已经${TRIAL_STATUS_LABELS[t!.status]}，不能撤销`);
    if (t!.endsOn < date) throw unprocessable('TRIAL_ENDED', `这个临时身份 ${t!.endsOn} 已经到期，不能撤销`);
    await tx`
      UPDATE member_trials SET status = 'cancelled', ended_on = ${date}, ended_by = ${ctx.actor.id}, end_reason = ${reason}
      WHERE id = ${trialId}`;
    if (t!.benefitUseId !== null) {
      await tx`
        UPDATE benefit_uses SET status = 'voided', voided_by = ${ctx.actor.id}, voided_at = now(), void_reason = ${`撤销赠送会籍：${reason}`.slice(0, 200)}
        WHERE id = ${t!.benefitUseId} AND status = 'active'`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'member_trial_cancelled',
      targetType: 'member',
      targetId: Number(peek.memberId),
      detail: { trialId, kind: TRIAL_KIND_LABELS[t!.kind], inviterId: Number(t!.inviterId), useId: t!.benefitUseId ?? undefined, reason },
      ip: ctx.ip,
      businessDate: date,
    });
  });
  return getTrial(deps.sql, trialId);
}

// ───────────────────────── 转正、到期（会员体系的自动处理） ─────────────────────────

/**
 * 自己的档级升了之后（会员一行已锁，membership.ts 记状态变化的同一事务；上线、期初导入定档按 id 升序已锁）：
 * 过了结束日的先记到期；自己的档级到了体验的档级或更高的记「转正」（M53：升档与升级礼照常）
 */
export async function convertTrials(tx: Tx, memberIds: number[], date: string): Promise<void> {
  if (!memberIds.length) return;
  await expireOverdue(tx, memberIds, date);
  await tx`
    UPDATE member_trials t SET status = 'converted', ended_on = GREATEST(${date}::date, t.starts_on)
    FROM members m
    WHERE m.id = t.member_id AND t.member_id IN ${tx(memberIds)} AND t.status = 'active' AND m.grade >= t.grade`;
}

/** 有没有过了结束日还生效的（每天的到期处理决定要不要跑） */
export async function hasOverdueTrials(db: Db, date: string): Promise<boolean> {
  const [r] = await db<{ hit: number }[]>`SELECT 1 AS hit FROM member_trials WHERE status = 'active' AND ends_on < ${date}::date LIMIT 1`;
  return !!r;
}

const EXPIRE_PAGE = 200;

/** 每天的到期处理（runMembershipDaily 调用）：过了结束日的记「体验到期」，一位一个事务、只锁受邀人一行；返回结束了几条与第一处出错 */
export async function expireTrials(sql: Sql, date: string): Promise<{ expired: number; error: string | null }> {
  let expired = 0;
  let error: string | null = null;
  const page = (after: number) => sql<{ memberId: number }[]>`
    SELECT DISTINCT member_id FROM member_trials WHERE status = 'active' AND ends_on < ${date}::date AND member_id > ${after}
    ORDER BY member_id LIMIT ${EXPIRE_PAGE}`;
  for (let rows: { memberId: number }[] = await page(0); rows.length; ) {
    for (const { memberId } of rows) {
      try {
        expired += await sql.begin(async (tx) => {
          await setTxTimeouts(tx);
          await tx`SELECT id FROM members WHERE id = ${memberId} FOR UPDATE`;
          return expireOverdue(tx, [Number(memberId)], date);
        });
      } catch (e) {
        error ??= `临时身份（会员 #${memberId}）：${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      }
    }
    rows = rows.length < EXPIRE_PAGE ? [] : await page(Number(rows[rows.length - 1]!.memberId));
  }
  return { expired, error };
}

// ───────────────────────── 看板、自检 ─────────────────────────

/** 后台「会员体系」：今天生效中的、本月发起、到期、转正、撤销、7 天内到期 */
export async function trialSummary(db: Db, date: string): Promise<TrialSummary> {
  const from = monthStart(date);
  const [r] = await db<Omit<TrialSummary, 'today' | 'from'>[]>`
    SELECT count(*) FILTER (WHERE status = 'active' AND starts_on <= ${date}::date AND ends_on >= ${date}::date)::int AS active,
           count(*) FILTER (WHERE status = 'active' AND starts_on <= ${date}::date AND ends_on >= ${date}::date AND kind = 'invite')::int AS active_invite,
           count(*) FILTER (WHERE status = 'active' AND starts_on <= ${date}::date AND ends_on >= ${date}::date AND kind = 'gift')::int AS active_gift,
           count(*) FILTER (WHERE business_date BETWEEN ${from}::date AND ${date}::date)::int AS started,
           count(*) FILTER (WHERE status = 'expired' AND ended_on BETWEEN ${from}::date AND ${date}::date)::int AS expired,
           count(*) FILTER (WHERE status = 'converted' AND ended_on BETWEEN ${from}::date AND ${date}::date)::int AS converted,
           count(*) FILTER (WHERE status = 'cancelled' AND ended_on BETWEEN ${from}::date AND ${date}::date)::int AS cancelled,
           count(*) FILTER (WHERE status = 'active' AND ends_on BETWEEN ${date}::date AND ${shiftDate(date, 6)}::date)::int AS ending_soon
    FROM member_trials`;
  return { today: date, from, ...r! };
}

const ListQuery = z.object({ scope: z.enum(['active', 'month'], '名单种类不正确').default('active') });

/** 看板的名单：今天生效中的（最先到期的在前），或本月发起、结束的（最近的在前）；最多 500 条 */
export async function listTrials(db: Db, date: string, scope: 'active' | 'month'): Promise<TrialRow[]> {
  const rules = await loadMembershipRules(db);
  const from = monthStart(date);
  const rows =
    scope === 'active'
      ? await db<TrialDbRow[]>`
          ${TRIAL_SELECT(db)} WHERE t.status = 'active' AND t.starts_on <= ${date}::date AND t.ends_on >= ${date}::date
          ORDER BY t.ends_on, t.id LIMIT 500`
      : await db<TrialDbRow[]>`
          ${TRIAL_SELECT(db)} WHERE t.business_date BETWEEN ${from}::date AND ${date}::date OR t.ended_on BETWEEN ${from}::date AND ${date}::date
          ORDER BY t.id DESC LIMIT 500`;
  return rows.map((r) => toRow(rules, r));
}

/**
 * 临时身份自检（cli check、备份核验）：① 赠送会籍与 QY-042 的使用登记对得上（邀请人、QY-042、1 次；撤销的已作废、其余有效）；
 * ② 生效中的：档级高于自己的会员档级（够了的应已转正），最近一次每天的到期处理那天之前到期的都已结束
 */
export async function trialChecks(db: Db): Promise<{ label: string; ok: boolean; detail: string }[]> {
  const [gift] = await db<{ n: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE u.id IS NULL OR u.member_id <> t.inviter_id OR b.code <> ${GIFT_BENEFIT_CODE} OR u.quantity <> 1
                              OR (t.status = 'cancelled') <> (u.status = 'voided'))::int AS n,
           count(*)::int AS total
    FROM member_trials t LEFT JOIN benefit_uses u ON u.id = t.benefit_use_id LEFT JOIN benefits b ON b.id = u.benefit_id
    WHERE t.kind = 'gift'`;
  const [last] = await db<{ businessDate: string }[]>`
    SELECT business_date FROM membership_job_runs WHERE job = 'daily' AND finished_at IS NOT NULL ORDER BY business_date DESC LIMIT 1`;
  const lastDate = last?.businessDate ?? null;
  const [act] = await db<{ reached: number; overdue: number; active: number }[]>`
    SELECT count(*) FILTER (WHERE m.grade >= t.grade)::int AS reached,
           count(*) FILTER (WHERE ${lastDate}::date IS NOT NULL AND t.ends_on < ${lastDate}::date)::int AS overdue,
           count(*)::int AS active
    FROM member_trials t JOIN members m ON m.id = t.member_id WHERE t.status = 'active'`;
  const problems = [
    act!.reached ? `${act!.reached} 条的会员自己的档级已经够了、没有转正` : '',
    act!.overdue ? `${act!.overdue} 条在 ${lastDate} 之前到期、还没有结束` : '',
  ].filter(Boolean);
  return [
    {
      label: '赠送会籍与 QY-042 的使用登记对得上',
      ok: gift!.n === 0,
      detail: gift!.n ? `${gift!.n} 条赠送会籍与使用登记对不上（不是邀请人、不是 QY-042，或撤销与作废不一致）` : `${gift!.total} 条赠送会籍都对得上`,
    },
    {
      label: '临时身份：到期的已结束、档级够了的已转正',
      ok: problems.length === 0,
      detail: problems.length ? problems.join('；') : `生效中的 ${act!.active} 条都在期内、档级高于会员自己的`,
    },
  ];
}

// ───────────────────────── 接口 ─────────────────────────

export function registerTrialRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const todayNow = () => today(sql, deps.config.timezone);

  app.get('/api/members/:id/trials', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const date = await todayNow();
    return readSnapshot(sql, (tx) => memberTrials(tx, id, date));
  });

  app.get('/api/members/:id/trial-options', { preHandler: guard('benefit.use') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { phone } = parse(OptionsQuery, req.query ?? {});
    const date = await todayNow();
    return readSnapshot(sql, (tx) => trialOptions(tx, id, date, phone));
  });

  app.post('/api/members/:id/trials', { preHandler: guard('benefit.use') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const result = await createTrial(deps, id, req.body, ctxOf(req));
    if (!result.replayed) reply.code(201);
    return result;
  });

  app.post('/api/member-trials/:id/cancel', { preHandler: guard('benefit.publish') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return cancelTrial(deps, id, req.body, ctxOf(req));
  });

  app.get('/api/membership/trials', { preHandler: guard() }, async (req) => {
    if (!can(req.actor, 'member.retention') && !can(req.actor, 'benefit.publish')) throw forbidden();
    const { scope } = parse(ListQuery, req.query ?? {});
    const date = await todayNow();
    return readSnapshot(sql, async (tx) => ({ summary: await trialSummary(tx, date), rows: await listTrials(tx, date, scope) }));
  });
}
