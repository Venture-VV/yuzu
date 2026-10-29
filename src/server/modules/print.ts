// 打印用的只读数据（R1.3）：80mm 结账单。交班表直接用 /api/shifts/:id 的班次记录。
// 不改任何单据；结账单在同一个快照里读结账单、明细与余额流水。

import type { FastifyInstance } from 'fastify';
import type { CheckoutPrint, CheckoutPrintLine } from '@shared/print';
import { guard } from '../auth/guard';
import { readSnapshot, type Db } from '../db';
import type { Deps } from '../lib/context';
import { idParam, parse } from '../lib/validate';
import { getCheckout } from './frontdesk/checkout';

export async function checkoutForPrint(db: Db, id: number): Promise<CheckoutPrint> {
  const detail = await getCheckout(db, id);
  const billIds = detail.bills.map((b) => b.billId);
  // 结账那一刻的明细：结账时已经挂上、当时还没作废的。反结账时作废的门票照样打出，之后新挂的明细不算这张单
  const lines = billIds.length
    ? await db<(CheckoutPrintLine & { billId: number })[]>`
        SELECT l.bill_id, l.name, l.unit_price, l.quantity, l.amount
        FROM bill_lines l JOIN checkouts c ON c.id = ${id}
        WHERE l.bill_id IN ${db(billIds)} AND l.posted_at <= c.created_at AND (l.voided_at IS NULL OR l.voided_at > c.created_at)
        ORDER BY l.bill_id, l.id`
    : [];
  const consumptionIds = detail.payments.flatMap((p) => (p.consumption ? [p.consumption.id] : []));
  const entries = consumptionIds.length
    ? await db<{ consumptionId: number; principalDelta: number; bonusDelta: number; principalAfter: number; bonusAfter: number }[]>`
        SELECT consumption_id, principal_delta, bonus_delta, principal_after, bonus_after FROM ledger_entries
        WHERE consumption_id IN ${db(consumptionIds)} AND entry_type = 'consume'`
    : [];
  return {
    ...detail,
    bills: detail.bills.map((b) => {
      const own = lines.filter((l) => l.billId === b.billId).map(({ name, unitPrice, quantity, amount }) => ({ name, unitPrice, quantity, amount }));
      return { ...b, lines: own, linesTotal: own.reduce((s, l) => s + l.amount, 0) };
    }),
    payments: detail.payments.map((p) => {
      const e = p.consumption ? entries.find((x) => x.consumptionId === p.consumption!.id) : undefined;
      return {
        ...p,
        balance: e
          ? {
              before: { principal: e.principalAfter - e.principalDelta, bonus: e.bonusAfter - e.bonusDelta },
              after: { principal: e.principalAfter, bonus: e.bonusAfter },
            }
          : null,
      };
    }),
  };
}

export function registerPrintRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/print/checkouts/:id', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return readSnapshot(deps.sql, (tx) => checkoutForPrint(tx, id));
  });
}
