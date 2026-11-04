// 线上充值（第二期 2a，docs/MP_RECHARGE.md）：充值页要显示的字、自定义金额的校验、建单的「结果待确认」。
// 数字全由门店系统算好（预估赠金、充完的档阶、最低与上限），这里只拼成句子；金额一律整数「分」。
//
// 建单的「结果待确认」（AGENTS.md：只读查回查不到不能断定没生效），与绑定的做法一样（bind-pending.ts）：
//   · 点「去支付」前先把这次的操作编号和选的哪一项存在手机上并读回核对，存不了就不发请求；
//   · 建好了、或门店系统明确拒绝才删；结果不确定（断网、超时、网关或门店出错、门店连不上）时保留，
//     请门店系统「确认作废」这个编号（/v1/recharge/abandon）：已经建了就回那张单（接着付）；还没有就登记作废，
//     原来那次请求之后即使到达也不会建单。以这个回答为准；
//   · 确认之前充值页显示「下单结果待确认」，不能再下新单；
//   · 手机上的记录读不出来（读存储出错，或存着的内容认不出）不当作没有：不能下单、不改写记录，提示稍后再试。

import type { MpRechargeAbandonResult, MpRechargeCreated, MpRechargeOptions, MpRechargeOrder } from '../../../src/shared/mp';
import { isApiError, member, messageOf } from './api';
import { yuan } from './format';

// ── 显示 ──

export interface PlanCard {
  planId: number;
  name: string;
  amount: string;
  /** 「预估赠 ¥150.00」；没有赠金为空 */
  bonus: string;
  /** 「充完 L2 潭影 · 初」 */
  label: string;
  coupons: string;
  blocked: string;
}

export interface OptionsView {
  open: boolean;
  notice: string;
  plans: PlanCard[];
  custom: { min: string; max: string; hint: string } | null;
  /** 首充 / 续充最低、今天还能充几笔 */
  rules: string;
  pending: OrderCard | null;
  mock: boolean;
}

export interface OrderCard {
  orderNo: string;
  status: string;
  amount: string;
  what: string;
  estimate: string;
  /** 还有多少分钟过期（待支付） */
  expires: string;
  result: { principal: string; bonus: string; label: string } | null;
  notice: string;
}

export function optionsView(o: MpRechargeOptions): OptionsView {
  const left = Math.max(0, o.dailyLimit - o.usedToday);
  const min = o.minimum > 0 ? (o.first ? '首充' : '续充') + '单笔最低 ' + yuan(o.minimum) : '';
  return {
    open: o.open,
    notice: o.notice || '',
    plans: o.plans.map((p) => ({
      planId: p.planId,
      name: p.name,
      amount: yuan(p.amount),
      bonus: p.bonus > 0 ? '预估赠 ' + yuan(p.bonus) : '',
      label: p.label ? '充完 ' + p.label : '',
      coupons: p.coupons.length ? '另送 ' + p.coupons.join('、') : '',
      blocked: p.blocked || '',
    })),
    custom: o.custom ? { min: yuan(o.custom.minCents), max: yuan(o.custom.maxCents), hint: '整元，' + yuan(o.custom.minCents) + ' 起，最多 ' + yuan(o.custom.maxCents) } : null,
    rules: [min, '今天还能充 ' + left + ' 笔'].filter((s) => s).join(' · '),
    pending: o.pending ? orderCard(o.pending) : null,
    mock: o.mock,
  };
}

const STATUS_TEXT: Record<string, string> = { pending: '待支付', paid: '充值成功', closed: '已关闭', held: '已付款，门店正在核对', handled: '已付款，门店已处理' };

export function orderCard(o: MpRechargeOrder, now = Date.now()): OrderCard {
  const mins = Math.max(0, Math.ceil((Date.parse(o.expiresAt) - now) / 60000));
  return {
    orderNo: o.orderNo,
    status: STATUS_TEXT[o.status] || o.status,
    amount: yuan(o.amount),
    what: o.planName ? o.planName : '自定义金额',
    estimate: (o.estBonus > 0 ? '预估赠 ' + yuan(o.estBonus) + '，' : '') + (o.estLabel ? '充完 ' + o.estLabel : '') + '（以到账时为准）',
    expires: o.status === 'pending' ? (mins > 0 ? mins + ' 分钟内付完有效' : '快过期了') : '',
    result: o.result ? { principal: yuan(o.result.principal), bonus: yuan(o.result.bonus), label: o.result.label } : null,
    notice: o.notice || '',
  };
}

/** 自定义金额：只收整元；不低于最低、不超过上限（分） */
export function parseCustomAmount(input: string, custom: { minCents: number; maxCents: number }): { ok: true; cents: number } | { ok: false; message: string } {
  const t = String(input || '').replace(/[\s,，¥]/g, '');
  if (!t) return { ok: false, message: '请填金额' };
  if (!/^\d{1,7}$/.test(t)) return { ok: false, message: '金额请填整元' };
  const cents = Number(t) * 100;
  if (cents < custom.minCents) return { ok: false, message: '最少充 ' + yuan(custom.minCents) };
  if (cents > custom.maxCents) return { ok: false, message: '线上单笔最多 ' + yuan(custom.maxCents) + '，更多请到前台充值' };
  return { ok: true, cents };
}

// ── 建单的「结果待确认」──

const KEY = 'tq_recharge_pending';

export interface RechargeChoice {
  planId: number | null;
  /** 自定义金额（分） */
  amount: number | null;
  /**
   * 顾客确认时充值页上的绑定状态版本号（可充项里的 bindVersion）：之后解绑、换绑过的，门店系统拒绝这次建单（BIND_STALE），
   * 不会记到换绑以后的会员上（小程序线测试 #52 的 P1）
   */
  bindVersion: number;
}

export interface RechargePending extends RechargeChoice {
  clientKey: string;
  at: number;
}

export type PendingRead = { state: 'none' } | { state: 'pending'; pending: RechargePending } | { state: 'unreadable' };

export type CreateOutcome =
  | { kind: 'created'; created: MpRechargeCreated }
  /** 原来那次已经建了单：接着付这张 */
  | { kind: 'existing'; order: MpRechargeOrder }
  /** 原来那次没有建单，已登记作废：可以重新选 */
  | { kind: 'abandoned' }
  /** 门店系统明确拒绝（不够最低、今天笔数用完、还有待支付的……） */
  | { kind: 'rejected'; code: string; message: string }
  /** 手机上的记录读不出来：不知道有没有没确认的，先不能下单 */
  | { kind: 'unreadable' }
  /** 还确认不了（多半是断网）：记录保留，网络好了再确认 */
  | { kind: 'pending'; message: string };

export function readRechargePending(): PendingRead {
  let raw: unknown;
  try {
    raw = wx.getStorageSync(KEY);
  } catch {
    return { state: 'unreadable' };
  }
  if (raw === '' || raw === undefined || raw === null) return { state: 'none' };
  const p = raw as Partial<RechargePending>;
  if (typeof p === 'object' && typeof p.clientKey === 'string' && p.clientKey) {
    return {
      state: 'pending',
      pending: {
        clientKey: p.clientKey,
        planId: typeof p.planId === 'number' ? p.planId : null,
        amount: typeof p.amount === 'number' ? p.amount : null,
        bindVersion: typeof p.bindVersion === 'number' ? p.bindVersion : -1,
        at: Number(p.at) || 0,
      },
    };
  }
  return { state: 'unreadable' };
}

function savePending(p: RechargePending): boolean {
  try {
    wx.setStorageSync(KEY, p);
    const back = wx.getStorageSync(KEY) as RechargePending | '';
    return !!back && back.clientKey === p.clientKey;
  } catch {
    return false;
  }
}

export function clearRechargePending(): void {
  try {
    wx.removeStorageSync(KEY);
  } catch {
    // 删不掉：下次确认时门店系统照样回同一个结果
  }
}

/** 结果不确定：小程序连不上网关、超时、网关或门店出错（5xx）、门店连不上 */
export const uncertain = (e: unknown) => !isApiError(e) || e.status === 0 || e.status >= 500 || e.code === 'STORE_OFFLINE';

/** 有待确认的建单时，请门店系统确认作废这个编号；以门店系统的回答为准。读不出来时不确认、不删 */
export async function resolveRechargePending(): Promise<CreateOutcome | null> {
  const r0 = readRechargePending();
  if (r0.state === 'none') return null;
  if (r0.state === 'unreadable') return { kind: 'unreadable' };
  try {
    const r = await member<MpRechargeAbandonResult>('POST', '/v1/recharge/abandon', { clientKey: r0.pending.clientKey });
    clearRechargePending();
    return r.status === 'created' ? { kind: 'existing', order: r.order } : { kind: 'abandoned' };
  } catch (e) {
    if (isApiError(e) && e.code === 'CLIENT_KEY_REUSED') {
      clearRechargePending();
      return { kind: 'abandoned' };
    }
    return { kind: 'pending', message: messageOf(e) };
  }
}

/** 建单：先确认手机上没有没确认的、再存操作编号（读不出来、存不了都不发），再发请求；结果不确定时马上确认一次 */
export async function sendCreate(choice: RechargeChoice, clientKey: string): Promise<CreateOutcome> {
  const before = readRechargePending();
  if (before.state === 'unreadable') return { kind: 'unreadable' };
  if (before.state === 'pending') return (await resolveRechargePending()) || { kind: 'pending', message: '' };
  if (!savePending({ clientKey, planId: choice.planId, amount: choice.amount, bindVersion: choice.bindVersion, at: Date.now() })) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这次没有下单，请清理微信的存储空间后再试' };
  }
  try {
    const created = await member<MpRechargeCreated>('POST', '/v1/recharge/orders', { clientKey, planId: choice.planId, amount: choice.amount, bindVersion: choice.bindVersion });
    clearRechargePending();
    return { kind: 'created', created };
  } catch (e) {
    if (!uncertain(e) && isApiError(e)) {
      clearRechargePending();
      return { kind: 'rejected', code: e.code, message: e.message };
    }
    return (await resolveRechargePending()) || { kind: 'pending', message: messageOf(e) };
  }
}
