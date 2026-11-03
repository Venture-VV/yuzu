import { useMemo, useSyncExternalStore } from 'react';
import type { ErpOpLookup, ErpOpType } from '@shared/erp';
import { api, ApiError, UncertainError } from './api';

// ERP 单据「结果待确认」的登记（费用报销、备用金打款与退回补付、部门需求单，v0.7.8），保存在本机浏览器里。
//
// 与会员记账、前台一样（AGENTS.md）：提交前先记下操作编号和原请求并读回核对，保存不了就不发请求；
// 只有确认了结果（成功、第一次提交就被服务端明确拒绝、查回已登记或已作废）才删除。
// 关闭对话框、刷新或重新登录后仍能在页面上查回、按原内容重新提交（同一编号，不会重复登记），
// 或在服务端确认作废（原请求之后即使到达也不会登记）后再重新填写。

export interface ErpPendingOp {
  /** 操作编号（幂等键） */
  key: string;
  type: ErpOpType;
  /** 提交地址与原请求，重新提交时原样发送 */
  url: string;
  body: unknown;
  /** 展示用，如「采购部 · 办公 · ¥60.00」 */
  summary: string;
  staffName: string;
  createdAt: string;
  /** 曾经结果不明：之后的重提即使被明确拒绝，之前那次请求也可能随后登记，要先查回或作废 */
  uncertain?: boolean;
}

const STORAGE_KEY = 'yuzu.erpPending.v1';
const listeners = new Set<() => void>();
/** 本页正在提交中的编号：请求还没返回时不算「待确认」 */
const inFlight = new Set<string>();
/** 已有结论、但本机删不掉记录的编号：本页先隐藏 */
const settled = new Set<string>();
let cachedRaw: string | null | undefined;
let cachedList: ErpPendingOp[] = [];

/** 待确认记录无法可靠保存到本机：为防止断网后重复登记，这笔不能提交 */
export class ErpPendingStoreError extends Error {
  readonly code = 'PENDING_STORE_FAILED';
  constructor() {
    super('本机浏览器无法保存「结果待确认」记录（存储空间已满或被禁用），为防止断网后重复登记，这笔没有提交。请清理浏览器数据或换一台电脑登记。');
  }
}

function readAll(): ErpPendingOp[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as ErpPendingOp[]) : [];
    cachedList = (Array.isArray(parsed) ? parsed : []).filter((p) => !settled.has(p.key));
  } catch {
    cachedList = [];
  }
  return cachedList;
}

/** 写入并读回核对：写入被拒绝或被静默丢弃时返回 false */
function persist(list: ErpPendingOp[]): boolean {
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

/** 提交前保存；保存不了时抛出 ErpPendingStoreError，调用方不得发出请求 */
function savePending(op: ErpPendingOp) {
  const list = readAll();
  if (list.some((p) => p.key === op.key)) return; // 原样重提：记录已在本机
  if (!persist([...list, op])) throw new ErpPendingStoreError();
  notify();
}

function markUncertain(key: string) {
  const list = readAll();
  if (!list.some((p) => p.key === key && !p.uncertain)) return;
  persist(list.map((p) => (p.key === key ? { ...p, uncertain: true } : p)));
  notify();
}

export function removeErpPending(key: string) {
  const list = readAll();
  if (!list.some((p) => p.key === key)) return;
  if (!persist(list.filter((p) => p.key !== key))) settled.add(key);
  notify();
}

function setInFlight(key: string, active: boolean) {
  if (active) inFlight.add(key);
  else inFlight.delete(key);
  snapshotCache = null;
  listeners.forEach((fn) => fn());
}

let snapshotCache: { source: ErpPendingOp[]; result: ErpPendingOp[] } | null = null;
function snapshot(): ErpPendingOp[] {
  const all = readAll();
  if (snapshotCache && snapshotCache.source === all) return snapshotCache.result;
  snapshotCache = { source: all, result: all.filter((p) => !inFlight.has(p.key)) };
  return snapshotCache.result;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) notify();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** 本机这些类型的待确认登记（不含本页正在提交中的） */
export function useErpPending(types: readonly ErpOpType[]): ErpPendingOp[] {
  const all = useSyncExternalStore(subscribe, snapshot);
  const key = types.join(',');
  return useMemo(() => all.filter((p) => key.split(',').includes(p.type)), [all, key]);
}

/**
 * 提交一笔 ERP 登记：先存本机并读回核对（存不了就不发请求），再发请求。
 * 成功、或第一次提交就被明确拒绝（4xx）时删除记录；超时、断网、服务器出错（5xx，可能已经登记、只是读结果时出错）保留
 * （页面上可以查回、重提或作废，不另起一笔）；
 * 曾经结果不明的编号重提被明确拒绝时也保留：之前那次请求可能随后登记，要先查回或作废再下结论。
 */
export async function sendErpOp<T>(op: Omit<ErpPendingOp, 'createdAt' | 'uncertain'> & { createdAt?: string }): Promise<T> {
  const record: ErpPendingOp = { ...op, createdAt: op.createdAt ?? new Date().toISOString() };
  // 本机已经有这条记录（页面刷新、关闭前发出的那次可能还在路上，或之前结果不明）：这是重提，不是新的一笔
  const retry = readAll().some((p) => p.key === record.key);
  // 第一次提交先标成「提交中」再写入：请求还没返回时页面上不显示待确认、不去查回。
  // 重提（从「结果待确认」里按原内容重新提交）不隐藏：那一行留在页面上显示提交中，被拒绝时原因写在这一行里
  const hide = !retry;
  if (hide) setInFlight(record.key, true);
  try {
    savePending(record);
  } catch (e) {
    if (hide) setInFlight(record.key, false);
    throw e;
  }
  try {
    const result = await api.post<T>(record.url, record.body, { timeoutMs: 20_000 });
    removeErpPending(record.key);
    return result;
  } catch (e) {
    if (e instanceof UncertainError) markUncertain(record.key);
    // 只有第一次提交就被服务端明确拒绝才删：重提被拒绝时，之前那次请求可能随后登记，要先查回或作废（v0.7.9 修正）
    else if (retry) markUncertain(record.key);
    else if (e instanceof ApiError) removeErpPending(record.key);
    throw e;
  } finally {
    if (hide) setInFlight(record.key, false);
  }
}

/** 按编号查回（只读）：查不到不能断定没有登记 */
export const lookupErpOp = (op: ErpPendingOp) => api.get<ErpOpLookup>(`/api/erp/ops/${op.key}?type=${op.type}`);

/** 在服务端确认作废：之后原请求即使到达也不会登记；原请求已经登记时返回查回的结果 */
export const abandonErpOp = (op: ErpPendingOp) => api.post<ErpOpLookup>(`/api/erp/ops/${op.key}/abandon`, { type: op.type, summary: op.summary.slice(0, 200) });
