// 菜品维护的「结果待确认」（8.1.16，Codex 审查 d12390f 的 P1；docs/DISHES_V8115.md 第 9 节，默认做法 CP10），保存在本机浏览器里。
//
// 新增、编辑、上下架、改价、导入都照 AGENTS.md 的规矩：提交前先把操作编号与原请求存进本机并读回核对，存不了就不发；
// 成功、第一次就被服务端明确拒绝的删掉记录；超时、断网、服务器出错（可能已经生效）的留着——
// 这道菜（新增、导入：这一类）上同类的操作先不能再做，只能：
//   · 查回：按编号只读查服务端，查不到只说明此刻还没有结果，不能断定没生效；
//   · 按原内容重新提交：同一个编号、同一份请求，服务端只办一次；被明确拒绝时先在服务端作废这个编号再下结论；
//   · 确认作废：服务端登记作废以后，原请求即使晚到也整笔不做，这时才能重新操作。
// 关掉弹窗、刷新、重新登录以后，菜品表上方照样列着，网络恢复时自动查回一次。

import { useSyncExternalStore } from 'react';
import type { DishOpLookup, DishOpType, DishRow } from '@shared/dishes';
import { api, errorMessage, isRejected, notSentAsRejection } from '../../lib/api';

export interface DishPendingOp {
  /** 操作编号（请求里的 clientKey） */
  key: string;
  type: DishOpType;
  /** 哪道菜；新增、导入为空 */
  itemId: number | null;
  method: 'post' | 'put';
  url: string;
  /** 原请求：重新提交时原样再发 */
  body: unknown;
  /** 给人看的：「宫保鸡丁 下架」「导入 菜品.xlsx」 */
  summary: string;
  staffName: string;
  createdAt: string;
}

const STORE_KEY = 'yuzu.dishPending.v1';
const watchers = new Set<() => void>();
/** 本页刚发出、还没回来的：不算待确认（表上不列，按钮转圈） */
const sending = new Set<string>();
/** 已经有结论、但本机的记录删不掉的：这一页里当它没有 */
const gone = new Set<string>();
let snap: { raw: string | null; list: DishPendingOp[] } | null = null;

function rawNow(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null; // 存储用不了：写也写不进，提交前就拦下了，不会有记录
  }
}

/** 本机全部的记录（含正在发的） */
function stored(): DishPendingOp[] {
  let list: DishPendingOp[] = [];
  try {
    const parsed: unknown = JSON.parse(rawNow() ?? '[]');
    if (Array.isArray(parsed)) list = parsed as DishPendingOp[];
  } catch {
    /* 坏了的当没有 */
  }
  return list.filter((op) => !gone.has(op.key));
}

/** 整份写回并读回核对：被拒绝（存储满了、被禁用）或悄悄没写进去都算失败 */
function store(list: DishPendingOp[]): boolean {
  const raw = list.length ? JSON.stringify(list) : null;
  try {
    if (raw === null) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, raw);
    return rawNow() === raw;
  } catch {
    return false;
  }
}

function emit() {
  snap = null;
  watchers.forEach((fn) => fn());
}

/** 有了结论：删掉本机的记录（删不掉就这一页里不再列） */
function settle(key: string) {
  if (!store(stored().filter((op) => op.key !== key))) gone.add(key);
  emit();
}

function shown(): DishPendingOp[] {
  const raw = rawNow();
  if (!snap || snap.raw !== raw) snap = { raw, list: stored().filter((op) => !sending.has(op.key)) };
  return snap.list;
}

function watch(fn: () => void) {
  watchers.add(fn);
  // 同一台电脑上另开的页签改了记录：跟着变
  const onStorage = (e: StorageEvent) => e.key === STORE_KEY && emit();
  window.addEventListener('storage', onStorage);
  return () => {
    watchers.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** 本机结果待确认的菜品维护（不含本页刚发出、还没回来的） */
export const useDishPending = (): DishPendingOp[] => useSyncExternalStore(watch, shown);

/** 这道菜（新增、导入不看菜）上同一类、结果待确认的那一笔 */
export const pendingOf = (list: readonly DishPendingOp[], type: DishOpType, itemId: number | null = null) => list.find((op) => op.type === type && op.itemId === itemId);

/** 记录存不进本机：一旦没收到结果就查不回原编号，所以这一笔不发 */
export class DishPendingStoreError extends Error {
  readonly code = 'PENDING_STORE_FAILED';
  constructor() {
    super('本机浏览器存不下「结果待确认」的记录（存储满了或被禁用），为了没收到结果时还能查回，这一笔没有提交。请清理浏览器数据，或换一台终端操作。');
  }
}

const call = <T>(op: DishPendingOp) => (op.method === 'put' ? api.put<T>(op.url, op.body) : api.post<T>(op.url, op.body, op.type === 'import' ? { timeoutMs: 60_000 } : undefined));

/**
 * 提交一笔菜品维护（第一次）：先存本机再发。成功、或被服务端明确拒绝（含「连不上、没发出去」）删掉记录、照常返回或抛出；
 * 结果不明（UncertainError）的记录留着，调用方提示「结果待确认」——这道菜上同类的操作在有结论之前不能再做。
 */
export async function sendDishOp<T>(op: Omit<DishPendingOp, 'createdAt'>): Promise<T> {
  const record: DishPendingOp = { ...op, createdAt: new Date().toISOString() };
  sending.add(record.key);
  try {
    if (!store([...stored(), record])) throw new DishPendingStoreError();
    emit();
    try {
      const result = await call<T>(record);
      settle(record.key);
      return result;
    } catch (raw) {
      const error = notSentAsRejection(raw);
      if (isRejected(error)) settle(record.key);
      throw error;
    }
  } finally {
    sending.delete(record.key);
    emit();
  }
}

/** 处理一笔待确认的结论：生效了（dish 是这道菜现在的样子）、确认没生效（作废了；reason 是重提被拒绝的原因）、还是不确定 */
export type DishOpOutcome = { kind: 'applied'; dish: DishRow | null } | { kind: 'abandoned'; reason?: string } | { kind: 'unknown'; message: string };

const NOT_YET = '还没查到已生效的结果：原请求可能还在路上或在排队。可以按原内容重新提交（同一个编号，不会办两次），或确认作废以后重新操作（作废以后原请求晚到也不生效）。';

function conclude(op: DishPendingOp, r: DishOpLookup): DishOpOutcome {
  if (r.found) {
    settle(op.key);
    return { kind: 'applied', dish: r.dish };
  }
  if (r.abandoned) {
    settle(op.key);
    return { kind: 'abandoned' };
  }
  return { kind: 'unknown', message: NOT_YET };
}

/** 查回（只读） */
export async function checkDishOp(op: DishPendingOp): Promise<DishOpOutcome> {
  try {
    return conclude(op, await api.get<DishOpLookup>(`/api/dining/dishes/ops/${op.key}?type=${op.type}`));
  } catch (e) {
    return { kind: 'unknown', message: `这次没查到：${errorMessage(e)}。原操作仍待确认。` };
  }
}

/** 确认作废：原操作已经办了的返回查回的结果；没办的登记作废，之后原请求再到也不办 */
export async function abandonDishOp(op: DishPendingOp): Promise<DishOpOutcome> {
  try {
    return conclude(op, await api.post<DishOpLookup>(`/api/dining/dishes/ops/${op.key}/abandon`, { type: op.type, itemId: op.itemId }));
  } catch (e) {
    return { kind: 'unknown', message: `作废没有完成：${errorMessage(e)}。原操作仍待确认。` };
  }
}

/** 按原内容重新提交（同一个编号）。被明确拒绝时不能断定之前那次不会生效：先作废这个编号，再下结论 */
export async function resendDishOp(op: DishPendingOp): Promise<DishOpOutcome> {
  try {
    const result = await call<{ dish?: DishRow }>(op);
    settle(op.key);
    return { kind: 'applied', dish: result.dish ?? null };
  } catch (e) {
    if (!isRejected(e)) return { kind: 'unknown', message: `${errorMessage(e)}，这一笔是否已生效仍不确定。` };
    if (e.code === 'OP_ABANDONED') {
      settle(op.key);
      return { kind: 'abandoned' };
    }
    const fenced = await abandonDishOp(op);
    if (fenced.kind === 'abandoned') return { kind: 'abandoned', reason: e.message };
    if (fenced.kind === 'applied') return fenced;
    return { kind: 'unknown', message: `按原内容重新提交被拒绝（${e.message}），但原请求会不会生效仍不确定。` };
  }
}
