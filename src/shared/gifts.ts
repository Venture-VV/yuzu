// 全局签赠（8.1.9，docs/GIFTS_V819.md，PENDING_DECISIONS「8.1.9 签赠」SZ1–SZ8）。
// 签赠券类型 = 券模板里标了签赠的那一类（兑换券或代金券）；签赠 = 给会员发签赠券，必选授权人与渠道；核销 = 结账时用这张券。
// 金额为整数「分」。

import type { CouponTemplate } from './coupons';

/** 签赠配置（settings 的 gift_rules，全公司一份） */
export interface GiftRules {
  /** 功能开关（默认开）：关了以后不能再发，已发的照常能用、台账照常看 */
  enabled: boolean;
  /** 板块的选项（签赠券类型选一个） */
  segments: string[];
  /** 发放渠道的选项（发放时选一个；管家部、客户部的面板默认选自己） */
  channels: string[];
  /** 签赠总则：全店通用的说明，在知识库与发放弹窗里显示 */
  generalRules: string;
}
export const DEFAULT_GIFT_RULES: GiftRules = {
  enabled: true,
  segments: ['浴区', '技师', '餐饮', '客房', '其他'],
  channels: ['管家部', '客户部', '前台', '其他'],
  generalRules: '',
};
/** 管家部、客户部的面板默认选的渠道 */
export const GIFT_PANEL_CHANNELS = { concierge: '管家部', customer: '客户部' } as const;
/** 一次最多发几张（与人工发券一样） */
export const MAX_GIFT_QUANTITY = 10;

export type GiftStatus = 'available' | 'used' | 'voided' | 'expired';
export const GIFT_STATUS_LABELS: Record<GiftStatus, string> = { available: '未使用', used: '已使用', voided: '已作废', expired: '已过期' };

/** 签赠券类型只有这两种：兑换券（送一个项目或票种）、代金券（送一个金额以内的） */
export const GIFT_KINDS = ['exchange', 'cash'] as const;
export type GiftKind = (typeof GIFT_KINDS)[number];
export const GIFT_KIND_LABELS: Record<GiftKind, string> = { exchange: '兑换券（送一个项目或票种）', cash: '代金券（送一个金额以内的）' };

/** 知识库里的一个签赠券类型：券模板（送什么、有效期）+ 板块、权益内容、规则说明（giftSegment、giftContent、giftRules）+ 用了多少 */
export interface GiftType extends CouponTemplate {
  /** 「发放当天起 30 天」「2026-11-01 至 2026-12-31」 */
  validityText: string;
  used: number;
  available: number;
  voided: number;
  expired: number;
}

/** 「发放当天起 30 天」「2026-11-01 至 2026-12-31」 */
export function giftValidityText(t: Pick<CouponTemplate, 'validity' | 'validFrom' | 'validTo' | 'validDays'>): string {
  return t.validity === 'days' ? `发放当天起 ${t.validDays ?? 0} 天` : `${t.validFrom ?? ''} 至 ${t.validTo ?? ''}`;
}

export interface GiftAuthorizer {
  id: number;
  name: string;
}

export interface GiftMemberOption {
  id: number;
  memberNo: string;
  name: string;
  /** 没有「查找与查看会员」权限的账号看到的是打码的；没留手机号的（匿名卡，8.1.15）为 null */
  phone: string | null;
  grade: number;
  /** 停用、合并过的不能发 */
  usable: boolean;
}

export interface GiftIssueResult {
  issueId: number;
  issueNo: string;
  replayed: boolean;
  coupons: { id: number; code: string; validTo: string }[];
}

export interface GiftLedgerRow {
  couponId: number;
  code: string;
  type: { id: number; name: string };
  segment: string;
  member: { id: number; name: string; phone: string } | null;
  authorizer: { id: number; name: string };
  issuedByName: string | null;
  channel: string;
  reason: string;
  issueNo: string;
  issuedAt: string;
  businessDate: string;
  validTo: string;
  status: GiftStatus;
  /** 核销（已使用）：结账单、时间、经办、抵了多少 */
  usedAt: string | null;
  checkoutId: number | null;
  checkoutNo: string | null;
  usedByName: string | null;
  usedCents: number | null;
  /** 作废：时间、经办、原因 */
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface GiftCountRow {
  issued: number;
  used: number;
  available: number;
  voided: number;
  expired: number;
}

export interface GiftShare {
  label: string;
  count: number;
  /** 占比，整数百分比（四舍五入） */
  pct: number;
}

export interface GiftLedger {
  rows: GiftLedgerRow[];
  /** 明细没显示全（统计仍按全部算） */
  truncated: boolean;
  totals: GiftCountRow & { usedCents: number };
  byAuthorizer: (GiftCountRow & { authorizer: { id: number; name: string } })[];
  /** 个人（会员名下）：发了几张、用了几张、抵了多少，按用了的从多到少（最多 50 位） */
  byPerson: { member: { id: number; name: string; phone: string }; issued: number; used: number; usedCents: number }[];
  /** 占比：已使用的张数按人员（授权人）、板块、券种；发出的张数按渠道。各取前 8 项，其余并成「其他」 */
  shares: { authorizer: GiftShare[]; segment: GiftShare[]; type: GiftShare[]; channel: GiftShare[] };
}

export const GIFT_LEDGER_ROW_LIMIT = 1000;
