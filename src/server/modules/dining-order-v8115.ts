// 8.1.15《浴族系统需求汇总》块 B3 · 按出品口下单、房号、整单备注（docs/DINING_V8115.md 第 4 节）：
//   · 下单权限按出品口分三项（在餐厅 / 水吧 / 果吧下单），服务端逐行核对（按菜现在的点单分类，后台没设的按默认归）；
//   · 点单时手牌号、房号至少填一项：只填房号的按 findGuestByRoom 找这间房现在的客人（这一版认在住的客房；房态中心合进来以后
//     在那个函数里接上服务房间登记的客人），下单时在挂账的事务里（锁住来访以后）再核对一次这间房还是这位客人；都填时账记在手牌上、房号写在送达位置；
//   · 整单备注写进这一单每道菜的出品单（厨房出品屏、点菜单）；退菜时选的责任岗位记在审计里。
// 都不另加锁：权限与菜的分类只读；挂账照旧（来访 → 账单 → 沽清 → 出品单）。

import { z } from 'zod';
import { DINING_OUTLET_LABELS, diningSlotOf, type DiningOutlet } from '@shared/dining';
import { MAX_DELIVER_ROOM, MAX_ORDER_NOTE, OUTLET_ORDER_PERMISSIONS, VOID_BLAMES } from '@shared/dining-v8115';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../db';
import type { Actor } from '../lib/context';
import { AppError, badRequest, conflict } from '../lib/errors';
import { currentStoreId } from '../lib/store-context';
import { parse } from '../lib/validate';

/** 整单备注（选填）：空的当没带，请求摘要与升级前一样 */
export const OrderNoteField = z
  .string()
  .trim()
  .max(MAX_ORDER_NOTE, `整单备注最多 ${MAX_ORDER_NOTE} 字`)
  .nullish()
  .transform((v) => v || undefined)
  .optional();

/** 送达房号（选填）：去空白、字母大写；空的当没带 */
export const DeliverRoomField = z
  .string()
  .trim()
  .max(MAX_DELIVER_ROOM, `房号最多 ${MAX_DELIVER_ROOM} 个字`)
  .nullish()
  .transform((v) => (v ? v.toUpperCase() : undefined))
  .optional();

/** 退菜的责任岗位（选填：点单页、桌台退菜时选，前台作废别的明细不带） */
export const VoidBlameField = z.enum(VOID_BLAMES, '责任岗位不正确').optional();

/**
 * 只填房号时找客人：这间房现在的客人——这次来访（visitId）与他的手牌号（tagCode）；找不到为 null。只读、不加锁。
 * 这一版认在住的客房（客房的入住单在住、来访在店）。房态中心（块 D）合进来以后在这里接上「这间服务房现在登记的客人」：
 * 签名与返回值不变，调用方（点单页找客人、下单时在挂账的事务里再核对一次）只认 visitId 与 tagCode。
 */
export async function findGuestByRoom(tx: Db, room: string): Promise<{ visitId: number; tagCode: string } | null> {
  const [stay] = await tx<{ visitId: number; tagCode: string }[]>`
    SELECT s.visit_id, h.code AS tag_code
    FROM room_stays s JOIN rooms r ON r.id = s.room_id JOIN visits v ON v.id = s.visit_id JOIN hand_tags h ON h.id = v.tag_id
    WHERE s.status = 'open' AND v.status = 'open' AND r.store_id = ${currentStoreId()} AND upper(btrim(r.room_no)) = upper(btrim(${room}))
    ORDER BY s.id LIMIT 1`;
  return stay ? { visitId: stay.visitId, tagCode: stay.tagCode } : null;
}

/** 按手牌号找在店客人（只认手牌，不当房号找）；找不到为 null */
export async function findGuestByTag(db: Db, tag: string): Promise<number | null> {
  const [v] = await db<{ visitId: number }[]>`
    SELECT v.id AS visit_id FROM visits v JOIN hand_tags h ON h.id = v.tag_id
    WHERE v.status = 'open' AND h.store_id = ${currentStoreId()} AND upper(h.code) = upper(btrim(${tag}))`;
  return v?.visitId ?? null;
}

/**
 * 按出品口逐行核对下单权限：这几道菜在哪个出品口（按菜现在的点单分类），没有那个出品口「下单」权限的整单拒绝。
 * 不进厨房的项目不在这里核对（点单页只能点进厨房的菜，挂账时照旧拒绝）
 */
export async function assertOrderOutlets(db: Db, actor: Actor, itemIds: number[]) {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return;
  const rows = await db<{ name: string; category: string; diningOutlet: string | null; diningGroup: string; stationName: string }[]>`
    SELECT i.name, i.category, i.dining_outlet, i.dining_group, s.name AS station_name
    FROM service_items i JOIN kitchen_stations s ON s.id = i.station_id WHERE i.id IN ${db(ids)} ORDER BY i.id`;
  const denied: { name: string; outlet: DiningOutlet }[] = [];
  for (const r of rows) {
    const { outlet } = diningSlotOf({ outlet: r.diningOutlet, group: r.diningGroup, category: r.category, stationName: r.stationName });
    if (!can(actor, OUTLET_ORDER_PERMISSIONS[outlet])) denied.push({ name: r.name, outlet });
  }
  if (denied.length) {
    const outlets = [...new Set(denied.map((d) => DINING_OUTLET_LABELS[d.outlet]))].join('、');
    throw new AppError(403, 'OUTLET_FORBIDDEN', `你的岗位不能在${outlets}下单（${denied.map((d) => `「${d.name}」`).join('')}），请删掉或请有权限的同事点`, {
      items: denied.map((d) => d.name),
    });
  }
}

/** 这个操作编号已经有结果了（原样重提）：照原样返回第一次的结果，不再按此刻的权限核对 */
async function replayed(db: Db, key: unknown): Promise<boolean> {
  if (!z.uuid().safeParse(key).success) return false;
  const rows = await db`SELECT 1 FROM idempotency_keys WHERE key = ${key as string}`;
  return rows.length > 0;
}

const OrderBody = z
  .object({
    clientKey: z.unknown().optional(),
    visitId: z.number('请先选客人').int().positive('请先选客人'),
    lines: z.array(z.object({ itemId: z.unknown() }).passthrough()).optional(),
    deliverRoom: DeliverRoomField,
    /** 只填了房号：按房号找到的客人，挂账时再核对一次这间房还是他 */
    roomOnly: z.boolean().optional(),
    toRoom: z.boolean().optional(),
  })
  .passthrough();

/**
 * 点单页下单之前（不在事务里）：按出品口核对下单权限；只填房号的给出挂账事务里再核对一次的钩子（PostOptions.toRoom，
 * 出品单的「送到哪」写「房 W301」）。同一编号已有结果的照原样返回第一次的结果，不再核对
 */
export async function prepareDiningOrder(db: Db, actor: Actor, raw: unknown): Promise<{ toRoom?: (tx: Tx) => Promise<string> }> {
  const body = parse(OrderBody, raw);
  if (body.roomOnly && body.toRoom) throw badRequest('「送到客房」与「按房号点单」只能选一样，请刷新后重新下单');
  if (body.roomOnly && !body.deliverRoom) throw badRequest('按房号点单要填房号');
  if (!(await replayed(db, body.clientKey))) {
    const itemIds = (body.lines ?? []).flatMap((l) => (typeof l.itemId === 'number' && Number.isInteger(l.itemId) ? [l.itemId] : []));
    await assertOrderOutlets(db, actor, itemIds);
  }
  if (!body.roomOnly) return {};
  const room = body.deliverRoom!;
  return {
    toRoom: async (tx) => {
      const hit = await findGuestByRoom(tx, room);
      if (!hit || hit.visitId !== body.visitId) {
        throw conflict('ROOM_GUEST_CHANGED', `房号 ${room} 现在不是这位客人了（刚刚换房、退房或换了客人），请重新找客人`);
      }
      return `房 ${room}`;
    },
  };
}
