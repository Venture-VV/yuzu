// 合同的验收登记与质量问题登记（v0.7.32，docs/PAYMENTS.md 第 2 节，P2、P3 待确认）：验收合格放开验收段（服务、租赁、其他合同还放开到货段），
// 质保从验收合格日起算的也按它；有未处理的质量问题时质保段不可付。登记以后不能改，登错了作废（写原因）；质量问题处理完标记已处理。
//
// 锁：新建先取操作编号的咨询锁（与「确认作废」串行）→ 合同一行（FOR NO KEY UPDATE，与新建付款申请串行：付款计划算的时候验收不在变）；
// 作废、标记已处理也只锁合同一行，再改那一条。维护合同的人登记。

import { z } from 'zod';
import type { ContractStatus } from '@shared/contracts';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { assertNotFenced } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { setTxTimeouts } from '../../lib/tx';
import { dateSchema, parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import { PAYABLE_CONTRACT_STATUSES } from './plan';

const Reason = z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 个字');
const ClientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');

async function lockContractRow(tx: Tx, contractId: number): Promise<{ contractNo: string; status: ContractStatus }> {
  const [c] = await tx<{ contractNo: string; status: ContractStatus }[]>`SELECT contract_no, status FROM contracts WHERE id = ${contractId} FOR NO KEY UPDATE`;
  if (!c) throw notFound('合同不存在');
  return c;
}

function assertSigned(c: { contractNo: string; status: ContractStatus }) {
  if (!PAYABLE_CONTRACT_STATUSES.includes(c.status)) throw conflict('INVALID_STATE', `合同 ${c.contractNo} 还没签署，签署以后才能登记验收、质量问题`);
}

const AcceptanceInput = z
  .object({
    clientKey: ClientKey,
    acceptedOn: dateSchema('验收日'),
    result: z.enum(['pass', 'fail'], '请选择验收结果'),
    signer: z.string('请填写签字人').trim().min(1, '请填写签字人').max(20, '签字人最多 20 个字'),
    note: z.string().trim().max(200, '说明最多 200 个字').default(''),
  })
  .refine((v) => v.result === 'pass' || v.note.length >= 2, { message: '不合格请写明怎么处理（至少 2 个字）', path: ['note'] });

/** 登记验收（合格 / 不合格）：验收日不晚于今天；以最近一条没作废的为准 */
export async function createAcceptance(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(AcceptanceInput, raw);
  if (input.acceptedOn > todayIn(deps.config.timezone)) throw badRequest('验收日不能晚于今天');
  const requestHash = hashRequest({ ...input, clientKey: undefined, contractId });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM contract_acceptances WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一条验收登记，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, input.clientKey, 'contract_acceptance', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      const c = await lockContractRow(tx, contractId);
      assertSigned(c);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO contract_acceptances (contract_id, accepted_on, result, signer, note, client_key, request_hash, created_by)
        VALUES (${contractId}, ${input.acceptedOn}, ${input.result}, ${input.signer}, ${input.note}, ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'acceptance', contractNo: c.contractNo, result: input.result, acceptedOn: input.acceptedOn }, ip });
      return { id: Number(row!.id), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'contract_acceptances_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    throw error;
  }
}

/** 作废验收登记（登错了）：写原因 */
export async function voidAcceptance(deps: Deps, acceptanceId: number, raw: unknown, actor: Actor, ip?: string) {
  const { reason } = parse(z.object({ reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [a] = await tx<{ contractId: number }[]>`SELECT contract_id FROM contract_acceptances WHERE id = ${acceptanceId}`;
    if (!a) throw notFound('验收登记不存在');
    const c = await lockContractRow(tx, Number(a.contractId));
    const [cur] = await tx<{ voidedAt: string | null }[]>`SELECT voided_at FROM contract_acceptances WHERE id = ${acceptanceId}`;
    if (cur!.voidedAt) return;
    await tx`UPDATE contract_acceptances SET voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason} WHERE id = ${acceptanceId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: Number(a.contractId), detail: { op: 'acceptance_void', contractNo: c.contractNo, acceptanceId, reason }, ip });
  });
}

const IssueInput = z.object({
  clientKey: ClientKey,
  foundOn: dateSchema('发现日'),
  description: z.string('请描述问题').trim().min(2, '请描述问题（至少 2 个字）').max(200, '问题描述最多 200 个字'),
});

/** 登记质量问题：有未处理的质量问题时质保段不可付 */
export async function createQualityIssue(deps: Deps, contractId: number, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(IssueInput, raw);
  if (input.foundOn > todayIn(deps.config.timezone)) throw badRequest('发现日不能晚于今天');
  const requestHash = hashRequest({ ...input, clientKey: undefined, contractId });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM contract_quality_issues WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一条质量问题，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, input.clientKey, 'contract_quality', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      const c = await lockContractRow(tx, contractId);
      assertSigned(c);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO contract_quality_issues (contract_id, found_on, description, client_key, request_hash, created_by)
        VALUES (${contractId}, ${input.foundOn}, ${input.description}, ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: contractId, detail: { op: 'quality_issue', contractNo: c.contractNo, foundOn: input.foundOn }, ip });
      return { id: Number(row!.id), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'contract_quality_issues_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    throw error;
  }
}

async function lockIssue(tx: Tx, issueId: number) {
  const [q] = await tx<{ contractId: number }[]>`SELECT contract_id FROM contract_quality_issues WHERE id = ${issueId}`;
  if (!q) throw notFound('质量问题登记不存在');
  const c = await lockContractRow(tx, Number(q.contractId));
  const [cur] = await tx<{ status: string; foundOn: string }[]>`SELECT status, found_on FROM contract_quality_issues WHERE id = ${issueId}`;
  return { contractId: Number(q.contractId), contractNo: c.contractNo, status: cur!.status, foundOn: cur!.foundOn };
}

/** 标记已处理（处理日、处理结果） */
export async function resolveQualityIssue(deps: Deps, issueId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(
    z.object({ resolvedOn: dateSchema('处理日'), resolution: z.string('请写处理结果').trim().min(2, '请写处理结果（至少 2 个字）').max(200, '处理结果最多 200 个字') }),
    raw,
  );
  if (input.resolvedOn > todayIn(deps.config.timezone)) throw badRequest('处理日不能晚于今天');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const q = await lockIssue(tx, issueId);
    if (q.status === 'resolved') return;
    if (q.status !== 'open') throw conflict('INVALID_STATE', '这条质量问题已作废');
    if (input.resolvedOn < q.foundOn) throw badRequest('处理日不能早于发现日');
    await tx`
      UPDATE contract_quality_issues SET status = 'resolved', resolved_on = ${input.resolvedOn}, resolution = ${input.resolution}, resolved_by = ${actor.id}, resolved_at = now()
      WHERE id = ${issueId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: q.contractId, detail: { op: 'quality_resolve', contractNo: q.contractNo, issueId }, ip });
  });
}

/** 作废质量问题（登错了，只有未处理的） */
export async function voidQualityIssue(deps: Deps, issueId: number, raw: unknown, actor: Actor, ip?: string) {
  const { reason } = parse(z.object({ reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const q = await lockIssue(tx, issueId);
    if (q.status === 'voided') return;
    if (q.status !== 'open') throw conflict('INVALID_STATE', '已处理的质量问题不能作废');
    await tx`UPDATE contract_quality_issues SET status = 'voided', void_reason = ${reason}, voided_by = ${actor.id}, voided_at = now() WHERE id = ${issueId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'contract_doc', targetType: 'contract', targetId: q.contractId, detail: { op: 'quality_void', contractNo: q.contractNo, issueId, reason }, ip });
  });
}
