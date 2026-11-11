import type {
  ReceiptItem,
  ReceiptTotals,
  ReceiptDetails,
  ReceiptReview,
} from "@shared/concierge/types";
import { normalizeReceiptPaymentMethod } from "@shared/concierge/receipt-review";
export class WorkspaceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const time = () => new Date().toISOString();
export function text(v: unknown, max = 200, required = false): string {
  if (v !== undefined && v !== null && typeof v !== "string")
    throw new WorkspaceError("输入格式不正确");
  const s = String(v ?? "").trim();
  if (s.length > max) throw new WorkspaceError(`文字不能超过${max}字`);
  if (required && !s) throw new WorkspaceError("请填写必填信息");
  return s;
}
export function amountCents(v: unknown) {
  const s = text(v, 16, true);
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s))
    throw new WorkspaceError("金额请输入非负数，最多两位小数");
  const [a, b = ""] = s.split(".");
  return Number(a) * 100 + Number(b.padEnd(2, "0"));
}
export function optionalAmount(v: unknown, signed = false): number | null {
  if (v === undefined || v === null || v === "") return null;
  const s = text(v, 16, true);
  if (signed && s.startsWith("-")) return -amountCents(s.slice(1));
  return amountCents(s);
}
export function dateTime(v: unknown, required = false) {
  const s = text(v, 40, required);
  if (!s) return "";
  if (
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s) ||
    !Number.isFinite(Date.parse(s))
  )
    throw new WorkspaceError("日期时间不正确");
  if (new Date(s.slice(0, 10)).toISOString().slice(0, 10) !== s.slice(0, 10))
    throw new WorkspaceError("日期不存在");
  return new Date(s).toISOString();
}
export function checkedTime(v: unknown) {
  const s = dateTime(v) || time();
  if (Date.parse(s) > Date.now() + 300000)
    throw new WorkspaceError("核对时间不能在未来");
  return s;
}
export function version(v: unknown) {
  if (!Number.isSafeInteger(v) || Number(v) < 1)
    throw new WorkspaceError("版本错误，请刷新");
  return Number(v);
}
export function idList(value: unknown, max = 24): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max)
    throw new WorkspaceError(`附件关联需为数组，最多${max}条`);
  return [...new Set(value.map((id) => text(id, 80, true)))];
}
export function objectField(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorkspaceError(`${label}格式错误`);
  return value as Record<string, unknown>;
}
export function receiptItems(value: unknown): ReceiptItem[] {
  if (!Array.isArray(value) || value.length > 200)
    throw new WorkspaceError("项目明细需为数组，最多200行");
  return value.map((item) => {
    const row = objectField(item, "项目明细");
    if (
      row.packageIncluded !== undefined &&
      typeof row.packageIncluded !== "boolean"
    )
      throw new WorkspaceError("套餐子项标记格式错误");
    return {
      name: text(row.name, 300),
      quantity: text(row.quantity, 80),
      unitPriceCents: optionalAmount(row.unitPrice),
      amountCents: optionalAmount(row.amount),
      rawText: text(row.rawText, 2000),
      ...(row.ocrName === undefined ? {} : { ocrName: text(row.ocrName, 300) }),
      ...(row.catalogItemId === undefined
        ? {}
        : { catalogItemId: text(row.catalogItemId, 80) }),
      ...(row.packageIncluded === undefined
        ? {}
        : { packageIncluded: row.packageIncluded }),
    };
  });
}
export function receiptTotals(
  value: unknown,
  before?: ReceiptTotals,
): ReceiptTotals {
  const input = objectField(value, "票面合计"),
    output = {
      subtotalCents: null,
      dueCents: null,
      roundingCents: null,
      paidCents: null,
      ...before,
    };
  for (const [key, destination] of Object.entries({
    subtotal: "subtotalCents",
    due: "dueCents",
    rounding: "roundingCents",
    paid: "paidCents",
  }))
    if (input[key] !== undefined)
      output[destination as keyof ReceiptTotals] = optionalAmount(
        input[key],
        key === "rounding",
      );
  return output;
}
export function receiptDetails(
  value: unknown,
  before?: ReceiptDetails,
): ReceiptDetails {
  const input = objectField(value, "票面信息"),
    output = {
      cashier: "",
      shift: "",
      wristbands: "",
      partySize: "",
      printCount: "",
      printedAt: "",
      printedBy: "",
      coupons: "",
      ...before,
    };
  for (const key of Object.keys(output) as (keyof ReceiptDetails)[])
    if (input[key] !== undefined)
      output[key] = text(input[key], key === "coupons" ? 1000 : 200);
  return output;
}
function paymentMethod(raw: string): string {
  return normalizeReceiptPaymentMethod(raw);
}
export function receiptReview(value: unknown): ReceiptReview {
  const input = objectField(value, "异常核对");
  if (input.mode !== "exceptions")
    throw new WorkspaceError("异常核对模式不正确");
  if (
    input.summaryConfirmed !== undefined &&
    typeof input.summaryConfirmed !== "boolean"
  )
    throw new WorkspaceError("整单确认标记格式错误");
  if (
    input.checkedIssueKeys !== undefined &&
    (!Array.isArray(input.checkedIssueKeys) ||
      input.checkedIssueKeys.length > 1000)
  )
    throw new WorkspaceError("异常确认列表格式错误");
  return {
    mode: "exceptions",
    checkedIssueKeys: [
      ...new Set(
        ((input.checkedIssueKeys || []) as unknown[]).map((key) =>
          text(key, 200, true),
        ),
      ),
    ],
    summaryConfirmed: input.summaryConfirmed === true,
  };
}
