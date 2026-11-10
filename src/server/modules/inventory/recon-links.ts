// 供应商在线对账确认（8.0.7 供应链收尾 2.6，docs/ERP_V807.md，迁移 100）。
//   · 对账登记（月结或按批次）以后，对账付款或采购经办可以生成「对账确认链接」（有效 N 天，V10，默认 14 天）发给供应商；
//     链接原文只在生成时给一次，库里只存摘要；重发时上一条没回的自动作废；能手动作废。
//   · 供应商打开（不用登录）看生成链接时的对账单快照，点「确认无误」或「有异议」（写原因、留姓名），只能回一次。
//   · 同一来源地址 10 分钟里试错（链接不对、过期、作废）最多 30 次（与员工食堂的登录一样，进程内计数）。
//   · 应付货款模块关着、对账登记撤销了的，链接打不开。
// 锁：生成先锁对账登记一行（FOR NO KEY UPDATE，同一条登记的生成串行），再改、写链接；作废、回复只锁链接一行。

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ReconLinkState, ReconPublicView, ReconSnapshot } from '@shared/cycles';
import type { Db } from '../../db';
import { guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { setTxTimeouts } from '../../lib/tx';
import { AttemptLimiter } from '../canteen/portal-auth';
import { enabledErpModules } from '../erp';
import { loadSettings } from '../settings';
import { statement } from './payables';

const KIND_LABELS: Record<string, string> = { opening: '期初未付', receipt: '收货', supplier_return: '退货扣款', payment: '付款', refund: '供应商退款' };

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** 2026-10-01 → 2026-10-31 */
const monthEnd = (monthStart: string) => {
  const [y, m] = monthStart.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export async function latestLink(db: Db, reconId: number): Promise<ReconLinkState | null> {
  const [l] = await db<(Omit<ReconLinkState, 'expired'> & { expired: boolean })[]>`
    SELECT l.id, l.created_at, s.display_name AS created_by_name, l.expires_at, l.expires_at < now() AS expired, l.voided_at,
           l.reply, l.reply_name, l.reply_note, l.replied_at
    FROM recon_links l JOIN staff s ON s.id = l.created_by
    WHERE l.reconciliation_id = ${reconId} ORDER BY l.id DESC LIMIT 1`;
  return l ? { ...l, id: Number(l.id) } : null;
}

/** 生成链接时的对账单快照：月结是那个月的往来与登记时的数字，按批次是登记的收货单 */
async function snapshotOf(db: Db, reconId: number): Promise<ReconSnapshot> {
  const [r] = await db<{
    supplierId: number;
    supplierName: string;
    kind: 'month' | 'batch';
    periodMonth: string | null;
    beginCents: number | null;
    openingCents: number | null;
    receivedCents: number | null;
    returnCreditCents: number | null;
    paidCents: number | null;
    refundedCents: number | null;
    endCents: number | null;
    totalCents: number;
  }[]>`
    SELECT r.supplier_id, s.name AS supplier_name, r.kind, r.period_month::text AS period_month, r.begin_cents, r.opening_cents,
           r.received_cents, r.return_credit_cents, r.paid_cents, r.refunded_cents, r.end_cents, r.total_cents
    FROM supplier_reconciliations r JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = ${reconId}`;
  if (!r) throw notFound('对账登记不存在');
  const { storeName } = await loadSettings(db);
  if (r.kind === 'month') {
    const from = r.periodMonth!;
    const to = monthEnd(from);
    const st = await statement(db, Number(r.supplierId), from, to);
    return {
      storeName,
      supplierName: r.supplierName,
      kind: 'month',
      month: from.slice(0, 7),
      from,
      to,
      totals: {
        beginCents: Number(r.beginCents),
        openingCents: Number(r.openingCents),
        receivedCents: Number(r.receivedCents),
        returnCreditCents: Number(r.returnCreditCents),
        paidCents: Number(r.paidCents),
        refundedCents: Number(r.refundedCents),
        endCents: Number(r.endCents),
      },
      totalCents: Number(r.totalCents),
      rows: st.rows.map((x) => ({ date: x.date, docNo: x.docNo, kind: (x.isVoid ? '冲销 · ' : '') + (KIND_LABELS[x.kind] ?? x.kind), amountCents: x.amountDeltaCents, note: x.note })),
    };
  }
  const docs = await db<{ docNo: string; docDate: string; amountCents: number }[]>`
    SELECT d.doc_no, d.doc_date::text AS doc_date, rd.amount_cents
    FROM supplier_reconciliation_docs rd JOIN inv_docs d ON d.id = rd.doc_id
    WHERE rd.reconciliation_id = ${reconId} ORDER BY d.doc_date, d.id`;
  return {
    storeName,
    supplierName: r.supplierName,
    kind: 'batch',
    month: null,
    from: docs[0]?.docDate ?? null,
    to: docs[docs.length - 1]?.docDate ?? null,
    totals: null,
    totalCents: Number(r.totalCents),
    rows: docs.map((d) => ({ date: d.docDate, docNo: d.docNo, kind: '收货', amountCents: Number(d.amountCents), note: '' })),
  };
}

/** 生成对账确认链接：返回链接原文（只给这一次）；上一条没回的自动作废 */
export async function createLink(deps: Deps, reconId: number, actor: Actor, ip?: string): Promise<{ token: string; link: ReconLinkState }> {
  const token = randomBytes(24).toString('base64url');
  const { reconLinkDays } = await loadSettings(deps.sql);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [r] = await tx<{ voidedAt: string | null; supplierId: number }[]>`
      SELECT voided_at, supplier_id FROM supplier_reconciliations WHERE id = ${reconId} FOR NO KEY UPDATE`;
    if (!r) throw notFound('对账登记不存在');
    if (r.voidedAt) throw conflict('INVALID_STATE', '这条对账登记已撤销，不能再发确认链接');
    const snapshot = await snapshotOf(tx, reconId);
    await tx`UPDATE recon_links SET voided_by = ${actor.id}, voided_at = now() WHERE reconciliation_id = ${reconId} AND voided_at IS NULL AND replied_at IS NULL`;
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO recon_links (reconciliation_id, token_hash, snapshot, expires_at, created_by)
      VALUES (${reconId}, ${hashToken(token)}, ${tx.json(snapshot as never)}, now() + make_interval(days => ${reconLinkDays}), ${actor.id})
      RETURNING id`;
    await writeAudit(tx, { staffId: actor.id, action: 'recon_link', targetType: 'supplier_reconciliation', targetId: reconId, detail: { op: 'create', linkId: row!.id, days: reconLinkDays }, ip });
  });
  return { token, link: (await latestLink(deps.sql, reconId))! };
}

export async function voidLink(deps: Deps, linkId: number, actor: Actor, ip?: string): Promise<ReconLinkState | null> {
  let reconId = 0;
  await deps.sql.begin(async (tx) => {
    const [l] = await tx<{ reconciliationId: number; voidedAt: string | null; repliedAt: string | null }[]>`
      SELECT reconciliation_id, voided_at, replied_at FROM recon_links WHERE id = ${linkId} FOR UPDATE`;
    if (!l) throw notFound('链接不存在');
    reconId = Number(l.reconciliationId);
    if (l.voidedAt) return;
    if (l.repliedAt) throw conflict('INVALID_STATE', '供应商已经回复过，链接不用作废');
    await tx`UPDATE recon_links SET voided_by = ${actor.id}, voided_at = now() WHERE id = ${linkId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'recon_link', targetType: 'supplier_reconciliation', targetId: reconId, detail: { op: 'void', linkId }, ip });
  });
  return latestLink(deps.sql, reconId);
}

interface LinkRow {
  id: number;
  snapshot: ReconSnapshot;
  expiresAt: string;
  expired: boolean;
  voidedAt: string | null;
  reconVoided: boolean;
  reply: ReconPublicView['reply'];
  replyName: string | null;
  replyNote: string;
  repliedAt: string | null;
}

const TokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, '链接不对') });
const ReplyInput = z
  .object({
    answer: z.enum(['confirmed', 'disputed'], '请选择确认无误还是有异议'),
    name: z.string('请留下您的姓名').trim().min(1, '请留下您的姓名').max(20, '姓名最多 20 个字'),
    note: z.string().trim().max(300, '说明最多 300 个字').default(''),
  })
  .refine((v) => v.answer === 'confirmed' || v.note.length >= 2, { message: '有异议请写明哪里不对（至少 2 个字）', path: ['note'] });

async function findByToken(db: Db, token: string, lock: boolean): Promise<LinkRow | null> {
  const [l] = await db<LinkRow[]>`
    SELECT l.id, l.snapshot, l.expires_at, l.expires_at < now() AS expired, l.voided_at, r.voided_at IS NOT NULL AS recon_voided,
           l.reply, l.reply_name, l.reply_note, l.replied_at
    FROM recon_links l JOIN supplier_reconciliations r ON r.id = l.reconciliation_id
    WHERE l.token_hash = ${hashToken(token)}
    ${lock ? db`FOR UPDATE OF l` : db``}`;
  return l ?? null;
}

const viewOf = (l: LinkRow): ReconPublicView => ({
  snapshot: l.snapshot,
  expiresAt: l.expiresAt,
  reply: l.reply,
  replyName: l.replyName,
  replyNote: l.replyNote,
  repliedAt: l.repliedAt,
});

export function registerReconLinkRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const limiter = new AttemptLimiter();
  const managers = guardAny('payable.manage', 'purchase.manage');
  app.post('/api/payables/reconciliations/:id/links', { preHandler: managers }, async (req, reply) => {
    const r = await createLink(deps, parse(idParam, req.params).id, req.actor, req.ip);
    reply.code(201);
    return r;
  });
  app.post('/api/payables/recon-links/:id/void', { preHandler: managers }, async (req) => voidLink(deps, parse(idParam, req.params).id, req.actor, req.ip));

  // ── 供应商打开链接（不用登录）──
  const open = async (token: string, ip: string, lock: boolean, db: Db = sql) => {
    limiter.check(ip);
    if (!(await enabledErpModules(db)).has('payables')) throw notFound('链接不存在或已失效');
    const l = await findByToken(db, token, lock);
    if (!l || l.voidedAt || l.reconVoided || (l.expired && !l.repliedAt)) {
      limiter.fail(ip);
      throw notFound(l?.expired ? '链接已过期，请联系门店重新发一份' : '链接不存在或已失效，请联系门店重新发一份');
    }
    return l;
  };
  app.get('/api/public/recon/:token', async (req, reply) => {
    const { token } = parse(TokenParam, req.params);
    reply.header('cache-control', 'no-store');
    return viewOf(await open(token, req.ip, false));
  });
  app.post('/api/public/recon/:token/reply', async (req, reply) => {
    const { token } = parse(TokenParam, req.params);
    const input = parse(ReplyInput, req.body);
    reply.header('cache-control', 'no-store');
    return sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const l = await open(token, req.ip, true, tx);
      if (l.repliedAt) {
        // 同一个回复重复提交（没收到结果、又点了一次）：照样返回；不同的拒绝
        if (l.reply === input.answer && l.replyName === input.name) return viewOf(l);
        throw conflict('ALREADY_REPLIED', '这份对账单已经回复过了，有变动请联系门店');
      }
      if (l.expired) throw unprocessable('LINK_EXPIRED', '链接已过期，请联系门店重新发一份');
      await tx`
        UPDATE recon_links SET reply = ${input.answer}, reply_name = ${input.name}, reply_note = ${input.note}, replied_at = now(), reply_ip = ${req.ip}
        WHERE id = ${l.id}`;
      await writeAudit(tx, { staffId: null, action: 'recon_reply', targetType: 'recon_link', targetId: l.id, detail: { answer: input.answer, name: input.name, note: input.note }, ip: req.ip });
      return viewOf((await findByToken(tx, token, false))!);
    });
  });
}
