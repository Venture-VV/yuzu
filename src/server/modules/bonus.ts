// 赠金批次（Batch 2.4c，店主 #2「赠金有效期」）：每笔赠金是一个批次，记下金额、剩余与到期时间。
//
//   · 充值赠金 → 新批次；有效期取套餐设置（自定义赠金取经营规则的默认值），不设为长期有效；
//   · 消费扣赠金（本金 / 赠金的扣款构成仍按扣款规则）→ 先用最早到期的批次，长期有效的最后用；
//   · 撤销 → 按原单扣用的批次逐笔恢复；升级前的消费没有批次记录，恢复为长期有效的批次；
//   · 到期未用完的赠金作废：会员记账前、打开会员详情时先处理这位会员，后台每分钟再扫描全店。
// 所有函数都在调用方持有会员行锁的事务里执行，批次再按 id 升序加锁；members.bonus_balance 始终等于批次剩余之和。

import { businessDateOf } from '@shared/business-date';
import type { Db, Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { AppError } from '../lib/errors';
import { loadSettings } from './settings';
import { applyBalance, lockMember, nextDocNo, type LockedMember } from './wallet-core';

const mismatch = () => new AppError(500, 'BONUS_LOTS_MISMATCH', '赠金批次与赠金余额不一致，已阻止本次记账，请联系维护人员核对');

/** 充值赠金：新建一个批次 */
export async function addRechargeLot(tx: Tx, o: { memberId: number; rechargeId: number; amount: number; expiresAt: Date | null; at: Date }) {
  if (o.amount <= 0) return;
  await tx`
    INSERT INTO bonus_lots (member_id, source, recharge_id, amount, remaining, expires_at, created_at)
    VALUES (${o.memberId}, 'recharge', ${o.rechargeId}, ${o.amount}, ${o.amount}, ${o.expiresAt}, ${o.at})`;
}

/**
 * 消费扣赠金：在未到期的批次里先用最早到期的（长期有效的最后），逐批记下扣用。
 * 批次合计不够说明账不一致（例如有人绕过系统改了余额），拒绝记账。
 */
export async function takeFromLots(tx: Tx, o: { memberId: number; consumptionId: number; amount: number; at: Date }) {
  if (o.amount <= 0) return;
  const lots = await tx<{ id: number; remaining: number }[]>`
    SELECT id, remaining FROM bonus_lots
    WHERE member_id = ${o.memberId} AND remaining > 0 AND (expires_at IS NULL OR expires_at > ${o.at})
    ORDER BY expires_at ASC NULLS LAST, id
    FOR UPDATE`;
  let left = o.amount;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(left, lot.remaining);
    await tx`UPDATE bonus_lots SET remaining = remaining - ${take} WHERE id = ${lot.id}`;
    await tx`INSERT INTO bonus_lot_moves (lot_id, kind, amount, consumption_id, created_at) VALUES (${lot.id}, 'consume', ${-take}, ${o.consumptionId}, ${o.at})`;
    left -= take;
  }
  if (left > 0) throw mismatch();
}

/**
 * 撤销消费：把原单扣用的赠金逐笔恢复到原批次（原批次已到期的，由调用方随后按到期作废）。
 * 升级前的消费没有批次记录：恢复为一个长期有效的批次，与升级前「赠金不过期」一致。
 */
export async function restoreToLots(tx: Tx, o: { memberId: number; consumptionId: number; reversalId: number; amount: number; at: Date }) {
  if (o.amount <= 0) return;
  const moves = await tx<{ lotId: number; amount: number }[]>`
    SELECT lot_id, -amount AS amount FROM bonus_lot_moves
    WHERE consumption_id = ${o.consumptionId} AND kind = 'consume' ORDER BY lot_id`;
  if (moves.length === 0) {
    await tx`
      INSERT INTO bonus_lots (member_id, source, amount, remaining, expires_at, created_at)
      VALUES (${o.memberId}, 'restored', ${o.amount}, ${o.amount}, NULL, ${o.at})`;
    return;
  }
  if (moves.reduce((s, m) => s + m.amount, 0) !== o.amount) throw mismatch();
  await tx`SELECT id FROM bonus_lots WHERE id IN ${tx(moves.map((m) => m.lotId))} ORDER BY id FOR UPDATE`;
  for (const m of moves) {
    await tx`UPDATE bonus_lots SET remaining = remaining + ${m.amount} WHERE id = ${m.lotId}`;
    await tx`
      INSERT INTO bonus_lot_moves (lot_id, kind, amount, consumption_id, reversal_id, created_at)
      VALUES (${m.lotId}, 'restore', ${m.amount}, ${o.consumptionId}, ${o.reversalId}, ${o.at})`;
  }
}

/**
 * 储值退回扣回赠金（v0.7.26，M70）：先扣退的这几笔充值自己的批次，不够再按最早到期的扣（长期有效的最后）；
 * 只扣没到期的（到期的由调用方之前处理掉）。批次合计不够说明账不一致，拒绝记账
 */
export async function takeForRefund(tx: Tx, o: { memberId: number; refundId: number; amount: number; rechargeIds: number[]; at: Date }) {
  if (o.amount <= 0) return;
  const ids = o.rechargeIds.length ? o.rechargeIds : [0];
  const lots = await tx<{ id: number; remaining: number }[]>`
    SELECT id, remaining FROM bonus_lots
    WHERE member_id = ${o.memberId} AND remaining > 0 AND (expires_at IS NULL OR expires_at > ${o.at})
    ORDER BY (recharge_id IN ${tx(ids)}) DESC NULLS LAST, expires_at ASC NULLS LAST, id
    FOR UPDATE`;
  let left = o.amount;
  for (const lot of lots) {
    if (left === 0) break;
    const take = Math.min(left, lot.remaining);
    await tx`UPDATE bonus_lots SET remaining = remaining - ${take} WHERE id = ${lot.id}`;
    await tx`INSERT INTO bonus_lot_moves (lot_id, kind, amount, member_refund_id, created_at) VALUES (${lot.id}, 'refund', ${-take}, ${o.refundId}, ${o.at})`;
    left -= take;
  }
  if (left > 0) throw mismatch();
}

/** 会员当前有剩余的批次（先到期的在前）：会员详情显示「¥50 有效至 11-26」 */
export async function openLots(db: Db, memberId: number) {
  return db<{ remaining: number; expiresAt: Date | null }[]>`
    SELECT remaining, expires_at FROM bonus_lots
    WHERE member_id = ${memberId} AND remaining > 0
    ORDER BY expires_at ASC NULLS LAST, id`;
}

// ───────────────────────── 赠金到期作废 ─────────────────────────

/**
 * 在会员锁内作废这位会员到期未用完的赠金（到期时刻 <= at）：生成一张赠金过期单、一条只减赠金的余额流水，
 * 记账人为系统。没有到期的批次时什么也不做。返回处理后的余额。
 */
export async function expireDueLots(tx: Tx, deps: Deps, member: LockedMember, at: Date, reversalId: number | null = null): Promise<LockedMember> {
  const lots = await tx<{ id: number; remaining: number }[]>`
    SELECT id, remaining FROM bonus_lots
    WHERE member_id = ${member.id} AND remaining > 0 AND expires_at <= ${at}
    ORDER BY id FOR UPDATE`;
  if (lots.length === 0) return member;
  const total = lots.reduce((s, l) => s + l.remaining, 0);
  const settings = await loadSettings(tx);
  const businessDate = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
  const docNo = await nextDocNo(tx, 'expire', businessDate);
  const [doc] = await tx<{ id: number }[]>`
    INSERT INTO bonus_expiries (doc_no, member_id, amount, business_date, reversal_id, created_at)
    VALUES (${docNo}, ${member.id}, ${total}, ${businessDate}, ${reversalId}, ${at}) RETURNING id`;
  for (const lot of lots) {
    await tx`UPDATE bonus_lots SET remaining = 0 WHERE id = ${lot.id}`;
    await tx`INSERT INTO bonus_lot_moves (lot_id, kind, amount, expiry_id, created_at) VALUES (${lot.id}, 'expire', ${-lot.remaining}, ${doc!.id}, ${at})`;
  }
  const after = await applyBalance(tx, member, { principal: 0, bonus: -total }, {
    entryType: 'expire', docNo, expiryId: doc!.id, businessDate, operatorId: null, at,
  });
  await writeAudit(tx, {
    staffId: null,
    action: 'bonus_expired',
    targetType: 'member',
    targetId: member.id,
    detail: { docNo, memberName: member.name, amount: total, lots: lots.length, ...(reversalId ? { reversalId } : {}) },
    businessDate,
  });
  return after;
}

/**
 * 单独一个事务处理一位会员到期的赠金并提交。会员记账前、打开会员详情时先调用，
 * 使员工看到、核对的余额已经扣除到期赠金；后台每分钟另有一次全店扫描（sweepExpiredBonus）。
 */
export async function expireMemberBonus(deps: Deps, memberId: number, at: Date = new Date()): Promise<boolean> {
  const [due] = await deps.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM bonus_lots WHERE member_id = ${memberId} AND remaining > 0 AND expires_at <= ${at}`;
  if (!due || due.n === 0) return false;
  return deps.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'");
    const member = await lockMember(tx, memberId);
    const after = await expireDueLots(tx, deps, member, at);
    return after !== member;
  });
}

/** 全店扫描到期赠金（服务运行时每分钟一次，启动时先跑一次）；返回处理的会员数 */
export async function sweepExpiredBonus(deps: Deps, at: Date = new Date(), limit = 200): Promise<number> {
  const due = await deps.sql<{ memberId: number }[]>`
    SELECT DISTINCT member_id FROM bonus_lots WHERE remaining > 0 AND expires_at <= ${at} ORDER BY member_id LIMIT ${limit}`;
  let done = 0;
  for (const { memberId } of due) {
    if (await expireMemberBonus(deps, memberId, at)) done += 1;
  }
  return done;
}
