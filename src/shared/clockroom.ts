// 钟房（S6 第二步，v0.7.1）：上牌与轮钟队列、派钟、上钟 / 下钟计时、加钟、退钟，以及技师提成规则。
// 规则按汤泉、足浴行业常见做法先定默认值（标「待确认」），店主在后台「技师」里改：
//   · 轮钟按上牌先后排队，派轮钟时技师的牌排到所有待钟技师之后（「上钟后牌退到最后」）；
//   · 点钟不动牌（点钟的技师回来仍在原位）；被客人退钟回原位，连续被退 3 次排到队尾；休息回岗排到队尾；
//   · 轮钟不派给排在第一位的技师时要写原因（记进钟房日志）；
//   · 加钟由原技师继续，记为点钟（客人选了继续让这位技师做）；
//   · 提成按项目售价的比例（默认 40%），点钟每钟另加 ¥10；可以按项目改成每钟固定金额（按价格档）。

import { PRICE_TIERS, type PriceTier } from './catalog';
import type { CallType, Technician, TechnicianRules } from './technicians';

export interface ClockroomRules {
  /** 轮钟什么时候排到队尾：派钟时（默认）/ 下钟后 */
  afterRotation: 'dispatch' | 'finish';
  /** 点钟之后的位置：不动牌（默认）/ 轮到时在上点钟就排到队尾 / 点钟也算一轮、排到队尾 */
  afterDesignated: 'keep' | 'passed' | 'end';
  /** 被客人退钟、取消派钟后回到原来的位置（默认是） */
  rejectKeepsPlace: boolean;
  /** 连续被退钟几次排到队尾（默认 3，0 为不排） */
  rejectEndAfter: number;
  /** 休息、离岗后回牌排到队尾（默认是） */
  backToEnd: boolean;
  /** 轮钟不派给排在第一位的技师时必须写原因（默认是） */
  skipNeedsReason: boolean;
  /** 项目没有填时长时一钟按多少分钟（默认 60） */
  defaultMinutes: number;
  /** 快到钟提前几分钟提醒（默认 5） */
  remindMinutes: number;
  /** 加钟记为点钟（默认是） */
  extensionAsDesignated: boolean;
}

export const DEFAULT_CLOCKROOM_RULES: ClockroomRules = {
  afterRotation: 'dispatch',
  afterDesignated: 'keep',
  rejectKeepsPlace: true,
  rejectEndAfter: 3,
  backToEnd: true,
  skipNeedsReason: true,
  defaultMinutes: 60,
  remindMinutes: 5,
  extensionAsDesignated: true,
};

export const AFTER_ROTATION_LABELS: Record<ClockroomRules['afterRotation'], string> = {
  dispatch: '派钟时排到队尾（上钟后牌退到最后）',
  finish: '下钟后排到队尾',
};
export const AFTER_DESIGNATED_LABELS: Record<ClockroomRules['afterDesignated'], string> = {
  keep: '点钟不动牌（回来仍在原位）',
  passed: '点钟期间轮到了就排到队尾',
  end: '点钟也算一轮，排到队尾',
};

export const TECH_STATES = ['on', 'rest', 'off'] as const;
export type TechState = (typeof TECH_STATES)[number];

export const SESSION_STATUSES = ['waiting', 'serving', 'done', 'cancelled', 'rejected'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const EVENT_KINDS = ['sign_in', 'rest', 'back', 'sign_out', 'to_end', 'dispatch', 'skip', 'start', 'extend', 'finish', 'cancel', 'reject', 'queue', 'room'] as const;
export type ClockEventKind = (typeof EVENT_KINDS)[number];
export const EVENT_KIND_LABELS: Record<ClockEventKind, string> = {
  sign_in: '上牌',
  rest: '休息',
  back: '回牌',
  sign_out: '下牌',
  to_end: '排到队尾',
  dispatch: '派钟',
  skip: '跳过',
  start: '上钟',
  extend: '加钟',
  finish: '下钟',
  cancel: '取消派钟',
  reject: '退钟',
  queue: '调整排位',
  room: '换房间',
};

/** 钟房看板上的技师 */
export interface BoardTechnician extends Technician {
  state: TechState;
  /** 在岗技师在轮钟队列里的位置（1 起）；休息、未上牌为 null */
  position: number | null;
  /** 在钟上（上钟中）或已派了钟（待上钟） */
  busy: { sessionId: number; status: 'waiting' | 'serving' } | null;
  /** 排在他后面、还在等他的点钟（等钟）数 */
  waiting: number;
  todayClocks: number;
  rejectStreak: number;
}

export interface BoardSession {
  id: number;
  sessionNo: string;
  technicianId: number;
  techNo: string;
  techName: string;
  visitId: number;
  tagCode: string;
  zone: 'male' | 'female';
  guest: string;
  itemId: number;
  itemName: string;
  callType: CallType;
  clocks: number;
  minutes: number;
  status: 'waiting' | 'serving';
  createdAt: string;
  startedAt: string | null;
  /** 计划下钟时刻（上钟后才有） */
  plannedEnd: string | null;
  /** 服务的房间（v0.7.16，空间台账里的技师服务类空间；没选为 null） */
  space: { id: number; code: string; displayName: string } | null;
  /** 房间的版本号（每换一次加 1）：换房间时原样带回，对不上（刚被改过）就拒绝 */
  spaceVersion: number;
}

export interface ClockroomBoard {
  serverTime: string;
  businessDate: string;
  rules: ClockroomRules;
  techRules: TechnicianRules;
  technicians: BoardTechnician[];
  sessions: BoardSession[];
  today: { clocks: number; designated: number; rotation: number };
}

export interface ClockEvent {
  id: number;
  at: string;
  kind: ClockEventKind;
  techNo: string | null;
  techName: string | null;
  sessionNo: string | null;
  staffName: string;
  text: string;
}

// ───────────────────────── 提成 ─────────────────────────

/** 一个项目（或默认）的提成：按明细金额的比例（基点，40% = 4000），或每钟固定金额（按价格档，分） */
export type CommissionBase = { kind: 'percent'; rateBp: number } | { kind: 'fixed'; perClock: Partial<Record<PriceTier, number>> };

export interface CommissionRules {
  base: CommissionBase;
  /** 点钟每钟另加（分） */
  designatedBonus: number;
  /** 按项目覆盖默认（键为项目编号） */
  items: Record<string, CommissionBase>;
}

export const DEFAULT_COMMISSION_RULES: CommissionRules = {
  base: { kind: 'percent', rateBp: 4000 },
  designatedBonus: 1000,
  items: {},
};

export const MAX_RATE_BP = 10_000;

/** 一条技师明细的提成（金额与钟数取正数，冲回时由调用方乘 −1，保证正负完全相抵） */
export function lineCommission(
  rules: CommissionRules,
  line: { itemId: number | null; tier: PriceTier | null; quantity: number; amount: number; callType: CallType },
): { base: number; bonus: number } {
  const rule = (line.itemId !== null && rules.items[String(line.itemId)]) || rules.base;
  let base: number;
  if (rule.kind === 'percent') {
    base = Math.round((line.amount * rule.rateBp) / 10_000);
  } else {
    const tier = line.tier ?? 'standard';
    const per = rule.perClock[tier] ?? PRICE_TIERS.map((t) => rule.perClock[t]).find((v) => v !== undefined) ?? 0;
    base = per * line.quantity;
  }
  const bonus = line.callType === 'designated' ? rules.designatedBonus * line.quantity : 0;
  return { base, bonus };
}

export const describeCommissionBase = (b: CommissionBase) =>
  b.kind === 'percent'
    ? `售价的 ${(b.rateBp / 100).toFixed(b.rateBp % 100 ? 2 : 0)}%`
    : `每钟 ${PRICE_TIERS.filter((t) => b.perClock[t] !== undefined)
        .map((t) => `${{ standard: '标准', professional: '专业', premium: '优选' }[t]} ¥${(b.perClock[t]! / 100).toFixed(2)}`)
        .join(' / ')}`;

export interface CommissionVersion {
  id: number | null;
  rules: CommissionRules;
  effectiveAt: string | null;
  note: string;
  createdByName: string | null;
}

export interface CommissionSettings {
  current: CommissionVersion;
  history: CommissionVersion[];
}
