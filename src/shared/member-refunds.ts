// 储值退回（v0.7.26，docs/MEMBERSHIP_FINISH.md 第 1 节；PENDING_DECISIONS M69–M74，店主 2026-11-04 交给主线开发，MP21）。
//
//   · 退的是本金（本金余额以内，默认全退）；赠金按退的本金占本金余额的比例扣回、四舍五入到分，本金退到 0 时剩下的赠金全部扣回（M70）；
//   · 按原收款方式退（M71）：先进先出地消费，剩下的本金算作最近的几笔充值——退的本金按最近的先退，分到每一笔充值，
//     每一行用那一笔的收款方式、每一笔累计不超过它收的钱；期初余额与合并转入的本金没有原收款方式，按员工选的方式退；
//   · 金额一律整数分，按比例扣回赠金用整数运算（不用浮点数算钱）。前后端共用。

import type { PaymentMethod } from './labels';

/** 退的本金来自哪里：一笔充值、期初余额（老卡迁移）、合并转入 */
export const REFUND_SOURCES = ['recharge', 'opening', 'merge'] as const;
export type RefundSource = (typeof REFUND_SOURCES)[number];
export const REFUND_SOURCE_LABELS: Record<RefundSource, string> = { recharge: '充值', opening: '期初余额', merge: '合并转入' };

/** 一笔进过本金的来源：收了多少、已经退过多少；没有原收款方式的（期初、合并转入）method 为空 */
export interface RefundSourceRow {
  source: RefundSource;
  id: number;
  /** 充值单号 / 期初明细号 / 合并单号 */
  docNo: string;
  /** 营业日 */
  date: string;
  /** 入账时间（排先后：最近的先退） */
  at: string;
  method: PaymentMethod | null;
  /** 充值的渠道：前台 / 小程序（线上充值的原路退回由小程序线接上） */
  channel: 'counter' | 'mp' | null;
  /** 这一笔进的本金 */
  amount: number;
  /** 已经退过的 */
  refunded: number;
  /** 按现在的本金余额，这一笔还剩多少（最近的先占） */
  remaining: number;
}

/** 分到每一笔的一行（页面列出来，员工核对后提交；扫码、银行卡填退款单号，期初与合并转入选退款方式） */
export interface RefundPlanLine {
  source: RefundSource;
  id: number;
  docNo: string;
  date: string;
  /** 原收款方式；期初、合并转入为空（员工选） */
  method: PaymentMethod | null;
  channel: 'counter' | 'mp' | null;
  amount: number;
}

/**
 * 把现在的本金余额从最近的一笔往前分（先进先出地消费，剩下的就是最近的几笔）。
 * sources 不要求排好；每一笔最多分到「收的 − 已退」。分不完说明账不一致（例如有人绕过系统改了余额），剩下的不归任何一笔
 */
export function attributeBalance<T extends Omit<RefundSourceRow, 'remaining'>>(sources: readonly T[], principalBalance: number): (T & { remaining: number })[] {
  const sorted = [...sources].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
  let left = Math.max(0, principalBalance);
  return sorted.map((s) => {
    const take = Math.min(left, Math.max(0, s.amount - s.refunded));
    left -= take;
    return { ...s, remaining: take };
  });
}

/** 退 amount 的本金：从最近的一笔起，每一笔最多它还剩的（sources 是 attributeBalance 的结果，已按最近的在前） */
export function allocateRefund(sources: readonly RefundSourceRow[], amount: number): RefundPlanLine[] {
  const lines: RefundPlanLine[] = [];
  let left = amount;
  for (const s of sources) {
    if (left <= 0) break;
    const take = Math.min(left, s.remaining);
    if (take <= 0) continue;
    lines.push({ source: s.source, id: s.id, docNo: s.docNo, date: s.date, method: s.method, channel: s.channel, amount: take });
    left -= take;
  }
  return lines;
}

/**
 * 扣回的赠金（M70）：退的本金占本金余额的比例 × 赠金余额，四舍五入到分；本金退到 0 时赠金全部扣回。
 * 整数运算：赠金与本金都可能到几十万元（几千万分），相乘超出浮点数能精确表示的整数
 */
export function refundBonus(principalBalance: number, bonusBalance: number, amount: number): number {
  if (bonusBalance <= 0 || amount <= 0) return 0;
  if (amount >= principalBalance) return bonusBalance;
  const p = BigInt(principalBalance);
  const v = (BigInt(bonusBalance) * BigInt(amount) * 2n + p) / (2n * p);
  return Math.min(bonusBalance, Number(v));
}

/** 退款方式要不要登记单号：微信、支付宝、银行卡登记商户后台的退款单号；其他写明怎么退的；现金不用 */
export const refundRefRequired = (method: PaymentMethod) => method !== 'cash';

/** 退储值前的核对（只读）：能退多少、分到哪几笔、扣回多少赠金、会不会降档 */
export interface MemberRefundPlan {
  memberId: number;
  memberNo: string;
  memberName: string;
  status: 'active' | 'frozen';
  principalBalance: number;
  bonusBalance: number;
  /** 这次退的本金（没指定时是全部本金） */
  amount: number;
  /** 扣回的赠金 */
  bonus: number;
  lines: RefundPlanLine[];
  /** 还能退的各笔（最近的在前，只列还剩的） */
  sources: RefundSourceRow[];
  /** 退完会降档时：从哪一档降到哪一档（M73） */
  grade: { from: string; to: string } | null;
  /** 不能退的原因（没有本金、被合并了） */
  blocked: string | null;
}

/** 退储值单 */
export interface MemberRefundDetail {
  id: number;
  refundNo: string;
  memberId: number;
  memberNo: string;
  memberName: string;
  principal: number;
  bonus: number;
  reason: string;
  operatorName: string;
  approverName: string;
  /** 记到的班次（退现金时是所选钱箱当班的班次） */
  shiftNo: string | null;
  shiftStaffName: string | null;
  businessDate: string;
  createdAt: string;
  lines: (RefundPlanLine & { method: PaymentMethod; ref: string })[];
  /** 这次退回降了档（M73） */
  grade: { from: string; to: string } | null;
}
