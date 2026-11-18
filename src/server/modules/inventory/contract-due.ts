// 8.1.10 急采后补合同（docs/ERP_V8110.md 第 1 节，PENDING_DECISIONS CK18–CK22）里只读的部分：哪些急采要补合同、还没补上，
// 付款与报销在哪里拦（CONTRACT_REQUIRED），期限与待补合同清单。付款、报销、采购单详情、待办数都从这里取，
// 所以这个文件不引用采购单、付款的模块（补合同本身在 urgent-contract.ts）。

import type { PurchaseOrder, UrgentContractDueRow } from '@shared/purchasing';
import type { Db } from '../../db';
import { unprocessable } from '../../lib/errors';
import { todayIn } from './common';
import { loadPurchaseRules } from './purchase-rules';

const message = (docNo: string) => `急采 ${docNo} 的金额达到要补合同的线，请先在它的补单采购单上补合同；补上以后从合同的付款计划里申请付款`;

/** 这几张收货单里第一张要补合同、还没补上的急采（没补采购单的也算），没有为空 */
export async function contractDueAmong(db: Db, receiptIds: number[]): Promise<{ docNo: string } | null> {
  if (receiptIds.length === 0) return null;
  const [r] = await db<{ docNo: string }[]>`
    SELECT d.doc_no FROM inv_docs d LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
    WHERE d.id IN ${db(receiptIds)} AND d.needs_contract AND po.contract_id IS NULL
    ORDER BY d.id LIMIT 1`;
  return r ?? null;
}

/** 付款申请、直接登记付款、预付款核销：要补合同、还没补上的急采拒绝 */
export async function assertContractNotDue(db: Db, receiptIds: number[]): Promise<void> {
  const hit = await contractDueAmong(db, receiptIds);
  if (hit) throw unprocessable('CONTRACT_REQUIRED', message(hit.docNo), { docNo: hit.docNo });
}

/** 现付供应商按采购单报销（CK22）：补单采购单的急采要补合同、还没补上的拒绝 */
export async function assertPoContractNotDue(db: Db, poId: number): Promise<void> {
  const [r] = await db<{ docNo: string }[]>`
    SELECT d.doc_no FROM purchase_orders po JOIN inv_docs d ON d.id = po.backfill_receipt_id
    WHERE po.id = ${poId} AND po.contract_id IS NULL AND d.needs_contract`;
  if (r) throw unprocessable('CONTRACT_REQUIRED', message(r.docNo), { docNo: r.docNo });
}

/** 期限与还剩几天（负数 = 超期几天）：急采生效那天（门店日期）+ 补合同期限 */
const DUE_SQL = (db: Db, timezone: string, days: number, today: string) => db`
  ((d.confirmed_at AT TIME ZONE ${timezone})::date + ${days}::int)::text AS due_on,
  ((d.confirmed_at AT TIME ZONE ${timezone})::date + ${days}::int - ${today}::date) AS days_left`;

/** 补单采购单上显示的「要补合同 · 还剩 N 天」：补上了、不要求的为空 */
export async function poContractDue(db: Db, poId: number, timezone: string): Promise<NonNullable<PurchaseOrder['contractDue']> | null> {
  const days = (await loadPurchaseRules(db)).contractDueDays;
  const [r] = await db<{ dueOn: string; daysLeft: number }[]>`
    SELECT ${DUE_SQL(db, timezone, days, todayIn(timezone))}
    FROM purchase_orders po JOIN inv_docs d ON d.id = po.backfill_receipt_id
    WHERE po.id = ${poId} AND po.contract_id IS NULL AND d.needs_contract AND d.status = 'confirmed'`;
  return r ? { dueOn: r.dueOn, daysLeft: Number(r.daysLeft) } : null;
}

/** 急采收货单上显示的「要补合同 · 还剩 N 天」 */
export async function receiptContractDue(db: Db, receiptId: number, timezone: string): Promise<NonNullable<PurchaseOrder['contractDue']> | null> {
  const days = (await loadPurchaseRules(db)).contractDueDays;
  const [r] = await db<{ dueOn: string; daysLeft: number }[]>`
    SELECT ${DUE_SQL(db, timezone, days, todayIn(timezone))}
    FROM inv_docs d LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
    WHERE d.id = ${receiptId} AND d.needs_contract AND d.status = 'confirmed' AND po.contract_id IS NULL`;
  return r ? { dueOn: r.dueOn, daysLeft: Number(r.daysLeft) } : null;
}

/** 待补合同清单：要补合同、还没补上的急采（还没补采购单的也列），期限早的在前 */
export async function listContractDue(db: Db, timezone: string): Promise<UrgentContractDueRow[]> {
  const days = (await loadPurchaseRules(db)).contractDueDays;
  const rows = await db<(Omit<UrgentContractDueRow, 'daysLeft' | 'poId'> & { poId: number | null; daysLeft: number | string })[]>`
    SELECT d.id AS receipt_id, d.doc_no, d.doc_date::text, s.name AS supplier_name, dep.name AS department_name, d.amount_cents,
           po.id AS po_id, po.doc_no AS po_no, ${DUE_SQL(db, timezone, days, todayIn(timezone))}
    FROM inv_docs d
    JOIN suppliers s ON s.id = d.supplier_id
    LEFT JOIN warehouses w ON w.id = d.warehouse_id
    LEFT JOIN departments dep ON dep.id = w.department_id
    LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
    WHERE d.needs_contract AND d.status = 'confirmed' AND po.contract_id IS NULL
    ORDER BY due_on, d.id`;
  return rows.map((r) => ({ ...r, receiptId: Number(r.receiptId), poId: r.poId === null ? null : Number(r.poId), daysLeft: Number(r.daysLeft) }));
}

/** 待补合同几张（采购的待办数） */
export async function contractDueCount(db: Db): Promise<number> {
  const [r] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM inv_docs d LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
    WHERE d.needs_contract AND d.status = 'confirmed' AND po.contract_id IS NULL`;
  return r!.n;
}
