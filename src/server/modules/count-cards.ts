// 次卡（v0.7.28 ④，docs/SCHEDULE_FINISH.md 第 5 节，N5 待确认）：卡种、售卡、结账按次抵扣、反结账退回、退卡、过期、旧次卡期初。
//
// 钱怎么记：
//   · 售卡是收款（现金类，记到经办人当班的班次、进交班与日结），不是营业额——与充值一样；
//   · 结账「用次卡」是会员的预付消费，与会员储值一样算营业额、不算实收；按明细的价钱抵（一次一份）；
//   · 退卡按现金类方式退，记到经办人当班的班次；过期的次数作废，不退钱。
// 加锁顺序：
//   · 售卡：操作编号的咨询锁（与「确认作废」串行）→ 经办人的班次（共享锁）→ 会员一行（共享锁，确认没停用、没合并）→ 卡种一行（共享锁）；
//   · 退卡：操作编号的咨询锁 → 经办人的班次（共享锁）→ 那张卡一行；
//   · 结账用次卡：在结账已有的锁（班次 → 手牌 → 来访 → 账单 → 会员 → 券）之后按卡的 id 升序锁卡；反结账退回同样在券之后按 id 升序锁卡；
//   · 过期：一张一个事务，只锁那张卡；卡种的修改只锁卡种一行、带版本号。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import {
  allocateCountCards,
  countCardUsable,
  DEFAULT_COUNT_CARD_VALID_DAYS,
  defaultCountCardRefund,
  MAX_COUNT_CARD_NAME,
  MAX_COUNT_CARD_PRICE,
  MAX_COUNT_CARD_USES,
  type CheckoutCountCardOption,
  type CountCard,
  type CountCardLine,
  type CountCardMove,
  type CountCardDayTotals,
  type CountCardType,
} from '@shared/count-cards';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from '@shared/labels';
import { formatYuan, parseYuan } from '@shared/money';
import { readCsvTable, unclosedQuoteMessage } from '@shared/csv-read';
import { guard, guardAny } from '../auth/guard';
import { isUniqueViolation, type Db, type Sql, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { cents, idParam, parse, positiveCents } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { loadSettings } from './settings';
import { lockPaymentShift, openShiftOf } from './shifts';
import { systemStaffId } from './system-staff';

const nums = (v: unknown[] | null | undefined) => (v ?? []).map(Number);

async function businessDay(db: Db, deps: Pick<Deps, 'config'>, at: Date) {
  const settings = await loadSettings(db);
  return businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
}

/** 到期日：营业日起算 N 天（含当天）；null 为长期 */
const expiryOf = (date: string, validDays: number | null) =>
  validDays === null ? null : new Date(Date.parse(`${date}T12:00:00Z`) + (validDays - 1) * 86_400_000).toISOString().slice(0, 10);

/** 能抵的项目、票种的名称（票种前面写「门票」） */
async function targetNames(db: Db, itemIds: number[], ticketTypeIds: number[]): Promise<string[]> {
  const items = itemIds.length ? await db<{ name: string }[]>`SELECT name FROM service_items WHERE id IN ${db(itemIds)} ORDER BY name` : [];
  const tickets = ticketTypeIds.length ? await db<{ name: string }[]>`SELECT name FROM ticket_types WHERE id IN ${db(ticketTypeIds)} ORDER BY name` : [];
  return [...items.map((i) => i.name), ...tickets.map((t) => `门票 · ${t.name}`)];
}

// ───────────────────────── 卡种 ─────────────────────────

export async function listCountCardTypes(db: Db): Promise<CountCardType[]> {
  const rows = await db<(Omit<CountCardType, 'targetNames' | 'itemIds' | 'ticketTypeIds'> & { itemIds: unknown[]; ticketTypeIds: unknown[] })[]>`
    SELECT t.id, t.name, t.item_ids, t.ticket_type_ids, t.uses, t.price, t.valid_days, t.active, t.note, t.version,
           (SELECT count(*)::int FROM count_cards c WHERE c.type_id = t.id) AS sold_count
    FROM count_card_types t ORDER BY t.active DESC, t.id`;
  const out: CountCardType[] = [];
  for (const r of rows) {
    const itemIds = nums(r.itemIds);
    const ticketTypeIds = nums(r.ticketTypeIds);
    out.push({ ...r, itemIds, ticketTypeIds, targetNames: await targetNames(db, itemIds, ticketTypeIds) });
  }
  return out;
}

const TypeInput = z.object({
  name: z.string('请填写卡种名称').trim().min(1, '请填写卡种名称').max(MAX_COUNT_CARD_NAME, `名称最多 ${MAX_COUNT_CARD_NAME} 字`),
  itemIds: z.array(z.number().int().positive()).max(50, '能抵的项目最多 50 个').default([]),
  ticketTypeIds: z.array(z.number().int().positive()).max(50, '能抵的票种最多 50 个').default([]),
  uses: z.number('请填写次数').int('次数要是整数').min(1, '至少 1 次').max(MAX_COUNT_CARD_USES, `最多 ${MAX_COUNT_CARD_USES} 次`),
  price: positiveCents('售价').max(MAX_COUNT_CARD_PRICE, `售价最多 ${formatYuan(MAX_COUNT_CARD_PRICE)}`),
  validDays: z.number('有效期要是天数').int('有效期要是整数天').min(1, '有效期至少 1 天').max(3650, '有效期最多 3650 天').nullable().default(DEFAULT_COUNT_CARD_VALID_DAYS),
  active: z.boolean().default(true),
  note: z.string().trim().max(100, '备注最多 100 字').default(''),
  /** 修改时带上打开时的版本，别人刚改过拒绝 */
  expectedVersion: z.number().int().min(1).optional(),
});

async function assertTargets(db: Db, itemIds: number[], ticketTypeIds: number[]) {
  if (itemIds.length + ticketTypeIds.length === 0) throw badRequest('请至少选一个能抵的项目或票种');
  if (itemIds.length) {
    const found = await db<{ id: number }[]>`SELECT id FROM service_items WHERE id IN ${db(itemIds)}`;
    if (found.length !== new Set(itemIds).size) throw badRequest('有能抵的项目不存在，请刷新后重新选');
  }
  if (ticketTypeIds.length) {
    const found = await db<{ id: number }[]>`SELECT id FROM ticket_types WHERE id IN ${db(ticketTypeIds)}`;
    if (found.length !== new Set(ticketTypeIds).size) throw badRequest('有能抵的票种不存在，请刷新后重新选');
  }
}

export async function saveCountCardType(deps: Deps, id: number | null, raw: unknown, ctx: OpContext): Promise<CountCardType[]> {
  const input = parse(TypeInput, raw);
  const itemIds = [...new Set(input.itemIds)].sort((a, b) => a - b);
  const ticketTypeIds = [...new Set(input.ticketTypeIds)].sort((a, b) => a - b);
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertTargets(tx, itemIds, ticketTypeIds);
      if (id === null) {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO count_card_types (name, item_ids, ticket_type_ids, uses, price, valid_days, active, note, created_by)
          VALUES (${input.name}, ${itemIds}::bigint[], ${ticketTypeIds}::bigint[], ${input.uses}, ${input.price}, ${input.validDays}, ${input.active},
                  ${input.note}, ${ctx.actor.id})
          RETURNING id`;
        await writeAudit(tx, { staffId: ctx.actor.id, action: 'count_card_type_saved', targetType: 'count_card_type', targetId: row!.id, detail: { ...input, itemIds, ticketTypeIds, created: true }, ip: ctx.ip });
        return;
      }
      const [cur] = await tx<{ version: number }[]>`SELECT version FROM count_card_types WHERE id = ${id} FOR UPDATE`;
      if (!cur) throw notFound('卡种不存在');
      if (input.expectedVersion !== undefined && input.expectedVersion !== cur.version) throw conflict('COUNT_CARD_TYPE_CHANGED', '这个卡种刚刚被别人改过，请刷新后重新修改');
      await tx`
        UPDATE count_card_types SET name = ${input.name}, item_ids = ${itemIds}::bigint[], ticket_type_ids = ${ticketTypeIds}::bigint[], uses = ${input.uses},
               price = ${input.price}, valid_days = ${input.validDays}, active = ${input.active}, note = ${input.note}, version = version + 1,
               updated_by = ${ctx.actor.id}, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'count_card_type_saved', targetType: 'count_card_type', targetId: id, detail: { ...input, itemIds, ticketTypeIds }, ip: ctx.ip });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'count_card_types_name_key')) throw conflict('COUNT_CARD_TYPE_NAME_TAKEN', `已有叫「${input.name}」的卡种`);
    throw error;
  }
  return listCountCardTypes(deps.sql);
}

// ───────────────────────── 查询 ─────────────────────────

type CardRow = Omit<CountCard, 'itemIds' | 'ticketTypeIds' | 'targetNames' | 'refund'> & {
  itemIds: unknown[];
  ticketTypeIds: unknown[];
  refundNo: string | null;
  refundAmount: number | null;
  refundUses: number | null;
  refundMethod: PaymentMethod | null;
  refundReason: string | null;
  refundAt: string | null;
  refundOperator: string | null;
};

const cardSql = (db: Db) => db`
  SELECT c.id, c.card_no, c.member_id, m.name AS member_name, c.type_id, c.name, c.item_ids, c.ticket_type_ids, c.total_uses, c.remaining, c.price,
         to_char(c.expires_on, 'YYYY-MM-DD') AS expires_on, c.source, c.status, c.payment_method, to_char(c.business_date, 'YYYY-MM-DD') AS business_date,
         s.display_name AS sold_by_name, c.sold_at, c.version,
         r.refund_no, r.amount AS refund_amount, r.uses AS refund_uses, r.method AS refund_method, r.reason AS refund_reason, r.created_at AS refund_at,
         ro.display_name AS refund_operator
  FROM count_cards c JOIN members m ON m.id = c.member_id JOIN staff s ON s.id = c.sold_by
  LEFT JOIN count_card_refunds r ON r.card_id = c.id LEFT JOIN staff ro ON ro.id = r.operator_id`;

async function toCard(db: Db, r: CardRow): Promise<CountCard> {
  const { refundNo, refundAmount, refundUses, refundMethod, refundReason, refundAt, refundOperator, ...rest } = r;
  const itemIds = nums(r.itemIds);
  const ticketTypeIds = nums(r.ticketTypeIds);
  return {
    ...rest,
    itemIds,
    ticketTypeIds,
    targetNames: await targetNames(db, itemIds, ticketTypeIds),
    refund: refundNo
      ? { refundNo, amount: Number(refundAmount), uses: Number(refundUses), method: refundMethod!, reason: refundReason!, createdAt: refundAt!, operatorName: refundOperator! }
      : null,
  };
}

export async function getCountCard(db: Db, id: number): Promise<CountCard> {
  const [r] = await db<CardRow[]>`${cardSql(db)} WHERE c.id = ${id}`;
  if (!r) throw notFound('次卡不存在');
  return toCard(db, r);
}

export async function memberCountCards(db: Db, memberId: number): Promise<CountCard[]> {
  const rows = await db<CardRow[]>`${cardSql(db)} WHERE c.member_id = ${memberId} ORDER BY (c.status = 'active') DESC, c.id DESC LIMIT 100`;
  const out: CountCard[] = [];
  for (const r of rows) out.push(await toCard(db, r));
  return out;
}

export async function countCardMoves(db: Db, cardId: number): Promise<CountCardMove[]> {
  return db<CountCardMove[]>`
    SELECT mv.id, mv.kind, mv.delta, mv.amount, ck.checkout_no, mv.note, s.display_name AS staff_name, mv.at, to_char(mv.business_date, 'YYYY-MM-DD') AS business_date
    FROM count_card_moves mv JOIN staff s ON s.id = mv.staff_id LEFT JOIN checkouts ck ON ck.id = mv.checkout_id
    WHERE mv.card_id = ${cardId} ORDER BY mv.id`;
}

// ───────────────────────── 售卡 ─────────────────────────

export const SaleInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  memberId: z.number('请选择会员').int().positive('请选择会员'),
  typeId: z.number('请选择卡种').int().positive('请选择卡种'),
  /** 页面上看到的卡种版本与售价：刚改过的拒绝 */
  expectedVersion: z.number().int().min(1),
  expectedPrice: positiveCents('售价'),
  method: z.enum(PAYMENT_METHODS, '请选择收款方式'),
  ref: z.string().trim().max(64, '收款备注最多 64 字').default(''),
  note: z.string().trim().max(100, '备注最多 100 字').default(''),
});
export type CountCardSaleInput = z.input<typeof SaleInput>;

/** 售卡（同一编号重提返回原来那张；结果待确认时可以「确认作废」，之后原请求晚到也不生效） */
export async function sellCountCard(deps: Deps, raw: CountCardSaleInput, ctx: OpContext): Promise<{ card: CountCard; replayed: boolean }> {
  const input = parse(SaleInput, raw);
  if (input.method === 'other' && input.ref.length < 2) throw badRequest('「其他」收款请在备注里写明收的是什么');
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM count_cards WHERE client_key = ${key}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔售卡，请刷新页面后重新办理');
    return Number(p.id);
  };
  const seenShift = await openShiftOf(deps.sql, ctx.actor.id);
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, key, 'count_card_sale', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      const shiftId = await lockPaymentShift(tx, ctx.actor.id, seenShift);
      const at = ctx.at ?? new Date();
      const [m] = await tx<{ name: string; status: string }[]>`SELECT name, status FROM members WHERE id = ${input.memberId} FOR SHARE`;
      if (!m) throw notFound('会员不存在');
      if (m.status !== 'active') throw unprocessable('MEMBER_INACTIVE', `会员「${m.name}」已停用或已合并，不能售卡`);
      const [t] = await tx<{ name: string; itemIds: unknown[]; ticketTypeIds: unknown[]; uses: number; price: number; validDays: number | null; active: boolean; version: number }[]>`
        SELECT name, item_ids, ticket_type_ids, uses, price, valid_days, active, version FROM count_card_types WHERE id = ${input.typeId} FOR SHARE`;
      if (!t) throw notFound('卡种不存在');
      if (!t.active) throw unprocessable('COUNT_CARD_TYPE_INACTIVE', `卡种「${t.name}」已停售`);
      if (t.version !== input.expectedVersion || Number(t.price) !== input.expectedPrice) {
        throw conflict('COUNT_CARD_TYPE_CHANGED', `卡种「${t.name}」刚刚改过（现在 ${t.uses} 次 ${formatYuan(Number(t.price))}），请核对后重新确认`, {
          version: t.version,
          price: Number(t.price),
        });
      }
      const date = await businessDay(tx, deps, at);
      const cardNo = await nextDocNo(tx, 'count_card', 'CK', date);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO count_cards (card_no, member_id, type_id, name, item_ids, ticket_type_ids, total_uses, remaining, price, expires_on, source,
                                 payment_method, payment_ref, shift_id, business_date, sold_by, sold_at, note, client_key, request_hash)
        VALUES (${cardNo}, ${input.memberId}, ${input.typeId}, ${t.name}, ${nums(t.itemIds)}::bigint[], ${nums(t.ticketTypeIds)}::bigint[], ${t.uses}, ${t.uses},
                ${Number(t.price)}, ${expiryOf(date, t.validDays)}, 'sale', ${input.method}, ${input.ref}, ${shiftId}, ${date}, ${ctx.actor.id}, ${at},
                ${input.note}, ${key}, ${requestHash})
        RETURNING id`;
      const cardId = Number(row!.id);
      await tx`
        INSERT INTO count_card_moves (card_id, kind, delta, amount, staff_id, at, business_date)
        VALUES (${cardId}, 'sale', ${t.uses}, ${Number(t.price)}, ${ctx.actor.id}, ${at}, ${date})`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'count_card_sale',
        targetType: 'member',
        targetId: input.memberId,
        detail: { docNo: cardNo, memberName: m.name, type: t.name, uses: t.uses, price: Number(t.price), method: input.method, ref: input.ref || undefined },
        ip: ctx.ip,
        businessDate: date,
      });
      return { id: cardId, replayed: false };
    });
    return { card: await getCountCard(deps.sql, out.id), replayed: out.replayed };
  } catch (error) {
    if (isUniqueViolation(error, 'count_cards_client_key_key')) {
      const id = await replay(deps.sql);
      if (id !== null) return { card: await getCountCard(deps.sql, id), replayed: true };
    }
    throw error;
  }
}

// ───────────────────────── 退卡 ─────────────────────────

export const RefundInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  /** 页面上看到的卡的版本（剩几次）：刚用过、改过的拒绝 */
  expectedVersion: z.number().int().min(1),
  amount: cents('退的钱').max(MAX_COUNT_CARD_PRICE, '退的钱过大'),
  method: z.enum(PAYMENT_METHODS, '请选择退款方式'),
  ref: z.string().trim().max(64, '退款单号最多 64 字').default(''),
  reason: z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 字'),
});
export type CountCardRefundInput = z.input<typeof RefundInput>;

/** 退卡：退剩下的次数，默认按售价折算，可以改少；现金从经办人当班的钱箱退，扫码、银行卡登记退款单号 */
export async function refundCountCard(deps: Deps, cardId: number, raw: CountCardRefundInput, ctx: OpContext): Promise<{ card: CountCard; replayed: boolean }> {
  const input = parse(RefundInput, raw);
  if (input.amount > 0 && input.method !== 'cash' && input.ref.length < 2) {
    throw badRequest(input.method === 'other' ? '「其他」方式退的请写明是怎么退的' : `${PAYMENT_METHOD_LABELS[input.method]}退的请登记商户后台的退款单号`);
  }
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ cardId, ...payload });
  const replay = async (db: Db) => {
    const [p] = await db<{ cardId: number; requestHash: string }[]>`SELECT card_id, request_hash FROM count_card_refunds WHERE client_key = ${key}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔退卡，请刷新页面后重新办理');
    return Number(p.cardId);
  };
  const seenShift = await openShiftOf(deps.sql, ctx.actor.id);
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, key, 'count_card_refund', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      const shiftId = await lockPaymentShift(tx, ctx.actor.id, seenShift);
      const at = ctx.at ?? new Date();
      const [c] = await tx<{ cardNo: string; memberId: number; name: string; status: string; remaining: number; totalUses: number; price: number; version: number }[]>`
        SELECT card_no, member_id, name, status, remaining, total_uses, price, version FROM count_cards WHERE id = ${cardId} FOR UPDATE`;
      if (!c) throw notFound('次卡不存在');
      if (c.status !== 'active' || c.remaining <= 0) throw conflict('COUNT_CARD_CLOSED', `次卡 ${c.cardNo} 已${c.status === 'refunded' ? '退卡' : c.status === 'expired' ? '过期' : '用完'}，不能再退`);
      if (c.version !== input.expectedVersion) throw conflict('COUNT_CARD_CHANGED', `次卡 ${c.cardNo} 刚刚有变化（现在剩 ${c.remaining} 次），请核对后重新确认`, { remaining: c.remaining });
      const max = defaultCountCardRefund({ price: Number(c.price), remaining: c.remaining, totalUses: c.totalUses });
      if (input.amount > max) throw unprocessable('COUNT_CARD_REFUND_EXCEEDS', `最多退 ${formatYuan(max)}（售价 × 剩下次数 ÷ 总次数）`, { max });
      const date = await businessDay(tx, deps, at);
      const refundNo = await nextDocNo(tx, 'count_card_refund', 'TK', date);
      const [r] = await tx<{ id: number }[]>`
        INSERT INTO count_card_refunds (refund_no, card_id, uses, amount, method, ref, reason, operator_id, shift_id, business_date, created_at, client_key, request_hash)
        VALUES (${refundNo}, ${cardId}, ${c.remaining}, ${input.amount}, ${input.method}, ${input.ref}, ${input.reason}, ${ctx.actor.id}, ${shiftId}, ${date}, ${at},
                ${key}, ${requestHash})
        RETURNING id`;
      await tx`
        INSERT INTO count_card_moves (card_id, kind, delta, amount, refund_id, note, staff_id, at, business_date)
        VALUES (${cardId}, 'refund', ${-c.remaining}, ${input.amount}, ${r!.id}, ${input.reason}, ${ctx.actor.id}, ${at}, ${date})`;
      await tx`UPDATE count_cards SET remaining = 0, status = 'refunded', version = version + 1 WHERE id = ${cardId}`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'count_card_refund',
        targetType: 'member',
        targetId: Number(c.memberId),
        detail: { docNo: refundNo, cardNo: c.cardNo, name: c.name, uses: c.remaining, amount: input.amount, method: input.method, ref: input.ref || undefined, reason: input.reason },
        ip: ctx.ip,
        businessDate: date,
      });
      return { id: cardId, replayed: false };
    });
    return { card: await getCountCard(deps.sql, out.id), replayed: out.replayed };
  } catch (error) {
    if (isUniqueViolation(error, 'count_card_refunds_client_key_key')) {
      const id = await replay(deps.sql);
      if (id !== null) return { card: await getCountCard(deps.sql, id), replayed: true };
    }
    throw error;
  }
}

// ───────────────────────── 结账 ─────────────────────────

interface OpenCardRow {
  id: number;
  cardNo: string;
  memberId: number;
  memberName: string;
  name: string;
  remaining: number;
  expiresOn: string | null;
  status: CountCard['status'];
  itemIds: unknown[];
  ticketTypeIds: unknown[];
}

/** 结账前核对：这几位会员可用的次卡，与每张卡在这次结账里最多能抵几份（不算别的卡） */
export async function countCardOptions(db: Db, memberIds: number[], lines: CountCardLine[], date: string): Promise<CheckoutCountCardOption[]> {
  if (memberIds.length === 0) return [];
  const rows = await db<OpenCardRow[]>`
    SELECT c.id, c.card_no, c.member_id, m.name AS member_name, c.name, c.remaining, to_char(c.expires_on, 'YYYY-MM-DD') AS expires_on, c.status,
           c.item_ids, c.ticket_type_ids
    FROM count_cards c JOIN members m ON m.id = c.member_id
    WHERE c.member_id IN ${db(memberIds)} AND c.status = 'active' AND c.remaining > 0 AND (c.expires_on IS NULL OR c.expires_on >= ${date})
    ORDER BY c.id LIMIT 50`;
  const out: CheckoutCountCardOption[] = [];
  for (const r of rows) {
    const itemIds = nums(r.itemIds);
    const ticketTypeIds = nums(r.ticketTypeIds);
    const [a] = allocateCountCards([{ cardId: r.id, itemIds, ticketTypeIds, uses: r.remaining }], lines);
    const coverable = a?.units.length ?? 0;
    out.push({
      cardId: Number(r.id),
      cardNo: r.cardNo,
      memberId: Number(r.memberId),
      memberName: r.memberName,
      name: r.name,
      remaining: r.remaining,
      expiresOn: r.expiresOn,
      itemIds,
      ticketTypeIds,
      targetNames: await targetNames(db, itemIds, ticketTypeIds),
      coverable,
      reason: coverable > 0 ? null : '这次结账里没有这张卡能抵的项目',
    });
  }
  return out;
}

/**
 * 结账事务里用次卡（班次、手牌、来访、账单、会员、券都已锁好，门票已挂到账单）：按卡的 id 升序锁卡，核对归属、状态、有效期与次数，
 * 按此刻的明细重新分配（与页面同一个算法），与员工确认的金额不一致时拒绝。记「结账使用」的变动、扣次数（用完的标「已用完」）。
 */
export async function redeemCountCards(
  tx: Tx,
  o: { payments: { cardId: number; uses: number; amount: number }[]; memberIds: number[]; lines: CountCardLine[]; checkoutId: number; date: string; at: Date; staffId: number },
): Promise<{ cardId: number; uses: number; amount: number; ref: string }[]> {
  if (o.payments.length === 0) return [];
  const ids = o.payments.map((p) => p.cardId).sort((a, b) => a - b);
  const rows = await tx<OpenCardRow[]>`
    SELECT c.id, c.card_no, c.member_id, m.name AS member_name, c.name, c.remaining, to_char(c.expires_on, 'YYYY-MM-DD') AS expires_on, c.status,
           c.item_ids, c.ticket_type_ids
    FROM count_cards c JOIN members m ON m.id = c.member_id WHERE c.id IN ${tx(ids)} ORDER BY c.id FOR UPDATE OF c`;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const p of o.payments) {
    const r = byId.get(p.cardId);
    if (!r) throw notFound('有一张次卡不存在，请刷新后重新核对');
    if (!o.memberIds.includes(Number(r.memberId))) {
      throw unprocessable('COUNT_CARD_NOT_IN_CHECKOUT', `次卡 ${r.cardNo} 是会员「${r.memberName}」的，只能在这位会员结账时用；同行朋友请合并到同一张结账单`);
    }
    const why = countCardUsable({ status: r.status, expiresOn: r.expiresOn, remaining: r.remaining }, o.date);
    if (why) throw conflict('COUNT_CARD_NOT_USABLE', `次卡 ${r.cardNo}「${r.name}」${why}`);
    if (p.uses > r.remaining) throw conflict('COUNT_CARD_CHANGED', `次卡 ${r.cardNo} 只剩 ${r.remaining} 次（刚刚有变化），请核对后重新确认`, { cardId: p.cardId, remaining: r.remaining });
  }
  const alloc = allocateCountCards(
    o.payments.map((p) => {
      const r = byId.get(p.cardId)!;
      return { cardId: p.cardId, itemIds: nums(r.itemIds), ticketTypeIds: nums(r.ticketTypeIds), uses: p.uses };
    }),
    o.lines,
  );
  const out: { cardId: number; uses: number; amount: number; ref: string }[] = [];
  for (const a of alloc) {
    const p = o.payments.find((x) => x.cardId === a.cardId)!;
    const r = byId.get(a.cardId)!;
    if (a.units.length !== p.uses || a.amount !== p.amount) {
      throw conflict(
        'COUNT_CARD_CHANGED',
        a.units.length < p.uses
          ? `次卡 ${r.cardNo} 这次只能抵 ${a.units.length} 次（账单上能抵的项目刚有变化），请核对后重新确认`
          : `次卡 ${r.cardNo} 抵 ${p.uses} 次现在是 ${formatYuan(a.amount)}（账单明细刚有变化），请核对后重新确认`,
        { cardId: a.cardId, uses: a.units.length, amount: a.amount },
      );
    }
    await tx`
      INSERT INTO count_card_moves (card_id, kind, delta, amount, checkout_id, note, staff_id, at, business_date)
      VALUES (${a.cardId}, 'use', ${-p.uses}, ${a.amount}, ${o.checkoutId}, ${a.units.map((u) => u.name).join('、').slice(0, 200)}, ${o.staffId}, ${o.at}, ${o.date})`;
    await tx`
      UPDATE count_cards SET remaining = remaining - ${p.uses}, status = CASE WHEN remaining - ${p.uses} = 0 THEN 'used_up' ELSE status END, version = version + 1
      WHERE id = ${a.cardId}`;
    out.push({ cardId: a.cardId, uses: p.uses, amount: a.amount, ref: `${r.name}（${r.cardNo}）× ${p.uses}`.slice(0, 64) });
  }
  return out;
}

/**
 * 反结账：这张结账单用掉的次数退回（只追加「反结账退回」；过期的卡退回后由每分钟的自动处理再作废）。
 * 用过的卡之后退了卡的不能反结账：退卡时按剩下的次数退了钱，这几次已经不在卡上
 */
export async function returnCheckoutCountCards(tx: Tx, o: { checkoutId: number; reason: string; date: string; at: Date; staffId: number }) {
  const pays = await tx<{ cardId: number; uses: number; amount: number }[]>`
    SELECT count_card_id AS card_id, count_card_uses AS uses, amount FROM checkout_payments
    WHERE checkout_id = ${o.checkoutId} AND method = 'count_card' ORDER BY count_card_id`;
  for (const p of pays) {
    const [c] = await tx<{ status: string; cardNo: string }[]>`SELECT status, card_no FROM count_cards WHERE id = ${p.cardId} FOR UPDATE`;
    if (!c) continue;
    if (c.status === 'refunded') {
      throw conflict('COUNT_CARD_REFUNDED', `这张结账单用的次卡 ${c.cardNo} 之后已经退卡，次数退不回去，不能反结账；要更正请联系店主处理`);
    }
    await tx`
      INSERT INTO count_card_moves (card_id, kind, delta, amount, checkout_id, note, staff_id, at, business_date)
      VALUES (${p.cardId}, 'return', ${p.uses}, ${p.amount}, ${o.checkoutId}, ${o.reason.slice(0, 200)}, ${o.staffId}, ${o.at}, ${o.date})`;
    await tx`
      UPDATE count_cards SET remaining = remaining + ${p.uses}, status = CASE WHEN status IN ('used_up', 'expired') THEN 'active' ELSE status END, version = version + 1
      WHERE id = ${p.cardId}`;
  }
}

// ───────────────────────── 过期 ─────────────────────────

/** 过了有效期没用完的次数作废（每分钟的自动处理；一张一个事务，只锁那张卡）；返回作废了几张 */
export async function expireCountCards(sql: Sql, deps: Pick<Deps, 'config'>, now = new Date()): Promise<number> {
  const today = await businessDay(sql, deps, now);
  const due = await sql<{ id: number }[]>`
    SELECT id FROM count_cards WHERE status = 'active' AND remaining > 0 AND expires_on < ${today} ORDER BY id LIMIT 500`;
  let n = 0;
  for (const d of due) {
    await sql.begin(async (tx) => {
      const [c] = await tx<{ status: string; remaining: number; expiresOn: string | null; cardNo: string; memberId: number }[]>`
        SELECT status, remaining, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, card_no, member_id FROM count_cards WHERE id = ${d.id} FOR UPDATE`;
      if (!c || c.status !== 'active' || c.remaining <= 0 || c.expiresOn === null || c.expiresOn >= today) return;
      const staffId = await systemStaffId(tx);
      await tx`
        INSERT INTO count_card_moves (card_id, kind, delta, note, staff_id, at, business_date)
        VALUES (${d.id}, 'expire', ${-c.remaining}, ${`有效期到 ${c.expiresOn}`}, ${staffId}, ${now}, ${today})`;
      await tx`UPDATE count_cards SET remaining = 0, status = 'expired', version = version + 1 WHERE id = ${d.id}`;
      await writeAudit(tx, { staffId, action: 'count_card_expire', targetType: 'member', targetId: Number(c.memberId), detail: { cardNo: c.cardNo, uses: c.remaining }, businessDate: today });
      n += 1;
    });
  }
  return n;
}

// ───────────────────────── 旧次卡期初 ─────────────────────────

export interface OpeningCountCardRow {
  line: number;
  phone: string;
  memberNo: string;
  name: string;
  /** 能抵的价目项目名称、票种名称（顿号隔开） */
  items: string;
  tickets: string;
  totalUses: number;
  remaining: number;
  price: number;
  expiresOn: string | null;
}

export interface OpeningCountCardPreview {
  rows: { line: number; memberName: string | null; name: string; remaining: number; ok: boolean; problem: string | null }[];
  ok: number;
  bad: number;
}

/** 旧次卡期初的模板（表头）：手机号、会员号（二选一）、卡名、能抵的项目、能抵的票种、总次数、剩余次数、原售价（元，可空）、到期日（可空） */
export const OPENING_COUNT_CARD_HEADER = ['手机号', '会员号', '卡名', '能抵的项目', '能抵的票种', '总次数', '剩余次数', '原售价', '到期日'] as const;

/** 读旧次卡期初的 CSV：按表头找列（列的顺序不限，没有的列按空），格式不对的行列出来 */
export function parseOpeningCountCardsCsv(text: string): { rows: OpeningCountCardRow[]; errors: { line: number; message: string }[] } {
  const { header, rows, unclosedQuoteLine } = readCsvTable(text);
  const errors: { line: number; message: string }[] = [];
  if (unclosedQuoteLine !== null) errors.push({ line: unclosedQuoteLine, message: unclosedQuoteMessage(unclosedQuoteLine) });
  if (!header) return { rows: [], errors: [...errors, { line: 1, message: `文件是空的；表头要有：${OPENING_COUNT_CARD_HEADER.join('、')}` }] };
  const col = (name: string) => header.cells.findIndex((c) => c.trim() === name);
  const idx = Object.fromEntries(OPENING_COUNT_CARD_HEADER.map((h) => [h, col(h)])) as Record<(typeof OPENING_COUNT_CARD_HEADER)[number], number>;
  for (const need of ['卡名', '总次数', '剩余次数'] as const) if (idx[need] < 0) errors.push({ line: header.line, message: `表头缺少「${need}」` });
  if (idx['手机号'] < 0 && idx['会员号'] < 0) errors.push({ line: header.line, message: '表头要有「手机号」或「会员号」' });
  if (errors.length) return { rows: [], errors };
  const cell = (r: { cells: string[] }, name: (typeof OPENING_COUNT_CARD_HEADER)[number]) => (idx[name] >= 0 ? (r.cells[idx[name]] ?? '').trim() : '');
  const out: OpeningCountCardRow[] = [];
  for (const r of rows) {
    const total = Number(cell(r, '总次数'));
    const remaining = Number(cell(r, '剩余次数'));
    const priceText = cell(r, '原售价');
    const price = priceText === '' ? 0 : parseYuan(priceText);
    const expires = cell(r, '到期日').replaceAll('/', '-');
    if (!Number.isInteger(total) || !Number.isInteger(remaining)) {
      errors.push({ line: r.line, message: '总次数、剩余次数要是整数' });
      continue;
    }
    if (price === null) {
      errors.push({ line: r.line, message: `原售价「${priceText}」不是金额` });
      continue;
    }
    if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
      errors.push({ line: r.line, message: `到期日「${expires}」要写成 YYYY-MM-DD` });
      continue;
    }
    out.push({
      line: r.line,
      phone: cell(r, '手机号').replace(/[\s-]/g, ''),
      memberNo: cell(r, '会员号'),
      name: cell(r, '卡名'),
      items: cell(r, '能抵的项目'),
      tickets: cell(r, '能抵的票种'),
      totalUses: total,
      remaining,
      price,
      expiresOn: expires || null,
    });
  }
  return { rows: out, errors };
}

/** 旧次卡期初：每行一位会员的一张卡（手机号或会员号找会员，项目、票种按名称找）；有一行不对整批不写 */
export async function importOpeningCountCards(deps: Deps, rows: OpeningCountCardRow[], o: { operatorId: number; apply: boolean; batch: string }): Promise<OpeningCountCardPreview> {
  const out: OpeningCountCardPreview['rows'] = [];
  const ready: { row: OpeningCountCardRow; memberId: number; itemIds: number[]; ticketTypeIds: number[] }[] = [];
  const split = (s: string) => s.split(/[、,，;；|]/).map((x) => x.trim()).filter(Boolean);
  for (const row of rows) {
    const problems: string[] = [];
    const [m] = row.memberNo
      ? await deps.sql<{ id: number; name: string }[]>`SELECT id, name FROM members WHERE member_no = ${row.memberNo}`
      : await deps.sql<{ id: number; name: string }[]>`SELECT id, name FROM members WHERE phone = ${row.phone}`;
    if (!m) problems.push('找不到会员');
    const itemNames = split(row.items);
    const ticketNames = split(row.tickets);
    const items = itemNames.length ? await deps.sql<{ id: number; name: string }[]>`SELECT id, name FROM service_items WHERE name IN ${deps.sql(itemNames)}` : [];
    const tickets = ticketNames.length ? await deps.sql<{ id: number; name: string }[]>`SELECT id, name FROM ticket_types WHERE name IN ${deps.sql(ticketNames)}` : [];
    const missing = [...itemNames.filter((n) => !items.some((i) => i.name === n)), ...ticketNames.filter((n) => !tickets.some((t) => t.name === n))];
    if (missing.length) problems.push(`找不到项目或票种：${missing.join('、')}`);
    if (itemNames.length + ticketNames.length === 0) problems.push('没有能抵的项目或票种');
    if (!row.name.trim() || row.name.trim().length > MAX_COUNT_CARD_NAME) problems.push(`卡名要 1–${MAX_COUNT_CARD_NAME} 字`);
    if (!(row.totalUses >= 1 && row.totalUses <= 1000) || !(row.remaining >= 1 && row.remaining <= row.totalUses)) problems.push('总次数、剩余次数不对（剩余要在 1 到总次数之间）');
    if (!(row.price >= 0 && row.price <= MAX_COUNT_CARD_PRICE)) problems.push('原售价不对');
    out.push({ line: row.line, memberName: m?.name ?? null, name: row.name, remaining: row.remaining, ok: problems.length === 0, problem: problems.join('；') || null });
    if (problems.length === 0) ready.push({ row, memberId: Number(m!.id), itemIds: items.map((i) => Number(i.id)), ticketTypeIds: tickets.map((t) => Number(t.id)) });
  }
  const bad = out.filter((r) => !r.ok).length;
  if (o.apply && bad === 0 && ready.length) {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const at = new Date();
      const date = await businessDay(tx, deps, at);
      for (const r of ready) {
        const cardNo = await nextDocNo(tx, 'count_card', 'CK', date);
        const [c] = await tx<{ id: number }[]>`
          INSERT INTO count_cards (card_no, member_id, name, item_ids, ticket_type_ids, total_uses, remaining, price, expires_on, source, business_date,
                                   sold_by, sold_at, note)
          VALUES (${cardNo}, ${r.memberId}, ${r.row.name.trim()}, ${r.itemIds}::bigint[], ${r.ticketTypeIds}::bigint[], ${r.row.totalUses}, ${r.row.remaining},
                  ${r.row.price}, ${r.row.expiresOn}, 'opening', ${date}, ${o.operatorId}, ${at}, ${`旧次卡期初 ${o.batch}`.slice(0, 100)})
          RETURNING id`;
        await tx`
          INSERT INTO count_card_moves (card_id, kind, delta, note, staff_id, at, business_date)
          VALUES (${c!.id}, 'opening', ${r.row.remaining}, ${`旧次卡期初 ${o.batch}`.slice(0, 200)}, ${o.operatorId}, ${at}, ${date})`;
      }
      await writeAudit(tx, { staffId: o.operatorId, action: 'count_card_opening', targetType: 'count_card', detail: { batch: o.batch, count: ready.length }, businessDate: date });
    });
  }
  return { rows: out, ok: out.length - bad, bad };
}

// ───────────────────────── 日结、交班、自检 ─────────────────────────

export async function countCardDayTotals(db: Db, date: string): Promise<CountCardDayTotals> {
  const sales = await db<{ method: PaymentMethod; count: number; amount: number }[]>`
    SELECT payment_method AS method, count(*)::int AS count, coalesce(sum(price), 0)::bigint AS amount FROM count_cards
    WHERE source = 'sale' AND business_date = ${date} GROUP BY payment_method ORDER BY payment_method`;
  const refunds = await db<{ method: PaymentMethod; count: number; amount: number }[]>`
    SELECT method, count(*)::int AS count, coalesce(sum(amount), 0)::bigint AS amount FROM count_card_refunds
    WHERE business_date = ${date} GROUP BY method ORDER BY method`;
  const [mv] = await db<{ useCount: number; useAmount: number; expiredCards: number; expiredUses: number; openingCards: number; openingUses: number }[]>`
    SELECT coalesce(-sum(delta) FILTER (WHERE kind = 'use'), 0)::int - coalesce(sum(delta) FILTER (WHERE kind = 'return'), 0)::int AS use_count,
           coalesce(sum(amount) FILTER (WHERE kind = 'use'), 0)::bigint - coalesce(sum(amount) FILTER (WHERE kind = 'return'), 0)::bigint AS use_amount,
           count(*) FILTER (WHERE kind = 'expire')::int AS expired_cards, coalesce(-sum(delta) FILTER (WHERE kind = 'expire'), 0)::int AS expired_uses,
           count(*) FILTER (WHERE kind = 'opening')::int AS opening_cards, coalesce(sum(delta) FILTER (WHERE kind = 'opening'), 0)::int AS opening_uses
    FROM count_card_moves WHERE business_date = ${date}`;
  const [left] = await db<{ cards: number; uses: number }[]>`
    SELECT count(*) FILTER (WHERE s > 0)::int AS cards, coalesce(sum(s) FILTER (WHERE s > 0), 0)::int AS uses
    FROM (SELECT card_id, sum(delta) AS s FROM count_card_moves WHERE business_date <= ${date} GROUP BY card_id) x`;
  const sum = (rows: { count: number; amount: number }[]) => ({ count: rows.reduce((s, r) => s + r.count, 0), amount: rows.reduce((s, r) => s + Number(r.amount), 0) });
  return {
    sales: { ...sum(sales), byMethod: sales.map((r) => ({ ...r, amount: Number(r.amount) })) },
    refunds: { ...sum(refunds), byMethod: refunds.map((r) => ({ ...r, amount: Number(r.amount) })) },
    uses: { count: mv!.useCount, amount: Number(mv!.useAmount) },
    expired: { cards: mv!.expiredCards, uses: mv!.expiredUses },
    opening: { cards: mv!.openingCards, uses: mv!.openingUses },
    outstanding: { cards: left!.cards, uses: left!.uses },
  };
}

/** 自检：每张卡剩几次 = 变动之和；结账收款里的「次卡」= 那张结账单的使用记录；退卡单与卡一致 */
export async function countCardChecks(db: Db): Promise<{ key: string; label: string; ok: boolean; detail: string }[]> {
  const bad = await db<{ cardNo: string }[]>`
    SELECT c.card_no FROM count_cards c LEFT JOIN (SELECT card_id, sum(delta) AS s FROM count_card_moves GROUP BY card_id) m ON m.card_id = c.id
    WHERE c.remaining <> coalesce(m.s, 0) LIMIT 5`;
  const pay = await db<{ checkoutNo: string }[]>`
    SELECT ck.checkout_no FROM checkout_payments p JOIN checkouts ck ON ck.id = p.checkout_id
    LEFT JOIN (SELECT checkout_id, card_id, sum(-delta) FILTER (WHERE kind = 'use') AS uses, sum(amount) FILTER (WHERE kind = 'use') AS amount
               FROM count_card_moves WHERE checkout_id IS NOT NULL GROUP BY checkout_id, card_id) u
      ON u.checkout_id = p.checkout_id AND u.card_id = p.count_card_id
    WHERE p.method = 'count_card' AND (u.uses IS DISTINCT FROM p.count_card_uses OR u.amount IS DISTINCT FROM p.amount) LIMIT 5`;
  const refunds = await db<{ refundNo: string }[]>`
    SELECT r.refund_no FROM count_card_refunds r JOIN count_cards c ON c.id = r.card_id
    LEFT JOIN count_card_moves mv ON mv.refund_id = r.id
    WHERE c.status <> 'refunded' OR mv.id IS NULL OR mv.amount <> r.amount OR -mv.delta <> r.uses LIMIT 5`;
  const [n] = await db<{ cards: number; uses: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'active')::int AS cards, coalesce(sum(remaining), 0)::int AS uses FROM count_cards`;
  return [
    {
      key: 'count_cards',
      label: '次卡：剩余次数与变动一致',
      ok: bad.length === 0,
      detail: bad.length ? `次数对不上的卡：${bad.map((b) => b.cardNo).join('、')}` : `可用的卡 ${n!.cards} 张，还剩 ${n!.uses} 次`,
    },
    {
      key: 'count_card_payments',
      label: '次卡：结账收款与使用记录一致',
      ok: pay.length === 0 && refunds.length === 0,
      detail: pay.length || refunds.length ? `对不上：${[...pay.map((p) => p.checkoutNo), ...refunds.map((r) => r.refundNo)].join('、')}` : '每笔「次卡」收款都有对应的使用记录，退卡单与卡一致',
    },
  ];
}

// ───────────────────────── 路由 ─────────────────────────

export function registerCountCardRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/count-card-types', { preHandler: guardAny('countcard.sell', 'catalog.manage', 'member.read') }, async () => listCountCardTypes(sql));
  app.post('/api/admin/count-card-types', { preHandler: guard('catalog.manage') }, async (req) => saveCountCardType(deps, null, req.body, ctxOf(req)));
  app.put('/api/admin/count-card-types/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return saveCountCardType(deps, id, req.body, ctxOf(req));
  });
  app.get('/api/members/:id/count-cards', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return memberCountCards(sql, id);
  });
  app.get('/api/count-cards/:id', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { card: await getCountCard(sql, id), moves: await countCardMoves(sql, id) };
  });
  app.post('/api/count-cards', { preHandler: guard('countcard.sell') }, async (req) => sellCountCard(deps, req.body as CountCardSaleInput, ctxOf(req)));
  app.post('/api/count-cards/:id/refund', { preHandler: guard('countcard.refund') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return refundCountCard(deps, id, req.body as CountCardRefundInput, ctxOf(req));
  });
}

export type { Tx };
