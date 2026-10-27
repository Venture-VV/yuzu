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
  | 'hand_tags_created'
  | 'hand_tags_imported'
  | 'hand_tag_locked'
  | 'hand_tag_unlocked'
  | 'hand_tag_updated';

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
