// 8.1.7 点菜单（小票可视化，docs/DINING_V817.md 第 6 节，PENDING_DECISIONS.md CF8、CF9）：
// 一桌（开台）或一位手牌客人（来访）点过的餐饮明细，按每次下单分段（同一张出品单号；不进厨房的按同一次挂账），
// 每道菜标已上 / 未上 / 制作中 / 已出餐 / 已退。只读，不加锁；已经结账、撤台、离店的也能看。

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { diningSlotOf, receiptLineState, type DiningReceipt, type DiningReceiptLine, type DiningReceiptOrder, type KitchenStatus } from '@shared/dining';
import type { Db } from '../db';
import type { Deps } from '../lib/context';
import { notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { guardAny } from '../auth/guard';
import { currentStoreId } from '../lib/store-context';
import { loadDiningRules } from './dining';

const ReceiptQuery = z
  .object({
    session: z.coerce.number().int().positive().optional(),
    visit: z.coerce.number().int().positive().optional(),
  })
  .refine((q) => (q.session === undefined) !== (q.visit === undefined), '请指定一桌（session）或一位手牌客人（visit）');

interface Head {
  id: number;
  title: string;
  zone: string;
  guest: string;
  guests: number | null;
  openedAt: string;
  closed: boolean;
  billId: number;
}

interface LineRow {
  billLineId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  status: 'active' | 'voided';
  postedAt: string;
  postKey: string | null;
  postedByName: string;
  category: string | null;
  diningOutlet: string | null;
  diningGroup: string | null;
  stationName: string | null;
  kitchenStatus: KitchenStatus | null;
  note: string | null;
  orderNo: string | null;
}

export async function diningReceipt(db: Db, q: { session?: number; visit?: number }): Promise<DiningReceipt> {
  const rules = await loadDiningRules(db);
  let head: Head | undefined;
  if (q.session !== undefined) {
    [head] = await db<Head[]>`
      SELECT s.id, t.name AS title, t.area AS zone, coalesce(m.name, nullif(s.guest_label, ''), '散客') AS guest, s.guests,
             s.opened_at, s.status <> 'open' AS closed, s.bill_id
      FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id LEFT JOIN members m ON m.id = s.member_id
      WHERE s.id = ${q.session} AND s.store_id = ${currentStoreId()}`;
    if (!head) throw notFound('开台记录不存在');
  } else {
    [head] = await db<Head[]>`
      SELECT v.id, h.code AS title, '' AS zone, coalesce(m.name, nullif(v.guest_label, ''), '散客') AS guest, NULL::int AS guests,
             v.checked_in_at AS opened_at, v.status <> 'open' AS closed, v.bill_id
      FROM visits v JOIN hand_tags h ON h.id = v.tag_id JOIN bills b ON b.id = v.bill_id AND b.store_id = ${currentStoreId()}
      LEFT JOIN members m ON m.id = v.member_id
      WHERE v.id = ${q.visit!}`;
    if (!head) throw notFound('这位客人的来访记录不存在');
  }

  const rows = await db<LineRow[]>`
    SELECT l.id AS bill_line_id, l.name, l.quantity, l.unit_price, l.amount, l.status, l.posted_at, l.post_key, p.display_name AS posted_by_name,
           si.category, si.dining_outlet, si.dining_group, ks.name AS station_name,
           k.status AS kitchen_status, k.note, k.order_no
    FROM bill_lines l JOIN staff p ON p.id = l.posted_by
    LEFT JOIN service_items si ON si.id = l.item_id LEFT JOIN kitchen_stations ks ON ks.id = si.station_id
    LEFT JOIN kitchen_items k ON k.bill_line_id = l.id
    WHERE l.bill_id = ${head.billId} AND l.source = 'dining'
    ORDER BY l.posted_at, l.id`;

  // 每次下单一段：同一张出品单号；没有出品单的按同一次挂账（操作编号），再没有就一条一段
  const groups = new Map<string, { orderNo: string | null; postedAt: string; postedByName: string; lines: DiningReceiptLine[] }>();
  for (const r of rows) {
    const key = r.orderNo ? `o:${r.orderNo}` : r.postKey ? `k:${r.postKey}` : `l:${r.billLineId}`;
    const slot = diningSlotOf({ outlet: r.diningOutlet, group: r.diningGroup, category: r.category, stationName: r.stationName });
    const line: DiningReceiptLine = {
      billLineId: Number(r.billLineId),
      name: r.name,
      outlet: slot.outlet,
      group: slot.group,
      quantity: r.quantity,
      unitPrice: Number(r.unitPrice),
      amount: Number(r.amount),
      note: r.note ?? '',
      kitchenStatus: r.kitchenStatus,
      state: receiptLineState(r.status, r.kitchenStatus, rules.trackServed),
    };
    const g = groups.get(key);
    if (g) g.lines.push(line);
    else groups.set(key, { orderNo: r.orderNo, postedAt: new Date(r.postedAt).toISOString(), postedByName: r.postedByName, lines: [line] });
  }
  const orders: DiningReceiptOrder[] = [...groups.values()].sort((a, b) => a.postedAt.localeCompare(b.postedAt)).map((g, i) => ({ seq: i + 1, ...g }));

  const all = orders.flatMap((o) => o.lines);
  const sum = (list: DiningReceiptLine[]) => list.reduce((n, l) => n + l.quantity, 0);
  const active = all.filter((l) => l.state !== 'voided');
  return {
    kind: q.session !== undefined ? 'table' : 'tag',
    id: Number(head.id),
    title: head.title,
    zone: head.zone,
    guest: head.guest,
    guests: head.guests,
    openedAt: new Date(head.openedAt).toISOString(),
    closed: head.closed,
    serverTime: new Date().toISOString(),
    trackServed: rules.trackServed,
    orders,
    totals: {
      quantity: sum(active),
      served: sum(active.filter((l) => l.state === 'served')),
      waiting: sum(active.filter((l) => l.state !== 'served')),
      voided: sum(all.filter((l) => l.state === 'voided')),
      amount: active.reduce((n, l) => n + l.amount, 0),
    },
  };
}

export function registerDiningReceiptRoutes(app: FastifyInstance, deps: Deps) {
  // 与桌台详情、点单相同的岗位：点单的、结账的
  app.get('/api/dining/receipt', { preHandler: guardAny('dining.order', 'frontdesk.checkout') }, async (req) => diningReceipt(deps.sql, parse(ReceiptQuery, req.query)));
}
