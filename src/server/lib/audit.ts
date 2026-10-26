import type { Db } from '../db';

export type AuditAction =
  | 'login'
  | 'login_failed'
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
  | 'settlement_closed'
  | 'settings_updated'
  | 'plan_saved'
  | 'item_saved'
  | 'export'
  | 'inventory_master_saved'
  | 'inventory_doc'
  | 'purchase_order'
  | 'payable_doc'
  | 'inventory_settings_updated';

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
