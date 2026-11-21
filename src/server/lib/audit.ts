import type { Db } from '../db';
import { currentStoreId, DEFAULT_STORE_ID } from './store-context';

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
  | 'position_chosen'
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
  | 'store_saved'
  | 'entity_saved'
  | 'staff_stores_saved'
  | 'store_switched'
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
  // 餐饮（S5 第一步）：出品档口、菜品的出品档口、沽清
  | 'kitchen_station_saved'
  | 'items_station_updated'
  // 8.1.7：菜品的点单分类（餐厅 / 水吧 / 果吧）
  | 'items_slot_updated'
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
  | 'stock_transfer'
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
  | 'patrol_checkin_void'
  // 8.0.20 用料与扣料（docs/ERP_V8020.md）：改项目的用料
  | 'item_recipe'
  // 8.0.20 布草洗涤：品类的新建与修改、开单、作废
  | 'linen_item'
  | 'linen_doc'
  | 'linen_doc_void'
  // 8.0.21 自定义字段（docs/FINANCE_V8021.md 第 1 节）
  | 'custom_field_def'
  | 'custom_field_value'
  // 8.0.21 开票申请（docs/FINANCE_V8021.md 第 3 节）：申请、登记已开、交给服务商开、驳回、作废
  | 'invoice_request'
  // 8.0.21 银行账户与网银流水（docs/FINANCE_V8021.md 第 4 节）：账户、导入、勾对
  | 'bank_account'
  | 'bank_import'
  | 'bank_match'
  // 8.0.21 批量付款（同上第 5 节）：生成、导出、下载、作废、记已付 / 失败
  | 'payment_batch'
  // 8.0.21 合同模板（同上第 6 节）：新建、改版、停用、导出 Word
  | 'contract_template'
  // 8.0.21 供应商门户（同上第 7 节）：发链接、作废，供应商在链接里报价、确认、发货预告
  | 'supplier_link'
  | 'supplier_reply'
  // 8.0.21 扫码收款（docs/INTEGRATIONS_V8021.md 第 2 节）：开始收款、原路退回、重试、线下已退
  | 'pay_terminal'
  // 8.0.21 平台验券（同上第 3 节）：验券、撤销核销、转补录
  | 'platform_verify'
  // 8.0.21 OTA 渠道订单（同上第 4 节）：渠道的新建与修改、导入、订单建 / 改 / 取消预约
  | 'ota_channel'
  | 'ota_import'
  | 'ota_order'
  // 8.0.21 供应商收款账户（Codex 安全审查后补，迁移 151）：应付岗改账户、另一人复核
  | 'supplier_bank'
  // 8.1.1 UI 工作台：发布、回滚（谁、什么时候、改了哪几屏，GZ3）；8.1.2 撤销定时发布、导入设计包
  | 'studio_publish'
  | 'studio_rollback'
  | 'studio_cancel'
  | 'studio_pack_import'
  // 8.1.9 零采备用金：申用、提交 / 撤回报销、更新补单、作废（detail.action 写是哪一样）
  | 'pool_use'
  // 8.1.9 库管入库台账导入
  | 'receipt_import'
  // 8.1.20 出入库台账导入
  | 'ledger_import'
  // 8.1.9 签赠：新建、修改签赠券类型（知识库），签赠发放；作废签赠券记 coupon_voided（与券一样）
  | 'gift_type'
  | 'gift_issue'
  // 8.1.10 急采后补合同；核库转领用（库管核库、部门答复替代，detail 写领用、替代、转采购）
  | 'po_contract_added'
  | 'request_stock'
  // 8.1.15 前台（块 A，docs/FRONTDESK_RISK_V8115.md）：手牌绑 / 解绑芯片号、黑名单的登记与解除、发牌被黑名单拦下、
  // 发牌后的异常处置（提醒、加收、上报、外出、返回、未结离店）与待办的指派、处理结果
  | 'hand_tag_card'
  | 'blacklist_added'
  | 'blacklist_lifted'
  | 'checkin_blocked'
  | 'visit_incident'
  | 'incident_assigned'
  | 'incident_resolved'
  // 8.1.15 块 B1（docs/DINING_V8115.md）：桌台动作——清台、维修、恢复、并台、拆台
  | 'table_clear'
  | 'table_maintenance'
  | 'table_restore'
  | 'table_merge'
  | 'table_split'
  // 8.1.15 菜品管理（docs/DISHES_V8115.md）：新增 / 编辑、上下架、改价、导入
  | 'dish_saved'
  | 'dish_active_set'
  | 'dish_price_changed'
  | 'dishes_imported'
  // 8.1.15 房态中心：服务房间的登记、续钟、换房、退房、并房 / 拆并，改房态（待清、清洁完成、维修、恢复），后台的房型
  | 'room_center_register'
  | 'room_center_extend'
  | 'room_center_move'
  | 'room_center_checkout'
  | 'room_center_merge'
  | 'room_center_state'
  | 'room_category'
  // 8.1.15 技师管理（docs/TECHNICIANS_V8115.md）：组别、班次、排班与临时调班、休假单（detail.action：申请、批准、驳回、撤回、销假）、主播报终端的接管与放下
  | 'technician_group'
  | 'technician_shift'
  | 'technician_schedule'
  | 'technician_leave'
  | 'clock_announcer'
  // 8.1.15 会员卡押金（收、退，detail.kind 写是哪一样）、退卡
  | 'member_card_deposit'
  | 'member_card_returned'
  // 8.1.17 第二家店改本店价（docs/FRONTDESK_V8117.md 第 6 节，BW-11）：改前改后、那时的全公司价、原因；菜品的另记进改价记录
  | 'store_price_changed'
  // 8.1.17 菜品（docs/DISHES_V8117.md 第 6 节）：排序、批量上下架、删除（下架并隐藏）、恢复
  | 'dishes_sorted'
  | 'dishes_active_bulk'
  | 'dish_deleted'
  | 'dish_restored'
  // 8.1.16 菜品维护的「结果待确认」：确认作废一个操作编号（Codex 审查 d12390f 的 P1，docs/DISHES_V8115.md 第 9 节）
  | 'dish_op_abandoned';

export interface AuditEntry {
  staffId: number | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string | number;
  detail?: Record<string, unknown>;
  ip?: string;
  businessDate?: string;
}

/** 审计记在当前门店（8.0.22）：不在事务里写的也记对（门店显式传，不靠事务开头的设置） */
export async function writeAudit(db: Db, entry: AuditEntry & { storeId?: number }): Promise<void> {
  const storeId = entry.storeId ?? currentStoreId();
  // 本店照旧不写这一列（默认值就是本店，只有一家店时与以往完全一样）
  const storeCol = storeId === DEFAULT_STORE_ID ? db`` : db`, store_id`;
  const storeVal = storeId === DEFAULT_STORE_ID ? db`` : db`, ${storeId}`;
  await db`
    INSERT INTO audit_logs (staff_id, action, target_type, target_id, detail, ip, business_date ${storeCol})
    VALUES (${entry.staffId}, ${entry.action}, ${entry.targetType ?? null},
            ${entry.targetId == null ? null : String(entry.targetId)},
            ${db.json((entry.detail ?? {}) as never)}, ${entry.ip ?? null}, ${entry.businessDate ?? null} ${storeVal})`;
}
