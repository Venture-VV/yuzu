// 经营看板（S3.5）：今天的在店、营业额与收款，近 7 个营业日走势。只读汇总，口径与日结一致。

import type { FastifyInstance } from 'fastify';
import { businessDateOf } from '@shared/business-date';
import type { CheckoutMethod, DashboardData } from '@shared/checkout';
import { shiftDate } from '@shared/labels';
import { can } from '@shared/permissions';
import { readSnapshot, type Db } from '../db';
import { guard } from '../auth/guard';
import type { Deps } from '../lib/context';
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
  const t = await dayNet(db, today);
  const [guests] = await db<{ n: number; ticket: number }[]>`
    SELECT count(*)::int AS n, coalesce(sum(cb.ticket_amount), 0) AS ticket
    FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id WHERE c.business_date = ${today} AND c.status = 'completed'`;
  const byMethod = await db<{ method: CheckoutMethod; amount: number }[]>`
    SELECT p.method, sum(p.amount) AS amount FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    WHERE c.business_date = ${today} AND c.status = 'completed' GROUP BY p.method ORDER BY amount DESC`;
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
    inStore: store!,
    todayStats: {
      checkouts: t.checkouts,
      guests: guests!.n,
      net: t.net,
      ticket: guests!.ticket,
      byMethod,
      discount: byMethod.filter((m) => m.method === 'discount').reduce((sum, m) => sum + m.amount, 0),
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
