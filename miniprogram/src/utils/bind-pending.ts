// 绑定会员的「结果待确认」（Codex 审查 PR #42 的 P1；AGENTS.md：只读查回查不到不能断定没生效）。
//   · 点绑定前先把这次的操作编号存在手机上并读回核对，存不了就不发请求；
//   · 绑上了、或门店系统明确拒绝（不是会员、已绑别的微信……）才删；
//   · 结果不确定（断网、超时、网关或门店出错、门店连不上）时保留，请门店系统「确认作废」这个编号（/v1/bind/abandon）：
//     已经绑上了门店系统就回「已绑定」；还没有就登记作废，原来那次请求之后即使到达也不会绑定。以这个回答为准；
//   · 确认之前「我的」页显示「绑定结果待确认」，不能再点绑定（换一个编号再绑，原来那次晚到就可能绑上另一位会员）。

import type { MpBindAbandonResult } from '../../../src/shared/mp';
import { isApiError, member, messageOf } from './api';

const KEY = 'tq_bind_pending';

export interface BindPending {
  clientKey: string;
  at: number;
}

export type BindOutcome =
  | { kind: 'bound' }
  /** 门店系统明确拒绝：不是会员、这个微信或这位会员已经绑了别的…… */
  | { kind: 'rejected'; code: string; message: string }
  /** 原来那次没有绑上，已登记作废：可以重新绑定 */
  | { kind: 'abandoned' }
  /** 还确认不了（多半是断网）：记录保留，网络好了再确认 */
  | { kind: 'pending'; message: string };

export function readBindPending(): BindPending | null {
  try {
    const p = wx.getStorageSync(KEY) as BindPending | '';
    return p && typeof p.clientKey === 'string' ? p : null;
  } catch {
    return null;
  }
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

/** 有待确认的绑定时，请门店系统确认作废这个编号；以门店系统的回答为准 */
export async function resolveBindPending(): Promise<BindOutcome | null> {
  const p = readBindPending();
  if (!p) return null;
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

/** 绑定：先存操作编号（存不了不发），再发请求；结果不确定时马上确认一次 */
export async function sendBind(phoneCode: string, clientKey: string): Promise<BindOutcome> {
  if (!savePending({ clientKey, at: Date.now() })) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这次没有提交，请清理微信的存储空间后再绑定' };
  }
  try {
    await member('POST', '/v1/bind', { phoneCode, clientKey });
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
