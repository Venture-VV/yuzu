// 菜品的做法、加料、套餐在点单这一头的读法（8.1.15，docs/DISHES_V8115.md 第 5 节）：
//   · 点单页的菜单带上每道菜可选的做法、能点的加料、套餐含哪几样；
//   · 建出品单时把套餐当时含的几样记在出品单上（kitchen_items.parts，下单以后改了套餐不影响已经下的单）。
// 8.1.17（docs/DISHES_V8117.md）：做法带上分组、加价与必选的组；下单时核对用同一份（dish-lines.ts 的 planDishLines）。
// 都只读、不加锁。维护在 dishes.ts。单独放一个文件：点单（dining.ts）与菜品管理（dishes.ts）都要用，不互相引。

import { defaultTier, type TierPrice } from '@shared/catalog';
import type { MenuDish } from '@shared/dining';
import type { ComboPartOption, ComboSwapOption, DishAddonOption, DishMethodGroup, DishMethodOption, DishPart } from '@shared/dishes';
import type { Db } from '../db';
import { pricesColumn } from './pricing';

export interface DishOptionSet {
  methods: DishMethodOption[];
  groups: DishMethodGroup[];
  addons: DishAddonOption[];
  combo: ComboPartOption[];
}

/**
 * 点单页的菜单：每道菜带上可选的做法、能点的加料、套餐含哪几样（有的才带，都没有的菜与以前一样）。
 * 8.1.17（BW7）：给了营业日的，套餐今天还能卖几份 = 自己的沽清与子项里最少能做的份数（可换的子项按能换成的里最多的那一样算）
 */
export async function withDishOptions(db: Db, dishes: MenuDish[], today?: string): Promise<MenuDish[]> {
  const options = await dishOptionsOf(
    db,
    dishes.map((d) => d.id),
  );
  const comboLeft = today
    ? await comboRemainingOf(
        db,
        [...options].filter(([, o]) => o.combo.length > 0).map(([id]) => id),
        today,
      )
    : new Map<number, number | null>();
  return dishes.map((d) => {
    const o = options.get(d.id);
    if (!o) return d;
    const left = comboLeft.get(d.id);
    return {
      ...d,
      ...(left !== undefined && left !== null ? { remaining: d.remaining === null ? left : Math.min(d.remaining, left) } : {}),
      ...(o.methods.length ? { methods: o.methods.map((m) => m.name), methodOptions: o.methods } : {}),
      ...(o.groups.length ? { methodGroups: o.groups } : {}),
      ...(o.addons.length ? { addons: o.addons } : {}),
      ...(o.combo.length ? { combo: o.combo } : {}),
    };
  });
}

/** 套餐的一样（8.1.17）：价目项目、每份几份、自己的档口（停用了、没挂档口的为 null，跟着套餐出）、能不能换、能换成哪几样 */
export interface ComboDef {
  itemId: number;
  name: string;
  quantity: number;
  stationId: number | null;
  swappable: boolean;
  swaps: (ComboSwapOption & { stationId: number | null })[];
}

/** 这几个价目项目里是套餐的：现在含哪几样（按维护时排的顺序），带上各自的档口与可换成的几样 */
export async function comboDefsOf(db: Db, itemIds: number[]): Promise<Map<number, ComboDef[]>> {
  const ids = [...new Set(itemIds)];
  const out = new Map<number, ComboDef[]>();
  if (ids.length === 0) return out;
  const rows = await db<{ comboItemId: number; itemId: number; name: string; quantity: number; swappable: boolean; stationId: number | null }[]>`
    SELECT c.combo_item_id, c.item_id, i.name, c.quantity, c.swappable, CASE WHEN s.active THEN i.station_id END AS station_id
    FROM dish_combo_items c JOIN service_items i ON i.id = c.item_id LEFT JOIN kitchen_stations s ON s.id = i.station_id
    WHERE c.combo_item_id IN ${db(ids)} ORDER BY c.combo_item_id, c.sort_no, c.item_id`;
  if (rows.length === 0) return out;
  const swaps = await db<{ comboItemId: number; itemId: number; toItemId: number; name: string; priceDiff: number; available: boolean; stationId: number | null }[]>`
    SELECT w.combo_item_id, w.item_id, w.to_item_id, i.name, w.price_diff,
           (i.active AND NOT i.technician_required AND coalesce(s.active, false)) AS available, CASE WHEN s.active THEN i.station_id END AS station_id
    FROM dish_combo_swaps w JOIN service_items i ON i.id = w.to_item_id LEFT JOIN kitchen_stations s ON s.id = i.station_id
    WHERE w.combo_item_id IN ${db(ids)} ORDER BY w.combo_item_id, w.item_id, w.sort_no, w.to_item_id`;
  for (const r of rows) {
    const mine = swaps
      .filter((w) => w.comboItemId === r.comboItemId && w.itemId === r.itemId)
      .map((w) => ({ itemId: w.toItemId, name: w.name, priceDiff: w.priceDiff, available: w.available, stationId: w.stationId }));
    out.set(r.comboItemId, [
      ...(out.get(r.comboItemId) ?? []),
      { itemId: r.itemId, name: r.name, quantity: r.quantity, stationId: r.stationId, swappable: r.swappable, swaps: r.swappable ? mine : [] },
    ]);
  }
  return out;
}

/**
 * 套餐今天还能卖几份（8.1.17 BW7）：子项各自扣沽清，所以是子项里最少能做的份数（这一样的余量 ÷ 每份几份，向下取整）；
 * 可换的子项按它与能换成的（在售的）里最多的那一样算。子项都不限量的为 null。套餐自己设的沽清另外算（调用方取小的）
 */
export async function comboRemainingOf(db: Db, comboIds: number[], today: string): Promise<Map<number, number | null>> {
  const defs = await comboDefsOf(db, comboIds);
  const out = new Map<number, number | null>();
  const itemIds = [...new Set([...defs.values()].flatMap((parts) => parts.flatMap((p) => [p.itemId, ...p.swaps.map((w) => w.itemId)])))];
  if (itemIds.length === 0) return out;
  const limits = new Map(
    (await db<{ itemId: number; remaining: number }[]>`SELECT item_id, remaining FROM dish_limits WHERE item_id IN ${db(itemIds)} AND business_date = ${today}`).map((r) => [r.itemId, r.remaining]),
  );
  const can = (itemId: number, perCombo: number) => {
    const left = limits.get(itemId);
    return left === undefined ? Infinity : Math.floor(left / perCombo);
  };
  for (const [comboId, parts] of defs) {
    const n = Math.min(...parts.map((p) => Math.max(can(p.itemId, p.quantity), ...p.swaps.filter((w) => w.available).map((w) => can(w.itemId, p.quantity)))));
    out.set(comboId, Number.isFinite(n) ? n : null);
  }
  return out;
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
  // 套餐（8.1.17 起带价目项目与可换成的几样）
  for (const [id, parts] of await comboDefsOf(db, ids)) {
    at(id).combo = parts.map((p) => ({
      name: p.name,
      quantity: p.quantity,
      itemId: p.itemId,
      ...(p.swappable && p.swaps.length ? { swaps: p.swaps.map(({ stationId: _stationId, ...w }) => w) } : {}),
    }));
  }
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
