import { useSyncExternalStore } from 'react';
import type { MpBannerAbandonResult, MpBannerAdmin, MpBannerOpLookup } from '@shared/mp';
import { api, ApiError, UncertainError } from '../../lib/api';

// 后台「微信小程序」新建首页轮播的「结果待确认」（小程序线；Codex 审查 PR #42 的 P1）。与 ERP 单据的做法一样（src/client/lib/erpPending.ts）：
//   · 提交前把操作编号和原请求存在本机并读回核对，存不了就不发请求；
//   · 成功、或第一次提交就被明确拒绝（4xx）才删；超时、断网、服务器出错（5xx）保留，页面上按原编号查回，
//     查不到的由员工「按原内容重新提交」（同一编号，不会多建）或「确认作废」（门店系统登记作废，原请求晚到也不会新建）；
//   · 曾经结果不明的编号，重提被明确拒绝时也保留：之前那次请求可能随后新建，要先查回或作废再下结论。
// 作废用小程序线自己的登记（迁移 044），不进共用的 op_fences，所以不用 ERP 的面板。

export interface MpPendingBanner {
  /** 操作编号（就是新建请求里的 clientKey） */
  key: string;
  /** 原请求（重新提交时原样发送） */
  body: Record<string, unknown>;
  /** 展示用：轮播的标题 */
  summary: string;
  staffName: string;
  createdAt: string;
  uncertain?: boolean;
}

const STORAGE_KEY = 'yuzu.mpPending.v1';
const listeners = new Set<() => void>();
/** 本页正在提交中的编号：请求还没返回时不算「待确认」 */
const inFlight = new Set<string>();
let cachedRaw: string | null | undefined;
let cachedList: MpPendingBanner[] = [];
let snapshotCache: { source: MpPendingBanner[]; result: MpPendingBanner[] } | null = null;

/** 待确认记录存不到本机：为防止断网后多建，这笔不能提交 */
export class MpPendingStoreError extends Error {
  readonly code = 'PENDING_STORE_FAILED';
  constructor() {
    super('本机浏览器无法保存「结果待确认」记录（存储空间已满或被禁用），为防止断网后多建一张，这次没有提交。请清理浏览器数据或换一台电脑再建。');
  }
}

function readAll(): MpPendingBanner[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as MpPendingBanner[]) : [];
    cachedList = Array.isArray(parsed) ? parsed : [];
  } catch {
    cachedList = [];
  }
  return cachedList;
}

/** 写入并读回核对：写入被拒绝或被静默丢弃时返回 false */
function persist(list: MpPendingBanner[]): boolean {
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

export function removeMpPending(key: string) {
  const list = readAll();
  if (!list.some((p) => p.key === key)) return;
  persist(list.filter((p) => p.key !== key));
  notify();
}

function markUncertain(key: string) {
  const list = readAll();
  if (!list.some((p) => p.key === key && !p.uncertain)) return;
  persist(list.map((p) => (p.key === key ? { ...p, uncertain: true } : p)));
  notify();
}

function snapshot(): MpPendingBanner[] {
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

/** 本机待确认的新建轮播（不含本页正在提交中的） */
export function useMpPendingBanners(): MpPendingBanner[] {
  return useSyncExternalStore(subscribe, snapshot);
}

/** 新建轮播：先存本机并读回核对（存不了就不发请求），再发请求 */
export async function sendBannerCreate(op: Omit<MpPendingBanner, 'createdAt' | 'uncertain'>): Promise<MpBannerAdmin & { replayed: boolean }> {
  const list = readAll();
  const retry = list.some((p) => p.key === op.key);
  if (!retry) {
    inFlight.add(op.key);
    if (!persist([...list, { ...op, createdAt: new Date().toISOString() }])) {
      inFlight.delete(op.key);
      throw new MpPendingStoreError();
    }
    notify();
  }
  try {
    const result = await api.post<MpBannerAdmin & { replayed: boolean }>('/api/admin/mp/banners', op.body, { timeoutMs: 20_000 });
    removeMpPending(op.key);
    return result;
  } catch (e) {
    if (e instanceof UncertainError) markUncertain(op.key);
    // 只有第一次提交就被明确拒绝才删：重提被拒绝时，之前那次请求可能随后新建，要先查回或作废
    else if (retry) markUncertain(op.key);
    else if (e instanceof ApiError) removeMpPending(op.key);
    throw e;
  } finally {
    if (inFlight.delete(op.key)) notify();
  }
}

/** 按编号查回（只读）：查不到不能断定没新建 */
export const lookupBannerOp = (op: MpPendingBanner) => api.get<MpBannerOpLookup>(`/api/admin/mp/banners/ops/${op.key}`);

/** 在门店系统确认作废：之后原请求即使到达也不会新建；已经建了返回那一条 */
export const abandonBannerOp = (op: MpPendingBanner) => api.post<MpBannerAbandonResult>('/api/admin/mp/banners/abandon', { clientKey: op.key });
