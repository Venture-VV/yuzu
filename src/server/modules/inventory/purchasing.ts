// 采购单：表达「准备买什么」。确认后才能按单收货；关键内容变化走改版（保留旧版本并重新确认）。
//
// 状态：草稿 → 待确认 →（负责人）已确认 → 已关闭；待确认可退回修改；未确认前可撤回。
// 已确认的采购单改供应商、数量或价格时，先存一份旧版本，再回到待确认。
// 先收货后补单：补单采购单确认后只关联原收货单，不再入库、不再形成应付。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '@shared/permissions';
import { MAX_LINE_IMAGES } from '@shared/requests';
import type { PoLine, PoRevision, PoStatus, PoSummary, PurchaseOrder, ReceivingState } from '@shared/purchasing';
import { fitsDecimals, formatQty, lineAmountCents, priceChangePercent, toBaseQty, toPurchaseQty } from '@shared/quantity';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { lockOpKey } from '../../lib/fences';
import { idParam, parse } from '../../lib/validate';
import {
  assertNotFuture,
  canOperateDept,
  docDateSchema,
  loadInventorySettings,
  logApproval,
  nextDocNo,
  overThreshold,
  priceBaseline,
  setTxTimeouts,
  todayIn,
  weighedCapMilli,
} from './common';
import { hashRequest } from '../../lib/idempotency';
import { ChannelKey, ChannelNote, loadPurchaseRules, resolveChannel, type ChannelColumns } from './purchase-rules';

// ───────────────────────── 输入 ─────────────────────────

const id = z.number().int().positive();

const LineInput = z.object({
  /** 已有明细行（修改 / 改版时） */
  id: id.nullable().default(null),
  materialId: id,
  purchaseQtyMilli: z.number('请填写数量').int().positive('数量必须大于 0').max(1_000_000_000_000),
  priceCents: z.number('请填写单价').int().nonnegative('单价不能为负数').max(100_000_000),
  note: z.string().trim().max(100).default(''),
  /** 规格（v0.7.8）：默认带物料档案的规格或需求单的详情 */
  spec: z.string().trim().max(80, '规格最多 80 个字').optional(),
  /** 图片（v0.7.8）：先上传拿到编号，每行最多 9 张。修改已有的行时不传规格、图片就保持原样 */
  imageIds: z.array(id).max(MAX_LINE_IMAGES, `每一行最多 ${MAX_LINE_IMAGES} 张图片`).optional(),
  /** 来自哪几行需求（v0.7.8，转采购单时带上；同一物料的几行需求可以合并成一行）。修改已有的行时不传就保持原样 */
  requestLineIds: z.array(id).max(50, '一行最多合并 50 行需求').optional(),
});

const PoBody = z.object({
  supplierId: id,
  orderDate: docDateSchema,
  expectedDate: docDateSchema.nullable().default(null),
  note: z.string().trim().max(200).default(''),
  /** 采购途径与途径说明（v0.7.29，E1）：新建不传按供应商的默认、再按采购规则的第一项；修改不传保持原样 */
  channel: ChannelKey.optional(),
  channelNote: ChannelNote.optional(),
  lines: z.array(LineInput).min(1, '请至少添加一项物料').max(100, '采购单最多 100 行'),
});
type PoBodyInput = z.input<typeof PoBody>;

const Meta = z.object({
  action: z.enum(['save', 'submit']).default('submit'),
  approveNow: z.boolean().default(false),
});
const CreateInput = Meta.extend({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') });
const ReasonInput = z.object({ reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200) });

// ───────────────────────── 读取 ─────────────────────────

function receivingOf(lines: { baseQtyMilli: number; receivedMilli: number }[]): ReceivingState {
  const received = lines.reduce((s, l) => s + l.receivedMilli, 0);
  if (received === 0) return 'none';
  return lines.every((l) => l.receivedMilli >= l.baseQtyMilli) ? 'full' : 'partial';
}

export async function getPo(db: Db, poId: number): Promise<PurchaseOrder> {
  const [po] = await db<(Omit<PurchaseOrder, 'channel'> & { supplierId: number; supplierName: string; backfillReceiptId: number | null; channelKey: string | null; channelLabel: string | null; channelNote: string })[]>`
    SELECT po.id, po.doc_no, po.status, po.order_date, po.expected_date, po.note, po.price_basis, po.revision, po.backfill,
           po.backfill_receipt_id, po.created_by, cb.display_name AS created_by_name, po.created_at,
           po.channel AS channel_key, po.channel_label, po.channel_note,
           ab.display_name AS approved_by_name, po.approved_at, po.returned_reason,
           clb.display_name AS closed_by_name, po.closed_at, po.close_reason, po.is_synthetic, po.total_cents,
           s.id AS supplier_id, s.name AS supplier_name
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    JOIN staff cb ON cb.id = po.created_by
    LEFT JOIN staff ab ON ab.id = po.approved_by
    LEFT JOIN staff clb ON clb.id = po.closed_by
    WHERE po.id = ${poId}`;
  if (!po) throw notFound('采购单不存在');

  const rawLines = await db<Omit<PoLine, 'compare'>[]>`
    SELECT pl.id, pl.line_no, pl.material_id, m.code AS material_code, m.name AS material_name, m.specification, m.decimals, m.weighed,
           pl.purchase_qty_milli, pl.purchase_unit, pl.inventory_unit, pl.factor_milli, pl.base_qty_milli,
           pl.price_cents, pl.amount_cents, pl.note, pl.spec,
           coalesce((SELECT json_agg(json_build_object('lineId', rl.id, 'requestId', r.id, 'requestNo', r.doc_no, 'departmentName', d.name,
                                                       'name', rl.name, 'qtyMilli', rl.qty_milli, 'unit', rl.unit) ORDER BY r.id, rl.line_no)
                     FROM purchase_order_line_requests x JOIN purchase_request_lines rl ON rl.id = x.request_line_id
                     JOIN purchase_requests r ON r.id = rl.request_id JOIN departments d ON d.id = r.department_id
                     WHERE x.po_line_id = pl.id), '[]'::json) AS requests,
           coalesce((SELECT json_agg(json_build_object('id', i.image_id, 'url', '/api/erp/images/' || i.image_id) ORDER BY i.sort_no)
                     FROM purchase_order_line_images i WHERE i.po_line_id = pl.id), '[]'::json) AS images,
           coalesce((SELECT sum(l.qty_milli) FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
                     WHERE l.po_line_id = pl.id AND d.status = 'confirmed'), 0) AS received_milli
    FROM purchase_order_lines pl JOIN materials m ON m.id = pl.material_id
    WHERE pl.po_id = ${poId} ORDER BY pl.line_no`;
  const lines: PoLine[] = [];
  for (const l of rawLines) {
    const base = await priceBaseline(
      db,
      { materialId: l.materialId, purchaseUnit: l.purchaseUnit, factorMilli: l.factorMilli, priceBasis: po.priceBasis },
      { onOrBefore: po.orderDate, excludePoId: po.id },
    );
    lines.push({ ...l, compare: { baseline: base, changePercent: base ? priceChangePercent(base.priceCents, l.priceCents) : null } });
  }

  const receipts = await db<PurchaseOrder['receipts']>`
    SELECT id, doc_no, doc_type, status, doc_date, amount_cents FROM inv_docs
    WHERE purchase_order_id = ${poId} AND doc_type = 'receipt' ORDER BY doc_date, id`;
  // 与应付未结清、供应商往来同一口径（v0.7.12）：退货只扣抵了本单收货的部分（return_applied_cents，现付的整笔），
  // 已付含付款核销与核销（预付款、退货余额）到本单收货的；没抵到的退货余额在供应商的可抵扣里，单列，不再从本单扣
  const [money] = await db<{ receivedCents: number; returnCreditCents: number; returnBalanceCents: number; paidCents: number }[]>`
    SELECT
      coalesce((SELECT sum(amount_cents) FROM inv_docs WHERE purchase_order_id = ${poId} AND doc_type = 'receipt' AND status = 'confirmed'), 0) AS received_cents,
      coalesce((SELECT sum(CASE WHEN r.settlement = 'cash' THEN r.amount_cents ELSE coalesce(r.return_applied_cents, r.amount_cents) END)
                FROM inv_docs r JOIN inv_docs src ON src.id = r.source_doc_id
                WHERE src.purchase_order_id = ${poId} AND r.doc_type = 'supplier_return' AND r.status = 'confirmed'), 0) AS return_credit_cents,
      -- 本单退货里还可以抵扣 / 退款的退货余额（挂账的，扣掉已核销、已退款的）
      coalesce((SELECT sum(r.amount_cents - coalesce(r.return_applied_cents, r.amount_cents)
                           - coalesce((SELECT sum(o.amount_cents) FROM ap_offsets o WHERE o.credit_return_id = r.id AND o.status = 'confirmed'), 0)
                           - coalesce((SELECT sum(f.amount_cents) FROM supplier_refunds f WHERE f.credit_return_id = r.id AND f.status = 'confirmed'), 0))
                FROM inv_docs r JOIN inv_docs src ON src.id = r.source_doc_id
                WHERE src.purchase_order_id = ${poId} AND r.doc_type = 'supplier_return' AND r.status = 'confirmed'
                  AND coalesce(r.settlement, 'credit') = 'credit'), 0) AS return_balance_cents,
      -- 已付含预付款、退货余额核销到这几张收货单的（v0.7.12）
      coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                JOIN inv_docs d ON d.id = pa.receipt_doc_id
                WHERE d.purchase_order_id = ${poId} AND p.status = 'confirmed'), 0)
      + coalesce((SELECT sum(ol.amount_cents) FROM ap_offset_lines ol JOIN ap_offsets o ON o.id = ol.offset_id
                  JOIN inv_docs d ON d.id = ol.receipt_doc_id
                  WHERE d.purchase_order_id = ${poId} AND o.status = 'confirmed'), 0) AS paid_cents`;
  const revisions = await db<PoRevision[]>`
    SELECT r.revision, s.display_name AS changed_by_name, r.changed_at, r.snapshot
    FROM purchase_order_revisions r JOIN staff s ON s.id = r.changed_by
    WHERE r.po_id = ${poId} ORDER BY r.revision DESC`;
  const approvals = await db<PurchaseOrder['approvals']>`
    SELECT a.id, a.action, s.display_name AS actor_name, a.reason, a.revision, a.created_at
    FROM approval_logs a JOIN staff s ON s.id = a.actor_id
    WHERE a.doc_kind = 'purchase_order' AND a.doc_id = ${poId} ORDER BY a.id`;
  const [backfillReceipt] = po.backfillReceiptId
    ? await db<PurchaseOrder['receipts']>`SELECT id, doc_no, doc_type, status, doc_date, amount_cents FROM inv_docs WHERE id = ${po.backfillReceiptId}`
    : [];

  const { supplierId, supplierName, backfillReceiptId: _b, channelKey, channelLabel, channelNote, ...rest } = po;
  return {
    ...rest,
    supplier: { id: supplierId, name: supplierName },
    channel: channelKey ? { key: channelKey, label: channelLabel ?? channelKey, note: channelNote } : null,
    backfillReceipt: backfillReceipt ?? null,
    lines,
    receiving: receivingOf(lines),
    receivedCents: money!.receivedCents,
    returnCreditCents: money!.returnCreditCents,
    returnBalanceCents: money!.returnBalanceCents,
    paidCents: money!.paidCents,
    unpaidCents: money!.receivedCents - money!.returnCreditCents - money!.paidCents,
    receipts,
    revisions,
    approvals,
  };
}

export async function listPos(db: Db, f: { status?: string; supplierId?: number; q?: string; open?: boolean }): Promise<PoSummary[]> {
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db<(Omit<PoSummary, 'receiving' | 'channel'> & { orderedMilli: number; receivedMilli: number; fullLines: number; channelKey: string | null; channelLabel: string | null; channelNote: string })[]>`
    SELECT po.id, po.doc_no, po.status, s.name AS supplier_name, po.supplier_id, po.order_date, po.expected_date, po.total_cents,
           po.revision, po.backfill, cb.display_name AS created_by_name, po.created_at,
           po.channel AS channel_key, po.channel_label, po.channel_note,
           (SELECT count(*) FROM purchase_order_lines WHERE po_id = po.id) AS line_count,
           coalesce((SELECT string_agg(m.name, '、' ORDER BY pl.line_no) FROM purchase_order_lines pl JOIN materials m ON m.id = pl.material_id
                     WHERE pl.po_id = po.id AND pl.line_no <= 3), '') AS summary,
           coalesce((SELECT sum(amount_cents) FROM inv_docs WHERE purchase_order_id = po.id AND doc_type = 'receipt' AND status = 'confirmed'), 0) AS received_cents,
           coalesce(rcv.received, 0) AS received_milli, coalesce(rcv.full_lines, 0) AS full_lines
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    JOIN staff cb ON cb.id = po.created_by
    LEFT JOIN LATERAL (
      SELECT sum(x.got) AS received, count(*) FILTER (WHERE x.got >= x.base_qty_milli) AS full_lines
      FROM (SELECT pl.base_qty_milli,
                   coalesce((SELECT sum(l.qty_milli) FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
                             WHERE l.po_line_id = pl.id AND d.status = 'confirmed'), 0) AS got
            FROM purchase_order_lines pl WHERE pl.po_id = po.id) x
    ) rcv ON true
    WHERE true
      ${f.status ? db`AND po.status = ${f.status}` : db``}
      ${f.supplierId ? db`AND po.supplier_id = ${f.supplierId}` : db``}
      ${f.open ? db`AND po.status = 'approved' AND NOT po.backfill` : db``}
      ${like ? db`AND (po.doc_no ILIKE ${like} OR s.name ILIKE ${like} OR po.note ILIKE ${like})` : db``}
    ORDER BY po.order_date DESC, po.id DESC
    LIMIT 300`;
  return rows.map(({ receivedMilli, fullLines, orderedMilli: _o, channelKey, channelLabel, channelNote, ...r }) => ({
    ...r,
    channel: channelKey ? { key: channelKey, label: channelLabel ?? channelKey, note: channelNote } : null,
    receiving: receivedMilli === 0 ? 'none' : fullLines >= r.lineCount ? 'full' : 'partial',
  }));
}

// ───────────────────────── 校验明细 ─────────────────────────

interface ExistingLine {
  id: number;
  lineNo: number;
  materialId: number;
  purchaseUnit: string;
  factorMilli: number;
  priceCents: number;
  /** 这一行现在的订购数量（库存单位） */
  baseQtyMilli: number;
  /** 已生效或在途收货占用的数量：不能改价、不能减到它以下（称重物料多到的除外，v0.7.13） */
  receivedMilli: number;
  /** 被任何收货明细引用过（含已撤回）：不能删除 */
  referenced: boolean;
  requestLineIds: number[];
  spec: string;
  imageIds: number[];
}

async function existingLines(db: Db, poId: number): Promise<Map<number, ExistingLine>> {
  const rows = await db<ExistingLine[]>`
    SELECT pl.id, pl.line_no, pl.material_id, pl.purchase_unit, pl.factor_milli, pl.price_cents, pl.base_qty_milli, pl.spec,
           coalesce((SELECT array_agg(i.image_id ORDER BY i.sort_no) FROM purchase_order_line_images i WHERE i.po_line_id = pl.id), '{}') AS image_ids,
           coalesce((SELECT array_agg(x.request_line_id ORDER BY x.request_line_id) FROM purchase_order_line_requests x WHERE x.po_line_id = pl.id), '{}') AS request_line_ids,
           coalesce((SELECT sum(l.qty_milli) FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
                     WHERE l.po_line_id = pl.id AND d.status IN ('confirmed', 'submitted', 'draft', 'returned')), 0) AS received_milli,
           EXISTS (SELECT 1 FROM inv_doc_lines WHERE po_line_id = pl.id) AS referenced
    FROM purchase_order_lines pl WHERE pl.po_id = ${poId}`;
  return new Map(rows.map((r) => [r.id, { ...r, imageIds: r.imageIds.map(Number), requestLineIds: r.requestLineIds.map(Number) }]));
}

interface PreparedLine {
  id: number | null;
  materialId: number;
  purchaseQtyMilli: number;
  purchaseUnit: string;
  inventoryUnit: string;
  factorMilli: number;
  baseQtyMilli: number;
  priceCents: number;
  amountCents: number;
  note: string;
  spec: string;
  imageIds: number[];
  requestLineIds: number[];
}

async function prepareLines(db: Db, body: z.infer<typeof PoBody>, existing: Map<number, ExistingLine>): Promise<PreparedLine[]> {
  const ids = [...new Set(body.lines.map((l) => l.materialId))];
  if (ids.length !== body.lines.length) throw badRequest('同一物料在一张采购单里只能出现一次');
  const mats = new Map(
    (
      await db<{ id: number; name: string; inventoryUnit: string; purchaseUnit: string; purchaseFactorMilli: number; decimals: number; tracked: boolean; active: boolean; weighed: boolean }[]>`
        SELECT id, name, inventory_unit, purchase_unit, purchase_factor_milli, decimals, tracked, active, weighed FROM materials WHERE id IN ${db(ids)}`
    ).map((m) => [m.id, m]),
  );
  const { weighTolerancePct } = await loadInventorySettings(db);
  return body.lines.map((l) => {
    const m = mats.get(l.materialId);
    if (!m) throw unprocessable('MATERIAL_NOT_FOUND', '有物料不存在，请刷新后重试');
    const prev = l.id ? existing.get(l.id) : undefined;
    if (l.id && !prev) throw unprocessable('PO_LINE_INVALID', '采购单明细已变化，请刷新后重试');
    if (!prev && (!m.tracked || !m.active)) throw unprocessable('MATERIAL_INACTIVE', `「${m.name}」已停用或不是受管物料`);
    // 已有明细沿用当时的采购单位与换算；新明细取物料当前包装
    const purchaseUnit = prev && prev.materialId === m.id ? prev.purchaseUnit : m.purchaseUnit;
    const factorMilli = prev && prev.materialId === m.id ? prev.factorMilli : m.purchaseFactorMilli;
    const base = toBaseQty(l.purchaseQtyMilli, factorMilli);
    if (base === null || !fitsDecimals(base, m.decimals)) {
      throw badRequest(`「${m.name}」的采购数量换算后不是整${m.inventoryUnit}，请调整数量`);
    }
    if (prev && prev.receivedMilli > 0) {
      if (prev.materialId !== m.id) throw unprocessable('PO_LINE_RECEIVED', `「${m.name}」所在行已有收货，不能更换物料`);
      // 称重物料按实际称重收货，可以比订购数量多出容差（v0.7.13）：数量没改的照旧；改了的，已收货不超过新数量加容差就行
      const weighedOk = m.weighed && (base === prev.baseQtyMilli || weighedCapMilli(base, weighTolerancePct) >= prev.receivedMilli);
      if (base < prev.receivedMilli && !weighedOk) {
        throw unprocessable('PO_QTY_BELOW_RECEIVED', `「${m.name}」已收货 ${formatQty(prev.receivedMilli)} ${m.inventoryUnit}，数量不能少于已收货`);
      }
      if (l.priceCents !== prev.priceCents) {
        throw unprocessable('PO_PRICE_LOCKED', `「${m.name}」已有收货，单价已随收货确认，不能再改`);
      }
    }
    return {
      id: l.id,
      materialId: m.id,
      purchaseQtyMilli: l.purchaseQtyMilli,
      purchaseUnit,
      inventoryUnit: m.inventoryUnit,
      factorMilli,
      baseQtyMilli: base,
      priceCents: l.priceCents,
      amountCents: lineAmountCents(base, l.priceCents, factorMilli),
      note: l.note,
      spec: l.spec ?? prev?.spec ?? '',
      imageIds: [...new Set(l.imageIds ?? prev?.imageIds ?? [])],
      // 不传就沿用原来的需求关联；新行按转采购单时带来的
      requestLineIds: [...new Set(l.requestLineIds ?? prev?.requestLineIds ?? [])],
    };
  });
}

/**
 * 转采购单（v0.7.8）：新关联的需求行要已通过、没被别的有效采购单（撤回的不算）占用；需求行选了物料的，采购单行的物料要一致。
 * 同一物料的几行需求（几个部门都要）可以合并成采购单的一行。锁需求单（id 升序）后再核对，同一行需求不会被两张采购单同时转走。
 * 加锁顺序：采购单 → 需求单。去掉关联（删行、撤回采购单）不需要审核权限，需求行回到「未下单」。
 */
async function checkRequestLinks(tx: Tx, poId: number | null, lines: PreparedLine[], existing: Map<number, ExistingLine>, actor: Actor) {
  const all = lines.flatMap((l) => l.requestLineIds);
  if (new Set(all).size !== all.length) throw badRequest('同一行需求在一张采购单里只能出现一次');
  if (all.length === 0) return;
  const before = new Set([...existing.values()].flatMap((l) => l.requestLineIds));
  const added = all.filter((r) => !before.has(r));
  if (added.length > 0) {
    if (!can(actor, 'request.review')) throw forbidden('当前账号不能把需求单转成采购单');
    await tx`
      SELECT r.id FROM purchase_requests r
      WHERE r.id IN (SELECT request_id FROM purchase_request_lines WHERE id IN ${tx(added)})
      ORDER BY r.id FOR UPDATE`;
  }
  const rows = await tx<{ id: number; name: string; materialId: number | null; status: string; docNo: string; takenBy: string | null }[]>`
    SELECT l.id, l.name, l.material_id, r.status, r.doc_no,
           (SELECT po.doc_no FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id
              JOIN purchase_orders po ON po.id = pl.po_id
             WHERE x.request_line_id = l.id AND po.status <> 'cancelled' ${poId ? tx`AND po.id <> ${poId}` : tx``} LIMIT 1) AS taken_by
    FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id
    WHERE l.id IN ${tx(all)}`;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const l of lines) {
    for (const rid of l.requestLineIds) {
      const r = byId.get(rid);
      if (!r) throw unprocessable('REQUEST_LINE_NOT_FOUND', '需求单的行不存在，请刷新后重试');
      if (r.materialId !== null && Number(r.materialId) !== l.materialId) throw unprocessable('REQUEST_MATERIAL_MISMATCH', `「${r.name}」的物料与需求单不一致`);
      if (before.has(rid)) continue;
      if (r.status !== 'approved') throw conflict('REQUEST_NOT_APPROVED', `需求单 ${r.docNo} 还没通过审核，不能转采购单`);
      if (r.takenBy) throw conflict('REQUEST_LINE_ORDERED', `「${r.name}」已经在采购单 ${r.takenBy} 里`, { docNo: r.takenBy });
    }
  }
}

/** 明细就地同步：已有行按 id 更新，删掉的行（无收货）删除，新行追加，保持收货对采购单行的引用 */
async function syncLines(tx: Tx, poId: number, lines: PreparedLine[], existing: Map<number, ExistingLine>) {
  const keep = new Set(lines.filter((l) => l.id).map((l) => l.id!));
  for (const prev of existing.values()) {
    if (keep.has(prev.id)) continue;
    if (prev.referenced) throw unprocessable('PO_LINE_RECEIVED', '已有收货记录的明细不能删除，可把数量改为已收货数量');
    await tx`DELETE FROM purchase_order_lines WHERE id = ${prev.id}`;
  }
  let nextNo = Math.max(0, ...[...existing.values()].map((l) => l.lineNo)) + 1;
  for (const l of lines) {
    if (l.id) {
      await tx`
        UPDATE purchase_order_lines SET material_id = ${l.materialId}, purchase_qty_milli = ${l.purchaseQtyMilli}, purchase_unit = ${l.purchaseUnit},
               inventory_unit = ${l.inventoryUnit}, factor_milli = ${l.factorMilli}, base_qty_milli = ${l.baseQtyMilli},
               price_cents = ${l.priceCents}, amount_cents = ${l.amountCents}, note = ${l.note}, spec = ${l.spec}
        WHERE id = ${l.id} AND po_id = ${poId}`;
      await syncLineImages(tx, l.id, l.imageIds);
      await syncLineRequests(tx, l.id, l.requestLineIds, existing.get(l.id)?.requestLineIds ?? []);
    } else {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO purchase_order_lines (po_id, line_no, material_id, purchase_qty_milli, purchase_unit, inventory_unit, factor_milli,
                                          base_qty_milli, price_cents, amount_cents, note, spec)
        VALUES (${poId}, ${nextNo++}, ${l.materialId}, ${l.purchaseQtyMilli}, ${l.purchaseUnit}, ${l.inventoryUnit}, ${l.factorMilli},
                ${l.baseQtyMilli}, ${l.priceCents}, ${l.amountCents}, ${l.note}, ${l.spec})
        RETURNING id`;
      await syncLineImages(tx, row!.id, l.imageIds);
      await syncLineRequests(tx, row!.id, l.requestLineIds, []);
    }
  }
  return lines.reduce((s, l) => s + l.amountCents, 0);
}

/** 采购单行的图片：按顺序整组替换（行在采购单改版时就地更新） */
async function syncLineImages(tx: Tx, poLineId: number, imageIds: number[]) {
  await tx`DELETE FROM purchase_order_line_images WHERE po_line_id = ${poLineId}`;
  let sort = 0;
  for (const imageId of imageIds) {
    sort += 1;
    await tx`INSERT INTO purchase_order_line_images (po_line_id, sort_no, image_id) VALUES (${poLineId}, ${sort}, ${imageId})`;
  }
}

/** 采购单行与需求行的关联：只增删有变化的 */
async function syncLineRequests(tx: Tx, poLineId: number, next: number[], prev: number[]) {
  const gone = prev.filter((r) => !next.includes(r));
  const fresh = next.filter((r) => !prev.includes(r));
  if (gone.length) await tx`DELETE FROM purchase_order_line_requests WHERE po_line_id = ${poLineId} AND request_line_id IN ${tx(gone)}`;
  for (const r of fresh) await tx`INSERT INTO purchase_order_line_requests (po_line_id, request_line_id) VALUES (${poLineId}, ${r})`;
}

/** 图片要先上传成功（拿到编号）才能挂到行上 */
async function checkImages(db: Db, lines: PreparedLine[]) {
  const ids = [...new Set(lines.flatMap((l) => l.imageIds))];
  if (ids.length === 0) return;
  const found = new Set((await db<{ id: number }[]>`SELECT id FROM erp_images WHERE id IN ${db(ids)}`).map((r) => Number(r.id)));
  if (ids.some((i) => !found.has(i))) throw unprocessable('IMAGE_NOT_FOUND', '有图片没有上传成功，请重新上传');
}

/** 供应商要在用；返回它的默认采购途径（v0.7.29） */
async function assertSupplier(db: Db, supplierId: number): Promise<{ defaultChannel: string | null }> {
  const [s] = await db<{ active: boolean; defaultChannel: string | null }[]>`SELECT active, default_channel FROM suppliers WHERE id = ${supplierId}`;
  if (!s || !s.active) throw unprocessable('SUPPLIER_INACTIVE', '供应商不存在或已停用');
  return { defaultChannel: s.defaultChannel };
}

// ───────────────────────── 状态流转 ─────────────────────────

interface PoRow {
  id: number;
  docNo: string;
  status: PoStatus;
  supplierId: number;
  revision: number;
  backfill: boolean;
  backfillReceiptId: number | null;
  createdBy: number;
}

async function lockPo(tx: Tx, poId: number): Promise<PoRow> {
  const [po] = await tx<PoRow[]>`
    SELECT id, doc_no, status, supplier_id, revision, backfill, backfill_receipt_id, created_by
    FROM purchase_orders WHERE id = ${poId} FOR UPDATE`;
  if (!po) throw notFound('采购单不存在');
  return po;
}

async function approveLocked(tx: Tx, po: PoRow, actor: Actor, reason = '') {
  if (po.backfill && po.backfillReceiptId) {
    // 补单：把原收货单关联到这张采购单。只建立关联，不新增库存流水或应付
    const [rc] = await tx<{ status: string; purchaseOrderId: number | null; supplierId: number }[]>`
      SELECT status, purchase_order_id, supplier_id FROM inv_docs WHERE id = ${po.backfillReceiptId} FOR UPDATE`;
    if (!rc || rc.status !== 'confirmed') throw conflict('BACKFILL_SOURCE_INVALID', '原收货单已冲销或未生效，不能补单');
    if (rc.purchaseOrderId) throw conflict('BACKFILL_LINKED', '原收货单已关联其他采购单');
    if (rc.supplierId !== po.supplierId) throw conflict('PO_SUPPLIER_MISMATCH', '补单供应商与原收货单不一致');
    const poLines = await tx<{ id: number; materialId: number; baseQtyMilli: number }[]>`
      SELECT id, material_id, base_qty_milli FROM purchase_order_lines WHERE po_id = ${po.id}`;
    const rcLines = await tx<{ id: number; materialId: number; qtyMilli: number }[]>`
      SELECT id, material_id, qty_milli FROM inv_doc_lines WHERE doc_id = ${po.backfillReceiptId}`;
    for (const r of rcLines) {
      const pl = poLines.find((p) => p.materialId === r.materialId);
      if (!pl || pl.baseQtyMilli < r.qtyMilli) throw conflict('BACKFILL_MISMATCH', '补单明细与原收货单不一致，请退回修改');
      await tx`UPDATE inv_doc_lines SET po_line_id = ${pl.id} WHERE id = ${r.id}`;
    }
    await tx`UPDATE inv_docs SET purchase_order_id = ${po.id}, updated_at = now() WHERE id = ${po.backfillReceiptId}`;
  }
  await tx`
    UPDATE purchase_orders SET status = 'approved', approved_by = ${actor.id}, approved_at = now(), returned_reason = NULL, updated_at = now()
    WHERE id = ${po.id}`;
  await logApproval(tx, 'purchase_order', po.id, 'approve', actor.id, reason, po.revision);
}

/** deptConfirm：急采的补单由本部门自己确认（#19，v0.7.11），不走负责人确认 */
async function submitLocked(tx: Tx, po: PoRow, actor: Actor, approveNow: boolean, deptConfirm = false) {
  if (po.status === 'submitted' || po.status === 'approved') return;
  if (po.status !== 'draft' && po.status !== 'returned') throw conflict('INVALID_STATE', '采购单当前状态不能提交');
  await tx`UPDATE purchase_orders SET status = 'submitted', submitted_by = ${actor.id}, submitted_at = now(), updated_at = now() WHERE id = ${po.id}`;
  await logApproval(tx, 'purchase_order', po.id, 'submit', actor.id, '', po.revision);
  const settings = await loadInventorySettings(tx);
  // #18：合计不超过免确认门槛的采购单提交即确认（v0.7.12）
  const [totals] = await tx<{ totalCents: number }[]>`SELECT total_cents FROM purchase_orders WHERE id = ${po.id}`;
  const totalCents = totals?.totalCents ?? null;
  if (deptConfirm) {
    await approveLocked(tx, { ...po, status: 'submitted' }, actor, '急采补单，部门确认');
  } else if (!(settings.approvalRules.purchase_order && overThreshold(settings, totalCents))) {
    await approveLocked(tx, { ...po, status: 'submitted' }, actor, settings.approvalRules.purchase_order ? '未超过免确认门槛，提交即确认' : '');
  } else if (approveNow) {
    if (!can(actor, 'inventory.approve')) throw forbidden('当前账号不能确认采购单，请提交给负责人');
    await approveLocked(tx, { ...po, status: 'submitted' }, actor);
  }
}


export async function createPo(deps: Deps, raw: unknown, actor: Actor, opts: { backfillReceiptId?: number; ip?: string; deptConfirm?: boolean } = {}) {
  const meta = parse(CreateInput, raw);
  const body = parse(PoBody, raw);
  if (meta.approveNow && !can(actor, 'inventory.approve')) throw forbidden('当前账号不能确认采购单，请提交给负责人');
  assertNotFuture(body.orderDate, deps.config.timezone);
  if (body.expectedDate && body.expectedDate < body.orderDate) throw badRequest('预计到货日期不能早于下单日期');
  const requestHash = hashRequest({ ...body, ...meta, clientKey: undefined, backfill: opts.backfillReceiptId ?? null, deptConfirm: !!opts.deptConfirm });
  const findExisting = async (db: Db) => {
    const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${meta.clientKey}`;
    if (!row) return null;
    if (row.opType !== 'purchase_order' || row.requestHash !== requestHash) {
      throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一张不同的单据，请刷新页面后重新填写');
    }
    return row.refId;
  };
  let poId: number;
  let replayed = false;
  try {
    const r = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, meta.clientKey);
      const existing = await findExisting(tx);
      if (existing) return { id: existing, replayed: true };
      const sup = await assertSupplier(tx, body.supplierId);
      const ch = resolveChannel(await loadPurchaseRules(tx), body, sup.defaultChannel);
      const lines = await prepareLines(tx, body, new Map());
      await checkRequestLinks(tx, null, lines, new Map(), actor);
      await checkImages(tx, lines);
      const settings = await loadInventorySettings(tx);
      const docNo = await nextDocNo(tx, 'purchase_order', 'CG', body.orderDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO purchase_orders (doc_no, supplier_id, status, order_date, expected_date, note, price_basis, backfill,
                                     backfill_receipt_id, client_key, created_by, channel, channel_label, channel_note)
        VALUES (${docNo}, ${body.supplierId}, 'draft', ${body.orderDate}, ${body.expectedDate}, ${body.note}, ${settings.priceBasis},
                ${!!opts.backfillReceiptId}, ${opts.backfillReceiptId ?? null}, ${meta.clientKey}, ${actor.id},
                ${ch.channel}, ${ch.channelLabel}, ${ch.channelNote})
        RETURNING id`;
      const newId = row!.id;
      const total = await syncLines(tx, newId, lines, new Map());
      await tx`UPDATE purchase_orders SET total_cents = ${total} WHERE id = ${newId}`;
      await tx`
        INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id)
        VALUES (${meta.clientKey}, 'purchase_order', ${requestHash}, ${newId}, ${actor.id})`;
      await logApproval(tx, 'purchase_order', newId, 'create', actor.id, '', 1);
      if (meta.action === 'submit') await submitLocked(tx, await lockPo(tx, newId), actor, meta.approveNow, opts.deptConfirm);
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'purchase_order',
        targetType: 'purchase_order',
        targetId: newId,
        detail: { docNo, action: meta.action, backfill: !!opts.backfillReceiptId, deptConfirm: !!opts.deptConfirm },
        ip: opts.ip,
      });
      return { id: newId, replayed: false };
    });
    poId = r.id;
    replayed = r.replayed;
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, 'purchase_orders_client_key_key')) {
      const existing = await findExisting(deps.sql);
      if (!existing) throw error;
      poId = existing;
      replayed = true;
    } else if (isUniqueViolation(error, 'purchase_orders_backfill_once')) {
      throw conflict('BACKFILL_EXISTS', '这张收货单已经有补单采购单');
    } else {
      throw error;
    }
  }
  return { po: await getPo(deps.sql, poId), replayed };
}

/** 修改时的采购途径：传了按传的；没传保持原样（旧单据没记的按供应商的默认带上） */
async function channelForUpdate(
  tx: Tx,
  poId: number,
  body: { channel?: string; channelNote?: string },
  supplierDefault: string | null,
): Promise<ChannelColumns> {
  const rules = await loadPurchaseRules(tx);
  if (body.channel !== undefined) return resolveChannel(rules, body, null);
  const [cur] = await tx<{ channel: string | null; channelLabel: string | null; channelNote: string }[]>`
    SELECT channel, channel_label, channel_note FROM purchase_orders WHERE id = ${poId}`;
  if (cur?.channel) return { channel: cur.channel, channelLabel: cur.channelLabel ?? cur.channel, channelNote: body.channelNote ?? cur.channelNote };
  return resolveChannel(rules, { channelNote: body.channelNote }, supplierDefault);
}

/** 修改草稿 / 退回的采购单；已确认的采购单改关键内容时走改版（revise = true） */
export async function updatePo(deps: Deps, poId: number, raw: PoBodyInput & { action?: 'save' | 'submit'; approveNow?: boolean }, actor: Actor, revise = false) {
  const body = parse(PoBody, raw);
  const meta = parse(Meta, raw);
  if (meta.approveNow && !can(actor, 'inventory.approve')) throw forbidden('当前账号不能确认采购单，请提交给负责人');
  assertNotFuture(body.orderDate, deps.config.timezone);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    let po = await lockPo(tx, poId);
    if (po.backfill) throw conflict('BACKFILL_LOCKED', '补单采购单按原收货单生成，不能修改；如有误请撤回后重新补单');
    const existing = await existingLines(tx, poId);
    const received = [...existing.values()].some((l) => l.receivedMilli > 0);
    if (revise) {
      if (po.status !== 'approved') throw conflict('INVALID_STATE', '只有已确认的采购单需要改版');
      if (received && body.supplierId !== po.supplierId) throw unprocessable('PO_SUPPLIER_LOCKED', '已有收货的采购单不能更换供应商');
      // 先保存当前版本，再回到待确认
      const snapshot = await getPo(tx, poId);
      await tx`
        INSERT INTO purchase_order_revisions (po_id, revision, snapshot, changed_by)
        VALUES (${poId}, ${po.revision}, ${tx.json({
          supplierName: snapshot.supplier.name,
          channel: snapshot.channel ? (snapshot.channel.note ? `${snapshot.channel.label} · ${snapshot.channel.note}` : snapshot.channel.label) : null,
          totalCents: snapshot.totalCents,
          lines: snapshot.lines.map((l) => ({ materialName: l.materialName, spec: l.spec, purchaseQtyMilli: l.purchaseQtyMilli, purchaseUnit: l.purchaseUnit, priceCents: l.priceCents, amountCents: l.amountCents, imageIds: l.images.map((i) => i.id) })),
        } as never)}, ${actor.id})`;
      await tx`UPDATE purchase_orders SET status = 'returned', revision = revision + 1, updated_at = now() WHERE id = ${poId}`;
      po = { ...po, status: 'returned', revision: po.revision + 1 };
      await logApproval(tx, 'purchase_order', poId, 'revise', actor.id, '', po.revision);
    } else if (po.status !== 'draft' && po.status !== 'returned') {
      throw conflict('INVALID_STATE', po.status === 'approved' ? '已确认的采购单请使用「改版」' : '采购单当前状态不能修改');
    }
    if (!revise && received && body.supplierId !== po.supplierId) throw unprocessable('PO_SUPPLIER_LOCKED', '已有收货的采购单不能更换供应商');
    const sup = await assertSupplier(tx, body.supplierId);
    const ch = await channelForUpdate(tx, poId, body, sup.defaultChannel);
    const lines = await prepareLines(tx, body, existing);
    await checkRequestLinks(tx, poId, lines, existing, actor);
    await checkImages(tx, lines);
    const total = await syncLines(tx, poId, lines, existing);
    await tx`
      UPDATE purchase_orders SET supplier_id = ${body.supplierId}, order_date = ${body.orderDate}, expected_date = ${body.expectedDate},
             note = ${body.note}, total_cents = ${total}, channel = ${ch.channel}, channel_label = ${ch.channelLabel},
             channel_note = ${ch.channelNote}, updated_at = now()
      WHERE id = ${poId}`;
    if (meta.action === 'submit' || revise) await submitLocked(tx, po, actor, meta.approveNow);
  });
  return getPo(deps.sql, poId);
}

export async function submitPo(deps: Deps, poId: number, actor: Actor, approveNow: boolean) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await submitLocked(tx, await lockPo(tx, poId), actor, approveNow);
  });
  return getPo(deps.sql, poId);
}

export async function approvePo(deps: Deps, poId: number, actor: Actor) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const po = await lockPo(tx, poId);
    if (po.status === 'approved') return;
    if (po.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的采购单可以确认');
    await approveLocked(tx, po, actor);
  });
  return getPo(deps.sql, poId);
}

export async function returnPo(deps: Deps, poId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(ReasonInput, raw);
  await deps.sql.begin(async (tx) => {
    const po = await lockPo(tx, poId);
    if (po.status === 'returned') return;
    if (po.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的采购单可以退回');
    await tx`UPDATE purchase_orders SET status = 'returned', returned_reason = ${reason}, updated_at = now() WHERE id = ${poId}`;
    await logApproval(tx, 'purchase_order', poId, 'return', actor.id, reason, po.revision);
  });
  return getPo(deps.sql, poId);
}

export async function cancelPo(deps: Deps, poId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(ReasonInput, raw);
  await deps.sql.begin(async (tx) => {
    const po = await lockPo(tx, poId);
    if (po.status === 'cancelled') return;
    if (!['draft', 'submitted', 'returned'].includes(po.status)) throw conflict('INVALID_STATE', '已确认的采购单不能撤回；不再到货请关闭');
    const [rc] = await tx<{ n: number }[]>`SELECT count(*) AS n FROM inv_docs WHERE purchase_order_id = ${poId} AND status <> 'cancelled'`;
    if (rc!.n > 0) throw conflict('PO_HAS_RECEIPTS', '这张采购单已有收货，不能撤回；请负责人确认后关闭');
    if (!can(actor, 'inventory.approve') && po.createdBy !== actor.id) throw forbidden('只能撤回自己创建的采购单');
    await tx`UPDATE purchase_orders SET status = 'cancelled', returned_reason = ${reason}, updated_at = now() WHERE id = ${poId}`;
    await logApproval(tx, 'purchase_order', poId, 'cancel', actor.id, reason, po.revision);
  });
  return getPo(deps.sql, poId);
}

/** 关闭：剩余未到的数量不再收货（例如供应商缺货），已收货与货款不受影响 */
export async function closePo(deps: Deps, poId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(ReasonInput, raw);
  await deps.sql.begin(async (tx) => {
    const po = await lockPo(tx, poId);
    if (po.status === 'closed') return;
    if (po.status !== 'approved') throw conflict('INVALID_STATE', '只有已确认的采购单可以关闭');
    const [pending] = await tx<{ n: number }[]>`
      SELECT count(*) AS n FROM inv_docs WHERE purchase_order_id = ${poId} AND status IN ('draft', 'submitted', 'returned')`;
    if (pending!.n > 0) throw conflict('PO_PENDING_RECEIPTS', '这张采购单还有未生效的收货单，请先处理');
    await tx`UPDATE purchase_orders SET status = 'closed', closed_by = ${actor.id}, closed_at = now(), close_reason = ${reason}, updated_at = now() WHERE id = ${poId}`;
    await logApproval(tx, 'purchase_order', poId, 'close', actor.id, reason, po.revision);
  });
  return getPo(deps.sql, poId);
}

/**
 * 按直接收货单（迁移 029 以前）或急采生成补单采购单（数量、价格取自收货单，不再入库或计款）。
 * dept：急采由本部门的部门申购补单并自己确认（#19，v0.7.11）。
 */
export async function backfillPo(deps: Deps, raw: unknown, actor: Actor, ip?: string, opts: { dept?: boolean } = {}) {
  const input = parse(z.object({ receiptDocId: id, clientKey: z.uuid(), approveNow: z.boolean().default(false), note: z.string().trim().max(200).default('') }), raw);
  const [rc] = await deps.sql<{ id: number; docType: string; status: string; supplierId: number; docDate: string; purchaseOrderId: number | null; docNo: string; urgent: boolean; departmentId: number | null }[]>`
    SELECT d.id, d.doc_type, d.status, d.supplier_id, d.doc_date, d.purchase_order_id, d.doc_no, d.urgent, w.department_id
    FROM inv_docs d LEFT JOIN warehouses w ON w.id = d.warehouse_id WHERE d.id = ${input.receiptDocId}`;
  if (!rc || rc.docType !== 'receipt') throw notFound('收货单不存在');
  if (opts.dept) {
    if (!rc.urgent) throw unprocessable('BACKFILL_NOT_URGENT', '部门只能给本部门的急采补单');
    if (!(await canOperateDept(deps.sql, actor, rc.departmentId))) throw forbidden('只有急采部门的部门申购可以补单');
    if (input.approveNow) throw badRequest('部门补单会直接由部门确认，不用再选「提交并确认」');
  }
  if (rc.status !== 'confirmed') throw unprocessable('BACKFILL_SOURCE_INVALID', '只有已生效的收货单可以补采购单');
  if (rc.purchaseOrderId) throw unprocessable('BACKFILL_LINKED', '这张收货单已关联采购单');
  const lines = await deps.sql<{ materialId: number; qtyMilli: number; factorMilli: number; priceCents: number; purchaseUnit: string }[]>`
    SELECT material_id, qty_milli, factor_milli, price_cents, purchase_unit FROM inv_doc_lines WHERE doc_id = ${rc.id} AND qty_milli > 0 ORDER BY line_no`;
  if (lines.length === 0) throw unprocessable('BACKFILL_EMPTY', '这张收货单没有合格实收，不需要补单');
  const poLines = lines.map((l) => {
    const packs = toPurchaseQty(l.qtyMilli, l.factorMilli);
    if (packs === null) throw unprocessable('BACKFILL_UNIT', '收货数量不是整包装，无法自动补单，请手工建采购单');
    return { materialId: l.materialId, purchaseQtyMilli: packs, priceCents: l.priceCents, note: '' };
  });
  return createPo(
    deps,
    {
      clientKey: input.clientKey,
      supplierId: rc.supplierId,
      orderDate: rc.docDate,
      note: input.note || `${rc.urgent ? '急采补单' : '补单'}：${rc.docNo}`,
      lines: poLines,
      action: 'submit',
      approveNow: input.approveNow,
    },
    actor,
    { backfillReceiptId: rc.id, ip, deptConfirm: opts.dept },
  );
}

// ───────────────────────── 路由 ─────────────────────────

const ListQuery = z.object({
  status: z.string().max(16).optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(32).optional(),
  open: z.enum(['1']).optional(),
});

export function registerPurchasingRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const poId = (req: FastifyRequest) => parse(idParam, req.params).id;

  app.get('/api/purchase-orders', { preHandler: guard('inventory.read') }, async (req) => {
    const q = parse(ListQuery, req.query);
    return listPos(sql, { ...q, open: q.open === '1' });
  });
  app.get('/api/purchase-orders/by-key/:key', { preHandler: guard('inventory.read') }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid() }), req.params);
    const [row] = await sql<{ id: number }[]>`SELECT id FROM purchase_orders WHERE client_key = ${key}`;
    return row ? { found: true, po: await getPo(sql, row.id) } : { found: false };
  });
  app.get('/api/purchase-orders/:id', { preHandler: guard('inventory.read') }, async (req) => getPo(sql, poId(req)));
  // 编制采购单时实时比价：按物料当前包装与当前价格口径
  app.get('/api/purchase-baseline', { preHandler: guard('inventory.read') }, async (req) => {
    const { materialId } = parse(z.object({ materialId: z.coerce.number().int().positive() }), req.query);
    const [m] = await sql<{ purchaseUnit: string; purchaseFactorMilli: number }[]>`SELECT purchase_unit, purchase_factor_milli FROM materials WHERE id = ${materialId}`;
    if (!m) throw notFound('物料不存在');
    const basis = (await loadInventorySettings(sql)).priceBasis;
    const baseline = await priceBaseline(
      sql,
      { materialId, purchaseUnit: m.purchaseUnit, factorMilli: m.purchaseFactorMilli, priceBasis: basis },
      { onOrBefore: todayIn(deps.config.timezone) },
    );
    return { baseline, priceBasis: basis };
  });

  app.post('/api/purchase-orders', { preHandler: guard('purchase.manage') }, async (req, reply) => {
    const r = await createPo(deps, req.body, req.actor, { ip: req.ip });
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/purchase-orders/backfill', { preHandler: guard('purchase.manage') }, async (req, reply) => {
    const r = await backfillPo(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.put('/api/purchase-orders/:id', { preHandler: guard('purchase.manage') }, async (req) => updatePo(deps, poId(req), req.body as PoBodyInput, req.actor));
  app.post('/api/purchase-orders/:id/revise', { preHandler: guard('purchase.manage') }, async (req) =>
    updatePo(deps, poId(req), req.body as PoBodyInput, req.actor, true),
  );
  app.post('/api/purchase-orders/:id/submit', { preHandler: guard('purchase.manage') }, async (req) => {
    const { approveNow } = parse(z.object({ approveNow: z.boolean().default(false) }), req.body ?? {});
    return submitPo(deps, poId(req), req.actor, approveNow);
  });
  app.post('/api/purchase-orders/:id/approve', { preHandler: guard('inventory.approve') }, async (req) => approvePo(deps, poId(req), req.actor));
  app.post('/api/purchase-orders/:id/return', { preHandler: guard('inventory.approve') }, async (req) => returnPo(deps, poId(req), req.body, req.actor));
  app.post('/api/purchase-orders/:id/cancel', { preHandler: guard('purchase.manage') }, async (req) => cancelPo(deps, poId(req), req.body, req.actor));
  app.post('/api/purchase-orders/:id/close', { preHandler: guard('inventory.read') }, async (req) => {
    if (!can(req.actor, 'purchase.manage') && !can(req.actor, 'inventory.approve')) throw forbidden();
    return closePo(deps, poId(req), req.body, req.actor);
  });
}
