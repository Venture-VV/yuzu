// 审批中心的引擎（v0.7.30，docs/APPROVALS.md）：提交时按规则开审批单，逐级同意、任何一级退回，撤回时关掉。
// 各单据模块在自己的事务里、锁住单据一行之后调用（锁顺序：单据 → 审批单一行 → 单据生效时照旧的锁）。
// 最后一级同意后由单据模块照旧让单据生效（同一段代码），所以默认规则下与 v0.7.29 一样一次就生效。

import {
  APPROVAL_OVERDUE_HOURS,
  CONTRACT_DEFAULT_STEPS,
  PAYMENT_EARLY_DEFAULT_STEPS,
  PAYMENT_REQUEST_DEFAULT_STEPS,
  SEAL_DEFAULT_STEPS,
  inStep,
  stepLabel,
  type ApprovalActionView,
  type ApprovalBrief,
  type ApprovalDocKind,
  type ApprovalDocType,
  type ApprovalStatus,
  type ApprovalStep,
  type ApproverSubject,
} from '@shared/approvals';
import { PAYMENT_OWNER_LEVEL_CENTS } from '@shared/payments';
import { can, permissionsOf, type Duty, type Role } from '@shared/permissions';
import { lineAmountCents } from '@shared/quantity';
import { loadRoleOverrides } from '../../auth/role-permissions';
import type { Db, Fragment, Tx } from '../../db';
import type { Actor } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { AppError, conflict } from '../../lib/errors';

/** 默认规则（没有规则命中、照现在的开关与门槛要确认的）：一级「负责人」，提交人有权限的可以一并同意 */
export const DEFAULT_STEPS: ApprovalStep[] = [{ group: 'manager', mode: 'any' }];

export interface ApprovalPlan {
  ruleId: number | null;
  ruleVersion: number | null;
  steps: ApprovalStep[];
  allowSelf: boolean;
}

export interface DocInfo {
  docType: ApprovalDocType;
  docNo: string;
  /** 算不出的（有一行没有参考价）为空：当作很大，只命中不封顶的规则 */
  amountCents: number | null;
  departmentId: number | null;
  /** 单据的提交人（没有记的取经办人） */
  submittedBy: number;
}

export interface RequestRow {
  id: number;
  docKind: ApprovalDocKind;
  docId: number;
  docType: ApprovalDocType;
  docNo: string;
  steps: ApprovalStep[];
  allowSelf: boolean;
  currentLevel: number;
  status: ApprovalStatus;
  submittedBy: number;
}

/** 能用审批中心的（审批接口的门槛） */
export function hasApprovalAccess(who: ApproverSubject): boolean {
  return can(who, 'approval.act') || can(who, 'inventory.approve') || can(who, 'expense.approve');
}

/** 这个人能不能审这一级（岗位组、指定的人，且能用审批中心） */
export function eligibleAt(step: ApprovalStep, who: ApproverSubject, kind: ApprovalDocKind): boolean {
  return inStep(step, who, kind) && hasApprovalAccess(who);
}

// ───────────────────────── 单据的金额、部门、提交人 ─────────────────────────

/** 物资单据的金额：有金额的按金额；没有的按参考价估算；盘点按各行差异数量 × 参考价取绝对值相加。有一行算不出返回 null */
async function invDocAmount(db: Db, docId: number, count: boolean): Promise<number | null> {
  const lines = await db<{ qtyMilli: number; factorMilli: number; amountCents: number | null; refPriceCents: number | null }[]>`
    SELECT l.qty_milli, l.factor_milli, l.amount_cents, m.ref_price_cents
    FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id WHERE l.doc_id = ${docId}`;
  let total = 0;
  for (const l of lines) {
    if (count) {
      if (l.qtyMilli === 0) continue;
      if (l.refPriceCents === null) return null;
      total += lineAmountCents(Math.abs(l.qtyMilli), l.refPriceCents, l.factorMilli);
    } else if (l.amountCents !== null) total += l.amountCents;
    else if (l.refPriceCents !== null) total += lineAmountCents(Math.abs(l.qtyMilli), l.refPriceCents, l.factorMilli);
    else return null;
  }
  return total;
}

const INV_TYPES: Record<string, ApprovalDocType> = { damage: 'damage', supplier_return: 'supplier_return', opening: 'opening', count: 'stocktake' };

/**
 * 没有规则命中时的审批链（默认规则）：库存、采购、货款、报销是一级负责人（与 v0.7.29 一样）；
 * 合同、合同变更是 财务 → 法务 → 负责人（C2），用印是一级店主（C7）；付款申请是 财务 → 负责人，申请金额 ≥ ¥50,000 再加一级店主（P5），
 * 提前付款是 财务 → 负责人 → 店主（P6）。默认规则里提交人有资格的可以审（与 v0.7.30 的默认规则一样）
 */
export function defaultPlanFor(docType: ApprovalDocType, amountCents: number | null = null): ApprovalPlan {
  let steps: ApprovalStep[];
  switch (docType) {
    case 'contract':
    case 'contract_change':
      steps = CONTRACT_DEFAULT_STEPS;
      break;
    case 'contract_seal':
      steps = SEAL_DEFAULT_STEPS;
      break;
    case 'payment_request':
      // 金额算不出（不该有）按大额算
      steps = amountCents === null || amountCents >= PAYMENT_OWNER_LEVEL_CENTS ? PAYMENT_EARLY_DEFAULT_STEPS : PAYMENT_REQUEST_DEFAULT_STEPS;
      break;
    case 'payment_early':
      steps = PAYMENT_EARLY_DEFAULT_STEPS;
      break;
    default:
      steps = DEFAULT_STEPS;
  }
  return { ruleId: null, ruleVersion: null, steps, allowSelf: true };
}

/** 单据在审批规则里的类型、金额、部门（docs/APPROVALS.md 第 2 节） */
export async function describeDoc(db: Db, kind: ApprovalDocKind, docId: number): Promise<DocInfo> {
  switch (kind) {
    case 'purchase_order': {
      const [p] = await db<{ docNo: string; totalCents: number; submittedBy: number }[]>`
        SELECT doc_no, total_cents, coalesce(submitted_by, created_by) AS submitted_by FROM purchase_orders WHERE id = ${docId}`;
      if (!p) throw new AppError(404, 'NOT_FOUND', '采购单不存在');
      // 采购单的需求单都来自同一个部门时取它
      const depts = await db<{ departmentId: number }[]>`
        SELECT DISTINCT r.department_id FROM purchase_order_lines pl
        JOIN purchase_order_line_requests x ON x.po_line_id = pl.id
        JOIN purchase_request_lines rl ON rl.id = x.request_line_id JOIN purchase_requests r ON r.id = rl.request_id
        WHERE pl.po_id = ${docId}`;
      return { docType: 'purchase_order', docNo: p.docNo, amountCents: Number(p.totalCents), departmentId: depts.length === 1 ? Number(depts[0]!.departmentId) : null, submittedBy: Number(p.submittedBy) };
    }
    case 'inv_doc': {
      const [d] = await db<{ docNo: string; docType: string; submittedBy: number; departmentId: number | null }[]>`
        SELECT d.doc_no, d.doc_type, coalesce(d.submitted_by, d.created_by) AS submitted_by, w.department_id
        FROM inv_docs d LEFT JOIN warehouses w ON w.id = d.warehouse_id WHERE d.id = ${docId}`;
      if (!d) throw new AppError(404, 'NOT_FOUND', '单据不存在');
      const docType = INV_TYPES[d.docType];
      if (!docType) throw conflict('APPROVAL_NOT_APPLICABLE', '这类单据不走审批中心');
      return {
        docType,
        docNo: d.docNo,
        amountCents: await invDocAmount(db, docId, d.docType === 'count'),
        // 部门小仓的报损、期初、盘点取那个部门；退供应商只在总仓
        departmentId: docType === 'supplier_return' || d.departmentId === null ? null : Number(d.departmentId),
        submittedBy: Number(d.submittedBy),
      };
    }
    case 'payment': {
      const [p] = await db<{ docNo: string; amountCents: number; createdBy: number }[]>`SELECT doc_no, amount_cents, created_by FROM payments WHERE id = ${docId}`;
      if (!p) throw new AppError(404, 'NOT_FOUND', '付款记录不存在');
      return { docType: 'payment', docNo: p.docNo, amountCents: Number(p.amountCents), departmentId: null, submittedBy: Number(p.createdBy) };
    }
    case 'opening_payable': {
      const [o] = await db<{ docNo: string; amountCents: number; createdBy: number }[]>`SELECT doc_no, amount_cents, created_by FROM opening_payables WHERE id = ${docId}`;
      if (!o) throw new AppError(404, 'NOT_FOUND', '期初未付记录不存在');
      return { docType: 'opening', docNo: o.docNo, amountCents: Number(o.amountCents), departmentId: null, submittedBy: Number(o.createdBy) };
    }
    case 'expense_claim': {
      const [c] = await db<{ docNo: string; amountCents: number; departmentId: number; createdBy: number }[]>`
        SELECT doc_no, amount_cents, department_id, created_by FROM expense_claims WHERE id = ${docId}`;
      if (!c) throw new AppError(404, 'NOT_FOUND', '报销单不存在');
      return { docType: 'expense_claim', docNo: c.docNo, amountCents: Number(c.amountCents), departmentId: Number(c.departmentId), submittedBy: Number(c.createdBy) };
    }
    // 合同（v0.7.31）：金额 = 合同总价（起草中按草稿）、部门 = 合同的部门；提交人取最近一次提交的人
    case 'contract': {
      const [c] = await db<{ docNo: string; totalCents: number; departmentId: number | null; submittedBy: number }[]>`
        SELECT c.contract_no AS doc_no, c.total_cents, c.department_id,
               coalesce((SELECT r.submitted_by FROM contract_revisions r WHERE r.contract_id = c.id AND r.change_id IS NULL ORDER BY r.seq DESC LIMIT 1), c.created_by) AS submitted_by
        FROM contracts c WHERE c.id = ${docId}`;
      if (!c) throw new AppError(404, 'NOT_FOUND', '合同不存在');
      return { docType: 'contract', docNo: c.docNo, amountCents: Number(c.totalCents), departmentId: c.departmentId === null ? null : Number(c.departmentId), submittedBy: Number(c.submittedBy) };
    }
    // 合同变更：金额 = 改前改后总价之差的绝对值（C10）
    case 'contract_change': {
      const [c] = await db<{ docNo: string; deltaCents: number; departmentId: number | null; submittedBy: number }[]>`
        SELECT x.change_no AS doc_no, x.delta_cents, c.department_id,
               coalesce((SELECT r.submitted_by FROM contract_revisions r WHERE r.change_id = x.id ORDER BY r.seq DESC LIMIT 1), x.created_by) AS submitted_by
        FROM contract_changes x JOIN contracts c ON c.id = x.contract_id WHERE x.id = ${docId}`;
      if (!c) throw new AppError(404, 'NOT_FOUND', '变更单不存在');
      return { docType: 'contract_change', docNo: c.docNo, amountCents: Number(c.deltaCents), departmentId: c.departmentId === null ? null : Number(c.departmentId), submittedBy: Number(c.submittedBy) };
    }
    // 用印：金额 = 合同总价
    case 'contract_seal': {
      const [s] = await db<{ docNo: string; totalCents: number; departmentId: number | null; createdBy: number }[]>`
        SELECT s.seal_no AS doc_no, c.total_cents, c.department_id, s.created_by
        FROM contract_seals s JOIN contracts c ON c.id = s.contract_id WHERE s.id = ${docId}`;
      if (!s) throw new AppError(404, 'NOT_FOUND', '用印申请不存在');
      return { docType: 'contract_seal', docNo: s.docNo, amountCents: Number(s.totalCents), departmentId: s.departmentId === null ? null : Number(s.departmentId), submittedBy: Number(s.createdBy) };
    }
    // 付款申请（v0.7.32）：提前付款是单独的单据类型；金额 = 申请金额、部门 = 合同的部门；提交人取最近一次提交的人
    case 'payment_request': {
      const [r] = await db<{ docNo: string; amountCents: number; early: boolean; departmentId: number | null; submittedBy: number }[]>`
        SELECT request_no AS doc_no, amount_cents, early, department_id, submitted_by FROM payment_requests WHERE id = ${docId}`;
      if (!r) throw new AppError(404, 'NOT_FOUND', '付款申请不存在');
      return {
        docType: r.early ? 'payment_early' : 'payment_request',
        docNo: r.docNo,
        amountCents: Number(r.amountCents),
        departmentId: r.departmentId === null ? null : Number(r.departmentId),
        submittedBy: Number(r.submittedBy),
      };
    }
  }
}

// ───────────────────────── 规则命中（A1） ─────────────────────────

/**
 * 同一单据类型、金额落在区间里（含下限、不含上限；金额算不出的只命中不封顶的）、部门对得上（规则的部门为空或等于单据的部门）
 * 的规则里取最具体的一条：指定了部门的优先，其次下限高的，再其次后建的。没有命中：fallback（现在的开关与门槛要确认）为真时
 * 用默认规则（一级负责人），否则不用审批。
 */
export async function planApproval(db: Db, input: { docType: ApprovalDocType; amountCents: number | null; departmentId: number | null; fallback: boolean }): Promise<ApprovalPlan | null> {
  const amount = input.amountCents;
  const [rule] = await db<{ id: number; version: number; steps: ApprovalStep[]; allowSelf: boolean }[]>`
    SELECT id, version, steps, allow_self FROM approval_rules
    WHERE active AND doc_type = ${input.docType}
      AND (department_id IS NULL OR department_id = ${input.departmentId})
      AND ${amount === null ? db`max_cents IS NULL` : db`min_cents <= ${amount} AND (max_cents IS NULL OR ${amount} < max_cents)`}
    ORDER BY (department_id IS NOT NULL) DESC, min_cents DESC, id DESC
    LIMIT 1`;
  if (rule) return { ruleId: Number(rule.id), ruleVersion: rule.version, steps: rule.steps, allowSelf: rule.allowSelf };
  return input.fallback ? defaultPlanFor(input.docType, input.amountCents) : null;
}

// ───────────────────────── 开审批单 ─────────────────────────

async function insertRequest(tx: Tx, kind: ApprovalDocKind, docId: number, info: DocInfo, plan: ApprovalPlan, submittedBy: number): Promise<number> {
  // 同一单据同时只有一张在审的审批单（部分唯一索引兜底）：之前没关掉的（不该有）先关掉，按这次提交重新走
  await tx`
    UPDATE approval_requests SET status = 'cancelled', finished_at = now(), finished_by = ${submittedBy}
    WHERE doc_kind = ${kind} AND doc_id = ${docId} AND status = 'pending'`;
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO approval_requests (doc_kind, doc_id, doc_type, doc_no, amount_cents, department_id, rule_id, rule_version, steps, allow_self, submitted_by)
    VALUES (${kind}, ${docId}, ${info.docType}, ${info.docNo}, ${info.amountCents}, ${info.departmentId}, ${plan.ruleId}, ${plan.ruleVersion},
            ${tx.json(plan.steps as never)}, ${plan.allowSelf}, ${submittedBy})
    RETURNING id`;
  return Number(row!.id);
}

export interface SubmitResult {
  /** effective：不用审批（或提交人一并同意了最后一级），调用方照旧让单据生效；pending：等审批 */
  outcome: 'effective' | 'pending';
  requestId: number | null;
  /** 不用审批是因为没有规则命中、现在的开关与门槛也不用确认 */
  skipped: boolean;
}

/**
 * 单据提交时（调用方已锁住单据一行、把单据改成待确认）：按规则决定要不要审批，要的开一张审批单。
 * fallback：没有规则命中时照现在的开关与门槛要不要确认。approveNow：提交人一并同意第一级（要能审这一级）。
 */
export async function submitForApproval(
  tx: Tx,
  kind: ApprovalDocKind,
  docId: number,
  ctx: { actor: Actor; timeZone: string },
  opts: { fallback: boolean; approveNow?: boolean; comment?: string },
): Promise<SubmitResult> {
  const info = await describeDoc(tx, kind, docId);
  const plan = await planApproval(tx, { docType: info.docType, amountCents: info.amountCents, departmentId: info.departmentId, fallback: opts.fallback });
  if (!plan) return { outcome: 'effective', requestId: null, skipped: true };
  const requestId = await insertRequest(tx, kind, docId, info, plan, ctx.actor.id);
  if (opts.approveNow) {
    const r = await approveCurrent(tx, kind, docId, ctx, { comment: opts.comment ?? '', selfSubmit: true });
    if (r === 'final') return { outcome: 'effective', requestId, skipped: false };
  }
  return { outcome: 'pending', requestId, skipped: false };
}

// ───────────────────────── 谁能审 ─────────────────────────

/** 今天在代理期内、没收回、委托人在用的代理（delegate = 这个人）：委托人的岗位、职责与按后台调整算好的权限 */
export async function delegatorsOf(db: Db, delegateId: number, today: string): Promise<ApproverSubject[]> {
  const rows = await db<{ id: number; role: Role; duties: Duty[] | null }[]>`
    SELECT DISTINCT s.id, s.role, s.duties FROM approval_delegations g JOIN staff s ON s.id = g.staff_id
    WHERE g.delegate_id = ${delegateId} AND g.revoked_at IS NULL AND ${today}::date BETWEEN g.starts_on AND g.ends_on AND s.active
    ORDER BY s.id`;
  if (rows.length === 0) return [];
  const overrides = await loadRoleOverrides(db);
  return rows.map((r) => {
    const duties = r.duties ?? [];
    return { id: Number(r.id), role: r.role, duties, permissions: permissionsOf({ role: r.role, duties }, overrides) };
  });
}

export interface Standing {
  /** 本人能审这一级 */
  self: boolean;
  /** 能替谁审（代理） */
  behalf: number[];
  /** 提交人不能审自己的单挡住了 */
  selfBlocked: boolean;
}

/** 这个人对审批单当前这一级的资格（不看会签里已经同意过的） */
export function standingOf(
  req: { docKind: ApprovalDocKind; steps: ApprovalStep[]; currentLevel: number; allowSelf: boolean; submittedBy: number },
  who: ApproverSubject,
  delegators: ApproverSubject[],
): Standing {
  const step = req.steps[req.currentLevel - 1]!;
  // 提交人不能审自己的单（规则里可以改）：哪一级都不能同意或退回，也不能借代理审
  const selfBlocked = !req.allowSelf && who.id === req.submittedBy;
  if (selfBlocked) return { self: false, behalf: [], selfBlocked };
  return {
    self: eligibleAt(step, who, req.docKind),
    behalf: delegators
      .filter((d) => d.id !== who.id && (req.allowSelf || d.id !== req.submittedBy) && eligibleAt(step, d, req.docKind))
      .map((d) => d.id),
    selfBlocked,
  };
}

/** 会签这一级要谁同意：指定的人（提交人不能审自己的单时，提交人自己那一份不用） */
export function requiredOf(req: { steps: ApprovalStep[]; currentLevel: number; allowSelf: boolean; submittedBy: number }): number[] | null {
  const step = req.steps[req.currentLevel - 1]!;
  if (!('staffIds' in step) || step.mode !== 'all') return null;
  return step.staffIds.filter((id) => req.allowSelf || id !== req.submittedBy);
}

export async function staffNames(db: Db, ids: number[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return new Map();
  const rows = await db<{ id: number; displayName: string }[]>`SELECT id, display_name FROM staff WHERE id IN ${db(uniq)}`;
  return new Map(rows.map((r) => [Number(r.id), r.displayName]));
}

async function notEligible(db: Db, req: RequestRow, standing: Standing, selfSubmit = false): Promise<AppError> {
  const undo = selfSubmit ? '；请去掉「同时确认」后提交' : '';
  if (standing.selfBlocked) {
    return new AppError(403, 'APPROVAL_SELF_FORBIDDEN', `按审批规则，提交人不能审自己的单（也不能借代理审），要交给其他审批人${undo}`);
  }
  const step = req.steps[req.currentLevel - 1]!;
  const names = await staffNames(db, 'staffIds' in step ? step.staffIds : []);
  const levels = req.steps.length > 1 ? `第 ${req.currentLevel} 级（共 ${req.steps.length} 级）` : '这一级';
  return new AppError(403, 'APPROVAL_NOT_ELIGIBLE', `这张单${levels}由「${stepLabel(step, names)}」审批，你不在这一级的审批人里${undo}`, { level: req.currentLevel });
}

// ───────────────────────── 同意、退回、关掉 ─────────────────────────

/** 锁住单据在审的那张审批单（调用方已锁住单据一行）；没有返回 null。合同类按当前这一级是不是法务决定要不要审查清单 */
export async function lockPending(tx: Tx, kind: ApprovalDocKind, docId: number): Promise<RequestRow | null> {
  const [r] = await tx<RequestRow[]>`
    SELECT id, doc_kind, doc_id, doc_type, doc_no, steps, allow_self, current_level, status, submitted_by
    FROM approval_requests WHERE doc_kind = ${kind} AND doc_id = ${docId} AND status = 'pending' FOR UPDATE`;
  return r ? { ...r, id: Number(r.id), docId: Number(r.docId), submittedBy: Number(r.submittedBy) } : null;
}

/**
 * 待确认的单据还没有审批单（迁移以后都有；兜底给旧数据、手工数据）：按默认规则补一张再审，与 v0.7.29 一样。
 * 页面带着审批单号来的（看的是别的审批单）不补，按「已经变了」拒绝。
 */
async function pendingOrDefault(tx: Tx, kind: ApprovalDocKind, docId: number, requestId: number | undefined): Promise<RequestRow> {
  const found = await lockPending(tx, kind, docId);
  if (found) return found;
  if (requestId !== undefined) throw conflict('APPROVAL_MOVED', '这张单的审批已经变了（退回、撤回或重新提交），请刷新后再看');
  const info = await describeDoc(tx, kind, docId);
  await insertRequest(tx, kind, docId, info, defaultPlanFor(info.docType, info.amountCents), info.submittedBy);
  return (await lockPending(tx, kind, docId))!;
}

export interface ActOptions {
  /** 页面看到的审批单与级别：审批单已经变了或走到别的级别（别人刚审过）拒绝 APPROVAL_MOVED */
  requestId?: number;
  level?: number;
  comment?: string;
  /** 批量同意 */
  batch?: boolean;
  /** 提交时一并同意第一级 */
  selfSubmit?: boolean;
}

export type ApproveOutcome = 'final' | 'advanced' | 'partial' | 'already';

/**
 * 同意当前这一级。final：最后一级也同意了，调用方让单据生效；advanced：进下一级；partial：会签还有人没同意；
 * already：同一个人对同一级重复同意（不重复记）。
 */
export async function approveCurrent(tx: Tx, kind: ApprovalDocKind, docId: number, ctx: { actor: Actor; timeZone: string }, opts: ActOptions = {}): Promise<ApproveOutcome> {
  const { actor } = ctx;
  const req = await pendingOrDefault(tx, kind, docId, opts.requestId);
  if (opts.requestId !== undefined && opts.requestId !== req.id) throw conflict('APPROVAL_MOVED', '这张单已经退回后重新提交过，请刷新后再看');
  if (opts.level !== undefined && opts.level !== req.currentLevel) {
    if (opts.level < req.currentLevel) {
      const [mine] = await tx<{ n: number }[]>`
        SELECT count(*) AS n FROM approval_actions WHERE request_id = ${req.id} AND level = ${opts.level} AND action = 'approve' AND actor_id = ${actor.id}`;
      if (mine!.n > 0) return 'already';
    }
    throw conflict('APPROVAL_MOVED', `这张单已经走到第 ${req.currentLevel} 级（别人刚审过），请刷新后再看`, { level: req.currentLevel });
  }
  const delegators = await delegatorsOf(tx, actor.id, todayIn(ctx.timeZone));
  const standing = standingOf(req, actor, delegators);
  const required = requiredOf(req);
  const comment = opts.comment ?? '';
  const record = (onBehalfOf: number | null) => tx`
    INSERT INTO approval_actions (request_id, level, action, actor_id, on_behalf_of, comment, batch)
    VALUES (${req.id}, ${req.currentLevel}, 'approve', ${actor.id}, ${onBehalfOf}, ${comment}, ${!!opts.batch})`;

  let complete: boolean;
  if (required === null) {
    // 或签：本人能审按本人记，否则按代理记（替第一位委托人）
    if (standing.self) await record(null);
    else if (standing.behalf.length > 0) await record(standing.behalf[0]!);
    else throw await notEligible(tx, req, standing, opts.selfSubmit);
    complete = true;
  } else {
    const done = await tx<{ who: number }[]>`
      SELECT DISTINCT coalesce(on_behalf_of, actor_id) AS who FROM approval_actions
      WHERE request_id = ${req.id} AND level = ${req.currentLevel} AND action = 'approve'`;
    const filled = new Set(done.map((d) => Number(d.who)));
    if (standing.self && actor.role === 'owner') {
      // 店主在每一级都能审：会签时店主同意即这一级通过（有人离职、停用时不会卡住）
      if (filled.has(actor.id)) return 'already';
      await record(null);
      complete = true;
    } else {
      const fills: (number | null)[] = [];
      if (standing.self && required.includes(actor.id) && !filled.has(actor.id)) fills.push(null);
      for (const b of standing.behalf) if (required.includes(b) && !filled.has(b)) fills.push(b);
      // 代理店主（Codex 自动审查 c0acccf）：店主请假设了代理人，代理人能做店主能做的——会签时店主同意即这一级通过，
      // 代理人替店主同意也一样（记「代 店主」）；本人或别的委托人也有要签的份时一并记上
      const owner = standing.behalf.find((b) => !filled.has(b) && delegators.some((d) => d.id === b && d.role === 'owner'));
      if (owner !== undefined && !fills.includes(owner)) fills.push(owner);
      if (fills.length === 0) {
        if ((standing.self && filled.has(actor.id)) || standing.behalf.some((b) => filled.has(b))) return 'already';
        throw await notEligible(tx, req, standing, opts.selfSubmit);
      }
      for (const f of fills) {
        await record(f);
        filled.add(f ?? actor.id);
      }
      complete = owner !== undefined || required.every((id) => filled.has(id));
    }
  }
  if (!complete) return 'partial';
  if (req.currentLevel >= req.steps.length) {
    await tx`UPDATE approval_requests SET status = 'approved', finished_at = now(), finished_by = ${actor.id} WHERE id = ${req.id}`;
    return 'final';
  }
  await tx`UPDATE approval_requests SET current_level = current_level + 1, level_started_at = now() WHERE id = ${req.id}`;
  return 'advanced';
}

/** 退回（任何一级，原因至少 2 个字）：审批单结束，调用方照旧把单据退回经办人 */
export async function returnCurrent(tx: Tx, kind: ApprovalDocKind, docId: number, ctx: { actor: Actor; timeZone: string }, opts: ActOptions & { reason: string }) {
  const { actor } = ctx;
  const req = await pendingOrDefault(tx, kind, docId, opts.requestId);
  if (opts.requestId !== undefined && opts.requestId !== req.id) throw conflict('APPROVAL_MOVED', '这张单已经退回后重新提交过，请刷新后再看');
  if (opts.level !== undefined && opts.level !== req.currentLevel) {
    throw conflict('APPROVAL_MOVED', `这张单已经走到第 ${req.currentLevel} 级（别人刚审过），请刷新后再看`, { level: req.currentLevel });
  }
  const standing = standingOf(req, actor, await delegatorsOf(tx, actor.id, todayIn(ctx.timeZone)));
  const onBehalfOf = standing.self ? null : (standing.behalf[0] ?? undefined);
  if (onBehalfOf === undefined) throw await notEligible(tx, req, standing);
  await tx`
    INSERT INTO approval_actions (request_id, level, action, actor_id, on_behalf_of, comment, batch)
    VALUES (${req.id}, ${req.currentLevel}, 'return', ${actor.id}, ${onBehalfOf}, ${opts.reason}, false)`;
  await tx`UPDATE approval_requests SET status = 'returned', finished_at = now(), finished_by = ${actor.id} WHERE id = ${req.id}`;
}

/** 单据撤回（作废没生效的）时把在审的审批单一起关掉 */
export async function closeApproval(tx: Tx, kind: ApprovalDocKind, docId: number, actor: Actor) {
  await tx`
    UPDATE approval_requests SET status = 'cancelled', finished_at = now(), finished_by = ${actor.id}
    WHERE doc_kind = ${kind} AND doc_id = ${docId} AND status = 'pending'`;
}

// ───────────────────────── 单据详情里的一句话 ─────────────────────────

export async function actionsOf(db: Db, requestIds: number[]): Promise<Map<number, ApprovalActionView[]>> {
  const out = new Map<number, ApprovalActionView[]>();
  if (requestIds.length === 0) return out;
  const rows = await db<(ApprovalActionView & { requestId: number })[]>`
    SELECT a.id, a.request_id, a.level, a.action, a.actor_id, s.display_name AS actor_name, a.on_behalf_of, b.display_name AS on_behalf_of_name,
           a.comment, a.batch, a.created_at
    FROM approval_actions a JOIN staff s ON s.id = a.actor_id LEFT JOIN staff b ON b.id = a.on_behalf_of
    WHERE a.request_id IN ${db(requestIds)} ORDER BY a.id`;
  for (const r of rows) {
    const { requestId, ...view } = r;
    const v = { ...view, id: Number(view.id), actorId: Number(view.actorId), onBehalfOf: view.onBehalfOf === null ? null : Number(view.onBehalfOf) };
    const list = out.get(Number(requestId)) ?? [];
    list.push(v);
    out.set(Number(requestId), list);
  }
  return out;
}

/** 单据详情里的审批进度：在审的那张，没有在审的取最近一张；从没走过审批中心的为空 */
export async function approvalBrief(db: Db, kind: ApprovalDocKind, docId: number): Promise<ApprovalBrief | null> {
  return briefOf(db, db`doc_kind = ${kind} AND doc_id = ${docId}`);
}

/** 指定的那张审批单的进度（合同的每一份提交记录各对着一张，v0.7.31） */
export async function approvalBriefById(db: Db, requestId: number): Promise<ApprovalBrief | null> {
  return briefOf(db, db`id = ${requestId}`);
}

async function briefOf(db: Db, where: Fragment): Promise<ApprovalBrief | null> {
  const [r] = await db<{
    id: number;
    status: ApprovalStatus;
    ruleId: number | null;
    currentLevel: number;
    steps: ApprovalStep[];
    allowSelf: boolean;
    submittedBy: number;
    levelStartedAt: string;
    overdue: boolean;
  }[]>`
    SELECT id, status, rule_id, current_level, steps, allow_self, submitted_by, level_started_at,
           (status = 'pending' AND level_started_at < now() - make_interval(hours => ${APPROVAL_OVERDUE_HOURS})) AS overdue
    FROM approval_requests WHERE ${where}
    ORDER BY (status = 'pending') DESC, id DESC LIMIT 1`;
  if (!r) return null;
  const id = Number(r.id);
  const actions = (await actionsOf(db, [id])).get(id) ?? [];
  const names = await staffNames(db, r.steps.flatMap((s) => ('staffIds' in s ? s.staffIds : [])));
  return {
    requestId: id,
    status: r.status,
    ruleId: r.ruleId === null ? null : Number(r.ruleId),
    currentLevel: r.currentLevel,
    levels: r.steps.length,
    steps: r.steps,
    stepLabels: r.steps.map((s) => stepLabel(s, names)),
    allowSelf: r.allowSelf,
    submittedBy: Number(r.submittedBy),
    levelStartedAt: r.levelStartedAt,
    overdue: r.overdue,
    approvedIds: [...new Set(actions.filter((a) => a.level === r.currentLevel && a.action === 'approve').map((a) => a.onBehalfOf ?? a.actorId))],
    actions,
  };
}

// ───────────────────────── 自检 ─────────────────────────

/**
 * 审批中心自检（进 `check`）：每张待确认的单据（急采验收除外）有且只有一张在审的审批单；每张在审的审批单，单据都还在待确认；
 * 在审的审批单当前这一级不超过审批链的级数（约束兜底）。
 */
export async function approvalChecks(db: Db): Promise<{ key: string; label: string; ok: boolean; detail: string }> {
  const docs = await db<{ docNo: string; n: number }[]>`
    SELECT d.doc_no, (SELECT count(*) FROM approval_requests r WHERE r.doc_kind = d.kind AND r.doc_id = d.id AND r.status = 'pending') AS n
    FROM (
      SELECT 'purchase_order' AS kind, id, doc_no FROM purchase_orders WHERE status = 'submitted'
      UNION ALL SELECT 'inv_doc', id, doc_no FROM inv_docs
        WHERE status = 'submitted' AND doc_type IN ('damage', 'supplier_return', 'opening', 'count') AND NOT urgent
      UNION ALL SELECT 'payment', id, doc_no FROM payments WHERE status = 'submitted'
      UNION ALL SELECT 'opening_payable', id, doc_no FROM opening_payables WHERE status = 'submitted'
      UNION ALL SELECT 'expense_claim', id, doc_no FROM expense_claims WHERE status = 'submitted'
      UNION ALL SELECT 'contract', id, contract_no FROM contracts WHERE status = 'reviewing'
      UNION ALL SELECT 'contract_change', id, change_no FROM contract_changes WHERE status = 'reviewing'
      UNION ALL SELECT 'contract_seal', id, seal_no FROM contract_seals WHERE status = 'reviewing'
      UNION ALL SELECT 'payment_request', id, request_no FROM payment_requests WHERE status = 'submitted'
    ) d
    WHERE (SELECT count(*) FROM approval_requests r WHERE r.doc_kind = d.kind AND r.doc_id = d.id AND r.status = 'pending') <> 1`;
  const orphans = await db<{ docNo: string }[]>`
    SELECT r.doc_no FROM approval_requests r
    WHERE r.status = 'pending' AND coalesce(CASE r.doc_kind
      WHEN 'purchase_order' THEN (SELECT status FROM purchase_orders WHERE id = r.doc_id)
      WHEN 'inv_doc' THEN (SELECT status FROM inv_docs WHERE id = r.doc_id)
      WHEN 'payment' THEN (SELECT status FROM payments WHERE id = r.doc_id)
      WHEN 'opening_payable' THEN (SELECT status FROM opening_payables WHERE id = r.doc_id)
      WHEN 'expense_claim' THEN (SELECT status FROM expense_claims WHERE id = r.doc_id)
      WHEN 'contract' THEN (SELECT CASE status WHEN 'reviewing' THEN 'submitted' ELSE status END FROM contracts WHERE id = r.doc_id)
      WHEN 'contract_change' THEN (SELECT CASE status WHEN 'reviewing' THEN 'submitted' ELSE status END FROM contract_changes WHERE id = r.doc_id)
      WHEN 'contract_seal' THEN (SELECT CASE status WHEN 'reviewing' THEN 'submitted' ELSE status END FROM contract_seals WHERE id = r.doc_id)
      WHEN 'payment_request' THEN (SELECT status FROM payment_requests WHERE id = r.doc_id)
    END, '') <> 'submitted'`;
  const bad = [
    ...docs.map((d) => `${d.docNo} 待确认但${d.n === 0 ? '没有在审的审批单' : `有 ${d.n} 张在审的审批单`}`),
    ...orphans.map((o) => `${o.docNo} 的审批单在审，单据已不在待确认`),
  ];
  return {
    key: 'approval_requests',
    label: '审批中心：待确认的单据各有一张在审的审批单，在审的审批单单据都还在待确认',
    ok: bad.length === 0,
    detail: bad.length ? bad.join('；') : '一致',
  };
}
