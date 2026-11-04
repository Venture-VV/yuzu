// 日结：按营业日汇总充值收款、储值消费、撤销，并核对余额与流水是否一致。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BACKFILL_KIND_LABELS, type BackfillKind } from '@shared/backfill';
import { businessDateOf } from '@shared/business-date';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@shared/labels';
import { formatAmount, formatYuan } from '@shared/money';
import { businessBreakdown, CHECKOUT_METHOD_LABELS, COUPON_PLATFORM_LABELS } from '@shared/checkout';
import type { BusinessTotals, SettlementAnomaly, SettlementCheck, SettlementDeposits, SettlementSummary, SettlementTotals } from '@shared/types';
import { readSnapshot, type Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { unprocessable } from '../lib/errors';
import { toCsv, CSV_TYPE, attachment } from '../lib/csv';
import { dateSchema, parse } from '../lib/validate';
import { resolveReadableDate } from './ledger';
import { loadFrontdeskRules } from './frontdesk/common';
import { loadSettings } from './settings';

type Pair = { principal: number; bonus: number };

async function computeTotals(db: Db, date: string): Promise<SettlementTotals> {
  const [rc] = await db<{ count: number; paid: number; bonus: number }[]>`
    SELECT count(*) AS count, coalesce(sum(paid_amount), 0) AS paid, coalesce(sum(bonus_amount), 0) AS bonus
    FROM recharges WHERE business_date = ${date}`;
  const byMethod = await db<{ method: PaymentMethod; count: number; amount: number }[]>`
    SELECT payment_method AS method, count(*) AS count, sum(paid_amount) AS amount
    FROM recharges WHERE business_date = ${date} GROUP BY payment_method ORDER BY payment_method`;
  const [cs] = await db<SettlementTotals['consume'][]>`
    SELECT count(*) AS count, coalesce(sum(total_amount), 0) AS total,
           coalesce(sum(principal_amount), 0) AS principal, coalesce(sum(bonus_amount), 0) AS bonus,
           count(*) FILTER (WHERE status = 'reversed') AS reversed_count
    FROM consumptions WHERE business_date = ${date}`;
  const [rv] = await db<SettlementTotals['reversal'][]>`
    SELECT count(*) AS count, coalesce(sum(r.principal_amount), 0) AS principal, coalesce(sum(r.bonus_amount), 0) AS bonus,
           count(*) FILTER (WHERE c.business_date <> r.business_date) AS cross_day_count
    FROM reversals r JOIN consumptions c ON c.id = r.consumption_id WHERE r.business_date = ${date}`;
  const [ex] = await db<SettlementTotals['expiry'][]>`
    SELECT count(*) AS count, coalesce(sum(amount), 0) AS bonus FROM bonus_expiries WHERE business_date = ${date}`;
  // 期初导入（只算有余额的行）与当天作废的期初
  const [op] = await db<SettlementTotals['opening'][]>`
    SELECT
      count(*) FILTER (WHERE i.business_date = ${date}) AS count,
      count(*) FILTER (WHERE b.void_business_date = ${date}) AS void_count,
      coalesce(sum(b.principal) FILTER (WHERE i.business_date = ${date}), 0)
        - coalesce(sum(b.principal) FILTER (WHERE b.void_business_date = ${date}), 0) AS principal,
      coalesce(sum(b.bonus) FILTER (WHERE i.business_date = ${date}), 0)
        - coalesce(sum(b.bonus) FILTER (WHERE b.void_business_date = ${date}), 0) AS bonus
    FROM opening_balances b JOIN opening_imports i ON i.id = b.import_id
    WHERE b.principal + b.bonus > 0 AND (i.business_date = ${date} OR b.void_business_date = ${date})`;
  const [net] = await db<Pair[]>`
    SELECT coalesce(sum(principal_delta), 0) AS principal, coalesce(sum(bonus_delta), 0) AS bonus
    FROM ledger_entries WHERE business_date = ${date}`;
  return {
    recharge: { count: rc!.count, paid: rc!.paid, bonus: rc!.bonus, byMethod },
    consume: cs!,
    reversal: rv!,
    expiry: ex!,
    opening: op!,
    net: net!,
    business: await businessTotals(db, date),
    backfill: (await db<{ count: number }[]>`SELECT count(*)::int AS count FROM backfill_entries WHERE business_date = ${date}`)[0]!,
    deposits: await depositTotals(db, date),
  };
}

/** 客房押金（S7）：当天收、退（按收款方式），以及当天结束时的在住押金余额 */
async function depositTotals(db: Db, date: string): Promise<SettlementDeposits> {
  const rows = await db<{ kind: string; method: PaymentMethod; count: number; amount: number }[]>`
    SELECT kind, method, count(*) AS count, sum(amount) AS amount FROM room_deposits
    WHERE business_date = ${date} GROUP BY kind, method ORDER BY kind, method`;
  const [held] = await db<{ amount: number }[]>`
    SELECT coalesce(sum(CASE WHEN kind = 'receive' THEN amount ELSE -amount END), 0) AS amount
    FROM room_deposits WHERE business_date <= ${date}`;
  const pick = (kind: string) => rows.filter((r) => r.kind === kind).map(({ method, count, amount }) => ({ method, count, amount }));
  return { received: pick('receive'), refunded: pick('refund'), held: held!.amount };
}

const EMPTY_DEPOSITS: SettlementDeposits = { received: [], refunded: [], held: 0 };

/** 营业口径：当天结账的计入当天，反结账计入反结账当天（负数） */
async function businessTotals(db: Db, date: string): Promise<BusinessTotals> {
  const [co] = await db<{ count: number; total: number; voidCount: number; voidTotal: number; ticket: number }[]>`
    SELECT
      count(*) FILTER (WHERE business_date = ${date}) AS count,
      coalesce(sum(total_amount) FILTER (WHERE business_date = ${date}), 0) AS total,
      count(*) FILTER (WHERE void_business_date = ${date}) AS void_count,
      coalesce(sum(total_amount) FILTER (WHERE void_business_date = ${date}), 0) AS void_total,
      coalesce(sum((SELECT sum(cb.ticket_amount) FROM checkout_bills cb WHERE cb.checkout_id = c.id))
               FILTER (WHERE business_date = ${date}), 0)
        - coalesce(sum((SELECT sum(cb.ticket_amount) FROM checkout_bills cb WHERE cb.checkout_id = c.id))
                   FILTER (WHERE void_business_date = ${date}), 0) AS ticket
    FROM checkouts c WHERE business_date = ${date} OR void_business_date = ${date}`;
  const byMethod = await db<BusinessTotals['byMethod']>`
    SELECT p.method,
           coalesce(sum(p.amount) FILTER (WHERE c.business_date = ${date}), 0)
             - coalesce(sum(p.amount) FILTER (WHERE c.void_business_date = ${date}), 0) AS amount,
           count(*) FILTER (WHERE c.business_date = ${date}) AS count,
           count(*) FILTER (WHERE c.void_business_date = ${date}) AS void_count
    FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    WHERE c.business_date = ${date} OR c.void_business_date = ${date}
    GROUP BY p.method ORDER BY p.method`;
  const coupons = await db<BusinessTotals['coupons']>`
    SELECT g.platform,
           coalesce(sum(g.amount) FILTER (WHERE c.business_date = ${date}), 0)
             - coalesce(sum(g.amount) FILTER (WHERE c.void_business_date = ${date}), 0) AS amount,
           count(*) FILTER (WHERE c.business_date = ${date}) AS count,
           count(*) FILTER (WHERE c.void_business_date = ${date}) AS void_count
    FROM group_buy_coupons g JOIN checkouts c ON c.id = g.checkout_id
    WHERE c.business_date = ${date} OR c.void_business_date = ${date}
    GROUP BY g.platform ORDER BY g.platform`;
  const net = co!.total - co!.voidTotal;
  // 退款单（v0.7.20）：当天开的、生效的（作废只能在当天，作废了就不算）
  const [rf] = await db<{ count: number; total: number }[]>`
    SELECT count(*)::int AS count, coalesce(sum(amount), 0)::bigint AS total FROM refunds WHERE business_date = ${date} AND status = 'completed'`;
  const refundByMethod = await db<BusinessTotals['refunds']['byMethod']>`
    SELECT p.method, count(*)::int AS count, sum(p.amount)::bigint AS amount
    FROM refund_payments p JOIN refunds r ON r.id = p.refund_id
    WHERE r.business_date = ${date} AND r.status = 'completed' GROUP BY p.method ORDER BY p.method`;
  return {
    checkouts: { count: co!.count, total: co!.total },
    voids: { count: co!.voidCount, total: co!.voidTotal },
    net,
    ticket: co!.ticket,
    items: net - co!.ticket,
    byMethod,
    coupons,
    refunds: { count: rf!.count, total: rf!.total, byMethod: refundByMethod },
  };
}

const EMPTY_REFUNDS: BusinessTotals['refunds'] = { count: 0, total: 0, byMethod: [] };
const EMPTY_BUSINESS: BusinessTotals = {
  checkouts: { count: 0, total: 0 },
  voids: { count: 0, total: 0 },
  net: 0,
  ticket: 0,
  items: 0,
  byMethod: [],
  coupons: [],
  refunds: EMPTY_REFUNDS,
};

// jsonb 不保留键顺序，比较前先按键排序
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
/** 确认日结时保存的快照可能早于新的口径（例如赠金过期，Batch 2.4c）：缺少的口径按 0 补齐再比较，不误报「日结后有变动」 */
const withNewSections = (t: SettlementTotals): SettlementTotals => ({
  ...t,
  expiry: t.expiry ?? { count: 0, bonus: 0 },
  opening: t.opening ?? { count: 0, voidCount: 0, principal: 0, bonus: 0 },
  // 退款单（v0.7.20）之前确认的快照没有 refunds
  business: t.business ? { ...t.business, refunds: t.business.refunds ?? EMPTY_REFUNDS } : EMPTY_BUSINESS,
  backfill: t.backfill ?? { count: 0 },
  deposits: t.deposits ?? EMPTY_DEPOSITS,
});
const sameTotals = (snapshot: SettlementTotals, now: SettlementTotals) => canonical(withNewSections(snapshot)) === canonical(now);

const ANOMALY_LABELS: Record<SettlementAnomaly['kind'], string> = {
  reversal: '撤销',
  cross_day_reversal: '跨日撤销',
  duplicate_blocked: '重复提交拦截',
  rejected: '余额不足拦截',
  abandoned: '作废待确认',
  balance_mismatch: '余额不符',
  chain_break: '流水不连续',
  checkout_void: '反结账',
  discount: '优惠 / 免单',
  ticket_override: '降档 / 免票',
  visit_cancel: '撤销误开的牌',
  line_void: '作废明细',
  backfill: '补录',
  refund: '退款单',
  refund_void: '作废退款单',
};
const pairText = (p: Pair) => `本金 ${formatYuan(p.principal)} / 赠金 ${formatYuan(p.bonus)}`;
/** 补录隔了多久：90 → 1.5 小时 */
const describeDelay = (minutes: number) => (minutes < 60 ? `${Math.max(minutes, 0)} 分钟` : `${Number((minutes / 60).toFixed(1))} 小时`);

export async function computeSettlement(db: Db, date: string, today: string): Promise<SettlementSummary> {
  const totals = await computeTotals(db, date);

  const [bal] = await db<{ opening: Pair; closing: Pair; ledgerNow: Pair; membersNow: Pair }[]>`
    SELECT
      json_build_object('principal', coalesce(sum(principal_delta) FILTER (WHERE business_date < ${date}), 0),
                        'bonus', coalesce(sum(bonus_delta) FILTER (WHERE business_date < ${date}), 0)) AS opening,
      json_build_object('principal', coalesce(sum(principal_delta) FILTER (WHERE business_date <= ${date}), 0),
                        'bonus', coalesce(sum(bonus_delta) FILTER (WHERE business_date <= ${date}), 0)) AS closing,
      json_build_object('principal', coalesce(sum(principal_delta), 0), 'bonus', coalesce(sum(bonus_delta), 0)) AS ledger_now,
      (SELECT json_build_object('principal', coalesce(sum(principal_balance), 0), 'bonus', coalesce(sum(bonus_balance), 0))
       FROM members) AS members_now
    FROM ledger_entries`;
  const balances = bal!;

  // 每条流水的「变动后余额」必须等于上一条的余额加本次变动
  const chainBreaks = await db<{ docNo: string; memberName: string; createdAt: string }[]>`
    SELECT x.doc_no, m.name AS member_name, x.created_at FROM (
      SELECT le.*, lag(principal_after, 1, 0::bigint) OVER w AS prev_p, lag(bonus_after, 1, 0::bigint) OVER w AS prev_b
      FROM ledger_entries le
      WHERE member_id IN (SELECT member_id FROM ledger_entries WHERE business_date = ${date})
      WINDOW w AS (PARTITION BY member_id ORDER BY id)
    ) x JOIN members m ON m.id = x.member_id
    WHERE x.business_date = ${date}
      AND (x.principal_after <> x.prev_p + x.principal_delta OR x.bonus_after <> x.prev_b + x.bonus_delta)`;

  // 会员当前余额必须等于其全部流水之和
  const mismatches = await db<{ memberName: string; principalBalance: number; bonusBalance: number; p: number; b: number }[]>`
    SELECT m.name AS member_name, m.principal_balance, m.bonus_balance, coalesce(l.p, 0) AS p, coalesce(l.b, 0) AS b
    FROM members m
    LEFT JOIN (SELECT member_id, sum(principal_delta) AS p, sum(bonus_delta) AS b FROM ledger_entries GROUP BY member_id) l
      ON l.member_id = m.id
    WHERE m.principal_balance <> coalesce(l.p, 0) OR m.bonus_balance <> coalesce(l.b, 0)`;

  // 赠金批次：会员赠金余额 = 全部批次剩余之和；每个批次「金额 + 变动 = 剩余」
  const [lots] = await db<{ members: number; lots: number }[]>`
    SELECT
      (SELECT count(*) FROM members m
       LEFT JOIN (SELECT member_id, sum(remaining) AS r FROM bonus_lots GROUP BY member_id) l ON l.member_id = m.id
       WHERE m.bonus_balance <> coalesce(l.r, 0)) AS members,
      (SELECT count(*) FROM bonus_lots b
       LEFT JOIN (SELECT lot_id, sum(amount) AS a FROM bonus_lot_moves GROUP BY lot_id) mv ON mv.lot_id = b.id
       WHERE b.amount + coalesce(mv.a, 0) <> b.remaining) AS lots`;

  // 营业口径与会员口径的桥：结账里的会员储值支付（净额）= 指向结账单的储值消费 − 其撤销
  const [bridge] = await db<{ payments: number; consumed: number; reversed: number; bills: number }[]>`
    SELECT
      (SELECT coalesce(sum(p.amount) FILTER (WHERE c.business_date = ${date}), 0)
              - coalesce(sum(p.amount) FILTER (WHERE c.void_business_date = ${date}), 0)
       FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
       WHERE p.method = 'wallet' AND (c.business_date = ${date} OR c.void_business_date = ${date})) AS payments,
      (SELECT coalesce(sum(total_amount), 0) FROM consumptions WHERE checkout_id IS NOT NULL AND business_date = ${date}) AS consumed,
      (SELECT coalesce(sum(r.principal_amount + r.bonus_amount), 0) FROM reversals r JOIN consumptions k ON k.id = r.consumption_id
       WHERE k.checkout_id IS NOT NULL AND r.business_date = ${date}) AS reversed,
      (SELECT coalesce(sum(cb.amount) FILTER (WHERE c.business_date = ${date}), 0)
              - coalesce(sum(cb.amount) FILTER (WHERE c.void_business_date = ${date}), 0)
       FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id
       WHERE c.business_date = ${date} OR c.void_business_date = ${date}) AS bills`;
  const receiptsNet = totals.business.byMethod.reduce((s, m) => s + m.amount, 0);
  const [refundCheck] = await db<{ bad: number }[]>`
    SELECT count(*)::int AS bad FROM refunds r
    WHERE r.business_date = ${date}
      AND (r.amount <> (SELECT coalesce(sum(amount), 0) FROM refund_items WHERE refund_id = r.id)
           OR r.amount <> (SELECT coalesce(sum(amount), 0) FROM refund_payments WHERE refund_id = r.id))`;

  const docDelta = {
    principal: totals.recharge.paid - totals.consume.principal + totals.reversal.principal + totals.opening.principal,
    bonus: totals.recharge.bonus - totals.consume.bonus + totals.reversal.bonus - totals.expiry.bonus + totals.opening.bonus,
  };
  const checks: SettlementCheck[] = [
    {
      key: 'documents_vs_ledger',
      label: '单据合计与流水一致',
      ok: docDelta.principal === totals.net.principal && docDelta.bonus === totals.net.bonus,
      detail: `单据推算 ${pairText(docDelta)}；流水合计 ${pairText(totals.net)}`,
    },
    {
      key: 'opening_plus_net',
      label: '期初 + 本日变动 = 期末',
      ok:
        balances.opening.principal + totals.net.principal === balances.closing.principal &&
        balances.opening.bonus + totals.net.bonus === balances.closing.bonus,
      detail: `期初 ${pairText(balances.opening)}；期末 ${pairText(balances.closing)}`,
    },
    {
      key: 'ledger_chain',
      label: '每笔流水的变动后余额连续',
      ok: chainBreaks.length === 0,
      detail: chainBreaks.length ? `${chainBreaks.length} 笔流水余额不连续` : '本营业日每笔流水均可从上一笔推出',
    },
    {
      key: 'members_vs_ledger',
      label: '会员当前余额与全部流水一致',
      ok: mismatches.length === 0,
      detail: mismatches.length
        ? `${mismatches.length} 位会员余额与流水不符`
        : `会员余额合计 ${pairText(balances.membersNow)}`,
    },
    {
      key: 'business_vs_receipts',
      label: '营业额 = 所结账单 = 结账收款',
      ok: totals.business.net === bridge!.bills && totals.business.net === receiptsNet,
      detail: `营业额（净额）${formatYuan(totals.business.net)}；所结账单 ${formatYuan(bridge!.bills)}；结账收款 ${formatYuan(receiptsNet)}`,
    },
    {
      key: 'wallet_bridge',
      label: '结账储值支付 = 储值消费（营业口径与会员口径的桥）',
      ok: bridge!.payments === bridge!.consumed - bridge!.reversed,
      detail: `结账储值支付（净额）${formatYuan(bridge!.payments)}；结账产生的储值消费 ${formatYuan(bridge!.consumed)}，其中当天撤销 ${formatYuan(bridge!.reversed)}`,
    },
    {
      // 退款单（v0.7.20）：当天的退款单，退的项目合计 = 退款方式合计 = 退款单金额
      key: 'refunds_balanced',
      label: '退款单：退的项目 = 退款方式 = 退款金额',
      ok: refundCheck!.bad === 0,
      detail: refundCheck!.bad
        ? `${refundCheck!.bad} 张退款单的项目、退款方式与金额对不上`
        : `当天退款单 ${totals.business.refunds.count} 张，合计 ${formatYuan(totals.business.refunds.total)}`,
    },
    {
      key: 'bonus_lots',
      label: '赠金批次与赠金余额一致',
      ok: lots!.members === 0 && lots!.lots === 0,
      detail:
        lots!.members || lots!.lots
          ? `${lots!.members} 位会员的赠金余额与批次不符，${lots!.lots} 个批次的剩余与变动不符`
          : '每位会员的赠金余额 = 未到期批次剩余之和，批次变动逐笔可推出',
    },
  ];

  const anomalies: SettlementAnomaly[] = [];
  const reversals = await db<{
    docNo: string; createdAt: string; memberName: string; amount: number; reason: string;
    consumptionDocNo: string; consumptionDate: string; operatorName: string;
  }[]>`
    SELECT r.doc_no, r.created_at, m.name AS member_name, r.principal_amount + r.bonus_amount AS amount, r.reason,
           c.doc_no AS consumption_doc_no, c.business_date AS consumption_date, s.display_name AS operator_name
    FROM reversals r JOIN consumptions c ON c.id = r.consumption_id
    JOIN members m ON m.id = r.member_id JOIN staff s ON s.id = r.operator_id
    WHERE r.business_date = ${date} ORDER BY r.id`;
  for (const r of reversals) {
    const crossDay = r.consumptionDate !== date;
    anomalies.push({
      kind: crossDay ? 'cross_day_reversal' : 'reversal',
      at: r.createdAt,
      docNo: r.docNo,
      memberName: r.memberName,
      amount: r.amount,
      description: `${crossDay ? `跨营业日撤销（原单营业日 ${r.consumptionDate}）` : '撤销消费'} · 原单 ${r.consumptionDocNo} · ${r.reason} · ${r.operatorName}`,
    });
  }
  const events = await db<{ action: string; createdAt: string; detail: Record<string, unknown>; staffName: string | null; memberName: string | null }[]>`
    SELECT a.action, a.created_at, a.detail, s.display_name AS staff_name,
           CASE WHEN a.target_type = 'member' THEN (SELECT name FROM members WHERE id::text = a.target_id) END AS member_name
    FROM audit_logs a LEFT JOIN staff s ON s.id = a.staff_id
    WHERE a.business_date = ${date} AND a.action IN ('duplicate_blocked', 'consume_rejected', 'operation_abandoned')
    ORDER BY a.id`;
  for (const e of events) {
    if (e.action === 'operation_abandoned') {
      // 结果待确认的操作被确认作废：没有入账。充值作废时请核对这笔款项是否确实未收或已退回
      anomalies.push({
        kind: 'abandoned',
        at: e.createdAt,
        docNo: null,
        memberName: e.memberName,
        amount: (e.detail.amount as number | null) ?? null,
        description: `结果待确认的操作已确认作废，没有入账${e.detail.summary ? ` · ${e.detail.summary as string}` : ''} · ${e.staffName ?? ''}`,
      });
    } else if (e.action === 'duplicate_blocked') {
      anomalies.push({
        kind: 'duplicate_blocked',
        at: e.createdAt,
        docNo: (e.detail.docNo as string) ?? null,
        memberName: (e.detail.memberName as string) ?? null,
        amount: null,
        description: `重复提交已拦截，未重复记账 · ${e.staffName ?? ''}`,
      });
    } else {
      anomalies.push({
        kind: 'rejected',
        at: e.createdAt,
        docNo: null,
        memberName: e.memberName,
        amount: (e.detail.total as number) ?? null,
        description: `余额不足，消费未入账（差 ${formatYuan((e.detail.shortfall as number) ?? 0)}）· ${e.staffName ?? ''}`,
      });
    }
  }
  // 反结账：原单若收过现金，需核对是否已退还或已在重新结账时收回
  const checkoutVoids = await db<{ checkoutNo: string; voidedAt: string; total: number; reason: string; staffName: string; createdDate: string }[]>`
    SELECT c.checkout_no, c.voided_at, c.total_amount AS total, c.void_reason AS reason, s.display_name AS staff_name, c.business_date AS created_date
    FROM checkouts c JOIN staff s ON s.id = c.voided_by WHERE c.void_business_date = ${date} ORDER BY c.voided_at`;
  for (const v of checkoutVoids) {
    anomalies.push({
      kind: 'checkout_void',
      at: v.voidedAt,
      docNo: v.checkoutNo,
      memberName: null,
      amount: v.total,
      description: `反结账${v.createdDate !== date ? `（原单营业日 ${v.createdDate}）` : ''} · ${v.reason} · ${v.staffName}；储值已按原单撤销，现金等请核对是否已退还或重新收取`,
    });
  }
  // 退款单（v0.7.20）：当天开的（含当天作废的），写明原结账单、退款方式与退款单号、经办人与原因
  const refundRows = await db<{
    refundNo: string; createdAt: string; amount: number; reason: string; staffName: string; checkoutNo: string; checkoutDate: string;
    status: string; voidedAt: string | null; voidReason: string | null; voidedByName: string | null; pays: { method: PaymentMethod; amount: number; ref: string }[];
  }[]>`
    SELECT r.refund_no, r.created_at, r.amount, r.reason, s.display_name AS staff_name, c.checkout_no, c.business_date AS checkout_date,
           r.status, r.voided_at, r.void_reason, vb.display_name AS voided_by_name,
           (SELECT json_agg(json_build_object('method', p.method, 'amount', p.amount, 'ref', p.ref) ORDER BY p.id) FROM refund_payments p WHERE p.refund_id = r.id) AS pays
    FROM refunds r JOIN staff s ON s.id = r.operator_id JOIN checkouts c ON c.id = r.checkout_id LEFT JOIN staff vb ON vb.id = r.voided_by
    WHERE r.business_date = ${date} ORDER BY r.id`;
  for (const r of refundRows) {
    const pays = r.pays.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatYuan(p.amount)}${p.ref ? `（${p.ref}）` : ''}`).join('、');
    anomalies.push({
      kind: 'refund',
      at: r.createdAt,
      docNo: r.refundNo,
      memberName: null,
      amount: r.amount,
      description: `退款单 · 原结账单 ${r.checkoutNo}${r.checkoutDate !== date ? `（营业日 ${r.checkoutDate}）` : ''} · ${pays} · ${r.reason} · ${r.staffName}${r.status === 'voided' ? '（已作废）' : ''}`,
    });
    if (r.status === 'voided') {
      anomalies.push({
        kind: 'refund_void',
        at: r.voidedAt,
        docNo: r.refundNo,
        memberName: null,
        amount: r.amount,
        description: `作废退款单 · ${r.voidReason ?? ''} · ${r.voidedByName ?? ''}；钱已退出去的请核对是否收回`,
      });
    }
  }
  // 前台少收与更正（R1.2，店主 2026-10-29 签认）：优惠 / 免单、降低票种或免票、接待超过时限后撤销误开的牌、作废明细
  const discounts = await db<{ checkoutNo: string; createdAt: string; amount: number; reason: string; operatorName: string; approverName: string; status: string }[]>`
    SELECT c.checkout_no, c.created_at, p.amount, p.ref AS reason, s.display_name AS operator_name, ap.display_name AS approver_name, c.status
    FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id JOIN staff s ON s.id = c.operator_id JOIN staff ap ON ap.id = p.approved_by
    WHERE p.method = 'discount' AND c.business_date = ${date} ORDER BY c.created_at, p.id`;
  for (const d of discounts) {
    anomalies.push({
      kind: 'discount',
      at: d.createdAt,
      docNo: d.checkoutNo,
      memberName: null,
      amount: d.amount,
      description: `优惠 / 免单 · ${d.reason} · 经办 ${d.operatorName}，${d.approverName}当场授权${d.status === 'voided' ? '（结账单已反结账）' : ''}`,
    });
  }
  const { selfVoidMinutes } = await loadFrontdeskRules(db);
  const frontEvents = await db<{ action: string; createdAt: string; detail: Record<string, unknown>; staffName: string | null; late: boolean | null }[]>`
    SELECT a.action, a.created_at, a.detail, s.display_name AS staff_name,
           CASE WHEN a.action = 'frontdesk_cancel'
                THEN (SELECT v.closed_at - v.checked_in_at > make_interval(mins => ${selfVoidMinutes}) FROM visits v WHERE v.id::text = a.target_id) END AS late
    FROM audit_logs a LEFT JOIN staff s ON s.id = a.staff_id
    WHERE a.business_date = ${date}
      AND (a.action IN ('frontdesk_cancel', 'frontdesk_void', 'table_void')
           OR (a.action = 'frontdesk_ticket' AND a.detail ? 'approval')
           OR (a.action = 'frontdesk_checkin' AND a.detail ? 'freeTickets'))
    ORDER BY a.id`;
  for (const e of frontEvents) {
    const d = e.detail;
    const text = (key: string) => (d[key] as string | undefined) ?? '';
    const staff = e.staffName ?? '';
    if (e.action === 'frontdesk_cancel') {
      if (!e.late) continue;
      anomalies.push({
        kind: 'visit_cancel',
        at: e.createdAt,
        docNo: text('visitNo') || null,
        memberName: null,
        amount: null,
        description: `接待超过 ${selfVoidMinutes} 分钟后撤销误开的牌 · ${text('reason')} · ${staff}`,
      });
    } else if (e.action === 'frontdesk_void' || e.action === 'table_void') {
      // 桌台退菜（餐饮第二步）与前台作废明细同列，单号是开台号
      anomalies.push({
        kind: 'line_void',
        at: e.createdAt,
        docNo: text('visitNo') || text('sessionNo') || null,
        memberName: null,
        amount: (d.amount as number | undefined) ?? null,
        description: `作废明细 ${text('name')} × ${(d.quantity as number | undefined) ?? ''} · ${text('reason')} · ${staff}`,
      });
    } else if (e.action === 'frontdesk_ticket') {
      const a = d.approval as { approverName: string; reason: string };
      anomalies.push({
        kind: 'ticket_override',
        at: e.createdAt,
        docNo: text('visitNo') || null,
        memberName: null,
        amount: null,
        description: `改票种为「${text('name')}」· ${a.reason} · 经办 ${staff}，${a.approverName}当场授权`,
      });
    } else {
      const f = d.freeTickets as { tags: string[]; approverName: string; reason: string };
      anomalies.push({
        kind: 'ticket_override',
        at: e.createdAt,
        docNo: null,
        memberName: null,
        amount: null,
        description: `接待时选免票（手牌 ${f.tags.join('、')}）· ${f.reason} · 经办 ${staff}，${f.approverName}当场授权`,
      });
    }
  }
  // 按实际时间补录的纸质单（R1.9）：每一步补录一行，时间为纸质单上的实际时间，写明补录人和隔了多久补录
  const backfills = await db<{
    kind: BackfillKind; slipNo: string; actualAt: string; delayMinutes: number; staffName: string;
    docNo: string | null; tagCode: string | null; amount: number | null; checkoutStatus: string | null;
  }[]>`
    SELECT b.kind, b.slip_no, b.actual_at, round(extract(epoch FROM b.entered_at - b.actual_at) / 60)::int AS delay_minutes,
           s.display_name AS staff_name, coalesce(c.checkout_no, v.visit_no) AS doc_no, t.code AS tag_code, c.status AS checkout_status,
           CASE b.kind WHEN 'checkout' THEN c.total_amount
                       WHEN 'charges' THEN (SELECT coalesce(sum(l.amount), 0) FROM bill_lines l WHERE l.post_key = b.op_key) END AS amount
    FROM backfill_entries b JOIN staff s ON s.id = b.entered_by
    LEFT JOIN checkouts c ON c.id = b.checkout_id LEFT JOIN visits v ON v.id = b.visit_id LEFT JOIN hand_tags t ON t.id = v.tag_id
    WHERE b.business_date = ${date} ORDER BY b.actual_at, b.id`;
  for (const b of backfills) {
    anomalies.push({
      kind: 'backfill',
      at: b.actualAt,
      docNo: b.docNo,
      memberName: null,
      amount: b.amount,
      description: `补录${BACKFILL_KIND_LABELS[b.kind]}${b.tagCode ? `（手牌 ${b.tagCode}）` : ''} · 纸质单 ${b.slipNo} · ${b.staffName}在实际时间后 ${describeDelay(b.delayMinutes)}补录${b.checkoutStatus === 'voided' ? '（结账单已反结账）' : ''}`,
    });
  }
  for (const c of chainBreaks) {
    anomalies.push({ kind: 'chain_break', at: c.createdAt, docNo: c.docNo, memberName: c.memberName, amount: null, description: '流水变动后余额不连续，请联系维护人员' });
  }
  for (const m of mismatches) {
    anomalies.push({
      kind: 'balance_mismatch',
      at: null,
      docNo: null,
      memberName: m.memberName,
      amount: null,
      description: `会员余额（${pairText({ principal: m.principalBalance, bonus: m.bonusBalance })}）与流水合计（${pairText({ principal: m.p, bonus: m.b })}）不符`,
    });
  }

  const byStaff = await db<SettlementSummary['byStaff']>`
    SELECT s.id AS staff_id, s.display_name AS name,
           coalesce(r.cnt, 0) AS recharge_count, coalesce(r.paid, 0) AS recharge_paid,
           coalesce(c.cnt, 0) AS consume_count, coalesce(c.total, 0) AS consume_total,
           coalesce(v.cnt, 0) AS reversal_count
    FROM staff s
    LEFT JOIN (SELECT operator_id, count(*) AS cnt, sum(paid_amount) AS paid FROM recharges WHERE business_date = ${date} GROUP BY 1) r ON r.operator_id = s.id
    LEFT JOIN (SELECT operator_id, count(*) AS cnt, sum(total_amount) AS total FROM consumptions WHERE business_date = ${date} GROUP BY 1) c ON c.operator_id = s.id
    LEFT JOIN (SELECT operator_id, count(*) AS cnt FROM reversals WHERE business_date = ${date} GROUP BY 1) v ON v.operator_id = s.id
    WHERE r.cnt IS NOT NULL OR c.cnt IS NOT NULL OR v.cnt IS NOT NULL
    ORDER BY s.id`;

  const [closedRow] = await db<{ closedAt: string; closedByName: string; note: string; revision: number; snapshot: SettlementTotals }[]>`
    SELECT d.closed_at, s.display_name AS closed_by_name, d.note, d.revision, d.snapshot
    FROM daily_settlements d JOIN staff s ON s.id = d.closed_by WHERE d.business_date = ${date}`;

  return {
    businessDate: date,
    isToday: date === today,
    isFuture: date > today,
    ...totals,
    balances,
    checks,
    anomalies,
    byStaff,
    closed: closedRow
      ? {
          closedAt: closedRow.closedAt,
          closedByName: closedRow.closedByName,
          note: closedRow.note,
          revision: closedRow.revision,
          changedSinceClose: !sameTotals(closedRow.snapshot, totals),
        }
      : null,
  };
}

export function settlementCsv(s: SettlementSummary): string {
  const y = formatAmount;
  const signed = (cents: number) => (cents < 0 ? '-' : '') + y(cents);
  const biz = businessBreakdown(s.business);
  const rows: (string | number)[][] = [
    ['浴族日结汇总', s.businessDate],
    [],
    ['项目', '笔数', '金额（元）', '说明'],
    ['充值实收', s.recharge.count, y(s.recharge.paid), '实际收款，等额计入本金'],
    ...s.recharge.byMethod.map((m) => [`  · ${PAYMENT_METHOD_LABELS[m.method]}`, m.count, y(m.amount), '']),
    ['赠金发放', s.recharge.count, y(s.recharge.bonus), '随充值赠送，不是收款'],
    ['储值消费合计', s.consume.count, y(s.consume.total), `其中已撤销 ${s.consume.reversedCount} 笔`],
    ['  · 扣本金', '', y(s.consume.principal), ''],
    ['  · 扣赠金', '', y(s.consume.bonus), ''],
    ['撤销恢复', s.reversal.count, y(s.reversal.principal + s.reversal.bonus), `跨营业日 ${s.reversal.crossDayCount} 笔`],
    ['  · 恢复本金', '', y(s.reversal.principal), ''],
    ['  · 恢复赠金', '', y(s.reversal.bonus), ''],
    ['赠金过期', s.expiry.count, y(s.expiry.bonus), '到期未用完的赠金作废，不是收款或退款'],
    ['期初导入（净额）', s.opening.count, y(s.opening.principal + s.opening.bonus), `旧系统余额迁入，不是收款；作废 ${s.opening.voidCount} 笔`],
    ['  · 期初本金', '', y(s.opening.principal), ''],
    ['  · 期初赠金', '', y(s.opening.bonus), ''],
    [],
    ['营业口径（前台结账）', '笔数', '金额（元）', '说明'],
    ['结账', s.business.checkouts.count, y(s.business.checkouts.total), '当天结账的账单合计（含门票）'],
    ['反结账', s.business.voids.count, (s.business.voids.total ? '-' : '') + y(s.business.voids.total), '当天反结账的结账单（原单可能在之前的营业日）'],
    ['应收（结账 − 反结账）', '', signed(biz.receivable), `门票 ${y(s.business.ticket)}，项目与其他 ${y(s.business.items)}`],
    ['优惠 / 免单', '', signed(biz.discount), '值班经理及以上当场授权，不是收款'],
    ['券抵扣', '', signed(biz.coupon), '结账用的券，是优惠，不是收款'],
    ['会员折扣', '', signed(biz.memberDiscount), '结账时自动算的会员折扣，是优惠，不是收款'],
    ['退款', s.business.refunds.count, (s.business.refunds.total ? '-' : '') + y(s.business.refunds.total), '当天的退款单（离店后部分退款，按原收款方式退）'],
    ...s.business.refunds.byMethod.map((m) => [`  · 退${PAYMENT_METHOD_LABELS[m.method]}`, m.count, '-' + y(m.amount), m.method === 'cash' ? '现金从钱箱退' : '商户后台原路退回']),
    ['净营业额', '', signed(biz.netRevenue), '应收 − 优惠 − 券抵扣 − 会员折扣 − 退款'],
    ['实收（现金类）', '', signed(biz.received), '现金、微信、支付宝、银行卡、其他，减去退款；不含会员储值、团购券、优惠、券抵扣'],
    ...s.business.byMethod.map((m) => [
      `  · ${CHECKOUT_METHOD_LABELS[m.method]}`,
      m.count,
      signed(m.amount),
      m.method === 'wallet'
        ? '会员余额抵扣，同时计入储值消费'
        : m.method === 'coupon'
          ? '平台团购核销，由平台结算'
          : m.method === 'discount' || m.method === 'store_coupon' || m.method === 'member_discount'
            ? '优惠，不是收款'
            : '',
    ]),
    ...s.business.coupons.map((c) => [`  · 团购 ${COUPON_PLATFORM_LABELS[c.platform]}`, c.count, (c.amount < 0 ? '-' : '') + y(c.amount), c.voidCount ? `作废 ${c.voidCount} 张` : '']),
    [],
    ['客房押金（负债，不算营业额）', '笔数', '金额（元）', '说明'],
    ...s.deposits.received.map((m) => [`收押金 · ${PAYMENT_METHOD_LABELS[m.method]}`, m.count, y(m.amount), m.method === 'cash' ? '现金计入钱箱' : '']),
    ...s.deposits.refunded.map((m) => [`退押金 · ${PAYMENT_METHOD_LABELS[m.method]}`, m.count, '-' + y(m.amount), m.method === 'cash' ? '现金从钱箱退' : '原路退回']),
    ['当天结束时在住押金余额', '', y(s.deposits.held), ''],
    [],
    ['余额核对', '本金（元）', '赠金（元）'],
    ['期初余额', y(s.balances.opening.principal), y(s.balances.opening.bonus)],
    ['本日净变动', (s.net.principal < 0 ? '-' : '') + y(s.net.principal), (s.net.bonus < 0 ? '-' : '') + y(s.net.bonus)],
    ['期末余额', y(s.balances.closing.principal), y(s.balances.closing.bonus)],
    [],
    ['核对项', '结果', '说明'],
    ...s.checks.map((c) => [c.label, c.ok ? '一致' : '不一致', c.detail]),
    [],
    ['异常与提醒', '单号', '会员', '说明'],
    ...s.anomalies.map((a) => [ANOMALY_LABELS[a.kind], a.docNo ?? '', a.memberName ?? '', a.description]),
  ];
  return toCsv(rows);
}

const DateParam = z.object({ date: dateSchema() });
const CloseInput = z.object({ note: z.string().trim().max(200, '备注最多 200 字').default('') });

export function registerSettlementRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const todayNow = async () => businessDateOf(new Date(), config.timezone, (await loadSettings(sql)).businessDayStartHour);

  app.get('/api/settlements/:date', { preHandler: guard('ledger.readToday') }, async (req) => {
    const { date } = parse(DateParam, req.params);
    const target = await resolveReadableDate(deps, req, date);
    const today = await todayNow();
    return readSnapshot(sql, (tx) => computeSettlement(tx, target, today));
  });

  app.post('/api/settlements/:date/close', { preHandler: guard('settlement.close') }, async (req) => {
    const { date } = parse(DateParam, req.params);
    const { note } = parse(CloseInput, req.body ?? {});
    const today = await todayNow();
    if (date > today) throw unprocessable('FUTURE_DATE', '营业日尚未开始，不能日结');
    // 快照取自同一时刻的数据；写入单独一个事务，并串行化同一营业日的日结确认
    const totals = await readSnapshot(sql, (tx) => computeTotals(tx, date));
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'settle:' + date}))`;
      const [prev] = await tx<{ snapshot: SettlementTotals; revision: number }[]>`
        SELECT snapshot, revision FROM daily_settlements WHERE business_date = ${date}`;
      await tx`
        INSERT INTO daily_settlements (business_date, closed_by, closed_at, note, snapshot, revision)
        VALUES (${date}, ${req.actor.id}, now(), ${note}, ${tx.json(totals as never)}, 1)
        ON CONFLICT (business_date) DO UPDATE
          SET closed_by = EXCLUDED.closed_by, closed_at = now(), note = EXCLUDED.note,
              snapshot = EXCLUDED.snapshot, revision = daily_settlements.revision + 1`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'settlement_closed',
        targetType: 'settlement',
        targetId: date,
        detail: { note, totals, previous: prev ?? null },
        ip: req.ip,
        businessDate: date,
      });
    });
    return readSnapshot(sql, (tx) => computeSettlement(tx, date, today));
  });

  app.get('/api/settlements/:date/export', { preHandler: guard('ledger.export') }, async (req, reply) => {
    const { date } = parse(DateParam, req.params);
    const target = await resolveReadableDate(deps, req, date);
    const today = await todayNow();
    const summary = await readSnapshot(sql, (tx) => computeSettlement(tx, target, today));
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'settlement', targetId: target, ip: req.ip });
    attachment(reply, `浴族日结-${target}.csv`, CSV_TYPE);
    return settlementCsv(summary);
  });
}
