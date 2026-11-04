// 小程序第二期 2a：线上充值单（小程序线，docs/MP_RECHARGE.md）。
//   · 可充的项：店主勾选的套餐与自定义金额，各自按这位会员此刻的规则预估（主线 previewOnlineRecharge，以到账时为准）；
//   · 建单：这个微信的咨询锁（与确认作废串行）→ 查作废登记、同一个编号的单 → 校验 → 写单子，不锁会员、不碰钱包；
//     之后在事务外向微信支付下单、签支付参数（同一个商户单号、同样的内容，微信回同一个 prepay_id）；
//   · 到账（到账通知、查单补单）：先与单子核对（金额、付款的微信、AppID、商户号），再 会员一行 → 充值单一行 → 主线 rechargeOnline，
//     与单子记「已入账」同一个事务；入账被拒（到账时规则变了）或对不上的，另开事务只锁单子一行、记「已付款待处理」给店主处理；
//   · 关单、取消：先在事务外请微信关单，关上了再锁单子一行记「已关闭」（关不上说明已经付了，转去查单入账）；
//   · 每分钟：待支付超过 2 分钟的去微信查，过期的去微信关。
// 记下了（入账或已付款待处理）才回微信「收到」；验签失败、门店出错回失败，微信会重发，按商户单号与交易单号去重。

import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import { formatYuan } from '@shared/money';
import {
  MP_RECHARGE_EXPIRE_MINUTES,
  MP_RECHARGE_ORDER_NO,
  type MpPayParams,
  type MpRechargeAbandonResult,
  type MpRechargeCreated,
  type MpRechargeEstimate,
  type MpRechargeFlag,
  type MpRechargeOptions,
  type MpRechargeOrder,
  type MpRechargePlan,
  type MpRechargeStatus,
} from '@shared/mp';
import { isUniqueViolation, type Db, type Sql, type Tx } from '../../db';
import type { Deps } from '../../lib/context';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { memberGradeInfo } from '../membership';
import { loadSettings } from '../settings';
import { previewOnlineRecharge, rechargeOnline } from '../wallet-online';
import { activeBinding } from './member';
import { loadRechargeRules } from './rules';
import type { PayRuntime } from './pay';
import { parseNotification, paymentParams, WxPayError, type WxTransaction } from './wxpay';

export { loadRechargeRules };

// ── 单子 ──

export interface OrderRow {
  id: number;
  orderNo: string;
  clientKey: string;
  openid: string;
  bindingId: number;
  memberId: number;
  planId: number | null;
  planName: string | null;
  amount: number;
  estBonus: number;
  estLabel: string;
  businessDate: string;
  expiresAt: string;
  mock: boolean;
  status: MpRechargeStatus;
  prepayId: string | null;
  transactionId: string | null;
  paidAt: string | null;
  rechargeId: number | null;
  creditedMemberId: number | null;
  bookedAt: string | null;
  bookedLabel: string | null;
  flags: MpRechargeFlag[];
  closedAt: string | null;
  closeReason: string | null;
  holdCode: string | null;
  holdMessage: string | null;
  heldAt: string | null;
  resolution: string | null;
  resolveClientKey: string | null;
  queriedAt: string | null;
  createdAt: string;
}

const ORDER_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function newOrderNo(businessDate: string): string {
  let tail = '';
  for (let i = 0; i < 10; i++) tail += ORDER_CHARS[randomInt(ORDER_CHARS.length)];
  return `MPR${businessDate.replace(/-/g, '')}${tail}`;
}

export const orderById = async (db: Db, id: number) => (await db<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE id = ${id}`)[0] ?? null;
export const lockOrder = async (tx: Tx, id: number) => (await tx<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE id = ${id} FOR UPDATE`)[0]!;
/** 建单与确认作废先取这个微信的咨询锁：同一个微信的建单与作废在这把锁里只有一个在改 */
const lockRechargeOpenid = (tx: Tx, openid: string) => tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_recharge:${openid}`}))`;

type EventKind = 'created' | 'wx_order' | 'notify' | 'query' | 'close' | 'booked' | 'held' | 'resolved';
export async function recordEvent(
  db: Db,
  orderId: number | null,
  kind: EventKind,
  ok: boolean,
  code: string | null,
  detail: Record<string, unknown> = {},
  staffId: number | null = null,
) {
  await db`
    INSERT INTO mp_recharge_events (order_id, kind, ok, code, detail, staff_id)
    VALUES (${orderId}, ${kind}, ${ok}, ${code}, ${db.json(detail as never)}, ${staffId})`;
}

/** 拒绝码只留数据库认的格式（大写字母、数字、下划线） */
const codeOf = (error: unknown) => {
  const c = error instanceof WxPayError || error instanceof AppError ? error.code : 'ERROR';
  return /^[A-Z][A-Z0-9_]{1,39}$/.test(c) ? c : 'ERROR';
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function storePhone(db: Db): Promise<string> {
  const [s] = await db<{ phone: string }[]>`SELECT phone FROM mp_stores WHERE is_home`;
  return s?.phone ?? '';
}

const CLOSE_TEXT: Record<string, string> = {
  expired: '这张单过了 15 分钟没有付，已关闭',
  cancelled: '这张单已取消',
  wx_closed: '这张单在微信支付那边已关闭',
  wx_failed: '微信支付下单没成功，这张单已关闭',
};

/** 给顾客看的单子 */
export async function orderView(db: Db, o: OrderRow): Promise<MpRechargeOrder> {
  let result: MpRechargeOrder['result'] = null;
  let notice: string | null = null;
  if (o.status === 'paid' && o.rechargeId !== null) {
    const [r] = await db<{ paidAmount: number; bonusAmount: number }[]>`SELECT paid_amount, bonus_amount FROM recharges WHERE id = ${o.rechargeId}`;
    result = {
      principal: r?.paidAmount ?? o.amount,
      bonus: r?.bonusAmount ?? 0,
      label: o.bookedLabel ?? '',
    };
  } else if (o.status === 'held' || o.status === 'handled') {
    const phone = await storePhone(db);
    notice =
      o.status === 'held'
        ? `已付款，门店系统没能自动入账，门店正在核对${phone ? `；有疑问请联系门店 ${phone}` : ''}`
        : `已付款，门店已经处理${phone ? `；有疑问请联系门店 ${phone}` : ''}`;
  } else if (o.status === 'closed') {
    notice = CLOSE_TEXT[o.closeReason ?? ''] ?? '这张单已关闭';
  }
  return {
    orderNo: o.orderNo,
    status: o.status,
    amount: o.amount,
    planName: o.planName,
    estBonus: o.estBonus,
    estLabel: o.estLabel,
    expiresAt: o.expiresAt,
    createdAt: o.createdAt,
    result,
    notice,
  };
}

async function boundMember(db: Db, openid: string): Promise<{ bindingId: number; memberId: number }> {
  const b = await activeBinding(db, openid);
  if (!b) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
  return { bindingId: b.id, memberId: b.memberId };
}

/** 这个微信下的单（别人的单当作没有） */
async function myOrder(db: Db, openid: string, orderNo: string): Promise<OrderRow> {
  if (!MP_RECHARGE_ORDER_NO.test(orderNo)) throw badRequest('充值单号不正确');
  const [o] = await db<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE order_no = ${orderNo} AND openid = ${openid}`;
  if (!o) throw notFound('充值单不存在');
  return o;
}

const payUnavailable = () => new AppError(503, 'MP_PAY_UNAVAILABLE', '线上充值暂时用不了，请到前台充值');
/** 这张单能不能用现在的微信支付处理（模拟的单只认模拟的微信支付，反过来也一样） */
const sameMode = (pay: PayRuntime | null, o: OrderRow): pay is PayRuntime => !!pay && o.mock === (pay.mode === 'mock');

// ── 可充的项与预估 ──

const yuanCeil = (cents: number) => Math.ceil(cents / 100) * 100;
const yuanFloor = (cents: number) => Math.floor(cents / 100) * 100;

/** 套餐上挂的券（按充完的档能领的）：「名称 × 张数」 */
async function planCoupons(db: Db, planIds: number[]): Promise<Map<number, { name: string; quantity: number; levels: number[] }[]>> {
  const out = new Map<number, { name: string; quantity: number; levels: number[] }[]>();
  if (!planIds.length) return out;
  const rows = await db<{ planId: number; name: string; quantity: number; levels: number[] }[]>`
    SELECT r.plan_id, t.name, r.quantity, t.levels
    FROM coupon_rules r JOIN coupon_templates t ON t.id = r.template_id
    WHERE r.active AND r.kind = 'recharge' AND t.active AND r.plan_id = ANY(${planIds}::bigint[])
    ORDER BY r.id`;
  for (const r of rows) out.set(r.planId, [...(out.get(r.planId) ?? []), r]);
  return out;
}

async function usedToday(db: Db, memberId: number, today: string): Promise<number> {
  const [r] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM mp_recharge_orders WHERE member_id = ${memberId} AND business_date = ${today} AND status <> 'closed'`;
  return r?.n ?? 0;
}

export async function rechargeOptions(deps: Deps, pay: PayRuntime | null, openid: string): Promise<MpRechargeOptions> {
  const { memberId } = await boundMember(deps.sql, openid);
  const rules = await loadRechargeRules(deps.sql);
  const settings = await loadSettings(deps.sql);
  const now = new Date();
  const today = businessDateOf(now, deps.config.timezone, settings.businessDayStartHour);
  // 先按 1 元预估一次：首充还是续充、单笔最低与上限、停用与合并都与金额无关
  const base = await previewOnlineRecharge(deps.sql, deps, memberId, 100, now);
  const minCents = yuanCeil(Math.max(100, base.minimum));
  const maxCents = yuanFloor(Math.min(rules.maxCents, base.maxSingle));
  const plans: MpRechargePlan[] = [];
  const rows = rules.planIds.length
    ? await deps.sql<{ id: number; name: string; payAmount: number }[]>`
        SELECT id, name, pay_amount FROM recharge_plans WHERE active AND id = ANY(${rules.planIds}::bigint[]) ORDER BY sort_order, pay_amount, id`
    : [];
  const coupons = await planCoupons(
    deps.sql,
    rows.map((r) => r.id),
  );
  for (const p of rows) {
    const e = await previewOnlineRecharge(deps.sql, deps, memberId, p.payAmount, now);
    const blocked =
      p.payAmount < Math.max(100, base.minimum)
        ? `${base.first ? '首充' : '续充'}单笔最低 ${formatYuan(Math.max(100, base.minimum))}`
        : p.payAmount > Math.min(rules.maxCents, base.maxSingle)
          ? `线上单笔最多 ${formatYuan(Math.min(rules.maxCents, base.maxSingle))}`
          : null;
    plans.push({
      planId: p.id,
      name: p.name,
      amount: p.payAmount,
      bonus: e.bonus,
      label: e.label,
      upgraded: e.upgraded,
      coupons: (coupons.get(p.id) ?? []).filter((c) => c.levels.length === 0 || c.levels.includes(e.gradeAfter)).map((c) => `${c.name} × ${c.quantity}`),
      blocked,
    });
  }
  const used = await usedToday(deps.sql, memberId, today);
  const [pendingRow] = await deps.sql<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE member_id = ${memberId} AND status = 'pending'`;
  const notice = !rules.enabled
    ? '线上充值还没开通，请到前台充值'
    : !pay
      ? '线上充值暂时用不了，请到前台充值'
      : base.frozen
        ? '会员已冻结，请到前台咨询'
        : base.mergedInto !== null
          ? '会员档案已合并，请到前台咨询'
          : used >= rules.dailyLimit
            ? `线上每天最多充 ${rules.dailyLimit} 笔，今天已经充了 ${used} 笔；明天再来或到前台充值`
            : maxCents < minCents
              ? '线上单笔上限低于最低充值额，请到前台充值'
              : null;
  return {
    open: notice === null,
    notice,
    plans,
    custom: rules.customEnabled && maxCents >= minCents ? { minCents, maxCents } : null,
    first: base.first,
    minimum: base.minimum,
    dailyLimit: rules.dailyLimit,
    usedToday: used,
    pending: pendingRow ? await orderView(deps.sql, pendingRow) : null,
    mock: pay?.mode === 'mock',
  };
}

const PreviewQuery = z.object({
  amount: z.coerce.number('请填写金额').int('金额请填整元').positive('请填写金额').max(100_000_000, '金额太大'),
});

export async function rechargePreview(deps: Deps, openid: string, query: unknown): Promise<MpRechargeEstimate> {
  const { amount } = parse(PreviewQuery, query);
  if (amount % 100 !== 0) throw badRequest('金额请填整元');
  const { memberId } = await boundMember(deps.sql, openid);
  const e = await previewOnlineRecharge(deps.sql, deps, memberId, amount);
  return { amount, bonus: e.bonus, label: e.label, upgraded: e.upgraded };
}

// ── 建单 ──

const CreateInput = z
  .object({
    clientKey: z.uuid('操作编号不正确'),
    planId: z.number().int().positive().nullable().default(null),
    /** 自定义金额（分，整元） */
    amount: z.number().int().positive().nullable().default(null),
  })
  .refine((v) => (v.planId === null) !== (v.amount === null), '请选择充值套餐或填写金额');

/** 微信账单里顾客看到的商品描述 */
async function description(db: Db, o: OrderRow): Promise<string> {
  const [s] = await db<{ name: string }[]>`SELECT name FROM mp_stores WHERE is_home`;
  // 不带千分位逗号：微信的交易账单是逗号分隔的，描述里少一个逗号就少一处出错的可能
  return `汤崎${s?.name ?? ''} 会员充值 ${Math.floor(o.amount / 100)}.${String(o.amount % 100).padStart(2, '0')}元`;
}

export async function createRechargeOrder(deps: Deps, pay: PayRuntime | null, openid: string, raw: unknown): Promise<MpRechargeCreated> {
  const input = parse(CreateInput, raw);
  if (!pay) throw payUnavailable();
  let order: OrderRow;
  let replayed: boolean;
  try {
    ({ order, replayed } = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockRechargeOpenid(tx, openid);
      // 这个编号已经确认作废（结果不确定时小程序请门店系统作废的）：晚到的原请求不再建单
      const [fenced] = await tx`SELECT 1 FROM mp_op_fences WHERE key = ${input.clientKey} AND op_type = 'mp_recharge' AND openid = ${openid}`;
      if (fenced) throw conflict('OP_ABANDONED', '这次充值已经放弃，请重新选择');
      const [prev] = await tx<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE client_key = ${input.clientKey}`;
      if (prev) {
        const same = prev.openid === openid && (input.planId !== null ? prev.planId === input.planId : prev.planId === null && prev.amount === input.amount);
        if (!same) throw conflict('CLIENT_KEY_REUSED', '这次充值的编号已经用过，请重新选择');
        return { order: prev, replayed: true };
      }
      const rules = await loadRechargeRules(tx);
      if (!rules.enabled) throw new AppError(403, 'MP_RECHARGE_DISABLED', '线上充值还没开通，请到前台充值');
      const { bindingId, memberId } = await boundMember(tx, openid);
      const now = new Date();
      const settings = await loadSettings(tx);
      const today = businessDateOf(now, deps.config.timezone, settings.businessDayStartHour);
      let amount: number;
      let plan: { id: number; name: string } | null = null;
      if (input.planId !== null) {
        if (!rules.planIds.includes(input.planId)) throw unprocessable('PLAN_NOT_ONLINE', '这个套餐不能在线上充，请刷新后再选');
        const [p] = await tx<
          { name: string; payAmount: number; active: boolean }[]
        >`SELECT name, pay_amount, active FROM recharge_plans WHERE id = ${input.planId}`;
        if (!p?.active) throw unprocessable('PLAN_UNAVAILABLE', '这个充值套餐已停用，请刷新后再选');
        amount = p.payAmount;
        plan = { id: input.planId, name: p.name };
      } else {
        if (!rules.customEnabled) throw unprocessable('CUSTOM_DISABLED', '现在不能自定义金额，请选择充值套餐');
        if (input.amount! % 100 !== 0) throw badRequest('金额请填整元');
        amount = input.amount!;
      }
      const e = await previewOnlineRecharge(tx, deps, memberId, amount, now);
      if (e.frozen) throw new AppError(403, 'MEMBER_FROZEN', '会员已冻结，请到前台咨询');
      if (e.mergedInto !== null) throw conflict('MEMBER_MERGED', '会员档案已合并，请到前台咨询');
      const minimum = Math.max(100, e.minimum);
      const maximum = Math.min(rules.maxCents, e.maxSingle);
      if (amount < minimum) throw unprocessable('RECHARGE_BELOW_MIN', `${e.first ? '首充' : '续充'}单笔最低 ${formatYuan(minimum)}`);
      if (amount > maximum) throw unprocessable('RECHARGE_OVER_LIMIT', `线上单笔最多 ${formatYuan(maximum)}，更多请到前台充值`);
      if ((await usedToday(tx, memberId, today)) >= rules.dailyLimit) {
        throw unprocessable('DAILY_LIMIT', `线上每天最多充 ${rules.dailyLimit} 笔，明天再来或到前台充值`);
      }
      const [pending] = await tx`SELECT 1 FROM mp_recharge_orders WHERE member_id = ${memberId} AND status = 'pending'`;
      if (pending) throw conflict('ORDER_PENDING', '还有一张待支付的充值单，请先付完或取消');
      const expiresAt = new Date(now.getTime() + MP_RECHARGE_EXPIRE_MINUTES * 60_000);
      const [row] = await tx<OrderRow[]>`
        INSERT INTO mp_recharge_orders (order_no, client_key, openid, binding_id, member_id, plan_id, plan_name, amount,
                                        est_bonus, est_label, business_date, expires_at, mock, created_at, updated_at)
        VALUES (${newOrderNo(today)}, ${input.clientKey}, ${openid}, ${bindingId}, ${memberId}, ${plan?.id ?? null}, ${plan?.name ?? null}, ${amount},
                ${e.bonus}, ${e.label.slice(0, 40)}, ${today}, ${expiresAt}, ${pay.mode === 'mock'}, ${now}, ${now})
        RETURNING *`;
      await recordEvent(tx, row!.id, 'created', true, null, {
        amount,
        planId: plan?.id ?? null,
        estBonus: e.bonus,
        estLabel: e.label,
      });
      return { order: row!, replayed: false };
    }));
  } catch (error) {
    if (isUniqueViolation(error, 'mp_recharge_orders_pending_uq')) throw conflict('ORDER_PENDING', '还有一张待支付的充值单，请先付完或取消');
    if (isUniqueViolation(error, 'mp_recharge_orders_client_key_key')) throw conflict('CLIENT_KEY_REUSED', '这次充值的编号已经用过，请重新选择');
    throw error;
  }
  const payment = order.status === 'pending' ? await ensurePayment(deps, pay, order) : null;
  return {
    order: await orderView(deps.sql, (await orderById(deps.sql, order.id))!),
    payment,
    mock: pay.mode === 'mock',
    replayed,
  };
}

/**
 * 拿支付参数：还没向微信下过单的先下单（事务外；同一个商户单号、同样的内容，微信回同一个 prepay_id），再签 paySign。
 * 微信连不上返回 null（单子留着，之后「继续支付」再下单）；微信明确拒绝下单的，请微信关单后关掉这张单。
 */
async function ensurePayment(deps: Deps, pay: PayRuntime, o: OrderRow): Promise<MpPayParams | null> {
  if (!sameMode(pay, o)) throw conflict('PAY_MODE_CHANGED', '门店系统的微信支付换过了，请取消这张单后重新下单');
  let prepayId = o.prepayId;
  if (!prepayId) {
    if (Date.parse(o.expiresAt) - Date.now() < 60_000) throw conflict('ORDER_EXPIRING', '这张单快过期了，请取消后重新下单');
    try {
      ({ prepayId } = await pay.client.jsapiOrder({
        outTradeNo: o.orderNo,
        description: await description(deps.sql, o),
        amountCents: o.amount,
        payerOpenid: o.openid,
        expiresAt: new Date(o.expiresAt),
      }));
    } catch (error) {
      await recordEvent(deps.sql, o.id, 'wx_order', false, codeOf(error), {
        message: messageOf(error),
      });
      if (error instanceof WxPayError && error.code === 'ORDERPAID') {
        // 已经付了（之前那次下单成功、顾客付了款）：去查单入账
        await syncFromWechat(deps, pay, o, 'order');
        return null;
      }
      if (error instanceof WxPayError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 429) {
        await closeAtWechat(deps, pay, o, 'wx_failed').catch(() => {});
        throw new AppError(502, 'WXPAY_ORDER_FAILED', '微信支付下单没成功，请稍后再试或到前台充值');
      }
      return null;
    }
    await deps.sql`UPDATE mp_recharge_orders SET prepay_id = ${prepayId}, updated_at = now() WHERE id = ${o.id} AND prepay_id IS NULL`;
    await recordEvent(deps.sql, o.id, 'wx_order', true, null, {});
  }
  return paymentParams(pay.config, prepayId);
}

// ── 顾客：查单、继续支付、取消、确认作废、模拟支付 ──

/** 查单：待支付的顺带去微信查（同一张单 3 秒一次），付了的当场入账 */
export async function getRechargeOrder(deps: Deps, pay: PayRuntime | null, openid: string, orderNo: string): Promise<MpRechargeOrder> {
  const o = await myOrder(deps.sql, openid, orderNo);
  if (o.status === 'pending' && sameMode(pay, o)) {
    const [claimed] = await deps.sql`
      UPDATE mp_recharge_orders SET queried_at = now()
      WHERE id = ${o.id} AND status = 'pending' AND (queried_at IS NULL OR queried_at < now() - interval '3 seconds')
      RETURNING id`;
    if (claimed) await syncFromWechat(deps, pay, o, 'query');
  }
  return orderView(deps.sql, (await orderById(deps.sql, o.id))!);
}

export async function payRechargeOrder(deps: Deps, pay: PayRuntime | null, openid: string, orderNo: string): Promise<MpRechargeCreated> {
  if (!pay) throw payUnavailable();
  const o = await myOrder(deps.sql, openid, orderNo);
  const payment = o.status === 'pending' ? await ensurePayment(deps, pay, o) : null;
  return {
    order: await orderView(deps.sql, (await orderById(deps.sql, o.id))!),
    payment,
    mock: pay.mode === 'mock',
    replayed: true,
  };
}

export async function cancelRechargeOrder(deps: Deps, pay: PayRuntime | null, openid: string, orderNo: string): Promise<MpRechargeOrder> {
  const o = await myOrder(deps.sql, openid, orderNo);
  if (o.status === 'pending') {
    if (!sameMode(pay, o)) {
      // 模拟的单在真的微信支付下（或反过来）付不了：直接关；真的单没有微信支付核实不能关
      if (!o.mock) throw payUnavailable();
      await closeLocally(deps.sql, o.id, 'cancelled', {});
    } else {
      await closeAtWechat(deps, pay, o, 'cancelled');
    }
  }
  return orderView(deps.sql, (await orderById(deps.sql, o.id))!);
}

const AbandonInput = z.object({ clientKey: z.uuid('操作编号不正确') });

/** 建单结果不确定时确认作废这个编号：与建单取同一把咨询锁；已经建了就返回那张单，还没有就登记作废 */
export async function abandonRechargeCreate(deps: Deps, openid: string, raw: unknown): Promise<MpRechargeAbandonResult> {
  const { clientKey } = parse(AbandonInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockRechargeOpenid(tx, openid);
    const [prev] = await tx<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE client_key = ${clientKey}`;
    if (prev) {
      if (prev.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这次充值的编号已经用过，请重新选择');
      return { status: 'created' as const, order: await orderView(tx, prev) };
    }
    await tx`
      INSERT INTO mp_op_fences (key, op_type, openid) VALUES (${clientKey}, 'mp_recharge', ${openid})
      ON CONFLICT (key, op_type) DO NOTHING`;
    const [fence] = await tx<{ openid: string }[]>`SELECT openid FROM mp_op_fences WHERE key = ${clientKey} AND op_type = 'mp_recharge'`;
    if (fence?.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这次充值的编号已经用过，请重新选择');
    return { status: 'abandoned' as const };
  });
}

/** 模拟支付（只在 development、test 的模拟微信支付）：造一条照真的签名、加密的到账通知，走同一条路入账 */
export async function mockPayRechargeOrder(deps: Deps, pay: PayRuntime | null, openid: string, orderNo: string): Promise<MpRechargeOrder> {
  if (!pay?.mock || (deps.config.env !== 'development' && deps.config.env !== 'test')) {
    throw new AppError(403, 'MP_MOCK_REFUSED', '这个门店系统不接受模拟支付');
  }
  const o = await myOrder(deps.sql, openid, orderNo);
  if (o.status === 'pending') {
    if (!o.prepayId) await ensurePayment(deps, pay, o);
    const n = pay.mock.pay(o.orderNo);
    await handlePayNotify(deps, pay, {
      headers: n.headers,
      body: Buffer.from(n.body, 'utf8').toString('base64'),
    });
  }
  return orderView(deps.sql, (await orderById(deps.sql, o.id))!);
}

// ── 关单 ──

async function closeLocally(sql: Sql, orderId: number, reason: 'expired' | 'cancelled' | 'wx_closed' | 'wx_failed', detail: Record<string, unknown>) {
  await sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const o = await lockOrder(tx, orderId);
    if (o.status !== 'pending') return;
    await tx`UPDATE mp_recharge_orders SET status = 'closed', closed_at = now(), close_reason = ${reason}, updated_at = now() WHERE id = ${orderId}`;
    await recordEvent(tx, orderId, 'close', true, null, { reason, ...detail });
  });
}

/** 请微信关单（事务外）：关上了（或微信那边没有这一单）再记「已关闭」；关不上说明已经付了，转去查单入账 */
async function closeAtWechat(deps: Deps, pay: PayRuntime, o: OrderRow, reason: 'expired' | 'cancelled' | 'wx_failed') {
  try {
    await pay.client.closeOrder(o.orderNo);
  } catch (error) {
    if (error instanceof WxPayError && error.code === 'ORDERPAID') {
      await syncFromWechat(deps, pay, o, 'close');
      return;
    }
    if (!(error instanceof WxPayError && (error.status === 404 || error.code === 'ORDER_NOT_EXIST'))) {
      await recordEvent(deps.sql, o.id, 'close', false, codeOf(error), {
        reason,
        message: messageOf(error),
      });
      throw new AppError(503, 'WXPAY_UNAVAILABLE', '微信支付暂时连不上，请稍后再试');
    }
  }
  await closeLocally(deps.sql, o.id, reason, {});
}

// ── 到账：查单、到账通知、入账 ──

type Source = 'notify' | 'query' | 'sweep' | 'close' | 'order' | 'recon';

/** 去微信查这一单、按微信那边的状态处理（2b 对账发现「微信有、门店没记」时用，与每分钟补查同一条路） */
export async function syncOrderFromWechat(deps: Deps, pay: PayRuntime, orderId: number, source: Source = 'recon'): Promise<OrderRow> {
  const o = await orderById(deps.sql, orderId);
  if (!o) throw notFound('线上充值单不存在');
  if ((o.status === 'pending' || o.status === 'closed') && sameMode(pay, o)) await syncFromWechat(deps, pay, o, source);
  return (await orderById(deps.sql, orderId))!;
}

/** 去微信查这一单（事务外），按微信那边的状态处理：已付入账、已关关单、过期没付的请微信关单 */
async function syncFromWechat(deps: Deps, pay: PayRuntime, o: OrderRow, source: Source, now = new Date()): Promise<void> {
  let t: WxTransaction | null;
  try {
    t = await pay.client.queryOrder(o.orderNo);
  } catch (error) {
    await recordEvent(deps.sql, o.id, 'query', false, codeOf(error), {
      source,
      message: messageOf(error),
    });
    return;
  }
  await deps.sql`UPDATE mp_recharge_orders SET queried_at = now() WHERE id = ${o.id}`;
  const expired = now.getTime() > Date.parse(o.expiresAt) + 60_000;
  if (!t) {
    // 微信那边没有这一单（下单没成功、连不上）：过了期就关
    if (expired)
      await closeLocally(deps.sql, o.id, 'expired', {
        wechat: 'ORDER_NOT_EXIST',
      });
    return;
  }
  if (t.tradeState === 'SUCCESS') {
    await recordEvent(deps.sql, o.id, 'query', true, null, {
      source,
      tradeState: t.tradeState,
      transactionId: t.transactionId,
      amount: t.amountTotal,
    });
    await acceptPayment(deps, pay, o.id, t, source);
    return;
  }
  if (t.tradeState === 'REFUND') {
    // 付了又在商户平台退了（入账之前）：不入账，交店主核对
    await recordEvent(deps.sql, o.id, 'query', true, null, {
      source,
      tradeState: t.tradeState,
      transactionId: t.transactionId,
    });
    if (t.transactionId) await hold(deps.sql, o.id, t, 'WX_REFUND', '微信支付那边这一单已转入退款，没有入账', source);
    return;
  }
  if (t.tradeState === 'CLOSED' || t.tradeState === 'REVOKED' || t.tradeState === 'PAYERROR') {
    await closeLocally(deps.sql, o.id, 'wx_closed', {
      tradeState: t.tradeState,
    });
    return;
  }
  // NOTPAY、USERPAYING：过了期就请微信关单
  if (expired && o.status === 'pending') await closeAtWechat(deps, pay, o, 'expired').catch(() => {});
}

/** 到账的内容与单子对不上的地方（对上返回 null） */
function mismatchOf(pay: PayRuntime, o: OrderRow, t: WxTransaction): string | null {
  const wrong: string[] = [];
  if (t.appId !== pay.config.appId) wrong.push(`AppID ${t.appId}`);
  if (t.mchId !== pay.config.mchId) wrong.push(`商户号 ${t.mchId}`);
  if (t.amountTotal !== o.amount) wrong.push(`金额 ${t.amountTotal === null ? '没有' : formatYuan(t.amountTotal)}（单子是 ${formatYuan(o.amount)}）`);
  if (t.payerOpenid !== o.openid) wrong.push('付款的微信不是下单的微信');
  return wrong.length ? `微信支付的到账与单子对不上：${wrong.join('；')}` : null;
}

/** 记「已付款待处理」：只锁单子一行；已经入账或待处理的不动 */
async function hold(sql: Sql, orderId: number, t: WxTransaction, code: string, message: string, source: Source): Promise<void> {
  await sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const o = await lockOrder(tx, orderId);
    if (o.status !== 'pending' && o.status !== 'closed') return;
    await tx`
      UPDATE mp_recharge_orders
      SET status = 'held', transaction_id = ${t.transactionId}, paid_at = ${t.successTime ? new Date(t.successTime) : new Date()},
          hold_code = ${/^[A-Z][A-Z0-9_]{1,39}$/.test(code) ? code : 'REJECTED'}, hold_message = ${message.slice(0, 300)}, held_at = now(), updated_at = now()
      WHERE id = ${orderId}`;
    await recordEvent(tx, orderId, 'held', false, /^[A-Z][A-Z0-9_]{1,39}$/.test(code) ? code : 'REJECTED', {
      source,
      message,
      transactionId: t.transactionId,
      amount: t.amountTotal,
    });
  });
}

/** 入账后的档阶（入账那一刻） */
export async function labelNow(db: Db, deps: Deps, memberId: number): Promise<string> {
  const settings = await loadSettings(db);
  const today = businessDateOf(new Date(), deps.config.timezone, settings.businessDayStartHour);
  return (await memberGradeInfo(db, memberId, today)).label.slice(0, 40);
}

/**
 * 入账一笔微信支付核实已付的单：会员一行 → 充值单一行 → 主线 rechargeOnline，与单子记「已入账」同一个事务。
 * 主线拒绝（到账时不够最低、超上限、套餐停用或改价……，4xx）的整个回滚，另开事务记「已付款待处理」；门店出错（5xx、锁超时）抛出去，等重发或补查。
 */
async function acceptPayment(deps: Deps, pay: PayRuntime, orderId: number, t: WxTransaction, source: Source): Promise<void> {
  const o0 = (await orderById(deps.sql, orderId))!;
  if (!t.transactionId) throw new AppError(400, 'WXPAY_BAD_NOTIFY', '到账内容里没有交易单号');
  const mismatch = mismatchOf(pay, o0, t);
  if (mismatch) {
    await hold(deps.sql, orderId, t, 'MISMATCH', mismatch, source);
    return;
  }
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await tx`SELECT id FROM members WHERE id = ${o0.memberId} FOR UPDATE`;
      const o = await lockOrder(tx, orderId);
      if (o.status !== 'pending' && o.status !== 'closed') {
        if (o.transactionId && o.transactionId !== t.transactionId) {
          await recordEvent(tx, orderId, 'notify', false, 'TRANSACTION_CONFLICT', {
            source,
            transactionId: t.transactionId,
            recorded: o.transactionId,
          });
        }
        return;
      }
      const r = await rechargeOnline(tx, deps, {
        memberId: o.memberId,
        paidAmount: o.amount,
        planId: o.planId,
        paymentRef: t.transactionId!,
        orderNo: o.orderNo,
      });
      const flags: MpRechargeFlag[] = [
        ...(r.frozen ? (['frozen'] as const) : []),
        ...(r.mergedFrom !== null ? (['merged'] as const) : []),
        ...(o.status === 'closed' ? (['after_close'] as const) : []),
      ];
      await tx`
        UPDATE mp_recharge_orders
        SET status = 'paid', transaction_id = ${t.transactionId}, paid_at = ${t.successTime ? new Date(t.successTime) : new Date()},
            recharge_id = ${r.recharge.id}, credited_member_id = ${r.memberId}, booked_at = now(), booked_label = ${await labelNow(tx, deps, r.memberId)},
            flags = ${flags}::text[], updated_at = now()
        WHERE id = ${orderId}`;
      await recordEvent(tx, orderId, 'booked', true, null, {
        source,
        transactionId: t.transactionId,
        rechargeId: r.recharge.id,
        docNo: r.recharge.docNo,
        bonus: r.recharge.bonusAmount,
        estBonus: o.estBonus,
        replayed: r.replayed,
        flags,
      });
    });
  } catch (error) {
    if (error instanceof AppError && error.status < 500) {
      await hold(deps.sql, orderId, t, error.code, error.message, source);
      return;
    }
    throw error;
  }
}

const NotifyInput = z.object({
  headers: z.object({
    timestamp: z.string().max(20).nullable(),
    nonce: z.string().max(64).nullable(),
    signature: z.string().max(1024).nullable(),
    serial: z.string().max(128).nullable(),
  }),
  /** 微信发来的报文主体，网关原样转（Base64） */
  body: z.string().max(16_000),
});

/**
 * 到账通知（网关原样转来）：验签、解密 → 找单子 → 核对、入账。记下了（入账、已付款待处理、找不到单子的记录）才算收到；
 * 验签失败不记库（公网上谁都能发，免得乱发的请求写满记录），回失败。
 */
export async function handlePayNotify(deps: Deps, pay: PayRuntime | null, raw: unknown): Promise<void> {
  if (!pay) throw payUnavailable();
  const input = parse(NotifyInput, raw);
  const body = Buffer.from(input.body, 'base64').toString('utf8');
  let n: ReturnType<typeof parseNotification>;
  try {
    n = parseNotification(pay.config, input.headers, body);
  } catch (error) {
    if (error instanceof WxPayError) throw new AppError(401, codeOf(error), error.message);
    throw error;
  }
  const t = n.transaction;
  if (n.eventType !== 'TRANSACTION.SUCCESS' || t.tradeState !== 'SUCCESS') return;
  const [o] = await deps.sql<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE order_no = ${t.outTradeNo}`;
  if (!o) {
    // 验过签的真付款，但门店系统里没有这张单（例如从备份恢复过）：记下来给店主看，同一笔只记一次
    const [seen] = await deps.sql`
      SELECT 1 FROM mp_recharge_events WHERE order_id IS NULL AND code = 'UNKNOWN_ORDER' AND detail->>'transactionId' = ${t.transactionId ?? ''}`;
    if (!seen) {
      await recordEvent(deps.sql, null, 'notify', false, 'UNKNOWN_ORDER', {
        outTradeNo: t.outTradeNo,
        transactionId: t.transactionId,
        amount: t.amountTotal,
        notifyId: n.id,
      });
    }
    return;
  }
  await recordEvent(deps.sql, o.id, 'notify', true, null, {
    notifyId: n.id,
    transactionId: t.transactionId,
    amount: t.amountTotal,
  });
  await acceptPayment(deps, pay, o.id, t, 'notify');
}

// ── 每分钟：补查、关单 ──

export interface SweepResult {
  checked: number;
  errors: number;
}

/** 待支付超过 2 分钟、1 分钟内没查过的去微信查（已付的入账、过期的关单）；每次最多 20 张 */
export async function sweepRechargeOrders(deps: Deps, pay: PayRuntime | null, now = new Date()): Promise<SweepResult> {
  const out: SweepResult = { checked: 0, errors: 0 };
  // 模拟的单在真的微信支付下付不了：过期就关
  await deps.sql`
    UPDATE mp_recharge_orders SET status = 'closed', closed_at = now(), close_reason = 'expired', updated_at = now()
    WHERE status = 'pending' AND mock AND ${pay?.mode !== 'mock'} AND expires_at < ${new Date(now.getTime() - 60_000)}`;
  if (!pay) return out;
  const rows = await deps.sql<OrderRow[]>`
    SELECT * FROM mp_recharge_orders
    WHERE status = 'pending' AND mock = ${pay.mode === 'mock'}
      AND created_at <= ${new Date(now.getTime() - 120_000)}
      AND (queried_at IS NULL OR queried_at <= ${new Date(now.getTime() - 60_000)})
    ORDER BY created_at LIMIT 20`;
  for (const o of rows) {
    out.checked++;
    try {
      await syncFromWechat(deps, pay, o, 'sweep', now);
    } catch {
      out.errors++;
    }
  }
  return out;
}
