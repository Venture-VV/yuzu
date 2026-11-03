// 券与会员权益（v0.7.20，飞书 RQ-006 后半；docs/COUPONS.md）。前后端共用：券模板的条件、抵扣算法、券码、券的状态。
// 金额都是分。

import { formatYuan } from './money';

export const COUPON_KINDS = ['cash', 'discount', 'exchange'] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];
export const COUPON_KIND_LABELS: Record<CouponKind, string> = { cash: '代金券', discount: '折扣券', exchange: '兑换券' };

export const COUPON_SCOPES = ['all', 'categories', 'items'] as const;
export type CouponScope = (typeof COUPON_SCOPES)[number];
export const COUPON_SCOPE_LABELS: Record<CouponScope, string> = { all: '整单', categories: '指定部门', items: '指定项目' };

export const COUPON_VALIDITIES = ['fixed', 'days'] as const;
export type CouponValidity = (typeof COUPON_VALIDITIES)[number];

/** 发券规则的种类：开卡礼（建档时）、升级礼（充值让等级升高时）、生日礼（生日当月）、充值赠券（充值套餐上挂的券） */
export const COUPON_RULE_KINDS = ['open_card', 'level_up', 'birthday', 'recharge'] as const;
export type CouponRuleKind = (typeof COUPON_RULE_KINDS)[number];
export const COUPON_RULE_KIND_LABELS: Record<CouponRuleKind, string> = {
  open_card: '开卡礼',
  level_up: '升级礼',
  birthday: '生日礼',
  recharge: '充值赠券',
};
/** 发券记录的种类：手动发给会员、无记名批次，加上四种自动规则 */
export const COUPON_ISSUE_KINDS = ['manual', 'batch', ...COUPON_RULE_KINDS] as const;
export type CouponIssueKind = (typeof COUPON_ISSUE_KINDS)[number];
export const COUPON_ISSUE_KIND_LABELS: Record<CouponIssueKind, string> = {
  manual: '手动发',
  batch: '无记名券',
  ...COUPON_RULE_KIND_LABELS,
};

/** 手动发券一次最多几张；无记名券一批最多几张 */
export const MAX_MANUAL_COUPONS = 10;
export const MAX_BATCH_COUPONS = 500;

// ───────────── 券码 ─────────────

/** 券码的字母表：去掉易混的 0、O、1、I，共 32 个字符；券码 12 位 */
export const COUPON_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const STORE_COUPON_CODE_PATTERN = /^[2-9A-HJ-NP-Z]{12}$/;
/** 输入的券码规范化：去掉空格与连字符、字母大写 */
export const normalizeStoreCouponCode = (input: string) => input.replace(/[\s-]/g, '').toUpperCase();
/** 显示成 4-4-4 */
export const formatStoreCouponCode = (code: string) => code.replace(/(.{4})(?=.)/g, '$1-');
/** 只显示后 4 位（对账包里的无记名券） */
export const maskStoreCouponCode = (code: string) => `••••-••••-${code.slice(-4)}`;

// ───────────── 券的条件与抵扣 ─────────────

/** 券模板的条件（发过券后不能改，见 docs/COUPONS.md 第 1 节） */
export interface CouponTerms {
  kind: CouponKind;
  /** 代金券面额 */
  faceValue: number | null;
  /** 折扣券：按百分比，88 = 8.8 折 */
  ratePercent: number | null;
  /** 折扣券「最多减」、兑换券「最多抵」；null = 不限 */
  maxOff: number | null;
  /** 满多少可用（按适用的明细算）；0 = 不限；兑换券没有门槛 */
  threshold: number;
  scope: CouponScope;
  /** 指定部门：门票、客房、价目表的分类、其他（手动金额、赔偿等）、未分类（与部门营业额快照同一口径） */
  scopeCategories: string[];
  /** 指定价目项目 */
  scopeItems: number[];
  /** 兑换券：兑换哪个价目项目，或哪个票种（二选一） */
  exchangeItemId: number | null;
  exchangeTicketTypeId: number | null;
}

/** 结账时的一条明细（含刚算出的门票），部门与部门营业额快照同一口径 */
export interface CouponLine {
  id: number;
  category: string;
  itemId: number | null;
  ticketTypeId: number | null;
  name: string;
  unitPrice: number;
  quantity: number;
  amount: number;
}

export type CouponEvaluation =
  | { usable: true; amount: number; lineIds: number[]; base: number }
  | { usable: false; reason: string; base: number };

const inScope = (t: CouponTerms, l: CouponLine) =>
  t.scope === 'all' || (t.scope === 'categories' ? t.scopeCategories.includes(l.category) : l.itemId !== null && t.scopeItems.includes(l.itemId));

/**
 * 这张券在这些明细上能抵多少（不找零）：
 *   · 代金券：适用明细合计满门槛才能用，抵 min(面额, 适用合计)；
 *   · 折扣券：适用明细合计满门槛才能用，抵 适用合计 ×（1 − 折扣），算到分、分以下舍去，不超过「最多减」；
 *   · 兑换券：账单上这个项目（票种）单价最高的那一份，不超过「最多抵」。
 * lineIds 是适用的明细（部门营业额快照按它们的金额比例分摊抵扣）。
 */
export function evaluateCoupon(t: CouponTerms, lines: readonly CouponLine[]): CouponEvaluation {
  if (t.kind === 'exchange') {
    const candidates = lines.filter(
      (l) => l.amount > 0 && (t.exchangeItemId !== null ? l.itemId === t.exchangeItemId : l.ticketTypeId !== null && l.ticketTypeId === t.exchangeTicketTypeId),
    );
    if (candidates.length === 0) return { usable: false, reason: '账单上没有这张券能兑换的项目', base: 0 };
    const best = candidates.reduce((a, b) => (b.unitPrice > a.unitPrice || (b.unitPrice === a.unitPrice && b.id < a.id) ? b : a));
    const unit = Math.min(best.unitPrice, best.amount);
    const amount = t.maxOff !== null ? Math.min(unit, t.maxOff) : unit;
    return { usable: true, amount, lineIds: [best.id], base: unit };
  }
  const applicable = lines.filter((l) => l.amount > 0 && inScope(t, l));
  const base = applicable.reduce((s, l) => s + l.amount, 0);
  if (base <= 0) return { usable: false, reason: '账单上没有这张券适用的项目', base };
  if (base < t.threshold) return { usable: false, reason: `适用的项目满 ${formatYuan(t.threshold)} 才能用（现在 ${formatYuan(base)}）`, base };
  let amount = t.kind === 'cash' ? Math.min(t.faceValue ?? 0, base) : Math.floor((base * (100 - (t.ratePercent ?? 100))) / 100);
  if (t.kind === 'discount' && t.maxOff !== null) amount = Math.min(amount, t.maxOff);
  if (amount <= 0) return { usable: false, reason: '适用的金额太小，这张券抵不了钱', base };
  return { usable: true, amount, lineIds: applicable.map((l) => l.id), base };
}

/** 「8.8 折」：rate 88 → 8.8，90 → 9 */
export const discountText = (ratePercent: number) => `${Number((ratePercent / 10).toFixed(1))} 折`;

/** 券的一句话说明：「代金券 ¥50 · 满 ¥200 可用 · 限门票」「8.8 折 · 最多减 ¥30」「兑换 搓澡 1 份」 */
export function couponTermsText(t: CouponTerms, names: { items?: Record<number, string>; ticketTypes?: Record<number, string> } = {}): string {
  const parts: string[] = [];
  if (t.kind === 'cash') parts.push(`代金券 ${formatYuan(t.faceValue ?? 0)}`);
  else if (t.kind === 'discount') parts.push(discountText(t.ratePercent ?? 100));
  else {
    const target = t.exchangeItemId !== null ? (names.items?.[t.exchangeItemId] ?? '指定项目') : (names.ticketTypes?.[t.exchangeTicketTypeId ?? 0] ?? '门票');
    parts.push(`兑换 ${target} 1 份`);
  }
  if (t.kind !== 'exchange' && t.threshold > 0) parts.push(`满 ${formatYuan(t.threshold)} 可用`);
  if (t.maxOff !== null) parts.push(`${t.kind === 'exchange' ? '最多抵' : '最多减'} ${formatYuan(t.maxOff)}`);
  if (t.kind !== 'exchange' && t.scope === 'categories') parts.push(`限${t.scopeCategories.join('、')}`);
  if (t.kind !== 'exchange' && t.scope === 'items') parts.push(`限 ${t.scopeItems.length} 个项目`);
  return parts.join(' · ');
}

// ───────────── 券的状态 ─────────────

/** 数据库里的状态：可用、已用、已作废；过期与未生效按有效期算（不改数据） */
export type CouponStatus = 'available' | 'used' | 'voided';
export type CouponState = 'available' | 'pending' | 'expired' | 'used' | 'voided';
export const COUPON_STATE_LABELS: Record<CouponState, string> = {
  available: '可用',
  pending: '未生效',
  expired: '已过期',
  used: '已用',
  voided: '已作废',
};
export function couponState(c: { status: CouponStatus; validFrom: string; validTo: string }, today: string): CouponState {
  if (c.status !== 'available') return c.status;
  if (today > c.validTo) return 'expired';
  if (today < c.validFrom) return 'pending';
  return 'available';
}

// ───────────── 接口 ─────────────

export interface CouponTemplate extends CouponTerms {
  id: number;
  name: string;
  validity: CouponValidity;
  validFrom: string | null;
  validTo: string | null;
  validDays: number | null;
  /** 限定发放等级（空 = 不限） */
  levels: number[];
  note: string;
  active: boolean;
  version: number;
  createdAt: string;
  createdByName: string;
  /** 一句话说明 */
  summary: string;
  /** 已发的张数；发过券后面额、折扣、门槛、范围、有效期、等级不能改 */
  issued: number;
}

export interface CouponRule {
  id: number;
  kind: CouponRuleKind;
  level: number | null;
  planId: number | null;
  planName: string | null;
  templateId: number;
  templateName: string;
  templateActive: boolean;
  quantity: number;
  active: boolean;
  createdAt: string;
  createdByName: string;
  deactivatedAt: string | null;
  deactivatedByName: string | null;
  /** 这条规则已经发了几次（几位会员 / 几笔充值） */
  issuedTimes: number;
}

export interface CouponRow {
  id: number;
  code: string;
  templateId: number;
  templateName: string;
  kind: CouponKind;
  summary: string;
  memberId: number | null;
  memberName: string | null;
  validFrom: string;
  validTo: string;
  status: CouponStatus;
  state: CouponState;
  issueNo: string;
  issueKind: CouponIssueKind;
  issuedAt: string;
  issuedByName: string | null;
  /** 用在哪张结账单（已用时） */
  checkoutNo: string | null;
  usedAmount: number | null;
  voidReason: string | null;
}

export interface MemberCoupons {
  coupons: CouponRow[];
  counts: Record<CouponState, number>;
}

export interface CouponIssueResult {
  /** 发券记录（「结果待确认」查回用） */
  issueId: number;
  issueNo: string;
  replayed: boolean;
  coupons: CouponRow[];
}

export interface CouponBatch {
  id: number;
  issueNo: string;
  templateId: number;
  templateName: string;
  summary: string;
  quantity: number;
  validFrom: string;
  validTo: string;
  note: string;
  issuedAt: string;
  issuedByName: string | null;
  counts: Record<CouponState, number>;
}

export interface CouponMeta {
  /** 可选的部门（与部门营业额快照同一口径） */
  categories: string[];
  items: { id: number; name: string; category: string; active: boolean }[];
  ticketTypes: { id: number; name: string; active: boolean }[];
  plans: { id: number; name: string; payAmount: number; bonusAmount: number; active: boolean }[];
  levels: { level: number; name: string }[];
}

export interface CouponStatsRow {
  templateId: number;
  name: string;
  kind: CouponKind;
  issued: number;
  used: number;
  usedAmount: number;
  expired: number;
  voided: number;
}
export interface CouponStats {
  from: string;
  to: string;
  rows: CouponStatsRow[];
  totals: Omit<CouponStatsRow, 'templateId' | 'name' | 'kind'>;
}

/** 结账时能用的券（会员的可用券，或输入的券码）：能抵多少、不能用的原因 */
export interface CheckoutCouponOption {
  couponId: number;
  code: string;
  templateName: string;
  summary: string;
  memberId: number | null;
  memberName: string | null;
  validTo: string;
  usable: boolean;
  amount: number;
  reason: string | null;
}
