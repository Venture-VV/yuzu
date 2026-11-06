// 合同的付款计划（v0.7.32，docs/PAYMENTS.md 第 2 节，默认 P1–P4、P12 待确认）：不另存表，每次按合同生效的那一版现算——
// 变更单生效（合同升版）以后自然按新的一版算。每一段：计划金额、按条件放开的可付金额、已申请、已付、还能申请多少、为什么现在能付 / 还不能付。
// 验收登记、质量问题登记、收货（减退货）决定到货、验收、质保三段放不放开。只读，不加锁（新建付款申请时在锁住合同一行以后再算一次）。

import { PAYMENT_STAGES, PAYMENT_STAGE_LABELS, WARRANTY_BASIS_LABELS, type ContractCategory, type ContractStatus, type PaymentStage } from '@shared/contracts';
import { formatAmount } from '@shared/money';
import {
  REQUEST_OPEN_STATUSES,
  addMonths,
  stageAmounts,
  type AcceptanceView,
  type ContractPaymentPlan,
  type PayMode,
  type PaymentRequestStatus,
  type PlanRequestBrief,
  type QualityIssueView,
  type StagePlan,
  type WarrantyState,
} from '@shared/payments';
import type { Db, Fragment } from '../../db';
import { daysBetween } from '../../lib/dates';
import { notFound } from '../../lib/errors';
import { readContent } from '../contracts/content';

const yuan = (cents: number) => `¥${formatAmount(cents)}`;

/** 签署以后（已签署、已归档、签署后终止的）才能付款 */
export const PAYABLE_CONTRACT_STATUSES: readonly ContractStatus[] = ['signed', 'archived', 'terminated'];

/** 一张申请已付的金额（供应商往来的付款 + 合同付款，都只算没冲销的）；r 是付款申请的别名 */
export const requestPaidSql = (db: Db, alias = 'r'): Fragment => db`(
  coalesce((SELECT sum(p.amount_cents) FROM payments p WHERE p.payment_request_id = ${db(alias)}.id AND p.status = 'confirmed'), 0)
  + coalesce((SELECT sum(o.amount_cents) FROM contract_payouts o WHERE o.payment_request_id = ${db(alias)}.id AND o.status = 'confirmed'), 0))`;

/** 合同付款的方式：采购合同按供应商往来付款（核销到收货单），其余没有收货单、不记应付，在申请上登记合同付款 */
export const payModeOf = (category: ContractCategory): PayMode => (category === 'purchase' ? 'ap' : 'direct');

export async function acceptancesOf(db: Db, contractId: number): Promise<AcceptanceView[]> {
  const rows = await db<AcceptanceView[]>`
    SELECT a.id, a.accepted_on, a.result, a.signer, a.note, cb.display_name AS created_by_name, a.created_at,
           a.voided_at, vb.display_name AS voided_by_name, a.void_reason
    FROM contract_acceptances a JOIN staff cb ON cb.id = a.created_by LEFT JOIN staff vb ON vb.id = a.voided_by
    WHERE a.contract_id = ${contractId}
    ORDER BY a.accepted_on DESC, a.id DESC`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function qualityIssuesOf(db: Db, contractId: number): Promise<QualityIssueView[]> {
  const rows = await db<QualityIssueView[]>`
    SELECT q.id, q.found_on, q.description, q.status, q.resolved_on, q.resolution, rb.display_name AS resolved_by_name,
           q.void_reason, vb.display_name AS voided_by_name, cb.display_name AS created_by_name, q.created_at
    FROM contract_quality_issues q JOIN staff cb ON cb.id = q.created_by
    LEFT JOIN staff rb ON rb.id = q.resolved_by LEFT JOIN staff vb ON vb.id = q.voided_by
    WHERE q.contract_id = ${contractId}
    ORDER BY (q.status = 'open') DESC, q.found_on DESC, q.id DESC`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** 采购合同挂的采购单上，已生效的收货金额减去生效的退货、最后一次到货日 */
export async function contractReceipts(db: Db, contractId: number): Promise<{ receivedCents: number; lastDeliveryDate: string | null }> {
  const [r] = await db<{ receivedCents: string; returnedCents: string; lastDate: string | null }[]>`
    SELECT coalesce((SELECT sum(coalesce(d.amount_cents, 0)) FROM inv_docs d JOIN purchase_orders po ON po.id = d.purchase_order_id
                     WHERE po.contract_id = ${contractId} AND d.doc_type = 'receipt' AND d.status = 'confirmed'), 0)::text AS received_cents,
           coalesce((SELECT sum(coalesce(r.amount_cents, 0)) FROM inv_docs r JOIN inv_docs d ON d.id = r.source_doc_id
                     JOIN purchase_orders po ON po.id = d.purchase_order_id
                     WHERE po.contract_id = ${contractId} AND r.doc_type = 'supplier_return' AND r.status = 'confirmed'), 0)::text AS returned_cents,
           (SELECT max(d.doc_date)::text FROM inv_docs d JOIN purchase_orders po ON po.id = d.purchase_order_id
            WHERE po.contract_id = ${contractId} AND d.doc_type = 'receipt' AND d.status = 'confirmed') AS last_date`;
  return { receivedCents: Math.max(0, Number(r!.receivedCents) - Number(r!.returnedCents)), lastDeliveryDate: r!.lastDate };
}

interface RequestAgg {
  id: number;
  requestNo: string;
  stage: PaymentStage;
  status: PaymentRequestStatus;
  amountCents: number;
  paidCents: number;
  early: boolean;
  expectedDate: string;
}

async function stageRequests(db: Db, contractId: number): Promise<RequestAgg[]> {
  const rows = await db<RequestAgg[]>`
    SELECT r.id, r.request_no, r.stage, r.status, r.amount_cents, ${requestPaidSql(db)} AS paid_cents, r.early, r.expected_date
    FROM payment_requests r WHERE r.contract_id = ${contractId} AND r.status <> 'voided'
    ORDER BY r.id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), amountCents: Number(r.amountCents), paidCents: Number(r.paidCents) }));
}

/**
 * 算一份合同的付款计划（P1–P4、P12）。today：门店时区的今天。
 * 还没审批通过的合同按草稿算计划金额，但哪一段都不可付、不能申请。
 */
export async function contractPlan(db: Db, contractId: number, today: string): Promise<ContractPaymentPlan> {
  const [c] = await db<{
    id: number;
    contractNo: string;
    title: string;
    category: ContractCategory;
    status: ContractStatus;
    supplierId: number | null;
    supplierName: string | null;
    counterparty: string;
    departmentId: number | null;
    totalCents: number;
    currentVersion: number;
    currentRevisionId: number | null;
    signedOn: string | null;
    draft: unknown;
  }[]>`
    SELECT c.id, c.contract_no, c.title, c.category, c.status, c.supplier_id, s.name AS supplier_name, c.counterparty, c.department_id,
           c.total_cents, c.current_version, c.current_revision_id, c.signed_on, c.draft
    FROM contracts c LEFT JOIN suppliers s ON s.id = c.supplier_id WHERE c.id = ${contractId}`;
  if (!c) throw notFound('合同不存在');
  let content = readContent(c.draft);
  if (c.currentRevisionId !== null) {
    const [rev] = await db<{ content: unknown }[]>`SELECT content FROM contract_revisions WHERE id = ${c.currentRevisionId}`;
    content = { ...readContent(rev!.content), lines: [] };
  }
  const total = content.totalCents;
  const payMode = payModeOf(c.category);
  const signed = PAYABLE_CONTRACT_STATUSES.includes(c.status) && c.signedOn !== null;
  const whyNot = signed
    ? null
    : c.status === 'approved'
      ? '合同审批通过了，还没登记签署，签署以后才能申请付款'
      : c.status === 'voided'
        ? '合同已作废'
        : '合同还没审批通过';

  const purchase = c.category === 'purchase';
  const receipts = purchase ? await contractReceipts(db, contractId) : null;
  const acceptances = await acceptancesOf(db, contractId);
  const latest = acceptances.find((a) => a.voidedAt === null) ?? null;
  const passed = latest?.result === 'pass';
  const issues = await qualityIssuesOf(db, contractId);
  const openIssues = issues.filter((q) => q.status === 'open').length;

  // 质保起算（P3）
  let startDate: string | null = null;
  let startNote = '';
  const basis = content.warranty.basis;
  if (basis === 'signing') startDate = c.signedOn;
  else if (basis === 'delivery' && purchase) startDate = receipts!.lastDeliveryDate;
  else {
    if (basis === 'delivery') startNote = '没有收货单，按验收合格日起算';
    startDate = passed ? latest!.acceptedOn : null;
  }
  const dueDate = startDate ? addMonths(startDate, content.warranty.months) : null;
  const warranty: WarrantyState = {
    basis,
    months: content.warranty.months,
    startDate,
    startNote,
    dueDate,
    daysLeft: dueDate ? daysBetween(today, dueDate) : null,
    openIssues,
  };

  const planned = stageAmounts(total, content.paymentTerms);
  const reqs = await stageRequests(db, contractId);
  const stages: StagePlan[] = PAYMENT_STAGES.map((stage) => {
    const term = content.paymentTerms.find((t) => t.stage === stage);
    const plannedCents = planned[stage];
    const mine = reqs.filter((r) => r.stage === stage);
    const requestedCents = mine.filter((r) => REQUEST_OPEN_STATUSES.includes(r.status)).reduce((s, r) => s + Math.max(0, r.amountCents - r.paidCents), 0);
    const paidCents = mine.reduce((s, r) => s + r.paidCents, 0);
    let payableCents = 0;
    let reason: string;
    if (plannedCents === 0) reason = '这一段比例为 0，不用付';
    else if (!signed) reason = whyNot!;
    else {
      switch (stage) {
        case 'prepay':
          payableCents = plannedCents;
          reason = `合同 ${c.signedOn} 已签署，预付款可付`;
          break;
        case 'delivery':
          if (purchase) {
            const received = receipts!.receivedCents;
            if (received <= 0) reason = '还没有生效的收货单';
            else if (total <= 0 || received >= total) {
              payableCents = plannedCents;
              reason = `已到货 ${yuan(received)}，到齐了，到货款可付`;
            } else {
              payableCents = Math.min(plannedCents, Math.round((plannedCents * received) / total));
              reason = `已到货 ${yuan(received)} / 合同 ${yuan(total)}，到货段按比例放开 ${yuan(payableCents)}`;
            }
          } else if (passed) {
            payableCents = plannedCents;
            reason = `没有收货单的合同按验收：${latest!.acceptedOn} 验收合格，到货款可付`;
          } else reason = '没有收货单的合同验收合格后放开（还没登记合格的验收）';
          break;
        case 'acceptance':
          if (passed) {
            payableCents = plannedCents;
            reason = `${latest!.acceptedOn} 验收合格（签字：${latest!.signer}），验收款可付`;
          } else reason = latest ? `最近一次验收（${latest.acceptedOn}）不合格：${latest.note}` : '还没登记验收';
          break;
        case 'warranty':
          if (!startDate) {
            reason =
              basis === 'delivery' && purchase
                ? '质保从到货日起算，还没有生效的收货单'
                : `质保从${basis === 'delivery' ? '验收合格日（没有收货单）' : WARRANTY_BASIS_LABELS[basis]}起算，还没登记合格的验收`;
          } else if (openIssues > 0) reason = `有 ${openIssues} 条未处理的质量问题，处理完才能付质保金`;
          else if (today < dueDate!) reason = `质保期到 ${dueDate}，还有 ${daysBetween(today, dueDate!)} 天`;
          else {
            payableCents = plannedCents;
            reason = `质保期 ${dueDate} 已满，没有未处理的质量问题，质保金可付`;
          }
          break;
      }
    }
    const overpaidCents = Math.max(0, paidCents - plannedCents);
    if (overpaidCents > 0) reason = `已付 ${yuan(paidCents)}，超过这一段（变更后）的计划金额 ${yuan(plannedCents)}，超出 ${yuan(overpaidCents)}（只显示，不追回）`;
    const remainingCents = Math.max(0, plannedCents - requestedCents - paidCents);
    const availableCents = Math.max(0, Math.min(payableCents, plannedCents) - requestedCents - paidCents);
    const open = mine.some((r) => REQUEST_OPEN_STATUSES.includes(r.status));
    const lastEnded = mine.length > 0 && mine[mine.length - 1]!.status === 'ended';
    const done = plannedCents === 0 || paidCents >= plannedCents || (!open && lastEnded);
    const requests: PlanRequestBrief[] = mine.map((r) => ({
      id: r.id,
      requestNo: r.requestNo,
      status: r.status,
      amountCents: r.amountCents,
      paidCents: r.paidCents,
      early: r.early,
      expectedDate: r.expectedDate,
    }));
    return {
      stage,
      percentBp: term?.percentBp ?? 0,
      condition: term?.condition ?? '',
      plannedCents,
      payableCents,
      requestedCents,
      paidCents,
      availableCents,
      remainingCents,
      overpaidCents,
      reason,
      done,
      requests,
    };
  });

  const [legacy] = await db<{ cents: string }[]>`
    SELECT coalesce(sum(pa.amount_cents), 0)::text AS cents
    FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
    JOIN inv_docs d ON d.id = pa.receipt_doc_id JOIN purchase_orders po ON po.id = d.purchase_order_id
    WHERE po.contract_id = ${contractId} AND p.status = 'confirmed' AND p.payment_request_id IS NULL`;

  return {
    contractId: Number(c.id),
    contractNo: c.contractNo,
    title: c.title,
    category: c.category,
    status: c.status,
    totalCents: total,
    currentVersion: c.currentVersion,
    payMode,
    supplierId: c.supplierId === null ? null : Number(c.supplierId),
    payee: payMode === 'ap' ? (c.supplierName ?? c.counterparty) : c.counterparty,
    departmentId: c.departmentId === null ? null : Number(c.departmentId),
    canRequest: signed,
    whyNot,
    receivedCents: receipts?.receivedCents ?? null,
    lastDeliveryDate: receipts?.lastDeliveryDate ?? null,
    latestAcceptance: latest,
    warranty,
    stages,
    plannedCents: stages.reduce((s, x) => s + x.plannedCents, 0),
    requestedCents: stages.reduce((s, x) => s + x.requestedCents, 0),
    paidCents: stages.reduce((s, x) => s + x.paidCents, 0),
    settled: stages.every((s) => s.done),
    legacyPaidCents: Number(legacy!.cents),
    acceptances,
    qualityIssues: issues,
  };
}

/** 一段的标签：预付 30% */
export const stageTitle = (stage: PaymentStage) => PAYMENT_STAGE_LABELS[stage];
