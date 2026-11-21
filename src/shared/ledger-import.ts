// 出入库台账（8.1.20，docs/ERP_V8120.md，PENDING_DECISIONS「8.1.20」LD1–LD10）：「库管入库」页右上角的
// 「导入出入库台账」「导出台账」「下载模板」。模板照门店的《仓库出入库记录》：一种物料一行，按月记入库（日期、数量）与
// 出库（日期、数量、领料人及部门）；表头两行（上一行是「入库」「出库」这样的分组，下一行是分组里的列）。

/** 不属于分组的列（表头第一行的名字；顺序就是模板里的顺序，导入时按名字认列） */
export const LEDGER_COLUMNS = ['序号', '日期', '供应商', '物料名称', '规格', '库位', '上期库存量'] as const;
export const LEDGER_TAIL_COLUMNS = ['库存量', '单价', '备注'] as const;
/** 模板里入库、出库各留几组（导入时有几组认几组，导出时不够就往后加） */
export const LEDGER_IN_SLOTS = 2;
export const LEDGER_OUT_SLOTS = 3;
/** 一份最多几行物料；一张单最多几行（与单据上限一样） */
export const LEDGER_MAX_ROWS = 500;
export const LEDGER_LINES_PER_DOC = 100;
/** 入库、出库各最多几组（一个月每天一组还有富余）；一份最多生成几张单（Codex 安全审查 1ddc70a：不封顶时一份小文件能塞几万组、一个事务里生成几万张单） */
export const LEDGER_MAX_GROUPS = 62;
export const LEDGER_MAX_DOCS = 200;
/** 导出的文件标题里带这几个字：导出的台账只用来对账，原样再导入会重复记账，导入时认出来拒绝 */
export const LEDGER_EXPORT_MARK = '系统导出';

export interface LedgerInEvent {
  /** 第几组入库（从 1 起） */
  slot: number;
  date: string | null;
  qtyMilli: number | null;
}

export interface LedgerOutEvent {
  slot: number;
  date: string | null;
  qtyMilli: number | null;
  /** 原文「领料人及部门」 */
  who: string;
  department: { id: number; name: string } | null;
  /** 领料人（去掉部门名以后剩下的；空着记部门名） */
  receiver: string;
}

export interface LedgerImportRow {
  /** 文件里的行号 */
  row: number;
  seq: string;
  material: { id: number; code: string; name: string; inventoryUnit: string; purchaseUnit: string } | null;
  supplier: { id: number; code: string; name: string } | null;
  /** 写在表里的库位；与档案不一样时导入会改档案 */
  location: string;
  locationBefore: string;
  /** 单价（分，每采购单位）：表里写的，没写取档案的参考价 */
  priceCents: number | null;
  priceFromRef: boolean;
  ins: LedgerInEvent[];
  outs: LedgerOutEvent[];
  inMilli: number;
  outMilli: number;
  /** 入库金额（分） */
  amountCents: number;
  note: string;
  /** 挡住导入的问题 */
  issues: string[];
  /** 只提醒、不挡导入（上期库存量、库存量对不上之类） */
  warnings: string[];
}

export interface LedgerImportDoc {
  kind: 'receipt' | 'issue';
  docDate: string;
  /** 供应商名或部门名 */
  party: string;
  receiver: string;
  lines: number;
  amountCents: number;
}

export interface LedgerImportPreview {
  fileName: string;
  sha256: string;
  /** 这次预览的摘要：导入时带上，服务端在锁里重新核对、不一样就整份不导 */
  digest: string;
  title: string;
  rows: LedgerImportRow[];
  docs: LedgerImportDoc[];
  issueCount: number;
  warningCount: number;
  amountCents: number;
  previous: { id: number; createdAt: string; createdByName: string; receiptCount: number; issueCount: number } | null;
}

export interface LedgerImportResult {
  import: {
    id: number;
    fileName: string;
    rowCount: number;
    receiptCount: number;
    issueCount: number;
    amountCents: number;
    createdAt: string;
    createdByName: string;
  };
  docs: { id: number; docNo: string; docType: 'receipt' | 'issue'; docDate: string; party: string; amountCents: number; lineCount: number }[];
  replayed: boolean;
}
