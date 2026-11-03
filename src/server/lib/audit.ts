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
  | 'export'
  | 'inventory_master_saved'
  | 'inventory_doc'
  | 'purchase_order'
  | 'payable_doc'
  | 'erp_import'
  | 'expense_doc'
  | 'petty_doc'
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
  | 'device_job_created';

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
