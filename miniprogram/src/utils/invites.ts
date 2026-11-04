// 邀请好友（第三期 3b，docs/MP_PHASE3.md 第 2 节）：邀请页、领取页要显示的字，发邀请码与好友领取的「结果待确认」。
//
// 发邀请码：先把这次的操作编号存在手机上并读回核对（存不了不发）；结果不确定时下次打开邀请页原样重提（同一个编号门店系统
// 返回同一个码）。晚到生效也只是多一个待领取的码，邀请人在列表里看得到、能收回。
//
// 好友领取（AGENTS.md「结果待确认」，与绑定、领券一样）：手机号快速验证的 code 只能用一次，原样重提不了——
//   · 点领取前先把这次的操作编号存在手机上并读回核对，存不了就不发请求；
//   · 领到了、或门店系统明确拒绝才删；结果不确定时保留，请门店系统「确认作废」这个编号：已经领到了回那一次，
//     还没有就登记作废，原来那次请求之后即使到达也不生效。以这个回答为准；确认之前不能再领；
//   · 手机上的记录读不出来不当作没有：不能领，提示稍后再试；
//   · 请求还在发（页面回到前台时，手机号验证的弹窗关掉也可能触发）不去确认作废它；点「领取」时手机上还有上一次没确认的，
//     先确认那一次：领的就是这一份、已经领到了就是领到了；领的是另一份、已经领到了的告诉顾客；没领到的接着领这一份。

import type { MpInviteAbandonResult, MpInviteClaimed, MpInviteCreated, MpInviteItem, MpInviteState } from '../../../src/shared/mp';
import { isApiError, member, messageOf } from './api';
import { beginFlight, clearStored, endFlight, inFlight, readStored, saveStored, uncertain } from './pending-store';

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
const CREATE_UNREADABLE: CreateOutcome = { kind: 'rejected', code: 'PENDING_UNREADABLE', message: '手机上的记录读不出来，这次没有发，请稍后再试' };

export async function sendCreate(clientKey: string, bindVersion: number): Promise<CreateOutcome> {
  const before = readStored(CREATE_KEY);
  if (before.state === 'unreadable') return CREATE_UNREADABLE;
  if (before.state === 'ok') return (await retryCreate()) || { kind: 'pending', message: '' };
  if (!saveStored(CREATE_KEY, { clientKey, bindVersion, at: Date.now() })) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这次没有发，请清理微信的存储空间后再试' };
  }
  return postCreate(clientKey, bindVersion);
}

/** 上次发邀请码的结果不确定：原样重提同一个编号（打开邀请页时）。存着的认不出来的不当作没有、不删（独立审查 3b/3c 的 P3） */
export async function retryCreate(): Promise<CreateOutcome | null> {
  const r = readStored(CREATE_KEY);
  if (r.state === 'none') return null;
  if (r.state === 'unreadable') return CREATE_UNREADABLE;
  const clientKey = r.value.clientKey;
  const bindVersion = r.value.bindVersion;
  if (typeof clientKey !== 'string' || typeof bindVersion !== 'number') return CREATE_UNREADABLE;
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
  | { kind: 'pending'; message: string }
  /** 点「领取」时手机上还有上一次没确认的、领的是另一份邀请、已经领到了：这一份没有领（message 写结果） */
  | { kind: 'earlier'; message: string };

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
  // 这次领取还在发（页面刚回到前台）：不去作废它，等它回来
  if (inFlight(r0.clientKey)) return { kind: 'pending', message: '这次领取还在提交，请稍候再点「再确认一次」' };
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
  if (before.state === 'pending') {
    const earlier = await resolveClaimPending();
    if (earlier && (earlier.kind === 'pending' || earlier.kind === 'unreadable')) return earlier;
    // 上一次领的就是这一份、已经领到了
    if (earlier && earlier.kind === 'claimed' && earlier.claimed.code === code) return earlier;
    if (earlier && earlier.kind === 'claimed') return { kind: 'earlier', message: '你之前领的另一份邀请已经领到了（' + claimedText(earlier.claimed) + '），这一份没有领' };
    // 上一次没领到（已登记作废）：接着领这一份
  }
  if (!saveStored(CLAIM_KEY, { clientKey, code, at: Date.now() })) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这次没有领，请清理微信的存储空间后再试' };
  }
  beginFlight(clientKey);
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
    // 请求回来了、结果不确定：先拿掉「正在发」，再确认作废
    endFlight(clientKey);
    return (await resolveClaimPending()) || { kind: 'pending', message: messageOf(e) };
  } finally {
    endFlight(clientKey);
  }
}
