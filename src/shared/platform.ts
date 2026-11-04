// 第三方平台核销补录（v0.7.28 ⑤，docs/SCHEDULE_FINISH.md 第 6 节，N6 待确认）：
//   · 已在平台 App（美团、大众点评、抖音等）核销、没有经过前台结账的券，补登记一笔——不结账、不算营业额、不动会员钱包；
//   · 平台打款另记；按平台、按时间段对账：补登记的应结 + 结账里登记的团购券抵扣 与 平台打款比对。
// 金额都是分。

import type { CouponPlatform } from './checkout';

/** 补登记最早能补到几天前的核销（N6，待确认） */
export const PLATFORM_BACKFILL_DAYS = 31;

export interface PlatformRedemption {
  id: number;
  redemptionNo: string;
  platform: CouponPlatform;
  code: string;
  dealName: string;
  faceValue: number;
  settleAmount: number;
  guests: number;
  redeemedAt: string;
  businessDate: string;
  note: string;
  status: 'active' | 'voided';
  registeredByName: string;
  registeredAt: string;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface PlatformSettlement {
  id: number;
  settlementNo: string;
  platform: CouponPlatform;
  periodFrom: string;
  periodTo: string;
  amount: number;
  receivedOn: string;
  ref: string;
  note: string;
  status: 'active' | 'voided';
  createdByName: string;
  createdAt: string;
  voidReason: string | null;
}

/** 对账：一个平台在这段时间里应结多少、到账多少 */
export interface PlatformReconcileRow {
  platform: CouponPlatform;
  /** 补登记（不结账）的核销：张数、面值、应结 */
  redemptions: { count: number; face: number; settle: number };
  /** 前台结账里登记的团购券：张数、抵扣金额（按抵扣金额算应结） */
  checkoutCoupons: { count: number; amount: number };
  /** 应结 = 补登记的应结 + 结账团购券的抵扣 */
  expected: number;
  /** 这段时间里的打款（打款所属期间在这段时间内的） */
  settlements: { count: number; amount: number };
  /** 到账 − 应结：负数是平台还欠的（或扣了佣金、退款） */
  diff: number;
}

export interface PlatformReconcile {
  from: string;
  to: string;
  rows: PlatformReconcileRow[];
  settlements: PlatformSettlement[];
}

/** 日结里的平台核销补录（v0.7.28）：不结账、不算营业额，单列 */
export interface PlatformDayTotals {
  count: number;
  face: number;
  settle: number;
  voidCount: number;
  byPlatform: { platform: CouponPlatform; count: number; face: number; settle: number }[];
}
export const EMPTY_PLATFORM_DAY_TOTALS: PlatformDayTotals = { count: 0, face: 0, settle: 0, voidCount: 0, byPlatform: [] };
