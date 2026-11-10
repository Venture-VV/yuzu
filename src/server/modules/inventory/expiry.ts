// 批次与效期（8.0.7 ERP P2 3.3，docs/ERP_V807.md，迁移 103）与供应链的 ERP 待办数字。
//   · 管效期的物料：总仓的结存按最近的收货批次往回分（最近收的最后用，先进先出），剩下的是最新的几批；部门小仓不分批（V17）。
//   · 到期前 N 天（V18，默认 30）以内与已过期的批次列出、能导出，进 ERP 待办。
//   · 待办数字（库存、采购的导航）：待准入的供应商、快到期 / 过期的证照、呆滞、临期 / 过期的批次。只读，不加锁。

import type { FastifyInstance } from 'fastify';
import type { ExpiryLot, SupplyTodo } from '@shared/supply';
import type { Db } from '../../db';
import { guard } from '../../auth/guard';
import { csvReply, toCsv } from '../../lib/csv';
import type { Deps } from '../../lib/context';
import { daysBetween, todayIn } from '../../lib/dates';
import { loadSettings } from '../settings';
import { admissionCounts } from './admission';
import { slowMovingCount } from './slow';

/** 管效期的物料推算剩下的批次（只返回到期前 days 天以内与已过期的；days = Infinity 返回全部有到期日的） */
export async function expiryLots(db: Db, today: string, days: number): Promise<ExpiryLot[]> {
  const mats = await db<{ id: number; code: string; name: string; inventoryUnit: string; decimals: number; stockMilli: string }[]>`
    SELECT id, code, name, inventory_unit, decimals, stock_milli::text AS stock_milli FROM materials
    WHERE expiry_tracked AND tracked AND stock_milli > 0 ORDER BY code`;
  if (mats.length === 0) return [];
  const lines = await db<{ materialId: number; docId: number; docNo: string; docDate: string; qtyMilli: string; batchNo: string | null; expiresOn: string | null }[]>`
    SELECT l.material_id, d.id AS doc_id, d.doc_no, d.doc_date::text AS doc_date, l.qty_milli::text AS qty_milli, l.batch_no, l.expires_on::text AS expires_on
    FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
    WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND coalesce(d.warehouse_id, 1) = 1 AND l.qty_milli > 0
      AND l.material_id IN ${db(mats.map((m) => m.id))}
    ORDER BY l.material_id, d.doc_date DESC, d.id DESC, l.id DESC`;
  const out: ExpiryLot[] = [];
  for (const m of mats) {
    let rest = Number(m.stockMilli);
    for (const l of lines.filter((x) => Number(x.materialId) === Number(m.id))) {
      if (rest <= 0) break;
      const take = Math.min(rest, Number(l.qtyMilli));
      rest -= take;
      if (!l.expiresOn) continue;
      const daysLeft = daysBetween(today, l.expiresOn);
      if (daysLeft > days) continue;
      out.push({
        materialId: Number(m.id),
        code: m.code,
        name: m.name,
        inventoryUnit: m.inventoryUnit,
        decimals: m.decimals,
        docId: Number(l.docId),
        docNo: l.docNo,
        receivedDate: l.docDate,
        batchNo: l.batchNo ?? '',
        expiresOn: l.expiresOn,
        remainingMilli: take,
        daysLeft,
      });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.code.localeCompare(b.code));
}

export async function supplyTodo(db: Db, today: string): Promise<SupplyTodo> {
  const { licenseRemindDays, expiryRemindDays } = await loadSettings(db);
  const adm = await admissionCounts(db, today, licenseRemindDays);
  const lots = await expiryLots(db, today, expiryRemindDays);
  return {
    ...adm,
    slowMoving: await slowMovingCount(db, today),
    expiringLots: lots.filter((l) => l.daysLeft >= 0).length,
    expiredLots: lots.filter((l) => l.daysLeft < 0).length,
  };
}

export function registerExpiryRoutes(app: FastifyInstance, { sql, config }: Deps) {
  const today = () => todayIn(config.timezone);
  app.get('/api/inventory/expiry-lots', { preHandler: guard('inventory.read') }, async () => {
    const { expiryRemindDays } = await loadSettings(sql);
    return expiryLots(sql, today(), expiryRemindDays);
  });
  app.get('/api/inventory/expiry-lots/export', { preHandler: guard('inventory.read') }, async (_req, reply) => {
    const { expiryRemindDays } = await loadSettings(sql);
    const lots = await expiryLots(sql, today(), expiryRemindDays);
    const csv = toCsv([
      ['物料编码', '物料', '批号', '收货日', '收货单', '到期日', '还剩几天', '推算剩余', '单位'],
      ...lots.map((l) => [l.code, l.name, l.batchNo, l.receivedDate, l.docNo, l.expiresOn, l.daysLeft, (l.remainingMilli / 1000).toFixed(l.decimals), l.inventoryUnit]),
    ]);
    return csvReply(reply, `临期批次_${today()}.csv`, csv);
  });
  app.get('/api/inventory/supply-todo', { preHandler: guard('inventory.read') }, async () => supplyTodo(sql, today()));
}
