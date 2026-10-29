// 会员钱包记账核心：充值、消费、撤销。
//
// 每笔操作在一个数据库事务内完成「单据 + 流水 + 余额」，要么全部成功，要么全部失败。
// 并发与重复提交的处理：
//   1. 先对会员行加锁（SELECT … FOR UPDATE），同一会员的操作严格串行；
//   2. 加锁后检查幂等键：同一个键再次提交时直接返回第一次的结果，不会重复记账；
//   3. 余额字段有 CHECK (>= 0) 约束兜底，任何情况下都不会透支；
//   4. 员工确认作废一笔结果待确认的操作时，先登记「编号 + 业务类型」的作废（lib/fences.ts）；
//      原请求写编号前与作废串行检查，同一类型已作废则整笔回滚；
//   5. 赠金按批次记账（bonus.ts）：记账前先作废这位会员到期的赠金，消费先用最早到期的批次，撤销回到原批次。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bonusExpiryAt, businessDateOf } from '@shared/business-date';
import { PRICE_TIERS, type PriceTier } from '@shared/catalog';
import { splitDeduction } from '@shared/deduction';
import { describeHours, PAYMENT_METHODS } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { can, type Permission } from '@shared/permissions';
import type { ConsumptionDoc, OperationLookup, OperationResult, RechargeDoc, ReversalDoc } from '@shared/types';
import { isUniqueViolation, type Db, type Sql, type Tx } from '../db';
import { guard } from '../auth/guard';
import { consumeOverLimitGrant } from '../auth/grants';
import { writeAudit } from '../lib/audit';
import { assertNotFenced, fenceKey, isFenced } from '../lib/fences';
import type { Deps, OpContext } from '../lib/context';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { idParam, parse, positiveCents, cents } from '../lib/validate';
import { addRechargeLot, expireDueLots, expireMemberBonus, restoreToLots, takeFromLots } from './bonus';
import { getMember } from './members';
import { loadPricedItems, priceLine } from './pricing';
import { loadSettings } from './settings';
import { applyBalance, lockMember, nextDocNo, type LockedMember } from './wallet-core';

type OpType = 'recharge' | 'consume' | 'reversal';
const OP_TYPES = ['recharge', 'consume', 'reversal'] as const satisfies readonly OpType[];
const OP_LABELS: Record<OpType, string> = { recharge: '充值', consume: '消费', reversal: '撤销' };
const isWalletOp = (t: string): t is OpType => (OP_TYPES as readonly string[]).includes(t);

// ───────────────────────── 输入 ─────────────────────────

const idempotencyKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
/** 超过单笔上限时，店主或店总当场授权的授权编号；不超过上限时不用带（不带时不进入请求摘要，旧请求重提不受影响） */
const overLimitGrantId = z.uuid('授权编号格式不正确').optional();

export const RechargeInput = z.object({
  idempotencyKey,
  memberId: z.number().int().positive(),
  planId: z.number().int().positive().nullable().default(null),
  paidAmount: positiveCents('实收金额'),
  bonusAmount: cents('赠金'),
  paymentMethod: z.enum(PAYMENT_METHODS, '请选择收款方式'),
  paymentRef: z.string().trim().max(64, '收款备注最多 64 字').default(''),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
  paymentConfirmed: z.literal(true, '请先核实收款到账，再确认入账'),
  overLimitGrantId,
  /** 页面确认时看到的赠金有效期（天，null 为长期有效）；与当前规则不一致时拒绝。不带时不核对 */
  bonusValidDays: z.number().int().positive().nullable().optional(),
});
export type RechargeInputData = z.input<typeof RechargeInput>;

const ExpectedSplit = z.object({ principal: cents('扣本金'), bonus: cents('扣赠金') });

export const ConsumeInput = z
  .object({
    idempotencyKey,
    memberId: z.number().int().positive(),
    lines: z
      .array(
        z.object({
          itemId: z.number().int().positive(),
          quantity: z.number().int().min(1).max(99, '单项数量最多 99'),
          /** 价格档；不带时按项目的默认档计价（升级前留下的待确认请求不带这一项） */
          tier: z.enum(PRICE_TIERS, '价格档不正确').optional(),
        }),
      )
      .max(30)
      .default([]),
    customLines: z
      .array(z.object({ name: z.string().trim().min(1, '请填写消费内容').max(32), amount: positiveCents('消费金额') }))
      .max(10)
      .default([]),
    note: z.string().trim().max(200, '备注最多 200 字').default(''),
    /** 员工确认时看到的应扣金额；与服务端计算不一致时拒绝，避免价格变动后误扣 */
    expectedTotal: positiveCents('应扣金额'),
    /** 员工确认时看到的会员余额；不一致说明其他终端刚刚操作过，需要重新确认 */
    expectedBalance: z.object({ principal: cents('本金'), bonus: cents('赠金') }).optional(),
    /** 员工确认时看到的扣款构成；扣款规则或余额变化导致构成不同时拒绝，实际入账必须与确认内容一致 */
    expectedSplit: ExpectedSplit.optional(),
    overLimitGrantId,
  })
  .refine((v) => v.lines.length + v.customLines.length > 0, '请至少选择一个消费项目');
export type ConsumeInputData = z.input<typeof ConsumeInput>;

export const ReverseInput = z.object({
  idempotencyKey,
  reason: z.string().trim().min(2, '请填写撤销原因（至少 2 个字）').max(200, '撤销原因最多 200 字'),
});
export type ReverseInputData = z.input<typeof ReverseInput>;

/**
 * 作废：type 是页面记录的原业务类型，服务端按它检查权限，并且只有与原请求真实类型一致时作废才生效；
 * 其余是原操作摘要，只用于审计与日结提醒，不参与记账。
 */
export const AbandonInput = z.object({
  type: z.enum(OP_TYPES, '缺少原操作的业务类型'),
  memberId: z.number().int().positive().optional(),
  amount: z.number().int().min(0).optional(),
  summary: z.string().trim().max(200, '摘要最多 200 字').default(''),
});
export type AbandonInputData = z.input<typeof AbandonInput>;
type AbandonInputParsed = z.output<typeof AbandonInput>;

// ───────────────────────── 基础工具 ─────────────────────────

const hashRequest = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

interface KeyRow {
  /** 会员记账之外，还可能是作废登记（abandoned）或其他模块的编号 */
  opType: string;
  requestHash: string;
  refId: number;
}

async function findKey(db: Db, key: string): Promise<KeyRow | undefined> {
  const [row] = await db<KeyRow[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${key}`;
  return row;
}

const abandonedError = () => conflict('OP_ABANDONED', '这笔操作已确认作废，没有入账；如仍需办理，请重新填写后提交');

function assertSameRequest(row: KeyRow, opType: OpType, requestHash: string) {
  // 005 版本的作废登记直接占用了编号，仍按已作废处理
  if (row.opType === 'abandoned') throw abandonedError();
  if (row.opType !== opType || row.requestHash !== requestHash) {
    throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的业务，请刷新页面后重新发起');
  }
}

/**
 * 在会员锁内执行一笔幂等操作。返回单据编号，以及是否为重复提交。
 */
async function runIdempotent(
  sql: Sql,
  opts: { key: string; opType: OpType; requestHash: string; memberId: number; staffId: number },
  body: (tx: Tx, member: LockedMember) => Promise<number>,
): Promise<{ refId: number; replayed: boolean }> {
  try {
    return await sql.begin(async (tx) => {
      // 限制等待时间：页面 15 秒超时之前，这笔操作要么已提交、要么已回滚，查询结果才可信
      await tx.unsafe("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '10s'");
      const member = await lockMember(tx, opts.memberId);
      const existing = await findKey(tx, opts.key);
      if (existing) {
        assertSameRequest(existing, opts.opType, opts.requestHash);
        return { refId: existing.refId, replayed: true };
      }
      if (await isFenced(tx, opts.key, [opts.opType])) throw abandonedError();
      const refId = await body(tx, member);
      // 写编号前与「确认作废」串行：处理期间被作废（同一业务类型）则整笔回滚
      await assertNotFenced(tx, opts.key, opts.opType, abandonedError);
      await tx`
        INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id)
        VALUES (${opts.key}, ${opts.opType}, ${opts.requestHash}, ${refId}, ${opts.staffId})`;
      return { refId, replayed: false };
    });
  } catch (error) {
    // 极少数情况下同一个键并发落在不同会员锁上，由主键约束兜底。
    if (isUniqueViolation(error, 'idempotency_keys_pkey')) {
      const existing = await findKey(sql, opts.key);
      if (existing) {
        assertSameRequest(existing, opts.opType, opts.requestHash);
        return { refId: existing.refId, replayed: true };
      }
    }
    throw error;
  }
}

// ───────────────────────── 读取单据 ─────────────────────────

export async function getRecharge(db: Db, id: number): Promise<RechargeDoc> {
  const [row] = await db<RechargeDoc[]>`
    SELECT r.id, r.doc_no, r.member_id, r.plan_id, r.plan_name, r.paid_amount, r.bonus_amount, r.payment_method,
           r.payment_ref, r.note, r.business_date, s.display_name AS operator_name, r.created_at,
           a.display_name AS over_limit_approver_name, r.bonus_expires_at
    FROM recharges r JOIN staff s ON s.id = r.operator_id LEFT JOIN staff a ON a.id = r.over_limit_approved_by
    WHERE r.id = ${id}`;
  if (!row) throw notFound('充值单不存在');
  return row;
}

export async function getConsumption(db: Db, id: number): Promise<ConsumptionDoc> {
  const [row] = await db<ConsumptionDoc[]>`
    SELECT c.id, c.doc_no, c.member_id, c.total_amount, c.principal_amount, c.bonus_amount, c.deduction_rule,
           c.note, c.status, c.business_date, s.display_name AS operator_name, c.created_at,
           a.display_name AS over_limit_approver_name,
           coalesce((
             SELECT json_agg(json_build_object('id', l.id, 'itemId', l.item_id, 'tier', l.tier, 'name', l.name, 'unitPrice', l.unit_price,
                                               'quantity', l.quantity, 'amount', l.amount) ORDER BY l.id)
             FROM consumption_lines l WHERE l.consumption_id = c.id), '[]'::json) AS lines,
           (SELECT json_build_object('id', r.id, 'docNo', r.doc_no, 'reason', r.reason, 'businessDate', r.business_date,
                                     'operatorName', rs.display_name, 'createdAt', r.created_at)
            FROM reversals r JOIN staff rs ON rs.id = r.operator_id WHERE r.consumption_id = c.id) AS reversal
    FROM consumptions c JOIN staff s ON s.id = c.operator_id LEFT JOIN staff a ON a.id = c.over_limit_approved_by
    WHERE c.id = ${id}`;
  if (!row) throw notFound('消费单不存在');
  return row;
}

export async function getReversal(db: Db, id: number): Promise<ReversalDoc> {
  const [row] = await db<ReversalDoc[]>`
    SELECT r.id, r.doc_no, r.consumption_id, c.doc_no AS consumption_doc_no, r.member_id, r.principal_amount,
           r.bonus_amount, r.reason, r.business_date, s.display_name AS operator_name, r.created_at,
           (SELECT json_build_object('docNo', e.doc_no, 'amount', e.amount) FROM bonus_expiries e WHERE e.reversal_id = r.id) AS expired_bonus
    FROM reversals r JOIN consumptions c ON c.id = r.consumption_id JOIN staff s ON s.id = r.operator_id
    WHERE r.id = ${id}`;
  if (!row) throw notFound('撤销单不存在');
  return row;
}

async function balancesOf(db: Db, column: 'recharge_id' | 'reversal_id' | 'consumption_id', id: number) {
  const [le] = await db<{ principalDelta: number; bonusDelta: number; principalAfter: number; bonusAfter: number }[]>`
    SELECT principal_delta, bonus_delta, principal_after, bonus_after FROM ledger_entries
    WHERE ${db(column)} = ${id} AND entry_type = ${column === 'recharge_id' ? 'recharge' : column === 'reversal_id' ? 'reversal' : 'consume'}`;
  if (!le) throw new AppError(500, 'LEDGER_MISSING', '找不到对应的余额流水');
  return {
    balanceBefore: { principal: le.principalAfter - le.principalDelta, bonus: le.bonusAfter - le.bonusDelta },
    balanceAfter: { principal: le.principalAfter, bonus: le.bonusAfter },
  };
}

export async function loadOperation(db: Db, opType: OpType, refId: number, replayed: boolean): Promise<OperationResult> {
  switch (opType) {
    case 'recharge': {
      const recharge = await getRecharge(db, refId);
      return { type: 'recharge', replayed, recharge, ...(await balancesOf(db, 'recharge_id', refId)), member: await getMember(db, recharge.memberId) };
    }
    case 'consume': {
      const consumption = await getConsumption(db, refId);
      return { type: 'consume', replayed, consumption, ...(await balancesOf(db, 'consumption_id', refId)), member: await getMember(db, consumption.memberId) };
    }
    case 'reversal': {
      const reversal = await getReversal(db, refId);
      const balances = await balancesOf(db, 'reversal_id', refId);
      // 恢复的赠金随即到期作废时，撤销后的余额按作废之后的显示
      const expired = reversal.expiredBonus?.amount ?? 0;
      return {
        type: 'reversal',
        replayed,
        reversal,
        consumption: await getConsumption(db, reversal.consumptionId),
        balanceBefore: balances.balanceBefore,
        balanceAfter: { principal: balances.balanceAfter.principal, bonus: balances.balanceAfter.bonus - expired },
        member: await getMember(db, reversal.memberId),
      };
    }
  }
}

function docNoOf(result: OperationResult): string {
  switch (result.type) {
    case 'recharge':
      return result.recharge.docNo;
    case 'consume':
      return result.consumption.docNo;
    case 'reversal':
      return result.reversal.docNo;
  }
}

async function finish(deps: Deps, ctx: OpContext, opType: OpType, key: string, run: { refId: number; replayed: boolean }) {
  const result = await loadOperation(deps.sql, opType, run.refId, run.replayed);
  if (run.replayed) {
    await writeAudit(deps.sql, {
      staffId: ctx.actor.id,
      action: 'duplicate_blocked',
      targetType: opType,
      targetId: run.refId,
      detail: { idempotencyKey: key, docNo: docNoOf(result), memberName: result.member.name },
      ip: ctx.ip,
      businessDate: businessDateOf(ctx.at ?? new Date(), deps.config.timezone, (await loadSettings(deps.sql)).businessDayStartHour),
    });
  }
  return result;
}

/**
 * 金额超过单笔上限：请求必须带店主或店总的当场授权，授权覆盖这位会员、这类业务、这个金额，在当前事务里核销。
 * 授权编号用操作编号标记用途（同一编号重提时直接返回第一次的结果，不会再核销一次）。
 */
async function approveOverLimit(
  tx: Tx,
  grantId: string | undefined,
  ctx: OpContext,
  o: { kind: 'recharge' | 'consume'; memberId: number; amount: number; limit: number; key: string },
): Promise<{ approverId: number; approverName: string }> {
  const label = o.kind === 'recharge' ? '充值' : '消费';
  if (!grantId) {
    throw unprocessable('OVER_LIMIT_AUTH_REQUIRED', `超过单笔${label}上限 ${formatYuan(o.limit)}，需要店主或店总当场授权`, { limit: o.limit, amount: o.amount });
  }
  return consumeOverLimitGrant(tx, {
    grantId,
    actor: ctx.actor,
    scope: { kind: o.kind, memberId: o.memberId, amount: o.amount },
    usedRef: `${o.kind}:${o.key}`,
  });
}

// ───────────────────────── 充值 ─────────────────────────

export async function recharge(deps: Deps, raw: RechargeInputData, ctx: OpContext): Promise<OperationResult> {
  const input = parse(RechargeInput, raw);
  const { idempotencyKey: key, ...payload } = input;
  await expireMemberBonus(deps, input.memberId, ctx.at ?? new Date());
  const run = await runIdempotent(
    deps.sql,
    { key, opType: 'recharge', requestHash: hashRequest(payload), memberId: input.memberId, staffId: ctx.actor.id },
    async (tx, locked) => {
      const settings = await loadSettings(tx);
      const at = ctx.at ?? new Date();
      // 先作废到期的赠金（通常已由记账前的单独事务处理），入账后余额从最新余额算起
      const member = await expireDueLots(tx, deps, locked, at);
      if (member.status !== 'active') throw unprocessable('MEMBER_FROZEN', '该会员已停用，不能充值');

      let planName: string | null = null;
      let bonusValidDays = settings.customBonusValidDays;
      if (input.planId) {
        const [plan] = await tx<{ name: string; payAmount: number; bonusAmount: number; active: boolean; bonusValidDays: number | null }[]>`
          SELECT name, pay_amount, bonus_amount, active, bonus_valid_days FROM recharge_plans WHERE id = ${input.planId}`;
        if (!plan || !plan.active) throw conflict('PLAN_UNAVAILABLE', '该充值套餐已停用，请重新选择');
        if (plan.payAmount !== input.paidAmount || plan.bonusAmount !== input.bonusAmount) {
          throw conflict('PLAN_CHANGED', '充值套餐金额刚刚有调整，请核对后重新确认');
        }
        planName = plan.name;
        bonusValidDays = plan.bonusValidDays;
      } else if (input.bonusAmount > 0 && !can(ctx.actor, 'recharge.customBonus')) {
        throw forbidden('当前岗位不能自定义赠金，请选择充值套餐');
      }
      // 赠金有效期以员工确认时看到的为准：期间店主调整了有效期时拒绝，按新的有效期重新确认
      if (input.bonusAmount > 0 && input.bonusValidDays !== undefined && input.bonusValidDays !== bonusValidDays) {
        throw conflict('PLAN_CHANGED', '赠金有效期刚刚有调整，请核对后重新确认', { bonusValidDays });
      }
      const bonusExpiresAt =
        input.bonusAmount > 0 && bonusValidDays !== null
          ? bonusExpiryAt(at, bonusValidDays, deps.config.timezone, settings.businessDayStartHour)
          : null;
      // 超过单笔上限：需要店主或店总当场授权，授权在这个事务里核销（业务回滚时一起回滚）
      const overLimit = input.paidAmount > settings.maxRechargeCents
        ? await approveOverLimit(tx, input.overLimitGrantId, ctx, { kind: 'recharge', memberId: member.id, amount: input.paidAmount, limit: settings.maxRechargeCents, key })
        : null;

      const businessDate = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
      const docNo = await nextDocNo(tx, 'recharge', businessDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO recharges (doc_no, member_id, plan_id, plan_name, paid_amount, bonus_amount, payment_method,
                               payment_ref, note, business_date, operator_id, created_at, over_limit_approved_by, bonus_expires_at)
        VALUES (${docNo}, ${member.id}, ${input.planId}, ${planName}, ${input.paidAmount}, ${input.bonusAmount},
                ${input.paymentMethod}, ${input.paymentRef}, ${input.note}, ${businessDate}, ${ctx.actor.id}, ${at},
                ${overLimit?.approverId ?? null}, ${bonusExpiresAt})
        RETURNING id`;
      const id = row!.id;
      await applyBalance(tx, member, { principal: input.paidAmount, bonus: input.bonusAmount }, {
        entryType: 'recharge', docNo, rechargeId: id, businessDate, operatorId: ctx.actor.id, at,
      });
      await addRechargeLot(tx, { memberId: member.id, rechargeId: id, amount: input.bonusAmount, expiresAt: bonusExpiresAt, at });
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'recharge_created',
        targetType: 'recharge',
        targetId: id,
        detail: {
          docNo, memberId: member.id, paid: input.paidAmount, bonus: input.bonusAmount, method: input.paymentMethod,
          ...(overLimit ? { overLimitApprovedBy: overLimit.approverId, overLimitApproverName: overLimit.approverName } : {}),
        },
        ip: ctx.ip,
        businessDate,
      });
      return id;
    },
  );
  return finish(deps, ctx, 'recharge', key, run);
}

// ───────────────────────── 消费 ─────────────────────────

export async function consume(deps: Deps, raw: ConsumeInputData, ctx: OpContext): Promise<OperationResult> {
  const input = parse(ConsumeInput, raw);
  const { idempotencyKey: key, ...payload } = input;
  if (input.customLines.length > 0 && !can(ctx.actor, 'consume.customAmount')) {
    throw forbidden('当前岗位不能手动输入消费金额');
  }
  await expireMemberBonus(deps, input.memberId, ctx.at ?? new Date());
  const run = await runIdempotent(
    deps.sql,
    { key, opType: 'consume', requestHash: hashRequest(payload), memberId: input.memberId, staffId: ctx.actor.id },
    async (tx, locked) => {
      const settings = await loadSettings(tx);
      const at = ctx.at ?? new Date();
      // 先作废到期的赠金：到期赠金不能再用，员工确认的余额若含到期赠金，下面的余额核对会要求重新确认
      const member = await expireDueLots(tx, deps, locked, at);
      if (member.status !== 'active') throw unprocessable('MEMBER_FROZEN', '该会员已停用，不能消费');

      // 项目价格以服务端为准，按所选价格档计价
      const items = await loadPricedItems(tx, input.lines.map((l) => l.itemId));
      const lines: { itemId: number | null; name: string; tier: PriceTier | null; unitPrice: number; quantity: number; amount: number }[] = [
        ...input.lines.map((l) => priceLine(items.get(l.itemId), l.tier, l.quantity, '有消费项目已停用，请重新选择')),
        ...input.customLines.map((l) => ({ itemId: null, name: l.name, tier: null, unitPrice: l.amount, quantity: 1, amount: l.amount })),
      ];
      const total = lines.reduce((sum, l) => sum + l.amount, 0);
      if (total !== input.expectedTotal) {
        throw conflict('PRICE_CHANGED', '消费金额与当前项目价格不一致，请核对后重新确认', { total });
      }
      const balance = { principal: member.principalBalance, bonus: member.bonusBalance };
      if (
        input.expectedBalance &&
        (input.expectedBalance.principal !== balance.principal || input.expectedBalance.bonus !== balance.bonus)
      ) {
        throw conflict('BALANCE_CHANGED', '会员余额刚刚发生变化，请核对最新余额后重新确认', { balance });
      }
      const split = splitDeduction(total, balance, settings.deductionRule);
      if (!split.ok) {
        throw unprocessable('INSUFFICIENT_BALANCE', `余额不足，还差 ¥${(split.shortfall / 100).toFixed(2)}`, {
          available: split.available,
          shortfall: split.shortfall,
          total,
        });
      }
      if (input.expectedSplit && (input.expectedSplit.principal !== split.principal || input.expectedSplit.bonus !== split.bonus)) {
        throw conflict('SPLIT_CHANGED', '扣款规则刚刚有调整，本金 / 赠金的扣款构成与确认时不同，请重新核对', {
          split: { principal: split.principal, bonus: split.bonus },
          rule: settings.deductionRule,
          balance,
        });
      }
      // 超过单笔上限：其余核对都通过后再核销授权
      const overLimit = total > settings.maxConsumeCents
        ? await approveOverLimit(tx, input.overLimitGrantId, ctx, { kind: 'consume', memberId: member.id, amount: total, limit: settings.maxConsumeCents, key })
        : null;

      const businessDate = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
      const docNo = await nextDocNo(tx, 'consume', businessDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO consumptions (doc_no, member_id, total_amount, principal_amount, bonus_amount, deduction_rule,
                                  note, business_date, operator_id, created_at, over_limit_approved_by)
        VALUES (${docNo}, ${member.id}, ${total}, ${split.principal}, ${split.bonus}, ${settings.deductionRule},
                ${input.note}, ${businessDate}, ${ctx.actor.id}, ${at}, ${overLimit?.approverId ?? null})
        RETURNING id`;
      const id = row!.id;
      for (const l of lines) {
        await tx`
          INSERT INTO consumption_lines (consumption_id, item_id, tier, name, unit_price, quantity, amount)
          VALUES (${id}, ${l.itemId}, ${l.tier}, ${l.name}, ${l.unitPrice}, ${l.quantity}, ${l.amount})`;
      }
      await applyBalance(tx, member, { principal: -split.principal, bonus: -split.bonus }, {
        entryType: 'consume', docNo, consumptionId: id, businessDate, operatorId: ctx.actor.id, at,
      });
      // 扣用的赠金先用最早到期的批次
      await takeFromLots(tx, { memberId: member.id, consumptionId: id, amount: split.bonus, at });
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'consumption_created',
        targetType: 'consumption',
        targetId: id,
        detail: {
          docNo, memberId: member.id, total, principal: split.principal, bonus: split.bonus, rule: settings.deductionRule,
          ...(overLimit ? { overLimitApprovedBy: overLimit.approverId, overLimitApproverName: overLimit.approverName } : {}),
        },
        ip: ctx.ip,
        businessDate,
      });
      return id;
    },
  );
  return finish(deps, ctx, 'consume', key, run);
}

// ───────────────────────── 撤销 ─────────────────────────

export async function reverse(deps: Deps, consumptionId: number, raw: ReverseInputData, ctx: OpContext): Promise<OperationResult> {
  const input = parse(ReverseInput, raw);
  const [target] = await deps.sql<{ memberId: number }[]>`SELECT member_id FROM consumptions WHERE id = ${consumptionId}`;
  if (!target) throw notFound('消费单不存在');
  await expireMemberBonus(deps, target.memberId, ctx.at ?? new Date());
  const run = await runIdempotent(
    deps.sql,
    {
      key: input.idempotencyKey,
      opType: 'reversal',
      requestHash: hashRequest({ consumptionId, reason: input.reason }),
      memberId: target.memberId,
      staffId: ctx.actor.id,
    },
    async (tx, locked) => {
      const settings = await loadSettings(tx);
      const at = ctx.at ?? new Date();
      const member = await expireDueLots(tx, deps, locked, at);
      // 锁顺序始终是「会员 → 消费单 → 赠金批次」，避免死锁
      const [c] = await tx<{ id: number; docNo: string; status: string; principalAmount: number; bonusAmount: number; businessDate: string; createdAt: Date }[]>`
        SELECT id, doc_no, status, principal_amount, bonus_amount, business_date, created_at FROM consumptions
        WHERE id = ${consumptionId} FOR UPDATE`;
      if (!c) throw notFound('消费单不存在');
      if (c.status !== 'completed') {
        const [r] = await tx<{ docNo: string }[]>`SELECT doc_no FROM reversals WHERE consumption_id = ${c.id}`;
        throw conflict('ALREADY_REVERSED', `该消费单已撤销${r ? `（撤销单 ${r.docNo}）` : ''}，不会重复恢复余额`);
      }
      // 撤销时限（#10，待确认）：超过时限只有店主可以撤销
      const windowHours = settings.reversalWindowHours;
      if (windowHours !== null && ctx.actor.role !== 'owner' && at.getTime() - new Date(c.createdAt).getTime() > windowHours * 3_600_000) {
        throw unprocessable('REVERSAL_WINDOW', `这笔消费已超过撤销时限（消费后 ${describeHours(windowHours)}内），只有店主可以撤销`, {
          windowHours,
          consumedAt: c.createdAt,
        });
      }

      const businessDate = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
      const docNo = await nextDocNo(tx, 'reversal', businessDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO reversals (doc_no, consumption_id, member_id, principal_amount, bonus_amount, reason,
                               business_date, operator_id, created_at)
        VALUES (${docNo}, ${c.id}, ${member.id}, ${c.principalAmount}, ${c.bonusAmount}, ${input.reason},
                ${businessDate}, ${ctx.actor.id}, ${at})
        RETURNING id`;
      const id = row!.id;
      await tx`UPDATE consumptions SET status = 'reversed' WHERE id = ${c.id}`;
      // 按原单扣款构成恢复，本金归本金、赠金归赠金；赠金回到原来的批次，原批次已到期的随即作废
      const restored = await applyBalance(tx, member, { principal: c.principalAmount, bonus: c.bonusAmount }, {
        entryType: 'reversal', docNo, consumptionId: c.id, reversalId: id, businessDate, operatorId: ctx.actor.id, at,
      });
      await restoreToLots(tx, { memberId: member.id, consumptionId: c.id, reversalId: id, amount: c.bonusAmount, at });
      await expireDueLots(tx, deps, restored, at, id);
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'consumption_reversed',
        targetType: 'reversal',
        targetId: id,
        detail: {
          docNo,
          consumptionDocNo: c.docNo,
          memberId: member.id,
          principal: c.principalAmount,
          bonus: c.bonusAmount,
          reason: input.reason,
          crossDay: c.businessDate !== businessDate,
        },
        ip: ctx.ip,
        businessDate,
      });
      return id;
    },
  );
  return finish(deps, ctx, 'reversal', input.idempotencyKey, run);
}

/**
 * 按操作编号查回结果（只读）。
 * 查不到只说明「此刻还没有已提交的结果」，原请求可能仍在路上或在等锁，页面不能据此断定没有入账；
 * 要放弃这笔，必须调用 abandonOperation。
 * expected 是页面记录的原业务类型：只有同一类型的作废登记才算「已作废」（别人伪报类型登记的不算）。
 */
export async function lookupOperation(sql: Sql, key: string, expected?: OpType): Promise<OperationLookup> {
  const row = await findKey(sql, key);
  if (row?.opType === 'abandoned') return { found: false, abandoned: true };
  // 库存、采购与前台有各自的查回接口，这里只查会员记账
  if (row) {
    if (!isWalletOp(row.opType)) return { found: false, abandoned: false };
    return { found: true, ...(await loadOperation(sql, row.opType, row.refId, true)) };
  }
  return { found: false, abandoned: await isFenced(sql, key, expected ? [expected] : OP_TYPES) };
}

/**
 * 作废一笔结果待确认的记账：登记「编号 + 原业务类型」的作废（单独提交，见 lib/fences.ts）。
 * - 登记成功：原请求无论还在路上、在等锁还是正在执行，写编号前都会看到作废并整笔回滚，永远不会入账；
 * - 编号已有结果：说明原操作已经入账，返回查回的结果，不作废；
 * - 原请求恰好正在写编号：这里等它提交（最多 5 秒）再给出确定答复，超时则仍为待确认。
 * 权限按 input.type 检查（路由），伪报类型的登记拦不下原请求。
 */
export async function abandonOperation(deps: Deps, key: string, input: AbandonInputParsed, ctx: OpContext): Promise<OperationLookup> {
  const outcome = await deps.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '10s'");
    const result = await fenceKey(tx, key, input.type, ctx.actor.id);
    if ('inserted' in result && result.inserted) {
      const settings = await loadSettings(tx);
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'operation_abandoned',
        targetType: input.memberId ? 'member' : 'operation',
        targetId: input.memberId ?? key,
        detail: {
          idempotencyKey: key,
          type: input.type,
          amount: input.amount ?? null,
          summary: [OP_LABELS[input.type], input.summary].filter(Boolean).join(' · '),
        },
        ip: ctx.ip,
        businessDate: businessDateOf(ctx.at ?? new Date(), deps.config.timezone, settings.businessDayStartHour),
      });
    }
    return result;
  });
  if (!('existingOpType' in outcome)) return { found: false, abandoned: true };
  if (outcome.existingOpType === 'abandoned') return { found: false, abandoned: true };
  if (!isWalletOp(outcome.existingOpType)) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号属于其他业务，不能在这里作废');
  return lookupOperation(deps.sql, key, input.type);
}

// ───────────────────────── 路由 ─────────────────────────

const OP_PERMISSION: Record<OpType, Permission> = { recharge: 'recharge.create', consume: 'consume.create', reversal: 'consume.reverse' };

export function registerWalletRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const ctxOf = (req: import('fastify').FastifyRequest): OpContext => ({ actor: req.actor, ip: req.ip });

  app.post('/api/recharges', { preHandler: guard('recharge.create') }, async (req) =>
    recharge(deps, req.body as RechargeInputData, ctxOf(req)),
  );

  app.get('/api/recharges/:id', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getRecharge(sql, id);
  });

  app.post('/api/consumptions', { preHandler: guard('consume.create') }, async (req) => {
    // 页面提交必须带上员工确认过的扣款构成（内部生成演示数据时可省略）
    parse(z.object({ expectedSplit: z.object(ExpectedSplit.shape, '缺少确认时的扣款构成，请刷新页面后重新核对') }), req.body);
    try {
      return await consume(deps, req.body as ConsumeInputData, ctxOf(req));
    } catch (error) {
      if (error instanceof AppError && error.code === 'INSUFFICIENT_BALANCE') {
        const body = req.body as { memberId?: number };
        await writeAudit(sql, {
          staffId: req.actor.id,
          action: 'consume_rejected',
          targetType: 'member',
          targetId: body.memberId,
          detail: { reason: 'insufficient', ...error.details },
          ip: req.ip,
          businessDate: businessDateOf(new Date(), deps.config.timezone, (await loadSettings(sql)).businessDayStartHour),
        });
      }
      throw error;
    }
  });

  app.get('/api/consumptions/:id', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getConsumption(sql, id);
  });

  app.post('/api/consumptions/:id/reverse', { preHandler: guard('consume.reverse') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return reverse(deps, id, req.body as ReverseInputData, ctxOf(req));
  });

  app.get('/api/reversals/:id', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getReversal(sql, id);
  });

  const KeyParam = z.object({ key: z.uuid('操作编号格式不正确') });

  // 页面超时或断网后，用提交时的操作编号查回结果；type 为页面记录的原业务类型
  app.get('/api/operations/:key', { preHandler: guard() }, async (req) => {
    const { key } = parse(KeyParam, req.params);
    const { type } = parse(z.object({ type: z.enum(OP_TYPES).optional() }), req.query ?? {});
    return lookupOperation(sql, key, type);
  });

  // 员工确认作废一笔结果待确认的记账：需要这项业务本身的权限（例如作废撤销需要撤销权限）
  app.post('/api/operations/:key/abandon', { preHandler: guard() }, async (req) => {
    const { key } = parse(KeyParam, req.params);
    const input = parse(AbandonInput, req.body ?? {});
    if (!can(req.actor, OP_PERMISSION[input.type])) throw forbidden();
    return abandonOperation(deps, key, input, ctxOf(req));
  });
}
