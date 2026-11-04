// 储值退回（v0.7.26，docs/MEMBERSHIP_FINISH.md 第 1 节；PENDING_DECISIONS M69–M74；店主 2026-11-04 交给主线开发，MP21）。
//
//   · 会员详情「退储值」：店员及以上发起（member.refund），店主或店总当场授权（member_refund，绑定会员与本金），授权人记在单子上；
//   · 退本金余额以内；赠金按比例扣回（本金退到 0 时全部扣回），赠金不退钱（M70）；
//   · 按原收款方式（M71）：剩下的本金算作最近的几笔充值，退的本金按最近的先退、分到每一笔，每一行用那一笔的收款方式；
//     期初余额与合并转入的没有原收款方式，按员工选的方式退；页面先列出分配，提交时重新分配、不一致拒绝；
//   · 现金从选定的钱箱退（与退款单同一套，lockRefundShift），不选就是自己的班次（lockPaymentShift）；扫码、银行卡登记退款单号（M72）；
//   · 一张退储值单 + 每一行 + 一条余额流水「储值退回」+ 赠金批次的扣回；不能作废（M74）；
//   · 靠充值升上来、扣完够不上这一档的当场降档（M73，membership.onRefundGrade）；券不收回；
//   · 线上充值的那一行（v0.7.27，MP21，docs/MP_RECHARGE.md 第 9 节）：小程序线的原路退回注册并打开时（registerOnlineRefundRoute），
//     可以交给门店系统原路退回（route = mp_auto，不填退款单号），小程序线用 listOnlineRefundLines 按行取、调微信支付的退款接口；
//     没注册或没打开时与 v0.7.26 一样要在商户平台退、填退款单号，免得钱没退出去，或者退两次。
// 加锁顺序：操作编号的咨询锁（与「确认作废」串行）→ 经办人或所选钱箱的班次（共享锁）→ 会员一行（到期没处理的赠金先作废）→ 授权一行
// → 赠金批次（id 升序）；之后按到期没处理的档阶先处理、再判断降档（会员一行已锁）。与充值、消费锁的是同一把会员锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from '@shared/labels';
import {
  allocateRefund,
  attributeBalance,
  onlineRoutable,
  REFUND_ROUTES,
  REFUND_SOURCES,
  refundBonus,
  refundRefRequired,
  type MemberRefundDetail,
  type MemberRefundPlan,
  type RefundPlanLine,
  type RefundRoute,
  type RefundSourceRow,
} from '@shared/member-refunds';
import type { RefundShiftOptions } from '@shared/checkout';
import { formatYuan } from '@shared/money';
import { guard } from '../auth/guard';
import { consumeMemberRefundGrant } from '../auth/grants';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { cents, idParam, parse, positiveCents } from '../lib/validate';
import { expireDueLots, takeForRefund } from './bonus';
import { erpOpAbandoned } from './erp-ops';
import { onRefundGrade, previewRefundGrade } from './membership';
import { loadSettings } from './settings';
import { lockPaymentShift, lockRefundShift, openShiftOf } from './shifts';
import { applyBalance, lockMember } from './wallet-core';

// ───────────────────────── 线上充值的原路退回（v0.7.27） ─────────────────────────

/** 小程序线的原路退回（docs/MP_RECHARGE.md 第 9 节）：接上、微信支付配好并打开时，由小程序线在启动时注册 */
export interface OnlineRefundRoute {
  /** 此刻能不能接新的原路退回（出错按不能处理） */
  available(db: Db): Promise<boolean>;
}

let onlineRefundRoute: OnlineRefundRoute | null = null;

/** 小程序线注册原路退回（传 null 撤掉）。没注册时线上充值的那一行与 v0.7.26 一样，要在商户平台退、填退款单号 */
export function registerOnlineRefundRoute(route: OnlineRefundRoute | null): void {
  onlineRefundRoute = route;
}

async function onlineRouteAvailable(db: Db): Promise<boolean> {
  if (!onlineRefundRoute) return false;
  try {
    return (await onlineRefundRoute.available(db)) === true;
  } catch {
    return false;
  }
}

/** 交给门店系统原路退回的一行（小程序线按 lineId 唯一建原路退回单） */
export interface OnlineRefundLine {
  lineId: number;
  refundId: number;
  refundNo: string;
  memberId: number;
  rechargeId: number;
  rechargeDocNo: string;
  /** 充值单上的微信支付交易单号 */
  paymentRef: string;
  /** 这一行退的本金（分） */
  amount: number;
  createdAt: string;
}

/** 交给门店系统原路退回的行（只读）：行号大于 afterId 的，按行号升序，最多 limit 行（1–500，默认 100） */
export async function listOnlineRefundLines(db: Db, opts: { afterId?: number; limit?: number } = {}): Promise<OnlineRefundLine[]> {
  const afterId = Math.max(0, Math.trunc(opts.afterId ?? 0));
  const limit = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 100)));
  const rows = await db<{ lineId: number; refundId: number; refundNo: string; memberId: number; rechargeId: number; rechargeDocNo: string; paymentRef: string; amount: number; createdAt: Date }[]>`
    SELECT l.id AS line_id, r.id AS refund_id, r.refund_no, r.member_id, rc.id AS recharge_id, rc.doc_no AS recharge_doc_no,
           rc.payment_ref, l.amount, r.created_at
    FROM member_refund_lines l JOIN member_refunds r ON r.id = l.refund_id JOIN recharges rc ON rc.id = l.recharge_id
    WHERE l.route = 'mp_auto' AND l.id > ${afterId}
    ORDER BY l.id LIMIT ${limit}`;
  return rows.map((r) => ({
    lineId: Number(r.lineId),
    refundId: Number(r.refundId),
    refundNo: r.refundNo,
    memberId: Number(r.memberId),
    rechargeId: Number(r.rechargeId),
    rechargeDocNo: r.rechargeDocNo,
    paymentRef: r.paymentRef,
    amount: Number(r.amount),
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

// ───────────────────────── 可退的各笔 ─────────────────────────

/** 这位会员进过本金的各笔（充值、有效的期初、合并转入）与已经退过多少；还没按余额分 */
async function rawSources(db: Db, memberId: number): Promise<Omit<RefundSourceRow, 'remaining'>[]> {
  const recharges = await db<{ id: number; docNo: string; date: string; at: Date; method: PaymentMethod; channel: 'counter' | 'mp'; amount: number; refunded: number }[]>`
    SELECT r.id, r.doc_no, to_char(r.business_date, 'YYYY-MM-DD') AS date, r.created_at AS at, r.payment_method AS method, r.channel,
           r.paid_amount AS amount,
           coalesce((SELECT sum(l.amount) FROM member_refund_lines l WHERE l.recharge_id = r.id), 0)::bigint AS refunded
    FROM recharges r WHERE r.member_id = ${memberId}`;
  const openings = await db<{ id: number; docNo: string; date: string; at: Date; amount: number; refunded: number }[]>`
    SELECT b.id, b.doc_no, to_char(i.business_date, 'YYYY-MM-DD') AS date, i.created_at AS at, b.principal AS amount,
           coalesce((SELECT sum(l.amount) FROM member_refund_lines l WHERE l.opening_id = b.id), 0)::bigint AS refunded
    FROM opening_balances b JOIN opening_imports i ON i.id = b.import_id
    WHERE b.member_id = ${memberId} AND b.status = 'active' AND b.principal > 0`;
  const merges = await db<{ id: number; docNo: string; date: string; at: Date; amount: number; refunded: number }[]>`
    SELECT g.id, g.merge_no AS doc_no, to_char(g.business_date, 'YYYY-MM-DD') AS date, g.created_at AS at, g.principal AS amount,
           coalesce((SELECT sum(l.amount) FROM member_refund_lines l WHERE l.member_merge_id = g.id), 0)::bigint AS refunded
    FROM member_merges g WHERE g.target_id = ${memberId} AND g.principal > 0`;
  const iso = (d: Date) => new Date(d).toISOString();
  return [
    ...recharges.map((r) => ({ source: 'recharge' as const, id: Number(r.id), docNo: r.docNo, date: r.date, at: iso(r.at), method: r.method, channel: r.channel, amount: Number(r.amount), refunded: Number(r.refunded) })),
    ...openings.map((o) => ({ source: 'opening' as const, id: Number(o.id), docNo: o.docNo, date: o.date, at: iso(o.at), method: null, channel: null, amount: Number(o.amount), refunded: Number(o.refunded) })),
    ...merges.map((g) => ({ source: 'merge' as const, id: Number(g.id), docNo: g.docNo, date: g.date, at: iso(g.at), method: null, channel: null, amount: Number(g.amount), refunded: Number(g.refunded) })),
  ];
}

const today = async (db: Db, timezone: string, at = new Date()) => businessDateOf(at, timezone, (await loadSettings(db)).businessDayStartHour);

const refundedByRecharge = (lines: readonly { source: string; id: number; amount: number }[]) => {
  const m = new Map<number, number>();
  for (const l of lines) if (l.source === 'recharge') m.set(l.id, (m.get(l.id) ?? 0) + l.amount);
  return m;
};

interface MemberRow {
  id: number;
  memberNo: string;
  name: string;
  status: 'active' | 'frozen';
  principalBalance: number;
  bonusBalance: number;
  mergedIntoNo: string | null;
}

async function memberRow(db: Db, memberId: number): Promise<MemberRow> {
  const [m] = await db<MemberRow[]>`
    SELECT m.id, m.member_no, m.name, m.status, m.principal_balance, m.bonus_balance, t.member_no AS merged_into_no
    FROM members m LEFT JOIN members t ON t.id = m.merged_into_id WHERE m.id = ${memberId}`;
  if (!m) throw notFound('会员不存在');
  return m;
}

const blockedReason = (m: MemberRow): string | null =>
  m.mergedIntoNo ? `这位会员已合并到 ${m.mergedIntoNo}，余额已经转过去，请到那位会员那里退` : m.principalBalance <= 0 ? '这位会员没有本金余额，没有可退的储值' : null;

/** 退储值前的核对（只读）：amount 不带时按全部本金 */
export async function memberRefundPlan(deps: Deps, memberId: number, amount: number | undefined, at = new Date()): Promise<MemberRefundPlan> {
  const db = deps.sql;
  const m = await memberRow(db, memberId);
  const date = await today(db, deps.config.timezone, at);
  const sources = attributeBalance(await rawSources(db, memberId), m.principalBalance).filter((s) => s.remaining > 0);
  const blocked = blockedReason(m);
  const want = blocked ? 0 : Math.min(amount ?? m.principalBalance, m.principalBalance);
  const lines = blocked ? [] : allocateRefund(sources, want);
  return {
    memberId: m.id,
    memberNo: m.memberNo,
    memberName: m.name,
    status: m.status,
    principalBalance: m.principalBalance,
    bonusBalance: m.bonusBalance,
    amount: want,
    bonus: blocked ? 0 : refundBonus(m.principalBalance, m.bonusBalance, want),
    lines,
    sources,
    grade: blocked || want <= 0 ? null : await previewRefundGrade(db, memberId, refundedByRecharge(lines), date),
    blocked,
    onlineRoute: await onlineRouteAvailable(db),
  };
}

/** 退现金能选的钱箱：此刻当班（未交班、不是升级前开的）的班次；默认自己的，只有一个当班的班次时选它 */
export async function refundDrawers(db: Db, actorId: number): Promise<RefundShiftOptions> {
  const rows = await db<{ id: number; shiftNo: string; staffId: number; staffName: string; startedAt: string }[]>`
    SELECT s.id, s.shift_no, s.staff_id, st.display_name AS staff_name, s.started_at
    FROM shifts s JOIN staff st ON st.id = s.staff_id WHERE s.status = 'open' AND NOT s.legacy_refund ORDER BY s.started_at, s.id`;
  const shifts = rows.map((r) => ({ id: r.id, shiftNo: r.shiftNo, staffName: r.staffName, startedAt: new Date(r.startedAt).toISOString(), mine: r.staffId === actorId, original: false }));
  const suggested = (shifts.find((x) => x.mine) ?? (shifts.length === 1 ? shifts[0] : undefined))?.id ?? null;
  return { shifts, suggested };
}

// ───────────────────────── 退储值 ─────────────────────────

const LineInput = z.object({
  source: z.enum(REFUND_SOURCES, '退的是哪一笔不正确，请刷新后重试'),
  id: z.number('退的是哪一笔不正确，请刷新后重试').int().positive(),
  method: z.enum(PAYMENT_METHODS, '请选择退款方式'),
  amount: positiveCents('退的金额'),
  /** 微信、支付宝、银行卡：商户后台的退款单号；其他：写明怎么退的 */
  ref: z.string().trim().max(64, '退款单号最多 64 字').default(''),
  /** 怎么退（v0.7.27）：员工退；或线上充值的那一行交给门店系统原路退回（不填退款单号） */
  route: z.enum(REFUND_ROUTES, '退款方式不正确，请刷新后重试').default('manual'),
});
export const MemberRefundInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  /** 退的本金（页面核对时看到的） */
  amount: positiveCents('退的本金'),
  /** 页面核对时看到的扣回赠金 */
  expectedBonus: cents('扣回的赠金'),
  lines: z.array(LineInput).min(1, '请核对退回的明细').max(60, '退回的明细最多 60 行'),
  reason: z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 字'),
  /** 退现金从哪个钱箱退（所选钱箱当班的班次）；不带时记到经办人自己的班次 */
  refundShiftId: z.number('钱箱班次不正确').int('钱箱班次不正确').positive('钱箱班次不正确').nullish().transform((v) => v ?? undefined),
  /** 店主或店总的当场授权（不进请求摘要：授权过期后重新授权、原样重提仍是同一笔） */
  grantId: z.uuid('请先请店主或店总当场授权'),
});
export type MemberRefundInputData = z.input<typeof MemberRefundInput>;

const sameLine = (a: { source: string; id: number; amount: number }, b: { source: string; id: number; amount: number }) =>
  a.source === b.source && a.id === b.id && a.amount === b.amount;

/** 退储值（同一编号重提返回原来那张；结果待确认时可以「确认作废」，之后原请求晚到也不生效） */
export async function createMemberRefund(deps: Deps, memberId: number, raw: MemberRefundInputData, ctx: OpContext): Promise<{ refund: MemberRefundDetail; replayed: boolean }> {
  const input = parse(MemberRefundInput, raw);
  const total = input.lines.reduce((s, l) => s + l.amount, 0);
  if (total !== input.amount) {
    throw unprocessable('REFUND_NOT_BALANCED', `退回的明细合计 ${formatYuan(total)}，退的本金 ${formatYuan(input.amount)}，两者要相等`);
  }
  const autoLine = input.lines.find((l) => l.route === 'mp_auto');
  if (input.lines.some((l) => l.route === 'mp_auto' && !(l.source === 'recharge' && l.method === 'wechat'))) {
    throw badRequest('只有线上充值（小程序）微信付的那一行能交给门店系统原路退回');
  }
  if (input.lines.some((l) => l.route === 'mp_auto' && l.ref !== '')) {
    throw badRequest('交给门店系统原路退回的那一行不用填退款单号；已经在商户平台退过的，请选「已在商户平台退过」再填单号');
  }
  const missingRef = input.lines.find((l) => l.route === 'manual' && refundRefRequired(l.method) && l.ref.length < 2);
  if (missingRef) {
    throw badRequest(
      missingRef.method === 'other'
        ? '「其他」方式退的请写明是怎么退的'
        : `${PAYMENT_METHOD_LABELS[missingRef.method]}退的请登记商户后台的退款单号（在商户后台原路退回后填写）`,
    );
  }
  const hasCash = input.lines.some((l) => l.method === 'cash');
  if (input.refundShiftId !== undefined && !hasCash) {
    throw unprocessable('REFUND_SHIFT_NOT_CASH', '这次没有退现金，不用选钱箱；扫码、银行卡退的记到你当班的交班表');
  }
  const { clientKey: key, grantId: _grant, ...payload } = input;
  // 员工退的行不带 route 进摘要：v0.7.26 提交、升级后原样重提的仍是同一笔
  const hashLines = payload.lines.map(({ route, ...l }) => (route === 'manual' ? l : { ...l, route }));
  const requestHash = hashRequest({ memberId, ...payload, lines: hashLines });
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM member_refunds WHERE client_key = ${key}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔退储值，请刷新页面后重新办理');
    return Number(p.id);
  };
  // 开始处理时经办人所在的班次：入账前它已交班则整笔拒绝（与充值、退款单同一协议）；选了钱箱时记到所选的班次
  const seenShift = input.refundShiftId === undefined ? await openShiftOf(deps.sql, ctx.actor.id) : null;
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, key, 'member_refund', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      const shiftId = input.refundShiftId === undefined ? await lockPaymentShift(tx, ctx.actor.id, seenShift) : await lockRefundShift(tx, input.refundShiftId);
      const at = ctx.at ?? new Date();
      // 会员一行：与充值、消费同一把锁；到期没用完的赠金先作废，扣回按作废之后的余额算
      const locked = await expireDueLots(tx, deps, await lockMember(tx, memberId), at);
      const m = await memberRow(tx, memberId);
      const blocked = blockedReason({ ...m, principalBalance: locked.principalBalance });
      if (blocked) throw unprocessable('REFUND_NOT_AVAILABLE', blocked);
      if (input.amount > locked.principalBalance) {
        throw conflict('REFUND_EXCEEDS', `本金余额只有 ${formatYuan(locked.principalBalance)}（刚刚有变化），最多退这么多，请重新核对`, {
          principalBalance: locked.principalBalance,
        });
      }
      // 按此刻的余额重新分配：与页面核对时的不一致就拒绝（中间有人充值、消费或退过）
      const sources = attributeBalance(await rawSources(tx, memberId), locked.principalBalance);
      const plan = allocateRefund(sources, input.amount);
      const changed =
        plan.length !== input.lines.length ||
        plan.some((p, i) => !sameLine(p, input.lines[i]!) || (p.method !== null && p.method !== input.lines[i]!.method));
      if (changed) {
        throw conflict('REFUND_ALLOCATION_CHANGED', '这位会员的储值刚刚有变化，退回的明细与核对时不同，请重新核对', {
          lines: plan,
        });
      }
      // 交给门店系统原路退回的行：必须是线上充值的那一行，而且小程序线的原路退回此刻开着
      if (autoLine) {
        if (input.lines.some((l, i) => l.route === 'mp_auto' && !onlineRoutable(plan[i]!))) {
          throw unprocessable('ONLINE_ROUTE_NOT_ALLOWED', '只有线上充值（小程序）微信付的那一行能交给门店系统原路退回，请重新核对');
        }
        if (!(await onlineRouteAvailable(tx))) {
          throw unprocessable('ONLINE_REFUND_UNAVAILABLE', '线上充值的原路退回现在没开：请在微信支付商户平台原路退回后，选「已在商户平台退过」并填退款单号');
        }
      }
      const bonus = refundBonus(locked.principalBalance, locked.bonusBalance, input.amount);
      if (bonus !== input.expectedBonus) {
        throw conflict('REFUND_BONUS_CHANGED', `扣回的赠金现在是 ${formatYuan(bonus)}（余额刚刚有变化），请重新核对`, { bonus });
      }
      const approval = await consumeMemberRefundGrant(tx, {
        grantId: input.grantId,
        actor: ctx.actor,
        scope: { memberId, amount: input.amount },
        usedRef: `member_refund:${key}`,
      });
      const settings = await loadSettings(tx);
      const date = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
      const refundNo = await nextDocNo(tx, 'member_refund', 'TC', date);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO member_refunds (refund_no, member_id, principal, bonus, reason, operator_id, approved_by, shift_id, business_date, created_at,
                                    client_key, request_hash)
        VALUES (${refundNo}, ${memberId}, ${input.amount}, ${bonus}, ${input.reason}, ${ctx.actor.id}, ${approval.approverId}, ${shiftId},
                ${date}, ${at}, ${key}, ${requestHash})
        RETURNING id`;
      const refundId = Number(row!.id);
      for (const l of input.lines) {
        await tx`
          INSERT INTO member_refund_lines (refund_id, source, recharge_id, opening_id, member_merge_id, method, amount, ref, route)
          VALUES (${refundId}, ${l.source}, ${l.source === 'recharge' ? l.id : null}, ${l.source === 'opening' ? l.id : null},
                  ${l.source === 'merge' ? l.id : null}, ${l.method}, ${l.amount}, ${l.ref}, ${l.route})`;
      }
      await applyBalance(tx, locked, { principal: -input.amount, bonus: -bonus }, {
        entryType: 'refund', docNo: refundNo, memberRefundId: refundId, businessDate: date, operatorId: ctx.actor.id, at,
      });
      await takeForRefund(tx, {
        memberId,
        refundId,
        amount: bonus,
        rechargeIds: input.lines.filter((l) => l.source === 'recharge').map((l) => l.id),
        at,
      });
      // 靠充值升上来、扣完够不上这一档的当场降档（M73）
      const grade = await onRefundGrade(tx, { memberId, refundId, refundNo, today: date, staffId: ctx.actor.id });
      const [drawer] = shiftId
        ? await tx<{ shiftNo: string; staffId: number; staffName: string }[]>`
            SELECT s.shift_no, s.staff_id, st.display_name AS staff_name FROM shifts s JOIN staff st ON st.id = s.staff_id WHERE s.id = ${shiftId}`
        : [];
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'member_refund',
        targetType: 'member',
        targetId: memberId,
        detail: {
          docNo: refundNo,
          memberName: m.name,
          principal: input.amount,
          bonus,
          reason: input.reason,
          approverId: approval.approverId,
          approverName: approval.approverName,
          lines: input.lines.map((l) => ({ source: l.source, id: l.id, method: l.method, amount: l.amount, ref: l.ref, ...(l.route === 'mp_auto' ? { route: l.route } : {}) })),
          ...(grade ? { grade } : {}),
          ...(drawer && Number(drawer.staffId) !== ctx.actor.id ? { refundShift: drawer.shiftNo, refundDrawer: drawer.staffName } : {}),
        },
        ip: ctx.ip,
        businessDate: date,
      });
      return { id: refundId, replayed: false };
    });
    return { refund: await getMemberRefund(deps.sql, out.id), replayed: out.replayed };
  } catch (error) {
    // 同一编号并发提交：后到的一笔撞上唯一约束，按原来那张返回
    if (isUniqueViolation(error, 'member_refunds_client_key_key')) {
      const id = await replay(deps.sql);
      if (id !== null) return { refund: await getMemberRefund(deps.sql, id), replayed: true };
    }
    throw error;
  }
}

// ───────────────────────── 查询 ─────────────────────────

const detailSql = (db: Db) => db`
  SELECT r.id, r.refund_no, r.member_id, m.member_no, m.name AS member_name, r.principal, r.bonus, r.reason,
         o.display_name AS operator_name, a.display_name AS approver_name, s.shift_no, ss.display_name AS shift_staff_name,
         to_char(r.business_date, 'YYYY-MM-DD') AS business_date, r.created_at,
         (SELECT json_build_object('fromGrade', e.from_grade, 'fromTier', e.from_tier, 'toGrade', e.to_grade, 'toTier', e.to_tier)
          FROM member_grade_events e WHERE e.member_refund_id = r.id) AS grade_event
  FROM member_refunds r JOIN members m ON m.id = r.member_id JOIN staff o ON o.id = r.operator_id JOIN staff a ON a.id = r.approved_by
  LEFT JOIN shifts s ON s.id = r.shift_id LEFT JOIN staff ss ON ss.id = s.staff_id`;

type DetailRow = Omit<MemberRefundDetail, 'lines' | 'grade' | 'createdAt'> & {
  createdAt: Date;
  gradeEvent: { fromGrade: number; fromTier: number | null; toGrade: number; toTier: number | null } | null;
};

async function toDetail(db: Db, r: DetailRow): Promise<MemberRefundDetail> {
  const lines = await db<{ source: RefundPlanLine['source']; id: number; docNo: string; date: string; method: PaymentMethod; channel: 'counter' | 'mp' | null; amount: number; ref: string; route: RefundRoute }[]>`
    SELECT l.source, coalesce(l.recharge_id, l.opening_id, l.member_merge_id) AS id,
           coalesce(rc.doc_no, ob.doc_no, mg.merge_no) AS doc_no,
           to_char(coalesce(rc.business_date, oi.business_date, mg.business_date), 'YYYY-MM-DD') AS date,
           l.method, rc.channel, l.amount, l.ref, l.route
    FROM member_refund_lines l
    LEFT JOIN recharges rc ON rc.id = l.recharge_id
    LEFT JOIN opening_balances ob ON ob.id = l.opening_id LEFT JOIN opening_imports oi ON oi.id = ob.import_id
    LEFT JOIN member_merges mg ON mg.id = l.member_merge_id
    WHERE l.refund_id = ${r.id} ORDER BY l.id`;
  const { gradeEvent, ...rest } = r;
  let grade: MemberRefundDetail['grade'] = null;
  if (gradeEvent) {
    const { loadMembershipRules } = await import('./membership');
    const { gradeLabel } = await import('@shared/membership');
    const rules = await loadMembershipRules(db);
    grade = { from: gradeLabel(rules, gradeEvent.fromGrade, gradeEvent.fromTier), to: gradeLabel(rules, gradeEvent.toGrade, gradeEvent.toTier) };
  }
  return {
    ...rest,
    id: Number(rest.id),
    memberId: Number(rest.memberId),
    principal: Number(rest.principal),
    bonus: Number(rest.bonus),
    createdAt: new Date(r.createdAt).toISOString(),
    lines: lines.map((l) => ({ ...l, id: Number(l.id), amount: Number(l.amount), channel: l.channel ?? null })),
    grade,
  };
}

export async function getMemberRefund(db: Db, id: number): Promise<MemberRefundDetail> {
  const [r] = await db<DetailRow[]>`${detailSql(db)} WHERE r.id = ${id}`;
  if (!r) throw notFound('退储值单不存在');
  return toDetail(db, r);
}

/** 这位会员退过的（最近的在前，最多 50 张） */
export async function listMemberRefunds(db: Db, memberId: number): Promise<MemberRefundDetail[]> {
  const rows = await db<DetailRow[]>`${detailSql(db)} WHERE r.member_id = ${memberId} ORDER BY r.id DESC LIMIT 50`;
  return Promise.all(rows.map((r) => toDetail(db, r)));
}

/** 某个营业日的退储值单（日结的异常清单、对账包） */
export async function memberRefundsOfDate(db: Db, date: string): Promise<MemberRefundDetail[]> {
  const rows = await db<DetailRow[]>`${detailSql(db)} WHERE r.business_date = ${date} ORDER BY r.id`;
  return Promise.all(rows.map((r) => toDetail(db, r)));
}

// ───────────────────────── 自检 ─────────────────────────

/** 储值退回的自检（2 项）：单子 = 几行 = 流水 = 赠金批次；每一笔退过的不超过它收的钱 */
export async function memberRefundChecks(db: Db): Promise<{ label: string; ok: boolean; detail: string }[]> {
  const [a] = await db<{ n: number; bad: number }[]>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE
             r.principal <> (SELECT coalesce(sum(l.amount), 0) FROM member_refund_lines l WHERE l.refund_id = r.id)
             OR NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.member_refund_id = r.id AND e.entry_type = 'refund'
                                                         AND e.principal_delta = -r.principal AND e.bonus_delta = -r.bonus AND e.member_id = r.member_id)
             OR r.bonus <> -(SELECT coalesce(sum(mv.amount), 0) FROM bonus_lot_moves mv WHERE mv.member_refund_id = r.id AND mv.kind = 'refund'))::int AS bad
    FROM member_refunds r`;
  const [b] = await db<{ bad: number }[]>`
    SELECT count(*)::int AS bad FROM (
      SELECT 1 FROM recharges r
      WHERE (SELECT coalesce(sum(l.amount), 0) FROM member_refund_lines l WHERE l.recharge_id = r.id) > r.paid_amount
      UNION ALL
      SELECT 1 FROM opening_balances o
      WHERE (SELECT coalesce(sum(l.amount), 0) FROM member_refund_lines l WHERE l.opening_id = o.id) > o.principal
      UNION ALL
      SELECT 1 FROM member_merges g
      WHERE (SELECT coalesce(sum(l.amount), 0) FROM member_refund_lines l WHERE l.member_merge_id = g.id) > g.principal
    ) x`;
  return [
    {
      label: '储值退回：退储值单 = 退回的明细 = 余额流水 = 赠金扣回',
      ok: a!.bad === 0,
      detail: a!.bad ? `${a!.bad} 张退储值单的明细、流水或赠金扣回对不上` : `共 ${a!.n} 张退储值单，逐张核对一致`,
    },
    {
      label: '储值退回：每一笔充值（期初、合并转入）退过的不超过它收的钱',
      ok: b!.bad === 0,
      detail: b!.bad ? `${b!.bad} 笔退过的超过了它收的钱` : '每一笔退过的都在它收的钱以内',
    },
  ];
}

// ───────────────────────── 接口 ─────────────────────────

const PlanQuery = z.object({ amount: z.coerce.number('退的本金要是整数（分）').int('退的本金要是整数（分）').positive('退的本金要大于 0').optional() });

export function registerMemberRefundRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/members/:id/refund-plan', { preHandler: guard('member.refund') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { amount } = parse(PlanQuery, req.query ?? {});
    return memberRefundPlan(deps, id, amount);
  });
  app.get('/api/members/:id/refund-drawers', { preHandler: guard('member.refund') }, async (req) => refundDrawers(sql, req.actor.id));
  app.post('/api/members/:id/refunds', { preHandler: guard('member.refund') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return createMemberRefund(deps, id, req.body as MemberRefundInputData, ctxOf(req));
  });
  app.get('/api/members/:id/refunds', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return listMemberRefunds(sql, id);
  });
  app.get('/api/member-refunds/:id', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getMemberRefund(sql, id);
  });
}

export type { Tx };
