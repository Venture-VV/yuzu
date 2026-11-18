// 库管入库的台账模板与一键导入（8.1.9，docs/ERP_V819.md 第 3.2 节，KR4、KR5）。

/** 模板「入库台账」的列（顺序就是模板里的顺序；导入时按表头的名字认列，顺序可以换） */
export const RECEIPT_IMPORT_COLUMNS = [
  '序号',
  '入库日期',
  '供应商',
  '物品名称',
  '物料编号',
  '送达数量',
  '合格实收',
  '单位',
  '单价',
  '金额',
  '拒收原因',
  '批号',
  '生产日期',
  '到期日',
  '收货人',
  '单据分组',
  '备注',
] as const;
export type ReceiptImportColumn = (typeof RECEIPT_IMPORT_COLUMNS)[number];
export const RECEIPT_IMPORT_REQUIRED: readonly ReceiptImportColumn[] = ['入库日期', '供应商', '物品名称', '送达数量', '单价'];
/** 一份最多几行；一张库管入库最多几行（与单据上限一样） */
export const RECEIPT_IMPORT_MAX_ROWS = 500;
export const RECEIPT_IMPORT_LINES_PER_DOC = 100;

export interface ReceiptImportRow {
  /** 文件里的行号（表头是第 1 行） */
  row: number;
  seq: string;
  docDate: string | null;
  supplier: { id: number; code: string; name: string } | null;
  material: { id: number; code: string; name: string; inventoryUnit: string; purchaseUnit: string } | null;
  /** 按库存单位换算好的送达、合格实收（千分之一） */
  deliveredMilli: number | null;
  acceptedMilli: number | null;
  /** 写的单位（空着是库存单位） */
  unit: string;
  /** 每采购单位的单价（分） */
  priceCents: number | null;
  /** 按合格实收 × 单价算的金额（分） */
  amountCents: number | null;
  rejectReason: string;
  batchNo: string | null;
  producedOn: string | null;
  expiresOn: string | null;
  handler: string;
  group: string;
  note: string;
  issues: string[];
}

export interface ReceiptImportGroup {
  docDate: string;
  supplierName: string;
  group: string;
  lines: number;
  amountCents: number;
}

export interface ReceiptImportPreview {
  fileName: string;
  sha256: string;
  rows: ReceiptImportRow[];
  /** 没有问题时要生成的库管入库单（有问题时为空） */
  groups: ReceiptImportGroup[];
  issueCount: number;
  amountCents: number;
  /** 这份文件以前导入过（同一份文件只能导入一次） */
  previous: { id: number; createdAt: string; createdByName: string; docCount: number } | null;
}

export interface ReceiptImportResult {
  import: { id: number; fileName: string; rowCount: number; docCount: number; amountCents: number; createdAt: string; createdByName: string };
  docs: { id: number; docNo: string; docDate: string; supplierName: string; lineCount: number; amountCents: number }[];
  replayed: boolean;
}
