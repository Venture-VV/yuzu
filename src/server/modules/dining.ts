// 餐饮（S5 第一步）：出品档口、点单、厨房出品屏（KDS）与估清。
//
// 钱只在账单明细里：点单就是给客人挂账（与前台挂账同一条路径 frontdesk/bills.ts 的 postCharges，同一个事务里建出品单），
// 退菜就是作废明细（voidLine，同一个事务里把出品单改为已退、按原份数加回估清）。出品单只记出品状态与时间。
//
// 并发：挂账、作废的加锁顺序是「来访 → 账单 → 明细 → （技师队列 → 钟单 → 技师状态）→ 估清 → 出品单」；
// 厨房屏的开始 / 出餐 / 上菜只锁出品单一行，设估清只锁估清一行，都不反向加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_DINING_RULES, KITCHEN_STATUSES, MAX_STATION_NAME, type DiningAdmin, type DiningGuest, type DiningMenu, type DiningRules, type KitchenBoard, type KitchenItem, type KitchenStation, type KitchenStatus, type MenuDish } from '@shared/dining';
import { defaultTier, type TierPrice } from '@shared/catalog';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps, OpContext } from '../lib/context';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { businessDate, nextDocNo, setTxTimeouts } from './frontdesk/common';
import { pricesColumn } from './pricing';
import { ctxOf } from '../lib/context';

export async function loadDiningRules(db: Db): Promise<DiningRules> {
  const [row] = await db<{ value: Partial<DiningRules> }[]>`SELECT value FROM settings WHERE key = 'dining_rules'`;
  return { ...DEFAULT_DINING_RULES, ...(row?.value ?? {}) };
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
 * 估清：这几道菜今天还剩的份数够不够，够就扣掉（按项目 id 升序锁估清行）。没有当天记录的不限量。
 * 返回扣过估清的项目（退菜时按原份数加回）。
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
      throw conflict(
        'DISH_SOLD_OUT',
        r.remaining === 0 ? `「${w.name}」今天已估清（卖完了），请换一道菜` : `「${w.name}」今天只剩 ${r.remaining} 份，请改份数或换一道菜`,
        { itemId: r.itemId, remaining: r.remaining },
      );
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

/** 一次下单建一张出品单（同一个出品单号）：手牌客人的（visitId）或桌台的（tableSessionId）；补录纸质单的菜早已上过，直接记为已上菜 */
export async function createKitchenItems(
  tx: Tx,
  args: { visitId: number | null; tableSessionId?: number | null; lines: KitchenLine[]; date: string; at: Date; actor: Actor; backfill: boolean },
): Promise<string | null> {
  if (args.lines.length === 0) return null;
  const orderNo = await nextDocNo(tx, 'kitchen_order', 'CD', args.date);
  const done = args.backfill ? args.at : null;
  for (const l of args.lines) {
    await tx`
      INSERT INTO kitchen_items (order_no, bill_line_id, visit_id, table_session_id, item_id, station_id, quantity, note, status, business_date,
                                 limit_taken, created_by, created_at, done_by, done_at, served_by, served_at)
      VALUES (${orderNo}, ${l.billLineId}, ${args.visitId}, ${args.tableSessionId ?? null}, ${l.itemId}, ${l.stationId}, ${l.quantity}, ${l.note},
              ${args.backfill ? 'served' : 'queued'}, ${args.date}, ${l.limitTaken}, ${args.actor.id}, ${args.at},
              ${done ? args.actor.id : null}, ${done}, ${done ? args.actor.id : null}, ${done})`;
  }
  return orderNo;
}

/** 退菜（作废餐饮明细之后，来访、账单、明细已锁）：出品单改为已退；扣过估清的按原份数加回（同一营业日的估清） */
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

/** 进厨房的在售菜品、默认价格档的单价与今天的估清 */
async function kitchenDishes(db: Db, today: string): Promise<MenuDish[]> {
  const rows = await db<{ id: number; name: string; category: string; prices: TierPrice[]; stationId: number; stationName: string; remaining: number | null }[]>`
    SELECT i.id, i.name, i.category, i.station_id, s.name AS station_name, ${pricesColumn(db)} AS prices,
           (SELECT d.remaining FROM dish_limits d WHERE d.item_id = i.id AND d.business_date = ${today}) AS remaining
    FROM service_items i JOIN kitchen_stations s ON s.id = i.station_id AND s.active
    WHERE i.active AND NOT i.technician_required ORDER BY s.sort_order, s.id, i.sort_order, i.id`;
  return rows.map(({ prices, ...r }) => ({ ...r, price: defaultPrice(prices) }));
}

// 手牌客人的菜显示牌号；桌台的菜（第二步）显示桌号
const ITEM_COLUMNS = (db: Db) => db`
  k.id, k.order_no, k.visit_id, h.code AS tag_code, v.zone, k.table_session_id, dt.name AS table_name,
  coalesce(m.name, nullif(v.guest_label, ''), tm.name, nullif(ts.guest_label, ''), '散客') AS guest, k.item_id, i.name,
  k.quantity, k.note, k.status, k.station_id, s.name AS station_name, k.rush_count, k.created_at, k.started_at, k.done_at, k.served_at,
  p.display_name AS posted_by_name, coalesce(v.status, ts.status) <> 'open' AS visit_closed`;
const ITEM_FROM = (db: Db) => db`
  kitchen_items k JOIN service_items i ON i.id = k.item_id JOIN kitchen_stations s ON s.id = k.station_id
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
    WHERE k.status IN ('queued', 'cooking', 'done') ORDER BY k.created_at, k.id`;
  const recent = await db<KitchenItem[]>`
    SELECT ${ITEM_COLUMNS(db)} FROM ${ITEM_FROM(db)}
    WHERE k.business_date = ${today} AND k.status IN ('served', 'cancelled') ORDER BY coalesce(k.served_at, k.cancelled_at) DESC, k.id DESC LIMIT 30`;
  const [t] = await db<{ orders: number; dishes: number; served: number; cancelled: number; avgMinutes: number | null }[]>`
    SELECT count(DISTINCT order_no)::int AS orders, coalesce(sum(quantity) FILTER (WHERE status <> 'cancelled'), 0)::int AS dishes,
           coalesce(sum(quantity) FILTER (WHERE status = 'served'), 0)::int AS served,
           coalesce(sum(quantity) FILTER (WHERE status = 'cancelled'), 0)::int AS cancelled,
           round(avg(extract(epoch FROM done_at - created_at) / 60) FILTER (WHERE done_at IS NOT NULL AND status <> 'cancelled'))::int AS avg_minutes
    FROM kitchen_items WHERE business_date = ${today}`;
  return { serverTime: now.toISOString(), businessDate: today, rules, stations, items: [...open, ...recent], dishes, today: t! };
}

export async function diningMenu(db: Db, deps: Deps): Promise<DiningMenu> {
  const today = await businessDate(db as Tx, deps, new Date());
  return { rules: await loadDiningRules(db), businessDate: today, dishes: await kitchenDishes(db, today) };
}

/** 点单页按手牌找在店客人：只给点单需要的信息（不含会员手机号、余额与账单） */
export async function diningGuest(db: Db, tagCode: string): Promise<DiningGuest> {
  const [v] = await db<{ visitId: number }[]>`
    SELECT v.id AS visit_id FROM visits v JOIN hand_tags h ON h.id = v.tag_id
    WHERE v.status = 'open' AND upper(h.code) = upper(${tagCode})`;
  if (!v) throw notFound(`手牌 ${tagCode} 现在没有在店客人，请核对牌号`);
  return diningGuestOf(db, v.visitId);
}

/**
 * 按来访取点单页的客人信息。下单后的回复用它：点单已经生效，不再要求客人此刻仍在店
 * （下单与回复之间客人刚好结账离店时，不能把已生效的点单说成失败；Codex 审查 PR #18）
 */
export async function diningGuestOf(db: Db, visitId: number): Promise<DiningGuest> {
  const [v] = await db<{ visitId: number; tagCode: string; zone: 'male' | 'female'; memberName: string | null; guestLabel: string }[]>`
    SELECT v.id AS visit_id, h.code AS tag_code, v.zone, m.name AS member_name, v.guest_label
    FROM visits v JOIN hand_tags h ON h.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
    WHERE v.id = ${visitId}`;
  if (!v) throw notFound('来访不存在');
  const pending = await db<DiningGuest['pending']>`
    SELECT k.id, k.bill_line_id, i.name, k.quantity, k.note, k.status, k.rush_count, k.created_at
    FROM kitchen_items k JOIN service_items i ON i.id = k.item_id
    WHERE k.visit_id = ${v.visitId} AND k.status IN ('queued', 'cooking', 'done') ORDER BY k.id`;
  return { visitId: v.visitId, tagCode: v.tagCode, zone: v.zone, guest: guestName(v.memberName, v.guestLabel), pending };
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
      SELECT status, started_at, order_no FROM kitchen_items WHERE id = ${id} FOR UPDATE`;
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
  /** 今天还剩几份；0 为估清，null 为不限量（取消估清） */
  remaining: z.number('份数必须是整数').int('份数必须是整数').min(0, '份数不能为负').max(9999, '份数最多 9999').nullable(),
});

/** 设估清：今天还剩几份（0 为估清）；取消后不限量。记审计 */
export async function setDishLimit(deps: Deps, itemId: number, raw: unknown, ctx: OpContext) {
  const { remaining } = parse(LimitInput, raw);
  await deps.sql.begin(async (tx) => {
    const at = ctx.at ?? new Date();
    const today = await businessDate(tx, deps, at);
    const [item] = await tx<{ name: string; stationId: number | null }[]>`SELECT name, station_id FROM service_items WHERE id = ${itemId}`;
    if (!item) throw notFound('菜品不存在');
    if (item.stationId === null) throw unprocessable('DISH_NOT_KITCHEN', `「${item.name}」不进厨房，不用估清`);
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
      detail: { name: item.name, remaining, summary: remaining === null ? `取消「${item.name}」的估清` : remaining === 0 ? `「${item.name}」估清` : `「${item.name}」限量 ${remaining} 份` },
      ip: ctx.ip,
      businessDate: today,
    });
  });
}

// ───────────────────────── 后台「餐饮」 ─────────────────────────

export async function diningAdmin(db: Db): Promise<DiningAdmin> {
  const [meta] = await db<{ updatedAt: string; updatedBy: string | null }[]>`
    SELECT s.updated_at, st.display_name AS updated_by FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = 'dining_rules'`;
  const items = await db<{ id: number; name: string; category: string; prices: TierPrice[]; stationId: number | null; technicianRequired: boolean }[]>`
    SELECT i.id, i.name, i.category, i.station_id, i.technician_required, ${pricesColumn(db)} AS prices
    FROM service_items i WHERE i.active ORDER BY i.sort_order, i.id`;
  return {
    rules: await loadDiningRules(db),
    rulesUpdatedAt: meta?.updatedAt ? new Date(meta.updatedAt).toISOString() : null,
    rulesUpdatedBy: meta?.updatedBy ?? null,
    stations: await stationsWithCount(db),
    items: items.map(({ prices, ...r }) => ({ ...r, price: defaultPrice(prices) })),
  };
}

const RulesInput = z.object({
  enabled: z.boolean(),
  trackServed: z.boolean(),
  warnMinutes: z.number('分钟数必须是整数').int('分钟数必须是整数').min(1, '至少 1 分钟').max(180, '最多 180 分钟'),
});
const StationInput = z.object({
  name: z.string().trim().min(1, '请填写档口名称').max(MAX_STATION_NAME, `档口名称最多 ${MAX_STATION_NAME} 字`),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  active: z.boolean().default(true),
});
const ItemsInput = z.object({
  items: z
    .array(z.object({ id: z.number().int().positive(), stationId: z.number().int().positive().nullable() }))
    .min(1, '没有要调整的菜品')
    .max(500),
});

export function registerDiningRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  // 后台「餐饮」：规则（只有店主）、出品档口与菜品的档口（能管理价目的岗位）
  app.get('/api/admin/dining', { preHandler: guardAny('settings.manage', 'catalog.manage') }, async () => diningAdmin(sql));

  app.put('/api/admin/dining/rules', { preHandler: guard('settings.manage') }, async (req) => {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('settings'))`;
      const before = await loadDiningRules(tx);
      const after = parse(RulesInput, { ...before, ...parse(RulesInput.partial(), req.body) });
      await tx`
        INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('dining_rules', ${tx.json(after as never)}, now(), ${req.actor.id})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'settings_updated', targetType: 'settings', detail: { key: 'dining_rules', before, after }, ip: req.ip });
    });
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

  // 菜品的出品档口：只提交要改的菜品（按项目 id 升序加锁）
  app.put('/api/admin/dining/items', { preHandler: guard('catalog.manage') }, async (req) => {
    const { items } = parse(ItemsInput, req.body);
    const ids = [...new Set(items.map((i) => i.id))];
    if (ids.length !== items.length) throw unprocessable('DUPLICATE_ITEM', '同一道菜提交了两次');
    await sql.begin(async (tx) => {
      const rows = await tx<{ id: number; name: string; stationId: number | null; technicianRequired: boolean }[]>`
        SELECT id, name, station_id, technician_required FROM service_items WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
      if (rows.length !== ids.length) throw notFound('有菜品不存在，请刷新后重试');
      const tech = rows.find((r) => r.technicianRequired && items.some((i) => i.id === r.id && i.stationId !== null));
      if (tech) throw unprocessable('ITEM_NEEDS_TECHNICIAN', `「${tech.name}」需要技师，不进厨房；要进厨房请先在「技师」里取消「需要技师」`);
      const stationIds = [...new Set(items.flatMap((i) => (i.stationId === null ? [] : [i.stationId])))];
      const stations = stationIds.length ? await tx<{ id: number; name: string }[]>`SELECT id, name FROM kitchen_stations WHERE id IN ${tx(stationIds)}` : [];
      if (stations.length !== stationIds.length) throw notFound('有档口不存在，请刷新后重试');
      const want = new Map(items.map((i) => [i.id, i.stationId]));
      const changed = rows.filter((r) => r.stationId !== want.get(r.id));
      for (const r of changed) await tx`UPDATE service_items SET station_id = ${want.get(r.id)!}, updated_at = now() WHERE id = ${r.id}`;
      if (changed.length) {
        const name = (sid: number | null) => (sid === null ? '不进厨房' : stations.find((s) => s.id === sid)!.name);
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'items_station_updated',
          targetType: 'item',
          detail: { summary: changed.map((r) => `${r.name} → ${name(want.get(r.id)!)}`).join('；').slice(0, 500) },
          ip: req.ip,
        });
      }
    });
    return diningAdmin(sql);
  });

  // 点单页：菜单与估清、按手牌找客人、下单（挂账）、催单
  app.get('/api/dining/menu', { preHandler: guardAny('dining.order', 'dining.kitchen') }, async () => diningMenu(sql, deps));

  app.get('/api/dining/guest', { preHandler: guard('dining.order') }, async (req) => {
    const { tag } = parse(z.object({ tag: z.string().trim().min(1, '请输入手牌号').max(16) }), req.query ?? {});
    return diningGuest(sql, tag);
  });

  // 下单就是挂账：与钟房派钟一样还要「前台挂账」权限（断网后的「结果待确认」按前台的操作编号查回、作废）
  app.post('/api/dining/orders', { preHandler: guard('dining.order', 'frontdesk.operate') }, async (req) => {
    const body = parse(z.object({ visitId: z.number('请先选客人').int().positive('请先选客人') }).passthrough(), req.body);
    const { postCharges } = await import('./frontdesk/bills');
    // 点单页只能点进厨房的菜（其他项目、手动金额请到前台登记）
    await postCharges(deps, body.visitId, { ...(req.body as object), customLines: [] } as never, ctxOf(req), { dining: { onlyKitchen: true } });
    return diningGuestOf(sql, body.visitId);
  });

  app.post('/api/dining/items/:id/rush', { preHandler: guard('dining.order') }, async (req) => {
    await rushDish(deps, parse(idParam, req.params).id, ctxOf(req));
    return { ok: true };
  });

  // 厨房屏：出品状态、估清
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
