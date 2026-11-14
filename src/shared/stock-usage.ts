// 8.0.20 用料与配方、销售与出品扣库存（docs/ERP_V8020.md 第 2 节）：前后端共用的类型与算法。

export interface StockUsageRules {
  /** 结账、出品时按用料扣库存（默认开；关着时不记扣料事件） */
  enabled: boolean;
  /** 不进厨房的明细（零售）从哪个仓扣；配方上单独指定的优先 */
  saleWarehouseId: number;
  /** 进厨房的明细（配方）从哪个仓扣 */
  recipeWarehouseId: number;
}

export const DEFAULT_STOCK_USAGE_RULES: StockUsageRules = { enabled: true, saleWarehouseId: 1, recipeWarehouseId: 1 };

/** 一份项目的一样用料 */
export interface RecipeLine {
  materialId: number;
  materialCode: string;
  materialName: string;
  inventoryUnit: string;
  decimals: number;
  /** 一份用多少（库存单位的千分之一） */
  qtyMilli: number;
  /** 损耗率（万分比，0–5000） */
  lossBp: number;
  /** 现在的平均成本（万分之一分 / 库存单位）；没有「看成本」权限时是 null */
  avgCostE4: number | null;
}

export interface ItemRecipe {
  itemId: number;
  itemName: string;
  category: string;
  price: number;
  active: boolean;
  /** 进厨房 / 水吧（出品时扣）还是不进（结账时扣） */
  kitchen: boolean;
  /** 在用的那一份的版本；0 = 没设用料 */
  version: number;
  warehouseId: number | null;
  note: string;
  lines: RecipeLine[];
  /** 一份的理论成本（分）；没有「看成本」权限或有物料没成本时是 null */
  unitCostCents: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type StockUsageKind = 'sale' | 'recipe';
export const STOCK_USAGE_KIND_LABELS: Record<StockUsageKind, string> = { sale: '销售出库', recipe: '配方耗用' };

/** 待扣料：还没入账的净数（按种类、仓、物料） */
export interface PendingUsage {
  kind: StockUsageKind;
  warehouseId: number;
  warehouseName: string;
  materialId: number;
  materialCode: string;
  materialName: string;
  inventoryUnit: string;
  /** 净数（正 = 该扣还没扣；负 = 冲回的等着后面的抵） */
  netMilli: number;
  /** 这个仓现在的结存 */
  stockMilli: number;
  /** 最早一条的时间 */
  since: string;
  /** 库存不够没扣成 */
  blocked: boolean;
  events: number;
}

export interface UsageBatch {
  id: number;
  kind: StockUsageKind;
  warehouseName: string;
  status: 'posting' | 'done' | 'released';
  docId: number | null;
  docNo: string | null;
  docDate: string;
  lineCount: number;
  error: string | null;
  createdAt: string;
}

export interface StockUsageOverview {
  rules: StockUsageRules;
  pending: PendingUsage[];
  batches: UsageBatch[];
  canEdit: boolean;
  canSeeCost: boolean;
}

/** 物料的最小计量（千分之一库存单位）：0 位小数 = 1000，3 位 = 1 */
export function stepMilli(decimals: number): number {
  return 10 ** (3 - Math.min(Math.max(decimals, 0), 3));
}

/** 几份实际扣多少：一份用量 × 份数 ×（1 + 损耗率），按物料的小数位向上取整 */
export function usageMilli(qtyMilli: number, quantity: number, lossBp: number, decimals: number): number {
  const step = BigInt(stepMilli(decimals));
  const raw = BigInt(qtyMilli) * BigInt(quantity) * BigInt(10000 + lossBp);
  const milli = (raw + 9999n) / 10000n;
  return Number(((milli + step - 1n) / step) * step);
}
