import type { Db } from '../db';

export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'auth_granted'
  | 'auth_failed'
  | 'logout'
  | 'password_changed'
  | 'staff_created'
  | 'staff_updated'
  | 'staff_password_reset'
  | 'member_created'
  | 'member_updated'
  | 'recharge_created'
  | 'consumption_created'
  | 'consumption_reversed'
  | 'consume_rejected'
  | 'duplicate_blocked'
  | 'operation_abandoned'
  | 'settlement_closed'
  | 'settings_updated'
  | 'plan_saved'
  | 'item_saved'
  | 'price_list_imported'
  | 'bonus_expired'
  | 'opening_imported'
  | 'opening_voided'
  | 'member_history_imported'
  | 'member_history_voided'
  | 'export'
  | 'inventory_master_saved'
  | 'inventory_doc'
  | 'purchase_order'
  | 'payable_doc'
  | 'erp_import'
  | 'expense_doc'
  | 'petty_doc'
  | 'petty_account'
  | 'sourcing_doc'
  | 'approval_rule'
  | 'approval_delegation'
  | 'approval_batch'
  | 'purchase_request'
  | 'erp_image'
  | 'erp_op_abandoned'
  | 'inventory_settings_updated'
  | 'frontdesk_checkin'
  | 'frontdesk_swap'
  | 'frontdesk_group'
  | 'frontdesk_cancel'
  | 'frontdesk_post'
  | 'frontdesk_void'
  | 'frontdesk_move'
  | 'frontdesk_abandon'
  | 'frontdesk_ticket'
  | 'frontdesk_checkout'
  | 'frontdesk_checkout_void'
  | 'ticket_type_saved'
  | 'shift_started'
  | 'shift_closed'
  | 'shift_joined'
  | 'shift_left'
  | 'hand_tags_created'
  | 'hand_tags_imported'
  | 'hand_tag_locked'
  | 'hand_tag_unlocked'
  | 'hand_tag_updated'
  | 'technician_saved'
  | 'items_technician_updated'
  // 餐饮（S5 第一步）：出品档口、菜品的出品档口、估清
  | 'kitchen_station_saved'
  | 'items_station_updated'
  | 'dish_limit_set'
  | 'dining_table_saved'
  | 'table_open'
  | 'table_update'
  | 'table_move'
  | 'table_cancel'
  | 'table_post'
  | 'table_void'
  // 客房（S7，v0.7.4）
  | 'room_type_saved'
  | 'room_saved'
  | 'room_checkin'
  | 'room_extend'
  | 'room_update'
  | 'room_move'
  | 'room_cancel'
  | 'room_deposit'
  | 'room_close'
  | 'room_housekeeping'
  | 'room_audit'
  // 8–10 月旧账只读对照（v0.7.10）
  | 'legacy_imported'
  | 'legacy_import_voided'
  // 空间台账（RQ-004 第一段，v0.7.14）：空间（含别名、核对、批量设区域）、楼层与区域、导入
  | 'space_saved'
  | 'space_zone_saved'
  | 'space_import'
  // 底图转换（RQ-004 第二段，v0.7.15）：上传图纸、启用一批底图
  | 'floorplan_upload'
  | 'floorplan_activate'
  // 第一级实时位置（RQ-004，v0.7.17）：刷卡点、项目所在区域
  | 'location_reader_saved'
  | 'items_zone_updated'
  // 平面图收尾（v0.7.19）：派对房等的使用单；换回旧底图、补画轮廓；对客导览的图标
  | 'usage_open'
  | 'usage_end'
  | 'usage_cancel'
  | 'booking_create'
  | 'booking_confirm'
  | 'booking_reschedule'
  | 'booking_cancel'
  | 'booking_no_show'
  | 'booking_arrive'
  // 次卡（v0.7.28 ④）
  | 'count_card_type_saved'
  | 'count_card_sale'
  | 'count_card_refund'
  | 'count_card_expire'
  | 'count_card_opening'
  // 平台核销补录（v0.7.28 ⑤）
  | 'platform_redemption'
  | 'platform_redemption_void'
  | 'platform_settlement'
  | 'platform_settlement_void'
  | 'floorplan_restore'
  | 'floorplan_outline'
  | 'guide_marker_saved'
  | 'guide_markers_detected'
  // 收银完善（RQ-006，v0.7.20）：退款单与作废；券模板、发券规则、发券、无记名券、作废券
  | 'checkout_refund'
  | 'checkout_refund_void'
  | 'coupon_template_saved'
  | 'coupon_rule_saved'
  | 'coupon_issued'
  | 'coupon_batch_created'
  | 'coupon_batch_exported'
  | 'coupon_voided'
  // 硬件连接（RQ-001，v0.7.21）：设备登记、启用停用、按采购清单导入、打印任务
  | 'device_created'
  | 'device_updated'
  | 'device_enabled'
  | 'devices_imported'
  | 'device_job_created'
  // 取消排队、等打印机恢复的打印任务（v0.7.28）
  | 'device_job_canceled'
  // 会员实体卡（v0.7.28）：发卡、补卡；挂失
  | 'member_card_issued'
  | 'member_card_lost'
  // 会员体系 v2（v0.7.23）：已有会员上线定档、手动调整档阶、他店查询
  | 'membership_live'
  | 'member_grade_adjusted'
  // 会员权益（v0.7.24）：导入清单、修改、发布 / 暂缓、自动发放、登记使用、作废登记
  | 'benefits_imported'
  | 'benefit_saved'
  | 'benefit_status'
  | 'benefit_granted'
  | 'benefit_used'
  | 'benefit_use_voided'
  | 'member_lookup'
  // 会员体系 v2 第三期（v0.7.25）：邀请体验、赠送会籍的发起与撤销
  | 'member_trial_created'
  | 'member_trial_cancelled'
  // 会员体系收尾（v0.7.26）：退储值、小程序线上充值入账、停用 / 启用、改手机号、合并
  | 'member_refund'
  | 'recharge_online'
  | 'member_status_changed'
  | 'member_phone_changed'
  | 'member_merged'
  // 微信小程序（小程序线）：解绑会员的微信、维护小程序内容、作废结果不确定的操作
  | 'mp_unbind'
  | 'mp_content_saved'
  | 'mp_op_abandoned'
  // 小程序线第二期：店主处理「已付款待处理」的线上充值单
  | 'mp_recharge_resolved'
  // 小程序线第二期 2d：原路退回没退成的，店主重试、已另行处理
  | 'mp_refund_retried'
  | 'mp_refund_handled';

export interface AuditEntry {
  staffId: number | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string | number;
  detail?: Record<string, unknown>;
  ip?: string;
  businessDate?: string;
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db`
    INSERT INTO audit_logs (staff_id, action, target_type, target_id, detail, ip, business_date)
    VALUES (${entry.staffId}, ${entry.action}, ${entry.targetType ?? null},
            ${entry.targetId == null ? null : String(entry.targetId)},
            ${db.json((entry.detail ?? {}) as never)}, ${entry.ip ?? null}, ${entry.businessDate ?? null})`;
}
