// 部门采购需求单与图片（v0.7.8，飞书需求 RQ-005 第二步，见 docs/REQUISITIONS.md）。

export type RequestStatus = 'submitted' | 'returned' | 'approved' | 'rejected' | 'cancelled';
export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  submitted: '待审核',
  returned: '已退回',
  approved: '已通过',
  rejected: '不采购',
  cancelled: '已撤回',
};

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
  /** none 未下单；ordered 已下单；partial 部分到货；received 已到货 */
  state: 'none' | 'ordered' | 'partial' | 'received';
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
}

export interface PurchaseRequestSummary {
  id: number;
  docNo: string;
  status: RequestStatus;
  department: { id: number; name: string };
  requester: { id: number; name: string };
  needBy: string | null;
  createdAt: string;
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
}

/** 提需求单要用的选项：用途、部门、可选的物料（部门申购没有库存查看权限，也能从这里选物料） */
export interface RequestMeta {
  purposes: string[];
  departments: { id: number; name: string }[];
  materials: { id: number; code: string; name: string; category: string; specification: string; purchaseUnit: string; inventoryUnit: string }[];
  me: RequestsList['me'];
}

export const imageUrl = (id: number) => `/api/erp/images/${id}`;
