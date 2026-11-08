// 费用预算（8.0.3，docs/BUDGET_INVOICES.md 第 2 节，默认 BI01–BI06 待确认）。
//
// 口径：
//   · 额度按「部门 × 费用科目 × 起始月」存：某个月生效的额度 = 起始月不晚于这个月的最近一条；额度为空 = 不控制；没设过 = 不控制。
//   · 已占用 = 这个部门、费用日期在这个月、待确认 / 已退回 / 已确认的报销单里这个科目的明细金额之和（撤回、冲销的不算）。
//   · 登记报销（以及退回后重新提交）时逐个科目核对：这张以前的已占用 + 这张这个科目的金额 > 额度，就是超预算（不拦登记，走审批）。
// 加锁：同一部门同一科目的报销登记、重新提交与预算修改按「部门 + 科目」的咨询锁串行（部门 id 升序、科目按固定顺序）；
// 报销里在锁住打款、采购单、发票之后取（报销的锁顺序：打款 → 采购单 → 发票号码 → 预算 → 写报销单）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BUDGET_CATEGORIES,
  BUDGET_MAX_CENTS,
  budgetLevel,
  monthOf,
  monthStart,
  type BudgetCell,
  type BudgetCheckItem,
  type BudgetGrid,
  type BudgetUsage,
} from '@shared/budgets';
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '@shared/expenses';
import { formatAmount } from '@shared/money';
import type { Db, Tx } from '../db';
import { readSnapshot } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { conflict, unprocessable } from '../lib/errors';
import { setTxTimeouts } from '../lib/tx';
import { parse } from '../lib/validate';
import { todayIn } from '../lib/dates';
import { loadExpenseRules } from './expenses';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const Month = z.string().regex(MONTH_RE, '月份要写成 YYYY-MM');
const ACTIVE_CLAIM = ['submitted', 'returned', 'confirmed'] as const;
const key = (departmentId: number, category: string) => `${departmentId}:${category}`;
const yuan = (cents: number) => `¥${formatAmount(cents)}`;

interface Effective {
  amountCents: number | null;
  fromMonth: string;
}

/** 某个月生效的额度（部门:科目 → 额度与起始月） */
async function effectiveBudgets(db: Db, month: string, departmentId?: number): Promise<Map<string, Effective>> {
  const rows = await db<{ departmentId: number; category: string; fromMonth: string; amountCents: number | null }[]>`
    SELECT DISTINCT ON (department_id, category) department_id, category, to_char(from_month, 'YYYY-MM') AS from_month, amount_cents
    FROM expense_budgets
    WHERE from_month <= ${monthStart(month)}::date ${departmentId ? db`AND department_id = ${departmentId}` : db``}
    ORDER BY department_id, category, from_month DESC`;
  return new Map(rows.map((r) => [key(Number(r.departmentId), r.category), { amountCents: r.amountCents === null ? null : Number(r.amountCents), fromMonth: r.fromMonth }]));
}

/** 某个月的已占用（部门:科目 → 已确认、审批中）；excludeClaimId：重新提交时不算这张自己 */
async function usage(db: Db, month: string, opts: { departmentId?: number; excludeClaimId?: number } = {}): Promise<Map<string, { confirmed: number; pending: number }>> {
  const start = monthStart(month);
  const rows = await db<{ departmentId: number; category: string; confirmed: number; pending: number }[]>`
    SELECT c.department_id, l.category,
           coalesce(sum(l.amount_cents) FILTER (WHERE c.status = 'confirmed'), 0)::bigint AS confirmed,
           coalesce(sum(l.amount_cents) FILTER (WHERE c.status IN ('submitted', 'returned')), 0)::bigint AS pending
    FROM expense_claim_lines l JOIN expense_claims c ON c.id = l.claim_id
    WHERE c.expense_date >= ${start}::date AND c.expense_date < (${start}::date + interval '1 month')::date
      AND c.status IN ${db(ACTIVE_CLAIM)}
      ${opts.departmentId ? db`AND c.department_id = ${opts.departmentId}` : db``}
      ${opts.excludeClaimId ? db`AND c.id <> ${opts.excludeClaimId}` : db``}
    GROUP BY c.department_id, l.category`;
  return new Map(rows.map((r) => [key(Number(r.departmentId), r.category), { confirmed: Number(r.confirmed), pending: Number(r.pending) }]));
}

function cellOf(category: ExpenseCategory, eff: Effective | undefined, use: { confirmed: number; pending: number } | undefined, warnPercent: number): BudgetCell {
  const confirmedCents = use?.confirmed ?? 0;
  const pendingCents = use?.pending ?? 0;
  const usedCents = confirmedCents + pendingCents;
  const budgetCents = eff ? eff.amountCents : null;
  return {
    category,
    budgetCents,
    fromMonth: eff ? eff.fromMonth : null,
    usedCents,
    confirmedCents,
    pendingCents,
    level: budgetLevel(budgetCents, usedCents, warnPercent),
  };
}

/** 预算页：一个月的「部门 × 科目」（在用的部门，加上这个月有额度或有占用的停用部门） */
export async function loadBudgetGrid(db: Db, month: string): Promise<BudgetGrid> {
  const rules = await loadExpenseRules(db);
  const [effective, used] = await Promise.all([effectiveBudgets(db, month), usage(db, month)]);
  const departments = await db<{ id: number; name: string; active: boolean }[]>`
    SELECT id, name, active FROM departments ORDER BY active DESC, sort_order, id`;
  const rows = departments
    .map((d) => ({
      departmentId: Number(d.id),
      departmentName: d.name,
      active: d.active,
      cells: EXPENSE_CATEGORIES.map((c) => cellOf(c, effective.get(key(Number(d.id), c)), used.get(key(Number(d.id), c)), rules.budgetWarnPercent)),
    }))
    .filter((r) => r.active || r.cells.some((c) => c.budgetCents !== null || c.usedCents > 0));
  return { month, warnPercent: rules.budgetWarnPercent, categories: BUDGET_CATEGORIES, rows };
}

/** 登记报销页：这个部门这个月各科目的额度与已占用 */
export async function budgetUsage(db: Db, departmentId: number, month: string): Promise<BudgetUsage> {
  const rules = await loadExpenseRules(db);
  const [effective, used] = await Promise.all([effectiveBudgets(db, month, departmentId), usage(db, month, { departmentId })]);
  return {
    departmentId,
    month,
    warnPercent: rules.budgetWarnPercent,
    cells: EXPENSE_CATEGORIES.map((c) => cellOf(c, effective.get(key(departmentId, c)), used.get(key(departmentId, c)), rules.budgetWarnPercent)),
  };
}

/** 「部门 + 科目」的咨询锁：部门 id 升序、科目按固定顺序（报销登记、重新提交与预算修改串行） */
async function lockCells(tx: Tx, cells: { departmentId: number; category: ExpenseCategory }[]) {
  const order = (c: ExpenseCategory) => EXPENSE_CATEGORIES.indexOf(c);
  const sorted = [...new Map(cells.map((c) => [key(c.departmentId, c.category), c])).values()].sort(
    (a, b) => a.departmentId - b.departmentId || order(a.category) - order(b.category),
  );
  for (const c of sorted) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`expense_budget:${key(c.departmentId, c.category)}`}, 0))`;
}

/**
 * 报销的预算核对（在报销的事务里、锁住打款、采购单、发票以后调用；会取「部门 + 科目」的咨询锁）：
 * 只看有额度的科目；这张以前的已占用 + 这张这个科目的金额超过额度就是超预算。
 */
export async function checkClaimBudget(
  tx: Tx,
  input: { departmentId: number; expenseDate: string; lines: { category: ExpenseCategory; amountCents: number }[]; excludeClaimId?: number },
): Promise<{ overBudget: boolean; items: BudgetCheckItem[] }> {
  const byCat = new Map<ExpenseCategory, number>();
  for (const l of input.lines) byCat.set(l.category, (byCat.get(l.category) ?? 0) + l.amountCents);
  const categories = [...byCat.keys()];
  await lockCells(tx, categories.map((category) => ({ departmentId: input.departmentId, category })));
  const month = monthOf(input.expenseDate);
  const effective = await effectiveBudgets(tx, month, input.departmentId);
  const used = await usage(tx, month, { departmentId: input.departmentId, excludeClaimId: input.excludeClaimId });
  const items: BudgetCheckItem[] = [];
  for (const category of EXPENSE_CATEGORIES) {
    const claimCents = byCat.get(category);
    const eff = effective.get(key(input.departmentId, category));
    if (claimCents === undefined || !eff || eff.amountCents === null) continue;
    const u = used.get(key(input.departmentId, category));
    items.push({ category, month, budgetCents: eff.amountCents, usedBeforeCents: (u?.confirmed ?? 0) + (u?.pending ?? 0), claimCents });
  }
  return { overBudget: items.some((i) => i.usedBeforeCents + i.claimCents > i.budgetCents), items };
}

// ───────────────────────── 改额度 ─────────────────────────

const SaveInput = z.object({
  month: Month,
  cells: z
    .array(
      z.object({
        departmentId: z.number().int().positive(),
        category: z.enum(EXPENSE_CATEGORIES),
        amountCents: z.number().int().min(0, '额度不能为负').max(BUDGET_MAX_CENTS, '额度太大了，请检查').nullable(),
        /** 页面上看到的额度（为空 = 不控制）：对不上（别人刚改过）拒绝 */
        seenCents: z.number().int().nullable(),
      }),
    )
    .min(1, '没有要保存的额度')
    .max(400, '一次最多改 400 格'),
});

/**
 * 保存一个月的额度：每一格改的是「从这个月起」的额度（这个月以后没另设的月份都沿用）；和这个月现在生效的一样的格子不动。
 * 在「部门 + 科目」的锁里核对页面看到的额度，有一格对不上整批拒绝（BUDGET_CHANGED）。
 */
export async function saveBudgets(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ changed: number; month: string }> {
  const input = parse(SaveInput, raw);
  const keys = new Set<string>();
  for (const c of input.cells) {
    const k = key(c.departmentId, c.category);
    if (keys.has(k)) throw unprocessable('BUDGET_DUPLICATE', '同一个部门同一个科目只能出现一次');
    keys.add(k);
  }
  const start = monthStart(input.month);
  const changed = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockCells(tx, input.cells);
    const depts = await tx<{ id: number; name: string }[]>`SELECT id, name FROM departments WHERE id IN ${tx(input.cells.map((c) => c.departmentId))}`;
    const deptName = new Map(depts.map((d) => [Number(d.id), d.name]));
    for (const c of input.cells) if (!deptName.has(c.departmentId)) throw unprocessable('DEPARTMENT_INVALID', '部门不存在');
    const effective = await effectiveBudgets(tx, input.month);
    const stale = input.cells.filter((c) => (effective.get(key(c.departmentId, c.category))?.amountCents ?? null) !== c.seenCents);
    if (stale.length) {
      const s = stale[0]!;
      throw conflict('BUDGET_CHANGED', `${deptName.get(s.departmentId)}的${EXPENSE_CATEGORY_LABELS[s.category]}额度刚被别人改过，请刷新后再改`, {
        cells: stale.map((x) => ({ departmentId: x.departmentId, category: x.category })),
      });
    }
    let n = 0;
    for (const c of input.cells) {
      const before = effective.get(key(c.departmentId, c.category));
      if ((before?.amountCents ?? null) === c.amountCents) continue;
      // 没设过、要设成不控制：不用记
      if (!before && c.amountCents === null) continue;
      await tx`
        INSERT INTO expense_budgets (department_id, category, from_month, amount_cents, updated_by)
        VALUES (${c.departmentId}, ${c.category}, ${start}, ${c.amountCents}, ${actor.id})
        ON CONFLICT (department_id, category, from_month) DO UPDATE
          SET amount_cents = EXCLUDED.amount_cents, version = expense_budgets.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'expense_budget',
        targetType: 'department',
        targetId: c.departmentId,
        detail: {
          month: input.month,
          department: deptName.get(c.departmentId),
          category: EXPENSE_CATEGORY_LABELS[c.category],
          from: before?.amountCents ?? null,
          fromMonth: before?.fromMonth ?? null,
          to: c.amountCents,
        },
        ip,
      });
      n += 1;
    }
    return n;
  });
  return { changed, month: input.month };
}

export function registerBudgetRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const thisMonth = () => monthOf(todayIn(config.timezone));
  app.get('/api/erp/expenses/budgets', { preHandler: guard('expense.read') }, async (req) => {
    const { month } = parse(z.object({ month: Month.optional() }), req.query);
    return readSnapshot(sql, (tx) => loadBudgetGrid(tx, month ?? thisMonth()));
  });
  app.get('/api/erp/expenses/budgets/usage', { preHandler: guard('expense.read') }, async (req) => {
    const q = parse(z.object({ departmentId: z.coerce.number().int().positive(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期要写成 YYYY-MM-DD').optional() }), req.query);
    return readSnapshot(sql, (tx) => budgetUsage(tx, q.departmentId, q.date ? monthOf(q.date) : thisMonth()));
  });
  app.put('/api/erp/expenses/budgets', { preHandler: guard('budget.manage') }, async (req) => {
    const r = await saveBudgets(deps, req.body, req.actor, req.ip);
    return { changed: r.changed, grid: await loadBudgetGrid(sql, r.month) };
  });
}

/** 审批页、报销详情的一句话（超了哪个科目） */
export const budgetSummary = (items: BudgetCheckItem[]) =>
  items
    .filter((i) => i.usedBeforeCents + i.claimCents > i.budgetCents)
    .map((i) => `${EXPENSE_CATEGORY_LABELS[i.category]}：${i.month} 额度 ${yuan(i.budgetCents)}，之前已占用 ${yuan(i.usedBeforeCents)}，这张 ${yuan(i.claimCents)}，超出 ${yuan(i.usedBeforeCents + i.claimCents - i.budgetCents)}`)
    .join('；');
