// 合同的写操作（v0.7.31，docs/CONTRACTS.md）：起草、修改、提交审查、撤回、作废、终止、签署、归档；审批（走审批中心，法务那一级按审查清单
// 逐条给意见）；变更单；用印申请；扫描件。
//
// 锁（AGENTS.md「开发约定」）：合同的修改、提交、撤回、作废、终止、签署、归档、扫描件、新建变更单与用印申请都先锁合同一行（带版本号）；
// 审批：合同（或变更单、用印申请）一行 → 审批单一行；变更单最后一级同意时 变更单 → 审批单 → 合同一行（写新版本）。
// 新建合同、变更单、用印申请先取操作编号的咨询锁（与「确认作废」串行），同一编号重提返回原来那一条。

import { z } from 'zod';
import { isLegalStep } from '@shared/approvals';
import {
  CHANGE_KINDS,
  CONTRACT_CATEGORIES,
  CONTRACT_EDITABLE,
  LEGAL_ITEM_KEYS,
  REVIEW_VERDICTS,
  SEAL_TYPES,
  type ContractCategory,
  type ContractContent,
  type ContractStatus,
  type LegalItemKey,
  type ReviewItem,
} from '@shared/contracts';
import { ISO_DATE } from '@shared/business-date';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { approveCurrent, closeApproval, lockPending, returnCurrent, submitForApproval, type ApproveOutcome } from '../approvals/engine';
import { erpOpAbandoned } from '../erp-ops';
import { saveImage } from '../requests';
import { assertSubmittable, ContentInput, contentWithoutLines, normalizeContent, readContent } from './content';

const id = z.number().int().positive();
const Reason = z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 个字');
const Version = z.object({ version: z.number('缺少版本号，请刷新后重试').int().positive() });
const isoDate = (label: string) => z.string(`请填写${label}`).regex(ISO_DATE, `${label}格式应为 YYYY-MM-DD`);
const ClientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');

// ───────────────────────── 合同 ─────────────────────────

interface ContractRow {
  id: number;
  contractNo: string;
  category: ContractCategory;
  supplierId: number | null;
  departmentId: number | null;
  status: ContractStatus;
  draft: unknown;
  version: number;
  currentVersion: number;
  currentRevisionId: number | null;
  totalCents: number;
  createdBy: number;
  handlerId: number;
}

async function lockContract(tx: Tx, contractId: number): Promise<ContractRow> {
  const [c] = await tx<ContractRow[]>`
    SELECT id, contract_no, category, supplier_id, department_id, status, draft, version, current_version, current_revision_id, total_cents, created_by, handler_id
    FROM contracts WHERE id = ${contractId} FOR UPDATE`;
  if (!c) throw notFound('合同不存在');
  return { ...c, id: Number(c.id), totalCents: Number(c.totalCents), createdBy: Number(c.createdBy), handlerId: Number(c.handlerId) };
}

function assertVersion(row: { version: number }, version: number) {
  if (row.version !== version) throw conflict('VERSION_CONFLICT', '这份合同刚被别人改过，请刷新后再操作');
}

const HeaderInput = z.object({
  category: z.enum(CONTRACT_CATEGORIES, '请选择合同类型'),
  supplierId: id.nullable().default(null),
  counterparty: z.string().trim().max(60, '相对方最多 60 个字').default(''),
  departmentId: id.nullable().default(null),
  handlerId: id.nullable().default(null),
  renewalOf: id.nullable().default(null),
});

/** 相对方、部门、经办、续签自（C1）：采购合同要选供应商；没写相对方名称的取供应商名称 */
async function checkHeader(db: Db, h: z.infer<typeof HeaderInput>, actor: Actor, selfId: number | null) {
  let counterparty = h.counterparty;
  if (h.category === 'purchase' && h.supplierId === null) throw badRequest('采购合同请从供应商档案里选相对方');
  if (h.supplierId !== null) {
    const [s] = await db<{ name: string; active: boolean }[]>`SELECT name, active FROM suppliers WHERE id = ${h.supplierId}`;
    if (!s) throw unprocessable('SUPPLIER_NOT_FOUND', '供应商不存在，请刷新后重试');
    if (!s.active) throw unprocessable('SUPPLIER_INACTIVE', `供应商「${s.name}」已停用`);
    counterparty ||= s.name;
  }
  if (!counterparty) throw badRequest('请填写相对方');
  if (h.departmentId !== null) {
    const [d] = await db`SELECT 1 FROM departments WHERE id = ${h.departmentId}`;
    if (!d) throw unprocessable('DEPARTMENT_NOT_FOUND', '部门不存在，请刷新后重试');
  }
  const handlerId = h.handlerId ?? actor.id;
  const [st] = await db<{ active: boolean }[]>`SELECT active FROM staff WHERE id = ${handlerId}`;
  if (!st?.active) throw unprocessable('STAFF_INACTIVE', '经办人不存在或已停用');
  if (h.renewalOf !== null) {
    if (h.renewalOf === selfId) throw badRequest('续签不能指向自己');
    const [r] = await db<{ status: ContractStatus }[]>`SELECT status FROM contracts WHERE id = ${h.renewalOf}`;
    if (!r) throw unprocessable('CONTRACT_NOT_FOUND', '要续签的合同不存在');
    if (r.status === 'voided') throw unprocessable('CONTRACT_VOIDED', '要续签的合同已作废');
  }
  return { ...h, counterparty, handlerId };
}

const CreateInput = HeaderInput.extend({ clientKey: ClientKey, content: ContentInput });

export async function createContract(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(CreateInput, raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM contracts WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一份合同，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 先取操作编号的咨询锁（与「确认作废」串行），确认这笔没有被作废
      await assertNotFenced(tx, input.clientKey, 'contract_create', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      const h = await checkHeader(tx, input, actor, null);
      const content = await normalizeContent(tx, input.content);
      const contractNo = await nextDocNo(tx, 'contract', 'HT', todayIn(deps.config.timezone));
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO contracts (contract_no, category, supplier_id, counterparty, department_id, handler_id, renewal_of, draft, title, start_date, end_date,
                               total_cents, client_key, request_hash, created_by)
        VALUES (${contractNo}, ${h.category}, ${h.supplierId}, ${h.counterparty}, ${h.departmentId}, ${h.handlerId}, ${h.renewalOf},
                ${tx.json(content as never)}, ${content.title}, ${content.startDate}, ${content.endDate}, ${content.totalCents},
                ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: row!.id, detail: { op: 'create', contractNo }, ip });
      return { id: Number(row!.id), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'contracts_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    throw error;
  }
}

const UpdateInput = HeaderInput.extend({ version: z.number().int().positive(), content: ContentInput });

/** 修改（起草中、已退回的）：基本信息与内容一起存 */
export async function updateContract(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(UpdateInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const c = await lockContract(tx, contractId);
    assertVersion(c, input.version);
    if (!CONTRACT_EDITABLE.includes(c.status)) throw conflict('INVALID_STATE', c.status === 'reviewing' ? '审查中的合同不能改，要改先撤回' : '审批通过以后的合同不能直接改，请开变更单');
    const h = await checkHeader(tx, input, actor, contractId);
    const content = await normalizeContent(tx, input.content);
    await tx`
      UPDATE contracts SET category = ${h.category}, supplier_id = ${h.supplierId}, counterparty = ${h.counterparty}, department_id = ${h.departmentId},
             handler_id = ${h.handlerId}, renewal_of = ${h.renewalOf}, draft = ${tx.json(content as never)}, title = ${content.title},
             start_date = ${content.startDate}, end_date = ${content.endDate}, total_cents = ${content.totalCents},
             version = version + 1, updated_at = now()
      WHERE id = ${contractId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'update', contractNo: c.contractNo }, ip });
  });
}

/** 一份提交记录：当时的内容（不含单价表）与单价表（只追加） */
async function insertRevision(tx: Tx, contractId: number, changeId: number | null, content: ContractContent, requestId: number | null, actor: Actor): Promise<number> {
  const [next] = await tx<{ seq: number }[]>`SELECT coalesce(max(seq), 0) + 1 AS seq FROM contract_revisions WHERE contract_id = ${contractId}`;
  const seq = Number(next!.seq);
  const [rev] = await tx<{ id: number }[]>`
    INSERT INTO contract_revisions (contract_id, change_id, seq, content, approval_request_id, submitted_by)
    VALUES (${contractId}, ${changeId}, ${seq}, ${tx.json(contentWithoutLines(content) as never)}, ${requestId}, ${actor.id})
    RETURNING id`;
  let lineNo = 0;
  for (const l of content.lines) {
    lineNo += 1;
    await tx`
      INSERT INTO contract_lines (revision_id, line_no, material_id, item_name, spec, unit, price_cents, tax_rate_bp, qty_milli)
      VALUES (${rev!.id}, ${lineNo}, ${l.materialId}, ${l.itemName}, ${l.spec}, ${l.unit}, ${l.priceCents}, ${l.taxRateBp}, ${l.qtyMilli})`;
  }
  return Number(rev!.id);
}

/** 提交审查：存一份提交记录，审批中心开审批单（单据类型「合同」，C2） */
export async function submitContract(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string) {
  const { version } = parse(Version, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const c = await lockContract(tx, contractId);
    if (c.status === 'reviewing') return;
    assertVersion(c, version);
    if (!CONTRACT_EDITABLE.includes(c.status)) throw conflict('INVALID_STATE', '只有起草中、已退回的合同可以提交审查');
    const content = readContent(c.draft);
    await assertSubmittable(tx, c.category, content);
    const r = await submitForApproval(tx, 'contract', contractId, { actor, timeZone: deps.config.timezone }, { fallback: true });
    await insertRevision(tx, contractId, null, content, r.requestId, actor);
    await tx`UPDATE contracts SET status = 'reviewing', version = version + 1, updated_at = now() WHERE id = ${contractId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'submit', contractNo: c.contractNo }, ip });
  });
}

/** 撤回审查中的合同：审批单一起关掉，回到起草中 */
export async function withdrawContract(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string) {
  const { version } = parse(Version, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const c = await lockContract(tx, contractId);
    if (c.status === 'draft') return;
    assertVersion(c, version);
    if (c.status !== 'reviewing') throw conflict('INVALID_STATE', '只有审查中的合同可以撤回');
    await closeApproval(tx, 'contract', contractId, actor);
    await tx`UPDATE contracts SET status = 'draft', version = version + 1, updated_at = now() WHERE id = ${contractId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'withdraw', contractNo: c.contractNo }, ip });
  });
}

/** 作废（起草中、已退回、审批通过还没签署的）：有在审的用印申请要先撤回 */
export async function voidContract(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(Version.extend({ reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const c = await lockContract(tx, contractId);
    if (c.status === 'voided') return;
    assertVersion(c, input.version);
    if (!['draft', 'returned', 'approved'].includes(c.status)) {
      throw conflict('INVALID_STATE', c.status === 'reviewing' ? '审查中的合同要先撤回再作废' : '已签署的合同不能作废，请终止');
    }
    const [seal] = await tx<{ sealNo: string }[]>`SELECT seal_no FROM contract_seals WHERE contract_id = ${contractId} AND status = 'reviewing' LIMIT 1`;
    if (seal) throw conflict('CONTRACT_SEAL_PENDING', `用印申请 ${seal.sealNo} 还在审批，请先撤回`);
    await tx`
      UPDATE contracts SET status = 'voided', closed_reason = ${input.reason}, closed_on = ${todayIn(deps.config.timezone)}, closed_by = ${actor.id}, closed_at = now(),
             version = version + 1, updated_at = now()
      WHERE id = ${contractId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'void', contractNo: c.contractNo, reason: input.reason }, ip });
  });
}

/** 终止（已签署、已归档的）：写原因与终止日期；有没结束的变更单要先处理 */
export async function terminateContract(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(Version.extend({ reason: Reason, closedOn: isoDate('终止日期') }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const c = await lockContract(tx, contractId);
    if (c.status === 'terminated') return;
    assertVersion(c, input.version);
    if (!['signed', 'archived'].includes(c.status)) throw conflict('INVALID_STATE', '只有已签署、已归档的合同可以终止');
    const [open] = await tx<{ changeNo: string }[]>`SELECT change_no FROM contract_changes WHERE contract_id = ${contractId} AND status IN ('draft', 'reviewing', 'returned') LIMIT 1`;
    if (open) throw conflict('CONTRACT_CHANGE_OPEN', `变更单 ${open.changeNo} 还没结束，请先撤回或作废`);
    await tx`
      UPDATE contracts SET status = 'terminated', closed_reason = ${input.reason}, closed_on = ${input.closedOn}, closed_by = ${actor.id}, closed_at = now(),
             version = version + 1, updated_at = now()
      WHERE id = ${contractId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'terminate', contractNo: c.contractNo, reason: input.reason }, ip });
  });
}

/** 签署登记（审批通过以后）：签订日、双方签署人；登记后合同生效（C8） */
export async function signContract(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(
    Version.extend({
      signedOn: isoDate('签订日'),
      ourSignatory: z.string('请填写我方签署人').trim().min(1, '请填写我方签署人').max(20, '签署人最多 20 个字'),
      theirSignatory: z.string('请填写对方签署人').trim().min(1, '请填写对方签署人').max(20, '签署人最多 20 个字'),
    }),
    raw,
  );
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const c = await lockContract(tx, contractId);
    assertVersion(c, input.version);
    if (c.status !== 'approved') throw conflict('INVALID_STATE', '只有审批通过（待签署）的合同可以登记签署');
    if (input.signedOn > todayIn(deps.config.timezone)) throw badRequest('签订日不能晚于今天');
    await tx`
      UPDATE contracts SET status = 'signed', signed_on = ${input.signedOn}, our_signatory = ${input.ourSignatory}, their_signatory = ${input.theirSignatory},
             signed_by = ${actor.id}, signed_at = now(), version = version + 1, updated_at = now()
      WHERE id = ${contractId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'sign', contractNo: c.contractNo, signedOn: input.signedOn }, ip });
  });
}

/** 归档（C8）：已签署、至少一条用印登记已生效、至少一张扫描件 */
export async function archiveContract(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(Version.extend({ archiveLocation: z.string('请填写存放位置').trim().min(1, '请填写存放位置').max(60, '存放位置最多 60 个字') }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const c = await lockContract(tx, contractId);
    assertVersion(c, input.version);
    if (c.status !== 'signed') throw conflict('INVALID_STATE', '只有已签署的合同可以归档');
    const [seal] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM contract_seals WHERE contract_id = ${contractId} AND status = 'approved'`;
    if (seal!.n === 0) throw unprocessable('CONTRACT_SEAL_REQUIRED', '归档前要有一条已生效的用印登记');
    const [file] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM contract_files WHERE contract_id = ${contractId} AND removed_at IS NULL`;
    if (file!.n === 0) throw unprocessable('CONTRACT_FILE_REQUIRED', '归档前请上传合同的扫描件（按页拍照）');
    const archiveNo = await nextDocNo(tx, 'contract_archive', 'GD', todayIn(deps.config.timezone));
    await tx`
      UPDATE contracts SET status = 'archived', archive_no = ${archiveNo}, archive_location = ${input.archiveLocation}, archived_by = ${actor.id}, archived_at = now(),
             version = version + 1, updated_at = now()
      WHERE id = ${contractId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'archive', contractNo: c.contractNo, archiveNo }, ip });
  });
}

// ───────────────────────── 审批（审批中心与合同详情共用） ─────────────────────────

const ChecklistInput = z
  .array(z.object({ key: z.enum(LEGAL_ITEM_KEYS as [LegalItemKey, ...LegalItemKey[]]), verdict: z.enum(REVIEW_VERDICTS), note: z.string().trim().max(200, '意见最多 200 个字').default('') }))
  .max(LEGAL_ITEM_KEYS.length);
const ApprovalFence = z.object({
  requestId: id.optional(),
  level: z.number().int().min(1).max(3).optional(),
  batch: z.boolean().optional(),
});
const ApproveInput = ApprovalFence.extend({ comment: z.string().trim().max(200, '意见最多 200 个字').default(''), checklist: ChecklistInput.optional() });
const ReturnInput = ApprovalFence.extend({ reason: Reason, checklist: ChecklistInput.optional() });

/** 同意时的审查清单（C3）：每条都要给结论；有「要修改」的不能同意；「风险提示」要写意见 */
function checklistForApprove(items: ReviewItem[] | undefined): ReviewItem[] {
  if (!items || items.length === 0) throw unprocessable('LEGAL_CHECKLIST_REQUIRED', '法务这一级要按审查清单逐条给结论（通过 / 要修改 / 风险提示）');
  const keys = new Set(items.map((i) => i.key));
  if (keys.size !== items.length) throw badRequest('审查清单里同一条出现了两次');
  const missing = LEGAL_ITEM_KEYS.filter((k) => !keys.has(k));
  if (missing.length) throw unprocessable('LEGAL_CHECKLIST_REQUIRED', `审查清单还有 ${missing.length} 条没给结论`);
  if (items.some((i) => i.verdict === 'revise')) throw unprocessable('LEGAL_CHECKLIST_REVISE', '有「要修改」的条目不能同意，请退回并写明要改什么');
  if (items.some((i) => i.verdict === 'risk' && i.note.length < 2)) throw unprocessable('LEGAL_CHECKLIST_NOTE', '「风险提示」的条目请写意见（至少 2 个字）');
  return LEGAL_ITEM_KEYS.map((k) => items.find((i) => i.key === k)!);
}

/** 退回时可以只填有问题的几条（「要修改」「风险提示」要写意见） */
function checklistForReturn(items: ReviewItem[] | undefined): ReviewItem[] | null {
  if (!items || items.length === 0) return null;
  if (new Set(items.map((i) => i.key)).size !== items.length) throw badRequest('审查清单里同一条出现了两次');
  if (items.some((i) => i.verdict !== 'pass' && i.note.length < 2)) throw unprocessable('LEGAL_CHECKLIST_NOTE', '「要修改」「风险提示」的条目请写意见（至少 2 个字）');
  return LEGAL_ITEM_KEYS.filter((k) => items.some((i) => i.key === k)).map((k) => items.find((i) => i.key === k)!);
}

type ReviewKind = 'contract' | 'contract_change';

/** 这张审批单对着的提交记录（合同本身、变更单的最近一份） */
async function revisionOfRequest(tx: Tx, requestId: number): Promise<number> {
  const [r] = await tx<{ id: number }[]>`SELECT id FROM contract_revisions WHERE approval_request_id = ${requestId}`;
  if (!r) throw conflict('APPROVAL_MOVED', '这张单的提交记录不见了，请刷新后再看');
  return Number(r.id);
}

/**
 * 合同、合同变更的同意：法务那一级要审查清单（同意时逐条、不能有「要修改」）；结论记在这份提交记录上（只追加）。
 * 同一个人重提已经审过的一级（审批中心「按原内容重新提交」）按已同意处理、不重复记清单。
 */
async function approveReviewable(tx: Tx, kind: ReviewKind, docId: number, input: z.infer<typeof ApproveInput>, ctx: { actor: Actor; timeZone: string }): Promise<ApproveOutcome> {
  if (input.batch) throw conflict('APPROVAL_NO_BATCH', '合同、合同变更要逐张审（法务那一级要按审查清单逐条给意见），不能批量同意');
  const req = await lockPending(tx, kind, docId);
  const atCurrent = req !== null && (input.level === undefined || input.level === req.currentLevel);
  const legal = atCurrent && isLegalStep(req!.steps[req!.currentLevel - 1]);
  const items = legal ? checklistForApprove(input.checklist) : null;
  const level = req?.currentLevel ?? 0;
  const outcome = await approveCurrent(tx, kind, docId, ctx, { requestId: input.requestId, level: input.level, comment: input.comment });
  if (items && outcome !== 'already') await recordReview(tx, req!.id, level, 'approve', items, ctx.actor);
  return outcome;
}

async function returnReviewable(tx: Tx, kind: ReviewKind, docId: number, input: z.infer<typeof ReturnInput>, ctx: { actor: Actor; timeZone: string }) {
  const req = await lockPending(tx, kind, docId);
  const atCurrent = req !== null && (input.level === undefined || input.level === req.currentLevel);
  const legal = atCurrent && isLegalStep(req!.steps[req!.currentLevel - 1]);
  const items = legal ? checklistForReturn(input.checklist) : null;
  const level = req?.currentLevel ?? 0;
  await returnCurrent(tx, kind, docId, ctx, { requestId: input.requestId, level: input.level, reason: input.reason });
  if (items) await recordReview(tx, req!.id, level, 'return', items, ctx.actor);
}

async function recordReview(tx: Tx, requestId: number, level: number, action: 'approve' | 'return', items: ReviewItem[], actor: Actor) {
  const revisionId = await revisionOfRequest(tx, requestId);
  // 代理审的记「代 某某」：与审批记录同一条
  const [act] = await tx<{ onBehalfOf: number | null }[]>`
    SELECT on_behalf_of FROM approval_actions WHERE request_id = ${requestId} AND level = ${level} AND actor_id = ${actor.id} AND action = ${action}
    ORDER BY id DESC LIMIT 1`;
  await tx`
    INSERT INTO contract_reviews (revision_id, approval_request_id, level, action, items, reviewer_id, on_behalf_of)
    VALUES (${revisionId}, ${requestId}, ${level}, ${action}, ${tx.json(items as never)}, ${actor.id}, ${act?.onBehalfOf ?? null})`;
}

/** 合同的同意、退回（审批中心与合同详情共用）：最后一级同意后「审批通过（待签署）」，这份提交记录成为第 1 版 */
export async function actOnContract(deps: Deps, contractId: number, action: 'approve' | 'return', raw: unknown, actor: Actor) {
  const ctx = { actor, timeZone: deps.config.timezone };
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const c = await lockContract(tx, contractId);
    if (action === 'approve') {
      const input = parse(ApproveInput, raw ?? {});
      // 已经通过的（最后一级的重提）照旧按成功返回，与采购单一样
      if (['approved', 'signed', 'archived', 'terminated'].includes(c.status)) return;
      if (c.status !== 'reviewing') throw conflict('INVALID_STATE', '只有审查中的合同可以同意');
      const outcome = await approveReviewable(tx, 'contract', contractId, input, ctx);
      if (outcome !== 'final') return;
      const [rev] = await tx<{ id: number }[]>`
        SELECT r.id FROM contract_revisions r JOIN approval_requests q ON q.id = r.approval_request_id
        WHERE r.contract_id = ${contractId} AND r.change_id IS NULL AND q.status = 'approved' ORDER BY r.seq DESC LIMIT 1`;
      await tx`INSERT INTO contract_versions (contract_id, version_no, revision_id, approved_by) VALUES (${contractId}, 1, ${rev!.id}, ${actor.id})`;
      await tx`
        UPDATE contracts SET status = 'approved', current_revision_id = ${rev!.id}, current_version = 1, version = version + 1, updated_at = now()
        WHERE id = ${contractId}`;
      await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'approved', contractNo: c.contractNo } });
    } else {
      const input = parse(ReturnInput, raw ?? {});
      if (c.status === 'returned') return;
      if (c.status !== 'reviewing') throw conflict('INVALID_STATE', '只有审查中的合同可以退回');
      await returnReviewable(tx, 'contract', contractId, input, ctx);
      await tx`UPDATE contracts SET status = 'returned', version = version + 1, updated_at = now() WHERE id = ${contractId}`;
    }
  });
}

// ───────────────────────── 变更单（C10） ─────────────────────────

interface ChangeRow {
  id: number;
  changeNo: string;
  contractId: number;
  baseVersion: number;
  status: 'draft' | 'reviewing' | 'returned' | 'approved' | 'voided';
  draft: unknown;
  version: number;
  totalCents: number;
}

async function lockChange(tx: Tx, changeId: number): Promise<ChangeRow> {
  const [x] = await tx<ChangeRow[]>`
    SELECT id, change_no, contract_id, base_version, status, draft, version, total_cents FROM contract_changes WHERE id = ${changeId} FOR UPDATE`;
  if (!x) throw notFound('变更单不存在');
  return { ...x, id: Number(x.id), contractId: Number(x.contractId), totalCents: Number(x.totalCents) };
}

const ChangeBody = z.object({
  kinds: z.array(z.enum(CHANGE_KINDS)).min(1, '请选择变更类型').max(CHANGE_KINDS.length),
  reason: Reason,
  content: ContentInput,
});

async function currentTotal(db: Db, contractId: number): Promise<number> {
  const [c] = await db<{ totalCents: number }[]>`
    SELECT (r.content->>'totalCents')::bigint AS total_cents FROM contracts c JOIN contract_revisions r ON r.id = c.current_revision_id WHERE c.id = ${contractId}`;
  return Number(c?.totalCents ?? 0);
}

export async function createChange(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(ChangeBody.extend({ clientKey: ClientKey }), raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined, contractId });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM contract_changes WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一张变更单，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, input.clientKey, 'contract_change', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      const c = await lockContract(tx, contractId);
      if (!['signed', 'archived'].includes(c.status)) throw conflict('INVALID_STATE', '只有已签署、已归档的合同可以开变更单');
      const [open] = await tx<{ changeNo: string }[]>`SELECT change_no FROM contract_changes WHERE contract_id = ${contractId} AND status IN ('draft', 'reviewing', 'returned') LIMIT 1`;
      if (open) throw conflict('CONTRACT_CHANGE_OPEN', `这份合同已经有一张没结束的变更单 ${open.changeNo}`);
      const content = await normalizeContent(tx, input.content);
      const before = await currentTotal(tx, contractId);
      const changeNo = await nextDocNo(tx, 'contract_change', 'BG', todayIn(deps.config.timezone));
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO contract_changes (change_no, contract_id, base_version, kinds, reason, draft, total_cents, delta_cents, client_key, request_hash, created_by)
        VALUES (${changeNo}, ${contractId}, ${c.currentVersion}, ${input.kinds}, ${input.reason}, ${tx.json(content as never)}, ${content.totalCents},
                ${Math.abs(content.totalCents - before)}, ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      await tx`UPDATE contracts SET updated_at = now() WHERE id = ${contractId}`;
      await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract_change', targetId: row!.id, detail: { op: 'create', changeNo, contractNo: c.contractNo }, ip });
      return { id: Number(row!.id), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'contract_changes_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    if (isUniqueViolation(error, 'contract_changes_open')) throw conflict('CONTRACT_CHANGE_OPEN', '这份合同已经有一张没结束的变更单');
    throw error;
  }
}

export async function updateChange(deps: Deps, changeId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(ChangeBody.extend({ version: z.number().int().positive() }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const x = await lockChange(tx, changeId);
    assertVersion(x, input.version);
    if (!['draft', 'returned'].includes(x.status)) throw conflict('INVALID_STATE', '只有起草中、已退回的变更单可以改');
    const content = await normalizeContent(tx, input.content);
    const before = await currentTotal(tx, x.contractId);
    await tx`
      UPDATE contract_changes SET kinds = ${input.kinds}, reason = ${input.reason}, draft = ${tx.json(content as never)}, total_cents = ${content.totalCents},
             delta_cents = ${Math.abs(content.totalCents - before)}, version = version + 1, updated_at = now()
      WHERE id = ${changeId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract_change', targetId: changeId, detail: { op: 'update', changeNo: x.changeNo }, ip });
  });
}

export async function submitChange(deps: Deps, changeId: number, raw: unknown, actor: Actor, ip?: string) {
  const { version } = parse(Version, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const x = await lockChange(tx, changeId);
    if (x.status === 'reviewing') return;
    assertVersion(x, version);
    if (!['draft', 'returned'].includes(x.status)) throw conflict('INVALID_STATE', '只有起草中、已退回的变更单可以提交');
    const [c] = await tx<{ category: ContractCategory; status: ContractStatus; currentVersion: number }[]>`SELECT category, status, current_version FROM contracts WHERE id = ${x.contractId}`;
    if (!['signed', 'archived'].includes(c!.status)) throw conflict('INVALID_STATE', '合同已经不在生效中（终止了），变更单不能再提交');
    if (c!.currentVersion !== x.baseVersion) throw conflict('VERSION_CONFLICT', '合同已经有了新的版本，请作废这张变更单、在新版本上重开');
    const content = readContent(x.draft);
    await assertSubmittable(tx, c!.category, content);
    const r = await submitForApproval(tx, 'contract_change', changeId, { actor, timeZone: deps.config.timezone }, { fallback: true });
    await insertRevision(tx, x.contractId, changeId, content, r.requestId, actor);
    await tx`UPDATE contract_changes SET status = 'reviewing', version = version + 1, updated_at = now() WHERE id = ${changeId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract_change', targetId: changeId, detail: { op: 'submit', changeNo: x.changeNo }, ip });
  });
}

export async function withdrawChange(deps: Deps, changeId: number, raw: unknown, actor: Actor, ip?: string) {
  const { version } = parse(Version, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const x = await lockChange(tx, changeId);
    if (x.status === 'draft') return;
    assertVersion(x, version);
    if (x.status !== 'reviewing') throw conflict('INVALID_STATE', '只有审查中的变更单可以撤回');
    await closeApproval(tx, 'contract_change', changeId, actor);
    await tx`UPDATE contract_changes SET status = 'draft', version = version + 1, updated_at = now() WHERE id = ${changeId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract_change', targetId: changeId, detail: { op: 'withdraw', changeNo: x.changeNo }, ip });
  });
}

export async function voidChange(deps: Deps, changeId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(Version.extend({ reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const x = await lockChange(tx, changeId);
    if (x.status === 'voided') return;
    assertVersion(x, input.version);
    if (!['draft', 'returned'].includes(x.status)) throw conflict('INVALID_STATE', x.status === 'reviewing' ? '审查中的变更单要先撤回再作废' : '已生效的变更单不能作废');
    await tx`
      UPDATE contract_changes SET status = 'voided', closed_reason = ${input.reason}, closed_by = ${actor.id}, closed_at = now(), version = version + 1, updated_at = now()
      WHERE id = ${changeId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract_change', targetId: changeId, detail: { op: 'void', changeNo: x.changeNo, reason: input.reason }, ip });
  });
}

/** 变更单的同意、退回：最后一级同意后合同按新内容生效、版本号加 1（变更单 → 审批单 → 合同一行） */
export async function actOnChange(deps: Deps, changeId: number, action: 'approve' | 'return', raw: unknown, actor: Actor) {
  const ctx = { actor, timeZone: deps.config.timezone };
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const x = await lockChange(tx, changeId);
    if (action === 'approve') {
      const input = parse(ApproveInput, raw ?? {});
      if (x.status === 'approved') return;
      if (x.status !== 'reviewing') throw conflict('INVALID_STATE', '只有审查中的变更单可以同意');
      const outcome = await approveReviewable(tx, 'contract_change', changeId, input, ctx);
      if (outcome !== 'final') return;
      const c = await lockContract(tx, x.contractId);
      if (!['signed', 'archived'].includes(c.status)) throw conflict('INVALID_STATE', '合同已经不在生效中（终止了），变更单不能生效');
      if (c.currentVersion !== x.baseVersion) throw conflict('VERSION_CONFLICT', '合同已经有了新的版本，这张变更单不能生效，请退回');
      const [rev] = await tx<{ id: number }[]>`
        SELECT r.id FROM contract_revisions r JOIN approval_requests q ON q.id = r.approval_request_id
        WHERE r.change_id = ${changeId} AND q.status = 'approved' ORDER BY r.seq DESC LIMIT 1`;
      const versionNo = c.currentVersion + 1;
      const content = readContent(x.draft);
      await tx`INSERT INTO contract_versions (contract_id, version_no, revision_id, change_id, approved_by) VALUES (${x.contractId}, ${versionNo}, ${rev!.id}, ${changeId}, ${actor.id})`;
      await tx`
        UPDATE contracts SET current_revision_id = ${rev!.id}, current_version = ${versionNo}, title = ${content.title}, start_date = ${content.startDate},
               end_date = ${content.endDate}, total_cents = ${content.totalCents}, version = version + 1, updated_at = now()
        WHERE id = ${x.contractId}`;
      await tx`UPDATE contract_changes SET status = 'approved', result_version = ${versionNo}, version = version + 1, updated_at = now() WHERE id = ${changeId}`;
      await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract_change', targetId: changeId, detail: { op: 'approved', changeNo: x.changeNo, contractNo: c.contractNo, version: versionNo } });
    } else {
      const input = parse(ReturnInput, raw ?? {});
      if (x.status === 'returned') return;
      if (x.status !== 'reviewing') throw conflict('INVALID_STATE', '只有审查中的变更单可以退回');
      await returnReviewable(tx, 'contract_change', changeId, input, ctx);
      await tx`UPDATE contract_changes SET status = 'returned', version = version + 1, updated_at = now() WHERE id = ${changeId}`;
    }
  });
}

// ───────────────────────── 用印申请（C7） ─────────────────────────

const SealBody = z.object({
  sealType: z.enum(SEAL_TYPES, '请选择印章'),
  copies: z.number('请填写份数').int('份数是整数').min(1, '份数至少 1 份').max(20, '份数最多 20 份'),
  operatorId: id,
  sealDate: isoDate('用印日期'),
  purpose: z.string().trim().max(100, '用途最多 100 个字').default(''),
});

async function checkOperator(db: Db, operatorId: number) {
  const [st] = await db<{ active: boolean }[]>`SELECT active FROM staff WHERE id = ${operatorId}`;
  if (!st?.active) throw unprocessable('STAFF_INACTIVE', '用印人不存在或已停用');
}

/** 用印申请：合同审批通过以后、归档以前，提交即走审批中心（单据类型「用印」） */
export async function createSeal(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(SealBody.extend({ clientKey: ClientKey }), raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined, contractId });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM contract_seals WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一条用印申请，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, input.clientKey, 'contract_seal', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      const c = await lockContract(tx, contractId);
      if (!['approved', 'signed'].includes(c.status)) throw conflict('INVALID_STATE', '合同审批通过以后、归档以前才能申请用印');
      await checkOperator(tx, input.operatorId);
      const sealNo = await nextDocNo(tx, 'contract_seal', 'YY', todayIn(deps.config.timezone));
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO contract_seals (seal_no, contract_id, seal_type, copies, operator_id, seal_date, purpose, client_key, request_hash, created_by)
        VALUES (${sealNo}, ${contractId}, ${input.sealType}, ${input.copies}, ${input.operatorId}, ${input.sealDate}, ${input.purpose},
                ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      await submitForApproval(tx, 'contract_seal', Number(row!.id), { actor, timeZone: deps.config.timezone }, { fallback: true });
      await tx`UPDATE contracts SET updated_at = now() WHERE id = ${contractId}`;
      await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract_seal', targetId: row!.id, detail: { op: 'create', sealNo, contractNo: c.contractNo }, ip });
      return { id: Number(row!.id), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'contract_seals_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    throw error;
  }
}

interface SealRow {
  id: number;
  sealNo: string;
  contractId: number;
  status: 'reviewing' | 'returned' | 'approved' | 'withdrawn';
  version: number;
  createdBy: number;
}

async function lockSeal(tx: Tx, sealId: number): Promise<SealRow> {
  const [s] = await tx<SealRow[]>`SELECT id, seal_no, contract_id, status, version, created_by FROM contract_seals WHERE id = ${sealId} FOR UPDATE`;
  if (!s) throw notFound('用印申请不存在');
  return { ...s, id: Number(s.id), contractId: Number(s.contractId), createdBy: Number(s.createdBy) };
}

/** 退回的用印申请改了再提交（审批从第一级重新走） */
export async function resubmitSeal(deps: Deps, sealId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(SealBody.extend({ version: z.number().int().positive() }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const s = await lockSeal(tx, sealId);
    if (s.status === 'reviewing' && s.version === input.version + 1) return;
    assertVersion(s, input.version);
    if (s.status !== 'returned') throw conflict('INVALID_STATE', '只有已退回的用印申请可以改了再提交');
    const [c] = await tx<{ status: ContractStatus }[]>`SELECT status FROM contracts WHERE id = ${s.contractId}`;
    if (!['approved', 'signed'].includes(c!.status)) throw conflict('INVALID_STATE', '合同审批通过以后、归档以前才能申请用印');
    await checkOperator(tx, input.operatorId);
    await tx`
      UPDATE contract_seals SET seal_type = ${input.sealType}, copies = ${input.copies}, operator_id = ${input.operatorId}, seal_date = ${input.sealDate},
             purpose = ${input.purpose}, status = 'reviewing', version = version + 1, updated_at = now()
      WHERE id = ${sealId}`;
    await submitForApproval(tx, 'contract_seal', sealId, { actor, timeZone: deps.config.timezone }, { fallback: true });
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract_seal', targetId: sealId, detail: { op: 'resubmit', sealNo: s.sealNo }, ip });
  });
}

export async function withdrawSeal(deps: Deps, sealId: number, raw: unknown, actor: Actor, ip?: string) {
  const { version } = parse(Version, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const s = await lockSeal(tx, sealId);
    if (s.status === 'withdrawn') return;
    assertVersion(s, version);
    if (!['reviewing', 'returned'].includes(s.status)) throw conflict('INVALID_STATE', '已生效的用印登记不能撤回');
    await closeApproval(tx, 'contract_seal', sealId, actor);
    await tx`UPDATE contract_seals SET status = 'withdrawn', version = version + 1, updated_at = now() WHERE id = ${sealId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract_seal', targetId: sealId, detail: { op: 'withdraw', sealNo: s.sealNo }, ip });
  });
}

const SealApprove = ApprovalFence.extend({ comment: z.string().trim().max(200, '意见最多 200 个字').default('') });
const SealReturn = ApprovalFence.extend({ reason: Reason });

/** 用印的同意、退回（审批中心与合同详情共用） */
export async function actOnSeal(deps: Deps, sealId: number, action: 'approve' | 'return', raw: unknown, actor: Actor) {
  const ctx = { actor, timeZone: deps.config.timezone };
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const s = await lockSeal(tx, sealId);
    if (action === 'approve') {
      const input = parse(SealApprove, raw ?? {});
      if (input.batch) throw conflict('APPROVAL_NO_BATCH', '用印申请要逐张审，不能批量同意');
      if (s.status === 'approved') return;
      if (s.status !== 'reviewing') throw conflict('INVALID_STATE', '只有审批中的用印申请可以同意');
      const outcome = await approveCurrent(tx, 'contract_seal', sealId, ctx, { requestId: input.requestId, level: input.level, comment: input.comment });
      if (outcome !== 'final') return;
      const [c] = await tx<{ status: ContractStatus }[]>`SELECT status FROM contracts WHERE id = ${s.contractId}`;
      if (!['approved', 'signed'].includes(c!.status)) throw conflict('INVALID_STATE', '合同已经不在审批通过、已签署（作废、终止或已归档），用印申请不能生效');
      await tx`UPDATE contract_seals SET status = 'approved', version = version + 1, updated_at = now() WHERE id = ${sealId}`;
      await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract_seal', targetId: sealId, detail: { op: 'approved', sealNo: s.sealNo } });
    } else {
      const input = parse(SealReturn, raw ?? {});
      if (s.status === 'returned') return;
      if (s.status !== 'reviewing') throw conflict('INVALID_STATE', '只有审批中的用印申请可以退回');
      await returnCurrent(tx, 'contract_seal', sealId, ctx, { requestId: input.requestId, level: input.level, reason: input.reason });
      await tx`UPDATE contract_seals SET status = 'returned', version = version + 1, updated_at = now() WHERE id = ${sealId}`;
    }
  });
}

// ───────────────────────── 扫描件 ─────────────────────────

/** 上传一页扫描件（图片，压缩后不超过 1 MB）：作废的合同不能再传；归档以后只能追加 */
export async function addFile(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string) {
  const img = await saveImage(deps.sql, raw, actor);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const c = await lockContract(tx, contractId);
    if (c.status === 'voided') throw conflict('INVALID_STATE', '作废的合同不能再上传扫描件');
    // 同一张图已经挂在这份合同上（上次上传没收到结果、重新上传的）：不另记一份（图片本身按内容去重）
    const [same] = await tx<{ id: number }[]>`
      SELECT id FROM contract_files WHERE contract_id = ${contractId} AND image_id = ${img.id} AND removed_at IS NULL LIMIT 1`;
    if (same) return { id: Number(same.id) };
    const [next] = await tx<{ sortNo: number }[]>`SELECT coalesce(max(sort_no), 0) + 1 AS sort_no FROM contract_files WHERE contract_id = ${contractId}`;
    const sortNo = Number(next!.sortNo);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO contract_files (contract_id, image_id, sort_no, added_by) VALUES (${contractId}, ${img.id}, ${sortNo}, ${actor.id}) RETURNING id`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'file_add', contractNo: c.contractNo, fileId: row!.id }, ip });
    return { id: Number(row!.id) };
  });
}

/** 删掉传错的扫描件（标记，不删记录）：归档以后不能删 */
export async function removeFile(deps: Deps, fileId: number, actor: Actor, ip?: string) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [f] = await tx<{ contractId: number; removedAt: string | null }[]>`SELECT contract_id, removed_at FROM contract_files WHERE id = ${fileId}`;
    if (!f) throw notFound('扫描件不存在');
    const c = await lockContract(tx, Number(f.contractId));
    if (f.removedAt) return;
    if (c.status === 'archived') throw conflict('INVALID_STATE', '归档以后扫描件只能追加，不能删');
    await tx`UPDATE contract_files SET removed_by = ${actor.id}, removed_at = now() WHERE id = ${fileId} AND removed_at IS NULL`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: c.id, detail: { op: 'file_remove', contractNo: c.contractNo, fileId }, ip });
  });
}

