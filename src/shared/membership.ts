// 会员体系 v2（v0.7.23 第一期，docs/MEMBERSHIP.md 第 2 节）：档级、阶位、会籍周期的规则与纯计算。
// 页面预览与服务端记账用同一份算法。金额一律整数分；赠送比例用万分比（500 = 5%）；日期是营业日 YYYY-MM-DD。

import type { TrialSummary } from './trials';
import { shiftDate } from './labels';

export const MAX_GRADE = 6;
/** 档级 L0–L6 */
export type Grade = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** 阶位：0 初、1 享、2 尊（L0 没有阶位） */
export type Tier = 0 | 1 | 2;
export const TIER_LABELS = ['初', '享', '尊'] as const;

export interface GradeRule {
  /** 档名，例如「观澜」 */
  name: string;
  /** 充值门槛（分）：滚动累计充值达到它就升入这一档；L0 为 0 */
  thresholdCents: number;
  /** 赠送比例（万分比）：充值后在这一档时，本笔实收 × 比例 */
  bonusBp: number;
}

export interface MembershipRules {
  /** 下标 0–6 对应 L0–L6 */
  grades: GradeRule[];
  /** 享阶、尊阶：周期内净储值消费达到本档门槛的百分之几 */
  enjoyPct: number;
  honorPct: number;
  /** 会籍周期（天，也是累计充值的滚动天数）、补充期（天） */
  cycleDays: number;
  graceDays: number;
  /** 单笔最低充值（分）：首充、续充；0 = 不限 */
  firstRechargeMinCents: number;
  topUpMinCents: number;
  /** 到期前几天进提醒名单（从大到小） */
  reminderDays: number[];
  /** 已有会员上线、期初导入（老卡迁移）最高定到几档（会员文档：最高档要新充值达到门槛） */
  onboardMaxGrade: number;
  /**
   * 手牌 VIP 柜：下标 0–6 对应 L0–L6，值是这一档能用到几级 VIP 柜（0 = 不能用）。
   * 柜子的 1–5 级沿用店主的柜号清单（2026-10-27：3 万以下、5 万、10 万、20 万、30 万以上），换算到新档级待确认
   */
  vipLockerLevels: number[];
  /**
   * 低一档邀请体验（v0.7.25，M52）：体验几天、每位会员每月能邀请几次（0 = 不开放）、
   * 受邀人多少个月内只能被邀请或赠送一次（撤销的不算）
   */
  trialInviteDays: number;
  trialInvitesPerMonth: number;
  trialInviteeMonths: number;
}

/** 默认值按会员文档（2026-11-02）与 PENDING_DECISIONS「会员体系 v2」（待确认，后台「会员规则」可改） */
export const DEFAULT_MEMBERSHIP_RULES: MembershipRules = {
  grades: [
    { name: '青溪', thresholdCents: 0, bonusBp: 0 },
    { name: '云涧', thresholdCents: 5_000_00, bonusBp: 0 },
    { name: '潭影', thresholdCents: 10_000_00, bonusBp: 500 },
    { name: '观澜', thresholdCents: 30_000_00, bonusBp: 800 },
    { name: '望岳', thresholdCents: 50_000_00, bonusBp: 1000 },
    { name: '山海', thresholdCents: 100_000_00, bonusBp: 1500 },
    { name: '归墟', thresholdCents: 300_000_00, bonusBp: 1800 },
  ],
  enjoyPct: 30,
  honorPct: 60,
  cycleDays: 365,
  graceDays: 90,
  firstRechargeMinCents: 5_000_00,
  topUpMinCents: 5_000_00,
  reminderDays: [90, 60, 30, 7],
  onboardMaxGrade: 5,
  // L0–L3 → 1 级柜（原来所有会员都能用 1 级柜）；L4（5 万）→ 2 级；L5（10 万）→ 4 级；L6（30 万）→ 5 级
  vipLockerLevels: [1, 1, 1, 1, 2, 4, 5],
  trialInviteDays: 7,
  trialInvitesPerMonth: 1,
  trialInviteeMonths: 12,
};

/** 会员当前的档阶与会籍（存在会员一行上） */
export interface GradeState {
  grade: Grade;
  tier: Tier | null;
  /** 会籍周期的第一天、最后一天（L0 没有） */
  cycleStart: string | null;
  cycleEnd: string | null;
  /** 补充期的最后一天（不在补充期为空） */
  graceUntil: string | null;
}

export const L0_STATE: GradeState = { grade: 0, tier: null, cycleStart: null, cycleEnd: null, graceUntil: null };

export const asGrade = (n: number): Grade => Math.max(0, Math.min(MAX_GRADE, Math.trunc(n))) as Grade;

/** 「L3 观澜 · 享」；L0 只有档名 */
export function gradeLabel(rules: MembershipRules, grade: number, tier: number | null): string {
  const name = rules.grades[grade]?.name ?? '';
  if (grade === 0 || tier === null) return `L${grade} ${name}`;
  return `L${grade} ${name} · ${TIER_LABELS[tier as Tier] ?? ''}`;
}

/** 金额（滚动累计充值）够得上的最高档；maxGrade 限定上线定档、老卡迁移的上限 */
export function gradeForAmount(rules: MembershipRules, cents: number, maxGrade: number = MAX_GRADE): Grade {
  let grade = 0;
  for (let g = 1; g <= Math.min(MAX_GRADE, maxGrade); g++) {
    const t = rules.grades[g]?.thresholdCents;
    if (t !== undefined && t > 0 && cents >= t) grade = g;
  }
  return grade as Grade;
}

/** 本笔赠金：实收 × 充值后所在档的比例，算到分、分以下舍去 */
export function bonusFor(rules: MembershipRules, grade: number, paidCents: number): number {
  const bp = rules.grades[grade]?.bonusBp ?? 0;
  return Math.floor((paidCents * bp) / 10_000);
}

/** 本档升享阶、尊阶（也是保级）要的周期净储值消费（分） */
export function tierTargets(rules: MembershipRules, grade: number): { enjoy: number; honor: number } {
  const t = rules.grades[grade]?.thresholdCents ?? 0;
  return { enjoy: Math.ceil((t * rules.enjoyPct) / 100), honor: Math.ceil((t * rules.honorPct) / 100) };
}

/** 周期消费对应的阶位（L0 没有阶位） */
export function tierForSpend(rules: MembershipRules, grade: number, spendCents: number): Tier | null {
  if (grade === 0) return null;
  const { enjoy, honor } = tierTargets(rules, grade);
  return spendCents >= honor ? 2 : spendCents >= enjoy ? 1 : 0;
}

/** 新周期：从 start 起 cycleDays 天（含当天） */
export function cycleFrom(rules: MembershipRules, start: string): { cycleStart: string; cycleEnd: string } {
  return { cycleStart: start, cycleEnd: shiftDate(start, rules.cycleDays - 1) };
}

/** 滚动累计充值的起点：today 往前 cycleDays 天（含 today） */
export const rollingFrom = (rules: MembershipRules, today: string) => shiftDate(today, -(rules.cycleDays - 1));

export interface RechargeOutcome {
  gradeBefore: Grade;
  gradeAfter: Grade;
  upgraded: boolean;
  /** 按充值后所在档算的赠金 */
  bonusCents: number;
  /** 充完以后的滚动累计 */
  rollingAfterCents: number;
  /** 下一档：门槛与还差多少（已是最高档为空） */
  next: { grade: Grade; name: string; needCents: number; bonusBp: number } | null;
}

/**
 * 一笔充值的结果：滚动累计（含本笔）够得上更高档就升档（可以连跳几档），赠金按充值后所在档的比例。
 * rollingBeforeCents 是这笔之前、滚动周期内已入账的充值实收合计。
 */
export function rechargeOutcome(rules: MembershipRules, gradeBefore: Grade, rollingBeforeCents: number, paidCents: number): RechargeOutcome {
  const rollingAfterCents = rollingBeforeCents + paidCents;
  const reached = gradeForAmount(rules, rollingAfterCents);
  const gradeAfter = (reached > gradeBefore ? reached : gradeBefore) as Grade;
  const nextGrade = gradeAfter < MAX_GRADE ? ((gradeAfter + 1) as Grade) : null;
  const nextRule = nextGrade === null ? null : rules.grades[nextGrade];
  return {
    gradeBefore,
    gradeAfter,
    upgraded: gradeAfter > gradeBefore,
    bonusCents: bonusFor(rules, gradeAfter, paidCents),
    rollingAfterCents,
    next:
      nextGrade === null || !nextRule
        ? null
        : { grade: nextGrade, name: nextRule.name, needCents: Math.max(0, nextRule.thresholdCents - rollingAfterCents), bonusBp: nextRule.bonusBp },
  };
}

/** 状态变化的种类（状态变化记录只追加） */
export const GRADE_EVENT_KINDS = [
  'go_live',
  'import',
  'recharge_up',
  'spend_up',
  'retain',
  'grace_start',
  'grace_retain',
  'downgrade',
  'manual',
] as const;
export type GradeEventKind = (typeof GRADE_EVENT_KINDS)[number];
export const GRADE_EVENT_LABELS: Record<GradeEventKind, string> = {
  go_live: '上线定档',
  import: '期初导入定档',
  recharge_up: '充值升档',
  spend_up: '消费升阶',
  retain: '到期保级',
  grace_start: '进入补充期',
  grace_retain: '补充期内保级',
  downgrade: '降档',
  manual: '手动调整',
};

export interface ExpiryStep {
  kind: 'retain' | 'grace_start' | 'grace_retain' | 'downgrade';
  next: GradeState;
}

/**
 * 到期处理的一步（每天营业日开始时对每位会员反复调用，直到返回空）：
 * · 周期结束、不在补充期：周期消费 ≥ 尊阶门槛保级（保持尊阶，新周期从原到期日的下一天起算）；
 *   ≥ 享阶门槛进补充期（照享原档）；不够降一档、进下一档的尊阶（新周期从到期日的下一天起算；L1 降到 L0）。
 * · 补充期结束：期内（从原周期开始累计）够尊阶门槛保级、新周期从原到期日的下一天起算；不够降一档，新周期从补充期结束的下一天起算。
 * spendCents 是从周期第一天到「这一步看的那一天」（周期或补充期的最后一天）的净储值消费。
 * 日期都按规则推出来、不看哪天跑的任务，补跑的结果与当天跑的一样。
 */
export function expiryStep(rules: MembershipRules, state: GradeState, spendCents: number, today: string): ExpiryStep | null {
  if (state.grade === 0 || !state.cycleStart || !state.cycleEnd) return null;
  const { enjoy, honor } = tierTargets(rules, state.grade);
  const downgrade = (from: string): ExpiryStep => {
    const grade = (state.grade - 1) as Grade;
    if (grade === 0) return { kind: 'downgrade', next: { ...L0_STATE } };
    return { kind: 'downgrade', next: { grade, tier: 2, ...cycleFrom(rules, from), graceUntil: null } };
  };
  if (state.graceUntil === null) {
    if (state.cycleEnd >= today) return null;
    const after = shiftDate(state.cycleEnd, 1);
    if (spendCents >= honor) return { kind: 'retain', next: { grade: state.grade, tier: 2, ...cycleFrom(rules, after), graceUntil: null } };
    if (spendCents >= enjoy && rules.graceDays > 0) {
      return { kind: 'grace_start', next: { ...state, graceUntil: shiftDate(state.cycleEnd, rules.graceDays) } };
    }
    return downgrade(after);
  }
  if (state.graceUntil >= today) return null;
  if (spendCents >= honor) {
    return { kind: 'grace_retain', next: { grade: state.grade, tier: 2, ...cycleFrom(rules, shiftDate(state.cycleEnd, 1)), graceUntil: null } };
  }
  return downgrade(shiftDate(state.graceUntil, 1));
}

/** 这一步要看的消费区间的最后一天：周期结束时看周期，补充期结束时看到补充期最后一天 */
export const expiryWindowEnd = (state: GradeState): string | null => state.graceUntil ?? state.cycleEnd;

/** 还有几天到期（周期最后一天算 0 天）；补充期按补充期最后一天算 */
export function daysToExpiry(state: GradeState, today: string): number | null {
  const end = state.graceUntil ?? state.cycleEnd;
  if (!end) return null;
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** 这一档能用到几级 VIP 柜（散客为 0） */
export const lockerLevelOf = (rules: MembershipRules, grade: number): number => rules.vipLockerLevels[grade] ?? 0;

/** 单笔最低充值：首充（没有充值、没有期初的会员）或续充；0 = 不限 */
export const rechargeMinimum = (rules: MembershipRules, first: boolean): number => (first ? rules.firstRechargeMinCents : rules.topUpMinCents);

/** 还有 daysLeft 天到期时落在哪一档提醒（到期前 90 / 60 / 30 / 7 天）；不在提醒范围为空 */
export function reminderBucket(rules: MembershipRules, daysLeft: number | null): number | null {
  if (daysLeft === null || daysLeft < 0) return null;
  for (const d of [...rules.reminderDays].sort((a, b) => a - b)) if (daysLeft <= d) return d;
  return null;
}

/** 19 个状态：L0 一个，L1–L6 各分初、享、尊 */
export const GRADE_STATES: { grade: Grade; tier: Tier | null }[] = [
  { grade: 0, tier: null },
  ...([1, 2, 3, 4, 5, 6] as Grade[]).flatMap((grade) => ([0, 1, 2] as Tier[]).map((tier) => ({ grade, tier }))),
];

/** 他店查询：姓名中间遮住（两个字遮后一个） */
export function maskName(name: string): string {
  const chars = [...name.trim()];
  if (chars.length <= 1) return '*';
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

export const maskPhone = (phone: string): string => (phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : '****');

// ───────────────────────── 接口的数据 ─────────────────────────

/** 会员一行上的档阶（会员一览、工作台、前台显示徽标） */
export interface MemberGradeFields {
  grade: Grade;
  tier: Tier | null;
  cycleEnd: string | null;
  graceUntil: string | null;
}

/** 一条状态变化记录 */
export interface GradeEventRow {
  id: number;
  kind: GradeEventKind;
  businessDate: string;
  fromGrade: Grade;
  fromTier: Tier | null;
  toGrade: Grade;
  toTier: Tier | null;
  cycleStart: string | null;
  cycleEnd: string | null;
  graceUntil: string | null;
  /** 当时的周期净储值消费（分） */
  cycleSpend: number;
  /** 上线定档、期初导入、充值升档时的累计充值（分） */
  rollingRecharge: number | null;
  rechargeDocNo: string | null;
  consumptionDocNo: string | null;
  /** 经办人；系统自动为空 */
  staffName: string | null;
  reason: string;
  createdAt: string;
}

/** 会员详情的等级卡 */
export interface MemberGradeInfo {
  memberId: number;
  /** 当前状态（到期没处理的已按规则推算到今天） */
  state: GradeState;
  /** 会员档阶的版本号（手动调整时核对） */
  version: number;
  today: string;
  label: string;
  /** 周期开始到今天的净储值消费（分）；L0 为 0 */
  cycleSpendCents: number;
  /** 本档升享阶、尊阶（也是保级）要的周期消费；L0 为空 */
  targets: { enjoy: number; honor: number } | null;
  inGrace: boolean;
  /** 离周期（补充期）结束还有几天；L0 为空 */
  daysLeft: number | null;
  /** 落在到期提醒的哪一档（90 / 60 / 30 / 7） */
  reminder: number | null;
  /** 滚动 365 天累计充值（含今天，分） */
  rollingRechargeCents: number;
  /** 还没有充值、没有期初：下一笔按首充最低 */
  firstRecharge: boolean;
  /** 下一档：门槛、按滚动累计还差多少、赠送比例；已是最高档为空 */
  next: { grade: Grade; name: string; thresholdCents: number; needCents: number; bonusBp: number } | null;
  /** 能用到几级 VIP 柜 */
  lockerLevel: number;
  /** 状态变化记录，最近的在前（最多 50 条） */
  events: GradeEventRow[];
}

/** 前台、VIP 柜核对用的档阶 */
export interface MemberGradeBadge {
  memberId: number;
  grade: Grade;
  tier: Tier | null;
  label: string;
  cycleEnd: string | null;
  graceUntil: string | null;
  daysLeft: number | null;
  reminder: number | null;
  /** 能用到几级 VIP 柜：自己的与生效中的临时身份取高的（v0.7.25，M51） */
  lockerLevel: number;
  /** 生效中的临时身份（v0.7.25）：「L3 观澜 · 初」、到哪天 */
  trial: { grade: Grade; label: string; endsOn: string; kind: 'invite' | 'gift' } | null;
}

/** 每天自动任务的运行记录 */
export interface MembershipJobRun {
  businessDate: string;
  startedAt: string;
  finishedAt: string | null;
  processed: number;
  retained: number;
  grace: number;
  downgraded: number;
  error: string | null;
  /** 这一次把到期的临时身份结束了几条（v0.7.25；只在当次的结果里，不存运行记录） */
  trialsExpired?: number;
}

/** 后台「会员体系」看板 */
export interface MembershipOverview {
  today: string;
  /** 已有会员上线定档（启用会员体系 v2 的那一天） */
  live: { businessDate: string; at: string; graded: number } | null;
  /** 19 个状态各多少人（状态与余额都按会员一行） */
  states: { grade: Grade; tier: Tier | null; count: number; balance: number }[];
  /** 本月（营业日所在的自然月）各种状态变化的人次 */
  month: { from: string; to: string; counts: Record<GradeEventKind, number> };
  /** 未来 N 天到期（不含补充期）的人数，按提醒天数 */
  expiring: { within: number; count: number }[];
  /** 在补充期的人数 */
  grace: number;
  /** 过了到期日还没处理的人数（自动任务没跑或出错，应为 0） */
  overdue: number;
  /** 今天的自动任务；最近 14 天的运行记录 */
  jobToday: MembershipJobRun | null;
  jobs: MembershipJobRun[];
  /** 临时身份（v0.7.25）：体验中、本月发起、到期、转正、撤销 */
  trials: TrialSummary;
}

/** 到期提醒名单、补充期名单的一行 */
export interface RetentionRow {
  memberId: number;
  memberNo: string;
  name: string;
  phone: string;
  grade: Grade;
  tier: Tier | null;
  cycleStart: string;
  cycleEnd: string;
  graceUntil: string | null;
  daysLeft: number;
  reminder: number | null;
  /** 周期开始到今天的净储值消费 */
  spendCents: number;
  /** 保级要的周期消费、还差多少 */
  honorCents: number;
  needCents: number;
  balance: number;
  lastActivityAt: string | null;
}

/** 看板里的状态变化（今天处理了谁、为什么） */
export interface GradeEventListRow extends GradeEventRow {
  memberId: number;
  memberNo: string;
  memberName: string;
}

/** 他店查询的结果：不含余额与流水 */
export interface MemberLookupResult {
  memberNo: string;
  maskedName: string;
  maskedPhone: string;
  grade: Grade;
  tier: Tier | null;
  label: string;
  cycleEnd: string | null;
  inGrace: boolean;
  graceUntil: string | null;
  status: 'active' | 'frozen';
}
