// 经营看板（S3.5）：今天的在店、营业额与收款，近 7 个营业日走势。只读汇总，口径与日结一致。

import type { FastifyInstance } from 'fastify';
import { businessDateOf } from '@shared/business-date';
import { priceTicket, type CheckoutMethod, type DashboardData } from '@shared/checkout';
import { shiftDate } from '@shared/labels';
import { can } from '@shared/permissions';
import { readSnapshot, type Db } from '../db';
import { guard } from '../auth/guard';
import type { Deps } from '../lib/context';
import { loadFrontdeskRules } from './frontdesk/common';
import { loadSettings } from './settings';

async function dayNet(db: Db, date: string) {
  const [row] = await db<{ net: number; checkouts: number; rechargePaid: number }[]>`
    SELECT
      (SELECT coalesce(sum(total_amount) FILTER (WHERE business_date = ${date}), 0)
              - coalesce(sum(total_amount) FILTER (WHERE void_business_date = ${date}), 0)
       FROM checkouts WHERE business_date = ${date} OR void_business_date = ${date}) AS net,
      (SELECT count(*) FROM checkouts WHERE business_date = ${date} AND status = 'completed')::int AS checkouts,
      (SELECT coalesce(sum(paid_amount), 0) FROM recharges WHERE business_date = ${date}) AS recharge_paid`;
  return row!;
}

export async function dashboard(db: Db, today: string, days: number): Promise<DashboardData> {
  const [store] = await db<{ count: number; unsettled: number }[]>`
    SELECT count(*)::int AS count, coalesce(sum(b.amount_cents), 0) AS unsettled
    FROM visits v JOIN bills b ON b.id = v.bill_id WHERE v.status = 'open'`;
  // 在店客人的门票按此刻（反结账后重结的按第一次结账的时刻）估算，与结账前核对同一算法；没选票种的不计入
  const { overtimeGraceMinutes } = await loadFrontdeskRules(db);
  const open = await db<{ checkedInAt: string; price12h: number | null; price24h: number | null; ticketEndAt: string | null; now: string }[]>`
    SELECT checked_in_at, ticket_price_12h AS price12h, ticket_price_24h AS price24h, ticket_end_at, now() AS now
    FROM visits WHERE status = 'open'`;
  let ticketEstimate = 0;
  for (const v of open) {
    if (v.price12h === null || v.price24h === null) continue;
    const end = new Date(v.ticketEndAt ?? v.now);
    ticketEstimate += priceTicket({ price12h: v.price12h, price24h: v.price24h }, v.checkedInAt, end, overtimeGraceMinutes).amount;
  }
  const noTicket = open.filter((v) => v.price12h === null).length;
  const t = await dayNet(db, today);
  const [guests] = await db<{ n: number; ticket: number }[]>`
    SELECT count(*)::int AS n, coalesce(sum(cb.ticket_amount), 0) AS ticket
    FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id WHERE c.business_date = ${today} AND c.status = 'completed'`;
  const byMethod = await db<{ method: CheckoutMethod; amount: number }[]>`
    SELECT p.method, sum(p.amount) AS amount FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    WHERE c.business_date = ${today} AND c.status = 'completed' GROUP BY p.method ORDER BY amount DESC`;
  // 优惠 / 免单与营业额同一口径（与日结 businessTotals 一致）：当日结账的加上、当日反结账的减去，
  // 前一营业日带优惠的单今天反结账时冲回优惠，净营业额只减「应收 − 优惠」
  const [discount] = await db<{ amount: number }[]>`
    SELECT coalesce(sum(p.amount) FILTER (WHERE c.business_date = ${today}), 0)
             - coalesce(sum(p.amount) FILTER (WHERE c.void_business_date = ${today}), 0) AS amount
    FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    WHERE p.method = 'discount' AND (c.business_date = ${today} OR c.void_business_date = ${today})`;
  const [rc] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM recharges WHERE business_date = ${today}`;
  const tickets = await db<DashboardData['tickets']>`
    SELECT cb.ticket_name AS name, count(*)::int AS count, sum(cb.ticket_amount) AS amount
    FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id WHERE c.business_date = ${today} AND c.status = 'completed'
    GROUP BY cb.ticket_name ORDER BY count DESC`;
  const history: DashboardData['days'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = shiftDate(today, -i);
    history.push({ date, ...(i === 0 ? t : await dayNet(db, date)) });
  }
  const openShifts = await db<DashboardData['openShifts']>`
    SELECT s.shift_no, st.display_name AS staff_name, s.started_at FROM shifts s JOIN staff st ON st.id = s.staff_id
    WHERE s.status = 'open' ORDER BY s.started_at`;
  return {
    today,
    inStore: { ...store!, ticketEstimate, noTicket },
    todayStats: {
      checkouts: t.checkouts,
      guests: guests!.n,
      net: t.net,
      ticket: guests!.ticket,
      byMethod,
      discount: discount!.amount,
      rechargePaid: t.rechargePaid,
      rechargeCount: rc!.n,
    },
    tickets,
    days: history,
    openShifts,
  };
}

export function registerDashboardRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/dashboard', { preHandler: guard('ledger.readToday') }, async (req) => {
    const settings = await loadSettings(deps.sql);
    const today = businessDateOf(new Date(), deps.config.timezone, settings.businessDayStartHour);
    // 历史营业日需要对应权限；没有时只看今天
    const days = can(req.actor, 'ledger.readHistory') ? 7 : 1;
    return readSnapshot(deps.sql, (tx) => dashboard(tx, today, days));
  });
}
