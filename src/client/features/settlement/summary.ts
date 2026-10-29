import { PAYMENT_METHODS, type PaymentMethod } from '@shared/labels';
import type { SettlementAnomaly, SettlementSummary } from '@shared/types';

/** 日结「异常与提醒」的类别名（日结页与 A4 日结单共用） */
export const ANOMALY_LABELS: Record<SettlementAnomaly['kind'], string> = {
  reversal: '撤销',
  cross_day_reversal: '跨日撤销',
  duplicate_blocked: '重复提交',
  rejected: '余额不足',
  abandoned: '作废待确认',
  balance_mismatch: '余额不符',
  chain_break: '流水不连续',
  checkout_void: '反结账',
  discount: '优惠 / 免单',
  ticket_override: '降档 / 免票',
  visit_cancel: '撤销误开的牌',
  line_void: '作废明细',
  backfill: '补录',
};

/** 实收合计：充值实收 + 结账里的现金类收款（会员储值、团购券、优惠 / 免单不是本次实收），按收款方式核对抽屉与各收款账户 */
export function receivedByMethod(s: SettlementSummary): { rows: { method: PaymentMethod; recharge: number; checkout: number; total: number }[]; total: number } {
  const rows = PAYMENT_METHODS.map((m) => {
    const recharge = s.recharge.byMethod.find((x) => x.method === m)?.amount ?? 0;
    const checkout = s.business.byMethod.find((x) => x.method === m)?.amount ?? 0;
    return { method: m, recharge, checkout, total: recharge + checkout };
  }).filter((r) => r.recharge || r.checkout);
  return { rows, total: rows.reduce((sum, r) => sum + r.total, 0) };
}
