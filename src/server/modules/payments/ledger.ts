// 质保金台账、本周应付、付款待办与自检（v0.7.32，docs/PAYMENTS.md 第 5、6 节；P9、P11、P12 店主 2026-11-10 照默认）。都只读，不加锁。
// 质保金提前几天提醒（P9）、本周应付看几周（P11）按付款规则（8.0.6，ERP「付款 → 付款规则」里改）。

import { PAYMENT_STAGE_LABELS } from '@shared/contracts';
import {
  type PaymentTodo,
  type WarrantyRow,
  type WarrantyRowStatus,
  type WeeklyItem,
  type WeeklyPayables,
} from '@shared/payments';
import type { Db } from '../../db';
import { openItems } from '../inventory/payables';
import { invoiceChecks } from './match';
import { ledgerChecks } from '../invoices';
import { PAYABLE_CONTRACT_STATUSES, contractPlan, requestPaidSql } from './plan';
import { loadPaymentRules } from './rules';

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** 这一天所在那一周的周一 */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = 周日
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

async function payableContracts(db: Db): Promise<number[]> {
  const rows = await db<{ id: number }[]>`SELECT id FROM contracts WHERE status IN ${db(PAYABLE_CONTRACT_STATUSES as string[])} ORDER BY id`;
  return rows.map((r) => Number(r.id));
}

export type WarrantyFilter = 'all' | 'due' | 'unsettled';

/** 质保金台账：一份有质保段（比例 > 0）的合同一条（P9、P12） */
export async function warrantyLedger(db: Db, today: string, filter: WarrantyFilter = 'all'): Promise<WarrantyRow[]> {
  const { warrantyRemindDays } = await loadPaymentRules(db);
  const out: WarrantyRow[] = [];
  for (const contractId of await payableContracts(db)) {
    const plan = await contractPlan(db, contractId, today);
    const st = plan.stages.find((s) => s.stage === 'warranty')!;
    if (st.plannedCents <= 0) continue;
    const w = plan.warranty;
    let rowStatus: WarrantyRowStatus;
    if (st.done) rowStatus = 'paid';
    else if (!w.startDate) rowStatus = 'not_started';
    else if (w.openIssues > 0) rowStatus = 'held';
    else if (w.daysLeft !== null && w.daysLeft <= 0) rowStatus = 'payable';
    else if (w.daysLeft !== null && w.daysLeft <= warrantyRemindDays) rowStatus = 'due_soon';
    else rowStatus = 'running';
    const [cp] = await db<{ counterparty: string }[]>`SELECT counterparty FROM contracts WHERE id = ${contractId}`;
    out.push({
      contractId,
      contractNo: plan.contractNo,
      title: plan.title,
      counterparty: cp!.counterparty,
      status: plan.status,
      plannedCents: st.plannedCents,
      requestedCents: st.requestedCents,
      paidCents: st.paidCents,
      basis: w.basis,
      months: w.months,
      startDate: w.startDate,
      dueDate: w.dueDate,
      daysLeft: w.daysLeft,
      openIssues: w.openIssues,
      rowStatus,
      settled: plan.settled,
    });
  }
  const rows = filter === 'due' ? out.filter((r) => isWarrantyDue(r, warrantyRemindDays)) : filter === 'unsettled' ? out.filter((r) => !r.settled) : out;
  // 到期早的在前，没起算的、付清的在后
  const rank = (r: WarrantyRow) => (r.rowStatus === 'paid' ? 3 : r.dueDate === null ? 2 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.contractId - b.contractId);
}

/** 进待办的质保金（P9）：到期前 N 天以内（含已到期没付的，N 按付款规则，默认 30），还没付清 */
export const isWarrantyDue = (r: WarrantyRow, remindDays: number) => r.rowStatus !== 'paid' && r.daysLeft !== null && r.daysLeft <= remindDays;

/**
 * 本周应付（P11）：从本周一起几周（按付款规则，默认四周），每周列出已批待付的申请（按期望付款日）、可付还没申请的合同段（算在本周）、
 * 那一周到期的质保金；期望付款日早于本周一的算在本周，晚于最后一周的另计。可用资金在页面上填、不存。
 */
export async function weeklyPayables(db: Db, today: string): Promise<WeeklyPayables> {
  const from = mondayOf(today);
  const { weeklyWeeks } = await loadPaymentRules(db);
  const weeks = Array.from({ length: weeklyWeeks }, (_, i) => ({ start: addDays(from, i * 7), end: addDays(from, i * 7 + 6), items: [] as WeeklyItem[], totalCents: 0 }));
  const lastEnd = weeks[weeks.length - 1]!.end;
  const weekOf = (date: string) => (date < from ? 0 : weeks.findIndex((w) => date >= w.start && date <= w.end));
  let laterCents = 0;
  const put = (item: WeeklyItem) => {
    const i = weekOf(item.date);
    if (i < 0) {
      laterCents += item.amountCents;
      return;
    }
    weeks[i]!.items.push(item);
    weeks[i]!.totalCents += item.amountCents;
  };

  // 已批待付
  const approved = await db<{ id: number; requestNo: string; payee: string; contractId: number | null; contractNo: string | null; stage: string | null; expectedDate: string; amountCents: string; paidCents: string }[]>`
    SELECT r.id, r.request_no, r.payee, r.contract_id, c.contract_no, r.stage, r.expected_date, r.amount_cents::text AS amount_cents, ${requestPaidSql(db)}::text AS paid_cents
    FROM payment_requests r LEFT JOIN contracts c ON c.id = r.contract_id
    WHERE r.status = 'approved' ORDER BY r.expected_date, r.id`;
  for (const r of approved) {
    const left = Number(r.amountCents) - Number(r.paidCents);
    if (left <= 0) continue;
    put({
      kind: 'approved',
      date: r.expectedDate,
      amountCents: left,
      payee: r.payee,
      requestId: Number(r.id),
      requestNo: r.requestNo,
      contractId: r.contractId === null ? null : Number(r.contractId),
      contractNo: r.contractNo,
      stage: (r.stage as WeeklyItem['stage']) ?? null,
      note: r.expectedDate < from ? `期望付款日 ${r.expectedDate} 已过` : '',
    });
  }

  // 可付未申请的合同段、到期的质保金
  for (const contractId of await payableContracts(db)) {
    const plan = await contractPlan(db, contractId, today);
    for (const st of plan.stages) {
      // 申请「结束」了的段（P12，剩下的不付了）不算可付未申请
      if (st.availableCents > 0 && !st.done) {
        put({ kind: 'available', date: today, amountCents: st.availableCents, payee: plan.payee, requestId: null, requestNo: null, contractId, contractNo: plan.contractNo, stage: st.stage, note: st.reason });
      }
    }
    const w = plan.warranty;
    const st = plan.stages.find((s) => s.stage === 'warranty')!;
    const left = st.remainingCents;
    // 还没到期、这几周内到期的质保金（已经到期的在「可付未申请」里）
    if (left > 0 && w.dueDate && w.dueDate > today && w.dueDate <= lastEnd) {
      put({
        kind: 'warranty',
        date: w.dueDate,
        amountCents: left,
        payee: plan.payee,
        requestId: null,
        requestNo: null,
        contractId,
        contractNo: plan.contractNo,
        stage: 'warranty',
        note: w.openIssues > 0 ? `有 ${w.openIssues} 条未处理的质量问题，处理完才能付` : `${PAYMENT_STAGE_LABELS.warranty}期 ${w.dueDate} 到期`,
      });
    }
  }

  // 没挂合同、也没提申请的应付余额（只作参考）
  const suppliers = await db<{ supplierId: number }[]>`
    SELECT supplier_id FROM ap_entries GROUP BY supplier_id HAVING sum(amount_delta_cents) > 0 ORDER BY supplier_id`;
  let otherAp = 0;
  for (const s of suppliers) {
    const items = await openItems(db, Number(s.supplierId));
    const receiptIds = items.filter((i) => i.kind === 'receipt' && i.openCents > 0).map((i) => i.id);
    const underContract = receiptIds.length
      ? new Set(
          (
            await db<{ id: number }[]>`
              SELECT d.id FROM inv_docs d JOIN purchase_orders po ON po.id = d.purchase_order_id WHERE d.id IN ${db(receiptIds)} AND po.contract_id IS NOT NULL`
          ).map((r) => Number(r.id)),
        )
      : new Set<number>();
    otherAp += items.filter((i) => i.openCents > 0 && !(i.kind === 'receipt' && underContract.has(i.id))).reduce((t, i) => t + i.openCents, 0);
  }
  const [held] = await db<{ cents: string }[]>`
    SELECT coalesce(sum(greatest(0, r.amount_cents - ${requestPaidSql(db)})), 0)::text AS cents
    FROM payment_requests r WHERE r.contract_id IS NULL AND r.status IN ('submitted', 'returned', 'approved')`;
  const otherApCents = Math.max(0, otherAp - Number(held!.cents));

  return { today, from, weeks, totalCents: weeks.reduce((s, w) => s + w.totalCents, 0), laterCents, otherApCents };
}

/** ERP 导航「付款」上的数字：批了待付款的申请、进待办的质保金；每周一另有本周应付 */
export async function paymentTodo(db: Db, today: string): Promise<PaymentTodo> {
  const [a] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM payment_requests WHERE status = 'approved'`;
  const warrantyDue = (await warrantyLedger(db, today, 'due')).length;
  let weekly: PaymentTodo['weekly'] = null;
  if (new Date(`${today}T00:00:00Z`).getUTCDay() === 1) {
    const w = (await weeklyPayables(db, today)).weeks[0]!;
    weekly = { totalCents: w.totalCents, count: w.items.length };
  }
  return { awaitingPayment: a!.n, warrantyDue, weekly };
}

/**
 * 付款流自检（进 `check`，v0.7.32）：
 *   · 付款申请已付 = 带着申请号的没冲销的付款（或合同付款）之和，且不超过申请金额；已付清的正好付清，待付款的没付完，审批中、退回、作废的没付过；
 *   · 按申请登记的付款，供应商与申请一样、申请是供应商往来付款；合同付款的申请是合同付款；
 *   · 没作废的发票分到采购单的金额合计 = 价税合计。
 */
export async function paymentChecks(db: Db): Promise<{ key: string; label: string; ok: boolean; detail: string }[]> {
  const reqs = await db<{ requestNo: string; status: string; amountCents: string; paidCents: string }[]>`
    SELECT r.request_no, r.status, r.amount_cents::text AS amount_cents, ${requestPaidSql(db)}::text AS paid_cents FROM payment_requests r`;
  const bad: string[] = [];
  for (const r of reqs) {
    const amount = Number(r.amountCents);
    const paid = Number(r.paidCents);
    if (paid > amount) bad.push(`${r.requestNo} 已付 ${paid} 超过申请金额 ${amount}`);
    else if (r.status === 'paid' && paid !== amount) bad.push(`${r.requestNo} 标记已付清但已付 ${paid} ≠ ${amount}`);
    else if (r.status === 'approved' && paid >= amount) bad.push(`${r.requestNo} 已付清但还在待付款`);
    else if (['submitted', 'returned', 'voided'].includes(r.status) && paid !== 0) bad.push(`${r.requestNo} 没批或已作废却有付款`);
  }
  const pays = await db<{ docNo: string }[]>`
    SELECT p.doc_no FROM payments p JOIN payment_requests r ON r.id = p.payment_request_id
    WHERE p.supplier_id IS DISTINCT FROM r.supplier_id OR r.pay_mode <> 'ap'`;
  bad.push(...pays.map((p) => `付款 ${p.docNo} 与它的付款申请对不上（供应商或付款方式）`));
  const outs = await db<{ docNo: string }[]>`
    SELECT o.doc_no FROM contract_payouts o JOIN payment_requests r ON r.id = o.payment_request_id WHERE r.pay_mode <> 'direct'`;
  bad.push(...outs.map((o) => `合同付款 ${o.docNo} 的申请不是合同付款`));
  bad.push(...(await invoiceChecks(db)));
  // 进项发票台账（8.0.3）
  const ledger = await ledgerChecks(db);
  return [
    {
      key: 'payments',
      label: '付款流：付款申请的已付与付款登记一致，按申请登记的付款与申请对得上，发票分到采购单的金额合计等于价税合计',
      ok: bad.length === 0,
      detail: bad.length ? bad.slice(0, 20).join('；') : '一致',
    },
    {
      key: 'input_invoices',
      label: '进项发票台账：有效报销单关联的发票都没作废、一张发票只挂一张有效报销单、不既分到采购单又报销，已认证的都有所属期',
      ok: ledger.length === 0,
      detail: ledger.length ? ledger.slice(0, 20).join('；') : '一致',
    },
  ];
}

