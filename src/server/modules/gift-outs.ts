// 买一赠一券的赠品出库（8.0.4 需求表 09「核销后赠品自动出库记账」，docs/MEMBERSHIP_V804.md 第 9.1 节，HY12）。
//   · 结账用了买一赠一券、模板上选了赠品物料的，结账事务里记一条「待出库」（coupon-checkout.ts，不碰库存，库存不够也不挡结账）；
//   · 这里每分钟把待出库的在选的仓开一张「直接耗用」单（库存模块自己的开单函数，经办人系统账号「赠品出库」，
//     操作编号用这一条自己的，重做也不会开出两张），库存流水照常记账；出不了库的（库存不够、物料停用……）记「出库失败」与原因，
//     补完库存后在「营销成本 → 赠品出库」点重试；
//   · 反结账：还没出库的取消；已出库的这里冲销那张耗用单（库存模块的冲销，只能冲当月的；跨月的记「冲销失败」，由仓库手工处理）。
// 锁：每一条在库存模块的事务里照库存单据原来的锁走（物料 id 升序……）；这里只在事务外读、事务后写这一条的结果。

import type { FastifyInstance } from 'fastify';
import { formatStoreCouponCode } from '@shared/coupons';
import type { GiftOutStatus } from '@shared/marketing-cost';
import { guardAny } from '../auth/guard';
import type { Db } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { conflict, notFound } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { createDoc, voidDoc } from './inventory/docs';
import { systemGiftActor } from './system-staff';


interface GiftOutRow {
  id: number;
  status: GiftOutStatus;
  clientKey: string;
  materialId: number;
  qtyMilli: number;
  warehouseId: number;
  businessDate: string;
  invDocId: number | null;
  couponCode: string;
  checkoutNo: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

async function giftOut(db: Db, id: number): Promise<GiftOutRow | null> {
  const [r] = await db<GiftOutRow[]>`
    SELECT g.id, g.status, g.client_key, g.material_id, g.qty_milli, g.warehouse_id, g.business_date::text AS business_date, g.inv_doc_id,
           c.code AS coupon_code, k.checkout_no
    FROM coupon_gift_outs g JOIN coupons c ON c.id = g.coupon_id JOIN checkouts k ON k.id = g.checkout_id WHERE g.id = ${id}`;
  return r ?? null;
}

/** 处理一条：待出库的开耗用单，待冲销的冲销 */
export async function handleGiftOut(deps: Pick<Deps, 'sql' | 'config'>, id: number): Promise<GiftOutStatus | null> {
  const { sql } = deps;
  const g = await giftOut(sql, id);
  if (!g || (g.status !== 'pending' && g.status !== 'void_pending')) return g?.status ?? null;
  const actor = await systemGiftActor(sql);
  if (g.status === 'pending') {
    try {
      const { doc } = await createDoc(
        deps as Deps,
        {
          clientKey: g.clientKey,
          action: 'submit',
          approveNow: false,
          docType: 'direct_use',
          docDate: g.businessDate,
          warehouseId: Number(g.warehouseId),
          note: `买一赠一券 ${formatStoreCouponCode(g.couponCode)} 的赠品（结账 ${g.checkoutNo}）`,
          lines: [{ materialId: Number(g.materialId), qtyMilli: Number(g.qtyMilli), note: '买一赠一赠品' }],
        },
        actor,
      );
      // 反结账在开单期间发生（这一条已改成待冲销）：照样记下单号，下一次冲销
      const [after] = await sql<{ status: GiftOutStatus }[]>`
        UPDATE coupon_gift_outs SET status = CASE WHEN status = 'pending' THEN 'done' ELSE status END, inv_doc_id = ${doc.id},
               attempts = attempts + 1, last_error = NULL, updated_at = now()
        WHERE id = ${id} AND status IN ('pending', 'void_pending', 'cancelled') RETURNING status`;
      // 开单期间反结账、改成了「已取消」：单已经开了，改成待冲销
      if (after?.status === 'cancelled') await sql`UPDATE coupon_gift_outs SET status = 'void_pending', updated_at = now() WHERE id = ${id}`;
      await writeAudit(sql, { staffId: actor.id, action: 'gift_out_done', targetType: 'coupon_gift_out', targetId: id, detail: { docNo: doc.docNo, checkoutNo: g.checkoutNo } });
      return after?.status === 'cancelled' ? 'void_pending' : (after?.status ?? 'done');
    } catch (error) {
      await sql`
        UPDATE coupon_gift_outs SET status = 'failed', attempts = attempts + 1, last_error = ${errText(error)}, updated_at = now()
        WHERE id = ${id} AND status = 'pending'`;
      await writeAudit(sql, { staffId: actor.id, action: 'gift_out_failed', targetType: 'coupon_gift_out', targetId: id, detail: { checkoutNo: g.checkoutNo, error: errText(error) } });
      return 'failed';
    }
  }
  // 待冲销
  try {
    await voidDoc(deps as Deps, Number(g.invDocId), { reason: `结账单 ${g.checkoutNo} 已反结账，买一赠一的赠品出库冲销` }, actor);
    await sql`UPDATE coupon_gift_outs SET status = 'voided', attempts = attempts + 1, last_error = NULL, updated_at = now() WHERE id = ${id} AND status = 'void_pending'`;
    return 'voided';
  } catch (error) {
    await sql`UPDATE coupon_gift_outs SET status = 'void_failed', attempts = attempts + 1, last_error = ${errText(error)}, updated_at = now() WHERE id = ${id} AND status = 'void_pending'`;
    return 'void_failed';
  }
}

/** 每分钟：待出库、待冲销的逐条处理（失败的等人点重试，不每分钟重试） */
export async function processGiftOuts(deps: Pick<Deps, 'sql' | 'config'>, opts: { limit?: number } = {}): Promise<{ done: number; failed: number; voided: number }> {
  const rows = await deps.sql<{ id: number }[]>`
    SELECT id FROM coupon_gift_outs WHERE status IN ('pending', 'void_pending') ORDER BY id LIMIT ${opts.limit ?? 30}`;
  const out = { done: 0, failed: 0, voided: 0 };
  for (const r of rows) {
    const s = await handleGiftOut(deps, Number(r.id));
    if (s === 'done') out.done += 1;
    else if (s === 'failed' || s === 'void_failed') out.failed += 1;
    else if (s === 'voided') out.voided += 1;
  }
  return out;
}

/** 重试：出库失败的改回待出库，冲销失败的改回待冲销，马上处理一次 */
export async function retryGiftOut(deps: Deps, id: number, ctx: OpContext): Promise<GiftOutStatus | null> {
  const [r] = await deps.sql<{ status: GiftOutStatus }[]>`
    UPDATE coupon_gift_outs SET status = CASE status WHEN 'failed' THEN 'pending' ELSE 'void_pending' END, updated_at = now()
    WHERE id = ${id} AND status IN ('failed', 'void_failed') RETURNING status`;
  if (!r) {
    if (!(await giftOut(deps.sql, id))) throw notFound('这条赠品出库不存在');
    throw conflict('GIFT_OUT_NOT_FAILED', '这条赠品出库现在不是失败状态，不用重试');
  }
  await writeAudit(deps.sql, { staffId: ctx.actor.id, action: 'gift_out_retried', targetType: 'coupon_gift_out', targetId: id, detail: { status: r.status }, ip: ctx.ip });
  return handleGiftOut(deps, id);
}

export function registerGiftOutRoutes(app: FastifyInstance, deps: Deps) {
  // 营销成本页（店主、店总）或仓库（总仓经办）都能点重试
  app.post('/api/gift-outs/:id/retry', { preHandler: guardAny('marketing.cost', 'inventory.operate') }, async (req) => {
    const status = await retryGiftOut(deps, parse(idParam, req.params).id, ctxOf(req));
    return { status };
  });
}

