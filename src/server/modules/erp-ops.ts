// ERP 单据「结果待确认」的查回与确认作废（v0.7.8，修正 v0.7.7）：费用报销、备用金打款与退回补付、部门需求单；
// v0.7.12 起还有核销、供应商退款、批量导入；v0.7.13 起还有对账登记；v0.7.22 起还有供应商付款与期初未付登记；后台的空间台账导入（v0.7.14）、模拟刷卡（v0.7.17）也借用这一套。
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
import { approvalOpRef, benefitUseOpRef, countCardOpRef, memberCardOpRef, couponOpRef, platformOpRef, deviceOpRef, fenceKey, gradeOpRef, isCouponOp, isCountCardOp, isApprovalOp, isDeviceOp, isFenced, isMemberOp, isPlatformOp, memberOpRef, trialOpRef } from '../lib/fences';
import { parse } from '../lib/validate';
import { setTxTimeouts } from '../lib/tx';

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
  // 空间台账导入（v0.7.14）：店主、店总（与后台「客房」同一组权限）
  space_import: ['settings.manage', 'catalog.manage'],
  // 模拟刷卡（v0.7.17）：与上报接口一致
  location_report: ['location.report'],
  // 券与会员权益（v0.7.20）：与各自的提交接口一致
  coupon_template: ['coupon.manage'],
  coupon_rule: ['coupon.manage'],
  coupon_batch: ['coupon.manage'],
  coupon_issue: ['coupon.issue'],
  // 硬件连接（v0.7.21）
  device_create: ['device.manage'],
  device_job: ['device.test'],
  // 供应商付款、期初未付登记（v0.7.22）
  payment: ['payable.manage'],
  opening_payable: ['payable.manage'],
  // 手动调整会员档阶（v0.7.23）：只有店主
  grade_adjust: ['member.adjust'],
  // 登记会员权益使用（v0.7.24）
  benefit_use: ['benefit.use'],
  // 邀请体验、赠送会籍（v0.7.25）：与登记权益使用同一个权限（M56）
  member_trial: ['benefit.use'],
  // 会员体系收尾（v0.7.26）：退储值、停用 / 启用、合并会员
  member_refund: ['member.refund'],
  member_status: ['member.status'],
  member_merge: ['member.merge'],
  // 次卡（v0.7.28）
  count_card_sale: ['countcard.sell'],
  count_card_refund: ['countcard.refund'],
  // 平台核销补录（v0.7.28）
  platform_redemption: ['platform.redeem'],
  platform_settlement: ['platform.settle'],
  // 业务单据打到小票机（v0.7.28）
  doc_print: ['print.network'],
  // 会员实体卡（v0.7.28）
  member_card: ['member.card'],
  // 审批中心（v0.7.30）：新建审批规则要「维护审批规则」；设代理人与接口一致（能进审批中心的）
  approval_rule: ['approval.rules'],
  approval_delegation: ['approval.act', 'inventory.approve', 'expense.approve'],
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
  space_import: ['settings.manage', 'catalog.manage'],
  location_report: ['location.report'],
  coupon_template: ['coupon.manage'],
  coupon_rule: ['coupon.manage'],
  coupon_batch: ['coupon.manage'],
  coupon_issue: ['coupon.issue'],
  device_create: ['device.manage'],
  device_job: ['device.test'],
  payment: ['payable.read'],
  opening_payable: ['payable.read'],
  grade_adjust: ['member.adjust'],
  benefit_use: ['benefit.use'],
  member_trial: ['benefit.use'],
  member_refund: ['member.refund'],
  member_status: ['member.status'],
  member_merge: ['member.merge'],
  count_card_sale: ['countcard.sell', 'member.read'],
  count_card_refund: ['countcard.refund'],
  platform_redemption: ['platform.redeem', 'platform.settle'],
  platform_settlement: ['platform.settle'],
  doc_print: ['print.network'],
  member_card: ['member.card', 'member.read'],
  approval_rule: ['approval.rules'],
  approval_delegation: ['approval.act', 'inventory.approve', 'expense.approve'],
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
  // 模拟刷卡（v0.7.17）的编号记在位置事件上：refId 是那条位置事件
  if (type === 'location_report') {
    const [event] = await db<{ id: number }[]>`SELECT id FROM location_events WHERE op_key = ${key}`;
    if (event) return { found: true, abandoned: false, refId: Number(event.id) };
  }
  // 券与会员权益（v0.7.20）的编号记在模板、规则、发券记录上：refId 是那条记录
  if (isCouponOp(type)) {
    const refId = await couponOpRef(db, key, type);
    if (refId !== null) return { found: true, abandoned: false, refId };
  }
  // 硬件连接（v0.7.21）的编号记在设备、打印任务上
  if (isDeviceOp(type)) {
    const refId = await deviceOpRef(db, key, type);
    if (refId !== null) return { found: true, abandoned: false, refId };
  }
  // 手动调整会员档阶（v0.7.23）的编号记在状态变化记录上：refId 是那位会员
  if (type === 'grade_adjust') {
    const refId = await gradeOpRef(db, key);
    if (refId !== null) return { found: true, abandoned: false, refId };
  }
  // 登记会员权益使用（v0.7.24）的编号记在使用登记上：refId 是那条登记
  if (type === 'benefit_use') {
    const refId = await benefitUseOpRef(db, key);
    if (refId !== null) return { found: true, abandoned: false, refId };
  }
  // 邀请体验、赠送会籍（v0.7.25）的编号记在临时身份上：refId 是那条临时身份
  if (type === 'member_trial') {
    const refId = await trialOpRef(db, key);
    if (refId !== null) return { found: true, abandoned: false, refId };
  }
  // 会员体系收尾（v0.7.26）：退储值单、停用 / 启用记录（refId 是那位会员）、合并单
  if (isMemberOp(type)) {
    const refId = await memberOpRef(db, key, type);
    if (refId !== null) return { found: true, abandoned: false, refId };
  }
  // 次卡（v0.7.28）：售卡、退卡的编号记在卡、退卡单上：refId 是那张卡
  if (isCountCardOp(type)) {
    const refId = await countCardOpRef(db, key, type);
    if (refId !== null) return { found: true, abandoned: false, refId };
  }
  // 平台核销补录（v0.7.28）：refId 是那笔补登记、那笔打款登记
  if (isPlatformOp(type)) {
    const refId = await platformOpRef(db, key, type);
    if (refId !== null) return { found: true, abandoned: false, refId };
  }
  // 会员实体卡（v0.7.28）：refId 是那张卡
  if (type === 'member_card') {
    const refId = await memberCardOpRef(db, key);
    if (refId !== null) return { found: true, abandoned: false, refId };
  }
  // 审批中心（v0.7.30）：refId 是那条审批规则、那条代理设置
  if (isApprovalOp(type)) {
    const refId = await approvalOpRef(db, key, type);
    if (refId !== null) return { found: true, abandoned: false, refId };
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
      await setTxTimeouts(tx);
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
