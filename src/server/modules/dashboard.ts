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
      ((SELECT count(*) FROM checkouts WHERE business_date = ${date}) - (SELECT count(*) FROM checkouts WHERE void_business_date = ${date}))::int AS checkouts,
      (SELECT coalesce(sum(paid_amount), 0) FROM recharges WHERE business_date = ${date}) AS recharge_paid`;
  return row!;
}

export async function dashboard(db: Db, today: string, days: number, opts: { inStore: boolean } = { inStore: true }): Promise<DashboardData> {
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
  // 结账客人、门票、收款构成与日结同一营业口径（v0.7.1，测试会话 PR #15 问题 2）：当天结的计正数、当天反结账的计负数，
  // 前一营业日的单今天反结账时，原营业日不变、今天冲回
  const [guests] = await db<{ n: number; ticket: number }[]>`
    SELECT (coalesce(sum(cb.guests) FILTER (WHERE c.business_date = ${today}), 0) - coalesce(sum(cb.guests) FILTER (WHERE c.void_business_date = ${today}), 0))::int AS n,
           coalesce(sum(cb.ticket_amount) FILTER (WHERE c.business_date = ${today}), 0)
             - coalesce(sum(cb.ticket_amount) FILTER (WHERE c.void_business_date = ${today}), 0) AS ticket
    FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id WHERE c.business_date = ${today} OR c.void_business_date = ${today}`;
  // 当天的退款单（v0.7.20）按退款方式冲减
  const byMethod = await db<{ method: CheckoutMethod; amount: number }[]>`
    WITH x AS (
      SELECT p.method,
             coalesce(sum(p.amount) FILTER (WHERE c.business_date = ${today}), 0) - coalesce(sum(p.amount) FILTER (WHERE c.void_business_date = ${today}), 0) AS amount
      FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
      WHERE c.business_date = ${today} OR c.void_business_date = ${today}
      GROUP BY p.method
      UNION ALL
      SELECT p.method, -sum(p.amount) FROM refund_payments p JOIN refunds r ON r.id = p.refund_id
      WHERE r.status = 'completed' AND r.business_date = ${today} GROUP BY p.method
    )
    SELECT method, sum(amount)::bigint AS amount FROM x GROUP BY method HAVING sum(amount) <> 0 ORDER BY amount DESC`;
  // 优惠 / 免单与营业额同一口径（与日结 businessTotals 一致）：当日结账的加上、当日反结账的减去，
  // 前一营业日带优惠的单今天反结账时冲回优惠，净营业额只减「应收 − 优惠」
  const [discount] = await db<{ amount: number; coupon: number; refund: number }[]>`
    SELECT coalesce(sum(p.amount) FILTER (WHERE p.method = 'discount' AND c.business_date = ${today}), 0)
             - coalesce(sum(p.amount) FILTER (WHERE p.method = 'discount' AND c.void_business_date = ${today}), 0) AS amount,
           coalesce(sum(p.amount) FILTER (WHERE p.method = 'store_coupon' AND c.business_date = ${today}), 0)
             - coalesce(sum(p.amount) FILTER (WHERE p.method = 'store_coupon' AND c.void_business_date = ${today}), 0) AS coupon,
           (SELECT coalesce(sum(amount), 0) FROM refunds WHERE status = 'completed' AND business_date = ${today}) AS refund
    FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    WHERE p.method IN ('discount', 'store_coupon') AND (c.business_date = ${today} OR c.void_business_date = ${today})`;
  const [rc] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM recharges WHERE business_date = ${today}`;
  const tickets = await db<DashboardData['tickets']>`
    SELECT cb.ticket_name AS name,
           (count(*) FILTER (WHERE c.business_date = ${today}) - count(*) FILTER (WHERE c.void_business_date = ${today}))::int AS count,
           coalesce(sum(cb.ticket_amount) FILTER (WHERE c.business_date = ${today}), 0) - coalesce(sum(cb.ticket_amount) FILTER (WHERE c.void_business_date = ${today}), 0) AS amount
    FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id
    WHERE (c.business_date = ${today} OR c.void_business_date = ${today}) AND cb.ticket_name IS NOT NULL
    GROUP BY cb.ticket_name
    HAVING count(*) FILTER (WHERE c.business_date = ${today}) <> count(*) FILTER (WHERE c.void_business_date = ${today})
        OR coalesce(sum(cb.ticket_amount) FILTER (WHERE c.business_date = ${today}), 0) <> coalesce(sum(cb.ticket_amount) FILTER (WHERE c.void_business_date = ${today}), 0)
    ORDER BY count DESC`;
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
    // 在店客人只给能看前台的岗位（v0.7.1）
    inStore: opts.inStore ? { ...store!, ticketEstimate, noTicket } : null,
    todayStats: {
      checkouts: t.checkouts,
      guests: guests!.n,
      net: t.net,
      ticket: guests!.ticket,
      byMethod,
      discount: discount!.amount,
      coupon: discount!.coupon,
      refund: discount!.refund,
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
    return readSnapshot(deps.sql, (tx) => dashboard(tx, today, days, { inStore: can(req.actor, 'frontdesk.read') }));
  });
}
