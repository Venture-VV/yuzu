// 会员端提醒（RQ-014，接主线 8.0.4 批量发券的「会员端弹窗」；什么时候弹按 HY16，待确认）：
// 首页显示时问门店系统这位会员今天要看的提醒（收到券、券快到期），有就弹出来；点「知道了」或「看我的券」记已读，以后不再弹。
//   · 哪位会员、哪天的提醒都由门店系统按这个微信此刻的绑定与门店营业日算；没绑定、门店连不上、会员功能没开时不弹、不提示
//     （连不上时已经弹着的照旧，不关）；
//   · 记已读：先记在手机上再发。门店系统回了（记上了；或者明确拒绝，比如已经解绑）就删掉；断网、超时、门店出错时留着，
//     下次打开首页先补发、补发前不再弹这几条（看过了）。门店系统只记这位会员自己的提醒、同一条只记一次，
//     所以重提、补发都不会多记，解绑或换绑以后补发的旧编号也记不到别的会员身上；
//   · 手机上存不了也照样发：只是已读，发不出去最多下次再弹一次。
// 现有的「到期提醒我」（微信订阅消息，3a）是另一套，在 utils/reminders.ts。

import type { MpNotice, MpNoticeRead, MpNotices } from '../../../src/shared/mp';
import { isApiError, member } from './api';

const KEY = 'tq_notice_read_pending';
/** 一次最多记几条（门店系统的 MP_NOTICE_READ_MAX） */
const PER_REQUEST = 20;
/** 手机上最多留几条没确认的（补发不完的旧的先丢：最多再弹一次） */
const KEEP = 60;

export interface NoticeView {
  id: number;
  title: string;
  body: string;
  /** 券的提醒：弹窗上多一个「看我的券」 */
  coupon: boolean;
}

export function noticeView(n: MpNotice): NoticeView {
  return { id: n.id, title: n.title, body: n.body, coupon: n.kind === 'coupon_issued' || n.kind === 'coupon_expiring' };
}

function readPending(): number[] {
  try {
    const v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number' && x > 0 && Math.floor(x) === x) : [];
  } catch {
    return [];
  }
}

function writePending(ids: number[]): void {
  try {
    if (ids.length) wx.setStorageSync(KEY, ids.slice(-KEEP));
    else wx.removeStorageSync(KEY);
  } catch {
    // 存不了照样发
  }
}

/** 门店系统回了：记上了，或者明确拒绝（没绑定、编号不对）。连不上、超时、出错、太频繁的还不算 */
function settled(e: unknown): boolean {
  return isApiError(e) && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

let flushing: Promise<void> | null = null;

/**
 * 按开始时的一份快照发，每批只发一次：手机上的记录改不了（存储写坏了）时，下一批不靠「记录变短了」往前走，
 * 不会把同一批一直重发、直到被限频（Codex 审查 53df24f 的 P2）。这一次没发完、没删掉的，下次打开首页再补
 */
async function flushOnce(): Promise<void> {
  const snapshot = readPending();
  // 这一次已经发完的：每批之后把它们都从记录里去掉（前一批没删掉的，这一批再删一次）
  let done: number[] = [];
  for (let i = 0; i < snapshot.length; i += PER_REQUEST) {
    const chunk = snapshot.slice(i, i + PER_REQUEST);
    try {
      await member<MpNoticeRead>('POST', '/v1/notices/read', { ids: chunk });
    } catch (e) {
      if (!settled(e)) return;
    }
    done = done.concat(chunk);
    writePending(readPending().filter((id) => done.indexOf(id) < 0));
  }
}

/** 补发上次没确认的已读（同一时间只发一份） */
export function flushReads(): Promise<void> {
  if (!flushing) {
    flushing = flushOnce().then(
      () => {
        flushing = null;
      },
      () => {
        flushing = null;
      },
    );
  }
  return flushing;
}

/** 看过了：先记在手机上，再发给门店系统；存不了也照样发这一次 */
export async function markRead(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const before = readPending();
  writePending(before.concat(ids.filter((id) => before.indexOf(id) < 0)));
  const stored = readPending();
  const unsaved = ids.filter((id) => stored.indexOf(id) < 0);
  if (unsaved.length) {
    // 手机上存不了：这几条直接发一次，结果不管（发不出去最多下次再弹）
    try {
      for (let i = 0; i < unsaved.length; i += PER_REQUEST) await member<MpNoticeRead>('POST', '/v1/notices/read', { ids: unsaved.slice(i, i + PER_REQUEST) });
    } catch {
      // 不提示
    }
  }
  // 正在补发的那一份可能是加进来之前取的：等它发完再补发一次
  if (flushing) await flushing;
  await flushReads();
}

/**
 * 今天要弹的提醒：先补发没确认的已读，再问；还没确认已读的那几条不再弹。
 * 没绑定、会员功能没开（门店系统明确回了）是没有；断网、门店连不上、出错是问不到，回 null：页面上弹着的照旧，不关
 */
export async function loadNotices(): Promise<NoticeView[] | null> {
  await flushReads();
  try {
    const r = await member<MpNotices>('GET', '/v1/notices');
    const pending = readPending();
    return (r.notices || []).filter((n) => pending.indexOf(n.id) < 0).map(noticeView);
  } catch (e) {
    return settled(e) ? [] : null;
  }
}
