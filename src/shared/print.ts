import type { CheckoutDetail, CheckoutPayment } from './checkout';

// 打印用的数据：80mm 结账单。交班表直接用班次记录（ShiftRecord）。

/** 结账单上的一行明细（结账那一刻账单上的有效明细，含门票） */
export interface CheckoutPrintLine {
  name: string;
  unitPrice: number;
  quantity: number;
  amount: number;
  /** 技师与点钟 / 轮钟，例如「08 号 小李 · 点钟」（v0.7.0）；没有技师时为 null */
  technician: string | null;
}

export interface WalletBalance {
  principal: number;
  bonus: number;
}

export interface CheckoutPrint extends Omit<CheckoutDetail, 'bills' | 'payments'> {
  bills: (CheckoutDetail['bills'][number] & { lines: CheckoutPrintLine[]; linesTotal: number })[];
  /** 储值支付带上这笔消费前后的会员余额 */
  payments: (CheckoutPayment & { balance: { before: WalletBalance; after: WalletBalance } | null })[];
}
