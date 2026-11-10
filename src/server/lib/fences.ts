// 「确认作废」登记（op_fences）：操作编号 + 声明的业务类型 + 经办人。
//
// 串行：登记作废与「原请求写入操作编号」都先按编号取事务级咨询锁，二者不会交错。
//   · 作废先登记：原请求写编号前发现同一类型的作废登记 → 整笔回滚（OP_ABANDONED）；
//   · 原请求先写编号：作废等它提交后看到编号已有结果 → 只返回查回结果，不作废。
// 只认「声明类型 = 原请求真实类型」的登记：伪报类型或从别的模块作废，都拦不下原请求；
// 作废接口按声明的类型检查权限，所以能让作废生效的人，必须具备这项业务本身的权限。

import type { Db, Tx } from '../db';

export const FENCED_OPS = [
  'recharge',
  'consume',
  'reversal',
  'checkin',
  'bill_post',
  'tag_swap',
  'checkout',
  'table_open',
  'table_post',
  'table_checkout',
  // S7 客房（v0.7.4）
  'room_checkin',
  'room_extend',
  'room_deposit',
  'room_refund',
  'room_close',
  // 收银完善（v0.7.6）：转单
  'line_move',
  // ERP（v0.7.8）：费用报销、备用金打款与退回补付、部门需求单
  'expense_claim',
  'petty_advance',
  'petty_settlement',
  'purchase_request',
  // 供应商结算（v0.7.12）：核销、供应商退款、批量导入
  'ap_offset',
  'supplier_refund',
  'erp_import',
  // 对账登记（v0.7.13）与撤销（v0.7.14）
  'supplier_recon',
  'supplier_recon_void',
  // 空间台账导入（v0.7.14）
  'space_import',
  // 模拟刷卡（v0.7.17）：编号记在位置事件上（location_events.op_key），不进 idempotency_keys
  'location_report',
  // 派对房等的使用单（v0.7.19）：开单、结束、撤单
  'usage_open',
  'usage_end',
  'usage_cancel',
  // 退款单（v0.7.20，离店后部分退款）
  'checkout_refund',
  // 券与会员权益（v0.7.20）：编号记在各自的表上（client_key），不进 idempotency_keys
  'coupon_template',
  'coupon_rule',
  'coupon_batch',
  'coupon_issue',
  // 批量发券（8.0.4，迁移 094）：编号记在发券单上（coupon_campaigns.client_key）
  'coupon_campaign',
  // 硬件连接（v0.7.21）：编号记在设备、打印任务上（client_key）
  'device_create',
  'device_job',
  // 供应商付款、期初未付登记（v0.7.22，迁移 039）
  'payment',
  'opening_payable',
  // 手动调整会员档阶（v0.7.23，迁移 040）：编号记在状态变化记录上（member_grade_events.client_key）
  'grade_adjust',
  // 登记会员权益使用（v0.7.24，迁移 041）：编号记在使用登记上（benefit_uses.client_key）
  'benefit_use',
  // 邀请体验、赠送会籍（v0.7.25，迁移 042）：编号记在临时身份上（member_trials.client_key）
  'member_trial',
  // 会员体系收尾（v0.7.26，迁移 047）：退储值、停用 / 启用、合并会员；编号记在各自的单子上（client_key）
  'member_refund',
  'member_status',
  'member_merge',
  // 预约（v0.7.28，迁移 053）：新建、改动（确认、改时间、到店、取消、爽约）
  'booking_create',
  'booking_change',
  // 次卡（v0.7.28，迁移 054）：售卡、退卡；编号记在卡、退卡单上（client_key）
  'count_card_sale',
  'count_card_refund',
  // 平台核销补录（v0.7.28，迁移 055）：补登记、打款登记；编号记在各自的行上（client_key）
  'platform_redemption',
  'platform_settlement',
  // 业务单据打到小票机（v0.7.28，迁移 056）：编号记在打印任务上（device_jobs.client_key）
  'doc_print',
  // 会员实体卡（v0.7.28，迁移 057）：发卡、补卡；编号记在卡上（member_cards.client_key）
  'member_card',
  // 审批中心（v0.7.30，迁移 073）：新建审批规则、设代理人；编号记在各自的行上（client_key）
  'approval_rule',
  'approval_delegation',
  // 合同与法务审查（v0.7.31，迁移 077）：新建合同、变更单、用印申请；编号记在各自的行上（client_key）
  'contract_create',
  'contract_change',
  'contract_seal',
  // 付款流（v0.7.32，迁移 080、081）：付款申请、合同付款、验收登记、质量问题登记、登记发票；编号记在各自的行上（client_key）
  'payment_request',
  'contract_payout',
  'contract_acceptance',
  'contract_quality',
  'supplier_invoice',
  // 员工食堂第二期（迁移 092）：柚子信箱的回信；编号记在 idempotency_keys（ref_id 是那一条）
  'canteen_reply',
  // 8.0.1 采购组整改（迁移 093）：集采导入、赠品登记；编号记在 idempotency_keys（ref_id 是那次导入、那条赠品登记）
  'request_import',
  'gift_receipt',
] as const;
export type FencedOp = (typeof FENCED_OPS)[number];

const lockKey = (tx: Tx, key: string) => tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

/**
 * 同一操作编号的提交排队（v0.7.9 修正）：在查「这个编号是否已有结果」之前先取这把锁，
 * 同一编号的两次提交（重提、连点）就不会都以为是第一次，后一次等前一次提交后直接返回原结果，
 * 而不是在业务检查里报「已被占用」之类的错。与登记作废用的是同一把锁。
 */
export const lockOpKey = lockKey;

/** 是否已有给定类型之一的作废登记（只读，不加锁） */
export async function isFenced(db: Db, key: string, opTypes: readonly FencedOp[]): Promise<boolean> {
  const [row] = await db<{ hit: number }[]>`SELECT 1 AS hit FROM op_fences WHERE key = ${key} AND op_type IN ${db(opTypes)}`;
  return !!row;
}

/** 原请求写入操作编号之前调用：与登记作废串行，并确认这笔没有被作废（同一类型） */
export async function assertNotFenced(tx: Tx, key: string, opType: FencedOp, abandoned: () => Error) {
  await lockKey(tx, key);
  if (await isFenced(tx, key, [opType])) throw abandoned();
}

/**
 * 登记作废（在调用方的事务里，与原请求写编号串行）。
 * 编号已有结果时返回 { existingOpType }，由调用方查回；否则登记（重复登记不报错）。
 */
export async function fenceKey(
  tx: Tx,
  key: string,
  opType: FencedOp,
  staffId: number,
): Promise<{ existingOpType: string } | { inserted: boolean }> {
  await lockKey(tx, key);
  const [existing] = await tx<{ opType: string }[]>`SELECT op_type FROM idempotency_keys WHERE key = ${key}`;
  if (existing) return { existingOpType: existing.opType };
  if (opType === 'location_report') {
    const [event] = await tx<{ id: number }[]>`SELECT id FROM location_events WHERE op_key = ${key}`;
    if (event) return { existingOpType: opType };
  }
  if (isCouponOp(opType) && (await couponOpRef(tx, key, opType)) !== null) return { existingOpType: opType };
  if (isDeviceOp(opType) && (await deviceOpRef(tx, key, opType)) !== null) return { existingOpType: opType };
  if (opType === 'grade_adjust' && (await gradeOpRef(tx, key)) !== null) return { existingOpType: opType };
  if (opType === 'benefit_use' && (await benefitUseOpRef(tx, key)) !== null) return { existingOpType: opType };
  if (opType === 'member_trial' && (await trialOpRef(tx, key)) !== null) return { existingOpType: opType };
  if (isMemberOp(opType) && (await memberOpRef(tx, key, opType)) !== null) return { existingOpType: opType };
  if (isCountCardOp(opType) && (await countCardOpRef(tx, key, opType)) !== null) return { existingOpType: opType };
  if (isPlatformOp(opType) && (await platformOpRef(tx, key, opType)) !== null) return { existingOpType: opType };
  if (isApprovalOp(opType) && (await approvalOpRef(tx, key, opType)) !== null) return { existingOpType: opType };
  if (isContractOp(opType) && (await contractOpRef(tx, key, opType)) !== null) return { existingOpType: opType };
  if (isPaymentFlowOp(opType) && (await paymentFlowOpRef(tx, key, opType)) !== null) return { existingOpType: opType };
  const rows = await tx`
    INSERT INTO op_fences (key, op_type, staff_id) VALUES (${key}, ${opType}, ${staffId})
    ON CONFLICT (key, op_type) DO NOTHING RETURNING key`;
  return { inserted: rows.length > 0 };
}

const COUPON_OPS = ['coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue', 'coupon_campaign'] as const;
type CouponOp = (typeof COUPON_OPS)[number];
export const isCouponOp = (op: string): op is CouponOp => (COUPON_OPS as readonly string[]).includes(op);

/** 券与会员权益（v0.7.20）的操作编号记在各自的表上：查到时返回那条记录的编号（模板、规则、发券记录） */
export async function couponOpRef(db: Db, key: string, opType: CouponOp): Promise<number | null> {
  const rows =
    opType === 'coupon_template'
      ? await db<{ id: number }[]>`SELECT id FROM coupon_templates WHERE client_key = ${key}`
      : opType === 'coupon_rule'
        ? await db<{ id: number }[]>`SELECT id FROM coupon_rules WHERE client_key = ${key}`
        : opType === 'coupon_campaign'
          ? await db<{ id: number }[]>`SELECT id FROM coupon_campaigns WHERE client_key = ${key}`
          : await db<{ id: number }[]>`SELECT id FROM coupon_issues WHERE client_key = ${key} AND kind = ${opType === 'coupon_batch' ? 'batch' : 'manual'}`;
  return rows[0] ? Number(rows[0].id) : null;
}

const APPROVAL_OPS = ['approval_rule', 'approval_delegation'] as const;
type ApprovalOp = (typeof APPROVAL_OPS)[number];
export const isApprovalOp = (op: string): op is ApprovalOp => (APPROVAL_OPS as readonly string[]).includes(op);

/** 审批中心（v0.7.30）的操作编号记在审批规则、代理设置上：查到时返回那一条的编号 */
export async function approvalOpRef(db: Db, key: string, opType: ApprovalOp): Promise<number | null> {
  const rows =
    opType === 'approval_rule'
      ? await db<{ id: number }[]>`SELECT id FROM approval_rules WHERE client_key = ${key}`
      : await db<{ id: number }[]>`SELECT id FROM approval_delegations WHERE client_key = ${key}`;
  return rows[0] ? Number(rows[0].id) : null;
}

const CONTRACT_OPS = ['contract_create', 'contract_change', 'contract_seal'] as const;
type ContractOp = (typeof CONTRACT_OPS)[number];
export const isContractOp = (op: string): op is ContractOp => (CONTRACT_OPS as readonly string[]).includes(op);

/** 合同（v0.7.31）的操作编号记在合同、变更单、用印登记上：查到时返回那一条的编号 */
export async function contractOpRef(db: Db, key: string, opType: ContractOp): Promise<number | null> {
  const rows =
    opType === 'contract_create'
      ? await db<{ id: number }[]>`SELECT id FROM contracts WHERE client_key = ${key}`
      : opType === 'contract_change'
        ? await db<{ id: number }[]>`SELECT id FROM contract_changes WHERE client_key = ${key}`
        : await db<{ id: number }[]>`SELECT id FROM contract_seals WHERE client_key = ${key}`;
  return rows[0] ? Number(rows[0].id) : null;
}

const PAYMENT_FLOW_OPS = ['payment_request', 'contract_payout', 'contract_acceptance', 'contract_quality', 'supplier_invoice'] as const;
type PaymentFlowOp = (typeof PAYMENT_FLOW_OPS)[number];
export const isPaymentFlowOp = (op: string): op is PaymentFlowOp => (PAYMENT_FLOW_OPS as readonly string[]).includes(op);

/** 付款流（v0.7.32）的操作编号记在付款申请、合同付款、验收登记、质量问题、发票上：查到时返回那一条的编号 */
export async function paymentFlowOpRef(db: Db, key: string, opType: PaymentFlowOp): Promise<number | null> {
  const rows =
    opType === 'payment_request'
      ? await db<{ id: number }[]>`SELECT id FROM payment_requests WHERE client_key = ${key}`
      : opType === 'contract_payout'
        ? await db<{ id: number }[]>`SELECT id FROM contract_payouts WHERE client_key = ${key}`
        : opType === 'contract_acceptance'
          ? await db<{ id: number }[]>`SELECT id FROM contract_acceptances WHERE client_key = ${key}`
          : opType === 'contract_quality'
            ? await db<{ id: number }[]>`SELECT id FROM contract_quality_issues WHERE client_key = ${key}`
            : await db<{ id: number }[]>`SELECT id FROM supplier_invoices WHERE client_key = ${key}`;
  return rows[0] ? Number(rows[0].id) : null;
}

const DEVICE_OPS = ['device_create', 'device_job', 'doc_print'] as const;
type DeviceOp = (typeof DEVICE_OPS)[number];
export const isDeviceOp = (op: string): op is DeviceOp => (DEVICE_OPS as readonly string[]).includes(op);

/** 硬件连接（v0.7.21）的操作编号记在设备、打印任务上（v0.7.28 起打印单据也是打印任务）：查到时返回那一台设备、那个任务的编号 */
export async function deviceOpRef(db: Db, key: string, opType: DeviceOp): Promise<number | null> {
  const rows =
    opType === 'device_create'
      ? await db<{ id: number }[]>`SELECT id FROM devices WHERE client_key = ${key}`
      : await db<{ id: number }[]>`SELECT id FROM device_jobs WHERE client_key = ${key}`;
  return rows[0] ? Number(rows[0].id) : null;
}

/** 手动调整会员档阶（v0.7.23）的操作编号记在状态变化记录上：查到时返回那位会员的编号 */
export async function gradeOpRef(db: Db, key: string): Promise<number | null> {
  const [row] = await db<{ memberId: number }[]>`SELECT member_id FROM member_grade_events WHERE client_key = ${key}`;
  return row ? Number(row.memberId) : null;
}

/** 登记会员权益使用（v0.7.24）的操作编号记在使用登记上：查到时返回那条登记的编号 */
export async function benefitUseOpRef(db: Db, key: string): Promise<number | null> {
  const [row] = await db<{ id: number }[]>`SELECT id FROM benefit_uses WHERE client_key = ${key}`;
  return row ? Number(row.id) : null;
}

/** 邀请体验、赠送会籍（v0.7.25）的操作编号记在临时身份上：查到时返回那条临时身份的编号 */
export async function trialOpRef(db: Db, key: string): Promise<number | null> {
  const [row] = await db<{ id: number }[]>`SELECT id FROM member_trials WHERE client_key = ${key}`;
  return row ? Number(row.id) : null;
}

const MEMBER_OPS = ['member_refund', 'member_status', 'member_merge'] as const;
type MemberOp = (typeof MEMBER_OPS)[number];
export const isMemberOp = (op: string): op is MemberOp => (MEMBER_OPS as readonly string[]).includes(op);

/**
 * 会员体系收尾（v0.7.26）的操作编号记在各自的单子上：退储值单、停用 / 启用记录、合并单。
 * 查到时返回那张单子的编号（停用 / 启用返回那位会员，页面据此刷新会员详情）
 */
export async function memberOpRef(db: Db, key: string, op: MemberOp): Promise<number | null> {
  if (op === 'member_refund') {
    const [row] = await db<{ id: number }[]>`SELECT id FROM member_refunds WHERE client_key = ${key}`;
    return row ? Number(row.id) : null;
  }
  if (op === 'member_status') {
    const [row] = await db<{ memberId: number }[]>`SELECT member_id FROM member_status_events WHERE client_key = ${key}`;
    return row ? Number(row.memberId) : null;
  }
  const [row] = await db<{ id: number }[]>`SELECT id FROM member_merges WHERE client_key = ${key}`;
  return row ? Number(row.id) : null;
}

const COUNT_CARD_OPS = ['count_card_sale', 'count_card_refund'] as const;
type CountCardOp = (typeof COUNT_CARD_OPS)[number];
export const isCountCardOp = (op: string): op is CountCardOp => (COUNT_CARD_OPS as readonly string[]).includes(op);

/** 次卡（v0.7.28）的操作编号记在卡（售卡）、退卡单上：查到时返回那张卡的编号 */
export async function countCardOpRef(db: Db, key: string, op: CountCardOp): Promise<number | null> {
  const [row] =
    op === 'count_card_sale'
      ? await db<{ id: number }[]>`SELECT id FROM count_cards WHERE client_key = ${key}`
      : await db<{ id: number }[]>`SELECT card_id AS id FROM count_card_refunds WHERE client_key = ${key}`;
  return row ? Number(row.id) : null;
}

const PLATFORM_OPS = ['platform_redemption', 'platform_settlement'] as const;
type PlatformOp = (typeof PLATFORM_OPS)[number];
export const isPlatformOp = (op: string): op is PlatformOp => (PLATFORM_OPS as readonly string[]).includes(op);

/** 平台核销补录（v0.7.28）的操作编号记在补登记、打款登记上：查到时返回那一行的编号 */
export async function platformOpRef(db: Db, key: string, op: PlatformOp): Promise<number | null> {
  const [row] =
    op === 'platform_redemption'
      ? await db<{ id: number }[]>`SELECT id FROM platform_redemptions WHERE client_key = ${key}`
      : await db<{ id: number }[]>`SELECT id FROM platform_settlements WHERE client_key = ${key}`;
  return row ? Number(row.id) : null;
}

/** 会员实体卡（v0.7.28）的发卡、补卡编号记在卡上：查到时返回那张卡的编号 */
export async function memberCardOpRef(db: Db, key: string): Promise<number | null> {
  const [row] = await db<{ id: number }[]>`SELECT id FROM member_cards WHERE client_key = ${key}`;
  return row ? Number(row.id) : null;
}
