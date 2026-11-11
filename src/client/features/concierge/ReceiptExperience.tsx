import { useCan } from "../../lib/session";
import { conciergeFetch as fetch } from "./api";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Eye,
  FileText,
  ImagePlus,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import type {
  Balance,
  Member,
  Receipt,
  ReceiptItem,
  CatalogItem,
  WorkspaceData,
  Upload,
} from "./types";
import { runReceiptOcr } from "./receipt-ocr";
import {
  applyCatalogMatches,
  matchCatalogName,
  reviewReceipt,
  catalogDisplayName,
} from "./receipt-review";
import { CatalogApprovalPanel } from "./CatalogManager";
import type { SaveCatalog } from "./CatalogManager";

export type ReceiptItemInput = {
  name: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  rawText: string;
  ocrName?: string;
  catalogItemId?: string;
  packageIncluded?: boolean;
};
export type ReceiptTotalsInput = {
  subtotal: string;
  due: string;
  rounding: string;
  paid: string;
};
export type ReceiptDetailsInput = {
  cashier: string;
  shift: string;
  wristbands: string;
  partySize: string;
  printCount: string;
  printedAt: string;
  printedBy: string;
  coupons: string;
};
export type PaymentInput = {
  method: string;
  amount: string;
  memberId: string;
  originalMethod?: string;
};
export type ReceiptDraft = {
  receiptId?: string;
  version?: number;
  memberId?: string;
  number?: string;
  store?: string;
  occurredAt?: string;
  amount?: string;
  rawText?: string;
  itemsText?: string;
  uploadIds?: string[];
  payments?: Array<Omit<PaymentInput, "memberId"> & { memberId?: string }>;
  items?: Array<{
    name: string;
    quantity: string;
    unitPrice?: string;
    amount?: string;
    rawText?: string;
    ocrName?: string;
    catalogItemId?: string;
    packageIncluded?: boolean;
  }>;
  totals?: Partial<ReceiptTotalsInput>;
  details?: Partial<ReceiptDetailsInput>;
  warnings?: string[];
  itemsReviewed?: boolean;
  review?: {
    mode: "exceptions";
    checkedIssueKeys: string[];
    summaryConfirmed: boolean;
  };
};
const EMPTY_TOTALS: ReceiptTotalsInput = {
  subtotal: "",
  due: "",
  rounding: "",
  paid: "",
};
const EMPTY_DETAILS: ReceiptDetailsInput = {
  cashier: "",
  shift: "",
  wristbands: "",
  partySize: "",
  printCount: "",
  printedAt: "",
  printedBy: "",
  coupons: "",
};
const DETAILS_LABELS: Record<keyof ReceiptDetailsInput, string> = {
  cashier: "收银员",
  shift: "班次",
  wristbands: "手牌 / 手牌号",
  partySize: "票面人数",
  printCount: "打印次数",
  printedAt: "打印时间（中国时间）",
  printedBy: "打印人",
  coupons: "券号 / 优惠券",
};
const METHOD_OPTIONS = [
  "会员扣卡",
  "微信",
  "支付宝",
  "现金",
  "银行卡",
  "其他待核",
];
const uid = () => crypto.randomUUID();
function money(n: number) {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n / 100);
}
function value(n: number | null | undefined) {
  return n == null ? "" : (n / 100).toFixed(2);
}
function displayMoney(n: number | null | undefined) {
  return n == null ? "票面未明确" : `¥ ${money(n)}`;
}
function moneyCents(s: string, signed = false): number | null {
  if (
    !(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(s.trim())
  )
    return null;
  const negative = s.trim().startsWith("-");
  const [whole, decimal = ""] = s.replace(/^-/, "").trim().split(".");
  const n = Number(whole) * 100 + Number((decimal + "00").slice(0, 2));
  return Number.isSafeInteger(n) ? (negative ? -n : n) : null;
}
function localTime(s?: string) {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
function date(s?: string) {
  if (!s) return "未记录";
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? s
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
}
function detailTime(value: string) {
  return /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? localTime(value) + "+08:00"
    : value;
}
function day(s: string) {
  return localTime(s).slice(0, 10);
}
function iso(s: string) {
  return s
    ? new Date(`${s}${s.length === 16 ? ":00" : ""}+08:00`).toISOString()
    : "";
}
function normalizeMethod(s: string) {
  return /会员|储值|余额|卡扣|扣卡/.test(s)
    ? "会员扣卡"
    : s.includes("微信")
      ? "微信"
      : s.includes("支付宝")
        ? "支付宝"
        : s.includes("银行卡")
          ? "银行卡"
          : s.includes("现金")
            ? "现金"
            : "其他待核";
}
function Field({
  label,
  hint,
  children,
  wide = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "field-wide" : ""}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Notice({
  children,
  warm = false,
}: {
  children: ReactNode;
  warm?: boolean;
}) {
  return (
    <div className={`detail-notice ${warm ? "notice-warm" : ""}`}>
      <ShieldCheck size={15} />
      <span>{children}</span>
    </div>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span
      className={`status status-${value === "已确认" ? "green" : value.includes("待") ? "orange" : "gray"}`}
    >
      <i />
      {value}
    </span>
  );
}
function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  locked = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  locked?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const element = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        close.current();
      }
      if (e.key === "Tab") {
        const list = [
          ...(element?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
          ) || []),
        ];
        const first = list[0],
          last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    element?.querySelector<HTMLElement>("button")?.focus();
    document.addEventListener("keydown", handler, true);
    return () => {
      document.body.style.overflow = before;
      document.removeEventListener("keydown", handler, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="modal-layer receipt-experience-layer">
      <div className="modal-scrim" onClick={locked ? undefined : onClose} />
      <section
        ref={ref}
        className={`modal-box ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="form-subtitle">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            disabled={locked}
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function EvidenceImages({
  ids,
  title = "原始凭证",
  compact = false,
}: {
  ids: string[];
  title?: string;
  compact?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [rotate, setRotate] = useState(0);
  const [failed, setFailed] = useState(false);
  const current = Math.min(page, Math.max(0, ids.length - 1));
  useEffect(() => setFailed(false), [current, ids.join(",")]);
  return (
    <section
      className={`receipt-image-pane ${compact ? "evidence-compact" : ""}`}
    >
      <div className="receipt-image-header">
        <strong>{title}</strong>
        <span>
          {ids.length ? `${current + 1} / ${ids.length}张` : "尚无附图"}
        </span>
      </div>
      {ids.length ? (
        <>
          <div className={`receipt-original ${zoom ? "zoomed" : ""}`}>
            {failed ? (
              <div className="image-load-failed">
                <CircleHelp size={25} />
                <p>图片暂时无法显示</p>
                <a
                  href={`/api/concierge/uploads/${ids[current]}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开凭证检查
                  <ArrowUpRight size={13} />
                </a>
              </div>
            ) : (
              <img
                key={ids[current]}
                src={`/api/concierge/uploads/${ids[current]}`}
                style={{ transform: `rotate(${rotate}deg)` }}
                alt={`${title}第${current + 1}页`}
                onError={() => setFailed(true)}
              />
            )}
          </div>
          <div className="receipt-image-tools">
            <button
              type="button"
              className="icon-btn"
              disabled={current === 0}
              aria-label="上一张凭证"
              onClick={() => {
                setPage((n) => n - 1);
                setRotate(0);
              }}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              className="text-btn"
              onClick={() => setZoom((v) => !v)}
            >
              <Eye size={14} />
              {zoom ? "适应宽度" : "放大查看"}
            </button>
            <button
              type="button"
              className="text-btn"
              onClick={() => setRotate((n) => (n + 90) % 360)}
            >
              旋转
            </button>
            <a
              className="text-btn"
              href={`/api/concierge/uploads/${ids[current]}`}
              target="_blank"
              rel="noreferrer"
            >
              打开原图
              <ArrowUpRight size={13} />
            </a>
            <button
              type="button"
              className="icon-btn"
              disabled={current >= ids.length - 1}
              aria-label="下一张凭证"
              onClick={() => {
                setPage((n) => n + 1);
                setRotate(0);
              }}
            >
              <ChevronRight size={18} />
            </button>
          </div>
          {ids.length > 1 && (
            <div className="evidence-thumbnails">
              {ids.map((id, i) => (
                <button
                  type="button"
                  key={id}
                  className={i === current ? "selected" : ""}
                  onClick={() => {
                    setPage(i);
                    setRotate(0);
                  }}
                  aria-label={`查看第${i + 1}张凭证`}
                >
                  <img
                    src={`/api/concierge/uploads/${id}`}
                    alt={`凭证缩略图${i + 1}`}
                  />
                  <span>{i + 1}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="no-receipt-image">
          <Camera size={32} />
          <p>此记录尚未附图，不能据此推断已核验消费。</p>
        </div>
      )}
    </section>
  );
}

export function inputReceiptItems(
  items: readonly ReceiptItemInput[],
): ReceiptItem[] {
  return items.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    unitPriceCents: moneyCents(i.unitPrice),
    amountCents: moneyCents(i.amount),
    rawText: i.rawText,
    ocrName: i.ocrName ?? i.name,
    catalogItemId: i.catalogItemId || "",
    packageIncluded: !!i.packageIncluded,
  }));
}
export function applyDraftCatalog(
  items: NonNullable<ReceiptDraft["items"]>,
  catalog: readonly CatalogItem[],
): ReceiptItemInput[] {
  const normalized: ReceiptItemInput[] = items.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    unitPrice: i.unitPrice ?? "",
    amount: i.amount ?? "",
    rawText: i.rawText ?? "",
    ocrName: i.ocrName ?? i.name,
    catalogItemId: i.catalogItemId || "",
    packageIncluded: !!i.packageIncluded,
  }));
  const matched = applyCatalogMatches(inputReceiptItems(normalized), catalog);
  return normalized.map((original, index) => ({
    ...original,
    name: matched[index]?.name ?? original.name,
    ocrName: matched[index]?.ocrName ?? original.ocrName,
    catalogItemId: matched[index]?.catalogItemId || "",
    packageIncluded: !!matched[index]?.packageIncluded,
  }));
}

export function ReceiptEditor({
  receipt,
  seed,
  data,
  busy,
  error,
  onClose,
  onSave,
  onSaveCatalog,
}: {
  receipt?: Receipt;
  seed?: ReceiptDraft;
  data: WorkspaceData;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<boolean>;
  onSaveCatalog: SaveCatalog;
}) {
  const canNative = useCan();
  const [nativeCheckoutId, setNativeCheckoutId] = useState(
    receipt?.nativeCheckoutId ? String(receipt.nativeCheckoutId) : "",
  );
  const catalog = data.catalog || [];
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [memberId, setMemberId] = useState(
    receipt?.memberId || seed?.memberId || "",
  );
  const [number, setNumber] = useState(receipt?.number || seed?.number || "");
  const [store, setStore] = useState(receipt?.store || seed?.store || "");
  const [occurredAt, setOccurredAt] = useState(
    localTime(receipt?.occurredAt || seed?.occurredAt),
  );
  const [occurredEdited, setOccurredEdited] = useState(false);
  const [kind, setKind] = useState<Receipt["kind"]>(receipt?.kind || "结算单");
  const [status, setStatus] = useState<Receipt["status"]>(
    receipt?.status || "待核对",
  );
  const [total, setTotal] = useState(
    receipt ? value(receipt.amountCents) : seed?.amount || "",
  );
  const [payments, setPayments] = useState<PaymentInput[]>(
    receipt?.payments.length
      ? receipt.payments.map((p) => ({
          method: normalizeMethod(p.method),
          amount: value(p.amountCents),
          memberId: p.memberId,
          originalMethod: p.originalMethod || p.method,
        }))
      : seed?.payments?.length
        ? seed.payments.map((p) => ({
            ...p,
            method: normalizeMethod(p.method),
            memberId: p.memberId || "",
            originalMethod: p.originalMethod || p.method,
          }))
        : [
            {
              method: "其他待核",
              amount: "",
              memberId: "",
              originalMethod: "",
            },
          ],
  );
  const [itemsTouched, setItemsTouched] = useState(false);
  const legacyConfirmed =
    receipt?.status === "已确认" && receipt.items === undefined;
  const [items, setItems] = useState<ReceiptItemInput[]>(() => {
    const rows =
      receipt?.items?.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: value(i.unitPriceCents),
        amount: value(i.amountCents),
        rawText: i.rawText,
        ocrName: i.ocrName ?? i.name,
        catalogItemId: i.catalogItemId || "",
        packageIncluded: !!i.packageIncluded,
      })) ||
      seed?.items ||
      [];
    return receipt && ["已确认", "已作废"].includes(receipt.status)
      ? rows.map((i) => ({
          ...i,
          unitPrice: i.unitPrice ?? "",
          amount: i.amount ?? "",
          rawText: i.rawText ?? "",
        }))
      : applyDraftCatalog(rows, catalog);
  });
  const [totals, setTotals] = useState<ReceiptTotalsInput>(
    receipt?.totals
      ? {
          subtotal: value(receipt.totals.subtotalCents),
          due: value(receipt.totals.dueCents),
          rounding: value(receipt.totals.roundingCents),
          paid: value(receipt.totals.paidCents),
        }
      : {
          subtotal: seed?.totals?.subtotal ?? "",
          due: seed?.totals?.due ?? "",
          rounding: seed?.totals?.rounding ?? "",
          paid: seed?.totals?.paid ?? "",
        },
  );
  const [details, setDetails] = useState<ReceiptDetailsInput>(() => {
    const source = receipt?.details || seed?.details;
    return Object.fromEntries(
      (Object.keys(EMPTY_DETAILS) as Array<keyof ReceiptDetailsInput>).map(
        (k) => [
          k,
          k === "printedAt"
            ? detailTime(source?.[k] ?? "")
            : (source?.[k] ?? ""),
        ],
      ),
    ) as ReceiptDetailsInput;
  });
  const [warnings, setWarnings] = useState<string[]>(
    receipt?.warnings || seed?.warnings || [],
  );
  const [itemsText, setItemsText] = useState(
    receipt?.itemsText || seed?.itemsText || "",
  );
  const [rawText, setRawText] = useState(
    receipt?.rawText || seed?.rawText || "",
  );
  const [note, setNote] = useState(receipt?.note || "");
  const [originalId, setOriginalId] = useState(
    receipt?.originalReceiptId || "",
  );
  const [reason, setReason] = useState("");
  const [summaryConfirmed, setSummaryConfirmed] = useState(false);
  const [checkedIssueKeys, setCheckedIssueKeys] = useState<string[]>(
    receipt?.review?.checkedIssueKeys || seed?.review?.checkedIssueKeys || [],
  );
  const [localError, setLocalError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [showAllItems, setShowAllItems] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [approvalIndex, setApprovalIndex] = useState<number | null>(null);
  const [showMetadata, setShowMetadata] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrMessage, setOcrMessage] = useState("");
  const [ocrCompleted, setOcrCompleted] = useState(false);
  const ocrRunning = useRef(false);
  const uploadIds = receipt?.uploadIds || seed?.uploadIds || [];
  const manager = data.user.role === "manager";
  const restricted =
    !!receipt && ["已确认", "已作废"].includes(receipt.status) && !manager;
  const canReRecognize =
    uploadIds.length > 0 &&
    ["待核对", "待补全", "待复核"].includes(receipt?.status || "待核对") &&
    ["待核对", "待补全", "待复核"].includes(status);
  const currentOccurredAt =
    !occurredEdited && (receipt?.occurredAt || seed?.occurredAt)
      ? receipt?.occurredAt || seed?.occurredAt
      : occurredAt
        ? iso(occurredAt)
        : "";
  const snapshot: Partial<Receipt> = {
    ...(receipt || {}),
    memberId,
    number,
    store,
    occurredAt: currentOccurredAt || "",
    kind,
    status,
    amountCents: moneyCents(total),
    items: inputReceiptItems(items),
    payments: payments
      .filter((p) => p.amount.trim() !== "")
      .map((p) => ({
        method: p.method,
        amountCents: moneyCents(p.amount) ?? Number.NaN,
        memberId: p.method === "会员扣卡" ? p.memberId : "",
        originalMethod: p.originalMethod,
      })),
    totals: {
      subtotalCents: moneyCents(totals.subtotal),
      dueCents: moneyCents(totals.due),
      roundingCents: moneyCents(totals.rounding, true),
      paidCents: moneyCents(totals.paid),
    },
    details,
    uploadIds,
    rawText,
    itemsText,
    warnings,
    originalReceiptId: originalId,
    note,
  };
  const report = reviewReceipt(snapshot, catalog);
  const currentIssueKeys = new Set(report.issues.map((i) => i.key));
  const pendingIssues = report.issues.filter(
    (i) => i.blocking && (i.requiresFix || !checkedIssueKeys.includes(i.key)),
  );
  const itemIssueIndexes = new Set(
    report.issues
      .filter((i) => i.itemIndex !== undefined)
      .map((i) => i.itemIndex!),
  );
  const visibleItems = items
    .map((item, index) => ({ item, index }))
    .filter((x) => showAllItems || itemIssueIndexes.has(x.index));
  const generalIssues = report.issues.filter((i) => i.itemIndex === undefined);
  const knownItemTotal = items.reduce(
    (n, i) => n + (moneyCents(i.amount) || 0),
    0,
  );
  const paymentTotal = payments.reduce(
    (n, p) => n + (moneyCents(p.amount) || 0),
    0,
  );
  const headerIssue = generalIssues.some((i) => i.scope === "header");
  const paymentIssue = generalIssues.some(
    (i) => i.scope === "payment" || i.scope === "total",
  );
  const duplicate = data.receipts.find(
    (r) =>
      r.id !== (receipt?.id || seed?.receiptId) &&
      r.number &&
      r.number === number.trim() &&
      r.store === store.trim() &&
      (!r.occurredAt ||
        !occurredAt ||
        day(r.occurredAt) === occurredAt.slice(0, 10)),
  );
  function change() {
    setDirty(true);
    setLocalError("");
    setSummaryConfirmed(false);
  }
  function close() {
    if (busy || ocrRunning.current) return;
    if (dirty && !confirm("有尚未保存的核对内容，确定关闭吗？")) return;
    onClose();
  }
  function updateItem(
    index: number,
    key: keyof ReceiptItemInput,
    v: string | boolean,
  ) {
    setItemsTouched(true);
    setItems((old) =>
      old.map((item, i) =>
        i === index
          ? {
              ...item,
              [key]: v,
              ...(key === "name" ? { catalogItemId: "" } : {}),
            }
          : item,
      ),
    );
    change();
  }
  function chooseCatalog(index: number, item: CatalogItem) {
    setItemsTouched(true);
    setItems((old) =>
      old.map((row, i) =>
        i === index
          ? {
              ...row,
              name: catalogDisplayName(item),
              ocrName: row.ocrName ?? row.name,
              catalogItemId: item.id,
              packageIncluded: item.packageIncluded,
            }
          : row,
      ),
    );
    change();
  }
  function checkIssue(key: string, checked: boolean) {
    setCheckedIssueKeys((old) =>
      checked ? [...new Set([...old, key])] : old.filter((x) => x !== key),
    );
    setDirty(true);
    setSummaryConfirmed(false);
  }
  function updatePayment(index: number, key: keyof PaymentInput, v: string) {
    setPayments((old) =>
      old.map((p, i) => (i === index ? { ...p, [key]: v } : p)),
    );
    change();
  }
  function issueControl(issue: (typeof report.issues)[number]) {
    return (
      <div
        className={`exception-message ${issue.requiresFix ? "requires-fix" : ""}`}
        key={issue.key}
      >
        <CircleHelp size={14} />
        <span>{issue.message}</span>
        {issue.blocking && !issue.requiresFix ? (
          <label>
            <input
              type="checkbox"
              checked={checkedIssueKeys.includes(issue.key)}
              onChange={(e) => checkIssue(issue.key, e.target.checked)}
            />
            已对照原图核实此异常
          </label>
        ) : issue.requiresFix ? (
          <b>需修正</b>
        ) : (
          <b>提示</b>
        )}
      </div>
    );
  }
  function itemIssueControls(issues: typeof report.issues) {
    const acknowledgment = issues.filter((i) => i.blocking && !i.requiresFix);
    const allChecked =
      acknowledgment.length > 0 &&
      acknowledgment.every((i) => checkedIssueKeys.includes(i.key));
    return (
      <div className="item-exception-group">
        {issues.map((issue) => (
          <div
            className={`exception-message ${issue.requiresFix ? "requires-fix" : ""}`}
            key={issue.key}
          >
            <CircleHelp size={14} />
            <span>{issue.message}</span>
            {issue.requiresFix && <b>需修正</b>}
          </div>
        ))}
        {acknowledgment.length > 0 && (
          <label
            className={`item-exception-ack ${allChecked ? "acknowledged" : ""}`}
          >
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(e) => {
                const keys = acknowledgment.map((i) => i.key);
                setCheckedIssueKeys((old) =>
                  e.target.checked
                    ? [...new Set([...old, ...keys])]
                    : old.filter((k) => !keys.includes(k)),
                );
                setDirty(true);
                setSummaryConfirmed(false);
              }}
            />
            <span>
              已对照原图核实以上异常
              <small>本项一次确认；项目字段修改后需重新核实</small>
            </span>
          </label>
        )}
      </div>
    );
  }
  async function recognizeAgain() {
    if (busy || ocrRunning.current || !canReRecognize) return;
    if (
      dirty &&
      !confirm(
        "重新识别会覆盖当前未保存的识别字段与异常核对状态。关联会员、原图和记录编号不变。是否继续？",
      )
    )
      return;
    ocrRunning.current = true;
    setOcrBusy(true);
    setOcrCompleted(false);
    setOcrProgress(0);
    setOcrMessage("正在读取已保存原图");
    setLocalError("");
    try {
      const files: File[] = [];
      for (let i = 0; i < uploadIds.length; i++) {
        setOcrMessage(`正在读取原图 ${i + 1}/${uploadIds.length}`);
        const response = await fetch(
          `/api/concierge/uploads/${encodeURIComponent(uploadIds[i]!)}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        if (!response.ok)
          throw new Error(`第${i + 1}张原图读取失败，请稍后重试。`);
        const blob = await response.blob();
        const savedUpload = data.uploads.find((u) => u.id === uploadIds[i]);
        const mime = blob.type || savedUpload?.mime || "";
        if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
          throw new Error("原图格式暂不支持重新识别。");
        files.push(
          new File(
            [blob],
            `receipt-page-${i + 1}.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`,
            { type: mime },
          ),
        );
        setOcrProgress((0.1 * (i + 1)) / uploadIds.length);
      }
      const result = await runReceiptOcr(files, (progress, message) => {
        setOcrProgress(0.1 + 0.9 * Math.min(1, Math.max(0, progress)));
        setOcrMessage(message || "正在重新识别原图");
      });
      setNumber(result.number ?? "");
      setStore(result.store ?? "");
      setOccurredAt(localTime(result.occurredAt));
      setOccurredEdited(true);
      setTotal(result.amount ?? "");
      setRawText(result.rawText);
      setWarnings(result.warnings || []);
      setItemsText(result.itemsText ?? "");
      setItems(applyDraftCatalog(result.items || [], catalogRef.current));
      setItemsTouched(true);
      setTotals({
        subtotal: result.totals?.subtotal ?? "",
        due: result.totals?.due ?? "",
        rounding: result.totals?.rounding ?? "",
        paid: result.totals?.paid ?? "",
      });
      setDetails(
        Object.fromEntries(
          (Object.keys(EMPTY_DETAILS) as Array<keyof ReceiptDetailsInput>).map(
            (k) => [
              k,
              k === "printedAt"
                ? detailTime(result.details?.[k] ?? "")
                : (result.details?.[k] ?? ""),
            ],
          ),
        ) as ReceiptDetailsInput,
      );
      setPayments(
        result.payments?.length
          ? result.payments.map((p) => ({
              method: normalizeMethod(p.method),
              amount: p.amount,
              originalMethod:
                "originalMethod" in p && typeof p.originalMethod === "string"
                  ? p.originalMethod
                  : p.method,
              memberId: "",
            }))
          : [
              {
                method: "其他待核",
                amount: "",
                originalMethod: "",
                memberId: "",
              },
            ],
      );
      setCheckedIssueKeys([]);
      setSummaryConfirmed(false);
      setDirty(true);
      setShowAllItems(false);
      setApprovalIndex(null);
      setOcrCompleted(true);
      setOcrProgress(1);
      setOcrMessage(
        "识别已填入并匹配名称，请处理标红异常，再确认整单。尚未保存。",
      );
    } catch (e) {
      setLocalError(
        e instanceof Error ? e.message : "重新识别未完成，原图与此前内容保留。",
      );
      setOcrMessage("识别未完成，原图与此前内容保留。");
    } finally {
      ocrRunning.current = false;
      setOcrBusy(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || ocrRunning.current) return;
    const mode = (e.nativeEvent as SubmitEvent).submitter?.getAttribute(
      "data-submit-mode",
    );
    const submitStatus: Receipt["status"] =
      mode === "draft"
        ? receipt && ["已确认", "已作废"].includes(receipt.status)
          ? status
          : kind === "退款单"
            ? "待复核"
            : status === "已作废"
              ? "已作废"
              : "待核对"
        : mode === "confirm" && kind === "结算单" && status !== "已作废"
          ? "已确认"
          : status;
    setLocalError("");
    if (submitStatus === "已确认") {
      if (kind !== "结算单") {
        setLocalError("当前仅结算单可以确认；退款等凭证请保存待复核。");
        return;
      }
      if (!(legacyConfirmed && !itemsTouched) && pendingIssues.length) {
        setLocalError(
          `还有${pendingIssues.length}项异常未处理，请修正必改字段，或对照原图核实相应异常。`,
        );
        return;
      }
      if (!summaryConfirmed) {
        setLocalError("请核对会员、总额与必要异常后确认整单。");
        return;
      }
    }
    if (kind === "退款单" && submitStatus !== "待复核") {
      setLocalError("退款凭证只保存待复核，逐支付退款执行尚未启用。");
      return;
    }
    if (submitStatus === "已作废" && (!manager || !reason.trim())) {
      setLocalError("作废需管理员操作并填写原因。");
      return;
    }
    await onSave({
      ...(receipt
        ? { id: receipt.id, version: receipt.version }
        : seed?.receiptId
          ? { id: seed.receiptId, version: seed.version }
          : {}),
      ...(canNative("frontdesk.read") ? { nativeCheckoutId } : {}),
      memberId,
      number: number.trim(),
      store: store.trim(),
      occurredAt: currentOccurredAt || "",
      kind,
      status: submitStatus,
      amount: total.trim(),
      payments: payments
        .filter((p) => p.amount.trim() !== "")
        .map((p) => ({
          ...p,
          amount: p.amount.trim(),
          memberId: p.method === "会员扣卡" ? p.memberId : "",
        })),
      ...(legacyConfirmed && !itemsTouched
        ? {}
        : {
            items: items.map((i) => ({ ...i, ocrName: i.ocrName ?? i.name })),
            review: {
              mode: "exceptions",
              checkedIssueKeys: checkedIssueKeys.filter((k) =>
                currentIssueKeys.has(k),
              ),
              summaryConfirmed,
            },
          }),
      totals,
      details,
      warnings,
      itemsText,
      rawText,
      note,
      uploadIds,
      originalReceiptId: originalId,
      reason,
    });
  }
  return (
    <Dialog
      title={receipt ? "核对本单异常" : "识别草稿 · 只处理异常"}
      subtitle="自动匹配已核准名称，处理标红项，再核对整单。"
      onClose={close}
      wide
      locked={busy || ocrBusy}
    >
      <form onSubmit={submit} onChange={() => setDirty(true)}>
        <div className="modal-content receipt-editor-content exception-editor-content">
          {(error || localError) && (
            <div className="alert alert-error" role="alert">
              {localError || error}
            </div>
          )}
          {restricted && (
            <Notice>
              此凭证已确认或作废。普通员工可查看，更正请由管理员处理。
            </Notice>
          )}
          {duplicate && (
            <Notice warm>
              发现同门店、同单号记录：{duplicate.number}，请核实是否重复。
            </Notice>
          )}
          <div
            className={`exception-overview ${pendingIssues.length ? "has-issues" : "is-clear"}`}
          >
            <div>
              <span>
                {pendingIssues.length ? (
                  <CircleHelp size={23} />
                ) : (
                  <ShieldCheck size={23} />
                )}
              </span>
              <div>
                <strong>
                  {pendingIssues.length
                    ? `${pendingIssues.length}项异常待处理`
                    : "当前没有未处理的必核异常"}
                </strong>
                <p>
                  共{items.length}项明细 · {report.normalItemIndexes.length}
                  项正常 · 无需逐行勾选
                </p>
              </div>
            </div>
            <button
              type="button"
              className="text-btn"
              onClick={() => setEvidenceOpen((v) => !v)}
            >
              <Eye size={15} />
              {evidenceOpen ? "收起原图" : "查看原图"}
            </button>
          </div>
          <details
            className="receipt-evidence-fold"
            open={evidenceOpen}
            onToggle={(e) => setEvidenceOpen(e.currentTarget.open)}
          >
            <summary>
              原始照片与识别原文 <span>{uploadIds.length}张图</span>
            </summary>
            <div className="fold-evidence-grid">
              <EvidenceImages ids={uploadIds} />
              <details className="ocr-text-details">
                <summary>完整识别原文与保留提示</summary>
                <pre>{rawText || "尚无识别原文。"}</pre>
                {warnings.length > 0 && (
                  <ul>
                    {warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </details>
            </div>
          </details>
          {canReRecognize && (
            <section className="receipt-rerun-ocr compact-rerun">
              <button
                type="button"
                className="text-btn"
                disabled={busy || ocrBusy}
                onClick={() => void recognizeAgain()}
              >
                <RefreshCw size={14} className={ocrBusy ? "spin" : ""} />
                {ocrBusy ? "正在重新识别…" : "识别不完整？重新识别本单原图"}
              </button>
              {(ocrBusy || ocrCompleted) && (
                <div className="ocr-progress" aria-live="polite">
                  <div>
                    <span>{ocrMessage}</span>
                    <strong>{Math.round(ocrProgress * 100)}%</strong>
                  </div>
                  <progress max={1} value={ocrProgress} />
                  <small>不会另建消费单；结果仍需核对后保存。</small>
                </div>
              )}
            </section>
          )}
          <fieldset
            className="exception-main-fieldset"
            disabled={restricted || busy || ocrBusy}
          >
            <section className="receipt-whole-summary">
              <h3>核对整单</h3>
              <div className="form-grid">
                <Field label="关联接待会员">
                  <select
                    value={memberId}
                    onChange={(e) => {
                      setMemberId(e.target.value);
                      change();
                    }}
                  >
                    <option value="">待核实会员</option>
                    {data.members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.code} · {m.name}
                        {m.cardNo ? ` · 卡${m.cardNo}` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="实际结算金额（元）">
                  <div className="amount-input">
                    <span>¥</span>
                    <input
                      value={total}
                      onChange={(e) => {
                        setTotal(e.target.value);
                        change();
                      }}
                      inputMode="decimal"
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                      placeholder="按票面实付核对"
                    />
                  </div>
                </Field>
              </div>
              <div className="receipt-summary-line">
                <span>
                  {store || "门店待核"} · {number || "单号待核"}
                </span>
                <span>{occurredAt ? date(currentOccurredAt) : "时间待核"}</span>
              </div>
            </section>
            {generalIssues.length > 0 && (
              <section className="general-review-issues">
                <h3>整单异常</h3>
                {generalIssues.map(issueControl)}
              </section>
            )}
            <details
              className="receipt-header-fold"
              open={headerIssue || showMetadata}
              onToggle={(e) => {
                if (!headerIssue) setShowMetadata(e.currentTarget.open);
              }}
            >
              <summary>
                票头、单号与详细信息{" "}
                <span>{headerIssue ? "需补充" : "可展开核对"}</span>
              </summary>
              <div className="form-grid">
                <Field label="门店">
                  <input
                    value={store}
                    onChange={(e) => {
                      setStore(e.target.value);
                      change();
                    }}
                    maxLength={100}
                  />
                </Field>
                <Field label="收银单号">
                  <input
                    value={number}
                    onChange={(e) => {
                      setNumber(e.target.value);
                      change();
                    }}
                    maxLength={100}
                  />
                </Field>
                <Field label="发生时间（中国时间）" wide>
                  <input
                    type="datetime-local"
                    step={1}
                    value={occurredAt}
                    onChange={(e) => {
                      setOccurredAt(e.target.value);
                      setOccurredEdited(true);
                      change();
                    }}
                  />
                </Field>
                <Field label="凭证类型">
                  <select
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value as Receipt["kind"]);
                      if (e.target.value === "退款单") setStatus("待复核");
                      change();
                    }}
                  >
                    {["结算单", "消费清单", "退款单", "作废单"].map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </Field>
                <Field label="业务状态">
                  <select
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value as Receipt["status"]);
                      change();
                    }}
                  >
                    {[
                      "待核对",
                      "待补全",
                      "待复核",
                      "已确认",
                      ...(manager && receipt ? ["已作废"] : []),
                    ].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </Field>
                {(
                  Object.keys(DETAILS_LABELS) as Array<
                    keyof ReceiptDetailsInput
                  >
                ).map((key) => (
                  <Field
                    key={key}
                    label={DETAILS_LABELS[key]}
                    wide={key === "coupons" || key === "wristbands"}
                  >
                    <input
                      value={details[key]}
                      onChange={(e) => {
                        setDetails((d) => ({ ...d, [key]: e.target.value }));
                        change();
                      }}
                      maxLength={key === "coupons" ? 1000 : 200}
                      placeholder="票面未显示请留空"
                    />
                  </Field>
                ))}
              </div>
            </details>
            <section className="exception-items-section">
              <div className="exception-section-heading">
                <div>
                  <h3>{showAllItems ? "全部项目明细" : "需要处理的项目"}</h3>
                  <span>
                    {showAllItems ? items.length : itemIssueIndexes.size}项
                  </span>
                </div>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => setShowAllItems((v) => !v)}
                >
                  {showAllItems ? "只看异常" : `展开全部${items.length}项`}
                  <ChevronRight size={14} />
                </button>
              </div>
              {!catalog.length && (
                <div className="catalog-first-calibration">
                  <ShieldCheck size={18} />
                  <span>
                    {manager
                      ? "名称库尚未校准。首次请对照原图核准常用名称；后续唯一别名即可自动带入。"
                      : "名称库尚未校准，可先对照原图核实本单原名；经理核准常用名称后，下次自动匹配。"}
                  </span>
                </div>
              )}
              <div className="receipt-item-editor exception-item-editor">
                {visibleItems.map(({ item, index }) => {
                  const issues = report.issues.filter(
                    (i) => i.itemIndex === index,
                  );
                  const match = matchCatalogName(item.name, catalog);
                  const selected =
                    match.status === "matched" ? match.item : undefined;
                  const candidates = match.candidates
                    .filter((c) => c.active)
                    .slice(0, 4);
                  return (
                    <article
                      className={`receipt-item-row ${issues.some((i) => i.requiresFix || (i.blocking && !checkedIssueKeys.includes(i.key))) ? "has-exception" : issues.length ? "exception-reviewed" : "normal-item"}`}
                      key={index}
                    >
                      <div className="receipt-item-row-top">
                        <strong>项目 {index + 1}</strong>
                        <span
                          className={`item-match-state ${selected ? "matched" : "unknown"}`}
                        >
                          {selected
                            ? "已核准名称"
                            : match.status === "ambiguous"
                              ? "名称有歧义"
                              : "名称待校准"}
                        </span>
                        <button
                          type="button"
                          className="text-btn danger-text"
                          onClick={() => {
                            setItemsTouched(true);
                            setItems((v) => v.filter((_, i) => i !== index));
                            setApprovalIndex(null);
                            change();
                          }}
                        >
                          删除
                        </button>
                      </div>
                      <div className="receipt-item-grid">
                        <Field label="项目名称" wide>
                          <input
                            value={item.name}
                            onChange={(e) =>
                              updateItem(index, "name", e.target.value)
                            }
                            maxLength={300}
                          />
                        </Field>
                        <Field label="数量">
                          <input
                            value={item.quantity}
                            onChange={(e) =>
                              updateItem(index, "quantity", e.target.value)
                            }
                            maxLength={80}
                          />
                        </Field>
                        <Field label="项目金额（元）">
                          <input
                            value={item.amount}
                            onChange={(e) =>
                              updateItem(index, "amount", e.target.value)
                            }
                            inputMode="decimal"
                            pattern="[0-9]+(\.[0-9]{1,2})?"
                            placeholder={
                              item.packageIncluded
                                ? "套餐内未单独标价"
                                : "未知留空，需核对"
                            }
                          />
                        </Field>
                      </div>
                      <p className="item-ocr-name">
                        识别原名：{item.ocrName || item.name || "未识别"}
                        {selected?.spec && (
                          <span>核准规格：{selected.spec}</span>
                        )}
                      </p>
                      {candidates.length > 0 && !selected && (
                        <div className="catalog-candidates">
                          <span>
                            {match.status === "ambiguous"
                              ? "多个核准项目符合，请选择："
                              : "可能的核准项目，需你选择："}
                          </span>
                          {candidates.map((c) => (
                            <button
                              type="button"
                              key={c.id}
                              onClick={() => chooseCatalog(index, c)}
                            >
                              {c.name}
                              {c.spec && <small>{c.spec}</small>}
                              <Check size={12} />
                            </button>
                          ))}
                        </div>
                      )}
                      <label className="package-included-toggle">
                        <input
                          type="checkbox"
                          checked={!!item.packageIncluded}
                          onChange={(e) =>
                            updateItem(
                              index,
                              "packageIncluded",
                              e.target.checked,
                            )
                          }
                        />
                        <span>
                          套餐内未单独标价<small>金额保持空白，不补成0</small>
                        </span>
                      </label>
                      {itemIssueControls(issues)}
                      <details className="item-raw-text">
                        <summary>单价与此项原文</summary>
                        <Field label="单价（元，票面没有可留空）">
                          <input
                            value={item.unitPrice}
                            onChange={(e) =>
                              updateItem(index, "unitPrice", e.target.value)
                            }
                            inputMode="decimal"
                            pattern="[0-9]+(\.[0-9]{1,2})?"
                          />
                        </Field>
                        <p>{item.rawText || "此项目没有独立识别原文。"}</p>
                      </details>
                      {manager && (
                        <button
                          type="button"
                          className="text-btn catalog-approve-trigger"
                          onClick={() =>
                            setApprovalIndex(
                              approvalIndex === index ? null : index,
                            )
                          }
                        >
                          <ShieldCheck size={14} />
                          核准并记住名称
                        </button>
                      )}
                      {manager && approvalIndex === index && (
                        <CatalogApprovalPanel
                          key={`${index}-${selected?.id || "new"}`}
                          ocrName={item.ocrName || item.name}
                          initialName={item.name}
                          packageIncluded={!!item.packageIncluded}
                          existing={selected}
                          onSave={onSaveCatalog}
                          onCancel={() => setApprovalIndex(null)}
                          onApplied={(approved, fresh) => {
                            setItemsTouched(true);
                            setItems((old) =>
                              applyDraftCatalog(old, fresh).map((row, i) =>
                                i === index
                                  ? {
                                      ...row,
                                      name: catalogDisplayName(approved),
                                      catalogItemId: approved.id,
                                      packageIncluded: approved.packageIncluded,
                                    }
                                  : row,
                              ),
                            );
                            setApprovalIndex(null);
                            change();
                          }}
                        />
                      )}
                    </article>
                  );
                })}
              </div>
              {!visibleItems.length && (
                <div className="normal-items-collapsed">
                  <ShieldCheck size={24} />
                  <strong>
                    {items.length
                      ? `${items.length}项明细已匹配，正常项目已折叠`
                      : "尚无结构化项目"}
                  </strong>
                  <p>
                    {items.length
                      ? "无需逐项勾选，可展开查看全部明细及原识别名。"
                      : "请重新识别或保存待补全，不从整单金额补造项目。"}
                  </p>
                </div>
              )}
              <div className="items-controls">
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => {
                    setItemsTouched(true);
                    setItems((old) => [
                      ...old,
                      {
                        name: "",
                        ocrName: "",
                        quantity: "",
                        unitPrice: "",
                        amount: "",
                        rawText: "",
                        catalogItemId: "",
                        packageIncluded: false,
                      },
                    ]);
                    setShowAllItems(true);
                    change();
                  }}
                >
                  <Plus size={14} />
                  手工补一项
                </button>
                <span>
                  已记录项目合计 ¥{money(knownItemTotal)} · 与实付分别保存
                </span>
              </div>
            </section>
            {canNative("frontdesk.read") && (
              <Field label="关联企业结账编号（可选）">
                <input
                  type="number"
                  min="1"
                  value={nativeCheckoutId}
                  onChange={(e) => {
                    setNativeCheckoutId(e.target.value);
                    change();
                  }}
                />
                <small>只关联同一企业会员的结账；不会再次收款或扣余额。</small>
              </Field>
            )}
            <details
              className="payment-review-fold"
              open={paymentIssue || paymentOpen}
              onToggle={(e) => {
                if (!paymentIssue) setPaymentOpen(e.currentTarget.open);
              }}
            >
              <summary>
                支付分录与票面合计 <span>分录合计 ¥{money(paymentTotal)}</span>
              </summary>
              <div className="payment-inputs">
                {payments.map((p, i) => (
                  <div className="payment-input-row" key={i}>
                    <div className="payment-row-top">
                      <span>支付分录 {i + 1}</span>
                      {payments.length > 1 && (
                        <button
                          type="button"
                          className="text-btn danger-text"
                          onClick={() => {
                            setPayments((v) => v.filter((_, n) => n !== i));
                            change();
                          }}
                        >
                          移除
                        </button>
                      )}
                    </div>
                    <div className="payment-row-grid">
                      <select
                        aria-label={`支付分录${i + 1}方式`}
                        value={p.method}
                        onChange={(e) =>
                          updatePayment(i, "method", e.target.value)
                        }
                      >
                        {METHOD_OPTIONS.map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                      <input
                        aria-label={`支付分录${i + 1}金额`}
                        value={p.amount}
                        onChange={(e) =>
                          updatePayment(i, "amount", e.target.value)
                        }
                        inputMode="decimal"
                        pattern="[0-9]+(\.[0-9]{1,2})?"
                        placeholder="金额（元）"
                      />
                    </div>
                    <Field label="票面支付原文">
                      <input
                        value={p.originalMethod || ""}
                        onChange={(e) =>
                          updatePayment(i, "originalMethod", e.target.value)
                        }
                        maxLength={200}
                      />
                    </Field>
                    {p.method === "会员扣卡" && (
                      <select
                        className="payment-member"
                        value={p.memberId}
                        onChange={(e) =>
                          updatePayment(i, "memberId", e.target.value)
                        }
                        aria-label={`支付分录${i + 1}实际扣卡会员`}
                      >
                        <option value="">选择实际扣卡会员</option>
                        {data.members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.code} · {m.name}
                            {m.cardNo ? ` · 卡${m.cardNo}` : ""}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  setPayments((v) => [
                    ...v,
                    {
                      method: "其他待核",
                      amount: "",
                      memberId: "",
                      originalMethod: "",
                    },
                  ]);
                  change();
                }}
              >
                <Plus size={14} />
                增加组合支付
              </button>
              <div className="form-grid totals-review-grid">
                {(
                  [
                    ["subtotal", "票面小计（元）"],
                    ["due", "票面应付（元）"],
                    ["rounding", "票面抹零 / 舍入（元）"],
                    ["paid", "票面支付合计（元）"],
                  ] as const
                ).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <input
                      value={totals[key]}
                      onChange={(e) => {
                        setTotals((t) => ({ ...t, [key]: e.target.value }));
                        change();
                      }}
                      inputMode="decimal"
                      placeholder="票面未显示请留空"
                    />
                  </Field>
                ))}
              </div>
            </details>
            <details className="optional-fields">
              <summary>补充说明、关联原单与项目原文</summary>
              <Field label="业务说明">
                <textarea
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    change();
                  }}
                  rows={3}
                  maxLength={2000}
                />
              </Field>
              <Field label="识别项目原文">
                <textarea
                  value={itemsText}
                  onChange={(e) => {
                    setItemsText(e.target.value);
                    change();
                  }}
                  rows={4}
                  maxLength={60000}
                />
              </Field>
              {["退款单", "作废单"].includes(kind) && (
                <Field label="关联原消费单">
                  <select
                    value={originalId}
                    onChange={(e) => {
                      setOriginalId(e.target.value);
                      change();
                    }}
                  >
                    <option value="">选择原单</option>
                    {data.receipts
                      .filter(
                        (r) => r.id !== receipt?.id && r.kind === "结算单",
                      )
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.number || r.id} · {displayMoney(r.amountCents)}
                        </option>
                      ))}
                  </select>
                </Field>
              )}
            </details>
            {(receipt || seed?.receiptId) && (
              <Field label="本次更正 / 作废原因">
                <input
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    change();
                  }}
                  maxLength={1000}
                  placeholder="已确认记录更正或作废时必填"
                />
              </Field>
            )}
          </fieldset>
          {kind === "退款单" && (
            <Notice warm>退款仅保存待复核凭证，不执行自动退款或改余额。</Notice>
          )}
          {!restricted && (
            <label className="receipt-confirm-check whole-receipt-confirm">
              <input
                type="checkbox"
                checked={summaryConfirmed}
                disabled={busy || ocrBusy}
                onChange={(e) => {
                  setSummaryConfirmed(e.target.checked);
                  setDirty(true);
                }}
              />
              <span>
                {legacyConfirmed && !itemsTouched
                  ? "我已核实本次更正内容，历史明细保持原记录。"
                  : "我已核对本单会员、实付总额和必要异常，确认整单记录。"}
                <small>字段修改后，旧的异常核对与整单确认会失效。</small>
              </span>
            </label>
          )}
          <Notice>
            名称库不含价格，金额只按本张票面核对；确认消费不改变余额。
          </Notice>
          {receipt && (
            <p className="form-history">
              登记：{receipt.createdByName} · {date(receipt.createdAt)}
              {receipt.confirmedByName
                ? `\n确认：${receipt.confirmedByName} · ${date(receipt.confirmedAt)}`
                : ""}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <span className="muted small">
            {pendingIssues.length
              ? `${pendingIssues.length}项异常待处理`
              : "正常项无需逐行确认"}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || ocrBusy}
            onClick={close}
          >
            关闭
          </button>
          {!restricted && (
            <>
              <button
                type="submit"
                data-submit-mode="draft"
                className="btn btn-secondary"
                disabled={busy || ocrBusy}
              >
                {receipt && ["已确认", "已作废"].includes(receipt.status)
                  ? "保存调整"
                  : "保存草稿"}
              </button>
              <button
                type="submit"
                data-submit-mode="confirm"
                className="btn btn-primary"
                disabled={busy || ocrBusy}
              >
                {busy || ocrBusy ? (
                  <RefreshCw size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}{" "}
                {ocrBusy
                  ? "等待重新识别"
                  : busy
                    ? "正在保存…"
                    : status === "已作废"
                      ? "保存作废状态"
                      : kind === "退款单"
                        ? "保存待复核"
                        : "确认整单"}
              </button>
            </>
          )}
        </div>
      </form>
    </Dialog>
  );
}

export function ReceiptDetail({
  receipt,
  data,
  onClose,
  onEdit,
}: {
  receipt: Receipt;
  data: WorkspaceData;
  onClose: () => void;
  onEdit: () => void;
}) {
  const memberName = (id: string) =>
    data.members.find((m) => m.id === id)?.name || "未匹配会员";
  const manager = data.user.role === "manager";
  const canEdit = manager || !["已确认", "已作废"].includes(receipt.status);
  const totals = receipt.totals;
  const knownItems = (receipt.items || []).filter(
    (i) => i.amountCents !== null,
  );
  return (
    <Dialog
      title="消费明细与原始凭证"
      subtitle={`${receipt.number || "单号待核"} · ${receipt.store || "门店待核"}`}
      onClose={onClose}
      wide
    >
      <div className="modal-content receipt-editor-content">
        <div className="receipt-detail-banner">
          <div>
            <span>实际结算金额</span>
            <strong>
              {receipt.amountCents == null
                ? "金额待核"
                : `¥ ${money(receipt.amountCents)}`}
            </strong>
            <p>
              {memberName(receipt.memberId)} · {receipt.kind} ·{" "}
              {date(receipt.occurredAt)}
            </p>
          </div>
          <Status value={receipt.status} />
        </div>
        <div className="receipt-review-grid detailed-review-grid">
          <div className="receipt-left-column">
            <EvidenceImages ids={receipt.uploadIds || []} />
            <details className="ocr-text-details">
              <summary>查看完整识别原文</summary>
              <pre>{receipt.rawText || "此记录没有识别原文。"}</pre>
            </details>
          </div>
          <section className="receipt-detail-fields">
            <h3 className="detail-section-title">
              逐项消费明细{" "}
              <span className="count-tag">{receipt.items?.length || 0}项</span>
            </h3>
            {receipt.items?.length ? (
              <>
                <div className="receipt-detail-items">
                  {receipt.items.map((item, i) => (
                    <article className="receipt-detail-item" key={i}>
                      <div className="receipt-detail-item-name">
                        <span>{i + 1}</span>
                        <strong>{item.name || "项目名称待核"}</strong>
                        <b
                          className={item.amountCents === 0 ? "zero-price" : ""}
                        >
                          {item.amountCents == null
                            ? "金额未明确"
                            : `¥ ${money(item.amountCents)}`}
                        </b>
                      </div>
                      <div className="receipt-detail-item-meta">
                        <span>数量：{item.quantity || "票面未明确"}</span>
                        {item.packageIncluded && <em>套餐内未单独标价</em>}
                        <span>单价：{displayMoney(item.unitPriceCents)}</span>
                        {item.amountCents === 0 && <em>0元项目</em>}
                      </div>
                      {item.ocrName && item.ocrName !== item.name && (
                        <p className="item-ocr-name">
                          识别原名：{item.ocrName}
                        </p>
                      )}
                      {item.rawText && (
                        <details className="item-raw-text">
                          <summary>项目原文</summary>
                          <p>{item.rawText}</p>
                        </details>
                      )}
                    </article>
                  ))}
                </div>
                <div className="item-detail-summary">
                  <span>已记录项目金额合计</span>
                  <strong>
                    ¥{" "}
                    {money(
                      knownItems.reduce((n, i) => n + (i.amountCents ?? 0), 0),
                    )}
                  </strong>
                  {knownItems.length !== receipt.items.length && (
                    <small>
                      另有{receipt.items.length - knownItems.length}项金额未明确
                    </small>
                  )}
                </div>
                <p className="items-help">
                  项目合计与实际支付分别展示，优惠、抹零等可能使两者不同。
                </p>
              </>
            ) : (
              <div className="legacy-items-empty">
                <FileText size={24} />
                <h4>此记录尚无逐项结构化明细</h4>
                <p>
                  旧记录未保存的项目不会根据结算金额补造。可查看原图与原文，按权限补录后保留更正记录。
                </p>
                {receipt.itemsText && <pre>{receipt.itemsText}</pre>}
              </div>
            )}
            <h3 className="detail-section-title receipt-detail-section">
              票面金额口径
            </h3>
            <dl className="receipt-totals-list">
              {[
                ["票面小计", totals?.subtotalCents],
                ["票面应付", totals?.dueCents],
                ["票面抹零 / 舍入", totals?.roundingCents],
                ["票面支付合计", totals?.paidCents],
                ["实际结算金额", receipt.amountCents],
              ].map(([label, n]) => (
                <div key={String(label)}>
                  <dt>{label}</dt>
                  <dd>{displayMoney(n as number | null | undefined)}</dd>
                </div>
              ))}
            </dl>
            <h3 className="detail-section-title receipt-detail-section">
              实际支付分录
            </h3>
            {receipt.payments.length ? (
              <div className="receipt-payment-details">
                {receipt.payments.map((p, i) => (
                  <article key={i}>
                    <div>
                      <strong>{p.method}</strong>
                      <b>¥ {money(p.amountCents)}</b>
                    </div>
                    <p>票面支付原文：{p.originalMethod || "未单独保存"}</p>
                    {p.method === "会员扣卡" && (
                      <p>
                        实际扣卡会员：
                        {p.memberId ? memberName(p.memberId) : "待核实"}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <p className="items-help">尚无已核实支付分录。</p>
            )}
            <h3 className="detail-section-title receipt-detail-section">
              票头与打印信息
            </h3>
            <dl className="detail-grid receipt-header-details">
              {(
                Object.keys(DETAILS_LABELS) as Array<keyof ReceiptDetailsInput>
              ).map((key) => (
                <div key={key}>
                  <dt>{DETAILS_LABELS[key]}</dt>
                  <dd>
                    {receipt.details?.[key]
                      ? key === "printedAt"
                        ? detailTime(receipt.details[key]).replace("T", " ")
                        : receipt.details[key]
                      : "票面未明确 / 未记录"}
                  </dd>
                </div>
              ))}
            </dl>
            {!!receipt.warnings?.length && (
              <section className="ocr-warning-box">
                <h3>
                  <CircleHelp size={16} />
                  保留的识别提示
                </h3>
                <ul>
                  {receipt.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </section>
            )}
            {receipt.note && (
              <>
                <h3 className="detail-section-title receipt-detail-section">
                  业务说明
                </h3>
                <div className="preferences-box">{receipt.note}</div>
              </>
            )}
            <dl className="detail-grid receipt-audit-info">
              <div>
                <dt>上传 / 登记人</dt>
                <dd>{receipt.createdByName}</dd>
              </div>
              <div>
                <dt>登记时间</dt>
                <dd>{date(receipt.createdAt)}</dd>
              </div>
              <div>
                <dt>核对确认人</dt>
                <dd>{receipt.confirmedByName || "尚未确认"}</dd>
              </div>
              <div>
                <dt>确认时间</dt>
                <dd>
                  {receipt.confirmedAt ? date(receipt.confirmedAt) : "尚未确认"}
                </dd>
              </div>
              <div>
                <dt>核对方式</dt>
                <dd>
                  {receipt.review?.mode === "exceptions"
                    ? receipt.review.summaryConfirmed
                      ? "已核实必要异常并确认整单"
                      : "异常核对草稿，未确认整单"
                    : receipt.itemsReviewed
                      ? "已逐项对照原图"
                      : "旧记录未保存核对方式"}
                </dd>
              </div>
            </dl>
            <Notice>
              此处查看消费凭证，不进行扣款。消费记录与余额快照分别保留，不根据时间或金额自动关联。
            </Notice>
          </section>
        </div>
      </div>
      <div className="modal-footer">
        <span className="muted small">只读详情，编辑需单独进入核对页</span>
        <button className="btn btn-secondary" onClick={onClose}>
          关闭
        </button>
        {canEdit && (
          <button className="btn btn-primary" onClick={onEdit}>
            <Pencil size={15} />
            编辑 / 核对
          </button>
        )}
      </div>
    </Dialog>
  );
}

async function prepareEvidence(files: File[]): Promise<File[]> {
  const result: File[] = [];
  for (const f of files) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type))
      throw new Error("支持JPEG、PNG、WebP；HEIC请转换后选择。");
    if (f.size <= 4 * 1024 * 1024) {
      result.push(f);
      continue;
    }
    const url = URL.createObjectURL(f);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const scale = Math.min(1, 2400 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器无法处理图片，请改用较小JPEG。");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!blob || blob.size > 4 * 1024 * 1024)
        throw new Error("单张图片仍超过4MB，请分段拍摄。");
      result.push(
        new File([blob], `${f.name.replace(/\.[^.]+$/, "")}.jpg`, {
          type: "image/jpeg",
        }),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (result.reduce((n, f) => n + f.size, 0) > 12 * 1024 * 1024)
    throw new Error("每次上传总量不能超过12MB。");
  return result;
}

export function BalanceEvidencePicker({
  memberId,
  receipts,
  onUploading,
  onDirty,
  existingUploadIds = [],
  existingReceiptIds = [],
}: {
  memberId: string;
  receipts: Receipt[];
  onUploading?: (working: boolean) => void;
  onDirty?: () => void;
  existingUploadIds?: string[];
  existingReceiptIds?: string[];
}) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const candidates = receipts.filter(
    (r) =>
      (r.memberId === memberId ||
        r.payments.some((p) => p.memberId === memberId)) &&
      (!search || `${r.number} ${r.store}`.includes(search)),
  );
  async function upload(files: FileList | null) {
    if (!files?.length || working) return;
    if (files.length > 4) {
      setError("每次最多上传4张图片。");
      return;
    }
    setWorking(true);
    onUploading?.(true);
    setError("");
    try {
      const prepared = await prepareEvidence(Array.from(files));
      const fd = new FormData();
      prepared.forEach((f) => fd.append("files", f));
      fd.append("memberId", memberId);
      const response = await fetch("/api/concierge/uploads", {
        method: "POST",
        body: fd,
      });
      const body = (await response.json()) as {
        uploads?: Upload[];
        error?: string;
      };
      if (!response.ok || !body.uploads?.length)
        throw new Error(body.error || "图片上传失败。");
      setUploads((old) => {
        const combined = [...old, ...body.uploads!];
        return combined.filter(
          (u, i) =>
            combined.findIndex((v) => v.id === u.id) === i &&
            !existingUploadIds.includes(u.id),
        );
      });
      onDirty?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败，请重试。");
    } finally {
      setWorking(false);
      onUploading?.(false);
    }
  }
  return (
    <div className="balance-evidence-picker">
      <div className="receipt-section-title">
        <span>
          <Camera size={14} />
        </span>
        <h3>核对依据与手工关联</h3>
      </div>
      <p className="items-help">
        可附收银余额照片，并手工选择已登记消费单。不会按时间、金额或当前会员自动关联。
      </p>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="evidence-pick-actions">
        <label className="btn btn-secondary small-btn">
          <Camera size={15} />
          拍摄余额依据
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            disabled={working}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <label className="btn btn-secondary small-btn">
          <ImagePlus size={15} />
          选择图片
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={working}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        {working && (
          <span className="evidence-uploading">
            <RefreshCw size={14} className="spin" />
            正在上传，完成后可保存
          </span>
        )}
      </div>
      {uploads.length > 0 && (
        <div className="new-evidence-images">
          {uploads.map((u) => (
            <div key={u.id}>
              <img
                src={`/api/concierge/uploads/${u.id}`}
                alt="新上传余额核对依据"
              />
              <button
                type="button"
                aria-label="移除此次新增附件"
                onClick={() => {
                  setUploads((v) => v.filter((x) => x.id !== u.id));
                  onDirty?.();
                }}
              >
                <X size={14} />
              </button>
              <input type="hidden" name="uploadIds" value={u.id} />
            </div>
          ))}
        </div>
      )}
      <label className="search-field receipt-link-search">
        <FileText size={15} />
        <input
          aria-label="筛选可关联消费单"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="按单号或门店查找该会员相关记录"
        />
      </label>
      <div className="receipt-link-selection-count">
        已手工选择 {selected.length} 条消费记录；筛选不清除已选项。
      </div>
      {selected.map((id) => (
        <input key={id} type="hidden" name="receiptIds" value={id} />
      ))}
      <div className="receipt-link-options">
        {candidates.length ? (
          candidates.map((r) => {
            const existing = existingReceiptIds.includes(r.id);
            return (
              <label
                className={`receipt-link-option ${existing ? "already-linked" : ""}`}
                key={r.id}
              >
                <input
                  type="checkbox"
                  value={r.id}
                  checked={existing || selected.includes(r.id)}
                  disabled={existing}
                  onChange={(e) => {
                    setSelected((old) =>
                      e.target.checked
                        ? [...old, r.id]
                        : old.filter((id) => id !== r.id),
                    );
                    onDirty?.();
                  }}
                />
                <span>
                  <strong>
                    {r.number || "单号待核"}
                    <em>{r.status}</em>
                    {existing && <b>已关联</b>}
                  </strong>
                  <small>
                    {r.store || "门店待核"} · {date(r.occurredAt)} ·{" "}
                    {r.amountCents == null
                      ? "金额未知"
                      : `¥ ${money(r.amountCents)}`}
                  </small>
                </span>
              </label>
            );
          })
        ) : (
          <p className="items-help">
            没有符合条件的消费记录。可以只附照片，不需要补造消费单。
          </p>
        )}
      </div>
      <Notice>
        选择关联只补充核对依据，不从消费金额推算余额，也不改变原消费记录。
      </Notice>
    </div>
  );
}

export function BalanceDetail({
  balance,
  member,
  receipts,
  busy,
  error,
  onClose,
  onReceipt,
  onAttach,
}: {
  balance: Balance;
  member?: Member;
  receipts: Receipt[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onReceipt: (receipt: Receipt) => void;
  onAttach: (
    payload: Record<string, unknown>,
    requestId: string,
  ) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState("");
  const request = useRef("");
  const uploadIds = balance.uploadIds || [];
  const receiptIds = balance.receiptIds || [];
  function close() {
    if (busy || uploading) return;
    if (dirty && !confirm("新增依据尚未保存，确定关闭吗？")) return;
    onClose();
  }
  function openReceipt(r: Receipt) {
    if (busy || uploading) return;
    if (
      dirty &&
      !confirm(
        "新增依据尚未保存，查看消费凭证会放弃本次未保存追加。确定继续吗？",
      )
    )
      return;
    onReceipt(r);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (uploading || busy) return;
    const fd = new FormData(e.currentTarget);
    const uploaded = fd.getAll("uploadIds").map(String);
    const selected = fd.getAll("receiptIds").map(String);
    if (!uploaded.length && !selected.length) {
      setLocalError("请至少添加一张依据照片，或手工勾选一条相关消费记录。");
      return;
    }
    request.current ||= uid();
    if (
      await onAttach(
        {
          balanceId: balance.id,
          uploadIds: uploaded,
          receiptIds: selected,
          reason: String(fd.get("reason") || "").trim(),
        },
        request.current,
      )
    ) {
      setAdding(false);
      setDirty(false);
      request.current = "";
      setLocalError("");
    }
  }
  return (
    <Dialog
      title="余额核对记录与凭证"
      subtitle={`${member?.code || ""} ${member?.name || "关联会员"} · 历史核对记录`}
      onClose={close}
      wide
    >
      <div className="modal-content balance-detail-content">
        <div className="receipt-detail-banner balance-detail-banner">
          <div>
            <span>本次收银核实余额快照</span>
            <strong>¥ {money(balance.amountCents)}</strong>
            <p>核对发生时间：{date(balance.checkedAt)}</p>
          </div>
          <Wallet size={29} />
        </div>
        <Notice>
          这是某一时点的余额快照，不是一笔消费或充值。系统不会根据时间、余额差异自动扣款或关联消费。
        </Notice>
        <div className="balance-evidence-grid">
          <EvidenceImages ids={uploadIds} title="余额核对依据照片" compact />
          <section>
            <dl className="detail-grid">
              <div>
                <dt>核对操作人</dt>
                <dd>{balance.actorName}</dd>
              </div>
              <div>
                <dt>系统登记时间</dt>
                <dd>{date(balance.createdAt)}</dd>
              </div>
              <div>
                <dt>核对来源</dt>
                <dd>{balance.source || "未填写"}</dd>
              </div>
              <div>
                <dt>历史记录编号</dt>
                <dd>{balance.id}</dd>
              </div>
            </dl>
            <h3 className="detail-section-title">当时填写的核对依据</h3>
            <div className="preferences-box">
              {balance.note || "此记录未填写说明。"}
            </div>
            <h3 className="detail-section-title">
              人工关联的消费凭证{" "}
              <span className="count-tag">{receiptIds.length}单</span>
            </h3>
            {receiptIds.length ? (
              <div className="linked-receipts">
                {receiptIds.map((id) => {
                  const r = receipts.find((x) => x.id === id);
                  return r ? (
                    <button
                      key={id}
                      className="linked-receipt"
                      disabled={busy || uploading}
                      onClick={() => openReceipt(r)}
                    >
                      <FileText size={19} />
                      <span>
                        <strong>{r.number || "单号待核"}</strong>
                        <small>
                          {r.kind} · {r.status} · {date(r.occurredAt)}
                        </small>
                      </span>
                      <b>{displayMoney(r.amountCents)}</b>
                      <ChevronRight size={15} />
                    </button>
                  ) : (
                    <div className="linked-record-missing" key={id}>
                      关联记录暂未载入：{id}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="unlinked-balance">
                <FileText size={25} />
                <strong>这条历史余额尚未关联消费凭证</strong>
                <p>
                  已有金额和说明保留，可手工追加依据；不会自动把最近的消费单附到这里。
                </p>
              </div>
            )}
            <button
              className="btn btn-secondary full-width"
              onClick={() => {
                if (
                  adding &&
                  dirty &&
                  !confirm("新增依据尚未保存，确定收起吗？")
                )
                  return;
                setAdding((v) => !v);
                setDirty(false);
                setLocalError("");
                request.current = "";
              }}
              disabled={busy || uploading}
            >
              <Plus size={15} />
              {adding ? "收起追加依据" : "追加照片 / 手工关联消费单"}
            </button>
          </section>
        </div>
        {adding && (
          <form className="append-evidence-form" onSubmit={submit}>
            {(error || localError) && (
              <div className="alert alert-error" role="alert">
                {localError || error}
              </div>
            )}
            <BalanceEvidencePicker
              memberId={balance.memberId}
              receipts={receipts}
              onUploading={setUploading}
              onDirty={() => setDirty(true)}
              existingUploadIds={uploadIds}
              existingReceiptIds={receiptIds}
            />
            <Field label="本次追加依据说明">
              <input
                name="reason"
                maxLength={1000}
                placeholder="例如：补充当时收银查询照片、人工核实关联原单"
                onChange={() => setDirty(true)}
              />
            </Field>
            <div className="append-evidence-actions">
              <small>只追加依据，不改金额、原核对人或核对时间。</small>
              <button className="btn btn-primary" disabled={busy || uploading}>
                {busy || uploading ? (
                  <RefreshCw size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}{" "}
                {busy
                  ? "正在保存…"
                  : uploading
                    ? "等待图片上传"
                    : "保存追加依据"}
              </button>
            </div>
          </form>
        )}
      </div>
      <div className="modal-footer">
        <span className="muted small">原始快照与追加操作均保留追溯</span>
        <button
          className="btn btn-secondary"
          disabled={busy || uploading}
          onClick={close}
        >
          关闭
        </button>
      </div>
    </Dialog>
  );
}
