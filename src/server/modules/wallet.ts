// 会员钱包记账核心：充值、消费、撤销。
//
// 每笔操作在一个数据库事务内完成「单据 + 流水 + 余额」，要么全部成功，要么全部失败。
// 并发与重复提交的处理：
//   1. 先对会员行加锁（SELECT … FOR UPDATE），同一会员的操作严格串行；
//   2. 加锁后检查幂等键：同一个键再次提交时直接返回第一次的结果，不会重复记账；
//   3. 余额字段有 CHECK (>= 0) 约束兜底，任何情况下都不会透支。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import { splitDeduction, type WalletBalance } from '@shared/deduction';
import { PAYMENT_METHODS } from '@shared/labels';
import { can } from '@shared/permissions';
import type { ConsumptionDoc, OperationLookup, OperationResult, RechargeDoc, ReversalDoc } from '@shared/types';
import { isUniqueViolation, type Db, type Sql, type Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { idParam, parse, positiveCents, cents } from '../lib/validate';
import { getMember } from './members';
import { loadSettings } from './settings';

type OpType = 'recharge' | 'consume' | 'reversal';
const DOC_PREFIX: Record<OpType, string> = { recharge: 'CZ', consume: 'XF', reversal: 'CX' };

// ───────────────────────── 输入 ─────────────────────────

const idempotencyKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');

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
});
export type RechargeInputData = z.input<typeof RechargeInput>;

const ExpectedSplit = z.object({ principal: cents('扣本金'), bonus: cents('扣赠金') });

export const ConsumeInput = z
  .object({
    idempotencyKey,
    memberId: z.number().int().positive(),
    lines: z
      .array(z.object({ itemId: z.number().int().positive(), quantity: z.number().int().min(1).max(99, '单项数量最多 99') }))
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
  })
  .refine((v) => v.lines.length + v.customLines.length > 0, '请至少选择一个消费项目');
export type ConsumeInputData = z.input<typeof ConsumeInput>;

export const ReverseInput = z.object({
  idempotencyKey,
  reason: z.string().trim().min(2, '请填写撤销原因（至少 2 个字）').max(200, '撤销原因最多 200 字'),
});
export type ReverseInputData = z.input<typeof ReverseInput>;

// ───────────────────────── 基础工具 ─────────────────────────

interface LockedMember {
  id: number;
  name: string;
  principalBalance: number;
  bonusBalance: number;
  status: 'active' | 'frozen';
}

async function lockMember(tx: Tx, id: number): Promise<LockedMember> {
  const [m] = await tx<LockedMember[]>`
    SELECT id, name, principal_balance, bonus_balance, status FROM members WHERE id = ${id} FOR UPDATE`;
  if (!m) throw notFound('会员不存在');
  return m;
}

async function nextDocNo(tx: Tx, type: OpType, businessDate: string): Promise<string> {
  const [row] = await tx<{ lastNo: number }[]>`
    INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES (${type}, ${businessDate}, 1)
    ON CONFLICT (doc_type, business_date) DO UPDATE SET last_no = doc_counters.last_no + 1
    RETURNING last_no`;
  return `${DOC_PREFIX[type]}${businessDate.replaceAll('-', '')}-${String(row!.lastNo).padStart(4, '0')}`;
}

const hashRequest = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

interface KeyRow {
  opType: OpType;
  requestHash: string;
  refId: number;
}

async function findKey(db: Db, key: string): Promise<KeyRow | undefined> {
  const [row] = await db<KeyRow[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${key}`;
  return row;
}

function assertSameRequest(row: KeyRow, opType: OpType, requestHash: string) {
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
      const refId = await body(tx, member);
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

async function applyBalance(
  tx: Tx,
  member: LockedMember,
  delta: WalletBalance,
  entry: {
    entryType: OpType;
    docNo: string;
    rechargeId?: number;
    consumptionId?: number;
    reversalId?: number;
    businessDate: string;
    operatorId: number;
    at: Date;
  },
) {
  const after = { principal: member.principalBalance + delta.principal, bonus: member.bonusBalance + delta.bonus };
  if (after.principal < 0 || after.bonus < 0) {
    throw new AppError(500, 'BALANCE_INVARIANT', '余额计算异常，已阻止本次记账');
  }
  await tx`
    UPDATE members SET principal_balance = ${after.principal}, bonus_balance = ${after.bonus}, updated_at = now()
    WHERE id = ${member.id}`;
  await tx`
    INSERT INTO ledger_entries (member_id, entry_type, recharge_id, consumption_id, reversal_id, doc_no,
                                principal_delta, bonus_delta, principal_after, bonus_after,
                                business_date, operator_id, created_at)
    VALUES (${member.id}, ${entry.entryType}, ${entry.rechargeId ?? null}, ${entry.consumptionId ?? null},
            ${entry.reversalId ?? null}, ${entry.docNo}, ${delta.principal}, ${delta.bonus},
            ${after.principal}, ${after.bonus}, ${entry.businessDate}, ${entry.operatorId}, ${entry.at})`;
}

// ───────────────────────── 读取单据 ─────────────────────────

export async function getRecharge(db: Db, id: number): Promise<RechargeDoc> {
  const [row] = await db<RechargeDoc[]>`
    SELECT r.id, r.doc_no, r.member_id, r.plan_id, r.plan_name, r.paid_amount, r.bonus_amount, r.payment_method,
           r.payment_ref, r.note, r.business_date, s.display_name AS operator_name, r.created_at
    FROM recharges r JOIN staff s ON s.id = r.operator_id WHERE r.id = ${id}`;
  if (!row) throw notFound('充值单不存在');
  return row;
}

export async function getConsumption(db: Db, id: number): Promise<ConsumptionDoc> {
  const [row] = await db<ConsumptionDoc[]>`
    SELECT c.id, c.doc_no, c.member_id, c.total_amount, c.principal_amount, c.bonus_amount, c.deduction_rule,
           c.note, c.status, c.business_date, s.display_name AS operator_name, c.created_at,
           coalesce((
             SELECT json_agg(json_build_object('id', l.id, 'itemId', l.item_id, 'name', l.name, 'unitPrice', l.unit_price,
                                               'quantity', l.quantity, 'amount', l.amount) ORDER BY l.id)
             FROM consumption_lines l WHERE l.consumption_id = c.id), '[]'::json) AS lines,
           (SELECT json_build_object('id', r.id, 'docNo', r.doc_no, 'reason', r.reason, 'businessDate', r.business_date,
                                     'operatorName', rs.display_name, 'createdAt', r.created_at)
            FROM reversals r JOIN staff rs ON rs.id = r.operator_id WHERE r.consumption_id = c.id) AS reversal
    FROM consumptions c JOIN staff s ON s.id = c.operator_id WHERE c.id = ${id}`;
  if (!row) throw notFound('消费单不存在');
  return row;
}

export async function getReversal(db: Db, id: number): Promise<ReversalDoc> {
  const [row] = await db<ReversalDoc[]>`
    SELECT r.id, r.doc_no, r.consumption_id, c.doc_no AS consumption_doc_no, r.member_id, r.principal_amount,
           r.bonus_amount, r.reason, r.business_date, s.display_name AS operator_name, r.created_at
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
      return {
        type: 'reversal',
        replayed,
        reversal,
        consumption: await getConsumption(db, reversal.consumptionId),
        ...(await balancesOf(db, 'reversal_id', refId)),
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

// ───────────────────────── 充值 ─────────────────────────

export async function recharge(deps: Deps, raw: RechargeInputData, ctx: OpContext): Promise<OperationResult> {
  const input = parse(RechargeInput, raw);
  const { idempotencyKey: key, ...payload } = input;
  const run = await runIdempotent(
    deps.sql,
    { key, opType: 'recharge', requestHash: hashRequest(payload), memberId: input.memberId, staffId: ctx.actor.id },
    async (tx, member) => {
      const settings = await loadSettings(tx);
      if (member.status !== 'active') throw unprocessable('MEMBER_FROZEN', '该会员已停用，不能充值');

      let planName: string | null = null;
      if (input.planId) {
        const [plan] = await tx<{ name: string; payAmount: number; bonusAmount: number; active: boolean }[]>`
          SELECT name, pay_amount, bonus_amount, active FROM recharge_plans WHERE id = ${input.planId}`;
        if (!plan || !plan.active) throw conflict('PLAN_UNAVAILABLE', '该充值套餐已停用，请重新选择');
        if (plan.payAmount !== input.paidAmount || plan.bonusAmount !== input.bonusAmount) {
          throw conflict('PLAN_CHANGED', '充值套餐金额刚刚有调整，请核对后重新确认');
        }
        planName = plan.name;
      } else if (input.bonusAmount > 0 && !can(ctx.actor.role, 'recharge.customBonus')) {
        throw forbidden('当前岗位不能自定义赠金，请选择充值套餐');
      }
      if (input.paidAmount > settings.maxRechargeCents) {
        throw unprocessable('AMOUNT_TOO_LARGE', '超过单笔充值上限，请核对金额或联系店主', { limit: settings.maxRechargeCents });
      }

      const at = ctx.at ?? new Date();
      const businessDate = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
      const docNo = await nextDocNo(tx, 'recharge', businessDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO recharges (doc_no, member_id, plan_id, plan_name, paid_amount, bonus_amount, payment_method,
                               payment_ref, note, business_date, operator_id, created_at)
        VALUES (${docNo}, ${member.id}, ${input.planId}, ${planName}, ${input.paidAmount}, ${input.bonusAmount},
                ${input.paymentMethod}, ${input.paymentRef}, ${input.note}, ${businessDate}, ${ctx.actor.id}, ${at})
        RETURNING id`;
      const id = row!.id;
      await applyBalance(tx, member, { principal: input.paidAmount, bonus: input.bonusAmount }, {
        entryType: 'recharge', docNo, rechargeId: id, businessDate, operatorId: ctx.actor.id, at,
      });
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'recharge_created',
        targetType: 'recharge',
        targetId: id,
        detail: { docNo, memberId: member.id, paid: input.paidAmount, bonus: input.bonusAmount, method: input.paymentMethod },
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
  if (input.customLines.length > 0 && !can(ctx.actor.role, 'consume.customAmount')) {
    throw forbidden('当前岗位不能手动输入消费金额');
  }
  const run = await runIdempotent(
    deps.sql,
    { key, opType: 'consume', requestHash: hashRequest(payload), memberId: input.memberId, staffId: ctx.actor.id },
    async (tx, member) => {
      const settings = await loadSettings(tx);
      if (member.status !== 'active') throw unprocessable('MEMBER_FROZEN', '该会员已停用，不能消费');

      // 项目价格以服务端为准
      const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
      const items = itemIds.length
        ? await tx<{ id: number; name: string; price: number; active: boolean }[]>`
            SELECT id, name, price, active FROM service_items WHERE id IN ${tx(itemIds)}`
        : [];
      const byId = new Map(items.map((i) => [i.id, i]));
      const lines = [
        ...input.lines.map((l) => {
          const item = byId.get(l.itemId);
          if (!item || !item.active) throw conflict('ITEM_UNAVAILABLE', '有消费项目已停用，请重新选择');
          return { itemId: item.id, name: item.name, unitPrice: item.price, quantity: l.quantity, amount: item.price * l.quantity };
        }),
        ...input.customLines.map((l) => ({ itemId: null, name: l.name, unitPrice: l.amount, quantity: 1, amount: l.amount })),
      ];
      const total = lines.reduce((sum, l) => sum + l.amount, 0);
      if (total !== input.expectedTotal) {
        throw conflict('PRICE_CHANGED', '消费金额与当前项目价格不一致，请核对后重新确认', { total });
      }
      if (total > settings.maxConsumeCents) {
        throw unprocessable('AMOUNT_TOO_LARGE', '超过单笔消费上限，请核对金额或联系店主', { limit: settings.maxConsumeCents });
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

      const at = ctx.at ?? new Date();
      const businessDate = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
      const docNo = await nextDocNo(tx, 'consume', businessDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO consumptions (doc_no, member_id, total_amount, principal_amount, bonus_amount, deduction_rule,
                                  note, business_date, operator_id, created_at)
        VALUES (${docNo}, ${member.id}, ${total}, ${split.principal}, ${split.bonus}, ${settings.deductionRule},
                ${input.note}, ${businessDate}, ${ctx.actor.id}, ${at})
        RETURNING id`;
      const id = row!.id;
      for (const l of lines) {
        await tx`
          INSERT INTO consumption_lines (consumption_id, item_id, name, unit_price, quantity, amount)
          VALUES (${id}, ${l.itemId}, ${l.name}, ${l.unitPrice}, ${l.quantity}, ${l.amount})`;
      }
      await applyBalance(tx, member, { principal: -split.principal, bonus: -split.bonus }, {
        entryType: 'consume', docNo, consumptionId: id, businessDate, operatorId: ctx.actor.id, at,
      });
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'consumption_created',
        targetType: 'consumption',
        targetId: id,
        detail: { docNo, memberId: member.id, total, principal: split.principal, bonus: split.bonus, rule: settings.deductionRule },
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
  const run = await runIdempotent(
    deps.sql,
    {
      key: input.idempotencyKey,
      opType: 'reversal',
      requestHash: hashRequest({ consumptionId, reason: input.reason }),
      memberId: target.memberId,
      staffId: ctx.actor.id,
    },
    async (tx, member) => {
      const settings = await loadSettings(tx);
      // 锁顺序始终是「会员 → 消费单」，避免死锁
      const [c] = await tx<{ id: number; docNo: string; status: string; principalAmount: number; bonusAmount: number; businessDate: string }[]>`
        SELECT id, doc_no, status, principal_amount, bonus_amount, business_date FROM consumptions
        WHERE id = ${consumptionId} FOR UPDATE`;
      if (!c) throw notFound('消费单不存在');
      if (c.status !== 'completed') {
        const [r] = await tx<{ docNo: string }[]>`SELECT doc_no FROM reversals WHERE consumption_id = ${c.id}`;
        throw conflict('ALREADY_REVERSED', `该消费单已撤销${r ? `（撤销单 ${r.docNo}）` : ''}，不会重复恢复余额`);
      }

      const at = ctx.at ?? new Date();
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
      // 按原单扣款构成恢复，本金归本金、赠金归赠金
      await applyBalance(tx, member, { principal: c.principalAmount, bonus: c.bonusAmount }, {
        entryType: 'reversal', docNo, consumptionId: c.id, reversalId: id, businessDate, operatorId: ctx.actor.id, at,
      });
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

export async function lookupOperation(sql: Sql, key: string): Promise<OperationLookup> {
  const row = await findKey(sql, key);
  if (!row) return { found: false };
  return { found: true, ...(await loadOperation(sql, row.opType, row.refId, true)) };
}

// ───────────────────────── 路由 ─────────────────────────

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

  // 页面超时或断网后，用提交时的操作编号查回结果
  app.get('/api/operations/:key', { preHandler: guard() }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid('操作编号格式不正确') }), req.params);
    return lookupOperation(sql, key);
  });
}
