// 零采备用金（8.1.9，docs/ERP_V819.md 第 2 节，PENDING_DECISIONS「8.1.9」BJ1–BJ8）。
//
// 口径：
//   · 总额是 ERP 设置里的 petty_pool（店主改，全公司一份）；没配置时不能申用。
//   · 申用登记即占用；挂的报销单（「费用报销」里钱从「零采备用金」来的）确认后不再占用 = 自动回补，不另记回补单据；
//     报销单撤回、冲销以后这笔申用又回到占用。状态从报销单推出来（POOL_USE_STATE_SQL），不另存。
//   · 剩余可用 = 总额 − 已占用；申用不能超过剩余可用（BJ3）。
// 加锁：
//   · 申用：操作编号的咨询锁（与「确认作废」串行）→ 零采备用金的咨询锁（申用都串行，在锁里算占用）→ 写申用；读报销单、总额不加锁。
//   · 提交 / 撤回报销、更新补单、作废：只锁申用一行（带版本号）；读采购单不加锁；撤回、作废在锁里核对没挂着有效的报销单。
//   · 财务登记报销（expenses.ts 的 createClaim）：操作编号 → 这几笔申用（id 升序，FOR UPDATE，lockPoolUsesForClaim）→ 采购单 → 发票 → 预算。
//     报销单的确认、退回、撤回、冲销不锁申用。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CLAIM_STATUS_LABELS } from '@shared/expenses';
import { formatAmount } from '@shared/money';
import {
  DEFAULT_POOL_SETTINGS,
  POOL_BACKFILL_LABELS,
  POOL_BACKFILLS,
  POOL_USE_STATE_LABELS,
  POOL_USE_STATES,
  type PoolBoard,
  type PoolClaimRef,
  type PoolPoOption,
  type PoolSettings,
  type PoolSummary,
  type PoolUseBrief,
  type PoolUseDetail,
  type PoolUseForClaim,
  type PoolUseRow,
  type PoolUseState,
} from '@shared/petty-pool';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Actor, type Deps } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { checkDateRange, todayIn } from '../lib/dates';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { saveRuleSetting } from '../lib/rule-settings';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { idParam, parse, positiveCents } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { assertNotFuture, docDateSchema } from './inventory/common';

const SETTING_KEY = 'petty_pool';
const LIST_LIMIT = 1000;
const EXPORT_LIMIT = 20_000;
const ACTIVE_CLAIM = ['submitted', 'returned', 'confirmed'] as const;
const id = z.number().int().positive();
const yuan = (cents: number) => (cents < 0 ? '-' : '') + formatAmount(Math.abs(cents)).replace(/,/g, '');

// ───────────────────────── 设置 ─────────────────────────

export async function loadPoolSettings(db: Db): Promise<PoolSettings> {
  const [row] = await db<{ value: Partial<PoolSettings> }[]>`SELECT value FROM settings WHERE key = ${SETTING_KEY}`;
  const v = row?.value ?? {};
  return {
    totalCents: typeof v.totalCents === 'number' ? v.totalCents : DEFAULT_POOL_SETTINGS.totalCents,
    departmentId: typeof v.departmentId === 'number' ? v.departmentId : DEFAULT_POOL_SETTINGS.departmentId,
  };
}

const SettingsInput = z.object({
  totalCents: z.number('总额必须是数字').int('总额要精确到分').min(0, '总额不能为负').max(1_000_000_000, '总额最多 1,000 万元').nullable(),
  departmentId: id.nullable(),
});

async function saveSettings(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<PoolSettings> {
  const input = parse(SettingsInput, raw);
  if (input.departmentId !== null) {
    const [d] = await deps.sql<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${input.departmentId}`;
    if (!d?.active) throw unprocessable('DEPARTMENT_INVALID', '归属部门不存在或已停用');
  }
  return saveRuleSetting(deps.sql, SETTING_KEY, loadPoolSettings, () => ({ totalCents: input.totalCents, departmentId: input.departmentId }), { actor, ip });
}

// ───────────────────────── 台账 ─────────────────────────

/** 一笔申用现在挂着的有效报销单（待确认、退回、已确认；按约定最多一张） */
const currentClaim = (db: Db) => db`
  LEFT JOIN LATERAL (
    SELECT c.id, c.doc_no, c.status, c.amount_cents, c.confirmed_at FROM expense_claim_pool_uses l JOIN expense_claims c ON c.id = l.claim_id
    WHERE l.use_id = u.id AND c.status IN ${db(ACTIVE_CLAIM)} ORDER BY c.id DESC LIMIT 1
  ) cl ON true`;

/** 从申用与它挂着的报销单推出状态 */
const STATE_SQL = `CASE WHEN u.status = 'voided' THEN 'voided' WHEN cl.status = 'confirmed' THEN 'reimbursed' WHEN cl.id IS NOT NULL THEN 'reviewing'
  WHEN u.claim_state = 'submitted' THEN 'submitted' ELSE 'open' END`;

interface UseFilter {
  ids?: number[];
  state?: PoolUseState;
  applicantId?: number;
  backfill?: 'pending' | 'done' | 'none';
  from?: string;
  to?: string;
}

interface RawUse {
  id: number;
  docNo: string;
  useDate: string;
  applicantId: number;
  applicantName: string;
  purpose: string;
  content: string;
  amountCents: number;
  note: string;
  state: PoolUseState;
  backfill: 'pending' | 'done' | null;
  poId: number | null;
  poNo: string | null;
  supplierName: string | null;
  submitNote: string;
  submittedAt: string | null;
  submittedByName: string | null;
  claimId: number | null;
  claimNo: string | null;
  claimStatus: PoolClaimRef['status'] | null;
  claimAmountCents: number | null;
  claimConfirmedAt: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  createdByName: string;
  createdAt: string;
  version: number;
  isSynthetic: boolean;
}

function useRows(db: Db, f: UseFilter, limit: number | null) {
  return db<RawUse[]>`
    SELECT * FROM (
      SELECT u.id, u.doc_no, u.use_date, u.applicant_id, a.display_name AS applicant_name, u.purpose, u.content, u.amount_cents, u.note,
             ${db.unsafe(STATE_SQL)} AS state, u.backfill, po.id AS po_id, po.doc_no AS po_no, s.name AS supplier_name,
             u.submit_note, u.submitted_at, sb.display_name AS submitted_by_name,
             cl.id AS claim_id, cl.doc_no AS claim_no, cl.status AS claim_status, cl.amount_cents AS claim_amount_cents, cl.confirmed_at AS claim_confirmed_at,
             u.void_reason, u.voided_at, vb.display_name AS voided_by_name, cb.display_name AS created_by_name, u.created_at, u.version, u.is_synthetic
      FROM petty_pool_uses u
      JOIN staff a ON a.id = u.applicant_id
      JOIN staff cb ON cb.id = u.created_by
      LEFT JOIN staff sb ON sb.id = u.submitted_by
      LEFT JOIN staff vb ON vb.id = u.voided_by
      LEFT JOIN purchase_orders po ON po.id = u.purchase_order_id
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      ${currentClaim(db)}
      WHERE TRUE
        ${f.ids ? db`AND u.id IN ${db(f.ids)}` : db``}
        ${f.applicantId ? db`AND u.applicant_id = ${f.applicantId}` : db``}
        ${f.backfill === 'none' ? db`AND u.backfill IS NULL` : f.backfill ? db`AND u.backfill = ${f.backfill}` : db``}
        ${f.from ? db`AND u.use_date >= ${f.from}` : db``}
        ${f.to ? db`AND u.use_date <= ${f.to}` : db``}
    ) x
    WHERE TRUE ${f.state ? db`AND x.state = ${f.state}` : db``}
    ORDER BY x.use_date DESC, x.id DESC
    ${limit ? db`LIMIT ${limit}` : db``}`;
}

function toRow(r: RawUse): PoolUseRow {
  return {
    id: Number(r.id),
    docNo: r.docNo,
    useDate: r.useDate,
    applicant: { id: Number(r.applicantId), name: r.applicantName },
    purpose: r.purpose,
    content: r.content,
    amountCents: Number(r.amountCents),
    note: r.note,
    state: r.state,
    backfill: r.backfill,
    purchaseOrder: r.poId ? { id: Number(r.poId), docNo: r.poNo!, supplierName: r.supplierName ?? '' } : null,
    submitNote: r.submitNote,
    submittedAt: r.submittedAt,
    submittedByName: r.submittedByName,
    claim: r.claimId ? { id: Number(r.claimId), docNo: r.claimNo!, status: r.claimStatus!, amountCents: Number(r.claimAmountCents), confirmedAt: r.claimConfirmedAt } : null,
    voidReason: r.voidReason,
    voidedAt: r.voidedAt,
    voidedByName: r.voidedByName,
    createdByName: r.createdByName,
    createdAt: r.createdAt,
    version: Number(r.version),
    isSynthetic: r.isSynthetic,
  };
}

/** 面板上的几个数：按全部申用算（不受列表筛选与张数限制） */
export async function poolSummary(db: Db, timezone: string, settings?: PoolSettings): Promise<PoolSummary> {
  const s = settings ?? (await loadPoolSettings(db));
  const monthStart = `${todayIn(timezone).slice(0, 8)}01`;
  const rows = await db<{ state: PoolUseState; count: number; cents: number }[]>`
    SELECT x.state, count(*)::int AS count, coalesce(sum(x.amount_cents), 0)::bigint AS cents FROM (
      SELECT u.amount_cents, ${db.unsafe(STATE_SQL)} AS state FROM petty_pool_uses u ${currentClaim(db)} WHERE u.status = 'active'
    ) x GROUP BY x.state`;
  const [month] = await db<{ count: number; cents: number }[]>`
    SELECT count(*)::int AS count, coalesce(sum(u.amount_cents), 0)::bigint AS cents
    FROM petty_pool_uses u ${currentClaim(db)}
    WHERE u.status = 'active' AND cl.status = 'confirmed' AND cl.confirmed_at >= (${monthStart}::date)::timestamp AT TIME ZONE ${timezone}`;
  const of = (st: 'open' | 'submitted' | 'reviewing') => {
    const r = rows.find((x) => x.state === st);
    return { count: r ? Number(r.count) : 0, cents: r ? Number(r.cents) : 0 };
  };
  const byState = { open: of('open'), submitted: of('submitted'), reviewing: of('reviewing') };
  const occupiedCents = byState.open.cents + byState.submitted.cents + byState.reviewing.cents;
  return {
    totalCents: s.totalCents,
    occupiedCents,
    remainingCents: s.totalCents === null ? null : s.totalCents - occupiedCents,
    pendingCount: byState.open.count + byState.submitted.count + byState.reviewing.count,
    byState,
    reimbursedThisMonth: { count: Number(month!.count), cents: Number(month!.cents) },
  };
}

export async function poolBoard(db: Db, timezone: string, f: UseFilter): Promise<PoolBoard> {
  const settings = await loadPoolSettings(db);
  const [dept] = settings.departmentId ? await db<{ name: string }[]>`SELECT name FROM departments WHERE id = ${settings.departmentId}` : [];
  const rows = (await useRows(db, f, LIST_LIMIT + 1)).map(toRow);
  return {
    settings,
    departmentName: dept?.name ?? null,
    summary: await poolSummary(db, timezone, settings),
    uses: rows.slice(0, LIST_LIMIT),
    truncated: rows.length > LIST_LIMIT,
  };
}

export async function getPoolUse(db: Db, useId: number): Promise<PoolUseDetail> {
  const [r] = await useRows(db, { ids: [useId] }, null);
  if (!r) throw notFound('这笔申用不存在');
  const claims = await db<{ id: number; docNo: string; status: PoolClaimRef['status']; amountCents: number; confirmedAt: string | null }[]>`
    SELECT c.id, c.doc_no, c.status, c.amount_cents, c.confirmed_at FROM expense_claim_pool_uses l JOIN expense_claims c ON c.id = l.claim_id
    WHERE l.use_id = ${useId} ORDER BY c.id`;
  return { ...toRow(r), claims: claims.map((c) => ({ ...c, id: Number(c.id), amountCents: Number(c.amountCents) })) };
}

// ───────────────────────── 申用 ─────────────────────────

const UseInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  useDate: docDateSchema,
  applicantId: id,
  purpose: z.string().trim().min(1, '请写用途说明').max(100, '用途说明最多 100 个字'),
  content: z.string().trim().min(1, '请写采购内容').max(200, '采购内容最多 200 个字'),
  amountCents: positiveCents('申用金额').max(100_000_000, '一笔最多 100 万元'),
  note: z.string().trim().max(200, '备注最多 200 个字').default(''),
});

/** 申用都串行：在锁里算占用与剩余 */
const lockPool = (tx: Tx) => tx`SELECT pg_advisory_xact_lock(hashtextextended('petty_pool', 0))`;

export async function createPoolUse(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ use: PoolUseDetail; replayed: boolean }> {
  const input = parse(UseInput, raw);
  assertNotFuture(input.useDate, deps.config.timezone);
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const findExisting = async (db: Db) => {
    const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (!row) return null;
    if (row.opType !== 'pool_use' || row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的登记，请刷新页面后重新填写');
    return Number(row.refId);
  };
  let useId: number;
  let replayed = false;
  try {
    const r = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      const existing = await findExisting(tx);
      if (existing) return { id: existing, replayed: true };
      await assertNotFenced(tx, input.clientKey, 'pool_use', erpOpAbandoned);
      const [applicant] = await tx<{ active: boolean }[]>`SELECT active FROM staff WHERE id = ${input.applicantId}`;
      if (!applicant?.active) throw unprocessable('APPLICANT_INVALID', '申请人不存在或已停用');
      await lockPool(tx);
      const settings = await loadPoolSettings(tx);
      if (settings.totalCents === null) throw unprocessable('POOL_NOT_CONFIGURED', '还没配置零采备用金的总额，请店主在「ERP 设置 → 报销与备用金」里填');
      const summary = await poolSummary(tx, deps.config.timezone, settings);
      const remaining = summary.remainingCents ?? 0;
      if (input.amountCents > remaining) {
        throw unprocessable(
          'POOL_EXCEEDED',
          remaining > 0
            ? `剩余可用只有 ¥${formatAmount(remaining)}，申用 ¥${formatAmount(input.amountCents)} 超了；先报销已用掉的，或请店主调高总额`
            : `零采备用金已经用满（已占用 ¥${formatAmount(summary.occupiedCents)}，总额 ¥${formatAmount(settings.totalCents)}）；先报销已用掉的，或请店主调高总额`,
          { remainingCents: remaining },
        );
      }
      const docNo = await nextDocNo(tx, 'petty_pool_use', 'LC', input.useDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO petty_pool_uses (doc_no, use_date, applicant_id, purpose, content, amount_cents, note, client_key, created_by)
        VALUES (${docNo}, ${input.useDate}, ${input.applicantId}, ${input.purpose}, ${input.content}, ${input.amountCents}, ${input.note}, ${input.clientKey}, ${actor.id})
        RETURNING id`;
      const newId = Number(row!.id);
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'pool_use', ${requestHash}, ${newId}, ${actor.id})`;
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'pool_use',
        targetType: 'petty_pool_use',
        targetId: newId,
        detail: { action: 'create', docNo, amountCents: input.amountCents, applicantId: input.applicantId, remainingBefore: remaining },
        ip,
      });
      return { id: newId, replayed: false };
    });
    useId = r.id;
    replayed = r.replayed;
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, 'petty_pool_uses_client_key_key')) {
      const existing = await findExisting(deps.sql);
      if (!existing) throw error;
      useId = existing;
      replayed = true;
    } else throw error;
  }
  return { use: await getPoolUse(deps.sql, useId), replayed };
}

// ───────────────────────── 报销、补单、作废 ─────────────────────────

const Version = z.object({ version: z.number().int().min(1) });
const BackfillInput = Version.extend({
  backfill: z.enum(POOL_BACKFILLS, '请选未补单或已补单'),
  purchaseOrderId: id.nullable().default(null),
});
const SubmitInput = BackfillInput.extend({ note: z.string().trim().max(200, '说明最多 200 个字').default('') });
const VoidInput = Version.extend({ reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 个字') });

interface LockedUse {
  id: number;
  docNo: string;
  status: 'active' | 'voided';
  claimState: 'open' | 'submitted';
  backfill: 'pending' | 'done' | null;
  purchaseOrderId: number | null;
  submitNote: string;
  version: number;
}

async function lockUse(tx: Tx, useId: number): Promise<LockedUse> {
  const [u] = await tx<LockedUse[]>`
    SELECT id, doc_no, status, claim_state, backfill, purchase_order_id, submit_note, version FROM petty_pool_uses WHERE id = ${useId} FOR UPDATE`;
  if (!u) throw notFound('这笔申用不存在');
  return { ...u, purchaseOrderId: u.purchaseOrderId === null ? null : Number(u.purchaseOrderId), version: Number(u.version) };
}

/** 挂着的有效报销单（调用方已经锁住申用一行：财务登记报销也先锁申用，二者串行） */
async function activeClaimOf(tx: Tx, useId: number): Promise<{ docNo: string; status: string } | null> {
  const [c] = await tx<{ docNo: string; status: string }[]>`
    SELECT c.doc_no, c.status FROM expense_claim_pool_uses l JOIN expense_claims c ON c.id = l.claim_id
    WHERE l.use_id = ${useId} AND c.status IN ${tx(ACTIVE_CLAIM)} ORDER BY c.id DESC LIMIT 1`;
  return c ?? null;
}

/** 已补单要选已确认或已关闭的采购单；未补单不选 */
async function checkBackfill(tx: Tx, backfill: 'pending' | 'done', poId: number | null): Promise<void> {
  if (backfill === 'pending') {
    if (poId !== null) throw badRequest('选了未补单就不用选采购单');
    return;
  }
  if (poId === null) throw unprocessable('PO_REQUIRED', '已补单请选对应的采购单');
  const [po] = await tx<{ status: string; docNo: string }[]>`SELECT status, doc_no FROM purchase_orders WHERE id = ${poId}`;
  if (!po) throw unprocessable('PO_NOT_FOUND', '采购单不存在');
  if (po.status !== 'approved' && po.status !== 'closed') throw unprocessable('PO_NOT_APPROVED', `采购单 ${po.docNo} 还没确认（或已撤回），确认以后再选`);
}

const assertVersion = (u: LockedUse, version: number) => {
  if (u.version !== version) throw conflict('VERSION_CONFLICT', `申用 ${u.docNo} 刚被别人改过，请刷新后再操作`);
};

async function act(
  deps: Deps,
  useId: number,
  actor: Actor,
  action: 'submit' | 'unsubmit' | 'backfill' | 'void',
  fn: (tx: Tx, u: LockedUse) => Promise<Record<string, unknown> | null>,
): Promise<PoolUseDetail> {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const u = await lockUse(tx, useId);
    const detail = await fn(tx, u);
    if (!detail) return;
    await writeAudit(tx, { staffId: actor.id, action: 'pool_use', targetType: 'petty_pool_use', targetId: useId, detail: { action, docNo: u.docNo, ...detail } });
  });
  return getPoolUse(deps.sql, useId);
}

/** 提交报销（供应链）：勾未补单 / 已补单（已补单选采购单），之后等财务登记报销单 */
export function submitPoolUse(deps: Deps, useId: number, raw: unknown, actor: Actor) {
  const input = parse(SubmitInput, raw);
  return act(deps, useId, actor, 'submit', async (tx, u) => {
    if (u.status === 'voided') throw conflict('USE_VOIDED', `申用 ${u.docNo} 已作废`);
    if (u.claimState === 'submitted') {
      // 原样重提：内容一样直接返回
      if (u.backfill === input.backfill && u.purchaseOrderId === input.purchaseOrderId && u.submitNote === input.note) return null;
      throw conflict('ALREADY_SUBMITTED', `申用 ${u.docNo} 已经提交报销；补单有变化请点「更新补单」`);
    }
    assertVersion(u, input.version);
    await checkBackfill(tx, input.backfill, input.purchaseOrderId);
    await tx`
      UPDATE petty_pool_uses SET claim_state = 'submitted', backfill = ${input.backfill}, purchase_order_id = ${input.purchaseOrderId}, submit_note = ${input.note},
             submitted_by = ${actor.id}, submitted_at = now(), version = version + 1, updated_at = now()
      WHERE id = ${useId}`;
    return { backfill: input.backfill, purchaseOrderId: input.purchaseOrderId };
  });
}

/** 撤回报销：财务还没登记报销单（或登记的已撤回、冲销）时 */
export function unsubmitPoolUse(deps: Deps, useId: number, raw: unknown, actor: Actor) {
  const input = parse(Version, raw);
  return act(deps, useId, actor, 'unsubmit', async (tx, u) => {
    if (u.status === 'voided') throw conflict('USE_VOIDED', `申用 ${u.docNo} 已作废`);
    if (u.claimState === 'open') return null;
    assertVersion(u, input.version);
    const claim = await activeClaimOf(tx, useId);
    if (claim)
      throw conflict(
        'CLAIM_ACTIVE',
        `财务已经登记了报销单 ${claim.docNo}（${CLAIM_STATUS_LABELS[claim.status as keyof typeof CLAIM_STATUS_LABELS] ?? claim.status}），不能撤回；要改请财务先撤回或冲销报销单`,
      );
    await tx`UPDATE petty_pool_uses SET claim_state = 'open', submitted_by = NULL, submitted_at = NULL, version = version + 1, updated_at = now() WHERE id = ${useId}`;
    return {};
  });
}

/** 更新补单：未补单的补了采购单以后改过来（已报销的也能改，只是记录、不动钱） */
export function backfillPoolUse(deps: Deps, useId: number, raw: unknown, actor: Actor) {
  const input = parse(BackfillInput, raw);
  return act(deps, useId, actor, 'backfill', async (tx, u) => {
    if (u.status === 'voided') throw conflict('USE_VOIDED', `申用 ${u.docNo} 已作废`);
    if (u.backfill === input.backfill && u.purchaseOrderId === input.purchaseOrderId) return null;
    assertVersion(u, input.version);
    await checkBackfill(tx, input.backfill, input.purchaseOrderId);
    await tx`UPDATE petty_pool_uses SET backfill = ${input.backfill}, purchase_order_id = ${input.purchaseOrderId}, version = version + 1, updated_at = now() WHERE id = ${useId}`;
    return { from: { backfill: u.backfill, purchaseOrderId: u.purchaseOrderId }, to: { backfill: input.backfill, purchaseOrderId: input.purchaseOrderId } };
  });
}

/** 作废：没挂着有效报销单的才能作废，作废后不再占用 */
export function voidPoolUse(deps: Deps, useId: number, raw: unknown, actor: Actor) {
  const input = parse(VoidInput, raw);
  return act(deps, useId, actor, 'void', async (tx, u) => {
    if (u.status === 'voided') return null;
    assertVersion(u, input.version);
    const claim = await activeClaimOf(tx, useId);
    if (claim) throw conflict('CLAIM_ACTIVE', `这笔申用挂着报销单 ${claim.docNo}，不能作废；要作废请财务先撤回或冲销报销单`);
    await tx`
      UPDATE petty_pool_uses SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${input.reason}, version = version + 1, updated_at = now()
      WHERE id = ${useId}`;
    return { reason: input.reason };
  });
}

// ───────────────────────── 给「费用报销」用 ─────────────────────────

const forClaimSql = (db: Db) => db<
  (Omit<PoolUseForClaim, 'id' | 'applicantId' | 'amountCents' | 'purchaseOrderId'> & { id: number; applicantId: number; amountCents: number; purchaseOrderId: number | null })[]
>`
  SELECT u.id, u.doc_no, u.use_date, u.applicant_id, a.display_name AS applicant_name, u.purpose, u.content, u.amount_cents, u.backfill,
         u.purchase_order_id, po.doc_no AS po_no, u.submit_note
  FROM petty_pool_uses u JOIN staff a ON a.id = u.applicant_id LEFT JOIN purchase_orders po ON po.id = u.purchase_order_id
  WHERE u.status = 'active' AND u.claim_state = 'submitted'
    AND NOT EXISTS (SELECT 1 FROM expense_claim_pool_uses l JOIN expense_claims c ON c.id = l.claim_id WHERE l.use_id = u.id AND c.status IN ${db(ACTIVE_CLAIM)})
  ORDER BY u.use_date, u.id
  LIMIT 500`;

/** 财务登记报销时可以勾的申用：供应链已提交报销、还没挂有效报销单的 */
export async function poolUsesForClaim(db: Db): Promise<PoolUseForClaim[]> {
  return (await forClaimSql(db)).map((u) => ({
    ...u,
    id: Number(u.id),
    applicantId: Number(u.applicantId),
    amountCents: Number(u.amountCents),
    purchaseOrderId: u.purchaseOrderId === null ? null : Number(u.purchaseOrderId),
  }));
}

/**
 * 登记报销（钱从零采备用金来）时锁住要报的申用并核对：没作废、供应链已提交报销、没挂着有效的报销单。
 * 调用方（createClaim）在操作编号之后、采购单之前调用；按 id 升序加锁。返回申用金额合计。
 */
export async function lockPoolUsesForClaim(tx: Tx, useIds: number[]): Promise<{ totalCents: number; uses: { id: number; docNo: string }[] }> {
  const ids = [...new Set(useIds)].sort((a, b) => a - b);
  const rows = await tx<{ id: number; docNo: string; status: string; claimState: string; amountCents: number }[]>`
    SELECT id, doc_no, status, claim_state, amount_cents FROM petty_pool_uses WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
  if (rows.length !== ids.length) throw unprocessable('POOL_USE_NOT_FOUND', '有一笔申用不存在，请刷新后重选');
  for (const u of rows) {
    if (u.status !== 'active') throw conflict('POOL_USE_VOIDED', `申用 ${u.docNo} 已作废，请刷新后重选`);
    if (u.claimState !== 'submitted') throw conflict('POOL_USE_NOT_SUBMITTED', `申用 ${u.docNo} 供应链还没提交报销（或已撤回），请刷新后重选`);
    const claim = await activeClaimOf(tx, Number(u.id));
    if (claim) throw conflict('POOL_USE_CLAIMED', `申用 ${u.docNo} 已经挂在报销单 ${claim.docNo} 上，不能重复报销`, { docNo: claim.docNo });
  }
  return { totalCents: rows.reduce((t, u) => t + Number(u.amountCents), 0), uses: rows.map((u) => ({ id: Number(u.id), docNo: u.docNo })) };
}

/** 报销单报的是哪几笔申用 */
export async function claimPoolUses(db: Db, claimId: number): Promise<PoolUseBrief[]> {
  const rows = await db<(Omit<PoolUseBrief, 'id' | 'amountCents'> & { id: number; amountCents: number })[]>`
    SELECT u.id, u.doc_no, u.use_date, a.display_name AS applicant_name, u.content, u.amount_cents, u.backfill, po.doc_no AS po_no
    FROM expense_claim_pool_uses l JOIN petty_pool_uses u ON u.id = l.use_id JOIN staff a ON a.id = u.applicant_id
    LEFT JOIN purchase_orders po ON po.id = u.purchase_order_id
    WHERE l.claim_id = ${claimId} ORDER BY u.id`;
  return rows.map((u) => ({ ...u, id: Number(u.id), amountCents: Number(u.amountCents) }));
}

// ───────────────────────── 采购单、自检、导出 ─────────────────────────

/** 提交报销时可以选的采购单：已确认或已关闭，按单号、供应商搜，最近的在前 */
export async function poolPoOptions(db: Db, q: string): Promise<PoolPoOption[]> {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db<(Omit<PoolPoOption, 'id' | 'totalCents'> & { id: number; totalCents: number })[]>`
    SELECT po.id, po.doc_no, s.name AS supplier_name, po.order_date, po.total_cents, po.status, po.backfill
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.status IN ('approved', 'closed')
      ${q ? db`AND (po.doc_no ILIKE ${like} OR s.name ILIKE ${like} OR s.code ILIKE ${like})` : db``}
    ORDER BY po.order_date DESC, po.id DESC LIMIT 50`;
  return rows.map((r) => ({ ...r, id: Number(r.id), totalCents: Number(r.totalCents) }));
}

/** 自检（「费用与备用金」那一组）：零采备用金一致 */
export async function poolCheck(db: Db): Promise<{ key: string; label: string; ok: boolean; detail: string }> {
  const bad = await db<{ docNo: string; why: string }[]>`
    SELECT c.doc_no, '钱从零采备用金来，但没有挂申用' AS why FROM expense_claims c
    WHERE c.pay_source = 'pool' AND c.status IN ${db(ACTIVE_CLAIM)} AND NOT EXISTS (SELECT 1 FROM expense_claim_pool_uses l WHERE l.claim_id = c.id)
    UNION ALL
    SELECT c.doc_no, '不是零采备用金的报销单挂了申用' FROM expense_claims c
    WHERE c.pay_source <> 'pool' AND EXISTS (SELECT 1 FROM expense_claim_pool_uses l WHERE l.claim_id = c.id)
    UNION ALL
    SELECT u.doc_no, '挂着 ' || count(*) || ' 张有效的报销单' FROM petty_pool_uses u
    JOIN expense_claim_pool_uses l ON l.use_id = u.id JOIN expense_claims c ON c.id = l.claim_id
    WHERE c.status IN ${db(ACTIVE_CLAIM)} GROUP BY u.id, u.doc_no HAVING count(*) > 1
    UNION ALL
    SELECT u.doc_no, CASE WHEN u.status = 'voided' THEN '已作废，却挂着有效的报销单' ELSE '没提交报销，却挂着有效的报销单' END FROM petty_pool_uses u
    WHERE (u.status = 'voided' OR u.claim_state = 'open')
      AND EXISTS (SELECT 1 FROM expense_claim_pool_uses l JOIN expense_claims c ON c.id = l.claim_id WHERE l.use_id = u.id AND c.status IN ${db(ACTIVE_CLAIM)})`;
  const [n] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM petty_pool_uses WHERE status = 'active'`;
  return {
    key: 'petty_pool',
    label: '零采备用金一致',
    ok: bad.length === 0,
    detail: bad.length ? bad.map((b) => `${b.docNo} ${b.why}`).join('；') : `有效申用 ${n!.count} 笔；零采备用金的报销单都挂着申用，一笔申用最多一张有效报销单`,
  };
}

async function poolCsv(db: Db, f: UseFilter): Promise<string> {
  const rows = (await useRows(db, f, EXPORT_LIMIT + 1)).map(toRow);
  if (rows.length > EXPORT_LIMIT) throw unprocessable('EXPORT_TOO_LARGE', `一次最多导出 ${EXPORT_LIMIT} 笔，请缩短日期范围`);
  return toCsv([
    ['单号', '申用日期', '申请人', '用途说明', '采购内容', '申用金额（元）', '状态', '补单', '采购单', '报销单', '报销单状态', '报销金额（元）', '回补时间', '提交报销', '备注', '作废原因'],
    ...rows.map((u) => [
      u.docNo,
      u.useDate,
      u.applicant.name,
      u.purpose,
      u.content,
      yuan(u.amountCents),
      POOL_USE_STATE_LABELS[u.state],
      u.backfill ? POOL_BACKFILL_LABELS[u.backfill] : '',
      u.purchaseOrder ? `${u.purchaseOrder.docNo} ${u.purchaseOrder.supplierName}` : '',
      u.claim?.docNo ?? '',
      u.claim ? CLAIM_STATUS_LABELS[u.claim.status] : '',
      u.claim ? yuan(u.claim.amountCents) : '',
      u.state === 'reimbursed' ? (u.claim?.confirmedAt ?? '') : '',
      u.submittedAt ? `${u.submittedByName ?? ''} ${u.submittedAt}` : '',
      u.note,
      u.voidReason ?? '',
    ]),
  ]);
}

// ───────────────────────── 路由 ─────────────────────────

const optId = z.coerce.number().int().positive().optional();
const ListQuery = z.object({
  state: z.enum(POOL_USE_STATES).optional(),
  applicantId: optId,
  backfill: z.enum(['pending', 'done', 'none']).optional(),
  from: docDateSchema.optional(),
  to: docDateSchema.optional(),
});
const keyParam = z.object({ key: z.uuid('操作编号格式不正确') });

function listFilter(raw: unknown): UseFilter {
  const q = parse(ListQuery, raw);
  if (q.from && q.to) checkDateRange(q.from, q.to);
  return q;
}

export function registerPettyPoolRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const useId = (req: { params: unknown }) => parse(idParam, req.params).id;

  app.get('/api/erp/pool', { preHandler: guard('pool.read') }, async (req) => readSnapshot(sql, (tx) => poolBoard(tx, config.timezone, listFilter(req.query))));
  app.get('/api/erp/pool/export', { preHandler: guard('pool.read') }, async (req, reply) => {
    const csv = await readSnapshot(sql, (tx) => poolCsv(tx, listFilter(req.query)));
    return csvReply(reply, `零采备用金台账-${todayIn(config.timezone)}.csv`, csv);
  });
  app.get('/api/erp/pool/settings', { preHandler: guardAny('pool.read', 'settings.manage') }, async () => loadPoolSettings(sql));
  app.put('/api/erp/pool/settings', { preHandler: guard('settings.manage') }, async (req) => saveSettings(deps, req.body, req.actor, ctxOf(req).ip));
  // 申用的申请人：在职员工（零采备用金的权限可能单独授给没有报销查看权限的岗位，不借用报销的员工接口）
  app.get(
    '/api/erp/pool/applicants',
    { preHandler: guard('pool.manage') },
    async () => sql<{ id: number; name: string }[]>`SELECT id, display_name AS name FROM staff WHERE active AND NOT system ORDER BY display_name`,
  );
  app.get('/api/erp/pool/po-options', { preHandler: guard('pool.manage') }, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().max(40).default('') }), req.query);
    return poolPoOptions(sql, q);
  });
  app.get('/api/erp/pool/uses/by-key/:key', { preHandler: guard('pool.read') }, async (req) => {
    const { key } = parse(keyParam, req.params);
    const [row] = await sql<{ id: number }[]>`SELECT id FROM petty_pool_uses WHERE client_key = ${key}`;
    if (!row) throw notFound('没有找到这笔申用');
    return getPoolUse(sql, Number(row.id));
  });
  app.get('/api/erp/pool/uses/:id', { preHandler: guard('pool.read') }, async (req) => getPoolUse(sql, useId(req)));
  app.post('/api/erp/pool/uses', { preHandler: guard('pool.manage') }, async (req, reply) => {
    const r = await createPoolUse(deps, req.body, req.actor, ctxOf(req).ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
  app.post('/api/erp/pool/uses/:id/submit', { preHandler: guard('pool.manage') }, async (req) => submitPoolUse(deps, useId(req), req.body, req.actor));
  app.post('/api/erp/pool/uses/:id/unsubmit', { preHandler: guard('pool.manage') }, async (req) => unsubmitPoolUse(deps, useId(req), req.body, req.actor));
  app.post('/api/erp/pool/uses/:id/backfill', { preHandler: guard('pool.manage') }, async (req) => backfillPoolUse(deps, useId(req), req.body, req.actor));
  app.post('/api/erp/pool/uses/:id/void', { preHandler: guard('pool.manage') }, async (req) => voidPoolUse(deps, useId(req), req.body, req.actor));
  // 财务登记报销时可以勾的申用（不在 /api/erp/pool 下：零采备用金模块关着时照样能报已提交的）
  app.get('/api/erp/expenses/pool-uses', { preHandler: guard('expense.manage') }, async () => {
    const [settings, uses] = await Promise.all([loadPoolSettings(sql), poolUsesForClaim(sql)]);
    return { departmentId: settings.departmentId, uses };
  });
}
