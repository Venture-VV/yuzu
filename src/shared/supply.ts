// 8.0.7 供应链收尾（docs/ERP_V807.md 第 2 节）：供应商准入与证照、季度评分与观察名单、部门耗用的用途与经办人、
// 呆滞与周转、批次与效期。数值与开关在「经营规则 → 可调的数值」里改（@shared/tunables）。

export const SUPPLIER_ADMISSIONS = ['pending', 'approved', 'suspended'] as const;
export type SupplierAdmission = (typeof SUPPLIER_ADMISSIONS)[number];
export const SUPPLIER_ADMISSION_LABELS: Record<SupplierAdmission, string> = { pending: '待准入', approved: '已准入', suspended: '暂停' };

export const LICENSE_KINDS = ['business', 'food', 'hygiene', 'other'] as const;
export type LicenseKind = (typeof LICENSE_KINDS)[number];
export const LICENSE_KIND_LABELS: Record<LicenseKind, string> = { business: '营业执照', food: '食品经营许可证', hygiene: '卫生许可证', other: '其他' };

/** 供应商的一张证照 */
export interface SupplierLicense {
  id: number;
  supplierId: number;
  kind: LicenseKind;
  /** 「其他」的名称；另外三种可以为空 */
  name: string;
  licenseNo: string;
  /** 有效期至：空 = 长期 */
  validUntil: string | null;
  /** 照片（通用图片接口）或 PDF（证照的下载接口）；都没有的为空 */
  media: { kind: 'image' | 'pdf'; url: string } | null;
  addedByName: string;
  addedAt: string;
}

/** 到期提醒里的一张证照（含已过期） */
export interface LicenseDueItem {
  licenseId: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  kind: LicenseKind;
  name: string;
  licenseNo: string;
  validUntil: string;
  /** 还剩几天（负数 = 已过期几天） */
  daysLeft: number;
}

/** 供应商档案的「准入与证照」 */
export interface SupplierAdmissionView {
  supplierId: number;
  admission: SupplierAdmission;
  admissionNote: string;
  admissionByName: string | null;
  admissionAt: string | null;
  licenses: SupplierLicense[];
  /** 准入的条件（V1）满足了没有：有一张没过期的营业执照 */
  canApprove: boolean;
}

// ───────────────────────── 季度评分（2.2） ─────────────────────────

/** 评分的权重（V4，待确认）：准时 40、合格 40、价格 20 */
export const SCORE_WEIGHTS = { onTime: 40, quality: 40, price: 20 } as const;

export interface SupplierScore {
  supplierId: number;
  code: string;
  name: string;
  admission: SupplierAdmission;
  /** 这个季度生效的收货单张数 */
  receipts: number;
  /** 准时的张数 */
  onTime: number;
  /** 准时率（万分之几） */
  onTimeBp: number | null;
  /** 送货金额（收货 + 拒收，分） */
  deliveredCents: number;
  /** 拒收金额 */
  rejectedCents: number;
  /** 退货金额 */
  returnedCents: number;
  /** 合格率（万分之几） */
  qualityBp: number | null;
  /** 价格指数（万分之几，10000 = 与同物料均价持平）；没有可比的为空 */
  priceIndexBp: number | null;
  /** 分数（0–100，一位小数 ×10）；样本不足的为空 */
  scoreX10: number | null;
  /** 低于观察线（V5）进观察名单 */
  watch: boolean;
}

export interface SupplierScoreReport {
  /** 2026Q4 这样 */
  quarter: string;
  from: string;
  to: string;
  watchBelow: number;
  rows: SupplierScore[];
}

/** 2026-11-10 → 2026Q4 */
export function quarterOf(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
}

/** 2026Q4 → [2026-10-01, 2026-12-31]；格式不对返回 null */
export function quarterRange(quarter: string): { from: string; to: string } | null {
  const m = /^(\d{4})Q([1-4])$/.exec(quarter);
  if (!m) return null;
  const y = Number(m[1]);
  const q = Number(m[2]);
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return { from: `${y}-${pad(startMonth)}-01`, to: `${y}-${pad(endMonth)}-${pad(lastDay)}` };
}

/** 往前数几个季度（含这个季度），最近的在前 */
export function recentQuarters(today: string, n: number): string[] {
  const [y0, m0] = today.split('-').map(Number) as [number, number];
  let y = y0;
  let q = Math.floor((m0 - 1) / 3) + 1;
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(`${y}Q${q}`);
    q -= 1;
    if (q === 0) {
      q = 4;
      y -= 1;
    }
  }
  return out;
}

/**
 * 分数（V4）：准时率 × 40 + 合格率 × 40 + 价格分 × 20；价格分 = 100 −（价格指数 − 1）× 200，封在 0–100，
 * 没有可比价格的按 100 分（不扣分）。返回 ×10 的整数（一位小数）。
 */
export function scoreOf(onTimeBp: number, qualityBp: number, priceIndexBp: number | null): number {
  const priceScore = priceIndexBp === null ? 100 : Math.min(100, Math.max(0, 100 - ((priceIndexBp - 10_000) / 10_000) * 200));
  const raw = (onTimeBp / 10_000) * SCORE_WEIGHTS.onTime + (qualityBp / 10_000) * SCORE_WEIGHTS.quality + (priceScore / 100) * SCORE_WEIGHTS.price;
  return Math.round(raw * 10);
}

// ───────────────────────── 部门耗用（2.3） ─────────────────────────

/** 耗用用途的默认列表（V6，在「经营规则 → 可调的数值」里改） */
export const DEFAULT_CONSUMPTION_PURPOSES = ['客用消耗', '员工使用', '清洁卫生', '维修保养', '活动与赠送', '其他'] as const;
export const MAX_CONSUMPTION_PURPOSES = 20;

export interface ConsumptionRecord {
  docId: number;
  docNo: string;
  docDate: string;
  departmentId: number;
  departmentName: string;
  /** 用途：8.0.7 以前的单子为空（页面显示「（v8.0.7 以前没记）」） */
  purpose: string | null;
  handlerId: number | null;
  handlerName: string | null;
  /** 说明（原来的「耗用用途」文字） */
  note: string;
  materialCode: string;
  materialName: string;
  inventoryUnit: string;
  decimals: number;
  quantityMilli: number;
  status: string;
}

// ───────────────────────── 呆滞与周转（2.4） ─────────────────────────

export interface SlowMovingRow {
  materialId: number;
  code: string;
  name: string;
  specification: string;
  inventoryUnit: string;
  decimals: number;
  /** 总仓为空，部门小仓是部门编号 */
  departmentId: number | null;
  warehouseName: string;
  stockMilli: number;
  /** 结存金额（按最近一次收货价，没有按参考价） */
  amountCents: number | null;
  /** 最近一次出库日（领料、耗用、报损、退供应商……）；没有出过的为空 */
  lastOutDate: string | null;
  /** 多少天没出库（从最近一次出库日或第一次入库日算起） */
  idleDays: number | null;
  /** 近 90 天日均用量（千分之一单位 ×1，取整） */
  dailyUsageMilli: number;
  /** 周转天数（结存 ÷ 日均用量）；没有用量的为空 */
  turnoverDays: number | null;
  slow: boolean;
}

export interface SlowMovingReport {
  slowDays: number;
  rows: SlowMovingRow[];
}

// ───────────────────────── 批次与效期（3.3） ─────────────────────────

export interface ExpiryLot {
  materialId: number;
  code: string;
  name: string;
  inventoryUnit: string;
  decimals: number;
  docId: number;
  docNo: string;
  receivedDate: string;
  batchNo: string;
  expiresOn: string;
  /** 这一批推算还剩多少（先进先出：剩下的是最近收的几批） */
  remainingMilli: number;
  daysLeft: number;
}

/** ERP 待办里供应链的几项（导航数字） */
export interface SupplyTodo {
  /** 待准入的供应商 */
  pendingAdmission: number;
  /** 到期前 N 天以内的证照（含已过期） */
  licensesDue: number;
  licensesExpired: number;
  /** 呆滞的物料行（按仓） */
  slowMoving: number;
  /** 临期与过期的批次 */
  expiringLots: number;
  expiredLots: number;
}
