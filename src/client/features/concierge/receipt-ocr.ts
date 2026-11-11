/**
 * Device-local OCR. The worker, engine and language files are all served from
 * this Site; receipt images are never sent to a third-party OCR endpoint.
 * Every extracted value is a suggestion for an employee to verify.
 */
export type ReceiptOcrResult = {
  rawText: string;
  number?: string;
  store?: string;
  occurredAt?: string;
  amount?: string;
  itemsText?: string;
  payments?: Array<{ method: string; amount: string; memberId?: string }>;
  items?: Array<{
    name: string;
    quantity: string;
    unitPrice?: string;
    amount?: string;
    rawText: string;
  }>;
  totals?: {
    subtotal?: string;
    due?: string;
    rounding?: string;
    paid?: string;
  };
  details?: {
    cashier?: string;
    shift?: string;
    wristbands?: string;
    partySize?: string;
    printCount?: string;
    printedAt?: string;
    printedBy?: string;
    coupons?: string;
  };
  warnings?: string[];
};

type TextLine = { original: string; compact: string; page: number };
const MONEY = "(?:0|[1-9]\\d{0,9}|[1-9]\\d{0,2}(?:,\\d{3}){1,3})\\.\\d{2}";
const amountLabels = [
  /支付合计|支付会计|支付总计|实收金额|实收合计|实际收款|实付款|实付金额|实际支付|实付合计|结算金额|实际结算|实收|实付/i,
  /应付金额|应收金额|应付合计|应收合计|应结金额|应付|应收/i,
  /总计金额|合计金额|消费合计|消费总额|合计|总计/i,
];
const paymentPattern = new RegExp(
  `(会员卡|储值卡|会员扣卡|扣卡|卡扣|微信|支付宝|现金)(?:支付|收款|扣款|金额|实付)?[:：=\\s]*[¥￥]?\\s*(${MONEY})(?![\\d.])`,
  "g",
);

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[，]/g, ",")
    .replace(/(\d)\s*[.·]\s*(\d{2})(?!\d)/g, "$1.$2")
    .trim();
}
function allLines(rawText: string): TextLine[] {
  let page = 0;
  return rawText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => {
      const original = normalized(line);
      const marker = /^【第\s*(\d+)\s*张】$/.exec(original);
      if (marker) {
        page = Number(marker[1]!);
        return [];
      }
      if (!original) return [];
      return [{ original, compact: original.replace(/[ \t]/g, ""), page }];
    });
}
function unique(values: string[]): string | undefined {
  const candidates = [...new Set(values)];
  return candidates.length === 1 ? candidates[0]! : undefined;
}
function moneyAfterLabel(line: string, label: RegExp): string | undefined {
  const match = label.exec(line);
  if (!match || match.index === undefined) return undefined;
  const prefix = line.slice(Math.max(0, match.index - 12), match.index);
  // Discounts, change, balances, page subtotals and refunds are not settlement totals.
  if (
    /优惠|折扣|赠送|找零|余额|积分|退款|实退|已退|本页|小计|数量|作废/.test(
      prefix,
    )
  )
    return undefined;
  const rest = line.slice(match.index + match[0]!.length);
  const amount = new RegExp(`^[:：=\\s]*[¥￥]?\\s*(${MONEY})(?![\\d.])`).exec(
    rest,
  );
  return amount?.[1]!.replace(/,/g, "");
}
function parseAmount(lines: TextLine[]): string | undefined {
  for (const label of amountLabels) {
    const candidates = lines.flatMap((line) => {
      const amount = moneyAfterLabel(line.compact, label);
      return amount === undefined ? [] : [amount];
    });
    if (candidates.length) return unique(candidates);
  }
  return undefined;
}
function parseNumber(lines: TextLine[]): string | undefined {
  const values: string[] = [];
  for (const line of lines) {
    // A payment transaction ID is not necessarily the receipt/order number.
    if (/支付流水|微信流水|支付宝流水|支付单号|交易流水/.test(line.compact))
      continue;
    const match =
      /(?:消费单号|结账单号|结算单号|收银单号|订单编号|订单[号时如]|账单编号|账单号|单据编号|单据号|小票号|单号)[:：,#=\s]*([A-Za-z0-9][A-Za-z0-9/_-]{3,63})(?![A-Za-z0-9/_-])/.exec(
        line.compact,
      );
    if (match) values.push(match[1]!);
  }
  if (values.length) return unique(values);
  // A damaged label may disappear while its alphanumeric order number survives.
  // Only consider the header, never wristband/card/coupon/payment identifiers.
  return unique(
    lines
      .slice(0, 14)
      .filter(
        (line) => !/手牌|卡号|会员|券码|税号|支付|交易|流水/.test(line.compact),
      )
      .flatMap((line) =>
        [
          ...line.compact.matchAll(
            /(?:^|[^A-Za-z0-9])([A-Za-z]{1,8}\d{10,32})(?![A-Za-z0-9])/g,
          ),
        ].map((match) => match[1]!),
      ),
  );
}
function parseStore(lines: TextLine[]): string | undefined {
  const values: string[] = [];
  for (const line of lines) {
    const match =
      /^(?:门店名称|门店|商户名称|商家名称|店名|收款单位)[:：=]\s*(.{2,60})$/.exec(
        line.original,
      );
    if (
      match &&
      !/^\d+$/.test(match[1]!) &&
      !/电话|地址|单号|金额/.test(match[1]!)
    )
      values.push(match[1]!.trim());
  }
  if (values.length) return unique(values);
  const heading = lines
    .slice(0, 8)
    .find(
      (line) =>
        /店|餐厅|生活|商贸|超市|会所|酒店/.test(line.compact) &&
        !/订单|单号|时间|地址|电话|金额/.test(line.compact) &&
        line.compact.length >= 4 &&
        line.compact.length <= 60,
    );
  return heading?.compact;
}
function dateFromLine(line: string): string | undefined {
  const match =
    /(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?(?:\s|T)*(\d{1,2})[:：./](\d{2})(?:[:：./](\d{2}))?(?!\d)/.exec(
      line,
    );
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((value) => Number(value || 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    return undefined;
  const pad = (value: number) => String(value).padStart(2, "0");
  return new Date(
    `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`,
  ).toISOString();
}
function parseDate(lines: TextLine[]): string | undefined {
  const available = lines.filter(
    (line) => !/打印|上传|拍照|开票日期/.test(line.compact),
  );
  for (const label of [/结账时间|结算时间/, /消费时间/, /交易时间/]) {
    const candidates = available
      .filter((line) => label.test(line.compact))
      .flatMap((line) => {
        const value = dateFromLine(line.original);
        return value ? [value] : [];
      });
    if (candidates.length) return unique(candidates);
  }
  return unique(
    available.flatMap((line) => {
      const value = dateFromLine(line.original);
      return value ? [value] : [];
    }),
  );
}
function parsePayments(lines: TextLine[]): ReceiptOcrResult["payments"] {
  const candidates = new Map<
    string,
    Array<{ amount: string; line: string; page: number }>
  >();
  for (const line of lines) {
    if (/退款|实退|已退|撤销|作废/.test(line.compact)) continue;
    for (const match of line.compact.matchAll(paymentPattern)) {
      const method = ["会员卡", "储值卡", "会员扣卡", "扣卡", "卡扣"].includes(
        match[1]!,
      )
        ? "会员卡"
        : match[1]!;
      const row = {
        amount: match[2]!.replace(/,/g, ""),
        line: line.compact,
        page: line.page,
      };
      const sameMethod = candidates.get(method) || [];
      // Repeated identical footer on another photograph may be a repeated page.
      // Within the same photo, repeated payments remain ambiguous for human review.
      if (
        !sameMethod.some(
          (old) => old.line === row.line && old.page !== row.page,
        )
      )
        sameMethod.push(row);
      candidates.set(method, sameMethod);
    }
  }
  const payments: NonNullable<ReceiptOcrResult["payments"]> = [];
  for (const [method, values] of candidates) {
    if (values.length === 1)
      payments.push({ method, amount: values[0]!.amount });
  }
  // POS systems may print their configured tender name rather than a standard
  // payment brand. Keep that wording for the employee instead of guessing.
  let inPayments = false;
  for (const line of lines) {
    if (/支付方式|付款方式|收款方式/.test(line.compact)) {
      inPayments = true;
      continue;
    }
    if (!inPayments) continue;
    if (/支付[合会]计|支付总计|打印|找零|余额|券码|优惠券/.test(line.compact)) {
      inPayments = false;
      continue;
    }
    const row = /^(.{2,50}?)\s+([\d,]+\.\d{2})(?:\s+.*)?$/.exec(
      line.original.replace(/^[|丨‖\s]+|[|丨‖\s]+$/g, ""),
    );
    if (!row || /合计|总计|金额/.test(row[1]!)) continue;
    const method = row[1]!.trim();
    if (
      !payments.some(
        (payment) =>
          payment.method === method &&
          payment.amount === row[2]!.replace(/,/g, ""),
      )
    )
      payments.push({ method, amount: row[2]!.replace(/,/g, "") });
  }
  return payments.length ? payments : undefined;
}
function itemSection(lines: TextLine[]): string[] {
  const itemLines: string[] = [];
  let withinItems = false;
  for (const line of lines) {
    if (
      /(?:项目|品名|商品|名称|项.{0,3}名)/.test(line.compact) &&
      /(?:数量|单价|金额|优惠|级昌|的有)/.test(line.compact)
    ) {
      withinItems = true;
      continue;
    }
    if (!withinItems) continue;
    if (
      /^(?:合计|总计|小计|小[十+]|消费合计|应收|应付|实收|实付|结算金额|支付方式|会员卡|储值卡|微信|支付宝|现金|优惠金额|抹零金额)/.test(
        line.compact,
      )
    ) {
      withinItems = false;
      continue;
    }
    if (
      !/记入场|入场[:：]|手牌[号码号]|^[\s─━—_.|丨‖-]{3,}$/.test(line.original)
    )
      itemLines.push(line.original);
  }
  return itemLines;
}
function parseItems(section: string[]): NonNullable<ReceiptOcrResult["items"]> {
  const items: NonNullable<ReceiptOcrResult["items"]> = [];
  let pending: string[] = [];
  const flush = () => {
    const name = pending
      .join("")
      .replace(/^[|丨‖\s]+|[|丨‖\s]+$/g, "")
      .trim();
    if (name && /[\u3400-\u9fffA-Za-z]/.test(name))
      items.push({ name, quantity: "", rawText: pending.join("\n") });
    pending = [];
  };
  for (const source of section) {
    const line = source.replace(/^[|丨‖\s]+|[|丨‖\s]+$/g, "").trim();
    if (!line) continue;
    const money = /(?:^|\s)([\d,]+\.\d{2})\s*$/.exec(line);
    let beforeAmount = money ? line.slice(0, money.index).trim() : line;
    const price = money
      ? /(?:^|\s)([\d,]+\.\d{2})\s*$/.exec(beforeAmount)
      : null;
    if (price) beforeAmount = beforeAmount.slice(0, price.index).trim();
    const quantity = /(?:\s{2,}|\s)(\d{1,5}(?:\.\d{1,3})?)\s*$/.exec(
      beforeAmount,
    );
    const name = (
      quantity ? beforeAmount.slice(0, quantity.index) : beforeAmount
    ).trim();
    if (money || quantity) {
      if (
        pending.length &&
        /^[-－•]/.test(pending[0]!) &&
        !/^[-－•]/.test(name) &&
        !/分钟|小时/.test(name) &&
        name.length > 3 &&
        !/^[^(]*\([^)]*$/.test(pending.join(""))
      )
        flush();
      const rawText = [...pending, source].join("\n");
      const fullName = [...pending, name].join("").trim();
      pending = [];
      if (!fullName || !/[\u3400-\u9fffA-Za-z]/.test(fullName)) continue;
      items.push({
        name: fullName,
        quantity: quantity?.[1]! || "",
        ...(money ? { amount: money[1]!.replace(/,/g, "") } : {}),
        ...(price ? { unitPrice: price[1]!.replace(/,/g, "") } : {}),
        rawText,
      });
    } else if (
      items.length &&
      (/^(?:限|仅限|仅供|堂食|外带)/.test(line) ||
        /仅$/.test(items[items.length - 1]!.name))
    ) {
      const previous = items[items.length - 1]!;
      previous.name += line;
      previous.rawText += `\n${source}`;
    } else {
      if (/^[-－•]/.test(line) && pending.length) flush();
      pending.push(line);
    }
  }
  flush();
  return items;
}
function labelled(lines: TextLine[], label: RegExp): string | undefined {
  return unique(
    lines.flatMap((line) => {
      const match = label.exec(line.original);
      const value = match
        ? line.original
            .slice(match.index + match[0]!.length)
            .replace(/^[:：,;；=\s]+/, "")
            .trim()
        : "";
      return value ? [value] : [];
    }),
  );
}
function labelledMoney(
  lines: TextLine[],
  label: RegExp,
  signed = false,
): string | undefined {
  return unique(
    lines.flatMap((line) => {
      const match = label.exec(line.compact);
      if (!match) return [];
      const result = new RegExp(
        `^[:：,=\\s]*[¥￥]?\\s*(${signed ? "-?" : ""}${MONEY})(?![\\d.])`,
      ).exec(line.compact.slice(match.index + match[0]!.length));
      return result ? [result[1]!.replace(/,/g, "")] : [];
    }),
  );
}

/** Conservative candidates only; this function never links a receipt to a member. */
export function parseReceiptText(rawText: string): ReceiptOcrResult {
  const lines = allLines(rawText);
  const section = itemSection(lines);
  const items = parseItems(section);
  const totals = {
    subtotal: labelledMoney(lines, /^(?:商品小计|消费小计|小计|小[十+])/),
    due: labelledMoney(
      lines,
      /(?:[应上谈灾冰旋记尿永]付金[额领顷狐客倾]|应收金额|应付合计|应收合计|应结金额|应付|应收)/,
    ),
    rounding: labelledMoney(lines, /(?:抹零金额|抹零|舍零金额)/, true),
    paid: labelledMoney(
      lines,
      /(?:支付合计|支付会计|支付总计|实收金额|实收合计|实际收款|实付款|实付金额|实际支付|实付合计|实收|实付)/,
    ),
  };
  const warnings: string[] = [];
  if (
    totals.due &&
    !lines.some((line) =>
      /应付金额|应收金额|应付合计|应收合计|应结金额/.test(line.compact),
    )
  )
    warnings.push("应付金额的标签存在识别错字，请重点核对原图。");
  if (
    totals.rounding &&
    !totals.rounding.startsWith("-") &&
    !lines.some((line) => /抹零.{0,4}[+＋]/.test(line.compact))
  ) {
    totals.rounding = undefined;
    warnings.push("抹零正负方向未可靠识别，请对照原图补全。");
  }
  if (!items.length) warnings.push("尚未可靠提取项目明细，请对照原图补全。");
  if (items.some((item) => !item.quantity || item.amount === undefined))
    warnings.push(
      "部分项目数量或金额未识别；套餐子项可能未单独计价，请逐项核对，不要补成零。",
    );
  if (!totals.paid)
    warnings.push("未可靠识别实付合计，请对照支付区核对结算金额。");
  if (totals.paid && totals.due && totals.paid !== totals.due)
    warnings.push("应付与实付金额不同，请核对抹零、优惠或支付差额。");
  return {
    rawText,
    number: parseNumber(lines),
    store: parseStore(lines),
    occurredAt: parseDate(lines),
    amount: totals.paid || parseAmount(lines),
    itemsText: section.length ? section.join("\n") : undefined,
    payments: parsePayments(lines),
    items,
    totals,
    details: {
      cashier: labelled(lines, /(?:收银员|收款员|收很员|收人很员)\s*[:：,]?/),
      shift: labelled(lines, /(?:班次)\s*[:：,]?/),
      wristbands: unique(
        lines.flatMap((line) =>
          [
            ...line.compact.matchAll(
              /手牌[号码号]*[:：,]?([\d,、 ]{2,40})(?!\d)/g,
            ),
          ].map((match) => match[1]!.trim()),
        ),
      ),
      partySize: labelled(lines, /手牌总数\s*[:：,]?/),
      printCount: labelled(lines, /打印次[数效]\s*[:：,]?/),
      printedAt: unique(
        lines
          .filter((line) => /打印.{0,2}[间问]/.test(line.compact))
          .flatMap((line) => {
            const date = dateFromLine(line.original);
            return date ? [date] : [];
          }),
      ),
      printedBy: labelled(lines, /打印人\s*[:：,;；]?/),
      coupons: unique(
        lines.flatMap((line) =>
          [
            ...line.compact.matchAll(/券[码号]([:：,]?)([A-Za-z0-9-]{4,60})/g),
          ].map((match) => match[2]!),
        ),
      ),
    },
    warnings,
  };
}

/** Keep a reliable primary candidate when another image-processing pass is noisy. */
export function mergeReceiptPasses(passes: string[]): ReceiptOcrResult {
  const parsed = passes.filter(Boolean).map(parseReceiptText);
  const base = parsed[0]! || parseReceiptText("");
  const result: ReceiptOcrResult = {
    ...base,
    rawText: passes
      .map((text, index) =>
        index ? `【补充识别第${index}轮】\n${text}` : text,
      )
      .join("\n"),
    totals: {},
    details: {},
    warnings: [...new Set(parsed.flatMap((page) => page.warnings || []))],
  };
  for (const key of ["number", "store", "occurredAt", "amount"] as const) {
    const values = parsed
      .map((page) => page[key]!)
      .filter((value): value is string => !!value);
    result[key] = values[0]!;
    if (new Set(values).size > 1)
      result.warnings!.push(
        `${{ number: "单号", store: "门店", occurredAt: "时间", amount: "结算金额" }[key]!}在不同识别轮次中不一致，请对照原图核对。`,
      );
  }
  for (const key of ["subtotal", "due", "rounding", "paid"] as const) {
    const values = parsed
      .map((page) => page.totals?.[key]!)
      .filter((value): value is string => !!value);
    result.totals![key] = values[0]!;
    if (new Set(values).size > 1)
      result.warnings!.push(
        `${{ subtotal: "小计", due: "应付金额", rounding: "抹零金额", paid: "实付金额" }[key]!}存在多个识别候选，请核对原图。`,
      );
  }
  for (const key of [
    "cashier",
    "shift",
    "wristbands",
    "partySize",
    "printCount",
    "printedAt",
    "printedBy",
    "coupons",
  ] as const)
    result.details![key] = parsed
      .map((page) => page.details?.[key]!)
      .find(Boolean);
  result.amount = result.totals?.paid || result.amount;
  result.payments = parsed
    .map((page) => page.payments)
    .find((payments) => payments?.length);
  return result;
}

export type OcrBox = { x0: number; y0: number; x1: number; y1: number };
export type OcrWord = { text: string; bbox: OcrBox; confidence?: number };
export type OcrLine = { text: string; bbox: OcrBox; words?: OcrWord[] };
export type OcrPage = {
  text: string;
  blocks?: Array<{ paragraphs?: Array<{ lines?: OcrLine[] }> }>;
};
export type ReceiptTableRegion = {
  top: number;
  bottom: number;
  quantityLeft: number;
  quantityRight: number;
  amountLeft: number;
  amountRight: number;
  width: number;
};
function layoutLines(page: OcrPage): OcrLine[] {
  return (page.blocks || []).flatMap((block) =>
    (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || []),
  );
}

/** Finds columns from OCR coordinates, never from a particular store/template. */
export function receiptTableRegion(
  page: OcrPage,
  width: number,
  height: number,
): ReceiptTableRegion | undefined {
  const lines = layoutLines(page);
  const header = lines.find(
    (line) =>
      /项目|品名|商品|名称|项.{0,3}名/.test(line.text.replace(/\s/g, "")) &&
      /数量|单价|金额|优惠|优.{0,2}价|级昌|的有|故昌/.test(
        line.text.replace(/\s/g, ""),
      ),
  );
  if (!header) return undefined;
  const following = lines.filter((line) => line.bbox.y0 > header.bbox.y1);
  const footer = following.find((line) =>
    /^(?:小计|合计|总计|抹零|应付|应收|实付|实收|支付方式)/.test(
      line.text.replace(/^[|丨‖\s]+/, "").replace(/\s/g, ""),
    ),
  );
  let top = header.bbox.y1 + 4;
  const entry = following.find((line) =>
    /记入场|入场[:：]|手牌号/.test(line.text.replace(/\s/g, "")),
  );
  if (entry && entry.bbox.y0 < top + height * 0.12) top = entry.bbox.y1 + 4;
  const bottom = footer?.bbox.y0 || height * 0.9;
  const quantityWords = following
    .filter((line) => line.bbox.y0 < bottom)
    .flatMap((line) => line.words || [])
    .filter(
      (word) =>
        /^\d{1,3}(?:\.\d+)?$/.test(word.text) &&
        word.bbox.x0 > width * 0.4 &&
        word.bbox.x1 < width * 0.72,
    );
  const headerQuantity = (header.words || []).find(
    (word) => word.bbox.x0 > width * 0.38 && word.bbox.x1 < width * 0.72,
  );
  if ((!quantityWords.length && !headerQuantity) || bottom - top < 60)
    return undefined;
  const centers = quantityWords
    .map((word) => (word.bbox.x0 + word.bbox.x1) / 2)
    .sort((a, b) => a - b);
  const center =
    centers.length >= 2
      ? centers[Math.floor(centers.length / 2)]!
      : headerQuantity
        ? (headerQuantity.bbox.x0 + headerQuantity.bbox.x1) / 2
        : centers[0]!;
  return {
    top: Math.round(top),
    bottom: Math.round(bottom),
    quantityLeft: Math.round(center - width * 0.045),
    quantityRight: Math.round(center + width * 0.045),
    amountLeft: Math.round(width * 0.74),
    amountRight: Math.round(width * 0.92),
    width,
  };
}

/** Quantity baselines keep wrapped names and unpriced package children separate. */
export function receiptItemsFromColumns(
  page: OcrPage,
  quantityPage: OcrPage,
  amountPage: OcrPage,
  region: ReceiptTableRegion,
  namePage?: OcrPage,
): NonNullable<ReceiptOcrResult["items"]> {
  const quantities = layoutLines(quantityPage)
    .flatMap((line) =>
      line.words?.length
        ? line.words
        : [{ text: line.text.trim(), bbox: line.bbox }],
    )
    .filter(
      (word) =>
        /^\d{1,3}(?:\.\d{1,3})?$/.test(word.text) &&
        word.bbox.y0 >= region.top &&
        word.bbox.y1 <= region.bottom,
    )
    .sort((a, b) => a.bbox.y0 - b.bbox.y0);
  if (!quantities.length) return [];
  const centers = quantities.map((word) => (word.bbox.y0 + word.bbox.y1) / 2);
  const lines = layoutLines(namePage || page).filter(
    (line) =>
      line.bbox.y0 >= region.top &&
      line.bbox.y0 < region.bottom &&
      !/记入场|入场[:：]|手牌号/.test(line.text.replace(/\s/g, "")),
  );
  const amounts = layoutLines(amountPage).flatMap((line) =>
    line.words?.length
      ? line.words
      : [{ text: line.text.trim(), bbox: line.bbox }],
  );
  const wholePageAmounts = layoutLines(page)
    .flatMap((line) => line.words || [])
    .filter(
      (word) =>
        word.bbox.x0 >= region.amountLeft &&
        /^\d[\d,]*\.\d{2}$/.test(word.text),
    );
  const items = quantities.flatMap((quantity, index) => {
    const low = index
      ? (centers[index - 1]! + centers[index]!) / 2
      : region.top;
    const high =
      index < quantities.length - 1
        ? (centers[index]! + centers[index + 1]!) / 2
        : Math.min(
            region.bottom,
            centers[index]! + Math.max(24, quantity.bbox.y1 - quantity.bbox.y0),
          );
    const ownLines = lines.filter((line) => {
      const y = (line.bbox.y0 + line.bbox.y1) / 2;
      return y >= low && y < high;
    });
    const name = ownLines
      .map((line) =>
        (line.words?.length
          ? line.words
              .filter((word) => word.bbox.x0 < region.quantityLeft)
              .map((word) => word.text)
              .join("")
          : line.text.replace(/\s+\d.*$/, "")
        ).trim(),
      )
      .filter(Boolean)
      .join("")
      .replace(/^[|丨‖]+|[|丨‖]+$/g, "");
    if (!name || !/[\u3400-\u9fffA-Za-z]/.test(name)) return [];
    const candidates = [...amounts, ...wholePageAmounts]
      .filter(
        (word) =>
          /^\d[\d,]*\.\d{2}$/.test(word.text) &&
          Math.abs((word.bbox.y0 + word.bbox.y1) / 2 - centers[index]!) <=
            Math.max(20, (quantity.bbox.y1 - quantity.bbox.y0) * 0.85),
      )
      .map((word) => word.text.replace(/,/g, ""));
    const amount = unique(candidates);
    return [
      {
        name,
        quantity: quantity.text,
        ...(amount === undefined ? {} : { amount }),
        rawText: ownLines.map((line) => line.text.trim()).join("\n"),
      },
    ];
  });
  for (let index = 1; index < items.length; index++) {
    const lines = items[index]!.rawText.split("\n"),
      first = lines[0]!.replace(/\s/g, "");
    if (
      lines.length > 1 &&
      /^限.{0,15}(?:食|用|饮|只|份)/.test(first) &&
      !/\d+\.\d{2}/.test(first) &&
      items[index]!.name.startsWith(first)
    ) {
      items[index - 1]!.name += first;
      items[index - 1]!.rawText += `\n${lines[0]!}`;
      items[index]!.name = items[index]!.name.slice(first.length);
      items[index]!.rawText = lines.slice(1).join("\n");
    }
  }
  return items;
}

type LocalOcrWorker = {
  setParameters(parameters: {
    tessedit_pageseg_mode: string | number;
    preserve_interword_spaces?: string;
    tessedit_char_whitelist?: string;
    user_defined_dpi?: string;
  }): Promise<unknown>;
  recognize(
    image: HTMLCanvasElement,
    options?: {
      rectangle: { left: number; top: number; width: number; height: number };
    },
    output?: { text: boolean; blocks: boolean },
  ): Promise<{ data: OcrPage }>;
  reinitialize(languages: string | string[]): Promise<unknown>;
  terminate(): Promise<unknown>;
};

const itemRows = new WeakMap<object, OcrBox>();
/** Only normalize separated decimal digits in the proven price column/row. */
export function supplementReceiptAmounts(
  items: NonNullable<ReceiptOcrResult["items"]>,
  page: OcrPage,
  width: number,
): string[] {
  const warnings: string[] = [];
  for (let index = 0; index < items.length; index++) {
    if (items[index]!.amount !== undefined) continue;
    const row = itemRows.get(items[index]!);
    if (!row) continue;
    const center = (row.y0 + row.y1) / 2;
    const candidates: Array<{
      amount: string;
      source: string;
      decimalCandidate: boolean;
    }> = [];
    for (const line of layoutLines(page)) {
      const words = (line.words || [])
        .filter(
          (word) =>
            word.bbox.x0 >= width * 0.72 &&
            word.bbox.x1 <= width * 0.95 &&
            Math.abs((word.bbox.y0 + word.bbox.y1) / 2 - center) <=
              Math.max(18, (row.y1 - row.y0) * 1.1),
        )
        .sort((a, b) => a.bbox.x0 - b.bbox.x0);
      if (!words.length) continue;
      const text = words
        .map((word) => word.text)
        .join(" ")
        .trim();
      if (/^\d[\d,]*\.\d{2}$/.test(text))
        candidates.push({
          amount: text.replace(/,/g, ""),
          source: text,
          decimalCandidate: false,
        });
      else {
        const spaced = /^(\d{1,9})\s+(\d{2})$/.exec(text);
        if (spaced)
          candidates.push({
            amount: `${spaced[1]!}.${spaced[2]!}`,
            source: text,
            decimalCandidate: true,
          });
      }
    }
    const amount = unique(candidates.map((candidate) => candidate.amount));
    if (amount === undefined) continue;
    items[index]!.amount = amount;
    const evidence = candidates.find(
      (candidate) => candidate.amount === amount,
    )!;
    items[index]!.rawText +=
      `\n${evidence.decimalCandidate ? "金额小数点候选" : "金额补充识别"}：${evidence.source}${evidence.decimalCandidate ? ` → ${amount}` : ""}`;
    if (evidence.decimalCandidate)
      warnings.push(
        `第${index + 1}项金额识别为“${evidence.source}”，小数点候选为${amount}元，请对照原图核对后再确认。`,
      );
  }
  return warnings;
}

/** Shared by the browser and the real-image CLI check. */
export async function recognizeReceiptTable(
  worker: LocalOcrWorker,
  image: HTMLCanvasElement,
  width: number,
  height: number,
  page: OcrPage,
  onStage?: (stage: number) => void,
): Promise<NonNullable<ReceiptOcrResult["items"]>> {
  const table = receiptTableRegion(page, width, height);
  if (!table) return [];
  try {
    onStage?.(1);
    await worker.reinitialize("chi_sim");
    await worker.setParameters({
      tessedit_pageseg_mode: 6,
      tessedit_char_whitelist: "",
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    const left = Math.round(width * 0.05);
    const names = await limited(
      worker.recognize(
        image,
        {
          rectangle: {
            left,
            top: table.top,
            width: Math.max(
              30,
              table.quantityLeft - left - Math.round(width * 0.015),
            ),
            height: table.bottom - table.top,
          },
        },
        { text: true, blocks: true },
      ),
      60000,
      "项目名称识别超时，请对照原图补全",
    );
    await worker.reinitialize("eng");
    await worker.setParameters({
      tessedit_pageseg_mode: 6,
      tessedit_char_whitelist: "0123456789.-",
      user_defined_dpi: "300",
    });
    onStage?.(2);
    const quantities = await limited(
      worker.recognize(
        image,
        {
          rectangle: {
            left: table.quantityLeft,
            top: table.top,
            width: table.quantityRight - table.quantityLeft,
            height: table.bottom - table.top,
          },
        },
        { text: true, blocks: true },
      ),
      45000,
      "项目数量复核超时，请对照原图核对",
    );
    const prices = await limited(
      worker.recognize(
        image,
        {
          rectangle: {
            left: table.amountLeft,
            top: table.top,
            width: table.amountRight - table.amountLeft,
            height: table.bottom - table.top,
          },
        },
        { text: true, blocks: true },
      ),
      45000,
      "项目金额复核超时，请对照原图核对",
    );
    const items = receiptItemsFromColumns(
      page,
      quantities.data,
      prices.data,
      table,
      names.data,
    );
    const quantityRows = layoutLines(quantities.data)
      .flatMap((line) =>
        line.words?.length
          ? line.words
          : [{ text: line.text.trim(), bbox: line.bbox }],
      )
      .filter((word) => /^\d{1,3}(?:\.\d{1,3})?$/.test(word.text))
      .sort((a, b) => a.bbox.y0 - b.bbox.y0);
    if (quantityRows.length === items.length) {
      items.forEach((item, index) =>
        itemRows.set(item, quantityRows[index]!.bbox),
      );
      await worker.setParameters({ tessedit_pageseg_mode: 7 });
      for (let index = 0; index < items.length; index++)
        if (items[index]!.amount === undefined) {
          const box = quantityRows[index]!.bbox,
            padding = Math.max(8, Math.round((box.y1 - box.y0) * 0.4)),
            top = Math.max(0, box.y0 - padding);
          const result = await limited(
            worker.recognize(image, {
              rectangle: {
                left: table.amountLeft,
                top,
                width: table.amountRight - table.amountLeft,
                height: Math.min(height - top, box.y1 - box.y0 + padding * 2),
              },
            }),
            15000,
            "单项金额复核超时，请对照原图补全",
          );
          const value = result.data.text.trim();
          if (/^\d[\d,]*\.\d{2}$/.test(value)) {
            items[index]!.amount = value.replace(/,/g, "");
            items[index]!.rawText += `\n金额局部复核：${value}`;
          }
        }
    }
    return items;
  } finally {
    await worker.reinitialize(["chi_sim", "eng"]);
    await worker.setParameters({
      tessedit_pageseg_mode: 6,
      tessedit_char_whitelist: "",
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
  }
}
type LocalTesseract = {
  createWorker(
    languages: string[],
    mode: number,
    options: {
      workerPath: string;
      corePath: string;
      langPath: string;
      workerBlobURL: boolean;
      logger: (event: { status: string; progress: number }) => void;
    },
  ): Promise<LocalOcrWorker>;
  PSM: { AUTO: string | number };
};
declare global {
  interface Window {
    Tesseract?: LocalTesseract;
  }
}

let enginePromise: Promise<LocalTesseract> | undefined;
/** Load only the vendored same-origin official bundle. A failed load is retryable. */
function loadScript(): Promise<LocalTesseract> {
  if (typeof window === "undefined")
    return Promise.reject(new Error("请在浏览器中加载小票识别"));
  if (
    typeof window.Tesseract?.createWorker === "function" &&
    window.Tesseract.PSM?.AUTO !== undefined
  )
    return Promise.resolve(window.Tesseract);
  if (enginePromise) return enginePromise;
  enginePromise = new Promise<LocalTesseract>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL(
      "/concierge/ocr/tesseract.min.js",
      window.location.origin,
    ).href;
    script.async = true;
    script.dataset.receiptOcrEngine = "local";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      script.remove();
      enginePromise = undefined;
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail("识别引擎加载超时，请检查网络后重试"),
      45000,
    );
    script.onload = () => {
      if (settled) return;
      if (
        typeof window.Tesseract?.createWorker !== "function" ||
        window.Tesseract.PSM?.AUTO === undefined
      ) {
        fail("识别引擎未正确加载，请刷新页面后重试");
        return;
      }
      settled = true;
      cleanup();
      resolve(window.Tesseract);
    };
    script.onerror = () => fail("识别引擎下载失败，请检查网络后重试");
    (document.head || document.documentElement).appendChild(script);
  });
  return enginePromise;
}

let recognitionRunning = false;
function limited<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
async function imageForOcr(file: File): Promise<HTMLCanvasElement> {
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let close = () => {};
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
    close = () => bitmap.close();
  } else {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await limited(
        image.decode(),
        30000,
        "图片解码超时，请重新拍摄或选择较小照片",
      );
      source = image;
      width = image.naturalWidth;
      height = image.naturalHeight;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  try {
    if (!width || !height) throw new Error("无法读取这张图片，请重新拍摄");
    // Limit phone memory use. The original file is retained unchanged by the caller.
    const scale = Math.min(
      1,
      10000 / Math.max(width, height),
      Math.sqrt(5000000 / (width * height)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理图片，请更换浏览器后重试");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const bounds = receiptPaperBounds(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width,
      canvas.height,
    );
    const enlargement = Math.min(
      2,
      Math.sqrt(5000000 / (bounds.width * bounds.height)),
      10000 / Math.max(bounds.width, bounds.height),
    );
    const cropped = document.createElement("canvas");
    cropped.width = Math.max(1, Math.round(bounds.width * enlargement));
    cropped.height = Math.max(1, Math.round(bounds.height * enlargement));
    const output = cropped.getContext("2d");
    if (!output) return canvas;
    output.fillStyle = "#ffffff";
    output.fillRect(0, 0, cropped.width, cropped.height);
    output.imageSmoothingEnabled = true;
    output.imageSmoothingQuality = "high";
    output.drawImage(
      canvas,
      bounds.left,
      bounds.top,
      bounds.width,
      bounds.height,
      0,
      0,
      cropped.width,
      cropped.height,
    );
    canvas.width = 0;
    canvas.height = 0;
    return cropped;
  } finally {
    close();
  }
}

/** Remove a dark/saturated table around a lighter paper; white backgrounds stay intact. */
export function receiptPaperBounds(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const full = { left: 0, top: 0, width, height };
  const columns = new Uint32Array(width),
    rows = new Uint32Array(height),
    step = 4;
  for (let y = 0; y < height; y += step)
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4,
        red = data[i]!,
        green = data[i + 1]!,
        blue = data[i + 2]!,
        max = Math.max(red, green, blue),
        min = Math.min(red, green, blue);
      if (max > 100 && (max - min) / max < 0.48) {
        columns[x]!++;
        rows[y]!++;
      }
    }
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let x = 0; x < width; x += step)
    if (columns[x]! > (height / step) * 0.2) {
      left = Math.min(left, x);
      right = x;
    }
  for (let y = 0; y < height; y += step)
    if (rows[y]! > (width / step) * 0.2) {
      top = Math.min(top, y);
      bottom = y;
    }
  if (
    right < left ||
    bottom < top ||
    (right - left) * (bottom - top) < width * height * 0.15 ||
    right - left < width * 0.18
  )
    return full;
  const margin = Math.max(8, Math.round(Math.min(width, height) * 0.012));
  left = Math.max(0, left - margin);
  right = Math.min(width - 1, right + margin);
  top = Math.max(0, top - margin);
  bottom = Math.min(height - 1, bottom + margin);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/** Local illumination correction for a supplementary pass; original pixels stay intact. */
export function receiptContrastPixels(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const gray = new Uint8Array(width * height),
    integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const value = Math.round(
        0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!,
      );
      gray[y * width + x] = value;
      sum += value;
      integral[(y + 1) * (width + 1) + x + 1] =
        integral[y * (width + 1) + x + 1]! + sum;
    }
  }
  const result = new Uint8ClampedArray(data.length),
    radius = Math.max(12, Math.round(width / 40));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius),
        x1 = Math.min(width, x + radius + 1),
        y0 = Math.max(0, y - radius),
        y1 = Math.min(height, y + radius + 1);
      const sum =
        integral[y1 * (width + 1) + x1]! -
        integral[y0 * (width + 1) + x1]! -
        integral[y1 * (width + 1) + x0]! +
        integral[y0 * (width + 1) + x0]!;
      const value = Math.max(
          0,
          Math.min(
            255,
            Math.round(
              (gray[y * width + x]! - sum / ((x1 - x0) * (y1 - y0))) * 2.2 +
                230,
            ),
          ),
        ),
        i = (y * width + x) * 4;
      result[i] = value;
      result[i + 1] = value;
      result[i + 2] = value;
      result[i + 3] = 255;
    }
  return result;
}

/**
 * Progress uses 0..1. Images are recognized in order using one worker to limit
 * phone memory use. Local OCR does not prove payment or update any balance.
 */
export async function runReceiptOcr(
  files: File[],
  onProgress: (progress: number, message?: string) => void,
): Promise<ReceiptOcrResult> {
  if (typeof window === "undefined")
    throw new Error("请在手机或电脑浏览器中进行图片识别");
  if (recognitionRunning) throw new Error("已有小票正在识别，请等待完成后再试");
  if (!files.length || files.length > 6)
    throw new Error("请选择1至6张属于同一小票的照片");
  for (const file of files) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new Error(
        "请使用JPEG、PNG或WebP照片；不支持的相册格式请转换或重新拍摄",
      );
    if (file.size > 15 * 1024 * 1024)
      throw new Error("单张照片超过15MB，请选择较小照片或分段拍摄");
    if (!file.size) throw new Error("照片内容为空，请重新选择");
  }
  recognitionRunning = true;
  let lastProgress = 0;
  let imageIndex = -1;
  let passIndex = 0;
  let worker: LocalOcrWorker | undefined;
  let nameSession:
    | import("./receipt-name-ocr").ReceiptNameOcrSession
    | undefined;
  const report = (progress: number, message: string) => {
    lastProgress = Math.max(lastProgress, Math.min(1, Math.max(0, progress)));
    try {
      onProgress(lastProgress, message);
    } catch {
      /* A UI callback must not leak a worker. */
    }
  };
  try {
    report(0, "正在加载本机识别引擎，首次使用需要下载模型");
    const { createWorker } = await loadScript();
    const origin = window.location.origin;
    const creation = createWorker(["chi_sim", "eng"], 1, {
      workerPath: `${origin}/concierge/ocr/worker.min.js`,
      corePath: `${origin}/concierge/ocr/core`,
      langPath: `${origin}/concierge/ocr/lang`,
      workerBlobURL: false,
      logger: (event: { status: string; progress: number }) => {
        if (event.status === "recognizing text" && imageIndex >= 0) {
          report(
            Math.min(
              0.97,
              0.1 +
                0.86 *
                  ((imageIndex + (passIndex + event.progress) / 4) /
                    files.length),
            ),
            `正在识别第${imageIndex + 1}/${files.length}张小票 · ${["票面文字", "项目名称", "项目数量与金额", "支付与合计复核"][passIndex]! || "票面复核"}`,
          );
        } else if (imageIndex < 0)
          report(
            Math.min(0.09, (event.progress || 0) * 0.09),
            "正在加载本机识别引擎",
          );
      },
    });
    try {
      worker = await limited(
        creation,
        120000,
        "识别引擎加载超时，请检查网络后重试；已上传的凭证可稍后继续",
      );
    } catch (error) {
      void creation
        .then((lateWorker) => lateWorker.terminate())
        .catch(() => {});
      throw error;
    }
    const results: string[] = [];
    const pageResults: ReceiptOcrResult[] = [];
    const tableItems: NonNullable<ReceiptOcrResult["items"]> = [];
    for (let index = 0; index < files.length; index++) {
      imageIndex = index;
      passIndex = 0;
      report(
        0.1 + 0.86 * (index / files.length),
        `正在准备第${index + 1}/${files.length}张照片`,
      );
      const canvas = await limited(
        imageForOcr(files[index]!),
        30000,
        "图片处理超时，请选择较小照片后重试",
      );
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: 6,
          preserve_interword_spaces: "1",
          tessedit_char_whitelist: "",
          user_defined_dpi: "300",
        });
        const result = await limited(
          worker.recognize(canvas, undefined, { text: true, blocks: true }),
          120000,
          `第${index + 1}张识别超时，请补拍清晰照片或稍后重试`,
        );
        const passes = [result.data.text.trim()];
        const amountWarnings: string[] = [];
        const table = receiptTableRegion(
          result.data,
          canvas.width,
          canvas.height,
        );
        let nameLayoutPage = result.data;
        let items = await recognizeReceiptTable(
          worker,
          canvas,
          canvas.width,
          canvas.height,
          result.data,
          (stage) => {
            passIndex = stage;
          },
        );
        amountWarnings.push(
          ...supplementReceiptAmounts(items, result.data, canvas.width),
        );
        const initial = parseReceiptText(passes[0]!);
        if (
          !initial.totals?.paid ||
          !initial.payments?.length ||
          !initial.totals?.due ||
          !initial.totals?.subtotal ||
          !items.length ||
          items.some((item) => item.amount === undefined)
        ) {
          passIndex = 3;
          // A smaller unaltered lower section often preserves decimal points
          // that a full-page layout pass omitted. Never derive totals by math.
          const lowerTop = Math.max(
            0,
            Math.round(
              (table?.bottom || canvas.height * 0.73) - canvas.height * 0.075,
            ),
          );
          const left = Math.round(canvas.width * 0.03),
            right = Math.round(canvas.width * 0.92);
          const lower = await limited(
            worker.recognize(canvas, {
              rectangle: {
                left,
                top: lowerTop,
                width: right - left,
                height: canvas.height - lowerTop,
              },
            }),
            60000,
            "合计区识别超时，请对照原图补全",
          );
          passes.push(lower.data.text.trim());
          const enhanced = document.createElement("canvas");
          enhanced.width = canvas.width;
          enhanced.height = canvas.height;
          const context = canvas.getContext("2d"),
            output = enhanced.getContext("2d");
          if (context && output) {
            const pixels = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
            pixels.data.set(
              receiptContrastPixels(pixels.data, canvas.width, canvas.height),
            );
            output.putImageData(pixels, 0, 0);
            try {
              await worker.setParameters({
                tessedit_pageseg_mode: 6,
                tessedit_char_whitelist: "",
              });
              const extra = await limited(
                worker.recognize(enhanced, undefined, {
                  text: true,
                  blocks: true,
                }),
                90000,
                "支付区复核超时，请对照原图核对金额",
              );
              // Supplementary text remains visible as evidence. Structured items
              // come from the table column pass, so a second pass cannot double them.
              passes.push(extra.data.text.trim());
              if (!items.length) {
                items = await recognizeReceiptTable(
                  worker,
                  canvas,
                  canvas.width,
                  canvas.height,
                  extra.data,
                  (stage) => {
                    passIndex = stage;
                  },
                );
                nameLayoutPage = extra.data;
              }
              amountWarnings.push(
                ...supplementReceiptAmounts(items, extra.data, canvas.width),
              );
            } finally {
              enhanced.width = 0;
              enhanced.height = 0;
            }
          }
        }
        if (items.length) {
          try {
            const {
              ReceiptNameOcrSession,
              planReceiptNameLines,
              applyReceiptNameLines,
            } = await import("./receipt-name-ocr");
            const nameTable = receiptTableRegion(
              nameLayoutPage,
              canvas.width,
              canvas.height,
            );
            const jobs = nameTable
              ? planReceiptNameLines(
                  nameLayoutPage,
                  nameTable,
                  items.map((item) => itemRows.get(item)),
                  canvas.width,
                  canvas.height,
                )
              : [];
            if (jobs.length) {
              nameSession ||= new ReceiptNameOcrSession();
              report(
                Math.min(0.97, 0.94 + 0.03 * ((index + 0.1) / files.length)),
                "正在加载本机中文名称增强，首次使用稍慢",
              );
              const names = await nameSession.recognize(
                canvas,
                jobs,
                (done, total) =>
                  report(
                    Math.min(
                      0.97,
                      0.94 + 0.03 * ((index + done / total) / files.length),
                    ),
                    `正在核对第${index + 1}张小票项目名称（${done}/${total}行）`,
                  ),
              );
              amountWarnings.push(...applyReceiptNameLines(items, names));
            } else
              amountWarnings.push(
                "本次项目名称定位不足，已保留首次识别名称，请对照原图核对名称。",
              );
          } catch {
            amountWarnings.push(
              "本机中文名称增强暂不可用，已保留首次识别名称，请核对项目名称。",
            );
          }
        }
        const pageResult = mergeReceiptPasses(passes);
        pageResult.warnings = [
          ...(pageResult.warnings || []),
          ...amountWarnings,
        ];
        if (items.length) tableItems.push(...items);
        else tableItems.push(...(pageResult.items || []));
        pageResults.push(pageResult);
        results.push(`【第 ${index + 1} 张】\n${pageResult.rawText}`);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    const rawText = results.join("\n\n");
    if (!results.some((text) => text.replace(/【第 \d+ 张】/g, "").trim()))
      throw new Error("没有识别到可读文字，请补拍清晰、完整的小票");
    if (rawText.length > 60000)
      throw new Error("识别文字过长，请按不同小票分开处理，避免误合并");
    const parsed = parseReceiptText(rawText);
    for (const key of ["number", "store", "occurredAt", "amount"] as const)
      parsed[key] = unique(
        pageResults.flatMap((page) => (page[key]! ? [page[key]!] : [])),
      );
    parsed.totals = {};
    for (const key of ["subtotal", "due", "rounding", "paid"] as const)
      parsed.totals[key] = unique(
        pageResults.flatMap((page) =>
          page.totals?.[key]! ? [page.totals[key]!] : [],
        ),
      );
    parsed.details = pageResults[0]!?.details;
    parsed.payments = pageResults
      .map((page) => page.payments)
      .find((payments) => payments?.length);
    parsed.warnings = pageResults.flatMap((page) => page.warnings || []);
    if (tableItems.length) {
      parsed.items = tableItems;
      parsed.itemsText = tableItems.map((item) => item.rawText).join("\n\n");
      parsed.warnings = (parsed.warnings || []).filter(
        (warning) => !/尚未可靠提取项目/.test(warning),
      );
      if (tableItems.some((item) => item.amount === undefined))
        parsed.warnings.push(
          "有项目未单独识别到金额；套餐子项可能不单独计价，请对照原图确认。",
        );
    }
    parsed.warnings = [
      ...new Set([
        ...(parsed.warnings || []),
        "项目名称、收银员及打印人可能存在错字，请对照原始小票逐项核对。",
      ]),
    ];
    if (files.length > 1)
      parsed.warnings.push(
        "分段照片可能包含重叠项目，请对照原图核对并移除重复行；系统不会按同名同价自动删除。",
      );
    report(1, "识别完成，请逐项核对会员、单号、日期、金额及支付信息");
    return parsed;
  } catch (error) {
    report(lastProgress, "识别未完成，原图保留，可补拍或重试");
    if (
      error instanceof Error &&
      /超时|图片|照片|可读文字|过长|小票|浏览器/.test(error.message)
    )
      throw error;
    throw new Error("本机识别暂时失败，请检查网络、补拍清晰照片或稍后重试");
  } finally {
    if (nameSession) await nameSession.dispose().catch(() => {});
    if (worker) await worker.terminate().catch(() => {});
    recognitionRunning = false;
  }
}
