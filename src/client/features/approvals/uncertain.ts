// 审批「结果待确认」（v0.7.30，Codex 自动审查 c0acccf、abe2842）：同意、退回在发出之前，把哪张审批单、第几级、什么内容
// 存进本机浏览器并读回核对（存不了就不发），有明确结果（成功或拒绝）才删；超时、断网、服务器出错，关掉页面、刷新、
// 重新登录以后记录都还在（按账号分开），这张审批单只能「按原内容重新提交」——原样再发，不按刷新后的级别重新拼
// （同一个人能审连续几级时，按刷新后的级别会多同意一级）。批量同意的整批记下（勾的单、各自的级别、意见）。
//
// 原样再发是安全的：服务端按「审批单 + 级别」把关，级别只往前走——
//   · 上次那次已经生效：不重复记（同一个人对同一级重复同意、单据已经生效或已经退回的，都按成功返回）；
//   · 还没生效：照常同意或退回这一级；
//   · 这张单已经走过这一级（别人审的）或已经结束：拒绝（APPROVAL_MOVED 等），上次那次到得再晚也同样被拒。
// 所以重新提交拿到的明确结果（成功或拒绝）就是上次那次的结果，之后不会再变，记录就删掉；还是没收到结果就接着留着。
// 读回时审批单已经结束（通过、退回、撤回）也删掉：上次那次已经改变不了什么（生效了的在审批记录里）。

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ApprovalStatus, BatchApproveResult } from '@shared/approvals';
import { api, UncertainError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { uuid } from '../../lib/utils';

export interface SentApproval {
  /** 谁发的（同一台电脑换人登录，各看各的） */
  staffId: number;
  requestId: number;
  docNo: string;
  action: 'approve' | 'return';
  /** 发出去时的级别 */
  level: number;
  /** 发到哪里、发了什么：重新提交时原样再发 */
  url: string;
  body: Record<string, unknown>;
  /** 批量同意的同一批：重新提交时整批原样再发 */
  batch?: { id: string; comment: string };
  createdAt: string;
}

const STORAGE_KEY = 'yuzu.approvalPending.v1';
const listeners = new Set<() => void>();
/** 本页正在发的（请求还没返回时不算「结果待确认」） */
const inFlight = new Set<string>();
/** 已经有明确结果、但本机删不掉的：本页先不显示 */
const settled = new Set<string>();
let cachedRaw: string | null | undefined;
let cachedList: SentApproval[] = [];
let snap: { source: SentApproval[]; result: SentApproval[] } | null = null;

const keyOf = (s: { staffId: number; requestId: number }) => `${s.staffId}:${s.requestId}`;

/** 本机存不了「结果待确认」的记录：没收到结果时就不知道原来发的是第几级，这次不发 */
export class ApprovalStoreError extends Error {
  readonly code = 'PENDING_STORE_FAILED';
  constructor() {
    super('本机浏览器存不了「结果待确认」的记录（存储空间满了或被禁用），为防止没收到结果时多同意一级，这次没有发出。请清理浏览器数据或换一台电脑审批。');
  }
}

/** 这张单上次的同意或退回还没有明确结果：先按原内容重新提交，不另发一个 */
export class ApprovalPendingError extends Error {
  readonly code = 'APPROVAL_RESULT_PENDING';
  constructor(readonly sent: SentApproval) {
    super(`${sent.docNo} 上次的「${sentLabel(sent)}」还没收到结果，请先按原内容重新提交`);
  }
}

/** 「同意第 2 级」「退回（第 1 级）」：没收到结果的那次做的是什么 */
export const sentLabel = (s: Pick<SentApproval, 'action' | 'level'>) => (s.action === 'approve' ? `同意第 ${s.level} 级` : `退回（第 ${s.level} 级）`);

const sameAct = (a: SentApproval, b: SentApproval) =>
  a.action === b.action && a.level === b.level && a.url === b.url && JSON.stringify(a.body) === JSON.stringify(b.body) && a.batch?.id === b.batch?.id;

function readAll(): SentApproval[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = raw ? (JSON.parse(raw) as SentApproval[]) : [];
    cachedList = (Array.isArray(parsed) ? parsed : []).filter((p) => !settled.has(keyOf(p)));
  } catch {
    cachedList = [];
  }
  return cachedList;
}

/** 写入并读回核对：写入被拒绝或被静默丢弃时返回 false */
function persist(list: SentApproval[]): boolean {
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
  snap = null;
  listeners.forEach((fn) => fn());
}

/** 发出之前存进本机；存不了抛 ApprovalStoreError，调用方不发请求 */
function save(records: SentApproval[]) {
  const list = readAll();
  const fresh = records.filter((r) => !list.some((p) => keyOf(p) === keyOf(r)));
  if (fresh.length === 0) return;
  if (!persist([...list, ...fresh])) throw new ApprovalStoreError();
  fresh.forEach((r) => settled.delete(keyOf(r)));
  notify();
}

function remove(keys: string[]) {
  const list = readAll();
  if (!list.some((p) => keys.includes(keyOf(p)))) return;
  if (!persist(list.filter((p) => !keys.includes(keyOf(p))))) keys.forEach((k) => settled.add(k));
  notify();
}

function snapshot(): SentApproval[] {
  const all = readAll();
  if (snap && snap.source === all) return snap.result;
  snap = { source: all, result: all.filter((p) => !inFlight.has(keyOf(p))) };
  return snap.result;
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

/** 本页开始发这几张 / 发完了：发着的时候不算「结果待确认」 */
function flight(keys: string[], active: boolean) {
  keys.forEach((k) => (active ? inFlight.add(k) : inFlight.delete(k)));
  snap = null;
  listeners.forEach((fn) => fn());
}

export interface UncertainApprovals {
  staffId: number;
  /** 这个账号没收到结果的（本页正在发的不算），先发的在前 */
  all: SentApproval[];
  get: (requestId: number | null | undefined) => SentApproval | null;
  /** 最近没收到结果的那一批里还没有明确结果的单 */
  batch: { id: string; comment: string; items: SentApproval[] } | null;
}

export function useUncertainApprovals(): UncertainApprovals {
  const staffId = useSession().staff.id;
  const list = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => {
    const all = list.filter((r) => r.staffId === staffId);
    const last = all.filter((r) => r.batch).at(-1)?.batch ?? null;
    return {
      staffId,
      all,
      get: (requestId) => (requestId ? (all.find((r) => r.requestId === requestId) ?? null) : null),
      batch: last ? { ...last, items: all.filter((r) => r.batch?.id === last.id) } : null,
    };
  }, [list, staffId]);
}

/** 读回：审批单已经结束（通过、退回、撤回），上次没收到结果的那次改变不了什么了，删掉记录 */
export function useSettleWhenFinished(requestId: number | null | undefined, status: ApprovalStatus | null | undefined) {
  const staffId = useSession().staff.id;
  useEffect(() => {
    if (requestId && status && status !== 'pending') remove([keyOf({ staffId, requestId })]);
  }, [requestId, status, staffId]);
}

/**
 * 同意或退回审批单的某一级（审批中心详情、单据详情原来的按钮共用）：先存本机并读回核对（存不了就不发）再发；
 * 本机已经有这张单没收到结果的记录时，只能是原样重提（内容不一样就拒绝，先处理那一笔）。
 */
export async function sendApproval<T = unknown>(act: Omit<SentApproval, 'createdAt'> & { createdAt?: string }): Promise<T> {
  const record: SentApproval = { ...act, createdAt: act.createdAt ?? new Date().toISOString() };
  const key = keyOf(record);
  const stored = readAll().find((p) => keyOf(p) === key);
  if (stored && !sameAct(stored, record)) throw new ApprovalPendingError(stored);
  const sent = stored ?? record;
  // 第一次发：标成「发着」再写入，请求还没返回时页面上不显示待确认；重提的那一条留在页面上
  if (!stored) flight([key], true);
  try {
    save([sent]);
  } catch (e) {
    if (!stored) flight([key], false);
    throw e;
  }
  try {
    const result = await api.post<T>(sent.url, sent.body);
    remove([key]);
    return result;
  } catch (e) {
    // 明确的拒绝也是上次那次的结果（级别只往前走，见上），删掉；没收到结果的接着留着
    if (!(e instanceof UncertainError)) remove([key]);
    throw e;
  } finally {
    if (!stored) flight([key], false);
  }
}

/**
 * 单据详情原来的「确认」「退回」：带着审批单与级别（useApprovalGate 的 fence）发到 …/approve、…/return 的走 sendApproval，
 * 其余（提交、撤回、冲销，或不在审批中心的单据）照旧。
 */
export function postDocAction<T = unknown>(url: string, body: unknown, docNo: string, staffId: number): Promise<T> {
  const b = (body ?? {}) as Record<string, unknown>;
  const action = url.endsWith('/approve') ? 'approve' : url.endsWith('/return') ? 'return' : null;
  if (action && typeof b.requestId === 'number' && typeof b.level === 'number') {
    return sendApproval<T>({ staffId, requestId: b.requestId, docNo, action, level: b.level, url, body: b });
  }
  return api.post<T>(url, body);
}

/**
 * 批量同意：整批先存本机（每张一条，记着同一批与意见）再发；每张的结果都是明确的（成功或写明原因的没成功）。
 * 重新提交那一批时带上原来的批号与意见，各张照上次的级别再发。
 */
export async function sendBatchApprove(
  staffId: number,
  items: { requestId: number; docNo: string; level: number }[],
  comment: string,
  batchId: string = uuid(),
): Promise<BatchApproveResult> {
  const createdAt = new Date().toISOString();
  const records: SentApproval[] = items.map((i) => ({
    staffId,
    requestId: i.requestId,
    docNo: i.docNo,
    action: 'approve',
    level: i.level,
    url: `/api/approvals/${i.requestId}/approve`,
    body: { level: i.level, comment },
    batch: { id: batchId, comment },
    createdAt,
  }));
  const list = readAll();
  for (const r of records) {
    const s = list.find((p) => keyOf(p) === keyOf(r));
    if (s && !sameAct(s, r)) throw new ApprovalPendingError(s);
  }
  const keys = records.map(keyOf);
  const fresh = keys.filter((k) => !list.some((p) => keyOf(p) === k));
  flight(fresh, true);
  try {
    save(records);
  } catch (e) {
    flight(fresh, false);
    throw e;
  }
  try {
    const r = await api.post<BatchApproveResult>('/api/approvals/batch-approve', { items: records.map((x) => ({ id: x.requestId, level: x.level })), comment });
    remove(keys);
    return r;
  } catch (e) {
    if (!(e instanceof UncertainError)) remove(keys);
    throw e;
  } finally {
    flight(fresh, false);
  }
}
