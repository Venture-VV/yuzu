// 管家部显示金额与时间的同一套写法（8.0.18 整合）：都用全店的格式函数——
// 金额 "1,280.00"（@shared/money），时间按门店时区（登录后由会话设置，lib/utils）。
// 原来每个部件各写一份，时区写死、有的带秒有的不带、月份有的补零有的不补。
import { formatAmount } from "@shared/money";
import { formatDate, formatDateTime, formatTime } from "../../lib/utils";

const valid = (iso?: string | null): iso is string =>
  !!iso && !Number.isNaN(new Date(iso).getTime());

/** 分 → "1,280.00"，负数带负号；前面的「¥」由用的地方写 */
export const money = (cents: number): string =>
  `${cents < 0 ? "-" : ""}${formatAmount(cents)}`;

/** 近期的时刻：11/14 03:13 */
export const shortStamp = (iso?: string | null, empty = ""): string =>
  valid(iso) ? formatDateTime(iso) : empty;

/** 可能隔了年的时刻（建档、上次到访、历史记录）：2026/11/14 03:13 */
export const stamp = (iso?: string | null, empty = "—"): string =>
  valid(iso) ? `${formatDate(iso)} ${formatTime(iso)}` : empty;

/** 只要日期：2026/11/14 */
export const dayStamp = (iso?: string | null, empty = "—"): string =>
  valid(iso) ? formatDate(iso) : empty;

/** 只要钟点：03:13 */
export const clock = (iso?: string | null, empty = ""): string =>
  valid(iso) ? formatTime(iso) : empty;
