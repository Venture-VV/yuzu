// 付款流的接口（v0.7.32，docs/PAYMENTS.md）：
//   · /api/erp/payments 跟 ERP「付款」模块的开关走：付款申请、按申请登记付款、合同付款、发票、三单、质保金台账、本周应付、待办；
//   · /api/erp/contracts/... 跟「合同」模块走：合同的付款计划、验收登记、质量问题登记。
// 查看要「查看货款与对账」或「发起付款申请」；发起、改、撤回要「发起付款申请」；登记付款、发票、放行、结束要「登记期初未付、付款……」；
// 审批与审批中心一样要能用审批中心；冲销合同付款要「冲销付款……」。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PAYMENT_STAGE_LABELS } from '@shared/contracts';
import { formatAmount } from '@shared/money';
import { WEEKLY_ITEM_LABELS } from '@shared/payments';
import { guardAny } from '../../auth/guard';
import { readSnapshot } from '../../db';
import { writeAudit } from '../../lib/audit';
import { ctxOf, type Deps } from '../../lib/context';
import { csvReply, toCsv } from '../../lib/csv';
import { todayIn } from '../../lib/dates';
import { idParam, parse } from '../../lib/validate';
import { openItems } from '../inventory/payables';
import { createAcceptance, createQualityIssue, resolveQualityIssue, voidAcceptance, voidQualityIssue } from './acceptance';
import { paymentTodo, warrantyLedger, weeklyPayables, type WarrantyFilter } from './ledger';
import { createInvoice, getInvoice, listInvoices, poThreeWay, releasePo, threeWayList, voidInvoice } from './match';
import { contractPlan } from './plan';
import { loadPaymentRules, savePaymentRules } from './rules';
import {
  actOnPaymentRequest,
  createPaymentRequest,
  endPaymentRequest,
  getPaymentRequest,
  listPaymentRequests,
  paymentRequestMeta,
  payFromRequest,
  payoutFromRequest,
  resubmitPaymentRequest,
  voidPaymentRequest,
  voidPayout,
  withdrawPaymentRequest,
  type RequestListFilter,
} from './requests';

const READ = guardAny('payable.read', 'payment.request');
const REQUEST = guardAny('payment.request');
const PAY = guardAny('payable.manage');
const ACT = guardAny('approval.act', 'inventory.approve', 'expense.approve');
const CONTRACT_READ = guardAny('contract.read');
const CONTRACT_MANAGE = guardAny('contract.manage');

const ListQuery = z.object({
  filter: z.enum(['all', 'reviewing', 'returned', 'approved', 'done', 'mine']).default('all'),
  supplierId: z.coerce.number().int().positive().optional(),
  contractId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(32).optional(),
});
const InvoiceQuery = z.object({
  supplierId: z.coerce.number().int().positive().optional(),
  poId: z.coerce.number().int().positive().optional(),
  status: z.enum(['valid', 'voided']).optional(),
  q: z.string().trim().max(32).optional(),
});
const yuanText = (cents: number) => (cents < 0 ? '-' : '') + formatAmount(Math.abs(cents)).replace(/,/g, '');

export function registerPaymentRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const today = () => todayIn(deps.config.timezone);
  const docId = (req: FastifyRequest) => parse(idParam, req.params).id;

  // ───────── 付款申请 ─────────
  app.get('/api/erp/payments/meta', { preHandler: READ }, async () => readSnapshot(sql, (tx) => paymentRequestMeta(tx, today())));
  app.get('/api/erp/payments/requests', { preHandler: READ }, async (req) => {
    const q = parse(ListQuery, req.query);
    return readSnapshot(sql, (tx) => listPaymentRequests(tx, req.actor, { ...q, filter: q.filter as RequestListFilter }));
  });
  app.get('/api/erp/payments/requests/:id', { preHandler: READ }, async (req) => readSnapshot(sql, (tx) => getPaymentRequest(tx, docId(req), today())));
  app.post('/api/erp/payments/requests', { preHandler: REQUEST }, async (req, reply) => {
    const r = await createPaymentRequest(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return { replayed: r.replayed, request: await getPaymentRequest(sql, r.id, today()) };
  });
  app.post('/api/erp/payments/requests/:id/resubmit', { preHandler: REQUEST }, async (req) => {
    await resubmitPaymentRequest(deps, docId(req), req.body, req.actor, req.ip);
    return getPaymentRequest(sql, docId(req), today());
  });
  app.post('/api/erp/payments/requests/:id/withdraw', { preHandler: REQUEST }, async (req) => {
    await withdrawPaymentRequest(deps, docId(req), req.body, req.actor, req.ip);
    return getPaymentRequest(sql, docId(req), today());
  });
  app.post('/api/erp/payments/requests/:id/void', { preHandler: guardAny('payment.request', 'payable.manage') }, async (req) => {
    await voidPaymentRequest(deps, docId(req), req.body, req.actor, req.ip);
    return getPaymentRequest(sql, docId(req), today());
  });
  app.post('/api/erp/payments/requests/:id/end', { preHandler: PAY }, async (req) => {
    await endPaymentRequest(deps, docId(req), req.body, req.actor, req.ip);
    return getPaymentRequest(sql, docId(req), today());
  });
  for (const action of ['approve', 'return'] as const) {
    app.post(`/api/erp/payments/requests/:id/${action}`, { preHandler: ACT }, async (req) => {
      await actOnPaymentRequest(deps, docId(req), action, req.body, req.actor);
      return getPaymentRequest(sql, docId(req), today());
    });
  }
  // 按申请登记付款（供应商往来）、合同付款（服务、租赁、其他合同）
  app.post('/api/erp/payments/requests/:id/pay', { preHandler: PAY }, async (req, reply) => {
    const r = await payFromRequest(deps, docId(req), req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    // 与付款登记的返回一样带 payment（「结果待确认」重新提交时按它找到那一笔）
    return { replayed: r.replayed, payment: { id: r.paymentId }, request: await getPaymentRequest(sql, docId(req), today()) };
  });
  app.post('/api/erp/payments/requests/:id/payout', { preHandler: PAY }, async (req, reply) => {
    const r = await payoutFromRequest(deps, docId(req), req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return { replayed: r.replayed, payoutId: r.payoutId, request: await getPaymentRequest(sql, docId(req), today()) };
  });
  app.post('/api/erp/payments/payouts/:id/void', { preHandler: guardAny('finance.void') }, async (req) => {
    await voidPayout(deps, docId(req), req.body, req.actor, req.ip);
    return { ok: true };
  });
  // 新建申请页：合同的付款计划、供应商没结清的货款（标出挂合同的、别的申请占着的）
  app.get('/api/erp/payments/contracts/:id/plan', { preHandler: READ }, async (req) => readSnapshot(sql, (tx) => contractPlan(tx, docId(req), today())));
  app.get('/api/erp/payments/suppliers/:id/open-items', { preHandler: READ }, async (req) =>
    readSnapshot(sql, async (tx) => {
      const supplierId = docId(req);
      const items = await openItems(tx, supplierId);
      const receiptIds = items.filter((i) => i.kind === 'receipt').map((i) => i.id);
      const contracts = receiptIds.length
        ? await tx<{ id: number; contractNo: string; poId: number | null }[]>`
            SELECT d.id, c.contract_no, d.purchase_order_id AS po_id FROM inv_docs d LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
            LEFT JOIN contracts c ON c.id = po.contract_id WHERE d.id IN ${tx(receiptIds)}`
        : [];
      const reserved = await tx<{ receiptDocId: number | null; openingPayableId: number | null; cents: string }[]>`
        SELECT t.receipt_doc_id, t.opening_payable_id,
               sum(greatest(0, t.amount_cents - coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                     WHERE p.payment_request_id = t.request_id AND p.status = 'confirmed'
                       AND (pa.receipt_doc_id = t.receipt_doc_id OR pa.opening_payable_id = t.opening_payable_id)), 0)))::text AS cents
        FROM payment_request_targets t JOIN payment_requests r ON r.id = t.request_id
        WHERE r.supplier_id = ${supplierId} AND r.status IN ('submitted', 'returned', 'approved')
        GROUP BY t.receipt_doc_id, t.opening_payable_id`;
      return items.map((i) => {
        const c = i.kind === 'receipt' ? contracts.find((x) => Number(x.id) === i.id) : undefined;
        const held = reserved.find((x) => (i.kind === 'receipt' ? Number(x.receiptDocId) === i.id : Number(x.openingPayableId) === i.id));
        return {
          ...i,
          contractNo: c?.contractNo ?? null,
          hasPo: i.kind === 'opening' || (c?.poId ?? null) !== null,
          requestedCents: held ? Number(held.cents) : 0,
        };
      });
    }),
  );

  // ───────── 发票与三单 ─────────
  app.get('/api/erp/payments/invoices', { preHandler: READ }, async (req) => readSnapshot(sql, (tx) => listInvoices(tx, parse(InvoiceQuery, req.query))));
  app.get('/api/erp/payments/invoices/:id', { preHandler: READ }, async (req) => readSnapshot(sql, (tx) => getInvoice(tx, docId(req))));
  app.post('/api/erp/payments/invoices', { preHandler: PAY }, async (req, reply) => {
    const r = await createInvoice(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return { replayed: r.replayed, invoice: await getInvoice(sql, r.id) };
  });
  app.post('/api/erp/payments/invoices/:id/void', { preHandler: PAY }, async (req) => {
    await voidInvoice(deps, docId(req), req.body, req.actor, req.ip);
    return getInvoice(sql, docId(req));
  });
  app.get('/api/erp/payments/three-way', { preHandler: READ }, async (req) => {
    const q = parse(z.object({ pending: z.enum(['0', '1']).default('1'), supplierId: z.coerce.number().int().positive().optional() }), req.query);
    return readSnapshot(sql, (tx) => threeWayList(tx, { pendingOnly: q.pending === '1', supplierId: q.supplierId }));
  });
  app.get('/api/erp/payments/three-way/po/:id', { preHandler: guardAny('payable.read', 'payment.request', 'purchase.manage') }, async (req) =>
    readSnapshot(sql, async (tx) => (await poThreeWay(tx, [docId(req)]))[0] ?? null),
  );
  app.post('/api/erp/payments/three-way/po/:id/release', { preHandler: PAY }, async (req) => {
    const r = await releasePo(deps, docId(req), req.body, req.actor, req.ip);
    return { replayed: r.replayed, row: (await poThreeWay(sql, [docId(req)]))[0] ?? null };
  });
  // 登记发票选采购单：这家供应商已下单的采购单与三单金额
  app.get('/api/erp/payments/suppliers/:id/pos', { preHandler: READ }, async (req) =>
    readSnapshot(sql, async (tx) => {
      const rows = await tx<{ id: number }[]>`
        SELECT id FROM purchase_orders WHERE supplier_id = ${docId(req)} AND status IN ('submitted', 'approved', 'closed') ORDER BY id DESC LIMIT 100`;
      return poThreeWay(tx, rows.map((r) => Number(r.id)));
    }),
  );

  // ───────── 质保金、本周应付、待办 ─────────
  app.get('/api/erp/payments/warranty', { preHandler: READ }, async (req) => {
    const { filter } = parse(z.object({ filter: z.enum(['all', 'due', 'unsettled']).default('all') }), req.query);
    return readSnapshot(sql, (tx) => warrantyLedger(tx, today(), filter as WarrantyFilter));
  });
  app.get('/api/erp/payments/weekly', { preHandler: READ }, async () => readSnapshot(sql, (tx) => weeklyPayables(tx, today())));
  app.get('/api/erp/payments/weekly/export', { preHandler: guardAny('payable.read') }, async (req, reply) => {
    const w = await readSnapshot(sql, (tx) => weeklyPayables(tx, today()));
    const rows: (string | number)[][] = [
      [`本周应付（${w.from} 起 ${w.weeks.length} 周，导出于 ${w.today}；可付未申请的算在本周，期望付款日已过的算在本周）`],
      ['周', '日期', '类型', '收款方', '申请号', '合同', '付款节点', '金额（元）', '说明'],
    ];
    w.weeks.forEach((wk, i) => {
      for (const it of wk.items) {
        rows.push([`第 ${i + 1} 周（${wk.start} 至 ${wk.end}）`, it.date, WEEKLY_ITEM_LABELS[it.kind], it.payee, it.requestNo ?? '', it.contractNo ?? '', it.stage ? PAYMENT_STAGE_LABELS[it.stage] : '', yuanText(it.amountCents), it.note]);
      }
      rows.push([`第 ${i + 1} 周合计`, '', '', '', '', '', '', yuanText(wk.totalCents), '']);
    });
    rows.push([`${w.weeks.length} 周合计`, '', '', '', '', '', '', yuanText(w.totalCents), '']);
    rows.push([`${w.weeks.length} 周以后的已批待付`, '', '', '', '', '', '', yuanText(w.laterCents), '']);
    rows.push(['没挂合同、没提申请的应付余额（参考）', '', '', '', '', '', '', yuanText(w.otherApCents), '']);
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'weekly_payables', targetId: w.from, detail: { from: w.from }, ip: req.ip });
    return csvReply(reply, `本周应付_${w.from}.csv`, toCsv(rows));
  });
  app.get('/api/erp/payments/todo', { preHandler: READ }, async () => readSnapshot(sql, (tx) => paymentTodo(tx, today())));

  // 付款规则（8.0.6）：能看付款的人都能看；改要「修改经营规则设置」（settings.manage，与费用规则、库存设置一样），只改提交的字段
  app.get('/api/erp/payments/rules', { preHandler: READ }, async () => loadPaymentRules(sql));
  app.put('/api/erp/payments/rules', { preHandler: guardAny('settings.manage') }, async (req) => savePaymentRules(sql, req.body, ctxOf(req)));

  // ───────── 合同的付款计划、验收、质量问题（跟合同模块走） ─────────
  app.get('/api/erp/contracts/:id/payment-plan', { preHandler: CONTRACT_READ }, async (req) => readSnapshot(sql, (tx) => contractPlan(tx, docId(req), today())));
  app.post('/api/erp/contracts/:id/acceptances', { preHandler: CONTRACT_MANAGE }, async (req, reply) => {
    const r = await createAcceptance(deps, docId(req), req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return { replayed: r.replayed, id: r.id, plan: await contractPlan(sql, docId(req), today()) };
  });
  app.post('/api/erp/contracts/acceptances/:id/void', { preHandler: CONTRACT_MANAGE }, async (req) => {
    await voidAcceptance(deps, docId(req), req.body, req.actor, req.ip);
    return { ok: true };
  });
  app.post('/api/erp/contracts/:id/quality-issues', { preHandler: CONTRACT_MANAGE }, async (req, reply) => {
    const r = await createQualityIssue(deps, docId(req), req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return { replayed: r.replayed, id: r.id, plan: await contractPlan(sql, docId(req), today()) };
  });
  app.post('/api/erp/contracts/quality-issues/:id/resolve', { preHandler: CONTRACT_MANAGE }, async (req) => {
    await resolveQualityIssue(deps, docId(req), req.body, req.actor, req.ip);
    return { ok: true };
  });
  app.post('/api/erp/contracts/quality-issues/:id/void', { preHandler: CONTRACT_MANAGE }, async (req) => {
    await voidQualityIssue(deps, docId(req), req.body, req.actor, req.ip);
    return { ok: true };
  });
}
