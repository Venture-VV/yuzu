import { useMemo, useSyncExternalStore } from 'react';
import type { MpBannerAbandonResult, MpBannerAdmin, MpBannerOpLookup, MpBindingRow } from '@shared/mp';
import { api, ApiError, UncertainError } from '../../lib/api';

// 后台「微信小程序」写操作的「结果待确认」（小程序线；Codex 审查 PR #42 的 P1）：新建首页轮播、解绑会员的微信。
// 与 ERP 单据的做法一样（src/client/lib/erpPending.ts）：
//   · 提交前把操作编号和原请求存在本机并读回核对，存不了就不发请求；
//   · 成功、或第一次提交就被明确拒绝（4xx）才删；超时、断网、服务器出错（5xx）保留，关掉弹窗、刷新后页面上照样能处理：
//     新建轮播按编号查回，查不到的「按原内容重新提交」（同一编号，不会多建）或「确认作废」（之后原请求晚到也不会新建）；
//     解绑看那条绑定是不是已经解绑，没有就「按原内容重新提交」（同一编号，只解绑一次；解绑只做一次，晚到的原请求不会再动别的）；
//   · 曾经结果不明的编号，重提被明确拒绝时也保留：之前那次请求可能随后生效，要先查回或作废再下结论。
// 作废用小程序线自己的登记（迁移 044），不进共用的 op_fences，所以不用 ERP 的面板。

export type MpOpType = 'banner_create' | 'unbind';

export interface MpPendingOp {
  /** 操作编号（就是请求里的 clientKey） */
  key: string;
  type: MpOpType;
  /** 提交地址与原请求（重新提交时原样发送） */
  url: string;
  body: Record<string, unknown>;
  /** 展示用：轮播的标题、解绑的是谁的哪个微信 */
  summary: string;
  staffName: string;
  createdAt: string;
  uncertain?: boolean;
  /** 解绑：哪位会员的哪条绑定 */
  memberId?: number;
  bindingId?: number;
}

const STORAGE_KEY = 'yuzu.mpPending.v1';
const listeners = new Set<() => void>();
/** 本页正在提交中的编号：请求还没返回时不算「待确认」 */
const inFlight = new Set<string>();
let cachedRaw: string | null | undefined;
let cachedList: MpPendingOp[] = [];
let snapshotCache: { source: MpPendingOp[]; result: MpPendingOp[] } | null = null;

/** 待确认记录存不到本机：为防止断网后多建，这笔不能提交 */
export class MpPendingStoreError extends Error {
  readonly code = 'PENDING_STORE_FAILED';
  constructor() {
    super('本机浏览器无法保存「结果待确认」记录（存储空间已满或被禁用），为防止断网后重复办理，这次没有提交。请清理浏览器数据或换一台电脑再办。');
  }
}

function readAll(): MpPendingOp[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as MpPendingOp[]) : [];
    // 早先（只有新建轮播时）的记录没有 type、url
    cachedList = (Array.isArray(parsed) ? parsed : []).map((p) => (p.type ? p : { ...p, type: 'banner_create' as const, url: '/api/admin/mp/banners' }));
  } catch {
    cachedList = [];
  }
  return cachedList;
}

/** 写入并读回核对：写入被拒绝或被静默丢弃时返回 false */
function persist(list: MpPendingOp[]): boolean {
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

function snapshot(): MpPendingOp[] {
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

/** 本机这一种待确认的操作（不含本页正在提交中的） */
export function useMpPending(type: MpOpType): MpPendingOp[] {
  const all = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => all.filter((p) => p.type === type), [all, type]);
}

/** 先存本机并读回核对（存不了就不发请求），再发请求 */
export async function sendMpOp<T>(op: Omit<MpPendingOp, 'createdAt' | 'uncertain'>): Promise<T> {
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
    const result = await api.post<T>(op.url, op.body, { timeoutMs: 20_000 });
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

/** 新建轮播 */
export const sendBannerCreate = (op: { key: string; body: Record<string, unknown>; summary: string; staffName: string }) =>
  sendMpOp<MpBannerAdmin & { replayed: boolean }>({ ...op, type: 'banner_create', url: '/api/admin/mp/banners' });

/** 解绑会员的微信 */
export const sendUnbind = (op: { key: string; memberId: number; bindingId: number; reason: string; summary: string; staffName: string }) =>
  sendMpOp<MpBindingRow>({
    key: op.key,
    type: 'unbind',
    url: `/api/admin/mp/bindings/${op.bindingId}/unbind`,
    body: { clientKey: op.key, reason: op.reason },
    summary: op.summary,
    staffName: op.staffName,
    memberId: op.memberId,
    bindingId: op.bindingId,
  });

/** 新建轮播按编号查回（只读）：查不到不能断定没新建 */
export const lookupBannerOp = (op: MpPendingOp) => api.get<MpBannerOpLookup>(`/api/admin/mp/banners/ops/${op.key}`);

/** 在门店系统确认作废新建轮播：之后原请求即使到达也不会新建；已经建了返回那一条 */
export const abandonBannerOp = (op: MpPendingOp) => api.post<MpBannerAbandonResult>('/api/admin/mp/banners/abandon', { clientKey: op.key });

/** 解绑查回（只读）：那条绑定已经解绑了就有结论（解绑只做一次，晚到的原请求不会再动它） */
export async function lookupUnbindOp(op: MpPendingOp): Promise<{ done: boolean }> {
  const rows = await api.get<MpBindingRow[]>(`/api/admin/mp/members/${op.memberId}/bindings`);
  const row = rows.find((r) => r.id === op.bindingId);
  return { done: !!row && !!row.unboundAt };
}
