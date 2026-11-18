// 8.1.10 核库转领用（docs/ERP_V8110.md 第 2 节，PENDING_DECISIONS CK8–CK17）：
//   · 需求单提交（要主管确认的在主管确认以后）时看每一行：选了物料、总仓现在有结存的行要核库，有一行就进「待核库」；
//     标了急的、集采导入的、「提需核库」关着的、一行都不用核的直接进采购审核（CK10、CK13）；
//   · 库管（「核库」权限）逐行选领用、替代或转采购，点「核库完成」时领用的行一起开一张部门领料单、马上生效（CK14）；
//   · 替代等部门（提单人、这个部门的主管或店主）答复：同意按提议开领料单（经办人记提议的库管），总仓不够了这一行改成转采购（CK15）；
//   · 全部领用了的需求单变成「已转领用」，不再进采购（CK16）；还有要买的进采购审核，部分领用的行转采购单时默认买剩下的；
//   · 超过「核库时限」没核完的、替代没答复的，每分钟的任务记成转采购（CK10）。
// 加锁：操作编号的咨询锁（与「确认作废」串行，业务类型 request_stock）→ 需求单一行（FOR UPDATE）→ 领料单照库存单据原来的锁
// （单号 → 物料按 id 升序 → 部门小仓）；没有先锁物料、再锁需求单的路径。超时任务一张需求单一个事务，只锁那张需求单一行。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Role } from '@shared/permissions';
import { fitsDecimals, formatQty, toBaseQty } from '@shared/quantity';
import {
  STOCK_CHECK_LABELS,
  type PurchaseRequest,
  type RequestLineCentralStock,
  type RequestLineStock,
  type StockCheckState,
  type StockMaterialOption,
  type SubstituteAnswerResult,
} from '@shared/requests';
import { guard, guardAny } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { createRequestIssue } from './inventory/docs';
import { logApproval } from './inventory/common';
import { loadPurchaseRules } from './inventory/purchase-rules';
import { closeDraftsOfRequest } from './request-drafts';
import { getRequest } from './requests';
import { systemStaffId } from './system-staff';

// ───────────────────────── 进待核库 ─────────────────────────

/**
 * 进待核库（CK13）：在调用方锁住（或刚建好）需求单一行的事务里，提交、修改后再提交、主管确认、部门表格导入之后调。
 * 只看待审核的单；还在等主管确认的先不核（none）。返回这张单的核库状态。
 */
export async function enterStockCheck(tx: Tx, requestId: number): Promise<StockCheckState> {
  const [r] = await tx<{ status: string; priority: string; source: string; deptConfirm: string }[]>`
    SELECT status, priority, source, dept_confirm FROM purchase_requests WHERE id = ${requestId}`;
  if (!r || r.status !== 'submitted') return 'none';
  let state: StockCheckState;
  if (r.deptConfirm === 'pending') state = 'none';
  else if (r.priority === 'urgent' || r.source === 'import' || !(await loadPurchaseRules(tx)).stockCheckEnabled) state = 'skipped';
  else {
    const [n] = await tx<{ lines: number }[]>`
      SELECT count(*)::int AS lines FROM purchase_request_lines l JOIN materials m ON m.id = l.material_id
      WHERE l.request_id = ${requestId} AND m.active AND m.tracked AND m.stock_milli > 0
        AND NOT EXISTS (SELECT 1 FROM request_line_stock s WHERE s.request_line_id = l.id)`;
    state = n!.lines > 0 ? 'pending' : 'skipped';
  }
  await tx`
    UPDATE purchase_requests SET stock_check = ${state}, stock_check_since = ${state === 'pending' ? tx`now()` : null},
           stock_checked_by = NULL, stock_checked_at = NULL
    WHERE id = ${requestId}`;
  return state;
}

/** 这张需求单有没有行已经从库存领用了（领用过的行不能再改、整单不能退回修改） */
export async function hasIssuedLines(db: Db, requestId: number): Promise<boolean> {
  const [row] = await db<{ issued: boolean }[]>`SELECT EXISTS (SELECT 1 FROM request_line_stock WHERE request_id = ${requestId} AND inv_doc_id IS NOT NULL) AS issued`;
  return !!row?.issued;
}

/** 修改需求单（整单替换明细）之前：删掉没领用的核库结果（领用过的由调用方先拒、数据库守卫兜底） */
export async function clearStockDecisions(tx: Tx, requestId: number) {
  await tx`DELETE FROM request_line_stock WHERE request_id = ${requestId}`;
}

/**
 * 需求单定为不采购、撤回时（调用方锁住需求单一行之后、改状态之前）：没核完的核库收掉——
 * 没答复的替代记成没回，待核库的记成不用核，待部门确认替代的记成核完。已经领用的照旧算领用。
 */
export async function closeOpenStockCheck(tx: Tx, requestId: number) {
  await tx`UPDATE request_line_stock SET substitute_state = 'expired' WHERE request_id = ${requestId} AND substitute_state = 'pending'`;
  await tx`
    UPDATE purchase_requests SET stock_check = CASE stock_check WHEN 'pending' THEN 'skipped' ELSE 'done' END
    WHERE id = ${requestId} AND stock_check IN ('pending', 'confirming')`;
}

/** 每一行都整行领用了：需求单变成「已转领用」（CK16），不再进采购 */
async function settleIssued(tx: Tx, requestId: number): Promise<boolean> {
  const [x] = await tx<{ lines: number; issued: number }[]>`
    SELECT count(*)::int AS lines,
           count(*) FILTER (WHERE s.inv_doc_id IS NOT NULL AND s.issued_qty_milli >= l.qty_milli)::int AS issued
    FROM purchase_request_lines l LEFT JOIN request_line_stock s ON s.request_line_id = l.id
    WHERE l.request_id = ${requestId}`;
  if (!x || x.lines === 0 || x.issued < x.lines) return false;
  await tx`UPDATE purchase_requests SET status = 'issued', reason = NULL, updated_at = now() WHERE id = ${requestId}`;
  await closeDraftsOfRequest(tx, requestId);
  return true;
}

// ───────────────────────── 读取 ─────────────────────────

/** 需求行的核库结果（getRequest 里用） */
export const LINE_STOCK_SQL = (db: Db) => db`
  (SELECT json_build_object(
            'decision', s.decision, 'issuedQtyMilli', s.issued_qty_milli,
            'substitute', CASE WHEN s.decision = 'substitute' THEN json_build_object(
                'materialId', sm.id, 'materialName', sm.name, 'qtyMilli', s.substitute_qty_milli, 'unit', sm.inventory_unit, 'state', s.substitute_state) END,
            'issueDoc', CASE WHEN s.inv_doc_id IS NULL THEN NULL ELSE json_build_object('id', d.id, 'docNo', d.doc_no, 'voided', d.status = 'voided') END,
            'decidedByName', dby.display_name, 'decidedAt', s.decided_at, 'answeredByName', aby.display_name)
     FROM request_line_stock s JOIN staff dby ON dby.id = s.decided_by LEFT JOIN staff aby ON aby.id = s.answered_by
     LEFT JOIN materials sm ON sm.id = s.substitute_material_id LEFT JOIN inv_docs d ON d.id = s.inv_doc_id
     WHERE s.request_line_id = l.id)`;

/** 选了物料的行：物料在总仓的结存与换算（getRequest 里用，部门也看得到这几样，CK9、CK17） */
export const CENTRAL_STOCK_SQL = (db: Db) => db`
  CASE WHEN m.id IS NULL THEN NULL
       ELSE json_build_object('stockMilli', m.stock_milli, 'inventoryUnit', m.inventory_unit, 'purchaseUnit', m.purchase_unit, 'factorMilli', m.purchase_factor_milli) END`;

export function lineStockOf(raw: RequestLineStock | null): RequestLineStock | null {
  if (!raw) return null;
  return {
    ...raw,
    issuedQtyMilli: Number(raw.issuedQtyMilli),
    substitute: raw.substitute ? { ...raw.substitute, materialId: Number(raw.substitute.materialId), qtyMilli: Number(raw.substitute.qtyMilli) } : null,
    issueDoc: raw.issueDoc ? { id: Number(raw.issueDoc.id), docNo: raw.issueDoc.docNo, voided: !!raw.issueDoc.voided } : null,
  };
}

export function centralStockOf(raw: { stockMilli: number; inventoryUnit: string; purchaseUnit: string; factorMilli: number } | null, unit: string): RequestLineCentralStock | null {
  if (!raw) return null;
  const stock = Number(raw.stockMilli);
  const factor = Number(raw.factorMilli);
  const lineQtyMilli = unit === raw.inventoryUnit ? stock : unit === raw.purchaseUnit && factor > 0 ? Math.floor((Math.max(0, stock) * 1000) / factor) : null;
  return { stockMilli: stock, inventoryUnit: raw.inventoryUnit, purchaseUnit: raw.purchaseUnit, factorMilli: factor, convertible: lineQtyMilli !== null, lineQtyMilli };
}

/** 替代品能选的物料：受管、在用、总仓有结存的 */
export async function stockMaterialOptions(db: Db): Promise<StockMaterialOption[]> {
  return db<StockMaterialOption[]>`
    SELECT id, code, name, specification, inventory_unit, decimals, stock_milli FROM materials
    WHERE active AND tracked AND stock_milli > 0 ORDER BY code LIMIT 2000`;
}

/** 待核库的张数（ERP 导航「需求单」上的待办数，给库管） */
export async function stockCheckCount(db: Db): Promise<number> {
  const [n] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM purchase_requests WHERE status = 'submitted' AND stock_check = 'pending'`;
  return n?.n ?? 0;
}

// ───────────────────────── 核库与答复替代 ─────────────────────────

interface LockedRequest {
  id: number;
  docNo: string;
  status: string;
  stockCheck: StockCheckState;
  departmentId: number;
  requesterId: number;
  requesterName: string;
  deptHeadId: number | null;
}

async function lockForStock(tx: Tx, requestId: number): Promise<LockedRequest> {
  const [r] = await tx<LockedRequest[]>`
    SELECT r.id, r.doc_no, r.status, r.stock_check, r.department_id, r.requester_id, s.display_name AS requester_name, r.dept_head_id
    FROM purchase_requests r JOIN staff s ON s.id = r.requester_id WHERE r.id = ${requestId} FOR UPDATE OF r`;
  if (!r) throw notFound('需求单不存在');
  return { ...r, id: Number(r.id), departmentId: Number(r.departmentId), requesterId: Number(r.requesterId), deptHeadId: r.deptHeadId === null ? null : Number(r.deptHeadId) };
}

function closedMessage(r: LockedRequest): string {
  if (r.status !== 'submitted') return '这张需求单已经不在待审核里，不用核库了';
  if (r.stockCheck === 'confirming') return '这张需求单已经核过库，在等部门确认替代';
  if (r.stockCheck === 'pending') return '这张需求单在等库管核库';
  return r.stockCheck === 'none' ? '这张需求单还在等部门主管确认' : `这张需求单${STOCK_CHECK_LABELS[r.stockCheck]}`;
}

/** 已经登记过的同一个操作编号：原样重提返回 true；用在了别的地方拒绝 */
async function replayed(db: Db, key: string, requestHash: string): Promise<boolean> {
  const [row] = await db<{ opType: string; requestHash: string }[]>`SELECT op_type, request_hash FROM idempotency_keys WHERE key = ${key}`;
  if (!row) return false;
  if (row.opType !== 'request_stock' || row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔操作，请刷新页面后重新填写');
  return true;
}

interface StockMaterial {
  id: number;
  name: string;
  active: boolean;
  tracked: boolean;
  stockMilli: number;
  inventoryUnit: string;
  purchaseUnit: string;
  purchaseFactorMilli: number;
  decimals: number;
}

async function loadStockMaterials(db: Db, ids: number[]): Promise<Map<number, StockMaterial>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db<StockMaterial[]>`
    SELECT id, name, active, tracked, stock_milli, inventory_unit, purchase_unit, purchase_factor_milli, decimals FROM materials WHERE id IN ${db(unique)}`;
  return new Map(rows.map((m) => [Number(m.id), { ...m, id: Number(m.id), stockMilli: Number(m.stockMilli), purchaseFactorMilli: Number(m.purchaseFactorMilli) }]));
}

const id = z.number().int().positive();
const qty = z.number('数量必须是数字').int('数量格式不正确').positive('数量必须大于 0').max(1_000_000_000_000, '数量过大');
const Decision = z.discriminatedUnion('decision', [
  z.object({ lineId: id, decision: z.literal('issue'), qtyMilli: qty }),
  z.object({ lineId: id, decision: z.literal('substitute'), materialId: id, qtyMilli: qty }),
  z.object({ lineId: id, decision: z.literal('purchase') }),
]);
const CheckInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  lines: z.array(Decision).min(1, '请逐行选怎么处理').max(50),
});
const AnswerInput = z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'), accept: z.boolean() });

interface LineRow {
  id: number;
  lineNo: number;
  name: string;
  materialId: number | null;
  qtyMilli: number;
  unit: string;
}

/**
 * 领用的数量（CK14）：这一行的单位是物料的库存单位或采购单位时按这个单位填（不超过申请数量，可以只领一部分）；
 * 是别的单位时整行领用，库管按库存单位填实际领的数量。返回库存单位的数量、记在需求行上的领用数量（这一行的单位）与领料单上的录入单位。
 */
function issueQty(l: LineRow, m: StockMaterial, q: number) {
  const over = () => unprocessable('ISSUE_EXCEEDS_REQUEST', `第 ${l.lineNo} 行最多领 ${formatQty(l.qtyMilli)} ${l.unit}（申请的数量），多的不用领`);
  let out: { base: number; issued: number; enteredQtyMilli: number | null; enteredUnit: string | null };
  if (l.unit === m.inventoryUnit) {
    if (q > l.qtyMilli) throw over();
    out = { base: q, issued: q, enteredQtyMilli: null, enteredUnit: null };
  } else if (l.unit === m.purchaseUnit) {
    if (q > l.qtyMilli) throw over();
    const base = toBaseQty(q, m.purchaseFactorMilli);
    if (base === null) throw badRequest(`第 ${l.lineNo} 行：${formatQty(q)} ${l.unit} 换算成 ${m.inventoryUnit} 除不尽，请换一个数`);
    out = { base, issued: q, enteredQtyMilli: q, enteredUnit: l.unit };
  } else {
    out = { base: q, issued: l.qtyMilli, enteredQtyMilli: null, enteredUnit: null };
  }
  if (!fitsDecimals(out.base, m.decimals)) throw badRequest(`「${m.name}」最多 ${m.decimals} 位小数（单位：${m.inventoryUnit}）`);
  return out;
}

/** 库管核库（CK14）：逐行领用、替代或转采购；领用的行一起开一张部门领料单、马上生效 */
export async function submitStockCheck(deps: Deps, requestId: number, raw: unknown, actor: Actor, ip?: string): Promise<PurchaseRequest> {
  const input = parse(CheckInput, raw);
  const requestHash = hashRequest({ requestId, lines: input.lines });
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      if (await replayed(tx, input.clientKey, requestHash)) return;
      await assertNotFenced(tx, input.clientKey, 'request_stock', erpOpAbandoned);
      const r = await lockForStock(tx, requestId);
      if (r.status !== 'submitted' || r.stockCheck !== 'pending') throw conflict('STOCK_CHECK_CLOSED', closedMessage(r));
      const lines = (await tx<LineRow[]>`SELECT id, line_no, name, material_id, qty_milli, unit FROM purchase_request_lines WHERE request_id = ${requestId} ORDER BY line_no`).map((l) => ({
        ...l,
        id: Number(l.id),
        materialId: l.materialId === null ? null : Number(l.materialId),
        qtyMilli: Number(l.qtyMilli),
      }));
      const byId = new Map(lines.map((l) => [l.id, l]));
      const seen = new Set<number>();
      for (const d of input.lines) {
        const l = byId.get(d.lineId);
        if (!l) throw conflict('STOCK_LINES_CHANGED', '需求单的内容刚改过，请刷新后重新核库');
        if (l.materialId === null) throw badRequest(`第 ${l.lineNo} 行是手填的新品，不核库`);
        if (seen.has(l.id)) throw badRequest('同一行只能选一次');
        seen.add(l.id);
      }
      const missing = lines.filter((l) => l.materialId !== null && !seen.has(l.id));
      if (missing.length) throw unprocessable('STOCK_LINE_MISSING', `每一行都要选领用、替代或转采购：第 ${missing.map((l) => l.lineNo).join('、')} 行还没选`);

      const mats = await loadStockMaterials(tx, [
        ...lines.flatMap((l) => (l.materialId === null ? [] : [l.materialId])),
        ...input.lines.flatMap((d) => (d.decision === 'substitute' ? [d.materialId] : [])),
      ]);
      const issues: { materialId: number; qtyMilli: number; enteredQtyMilli: number | null; enteredUnit: string | null; note: string }[] = [];
      const plans: { lineId: number; decision: 'issue' | 'substitute' | 'purchase'; issued: number; subId: number | null; subQty: number | null }[] = [];
      for (const d of input.lines) {
        const l = byId.get(d.lineId)!;
        const m = mats.get(l.materialId!)!;
        if (d.decision === 'purchase') {
          plans.push({ lineId: l.id, decision: 'purchase', issued: 0, subId: null, subQty: null });
        } else if (d.decision === 'issue') {
          if (!m.active || !m.tracked) throw unprocessable('MATERIAL_INACTIVE', `「${m.name}」已停用或不是受管物料，不能领用，请选转采购`);
          const q = issueQty(l, m, d.qtyMilli);
          issues.push({ materialId: m.id, qtyMilli: q.base, enteredQtyMilli: q.enteredQtyMilli, enteredUnit: q.enteredUnit, note: `${r.docNo} 第 ${l.lineNo} 行` });
          plans.push({ lineId: l.id, decision: 'issue', issued: q.issued, subId: null, subQty: null });
        } else {
          const s = mats.get(d.materialId);
          if (!s || !s.active || !s.tracked) throw unprocessable('MATERIAL_INACTIVE', '替代的物料不存在、已停用或不是受管物料');
          if (s.id === m.id) throw badRequest(`第 ${l.lineNo} 行：替代要换一种物料，同一种请选「领用」`);
          if (!fitsDecimals(d.qtyMilli, s.decimals)) throw badRequest(`「${s.name}」最多 ${s.decimals} 位小数（单位：${s.inventoryUnit}）`);
          if (d.qtyMilli > s.stockMilli) throw unprocessable('INSUFFICIENT_STOCK', `「${s.name}」总仓只有 ${formatQty(s.stockMilli)} ${s.inventoryUnit}`);
          plans.push({ lineId: l.id, decision: 'substitute', issued: 0, subId: s.id, subQty: d.qtyMilli });
        }
      }
      // 同一物料几行一起领：合计不超过总仓结存（生效时在物料锁里再核对一次）
      const need = new Map<number, number>();
      for (const i of issues) need.set(i.materialId, (need.get(i.materialId) ?? 0) + i.qtyMilli);
      for (const [mid, q] of need) {
        const m = mats.get(mid)!;
        if (q > m.stockMilli) throw unprocessable('INSUFFICIENT_STOCK', `「${m.name}」总仓只有 ${formatQty(m.stockMilli)} ${m.inventoryUnit}，领用合计 ${formatQty(q)} ${m.inventoryUnit}`);
      }

      const doc = issues.length ? await createRequestIssue(tx, deps, { departmentId: r.departmentId, handler: r.requesterName, note: `需求单 ${r.docNo} 核库转领用`, lines: issues }, actor) : null;
      for (const p of plans) {
        await tx`
          INSERT INTO request_line_stock (request_line_id, request_id, decision, issued_qty_milli, substitute_material_id, substitute_qty_milli, substitute_state, inv_doc_id, decided_by)
          VALUES (${p.lineId}, ${requestId}, ${p.decision}, ${p.issued}, ${p.subId}, ${p.subQty}, ${p.decision === 'substitute' ? 'pending' : null},
                  ${p.decision === 'issue' ? doc!.id : null}, ${actor.id})`;
      }
      const subs = plans.filter((p) => p.decision === 'substitute').length;
      await tx`
        UPDATE purchase_requests SET stock_check = ${subs ? 'confirming' : 'done'}, stock_checked_by = ${actor.id}, stock_checked_at = now(), updated_at = now()
        WHERE id = ${requestId}`;
      const allIssued = subs ? false : await settleIssued(tx, requestId);
      const issuedRows = plans.filter((p) => p.decision === 'issue').length;
      const buy = plans.filter((p) => p.decision === 'purchase').length + lines.filter((l) => l.materialId === null).length;
      const parts = [issuedRows ? `领用 ${issuedRows} 行（${doc!.docNo}）` : '', subs ? `替代 ${subs} 行等部门确认` : '', buy ? `转采购 ${buy} 行` : '', allIssued ? '全部领用，不再采购' : ''].filter(
        Boolean,
      );
      await logApproval(tx, 'purchase_request', requestId, 'stock', actor.id, `核库：${parts.join('；')}`);
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'request_stock', ${requestHash}, ${requestId}, ${actor.id})`;
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'request_stock',
        targetType: 'purchase_request',
        targetId: requestId,
        detail: { docNo: r.docNo, issueDocNo: doc?.docNo ?? null, issued: issuedRows, substitute: subs, purchase: buy, allIssued },
        ip,
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error, 'idempotency_keys_pkey') || !(await replayed(deps.sql, input.clientKey, requestHash))) throw error;
  }
  return getRequest(deps.sql, actor, requestId, deps.config.timezone);
}

/** 同意替代时开领料单可能遇到的、改成转采购的原因：总仓不够了、替代品停用了 */
const SUBSTITUTE_FAILURES = new Set(['INSUFFICIENT_STOCK', 'MATERIAL_INACTIVE', 'MATERIAL_NOT_TRACKED']);

/** 部门答复替代（CK15）：同意按提议开领料单（经办人记提议的库管），总仓不够了这一行改成转采购；不同意这一行转采购 */
export async function answerSubstitute(deps: Deps, requestId: number, lineId: number, raw: unknown, actor: Actor, ip?: string): Promise<SubstituteAnswerResult> {
  const input = parse(AnswerInput, raw);
  const requestHash = hashRequest({ requestId, lineId, accept: input.accept });
  let message: string | null = null;
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      if (await replayed(tx, input.clientKey, requestHash)) return;
      await assertNotFenced(tx, input.clientKey, 'request_stock', erpOpAbandoned);
      const r = await lockForStock(tx, requestId);
      const head =
        actor.role === 'owner' || r.requesterId === actor.id || r.deptHeadId === actor.id || (await tx`SELECT 1 FROM departments WHERE id = ${r.departmentId} AND head_id = ${actor.id}`).length > 0;
      if (!head) throw forbidden('只有提单人、这个部门的主管或店主能答复替代');
      if (r.status !== 'submitted' || r.stockCheck !== 'confirming') throw conflict('STOCK_CHECK_CLOSED', closedMessage(r));
      const [s] = await tx<
        { decision: string; substituteState: string; substituteMaterialId: number; substituteQtyMilli: number; decidedBy: number; lineNo: number; name: string; qtyMilli: number; unit: string }[]
      >`
        SELECT s.decision, s.substitute_state, s.substitute_material_id, s.substitute_qty_milli, s.decided_by, l.line_no, l.name, l.qty_milli, l.unit
        FROM request_line_stock s JOIN purchase_request_lines l ON l.id = s.request_line_id
        WHERE s.request_line_id = ${lineId} AND s.request_id = ${requestId} FOR UPDATE OF s`;
      if (!s || s.decision !== 'substitute') throw notFound('这一行没有替代提议');
      if (s.substituteState !== 'pending') throw conflict('SUBSTITUTE_ANSWERED', '这一行的替代已经答复过了，请刷新');
      let reason: string;
      if (input.accept) {
        const [p] = await tx<{ id: number; username: string; displayName: string; role: Role }[]>`SELECT id, username, display_name, role FROM staff WHERE id = ${s.decidedBy}`;
        const proposer: Actor = { id: Number(p!.id), username: p!.username, displayName: p!.displayName, role: p!.role, duties: [], mustChangePassword: false };
        try {
          const doc = await tx.savepoint((sp) =>
            createRequestIssue(
              sp,
              deps,
              {
                departmentId: r.departmentId,
                handler: r.requesterName,
                note: `需求单 ${r.docNo} 第 ${s.lineNo} 行替代领用`,
                lines: [
                  {
                    materialId: Number(s.substituteMaterialId),
                    qtyMilli: Number(s.substituteQtyMilli),
                    enteredQtyMilli: null,
                    enteredUnit: null,
                    note: `${r.docNo} 第 ${s.lineNo} 行（替代「${s.name}」）`.slice(0, 100),
                  },
                ],
              },
              proposer,
            ),
          );
          await tx`
            UPDATE request_line_stock SET substitute_state = 'accepted', issued_qty_milli = ${Number(s.qtyMilli)}, inv_doc_id = ${doc.id},
                   answered_by = ${actor.id}, answered_at = now()
            WHERE request_line_id = ${lineId}`;
          reason = `部门同意第 ${s.lineNo} 行用替代品（${doc.docNo}）`;
        } catch (error) {
          if (!(error instanceof AppError) || !SUBSTITUTE_FAILURES.has(error.code)) throw error;
          await tx`UPDATE request_line_stock SET substitute_state = 'failed', answered_by = ${actor.id}, answered_at = now() WHERE request_line_id = ${lineId}`;
          message = `${error.message}；第 ${s.lineNo} 行改成转采购`;
          reason = `部门同意第 ${s.lineNo} 行用替代品，但${error.message}，改成转采购`;
        }
      } else {
        await tx`UPDATE request_line_stock SET substitute_state = 'declined', answered_by = ${actor.id}, answered_at = now() WHERE request_line_id = ${lineId}`;
        reason = `部门不用第 ${s.lineNo} 行的替代品，照原来买`;
      }
      const [left] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM request_line_stock WHERE request_id = ${requestId} AND substitute_state = 'pending'`;
      if (left!.n === 0) {
        await tx`UPDATE purchase_requests SET stock_check = 'done', updated_at = now() WHERE id = ${requestId}`;
        if (await settleIssued(tx, requestId)) reason += '；全部领用，不再采购';
      }
      await logApproval(tx, 'purchase_request', requestId, 'stock', actor.id, reason.slice(0, 200));
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'request_stock', ${requestHash}, ${requestId}, ${actor.id})`;
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'request_stock',
        targetType: 'purchase_request',
        targetId: requestId,
        detail: { docNo: r.docNo, lineId, accept: input.accept, failed: !!message },
        ip,
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error, 'idempotency_keys_pkey') || !(await replayed(deps.sql, input.clientKey, requestHash))) throw error;
  }
  // 结果按这一行现在的答复给（原样重提也一样）
  const [now] = await deps.sql<{ state: string }[]>`SELECT substitute_state AS state FROM request_line_stock WHERE request_line_id = ${lineId}`;
  const outcome = now?.state === 'accepted' ? 'accepted' : now?.state === 'failed' ? 'failed' : 'declined';
  if (outcome === 'failed' && !message) message = '同意的时候总仓不够了，这一行改成转采购';
  return { request: await getRequest(deps.sql, actor, requestId, deps.config.timezone), outcome, message };
}

// ───────────────────────── 超时（每分钟的任务） ─────────────────────────

/**
 * 核库超时（CK10）：进待核库超过「核库时限」还没核完的记成「超时转采购」（没核的行都转采购，进采购审核）；
 * 替代提议发出后超过核库时限部门还没回的记成「没回，照原来买」。一张需求单一个事务，只锁那张需求单一行，锁住以后再核对一次。
 */
export async function sweepStockChecks(deps: Pick<Deps, 'sql'>, now: Date = new Date()): Promise<{ timedOut: number; expired: number }> {
  const { sql } = deps;
  const hours = (await loadPurchaseRules(sql)).stockCheckHours;
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const due = await sql<{ id: number }[]>`
    SELECT id FROM purchase_requests WHERE status = 'submitted' AND stock_check = 'pending' AND stock_check_since <= ${cutoff} ORDER BY id LIMIT 200`;
  const waiting = await sql<{ id: number }[]>`
    SELECT DISTINCT s.request_id AS id FROM request_line_stock s JOIN purchase_requests r ON r.id = s.request_id
    WHERE s.substitute_state = 'pending' AND s.decided_at <= ${cutoff} AND r.status = 'submitted' AND r.stock_check = 'confirming'
    ORDER BY 1 LIMIT 200`;
  let timedOut = 0;
  let expired = 0;
  for (const d of due) {
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const r = await lockForStock(tx, Number(d.id));
      const [since] = await tx<{ since: Date | null }[]>`SELECT stock_check_since AS since FROM purchase_requests WHERE id = ${r.id}`;
      if (r.status !== 'submitted' || r.stockCheck !== 'pending' || !since?.since || new Date(since.since) > cutoff) return;
      await tx`UPDATE purchase_requests SET stock_check = 'timeout', stock_checked_by = NULL, stock_checked_at = now(), updated_at = now() WHERE id = ${r.id}`;
      await logApproval(tx, 'purchase_request', r.id, 'stock', await systemStaffId(tx), `核库超过 ${hours} 小时没核完，系统转采购`);
      timedOut += 1;
    });
  }
  for (const w of waiting) {
    await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const r = await lockForStock(tx, Number(w.id));
      if (r.status !== 'submitted' || r.stockCheck !== 'confirming') return;
      const rows = await tx<{ lineNo: number }[]>`
        UPDATE request_line_stock s SET substitute_state = 'expired'
        FROM purchase_request_lines l
        WHERE l.id = s.request_line_id AND s.request_id = ${r.id} AND s.substitute_state = 'pending' AND s.decided_at <= ${cutoff}
        RETURNING l.line_no`;
      if (rows.length === 0) return;
      expired += rows.length;
      let reason = `部门超过 ${hours} 小时没答复第 ${rows
        .map((x) => x.lineNo)
        .sort((a, b) => a - b)
        .join('、')} 行的替代，照原来买`;
      const [left] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM request_line_stock WHERE request_id = ${r.id} AND substitute_state = 'pending'`;
      if (left!.n === 0) {
        await tx`UPDATE purchase_requests SET stock_check = 'done', updated_at = now() WHERE id = ${r.id}`;
        if (await settleIssued(tx, r.id)) reason += '；全部领用，不再采购';
      }
      await logApproval(tx, 'purchase_request', r.id, 'stock', await systemStaffId(tx), reason.slice(0, 200));
    });
  }
  return { timedOut, expired };
}

// ───────────────────────── 路由 ─────────────────────────

const LineParams = z.object({ id: z.coerce.number().int().positive(), lineId: z.coerce.number().int().positive() });

export function registerRequestStockRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/erp/requests/stock-materials', { preHandler: guard('request.stock') }, async () => readSnapshot(sql, stockMaterialOptions));
  app.post('/api/erp/requests/:id/stock-check', { preHandler: guard('request.stock') }, async (req) => ({
    request: await submitStockCheck(deps, parse(idParam, req.params).id, req.body ?? {}, req.actor, req.ip),
  }));
  // 部门答复替代：是不是提单人、主管或店主在函数里核对
  app.post('/api/erp/requests/:id/lines/:lineId/substitute', { preHandler: guardAny('request.create', 'request.review', 'request.stock') }, async (req) => {
    const p = parse(LineParams, req.params);
    return answerSubstitute(deps, p.id, p.lineId, req.body ?? {}, req.actor, req.ip);
  });
}
