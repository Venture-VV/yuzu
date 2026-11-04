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

// ── 业务单据打到小票机（v0.7.28 ⑥，docs/SCHEDULE_FINISH.md 第 7 节，N7）──

/** 要打的单据：结账单、退款单、交班表（按编号），日结单（按营业日；80mm 汇总，完整的 A4 日结单照旧用浏览器打印） */
export type PrintDoc = { type: 'checkout'; id: number } | { type: 'refund'; id: number } | { type: 'shift'; id: number } | { type: 'settlement'; date: string };
export const PRINT_DOC_TYPES = ['checkout', 'refund', 'shift', 'settlement'] as const;
export type PrintDocType = (typeof PRINT_DOC_TYPES)[number];
export const PRINT_DOC_LABELS: Record<PrintDocType, string> = { checkout: '结账单', refund: '退款单', shift: '交班表', settlement: '日结单' };

/** 「打到小票机」能选的打印机：启用的、配好了地址的小票打印机 */
export interface PrintPrinter {
  id: number;
  code: string;
  name: string;
  area: string;
  status: 'unknown' | 'online' | 'offline' | 'error';
  statusCode: string | null;
  paperWidth: 58 | 80;
  /** 这台排队、等恢复的单子有几张 */
  waiting: number;
}
