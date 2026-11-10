// 结账收款（S3.2–S3.3；店主 2026-10-27 #31 门票跳档、#32 结清才能离店、#34 团购券完整券码）。
//
//   · 单牌或同行合并结账：一张结账单结清所选手牌的账单，账单与来访一起结束，手牌释放；
//   · 门票：按每位客人选定的票种（接待时留存的票价）与在店时长计算，每 12 小时跳一档（宽限见前台规则），
//     结账时作为明细挂到账单（免票不挂明细，记在结账单上）；
//   · 收款：现金、微信、支付宝、银行卡、其他、会员储值、团购券、优惠 / 免单，可组合，合计必须等于应收；
//     「其他」必须填备注；「优惠 / 免单」最多一笔，须值班经理及以上当场授权（授权绑定这几张手牌与优惠金额，原因随授权填写），
//     不计入实收（R1.2，店主 2026-10-29 签认）；
//   · 会员储值：在结账的同一事务里生成标准消费单与余额流水（指向结账单），会员日结与自检原样适用；
//   · 团购券：记平台与完整券码，同一平台同一券码只能有一笔有效登记（数据库唯一约束兜底）；
//   · 员工确认时看到的应收合计与储值扣款构成，和服务端此刻计算的不一致时拒绝（门票跳档、改价、余额变化）；
//   · 同一操作编号只结一次；结果待确认时可查回或作废（与接待、挂账同一机制）；
//   · 反结账：作废结账单——储值消费按原单撤销、团购券登记作废、门票明细作废，账单与来访恢复为在店未结；
//     储值消费只能这样随结账单一起撤销，会员撤销接口拒绝单独撤销（CHECKOUT_LINKED）；
//     结账后超过「撤销时限」（默认 48 小时）只有店主可以反结账；恢复在店的客人，门票按第一次结账的时刻计算
//     （记在来访的 ticket_end_at，客人已离店、只是更正，不再随时间跳档）；
//   · 结账单、反结账记下经办人的班次（交班表按班次汇总）；开始处理时所在的班次在入账前已交班则整笔拒绝（见 shifts.ts）。
// 加锁顺序：经办人的班次（共享锁）→ 手牌（反结账）→ 同行组 → 来访 → 账单 → 会员（id 升序）→ 赠金批次；
// 交班只锁班次一行（排他）、不锁业务行，不会与这里成环。

import { z } from 'zod';
import {
  COUPON_CODE_PATTERN,
  COUPON_PLATFORM_LABELS,
  COUPON_PLATFORMS,
  isFreeTicket,
  normalizeCouponCode,
  priceTicket,
  ticketTierLabel,
  type CheckoutDetail,
  type CheckoutPreview,
  type CheckoutSummary,
  type CouponPlatform,
} from '@shared/checkout';
import { describeHours, PAYMENT_METHODS } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { cents, parse, positiveCents } from '../../lib/validate';
import { consumeDiscountGrant } from '../../auth/grants';
import { expireMemberBonus } from '../bonus';
import { loadSettings } from '../settings';
import { withSpendQuota } from '../spend-quota';
import { lockPaymentShift, lockRefundShift, openShiftOf, shiftDrawerLabel } from '../shifts';
import { consumeForCheckout, reverseForCheckout } from '../wallet';
import {
  assertOpen,
  businessDate,
  closeGroupIfEmpty,
  hashRequest,
  loadFrontdeskRules,
  lockGroups,
  lockVisits,
  nextDocNo,
  runIdempotent,
  saveKey,
  setTxTimeouts,
} from './common';
import { assertAfterVisits, assertNotReused, backfillDetail, BackfillInput, backfillMarkSql, normalizeMark, recordBackfill, resolveBackfill } from './backfill';
import { openSessionsOf, settleSessionsAtCheckout } from '../clockroom';
import { locateGone, locateSessionEnd } from '../locations';
import { closeUsagesOfVisits, openUsagesOf } from '../usages';
import { unservedDishesOf } from '../dining';
import { applyVisitTicket, resolveTicketType } from './tickets';
import { assertNoRefunds, listRefundsOf } from './refunds';
import { CouponCodeInput, couponLines, memberCouponOptions, redeemCoupon, returnCheckoutCoupons, withTicketLines } from '../coupon-checkout';
import { memberDiscountPreview, settleMemberDiscount, type MemberDiscountEntry } from '../member-discounts';
import { memberTicketExtensions } from '../ticket-extensions';
import { countCardOptions, redeemCountCards, returnCheckoutCountCards } from '../count-cards';
import { lockPlatformCode, redemptionOfCode } from '../platform-redemptions';
import { MAX_COUNT_CARD_USES, MAX_COUNT_CARDS_PER_CHECKOUT } from '@shared/count-cards';

// ───────────────────────── 输入 ─────────────────────────

const CashPayment = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: positiveCents('收款金额'),
  /** 收款备注，例如微信支付单号后几位 */
  ref: z.string().trim().max(64, '收款备注最多 64 字').default(''),
});
const WalletPayment = z.object({
  method: z.literal('wallet'),
  memberId: z.number().int().positive(),
  amount: positiveCents('储值支付金额'),
  /** 员工确认时看到的本金 / 赠金扣款构成 */
  expectedSplit: z.object({ principal: cents('扣本金'), bonus: cents('扣赠金') }, '缺少确认时的扣款构成，请重新核对'),
});
const CouponPayment = z.object({
  method: z.literal('coupon'),
  platform: z.enum(COUPON_PLATFORMS, '请选择团购平台'),
  code: z
    .string('请填写完整券码')
    .transform(normalizeCouponCode)
    .pipe(z.string().regex(COUPON_CODE_PATTERN, '请填写完整券码（6–64 位数字或字母）')),
  dealName: z.string().trim().max(48, '团购项目最多 48 字').default(''),
  amount: positiveCents('抵扣金额'),
});
/** 优惠 / 免单：值班经理及以上当场授权（授权编号）；原因随授权填写 */
const DiscountPayment = z.object({
  method: z.literal('discount'),
  amount: positiveCents('优惠金额'),
  grantId: z.uuid('优惠 / 免单需要值班经理、店总或店主当场授权'),
});
/** 券抵扣（v0.7.20）：会员的券或无记名券的券码；amount 是员工确认时看到的抵扣，与服务端此刻算的不一致时拒绝 */
const StoreCouponPayment = z.object({
  method: z.literal('store_coupon'),
  code: CouponCodeInput,
  amount: positiveCents('券抵扣'),
});
/**
 * 会员折扣（v0.7.25，docs/MEMBERSHIP_P3.md 第 2 节）：结账前核对给出的、省得最多的那一项；服务端在会员锁里按此刻的明细重新算，
 * 会员、权益、金额与员工确认时看到的不一致时拒绝。只有手牌结账能用
 */
const MemberDiscountPayment = z.object({
  method: z.literal('member_discount'),
  memberId: z.number().int().positive(),
  benefitId: z.number().int().positive(),
  amount: positiveCents('会员折扣'),
});
/**
 * 次卡（v0.7.28）：这位会员的哪张卡、抵几次；amount 是员工确认时看到的（按明细的价钱，一次一份），服务端按此刻的明细重新分配，
 * 不一致时拒绝。只有手牌结账能用；不和券、会员折扣、优惠 / 免单同时用
 */
const CountCardPayment = z.object({
  method: z.literal('count_card'),
  cardId: z.number().int().positive(),
  uses: z.number('次数要是整数').int('次数要是整数').min(1, '至少抵 1 次').max(MAX_COUNT_CARD_USES, `一次最多抵 ${MAX_COUNT_CARD_USES} 次`),
  amount: positiveCents('次卡抵扣'),
});
export const Payment = z.union([CashPayment, WalletPayment, CouponPayment, DiscountPayment, StoreCouponPayment, MemberDiscountPayment, CountCardPayment], '收款方式不正确');

export const CheckoutInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  visitIds: z.array(z.number().int().positive()).min(1, '请选择要结账的手牌').max(30, '一次最多合并 30 张手牌'),
  /** 还没有选票种的客人（Batch 3 之前开的牌）在结账时补选 */
  tickets: z.array(z.object({ visitId: z.number().int().positive(), ticketTypeId: z.number().int().positive() })).max(30).default([]),
  /** 员工确认时看到的应收合计（含门票）；与服务端此刻计算的不一致时拒绝 */
  expectedTotal: cents('应收合计'),
  payments: z.array(Payment).max(10, '收款最多 10 笔').default([]),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
  /** 按实际时间补录纸质单（R1.9）：纸质单号与实际时间，门票按实际离店时间计算；平时不带 */
  backfill: BackfillInput,
});
export type CheckoutInputData = z.input<typeof CheckoutInput>;

export const VoidCheckoutInput = z.object({
  reason: z.string().trim().min(2, '请填写反结账原因（至少 2 个字）').max(200, '原因最多 200 字'),
  /** 跨钱箱退款（v0.7.1）：退款记到这个班次（所选钱箱当班的班次）；不带时记到反结账人自己的班次（原来的做法） */
  refundShiftId: z.number('钱箱班次不正确').int('钱箱班次不正确').positive('钱箱班次不正确').nullish().transform((v) => v ?? undefined),
});

// ───────────────────────── 结账前核对 ─────────────────────────

interface VisitRow {
  id: number;
  visitNo: string;
  billId: number;
  billNo: string;
  billStatus: string;
  tagCode: string;
  zone: CheckoutPreview['visits'][number]['zone'];
  memberId: number | null;
  memberName: string | null;
  guestLabel: string;
  checkedInAt: string;
  groupId: number | null;
  status: string;
  linesAmount: number;
  ticketTypeId: number | null;
  ticketName: string | null;
  price12h: number | null;
  price24h: number | null;
  /** 反结账后重结：门票计到第一次结账的时刻 */
  ticketEndAt: string | null;
}

async function loadVisitRows(db: Db, ids: number[]): Promise<VisitRow[]> {
  return db<VisitRow[]>`
    SELECT v.id, v.visit_no, v.bill_id, b.bill_no, b.status AS bill_status, t.code AS tag_code, v.zone, v.member_id,
           m.name AS member_name, v.guest_label, v.checked_in_at, v.group_id, v.status, b.amount_cents AS lines_amount,
           v.ticket_type_id, tt.name AS ticket_name, v.ticket_price_12h AS price12h, v.ticket_price_24h AS price24h, v.ticket_end_at
    FROM visits v JOIN bills b ON b.id = v.bill_id JOIN hand_tags t ON t.id = v.tag_id
    LEFT JOIN members m ON m.id = v.member_id LEFT JOIN ticket_types tt ON tt.id = v.ticket_type_id
    WHERE v.id IN ${db(ids)} ORDER BY t.code`;
}

/** 结账前核对：所选手牌的已挂明细与按此刻计算的门票（只读） */
export async function previewCheckout(deps: Deps, visitIds: number[], at = new Date()): Promise<CheckoutPreview> {
  const ids = [...new Set(visitIds)];
  if (ids.length === 0) throw badRequest('请选择要结账的手牌');
  // 会员到期的赠金先作废，员工核对的余额与入账时一致
  const memberIds = await deps.sql<{ memberId: number }[]>`SELECT DISTINCT member_id FROM visits WHERE id IN ${deps.sql(ids)} AND member_id IS NOT NULL`;
  for (const m of memberIds) await expireMemberBonus(deps, m.memberId, at);
  return deps.sql.begin('isolation level repeatable read read only', async (tx) => {
    const rules = await loadFrontdeskRules(tx);
    const rows = await loadVisitRows(tx, ids);
    if (rows.length !== ids.length) throw notFound('有手牌的来访记录不存在，请刷新后重试');
    const closed = rows.find((v) => v.status !== 'open');
    if (closed) throw conflict('VISIT_CLOSED', `手牌 ${closed.tagCode} 已不在店，请刷新后重新选择`);
    // 补录接待的客人：手牌之后又发给了别人时，先提示按纸质单补录结账时间（与结账时同一核对）
    await assertNotReused(tx, at, ids, deps.config.timezone);
    const lines = await tx<{ id: number; billId: number; name: string; quantity: number; amount: number }[]>`
      SELECT id, bill_id, name, quantity, amount FROM bill_lines
      WHERE status = 'active' AND bill_id IN ${tx(rows.map((r) => r.billId))} ORDER BY id`;
    const date = await businessDate(tx, deps, at);
    const memberRows = rows.some((r) => r.memberId)
      ? await tx<Omit<CheckoutPreview['members'][number], 'spendQuota'>[]>`
          SELECT id, name, member_no, status, principal_balance, bonus_balance FROM members
          WHERE id IN ${tx(rows.flatMap((r) => (r.memberId ? [r.memberId] : [])))} ORDER BY id`
      : [];
    // 充值当日的储值额度（8.0.4 需求表 04）：选储值支付时页面显示剩余额度、超了先拦
    const members = await withSpendQuota(tx, memberRows, date, (await loadSettings(tx)).rechargeSpendPct);
    // 浴票延迟（v0.7.25 续）：会员的门票在跳档宽限之上多给几分钟（按此刻推算的档阶，与结账时同一算法）
    const extensions = await memberTicketExtensions(tx, rows.map((r) => r.memberId), date);
    const visits = rows.map((r) => {
      const extension = r.memberId ? (extensions.get(Number(r.memberId)) ?? null) : null;
      const graceMinutes = rules.overtimeGraceMinutes + (extension?.minutes ?? 0);
      const t = r.ticketTypeId !== null ? priceTicket({ price12h: r.price12h!, price24h: r.price24h! }, r.checkedInAt, ticketEnd(r, at), graceMinutes) : null;
      return {
        visitId: r.id,
        visitNo: r.visitNo,
        billId: r.billId,
        tagCode: r.tagCode,
        zone: r.zone,
        memberId: r.memberId,
        memberName: r.memberName,
        guestLabel: r.guestLabel,
        checkedInAt: r.checkedInAt,
        groupId: r.groupId,
        linesAmount: r.linesAmount,
        lines: lines.filter((l) => l.billId === r.billId).map(({ billId: _b, ...l }) => l),
        ticket: t
          ? {
              typeId: r.ticketTypeId!,
              name: r.ticketName!,
              segments: t.segments,
              tierLabel: ticketTierLabel(t.segments),
              amount: t.amount,
              stayMinutes: t.stayMinutes,
              nextJumpAt: t.nextJumpAt,
              nextAmount: t.nextAmount,
              endAt: r.ticketEndAt ? new Date(r.ticketEndAt).toISOString() : null,
            }
          : null,
        graceMinutes,
        extension,
        needsTicket: r.ticketTypeId === null,
        amount: r.linesAmount + (t?.amount ?? 0),
      };
    });
    // 会员的券（v0.7.20）：按已挂的明细加上此刻的门票算能抵多少
    const memberIds = members.map((m) => m.id);
    const couponBase = withTicketLines(
      await couponLines(tx, rows.map((r) => r.billId)),
      visits.flatMap((v) => (v.ticket ? [{ visitId: v.visitId, typeId: v.ticket.typeId, name: v.ticket.name, amount: v.ticket.amount }] : [])),
    );
    const storeCoupons = await memberCouponOptions(tx, memberIds, couponBase, date);
    // 次卡（v0.7.28）：与券同一套明细（已挂的明细 + 此刻的门票）
    const countCards = await countCardOptions(tx, memberIds, couponBase, date);
    // 会员折扣（v0.7.25）：按会员本人账单上的明细加上此刻的门票算，省得最多的在前（没选券、优惠时第一项要带上）
    const memberDiscounts = await memberDiscountPreview(
      tx,
      visits.flatMap((v) =>
        v.memberId
          ? [
              {
                visitId: v.visitId,
                billId: v.billId,
                memberId: v.memberId,
                memberName: v.memberName ?? '',
                tagCode: v.tagCode,
                ticket: v.ticket ? withTicketLines([], [{ visitId: v.visitId, typeId: v.ticket.typeId, name: v.ticket.name, amount: v.ticket.amount }])[0] ?? null : null,
              },
            ]
          : [],
      ),
      date,
      // 同行优惠（v0.7.26，QY-041）：这张结账单里不是会员的客人
      visits.flatMap((v) =>
        v.memberId
          ? []
          : [
              {
                billId: v.billId,
                tagCode: v.tagCode,
                ticket: v.ticket ? withTicketLines([], [{ visitId: v.visitId, typeId: v.ticket.typeId, name: v.ticket.name, amount: v.ticket.amount }])[0] ?? null : null,
              },
            ],
      ),
    );
    return {
      visits,
      totalAmount: visits.reduce((s, v) => s + v.amount, 0),
      members,
      storeCoupons,
      memberDiscounts,
      countCards,
      countCardLines: couponBase.map(({ id, itemId, ticketTypeId, name, unitPrice, quantity, amount }) => ({ id, itemId, ticketTypeId, name, unitPrice, quantity, amount })),
      graceMinutes: rules.overtimeGraceMinutes,
      pricedAt: at.toISOString(),
      sessions: await openSessionsOf(tx, ids),
      dishes: await unservedDishesOf(tx, ids),
      rooms: await openRoomsOf(tx, ids),
      usages: await openUsagesOf(tx, ids, at),
    };
  });
}

/** 这几位客人还在住的客房（S7）：结账前要先退房（补齐房费挂到手牌账单、退押金） */
async function openRoomsOf(db: Db, visitIds: number[]) {
  return db<{ stayId: number; tagCode: string; roomNo: string; stayNo: string }[]>`
    SELECT s.id AS stay_id, ht.code AS tag_code, r.room_no, s.stay_no
    FROM room_stays s JOIN rooms r ON r.id = s.room_id JOIN visits v ON v.id = s.visit_id JOIN hand_tags ht ON ht.id = v.tag_id
    WHERE s.visit_id IN ${db(visitIds)} AND s.status = 'open' ORDER BY ht.code, r.room_no`;
}

/** 门票计到的时刻：反结账后重结按第一次结账的时刻，平时按此刻 */
const ticketEnd = (r: Pick<VisitRow, 'ticketEndAt'>, at: Date) => (r.ticketEndAt ? new Date(r.ticketEndAt) : at);

// ───────────────────────── 结账 ─────────────────────────

export type CheckoutPaymentInput = z.infer<typeof Payment>;

/** 收款的基本核对（手牌结账与桌台结账共用）：优惠最多一笔、「其他」要备注、储值要有权限、同一会员与同一张券不重复 */
export function splitPayments(payments: CheckoutPaymentInput[], actor: OpContext['actor']) {
  const wallets = payments.filter((p) => p.method === 'wallet');
  const coupons = payments.filter((p) => p.method === 'coupon');
  const discounts = payments.filter((p) => p.method === 'discount');
  const storeCoupons = payments.filter((p) => p.method === 'store_coupon');
  const memberDiscounts = payments.filter((p) => p.method === 'member_discount');
  const countCards = payments.filter((p) => p.method === 'count_card');
  if (discounts.length > 1) throw badRequest('优惠 / 免单最多登记一笔，请合并金额后重新授权');
  // 券（v0.7.20）：每张结账单最多 1 张，不与优惠 / 免单同时用
  if (storeCoupons.length > 1) throw badRequest('每张结账单最多用 1 张券');
  if (storeCoupons.length && discounts.length) throw badRequest('券不能和优惠 / 免单同时用，请二选一');
  // 会员折扣（v0.7.25，M13）：一张结账单只享一种，不与券、优惠 / 免单同用
  if (memberDiscounts.length > 1) throw badRequest('一张结账单只享一种会员折扣');
  if (memberDiscounts.length && (storeCoupons.length || discounts.length)) throw badRequest('会员折扣不能和券、优惠 / 免单同时用，请二选一');
  // 次卡（v0.7.28，N5）：一张结账单最多几张卡、同一张卡合并成一笔；不和券、会员折扣、优惠 / 免单同时用（与它们之间一样二选一）
  if (countCards.length > MAX_COUNT_CARDS_PER_CHECKOUT) throw badRequest(`一张结账单最多用 ${MAX_COUNT_CARDS_PER_CHECKOUT} 张次卡`);
  if (new Set(countCards.map((c) => c.cardId)).size !== countCards.length) throw badRequest('同一张次卡请合并为一笔（抵几次写在一起）');
  if (countCards.length && (storeCoupons.length || discounts.length || memberDiscounts.length)) throw badRequest('次卡不能和券、会员折扣、优惠 / 免单同时用，请二选一');
  if (payments.some((p) => p.method === 'other' && !p.ref)) throw badRequest('「其他」收款请在备注里写明收的是什么');
  if (wallets.length && !can(actor, 'consume.create')) throw forbidden('当前岗位不能用会员储值收款');
  if (new Set(wallets.map((w) => w.memberId)).size !== wallets.length) throw badRequest('同一位会员的储值支付请合并为一笔');
  if (new Set(coupons.map((c) => `${c.platform}:${c.code}`)).size !== coupons.length) throw badRequest('同一张团购券不能登记两次');
  return { wallets, coupons, discounts, storeCoupons, memberDiscounts, countCards };
}

/** 收款合计必须等于应收（手牌结账与桌台结账共用） */
export function assertSettled(payments: CheckoutPaymentInput[], total: number) {
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  if (paid !== total) {
    throw unprocessable(
      'NOT_SETTLED',
      paid < total
        ? `还差 ${formatYuan(total - paid)} 没有收，结清才能离店`
        : `收款合计多了 ${formatYuan(paid - total)}，请核对（现金找零不用登记，按应收金额记）`,
      { total, paid },
    );
  }
  return paid;
}


/**
 * 部门营业额快照（v0.7.6）：记好收款（含优惠 / 免单）之后调用，按这次要结的有效明细记下各部门、各项目的数量与金额，
 * 优惠按金额比例分摊到各项（数据库函数 yuzu_snapshot_checkout_items，升级时也用它给已有的结账单补记）。手牌、桌台结账共用。
 * 补录到更早时刻的结账也按这一刻的有效明细记：之后才转走、作废的明细不算进来，与结账金额一致
 */
export async function snapshotCheckoutItems(tx: Tx, checkoutId: number) {
  await tx`SELECT yuzu_snapshot_checkout_items(${checkoutId}, true)`;
}
/**
 * 登记这张结账单的收款（手牌结账与桌台结账共用）：会员储值按会员 id 升序逐位记账（同一事务里生成消费单与余额流水），
 * 团购券（同一平台同一券码只能有一笔有效登记）、现金类、优惠 / 免单（已核销的当场授权）。
 */
export async function recordCheckoutPayments(
  tx: Tx,
  deps: Deps,
  a: {
    checkoutId: number;
    checkoutNo: string;
    payments: CheckoutPaymentInput[];
    discount: { reason: string; approverId: number } | null;
    /** 储值消费单备注里的手牌号；桌台结账时为桌号（tables） */
    tagCodes: string[];
    tables?: string[];
    /** 这次结的账单（券按这些账单上的明细算抵扣）与客人里的会员（会员的券只能用在自己结账时） */
    billIds: number[];
    memberIds: number[];
    date: string;
    at: Date;
    ctx: OpContext;
    /** 会员折扣（v0.7.25，手牌结账在会员锁里核对过的）；桌台结账没有 */
    memberDiscount?: MemberDiscountEntry | null;
  },
) {
  const wallets = a.payments.filter((p) => p.method === 'wallet');
  const coupons = a.payments.filter((p) => p.method === 'coupon');
  const discounts = a.payments.filter((p) => p.method === 'discount');
  // 会员储值：按会员 id 升序逐位记账（锁顺序固定）
  for (const w of [...wallets].sort((x, y) => x.memberId - y.memberId)) {
    const r = await consumeForCheckout(tx, deps, {
      memberId: w.memberId,
      amount: w.amount,
      expectedSplit: w.expectedSplit,
      checkoutId: a.checkoutId,
      checkoutNo: a.checkoutNo,
      tagCodes: a.tagCodes,
      tables: a.tables,
      businessDate: a.date,
      ctx: a.ctx,
      at: a.at,
    });
    await tx`
      INSERT INTO checkout_payments (checkout_id, method, amount, member_id, consumption_id)
      VALUES (${a.checkoutId}, 'wallet', ${w.amount}, ${w.memberId}, ${r.consumptionId})`;
  }
  // 团购券：同一平台同一券码只能有一笔有效登记；也不能是已在平台核销补登记过的（v0.7.28，先取「平台 + 券码」的咨询锁，与补登记串行）
  for (const cp of coupons) {
    await lockPlatformCode(tx, cp.platform, cp.code);
    const registered = await redemptionOfCode(tx, cp.platform, cp.code);
    if (registered) {
      throw conflict('COUPON_USED', `${COUPON_PLATFORM_LABELS[cp.platform]}券码 ${cp.code} 已在平台核销补登记过（${registered}），同一张券不能重复使用`, { platform: cp.platform, code: cp.code });
    }
    const [used] = await tx<{ checkoutNo: string; registeredAt: string }[]>`
      SELECT c.checkout_no, g.registered_at FROM group_buy_coupons g JOIN checkouts c ON c.id = g.checkout_id
      WHERE g.platform = ${cp.platform} AND g.code = ${cp.code} AND g.status = 'active'`;
    if (used) throw couponUsed(cp.platform, cp.code, used.checkoutNo);
    const [g] = await tx<{ id: number }[]>`
      INSERT INTO group_buy_coupons (platform, code, deal_name, amount, checkout_id, business_date, registered_by, registered_at)
      VALUES (${cp.platform}, ${cp.code}, ${cp.dealName}, ${cp.amount}, ${a.checkoutId}, ${a.date}, ${a.ctx.actor.id}, ${a.at})
      RETURNING id`;
    await tx`
      INSERT INTO checkout_payments (checkout_id, method, amount, ref, coupon_id)
      VALUES (${a.checkoutId}, 'coupon', ${cp.amount}, ${cp.dealName}, ${g!.id})`;
  }
  // 券抵扣（v0.7.20）：在会员储值、赠金批次之后锁券一行，按此刻的明细核对抵扣；记下适用的明细（部门快照按它们分摊）
  for (const sc of a.payments.filter((p) => p.method === 'store_coupon')) {
    const r = await redeemCoupon(tx, {
      code: sc.code,
      expectedAmount: sc.amount,
      memberIds: a.memberIds,
      billIds: a.billIds,
      checkoutId: a.checkoutId,
      date: a.date,
      at: a.at,
      staffId: a.ctx.actor.id,
    });
    await tx`
      INSERT INTO checkout_payments (checkout_id, method, amount, ref, store_coupon_id, coupon_lines)
      VALUES (${a.checkoutId}, 'store_coupon', ${r.amount}, ${r.ref}, ${r.couponId}, ${r.lineIds}::bigint[])`;
  }
  // 次卡（v0.7.28）：在券之后按卡的 id 升序锁卡，按此刻的明细（门票已挂到账单）重新分配；会员的预付消费，与储值一样不分摊到部门快照
  const countCardPays = a.payments.filter((p) => p.method === 'count_card');
  if (countCardPays.length) {
    const used = await redeemCountCards(tx, {
      payments: countCardPays.map((p) => ({ cardId: p.cardId, uses: p.uses, amount: p.amount })),
      memberIds: a.memberIds,
      lines: await couponLines(tx, a.billIds),
      checkoutId: a.checkoutId,
      date: a.date,
      at: a.at,
      staffId: a.ctx.actor.id,
    });
    for (const u of used) {
      await tx`
        INSERT INTO checkout_payments (checkout_id, method, amount, ref, count_card_id, count_card_uses)
        VALUES (${a.checkoutId}, 'count_card', ${u.amount}, ${u.ref}, ${u.cardId}, ${u.uses})`;
    }
  }
  // 会员折扣（v0.7.25）：优惠、不是收款；记会员、权益与版本、折扣、适用明细（部门快照按这些明细分摊）
  if (a.memberDiscount) {
    const d = a.memberDiscount;
    await tx`
      INSERT INTO checkout_payments (checkout_id, method, amount, ref, discount_member_id, benefit_id, benefit_version, discount_rate, coupon_lines)
      VALUES (${a.checkoutId}, 'member_discount', ${d.amount}, ${d.ref}, ${d.memberId}, ${d.benefitId}, ${d.version}, ${d.rate}, ${d.lineIds}::bigint[])`;
  }
  for (const p of a.payments) {
    if (p.method === 'wallet' || p.method === 'coupon' || p.method === 'discount' || p.method === 'store_coupon' || p.method === 'member_discount' || p.method === 'count_card') continue;
    await tx`
      INSERT INTO checkout_payments (checkout_id, method, amount, ref)
      VALUES (${a.checkoutId}, ${p.method}, ${p.amount}, ${p.ref})`;
  }
  if (a.discount && discounts[0]) {
    await tx`
      INSERT INTO checkout_payments (checkout_id, method, amount, ref, approved_by, grant_id)
      VALUES (${a.checkoutId}, 'discount', ${discounts[0].amount}, ${a.discount.reason}, ${a.discount.approverId}, ${discounts[0].grantId})`;
  }
}

export async function checkout(deps: Deps, raw: CheckoutInputData, ctx: OpContext): Promise<CheckoutDetail> {
  const input = parse(CheckoutInput, raw);
  const ids = [...new Set(input.visitIds)];
  if (ids.length !== input.visitIds.length) throw badRequest('同一张手牌不能重复结账');
  const { wallets, discounts, storeCoupons, memberDiscounts, countCards } = splitPayments(input.payments, ctx.actor);
  for (const t of input.tickets) if (!ids.includes(t.visitId)) throw badRequest('补选票种的客人不在本次结账里');
  // 补录纸质单：按纸质单上的实际离店时间结账；储值流水按发生顺序连续记账，不能插到过去，补录的结账不能用储值
  const backfill = resolveBackfill(input.backfill, ctx.actor);
  if (backfill && wallets.length) {
    throw unprocessable('BACKFILL_NO_WALLET', '补录的结账不能用会员储值（储值流水不能补记到过去）；请按纸质单上的实际收款方式登记，储值支付的单请联系店主处理');
  }

  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  // 收款开始处理时经办人所在的班次：入账前这个班次已交班则整笔拒绝（见 shifts.ts lockPaymentShift）
  const seenShift = await openShiftOf(deps.sql, ctx.actor.id);
  // 会员到期的赠金先单独作废并提交（与会员消费一致），入账时核对的余额不含到期赠金
  for (const w of wallets) await expireMemberBonus(deps, w.memberId, ctx.at ?? new Date());

  const run = await runIdempotent(deps, { key, opType: 'checkout', requestHash }, async (tx) => {
    // ① 先对班次加共享锁，再锁手牌、来访、账单：交班等这笔提交后再汇总，这笔记入本班次（结账单除反结账外不可改）
    const shiftId = await lockPaymentShift(tx, ctx.actor.id, seenShift);
    const at = backfill?.at ?? ctx.at ?? new Date();
    const rules = await loadFrontdeskRules(tx);
    // ② 同行组 → ③ 来访 → 账单；加锁后核对同行组没有被其他终端改过
    const peek = await tx<{ id: number; groupId: number | null }[]>`SELECT id, group_id FROM visits WHERE id IN ${tx(ids)}`;
    if (peek.length !== ids.length) throw notFound('有手牌的来访记录不存在，请刷新后重试');
    await lockGroups(tx, peek.map((p) => p.groupId));
    const locked = await lockVisits(tx, ids);
    for (const p of peek) {
      const v = locked.get(p.id)!;
      assertOpen(v);
      if (v.groupId !== p.groupId) throw conflict('VISIT_CHANGED', '同行组刚刚有变化，请刷新后重试');
    }
    // 客房（S7）：还住着客房的先退房（补齐房费、退押金）；客房入住、退房也先锁这位客人的来访，两边不会交错
    const [room] = await openRoomsOf(tx, ids);
    if (room) throw conflict('ROOM_OPEN', `手牌 ${room.tagCode} 还住着客房 ${room.roomNo}，请先退房（补齐房费、退押金），再结账`);
    // 储值只能由本次结账的客人里的会员支付，不能扣不在这张结账单上的会员（串单）；会员替朋友付，把朋友的手牌合并进来一起结
    const guests = new Set([...locked.values()].map((v) => v.memberId));
    const outsider = wallets.find((w) => !guests.has(w.memberId));
    if (outsider) {
      throw unprocessable('WALLET_MEMBER_NOT_IN_CHECKOUT', '只能用本次结账客人里的会员储值支付；同行朋友请合并到同一张结账单', {
        memberId: outsider.memberId,
      });
    }
    const billIds = [...locked.values()].map((v) => v.billId).sort((a, b) => a - b);
    await tx`SELECT id FROM bills WHERE id IN ${tx(billIds)} ORDER BY id FOR UPDATE`;
    // 补录：实际离店时间不能早于这几位客人的接待和已挂的明细；补录接待的客人，在店时段里手牌、会员不能已有别的来访
    if (backfill) await assertAfterVisits(tx, at, ids, 'checkout', deps.config.timezone);
    await assertNotReused(tx, at, ids, deps.config.timezone);
    // 钟房（v0.7.1，账单之后、会员之前加锁）：还没结束的钟单一起收尾，在钟上的按结账时刻下钟
    const endedSessions = await settleSessionsAtCheckout(tx, deps, ids, ctx.actor, at);

    // 补选票种（来访已锁）；免票要当场授权，请先在手牌详情里改票种并授权
    for (const t of input.tickets) {
      const [cur] = await tx<{ ticketTypeId: number | null }[]>`SELECT ticket_type_id FROM visits WHERE id = ${t.visitId}`;
      if (cur!.ticketTypeId === t.ticketTypeId) continue;
      if (cur!.ticketTypeId !== null) throw conflict('TICKET_CHANGED', '这位客人的票种刚刚已选定，请刷新后重新核对');
      const type = (await resolveTicketType(tx, t.ticketTypeId))!;
      if (isFreeTicket(type)) {
        throw unprocessable('TICKET_AUTH_REQUIRED', `「${type.name}」是免票，需要当场授权：请先在手牌详情里改票种并请值班经理授权，再结账`);
      }
      await applyVisitTicket(tx, t.visitId, null, type, ctx.actor.id, at);
    }
    const rows = await loadVisitRows(tx, ids);
    const missing = rows.filter((r) => r.ticketTypeId === null);
    if (missing.length) {
      throw unprocessable('TICKET_REQUIRED', `手牌 ${missing.map((r) => r.tagCode).join('、')} 还没有选票种，请先选择票种再结账`, {
        tagCodes: missing.map((r) => r.tagCode),
      });
    }
    const date = await businessDate(tx, deps, at);
    // 浴票延迟（v0.7.25 续）：会员此刻的档阶多给几分钟不跳档（只读、不加锁；会员一行仍在下面的会员折扣里按 id 升序锁）
    const extensions = await memberTicketExtensions(tx, rows.map((r) => r.memberId), date);
    const priced = rows.map((r) => {
      const extension = r.memberId ? (extensions.get(Number(r.memberId)) ?? null) : null;
      const t = priceTicket({ price12h: r.price12h!, price24h: r.price24h! }, r.checkedInAt, ticketEnd(r, at), rules.overtimeGraceMinutes + (extension?.minutes ?? 0));
      return { ...r, ticket: t, extension, amount: r.linesAmount + t.amount };
    });
    const total = priced.reduce((s, r) => s + r.amount, 0);
    if (total !== input.expectedTotal) {
      throw conflict('PRICE_CHANGED', `应收合计刚刚变为 ${formatYuan(total)}（门票可能刚刚跳档，或账单明细有变化），请核对后重新确认`, {
        total,
        tickets: priced.map((r) => ({ tagCode: r.tagCode, segments: r.ticket.segments, amount: r.ticket.amount })),
      });
    }
    const paid = assertSettled(input.payments, total);

    // 优惠 / 免单：核销值班经理及以上的当场授权（这几张手牌、这个金额；业务回滚时核销一起回滚）
    const discount = discounts[0]
      ? await consumeDiscountGrant(tx, { grantId: discounts[0].grantId, actor: ctx.actor, visitIds: ids, amount: discounts[0].amount, usedRef: `checkout:${key}` })
      : null;

    const checkoutNo = await nextDocNo(tx, 'checkout', 'JZ', date);
    const [c] = await tx<{ id: number }[]>`
      INSERT INTO checkouts (checkout_no, client_key, total_amount, paid_amount, note, business_date, operator_id, created_at, shift_id)
      VALUES (${checkoutNo}, ${key}, ${total}, ${paid}, ${input.note}, ${date}, ${ctx.actor.id}, ${at}, ${shiftId})
      RETURNING id`;
    const checkoutId = c!.id;

    // 门票作为明细挂到账单（免票不挂），与本次结账共用操作编号
    for (const r of priced) {
      if (r.ticket.amount > 0) {
        const name = `门票 · ${r.ticketName}（${ticketTierLabel(r.ticket.segments)}）`.slice(0, 48);
        await tx`
          INSERT INTO bill_lines (bill_id, source, item_id, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at,
                                  ticket_type_id, ticket_segments)
          VALUES (${r.billId}, 'bath', NULL, ${name}, ${r.ticket.amount}, 1, ${r.ticket.amount}, ${key}, ${date}, ${ctx.actor.id}, ${at},
                  ${r.ticketTypeId}, ${r.ticket.segments})`;
        await tx`UPDATE bills SET amount_cents = amount_cents + ${r.ticket.amount}, line_count = line_count + 1 WHERE id = ${r.billId}`;
      }
      await tx`
        INSERT INTO checkout_bills (checkout_id, bill_id, visit_id, amount, stay_minutes, ticket_type_id, ticket_name, ticket_segments, ticket_amount,
                                    ticket_extension_minutes, ticket_extension_benefit_id)
        VALUES (${checkoutId}, ${r.billId}, ${r.id}, ${r.amount}, ${r.ticket.stayMinutes}, ${r.ticketTypeId}, ${r.ticketName}, ${r.ticket.segments},
                ${r.ticket.amount}, ${r.extension?.minutes ?? 0}, ${r.extension?.benefitId ?? null})`;
    }

    const tagCodes = priced.map((r) => r.tagCode);
    const memberIds = [...guests].filter((m): m is number => m !== null);
    // 会员折扣（v0.7.25）：门票已挂到账单；在会员一行锁里（id 升序，储值随后锁同样的行）处理完到期再按此刻的明细核对（M45：必须带上省得最多的一种）
    const md = memberDiscounts[0];
    const memberDiscount = await settleMemberDiscount(tx, {
      guests: priced.flatMap((r) => (r.memberId ? [{ memberId: Number(r.memberId), memberName: r.memberName ?? '', tagCode: r.tagCode, billId: r.billId }] : [])),
      companions: priced.flatMap((r) => (r.memberId ? [] : [{ tagCode: r.tagCode, billId: r.billId }])),
      input: md ? { memberId: md.memberId, benefitId: md.benefitId, amount: md.amount } : null,
      // 用了次卡（v0.7.28）也不打会员折扣：与券、优惠 / 免单一样二选一
      otherReduction: storeCoupons.length > 0 || discounts.length > 0 || countCards.length > 0,
      date,
    });
    await recordCheckoutPayments(tx, deps, { checkoutId, checkoutNo, payments: input.payments, discount, tagCodes, billIds, memberIds, date, at, ctx, memberDiscount });
    await snapshotCheckoutItems(tx, checkoutId);

    // 结清：账单与来访结束，手牌释放；同行组没有在店客人时关闭
    await tx`UPDATE bills SET status = 'settled', closed_at = ${at} WHERE id IN ${tx(billIds)}`;
    await tx`UPDATE visits SET status = 'settled', closed_at = ${at}, closed_by = ${ctx.actor.id} WHERE id IN ${tx(ids)}`;
    for (const g of new Set(priced.map((r) => r.groupId))) await closeGroupIfEmpty(tx, g, at);
    // 派对房等的使用单（v0.7.19）：使用人结账时一起结束（在结账已有的锁之后，按 id 升序锁）
    const usages = await closeUsagesOfVisits(tx, ids, 'checkout', { at, staffId: ctx.actor.id });
    // 实时位置（v0.7.17）：客人离店、当前位置清掉；结账时一起下钟的技师回休息区（先客人、再技师，按固定顺序锁当前位置）
    await locateGone(tx, ids, 'checkout', { type: 'checkout', id: checkoutId }, { at, staffId: ctx.actor.id });
    await locateSessionEnd(tx, endedSessions, { at, staffId: ctx.actor.id });

    if (backfill) await recordBackfill(tx, backfill, { kind: 'checkout', opKey: key, checkoutId, businessDate: date, actor: ctx.actor });
    await saveKey(tx, key, 'checkout', requestHash, checkoutId, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_checkout',
      targetType: 'checkout',
      targetId: checkoutId,
      detail: {
        docNo: checkoutNo,
        tags: tagCodes,
        total,
        payments: input.payments.map((p) => ({ method: p.method, amount: p.amount })),
        tickets: priced.map((r) => ({
          tagCode: r.tagCode,
          ticket: r.ticketName,
          segments: r.ticket.segments,
          amount: r.ticket.amount,
          ...(r.extension ? { extension: { minutes: r.extension.minutes, benefitId: r.extension.benefitId, version: r.extension.version } } : {}),
        })),
        ...(discount ? { discount: { amount: discounts[0]!.amount, reason: discount.reason, approverId: discount.approverId, approverName: discount.approverName } } : {}),
        ...(memberDiscount ? { memberDiscount: { memberId: memberDiscount.memberId, benefitId: memberDiscount.benefitId, rate: memberDiscount.rate, amount: memberDiscount.amount } } : {}),
        ...(usages.length ? { usages } : {}),
        ...backfillDetail(backfill),
      },
      ip: ctx.ip,
      businessDate: date,
    });
    return checkoutId;
  });
  return getCheckout(deps.sql, run.refId);
}

const couponUsed = (platform: CouponPlatform, code: string, checkoutNo: string | null) =>
  conflict('COUPON_USED', `${COUPON_PLATFORM_LABELS[platform]}券码 ${code} 已登记过${checkoutNo ? `（结账单 ${checkoutNo}）` : ''}，同一张券不能重复使用`, {
    platform,
    code,
    checkoutNo,
  });

// ───────────────────────── 反结账 ─────────────────────────

/**
 * 反结账：撤销一张结账单，账单与来访恢复为在店未结，之后可更正后重新结账。
 * 手牌已发给其他客人、已锁定或停用，或会员已持有其他在店手牌时不能反结账。
 * 储值消费按原单撤销（本金、赠金按原构成恢复），团购券登记作废（券码可重新登记），门票明细作废并留痕。
 */
export async function voidCheckout(deps: Deps, checkoutId: number, raw: unknown, ctx: OpContext): Promise<CheckoutDetail> {
  const { reason, refundShiftId } = parse(VoidCheckoutInput, raw);
  // 反结账开始处理时反结账人所在的班次：退款记到这个班次，入账前它已交班则拒绝（见 shifts.ts lockPaymentShift）。
  // 选了钱箱（跨钱箱退款）时记到所选的班次，不要求反结账人自己开班
  const seenShift = refundShiftId === undefined ? await openShiftOf(deps.sql, ctx.actor.id) : null;
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 只有这个事务允许「已结 → 未结」（见迁移 014 的账单、来访保护）
    await tx.unsafe("SET LOCAL yuzu.reopen = 'on'");
    // 先对班次加共享锁，再锁结账单与手牌、来访、账单
    const voidShiftId = refundShiftId === undefined ? await lockPaymentShift(tx, ctx.actor.id, seenShift) : await lockRefundShift(tx, refundShiftId);
    const at = ctx.at ?? new Date();
    const [c] = await tx<{ id: number; checkoutNo: string; clientKey: string; status: string; createdAt: string }[]>`
      SELECT id, checkout_no, client_key, status, created_at FROM checkouts WHERE id = ${checkoutId} FOR UPDATE`;
    if (!c) throw notFound('结账单不存在');
    if (c.status !== 'completed') throw conflict('ALREADY_VOIDED', `结账单 ${c.checkoutNo} 已反结账`);
    // 退款单（v0.7.20）：有生效的退款单的结账单不能反结账（结账单已锁，开退款单要等这里提交）
    await assertNoRefunds(tx, c);
    // 选钱箱只用于退现金（PR #17 复测 P2）：原单没收现金时，扫码等原路退回的提醒记到反结账人自己的班次，
    // 与页面一致要求先开班（R1.2），不能借别人的班次绕过；收款明细只追加不修改，在这里核对即可
    if (refundShiftId !== undefined) {
      const [cash] = await tx<{ amount: number }[]>`
        SELECT coalesce(sum(amount), 0)::int AS amount FROM checkout_payments WHERE checkout_id = ${c.id} AND method = 'cash'`;
      if (cash!.amount === 0) {
        throw unprocessable('REFUND_SHIFT_NOT_CASH', `结账单 ${c.checkoutNo} 没有收现金，不用选退款钱箱；请先开班，再反结账（原路退回的提醒记到你当班的交班表）`);
      }
    }
    // 撤销与反结账时限（#10，默认 48 小时）：超过时限只有店主可以反结账
    const windowHours = (await loadSettings(tx)).reversalWindowHours;
    if (windowHours !== null && ctx.actor.role !== 'owner' && at.getTime() - new Date(c.createdAt).getTime() > windowHours * 3_600_000) {
      throw unprocessable('REVERSAL_WINDOW', `结账单 ${c.checkoutNo} 已超过反结账时限（结账后 ${describeHours(windowHours)}内），只有店主可以反结账`, {
        windowHours,
        checkedOutAt: new Date(c.createdAt).toISOString(),
      });
    }
    // 手牌结账单恢复来访；桌台结账单（餐饮第二步）恢复开台
    const all = await tx<{ visitId: number | null; tableSessionId: number | null; billId: number; tagId: number | null; groupId: number | null; memberId: number | null }[]>`
      SELECT cb.visit_id, cb.table_session_id, cb.bill_id, v.tag_id, v.group_id, v.member_id
      FROM checkout_bills cb LEFT JOIN visits v ON v.id = cb.visit_id WHERE cb.checkout_id = ${c.id}`;
    const items = all.filter((i): i is typeof i & { visitId: number; tagId: number } => i.visitId !== null);
    const tableItems = all.filter((i) => i.tableSessionId !== null).map((i) => ({ sessionId: i.tableSessionId!, billId: i.billId }));

    // ① 手牌（id 升序）：必须启用、未锁定、没有其他在店客人
    const tags = items.length
      ? await tx<{ id: number; code: string; locked: boolean; active: boolean }[]>`
          SELECT id, code, locked, active FROM hand_tags WHERE id IN ${tx(items.map((i) => i.tagId))} ORDER BY id FOR UPDATE`
      : [];
    for (const t of tags) {
      if (!t.active || t.locked) throw conflict('TAG_UNAVAILABLE', `手牌 ${t.code} 已${t.active ? '锁定' : '停用'}，不能恢复在店；请先在手牌管理里处理`);
    }
    const busy = tags.length
      ? await tx<{ code: string }[]>`
          SELECT t.code FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE v.status = 'open' AND v.tag_id IN ${tx(tags.map((t) => t.id))}`
      : [];
    if (busy.length) throw conflict('TAG_REISSUED', `手牌 ${busy.map((b) => b.code).join('、')} 已发给其他客人，不能反结账`);
    const memberIds = items.flatMap((i) => (i.memberId ? [i.memberId] : []));
    if (memberIds.length) {
      const [inStore] = await tx<{ name: string }[]>`
        SELECT m.name FROM visits v JOIN members m ON m.id = v.member_id WHERE v.status = 'open' AND v.member_id IN ${tx(memberIds)}`;
      if (inStore) throw conflict('MEMBER_IN_STORE', `会员「${inStore.name}」已持有其他在店手牌，不能反结账`);
    }
    // ② 同行组 → ③ 来访 → 账单
    await lockGroups(tx, items.map((i) => i.groupId));
    const visits = await lockVisits(tx, items.map((i) => i.visitId));
    for (const v of visits.values()) {
      if (v.status !== 'settled') throw conflict('VISIT_CHANGED', `来访 ${v.visitNo} 状态已变化，请刷新后重试`);
    }
    // 桌台结账单：桌台（id 升序）此刻不能已开给别的客人 → 开台（id 升序）
    const tables = tableItems.length
      ? await tx<{ id: number; name: string }[]>`
          SELECT t.id, t.name FROM dining_tables t
          WHERE t.id IN (SELECT table_id FROM table_sessions WHERE id IN ${tx(tableItems.map((i) => i.sessionId))}) ORDER BY t.id FOR UPDATE`
      : [];
    if (tables.length) {
      const taken = await tx<{ name: string }[]>`
        SELECT t.name FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id WHERE s.status = 'open' AND s.table_id IN ${tx(tables.map((t) => t.id))}`;
      if (taken.length) throw conflict('TABLE_TAKEN', `桌台「${taken.map((t) => t.name).join('、')}」已开给别的客人，不能反结账；请先把那一桌转到别的桌台`);
      const sessions = await tx<{ id: number; sessionNo: string; status: string }[]>`
        SELECT id, session_no, status FROM table_sessions WHERE id IN ${tx(tableItems.map((i) => i.sessionId))} ORDER BY id FOR UPDATE`;
      for (const s of sessions) if (s.status !== 'settled') throw conflict('VISIT_CHANGED', `开台 ${s.sessionNo} 状态已变化，请刷新后重试`);
    }
    const billIds = all.map((i) => i.billId).sort((a, b) => a - b);
    await tx`SELECT id FROM bills WHERE id IN ${tx(billIds)} ORDER BY id FOR UPDATE`;

    const date = await businessDate(tx, deps, at);
    const voidText = `反结账 ${c.checkoutNo}：${reason}`.slice(0, 200);
    // 恢复在店：同行组、账单、来访
    const groupIds = [...new Set(items.flatMap((i) => (i.groupId ? [i.groupId] : [])))];
    if (groupIds.length) await tx`UPDATE visit_groups SET status = 'open', closed_at = NULL WHERE id IN ${tx(groupIds)} AND status = 'closed'`;
    await tx`UPDATE bills SET status = 'open', closed_at = NULL WHERE id IN ${tx(billIds)}`;
    // 门票计到第一次结账的时刻（客人已离店，只是更正）；多次反结账保留第一次的时刻
    if (items.length) {
      await tx`
        UPDATE visits SET status = 'open', closed_at = NULL, closed_by = NULL, ticket_end_at = coalesce(ticket_end_at, closed_at)
        WHERE id IN ${tx(items.map((i) => i.visitId))}`;
    }
    if (tableItems.length) {
      await tx`UPDATE table_sessions SET status = 'open', closed_at = NULL, closed_by = NULL WHERE id IN ${tx(tableItems.map((i) => i.sessionId))}`;
    }
    // 门票明细作废（下次结账按届时的在店时长重新计算）
    const ticketLines = await tx<{ id: number; billId: number; amount: number }[]>`
      SELECT id, bill_id, amount FROM bill_lines
      WHERE post_key = ${c.clientKey} AND ticket_type_id IS NOT NULL AND status = 'active' AND bill_id IN ${tx(billIds)} FOR UPDATE`;
    for (const l of ticketLines) {
      await tx`UPDATE bill_lines SET status = 'voided', void_reason = ${voidText}, voided_by = ${ctx.actor.id}, voided_at = ${at} WHERE id = ${l.id}`;
      await tx`UPDATE bills SET amount_cents = amount_cents - ${l.amount}, line_count = line_count - 1 WHERE id = ${l.billId}`;
    }
    // 储值消费按原单撤销（会员 id 升序）
    const walletPays = await tx<{ consumptionId: number; memberId: number }[]>`
      SELECT consumption_id, member_id FROM checkout_payments WHERE checkout_id = ${c.id} AND method = 'wallet' ORDER BY member_id`;
    for (const w of walletPays) await reverseForCheckout(tx, deps, { consumptionId: w.consumptionId, reason: voidText, businessDate: date, ctx, at });
    // 团购券登记作废：券码可以重新登记
    await tx`
      UPDATE group_buy_coupons SET status = 'voided', voided_at = ${at}, voided_by = ${ctx.actor.id}, void_reason = ${voidText}
      WHERE checkout_id = ${c.id} AND status = 'active'`;
    // 用掉的券退回（v0.7.20；在会员之后锁券）
    await returnCheckoutCoupons(tx, { checkoutId: c.id, reason: voidText, date, at, staffId: ctx.actor.id });
    // 用掉的次卡次数退回（v0.7.28；在券之后按卡的 id 升序锁卡）
    await returnCheckoutCountCards(tx, { checkoutId: c.id, reason: voidText, date, at, staffId: ctx.actor.id });
    // 退款记到反结账人的班次，或所选钱箱当班的班次（事务开头已加锁核对）
    await tx`
      UPDATE checkouts SET status = 'voided', voided_at = ${at}, voided_by = ${ctx.actor.id}, void_reason = ${reason}, void_business_date = ${date},
                           void_shift_id = ${voidShiftId}
      WHERE id = ${c.id}`;
    // 从别人的钱箱退：审计写明记到了谁的哪个班次
    const drawer = voidShiftId ? await shiftDrawerLabel(tx, voidShiftId, ctx.actor.id) : null;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_checkout_void',
      targetType: 'checkout',
      targetId: c.id,
      detail: {
        docNo: c.checkoutNo,
        tags: tags.map((t) => t.code),
        ...(tables.length ? { tables: tables.map((t) => t.name) } : {}),
        reason,
        ...(drawer && !drawer.mine ? { refundShift: drawer.shiftNo, refundDrawer: drawer.label } : {}),
      },
      ip: ctx.ip,
      businessDate: date,
    });
  });
  return getCheckout(deps.sql, checkoutId);
}

// ───────────────────────── 查询 ─────────────────────────

export async function getCheckout(db: Db, id: number): Promise<CheckoutDetail> {
  const [c] = await db<Omit<CheckoutDetail, 'bills' | 'payments' | 'remainingMates'>[]>`
    SELECT c.id, c.checkout_no, c.status, c.total_amount, c.note, c.business_date, s.display_name AS operator_name, c.created_at,
           c.voided_at, vs.display_name AS voided_by_name, c.void_reason, ${backfillMarkSql(db, 'c.client_key')} AS backfill
    FROM checkouts c JOIN staff s ON s.id = c.operator_id LEFT JOIN staff vs ON vs.id = c.voided_by WHERE c.id = ${id}`;
  if (!c) throw notFound('结账单不存在');
  // 手牌账单显示牌号；桌台账单（餐饮第二步）显示桌号与人数
  const bills = await db<CheckoutDetail['bills']>`
    SELECT cb.bill_id, b.bill_no, cb.visit_id, v.visit_no, t.code AS tag_code, cb.table_session_id, dt.name AS table_name, cb.guests,
           coalesce(m.name, tm.name) AS member_name, coalesce(v.guest_label, ts.guest_label, '') AS guest_label, cb.amount,
           cb.stay_minutes, cb.ticket_name, cb.ticket_segments, cb.ticket_amount, cb.ticket_extension_minutes
    FROM checkout_bills cb JOIN bills b ON b.id = cb.bill_id
    LEFT JOIN visits v ON v.id = cb.visit_id LEFT JOIN hand_tags t ON t.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
    LEFT JOIN table_sessions ts ON ts.id = cb.table_session_id LEFT JOIN dining_tables dt ON dt.id = ts.table_id
    LEFT JOIN members tm ON tm.id = ts.member_id
    WHERE cb.checkout_id = ${id} ORDER BY coalesce(t.code, dt.name)`;
  const payments = await db<CheckoutDetail['payments']>`
    SELECT p.id, p.method, p.amount, p.ref, coalesce(p.member_id, p.discount_member_id) AS member_id, m.name AS member_name, ap.display_name AS approved_by_name,
           CASE WHEN k.id IS NULL THEN NULL ELSE json_build_object('id', k.id, 'docNo', k.doc_no, 'principal', k.principal_amount,
                                                                     'bonus', k.bonus_amount, 'status', k.status) END AS consumption,
           CASE WHEN g.id IS NULL THEN NULL ELSE json_build_object('id', g.id, 'platform', g.platform, 'code', g.code,
                                                                     'dealName', g.deal_name, 'status', g.status) END AS coupon
    FROM checkout_payments p LEFT JOIN members m ON m.id = coalesce(p.member_id, p.discount_member_id) LEFT JOIN consumptions k ON k.id = p.consumption_id
    LEFT JOIN group_buy_coupons g ON g.id = p.coupon_id LEFT JOIN staff ap ON ap.id = p.approved_by
    WHERE p.checkout_id = ${id} ORDER BY p.id`;
  const mates = await db<{ code: string }[]>`
    SELECT DISTINCT t.code FROM visits v JOIN hand_tags t ON t.id = v.tag_id
    WHERE v.status = 'open' AND v.group_id IN (
      SELECT v2.group_id FROM checkout_bills cb JOIN visits v2 ON v2.id = cb.visit_id WHERE cb.checkout_id = ${id} AND v2.group_id IS NOT NULL)
      AND v.id NOT IN (SELECT visit_id FROM checkout_bills WHERE checkout_id = ${id} AND visit_id IS NOT NULL)
    ORDER BY t.code`;
  return { ...c, backfill: normalizeMark(c.backfill), bills, payments, remainingMates: mates.map((m) => m.code), refunds: await listRefundsOf(db, id) };
}

export async function listCheckouts(db: Db, date: string): Promise<CheckoutSummary[]> {
  return db<CheckoutSummary[]>`
    SELECT c.id, c.checkout_no, c.status, c.total_amount, c.business_date, s.display_name AS operator_name, c.created_at,
           coalesce((SELECT array_agg(t.code ORDER BY t.code) FROM checkout_bills cb JOIN visits v ON v.id = cb.visit_id
                     JOIN hand_tags t ON t.id = v.tag_id WHERE cb.checkout_id = c.id), '{}') AS tag_codes,
           coalesce((SELECT array_agg(dt.name ORDER BY dt.name) FROM checkout_bills cb JOIN table_sessions ts ON ts.id = cb.table_session_id
                     JOIN dining_tables dt ON dt.id = ts.table_id WHERE cb.checkout_id = c.id), '{}') AS table_names,
           (SELECT array_agg(DISTINCT p.method) FROM checkout_payments p WHERE p.checkout_id = c.id) AS methods,
           (SELECT bf.slip_no FROM backfill_entries bf WHERE bf.op_key = c.client_key ORDER BY bf.id LIMIT 1) AS backfill_slip_no,
           (SELECT coalesce(sum(r.amount), 0) FROM refunds r WHERE r.checkout_id = c.id AND r.status = 'completed')::bigint AS refunded_amount
    FROM checkouts c JOIN staff s ON s.id = c.operator_id
    WHERE c.business_date = ${date} OR c.void_business_date = ${date}
    ORDER BY c.id DESC`;
}

/** 按完整券码查团购券登记（核对一张券有没有用过） */
export async function findCoupon(db: Db, platform: CouponPlatform, rawCode: string) {
  const code = normalizeCouponCode(rawCode);
  return db<{ id: number; status: string; checkoutNo: string; amount: number; registeredAt: string; registeredByName: string }[]>`
    SELECT g.id, g.status, c.checkout_no, g.amount, g.registered_at, s.display_name AS registered_by_name
    FROM group_buy_coupons g JOIN checkouts c ON c.id = g.checkout_id JOIN staff s ON s.id = g.registered_by
    WHERE g.platform = ${platform} AND g.code = ${code} ORDER BY g.id DESC`;
}

