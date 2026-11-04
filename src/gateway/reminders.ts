// 到期提醒的发送（小程序线第三期 3a，docs/MP_PHASE3.md 第 1 节）：网关每 30 秒向门店系统取一批待发的消息，
// 用 AppSecret 换来的接口凭据调微信的「发送订阅消息」，再把每一条的结果报回门店系统。
//   · 方向与其他接口一样：网关连门店，门店不连网关；门店断网时消息在门店等着，连上再发；
//   · 一次同意只能发一条：发了没收到回音的报「结果不明」，门店不再给第二次；回报没送到的，门店过了期限也记「结果不明」；
//   · 一批有期限（门店给的 leasedUntil）：快到期限就不再开始发；遇到微信忙、超时、连不上就停下这一批，剩下的没发，报「再试」
//     （门店隔一会儿再给）——免得微信出问题时一批一批地把顾客的同意都耗成「结果不明」；
//   · 取一批时带批次号：门店那边取好了、回答路上丢了的，下一轮带着同一个批次号再要，门店把那一批原样再给；
//   · 门店连不上、没有要发的：这一轮什么都不做。

import { randomUUID } from 'node:crypto';
import type { MpReminderLease, MpReminderReport } from '@shared/mp';
import { UpstreamDown, type Upstream } from './upstream';
import type { SubscribeMessage, WechatClient } from './wechat';

export interface ReminderTick {
  leased: number;
  sent: number;
  failed: number;
  retry: number;
  unknown: number;
  /** 没开始发、报了「再试」的（快到期限、或前面一条遇到微信忙、超时、连不上） */
  notStarted: number;
  /** 回报没送到门店（门店过了期限会记结果不明） */
  reportLost: boolean;
}

/** 两轮之间要记住的：上一轮取一批时没收到门店的回答，这一轮带着同一个批次号再要 */
export interface ReminderState {
  pendingBatch?: string;
}

/** 离这一批的期限还剩多少时不再开始发（每条最多等微信 8 秒，留出回报的时间） */
const STOP_BEFORE_MS = 30_000;

export async function sendDueReminders(o: {
  upstream: Upstream;
  wechat: WechatClient;
  state: SubscribeMessage['state'];
  limit?: number;
  memo?: ReminderState;
  now?: () => number;
}): Promise<ReminderTick | null> {
  const memo = o.memo ?? {};
  const now = o.now ?? Date.now;
  const batchId = memo.pendingBatch ?? randomUUID();
  let lease: MpReminderLease;
  try {
    // 先记下批次号：这一次的回答路上丢了，下一轮还用它
    memo.pendingBatch = batchId;
    const r = await o.upstream.call('POST', '/api/mp/gateway/reminders/lease', { body: { limit: o.limit ?? 20, batchId } });
    if (r.status !== 200) {
      memo.pendingBatch = undefined;
      return null;
    }
    lease = JSON.parse(r.body.toString('utf8')) as MpReminderLease;
  } catch (error) {
    if (error instanceof UpstreamDown) return null;
    if (error instanceof SyntaxError) {
      memo.pendingBatch = undefined;
      return null;
    }
    throw error;
  }
  const messages = lease.messages ?? [];
  const tick: ReminderTick = { leased: messages.length, sent: 0, failed: 0, retry: 0, unknown: 0, notStarted: 0, reportLost: false };
  if (!messages.length) {
    memo.pendingBatch = undefined;
    return tick;
  }
  const deadline = lease.leasedUntil ? Date.parse(lease.leasedUntil) - STOP_BEFORE_MS : now() + 60_000;
  const results: MpReminderReport[] = [];
  let stop = false;
  for (const m of messages) {
    if (stop || now() > deadline) {
      tick.notStarted += 1;
      tick.retry += 1;
      results.push({ id: m.id, leaseToken: m.leaseToken, outcome: 'retry', errcode: null, errmsg: '这一批没轮到发' });
      continue;
    }
    const r = await o.wechat.sendSubscribe({ touser: m.openid, templateId: m.templateId, page: m.page, data: m.data, state: o.state });
    tick[r.outcome] += 1;
    results.push({ id: m.id, leaseToken: m.leaseToken, outcome: r.outcome, errcode: r.errcode, errmsg: r.errmsg });
    // 顾客拒收、模板不对只是这一条的事；微信忙、超时、连不上，后面的多半也发不出去：停下这一批
    if (r.outcome === 'retry' || r.outcome === 'unknown') stop = true;
  }
  // 回报：连不上时隔一秒再试一次；还不行就算了（门店过了期限记结果不明，不会再发第二次）
  for (let i = 0; i < 2; i++) {
    try {
      const r = await o.upstream.call('POST', '/api/mp/gateway/reminders/report', { body: { results } });
      if (r.status === 200) {
        memo.pendingBatch = undefined;
        return tick;
      }
    } catch (error) {
      if (!(error instanceof UpstreamDown)) throw error;
    }
    if (i === 0) await new Promise((res) => setTimeout(res, 1000));
  }
  // 这一批已经发过了，不能再按批次号要回来重发
  memo.pendingBatch = undefined;
  tick.reportLost = true;
  return tick;
}
