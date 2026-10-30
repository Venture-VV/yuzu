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
  | 'inventory_settings_updated'
  | 'frontdesk_checkin'
  | 'frontdesk_swap'
  | 'frontdesk_group'
  | 'frontdesk_cancel'
  | 'frontdesk_post'
  | 'frontdesk_void'
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
  | 'dish_limit_set';

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
