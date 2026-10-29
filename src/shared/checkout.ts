// S3 结账：门票 12 小时跳档、收款方式、团购券。前后端共用。金额为分。
//
// 门票（店主 2026-10-27 #31，附录 B）：每 12 小时跳一档。按 12 小时为一段计段数 n（不足一段按一段），
//   票价 = ⌊n / 2⌋ × 24 小时档 + （n 为奇数时再加一个 12 小时档）。
//   例：不含餐 499 → 599 → 1098 → 1198 → 1697。
// 跳档宽限（❓6，默认 0）：每个 12 小时的分界点之后多少分钟内不跳档。

import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from './labels';
import type { TagZone } from './frontdesk';

export const TICKET_SEGMENT_MS = 12 * 3_600_000;

export interface TicketType {
  id: number;
  name: string;
  /** 12 小时档 / 24 小时档（分）；免票两档都为 0 */
  price12h: number;
  price24h: number;
  note: string;
  active: boolean;
  isDefault: boolean;
  sortOrder: number;
}

/** 在店时长 → 段数（每 12 小时一段，不足一段按一段，至少 1 段）；宽限分钟内不跳档 */
export function ticketSegments(stayMs: number, graceMinutes: number): number {
  return Math.max(1, Math.ceil((stayMs - graceMinutes * 60_000) / TICKET_SEGMENT_MS));
}

export function ticketPrice(t: Pick<TicketType, 'price12h' | 'price24h'>, segments: number): number {
  return Math.floor(segments / 2) * t.price24h + (segments % 2) * t.price12h;
}

/** 「12 小时档」「24 小时档」「24 小时档 + 12 小时档」「24 小时档 × 2」… */
export function ticketTierLabel(segments: number): string {
  const full = Math.floor(segments / 2);
  const half = segments % 2;
  const parts: string[] = [];
  if (full === 1) parts.push('24 小时档');
  else if (full > 1) parts.push(`24 小时档 × ${full}`);
  if (half) parts.push('12 小时档');
  return parts.join(' + ');
}

/** 下一次跳档的时刻：当前段数对应的分界点 + 宽限 */
export function nextTicketJumpAt(checkedInAt: string | Date, segments: number, graceMinutes: number): Date {
  return new Date(new Date(checkedInAt).getTime() + segments * TICKET_SEGMENT_MS + graceMinutes * 60_000);
}

/** 按在店时长计算一位客人的门票 */
export function priceTicket(t: Pick<TicketType, 'price12h' | 'price24h'>, checkedInAt: string | Date, at: Date, graceMinutes: number) {
  const stayMs = Math.max(0, at.getTime() - new Date(checkedInAt).getTime());
  const segments = ticketSegments(stayMs, graceMinutes);
  return {
    segments,
    amount: ticketPrice(t, segments),
    stayMinutes: Math.floor(stayMs / 60_000),
    nextJumpAt: nextTicketJumpAt(checkedInAt, segments, graceMinutes).toISOString(),
    nextAmount: ticketPrice(t, segments + 1),
  };
}

// ───────────── 收款方式 ─────────────

/** 结账收款：现金、微信、支付宝、银行卡、其他（与充值相同），以及会员储值、团购券 */
export const CHECKOUT_METHODS = [...PAYMENT_METHODS, 'wallet', 'coupon'] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];
export const CHECKOUT_METHOD_LABELS: Record<CheckoutMethod, string> = {
  ...PAYMENT_METHOD_LABELS,
  wallet: '会员储值',
  coupon: '团购券',
};
/** 实收（现金流入）的方式：会员储值是会员余额抵扣，团购券由平台结算，二者都不是本次实收 */
export const isCashLike = (m: CheckoutMethod): m is PaymentMethod => (PAYMENT_METHODS as readonly string[]).includes(m);

export const COUPON_PLATFORMS = ['meituan', 'dianping', 'douyin', 'other'] as const;
export type CouponPlatform = (typeof COUPON_PLATFORMS)[number];
export const COUPON_PLATFORM_LABELS: Record<CouponPlatform, string> = {
  meituan: '美团',
  dianping: '大众点评',
  douyin: '抖音',
  other: '其他平台',
};

/** 团购券码规范化：去掉空格与连字符，字母大写 */
export const normalizeCouponCode = (input: string) => input.replace(/[\s-]/g, '').toUpperCase();
export const COUPON_CODE_PATTERN = /^[0-9A-Z]{6,64}$/;

// ───────────── 接口返回 ─────────────

/** 结账前核对：所选手牌的账单与按当前时刻计算的门票 */
export interface CheckoutPreview {
  visits: {
    visitId: number;
    visitNo: string;
    billId: number;
    tagCode: string;
    zone: TagZone;
    memberId: number | null;
    memberName: string | null;
    guestLabel: string;
    checkedInAt: string;
    groupId: number | null;
    /** 已挂明细合计（不含门票） */
    linesAmount: number;
    lines: { id: number; name: string; quantity: number; amount: number }[];
    ticket: {
      typeId: number;
      name: string;
      segments: number;
      tierLabel: string;
      amount: number;
      stayMinutes: number;
      nextJumpAt: string;
      nextAmount: number;
    } | null;
    /** 还没有选票种（Batch 3 之前开的牌） */
    needsTicket: boolean;
    amount: number;
  }[];
  totalAmount: number;
  /** 这些手牌上的会员（可用储值支付），附余额 */
  members: { id: number; name: string; memberNo: string; status: 'active' | 'frozen'; principalBalance: number; bonusBalance: number }[];
  graceMinutes: number;
  pricedAt: string;
}

export interface CheckoutPayment {
  id: number;
  method: CheckoutMethod;
  amount: number;
  ref: string;
  memberId: number | null;
  memberName: string | null;
  consumption: { id: number; docNo: string; principal: number; bonus: number; status: 'completed' | 'reversed' } | null;
  coupon: { id: number; platform: CouponPlatform; code: string; dealName: string; status: 'active' | 'voided' } | null;
}

export interface CheckoutDetail {
  id: number;
  checkoutNo: string;
  status: 'completed' | 'voided';
  totalAmount: number;
  note: string;
  businessDate: string;
  operatorName: string;
  createdAt: string;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  bills: {
    billId: number;
    billNo: string;
    visitId: number;
    visitNo: string;
    tagCode: string;
    memberName: string | null;
    guestLabel: string;
    amount: number;
    stayMinutes: number;
    ticketName: string;
    ticketSegments: number;
    ticketAmount: number;
  }[];
  payments: CheckoutPayment[];
  /** 本次结账后同行组里仍在店的手牌 */
  remainingMates: string[];
}

export interface CheckoutSummary {
  id: number;
  checkoutNo: string;
  status: 'completed' | 'voided';
  totalAmount: number;
  tagCodes: string[];
  methods: CheckoutMethod[];
  operatorName: string;
  createdAt: string;
  businessDate: string;
}
