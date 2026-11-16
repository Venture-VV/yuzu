// 8.0.21 开票申请（销项，docs/FINANCE_V8021.md 第 3 节，CW-B / CW2 / CW13–CW15）。
//   · 申请：前台在结账记录（frontdesk.checkout）、充值记录（recharge.create）上，财务在协议单位回款上（ar.manage）；有「开票」的都能申请。
//     可开金额 = 来源的实收（CW13）：结账单只算现金类收款（微信、支付宝、现金、银行卡、其他），减去已生效的退款；
//     储值在充值时开（充值的实收）；协议单位按回款开。同一来源同时只有一张申请中 / 已开的。
//   · 处理（invoice.issue，ERP「财务 → 开票」）：登记已开（手工开好、填号码、可传 PDF）；交给开票服务商开（适配器，8.0.21 只有模拟的）；
//     驳回、作废（写原因）。来源反结账、作废不拦，已开的标「来源已作废，要红冲」（CW15）。
// 锁：申请先取操作编号的咨询锁（与「确认作废」串行，业务类型 invoice_request）→ 来源一行（FOR KEY SHARE，锁住以后核对没反结账、没作废）→ 写申请，
//     同一来源靠部分唯一索引兜底；处理只锁申请一行（带版本号）。交给服务商开：先在锁里把申请记成「发送中」（issued_via = sending），
//     事务外调服务商，再锁申请一行写结果——同一张不会同时发两次；结果没回来（进程中断）的由财务确认后改回「申请中」。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PAYMENT_METHODS } from '@shared/labels';
import { can, type Permission } from '@shared/permissions';
import { INVOICE_SOURCE_LABELS, INVOICE_SOURCE_TYPES, TAX_NO_PATTERN, type InvoiceSourceInfo, type InvoiceSourceType, type SalesInvoice, type SalesInvoiceList } from '@shared/sales-invoices';
import { guard, sessionOnly } from '../auth/guard';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../db';
import { eInvoiceAdapter } from '../integrations/einvoice';
import { modeOf } from '../integrations/config';
import { withCallLog } from '../integrations/calls';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Actor, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { todayIn } from '../lib/dates';
import { dateSchema, idParam, parse } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { readFile, storePdf } from './inventory/files';

const yuan = (cents: number) => `¥${Math.trunc(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

/** 申请、查看来源要的权限（有其一即可；有「开票」的都行） */
const SOURCE_PERMS: Record<InvoiceSourceType, Permission[]> = {
  checkout: ['frontdesk.checkout', 'invoice.issue'],
  recharge: ['recharge.create', 'invoice.issue'],
  ar_collection: ['ar.manage', 'invoice.issue'],
};
function assertSourcePerm(req: FastifyRequest, type: InvoiceSourceType) {
  if (req.actor.mustChangePassword) throw forbidden('首次登录请先修改密码');
  if (!SOURCE_PERMS[type].some((p) => can(req.actor, p))) throw forbidden();
}

// ───────────────────────── 来源 ─────────────────────────

interface SourceRow {
  no: string;
  date: string;
  voided: boolean;
  invoiceableCents: number;
  basis: string[];
  partyName: string;
}

/** 来源的情况与可开金额；lock = 在申请的事务里（FOR KEY SHARE 锁住来源一行） */
async function loadSource(db: Db, type: InvoiceSourceType, id: number, lock: boolean): Promise<SourceRow> {
  if (type === 'checkout') {
    const [c] = lock
      ? await db<{ no: string; date: string; status: string; memberName: string | null }[]>`
          SELECT c.checkout_no AS no, c.business_date::text AS date, c.status, NULL::text AS member_name FROM checkouts c WHERE c.id = ${id} FOR KEY SHARE`
      : await db<{ no: string; date: string; status: string; memberName: string | null }[]>`
          SELECT c.checkout_no AS no, c.business_date::text AS date, c.status,
                 (SELECT m.name FROM checkout_payments p JOIN members m ON m.id = p.member_id WHERE p.checkout_id = c.id ORDER BY p.id LIMIT 1) AS member_name
          FROM checkouts c WHERE c.id = ${id}`;
    if (!c) throw notFound('结账单不存在');
    const pays = await db<{ method: string; amount: string }[]>`
      SELECT method, sum(amount)::text AS amount FROM checkout_payments WHERE checkout_id = ${id} GROUP BY method`;
    const [ref] = await db<{ amount: string }[]>`
      SELECT coalesce(sum(rp.amount), 0)::text AS amount
      FROM refund_payments rp JOIN refunds r ON r.id = rp.refund_id
      WHERE r.checkout_id = ${id} AND r.status = 'completed'`;
    const cash = pays.filter((p) => (PAYMENT_METHODS as readonly string[]).includes(p.method)).reduce((s, p) => s + Number(p.amount), 0);
    const other = pays.filter((p) => !(PAYMENT_METHODS as readonly string[]).includes(p.method)).reduce((s, p) => s + Number(p.amount), 0);
    const refunded = Number(ref!.amount);
    const basis = [`现金类收款 ${yuan(cash)}`];
    if (other > 0) basis.push(`储值、券、优惠、挂账等 ${yuan(other)} 不在这里开（储值在充值时开，挂账按回款开）`);
    if (refunded > 0) basis.push(`已退款 ${yuan(refunded)}`);
    const voided = c.status === 'voided';
    return { no: c.no, date: c.date, voided, invoiceableCents: voided ? 0 : Math.max(0, cash - refunded), basis, partyName: c.memberName ?? '' };
  }
  if (type === 'recharge') {
    const [r] = lock
      ? await db<{ no: string; date: string; paid: string; bonus: string; memberName: string }[]>`
          SELECT r.doc_no AS no, r.business_date::text AS date, r.paid_amount::text AS paid, r.bonus_amount::text AS bonus, '' AS member_name
          FROM recharges r WHERE r.id = ${id} FOR KEY SHARE`
      : await db<{ no: string; date: string; paid: string; bonus: string; memberName: string }[]>`
          SELECT r.doc_no AS no, r.business_date::text AS date, r.paid_amount::text AS paid, r.bonus_amount::text AS bonus, m.name AS member_name
          FROM recharges r JOIN members m ON m.id = r.member_id WHERE r.id = ${id}`;
    if (!r) throw notFound('充值记录不存在');
    const basis = [`充值实收 ${yuan(Number(r.paid))}`];
    if (Number(r.bonus) > 0) basis.push(`赠金 ${yuan(Number(r.bonus))} 不开票`);
    return { no: r.no, date: r.date, voided: false, invoiceableCents: Number(r.paid), basis, partyName: r.memberName };
  }
  const [a] = lock
    ? await db<{ no: string; date: string; amount: string; voided: boolean; accountName: string }[]>`
        SELECT c.doc_no AS no, c.collected_on::text AS date, c.amount_cents::text AS amount, c.voided_at IS NOT NULL AS voided, '' AS account_name
        FROM ar_collections c WHERE c.id = ${id} FOR KEY SHARE`
    : await db<{ no: string; date: string; amount: string; voided: boolean; accountName: string }[]>`
        SELECT c.doc_no AS no, c.collected_on::text AS date, c.amount_cents::text AS amount, c.voided_at IS NOT NULL AS voided, a.name AS account_name
        FROM ar_collections c JOIN ar_accounts a ON a.id = c.account_id WHERE c.id = ${id}`;
  if (!a) throw notFound('回款登记不存在');
  return { no: a.no, date: a.date, voided: a.voided, invoiceableCents: a.voided ? 0 : Number(a.amount), basis: [`回款 ${yuan(Number(a.amount))}`], partyName: a.accountName };
}

// ───────────────────────── 读 ─────────────────────────

interface Raw extends Omit<SalesInvoice, 'id' | 'sourceId' | 'amountCents' | 'hasFile' | 'sourceVoided'> {
  id: number;
  sourceId: number;
  amountCents: string;
  fileId: number | null;
  sourceVoided: boolean;
}

/** 来源已经反结账 / 冲销（开了票的要红冲）：列、「要红冲」筛选、红冲计数共用这一个条件 */
const SOURCE_VOIDED = (db: Db) => db`
  CASE i.source_type
    WHEN 'checkout' THEN EXISTS (SELECT 1 FROM checkouts c WHERE c.id = i.source_id AND c.status = 'voided')
    WHEN 'ar_collection' THEN EXISTS (SELECT 1 FROM ar_collections a WHERE a.id = i.source_id AND a.voided_at IS NOT NULL)
    ELSE false END`;
/**
 * 开票金额超过来源现在的可开金额（结账单申请或开票以后退了款；反结账、作废的由 SOURCE_VOIDED 标）。可开金额与 loadSource 同一个口径：
 * 现金类实收 − 已完成的退款（Codex 审查 0edd8df 后补：已开的要红冲后按现在的金额重开，没开的处理时拦下）
 */
const SOURCE_REDUCED = (db: Db) => db`
  CASE i.source_type
    WHEN 'checkout' THEN i.amount_cents > (
      (SELECT coalesce(sum(p.amount), 0) FROM checkout_payments p WHERE p.checkout_id = i.source_id AND p.method IN ${db([...PAYMENT_METHODS])})
      - (SELECT coalesce(sum(rp.amount), 0) FROM refund_payments rp JOIN refunds r ON r.id = rp.refund_id WHERE r.checkout_id = i.source_id AND r.status = 'completed'))
    ELSE false END`;
const COLUMNS = (db: Db) => db`
  i.id, i.request_no, i.source_type, i.source_id, i.source_no, i.amount_cents::text AS amount_cents, i.title_type, i.title, i.tax_no, i.email, i.phone,
  i.invoice_kind, i.note, i.status, i.invoice_no, i.invoice_date::text AS invoice_date, i.file_id, i.issued_via, i.provider_ref, i.reject_reason, i.void_reason,
  i.version, rq.display_name AS requested_by_name, i.requested_at, hd.display_name AS handled_by_name, i.handled_at, vd.display_name AS voided_by_name, i.voided_at,
  ${SOURCE_VOIDED(db)} AS source_voided, ${SOURCE_REDUCED(db)} AS source_reduced`;
const FROM = (db: Db) => db`
  invoice_requests i JOIN staff rq ON rq.id = i.requested_by LEFT JOIN staff hd ON hd.id = i.handled_by LEFT JOIN staff vd ON vd.id = i.voided_by`;

const toInvoice = (r: Raw): SalesInvoice => {
  const { fileId, ...rest } = r;
  return {
    ...rest,
    id: Number(r.id),
    sourceId: Number(r.sourceId),
    amountCents: Number(r.amountCents),
    hasFile: fileId !== null,
    requestedAt: new Date(r.requestedAt).toISOString(),
    handledAt: r.handledAt ? new Date(r.handledAt).toISOString() : null,
    voidedAt: r.voidedAt ? new Date(r.voidedAt).toISOString() : null,
  };
};

export async function getSalesInvoice(db: Db, id: number): Promise<SalesInvoice> {
  const [r] = await db<Raw[]>`SELECT ${COLUMNS(db)} FROM ${FROM(db)} WHERE i.id = ${id}`;
  if (!r) throw notFound('开票申请不存在');
  return toInvoice(r);
}

export async function sourceInfo(db: Db, type: InvoiceSourceType, id: number): Promise<InvoiceSourceInfo> {
  const s = await loadSource(db, type, id, false);
  const rows = (await db<Raw[]>`SELECT ${COLUMNS(db)} FROM ${FROM(db)} WHERE i.source_type = ${type} AND i.source_id = ${id} ORDER BY i.id DESC`).map(toInvoice);
  return {
    type,
    id,
    no: s.no,
    date: s.date,
    invoiceableCents: s.invoiceableCents,
    basis: s.basis,
    voided: s.voided,
    partyName: s.partyName,
    active: rows.find((r) => r.status === 'requested' || r.status === 'issued') ?? null,
    history: rows,
  };
}

const ListQuery = z.object({
  status: z.enum(['requested', 'issued', 'rejected', 'voided', 'all', 'red']).default('requested'),
  q: z.string().trim().max(40).default(''),
});

export async function listSalesInvoices(db: Db, raw: unknown, mode: SalesInvoiceList['providerMode']): Promise<SalesInvoiceList> {
  const q = parse(ListQuery, raw);
  const like = `%${q.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  // 「要红冲」在 SQL 里先筛再取最近的 500 张（Codex 审查 beabd59 后补：原来先取 500 张已开的再在内存里筛，早的那张会漏掉）
  const rows = (
    await db<Raw[]>`
      SELECT ${COLUMNS(db)} FROM ${FROM(db)}
      WHERE (${q.status} = 'all' OR i.status = ${q.status} OR (${q.status} = 'red' AND i.status = 'issued' AND (${SOURCE_VOIDED(db)} OR ${SOURCE_REDUCED(db)})))
        AND (${q.q} = '' OR i.request_no ILIKE ${like} OR i.source_no ILIKE ${like} OR i.title ILIKE ${like} OR coalesce(i.invoice_no, '') ILIKE ${like})
      ORDER BY i.id DESC LIMIT 500`
  ).map(toInvoice);
  const [c] = await db<{ requested: number; issued: number; sending: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'requested')::int AS requested, count(*) FILTER (WHERE status = 'issued')::int AS issued,
           count(*) FILTER (WHERE status = 'requested' AND issued_via = 'sending')::int AS sending
    FROM invoice_requests`;
  const [red] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM invoice_requests i WHERE i.status = 'issued' AND (${SOURCE_VOIDED(db)} OR ${SOURCE_REDUCED(db)})`;
  return { rows, counts: { ...c!, redFlag: red!.n }, providerMode: mode };
}

// ───────────────────────── 申请 ─────────────────────────

const RequestInput = z
  .object({
    clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
    sourceType: z.enum(INVOICE_SOURCE_TYPES, '来源不对'),
    sourceId: z.number().int().positive('来源编号不对'),
    amountCents: z.number('请填写开票金额').int('金额要精确到分').positive('开票金额要大于 0'),
    titleType: z.enum(['personal', 'company'], '请选择抬头类型'),
    title: z.string('请填写抬头').trim().min(1, '请填写抬头').max(100, '抬头最多 100 个字'),
    taxNo: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase().replace(/\s/g, ''))
      .refine((s) => s === '' || TAX_NO_PATTERN.test(s), '税号是 15–20 位数字或大写字母')
      .default(''),
    email: z.union([z.literal(''), z.email('邮箱格式不对')]).default(''),
    phone: z
      .string()
      .trim()
      .max(20)
      .refine((s) => s === '' || /^[0-9+\-\s]{6,20}$/.test(s), '手机号格式不对')
      .default(''),
    invoiceKind: z.enum(['normal', 'special'], '请选择发票种类').default('normal'),
    note: z.string().trim().max(200, '备注最多 200 个字').default(''),
  })
  .refine((v) => v.titleType === 'company' || v.invoiceKind === 'normal', { message: '个人抬头只能开普通发票', path: ['invoiceKind'] })
  .refine((v) => v.invoiceKind === 'normal' || v.taxNo !== '', { message: '专票要填税号', path: ['taxNo'] });

export async function requestInvoice(deps: Deps, raw: unknown, ctx: OpContext): Promise<{ request: SalesInvoice; replayed: boolean }> {
  const input = parse(RequestInput, raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM invoice_requests WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已用于另一份开票申请，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    const result = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, input.clientKey, 'invoice_request', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      const src = await loadSource(tx, input.sourceType, input.sourceId, true);
      if (src.voided) throw unprocessable('SOURCE_VOIDED', `${INVOICE_SOURCE_LABELS[input.sourceType]} ${src.no} 已反结账或作废，不能申请开票`);
      if (src.invoiceableCents <= 0) throw unprocessable('NOTHING_TO_INVOICE', `${INVOICE_SOURCE_LABELS[input.sourceType]} ${src.no} 没有能开票的金额（${src.basis.join('；')}）`);
      if (input.amountCents > src.invoiceableCents) {
        throw unprocessable('AMOUNT_OVER', `开票金额 ${yuan(input.amountCents)} 超过可开金额 ${yuan(src.invoiceableCents)}（${src.basis.join('；')}）`);
      }
      const [active] = await tx<{ requestNo: string }[]>`
        SELECT request_no FROM invoice_requests WHERE source_type = ${input.sourceType} AND source_id = ${input.sourceId} AND status IN ('requested', 'issued')`;
      if (active) throw conflict('INVOICE_REQUEST_EXISTS', `这一笔已经有开票申请 ${active.requestNo}（同一笔只能开一次；要重开先作废原来那张）`);
      const today = todayIn(deps.config.timezone);
      const requestNo = await nextDocNo(tx, 'invoice_request', 'KP', today);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO invoice_requests (request_no, source_type, source_id, source_no, amount_cents, title_type, title, tax_no, email, phone,
                                      invoice_kind, note, client_key, request_hash, requested_by, entity_id)
        VALUES (${requestNo}, ${input.sourceType}, ${input.sourceId}, ${src.no}, ${input.amountCents}, ${input.titleType}, ${input.title}, ${input.taxNo},
                ${input.email}, ${input.phone}, ${input.invoiceKind}, ${input.note}, ${input.clientKey}, ${requestHash}, ${ctx.actor.id},
                -- 销售方（8.0.22）：结账、充值发生在哪家店就是那家店的主体；回款是当前门店的主体
                coalesce((SELECT entity_id FROM stores WHERE id = ${
                  input.sourceType === 'checkout'
                    ? tx`(SELECT store_id FROM checkouts WHERE id = ${input.sourceId})`
                    : input.sourceType === 'recharge'
                      ? tx`(SELECT store_id FROM recharges WHERE id = ${input.sourceId})`
                      : tx`NULL::bigint`
                }), yuzu_entity()))
        RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'invoice_request',
        targetType: 'invoice_request',
        targetId: row!.id,
        detail: { op: 'request', requestNo, source: `${INVOICE_SOURCE_LABELS[input.sourceType]} ${src.no}`, amountCents: input.amountCents, title: input.title },
        ip: ctx.ip,
      });
      return { id: Number(row!.id), replayed: false };
    });
    return { request: await getSalesInvoice(deps.sql, result.id), replayed: result.replayed };
  } catch (error) {
    if (isUniqueViolation(error, 'invoice_requests_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { request: await getSalesInvoice(deps.sql, existing), replayed: true };
    }
    if (isUniqueViolation(error, 'invoice_requests_active_uq')) throw conflict('INVOICE_REQUEST_EXISTS', '这一笔已经有开票申请（同一笔只能开一次；要重开先作废原来那张）');
    throw error;
  }
}

// ───────────────────────── 处理 ─────────────────────────

const Version = z.number('缺少版本号，请刷新后重试').int().min(1);
const Reason = z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 个字');

async function lockRequest(tx: Tx, id: number, version: number) {
  const [r] = await tx<{ status: string; version: number; issuedVia: string | null; requestNo: string; amountCents: string }[]>`
    SELECT status, version, issued_via, request_no, amount_cents::text AS amount_cents FROM invoice_requests WHERE id = ${id} FOR UPDATE`;
  if (!r) throw notFound('开票申请不存在');
  if (r.version !== version) throw conflict('INVOICE_REQUEST_CHANGED', '这张申请刚被别人处理过，请刷新后再看');
  return r;
}

/**
 * 处理（登记已开、交给服务商开）之前按来源现在的情况再核对一次：申请以后反结账、作废，或退了款、金额超过现在可开的，
 * 这张就不能开，要驳回后按现在的金额重新申请（Codex 审查 0edd8df 后补）。在锁住申请一行以后对来源加共享键锁（与申请时同一把），
 * 与反结账、退款单（锁结账单一行）串行
 */
async function assertStillInvoiceable(tx: Tx, id: number) {
  const [q] = await tx<{ sourceType: InvoiceSourceType; sourceId: number; amountCents: string }[]>`
    SELECT source_type, source_id, amount_cents::text AS amount_cents FROM invoice_requests WHERE id = ${id}`;
  const label = INVOICE_SOURCE_LABELS[q!.sourceType];
  const src = await loadSource(tx, q!.sourceType, Number(q!.sourceId), true);
  if (src.voided) throw conflict('SOURCE_VOIDED', `${label} ${src.no} 已反结账或作废：这张申请开不了，请驳回`);
  const amount = Number(q!.amountCents);
  if (amount > src.invoiceableCents) {
    throw conflict('SOURCE_CHANGED', `这张申请 ${yuan(amount)}，${label} ${src.no} 现在只能开 ${yuan(src.invoiceableCents)}（${src.basis.join('；')}）：请驳回后按现在的金额重新申请`);
  }
}

const IssueInput = z.object({
  version: Version,
  invoiceNo: z.string('请填写发票号码').trim().min(1, '请填写发票号码').max(40, '发票号码最多 40 位'),
  invoiceDate: dateSchema('开票日'),
  pdf: z
    .object({ name: z.string().trim().min(1).max(80), data: z.string().min(16) })
    .nullable()
    .default(null),
});

/** 登记已开（手工在开票系统里开好，回来填号码、可传 PDF） */
export async function issueManually(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<SalesInvoice> {
  const input = parse(IssueInput, raw);
  if (input.invoiceDate > todayIn(deps.config.timezone)) throw badRequest('开票日不能晚于今天');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const r = await lockRequest(tx, id, input.version);
    if (r.status !== 'requested') throw conflict('INVOICE_REQUEST_DONE', '这张申请已经处理过了');
    if (r.issuedVia === 'sending') throw conflict('INVOICE_SENDING', '这张已经交给开票服务商、结果还没回来；确认服务商没开出以后先改回「申请中」');
    await assertStillInvoiceable(tx, id);
    const file = input.pdf ? await storePdf(tx, 'sales_invoice', input.pdf.data, actor) : null;
    await tx`
      UPDATE invoice_requests
      SET status = 'issued', invoice_no = ${input.invoiceNo}, invoice_date = ${input.invoiceDate}, file_id = ${file?.id ?? null}, issued_via = 'manual',
          handled_by = ${actor.id}, handled_at = now(), version = version + 1
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'invoice_request',
      targetType: 'invoice_request',
      targetId: id,
      detail: { op: 'issue', requestNo: r.requestNo, invoiceNo: input.invoiceNo, via: 'manual' },
      ip,
    });
  });
  return getSalesInvoice(deps.sql, id);
}

/** 交给开票服务商开：先记「发送中」，事务外调服务商，再写结果 */
export async function issueViaProvider(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<SalesInvoice> {
  const { version } = parse(z.object({ version: Version }), raw);
  const adapter = eInvoiceAdapter(deps.config.integrations);
  if (!adapter) throw unprocessable('EINVOICE_OFF', '开票服务商还没接（等服务商账号联调）；请在开票系统里开好后「登记已开」');
  const req = await deps.sql.begin(async (tx) => {
    const r = await lockRequest(tx, id, version);
    if (r.status !== 'requested') throw conflict('INVOICE_REQUEST_DONE', '这张申请已经处理过了');
    if (r.issuedVia === 'sending') throw conflict('INVOICE_SENDING', '这张已经交给开票服务商了，等结果');
    await assertStillInvoiceable(tx, id);
    await tx`UPDATE invoice_requests SET issued_via = 'sending', handled_by = ${actor.id}, handled_at = now(), version = version + 1 WHERE id = ${id}`;
    const [d] = await tx<{ titleType: 'personal' | 'company'; title: string; taxNo: string; invoiceKind: 'normal' | 'special' }[]>`
      SELECT title_type, title, tax_no, invoice_kind FROM invoice_requests WHERE id = ${id}`;
    return { ...d!, requestNo: r.requestNo, amountCents: Number(r.amountCents) };
  });
  const today = todayIn(deps.config.timezone);
  let result;
  try {
    result = await withCallLog(
      deps.sql,
      {
        kind: 'einvoice',
        provider: adapter.provider,
        action: 'issue',
        mode: adapter.mode,
        refType: 'invoice_request',
        refId: id,
        staffId: actor.id,
        request: { requestNo: req.requestNo, amountCents: req.amountCents, kind: req.invoiceKind, titleType: req.titleType },
      },
      () => adapter.issue({ requestId: id, requestNo: req.requestNo, titleType: req.titleType, title: req.title, taxNo: req.taxNo, kind: req.invoiceKind, amountCents: req.amountCents }, today),
      (r) => ({ invoiceNo: r.invoiceNo, providerRef: r.providerRef }),
    );
  } catch (error) {
    // 服务商明确失败：改回「申请中」，可以再发或手工开
    await deps.sql.begin(async (tx) => {
      await tx`UPDATE invoice_requests SET issued_via = NULL, version = version + 1 WHERE id = ${id} AND status = 'requested' AND issued_via = 'sending'`;
    });
    throw unprocessable('EINVOICE_FAILED', `开票服务商没开出来：${error instanceof Error ? error.message : String(error)}`);
  }
  await deps.sql.begin(async (tx) => {
    const [r] = await tx<{ status: string; issuedVia: string | null }[]>`SELECT status, issued_via FROM invoice_requests WHERE id = ${id} FOR UPDATE`;
    if (!r || r.status !== 'requested' || r.issuedVia !== 'sending') {
      // 中间被人改回了「申请中」或手工登记了：服务商这张记进审计，由财务去服务商那边作废
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'invoice_request',
        targetType: 'invoice_request',
        targetId: id,
        detail: { op: 'provider_late', invoiceNo: result.invoiceNo, providerRef: result.providerRef },
        ip,
      });
      return;
    }
    const file = await storePdf(tx, 'sales_invoice', result.pdf.toString('base64'), actor);
    await tx`
      UPDATE invoice_requests
      SET status = 'issued', invoice_no = ${result.invoiceNo}, invoice_date = ${result.invoiceDate}, file_id = ${file.id}, issued_via = ${adapter.provider},
          provider_ref = ${result.providerRef}, handled_by = ${actor.id}, handled_at = now(), version = version + 1
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'invoice_request',
      targetType: 'invoice_request',
      targetId: id,
      detail: { op: 'issue', requestNo: req.requestNo, invoiceNo: result.invoiceNo, via: adapter.provider },
      ip,
    });
  });
  const after = await getSalesInvoice(deps.sql, id);
  if (after.status !== 'issued') throw conflict('INVOICE_REQUEST_CHANGED', '服务商开出来了，但这张申请中间被人改过，请刷新后核对（服务商那边的发票号码记在操作审计里）');
  return after;
}

/** 交给服务商以后结果没回来（进程中断）：财务确认服务商没开出，改回「申请中」 */
export async function resetSending(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<SalesInvoice> {
  const input = parse(z.object({ version: Version, reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    const r = await lockRequest(tx, id, input.version);
    if (r.status !== 'requested' || r.issuedVia !== 'sending') throw conflict('INVOICE_REQUEST_DONE', '这张不在「发送中」');
    await tx`UPDATE invoice_requests SET issued_via = NULL, version = version + 1 WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'invoice_request',
      targetType: 'invoice_request',
      targetId: id,
      detail: { op: 'reset_sending', requestNo: r.requestNo, reason: input.reason },
      ip,
    });
  });
  return getSalesInvoice(deps.sql, id);
}

export async function rejectRequest(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<SalesInvoice> {
  const input = parse(z.object({ version: Version, reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    const r = await lockRequest(tx, id, input.version);
    if (r.status !== 'requested') throw conflict('INVOICE_REQUEST_DONE', '这张申请已经处理过了');
    if (r.issuedVia === 'sending') throw conflict('INVOICE_SENDING', '这张已经交给开票服务商、结果还没回来，不能驳回');
    await tx`UPDATE invoice_requests SET status = 'rejected', reject_reason = ${input.reason}, handled_by = ${actor.id}, handled_at = now(), version = version + 1 WHERE id = ${id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'invoice_request', targetType: 'invoice_request', targetId: id, detail: { op: 'reject', requestNo: r.requestNo, reason: input.reason }, ip });
  });
  return getSalesInvoice(deps.sql, id);
}

/** 作废：申请中的（不开了）、已开的（红冲：服务商开的要在服务商那边同时作废）；之后可以重新申请 */
export async function voidRequest(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<SalesInvoice> {
  const input = parse(z.object({ version: Version, reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    const r = await lockRequest(tx, id, input.version);
    if (r.status !== 'requested' && r.status !== 'issued') throw conflict('INVOICE_REQUEST_DONE', '这张已经驳回或作废了');
    if (r.issuedVia === 'sending') throw conflict('INVOICE_SENDING', '这张已经交给开票服务商、结果还没回来，不能作废');
    await tx`UPDATE invoice_requests SET status = 'voided', void_reason = ${input.reason}, voided_by = ${actor.id}, voided_at = now(), version = version + 1 WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'invoice_request',
      targetType: 'invoice_request',
      targetId: id,
      detail: { op: 'void', requestNo: r.requestNo, wasIssued: r.status === 'issued', reason: input.reason },
      ip,
    });
  });
  return getSalesInvoice(deps.sql, id);
}

// ───────────────────────── 接口 ─────────────────────────

const SourceQuery = z.object({ type: z.enum(INVOICE_SOURCE_TYPES, '来源不对'), id: z.coerce.number().int().positive('来源编号不对') });

export function registerSalesInvoiceRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const ISSUE = guard('invoice.issue');
  const providerMode = () => modeOf(deps.config.integrations, 'einvoice');
  // 申请：前台、充值、回款的岗位（不在 ERP 前缀下，ERP 关着时前台照样能申请——申请要等开票模块开着才有人处理，页面上提示）
  app.get('/api/invoice-requests/source', { preHandler: sessionOnly }, async (req) => {
    const q = parse(SourceQuery, req.query ?? {});
    assertSourcePerm(req, q.type);
    return readSnapshot(sql, (tx) => sourceInfo(tx, q.type, q.id));
  });
  app.post('/api/invoice-requests', { preHandler: sessionOnly }, async (req, reply) => {
    const type = (req.body as { sourceType?: string } | null)?.sourceType;
    if (!(INVOICE_SOURCE_TYPES as readonly string[]).includes(type ?? '')) throw badRequest('来源不对');
    assertSourcePerm(req, type as InvoiceSourceType);
    const r = await requestInvoice(deps, req.body, ctxOf(req));
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  // 处理：ERP「财务 → 开票」
  app.get('/api/erp/sales-invoices', { preHandler: ISSUE }, async (req) => readSnapshot(sql, (tx) => listSalesInvoices(tx, req.query ?? {}, providerMode())));
  app.get('/api/erp/sales-invoices/:id', { preHandler: ISSUE }, async (req) => getSalesInvoice(sql, parse(idParam, req.params).id));
  app.get('/api/erp/sales-invoices/:id/file', { preHandler: ISSUE }, async (req, reply) => {
    const inv = await getSalesInvoice(sql, parse(idParam, req.params).id);
    const [row] = await sql<{ fileId: number | null }[]>`SELECT file_id FROM invoice_requests WHERE id = ${inv.id}`;
    const file = row?.fileId ? await readFile(sql, Number(row.fileId), 'sales_invoice') : null;
    if (!file) throw notFound('这张没有发票文件');
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`发票-${inv.invoiceNo ?? inv.requestNo}.pdf`)}`);
    return reply.send(file.data);
  });
  app.post('/api/erp/sales-invoices/:id/issue', { preHandler: ISSUE, bodyLimit: 14_500_000 }, async (req) => issueManually(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.post('/api/erp/sales-invoices/:id/provider', { preHandler: ISSUE }, async (req) => issueViaProvider(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.post('/api/erp/sales-invoices/:id/reset-sending', { preHandler: ISSUE }, async (req) => resetSending(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.post('/api/erp/sales-invoices/:id/reject', { preHandler: ISSUE }, async (req) => rejectRequest(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.post('/api/erp/sales-invoices/:id/void', { preHandler: ISSUE }, async (req) => voidRequest(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
}
