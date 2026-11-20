// 8.1.17《浴族系统需求汇总》8.1.15 没做完的部分（docs/FRONTDESK_V8117.md）：前后端共用的常量与小函数。
//   · BW-4 退菜按出品口：退菜：餐厅 / 水吧 / 果吧三项权限；
//   · BW-1 超时加收按小时预填、超时提醒；
//   · BW-2 桌台提醒：维修过了预计恢复时间、待清台太久；
//   · BW-11 本店价改价留痕。
// 金额为分。

import { DINING_OUTLET_KEYS, DINING_OUTLET_LABELS, type DiningOutlet } from './dining';
import type { Permission } from './permissions';

// ───────────── BW-4 退菜按出品口 ─────────────

/** 退某个出品口的菜的权限（与下单的 OUTLET_ORDER_PERMISSIONS 一一对应） */
export const OUTLET_VOID_PERMISSIONS: Record<DiningOutlet, Permission> = {
  restaurant: 'dining.voidRestaurant',
  water: 'dining.voidWater',
  fruit: 'dining.voidFruit',
};
export const VOID_PERMISSIONS: readonly Permission[] = DINING_OUTLET_KEYS.map((o) => OUTLET_VOID_PERMISSIONS[o]);

/** 这个岗位能退哪几个出品口的菜 */
export const voidOutletsOf = (can: (p: Permission) => boolean): DiningOutlet[] => DINING_OUTLET_KEYS.filter((o) => can(OUTLET_VOID_PERMISSIONS[o]));

/** 不能退这道菜时的一句话（不知道在哪个出品口的当作能退：页面上不拦，服务端核对） */
export function voidBlockedText(outlet: DiningOutlet | null | undefined, allowed: readonly DiningOutlet[]): string | null {
  return outlet && !allowed.includes(outlet) ? `不能退${DINING_OUTLET_LABELS[outlet]}的菜` : null;
}
