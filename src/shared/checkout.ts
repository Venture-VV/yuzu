// S3 结账：门票 12 小时跳档、收款方式、团购券。前后端共用。金额为分。
//
// 门票（店主 2026-10-27 #31，附录 B）：每 12 小时跳一档。按 12 小时为一段计段数 n（不足一段按一段），
//   票价 = ⌊n / 2⌋ × 24 小时档 + （n 为奇数时再加一个 12 小时档）。
//   例：不含餐 499 → 599 → 1098 → 1198 → 1697。
// 跳档宽限（❓6，默认 0）：每个 12 小时的分界点之后多少分钟内不跳档。

import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from './labels';
import type { BackfillMark } from './backfill';
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

/** 免票：两档票价都为 0（例如「儿童免票（1 米以下）」） */
export const isFreeTicket = (t: Pick<TicketType, 'price12h' | 'price24h'>) => t.price12h === 0 && t.price24h === 0;

/**
 * 选这个票种是否需要值班经理及以上当场授权（R1.2，店主 2026-10-29 签认）：免票（接待时直接选也算），
 * 或比客人现在留存的票价便宜（任一档更低）。current 为 null 表示客人还没有票种（接待时）。
 */
export function ticketChangeNeedsGrant(
  type: Pick<TicketType, 'price12h' | 'price24h'>,
  current: Pick<TicketType, 'price12h' | 'price24h'> | null,
): boolean {
  if (isFreeTicket(type)) return true;
  return current !== null && (type.price12h < current.price12h || type.price24h < current.price24h);
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

/**
 * 结账收款：现金、微信、支付宝、银行卡、其他（与充值相同），以及会员储值、团购券、优惠 / 免单。
 * 「优惠 / 免单」（R1.2，店主 2026-10-29 签认）由值班经理及以上当场授权并填原因，一张结账单最多一笔；
 * 店员不能自行抹零，抹零也走优惠。
 */
export const CHECKOUT_METHODS = [...PAYMENT_METHODS, 'wallet', 'coupon', 'discount'] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];
export const CHECKOUT_METHOD_LABELS: Record<CheckoutMethod, string> = {
  ...PAYMENT_METHOD_LABELS,
  wallet: '会员储值',
  coupon: '团购券',
  discount: '优惠 / 免单',
};
/** 实收（现金流入）的方式：会员储值是会员余额抵扣，团购券由平台结算，优惠 / 免单没有收钱，三者都不是本次实收 */
export const isCashLike = (m: CheckoutMethod): m is PaymentMethod => (PAYMENT_METHODS as readonly string[]).includes(m);

/**
 * 营业口径的分列（店主 2026-10-29 签认：日结分列应收、优惠、净营业额、实收）：
 * 应收 = 结账合计 − 反结账；优惠 = 「优惠 / 免单」收款；净营业额 = 应收 − 优惠；
 * 实收 = 现金类收款（现金、微信、支付宝、银行卡、其他），不含会员储值、团购券与优惠。
 */
export function businessBreakdown(b: { net: number; byMethod: readonly { method: CheckoutMethod; amount: number }[] }) {
  const discount = b.byMethod.filter((m) => m.method === 'discount').reduce((sum, m) => sum + m.amount, 0);
  const received = b.byMethod.filter((m) => isCashLike(m.method)).reduce((sum, m) => sum + m.amount, 0);
  return { receivable: b.net, discount, netRevenue: b.net - discount, received };
}

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
      /** 反结账后重结：门票按第一次结账的时刻计算，不再随时间跳档；平时为 null */
      endAt: string | null;
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
  /** 钟房里还没结束的钟单（v0.7.1）：结账时一起收尾，在钟上的下钟，还没上钟的按已做完记 */
  sessions: { sessionNo: string; tagCode: string; techNo: string; techName: string; itemName: string; clocks: number; status: 'waiting' | 'serving' }[];
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
  /** 优惠 / 免单的授权人（原因记在 ref） */
  approvedByName: string | null;
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
  /** 按实际时间补录的结账（R1.9）：纸质单号、实际时间与补录人；平时为 null */
  backfill: BackfillMark | null;
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
  /** 补录的结账单的纸质单号（R1.9）；平时为 null */
  backfillSlipNo: string | null;
}

// ───────────── 交班（店主 #11） ─────────────

/**
 * 一个班次（开班到交班）内本人经办的收款汇总；未交班时为实时数据，交班后为快照。
 * R1.2 起（店主 2026-10-29 签认）：结账收款算在收款时的班次，之后被反结账也不减；反结账退的现金
 * 算在执行反结账的人当时的班次、扣减应有现金（原单与反结账在同一班次时两者相抵）。之前的快照没有退款一项。
 */
export interface ShiftSummary {
  from: string;
  to: string;
  /** 本班次收款的结账单（含之后被反结账的） */
  checkouts: { count: number; total: number };
  /** 结账收款按方式（含会员储值、团购券、优惠 / 免单） */
  checkoutByMethod: { method: CheckoutMethod; count: number; amount: number }[];
  recharges: { count: number; paid: number; bonus: number; byMethod: { method: PaymentMethod; count: number; amount: number }[] };
  /** 会员工作台直接登记的储值消费（不经前台结账） */
  walletConsumes: { count: number; total: number };
  coupons: { platform: CouponPlatform; count: number; amount: number }[];
  /** 本班次内本人做的反结账（原单可能在别的班次）；cashRefund 为退给客人的现金（R1.2 起） */
  voids: { checkoutNo: string; amount: number; reason: string; voidedAt: string; cashRefund?: number }[];
  /**
   * 反结账退款按原收款方式（R1.2 起）：现金从本班钱箱退，扣减应有现金；扫码、银行卡、团购在商户后台原路退回并登记退款单号。
   * 升级（迁移 017）时已有的班次与之前的快照没有这一项：反结账只列提醒、不扣现金（cashRefund、cash.refund 同样没有）
   */
  refunds?: { count: number; total: number; byMethod: { method: CheckoutMethod; amount: number }[] };
  /** 应有现金 = 备用金 + 结账现金 + 充值现金 − 反结账退现金 */
  cash: { opening: number; checkout: number; recharge: number; refund?: number; expected: number };
}

export interface ShiftRecord {
  id: number;
  shiftNo: string;
  staffId: number;
  staffName: string;
  status: 'open' | 'closed';
  businessDate: string;
  startedAt: string;
  openingCash: number;
  endedAt: string | null;
  expectedCash: number | null;
  countedCash: number | null;
  note: string;
  handedToName: string | null;
  closedByName: string | null;
  summary: ShiftSummary;
}

/** 经营看板（S3.5） */
export interface DashboardData {
  today: string;
  /**
   * 在店未结：unsettled 是已挂明细；ticketEstimate 是按此刻在店时长估算的门票（结账时才挂到账单），
   * noTicket 是还没选票种、没有计入估算的人数
   */
  /** 在店客人：人数、已挂未结、门票估算；没有「查看在店手牌」权限的岗位为 null（v0.7.1，测试会话 PR #15 问题 1） */
  inStore: { count: number; unsettled: number; ticketEstimate: number; noTicket: number } | null;
  todayStats: {
    checkouts: number;
    guests: number;
    net: number;
    ticket: number;
    byMethod: { method: CheckoutMethod; amount: number }[];
    /** 优惠 / 免单（已含在 net 里，单列）；与日结同一口径：当日结账的减去当日反结账的，可为负 */
    discount: number;
    rechargePaid: number;
    rechargeCount: number;
  };
  tickets: { name: string; count: number; amount: number }[];
  days: { date: string; net: number; checkouts: number; rechargePaid: number }[];
  openShifts: { shiftNo: string; staffName: string; startedAt: string }[];
}
