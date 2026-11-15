// 8.0.21 批量付款文件（docs/FINANCE_V8021.md 第 5 节，CW-D / CW4 / CW18 / CW19）。
//   · 「付款 → 批量付款」勾选已审批、没付清、收款账户齐全的付款申请 → 生成批次（抄一份收款户名、开户行、账号）→ 导出网银模板
//     （工商、建设、招商常见的列 + 通用 CSV）→ 在网银里上传付款 → 回来：导入银行流水自动对上（金额、收款户名）的照「按申请登记付款」记账，
//     对不上的手动「标记已付 / 失败」。全部有结论以后批次「已完成」。
//   · 导出以后不能改，只能作废重开：作废要确认这一批没在网银里付；有记了已付的不能作废。
// 锁：生成先取操作编号的咨询锁（与「确认作废」串行，业务类型 payment_batch）→ 付款申请（id 升序，FOR NO KEY UPDATE；锁住以后核对已审批、没付清、
//     不在别的没结束的批次里）→ 写批次与明细，同一张申请靠部分唯一索引兜底；导出、作废只锁批次一行（带版本号）；
//     记已付：批次一行 → 明细一行（记下付款日、流水号）→ 事务外调「按申请登记付款」/「登记合同付款」（用明细自己的操作编号，原来的锁与幂等）→
//     再锁明细一行写结果。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BANK_TEMPLATE_LABELS, type BankTemplate } from '@shared/bank';
import { guard } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db } from '../db';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { attachment, toCsv } from '../lib/csv';
import { todayIn } from '../lib/dates';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { dateSchema, idParam, parse } from '../lib/validate';
import { buildWorkbook } from '../lib/xlsx';
import { erpOpAbandoned } from './erp-ops';
import { getPaymentRequest, payFromRequest, payoutFromRequest } from './payments/requests';

const READ = guard('payable.read');
const MANAGE = guard('payable.manage');
const yuanText = (c: number) => `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const maskAccount = (a: string) => (a.length > 4 ? `${'*'.repeat(Math.min(8, a.length - 4))}${a.slice(-4)}` : a);

export interface BatchCandidate {
  requestId: number;
  requestNo: string;
  payee: string;
  supplierName: string | null;
  leftCents: number;
  expectedDate: string;
  payMode: 'ap' | 'direct';
  bankPayee: string;
  bankName: string;
  bankAccountTail: string;
  /** 收款账户不全（户名、开户行、账号）的不能进批次 */
  bankOk: boolean;
}

/** 能进批次的：已审批、没付清、不在别的没结束的批次里 */
async function candidates(db: Db): Promise<BatchCandidate[]> {
  const rows = await db<{ requestId: number; requestNo: string; payee: string; supplierName: string | null; amount: string; paid: string; expectedDate: string; payMode: 'ap' | 'direct'; bankPayee: string | null; bankName: string | null; bankAccount: string | null }[]>`
    SELECT r.id AS request_id, r.request_no, r.payee, s.name AS supplier_name, r.amount_cents::text AS amount, r.expected_date::text AS expected_date, r.pay_mode,
           s.bank_payee, s.bank_name, s.bank_account,
           (coalesce((SELECT sum(p.amount_cents) FROM payments p WHERE p.payment_request_id = r.id AND p.status = 'confirmed'), 0)
            + coalesce((SELECT sum(o.amount_cents) FROM contract_payouts o WHERE o.payment_request_id = r.id AND o.status = 'confirmed'), 0))::text AS paid
    FROM payment_requests r LEFT JOIN suppliers s ON s.id = r.supplier_id
    WHERE r.status = 'approved'
      AND NOT EXISTS (SELECT 1 FROM payment_batch_items i WHERE i.payment_request_id = r.id AND i.active)
    ORDER BY r.expected_date, r.id`;
  return rows
    .map((r) => {
      const left = Number(r.amount) - Number(r.paid);
      const payee = (r.bankPayee || '').trim();
      return {
        requestId: Number(r.requestId),
        requestNo: r.requestNo,
        payee: r.payee,
        supplierName: r.supplierName,
        leftCents: left,
        expectedDate: r.expectedDate,
        payMode: r.payMode,
        bankPayee: payee,
        bankName: r.bankName ?? '',
        bankAccountTail: (r.bankAccount ?? '').slice(-4),
        bankOk: !!payee && !!(r.bankName ?? '').trim() && /^[0-9]{8,32}$/.test(r.bankAccount ?? ''),
      };
    })
    .filter((r) => r.leftCents > 0);
}

export interface BatchItemView {
  id: number;
  lineNo: number;
  requestId: number;
  requestNo: string;
  amountCents: number;
  payeeName: string;
  payeeBank: string;
  payeeAccountMasked: string;
  purpose: string;
  status: 'pending' | 'paid' | 'failed' | 'removed';
  paymentKind: 'payment' | 'payout' | null;
  paymentId: number | null;
  paidOn: string | null;
  bankRef: string;
  failReason: string | null;
  /** 已对上银行流水 */
  matched: boolean;
}
export interface BatchView {
  id: number;
  batchNo: string;
  accountId: number;
  accountName: string;
  template: BankTemplate;
  status: 'draft' | 'exported' | 'done' | 'voided';
  totalCents: number;
  itemCount: number;
  note: string;
  version: number;
  createdByName: string;
  createdAt: string;
  exportedAt: string | null;
  voidReason: string | null;
  items: BatchItemView[];
}

async function batchesWhere(db: Db, where: ReturnType<Db>, limit = 100): Promise<BatchView[]> {
  const rows = await db<(Omit<BatchView, 'items' | 'id' | 'accountId' | 'totalCents'> & { id: number; accountId: number; totalCents: string })[]>`
    SELECT b.id, b.batch_no, b.account_id, a.name AS account_name, b.template, b.status, b.total_cents::text AS total_cents, b.item_count, b.note, b.version,
           s.display_name AS created_by_name, b.created_at, b.exported_at, b.void_reason
    FROM payment_batches b JOIN bank_accounts a ON a.id = b.account_id JOIN staff s ON s.id = b.created_by
    WHERE ${where} ORDER BY b.id DESC LIMIT ${limit}`;
  const ids = rows.map((r) => Number(r.id));
  const items = ids.length
    ? await db<(Omit<BatchItemView, 'id' | 'requestId' | 'amountCents' | 'paymentId' | 'payeeAccountMasked'> & { id: number; batchId: number; requestId: number; amountCents: string; paymentId: number | null; payeeAccount: string })[]>`
        SELECT i.id, i.batch_id, i.line_no, i.payment_request_id AS request_id, r.request_no, i.amount_cents::text AS amount_cents, i.payee_name, i.payee_bank,
               i.payee_account, i.purpose, i.status, i.payment_kind, i.payment_id, i.paid_on::text AS paid_on, i.bank_ref, i.fail_reason,
               EXISTS (SELECT 1 FROM bank_matches m WHERE m.target_type = 'batch_item' AND m.target_id = i.id AND m.status = 'active') AS matched
        FROM payment_batch_items i JOIN payment_requests r ON r.id = i.payment_request_id
        WHERE i.batch_id IN ${db(ids)} ORDER BY i.batch_id, i.line_no`
    : [];
  return rows.map((b) => ({
    ...b,
    id: Number(b.id),
    accountId: Number(b.accountId),
    totalCents: Number(b.totalCents),
    createdAt: new Date(b.createdAt).toISOString(),
    exportedAt: b.exportedAt ? new Date(b.exportedAt).toISOString() : null,
    items: items
      .filter((i) => Number(i.batchId) === Number(b.id))
      .map(({ batchId: _b, payeeAccount, ...i }) => ({
        ...i,
        id: Number(i.id),
        requestId: Number(i.requestId),
        amountCents: Number(i.amountCents),
        paymentId: i.paymentId === null ? null : Number(i.paymentId),
        payeeAccountMasked: maskAccount(payeeAccount),
      })),
  }));
}
export async function getBatch(db: Db, id: number): Promise<BatchView> {
  const [b] = await batchesWhere(db, db`b.id = ${id}`, 1);
  if (!b) throw notFound('批次不存在');
  return b;
}

// ───────────────────────── 生成 ─────────────────────────

const CreateInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  accountId: z.number().int().positive('请选择付款账户'),
  requestIds: z.array(z.number().int().positive()).min(1, '请至少勾选一张付款申请').max(200, '一批最多 200 笔'),
  note: z.string().trim().max(200).default(''),
});

async function createBatch(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(CreateInput, raw);
  const ids = [...new Set(input.requestIds)].sort((a, b) => a - b);
  const requestHash = hashRequest({ ...input, clientKey: undefined, requestIds: ids });
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, input.clientKey, 'payment_batch', erpOpAbandoned);
      const [existing] = await tx<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM payment_batches WHERE client_key = ${input.clientKey}`;
      if (existing) {
        if (existing.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一批付款，请刷新页面后重新勾选');
        return { id: Number(existing.id), replayed: true };
      }
      const [acc] = await tx<{ template: BankTemplate; active: boolean }[]>`SELECT template, active FROM bank_accounts WHERE id = ${input.accountId}`;
      if (!acc || !acc.active) throw unprocessable('BANK_ACCOUNT_INVALID', '付款账户不存在或已停用');
      // 付款申请按 id 升序锁住，锁住以后再核对
      const locked = await tx<{ id: number }[]>`SELECT id FROM payment_requests WHERE id IN ${tx(ids)} ORDER BY id FOR NO KEY UPDATE`;
      if (locked.length !== ids.length) throw notFound('有付款申请不存在，请刷新后重选');
      const pool = new Map((await candidates(tx)).map((c) => [c.requestId, c]));
      const picked = ids.map((id) => {
        const c = pool.get(id);
        if (!c) throw conflict('BATCH_REQUEST_INVALID', `付款申请 #${id} 不是待付款、已经付清，或已经在别的批次里，请刷新后重选`);
        if (!c.bankOk) throw unprocessable('BATCH_BANK_MISSING', `${c.supplierName ?? c.payee} 的收款账户没登记全（户名、开户行、账号），先在供应商档案里补上`);
        return c;
      });
      const today = todayIn(deps.config.timezone);
      const batchNo = await nextDocNo(tx, 'payment_batch', 'PL', today);
      const total = picked.reduce((s, c) => s + c.leftCents, 0);
      const [b] = await tx<{ id: number }[]>`
        INSERT INTO payment_batches (batch_no, account_id, template, total_cents, item_count, note, client_key, request_hash, created_by)
        VALUES (${batchNo}, ${input.accountId}, ${acc.template}, ${total}, ${picked.length}, ${input.note}, ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      const batchId = Number(b!.id);
      let n = 0;
      for (const c of picked) {
        n += 1;
        // 收款账户在这里抄下来（之后改档案不影响这一批）
        await tx`
          INSERT INTO payment_batch_items (batch_id, line_no, payment_request_id, amount_cents, payee_name, payee_bank, payee_account, purpose, pay_client_key)
          SELECT ${batchId}, ${n}, r.id, ${c.leftCents}, s.bank_payee, s.bank_name, s.bank_account, left(${`付款申请 ${c.requestNo}`}, 60), gen_random_uuid()
          FROM payment_requests r JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = ${c.requestId}`;
      }
      await writeAudit(tx, { staffId: actor.id, action: 'payment_batch', targetType: 'payment_batch', targetId: batchId, detail: { op: 'create', batchNo, count: picked.length, totalCents: total }, ip });
      return { id: batchId, replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'payment_batch_items_active_uq')) throw conflict('BATCH_REQUEST_INVALID', '有付款申请已经在别的批次里了，请刷新后重选');
    throw error;
  }
}

// ───────────────────────── 导出 ─────────────────────────

const TEMPLATE_COLUMNS: Record<BankTemplate, { headers: string[]; row: (i: { lineNo: number; payeeName: string; payeeBank: string; payeeAccount: string; amountCents: number; purpose: string }) => (string | number)[] }> = {
  icbc: { headers: ['收款账号', '收款单位名称', '收款银行', '金额', '用途'], row: (i) => [i.payeeAccount, i.payeeName, i.payeeBank, yuanText(i.amountCents), i.purpose] },
  ccb: { headers: ['序号', '收款账号', '收款户名', '收款行名', '金额', '摘要'], row: (i) => [i.lineNo, i.payeeAccount, i.payeeName, i.payeeBank, yuanText(i.amountCents), i.purpose] },
  cmb: { headers: ['收方账号', '收方户名', '收方开户行', '金额', '用途'], row: (i) => [i.payeeAccount, i.payeeName, i.payeeBank, yuanText(i.amountCents), i.purpose] },
  generic: { headers: ['序号', '收款户名', '收款账号', '收款开户行', '金额（元）', '用途'], row: (i) => [i.lineNo, i.payeeName, i.payeeAccount, i.payeeBank, yuanText(i.amountCents), i.purpose] },
};

async function exportBatch(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<BatchView> {
  const { version } = parse(z.object({ version: z.number().int().min(1) }), raw);
  await deps.sql.begin(async (tx) => {
    const [b] = await tx<{ status: string; version: number; batchNo: string }[]>`SELECT status, version, batch_no FROM payment_batches WHERE id = ${id} FOR UPDATE`;
    if (!b) throw notFound('批次不存在');
    if (b.version !== version) throw conflict('BATCH_CHANGED', '这一批刚被别人改过，请刷新后再看');
    if (b.status === 'exported') return;
    if (b.status !== 'draft') throw conflict('BATCH_CLOSED', '这一批已经完成或作废了');
    await tx`UPDATE payment_batches SET status = 'exported', exported_by = ${actor.id}, exported_at = now(), version = version + 1 WHERE id = ${id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'payment_batch', targetType: 'payment_batch', targetId: id, detail: { op: 'export', batchNo: b.batchNo }, ip });
  });
  return getBatch(deps.sql, id);
}

async function batchFile(db: Db, id: number): Promise<{ name: string; type: string; body: Buffer | string }> {
  const [b] = await db<{ batchNo: string; template: BankTemplate; status: string }[]>`SELECT batch_no, template, status FROM payment_batches WHERE id = ${id}`;
  if (!b) throw notFound('批次不存在');
  if (b.status === 'draft' || b.status === 'voided') throw conflict('BATCH_NOT_EXPORTED', b.status === 'draft' ? '先点「导出」把这一批定下来' : '这一批已经作废了');
  const items = await db<{ lineNo: number; payeeName: string; payeeBank: string; payeeAccount: string; amountCents: string; purpose: string }[]>`
    SELECT line_no, payee_name, payee_bank, payee_account, amount_cents::text AS amount_cents, purpose FROM payment_batch_items WHERE batch_id = ${id} AND status <> 'removed' ORDER BY line_no`;
  const t = TEMPLATE_COLUMNS[b.template];
  const rows = items.map((i) => t.row({ ...i, amountCents: Number(i.amountCents) }));
  if (b.template === 'generic') return { name: `批量付款-${b.batchNo}.csv`, type: 'text/csv; charset=utf-8', body: toCsv([t.headers, ...rows]) };
  const wb = buildWorkbook([{ name: '批量转账', widths: t.headers.map((h) => Math.max(10, h.length * 2 + 4)), rows: [{ cells: t.headers }, ...rows.map((cells) => ({ cells: cells.map(String) }))], freezeRows: 1 }]);
  return { name: `批量付款-${b.batchNo}-${BANK_TEMPLATE_LABELS[b.template]}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: wb };
}

// ───────────────────────── 作废、结果 ─────────────────────────

async function voidBatch(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<BatchView> {
  const input = parse(z.object({ version: z.number().int().min(1), reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200), confirmNotPaid: z.literal(true, '请确认这一批没有在网银里付款') }), raw);
  await deps.sql.begin(async (tx) => {
    const [b] = await tx<{ status: string; version: number; batchNo: string }[]>`SELECT status, version, batch_no FROM payment_batches WHERE id = ${id} FOR UPDATE`;
    if (!b) throw notFound('批次不存在');
    if (b.version !== input.version) throw conflict('BATCH_CHANGED', '这一批刚被别人改过，请刷新后再看');
    if (b.status === 'voided') return;
    if (b.status === 'done') throw conflict('BATCH_CLOSED', '这一批已经完成了');
    const [paid] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM payment_batch_items WHERE batch_id = ${id} AND (status = 'paid' OR paid_on IS NOT NULL)`;
    if (paid!.n > 0) throw conflict('BATCH_HAS_PAID', '这一批已经有记了已付的，不能作废；没付的标「失败」');
    await tx`UPDATE payment_batch_items SET status = 'removed', active = false, fail_reason = '批次作废', updated_by = ${actor.id}, updated_at = now() WHERE batch_id = ${id} AND status = 'pending'`;
    await tx`UPDATE payment_batches SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${input.reason}, version = version + 1 WHERE id = ${id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'payment_batch', targetType: 'payment_batch', targetId: id, detail: { op: 'void', batchNo: b.batchNo, reason: input.reason }, ip });
  });
  return getBatch(deps.sql, id);
}

async function closeIfDone(db: Db, batchId: number) {
  const [left] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM payment_batch_items WHERE batch_id = ${batchId} AND status = 'pending'`;
  if (left!.n === 0) await db`UPDATE payment_batches SET status = 'done', version = version + 1 WHERE id = ${batchId} AND status = 'exported'`;
}

/** 这一行的操作编号已经记过的付款（按申请登记的付款，或合同付款） */
async function priorPayment(db: Db, key: string): Promise<{ kind: 'payment' | 'payout'; paymentId: number } | null> {
  const [p] = await db<{ refId: number }[]>`SELECT ref_id FROM idempotency_keys WHERE key = ${key} AND op_type = 'payment'`;
  if (p) return { kind: 'payment', paymentId: Number(p.refId) };
  const [o] = await db<{ id: number }[]>`SELECT id FROM contract_payouts WHERE client_key = ${key}`;
  return o ? { kind: 'payout', paymentId: Number(o.id) } : null;
}

/** 照「按申请登记付款」记这一行（用这一行自己的操作编号） */
async function payItem(
  deps: Deps,
  claim: { requestId: number; amountCents: number; payDate: string; key: string },
  evidence: string,
  actor: Actor,
  ip?: string,
): Promise<{ kind: 'payment' | 'payout'; paymentId: number }> {
  const req = await getPaymentRequest(deps.sql, claim.requestId, todayIn(deps.config.timezone));
  if (req.payMode === 'direct') {
    const r = await payoutFromRequest(deps, claim.requestId, { clientKey: claim.key, payDate: claim.payDate, amountCents: claim.amountCents, method: 'bank_transfer', evidence, note: '' }, actor, ip);
    return { kind: 'payout', paymentId: r.payoutId };
  }
  // 没挂合同的：核销到申请里选的那几笔（按顺序）；挂了合同的：记预付款，之后按收货核销
  const allocations: { kind: 'receipt' | 'opening'; targetId: number; amountCents: number }[] = [];
  let prepay = false;
  if (req.contractId === null) {
    let left = claim.amountCents;
    for (const t of req.targets) {
      const room = Math.min(t.amountCents - t.paidCents, t.openCents);
      if (room <= 0 || left <= 0) continue;
      const a = Math.min(room, left);
      allocations.push({ kind: t.kind, targetId: t.targetId, amountCents: a });
      left -= a;
    }
    if (left > 0) throw unprocessable('BATCH_ALLOC', `付款申请 ${req.requestNo} 里选的货款不够核销 ¥${yuanText(claim.amountCents)}，请到付款申请里手工登记`);
  } else prepay = true;
  const r = await payFromRequest(deps, claim.requestId, { clientKey: claim.key, payDate: claim.payDate, amountCents: claim.amountCents, method: 'bank_transfer', evidence, note: '', allocations, prepay }, actor, ip);
  return { kind: 'payment', paymentId: r.paymentId };
}

/** 记这一行已付：照「按申请登记付款」记账（重来也只记一次） */
export async function recordItemPaid(deps: Deps, itemId: number, input: { payDate: string; bankRef: string }, actor: Actor, ip?: string): Promise<void> {
  const claim = await deps.sql.begin(async (tx) => {
    const [head] = await tx<{ batchId: number }[]>`SELECT batch_id FROM payment_batch_items WHERE id = ${itemId}`;
    if (!head) throw notFound('这一行不存在');
    const [b] = await tx<{ status: string; batchNo: string }[]>`SELECT status, batch_no FROM payment_batches WHERE id = ${head.batchId} FOR UPDATE`;
    const [i] = await tx<{ status: string; paidOn: string | null; bankRef: string; requestId: number; amountCents: string; payClientKey: string }[]>`
      SELECT status, paid_on::text AS paid_on, bank_ref, payment_request_id AS request_id, amount_cents::text AS amount_cents, pay_client_key
      FROM payment_batch_items WHERE id = ${itemId} FOR UPDATE`;
    if (i!.status === 'paid') return null;
    if (i!.status !== 'pending') throw conflict('BATCH_ITEM_CLOSED', '这一行已经标了失败或移出了');
    if (b!.status !== 'exported') throw conflict('BATCH_NOT_EXPORTED', b!.status === 'draft' ? '这一批还没导出' : '这一批已经结束了');
    // 第一次记下付款日与流水号，之后重来都按这一次的（原请求的摘要对得上）
    if (i!.paidOn === null) await tx`UPDATE payment_batch_items SET paid_on = ${input.payDate}, bank_ref = ${input.bankRef.slice(0, 64)}, updated_by = ${actor.id}, updated_at = now() WHERE id = ${itemId}`;
    return { batchId: Number(head.batchId), batchNo: b!.batchNo, requestId: Number(i!.requestId), amountCents: Number(i!.amountCents), payDate: i!.paidOn ?? input.payDate, bankRef: i!.paidOn === null ? input.bankRef.slice(0, 64) : i!.bankRef, key: i!.payClientKey };
  });
  if (!claim) return;
  const evidence = `批量付款 ${claim.batchNo}${claim.bankRef ? ` 流水 ${claim.bankRef}` : ''}`.slice(0, 200);
  // 上一次已经记上了付款、没来得及把这一行标已付（进程停了、超时）：按这一行自己的操作编号找回那笔，
  // 不再按现在的余额重算核销（记过以后申请里的货款已经核销掉了，重算会以为不够核销而卡住）
  const prior = await priorPayment(deps.sql, claim.key);
  const { kind, paymentId } = prior ?? (await payItem(deps, claim, evidence, actor, ip));
  await deps.sql.begin(async (tx) => {
    await tx`SELECT id FROM payment_batches WHERE id = ${claim.batchId} FOR UPDATE`;
    const [i] = await tx<{ status: string }[]>`SELECT status FROM payment_batch_items WHERE id = ${itemId} FOR UPDATE`;
    if (i!.status === 'paid') return;
    await tx`UPDATE payment_batch_items SET status = 'paid', active = false, payment_kind = ${kind}, payment_id = ${paymentId}, updated_by = ${actor.id}, updated_at = now() WHERE id = ${itemId}`;
    await closeIfDone(tx, claim.batchId);
    await writeAudit(tx, { staffId: actor.id, action: 'payment_batch', targetType: 'payment_batch', targetId: claim.batchId, detail: { op: 'paid', item: itemId, kind, paymentId }, ip });
  });
}

async function markFailed(deps: Deps, itemId: number, raw: unknown, actor: Actor, ip?: string) {
  const { reason } = parse(z.object({ reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200) }), raw);
  await deps.sql.begin(async (tx) => {
    const [head] = await tx<{ batchId: number }[]>`SELECT batch_id FROM payment_batch_items WHERE id = ${itemId}`;
    if (!head) throw notFound('这一行不存在');
    const [b] = await tx<{ status: string }[]>`SELECT status FROM payment_batches WHERE id = ${head.batchId} FOR UPDATE`;
    const [i] = await tx<{ status: string; paidOn: string | null }[]>`SELECT status, paid_on::text AS paid_on FROM payment_batch_items WHERE id = ${itemId} FOR UPDATE`;
    if (i!.status !== 'pending') throw conflict('BATCH_ITEM_CLOSED', '这一行已经有结论了');
    if (i!.paidOn !== null) throw conflict('BATCH_ITEM_PAYING', '这一行正在记已付（上一次没做完），请再点一次「标记已付」');
    if (b!.status !== 'exported') throw conflict('BATCH_NOT_EXPORTED', '这一批还没导出或已经结束');
    const [m] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_matches WHERE target_type = 'batch_item' AND target_id = ${itemId} AND status = 'active'`;
    if (m!.n > 0) throw conflict('BATCH_ITEM_MATCHED', '这一行已经对上银行流水了，先在银行流水里撤销勾对');
    await tx`UPDATE payment_batch_items SET status = 'failed', active = false, fail_reason = ${reason}, updated_by = ${actor.id}, updated_at = now() WHERE id = ${itemId}`;
    await closeIfDone(tx, Number(head.batchId));
    await writeAudit(tx, { staffId: actor.id, action: 'payment_batch', targetType: 'payment_batch', targetId: Number(head.batchId), detail: { op: 'failed', item: itemId, reason }, ip });
  });
}

export function registerPaymentBatchRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const today = () => todayIn(deps.config.timezone);
  app.get('/api/erp/payments/batches', { preHandler: READ }, async () => readSnapshot(sql, async (tx) => ({ batches: await batchesWhere(tx, tx`TRUE`), candidates: await candidates(tx) })));
  app.get('/api/erp/payments/batches/:id', { preHandler: READ }, async (req) => getBatch(sql, parse(idParam, req.params).id));
  app.post('/api/erp/payments/batches', { preHandler: MANAGE }, async (req, reply) => {
    const r = await createBatch(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return { replayed: r.replayed, batch: await getBatch(sql, r.id) };
  });
  app.post('/api/erp/payments/batches/:id/export', { preHandler: MANAGE }, async (req) => exportBatch(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.get('/api/erp/payments/batches/:id/file', { preHandler: MANAGE }, async (req, reply) => {
    const f = await batchFile(sql, parse(idParam, req.params).id);
    await writeAudit(sql, { staffId: req.actor.id, action: 'payment_batch', targetType: 'payment_batch', targetId: parse(idParam, req.params).id, detail: { op: 'download', file: f.name }, ip: req.ip });
    attachment(reply, f.name, f.type);
    return reply.send(f.body);
  });
  app.post('/api/erp/payments/batches/:id/void', { preHandler: MANAGE }, async (req) => voidBatch(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.post('/api/erp/payments/batch-items/:id/paid', { preHandler: MANAGE }, async (req) => {
    const id = parse(idParam, req.params).id;
    const input = parse(z.object({ payDate: dateSchema('付款日'), bankRef: z.string().trim().max(64).default('') }), req.body);
    if (input.payDate > today()) throw badRequest('付款日不能晚于今天');
    await recordItemPaid(deps, id, input, req.actor, req.ip);
    const [i] = await sql<{ batchId: number }[]>`SELECT batch_id FROM payment_batch_items WHERE id = ${id}`;
    return getBatch(sql, Number(i!.batchId));
  });
  app.post('/api/erp/payments/batch-items/:id/failed', { preHandler: MANAGE }, async (req) => {
    const id = parse(idParam, req.params).id;
    await markFailed(deps, id, req.body, req.actor, req.ip);
    const [i] = await sql<{ batchId: number }[]>`SELECT batch_id FROM payment_batch_items WHERE id = ${id}`;
    return getBatch(sql, Number(i!.batchId));
  });
}
