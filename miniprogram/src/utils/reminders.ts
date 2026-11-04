// 到期提醒（第三期 3a，docs/MP_PHASE3.md 第 1 节）：「提醒我」的字、请顾客同意、请门店系统记下。
//   · 微信只给这类门店一次性订阅：顾客点一次「提醒我」、在微信的弹窗里同意一次，门店系统才能发一条。弹窗只能在点按里直接调
//     （wx.requestSubscribeMessage），所以点按里先弹窗、同意了再发请求；
//   · 设提醒的「结果待确认」（AGENTS.md）：先把这次的操作编号与内容存在手机上并读回核对，存不了不发；门店系统记下了、或明确
//     拒绝了才删；结果不确定（断网、超时、网关或门店出错、门店连不上）时保留，下次打开券、会员卡、余额页时原样重提（同一个编号
//     门店系统返回同一条）。不用确认作废：晚到生效也是顾客自己要的提醒，不会记两条；
//   · 已经设好的显示「已设提醒」，不再弹窗。
//   · 第三期 3d 加了「到店提醒我」（我的预约）：门店确认以后，预约那天 10:00–20:00 之间发一条。

import type { MpReminderConsented, MpReminderKind, MpReminderOptions, MpReminderTemplateKind } from '../../../src/shared/mp';
import { isApiError, member, messageOf } from './api';
import { uuid } from './uuid';

const KEY = 'tq_reminder_pending';
/** 手机上最多留几条没确认的 */
const MAX_PENDING = 20;

export type ReminderTarget =
  | { kind: 'coupon'; couponCode: string }
  | { kind: 'membership' | 'grace' | 'bonus'; targetDate: string }
  | { kind: 'booking'; bookingId: number };

export const templateKindOf = (k: MpReminderKind): MpReminderTemplateKind => (k === 'grace' ? 'membership' : k);

/** 取能设哪几种、已经设了哪些；取不到（断网、没开）时为空，页面照常、不显示「提醒我」 */
export async function loadReminders(): Promise<MpReminderOptions | null> {
  try {
    const o = await member<MpReminderOptions>('GET', '/v1/reminders');
    return o.open ? o : null;
  } catch {
    return null;
  }
}

const sameTarget = (a: ReminderTarget, s: { kind: MpReminderKind; couponCode: string | null; bookingId?: number | null; targetDate: string }) =>
  a.kind === s.kind && (a.kind === 'coupon' ? a.couponCode === s.couponCode : a.kind === 'booking' ? a.bookingId === s.bookingId : a.targetDate === s.targetDate);

/** 这一样东西的「提醒我」：能不能设、已经设了没有、按钮上写什么 */
export function remindButton(o: MpReminderOptions | null, target: ReminderTarget): { show: boolean; set: boolean; text: string } {
  if (!o || !o.templates[templateKindOf(target.kind)]) return { show: false, set: false, text: '' };
  const done = o.set.some((s) => sameTarget(target, s) && s.state !== 'done');
  if (target.kind === 'booking') return done ? { show: true, set: true, text: '已设到店提醒' } : { show: true, set: false, text: '到店提醒我' };
  if (done) return { show: true, set: true, text: target.kind === 'grace' ? '已设补充期提醒' : '已设提醒' };
  return { show: true, set: false, text: target.kind === 'grace' ? '进补充期也提醒我' : '到期提醒我' };
}

/** 「到期前 3 天、10:00–20:00 之间发一条微信消息」 */
export function remindHint(o: MpReminderOptions, kind: MpReminderKind): string {
  const hours = o.sendHours.from + ':00–' + o.sendHours.to + ':00';
  if (kind === 'grace') return '进补充期当天 ' + hours + ' 之间发一条微信消息';
  if (kind === 'booking') return '门店确认以后，预约那天 ' + hours + ' 之间发一条微信消息';
  return '到期前 ' + o.leadDays[kind] + ' 天 ' + hours + ' 之间发一条微信消息';
}

// ── 请顾客同意 ──

/** 微信的弹窗：accept 同意；其余（拒绝、被关掉、模板不能用、出错）都是没同意 */
export function askConsent(templateId: string): Promise<'accept' | 'reject' | 'ban' | 'fail'> {
  return new Promise((resolve) => {
    try {
      wx.requestSubscribeMessage({
        tmplIds: [templateId],
        success: (r: Record<string, string>) => {
          const v = r[templateId];
          resolve(v === 'accept' ? 'accept' : v === 'ban' || v === 'filter' ? 'ban' : 'reject');
        },
        fail: () => resolve('fail'),
      });
    } catch {
      resolve('fail');
    }
  });
}

export function refusedText(r: 'reject' | 'ban' | 'fail'): string {
  if (r === 'ban') return '微信里关掉了这家店的消息，可以在小程序右上角「…」→「设置」里打开';
  if (r === 'fail') return '微信没能弹出提醒的确认，请稍后再试';
  return '没有同意，不会发提醒';
}

// ── 设提醒的「结果待确认」──

interface ReminderPending {
  clientKey: string;
  body: { kind: MpReminderKind; couponCode?: string; bookingId?: number; targetDate?: string; templateId: string; bindVersion: number };
  at: number;
}

type ListRead = { ok: true; list: ReminderPending[] } | { ok: false };

function readList(): ListRead {
  let raw: unknown;
  try {
    raw = wx.getStorageSync(KEY);
  } catch {
    return { ok: false };
  }
  if (raw === '' || raw === undefined || raw === null) return { ok: true, list: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const list = raw.filter((p): p is ReminderPending => !!p && typeof p === 'object' && typeof p.clientKey === 'string' && !!p.body && typeof p.body.kind === 'string');
  return list.length === raw.length ? { ok: true, list } : { ok: false };
}

function writeList(list: ReminderPending[]): boolean {
  try {
    if (list.length) wx.setStorageSync(KEY, list);
    else wx.removeStorageSync(KEY);
    const back = readList();
    return back.ok && back.list.length === list.length && back.list.every((p, i) => p.clientKey === list[i]!.clientKey);
  } catch {
    return false;
  }
}

function dropPending(clientKey: string): void {
  const r = readList();
  if (r.ok) writeList(r.list.filter((p) => p.clientKey !== clientKey));
}

/** 结果不确定：连不上网关、超时、网关或门店出错（5xx）、门店连不上 */
const uncertain = (e: unknown) => !isApiError(e) || e.status === 0 || e.status >= 500 || e.code === 'STORE_OFFLINE';

export type ConsentOutcome =
  /** 门店系统记下了（或之前已经记下） */
  | { kind: 'set'; consented: MpReminderConsented }
  /** 门店系统明确拒绝（绑定刚变过、到期日刚变过、券用掉了……） */
  | { kind: 'rejected'; code: string; message: string }
  /** 还不知道记下没有（多半是断网）：记录保留，下次打开时原样重提 */
  | { kind: 'pending'; message: string };

async function post(p: ReminderPending): Promise<ConsentOutcome> {
  try {
    const consented = await member<MpReminderConsented>('POST', '/v1/reminders', { clientKey: p.clientKey, ...p.body });
    dropPending(p.clientKey);
    return { kind: 'set', consented };
  } catch (e) {
    if (!uncertain(e) && isApiError(e)) {
      dropPending(p.clientKey);
      return { kind: 'rejected', code: e.code, message: e.message };
    }
    return { kind: 'pending', message: messageOf(e) };
  }
}

/** 顾客同意以后：先存在手机上（存不了不发），再请门店系统记下 */
export async function sendConsent(clientKey: string, target: ReminderTarget, templateId: string, bindVersion: number): Promise<ConsentOutcome> {
  const r = readList();
  if (!r.ok) return { kind: 'rejected', code: 'PENDING_UNREADABLE', message: '手机上的记录读不出来，这次没有设提醒，请稍后再试' };
  const body =
    target.kind === 'coupon'
      ? { kind: target.kind, couponCode: target.couponCode, templateId, bindVersion }
      : target.kind === 'booking'
        ? { kind: target.kind, bookingId: target.bookingId, templateId, bindVersion }
        : { kind: target.kind, targetDate: target.targetDate, templateId, bindVersion };
  const p: ReminderPending = { clientKey, body, at: Date.now() };
  // 最多留 20 条：太旧的先丢（门店系统里同一样东西只记一条，丢了的顾客再点一次就行）
  if (!writeList([...r.list, p].slice(-MAX_PENDING))) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这次没有设提醒，请清理微信的存储空间后再试' };
  }
  return post(p);
}

/** 打开券、会员卡、余额页时：没确认的原样重提一次（同一个编号）；返回这次记下了几条 */
export async function retryPendingReminders(): Promise<number> {
  const r = readList();
  if (!r.ok || !r.list.length) return 0;
  let set = 0;
  for (const p of r.list) if ((await post(p)).kind === 'set') set += 1;
  return set;
}

/** 设好以后的提示：「11月17日 10:00 以后会发一条微信消息」 */
export function setText(c: MpReminderConsented, o: MpReminderOptions | null): string {
  const [, m, d] = c.dueDate.split('-');
  const from = o ? o.sendHours.from : 10;
  if (c.kind === 'booking') return '已设到店提醒：门店确认以后，' + Number(m) + '月' + Number(d) + '日 ' + from + ':00 以后发一条微信消息';
  return '已设提醒：' + Number(m) + '月' + Number(d) + '日 ' + from + ':00 以后发一条微信消息';
}

/**
 * 点「提醒我」：先弹微信的确认（要在点按里直接调，前面不能有别的等待），同意了请门店系统记下，结果用提示框告诉顾客。
 * 返回要不要刷新这一页（记下了、或门店系统说情况变了）
 */
export async function remindTap(o: MpReminderOptions | null, target: ReminderTarget): Promise<boolean> {
  const tid = o ? o.templates[templateKindOf(target.kind)] : null;
  if (!o || !tid) return false;
  const answer = await askConsent(tid);
  if (answer !== 'accept') {
    wx.showToast({ title: refusedText(answer), icon: 'none' });
    return false;
  }
  const out = await sendConsent(uuid(), target, tid, o.bindVersion);
  if (out.kind === 'set') {
    wx.showModal({ title: '设好了', content: setText(out.consented, o), showCancel: false });
    return true;
  }
  if (out.kind === 'rejected') {
    wx.showModal({ title: '没有设上', content: out.message, showCancel: false });
    return true;
  }
  wx.showModal({ title: '还没设好', content: '网络不好，门店系统还没回话。下次打开这一页会再试一次，不会设成两条。', showCancel: false });
  return false;
}
