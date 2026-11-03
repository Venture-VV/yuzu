// 旧系统（EBC）会员余额期初导入（店主 2026-10-27 #5 #6）：CSV 解析，管理页与命令行共用。
//
// 列：name,phone,legacy_no,principal,bonus,bonus_expires_on,total_recharged,gender,birthday,note
// （也接受中文表头：姓名,手机号,旧卡号,本金,赠金,赠金到期日,累计充值,性别,生日,备注）
//   · 金额单位为元，最多两位小数；本金必填（没有余额填 0），赠金留空为 0；
//   · 赠金到期日是「最后一天可用」的日期（YYYY-MM-DD），留空为长期有效；
//   · 累计充值是旧系统里这位会员累计充值的实收金额，只用于 VIP 柜等级（口径待确认），不计入充值实收；
//   · 本金和赠金都为 0 的行只建档、不记余额。

import { formatYuan, parseYuan } from './money';
import { readCsvTable, unclosedQuoteMessage } from './csv-read';

export interface OpeningRow {
  /** 文件里的行号（含表头，从 1 开始） */
  line: number;
  name: string;
  phone: string;
  legacyNo: string;
  principal: number;
  bonus: number;
  /** 赠金最后一天可用的日期；null 为长期有效 */
  bonusExpiresOn: string | null;
  /** 旧系统累计充值（分）；null 为未提供 */
  totalRecharged: number | null;
  gender: 'female' | 'male' | null;
  birthday: string | null;
  note: string;
  /** 原始内容（表头 → 单元格），作为来源记录保存 */
  raw: Record<string, string>;
}

export interface OpeningCsvResult {
  rows: OpeningRow[];
  errors: { line: number; message: string }[];
}

export const OPENING_MAX_ROWS = 5000;

const HEADER_ALIASES: Record<string, string[]> = {
  name: ['name', '姓名', '会员姓名'],
  phone: ['phone', 'mobile', '手机号', '手机', '电话'],
  legacy_no: ['legacy_no', 'card_no', '旧卡号', '卡号', '会员号', '旧会员号'],
  principal: ['principal', '本金', '本金余额', '储值余额'],
  bonus: ['bonus', '赠金', '赠金余额', '赠送余额'],
  bonus_expires_on: ['bonus_expires_on', '赠金到期日', '赠金有效期', '到期日'],
  total_recharged: ['total_recharged', '累计充值', '累计充值金额'],
  gender: ['gender', '性别'],
  birthday: ['birthday', '生日'],
  note: ['note', '备注'],
};

const GENDERS: Record<string, 'female' | 'male' | null> = { '': null, 男: 'male', male: 'male', m: 'male', 女: 'female', female: 'female', f: 'female' };

/** 2026/1/5、2026-01-05 → 2026-01-05；不是有效日期时返回 null */
export function normalizeDate(text: string): string | null {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

const money = (text: string): number | null => {
  const t = text.replace(/[¥￥元,\s]/g, '');
  if (t === '') return 0;
  const v = parseYuan(t);
  return v === null || v < 0 ? null : v;
};

export function parseOpeningCsv(text: string): OpeningCsvResult {
  const table = readCsvTable(text);
  const errors: OpeningCsvResult['errors'] = [];
  const rows: OpeningRow[] = [];
  if (table.unclosedQuoteLine !== null) return { rows, errors: [{ line: table.unclosedQuoteLine, message: unclosedQuoteMessage(table.unclosedQuoteLine) }] };
  if (!table.header) return { rows, errors: [{ line: 1, message: '文件是空的' }] };
  const headerLine = table.header.line;
  const headerCells = table.header.cells;
  const header = headerCells.map((h) => h.toLowerCase().replace(/\s+/g, ''));
  const col: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = header.findIndex((h) => aliases.includes(h));
    if (i >= 0) col[key] = i;
  }
  for (const [key, label] of [
    ['name', '姓名'],
    ['phone', '手机号'],
    ['principal', '本金'],
  ] as const) {
    if (col[key] === undefined) errors.push({ line: headerLine, message: `表头缺少「${label}」列` });
  }
  if (errors.length) return { rows, errors };

  const seen = new Map<string, number>();
  for (const { line, cells } of table.rows) {
    const cell = (key: string) => (col[key] !== undefined ? (cells[col[key]!] ?? '') : '');
    const problems: string[] = [];

    const name = cell('name');
    if (!name) problems.push('姓名为空');
    else if (name.length > 32) problems.push('姓名超过 32 字');
    const phone = cell('phone').replace(/[\s-]/g, '');
    if (!/^1\d{10}$/.test(phone)) problems.push(`手机号「${cell('phone')}」不是 11 位手机号`);
    else if (seen.has(phone)) problems.push(`手机号 ${phone} 与第 ${seen.get(phone)} 行重复（一人只能登记一个手机号）`);
    const legacyNo = cell('legacy_no');
    if (legacyNo.length > 32) problems.push('旧卡号超过 32 字');

    const principal = money(cell('principal'));
    if (principal === null) problems.push(`本金「${cell('principal')}」不正确（单位元，最多两位小数，不能为负）`);
    const bonus = money(cell('bonus'));
    if (bonus === null) problems.push(`赠金「${cell('bonus')}」不正确`);
    let bonusExpiresOn: string | null = null;
    if (cell('bonus_expires_on')) {
      bonusExpiresOn = normalizeDate(cell('bonus_expires_on'));
      if (!bonusExpiresOn) problems.push(`赠金到期日「${cell('bonus_expires_on')}」应为 YYYY-MM-DD`);
      else if (!bonus) bonusExpiresOn = null; // 没有赠金时到期日无意义，忽略
    }
    let totalRecharged: number | null = null;
    if (cell('total_recharged')) {
      totalRecharged = money(cell('total_recharged'));
      if (totalRecharged === null) problems.push(`累计充值「${cell('total_recharged')}」不正确`);
    }
    const gender = GENDERS[cell('gender').toLowerCase()];
    if (gender === undefined) problems.push(`性别「${cell('gender')}」应为 男 / 女 或留空`);
    let birthday: string | null = null;
    if (cell('birthday')) {
      birthday = normalizeDate(cell('birthday'));
      if (!birthday) problems.push(`生日「${cell('birthday')}」应为 YYYY-MM-DD`);
    }
    const note = cell('note');
    if (note.length > 200) problems.push('备注超过 200 字');

    if (problems.length) {
      errors.push({ line, message: problems.join('；') });
      continue;
    }
    seen.set(phone, line);
    const raw: Record<string, string> = {};
    headerCells.forEach((h, k) => {
      if (h) raw[h] = cells[k] ?? '';
    });
    rows.push({
      line,
      name,
      phone,
      legacyNo,
      principal: principal!,
      bonus: bonus!,
      bonusExpiresOn,
      totalRecharged,
      gender: gender ?? null,
      birthday,
      note,
      raw,
    });
  }
  if (rows.length + errors.length === 0) errors.push({ line: headerLine + 1, message: '文件里没有会员' });
  if (rows.length > OPENING_MAX_ROWS) errors.push({ line: 0, message: `一次最多导入 ${OPENING_MAX_ROWS} 位会员，请分批` });
  return { rows, errors };
}

/** EBC 控制总数：旧系统报表上的会员人数与本金、赠金、累计充值合计（金额为分） */
export interface OpeningTotals {
  count: number;
  principal: number;
  bonus: number;
  legacyRecharged: number;
}

/** 与控制总数的比对（R1.5）：本次导入 + 排除清单 = 控制总数，四项分毫不差才能导入 */
export interface OpeningControlCheck {
  expected: OpeningTotals;
  imported: OpeningTotals;
  excluded: OpeningTotals;
  ok: boolean;
  /** 不一致的项，例如「本金：导入 + 排除 ¥1,200.00，控制总数 ¥1,212.00，差 ¥12.00」 */
  mismatches: string[];
}

const ZERO: OpeningTotals = { count: 0, principal: 0, bonus: 0, legacyRecharged: 0 };

/**
 * 排除清单（这次不导入、之后到店补导的会员，例如没有合格手机号、一号多卡）只用来对总数：
 * 表头与导入文件相同，逐行累计人数与本金、赠金、累计充值；不核对姓名与手机号，金额写错的行报错。
 */
export function sumOpeningCsv(text: string): { totals: OpeningTotals; errors: { line: number; message: string }[] } {
  const table = readCsvTable(text);
  const errors: { line: number; message: string }[] = [];
  const totals = { ...ZERO };
  if (table.unclosedQuoteLine !== null) return { totals, errors: [{ line: table.unclosedQuoteLine, message: unclosedQuoteMessage(table.unclosedQuoteLine) }] };
  if (!table.header) return { totals, errors };
  const headerLine = table.header.line;
  const header = table.header.cells.map((h) => h.toLowerCase().replace(/\s+/g, ''));
  const col = (key: string) => header.findIndex((h) => HEADER_ALIASES[key]!.includes(h));
  const [principalCol, bonusCol, rechargedCol] = [col('principal'), col('bonus'), col('total_recharged')];
  if (principalCol < 0) return { totals, errors: [{ line: headerLine, message: '表头缺少「本金」列' }] };
  for (const { line, cells } of table.rows) {
    const amounts = [principalCol, bonusCol, rechargedCol].map((c) => (c < 0 ? 0 : money(cells[c] ?? '')));
    if (amounts.some((v) => v === null)) {
      errors.push({ line, message: '本金、赠金或累计充值不正确（单位元，最多两位小数，不能为负）' });
      continue;
    }
    totals.count += 1;
    totals.principal += amounts[0]!;
    totals.bonus += amounts[1]!;
    totals.legacyRecharged += amounts[2]!;
  }
  return { totals, errors };
}

export function compareOpeningControl(expected: OpeningTotals, imported: OpeningTotals, excluded: OpeningTotals = ZERO): OpeningControlCheck {
  const items: [keyof OpeningTotals, string, (v: number) => string][] = [
    ['count', '人数', (v) => `${v} 位`],
    ['principal', '本金', formatYuan],
    ['bonus', '赠金', formatYuan],
    ['legacyRecharged', '累计充值', formatYuan],
  ];
  const mismatches = items.flatMap(([key, label, show]) => {
    const got = imported[key] + excluded[key];
    if (got === expected[key]) return [];
    const diff = got - expected[key];
    return [`${label}：导入${excluded.count ? ' + 排除' : ''} ${show(got)}，控制总数 ${show(expected[key])}，${diff > 0 ? '多' : '少'} ${show(Math.abs(diff))}`];
  });
  return { expected, imported, excluded, ok: mismatches.length === 0, mismatches };
}

/** 管理页预览与导入的结果 */
export interface OpeningImportReport {
  dryRun: boolean;
  /** 已导入时的批次号 */
  importNo: string | null;
  /** 同一编号重提时为 true（返回第一次导入的结果） */
  replayed: boolean;
  total: number;
  createCount: number;
  matchCount: number;
  /** 本金、赠金都为 0，只建档 */
  zeroCount: number;
  principalTotal: number;
  bonusTotal: number;
  legacyRechargedTotal: number;
  /** 填了 EBC 控制总数时的比对结果 */
  control: OpeningControlCheck | null;
  errors: { line: number; message: string }[];
  /** 前 30 行的处理方式，供核对 */
  samples: { line: number; name: string; phone: string; principal: number; bonus: number; action: 'create' | 'match'; memberNo: string | null }[];
}

export interface OpeningImportSummary {
  id: number;
  importNo: string;
  source: string;
  fileName: string;
  note: string;
  rowCount: number;
  createdCount: number;
  principalTotal: number;
  bonusTotal: number;
  businessDate: string;
  importedByName: string;
  createdAt: string;
  /** 仍有效 / 已作废的会员数 */
  activeCount: number;
  voidedCount: number;
}

/** 一位会员的期初明细（导入批次详情） */
export interface OpeningBalanceRow {
  id: number;
  lineNo: number;
  docNo: string;
  memberId: number;
  memberNo: string;
  memberName: string;
  memberPhone: string;
  legacyNo: string;
  principal: number;
  bonus: number;
  bonusExpiresAt: string | null;
  legacyRecharged: number;
  memberCreated: boolean;
  status: 'active' | 'voided';
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  /** 期初之后这位会员已有其他余额变动（消费、充值、赠金过期等）时不能再作废 */
  laterActivity: boolean;
  sourceRow: Record<string, string>;
}

export interface OpeningImportDetail extends OpeningImportSummary {
  rows: OpeningBalanceRow[];
}
