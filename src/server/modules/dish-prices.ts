// 菜品的改价记录（8.1.15，docs/DISHES_V8115.md 第 4 节）：改前、改后、谁、几点、原因、从哪里改的，只追加。
// 菜品管理的改价、菜品导入，以及后台价目里改到菜品价格的两处（单个项目、价目表导入）都记到这里；
// 以前的订单照下单时的价（明细上留着当时的单价），这里不碰明细。
// 单独放一个文件：后台价目（catalog.ts）与菜品管理（dishes.ts）都要用，不互相引。

import { sortTiers, type TierPrice } from '@shared/catalog';
import { priceDiff, type DishPriceSource } from '@shared/dishes';
import type { Db, Tx } from '../db';
import { pricesColumn } from './pricing';

/** 这几个价目项目里哪些是菜品（挂了出品档口、不需要技师）：只有菜品的改价进改价记录 */
export async function dishIdsAmong(db: Db, itemIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return new Set();
  const rows = await db<{ id: number }[]>`SELECT id FROM service_items WHERE id IN ${db(ids)} AND station_id IS NOT NULL AND NOT technician_required`;
  return new Set(rows.map((r) => r.id));
}

/** 这个价目项目是菜品时，它现在的名称与各档的价（全公司的价目）；不是菜品返回 null。改之前取一次，改完交给 recordPriceChanges */
export async function dishPriceState(db: Db, itemId: number): Promise<{ name: string; prices: TierPrice[] } | null> {
  const [row] = await db<{ name: string; prices: TierPrice[] }[]>`
    SELECT i.name, ${pricesColumn(db, { base: true })} AS prices FROM service_items i
    WHERE i.id = ${itemId} AND i.station_id IS NOT NULL AND NOT i.technician_required`;
  return row ? { name: row.name, prices: sortTiers(row.prices) } : null;
}

/**
 * 记下一道菜这次改了哪几档（调用方的事务里，菜品那一行已经锁住）：没改的档不记；返回记了几条。
 * before 为空数组 = 新建菜品的定价。
 */
export async function recordPriceChanges(
  tx: Tx,
  args: { itemId: number; itemName: string; before: readonly TierPrice[]; after: readonly TierPrice[]; reason: string; source: DishPriceSource; staffId: number | null },
): Promise<number> {
  const diff = priceDiff(args.before, args.after);
  for (const d of diff) {
    await tx`
      INSERT INTO dish_price_changes (item_id, item_name, tier, old_price, new_price, reason, source, staff_id)
      VALUES (${args.itemId}, ${args.itemName}, ${d.tier}, ${d.oldPrice}, ${d.newPrice}, ${args.reason}, ${args.source}, ${args.staffId})`;
  }
  return diff.length;
}
