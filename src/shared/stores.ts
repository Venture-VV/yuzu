// 多门店与公司主体（8.0.22，docs/MULTISTORE_V8022.md）。

export const DEFAULT_STORE_ID = 1;
export const DEFAULT_ENTITY_ID = 1;

/**
 * 按店的设置键（第 4 节）：第二家店改了存 store_settings，本店照旧用 settings；门店名取门店档案。
 * 其余设置（钱包、会员、券、ERP、审批、付款……）全公司一份。
 */
export const STORE_SCOPED_SETTING_KEYS = [
  'business_day_start_hour',
  'business_hours',
  'require_open_shift',
  'shift_mode',
  'cash_drawers',
  'print_mode',
  'print_wait_minutes',
  'frontdesk_rules',
  'dining_rules',
  'emenu_rules',
  'room_rules',
  'booking_rules',
  'usage_rules',
  'technician_rules',
  'clockroom_rules',
  'location_rules',
  'guide_rules',
  'stock_usage_rules',
] as const;

export const STORE_CODE_PATTERN = /^[A-Z0-9]{2,8}$/;

export interface StoreBrief {
  id: number;
  code: string;
  name: string;
}

export interface StoreView extends StoreBrief {
  entityId: number;
  entityName: string;
  address: string;
  phone: string;
  active: boolean;
  sortOrder: number;
  version: number;
  staffCount: number;
}

export interface EntityView {
  id: number;
  name: string;
  taxNo: string;
  addressPhone: string;
  bankName: string;
  bankAccount: string;
  active: boolean;
  version: number;
  storeCount: number;
}
