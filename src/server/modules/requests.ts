// 部门采购需求单与图片（v0.7.8，飞书需求 RQ-005 第二步，见 docs/REQUISITIONS.md）。
//
// · 部门申购只能给员工档案里的所属部门提需求，能改、撤回自己的单（审核前）；采购（request.review）看全部、审核。
// · 新产品（不在物料档案里的）必须有参考链接和至少一张图片（12 条自检第 12 条）。
// · 通过之后内容不能再改；转采购单在采购单的接口里每一行带 requestLineIds（同一物料的几行需求可以合并成一行），
//   下单 / 到货 / 退货按采购单与收货单算。
// · 图片：浏览器压缩后上传，服务端核对文件头与大小，按内容摘要只存一份。
// 加锁顺序：采购单 → 需求单（转采购单时锁需求单，见 purchasing.ts）。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatAmount } from '@shared/money';
import { can } from '@shared/permissions';
import { formatQty } from '@shared/quantity';
import {
  imageUrl,
  MAX_IMAGE_BYTES,
  REQUEST_STATUS_LABELS,
  MAX_LINE_IMAGES,
  type OpenRequestLine,
  type PurchaseRequest,
  type PurchaseRequestSummary,
  type RequestLineProgress,
  type RequestMeta,
  type RequestsList,
  type RequestStatus,
} from '@shared/requests';
import { isUniqueViolation, readSnapshot, type Db } from '../db';
import { guard, guardAny } from '../auth/guard';
import { assertNotFenced } from '../lib/fences';
import { writeAudit } from '../lib/audit';
import { toCsv } from '../lib/csv';
import type { Actor, Deps } from '../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { loadExpenseRules } from './expenses';
import { docDateSchema, logApproval, nextDocNo, setTxTimeouts, todayIn } from './inventory/common';

const id = z.number().int().positive();
const hashRequest = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const ReasonInput = z.object({ reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200) });

// ───────────────────────── 谁在看 ─────────────────────────

async function myContext(db: Db, actor: Actor) {
  const [me] = await db<{ departmentId: number | null; departmentName: string | null }[]>`
    SELECT s.department_id, d.name AS department_name FROM staff s LEFT JOIN departments d ON d.id = s.department_id WHERE s.id = ${actor.id}`;
  return {
    departmentId: me?.departmentId ?? null,
    departmentName: me?.departmentName ?? null,
    canReview: can(actor, 'request.review'),
    canCreate: can(actor, 'request.create'),
  };
}

/** 看得到这张需求单：审核的人看全部；部门申购看本部门的与自己提的 */
function visible(me: Awaited<ReturnType<typeof myContext>>, actor: Actor, r: { departmentId: number; requesterId: number }) {
  return me.canReview || r.requesterId === actor.id || (me.departmentId !== null && r.departmentId === me.departmentId);
}

// ───────────────────────── 读取 ─────────────────────────

/** 需求行的进度：对应的有效采购单行（撤回的不算）、已生效的收货与退供应商数量 */
const PROGRESS_SQL = (db: Db) => db`
  (SELECT json_build_object(
            'poId', po.id, 'docNo', po.doc_no, 'status', po.status, 'supplierName', s.name,
            'orderedMilli', pl.base_qty_milli, 'inventoryUnit', pl.inventory_unit,
            'mergedLines', (SELECT count(*) FROM purchase_order_line_requests y WHERE y.po_line_id = pl.id),
            'receivedMilli', coalesce((SELECT sum(il.qty_milli) FROM inv_doc_lines il JOIN inv_docs d ON d.id = il.doc_id
                                       WHERE il.po_line_id = pl.id AND d.doc_type = 'receipt' AND d.status = 'confirmed'), 0),
            'returnedMilli', coalesce((SELECT sum(rl.qty_milli) FROM inv_doc_lines rl JOIN inv_docs rd ON rd.id = rl.doc_id
                                       JOIN inv_doc_lines src ON src.id = rl.source_line_id
                                       WHERE src.po_line_id = pl.id AND rd.doc_type = 'supplier_return' AND rd.status = 'confirmed'), 0))
     FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id
     JOIN purchase_orders po ON po.id = pl.po_id JOIN suppliers s ON s.id = po.supplier_id
     WHERE x.request_line_id = l.id AND po.status <> 'cancelled'
     ORDER BY pl.id LIMIT 1)`;

interface RawProgress {
  poId: number;
  docNo: string;
  status: string;
  supplierName: string;
  orderedMilli: number;
  inventoryUnit: string;
  mergedLines: number;
  receivedMilli: number;
  returnedMilli: number;
}

function progressOf(p: RawProgress | null): RequestLineProgress {
  if (!p) return { po: null, orderedMilli: 0, receivedMilli: 0, returnedMilli: 0, inventoryUnit: null, mergedLines: 0, state: 'none' };
  const received = Number(p.receivedMilli);
  const ordered = Number(p.orderedMilli);
  return {
    po: { id: p.poId, docNo: p.docNo, status: p.status, supplierName: p.supplierName },
    orderedMilli: ordered,
    receivedMilli: received,
    returnedMilli: Number(p.returnedMilli),
    inventoryUnit: p.inventoryUnit,
    mergedLines: Number(p.mergedLines),
    state: received <= 0 ? 'ordered' : received >= ordered ? 'received' : 'partial',
  };
}

async function summaries(db: Db, f: { ids?: number[]; status?: RequestStatus; departmentId?: number; requesterOrDept?: { staffId: number; departmentId: number | null } }) {
  return db<(Omit<PurchaseRequestSummary, 'department' | 'requester'> & { departmentId: number; departmentName: string; requesterId: number; requesterName: string })[]>`
    SELECT r.id, r.doc_no, r.status, r.need_by, r.created_at, r.department_id, d.name AS department_name, r.requester_id, s.display_name AS requester_name,
           (SELECT count(*)::int FROM purchase_request_lines l WHERE l.request_id = r.id) AS line_count,
           coalesce((SELECT string_agg(l.name, '、' ORDER BY l.line_no) FROM purchase_request_lines l WHERE l.request_id = r.id AND l.line_no <= 3), '') AS summary,
           (SELECT count(*)::int FROM purchase_request_lines l WHERE l.request_id = r.id AND EXISTS (
              SELECT 1 FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
              WHERE x.request_line_id = l.id AND po.status <> 'cancelled')) AS ordered_lines,
           (SELECT count(*)::int FROM purchase_request_lines l WHERE l.request_id = r.id AND EXISTS (
              SELECT 1 FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
              WHERE x.request_line_id = l.id AND po.status <> 'cancelled'
                AND (SELECT coalesce(sum(il.qty_milli), 0) FROM inv_doc_lines il JOIN inv_docs dd ON dd.id = il.doc_id
                     WHERE il.po_line_id = pl.id AND dd.doc_type = 'receipt' AND dd.status = 'confirmed') >= pl.base_qty_milli)) AS received_lines
    FROM purchase_requests r JOIN departments d ON d.id = r.department_id JOIN staff s ON s.id = r.requester_id
    WHERE TRUE
      ${f.ids ? db`AND r.id IN ${db(f.ids)}` : db``}
      ${f.status ? db`AND r.status = ${f.status}` : db``}
      ${f.departmentId ? db`AND r.department_id = ${f.departmentId}` : db``}
      ${f.requesterOrDept ? db`AND (r.requester_id = ${f.requesterOrDept.staffId} OR r.department_id = ${f.requesterOrDept.departmentId ?? 0})` : db``}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 500`;
}

const toSummary = (r: Awaited<ReturnType<typeof summaries>>[number]): PurchaseRequestSummary => {
  const { departmentId, departmentName, requesterId, requesterName, ...rest } = r;
  return { ...rest, department: { id: departmentId, name: departmentName }, requester: { id: requesterId, name: requesterName } };
};

export async function listRequests(db: Db, actor: Actor, f: { status?: RequestStatus; departmentId?: number }): Promise<RequestsList> {
  const me = await myContext(db, actor);
  const rows = await summaries(db, { ...f, requesterOrDept: me.canReview ? undefined : { staffId: actor.id, departmentId: me.departmentId } });
  return { requests: rows.map(toSummary), me };
}

export async function getRequest(db: Db, actor: Actor, requestId: number): Promise<PurchaseRequest> {
  const me = await myContext(db, actor);
  const [row] = await summaries(db, { ids: [requestId] });
  if (!row || !visible(me, actor, { departmentId: row.departmentId, requesterId: row.requesterId })) throw notFound('需求单不存在');
  const [extra] = await db<{ note: string; reviewedByName: string | null; reviewedAt: string | null; reason: string | null; isSynthetic: boolean }[]>`
    SELECT r.note, rb.display_name AS reviewed_by_name, r.reviewed_at, r.reason, r.is_synthetic
    FROM purchase_requests r LEFT JOIN staff rb ON rb.id = r.reviewed_by WHERE r.id = ${requestId}`;
  const lines = await db<(Omit<PurchaseRequest['lines'][number], 'progress'> & { progress: RawProgress | null })[]>`
    SELECT l.id, l.line_no, l.material_id, m.name AS material_name, l.name, l.purpose, l.qty_milli, l.unit, l.link, l.details,
           l.ref_price_cents, l.note,
           coalesce((SELECT json_agg(json_build_object('id', i.image_id, 'url', '/api/erp/images/' || i.image_id) ORDER BY i.sort_no)
                     FROM purchase_request_line_images i WHERE i.request_line_id = l.id), '[]'::json) AS images,
           ${PROGRESS_SQL(db)} AS progress
    FROM purchase_request_lines l LEFT JOIN materials m ON m.id = l.material_id
    WHERE l.request_id = ${requestId} ORDER BY l.line_no`;
  const approvals = await db<PurchaseRequest['approvals']>`
    SELECT a.id, a.action, s.display_name AS actor_name, a.reason, a.created_at
    FROM approval_logs a JOIN staff s ON s.id = a.actor_id WHERE a.doc_kind = 'purchase_request' AND a.doc_id = ${requestId} ORDER BY a.id`;
  return { ...toSummary(row), ...extra!, lines: lines.map((l) => ({ ...l, progress: progressOf(l.progress) })), approvals };
}

/** 已通过、还没下单的需求行（转采购单用；ids 给了就只取这些） */
export async function openLines(db: Db, ids?: number[]): Promise<OpenRequestLine[]> {
  const rows = await db<(Omit<OpenRequestLine, 'department'> & { departmentId: number; departmentName: string })[]>`
    SELECT l.id, r.id AS request_id, r.doc_no AS request_no, r.department_id, d.name AS department_name, s.display_name AS requester_name,
           l.material_id, m.name AS material_name, l.name, l.purpose, l.qty_milli, l.unit, l.link, l.details, l.ref_price_cents,
           coalesce((SELECT json_agg(json_build_object('id', i.image_id, 'url', '/api/erp/images/' || i.image_id) ORDER BY i.sort_no)
                     FROM purchase_request_line_images i WHERE i.request_line_id = l.id), '[]'::json) AS images
    FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id
    JOIN departments d ON d.id = r.department_id JOIN staff s ON s.id = r.requester_id
    LEFT JOIN materials m ON m.id = l.material_id
    WHERE r.status = 'approved'
      AND NOT EXISTS (SELECT 1 FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id
                      JOIN purchase_orders po ON po.id = pl.po_id
                      WHERE x.request_line_id = l.id AND po.status <> 'cancelled')
      ${ids ? db`AND l.id IN ${db(ids)}` : db``}
    ORDER BY r.created_at, r.id, l.line_no
    LIMIT 500`;
  return rows.map(({ departmentId, departmentName, ...r }) => ({ ...r, department: { id: departmentId, name: departmentName } }));
}

/** 提需求单要用的选项。物料只列受管、在用的（采购单只能下这些） */
export async function requestMeta(db: Db, actor: Actor): Promise<RequestMeta> {
  const me = await myContext(db, actor);
  const rules = await loadExpenseRules(db);
  const departments = await db<RequestMeta['departments']>`SELECT id, name FROM departments WHERE active ORDER BY sort_order, id`;
  const materials = await db<RequestMeta['materials']>`
    SELECT id, code, name, category, specification, purchase_unit, inventory_unit FROM materials WHERE active AND tracked ORDER BY code`;
  return { purposes: rules.purposes, departments, materials, me };
}

// ───────────────────────── 提交与修改 ─────────────────────────

const LineInput = z.object({
  materialId: id.nullable().default(null),
  name: z.string().trim().min(1, '请填写产品名').max(40, '产品名最多 40 个字'),
  purpose: z.string().trim().min(1, '请选择用途').max(20),
  qtyMilli: z.number().int().positive('数量必须大于 0').max(1_000_000_000),
  unit: z.string().trim().min(1, '请填写单位').max(8, '单位最多 8 个字'),
  link: z.string().trim().max(500, '链接最多 500 个字').default(''),
  details: z.string().trim().max(200, '详情最多 200 个字').default(''),
  refPriceCents: z.number().int().min(0).max(100_000_000).nullable().default(null),
  note: z.string().trim().max(100).default(''),
  imageIds: z.array(id).max(MAX_LINE_IMAGES, `每一行最多 ${MAX_LINE_IMAGES} 张图片`).default([]),
});

const BodyInput = z.object({
  departmentId: id.nullable().default(null),
  needBy: docDateSchema.nullable().default(null),
  note: z.string().trim().max(200).default(''),
  lines: z.array(LineInput).min(1, '至少一行').max(50, '一张需求单最多 50 行'),
});
const CreateInput = BodyInput.extend({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') });

async function validateLines(db: Db, lines: z.infer<typeof LineInput>[]) {
  const rules = await loadExpenseRules(db);
  const matIds = [...new Set(lines.map((l) => l.materialId).filter((x): x is number => x !== null))];
  const mats = matIds.length
    ? new Map((await db<{ id: number; name: string; active: boolean; tracked: boolean }[]>`SELECT id, name, active, tracked FROM materials WHERE id IN ${db(matIds)}`).map((m) => [m.id, m]))
    : new Map<number, { id: number; name: string; active: boolean; tracked: boolean }>();
  const imageIds = [...new Set(lines.flatMap((l) => l.imageIds))];
  const images = imageIds.length ? new Set((await db<{ id: number }[]>`SELECT id FROM erp_images WHERE id IN ${db(imageIds)}`).map((r) => r.id)) : new Set<number>();
  for (const l of lines) {
    if (!rules.purposes.includes(l.purpose)) throw unprocessable('PURPOSE_INVALID', `用途只能从固定选项里选：${rules.purposes.join('、')}`);
    if (l.materialId !== null) {
      const m = mats.get(l.materialId);
      if (!m || !m.active || !m.tracked) throw unprocessable('MATERIAL_INACTIVE', '选的物料不存在、已停用或不是受管物料');
    } else {
      // 新产品：图片与链接为必填（12 条自检第 12 条）
      if (!/^https?:\/\/\S+$/i.test(l.link)) throw unprocessable('LINK_REQUIRED', `「${l.name}」是新产品，请填写参考链接（http 或 https 开头）`);
      if (l.imageIds.length === 0) throw unprocessable('IMAGE_REQUIRED', `「${l.name}」是新产品，请至少上传一张图片`);
    }
    if (l.link && !/^https?:\/\/\S+$/i.test(l.link)) throw unprocessable('LINK_INVALID', `「${l.name}」的链接要以 http 或 https 开头`);
    if (new Set(l.imageIds).size !== l.imageIds.length) throw badRequest('同一张图片在一行里只能出现一次');
    for (const i of l.imageIds) if (!images.has(i)) throw unprocessable('IMAGE_NOT_FOUND', '有图片没有上传成功，请重新上传');
  }
}

async function writeLines(tx: Db, requestId: number, lines: z.infer<typeof LineInput>[]) {
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO purchase_request_lines (request_id, line_no, material_id, name, purpose, qty_milli, unit, link, details, ref_price_cents, note)
      VALUES (${requestId}, ${lineNo}, ${l.materialId}, ${l.name}, ${l.purpose}, ${l.qtyMilli}, ${l.unit}, ${l.link}, ${l.details}, ${l.refPriceCents}, ${l.note})
      RETURNING id`;
    let sort = 0;
    for (const imageId of l.imageIds) {
      sort += 1;
      await tx`INSERT INTO purchase_request_line_images (request_line_id, sort_no, image_id) VALUES (${row!.id}, ${sort}, ${imageId})`;
    }
  }
}

/** 需求单记在哪个部门：部门申购只能是员工档案里的所属部门；店主或审核的人可以替任何部门提 */
async function resolveDepartment(db: Db, actor: Actor, wanted: number | null) {
  const me = await myContext(db, actor);
  const free = actor.role === 'owner' || me.canReview;
  const deptId = free ? (wanted ?? me.departmentId) : me.departmentId;
  if (!deptId) throw unprocessable('DEPARTMENT_REQUIRED', free ? '请选择部门' : '你的员工档案里还没有填所属部门，请店主在后台员工里补上');
  if (!free && wanted !== null && wanted !== me.departmentId) throw forbidden('只能给自己的部门提需求单');
  const [d] = await db<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${deptId}`;
  if (!d?.active) throw unprocessable('DEPARTMENT_INVALID', '部门不存在或已停用');
  return deptId;
}

export async function createRequest(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(CreateInput, raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const findExisting = async (db: Db) => {
    const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (!row) return null;
    if (row.opType !== 'purchase_request' || row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一张不同的单据，请刷新页面后重新填写');
    return row.refId;
  };
  let requestId: number;
  let replayed = false;
  try {
    const r = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const existing = await findExisting(tx);
      if (existing) return { id: existing, replayed: true };
      await assertNotFenced(tx, input.clientKey, 'purchase_request', erpOpAbandoned);
      const deptId = await resolveDepartment(tx, actor, input.departmentId);
      await validateLines(tx, input.lines);
      const docNo = await nextDocNo(tx, 'purchase_request', 'XQ', todayIn(deps.config.timezone));
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO purchase_requests (doc_no, department_id, requester_id, need_by, note, status, client_key)
        VALUES (${docNo}, ${deptId}, ${actor.id}, ${input.needBy}, ${input.note}, 'submitted', ${input.clientKey})
        RETURNING id`;
      await writeLines(tx, row!.id, input.lines);
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'purchase_request', ${requestHash}, ${row!.id}, ${actor.id})`;
      await logApproval(tx, 'purchase_request', row!.id, 'create', actor.id);
      await logApproval(tx, 'purchase_request', row!.id, 'submit', actor.id);
      await writeAudit(tx, { staffId: actor.id, action: 'purchase_request', targetType: 'purchase_request', targetId: row!.id, detail: { docNo, lines: input.lines.length }, ip });
      return { id: row!.id, replayed: false };
    });
    requestId = r.id;
    replayed = r.replayed;
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, 'purchase_requests_client_key_key')) {
      const existing = await findExisting(deps.sql);
      if (!existing) throw error;
      requestId = existing;
      replayed = true;
    } else throw error;
  }
  return { request: await getRequest(deps.sql, actor, requestId), replayed };
}

async function lockRequest(tx: Db, requestId: number) {
  const [r] = await tx<{ id: number; status: RequestStatus; requesterId: number; departmentId: number; docNo: string }[]>`
    SELECT id, status, requester_id, department_id, doc_no FROM purchase_requests WHERE id = ${requestId} FOR UPDATE`;
  if (!r) throw notFound('需求单不存在');
  return r;
}

/** 提交后、退回后由提单人修改（整单替换明细），改完回到待审核 */
export async function updateRequest(deps: Deps, requestId: number, raw: unknown, actor: Actor) {
  const input = parse(BodyInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const r = await lockRequest(tx, requestId);
    if (r.requesterId !== actor.id && actor.role !== 'owner') throw forbidden('只能改自己提的需求单');
    if (r.status !== 'submitted' && r.status !== 'returned') throw conflict('INVALID_STATE', '需求单已结束审核，不能再改');
    if (input.departmentId !== null && input.departmentId !== r.departmentId) throw badRequest('需求单的部门不能改，请撤回后重新提');
    await validateLines(tx, input.lines);
    await tx`DELETE FROM purchase_request_line_images WHERE request_line_id IN (SELECT id FROM purchase_request_lines WHERE request_id = ${requestId})`;
    await tx`DELETE FROM purchase_request_lines WHERE request_id = ${requestId}`;
    await writeLines(tx, requestId, input.lines);
    await tx`UPDATE purchase_requests SET need_by = ${input.needBy}, note = ${input.note}, status = 'submitted', reason = NULL, updated_at = now() WHERE id = ${requestId}`;
    await logApproval(tx, 'purchase_request', requestId, r.status === 'returned' ? 'submit' : 'revise', actor.id);
  });
  await writeAudit(deps.sql, { staffId: actor.id, action: 'purchase_request', targetType: 'purchase_request', targetId: requestId, detail: { action: 'update' } });
  return getRequest(deps.sql, actor, requestId);
}

export async function actOnRequest(deps: Deps, requestId: number, action: 'approve' | 'return' | 'reject' | 'cancel', raw: unknown, actor: Actor) {
  const reason = action === 'approve' ? '' : parse(ReasonInput, raw).reason;
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const r = await lockRequest(tx, requestId);
    switch (action) {
      case 'approve':
        if (!can(actor, 'request.review')) throw forbidden('当前账号不能审核需求单');
        if (r.status === 'approved') return;
        if (r.status !== 'submitted') throw conflict('INVALID_STATE', '只有待审核的需求单可以通过');
        await tx`UPDATE purchase_requests SET status = 'approved', reviewed_by = ${actor.id}, reviewed_at = now(), reason = NULL, updated_at = now() WHERE id = ${requestId}`;
        return logApproval(tx, 'purchase_request', requestId, 'approve', actor.id);
      case 'return':
        if (!can(actor, 'request.review')) throw forbidden('当前账号不能审核需求单');
        if (r.status === 'returned') return;
        if (r.status !== 'submitted') throw conflict('INVALID_STATE', '只有待审核的需求单可以退回');
        await tx`UPDATE purchase_requests SET status = 'returned', reason = ${reason}, updated_at = now() WHERE id = ${requestId}`;
        return logApproval(tx, 'purchase_request', requestId, 'return', actor.id, reason);
      case 'reject':
        if (!can(actor, 'request.review')) throw forbidden('当前账号不能审核需求单');
        if (r.status === 'rejected') return;
        if (r.status !== 'submitted' && r.status !== 'returned') throw conflict('INVALID_STATE', '只有待审核或退回的需求单可以定为不采购');
        await tx`UPDATE purchase_requests SET status = 'rejected', reviewed_by = ${actor.id}, reviewed_at = now(), reason = ${reason}, updated_at = now() WHERE id = ${requestId}`;
        return logApproval(tx, 'purchase_request', requestId, 'cancel', actor.id, `不采购：${reason}`);
      case 'cancel':
        if (r.requesterId !== actor.id && actor.role !== 'owner') throw forbidden('只能撤回自己提的需求单');
        if (r.status === 'cancelled') return;
        if (r.status !== 'submitted' && r.status !== 'returned') throw conflict('INVALID_STATE', '需求单已结束审核，不能撤回');
        await tx`UPDATE purchase_requests SET status = 'cancelled', reason = ${reason}, updated_at = now() WHERE id = ${requestId}`;
        return logApproval(tx, 'purchase_request', requestId, 'cancel', actor.id, reason);
    }
  });
  await writeAudit(deps.sql, { staffId: actor.id, action: 'purchase_request', targetType: 'purchase_request', targetId: requestId, detail: { action, reason } });
  return getRequest(deps.sql, actor, requestId);
}

// ───────────────────────── 图片 ─────────────────────────

const ImageInput = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp'], '只能上传 JPEG、PNG、WebP 图片'),
  data: z.string().min(16).max(1_500_000),
});

function sniff(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export async function saveImage(db: Db, raw: unknown, actor: Actor) {
  const input = parse(ImageInput, raw);
  const buf = Buffer.from(input.data, 'base64');
  if (buf.length === 0) throw badRequest('图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) throw unprocessable('IMAGE_TOO_LARGE', '图片压缩后仍超过 1 MB，请换一张或裁小一点');
  const kind = sniff(buf);
  if (!kind || kind !== input.mime) throw unprocessable('IMAGE_INVALID', '文件不是有效的 JPEG、PNG 或 WebP 图片');
  const sha = createHash('sha256').update(buf).digest('hex');
  const [row] = await db<{ id: number }[]>`
    INSERT INTO erp_images (sha256, mime, data, size_bytes, created_by) VALUES (${sha}, ${kind}, ${buf}, ${buf.length}, ${actor.id})
    ON CONFLICT (sha256) DO NOTHING RETURNING id`;
  const imageId = row?.id ?? (await db<{ id: number }[]>`SELECT id FROM erp_images WHERE sha256 = ${sha}`)[0]!.id;
  return { id: imageId, url: imageUrl(imageId) };
}

// ───────────────────────── 自检 ─────────────────────────

export async function requestChecks(db: Db) {
  const bad = await db<{ docNo: string; why: string }[]>`
    SELECT min(r.doc_no) AS doc_no, '同一行需求对应了不止一行有效的采购单' AS why
    FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
    JOIN purchase_request_lines l ON l.id = x.request_line_id JOIN purchase_requests r ON r.id = l.request_id
    WHERE po.status <> 'cancelled' GROUP BY x.request_line_id HAVING count(*) > 1
    UNION ALL
    SELECT r.doc_no, '采购单行的物料与需求行不一致'
    FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
    JOIN purchase_request_lines l ON l.id = x.request_line_id JOIN purchase_requests r ON r.id = l.request_id
    WHERE po.status <> 'cancelled' AND l.material_id IS NOT NULL AND l.material_id <> pl.material_id
    UNION ALL
    SELECT r.doc_no, '采购单行关联的需求单没有通过'
    FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
    JOIN purchase_request_lines l ON l.id = x.request_line_id JOIN purchase_requests r ON r.id = l.request_id
    WHERE po.status <> 'cancelled' AND r.status <> 'approved'
    UNION ALL
    SELECT r.doc_no, '新产品「' || l.name || '」没有链接或图片' FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id
    WHERE l.material_id IS NULL AND (l.link = '' OR NOT EXISTS (SELECT 1 FROM purchase_request_line_images i WHERE i.request_line_id = l.id))`;
  const [n] = await db<{ requests: number; images: number; bytes: number }[]>`
    SELECT (SELECT count(*)::int FROM purchase_requests) AS requests, (SELECT count(*)::int FROM erp_images) AS images,
           (SELECT coalesce(sum(size_bytes), 0)::bigint FROM erp_images) AS bytes`;
  return [
    {
      key: 'purchase_requests',
      label: '需求单与采购单一致',
      ok: bad.length === 0,
      detail: bad.length
        ? bad.map((b) => `${b.docNo} ${b.why}`).join('；')
        : `需求单 ${n!.requests} 张：每一行需求最多对应一行有效的采购单，物料一致；新产品都有链接和图片（图片 ${n!.images} 张，共 ${(Number(n!.bytes) / 1024 / 1024).toFixed(1)} MB）`,
    },
  ];
}

// ───────────────────────── 导出（v0.7.9） ─────────────────────────

const EXPORT_LIMIT = 20_000;
const PROGRESS_LABELS: Record<RequestLineProgress['state'], string> = { none: '未下单', ordered: '已下单', partial: '部分到货', received: '已到货' };

/** 需求单导出：每一行需求一行，带下单 / 到货 / 退货与采购单号（只导出看得到的） */
async function requestsCsv(db: Db, timezone: string, f: { from: string; to: string; status?: RequestStatus; departmentId?: number }) {
  const [n] = await db<{ count: number }[]>`
    SELECT count(*)::int AS count FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id
    WHERE (r.created_at AT TIME ZONE ${timezone})::date BETWEEN ${f.from} AND ${f.to}
      ${f.status ? db`AND r.status = ${f.status}` : db``} ${f.departmentId ? db`AND r.department_id = ${f.departmentId}` : db``}`;
  if (n!.count > EXPORT_LIMIT) throw unprocessable('EXPORT_TOO_LARGE', `这段时间有 ${n!.count} 行需求，一次最多导出 ${EXPORT_LIMIT} 行，请缩短日期范围`);
  const rows = await db<{
    docNo: string;
    createdAt: string;
    departmentName: string;
    requesterName: string;
    status: RequestStatus;
    needBy: string | null;
    lineNo: number;
    name: string;
    materialName: string | null;
    purpose: string;
    qtyMilli: number;
    unit: string;
    refPriceCents: number | null;
    link: string;
    details: string;
    note: string;
    imageCount: number;
    progress: RawProgress | null;
  }[]>`
    SELECT r.doc_no, r.created_at, d.name AS department_name, s.display_name AS requester_name, r.status, r.need_by,
           l.line_no, l.name, m.name AS material_name, l.purpose, l.qty_milli, l.unit, l.ref_price_cents, l.link, l.details, l.note,
           (SELECT count(*)::int FROM purchase_request_line_images i WHERE i.request_line_id = l.id) AS image_count,
           ${PROGRESS_SQL(db)} AS progress
    FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id
    JOIN departments d ON d.id = r.department_id JOIN staff s ON s.id = r.requester_id
    LEFT JOIN materials m ON m.id = l.material_id
    WHERE (r.created_at AT TIME ZONE ${timezone})::date BETWEEN ${f.from} AND ${f.to}
      ${f.status ? db`AND r.status = ${f.status}` : db``} ${f.departmentId ? db`AND r.department_id = ${f.departmentId}` : db``}
    ORDER BY r.created_at, r.id, l.line_no`;
  const out: (string | number)[][] = [
    ['需求单号', '提交时间', '部门', '提单人', '状态', '需要日期', '行号', '产品名', '物料', '用途', '数量', '单位', '参考单价（元）', '参考链接', '详情 / 规格', '备注', '图片张数',
     '进度', '采购单号', '供应商', '下单数量', '到货数量', '退货数量', '库存单位'],
  ];
  for (const r of rows) {
    const p = progressOf(r.progress);
    out.push([
      r.docNo,
      String(r.createdAt).replace('T', ' ').slice(0, 16),
      r.departmentName,
      r.requesterName,
      REQUEST_STATUS_LABELS[r.status],
      r.needBy ?? '',
      r.lineNo,
      r.name,
      r.materialName ?? '新产品',
      r.purpose,
      formatQty(Number(r.qtyMilli)).replace(/,/g, ''),
      r.unit,
      r.refPriceCents === null ? '' : formatAmount(Number(r.refPriceCents)).replace(/,/g, ''),
      r.link,
      r.details,
      r.note,
      r.imageCount,
      PROGRESS_LABELS[p.state],
      p.po?.docNo ?? '',
      p.po?.supplierName ?? '',
      p.po ? formatQty(p.orderedMilli).replace(/,/g, '') : '',
      p.po ? formatQty(p.receivedMilli).replace(/,/g, '') : '',
      p.po ? formatQty(p.returnedMilli).replace(/,/g, '') : '',
      p.inventoryUnit ?? '',
    ]);
  }
  return toCsv(out);
}

// ───────────────────────── 路由 ─────────────────────────

const ListQuery = z.object({
  status: z.enum(['submitted', 'returned', 'approved', 'rejected', 'cancelled']).optional(),
  departmentId: z.coerce.number().int().positive().optional(),
});
const ExportQuery = ListQuery.extend({ from: docDateSchema, to: docDateSchema });
const IdsQuery = z.object({ ids: z.string().regex(/^\d+(,\d+)*$/).optional() });
const keyParam = z.object({ key: z.uuid('操作编号格式不正确') });

export function registerRequestRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const docId = (req: { params: unknown }) => parse(idParam, req.params).id;
  const anyRequest = guardAny('request.create', 'request.review');

  app.get('/api/erp/requests', { preHandler: anyRequest }, async (req) => readSnapshot(sql, (tx) => listRequests(tx, req.actor, parse(ListQuery, req.query))));
  app.get('/api/erp/requests/open-lines', { preHandler: guardAny('request.review') }, async (req) => {
    const { ids } = parse(IdsQuery, req.query);
    return openLines(sql, ids ? ids.split(',').map(Number) : undefined);
  });
  app.get('/api/erp/requests/by-key/:key', { preHandler: anyRequest }, async (req) => {
    const { key } = parse(keyParam, req.params);
    const [row] = await sql<{ id: number }[]>`SELECT id FROM purchase_requests WHERE client_key = ${key}`;
    if (!row) throw notFound('没有找到这次提交');
    return getRequest(sql, req.actor, row.id);
  });
  app.get('/api/erp/requests/checks', { preHandler: anyRequest }, async () => readSnapshot(sql, requestChecks));
  // 导出需求单（v0.7.9）：与报销、台账同一个导出权限（店主、对账付款、成本核算、负责人）
  app.get('/api/erp/requests/export', { preHandler: guard('expense.export') }, async (req, reply) => {
    const f = parse(ExportQuery, req.query);
    if (f.from > f.to) throw badRequest('开始日期不能晚于结束日期');
    const csv = await readSnapshot(sql, (tx) => requestsCsv(tx, deps.config.timezone, f));
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'purchase_requests', detail: f, ip: req.ip });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`采购需求单_${f.from}_${f.to}.csv`)}`);
    return csv;
  });
  app.get('/api/erp/requests/meta', { preHandler: anyRequest }, async (req) => readSnapshot(sql, (tx) => requestMeta(tx, req.actor)));
  app.get('/api/erp/requests/:id', { preHandler: anyRequest }, async (req) => readSnapshot(sql, (tx) => getRequest(tx, req.actor, docId(req))));
  app.post('/api/erp/requests', { preHandler: guardAny('request.create') }, async (req, reply) => {
    const r = await createRequest(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
  app.put('/api/erp/requests/:id', { preHandler: guardAny('request.create') }, async (req) => updateRequest(deps, docId(req), req.body, req.actor));
  for (const action of ['approve', 'return', 'reject'] as const) {
    app.post(`/api/erp/requests/:id/${action}`, { preHandler: guardAny('request.review') }, async (req) => actOnRequest(deps, docId(req), action, req.body, req.actor));
  }
  app.post('/api/erp/requests/:id/cancel', { preHandler: guardAny('request.create') }, async (req) => actOnRequest(deps, docId(req), 'cancel', req.body, req.actor));

  // 图片：上传（压缩后的 Base64，单张不超过 1 MB）与查看（要登录、要有需求单或库存采购的查看权限）
  app.post('/api/erp/images', { preHandler: guardAny('request.create', 'request.review', 'purchase.manage'), bodyLimit: 1_600_000 }, async (req, reply) => {
    const img = await saveImage(sql, req.body, req.actor);
    reply.code(201);
    return img;
  });
  app.get('/api/erp/images/:id', { preHandler: guardAny('request.create', 'request.review', 'inventory.read', 'expense.read') }, async (req, reply) => {
    const [img] = await sql<{ mime: string; data: Buffer }[]>`SELECT mime, data FROM erp_images WHERE id = ${docId(req)}`;
    if (!img) throw notFound('图片不存在');
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(img.data);
  });
}
