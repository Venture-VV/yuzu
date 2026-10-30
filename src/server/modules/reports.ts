// 数据看板（v0.6.0）：经营总览（任选时段、环比）、会员总览、今日值班数据。只读汇总，口径与日结一致。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import { levelOf } from '@shared/frontdesk';
import { shiftDate } from '@shared/labels';
import { channelLabel, levelName } from '@shared/members';
import { MAX_REPORT_DAYS, type DutyExtras, type ExecutiveReport, type MemberBrief, type MembersReport, type PeriodKpis } from '@shared/reports';
import { readSnapshot, type Db } from '../db';
import { guard } from '../auth/guard';
import type { Deps } from '../lib/context';
import { badRequest } from '../lib/errors';
import { parse } from '../lib/validate';
import { loadFrontdeskRules } from './frontdesk/common';
import { loadSettings } from './settings';
import { technicianReport } from './technicians';

interface Clock {
  tz: string;
  startHour: number;
}

/** 某个时间戳所属的营业日（SQL 片段） */
const bizDate = (db: Db, col: string, c: Clock) => db`((${db(col)} AT TIME ZONE ${c.tz}) - make_interval(hours => ${c.startHour}))::date`;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

async function periodKpis(db: Db, from: string, to: string, c: Clock): Promise<PeriodKpis> {
  const [r] = await db<Omit<PeriodKpis, 'net' | 'perGuest'>[]>`
    SELECT
      (SELECT coalesce(sum(total_amount) FILTER (WHERE business_date BETWEEN ${from} AND ${to}), 0)
              - coalesce(sum(total_amount) FILTER (WHERE void_business_date BETWEEN ${from} AND ${to}), 0)
       FROM checkouts WHERE business_date BETWEEN ${from} AND ${to} OR void_business_date BETWEEN ${from} AND ${to}) AS receivable,
      (SELECT coalesce(sum(p.amount) FILTER (WHERE c.business_date BETWEEN ${from} AND ${to}), 0)
              - coalesce(sum(p.amount) FILTER (WHERE c.void_business_date BETWEEN ${from} AND ${to}), 0)
       FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
       WHERE p.method = 'discount' AND (c.business_date BETWEEN ${from} AND ${to} OR c.void_business_date BETWEEN ${from} AND ${to})) AS discount,
      (SELECT count(*) FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id
       WHERE c.business_date BETWEEN ${from} AND ${to} AND c.status = 'completed')::int AS guests,
      (SELECT count(*) FROM checkouts WHERE business_date BETWEEN ${from} AND ${to} AND status = 'completed')::int AS checkouts,
      (SELECT coalesce(sum(paid_amount), 0) FROM recharges WHERE business_date BETWEEN ${from} AND ${to}) AS recharge_paid,
      (SELECT count(*) FROM recharges WHERE business_date BETWEEN ${from} AND ${to})::int AS recharge_count,
      (SELECT coalesce(sum(total_amount), 0) FROM consumptions WHERE business_date BETWEEN ${from} AND ${to} AND status = 'completed') AS wallet_consumed,
      (SELECT count(*) FROM members WHERE ${bizDate(db, 'created_at', c)} BETWEEN ${from} AND ${to})::int AS new_members`;
  const net = r!.receivable - r!.discount;
  return { ...r!, net, perGuest: r!.guests ? Math.round(net / r!.guests) : 0 };
}

/** 部门（项目分类）与项目：每张结账单结账那一刻的明细（与对账包的部门参考表同一口径），时段内结的计正数、反结账的计负数 */
async function itemLines(db: Db, from: string, to: string) {
  return db<{ category: string; name: string; quantity: number; amount: number }[]>`
    WITH k AS (
      SELECT id, created_at, 1 AS sign FROM checkouts WHERE business_date BETWEEN ${from} AND ${to}
      UNION ALL
      SELECT id, created_at, -1 FROM checkouts WHERE void_business_date BETWEEN ${from} AND ${to}
    )
    SELECT CASE WHEN l.ticket_type_id IS NOT NULL THEN '门票'
                WHEN l.item_id IS NULL THEN '其他（手动金额、赔偿等）'
                ELSE coalesce(nullif(si.category, ''), '未分类') END AS category,
           l.name, sum(k.sign * l.quantity)::int AS quantity, sum(k.sign * l.amount)::bigint AS amount
    FROM k JOIN checkout_bills cb ON cb.checkout_id = k.id
    JOIN bill_lines l ON l.bill_id = cb.bill_id AND l.posted_at <= k.created_at AND (l.voided_at IS NULL OR l.voided_at > k.created_at)
    LEFT JOIN service_items si ON si.id = l.item_id
    GROUP BY 1, 2
    HAVING sum(k.sign * l.quantity) <> 0 OR sum(k.sign * l.amount) <> 0`;
}

function byCategory(lines: { category: string; quantity: number; amount: number }[]) {
  const map = new Map<string, { category: string; quantity: number; amount: number }>();
  for (const l of lines) {
    const x = map.get(l.category) ?? { category: l.category, quantity: 0, amount: 0 };
    x.quantity += l.quantity;
    x.amount += l.amount;
    map.set(l.category, x);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

export async function executiveReport(db: Db, from: string, to: string, c: Clock): Promise<ExecutiveReport> {
  const days = daysBetween(from, to);
  const prevTo = shiftDate(from, -1);
  const prevFrom = shiftDate(prevTo, -(days - 1));
  const kpis = await periodKpis(db, from, to, c);
  const prev = await periodKpis(db, prevFrom, prevTo, c);
  const trend = await db<ExecutiveReport['trend']>`
    WITH d AS (SELECT generate_series(${from}::date, ${to}::date, interval '1 day')::date AS date),
    rec AS (
      SELECT business_date AS date, sum(total_amount) AS amount FROM checkouts WHERE business_date BETWEEN ${from} AND ${to} GROUP BY 1
      UNION ALL
      SELECT void_business_date, -sum(total_amount) FROM checkouts WHERE void_business_date BETWEEN ${from} AND ${to} GROUP BY 1
    ),
    dis AS (
      SELECT c.business_date AS date, sum(p.amount) AS amount FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
      WHERE p.method = 'discount' AND c.business_date BETWEEN ${from} AND ${to} GROUP BY 1
      UNION ALL
      SELECT c.void_business_date, -sum(p.amount) FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
      WHERE p.method = 'discount' AND c.void_business_date BETWEEN ${from} AND ${to} GROUP BY 1
    ),
    g AS (
      SELECT c.business_date AS date, count(*) AS n FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id
      WHERE c.business_date BETWEEN ${from} AND ${to} AND c.status = 'completed' GROUP BY 1
    ),
    r AS (SELECT business_date AS date, sum(paid_amount) AS amount FROM recharges WHERE business_date BETWEEN ${from} AND ${to} GROUP BY 1)
    SELECT to_char(d.date, 'YYYY-MM-DD') AS date,
           (coalesce((SELECT sum(amount) FROM rec WHERE rec.date = d.date), 0) - coalesce((SELECT sum(amount) FROM dis WHERE dis.date = d.date), 0))::bigint AS net,
           coalesce((SELECT n FROM g WHERE g.date = d.date), 0)::int AS guests,
           coalesce((SELECT amount FROM r WHERE r.date = d.date), 0)::bigint AS recharge_paid
    FROM d ORDER BY d.date`;
  const byMethod = await db<ExecutiveReport['byMethod']>`
    SELECT p.method, sum(p.amount)::bigint AS amount FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    WHERE c.business_date BETWEEN ${from} AND ${to} AND c.status = 'completed' GROUP BY p.method ORDER BY amount DESC`;
  const tickets = await db<ExecutiveReport['tickets']>`
    SELECT cb.ticket_name AS name, count(*)::int AS count, sum(cb.ticket_amount)::bigint AS amount
    FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id
    WHERE c.business_date BETWEEN ${from} AND ${to} AND c.status = 'completed'
    GROUP BY cb.ticket_name ORDER BY count DESC`;
  const lines = await itemLines(db, from, to);
  const arrivals = await db<ExecutiveReport['arrivals']>`
    SELECT extract(hour FROM checked_in_at AT TIME ZONE ${c.tz})::int AS hour, count(*)::int AS count
    FROM visits WHERE business_date BETWEEN ${from} AND ${to} AND status <> 'cancelled'
    GROUP BY 1 ORDER BY 1`;
  return {
    from,
    to,
    days,
    prevFrom,
    prevTo,
    kpis,
    prev,
    trend,
    byMethod,
    tickets,
    departments: byCategory(lines),
    topItems: lines.filter((l) => l.category !== '门票' && l.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 10),
    arrivals,
  };
}

const MEMBER_BRIEF = (db: Db) => db`
  m.id, m.member_no, m.name, right(m.phone, 4) AS phone_tail, m.principal_balance + m.bonus_balance AS balance,
  (SELECT max(le.created_at) FROM ledger_entries le WHERE le.member_id = m.id) AS last_activity_at`;

export async function membersReport(db: Db, from: string, to: string, c: Clock): Promise<MembersReport> {
  const settings = await loadSettings(db);
  const rules = await loadFrontdeskRules(db);
  const [t] = await db<MembersReport['totals'][]>`
    SELECT count(*)::int AS members, count(*) FILTER (WHERE principal_balance + bonus_balance > 0)::int AS with_balance,
           coalesce(sum(principal_balance), 0) AS principal, coalesce(sum(bonus_balance), 0) AS bonus,
           count(*) FILTER (WHERE status = 'frozen')::int AS frozen
    FROM members`;
  const [a] = await db<MembersReport['activity'][]>`
    WITH x AS (
      SELECT m.principal_balance + m.bonus_balance AS balance, (SELECT max(le.created_at) FROM ledger_entries le WHERE le.member_id = m.id) AS last_at
      FROM members m WHERE m.principal_balance + m.bonus_balance > 0
    )
    SELECT count(*) FILTER (WHERE last_at >= now() - interval '30 days')::int AS active30,
           count(*) FILTER (WHERE last_at < now() - interval '30 days' AND last_at >= now() - interval '90 days')::int AS active90,
           count(*) FILTER (WHERE last_at IS NULL OR last_at < now() - interval '90 days')::int AS dormant,
           coalesce(sum(balance) FILTER (WHERE last_at IS NULL OR last_at < now() - interval '90 days'), 0) AS dormant_balance
    FROM x`;
  const [p] = await db<MembersReport['period'][]>`
    SELECT (SELECT count(*) FROM members WHERE ${bizDate(db, 'created_at', c)} BETWEEN ${from} AND ${to})::int AS new_members,
           (SELECT coalesce(sum(paid_amount), 0) FROM recharges WHERE business_date BETWEEN ${from} AND ${to}) AS recharge_paid,
           (SELECT count(*) FROM recharges WHERE business_date BETWEEN ${from} AND ${to})::int AS recharge_count,
           (SELECT count(DISTINCT member_id) FROM recharges WHERE business_date BETWEEN ${from} AND ${to})::int AS recharge_members,
           (SELECT coalesce(sum(total_amount), 0) FROM consumptions WHERE business_date BETWEEN ${from} AND ${to} AND status = 'completed') AS wallet_consumed,
           (SELECT count(DISTINCT member_id) FROM consumptions WHERE business_date BETWEEN ${from} AND ${to} AND status = 'completed')::int AS consume_members`;
  const channelRows = await db<{ channel: string | null; total: number; fresh: number }[]>`
    SELECT channel, count(*)::int AS total,
           count(*) FILTER (WHERE ${bizDate(db, 'created_at', c)} BETWEEN ${from} AND ${to})::int AS fresh
    FROM members GROUP BY channel`;
  const label = (key: string | null) => channelLabel(settings.memberChannels, key) ?? '未登记';
  const channels = (pick: 'total' | 'fresh') =>
    channelRows
      .filter((r) => r[pick] > 0)
      .map((r) => ({ channel: r.channel, label: label(r.channel), count: r[pick] }))
      .sort((x, y) => y.count - x.count);

  // 等级分布：口径与 VIP 柜相同
  const amounts =
    rules.vipLevelBasis === 'balance'
      ? await db<{ amount: number; balance: number }[]>`SELECT principal_balance + bonus_balance AS amount, principal_balance + bonus_balance AS balance FROM members`
      : await db<{ amount: number; balance: number }[]>`
          SELECT coalesce((SELECT sum(r.paid_amount) FROM recharges r WHERE r.member_id = m.id), 0)
                 + coalesce((SELECT sum(o.legacy_recharged) FROM opening_balances o WHERE o.member_id = m.id AND o.status = 'active'), 0) AS amount,
                 m.principal_balance + m.bonus_balance AS balance
          FROM members m`;
  const levels = new Map<number, { level: number; name: string; count: number; balance: number }>();
  for (let i = 0; i <= rules.vipLevelThresholds.length; i++) levels.set(i, { level: i, name: levelName(i, rules.vipLevelNames), count: 0, balance: 0 });
  for (const m of amounts) {
    const l = levels.get(levelOf(Number(m.amount), rules.vipLevelThresholds))!;
    l.count += 1;
    l.balance += Number(m.balance);
  }

  const withLevel = async (rows: (Omit<MemberBrief, 'levelName'> & Record<string, unknown>)[]) => {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const lv =
      rules.vipLevelBasis === 'balance'
        ? await db<{ id: number; amount: number }[]>`SELECT id, principal_balance + bonus_balance AS amount FROM members WHERE id IN ${db(ids)}`
        : await db<{ id: number; amount: number }[]>`
            SELECT m.id, coalesce((SELECT sum(r.paid_amount) FROM recharges r WHERE r.member_id = m.id), 0)
                   + coalesce((SELECT sum(o.legacy_recharged) FROM opening_balances o WHERE o.member_id = m.id AND o.status = 'active'), 0) AS amount
            FROM members m WHERE m.id IN ${db(ids)}`;
    const map = new Map(lv.map((x) => [x.id, levelName(levelOf(Number(x.amount), rules.vipLevelThresholds), rules.vipLevelNames)]));
    return rows.map((r) => ({ ...r, levelName: map.get(r.id) ?? '' }));
  };
  const topBalance = await withLevel(
    await db`SELECT ${MEMBER_BRIEF(db)} FROM members m WHERE m.principal_balance + m.bonus_balance > 0 ORDER BY balance DESC, m.id LIMIT 10`,
  );
  const topRecharge = (await withLevel(
    await db`
      SELECT ${MEMBER_BRIEF(db)}, x.paid FROM (
        SELECT member_id, sum(paid_amount) AS paid FROM recharges WHERE business_date BETWEEN ${from} AND ${to} GROUP BY member_id
      ) x JOIN members m ON m.id = x.member_id ORDER BY x.paid DESC, m.id LIMIT 10`,
  )) as (MemberBrief & { paid: number })[];
  const dormantList = await withLevel(
    await db`
      SELECT * FROM (SELECT ${MEMBER_BRIEF(db)} FROM members m WHERE m.principal_balance + m.bonus_balance > 0) x
      WHERE last_activity_at IS NULL OR last_activity_at < now() - interval '90 days'
      ORDER BY balance DESC, id LIMIT 10`,
  );
  const [bx] = await db<MembersReport['bonusExpiring'][]>`
    SELECT coalesce(sum(remaining), 0) AS amount, count(DISTINCT member_id)::int AS members
    FROM bonus_lots WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at < now() + interval '30 days'`;
  return {
    from,
    to,
    totals: t!,
    activity: a!,
    period: p!,
    newByChannel: channels('fresh'),
    allByChannel: channels('total'),
    levels: [...levels.values()],
    topBalance: topBalance as MemberBrief[],
    topRecharge,
    dormantList: dormantList as MemberBrief[],
    bonusExpiring: bx!,
  };
}

/** 今日看板的值班数据：分时结账与接待、部门构成、在店最久的客人 */
export async function dutyExtras(db: Db, today: string, c: Clock): Promise<DutyExtras> {
  const rows = await db<{ hour: number; checkouts: number; arrivals: number }[]>`
    SELECT h AS hour,
           (SELECT count(*) FROM checkouts WHERE business_date = ${today} AND status = 'completed'
              AND extract(hour FROM created_at AT TIME ZONE ${c.tz}) = h)::int AS checkouts,
           (SELECT count(*) FROM visits WHERE business_date = ${today} AND status <> 'cancelled'
              AND extract(hour FROM checked_in_at AT TIME ZONE ${c.tz}) = h)::int AS arrivals
    FROM generate_series(0, 23) h ORDER BY h`;
  // 按营业日的顺序排（从切换时刻起），例如 06 点切换时 06、07 … 23、00 … 05
  const hourly = [...rows.slice(c.startHour), ...rows.slice(0, c.startHour)];
  const longStays = await db<DutyExtras['longStays']>`
    SELECT v.id AS visit_id, t.code AS tag_code, coalesce(m.name, nullif(v.guest_label, ''), '散客') AS guest, v.checked_in_at, b.amount_cents
    FROM visits v JOIN hand_tags t ON t.id = v.tag_id JOIN bills b ON b.id = v.bill_id LEFT JOIN members m ON m.id = v.member_id
    WHERE v.status = 'open' ORDER BY v.checked_in_at, v.id LIMIT 8`;
  return { hourly, departments: byCategory(await itemLines(db, today, today)), longStays };
}

const PeriodQuery = z.object({ from: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'), to: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD') });

export function registerDashboardReportRoutes(app: FastifyInstance, deps: Deps) {
  const clockAndToday = async () => {
    const s = await loadSettings(deps.sql);
    const c: Clock = { tz: deps.config.timezone, startHour: s.businessDayStartHour };
    return { c, today: businessDateOf(new Date(), c.tz, c.startHour) };
  };
  const realDate = (d: string) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  const period = (q: unknown, today: string) => {
    const { from, to } = parse(PeriodQuery, q);
    if (!realDate(from) || !realDate(to)) throw badRequest('日期不正确');
    if (from > to) throw badRequest('开始日期不能晚于结束日期');
    if (to > today) throw badRequest('结束日期不能晚于今天的营业日');
    if (daysBetween(from, to) > MAX_REPORT_DAYS) throw badRequest(`一次最多看 ${MAX_REPORT_DAYS} 天`);
    return { from, to };
  };

  app.get('/api/reports/executive', { preHandler: guard('report.executive') }, async (req) => {
    const { c, today } = await clockAndToday();
    const { from, to } = period(req.query, today);
    return readSnapshot(deps.sql, (tx) => executiveReport(tx, from, to, c));
  });

  app.get('/api/reports/members', { preHandler: guard('report.members') }, async (req) => {
    const { c, today } = await clockAndToday();
    const { from, to } = period(req.query, today);
    return readSnapshot(deps.sql, (tx) => membersReport(tx, from, to, c));
  });

  app.get('/api/reports/technicians', { preHandler: guard('report.technicians') }, async (req) => {
    const { today } = await clockAndToday();
    const { from, to } = period(req.query, today);
    return readSnapshot(deps.sql, (tx) => technicianReport(tx, from, to));
  });

  app.get('/api/reports/duty', { preHandler: guard('ledger.readToday') }, async () => {
    const { c, today } = await clockAndToday();
    return readSnapshot(deps.sql, (tx) => dutyExtras(tx, today, c));
  });
}
