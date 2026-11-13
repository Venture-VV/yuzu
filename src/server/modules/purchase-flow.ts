// 采购流程图（8.0.17，docs/FLOW_V8017.md）：只读。把需求单、询价单、采购单取成「事实」，交给 @shared/purchase-flow 算出一排环节。
// 不写任何东西、不加锁；都在只读快照里取（一条流程的几张单据读同一时刻的数）。
//
// 谁看得到（LC6）：
//   · 有「查看库存」的（采购、仓库、财务、负责人）：任何一条流程、进行中的列表，带金额；
//   · 只有需求单权限的部门同事：只能从自己看得到的需求单看流程（与需求单详情同一条规矩），不带金额、下游的单据不给链接。
// 采购单的已收、已付用采购单详情的同一个函数（poMoney），两处的数一样。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can } from '@shared/permissions';
import { buildPurchaseFlow, type FlowAnchorKind, type FlowFacts, type FlowPoFact, type FlowRequestFact, type FlowRules, type FlowSourcingFact, type PurchaseFlow, type PurchaseFlowList } from '@shared/purchase-flow';
import type { InvDocStatus } from '@shared/inventory';
import type { PoStatus, ReceivingState, SourcingStatus } from '@shared/purchasing';
import type { RequestStatus } from '@shared/requests';
import { readSnapshot, type Db } from '../db';
import { guardAny } from '../auth/guard';
import type { Actor, Deps } from '../lib/context';
import { todayIn } from '../lib/dates';
import { forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { shiftDate } from '@shared/labels';
import { approvalBrief } from './approvals/engine';
import { poSettlement } from './inventory/common';
import { loadPurchaseRules } from './inventory/purchase-rules';
import { poMoney } from './inventory/purchasing';
import { loadPaymentRules } from './payments/rules';

/** 进行中的列表最多列几条、往回看多少天（再早的已确认采购单、已通过的需求单不列） */
export const FLOW_LIST_MAX = 60;
export const FLOW_LIST_DAYS = 120;
/** 一张需求单最多带几张采购单进流程图（拆得再多的只算前几张） */
const MAX_POS_PER_FLOW = 8;

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

interface Ctx {
  db: Db;
  rules: FlowRules;
  cutoffEnabled: boolean;
  now: string;
  today: string;
  purchasing: boolean;
  /** 一次请求里同一张单只取一次 */
  requests: Map<number, Promise<(FlowRequestFact & { departmentId: number; requesterId: number; deptHeadId: number | null; poIds: number[]; sourcingIds: number[] }) | null>>;
  pos: Map<number, Promise<(FlowPoFact & { requestIds: number[]; sourcingId: number | null }) | null>>;
  sourcings: Map<number, Promise<(FlowSourcingFact & { requestIds: number[]; poIds: number[] }) | null>>;
}

async function context(db: Db, actor: Actor, timezone: string): Promise<Ctx> {
  const r = await loadPurchaseRules(db);
  return {
    db,
    rules: { quoteThresholdCents: r.quoteThresholdCents, minQuotes: r.minQuotes, arrivalOverdueDays: r.arrivalOverdueDays, stallDays: r.flowStallDays, payDays: (await loadPaymentRules(db)).payDays },
    cutoffEnabled: r.cutoffEnabled,
    now: new Date().toISOString(),
    today: todayIn(timezone),
    purchasing: can(actor, 'inventory.read'),
    requests: new Map(),
    pos: new Map(),
    sourcings: new Map(),
  };
}

// ───────────────────────── 取事实 ─────────────────────────

/** 需求行有没有有效的采购单行（撤回的采购单不算） */
const ORDERED = (db: Db) => db`
  EXISTS (SELECT 1 FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
          WHERE x.request_line_id = l.id AND po.status <> 'cancelled')`;

function requestFact(c: Ctx, id: number) {
  let p = c.requests.get(id);
  if (!p) {
    p = (async () => {
      const { db } = c;
      const [r] = await db<Record<string, unknown>[]>`
        SELECT r.id, r.doc_no, r.status, r.department_id, d.name AS department_name, r.requester_id, s.display_name AS requester_name,
               r.submitted_at, r.reviewed_at, rb.display_name AS reviewed_by_name, r.reason, r.approvable_on,
               r.dept_confirm, r.dept_head_id, hd.display_name AS dept_head_name, cf.display_name AS dept_confirmed_by_name, r.dept_confirmed_at,
               (SELECT count(*)::int FROM purchase_request_lines l WHERE l.request_id = r.id) AS line_count,
               coalesce((SELECT string_agg(l.name, '、' ORDER BY l.line_no) FROM purchase_request_lines l WHERE l.request_id = r.id AND l.line_no <= 3), '') AS summary,
               (SELECT count(*)::int FROM purchase_request_lines l WHERE l.request_id = r.id AND NOT ${ORDERED(db)}) AS unordered_lines,
               coalesce((SELECT sum(round(l.qty_milli::numeric * l.ref_price_cents / 1000)) FROM purchase_request_lines l
                         WHERE l.request_id = r.id AND l.ref_price_cents IS NOT NULL), 0)::float8 AS estimate_cents,
               (SELECT count(*)::int FROM purchase_request_lines l WHERE l.request_id = r.id AND l.ref_price_cents IS NOT NULL) AS priced_lines,
               coalesce((SELECT array_agg(DISTINCT po.id ORDER BY po.id) FROM purchase_request_lines l
                         JOIN purchase_order_line_requests x ON x.request_line_id = l.id JOIN purchase_order_lines pl ON pl.id = x.po_line_id
                         JOIN purchase_orders po ON po.id = pl.po_id WHERE l.request_id = r.id AND po.status <> 'cancelled'), '{}') AS po_ids,
               coalesce((SELECT array_agg(DISTINCT e.id ORDER BY e.id) FROM purchase_request_lines l
                         JOIN sourcing_line_requests sr ON sr.request_line_id = l.id JOIN sourcing_lines sl ON sl.id = sr.sourcing_line_id
                         JOIN sourcing_events e ON e.id = sl.event_id WHERE l.request_id = r.id AND e.status <> 'cancelled'), '{}') AS sourcing_ids
        FROM purchase_requests r JOIN departments d ON d.id = r.department_id JOIN staff s ON s.id = r.requester_id
        LEFT JOIN staff rb ON rb.id = r.reviewed_by LEFT JOIN staff hd ON hd.id = r.dept_head_id LEFT JOIN staff cf ON cf.id = r.dept_confirmed_by
        WHERE r.id = ${id}`;
      if (!r) return null;
      const status = r.status as RequestStatus;
      const approvableOn = day(r.approvableOn);
      const lineCount = Number(r.lineCount);
      return {
        id: Number(r.id),
        docNo: String(r.docNo),
        status,
        departmentId: Number(r.departmentId),
        departmentName: String(r.departmentName),
        requesterId: Number(r.requesterId),
        requesterName: String(r.requesterName),
        submittedAt: iso(r.submittedAt)!,
        reviewedAt: iso(r.reviewedAt),
        reviewedByName: (r.reviewedByName as string | null) ?? null,
        reason: (r.reason as string | null) ?? null,
        lockedToday: c.cutoffEnabled && status === 'submitted' && approvableOn !== null && approvableOn > c.today,
        deptConfirm: {
          state: r.deptConfirm as 'none' | 'pending' | 'confirmed',
          headName: (r.deptHeadName as string | null) ?? null,
          confirmedByName: (r.deptConfirmedByName as string | null) ?? null,
          confirmedAt: iso(r.deptConfirmedAt),
        },
        deptHeadId: r.deptHeadId == null ? null : Number(r.deptHeadId),
        lineCount,
        summary: lineCount > 3 ? `${String(r.summary)} 等 ${lineCount} 项` : String(r.summary),
        unorderedLines: Number(r.unorderedLines),
        estimateCents: Math.round(Number(r.estimateCents)),
        pricedLines: Number(r.pricedLines),
        poIds: ids(r.poIds),
        sourcingIds: ids(r.sourcingIds),
      };
    })();
    c.requests.set(id, p);
  }
  return p;
}

function poFact(c: Ctx, id: number) {
  let p = c.pos.get(id);
  if (!p) {
    p = (async () => {
      const { db } = c;
      const [po] = await db<Record<string, unknown>[]>`
        SELECT po.id, po.doc_no, po.status, s.name AS supplier_name, po.total_cents, po.order_date, po.expected_date, po.created_at,
               cb.display_name AS created_by_name, po.approved_at, ab.display_name AS approved_by_name, po.returned_reason, po.close_reason, po.sourcing_event_id,
               (SELECT count(*)::int FROM purchase_order_lines pl WHERE pl.po_id = po.id) AS line_count,
               coalesce((SELECT string_agg(m.name, '、' ORDER BY pl.line_no) FROM purchase_order_lines pl JOIN materials m ON m.id = pl.material_id
                         WHERE pl.po_id = po.id AND pl.line_no <= 3), '') AS summary,
               (SELECT max(a.created_at) FROM approval_logs a WHERE a.doc_kind = 'purchase_order' AND a.doc_id = po.id AND a.action = 'submit') AS submitted_at,
               coalesce((SELECT array_agg(DISTINCT rl.request_id ORDER BY rl.request_id) FROM purchase_order_lines pl
                         JOIN purchase_order_line_requests x ON x.po_line_id = pl.id JOIN purchase_request_lines rl ON rl.id = x.request_line_id
                         WHERE pl.po_id = po.id), '{}') AS request_ids,
               (SELECT count(*)::int FROM purchase_order_lines pl WHERE pl.po_id = po.id AND NOT EXISTS (
                  SELECT 1 FROM expense_claim_lines cl JOIN expense_claims ec ON ec.id = cl.claim_id
                  WHERE cl.po_line_id = pl.id AND ec.status IN ('submitted', 'returned', 'confirmed'))) AS unclaimed_lines,
               (SELECT count(*)::int FROM expense_claims ec WHERE ec.purchase_order_id = po.id AND ec.status IN ('submitted', 'returned')) AS claims_pending
        FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN staff cb ON cb.id = po.created_by
        LEFT JOIN staff ab ON ab.id = po.approved_by
        WHERE po.id = ${id}`;
      if (!po || po.status === 'cancelled') return null;
      // 每行订了多少、合格实收多少（与采购单详情同一口径：已生效的单据）
      const lines = await db<{ base: number; received: number }[]>`
        SELECT pl.base_qty_milli AS base,
               coalesce((SELECT sum(l.qty_milli) FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id WHERE l.po_line_id = pl.id AND d.status = 'confirmed'), 0) AS received
        FROM purchase_order_lines pl WHERE pl.po_id = ${id}`;
      const receivedLines = lines.filter((l) => Number(l.received) >= Number(l.base)).length;
      const anyReceived = lines.some((l) => Number(l.received) > 0);
      const receiving: ReceivingState = !anyReceived ? 'none' : receivedLines === lines.length ? 'full' : 'partial';
      const receipts = await db<{ id: number; docNo: string; status: InvDocStatus; docDate: unknown }[]>`
        SELECT id, doc_no, status, doc_date FROM inv_docs
        WHERE purchase_order_id = ${id} AND doc_type = 'receipt' AND status NOT IN ('cancelled', 'voided') ORDER BY doc_date, id`;
      const money = await poMoney(db, id);
      const brief = await approvalBrief(db, 'purchase_order', id);
      const lineCount = Number(po.lineCount);
      return {
        id: Number(po.id),
        docNo: String(po.docNo),
        status: po.status as PoStatus,
        supplierName: String(po.supplierName),
        summary: lineCount > 3 ? `${String(po.summary)} 等 ${lineCount} 项` : String(po.summary),
        lineCount,
        receivedLines,
        totalCents: Number(po.totalCents),
        orderDate: day(po.orderDate)!,
        expectedDate: day(po.expectedDate),
        createdAt: iso(po.createdAt)!,
        createdByName: String(po.createdByName),
        submittedAt: iso(po.submittedAt),
        approvedAt: iso(po.approvedAt),
        approvedByName: (po.approvedByName as string | null) ?? null,
        returnedReason: (po.returnedReason as string | null) ?? null,
        closeReason: (po.closeReason as string | null) ?? null,
        approval: brief
          ? {
              requestId: brief.requestId,
              status: brief.status,
              currentLevel: brief.currentLevel,
              levels: brief.levels,
              currentLabel: brief.stepLabels[brief.currentLevel - 1] ?? '负责人',
              levelStartedAt: iso(brief.levelStartedAt)!,
              overdue: brief.overdue,
            }
          : null,
        receiving,
        receivedCents: money.receivedCents,
        paidCents: money.paidCents,
        unpaidCents: money.unpaidCents,
        receipts: receipts.map((r) => ({ id: Number(r.id), docNo: r.docNo, status: r.status, docDate: day(r.docDate)! })),
        settlement: await poSettlement(db, id),
        unclaimedLines: Number(po.unclaimedLines),
        claimsPending: Number(po.claimsPending),
        requestIds: ids(po.requestIds),
        sourcingId: po.sourcingEventId == null ? null : Number(po.sourcingEventId),
      };
    })();
    c.pos.set(id, p);
  }
  return p;
}

function sourcingFact(c: Ctx, id: number) {
  let p = c.sourcings.get(id);
  if (!p) {
    p = (async () => {
      const { db } = c;
      const [e] = await db<Record<string, unknown>[]>`
        SELECT e.id, e.doc_no, e.status, e.title, e.created_at, cb.display_name AS created_by_name, e.single_source, e.awarded_at,
               ab.display_name AS awarded_by_name,
               (SELECT sp.name FROM sourcing_quotes q JOIN suppliers sp ON sp.id = q.supplier_id WHERE q.id = e.awarded_quote_id) AS awarded_supplier_name,
               (SELECT count(*)::int FROM sourcing_quotes q WHERE q.event_id = e.id AND q.status = 'active') AS active_quotes,
               (SELECT max(q.created_at) FROM sourcing_quotes q WHERE q.event_id = e.id AND q.status = 'active') AS last_quote_at,
               (SELECT min(q.goods_cents + q.freight_cents) FROM sourcing_quotes q WHERE q.event_id = e.id AND q.status = 'active')::float8 AS lowest_landed_cents,
               coalesce((SELECT array_agg(DISTINCT rl.request_id ORDER BY rl.request_id) FROM sourcing_lines sl
                         JOIN sourcing_line_requests sr ON sr.sourcing_line_id = sl.id JOIN purchase_request_lines rl ON rl.id = sr.request_line_id
                         WHERE sl.event_id = e.id), '{}') AS request_ids,
               coalesce((SELECT array_agg(po.id ORDER BY po.id) FROM purchase_orders po WHERE po.sourcing_event_id = e.id AND po.status <> 'cancelled'), '{}') AS po_ids
        FROM sourcing_events e JOIN staff cb ON cb.id = e.created_by LEFT JOIN staff ab ON ab.id = e.awarded_by
        WHERE e.id = ${id}`;
      if (!e) return null;
      return {
        id: Number(e.id),
        docNo: String(e.docNo),
        status: e.status as SourcingStatus,
        title: String(e.title),
        createdAt: iso(e.createdAt)!,
        createdByName: String(e.createdByName),
        activeQuotes: Number(e.activeQuotes),
        lastQuoteAt: iso(e.lastQuoteAt),
        lowestLandedCents: e.lowestLandedCents == null ? null : Math.round(Number(e.lowestLandedCents)),
        singleSource: Boolean(e.singleSource),
        awardedAt: iso(e.awardedAt),
        awardedByName: (e.awardedByName as string | null) ?? null,
        awardedSupplierName: (e.awardedSupplierName as string | null) ?? null,
        requestIds: ids(e.requestIds),
        poIds: ids(e.poIds),
      };
    })();
    c.sourcings.set(id, p);
  }
  return p;
}

const present = <T>(xs: (T | null)[]): T[] => xs.filter((x): x is T => x !== null);
/** 几张询价单里用哪张：还在询价的优先，再是最近的 */
const pickSourcing = (xs: FlowSourcingFact[]) => xs.find((s) => s.status === 'open') ?? xs[xs.length - 1] ?? null;

async function factsFor(c: Ctx, kind: FlowAnchorKind, id: number): Promise<FlowFacts | null> {
  const base = { rules: c.rules, now: c.now, today: c.today, purchasing: c.purchasing };
  if (kind === 'request') {
    const r = await requestFact(c, id);
    if (!r) return null;
    const pos = present(await Promise.all(r.poIds.slice(0, MAX_POS_PER_FLOW).map((p) => poFact(c, p))));
    const sourcingIds = [...new Set([...r.sourcingIds, ...pos.map((p) => p.sourcingId).filter((x): x is number => x !== null)])];
    const sourcing = pickSourcing(present(await Promise.all(sourcingIds.map((s) => sourcingFact(c, s)))).filter((s) => s.status !== 'cancelled'));
    return { ...base, anchor: { kind, id, docNo: r.docNo }, requests: [r], sourcing, pos };
  }
  if (kind === 'po') {
    const p = await poFact(c, id);
    if (!p) return null;
    const requests = present(await Promise.all(p.requestIds.map((r) => requestFact(c, r))));
    const sourcing = p.sourcingId ? await sourcingFact(c, p.sourcingId) : null;
    return { ...base, anchor: { kind, id, docNo: p.docNo }, requests, sourcing, pos: [p] };
  }
  const s = await sourcingFact(c, id);
  if (!s) return null;
  const requests = present(await Promise.all(s.requestIds.map((r) => requestFact(c, r))));
  const pos = present(await Promise.all(s.poIds.slice(0, MAX_POS_PER_FLOW).map((p) => poFact(c, p))));
  return { ...base, anchor: { kind, id, docNo: s.docNo }, requests, sourcing: s, pos };
}

/** 看的人看不看得到这张需求单（与需求单详情同一条规矩：审核的人看全部；别人看本部门的与自己提的） */
async function requestVisible(db: Db, actor: Actor, r: { departmentId: number; requesterId: number; deptHeadId: number | null }): Promise<boolean> {
  if (can(actor, 'request.review') || r.requesterId === actor.id || r.deptHeadId === actor.id) return true;
  // 部门主管（8.0.17）：我当主管的部门的需求单
  const [head] = await db<{ id: number }[]>`SELECT id FROM departments WHERE id = ${r.departmentId} AND head_id = ${actor.id}`;
  if (head) return true;
  if (!can(actor, 'request.create')) return false;
  const [me] = await db<{ departmentId: number | null }[]>`SELECT department_id FROM staff WHERE id = ${actor.id}`;
  return me?.departmentId != null && Number(me.departmentId) === r.departmentId;
}

// ───────────────────────── 一条、列表 ─────────────────────────

export async function getPurchaseFlow(db: Db, actor: Actor, kind: FlowAnchorKind, id: number, timezone: string): Promise<PurchaseFlow> {
  const c = await context(db, actor, timezone);
  const missing = () => notFound(kind === 'request' ? '需求单不存在' : kind === 'po' ? '采购单不存在（或已撤回）' : '询价单不存在');
  if (kind !== 'request' && !c.purchasing) throw forbidden('没有查看采购单的权限');
  if (kind === 'request' && !c.purchasing) {
    const r = await requestFact(c, id);
    if (!r || !(await requestVisible(db, actor, r))) throw missing();
  }
  const facts = await factsFor(c, kind, id);
  if (!facts) throw missing();
  return buildPurchaseFlow(facts);
}

/**
 * 进行中的流程（最多 FLOW_LIST_MAX 条，卡住的在前、再按最近动过的在前）：
 *   · 没结束的采购单（草稿、待确认、退回，与近 FLOW_LIST_DAYS 天已确认的），各一条；
 *   · 还有行没下单的需求单（待审核、退回，与近 FLOW_LIST_DAYS 天已通过的），各一条——需求已经全部转成采购单的，由采购单那一条代表；
 *   · 没有需求单、也还没转采购单的询价单，各一条。
 * 全部做完的不列。
 */
export async function listPurchaseFlows(db: Db, actor: Actor, timezone: string): Promise<PurchaseFlowList> {
  const c = await context(db, actor, timezone);
  if (!c.purchasing) throw forbidden('没有查看采购单的权限');
  const since = shiftDate(c.today, -FLOW_LIST_DAYS);
  const cap = FLOW_LIST_MAX + 1;
  const poRows = await db<{ id: number }[]>`
    SELECT id FROM purchase_orders
    WHERE status IN ('draft', 'submitted', 'returned') OR (status = 'approved' AND order_date >= ${since}::date)
    ORDER BY id DESC LIMIT ${cap}`;
  const requestRows = await db<{ id: number }[]>`
    SELECT r.id FROM purchase_requests r
    WHERE r.status IN ('submitted', 'returned')
       OR (r.status = 'approved' AND (r.submitted_at AT TIME ZONE ${timezone})::date >= ${since}::date
           AND EXISTS (SELECT 1 FROM purchase_request_lines l WHERE l.request_id = r.id AND NOT ${ORDERED(db)}))
    ORDER BY r.id DESC LIMIT ${cap}`;
  const sourcingRows = await db<{ id: number }[]>`
    SELECT e.id FROM sourcing_events e
    WHERE e.status IN ('open', 'awarded') AND (e.created_at AT TIME ZONE ${timezone})::date >= ${since}::date
      AND NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.sourcing_event_id = e.id AND po.status <> 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM sourcing_lines sl JOIN sourcing_line_requests sr ON sr.sourcing_line_id = sl.id WHERE sl.event_id = e.id)
    ORDER BY e.id DESC LIMIT ${cap}`;
  const anchors: { kind: FlowAnchorKind; id: number }[] = [
    ...requestRows.slice(0, FLOW_LIST_MAX).map((r) => ({ kind: 'request' as const, id: Number(r.id) })),
    ...sourcingRows.slice(0, FLOW_LIST_MAX).map((r) => ({ kind: 'sourcing' as const, id: Number(r.id) })),
    ...poRows.slice(0, FLOW_LIST_MAX).map((r) => ({ kind: 'po' as const, id: Number(r.id) })),
  ];
  const flows: PurchaseFlow[] = [];
  // 一条一条取（同一个连接上排着；同一张单在这一次请求里只取一次）
  for (const a of anchors) {
    const facts = await factsFor(c, a.kind, a.id);
    if (!facts) continue;
    const flow = buildPurchaseFlow(facts);
    if (!flow.end) flows.push(flow);
  }
  const time = (f: PurchaseFlow) => (f.movedAt ? Date.parse(f.movedAt.length === 10 ? `${f.movedAt}T00:00:00Z` : f.movedAt) : 0);
  flows.sort((a, b) => Number(b.alert) - Number(a.alert) || time(b) - time(a));
  const truncated = flows.length > FLOW_LIST_MAX || poRows.length > FLOW_LIST_MAX || requestRows.length > FLOW_LIST_MAX || sourcingRows.length > FLOW_LIST_MAX;
  return { flows: flows.slice(0, FLOW_LIST_MAX), rules: c.rules, truncated };
}

// ───────────────────────── 路由 ─────────────────────────

const OneQuery = z.object({ kind: z.enum(['request', 'po', 'sourcing'], '缺少单据类型'), id: z.coerce.number().int().positive() });

export function registerPurchaseFlowRoutes(app: FastifyInstance, { sql, config }: Deps) {
  // 一条：有「查看库存」的都能看；只有需求单权限的只能看自己看得到的需求单（在函数里核对）
  app.get('/api/purchase-flow/one', { preHandler: guardAny('inventory.read', 'request.create', 'request.review') }, async (req) => {
    const q = parse(OneQuery, req.query);
    return readSnapshot(sql, (tx) => getPurchaseFlow(tx, req.actor, q.kind, q.id, config.timezone));
  });
  app.get('/api/purchase-flow/list', { preHandler: guardAny('inventory.read') }, async (req) => readSnapshot(sql, (tx) => listPurchaseFlows(tx, req.actor, config.timezone)));
}
