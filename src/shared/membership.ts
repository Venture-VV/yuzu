// 会员体系 v2（v0.7.23 第一期，docs/MEMBERSHIP.md 第 2 节）：档级、阶位、会籍周期的规则与纯计算。
// 页面预览与服务端记账用同一份算法。金额一律整数分；赠送比例用万分比（500 = 5%）；日期是营业日 YYYY-MM-DD。

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
  /** 已有会员上线、老卡迁移最高定到几档（会员文档：最高档要新充值达到门槛） */
  onboardMaxGrade: number;
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
  'recharge_up',
  'recharge_reversed',
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
  recharge_up: '充值升档',
  recharge_reversed: '撤销充值退回原档',
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

/** 手牌 VIP 柜原来的 1–5 级（店主 2026-10-27 答复：3 万以下、5 万、10 万、20 万、30 万以上）对应的新档级（待确认） */
export const LEGACY_VIP_LEVEL_TO_GRADE: Record<number, Grade> = { 1: 1, 2: 4, 3: 5, 4: 5, 5: 6 };
