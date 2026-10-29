import { useSyncExternalStore } from 'react';

// 「结果待确认」的记账操作，保存在本机浏览器里。
//
// 提交前先记下操作编号和原请求，并读回核对确实已保存；保存不了（存储已满或被禁用）就不发请求，
// 否则响应一旦丢失，关闭或刷新后就再也找不到原编号。只有确认了结果（成功、服务端明确拒绝、
// 服务端确认作废）才删除。这样即使关闭面板、切换会员、刷新页面或重新登录，也能用原编号查回结果
// 或原样重提，不会因为换了新编号而重复入账。

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
/** 已有结论、但本机删不掉记录的编号：本页先隐藏，下次进入页面自动查回后再删 */
const settled = new Set<string>();
let cachedRaw: string | null | undefined;
let cachedList: PendingOp[] = [];

/** 待确认记录无法可靠保存到本机：为防止断网后重复记账，这笔不能提交 */
export class PendingStoreError extends Error {
  readonly code = 'PENDING_STORE_FAILED';
  constructor() {
    super('本机浏览器无法保存「结果待确认」记录（存储空间已满或被禁用），为防止断网后重复记账，这笔没有提交。请联系店主清理浏览器数据，或换一台终端办理。');
  }
}

function readAll(): PendingOp[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null; // 存储不可用：写入同样会失败，提交前就会被拦下，这里不会有记录
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as PendingOp[]) : [];
    cachedList = (Array.isArray(parsed) ? parsed : []).filter((p) => !settled.has(p.key));
  } catch {
    cachedList = [];
  }
  return cachedList;
}

/** 写入并读回核对：写入被拒绝（例如存储已满）或被静默丢弃时返回 false */
function persist(list: PendingOp[]): boolean {
  const raw = list.length ? JSON.stringify(list) : null;
  try {
    if (raw === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, raw);
    return localStorage.getItem(STORAGE_KEY) === raw;
  } catch {
    return false;
  }
}

function notify() {
  cachedRaw = undefined;
  snapshotCache = null;
  listeners.forEach((fn) => fn());
}

/** 提交前保存待确认记录；保存不了时抛出 PendingStoreError，调用方不得发出请求 */
export function savePending(op: PendingOp) {
  const list = readAll();
  if (list.some((p) => p.key === op.key)) return; // 原样重提：记录已在本机
  if (!persist([...list, op])) throw new PendingStoreError();
  notify();
}

export function removePending(key: string) {
  const list = readAll();
  if (!list.some((p) => p.key === key)) return;
  if (!persist(list.filter((p) => p.key !== key))) settled.add(key);
  notify();
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
