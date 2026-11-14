import type { Db } from '../db';

export type AuditAction =
  | 'customer_record'
  | 'concierge_record'
  | 'concierge_upload'
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
  | 'contract_doc'
  | 'payment_doc'
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
  | 'clock_assign'
  | 'clock_transfer'
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
  // 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）：平板下单、电子菜单的保存与生成初稿、点单密码
  | 'emenu_order'
  | 'emenu_saved'
  | 'emenu_draft'
  | 'order_pin_set'
  | 'order_pin_cleared'
  | 'order_pin_failed'
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
  // 8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）
  | 'member_tag_saved'
  | 'member_tags_exported'
  | 'member_records_exported'
  | 'coupon_campaign_created'
  | 'coupon_campaign_finished'
  | 'coupon_usage_exported'
  | 'sms_outbox_exported'
  | 'sms_sent'
  | 'gift_out_done'
  | 'gift_out_failed'
  | 'gift_out_retried'
  | 'marketing_cost_param_saved'
  | 'marketing_cost_exported'
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
  | 'mp_refund_handled'
  // 员工食堂 · 柚子饭堂（docs/CANTEEN.md）：员工名单的新建、修改、停用、重新开通、员工自己登记；跟柚子说的回信
  | 'canteen_employee'
  | 'canteen_feedback'
  // 8.0.1 采购组整改：签约供应商的合同 PDF（08）、收货附件（11）、集采导入（06）、赠品台账（09）
  | 'supplier_contract_file'
  | 'supplier_contract_file_removed'
  | 'receipt_attachment'
  | 'request_import'
  | 'gift_receipt'
  // 8.0.3 费用预算与进项发票台账：改预算额度；台账里的发票（登记、认证状态、照片、作废）
  | 'expense_budget'
  | 'input_invoice'
  // 8.0.7 供应链收尾与 ERP P2（docs/ERP_V807.md）：证照与准入、验收标准模板、对账确认链接与供应商的回复、
  // 协议单位与回款、资产卡片与扫码盘点、企业微信推送
  | 'supplier_license'
  | 'supplier_admission'
  | 'acceptance_template'
  | 'recon_link'
  | 'recon_reply'
  | 'ar_unit'
  | 'ar_collection'
  | 'asset_card'
  | 'asset_stocktake'
  | 'wecom_push'
  // 8.0.9 安保巡场（docs/PATROL_V809.md）：场所的新建、修改、换码、停用 / 启用；作废打卡记录
  | 'patrol_point'
  | 'patrol_checkin_void';

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
