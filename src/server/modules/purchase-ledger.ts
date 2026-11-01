// 采购台账（按日逐笔）、12 条账目自检、下单物料（v0.7.9，飞书需求 RQ-005 第三步，见 docs/LEDGER.md）。会员的流水在 modules/ledger.ts，与这里无关。
//
// · 只读：都是对已有单据（打款、报销、退回补付、采购单、收货、需求单）的查询，不改数据；
// · 账目自检是经营预警，不进 `check`（`check` 只管数据一致性，必须全 ✓）；
// · 下单物料导出带图片的 Excel（lib/xlsx.ts）：每行嵌入第一张图片，图片总量有上限，超过的行写明没嵌入。

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { EXPENSE_CATEGORY_LABELS, PAY_SOURCE_LABELS, type ExpenseCategory, type PaySource } from '@shared/expenses';
import {
  AUDIT_KIND_LABELS,
  LEDGER_KIND_LABELS,
  ORDERED_STATE_LABELS,
  type AuditItem,
  type AuditRule,
  type Ledger,
  type LedgerAudit,
  type LedgerEntry,
  type LedgerKind,
  type LedgerTotals,
  type OrderedLine,
  type OrderedLines,
  type OrderedState,
} from '@shared/purchase-ledger';
import { formatAmount } from '@shared/money';
import { PAY_METHOD_LABELS, type PayMethod } from '@shared/purchasing';
import { formatQty } from '@shared/quantity';
import type { ImageRef } from '@shared/requests';
import { readSnapshot, type Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { toCsv } from '../lib/csv';
import { badRequest, unprocessable } from '../lib/errors';
import { dateSchema, parse } from '../lib/validate';
import { buildXlsx, type XlsxImage } from '../lib/xlsx';
import { advanceRows, loadExpenseRules, toAdvanceSummary } from './expenses';
import { todayIn } from './inventory/common';

/** 页面最多显示多少笔；合计与导出不受这个限制 */
const LEDGER_LIST_LIMIT = 3000;
const EXPORT_LIMIT = 20_000;
/** 下单物料导出 Excel：最多多少行，嵌入的图片最多多少字节 */
const ORDERED_EXPORT_ROWS = 3000;
const ORDERED_IMAGE_BUDGET = 60 * 1024 * 1024;
const AUDIT_ITEMS = 50;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function checkRange(from: string, to: string) {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) throw badRequest('开始日期不能晚于结束日期');
  if (daysBetween(from, to) > 366) throw badRequest('一次最多查 366 天');
}

function csvReply(reply: FastifyReply, name: string, csv: string) {
  reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  return csv;
}

// ───────────────────────── 采购台账 ─────────────────────────

interface LedgerFilter {
  from: string;
  to: string;
  departmentId?: number;
  handlerId?: number;
}

type PurchaseLedgerRow = Omit<LedgerEntry, 'department' | 'handler' | 'qty' | 'description'> & {
  departmentId: number;
  departmentName: string;
  handlerId: number;
  handlerName: string;
  itemName: string | null;
  method: PayMethod | null;
  evidence: string | null;
  boughtMilli: number | null;
  receivedMilli: number | null;
  unit: string | null;
};

const KIND_ORDER: Record<LedgerKind, number> = { advance: 0, expense: 1, return: 2, topup: 3 };

// 部门、经办人筛选：打款与退回补付按所属打款（别名 a），报销按报销单（别名 c）。
// 逐笔、合计、导出前的笔数都用这两个，口径一致（v0.7.9 审查修正：导出笔数原来没按部门、经办人筛选）
const byAdvance = (db: Db, f: LedgerFilter) =>
  db`${f.departmentId ? db`AND a.department_id = ${f.departmentId}` : db``} ${f.handlerId ? db`AND a.handler_id = ${f.handlerId}` : db``}`;
const byClaim = (db: Db, f: LedgerFilter) =>
  db`${f.departmentId ? db`AND c.department_id = ${f.departmentId}` : db``} ${f.handlerId ? db`AND c.handler_id = ${f.handlerId}` : db``}`;

async function ledgerRows(db: Db, f: LedgerFilter, limit: number | null): Promise<PurchaseLedgerRow[]> {
  const rows = await db<PurchaseLedgerRow[]>`
    SELECT * FROM (
      SELECT 'advance'::text AS kind, a.advance_date AS date, a.doc_no, a.id AS ref_id, a.id AS advance_id, a.doc_no AS advance_no,
             a.department_id, d.name AS department_name, a.handler_id, h.display_name AS handler_name,
             NULL::text AS item_name, a.method, a.evidence, NULL::text AS category, NULL::bigint AS bought_milli, NULL::bigint AS received_milli,
             NULL::text AS unit, NULL::text AS pay_source, NULL::text AS po_no, a.amount_cents, 1 AS line_no
      FROM petty_advances a JOIN departments d ON d.id = a.department_id JOIN staff h ON h.id = a.handler_id
      WHERE a.status = 'active' AND a.advance_date BETWEEN ${f.from} AND ${f.to} ${byAdvance(db, f)}
      UNION ALL
      SELECT s.kind, s.settle_date, s.doc_no, s.id, a.id, a.doc_no,
             a.department_id, d.name, a.handler_id, h.display_name,
             NULL, s.method, s.evidence, NULL, NULL, NULL, NULL, NULL, NULL, s.amount_cents, 1
      FROM petty_settlements s JOIN petty_advances a ON a.id = s.advance_id
      JOIN departments d ON d.id = a.department_id JOIN staff h ON h.id = a.handler_id
      WHERE s.status = 'active' AND s.settle_date BETWEEN ${f.from} AND ${f.to} ${byAdvance(db, f)}
      UNION ALL
      SELECT 'expense', c.expense_date, c.doc_no, c.id, c.advance_id, a.doc_no,
             c.department_id, d.name, c.handler_id, h.display_name,
             l.name, NULL, NULL, l.category, l.bought_milli, l.received_milli, l.unit, c.pay_source, po.doc_no, l.amount_cents, l.line_no
      FROM expense_claim_lines l JOIN expense_claims c ON c.id = l.claim_id
      JOIN departments d ON d.id = c.department_id JOIN staff h ON h.id = c.handler_id
      LEFT JOIN petty_advances a ON a.id = c.advance_id LEFT JOIN purchase_orders po ON po.id = c.purchase_order_id
      WHERE c.status = 'confirmed' AND c.expense_date BETWEEN ${f.from} AND ${f.to} ${byClaim(db, f)}
    ) t
    ORDER BY date DESC, CASE kind WHEN 'advance' THEN 0 WHEN 'expense' THEN 1 WHEN 'return' THEN 2 ELSE 3 END, doc_no, line_no
    ${limit ? db`LIMIT ${limit}` : db``}`;
  return rows;
}

function toEntry(r: PurchaseLedgerRow): LedgerEntry {
  const qty = r.kind === 'expense' && r.unit !== null ? { boughtMilli: Number(r.boughtMilli), receivedMilli: Number(r.receivedMilli), unit: r.unit } : null;
  const description = r.kind === 'expense' ? (r.itemName ?? '') : [r.method ? PAY_METHOD_LABELS[r.method] : '', r.evidence ?? ''].filter(Boolean).join(' · ');
  return {
    kind: r.kind,
    date: r.date,
    docNo: r.docNo,
    refId: Number(r.refId),
    advanceId: r.advanceId === null ? null : Number(r.advanceId),
    advanceNo: r.advanceNo,
    department: { id: Number(r.departmentId), name: r.departmentName },
    handler: { id: Number(r.handlerId), name: r.handlerName },
    description,
    category: (r.category as ExpenseCategory | null) ?? null,
    qty,
    paySource: (r.paySource as PaySource | null) ?? null,
    poNo: r.poNo,
    amountCents: Number(r.amountCents),
  };
}

const emptyTotals = (): LedgerTotals => ({ advanceCents: 0, pettySpentCents: 0, companySpentCents: 0, returnedCents: 0, toppedUpCents: 0 });
function addTo(t: LedgerTotals, e: { kind: LedgerKind; paySource: PaySource | null; amountCents: number }) {
  if (e.kind === 'advance') t.advanceCents += e.amountCents;
  else if (e.kind === 'return') t.returnedCents += e.amountCents;
  else if (e.kind === 'topup') t.toppedUpCents += e.amountCents;
  else if (e.paySource === 'petty') t.pettySpentCents += e.amountCents;
  else t.companySpentCents += e.amountCents;
}

/** 合计按全部单据算（不受显示上限影响） */
async function ledgerTotals(db: Db, f: LedgerFilter): Promise<LedgerTotals> {
  const [t] = await db<LedgerTotals[]>`
    SELECT
      coalesce((SELECT sum(a.amount_cents) FROM petty_advances a WHERE a.status = 'active' AND a.advance_date BETWEEN ${f.from} AND ${f.to}
                ${byAdvance(db, f)}), 0)::bigint AS advance_cents,
      coalesce((SELECT sum(c.amount_cents) FROM expense_claims c WHERE c.status = 'confirmed' AND c.pay_source = 'petty' AND c.expense_date BETWEEN ${f.from} AND ${f.to}
                ${byClaim(db, f)}), 0)::bigint AS petty_spent_cents,
      coalesce((SELECT sum(c.amount_cents) FROM expense_claims c WHERE c.status = 'confirmed' AND c.pay_source = 'company' AND c.expense_date BETWEEN ${f.from} AND ${f.to}
                ${byClaim(db, f)}), 0)::bigint AS company_spent_cents,
      coalesce((SELECT sum(s.amount_cents) FROM petty_settlements s JOIN petty_advances a ON a.id = s.advance_id
                WHERE s.status = 'active' AND s.kind = 'return' AND s.settle_date BETWEEN ${f.from} AND ${f.to}
                ${byAdvance(db, f)}), 0)::bigint AS returned_cents,
      coalesce((SELECT sum(s.amount_cents) FROM petty_settlements s JOIN petty_advances a ON a.id = s.advance_id
                WHERE s.status = 'active' AND s.kind = 'topup' AND s.settle_date BETWEEN ${f.from} AND ${f.to}
                ${byAdvance(db, f)}), 0)::bigint AS topped_up_cents`;
  return {
    advanceCents: Number(t!.advanceCents),
    pettySpentCents: Number(t!.pettySpentCents),
    companySpentCents: Number(t!.companySpentCents),
    returnedCents: Number(t!.returnedCents),
    toppedUpCents: Number(t!.toppedUpCents),
  };
}

export async function buildLedger(db: Db, f: LedgerFilter): Promise<Ledger> {
  const rows = await ledgerRows(db, f, LEDGER_LIST_LIMIT + 1);
  const truncated = rows.length > LEDGER_LIST_LIMIT;
  const entries = rows.slice(0, LEDGER_LIST_LIMIT).map(toEntry);
  const byDate = new Map<string, Ledger['days'][number]>();
  for (const e of entries) {
    let day = byDate.get(e.date);
    if (!day) {
      day = { date: e.date, entries: [], totals: emptyTotals() };
      byDate.set(e.date, day);
    }
    day.entries.push(e);
    addTo(day.totals, e);
  }
  for (const day of byDate.values()) day.entries.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.docNo.localeCompare(b.docNo));
  return { from: f.from, to: f.to, days: [...byDate.values()], totals: await ledgerTotals(db, f), truncated };
}

/** 要导出的笔数：与逐笔同一口径（同样的日期、部门、经办人筛选），导出前先数，超过上限整份拒绝 */
export async function ledgerCount(db: Db, f: LedgerFilter): Promise<number> {
  const [n] = await db<{ count: number }[]>`
    SELECT (SELECT count(*) FROM petty_advances a WHERE a.status = 'active' AND a.advance_date BETWEEN ${f.from} AND ${f.to} ${byAdvance(db, f)})
         + (SELECT count(*) FROM petty_settlements s JOIN petty_advances a ON a.id = s.advance_id
            WHERE s.status = 'active' AND s.settle_date BETWEEN ${f.from} AND ${f.to} ${byAdvance(db, f)})
         + (SELECT count(*) FROM expense_claim_lines l JOIN expense_claims c ON c.id = l.claim_id
            WHERE c.status = 'confirmed' AND c.expense_date BETWEEN ${f.from} AND ${f.to} ${byClaim(db, f)}) AS count`;
  return Number(n!.count);
}

async function ledgerCsv(db: Db, f: LedgerFilter) {
  const count = await ledgerCount(db, f);
  if (count > EXPORT_LIMIT) {
    throw unprocessable('EXPORT_TOO_LARGE', `这段时间有 ${count} 笔，一次最多导出 ${EXPORT_LIMIT} 笔，请缩短日期范围分几次导出`);
  }
  const entries = (await ledgerRows(db, f, null)).map(toEntry).reverse();
  const rows: (string | number)[][] = [['日期', '类型', '单号', '部门', '经办人', '内容', '费用科目', '购买数量', '到货数量', '单位', '钱从哪来', '打款单号', '采购单号', '金额（元）']];
  for (const e of entries) {
    rows.push([
      e.date,
      LEDGER_KIND_LABELS[e.kind],
      e.docNo,
      e.department.name,
      e.handler.name,
      e.description,
      e.category ? EXPENSE_CATEGORY_LABELS[e.category] : '',
      e.qty ? formatQty(e.qty.boughtMilli) : '',
      e.qty ? formatQty(e.qty.receivedMilli) : '',
      e.qty?.unit ?? '',
      e.paySource ? PAY_SOURCE_LABELS[e.paySource] : e.kind === 'expense' ? '' : '备用金',
      e.advanceNo ?? '',
      e.poNo ?? '',
      formatAmount(e.amountCents).replace(/,/g, ''),
    ]);
  }
  const t = await ledgerTotals(db, f);
  rows.push([]);
  rows.push(['合计', '打款', '', '', '', '', '', '', '', '', '', '', '', formatAmount(t.advanceCents).replace(/,/g, '')]);
  rows.push(['合计', '支出（备用金）', '', '', '', '', '', '', '', '', '', '', '', formatAmount(t.pettySpentCents).replace(/,/g, '')]);
  rows.push(['合计', '支出（公司直付）', '', '', '', '', '', '', '', '', '', '', '', formatAmount(t.companySpentCents).replace(/,/g, '')]);
  rows.push(['合计', '退回', '', '', '', '', '', '', '', '', '', '', '', formatAmount(t.returnedCents).replace(/,/g, '')]);
  rows.push(['合计', '补付', '', '', '', '', '', '', '', '', '', '', '', formatAmount(t.toppedUpCents).replace(/,/g, '')]);
  return toCsv(rows);
}

// ───────────────────────── 下单物料 ─────────────────────────

interface OrderedFilter {
  /** 下单日期范围；不给就不限（账目自检第 9 条：没到齐的采购单不管多早下的都要列出来） */
  from?: string;
  to?: string;
  supplierId?: number;
  state?: 'open' | 'overdue' | 'received' | 'all';
}

async function orderedRows(db: Db, f: OrderedFilter) {
  // 只要未到、超期的：已结束的采购单只会是「已到齐」或「已结束」，直接不读
  const approvedOnly = f.state === 'open' || f.state === 'overdue';
  return db<(Omit<OrderedLine, 'state' | 'dueDate' | 'overdue'> & { poStatus: string })[]>`
    SELECT po.id AS po_id, po.doc_no, po.order_date, po.expected_date, po.status AS po_status, s.name AS supplier_name,
           pl.id AS line_id, m.code AS material_code, m.name AS material_name, pl.spec, pl.purchase_qty_milli, pl.purchase_unit,
           pl.base_qty_milli, pl.inventory_unit, pl.price_cents, pl.amount_cents,
           coalesce((SELECT sum(l.qty_milli) FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
                     WHERE l.po_line_id = pl.id AND d.doc_type = 'receipt' AND d.status = 'confirmed'), 0)::bigint AS received_milli,
           coalesce((SELECT json_agg(json_build_object('id', i.image_id, 'url', '/api/erp/images/' || i.image_id) ORDER BY i.sort_no)
                     FROM purchase_order_line_images i WHERE i.po_line_id = pl.id), '[]'::json) AS images,
           coalesce((SELECT array_agg(DISTINCT d.name) FROM purchase_order_line_requests x
                     JOIN purchase_request_lines rl ON rl.id = x.request_line_id JOIN purchase_requests r ON r.id = rl.request_id
                     JOIN departments d ON d.id = r.department_id WHERE x.po_line_id = pl.id), '{}') AS departments
    FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id
    JOIN suppliers s ON s.id = po.supplier_id JOIN materials m ON m.id = pl.material_id
    WHERE po.status IN ('approved', 'closed')
      ${f.from ? db`AND po.order_date >= ${f.from}` : db``}
      ${f.to ? db`AND po.order_date <= ${f.to}` : db``}
      ${f.supplierId ? db`AND po.supplier_id = ${f.supplierId}` : db``}
      ${approvedOnly ? db`AND po.status = 'approved'` : db``}
    ORDER BY po.order_date DESC, po.id DESC, pl.line_no`;
}

function orderedState(r: { poStatus: string; receivedMilli: number; baseQtyMilli: number }): OrderedState {
  const received = Number(r.receivedMilli);
  if (received >= Number(r.baseQtyMilli)) return 'received';
  if (r.poStatus === 'closed') return 'closed';
  return received > 0 ? 'partial' : 'open';
}

export async function orderedLines(db: Db, timezone: string, f: OrderedFilter, limit: number | null = 2000): Promise<OrderedLines> {
  const rules = await loadExpenseRules(db);
  const today = todayIn(timezone);
  const all = (await orderedRows(db, f)).map(({ poStatus, ...r }): OrderedLine => {
    const state = orderedState({ poStatus, receivedMilli: r.receivedMilli, baseQtyMilli: r.baseQtyMilli });
    const dueDate = r.expectedDate ?? addDays(r.orderDate, rules.arrivalOverdueDays);
    return {
      ...r,
      poId: Number(r.poId),
      lineId: Number(r.lineId),
      purchaseQtyMilli: Number(r.purchaseQtyMilli),
      baseQtyMilli: Number(r.baseQtyMilli),
      receivedMilli: Number(r.receivedMilli),
      priceCents: Number(r.priceCents),
      amountCents: Number(r.amountCents),
      departments: r.departments ?? [],
      state,
      dueDate,
      overdue: (state === 'open' || state === 'partial') && dueDate < today,
    };
  });
  const wanted = all.filter((l) =>
    f.state === 'open' ? l.state === 'open' || l.state === 'partial' : f.state === 'overdue' ? l.overdue : f.state === 'received' ? l.state === 'received' : true,
  );
  return { lines: limit ? wanted.slice(0, limit) : wanted, truncated: limit ? wanted.length > limit : false };
}

const ORDERED_HEADERS = ['下单日期', '采购单号', '供应商', '物料编码', '物料', '规格', '采购数量', '采购单位', '库存数量', '已到', '未到', '库存单位', '单价（元）', '金额（元）', '应到日期', '状态', '需求部门'];
function orderedCells(l: OrderedLine): (string | number)[] {
  return [
    l.orderDate,
    l.docNo,
    l.supplierName,
    l.materialCode,
    l.materialName,
    l.spec,
    Number(formatQty(l.purchaseQtyMilli).replace(/,/g, '')),
    l.purchaseUnit,
    Number(formatQty(l.baseQtyMilli).replace(/,/g, '')),
    Number(formatQty(l.receivedMilli).replace(/,/g, '')),
    Number(formatQty(Math.max(0, l.baseQtyMilli - l.receivedMilli)).replace(/,/g, '')),
    l.inventoryUnit,
    l.priceCents / 100,
    l.amountCents / 100,
    l.dueDate,
    l.overdue ? `${ORDERED_STATE_LABELS[l.state]}（超期）` : ORDERED_STATE_LABELS[l.state],
    l.departments.join('、'),
  ];
}

async function orderedForExport(db: Db, timezone: string, f: OrderedFilter) {
  const { lines } = await orderedLines(db, timezone, f, null);
  if (lines.length > ORDERED_EXPORT_ROWS) {
    throw unprocessable('EXPORT_TOO_LARGE', `这段时间有 ${lines.length} 行，一次最多导出 ${ORDERED_EXPORT_ROWS} 行，请缩短日期范围分几次导出`);
  }
  return lines;
}

/**
 * 下单物料导出 Excel：每行嵌入第一张图片；总量超过上限后，后面的行写明没嵌入。
 * 先只读图片的格式与大小排好哪些行能嵌入，再只取这些图片的内容（读进内存的不超过上限，v0.7.9 审查修正）。
 */
export async function orderedXlsx(db: Db, timezone: string, f: OrderedFilter, imageBudget = ORDERED_IMAGE_BUDGET) {
  const lines = await orderedForExport(db, timezone, f);
  const firstIds = [...new Set(lines.map((l) => l.images[0]?.id).filter((x): x is number => !!x))];
  const info = new Map<number, { mime: string; size: number }>();
  if (firstIds.length) {
    for (const r of await db<{ id: number; mime: string; sizeBytes: number }[]>`SELECT id, mime, size_bytes FROM erp_images WHERE id IN ${db(firstIds)}`) {
      info.set(Number(r.id), { mime: r.mime, size: Number(r.sizeBytes) });
    }
  }
  let budget = imageBudget;
  const plan = lines.map((l) => {
    const first: ImageRef | undefined = l.images[0];
    let note = l.images.length === 0 ? '无图片' : l.images.length > 1 ? `共 ${l.images.length} 张，嵌入第 1 张` : '';
    let embed: { id: number; ext: XlsxImage['ext'] } | null = null;
    const meta = first ? info.get(first.id) : undefined;
    if (first && meta) {
      const ext = meta.mime === 'image/png' ? 'png' : meta.mime === 'image/jpeg' ? 'jpeg' : null;
      if (!ext) note = `共 ${l.images.length} 张（WebP 格式没有嵌入，请在系统里看）`;
      else if (meta.size > budget) note = `共 ${l.images.length} 张（图片太多没有嵌入，请缩短日期范围）`;
      else {
        budget -= meta.size;
        embed = { id: first.id, ext };
      }
    }
    return { note, embed };
  });
  const wanted = [...new Set(plan.flatMap((p) => (p.embed ? [p.embed.id] : [])))];
  const blobs = new Map<number, Buffer>();
  if (wanted.length) {
    for (const r of await db<{ id: number; data: Buffer }[]>`SELECT id, data FROM erp_images WHERE id IN ${db(wanted)}`) blobs.set(Number(r.id), r.data);
  }
  const images: { row: number; col: number; image: XlsxImage }[] = [];
  plan.forEach(({ embed }, i) => {
    const data = embed ? blobs.get(embed.id) : undefined;
    if (embed && data) images.push({ row: i, col: 0, image: { data, ext: embed.ext } });
  });
  const rows = lines.map((l, i) => [null, ...orderedCells(l), plan[i]!.note]);
  return buildXlsx({
    name: '下单物料',
    columns: [
      { header: '图片', width: 14 },
      { header: '下单日期', width: 11 },
      { header: '采购单号', width: 16 },
      { header: '供应商', width: 16 },
      { header: '物料编码', width: 10 },
      { header: '物料', width: 22 },
      { header: '规格', width: 22 },
      { header: '采购数量', width: 9 },
      { header: '采购单位', width: 8 },
      { header: '库存数量', width: 9 },
      { header: '已到', width: 8 },
      { header: '未到', width: 8 },
      { header: '库存单位', width: 8 },
      { header: '单价（元）', width: 10 },
      { header: '金额（元）', width: 11 },
      { header: '应到日期', width: 11 },
      { header: '状态', width: 12 },
      { header: '需求部门', width: 14 },
      { header: '图片说明', width: 22 },
    ],
    rows,
    images,
    imageRowHeight: 64,
  });
}

async function orderedCsv(db: Db, timezone: string, f: OrderedFilter) {
  const lines = await orderedForExport(db, timezone, f);
  return toCsv([[...ORDERED_HEADERS, '图片张数'], ...lines.map((l) => [...orderedCells(l), l.images.length])]);
}

// ───────────────────────── 12 条账目自检 ─────────────────────────

const ACTIVE_CLAIM = ['submitted', 'returned', 'confirmed'] as const;

export async function ledgerAudit(db: Db, timezone: string): Promise<LedgerAudit> {
  const rules = await loadExpenseRules(db);
  const today = todayIn(timezone);
  const out: AuditRule[] = [];
  const push = (no: number, title: string, kind: AuditRule['kind'], how: string, items: AuditItem[], count = items.length) =>
    out.push({ no, title, kind, how, ok: count === 0, count, items: items.slice(0, AUDIT_ITEMS) });
  const claimLink = (id: number) => ({ kind: 'claim' as const, id: Number(id) });

  // 1 支出要素齐全
  const r1 = await db<{ id: number; docNo: string; expenseDate: string }[]>`
    SELECT c.id, c.doc_no, c.expense_date FROM expense_claims c
    WHERE c.status IN ${db(ACTIVE_CLAIM)}
      AND (c.amount_cents <= 0 OR EXISTS (SELECT 1 FROM expense_claim_lines l WHERE l.claim_id = c.id
                                          AND (btrim(l.name) = '' OR l.amount_cents <= 0)))
    ORDER BY c.expense_date DESC LIMIT 500`;
  push(1, '支出必须有日期、金额、类别、部门、经办人', 'block', '有效报销单（待确认、退回、已确认）的日期、部门、经办人、每一行的物品、费用科目与金额',
    r1.map((c) => ({ text: `${c.docNo} 缺少金额或明细`, date: c.expenseDate, link: claimLink(c.id) })));

  // 2 用备用金付、但没有采购单的报销
  const r2 = await db<{ id: number; docNo: string; expenseDate: string; advanceNo: string; amountCents: number; summary: string }[]>`
    SELECT c.id, c.doc_no, c.expense_date, a.doc_no AS advance_no, c.amount_cents,
           coalesce((SELECT string_agg(l.name, '、' ORDER BY l.line_no) FROM expense_claim_lines l WHERE l.claim_id = c.id AND l.line_no <= 3), '') AS summary
    FROM expense_claims c JOIN petty_advances a ON a.id = c.advance_id
    WHERE c.pay_source = 'petty' AND c.status IN ${db(ACTIVE_CLAIM)} AND c.purchase_order_id IS NULL
    ORDER BY c.expense_date DESC LIMIT 500`;
  push(2, '一笔打款必须能分摊到具体采购单', 'warn', '用备用金付、但没有对应采购单的报销（按次报销），请补采购单或在报销里说明（待确认）',
    r2.map((c) => ({ text: `${c.docNo}（打款 ${c.advanceNo}）${c.summary} ¥${formatAmount(Number(c.amountCents))}`, date: c.expenseDate, link: claimLink(c.id) })));

  // 3、4 平账：未平的付款日；超期未退
  const advances = (await advanceRows(db, {})).map((r) => toAdvanceSummary(r, today, rules.overdueDays)).filter((a) => a.state !== 'settled');
  const byDay = new Map<string, { date: string; dept: string; outstanding: number; advanceId: number; n: number }>();
  for (const a of advances) {
    const key = `${a.advanceDate}|${a.department.id}`;
    const d = byDay.get(key) ?? { date: a.advanceDate, dept: a.department.name, outstanding: 0, advanceId: a.id, n: 0 };
    d.outstanding += a.outstandingCents;
    d.n += 1;
    byDay.set(key, d);
  }
  const unsettledDays = [...byDay.values()].sort((x, y) => (x.date < y.date ? 1 : -1));
  push(3, '每日打款减支出必须等于应退回，不平即报警', 'warn', '每个付款日、每个部门：打款 − 已确认支出 − 实际退回 ≠ 0（钱还在经办人手里，或待补付）',
    unsettledDays.map((d) => ({
      text: `${d.date} ${d.dept}：${d.outstanding > 0 ? `未退回 ¥${formatAmount(d.outstanding)}` : `待补付 ¥${formatAmount(-d.outstanding)}`}（${d.n} 笔打款）`,
      date: d.date,
      link: { kind: 'advance' as const, id: d.advanceId },
    })));
  const overdue = advances.filter((a) => a.state === 'overdue');
  push(4, `应退回减实际退回为未退回，超 ${rules.overdueDays} 天预警`, 'warn', `打款日起超过 ${rules.overdueDays} 天（费用报销规则里改）还没平的打款`,
    overdue.map((a) => ({ text: `${a.docNo} ${a.department.name} · ${a.handler.name}：未退回 ¥${formatAmount(a.outstandingCents)}，已 ${a.ageDays} 天`, date: a.advanceDate, link: { kind: 'advance' as const, id: a.id } })));

  // 5 发票类型与税点匹配字典
  const claims5 = await db<{ id: number; docNo: string; expenseDate: string; invoiceType: string; invoiceLabel: string; taxRateBp: number; invoiceNo: string }[]>`
    SELECT id, doc_no, expense_date, invoice_type, invoice_label, tax_rate_bp, invoice_no FROM expense_claims
    WHERE status IN ${db(ACTIVE_CLAIM)} ORDER BY expense_date DESC`;
  const types = new Map(rules.invoiceTypes.map((t) => [t.key, t]));
  const bad5 = claims5.filter((c) => !types.get(c.invoiceType)?.taxRatesBp.includes(Number(c.taxRateBp)));
  push(5, '发票类型与税点必须匹配字典', 'block', '有效报销单的发票类型与税点在当前的费用报销规则里（规则改过之后的旧单会列出来）',
    bad5.map((c) => ({ text: `${c.docNo}：${c.invoiceLabel} · 税点 ${Number(c.taxRateBp) / 100}% 不在当前规则里`, date: c.expenseDate, link: claimLink(c.id) })));

  // 6 费用科目只有三种
  const r6 = await db<{ id: number; docNo: string; expenseDate: string; category: string }[]>`
    SELECT c.id, c.doc_no, c.expense_date, l.category FROM expense_claim_lines l JOIN expense_claims c ON c.id = l.claim_id
    WHERE c.status IN ${db(ACTIVE_CLAIM)} AND l.category NOT IN ('office', 'fixed_asset', 'low_value') LIMIT 500`;
  push(6, '费用科目只允许办公费、固定资产、低值易耗', 'block', '报销明细的费用科目（数据库约束，只能是这三种）',
    r6.map((c) => ({ text: `${c.docNo}：${c.category}`, date: c.expenseDate, link: claimLink(c.id) })));

  // 7 部门走字典：引用的部门都在档案里；部门名里不能像是几个部门拼在一起
  const r7 = await db<{ id: number; name: string }[]>`SELECT id, name FROM departments WHERE name ~ '[、/／,，+＋&＆]' ORDER BY id`;
  push(7, '部门走字典，禁止多部门拼接', 'block', '报销、打款、需求单的部门都引用部门档案（数据库外键）；部门档案里名称像是几个部门拼在一起的列出来',
    r7.map((d) => ({ text: `部门档案「${d.name}」像是几个部门拼在一起，请拆开`, date: null, link: null })));

  // 8 数量不一致写原因
  const r8 = await db<{ id: number; docNo: string; expenseDate: string; name: string }[]>`
    SELECT c.id, c.doc_no, c.expense_date, l.name FROM expense_claim_lines l JOIN expense_claims c ON c.id = l.claim_id
    WHERE c.status IN ${db(ACTIVE_CLAIM)} AND l.bought_milli <> l.received_milli AND btrim(l.diff_reason) = '' LIMIT 500`;
  push(8, '到货数量不等于购买数量时必须填差异原因', 'block', '报销明细：购买数量与到货数量不一致的，都写了原因',
    r8.map((c) => ({ text: `${c.docNo}「${c.name}」没写差异原因`, date: c.expenseDate, link: claimLink(c.id) })));

  // 9 已下单未到货超期：所有没到齐的已确认采购单，不限下单日期（不能因为单子下得早就从预警里消失，v0.7.9 审查修正）
  const late = (await orderedLines(db, timezone, { state: 'overdue' }, null)).lines;
  push(9, `已下单未到货超约定天数预警`, 'warn', `已确认的采购单行没到齐：有预计到货日的过了预计日，没有的过了下单后 ${rules.arrivalOverdueDays} 天（费用报销规则里改）`,
    late.map((l) => ({
      text: `${l.docNo} ${l.materialName}：应到 ${l.dueDate}，已到 ${formatQty(l.receivedMilli)} / ${formatQty(l.baseQtyMilli)} ${l.inventoryUnit}`,
      date: l.orderDate,
      link: { kind: 'po' as const, id: l.poId },
    })));

  // 10 同一物品同一天重复下单
  const r10 = await db<{ materialName: string; orderDate: string; docs: string[]; poId: number }[]>`
    SELECT m.name AS material_name, po.order_date, array_agg(DISTINCT po.doc_no) AS docs, min(po.id) AS po_id
    FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id JOIN materials m ON m.id = pl.material_id
    WHERE po.status <> 'cancelled' AND po.backfill = false
    GROUP BY pl.material_id, m.name, po.order_date HAVING count(DISTINCT po.id) > 1
    ORDER BY po.order_date DESC LIMIT 500`;
  push(10, '同一物品同一天重复下单提示', 'warn', '同一物料、同一下单日出现在两张以上有效的采购单里（撤回的不算）',
    r10.map((r) => ({ text: `${r.orderDate}「${r.materialName}」：${r.docs.join('、')}`, date: r.orderDate, link: { kind: 'po' as const, id: Number(r.poId) } })));

  // 11 标有发票的都有发票号
  const bad11 = claims5.filter((c) => types.get(c.invoiceType)?.needsNumber && !c.invoiceNo.trim());
  push(11, '标注有发票但实际无票直接拦截', 'block', '发票类型要求发票号的报销单都填了发票号（登记时拦截）',
    bad11.map((c) => ({ text: `${c.docNo}：${c.invoiceLabel} 没有发票号`, date: c.expenseDate, link: claimLink(c.id) })));

  // 12 新产品的图片与链接
  const r12 = await db<{ id: number; docNo: string; createdDate: string; name: string }[]>`
    SELECT r.id, r.doc_no, to_char(r.created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS created_date, l.name
    FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id
    WHERE l.material_id IS NULL AND (l.link = '' OR NOT EXISTS (SELECT 1 FROM purchase_request_line_images i WHERE i.request_line_id = l.id))
    LIMIT 500`;
  push(12, '图片与链接为必填', 'block', '需求单里的新产品（不在物料档案里的）都有参考链接与图片（提交时拦截）',
    r12.map((r) => ({ text: `${r.docNo}「${r.name}」缺链接或图片`, date: r.createdDate, link: { kind: 'request' as const, id: Number(r.id) } })));

  void AUDIT_KIND_LABELS;
  return { today, rules: out };
}

// ───────────────────────── 路由 ─────────────────────────

const optId = z.coerce.number().int().positive().optional();
const LedgerQuery = z.object({ from: dateSchema('开始日期'), to: dateSchema('结束日期'), departmentId: optId, handlerId: optId });
const OrderedQuery = z.object({
  from: dateSchema('开始日期'),
  to: dateSchema('结束日期'),
  supplierId: optId,
  state: z.enum(['open', 'overdue', 'received', 'all']).default('all'),
});

export function registerPurchaseLedgerRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;

  app.get('/api/erp/ledger', { preHandler: guard('expense.read') }, async (req) => {
    const f = parse(LedgerQuery, req.query);
    checkRange(f.from, f.to);
    return readSnapshot(sql, (tx) => buildLedger(tx, f));
  });
  app.get('/api/erp/ledger/export', { preHandler: guard('expense.export') }, async (req, reply) => {
    const f = parse(LedgerQuery, req.query);
    checkRange(f.from, f.to);
    const csv = await readSnapshot(sql, (tx) => ledgerCsv(tx, f));
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'purchase_ledger', detail: f, ip: req.ip });
    return csvReply(reply, `采购台账_${f.from}_${f.to}.csv`, csv);
  });
  app.get('/api/erp/audit', { preHandler: guard('expense.read') }, async () => readSnapshot(sql, (tx) => ledgerAudit(tx, config.timezone)));

  app.get('/api/purchase-orders/ordered-lines', { preHandler: guard('inventory.read') }, async (req) => {
    const f = parse(OrderedQuery, req.query);
    checkRange(f.from, f.to);
    return readSnapshot(sql, (tx) => orderedLines(tx, config.timezone, f));
  });
  app.get('/api/purchase-orders/ordered-lines/export.csv', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const f = parse(OrderedQuery, req.query);
    checkRange(f.from, f.to);
    const csv = await readSnapshot(sql, (tx) => orderedCsv(tx, config.timezone, f));
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'ordered_lines', detail: { ...f, format: 'csv' }, ip: req.ip });
    return csvReply(reply, `下单物料_${f.from}_${f.to}.csv`, csv);
  });
  app.get('/api/purchase-orders/ordered-lines/export.xlsx', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const f = parse(OrderedQuery, req.query);
    checkRange(f.from, f.to);
    const buf = await readSnapshot(sql, (tx) => orderedXlsx(tx, config.timezone, f));
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'ordered_lines', detail: { ...f, format: 'xlsx' }, ip: req.ip });
    reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`下单物料_${f.from}_${f.to}.xlsx`)}`);
    return reply.send(buf);
  });
}
