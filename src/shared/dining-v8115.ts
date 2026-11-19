// 8.1.15《浴族系统需求汇总》块 B · 餐饮（docs/DINING_V8115.md）：
//   · B1 桌台动作：桌台多一个状态（可用 / 待清台 / 维修中），并台、拆台、清台、维修、恢复记进 table_events，桌台历史把它与开台、换台、撤台、结账排在一起；
//   · B2 台账合并退菜：台账按类型筛（全部 / 正常 / 退菜 / 赠送 / 折扣），退菜的行带原因、审批与责任岗位，汇总有退菜率；
//   · B3 出品口下单权限与房号：在餐厅 / 水吧 / 果吧下单各一项权限，点单时手牌号、房号至少填一项，整单备注写进这一单每道菜的出品单。

import type { DiningOutlet } from './dining';
import type { Permission } from './permissions';

// ───────────── B1 桌台状态与动作 ─────────────

/** 桌台的状态：可用、待清台（结账以后，点「清台」回到可用）、维修中（要原因与预计恢复时间）。用餐中看有没有开着的开台 */
export const TABLE_STATES = ['available', 'dirty', 'maintenance'] as const;
export type TableState = (typeof TABLE_STATES)[number];
export const TABLE_STATE_LABELS: Record<TableState, string> = { available: '可用', dirty: '待清台', maintenance: '维修中' };

/** 维修的原因最多几个字；预计恢复时间最远几天以后 */
export const MAX_TABLE_ACTION_REASON = 100;
export const MAX_MAINTENANCE_DAYS = 90;

/** table_events 的种类（只追加） */
export type TableEventKind = 'merge' | 'split' | 'clear' | 'maintenance' | 'restore';

/** 桌台历史里的一条：table_events 与开台、换台（转入 / 转出）、撤台、结账、反结账 */
export type TableHistoryKind = TableEventKind | 'open' | 'move_in' | 'move_out' | 'cancel' | 'checkout' | 'checkout_void';

export const TABLE_HISTORY_LABELS: Record<TableHistoryKind, string> = {
  open: '开台',
  move_in: '换台转入',
  move_out: '换台转出',
  cancel: '撤台',
  checkout: '结账',
  checkout_void: '反结账',
  merge: '并台',
  split: '拆台',
  clear: '清台',
  maintenance: '维修',
  restore: '恢复',
};

export interface TableHistoryEntry {
  kind: TableHistoryKind;
  at: string;
  operatorName: string;
  /** 说明：人数与客人、换到哪桌、并入哪桌、维修原因与预计恢复时间、结账单号 */
  text: string;
  /** 这一条关于哪一次开台（清台、维修、恢复没有） */
  sessionNo: string | null;
}

export interface TableHistory {
  tableId: number;
  tableName: string;
  entries: TableHistoryEntry[];
  /** 只列最近这么多条；更早的还有时 truncated 为真 */
  limit: number;
  truncated: boolean;
}

/** 桌台历史一次最多列几条 */
export const TABLE_HISTORY_LIMIT = 200;

/** 桌台动作（清台、维修、恢复、并台、拆台）的回复：第一次记下的那条（同一编号重提返回同一条） */
export interface TableActionResult {
  eventId: number;
  tableId: number;
  kind: TableEventKind;
  at: string;
  replayed: boolean;
}

// ───────────── B2 台账类型、退菜的责任岗位 ─────────────

/** 台账的类型：正常、退菜（作废的明细）、赠送（被签赠券抵掉的行）、折扣（被券或会员折扣抵到的行） */
export const LEDGER_KINDS = ['normal', 'voided', 'gift', 'discount'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export const LEDGER_KIND_LABELS: Record<LedgerKind, string> = { normal: '正常', voided: '退菜', gift: '赠送', discount: '折扣' };

/** 退菜的责任岗位（退菜时选，记在审计里，不改明细表） */
export const VOID_BLAMES = ['waiter', 'kitchen', 'water', 'fruit', 'guest', 'other'] as const;
export type VoidBlame = (typeof VOID_BLAMES)[number];
export const VOID_BLAME_LABELS: Record<VoidBlame, string> = { waiter: '服务员', kitchen: '厨房', water: '水吧', fruit: '果吧', guest: '客人原因', other: '其他' };
export const isVoidBlame = (v: unknown): v is VoidBlame => typeof v === 'string' && (VOID_BLAMES as readonly string[]).includes(v);

/** 退菜率：退菜份数 ÷ 全部份数，另写金额占比（按日期、分类筛完、类型筛之前的那一批算） */
export interface LedgerVoidRate {
  quantity: number;
  amount: number;
  voidedQuantity: number;
  voidedAmount: number;
}

/** 百分比，一位小数（全部是 0 时写「—」） */
export const percentText = (part: number, whole: number) => (whole > 0 ? `${(Math.round((part / whole) * 1000) / 10).toFixed(1)}%` : '—');

// ───────────── B3 按出品口下单、房号、整单备注 ─────────────

/** 在某个出品口下单的权限 */
export const OUTLET_ORDER_PERMISSIONS: Record<DiningOutlet, Permission> = {
  restaurant: 'dining.orderRestaurant',
  water: 'dining.orderWater',
  fruit: 'dining.orderFruit',
};

/** 整单备注最多几个字（写进这一单每道菜的出品单） */
export const MAX_ORDER_NOTE = 60;
/** 送达房号最多几个字 */
export const MAX_DELIVER_ROOM = 10;

/** 桌台看板上一张桌的状态（8.1.15 块 B1）；维修时带原因与预计恢复时间 */
export interface TableStateInfo {
  state: TableState;
  maintenanceReason: string | null;
  maintenanceUntil: string | null;
  /** 现在这个状态从什么时候开始（升级前的桌为空） */
  stateSince: string | null;
}
