// 次卡（v0.7.28 ④，docs/SCHEDULE_FINISH.md 第 5 节，N5 待确认）：前后端共用的类型、默认值与「按次抵扣」的分配算法。
//   · 卡种：能抵哪些价目项目、哪些票种，几次、售价、有效期（天，空为长期）；改卡种只影响之后卖的卡（卡上记下当时的条件）；
//   · 售卡：卖给会员，现金类收款（现金、微信、支付宝、银行卡、其他），记到经办人当班的班次；是收款、不是营业额；
//   · 结账「用次卡」：一次抵一份（门票一位客人算一份）；先抵单价高的；是会员的预付消费，与会员储值一样算营业额、不算实收；
//     不和券、会员折扣、优惠 / 免单同时用（与它们之间一样二选一）；反结账退回次数；
//   · 退卡：退剩下的次数，默认退 售价 × 剩下次数 ÷ 总次数（舍到分），可以改少；店主、店总、值班经理；
//   · 过期：过了有效期没用完的次数作废（每分钟的自动处理，一张一个事务）；
//   · 旧次卡期初：按模板导入（只记次数，不记钱、不进交班）。
// 金额都是分。

import type { PaymentMethod } from './labels';

export const MAX_COUNT_CARD_USES = 100;
export const MAX_COUNT_CARD_PRICE = 10_000_000;
export const MAX_COUNT_CARD_NAME = 32;
/** 一张结账单最多用几张次卡 */
export const MAX_COUNT_CARDS_PER_CHECKOUT = 5;
/** 卡种的有效期默认 365 天（N5，待确认） */
export const DEFAULT_COUNT_CARD_VALID_DAYS = 365;

export const COUNT_CARD_STATUSES = ['active', 'used_up', 'expired', 'refunded'] as const;
export type CountCardStatus = (typeof COUNT_CARD_STATUSES)[number];
export const COUNT_CARD_STATUS_LABELS: Record<CountCardStatus, string> = { active: '可用', used_up: '已用完', expired: '已过期', refunded: '已退卡' };

export const COUNT_CARD_SOURCES = ['sale', 'opening'] as const;
export type CountCardSource = (typeof COUNT_CARD_SOURCES)[number];
export const COUNT_CARD_SOURCE_LABELS: Record<CountCardSource, string> = { sale: '售卡', opening: '旧次卡期初' };

export const COUNT_CARD_MOVE_KINDS = ['sale', 'opening', 'use', 'return', 'refund', 'expire'] as const;
export type CountCardMoveKind = (typeof COUNT_CARD_MOVE_KINDS)[number];
export const COUNT_CARD_MOVE_LABELS: Record<CountCardMoveKind, string> = {
  sale: '售卡',
  opening: '期初导入',
  use: '结账使用',
  return: '反结账退回',
  refund: '退卡',
  expire: '过期作废',
};

/** 卡种（后台「价目与套餐」维护） */
export interface CountCardType {
  id: number;
  name: string;
  itemIds: number[];
  ticketTypeIds: number[];
  /** 能抵的项目、票种的名称（显示用） */
  targetNames: string[];
  uses: number;
  price: number;
  /** 有效期（天）；null = 长期 */
  validDays: number | null;
  active: boolean;
  note: string;
  version: number;
  soldCount: number;
}

/** 会员的一张次卡 */
export interface CountCard {
  id: number;
  cardNo: string;
  memberId: number;
  memberName: string;
  typeId: number | null;
  name: string;
  itemIds: number[];
  ticketTypeIds: number[];
  targetNames: string[];
  totalUses: number;
  remaining: number;
  price: number;
  expiresOn: string | null;
  source: CountCardSource;
  status: CountCardStatus;
  paymentMethod: PaymentMethod | null;
  businessDate: string;
  soldByName: string;
  soldAt: string;
  /** 退卡（有的话） */
  refund: { refundNo: string; amount: number; uses: number; method: PaymentMethod; reason: string; createdAt: string; operatorName: string } | null;
  version: number;
}

export interface CountCardMove {
  id: number;
  kind: CountCardMoveKind;
  delta: number;
  amount: number;
  checkoutNo: string | null;
  note: string;
  staffName: string;
  at: string;
  businessDate: string;
}

/** 退卡默认退多少：售价 × 剩下次数 ÷ 总次数，舍到分；用完的、没有售价（期初）的为 0 */
export const defaultCountCardRefund = (c: Pick<CountCard, 'price' | 'remaining' | 'totalUses'>) =>
  c.totalUses > 0 ? Math.floor((c.price * c.remaining) / c.totalUses) : 0;

/** 这张卡今天能不能用（不看次数） */
export function countCardUsable(c: Pick<CountCard, 'status' | 'expiresOn' | 'remaining'>, date: string): string | null {
  if (c.status === 'refunded') return '已退卡';
  if (c.status === 'expired' || (c.expiresOn !== null && c.expiresOn < date)) return `已过期（有效期到 ${c.expiresOn}）`;
  if (c.remaining <= 0 || c.status === 'used_up') return '次数已用完';
  return null;
}

// ───────────── 结账时按次抵扣 ─────────────

/** 结账时的一份（与券同一套明细：门票还没挂到账单时用负数编号代替） */
export interface CountCardLine {
  id: number;
  itemId: number | null;
  ticketTypeId: number | null;
  name: string;
  unitPrice: number;
  quantity: number;
  amount: number;
}

/** 一张卡这次抵哪几份：每份是哪一条明细、抵多少 */
export interface CountCardAllocation {
  cardId: number;
  units: { lineId: number; amount: number; name: string }[];
  amount: number;
}

/**
 * 这一次结账里几张卡（按卡号 id 升序）依次抵：每张卡在还没被前面的卡抵掉的份里，挑能抵的、单价高的先抵（同价先门票、再按明细编号），
 * 抵 uses 份（不够就抵能抵的那几份）。每份抵 min(单价, 这条明细剩下没抵的金额)。前后端用同一个函数，结果一致才能结账。
 */
export function allocateCountCards(
  cards: { cardId: number; itemIds: number[]; ticketTypeIds: number[]; uses: number }[],
  lines: readonly CountCardLine[],
): CountCardAllocation[] {
  const left = new Map(lines.map((l) => [l.id, { qty: l.quantity, amount: l.amount }]));
  const order = [...lines].sort(
    (a, b) => b.unitPrice - a.unitPrice || Number(b.ticketTypeId !== null) - Number(a.ticketTypeId !== null) || a.id - b.id,
  );
  return [...cards]
    .sort((a, b) => a.cardId - b.cardId)
    .map((c) => {
      const units: CountCardAllocation['units'] = [];
      for (const l of order) {
        if (units.length >= c.uses) break;
        const fits = (l.itemId !== null && c.itemIds.includes(l.itemId)) || (l.ticketTypeId !== null && c.ticketTypeIds.includes(l.ticketTypeId));
        if (!fits) continue;
        const rest = left.get(l.id)!;
        while (units.length < c.uses && rest.qty > 0 && rest.amount > 0) {
          const amount = Math.min(l.unitPrice, rest.amount);
          if (amount <= 0) break;
          units.push({ lineId: l.id, amount, name: l.name });
          rest.qty -= 1;
          rest.amount -= amount;
        }
      }
      return { cardId: c.cardId, units, amount: units.reduce((s, u) => s + u.amount, 0) };
    });
}

/** 结账前核对给的：这几位会员能用的次卡，与这张卡在这次结账里最多能抵几份 */
export interface CheckoutCountCardOption {
  cardId: number;
  cardNo: string;
  memberId: number;
  memberName: string;
  name: string;
  remaining: number;
  expiresOn: string | null;
  itemIds: number[];
  ticketTypeIds: number[];
  targetNames: string[];
  /** 这次结账里能抵的份数（不算别的卡）；0 时 reason 写原因 */
  coverable: number;
  reason: string | null;
}

/** 卡种的一句话：「足疗 · 10 次 · ¥1,500 · 365 天」 */
export function countCardTermsText(t: { targetNames: string[]; uses: number; price: number; validDays: number | null }, yuan: (cents: number) => string) {
  return `${t.targetNames.join('、') || '（没有可抵的项目）'} · ${t.uses} 次 · ${yuan(t.price)} · ${t.validDays === null ? '长期有效' : `${t.validDays} 天`}`;
}

/** 日结里的次卡（v0.7.28）：售卡、退卡是收款与退款（按方式），结账使用是营业额里的「次卡」，过期作废不退钱 */
export interface CountCardDayTotals {
  sales: { count: number; amount: number; byMethod: { method: PaymentMethod; count: number; amount: number }[] };
  refunds: { count: number; amount: number; byMethod: { method: PaymentMethod; count: number; amount: number }[] };
  /** 结账使用（净额：当天用的 − 当天反结账退回的） */
  uses: { count: number; amount: number };
  expired: { cards: number; uses: number };
  opening: { cards: number; uses: number };
  /** 当天结束时还没用的次数（可用的卡） */
  outstanding: { cards: number; uses: number };
}
export const EMPTY_COUNT_CARD_TOTALS: CountCardDayTotals = {
  sales: { count: 0, amount: 0, byMethod: [] },
  refunds: { count: 0, amount: 0, byMethod: [] },
  uses: { count: 0, amount: 0 },
  expired: { cards: 0, uses: 0 },
  opening: { cards: 0, uses: 0 },
  outstanding: { cards: 0, uses: 0 },
};
