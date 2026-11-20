// 菜品管理（8.1.15，店主 2026-11-19《浴族系统需求汇总》餐饮第 4 条，docs/DISHES_V8115.md）。
//
// 菜品就是现有的餐饮价目项目（service_items 里挂了出品档口、不需要技师的），不另建「菜品表」：这里给它一个统一的维护入口——
// 一张表看全部菜品，新增 / 编辑（名称、分类、出品口与小类、档口、图片、做法、加料、套餐内容），上下架，改价（单独一项权限、写改价记录），
// Excel 导出与导入（dishes-import.ts）。点单那一头怎么读做法、加料、套餐在 dish-options.ts。
//
// 权限：看 = 有任一项菜品权限；维护按出品口分三项（这道菜现在所在的出品口、要挪去的出品口都要有）；定价、改价再要「定价与改价」。
// 都在锁住这道菜以后按库里的出品口核对，页面上看到的不算数。
//
// 结果待确认（8.1.16，Codex 审查 d12390f 的 P1）：编辑、上下架、改价都带页面打开时看到的版本（rev），在锁里核对，对不上整笔拒绝——
// 延迟到达的旧请求不会再把菜改回去（上架以后别人又下架了，晚到的那笔上架被拒绝）；导入的预览摘要里带上要改的那几道菜的版本。
// 页面在结果不明时把原编号与原请求存在本机，只能按编号查回、按原内容重提或确认作废（作废记在 dish_ops：原请求之后再到也整笔不做）。
//
// 加锁（docs/LOCKING.md 第 1 节）：操作编号的咨询锁 →「菜品维护」咨询锁（菜品管理的写入全部串行）→ 这道菜与它引用的加料、套餐子项
// （service_items，id 升序，FOR NO KEY UPDATE；与后台价目、后台「出品档口与菜品」同一批行、同一个顺序）→ 做法 / 加料 / 套餐子表 → 改价记录 → 操作记录。
// 导入锁全部价目项目（id 升序，与价目表导入相同）。不碰来访、账单、出品单的锁；点单读价目与做法都不加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { defaultTier, PRICE_TIERS, sortTiers, tierPrice, type TierPrice } from '@shared/catalog';
import { DINING_OUTLET_LABELS, diningSlotOf, parseSlotKey, slotLabel, type DiningOutlet, type DiningSlot } from '@shared/dining';
import {
  DISH_EXPORT_EXTRA_COLUMNS,
  DISH_OP_LABELS,
  DISH_OP_TYPES,
  DISH_OUTLET_PERMISSIONS,
  DISH_PERMISSIONS,
  DISH_PRICE_PERMISSION,
  DISH_SHEET_COLUMNS,
  filterDishes,
  isDishStatusFilter,
  MAX_COMBO_ITEM_QUANTITY,
  MAX_COMBO_ITEMS,
  MAX_DISH_ADDONS,
  MAX_DISH_CATEGORY,
  MAX_DISH_METHOD_LENGTH,
  MAX_DISH_METHODS,
  MAX_DISH_NAME,
  MAX_PRICE_REASON,
  partsText,
  priceChangeText,
  priceDiff,
  pricesText,
  remainingText,
  type DishAddonRef,
  type DishComboRef,
  type DishFilter,
  type DishOpLookup,
  type DishOpType,
  type DishPriceChange,
  type DishPriceSource,
  type DishRow,
  type DishSaveResult,
  type DishesBoard,
} from '@shared/dishes';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Actor, type Deps, type OpContext } from '../lib/context';
import { attachment } from '../lib/csv';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse, positiveCents } from '../lib/validate';
import { buildXlsx } from '../lib/xlsx';
import { recordPriceChanges } from './dish-prices';
import { emenuImage, saveEmenuImage } from './emenu/core';
import { abandonedError, businessDate } from './frontdesk/common';
import { pricesColumn } from './pricing';

/** 菜品的图片地址（图存在电子菜单的图片表里；这个地址给有菜品权限的人看） */
const dishImageUrl = (id: number | null | undefined) => (id ? `/api/dining/dishes/images/${id}` : null);

/** 版本：这一行最后一次修改的时刻（微秒）。后台价目、出品档口那几处改这一行时也会动它 */
const REV = (db: Db) => db`(extract(epoch FROM i.updated_at) * 1000000)::bigint::text`;

const defaultPrice = (prices: readonly TierPrice[]) => tierPrice(prices, defaultTier(prices)!)!;

// ───────────────────────── 读：菜品表 ─────────────────────────

interface DishBase {
  id: number;
  name: string;
  category: string;
  active: boolean;
  stationId: number;
  stationName: string;
  stationActive: boolean;
  diningOutlet: string | null;
  diningGroup: string;
  dishImageId: number | null;
  prices: TierPrice[];
  remaining: number | null;
  emenuName: string | null;
  emenuImageId: number | null;
  rev: string;
  updatedAt: string;
}

/** 全部菜品（或给定的几道）：挂了出品档口、不需要技师的价目项目，含下架的、档口停用的 */
async function loadDishRows(db: Db, today: string, onlyIds?: number[]): Promise<DishRow[]> {
  if (onlyIds && onlyIds.length === 0) return [];
  const rows = await db<DishBase[]>`
    SELECT i.id, i.name, i.category, i.active, i.station_id, s.name AS station_name, s.active AS station_active, i.dining_outlet, i.dining_group,
           i.dish_image_id, ${pricesColumn(db, { base: true })} AS prices,
           (SELECT d.remaining FROM dish_limits d WHERE d.item_id = i.id AND d.business_date = ${today}) AS remaining,
           ed.name AS emenu_name, ed.image_id AS emenu_image_id, ${REV(db)} AS rev, i.updated_at
    FROM service_items i JOIN kitchen_stations s ON s.id = i.station_id
    LEFT JOIN emenu_dish_specs sp ON sp.item_id = i.id LEFT JOIN emenu_dishes ed ON ed.id = sp.dish_id
    WHERE NOT i.technician_required ${onlyIds ? db`AND i.id IN ${db(onlyIds)}` : db``}
    ORDER BY i.active DESC, s.sort_order, s.id, i.sort_order, i.id`;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const methods = await db<{ itemId: number; name: string }[]>`SELECT item_id, name FROM dish_methods WHERE item_id IN ${db(ids)} ORDER BY item_id, sort_no, name`;
  // 加料、套餐：自己的（按这道菜找）与被谁用（按加料、子项找）一次取回来
  const addons = await db<{ itemId: number; addonItemId: number; name: string; ownerName: string; prices: TierPrice[]; available: boolean }[]>`
    SELECT a.item_id, a.addon_item_id, i.name, o.name AS owner_name, ${pricesColumn(db, { base: true })} AS prices,
           (i.active AND NOT i.technician_required AND coalesce(s.active, false)) AS available
    FROM dish_addons a JOIN service_items i ON i.id = a.addon_item_id JOIN service_items o ON o.id = a.item_id
    LEFT JOIN kitchen_stations s ON s.id = i.station_id
    WHERE a.item_id IN ${db(ids)} OR a.addon_item_id IN ${db(ids)} ORDER BY a.item_id, a.sort_no, a.addon_item_id`;
  const combos = await db<{ comboItemId: number; itemId: number; name: string; ownerName: string; quantity: number; available: boolean }[]>`
    SELECT c.combo_item_id, c.item_id, i.name, o.name AS owner_name, c.quantity, i.active AS available
    FROM dish_combo_items c JOIN service_items i ON i.id = c.item_id JOIN service_items o ON o.id = c.combo_item_id
    WHERE c.combo_item_id IN ${db(ids)} OR c.item_id IN ${db(ids)} ORDER BY c.combo_item_id, c.sort_no, c.item_id`;
  return rows.map((r) => {
    const { assigned, ...slot } = diningSlotOf({ outlet: r.diningOutlet, group: r.diningGroup, category: r.category, stationName: r.stationName });
    const prices = sortTiers(r.prices);
    const imageId = r.dishImageId ?? r.emenuImageId;
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      outlet: slot.outlet,
      group: slot.group,
      slotAssigned: assigned,
      stationId: r.stationId,
      stationName: r.stationName,
      stationActive: r.stationActive,
      prices,
      price: defaultPrice(prices),
      active: r.active,
      remaining: r.remaining,
      imageId: r.dishImageId,
      imageUrl: dishImageUrl(imageId),
      emenuDish: r.emenuName,
      methods: methods.filter((m) => m.itemId === r.id).map((m) => m.name),
      addons: addons.filter((a) => a.itemId === r.id).map((a): DishAddonRef => ({ itemId: a.addonItemId, name: a.name, price: defaultPrice(sortTiers(a.prices)), available: a.available })),
      combo: combos.filter((c) => c.comboItemId === r.id).map((c): DishComboRef => ({ itemId: c.itemId, name: c.name, quantity: c.quantity, available: c.available })),
      usedBy: [...addons.filter((a) => a.addonItemId === r.id).map((a) => `「${a.ownerName}」的加料`), ...combos.filter((c) => c.itemId === r.id).map((c) => `套餐「${c.ownerName}」`)],
      rev: r.rev,
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  });
}

async function dishesBoard(db: Db, deps: Deps, filter?: DishFilter): Promise<DishesBoard> {
  const today = await businessDate(db, deps, new Date());
  const all = await loadDishRows(db, today);
  const stations = await db<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM kitchen_stations ORDER BY sort_order, id`;
  const categories = await db<{ category: string }[]>`SELECT DISTINCT category FROM service_items WHERE category <> '' ORDER BY category`;
  return { businessDate: today, dishes: filter ? filterDishes(all, filter) : all, stations, categories: categories.map((c) => c.category) };
}

async function getDish(db: Db, deps: Deps, id: number): Promise<DishRow> {
  const [dish] = await loadDishRows(db, await businessDate(db, deps, new Date()), [id]);
  if (!dish) throw notFound('菜品不存在（或不是菜品：没挂出品档口、需要技师的项目不在这里维护）');
  return dish;
}

// ───────────────────────── 锁与现状 ─────────────────────────

/** 菜品管理的写入全部串行（新增、编辑、上下架、改价、导入）：同名、套餐不套套餐这些核对不会被另一笔同时的保存绕过 */
export const lockDishLedger = (tx: Tx) => tx`SELECT pg_advisory_xact_lock(hashtextextended('yuzu.dishes', 0))`;

export interface ItemState {
  id: number;
  name: string;
  category: string;
  active: boolean;
  stationId: number | null;
  stationName: string | null;
  technicianRequired: boolean;
  diningOutlet: string | null;
  diningGroup: string;
  dishImageId: number | null;
  prices: TierPrice[];
  rev: string;
}

export const isDishState = (s: ItemState) => s.stationId !== null && !s.technicianRequired;
export const slotOfState = (s: ItemState): DiningSlot => {
  const { assigned: _assigned, ...slot } = diningSlotOf({ outlet: s.diningOutlet, group: s.diningGroup, category: s.category, stationName: s.stationName });
  return slot;
};

/**
 * 按 id 升序锁住这几个价目项目，返回锁住以后的样子（不存在的不在返回里）。
 * 用 FOR NO KEY UPDATE：与后台价目、后台「出品档口与菜品」锁这一行的 FOR UPDATE 互相排队，但不挡点单写明细时对这一行的外键检查
 * （这里只改名称、档口、价格这些，不动主键）——营业中维护菜品、预览导入不会让下单等着
 */
async function lockItems(tx: Tx, itemIds: number[]): Promise<Map<number, ItemState>> {
  const ids = [...new Set(itemIds)].sort((a, b) => a - b);
  if (ids.length === 0) return new Map();
  await tx`SELECT id FROM service_items WHERE id IN ${tx(ids)} ORDER BY id FOR NO KEY UPDATE`;
  return readItems(tx, ids);
}

export async function readItems(db: Db, ids: number[]): Promise<Map<number, ItemState>> {
  if (ids.length === 0) return new Map();
  const rows = await db<ItemState[]>`
    SELECT i.id, i.name, i.category, i.active, i.station_id, s.name AS station_name, i.technician_required, i.dining_outlet, i.dining_group,
           i.dish_image_id, ${pricesColumn(db, { base: true })} AS prices, ${REV(db)} AS rev
    FROM service_items i LEFT JOIN kitchen_stations s ON s.id = i.station_id WHERE i.id IN ${db(ids)}`;
  return new Map(rows.map((r) => [r.id, { ...r, prices: sortTiers(r.prices) }]));
}

function assertOutlet(actor: Actor, outlet: DiningOutlet, what: string) {
  if (!can(actor, DISH_OUTLET_PERMISSIONS[outlet])) throw forbidden(`没有${DINING_OUTLET_LABELS[outlet]}的菜品维护权限，不能${what}`);
}

const notDish = () => notFound('菜品不存在（或不是菜品：没挂出品档口、需要技师的项目不在这里维护）');

// ───────────────────────── 入参 ─────────────────────────

const clientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const unique = <T>(list: T[]) => new Set(list).size === list.length;

const tierInput = positiveCents('价格').nullish();
/** 各档的价（分）；某一档不提供为 null 或不带。换成按「标准、专业、优选」排好的清单 */
const PricesInput = z.object({ standard: tierInput, professional: tierInput, premium: tierInput }).transform((p) =>
  PRICE_TIERS.flatMap((tier): TierPrice[] => {
    const price = p[tier];
    return price ? [{ tier, price }] : [];
  }),
);

const DishFields = z.object({
  name: z.string('请填写菜名').trim().min(1, '请填写菜名').max(MAX_DISH_NAME, `菜名最多 ${MAX_DISH_NAME} 个字`),
  category: z.string().trim().max(MAX_DISH_CATEGORY, `分类最多 ${MAX_DISH_CATEGORY} 个字`).default(''),
  slot: z
    .string('请选择出品口与小类')
    .max(40)
    .refine((v) => parseSlotKey(v) !== null, '出品口与小类不对，请刷新后重试'),
  stationId: z.number('请选择出品档口').int().positive('请选择出品档口'),
  imageId: z.number().int().positive().nullable().default(null),
  methods: z
    .array(
      z
        .string()
        .trim()
        .min(1, '做法不能是空的')
        .max(MAX_DISH_METHOD_LENGTH, `一种做法最多 ${MAX_DISH_METHOD_LENGTH} 个字`)
        .refine((m) => !/[，,、;；/\s]/.test(m), '做法里不要带逗号、顿号、斜杠或空格（一种做法写一个）'),
    )
    .max(MAX_DISH_METHODS, `一道菜最多 ${MAX_DISH_METHODS} 种做法`)
    .refine(unique, '做法重复了')
    .default([]),
  addons: z.array(z.number().int().positive()).max(MAX_DISH_ADDONS, `一道菜最多 ${MAX_DISH_ADDONS} 种加料`).refine(unique, '加料重复了').default([]),
  combo: z
    .array(
      z.object({
        itemId: z.number().int().positive(),
        quantity: z.number('份数必须是整数').int('份数必须是整数').min(1, '份数至少 1').max(MAX_COMBO_ITEM_QUANTITY, `份数最多 ${MAX_COMBO_ITEM_QUANTITY}`),
      }),
    )
    .max(MAX_COMBO_ITEMS, `一个套餐最多含 ${MAX_COMBO_ITEMS} 样`)
    .refine((list) => unique(list.map((c) => c.itemId)), '套餐里同一道菜写了两次')
    .default([]),
});
export type DishFieldsData = z.output<typeof DishFields>;

const CreateInput = DishFields.extend({
  clientKey,
  prices: PricesInput.refine((p) => p.length > 0, '请至少填写一档价格'),
  active: z.boolean().default(true),
});
/**
 * 页面打开时看到的版本（这一行最后一次修改的时刻）：编辑、上下架、改价都带，在锁里核对，别人先改过就拒绝。
 * 只比状态（上架 / 下架、改前的价）挡不住「改过去又改回来」：晚到的旧请求看到的还是原样，会把菜又改一遍（Codex 审查 d12390f 的 P1）
 */
const revInput = z.string('缺少版本，请刷新后重试').regex(/^[0-9]{1,20}$/, '版本不对，请刷新后重试');
const UpdateInput = DishFields.extend({ clientKey, rev: revInput });
const ActiveInput = z.object({ clientKey, active: z.boolean('请指明上架还是下架'), rev: revInput });
const reasonInput = z.string('请填写改价原因').trim().min(2, '请填写改价原因（至少 2 个字）').max(MAX_PRICE_REASON, `原因最多 ${MAX_PRICE_REASON} 个字`);
const PriceInput = z.object({
  clientKey,
  prices: PricesInput.refine((p) => p.length > 0, '请至少留一档价格'),
  /** 改价时页面上看到的各档价格：与现在的不一样（别人刚改过）就拒绝 */
  expected: PricesInput,
  rev: revInput,
  reason: reasonInput,
});

/** 页面看到的版本与锁住以后的不一样：别人（或晚到的另一笔）先改过这道菜 */
const changedSince = (cur: ItemState, what: string) =>
  conflict('DISH_CHANGED', `「${cur.name}」刚刚被改过（现在${cur.active ? '上架' : '下架'}、${pricesText(cur.prices)}），没有${what}；请刷新后再操作`, {
    active: cur.active,
    prices: cur.prices,
  });

// ───────────────────────── 写：事务里的几步（单道保存与导入共用） ─────────────────────────

interface FieldChange {
  label: string;
  before: string;
  after: string;
}

const listText = (list: readonly string[]) => (list.length ? list.join('、') : '（没有）');

/** 核对档口、图片、同名、加料、套餐内容（这道菜与引用的菜都已锁住）；返回引用的菜现在的样子 */
async function checkFields(tx: Tx, cur: ItemState | null, f: DishFieldsData, refs: Map<number, ItemState>) {
  const id = cur?.id ?? null;
  const [station] = await tx<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM kitchen_stations WHERE id = ${f.stationId}`;
  if (!station) throw notFound('出品档口不存在，请刷新后重试');
  if (!station.active && cur?.stationId !== station.id) throw unprocessable('STATION_INACTIVE', `档口「${station.name}」已停用，请换一个`);
  if (f.imageId !== null && f.imageId !== cur?.dishImageId) {
    const [img] = await tx<{ id: number }[]>`SELECT id FROM emenu_images WHERE id = ${f.imageId}`;
    if (!img) throw notFound('图片不存在，请重新上传');
  }
  if (cur?.name !== f.name) {
    const [dup] = await tx<{ id: number }[]>`SELECT id FROM service_items WHERE lower(btrim(name)) = lower(${f.name}) AND id IS DISTINCT FROM ${id} LIMIT 1`;
    if (dup) throw conflict('DISH_NAME_TAKEN', `价目里已经有「${f.name}」了（菜品或别的项目），请换一个名字`);
  }
  const refIds = [...f.addons, ...f.combo.map((c) => c.itemId)];
  if (id !== null && refIds.includes(id)) throw unprocessable('DISH_SELF_REF', '加料、套餐内容里不能选这道菜自己');
  for (const refId of refIds) {
    const r = refs.get(refId);
    if (!r) throw notFound('选的加料或套餐内容里有菜已经不存在，请刷新后重试');
    if (!isDishState(r)) throw unprocessable('DISH_REF_NOT_DISH', `「${r.name}」不是菜品（没挂出品档口，或需要技师），不能当加料或放进套餐`);
  }
  if (refIds.length) {
    const nested = await tx<{ id: number; name: string }[]>`
      SELECT DISTINCT i.id, i.name FROM dish_combo_items c JOIN service_items i ON i.id = c.combo_item_id WHERE c.combo_item_id IN ${tx(refIds)} ORDER BY i.id LIMIT 1`;
    if (nested[0]) {
      throw unprocessable('DISH_COMBO_NESTED', f.addons.includes(nested[0].id) ? `「${nested[0].name}」是套餐，不能当加料` : `「${nested[0].name}」本身是套餐，套餐里不能再放套餐`);
    }
  }
  if (f.combo.length && id !== null) {
    const [inCombo] = await tx<{ name: string }[]>`
      SELECT i.name FROM dish_combo_items c JOIN service_items i ON i.id = c.combo_item_id WHERE c.item_id = ${id} ORDER BY i.id LIMIT 1`;
    if (inCombo) throw unprocessable('DISH_COMBO_NESTED', `这道菜已经在套餐「${inCombo.name}」里，不能再做成套餐`);
    const [asAddon] = await tx<{ name: string }[]>`
      SELECT i.name FROM dish_addons a JOIN service_items i ON i.id = a.item_id WHERE a.addon_item_id = ${id} ORDER BY i.id LIMIT 1`;
    if (asAddon) throw unprocessable('DISH_COMBO_NESTED', `这道菜是「${asAddon.name}」的加料，不能做成套餐`);
  }
  return station;
}

async function writeMethods(tx: Tx, id: number, methods: string[], fresh = false) {
  if (!fresh) await tx`DELETE FROM dish_methods WHERE item_id = ${id}`;
  if (methods.length) {
    await tx`INSERT INTO dish_methods (item_id, name, sort_no) SELECT ${id}, m, (ord - 1)::int FROM unnest(${methods}::text[]) WITH ORDINALITY AS t(m, ord)`;
  }
}

async function writeAddons(tx: Tx, id: number, addons: number[], fresh = false) {
  if (!fresh) await tx`DELETE FROM dish_addons WHERE item_id = ${id}`;
  if (addons.length) {
    await tx`INSERT INTO dish_addons (item_id, addon_item_id, sort_no) SELECT ${id}, a, (ord - 1)::int FROM unnest(${addons}::bigint[]) WITH ORDINALITY AS t(a, ord)`;
  }
}

async function writeCombo(tx: Tx, id: number, combo: { itemId: number; quantity: number }[], fresh = false) {
  if (!fresh) await tx`DELETE FROM dish_combo_items WHERE combo_item_id = ${id}`;
  if (combo.length) {
    await tx`
      INSERT INTO dish_combo_items (combo_item_id, item_id, quantity, sort_no)
      SELECT ${id}, c, q, (ord - 1)::int FROM unnest(${combo.map((c) => c.itemId)}::bigint[], ${combo.map((c) => c.quantity)}::int[]) WITH ORDINALITY AS t(c, q, ord)`;
  }
}

/** 这道菜现在的做法、加料、套餐内容（比较有没有变、写审计用） */
async function childrenOf(db: Db, id: number) {
  const methods = await db<{ name: string }[]>`SELECT name FROM dish_methods WHERE item_id = ${id} ORDER BY sort_no, name`;
  const addons = await db<{ id: number; name: string }[]>`
    SELECT i.id, i.name FROM dish_addons a JOIN service_items i ON i.id = a.addon_item_id WHERE a.item_id = ${id} ORDER BY a.sort_no, i.id`;
  const combo = await db<{ itemId: number; name: string; quantity: number }[]>`
    SELECT i.id AS item_id, i.name, c.quantity FROM dish_combo_items c JOIN service_items i ON i.id = c.item_id WHERE c.combo_item_id = ${id} ORDER BY c.sort_no, i.id`;
  return { methods: methods.map((m) => m.name), addons, combo };
}

const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 新建一道菜（事务里；「菜品维护」锁已取）：要目标出品口的维护权限与定价权限；定价记进改价记录。
 * 返回新菜的编号。
 */
export async function createDishTx(tx: Tx, ctx: OpContext, f: DishFieldsData & { prices: TierPrice[]; active: boolean }, opts: { reason: string; source: DishPriceSource }): Promise<number> {
  const slot = parseSlotKey(f.slot)!;
  assertOutlet(ctx.actor, slot.outlet, '在这里新建菜品');
  if (!can(ctx.actor, DISH_PRICE_PERMISSION)) throw forbidden('新建菜品要定价，需要「菜品管理：定价与改价」的权限');
  const refs = await lockItems(tx, [...f.addons, ...f.combo.map((c) => c.itemId)]);
  await checkFields(tx, null, f, refs);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO service_items (name, category, price, technician_required, station_id, dining_outlet, dining_group, dish_image_id, active, sort_order)
    VALUES (${f.name}, ${f.category}, ${defaultPrice(f.prices)}, false, ${f.stationId}, ${slot.outlet}, ${slot.group}, ${f.imageId}, ${f.active},
            (SELECT coalesce(max(sort_order), 0) + 1 FROM service_items))
    RETURNING id`;
  const id = row!.id;
  await tx`
    INSERT INTO service_item_prices (item_id, tier, price)
    SELECT ${id}, unnest(${f.prices.map((p) => p.tier)}::text[]), unnest(${f.prices.map((p) => p.price)}::bigint[])`;
  // 新建的菜：做法、加料、套餐内容直接写（没有旧的要先删）
  await writeMethods(tx, id, f.methods, true);
  await writeAddons(tx, id, f.addons, true);
  await writeCombo(tx, id, f.combo, true);
  await recordPriceChanges(tx, { itemId: id, itemName: f.name, before: [], after: f.prices, reason: opts.reason, source: opts.source, staffId: ctx.actor.id });
  return id;
}

/**
 * 改一道菜的名称、分类、出品口与小类、档口、图片、做法、加料、套餐内容（事务里；「菜品维护」锁已取）。
 * 要这道菜现在所在出品口的维护权限，挪到另一个出品口还要那一个的。返回改了什么（什么都没改返回空，不动这一行）
 */
export async function updateDishTx(tx: Tx, ctx: OpContext, id: number, f: DishFieldsData, opts: { rev?: string } = {}): Promise<FieldChange[]> {
  const locked = await lockItems(tx, [id, ...f.addons, ...f.combo.map((c) => c.itemId)]);
  const cur = locked.get(id);
  if (!cur || !isDishState(cur)) throw notDish();
  if (opts.rev !== undefined && opts.rev !== cur.rev) throw conflict('DISH_CHANGED', `「${cur.name}」刚刚被别人改过，请刷新后再改`);
  const from = slotOfState(cur);
  const to = parseSlotKey(f.slot)!;
  assertOutlet(ctx.actor, from.outlet, `改「${cur.name}」`);
  if (to.outlet !== from.outlet) assertOutlet(ctx.actor, to.outlet, `把「${cur.name}」挪到${DINING_OUTLET_LABELS[to.outlet]}`);
  const station = await checkFields(tx, cur, f, locked);
  const kids = await childrenOf(tx, id);

  const changes: FieldChange[] = [];
  if (cur.name !== f.name) changes.push({ label: '名称', before: cur.name, after: f.name });
  if (cur.category !== f.category) changes.push({ label: '分类', before: cur.category || '（空）', after: f.category || '（空）' });
  // 出品口与小类：原来按默认归的、现在选的与默认一样，不算改（不把「按默认」写成设过）
  const slotChanged = from.outlet !== to.outlet || from.group !== to.group;
  if (slotChanged) changes.push({ label: '出品口与小类', before: slotLabel(from), after: slotLabel(to) });
  // 但按默认归的菜，默认归到哪是看分类与档口的：这次改了分类或档口，不写明的话保存以后会跟着跑到另一处——
  // 页面上选的是哪一处就写明哪一处（也免得没有另一处权限的人借换档口把菜挪过去）
  const kept = diningSlotOf({ outlet: cur.diningOutlet, group: cur.diningGroup, category: f.category, stationName: station.name });
  const writeSlot = kept.outlet !== to.outlet || kept.group !== to.group;
  if (cur.stationId !== f.stationId) changes.push({ label: '档口', before: cur.stationName ?? '', after: station.name });
  if (cur.dishImageId !== f.imageId) changes.push({ label: '图片', before: cur.dishImageId ? '有' : '没有', after: f.imageId ? (cur.dishImageId ? '换了一张' : '有') : '没有' });
  const methodsChanged = !sameList(kids.methods, f.methods);
  if (methodsChanged) changes.push({ label: '做法', before: listText(kids.methods), after: listText(f.methods) });
  const addonsChanged = !sameList(
    kids.addons.map((a) => a.id),
    f.addons,
  );
  if (addonsChanged) {
    changes.push({ label: '加料', before: listText(kids.addons.map((a) => a.name)), after: listText(f.addons.map((a) => locked.get(a)!.name)) });
  }
  const comboChanged = !sameList(
    kids.combo.map((c) => `${c.itemId}×${c.quantity}`),
    f.combo.map((c) => `${c.itemId}×${c.quantity}`),
  );
  if (comboChanged) {
    changes.push({
      label: '套餐内容',
      before: kids.combo.length ? partsText(kids.combo) : '（没有）',
      after: f.combo.length ? partsText(f.combo.map((c) => ({ name: locked.get(c.itemId)!.name, quantity: c.quantity }))) : '（没有）',
    });
  }
  if (changes.length === 0) return [];

  await tx`
    UPDATE service_items SET name = ${f.name}, category = ${f.category}, station_id = ${f.stationId}, dish_image_id = ${f.imageId},
           ${writeSlot ? tx`dining_outlet = ${to.outlet}, dining_group = ${to.group},` : tx``} updated_at = clock_timestamp()
    WHERE id = ${id}`;
  if (methodsChanged) await writeMethods(tx, id, f.methods);
  if (addonsChanged) await writeAddons(tx, id, f.addons);
  if (comboChanged) await writeCombo(tx, id, f.combo);
  return changes;
}

/**
 * 上架 / 下架（事务里）：要这道菜所在出品口的维护权限；带了页面看到的版本（rev）的，与锁住以后的不一样整笔拒绝。
 * 本来就是这个状态返回 false、不动这一行
 */
export async function setDishActiveTx(tx: Tx, ctx: OpContext, id: number, active: boolean, opts: { rev?: string } = {}): Promise<{ name: string; changed: boolean }> {
  const cur = (await lockItems(tx, [id])).get(id);
  if (!cur || !isDishState(cur)) throw notDish();
  assertOutlet(ctx.actor, slotOfState(cur).outlet, `把「${cur.name}」${active ? '上架' : '下架'}`);
  if (opts.rev !== undefined && opts.rev !== cur.rev) throw changedSince(cur, active ? '上架' : '下架');
  if (cur.active === active) return { name: cur.name, changed: false };
  await tx`UPDATE service_items SET active = ${active}, updated_at = clock_timestamp() WHERE id = ${id}`;
  return { name: cur.name, changed: true };
}

/**
 * 改价（事务里）：要「定价与改价」与这道菜所在出品口的维护权限；改的是全公司的价目（各档），默认档的价同步到 service_items.price；
 * 每一档的变化记一条改价记录。以前的订单不动（明细上留着当时的单价）。返回改了哪几档（没变返回空）
 */
export async function changeDishPriceTx(
  tx: Tx,
  ctx: OpContext,
  id: number,
  prices: TierPrice[],
  opts: { reason: string; source: DishPriceSource; expected?: TierPrice[]; rev?: string },
): Promise<{ name: string; diff: ReturnType<typeof priceDiff> }> {
  const cur = (await lockItems(tx, [id])).get(id);
  if (!cur || !isDishState(cur)) throw notDish();
  const outlet = slotOfState(cur).outlet;
  if (!can(ctx.actor, DISH_PRICE_PERMISSION)) throw forbidden('没有「菜品管理：定价与改价」的权限');
  assertOutlet(ctx.actor, outlet, `改「${cur.name}」的价格`);
  if (opts.expected && priceDiff(opts.expected, cur.prices).length > 0) {
    throw conflict('DISH_PRICE_STALE', `「${cur.name}」的价格刚刚被别人改过（现在是 ${pricesText(cur.prices)}），请刷新后再改`, { prices: cur.prices });
  }
  // 价格看着一样也可能是「改过去又改回来」：再核对版本，晚到的旧改价不会把价又改一遍
  if (opts.rev !== undefined && opts.rev !== cur.rev) throw changedSince(cur, '改价');
  const diff = priceDiff(cur.prices, prices);
  if (diff.length === 0) return { name: cur.name, diff };
  for (const d of diff) {
    if (d.newPrice === null) {
      await tx`DELETE FROM service_item_prices WHERE item_id = ${id} AND tier = ${d.tier}`;
    } else {
      await tx`
        INSERT INTO service_item_prices (item_id, tier, price) VALUES (${id}, ${d.tier}, ${d.newPrice})
        ON CONFLICT (item_id, tier) DO UPDATE SET price = EXCLUDED.price`;
    }
  }
  await tx`UPDATE service_items SET price = ${defaultPrice(prices)}, updated_at = clock_timestamp() WHERE id = ${id}`;
  await recordPriceChanges(tx, { itemId: id, itemName: cur.name, before: cur.prices, after: prices, reason: opts.reason, source: opts.source, staffId: ctx.actor.id });
  return { name: cur.name, diff };
}

// ───────────────────────── 操作编号 ─────────────────────────

/** dish_ops 里一个编号的记录：result.abandoned 为真的是「确认作废」登记的（没办，原请求之后再到也不办） */
interface DishOpRow {
  opType: DishOpType;
  requestHash: string;
  itemId: number | null;
  result: Record<string, unknown>;
  createdAt: string;
}
const isAbandonedRow = (row: DishOpRow) => row.result?.abandoned === true;
const readDishOp = async (db: Db, key: string) => (await db<DishOpRow[]>`SELECT op_type, request_hash, item_id, result, created_at FROM dish_ops WHERE client_key = ${key}`)[0];

/**
 * 带操作编号的一笔菜品维护：同一个编号排队（操作编号的咨询锁，与「确认作废」同一把），已经办过的——内容一样返回第一次的结果，
 * 内容不同拒绝；已经确认作废的整笔不做（OP_ABANDONED）；没办过的取「菜品维护」锁、办理、记下编号
 */
export async function runDishOp<R extends Record<string, unknown>>(
  deps: Deps,
  opts: { key: string; opType: DishOpType; requestHash: string; staffId: number },
  body: (tx: Tx) => Promise<{ itemId: number | null; result: R }>,
): Promise<{ itemId: number | null; result: R; replayed: boolean }> {
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, opts.key);
    const seen = (await readDishOp(tx, opts.key)) as (DishOpRow & { result: R }) | undefined;
    if (seen) {
      if (isAbandonedRow(seen)) throw abandonedError();
      if (seen.opType !== opts.opType || seen.requestHash !== opts.requestHash) {
        throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次不同的操作，请刷新页面后重新发起');
      }
      return { itemId: seen.itemId, result: seen.result, replayed: true };
    }
    await lockDishLedger(tx);
    const done = await body(tx);
    await tx`
      INSERT INTO dish_ops (client_key, op_type, request_hash, item_id, result, staff_id)
      VALUES (${opts.key}, ${opts.opType}, ${opts.requestHash}, ${done.itemId}, ${tx.json(done.result as never)}, ${opts.staffId})`;
    return { ...done, replayed: false };
  }) as Promise<{ itemId: number | null; result: R; replayed: boolean }>;
}

// ───────────────────────── 新增、编辑、上下架、改价 ─────────────────────────

async function createDish(deps: Deps, raw: unknown, ctx: OpContext): Promise<DishSaveResult> {
  const { clientKey: key, ...input } = parse(CreateInput, raw);
  const run = await runDishOp(deps, { key, opType: 'create', requestHash: hashRequest(input), staffId: ctx.actor.id }, async (tx) => {
    const id = await createDishTx(tx, ctx, input, { reason: '新建菜品', source: 'dishes' });
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'dish_saved',
      targetType: 'item',
      targetId: id,
      detail: { name: input.name, summary: `新建菜品「${input.name}」（${slotLabel(parseSlotKey(input.slot)!)}，${pricesText(input.prices)}）${input.active ? '' : '，先不上架'}` },
      ip: ctx.ip,
    });
    return { itemId: id, result: {} };
  });
  return { dish: await getDish(deps.sql, deps, run.itemId!), replayed: run.replayed };
}

async function updateDish(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<DishSaveResult> {
  const { clientKey: key, rev, ...input } = parse(UpdateInput, raw);
  const run = await runDishOp(deps, { key, opType: 'update', requestHash: hashRequest({ id, rev, ...input }), staffId: ctx.actor.id }, async (tx) => {
    const changes = await updateDishTx(tx, ctx, id, input, { rev });
    if (changes.length) {
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'dish_saved',
        targetType: 'item',
        targetId: id,
        detail: {
          name: input.name,
          changes,
          summary: `修改菜品「${input.name}」：${changes.map((c) => `${c.label} ${c.before} → ${c.after}`).join('；')}`.slice(0, 500),
        },
        ip: ctx.ip,
      });
    }
    return { itemId: id, result: {} };
  });
  return { dish: await getDish(deps.sql, deps, run.itemId!), replayed: run.replayed };
}

async function setDishActive(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<DishSaveResult> {
  const { clientKey: key, active, rev } = parse(ActiveInput, raw);
  const run = await runDishOp(deps, { key, opType: 'active', requestHash: hashRequest({ id, active, rev }), staffId: ctx.actor.id }, async (tx) => {
    const r = await setDishActiveTx(tx, ctx, id, active, { rev });
    if (r.changed) {
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'dish_active_set',
        targetType: 'item',
        targetId: id,
        detail: { name: r.name, active, summary: `菜品「${r.name}」${active ? '上架' : '下架'}` },
        ip: ctx.ip,
      });
    }
    return { itemId: id, result: {} };
  });
  return { dish: await getDish(deps.sql, deps, run.itemId!), replayed: run.replayed };
}

async function changeDishPrice(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<DishSaveResult> {
  const { clientKey: key, ...input } = parse(PriceInput, raw);
  const run = await runDishOp(deps, { key, opType: 'price', requestHash: hashRequest({ id, ...input }), staffId: ctx.actor.id }, async (tx) => {
    const r = await changeDishPriceTx(tx, ctx, id, input.prices, { reason: input.reason, source: 'dishes', expected: input.expected, rev: input.rev });
    if (r.diff.length === 0) throw unprocessable('DISH_PRICE_SAME', '价格没有变，不用改');
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'dish_price_changed',
      targetType: 'item',
      targetId: id,
      detail: { name: r.name, changes: r.diff, reason: input.reason, summary: `菜品「${r.name}」改价：${r.diff.map(priceChangeText).join('；')}（${input.reason}）`.slice(0, 500) },
      ip: ctx.ip,
    });
    return { itemId: id, result: {} };
  });
  return { dish: await getDish(deps.sql, deps, run.itemId!), replayed: run.replayed };
}

// ───────────────────────── 结果待确认：按编号查回、确认作废 ─────────────────────────

const OpTypeInput = z.enum(DISH_OP_TYPES, '操作类型不对，请刷新后重试');
const OpKeyParam = z.object({ key: z.uuid('操作编号不对') });
const AbandonInput = z.object({ type: OpTypeInput, itemId: z.number().int().positive().nullish() });

/** 编号已有的记录 → 查回的结果（声明的类型与记下的不一样：这个编号是别的操作的，原请求不会按声明的那种生效） */
async function lookupOf(db: Db, deps: Deps, row: DishOpRow | undefined, type: DishOpType): Promise<DishOpLookup> {
  if (!row) return { found: false, abandoned: false };
  if (row.opType !== type) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号属于另一种菜品操作，请刷新后核对');
  if (isAbandonedRow(row)) return { found: false, abandoned: true };
  const dish = row.itemId === null ? null : await getDish(db, deps, row.itemId).catch(() => null);
  return { found: true, type: row.opType, itemId: row.itemId, dish, result: row.result, at: new Date(row.createdAt).toISOString() };
}

/** 按编号只读查回：查不到只说明此刻还没有已提交的结果（原请求可能还在路上或在等锁），不能据此断定没有生效 */
const lookupDishOp = async (deps: Deps, key: string, type: DishOpType) => lookupOf(deps.sql, deps, await readDishOp(deps.sql, key), type);

/**
 * 确认作废一个结果不明的编号：按声明的类型检查权限（改价要「定价与改价」，其余要任一处的维护权限；带了菜的再要这道菜所在出品口的），
 * 与原请求写编号取同一把咨询锁——
 *   · 编号已经办过：返回查回的结果，不作废；
 *   · 还没办：在 dish_ops 记一条作废（result.abandoned），原请求之后即使到达也整笔不做（runDishOp 抛 OP_ABANDONED）；
 *   · 原请求恰好正在办：等它提交（最多 5 秒）再答，等不到这一次失败、仍是待确认。
 */
async function abandonDishOp(deps: Deps, key: string, raw: unknown, ctx: OpContext): Promise<DishOpLookup> {
  const { type, itemId } = parse(AbandonInput, raw);
  // 改价、新增（新增要定价）本身要「定价与改价」：作废它们也要
  if ((type === 'price' || type === 'create') && !can(ctx.actor, DISH_PRICE_PERMISSION)) throw forbidden(`作废${DISH_OP_LABELS[type]}要有「菜品管理：定价与改价」的权限`);
  const row = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, key);
    const seen = await readDishOp(tx, key);
    if (seen) return seen;
    const dish = itemId ? (await readItems(tx, [itemId])).get(itemId) : undefined;
    if (dish && isDishState(dish)) assertOutlet(ctx.actor, slotOfState(dish).outlet, `作废「${dish.name}」的${DISH_OP_LABELS[type]}`);
    const ref = dish && isDishState(dish) ? dish.id : null;
    await tx`
      INSERT INTO dish_ops (client_key, op_type, request_hash, item_id, result, staff_id)
      VALUES (${key}, ${type}, ${hashRequest({ abandoned: key })}, ${ref}, ${tx.json({ abandoned: true })}, ${ctx.actor.id})`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'dish_op_abandoned',
      targetType: 'operation',
      targetId: key,
      detail: { key, type, itemId: ref, summary: `作废结果待确认的${DISH_OP_LABELS[type]}${dish ? `（「${dish.name}」）` : ''}：原请求之后再到也不生效` },
      ip: ctx.ip,
    });
    return undefined;
  });
  if (!row) return { found: false, abandoned: true };
  return lookupOf(deps.sql, deps, row, type);
}

// ───────────────────────── 改价记录、导出 ─────────────────────────

const HistoryQuery = z.object({
  itemId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** 改价记录：新的在前；给了菜品只看这一道 */
async function dishPriceChanges(db: Db, raw: unknown): Promise<DishPriceChange[]> {
  const q = parse(HistoryQuery, raw ?? {});
  return db<DishPriceChange[]>`
    SELECT c.id, c.item_id, c.item_name, c.tier, c.old_price, c.new_price, c.reason, c.source, s.display_name AS staff_name, c.created_at
    FROM dish_price_changes c LEFT JOIN staff s ON s.id = c.staff_id
    ${q.itemId ? db`WHERE c.item_id = ${q.itemId}` : db``} ORDER BY c.id DESC LIMIT ${q.limit}`;
}

const yuan = (cents: number | null) => (cents === null ? null : cents / 100);

/** 导出全部菜品（Excel）：列与导入认的一样，改完可以原样导回来；后面三列只读 */
async function dishesXlsx(db: Db, deps: Deps): Promise<{ buffer: Buffer; fileName: string; count: number }> {
  const board = await dishesBoard(db, deps);
  const rows = board.dishes.map((d) => [
    d.id,
    d.name,
    d.category,
    DINING_OUTLET_LABELS[d.outlet],
    d.group,
    d.stationName,
    yuan(tierPrice(d.prices, 'standard')),
    yuan(tierPrice(d.prices, 'professional')),
    yuan(tierPrice(d.prices, 'premium')),
    d.active ? '上架' : '下架',
    d.methods.join('、'),
    d.addons.map((a) => a.name).join('、'),
    partsText(d.combo),
    remainingText(d.remaining),
    d.imageUrl ? '有' : '',
    d.emenuDish ?? '',
  ]);
  const widths: Record<string, number> = { 编号: 8, 名称: 22, 分类: 12, 出品口: 8, 小类: 10, 档口: 12, 状态: 8, 做法: 26, 加料: 26, 套餐内容: 34, 今日沽清: 10, 图片: 6, 电子菜单: 18 };
  const buffer = buildXlsx({
    name: '菜品',
    columns: [...DISH_SHEET_COLUMNS, ...DISH_EXPORT_EXTRA_COLUMNS].map((header) => ({ header, width: widths[header] ?? 10 })),
    rows,
  });
  return { buffer, fileName: `菜品_${board.businessDate}.xlsx`, count: rows.length };
}

// ───────────────────────── 路由 ─────────────────────────

const BoardQuery = z.object({
  q: z.string().max(40).default(''),
  outlet: z.enum(['restaurant', 'water', 'fruit'], '出品口不对').optional(),
  status: z.string().refine(isDishStatusFilter, '状态不对').default('all'),
});

export function registerDishRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const view = guardAny(...DISH_PERMISSIONS);
  // 维护：三个出品口有任一项才进得来；具体到哪道菜在事务里按库里的出品口核对
  const manage = guardAny(...Object.values(DISH_OUTLET_PERMISSIONS));

  app.get('/api/dining/dishes', { preHandler: view }, async (req) => {
    const q = parse(BoardQuery, req.query ?? {});
    const filtered = q.q.trim() !== '' || q.outlet !== undefined || q.status !== 'all';
    return dishesBoard(sql, deps, filtered ? { q: q.q, outlet: q.outlet ?? null, status: q.status as DishFilter['status'] } : undefined);
  });
  app.post('/api/dining/dishes', { preHandler: manage }, async (req, reply) => {
    const r = await createDish(deps, req.body, ctxOf(req));
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.put('/api/dining/dishes/:id', { preHandler: manage }, async (req) => updateDish(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/dining/dishes/:id/active', { preHandler: manage }, async (req) => setDishActive(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/dining/dishes/:id/price', { preHandler: guard(DISH_PRICE_PERMISSION) }, async (req) => changeDishPrice(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.get('/api/dining/dishes/price-changes', { preHandler: view }, async (req) => dishPriceChanges(sql, req.query));
  // 结果待确认（8.1.16）：按编号查回（看得到菜品的都能查）、确认作废（按声明的类型核对权限）
  app.get('/api/dining/dishes/ops/:key', { preHandler: view }, async (req) => {
    const { key } = parse(OpKeyParam, req.params);
    const { type } = parse(z.object({ type: OpTypeInput }), req.query ?? {});
    return lookupDishOp(deps, key, type);
  });
  app.post('/api/dining/dishes/ops/:key/abandon', { preHandler: manage }, async (req) => abandonDishOp(deps, parse(OpKeyParam, req.params).key, req.body, ctxOf(req)));

  app.get('/api/dining/dishes/export.xlsx', { preHandler: view }, async (req, reply) => {
    const file = await dishesXlsx(sql, deps);
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'dishes', detail: { count: file.count }, ip: req.ip });
    attachment(reply, file.fileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return reply.send(file.buffer);
  });

  // 图片：压缩后的 Base64，单张不超过 1 MB；存在电子菜单的图片表里（按内容去重、只追加）
  app.post('/api/dining/dishes/images', { preHandler: manage, bodyLimit: 1_600_000 }, async (req, reply) => {
    const img = await saveEmenuImage(sql, req.body, req.actor);
    reply.code(201);
    return { id: img.id, url: dishImageUrl(img.id)! };
  });
  app.get('/api/dining/dishes/images/:id', { preHandler: view }, async (req, reply) => {
    const img = await emenuImage(sql, parse(idParam, req.params).id);
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(img.data);
  });
}
