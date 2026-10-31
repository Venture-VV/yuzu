// 库存单据：期初、收货、领用、领用退回、直接耗用、报损、盘点、退供应商。
//
// 生命周期：草稿 → 提交 →（需要时）负责人确认 → 已生效；负责人可退回修改；生效后只能冲销。
// 只有「已生效」才写库存流水和应付流水；草稿、待确认、已退回都不影响库存或货款。
// 新建单据带操作编号（幂等键），重复提交只得到同一张单；提交、确认、退回、冲销按状态幂等。

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  COUNT_REASONS,
  INV_DOC_META,
  type CountReason,
  type InvDoc,
  type InvDocSummary,
  type InvDocType,
} from '@shared/inventory';
import type { SupplierSettlement } from '@shared/expenses';
import { can, type Permission } from '@shared/permissions';
import { fitsDecimals, formatQty, lineAmountCents, priceChangePercent, toBaseQty } from '@shared/quantity';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import {
  applyMove,
  assertEnoughStock,
  assertNotFuture,
  docDateSchema,
  loadInventorySettings,
  lockMaterials,
  logApproval,
  nextDocNo,
  poSettlement,
  priceBaseline,
  setTxTimeouts,
  todayIn,
} from './common';

// ───────────────────────── 输入 ─────────────────────────

const qty = (label: string) => z.number(`${label}必须是数字`).int(`${label}格式不正确`).min(0, `${label}不能为负数`).max(1_000_000_000_000, `${label}过大`);
const positiveQty = (label: string) => qty(label).positive(`${label}必须大于 0`);
const note = (max = 100) => z.string().trim().max(max, `备注最多 ${max} 字`).default('');
const id = z.number().int().positive();

const Entered = {
  enteredQtyMilli: z.number().int().positive().nullable().default(null),
  enteredUnit: z.string().trim().max(8).nullable().default(null),
};
const QtyLine = z.object({ materialId: id, qtyMilli: positiveQty('数量'), ...Entered, note: note() });
const OpeningLine = z.object({ materialId: id, qtyMilli: qty('期初数量'), note: note() });
const CountLine = z.object({
  materialId: id,
  countedMilli: qty('实盘数量'),
  /** 员工填实盘时页面上显示的账面数；与服务端记下的账面不一致说明期间有收发 */
  expectedBookMilli: z.number().int().nullable().default(null),
  note: note(),
});
const SourceLine = z.object({ sourceLineId: id, qtyMilli: positiveQty('数量'), note: note() });
const ReceiptLine = z.object({
  materialId: id,
  poLineId: id.nullable().default(null),
  deliveredMilli: positiveQty('送达数量'),
  acceptedMilli: qty('合格实收数量'),
  rejectReason: z.string().trim().max(100).default(''),
  /** 每采购单位价格（分）；关联采购单时以采购单价格为准 */
  priceCents: z.number().int().nonnegative().max(100_000_000).nullable().default(null),
  note: note(),
});

const lines = <T extends z.ZodType>(schema: T) => z.array(schema).min(1, '请至少添加一行').max(100, '单据最多 100 行');

const Header = {
  docDate: docDateSchema,
  note: note(200),
};

const DocBody = z.discriminatedUnion('docType', [
  z.object({ docType: z.literal('opening'), ...Header, lines: lines(OpeningLine) }),
  z.object({
    docType: z.literal('receipt'),
    ...Header,
    supplierId: id,
    purchaseOrderId: id.nullable().default(null),
    handler: z.string().trim().max(32).default(''),
    lines: lines(ReceiptLine),
  }),
  z.object({ docType: z.literal('issue'), ...Header, departmentId: id, handler: z.string().trim().min(1, '请填写领用人').max(32), lines: lines(QtyLine) }),
  z.object({ docType: z.literal('issue_return'), ...Header, sourceDocId: id, handler: z.string().trim().max(32).default(''), lines: lines(SourceLine) }),
  z.object({ docType: z.literal('direct_use'), ...Header, note: z.string().trim().min(2, '请填写耗用用途').max(200), lines: lines(QtyLine) }),
  z.object({ docType: z.literal('damage'), ...Header, note: z.string().trim().min(2, '请填写报损原因').max(200), lines: lines(QtyLine) }),
  z.object({ docType: z.literal('count'), ...Header, lines: lines(CountLine) }),
  z.object({ docType: z.literal('supplier_return'), ...Header, note: z.string().trim().min(2, '请填写退货原因').max(200), sourceDocId: id, lines: lines(SourceLine) }),
]);
export type DocBodyInput = z.input<typeof DocBody>;

const CreateInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  /** save = 存草稿；submit = 提交（不需要确认的单据直接生效） */
  action: z.enum(['save', 'submit']).default('submit'),
  /** 提交人本身有确认权限时，可一步「提交并确认」 */
  approveNow: z.boolean().default(false),
});
export type CreateDocInput = DocBodyInput & z.input<typeof CreateInput>;

const ReasonInput = z.object({ reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200) });
const ApproveInput = z.object({
  /** 盘点：每行差异的确认原因 */
  countReasons: z.record(z.string(), z.enum(COUNT_REASONS)).default({}),
});

// ───────────────────────── 权限 ─────────────────────────

const OPERATE_PERMISSION: Record<InvDocType, Permission> = {
  opening: 'inventory.operate',
  receipt: 'inventory.operate',
  issue: 'inventory.operate',
  issue_return: 'inventory.operate',
  direct_use: 'inventory.operate',
  damage: 'inventory.operate',
  count: 'inventory.operate',
  supplier_return: 'supplierReturn.create',
};

function assertCanOperate(actor: Actor, type: InvDocType) {
  if (!can(actor, OPERATE_PERMISSION[type])) throw forbidden(`当前账号没有「${INV_DOC_META[type].title}」的职责`);
}

// ───────────────────────── 读取 ─────────────────────────

interface DocRow {
  id: number;
  docType: InvDocType;
  status: InvDoc['status'];
  docDate: string;
  supplierId: number | null;
  purchaseOrderId: number | null;
  departmentId: number | null;
  sourceDocId: number | null;
  createdBy: number;
  submittedBy: number | null;
}

export async function getDoc(db: Db, docId: number): Promise<InvDoc> {
  const [d] = await db<(InvDoc & Record<string, unknown>)[]>`
    SELECT d.id, d.doc_no, d.doc_type, d.status, d.doc_date, d.handler, d.note, d.amount_cents, d.no_po, d.is_synthetic, d.created_by,
           d.created_at, d.submitted_at, d.confirmed_at, d.returned_reason, d.voided_at, d.void_reason,
           CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('id', s.id, 'name', s.name) END AS supplier,
           CASE WHEN po.id IS NULL THEN NULL ELSE json_build_object('id', po.id, 'docNo', po.doc_no) END AS purchase_order,
           CASE WHEN dep.id IS NULL THEN NULL ELSE json_build_object('id', dep.id, 'name', dep.name) END AS department,
           CASE WHEN src.id IS NULL THEN NULL ELSE json_build_object('id', src.id, 'docNo', src.doc_no, 'docType', src.doc_type, 'status', src.status) END AS source_doc,
           cb.display_name AS created_by_name, sb.display_name AS submitted_by_name,
           ob.display_name AS confirmed_by_name, vb.display_name AS voided_by_name
    FROM inv_docs d
    LEFT JOIN suppliers s ON s.id = d.supplier_id
    LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
    LEFT JOIN departments dep ON dep.id = d.department_id
    LEFT JOIN inv_docs src ON src.id = d.source_doc_id
    JOIN staff cb ON cb.id = d.created_by
    LEFT JOIN staff sb ON sb.id = d.submitted_by
    LEFT JOIN staff ob ON ob.id = d.confirmed_by
    LEFT JOIN staff vb ON vb.id = d.voided_by
    WHERE d.id = ${docId}`;
  if (!d) throw notFound('单据不存在');

  const lines = await db<InvDoc['lines']>`
    SELECT l.id, l.line_no, l.material_id, m.code AS material_code, m.name AS material_name, m.specification, m.decimals,
           l.qty_milli, l.inventory_unit, l.purchase_unit, l.factor_milli, l.entered_qty_milli, l.entered_unit,
           l.delivered_milli, l.rejected_milli, l.reject_reason, l.price_cents, l.amount_cents, l.po_line_id,
           l.book_milli, l.counted_milli, l.diff_reason, l.source_line_id, l.note, m.stock_milli,
           (${d.docType === 'count' && ['draft', 'submitted', 'returned'].includes(d.status)} AND l.book_move_id IS DISTINCT FROM m.last_move_id) AS stale,
           coalesce((SELECT sum(rl.qty_milli) FROM inv_doc_lines rl JOIN inv_docs rd ON rd.id = rl.doc_id
                     WHERE rl.source_line_id = l.id AND rd.status IN ('confirmed', 'submitted')), 0) AS returned_milli
    FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id
    WHERE l.doc_id = ${docId} ORDER BY l.line_no`;

  if (d.docType === 'receipt') {
    const [basis] = await db<{ priceBasis: string }[]>`SELECT price_basis FROM inv_docs WHERE id = ${docId}`;
    for (const l of lines) {
      if (l.priceCents === null || l.qtyMilli === 0) continue;
      const base = await priceBaseline(
        db,
        { materialId: l.materialId, purchaseUnit: l.purchaseUnit, factorMilli: l.factorMilli, priceBasis: basis!.priceBasis },
        { onOrBefore: d.docDate, beforeDoc: { date: d.docDate, id: docId } },
      );
      l.compare = { baseline: base, changePercent: base ? priceChangePercent(base.priceCents, l.priceCents) : null };
    }
  }

  const children = await db<InvDoc['children']>`
    SELECT id, doc_no, doc_type, status FROM inv_docs WHERE source_doc_id = ${docId} ORDER BY id`;
  const approvals = await db<InvDoc['approvals']>`
    SELECT a.id, a.action, s.display_name AS actor_name, a.reason, a.revision, a.created_at
    FROM approval_logs a JOIN staff s ON s.id = a.actor_id
    WHERE a.doc_kind = 'inv_doc' AND a.doc_id = ${docId} ORDER BY a.id`;

  const doc = { ...d, lines, children, approvals, voidable: { ok: false, reason: null } } as InvDoc;
  doc.voidable = await voidability(db, doc);
  return doc;
}

export async function listDocs(
  db: Db,
  f: { type?: InvDocType; status?: string; from?: string; to?: string; materialId?: number; q?: string; supplierId?: number; limit?: number },
): Promise<InvDocSummary[]> {
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return db<InvDocSummary[]>`
    SELECT d.id, d.doc_no, d.doc_type, d.status, d.doc_date, d.amount_cents, d.no_po, d.created_at,
           coalesce(s.name, dep.name) AS party_name, cb.display_name AS created_by_name,
           (SELECT count(*) FROM inv_doc_lines WHERE doc_id = d.id) AS line_count,
           coalesce((SELECT string_agg(m.name, '、' ORDER BY l.line_no) FROM (
              SELECT * FROM inv_doc_lines WHERE doc_id = d.id ORDER BY line_no LIMIT 3) l
              JOIN materials m ON m.id = l.material_id), '') AS summary
    FROM inv_docs d
    LEFT JOIN suppliers s ON s.id = d.supplier_id
    LEFT JOIN departments dep ON dep.id = d.department_id
    JOIN staff cb ON cb.id = d.created_by
    WHERE true
      ${f.type ? db`AND d.doc_type = ${f.type}` : db``}
      ${f.status ? db`AND d.status = ${f.status}` : db``}
      ${f.from ? db`AND d.doc_date >= ${f.from}` : db``}
      ${f.to ? db`AND d.doc_date <= ${f.to}` : db``}
      ${f.supplierId ? db`AND d.supplier_id = ${f.supplierId}` : db``}
      ${f.materialId ? db`AND EXISTS (SELECT 1 FROM inv_doc_lines WHERE doc_id = d.id AND material_id = ${f.materialId})` : db``}
      ${like ? db`AND (d.doc_no ILIKE ${like} OR s.name ILIKE ${like} OR dep.name ILIKE ${like} OR d.handler ILIKE ${like} OR d.note ILIKE ${like})` : db``}
    ORDER BY d.doc_date DESC, d.id DESC
    LIMIT ${f.limit ?? 200}`;
}

/** 冲销条件：有后续业务的原单不能冲销，需先处理后续单据 */
async function voidability(db: Db, doc: InvDoc): Promise<InvDoc['voidable']> {
  if (doc.status !== 'confirmed') return { ok: false, reason: '只有已生效的单据可以冲销' };
  if (doc.docType === 'count') return { ok: false, reason: '盘点调整不能冲销，如有错误请重新盘点' };
  const activeChildren = doc.children.filter((c) => c.status === 'confirmed' || c.status === 'submitted');
  if (activeChildren.length > 0) {
    return { ok: false, reason: `已有后续单据 ${activeChildren.map((c) => c.docNo).join('、')}，需先冲销或撤回后续单据` };
  }
  if (doc.docType === 'receipt') {
    const [paid] = await db<{ count: number }[]>`
      SELECT count(*) AS count FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
      WHERE pa.receipt_doc_id = ${doc.id} AND p.status IN ('confirmed', 'submitted')`;
    if (paid && paid.count > 0) return { ok: false, reason: '这张收货单已有付款核销，需先冲销付款' };
  }
  return { ok: true, reason: null };
}

// ───────────────────────── 准备：校验并生成行快照 ─────────────────────────

interface PreparedLine {
  materialId: number;
  qtyMilli: number;
  inventoryUnit: string;
  purchaseUnit: string;
  factorMilli: number;
  enteredQtyMilli: number | null;
  enteredUnit: string | null;
  deliveredMilli: number | null;
  rejectedMilli: number | null;
  rejectReason: string;
  priceCents: number | null;
  amountCents: number | null;
  poLineId: number | null;
  bookMilli: number | null;
  countedMilli: number | null;
  bookMoveId: number | null;
  sourceLineId: number | null;
  note: string;
}

interface Prepared {
  supplierId: number | null;
  purchaseOrderId: number | null;
  departmentId: number | null;
  sourceDocId: number | null;
  handler: string;
  amountCents: number;
  noPo: boolean;
  priceBasis: string;
  lines: PreparedLine[];
}

interface MaterialInfo {
  id: number;
  name: string;
  inventoryUnit: string;
  decimals: number;
  purchaseUnit: string;
  purchaseFactorMilli: number;
  tracked: boolean;
  active: boolean;
  stockMilli: number;
  lastMoveId: number | null;
}

async function loadMaterials(db: Db, ids: number[]): Promise<Map<number, MaterialInfo>> {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await db<MaterialInfo[]>`
        SELECT id, name, inventory_unit, decimals, purchase_unit, purchase_factor_milli, tracked, active, stock_milli, last_move_id
        FROM materials WHERE id IN ${db(unique)}`
    : [];
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const mid of unique) {
    const m = map.get(mid);
    if (!m) throw unprocessable('MATERIAL_NOT_FOUND', '有物料不存在，请刷新后重试');
    if (!m.tracked) throw unprocessable('MATERIAL_NOT_TRACKED', `「${m.name}」是候选物料，尚未纳入库存管理`);
    if (!m.active) throw unprocessable('MATERIAL_INACTIVE', `「${m.name}」已停用`);
  }
  return map;
}

function checkDecimals(m: MaterialInfo, milli: number, label: string) {
  if (!fitsDecimals(milli, m.decimals)) {
    throw badRequest(`「${m.name}」的${label}最多 ${m.decimals} 位小数（单位：${m.inventoryUnit}）`);
  }
}

function enteredFields(m: MaterialInfo, line: { qtyMilli: number; enteredQtyMilli: number | null; enteredUnit: string | null }) {
  if (!line.enteredUnit || line.enteredQtyMilli === null) return { enteredQtyMilli: null, enteredUnit: null };
  // 录入单位只能是库存单位或采购单位，且换算后必须与数量一致（「10 箱」与「10 瓶」不会混淆）
  if (line.enteredUnit === m.inventoryUnit && line.enteredQtyMilli === line.qtyMilli) {
    return { enteredQtyMilli: line.enteredQtyMilli, enteredUnit: line.enteredUnit };
  }
  if (line.enteredUnit === m.purchaseUnit && toBaseQty(line.enteredQtyMilli, m.purchaseFactorMilli) === line.qtyMilli) {
    return { enteredQtyMilli: line.enteredQtyMilli, enteredUnit: line.enteredUnit };
  }
  throw badRequest(`「${m.name}」录入的数量与单位换算不一致，请刷新后重试`);
}

function baseLine(m: MaterialInfo): Omit<PreparedLine, 'qtyMilli' | 'note'> {
  return {
    materialId: m.id,
    inventoryUnit: m.inventoryUnit,
    purchaseUnit: m.purchaseUnit,
    factorMilli: m.purchaseFactorMilli,
    enteredQtyMilli: null,
    enteredUnit: null,
    deliveredMilli: null,
    rejectedMilli: null,
    rejectReason: '',
    priceCents: null,
    amountCents: null,
    poLineId: null,
    bookMilli: null,
    countedMilli: null,
    bookMoveId: null,
    sourceLineId: null,
  };
}

function assertUniqueMaterials(lines: { materialId: number }[], what: string) {
  const seen = new Set<number>();
  for (const l of lines) {
    if (seen.has(l.materialId)) throw badRequest(`同一物料在${what}中只能出现一次`);
    seen.add(l.materialId);
  }
}

/** 已退回 / 已退货数量：只统计已生效与待确认的单据，排除正在编辑的这张 */
async function returnedBySourceLine(db: Db, sourceLineIds: number[], excludeDocId: number | null) {
  if (sourceLineIds.length === 0) return new Map<number, number>();
  const rows = await db<{ sourceLineId: number; qty: number }[]>`
    SELECT l.source_line_id, sum(l.qty_milli) AS qty FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
    WHERE l.source_line_id IN ${db(sourceLineIds)} AND d.status IN ('confirmed', 'submitted')
      ${excludeDocId ? db`AND d.id <> ${excludeDocId}` : db``}
    GROUP BY l.source_line_id`;
  return new Map(rows.map((r) => [r.sourceLineId, r.qty]));
}

/** 采购单各行已合格实收数量（只算已生效的收货单） */
export async function receivedByPoLine(db: Db, poId: number, excludeDocId: number | null = null) {
  const rows = await db<{ poLineId: number; qty: number }[]>`
    SELECT l.po_line_id, sum(l.qty_milli) AS qty FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
    WHERE d.purchase_order_id = ${poId} AND d.doc_type = 'receipt' AND d.status = 'confirmed' AND l.po_line_id IS NOT NULL
      ${excludeDocId ? db`AND d.id <> ${excludeDocId}` : db``}
    GROUP BY l.po_line_id`;
  return new Map(rows.map((r) => [r.poLineId, r.qty]));
}

async function prepare(db: Db, deps: Deps, body: z.infer<typeof DocBody>, existing: { id: number; lines: { materialId: number; bookMilli: number | null; bookMoveId: number | null }[] } | null): Promise<Prepared> {
  assertNotFuture(body.docDate, deps.config.timezone);
  const empty: Prepared = { supplierId: null, purchaseOrderId: null, departmentId: null, sourceDocId: null, handler: '', amountCents: 0, noPo: false, priceBasis: '', lines: [] };

  switch (body.docType) {
    case 'opening': {
      assertUniqueMaterials(body.lines, '期初单');
      const mats = await loadMaterials(db, body.lines.map((l) => l.materialId));
      return {
        ...empty,
        lines: body.lines.map((l) => {
          const m = mats.get(l.materialId)!;
          checkDecimals(m, l.qtyMilli, '期初数量');
          return { ...baseLine(m), qtyMilli: l.qtyMilli, note: l.note };
        }),
      };
    }

    case 'issue':
    case 'direct_use':
    case 'damage': {
      if (body.docType === 'issue') {
        const [dep] = await db<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${body.departmentId}`;
        if (!dep || !dep.active) throw unprocessable('DEPARTMENT_INACTIVE', '领用部门不存在或已停用');
      }
      const mats = await loadMaterials(db, body.lines.map((l) => l.materialId));
      return {
        ...empty,
        departmentId: body.docType === 'issue' ? body.departmentId : null,
        handler: body.docType === 'issue' ? body.handler : '',
        lines: body.lines.map((l) => {
          const m = mats.get(l.materialId)!;
          checkDecimals(m, l.qtyMilli, '数量');
          return { ...baseLine(m), qtyMilli: l.qtyMilli, ...enteredFields(m, l), note: l.note };
        }),
      };
    }

    case 'count': {
      assertUniqueMaterials(body.lines, '盘点单');
      const mats = await loadMaterials(db, body.lines.map((l) => l.materialId));
      // 账面数在开始盘点时记下；修改草稿时已有物料沿用原快照，新增物料取当前账面
      const previous = new Map(existing?.lines.map((l) => [l.materialId, l]) ?? []);
      const changed = body.lines.filter((l) => {
        const prev = previous.get(l.materialId);
        const book = prev?.bookMilli ?? mats.get(l.materialId)!.stockMilli;
        return l.expectedBookMilli !== null && l.expectedBookMilli !== book;
      });
      if (changed.length > 0) {
        throw conflict('COUNT_STALE', `账面数已变化：${changed.map((l) => mats.get(l.materialId)!.name).join('、')}，请按最新账面核对实盘数后再提交`, {
          materialIds: changed.map((l) => l.materialId),
        });
      }
      return {
        ...empty,
        lines: body.lines.map((l) => {
          const m = mats.get(l.materialId)!;
          checkDecimals(m, l.countedMilli, '实盘数量');
          const prev = previous.get(m.id);
          const bookMilli = prev?.bookMilli ?? m.stockMilli;
          const bookMoveId = prev ? prev.bookMoveId : m.lastMoveId;
          return {
            ...baseLine(m),
            qtyMilli: l.countedMilli - bookMilli,
            countedMilli: l.countedMilli,
            bookMilli,
            bookMoveId,
            note: l.note,
          };
        }),
      };
    }

    case 'issue_return':
    case 'supplier_return': {
      const sourceType = body.docType === 'issue_return' ? 'issue' : 'receipt';
      const [src] = await db<{ id: number; docType: string; status: string; supplierId: number | null; departmentId: number | null }[]>`
        SELECT id, doc_type, status, supplier_id, department_id FROM inv_docs WHERE id = ${body.sourceDocId}`;
      if (!src || src.docType !== sourceType) throw unprocessable('SOURCE_INVALID', body.docType === 'issue_return' ? '请选择原领用单' : '请选择原收货单');
      if (src.status !== 'confirmed') throw unprocessable('SOURCE_NOT_CONFIRMED', '原单未生效或已冲销，不能退回');
      const srcLines = await db<{ id: number; materialId: number; qtyMilli: number; priceCents: number | null; factorMilli: number; inventoryUnit: string; purchaseUnit: string }[]>`
        SELECT id, material_id, qty_milli, price_cents, factor_milli, inventory_unit, purchase_unit FROM inv_doc_lines WHERE doc_id = ${src.id}`;
      const byId = new Map(srcLines.map((l) => [l.id, l]));
      const mats = await loadMaterials(db, srcLines.filter((l) => body.lines.some((b) => b.sourceLineId === l.id)).map((l) => l.materialId));
      const already = await returnedBySourceLine(db, body.lines.map((l) => l.sourceLineId), existing?.id ?? null);
      const seen = new Set<number>();
      let amount = 0;
      const prepared = body.lines.map((l) => {
        const s = byId.get(l.sourceLineId);
        if (!s) throw unprocessable('SOURCE_LINE_INVALID', '退回明细与原单不符，请刷新后重试');
        if (seen.has(s.id)) throw badRequest('同一原单行只能出现一次');
        seen.add(s.id);
        const m = mats.get(s.materialId)!;
        checkDecimals(m, l.qtyMilli, '数量');
        const remaining = s.qtyMilli - (already.get(s.id) ?? 0);
        if (l.qtyMilli > remaining) {
          throw unprocessable(
            'RETURN_EXCEEDS_SOURCE',
            `「${m.name}」最多还能${body.docType === 'issue_return' ? '退回' : '退货'} ${formatQty(Math.max(0, remaining))} ${s.inventoryUnit}`,
            { materialId: m.id, remainingMilli: remaining },
          );
        }
        const line: PreparedLine = {
          ...baseLine(m),
          inventoryUnit: s.inventoryUnit,
          purchaseUnit: s.purchaseUnit,
          factorMilli: s.factorMilli,
          qtyMilli: l.qtyMilli,
          sourceLineId: s.id,
          note: l.note,
        };
        if (body.docType === 'supplier_return') {
          // 退货扣款按原收货价格与换算计算
          line.priceCents = s.priceCents ?? 0;
          line.amountCents = lineAmountCents(l.qtyMilli, line.priceCents, s.factorMilli);
          amount += line.amountCents;
        }
        return line;
      });
      return {
        ...empty,
        sourceDocId: src.id,
        supplierId: body.docType === 'supplier_return' ? src.supplierId : null,
        departmentId: body.docType === 'issue_return' ? src.departmentId : null,
        handler: body.docType === 'issue_return' ? body.handler : '',
        amountCents: amount,
        lines: prepared,
      };
    }

    case 'receipt': {
      const [sup] = await db<{ active: boolean }[]>`SELECT active FROM suppliers WHERE id = ${body.supplierId}`;
      if (!sup || !sup.active) throw unprocessable('SUPPLIER_INACTIVE', '供应商不存在或已停用');
      const mats = await loadMaterials(db, body.lines.map((l) => l.materialId));
      let poLines = new Map<number, { id: number; materialId: number; baseQtyMilli: number; priceCents: number; factorMilli: number; purchaseUnit: string; inventoryUnit: string }>();
      let received = new Map<number, number>();
      let priceBasis = (await loadInventorySettings(db)).priceBasis;
      if (body.purchaseOrderId) {
        const [po] = await db<{ supplierId: number; status: string; docNo: string; priceBasis: string }[]>`
          SELECT supplier_id, status, doc_no, price_basis FROM purchase_orders WHERE id = ${body.purchaseOrderId}`;
        if (!po) throw unprocessable('PO_NOT_FOUND', '采购单不存在');
        if (po.status !== 'approved') throw unprocessable('PO_NOT_APPROVED', `采购单 ${po.docNo} 尚未确认或已关闭，不能收货`);
        if (po.supplierId !== body.supplierId) throw unprocessable('PO_SUPPLIER_MISMATCH', '收货供应商与采购单不一致');
        priceBasis = po.priceBasis;
        const rows = await db<{ id: number; materialId: number; baseQtyMilli: number; priceCents: number; factorMilli: number; purchaseUnit: string; inventoryUnit: string }[]>`
          SELECT id, material_id, base_qty_milli, price_cents, factor_milli, purchase_unit, inventory_unit
          FROM purchase_order_lines WHERE po_id = ${body.purchaseOrderId}`;
        poLines = new Map(rows.map((r) => [r.id, r]));
        received = await receivedByPoLine(db, body.purchaseOrderId, existing?.id ?? null);
      } else {
        const settings = await loadInventorySettings(db);
        if (!settings.allowDirectReceipt) throw unprocessable('DIRECT_RECEIPT_DISABLED', '当前规则不允许无采购单直接收货');
      }
      let amount = 0;
      const prepared = body.lines.map((l) => {
        const m = mats.get(l.materialId)!;
        checkDecimals(m, l.deliveredMilli, '送达数量');
        checkDecimals(m, l.acceptedMilli, '合格实收数量');
        if (l.acceptedMilli > l.deliveredMilli) throw badRequest(`「${m.name}」合格实收不能多于送达数量`);
        const rejected = l.deliveredMilli - l.acceptedMilli;
        if (rejected > 0 && !l.rejectReason) throw badRequest(`「${m.name}」有拒收，请填写拒收原因`);
        let price = l.priceCents;
        let factor = m.purchaseFactorMilli;
        let purchaseUnit = m.purchaseUnit;
        let inventoryUnit = m.inventoryUnit;
        if (body.purchaseOrderId) {
          const pl = l.poLineId ? poLines.get(l.poLineId) : undefined;
          if (!pl || pl.materialId !== m.id) throw unprocessable('PO_LINE_MISMATCH', `「${m.name}」不在这张采购单里，请另做直接收货`);
          const remaining = pl.baseQtyMilli - (received.get(pl.id) ?? 0);
          if (l.acceptedMilli > remaining) {
            throw unprocessable('RECEIPT_EXCEEDS_ORDER', `「${m.name}」超出采购单未到数量（还差 ${formatQty(Math.max(0, remaining))} ${pl.inventoryUnit}）`, {
              materialId: m.id,
              remainingMilli: remaining,
            });
          }
          // 关联采购单时，价格、单位与换算以采购单为准
          price = pl.priceCents;
          factor = pl.factorMilli;
          purchaseUnit = pl.purchaseUnit;
          inventoryUnit = pl.inventoryUnit;
        } else if (price === null) {
          throw badRequest(`「${m.name}」请填写成交价（每${m.purchaseUnit}）`);
        }
        const amountCents = lineAmountCents(l.acceptedMilli, price!, factor);
        amount += amountCents;
        return {
          ...baseLine(m),
          inventoryUnit,
          purchaseUnit,
          factorMilli: factor,
          qtyMilli: l.acceptedMilli,
          deliveredMilli: l.deliveredMilli,
          rejectedMilli: rejected,
          rejectReason: rejected > 0 ? l.rejectReason : '',
          priceCents: price,
          amountCents,
          poLineId: body.purchaseOrderId ? l.poLineId : null,
          note: l.note,
        };
      });
      if (body.purchaseOrderId) {
        const seen = new Set<number>();
        for (const l of prepared) {
          if (seen.has(l.poLineId!)) throw badRequest('同一采购单行在一张收货单里只能出现一次');
          seen.add(l.poLineId!);
        }
      }
      return {
        ...empty,
        supplierId: body.supplierId,
        purchaseOrderId: body.purchaseOrderId,
        handler: body.handler,
        amountCents: amount,
        noPo: !body.purchaseOrderId,
        priceBasis,
        lines: prepared,
      };
    }
  }
}

async function insertLines(tx: Tx, docId: number, lines: PreparedLine[]) {
  await tx`DELETE FROM inv_doc_lines WHERE doc_id = ${docId}`;
  for (const [i, l] of lines.entries()) {
    await tx`
      INSERT INTO inv_doc_lines (doc_id, line_no, material_id, qty_milli, inventory_unit, purchase_unit, factor_milli,
                                 entered_qty_milli, entered_unit, delivered_milli, rejected_milli, reject_reason, price_cents,
                                 amount_cents, po_line_id, book_milli, counted_milli, book_move_id, source_line_id, note)
      VALUES (${docId}, ${i + 1}, ${l.materialId}, ${l.qtyMilli}, ${l.inventoryUnit}, ${l.purchaseUnit}, ${l.factorMilli},
              ${l.enteredQtyMilli}, ${l.enteredUnit}, ${l.deliveredMilli}, ${l.rejectedMilli}, ${l.rejectReason}, ${l.priceCents},
              ${l.amountCents}, ${l.poLineId}, ${l.bookMilli}, ${l.countedMilli}, ${l.bookMoveId}, ${l.sourceLineId}, ${l.note})`;
  }
}

// ───────────────────────── 生效 ─────────────────────────

async function needsApproval(db: Db, docId: number, type: InvDocType): Promise<boolean> {
  const rules = (await loadInventorySettings(db)).approvalRules;
  switch (type) {
    case 'opening':
      return rules.opening;
    case 'damage':
      return rules.damage;
    case 'supplier_return':
      return rules.supplier_return;
    case 'count': {
      // 没有差异的盘点不需要调整，直接生效
      const [row] = await db<{ diffs: number }[]>`SELECT count(*) AS diffs FROM inv_doc_lines WHERE doc_id = ${docId} AND qty_milli <> 0`;
      return (row?.diffs ?? 0) > 0;
    }
    default:
      return false;
  }
}

interface LineRow {
  id: number;
  materialId: number;
  qtyMilli: number;
  amountCents: number | null;
  poLineId: number | null;
  sourceLineId: number | null;
  bookMoveId: number | null;
}

/** 让单据生效：写库存流水（与应付流水），状态改为已生效。调用方已锁定单据行。 */
async function confirmDoc(tx: Tx, doc: DocRow & { docNo: string; amountCents: number }, actor: Actor, opts: { countReasons?: Record<string, CountReason> } = {}) {
  const lines = await tx<LineRow[]>`
    SELECT id, material_id, qty_milli, amount_cents, po_line_id, source_line_id, book_move_id
    FROM inv_doc_lines WHERE doc_id = ${doc.id} ORDER BY line_no`;

  // 锁顺序：原单 / 采购单 → 物料（与其他单据一致，避免死锁）
  if (doc.sourceDocId) {
    const [src] = await tx<{ status: string }[]>`SELECT status FROM inv_docs WHERE id = ${doc.sourceDocId} FOR UPDATE`;
    if (src?.status !== 'confirmed') throw conflict('SOURCE_NOT_CONFIRMED', '原单已冲销或未生效，不能继续');
  }
  if (doc.purchaseOrderId) {
    const [po] = await tx<{ status: string }[]>`SELECT status FROM purchase_orders WHERE id = ${doc.purchaseOrderId} FOR UPDATE`;
    if (po?.status !== 'approved') throw conflict('PO_NOT_APPROVED', '采购单已关闭或未确认，不能收货');
    // prepare 读取后，采购可能已完成改版。取得采购单锁后复核完整快照，不能只检查余量。
    const [stale] = await tx<{ changed: boolean }[]>`
      SELECT (d.supplier_id IS DISTINCT FROM p.supplier_id OR d.price_basis IS DISTINCT FROM p.price_basis
        OR EXISTS (
          SELECT 1 FROM inv_doc_lines l LEFT JOIN purchase_order_lines pl ON pl.id = l.po_line_id AND pl.po_id = p.id
          WHERE l.doc_id = d.id AND (pl.id IS NULL OR
            (l.material_id, l.price_cents, l.factor_milli, l.purchase_unit, l.inventory_unit)
            IS DISTINCT FROM (pl.material_id, pl.price_cents, pl.factor_milli, pl.purchase_unit, pl.inventory_unit))
        )) AS changed
      FROM inv_docs d JOIN purchase_orders p ON p.id = d.purchase_order_id WHERE d.id = ${doc.id}`;
    if (stale?.changed) throw conflict('PO_RECEIPT_STALE', '采购单内容已变化，请重新打开收货单，按最新采购单核对后再提交');
  }
  const mats = await lockMaterials(tx, lines.map((l) => l.materialId));
  const ref = (l: LineRow, moveType: Parameters<typeof applyMove>[3]['moveType']) => ({
    moveType,
    docId: doc.id,
    lineId: l.id,
    docDate: doc.docDate,
    operatorId: actor.id,
  });
  // 收货与退货记下结算方式（v0.7.7）：挂账记应付；现付的货款走费用报销，不记应付
  let settlement: SupplierSettlement | null = null;

  switch (doc.docType) {
    case 'opening': {
      for (const l of lines) {
        const [other] = await tx<{ count: number }[]>`
          SELECT count(*) AS count FROM stock_moves sm JOIN inv_docs d ON d.id = sm.doc_id
          WHERE sm.material_id = ${l.materialId} AND NOT (d.doc_type = 'opening' AND d.status = 'voided')`;
        const m = mats.get(l.materialId)!;
        if ((other?.count ?? 0) > 0 || m.stockMilli !== 0) {
          throw conflict('OPENING_EXISTS', `「${m.name}」已有库存记录，不能再建期初；请用盘点调整`);
        }
        await applyMove(tx, m, l.qtyMilli, ref(l, 'opening'));
      }
      break;
    }
    case 'receipt': {
      if (doc.purchaseOrderId) {
        const ordered = new Map(
          (await tx<{ id: number; baseQtyMilli: number }[]>`SELECT id, base_qty_milli FROM purchase_order_lines WHERE po_id = ${doc.purchaseOrderId}`).map((r) => [r.id, r.baseQtyMilli]),
        );
        const received = await receivedByPoLine(tx, doc.purchaseOrderId, doc.id);
        for (const l of lines) {
          const remaining = (ordered.get(l.poLineId!) ?? 0) - (received.get(l.poLineId!) ?? 0);
          if (l.qtyMilli > remaining) {
            const m = mats.get(l.materialId)!;
            throw conflict('RECEIPT_EXCEEDS_ORDER', `「${m.name}」超出采购单未到数量（还差 ${formatQty(Math.max(0, remaining))} ${m.inventoryUnit}）`);
          }
        }
      }
      for (const l of lines) await applyMove(tx, mats.get(l.materialId)!, l.qtyMilli, ref(l, 'receipt'));
      // 按采购单收货：跟着这张采购单的结算方式（第一张收货或已有的报销定下的，供应商改了设置也不变）
      if (doc.purchaseOrderId) settlement = await poSettlement(tx, doc.purchaseOrderId);
      else {
        const [sup] = await tx<{ settlement: SupplierSettlement }[]>`SELECT settlement FROM suppliers WHERE id = ${doc.supplierId}`;
        settlement = sup!.settlement;
      }
      if (doc.amountCents > 0 && settlement === 'credit') {
        await tx`
          INSERT INTO ap_entries (supplier_id, entry_type, amount_delta_cents, inv_doc_id, entry_date, operator_id)
          VALUES (${doc.supplierId}, 'receipt', ${doc.amountCents}, ${doc.id}, ${doc.docDate}, ${actor.id})`;
      }
      break;
    }
    case 'issue':
    case 'direct_use':
    case 'damage': {
      assertEnoughStock(mats, lines);
      const moveType = doc.docType;
      for (const l of lines) await applyMove(tx, mats.get(l.materialId)!, -l.qtyMilli, ref(l, moveType));
      break;
    }
    case 'issue_return':
    case 'supplier_return': {
      // 在原单锁内复核可退数量（只算已生效的退回 / 退货）
      const srcLines = new Map(
        (await tx<{ id: number; qtyMilli: number }[]>`SELECT id, qty_milli FROM inv_doc_lines WHERE doc_id = ${doc.sourceDocId}`).map((r) => [r.id, r.qtyMilli]),
      );
      const done = await tx<{ sourceLineId: number; qty: number }[]>`
        SELECT l.source_line_id, sum(l.qty_milli) AS qty FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
        WHERE d.source_doc_id = ${doc.sourceDocId} AND d.status = 'confirmed' AND d.id <> ${doc.id}
        GROUP BY l.source_line_id`;
      const doneMap = new Map(done.map((r) => [r.sourceLineId, r.qty]));
      for (const l of lines) {
        const remaining = (srcLines.get(l.sourceLineId!) ?? 0) - (doneMap.get(l.sourceLineId!) ?? 0);
        if (l.qtyMilli > remaining) {
          const m = mats.get(l.materialId)!;
          throw conflict('RETURN_EXCEEDS_SOURCE', `「${m.name}」最多还能退 ${formatQty(Math.max(0, remaining))} ${m.inventoryUnit}`);
        }
      }
      if (doc.docType === 'issue_return') {
        for (const l of lines) await applyMove(tx, mats.get(l.materialId)!, l.qtyMilli, ref(l, 'issue_return'));
      } else {
        assertEnoughStock(mats, lines);
        for (const l of lines) await applyMove(tx, mats.get(l.materialId)!, -l.qtyMilli, ref(l, 'supplier_return'));
        // 退货跟着原收货单的结算方式：现付的收货没记应付，退货也不记应付扣款（供应商退款在 RQ-002 做）
        const [src] = await tx<{ settlement: SupplierSettlement | null }[]>`SELECT settlement FROM inv_docs WHERE id = ${doc.sourceDocId}`;
        settlement = src?.settlement ?? 'credit';
        if (doc.amountCents > 0 && settlement === 'credit') {
          await tx`
            INSERT INTO ap_entries (supplier_id, entry_type, amount_delta_cents, inv_doc_id, entry_date, operator_id)
            VALUES (${doc.supplierId}, 'supplier_return', ${-doc.amountCents}, ${doc.id}, ${doc.docDate}, ${actor.id})`;
        }
      }
      break;
    }
    case 'count': {
      // 记下账面数之后又有收发：不能用旧盘点结果覆盖新变动，需要重新核对
      const stale = lines.filter((l) => l.bookMoveId !== mats.get(l.materialId)!.lastMoveId);
      if (stale.length > 0) {
        throw conflict('COUNT_STALE', `盘点后又有收发：${stale.map((l) => mats.get(l.materialId)!.name).join('、')}，请重新核对账面数后再确认`, {
          materialIds: stale.map((l) => l.materialId),
        });
      }
      for (const l of lines) {
        if (l.qtyMilli === 0) continue;
        const reason = opts.countReasons?.[String(l.id)] ?? 'unknown';
        await tx`UPDATE inv_doc_lines SET diff_reason = ${reason} WHERE id = ${l.id}`;
        await applyMove(tx, mats.get(l.materialId)!, l.qtyMilli, ref(l, 'count_adjust'));
      }
      break;
    }
  }

  await tx`
    UPDATE inv_docs SET status = 'confirmed', confirmed_by = ${actor.id}, confirmed_at = now(), settlement = ${settlement},
           submitted_by = coalesce(submitted_by, ${actor.id}), submitted_at = coalesce(submitted_at, now()), updated_at = now()
    WHERE id = ${doc.id}`;
}

async function lockDoc(tx: Tx, docId: number) {
  const [doc] = await tx<(DocRow & { docNo: string; amountCents: number })[]>`
    SELECT id, doc_no, doc_type, status, doc_date, supplier_id, purchase_order_id, department_id, source_doc_id,
           amount_cents, created_by, submitted_by
    FROM inv_docs WHERE id = ${docId} FOR UPDATE`;
  if (!doc) throw notFound('单据不存在');
  return doc;
}

/** 提交：不需要确认的单据直接生效；需要确认时进入待确认，提交人有确认权限且选择 approveNow 时一并确认 */
async function submitLocked(tx: Tx, doc: DocRow & { docNo: string; amountCents: number }, actor: Actor, approveNow: boolean) {
  if (doc.status === 'submitted' || doc.status === 'confirmed') return; // 幂等
  if (doc.status !== 'draft' && doc.status !== 'returned') throw conflict('INVALID_STATE', '单据当前状态不能提交');
  if (doc.docType === 'count') {
    const stale = await tx<{ name: string }[]>`
      SELECT m.name FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id
      WHERE l.doc_id = ${doc.id} AND l.book_move_id IS DISTINCT FROM m.last_move_id`;
    if (stale.length) {
      throw conflict('COUNT_STALE', `盘点后又有收发：${stale.map((s) => s.name).join('、')}。请先「按最新账面重新核对」，确认实盘数后再提交`);
    }
  }
  const approval = await needsApproval(tx, doc.id, doc.docType);
  await tx`UPDATE inv_docs SET status = 'submitted', submitted_by = ${actor.id}, submitted_at = now(), returned_reason = NULL, updated_at = now() WHERE id = ${doc.id}`;
  await logApproval(tx, 'inv_doc', doc.id, 'submit', actor.id);
  if (!approval) {
    await confirmDoc(tx, { ...doc, status: 'submitted' }, actor);
  } else if (approveNow) {
    if (!can(actor, 'inventory.approve')) throw forbidden('当前账号不能确认这类单据，请提交给负责人');
    await confirmDoc(tx, { ...doc, status: 'submitted' }, actor);
    await logApproval(tx, 'inv_doc', doc.id, 'approve', actor.id);
  }
}

// ───────────────────────── 对外操作 ─────────────────────────

const hashRequest = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

export async function createDoc(deps: Deps, raw: CreateDocInput, actor: Actor, ip?: string): Promise<{ doc: InvDoc; replayed: boolean }> {
  const meta = parse(CreateInput, raw);
  const body = parse(DocBody, raw);
  assertCanOperate(actor, body.docType);
  if (meta.approveNow && !can(actor, 'inventory.approve')) throw forbidden('当前账号不能确认这类单据，请提交给负责人');
  const requestHash = hashRequest({ ...body, action: meta.action, approveNow: meta.approveNow });
  const findExisting = async (db: Db) => {
    const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${meta.clientKey}`;
    if (!row) return null;
    if (row.opType !== 'inv_doc' || row.requestHash !== requestHash) {
      throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一张不同的单据，请刷新页面后重新填写');
    }
    return row.refId;
  };
  let docId: number;
  let replayed = false;
  try {
    const result = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const existing = await findExisting(tx);
      if (existing) return { id: existing, replayed: true };
      const prepared = await prepare(tx, deps, body, null);
      const meta2 = INV_DOC_META[body.docType];
      const docNo = await nextDocNo(tx, `inv_${body.docType}`, meta2.prefix, body.docDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO inv_docs (doc_no, doc_type, status, doc_date, supplier_id, purchase_order_id, department_id, handler,
                              source_doc_id, note, amount_cents, no_po, price_basis, client_key, created_by)
        VALUES (${docNo}, ${body.docType}, 'draft', ${body.docDate}, ${prepared.supplierId}, ${prepared.purchaseOrderId},
                ${prepared.departmentId}, ${prepared.handler}, ${prepared.sourceDocId}, ${body.note}, ${prepared.amountCents},
                ${prepared.noPo}, ${prepared.priceBasis}, ${meta.clientKey}, ${actor.id})
        RETURNING id`;
      const newId = row!.id;
      await insertLines(tx, newId, prepared.lines);
      await tx`
        INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id)
        VALUES (${meta.clientKey}, 'inv_doc', ${requestHash}, ${newId}, ${actor.id})`;
      await logApproval(tx, 'inv_doc', newId, 'create', actor.id);
      if (meta.action === 'submit') {
        await submitLocked(tx, await lockDoc(tx, newId), actor, meta.approveNow);
      }
      await writeAudit(tx, { staffId: actor.id, action: 'inventory_doc', targetType: body.docType, targetId: newId, detail: { docNo, action: meta.action }, ip });
      return { id: newId, replayed: false };
    });
    docId = result.id;
    replayed = result.replayed;
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, 'inv_docs_client_key_key')) {
      const existing = await findExisting(deps.sql);
      if (!existing) throw error;
      docId = existing;
      replayed = true;
    } else {
      throw error;
    }
  }
  return { doc: await getDoc(deps.sql, docId), replayed };
}

export async function updateDoc(deps: Deps, docId: number, raw: DocBodyInput & { action?: 'save' | 'submit'; approveNow?: boolean }, actor: Actor) {
  const body = parse(DocBody, raw);
  const meta = parse(CreateInput.omit({ clientKey: true }), raw);
  assertCanOperate(actor, body.docType);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    if (doc.docType !== body.docType) throw badRequest('不能更改单据类型');
    if (doc.status !== 'draft' && doc.status !== 'returned') throw conflict('INVALID_STATE', '只有草稿或退回修改的单据可以编辑');
    const existingLines = await tx<{ materialId: number; bookMilli: number | null; bookMoveId: number | null }[]>`
      SELECT material_id, book_milli, book_move_id FROM inv_doc_lines WHERE doc_id = ${docId}`;
    const prepared = await prepare(tx, deps, body, { id: docId, lines: existingLines });
    await tx`
      UPDATE inv_docs SET doc_date = ${body.docDate}, supplier_id = ${prepared.supplierId}, purchase_order_id = ${prepared.purchaseOrderId},
             department_id = ${prepared.departmentId}, handler = ${prepared.handler}, source_doc_id = ${prepared.sourceDocId},
             note = ${body.note}, amount_cents = ${prepared.amountCents}, no_po = ${prepared.noPo}, price_basis = ${prepared.priceBasis}, updated_at = now()
      WHERE id = ${docId}`;
    await insertLines(tx, docId, prepared.lines);
    if (meta.action === 'submit') await submitLocked(tx, await lockDoc(tx, docId), actor, meta.approveNow);
  });
  return getDoc(deps.sql, docId);
}

export async function submitDoc(deps: Deps, docId: number, actor: Actor, approveNow = false) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    assertCanOperate(actor, doc.docType);
    await submitLocked(tx, doc, actor, approveNow);
  });
  return getDoc(deps.sql, docId);
}

export async function approveDoc(deps: Deps, docId: number, raw: unknown, actor: Actor) {
  const { countReasons } = parse(ApproveInput, raw ?? {});
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    if (doc.status === 'confirmed') return; // 幂等
    if (doc.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的单据可以确认');
    await confirmDoc(tx, doc, actor, { countReasons });
    await logApproval(tx, 'inv_doc', docId, 'approve', actor.id);
  });
  return getDoc(deps.sql, docId);
}

/** 负责人退回修改：说明原因，提交人改后可再提交 */
export async function returnDoc(deps: Deps, docId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(ReasonInput, raw);
  await deps.sql.begin(async (tx) => {
    const doc = await lockDoc(tx, docId);
    if (doc.status === 'returned') return;
    if (doc.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的单据可以退回');
    await tx`UPDATE inv_docs SET status = 'returned', returned_reason = ${reason}, updated_at = now() WHERE id = ${docId}`;
    await logApproval(tx, 'inv_doc', docId, 'return', actor.id, reason);
  });
  return getDoc(deps.sql, docId);
}

/** 撤回（作废未生效的单据）：经办人或负责人 */
export async function cancelDoc(deps: Deps, docId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(ReasonInput, raw);
  await deps.sql.begin(async (tx) => {
    const doc = await lockDoc(tx, docId);
    if (doc.status === 'cancelled') return;
    if (!['draft', 'submitted', 'returned'].includes(doc.status)) throw conflict('INVALID_STATE', '已生效的单据不能撤回，只能冲销');
    if (!can(actor, 'inventory.approve') && doc.createdBy !== actor.id) throw forbidden('只能撤回自己创建的单据');
    await tx`UPDATE inv_docs SET status = 'cancelled', returned_reason = ${reason}, updated_at = now() WHERE id = ${docId}`;
    await logApproval(tx, 'inv_doc', docId, 'cancel', actor.id, reason);
  });
  return getDoc(deps.sql, docId);
}

/** 冲销已生效的单据：按原流水反向记账，原单保留并标记已冲销 */
export async function voidDoc(deps: Deps, docId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(ReasonInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    if (doc.status === 'voided') return;
    const check = await voidability(tx, await getDoc(tx, docId));
    if (!check.ok) throw conflict('NOT_VOIDABLE', check.reason ?? '这张单据不能冲销');
    const moves = await tx<{ materialId: number; docLineId: number; qtyDeltaMilli: number }[]>`
      SELECT material_id, doc_line_id, qty_delta_milli FROM stock_moves WHERE doc_id = ${docId} AND move_type <> 'void' ORDER BY id`;
    const mats = await lockMaterials(tx, moves.map((m) => m.materialId));
    // 冲销流水记在冲销当天，原单日期不变；按日期汇总时原单与冲销分别出现在各自日期
    const voidDate = todayIn(deps.config.timezone);
    for (const mv of moves) {
      await applyMove(tx, mats.get(mv.materialId)!, -mv.qtyDeltaMilli, {
        moveType: 'void',
        docId,
        lineId: mv.docLineId,
        docDate: voidDate,
        operatorId: actor.id,
      });
    }
    const ap = await tx<{ supplierId: number; amountDeltaCents: number }[]>`
      SELECT supplier_id, amount_delta_cents FROM ap_entries WHERE inv_doc_id = ${docId} AND entry_type <> 'void'`;
    for (const e of ap) {
      await tx`
        INSERT INTO ap_entries (supplier_id, entry_type, amount_delta_cents, inv_doc_id, entry_date, operator_id)
        VALUES (${e.supplierId}, 'void', ${-e.amountDeltaCents}, ${docId}, ${voidDate}, ${actor.id})`;
    }
    await tx`UPDATE inv_docs SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason}, updated_at = now() WHERE id = ${docId}`;
    await logApproval(tx, 'inv_doc', docId, 'void', actor.id, reason);
  });
  return getDoc(deps.sql, docId);
}

/** 盘点：对「账面已变动」的行，按最新账面重新记下账面数（实盘数保留，需员工再次核对） */
export async function refreshCountBook(deps: Deps, docId: number, actor: Actor) {
  await deps.sql.begin(async (tx) => {
    const doc = await lockDoc(tx, docId);
    assertCanOperate(actor, doc.docType);
    if (doc.docType !== 'count') throw badRequest('只有盘点单需要核对账面');
    if (doc.status !== 'draft' && doc.status !== 'returned') throw conflict('INVALID_STATE', '待确认的盘点单请由负责人退回后再重新核对');
    await tx`
      UPDATE inv_doc_lines l SET book_milli = m.stock_milli, book_move_id = m.last_move_id,
             qty_milli = l.counted_milli - m.stock_milli
      FROM materials m
      WHERE l.doc_id = ${docId} AND m.id = l.material_id AND l.book_move_id IS DISTINCT FROM m.last_move_id`;
  });
  return getDoc(deps.sql, docId);
}

/** 部门常用领用：近 60 天按次数排序，带上次领用数量，供领用单一键填入 */
export async function usualIssues(db: Db, departmentId: number) {
  return db<{ materialId: number; times: number; lastQtyMilli: number }[]>`
    SELECT l.material_id, count(*) AS times,
           (array_agg(l.qty_milli ORDER BY d.doc_date DESC, d.id DESC))[1] AS last_qty_milli
    FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id JOIN materials m ON m.id = l.material_id
    WHERE d.doc_type = 'issue' AND d.status = 'confirmed' AND d.department_id = ${departmentId}
      AND d.doc_date >= current_date - 60 AND m.active AND m.tracked
    GROUP BY l.material_id ORDER BY count(*) DESC, max(d.id) DESC LIMIT 16`;
}

export async function findDocByKey(db: Db, key: string): Promise<InvDoc | null> {
  const [row] = await db<{ id: number }[]>`SELECT id FROM inv_docs WHERE client_key = ${key}`;
  return row ? getDoc(db, row.id) : null;
}

// ───────────────────────── 路由 ─────────────────────────

const ListQuery = z.object({
  type: z.enum(Object.keys(INV_DOC_META) as [InvDocType, ...InvDocType[]]).optional(),
  status: z.string().max(16).optional(),
  from: docDateSchema.optional(),
  to: docDateSchema.optional(),
  materialId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(32).optional(),
});

export function registerDocRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const docId = (req: FastifyRequest) => parse(idParam, req.params).id;
  const typeOf = async (id: number) => {
    const [row] = await sql<{ docType: InvDocType; createdBy: number }[]>`SELECT doc_type, created_by FROM inv_docs WHERE id = ${id}`;
    if (!row) throw notFound('单据不存在');
    return row;
  };

  app.get('/api/inventory/docs', { preHandler: guard('inventory.read') }, async (req) => listDocs(sql, parse(ListQuery, req.query)));
  app.get('/api/inventory/docs/by-key/:key', { preHandler: guard('inventory.read') }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid() }), req.params);
    const doc = await findDocByKey(sql, key);
    return doc ? { found: true, doc } : { found: false };
  });
  app.get('/api/inventory/docs/:id', { preHandler: guard('inventory.read') }, async (req) => getDoc(sql, docId(req)));
  app.get('/api/inventory/departments/:id/usual', { preHandler: guard('inventory.read') }, async (req) =>
    usualIssues(sql, parse(idParam, req.params).id),
  );

  app.post('/api/inventory/docs', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const result = await createDoc(deps, req.body as CreateDocInput, req.actor, req.ip);
    reply.code(result.replayed ? 200 : 201);
    return result;
  });
  app.put('/api/inventory/docs/:id', { preHandler: guard('inventory.read') }, async (req) =>
    updateDoc(deps, docId(req), req.body as DocBodyInput, req.actor),
  );
  app.post('/api/inventory/docs/:id/submit', { preHandler: guard('inventory.read') }, async (req) => {
    const { approveNow } = parse(z.object({ approveNow: z.boolean().default(false) }), req.body ?? {});
    return submitDoc(deps, docId(req), req.actor, approveNow);
  });
  app.post('/api/inventory/docs/:id/approve', { preHandler: guard('inventory.approve') }, async (req) =>
    approveDoc(deps, docId(req), req.body, req.actor),
  );
  app.post('/api/inventory/docs/:id/return', { preHandler: guard('inventory.approve') }, async (req) =>
    returnDoc(deps, docId(req), req.body, req.actor),
  );
  app.post('/api/inventory/docs/:id/cancel', { preHandler: guard('inventory.read') }, async (req) => {
    const id = docId(req);
    assertCanOperate(req.actor, (await typeOf(id)).docType);
    return cancelDoc(deps, id, req.body, req.actor);
  });
  app.post('/api/inventory/docs/:id/void', { preHandler: guard('inventory.approve') }, async (req) =>
    voidDoc(deps, docId(req), req.body, req.actor),
  );
  app.post('/api/inventory/docs/:id/refresh-book', { preHandler: guard('inventory.operate') }, async (req) =>
    refreshCountBook(deps, docId(req), req.actor),
  );
}
