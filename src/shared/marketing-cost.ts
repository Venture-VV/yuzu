// 营销成本测算（8.0.4 需求表 10、11，docs/MEMBERSHIP_V804.md 第 10 节，HY14、HY15）：数据看板里的一页，只读、现算。
// 口径「实核」——按实际核销算，不按发放面值：
//   · 券（含买一赠一）：这段时间结账用券的抵扣（按结账的营业日，反结账的那张单不算）；发放张数、代金券发放面值只做参考；
//   · 赠金：这段时间储值消费里用掉的赠金（撤销的冲减）；发出的赠金、到期作废的赠金只做参考；
//   · 会员折扣：这段时间结账记的会员折扣（包房折扣、同行优惠、会员日……；反结账的不算）；
//   · 服务类权益：这段时间登记使用的次数 × 店主填的「测算单价」（没填的只列次数、不算钱）；
//   · 买一赠一的赠品出库：份数与出库状态（真实的库存出库，照常进库存账；这里只看状态，出库失败的在这里重试）。
// 与财务隔离（需求表 11）：这些数只在这一页现算，不写进日结、交班、对账包、营业数据与 ERP 的任何账；
// 权限「营销成本测算」默认店主、店总，有财务职责（对账付款、成本核算）的账号一律没有（@shared/permissions 的 FINANCE_EXCLUDED）。

import type { UsageGroup } from './coupon-usage';

export const GIFT_OUT_STATUSES = ['pending', 'done', 'failed', 'cancelled', 'void_pending', 'voided', 'void_failed'] as const;
export type GiftOutStatus = (typeof GIFT_OUT_STATUSES)[number];
export const GIFT_OUT_STATUS_LABELS: Record<GiftOutStatus, string> = {
  pending: '待出库',
  done: '已出库',
  failed: '出库失败',
  cancelled: '已取消（反结账）',
  void_pending: '待冲销（反结账）',
  voided: '已冲销（反结账）',
  void_failed: '冲销失败',
};
/** 要人处理的（点重试，或仓库手工处理） */
export const GIFT_OUT_NEEDS_ACTION: readonly GiftOutStatus[] = ['failed', 'void_failed'];

/** 券成本的一行（按券、发放方式、会员权益、会员档级） */
export interface CouponCostRow {
  key: string;
  label: string;
  note: string | null;
  /** 用了几张（这段时间、没反结账的结账单） */
  used: number;
  /** 抵扣金额（分） */
  amount: number;
}

export interface DiscountCostRow {
  benefitId: number;
  code: string;
  name: string;
  /** 几张结账单 */
  checkouts: number;
  amount: number;
}

export interface ServiceCostRow {
  benefitId: number;
  code: string;
  name: string;
  uses: number;
  members: number;
  /** 测算单价（分），没填为 null */
  unitCost: number | null;
  /** 次数 × 单价；没填单价为 null */
  amount: number | null;
}

export interface GiftOutItem {
  id: number;
  status: GiftOutStatus;
  businessDate: string;
  couponCode: string;
  checkoutNo: string;
  templateName: string;
  materialName: string;
  unit: string;
  qtyMilli: number;
  warehouseName: string;
  invDocNo: string | null;
  lastError: string | null;
}

export interface MarketingCost {
  from: string;
  to: string;
  /** 券 + 赠金 + 会员折扣 + 填了单价的服务类权益 */
  total: number;
  coupons: {
    used: number;
    amount: number;
    /** 参考：这段时间发出的张数、其中代金券的面值合计 */
    issued: number;
    issuedFace: number;
    groups: Record<UsageGroup, CouponCostRow[]>;
  };
  bonus: {
    consumed: number;
    /** 参考：这段时间充值送出的赠金、到期作废的赠金 */
    issued: number;
    expired: number;
  };
  discounts: { checkouts: number; amount: number; rows: DiscountCostRow[] };
  services: { uses: number; amount: number; rows: ServiceCostRow[] };
  giftOuts: {
    counts: Partial<Record<GiftOutStatus, number>>;
    /** 这段时间的（最近 200 条），另加不在这段时间但还要处理的 */
    items: GiftOutItem[];
  };
}

/** 服务类权益的测算单价（只在营销成本页改，不进任何账） */
export interface CostParam {
  benefitId: number;
  code: string;
  name: string;
  status: 'draft' | 'published' | 'paused';
  unitCost: number | null;
  updatedByName: string | null;
  updatedAt: string | null;
}
