import type {
  CatalogItem,
  Receipt,
  ReceiptItem,
  ReceiptReviewIssue,
} from "./types";
export type { ReceiptReviewIssue } from "./types";

export type CatalogNameMatch = {
  status: "matched" | "suggested" | "ambiguous" | "unmatched";
  item?: CatalogItem;
  candidates: CatalogItem[];
  source?: "exact" | "alias" | "fuzzy";
};
export type ReceiptReviewResult = {
  issues: ReceiptReviewIssue[];
  normalItemIndexes: number[];
};

/** Formatting only: retain decimal points, digits and units so 1.5L can never become 15L. */
export function normalizeCatalogText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}
export function catalogDisplayName(
  item: Pick<CatalogItem, "name" | "spec">,
): string {
  const name = item.name.trim(),
    spec = item.spec.trim();
  if (
    !spec ||
    normalizeCatalogText(name).endsWith(normalizeCatalogText(spec)) ||
    normalizeCatalogText(name).includes(`(${normalizeCatalogText(spec)})`)
  )
    return name;
  return `${name} ${spec}`;
}
function fullNames(item: CatalogItem): string[] {
  const name = normalizeCatalogText(item.name),
    spec = normalizeCatalogText(item.spec);
  const values = [normalizeCatalogText(catalogDisplayName(item))];
  if (spec) values.push(name + spec, `${name}(${spec})`);
  return [...new Set(values)];
}
function digits(value: string): string[] {
  return (normalizeCatalogText(value).match(/\d+(?:\.\d+)?/g) || []).map(
    (number) => String(Number(number)),
  );
}
function conflictingDigits(value: string, item: CatalogItem): boolean {
  const query = digits(value),
    reference = digits(catalogDisplayName(item));
  return (
    !!query.length &&
    !!reference.length &&
    query.some((number) => !reference.includes(number))
  );
}
function similarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (
    Math.min(left.length, right.length) / Math.max(left.length, right.length) <
    0.55
  )
    return 0;
  const a = Array.from(left),
    b = Array.from(right);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j++)
      current.push(
        Math.min(
          current[j]! + 1,
          previous[j + 1]! + 1,
          previous[j]! + (a[i]! === b[j]! ? 0 : 1),
        ),
      );
    previous = current;
  }
  return 1 - previous[b.length]! / Math.max(a.length, b.length);
}

/** A suggestion is never an approval. Neither this function nor the catalog receives a price. */
export function matchCatalogName(
  name: string,
  catalog: readonly CatalogItem[],
): CatalogNameMatch {
  const query = normalizeCatalogText(name);
  if (!query) return { status: "unmatched", candidates: [] };
  const active = catalog.filter((item) => item.active),
    exact: Array<{ item: CatalogItem; source: "exact" | "alias" }> = [];
  for (const item of active) {
    if (fullNames(item).includes(query)) exact.push({ item, source: "exact" });
    else if (
      item.aliases.some((alias) => normalizeCatalogText(alias) === query) &&
      !conflictingDigits(name, item)
    )
      exact.push({ item, source: "alias" });
  }
  const approved = [
    ...new Map(exact.map((match) => [match.item.id, match])).values(),
  ];
  if (approved.length === 1)
    return {
      status: "matched",
      item: approved[0]!.item,
      candidates: [approved[0]!.item],
      source: approved[0]!.source,
    };
  if (approved.length > 1)
    return {
      status: "ambiguous",
      candidates: approved.map((match) => match.item),
    };
  const ranked = active
    .map((item) => ({
      item,
      score: Math.max(
        ...[
          ...fullNames(item),
          normalizeCatalogText(item.name),
          ...item.aliases.map(normalizeCatalogText),
        ].map((value) => similarity(query, value)),
      ),
    }))
    .filter((match) => match.score >= 0.55)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
    .slice(0, 5);
  if (!ranked.length) return { status: "unmatched", candidates: [] };
  const ambiguous =
    ranked.length > 1 && ranked[0]!.score - ranked[1]!.score < 0.08;
  return {
    status: ambiguous ? "ambiguous" : "suggested",
    candidates: ranked.map((match) => match.item),
    source: "fuzzy",
  };
}

/** Only an exact approved name/alias may replace a name. Every money field is copied verbatim. */
export function applyCatalogMatches(
  items: readonly ReceiptItem[],
  catalog: readonly CatalogItem[],
): ReceiptItem[] {
  return items.map((item) => {
    const original = { ...item, ocrName: item.ocrName ?? item.name },
      match = matchCatalogName(item.name, catalog);
    if (match.status !== "matched" || !match.item) {
      const { catalogItemId: _, ...unmatched } = original;
      return unmatched;
    }
    return {
      ...original,
      name: catalogDisplayName(match.item),
      catalogItemId: match.item.id,
      packageIncluded:
        item.packageIncluded === true || match.item.packageIncluded,
    };
  });
}

// Two independent 32-bit accumulators keep stable field fingerprints synchronous in browsers and Workers.
function fingerprint(value: unknown): string {
  const data = JSON.stringify(value);
  let left = 2166136261,
    right = 2246822507;
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 3266489909);
  }
  return (
    (left >>> 0).toString(16).padStart(8, "0") +
    (right >>> 0).toString(16).padStart(8, "0")
  );
}
function knownMoney(value: unknown, signed = false): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (signed || value >= 0)
  );
}
function quantity(
  value: string,
): { numerator: number; denominator: number } | null {
  const normalized = value.normalize("NFKC").trim(),
    match = normalized.match(
      /^(\d{1,6})(?:\.(\d{1,4}))?\s*(?:[\u3400-\u9fffA-Za-z]+)?$/,
    );
  if (!match) return null;
  const fraction = match[2]! || "",
    denominator = 10 ** fraction.length;
  return {
    numerator: Number(match[1]!) * denominator + Number(fraction || 0),
    denominator,
  };
}
export function normalizeReceiptPaymentMethod(raw: string): string {
  return /会员|储值|余额|卡扣|扣卡/.test(raw)
    ? "会员扣卡"
    : raw.includes("微信")
      ? "微信"
      : raw.includes("支付宝")
        ? "支付宝"
        : raw.includes("银行卡")
          ? "银行卡"
          : raw.includes("现金")
            ? "现金"
            : "其他待核";
}

/** Recompute the current exceptions. Client acknowledgements do not influence this result. */
export function reviewReceipt(
  receipt: Partial<Receipt>,
  catalog: readonly CatalogItem[],
): ReceiptReviewResult {
  const issues: ReceiptReviewIssue[] = [],
    items = applyCatalogMatches(receipt.items || [], catalog).map((item) => ({
      ...item,
      name: item.name.trim(),
      quantity: item.quantity.trim(),
      rawText: item.rawText.trim(),
      ocrName: item.ocrName?.trim(),
    }));
  const payments = (receipt.payments || []).map((payment) => ({
    method: normalizeReceiptPaymentMethod(payment.method.trim()),
    amountCents: payment.amountCents,
    memberId: payment.memberId.trim(),
    originalMethod: (payment.originalMethod || payment.method).trim(),
  }));
  const totals = {
    subtotalCents: receipt.totals?.subtotalCents ?? null,
    dueCents: receipt.totals?.dueCents ?? null,
    roundingCents: receipt.totals?.roundingCents ?? null,
    paidCents: receipt.totals?.paidCents ?? null,
  };
  const warnings = (receipt.warnings || []).map((warning) => warning.trim());
  const add = (
    scope: ReceiptReviewIssue["scope"],
    code: string,
    message: string,
    values: unknown,
    itemIndex?: number,
    requiresFix = false,
  ) => {
    const key = `${scope}:${code}:${itemIndex === undefined ? "receipt" : itemIndex}:${fingerprint(values)}`;
    if (!issues.some((issue) => issue.key === key))
      issues.push({
        key,
        scope,
        ...(itemIndex === undefined ? {} : { itemIndex }),
        message,
        blocking: true,
        ...(requiresFix ? { requiresFix: true } : {}),
      });
  };
  for (const [key, label] of [
    ["memberId", "接待会员"],
    ["store", "门店"],
    ["number", "收银单号"],
  ] as const)
    if (!receipt[key]!?.trim())
      add(
        "header",
        key,
        `请补齐${label}。`,
        receipt[key]! ?? null,
        undefined,
        true,
      );
  if (!receipt.occurredAt || !Number.isFinite(Date.parse(receipt.occurredAt)))
    add(
      "header",
      "occurredAt",
      "请补齐有效消费发生时间。",
      receipt.occurredAt ?? null,
      undefined,
      true,
    );
  if (!receipt.uploadIds?.length)
    add(
      "header",
      "source-image",
      "请附原始小票图片。",
      receipt.uploadIds || [],
      undefined,
      true,
    );
  if (receipt.kind && receipt.kind !== "结算单")
    add(
      "header",
      "unsettled-kind",
      "仅结算单可确认消费；其他凭证请保留待核状态。",
      receipt.kind,
      undefined,
      true,
    );
  if (!items.length)
    add("name", "empty-items", "请保留小票上的消费项目。", [], undefined, true);
  const itemFacts = items.map((item) => ({
    name: item.name,
    ocrName: item.ocrName ?? "",
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    amountCents: item.amountCents,
    packageIncluded: item.packageIncluded === true,
    rawText: item.rawText,
  }));
  items.forEach((item, index) => {
    const match = matchCatalogName(item.name, catalog),
      included =
        item.packageIncluded === true ||
        (match.status === "matched" && match.item?.packageIncluded === true);
    if (!item.name.trim())
      add(
        "name",
        "missing-name",
        "请补齐项目名称。",
        itemFacts[index]!,
        index,
        true,
      );
    else if (match.status !== "matched")
      add(
        "name",
        match.status,
        match.status === "ambiguous"
          ? "名称对应多个已核准项目，请对照原图核实规格或保留原名。"
          : match.status === "suggested"
            ? "名称只有相似候选，请人工核对；系统不会按相似字或价格套用。"
            : "名称尚未核准，可对照原图确认原名，无需强制建目录。",
        [
          item.name,
          item.ocrName ?? "",
          match.status,
          match.candidates.map((candidate) => [
            candidate.id,
            candidate.version,
            candidate.name,
            candidate.spec,
          ]),
        ],
        index,
      );
    if (item.amountCents === null || item.amountCents === undefined) {
      if (!included)
        add(
          "amount",
          "missing-line-amount",
          "非套餐子项缺少票面金额，请补齐；不能用历史价格或实付差额补造。",
          itemFacts[index]!,
          index,
          true,
        );
    } else if (!knownMoney(item.amountCents))
      add(
        "amount",
        "invalid-line-amount",
        "项目金额格式不正确，请按票面修正。",
        itemFacts[index]!,
        index,
        true,
      );
    if (
      item.unitPriceCents !== null &&
      item.unitPriceCents !== undefined &&
      !knownMoney(item.unitPriceCents)
    )
      add(
        "amount",
        "invalid-unit-price",
        "项目单价格式不正确。",
        itemFacts[index]!,
        index,
        true,
      );
    const q = quantity(item.quantity || "");
    if (!q)
      add(
        "quantity",
        "quantity-unread",
        "项目数量未明确，请对照原图核对，不自动补为1。",
        itemFacts[index]!,
        index,
      );
    else if (
      knownMoney(item.unitPriceCents) &&
      knownMoney(item.amountCents) &&
      q.numerator * item.unitPriceCents !== item.amountCents * q.denominator
    )
      add(
        "quantity",
        "unit-line-mismatch",
        "数量×单价与项目金额不同；如有折扣或套餐计价，请对照原图核对。",
        itemFacts[index]!,
        index,
      );
    const hasCandidateWarning = warnings.some(
      (warning) =>
        new RegExp(`第\\s*${index + 1}\\s*项`).test(warning) &&
        /金额|单价|价格|小数点/.test(warning) &&
        /候选|不一致|冲突|小数点/.test(warning),
    );
    if (
      !hasCandidateWarning &&
      /金额.*(?:小数点候选|识别候选)|(?:小数点候选).*金额/.test(
        item.rawText || "",
      )
    )
      add(
        "amount",
        "ocr-candidate",
        "此项金额来自OCR候选或小数点推测，请重点核对原图。",
        itemFacts[index]!,
        index,
      );
  });
  const actual = receipt.amountCents ?? null;
  if (!knownMoney(actual))
    add(
      "total",
      "missing-paid",
      "请补齐有效的实际结算金额。",
      actual ?? null,
      undefined,
      true,
    );
  payments.forEach((payment, index) => {
    const method = normalizeReceiptPaymentMethod(payment.method || ""),
      facts = {
        index,
        method,
        originalMethod: payment.originalMethod ?? "",
        amountCents: payment.amountCents,
        memberId: payment.memberId,
      };
    if (!knownMoney(payment.amountCents))
      add(
        "payment",
        `invalid-amount-${index}`,
        "支付分录金额无效。",
        facts,
        undefined,
        true,
      );
    if (method === "其他待核")
      add(
        "payment",
        `unknown-method-${index}`,
        "支付方式未明确，请人工选择实际支付类型；不根据银行简称自动猜测。",
        facts,
        undefined,
        true,
      );
    if (method === "会员扣卡" && !payment.memberId)
      add(
        "payment",
        `missing-card-member-${index}`,
        "会员扣卡需明确实际扣卡会员。",
        facts,
        undefined,
        true,
      );
  });
  if (
    knownMoney(actual) &&
    payments.every((payment) => knownMoney(payment.amountCents))
  ) {
    const total = payments.reduce(
      (sum, payment) => sum + payment.amountCents,
      0,
    );
    if (total !== actual)
      add(
        "payment",
        "payment-total",
        "支付分录合计与实际结算金额不一致，请修正后确认。",
        [actual, payments],
        undefined,
        true,
      );
  }
  if (
    knownMoney(totals?.paidCents) &&
    knownMoney(actual) &&
    totals.paidCents !== actual
  )
    add(
      "total",
      "paid-actual-mismatch",
      "票面实付与实际结算金额不同，请修正。",
      [actual, totals.paidCents],
      undefined,
      true,
    );
  const knownItems = items.filter((item) => knownMoney(item.amountCents)),
    requiredAmountsKnown = items.every(
      (item) =>
        knownMoney(item.amountCents) ||
        item.packageIncluded === true ||
        (matchCatalogName(item.name, catalog).status === "matched" &&
          matchCatalogName(item.name, catalog).item?.packageIncluded === true),
    );
  if (
    knownItems.length &&
    requiredAmountsKnown &&
    knownMoney(totals?.subtotalCents)
  ) {
    const total = knownItems.reduce(
      (sum, item) => sum + (item.amountCents || 0),
      0,
    );
    if (total !== totals.subtotalCents)
      add(
        "total",
        "items-subtotal",
        "已知项目合计与票面小计不同，请核对优惠口径或漏项。",
        [itemFacts, totals.subtotalCents],
      );
  }
  const paid = knownMoney(totals?.paidCents)
    ? totals.paidCents
    : knownMoney(actual)
      ? actual
      : null;
  const adjustmentKnown = knownMoney(totals.roundingCents, true),
    explained =
      paid !== null &&
      adjustmentKnown &&
      ((knownMoney(totals.subtotalCents) &&
        totals.subtotalCents + (totals.roundingCents as number) === paid) ||
        (knownMoney(totals.dueCents) &&
          totals.dueCents + (totals.roundingCents as number) === paid));
  if (
    paid !== null &&
    knownMoney(totals?.dueCents) &&
    totals.dueCents !== paid &&
    !explained
  )
    add(
      "total",
      "due-paid-difference",
      "应付与实付不同，请核对优惠、抹零或其他调整依据。",
      [totals, actual, receipt.details?.coupons || ""],
    );
  warnings.forEach((warning) => {
    if (/应付.*实付.*不同/.test(warning) && explained) return;
    if (/候选|不一致|不确定|冲突|小数点/.test(warning)) {
      const indexMatch = warning.match(/第\s*(\d+)\s*项/),
        index = indexMatch ? Number(indexMatch[1]!) - 1 : undefined;
      if (index !== undefined && index >= 0 && index < items.length) {
        const scope = /名称|品名|项目名/.test(warning)
          ? "name"
          : /数量/.test(warning)
            ? "quantity"
            : /金额|单价|价格|小数点/.test(warning)
              ? "amount"
              : "header";
        add(scope, "ocr-warning", warning, [warning, itemFacts[index]!], index);
        return;
      }
      const scope = /名称|品名/.test(warning)
        ? "name"
        : /单号|门店|时间/.test(warning)
          ? "header"
          : /支付/.test(warning)
            ? "payment"
            : "total";
      add(scope, "ocr-warning", warning, [
        warning,
        scope === "header"
          ? [receipt.number?.trim(), receipt.store?.trim(), receipt.occurredAt]
          : [totals, actual, payments, itemFacts],
      ]);
    } else if (/重叠|重复行/.test(warning))
      add("header", "overlap-warning", warning, [warning, itemFacts]);
  });
  return {
    issues,
    normalItemIndexes: items
      .map((_, index) => index)
      .filter((index) => !issues.some((issue) => issue.itemIndex === index)),
  };
}
