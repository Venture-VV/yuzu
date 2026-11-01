// 旧账核验（v0.7.10）：按「账目问题清单」的结构与口径重算（见 docs/LEGACY_LEDGER.md 第 6、7 节）。
// 纯计算：导入预览（内存里的解析结果）与页面（数据库里的只读表）用同一个函数，结果一致。

import {
  LEGACY_RULES,
  LEGACY_SOURCE_LABELS,
  legacyLedgerKind,
  type LegacyAudit,
  type LegacyBrandLine,
  type LegacyDailyRow,
  type LegacyFinding,
  type LegacyLedgerLine,
  type LegacyMaterialLine,
  type LegacyOrderedLine,
  type LegacyOverviewRow,
  type LegacyPaymentDay,
  type LegacyRowRef,
  type LegacyRuleResult,
  type LegacySource,
} from '@shared/legacy';
import { formatYuan } from '@shared/money';

export interface LegacyData {
  imported: LegacySource[];
  ledger: LegacyLedgerLine[];
  /** 采购台账第 1 张表的名称 */
  ledgerSheet: string;
  payments: LegacyPaymentDay[];
  paymentSheet: string;
  materials: LegacyMaterialLine[];
  /** 采购物资明细表的每张月份表（含没有内容的表） */
  materialSheets: { name: string; rows: number }[];
  ordered: (Omit<LegacyOrderedLine, 'imageId' | 'raw'> & { hasImage: boolean })[];
  brand: LegacyBrandLine[];
  brandSheet: string;
  /** 品牌清单表头之后表格里写出来的行数（含空行），没有导入为 null */
  brandTableRows: number | null;
}

/** 每条最多列多少行（另给总数） */
const MAX_ROWS = 300;

const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);
const y = formatYuan;
const range = (dates: (string | null)[]) => {
  const ds = dates.filter((d): d is string => !!d).sort();
  return ds.length ? (ds[0] === ds[ds.length - 1] ? ds[0]! : `${ds[0]} ~ ${ds[ds.length - 1]!.slice(5)}`) : '—';
};
/** 「8月」「09月」→ 8；认不出月份的表为 null */
const sheetMonth = (name: string) => {
  const m = /(\d{1,2})\s*月/.exec(name);
  return m ? Number(m[1]) : null;
};
const monthOf = (date: string | null) => (date ? Number(date.slice(5, 7)) : null);

function finding(key: string, title: string, detail: string, rows: LegacyRowRef[] = [], count: number | null = rows.length): LegacyFinding {
  return { key, title, detail, count, rows: rows.slice(0, MAX_ROWS) };
}

export function legacyAudit(d: LegacyData): LegacyAudit {
  const has = (s: LegacySource) => d.imported.includes(s);
  const notImported = (s: LegacySource) => `「${LEGACY_SOURCE_LABELS[s]}」还没有导入`;

  // ── 采购台账 ──
  const L = d.ledger.filter((l) => !l.preHeader);
  const kinds = L.map((l) => ({ l, k: legacyLedgerKind(l) }));
  const ledgerRef = (l: LegacyLedgerLine, why: string): LegacyRowRef => ({
    source: 'purchase_ledger',
    sheet: d.ledgerSheet,
    rowNo: l.rowNo,
    text: `第 ${l.rowNo} 行${l.item ? `「${l.item}」` : ''}${l.amountCents !== null ? ` ${y(l.amountCents)}` : ''}：${why}`,
  });
  const expenses = kinds.filter((x) => x.k === 'expense').map((x) => x.l);
  const refunds = kinds.filter((x) => x.k === 'refund').map((x) => x.l);
  const payouts = kinds.filter((x) => x.k === 'payout').map((x) => x.l);
  const unclear = kinds.filter((x) => x.k === 'unclear').map((x) => x.l);
  const noAmount = L.filter((l) => l.amountCents === null);
  const noDate = L.filter((l) => l.date === null);
  const noCategory = L.filter((l) => !l.item);
  const expenseTotal = sum(expenses.map((l) => l.amountCents));
  const refundTotal = sum(refunds.map((l) => l.amountCents));
  const payoutTotal = sum(payouts.map((l) => l.amountCents));
  const netSpend = expenseTotal + refundTotal;
  const spendOf = (pred: (l: LegacyLedgerLine) => boolean) => sum([...expenses, ...refunds].filter(pred).map((l) => l.amountCents));

  // ── 付款台账 ──
  const P = d.payments.filter((p) => p.date !== null);
  const advanceTotal = sum(P.map((p) => p.advanceCents));
  const shouldTotal = sum(P.map((p) => p.shouldReturnCents));
  const returnedTotal = sum(P.map((p) => p.returnedCents));
  const payRef = (p: LegacyPaymentDay, why: string): LegacyRowRef => ({ source: 'purchase_ledger', sheet: d.paymentSheet, rowNo: p.rowNo, text: `${p.date ?? `第 ${p.rowNo} 行`}：${why}` });
  const shouldNoReturn = P.filter((p) => (p.shouldReturnCents ?? 0) > 0 && !(p.returnedCents ?? 0));

  // ── 采购物资明细表 ──
  const M = d.materials;
  const matRef = (m: LegacyMaterialLine, why: string): LegacyRowRef => ({
    source: 'material_detail',
    sheet: m.sheet,
    rowNo: m.rowNo,
    text: `「${m.sheet}」第 ${m.rowNo} 行${m.item ? `「${m.item}」` : ''}：${why}`,
  });
  const matTotal = sum(M.map((m) => m.amountCents));
  const matMonth = (m: LegacyMaterialLine) => sheetMonth(m.sheet) ?? monthOf(m.date);

  // ── 已下单物料 ──
  const O = d.ordered;
  const ordRef = (o: (typeof O)[number], why: string): LegacyRowRef => ({
    source: 'ordered_materials',
    sheet: o.sheet,
    rowNo: o.rowNo,
    text: `${o.date ?? `第 ${o.rowNo} 行`}「${o.product}」：${why}`,
  });
  const ordTotal = sum(O.map((o) => o.amountCents));

  // ── 品牌清单 ──
  const B = d.brand;
  const brandRef = (b: LegacyBrandLine, why: string): LegacyRowRef => ({ source: 'brand_requests', sheet: d.brandSheet, rowNo: b.rowNo, text: `第 ${b.rowNo} 行${b.product ? `「${b.product}」` : ''}：${why}` });
  const brandComplete = B.filter((b) => b.product && b.purpose && b.qtyMilli !== null && (b.linkUrl || b.linkText));
  const brandRows = d.brandTableRows ?? B.length;

  // ───────── 一、总览 ─────────
  const overview: LegacyOverviewRow[] = [];
  if (has('purchase_ledger')) {
    overview.push({
      source: 'purchase_ledger',
      label: '采购台账（费用报销明细）',
      rows: L.length,
      period: range(L.map((l) => l.date)),
      amountText: `${y(sum(L.map((l) => l.amountCents)))}（净）`,
      problems: `打款、支出、退款混在一列；${noAmount.length} 行无金额、${noDate.length} 行无日期、${noCategory.length} 行无类别`,
    });
    overview.push({
      source: 'purchase_ledger',
      label: '采购台账（付款台账）',
      rows: P.length,
      period: range(P.map((p) => p.date)),
      amountText: `打款 ${y(advanceTotal)} / 应退回 ${y(shouldTotal)} / 实际退回 ${y(returnedTotal)}`,
      problems:
        shouldTotal === returnedTotal ? '应退回与实际退回相等' : `应退回比实际退回${shouldTotal < returnedTotal ? '少' : '多'} ${y(Math.abs(returnedTotal - shouldTotal))}`,
    });
  }
  if (has('material_detail')) {
    const perSheet = d.materialSheets.map((s) => `${s.name} ${s.rows} 行`).join('、');
    const empty = d.materialSheets.filter((s) => s.rows === 0).map((s) => s.name);
    overview.push({
      source: 'material_detail',
      label: '采购物资明细表',
      rows: M.length,
      period: perSheet,
      amountText: y(matTotal),
      problems: [empty.length ? `${empty.join('、')}整月空白` : '', `用途列 ${M.filter((m) => !m.purpose).length}/${M.length} 未填`].filter(Boolean).join('；'),
    });
  }
  if (has('ordered_materials')) {
    overview.push({
      source: 'ordered_materials',
      label: '已下单物料',
      rows: O.length,
      period: range(O.map((o) => o.date)),
      amountText: y(ordTotal),
      problems: `备注 ${O.filter((o) => !o.note).length}/${O.length} 行空；图片是 WPS 单元格图（${O.filter((o) => o.hasImage).length} 行有图），导出即丢`,
    });
  }
  if (has('brand_requests')) {
    const qty = sum(B.map((b) => b.qtyMilli)) / 1000;
    overview.push({
      source: 'brand_requests',
      label: '品牌新增寻款采购清单',
      rows: brandRows,
      period: `有内容的 ${B.length} 行`,
      amountText: `数量合计 ${qty.toLocaleString('en-US')}`,
      problems: `${brandRows - brandComplete.length} 行缺链接 / 用途 / 数量；下单 ${B.filter((b) => b.ordered).length}、到货 ${B.filter((b) => b.received).length}、退货 ${B.filter((b) => b.returned).length}`,
    });
  }

  // ───────── 二、三套账之间的差额 ─────────
  const crossChecks: LegacyFinding[] = [];
  if (has('purchase_ledger')) {
    const payoutAbs = -payoutTotal;
    crossChecks.push(
      finding(
        'payout_vs_payment',
        '台账里记的打款 vs 付款台账',
        `台账 ${payouts.length} 行大额负数（推定打款）合计 ${y(payoutAbs)}，付款台账打款合计 ${y(advanceTotal)}，${advanceTotal >= payoutAbs ? `差 ${y(advanceTotal - payoutAbs)} 未进台账` : `台账多 ${y(payoutAbs - advanceTotal)}`}`,
        payouts.map((l) => ledgerRef(l, '推定打款')),
      ),
      finding(
        'spend_vs_payout',
        '支出与打款',
        `台账正数支出 ${y(expenseTotal)}，小额退款 ${y(-refundTotal)}，净支出 ${y(netSpend)}；打款 ${y(advanceTotal)}，${netSpend >= advanceTotal ? `支出比打款多 ${y(netSpend - advanceTotal)}` : `打款比支出多 ${y(advanceTotal - netSpend)}`}`,
        [],
        null,
      ),
      finding(
        'should_vs_returned',
        '应退回 vs 实际退回',
        `应退回 ${y(shouldTotal)}，实际退回出纳 ${y(returnedTotal)}，${returnedTotal >= shouldTotal ? `多退 ${y(returnedTotal - shouldTotal)}` : `少退 ${y(shouldTotal - returnedTotal)}`}；另有 ${shouldNoReturn.length} 天记录了应退回但没记实际退回，涉及 ${y(sum(shouldNoReturn.map((p) => p.shouldReturnCents)))}`,
        shouldNoReturn.map((p) => payRef(p, `应退回 ${y(p.shouldReturnCents ?? 0)}，没记实际退回`)),
      ),
    );
    if (has('material_detail')) {
      const ledgerAugSep = spendOf((l) => monthOf(l.date) === 8 || monthOf(l.date) === 9);
      const matAugSep = sum(M.filter((m) => matMonth(m) === 8 || matMonth(m) === 9).map((m) => m.amountCents));
      crossChecks.push(
        finding(
          'ledger_vs_material',
          '采购台账 vs 财务明细表（8–9 月）',
          `8–9 月台账净支出 ${y(ledgerAugSep)}，明细表 ${y(matAugSep)}，差 ${y(Math.abs(ledgerAugSep - matAugSep))}，没有对照表说明差异构成`,
          [],
          null,
        ),
      );
    }
    const octMat = M.filter((m) => matMonth(m) === 10);
    crossChecks.push(
      finding(
        'october',
        '10 月三张表',
        [
          has('material_detail') ? `明细表 10 月 ${octMat.length} 行` : notImported('material_detail'),
          has('ordered_materials') ? `已下单 ${y(sum(O.filter((o) => monthOf(o.date) === 10).map((o) => o.amountCents)))}` : notImported('ordered_materials'),
          `台账 10 月净支出 ${y(spendOf((l) => monthOf(l.date) === 10))}`,
        ].join('；'),
        [],
        null,
      ),
    );
  }

  // ───────── 三、每日平账 ─────────
  let daily: LegacyAudit['daily'] = null;
  if (has('purchase_ledger')) {
    const spendByDay = new Map<string, number>();
    for (const l of [...expenses, ...refunds]) if (l.date) spendByDay.set(l.date, (spendByDay.get(l.date) ?? 0) + (l.amountCents ?? 0));
    const days: LegacyDailyRow[] = P.map((p) => {
      const spend = spendByDay.get(p.date!) ?? 0;
      const diff = (p.advanceCents ?? 0) - spend - (p.shouldReturnCents ?? 0);
      const abs = Math.abs(diff);
      return {
        date: p.date!,
        advanceCents: p.advanceCents ?? 0,
        spendCents: spend,
        shouldReturnCents: p.shouldReturnCents ?? 0,
        returnedCents: p.returnedCents ?? 0,
        diffCents: diff,
        state: abs === 0 ? 'balanced' : abs < LEGACY_RULES.tailToleranceCents ? 'tail' : 'unbalanced',
      };
    });
    daily = {
      days,
      unbalanced: days.filter((x) => x.state === 'unbalanced').length,
      tail: days.filter((x) => x.state === 'tail').length,
      zeroAdvanceWithSpend: days.filter((x) => x.advanceCents === 0 && x.spendCents > 0).map((x) => x.date),
    };
  }

  // ───────── 四、字段与口径问题 ─────────
  const fieldIssues: LegacyFinding[] = [];
  if (has('purchase_ledger')) {
    fieldIssues.push(
      finding(
        'mixed_negatives',
        '负数混用',
        `台账「金额」一列里：${payouts.length} 行大额负数（推定打款）合计 ${y(-payoutTotal)}，${refunds.length} 行小额负数（推定退款）合计 ${y(-refundTotal)}${unclear.length ? `，${unclear.length} 行正好 ${y(-LEGACY_RULES.payoutThresholdCents)} 无法判断` : ''}；同一列两种含义，分不出「钱进来」和「退回来」`,
        [...payouts.map((l) => ledgerRef(l, '推定打款')), ...refunds.map((l) => ledgerRef(l, '推定退款')), ...unclear.map((l) => ledgerRef(l, '无法判断'))],
        payouts.length + refunds.length + unclear.length,
      ),
      finding(
        'ledger_missing',
        '台账必填缺失',
        `${noAmount.length} 行无金额（其中 ${noAmount.filter((l) => l.mergedInto !== null).length} 行是合并的金额格）、${noDate.length} 行无日期、${noCategory.length} 行无类别`,
        [...noAmount.map((l) => ledgerRef(l, l.mergedInto !== null ? `金额与第 ${l.mergedInto} 行合并` : '没有金额')), ...noDate.map((l) => ledgerRef(l, '没有日期')), ...noCategory.map((l) => ledgerRef(l, '没有类别'))],
      ),
    );
  }
  if (has('material_detail')) {
    const mNoAmount = M.filter((m) => m.amountCents === null);
    const mNoItem = M.filter((m) => !m.item);
    fieldIssues.push(
      finding('material_missing', '明细表必填缺失', `${mNoAmount.length} 行无金额、${mNoItem.length} 行无物品名`, [
        ...mNoAmount.map((m) => matRef(m, m.mergedInto !== null ? `金额与第 ${m.mergedInto} 行合并` : '没有金额')),
        ...mNoItem.map((m) => matRef(m, '没有物品名')),
      ]),
    );
    const combos = new Map<string, LegacyMaterialLine[]>();
    for (const m of M) {
      const key = `${m.invoice || '（空）'} ${m.taxRateBp !== null ? `${m.taxRateBp / 100}%` : m.taxText || '（空）'}`;
      combos.set(key, [...(combos.get(key) ?? []), m]);
    }
    const sorted = [...combos.entries()].sort((a, b) => b[1].length - a[1].length);
    const spellings = [...new Set(M.map((m) => m.invoice).filter(Boolean))];
    fieldIssues.push(
      finding(
        'invoice_tax',
        '发票与税点',
        `发票写法 ${spellings.length} 种（${spellings.join(' / ') || '—'}）；组合：${sorted.map(([k, v]) => `「${k}」${v.length} 行`).join('、')}`,
        sorted.flatMap(([k, v]) => v.map((m) => matRef(m, k))),
      ),
    );
    const cats = new Map<string, number>();
    for (const m of M) if (m.category) cats.set(m.category, (cats.get(m.category) ?? 0) + 1);
    fieldIssues.push(
      finding(
        'category_synonyms',
        '费用科目同义不同名',
        `「备注」列（费用科目）有 ${cats.size} 种写法：${[...cats.entries()].map(([k, v]) => `${k} ${v} 行`).join('、')}；新账只有办公费、固定资产、低值易耗三种`,
        M.filter((m) => m.category && !['办公费', '固定资产', '低值易耗'].includes(m.category)).map((m) => matRef(m, `写成「${m.category}」`)),
      ),
    );
    const joined = M.filter((m) => /[、，,/／\n+＋]/.test(m.department));
    const costInDept = M.filter((m) => /耗材|餐具|运费/.test(m.department));
    fieldIssues.push(
      finding(
        'department_text',
        '部门列被当成自由文本',
        `${joined.length} 行把几个部门拼在一起（如「${joined[0]?.department.replace(/\n/g, '') ?? '—'}」）；${costInDept.length} 行把费用类别写进部门（如「${costInDept[0]?.department ?? '—'}」）`,
        [...joined.map((m) => matRef(m, `部门「${m.department.replace(/\n/g, '')}」`)), ...costInDept.map((m) => matRef(m, `部门「${m.department}」`))],
      ),
    );
  }
  if (has('ordered_materials')) {
    fieldIssues.push(
      finding(
        'ordered_notes',
        '已下单物料备注全空、图片是 WPS 单元格图',
        `备注 ${O.filter((o) => !o.note).length}/${O.length} 行空；${O.filter((o) => o.hasImage).length} 行的图片用 WPS「DISPIMG」嵌在单元格里，导出或迁移即丢（这里已把原图存下来）`,
        O.filter((o) => !o.hasImage).map((o) => ordRef(o, '没有图片')),
        O.filter((o) => !o.note).length,
      ),
    );
  }
  if (has('brand_requests')) {
    const orderedNotReceived = B.filter((b) => b.ordered && !b.received);
    fieldIssues.push(
      finding(
        'brand_status',
        '品牌清单状态靠手填',
        `是否下单 / 到货 / 退货三列只有「是」与空；${orderedNotReceived.length} 行已下单未到货，没有下单日期，分不出超没超期；${brandRows - brandComplete.length} 行缺链接、缺用途或缺数量（表格共 ${brandRows} 行，有内容的 ${B.length} 行）`,
        [...orderedNotReceived.map((b) => brandRef(b, '已下单未到货')), ...B.filter((b) => !brandComplete.includes(b)).map((b) => brandRef(b, '缺链接、用途或数量'))],
        orderedNotReceived.length,
      ),
    );
  }

  // ───────── 五、12 条规则在旧账上 ─────────
  const rule = (no: number, title: string, result: string, count: number | null, rows: LegacyRowRef[] = []): LegacyRuleResult => ({ no, title, result, count, rows: rows.slice(0, MAX_ROWS) });
  const skip = (no: number, title: string, src: LegacySource) => rule(no, title, `${notImported(src)}，没有核对`, null);
  const rules: LegacyRuleResult[] = [];
  rules.push(
    has('purchase_ledger')
      ? rule(1, '支出必须有日期、金额、类别、部门、经办人', `台账 ${noAmount.length} 行无金额、${noDate.length} 行无日期、${noCategory.length} 行无类别；旧台账没有部门、经办人列`, noAmount.length + noDate.length + noCategory.length, [
          ...noAmount.map((l) => ledgerRef(l, '没有金额')),
          ...noDate.map((l) => ledgerRef(l, '没有日期')),
          ...noCategory.map((l) => ledgerRef(l, '没有类别')),
        ])
      : skip(1, '支出必须有日期、金额、类别、部门、经办人', 'purchase_ledger'),
  );
  rules.push(
    has('purchase_ledger')
      ? rule(2, '一笔打款必须能分摊到具体采购单', `旧账没有采购单：推定的 ${payouts.length} 笔打款（${y(-payoutTotal)}）都分摊不到采购单`, payouts.length, payouts.map((l) => ledgerRef(l, '推定打款')))
      : skip(2, '一笔打款必须能分摊到具体采购单', 'purchase_ledger'),
  );
  rules.push(
    daily
      ? rule(
          3,
          '每日打款减支出必须等于应退回，不平即报警',
          `${daily.days.length} 个付款日里 ${daily.unbalanced} 天不平（另有 ${daily.tail} 天差额不到 1 元，算尾差）；${daily.zeroAdvanceWithSpend.length} 天打款为 0 但当天仍有支出`,
          daily.unbalanced,
          [...daily.days]
            .filter((x) => x.state === 'unbalanced')
            .sort((a, b) => Math.abs(b.diffCents) - Math.abs(a.diffCents))
            .map((x) => ({ source: 'purchase_ledger' as const, sheet: d.paymentSheet, rowNo: P.find((p) => p.date === x.date)?.rowNo ?? 0, text: `${x.date}：差额 ${x.diffCents > 0 ? '+' : ''}${y(x.diffCents)}` })),
        )
      : skip(3, '每日打款减支出必须等于应退回，不平即报警', 'purchase_ledger'),
  );
  rules.push(
    has('purchase_ledger')
      ? rule(
          4,
          '应退回减实际退回为未退回，超 7 天预警',
          `应退回 ${y(shouldTotal)}、实际退回 ${y(returnedTotal)}，${returnedTotal >= shouldTotal ? `多退 ${y(returnedTotal - shouldTotal)}` : `少退 ${y(shouldTotal - returnedTotal)}`}；${shouldNoReturn.length} 天记了应退回、没记实际退回（都已超过 7 天）`,
          shouldNoReturn.length,
          shouldNoReturn.map((p) => payRef(p, `应退回 ${y(p.shouldReturnCents ?? 0)}，没记实际退回`)),
        )
      : skip(4, '应退回减实际退回为未退回，超 7 天预警', 'purchase_ledger'),
  );
  const inv = fieldIssues.find((f) => f.key === 'invoice_tax');
  rules.push(
    has('material_detail')
      ? rule(5, '发票类型与税点必须匹配字典', `旧表没有字典：${inv?.detail ?? ''}`, M.filter((m) => !m.invoice || m.taxRateBp === null).length, M.filter((m) => !m.invoice || m.taxRateBp === null).map((m) => matRef(m, '发票或税点没填')))
      : skip(5, '发票类型与税点必须匹配字典', 'material_detail'),
  );
  const syn = fieldIssues.find((f) => f.key === 'category_synonyms');
  rules.push(has('material_detail') ? rule(6, '费用科目只允许办公费、固定资产、低值易耗', syn?.detail ?? '', syn?.rows.length ?? 0, syn?.rows) : skip(6, '费用科目只允许办公费、固定资产、低值易耗', 'material_detail'));
  const dep = fieldIssues.find((f) => f.key === 'department_text');
  rules.push(has('material_detail') ? rule(7, '部门走字典，禁止多部门拼接', dep?.detail ?? '', dep?.count ?? 0, dep?.rows) : skip(7, '部门走字典，禁止多部门拼接', 'material_detail'));
  const diffQty = M.filter((m) => m.boughtMilli !== null && m.receivedMilli !== null && m.boughtMilli !== m.receivedMilli);
  rules.push(
    has('material_detail')
      ? rule(8, '到货数量不等于购买数量时必须填差异原因', `明细表 ${diffQty.length} 行购买数量与到货数量不同（旧表没有原因列）`, diffQty.length, diffQty.map((m) => matRef(m, `购买 ${m.boughtText}、到货 ${m.receivedText}`)))
      : skip(8, '到货数量不等于购买数量时必须填差异原因', 'material_detail'),
  );
  const notArrived = B.filter((b) => b.ordered && !b.received);
  rules.push(
    has('brand_requests')
      ? rule(9, '已下单未到货超约定天数预警', `品牌清单 ${notArrived.length} 行已下单未到货；旧表没有下单日期，分不出超没超期`, notArrived.length, notArrived.map((b) => brandRef(b, '已下单未到货')))
      : skip(9, '已下单未到货超约定天数预警', 'brand_requests'),
  );
  const dupKey = new Map<string, (typeof O)[number][]>();
  for (const o of O) if (o.date && o.product) dupKey.set(`${o.date}|${o.product}`, [...(dupKey.get(`${o.date}|${o.product}`) ?? []), o]);
  const dups = [...dupKey.values()].filter((v) => v.length > 1);
  rules.push(
    has('ordered_materials')
      ? rule(10, '同一物品同一天重复下单提示', dups.length ? `已下单物料里同一天同名产品出现两次以上：${dups.map((v) => `${v[0]!.date}「${v[0]!.product}」${v.length} 次`).join('、')}` : '已下单物料里没有同一天重复下单', dups.length, dups.flatMap((v) => v.map((o) => ordRef(o, `同一天下了 ${v.length} 次`))))
      : skip(10, '同一物品同一天重复下单提示', 'ordered_materials'),
  );
  rules.push(rule(11, '标注有发票但实际无票直接拦截', '旧表没有发票号，核对不了（新账登记时按发票类型要求发票号）', null));
  const noLink = B.filter((b) => !(b.linkUrl || b.linkText));
  const noImage = O.filter((o) => !o.hasImage);
  rules.push(
    has('brand_requests') || has('ordered_materials')
      ? rule(
          12,
          '图片与链接为必填',
          [has('brand_requests') ? `品牌清单有内容的 ${B.length} 行里 ${noLink.length} 行没有链接（表格共 ${brandRows} 行，${brandRows - B.length} 行是空行）` : notImported('brand_requests'), has('ordered_materials') ? `已下单物料 ${noImage.length} 行没有图片` : notImported('ordered_materials')].join('；'),
          noLink.length + noImage.length,
          [...noLink.map((b) => brandRef(b, '没有链接')), ...noImage.map((o) => ordRef(o, '没有图片'))],
        )
      : skip(12, '图片与链接为必填', 'brand_requests'),
  );

  return { imported: d.imported, overview, crossChecks, daily, fieldIssues, rules };
}
