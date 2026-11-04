// 钱包的线上收款入口（v0.7.26，docs/MEMBERSHIP_FINISH.md 第 2 节；给小程序第二期，MP_RECHARGE.md 第 5 节第 1–3 条）。
//
// 小程序线的线上充值单到账时，在它自己的事务里调用 rechargeOnline，与充值单记「已到账」一起提交：
//   · 与前台充值同一条入账（recharges、ledger_entries、赠金批次、升档、充值赠券、首充礼），不另建余额；
//   · 经办人是系统账号「小程序」（system.mp，第一次入账时建，不能登录、不出现在员工名单里）；
//   · 渠道记 'mp'、不记班次：不进任何收银员的交班表、不算哪个钱箱的钱；日结、看板「线上（小程序）」单列；
//   · 收款方式微信，收款备注记微信支付的交易单号；同一个交易单号只入账一次（再调用返回第一次的充值单）；
//   · 赠金按充完以后所在档自动算；首充 / 续充最低、单笔上限照旧，不够或超过直接拒绝（线上没有当场授权）；
//   · 套餐只核对金额与是否启用，套餐上挂的券照发；
//   · 到账时会员已停用：钱已经付了，照样入账，结果里标出 frozen，小程序线记异常给店主看（MP_RECHARGE.md 第 3 节）；
//     来源会员已合并到另一位：记到合并进去的那位，结果里标出 mergedFrom。
//
// 加锁：会员一行（同一会员的充值、消费、退回都串行）。调用方可以先锁会员一行、再锁自己的充值单一行，再调用这里
// （同一事务里已经锁住的会员不会再等）；调用之前不要锁会员以外的业务行。同一张充值单的重复通知在调用方的充值单一行上排队，
// 交易单号的唯一索引兜底。

import { z } from 'zod';
import { bonusExpiryAt, businessDateOf } from '@shared/business-date';
import { gradeLabel } from '@shared/membership';
import { formatYuan } from '@shared/money';
import type { RechargeDoc } from '@shared/types';
import type { Db, Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors';
import { parse, positiveCents } from '../lib/validate';
import { addRechargeLot, expireDueLots } from './bonus';
import { issueRechargeCoupons } from './coupons';
import { onRecharge } from './benefits';
import { applyRechargeGrade, planRechargeGrade, previewRechargeGrade } from './membership';
import { loadSettings } from './settings';
import { getRecharge } from './wallet';
import { applyBalance, lockMember, nextDocNo, type LockedMember } from './wallet-core';

/** 系统账号「小程序」：线上收款的经办人 */
export const SYSTEM_MP_USERNAME = 'system.mp';
const SYSTEM_MP_NAME = '小程序';

const OnlineRechargeInput = z.object({
  memberId: z.number().int().positive('会员编号不对'),
  paidAmount: positiveCents('实付金额'),
  planId: z.number().int().positive().nullable(),
  paymentRef: z.string().trim().min(1, '缺少微信支付的交易单号').max(64, '交易单号太长'),
  orderNo: z.string().trim().min(1, '缺少线上充值单号').max(64, '线上充值单号太长'),
  at: z.date().optional(),
});
export type OnlineRechargeInput = z.input<typeof OnlineRechargeInput>;

export interface OnlineRechargeResult {
  recharge: RechargeDoc;
  /** 同一个交易单号已经入过账：返回第一次的充值单，这次没有再记账 */
  replayed: boolean;
  /** 入账的会员（来源会员合并掉了时是合并进去的那位） */
  memberId: number;
  /** 来源会员已合并：原来的会员编号 */
  mergedFrom: number | null;
  /** 到账时会员已停用（钱已经付了，照样入账；小程序线记异常给店主看） */
  frozen: boolean;
  /** 这次入账前后的档级（L0–L6）；重复调用（replayed）时为空 */
  grade: { before: number; after: number } | null;
}

/** 系统账号「小程序」的编号：第一次线上入账时建（不能登录：停用、没有能对上的密码；员工名单里不显示） */
export async function systemStaffId(tx: Tx): Promise<number> {
  const [row] = await tx<{ id: number; system: boolean }[]>`SELECT id, system FROM staff WHERE username = ${SYSTEM_MP_USERNAME}`;
  if (row?.system) return row.id;
  if (!row) {
    const [made] = await tx<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash, active, must_change_password, system)
      VALUES (${SYSTEM_MP_USERNAME}, ${SYSTEM_MP_NAME}, 'clerk', 'system:no-login', false, false, true)
      ON CONFLICT (username) DO NOTHING RETURNING id`;
    if (made) return made.id;
    // 同时有另一笔在建：它提交以后再读
    const [again] = await tx<{ id: number; system: boolean }[]>`SELECT id, system FROM staff WHERE username = ${SYSTEM_MP_USERNAME}`;
    if (again?.system) return again.id;
  }
  throw new AppError(500, 'SYSTEM_ACCOUNT_TAKEN', `员工账号 ${SYSTEM_MP_USERNAME} 被占用了，线上收款要用这个系统账号；请店主改掉那位员工的账号`);
}

/**
 * 记到哪位会员：来源会员合并掉了时沿着「合并到」找到最后那位（合并只追加，merged_into_id 设了就不再变），
 * 锁住以后再核对一次（锁之前刚被合并的，接着往下找）
 */
async function lockCreditMember(tx: Tx, memberId: number): Promise<{ member: LockedMember; mergedFrom: number | null }> {
  let id = memberId;
  for (let hop = 0; hop < 16; hop++) {
    const [row] = await tx<{ mergedIntoId: number | null }[]>`SELECT merged_into_id FROM members WHERE id = ${id}`;
    if (!row) throw notFound('会员不存在');
    if (row.mergedIntoId !== null) {
      id = row.mergedIntoId;
      continue;
    }
    const member = await lockMember(tx, id);
    const [locked] = await tx<{ mergedIntoId: number | null }[]>`SELECT merged_into_id FROM members WHERE id = ${id}`;
    if (locked!.mergedIntoId !== null) {
      id = locked!.mergedIntoId;
      continue;
    }
    return { member, mergedFrom: id === memberId ? null : memberId };
  }
  throw conflict('MEMBER_MERGE_LOOP', '这位会员的合并记录对不上，请店主核对');
}

async function replay(tx: Tx, id: number, input: z.infer<typeof OnlineRechargeInput>): Promise<OnlineRechargeResult> {
  const recharge = await getRecharge(tx, id);
  if (recharge.paidAmount !== input.paidAmount) {
    throw conflict('ONLINE_REF_CONFLICT', `交易单号 ${input.paymentRef} 已经入过账（${recharge.docNo}，${formatYuan(recharge.paidAmount)}），金额对不上`, {
      rechargeId: id,
    });
  }
  // 入账的会员是这位、或者这位后来合并进去的那位
  const [chain] = await tx<{ ok: boolean }[]>`
    WITH RECURSIVE up AS (
      SELECT id, merged_into_id FROM members WHERE id = ${input.memberId}
      UNION ALL
      SELECT m.id, m.merged_into_id FROM members m JOIN up ON m.id = up.merged_into_id
    )
    SELECT EXISTS (SELECT 1 FROM up WHERE id = ${recharge.memberId}) AS ok`;
  if (!chain?.ok) {
    throw conflict('ONLINE_REF_CONFLICT', `交易单号 ${input.paymentRef} 已经入过另一位会员的账（${recharge.docNo}）`, { rechargeId: id });
  }
  const [m] = await tx<{ status: 'active' | 'frozen' }[]>`SELECT status FROM members WHERE id = ${recharge.memberId}`;
  return {
    recharge,
    replayed: true,
    memberId: recharge.memberId,
    mergedFrom: recharge.memberId === input.memberId ? null : input.memberId,
    frozen: m?.status === 'frozen',
    grade: null,
  };
}

/**
 * 线上收款入账（调用方的事务里）：见文件开头。拒绝时抛 AppError（code 见下），调用方的事务跟着回滚：
 *   RECHARGE_BELOW_MIN 不够首充 / 续充最低；RECHARGE_OVER_LIMIT 超过单笔上限；PLAN_UNAVAILABLE / PLAN_CHANGED 套餐停用或改了金额；
 *   ONLINE_REF_CONFLICT 同一个交易单号已经入过别的会员或别的金额；NOT_FOUND 会员不存在
 */
export async function rechargeOnline(tx: Tx, deps: Deps, raw: OnlineRechargeInput): Promise<OnlineRechargeResult> {
  const input = parse(OnlineRechargeInput, raw);
  const at = input.at ?? new Date();
  const [dup] = await tx<{ id: number }[]>`SELECT id FROM recharges WHERE channel = 'mp' AND payment_ref = ${input.paymentRef}`;
  if (dup) return replay(tx, dup.id, input);

  const { member: locked, mergedFrom } = await lockCreditMember(tx, input.memberId);
  // 锁住会员以后再查一次：同一个交易单号的另一笔（另一张单子，不该有）刚提交
  const [dup2] = await tx<{ id: number }[]>`SELECT id FROM recharges WHERE channel = 'mp' AND payment_ref = ${input.paymentRef}`;
  if (dup2) return replay(tx, dup2.id, input);

  const settings = await loadSettings(tx);
  const member = await expireDueLots(tx, deps, locked, at);
  const businessDate = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
  const grade = await planRechargeGrade(tx, member.id, input.paidAmount, businessDate);
  if (grade.minimum > 0 && input.paidAmount < grade.minimum) {
    throw unprocessable('RECHARGE_BELOW_MIN', `${grade.first ? '首充' : '续充'}单笔最低 ${formatYuan(grade.minimum)}，这笔 ${formatYuan(input.paidAmount)} 不够`, {
      minimum: grade.minimum,
      first: grade.first,
    });
  }
  if (input.paidAmount > settings.maxRechargeCents) {
    throw unprocessable('RECHARGE_OVER_LIMIT', `超过单笔上限 ${formatYuan(settings.maxRechargeCents)}，线上没有当场授权`, { limit: settings.maxRechargeCents });
  }
  let planName: string | null = null;
  let bonusValidDays = settings.customBonusValidDays;
  if (input.planId !== null) {
    const [plan] = await tx<{ name: string; payAmount: number; active: boolean; bonusValidDays: number | null }[]>`
      SELECT name, pay_amount, active, bonus_valid_days FROM recharge_plans WHERE id = ${input.planId}`;
    if (!plan || !plan.active) throw conflict('PLAN_UNAVAILABLE', '这个充值套餐已停用');
    if (plan.payAmount !== input.paidAmount) throw conflict('PLAN_CHANGED', `充值套餐「${plan.name}」现在是 ${formatYuan(plan.payAmount)}，与实付金额对不上`);
    planName = plan.name;
    bonusValidDays = plan.bonusValidDays;
  }
  const bonus = grade.outcome.bonusCents;
  const bonusExpiresAt = bonus > 0 && bonusValidDays !== null ? bonusExpiryAt(at, bonusValidDays, deps.config.timezone, settings.businessDayStartHour) : null;
  const staffId = await systemStaffId(tx);

  const docNo = await nextDocNo(tx, 'recharge', businessDate);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO recharges (doc_no, member_id, plan_id, plan_name, paid_amount, bonus_amount, payment_method,
                           payment_ref, note, business_date, operator_id, created_at, bonus_expires_at, shift_id, channel)
    VALUES (${docNo}, ${member.id}, ${input.planId}, ${planName}, ${input.paidAmount}, ${bonus},
            'wechat', ${input.paymentRef}, ${`小程序充值单 ${input.orderNo}`}, ${businessDate}, ${staffId}, ${at}, ${bonusExpiresAt}, NULL, 'mp')
    RETURNING id`;
  const id = row!.id;
  await applyBalance(tx, member, { principal: input.paidAmount, bonus }, { entryType: 'recharge', docNo, rechargeId: id, businessDate, operatorId: staffId, at });
  await addRechargeLot(tx, { memberId: member.id, rechargeId: id, amount: bonus, expiresAt: bonusExpiresAt, at });
  await applyRechargeGrade(tx, grade, { memberId: member.id, rechargeId: id, today: businessDate });
  await issueRechargeCoupons(tx, {
    memberId: member.id,
    planId: input.planId,
    rechargeId: id,
    levelBefore: grade.state.grade,
    levelAfter: grade.outcome.gradeAfter,
    staffId,
    at,
    date: businessDate,
  });
  await onRecharge(tx, { memberId: member.id, first: grade.first, date: businessDate, staffId });
  const frozen = member.status !== 'active';
  await writeAudit(tx, {
    staffId,
    action: 'recharge_online',
    targetType: 'recharge',
    targetId: id,
    detail: {
      docNo,
      memberId: member.id,
      memberName: member.name,
      paid: input.paidAmount,
      bonus,
      orderNo: input.orderNo,
      paymentRef: input.paymentRef,
      gradeBefore: grade.state.grade,
      gradeAfter: grade.outcome.gradeAfter,
      ...(frozen ? { frozen: true } : {}),
      ...(mergedFrom !== null ? { mergedFrom } : {}),
      summary: `小程序充值 ${formatYuan(input.paidAmount)}${bonus ? `，赠 ${formatYuan(bonus)}` : ''}（${gradeLabel(grade.rules, grade.outcome.gradeAfter, grade.outcome.upgraded ? 0 : grade.state.tier)}）`,
    },
    businessDate,
  });
  return {
    recharge: await getRecharge(tx, id),
    replayed: false,
    memberId: member.id,
    mergedFrom,
    frozen,
    grade: { before: grade.state.grade, after: grade.outcome.gradeAfter },
  };
}

export interface OnlineRechargePreview {
  /** 按此刻的规则：这笔充完的赠金（分）、档级与阶位、档阶名称 */
  bonus: number;
  gradeBefore: number;
  gradeAfter: number;
  upgraded: boolean;
  label: string;
  /** 首充还是续充、单笔最低（分，0 = 不限） */
  first: boolean;
  minimum: number;
  /** 前台的单笔上限（分）：线上不能超过它 */
  maxSingle: number;
  /** 会员停用了（不能下单） */
  frozen: boolean;
  /** 来源会员已合并：线上下单应该用合并进去的那位 */
  mergedInto: number | null;
}

/** 只读预估（小程序下单页「以到账时为准」）：到期没处理的按规则推算，不写任何东西 */
export async function previewOnlineRecharge(db: Db, deps: Deps, memberId: number, paidAmount: number, now = new Date()): Promise<OnlineRechargePreview> {
  const settings = await loadSettings(db);
  const today = businessDateOf(now, deps.config.timezone, settings.businessDayStartHour);
  const [m] = await db<{ status: 'active' | 'frozen'; mergedIntoId: number | null }[]>`SELECT status, merged_into_id FROM members WHERE id = ${memberId}`;
  if (!m) throw notFound('会员不存在');
  const g = await previewRechargeGrade(db, memberId, paidAmount, today);
  return {
    bonus: g.outcome.bonusCents,
    gradeBefore: g.state.grade,
    gradeAfter: g.outcome.gradeAfter,
    upgraded: g.outcome.upgraded,
    label: gradeLabel(g.rules, g.outcome.gradeAfter, g.outcome.upgraded ? 0 : g.state.tier),
    first: g.first,
    minimum: g.minimum,
    maxSingle: settings.maxRechargeCents,
    frozen: m.status !== 'active',
    mergedInto: m.mergedIntoId,
  };
}
