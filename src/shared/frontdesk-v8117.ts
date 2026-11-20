// 8.1.17《浴族系统需求汇总》8.1.15 没做完的部分（docs/FRONTDESK_V8117.md）：前后端共用的常量与小函数。
//   · BW-4 退菜按出品口：退菜：餐厅 / 水吧 / 果吧三项权限；
//   · BW-1 超时加收按小时预填、超时提醒；
//   · BW-2 桌台提醒：维修过了预计恢复时间、待清台太久；
//   · BW-11 本店价改价留痕。
// 金额为分。

import { PRICE_TIER_LABELS, type PriceTier } from './catalog';
import { DINING_OUTLET_KEYS, DINING_OUTLET_LABELS, type DiningOutlet } from './dining';
import { formatYuan } from './money';
import { MAX_SURCHARGE_CENTS, OVERSTAY_TIERS } from './frontdesk-risk';
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

// ───────────── BW-1 超时加收与提醒 ─────────────

/** 超时从几小时算起：12 小时（超时在店的第一级） */
export const OVERTIME_FROM_HOURS = 12;
/** 「每超 1 小时加收」最多填多少（分）：¥1,000 */
export const MAX_OVERTIME_HOURLY_CENTS = 100_000;

/**
 * 点「加收」时先填好的金额（BW1）：在店超过 12 小时以后，不足 1 小时按 1 小时算（超 1 分钟算 1 小时）× 每小时的价；
 * 一笔最多 ¥10,000（与手填的上限一样）。没设价、还没超过 12 小时的返回 null（照旧手填）
 */
export function overtimeSurchargeOf(stayMinutes: number, hourlyCents: number): { hours: number; amount: number; capped: boolean } | null {
  const over = stayMinutes - OVERTIME_FROM_HOURS * 60;
  if (hourlyCents <= 0 || over <= 0) return null;
  const hours = Math.ceil(over / 60);
  const raw = hours * hourlyCents;
  return { hours, amount: Math.min(raw, MAX_SURCHARGE_CENTS), capped: raw > MAX_SURCHARGE_CENTS };
}

/** 超时提醒的三级（12 / 24 / 72 小时，与手牌板的超时分级同一份），从低到高 */
export const OVERTIME_REMINDER_HOURS: readonly number[] = [...OVERSTAY_TIERS].map((t) => t.hours).sort((a, b) => a - b);

/** 在店这么多分钟，到了哪一级提醒（没到 12 小时为 null）：只记最高的那一级，低的几级算被它盖过 */
export function overtimeReminderLevel(stayMinutes: number): number | null {
  const reached = OVERTIME_REMINDER_HOURS.filter((h) => stayMinutes >= h * 60);
  return reached.length ? reached[reached.length - 1]! : null;
}

/** 超时提醒的备注（经办记录、异常待办里那一句） */
export const overtimeReminderNote = (hours: number) => `在店超过 ${hours} 小时，请去看看客人、提醒结账或续时（系统记）`;

// ───────────── BW-2 桌台提醒 ─────────────

/** 「待清台多久算久了」最多填多少分钟 */
export const MAX_DIRTY_ALERT_MINUTES = 240;

/** 一张桌（没在用餐的）要不要提醒：维修过了预计恢复时间（overdue）、待清台太久（dirty_long），带过了几分钟；不用提醒为 null */
export type TableReminder = { kind: 'overdue' | 'dirty_long'; minutes: number };

export function tableReminderOf(
  t: { state: 'available' | 'dirty' | 'maintenance'; maintenanceUntil: string | null; stateSince: string | null },
  now: number,
  dirtyAlertMinutes: number,
): TableReminder | null {
  if (t.state === 'maintenance' && t.maintenanceUntil) {
    const over = now - new Date(t.maintenanceUntil).getTime();
    return over >= 0 ? { kind: 'overdue', minutes: Math.floor(over / 60_000) } : null;
  }
  // 待清台从结账那一刻（state_since）算；升级前就待清台、没有时刻的不提醒
  if (t.state === 'dirty' && t.stateSince) {
    const minutes = Math.floor((now - new Date(t.stateSince).getTime()) / 60_000);
    return minutes >= dirtyAlertMinutes ? { kind: 'dirty_long', minutes } : null;
  }
  return null;
}

/** 餐饮的待办数（桌台这一块）：没在用餐的桌里要提醒的几桌，分两样 */
export function tableTodos(
  tables: readonly { session: unknown; state: 'available' | 'dirty' | 'maintenance'; maintenanceUntil: string | null; stateSince: string | null }[],
  now: number,
  dirtyAlertMinutes: number,
): { overdue: number; dirtyLong: number; total: number } {
  let overdue = 0;
  let dirtyLong = 0;
  for (const t of tables) {
    if (t.session) continue;
    const r = tableReminderOf(t, now, dirtyAlertMinutes);
    if (r?.kind === 'overdue') overdue += 1;
    else if (r?.kind === 'dirty_long') dirtyLong += 1;
  }
  return { overdue, dirtyLong, total: overdue + dirtyLong };
}

// ───────────── BW-11 本店价改价留痕 ─────────────

/** 本店价改价的原因最多几个字（与菜品改价记录一样，2–100） */
export const MAX_STORE_PRICE_REASON = 100;

/** 本店价改价的一句话：「标准 同全公司（¥38.00）→ ¥35.00」「标准 ¥35.00 → 同全公司（¥38.00）」 */
export function storePriceChangeText(c: { tier: PriceTier; oldPrice: number | null; newPrice: number | null; basePrice: number | null }): string {
  const side = (p: number | null) => (p === null ? `同全公司${c.basePrice ? `（${formatYuan(c.basePrice)}）` : ''}` : formatYuan(p));
  return `${PRICE_TIER_LABELS[c.tier]} ${side(c.oldPrice)} → ${side(c.newPrice)}`;
}

/** 改价记录按门店筛：all 全部、hq 全公司的价目、数字是那家店的本店价 */
export type PriceChangeStoreFilter = 'all' | 'hq' | number;
