// 小程序第二期 2b：对账（小程序线，docs/MP_RECHARGE.md 第 8 节）。
// 每天北京时间 10 点半以后下前一天的微信支付交易账单，与线上充值单逐笔核对，结论只追加地记在 mp_recharge_recons，标红的给店主看。
// 只看、只记：不改单子、不动钱。唯一会动的是「微信有、门店还没记」的那一笔：先按商户单号去微信查单（与每分钟补查同一条路），
// 补上了就不算没对上。同一个商户号下不是小程序的交易（例如前台扫码收款，商户单号不是 MPR 开头）不核对，只数一下。

import { MP_RECHARGE_ORDER_NO, MP_REFUND_NO, type MpRechargeRecon, type MpReconIssue } from '@shared/mp';
import type { Db } from '../../db';
import type { Deps } from '../../lib/context';
import type { PayRuntime } from './pay';
import { syncOrderFromWechat, type OrderRow } from './recharge';
import { syncRefundOrder } from './refund';
import { WxPayError } from './wxpay';

/** 微信支付的账单按北京时间的自然日 */
const WX_TZ = 'Asia/Shanghai';
/** 前一天的账单上午 10 点以后才能下；留半小时余量 */
const READY_MINUTES = 10 * 60 + 30;

const beijing = (d: Date) => new Date(d.getTime() + 8 * 3_600_000);
/** 北京时间的日期 YYYY-MM-DD */
export const beijingDate = (d: Date) => beijing(d).toISOString().slice(0, 10);
const yesterdayOf = (d: Date) => beijingDate(new Date(d.getTime() - 86_400_000));

type Who = { source: 'auto' } | { source: 'manual'; staffId: number };

export async function reconcileDay(deps: Deps, pay: PayRuntime, billDate: string, who: Who): Promise<MpRechargeRecon> {
  const bill = await pay.client.tradeBill(billDate);
  // 只核对小程序线上充值的交易（商户单号是 MPR 开头的）；同一个商户号下的别的交易不管
  const mine = bill.filter((r) => MP_RECHARGE_ORDER_NO.test(r.outTradeNo));
  const success = mine.filter((r) => r.tradeState === 'SUCCESS');
  const refunds = mine
    .filter((r) => r.tradeState === 'REFUND' || r.refundId)
    .map((r) => ({ transactionId: r.transactionId, refundId: r.refundId, amount: r.refundAmount, status: r.refundStatus }));

  const issues: MpReconIssue[] = [];
  const matched = new Set<string>();
  for (const r of success) {
    let [o] = await deps.sql<OrderRow[]>`SELECT * FROM mp_recharge_orders WHERE order_no = ${r.outTradeNo}`;
    if (!o) {
      issues.push({
        kind: 'UNKNOWN_ORDER',
        outTradeNo: r.outTradeNo,
        transactionId: r.transactionId,
        wxAmount: r.amount,
        storeAmount: null,
        note: '微信支付已收款，门店系统里没有这张单（例如门店系统从备份恢复过）',
      });
      continue;
    }
    if (!o.transactionId) {
      // 到账通知没送到、补查也还没查到：先去微信查一次，补上了就照常入账（或记已付款待处理）
      o = await syncOrderFromWechat(deps, pay, o.id).catch(() => o!);
    }
    if (!o.transactionId) {
      issues.push({
        kind: 'NOT_BOOKED',
        outTradeNo: r.outTradeNo,
        transactionId: r.transactionId,
        wxAmount: r.amount,
        storeAmount: null,
        note: '微信支付已收款，门店系统还没记上（查单也没补上）',
      });
      continue;
    }
    if (o.transactionId !== r.transactionId) {
      issues.push({
        kind: 'TX_MISMATCH',
        outTradeNo: r.outTradeNo,
        transactionId: r.transactionId,
        wxAmount: r.amount,
        storeAmount: o.amount,
        note: `门店系统记的交易单号是 ${o.transactionId}`,
      });
      continue;
    }
    matched.add(r.transactionId);
    if (r.amount !== o.amount) {
      issues.push({
        kind: 'AMOUNT_MISMATCH',
        outTradeNo: r.outTradeNo,
        transactionId: r.transactionId,
        wxAmount: r.amount,
        storeAmount: o.amount,
        note: '同一笔交易两边的金额不一样',
      });
    }
  }

  // 门店系统里这一天付款的单子（已入账、已付款待处理、已处理），微信那天的账单里都要有
  const ours = await paidOn(deps.sql, billDate);
  for (const o of ours) {
    if (matched.has(o.transactionId!)) continue;
    const t = Date.parse(o.paidAt!);
    const nearMidnight = Math.min(...[0, 1].map((k) => Math.abs(t - Date.parse(`${billDate}T00:00:00+08:00`) - k * 86_400_000))) < 10 * 60_000;
    issues.push({
      kind: 'NOT_IN_BILL',
      outTradeNo: o.orderNo,
      transactionId: o.transactionId,
      wxAmount: null,
      storeAmount: o.amount,
      note: nearMidnight ? '门店记了、微信这一天的账单里没有；付款在零点前后，请看前后一天的对账' : '门店记了、微信这一天的账单里没有',
    });
  }

  issues.push(...(await reconcileRefunds(deps, pay, billDate, mine)));

  const [row] = await deps.sql<{ id: number }[]>`
    INSERT INTO mp_recharge_recons (bill_date, ok, wx_count, wx_amount, store_count, store_amount, issues, refunds, source, staff_id)
    VALUES (${billDate}, ${issues.length === 0}, ${success.length}, ${success.reduce((a, r) => a + r.amount, 0)},
            ${ours.length}, ${ours.reduce((a, o) => a + o.amount, 0)}, ${deps.sql.json(issues as never)}, ${deps.sql.json(refunds as never)},
            ${who.source}, ${who.source === 'manual' ? who.staffId : null})
    RETURNING id`;
  return (await recentRecons(deps.sql, 1, row!.id))[0]!;
}

type RefundRecon = { id: number; outRefundNo: string; outTradeNo: string | null; transactionId: string; amount: number; status: string; succeededAt: string | null };

/**
 * 2d 原路退回：账单里商户退款单号是 MPRF 开头的退款行（门店系统自己申请的）与原路退回单逐笔核对；
 * 微信说退到了、门店还没记的，先按现在的单号去微信查一次（与每分钟的查退款同一条路），补上了就不算没对上。
 * 同一个商户号下在商户平台手动退的（单号不是 MPRF 开头）只列在退款里，不核对
 */
async function reconcileRefunds(deps: Deps, pay: PayRuntime, billDate: string, mine: { tradeState: string; outTradeNo: string; transactionId: string; refundAmount: number | null; refundStatus: string | null; outRefundNo: string | null }[]): Promise<MpReconIssue[]> {
  const issues: MpReconIssue[] = [];
  const matched = new Set<string>();
  const rows = mine.filter((r) => r.tradeState === 'REFUND' && r.outRefundNo && MP_REFUND_NO.test(r.outRefundNo));
  const load = async (no: string) =>
    (await deps.sql<RefundRecon[]>`SELECT id, out_refund_no, out_trade_no, transaction_id, amount, status, succeeded_at FROM mp_refund_orders WHERE out_refund_no = ${no}`)[0] ?? null;
  for (const r of rows) {
    let ro = await load(r.outRefundNo!);
    if (!ro) {
      issues.push({
        kind: 'REFUND_UNKNOWN',
        outTradeNo: r.outTradeNo,
        transactionId: r.transactionId,
        wxAmount: r.refundAmount,
        storeAmount: null,
        note: `微信支付退了一笔（商户退款单号 ${r.outRefundNo}），门店系统里没有这张原路退回单（例如门店系统从备份恢复过）`,
      });
      continue;
    }
    if (ro.status !== 'success' && (r.refundStatus === 'SUCCESS' || r.refundStatus === null)) {
      await syncRefundOrder(deps, pay, Number(ro.id));
      ro = (await load(r.outRefundNo!))!;
    }
    if (ro.status !== 'success') {
      issues.push({
        kind: 'REFUND_NOT_RECORDED',
        outTradeNo: r.outTradeNo,
        transactionId: r.transactionId,
        wxAmount: r.refundAmount,
        storeAmount: Number(ro.amount),
        note: `微信支付已经退了（商户退款单号 ${r.outRefundNo}），门店系统还没记已退到（查退款也没补上）`,
      });
      continue;
    }
    matched.add(ro.outRefundNo);
    if (r.refundAmount !== Number(ro.amount)) {
      issues.push({
        kind: 'REFUND_AMOUNT_MISMATCH',
        outTradeNo: r.outTradeNo,
        transactionId: r.transactionId,
        wxAmount: r.refundAmount,
        storeAmount: Number(ro.amount),
        note: `同一笔退款（商户退款单号 ${r.outRefundNo}）两边的金额不一样`,
      });
    }
  }
  // 门店系统里这一天（北京时间）退到的原路退回单，微信那天的账单里都要有
  const ours = await deps.sql<RefundRecon[]>`
    SELECT id, out_refund_no, out_trade_no, transaction_id, amount, status, succeeded_at FROM mp_refund_orders
    WHERE status = 'success' AND (succeeded_at AT TIME ZONE ${WX_TZ})::date = ${billDate}::date ORDER BY id`;
  for (const ro of ours) {
    if (matched.has(ro.outRefundNo)) continue;
    const t = Date.parse(ro.succeededAt!);
    const nearMidnight = Math.min(...[0, 1].map((k) => Math.abs(t - Date.parse(`${billDate}T00:00:00+08:00`) - k * 86_400_000))) < 10 * 60_000;
    issues.push({
      kind: 'REFUND_NOT_IN_BILL',
      outTradeNo: ro.outTradeNo,
      transactionId: ro.transactionId,
      wxAmount: null,
      storeAmount: Number(ro.amount),
      note: `门店记了已退到（商户退款单号 ${ro.outRefundNo}），微信这一天的账单里没有${nearMidnight ? '；退到的时间在零点前后，请看前后一天的对账' : ''}`,
    });
  }
  return issues;
}

/** 门店系统里那一天（北京时间）付款的单子 */
async function paidOn(db: Db, billDate: string): Promise<OrderRow[]> {
  return db<OrderRow[]>`
    SELECT * FROM mp_recharge_orders
    WHERE transaction_id IS NOT NULL AND status IN ('paid', 'held', 'handled')
      AND (paid_at AT TIME ZONE ${WX_TZ})::date = ${billDate}::date
    ORDER BY id`;
}

/** 最近的对账：每个账单日取最后一次；给了 id 就只取那一条 */
export async function recentRecons(db: Db, days = 30, id?: number): Promise<MpRechargeRecon[]> {
  return db<MpRechargeRecon[]>`
    SELECT r.id, r.bill_date, r.ok, r.wx_count, r.wx_amount, r.store_count, r.store_amount, r.issues, r.refunds, r.source,
           s.display_name AS staff_name, r.created_at
    FROM mp_recharge_recons r LEFT JOIN staff s ON s.id = r.staff_id
    WHERE ${id === undefined ? db`r.id IN (SELECT max(id) FROM mp_recharge_recons GROUP BY bill_date)` : db`r.id = ${id}`}
    ORDER BY r.bill_date DESC
    LIMIT ${days}`;
}

/**
 * 每分钟的定时任务里调用：北京时间 10 点半以后、前一天还没有自动对过账，就对一次。
 * 下账单失败（账单还在生成、连不上微信）时 30 分钟后再试，不每分钟打扰微信。
 */
let lastFailure = 0;
export async function maybeReconcileYesterday(deps: Deps, pay: PayRuntime | null, now = new Date()): Promise<MpRechargeRecon | null> {
  if (!pay) return null;
  const b = beijing(now);
  if (b.getUTCHours() * 60 + b.getUTCMinutes() < READY_MINUTES) return null;
  if (now.getTime() - lastFailure < 30 * 60_000) return null;
  const day = yesterdayOf(now);
  const [done] = await deps.sql`SELECT 1 FROM mp_recharge_recons WHERE bill_date = ${day} AND source = 'auto'`;
  if (done) return null;
  try {
    return await reconcileDay(deps, pay, day, { source: 'auto' });
  } catch (error) {
    lastFailure = now.getTime();
    if (error instanceof WxPayError) throw new Error(`下载 ${day} 的微信支付账单没成功（${error.code}：${error.message}），30 分钟后再试`);
    throw error;
  }
}

/** 测试用：清掉「30 分钟后再试」的记号 */
export function resetReconBackoff() {
  lastFailure = 0;
}
