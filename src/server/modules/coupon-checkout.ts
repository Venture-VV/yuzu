// 结账用券（v0.7.20，docs/COUPONS.md 第 3 节）：手牌结账、桌台结账共用。
//   · 结账前核对：本次结账客人里的会员的可用券（能抵多少、不能用的原因），或输入的券码；
//   · 结账事务里：锁券一行（在账单、会员储值、赠金批次之后），核对状态、有效期、归属与门槛，按此刻的明细重新算抵扣，
//     与员工确认时看到的不一致时拒绝（COUPON_AMOUNT_CHANGED）；记「已用」与使用记录；收款明细记一笔券抵扣（券、适用的明细）；
//   · 反结账：用掉的券退回（过了有效期的退回后就是已过期）。
// 每张结账单最多 1 张券，不与优惠 / 免单同时用（frontdesk/checkout.ts splitPayments 核对）。

import { z } from 'zod';
import {
  couponTermsText,
  evaluateCoupon,
  formatStoreCouponCode,
  normalizeStoreCouponCode,
  STORE_COUPON_CODE_PATTERN,
  type CheckoutCouponOption,
  type CouponLine,
  type CouponTerms,
} from '@shared/coupons';
import { formatYuan } from '@shared/money';
import type { Db, Tx } from '../db';
import type { Deps } from '../lib/context';
import { conflict, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';

/** 账单上的有效明细，部门与部门营业额快照同一口径（门票、客房、其他、价目分类、未分类） */
export async function couponLines(db: Db, billIds: number[]): Promise<CouponLine[]> {
  if (billIds.length === 0) return [];
  return db<CouponLine[]>`
    SELECT l.id,
           CASE WHEN l.ticket_type_id IS NOT NULL THEN '门票'
                WHEN l.source = 'room' THEN '客房'
                WHEN l.item_id IS NULL THEN '其他（手动金额、赔偿等）'
                ELSE coalesce(nullif(si.category, ''), '未分类') END AS category,
           l.item_id, l.ticket_type_id, l.name, l.unit_price, l.quantity, l.amount,
           -- 派对房等的房费（v0.7.28）：营业日是周一至周四的，包房房费折扣也打（M44）
           (uc.line_id IS NOT NULL AND extract(isodow FROM l.business_date) BETWEEN 1 AND 4) AS party_room_day
    FROM bill_lines l LEFT JOIN service_items si ON si.id = l.item_id
    LEFT JOIN space_usage_charges uc ON uc.line_id = l.id AND uc.kind = 'fee'
    WHERE l.bill_id IN ${db(billIds)} AND l.status = 'active'
    ORDER BY l.id`;
}

interface CouponRowForCheckout extends CouponTerms {
  id: number;
  code: string;
  status: 'available' | 'used' | 'voided';
  memberId: number | null;
  memberName: string | null;
  validFrom: string;
  validTo: string;
  templateName: string;
  exchangeItemName: string | null;
  exchangeTicketName: string | null;
  checkoutNo: string | null;
}

const COUPON_FOR_CHECKOUT = (db: Db) => db`
  SELECT c.id, c.code, c.status, c.member_id, m.name AS member_name, c.valid_from, c.valid_to, t.name AS template_name,
         t.kind, t.face_value, t.rate_percent, t.max_off, t.threshold, t.scope, t.scope_categories, t.scope_items,
         t.exchange_item_id, t.exchange_ticket_type_id, xi.name AS exchange_item_name, xt.name AS exchange_ticket_name, ck.checkout_no
  FROM coupons c JOIN coupon_templates t ON t.id = c.template_id LEFT JOIN members m ON m.id = c.member_id
  LEFT JOIN service_items xi ON xi.id = t.exchange_item_id LEFT JOIN ticket_types xt ON xt.id = t.exchange_ticket_type_id
  LEFT JOIN checkouts ck ON ck.id = c.checkout_id`;

const termsOf = (r: CouponRowForCheckout): CouponTerms => ({
  kind: r.kind,
  faceValue: r.faceValue === null ? null : Number(r.faceValue),
  ratePercent: r.ratePercent,
  maxOff: r.maxOff === null ? null : Number(r.maxOff),
  threshold: Number(r.threshold),
  scope: r.scope,
  scopeCategories: r.scopeCategories,
  scopeItems: r.scopeItems.map(Number),
  exchangeItemId: r.exchangeItemId === null ? null : Number(r.exchangeItemId),
  exchangeTicketTypeId: r.exchangeTicketTypeId === null ? null : Number(r.exchangeTicketTypeId),
});
const summaryOf = (r: CouponRowForCheckout) =>
  couponTermsText(termsOf(r), {
    items: r.exchangeItemId !== null && r.exchangeItemName ? { [Number(r.exchangeItemId)]: r.exchangeItemName } : {},
    ticketTypes: r.exchangeTicketTypeId !== null && r.exchangeTicketName ? { [Number(r.exchangeTicketTypeId)]: r.exchangeTicketName } : {},
  });

/** 这张券在这次结账里能不能用、能抵多少（不加锁，结账前核对用；结账事务里由 redeemCoupon 再核对一遍） */
function judge(r: CouponRowForCheckout, ctx: { memberIds: number[]; lines: CouponLine[]; date: string }): { usable: boolean; amount: number; reason: string | null; lineIds: number[] } {
  const no = (reason: string) => ({ usable: false, amount: 0, reason, lineIds: [] });
  if (r.status === 'used') return no(`这张券已经用过了${r.checkoutNo ? `（结账单 ${r.checkoutNo}）` : ''}`);
  if (r.status === 'voided') return no('这张券已作废');
  if (ctx.date < r.validFrom) return no(`这张券 ${r.validFrom} 起才能用`);
  if (ctx.date > r.validTo) return no(`这张券已过期（有效期到 ${r.validTo}）`);
  if (r.memberId !== null && !ctx.memberIds.includes(r.memberId)) {
    return no(`这张券是会员「${r.memberName ?? ''}」的，只能在这位会员结账时用；同行朋友请合并到同一张结账单`);
  }
  const ev = evaluateCoupon(termsOf(r), ctx.lines);
  return ev.usable ? { usable: true, amount: ev.amount, reason: null, lineIds: ev.lineIds } : no(ev.reason);
}

const toOption = (r: CouponRowForCheckout, j: ReturnType<typeof judge>): CheckoutCouponOption => ({
  couponId: r.id,
  code: r.code,
  templateName: r.templateName,
  summary: summaryOf(r),
  memberId: r.memberId,
  memberName: r.memberName,
  validTo: r.validTo,
  usable: j.usable,
  amount: j.amount,
  reason: j.reason,
});

/** 结账前核对：这几位会员没用过、没过期的券，能用的排前面（能抵多的在前） */
export async function memberCouponOptions(db: Db, memberIds: number[], lines: CouponLine[], date: string): Promise<CheckoutCouponOption[]> {
  if (memberIds.length === 0) return [];
  const rows = await db<CouponRowForCheckout[]>`
    ${COUPON_FOR_CHECKOUT(db)}
    WHERE c.member_id IN ${db(memberIds)} AND c.status = 'available' AND c.valid_to >= ${date}
    ORDER BY c.valid_to, c.id LIMIT 100`;
  return rows
    .map((r) => toOption(r, judge(r, { memberIds, lines, date })))
    .sort((a, b) => Number(b.usable) - Number(a.usable) || b.amount - a.amount || a.validTo.localeCompare(b.validTo));
}

export const CouponCodeInput = z
  .string('请填写券码')
  .transform(normalizeStoreCouponCode)
  .pipe(z.string().regex(STORE_COUPON_CODE_PATTERN, '券码是 12 位字母数字（没有 0、O、1、I），请核对'));

/** 输入券码核对（结账前）：没有这张券时 found 为 false */
export async function couponByCode(db: Db, rawCode: string, memberIds: number[], lines: CouponLine[], date: string): Promise<CheckoutCouponOption | null> {
  const code = parse(CouponCodeInput, rawCode);
  const [r] = await db<CouponRowForCheckout[]>`${COUPON_FOR_CHECKOUT(db)} WHERE c.code = ${code}`;
  return r ? toOption(r, judge(r, { memberIds, lines, date })) : null;
}

/**
 * 结账事务里用券（账单已锁、会员储值已记账）：锁券一行，按此刻的明细重新核对与计算抵扣；
 * 与员工确认的金额不一致时拒绝。返回券、抵扣与适用的明细（收款明细与部门快照用）
 */
export async function redeemCoupon(
  tx: Tx,
  o: { code: string; expectedAmount: number; memberIds: number[]; billIds: number[]; checkoutId: number; date: string; at: Date; staffId: number },
): Promise<{ couponId: number; amount: number; lineIds: number[]; ref: string }> {
  const [r] = await tx<CouponRowForCheckout[]>`${COUPON_FOR_CHECKOUT(tx)} WHERE c.code = ${o.code} FOR UPDATE OF c`;
  if (!r) throw unprocessable('COUPON_NOT_FOUND', `没有券码 ${formatStoreCouponCode(o.code)} 这张券，请核对`);
  const lines = await couponLines(tx, o.billIds);
  const j = judge(r, { memberIds: o.memberIds, lines, date: o.date });
  if (!j.usable) {
    const code = r.status === 'used' ? 'COUPON_USED' : r.status === 'voided' ? 'COUPON_VOIDED' : 'COUPON_NOT_USABLE';
    throw (r.status === 'used' ? conflict : unprocessable)(code, j.reason ?? '这张券现在不能用', { code: o.code });
  }
  if (j.amount !== o.expectedAmount) {
    throw conflict('COUPON_AMOUNT_CHANGED', `这张券现在能抵 ${formatYuan(j.amount)}（账单明细有变化），请核对后重新确认`, { amount: j.amount });
  }
  await tx`UPDATE coupons SET status = 'used', checkout_id = ${o.checkoutId} WHERE id = ${r.id}`;
  await tx`
    INSERT INTO coupon_events (coupon_id, kind, checkout_id, amount, staff_id, at, business_date)
    VALUES (${r.id}, 'use', ${o.checkoutId}, ${j.amount}, ${o.staffId}, ${o.at}, ${o.date})`;
  return { couponId: r.id, amount: j.amount, lineIds: j.lineIds, ref: `${r.templateName}（${formatStoreCouponCode(r.code)}）`.slice(0, 64) };
}

/** 反结账：这张结账单用掉的券退回（只追加「退回」记录）；券已不在这张结账单上（不会发生）时跳过 */
export async function returnCheckoutCoupons(tx: Tx, o: { checkoutId: number; reason: string; date: string; at: Date; staffId: number }) {
  const pays = await tx<{ couponId: number; amount: number }[]>`
    SELECT store_coupon_id AS coupon_id, amount FROM checkout_payments WHERE checkout_id = ${o.checkoutId} AND method = 'store_coupon' ORDER BY store_coupon_id`;
  for (const p of pays) {
    const [c] = await tx<{ status: string; checkoutId: number | null }[]>`SELECT status, checkout_id FROM coupons WHERE id = ${p.couponId} FOR UPDATE`;
    if (c?.status !== 'used' || c.checkoutId !== o.checkoutId) continue;
    await tx`UPDATE coupons SET status = 'available', checkout_id = NULL WHERE id = ${p.couponId}`;
    await tx`
      INSERT INTO coupon_events (coupon_id, kind, checkout_id, amount, reason, staff_id, at, business_date)
      VALUES (${p.couponId}, 'return', ${o.checkoutId}, ${p.amount}, ${o.reason.slice(0, 200)}, ${o.staffId}, ${o.at}, ${o.date})`;
  }
}

/** 结账前核对用的明细：已挂的明细加上按此刻算出的门票（门票还没挂到账单，用负数编号代替） */
export function withTicketLines(lines: CouponLine[], tickets: { visitId: number; typeId: number; name: string; amount: number }[]): CouponLine[] {
  return [
    ...lines,
    ...tickets
      .filter((t) => t.amount > 0)
      .map((t) => ({ id: -t.visitId, category: '门票', itemId: null, ticketTypeId: t.typeId, name: t.name, unitPrice: t.amount, quantity: 1, amount: t.amount })),
  ];
}

export type { Deps };
