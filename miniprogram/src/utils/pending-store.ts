// 「结果待确认」存在手机上的记录（AGENTS.md）：第三期的邀请领取、扫码点餐共用。
//   · 存：写进去再读回来核对，核对不上当作存不了（存不了就不发请求）；
//   · 读：读出错、或存着的东西认不出，都当「读不出来」，不当作没有；
//   · 删：删不掉也不要紧，下次照样按门店系统的回答处理。

import { isApiError } from './api';

/** 结果不确定：连不上网关、超时、网关或门店出错（5xx）、门店连不上 */
export const uncertain = (e: unknown) => !isApiError(e) || e.status === 0 || e.status >= 500 || e.code === 'STORE_OFFLINE';

export type Stored = { state: 'none' } | { state: 'ok'; value: Record<string, unknown> } | { state: 'unreadable' };

export function readStored(key: string): Stored {
  let raw: unknown;
  try {
    raw = wx.getStorageSync(key);
  } catch {
    return { state: 'unreadable' };
  }
  if (raw === '' || raw === undefined || raw === null) return { state: 'none' };
  if (typeof raw !== 'object') return { state: 'unreadable' };
  return { state: 'ok', value: raw as Record<string, unknown> };
}

export function saveStored(key: string, value: Record<string, unknown> & { clientKey: string }): boolean {
  try {
    wx.setStorageSync(key, value);
    const back = wx.getStorageSync(key) as { clientKey?: string } | '';
    return !!back && back.clientKey === value.clientKey;
  } catch {
    return false;
  }
}

export function clearStored(key: string): void {
  try {
    wx.removeStorageSync(key);
  } catch {
    // 删不掉：下次照样按门店系统的回答处理
  }
}
