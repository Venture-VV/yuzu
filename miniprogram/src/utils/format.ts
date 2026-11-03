// 金额、日期与会员码的显示。金额一律整数「分」，只用整数运算，不用浮点数算钱。

const pad2 = (n: number) => (n < 10 ? '0' : '') + n;
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 金额：¥1,234.56；sign 时正数带「+」；负数用「−」 */
export function yuan(cents: number, sign = false): string {
  const v = Math.abs(Math.round(cents));
  const s = '¥' + group(String(Math.floor(v / 100))) + '.' + pad2(v % 100);
  if (cents < 0 && v > 0) return '−' + s;
  return sign && v > 0 ? '+' + s : s;
}

/** 价目上的价格：整元不写小数（¥189），有角分的照写（¥189.50） */
export function price(cents: number): string {
  const v = Math.abs(Math.round(cents));
  const s = '¥' + group(String(Math.floor(v / 100))) + (v % 100 ? '.' + pad2(v % 100) : '');
  return cents < 0 && v > 0 ? '−' + s : s;
}

/** 赠送比例（万分比）：1000 → 10%、850 → 8.5% */
export function percentOfBp(bp: number): string {
  const whole = Math.floor(bp / 100);
  const rest = bp % 100;
  if (!rest) return whole + '%';
  return whole + '.' + (rest % 10 ? pad2(rest) : String(rest / 10)) + '%';
}

/** 门店在北京时间：ISO 时间 → 2026-10-28 14:05（不依赖手机的时区设置） */
export function shopDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!isFinite(t)) return '';
  const d = new Date(t + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

/** 只要时分：14:05 */
export function shopTime(iso: string): string {
  return shopDateTime(iso).slice(11);
}

/** 会员码每 4 位空一格，前台手输时好认 */
export function groupCode(code: string): string {
  return code.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** 时长：90 分钟；没有时长为空 */
export function minutes(m: number | null): string {
  return m ? m + ' 分钟' : '';
}
