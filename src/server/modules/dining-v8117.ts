// 8.1.17 餐饮按出品口（docs/FRONTDESK_V8117.md 第 2、3 节）：
//   · BW-4 退菜按出品口：餐饮的菜退菜（手牌、桌台两个退菜接口，与退菜的当场授权申请）要这道菜所在出品口的「退菜」权限，
//     出品口与下单核对同一个判断（diningSlotOf：按菜现在的点单分类，后台没设的按默认归）；别的明细照旧要「前台挂账」。
//     核对放在逐行的那一步（authorizeLineVoid 开头），之后原因、时限、授权的规矩照旧；
//   · BW-3 发卡台「加项目」：进厨房的菜按出品口的下单权限逐行核对，用点单页的同一个函数 assertOrderOutlets（在挂账的事务里，见 frontdesk/bills.ts）。
// 都只读、不加锁：权限与菜的分类只读；退菜照旧的锁（来访 / 桌台 → 账单 → 明细 → 出品单 → 沽清）。

import { DINING_OUTLET_LABELS, diningSlotOf, type DiningOutlet } from '@shared/dining';
import { OUTLET_VOID_PERMISSIONS, VOID_PERMISSIONS } from '@shared/frontdesk-v8117';
import { can } from '@shared/permissions';
import type { Db } from '../db';
import type { Actor } from '../lib/context';
import { AppError, forbidden } from '../lib/errors';

/** 一条餐饮明细是哪个出品口的菜（与下单核对同一个判断）；不是餐饮的明细为 null */
export async function lineOutletOf(db: Db, lineId: number): Promise<DiningOutlet | null> {
  const [r] = await db<{ source: string; category: string | null; diningOutlet: string | null; diningGroup: string | null; stationName: string | null }[]>`
    SELECT l.source, si.category, si.dining_outlet, si.dining_group, ks.name AS station_name
    FROM bill_lines l LEFT JOIN service_items si ON si.id = l.item_id LEFT JOIN kitchen_stations ks ON ks.id = si.station_id
    WHERE l.id = ${lineId}`;
  if (!r || r.source !== 'dining') return null;
  return diningSlotOf({ outlet: r.diningOutlet, group: r.diningGroup, category: r.category, stationName: r.stationName }).outlet;
}

/** 退明细的接口谁进得来：有「前台挂账」的，或有任一项「退菜：某出品口」的（康美部）；进来以后逐行核对 */
export const canEnterLineVoid = (actor: Actor) => can(actor, 'frontdesk.operate') || VOID_PERMISSIONS.some((p) => can(actor, p));

/**
 * 退这一条明细的权限（BW-4）：餐饮的菜要它所在出品口的「退菜」权限；别的明细照旧要「前台挂账」。
 * 调用前已锁好来访 / 桌台、账单与这条明细（只读地查这道菜的分类，不另加锁）
 */
export async function assertLineVoidPermission(db: Db, actor: Actor, line: { id: number; source: string; name: string }): Promise<void> {
  if (line.source !== 'dining') {
    if (!can(actor, 'frontdesk.operate')) throw forbidden(`「${line.name}」不是餐饮的菜，作废要「前台挂账」权限，请找前台同事`);
    return;
  }
  const outlet = (await lineOutletOf(db, line.id)) ?? 'restaurant';
  if (!can(actor, OUTLET_VOID_PERMISSIONS[outlet])) {
    throw new AppError(403, 'OUTLET_VOID_FORBIDDEN', `你的岗位不能退${DINING_OUTLET_LABELS[outlet]}的菜（「${line.name}」），请有权限的同事退`, { outlet });
  }
}
