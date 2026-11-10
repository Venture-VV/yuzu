// 扫码点餐（第三期 3c，docs/MP_PHASE3.md 第 3 节）：桌码怎么认、菜单与购物车、下单与「我的账单」要显示的字、下单的「结果待确认」。
//
// 桌码：后台打印的码里是 18 位数字（71 开头）；以后换成「扫普通链接二维码打开小程序」的链接，链接里带着同一串数字。
// 这里只认出这串数字，签名对不对、是哪张桌由门店系统核对。
//
// 下单（AGENTS.md「结果待确认」，与领券、邀请领取一样）：
//   · 点「下单」前先把这次的操作编号存在手机上并读回核对，存不了就不发请求；
//   · 下了、或门店系统明确拒绝才删；结果不确定时保留，马上请门店系统「确认作废」这个编号：已经下了回那一单；
//     还没有就登记作废，原来那次请求之后即使到达也不下。以这个回答为准；连作废都发不出去时保留，确认之前不能再下；
//   · 手机上的记录读不出来不当作没有：不能下，提示稍后再试；
//   · 请求还在发（页面回到前台时）不去确认作废它；点「下单」时手机上还有上一单没确认的，先确认上一单、告诉顾客结果，这一单不下
//     （独立审查 3b/3c 的 P2：原来把上一单的结果当成这一单的，清掉了购物车）。

import type { MpFoodAbandonResult, MpFoodBill, MpFoodDish, MpFoodMenu, MpFoodOrdered } from '../../../src/shared/mp';
import { isApiError, member, messageOf } from './api';
import { price, yuan } from './format';
import { beginFlight, clearStoredIf, endFlight, inFlight, readStored, saveStored, uncertain } from './pending-store';

// ── 桌码 ──

const TABLE_IN = /(?:^|[^0-9])(71[0-9]{16})(?![0-9])/;

/** 从扫到的内容（一串数字，或带着这串数字的链接）里认出桌码；认不出回空 */
export function tableCodeOf(scanned: string | undefined | null): string {
  const m = TABLE_IN.exec(String(scanned || '').trim());
  return m ? m[1]! : '';
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** 打开点餐页带的参数：t（桌码）、scene（小程序码）、q（扫普通链接二维码打开时微信给的链接） */
export function tableFromOptions(options: Record<string, string | undefined>): string {
  for (const k of ['t', 'scene', 'q']) {
    const v = options[k];
    if (v) {
      const code = tableCodeOf(decode(v));
      if (code) return code;
    }
  }
  return '';
}

// ── 菜单与购物车 ──

/** 一单的口味备注最多几个字（与门店系统一样） */
export const NOTE_MAX = 40;

/** 购物车：菜品编号 → 份数与口味备注 */
export type Cart = Record<string, { quantity: number; note: string }>;

export interface DishView {
  id: number;
  name: string;
  price: string;
  /** 「今天没有了」「今天还剩 3 份」，不限量为空 */
  stock: string;
  soldOut: boolean;
  count: number;
  note: string;
}

export interface GroupView {
  name: string;
  dishes: DishView[];
}

const countOf = (cart: Cart, id: number) => (cart[String(id)] ? cart[String(id)]!.quantity : 0);

/** 按出品档口分组（门店系统已经按档口的顺序排好） */
export function menuGroups(dishes: MpFoodDish[], cart: Cart): GroupView[] {
  const groups: GroupView[] = [];
  for (const d of dishes) {
    let g = groups.find((x) => x.name === d.group);
    if (!g) {
      g = { name: d.group, dishes: [] };
      groups.push(g);
    }
    const line = cart[String(d.id)];
    g.dishes.push({
      id: d.id,
      name: d.name,
      price: price(d.price),
      stock: d.remaining === null ? '' : d.remaining === 0 ? '今天没有了' : d.remaining <= 5 ? '今天还剩 ' + d.remaining + ' 份' : '',
      soldOut: d.remaining === 0,
      count: line ? line.quantity : 0,
      note: line ? line.note : '',
    });
  }
  return groups;
}

export interface CartSum {
  quantity: number;
  total: number;
  /** 菜单上已经没有的、估清的不算 */
  items: { itemId: number; quantity: number; note?: string }[];
}

/** 购物车合计：按菜单上的价格算（下单时门店系统再核对一次，价格刚改过的拒绝） */
export function cartSum(cart: Cart, dishes: MpFoodDish[]): CartSum {
  let quantity = 0;
  let total = 0;
  const items: CartSum['items'] = [];
  for (const d of dishes) {
    const line = cart[String(d.id)];
    if (!line || line.quantity <= 0 || d.remaining === 0) continue;
    quantity += line.quantity;
    total += d.price * line.quantity;
    const note = line.note.trim();
    items.push(note ? { itemId: d.id, quantity: line.quantity, note } : { itemId: d.id, quantity: line.quantity });
  }
  return { quantity, total, items };
}

/** 加一份之前看看能不能加：估清、剩的份数、一道菜最多几份、最多几道菜、一单的上限；能加回空 */
export function addProblem(cart: Cart, dish: MpFoodDish, dishes: MpFoodDish[], limits: MpFoodMenu['limits']): string {
  if (dish.remaining === 0) return '「' + dish.name + '」今天没有了';
  const now = countOf(cart, dish.id);
  if (dish.remaining !== null && now + 1 > dish.remaining) return '「' + dish.name + '」今天只剩 ' + dish.remaining + ' 份';
  // 账单、点单记录能存的上限（旧的门店系统回答里没有时按 99 份、20 道菜）
  const lineMax = limits.maxLineQuantity || 99;
  const linesMax = limits.maxLines || 20;
  if (now + 1 > lineMax) return '一道菜一单最多 ' + lineMax + ' 份，多的请服务员点';
  const sum = cartSum(cart, dishes);
  if (now === 0 && sum.items.length + 1 > linesMax) return '一单最多 ' + linesMax + ' 道菜，多的请服务员点';
  if (sum.quantity + 1 > limits.maxQuantity) return '一单最多 ' + limits.maxQuantity + ' 份，多的请服务员点';
  if (sum.total + dish.price > limits.maxTotal) return '一单最多 ' + price(limits.maxTotal) + '，多的请服务员点';
  return '';
}

/** 加减一份；减到 0 就从购物车拿掉 */
export function changeCount(cart: Cart, id: number, delta: number): Cart {
  const key = String(id);
  const cur = cart[key] || { quantity: 0, note: '' };
  const quantity = Math.max(0, cur.quantity + delta);
  const next: Cart = { ...cart };
  if (quantity === 0) delete next[key];
  else next[key] = { quantity, note: cur.note };
  return next;
}

export function setNote(cart: Cart, id: number, note: string): Cart {
  const key = String(id);
  const cur = cart[key];
  if (!cur) return cart;
  return { ...cart, [key]: { quantity: cur.quantity, note: note.trim().slice(0, NOTE_MAX) } };
}

// ── 下单的结果与我的账单 ──

export interface OrderedView {
  where: string;
  no: string;
  total: string;
  lines: { key: string; name: string; qty: string; amount: string; note: string }[];
}

export function orderedView(o: MpFoodOrdered): OrderedView {
  return {
    where: o.deliverTo ? '送到 ' + o.deliverTo + ' 桌' : '服务员按手牌 ' + o.tagCode + ' 送',
    no: o.orderNo ? '出品单 ' + o.orderNo : '',
    total: yuan(o.total),
    lines: o.lines.map((l, i) => ({ key: String(i), name: l.name, qty: '×' + l.quantity, amount: yuan(l.amount), note: l.note })),
  };
}

const DISH_STATUS: Record<string, string> = { queued: '待做', cooking: '制作中', done: '已出餐', served: '已上菜', cancelled: '已退' };

export interface BillLineView {
  key: string;
  name: string;
  qty: string;
  amount: string;
  /** 进厨房的菜现在做到哪了；不进厨房的（门票、按摩……）为空 */
  status: string;
  /** 「待做」「制作中」标出来 */
  waiting: boolean;
}

export function billLines(b: MpFoodBill): BillLineView[] {
  return b.lines.map((l, i) => ({
    key: String(i),
    name: l.name,
    qty: '×' + l.quantity,
    amount: yuan(l.amount),
    status: l.status ? DISH_STATUS[l.status] || '' : '',
    waiting: l.status === 'queued' || l.status === 'cooking',
  }));
}

// ── 下单的「结果待确认」──

const ORDER_KEY = 'tq_food_order_pending';

export type OrderOutcome =
  /** 下了（或原来那次已经下了） */
  | { kind: 'ordered'; ordered: MpFoodOrdered }
  /** 原来那次没有下成，已登记作废：可以重新下 */
  | { kind: 'abandoned' }
  /** 门店系统明确拒绝（估清了、价格刚改过、手牌结了、超过上限…） */
  | { kind: 'rejected'; code: string; message: string }
  /** 手机上的记录读不出来：不知道有没有没确认的，先不能下 */
  | { kind: 'unreadable' }
  /** 还确认不了（多半是断网）：记录保留，网络好了再确认 */
  | { kind: 'pending'; message: string }
  /** 点「下单」时手机上还有上一单没确认的：确认了上一单（message 写结果），这一单没有下，购物车留着 */
  | { kind: 'earlier'; message: string };

export type OrderPendingRead = { state: 'none' } | { state: 'pending'; clientKey: string } | { state: 'unreadable' };

export function readOrderPending(): OrderPendingRead {
  const r = readStored(ORDER_KEY);
  if (r.state !== 'ok') return r;
  const clientKey = r.value.clientKey;
  return typeof clientKey === 'string' ? { state: 'pending', clientKey } : { state: 'unreadable' };
}

/** 有待确认的一单时，请门店系统确认作废这个编号；以门店系统的回答为准。读不出来时不确认、不删 */
export async function resolveOrderPending(): Promise<OrderOutcome | null> {
  const r0 = readOrderPending();
  if (r0.state === 'none') return null;
  if (r0.state === 'unreadable') return { kind: 'unreadable' };
  // 这一单还在发（页面刚回到前台）：不去作废它，等它回来
  if (inFlight(r0.clientKey)) return { kind: 'pending', message: '这一单还在提交，请稍候再点「再确认一次」' };
  try {
    const r = await member<MpFoodAbandonResult>('POST', '/v1/food/orders/abandon', { clientKey: r0.clientKey });
    clearStoredIf(ORDER_KEY, r0.clientKey);
    return r.status === 'ordered' ? { kind: 'ordered', ordered: r.ordered } : { kind: 'abandoned' };
  } catch (e) {
    if (isApiError(e) && e.code === 'CLIENT_KEY_REUSED') {
      clearStoredIf(ORDER_KEY, r0.clientKey);
      return { kind: 'abandoned' };
    }
    return { kind: 'pending', message: messageOf(e) };
  }
}

export interface OrderBody {
  items: CartSum['items'];
  /** 扫到的桌码（没扫不带） */
  table: string;
  expectedTotal: number;
  bindVersion: number;
}

/** 下单：先确认手机上没有没确认的、再存编号（读不出来、存不了都不发），再发；结果不确定时马上确认一次 */
export async function sendOrder(body: OrderBody, clientKey: string): Promise<OrderOutcome> {
  const before = readOrderPending();
  if (before.state === 'unreadable') return { kind: 'unreadable' };
  if (before.state === 'pending') {
    // 上一单还没确认：先确认上一单，告诉顾客结果；这一单不下（购物车留着，顾客看了再点）
    const earlier = await resolveOrderPending();
    if (!earlier || earlier.kind === 'abandoned') return { kind: 'earlier', message: '上一单没有下成；这一单还没下，请再点一次「下单」' };
    if (earlier.kind === 'ordered') {
      const o = earlier.ordered;
      return { kind: 'earlier', message: '上一单已经下好了（' + (o.orderNo ? '出品单 ' + o.orderNo + '，' : '') + yuan(o.total) + '）；这一单还没下，看一下「我的账单」，要的话再点一次「下单」' };
    }
    return earlier;
  }
  if (!saveStored(ORDER_KEY, { clientKey, at: Date.now() })) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这一单没有下，请清理微信的存储空间后再试' };
  }
  beginFlight(clientKey);
  try {
    const req: Record<string, unknown> = { clientKey, items: body.items, expectedTotal: body.expectedTotal, bindVersion: body.bindVersion };
    if (body.table) req.table = body.table;
    const ordered = await member<MpFoodOrdered>('POST', '/v1/food/orders', req);
    clearStoredIf(ORDER_KEY, clientKey);
    return { kind: 'ordered', ordered };
  } catch (e) {
    if (!uncertain(e) && isApiError(e)) {
      clearStoredIf(ORDER_KEY, clientKey);
      return { kind: 'rejected', code: e.code, message: e.message };
    }
    // 请求回来了、结果不确定：先拿掉「正在发」，再确认作废
    endFlight(clientKey);
    return (await resolveOrderPending()) || { kind: 'pending', message: messageOf(e) };
  } finally {
    endFlight(clientKey);
  }
}
