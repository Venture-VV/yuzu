// 权益使用率看板（8.0.4 需求表 08，docs/MEMBERSHIP_V804.md 第 8 节，HY10）：按发放的时间段圈一批券，看领了多少、用了多少。
//   · 发放 = 这段时间发出的张数（含后来作废的）；
//   · 领取 = 其中到了会员账户的（发给会员的、小程序领的）+ 无记名券里已经用掉的；
//   · 核销 = 其中已经用掉的（反结账退回的不算）；核销率 = 核销 ÷ 发放，领取率 = 领取 ÷ 发放；
//   · 核销金额 = 这些券结账时的抵扣金额；过期 = 到今天还没用、有效期已过的；作废 = 已作废的。
// 与「统计」的区别：统计按事情发生的那一天（今天发了几张、今天用了几张），这里按发券的那一批算到今天。
// 服务类权益（专属通道、停车……）没有券，另列这段时间登记使用的次数与人数。

/** 一组券的张数与金额 */
export interface UsageCounts {
  issued: number;
  claimed: number;
  used: number;
  usedAmount: number;
  expired: number;
  voided: number;
}

export interface UsageRow extends UsageCounts {
  key: string;
  label: string;
  /** 补充说明（券的种类、权益编号……），没有为 null */
  note: string | null;
}

export const USAGE_GROUPS = ['template', 'source', 'benefit', 'grade'] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];
export const USAGE_GROUP_LABELS: Record<UsageGroup, string> = {
  template: '按券',
  source: '按发放方式',
  benefit: '按会员权益',
  grade: '按会员档级',
};

/** 服务类权益这段时间的登记使用（作废的不算） */
export interface ServiceUsageRow {
  benefitId: number;
  code: string;
  name: string;
  uses: number;
  members: number;
}

export interface CouponUsage {
  from: string;
  to: string;
  /** 过期按这一天算 */
  today: string;
  grade: number | null;
  tagId: number | null;
  totals: UsageCounts;
  groups: Record<UsageGroup, UsageRow[]>;
  services: ServiceUsageRow[];
}

export const EMPTY_USAGE: UsageCounts = { issued: 0, claimed: 0, used: 0, usedAmount: 0, expired: 0, voided: 0 };

export function addUsage(a: UsageCounts, b: UsageCounts): UsageCounts {
  return {
    issued: a.issued + b.issued,
    claimed: a.claimed + b.claimed,
    used: a.used + b.used,
    usedAmount: a.usedAmount + b.usedAmount,
    expired: a.expired + b.expired,
    voided: a.voided + b.voided,
  };
}

/** 比例（%），保留一位小数；分母是 0 返回 null。420 ÷ 1000 → 42 */
export const usageRate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part * 1000) / whole) / 10 : null);

/** 「42%」「42.5%」，分母是 0 时「—」 */
export function rateText(part: number, whole: number): string {
  const r = usageRate(part, whole);
  return r === null ? '—' : `${r}%`;
}
