// 会员端提醒（RQ-014，接主线 8.0.4 批量发券的「会员端弹窗」；什么时候弹按 HY16，待确认）：
// 首页显示时问门店系统这位会员今天要看的提醒（收到券、券快到期），有就弹出来；点「知道了」或「看我的券」记已读，以后不再弹。
//   · 哪位会员、哪天的提醒都由门店系统按这个微信此刻的绑定与门店营业日算；没绑定、门店连不上、会员功能没开时不弹、不提示
//     （连不上时已经弹着的照旧，不关）；
//   · 门店系统的回答带着那一刻的绑定状态版本号：首页丢掉比见过的更旧的回答（换绑以前发出去、换绑以后才回来的）；
//     记已读带看到提醒时的版本号，之后解绑、换绑过的门店系统拒绝（BIND_STALE），旧会员的提醒照旧没读（小程序线测试 29aa0cc 的 P1）；
//   · 记已读：先记在手机上（编号与版本号）再发。门店系统回了（记上了；或者明确拒绝，比如已经解绑、换绑过）就删掉；
//     断网、超时、门店出错时留着，下次打开首页先补发、补发前不再弹这几条（看过了）。重提、补发都只记一次；
//   · 手机上存不了也照样发：只是已读，发不出去最多下次再弹一次；
//   · 手机上的记录一时读不出来（读存储出错）不当作没有：这一次不补发、不删、不改，下次再补（小程序线测试 29aa0cc 的 P2）。
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

/** 没确认的一条已读：提醒的编号，与看到它时这个微信的绑定状态版本号 */
interface PendingRead {
  id: number;
  v: number;
}
type Stored = { ok: true; items: PendingRead[] } | { ok: false };

const isInt = (x: unknown, min: number) => typeof x === 'number' && Math.floor(x) === x && x >= min;
const same = (a: PendingRead, b: PendingRead) => a.id === b.id && a.v === b.v;

/** 读手机上的记录：读出错是「读不出来」（不是没有）；认不出的条目（例如以前只存编号的）丢掉 */
function readPending(): Stored {
  let v: unknown;
  try {
    v = wx.getStorageSync(KEY);
  } catch {
    return { ok: false };
  }
  const items = Array.isArray(v)
    ? (v as unknown[]).filter((x): x is PendingRead => !!x && typeof x === 'object' && isInt((x as PendingRead).id, 1) && isInt((x as PendingRead).v, 0))
    : [];
  return { ok: true, items };
}

/** 只在刚读清楚的记录上改：读不出来时调用方不会走到这里 */
function writePending(items: PendingRead[]): void {
  try {
    if (items.length) wx.setStorageSync(KEY, items.slice(-KEEP));
    else wx.removeStorageSync(KEY);
  } catch {
    // 存不了照样发
  }
}

/** 门店系统回了：记上了，或者明确拒绝（没绑定、换绑过、编号不对）。连不上、超时、出错、太频繁的还不算 */
function settled(e: unknown): boolean {
  return isApiError(e) && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

/** 按版本号分组、每组每批最多 20 条（先来的先发） */
function batches(items: PendingRead[]): PendingRead[][] {
  const out: PendingRead[][] = [];
  const versions: number[] = [];
  for (const x of items) if (versions.indexOf(x.v) < 0) versions.push(x.v);
  for (const v of versions) {
    const group = items.filter((x) => x.v === v);
    for (let i = 0; i < group.length; i += PER_REQUEST) out.push(group.slice(i, i + PER_REQUEST));
  }
  return out;
}

const send = (batch: PendingRead[]) => member<MpNoticeRead>('POST', '/v1/notices/read', { ids: batch.map((x) => x.id), bindVersion: batch[0]!.v });

let flushing: Promise<void> | null = null;

/**
 * 按开始时的一份快照发，每批只发一次：手机上的记录改不了（存储写坏了）时，下一批不靠「记录变短了」往前走，
 * 不会把同一批一直重发、直到被限频（Codex 审查 53df24f 的 P2）。这一次没发完、没删掉的，下次打开首页再补。
 * 记录读不出来时不补发；发完一批再读不出来时就停下，不删、不改（读不出来不等于没有）
 */
async function flushOnce(): Promise<void> {
  const snapshot = readPending();
  if (!snapshot.ok) return;
  // 这一次已经发完的：每批之后把它们都从记录里去掉（前一批没删掉的，这一批再删一次）
  let done: PendingRead[] = [];
  for (const batch of batches(snapshot.items)) {
    try {
      await send(batch);
    } catch (e) {
      if (!settled(e)) return;
    }
    done = done.concat(batch);
    const now = readPending();
    if (!now.ok) return;
    writePending(now.items.filter((x) => !done.some((d) => same(d, x))));
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

/** 看过了：先记在手机上（带看到它们时的绑定状态版本号），再发给门店系统；存不了、读不出来也照样发这一次 */
export async function markRead(ids: number[], bindVersion: number): Promise<void> {
  if (!ids.length) return;
  const mine = ids.map((id) => ({ id, v: bindVersion }));
  const before = readPending();
  // 读不出来时不改（不盖掉原来那些没确认的）
  if (before.ok) writePending(before.items.concat(mine.filter((x) => !before.items.some((y) => same(x, y)))));
  const stored = readPending();
  const unsaved = stored.ok ? mine.filter((x) => !stored.items.some((y) => same(x, y))) : mine;
  if (unsaved.length) {
    // 手机上存不了：这几条直接发一次，结果不管（发不出去最多下次再弹）
    try {
      for (const batch of batches(unsaved)) await send(batch);
    } catch {
      // 不提示
    }
  }
  // 正在补发的那一份可能是加进来之前取的：等它发完再补发一次
  if (flushing) await flushing;
  await flushReads();
}

export interface NoticeLoad {
  notices: NoticeView[];
  /** 门店系统回答时这个微信的绑定状态版本号；没绑定、会员功能没开时为空 */
  bindVersion: number | null;
}

/**
 * 今天要弹的提醒：先补发没确认的已读，再问；还没确认已读的那几条不再弹。
 * 没绑定、会员功能没开（门店系统明确回了）是没有；断网、门店连不上、出错是问不到，回 null：页面上弹着的照旧，不关
 */
export async function loadNotices(): Promise<NoticeLoad | null> {
  await flushReads();
  try {
    const r = await member<MpNotices>('GET', '/v1/notices');
    const pending = readPending();
    const skip = pending.ok ? pending.items.map((x) => x.id) : [];
    return {
      notices: (r.notices || []).filter((n) => skip.indexOf(n.id) < 0).map(noticeView),
      bindVersion: typeof r.bindVersion === 'number' ? r.bindVersion : null,
    };
  } catch (e) {
    return settled(e) ? { notices: [], bindVersion: null } : null;
  }
}
