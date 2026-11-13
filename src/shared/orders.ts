// 订单查询与逐行明细（8.0.15，docs/ORDERS_V8015.md 第 2 节）。前后端共用。
//
// 前台「流水」页的「订单查询」：按结账单号、退款单号、手牌号、桌号、会员手机号（后 4 位或全号）、会员姓名、客人称呼查账单，
// 点开看逐行明细（与打印的结账单同一个取法，另加所属部门与摊到这一行的优惠），导出当前结果的逐行明细。
// 都是只读；口径与结账时记下的项目快照（checkout_items，看板与对账包用的那一份）一致。

import type { CheckoutPrint } from './print';
import type { CheckoutMethod, RefundDetail, RefundMethod } from './checkout';

/** 一次最多列多少张（按时间倒序取最近的） */
export const ORDER_SEARCH_LIMIT = 200;
export const ORDER_QUERY_MAX = 32;

/** 列表里的一张单：结账单或退款单 */
export interface OrderRow {
  kind: 'checkout' | 'refund';
  id: number;
  /** 结账单号（JZ…）或退款单号（TK…） */
  docNo: string;
  /** 结账单：自己；退款单：原结账单 */
  checkoutId: number;
  checkoutNo: string;
  createdAt: string;
  businessDate: string;
  /** 结账单：completed 已结账 / voided 已反结账；退款单：completed 生效 / voided 已作废 */
  status: 'completed' | 'voided';
  /** 结账单：应收合计；退款单：退的金额 */
  amount: number;
  /** 结账单上生效的退款单合计（退款单为 0） */
  refundedAmount: number;
  tagCodes: string[];
  tableNames: string[];
  /** 会员姓名或客人称呼（每张手牌 / 桌台一个；散客没填称呼的不列） */
  guests: string[];
  methods: (CheckoutMethod | RefundMethod)[];
  operatorName: string;
}

export interface OrderSearchResult {
  /** 实际用的搜索词（去掉了首尾空白）；空 = 按营业日列 */
  q: string;
  /** 没有搜索词时列的营业日；有搜索词而且能看历史时为 null（跨营业日） */
  date: string | null;
  /** 这位员工能不能看之前的营业日（不能的话只查得到当天的） */
  historyAllowed: boolean;
  rows: OrderRow[];
  /** 符合的不止这些（只列了最近的 ORDER_SEARCH_LIMIT 张） */
  truncated: boolean;
}

/** 结账单的一行明细 */
export interface OrderLine {
  /** 哪张手牌 / 桌台的（「手牌 A8067」「桌台 3 号」）；按项目快照显示时为空 */
  holder: string;
  /** 项目名称（账单上的名称，与打印的结账单一样） */
  name: string;
  /** 所属部门：门票 / 客房 / 价目里的分类…（与看板、对账包同一个归法） */
  category: string;
  /** 技师与点钟 / 轮钟；没有为 null */
  technician: string | null;
  quantity: number;
  /** 单价（分）；按项目快照显示、而且同一个项目有几种单价时为 null */
  unitPrice: number | null;
  amount: number;
  /** 摊到这一行的优惠（优惠 / 免单、券抵扣、会员折扣） */
  discount: number;
}

export interface CheckoutOrderDetail {
  /** 与打印的结账单同一份（手牌、门票、逐行、收款、余额、退款单） */
  doc: CheckoutPrint;
  lines: OrderLine[];
  /**
   * lines 是怎么来的：lines = 结账那一刻账单上的明细（正常情况）；
   * items = 结账时记下的项目快照（按时刻取出来的明细与快照对不上时——例如按实际时间补录到更早时刻的结账——改用它，没有手牌、技师）
   */
  source: 'lines' | 'items';
  /** 这张单的应收、优惠合计（= 各行相加） */
  amount: number;
  discount: number;
}

export type RefundOrderDetail = RefundDetail;

/** 结账时记下的一项（checkout_items 的一行） */
export interface OrderItemSnapshot {
  category: string;
  name: string;
  quantity: number;
  amount: number;
  discount: number;
}

/** 按时刻取出来的一行（还没摊优惠）：itemName 是它在项目快照里归到的名称（房费按种类合并，别的就是 name） */
export interface RawOrderLine extends Omit<OrderLine, 'discount' | 'unitPrice'> {
  lineId: number;
  itemName: string;
  unitPrice: number;
}

const itemKey = (category: string, name: string) => `${category}\u0000${name}`;

/**
 * 把按项目记下的优惠摊到每一行：同一个项目里按金额比例，分以下的尾差按舍去的部分从大到小逐行补 1 分（最大余数法，
 * 与结账时把整单优惠摊到项目用的是同一种算法），所以各行相加正好等于这个项目的优惠。
 * 按行算出来的各项（数量、金额）与快照对不上时返回 null：调用方改用快照显示。
 */
export function allocateLineDiscounts(lines: readonly RawOrderLine[], items: readonly OrderItemSnapshot[]): OrderLine[] | null {
  const groups = new Map<string, RawOrderLine[]>();
  for (const l of lines) groups.set(itemKey(l.category, l.itemName), [...(groups.get(itemKey(l.category, l.itemName)) ?? []), l]);
  if (groups.size !== items.length) return null;
  const discountOf = new Map<number, number>();
  for (const item of items) {
    const group = groups.get(itemKey(item.category, item.name));
    if (!group) return null;
    const amount = group.reduce((s, l) => s + l.amount, 0);
    const quantity = group.reduce((s, l) => s + l.quantity, 0);
    if (amount !== item.amount || quantity !== item.quantity) return null;
    const shares = group.map((l) => ({ id: l.lineId, base: Math.floor((l.amount * item.discount) / amount), frac: (l.amount * item.discount) % amount, amount: l.amount }));
    let left = item.discount - shares.reduce((s, x) => s + x.base, 0);
    for (const x of [...shares].sort((a, b) => b.frac - a.frac || b.amount - a.amount || a.id - b.id)) {
      discountOf.set(x.id, x.base + (left > 0 ? 1 : 0));
      if (left > 0) left -= 1;
    }
  }
  return lines.map(({ lineId, itemName: _itemName, ...l }) => ({ ...l, discount: discountOf.get(lineId) ?? 0 }));
}

/** 按项目快照显示（没有手牌、技师）：单价 = 金额 / 数量，除不尽（同一个项目有几种单价）时不显示 */
export function linesFromItems(items: readonly OrderItemSnapshot[]): OrderLine[] {
  return items.map((i) => ({
    holder: '',
    name: i.name,
    category: i.category,
    technician: null,
    quantity: i.quantity,
    unitPrice: i.quantity > 0 && i.amount % i.quantity === 0 ? i.amount / i.quantity : null,
    amount: i.amount,
    discount: i.discount,
  }));
}

/** 列表里的状态文字 */
export function orderStatusLabel(row: Pick<OrderRow, 'kind' | 'status' | 'refundedAmount'>): string {
  if (row.kind === 'refund') return row.status === 'voided' ? '退款单 · 已作废' : '退款单';
  if (row.status === 'voided') return '已反结账';
  return row.refundedAmount > 0 ? '已结账 · 有退款' : '已结账';
}

/** 搜索词是不是「手机号后 4 位或 11 位全号」（只有这两种按手机号找） */
export const orderPhoneQuery = (q: string): 'tail' | 'full' | null => (/^[0-9]{4}$/.test(q) ? 'tail' : /^1[0-9]{10}$/.test(q) ? 'full' : null);
