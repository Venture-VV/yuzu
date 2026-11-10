// 每分钟的自动任务（应用每分钟调一次；demo-prepare 最后也调一次，准备完以后第一次启动应用不再改数据）。
// 各项互不影响：一项出错写日志、接着跑下一项，下一分钟再试。顺序有讲究：到期处理在权益发放、生日礼之前
// （按新的档阶发，不按过期的档阶发，Codex 自动审查 43d53e9）。

import type { AppConfig } from './config';
import type { Sql } from './db';
import { runBenefitsDaily, runVisitChallenges } from './modules/benefits';
import { sweepExpiredBonus } from './modules/bonus';
import { sweepBookings } from './modules/bookings';
import { expireCountCards } from './modules/count-cards';
import { resumeCampaigns } from './modules/coupon-campaigns';
import { processGiftOuts } from './modules/gift-outs';
import { sendPendingSms } from './modules/sms';
import { issueBirthdayCoupons } from './modules/coupons';
import { runMembershipDaily } from './modules/membership';
import { runWecomWeekly } from './modules/wecom';
import { runCanteenReminders } from './modules/canteen/push';
import { MEAL_LABELS } from '@shared/canteen';
import { WECOM_MAX_ATTEMPTS } from '@shared/wecom';

export interface JobLog {
  info: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

export async function runMinuteJobs(
  deps: { sql: Sql; config: AppConfig },
  log: JobLog,
  opts: { now?: Date; birthday?: boolean } = {},
): Promise<void> {
  const { sql, config } = deps;
  const now = opts.now ?? new Date();
  // 赠金到期作废（会员记账、打开会员详情时也会先处理这位会员）
  try {
    const n = await sweepExpiredBonus({ sql, config }, now);
    if (n > 0) log.info(`赠金到期作废：${n} 位会员`);
  } catch (error) {
    log.error('赠金到期作废扫描失败，下一分钟重试', error);
  }
  // 会员到期处理（v0.7.23）：营业日开始后处理周期、补充期已结束的会员（今天跑过、没有到期的就什么都不做）
  try {
    const run = await runMembershipDaily({ sql, config }, now);
    if (run?.processed) log.info(`会员到期处理：${run.processed} 位（保级 ${run.retained}、进补充期 ${run.grace}、降档 ${run.downgraded}）`);
    if (run?.trialsExpired) log.info(`临时身份到期：${run.trialsExpired} 位`);
    if (run?.error) log.error(`会员到期处理有出错的：${run.error}`);
  } catch (error) {
    log.error('会员到期处理失败，下一分钟重试', error);
  }
  // 会员权益（v0.7.24）：到期处理之后按新的档阶发本期的券类、生日礼、节日关怀（今天跑过、权益清单没改过就什么都不做）；
  // 日志只写这一次新发的，当天累计的写在括号里
  try {
    const run = await runBenefitsDaily({ sql, config }, now);
    if (run?.thisRun.coupons) {
      log.info(`会员权益自动发放：这一次 ${run.thisRun.processed} 位会员、${run.thisRun.coupons} 张券（营业日 ${run.businessDate} 累计 ${run.processed} 位、${run.coupons} 张）`);
    }
    if (run?.error) log.error(`会员权益自动发放有出错的：${run.error}`);
  } catch (error) {
    log.error('会员权益自动发放失败，下一分钟重试', error);
  }
  // 生日礼（v0.7.20）：应用每 10 分钟查一次生日当月还没发的会员（去重键兜底，几个进程同时跑也只发一次）
  if (opts.birthday !== false) {
    try {
      const n = await issueBirthdayCoupons({ sql, config }, now);
      if (n > 0) log.info(`生日礼：发给 ${n} 位会员`);
    } catch (error) {
      log.error('生日礼发券失败，10 分钟后重试', error);
    }
  }
  // 预约（v0.7.28）：小程序预约开始前还没确认的自动取消、过了时间没到店的记爽约、客房过了保留时间释放
  try {
    const run = await sweepBookings(sql, now);
    if (run.cancelled || run.noShow) log.info(`预约：自动取消 ${run.cancelled} 张、记爽约 ${run.noShow} 张`);
  } catch (error) {
    log.error('预约的自动处理失败，下一分钟重试', error);
  }
  // 员工食堂 · 饭点提醒（docs/CANTEEN.md 第 19 节）：到点以后 30 分钟之内，每天每顿给开着提醒的员工手机发一次（几个进程同时跑也只发一次）
  try {
    for (const r of await runCanteenReminders({ sql, config }, now)) {
      log.info(`饭点提醒（${r.date} ${MEAL_LABELS[r.meal]}）：送到 ${r.sent} 台手机${r.failed ? `、${r.failed} 台没送到` : ''}${r.skippedCheckedIn ? `；${r.skippedCheckedIn} 人已经打过卡、没再提醒` : ''}`);
    }
  } catch (error) {
    log.error('饭点提醒没发完，下一分钟接着发', error);
  }
  // 会员挑战（v0.7.28，QY-057）：这个月到店天数满了、还没送过的会员送一次
  try {
    const r = await runVisitChallenges({ sql, config }, now);
    if (r.members > 0) log.info(`会员挑战：${r.members} 位会员满了，发券 ${r.coupons} 张`);
  } catch (error) {
    log.error('会员挑战的发放失败，下一分钟重试', error);
  }
  // 批量发券（8.0.4）：请求断了、进程重启时没发完的发券单接着发（同一个人不会发两次）
  try {
    const n = await resumeCampaigns({ sql, config });
    if (n > 0) log.info(`批量发券：接着发了 ${n} 位会员`);
  } catch (error) {
    log.error('批量发券的续发失败，下一分钟重试', error);
  }
  // 短信待发箱（8.0.4）：配了短信通道才发；没配的留在待发箱，后台导出手动发
  try {
    const r = await sendPendingSms({ sql, config });
    if (r.sent || r.failed) log.info(`短信：发出 ${r.sent} 条${r.failed ? `、${r.failed} 条没发出去（下一分钟再试，最多 3 次）` : ''}`);
  } catch (error) {
    log.error('短信发送失败，下一分钟重试', error);
  }
  // 买一赠一的赠品出库（8.0.4，HY12）：结账后记下的待出库开直接耗用单，反结账的冲销；出不了的记失败等人重试
  try {
    const r = await processGiftOuts({ sql, config });
    if (r.done || r.failed || r.voided) log.info(`赠品出库：出库 ${r.done} 条、冲销 ${r.voided} 条${r.failed ? `、${r.failed} 条失败（营销成本页重试）` : ''}`);
  } catch (error) {
    log.error('赠品出库失败，下一分钟重试', error);
  }
  // 次卡（v0.7.28）：过了有效期没用完的次数作废
  try {
    const n = await expireCountCards(sql, { config }, now);
    if (n > 0) log.info(`次卡：${n} 张过期作废`);
  } catch (error) {
    log.error('次卡的过期处理失败，下一分钟重试', error);
  }
  // 企业微信每周一推（8.0.7）：周一 9:00 以后、开关打开、.env 配了机器人地址时推这一周的（同一周只推一次）
  try {
    const r = await runWecomWeekly({ sql, config }, now);
    if (r?.ok) log.info('企业微信：这一周的 ERP 提醒已推送');
    else if (r) log.error(`企业微信每周一推没发出去（隔 5 分钟再试，最多 ${WECOM_MAX_ATTEMPTS} 次）：${r.error}`);
  } catch (error) {
    log.error('企业微信每周一推失败，下一分钟重试', error);
  }
}
