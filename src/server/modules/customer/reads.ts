import { z } from "zod";
import { businessDateOf } from "@shared/business-date";
import { can } from "@shared/permissions";
import {
  CHECKOUT_METHOD_LABELS,
  isCashLike,
  type CheckoutMethod,
} from "@shared/checkout";
import { SECTION_TYPES } from "@shared/member-records";
import type * as C from "@shared/customer";
import { customerAmountGrade, CUSTOMER_RATING_RULES } from "@shared/customer-ratings";
import type { Db, Fragment } from "../../db";
import type { Actor } from "../../lib/context";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { parse } from "../../lib/validate";
import { loadSettings } from "../settings";
import { memberFamily } from "../membership";
import {
  canonicalMemberId,
  nativeMemberSummaries,
  nativeMemberSummary,
} from "../concierge/native-links";
import { checkoutOrderDetail } from "../orders";
import { getConsumption } from "../wallet";
import { getBoard } from "../frontdesk/visits";

const LIMIT = 50;
const Month = z
  .string()
  .regex(
    /^(19\d\d|[2-9]\d{3})-(0[1-9]|1[0-2])$/,
    "月份应为YYYY-MM（1900年起）",
  );
const Query = z.object({
  day: z.iso.date().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  month: Month.optional(),
  q: z
    .string()
    .trim()
    .max(60)
    .refine((v) => !v.includes("\0"), "查找内容含无效字符")
    .default(""),
  managerId: z.coerce.number().int().positive().optional(),
  status: z.string().max(20).default("all"),
  amountBand: z.enum(["all", "lt1k", "1k-3k", "3k-5k", "5k-10k", "gte10k"]).default("all"),
  period: z.enum(["today", "month", "lastMonthSame"]).default("month"),
  scope: z.enum(["department", "group", "staff"]).default("department"),
  groupName: z.enum(["A组", "B组"]).optional(),
  method: z.string().max(30).optional(),
  hour: z.coerce.number().int().min(0).max(23).optional(),
  visitScope: z.enum(["workbench", "arrivals"]).default("workbench"),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  timelineOffset: z.coerce.number().int().min(0).max(1000000).default(0),
  unbound: z.enum(["0", "1"]).optional(),
  timelineMonth: Month.optional(),
  timelineSection: z.enum(["all", "recharge", "consume"]).default("all"),
});
type Q = z.infer<typeof Query>;
type Row = Record<string, any>;
const n = (v: unknown) => Number(v ?? 0);
const staff = (db: Db, expr: string) =>
  db`(SELECT jsonb_build_object('id',s.id,'name',s.display_name,'active',s.active) FROM staff s WHERE s.id=${db(expr)})`;
const person = (db: Db, expr: string) =>
  db`(SELECT jsonb_build_object('id',m.id,'memberNo',m.member_no,'name',m.name,'phone',m.phone,'status',m.status) FROM members m WHERE m.id=${db(expr)})`;
const family = (db: Db) => db`WITH RECURSIVE family AS (
 SELECT id AS root,id FROM members WHERE merged_into_id IS NULL
 UNION SELECT f.root,m.id FROM members m JOIN family f ON m.merged_into_id=f.id)`;
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
function page<T>(rows: T[], q: Q, meta: C.CustomerMeta): C.CustomerPage<T> {
  return {
    ...meta,
    rows: rows.slice(q.offset, q.offset + LIMIT),
    offset: q.offset,
    limit: LIMIT,
    hasMore: rows.length > q.offset + LIMIT,
    filteredTotal: rows.length,
  };
}
export async function customerMeta(
  db: Db,
  actor: Actor,
  timezone: string,
  at = new Date(),
): Promise<C.CustomerMeta> {
  const settings = await loadSettings(db);
  return {
    serverTime: at.toISOString(),
    timezone,
    businessDate: businessDateOf(at, timezone, settings.businessDayStartHour),
    capabilities: {
      manage: can(actor, "customer.manage"),
      operate: can(actor, "customer.operate"),
      scope: can(actor, "customer.manage") ? "all" : "self",
      actorId: actor.id,
      financialReadToday: can(actor, "ledger.readToday"),
      financialReadHistory: can(actor, "ledger.readHistory"),
      financialScope: can(actor, "customer.manage") ? "all" : "self",
      memberFinancialTimeline: can(actor, "member.read"),
    },
  };
}
function scope(actor: Actor, q: Q): number | null {
  if (can(actor, "customer.manage")) return q.managerId ?? null;
  if (q.managerId !== undefined && q.managerId !== actor.id)
    throw forbidden("当前账号只能查看本人的业绩和充值归属");
  return actor.id;
}
function dates(q: Q, meta: C.CustomerMeta) {
  if (q.day && (q.from || q.to)) throw badRequest("营业日与起止日期请只选一种");
  const from = q.from ?? q.day ?? meta.businessDate,
    to = q.to ?? q.day ?? from;
  if (from > to) throw badRequest("开始日期不能晚于结束日期");
  return { from, to };
}
async function monthBounds(db: Db, month: string) {
  const [r] = await db`SELECT ${month + "-01"}::date::text AS first,
    ((${month + "-01"}::date+interval '1 month')::date-1)::text AS last`;
  return { from: String(r!.first), to: String(r!.last) };
}
async function targetPeriod(db: Db, q: Q, meta: C.CustomerMeta) {
  const month = q.month ?? q.day?.slice(0, 7) ?? meta.businessDate.slice(0, 7);
  const range = await monthBounds(db, month);
  const day = q.day ?? (month === meta.businessDate.slice(0, 7) ? meta.businessDate : range.to);
  if (day.slice(0, 7) !== month) throw badRequest("所选营业日须属于目标月份");
  const [prior] = await db`SELECT (${range.from}::date-interval '1 month')::date::text AS first,
    (${day}::date-interval '1 month')::date::text AS last`;
  return { month, day, range, previous: { from: String(prior!.first), to: String(prior!.last) } };
}
const groupName = (value: unknown): C.CustomerGroupName | null =>
  value === "A组" || value === "B组" ? value : null;
function visibleCredit(db: Db, actor: Actor, alias = "cr") {
  return can(actor, "customer.manage")
    ? db`true`
    : db`${db(alias + ".seller_staff_id")}=${actor.id}
    AND (${db(alias + ".status")}='verified' OR ${db(alias + ".claimed_by")}=${actor.id})`;
}
type FinancialAccess = { today: string; history: boolean; operatorId: number | null };
function financialAccess(actor: Actor, today: string, day = today): FinancialAccess {
  if (!can(actor, "ledger.readToday")) throw forbidden("当前账号没有查看消费原单的流水权限");
  const history = can(actor, "ledger.readHistory");
  if (day !== today && !history) throw forbidden("当前账号只能查看本营业日的消费原单");
  return { today, history, operatorId: can(actor, "customer.manage") ? null : actor.id };
}
function visibleFinancialSource(db: Db, actor: Actor, today: string, alias: string) {
  return db`${can(actor, "ledger.readToday")}
    AND (${can(actor, "ledger.readHistory")} OR ${db(alias + ".business_date")}=${today}::date)
    AND (${can(actor, "customer.manage")} OR ${db(alias + ".operator_id")}=${actor.id})`;
}
async function financialDocumentAccess(db: Db, actor: Actor, today: string, id: number, source: "checkout" | "consumption") {
  financialAccess(actor, today);
  const [document] = source === "checkout"
    ? await db`SELECT business_date::text AS day,operator_id FROM checkouts WHERE id=${id}`
    : await db`SELECT business_date::text AS day,operator_id FROM consumptions WHERE id=${id} AND checkout_id IS NULL`;
  if (!document) throw notFound("消费原单不存在");
  const access = financialAccess(actor, today, String(document.day));
  if (access.operatorId !== null && n(document.operatorId) !== access.operatorId)
    throw notFound("消费原单不存在或不在本人的经办范围");
  return access;
}

/** Signed performance events use their actual business date; they never rewrite native amounts. */
async function performance(
  db: Db,
  from: string,
  to: string,
  managerId: number | null,
) {
  return db<Row[]>`WITH events AS (
    SELECT cr.seller_staff_id AS staff_id,r.business_date AS day,r.paid_amount AS amount
    FROM recharges r JOIN customer_recharge_credits cr ON cr.recharge_id=r.id
    WHERE cr.status='verified' AND cr.owner_department='customer'
    UNION ALL
    SELECT cr.seller_staff_id,mr.business_date,-l.amount FROM member_refund_lines l
    JOIN member_refunds mr ON mr.id=l.refund_id JOIN customer_recharge_credits cr ON cr.recharge_id=l.recharge_id
    WHERE l.source='recharge' AND cr.status='verified' AND cr.owner_department='customer'
  ) SELECT e.staff_id,e.day::text AS day,t.group_name,sum(e.amount)::bigint AS amount FROM events e
    LEFT JOIN customer_month_targets t ON t.staff_id=e.staff_id AND t.month=date_trunc('month',e.day)::date
    WHERE e.day BETWEEN ${from} AND ${to} AND (${managerId}::bigint IS NULL OR e.staff_id=${managerId}) GROUP BY e.staff_id,e.day,t.group_name`;
}

/** Signed native events; the customer extension only supplies verified ownership. */
export async function customerPerformance(
  db: Db, actor: Actor, timezone: string, raw: unknown, at = new Date(),
): Promise<C.CustomerPerformancePage> {
  const q = parse(Query, raw), meta = await customerMeta(db, actor, timezone, at);
  if (!can(actor, "customer.manage") && (q.scope !== "staff" || (q.managerId !== undefined && q.managerId !== actor.id)))
    throw forbidden("当前账号只能查看本人的已核业绩原单明细");
  if (q.scope === "group" && !q.groupName) throw badRequest("请选择A组或B组");
  if (q.scope === "staff" && !q.managerId && can(actor, "customer.manage")) throw badRequest("请选择客户经理");
  const p = await targetPeriod(db, q, meta),
    range = q.period === "today" ? { from: p.day, to: p.day }
      : q.period === "lastMonthSame" ? p.previous : { from: p.range.from, to: p.day },
    managerId = q.scope === "staff" ? (q.managerId ?? actor.id) : null;
  const facts = await db<Row[]>`${family(db)}, events AS (
    SELECT r.id,'recharge'::text AS event_type,r.doc_no,r.created_at AS occurred_at,r.business_date,r.paid_amount AS amount_cents,
      r.id AS recharge_id,NULL::bigint AS refund_id,r.member_id,cr.seller_staff_id
    FROM recharges r JOIN customer_recharge_credits cr ON cr.recharge_id=r.id
    WHERE cr.status='verified' AND cr.owner_department='customer'
    UNION ALL
    SELECT l.id,'refund',mr.refund_no,mr.created_at,mr.business_date,-l.amount,l.recharge_id,mr.id,r.member_id,cr.seller_staff_id
    FROM member_refund_lines l JOIN member_refunds mr ON mr.id=l.refund_id JOIN recharges r ON r.id=l.recharge_id
    JOIN customer_recharge_credits cr ON cr.recharge_id=r.id
    WHERE l.source='recharge' AND cr.status='verified' AND cr.owner_department='customer'
  ) SELECT e.id,e.event_type,e.doc_no,e.occurred_at,e.business_date::text AS business_date,e.amount_cents,e.recharge_id,e.refund_id,
    ${person(db, "f.root")} AS member,${staff(db, "e.seller_staff_id")} AS manager,t.group_name
    FROM events e JOIN family f ON f.id=e.member_id
    LEFT JOIN customer_month_targets t ON t.staff_id=e.seller_staff_id AND t.month=date_trunc('month',e.business_date)::date
    WHERE e.business_date BETWEEN ${range.from} AND ${range.to}
    AND (${managerId}::bigint IS NULL OR e.seller_staff_id=${managerId})
    AND (${q.scope !== "group"} OR t.group_name=${q.groupName ?? null})
    ORDER BY e.occurred_at DESC,e.event_type,e.id DESC`;
  const rows: C.CustomerPerformanceEvent[] = facts.map((r) => ({
    id: n(r.id), eventType: r.eventType, docNo: r.docNo, occurredAt: r.occurredAt,
    businessDate: r.businessDate, amountCents: n(r.amountCents), rechargeId: n(r.rechargeId),
    refundId: r.refundId == null ? null : n(r.refundId), member: r.member, manager: r.manager, groupName: groupName(r.groupName),
  }));
  return {
    ...page(rows, q, meta), period: q.period, scope: q.scope, asOfDay: p.day, ...range,
    groupName: q.scope === "group" ? q.groupName! : null, managerId,
    totals: rows.reduce((s, r) => ({
      rechargeCents: s.rechargeCents + (r.eventType === "recharge" ? r.amountCents : 0),
      refundCents: s.refundCents - (r.eventType === "refund" ? r.amountCents : 0),
      netCents: s.netCents + r.amountCents,
    }), { rechargeCents: 0, refundCents: 0, netCents: 0 }),
  };
}

async function rechargeRows(
  db: Db,
  actor: Actor,
  timezone: string,
  q: Q,
  from: string,
  to: string,
  onlyId: number | null = null,
): Promise<C.CustomerRechargeRow[]> {
  if (
    !["all", "unclaimed", "pending", "verified", "rejected", "voided"].includes(
      q.status,
    )
  )
    throw badRequest("充值归属状态不正确");
  const managerId = scope(actor, q);
  const rows = await db<
    Row[]
  >`${family(db)} SELECT r.id,r.doc_no,r.created_at,r.business_date::text AS business_date,
    r.paid_amount,r.bonus_amount,r.payment_method,r.channel,${staff(db, "r.operator_id")} AS operator,
    ${person(db, "f.root")} AS member,${staff(db, "b.maintainer_staff_id")} AS maintainer,
    (SELECT coalesce(sum(l.amount),0) FROM member_refund_lines l WHERE l.recharge_id=r.id AND l.source='recharge') AS refunded,
    cr.id AS credit_id,cr.version,cr.status,cr.first_kind,cr.owner_department,cr.reason,cr.claimed_at,cr.reviewed_at,
    ${staff(db, "cr.seller_staff_id")} AS seller,${staff(db, "cr.maintainer_at_event")} AS historical_owner
    FROM recharges r JOIN family f ON f.id=r.member_id JOIN members m ON m.id=f.root
    LEFT JOIN customer_bindings b ON b.member_id=f.root LEFT JOIN customer_recharge_credits cr ON cr.recharge_id=r.id
    WHERE ${visibleCredit(db, actor)} AND (${onlyId}::bigint IS NULL OR r.id=${onlyId})
      AND (${onlyId}::bigint IS NOT NULL OR r.business_date BETWEEN ${from} AND ${to})
      AND (${managerId}::bigint IS NULL OR cr.seller_staff_id=${managerId})
      AND (${q.status}='all' OR coalesce(cr.status,'unclaimed')=${q.status})
      AND (${q.hour ?? null}::int IS NULL OR extract(hour FROM r.created_at AT TIME ZONE ${timezone})=${q.hour ?? null})
      AND (${!q.q} OR r.doc_no ILIKE ${like(q.q)} OR m.name ILIKE ${like(q.q)} OR m.phone LIKE ${like(q.q)} OR m.member_no ILIKE ${like(q.q)})
    ORDER BY r.created_at DESC,r.id DESC`;
  return rows.map((r) => ({
    id: n(r.id),
    docNo: r.docNo,
    member: r.member,
    occurredAt: r.createdAt,
    businessDate: r.businessDate,
    paidCents: n(r.paidAmount),
    bonusCents: n(r.bonusAmount),
    refundedCents: n(r.refunded),
    netPaidCents: n(r.paidAmount) - n(r.refunded),
    paymentMethod: r.paymentMethod,
    channel: r.channel,
    operator: r.operator,
    maintainer: r.maintainer,
    credit: {
      id: r.creditId == null ? null : n(r.creditId),
      version: n(r.version),
      status: r.status ?? "unclaimed",
      rechargeKind: r.firstKind ?? "unknown",
      ownerDepartment: r.ownerDepartment ?? "unknown",
      claimedSeller: r.seller,
      verifiedSeller: r.status === "verified" ? r.seller : null,
      receptionist: null,
      ownerAtTrade: r.historicalOwner,
      reason: r.reason ?? "",
      updatedAt: r.reviewedAt ?? r.claimedAt ?? null,
    },
  }));
}
export async function customerRecharges(
  db: Db,
  actor: Actor,
  timezone: string,
  raw: unknown,
  at = new Date(),
): Promise<C.CustomerRechargePage> {
  const q = parse(Query, raw),
    meta = await customerMeta(db, actor, timezone, at),
    range = dates(q, meta),
    rows = await rechargeRows(db, actor, timezone, q, range.from, range.to);
  // A row's net is its lifetime net; period performance follows the signed
  // native events instead, including refunds of recharges outside this page.
  const managerId = scope(actor, q);
  const [credit] = await db`${family(db)}, events AS (
    SELECT r.id AS recharge_id,r.business_date,r.created_at AS occurred_at,r.paid_amount AS amount
    FROM recharges r
    UNION ALL
    SELECT l.recharge_id,mr.business_date,mr.created_at,-l.amount
    FROM member_refund_lines l JOIN member_refunds mr ON mr.id=l.refund_id WHERE l.source='recharge'
  ) SELECT coalesce(sum(e.amount),0)::bigint AS amount FROM events e
    JOIN recharges r ON r.id=e.recharge_id JOIN family f ON f.id=r.member_id JOIN members m ON m.id=f.root
    JOIN customer_recharge_credits cr ON cr.recharge_id=r.id
    WHERE cr.status='verified' AND cr.owner_department='customer'
      AND (${q.status}='all' OR ${q.status}='verified')
      AND e.business_date BETWEEN ${range.from} AND ${range.to}
      AND (${managerId}::bigint IS NULL OR cr.seller_staff_id=${managerId})
      AND (${q.hour ?? null}::int IS NULL OR extract(hour FROM e.occurred_at AT TIME ZONE ${timezone})=${q.hour ?? null})
      AND (${!q.q} OR r.doc_no ILIKE ${like(q.q)} OR m.name ILIKE ${like(q.q)} OR m.phone LIKE ${like(q.q)} OR m.member_no ILIKE ${like(q.q)})`;
  return {
    ...page(rows, q, meta),
    filters: {
      ...range,
      managerId,
      status: q.status,
      q: q.q,
      hour: q.hour ?? null,
    },
    totals: rows.reduce(
      (s, r) => ({
        paidCents: s.paidCents + r.paidCents,
        bonusCents: s.bonusCents + r.bonusCents,
        refundedCents: s.refundedCents + r.refundedCents,
        netPaidCents: s.netPaidCents + r.netPaidCents,
        verifiedCreditCents: n(credit!.amount),
        pendingPaidCents:
          s.pendingPaidCents +
          (r.credit.status !== "verified" ? r.paidCents : 0),
      }),
      {
        paidCents: 0,
        bonusCents: 0,
        refundedCents: 0,
        netPaidCents: 0,
        verifiedCreditCents: n(credit!.amount),
        pendingPaidCents: 0,
      },
    ),
  };
}
export async function customerRecharge(
  db: Db,
  actor: Actor,
  timezone: string,
  id: number,
  at = new Date(),
): Promise<C.CustomerRechargeDetail> {
  const meta = await customerMeta(db, actor, timezone, at),
    q = parse(Query, {}),
    rows = await rechargeRows(
      db,
      actor,
      timezone,
      q,
      meta.businessDate,
      meta.businessDate,
      id,
    );
  const recharge = rows[0];
  if (!recharge) throw notFound("充值单不存在或不在本人归属范围");
  const refunds = await db<
    Row[]
  >`SELECT mr.id,mr.refund_no AS doc_no,mr.created_at AS occurred_at,mr.business_date::text AS business_date,l.amount AS amount_cents,l.route
    FROM member_refund_lines l JOIN member_refunds mr ON mr.id=l.refund_id WHERE l.recharge_id=${id} AND l.source='recharge' ORDER BY mr.id DESC,l.id`;
  const [r] = await db`SELECT note FROM recharges WHERE id=${id}`;
  return {
    ...meta,
    recharge,
    refunds: refunds.map((r) => ({
      id: n(r.id),
      docNo: r.docNo,
      occurredAt: r.occurredAt,
      businessDate: r.businessDate,
      amountCents: n(r.amountCents),
      route: r.route,
    })),
    note: String(r?.note ?? ""),
  };
}

async function settlementRows(
  db: Db,
  timezone: string,
  q: Q,
  day: string,
  onlyId: number | null,
  access: FinancialAccess,
): Promise<C.CustomerSettlementRow[]> {
  if (q.method && !Object.hasOwn(CHECKOUT_METHOD_LABELS, q.method))
    throw badRequest("付款方式不正确");
  const rows = await db<
    Row[]
  >`SELECT c.id,c.checkout_no AS doc_no,c.created_at,c.business_date::text AS business_date,c.status,c.total_amount,
    ${staff(db, "c.operator_id")} AS operator,
    coalesce((SELECT array_agg(t.code ORDER BY t.code) FROM checkout_bills cb JOIN visits v ON v.id=cb.visit_id JOIN hand_tags t ON t.id=v.tag_id WHERE cb.checkout_id=c.id),'{}') AS tags,
    coalesce((SELECT array_agg(DISTINCT coalesce(m.name,tm.name,nullif(v.guest_label,''),nullif(ts.guest_label,''))) FROM checkout_bills cb
      LEFT JOIN visits v ON v.id=cb.visit_id LEFT JOIN members m ON m.id=v.member_id LEFT JOIN table_sessions ts ON ts.id=cb.table_session_id LEFT JOIN members tm ON tm.id=ts.member_id WHERE cb.checkout_id=c.id),'{}') AS guests,
    coalesce((SELECT array_agg(DISTINCT method) FROM checkout_payments WHERE checkout_id=c.id),'{}') AS methods,
    (SELECT coalesce(sum(amount),0) FROM checkout_payments WHERE checkout_id=c.id AND method IN ('discount','store_coupon','member_discount')) AS discount,
    (SELECT coalesce(sum(amount),0) FROM checkout_payments WHERE checkout_id=c.id AND method IN ('cash','wechat','alipay','bank_card','other')) AS cash,
    (SELECT coalesce(sum(amount),0) FROM refunds WHERE checkout_id=c.id AND status='completed') AS refunded,
    (c.business_date=${day}::date AND (${q.hour ?? null}::int IS NULL OR extract(hour FROM c.created_at AT TIME ZONE ${timezone})=${q.hour ?? null})) AS created_today,
    (c.void_business_date=${day}::date AND (${q.hour ?? null}::int IS NULL OR extract(hour FROM c.voided_at AT TIME ZONE ${timezone})=${q.hour ?? null})) AS voided_today,
    (SELECT coalesce(sum(amount),0) FROM refunds WHERE checkout_id=c.id AND status='completed' AND business_date=${day}
      AND (${q.hour ?? null}::int IS NULL OR extract(hour FROM created_at AT TIME ZONE ${timezone})=${q.hour ?? null})) AS refunded_today
    FROM checkouts c WHERE ((${onlyId}::bigint IS NOT NULL AND c.id=${onlyId}) OR (${onlyId}::bigint IS NULL
      AND (c.business_date=${day} OR c.void_business_date=${day} OR EXISTS(SELECT 1 FROM refunds rf WHERE rf.checkout_id=c.id AND rf.business_date=${day} AND rf.status='completed'))))
      AND (${access.operatorId}::bigint IS NULL OR c.operator_id=${access.operatorId})
      AND (${access.history} OR c.business_date=${access.today}::date)
    ORDER BY c.created_at DESC,c.id DESC`;
  return rows
    .filter(
      (r) =>
        (!q.method || r.methods.includes(q.method)) &&
        (!q.q ||
          [r.docNo, ...r.tags, ...r.guests]
            .filter(Boolean)
            .some((s: unknown) =>
              String(s).toLowerCase().includes(q.q.toLowerCase()),
            )),
    )
    .filter(
      (r) =>
        q.hour === undefined ||
        r.createdToday ||
        r.voidedToday ||
        n(r.refundedToday) > 0,
    )
    .map((r) => {
      const sign =
          onlyId !== null
            ? r.status === "completed"
              ? 1
              : 0
            : (r.createdToday ? 1 : 0) - (r.voidedToday ? 1 : 0),
        refunded = onlyId !== null ? n(r.refunded) : n(r.refundedToday);
      return {
        sourceKind: "checkout" as const,
        principalCents: null,
        bonusCents: null,
        id: n(r.id),
        docNo: r.docNo,
        occurredAt: r.createdAt,
        businessDate: r.businessDate,
        status: r.status,
        amountCents: n(r.totalAmount),
        discountedCents: n(r.discount),
        refundedCents: refunded,
        netCents: sign * (n(r.totalAmount) - n(r.discount)) - refunded,
        cashReceivedCents: sign * n(r.cash) - refunded,
        operator: r.operator,
        tagCodes: r.tags,
        guestNames: r.guests.filter(Boolean),
        methods: r.methods,
      };
    });
}
async function standaloneRows(
  db: Db,
  timezone: string,
  q: Q,
  day: string,
  id: number | null,
  access: FinancialAccess,
): Promise<C.CustomerSettlementRow[]> {
  const rows = await db<
    Row[]
  >`SELECT c.id,c.doc_no,c.created_at,c.business_date::text AS business_date,c.status,c.total_amount,c.principal_amount,c.bonus_amount,
    ${staff(db, "c.operator_id")} AS operator,m.name,
    (c.business_date=${day}::date AND (${q.hour ?? null}::int IS NULL OR extract(hour FROM c.created_at AT TIME ZONE ${timezone})=${q.hour ?? null})) AS created_today,
    (r.business_date=${day}::date AND (${q.hour ?? null}::int IS NULL OR extract(hour FROM r.created_at AT TIME ZONE ${timezone})=${q.hour ?? null})) AS reversed_today FROM consumptions c JOIN members m ON m.id=c.member_id LEFT JOIN reversals r ON r.consumption_id=c.id
    WHERE c.checkout_id IS NULL AND ((${id}::bigint IS NOT NULL AND c.id=${id}) OR (${id}::bigint IS NULL AND (c.business_date=${day} OR r.business_date=${day})))
    AND (${access.operatorId}::bigint IS NULL OR c.operator_id=${access.operatorId})
    AND (${access.history} OR c.business_date=${access.today}::date) ORDER BY c.created_at DESC,c.id DESC`;
  return rows
    .filter(
      (r) =>
        (!q.method || q.method === "wallet") &&
        (!q.q ||
          [r.docNo, r.name].some((s) =>
            String(s).toLowerCase().includes(q.q.toLowerCase()),
          )),
    )
    .filter((r) => q.hour === undefined || r.createdToday || r.reversedToday)
    .map((r) => ({
      sourceKind: "consumption",
      id: n(r.id),
      docNo: r.docNo,
      occurredAt: r.createdAt,
      businessDate: r.businessDate,
      status: r.status,
      amountCents: n(r.totalAmount),
      principalCents: n(r.principalAmount),
      bonusCents: n(r.bonusAmount),
      discountedCents: 0,
      refundedCents:
        id !== null
          ? r.status === "reversed"
            ? n(r.totalAmount)
            : 0
          : r.reversedToday
            ? n(r.totalAmount)
            : 0,
      netCents:
        (id !== null
          ? r.status === "completed"
            ? 1
            : 0
          : (r.createdToday ? 1 : 0) - (r.reversedToday ? 1 : 0)) *
        n(r.totalAmount),
      cashReceivedCents: 0,
      operator: r.operator,
      tagCodes: [],
      guestNames: [r.name],
      methods: ["wallet"],
    }));
}
export async function customerSettlements(
  db: Db,
  actor: Actor,
  timezone: string,
  raw: unknown,
  at = new Date(),
): Promise<C.CustomerSettlementPage> {
  const q = parse(Query, raw),
    meta = await customerMeta(db, actor, timezone, at),
    day = q.day ?? meta.businessDate,
    access = financialAccess(actor, meta.businessDate, day);
  const rows = [
    ...(await settlementRows(db, timezone, q, day, null, access)),
    ...(await standaloneRows(db, timezone, q, day, null, access)),
  ].sort(
    (a, b) =>
      b.occurredAt.localeCompare(a.occurredAt) ||
      b.id - a.id ||
      a.sourceKind.localeCompare(b.sourceKind),
  );
  return {
    ...page(rows, q, meta),
    totals: rows.reduce(
      (s, r) => ({
        amountCents: s.amountCents + r.amountCents,
        discountedCents: s.discountedCents + r.discountedCents,
        refundedCents: s.refundedCents + r.refundedCents,
        netCents: s.netCents + r.netCents,
        cashReceivedCents: s.cashReceivedCents + r.cashReceivedCents,
      }),
      {
        amountCents: 0,
        discountedCents: 0,
        refundedCents: 0,
        netCents: 0,
        cashReceivedCents: 0,
      },
    ),
  };
}
export async function customerSettlement(
  db: Db,
  actor: Actor,
  timezone: string,
  id: number,
  at = new Date(),
  source = "checkout",
): Promise<C.CustomerSettlementDetail> {
  if (!["checkout", "consumption"].includes(source))
    throw badRequest("消费来源不正确");
  const meta = await customerMeta(db, actor, timezone, at),
    access = await financialDocumentAccess(db, actor, meta.businessDate, id, source as "checkout" | "consumption");
  if (source === "consumption") {
    const settlement = (
        await standaloneRows(
          db,
          timezone,
          parse(Query, {}),
          meta.businessDate,
          id,
          access,
        )
      )[0];
    if (!settlement) throw notFound("独立会员扣卡单不存在");
    const consumption = await getConsumption(db, id),
      [p] =
        await db`SELECT ${person(db, "c.member_id")} AS payer FROM consumptions c WHERE c.id=${id}`;
    return {
      ...meta,
      settlement,
      detail: null,
      consumption,
      payments: [
        {
          id,
          method: "wallet",
          amountCents: consumption.totalAmount,
          payer: p!.payer,
          discountMember: null,
          consumptionId: id,
          principalCents: consumption.principalAmount,
          bonusCents: consumption.bonusAmount,
        },
      ],
    };
  }
  const settlement = (
      await settlementRows(
        db,
        timezone,
        parse(Query, {}),
        meta.businessDate,
        id,
        access,
      )
    )[0];
  if (!settlement) throw notFound("结账单不存在");
  const payments = await db<
    Row[]
  >`SELECT p.id,p.method,p.amount AS amount_cents,${person(db, "p.member_id")} AS payer,
    ${person(db, "p.discount_member_id")} AS discount_member,p.consumption_id,c.principal_amount AS principal_cents,c.bonus_amount AS bonus_cents
    FROM checkout_payments p LEFT JOIN consumptions c ON c.id=p.consumption_id WHERE p.checkout_id=${id} ORDER BY p.id`;
  return {
    ...meta,
    settlement,
    detail: await checkoutOrderDetail(db, id),
    consumption: null,
    payments: payments.map((p) => ({
      id: n(p.id),
      method: p.method,
      amountCents: n(p.amountCents),
      payer: p.payer,
      discountMember: p.discountMember,
      consumptionId: p.consumptionId == null ? null : n(p.consumptionId),
      principalCents: p.principalCents == null ? null : n(p.principalCents),
      bonusCents: p.bonusCents == null ? null : n(p.bonusCents),
    })),
  };
}

async function noteRows(db: Db, where: Fragment): Promise<C.CustomerNote[]> {
  return (await db`SELECT sn.id,sn.member_id,sn.visit_id,sn.kind,sn.occurred_at,sn.outcome,sn.content,sn.feedback,sn.next_contact_on::text AS next_contact_on,
    sn.created_at,${staff(db, "sn.staff_id")} AS author FROM customer_service_notes sn WHERE ${where} ORDER BY sn.occurred_at DESC,sn.id DESC`) as C.CustomerNote[];
}
async function visitRows(
  db: Db,
  timezone: string,
  q: Q,
  day: string,
  id: number | null = null,
  arrivalRange: { from: string; to: string } | null = null,
): Promise<C.CustomerVisitRow[]> {
  if (!["all", "open", "left", "settled", "cancelled"].includes(q.status))
    throw badRequest("到店状态不正确");
  const settings = await loadSettings(db);
  // Overview arrivals follow the original check-in business day, including
  // guests who checked out later. The workbench keeps current/departing guests.
  const population = arrivalRange
    ? db`v.business_date BETWEEN ${arrivalRange.from} AND ${arrivalRange.to} AND v.status<>'cancelled'`
    : db`(v.status='open' OR (v.status<>'open' AND coalesce(
        (SELECT c.business_date FROM checkout_bills cbill JOIN checkouts c ON c.id=cbill.checkout_id
          WHERE cbill.visit_id=v.id AND c.status='completed' ORDER BY c.id DESC LIMIT 1),
        ((v.closed_at AT TIME ZONE ${timezone})-make_interval(hours=>${settings.businessDayStartHour}::int))::date)=${day}::date))`;
  // Keep the native bill total: it is updated atomically with native bill facts.
  // Never reconstruct a customer amount from catalog prices or summing display lines.
  const rows = (await db`${family(db)} SELECT v.id,v.visit_no,t.code AS tag_code,v.status,v.checked_in_at,v.closed_at,v.business_date::text AS business_date,v.guest_label,
    ${person(db, "f.root")} AS member,b.amount_cents,b.line_count,${staff(db, "cb.maintainer_staff_id")} AS maintainer,
    (SELECT max(occurred_at) FROM customer_service_notes WHERE visit_id=v.id) AS last_service_at
    FROM visits v JOIN bills b ON b.id=v.bill_id JOIN hand_tags t ON t.id=v.tag_id LEFT JOIN family f ON f.id=v.member_id
    LEFT JOIN members m ON m.id=f.root LEFT JOIN customer_bindings cb ON cb.member_id=f.root
    WHERE (${id}::bigint IS NOT NULL AND v.id=${id}) OR (${id}::bigint IS NULL
      AND ${population}
      AND (${q.status}='all' OR (${q.status}='left' AND v.status<>'open') OR v.status=${q.status}) AND (${q.managerId ?? null}::bigint IS NULL OR cb.maintainer_staff_id=${q.managerId ?? null})
      AND (${q.hour ?? null}::int IS NULL OR extract(hour FROM v.checked_in_at AT TIME ZONE ${timezone})=${q.hour ?? null})
      AND (${!q.q} OR t.code ILIKE ${like(q.q)} OR m.name ILIKE ${like(q.q)} OR m.phone LIKE ${like(q.q)} OR m.member_no ILIKE ${like(q.q)} OR v.guest_label ILIKE ${like(q.q)}))
    ORDER BY (v.status='open') DESC,v.checked_in_at DESC,v.id DESC`) as C.CustomerVisitRow[];
  const bands: Record<C.CustomerAmountBand, [number, number | null]> = {
    all: [0, null], lt1k: [0, 100000], "1k-3k": [100000, 300000], "3k-5k": [300000, 500000], "5k-10k": [500000, 1000000], gte10k: [1000000, null],
  };
  const [minimum, maximum] = bands[q.amountBand];
  return rows.filter((r) => n(r.amountCents) >= minimum && (maximum === null || n(r.amountCents) < maximum));
}
async function liveVisitMembers(db: Db, rows: C.CustomerVisitRow[], timezone: string) {
  const members = new Map<number, C.CustomerVisitMember>();
  for (const r of rows) {
    if (!r.member) continue;
    if (!members.has(r.member.id)) {
      const m = await nativeMemberSummary(db, r.member.id, timezone);
      if (m) members.set(m.id, { id: m.id, memberNo: m.memberNo, name: m.name, phone: m.phone, status: m.status,
        grade: m.grade as C.CustomerVisitMember["grade"], tier: m.tier as C.CustomerVisitMember["tier"], gradeLabel: m.gradeLabel });
    }
    r.member = members.get(r.member.id) ?? null;
  }
  return rows;
}
export async function customerVisits(
  db: Db,
  actor: Actor,
  timezone: string,
  raw: unknown,
  at = new Date(),
): Promise<C.CustomerVisitPage> {
  const q = parse(Query, raw),
    meta = await customerMeta(db, actor, timezone, at),
    arrivalRange = q.visitScope === "arrivals" ? dates(q, meta) : null,
    rows = await visitRows(
      db,
      timezone,
      q,
      q.day ?? meta.businessDate,
      null,
      arrivalRange,
    ),
    board = await getBoard(db);
  return {
    ...page(rows, q, meta),
    rows: await liveVisitMembers(db, rows.slice(q.offset, q.offset + LIMIT), timezone),
    totals: {
      inStoreCount: board.stats.inStore,
      amountCents: board.stats.unsettledCents,
      filteredInStoreCount: rows.filter((r) => r.status === "open").length,
      filteredAmountCents: rows
        .filter((r) => r.status === "open")
        .reduce((s, r) => s + n(r.amountCents), 0),
    },
  };
}
export async function customerVisit(
  db: Db,
  actor: Actor,
  timezone: string,
  id: number,
  at = new Date(),
): Promise<C.CustomerVisitDetail> {
  const meta = await customerMeta(db, actor, timezone, at),
    visit = (
      await visitRows(db, timezone, parse(Query, {}), meta.businessDate, id)
    )[0];
  if (!visit) throw notFound("到店记录不存在");
  const linesReadable = visit.status === "open" || can(actor, "frontdesk.read");
  const lines = linesReadable
    ? await db`SELECT l.id,l.name,l.quantity,l.unit_price AS unit_price_cents,l.amount AS amount_cents,l.status,l.posted_at AS occurred_at
    FROM bill_lines l JOIN visits v ON v.bill_id=l.bill_id WHERE v.id=${id} ORDER BY l.id` : [];
  return {
    ...meta,
    visit: (await liveVisitMembers(db, [visit], timezone))[0]!,
    linesReadable,
    lines: lines.map((l) => ({
      id: n(l.id),
      name: l.name,
      quantity: n(l.quantity),
      unitPriceCents: n(l.unitPriceCents),
      amountCents: n(l.amountCents),
      status: l.status,
      occurredAt: l.occurredAt,
    })),
    notes: await noteRows(db, db`sn.visit_id=${id}`),
  };
}
async function memberProjections(
  db: Db,
  ids: number[],
  timezone: string,
): Promise<C.CustomerMember[]> {
  if (!ids.length) return [];
  const summaries = await nativeMemberSummaries(db, ids, timezone),
    canonicalIds = [...new Set([...summaries.values()].map((s) => s.id))];
  const details = await db`WITH RECURSIVE family AS (
    SELECT id AS root,id FROM members WHERE id=ANY(${canonicalIds}::bigint[])
    UNION SELECT f.root,m.id FROM members m JOIN family f ON m.merged_into_id=f.id
  ), last_visits AS (
    SELECT f.root,max(v.checked_in_at) AS last_visit_at FROM family f JOIN visits v ON v.member_id=f.id
    WHERE v.status<>'cancelled' AND v.checked_in_at<=now() GROUP BY f.root
  ) SELECT m.id,m.created_at,b.version,b.updated_at,${staff(db, "b.maintainer_staff_id")} AS maintainer,v.last_visit_at
    FROM members m LEFT JOIN customer_bindings b ON b.member_id=m.id LEFT JOIN last_visits v ON v.root=m.id
    WHERE m.id=ANY(${canonicalIds}::bigint[])`;
  const byId = new Map(details.map((r) => [n(r.id), r]));
  return ids.map((id) => {
    const s = summaries.get(id), r = s && byId.get(s.id);
    if (!s || !r) throw notFound("会员不存在");
    return {
    id: s.id,
    memberNo: s.memberNo,
    name: s.name,
    phone: s.phone,
    status: s.status,
    grade: s.grade as C.CustomerMember["grade"],
    tier: s.tier as C.CustomerMember["tier"],
    gradeLabel: s.gradeLabel,
    principalCents: s.principalCents,
    bonusCents: s.bonusCents,
    totalCents: s.totalCents,
    createdAt: r.createdAt,
    lastVisitAt: r.lastVisitAt,
    binding: {
      memberId: s.id,
      maintainer: r.maintainer,
      version: n(r.version),
      updatedAt: r.updatedAt ?? null,
    },
    };
  });
}
async function memberProjection(db: Db, id: number, timezone: string): Promise<C.CustomerMember> {
  return (await memberProjections(db, [id], timezone))[0]!;
}
export async function customerMembers(
  db: Db,
  actor: Actor,
  timezone: string,
  raw: unknown,
  at = new Date(),
): Promise<C.CustomerPage<C.CustomerMember>> {
  const q = parse(Query, raw),
    meta = await customerMeta(db, actor, timezone, at);
  const ids =
    await db`${family(db)} SELECT m.id FROM members m LEFT JOIN customer_bindings b ON b.member_id=m.id WHERE m.merged_into_id IS NULL
    AND (${q.unbound !== "1"} OR b.maintainer_staff_id IS NULL)
    AND (${q.managerId ?? null}::bigint IS NULL OR b.maintainer_staff_id=${q.managerId ?? null}) AND (${!q.q} OR EXISTS(
      SELECT 1 FROM family f JOIN members sm ON sm.id=f.id WHERE f.root=m.id AND (sm.name ILIKE ${like(q.q)} OR sm.phone LIKE ${like(q.q)} OR sm.member_no ILIKE ${like(q.q)}
        OR EXISTS(SELECT 1 FROM member_cards mc WHERE mc.member_id=sm.id AND mc.status='active' AND mc.card_no ILIKE ${like(q.q)})))) ORDER BY m.id DESC`;
  const result = page(ids, q, meta),
    rows = await memberProjections(db, result.rows.map((r) => n(r.id)), timezone);
  return { ...result, rows };
}

/** All canonical native members, including those without a concierge service profile. */
export async function customerLowBalances(
  db: Db, actor: Actor, timezone: string, raw: unknown, at = new Date(),
): Promise<C.CustomerLowBalancePage> {
  const q = parse(Query, raw), meta = await customerMeta(db, actor, timezone, at);
  const ids = await db`${family(db)} SELECT m.id,m.principal_balance AS principal_cents,
    greatest(0,m.bonus_balance-(SELECT coalesce(sum(remaining),0) FROM bonus_lots
      WHERE member_id=m.id AND remaining>0 AND expires_at<=now())) AS bonus_cents FROM members m
    LEFT JOIN customer_bindings b ON b.member_id=m.id WHERE m.merged_into_id IS NULL
    AND m.principal_balance+greatest(0,m.bonus_balance-(SELECT coalesce(sum(remaining),0) FROM bonus_lots
      WHERE member_id=m.id AND remaining>0 AND expires_at<=now()))<3000000
    AND (${q.managerId ?? null}::bigint IS NULL OR b.maintainer_staff_id=${q.managerId ?? null})
    AND (${!q.q} OR EXISTS(SELECT 1 FROM family f JOIN members sm ON sm.id=f.id WHERE f.root=m.id
      AND (sm.name ILIKE ${like(q.q)} OR sm.phone LIKE ${like(q.q)} OR sm.member_no ILIKE ${like(q.q)}
      OR EXISTS(SELECT 1 FROM member_cards mc WHERE mc.member_id=sm.id AND mc.status='active' AND mc.card_no ILIKE ${like(q.q)}))))
    ORDER BY m.principal_balance+greatest(0,m.bonus_balance-(SELECT coalesce(sum(remaining),0) FROM bonus_lots
      WHERE member_id=m.id AND remaining>0 AND expires_at<=now())),m.id`;
  const result = page(ids, q, meta),
    rows = await memberProjections(db, result.rows.map((r) => n(r.id)), timezone);
  return {
    ...result, rows, thresholdCents: 3000000,
    totals: ids.reduce<C.CustomerLowBalancePage["totals"]>((s, r) => ({ memberCount: s.memberCount + 1, principalCents: s.principalCents + n(r.principalCents),
      bonusCents: s.bonusCents + n(r.bonusCents), totalCents: s.totalCents + n(r.principalCents) + n(r.bonusCents) }),
      { memberCount: 0, principalCents: 0, bonusCents: 0, totalCents: 0 }),
  };
}
export async function customerMember(
  db: Db,
  actor: Actor,
  timezone: string,
  id: number,
  raw: unknown,
  at = new Date(),
): Promise<C.CustomerMemberDetail> {
  const q = parse(Query, raw),
    meta = await customerMeta(db, actor, timezone, at),
    canonical = await canonicalMemberId(db, id);
  if (canonical === null) throw notFound("会员不存在");
  const ids = await memberFamily(db, canonical),
    timeline = can(actor, "member.read")
      ? await db`SELECT le.id,le.entry_type AS type,le.doc_no,le.created_at AS occurred_at,le.business_date::text AS business_date,
    le.principal_delta AS principal_delta_cents,le.bonus_delta AS bonus_delta_cents,coalesce(s.display_name,'系统') AS operator_name,
    CASE WHEN ${visibleCredit(db, actor)} THEN le.recharge_id ELSE NULL END AS recharge_id,
    CASE WHEN c.checkout_id IS NULL AND ${visibleFinancialSource(db, actor, meta.businessDate, "c")} THEN le.consumption_id ELSE NULL END AS consumption_id,
    CASE WHEN ${visibleFinancialSource(db, actor, meta.businessDate, "checkout")} THEN c.checkout_id ELSE NULL END AS checkout_id
    FROM ledger_entries le LEFT JOIN staff s ON s.id=le.operator_id LEFT JOIN consumptions c ON c.id=le.consumption_id
    LEFT JOIN checkouts checkout ON checkout.id=c.checkout_id
    LEFT JOIN customer_recharge_credits cr ON cr.recharge_id=le.recharge_id WHERE le.member_id IN ${db(ids)}
    AND (${q.timelineMonth ?? null}::text IS NULL OR to_char(le.business_date,'YYYY-MM')=${q.timelineMonth ?? null})
    ${q.timelineSection === "all" ? db`` : db`AND le.entry_type IN ${db([...SECTION_TYPES[q.timelineSection]])}`}
    ORDER BY le.id DESC LIMIT 51 OFFSET ${q.timelineOffset}` : [];
  const requests =
    await db`SELECT br.id,br.member_id,br.version,br.status,br.reason,br.requested_at AS created_at,br.reviewed_at AS resolved_at,br.review_reason,
    ${staff(db, "br.to_staff_id")} AS manager,${staff(db, "br.from_staff_id")} AS from,${staff(db, "br.requested_by")} AS requester,${staff(db, "br.reviewed_by")} AS reviewer
    FROM customer_binding_requests br WHERE br.member_id IN ${db(ids)} ORDER BY br.id DESC`;
  return {
    ...meta,
    member: await memberProjection(db, canonical, timezone),
    timeline: timeline.slice(0, 50) as C.CustomerLedgerEvent[],
    timelineHasMore: timeline.length > 50,
    timelineOffset: q.timelineOffset,
    notes: await noteRows(
      db,
      db`sn.member_id IN ${db(ids)} OR sn.visit_id IN (SELECT id FROM visits WHERE member_id IN ${db(ids)})`,
    ),
    bindingRequests: requests.map((r) => ({
      id: n(r.id),
      memberId: n(r.memberId),
      version: n(r.version),
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      reviewReason: r.reviewReason,
      manager: r.manager,
      from: r.from,
      requester: r.requester,
      reviewer: r.reviewer,
    })),
  };
}

/** Manager discovery queue; never expose a store-wide application pool to individual staff. */
export async function customerBindings(
  db: Db,
  actor: Actor,
  timezone: string,
  raw: unknown,
  at = new Date(),
): Promise<C.CustomerBindingQueue> {
  if (!can(actor, "customer.manage"))
    throw forbidden("只有客户部管理者可以查看绑定审核队列");
  const q = parse(Query, raw),
    meta = await customerMeta(db, actor, timezone, at);
  if (!["pending", "approved", "rejected", "all"].includes(q.status))
    throw badRequest("绑定申请状态不正确");
  const requests = await db<
    Row[]
  >`SELECT br.id,br.member_id,br.version,br.status,br.reason,br.requested_at AS created_at,br.reviewed_at AS resolved_at,br.review_reason,
    ${person(db, "br.member_id")} AS member,${staff(db, "br.to_staff_id")} AS manager,${staff(db, "br.from_staff_id")} AS from,
    ${staff(db, "br.requested_by")} AS requester,${staff(db, "br.reviewed_by")} AS reviewer
    FROM customer_binding_requests br WHERE (${q.status}='all' OR br.status=${q.status}) ORDER BY br.id DESC`;
  return page(
    requests.map((r) => ({
      id: n(r.id),
      memberId: n(r.memberId),
      version: n(r.version),
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      reviewReason: r.reviewReason,
      manager: r.manager,
      from: r.from,
      requester: r.requester,
      reviewer: r.reviewer,
      member: r.member,
    })),
    q,
    meta,
  );
}

export async function customerTargets(
  db: Db,
  actor: Actor,
  timezone: string,
  raw: unknown,
  at = new Date(),
): Promise<C.CustomerTargets> {
  const q = parse(Query, raw), meta = await customerMeta(db, actor, timezone, at),
    managerId = scope(actor, q), p = await targetPeriod(db, q, meta),
    { month, day, range } = p;
  const departmentPerf = await performance(db, range.from, day, null),
    departmentToday = departmentPerf.filter((r) => r.day === day),
    departmentPrevious = await performance(db, p.previous.from, p.previous.to, null);
  const managers = await db`SELECT id,display_name AS name,active FROM staff WHERE
    role='account_manager' OR EXISTS(SELECT 1 FROM customer_month_targets t WHERE t.staff_id=staff.id AND t.month=${month + "-01"})
    OR EXISTS(SELECT 1 FROM customer_recharge_credits cr WHERE cr.seller_staff_id=staff.id) OR id=${managerId} ORDER BY id`;
  const configured = await db`SELECT id,staff_id,target_cents,group_name,version FROM customer_month_targets WHERE month=${month + "-01"}`;
  const department = configured.find((r) => r.staffId == null),
    assigned = configured.filter((r) => r.staffId != null).reduce((s, r) => s + n(r.targetCents), 0),
    sum = (facts: Row[], staffId?: number) => facts.filter((r) => staffId === undefined || n(r.staffId) === staffId).reduce((s, r) => s + n(r.amount), 0);
  const ranked = managers.map((m): C.CustomerTargetRow => {
    const t = configured.find((t) => n(t.staffId) === n(m.id)), done = sum(departmentPerf, n(m.id));
    return {
      manager: m as C.CustomerStaff, targetCents: t ? n(t.targetCents) : null,
      version: n(t?.version), groupName: groupName(t?.groupName), rank: 0,
      verifiedCreditCents: done, todayCreditCents: sum(departmentToday, n(m.id)),
      lastMonthSameDayCents: sum(departmentPrevious, n(m.id)),
      progress: t && n(t.targetCents) > 0 ? done / n(t.targetCents) : null,
      amountGrade: customerAmountGrade(done, "individual"),
    };
  }).sort((a, b) => b.verifiedCreditCents - a.verifiedCreditCents || a.manager.id - b.manager.id);
  ranked.forEach((r, i) => { r.rank = i > 0 && r.verifiedCreditCents === ranked[i - 1]!.verifiedCreditCents ? ranked[i - 1]!.rank : i + 1; });
  const rows = ranked.filter((r) => managerId === null || r.manager.id === managerId);
  const scopedPerf = departmentPerf.filter((r) => managerId === null || n(r.staffId) === managerId);
  const days = await db`SELECT d::date::text AS day FROM generate_series(${range.from}::date,${day}::date,interval '1 day') d`;
  const history = await db`SELECT v.id,CASE WHEN t.staff_id IS NULL THEN 'department' ELSE 'individual' END AS scope,t.staff_id AS manager_id,to_char(t.month,'YYYY-MM') AS month,
    (v.snapshot->>'targetCents')::bigint AS target_cents,v.version,v.created_at FROM customer_target_versions v JOIN customer_month_targets t ON t.id=v.target_id
    WHERE t.month=${month + "-01"} AND (${managerId}::bigint IS NULL OR t.staff_id IS NULL OR t.staff_id=${managerId}) ORDER BY v.id DESC`;
  const done = sum(departmentPerf);
  return {
    ...meta, month, asOfDay: day,
    departmentVerifiedCreditCents: done, departmentTodayCreditCents: sum(departmentToday),
    ungroupedVerifiedCreditCents: sum(departmentPerf.filter((r) => !groupName(r.groupName))),
    ungroupedTodayCreditCents: sum(departmentToday.filter((r) => !groupName(r.groupName))),
    departmentAmountGrade: customerAmountGrade(done, "department"), ratings: CUSTOMER_RATING_RULES,
    departmentLastMonthSameDayCents: sum(departmentPrevious),
    departmentTargetCents: department ? n(department.targetCents) : null,
    assignedTargetCents: assigned, allocationDifferenceCents: department ? n(department.targetCents) - assigned : null,
    departmentVersion: n(department?.version), rows,
    groups: (["A组", "B组"] as const).map((name) => {
      const targets = configured.filter((r) => r.staffId != null && r.groupName === name);
      return {
        groupName: name,
        verifiedCreditCents: sum(departmentPerf.filter((r) => r.groupName === name)),
        todayCreditCents: sum(departmentToday.filter((r) => r.groupName === name)),
        lastMonthSameDayCents: sum(departmentPrevious.filter((r) => r.groupName === name)),
        targetCents: targets.length ? targets.reduce((s, r) => s + n(r.targetCents), 0) : null,
      };
    }),
    daily: days.map((d) => ({ day: d.day, verifiedCreditCents: sum(scopedPerf.filter((r) => r.day === d.day)), targetCents: null })),
    history: history.map((r) => ({ id: n(r.id), scope: r.scope, managerId: r.managerId == null ? null : n(r.managerId),
      month: r.month, targetCents: n(r.targetCents), version: n(r.version), createdAt: r.createdAt })),
  };
}

export async function customerOverview(
  db: Db,
  actor: Actor,
  timezone: string,
  raw: unknown,
  at = new Date(),
): Promise<C.CustomerOverview> {
  const q = parse(Query, raw),
    meta = await customerMeta(db, actor, timezone, at),
    day = q.day ?? meta.businessDate,
    month = q.month ?? day.slice(0, 7),
    managerId = scope(actor, q);
  const rows = await rechargeRows(
      db,
      actor,
      timezone,
      parse(Query, {}),
      day,
      day,
    ),
    targets = await customerTargets(db, actor, timezone, { month, day }, at),
    perf = await performance(db, day, day, managerId);
  const [facts] =
    await db`SELECT (SELECT count(*)::int FROM visits WHERE business_date=${day} AND status<>'cancelled') AS visits,
    (SELECT count(*)::int FROM visits WHERE status='open') AS in_store,
    (SELECT count(*)::int FROM checkouts WHERE business_date=${day}) AS checkouts,
    (SELECT coalesce(sum(paid_amount),0) FROM recharges WHERE business_date=${day}) AS paid,
    (SELECT coalesce(sum(bonus_amount),0) FROM recharges WHERE business_date=${day}) AS bonus,
    (SELECT coalesce(sum(l.amount),0) FROM member_refund_lines l JOIN member_refunds r ON r.id=l.refund_id WHERE r.business_date=${day} AND l.recharge_id IS NULL) AS unmapped`;
  const paymentRows = await db<Row[]>`WITH p AS (
    SELECT p.method,p.amount,c.created_at AS at,'checkout' AS kind FROM checkout_payments p JOIN checkouts c ON c.id=p.checkout_id WHERE c.business_date=${day}
    UNION ALL SELECT p.method,-p.amount,c.voided_at,'checkout' FROM checkout_payments p JOIN checkouts c ON c.id=p.checkout_id WHERE c.void_business_date=${day}
    UNION ALL SELECT p.method,-p.amount,r.created_at,'refund' FROM refund_payments p JOIN refunds r ON r.id=p.refund_id WHERE r.business_date=${day} AND r.status='completed'
    UNION ALL SELECT 'wallet',total_amount,created_at,'standalone' FROM consumptions WHERE checkout_id IS NULL AND business_date=${day}
    UNION ALL SELECT 'wallet',-c.total_amount,r.created_at,'standalone' FROM reversals r JOIN consumptions c ON c.id=r.consumption_id WHERE c.checkout_id IS NULL AND r.business_date=${day}
    UNION ALL SELECT payment_method,paid_amount,created_at,'recharge' FROM recharges WHERE business_date=${day}
  ) SELECT method,kind,extract(hour FROM at AT TIME ZONE ${timezone})::int AS hour,sum(amount)::bigint AS amount FROM p GROUP BY method,kind,hour`;
  const visitsByHour =
    await db`SELECT extract(hour FROM checked_in_at AT TIME ZONE ${timezone})::int AS hour,count(*)::int AS count FROM visits WHERE business_date=${day} AND status<>'cancelled' GROUP BY 1`;
  const methods = [...new Set(paymentRows.map((r) => String(r.method)))],
    payments = methods.map((method) => ({
      method,
      label: CHECKOUT_METHOD_LABELS[method as CheckoutMethod] ?? method,
      settlementCents: paymentRows
        .filter(
          (r) =>
            r.method === method && ["checkout", "standalone"].includes(r.kind),
        )
        .reduce((s, r) => s + n(r.amount), 0),
      rechargeCents: paymentRows
        .filter((r) => r.method === method && r.kind === "recharge")
        .reduce((s, r) => s + n(r.amount), 0),
      refundCents: -paymentRows
        .filter((r) => r.method === method && r.kind === "refund")
        .reduce((s, r) => s + n(r.amount), 0),
    }));
  const discount = (m: string) =>
    ["discount", "store_coupon", "member_discount"].includes(m);
  const due = payments.reduce((s, p) => s + p.settlementCents, 0),
    net = payments
      .filter((p) => !discount(p.method))
      .reduce((s, p) => s + p.settlementCents - p.refundCents, 0),
    cash = payments
      .filter((p) => isCashLike(p.method as CheckoutMethod))
      .reduce((s, p) => s + p.settlementCents - p.refundCents, 0);
  const done = meta.capabilities.manage
      ? targets.departmentVerifiedCreditCents
      : targets.rows.reduce((s, r) => s + r.verifiedCreditCents, 0),
    target = meta.capabilities.manage
      ? targets.departmentTargetCents
      : (targets.rows[0]?.targetCents ?? null);
  return {
    ...meta,
    day,
    month,
    metrics: {
      visitCount: n(facts!.visits),
      inStoreCount: n(facts!.inStore),
      settlementCount: n(facts!.checkouts),
      settlementDueCents: due,
      settlementNetCents: net,
      cashReceivedCents: cash,
      standaloneWalletNetCents: paymentRows
        .filter((r) => r.kind === "standalone")
        .reduce((s, r) => s + n(r.amount), 0),
      rechargePaidCents: n(facts!.paid),
      rechargeBonusCents: n(facts!.bonus),
      verifiedCreditCents: perf.reduce((s, r) => s + n(r.amount), 0),
      pendingPaidCents: rows
        .filter((r) => r.credit.status !== "verified")
        .reduce((s, r) => s + r.paidCents, 0),
      unmappedRefundCents: meta.capabilities.manage ? n(facts!.unmapped) : null,
      monthVerifiedCreditCents: done,
      monthTargetCents: target,
      targetProgress: target && target > 0 ? done / target : null,
    },
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: String(hour).padStart(2, "0") + ":00",
      visitCount: n(visitsByHour.find((v) => n(v.hour) === hour)?.count),
      rechargePaidCents: paymentRows
        .filter((r) => n(r.hour) === hour && r.kind === "recharge")
        .reduce((s, r) => s + n(r.amount), 0),
      settlementNetCents: paymentRows
        .filter(
          (r) =>
            n(r.hour) === hour && r.kind !== "recharge" && !discount(r.method),
        )
        .reduce((s, r) => s + n(r.amount), 0),
    })),
    payments,
    managers: targets.rows,
    performanceBasis: "verified-native-recharge-principal",
  };
}
