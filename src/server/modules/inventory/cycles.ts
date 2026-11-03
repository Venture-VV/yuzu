// 每月盘点与供应商对账的提醒、对账登记（#23，v0.7.13，见 docs/STOCK_CYCLES.md）。
//
// 盘点提醒：从每月的盘点日起到月底，每个在用的仓按「月初（1 号 0 点）有结存的物料，本月的盘点单都盘到了」算盘完；
//   盘点单已提交或已生效都算，草稿、退回的不算。部门小仓的台面日耗品没有结存，不在里面。
// 对账提醒：挂账供应商分月结 / 按批次。月结：每月对账日起，上个月有往来或上月底余额不为 0、还没登记上个月对账的；
//   按批次：改成按批次那天以后生效的每张收货单，没登记对账的。登记以后数字又变了的另列「登记后有变动」。
// 对账登记只追加，撤销写原因、留经办人。锁顺序：供应商（与付款、核销同一个方向）→ 收货单（id 升序，按批次时）/ 对账登记。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  BatchReconItem,
  MonthlyReconItem,
  ReconReminders,
  StocktakeProgress,
  StocktakeReminders,
  SupplierReconciliation,
} from '@shared/cycles';
import { CENTRAL_WAREHOUSE_ID } from '@shared/inventory';
import { shiftDate } from '@shared/labels';
import { can } from '@shared/permissions';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { idParam, parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import { loadInventorySettings, setTxTimeouts, todayIn } from './common';
import { lockSupplier, statementTotals } from './payables';
import { listWarehouses } from './reports';
import { hashRequest } from '../../lib/idempotency';

// ───────────────────────── 日期 ─────────────────────────

/** 某月 1 号（YYYY-MM-01） */
export const monthStartOf = (date: string) => `${date.slice(0, 7)}-01`;
/** 前后第 n 个月的 1 号 */
export function shiftMonth(monthStart: string, n: number): string {
  const [y, m] = monthStart.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}
/** 这个月的最后一天 */
export const monthEndOf = (monthStart: string) => shiftDate(shiftMonth(monthStart, 1), -1);
/** 这个月的第 day 天（超过月底按月底） */
function dayOfMonth(monthStart: string, day: number): string {
  const d = shiftDate(monthStart, Math.max(1, day) - 1);
  const end = monthEndOf(monthStart);
  return d > end ? end : d;
}

// ───────────────────────── 盘点提醒 ─────────────────────────

interface WarehouseLite {
  id: number;
  name: string;
  kind: 'central' | 'department';
  departmentId: number | null;
}

/**
 * 这些仓的盘点进度：bookBefore 那一刻（月初 0 点）有结存的物料里，from–to 之间的盘点单（已提交或已生效）盘到了几种
 */
export async function stocktakeProgress(
  db: Db,
  warehouses: WarehouseLite[],
  window: { bookBefore: Date | string; from: string; to: string },
): Promise<StocktakeProgress[]> {
  if (warehouses.length === 0) return [];
  const ids = warehouses.map((w) => w.id);
  const rows = await db<
    { warehouseId: number; materialId: number; code: string; name: string; bookMilli: number; inventoryUnit: string; decimals: number; counted: boolean }[]
  >`
    WITH start_book AS (
      SELECT DISTINCT ON (sm.warehouse_id, sm.material_id) sm.warehouse_id, sm.material_id, sm.qty_after_milli
      FROM stock_moves sm
      WHERE sm.warehouse_id IN ${db(ids)} AND sm.created_at < ${window.bookBefore}::timestamptz
      ORDER BY sm.warehouse_id, sm.material_id, sm.id DESC
    ), counted AS (
      SELECT DISTINCT coalesce(d.warehouse_id, ${CENTRAL_WAREHOUSE_ID}) AS warehouse_id, l.material_id
      FROM inv_docs d JOIN inv_doc_lines l ON l.doc_id = d.id
      WHERE d.doc_type = 'count' AND d.status IN ('submitted', 'confirmed') AND d.doc_date BETWEEN ${window.from} AND ${window.to}
        AND coalesce(d.warehouse_id, ${CENTRAL_WAREHOUSE_ID}) IN ${db(ids)}
    )
    SELECT sb.warehouse_id, sb.material_id, m.code, m.name, sb.qty_after_milli AS book_milli, m.inventory_unit, m.decimals,
           (c.material_id IS NOT NULL) AS counted
    FROM start_book sb JOIN materials m ON m.id = sb.material_id
    LEFT JOIN counted c ON c.warehouse_id = sb.warehouse_id AND c.material_id = sb.material_id
    WHERE sb.qty_after_milli > 0 AND m.tracked AND m.active
      AND NOT (m.counter_use AND sb.warehouse_id <> ${CENTRAL_WAREHOUSE_ID})
    ORDER BY sb.warehouse_id, m.code`;
  return warehouses.map((w) => {
    const mine = rows.filter((r) => r.warehouseId === w.id);
    const missing = mine.filter((r) => !r.counted);
    return {
      warehouseId: w.id,
      warehouseName: w.name,
      kind: w.kind,
      departmentId: w.departmentId,
      required: mine.length,
      counted: mine.length - missing.length,
      done: missing.length === 0,
      missing: missing.slice(0, 30).map(({ warehouseId: _w, counted: _c, ...m }) => m),
    };
  });
}

/** 盘点提醒的时间：本月盘点日起提醒，宽限天数后标红 */
async function stocktakeWindow(db: Db, timeZone: string) {
  const settings = await loadInventorySettings(db);
  const today = todayIn(timeZone);
  const month = monthStartOf(today);
  const startDate = dayOfMonth(month, settings.stocktakeDay);
  const dueDate = shiftDate(startDate, settings.stocktakeGraceDays);
  // 月初 0 点（门店时区）
  const [b] = await db<{ at: Date }[]>`SELECT ((${month}::date)::timestamp AT TIME ZONE ${timeZone}) AS at`;
  return { today, month, startDate, dueDate, active: today >= startDate, overdue: today >= dueDate, bookBefore: b!.at };
}

/** 当前账号能看的仓：总仓——仓库、成本核算、负责人；部门小仓——成本核算、负责人（本部门的在「本部门小仓」里看） */
export async function stocktakeReminders(db: Db, actor: Actor, timeZone: string): Promise<StocktakeReminders> {
  const win = await stocktakeWindow(db, timeZone);
  const seesAll = actor.role === 'owner' || can(actor, 'deptStock.audit') || can(actor, 'inventory.approve');
  const all = (await listWarehouses(db)).filter((w) => w.active);
  const visible = all.filter((w) => (w.kind === 'central' ? seesAll || can(actor, 'inventory.operate') : seesAll));
  const warehouses = await stocktakeProgress(
    db,
    visible.map((w) => ({ id: w.id, name: w.name, kind: w.kind, departmentId: w.departmentId })),
    { bookBefore: win.bookBefore, from: win.month, to: win.today },
  );
  const { bookBefore: _b, ...rest } = win;
  return { ...rest, month: win.month.slice(0, 7), warehouses };
}

/** 一个部门小仓本月的盘点提醒（「本部门小仓」页用；调用方已核对能看这个部门） */
export async function deptStocktakeReminder(db: Db, warehouse: WarehouseLite, timeZone: string): Promise<StocktakeReminders> {
  const win = await stocktakeWindow(db, timeZone);
  const warehouses = await stocktakeProgress(db, [warehouse], { bookBefore: win.bookBefore, from: win.month, to: win.today });
  const { bookBefore: _b, ...rest } = win;
  return { ...rest, month: win.month.slice(0, 7), warehouses };
}

// ───────────────────────── 对账提醒 ─────────────────────────

type Snapshot = NonNullable<SupplierReconciliation['snapshot']>;
const SNAPSHOT_KEYS: (keyof Snapshot)[] = ['beginCents', 'openingCents', 'receivedCents', 'returnCreditCents', 'paidCents', 'refundedCents', 'endCents'];
const sameSnapshot = (a: Snapshot, b: Snapshot) => SNAPSHOT_KEYS.every((k) => Number(a[k]) === Number(b[k]));

const canMonthly = (actor: Actor) => can(actor, 'payable.manage');
const canBatch = (actor: Actor) => can(actor, 'payable.manage') || can(actor, 'purchase.manage');

export async function reconReminders(db: Db, actor: Actor, timeZone: string, asOf?: string): Promise<ReconReminders> {
  const settings = await loadInventorySettings(db);
  const today = asOf ?? todayIn(timeZone);
  const thisMonth = monthStartOf(today);
  const prevStart = shiftMonth(thisMonth, -1);
  const prevEnd = shiftDate(thisMonth, -1);
  const startDate = dayOfMonth(thisMonth, settings.monthlyReconDay);
  const dueDate = shiftDate(startDate, settings.monthlyReconGraceDays);

  // 月结：上个月有往来（应付流水或核销）或上月底余额不为 0 的挂账供应商
  const monthlyRows = await db<
    {
      supplierId: number;
      code: string;
      name: string;
      endCents: number;
      reconId: number | null;
      snapshot: Snapshot | null;
    }[]
  >`
    SELECT s.id AS supplier_id, s.code, s.name,
           coalesce((SELECT sum(e.amount_delta_cents) FROM ap_entries e WHERE e.supplier_id = s.id AND e.entry_date <= ${prevEnd}), 0) AS end_cents,
           r.id AS recon_id,
           CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
             'beginCents', r.begin_cents, 'openingCents', r.opening_cents, 'receivedCents', r.received_cents,
             'returnCreditCents', r.return_credit_cents, 'paidCents', r.paid_cents, 'refundedCents', r.refunded_cents,
             'endCents', r.end_cents) END AS snapshot
    FROM suppliers s
    LEFT JOIN supplier_reconciliations r
      ON r.supplier_id = s.id AND r.kind = 'month' AND r.period_month = ${prevStart} AND r.voided_at IS NULL
    WHERE s.settlement = 'credit' AND s.reconcile_cycle = 'monthly'
      AND (EXISTS (SELECT 1 FROM ap_entries e WHERE e.supplier_id = s.id AND e.entry_date BETWEEN ${prevStart} AND ${prevEnd})
           OR EXISTS (SELECT 1 FROM ap_offsets o WHERE o.supplier_id = s.id AND o.status = 'confirmed' AND o.offset_date BETWEEN ${prevStart} AND ${prevEnd})
           OR coalesce((SELECT sum(e.amount_delta_cents) FROM ap_entries e WHERE e.supplier_id = s.id AND e.entry_date <= ${prevEnd}), 0) <> 0)
    ORDER BY s.code`;
  const monthly: MonthlyReconItem[] = [];
  for (const r of monthlyRows) {
    let state: MonthlyReconItem['state'] | null = 'pending';
    if (r.reconId !== null && r.snapshot) {
      const now = await statementTotals(db, r.supplierId, prevStart, prevEnd);
      state = sameSnapshot(r.snapshot, now) ? null : 'changed';
    }
    if (state) {
      monthly.push({
        supplierId: r.supplierId,
        supplierCode: r.code,
        supplierName: r.name,
        month: prevStart.slice(0, 7),
        endCents: Number(r.endCents),
        state,
        reconciliationId: r.reconId,
      });
    }
  }

  // 按批次：改成按批次那天以后生效的收货单没登记的；登记过、之后收货单冲销了的
  const batchRows = await db<
    {
      supplierId: number;
      code: string;
      name: string;
      docId: number;
      docNo: string;
      docDate: string;
      amountCents: number;
      status: string;
      reconId: number | null;
    }[]
  >`
    SELECT s.id AS supplier_id, s.code, s.name, d.id AS doc_id, d.doc_no, d.doc_date::text AS doc_date, d.amount_cents, d.status, r.id AS recon_id
    FROM inv_docs d JOIN suppliers s ON s.id = d.supplier_id
    LEFT JOIN LATERAL (
      SELECT rr.id FROM supplier_reconciliation_docs rd JOIN supplier_reconciliations rr ON rr.id = rd.reconciliation_id
      WHERE rd.doc_id = d.id AND rr.voided_at IS NULL ORDER BY rr.id LIMIT 1
    ) r ON true
    WHERE d.doc_type = 'receipt' AND coalesce(d.settlement, 'credit') = 'credit'
      AND ((d.status = 'confirmed' AND r.id IS NULL AND s.settlement = 'credit' AND s.reconcile_cycle = 'batch' AND d.doc_date >= s.reconcile_since)
           OR (d.status = 'voided' AND r.id IS NOT NULL))
    ORDER BY d.doc_date, d.id`;
  const batch: BatchReconItem[] = batchRows.map((r) => {
    const due = shiftDate(r.docDate, settings.batchReconGraceDays);
    const voided = r.status === 'voided';
    return {
      supplierId: r.supplierId,
      supplierCode: r.code,
      supplierName: r.name,
      docId: r.docId,
      docNo: r.docNo,
      docDate: r.docDate,
      amountCents: Number(r.amountCents),
      dueDate: due,
      overdue: !voided && today >= due,
      state: voided ? 'changed' : 'pending',
      voided,
      reconciliationId: r.reconId,
    };
  });

  return {
    today,
    monthly: {
      month: prevStart.slice(0, 7),
      startDate,
      dueDate,
      active: today >= startDate,
      overdue: today >= dueDate,
      items: monthly,
    },
    batch,
    canMonthly: canMonthly(actor),
    canBatch: canBatch(actor),
  };
}

// ───────────────────────── 对账登记 ─────────────────────────

const ReconInput = z
  .object({
    clientKey: z.uuid('操作编号格式不正确'),
    supplierId: z.number().int().positive(),
    kind: z.enum(['month', 'batch']),
    /** 月结：对的是哪个月 */
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式不正确')
      .optional(),
    /** 按批次：哪几张收货单 */
    docIds: z.array(z.number().int().positive()).max(50, '一次最多登记 50 张收货单').optional(),
    note: z.string().trim().max(200, '备注最多 200 字').default(''),
  })
  .refine((r) => (r.kind === 'month' ? !!r.month : (r.docIds?.length ?? 0) > 0), {
    message: '月结要选月份，按批次要选收货单',
  });
/** 撤销也带操作编号（v0.7.14，v0.7.13 审查的修正）：提交前存本机，断网后查回、重提或作废 */
const VoidInput = z.object({
  clientKey: z.uuid('操作编号格式不正确'),
  reason: z.string().trim().min(2, '请填写撤销原因（至少 2 个字）').max(200),
});

async function findByKey(db: Db, key: string, requestHash: string, opType: 'supplier_recon' | 'supplier_recon_void' = 'supplier_recon'): Promise<number | null> {
  const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`
    SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${key}`;
  if (!row) return null;
  if (row.opType !== opType || row.requestHash !== requestHash) {
    throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于其他内容，请刷新后重新填写');
  }
  return Number(row.refId);
}

function assertCanKind(actor: Actor, kind: 'month' | 'batch') {
  if (kind === 'month' ? !canMonthly(actor) : !canBatch(actor)) {
    throw forbidden(kind === 'month' ? '月结对账由对账付款登记' : '按批次对账由采购经办或对账付款登记');
  }
}

export async function createReconciliation(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(ReconInput, raw);
  assertCanKind(actor, input.kind);
  const today = todayIn(deps.config.timezone);
  const docIds = [...new Set(input.docIds ?? [])].sort((a, b) => a - b);
  if (input.kind === 'batch' && docIds.length !== (input.docIds ?? []).length) throw badRequest('同一张收货单只能选一次');
  const requestHash = hashRequest({ ...input, clientKey: undefined, docIds: input.kind === 'batch' ? docIds : undefined });
  let reconId: number;
  let replayed = false;
  try {
    const r = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      const existing = await findByKey(tx, input.clientKey, requestHash);
      if (existing) return { id: existing, replayed: true };
      await assertNotFenced(tx, input.clientKey, 'supplier_recon', erpOpAbandoned);
      await lockSupplier(tx, input.supplierId);
      const [sup] = await tx<{ settlement: string; code: string; name: string }[]>`SELECT settlement, code, name FROM suppliers WHERE id = ${input.supplierId}`;
      if (sup!.settlement !== 'credit') throw unprocessable('SUPPLIER_CASH', '现付供应商的货款走费用报销，不用对账');
      let newId: number;
      if (input.kind === 'month') {
        const periodMonth = `${input.month!}-01`;
        if (periodMonth >= monthStartOf(today)) throw unprocessable('MONTH_NOT_ENDED', '只能登记已经过完的月份（这个月还没结束）');
        const [dup] = await tx<{ id: number }[]>`
          SELECT id FROM supplier_reconciliations
          WHERE supplier_id = ${input.supplierId} AND kind = 'month' AND period_month = ${periodMonth} AND voided_at IS NULL`;
        if (dup) throw conflict('RECON_EXISTS', `${sup!.name} ${input.month} 已经登记过对账；要重新登记请先撤销原来的`);
        const t = await statementTotals(tx, input.supplierId, periodMonth, monthEndOf(periodMonth));
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO supplier_reconciliations (supplier_id, kind, period_month, begin_cents, opening_cents, received_cents, return_credit_cents,
                                                paid_cents, refunded_cents, end_cents, total_cents, note, client_key, created_by)
          VALUES (${input.supplierId}, 'month', ${periodMonth}, ${t.beginCents}, ${t.openingCents}, ${t.receivedCents}, ${t.returnCreditCents},
                  ${t.paidCents}, ${t.refundedCents}, ${t.endCents}, ${t.endCents}, ${input.note}, ${input.clientKey}, ${actor.id})
          RETURNING id`;
        newId = row!.id;
      } else {
        // 供应商已锁住：同一供应商的登记串行，一张收货单不会同时被两条登记占用；收货单按 id 升序加共享锁
        const docs = await tx<{ id: number; docNo: string; docType: string; status: string; supplierId: number | null; settlement: string | null; amountCents: number }[]>`
          SELECT id, doc_no, doc_type, status, supplier_id, settlement, amount_cents FROM inv_docs WHERE id IN ${tx(docIds)} ORDER BY id FOR SHARE`;
        if (docs.length !== docIds.length) throw notFound('有收货单不存在，请刷新后重试');
        for (const d of docs) {
          if (d.docType !== 'receipt' || d.supplierId !== input.supplierId) throw unprocessable('RECON_DOC_INVALID', `${d.docNo} 不是这个供应商的收货单`);
          if (d.status !== 'confirmed') throw unprocessable('RECON_DOC_INVALID', `${d.docNo} 还没生效或已冲销，不能登记对账`);
          if ((d.settlement ?? 'credit') !== 'credit') throw unprocessable('RECON_DOC_INVALID', `${d.docNo} 是现付的收货，不用对账`);
        }
        const taken = await tx<{ docNo: string }[]>`
          SELECT d.doc_no FROM supplier_reconciliation_docs rd JOIN supplier_reconciliations r ON r.id = rd.reconciliation_id
          JOIN inv_docs d ON d.id = rd.doc_id
          WHERE rd.doc_id IN ${tx(docIds)} AND r.voided_at IS NULL ORDER BY d.id`;
        if (taken.length > 0) throw conflict('RECON_DOC_TAKEN', `${taken.map((t) => t.docNo).join('、')} 已经登记过对账`);
        const total = docs.reduce((sum, d) => sum + Number(d.amountCents), 0);
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO supplier_reconciliations (supplier_id, kind, total_cents, note, client_key, created_by)
          VALUES (${input.supplierId}, 'batch', ${total}, ${input.note}, ${input.clientKey}, ${actor.id})
          RETURNING id`;
        newId = row!.id;
        for (const d of docs) {
          await tx`INSERT INTO supplier_reconciliation_docs (reconciliation_id, doc_id, amount_cents) VALUES (${newId}, ${d.id}, ${d.amountCents})`;
        }
      }
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'supplier_recon', ${requestHash}, ${newId}, ${actor.id})`;
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'payable_doc',
        targetType: 'supplier_reconciliation',
        targetId: newId,
        detail: { reconciled: true, supplierId: input.supplierId, kind: input.kind, month: input.month ?? null, docIds: input.kind === 'batch' ? docIds : null },
        ip,
      });
      return { id: newId, replayed: false };
    });
    reconId = r.id;
    replayed = r.replayed;
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, 'supplier_reconciliations_client_key_key')) {
      const existing = await findByKey(deps.sql, input.clientKey, requestHash);
      if (!existing) throw error;
      reconId = existing;
      replayed = true;
    } else if (isUniqueViolation(error, 'supplier_recon_month_once')) {
      throw conflict('RECON_EXISTS', `${input.month} 已经登记过对账；要重新登记请先撤销原来的`);
    } else throw error;
  }
  return { reconciliation: await getReconciliation(deps.sql, reconId), replayed };
}

export async function voidReconciliation(deps: Deps, reconId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(VoidInput, raw);
  const [head] = await deps.sql<{ supplierId: number; kind: 'month' | 'batch' }[]>`SELECT supplier_id, kind FROM supplier_reconciliations WHERE id = ${reconId}`;
  if (!head) throw notFound('对账登记不存在');
  assertCanKind(actor, head.kind);
  const requestHash = hashRequest({ reconId, reason: input.reason });
  let replayed = false;
  try {
    replayed = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      if (await findByKey(tx, input.clientKey, requestHash, 'supplier_recon_void')) return true;
      // 页面上确认作废过的编号：原请求晚到也不撤销
      await assertNotFenced(tx, input.clientKey, 'supplier_recon_void', erpOpAbandoned);
      await lockSupplier(tx, head.supplierId);
      const [cur] = await tx<{ voidedAt: string | null }[]>`SELECT voided_at FROM supplier_reconciliations WHERE id = ${reconId} FOR UPDATE`;
      // 已经被撤销（别的请求）：这一笔也算完成，记下编号
      if (!cur!.voidedAt) {
        await tx`UPDATE supplier_reconciliations SET voided_by = ${actor.id}, voided_at = now(), void_reason = ${input.reason} WHERE id = ${reconId}`;
        await writeAudit(tx, { staffId: actor.id, action: 'payable_doc', targetType: 'supplier_reconciliation', targetId: reconId, detail: { voided: true, reason: input.reason }, ip });
      }
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'supplier_recon_void', ${requestHash}, ${reconId}, ${actor.id})`;
      return false;
    });
  } catch (error) {
    if (!isUniqueViolation(error, 'idempotency_keys_pkey') || !(await findByKey(deps.sql, input.clientKey, requestHash, 'supplier_recon_void'))) throw error;
    replayed = true;
  }
  return { reconciliation: await getReconciliation(deps.sql, reconId), replayed };
}

const RECON_SELECT = (db: Db) => db`
  SELECT r.id, r.supplier_id, s.code AS supplier_code, s.name AS supplier_name, r.kind,
         CASE WHEN r.period_month IS NULL THEN NULL ELSE to_char(r.period_month, 'YYYY-MM') END AS month,
         r.period_month::text AS period_month,
         r.begin_cents, r.opening_cents, r.received_cents, r.return_credit_cents, r.paid_cents, r.refunded_cents, r.end_cents,
         r.total_cents, r.note, cb.display_name AS created_by_name, r.created_at,
         vb.display_name AS voided_by_name, r.voided_at, r.void_reason
  FROM supplier_reconciliations r JOIN suppliers s ON s.id = r.supplier_id
  JOIN staff cb ON cb.id = r.created_by LEFT JOIN staff vb ON vb.id = r.voided_by`;

interface ReconRow {
  id: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  kind: 'month' | 'batch';
  month: string | null;
  periodMonth: string | null;
  beginCents: number | null;
  openingCents: number | null;
  receivedCents: number | null;
  returnCreditCents: number | null;
  paidCents: number | null;
  refundedCents: number | null;
  endCents: number | null;
  totalCents: number;
  note: string;
  createdByName: string;
  createdAt: string;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

async function toReconciliation(db: Db, r: ReconRow): Promise<SupplierReconciliation> {
  let snapshot: SupplierReconciliation['snapshot'] = null;
  let current: SupplierReconciliation['current'] = null;
  let docs: SupplierReconciliation['docs'] = [];
  let changed = false;
  if (r.kind === 'month') {
    snapshot = {
      beginCents: Number(r.beginCents),
      openingCents: Number(r.openingCents),
      receivedCents: Number(r.receivedCents),
      returnCreditCents: Number(r.returnCreditCents),
      paidCents: Number(r.paidCents),
      refundedCents: Number(r.refundedCents),
      endCents: Number(r.endCents),
    };
    const t = await statementTotals(db, r.supplierId, r.periodMonth!, monthEndOf(r.periodMonth!));
    current = {
      beginCents: Number(t.beginCents),
      openingCents: Number(t.openingCents),
      receivedCents: Number(t.receivedCents),
      returnCreditCents: Number(t.returnCreditCents),
      paidCents: Number(t.paidCents),
      refundedCents: Number(t.refundedCents),
      endCents: Number(t.endCents),
    };
    changed = r.voidedAt === null && !sameSnapshot(snapshot, current);
  } else {
    docs = await db<SupplierReconciliation['docs']>`
      SELECT d.id AS doc_id, d.doc_no, d.doc_date::text AS doc_date, rd.amount_cents, d.status
      FROM supplier_reconciliation_docs rd JOIN inv_docs d ON d.id = rd.doc_id
      WHERE rd.reconciliation_id = ${r.id} ORDER BY d.doc_date, d.id`;
    changed = r.voidedAt === null && docs.some((d) => d.status !== 'confirmed');
  }
  return {
    id: r.id,
    supplierId: r.supplierId,
    supplierCode: r.supplierCode,
    supplierName: r.supplierName,
    kind: r.kind,
    month: r.month,
    snapshot,
    current,
    totalCents: Number(r.totalCents),
    docs: docs.map((d) => ({ ...d, amountCents: Number(d.amountCents) })),
    note: r.note,
    createdByName: r.createdByName,
    createdAt: r.createdAt,
    voided: r.voidedAt ? { byName: r.voidedByName ?? '', at: r.voidedAt, reason: r.voidReason ?? '' } : null,
    changed,
  };
}

export async function getReconciliation(db: Db, reconId: number): Promise<SupplierReconciliation> {
  const [r] = await db<ReconRow[]>`${RECON_SELECT(db)} WHERE r.id = ${reconId}`;
  if (!r) throw notFound('对账登记不存在');
  return toReconciliation(db, r);
}

/** 对账登记记录，新的在前；beforeId 往前翻页（v0.7.14：超过一页的也能找到并撤销） */
export async function listReconciliations(db: Db, q: { supplierId?: number; limit?: number; beforeId?: number }): Promise<SupplierReconciliation[]> {
  const rows = await db<ReconRow[]>`
    ${RECON_SELECT(db)}
    WHERE true
      ${q.supplierId ? db`AND r.supplier_id = ${q.supplierId}` : db``}
      ${q.beforeId ? db`AND r.id < ${q.beforeId}` : db``}
    ORDER BY r.id DESC LIMIT ${q.limit ?? 50}`;
  const out: SupplierReconciliation[] = [];
  for (const r of rows) out.push(await toReconciliation(db, r));
  return out;
}

// ───────────────────────── 自检 ─────────────────────────

/** 对账登记的自检项（`check`）：同一月份最多一条有效登记由唯一索引保证；这里核对按批次登记的收货单 */
export async function reconciliationChecks(db: Db) {
  const bad = await db<{ docNo: string }[]>`
    SELECT d.doc_no FROM supplier_reconciliation_docs rd
    JOIN supplier_reconciliations r ON r.id = rd.reconciliation_id
    JOIN inv_docs d ON d.id = rd.doc_id
    WHERE r.voided_at IS NULL AND (r.kind <> 'batch' OR d.doc_type <> 'receipt' OR d.supplier_id IS DISTINCT FROM r.supplier_id)
    UNION
    SELECT d.doc_no FROM supplier_reconciliation_docs rd
    JOIN supplier_reconciliations r ON r.id = rd.reconciliation_id
    JOIN inv_docs d ON d.id = rd.doc_id
    WHERE r.voided_at IS NULL
    GROUP BY d.id, d.doc_no HAVING count(*) > 1`;
  const sums = await db<{ id: number }[]>`
    SELECT r.id FROM supplier_reconciliations r
    WHERE r.kind = 'batch'
      AND r.total_cents <> coalesce((SELECT sum(amount_cents) FROM supplier_reconciliation_docs WHERE reconciliation_id = r.id), 0)`;
  return { bad: bad.map((b) => b.docNo), badTotals: sums.map((s) => s.id) };
}

// ───────────────────────── 接口 ─────────────────────────

export function registerCycleRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  // 盘点提醒：总仓与所有部门小仓（本部门的在「本部门小仓」接口里）
  app.get('/api/inventory/cycles/stocktake', { preHandler: guardAny('inventory.operate', 'deptStock.audit', 'inventory.approve') }, async (req) =>
    readSnapshot(sql, (tx) => stocktakeReminders(tx, req.actor, config.timezone)),
  );
  // 对账提醒与登记
  app.get('/api/payables/cycles', { preHandler: guard('payable.read') }, async (req) =>
    readSnapshot(sql, (tx) => reconReminders(tx, req.actor, config.timezone)),
  );
  app.get('/api/payables/reconciliations', { preHandler: guard('payable.read') }, async (req) => {
    const q = parse(
      z.object({
        supplierId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        beforeId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    return readSnapshot(sql, (tx) => listReconciliations(tx, q));
  });
  app.get('/api/payables/reconciliations/:id', { preHandler: guard('payable.read') }, async (req) =>
    readSnapshot(sql, (tx) => getReconciliation(tx, parse(idParam, req.params).id)),
  );
  app.post('/api/payables/reconciliations', { preHandler: guardAny('payable.manage', 'purchase.manage') }, async (req, reply) => {
    const r = await createReconciliation(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/payables/reconciliations/:id/void', { preHandler: guardAny('payable.manage', 'purchase.manage') }, async (req) =>
    voidReconciliation(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip),
  );
}
