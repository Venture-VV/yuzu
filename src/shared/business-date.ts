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
