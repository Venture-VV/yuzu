// 8.0.20 布草洗涤（docs/ERP_V8020.md 第 4 节）：前后端共用的类型。

export type LinenDocKind = 'add' | 'send' | 'return' | 'scrap';
export const LINEN_DOC_LABELS: Record<LinenDocKind, string> = { add: '新增', send: '送洗', return: '收回', scrap: '报废' };
export const LINEN_DOC_PREFIX: Record<LinenDocKind, string> = { add: 'BX', send: 'BS', return: 'BH', scrap: 'BF' };

export interface LinenItem {
  id: number;
  name: string;
  totalQty: number;
  atLaundryQty: number;
  /** 在店 = 总数 − 在洗 */
  inHouseQty: number;
  washPriceCents: number;
  active: boolean;
  version: number;
}

export interface LinenDocLine {
  itemId: number;
  itemName: string;
  qty: number;
  damagedQty: number;
  lostQty: number;
  priceCents: number;
  amountCents: number;
}

export interface LinenDoc {
  id: number;
  docNo: string;
  kind: LinenDocKind;
  supplier: { id: number; name: string } | null;
  docDate: string;
  note: string;
  amountCents: number;
  status: 'confirmed' | 'voided';
  createdByName: string;
  createdAt: string;
  voidReason: string | null;
  lines: LinenDocLine[];
}

/** 哪家洗涤厂手里还有几件没收回 */
export interface LinenOutstanding {
  supplierId: number;
  supplierName: string;
  itemId: number;
  itemName: string;
  qty: number;
}

export interface LinenOverview {
  items: LinenItem[];
  outstanding: LinenOutstanding[];
  docs: LinenDoc[];
  canManage: boolean;
}

/** 洗涤费对账表（按洗涤厂、按月；只算有效的收回单） */
export interface LinenStatement {
  month: string;
  rows: { supplierId: number; supplierName: string; docs: number; washedQty: number; damagedQty: number; lostQty: number; amountCents: number }[];
  totalCents: number;
}
