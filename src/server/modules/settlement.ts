// 日结：按营业日汇总充值收款、储值消费、撤销，并核对余额与流水是否一致。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@shared/labels';
import { formatAmount, formatYuan } from '@shared/money';
import type { SettlementAnomaly, SettlementCheck, SettlementSummary, SettlementTotals } from '@shared/types';
import { readSnapshot, type Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { unprocessable } from '../lib/errors';
import { toCsv } from '../lib/csv';
import { parse } from '../lib/validate';
import { resolveReadableDate } from './ledger';
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
  const [net] = await db<Pair[]>`
    SELECT coalesce(sum(principal_delta), 0) AS principal, coalesce(sum(bonus_delta), 0) AS bonus
    FROM ledger_entries WHERE business_date = ${date}`;
  return {
    recharge: { count: rc!.count, paid: rc!.paid, bonus: rc!.bonus, byMethod },
    consume: cs!,
    reversal: rv!,
    net: net!,
  };
}

// jsonb 不保留键顺序，比较前先按键排序
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const sameTotals = (a: SettlementTotals, b: SettlementTotals) => canonical(a) === canonical(b);

const ANOMALY_LABELS: Record<SettlementAnomaly['kind'], string> = {
  reversal: '撤销',
  cross_day_reversal: '跨日撤销',
  duplicate_blocked: '重复提交拦截',
  rejected: '余额不足拦截',
  balance_mismatch: '余额不符',
  chain_break: '流水不连续',
};
const pairText = (p: Pair) => `本金 ${formatYuan(p.principal)} / 赠金 ${formatYuan(p.bonus)}`;

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

  const docDelta = {
    principal: totals.recharge.paid - totals.consume.principal + totals.reversal.principal,
    bonus: totals.recharge.bonus - totals.consume.bonus + totals.reversal.bonus,
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
    WHERE a.business_date = ${date} AND a.action IN ('duplicate_blocked', 'consume_rejected')
    ORDER BY a.id`;
  for (const e of events) {
    if (e.action === 'duplicate_blocked') {
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

const DateParam = z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD') });
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
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`浴族日结-${target}.csv`)}`);
    return settlementCsv(summary);
  });
}
