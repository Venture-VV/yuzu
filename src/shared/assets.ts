// 资产与易耗台账（8.0.7 ERP P2 3.2，docs/ERP_V807.md）：资产卡片、变动记录、标签（二维码 = 资产编号）、扫码盘点。

export const ASSET_CATEGORIES = ['fixed', 'consumable'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];
export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = { fixed: '固定资产', consumable: '低值易耗' };

export const ASSET_STATUSES = ['in_use', 'idle', 'repair', 'scrapped'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = { in_use: '在用', idle: '闲置', repair: '维修', scrapped: '报废' };

/** 一次最多建几张（转资产建卡、手工建卡） */
export const ASSET_BATCH_MAX = 50;

export interface AssetCard {
  id: number;
  assetNo: string;
  name: string;
  category: AssetCategory;
  departmentId: number | null;
  departmentName: string | null;
  location: string;
  keeper: string;
  originalCents: number;
  acquiredOn: string;
  status: AssetStatus;
  materialId: number | null;
  /** 从哪张收货单转来的 */
  receipt: { docId: number; docNo: string; lineId: number } | null;
  note: string;
  version: number;
  createdAt: string;
}

export interface AssetChange {
  id: number;
  kind: 'create' | 'edit' | 'transfer' | 'status' | 'scrap';
  detail: Record<string, unknown>;
  reason: string;
  createdByName: string;
  createdAt: string;
}

export interface AssetDetail extends AssetCard {
  changes: AssetChange[];
}

/** 能转资产建卡的收货行（按收货单号找） */
export interface AssetReceiptLine {
  lineId: number;
  docId: number;
  docNo: string;
  docDate: string;
  materialId: number;
  materialName: string;
  inventoryUnit: string;
  /** 收货数量（整件） */
  quantity: number;
  /** 已经建了几张卡 */
  carded: number;
  /** 每件的价钱（分，按收货单价折算到库存单位） */
  unitCents: number;
}

export interface AssetStocktake {
  id: number;
  docNo: string;
  departmentId: number | null;
  departmentName: string | null;
  status: 'open' | 'closed';
  note: string;
  startedByName: string;
  startedAt: string;
  closedAt: string | null;
  /** 范围内（没报废的）资产张数 */
  expected: number;
  /** 扫到的（范围内） */
  found: number;
  /** 没扫到的（盘亏）：结束后才算 */
  missing: { id: number; assetNo: string; name: string; location: string; keeper: string }[];
  /** 扫到但不在范围里的、或者编号对不上的 */
  extra: { code: string; assetNo: string | null; name: string | null; departmentName: string | null }[];
  scans: { code: string; assetNo: string | null; name: string | null; scannedAt: string }[];
}
