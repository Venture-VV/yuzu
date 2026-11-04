import { useMemo, useSyncExternalStore } from 'react';
import type {
  MpAdminData,
  MpBannerAbandonResult,
  MpBannerAdmin,
  MpBannerOpLookup,
  MpBindingRow,
  MpRechargeAdminData,
  MpRechargeOrderAdmin,
  MpRefundOrderAdmin,
} from '@shared/mp';
import { api, ApiError, UncertainError } from '../../lib/api';
import { uuid } from '../../lib/utils';

// 后台「微信小程序」写操作的「结果待确认」（小程序线；Codex 审查 PR #42 的 P1）：新建首页轮播、解绑会员的微信，
// 修改内容（对顾客开放的开关、门店信息、轮播、项目介绍、线上充值的设置、领券中心的设置），以及处理「已付款待处理」的线上充值单（第二期 2a）。
// 与 ERP 单据的做法一样（src/client/lib/erpPending.ts）：
//   · 提交前把操作编号和原请求存在本机并读回核对，存不了就不发请求；
//   · 成功、或第一次提交就被明确拒绝（4xx）才删；超时、断网、服务器出错（5xx）保留，关掉弹窗、刷新后页面上照样能处理：
//     新建轮播按编号查回，查不到的「按原内容重新提交」（同一编号，不会多建）或「确认作废」（之后原请求晚到也不会新建）；
//     解绑看那条绑定是不是已经解绑，没有就「按原内容重新提交」（同一编号，只解绑一次；解绑只做一次，晚到的原请求不会再动别的）；
//     处理线上充值单看那张单是不是已经不是「已付款待处理」，还是的话「按原内容重新提交」（同一编号只处理一次）；
//     修改内容都带打开时的版本号：版本号变了就有结论（原请求要么已经生效，要么因为版本号对不上永远不会生效）；
//     没变的「按原内容重新提交」（同一版本号，不会改两次），或「放弃这次修改」（门店系统按现在的内容、用原来的版本号保存一次，
//     内容不变、版本号加一，原请求晚到也会被拒绝）；
//   · 曾经结果不明的编号，重提被明确拒绝时也保留：之前那次请求可能随后生效，要先查回或作废再下结论；
//   · 本机的记录读不出来（浏览器存储读失败，或存着的内容认不出）不当作没有（本地 AI 预检 PR #42 的 P1）：
//     这时一律不发新的请求、不改写记录（原来的记录原样留着），页面提示恢复后再读一次，读得出来才继续。
// 作废用小程序线自己的登记（迁移 044），不进共用的 op_fences，所以不用 ERP 的面板。

export type MpUpdateType = 'rules_update' | 'store_update' | 'banner_update' | 'intro_update' | 'recharge_rules_update' | 'coupon_rules_update' | 'reminder_rules_update' | 'invite_rules_update' | 'food_rules_update';
export type MpOpType = 'banner_create' | 'unbind' | 'recharge_resolve' | 'refund_retry' | 'refund_handle' | MpUpdateType;

export interface MpPendingOp {
  /** 操作编号（就是请求里的 clientKey） */
  key: string;
  type: MpOpType;
  /** 提交地址与原请求（重新提交时原样发送）；修改内容用 PUT，其余 POST */
  url: string;
  method?: 'POST' | 'PUT';
  body: Record<string, unknown>;
  /** 展示用：轮播的标题、解绑的是谁的哪个微信 */
  summary: string;
  staffName: string;
  createdAt: string;
  uncertain?: boolean;
  /** 解绑：哪位会员的哪条绑定 */
  memberId?: number;
  bindingId?: number;
  /** 修改内容：改的是哪一条（门店编号、轮播编号、项目编号；开关为 rules）与提交时带的版本号 */
  target?: string;
  baseVersion?: number;
  /** 原路退回的重试：提交时那张原路退回单的状态（查回时比对） */
  seen?: string;
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

/** 本机的待确认记录读不出来：不知道有没有没确认的，为防止重复办理，这笔不能提交 */
export class MpPendingReadError extends Error {
  readonly code = 'PENDING_READ_FAILED';
  constructor() {
    super('本机浏览器的「结果待确认」记录读不出来，不知道之前有没有没确认的，为防止重复办理，这次没有提交。请稍后在页面上方点「再读一次」；一直读不出来请换一台电脑办。');
  }
}

/** 一条记录认得出来：有编号、地址与原请求 */
const wellFormed = (p: unknown): p is Partial<MpPendingOp> & { key: string } =>
  !!p && typeof p === 'object' && typeof (p as MpPendingOp).key === 'string' && !!(p as MpPendingOp).key && !!(p as MpPendingOp).body && typeof (p as MpPendingOp).body === 'object';

/** 读本机的记录；读不了、或存着的内容认不出（不是没有）返回 null，不能当作没有 */
function readAll(): MpPendingOp[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === cachedRaw) return cachedList;
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(wellFormed)) return null;
  cachedRaw = raw;
  // 早先（只有新建轮播时）的记录没有 type、url
  cachedList = parsed.map((p) => (p.type ? (p as MpPendingOp) : ({ ...p, type: 'banner_create', url: '/api/admin/mp/banners' } as MpPendingOp)));
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
  // 读不出来时不改写：原来的记录原样留着
  if (!list || !list.some((p) => p.key === key)) return;
  persist(list.filter((p) => p.key !== key));
  notify();
}

function markUncertain(key: string) {
  const list = readAll();
  if (!list || !list.some((p) => p.key === key && !p.uncertain)) return;
  persist(list.map((p) => (p.key === key ? { ...p, uncertain: true } : p)));
  notify();
}

function snapshot(): MpPendingOp[] {
  // 读不出来时照旧显示上一次读到的（页面上方另有「读不出来」的提示，那时什么都不能提交）
  const all = readAll() ?? cachedList;
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

/** 本机的记录现在读不出来 */
export function useMpPendingUnreadable(): boolean {
  return useSyncExternalStore(subscribe, () => readAll() === null);
}

/** 「再读一次」：存储恢复后页面重新读 */
export function recheckMpPending() {
  notify();
}

/** 先存本机并读回核对（存不了就不发请求），再发请求 */
export async function sendMpOp<T>(op: Omit<MpPendingOp, 'createdAt' | 'uncertain'>): Promise<T> {
  const list = readAll();
  // 读不出来：不知道有没有没确认的，不发新的、也不重提（重提的结果要记回本机）；更不能拿空的列表把原来的记录盖掉
  if (!list) {
    notify();
    throw new MpPendingReadError();
  }
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
    const result = op.method === 'PUT' ? await api.put<T>(op.url, op.body) : await api.post<T>(op.url, op.body, { timeoutMs: 20_000 });
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

/** 处理「已付款待处理」的线上充值单（重新入账、按金额入账、已另行处理） */
export const sendResolve = (op: { key: string; orderId: number; action: string; note: string; summary: string; staffName: string }) =>
  sendMpOp<MpRechargeOrderAdmin>({
    key: op.key,
    type: 'recharge_resolve',
    url: `/api/admin/mp/recharge/orders/${op.orderId}/resolve`,
    body: { clientKey: op.key, action: op.action, note: op.note },
    summary: op.summary,
    staffName: op.staffName,
    target: String(op.orderId),
  });

/** 处理线上充值单查回（只读）：那张单已经不是「已付款待处理」就有结论（同一张单只处理一次，晚到的原请求不会再动它） */
export async function lookupResolveOp(op: MpPendingOp): Promise<{ done: boolean }> {
  const data = await api.get<MpRechargeAdminData>('/api/admin/mp/recharge');
  return { done: !data.held.some((o) => String(o.id) === op.target) };
}

/**
 * 原路退回（2d）：重试、已另行处理。都带店主看到的商户退款单号：单号变了（别人刚重试过）门店系统就不再动它，
 * 所以按原内容重新提交不会退两次、不会换两次单号
 */
export const sendRefundAct = (op: { key: string; refundId: number; act: 'retry' | 'handle'; outRefundNo: string; status: string; note?: string; summary: string; staffName: string }) =>
  sendMpOp<MpRefundOrderAdmin>({
    key: op.key,
    type: op.act === 'retry' ? 'refund_retry' : 'refund_handle',
    url: `/api/admin/mp/refunds/${op.refundId}/${op.act}`,
    body: { outRefundNo: op.outRefundNo, ...(op.note ? { note: op.note } : {}) },
    summary: op.summary,
    staffName: op.staffName,
    target: String(op.refundId),
    seen: op.status,
  });

/** 原路退回的操作查回（只读）：另行处理看是不是已经「已另行处理」；重试看单号或状态是不是变了 */
export async function lookupRefundOp(op: MpPendingOp): Promise<{ done: boolean }> {
  const data = await api.get<MpRechargeAdminData>('/api/admin/mp/recharge');
  const r = data.refunds.find((x) => String(x.id) === op.target);
  if (!r) return { done: true };
  if (op.type === 'refund_handle') return { done: r.status === 'handled' };
  return { done: r.outRefundNo !== op.body.outRefundNo || r.status !== op.seen };
}

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

// ── 修改内容（带版本号）──

/** 修改内容：先存本机再发（同一套「结果待确认」）；body 里带着打开时的版本号 */
export const sendUpdate = <T>(op: { type: MpUpdateType; url: string; target: string; body: Record<string, unknown> & { version: number }; summary: string; staffName: string }) =>
  sendMpOp<T>({ ...op, key: uuid(), method: 'PUT', baseVersion: op.body.version });

/** 每种修改会提交的内容字段（不含版本号）：查回时与现在的内容比、放弃时按现在的内容原样保存 */
const CONTENT_FIELDS: Record<MpUpdateType, string[]> = {
  rules_update: ['enabled'],
  store_update: ['name', 'hours', 'address', 'phone', 'latitude', 'longitude', 'notice', 'imageId', 'visible'],
  banner_update: ['title', 'imageId', 'link', 'startsOn', 'endsOn', 'sortOrder', 'active'],
  intro_update: ['intro', 'imageId'],
  recharge_rules_update: ['enabled', 'planIds', 'customEnabled', 'maxCents', 'dailyLimit', 'refundAuto'],
  coupon_rules_update: ['enabled', 'offers'],
  reminder_rules_update: ['enabled', 'coupon', 'membership', 'bonus'],
  invite_rules_update: ['enabled'],
  food_rules_update: ['enabled', 'itemIds'],
};

const isUpdate = (op: MpPendingOp): op is MpPendingOp & { type: MpUpdateType } => op.type in CONTENT_FIELDS;

/** 这一条现在的版本号与内容；已经没有这一条时返回 null */
function currentOf(op: MpPendingOp, data: MpAdminData): { version: number; content: Record<string, unknown> } | null {
  const found: { version: number } | undefined =
    op.type === 'rules_update'
      ? { ...data.rules }
      : op.type === 'recharge_rules_update'
        ? { ...data.rechargeRules }
        : op.type === 'coupon_rules_update'
          ? { ...data.couponRules }
          : op.type === 'reminder_rules_update'
            ? { ...data.reminderRules }
            : op.type === 'invite_rules_update'
              ? { ...data.inviteRules }
              : op.type === 'food_rules_update'
                ? { ...data.foodRules }
          : op.type === 'store_update'
          ? data.stores.find((s) => s.code === op.target)
          : op.type === 'banner_update'
            ? data.banners.find((b) => String(b.id) === op.target)
            : op.type === 'intro_update'
              ? data.items.find((i) => String(i.itemId) === op.target)
              : undefined;
  if (!found || !isUpdate(op)) return null;
  const row = found as Record<string, unknown>;
  return { version: found.version, content: Object.fromEntries(CONTENT_FIELDS[op.type].map((k) => [k, row[k] ?? null])) };
}

/** 对象按键排好（服务端存成 jsonb 会重排键） */
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
/**
 * 比内容用：服务端会去掉首尾空格，定位存到小数点后 6 位；勾选的套餐不看先后、去重；
 * 领券中心可领的券是一串对象，先后就是顾客看到的先后，按原来的先后比、对象里不看键的先后；
 * 到期提醒的模板是一个对象（模板编号与字段），不看键的先后
 */
const norm = (v: unknown) =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? JSON.stringify(sortKeys(v))
    : Array.isArray(v)
    ? v.some((x) => x !== null && typeof x === 'object')
      ? JSON.stringify(sortKeys(v))
      : JSON.stringify([...new Set(v)].sort())
    : typeof v === 'string'
      ? v.trim()
      : typeof v === 'number'
        ? Math.round(v * 1e6) / 1e6
        : (v ?? null);
function sameContent(op: MpPendingOp & { type: MpUpdateType }, content: Record<string, unknown>): boolean {
  return CONTENT_FIELDS[op.type].every((k) => norm(op.body[k]) === norm(content[k]));
}

/**
 * 修改的结论：saved = 已经改上了（现在的内容与这次提交的一样），changed = 这期间被改过（以现在的内容为准），
 * gone = 这一条已经没有了；版本号还是提交时的，返回 null（还没生效，但原请求仍可能随后生效，不能当作没改上）。
 */
export type MpUpdateOutcome = 'saved' | 'changed' | 'gone';
export function updateOutcome(op: MpPendingOp, data: MpAdminData): MpUpdateOutcome | null {
  if (!isUpdate(op)) return null;
  const now = currentOf(op, data);
  if (!now) return 'gone';
  // 版本号只会往上加：变了，原请求要么已经生效，要么因为版本号对不上永远不会生效
  if (now.version === op.baseVersion) return null;
  return sameContent(op, now.content) ? 'saved' : 'changed';
}

/** 按门店系统现在的内容查回（只读） */
export const lookupUpdate = async (op: MpPendingOp) => updateOutcome(op, await api.get<MpAdminData>('/api/admin/mp'));

/**
 * 放弃这次修改：门店系统按现在的内容、用提交时的版本号保存一次（内容不变、版本号加一），原请求晚到会因为版本号对不上被拒绝。
 * 已经有结论的（版本号变了）不再保存，返回结论。
 */
export async function abandonUpdate(op: MpPendingOp): Promise<MpUpdateOutcome | 'abandoned'> {
  const data = await api.get<MpAdminData>('/api/admin/mp');
  const outcome = updateOutcome(op, data);
  if (outcome) return outcome;
  const now = currentOf(op, data)!;
  try {
    await api.put(op.url, { ...now.content, version: op.baseVersion });
    return 'abandoned';
  } catch (e) {
    // 原请求或别人刚好先改了：再查一次，以门店系统的为准
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      const again = await lookupUpdate(op);
      if (again) return again;
    }
    throw e;
  }
}
