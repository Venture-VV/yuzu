// 技师（S6 第一步，v0.7.0）：技师名册、挂技师项目时选技师（点钟 / 轮钟）、技师业绩。
// 钟房看板、轮钟排队、上下钟计时与提成在第二步（ROADMAP 第 10 节）。
//
// 汤崎价目表的「标准 / 专业 / 优选」三档对应技师等级：开启「价格跟技师等级」时，选了技师就按他的等级取价
// （只有一档价格的项目不分等级，都按这一档）。规则先按汤泉常见做法设默认值，标「待确认」，店主在后台改。

import { PRICE_TIER_LABELS, type PriceTier } from './catalog';

export const CALL_TYPES = ['rotation', 'designated'] as const;
export type CallType = (typeof CALL_TYPES)[number];
export const CALL_TYPE_LABELS: Record<CallType, string> = { rotation: '轮钟', designated: '点钟' };

/** 工号：1–6 位数字或字母，例如 08、A12 */
export const TECH_NO_PATTERN = /^[0-9A-Za-z]{1,6}$/;
export const MAX_TECH_NAME = 16;

export const gradeLabel = (grade: PriceTier) => `${PRICE_TIER_LABELS[grade]}技师`;

export interface Technician {
  id: number;
  techNo: string;
  name: string;
  gender: 'male' | 'female';
  /** 等级，对应价目表的价格档 */
  grade: PriceTier;
  /** 可做的项目分类；空为全部需要技师的项目 */
  skills: string[];
  active: boolean;
  sortOrder: number;
  note: string;
  isSynthetic: boolean;
}

export interface TechnicianRules {
  /** 技师功能：关闭时前台挂账与升级前完全一样（默认关闭） */
  enabled: boolean;
  /** 挂「需要技师」的项目必须选技师（默认是） */
  requireTechnician: boolean;
  /** 价格跟技师等级：选了技师按他的等级取价（默认是，待确认） */
  tierByGrade: boolean;
  /** 选技师时默认的上钟方式（默认轮钟，待确认） */
  defaultCallType: CallType;
}

export const DEFAULT_TECHNICIAN_RULES: TechnicianRules = {
  enabled: false,
  requireTechnician: true,
  tierByGrade: true,
  defaultCallType: 'rotation',
};

/** 明细上的技师（随明细留存；作废的明细照样显示是谁做的） */
export interface LineTechnician {
  id: number;
  techNo: string;
  name: string;
  callType: CallType;
}

export const technicianText = (t: { techNo: string; name: string; callType?: CallType }) =>
  `${t.techNo} 号 ${t.name}${t.callType ? ` · ${CALL_TYPE_LABELS[t.callType]}` : ''}`;

/** 这位技师能不能做这个项目：可做分类为空表示全部；价格跟等级时，多档项目要有他这一档的价格 */
export function canServe(
  t: Pick<Technician, 'skills' | 'grade' | 'active'>,
  item: { category: string; prices: { tier: PriceTier }[] },
  tierByGrade: boolean,
): string | null {
  if (!t.active) return '已停用';
  const category = item.category || '其他';
  if (t.skills.length > 0 && !t.skills.includes(category)) return `不做「${category}」`;
  if (tierByGrade && item.prices.length > 1 && !item.prices.some((p) => p.tier === t.grade)) return `这个项目没有${PRICE_TIER_LABELS[t.grade]}档价格`;
  return null;
}

/** 选了技师时的价格档：价格跟等级且项目分档时取技师等级，否则用所选的档 */
export function tierFor(t: Pick<Technician, 'grade'>, item: { prices: { tier: PriceTier }[] }, chosen: PriceTier, tierByGrade: boolean): PriceTier {
  return tierByGrade && item.prices.length > 1 ? t.grade : chosen;
}

export const TECHNICIAN_RULE_LABELS: Record<keyof TechnicianRules, string> = {
  enabled: '技师功能',
  requireTechnician: '挂技师项目必须选技师',
  tierByGrade: '价格跟技师等级',
  defaultCallType: '默认上钟方式',
};

/** 前台选技师用：规则与在职技师（含今日已上的钟数，帮助排轮钟） */
export interface FrontdeskTechnicians {
  rules: TechnicianRules;
  technicians: (Technician & { todayClocks: number })[];
}

/** 后台「技师」分区 */
export interface TechnicianAdmin {
  rules: TechnicianRules;
  rulesUpdatedAt: string | null;
  rulesUpdatedBy: string | null;
  technicians: (Technician & { createdAt: string; updatedAt: string; lineCount: number })[];
  /** 项目分类（技师可做的分类从这里选） */
  categories: string[];
}

/** 技师业绩：时段内结账的技师明细（结账那一刻的明细，时段内反结账的冲回，与部门构成同一口径） */
export interface TechnicianReport {
  from: string;
  to: string;
  rows: {
    technicianId: number;
    techNo: string;
    name: string;
    grade: PriceTier;
    active: boolean;
    /** 钟数（明细数量之和） */
    clocks: number;
    designated: number;
    rotation: number;
    amount: number;
  }[];
  totals: { clocks: number; designated: number; rotation: number; amount: number };
  /** 需要技师、但挂账时没有指定技师的明细（规则不要求必须选技师时会有） */
  unassigned: { clocks: number; amount: number };
}
