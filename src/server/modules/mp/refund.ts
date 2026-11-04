// 小程序第二期 2d：原路退回（小程序线，docs/MP_RECHARGE.md 第 9 节；MP21）。
//   · 主线退储值单里交给门店系统原路退回的行（route = mp_auto，主线 v0.7.27）：每分钟按行号往后取，按行号唯一建原路退回单；
//     退储值单店主或店总当场授权过、不能作废（M74），门店系统不另外判断该不该退、退多少，只管把钱退到；
//   · 调微信支付的退款接口（事务外）：商户退款单号建单时定下，同一个单号、同样的内容微信只退一次；
//     结果按退款通知（网关同一个 /v1/pay/notify）或每 5 分钟查一次退款更新；
//   · 连不上、微信出错的自己隔一会儿再试；微信明确拒绝（例如超过可退金额、顾客的微信注销了）、找不到原单的记「没能退」，
//     与退款关闭、退款异常的一起列给店主：重试（关闭、没能退的先查旧单号确认没退到，再换新单号）或已另行处理（写怎么处理的）；
//   · 开关：门店系统的微信支付配好、店主在后台开着「原路退回」时才向主线报「能接」（registerOnlineRefundRoute），
//     主线的退储值才给选「门店系统原路退回」；关掉只影响以后的退储值，已经交给门店系统的照样退完。

import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { MpRefundOrderAdmin, MpRefundStatus } from '@shared/mp';
import type { Db, Sql } from '../../db';
import type { Deps, OpContext } from '../../lib/context';
import { writeAudit } from '../../lib/audit';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { listOnlineRefundLines, registerOnlineRefundRoute } from '../member-refunds';
import { activePay, type PayRuntime } from './pay';
import { loadRechargeRules } from './rules';
import { OUT_REFUND_NO, WxPayError, type WxRefund } from './wxpay';

interface RefundRow {
  id: number;
  lineId: number;
  memberRefundId: number;
  memberId: number;
  rechargeId: number;
  rechargeOrderId: number | null;
  outTradeNo: string | null;
  transactionId: string;
  outRefundNo: string;
  amount: number;
  total: number | null;
  mock: boolean;
  status: MpRefundStatus;
  wxRefundId: string | null;
  attempts: number;
  nextTryAt: string | null;
  queriedAt: string | null;
}

type EventKind = 'created' | 'apply' | 'query' | 'notify' | 'retry' | 'handled';

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const codeOf = (error: unknown) => {
  const c = error instanceof WxPayError || error instanceof AppError ? error.code : 'ERROR';
  return CODE.test(c) ? c : 'ERROR';
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function recordEvent(db: Db, orderId: number | null, kind: EventKind, ok: boolean, code: string | null, detail: Record<string, unknown> = {}, staffId: number | null = null) {
  await db`
    INSERT INTO mp_refund_events (order_id, kind, ok, code, detail, staff_id)
    VALUES (${orderId}, ${kind}, ${ok}, ${code && CODE.test(code) ? code : null}, ${db.json(detail as never)}, ${staffId})`;
}

/** 北京时间的日期（YYYY-MM-DD）：退款单号里用；不从 recharge-recon 引，免得 recharge → refund → recharge-recon → recharge 绕一圈 */
const beijingDate = (d: Date) => new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
const NO_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 商户退款单号：MPRF + 北京时间的日期 + 10 位随机 */
function newRefundNo(now = new Date()): string {
  let tail = '';
  for (let i = 0; i < 10; i++) tail += NO_CHARS[randomInt(NO_CHARS.length)];
  const no = `MPRF${beijingDate(now).replace(/-/g, '')}${tail}`;
  if (!OUT_REFUND_NO.test(no)) throw new Error('商户退款单号格式不对');
  return no;
}

const lockRefund = async (db: Db, id: number) => (await db<RefundRow[]>`SELECT * FROM mp_refund_orders WHERE id = ${id} FOR UPDATE`)[0] ?? null;
const sameMode = (pay: PayRuntime | null, o: RefundRow): pay is PayRuntime => !!pay && o.mock === (pay.mode === 'mock');

/** 顾客在微信退款消息里看到的原因 */
const REASON = '会员储值退回';
/** 处理中的多久查一次退款 */
const QUERY_EVERY_MS = 5 * 60_000;
/** 连不上、微信出错：第 n 次之后隔 2^n 分钟再试，最长 1 小时；商户号余额不够隔 30 分钟 */
const backoffMs = (attempts: number, code: string) => (code === 'NOT_ENOUGH' ? 30 * 60_000 : Math.min(60, 2 ** Math.min(attempts, 6)) * 60_000);
/** 这些拒绝码等一会儿再试（没退成也不算定了）：余额不够、太频繁、微信那边出错 */
const RETRY_LATER = new Set(['NOT_ENOUGH', 'FREQUENCY_LIMITED', 'SYSTEM_ERROR', 'BIZERR_NEED_RETRY']);

// ── 向主线报能不能接 ──

/** 此刻能不能接新的原路退回：门店系统的微信支付配好了、店主开着「原路退回」 */
export async function onlineRefundAvailable(db: Db): Promise<boolean> {
  if (!activePay()) return false;
  return (await loadRechargeRules(db)).refundAuto;
}

/** 启动小程序端口时向主线注册（主线的退储值按它决定给不给选「门店系统原路退回」） */
export function registerRefundRoute(): void {
  registerOnlineRefundRoute({ available: onlineRefundAvailable });
}

// ── 同一张原路退回单串行 ──

/**
 * 同一张原路退回单的申请、查退款、店主的重试与另行处理一张一张来（独立审查 2d 的 P1）：这几步要跨着调微信，
 * 所以用会话级咨询锁，拿一条单独借出的连接拿着，不开事务、不锁别的表；锁里先重读这一张，按读到的单号办，之后每次改写都核对单号。
 * 每分钟的扫描拿不到就跳过这一张（下一分钟再来）；店主的操作最多等 15 秒，等不到回「稍后再试」。
 */
async function withRefundLock<T>(sql: Sql, id: number, wait: boolean, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const conn = await sql.reserve();
  const key = `mp_refund:${id}`;
  let locked = false;
  try {
    for (let i = 0; ; i++) {
      const [r] = await conn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${key})) AS ok`;
      if (r?.ok) {
        locked = true;
        break;
      }
      if (!wait || i >= 60) return { ok: false };
      await new Promise((res) => setTimeout(res, 250));
    }
    return { ok: true, value: await fn() };
  } finally {
    if (locked) await conn`SELECT pg_advisory_unlock(hashtext(${key}))`.catch(() => {});
    conn.release();
  }
}

/** 店主的操作：拿到这一张的锁再办；等不到（正在向微信申请）回稍后再试 */
async function asOwner<T>(sql: Sql, id: number, fn: () => Promise<T>): Promise<T> {
  const r = await withRefundLock(sql, id, true, fn);
  if (!r.ok) throw conflict('REFUND_BUSY', '这一笔正在向微信支付申请，请稍后再试');
  return r.value;
}

const readRefund = async (db: Db, id: number) => (await db<RefundRow[]>`SELECT * FROM mp_refund_orders WHERE id = ${id}`)[0] ?? null;

// ── 每分钟：取新的行、申请退款、查处理中的 ──

/**
 * 取交给门店系统的行，每行建一张原路退回单（按行号唯一；找不到原来那笔线上充值单的记「没能退」）。
 * 不用「已经取到第几行」记位置：行号小的可能比行号大的晚提交（独立审查 2d 的 P2），所以每次从「还没建单的里行号最小的」往后取
 */
export async function pullRefundLines(deps: Deps, pay: PayRuntime | null, now = new Date()): Promise<number> {
  const [gap] = await deps.sql<{ id: number | null }[]>`
    SELECT min(l.id) AS id FROM member_refund_lines l
    WHERE l.route = 'mp_auto' AND NOT EXISTS (SELECT 1 FROM mp_refund_orders o WHERE o.line_id = l.id)`;
  if (gap?.id === null || gap?.id === undefined) return 0;
  let afterId = Number(gap.id) - 1;
  let created = 0;
  for (let page = 0; page < 5; page++) {
    const lines = await listOnlineRefundLines(deps.sql, { afterId, limit: 100 });
    for (const l of lines) {
      afterId = l.lineId;
      const [o] = await deps.sql<{ id: number; orderNo: string; amount: number; mock: boolean }[]>`
        SELECT id, order_no, amount, mock FROM mp_recharge_orders WHERE recharge_id = ${l.rechargeId}`;
      const missing = !o;
      const [row] = await deps.sql<{ id: number }[]>`
        INSERT INTO mp_refund_orders (line_id, member_refund_id, member_id, recharge_id, recharge_order_id, out_trade_no, transaction_id,
                                      out_refund_no, amount, total, mock, status, fail_code, fail_message, created_at, updated_at)
        VALUES (${l.lineId}, ${l.refundId}, ${l.memberId}, ${l.rechargeId}, ${o?.id ?? null}, ${o?.orderNo ?? null}, ${l.paymentRef},
                ${newRefundNo(now)}, ${l.amount}, ${o?.amount ?? null}, ${o ? o.mock : pay?.mode === 'mock'},
                ${missing ? 'failed' : 'new'}, ${missing ? 'ORDER_NOT_FOUND' : null},
                ${missing ? '门店系统里找不到这笔充值对应的线上充值单，没法原路退回，请在商户平台按交易单号退' : null}, ${now}, ${now})
        ON CONFLICT (line_id) DO NOTHING
        RETURNING id`;
      if (!row) continue;
      created++;
      await recordEvent(deps.sql, row.id, 'created', !missing, missing ? 'ORDER_NOT_FOUND' : null, {
        lineId: l.lineId,
        refundNo: l.refundNo,
        amount: l.amount,
        transactionId: l.paymentRef,
      });
    }
    if (lines.length < 100) break;
  }
  return created;
}

/**
 * 按微信支付回来的退款更新原路退回单（申请的应答、查退款、退款通知都走这里）：只认这一张现在的商户退款单号；已经定了的不动。
 * 「没能退」的，微信那边对现在这个单号说了在退、退到了，以微信的为准（独立审查 2d 的 P1）
 */
async function settle(sql: Sql, orderId: number, r: WxRefund, source: 'apply' | 'query' | 'notify'): Promise<void> {
  await sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const o = await lockRefund(tx, orderId);
    if (!o) return;
    if (r.outRefundNo !== o.outRefundNo || r.refund !== Number(o.amount)) {
      // 退款单号、金额与原路退回单对不上（例如换过单号之后旧单号的通知）：只记下来给店主看，不改状态
      await recordEvent(tx, o.id, source, false, 'MISMATCH', { outRefundNo: r.outRefundNo, refund: r.refund, expected: Number(o.amount), current: o.outRefundNo });
      return;
    }
    const next: MpRefundStatus | null =
      r.status === 'SUCCESS' ? 'success' : r.status === 'PROCESSING' ? 'processing' : r.status === 'ABNORMAL' ? 'abnormal' : r.status === 'CLOSED' ? 'closed' : null;
    const allowed: Record<MpRefundStatus, MpRefundStatus[]> = {
      new: ['processing', 'success', 'abnormal', 'closed'],
      processing: ['success', 'abnormal', 'closed'],
      abnormal: ['success', 'closed'],
      failed: ['processing', 'success', 'abnormal', 'closed'],
      success: [],
      closed: [],
      handled: [],
    };
    await recordEvent(tx, o.id, source, true, null, { status: r.status, refundId: r.refundId, account: r.userReceivedAccount, outRefundNo: r.outRefundNo });
    if (!next || next === o.status) {
      await tx`UPDATE mp_refund_orders SET wx_refund_id = coalesce(wx_refund_id, ${r.refundId}), queried_at = now(), updated_at = now() WHERE id = ${o.id}`;
      return;
    }
    if (!allowed[o.status].includes(next)) return;
    await tx`
      UPDATE mp_refund_orders
      SET status = ${next}, wx_refund_id = ${r.refundId}, received_account = ${r.userReceivedAccount?.slice(0, 64) ?? null},
          succeeded_at = ${next === 'success' ? (r.successTime ? new Date(r.successTime) : new Date()) : null},
          fail_code = ${next === 'success' || next === 'processing' ? null : next === 'abnormal' ? 'REFUND_ABNORMAL' : 'REFUND_CLOSED'},
          fail_message = ${next === 'abnormal' ? '微信支付退款异常（例如顾客的银行卡注销了），请到商户平台处理' : next === 'closed' ? '微信支付把这笔退款关了，没有退到' : null},
          queried_at = now(), updated_at = now()
      WHERE id = ${o.id}`;
  });
}

/**
 * 申请退款（拿着这一张的锁、事务外调微信）：重读这一张，还是待申请、单号还是 expectedNo 才申请；之后每次改写都核对单号。
 * 同一个商户退款单号、同样的内容微信回同一笔，不会退两次
 */
async function applyLocked(deps: Deps, pay: PayRuntime, id: number, expectedNo: string, now: Date): Promise<void> {
  const o = await readRefund(deps.sql, id);
  if (!o || o.status !== 'new' || o.outRefundNo !== expectedNo || !sameMode(pay, o) || !o.outTradeNo || o.total === null) return;
  const no = o.outRefundNo;
  try {
    const r = await pay.client.refund({ outTradeNo: o.outTradeNo, outRefundNo: no, reason: REASON, refundCents: Number(o.amount), totalCents: Number(o.total) });
    await deps.sql`
      UPDATE mp_refund_orders SET attempts = attempts + 1, next_try_at = NULL, updated_at = now()
      WHERE id = ${id} AND status = 'new' AND out_refund_no = ${no}`;
    await settle(deps.sql, id, r, 'apply');
  } catch (error) {
    const code = codeOf(error);
    await recordEvent(deps.sql, id, 'apply', false, code, { message: messageOf(error), outRefundNo: no });
    const definite = error instanceof WxPayError && error.status !== undefined && error.status >= 400 && error.status < 500 && !RETRY_LATER.has(error.code);
    if (definite) {
      // 微信明确拒绝（例如超过可退金额：店里可能已经在商户平台手动退过；顾客的微信注销了）：记没能退，给店主看
      await deps.sql`
        UPDATE mp_refund_orders SET status = 'failed', fail_code = ${code}, fail_message = ${messageOf(error)}, attempts = attempts + 1, updated_at = now()
        WHERE id = ${id} AND status = 'new' AND out_refund_no = ${no}`;
    } else {
      await deps.sql`
        UPDATE mp_refund_orders
        SET attempts = attempts + 1, next_try_at = ${new Date(now.getTime() + backoffMs(o.attempts + 1, code))},
            fail_code = ${code}, fail_message = ${messageOf(error)}, updated_at = now()
        WHERE id = ${id} AND status = 'new' AND out_refund_no = ${no}`;
    }
  }
}

/** 查退款（拿着这一张的锁、事务外调微信）：处理中、退款异常的，按这一张现在的单号查 */
async function queryLocked(deps: Deps, pay: PayRuntime, id: number): Promise<void> {
  const o = await readRefund(deps.sql, id);
  if (!o || (o.status !== 'processing' && o.status !== 'abnormal') || !sameMode(pay, o)) return;
  try {
    const r = await pay.client.queryRefund(o.outRefundNo);
    await deps.sql`UPDATE mp_refund_orders SET queried_at = now() WHERE id = ${id}`;
    if (r) await settle(deps.sql, id, r, 'query');
  } catch (error) {
    await recordEvent(deps.sql, id, 'query', false, codeOf(error), { message: messageOf(error), outRefundNo: o.outRefundNo });
  }
}

/** 2b 对账用：账单说退到了、门店还没记的，拿着这一张的锁按现在的单号去微信查一次；返回之后的状态 */
export async function syncRefundOrder(deps: Deps, pay: PayRuntime, id: number): Promise<MpRefundStatus | null> {
  await withRefundLock(deps.sql, id, true, async () => {
    const o = await readRefund(deps.sql, id);
    if (!o || o.status === 'success' || o.status === 'handled' || !sameMode(pay, o)) return;
    try {
      const r = await pay.client.queryRefund(o.outRefundNo);
      if (r) await settle(deps.sql, id, r, 'query');
    } catch (error) {
      await recordEvent(deps.sql, id, 'query', false, codeOf(error), { message: messageOf(error), source: 'recon', outRefundNo: o.outRefundNo });
    }
  }).catch(() => null);
  return (await readRefund(deps.sql, id))?.status ?? null;
}

export interface RefundSweep {
  created: number;
  applied: number;
  queried: number;
  errors: number;
}

/**
 * 每分钟：取新的行、申请到时候的、查处理中的（每张 5 分钟查一次）；每次最多各 20 张。
 * 几步互不连累：前一步出错（例如数据库一时连不上）照样做后面的，下一分钟再来
 */
export async function processRefunds(deps: Deps, pay: PayRuntime | null, now = new Date()): Promise<RefundSweep> {
  const out: RefundSweep = { created: 0, applied: 0, queried: 0, errors: 0 };
  try {
    out.created = await pullRefundLines(deps, pay, now);
  } catch {
    out.errors++;
  }
  if (!pay) return out;
  try {
    // 模拟的单在真的微信支付下（或反过来）退不了：记没能退给店主看
    await deps.sql`
      UPDATE mp_refund_orders SET status = 'failed', fail_code = 'PAY_MODE_CHANGED', fail_message = '门店系统的微信支付换过了，这笔退不了，请另行处理', updated_at = now()
      WHERE status = 'new' AND mock <> ${pay.mode === 'mock'}`;
    const due = await deps.sql<RefundRow[]>`
      SELECT * FROM mp_refund_orders
      WHERE status = 'new' AND mock = ${pay.mode === 'mock'} AND (next_try_at IS NULL OR next_try_at <= ${now})
      ORDER BY id LIMIT 20`;
    for (const o of due) {
      const r = await withRefundLock(deps.sql, o.id, false, () => applyLocked(deps, pay, o.id, o.outRefundNo, now)).catch(() => null);
      if (r?.ok) out.applied++;
      else if (r === null) out.errors++;
    }
  } catch {
    out.errors++;
  }
  try {
    const processing = await deps.sql<RefundRow[]>`
      SELECT * FROM mp_refund_orders
      WHERE status IN ('processing', 'abnormal') AND mock = ${pay.mode === 'mock'}
        AND (queried_at IS NULL OR queried_at <= ${new Date(now.getTime() - QUERY_EVERY_MS)})
      ORDER BY id LIMIT 20`;
    for (const o of processing) {
      const r = await withRefundLock(deps.sql, o.id, false, () => queryLocked(deps, pay, o.id)).catch(() => null);
      if (r?.ok) out.queried++;
      else if (r === null) out.errors++;
    }
  } catch {
    out.errors++;
  }
  return out;
}

/** 退款通知（网关转来、已验签解密）：找到原路退回单就按它更新；找不到的（例如商户平台上手动退的）记一条，同一笔只记一次 */
export async function handleRefundNotice(deps: Deps, r: WxRefund, notifyId: string): Promise<void> {
  const [o] = await deps.sql<{ id: number }[]>`SELECT id FROM mp_refund_orders WHERE out_refund_no = ${r.outRefundNo}`;
  if (!o) {
    const [seen] = await deps.sql`SELECT 1 FROM mp_refund_events WHERE order_id IS NULL AND code = 'UNKNOWN_REFUND' AND detail->>'refundId' = ${r.refundId}`;
    if (!seen) {
      await recordEvent(deps.sql, null, 'notify', false, 'UNKNOWN_REFUND', { refundId: r.refundId, outRefundNo: r.outRefundNo, status: r.status, refund: r.refund, notifyId });
    }
    return;
  }
  await settle(deps.sql, o.id, r, 'notify');
}

// ── 后台：重试、已另行处理（权限 mp.recharge）──

const SELECT_ADMIN = (db: Db) => db`
  SELECT o.*, m.name AS member_name, m.member_no, r.refund_no AS member_refund_no, rc.doc_no AS recharge_doc_no, s.display_name AS handled_by_name
  FROM mp_refund_orders o
  JOIN members m ON m.id = o.member_id
  JOIN member_refunds r ON r.id = o.member_refund_id
  JOIN recharges rc ON rc.id = o.recharge_id
  LEFT JOIN staff s ON s.id = o.handled_by`;

type AdminRow = RefundRow & {
  memberName: string;
  memberNo: string;
  memberRefundNo: string;
  rechargeDocNo: string;
  receivedAccount: string | null;
  succeededAt: string | null;
  failCode: string | null;
  failMessage: string | null;
  handledNote: string | null;
  handledByName: string | null;
  handledAt: string | null;
  createdAt: string;
};
const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);
function toAdmin(r: AdminRow): MpRefundOrderAdmin {
  return {
    id: Number(r.id),
    createdAt: iso(r.createdAt)!,
    status: r.status,
    memberId: Number(r.memberId),
    memberName: r.memberName,
    memberNo: r.memberNo,
    memberRefundNo: r.memberRefundNo,
    rechargeDocNo: r.rechargeDocNo,
    outTradeNo: r.outTradeNo,
    transactionId: r.transactionId,
    outRefundNo: r.outRefundNo,
    amount: Number(r.amount),
    wxRefundId: r.wxRefundId,
    receivedAccount: r.receivedAccount,
    succeededAt: iso(r.succeededAt),
    failCode: r.failCode,
    failMessage: r.failMessage,
    attempts: r.attempts,
    nextTryAt: iso(r.nextTryAt),
    handledNote: r.handledNote,
    handledByName: r.handledByName,
    handledAt: iso(r.handledAt),
  };
}

/** 后台：要店主看的（没退成的、处理中的）全部，加最近的 30 张 */
export async function refundAdminList(db: Db): Promise<MpRefundOrderAdmin[]> {
  const open = await db<AdminRow[]>`${SELECT_ADMIN(db)} WHERE o.status NOT IN ('success', 'handled') ORDER BY o.id DESC`;
  const recent = await db<AdminRow[]>`${SELECT_ADMIN(db)} WHERE o.status IN ('success', 'handled') ORDER BY o.id DESC LIMIT 30`;
  return [...open, ...recent].map(toAdmin);
}

async function adminRow(db: Db, id: number): Promise<MpRefundOrderAdmin> {
  const [r] = await db<AdminRow[]>`${SELECT_ADMIN(db)} WHERE o.id = ${id}`;
  if (!r) throw notFound('原路退回单不存在');
  return toAdmin(r);
}

const ActInput = z.object({
  /** 店主看到的商户退款单号：已经变了（别人刚重试过）就拒绝，请刷新再看（独立审查 2d 的 P2） */
  outRefundNo: z.string().regex(OUT_REFUND_NO, '商户退款单号不正确'),
});
const HandleInput = ActInput.extend({
  note: z.string('请写怎么处理的').trim().min(1, '请写怎么处理的').max(200, '最多 200 字'),
});
const changed = () => conflict('REFUND_CHANGED', '这一笔刚被别人处理过（退款单号变了），请刷新后再看');

/**
 * 重试（拿着这一张的锁）：待申请的（连不上、余额不够等）马上再试，单号不变；关闭了、没能退的先查旧单号——
 * 微信那边已经退到或在退的按它记，确认没退到（没有这一笔、或已关闭）才换一个新的商户退款单号重新申请（关闭了的单号不能再用）。
 * 找不到原单的重试不了，只能已另行处理
 */
export async function retryRefund(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<MpRefundOrderAdmin> {
  const input = parse(ActInput, raw);
  const pay = activePay();
  await asOwner(deps.sql, id, async () => {
    const o = await readRefund(deps.sql, id);
    if (!o) throw notFound('原路退回单不存在');
    if (o.outRefundNo !== input.outRefundNo) throw changed();
    if (o.status === 'new') {
      await deps.sql`UPDATE mp_refund_orders SET next_try_at = NULL, updated_at = now() WHERE id = ${id} AND status = 'new' AND out_refund_no = ${o.outRefundNo}`;
      await recordEvent(deps.sql, id, 'retry', true, null, { outRefundNo: o.outRefundNo, now: true }, ctx.actor.id);
      if (sameMode(pay, o)) await applyLocked(deps, pay, id, o.outRefundNo, new Date());
      return;
    }
    if (o.status !== 'closed' && o.status !== 'failed') throw conflict('REFUND_NOT_RETRYABLE', '这笔原路退回现在不能重试，请刷新后再看');
    if (!o.outTradeNo) throw unprocessable('ORDER_NOT_FOUND', '找不到原来那笔线上充值单，没法原路退回；请在商户平台按交易单号退，再记已另行处理');
    if (!sameMode(pay, o)) throw new AppError(503, 'MP_PAY_UNAVAILABLE', '门店系统的微信支付现在用不了，稍后再试');
    // 先查旧单号：已经退到、在退的照实记，不另退
    let old: WxRefund | null;
    try {
      old = await pay.client.queryRefund(o.outRefundNo);
    } catch (error) {
      await recordEvent(deps.sql, id, 'query', false, codeOf(error), { message: messageOf(error), source: 'retry', outRefundNo: o.outRefundNo }, ctx.actor.id);
      throw new AppError(503, 'WXPAY_UNAVAILABLE', '微信支付暂时连不上，稍后再试');
    }
    if (old && old.status !== 'CLOSED') {
      // 没能退的在微信那边其实有这一笔（在退或退到了）：按微信的记；关闭了的又查到不是关闭（不该有）：只记一条
      if (o.status === 'failed') await settle(deps.sql, id, old, 'query');
      else await recordEvent(deps.sql, id, 'query', false, 'NOT_CLOSED', { status: old.status, source: 'retry', outRefundNo: o.outRefundNo }, ctx.actor.id);
      return;
    }
    const fresh = newRefundNo();
    const renamed = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const locked = await lockRefund(tx, id);
      if (!locked || locked.outRefundNo !== input.outRefundNo || (locked.status !== 'closed' && locked.status !== 'failed')) return false;
      await tx`
        UPDATE mp_refund_orders
        SET status = 'new', out_refund_no = ${fresh}, attempts = 0, next_try_at = NULL, fail_code = NULL, fail_message = NULL,
            wx_refund_id = NULL, received_account = NULL, queried_at = NULL, updated_at = now()
        WHERE id = ${id}`;
      await recordEvent(tx, id, 'retry', true, null, { from: input.outRefundNo, to: fresh, previous: locked.status }, ctx.actor.id);
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'mp_refund_retried',
        targetType: 'member',
        targetId: Number(locked.memberId),
        detail: { refundOrderId: id, from: input.outRefundNo, to: fresh },
        ip: ctx.ip,
      });
      return true;
    });
    if (renamed) await applyLocked(deps, pay, id, fresh, new Date());
  });
  return adminRow(deps.sql, id);
}

/**
 * 已另行处理（拿着这一张的锁）：退款异常、关闭、没能退的，店主在商户平台或前台处理了，写怎么处理的。
 * 没能退的、向微信申请过的，先按现在的单号查一次：微信那边在退或退到了的不让另行处理（免得顾客收两次，独立审查 2d 的 P1）
 */
export async function handleRefund(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<MpRefundOrderAdmin> {
  const input = parse(HandleInput, raw);
  const pay = activePay();
  await asOwner(deps.sql, id, async () => {
    const o = await readRefund(deps.sql, id);
    if (!o) throw notFound('原路退回单不存在');
    if (o.outRefundNo !== input.outRefundNo) throw changed();
    // 同一个单号重提（结果待确认时）：已经记了就照旧返回
    if (o.status === 'handled') return;
    if (o.status !== 'abnormal' && o.status !== 'closed' && o.status !== 'failed') {
      throw conflict('REFUND_NOT_HANDLEABLE', o.status === 'success' ? '这笔已经原路退到了，不用另行处理' : '这笔还在退，等有了结果再处理');
    }
    if (o.status === 'failed' && o.attempts > 0 && o.outTradeNo) {
      if (!sameMode(pay, o)) throw new AppError(503, 'MP_PAY_UNAVAILABLE', '门店系统的微信支付现在用不了，查不了这一笔，稍后再试');
      let now: WxRefund | null;
      try {
        now = await pay.client.queryRefund(o.outRefundNo);
      } catch (error) {
        await recordEvent(deps.sql, id, 'query', false, codeOf(error), { message: messageOf(error), source: 'handle', outRefundNo: o.outRefundNo }, ctx.actor.id);
        throw new AppError(503, 'WXPAY_UNAVAILABLE', '微信支付暂时连不上，查不了这一笔，稍后再试');
      }
      if (now && now.status !== 'CLOSED') {
        await settle(deps.sql, id, now, 'query');
        throw conflict('REFUND_IN_WECHAT', '微信支付那边这一笔在退或已经退到了，不能另行处理；请刷新看最新的状态');
      }
    }
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const locked = await lockRefund(tx, id);
      if (!locked || locked.outRefundNo !== input.outRefundNo) throw changed();
      if (locked.status !== 'abnormal' && locked.status !== 'closed' && locked.status !== 'failed') throw conflict('REFUND_NOT_HANDLEABLE', '这笔的状态刚变了，请刷新后再看');
      await tx`
        UPDATE mp_refund_orders SET status = 'handled', handled_note = ${input.note}, handled_by = ${ctx.actor.id}, handled_at = now(), updated_at = now()
        WHERE id = ${id}`;
      await recordEvent(tx, id, 'handled', true, null, { note: input.note, previous: locked.status }, ctx.actor.id);
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'mp_refund_handled',
        targetType: 'member',
        targetId: Number(locked.memberId),
        detail: { refundOrderId: id, note: input.note },
        ip: ctx.ip,
      });
    });
  });
  return adminRow(deps.sql, id);
}
