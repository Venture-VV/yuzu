// 会员体系 v2 第一期（v0.7.23，docs/MEMBERSHIP.md 第 2–4、7、8、11、12 节）：档级、阶位与会籍周期全自动。
//
// 状态存在会员一行上（档级、阶位、周期、补充期、版本号；会员一行本来就是钱包的锁），每一次变化记一条状态变化（只追加）：
//   · 充值（钱包充值的事务里，会员已锁）：先把到期没处理的按规则处理掉，再按滚动 365 天累计升档（可以连跳），赠金按充值后所在档的比例；
//   · 储值消费（会员消费、前台与桌台结账的储值支付，会员已锁）：周期净储值消费到本档门槛的 30% / 60% 升享阶 / 尊阶，补充期内到 60% 当场保级；
//   · 每天营业日开始（应用的定时任务每分钟看一次，一位会员一个事务）：到期的会员保级、进补充期或降一档；
//   · 已有会员上线（迁移之后只做一次）、期初导入：按累计充值（含旧系统累计）定档、进初阶。
// 日期都是营业日。规则改了只影响以后的判断，已经记下的状态不重算。
// 锁：只锁会员一行（与钱包同一把锁）；上线定档先取规则锁、再按 id 升序锁会员；都不等其他业务锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import { MAX_VIP_LEVEL } from '@shared/frontdesk';
import { shiftDate } from '@shared/labels';
import {
  asGrade,
  cycleFrom,
  daysToExpiry,
  DEFAULT_MEMBERSHIP_RULES,
  expiryStep,
  expiryWindowEnd,
  GRADE_EVENT_KINDS,
  GRADE_STATES,
  gradeForAmount,
  gradeLabel,
  L0_STATE,
  lockerLevelOf,
  MAX_GRADE,
  maskName,
  maskPhone,
  rechargeMinimum,
  rechargeOutcome,
  reminderBucket,
  rollingFrom,
  tierForSpend,
  tierTargets,
  type ExpiryStep,
  type Grade,
  type GradeEventKind,
  type GradeEventListRow,
  type GradeEventRow,
  type GradeState,
  type MemberGradeBadge,
  type MemberGradeInfo,
  type MemberLookupResult,
  type MembershipJobRun,
  type MembershipOverview,
  type MembershipRules,
  type RechargeOutcome,
  type RetentionRow,
  type Tier,
} from '@shared/membership';
import { formatYuan } from '@shared/money';
import { guard, sessionOnly } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { toCsv, csvReply } from '../lib/csv';
import { conflict, notFound } from '../lib/errors';
import { dateSchema, idParam, parse } from '../lib/validate';
import { lockSettings, sameJson, saveRuleSetting } from '../lib/rule-settings';
import { setTxTimeouts } from '../lib/tx';
import { assertNotFenced } from '../lib/fences';
import { onDueSettled, onGradeChanged, onMembersGraded } from './benefits';
import { erpOpAbandoned } from './erp-ops';
import { activeTrialsOf, convertTrials, expireTrials, hasOverdueTrials, trialSummary } from './member-trials';
import { loadSettings } from './settings';

const RULES_KEY = 'membership_rules';
/** 已有会员上线定档的标记（只做一次） */
const LIVE_KEY = 'membership_live';

// ───────────────────────── 会员规则 ─────────────────────────

export async function loadMembershipRules(db: Db): Promise<MembershipRules> {
  const [row] = await db<{ value: Partial<MembershipRules> }[]>`SELECT value FROM settings WHERE key = ${RULES_KEY}`;
  return { ...DEFAULT_MEMBERSHIP_RULES, ...(row?.value ?? {}) };
}

const centsField = (label: string, max: number) =>
  z.number(`请填写${label}`).int(`${label}要精确到分`).min(0, `${label}不能为负`).max(max, `${label}过大`);

const RulesInput = z
  .object({
    grades: z
      .array(
        z.object({
          name: z.string('请填写档名').trim().min(1, '请填写档名').max(8, '档名最多 8 个字'),
          thresholdCents: centsField('充值门槛', 100_000_000_00),
          bonusBp: z.number('请填写赠送比例').int('赠送比例最多精确到 0.01%').min(0, '赠送比例不能为负').max(10_000, '赠送比例最多 100%'),
        }),
      )
      .length(MAX_GRADE + 1, '档级是 L0–L6 共 7 档'),
    enjoyPct: z.number('请填写享阶比例').int('享阶比例取整数').min(1, '享阶比例至少 1%').max(100, '享阶比例最多 100%'),
    honorPct: z.number('请填写尊阶比例').int('尊阶比例取整数').min(1, '尊阶比例至少 1%').max(100, '尊阶比例最多 100%'),
    cycleDays: z.number('请填写会籍周期').int('会籍周期按天').min(30, '会籍周期至少 30 天').max(1095, '会籍周期最多 1095 天'),
    graceDays: z.number('请填写补充期').int('补充期按天').min(0, '补充期不能为负').max(365, '补充期最多 365 天'),
    firstRechargeMinCents: centsField('首充最低', 1_000_000_00),
    topUpMinCents: centsField('续充最低', 1_000_000_00),
    reminderDays: z.array(z.number('提醒天数要是整数').int('提醒天数要是整数').min(1, '提醒天数至少 1 天').max(365, '提醒天数最多 365 天')).max(6, '提醒最多 6 档'),
    onboardMaxGrade: z.number('请选择上线定档的最高档').int().min(0).max(MAX_GRADE),
    vipLockerLevels: z
      .array(z.number('请填写 VIP 柜等级').int('VIP 柜等级取整数').min(0, 'VIP 柜等级不能为负').max(MAX_VIP_LEVEL, `VIP 柜最多 ${MAX_VIP_LEVEL} 级`))
      .length(MAX_GRADE + 1, '每一档都要填能用几级 VIP 柜'),
    // 低一档邀请体验（v0.7.25，M52）
    trialInviteDays: z.number('请填写邀请体验的天数').int('邀请体验按天').min(1, '邀请体验至少 1 天').max(90, '邀请体验最多 90 天'),
    trialInvitesPerMonth: z.number('请填写每月能邀请几次').int('次数要是整数').min(0, '次数不能为负').max(10, '每月最多 10 次'),
    trialInviteeMonths: z.number('请填写受邀间隔').int('受邀间隔按月').min(1, '受邀间隔至少 1 个月').max(36, '受邀间隔最多 36 个月'),
  })
  .superRefine((r, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (r.grades[0]!.thresholdCents !== 0) issue(['grades', 0, 'thresholdCents'], 'L0 是免费注册，门槛是 0');
    for (let g = 1; g <= MAX_GRADE; g++) {
      if (r.grades[g]!.thresholdCents <= r.grades[g - 1]!.thresholdCents) issue(['grades', g, 'thresholdCents'], `L${g} 的门槛要高于 L${g - 1}`);
    }
    const names = r.grades.map((g) => g.name);
    if (new Set(names).size !== names.length) issue(['grades'], '各档的名称不能重复');
    if (r.enjoyPct >= r.honorPct) issue(['enjoyPct'], '享阶比例要低于尊阶比例');
    if (new Set(r.reminderDays).size !== r.reminderDays.length) issue(['reminderDays'], '提醒天数不能重复');
    if (r.reminderDays.some((d) => d >= r.cycleDays)) issue(['reminderDays'], '提醒天数要少于会籍周期');
    if (r.vipLockerLevels.some((v, i) => i > 0 && v < r.vipLockerLevels[i - 1]!)) issue(['vipLockerLevels'], '高档能用的 VIP 柜不能比低档少');
  })
  .transform((r) => ({ ...r, reminderDays: [...r.reminderDays].sort((a, b) => b - a) }));

// ───────────────────────── 状态与记录 ─────────────────────────

interface GradeRow {
  grade: number;
  tier: number | null;
  cycleStart: string | null;
  cycleEnd: string | null;
  graceUntil: string | null;
  gradeVersion: number;
}

const stateOf = (r: GradeRow): GradeState => ({
  grade: asGrade(r.grade),
  tier: r.tier === null ? null : (r.tier as Tier),
  cycleStart: r.cycleStart,
  cycleEnd: r.cycleEnd,
  graceUntil: r.graceUntil,
});

async function readGrade(db: Db, memberId: number): Promise<{ state: GradeState; version: number } | null> {
  const [r] = await db<GradeRow[]>`
    SELECT grade, tier, cycle_start, cycle_end, grace_until, grade_version FROM members WHERE id = ${memberId}`;
  return r ? { state: stateOf(r), version: r.gradeVersion } : null;
}

/**
 * 这位会员与并进来的会员（v0.7.26 合并，M79：以后的滚动累计充值、周期储值消费、是不是首充都把来源会员的算进去；
 * 并进来的会员之前也并过别人的，一并算）
 */
export async function memberFamily(db: Db, memberId: number): Promise<number[]> {
  const rows = await db<{ id: number }[]>`
    WITH RECURSIVE fam AS (
      SELECT ${memberId}::bigint AS id
      UNION SELECT m.id FROM members m JOIN fam ON m.merged_into_id = fam.id
    ) SELECT id FROM fam ORDER BY id`;
  return rows.map((r) => Number(r.id));
}

/** 净储值消费：from 到 to（营业日，含两端）的储值消费；撤销了的（含反结账）不算 */
async function spendBetween(db: Db, memberId: number, from: string, to: string): Promise<number> {
  const family = await memberFamily(db, memberId);
  const [r] = await db<{ s: number }[]>`
    SELECT coalesce(sum(total_amount), 0) AS s FROM consumptions
    WHERE member_id IN ${db(family)} AND status = 'completed' AND business_date BETWEEN ${from} AND ${to}`;
  return Number(r!.s);
}

/** 周期开始以来的净储值消费（消费的营业日不会在今天之后；补录、跨夜结账记在更早的营业日也照算） */
async function spendSince(db: Db, memberId: number, from: string): Promise<number> {
  const family = await memberFamily(db, memberId);
  const [r] = await db<{ s: number }[]>`
    SELECT coalesce(sum(total_amount), 0) AS s FROM consumptions
    WHERE member_id IN ${db(family)} AND status = 'completed' AND business_date >= ${from}`;
  return Number(r!.s);
}

/**
 * 滚动累计充值：today 往前一个会籍周期（含 today）的充值实收，减去这几笔退回的本金（v0.7.26 储值退回，M73）；
 * 期初导入的旧系统累计不算（日期不明）；并进来的会员的充值一并算（M79）
 */
async function rollingRecharge(db: Db, rules: MembershipRules, memberId: number, today: string): Promise<number> {
  const family = await memberFamily(db, memberId);
  const [r] = await db<{ s: number }[]>`
    SELECT coalesce(sum(r.paid_amount - coalesce((SELECT sum(l.amount) FROM member_refund_lines l WHERE l.recharge_id = r.id), 0)), 0) AS s
    FROM recharges r
    WHERE r.member_id IN ${db(family)} AND r.business_date BETWEEN ${rollingFrom(rules, today)} AND ${today}`;
  return Number(r!.s);
}

/** 首充：还没有充值、也没有有效期初的会员 */
async function isFirstRecharge(db: Db, memberId: number): Promise<boolean> {
  const family = await memberFamily(db, memberId);
  const [r] = await db<{ first: boolean }[]>`
    SELECT NOT EXISTS (SELECT 1 FROM recharges WHERE member_id IN ${db(family)})
       AND NOT EXISTS (SELECT 1 FROM opening_balances WHERE member_id IN ${db(family)} AND status = 'active') AS first`;
  return r!.first;
}

interface EventExtra {
  cycleSpend?: number;
  rollingRecharge?: number | null;
  rechargeId?: number | null;
  consumptionId?: number | null;
  staffId?: number | null;
  reason?: string;
  clientKey?: string | null;
  /** 储值退回降档（v0.7.26）、合并（v0.7.26）的单子 */
  memberRefundId?: number | null;
  memberMergeId?: number | null;
  /** 补跑到期的中间几步：只发事件礼，本期券类与生日礼等走完再按最后的状态发（settleDue） */
  deferPeriodic?: boolean;
}

/**
 * 写会员一行的新状态（版本号加一）并记一条状态变化；调用方已锁会员。
 * 之后在同一事务里按新档阶发会员权益（v0.7.24：补发本期券类差额，升档、升阶、保级的事件礼，生日礼）
 */
async function changeState(tx: Tx, memberId: number, kind: GradeEventKind, businessDate: string, from: GradeState, to: GradeState, extra: EventExtra = {}) {
  await tx`
    UPDATE members SET grade = ${to.grade}, tier = ${to.tier}, cycle_start = ${to.cycleStart}, cycle_end = ${to.cycleEnd},
           grace_until = ${to.graceUntil}, grade_version = grade_version + 1
    WHERE id = ${memberId}`;
  const [event] = await tx<{ id: number }[]>`
    INSERT INTO member_grade_events (member_id, kind, business_date, from_grade, from_tier, to_grade, to_tier, cycle_start, cycle_end, grace_until,
                                     cycle_spend, rolling_recharge, recharge_id, consumption_id, staff_id, reason, client_key,
                                     member_refund_id, member_merge_id)
    VALUES (${memberId}, ${kind}, ${businessDate}, ${from.grade}, ${from.tier}, ${to.grade}, ${to.tier}, ${to.cycleStart}, ${to.cycleEnd}, ${to.graceUntil},
            ${extra.cycleSpend ?? 0}, ${extra.rollingRecharge ?? null}, ${extra.rechargeId ?? null}, ${extra.consumptionId ?? null},
            ${extra.staffId ?? null}, ${extra.reason ?? ''}, ${extra.clientKey ?? null}, ${extra.memberRefundId ?? null}, ${extra.memberMergeId ?? null})
    RETURNING id`;
  // 临时身份（v0.7.25，M53）：自己的档级升到体验的档级或更高时转正
  if (to.grade > from.grade) await convertTrials(tx, [memberId], businessDate);
  await onGradeChanged(tx, { memberId, kind, eventId: Number(event!.id), date: businessDate, to, staffId: extra.staffId ?? null, deferPeriodic: extra.deferPeriodic });
}

interface DueStep {
  kind: ExpiryStep['kind'];
  from: GradeState;
  next: GradeState;
  spend: number;
}

/**
 * 到期没处理的按规则推算到 today（只读）：周期或补充期结束的那一步看从周期第一天到结束那天的净储值消费。
 * 日期都按规则推出来，不看哪天推算，补跑与当天跑结果一样
 */
async function projectDue(db: Db, rules: MembershipRules, memberId: number, state: GradeState, today: string): Promise<{ steps: DueStep[]; state: GradeState }> {
  const steps: DueStep[] = [];
  let cur = state;
  // 周期至少 30 天，停机几个月补跑也只有几步；上限防止规则异常时死循环
  for (let i = 0; i < 40; i++) {
    const end = expiryWindowEnd(cur);
    if (cur.grade === 0 || !cur.cycleStart || !end || end >= today) break;
    const spend = await spendBetween(db, memberId, cur.cycleStart, end);
    const step = expiryStep(rules, cur, spend, today);
    if (!step) break;
    steps.push({ kind: step.kind, from: cur, next: step.next, spend });
    cur = step.next;
  }
  return { steps, state: cur };
}

/**
 * 把到期没处理的处理掉（会员一行已锁）；返回处理后的状态与各步。
 * 会员权益：每一步的事件礼（保级礼）照发；本期券类与生日礼走完以后按处理完的状态发一次——停机后补跑、一次连走几步时
 * （例如 6 月 30 日到期、补充期也过了，11 月 3 日才处理：先进补充期、再降档），中间那几步的档阶早已过去，
 * 按它发的本月券降档后收不回（Codex 自动审查 98806a3）。与每天按时处理的结果一样
 */
async function settleDue(tx: Tx, rules: MembershipRules, memberId: number, state: GradeState, today: string) {
  const projected = await projectDue(tx, rules, memberId, state, today);
  for (const s of projected.steps) await changeState(tx, memberId, s.kind, today, s.from, s.next, { cycleSpend: s.spend, deferPeriodic: true });
  if (projected.steps.length) await onDueSettled(tx, memberId, today);
  return projected;
}

/**
 * 按档阶判断的写操作之前（会员一行已锁，调用方的事务里）：到期没处理的先处理掉，返回处理后的档阶（会员不存在为空）。
 * 与充值、消费一样，不按应该已经降掉的档阶判断（例如登记权益使用，Codex 自动审查 825e248）
 */
export async function settleMemberDue(tx: Tx, memberId: number, today: string): Promise<GradeState | null> {
  const current = await readGrade(tx, memberId);
  if (!current) return null;
  return (await settleDue(tx, await loadMembershipRules(tx), memberId, current.state, today)).state;
}

/** 只读：到期没处理的按规则推算到 today 的档阶（与等级卡一样；会员不存在为空） */
export async function projectedGrade(db: Db, memberId: number, today: string): Promise<GradeState | null> {
  const current = await readGrade(db, memberId);
  if (!current) return null;
  return (await projectDue(db, await loadMembershipRules(db), memberId, current.state, today)).state;
}

// ───────────────────────── 充值与消费（钱包的事务里调用） ─────────────────────────

export interface RechargeGrade {
  rules: MembershipRules;
  /** 充值前的状态（到期没处理的已处理） */
  state: GradeState;
  first: boolean;
  /** 单笔最低（分），0 = 不限 */
  minimum: number;
  rollingBeforeCents: number;
  outcome: RechargeOutcome;
}

/**
 * 充值入账前（会员一行已锁）：先把到期没处理的处理掉，再算这笔充完的档级、按档的赠金与首充 / 续充最低。
 * 充值被拒时整笔回滚（处理掉的到期一并回滚，之后由每天的自动任务处理）
 */
export async function planRechargeGrade(tx: Tx, memberId: number, paidCents: number, today: string): Promise<RechargeGrade> {
  const rules = await loadMembershipRules(tx);
  const current = await readGrade(tx, memberId);
  if (!current) throw notFound('会员不存在');
  const { state } = await settleDue(tx, rules, memberId, current.state, today);
  const rollingBeforeCents = await rollingRecharge(tx, rules, memberId, today);
  const first = await isFirstRecharge(tx, memberId);
  return { rules, state, first, minimum: rechargeMinimum(rules, first), rollingBeforeCents, outcome: rechargeOutcome(rules, state.grade, rollingBeforeCents, paidCents) };
}

// ───────────────────────── 储值退回（v0.7.26，M73） ─────────────────────────

/**
 * 现在这一档是不是本会籍周期里靠充值升上来的：最近一条改了档级的状态变化是「充值升档」、发生在这个周期里
 * （周期从升档那天起算）。靠保级、手动调整、上线定档、合并留在这一档的不算
 */
async function gradeFromRecharge(db: Db, memberId: number, state: GradeState): Promise<boolean> {
  if (state.grade === 0 || !state.cycleStart) return false;
  const [e] = await db<{ kind: GradeEventKind; businessDate: string }[]>`
    SELECT kind, business_date FROM member_grade_events
    WHERE member_id = ${memberId} AND to_grade <> from_grade ORDER BY id DESC LIMIT 1`;
  return !!e && e.kind === 'recharge_up' && e.businessDate >= state.cycleStart;
}

/** 储值退回以后够得上的档阶：降到够得上的那一档的初阶，会籍周期不变；L0 没有周期。够得上、或不是靠充值升上来的为空 */
async function refundTarget(db: Db, rules: MembershipRules, memberId: number, state: GradeState, rollingAfter: number): Promise<GradeState | null> {
  if (!(await gradeFromRecharge(db, memberId, state))) return null;
  const reached = gradeForAmount(rules, rollingAfter);
  if (reached >= state.grade) return null;
  return reached === 0 ? L0_STATE : { grade: reached, tier: 0, cycleStart: state.cycleStart, cycleEnd: state.cycleEnd, graceUntil: null };
}

/**
 * 退储值前的核对（只读）：按这次分到每一笔充值的本金推算会不会降档；返回「从哪一档降到哪一档」，不降为空。
 * refunded：充值单编号 → 这次要退的本金（期初、合并转入的不算充值，不影响滚动累计）
 */
export async function previewRefundGrade(db: Db, memberId: number, refunded: Map<number, number>, today: string): Promise<{ from: string; to: string } | null> {
  const rules = await loadMembershipRules(db);
  const state = await projectedGrade(db, memberId, today);
  if (!state || state.grade === 0) return null;
  let minus = 0;
  if (refunded.size) {
    const rows = await db<{ id: number }[]>`
      SELECT id FROM recharges WHERE id IN ${db([...refunded.keys()])} AND business_date BETWEEN ${rollingFrom(rules, today)} AND ${today}`;
    for (const r of rows) minus += refunded.get(Number(r.id)) ?? 0;
  }
  const to = await refundTarget(db, rules, memberId, state, (await rollingRecharge(db, rules, memberId, today)) - minus);
  return to ? { from: gradeLabel(rules, state.grade, state.tier), to: gradeLabel(rules, to.grade, to.tier) } : null;
}

/**
 * 退储值单记好之后（会员一行已锁、退回的几行已写）：到期没处理的先处理掉，够不上这一档就当场降档、记一条「储值退回降档」。
 * 返回从哪一档降到哪一档（不降为空）
 */
export async function onRefundGrade(tx: Tx, o: { memberId: number; refundId: number; refundNo: string; today: string; staffId: number }): Promise<{ from: string; to: string } | null> {
  const rules = await loadMembershipRules(tx);
  const current = await readGrade(tx, o.memberId);
  if (!current) return null;
  const { state } = await settleDue(tx, rules, o.memberId, current.state, o.today);
  const rolling = await rollingRecharge(tx, rules, o.memberId, o.today);
  const to = await refundTarget(tx, rules, o.memberId, state, rolling);
  if (!to) return null;
  await changeState(tx, o.memberId, 'refund_down', o.today, state, to, {
    rollingRecharge: rolling,
    staffId: o.staffId,
    reason: `储值退回 ${o.refundNo}`,
    memberRefundId: o.refundId,
  });
  return { from: gradeLabel(rules, state.grade, state.tier), to: gradeLabel(rules, to.grade, to.tier) };
}

/** 充值单记好之后：升档的写新状态（进初阶，会籍周期从今天起算）与一条「充值升档」 */
export async function applyRechargeGrade(tx: Tx, plan: RechargeGrade, o: { memberId: number; rechargeId: number; today: string }) {
  if (!plan.outcome.upgraded) return;
  const to: GradeState = { grade: plan.outcome.gradeAfter, tier: 0, ...cycleFrom(plan.rules, o.today), graceUntil: null };
  await changeState(tx, o.memberId, 'recharge_up', o.today, plan.state, to, { rollingRecharge: plan.outcome.rollingAfterCents, rechargeId: o.rechargeId });
}

/**
 * 储值消费记好之后（会员一行已锁）：先把到期没处理的处理掉；周期消费到本档门槛的 30% / 60% 升享阶 / 尊阶（同一周期只升不降）；
 * 补充期内（从原周期第一天累计）到 60% 当场保级，新周期从原到期日的下一天起算。
 * today 是这笔消费的营业日（补录、跨夜结账可能早于今天：这时只升阶，到期由每天的自动任务处理）
 */
export async function onStoredValueSpend(tx: Tx, o: { memberId: number; consumptionId: number; today: string }) {
  const rules = await loadMembershipRules(tx);
  const current = await readGrade(tx, o.memberId);
  if (!current) return;
  const { state } = await settleDue(tx, rules, o.memberId, current.state, o.today);
  if (state.grade === 0 || !state.cycleStart || !state.cycleEnd) return;
  const spend = await spendSince(tx, o.memberId, state.cycleStart);
  if (state.graceUntil !== null) {
    if (spend >= tierTargets(rules, state.grade).honor) {
      const to: GradeState = { grade: state.grade, tier: 2, ...cycleFrom(rules, shiftDate(state.cycleEnd, 1)), graceUntil: null };
      await changeState(tx, o.memberId, 'grace_retain', o.today, state, to, { cycleSpend: spend, consumptionId: o.consumptionId });
    }
    return;
  }
  const tier = tierForSpend(rules, state.grade, spend) ?? 0;
  if (tier > (state.tier ?? 0)) {
    await changeState(tx, o.memberId, 'spend_up', o.today, state, { ...state, tier }, { cycleSpend: spend, consumptionId: o.consumptionId });
  }
}

// ───────────────────────── 上线定档、期初导入定档 ─────────────────────────

/**
 * 按累计充值（本系统全部充值实收 + 有效期初的旧系统累计充值）定档、进初阶，会籍周期从 today 起；最高到「上线定档最高档」。
 * 只升不降：已经在这一档或更高的不动。调用方按需先取规则锁；这里按 id 升序锁会员
 */
async function gradeByCumulative(tx: Tx, memberIds: number[] | 'all', o: { kind: 'go_live' | 'import'; today: string; staffId: number | null }) {
  const rules = await loadMembershipRules(tx);
  if (memberIds !== 'all' && memberIds.length === 0) return { members: 0, graded: 0 };
  const rows = await tx<(GradeRow & { id: number; amount: number })[]>`
    SELECT m.id, m.grade, m.tier, m.cycle_start, m.cycle_end, m.grace_until, m.grade_version,
           coalesce((SELECT sum(r.paid_amount) FROM recharges r WHERE r.member_id = m.id), 0)
           + coalesce((SELECT sum(b.legacy_recharged) FROM opening_balances b WHERE b.member_id = m.id AND b.status = 'active'), 0) AS amount
    FROM members m
    ${memberIds === 'all' ? tx`` : tx`WHERE m.id IN ${tx(memberIds)}`}
    ORDER BY m.id
    FOR UPDATE OF m`;
  const cycle = cycleFrom(rules, o.today);
  const changes = rows.flatMap((r) => {
    const grade = gradeForAmount(rules, Number(r.amount), rules.onboardMaxGrade);
    return grade > r.grade ? [{ id: Number(r.id), from: stateOf(r), grade, amount: Number(r.amount) }] : [];
  });
  // 一次写完（上线时可能有几千位会员）
  if (changes.length) {
    const ids = changes.map((c) => c.id);
    const grades = changes.map((c) => c.grade);
    await tx`
      UPDATE members m SET grade = x.grade, tier = 0, cycle_start = ${cycle.cycleStart}, cycle_end = ${cycle.cycleEnd}, grace_until = NULL,
             grade_version = m.grade_version + 1
      FROM unnest(${ids}::bigint[], ${grades}::smallint[]) AS x (id, grade)
      WHERE m.id = x.id`;
    await tx`
      INSERT INTO member_grade_events (member_id, kind, business_date, from_grade, from_tier, to_grade, to_tier, cycle_start, cycle_end, grace_until,
                                       cycle_spend, rolling_recharge, staff_id)
      SELECT x.id, ${o.kind}, ${o.today}, x.from_grade, x.from_tier, x.grade, 0, ${cycle.cycleStart}, ${cycle.cycleEnd}, NULL, 0, x.amount, ${o.staffId}
      FROM unnest(${ids}::bigint[], ${changes.map((c) => c.from.grade)}::smallint[], ${changes.map((c) => c.from.tier)}::smallint[],
                  ${grades}::smallint[], ${changes.map((c) => c.amount)}::bigint[]) AS x (id, from_grade, from_tier, grade, amount)
      ORDER BY x.id`;
    // 临时身份（v0.7.25）：定档到了体验的档级或更高的转正
    await convertTrials(tx, ids, o.today);
    // 会员权益（v0.7.24）：定了档的当场补发本期券类（不发升级礼）
    await onMembersGraded(tx, ids, o.today, o.staffId);
  }
  return { members: rows.length, graded: changes.length };
}

/**
 * 已有会员上线定档（会员体系 v2 启用时只做一次）：应用启动、命令行迁移之后调用。
 * 先取规则锁再看标记，几个进程同时启动也只做一次。返回定了档的人数；之前已经做过返回 null
 */
export async function ensureMembershipLive(deps: Pick<Deps, 'sql' | 'config'>, now = new Date()): Promise<{ businessDate: string; graded: number } | null> {
  const [done] = await deps.sql`SELECT 1 FROM settings WHERE key = ${LIVE_KEY}`;
  if (done) return null;
  return deps.sql.begin(async (tx) => {
    await lockSettings(tx);
    const [again] = await tx`SELECT 1 FROM settings WHERE key = ${LIVE_KEY}`;
    if (again) return null;
    const settings = await loadSettings(tx);
    const businessDate = businessDateOf(now, deps.config.timezone, settings.businessDayStartHour);
    const { members, graded } = await gradeByCumulative(tx, 'all', { kind: 'go_live', today: businessDate, staffId: null });
    await tx`INSERT INTO settings (key, value) VALUES (${LIVE_KEY}, ${tx.json({ businessDate, at: now.toISOString(), graded })})`;
    await writeAudit(tx, { staffId: null, action: 'membership_live', targetType: 'settings', detail: { businessDate, members, graded }, businessDate });
    return { businessDate, graded };
  });
}

/** 期初导入（导入的事务里，会员已锁）：还没到这一档的会员按累计充值（含这次导入的旧系统累计充值）定档 */
export async function gradeImportedMembers(tx: Tx, memberIds: number[], today: string, staffId: number): Promise<number> {
  const ids = [...new Set(memberIds)].sort((a, b) => a - b);
  return (await gradeByCumulative(tx, ids, { kind: 'import', today, staffId })).graded;
}

// ───────────────────────── 每天的自动任务 ─────────────────────────

/** 一次翻多少位到期的会员 */
const DAILY_PAGE = 200;

/**
 * 到期处理：营业日开始后，周期或补充期已经结束的会员逐位处理（一位一个事务、锁会员一行）。
 * 应用每分钟调用一次：今天已经跑过、没有到期的会员时什么都不做。运行记录一个营业日一条，同一天多次处理累加。
 */
export async function runMembershipDaily(deps: Pick<Deps, 'sql' | 'config'>, now = new Date()): Promise<MembershipJobRun | null> {
  const { sql } = deps;
  const settings = await loadSettings(sql);
  const today = businessDateOf(now, deps.config.timezone, settings.businessDayStartHour);
  const dueIds = (after: number) => sql<{ id: number }[]>`
    SELECT id FROM members
    WHERE grade > 0 AND ((grace_until IS NULL AND cycle_end < ${today}) OR grace_until < ${today}) AND id > ${after}
    ORDER BY id LIMIT ${DAILY_PAGE}`;
  const first = await dueIds(0);
  const [run] = await sql<{ finishedAt: string | null; error: string | null }[]>`
    SELECT finished_at, error FROM membership_job_runs WHERE job = 'daily' AND business_date = ${today}`;
  // 今天已经跑完、没出错、也没有到期的会员：什么都不做。没跑完（进程在中途停了）或出过错的，就算已经没有到期的会员
  // （例如出错的那位后来充值、消费时被处理了），也要走到最后把运行记录补完，否则自检一整天都报（Codex 自动审查 43d53e9）
  // 临时身份（v0.7.25）：过了结束日还生效的也在这里结束
  const trialsDue = await hasOverdueTrials(sql, today);
  if (run && run.finishedAt && !run.error && first.length === 0 && !trialsDue) return null;
  await sql`
    INSERT INTO membership_job_runs (job, business_date) VALUES ('daily', ${today})
    ON CONFLICT (job, business_date) DO NOTHING`;
  const rules = await loadMembershipRules(sql);
  const counts = { processed: 0, retained: 0, grace: 0, downgraded: 0 };
  let error: string | null = null;
  for (let page: { id: number }[] = first; page.length; ) {
    for (const { id } of page) {
      try {
        const steps = await sql.begin(async (tx) => {
          await setTxTimeouts(tx);
          await tx`SELECT id FROM members WHERE id = ${id} FOR UPDATE`;
          const current = await readGrade(tx, id);
          return current ? (await settleDue(tx, rules, id, current.state, today)).steps : [];
        });
        if (!steps.length) continue;
        counts.processed += 1;
        for (const s of steps) {
          if (s.kind === 'retain' || s.kind === 'grace_retain') counts.retained += 1;
          else if (s.kind === 'grace_start') counts.grace += 1;
          else counts.downgraded += 1;
        }
      } catch (e) {
        error ??= `会员 #${id}：${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      }
    }
    page = page.length < DAILY_PAGE ? [] : await dueIds(Number(page[page.length - 1]!.id));
  }
  // 临时身份到期（会员到期处理之后：处理中升了档的已经转正，不再记到期）
  const trials = trialsDue ? await expireTrials(sql, today) : { expired: 0, error: null };
  error ??= trials.error;
  const [saved] = await sql<MembershipJobRun[]>`
    UPDATE membership_job_runs
       SET processed = processed + ${counts.processed}, retained = retained + ${counts.retained}, grace = grace + ${counts.grace},
           downgraded = downgraded + ${counts.downgraded}, finished_at = now(), error = ${error}
     WHERE job = 'daily' AND business_date = ${today}
    RETURNING business_date, started_at, finished_at, processed, retained, grace, downgraded, error`;
  return saved ? { ...saved, trialsExpired: trials.expired } : null;
}

// ───────────────────────── 读：等级卡、徽标、看板、名单 ─────────────────────────

const today = async (db: Db, timezone: string, at = new Date()) => businessDateOf(at, timezone, (await loadSettings(db)).businessDayStartHour);

const EVENT_COLUMNS = (db: Db) => db`
  e.id, e.kind, e.business_date, e.from_grade, e.from_tier, e.to_grade, e.to_tier, e.cycle_start, e.cycle_end, e.grace_until,
  e.cycle_spend, e.rolling_recharge, r.doc_no AS recharge_doc_no, c.doc_no AS consumption_doc_no, s.display_name AS staff_name, e.reason, e.created_at`;

async function gradeEvents(db: Db, memberId: number, limit: number): Promise<GradeEventRow[]> {
  return db<GradeEventRow[]>`
    SELECT ${EVENT_COLUMNS(db)}
    FROM member_grade_events e
    LEFT JOIN recharges r ON r.id = e.recharge_id LEFT JOIN consumptions c ON c.id = e.consumption_id LEFT JOIN staff s ON s.id = e.staff_id
    WHERE e.member_id = ${memberId} ORDER BY e.id DESC LIMIT ${limit}`;
}

/** 会员详情的等级卡：到期没处理的按规则推算到今天（只读） */
export async function memberGradeInfo(db: Db, memberId: number, todayDate: string): Promise<MemberGradeInfo> {
  const rules = await loadMembershipRules(db);
  const current = await readGrade(db, memberId);
  if (!current) throw notFound('会员不存在');
  const { state } = await projectDue(db, rules, memberId, current.state, todayDate);
  const spend = state.grade > 0 && state.cycleStart ? await spendSince(db, memberId, state.cycleStart) : 0;
  const rolling = await rollingRecharge(db, rules, memberId, todayDate);
  // 下一档按现在的档阶算（Codex 自动审查 43d53e9）：滚动累计已经够得上更高档时（上线定档封顶、手动调低、门槛改低），
  // 下一笔充值就升到够得上的那一档，还差 0；不按「充 0 元」推演，否则会跳过这一档、甚至显示「已是最高档」
  const reached = gradeForAmount(rules, rolling);
  const nextGrade = reached > state.grade ? reached : state.grade < MAX_GRADE ? ((state.grade + 1) as Grade) : null;
  const nextRule = nextGrade === null ? undefined : rules.grades[nextGrade];
  const next =
    nextGrade === null || !nextRule
      ? null
      : { grade: nextGrade, name: nextRule.name, needCents: Math.max(0, nextRule.thresholdCents - rolling), bonusBp: nextRule.bonusBp };
  const daysLeft = state.grade > 0 ? daysToExpiry(state, todayDate) : null;
  return {
    memberId,
    state,
    version: current.version,
    today: todayDate,
    label: gradeLabel(rules, state.grade, state.tier),
    cycleSpendCents: spend,
    targets: state.grade > 0 ? tierTargets(rules, state.grade) : null,
    inGrace: state.graceUntil !== null,
    daysLeft,
    reminder: state.graceUntil === null ? reminderBucket(rules, daysLeft) : null,
    rollingRechargeCents: rolling,
    firstRecharge: await isFirstRecharge(db, memberId),
    next: next ? { ...next, thresholdCents: rules.grades[next.grade]!.thresholdCents } : null,
    lockerLevel: lockerLevelOf(rules, state.grade),
    events: await gradeEvents(db, memberId, 50),
  };
}

/** 前台、VIP 柜核对用的档阶（按会员一行，不推算：营业日开始后一分钟内自动任务就会处理到期） */
export async function memberGradeBadges(db: Db, memberIds: number[], todayDate: string): Promise<Map<number, MemberGradeBadge>> {
  const ids = [...new Set(memberIds)];
  if (!ids.length) return new Map();
  const rules = await loadMembershipRules(db);
  const rows = await db<(GradeRow & { id: number })[]>`
    SELECT id, grade, tier, cycle_start, cycle_end, grace_until, grade_version FROM members WHERE id IN ${db(ids)}`;
  // 临时身份（v0.7.25，M51）：VIP 柜按自己的与临时身份的取高的；徽标仍显示自己的档阶，另外标「体验中」
  const trials = await activeTrialsOf(db, ids, todayDate);
  return new Map(
    rows.map((r) => {
      const s = stateOf(r);
      const daysLeft = s.grade > 0 ? daysToExpiry(s, todayDate) : null;
      const trial = trials.get(Number(r.id)) ?? null;
      return [
        Number(r.id),
        {
          memberId: Number(r.id),
          grade: s.grade,
          tier: s.tier,
          label: gradeLabel(rules, s.grade, s.tier),
          cycleEnd: s.cycleEnd,
          graceUntil: s.graceUntil,
          daysLeft,
          reminder: s.graceUntil === null ? reminderBucket(rules, daysLeft) : null,
          lockerLevel: Math.max(lockerLevelOf(rules, s.grade), trial ? lockerLevelOf(rules, trial.grade) : 0),
          trial: trial ? { grade: trial.grade, label: gradeLabel(rules, trial.grade, trial.tier), endsOn: trial.endsOn, kind: trial.kind } : null,
        },
      ];
    }),
  );
}

const JOB_COLUMNS = (db: Db) => db`business_date, started_at, finished_at, processed, retained, grace, downgraded, error`;

export async function membershipOverview(db: Db, todayDate: string): Promise<MembershipOverview> {
  const rules = await loadMembershipRules(db);
  const stateRows = await db<{ grade: number; tier: number | null; count: number; balance: number }[]>`
    SELECT grade, tier, count(*)::int AS count, coalesce(sum(principal_balance + bonus_balance), 0) AS balance FROM members GROUP BY grade, tier`;
  const states = GRADE_STATES.map((s) => {
    const r = stateRows.find((x) => x.grade === s.grade && x.tier === s.tier);
    return { ...s, count: r?.count ?? 0, balance: Number(r?.balance ?? 0) };
  });
  const from = `${todayDate.slice(0, 7)}-01`;
  const kindRows = await db<{ kind: GradeEventKind; n: number }[]>`
    SELECT kind, count(*)::int AS n FROM member_grade_events WHERE business_date BETWEEN ${from} AND ${todayDate} GROUP BY kind`;
  const counts = Object.fromEntries(GRADE_EVENT_KINDS.map((k) => [k, kindRows.find((r) => r.kind === k)?.n ?? 0])) as Record<GradeEventKind, number>;
  const expiring = await Promise.all(
    [...rules.reminderDays].sort((a, b) => a - b).map(async (within) => {
      const [r] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM members
        WHERE grade > 0 AND grace_until IS NULL AND cycle_end BETWEEN ${todayDate} AND ${shiftDate(todayDate, within)}`;
      return { within, count: r!.n };
    }),
  );
  const [g] = await db<{ grace: number; overdue: number }[]>`
    SELECT count(*) FILTER (WHERE grace_until >= ${todayDate})::int AS grace,
           count(*) FILTER (WHERE (grace_until IS NULL AND cycle_end < ${todayDate}) OR grace_until < ${todayDate})::int AS overdue
    FROM members WHERE grade > 0`;
  const jobs = await db<MembershipJobRun[]>`
    SELECT ${JOB_COLUMNS(db)} FROM membership_job_runs WHERE job = 'daily' ORDER BY business_date DESC LIMIT 14`;
  const [live] = await db<{ value: MembershipOverview['live'] }[]>`SELECT value FROM settings WHERE key = ${LIVE_KEY}`;
  return {
    trials: await trialSummary(db, todayDate),
    today: todayDate,
    live: live?.value ?? null,
    states,
    month: { from, to: todayDate, counts },
    expiring,
    grace: g!.grace,
    overdue: g!.overdue,
    jobToday: jobs.find((j) => j.businessDate === todayDate) ?? null,
    jobs,
  };
}

const RetentionQuery = z.object({
  kind: z.enum(['expiring', 'grace'], '名单种类不正确').default('expiring'),
  within: z.coerce.number().int().min(1, '天数至少 1 天').max(365, '最多查 365 天').default(90),
});
type RetentionQueryData = z.output<typeof RetentionQuery>;

/** 到期提醒名单（未来 N 天到期、不在补充期）或补充期名单，最先到期的在前（最多 1000 位） */
export async function retentionList(db: Db, todayDate: string, q: RetentionQueryData): Promise<RetentionRow[]> {
  const rules = await loadMembershipRules(db);
  const rows = await db<(Omit<RetentionRow, 'daysLeft' | 'reminder' | 'honorCents' | 'needCents'> & { grade: number })[]>`
    SELECT m.id AS member_id, m.member_no, m.name, m.phone, m.grade, m.tier, m.cycle_start, m.cycle_end, m.grace_until,
           m.principal_balance + m.bonus_balance AS balance,
           (SELECT max(le.created_at) FROM ledger_entries le WHERE le.member_id = m.id) AS last_activity_at,
           (SELECT coalesce(sum(c.total_amount), 0) FROM consumptions c
             WHERE c.member_id = m.id AND c.status = 'completed' AND c.business_date >= m.cycle_start) AS spend_cents
    FROM members m
    WHERE m.grade > 0 AND ${
      q.kind === 'grace'
        ? db`m.grace_until >= ${todayDate}`
        : db`m.grace_until IS NULL AND m.cycle_end BETWEEN ${todayDate} AND ${shiftDate(todayDate, q.within)}`
    }
    ORDER BY coalesce(m.grace_until, m.cycle_end), m.id
    LIMIT 1000`;
  return rows.map((r) => {
    const state: GradeState = { grade: asGrade(r.grade), tier: r.tier, cycleStart: r.cycleStart, cycleEnd: r.cycleEnd, graceUntil: r.graceUntil };
    const daysLeft = daysToExpiry(state, todayDate) ?? 0;
    const honorCents = tierTargets(rules, r.grade).honor;
    const spendCents = Number(r.spendCents);
    return {
      ...r,
      grade: state.grade,
      balance: Number(r.balance),
      spendCents,
      daysLeft,
      reminder: r.graceUntil === null ? reminderBucket(rules, daysLeft) : null,
      honorCents,
      needCents: Math.max(0, honorCents - spendCents),
    };
  });
}

const EventsQuery = z.object({
  date: dateSchema('营业日').optional(),
  kind: z.enum(GRADE_EVENT_KINDS, '变化种类不正确').optional(),
});

/** 看板里的状态变化：某个营业日（默认今天）的，最近的在前（最多 500 条） */
export async function listGradeEvents(db: Db, date: string, kind?: GradeEventKind): Promise<GradeEventListRow[]> {
  return db<GradeEventListRow[]>`
    SELECT ${EVENT_COLUMNS(db)}, m.id AS member_id, m.member_no, m.name AS member_name
    FROM member_grade_events e JOIN members m ON m.id = e.member_id
    LEFT JOIN recharges r ON r.id = e.recharge_id LEFT JOIN consumptions c ON c.id = e.consumption_id LEFT JOIN staff s ON s.id = e.staff_id
    WHERE e.business_date = ${date} ${kind ? db`AND e.kind = ${kind}` : db``}
    ORDER BY e.id DESC LIMIT 500`;
}

// ───────────────────────── 手动调整、他店查询 ─────────────────────────

const AdjustInput = z
  .object({
    clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
    grade: z.number('请选择档级').int().min(0, '档级是 L0–L6').max(MAX_GRADE, '档级是 L0–L6'),
    tier: z.number('请选择阶位').int().min(0, '阶位是初、享、尊').max(2, '阶位是初、享、尊').nullable(),
    reason: z.string('请填写调整原因').trim().min(2, '请填写调整原因（至少 2 个字）').max(200, '原因最多 200 字'),
    /** 页面看到的档阶版本号：期间有充值升档、消费升阶、到期处理时拒绝 */
    expectedVersion: z.number('缺少档阶版本号，请刷新页面').int().min(0),
  })
  .refine((v) => (v.grade === 0) === (v.tier === null), { message: '只有 L0 没有阶位，L1–L6 请选择初、享、尊', path: ['tier'] });

/**
 * 手动调整档阶（写原因，留记录）：新状态的会籍周期从今天起算（L0 没有周期）。
 * 同一编号重提返回原来那条；页面看到的版本号与当前不一致时拒绝（GRADE_CHANGED）
 */
export async function adjustMemberGrade(deps: Deps, memberId: number, raw: unknown, ctx: OpContext): Promise<MemberGradeInfo> {
  const input = parse(AdjustInput, raw);
  const at = ctx.at ?? new Date();
  const replayed = async (db: Db) => {
    const [prev] = await db<{ memberId: number; toGrade: number; toTier: number | null; reason: string }[]>`
      SELECT member_id, to_grade, to_tier, reason FROM member_grade_events WHERE client_key = ${input.clientKey}`;
    if (!prev) return false;
    if (Number(prev.memberId) !== memberId || prev.toGrade !== input.grade || prev.toTier !== input.tier || prev.reason !== input.reason) {
      throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次调整，请刷新页面后重新调整');
    }
    return true;
  };
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 先取操作编号的咨询锁、核对没有被「确认作废」（与作废串行；结果待确认时作废了，原请求晚到也不生效）
      await assertNotFenced(tx, input.clientKey, 'grade_adjust', erpOpAbandoned);
      const [m] = await tx<{ id: number }[]>`SELECT id FROM members WHERE id = ${memberId} FOR UPDATE`;
      if (!m) throw notFound('会员不存在');
      if (await replayed(tx)) return;
      const current = (await readGrade(tx, memberId))!;
      if (current.version !== input.expectedVersion) {
        throw conflict('GRADE_CHANGED', '这位会员的档阶刚刚有变化（充值、消费或到期处理），请刷新后再调整', { version: current.version });
      }
      const rules = await loadMembershipRules(tx);
      const date = await today(tx, deps.config.timezone, at);
      const { state } = await settleDue(tx, rules, memberId, current.state, date);
      const grade = asGrade(input.grade);
      const to: GradeState = grade === 0 ? { ...L0_STATE } : { grade, tier: input.tier as Tier, ...cycleFrom(rules, date), graceUntil: null };
      const spend = state.grade > 0 && state.cycleStart ? await spendSince(tx, memberId, state.cycleStart) : 0;
      await changeState(tx, memberId, 'manual', date, state, to, { cycleSpend: spend, staffId: ctx.actor.id, reason: input.reason, clientKey: input.clientKey });
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'member_grade_adjusted',
        targetType: 'member',
        targetId: memberId,
        detail: {
          from: gradeLabel(rules, state.grade, state.tier),
          to: gradeLabel(rules, to.grade, to.tier),
          cycle: to.cycleStart ? `${to.cycleStart} 至 ${to.cycleEnd}` : null,
          reason: input.reason,
        },
        ip: ctx.ip,
        businessDate: date,
      });
    });
  } catch (error) {
    // 同一编号并发提交：后到的一笔撞上唯一约束，按原来那条返回
    if (!(isUniqueViolation(error, 'member_grade_events_client_key_key') && (await replayed(deps.sql)))) throw error;
  }
  return memberGradeInfo(deps.sql, memberId, await today(deps.sql, deps.config.timezone));
}

const LookupQuery = z.object({ q: z.string('请输入手机号或会员号').trim().min(1, '请输入手机号或会员号').max(32, '最多 32 个字') });

/** 另一家店的只读查询：按完整手机号或会员号查一位会员的档阶与会籍；不含余额与流水；每次查询记审计 */
export async function lookupMember(deps: Deps, raw: unknown, ctx: OpContext): Promise<{ found: boolean; member: MemberLookupResult | null }> {
  const { q } = parse(LookupQuery, raw);
  const phone = q.replace(/[\s-]/g, '');
  const byPhone = /^1\d{10}$/.test(phone);
  const [m] = await deps.sql<(GradeRow & { id: number; memberNo: string; name: string; phone: string; status: 'active' | 'frozen' })[]>`
    SELECT id, member_no, name, phone, status, grade, tier, cycle_start, cycle_end, grace_until, grade_version FROM members
    WHERE ${byPhone ? deps.sql`phone = ${phone}` : deps.sql`upper(member_no) = upper(${q})`}`;
  const date = await today(deps.sql, deps.config.timezone, ctx.at);
  await writeAudit(deps.sql, {
    staffId: ctx.actor.id,
    action: 'member_lookup',
    targetType: 'member',
    targetId: m?.id,
    detail: { query: byPhone ? maskPhone(phone) : q, found: !!m },
    ip: ctx.ip,
    businessDate: date,
  });
  if (!m) return { found: false, member: null };
  const rules = await loadMembershipRules(deps.sql);
  const s = stateOf(m);
  return {
    found: true,
    member: {
      memberNo: m.memberNo,
      maskedName: maskName(m.name),
      maskedPhone: maskPhone(m.phone),
      grade: s.grade,
      tier: s.tier,
      label: gradeLabel(rules, s.grade, s.tier),
      cycleEnd: s.cycleEnd,
      inGrace: s.graceUntil !== null,
      graceUntil: s.graceUntil,
      status: m.status,
    },
  };
}

// ───────────────────────── 自检 ─────────────────────────

/**
 * 会员档阶自检（cli check、备份核验）：
 * ① 会员当前档阶 = 最后一条状态变化的结果（没有记录的是 L0）；② 状态变化前后相接；
 * ③ 最近一次自动任务处理完、没有出错，那一天之前到期的会员都处理了（按运行记录的营业日判断，旧备份核验也成立）
 */
export async function membershipChecks(db: Db): Promise<{ label: string; ok: boolean; detail: string }[]> {
  const [state] = await db<{ n: number; members: number }[]>`
    SELECT count(*) FILTER (WHERE (e.id IS NULL AND m.grade <> 0)
                               OR (e.id IS NOT NULL AND (m.grade, m.tier, m.cycle_start, m.cycle_end, m.grace_until)
                                                        IS DISTINCT FROM (e.to_grade, e.to_tier, e.cycle_start, e.cycle_end, e.grace_until)))::int AS n,
           count(*)::int AS members
    FROM members m
    LEFT JOIN LATERAL (SELECT * FROM member_grade_events x WHERE x.member_id = m.id ORDER BY x.id DESC LIMIT 1) e ON true`;
  const [chain] = await db<{ n: number; events: number }[]>`
    SELECT count(*) FILTER (WHERE (prev_id IS NULL AND (from_grade <> 0 OR from_tier IS NOT NULL))
                               OR (prev_id IS NOT NULL AND (from_grade, from_tier) IS DISTINCT FROM (prev_grade, prev_tier)))::int AS n,
           count(*)::int AS events
    FROM (SELECT from_grade, from_tier,
                 lag(id) OVER w AS prev_id, lag(to_grade) OVER w AS prev_grade, lag(to_tier) OVER w AS prev_tier
          FROM member_grade_events WINDOW w AS (PARTITION BY member_id ORDER BY id)) x`;
  const [last] = await db<{ businessDate: string; finishedAt: string | null; error: string | null }[]>`
    SELECT business_date, finished_at, error FROM membership_job_runs WHERE job = 'daily' ORDER BY business_date DESC LIMIT 1`;
  let jobOk = true;
  let jobDetail = '还没有运行记录';
  if (last) {
    const [due] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM members
      WHERE grade > 0 AND ((grace_until IS NULL AND cycle_end < ${last.businessDate}) OR grace_until < ${last.businessDate})`;
    jobOk = !!last.finishedAt && !last.error && due!.n === 0;
    jobDetail = !last.finishedAt
      ? `${last.businessDate} 的自动任务没有跑完`
      : last.error
        ? `${last.businessDate} 的自动任务出错：${last.error}`
        : due!.n
          ? `${due!.n} 位会员在 ${last.businessDate} 之前到期，还没有处理`
          : `最近一次 ${last.businessDate}，到期的会员都已处理`;
  }
  return [
    {
      label: '会员档阶与状态变化记录一致',
      ok: state!.n === 0,
      detail: state!.n ? `${state!.n} 位会员的档阶与最后一条状态变化不符` : `${state!.members} 位会员的档阶都是最后一条状态变化的结果`,
    },
    {
      label: '会员状态变化前后相接',
      ok: chain!.n === 0,
      detail: chain!.n ? `${chain!.n} 条状态变化的「从」与上一条的「到」不符` : `${chain!.events} 条状态变化逐条相接`,
    },
    { label: '会员到期处理（每天的自动任务）', ok: jobOk, detail: jobDetail },
  ];
}

// ───────────────────────── 接口 ─────────────────────────

const csvDate = (d: string | null) => d ?? '';

export function registerMembershipRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const todayNow = () => today(sql, deps.config.timezone);

  // 会员规则：前台、充值页、会员详情都要（档名、门槛、比例），登录即可读；改要「修改会员规则」
  app.get('/api/membership/rules', { preHandler: sessionOnly }, async () => loadMembershipRules(sql));
  // 整页保存：页面带上打开时读到的规则（based），这期间别人保存过就整页拒绝、让页面换成最新的再改，不悄悄改回别人的修改
  app.put('/api/membership/rules', { preHandler: guard('member.rules') }, async (req) => {
    const based = (req.body as { based?: unknown } | null)?.based;
    return saveRuleSetting(
      sql,
      RULES_KEY,
      loadMembershipRules,
      (before) => {
        if (based !== undefined && !sameJson(based, before)) {
          throw conflict('RULES_CHANGED', '会员规则刚被别人改过，页面已换成最新的规则，请核对后重新修改、保存');
        }
        // 页面没带的项（例如更新前打开的页面没有邀请体验的三项）保留现在的值
        return parse(RulesInput, { ...before, ...(req.body as object) });
      },
      ctxOf(req),
    );
  });

  app.get('/api/membership/overview', { preHandler: guard('member.retention') }, async () => {
    const date = await todayNow();
    return readSnapshot(sql, (tx) => membershipOverview(tx, date));
  });

  app.get('/api/membership/retention', { preHandler: guard('member.retention') }, async (req) => {
    const q = parse(RetentionQuery, req.query ?? {});
    return retentionList(sql, await todayNow(), q);
  });

  app.get('/api/membership/retention.csv', { preHandler: guard('member.retention') }, async (req, reply) => {
    const q = parse(RetentionQuery, req.query ?? {});
    const date = await todayNow();
    const rules = await loadMembershipRules(sql);
    const rows = await retentionList(sql, date, q);
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'membership_retention', detail: { kind: q.kind, within: q.within, rows: rows.length }, ip: req.ip, businessDate: date });
    const title = q.kind === 'grace' ? '补充期名单' : `到期提醒名单（${q.within} 天内）`;
    return csvReply(
      reply,
      `${title}-${date}.csv`,
      toCsv([
        ['会员号', '姓名', '手机号', '档阶', '周期开始', '周期到期', '补充期到', '还有几天', '周期储值消费', '保级要消费', '还差', '余额', '最近一次余额变动'],
        ...rows.map((r) => [
          r.memberNo,
          r.name,
          r.phone,
          gradeLabel(rules, r.grade, r.tier),
          r.cycleStart,
          r.cycleEnd,
          csvDate(r.graceUntil),
          r.daysLeft,
          formatYuan(r.spendCents),
          formatYuan(r.honorCents),
          formatYuan(r.needCents),
          formatYuan(r.balance),
          r.lastActivityAt ?? '',
        ]),
      ]),
    );
  });

  app.get('/api/membership/events', { preHandler: guard('member.retention') }, async (req) => {
    const q = parse(EventsQuery, req.query ?? {});
    return listGradeEvents(sql, q.date ?? (await todayNow()), q.kind);
  });

  app.get('/api/membership/lookup', { preHandler: guard('member.lookup') }, async (req) => lookupMember(deps, req.query ?? {}, ctxOf(req)));

  app.get('/api/members/:id/grade', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const date = await todayNow();
    return readSnapshot(sql, (tx) => memberGradeInfo(tx, id, date));
  });

  app.post('/api/members/:id/grade', { preHandler: guard('member.adjust') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return adjustMemberGrade(deps, id, req.body, ctxOf(req));
  });
}

