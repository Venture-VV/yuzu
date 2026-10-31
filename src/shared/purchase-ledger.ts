// 采购台账、账目自检、下单物料（v0.7.9，飞书需求 RQ-005 第三步，见 docs/LEDGER.md）。

import type { ExpenseCategory, PaySource } from './expenses';
import type { ImageRef } from './requests';

// ───────────────────────── 采购台账（按日逐笔） ─────────────────────────

export type LedgerKind = 'advance' | 'expense' | 'return' | 'topup';
export const LEDGER_KIND_LABELS: Record<LedgerKind, string> = { advance: '打款', expense: '支出', return: '退回', topup: '补付' };

export interface LedgerEntry {
  kind: LedgerKind;
  date: string;
  /** 打款单号、报销单号、退回 / 补付单号 */
  docNo: string;
  /** 打款、报销单、退回补付单的编号（打开详情用） */
  refId: number;
  /** 所属的打款（打款本身、用备用金的报销、退回补付） */
  advanceId: number | null;
  advanceNo: string | null;
  department: { id: number; name: string };
  handler: { id: number; name: string };
  /** 支出：物品；打款与退回补付：方式与凭据 */
  description: string;
  category: ExpenseCategory | null;
  /** 支出：购买与到货数量（库存单位或报销登记的单位） */
  qty: { boughtMilli: number; receivedMilli: number; unit: string } | null;
  paySource: PaySource | null;
  poNo: string | null;
  amountCents: number;
}

export interface LedgerTotals {
  advanceCents: number;
  /** 用备用金付的支出（已确认的报销） */
  pettySpentCents: number;
  /** 公司直付的支出 */
  companySpentCents: number;
  returnedCents: number;
  toppedUpCents: number;
}

export interface LedgerDay {
  date: string;
  entries: LedgerEntry[];
  totals: LedgerTotals;
}

export interface Ledger {
  from: string;
  to: string;
  days: LedgerDay[];
  totals: LedgerTotals;
  /** 逐笔超过显示上限（合计仍按全部算） */
  truncated: boolean;
}

// ───────────────────────── 12 条账目自检 ─────────────────────────

export type AuditKind = 'block' | 'warn';
export const AUDIT_KIND_LABELS: Record<AuditKind, string> = { block: '录入时拦截', warn: '每日预警' };

export interface AuditItem {
  text: string;
  date: string | null;
  link: { kind: 'claim' | 'advance' | 'po' | 'request'; id: number } | null;
}

export interface AuditRule {
  no: number;
  title: string;
  kind: AuditKind;
  /** 怎么查（给人看的口径） */
  how: string;
  ok: boolean;
  count: number;
  /** 前 50 条 */
  items: AuditItem[];
}

export interface LedgerAudit {
  today: string;
  rules: AuditRule[];
}

// ───────────────────────── 下单物料（库管） ─────────────────────────

export type OrderedState = 'open' | 'partial' | 'received' | 'closed';
export const ORDERED_STATE_LABELS: Record<OrderedState, string> = { open: '未到货', partial: '部分到货', received: '已到齐', closed: '已关闭' };

export interface OrderedLine {
  poId: number;
  docNo: string;
  orderDate: string;
  expectedDate: string | null;
  supplierName: string;
  lineId: number;
  materialCode: string;
  materialName: string;
  spec: string;
  purchaseQtyMilli: number;
  purchaseUnit: string;
  baseQtyMilli: number;
  inventoryUnit: string;
  receivedMilli: number;
  priceCents: number;
  amountCents: number;
  images: ImageRef[];
  /** 来自哪些部门的需求 */
  departments: string[];
  state: OrderedState;
  /** 应到日期：预计到货日，没有就是下单日 + 约定到货天数 */
  dueDate: string;
  /** 没到齐且过了应到日期（12 条自检第 9 条） */
  overdue: boolean;
}

export interface OrderedLines {
  lines: OrderedLine[];
  truncated: boolean;
}
