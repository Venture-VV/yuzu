import { useSyncExternalStore } from 'react';

// 「结果待确认」的记账操作，保存在本机浏览器里。
//
// 提交前先记下操作编号和原请求；只有确认了结果（成功、服务端明确拒绝、员工明确放弃）才删除。
// 这样即使关闭面板、切换会员、刷新页面或重新登录，也能用原编号查回结果或原样重提，
// 不会因为换了新编号而重复入账。

export type PendingType = 'recharge' | 'consume' | 'reversal';

export interface PendingOp {
  /** 操作编号（幂等键） */
  key: string;
  type: PendingType;
  /** 提交地址与原请求，重新提交时原样发送 */
  url: string;
  body: unknown;
  memberId: number;
  memberName: string;
  /** 撤销操作对应的消费单 */
  consumptionId?: number;
  /** 主要金额（分）：充值实收 / 消费应扣 / 撤销恢复 */
  amount: number;
  /** 如「常泡 500 · 微信」 */
  summary: string;
  staffName: string;
  createdAt: string;
}

const STORAGE_KEY = 'yuzu.pendingOps.v1';
const listeners = new Set<() => void>();
/** 本页正在提交中的编号：请求还没返回时不算「待确认」 */
const inFlight = new Set<string>();
/** 正由屏幕上打开的流程处理的编号：顶部提醒不重复显示、不抢先查询 */
const claimed = new Set<string>();
let memoryFallback: PendingOp[] = [];
let cachedRaw: string | null = null;
let cachedList: PendingOp[] = [];

function readAll(): PendingOp[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryFallback;
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as PendingOp[]) : [];
    cachedList = Array.isArray(parsed) ? parsed : [];
  } catch {
    cachedList = [];
  }
  return cachedList;
}

function writeAll(list: PendingOp[]) {
  memoryFallback = list;
  try {
    if (list.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 隐私模式等不可写时，退回内存保存（至少在关闭面板后仍可处理） */
  }
  listeners.forEach((fn) => fn());
}

export function savePending(op: PendingOp) {
  writeAll([...readAll().filter((p) => p.key !== op.key), op]);
}

export function removePending(key: string) {
  if (readAll().some((p) => p.key === key)) writeAll(readAll().filter((p) => p.key !== key));
}

export function setInFlight(key: string, active: boolean) {
  if (active) inFlight.add(key);
  else inFlight.delete(key);
  snapshotCache = null;
  listeners.forEach((fn) => fn());
}

export function setClaimed(key: string, active: boolean) {
  if (active) claimed.add(key);
  else claimed.delete(key);
  snapshotCache = null;
  listeners.forEach((fn) => fn());
}

/** 某位会员某类操作的待确认记录（撤销还要对上消费单） */
export function findPending(memberId: number, type: PendingType, consumptionId?: number): PendingOp | undefined {
  return readAll().find(
    (p) => p.memberId === memberId && p.type === type && (type !== 'reversal' || p.consumptionId === consumptionId) && !inFlight.has(p.key),
  );
}

let snapshotCache: { source: PendingOp[]; result: PendingOp[] } | null = null;
function snapshot(): PendingOp[] {
  const all = readAll();
  if (snapshotCache && snapshotCache.source === all) return snapshotCache.result;
  snapshotCache = { source: all, result: all.filter((p) => !inFlight.has(p.key) && !claimed.has(p.key)) };
  return snapshotCache.result;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      snapshotCache = null;
      fn();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** 当前所有待确认操作（不含本页正在提交中、或正在打开的流程里处理的） */
export function usePendingOps(): PendingOp[] {
  return useSyncExternalStore(subscribe, snapshot);
}

export const PENDING_LABELS: Record<PendingType, string> = { recharge: '充值', consume: '消费', reversal: '撤销' };
