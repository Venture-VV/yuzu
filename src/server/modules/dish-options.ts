// 菜品的做法、加料、套餐在点单这一头的读法（8.1.15，docs/DISHES_V8115.md 第 5 节）：
//   · 点单页的菜单带上每道菜可选的做法、能点的加料、套餐含哪几样；
//   · 建出品单时把套餐当时含的几样记在出品单上（kitchen_items.parts，下单以后改了套餐不影响已经下的单）。
// 8.1.17（docs/DISHES_V8117.md）：做法带上分组、加价与必选的组；下单时核对用同一份（dish-lines.ts 的 planDishLines）。
// 都只读、不加锁。维护在 dishes.ts。单独放一个文件：点单（dining.ts）与菜品管理（dishes.ts）都要用，不互相引。

import { defaultTier, type TierPrice } from '@shared/catalog';
import type { MenuDish } from '@shared/dining';
import type { DishAddonOption, DishMethodGroup, DishMethodOption, DishPart } from '@shared/dishes';
import type { Db } from '../db';
import { pricesColumn } from './pricing';

export interface DishOptionSet {
  methods: DishMethodOption[];
  groups: DishMethodGroup[];
  addons: DishAddonOption[];
  combo: DishPart[];
}

/** 点单页的菜单：每道菜带上可选的做法、能点的加料、套餐含哪几样（有的才带，都没有的菜与以前一样） */
export async function withDishOptions(db: Db, dishes: MenuDish[]): Promise<MenuDish[]> {
  const options = await dishOptionsOf(
    db,
    dishes.map((d) => d.id),
  );
  return dishes.map((d) => {
    const o = options.get(d.id);
    if (!o) return d;
    return {
      ...d,
      ...(o.methods.length ? { methods: o.methods.map((m) => m.name), methodOptions: o.methods } : {}),
      ...(o.groups.length ? { methodGroups: o.groups } : {}),
      ...(o.addons.length ? { addons: o.addons } : {}),
      ...(o.combo.length ? { combo: o.combo } : {}),
    };
  });
}

const defaultPrice = (prices: TierPrice[]) => {
  const tier = defaultTier(prices);
  return prices.find((p) => p.tier === tier)?.price ?? prices[0]!.price;
};

/**
 * 这几道菜的做法（带分组、加价）、做法的组、加料、套餐内容（都没有的菜不在返回里）。
 * 加料只列现在能点的：在售、挂在启用的档口上、不需要技师（与点单页的菜单同一个口径）；价格是加料自己的默认价
 */
export async function dishOptionsOf(db: Db, itemIds: number[]): Promise<Map<number, DishOptionSet>> {
  const ids = [...new Set(itemIds)];
  const out = new Map<number, DishOptionSet>();
  if (ids.length === 0) return out;
  const at = (id: number) => {
    let set = out.get(id);
    if (!set) out.set(id, (set = { methods: [], groups: [], addons: [], combo: [] }));
    return set;
  };
  const methods = await db<{ itemId: number; name: string; groupName: string | null; price: number }[]>`
    SELECT item_id, name, group_name, price FROM dish_methods WHERE item_id IN ${db(ids)} ORDER BY item_id, sort_no, name`;
  for (const m of methods) at(m.itemId).methods.push({ name: m.name, group: m.groupName ?? '', price: m.price });
  const groups = await db<{ itemId: number; name: string; required: boolean }[]>`
    SELECT item_id, name, required FROM dish_method_groups WHERE item_id IN ${db(ids)} ORDER BY item_id, sort_no, name`;
  for (const g of groups) at(g.itemId).groups.push({ name: g.name, required: g.required });
  const addons = await db<{ itemId: number; id: number; name: string; prices: TierPrice[] }[]>`
    SELECT a.item_id, i.id, i.name, ${pricesColumn(db)} AS prices
    FROM dish_addons a JOIN service_items i ON i.id = a.addon_item_id JOIN kitchen_stations s ON s.id = i.station_id AND s.active
    WHERE a.item_id IN ${db(ids)} AND i.active AND NOT i.technician_required ORDER BY a.item_id, a.sort_no, i.id`;
  for (const a of addons) at(a.itemId).addons.push({ id: a.id, name: a.name, price: defaultPrice(a.prices) });
  for (const [id, parts] of await comboPartsOf(db, ids)) at(id).combo = parts;
  return out;
}

/** 这几个价目项目里是套餐的：现在含哪几样（每份套餐的份数），按维护时排的顺序 */
export async function comboPartsOf(db: Db, itemIds: number[]): Promise<Map<number, DishPart[]>> {
  const ids = [...new Set(itemIds)];
  const out = new Map<number, DishPart[]>();
  if (ids.length === 0) return out;
  const rows = await db<{ comboItemId: number; name: string; quantity: number }[]>`
    SELECT c.combo_item_id, i.name, c.quantity FROM dish_combo_items c JOIN service_items i ON i.id = c.item_id
    WHERE c.combo_item_id IN ${db(ids)} ORDER BY c.combo_item_id, c.sort_no, c.item_id`;
  for (const r of rows) out.set(r.comboItemId, [...(out.get(r.comboItemId) ?? []), { name: r.name, quantity: r.quantity }]);
  return out;
}
