// 费用预算（8.0.3，docs/BUDGET_INVOICES.md 第 2 节，默认 BI01–BI06 待确认）：部门 × 费用科目 × 月份的额度，
// 从某月起生效、之后每月沿用，直到下一次修改；没设的格子不控制。占用 = 待确认、已退回、已确认的报销单的明细金额。
// 达到额度的 80%（费用报销规则里可改）黄灯，超过 100% 红灯；登记报销时超了的走审批中心的「超预算报销」（不拦登记）。

import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from './expenses';

export type BudgetLevel = 'none' | 'ok' | 'warn' | 'over';
export const BUDGET_LEVEL_LABELS: Record<BudgetLevel, string> = { none: '不控制', ok: '正常', warn: '快用完', over: '超预算' };

/** 黄灯百分比的范围（费用报销规则） */
export const BUDGET_WARN_MIN = 50;
export const BUDGET_WARN_MAX = 100;
/** 一格额度的上限：¥10 亿（只防填错） */
export const BUDGET_MAX_CENTS = 100_000_000_000;

/** 额度为空：不控制；超过额度：超预算；达到黄灯百分比：快用完 */
export function budgetLevel(budgetCents: number | null, usedCents: number, warnPercent: number): BudgetLevel {
  if (budgetCents === null) return 'none';
  if (usedCents > budgetCents) return 'over';
  if (budgetCents > 0 && usedCents * 100 >= budgetCents * warnPercent) return 'warn';
  return 'ok';
}

/** 2026-11 → 2026-11-01 */
export const monthStart = (month: string) => `${month}-01`;
/** 2026-11-15 → 2026-11 */
export const monthOf = (date: string) => date.slice(0, 7);

export interface BudgetCell {
  category: ExpenseCategory;
  /** 这个月生效的额度（分）；为空 = 不控制 */
  budgetCents: number | null;
  /** 额度从哪个月起（YYYY-MM）；从没设过为空 */
  fromMonth: string | null;
  /** 已占用 = 已确认 + 审批中（待确认、已退回） */
  usedCents: number;
  confirmedCents: number;
  pendingCents: number;
  level: BudgetLevel;
}

export interface BudgetRow {
  departmentId: number;
  departmentName: string;
  active: boolean;
  cells: BudgetCell[];
}

export interface BudgetGrid {
  /** YYYY-MM */
  month: string;
  warnPercent: number;
  categories: { key: ExpenseCategory; label: string }[];
  rows: BudgetRow[];
}

/** 报销单上记的预算核对（每个有额度的科目一条） */
export interface BudgetCheckItem {
  category: ExpenseCategory;
  /** YYYY-MM：费用日期所在的月 */
  month: string;
  budgetCents: number;
  /** 这张以前的已占用（重新提交时不含这张自己） */
  usedBeforeCents: number;
  /** 这张报销里这个科目的金额 */
  claimCents: number;
}

export const budgetOver = (c: BudgetCheckItem) => c.usedBeforeCents + c.claimCents > c.budgetCents;

/** 一句话：办公费 本月额度 ¥2,000.00，之前已占用 ¥1,800.00，这张 ¥500.00（超出 ¥300.00） */
export function budgetCheckText(c: BudgetCheckItem, yuan: (cents: number) => string): string {
  const after = c.usedBeforeCents + c.claimCents;
  const tail = after > c.budgetCents ? `（超出 ${yuan(after - c.budgetCents)}）` : `（报完剩 ${yuan(c.budgetCents - after)}）`;
  return `${EXPENSE_CATEGORY_LABELS[c.category]} ${c.month} 额度 ${yuan(c.budgetCents)}，之前已占用 ${yuan(c.usedBeforeCents)}，这张 ${yuan(c.claimCents)}${tail}`;
}

/** 登记页带出的这个部门这个月各科目的额度与已占用 */
export interface BudgetUsage {
  departmentId: number;
  month: string;
  warnPercent: number;
  cells: BudgetCell[];
}

/** 保存预算：每一格带上页面看到的额度（对不上拒绝 BUDGET_CHANGED） */
export interface BudgetSaveCell {
  departmentId: number;
  category: ExpenseCategory;
  amountCents: number | null;
  seenCents: number | null;
}

export const BUDGET_CATEGORIES = EXPENSE_CATEGORIES.map((key) => ({ key, label: EXPENSE_CATEGORY_LABELS[key] }));
