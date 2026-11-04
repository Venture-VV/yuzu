// 领券中心（第二期 2c，docs/MP_COUPONS.md）：列表要显示的字、领取的「结果待确认」。
// 能不能领、领过几张都由门店系统算好，这里只拼成句子。
//
// 领取的「结果待确认」（AGENTS.md：只读查回查不到不能断定没生效），与绑定、充值建单的做法一样：
//   · 点「领取」前先把这次的操作编号和领的哪张存在手机上并读回核对，存不了就不发请求；
//   · 领到了、或门店系统明确拒绝才删；结果不确定（断网、超时、网关或门店出错、门店连不上）时保留，
//     请门店系统「确认作废」这个编号（/v1/coupon-claims/abandon）：已经领到了就回那一张；还没有就登记作废，
//     原来那次请求之后即使到达也不会发券。以这个回答为准；
//   · 确认之前领券中心显示「领取结果待确认」，不能再领；
//   · 手机上的记录读不出来（读存储出错，或存着的内容认不出）不当作没有：不能领、不改写记录，提示稍后再试。

import type { MpCouponAbandonResult, MpCouponCenter, MpCouponClaimed } from '../../../src/shared/mp';
import { isApiError, member, messageOf } from './api';
import { couponCode, couponFace } from './views';

// ── 显示 ──

export interface OfferCard {
  templateId: number;
  name: string;
  /** 券面左边的大字：「¥30」「9 折」「兑换」 */
  big: string;
  kind: string;
  terms: string;
  validity: string;
  /** 「每人限领 1 张 · 已领 1 张」「不限领」 */
  limit: string;
  canClaim: boolean;
  /** 按钮上的字：「领取」「已领满」「领不了」 */
  button: string;
  reason: string;
}

export interface CenterView {
  open: boolean;
  notice: string;
  items: OfferCard[];
  /** 这一页显示时的绑定状态版本号：领取时带上，之后解绑、换绑过的门店系统拒绝（BIND_STALE） */
  bindVersion: number;
}

export function centerView(c: MpCouponCenter): CenterView {
  return {
    open: c.open,
    notice: c.notice || '',
    bindVersion: c.bindVersion,
    items: c.items.map((i) => {
      const face = couponFace(i.kind, i.summary);
      const full = !i.canClaim && /已经领满/.test(i.reason || '');
      return {
        templateId: i.templateId,
        name: i.name,
        big: face.big,
        kind: face.kind,
        terms: face.terms,
        validity: i.validity,
        limit: i.claimed > 0 ? i.limitText + ' · 已领 ' + i.claimed + ' 张' : i.limitText,
        canClaim: i.canClaim,
        button: i.canClaim ? '领取' : full ? '已领满' : '领不了',
        reason: i.reason || '',
      };
    }),
  };
}

/** 领到的那张：「已放进我的券」的提示里写券码与有效期 */
export function claimedText(c: MpCouponClaimed): string {
  const valid = c.coupon.validFrom === c.coupon.validTo ? c.coupon.validTo + ' 当天有效' : c.coupon.validFrom + ' 至 ' + c.coupon.validTo;
  return c.coupon.name + '（' + couponCode(c.coupon.code) + '）已放进「我的券」，' + valid;
}

// ── 领取的「结果待确认」──

const KEY = 'tq_coupon_pending';

export interface CouponPending {
  clientKey: string;
  templateId: number;
  bindVersion: number;
  at: number;
}

export type PendingRead = { state: 'none' } | { state: 'pending'; pending: CouponPending } | { state: 'unreadable' };

export type ClaimOutcome =
  /** 领到了（或原来那次已经领到） */
  | { kind: 'claimed'; claimed: MpCouponClaimed }
  /** 原来那次没有领到，已登记作废：可以重新领 */
  | { kind: 'abandoned' }
  /** 门店系统明确拒绝（领满了、档级不够、停领了……） */
  | { kind: 'rejected'; code: string; message: string }
  /** 手机上的记录读不出来：不知道有没有没确认的，先不能领 */
  | { kind: 'unreadable' }
  /** 还确认不了（多半是断网）：记录保留，网络好了再确认 */
  | { kind: 'pending'; message: string };

export function readCouponPending(): PendingRead {
  let raw: unknown;
  try {
    raw = wx.getStorageSync(KEY);
  } catch {
    return { state: 'unreadable' };
  }
  if (raw === '' || raw === undefined || raw === null) return { state: 'none' };
  const p = raw as Partial<CouponPending>;
  if (typeof p === 'object' && typeof p.clientKey === 'string' && p.clientKey && typeof p.templateId === 'number') {
    return {
      state: 'pending',
      pending: { clientKey: p.clientKey, templateId: p.templateId, bindVersion: typeof p.bindVersion === 'number' ? p.bindVersion : -1, at: Number(p.at) || 0 },
    };
  }
  return { state: 'unreadable' };
}

function savePending(p: CouponPending): boolean {
  try {
    wx.setStorageSync(KEY, p);
    const back = wx.getStorageSync(KEY) as CouponPending | '';
    return !!back && back.clientKey === p.clientKey;
  } catch {
    return false;
  }
}

export function clearCouponPending(): void {
  try {
    wx.removeStorageSync(KEY);
  } catch {
    // 删不掉：下次确认时门店系统照样回同一个结果
  }
}

/** 结果不确定：小程序连不上网关、超时、网关或门店出错（5xx）、门店连不上 */
export const uncertain = (e: unknown) => !isApiError(e) || e.status === 0 || e.status >= 500 || e.code === 'STORE_OFFLINE';

/** 有待确认的领取时，请门店系统确认作废这个编号；以门店系统的回答为准。读不出来时不确认、不删 */
export async function resolveCouponPending(): Promise<ClaimOutcome | null> {
  const r0 = readCouponPending();
  if (r0.state === 'none') return null;
  if (r0.state === 'unreadable') return { kind: 'unreadable' };
  try {
    const r = await member<MpCouponAbandonResult>('POST', '/v1/coupon-claims/abandon', { clientKey: r0.pending.clientKey });
    clearCouponPending();
    return r.status === 'claimed' ? { kind: 'claimed', claimed: r.claimed } : { kind: 'abandoned' };
  } catch (e) {
    if (isApiError(e) && e.code === 'CLIENT_KEY_REUSED') {
      clearCouponPending();
      return { kind: 'abandoned' };
    }
    return { kind: 'pending', message: messageOf(e) };
  }
}

/**
 * 领取：先确认手机上没有没确认的、再存操作编号（读不出来、存不了都不发），再发请求；结果不确定时马上确认一次。
 * bindVersion 是这一页显示时的绑定状态版本号：点了领取之后才解绑、换绑的，门店系统不发券（不会发给换绑以后的会员）
 */
export async function sendClaim(templateId: number, clientKey: string, bindVersion: number): Promise<ClaimOutcome> {
  const before = readCouponPending();
  if (before.state === 'unreadable') return { kind: 'unreadable' };
  if (before.state === 'pending') return (await resolveCouponPending()) || { kind: 'pending', message: '' };
  if (!savePending({ clientKey, templateId, bindVersion, at: Date.now() })) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这次没有领，请清理微信的存储空间后再试' };
  }
  try {
    const claimed = await member<MpCouponClaimed>('POST', '/v1/coupon-claims', { clientKey, templateId, bindVersion });
    clearCouponPending();
    return { kind: 'claimed', claimed };
  } catch (e) {
    if (!uncertain(e) && isApiError(e)) {
      clearCouponPending();
      return { kind: 'rejected', code: e.code, message: e.message };
    }
    return (await resolveCouponPending()) || { kind: 'pending', message: messageOf(e) };
  }
}
