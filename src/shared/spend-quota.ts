// 充值当日的储值消费比例（8.0.4 需求表 04，docs/MEMBERSHIP_V804.md 第 4 节，PENDING_DECISIONS HY01–HY03）。
// 需求原话：「单次充值 10 万元，本次消费最高不得超过本次充值金额的 70%」。
// 会员在某个营业日充了值，这一天用储值付的钱不超过「当天第一笔充值前的余额 + 当天充值实收 × 比例」：
// 客人卡里原来的钱照常用，限的是新充的钱（新会员充 10 万，当天最多用 7 万储值）；没充值的日子不限。

import { formatYuan } from './money';

export interface SpendQuota {
  /** 营业日 */
  businessDate: string;
  /** 当天充值实收合计（含线上） */
  recharged: number;
  /** 当天第一笔充值入账前的余额（本金 + 赠金；当天第一笔充值以后合并、期初转进来的，撤销第一笔充值之前的消费退回来的也算在这里，随即作废的赠金不算） */
  priorBalance: number;
  /** 比例（%） */
  pct: number;
  /** 上限 = 充值前的余额 + 当天充值实收 × 比例（分以下舍去） */
  cap: number;
  /** 当天第一笔充值以后已经用掉的储值（撤销、反结账的不算） */
  spent: number;
  /** 剩余额度 = 上限 − 已用（不小于 0） */
  remaining: number;
}

export function spendCap(recharged: number, priorBalance: number, pct: number): number {
  return priorBalance + Math.floor((recharged * pct) / 100);
}

/** 「今日储值可用 ¥70,000.00（充值前余额 ¥0.00 + 今日充值 ¥100,000.00 × 70%）」 */
export function spendQuotaText(q: SpendQuota): string {
  const used = q.spent > 0 ? `，已用 ${formatYuan(q.spent)}` : '';
  return `今日储值可用 ${formatYuan(q.remaining)}（充值前余额 ${formatYuan(q.priorBalance)} + 今日充值 ${formatYuan(q.recharged)} × ${q.pct}%${used}）`;
}
