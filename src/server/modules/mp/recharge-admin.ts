// 后台「微信小程序」→「线上充值」（小程序线第二期 2a，docs/MP_RECHARGE.md；权限 mp.recharge，待确认：店主、店总）：
//   · 设置：开关（默认关）、线上可充的套餐、自定义金额的开关（默认开）、线上单笔上限与每人每天笔数；照规则类设置走 saveRuleSetting，带版本号；
//   · 线上充值单：已付款待处理的（全部）与最近的；验过签、但门店系统里找不到单子的到账通知；
//   · 处理已付款待处理的：重新入账（照原来的套餐）、按金额入账（不发套餐券）、已另行处理（商户平台退款、前台另记），都要写原因；
//     入账照到账时一样：会员一行 → 单子一行 → 主线 rechargeOnline（按同一个微信交易单号去重）；同一个操作编号重提返回原来那次。

import { z } from 'zod';
import { formatYuan } from '@shared/money';
import { MP_RECHARGE_RULES_KEY, type MpRechargeAdminData, type MpRechargeFlag, type MpRechargeOrderAdmin, type MpRechargeRules } from '@shared/mp';
import { isUniqueViolation, type Db } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { loadSettings } from '../settings';
import { rechargeOnline } from '../wallet-online';
import { activePay, payProblem } from './pay';
import { labelNow, loadRechargeRules, lockOrder, orderById, recordEvent } from './recharge';

const adminOrders = (db: Db, where: 'held' | 'recent' | number) => db<MpRechargeOrderAdmin[]>`
  SELECT o.id, o.order_no, o.status, o.member_id, m.member_no, m.name AS member_name, o.credited_member_id, o.plan_id, o.plan_name,
         o.amount, o.est_bonus, o.est_label, o.recharge_id, r.doc_no AS recharge_doc_no, r.bonus_amount AS booked_bonus, o.booked_label,
         o.transaction_id, o.paid_at, o.booked_at, o.flags, o.closed_at, o.close_reason, o.hold_code, o.hold_message, o.held_at,
         o.resolution, o.resolution_note, s.display_name AS resolved_by_name, o.resolved_at, o.mock, o.created_at, o.expires_at
  FROM mp_recharge_orders o
  JOIN members m ON m.id = o.member_id
  LEFT JOIN recharges r ON r.id = o.recharge_id
  LEFT JOIN staff s ON s.id = o.resolved_by
  WHERE ${typeof where === 'number' ? db`o.id = ${where}` : where === 'held' ? db`o.status = 'held'` : db`true`}
  ORDER BY o.id DESC
  LIMIT ${where === 'recent' ? 50 : 500}`;

export async function rechargeAdminData(db: Db): Promise<MpRechargeAdminData> {
  const [rules, settings, plans, held, recent, orphans] = await Promise.all([
    loadRechargeRules(db),
    loadSettings(db),
    db<{ id: number; name: string; payAmount: number }[]>`SELECT id, name, pay_amount FROM recharge_plans WHERE active ORDER BY sort_order, pay_amount, id`,
    adminOrders(db, 'held'),
    adminOrders(db, 'recent'),
    db<MpRechargeAdminData['orphans']>`
      SELECT id, created_at, detail->>'outTradeNo' AS out_trade_no, detail->>'transactionId' AS transaction_id, (detail->>'amount')::bigint AS amount
      FROM mp_recharge_events WHERE order_id IS NULL AND code = 'UNKNOWN_ORDER' ORDER BY id DESC LIMIT 50`,
  ]);
  return {
    rules,
    payMode: activePay()?.mode ?? null,
    payProblem: payProblem(),
    plans,
    counterMaxCents: settings.maxRechargeCents,
    held,
    recent,
    orphans,
  };
}

const RulesInput = z.object({
  enabled: z.boolean('请选择是否开通线上充值'),
  planIds: z.array(z.number().int().positive()).max(30, '最多勾选 30 个套餐').default([]),
  customEnabled: z.boolean('请选择是否允许自定义金额'),
  maxCents: z.number('请填写线上单笔上限').int('线上单笔上限请填整元').min(100, '线上单笔上限至少 1 元'),
  dailyLimit: z.number('请填写每人每天最多几笔').int('每天笔数请填整数').min(1, '每天至少 1 笔').max(50, '每天最多 50 笔'),
  /** 后台看到的版本号（后台都带）；没带的不核对：自动化脚本收尾时不管现在是什么都关上 */
  version: z.number().int().min(0).optional(),
});

export async function saveRechargeRules(deps: Deps, raw: unknown, ctx: OpContext): Promise<MpRechargeRules> {
  const input = parse(RulesInput, raw);
  if (input.maxCents % 100 !== 0) throw badRequest('线上单笔上限请填整元');
  return saveRuleSetting(
    deps.sql,
    MP_RECHARGE_RULES_KEY,
    loadRechargeRules,
    async (before, tx) => {
      if (input.version !== undefined && input.version !== before.version) throw conflict('VERSION_CONFLICT', '线上充值的设置刚被别人改过，请刷新后再改');
      // 只核对这次改了的：之前勾过、后来停用的套餐，与前台单笔上限后来调低了的，原样保存不拦（可充的项只列启用的套餐，线上上限按两者里小的算）；
      // 「放弃这次修改」按现在的内容原样保存一次，不会因为这些被拒
      const settings = await loadSettings(tx);
      if (input.maxCents !== before.maxCents && input.maxCents > settings.maxRechargeCents) {
        throw unprocessable('OVER_COUNTER_LIMIT', `线上单笔上限不能超过前台的单笔上限 ${formatYuan(settings.maxRechargeCents)}`);
      }
      const ids = [...new Set(input.planIds)];
      const added = ids.filter((id) => !before.planIds.includes(id));
      const found = added.length ? await tx<{ id: number }[]>`SELECT id FROM recharge_plans WHERE active AND id = ANY(${added}::bigint[])` : [];
      if (found.length !== added.length) throw unprocessable('PLAN_UNAVAILABLE', '勾选的套餐里有停用或不存在的，请刷新后再选');
      // 内容没变也加一：后台「放弃这次修改」靠它让原来那次请求的版本号对不上
      return {
        enabled: input.enabled,
        planIds: ids,
        customEnabled: input.customEnabled,
        maxCents: input.maxCents,
        dailyLimit: input.dailyLimit,
        version: before.version + 1,
      };
    },
    ctx,
  );
}

const ResolveInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  action: z.enum(['rebook', 'rebook_amount', 'handled'], '请选择怎么处理'),
  note: z.string('请写怎么处理的').trim().min(1, '请写怎么处理的').max(200, '最多 200 字'),
});

/** 到账与单子对不上、付了又退了、同一个交易单号入过别的账：不能直接入账，只能记「已另行处理」 */
const NO_REBOOK = new Set(['MISMATCH', 'WX_REFUND', 'ONLINE_REF_CONFLICT']);

export async function resolveHeldOrder(deps: Deps, orderId: number, raw: unknown, ctx: OpContext): Promise<MpRechargeOrderAdmin> {
  const input = parse(ResolveInput, raw);
  const o0 = await orderById(deps.sql, orderId);
  if (!o0) throw notFound('线上充值单不存在');
  if (o0.resolveClientKey !== input.clientKey) {
    if (input.action !== 'handled' && o0.holdCode && NO_REBOOK.has(o0.holdCode)) {
      throw unprocessable('REBOOK_REFUSED', '这张单的到账与单子对不上（或已退款、已入过别的账），不能直接入账；请核对后记「已另行处理」');
    }
    await resolveTx(deps, orderId, o0.memberId, input, ctx).catch((error: unknown) => {
      if (isUniqueViolation(error, 'mp_recharge_orders_resolve_client_key_key')) throw conflict('CLIENT_KEY_REUSED', '这次处理的编号已经用过，请刷新后再处理');
      throw error;
    });
  }
  const [row] = await adminOrders(deps.sql, orderId);
  return row!;
}

function resolveTx(deps: Deps, orderId: number, memberId: number, input: z.infer<typeof ResolveInput>, ctx: OpContext) {
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 入账与到账时同一个顺序：会员一行 → 单子一行 → rechargeOnline
    if (input.action !== 'handled') await tx`SELECT id FROM members WHERE id = ${memberId} FOR UPDATE`;
    const o = await lockOrder(tx, orderId);
    if (o.resolveClientKey === input.clientKey) return;
    if (o.status !== 'held') throw conflict('NOT_HELD', '这张单已经不是「已付款待处理」了，请刷新');
    if (input.action === 'handled') {
      await tx`
          UPDATE mp_recharge_orders
          SET status = 'handled', resolution = 'handled', resolution_note = ${input.note}, resolved_by = ${ctx.actor.id}, resolved_at = now(),
              resolve_client_key = ${input.clientKey}, updated_at = now()
          WHERE id = ${orderId}`;
    } else {
      const r = await rechargeOnline(tx, deps, {
        memberId: o.memberId,
        paidAmount: o.amount,
        planId: input.action === 'rebook' ? o.planId : null,
        paymentRef: o.transactionId!,
        orderNo: o.orderNo,
      });
      const flags: MpRechargeFlag[] = [...(r.frozen ? (['frozen'] as const) : []), ...(r.mergedFrom !== null ? (['merged'] as const) : [])];
      await tx`
          UPDATE mp_recharge_orders
          SET status = 'paid', recharge_id = ${r.recharge.id}, credited_member_id = ${r.memberId}, booked_at = now(),
              booked_label = ${await labelNow(tx, deps, r.memberId)}, flags = ${flags}::text[],
              resolution = ${input.action}, resolution_note = ${input.note}, resolved_by = ${ctx.actor.id}, resolved_at = now(),
              resolve_client_key = ${input.clientKey}, updated_at = now()
          WHERE id = ${orderId}`;
      await recordEvent(
        tx,
        orderId,
        'booked',
        true,
        null,
        {
          source: 'resolve',
          action: input.action,
          rechargeId: r.recharge.id,
          docNo: r.recharge.docNo,
          bonus: r.recharge.bonusAmount,
          flags,
        },
        ctx.actor.id,
      );
    }
    await recordEvent(tx, orderId, 'resolved', true, null, { action: input.action, note: input.note, holdCode: o.holdCode }, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'mp_recharge_resolved',
      targetType: 'mp_recharge_order',
      targetId: orderId,
      detail: {
        orderNo: o.orderNo,
        memberId: o.memberId,
        amount: o.amount,
        action: input.action,
        note: input.note,
        holdCode: o.holdCode,
      },
      ip: ctx.ip,
    });
  });
}
