// 绑定会员的「结果待确认」（Codex 审查 PR #42 的 P1；AGENTS.md：只读查回查不到不能断定没生效）。
//   · 点绑定前先把这次的操作编号存在手机上并读回核对，存不了就不发请求；
//   · 绑上了、或门店系统明确拒绝（不是会员、已绑别的微信……）才删；
//   · 结果不确定（断网、超时、网关或门店出错、门店连不上）时保留，请门店系统「确认作废」这个编号（/v1/bind/abandon）：
//     已经绑上了门店系统就回「已绑定」；还没有就登记作废，原来那次请求之后即使到达也不会绑定。以这个回答为准；
//   · 确认之前「我的」页显示「绑定结果待确认」，不能再点绑定（换一个编号再绑，原来那次晚到就可能绑上另一位会员）；
//   · 手机上的记录读不出来（读存储出错，或存着的内容认不出）不当作没有（本地 AI 预检 PR #42 的 P1）：不能绑定、不改写记录，
//     「我的」页提示稍后再试，读得出来才继续确认；
//   · 已经绑定时，读不出来的记录可以删：每次绑定都带着点绑定时看到的绑定状态版本号（/v1/me 的 bindVersion），
//     门店系统对不上就拒绝（BIND_STALE）。那条记录的请求是没绑定时发的，现在已经绑定，要么就是它绑上的，要么之后
//     有过绑定（版本号变了）——它晚到时，还绑着就被拒（这个微信已经有绑定），解绑之后也因为版本号对不上被拒
//     （小程序线测试预检 #44 的 P1：只靠「已经有绑定」不够，解绑之后旧请求曾经还能绑上）。

import type { MpBindAbandonResult } from '../../../src/shared/mp';
import { isApiError, member, messageOf } from './api';

const KEY = 'tq_bind_pending';

export interface BindPending {
  clientKey: string;
  at: number;
}

export type BindOutcome =
  | { kind: 'bound' }
  /** 手机上的记录读不出来：不知道有没有没确认的绑定，先不能绑定 */
  | { kind: 'unreadable' }
  /** 门店系统明确拒绝：不是会员、这个微信或这位会员已经绑了别的…… */
  | { kind: 'rejected'; code: string; message: string }
  /** 原来那次没有绑上，已登记作废：可以重新绑定 */
  | { kind: 'abandoned' }
  /** 还确认不了（多半是断网）：记录保留，网络好了再确认 */
  | { kind: 'pending'; message: string };

export type PendingRead = { state: 'none' } | { state: 'pending'; pending: BindPending } | { state: 'unreadable' };

/** 读手机上的记录：读存储出错、或存着的内容认不出（不是空的），都是「读不出来」，不能当作没有 */
export function readBindPending(): PendingRead {
  let raw: unknown;
  try {
    raw = wx.getStorageSync(KEY);
  } catch {
    return { state: 'unreadable' };
  }
  // 没存过时微信返回空字符串
  if (raw === '' || raw === undefined || raw === null) return { state: 'none' };
  const p = raw as Partial<BindPending>;
  if (typeof p === 'object' && typeof p.clientKey === 'string' && p.clientKey) return { state: 'pending', pending: { clientKey: p.clientKey, at: Number(p.at) || 0 } };
  return { state: 'unreadable' };
}


/** 写入并读回核对：写不进去或读回不对返回 false */
function savePending(p: BindPending): boolean {
  try {
    wx.setStorageSync(KEY, p);
    const back = wx.getStorageSync(KEY) as BindPending | '';
    return !!back && back.clientKey === p.clientKey;
  } catch {
    return false;
  }
}

export function clearBindPending(): void {
  try {
    wx.removeStorageSync(KEY);
  } catch {
    // 删不掉：下次确认时门店系统照样回同一个结果
  }
}

/** 结果不确定：小程序连不上网关、超时、网关或门店出错（5xx）、门店连不上；其余是明确的回答 */
export const uncertain = (e: unknown) => !isApiError(e) || e.status === 0 || e.status >= 500 || e.code === 'STORE_OFFLINE';

/** 有待确认的绑定时，请门店系统确认作废这个编号；以门店系统的回答为准。读不出来时不确认、不删 */
export async function resolveBindPending(): Promise<BindOutcome | null> {
  const r0 = readBindPending();
  if (r0.state === 'none') return null;
  if (r0.state === 'unreadable') return { kind: 'unreadable' };
  const p = r0.pending;
  try {
    const r = await member<MpBindAbandonResult>('POST', '/v1/bind/abandon', { clientKey: p.clientKey });
    clearBindPending();
    return r.status === 'bound' ? { kind: 'bound' } : { kind: 'abandoned' };
  } catch (e) {
    // 这个编号被别的微信用了（几乎不会发生）：对这个微信来说就是没绑上
    if (isApiError(e) && e.code === 'CLIENT_KEY_REUSED') {
      clearBindPending();
      return { kind: 'abandoned' };
    }
    return { kind: 'pending', message: messageOf(e) };
  }
}

/** 已经绑定了：手机上读不出来的记录不再要紧（它的请求带的绑定版本号已经过时，晚到也不会生效，见文件开头），能删就删 */
export function dropUnreadableWhenBound(): void {
  if (readBindPending().state === 'unreadable') clearBindPending();
}

/**
 * 绑定：先确认手机上没有没确认的绑定、再存操作编号（读不出来、存不了都不发），再发请求；结果不确定时马上确认一次。
 * bindVersion 是点绑定时页面上的绑定状态版本号（/v1/me 给的）：期间绑定状态变过，门店系统拒绝（BIND_STALE），页面刷新后再绑
 */
export async function sendBind(phoneCode: string, clientKey: string, bindVersion: number): Promise<BindOutcome> {
  const before = readBindPending();
  // 读不出来：不能拿新的编号盖掉原来那条（原来那次晚到就可能绑上）
  if (before.state === 'unreadable') return { kind: 'unreadable' };
  // 还有没确认的：先确认那一次
  if (before.state === 'pending') return (await resolveBindPending()) ?? { kind: 'pending', message: '' };
  if (!savePending({ clientKey, at: Date.now() })) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这次没有提交，请清理微信的存储空间后再绑定' };
  }
  try {
    await member('POST', '/v1/bind', { phoneCode, clientKey, bindVersion });
    clearBindPending();
    return { kind: 'bound' };
  } catch (e) {
    if (!uncertain(e) && isApiError(e)) {
      clearBindPending();
      return { kind: 'rejected', code: e.code, message: e.message };
    }
    return (await resolveBindPending()) ?? { kind: 'pending', message: messageOf(e) };
  }
}
