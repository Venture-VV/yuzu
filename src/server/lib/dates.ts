// 日期的通用小工具（原来散在库存、费用、采购台账几个模块里；v0.7.22 代码整理时合到这里）。

import { businessDateOf, ISO_DATE } from '@shared/business-date';
import { badRequest } from './errors';

/** 门店时区的自然日（库存与采购按自然日统计，不沿用会员营业日切换规则） */
export const todayIn = (timeZone: string) => businessDateOf(new Date(), timeZone, 0);

/** 某个时刻在门店时区是哪一天 */
export const dateIn = (at: string | Date, timeZone: string) => businessDateOf(new Date(at), timeZone, 0);

/** 门店时区现在几点（HH:MM，24 小时制；8.0.1 需求单的每日截单用） */
export function clockIn(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/** 两个日期（YYYY-MM-DD）相差几天（不含起点：同一天为 0） */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** 查询的日期区间：格式对、开始不晚于结束、一次最多查 366 天 */
export function checkDateRange(from: string, to: string) {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) throw badRequest('开始日期不能晚于结束日期');
  if (daysBetween(from, to) > 366) throw badRequest('一次最多查 366 天');
}
