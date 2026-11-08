// 库存单据：期初、收货、领用、领用退回、直接耗用、报损、盘点、退供应商。
//
// 生命周期：草稿 → 提交 →（需要时）负责人确认 → 已生效；负责人可退回修改；生效后只能冲销。
// 退供应商（#20，v0.7.12）：确认后先进「待供应商确认」，采购登记「供应商已同意」才生效（出库、扣款），「不同意」则撤回。
// 免确认门槛（#18，v0.7.12）：设为需要确认的单据，金额不超过门槛的提交即生效（报损、期初按物料参考价估算）。
// 只有「已生效」才写库存流水和应付流水；草稿、待确认、已退回都不影响库存或货款。
// 新建单据带操作编号（幂等键），重复提交只得到同一张单；提交、确认、退回、冲销按状态幂等。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CENTRAL_WAREHOUSE_ID,
  COUNT_REASONS,
  INV_DOC_META,
  isBigVariance,
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
import { lockOpKey } from '../../lib/fences';
import { idParam, parse } from '../../lib/validate';
import {
  applyMove,
  assertEnoughDeptStock,
  assertEnoughStock,
  assertNotFuture,
  assertSameMonth,
  canOperateDept,
  departmentWarehouse,
  deptBalances,
  docDateSchema,
  loadInventorySettings,
  lockDeptWarehouse,
  overThreshold,
  lockMaterials,
  logApproval,
  nextDocNo,
  poSettlement,
  priceBaseline,
  setTxTimeouts,
  todayIn,
  warehouseInfo,
  weighedCapMilli,
} from './common';
import { hashRequest } from '../../lib/idempotency';
import { approvalBrief, approveCurrent, closeApproval, returnCurrent, submitForApproval } from '../approvals/engine';
import { urgentPlan } from './urgent';
import { receiptAttachments } from './attachments';

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
  /** 差异原因（v0.7.30，A8）：大差异的行提交时必须写原因类别与说明；小差异的可以不写（确认时按默认） */
  diffReason: z.enum(COUNT_REASONS).nullable().default(null),
  diffNote: z.string().trim().max(100, '差异说明最多 100 字').default(''),
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
/** 期初、耗用、报损、盘点动哪个仓（v0.7.11 两级库存；不填是总仓） */
const WarehouseField = { warehouseId: id.default(CENTRAL_WAREHOUSE_ID) };

const DocBody = z.discriminatedUnion('docType', [
  z.object({ docType: z.literal('opening'), ...Header, ...WarehouseField, lines: lines(OpeningLine) }),
  z.object({
    docType: z.literal('receipt'),
    ...Header,
    supplierId: id,
    purchaseOrderId: id.nullable().default(null),
    handler: z.string().trim().max(32).default(''),
    /** 一起验收的采购经办（#17 第一次验收；按采购单收货必选） */
    coAcceptorId: id.nullable().default(null),
    /** 急采（#19）：没有采购单，进这个部门的小仓，合计不超过急采上限 */
    urgent: z.boolean().default(false),
    departmentId: id.nullable().default(null),
    lines: lines(ReceiptLine),
  }),
  z.object({ docType: z.literal('issue'), ...Header, departmentId: id, handler: z.string().trim().min(1, '请填写领料人').max(32), lines: lines(QtyLine) }),
  z.object({ docType: z.literal('issue_return'), ...Header, sourceDocId: id, handler: z.string().trim().max(32).default(''), lines: lines(SourceLine) }),
  z.object({ docType: z.literal('direct_use'), ...Header, ...WarehouseField, note: z.string().trim().min(2, '请填写耗用用途').max(200), lines: lines(QtyLine) }),
  z.object({ docType: z.literal('damage'), ...Header, ...WarehouseField, note: z.string().trim().min(2, '请填写报损原因').max(200), lines: lines(QtyLine) }),
  z.object({ docType: z.literal('count'), ...Header, ...WarehouseField, lines: lines(CountLine) }),
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
/** 供应商对退货的答复（#20）：同意写同意的日期，不同意写原因 */
const AnswerInput = z.discriminatedUnion('agreed', [
  z.object({ agreed: z.literal(true), date: docDateSchema, note: z.string().trim().max(200, '说明最多 200 字').default('') }),
  z.object({ agreed: z.literal(false), note: z.string().trim().min(2, '请写明供应商不同意的原因（至少 2 个字）').max(200, '说明最多 200 字') }),
]);
/** 审批（v0.7.30）：页面看到的审批单与级别（审批单已经变了、走到别的级别时拒绝） */
const ApprovalFence = z.object({
  requestId: z.number().int().positive().optional(),
  level: z.number().int().min(1).max(3).optional(),
  /** 审批中心的批量同意（记在审批记录上） */
  batch: z.boolean().optional(),
});
const ApproveInput = ApprovalFence.extend({
  /** 盘点：每行差异的确认原因 */
  countReasons: z.record(z.string(), z.enum(COUNT_REASONS)).default({}),
  /** 同意时的意见（选填） */
  comment: z.string().trim().max(200, '意见最多 200 个字').default(''),
});
const ReturnInput = ReasonInput.extend(ApprovalFence.shape);

/** 走审批中心的物资单据（v0.7.30）：报损、退供应商、期初、盘点；急采的验收（仓库到部门验收）不在审批中心 */
const APPROVAL_INV_TYPES: readonly InvDocType[] = ['damage', 'supplier_return', 'opening', 'count'];
const inApprovalCenter = (doc: { docType: InvDocType; urgent: boolean }) => !doc.urgent && APPROVAL_INV_TYPES.includes(doc.docType);

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

/** 单据动的仓（领料、退回是部门小仓那一头；迁移前的领料、退回为空） */
export interface WarehouseRef {
  id: number;
  kind: 'central' | 'department';
  departmentId: number | null;
  name: string;
  active: boolean;
}

/**
 * 谁能登记（v0.7.11 两级库存，见 docs/WAREHOUSES.md）：总仓的单据与领料、退回要「物资经办」（退供应商：物资经办或采购经办）；
 * 部门小仓：本部门的部门申购（期初、耗用、报损、盘点、退供应商），财务成本岗可给任何部门盘点、登记耗用；店主不限。
 * 急采（进部门小仓的收货）8.0.1 起收拢到采购（采购组整改 05，CG05）：只有「编制与提交采购单」的（与店主）能登记，部门、仓库都不能。
 */
export async function assertCanOperate(db: Db, actor: Actor, type: InvDocType, wh: WarehouseRef | null) {
  const central = !wh || wh.kind === 'central' || type === 'issue' || type === 'issue_return';
  if (central) {
    if (!can(actor, OPERATE_PERMISSION[type])) throw forbidden(`当前账号没有「${INV_DOC_META[type].title}」的职责`);
    return;
  }
  if (actor.role === 'owner') return;
  if (type === 'receipt') {
    if (can(actor, 'purchase.manage')) return;
    throw forbidden('急采统一由采购在「采购 → 急采」登记（8.0.1 起部门、仓库不再登记急采）');
  }
  if ((type === 'count' || type === 'direct_use') && can(actor, 'deptStock.audit')) return;
  if (type === 'supplier_return' && can(actor, 'supplierReturn.create')) return;
  if (await canOperateDept(db, actor, wh.departmentId)) return;
  throw forbidden(`只有${wh.name}所属部门的部门申购${type === 'count' || type === 'direct_use' ? '或财务成本岗' : ''}可以登记`);
}

export async function warehouseRef(db: Db, warehouseId: number | null): Promise<WarehouseRef | null> {
  if (warehouseId === null) return null;
  const w = await warehouseInfo(db, warehouseId);
  if (!w) throw unprocessable('WAREHOUSE_NOT_FOUND', '仓库不存在，请刷新后重试');
  return w;
}

/** 新建、编辑时按输入算这张单动的仓 */
async function warehouseOfBody(db: Db, body: z.infer<typeof DocBody>): Promise<WarehouseRef | null> {
  switch (body.docType) {
    case 'opening':
    case 'direct_use':
    case 'damage':
    case 'count':
      return warehouseRef(db, body.warehouseId);
    case 'receipt': {
      if (!body.urgent) return warehouseRef(db, CENTRAL_WAREHOUSE_ID);
      if (!body.departmentId) throw badRequest('急采要选是哪个部门买的');
      const w = await departmentWarehouse(db, body.departmentId);
      if (!w) throw unprocessable('WAREHOUSE_NOT_FOUND', '这个部门还没有小仓，请刷新后重试');
      return warehouseRef(db, w.id);
    }
    case 'issue': {
      const w = await departmentWarehouse(db, body.departmentId);
      if (!w) throw unprocessable('WAREHOUSE_NOT_FOUND', '这个部门还没有小仓，请刷新后重试');
      return warehouseRef(db, w.id);
    }
    case 'issue_return':
    case 'supplier_return': {
      const [src] = await db<{ warehouseId: number | null }[]>`SELECT warehouse_id FROM inv_docs WHERE id = ${body.sourceDocId}`;
      return warehouseRef(db, src?.warehouseId ?? null);
    }
  }
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
  warehouseId: number | null;
  urgent: boolean;
  /** 急采按金额分级审批通过的时间（8.0.1）；批了以后才能验收 */
  urgentApprovedAt?: string | null;
  createdBy: number;
  submittedBy: number | null;
  /** 退供应商：供应商同意的日期（生效日期，v0.7.12） */
  supplierAnswerDate?: string | null;
}

/** 仓的显示名（总仓用「库存范围名称」） */
const WAREHOUSE_NAME_SQL = (db: Db) => db`CASE WHEN w.kind = 'central'
  THEN coalesce((SELECT value #>> '{}' FROM settings WHERE key = 'inventory_scope_name'), '后勤总库')
  ELSE wd.name || '小仓' END`;

export async function getDoc(db: Db, docId: number, timeZone?: string): Promise<InvDoc> {
  const [d] = await db<(InvDoc & Record<string, unknown>)[]>`
    SELECT d.id, d.doc_no, d.doc_type, d.status, d.doc_date, d.handler, d.note, d.amount_cents, d.no_po, d.is_synthetic, d.created_by,
           d.created_at, d.submitted_at, d.confirmed_at, d.returned_reason, d.voided_at, d.void_reason,
           d.warehouse_id, d.urgent, d.urgent_cap_cents, d.urgent_approved_at,
           CASE WHEN w.id IS NULL THEN NULL ELSE json_build_object('id', w.id, 'name', ${WAREHOUSE_NAME_SQL(db)}, 'kind', w.kind) END AS warehouse,
           CASE WHEN ca.id IS NULL THEN NULL ELSE json_build_object('id', ca.id, 'name', ca.display_name) END AS co_acceptor,
           CASE WHEN d.dept_signed_at IS NULL THEN NULL
                ELSE json_build_object('signedByName', sg.display_name, 'signedAt', d.dept_signed_at, 'note', coalesce(d.dept_sign_note, '')) END AS dept_sign,
           CASE WHEN d.supplier_answer_at IS NULL THEN NULL
                ELSE json_build_object('agreed', d.supplier_answer_date IS NOT NULL, 'date', d.supplier_answer_date, 'note', coalesce(d.supplier_answer_note, ''),
                                       'byName', sa.display_name, 'at', d.supplier_answer_at) END AS supplier_answer,
           d.return_applied_cents, coalesce(src.settlement, 'credit') AS source_settlement,
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
    LEFT JOIN warehouses w ON w.id = d.warehouse_id
    LEFT JOIN departments wd ON wd.id = w.department_id
    LEFT JOIN staff ca ON ca.id = d.co_acceptor_id
    LEFT JOIN staff sg ON sg.id = d.dept_signed_by
    LEFT JOIN staff sa ON sa.id = d.supplier_answer_by
    WHERE d.id = ${docId}`;
  if (!d) throw notFound('单据不存在');
  // 行上的「当前结存」与盘点的账面：按这张单出库的那个仓（领料从总仓出，退回从部门小仓出）
  const docWarehouseId = (d.warehouseId as number | null) ?? null;
  const stockWarehouseId = d.docType === 'issue' || docWarehouseId === null ? CENTRAL_WAREHOUSE_ID : docWarehouseId;
  const isDept = stockWarehouseId !== CENTRAL_WAREHOUSE_ID;

  const lines = await db<InvDoc['lines']>`
    SELECT l.id, l.line_no, l.material_id, m.code AS material_code, m.name AS material_name, m.specification, m.decimals,
           l.qty_milli, l.inventory_unit, l.purchase_unit, l.factor_milli, l.entered_qty_milli, l.entered_unit,
           l.delivered_milli, l.rejected_milli, l.reject_reason, l.price_cents, l.amount_cents, l.po_line_id,
           l.book_milli, l.counted_milli, l.diff_reason, l.diff_note, l.source_line_id, l.note, m.counter_use, m.weighed,
           CASE WHEN ${isDept} THEN coalesce(ws.stock_milli, 0) ELSE m.stock_milli END AS stock_milli,
           -- 台面日耗品（#14，v0.7.13）：领料、急采生效时在部门小仓自动记的耗用
           EXISTS (SELECT 1 FROM stock_moves am WHERE am.doc_line_id = l.id AND am.move_type = 'direct_use'
                   AND ${d.docType === 'issue' || d.docType === 'receipt'}) AS auto_consumed,
           (${d.docType === 'count' && ['draft', 'submitted', 'returned'].includes(d.status)}
            AND l.book_move_id IS DISTINCT FROM CASE WHEN ${isDept} THEN ws.last_move_id ELSE m.last_move_id END) AS stale,
           coalesce((SELECT sum(rl.qty_milli) FROM inv_doc_lines rl JOIN inv_docs rd ON rd.id = rl.doc_id
                     WHERE rl.source_line_id = l.id AND rd.status IN ('confirmed', 'submitted', 'awaiting_supplier')), 0) AS returned_milli
    FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id
    LEFT JOIN warehouse_stock ws ON ws.warehouse_id = ${stockWarehouseId} AND ws.material_id = l.material_id
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

  // 已生效的退货：扣款抵了原收货单多少，退货余额的核销与退款（v0.7.12）
  let returnCredit: InvDoc['returnCredit'] = null;
  if (d.docType === 'supplier_return' && d.status === 'confirmed') {
    const [used] = await db<{ offsetCents: number; refundedCents: number }[]>`
      SELECT coalesce((SELECT sum(amount_cents) FROM ap_offsets WHERE credit_return_id = ${docId} AND status = 'confirmed'), 0) AS offset_cents,
             coalesce((SELECT sum(amount_cents) FROM supplier_refunds WHERE credit_return_id = ${docId} AND status = 'confirmed'), 0) AS refunded_cents`;
    const applied = (d.returnAppliedCents as number | null) ?? d.amountCents;
    returnCredit = {
      settlement: d.sourceSettlement as NonNullable<InvDoc['returnCredit']>['settlement'],
      appliedCents: applied,
      offsetCents: used!.offsetCents,
      refundedCents: used!.refundedCents,
      availableCents: d.amountCents - applied - used!.offsetCents - used!.refundedCents,
    };
  }
  const { warehouseId: _w, returnAppliedCents: _a, sourceSettlement: _s, ...rest } = d;
  const approval = await approvalBrief(db, 'inv_doc', docId);
  // 收货单的附件（8.0.1，CG11）
  const attachments = d.docType === 'receipt' ? ((await receiptAttachments(db, [docId])).get(docId) ?? []) : [];
  const doc = { ...rest, returnCredit, lines, children, approvals, approval, attachments, voidable: { ok: false, reason: null } } as InvDoc;
  doc.voidable = await voidability(db, doc, timeZone);
  return doc;
}

export async function listDocs(
  db: Db,
  f: {
    type?: InvDocType;
    status?: string;
    from?: string;
    to?: string;
    materialId?: number;
    q?: string;
    supplierId?: number;
    /** 只看动这个仓的单据（领料、退回按部门小仓那一头） */
    warehouseId?: number;
    /** 领料：只看部门还没签收的 */
    unsigned?: boolean;
    urgent?: boolean;
    limit?: number;
  },
): Promise<InvDocSummary[]> {
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return db<InvDocSummary[]>`
    SELECT d.id, d.doc_no, d.doc_type, d.status, d.doc_date, d.amount_cents, d.no_po, d.created_at, d.urgent,
           coalesce(s.name, dep.name) AS party_name, cb.display_name AS created_by_name,
           CASE WHEN w.id IS NULL THEN NULL ELSE ${WAREHOUSE_NAME_SQL(db)} END AS warehouse_name,
           CASE WHEN d.doc_type = 'issue' AND d.warehouse_id IS NOT NULL THEN d.dept_signed_at IS NOT NULL END AS dept_signed,
           (d.urgent AND d.status = 'confirmed' AND d.purchase_order_id IS NULL) AS needs_backfill,
           (d.urgent_approved_at IS NOT NULL) AS urgent_approved,
           (SELECT count(*) FROM inv_doc_lines WHERE doc_id = d.id) AS line_count,
           coalesce((SELECT string_agg(m.name, '、' ORDER BY l.line_no) FROM (
              SELECT * FROM inv_doc_lines WHERE doc_id = d.id ORDER BY line_no LIMIT 3) l
              JOIN materials m ON m.id = l.material_id), '') AS summary
    FROM inv_docs d
    LEFT JOIN suppliers s ON s.id = d.supplier_id
    LEFT JOIN departments dep ON dep.id = d.department_id
    LEFT JOIN warehouses w ON w.id = d.warehouse_id
    LEFT JOIN departments wd ON wd.id = w.department_id
    JOIN staff cb ON cb.id = d.created_by
    WHERE true
      ${f.type ? db`AND d.doc_type = ${f.type}` : db``}
      ${
        !f.warehouseId
          ? db``
          : f.warehouseId === CENTRAL_WAREHOUSE_ID
            ? // 领料、退回一头是总仓，按总仓筛也列出
              db`AND (d.warehouse_id IS NULL OR d.warehouse_id = ${CENTRAL_WAREHOUSE_ID} OR d.doc_type IN ('issue', 'issue_return'))`
            : db`AND d.warehouse_id = ${f.warehouseId}`
      }
      ${f.unsigned ? db`AND d.doc_type = 'issue' AND d.status = 'confirmed' AND d.warehouse_id IS NOT NULL AND d.dept_signed_at IS NULL` : db``}
      ${f.urgent !== undefined ? db`AND d.urgent = ${f.urgent}` : db``}
      ${f.status ? db`AND d.status = ${f.status}` : db``}
      ${f.from ? db`AND d.doc_date >= ${f.from}` : db``}
      ${f.to ? db`AND d.doc_date <= ${f.to}` : db``}
      ${f.supplierId ? db`AND d.supplier_id = ${f.supplierId}` : db``}
      ${f.materialId ? db`AND EXISTS (SELECT 1 FROM inv_doc_lines WHERE doc_id = d.id AND material_id = ${f.materialId})` : db``}
      ${like ? db`AND (d.doc_no ILIKE ${like} OR s.name ILIKE ${like} OR dep.name ILIKE ${like} OR d.handler ILIKE ${like} OR d.note ILIKE ${like})` : db``}
    ORDER BY d.doc_date DESC, d.id DESC
    LIMIT ${f.limit ?? 200}`;
}

/** 冲销条件：有后续业务的原单不能冲销，需先处理后续单据；#21 跨月不能冲销（给了门店时区才判断，冲销时一定判断） */
async function voidability(db: Db, doc: InvDoc, timeZone?: string): Promise<InvDoc['voidable']> {
  if (doc.status !== 'confirmed') return { ok: false, reason: '只有已生效的单据可以冲销' };
  if (doc.docType === 'count') return { ok: false, reason: '盘点调整不能冲销，如有错误请重新盘点' };
  // 退供应商按供应商同意（生效）那天算月份（v0.7.12）
  const effectiveDate = effectiveDateOf(doc);
  if (timeZone && effectiveDate.slice(0, 7) !== todayIn(timeZone).slice(0, 7)) {
    return { ok: false, reason: `单据日期在 ${Number(effectiveDate.slice(5, 7))} 月，跨月不能冲销；请用本月的单据更正` };
  }
  const activeChildren = doc.children.filter((c) => c.status === 'confirmed' || c.status === 'submitted' || c.status === 'awaiting_supplier');
  if (activeChildren.length > 0) {
    return { ok: false, reason: `已有后续单据 ${activeChildren.map((c) => c.docNo).join('、')}，需先冲销或撤回后续单据` };
  }
  if (doc.docType === 'receipt') {
    const [paid] = await db<{ count: number }[]>`
      SELECT count(*) AS count FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
      WHERE pa.receipt_doc_id = ${doc.id} AND p.status IN ('confirmed', 'submitted')`;
    if (paid && paid.count > 0) return { ok: false, reason: '这张收货单已有付款核销，需先冲销付款' };
    const [offset] = await db<{ docNo: string }[]>`
      SELECT o.doc_no FROM ap_offset_lines ol JOIN ap_offsets o ON o.id = ol.offset_id
      WHERE ol.receipt_doc_id = ${doc.id} AND o.status = 'confirmed' ORDER BY o.id LIMIT 1`;
    if (offset) return { ok: false, reason: `这张收货单已有核销（${offset.docNo}），需先冲销核销单` };
    // 现付的采购单按采购单报销了这几行（到货数量取自收货）：先冲销或撤回报销（测试服回归报告，v0.7.11）
    const [claimed] = await db<{ docNo: string }[]>`
      SELECT c.doc_no FROM expense_claim_lines cl JOIN expense_claims c ON c.id = cl.claim_id
      WHERE c.status IN ('submitted', 'returned', 'confirmed')
        AND cl.po_line_id IN (SELECT po_line_id FROM inv_doc_lines WHERE doc_id = ${doc.id} AND po_line_id IS NOT NULL)
      ORDER BY c.id LIMIT 1`;
    if (claimed) return { ok: false, reason: `这张收货单的采购单已按采购单报销（${claimed.docNo}），需先冲销或撤回报销` };
  }
  if (doc.docType === 'supplier_return') {
    // 退货余额已经核销到别的货款或退了款：先冲销那一笔（v0.7.12）
    const [used] = await db<{ docNo: string }[]>`
      SELECT doc_no FROM (
        SELECT doc_no, id FROM ap_offsets WHERE credit_return_id = ${doc.id} AND status = 'confirmed'
        UNION ALL SELECT doc_no, id FROM supplier_refunds WHERE credit_return_id = ${doc.id} AND status = 'confirmed'
      ) x ORDER BY id LIMIT 1`;
    if (used) return { ok: false, reason: `这张退货单的退货余额已核销或退款（${used.docNo}），需先冲销那一笔` };
  }
  return { ok: true, reason: null };
}

/** 单据的生效日期：退供应商按供应商同意的日期（v0.7.12），其他按单据日期 */
function effectiveDateOf(doc: Pick<InvDoc, 'docType' | 'docDate' | 'supplierAnswer'>): string {
  return doc.docType === 'supplier_return' && doc.supplierAnswer?.agreed && doc.supplierAnswer.date ? doc.supplierAnswer.date : doc.docDate;
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
  /** 盘点：提交时写的差异原因与说明（v0.7.30） */
  diffReason?: CountReason | null;
  diffNote?: string;
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
  /** 动的仓（领料、退回记部门小仓那一头；迁移前的领料的退回为空） */
  warehouseId: number | null;
  urgent: boolean;
  urgentCapCents: number | null;
  coAcceptorId: number | null;
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
  counterUse: boolean;
  weighed: boolean;
}

async function loadMaterials(db: Db, ids: number[]): Promise<Map<number, MaterialInfo>> {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await db<MaterialInfo[]>`
        SELECT id, name, inventory_unit, decimals, purchase_unit, purchase_factor_milli, tracked, active, stock_milli, last_move_id,
               counter_use, weighed
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

/**
 * 台面日耗品（#14，v0.7.13）领到部门即算耗用，部门小仓始终没有结存：部门小仓不登记它的期初、耗用、报损、盘点，
 * 也不能退回总仓（领错了冲销整张领料单再重新登记）。
 */
export function assertNoCounterUse(
  mats: Map<number, { name: string; counterUse: boolean }>,
  what: 'dept' | 'return',
  status: 'prepare' | 'confirm' = 'prepare',
) {
  const hit = [...mats.values()].filter((m) => m.counterUse);
  if (hit.length === 0) return;
  const names = hit.map((m) => `「${m.name}」`).join('');
  const msg =
    what === 'return'
      ? `${names}是台面日耗品，领到部门时已经算耗用，不能退回；数量登记错了请冲销原领料单后重新登记`
      : `${names}是台面日耗品，领到部门即算耗用，部门小仓不登记期初、耗用、报损、盘点；请从单据里去掉`;
  if (status === 'confirm') throw conflict('COUNTER_USE_NOT_ALLOWED', msg);
  throw unprocessable('COUNTER_USE_NOT_ALLOWED', msg);
}

/** 称重物料（#14，v0.7.13）按实际称重收货，可以比订购数量多出容差；其他物料不能超过订购数量 */
function receiptRoom(m: { weighed: boolean }, orderedMilli: number, receivedMilli: number, tolerancePct: number): number {
  return (m.weighed ? weighedCapMilli(orderedMilli, tolerancePct) : orderedMilli) - receivedMilli;
}
function receiptExceedsMessage(m: { name: string; weighed: boolean }, unit: string, orderedMilli: number, receivedMilli: number, room: number, tolerancePct: number) {
  if (m.weighed) {
    return `「${m.name}」超出采购单数量的称重容差：订 ${formatQty(orderedMilli)} ${unit}，已收 ${formatQty(receivedMilli)} ${unit}，容差 ${tolerancePct}%，最多还能收 ${formatQty(Math.max(0, room))} ${unit}`;
  }
  return `「${m.name}」超出采购单未到数量（还差 ${formatQty(Math.max(0, room))} ${unit}）`;
}

/** 已退回 / 已退货数量：只统计已生效与待确认的单据，排除正在编辑的这张 */
async function returnedBySourceLine(db: Db, sourceLineIds: number[], excludeDocId: number | null) {
  if (sourceLineIds.length === 0) return new Map<number, number>();
  const rows = await db<{ sourceLineId: number; qty: number }[]>`
    SELECT l.source_line_id, sum(l.qty_milli) AS qty FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
    WHERE l.source_line_id IN ${db(sourceLineIds)} AND d.status IN ('confirmed', 'submitted', 'awaiting_supplier')
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

async function prepare(
  db: Db,
  deps: Deps,
  body: z.infer<typeof DocBody>,
  existing: { id: number; lines: { materialId: number; bookMilli: number | null; bookMoveId: number | null }[] } | null,
  wh: WarehouseRef | null,
  actor: Actor,
): Promise<Prepared> {
  assertNotFuture(body.docDate, deps.config.timezone);
  if (wh && !wh.active && body.docType !== 'issue_return' && body.docType !== 'supplier_return') {
    throw unprocessable('WAREHOUSE_INACTIVE', `${wh.name}所属的部门已停用`);
  }
  const empty: Prepared = {
    supplierId: null,
    purchaseOrderId: null,
    // 部门小仓的单据记下部门（列表、库存卡的「对象」显示部门）
    departmentId: wh?.kind === 'department' ? wh.departmentId : null,
    sourceDocId: null,
    handler: '',
    amountCents: 0,
    noPo: false,
    priceBasis: '',
    warehouseId: wh?.id ?? null,
    urgent: false,
    urgentCapCents: null,
    coAcceptorId: null,
    lines: [],
  };

  switch (body.docType) {
    case 'opening': {
      assertUniqueMaterials(body.lines, '期初单');
      const mats = await loadMaterials(db, body.lines.map((l) => l.materialId));
      if (wh?.kind === 'department') assertNoCounterUse(mats, 'dept');
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
      if (body.docType !== 'issue' && wh?.kind === 'department') assertNoCounterUse(mats, 'dept');
      return {
        ...empty,
        departmentId: body.docType === 'issue' ? body.departmentId : empty.departmentId,
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
      if (wh?.kind === 'department') assertNoCounterUse(mats, 'dept');
      // 账面按盘点的仓：总仓在物料上，部门小仓在 warehouse_stock（v0.7.11）
      if (wh && wh.kind === 'department') {
        const dept = await deptBalances(db, wh.id, body.lines.map((l) => l.materialId));
        for (const [mid, b] of dept) {
          const m = mats.get(mid)!;
          m.stockMilli = b.stockMilli;
          m.lastMoveId = b.lastMoveId;
        }
      }
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
          const diff = l.countedMilli - bookMilli;
          return {
            ...baseLine(m),
            qtyMilli: diff,
            countedMilli: l.countedMilli,
            bookMilli,
            bookMoveId,
            note: l.note,
            // 没有差异的行不记原因
            diffReason: diff === 0 ? null : l.diffReason,
            diffNote: diff === 0 ? '' : l.diffNote,
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
      // 迁移 029 以前的领料没进部门小仓，退回只进总仓，不受台面日耗品的限制
      if (body.docType === 'issue_return' && wh?.kind === 'department') assertNoCounterUse(mats, 'return');
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
      const settings = await loadInventorySettings(db);
      const capText = `¥${(settings.urgentCapCents / 100).toFixed(2)}`;
      // #19：不允许没开采购单先收货；没有采购单只能由部门登记急采（进部门小仓，不超过上限）
      if (body.urgent && body.purchaseOrderId) throw badRequest('急采是没有采购单的收货；有采购单请按采购单收货');
      if (!body.urgent && !body.purchaseOrderId) {
        throw unprocessable('PO_REQUIRED', `收货必须对应已确认的采购单；没有采购单的只能由部门登记急采（合计不超过 ${capText}）`);
      }
      // #17：按采购单收货，采购和仓库一起第一次验收
      let coAcceptorId: number | null = null;
      if (!body.urgent) {
        if (!body.coAcceptorId) throw badRequest('请选一起验收的采购经办');
        if (body.coAcceptorId === actor.id) throw badRequest('一起验收的采购要另一个人，不能选自己');
        const [co] = await db<{ active: boolean; role: string; duties: string[] }[]>`
          SELECT active, role, duties FROM staff WHERE id = ${body.coAcceptorId}`;
        if (!co || !co.active || (co.role !== 'owner' && !co.duties.includes('purchase'))) {
          throw unprocessable('CO_ACCEPTOR_INVALID', '一起验收的人要是在职的采购经办');
        }
        coAcceptorId = body.coAcceptorId;
      }
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
          const got = received.get(pl.id) ?? 0;
          const remaining = receiptRoom(m, pl.baseQtyMilli, got, settings.weighTolerancePct);
          if (l.acceptedMilli > remaining) {
            throw unprocessable('RECEIPT_EXCEEDS_ORDER', receiptExceedsMessage(m, pl.inventoryUnit, pl.baseQtyMilli, got, remaining, settings.weighTolerancePct), {
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
      if (body.urgent && amount > settings.urgentCapCents) {
        throw unprocessable('URGENT_OVER_CAP', `急采合计 ¥${(amount / 100).toFixed(2)} 超过上限 ${capText}，请先开采购单`, {
          amountCents: amount,
          capCents: settings.urgentCapCents,
        });
      }
      return {
        ...empty,
        supplierId: body.supplierId,
        purchaseOrderId: body.purchaseOrderId,
        handler: body.handler,
        amountCents: amount,
        noPo: !body.purchaseOrderId,
        priceBasis,
        urgent: body.urgent,
        urgentCapCents: body.urgent ? settings.urgentCapCents : null,
        coAcceptorId,
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
                                 amount_cents, po_line_id, book_milli, counted_milli, book_move_id, source_line_id, note, diff_reason, diff_note)
      VALUES (${docId}, ${i + 1}, ${l.materialId}, ${l.qtyMilli}, ${l.inventoryUnit}, ${l.purchaseUnit}, ${l.factorMilli},
              ${l.enteredQtyMilli}, ${l.enteredUnit}, ${l.deliveredMilli}, ${l.rejectedMilli}, ${l.rejectReason}, ${l.priceCents},
              ${l.amountCents}, ${l.poLineId}, ${l.bookMilli}, ${l.countedMilli}, ${l.bookMoveId}, ${l.sourceLineId}, ${l.note},
              ${l.diffReason ?? null}, ${l.diffNote ?? ''})`;
  }
}

// ───────────────────────── 生效 ─────────────────────────

/**
 * 单据金额（#18 免确认门槛用）：有金额的按金额；期初、报损没有价格，按物料参考价估算；有一行没有参考价返回 null（照旧要确认）。
 */
async function approvalAmount(db: Db, docId: number): Promise<number | null> {
  const lines = await db<{ qtyMilli: number; factorMilli: number; amountCents: number | null; refPriceCents: number | null }[]>`
    SELECT l.qty_milli, l.factor_milli, l.amount_cents, m.ref_price_cents
    FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id WHERE l.doc_id = ${docId}`;
  let total = 0;
  for (const l of lines) {
    if (l.amountCents !== null) total += l.amountCents;
    else if (l.refPriceCents !== null) total += lineAmountCents(Math.abs(l.qtyMilli), l.refPriceCents, l.factorMilli);
    else return null;
  }
  return total;
}

/** 盘点单里的「大差异」行（v0.7.30，A8）：差异超过账面的 2% 或差异金额超过 ¥500（「库存规则」里可改） */
async function bigCountLines(db: Db, docId: number) {
  const settings = await loadInventorySettings(db);
  const lines = await db<{ id: number; name: string; qtyMilli: number; bookMilli: number | null; factorMilli: number; refPriceCents: number | null; diffReason: string | null; diffNote: string }[]>`
    SELECT l.id, m.name, l.qty_milli, l.book_milli, l.factor_milli, m.ref_price_cents, l.diff_reason, l.diff_note
    FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id WHERE l.doc_id = ${docId} AND l.qty_milli <> 0 ORDER BY l.line_no`;
  return lines.filter((l) =>
    isBigVariance(Number(l.bookMilli ?? 0), l.qtyMilli, l.refPriceCents === null ? null : lineAmountCents(Math.abs(l.qtyMilli), Number(l.refPriceCents), l.factorMilli), settings),
  );
}

/** 有大差异的行，提交时必须写原因类别与说明（v0.7.30，A8；COUNT_REASON_REQUIRED） */
async function assertCountReasons(db: Db, docId: number) {
  const missing = (await bigCountLines(db, docId)).filter((l) => !l.diffReason || l.diffReason === 'pending' || l.diffNote.trim().length < 2);
  if (missing.length === 0) return;
  const settings = await loadInventorySettings(db);
  throw unprocessable(
    'COUNT_REASON_REQUIRED',
    `「${missing.map((l) => l.name).join('、')}」是大差异（超过账面的 ${settings.countBigPct}% 或差异金额超过 ¥${(settings.countBigCents / 100).toFixed(0)}），请选原因类别并写说明（至少 2 个字）`,
    { lineIds: missing.map((l) => Number(l.id)) },
  );
}

async function countHasDiffs(db: Db, docId: number): Promise<boolean> {
  const [row] = await db<{ diffs: number }[]>`SELECT count(*) AS diffs FROM inv_doc_lines WHERE doc_id = ${docId} AND qty_milli <> 0`;
  return (row?.diffs ?? 0) > 0;
}

async function needsApproval(db: Db, docId: number, type: InvDocType, doc?: { warehouseId: number | null; urgent: boolean }): Promise<boolean> {
  const settings = await loadInventorySettings(db);
  const rules = settings.approvalRules;
  // 急采：仓库到部门验收、确认后才生效（#19）
  if (type === 'receipt' && doc?.urgent) return true;
  // 部门小仓的盘点差异由部门自己管：提交即生效（#17，待确认）；有「大差异」行的要审批（v0.7.30，A8）
  if (type === 'count' && doc?.warehouseId && doc.warehouseId !== CENTRAL_WAREHOUSE_ID) return (await bigCountLines(db, docId)).length > 0;
  switch (type) {
    // #18：设为需要确认的单据，金额不超过免确认门槛的提交即生效（v0.7.12）
    case 'opening':
      return rules.opening && overThreshold(settings, await approvalAmount(db, docId));
    case 'damage':
      return rules.damage && overThreshold(settings, await approvalAmount(db, docId));
    case 'supplier_return':
      return rules.supplier_return && overThreshold(settings, await approvalAmount(db, docId));
    case 'count':
      // 没有差异的盘点不需要调整，直接生效
      return countHasDiffs(db, docId);
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
  diffReason: CountReason | 'pending' | null;
}

/** 让单据生效：写库存流水（与应付流水），状态改为已生效。调用方已锁定单据行。 */
async function confirmDoc(tx: Tx, doc: DocRow & { docNo: string; amountCents: number }, actor: Actor, opts: { countReasons?: Record<string, CountReason> } = {}) {
  const lines = await tx<LineRow[]>`
    SELECT id, material_id, qty_milli, amount_cents, po_line_id, source_line_id, book_move_id, diff_reason
    FROM inv_doc_lines WHERE doc_id = ${doc.id} ORDER BY line_no`;

  // 锁顺序：原单 / 采购单 → 物料（与其他单据一致，避免死锁）
  if (doc.sourceDocId) {
    const [src] = await tx<{ status: string; warehouseId: number | null }[]>`SELECT status, warehouse_id FROM inv_docs WHERE id = ${doc.sourceDocId} FOR UPDATE`;
    if (src?.status !== 'confirmed') throw conflict('SOURCE_NOT_CONFIRMED', '原单已冲销或未生效，不能继续');
    // 领料退回、退供应商动的仓跟原单走（迁移前的领料没进部门小仓，退回只进总仓）
    if ((src.warehouseId ?? null) !== (doc.warehouseId ?? null)) {
      throw conflict('SOURCE_WAREHOUSE_MISMATCH', '这张单与原单不在同一个仓，请撤回后按原单重新登记');
    }
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
  // v0.7.11 两级库存：这张单动的仓（迁移前的领料、退回为空，只动总仓）
  const wh = doc.warehouseId === null ? null : await warehouseRef(tx, doc.warehouseId);
  const whId = wh?.id ?? CENTRAL_WAREHOUSE_ID;
  const isDept = whId !== CENTRAL_WAREHOUSE_ID;
  if (isDept) await lockDeptWarehouse(tx, whId);
  const ref = (l: LineRow, moveType: Parameters<typeof applyMove>[3]['moveType'], warehouseId = whId) => ({
    moveType,
    docId: doc.id,
    lineId: l.id,
    docDate: doc.docDate,
    operatorId: actor.id,
    warehouseId,
    warehouseName: warehouseId === CENTRAL_WAREHOUSE_ID ? '总仓' : wh?.name,
  });
  const assertEnough = async (warehouseId: number, outs: { materialId: number; qtyMilli: number }[]) => {
    if (warehouseId === CENTRAL_WAREHOUSE_ID) assertEnoughStock(mats, outs);
    else await assertEnoughDeptStock(tx, warehouseId, wh?.name ?? '部门小仓', mats, outs);
  };
  // 台面日耗品（#14，v0.7.13）：部门小仓不登记它的期初、耗用、报损、盘点，也不能退回（物料可能在单据提交后才改成台面日耗品）
  if (isDept && ['opening', 'direct_use', 'damage', 'count'].includes(doc.docType)) assertNoCounterUse(mats, 'dept', 'confirm');
  if (doc.docType === 'issue_return' && isDept) assertNoCounterUse(mats, 'return', 'confirm');
  /** 领料、急采进部门小仓的台面日耗品，在同一张单里接着记一笔部门小仓的「耗用」流水，结存回到 0 */
  const consumeCounterUse = async (ls: LineRow[]) => {
    for (const l of ls) {
      const m = mats.get(l.materialId)!;
      if (m.counterUse && l.qtyMilli > 0) await applyMove(tx, m, -l.qtyMilli, ref(l, 'direct_use', whId));
    }
  };
  // 收货与退货记下结算方式（v0.7.7）：挂账记应付；现付的货款走费用报销，不记应付
  let settlement: SupplierSettlement | null = null;
  // 退供应商：扣款抵了原收货单多少（v0.7.12）
  let returnApplied: number | null = null;

  switch (doc.docType) {
    case 'opening': {
      // 每个仓每个物料只能建一次期初（这个仓已有流水或结存时用盘点调整）
      const dept = isDept ? await deptBalances(tx, whId, lines.map((l) => l.materialId)) : null;
      for (const l of lines) {
        const [other] = await tx<{ count: number }[]>`
          SELECT count(*) AS count FROM stock_moves sm JOIN inv_docs d ON d.id = sm.doc_id
          WHERE sm.material_id = ${l.materialId} AND sm.warehouse_id = ${whId} AND NOT (d.doc_type = 'opening' AND d.status = 'voided')`;
        const m = mats.get(l.materialId)!;
        const balance = dept ? dept.get(l.materialId)!.stockMilli : m.stockMilli;
        if ((other?.count ?? 0) > 0 || balance !== 0) {
          throw conflict('OPENING_EXISTS', `「${m.name}」在${isDept ? wh!.name : '总仓'}已有库存记录，不能再建期初；请用盘点调整`);
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
        const { weighTolerancePct } = await loadInventorySettings(tx);
        for (const l of lines) {
          const m = mats.get(l.materialId)!;
          const orderedMilli = ordered.get(l.poLineId!) ?? 0;
          const got = received.get(l.poLineId!) ?? 0;
          const remaining = receiptRoom(m, orderedMilli, got, weighTolerancePct);
          if (l.qtyMilli > remaining) {
            throw conflict('RECEIPT_EXCEEDS_ORDER', receiptExceedsMessage(m, m.inventoryUnit, orderedMilli, got, remaining, weighTolerancePct));
          }
        }
      }
      if (doc.urgent) {
        // 急采：仓库确认时按当时的上限再核对一次（#19）
        const cap = (await loadInventorySettings(tx)).urgentCapCents;
        if (doc.amountCents > cap) {
          throw conflict('URGENT_OVER_CAP', `急采合计 ¥${(doc.amountCents / 100).toFixed(2)} 超过现在的上限 ¥${(cap / 100).toFixed(2)}，请退回部门改开采购单`);
        }
      }
      // 按采购单收货进总仓；急采进部门小仓
      for (const l of lines) await applyMove(tx, mats.get(l.materialId)!, l.qtyMilli, ref(l, 'receipt'));
      // 急采的台面日耗品：进部门小仓即算耗用（#14，v0.7.13）
      if (isDept) await consumeCounterUse(lines);
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
    case 'issue': {
      // 领料（#13、#17）：总仓出、部门小仓进；迁移前的领料（没有仓）只出总仓
      assertEnoughStock(mats, lines);
      for (const l of lines) {
        await applyMove(tx, mats.get(l.materialId)!, -l.qtyMilli, ref(l, 'issue', CENTRAL_WAREHOUSE_ID));
        if (wh) await applyMove(tx, mats.get(l.materialId)!, l.qtyMilli, ref(l, 'issue', wh.id));
      }
      // 台面日耗品：领到部门即算耗用（#14，v0.7.13）；迁移前的领料没有仓，不动
      if (wh) await consumeCounterUse(lines);
      break;
    }
    case 'direct_use':
    case 'damage': {
      await assertEnough(whId, lines);
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
        // 退回：部门小仓出、总仓进；迁移前的领料没进部门小仓，退回只进总仓
        if (wh) await assertEnough(wh.id, lines);
        for (const l of lines) {
          if (wh) await applyMove(tx, mats.get(l.materialId)!, -l.qtyMilli, ref(l, 'issue_return', wh.id));
          await applyMove(tx, mats.get(l.materialId)!, l.qtyMilli, ref(l, 'issue_return', CENTRAL_WAREHOUSE_ID));
        }
      } else {
        // 退供应商：从原收货单的仓出（急采的从部门小仓出）
        await assertEnough(whId, lines);
        for (const l of lines) await applyMove(tx, mats.get(l.materialId)!, -l.qtyMilli, ref(l, 'supplier_return'));
        // 退货跟着原收货单的结算方式：现付的收货没记应付，退货也不记应付扣款（供应商退款在 RQ-002 做）
        const [src] = await tx<{ settlement: SupplierSettlement | null }[]>`SELECT settlement FROM inv_docs WHERE id = ${doc.sourceDocId}`;
        settlement = src?.settlement ?? 'credit';
        if (doc.amountCents > 0 && settlement === 'credit') {
          await tx`
            INSERT INTO ap_entries (supplier_id, entry_type, amount_delta_cents, inv_doc_id, entry_date, operator_id)
            VALUES (${doc.supplierId}, 'supplier_return', ${-doc.amountCents}, ${doc.id}, ${doc.docDate}, ${actor.id})`;
          // 先抵原收货单还没付、也没在待确认付款里的部分（原单已在上面锁住，与付款、核销串行）；多出来的是退货余额（#20、#25）
          const [open] = await tx<{ openCents: number }[]>`
            SELECT x.amount_cents
              - coalesce((SELECT sum(r.return_applied_cents) FROM inv_docs r
                          WHERE r.source_doc_id = x.id AND r.doc_type = 'supplier_return' AND r.status = 'confirmed' AND r.id <> ${doc.id}), 0)
              - coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                          WHERE pa.receipt_doc_id = x.id AND p.status IN ('confirmed', 'submitted')), 0)
              - coalesce((SELECT sum(ol.amount_cents) FROM ap_offset_lines ol JOIN ap_offsets o ON o.id = ol.offset_id
                          WHERE ol.receipt_doc_id = x.id AND o.status = 'confirmed'), 0) AS open_cents
            FROM inv_docs x WHERE x.id = ${doc.sourceDocId}`;
          returnApplied = Math.max(0, Math.min(doc.amountCents, open?.openCents ?? 0));
        } else {
          // 现付供应商的退货不记应付，整笔等供应商退款；金额为 0 的没有可退的
          returnApplied = 0;
        }
      }
      break;
    }
    case 'count': {
      // 记下账面数之后又有收发：不能用旧盘点结果覆盖新变动，需要重新核对（按盘点的仓）
      const dept = isDept ? await deptBalances(tx, whId, lines.map((l) => l.materialId)) : null;
      const lastMove = (mid: number) => (dept ? dept.get(mid)!.lastMoveId : mats.get(mid)!.lastMoveId);
      const stale = lines.filter((l) => l.bookMoveId !== lastMove(l.materialId));
      if (stale.length > 0) {
        throw conflict('COUNT_STALE', `盘点后又有收发：${stale.map((l) => mats.get(l.materialId)!.name).join('、')}，请重新核对账面数后再确认`, {
          materialIds: stale.map((l) => l.materialId),
        });
      }
      for (const l of lines) {
        if (l.qtyMilli === 0) continue;
        // 确认时选的原因 → 提交时写的原因（v0.7.30）→ 部门小仓的差异默认算「耗用」（客用、日耗品用掉的），总仓默认「不明差异」
        const submitted = l.diffReason && l.diffReason !== 'pending' ? l.diffReason : null;
        const reason = opts.countReasons?.[String(l.id)] ?? submitted ?? (isDept ? 'consumed' : 'unknown');
        await tx`UPDATE inv_doc_lines SET diff_reason = ${reason} WHERE id = ${l.id}`;
        await applyMove(tx, mats.get(l.materialId)!, l.qtyMilli, ref(l, 'count_adjust'));
      }
      break;
    }
  }

  await tx`
    UPDATE inv_docs SET status = 'confirmed', confirmed_by = ${actor.id}, confirmed_at = now(), settlement = ${settlement},
           return_applied_cents = coalesce(${returnApplied}::bigint, return_applied_cents),
           submitted_by = coalesce(submitted_by, ${actor.id}), submitted_at = coalesce(submitted_at, now()), updated_at = now()
    WHERE id = ${doc.id}`;
}

async function lockDoc(tx: Tx, docId: number) {
  const [doc] = await tx<(DocRow & { docNo: string; amountCents: number })[]>`
    SELECT id, doc_no, doc_type, status, doc_date, supplier_id, purchase_order_id, department_id, source_doc_id,
           warehouse_id, urgent, urgent_approved_at, amount_cents, created_by, submitted_by, supplier_answer_date
    FROM inv_docs WHERE id = ${docId} FOR UPDATE`;
  if (!doc) throw notFound('单据不存在');
  return doc;
}

/**
 * 提交：不需要确认的单据直接生效；需要确认时进入待确认，提交人有确认权限且选择 approveNow 时一并确认。
 * v0.7.30 起报损、退供应商、期初、盘点走审批中心：命中审批规则的按规则的审批链，没有命中按现在的开关与门槛（默认规则）。
 */
async function submitLocked(tx: Tx, doc: DocRow & { docNo: string; amountCents: number }, actor: Actor, approveNow: boolean, timeZone: string) {
  if (doc.status === 'submitted' || doc.status === 'awaiting_supplier' || doc.status === 'confirmed') return; // 幂等
  if (doc.status !== 'draft' && doc.status !== 'returned') throw conflict('INVALID_STATE', '单据当前状态不能提交');
  if (doc.urgent) {
    // 急采（8.0.1 采购组整改 05，CG05）：按金额分级审批（审批中心「急采」），批了以后仓库到部门验收才进小仓
    if (approveNow) throw badRequest('急采要按金额分级审批，不能提交时一并确认');
    const plan = await urgentPlan(tx, Number(doc.amountCents));
    await tx`
      UPDATE inv_docs SET status = 'submitted', submitted_by = ${actor.id}, submitted_at = now(), returned_reason = NULL, urgent_approved_at = NULL, updated_at = now()
      WHERE id = ${doc.id}`;
    await logApproval(tx, 'inv_doc', doc.id, 'submit', actor.id);
    const r = await submitForApproval(tx, 'inv_doc', doc.id, { actor, timeZone }, { fallback: true, defaultPlan: plan });
    if (r.outcome === 'effective') await tx`UPDATE inv_docs SET urgent_approved_at = now() WHERE id = ${doc.id}`;
    return;
  }
  if (doc.docType === 'count') {
    const whId = doc.warehouseId ?? CENTRAL_WAREHOUSE_ID;
    const stale = await tx<{ name: string }[]>`
      SELECT m.name FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id
      LEFT JOIN warehouse_stock ws ON ws.warehouse_id = ${whId} AND ws.material_id = l.material_id
      WHERE l.doc_id = ${doc.id}
        AND l.book_move_id IS DISTINCT FROM CASE WHEN ${whId !== CENTRAL_WAREHOUSE_ID} THEN ws.last_move_id ELSE m.last_move_id END`;
    if (stale.length) {
      throw conflict('COUNT_STALE', `盘点后又有收发：${stale.map((s) => s.name).join('、')}。请先「按最新账面重新核对」，确认实盘数后再提交`);
    }
    await assertCountReasons(tx, doc.id);
  }
  const approval = await needsApproval(tx, doc.id, doc.docType, doc);
  await tx`UPDATE inv_docs SET status = 'submitted', submitted_by = ${actor.id}, submitted_at = now(), returned_reason = NULL, updated_at = now() WHERE id = ${doc.id}`;
  await logApproval(tx, 'inv_doc', doc.id, 'submit', actor.id);
  if (inApprovalCenter(doc) && !(doc.docType === 'count' && !(await countHasDiffs(tx, doc.id)))) {
    // 没有差异的盘点不用调整，直接生效（不看审批规则）
    if (approveNow && !can(actor, 'inventory.approve')) throw forbidden('当前账号不能确认这类单据，请提交给负责人');
    const r = await submitForApproval(tx, 'inv_doc', doc.id, { actor, timeZone }, { fallback: approval, approveNow });
    if (r.outcome === 'effective') {
      await afterApproval(tx, { ...doc, status: 'submitted' }, actor);
      if (!r.skipped) await logApproval(tx, 'inv_doc', doc.id, 'approve', actor.id);
    }
  } else if (!approval) {
    await afterApproval(tx, { ...doc, status: 'submitted' }, actor);
  } else if (approveNow) {
    if (!can(actor, 'inventory.approve')) throw forbidden('当前账号不能确认这类单据，请提交给负责人');
    if (doc.urgent && actor.role !== 'owner') throw forbidden('急采要由另一个人（仓库）到部门验收后确认');
    await afterApproval(tx, { ...doc, status: 'submitted' }, actor);
    await logApproval(tx, 'inv_doc', doc.id, 'approve', actor.id);
  }
}

/** 不用确认或负责人确认之后：退供应商先等供应商同意（#20，v0.7.12），其他单据直接生效 */
async function afterApproval(tx: Tx, doc: DocRow & { docNo: string; amountCents: number }, actor: Actor, opts: { countReasons?: Record<string, CountReason> } = {}) {
  if (doc.docType === 'supplier_return') {
    // 原收货单还得有效；可退数量在供应商同意、真正出库时再核对一次
    const [src] = await tx<{ status: string }[]>`SELECT status FROM inv_docs WHERE id = ${doc.sourceDocId}`;
    if (src?.status !== 'confirmed') throw conflict('SOURCE_NOT_CONFIRMED', '原收货单已冲销或未生效，不能退货');
    await tx`UPDATE inv_docs SET status = 'awaiting_supplier', updated_at = now() WHERE id = ${doc.id}`;
    return;
  }
  await confirmDoc(tx, doc, actor, opts);
}

// ───────────────────────── 对外操作 ─────────────────────────


export async function createDoc(deps: Deps, raw: CreateDocInput, actor: Actor, ip?: string): Promise<{ doc: InvDoc; replayed: boolean }> {
  const meta = parse(CreateInput, raw);
  const body = parse(DocBody, raw);
  await assertCanOperate(deps.sql, actor, body.docType, await warehouseOfBody(deps.sql, body));
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
      await lockOpKey(tx, meta.clientKey);
      const existing = await findExisting(tx);
      if (existing) return { id: existing, replayed: true };
      const wh = await warehouseOfBody(tx, body);
      await assertCanOperate(tx, actor, body.docType, wh);
      const prepared = await prepare(tx, deps, body, null, wh, actor);
      const meta2 = INV_DOC_META[body.docType];
      const docNo = await nextDocNo(tx, `inv_${body.docType}`, meta2.prefix, body.docDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO inv_docs (doc_no, doc_type, status, doc_date, supplier_id, purchase_order_id, department_id, handler,
                              source_doc_id, note, amount_cents, no_po, price_basis, warehouse_id, urgent, urgent_cap_cents,
                              co_acceptor_id, client_key, created_by)
        VALUES (${docNo}, ${body.docType}, 'draft', ${body.docDate}, ${prepared.supplierId}, ${prepared.purchaseOrderId},
                ${prepared.departmentId}, ${prepared.handler}, ${prepared.sourceDocId}, ${body.note}, ${prepared.amountCents},
                ${prepared.noPo}, ${prepared.priceBasis}, ${prepared.warehouseId}, ${prepared.urgent}, ${prepared.urgentCapCents},
                ${prepared.coAcceptorId}, ${meta.clientKey}, ${actor.id})
        RETURNING id`;
      const newId = row!.id;
      await insertLines(tx, newId, prepared.lines);
      await tx`
        INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id)
        VALUES (${meta.clientKey}, 'inv_doc', ${requestHash}, ${newId}, ${actor.id})`;
      await logApproval(tx, 'inv_doc', newId, 'create', actor.id);
      if (meta.action === 'submit') {
        await submitLocked(tx, await lockDoc(tx, newId), actor, meta.approveNow, deps.config.timezone);
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
  return { doc: await getDoc(deps.sql, docId, deps.config.timezone), replayed };
}

export async function updateDoc(deps: Deps, docId: number, raw: DocBodyInput & { action?: 'save' | 'submit'; approveNow?: boolean }, actor: Actor) {
  const body = parse(DocBody, raw);
  const meta = parse(CreateInput.omit({ clientKey: true }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    if (doc.docType !== body.docType) throw badRequest('不能更改单据类型');
    // 原单的仓与改后的仓都要有权限（不能借改单把单据挪到别的部门小仓）
    await assertCanOperate(tx, actor, doc.docType, await warehouseRef(tx, doc.warehouseId));
    const wh = await warehouseOfBody(tx, body);
    await assertCanOperate(tx, actor, body.docType, wh);
    if (doc.status !== 'draft' && doc.status !== 'returned') throw conflict('INVALID_STATE', '只有草稿或退回修改的单据可以编辑');
    const existingLines = await tx<{ materialId: number; bookMilli: number | null; bookMoveId: number | null }[]>`
      SELECT material_id, book_milli, book_move_id FROM inv_doc_lines WHERE doc_id = ${docId}`;
    // 盘点换了仓：原来记下的账面不能沿用
    const keepBook = (doc.warehouseId ?? CENTRAL_WAREHOUSE_ID) === (wh?.id ?? CENTRAL_WAREHOUSE_ID);
    const prepared = await prepare(tx, deps, body, keepBook ? { id: docId, lines: existingLines } : { id: docId, lines: [] }, wh, actor);
    await tx`
      UPDATE inv_docs SET doc_date = ${body.docDate}, supplier_id = ${prepared.supplierId}, purchase_order_id = ${prepared.purchaseOrderId},
             department_id = ${prepared.departmentId}, handler = ${prepared.handler}, source_doc_id = ${prepared.sourceDocId},
             note = ${body.note}, amount_cents = ${prepared.amountCents}, no_po = ${prepared.noPo}, price_basis = ${prepared.priceBasis},
             warehouse_id = ${prepared.warehouseId}, urgent = ${prepared.urgent}, urgent_cap_cents = ${prepared.urgentCapCents},
             co_acceptor_id = ${prepared.coAcceptorId}, updated_at = now()
      WHERE id = ${docId}`;
    await insertLines(tx, docId, prepared.lines);
    if (meta.action === 'submit') await submitLocked(tx, await lockDoc(tx, docId), actor, meta.approveNow, deps.config.timezone);
  });
  return getDoc(deps.sql, docId, deps.config.timezone);
}

export async function submitDoc(deps: Deps, docId: number, actor: Actor, approveNow = false) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    await assertCanOperate(tx, actor, doc.docType, await warehouseRef(tx, doc.warehouseId));
    await submitLocked(tx, doc, actor, approveNow, deps.config.timezone);
  });
  return getDoc(deps.sql, docId, deps.config.timezone);
}

/** 同意（v0.7.30 起报损、退供应商、期初、盘点走审批中心）：同意的是当前这一级，最后一级同意后照旧生效 */
export async function approveDoc(deps: Deps, docId: number, raw: unknown, actor: Actor) {
  const { countReasons, comment, ...fence } = parse(ApproveInput, raw ?? {});
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    if (doc.status === 'confirmed' || doc.status === 'awaiting_supplier') return; // 幂等
    if (doc.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的单据可以确认');
    if (doc.urgent && doc.createdBy === actor.id && actor.role !== 'owner') throw forbidden('登记急采的人不能审自己的急采');
    if (doc.urgent) {
      // 急采（8.0.1，CG05）：这里是审批中心按金额分级的审批；批了以后还要仓库到部门验收（verifyUrgent）才进小仓
      if (doc.urgentApprovedAt) return; // 已经批过、等验收（幂等）
      const step = await approveCurrent(tx, 'inv_doc', docId, { actor, timeZone: deps.config.timezone }, { ...fence, comment });
      if (step !== 'final') return;
      await tx`UPDATE inv_docs SET urgent_approved_at = now(), updated_at = now() WHERE id = ${docId}`;
      await logApproval(tx, 'inv_doc', docId, 'approve', actor.id, comment || '急采审批通过，等仓库到部门验收');
      return;
    }
    if (inApprovalCenter(doc)) {
      const step = await approveCurrent(tx, 'inv_doc', docId, { actor, timeZone: deps.config.timezone }, { ...fence, comment });
      if (step !== 'final') return;
    }
    await afterApproval(tx, doc, actor, { countReasons });
    await logApproval(tx, 'inv_doc', docId, 'approve', actor.id, comment);
  });
  return getDoc(deps.sql, docId, deps.config.timezone);
}

/** 负责人退回修改：说明原因，提交人改后可再提交 */
export async function returnDoc(deps: Deps, docId: number, raw: unknown, actor: Actor) {
  const { reason, ...fence } = parse(ReturnInput, raw);
  await deps.sql.begin(async (tx) => {
    const doc = await lockDoc(tx, docId);
    if (doc.status === 'returned') return;
    if (doc.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的单据可以退回');
    // 急采（8.0.1）：还在审批中的按审批中心退回；批了、等验收的由负责人退回，改了再提交要重新审批
    if (inApprovalCenter(doc) || (doc.urgent && !doc.urgentApprovedAt)) {
      await returnCurrent(tx, 'inv_doc', docId, { actor, timeZone: deps.config.timezone }, { ...fence, reason });
    }
    await tx`UPDATE inv_docs SET status = 'returned', returned_reason = ${reason}, urgent_approved_at = NULL, updated_at = now() WHERE id = ${docId}`;
    await logApproval(tx, 'inv_doc', docId, 'return', actor.id, reason);
  });
  return getDoc(deps.sql, docId, deps.config.timezone);
}

/** 撤回（作废未生效的单据）：经办人或负责人 */
export async function cancelDoc(deps: Deps, docId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(ReasonInput, raw);
  await deps.sql.begin(async (tx) => {
    const doc = await lockDoc(tx, docId);
    if (doc.status === 'cancelled') return;
    if (!['draft', 'submitted', 'returned', 'awaiting_supplier'].includes(doc.status)) throw conflict('INVALID_STATE', '已生效的单据不能撤回，只能冲销');
    // 等供应商确认的退货：登记的人、负责人、能登记供应商答复的采购都可以撤回
    const mayCancelOthers = can(actor, 'inventory.approve') || (doc.status === 'awaiting_supplier' && can(actor, 'supplierReturn.answer'));
    if (!mayCancelOthers && doc.createdBy !== actor.id) throw forbidden('只能撤回自己创建的单据');
    await tx`UPDATE inv_docs SET status = 'cancelled', returned_reason = ${reason}, updated_at = now() WHERE id = ${docId}`;
    await closeApproval(tx, 'inv_doc', docId, actor);
    await logApproval(tx, 'inv_doc', docId, 'cancel', actor.id, reason);
  });
  return getDoc(deps.sql, docId, deps.config.timezone);
}

/**
 * 登记供应商对退货的答复（#20，v0.7.12）：同意 → 按同意的日期出库、扣款（单据生效）；不同意 → 撤回，库存不动。
 * 采购与供应商沟通（「登记供应商对退货的答复」，默认采购经办与店主）。
 */
export async function answerReturn(deps: Deps, docId: number, raw: unknown, actor: Actor) {
  const input = parse(AnswerInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    if (doc.docType !== 'supplier_return') throw badRequest('只有退供应商单要登记供应商的答复');
    if (input.agreed && doc.status === 'confirmed') return; // 幂等
    if (!input.agreed && doc.status === 'cancelled') return;
    if (doc.status !== 'awaiting_supplier') throw conflict('INVALID_STATE', '这张退货单不在「待供应商确认」，不能登记供应商的答复');
    if (input.agreed) {
      assertNotFuture(input.date, deps.config.timezone);
      if (input.date < doc.docDate) throw badRequest('供应商同意的日期不能早于退货单的日期');
      await tx`
        UPDATE inv_docs SET supplier_answer_by = ${actor.id}, supplier_answer_at = now(), supplier_answer_date = ${input.date},
               supplier_answer_note = ${input.note}, updated_at = now()
        WHERE id = ${docId}`;
      // 出库与扣款记在供应商同意的那天
      await confirmDoc(tx, { ...doc, docDate: input.date }, actor);
      await logApproval(tx, 'inv_doc', docId, 'supplier_agree', actor.id, input.note);
    } else {
      await tx`
        UPDATE inv_docs SET supplier_answer_by = ${actor.id}, supplier_answer_at = now(), supplier_answer_note = ${input.note},
               status = 'cancelled', returned_reason = ${`供应商不同意：${input.note}`}, updated_at = now()
        WHERE id = ${docId}`;
      await logApproval(tx, 'inv_doc', docId, 'supplier_reject', actor.id, input.note);
    }
  });
  return getDoc(deps.sql, docId, deps.config.timezone);
}

/** 冲销已生效的单据：按原流水反向记账，原单保留并标记已冲销 */
export async function voidDoc(deps: Deps, docId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(ReasonInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    if (doc.status === 'voided') return;
    // #21：当月发生的当月冲销完，跨月不能冲销；退供应商按供应商同意（生效）的日期算（v0.7.12）
    assertSameMonth(doc.docType === 'supplier_return' && doc.supplierAnswerDate ? doc.supplierAnswerDate : doc.docDate, deps.config.timezone);
    // 锁顺序：单据 → 采购单 → 物料；锁住采购单再查报销，与「按采购单报销」（采购单 → 报销单）串行
    if (doc.purchaseOrderId) await tx`SELECT id FROM purchase_orders WHERE id = ${doc.purchaseOrderId} FOR UPDATE`;
    const check = await voidability(tx, await getDoc(tx, docId), deps.config.timezone);
    if (!check.ok) throw conflict('NOT_VOIDABLE', check.reason ?? '这张单据不能冲销');
    const moves = await tx<{ materialId: number; docLineId: number; qtyDeltaMilli: number; warehouseId: number }[]>`
      SELECT material_id, doc_line_id, qty_delta_milli, warehouse_id FROM stock_moves WHERE doc_id = ${docId} AND move_type <> 'void' ORDER BY id DESC`;
    const mats = await lockMaterials(tx, moves.map((m) => m.materialId));
    const wh = await warehouseRef(tx, doc.warehouseId);
    // 部门停用后它的小仓已清空，不能再冲回去
    for (const w of [...new Set(moves.map((m) => m.warehouseId))].sort((a, b) => a - b)) await lockDeptWarehouse(tx, w);
    // 冲销流水记在冲销当天，原单日期不变；按日期汇总时原单与冲销分别出现在各自日期；各仓按原流水反向记。
    // 从最后一条往前冲（台面日耗品的领料：先冲部门小仓的自动耗用，再冲领料，部门小仓的结存不会先变负，v0.7.13）
    const voidDate = todayIn(deps.config.timezone);
    for (const mv of moves) {
      await applyMove(tx, mats.get(mv.materialId)!, -mv.qtyDeltaMilli, {
        moveType: 'void',
        docId,
        lineId: mv.docLineId,
        docDate: voidDate,
        operatorId: actor.id,
        warehouseId: mv.warehouseId,
        warehouseName: mv.warehouseId === CENTRAL_WAREHOUSE_ID ? '总仓' : wh?.name,
      });
    }
    // 台面日耗品（v0.7.13）：冲销不能让部门小仓留下结存——物料可能是这张单之后才改成台面日耗品的
    // （例如部门先耗用、清零后改成台面日耗品，再冲销那张耗用单）
    const counterTouched = [...new Set(moves.filter((mv) => mv.warehouseId !== CENTRAL_WAREHOUSE_ID && mats.get(mv.materialId)!.counterUse).map((mv) => `${mv.warehouseId}:${mv.materialId}`))];
    for (const key of counterTouched) {
      const [warehouseId, materialId] = key.split(':').map(Number) as [number, number];
      const [left] = await tx<{ stockMilli: number }[]>`
        SELECT stock_milli FROM warehouse_stock WHERE warehouse_id = ${warehouseId} AND material_id = ${materialId}`;
      if ((left?.stockMilli ?? 0) > 0) {
        const m = mats.get(materialId)!;
        throw conflict(
          'COUNTER_USE_NOT_ALLOWED',
          `「${m.name}」现在是台面日耗品，冲销这张单会让${wh?.id === warehouseId ? wh.name : '部门小仓'}留下结存；确实要冲销，请先在物料档案里取消「台面日耗品」，冲销后把结存登记耗用或退回总仓，再改回来`,
        );
      }
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
  return getDoc(deps.sql, docId, deps.config.timezone);
}

/** 盘点：对「账面已变动」的行，按最新账面重新记下账面数（实盘数保留，需员工再次核对） */
export async function refreshCountBook(deps: Deps, docId: number, actor: Actor) {
  await deps.sql.begin(async (tx) => {
    const doc = await lockDoc(tx, docId);
    await assertCanOperate(tx, actor, doc.docType, await warehouseRef(tx, doc.warehouseId));
    if (doc.docType !== 'count') throw badRequest('只有盘点单需要核对账面');
    if (doc.status !== 'draft' && doc.status !== 'returned') throw conflict('INVALID_STATE', '待确认的盘点单请由负责人退回后再重新核对');
    const whId = doc.warehouseId ?? CENTRAL_WAREHOUSE_ID;
    if (whId === CENTRAL_WAREHOUSE_ID) {
      await tx`
        UPDATE inv_doc_lines l SET book_milli = m.stock_milli, book_move_id = m.last_move_id,
               qty_milli = l.counted_milli - m.stock_milli
        FROM materials m
        WHERE l.doc_id = ${docId} AND m.id = l.material_id AND l.book_move_id IS DISTINCT FROM m.last_move_id`;
    } else {
      // 部门小仓的账面在 warehouse_stock（没有记录的算 0）
      await tx`
        UPDATE inv_doc_lines l SET book_milli = coalesce(ws.stock_milli, 0), book_move_id = ws.last_move_id,
               qty_milli = l.counted_milli - coalesce(ws.stock_milli, 0)
        FROM inv_doc_lines l2 LEFT JOIN warehouse_stock ws ON ws.warehouse_id = ${whId} AND ws.material_id = l2.material_id
        WHERE l.id = l2.id AND l.doc_id = ${docId} AND l.book_move_id IS DISTINCT FROM ws.last_move_id`;
    }
  });
  return getDoc(deps.sql, docId, deps.config.timezone);
}

/**
 * 部门签收领料（#17 第二次验收、确认签字）：本部门的部门申购（或店主）在自己的待办里签收；有差异写明，
 * 仓库据此做退回或盘点。领料单仓库登记即生效，签收只是记下部门确认，只能签一次。
 */
export async function signIssue(deps: Deps, docId: number, raw: unknown, actor: Actor) {
  const { note: signNote } = parse(z.object({ note: z.string().trim().max(200).default('') }), raw ?? {});
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    if (doc.docType !== 'issue') throw badRequest('只有领料单需要部门签收');
    const [cur] = await tx<{ signedAt: string | null }[]>`SELECT dept_signed_at AS signed_at FROM inv_docs WHERE id = ${docId}`;
    if (cur?.signedAt) return; // 幂等
    if (doc.status !== 'confirmed') throw conflict('INVALID_STATE', '领料单还没生效或已冲销，不能签收');
    if (doc.warehouseId === null) throw conflict('INVALID_STATE', '迁移前的领料没有进部门小仓，不用签收');
    if (!(await canOperateDept(tx, actor, doc.departmentId))) throw forbidden('只有领料部门的部门申购可以签收');
    await tx`
      UPDATE inv_docs SET dept_signed_by = ${actor.id}, dept_signed_at = now(), dept_sign_note = ${signNote}, updated_at = now()
      WHERE id = ${docId}`;
    await logApproval(tx, 'inv_doc', docId, 'sign', actor.id, signNote);
  });
  return getDoc(deps.sql, docId, deps.config.timezone);
}

/** 急采：仓库到部门验收、确认后才生效（#19）；物资经办或负责人确认，不能是登记的人 */
export async function verifyUrgent(deps: Deps, docId: number, actor: Actor) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const doc = await lockDoc(tx, docId);
    if (doc.docType !== 'receipt' || !doc.urgent) throw badRequest('只有急采需要仓库验收');
    if (doc.status === 'confirmed') return; // 幂等
    if (doc.status !== 'submitted') throw conflict('INVALID_STATE', '只有待验收的急采可以确认');
    if (!doc.urgentApprovedAt) throw conflict('URGENT_NOT_APPROVED', '这张急采还在审批中（按金额分级审批），批了以后才能验收');
    if (!can(actor, 'inventory.operate') && !can(actor, 'inventory.approve')) throw forbidden('急采要由仓库（物资经办）到部门验收后确认');
    if (doc.createdBy === actor.id && actor.role !== 'owner') throw forbidden('急采要由另一个人（仓库）验收，不能自己确认');
    await confirmDoc(tx, doc, actor);
    await logApproval(tx, 'inv_doc', docId, 'approve', actor.id, '仓库到部门验收');
  });
  return getDoc(deps.sql, docId, deps.config.timezone);
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
  status: z.string().max(32).optional(),
  from: docDateSchema.optional(),
  to: docDateSchema.optional(),
  materialId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  warehouseId: z.coerce.number().int().positive().optional(),
  unsigned: z.enum(['1']).optional(),
  urgent: z.enum(['1', '0']).optional(),
  q: z.string().trim().max(32).optional(),
});

export function registerDocRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const docId = (req: FastifyRequest) => parse(idParam, req.params).id;
  const typeOf = async (id: number) => {
    const [row] = await sql<{ docType: InvDocType; createdBy: number; warehouseId: number | null }[]>`
      SELECT doc_type, created_by, warehouse_id FROM inv_docs WHERE id = ${id}`;
    if (!row) throw notFound('单据不存在');
    return row;
  };

  app.get('/api/inventory/docs', { preHandler: guard('inventory.read') }, async (req) => {
    const q = parse(ListQuery, req.query);
    return listDocs(sql, { ...q, unsigned: q.unsigned === '1', urgent: q.urgent === undefined ? undefined : q.urgent === '1' });
  });
  app.get('/api/inventory/docs/by-key/:key', { preHandler: guard('inventory.read') }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid() }), req.params);
    const doc = await findDocByKey(sql, key);
    return doc ? { found: true, doc } : { found: false };
  });
  app.get('/api/inventory/docs/:id', { preHandler: guard('inventory.read') }, async (req) => getDoc(sql, docId(req), deps.config.timezone));
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
    const row = await typeOf(id);
    await assertCanOperate(sql, req.actor, row.docType, await warehouseRef(sql, row.warehouseId));
    return cancelDoc(deps, id, req.body, req.actor);
  });
  // #21：库存冲销由仓库或财务成本岗操作，只限当月（v0.7.11）
  app.post('/api/inventory/docs/:id/supplier-answer', { preHandler: guard('supplierReturn.answer') }, async (req) =>
    answerReturn(deps, docId(req), req.body, req.actor),
  );
  app.post('/api/inventory/docs/:id/void', { preHandler: guard('inventory.void') }, async (req) =>
    voidDoc(deps, docId(req), req.body, req.actor),
  );
  // 急采：仓库到部门验收后确认（#19）
  app.post('/api/inventory/docs/:id/verify-urgent', { preHandler: guard('inventory.read') }, async (req) => verifyUrgent(deps, docId(req), req.actor));
  app.post('/api/inventory/docs/:id/refresh-book', { preHandler: guard('inventory.operate') }, async (req) =>
    refreshCountBook(deps, docId(req), req.actor),
  );
}
