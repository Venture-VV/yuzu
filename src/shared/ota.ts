// OTA 渠道订单（8.0.21，docs/INTEGRATIONS_V8021.md 第 4 节，CW-I / CW9）：渠道后台导出的订单表 → 客房预约。前后端共用的列对照与解析。

export const OTA_FIELDS = ['orderNo', 'guestName', 'guestPhone', 'roomType', 'checkin', 'checkout', 'nights', 'rooms', 'amount', 'payMode', 'status'] as const;
export type OtaField = (typeof OTA_FIELDS)[number];
export type OtaColumnMap = Partial<Record<OtaField, string>>;

export const OTA_FIELD_LABELS: Record<OtaField, string> = {
  orderNo: '订单号',
  guestName: '入住人',
  guestPhone: '电话',
  roomType: '房型',
  checkin: '入住日',
  checkout: '离店日',
  nights: '晚数',
  rooms: '间数',
  amount: '金额',
  payMode: '付款方式',
  status: '状态',
};
/** 必须有的列：订单号、房型、入住日，离店日和晚数至少一个，金额 */
export const OTA_REQUIRED: OtaField[] = ['orderNo', 'roomType', 'checkin', 'amount'];

const SYNONYMS: Record<OtaField, string[]> = {
  orderNo: ['订单号', '订单编号', '预订号', '预订单号', '渠道订单号', '订单id'],
  guestName: ['入住人', '客人姓名', '住客姓名', '入住人姓名', '联系人', '姓名'],
  guestPhone: ['联系电话', '手机号', '手机', '电话', '联系人电话'],
  roomType: ['房型', '房型名称', '预订房型', '产品名称'],
  checkin: ['入住日期', '入住日', '入住时间', '到店日期', '抵店日期'],
  checkout: ['离店日期', '离店日', '离店时间', '退房日期'],
  nights: ['晚数', '入住晚数', '间夜', '入住天数', '天数'],
  rooms: ['间数', '房间数', '预订间数', '房数'],
  amount: ['订单金额', '总金额', '总价', '金额', '房费', '卖价'],
  payMode: ['付款方式', '支付方式', '支付类型', '付款类型'],
  status: ['订单状态', '状态'],
};

const norm = (s: string) => s.replace(/\s+/g, '').replace(/[（）()]/g, '').toLowerCase();

/** 按表头的同义词认列 */
export function detectOtaColumns(header: string[]): OtaColumnMap {
  const map: OtaColumnMap = {};
  const used = new Set<string>();
  for (const f of OTA_FIELDS) {
    for (const syn of SYNONYMS[f]) {
      const hit = header.find((h) => !used.has(h) && norm(h) === norm(syn)) ?? header.find((h) => !used.has(h) && norm(h).includes(norm(syn)));
      if (hit) {
        map[f] = hit;
        used.add(hit);
        break;
      }
    }
  }
  return map;
}

export function otaColumnProblem(map: OtaColumnMap): string | null {
  const missing = OTA_REQUIRED.filter((f) => !map[f]);
  if (!map.checkout && !map.nights) missing.push('checkout');
  return missing.length ? `认不出这几列：${missing.map((f) => OTA_FIELD_LABELS[f]).join('、')}；请在列对照里选` : null;
}

export interface ParsedOtaOrder {
  row: number;
  orderNo: string;
  guestName: string;
  guestPhone: string;
  roomType: string;
  checkin: string;
  checkout: string;
  nights: number;
  rooms: number;
  amountCents: number;
  payMode: 'prepaid' | 'pay_at_hotel';
  channelStatus: 'confirmed' | 'cancelled';
}

/** 2026/11/20、2026-11-20、2026年11月20日、20261120（Excel 的日期已经由读表的地方转成 YYYY-MM-DD） */
export function parseOtaDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** ¥1,234.50 → 123450 */
export function parseOtaAmount(v: string): number | null {
  const s = v.replace(/[¥￥,，\s元]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return Number(i) * 100 + Number(f.padEnd(2, '0'));
}

const ROOM_UNITS = /(间房|房间|间|房|rooms?)$/i;
const NIGHT_UNITS = /(间夜|晚|夜|天|nights?|days?)$/i;
/**
 * 间数、晚数：整数，可以带「.0」与单位（「1.0」「2 间」「3晚」，全角数字也认）；
 * 别的（「1.5」「1-2」「两间」）读不出来，返回 NaN——不把里面的数字拼在一起（「1.0」原来读成 10，Codex 审查 `4d191f4` 后补）。
 */
export function parseOtaCount(text: string, units: RegExp): number {
  const s = text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/．/g, '.')
    .replace(/\s/g, '')
    .replace(units, '');
  return /^\d{1,4}(\.0+)?$/.test(s) ? Number(s.split('.')[0]) : NaN;
}

export function parseOtaRows(header: string[], rows: { row: number; cells: string[] }[], map: OtaColumnMap): { orders: ParsedOtaOrder[]; problems: { row: number; message: string }[] } {
  const col = (f: OtaField) => (map[f] ? header.indexOf(map[f]!) : -1);
  const idx = Object.fromEntries(OTA_FIELDS.map((f) => [f, col(f)])) as Record<OtaField, number>;
  const get = (cells: string[], f: OtaField) => (idx[f] >= 0 ? (cells[idx[f]] ?? '').trim() : '');
  const roomNights = /间夜/.test(map.nights ?? '');
  const orders: ParsedOtaOrder[] = [];
  const problems: { row: number; message: string }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const orderNo = get(r.cells, 'orderNo');
    if (!orderNo) continue;
    const bad = (message: string) => problems.push({ row: r.row, message: `订单 ${orderNo}：${message}` });
    if (orderNo.length > 64) {
      bad('订单号太长');
      continue;
    }
    if (seen.has(orderNo)) {
      bad('同一份文件里重复出现');
      continue;
    }
    const checkin = parseOtaDate(get(r.cells, 'checkin'));
    if (!checkin) {
      bad('入住日读不出来');
      continue;
    }
    const roomsText = get(r.cells, 'rooms');
    const rooms = roomsText ? parseOtaCount(roomsText, ROOM_UNITS) : 1;
    if (!Number.isInteger(rooms) || rooms < 1 || rooms > 20) {
      bad('间数要是 1–20');
      continue;
    }
    let checkout = get(r.cells, 'checkout') ? parseOtaDate(get(r.cells, 'checkout')) : null;
    const nightsText = get(r.cells, 'nights');
    let nights = nightsText ? parseOtaCount(nightsText, NIGHT_UNITS) : NaN;
    // 「间夜」是间数 × 晚数：两间住三晚是 6 间夜，按间数折回晚数（除不尽的读不出来）
    if ((roomNights || /间夜/.test(nightsText)) && Number.isInteger(nights)) nights = nights % rooms === 0 ? nights / rooms : NaN;
    if (!checkout && Number.isInteger(nights) && nights > 0) checkout = addDays(checkin, nights);
    if (!checkout || checkout <= checkin) {
      bad('离店日读不出来，或不晚于入住日');
      continue;
    }
    nights = daysBetween(checkin, checkout);
    const amountCents = parseOtaAmount(get(r.cells, 'amount'));
    if (amountCents === null) {
      bad('金额读不出来');
      continue;
    }
    const roomType = get(r.cells, 'roomType');
    if (!roomType) {
      bad('没有房型');
      continue;
    }
    const pay = get(r.cells, 'payMode');
    const status = get(r.cells, 'status');
    seen.add(orderNo);
    orders.push({
      row: r.row,
      orderNo,
      guestName: get(r.cells, 'guestName').slice(0, 32),
      guestPhone: get(r.cells, 'guestPhone').replace(/\s/g, '').slice(0, 20),
      roomType: roomType.slice(0, 60),
      checkin,
      checkout,
      nights,
      rooms,
      amountCents,
      payMode: /现付|到店|前台付|酒店收/.test(pay) ? 'pay_at_hotel' : 'prepaid',
      channelStatus: /取消|退订|已退|cancel/i.test(status) ? 'cancelled' : 'confirmed',
    });
  }
  return { orders, problems };
}

// ── 页面用的类型 ──
export interface OtaChannel {
  id: number;
  name: string;
  commissionBp: number;
  roomMap: Record<string, number>;
  columnMap: OtaColumnMap;
  active: boolean;
  version: number;
}
export type OtaOrderStatus = 'new' | 'booked' | 'cancelled' | 'failed' | 'skipped';
export const OTA_ORDER_STATUS_LABELS: Record<OtaOrderStatus, string> = { new: '刚导入', booked: '已建预约', cancelled: '已取消', failed: '没建成', skipped: '已跳过' };
export interface OtaOrderView {
  id: number;
  channelId: number;
  channelName: string;
  orderNo: string;
  guestName: string;
  guestPhone: string;
  channelRoom: string;
  roomTypeName: string | null;
  checkinDate: string;
  checkoutDate: string;
  nights: number;
  rooms: number;
  amountCents: number;
  payMode: 'prepaid' | 'pay_at_hotel';
  channelStatus: 'confirmed' | 'cancelled';
  status: OtaOrderStatus;
  failReason: string | null;
  overbooked: boolean;
  notice: string | null;
  bookings: { id: number; bookingNo: string; status: string }[];
  updatedAt: string;
  /** 这一行的版本（xmin）：「重试」带上，处理时核对没被另一次导入、重试改过 */
  rev: string;
}
export interface OtaImportResult {
  importId: number;
  rows: number;
  created: number;
  updated: number;
  cancelled: number;
  failed: number;
  skipped: number;
  unchanged: number;
  problems: { row: number; message: string }[];
  orders: OtaOrderView[];
}
export interface OtaReconRow {
  channelId: number;
  channelName: string;
  orders: number;
  roomNights: number;
  amountCents: number;
  commissionCents: number;
  netCents: number;
}
/** 预付的渠道订单：结账时收款区默认带的一行团购券（平台「其他」、券码 = 订单号、金额 = 订单金额，不超过房费） */
export interface OtaPrepaidHint {
  orderNo: string;
  couponCode: string;
  channelName: string;
  roomTypeName: string;
  amountCents: number;
}
