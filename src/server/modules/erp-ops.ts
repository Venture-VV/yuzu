// ERP 单据「结果待确认」的查回与确认作废（v0.7.8，修正 v0.7.7）：费用报销、备用金打款与退回补付、部门需求单；
// v0.7.12 起还有核销、供应商退款、批量导入；v0.7.13 起还有对账登记。
//
// 页面提交前把操作编号和原请求存在本机（读回核对，存不了就不发请求）；断网或超时后：
//   · 查回：按编号只读查询。查不到不能断定没有登记（原请求可能还在路上或在等锁）；
//   · 按原内容重新提交：同一编号，服务端保证只登记一次；
//   · 确认作废：服务端登记「编号 + 原业务类型」的作废，原请求之后即使到达也整笔回滚，然后才允许重新填写。
// 作废按原业务类型的登记权限检查，只拦同类型的原请求（与会员记账、前台一致，见 lib/fences.ts）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ERP_OP_TYPES, type ErpOpLookup, type ErpOpType } from '@shared/erp';
import { can, type Permission } from '@shared/permissions';
import { type Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { conflict, forbidden } from '../lib/errors';
import { fenceKey, isFenced } from '../lib/fences';
import { parse } from '../lib/validate';

export const erpOpAbandoned = () => conflict('OP_ABANDONED', '这笔已确认作废，没有登记；如仍需办理，请重新填写后提交');

/** 登记（也就是作废）要的权限：与原来的提交接口一致 */
const WRITE: Record<ErpOpType, Permission[]> = {
  expense_claim: ['expense.manage'],
  petty_advance: ['petty.manage'],
  petty_settlement: ['petty.manage'],
  purchase_request: ['request.create'],
  ap_offset: ['payable.manage'],
  supplier_refund: ['payable.manage'],
  erp_import: ['inventory.master', 'payable.manage'],
  // 对账登记（v0.7.13）：月结由对账付款，按批次由采购经办或对账付款；接口里按种类再核对一次
  supplier_recon: ['payable.manage', 'purchase.manage'],
  supplier_recon_void: ['payable.manage', 'purchase.manage'],
};
/** 查回要的权限 */
const READ: Record<ErpOpType, Permission[]> = {
  expense_claim: ['expense.read'],
  petty_advance: ['expense.read'],
  petty_settlement: ['expense.read'],
  purchase_request: ['request.create', 'request.review'],
  ap_offset: ['payable.read'],
  supplier_refund: ['payable.read'],
  erp_import: ['inventory.master', 'payable.manage', 'inventory.approve'],
  supplier_recon: ['payable.read'],
  supplier_recon_void: ['payable.read'],
};

export async function lookupErpOp(db: Db, key: string, type: ErpOpType): Promise<ErpOpLookup> {
  const [row] = await db<{ opType: string; refId: number }[]>`SELECT op_type, ref_id FROM idempotency_keys WHERE key = ${key}`;
  if (row) {
    if (row.opType !== type) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号属于其他业务');
    const refId = Number(row.refId);
    if (type === 'petty_settlement') {
      const [s] = await db<{ advanceId: number }[]>`SELECT advance_id FROM petty_settlements WHERE id = ${refId}`;
      return { found: true, abandoned: false, refId, advanceId: s ? Number(s.advanceId) : undefined };
    }
    return { found: true, abandoned: false, refId };
  }
  return { found: false, abandoned: await isFenced(db, key, [type]) };
}

const KeyParam = z.object({ key: z.uuid('操作编号格式不正确') });
const TypeQuery = z.object({ type: z.enum(ERP_OP_TYPES, '缺少原操作的业务类型') });
const AbandonInput = TypeQuery.extend({ summary: z.string().trim().max(200).default('') });

export function registerErpOpsRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const allowed = (actor: Parameters<typeof can>[0], perms: Permission[]) => perms.some((p) => can(actor, p));

  app.get('/api/erp/ops/:key', { preHandler: guard() }, async (req) => {
    const { key } = parse(KeyParam, req.params);
    const { type } = parse(TypeQuery, req.query ?? {});
    if (!allowed(req.actor, READ[type])) throw forbidden();
    return lookupErpOp(sql, key, type);
  });

  app.post('/api/erp/ops/:key/abandon', { preHandler: guard() }, async (req) => {
    const { key } = parse(KeyParam, req.params);
    const input = parse(AbandonInput, req.body ?? {});
    if (!allowed(req.actor, WRITE[input.type])) throw forbidden();
    const outcome = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '10s'");
      const result = await fenceKey(tx, key, input.type, req.actor.id);
      if ('inserted' in result && result.inserted) {
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'erp_op_abandoned',
          targetType: 'operation',
          targetId: key,
          detail: { idempotencyKey: key, type: input.type, summary: input.summary },
          ip: req.ip,
        });
      }
      return result;
    });
    if ('existingOpType' in outcome && outcome.existingOpType !== input.type) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号属于其他业务，不能在这里作废');
    return lookupErpOp(sql, key, input.type);
  });
}
