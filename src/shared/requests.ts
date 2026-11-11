// 部门采购需求单与图片（v0.7.8，飞书需求 RQ-005 第二步，见 docs/REQUISITIONS.md）。

export type RequestStatus = 'submitted' | 'returned' | 'approved' | 'rejected' | 'cancelled';
export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  submitted: '待审核',
  returned: '已退回',
  approved: '已通过',
  rejected: '不采购',
  cancelled: '已撤回',
};

/** 采购优先级（8.0.1 采购组整改 02，CG02）：紧急标红点、普通标绿点 */
export type RequestPriority = 'urgent' | 'normal';
export const PRIORITY_LABELS: Record<RequestPriority, string> = { urgent: '紧急', normal: '普通' };

/**
 * 待审核的排序（CG02）：紧急在前 → 期望到货日期早的在前（没填的排后）→ 提交早的在前。
 * 需求单「待审核」、审批中心顶部的「需求单待审核」、待转采购单的行都用这个顺序。
 */
export function reviewOrder(
  a: { priority: RequestPriority; needBy: string | null; submittedAt: string; id: number },
  b: { priority: RequestPriority; needBy: string | null; submittedAt: string; id: number },
): number {
  if (a.priority !== b.priority) return a.priority === 'urgent' ? -1 : 1;
  if (a.needBy !== b.needBy) {
    if (a.needBy === null) return 1;
    if (b.needBy === null) return -1;
    return a.needBy < b.needBy ? -1 : 1;
  }
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? -1 : 1;
  return a.id - b.id;
}

/** 每一行最多挂几张图 */
export const MAX_LINE_IMAGES = 9;
/** 压缩后单张图片的上限（字节） */
export const MAX_IMAGE_BYTES = 1024 * 1024;
/** 浏览器压缩：最长边与 JPEG 质量 */
export const IMAGE_MAX_EDGE = 1600;
export const IMAGE_QUALITY = 0.8;

export interface ImageRef {
  id: number;
  /** 图片地址（要登录才能看） */
  url: string;
}

/** 需求行的进度：由采购单与收货单算出来（不手填） */
export interface RequestLineProgress {
  /** 对应的有效采购单行（撤回的采购单不算） */
  po: { id: number; docNo: string; status: string; supplierName: string } | null;
  /** 下单数量（采购单行的库存数量）与单位 */
  orderedMilli: number;
  /** 已生效的收货数量 */
  receivedMilli: number;
  /** 已生效的退供应商数量 */
  returnedMilli: number;
  inventoryUnit: string | null;
  /** 这一行采购单合并了几行需求（1 就是只有这一行）；合并时下单、到货数量是整行的 */
  mergedLines: number;
  /** 还没下单、在没撤销的询价单里（v0.7.30）：询价、定标之后转采购单 */
  sourcing: { id: number; docNo: string } | null;
  /** none 未下单；sourcing 询价中（v0.7.30）；ordered 已下单；partial 部分到货；received 已到货；closed 采购单已关闭、没到齐的不再到（v0.7.11） */
  state: 'none' | 'sourcing' | 'ordered' | 'partial' | 'received' | 'closed';
}

export interface RequestLine {
  id: number;
  lineNo: number;
  materialId: number | null;
  materialName: string | null;
  name: string;
  purpose: string;
  qtyMilli: number;
  unit: string;
  link: string;
  details: string;
  refPriceCents: number | null;
  note: string;
  images: ImageRef[];
  progress: RequestLineProgress;
  /** 集采导入（06）带进来的：申请人、采购途径、供应商（填单的为空） */
  applicant: string;
  channel: string | null;
  supplier: { id: number; name: string } | null;
}

export interface PurchaseRequestSummary {
  id: number;
  docNo: string;
  status: RequestStatus;
  department: { id: number; name: string };
  requester: { id: number; name: string };
  needBy: string | null;
  createdAt: string;
  /** 采购优先级（02） */
  priority: RequestPriority;
  /** 这一轮提交的时间（退回后再提交、修改都算重新提交） */
  submittedAt: string;
  /** 每日截单（03）：截单后提交的最早哪天能通过；截单前提交或没开截单的为空 */
  approvableOn: string | null;
  /** 截单后提交、今天还不能通过 */
  lockedToday: boolean;
  /** 填单的、集采导入的（06），还是部门表格导入的（供应链二次整改 02） */
  source: 'form' | 'import' | 'sheet';
  lineCount: number;
  /** 前几行的名称 */
  summary: string;
  /** 已下单的行数 */
  orderedLines: number;
  /** 已到货的行数 */
  receivedLines: number;
}

export interface PurchaseRequest extends PurchaseRequestSummary {
  note: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reason: string | null;
  isSynthetic: boolean;
  lines: RequestLine[];
  approvals: { id: number; action: string; actorName: string; reason: string; createdAt: string }[];
}

export interface RequestsList {
  requests: PurchaseRequestSummary[];
  /** 当前账号：所属部门、能不能审核 */
  me: { departmentId: number | null; departmentName: string | null; canReview: boolean; canCreate: boolean };
}

/** 已通过、还没下单的需求行（转采购单用） */
export interface OpenRequestLine {
  id: number;
  requestId: number;
  requestNo: string;
  department: { id: number; name: string };
  requesterName: string;
  materialId: number | null;
  materialName: string | null;
  name: string;
  purpose: string;
  qtyMilli: number;
  unit: string;
  link: string;
  details: string;
  refPriceCents: number | null;
  images: ImageRef[];
  /** 排序用（CG02）：所在需求单的优先级、期望到货日期、提交时间 */
  priority: RequestPriority;
  needBy: string | null;
  submittedAt: string;
  /** 集采导入带进来的申请人、采购途径、供应商（转采购单时按供应商分组） */
  applicant: string;
  channel: string | null;
  supplier: { id: number; name: string } | null;
}

/** 提需求单要用的选项：用途、部门、可选的物料（部门申购没有库存查看权限，也能从这里选物料） */
export interface RequestMeta {
  purposes: string[];
  departments: { id: number; name: string }[];
  materials: { id: number; code: string; name: string; category: string; specification: string; purchaseUnit: string; inventoryUnit: string }[];
  me: RequestsList['me'];
  /** 每日截单（03）：开着时截单时间（门店时区） */
  cutoff: { enabled: boolean; time: string };
}

export const imageUrl = (id: number) => `/api/erp/images/${id}`;

// ───────────────────────── 集采导入（8.0.1 采购组整改 06，CG06；供应链二次整改 01 改成最终版） ─────────────────────────

/** 集采模板就是采购组的最终版收集表（供应链二次整改 01，GY12）：第 1 行是标题、第 2 行是表头，名字与顺序都不动 */
export const REQUEST_IMPORT_TITLE = '品牌新增寻款采购清单';
export const REQUEST_IMPORT_COLUMNS = ['序号', '是否下单', '是否到货', '是否退货', '产品名称', '用途', '采购数量', '备注', '产品详情', '参考链接渠道'] as const;
/** 必填（表头橙色）；表头按名字认，这两列也认 8.0.1 旧模板的「物品名称」「数量」 */
export const REQUEST_IMPORT_REQUIRED = ['产品名称', '采购数量'] as const;
/** 8.0.1 旧模板的列：表里有的照旧认（旧模板填的文件照样能导入） */
export const REQUEST_IMPORT_LEGACY_COLUMNS = ['申请部门', '申请人', '物品名称', '单位', '数量', '采购优先级', '期望到货日期', '采购途径', '供应商名称'] as const;
/** 线下跟踪的三列：只能填是、否或空着；标了「是」的行默认不导入（GY15） */
export const REQUEST_IMPORT_OFFLINE_COLUMNS = ['是否下单', '是否到货', '是否退货'] as const;
/** 一份文件最多多少行 */
export const REQUEST_IMPORT_MAX_ROWS = 500;

export interface RequestImportRow {
  /** 文件里的行号（表头是第 1 行） */
  row: number;
  seq: string;
  department: { id: number; name: string } | null;
  departmentText: string;
  applicant: string;
  name: string;
  /** 用途：最终版里自由填写，原样记在需求行上（空着记「其他」） */
  purpose: string;
  unit: string;
  qtyMilli: number | null;
  priority: RequestPriority;
  needBy: string | null;
  channel: 'online' | 'self' | 'supplier' | null;
  supplier: { id: number; name: string } | null;
  note: string;
  details: string;
  link: string;
  /** 物品名称与物料档案里的名称一样的：带上物料；不一样的按新产品 */
  material: { id: number; name: string } | null;
  /** 表里标了「是」的线下跟踪列（是否下单、是否到货、是否退货） */
  offline: string[];
  /** 这一行不导入（线下已经下单、到货或退货，又没勾「线下已下单的也导入」） */
  skipped: boolean;
  /** 这一行的问题（空 = 可以导入）；不导入的行有问题也不挡 */
  issues: string[];
}

export interface RequestImportPreview {
  fileName: string;
  sha256: string;
  rows: RequestImportRow[];
  /** 合成几张需求单：部门 + 优先级 + 期望到货日期 */
  groups: { department: string; priority: RequestPriority; needBy: string | null; lines: number }[];
  /** 要导入的行里有问题的行数 */
  issueCount: number;
  /** 不导入的行数（线下已下单的） */
  skippedCount: number;
  /** 这份文件已经导入过 */
  duplicate: { id: number; createdAt: string; createdByName: string } | null;
}

export interface RequestImportResult {
  import: { id: number; fileName: string; rowCount: number; requestCount: number; skippedCount: number; createdAt: string; createdByName: string };
  requests: { id: number; docNo: string; department: string; priority: RequestPriority; needBy: string | null; lineCount: number }[];
  replayed: boolean;
}

// ───────────────────────── 部门表格导入（供应链二次整改 02，docs/ERP_ROUND2.md 第 3 节） ─────────────────────────

/** 部门需求表的列（表头一行、不合并）；列按名字认，顺序可以换，多出来的列不管 */
export const DEPT_SHEET_COLUMNS = ['序号', '申请部门', '物品名称', '物料编号', '用途', '数量', '单位', '采购优先级', '期望到货日期', '参考单价', '参考链接', '产品详情', '备注'] as const;
/** 必填（表头橙色） */
export const DEPT_SHEET_REQUIRED = ['物品名称', '用途', '数量'] as const;
/** 一份文件最多多少行；一张需求单最多 50 行，超过的按顺序拆成几张 */
export const DEPT_SHEET_MAX_ROWS = 500;
export const DEPT_SHEET_LINES_PER_REQUEST = 50;

export interface DeptSheetRow {
  row: number;
  seq: string;
  department: { id: number; name: string } | null;
  departmentText: string;
  material: { id: number; code: string; name: string } | null;
  name: string;
  code: string;
  purpose: string;
  qtyMilli: number | null;
  unit: string;
  priority: RequestPriority;
  needBy: string | null;
  refPriceCents: number | null;
  link: string;
  details: string;
  note: string;
  /** 这一行的问题：「哪一列：为什么」（空 = 可以导入） */
  issues: string[];
}

export interface DeptSheetPreview {
  fileName: string;
  sha256: string;
  rows: DeptSheetRow[];
  /** 合成几张需求单（部门 + 优先级 + 期望到货日期，一张最多 50 行） */
  groups: { department: string; priority: RequestPriority; needBy: string | null; lines: number }[];
  issueCount: number;
  /** 这份文件以前导入过（最近一次）：要勾「确认再导入一次」 */
  previous: { id: number; createdAt: string; createdByName: string; requestCount: number } | null;
}

export interface DeptSheetResult {
  import: { id: number; fileName: string; rowCount: number; requestCount: number; createdAt: string; createdByName: string };
  requests: { id: number; docNo: string; department: string; priority: RequestPriority; needBy: string | null; lineCount: number }[];
  /** 第一张需求单（「结果待确认」查回时按它找） */
  request: { id: number; docNo: string };
  replayed: boolean;
}

// ───────────────────────── 草稿箱（供应链二次整改 03，docs/ERP_ROUND2.md） ─────────────────────────

/** 填单页每隔多少秒自动存一次草稿 */
export const DRAFT_AUTOSAVE_SECONDS = 30;
/** 草稿多少天没再保存就自动清理 */
export const DRAFT_KEEP_DAYS = 30;
/** 每人最多几份草稿 */
export const DRAFT_MAX_PER_STAFF = 20;
/** 草稿里各栏最多多少个字（比提交时宽：草稿不按提交的规则核对，页面上填到哪存到哪） */
export const DRAFT_LIMITS = { name: 80, purpose: 40, qty: 30, unit: 20, refPrice: 30, link: 600, details: 300, lineNote: 200, note: 300 } as const;

/** 草稿里的一行：就是填单页上的一行 */
export interface RequestDraftLine {
  kind: 'material' | 'new';
  materialId: number | null;
  name: string;
  purpose: string;
  qty: string;
  unit: string;
  refPrice: string;
  link: string;
  details: string;
  note: string;
  images: ImageRef[];
}

export interface RequestDraftBody {
  departmentId: number | null;
  needBy: string;
  priority: RequestPriority;
  note: string;
  lines: RequestDraftLine[];
}

export interface RequestDraftSummary {
  /** 草稿编号（页面生成的 UUID） */
  key: string;
  /** 修改哪张需求单的草稿；新提的为空 */
  request: { id: number; docNo: string } | null;
  departmentName: string | null;
  /** 前几行的名称 */
  title: string;
  lineCount: number;
  /** 版本号：保存时带上，对不上说明在别处改过 */
  rev: number;
  createdAt: string;
  updatedAt: string;
  /** 什么时候过期（最后一次保存之后 DRAFT_KEEP_DAYS 天） */
  expiresAt: string;
}

export interface RequestDraft extends RequestDraftSummary {
  body: RequestDraftBody;
}

export interface RequestDraftsList {
  drafts: RequestDraftSummary[];
  max: number;
  keepDays: number;
}

/** 保存草稿时发的一行（图片只发编号） */
export type RequestDraftLineInput = Omit<RequestDraftLine, 'images'> & { imageIds: number[] };
export interface RequestDraftSaveInput {
  /** 看到的版本；第一次保存是 0 */
  rev: number;
  /** 这一次保存的编号：没收到回复、再发一次的同一次保存只算一次 */
  saveId: string;
  requestId: number | null;
  body: Omit<RequestDraftBody, 'lines'> & { lines: RequestDraftLineInput[] };
}
