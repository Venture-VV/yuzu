// 审批中心的读（v0.7.30，docs/APPROVALS.md 第 3 节）：待我审批、全部在审、我提交的；卡片、详情（审批链每一级与单据要点）、
// 导航上的数字（含超时）、急采待补单（超过 3 天，A10）。只读，不加锁。

import {
  APPROVAL_DOC_KINDS,
  APPROVAL_DOC_TYPE_LABELS,
  APPROVAL_MODE_LABELS,
  URGENT_BACKFILL_ESCALATE_DAYS,
  stepLabel,
  type ApprovalActionView,
  type ApprovalCard,
  type ApprovalCounts,
  type ApprovalDetail,
  type ApprovalDocDigest,
  type ApprovalDocKind,
  type ApprovalDocType,
  type ApprovalStatus,
  type ApprovalStep,
  type ApproverSubject,
  type UrgentAcceptItem,
  type UrgentBackfillItem,
} from '@shared/approvals';
import type { ErpModuleKey } from '@shared/erp';
import { EXPENSE_CATEGORY_LABELS, PAY_SOURCE_LABELS, type ExpenseCategory, type PaySource } from '@shared/expenses';
import { COUNT_REASON_LABELS, INV_DOC_META, isBigVariance, variancePct, type CountReason, type InvDocType } from '@shared/inventory';
import { formatAmount } from '@shared/money';
import { can, permissionsOf, type Duty, type Role } from '@shared/permissions';
import { PAY_METHOD_LABELS, type PayMethod } from '@shared/purchasing';
import { formatQty, lineAmountCents } from '@shared/quantity';
import { loadRoleOverrides } from '../../auth/role-permissions';
import type { Db } from '../../db';
import type { Actor } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { forbidden, notFound } from '../../lib/errors';
import { enabledErpModules, erpModuleDisabled } from '../erp';
import { loadInventorySettings } from '../inventory/common';
import { actionsOf, delegatorsOf, eligibleAt, requiredOf, staffNames, standingOf } from './engine';

/** 看「全部在审」、任意一张审批单的详情：负责人（采购、物资、货款或报销的确认）与管规则的（店主） */
export function canViewAll(who: ApproverSubject): boolean {
  return can(who, 'inventory.approve') || can(who, 'expense.approve') || can(who, 'approval.rules');
}

interface RequestRow {
  id: number;
  docKind: ApprovalDocKind;
  docId: number;
  docType: ApprovalDocType;
  docNo: string;
  amountCents: number | null;
  departmentName: string | null;
  ruleId: number | null;
  ruleNote: string | null;
  steps: ApprovalStep[];
  allowSelf: boolean;
  currentLevel: number;
  levelStartedAt: string;
  status: ApprovalStatus;
  submittedBy: number;
  submittedByName: string;
  submittedAt: string;
  finishedAt: string | null;
  overdue: boolean;
}

async function loadRequests(db: Db, where: { pending?: boolean; ids?: number[]; submittedBy?: number; limit?: number }): Promise<RequestRow[]> {
  const rows = await db<RequestRow[]>`
    SELECT r.id, r.doc_kind, r.doc_id, r.doc_type, r.doc_no, r.amount_cents, d.name AS department_name, r.rule_id, ar.note AS rule_note,
           r.steps, r.allow_self, r.current_level, r.level_started_at, r.status, r.submitted_by, s.display_name AS submitted_by_name,
           r.submitted_at, r.finished_at,
           (r.status = 'pending' AND r.level_started_at < now() - make_interval(hours => 24)) AS overdue
    FROM approval_requests r JOIN staff s ON s.id = r.submitted_by
    LEFT JOIN departments d ON d.id = r.department_id LEFT JOIN approval_rules ar ON ar.id = r.rule_id
    WHERE true
      ${where.pending ? db`AND r.status = 'pending'` : db``}
      ${where.ids ? db`AND r.id IN ${db(where.ids.length ? where.ids : [0])}` : db``}
      ${where.submittedBy !== undefined ? db`AND r.submitted_by = ${where.submittedBy}` : db``}
    ORDER BY r.id DESC
    ${where.limit ? db`LIMIT ${where.limit}` : db``}`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    docId: Number(r.docId),
    amountCents: r.amountCents === null ? null : Number(r.amountCents),
    ruleId: r.ruleId === null ? null : Number(r.ruleId),
    submittedBy: Number(r.submittedBy),
  }));
}

/** 在用的员工（判断某一级有没有人能审） */
async function activeSubjects(db: Db): Promise<ApproverSubject[]> {
  const rows = await db<{ id: number; role: Role; duties: Duty[] | null }[]>`SELECT id, role, duties FROM staff WHERE active`;
  const overrides = await loadRoleOverrides(db);
  return rows.map((r) => {
    const duties = r.duties ?? [];
    return { id: Number(r.id), role: r.role, duties, permissions: permissionsOf({ role: r.role, duties }, overrides) };
  });
}

/** 这一级目前有没有人能审：或签要有一位在用、能审的（提交人不能审自己的单时不算提交人）；会签要指定的人都还能审，或者有店主 */
function isStuck(req: RequestRow, staff: ApproverSubject[]): boolean {
  const step = req.steps[req.currentLevel - 1]!;
  const able = staff.filter((s) => eligibleAt(step, s, req.docKind) && (req.allowSelf || s.id !== req.submittedBy));
  if (able.some((s) => s.role === 'owner')) return false;
  const required = requiredOf(req);
  if (required === null) return able.length === 0;
  if (required.length === 0) return true;
  return !required.every((id) => able.some((s) => s.id === id));
}

/** 卡片上的一句话：供应商 / 部门、前三项物料 */
async function summaries(db: Db, reqs: RequestRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (kind: ApprovalDocKind) => [...new Set(reqs.filter((r) => r.docKind === kind).map((r) => r.docId))];
  const put = (kind: ApprovalDocKind, id: number, party: string | null, items: string | null, n: number) => {
    const list = items ? `${items}${n > 3 ? ` 等 ${n} 项` : ''}` : '';
    out.set(`${kind}:${id}`, [party, list].filter(Boolean).join(' · '));
  };
  const po = ids('purchase_order');
  if (po.length) {
    const rows = await db<{ id: number; party: string; items: string | null; n: number }[]>`
      SELECT p.id, s.name AS party,
             (SELECT string_agg(x.name, '、') FROM (SELECT m.name FROM purchase_order_lines pl JOIN materials m ON m.id = pl.material_id
               WHERE pl.po_id = p.id ORDER BY pl.line_no LIMIT 3) x) AS items,
             (SELECT count(*) FROM purchase_order_lines WHERE po_id = p.id) AS n
      FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id IN ${db(po)}`;
    for (const r of rows) put('purchase_order', Number(r.id), r.party, r.items, r.n);
  }
  const inv = ids('inv_doc');
  if (inv.length) {
    const rows = await db<{ id: number; party: string | null; items: string | null; n: number }[]>`
      SELECT d.id, coalesce(s.name, wd.name || '小仓', dep.name) AS party,
             (SELECT string_agg(x.name, '、') FROM (SELECT m.name FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id
               WHERE l.doc_id = d.id AND (d.doc_type <> 'count' OR l.qty_milli <> 0) ORDER BY l.line_no LIMIT 3) x) AS items,
             (SELECT count(*) FROM inv_doc_lines l WHERE l.doc_id = d.id AND (d.doc_type <> 'count' OR l.qty_milli <> 0)) AS n
      FROM inv_docs d LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN departments dep ON dep.id = d.department_id
      LEFT JOIN warehouses w ON w.id = d.warehouse_id LEFT JOIN departments wd ON wd.id = w.department_id
      WHERE d.id IN ${db(inv)}`;
    for (const r of rows) put('inv_doc', Number(r.id), r.party, r.items, r.n);
  }
  const pay = ids('payment');
  if (pay.length) {
    const rows = await db<{ id: number; party: string; method: PayMethod }[]>`
      SELECT p.id, s.name AS party, p.method FROM payments p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id IN ${db(pay)}`;
    for (const r of rows) put('payment', Number(r.id), r.party, PAY_METHOD_LABELS[r.method] ?? r.method, 1);
  }
  const op = ids('opening_payable');
  if (op.length) {
    const rows = await db<{ id: number; party: string; asOf: string }[]>`
      SELECT o.id, s.name AS party, o.as_of_date AS as_of FROM opening_payables o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id IN ${db(op)}`;
    for (const r of rows) put('opening_payable', Number(r.id), r.party, `期初未付（截至 ${r.asOf}）`, 1);
  }
  const ec = ids('expense_claim');
  if (ec.length) {
    const rows = await db<{ id: number; party: string; purpose: string; handler: string }[]>`
      SELECT c.id, d.name AS party, c.purpose, h.display_name AS handler
      FROM expense_claims c JOIN departments d ON d.id = c.department_id JOIN staff h ON h.id = c.handler_id WHERE c.id IN ${db(ec)}`;
    for (const r of rows) put('expense_claim', Number(r.id), r.party, `${r.purpose} · 经办 ${r.handler}`, 1);
  }
  return out;
}

interface Viewer {
  actor: Actor;
  delegators: ApproverSubject[];
  staff: ApproverSubject[];
}

async function viewerOf(db: Db, actor: Actor, timeZone: string): Promise<Viewer> {
  return { actor, delegators: await delegatorsOf(db, actor.id, todayIn(timeZone)), staff: await activeSubjects(db) };
}

/** 我现在能不能审当前这一级（会签里我能填的都填过了算不能） */
function myStanding(req: RequestRow, v: Viewer, actions: ApprovalActionView[]): { canAct: boolean; actingFor: number[] } {
  if (req.status !== 'pending') return { canAct: false, actingFor: [] };
  const st = standingOf(req, v.actor, v.delegators);
  const required = requiredOf(req);
  if (required === null || (st.self && v.actor.role === 'owner')) {
    return { canAct: st.self || st.behalf.length > 0, actingFor: st.self ? [] : st.behalf.slice(0, 1) };
  }
  const filled = new Set(actions.filter((a) => a.level === req.currentLevel && a.action === 'approve').map((a) => a.onBehalfOf ?? a.actorId));
  const mine = st.self && required.includes(v.actor.id) && !filled.has(v.actor.id);
  const behalf = st.behalf.filter((b) => required.includes(b) && !filled.has(b));
  // 代理店主：会签时代理人能替店主同意（店主同意即这一级通过），与 approveCurrent 一致
  const owner = st.behalf.find((b) => !filled.has(b) && v.delegators.some((d) => d.id === b && d.role === 'owner'));
  if (owner !== undefined && !behalf.includes(owner)) behalf.push(owner);
  return { canAct: mine || behalf.length > 0, actingFor: mine && owner === undefined ? [] : behalf };
}

async function toCards(db: Db, reqs: RequestRow[], v: Viewer): Promise<ApprovalCard[]> {
  if (reqs.length === 0) return [];
  const actions = await actionsOf(db, reqs.map((r) => r.id));
  const sums = await summaries(db, reqs);
  const names = await staffNames(db, [...reqs.flatMap((r) => r.steps.flatMap((s) => ('staffIds' in s ? s.staffIds : []))), ...v.delegators.map((d) => d.id)]);
  return reqs.map((r) => {
    const acts = actions.get(r.id) ?? [];
    const st = myStanding(r, v, acts);
    return {
      id: r.id,
      docKind: r.docKind,
      docId: r.docId,
      docType: r.docType,
      docNo: r.docNo,
      amountCents: r.amountCents,
      departmentName: r.departmentName,
      summary: sums.get(`${r.docKind}:${r.docId}`) ?? '',
      status: r.status,
      ruleId: r.ruleId,
      ruleNote: r.ruleId === null ? null : r.ruleNote || null,
      currentLevel: r.currentLevel,
      levels: r.steps.length,
      currentStepLabel: stepLabel(r.steps[r.currentLevel - 1]!, names),
      submittedById: r.submittedBy,
      submittedByName: r.submittedByName,
      submittedAt: r.submittedAt,
      levelStartedAt: r.levelStartedAt,
      finishedAt: r.finishedAt,
      overdue: r.overdue,
      canAct: st.canAct,
      actingFor: st.actingFor.map((id) => names.get(id) ?? `#${id}`),
      stuck: r.status === 'pending' && isStuck(r, v.staff),
      lastAction: acts.at(-1) ?? null,
    };
  });
}

export type ApprovalTab = 'mine' | 'all' | 'submitted';

/**
 * 单据属于哪个 ERP 模块（Codex 自动审查 2cfd28b）：模块关着时，单据原来的接口一律拒绝（ERP_MODULE_DISABLED），
 * 审批中心也不列、不给看、不能审，不能借这里绕过模块开关。库存单据跟审批中心本身同依赖库存，能进审批中心就说明库存开着
 */
const MODULE_OF_KIND: Record<ApprovalDocKind, ErpModuleKey> = {
  purchase_order: 'purchasing',
  inv_doc: 'inventory',
  payment: 'payables',
  opening_payable: 'payables',
  expense_claim: 'expenses',
};

/** 模块关着的单据种类 */
export async function closedApprovalKinds(db: Db): Promise<Set<ApprovalDocKind>> {
  const on = await enabledErpModules(db);
  return new Set(APPROVAL_DOC_KINDS.filter((k) => !on.has(MODULE_OF_KIND[k])));
}

/** 这种单据的模块关着：拒绝（与单据原来的接口一样） */
export async function assertApprovalKindOpen(db: Db, kind: ApprovalDocKind): Promise<void> {
  if ((await closedApprovalKinds(db)).has(kind)) throw erpModuleDisabled(MODULE_OF_KIND[kind]);
}

/** 待我审批（含我代理的）、全部在审（负责人与店主看全店）、我提交的（最近 100 张） */
export async function listApprovals(db: Db, actor: Actor, timeZone: string, tab: ApprovalTab, docType?: ApprovalDocType): Promise<ApprovalCard[]> {
  if (tab === 'all' && !canViewAll(actor)) throw forbidden('「全部在审」给负责人与店主看');
  const v = await viewerOf(db, actor, timeZone);
  const loaded = tab === 'submitted' ? await loadRequests(db, { submittedBy: actor.id, limit: 100 }) : await loadRequests(db, { pending: true });
  const closed = await closedApprovalKinds(db);
  const reqs = loaded.filter((r) => !closed.has(r.docKind) && (!docType || r.docType === docType));
  let cards = await toCards(db, reqs, v);
  if (tab === 'mine') cards = cards.filter((c) => c.canAct);
  if (tab !== 'submitted') {
    // 超时的排在最前，其次等得久的
    cards.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.levelStartedAt.localeCompare(b.levelStartedAt) || a.id - b.id);
  }
  return cards;
}

/** 导航上的数字：待我审批几张、其中超时几张；急采待补单（超过 3 天，负责人看） */
export async function approvalCounts(db: Db, actor: Actor, timeZone: string): Promise<ApprovalCounts> {
  const mine = await listApprovals(db, actor, timeZone, 'mine');
  const approver = can(actor, 'inventory.approve');
  const backfill = approver ? (await urgentBackfills(db, timeZone)).length : 0;
  const accept = approver ? (await urgentAwaitingAcceptance(db, actor)).length : 0;
  return { mine: mine.length, overdue: mine.filter((c) => c.overdue).length, backfill, accept };
}

// ───────────────────────── 详情 ─────────────────────────

async function digestOf(db: Db, kind: ApprovalDocKind, docId: number): Promise<ApprovalDocDigest> {
  switch (kind) {
    case 'purchase_order': {
      const [p] = await db<{ supplierName: string; orderDate: string; note: string; revision: number; backfill: boolean; channelLabel: string | null; expectedDate: string | null }[]>`
        SELECT s.name AS supplier_name, p.order_date, p.note, p.revision, p.backfill, p.channel_label, p.expected_date
        FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ${docId}`;
      if (!p) throw notFound('采购单不存在');
      const lines = await db<{ id: number; name: string; spec: string; purchaseQtyMilli: number; purchaseUnit: string; priceCents: number; amountCents: number }[]>`
        SELECT pl.id, m.name, coalesce(nullif(pl.spec, ''), m.specification) AS spec, pl.purchase_qty_milli, pl.purchase_unit, pl.price_cents, pl.amount_cents
        FROM purchase_order_lines pl JOIN materials m ON m.id = pl.material_id WHERE pl.po_id = ${docId} ORDER BY pl.line_no`;
      return {
        title: p.backfill ? '补单采购单' : p.revision > 1 ? `采购单改版（第 ${p.revision} 版）` : '采购单',
        link: `/purchasing?po=${docId}`,
        party: p.supplierName,
        docDate: p.orderDate,
        note: p.note,
        facts: [
          ...(p.channelLabel ? [{ label: '采购途径', value: p.channelLabel }] : []),
          ...(p.expectedDate ? [{ label: '预计到货', value: p.expectedDate }] : []),
        ],
        lines: lines.map((l) => ({
          id: Number(l.id),
          name: l.name,
          spec: l.spec,
          qty: formatQty(l.purchaseQtyMilli),
          unit: l.purchaseUnit,
          priceCents: Number(l.priceCents),
          amountCents: Number(l.amountCents),
        })),
      };
    }
    case 'inv_doc': {
      const [d] = await db<{ docType: InvDocType; docDate: string; note: string; party: string | null; warehouseName: string | null }[]>`
        SELECT d.doc_type, d.doc_date, d.note, coalesce(s.name, dep.name) AS party, wd.name || '小仓' AS warehouse_name
        FROM inv_docs d LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN departments dep ON dep.id = d.department_id
        LEFT JOIN warehouses w ON w.id = d.warehouse_id LEFT JOIN departments wd ON wd.id = w.department_id
        WHERE d.id = ${docId}`;
      if (!d) throw notFound('单据不存在');
      const settings = await loadInventorySettings(db);
      const lines = await db<{
        id: number;
        name: string;
        spec: string;
        qtyMilli: number;
        inventoryUnit: string;
        amountCents: number | null;
        priceCents: number | null;
        refPriceCents: number | null;
        factorMilli: number;
        bookMilli: number | null;
        countedMilli: number | null;
        diffReason: CountReason | 'pending' | null;
        diffNote: string;
      }[]>`
        SELECT l.id, m.name, m.specification AS spec, l.qty_milli, l.inventory_unit, l.amount_cents, l.price_cents, m.ref_price_cents, l.factor_milli,
               l.book_milli, l.counted_milli, l.diff_reason, l.diff_note
        FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id WHERE l.doc_id = ${docId} ORDER BY l.line_no`;
      const count = d.docType === 'count';
      return {
        title: count ? '盘点差异' : INV_DOC_META[d.docType].title,
        link: `/inventory/docs?doc=${docId}`,
        party: d.warehouseName ?? d.party,
        docDate: d.docDate,
        note: d.note,
        facts: d.warehouseName ? [{ label: '仓', value: d.warehouseName }] : [],
        lines: lines
          .filter((l) => !count || l.qtyMilli !== 0)
          .map((l) => {
            const est = l.amountCents !== null ? Number(l.amountCents) : l.refPriceCents === null ? null : lineAmountCents(Math.abs(l.qtyMilli), Number(l.refPriceCents), Number(l.factorMilli));
            const book = Number(l.bookMilli ?? 0);
            return {
              id: Number(l.id),
              name: l.name,
              spec: l.spec,
              qty: formatQty(count ? l.qtyMilli : Math.abs(l.qtyMilli)),
              unit: l.inventoryUnit,
              priceCents: l.priceCents === null ? null : Number(l.priceCents),
              amountCents: est,
              ...(count
                ? {
                    count: {
                      bookMilli: book,
                      countedMilli: Number(l.countedMilli ?? 0),
                      diffMilli: l.qtyMilli,
                      pct: variancePct(book, l.qtyMilli),
                      big: isBigVariance(book, l.qtyMilli, est, settings),
                      reason: l.diffReason && l.diffReason !== 'pending' ? COUNT_REASON_LABELS[l.diffReason] : null,
                      reasonNote: l.diffNote,
                    },
                  }
                : {}),
            };
          }),
      };
    }
    case 'payment': {
      const [p] = await db<{ supplierName: string; payDate: string; note: string; method: PayMethod; evidence: string }[]>`
        SELECT s.name AS supplier_name, p.pay_date, p.note, p.method, p.evidence FROM payments p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ${docId}`;
      if (!p) throw notFound('付款记录不存在');
      const allocs = await db<{ id: number; docNo: string; amountCents: number }[]>`
        SELECT pa.id, coalesce(d.doc_no, o.doc_no) AS doc_no, pa.amount_cents
        FROM payment_allocations pa LEFT JOIN inv_docs d ON d.id = pa.receipt_doc_id LEFT JOIN opening_payables o ON o.id = pa.opening_payable_id
        WHERE pa.payment_id = ${docId} ORDER BY pa.id`;
      return {
        title: '付款',
        link: `/payables?payment=${docId}`,
        party: p.supplierName,
        docDate: p.payDate,
        note: p.note,
        facts: [
          { label: '方式', value: PAY_METHOD_LABELS[p.method] ?? p.method },
          { label: '凭据', value: p.evidence },
        ],
        lines: allocs.map((a) => ({ id: Number(a.id), name: `核销 ${a.docNo}`, spec: '', qty: '', unit: '', priceCents: null, amountCents: Number(a.amountCents) })),
      };
    }
    case 'opening_payable': {
      const [o] = await db<{ supplierName: string; asOfDate: string; note: string }[]>`
        SELECT s.name AS supplier_name, o.as_of_date, o.note FROM opening_payables o JOIN suppliers s ON s.id = o.supplier_id WHERE o.id = ${docId}`;
      if (!o) throw notFound('期初未付记录不存在');
      return { title: '期初未付', link: '/payables?view=openings', party: o.supplierName, docDate: o.asOfDate, note: o.note, facts: [{ label: '截至', value: o.asOfDate }], lines: [] };
    }
    case 'expense_claim': {
      const [c] = await db<{ departmentName: string; expenseDate: string; note: string; purpose: string; paySource: PaySource; invoiceLabel: string; handlerName: string; poNo: string | null }[]>`
        SELECT d.name AS department_name, c.expense_date, c.note, c.purpose, c.pay_source, c.invoice_label, h.display_name AS handler_name, po.doc_no AS po_no
        FROM expense_claims c JOIN departments d ON d.id = c.department_id JOIN staff h ON h.id = c.handler_id
        LEFT JOIN purchase_orders po ON po.id = c.purchase_order_id WHERE c.id = ${docId}`;
      if (!c) throw notFound('报销单不存在');
      const lines = await db<{ id: number; name: string; category: ExpenseCategory; unit: string; boughtMilli: number; amountCents: number }[]>`
        SELECT id, name, category, unit, bought_milli, amount_cents FROM expense_claim_lines WHERE claim_id = ${docId} ORDER BY line_no`;
      return {
        title: '费用报销',
        link: `/erp/expenses?claim=${docId}`,
        party: c.departmentName,
        docDate: c.expenseDate,
        note: c.note,
        facts: [
          { label: '用途', value: c.purpose },
          { label: '经办', value: c.handlerName },
          { label: '付款来源', value: PAY_SOURCE_LABELS[c.paySource] ?? c.paySource },
          { label: '发票', value: c.invoiceLabel },
          ...(c.poNo ? [{ label: '采购单', value: c.poNo }] : []),
        ],
        lines: lines.map((l) => ({
          id: Number(l.id),
          name: l.name,
          spec: EXPENSE_CATEGORY_LABELS[l.category] ?? l.category,
          qty: formatQty(l.boughtMilli),
          unit: l.unit,
          priceCents: null,
          amountCents: Number(l.amountCents),
        })),
      };
    }
  }
}

export async function getApprovalDetail(db: Db, actor: Actor, timeZone: string, id: number): Promise<ApprovalDetail> {
  const [req] = await loadRequests(db, { ids: [id] });
  if (!req) throw notFound('审批单不存在');
  await assertApprovalKindOpen(db, req.docKind);
  const v = await viewerOf(db, actor, timeZone);
  const [card] = await toCards(db, [req], v);
  const actions = (await actionsOf(db, [id])).get(id) ?? [];
  // 能看：现在能审的、提交人、审过这张单的、负责人与店主
  const mine = card!.canAct || req.submittedBy === actor.id || actions.some((a) => a.actorId === actor.id) || canViewAll(actor);
  if (!mine) throw forbidden('这张审批单不在你的待办里');
  const names = await staffNames(db, req.steps.flatMap((s) => ('staffIds' in s ? s.staffIds : [])));
  const levelsDetail = req.steps.map((step, i) => {
    const level = i + 1;
    const acts = actions.filter((a) => a.level === level);
    const returned = acts.some((a) => a.action === 'return');
    const state: ApprovalDetail['levelsDetail'][number]['state'] = returned
      ? 'returned'
      : req.status === 'approved' || level < req.currentLevel
        ? 'done'
        : level === req.currentLevel && req.status === 'pending'
          ? 'current'
          : 'waiting';
    const required = 'staffIds' in step && step.mode === 'all' ? step.staffIds.filter((sid) => req.allowSelf || sid !== req.submittedBy) : [];
    const approved = new Set(acts.filter((a) => a.action === 'approve').map((a) => a.onBehalfOf ?? a.actorId));
    return {
      level,
      label: stepLabel(step, names),
      mode: step.mode,
      state,
      waitingFor: state === 'current' ? required.filter((sid) => !approved.has(sid)).map((sid) => names.get(sid) ?? `#${sid}`) : [],
      actions: acts,
    };
  });
  const previous = await db<{ id: number; status: ApprovalStatus; submittedAt: string; finishedAt: string | null; lastComment: string | null }[]>`
    SELECT r.id, r.status, r.submitted_at, r.finished_at,
           (SELECT a.comment FROM approval_actions a WHERE a.request_id = r.id ORDER BY a.id DESC LIMIT 1) AS last_comment
    FROM approval_requests r WHERE r.doc_kind = ${req.docKind} AND r.doc_id = ${req.docId} AND r.id <> ${id} ORDER BY r.id DESC LIMIT 10`;
  return {
    ...card!,
    allowSelf: req.allowSelf,
    levelsDetail,
    doc: await digestOf(db, req.docKind, req.docId),
    previous: previous.map((p) => ({ ...p, id: Number(p.id) })),
  };
}

/** 卡片标题：单据类型（盘点差异、报损……） */
export const cardTitle = (c: Pick<ApprovalCard, 'docType'>) => APPROVAL_DOC_TYPE_LABELS[c.docType];
export const modeText = (mode: 'any' | 'all') => APPROVAL_MODE_LABELS[mode];
export const yuan = (cents: number) => `¥${formatAmount(cents)}`;

// ───────────────────────── 急采待补单（A10） ─────────────────────────

/** 急采收货生效后超过 3 天还没补采购单的（补单后自动消失；补单撤回的回到这里） */
/**
 * 急采待验收：部门登记的急采收货，等仓库或负责人到部门验收（急采不走审批中心）。原来导航上「审批待办」的数字把所有待确认的
 * 物资单据都算上，审批中心的数字只算审批单，这些就没了提醒（Codex 自动审查 abe2842）：负责人的数字照样算上、页面上方列出来。
 * 登记的人自己验收不了（店主除外），不算他的。
 */
export async function urgentAwaitingAcceptance(db: Db, actor: Actor): Promise<UrgentAcceptItem[]> {
  const rows = await db<{ docId: number; docNo: string; departmentName: string | null; supplierName: string | null; amountCents: number | null; createdAt: string; handlerName: string }[]>`
    SELECT d.id AS doc_id, d.doc_no, wd.name AS department_name, s.name AS supplier_name, d.amount_cents, d.created_at, cb.display_name AS handler_name
    FROM inv_docs d JOIN staff cb ON cb.id = d.created_by
    LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN warehouses w ON w.id = d.warehouse_id LEFT JOIN departments wd ON wd.id = w.department_id
    WHERE d.doc_type = 'receipt' AND d.urgent AND d.status = 'submitted'
      ${actor.role === 'owner' ? db`` : db`AND d.created_by <> ${actor.id}`}
    ORDER BY d.created_at, d.id`;
  return rows.map((r) => ({ ...r, docId: Number(r.docId), amountCents: r.amountCents === null ? null : Number(r.amountCents) }));
}

export async function urgentBackfills(db: Db, timeZone: string): Promise<UrgentBackfillItem[]> {
  // 补单要开采购单：采购模块关着时不提醒（补不了）
  if (!(await enabledErpModules(db)).has('purchasing')) return [];
  const today = todayIn(timeZone);
  const rows = await db<{ receiptId: number; docNo: string; departmentName: string | null; supplierName: string | null; amountCents: number; confirmedAt: string; daysOver: number; handlerName: string }[]>`
    SELECT d.id AS receipt_id, d.doc_no, wd.name AS department_name, s.name AS supplier_name, d.amount_cents, d.confirmed_at,
           (${today}::date - (d.confirmed_at AT TIME ZONE ${timeZone})::date) - ${URGENT_BACKFILL_ESCALATE_DAYS} AS days_over,
           cb.display_name AS handler_name
    FROM inv_docs d JOIN staff cb ON cb.id = d.created_by
    LEFT JOIN suppliers s ON s.id = d.supplier_id LEFT JOIN warehouses w ON w.id = d.warehouse_id LEFT JOIN departments wd ON wd.id = w.department_id
    WHERE d.doc_type = 'receipt' AND d.urgent AND d.status = 'confirmed' AND d.purchase_order_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM purchase_orders p WHERE p.backfill_receipt_id = d.id AND p.status NOT IN ('cancelled'))
      AND (${today}::date - (d.confirmed_at AT TIME ZONE ${timeZone})::date) > ${URGENT_BACKFILL_ESCALATE_DAYS}
    ORDER BY d.confirmed_at, d.id`;
  return rows.map((r) => ({ ...r, receiptId: Number(r.receiptId), amountCents: Number(r.amountCents) }));
}
