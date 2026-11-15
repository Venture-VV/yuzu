// 供应商门户（8.0.21，docs/FINANCE_V8021.md 第 7 节，CW-F）：报价、订单确认、发货预告三种链接。
// 供应商不开账号，凭门店发的链接打开（有效天数与对账确认链接同一项设置），按链接种类填报价、确认能供与承诺到货日、发货预告。

export const SUPPLIER_LINK_KINDS = ['quote', 'po_confirm', 'delivery'] as const;
export type SupplierLinkKind = (typeof SUPPLIER_LINK_KINDS)[number];
export const SUPPLIER_LINK_LABELS: Record<SupplierLinkKind, string> = { quote: '报价', po_confirm: '订单确认', delivery: '发货预告' };

export interface SupplierLinkLine {
  lineId: number;
  lineNo: number;
  materialName: string;
  spec: string;
  purchaseUnit: string;
  purchaseQtyMilli: number;
  /** 采购单的才有：下单单价与金额 */
  priceCents: number | null;
  amountCents: number | null;
}

/** 生成链接时的快照：供应商看到的就是这些 */
export interface SupplierLinkSnapshot {
  storeName: string;
  supplierName: string;
  docNo: string;
  title: string;
  /** 询价单的「要货日期」、采购单的「期望到货」 */
  needBy: string | null;
  orderDate: string | null;
  note: string;
  lines: SupplierLinkLine[];
  totalCents: number | null;
  /** 采购单链接：发链接时采购单的版次（8.0.21 Codex 审查 beabd59 后补；之前发的没有）。改版以后链接不能再回复 */
  revision?: number;
}

export interface SupplierConfirmation {
  promisedDate: string;
  replyName: string;
  note: string;
  createdAt: string;
}

export interface DeliveryNotice {
  id: number;
  shipDate: string;
  eta: string | null;
  trackingNo: string;
  lines: { lineId: number; qtyMilli: number }[];
  note: string;
  replyName: string;
  createdAt: string;
}

/** 这家在这张询价单上现在的有效报价（供应商链接里看到的「您已报价」） */
export interface PortalQuote {
  goodsCents: number;
  freightCents: number;
  payTerms: string;
  creditDays: number;
  deliveryDays: number | null;
  validUntil: string | null;
  note: string;
  prices: { lineId: number; priceCents: number }[];
  viaLink: boolean;
  createdAt: string;
}

export interface SupplierPublicView {
  kind: SupplierLinkKind;
  snapshot: SupplierLinkSnapshot;
  expiresAt: string;
  /** 还能不能回：询价单定标、撤销了，采购单撤回、关闭了，订单已经确认过了的都不能 */
  open: boolean;
  closedReason: string | null;
  quote: PortalQuote | null;
  confirmation: SupplierConfirmation | null;
  notices: DeliveryNotice[];
}

/** 员工这边看到的一条链接 */
export interface SupplierLinkState {
  id: number;
  kind: SupplierLinkKind;
  supplierId: number;
  supplierName: string;
  createdAt: string;
  createdByName: string;
  expiresAt: string;
  expired: boolean;
  voidedAt: string | null;
  replies: number;
  lastReplyAt: string | null;
  lastReplyName: string | null;
}

/** 采购单上的供应商一栏：确认、发货预告、链接 */
export interface PoSupplierPortal {
  confirmation: SupplierConfirmation | null;
  notices: DeliveryNotice[];
  links: SupplierLinkState[];
}
