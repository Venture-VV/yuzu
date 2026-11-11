// 平板点餐页存在这台平板上的东西（浏览器 localStorage）：
//   · 这一次点餐（手牌、桌号、人数、没下单的菜、备注）：页面被系统刷新了还在；没人动超过设置的分钟数就不要了；
//   · 「结果待确认」的下单：提交前先记下操作编号与原请求（不含点单密码）并读回核对，保存不了就不发请求；
//     只有确认了结果（成功、门店系统明确拒绝、确认作废）才删。与前台的待确认记录同一套做法（frontdesk/pending.tsx），
//     只是重提、作废都要再输点单密码，所以密码不存在平板上；
//   · 这台平板上一次下单用的桌号（平板一般固定在一张桌上，下次预先填好）。

import { useSyncExternalStore } from 'react';
import type { EmenuOrderBody } from '@shared/emenu';

export interface CartLine {
  itemId: number;
  dishId: number;
  quantity: number;
}

export interface Remark {
  avoid: string[];
  serve: string | null;
  custom: string;
}

export const EMPTY_REMARK: Remark = { avoid: [], serve: null, custom: '' };

export interface TableSession {
  visitId: number;
  tagCode: string;
  tableName: string;
  guests: number;
}

interface SavedState {
  session: TableSession;
  cart: CartLine[];
  remark: Remark;
  touchedAt: number;
}

const STATE_KEY = 'yuzu.emenu.state.v1';
const TABLE_KEY = 'yuzu.emenu.table.v1';
const PENDING_KEY = 'yuzu.emenu.pending.v1';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  const raw = value === null ? null : JSON.stringify(value);
  try {
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
    return localStorage.getItem(key) === raw;
  } catch {
    return false;
  }
}

/** 这一次点餐：maxIdleMs 之内动过的才要（0 为不限）；格式不对的当没有 */
export function loadState(maxIdleMs: number): SavedState | null {
  const s = read<SavedState>(STATE_KEY);
  if (!s || typeof s.session?.visitId !== 'number' || typeof s.session.tagCode !== 'string' || !Array.isArray(s.cart)) return null;
  if (maxIdleMs > 0 && Date.now() - (s.touchedAt ?? 0) > maxIdleMs) return null;
  return { session: s.session, cart: s.cart.filter((l) => l && l.quantity > 0), remark: { ...EMPTY_REMARK, ...(s.remark ?? {}) }, touchedAt: s.touchedAt };
}

export function saveState(state: Omit<SavedState, 'touchedAt'> | null) {
  write(STATE_KEY, state ? { ...state, touchedAt: Date.now() } : null);
}

export const lastTable = () => read<string>(TABLE_KEY) ?? '';
export const rememberTable = (name: string) => void write(TABLE_KEY, name);

// ───────────────────────── 结果待确认 ─────────────────────────

export interface PendingOrder {
  key: string;
  /** 原请求（不含点单密码）：重新提交时原样再发 */
  body: EmenuOrderBody;
  /** 展示用：几份、多少钱 */
  quantity: number;
  createdAt: string;
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: PendingOrder | null = null;
/** 已有结论、但本机删不掉记录的编号：本页先当它没有 */
const settled = new Set<string>();

function current(): PendingOrder | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(PENDING_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const p = raw ? (JSON.parse(raw) as PendingOrder) : null;
    cached = p && typeof p.key === 'string' && p.body && !settled.has(p.key) ? p : null;
  } catch {
    cached = null;
  }
  return cached;
}

function notify() {
  cachedRaw = undefined;
  listeners.forEach((fn) => fn());
}

/** 提交前保存；保存不了返回 false，调用方不得发出请求 */
export function savePending(p: PendingOrder): boolean {
  if (current()?.key === p.key) return true; // 原样重提：记录已在本机
  if (!write(PENDING_KEY, p)) return false;
  notify();
  return true;
}

export function removePending(key: string) {
  if (current()?.key !== key) return;
  if (!write(PENDING_KEY, null)) settled.add(key);
  notify();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PENDING_KEY) {
      cachedRaw = undefined;
      fn();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** 这台平板上结果待确认的那一单（没有为 null）。没处理完之前这台平板不能再下新的一单 */
export function usePendingOrder(): PendingOrder | null {
  return useSyncExternalStore(subscribe, current, () => null);
}

export const PENDING_STORE_FAILED = '这台平板存不了「结果待确认」的记录（存储空间满了或被禁用），为了不重复下单，这一单没有提交。请换一台平板，或请服务员在点单页下单。';
