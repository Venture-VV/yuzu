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
import { activeBinding, bindingStateOf, lockOpenidShared } from './member';
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

/**
 * 这个微信**现在这条有效绑定**下的单：没绑定回「请先绑定会员」；解绑、换绑之前下的单当作没有，
 * 不能再看、再付、再取消（小程序线测试 866ccfa 的 P1）。之前已经付了的照常由到账通知、补查按原单入账到原来的会员，
 * 解绑后还没付的由解绑与每分钟的补查请微信关掉（closeUnboundOrders）
 */
async function myOrder(db: Db, openid: string, orderNo: string): Promise<OrderRow> {
  if (!MP_RECHARGE_ORDER_NO.test(orderNo)) throw badRequest('充值单号不正确');
  const { bindingId } = await boundMember(db, openid);
  const [o] = await db<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE order_no = ${orderNo} AND openid = ${openid} AND binding_id = ${bindingId}`;
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
  // 绑定与版本号用一条语句读（同一个快照）：建单时带回来的版本号与这里看到的会员是同一条绑定
  const { binding, version: bindVersion } = await bindingStateOf(deps.sql, openid);
  if (!binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
  const { id: bindingId, memberId } = binding;
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
  // 只给这条绑定下的：换绑前那个微信留下、还没关上的单不给这个微信看、也付不了（下单的付款人是那个微信）
  const [pendingRow] = await deps.sql<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE binding_id = ${bindingId} AND status = 'pending'`;
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
    bindVersion,
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
    /** 顾客确认时看到的绑定状态版本号（可充项里的 bindVersion） */
    bindVersion: z.number('请刷新充值页后再下单').int('请刷新充值页后再下单').min(0, '请刷新充值页后再下单'),
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
      // 这个微信绑定状态的共享锁（解绑拿排他的）：这里读到的有效绑定到写单、提交之前不会被解绑；
      // 解绑提交之后再扫这条绑定没付的单去关，不会漏掉同时建的这一张（小程序线测试 866ccfa 的 P1）
      await lockOpenidShared(tx, openid);
      const state = await bindingStateOf(tx, openid);
      if (!state.binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
      // 顾客确认时看到的是哪一条绑定：之后解绑、换绑过（版本号变了），这是之前的请求，不再建单——
      // 否则换绑以后才到的旧请求会给换绑以后的会员建单、付款记到他身上（小程序线测试 #52 的 P1）
      if (state.version !== input.bindVersion) throw conflict('BIND_STALE', '会员绑定刚变过，这次没有下单，请回到充值页重新确认');
      const { id: bindingId, memberId } = state.binding;
      const [prev] = await tx<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE client_key = ${input.clientKey}`;
      if (prev) {
        // 同一个编号重提：只认同一个微信、同一条绑定、同样的内容；解绑、换绑之前下的单不再给这个微信
        const same =
          prev.openid === openid &&
          prev.bindingId === bindingId &&
          (input.planId !== null ? prev.planId === input.planId : prev.planId === null && prev.amount === input.amount);
        if (!same) throw conflict('CLIENT_KEY_REUSED', '这次充值的编号已经用过，请重新选择');
        return { order: prev, replayed: true };
      }
      const rules = await loadRechargeRules(tx);
      if (!rules.enabled) throw new AppError(403, 'MP_RECHARGE_DISABLED', '线上充值还没开通，请到前台充值');
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
      const [pending] = await tx<{ bindingId: number }[]>`SELECT binding_id FROM mp_recharge_orders WHERE member_id = ${memberId} AND status = 'pending'`;
      if (pending) {
        // 换绑前那个微信留下的、解绑时没关上（例如当时微信支付连不上）：每分钟的补查接着关
        if (pending.bindingId !== bindingId) throw conflict('ORDER_PENDING', '换绑之前下的那张充值单还在关闭，请过一分钟再试');
        throw conflict('ORDER_PENDING', '还有一张待支付的充值单，请先付完或取消');
      }
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
    // 下单期间这张单可能被取消、关掉了（「继续支付」与「取消」同时点）：只有还是待支付才记下 prepay_id、给支付参数；
    // 已经不是待支付的，刚才在微信下的这一单要关掉，不能留着能付（审查 2a 的 P2）。
    // 下单期间这条绑定被解除了的也一样：解绑之后不再给支付参数（小程序线测试 866ccfa 的 P1）
    // 在这个微信绑定锁的共享模式里核对、记下（解绑拿排他的）：解绑提交之后不会再记下、签出支付参数（小程序线测试 #52 的补充）
    const [kept] = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpenidShared(tx, o.openid);
      return tx<{ prepayId: string }[]>`
        UPDATE mp_recharge_orders o SET prepay_id = coalesce(o.prepay_id, ${prepayId}), updated_at = now()
        WHERE o.id = ${o.id} AND o.status = 'pending'
          AND EXISTS (SELECT 1 FROM mp_bindings b WHERE b.id = o.binding_id AND b.unbound_at IS NULL)
        RETURNING o.prepay_id`;
    });
    if (!kept) {
      await pay.client.closeOrder(o.orderNo).then(
        // 微信关上了：解绑的那种这里还是待支付，一起记已关闭（已经不是待支付的不动）；关不上的由每分钟的补查接着关
        () => closeLocally(deps.sql, o.id, 'cancelled', { unbound: true }),
        async (error: unknown) => {
          if (error instanceof WxPayError && error.code === 'ORDERPAID') await syncFromWechat(deps, pay, o, 'order');
        },
      );
      await recordEvent(deps.sql, o.id, 'wx_order', false, 'ORDER_NOT_PENDING', { message: '下单期间这张单已经不是待支付（或绑定已解除），已请微信关单' });
      throw conflict('ORDER_NOT_PENDING', '这张单已经关闭，请重新下单');
    }
    prepayId = kept.prepayId;
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
  // 已经向微信下过单（有 prepay_id）的：在这个微信绑定锁的共享模式里核对现在这条绑定、签支付参数。解绑拿排他的，
  // 所以解绑提交之后不会再签出支付参数——继续支付与解绑交错时，要么先签（解绑等它，之后请微信关单），要么解绑先提交、这里不认
  // （小程序线测试 #52 的补充）。还没下过单的走 ensurePayment：向微信下单在事务外，记下 prepay_id 时同样在这把锁里核对
  const first = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpenidShared(tx, openid);
    const order = await myOrder(tx, openid, orderNo);
    const signed = order.status === 'pending' && order.prepayId && sameMode(pay, order) ? paymentParams(pay.config, order.prepayId) : null;
    return { order, signed };
  });
  const o = first.order;
  const payment = first.signed ?? (o.status === 'pending' ? await ensurePayment(deps, pay, o) : null);
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
      // 解绑、换绑之前下的单不再给这个微信（解绑时已请微信关掉）：对现在的绑定来说这个编号就是作废了，请重新选择
      const b = await activeBinding(tx, openid);
      if (!b || b.id !== prev.bindingId) return { status: 'abandoned' as const };
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
  if (!pay?.mock || (deps.config.env !== 'development' && deps.config.env !== 'test') || ['prod', 'shadow', 'test'].includes(deps.config.instance)) {
    throw new AppError(403, 'MP_MOCK_REFUSED', '这个门店系统不接受模拟支付');
  }
  const mock = pay.mock;
  const o = await myOrder(deps.sql, openid, orderNo);
  if (o.status === 'pending') {
    if (!o.prepayId) await ensurePayment(deps, pay, o);
    // 模拟「付款」也在绑定锁的共享模式里核对这条绑定：解绑提交之后不再付（与继续支付一样）
    const n = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpenidShared(tx, openid);
      const again = await myOrder(tx, openid, orderNo);
      return again.status === 'pending' ? mock.pay(again.orderNo) : null;
    });
    if (n) {
      await handlePayNotify(deps, pay, {
        headers: n.headers,
        body: Buffer.from(n.body, 'utf8').toString('base64'),
      });
    }
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
async function closeAtWechat(deps: Deps, pay: PayRuntime, o: OrderRow, reason: 'expired' | 'cancelled' | 'wx_failed', detail: Record<string, unknown> = {}) {
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
        ...detail,
        message: messageOf(error),
      });
      throw new AppError(503, 'WXPAY_UNAVAILABLE', '微信支付暂时连不上，请稍后再试');
    }
  }
  await closeLocally(deps.sql, o.id, reason, detail);
}

/**
 * 绑定已经解除的待支付单请微信关掉（解绑之后，与每分钟的补查）：解绑、换绑之后旧单不能再付（小程序线测试 866ccfa 的 P1）。
 * 微信说已经付了的照常查单、按原单入账到原来的会员（钱不会因为解绑丢）；关不上的（微信连不上）下一分钟接着关。
 * 不传 bindingId 时扫所有已解绑的，每次最多 20 张。
 */
export async function closeUnboundOrders(deps: Deps, pay: PayRuntime | null, bindingId?: number): Promise<SweepResult> {
  const out: SweepResult = { checked: 0, errors: 0 };
  const rows = await deps.sql<OrderRow[]>`
    SELECT o.* FROM mp_recharge_orders o JOIN mp_bindings b ON b.id = o.binding_id
    WHERE o.status = 'pending' AND b.unbound_at IS NOT NULL ${bindingId === undefined ? deps.sql`` : deps.sql`AND o.binding_id = ${bindingId}`}
    ORDER BY o.id LIMIT 20`;
  for (const o of rows) {
    out.checked++;
    try {
      if (sameMode(pay, o)) await closeAtWechat(deps, pay, o, 'cancelled', { unbound: true });
      // 模拟的单在真的微信支付下（或没有微信支付时）付不了：直接关。真的单要等微信支付恢复后再关
      else if (o.mock) await closeLocally(deps.sql, o.id, 'cancelled', { unbound: true });
    } catch {
      out.errors++;
    }
  }
  return out;
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
  // PAYERROR（这一次付款失败，例如银行拒了）不是最终结果：微信那边这一单还能再付，按没付处理、到期再请微信关单
  if (t.tradeState === 'CLOSED' || t.tradeState === 'REVOKED') {
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
  if (t.outTradeNo !== o.orderNo) wrong.push(`商户单号 ${t.outTradeNo}`);
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
    // 门店这边出错（锁超时、系统账号被占用……）：记一笔；一直入不了的转「已付款待处理」给店主看，钱已经付了，不能一直挂在待支付、
    // 也挡着顾客下新单（审查 2a 的 P2）。店主之后「重新入账」按同一个交易单号去重，不会入两次
    await recordEvent(deps.sql, orderId, 'booked', false, codeOf(error), { source, message: messageOf(error), transactionId: t.transactionId }).catch(() => {});
    const [f] = await deps.sql<{ n: number; first: string | null }[]>`
      SELECT count(*)::int AS n, min(created_at) AS first FROM mp_recharge_events WHERE order_id = ${orderId} AND kind = 'booked' AND NOT ok`.catch(() => []);
    if (f && f.first && f.n >= BOOK_FAIL_TIMES && Date.now() - Date.parse(f.first) >= BOOK_FAIL_MS) {
      const held = await hold(deps.sql, orderId, t, 'BOOK_FAILED', `门店系统入账一直出错（${messageOf(error)}），请核对后重新入账`, source)
        .then(() => true)
        .catch(() => false);
      if (held) return;
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
  // 晚到的通知（微信在重发，例如门店断过网）：这期间店里可能已在商户平台把这笔退了。还没入账的，先去微信查这一单现在的状态，
  // 按查单的结果处理（已转入退款的记已付款待处理、不入账）；查不了回失败，等微信重发或每分钟补查（审查 2a 的 P2）
  const age = t.successTime ? Date.now() - Date.parse(t.successTime) : 0;
  if ((o.status === 'pending' || o.status === 'closed') && age > LATE_NOTIFY_MS && sameMode(pay, o)) {
    let current: WxTransaction | null;
    try {
      current = await pay.client.queryOrder(o.orderNo);
    } catch (error) {
      await recordEvent(deps.sql, o.id, 'query', false, codeOf(error), { source: 'notify', message: messageOf(error) });
      throw new AppError(503, 'WXPAY_UNAVAILABLE', '晚到的到账通知要先去微信查单，现在查不了，等重发');
    }
    await recordEvent(deps.sql, o.id, 'query', true, null, { source: 'notify', tradeState: current?.tradeState ?? null, transactionId: current?.transactionId ?? null });
    if (current?.tradeState === 'REFUND' && current.transactionId) {
      await hold(deps.sql, o.id, current, 'WX_REFUND', '微信支付那边这一单已转入退款，没有入账', 'notify');
      return;
    }
    if (current?.tradeState !== 'SUCCESS') {
      throw new AppError(503, 'WXPAY_STATE_UNCLEAR', `到账通知说已付，查单却是 ${current?.tradeState ?? '没有这一单'}，先不入账`);
    }
    await acceptPayment(deps, pay, o.id, current, 'notify');
    return;
  }
  await acceptPayment(deps, pay, o.id, t, 'notify');
}

/** 到账通知比付款时间晚这么久就算晚到（微信在重发）：先查单再入账 */
const LATE_NOTIFY_MS = 5 * 60_000;
/** 门店这边入账一直出错：出错 3 次以上、头一次出错已过 10 分钟，记已付款待处理给店主看 */
const BOOK_FAIL_TIMES = 3;
const BOOK_FAIL_MS = 10 * 60_000;

// ── 每分钟：补查、关单 ──

export interface SweepResult {
  checked: number;
  errors: number;
}

/** 待支付超过 2 分钟、1 分钟内没查过的去微信查（已付的入账、过期的关单）；每次最多 20 张 */
export async function sweepRechargeOrders(deps: Deps, pay: PayRuntime | null, now = new Date()): Promise<SweepResult> {
  // 解绑时没关上的（微信连不上）接着关
  const out = await closeUnboundOrders(deps, pay);
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
