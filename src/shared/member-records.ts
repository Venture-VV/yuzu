// 前台会员工作台的充值记录与消费记录（8.0.4 需求表 07，docs/MEMBERSHIP_V804.md 第 7 节）：原来的「余额记录」拆成两块，
// 各自按种类、营业日起止查询与导出；上面「收支比例」的数字就是两块当前查询条件下的合计（与明细合计一致）。

import type { EntryType } from './labels';
import type { LedgerRow } from './types';

export const RECORD_SECTIONS = ['recharge', 'consume'] as const;
export type RecordSection = (typeof RECORD_SECTIONS)[number];
export const RECORD_SECTION_LABELS: Record<RecordSection, string> = { recharge: '充值记录', consume: '消费记录' };

/** 两块各包括哪几种余额流水：充值记录是余额增加（储值退回、期初作废是它的冲减），消费记录是余额减少（撤销是它的冲减） */
export const SECTION_TYPES: Record<RecordSection, readonly EntryType[]> = {
  recharge: ['recharge', 'opening', 'merge_in', 'refund', 'opening_void'],
  consume: ['consume', 'reversal', 'expire', 'merge_out'],
};

/** 页面上一块最多列多少笔（导出不限） */
export const MAX_RECORD_ROWS = 300;

export interface RecordTotals {
  count: number;
  /** 本金、赠金变动之和（充值记录为正，消费记录按「减少了多少」记正数） */
  principal: number;
  bonus: number;
  total: number;
  /** 充值实收合计（只有充值记录） */
  paid: number;
  /** 按种类：笔数、金额（与上面同号） */
  byType: Partial<Record<EntryType, { count: number; total: number }>>;
}

export interface MemberRecords {
  section: RecordSection;
  from: string | null;
  to: string | null;
  types: EntryType[];
  rows: LedgerRow[];
  totals: RecordTotals;
  /** 超过页面上限、只列了最近的几笔 */
  truncated: boolean;
}

/** 收支比例：消费占充值的百分之几（一位小数）；充值是 0 时为空 */
export function spendRatio(recharge: number, consume: number): number | null {
  if (recharge <= 0) return null;
  return Math.round((consume * 1000) / recharge) / 10;
}
