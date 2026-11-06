// 审批中心的接口（v0.7.30，docs/APPROVALS.md）：待办列表、详情、同意 / 退回（按审批单走到单据模块原来的确认、退回）、
// 批量同意、审批规则（新建、修改、停用，带版本号）、代理人（设、收回）。
//
// 锁：同意、退回照单据模块原来的顺序（单据 → 审批单 → 单据生效时照旧的锁）；规则的修改只锁那一条、带版本号；
// 代理人的设只靠操作编号的咨询锁与唯一约束，收回只锁那一条。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  APPROVAL_BATCH_MAX,
  APPROVAL_BATCH_MAX_CENTS,
  APPROVAL_DOC_TYPES,
  APPROVAL_GROUPS,
  APPROVAL_MAX_LEVELS,
  APPROVAL_MAX_STAFF,
  CONTRACT_REVIEW_DOC_TYPES,
  DELEGATION_MAX_DAYS,
  NO_BATCH_DOC_TYPES,
  inStep,
  stepLabel,
  type ApprovalDocKind,
  type ApprovalDocType,
  type ApprovalRuleView,
  type ApprovalStep,
  type ApproverOption,
  type BatchApproveResult,
  type DelegationView,
} from '@shared/approvals';
import { formatAmount } from '@shared/money';
import { can, permissionsOf, type Duty, type Role } from '@shared/permissions';
import { isUniqueViolation, type Db } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { loadRoleOverrides } from '../../auth/role-permissions';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { daysBetween, todayIn } from '../../lib/dates';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced } from '../../lib/fences';
import { erpOpAbandoned } from '../erp-ops';
import { hashRequest } from '../../lib/idempotency';
import { setTxTimeouts } from '../../lib/tx';
import { idParam, parse } from '../../lib/validate';
import { actOnChange, actOnContract, actOnSeal } from '../contracts/flow';
import { actOnPaymentRequest } from '../payments/requests';
import { actOnClaim } from '../expenses';
import { approveDoc, returnDoc } from '../inventory/docs';
import { actOnOpening, actOnPayment } from '../inventory/payables';
import { approvePo, returnPo } from '../inventory/purchasing';
import { approvalCounts, assertApprovalKindOpen, getApprovalDetail, listApprovals, urgentAwaitingAcceptance, urgentBackfills, type ApprovalTab } from './center';
import { hasApprovalAccess, staffNames } from './engine';

const id = z.number().int().positive();
const dateStr = z.iso.date('日期格式不对');
const ACT = guardAny('approval.act', 'inventory.approve', 'expense.approve');

// ───────────────────────── 同意、退回 ─────────────────────────

/** 合同类法务那一级的审查清单（v0.7.31，C3；合同模块里再核对每一条） */
const Checklist = z.array(z.object({ key: z.string().max(20), verdict: z.string().max(10), note: z.string().max(200).default('') })).max(20);
const ApproveBody = z.object({
  level: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
  comment: z.string().trim().max(200, '意见最多 200 个字').default(''),
  /** 盘点：最后一级同意时可以改每行差异的原因类别（与原来的确认一样） */
  countReasons: z.record(z.string(), z.string()).optional(),
  checklist: Checklist.optional(),
});
const ReturnBody = z.object({
  level: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
  reason: z.string().trim().min(2, '请写退回原因（至少 2 个字）').max(200, '原因最多 200 个字'),
  checklist: Checklist.optional(),
});

async function requestHead(db: Db, requestId: number): Promise<{ id: number; docKind: ApprovalDocKind; docId: number; docNo: string; docType: string; amountCents: number | null; status: string }> {
  const [r] = await db<{ id: number; docKind: ApprovalDocKind; docId: number; docNo: string; docType: string; amountCents: number | null; status: string }[]>`
    SELECT id, doc_kind, doc_id, doc_no, doc_type, amount_cents, status FROM approval_requests WHERE id = ${requestId}`;
  if (!r) throw notFound('审批单不存在');
  return { ...r, id: Number(r.id), docId: Number(r.docId), amountCents: r.amountCents === null ? null : Number(r.amountCents) };
}

/** 按审批单走到单据模块原来的确认、退回（同一段代码，默认规则下与原来的按钮一样） */
async function actOnRequest(deps: Deps, requestId: number, action: 'approve' | 'return', body: Record<string, unknown>, actor: Actor) {
  const head = await requestHead(deps.sql, requestId);
  // 单据所属的模块关着：与单据原来的接口一样拒绝（批量同意时这一张单独失败）
  await assertApprovalKindOpen(deps.sql, head.docKind);
  const raw = { ...body, requestId };
  switch (head.docKind) {
    case 'purchase_order':
      return action === 'approve' ? approvePo(deps, head.docId, actor, raw) : returnPo(deps, head.docId, raw, actor);
    case 'inv_doc':
      return action === 'approve' ? approveDoc(deps, head.docId, raw, actor) : returnDoc(deps, head.docId, raw, actor);
    case 'payment':
      return actOnPayment(deps, head.docId, action, raw, actor);
    case 'opening_payable':
      return actOnOpening(deps, head.docId, action, raw, actor);
    case 'expense_claim':
      return actOnClaim(deps, head.docId, action, raw, actor);
    // 合同与法务审查（v0.7.31）：法务那一级带审查清单
    case 'contract':
      return actOnContract(deps, head.docId, action, raw, actor);
    case 'contract_change':
      return actOnChange(deps, head.docId, action, raw, actor);
    case 'contract_seal':
      return actOnSeal(deps, head.docId, action, raw, actor);
    // 付款申请（v0.7.32）：提前付款不能批量同意
    case 'payment_request':
      return actOnPaymentRequest(deps, head.docId, action, raw, actor);
  }
}

// ───────────────────────── 审批规则 ─────────────────────────

const StepInput = z.union([
  z.object({ group: z.enum(APPROVAL_GROUPS), mode: z.literal('any').default('any') }),
  z.object({
    staffIds: z.array(id).min(1, '指定的人至少一位').max(APPROVAL_MAX_STAFF, `一级最多指定 ${APPROVAL_MAX_STAFF} 个人`),
    mode: z.enum(['any', 'all']).default('any'),
  }),
]);
const RuleBody = z
  .object({
    docType: z.enum(APPROVAL_DOC_TYPES),
    minCents: z.number().int().min(0, '金额下限不能为负').max(100_000_000_00).default(0),
    maxCents: z.number().int().positive().max(100_000_000_00).nullable().default(null),
    departmentId: id.nullable().default(null),
    steps: z.array(StepInput).min(1, '审批链至少一级').max(APPROVAL_MAX_LEVELS, `审批链最多 ${APPROVAL_MAX_LEVELS} 级`),
    allowSelf: z.boolean().default(false),
    note: z.string().trim().max(100, '说明最多 100 个字').default(''),
  })
  .refine((r) => r.maxCents === null || r.maxCents > r.minCents, { message: '金额上限要大于下限（上限不含）', path: ['maxCents'] });
const CreateRuleBody = RuleBody.and(z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') }));
const UpdateRuleBody = RuleBody.and(z.object({ version: z.number().int().positive() }));
const ActiveBody = z.object({ version: z.number().int().positive(), active: z.boolean() });

/** 指定的人要在用、能用审批中心；同一级不重复；合同、合同变更要有且只有一级「法务」，别的单据不能用「法务」（C2） */
async function checkSteps(db: Db, steps: ApprovalStep[], docType: ApprovalDocType) {
  const legal = steps.filter((s) => 'group' in s && s.group === 'legal').length;
  if (CONTRACT_REVIEW_DOC_TYPES.includes(docType)) {
    if (legal !== 1) throw unprocessable('RULE_LEGAL_REQUIRED', '合同、合同变更的审批链要有且只有一级「法务」（法务按审查清单逐条给意见）');
  } else if (legal > 0) {
    throw unprocessable('RULE_LEGAL_NOT_ALLOWED', '「法务」这一组只用于合同、合同变更');
  }
  const ids = [...new Set(steps.flatMap((s) => ('staffIds' in s ? s.staffIds : [])))];
  for (const s of steps) if ('staffIds' in s && new Set(s.staffIds).size !== s.staffIds.length) throw badRequest('同一级里指定的人重复了');
  if (ids.length === 0) return;
  const rows = await db<{ id: number; displayName: string; role: Role; duties: Duty[] | null; active: boolean }[]>`
    SELECT id, display_name, role, duties, active FROM staff WHERE id IN ${db(ids)}`;
  const overrides = await loadRoleOverrides(db);
  for (const sid of ids) {
    const s = rows.find((r) => Number(r.id) === sid);
    if (!s || !s.active) throw unprocessable('APPROVER_INVALID', '指定的人有不存在或已停用的，请重新选择');
    const who = { id: sid, role: s.role, duties: s.duties ?? [], permissions: permissionsOf({ role: s.role, duties: s.duties ?? [] }, overrides) };
    if (!hasApprovalAccess(who)) throw unprocessable('APPROVER_INVALID', `「${s.displayName}」没有审批中心的权限（岗位权限里的「审批中心：审批」），不能指定为审批人`);
  }
}

async function checkDepartment(db: Db, departmentId: number | null) {
  if (departmentId === null) return;
  const [d] = await db<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${departmentId}`;
  if (!d?.active) throw unprocessable('DEPARTMENT_INVALID', '部门不存在或已停用');
}

export async function listRules(db: Db): Promise<ApprovalRuleView[]> {
  const rows = await db<(Omit<ApprovalRuleView, 'stepLabels'> & { steps: ApprovalStep[] })[]>`
    SELECT r.id, r.doc_type, r.min_cents, r.max_cents, r.department_id, d.name AS department_name, r.steps, r.allow_self, r.note, r.active, r.version,
           cb.display_name AS created_by_name, r.created_at, ub.display_name AS updated_by_name, r.updated_at
    FROM approval_rules r JOIN staff cb ON cb.id = r.created_by LEFT JOIN staff ub ON ub.id = r.updated_by
    LEFT JOIN departments d ON d.id = r.department_id
    ORDER BY r.active DESC, r.doc_type, (r.department_id IS NOT NULL) DESC, r.min_cents DESC, r.id DESC`;
  const names = await staffNames(db, rows.flatMap((r) => r.steps.flatMap((s) => ('staffIds' in s ? s.staffIds : []))));
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    minCents: Number(r.minCents),
    maxCents: r.maxCents === null ? null : Number(r.maxCents),
    departmentId: r.departmentId === null ? null : Number(r.departmentId),
    stepLabels: r.steps.map((s) => stepLabel(s, names)),
  }));
}

async function createRule(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(CreateRuleBody, raw);
  const { clientKey, ...rule } = input;
  const requestHash = hashRequest(rule);
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM approval_rules WHERE client_key = ${clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一条规则，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 先取操作编号的咨询锁（与「确认作废」串行），确认这笔没有被作废
      await assertNotFenced(tx, clientKey, 'approval_rule', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      await checkDepartment(tx, rule.departmentId);
      await checkSteps(tx, rule.steps, rule.docType);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO approval_rules (doc_type, min_cents, max_cents, department_id, steps, allow_self, note, client_key, request_hash, created_by, updated_by)
        VALUES (${rule.docType}, ${rule.minCents}, ${rule.maxCents}, ${rule.departmentId}, ${tx.json(rule.steps as never)}, ${rule.allowSelf}, ${rule.note},
                ${clientKey}, ${requestHash}, ${actor.id}, ${actor.id})
        RETURNING id`;
      await writeAudit(tx, { staffId: actor.id, action: 'approval_rule', targetType: 'approval_rule', targetId: row!.id, detail: { op: 'create', ...rule }, ip });
      return { id: Number(row!.id), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'approval_rules_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    throw error;
  }
}

async function updateRule(deps: Deps, ruleId: number, raw: unknown, actor: Actor, ip?: string) {
  const { version, ...rule } = parse(UpdateRuleBody, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [cur] = await tx<{ version: number }[]>`SELECT version FROM approval_rules WHERE id = ${ruleId} FOR UPDATE`;
    if (!cur) throw notFound('审批规则不存在');
    if (cur.version !== version) throw conflict('VERSION_CONFLICT', '这条规则刚被别人改过，请刷新后再改');
    await checkDepartment(tx, rule.departmentId);
    await checkSteps(tx, rule.steps, rule.docType);
    await tx`
      UPDATE approval_rules SET doc_type = ${rule.docType}, min_cents = ${rule.minCents}, max_cents = ${rule.maxCents}, department_id = ${rule.departmentId},
             steps = ${tx.json(rule.steps as never)}, allow_self = ${rule.allowSelf}, note = ${rule.note}, version = version + 1,
             updated_by = ${actor.id}, updated_at = now()
      WHERE id = ${ruleId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'approval_rule', targetType: 'approval_rule', targetId: ruleId, detail: { op: 'update', ...rule }, ip });
  });
}

async function setRuleActive(deps: Deps, ruleId: number, raw: unknown, actor: Actor, ip?: string) {
  const { version, active } = parse(ActiveBody, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [cur] = await tx<{ version: number; active: boolean }[]>`SELECT version, active FROM approval_rules WHERE id = ${ruleId} FOR UPDATE`;
    if (!cur) throw notFound('审批规则不存在');
    if (cur.active === active) return;
    if (cur.version !== version) throw conflict('VERSION_CONFLICT', '这条规则刚被别人改过，请刷新后再改');
    await tx`UPDATE approval_rules SET active = ${active}, version = version + 1, updated_by = ${actor.id}, updated_at = now() WHERE id = ${ruleId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'approval_rule', targetType: 'approval_rule', targetId: ruleId, detail: { op: active ? 'activate' : 'deactivate' }, ip });
  });
}

// ───────────────────────── 代理人 ─────────────────────────

const DelegationBody = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  /** 被代理的人（请假的人）：本人给自己设；店主（维护审批规则）可以给任何人设 */
  staffId: id,
  delegateId: id,
  startsOn: dateStr,
  endsOn: dateStr,
  reason: z.string().trim().max(60, '原因最多 60 个字').default(''),
});

export async function listDelegations(db: Db, actor: Actor, timeZone: string, all: boolean): Promise<DelegationView[]> {
  const today = todayIn(timeZone);
  const rows = await db<(Omit<DelegationView, 'active'> & { active: boolean })[]>`
    SELECT g.id, g.staff_id, s.display_name AS staff_name, g.delegate_id, d.display_name AS delegate_name, g.starts_on, g.ends_on, g.reason,
           cb.display_name AS created_by_name, g.created_at, rb.display_name AS revoked_by_name, g.revoked_at,
           (g.revoked_at IS NULL AND ${today}::date BETWEEN g.starts_on AND g.ends_on) AS active
    FROM approval_delegations g JOIN staff s ON s.id = g.staff_id JOIN staff d ON d.id = g.delegate_id JOIN staff cb ON cb.id = g.created_by
    LEFT JOIN staff rb ON rb.id = g.revoked_by
    WHERE ${all ? db`true` : db`(g.staff_id = ${actor.id} OR g.delegate_id = ${actor.id})`}
      AND (g.revoked_at IS NULL OR g.revoked_at > now() - interval '30 days') AND g.ends_on >= ${today}::date - 30
    ORDER BY (g.revoked_at IS NULL AND g.ends_on >= ${today}::date) DESC, g.starts_on DESC, g.id DESC
    LIMIT 200`;
  return rows.map((r) => ({ ...r, id: Number(r.id), staffId: Number(r.staffId), delegateId: Number(r.delegateId) }));
}

async function createDelegation(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(DelegationBody, raw);
  const { clientKey, ...d } = input;
  if (d.staffId !== actor.id && !can(actor, 'approval.rules')) throw forbidden('只能给自己设代理人（给别人设要店主）');
  if (d.staffId === d.delegateId) throw badRequest('代理人不能是本人');
  if (d.endsOn < d.startsOn) throw badRequest('结束日期不能早于开始日期');
  if (daysBetween(d.startsOn, d.endsOn) + 1 > DELEGATION_MAX_DAYS) throw badRequest(`代理最多 ${DELEGATION_MAX_DAYS} 天（含首尾）`);
  if (d.endsOn < todayIn(deps.config.timezone)) throw badRequest('结束日期已经过了');
  const requestHash = hashRequest(d);
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM approval_delegations WHERE client_key = ${clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次设置，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, clientKey, 'approval_delegation', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      const people = await tx<{ id: number; displayName: string; role: Role; duties: Duty[] | null; active: boolean }[]>`
        SELECT id, display_name, role, duties, active FROM staff WHERE id IN ${tx([d.staffId, d.delegateId])}`;
      const staff = people.find((p) => Number(p.id) === d.staffId);
      const delegate = people.find((p) => Number(p.id) === d.delegateId);
      if (!staff?.active) throw unprocessable('STAFF_INVALID', '被代理的人不存在或已停用');
      if (!delegate?.active) throw unprocessable('DELEGATE_INVALID', '代理人不存在或已停用');
      const overrides = await loadRoleOverrides(tx);
      const subject = { id: d.delegateId, role: delegate.role, duties: delegate.duties ?? [], permissions: permissionsOf({ role: delegate.role, duties: delegate.duties ?? [] }, overrides) };
      if (!hasApprovalAccess(subject)) {
        throw unprocessable('DELEGATE_INVALID', `「${delegate.displayName}」没有审批中心的权限（岗位权限里的「审批中心：审批」），不能做代理人`);
      }
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO approval_delegations (staff_id, delegate_id, starts_on, ends_on, reason, client_key, request_hash, created_by)
        VALUES (${d.staffId}, ${d.delegateId}, ${d.startsOn}, ${d.endsOn}, ${d.reason}, ${clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      await writeAudit(tx, { staffId: actor.id, action: 'approval_delegation', targetType: 'approval_delegation', targetId: row!.id, detail: { op: 'create', ...d }, ip });
      return { id: Number(row!.id), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'approval_delegations_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    throw error;
  }
}

async function revokeDelegation(deps: Deps, delegationId: number, actor: Actor, ip?: string) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [g] = await tx<{ staffId: number; createdBy: number; revokedAt: string | null }[]>`
      SELECT staff_id, created_by, revoked_at FROM approval_delegations WHERE id = ${delegationId} FOR UPDATE`;
    if (!g) throw notFound('代理设置不存在');
    if (Number(g.staffId) !== actor.id && Number(g.createdBy) !== actor.id && !can(actor, 'approval.rules')) throw forbidden('只能收回自己的代理设置');
    if (g.revokedAt) return;
    await tx`UPDATE approval_delegations SET revoked_by = ${actor.id}, revoked_at = now() WHERE id = ${delegationId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'approval_delegation', targetType: 'approval_delegation', targetId: delegationId, detail: { op: 'revoke' }, ip });
  });
}

/** 规则编辑器、代理人选择用：在用、能用审批中心的员工，以及他们在哪些岗位组里 */
async function approverOptions(db: Db): Promise<ApproverOption[]> {
  const rows = await db<{ id: number; displayName: string; role: Role; duties: Duty[] | null }[]>`
    SELECT id, display_name, role, duties FROM staff WHERE active ORDER BY id`;
  const overrides = await loadRoleOverrides(db);
  return rows
    .map((r) => {
      const who = { id: Number(r.id), role: r.role, duties: r.duties ?? [], permissions: permissionsOf({ role: r.role, duties: r.duties ?? [] }, overrides) };
      return {
        who,
        option: {
          id: who.id,
          name: r.displayName,
          role: r.role,
          groups: APPROVAL_GROUPS.filter((g) => inStep({ group: g, mode: 'any' }, who, 'purchase_order') || inStep({ group: g, mode: 'any' }, who, 'expense_claim')),
        },
      };
    })
    .filter((x) => hasApprovalAccess(x.who))
    .map((x) => x.option);
}

// ───────────────────────── 路由 ─────────────────────────

const ListQuery = z.object({ tab: z.enum(['mine', 'all', 'submitted']).default('mine'), docType: z.enum(APPROVAL_DOC_TYPES).optional() });
const BatchBody = z.object({
  items: z
    .array(z.object({ id, level: z.number().int().min(1).max(APPROVAL_MAX_LEVELS) }))
    .min(1, '请至少勾选一张')
    .max(APPROVAL_BATCH_MAX, `一次最多 ${APPROVAL_BATCH_MAX} 张`),
  comment: z.string().trim().max(200, '意见最多 200 个字').default(''),
});

export function registerApprovalRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const reqId = (req: FastifyRequest) => parse(idParam, req.params).id;

  app.get('/api/approvals', { preHandler: ACT }, async (req) => {
    const q = parse(ListQuery, req.query);
    return listApprovals(sql, req.actor, config.timezone, q.tab as ApprovalTab, q.docType);
  });
  app.get('/api/approvals/count', { preHandler: ACT }, async (req) => approvalCounts(sql, req.actor, config.timezone));
  // 急采待补单（A10）：生效后超过 3 天没补采购单的，进负责人的待办
  app.get('/api/approvals/backfills', { preHandler: guard('inventory.approve') }, async () => urgentBackfills(sql, config.timezone));
  // 急采待验收（不走审批中心）：负责人的数字算上、页面上方列出来（Codex 自动审查 abe2842）
  app.get('/api/approvals/accepts', { preHandler: guard('inventory.approve') }, async (req) => urgentAwaitingAcceptance(sql, req.actor));
  app.get('/api/approvals/rules', { preHandler: ACT }, async () => listRules(sql));
  app.get('/api/approvals/approvers', { preHandler: ACT }, async () => approverOptions(sql));
  app.get('/api/approvals/delegations', { preHandler: ACT }, async (req) => {
    const { all } = parse(z.object({ all: z.enum(['1']).optional() }), req.query);
    if (all && !can(req.actor, 'approval.rules')) throw forbidden('看所有人的代理设置要店主');
    return listDelegations(sql, req.actor, config.timezone, !!all);
  });
  app.get('/api/approvals/:id', { preHandler: ACT }, async (req) => getApprovalDetail(sql, req.actor, config.timezone, reqId(req)));

  app.post('/api/approvals/:id/approve', { preHandler: ACT }, async (req) => {
    const id = reqId(req);
    const body = parse(ApproveBody, req.body ?? {});
    await actOnRequest(deps, id, 'approve', body, req.actor);
    return getApprovalDetail(sql, req.actor, config.timezone, id);
  });
  app.post('/api/approvals/:id/return', { preHandler: ACT }, async (req) => {
    const id = reqId(req);
    const body = parse(ReturnBody, req.body ?? {});
    await actOnRequest(deps, id, 'return', body, req.actor);
    return getApprovalDetail(sql, req.actor, config.timezone, id);
  });
  // 批量同意（A5）：同一种单据、每张不超过 ¥5,000，一次最多 50 张；每张单独成功或失败
  app.post('/api/approvals/batch-approve', { preHandler: ACT }, async (req): Promise<BatchApproveResult> => {
    const body = parse(BatchBody, req.body);
    if (new Set(body.items.map((i) => i.id)).size !== body.items.length) throw badRequest('同一张审批单勾了两次');
    const heads = await Promise.all(body.items.map((i) => requestHead(sql, i.id)));
    if (new Set(heads.map((h) => h.docType)).size > 1) throw badRequest('批量同意只能是同一种单据');
    const results: BatchApproveResult['results'] = [];
    for (const [i, item] of body.items.entries()) {
      const head = heads[i]!;
      // 合同、合同变更（法务要逐条给意见）、用印要逐张审（v0.7.31）
      if (NO_BATCH_DOC_TYPES.includes(head.docType as ApprovalDocType)) {
        results.push({ id: item.id, ok: false, docNo: head.docNo, code: 'APPROVAL_NO_BATCH', message: '合同、合同变更、用印要逐张审，请打开单独审' });
        continue;
      }
      if (head.amountCents === null || head.amountCents > APPROVAL_BATCH_MAX_CENTS) {
        results.push({ id: item.id, ok: false, docNo: head.docNo, code: 'BATCH_OVER_LIMIT', message: `金额超过 ¥${formatAmount(APPROVAL_BATCH_MAX_CENTS)}（或算不出），请打开单独审` });
        continue;
      }
      try {
        await actOnRequest(deps, item.id, 'approve', { level: item.level, comment: body.comment, batch: true }, req.actor);
        results.push({ id: item.id, ok: true, docNo: head.docNo });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        results.push({ id: item.id, ok: false, docNo: head.docNo, code: error.code, message: error.message });
      }
    }
    await writeAudit(sql, { staffId: req.actor.id, action: 'approval_batch', detail: { items: body.items, ok: results.filter((r) => r.ok).length }, ip: req.ip });
    return { results };
  });

  app.post('/api/approvals/rules', { preHandler: guard('approval.rules') }, async (req, reply) => {
    const r = await createRule(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return { ...r, rules: await listRules(sql) };
  });
  app.put('/api/approvals/rules/:id', { preHandler: guard('approval.rules') }, async (req) => {
    await updateRule(deps, reqId(req), req.body, req.actor, req.ip);
    return listRules(sql);
  });
  app.post('/api/approvals/rules/:id/active', { preHandler: guard('approval.rules') }, async (req) => {
    await setRuleActive(deps, reqId(req), req.body, req.actor, req.ip);
    return listRules(sql);
  });

  app.post('/api/approvals/delegations', { preHandler: ACT }, async (req, reply) => {
    const r = await createDelegation(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/approvals/delegations/:id/revoke', { preHandler: ACT }, async (req) => {
    await revokeDelegation(deps, reqId(req), req.actor, req.ip);
    return { ok: true };
  });
}
