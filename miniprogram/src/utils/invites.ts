// 邀请好友（第三期 3b，docs/MP_PHASE3.md 第 2 节）：邀请页、领取页要显示的字，发邀请码与好友领取的「结果待确认」。
//
// 发邀请码：先把这次的操作编号存在手机上并读回核对（存不了不发）；结果不确定时下次打开邀请页原样重提（同一个编号门店系统
// 返回同一个码）。晚到生效也只是多一个待领取的码，邀请人在列表里看得到、能收回。
//
// 好友领取（AGENTS.md「结果待确认」，与绑定、领券一样）：手机号快速验证的 code 只能用一次，原样重提不了——
//   · 点领取前先把这次的操作编号存在手机上并读回核对，存不了就不发请求；
//   · 领到了、或门店系统明确拒绝才删；结果不确定时保留，请门店系统「确认作废」这个编号：已经领到了回那一次，
//     还没有就登记作废，原来那次请求之后即使到达也不生效。以这个回答为准；确认之前不能再领；
//   · 手机上的记录读不出来不当作没有：不能领，提示稍后再试。

import type { MpInviteAbandonResult, MpInviteClaimed, MpInviteCreated, MpInviteItem, MpInviteState } from '../../../src/shared/mp';
import { isApiError, member, messageOf } from './api';

// ── 显示 ──

const STATE_TEXT: Record<MpInviteState, string> = { open: '待领取', used: '已领取', revoked: '已收回', expired: '过期了' };
const TRIAL_TEXT: Record<string, string> = { active: '体验中', expired: '体验结束', converted: '已转正', cancelled: '已撤销' };

/** 「11月11日」 */
export function shortDate(iso: string): string {
  const d = iso.slice(0, 10).split('-');
  return Number(d[1]) + '月' + Number(d[2]) + '日';
}

export interface InviteItemView {
  code: string;
  state: MpInviteState;
  stateText: string;
  /** 「好友能体验 L1 云涧 · 初」「王* · 体验中，至 11月11日」 */
  line: string;
  /** 「11月11日前有效」「11月4日发出」 */
  when: string;
  /** 待领取的：可以发给好友、收回 */
  open: boolean;
}

export function inviteItemView(i: MpInviteItem): InviteItemView {
  const trial = i.friend ? i.friend.trial : null;
  return {
    code: i.code,
    state: i.state,
    stateText: STATE_TEXT[i.state] || i.state,
    line: i.friend && trial ? i.friend.name + ' · ' + (TRIAL_TEXT[trial.status] || trial.status) + '，' + trial.label + ' 至 ' + shortDate(trial.endsOn) : '好友能体验 ' + i.label,
    when: i.state === 'open' ? shortDate(i.expiresAt) + '前有效' : shortDate(i.createdAt) + '发出',
    open: i.state === 'open',
  };
}

/** 领到了的提示：「L1 云涧 · 初，体验到 11月11日」 */
export function claimedText(c: MpInviteClaimed): string {
  return c.trial.label + '，体验到 ' + shortDate(c.trial.endsOn);
}

/** 结果不确定：连不上网关、超时、网关或门店出错（5xx）、门店连不上 */
export const uncertain = (e: unknown) => !isApiError(e) || e.status === 0 || e.status >= 500 || e.code === 'STORE_OFFLINE';

function readStored(key: string): { state: 'none' } | { state: 'ok'; value: Record<string, unknown> } | { state: 'unreadable' } {
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

function saveStored(key: string, value: Record<string, unknown> & { clientKey: string }): boolean {
  try {
    wx.setStorageSync(key, value);
    const back = wx.getStorageSync(key) as { clientKey?: string } | '';
    return !!back && back.clientKey === value.clientKey;
  } catch {
    return false;
  }
}

function clearStored(key: string): void {
  try {
    wx.removeStorageSync(key);
  } catch {
    // 删不掉：下次照样按门店系统的回答处理
  }
}

// ── 发邀请码 ──

const CREATE_KEY = 'tq_invite_create_pending';

export type CreateOutcome =
  | { kind: 'created'; created: MpInviteCreated }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'pending'; message: string };

async function postCreate(clientKey: string, bindVersion: number): Promise<CreateOutcome> {
  try {
    const created = await member<MpInviteCreated>('POST', '/v1/invites', { clientKey, bindVersion });
    clearStored(CREATE_KEY);
    return { kind: 'created', created };
  } catch (e) {
    if (!uncertain(e) && isApiError(e)) {
      clearStored(CREATE_KEY);
      return { kind: 'rejected', code: e.code, message: e.message };
    }
    return { kind: 'pending', message: messageOf(e) };
  }
}

/** 发一个邀请码：先存编号（存不了不发），再请门店系统发 */
export async function sendCreate(clientKey: string, bindVersion: number): Promise<CreateOutcome> {
  const before = readStored(CREATE_KEY);
  if (before.state === 'unreadable') return { kind: 'rejected', code: 'PENDING_UNREADABLE', message: '手机上的记录读不出来，这次没有发，请稍后再试' };
  if (before.state === 'ok') return (await retryCreate()) || { kind: 'pending', message: '' };
  if (!saveStored(CREATE_KEY, { clientKey, bindVersion, at: Date.now() })) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这次没有发，请清理微信的存储空间后再试' };
  }
  return postCreate(clientKey, bindVersion);
}

/** 上次发邀请码的结果不确定：原样重提同一个编号（打开邀请页时） */
export async function retryCreate(): Promise<CreateOutcome | null> {
  const r = readStored(CREATE_KEY);
  if (r.state !== 'ok') return null;
  const clientKey = r.value.clientKey;
  const bindVersion = r.value.bindVersion;
  if (typeof clientKey !== 'string' || typeof bindVersion !== 'number') {
    clearStored(CREATE_KEY);
    return null;
  }
  return postCreate(clientKey, bindVersion);
}

// ── 好友领取 ──

const CLAIM_KEY = 'tq_invite_claim_pending';

export type ClaimOutcome =
  /** 领到了（或原来那次已经领到） */
  | { kind: 'claimed'; claimed: MpInviteClaimed }
  /** 原来那次没有领到，已登记作废：可以重新领 */
  | { kind: 'abandoned' }
  /** 门店系统明确拒绝（要填姓名、被领走了、过期了、档级不够低…） */
  | { kind: 'rejected'; code: string; message: string }
  /** 手机上的记录读不出来：不知道有没有没确认的，先不能领 */
  | { kind: 'unreadable' }
  /** 还确认不了（多半是断网）：记录保留，网络好了再确认 */
  | { kind: 'pending'; message: string };

export type ClaimPendingRead = { state: 'none' } | { state: 'pending'; clientKey: string; code: string } | { state: 'unreadable' };

export function readClaimPending(): ClaimPendingRead {
  const r = readStored(CLAIM_KEY);
  if (r.state !== 'ok') return r;
  const { clientKey, code } = r.value;
  return typeof clientKey === 'string' && typeof code === 'string' ? { state: 'pending', clientKey, code } : { state: 'unreadable' };
}

/** 有待确认的领取时，请门店系统确认作废这个编号；以门店系统的回答为准。读不出来时不确认、不删 */
export async function resolveClaimPending(): Promise<ClaimOutcome | null> {
  const r0 = readClaimPending();
  if (r0.state === 'none') return null;
  if (r0.state === 'unreadable') return { kind: 'unreadable' };
  try {
    const r = await member<MpInviteAbandonResult>('POST', '/v1/invites/claim/abandon', { clientKey: r0.clientKey });
    clearStored(CLAIM_KEY);
    return r.status === 'claimed' ? { kind: 'claimed', claimed: r.claimed } : { kind: 'abandoned' };
  } catch (e) {
    if (isApiError(e) && e.code === 'CLIENT_KEY_REUSED') {
      clearStored(CLAIM_KEY);
      return { kind: 'abandoned' };
    }
    return { kind: 'pending', message: messageOf(e) };
  }
}

/** 领取：先确认手机上没有没确认的、再存编号（读不出来、存不了都不发），再发；结果不确定时马上确认一次 */
export async function sendClaim(code: string, phoneCode: string, name: string, clientKey: string, bindVersion: number): Promise<ClaimOutcome> {
  const before = readClaimPending();
  if (before.state === 'unreadable') return { kind: 'unreadable' };
  if (before.state === 'pending') return (await resolveClaimPending()) || { kind: 'pending', message: '' };
  if (!saveStored(CLAIM_KEY, { clientKey, code, at: Date.now() })) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这次没有领，请清理微信的存储空间后再试' };
  }
  try {
    const body: Record<string, unknown> = { clientKey, phoneCode, bindVersion };
    if (name.trim()) body.name = name.trim();
    const claimed = await member<MpInviteClaimed>('POST', '/v1/invites/' + code + '/claim', body);
    clearStored(CLAIM_KEY);
    return { kind: 'claimed', claimed };
  } catch (e) {
    if (!uncertain(e) && isApiError(e)) {
      clearStored(CLAIM_KEY);
      return { kind: 'rejected', code: e.code, message: e.message };
    }
    return (await resolveClaimPending()) || { kind: 'pending', message: messageOf(e) };
  }
}
