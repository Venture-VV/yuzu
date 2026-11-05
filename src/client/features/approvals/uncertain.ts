// 审批没收到结果（超时、断网、写请求遇到服务器出错；v0.7.30，Codex 自动审查 c0acccf）：记住刚才发出去的是哪张审批单、
// 第几级、什么内容；没有明确结果之前，这张审批单只能「按原内容重新提交」——原样再发，不按刷新后的级别重新拼
// （同一个人能审连续几级时，按刷新后的级别会多同意一级）。批量同意的整批原样记下（勾的单、各自的级别、意见）。
//
// 原样再发是安全的：服务端按「审批单 + 级别」把关，级别只往前走——
//   · 上次那次已经生效：不重复记（同一个人对同一级重复同意、单据已经生效或已经退回的，都按成功返回）；
//   · 还没生效：照常同意或退回这一级；
//   · 这张单已经走过这一级（别人审的）或已经结束：拒绝（APPROVAL_MOVED 等），上次那次到得再晚也同样被拒。
// 所以重新提交拿到的明确结果（成功或拒绝）就是上次那次的结果，之后不会再变，记下的就清掉；还是没收到结果就接着保留。
// 审批单已经结束（读回时看到通过、退回、撤回）时也清掉：上次那次已经改变不了什么。
// 记在这一页里，不跨刷新：刷新后页面显示的是服务端的现状，按钮上写着第几级，点了是对这一级的决定，服务端照样按级别把关。

import { useEffect, useSyncExternalStore } from 'react';
import type { ApprovalStatus, BatchApproveResult } from '@shared/approvals';
import { api, UncertainError } from '../../lib/api';

export interface SentApproval {
  requestId: number;
  docNo: string;
  action: 'approve' | 'return';
  /** 发出去时的级别 */
  level: number;
  /** 发到哪里、发了什么：重新提交时原样再发 */
  url: string;
  body: Record<string, unknown>;
}

const sent = new Map<number, SentApproval>();
/** 没收到结果的那一批：勾的单与意见（每张同时记在 sent 里） */
let batch: { ids: number[]; comment: string } | null = null;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version += 1;
  for (const f of listeners) f();
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** 读下面几样之前调用：记下的有变化时重新渲染 */
export function useUncertainApprovals(): number {
  return useSyncExternalStore(subscribe, () => version);
}

export function uncertainApproval(requestId: number | null | undefined): SentApproval | null {
  return requestId ? (sent.get(requestId) ?? null) : null;
}

/** 没收到结果的那一批里还没有明确结果的单（单张打开重新提交过的不再算） */
export function uncertainBatch(): { items: SentApproval[]; comment: string } | null {
  if (!batch) return null;
  const items = batch.ids.map((id) => sent.get(id)).filter((s): s is SentApproval => !!s);
  return items.length > 0 ? { items, comment: batch.comment } : null;
}

function settle(ids: number[]) {
  let any = false;
  for (const id of ids) any = sent.delete(id) || any;
  if (batch && !batch.ids.some((id) => sent.has(id))) {
    batch = null;
    any = true;
  }
  if (any) changed();
}

/** 读回：审批单已经结束（通过、退回、撤回），上次没收到结果的那次改变不了什么了（生效了的在审批记录里），清掉 */
export function useSettleWhenFinished(requestId: number | null | undefined, status: ApprovalStatus | null | undefined) {
  useEffect(() => {
    if (requestId && status && status !== 'pending' && sent.has(requestId)) settle([requestId]);
  }, [requestId, status]);
}

/** 同意或退回审批单的某一级（审批中心详情、单据详情原来的按钮共用）：没收到结果时记下，有明确结果（成功或拒绝）时清掉 */
export async function sendApproval<T = unknown>(act: SentApproval): Promise<T> {
  try {
    const r = await api.post<T>(act.url, act.body);
    settle([act.requestId]);
    return r;
  } catch (e) {
    if (e instanceof UncertainError) {
      sent.set(act.requestId, act);
      changed();
    } else settle([act.requestId]);
    throw e;
  }
}

/**
 * 单据详情原来的「确认」「退回」：带着审批单与级别（useApprovalGate 的 fence）发到 …/approve、…/return 的走 sendApproval，
 * 其余（提交、撤回、冲销，或不在审批中心的单据）照旧。
 */
export function postDocAction<T = unknown>(url: string, body: unknown, docNo: string): Promise<T> {
  const b = (body ?? {}) as Record<string, unknown>;
  const action = url.endsWith('/approve') ? 'approve' : url.endsWith('/return') ? 'return' : null;
  if (action && typeof b.requestId === 'number' && typeof b.level === 'number') {
    return sendApproval<T>({ requestId: b.requestId, docNo, action, level: b.level, url, body: b });
  }
  return api.post<T>(url, body);
}

/** 批量同意：没收到结果时整批记下（每张也记成单张的同意，单张打开时同样只能按原内容重新提交）；每张的结果都是明确的 */
export async function sendBatchApprove(items: { requestId: number; docNo: string; level: number }[], comment: string): Promise<BatchApproveResult> {
  const ids = items.map((i) => i.requestId);
  try {
    const r = await api.post<BatchApproveResult>('/api/approvals/batch-approve', { items: items.map((i) => ({ id: i.requestId, level: i.level })), comment });
    settle(ids);
    return r;
  } catch (e) {
    if (e instanceof UncertainError) {
      for (const i of items) {
        sent.set(i.requestId, { requestId: i.requestId, docNo: i.docNo, action: 'approve', level: i.level, url: `/api/approvals/${i.requestId}/approve`, body: { level: i.level, comment } });
      }
      batch = { ids, comment };
      changed();
    } else settle(ids);
    throw e;
  }
}
