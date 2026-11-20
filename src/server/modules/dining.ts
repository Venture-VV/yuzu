// 餐饮（S5 第一步）：出品档口、点单、厨房出品屏（KDS）与沽清。
//
// 钱只在账单明细里：点单就是给客人挂账（与前台挂账同一条路径 frontdesk/bills.ts 的 postCharges，同一个事务里建出品单），
// 退菜就是作废明细（voidLine，同一个事务里把出品单改为已退、按原份数加回沽清）。出品单只记出品状态与时间。
//
// 并发：挂账、作废的加锁顺序是「来访 → 账单 → 明细 → （技师队列 → 钟单 → 技师状态）→ 沽清 → 出品单」；
// 厨房屏的开始 / 出餐 / 上菜只锁出品单一行，设沽清只锁沽清一行，都不反向加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_DINING_RULES,
  KITCHEN_STATUSES,
  MAX_STATION_NAME,
  MAX_VOID_FREE_CENTS,
  diningSlotOf,
  parseSlotKey,
  slotLabel,
  type DiningAdmin,
  type DiningGuest,
  type DiningMenu,
  type DiningRules,
  type KitchenBoard,
  type KitchenItem,
  type KitchenStation,
  type KitchenStatus,
  type MenuDish,
} from '@shared/dining';
import { defaultTier, sortTiers, type TierPrice } from '@shared/catalog';
import { can } from '@shared/permissions';
import type { FrontdeskOpLookup } from '@shared/frontdesk';
import type { Db, Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps, OpContext } from '../lib/context';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { businessDate, loadFrontdeskRules, nextDocNo, setTxTimeouts } from './frontdesk/common';
import { pricesColumn } from './pricing';
import { ctxOf } from '../lib/context';
import { saveRuleSetting } from '../lib/rule-settings';
import { recordRecipeUsage, reverseRecipeUsage } from './stock-usage';
import { settingRow } from '../lib/store-settings';
import { currentStoreId } from '../lib/store-context';
import { DeliverRoomField, findGuestByRoom, findGuestByTag, prepareDiningOrder } from './dining-order-v8115';
import { comboPartsOf, withDishOptions } from './dish-options';
import { pendingAddonsColumn } from './dish-addon-void';

export async function loadDiningRules(db: Db): Promise<DiningRules> {
  const row = await settingRow<Partial<DiningRules>>(db, 'dining_rules');
  return { ...DEFAULT_DINING_RULES, ...row?.value };
}

// ───────────────────────── 挂账时建出品单（frontdesk/bills.ts 调用） ─────────────────────────

/** 进厨房的菜品：餐饮功能开启、挂在启用的档口上的项目 → 档口（需要技师的项目不进厨房） */
export async function kitchenStationsOf(db: Db, itemIds: number[]): Promise<Map<number, number>> {
  const unique = [...new Set(itemIds)];
  if (unique.length === 0 || !(await loadDiningRules(db)).enabled) return new Map();
  const rows = await db<{ id: number; stationId: number }[]>`
    SELECT i.id, i.station_id FROM service_items i JOIN kitchen_stations s ON s.id = i.station_id AND s.active
    WHERE i.id IN ${db(unique)} AND NOT i.technician_required`;
  return new Map(rows.map((r) => [r.id, r.stationId]));
}

export interface DishLine {
  itemId: number;
  name: string;
  quantity: number;
}

/**
 * 沽清：这几道菜今天还剩的份数够不够，够就扣掉（按项目 id 升序锁沽清行）。没有当天记录的不限量。
 * 返回扣过沽清的项目（退菜时按原份数加回）。
 */
export async function takeDishLimits(tx: Tx, lines: DishLine[], date: string): Promise<Set<number>> {
  const wanted = new Map<number, { name: string; quantity: number }>();
  for (const l of lines) {
    const cur = wanted.get(l.itemId);
    wanted.set(l.itemId, { name: l.name, quantity: (cur?.quantity ?? 0) + l.quantity });
  }
  if (wanted.size === 0) return new Set();
  const rows = await tx<{ itemId: number; remaining: number }[]>`
    SELECT item_id, remaining FROM dish_limits WHERE item_id IN ${tx([...wanted.keys()])} AND business_date = ${date}
    ORDER BY item_id FOR UPDATE`;
  for (const r of rows) {
    const w = wanted.get(r.itemId)!;
    if (r.remaining < w.quantity) {
      throw conflict('DISH_SOLD_OUT', r.remaining === 0 ? `「${w.name}」今天已沽清（卖完了），请换一道菜` : `「${w.name}」今天只剩 ${r.remaining} 份，请改份数或换一道菜`, {
        itemId: r.itemId,
        remaining: r.remaining,
      });
    }
    await tx`UPDATE dish_limits SET remaining = remaining - ${w.quantity} WHERE item_id = ${r.itemId}`;
  }
  return new Set(rows.map((r) => r.itemId));
}

export interface KitchenLine {
  billLineId: number;
  itemId: number;
  stationId: number;
  quantity: number;
  note: string;
  limitTaken: boolean;
}

/**
 * 一次下单建一张出品单（同一个出品单号）：手牌客人的（visitId）或桌台的（tableSessionId）；补录纸质单的菜早已上过，直接记为已上菜。
 * deliverTo：小程序扫了桌上的码点的菜送到哪张桌（v0.7.28，桌台名称；空为送到客人手里）
 * orderNote、deliverRoom（8.1.15 块 B3）：整单备注写进这一单每道菜的出品单；送到房间的记房号，「送到哪」没有别的时写「房 W301」
 */
export async function createKitchenItems(
  tx: Tx,
  args: {
    visitId: number | null;
    tableSessionId?: number | null;
    deliverTo?: string;
    lines: KitchenLine[];
    date: string;
    at: Date;
    actor: Actor;
    backfill: boolean;
    orderNote?: string;
    deliverRoom?: string;
  },
): Promise<string | null> {
  if (args.lines.length === 0) return null;
  const orderNo = await nextDocNo(tx, 'kitchen_order', 'CD', args.date);
  const done = args.backfill ? args.at : null;
  const deliverTo = args.deliverTo || (args.deliverRoom ? `房 ${args.deliverRoom}` : '');
  const made: number[] = [];
  // 套餐（8.1.15 菜品管理）：下单当时含哪几样记在出品单上（只读、不加锁；以后改了套餐，已经下的单还是当时的）
  const combos = await comboPartsOf(
    tx,
    args.lines.map((l) => l.itemId),
  );
  for (const l of args.lines) {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO kitchen_items (order_no, bill_line_id, visit_id, table_session_id, item_id, station_id, quantity, note, status, business_date,
                                 limit_taken, created_by, created_at, done_by, done_at, served_by, served_at, deliver_to, parts, order_note, deliver_room)
      VALUES (${orderNo}, ${l.billLineId}, ${args.visitId}, ${args.tableSessionId ?? null}, ${l.itemId}, ${l.stationId}, ${l.quantity}, ${l.note},
              ${args.backfill ? 'served' : 'queued'}, ${args.date}, ${l.limitTaken}, ${args.actor.id}, ${args.at},
              ${done ? args.actor.id : null}, ${done}, ${done ? args.actor.id : null}, ${done}, ${deliverTo},
              ${tx.json((combos.get(l.itemId) ?? []) as never)}, ${args.orderNote ?? ''}, ${args.deliverRoom ?? ''})
      RETURNING id`;
    made.push(Number(row!.id));
  }
  // 扣库存（8.0.20）：补录的一建就是已上桌，这时按用料记「该扣多少」；正常下单的等出品完成时记
  if (args.backfill) await recordRecipeUsage(tx, made);
  return orderNo;
}

/** 退菜（作废餐饮明细之后，来访、账单、明细已锁）：出品单改为已退；扣过沽清的按原份数加回（同一营业日的沽清） */
export async function cancelKitchenItem(tx: Tx, billLineId: number, reason: string, actor: Actor, at: Date) {
  const [k] = await tx<{ id: number; itemId: number; quantity: number; status: KitchenStatus; businessDate: string; limitTaken: boolean }[]>`
    SELECT id, item_id, quantity, status, business_date::text AS business_date, limit_taken FROM kitchen_items WHERE bill_line_id = ${billLineId}`;
  if (!k || k.status === 'cancelled') return;
  if (k.limitTaken) {
    await tx`UPDATE dish_limits SET remaining = remaining + ${k.quantity} WHERE item_id = ${k.itemId} AND business_date = ${k.businessDate}`;
  }
  await tx`
    UPDATE kitchen_items SET status = 'cancelled', cancelled_at = ${at}, cancelled_by = ${actor.id}, cancel_reason = ${reason.slice(0, 200)}
    WHERE id = ${k.id}`;
}

/** 结账前核对（只读）：这几位客人还没上的菜，结账页列出来提醒 */
export async function unservedDishesOf(db: Db, visitIds: number[]) {
  return db<{ tagCode: string; name: string; quantity: number; status: KitchenStatus }[]>`
    SELECT h.code AS tag_code, i.name, k.quantity, k.status
    FROM kitchen_items k JOIN service_items i ON i.id = k.item_id JOIN visits v ON v.id = k.visit_id JOIN hand_tags h ON h.id = v.tag_id
    WHERE k.visit_id IN ${db(visitIds)} AND k.status IN ('queued', 'cooking', 'done') ORDER BY k.id`;
}

// ───────────────────────── 厨房屏、点单页 ─────────────────────────

const guestName = (memberName: string | null, label: string) => memberName ?? (label || '散客');
/** 默认价格档（标准 → 专业 → 优选中第一个提供的）的单价 */
const defaultPrice = (prices: TierPrice[]) => {
  const tier = defaultTier(prices);
  return prices.find((p) => p.tier === tier)?.price ?? prices[0]!.price;
};

async function stationsWithCount(db: Db): Promise<KitchenStation[]> {
  return db<KitchenStation[]>`
    SELECT s.id, s.name, s.sort_order, s.active,
           (SELECT count(*) FROM service_items i WHERE i.station_id = s.id AND i.active)::int AS item_count
    FROM kitchen_stations s ORDER BY s.sort_order, s.id`;
}

/** 进厨房的在售菜品、默认价格档的单价、今天的沽清与点单分类（8.1.7：后台没设的按默认归） */
async function kitchenDishes(db: Db, today: string): Promise<MenuDish[]> {
  const rows = await db<
    {
      id: number;
      name: string;
      category: string;
      prices: TierPrice[];
      stationId: number;
      stationName: string;
      remaining: number | null;
      diningOutlet: string | null;
      diningGroup: string;
    }[]
  >`
    SELECT i.id, i.name, i.category, i.station_id, s.name AS station_name, ${pricesColumn(db)} AS prices,
           (SELECT d.remaining FROM dish_limits d WHERE d.item_id = i.id AND d.business_date = ${today}) AS remaining,
           i.dining_outlet, i.dining_group
    FROM service_items i JOIN kitchen_stations s ON s.id = i.station_id AND s.active
    WHERE i.active AND NOT i.technician_required ORDER BY i.dish_sort NULLS LAST, s.sort_order, s.id, i.sort_order, i.id`;
  // 8.1.17（BW10）：菜品表里排过的按排的先后（同一个小类挨在一起），没排过的在后面、照原来的顺序
  return rows.map(({ prices, diningOutlet, diningGroup, ...r }) => {
    const slot = diningSlotOf({ outlet: diningOutlet, group: diningGroup, category: r.category, stationName: r.stationName });
    // 8.1.17（BW5）：多档的菜带上各档的价，点单时弹出来选；只有一档的不带
    return { ...r, price: defaultPrice(prices), outlet: slot.outlet, group: slot.group, ...(prices.length > 1 ? { prices: sortTiers(prices) } : {}) };
  });
}

// 手牌客人的菜显示牌号；桌台的菜（第二步）显示桌号
const ITEM_COLUMNS = (db: Db) => db`
  k.id, k.order_no, k.visit_id, h.code AS tag_code, v.zone, k.table_session_id, dt.name AS table_name,
  coalesce(m.name, nullif(v.guest_label, ''), tm.name, nullif(ts.guest_label, ''), '散客') AS guest, k.item_id, bl.name,
  k.quantity, k.note, k.deliver_to, k.parts, k.status, k.station_id, s.name AS station_name, k.rush_count, k.created_at, k.started_at, k.done_at, k.served_at,
  p.display_name AS posted_by_name, coalesce(v.status, ts.status) <> 'open' AS visit_closed, k.order_note, k.deliver_room`;
const ITEM_FROM = (db: Db) => db`
  kitchen_items k JOIN service_items i ON i.id = k.item_id JOIN kitchen_stations s ON s.id = k.station_id
  JOIN bill_lines bl ON bl.id = k.bill_line_id
  LEFT JOIN visits v ON v.id = k.visit_id LEFT JOIN hand_tags h ON h.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
  LEFT JOIN table_sessions ts ON ts.id = k.table_session_id LEFT JOIN dining_tables dt ON dt.id = ts.table_id
  LEFT JOIN members tm ON tm.id = ts.member_id
  JOIN staff p ON p.id = k.created_by`;

export async function kitchenBoard(db: Db, deps: Deps): Promise<KitchenBoard> {
  const now = new Date();
  const today = await businessDate(db as Tx, deps, now);
  const rules = await loadDiningRules(db);
  const [stations, dishes] = await Promise.all([stationsWithCount(db), kitchenDishes(db, today)]);
  // 今天还在做的、出了餐还没上的，以及最近上过 / 退过的 30 道（核对用）
  const open = await db<KitchenItem[]>`
    SELECT ${ITEM_COLUMNS(db)} FROM ${ITEM_FROM(db)}
    WHERE k.status IN ('queued', 'cooking', 'done') AND k.store_id = ${currentStoreId()} ORDER BY k.created_at, k.id`;
  const recent = await db<KitchenItem[]>`
    SELECT ${ITEM_COLUMNS(db)} FROM ${ITEM_FROM(db)}
    WHERE k.business_date = ${today} AND k.status IN ('served', 'cancelled') AND k.store_id = ${currentStoreId()} ORDER BY coalesce(k.served_at, k.cancelled_at) DESC, k.id DESC LIMIT 30`;
  const [t] = await db<{ orders: number; dishes: number; served: number; cancelled: number; avgMinutes: number | null }[]>`
    SELECT count(DISTINCT order_no)::int AS orders, coalesce(sum(quantity) FILTER (WHERE status <> 'cancelled'), 0)::int AS dishes,
           coalesce(sum(quantity) FILTER (WHERE status = 'served'), 0)::int AS served,
           coalesce(sum(quantity) FILTER (WHERE status = 'cancelled'), 0)::int AS cancelled,
           round(avg(extract(epoch FROM done_at - created_at) / 60) FILTER (WHERE done_at IS NOT NULL AND status <> 'cancelled'))::int AS avg_minutes
    FROM kitchen_items WHERE business_date = ${today} AND store_id = ${currentStoreId()}`;
  return { serverTime: now.toISOString(), businessDate: today, rules, stations, items: [...open, ...recent], dishes, today: t! };
}

export async function diningMenu(db: Db, deps: Deps): Promise<DiningMenu> {
  const today = await businessDate(db as Tx, deps, new Date());
  const { selfVoidMinutes } = await loadFrontdeskRules(db);
  // 点单页的菜单带上做法、加料、套餐内容（8.1.15 菜品管理；厨房屏 5 秒取一次的沽清列表不带）
  return { rules: await loadDiningRules(db), businessDate: today, dishes: await withDishOptions(db, await kitchenDishes(db, today)), selfVoidMinutes };
}

/** 点单页按手牌找在店客人：只给点单需要的信息（不含会员手机号、余额与账单） */
export async function diningGuest(db: Db, tagCode: string): Promise<DiningGuest> {
  const [v] = await db<{ visitId: number }[]>`
    SELECT v.id AS visit_id FROM visits v JOIN hand_tags h ON h.id = v.tag_id
    WHERE v.status = 'open' AND upper(h.code) = upper(${tagCode})`;
  if (v) return { ...(await diningGuestOf(db, v.visitId)), via: 'tag' };
  // 客房点餐（8.0.20）：不是手牌号的话当房号找在住的客人（住客本来就有手牌与账单，点的菜挂在那张账单上、退房时一起结）
  const [stay] = await db<{ visitId: number }[]>`
    SELECT s.visit_id FROM room_stays s JOIN rooms r ON r.id = s.room_id JOIN visits vv ON vv.id = s.visit_id
    WHERE s.status = 'open' AND vv.status = 'open' AND upper(r.room_no) = upper(${tagCode})`;
  if (stay) return { ...(await diningGuestOf(db, stay.visitId)), via: 'room' };
  throw notFound(`手牌 ${tagCode} 现在没有在店客人（也没有这个房号的在住客人），请核对`);
}

/**
 * 点单页找客人（8.1.15 块 B3）：手牌号、房号至少一样。都填时按手牌找、房号是送到哪；只填房号的按 findGuestByRoom 找这间房现在的客人；
 * 只填手牌号的照旧（手牌找不到时当房号找在住的客人）
 */
async function diningGuestFor(db: Db, q: { tag?: string; room?: string }): Promise<DiningGuest> {
  if (q.tag && q.room) {
    const visitId = await findGuestByTag(db, q.tag);
    if (!visitId) throw notFound(`手牌 ${q.tag} 现在没有在店客人，请核对`);
    return { ...(await diningGuestOf(db, visitId)), via: 'tag', deliverRoom: q.room };
  }
  if (q.room) {
    const hit = await findGuestByRoom(db, q.room);
    if (!hit) throw notFound(`房号 ${q.room} 现在没有登记的客人，请核对房号，或填手牌号`);
    return { ...(await diningGuestOf(db, hit.visitId)), via: 'room', deliverRoom: q.room };
  }
  const g = await diningGuest(db, q.tag!);
  return g.via === 'room' ? { ...g, deliverRoom: q.tag!.toUpperCase() } : g;
}

/** 这位客人在住的客房（没住店是 null） */
export async function openRoomOf(db: Db, visitId: number): Promise<string | null> {
  const [r] = await db<{ roomNo: string }[]>`
    SELECT r.room_no FROM room_stays s JOIN rooms r ON r.id = s.room_id WHERE s.visit_id = ${visitId} AND s.status = 'open' ORDER BY s.id LIMIT 1`;
  return r?.roomNo ?? null;
}

/**
 * 按来访取点单页的客人信息。下单后的回复用它：点单已经生效，不再要求客人此刻仍在店
 * （下单与回复之间客人刚好结账离店时，不能把已生效的点单说成失败；Codex 审查 PR #18）
 */
export async function diningGuestOf(db: Db, visitId: number): Promise<DiningGuest> {
  const [v] = await db<{ visitId: number; tagCode: string; zone: 'male' | 'female'; memberName: string | null; guestLabel: string }[]>`
    SELECT v.id AS visit_id, h.code AS tag_code, v.zone, m.name AS member_name, v.guest_label
    FROM visits v JOIN hand_tags h ON h.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
    WHERE v.id = ${visitId} AND v.store_id = ${currentStoreId()}`;
  if (!v) throw notFound('来访不存在');
  const pending = await db<DiningGuest['pending']>`
    SELECT k.id, k.bill_line_id, k.item_id, l.name, k.quantity, k.note, k.status, k.rush_count, k.created_at, l.amount, l.posted_by, l.posted_at,
           l.addon_of, ${pendingAddonsColumn(db)}
    FROM kitchen_items k JOIN bill_lines l ON l.id = k.bill_line_id
    WHERE k.visit_id = ${v.visitId} AND k.status IN ('queued', 'cooking', 'done') ORDER BY k.id`;
  return { visitId: v.visitId, tagCode: v.tagCode, zone: v.zone, guest: guestName(v.memberName, v.guestLabel), pending, roomNo: await openRoomOf(db, v.visitId) };
}

const KITCHEN_ACTIONS = ['start', 'done', 'serve', 'undo'] as const;
type KitchenAction = (typeof KITCHEN_ACTIONS)[number];

/**
 * 厨房屏：开始做、出餐、上菜、撤回一步（点错了）；规则「出餐即算上菜」时出餐直接记为已上菜。
 * from：页面上看到的状态，与现在不同就拒绝（连点两下「撤回」不会退两步）；
 * servedOnly：只有点单权限的服务员只能上菜、撤回上菜（在锁内判断，不会被别人刚撤回的状态带过去）。
 */
export async function kitchenAction(deps: Deps, id: number, action: KitchenAction, ctx: OpContext, opts: { from?: KitchenStatus; servedOnly?: boolean } = {}) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const [k] = await tx<{ status: KitchenStatus; startedAt: string | null; orderNo: string }[]>`
      SELECT status, started_at, order_no FROM kitchen_items WHERE id = ${id} AND store_id = ${currentStoreId()} FOR UPDATE`;
    if (!k) throw notFound('出品单不存在');
    if (k.status === 'cancelled') throw conflict('DISH_CANCELLED', '这道菜已经退了，请刷新');
    const rules = await loadDiningRules(tx);
    const stale = () => conflict('DISH_CHANGED', '这道菜的状态刚刚变了，请刷新');
    if (opts.from && opts.from !== k.status) throw stale();
    if (opts.servedOnly && (action === 'start' || action === 'done' || (action === 'undo' && k.status !== 'served'))) {
      throw new AppError(403, 'KITCHEN_ONLY', action === 'undo' ? '撤回出餐、撤回开始做由厨房在出品屏上操作' : '开始做、出餐由厨房在出品屏上操作');
    }
    if (action === 'start') {
      if (k.status !== 'queued') throw stale();
      await tx`UPDATE kitchen_items SET status = 'cooking', started_at = ${at}, started_by = ${ctx.actor.id} WHERE id = ${id}`;
    } else if (action === 'done') {
      if (k.status !== 'queued' && k.status !== 'cooking') throw stale();
      await tx`UPDATE kitchen_items SET status = 'done', done_at = ${at}, done_by = ${ctx.actor.id} WHERE id = ${id}`;
      // 规则「出餐即算上菜」：不用服务员再点上菜
      if (!rules.trackServed) await tx`UPDATE kitchen_items SET status = 'served', served_at = ${at}, served_by = ${ctx.actor.id} WHERE id = ${id}`;
      // 扣库存（8.0.20）：出品完成时按用料记「该扣多少」（只插入；每分钟的任务再开耗用单）
      await recordRecipeUsage(tx, [id]);
    } else if (action === 'serve') {
      if (k.status !== 'done') throw stale();
      await tx`UPDATE kitchen_items SET status = 'served', served_at = ${at}, served_by = ${ctx.actor.id} WHERE id = ${id}`;
    } else {
      // 撤回一步：已上菜 → 已出餐 → 制作中（开始过）/ 待做 → 待做
      if (k.status === 'served') {
        await tx`UPDATE kitchen_items SET status = 'done', served_at = NULL, served_by = NULL WHERE id = ${id}`;
      } else if (k.status === 'done') {
        await tx`
          UPDATE kitchen_items SET status = ${k.startedAt ? 'cooking' : 'queued'}, done_at = NULL, done_by = NULL WHERE id = ${id}`;
        // 扣库存（8.0.20）：撤回出品完成，记一条冲回
        await reverseRecipeUsage(tx, id);
      } else if (k.status === 'cooking') {
        await tx`UPDATE kitchen_items SET status = 'queued', started_at = NULL, started_by = NULL WHERE id = ${id}`;
      } else {
        throw conflict('DISH_CHANGED', '还没开始做，没有可以撤回的');
      }
    }
  });
}

/** 催单：服务员按客人催，厨房屏上这道菜标出催了几次 */
export async function rushDish(deps: Deps, id: number, ctx: OpContext) {
  const at = ctx.at ?? new Date();
  const [k] = await deps.sql<{ id: number }[]>`
    UPDATE kitchen_items SET rush_count = rush_count + 1, rushed_at = ${at} WHERE id = ${id} AND status IN ('queued', 'cooking') RETURNING id`;
  if (!k) throw conflict('DISH_CHANGED', '这道菜已经出餐或退了，不用催了');
}

const LimitInput = z.object({
  /** 今天还剩几份；0 为沽清，null 为不限量（取消沽清） */
  remaining: z.number('份数必须是整数').int('份数必须是整数').min(0, '份数不能为负').max(9999, '份数最多 9999').nullable(),
});

/** 设沽清：今天还剩几份（0 为沽清）；取消后不限量。记审计 */
export async function setDishLimit(deps: Deps, itemId: number, raw: unknown, ctx: OpContext) {
  const { remaining } = parse(LimitInput, raw);
  await deps.sql.begin(async (tx) => {
    const at = ctx.at ?? new Date();
    const today = await businessDate(tx, deps, at);
    const [item] = await tx<{ name: string; stationId: number | null }[]>`SELECT name, station_id FROM service_items WHERE id = ${itemId}`;
    if (!item) throw notFound('菜品不存在');
    if (item.stationId === null) throw unprocessable('DISH_NOT_KITCHEN', `「${item.name}」不进厨房，不用沽清`);
    if (remaining === null) {
      await tx`DELETE FROM dish_limits WHERE item_id = ${itemId}`;
    } else {
      await tx`
        INSERT INTO dish_limits (item_id, business_date, remaining, updated_at, updated_by) VALUES (${itemId}, ${today}, ${remaining}, ${at}, ${ctx.actor.id})
        ON CONFLICT (item_id) DO UPDATE SET business_date = EXCLUDED.business_date, remaining = EXCLUDED.remaining,
          updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'dish_limit_set',
      targetType: 'item',
      targetId: itemId,
      detail: { name: item.name, remaining, summary: remaining === null ? `取消「${item.name}」的沽清` : remaining === 0 ? `「${item.name}」沽清` : `「${item.name}」限量 ${remaining} 份` },
      ip: ctx.ip,
      businessDate: today,
    });
  });
}

// ───────────────────────── 后台「餐饮」 ─────────────────────────

export async function diningAdmin(db: Db): Promise<DiningAdmin> {
  const [meta] = await db<{ updatedAt: string; updatedBy: string | null }[]>`
    SELECT s.updated_at, st.display_name AS updated_by FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = 'dining_rules'`;
  const items = await db<
    {
      id: number;
      name: string;
      category: string;
      prices: TierPrice[];
      stationId: number | null;
      technicianRequired: boolean;
      stationName: string | null;
      diningOutlet: string | null;
      diningGroup: string;
    }[]
  >`
    SELECT i.id, i.name, i.category, i.station_id, i.technician_required, ${pricesColumn(db)} AS prices,
           s.name AS station_name, i.dining_outlet, i.dining_group
    FROM service_items i LEFT JOIN kitchen_stations s ON s.id = i.station_id
    WHERE i.active ORDER BY i.sort_order, i.id`;
  return {
    rules: await loadDiningRules(db),
    rulesUpdatedAt: meta?.updatedAt ? new Date(meta.updatedAt).toISOString() : null,
    rulesUpdatedBy: meta?.updatedBy ?? null,
    stations: await stationsWithCount(db),
    items: items.map(({ prices, stationName, diningOutlet, diningGroup, ...r }) => {
      const { assigned, ...slot } = diningSlotOf({ outlet: diningOutlet, group: diningGroup, category: r.category, stationName });
      return { ...r, price: defaultPrice(prices), slot, slotAssigned: assigned };
    }),
  };
}

const RulesInput = z.object({
  enabled: z.boolean(),
  trackServed: z.boolean(),
  warnMinutes: z.number('分钟数必须是整数').int('分钟数必须是整数').min(1, '至少 1 分钟').max(180, '最多 180 分钟'),
  // 8.0.8：桌台点单开关（A05）、小额退菜上限（B02）
  tablesEnabled: z.boolean(),
  voidFreeCents: z
    .number('金额必须是整数（分）')
    .int('金额必须是整数（分）')
    .min(0, '不能小于 0')
    .max(MAX_VOID_FREE_CENTS, `最多 ¥${MAX_VOID_FREE_CENTS / 100}`),
  // 8.1.15（块 B1）：结账以后桌台先待清台
  clearAfterCheckout: z.boolean(),
});
const StationInput = z.object({
  name: z.string().trim().min(1, '请填写档口名称').max(MAX_STATION_NAME, `档口名称最多 ${MAX_STATION_NAME} 字`),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  active: z.boolean().default(true),
});
/**
 * 菜品的出品档口与点单分类（8.1.7）：两样都可以不带（不带的不改），至少带一样。
 * slot 是点单分类的编码（restaurant:餐饮、water:调酒、fruit……），null 为「按默认归」（清掉设过的）
 */
const ItemsInput = z.object({
  items: z
    .array(
      z
        .object({
          id: z.number().int().positive(),
          stationId: z.number().int().positive().nullable().optional(),
          slot: z
            .string()
            .max(40)
            .nullable()
            .optional()
            .refine((v) => v === undefined || v === null || parseSlotKey(v) !== null, '点单分类不对，请刷新后重试'),
        })
        .refine((i) => i.stationId !== undefined || i.slot !== undefined, '没有要调整的内容'),
    )
    .min(1, '没有要调整的菜品')
    .max(500),
});

export function registerDiningRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  // 后台「餐饮」：规则（只有店主）、出品档口与菜品的档口（能管理价目的岗位）
  app.get('/api/admin/dining', { preHandler: guardAny('settings.manage', 'catalog.manage') }, async () => diningAdmin(sql));

  app.put('/api/admin/dining/rules', { preHandler: guard('settings.manage') }, async (req) => {
    await saveRuleSetting(sql, 'dining_rules', loadDiningRules, (before) => parse(RulesInput, { ...before, ...parse(RulesInput.partial(), req.body) }), ctxOf(req));
    return diningAdmin(sql);
  });

  app.post('/api/admin/dining/stations', { preHandler: guard('catalog.manage') }, async (req) => {
    const s = parse(StationInput, req.body);
    await sql.begin(async (tx) => {
      const [dup] = await tx<{ id: number }[]>`SELECT id FROM kitchen_stations WHERE lower(btrim(name)) = lower(${s.name})`;
      if (dup) throw conflict('STATION_NAME_TAKEN', `已有档口「${s.name}」`);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO kitchen_stations (name, sort_order, active, created_by) VALUES (${s.name}, ${s.sortOrder}, ${s.active}, ${req.actor.id}) RETURNING id`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'kitchen_station_saved', targetType: 'kitchen_station', targetId: row!.id, detail: { summary: `新建出品档口「${s.name}」` }, ip: req.ip });
    });
    return diningAdmin(sql);
  });

  app.put('/api/admin/dining/stations/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const s = parse(StationInput, req.body);
    await sql.begin(async (tx) => {
      const [cur] = await tx<{ name: string }[]>`SELECT name FROM kitchen_stations WHERE id = ${id} FOR UPDATE`;
      if (!cur) throw notFound('档口不存在');
      const [dup] = await tx<{ id: number }[]>`SELECT id FROM kitchen_stations WHERE lower(btrim(name)) = lower(${s.name}) AND id <> ${id}`;
      if (dup) throw conflict('STATION_NAME_TAKEN', `已有档口「${s.name}」`);
      await tx`UPDATE kitchen_stations SET name = ${s.name}, sort_order = ${s.sortOrder}, active = ${s.active}, updated_at = now() WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'kitchen_station_saved',
        targetType: 'kitchen_station',
        targetId: id,
        detail: { summary: `修改出品档口「${cur.name}」${cur.name !== s.name ? ` → 「${s.name}」` : ''}${s.active ? '' : '（停用）'}` },
        ip: req.ip,
      });
    });
    return diningAdmin(sql);
  });

  // 菜品的出品档口与点单分类（8.1.7）：只提交要改的菜品（按项目 id 升序加锁）
  app.put('/api/admin/dining/items', { preHandler: guard('catalog.manage') }, async (req) => {
    const { items } = parse(ItemsInput, req.body);
    const ids = [...new Set(items.map((i) => i.id))];
    if (ids.length !== items.length) throw unprocessable('DUPLICATE_ITEM', '同一道菜提交了两次');
    await sql.begin(async (tx) => {
      const rows = await tx<{ id: number; name: string; stationId: number | null; technicianRequired: boolean; diningOutlet: string | null; diningGroup: string }[]>`
        SELECT id, name, station_id, technician_required, dining_outlet, dining_group FROM service_items WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
      if (rows.length !== ids.length) throw notFound('有菜品不存在，请刷新后重试');
      const tech = rows.find((r) => r.technicianRequired && items.some((i) => i.id === r.id && i.stationId !== undefined && i.stationId !== null));
      if (tech) throw unprocessable('ITEM_NEEDS_TECHNICIAN', `「${tech.name}」需要技师，不进厨房；要进厨房请先在「技师」里取消「需要技师」`);
      const stationIds = [...new Set(items.flatMap((i) => (i.stationId === undefined || i.stationId === null ? [] : [i.stationId])))];
      const stations = stationIds.length ? await tx<{ id: number; name: string }[]>`SELECT id, name FROM kitchen_stations WHERE id IN ${tx(stationIds)}` : [];
      if (stations.length !== stationIds.length) throw notFound('有档口不存在，请刷新后重试');
      const byId = new Map(items.map((i) => [i.id, i]));

      // 出品档口：带了而且变了的
      const wantStation = (r: (typeof rows)[number]) => byId.get(r.id)!.stationId;
      const stationChanged = rows.filter((r) => wantStation(r) !== undefined && r.stationId !== wantStation(r));
      for (const r of stationChanged) await tx`UPDATE service_items SET station_id = ${wantStation(r)!}, updated_at = now() WHERE id = ${r.id}`;
      if (stationChanged.length) {
        const name = (sid: number | null) => (sid === null ? '不进厨房' : stations.find((s) => s.id === sid)!.name);
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'items_station_updated',
          targetType: 'item',
          detail: {
            summary: stationChanged
              .map((r) => `${r.name} → ${name(wantStation(r)!)}`)
              .join('；')
              .slice(0, 500),
          },
          ip: req.ip,
        });
      }

      // 点单分类（8.1.7）：带了而且变了的；null 为清掉、按默认归
      const wantSlot = (r: (typeof rows)[number]) => {
        const v = byId.get(r.id)!.slot;
        return v === undefined ? undefined : v === null ? null : parseSlotKey(v)!;
      };
      const slotChanged = rows.filter((r) => {
        const w = wantSlot(r);
        if (w === undefined) return false;
        return w === null ? r.diningOutlet !== null : r.diningOutlet !== w.outlet || r.diningGroup !== w.group;
      });
      for (const r of slotChanged) {
        const w = wantSlot(r)!;
        await tx`UPDATE service_items SET dining_outlet = ${w?.outlet ?? null}, dining_group = ${w?.group ?? ''}, updated_at = now() WHERE id = ${r.id}`;
      }
      if (slotChanged.length) {
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'items_slot_updated',
          targetType: 'item',
          detail: {
            summary: slotChanged
              .map((r) => {
                const w = wantSlot(r);
                return `${r.name} → ${w ? slotLabel(w) : '按默认'}`;
              })
              .join('；')
              .slice(0, 500),
          },
          ip: req.ip,
        });
      }
    });
    return diningAdmin(sql);
  });

  // 点单页：菜单与沽清、按手牌找客人、下单（挂账）、催单
  // 8.0.8：前台「加项目」看余量（B03）、退菜看小额上限（B02）、收银与看日结的看桌台点单开没开（A05），都读这一份
  app.get('/api/dining/menu', { preHandler: guardAny('dining.order', 'dining.kitchen', 'frontdesk.operate', 'frontdesk.checkout', 'ledger.export', 'report.executive') }, async () =>
    diningMenu(sql, deps),
  );

  // 8.1.15（块 B3）：手牌号（tag）、房号（room）至少带一样；只带 tag 的照旧
  app.get('/api/dining/guest', { preHandler: guard('dining.order') }, async (req) => {
    const q = parse(
      z.object({ tag: z.string().trim().max(16).optional(), room: DeliverRoomField }).refine((v) => !!v.tag || !!v.room, '请输入手牌号或房号'),
      req.query ?? {},
    );
    return diningGuestFor(sql, { ...(q.tag ? { tag: q.tag } : {}), ...(q.room ? { room: q.room } : {}) });
  });

  // 下单就是挂账（断网后的「结果待确认」按前台的操作编号查回、作废）。8.1.15（块 B3）起按出品口逐行核对「在某个出品口下单」，
  // 不再另要「前台挂账」（康美部只有水吧、果吧的下单权限）；只填房号找到的客人在挂账的事务里再核对一次这间房还是他
  app.post('/api/dining/orders', { preHandler: guard('dining.order') }, async (req) => {
    const body = parse(z.object({ visitId: z.number('请先选客人').int().positive('请先选客人'), toRoom: z.boolean().optional() }).passthrough(), req.body);
    const { postCharges } = await import('./frontdesk/bills');
    const order = await prepareDiningOrder(sql, req.actor, req.body);
    // 客房点餐（8.0.20）：送到客房的，出品单上写房号。住哪间在挂账的事务里、核对完操作编号之后才查（见 PostOptions.toRoom）
    const visitId = body.visitId;
    const toRoom = body.toRoom
      ? async (tx: Tx) => {
          const roomNo = await openRoomOf(tx, visitId);
          if (!roomNo) throw unprocessable('ROOM_NOT_STAYING', '这位客人现在没有在住的客房，不能送到客房');
          return `客房 ${roomNo}`;
        }
      : order.toRoom;
    const { toRoom: _toRoom, ...rest } = req.body as Record<string, unknown>;
    // 点单页只能点进厨房的菜（其他项目、手动金额请到前台登记）
    await postCharges(deps, visitId, { ...rest, customLines: [] } as never, ctxOf(req), { dining: { onlyKitchen: true }, ...(toRoom ? { toRoom } : {}) });
    return diningGuestOf(sql, body.visitId);
  });

  // 点单页下单「结果待确认」的查回与确认作废（8.1.15，Codex 审查 f6327a4）：下单只要「餐饮点单」+ 出品口权限（康美部没有前台权限），
  // 查回、作废也照这个来——有「餐饮点单」，或有前台原来那一项（查回要「查看在店手牌」、作废要「接待发牌、挂账、换牌」，同一台设备上
  // 前台的同事也能处理）。只认点单用的业务类型（挂账 bill_post）；查回只说生效没生效、记在哪次来访上，不给整张账单；
  // 编号属于别的前台业务的，这里只答「没查到」、不作废（作废登记绑定业务类型，只拦同类型的原请求，见 lib/fences.ts）
  const DiningOpKey = z.object({ key: z.uuid('操作编号格式不正确') });
  const diningOpResult = (r: FrontdeskOpLookup): FrontdeskOpLookup => {
    if (!r.found) return r;
    if (r.type !== 'bill_post') return { found: false, abandoned: false };
    return { found: true, type: 'dining_order', visitId: r.visit.id };
  };
  app.get('/api/dining/ops/:key', { preHandler: guardAny('dining.order', 'frontdesk.read') }, async (req) => {
    const { key } = parse(DiningOpKey, req.params);
    const { lookupFrontdeskOp } = await import('./frontdesk/visits');
    return diningOpResult((await lookupFrontdeskOp(sql, key, deps.config.timezone, 'bill_post')) as FrontdeskOpLookup);
  });
  app.post('/api/dining/ops/:key/abandon', { preHandler: guardAny('dining.order', 'frontdesk.operate') }, async (req) => {
    const { key } = parse(DiningOpKey, req.params);
    const { abandonFrontdeskOp } = await import('./frontdesk/visits');
    return diningOpResult((await abandonFrontdeskOp(deps, key, 'bill_post', ctxOf(req))) as FrontdeskOpLookup);
  });

  app.post('/api/dining/items/:id/rush', { preHandler: guard('dining.order') }, async (req) => {
    await rushDish(deps, parse(idParam, req.params).id, ctxOf(req));
    return { ok: true };
  });

  // 厨房屏：出品状态、沽清
  app.get('/api/kitchen', { preHandler: guardAny('dining.kitchen', 'dining.order') }, async () => kitchenBoard(sql, deps));

  app.post('/api/kitchen/items/:id/:action', { preHandler: guardAny('dining.kitchen', 'dining.order') }, async (req) => {
    const { id, action } = parse(z.object({ id: z.coerce.number().int().positive(), action: z.enum(KITCHEN_ACTIONS, '操作不正确') }), req.params);
    const { from } = parse(z.object({ from: z.enum(KITCHEN_STATUSES).optional() }), req.body ?? {});
    // 服务员（只有点单权限）只能点「上菜」与撤回上菜；开始做、出餐要厨房的岗位
    await kitchenAction(deps, id, action, ctxOf(req), { from, servedOnly: !can(req.actor, 'dining.kitchen') });
    return kitchenBoard(sql, deps);
  });

  app.put('/api/kitchen/limits/:id', { preHandler: guard('dining.kitchen') }, async (req) => {
    await setDishLimit(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return kitchenBoard(sql, deps);
  });
}
