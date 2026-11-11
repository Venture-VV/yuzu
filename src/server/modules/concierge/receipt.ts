// Receipt validation never calls wallet, checkout, recharge or refund writers.
import type { Db } from "../../db";
import type {
  Receipt,
  Payment,
  TeamUser,
  CatalogItem,
  ReceiptItem,
} from "@shared/concierge/types";
import {
  applyCatalogMatches,
  normalizeReceiptPaymentMethod as paymentMethod,
  reviewReceipt,
} from "@shared/concierge/receipt-review";
import {
  text,
  dateTime,
  optionalAmount,
  amountCents,
  idList,
  receiptItems,
  receiptTotals,
  receiptDetails,
  receiptReview,
  objectField,
  WorkspaceError,
  uuid,
} from "./validation";
import { requireMember, readCatalog } from "./store";
async function findRecordUpload(db: Db, id: string) {
  const [r] = await db`SELECT id FROM concierge_uploads WHERE id=${uuid(id)}::uuid`;
  return r;
}
async function findReceipt(db: Db, id: string) {
  const [r] =
    await db`SELECT data FROM concierge_records WHERE id=${uuid(id)}::uuid AND kind='receipt'`;
  return r;
}
async function findConfirmedReceipt(
  db: Db,
  id: string,
  number: string,
  store: string,
  occurredAt: string,
  kind: string,
) {
  const day = new Date(Date.parse(occurredAt) + 8 * 3600000)
    .toISOString()
    .slice(0, 10);
  const [r] =
    await db`SELECT id FROM concierge_records WHERE kind='receipt' AND id<>${uuid(id)}::uuid AND data->>'number'=${number} AND data->>'store'=${store} AND data->>'receiptDay'=${day} AND data->>'kind'=${kind} AND data->>'status'='已确认'`;
  return r;
}
export async function buildReceipt(
  db: Db,
  p: Record<string, any>,
  before: any,
  actor: TeamUser,
  id: string,
  memberId: string,
) {
  let data: any;
  const ts = new Date().toISOString();

  const receiptValue = (key: string) =>
    p[key] === undefined ? before?.[key] : p[key];
  const receiptKind = text(receiptValue("kind"), 20, true),
    status = text(receiptValue("status"), 20, true);
  if (
    !["结算单", "消费清单", "退款单", "作废单"].includes(receiptKind) ||
    !["待核对", "待补全", "待复核", "已确认", "已作废"].includes(status)
  )
    throw new WorkspaceError("凭证类别或状态错误");
  if (
    (["已确认", "已作废"].includes(before?.status) ||
      status === "已作废" ||
      (["退款单", "作废单"].includes(receiptKind) && status === "已确认")) &&
    actor.role !== "manager"
  )
    throw new WorkspaceError("已确认金额更正及退款作废请提交管理员复核", 403);
  const number = text(receiptValue("number"), 100),
    store = text(receiptValue("store"), 100),
    occurredAt = dateTime(receiptValue("occurredAt")),
    itemsText = text(receiptValue("itemsText"), 60000),
    rawText = text(receiptValue("rawText"), 60000),
    note = text(receiptValue("note"), 3000),
    originalReceiptId = text(receiptValue("originalReceiptId"), 80);
  let amount =
    p.amount === undefined
      ? (before?.amountCents ?? null)
      : optionalAmount(p.amount);
  const uploadIds = idList(receiptValue("uploadIds"), 12);
  for (const image of uploadIds)
    if (!(await findRecordUpload(db, image)))
      throw new WorkspaceError("原图不存在，请重新上传");
  // 列表里的凭证是摘要（不带逐项明细与识别原文）。拿摘要去保存，会把库里的明细与原文清成空的——
  // 页面已经改成先取完整的再编辑，这里再兜一道：原来有明细、有识别原文，这次两样都是空的，按「没载入明细」拒绝。
  if (
    before &&
    Array.isArray(p.items) &&
    p.items.length === 0 &&
    Array.isArray(before.items) &&
    before.items.length > 0 &&
    !rawText &&
    !!before.rawText
  )
    throw new WorkspaceError(
      "这张凭证的逐项明细还没有载入，请刷新后重新打开再保存",
      409,
    );
  const catalog = await readCatalog(db),
    items =
      p.items === undefined
        ? before?.items
        : applyCatalogMatches(receiptItems(p.items), catalog);
  if (p.itemsReviewed !== undefined && typeof p.itemsReviewed !== "boolean")
    throw new WorkspaceError("逐项核对标记格式错误");
  const itemsReviewed =
    p.itemsReviewed === undefined
      ? p.items === undefined && before?.itemsReviewed === true
      : p.itemsReviewed;
  const totals =
      p.totals === undefined
        ? before?.totals
        : receiptTotals(p.totals, before?.totals),
    details =
      p.details === undefined
        ? before?.details
        : receiptDetails(p.details, before?.details);
  const review =
    p.review === undefined ? before?.review : receiptReview(p.review);
  let warnings = before?.warnings;
  if (p.warnings !== undefined) {
    if (!Array.isArray(p.warnings) || p.warnings.length > 50)
      throw new WorkspaceError("识别提示最多50条");
    warnings = p.warnings.map((warning) => text(warning, 500, true));
  }
  if (
    amount === null &&
    totals?.paidCents !== undefined &&
    totals.paidCents !== null
  )
    amount = totals.paidCents;
  const payments: Payment[] = [];
  if (p.payments !== undefined && !Array.isArray(p.payments))
    throw new WorkspaceError("支付明细格式错误");
  if (Array.isArray(p.payments) && p.payments.length > 20)
    throw new WorkspaceError("支付方式过多");
  const submittedPayments =
    p.payments === undefined ? before?.payments || [] : p.payments;
  for (const value of submittedPayments as unknown[]) {
    const payment = objectField(value, "支付明细"),
      rawMethod = text(payment.method, 50, true),
      normalized = paymentMethod(rawMethod),
      preserveHistorical =
        p.payments === undefined && before?.status === "已确认",
      method = preserveHistorical ? rawMethod : normalized,
      paymentMember = text(payment.memberId, 80),
      cents =
        p.payments === undefined
          ? Number(payment.amountCents)
          : amountCents(payment.amount),
      originalMethod = text(payment.originalMethod, 200) || rawMethod;
    if (paymentMember) await requireMember(db, paymentMember);
    if (status === "已确认" && normalized === "会员扣卡" && !paymentMember)
      throw new WorkspaceError("会员卡支付请核对实际扣卡会员");
    if (status === "已确认" && normalized === "其他待核" && !preserveHistorical)
      throw new WorkspaceError(
        "支付方式未明确，请核对后选择会员扣卡、现金、微信、支付宝或银行卡",
      );
    // 只留认得的字段（整改：原来把页面发来的整个对象原样存下，多出来的键也进了库）
    payments.push({
      method,
      amountCents: cents,
      memberId: paymentMember,
      originalMethod,
    } as Payment);
  }
  if (status === "已确认") {
    if (receiptKind === "消费清单")
      throw new WorkspaceError("未结算消费清单不能确认成已结消费");
    if (
      !memberId ||
      !number ||
      !store ||
      !occurredAt ||
      amount === null ||
      !uploadIds.length
    )
      throw new WorkspaceError("确认前请补齐门店 单号 时间 金额和原图");
    if (
      receiptKind !== "作废单" &&
      payments.reduce((v, x) => v + x.amountCents, 0) !== amount
    )
      throw new WorkspaceError("支付分项合计与结算金额不一致");
    const paymentFacts = (rows: Payment[]) =>
      JSON.stringify(
        rows.map((payment) => ({
          method: paymentMethod(payment.method),
          amountCents: payment.amountCents,
          memberId: payment.memberId,
        })),
      );
    const legacyConfirmed =
      before?.status === "已确认" &&
      before.items === undefined &&
      p.items === undefined &&
      p.itemsReviewed === undefined &&
      amount === before.amountCents &&
      itemsText === (before.itemsText || "") &&
      paymentFacts(payments) === paymentFacts(before.payments || []);
    const currentReview = reviewReceipt(
      {
        memberId,
        number,
        store,
        occurredAt,
        kind: receiptKind as Receipt["kind"],
        amountCents: amount,
        payments,
        items,
        totals,
        details,
        warnings,
        uploadIds,
      },
      catalog,
    );
    if (review?.mode === "exceptions") {
      if (review.summaryConfirmed !== true)
        throw new WorkspaceError("请完成本单异常核对并确认整单");
      const needsFix = currentReview.issues.find((issue) => issue.requiresFix);
      if (needsFix) throw new WorkspaceError(needsFix.message);
      const acknowledged = new Set(review.checkedIssueKeys),
        unchecked = currentReview.issues.filter(
          (issue) => issue.blocking && !acknowledged.has(issue.key),
        );
      if (unchecked.length)
        throw new WorkspaceError(
          `还有${unchecked.length}项当前异常未核对：${unchecked[0]!.message}`,
        );
    } else if (!legacyConfirmed) {
      if (
        !Array.isArray(items) ||
        !items.length ||
        items.some((item: ReceiptItem) => !item.name.trim()) ||
        itemsReviewed !== true
      )
        throw new WorkspaceError(
          "确认前请补齐消费项目明细，并逐项核对后勾选确认",
        );
      const needsFix = currentReview.issues.find((issue) => issue.requiresFix);
      if (needsFix) throw new WorkspaceError(needsFix.message);
    }
    if (
      totals?.paidCents !== undefined &&
      totals.paidCents !== null &&
      totals.paidCents !== amount
    )
      throw new WorkspaceError(
        "票面实付金额与本单实际结算金额不一致，请核对；应付和实付可分别保存",
      );
    const existing = await findConfirmedReceipt(
      db,
      id,
      number,
      store,
      occurredAt,
      receiptKind,
    );
    if (existing && receiptKind === "结算单")
      throw new WorkspaceError("该单已确认，请打开已有记录补图或更正", 409);
    if (["退款单", "作废单"].includes(receiptKind)) {
      if (!originalReceiptId || originalReceiptId === id)
        throw new WorkspaceError("退款或作废请关联原消费单");
      const original = await findReceipt(db, originalReceiptId);
      const originalData = original ? original.data : null;
      if (
        !originalData ||
        originalData.kind !== "结算单" ||
        originalData.status !== "已确认"
      )
        throw new WorkspaceError("原单必须为已确认结算单");
      // Refund confirmation is kept in the review queue until a verified payment-row linkage is provided.
      throw new WorkspaceError(
        "退款或作废凭证请保留待复核；管理员可在原单更正状态并保留原因，逐笔退款支付关联尚未启用",
      );
    }
  }
  if (
    ["已确认", "已作废"].includes(before?.status) &&
    !text(p.reason ?? p.changeReason, 1000)
  )
    throw new WorkspaceError("更正已确认凭证请填写原因");
  data = {
    ...before,
    memberId,
    number,
    store,
    occurredAt,
    kind: receiptKind,
    status,
    amountCents: amount,
    payments,
    itemsText,
    rawText,
    note,
    uploadIds,
    originalReceiptId,
    ...(items === undefined ? {} : { items, itemsReviewed }),
    ...(totals === undefined ? {} : { totals }),
    ...(details === undefined ? {} : { details }),
    ...(warnings === undefined ? {} : { warnings }),
    ...(review === undefined ? {} : { review }),
    confirmedByName:
      before?.confirmedByName || (status === "已确认" ? actor.name : ""),
    confirmedAt: before?.confirmedAt || (status === "已确认" ? ts : ""),
  };

  data.receiptDay = data.occurredAt
    ? new Date(Date.parse(data.occurredAt) + 8 * 3600000)
        .toISOString()
        .slice(0, 10)
    : "";
  return data;
}
