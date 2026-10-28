// 营业日口径（待确认）：营业日在每天 startHour 点切换。
// 例如 startHour = 6 时，10月26日凌晨 02:00 的业务仍记入 10月25日 营业日。

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // en-CA 的日期格式即 YYYY-MM-DD
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

export function businessDateOf(at: Date, timeZone: string, startHour: number): string {
  return formatterFor(timeZone).format(new Date(at.getTime() - startHour * 3_600_000));
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 营业时间（店主 #4，待确认）：每天 open 开门、close 打烊（HH:MM，门店时区）；close 不晚于 open 表示营业到次日。
 * null 为全天 24 小时营业。营业时间只用于显示与提醒，不拦业务；营业日仍按切换时间计算。
 */
export interface BusinessHours {
  open: string;
  close: string;
}

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** 门店时区里，这一刻是当天的第几分钟（0–1439） */
export function minuteOfDay(at: Date, timeZone: string): number {
  let f = clockFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    clockFormatters.set(timeZone, f);
  }
  const parts = f.formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return part('hour') * 60 + part('minute');
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** 这一分钟是否在营业时间内（含开门那一分钟，不含打烊那一分钟） */
export function isOpenAt(minute: number, hours: BusinessHours | null): boolean {
  if (!hours) return true;
  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  return open < close ? minute >= open && minute < close : minute >= open || minute < close;
}

/** 「10:00–次日 02:00」「全天 24 小时营业」 */
export function describeBusinessHours(hours: BusinessHours | null): string {
  if (!hours) return '全天 24 小时营业';
  const overnight = toMinutes(hours.close) <= toMinutes(hours.open);
  return `${hours.open}–${overnight ? '次日 ' : ''}${hours.close}`;
}
