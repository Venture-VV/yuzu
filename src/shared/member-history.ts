// 旧 EBC 逐笔流水只读导入（v0.7.28 ⑩，N12 待确认）：模板 CSV 的解析，管理页与命令行共用。
//
// 列（也接受中文表头）：phone 手机号, legacy_no 旧卡号, name 姓名, time 时间, type 类型, amount 金额, bonus 赠金,
//   balance 余额, bonus_balance 赠金余额, doc_no 单号, store 门店, operator 经办人, note 备注
//   · 认会员：旧卡号（期初导入时记下的）或手机号，至少一个；
//   · 时间：YYYY-MM-DD 或 YYYY-MM-DD HH:MM[:SS]（「/」「.」也行），按门店时区；
//   · 类型照旧系统写的原文保存（例如「充值」「消费」「赠送」「退卡」），另按关键字归类只用于显示；
//   · 金额单位为元、最多两位小数，可以是负数（照旧系统的正负）；赠金、余额、赠金余额可以留空。
// 只读、不进正式账：不写余额流水、不改会员余额与档阶。

import { formatYuan, parseYuan } from './money';
import { readCsvTable, unclosedQuoteMessage } from './csv-read';

export const MEMBER_HISTORY_KINDS = ['recharge', 'consume', 'bonus', 'refund', 'adjust', 'other'] as const;
export type MemberHistoryKind = (typeof MEMBER_HISTORY_KINDS)[number];
export const MEMBER_HISTORY_KIND_LABELS: Record<MemberHistoryKind, string> = {
  recharge: '充值',
  consume: '消费',
  bonus: '赠送',
  refund: '退款',
  adjust: '调整',
  other: '其他',
};

/** 一次最多导入的行数（更多的请分批导出） */
export const MEMBER_HISTORY_MAX_ROWS = 100_000;

export interface MemberHistoryCsvRow {
  line: number;
  phone: string;
  legacyNo: string;
  name: string;
  /** 门店时区的日期与时分秒 */
  date: string;
  time: string;
  typeLabel: string;
  kind: MemberHistoryKind;
  amount: number;
  bonus: number | null;
  balance: number | null;
  bonusBalance: number | null;
  docNo: string;
  store: string;
  operator: string;
  note: string;
  raw: Record<string, string>;
}

const HEADER_ALIASES: Record<string, string[]> = {
  phone: ['phone', 'mobile', '手机号', '手机', '电话'],
  legacy_no: ['legacy_no', 'card_no', '旧卡号', '卡号', '会员卡号', '会员号'],
  name: ['name', '姓名', '会员姓名'],
  time: ['time', 'date', 'occurred_at', '时间', '日期', '交易时间', '发生时间'],
  type: ['type', 'kind', '类型', '交易类型', '业务类型'],
  amount: ['amount', '金额', '交易金额', '发生额'],
  bonus: ['bonus', '赠金', '赠送金额'],
  balance: ['balance', '余额', '本金余额', '储值余额'],
  bonus_balance: ['bonus_balance', '赠金余额', '赠送余额'],
  doc_no: ['doc_no', '单号', '流水号', '交易单号'],
  store: ['store', '门店', '店铺'],
  operator: ['operator', '经办人', '操作员', '收银员'],
  note: ['note', '备注', '说明'],
};

/** 按关键字归类（只用于显示；原文照旧保存） */
export function classifyHistoryType(label: string): MemberHistoryKind {
  if (/退/.test(label)) return 'refund';
  // 「储值消费」是消费：先看消费
  if (/消费|扣|结账|使用/.test(label)) return 'consume';
  if (/充值|充入|储值/.test(label)) return 'recharge';
  if (/赠|送|奖励/.test(label)) return 'bonus';
  if (/调|冲|撤|改|补/.test(label)) return 'adjust';
  return 'other';
}

const TIME_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/** 2026/1/5 9:03 → { date: 2026-01-05, time: 09:03:00 }；不是有效时间时返回 null */
export function parseHistoryTime(text: string): { date: string; time: string } | null {
  const m = TIME_RE.exec(text.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  return { date, time: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}` };
}

/** 元 → 分（可以带负号、¥、千分位）；空为 null；格式不对返回 undefined */
function money(text: string): number | null | undefined {
  const t = text.trim().replace(/[¥￥,，\s]/g, '');
  if (t === '') return null;
  const negative = t.startsWith('-') || t.startsWith('−');
  const cents = parseYuan(negative ? t.slice(1) : t);
  if (cents === null) return undefined;
  return negative ? -cents : cents;
}

export function parseMemberHistoryCsv(text: string): { rows: MemberHistoryCsvRow[]; errors: { line: number; message: string }[] } {
  const errors: { line: number; message: string }[] = [];
  const { header, rows, unclosedQuoteLine } = readCsvTable(text.replace(/^﻿/, ''));
  if (unclosedQuoteLine !== null) return { rows: [], errors: [{ line: unclosedQuoteLine, message: unclosedQuoteMessage(unclosedQuoteLine) }] };
  if (!header) return { rows: [], errors: [{ line: 1, message: '文件是空的' }] };
  const names = header.cells.map((c) => c.trim().toLowerCase());
  const col: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = names.findIndex((n) => aliases.includes(n));
    if (i >= 0) col[key] = i;
  }
  const missing = ['time', 'type', 'amount'].filter((k) => col[k] === undefined);
  if (col.phone === undefined && col.legacy_no === undefined) missing.unshift('手机号或旧卡号');
  if (missing.length) {
    const label: Record<string, string> = { time: '时间', type: '类型', amount: '金额' };
    return { rows: [], errors: [{ line: header.line, message: `表头缺少：${missing.map((k) => label[k] ?? k).join('、')}（模板见 docs/SCHEDULE_FINISH.md 第 11 节）` }] };
  }
  const out: MemberHistoryCsvRow[] = [];
  for (const r of rows) {
    if (r.cells.every((c) => c.trim() === '')) continue;
    const cell = (k: string) => (col[k] === undefined ? '' : (r.cells[col[k]!] ?? '').trim());
    const raw = Object.fromEntries(header.cells.map((h, i) => [h.trim(), (r.cells[i] ?? '').trim()]));
    const problems: string[] = [];
    const phone = cell('phone').replace(/[\s-]/g, '');
    const legacyNo = cell('legacy_no').replace(/\s/g, '').toUpperCase();
    if (!phone && !legacyNo) problems.push('手机号和旧卡号都没填');
    if (phone && !/^1\d{10}$/.test(phone)) problems.push(`手机号「${phone}」不对`);
    if (legacyNo.length > 32) problems.push('旧卡号太长');
    const at = parseHistoryTime(cell('time'));
    if (!at) problems.push(`时间「${cell('time')}」不对（应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM）`);
    const typeLabel = cell('type');
    if (!typeLabel) problems.push('类型没填');
    if (typeLabel.length > 32) problems.push('类型太长');
    const amount = money(cell('amount'));
    if (amount === undefined || amount === null) problems.push(`金额「${cell('amount')}」不对`);
    const bonus = money(cell('bonus'));
    const balance = money(cell('balance'));
    const bonusBalance = money(cell('bonus_balance'));
    if (bonus === undefined) problems.push(`赠金「${cell('bonus')}」不对`);
    if (balance === undefined) problems.push(`余额「${cell('balance')}」不对`);
    if (bonusBalance === undefined) problems.push(`赠金余额「${cell('bonus_balance')}」不对`);
    for (const [k, max] of [['doc_no', 64], ['store', 64], ['operator', 32], ['note', 200]] as const) {
      if (cell(k).length > max) problems.push(`${k === 'doc_no' ? '单号' : k === 'store' ? '门店' : k === 'operator' ? '经办人' : '备注'}太长（最多 ${max} 字）`);
    }
    if (problems.length) {
      errors.push({ line: r.line, message: problems.join('；') });
      continue;
    }
    out.push({
      line: r.line,
      phone,
      legacyNo,
      name: cell('name'),
      date: at!.date,
      time: at!.time,
      typeLabel,
      kind: classifyHistoryType(typeLabel),
      amount: amount!,
      bonus: bonus ?? null,
      balance: balance ?? null,
      bonusBalance: bonusBalance ?? null,
      docNo: cell('doc_no'),
      store: cell('store'),
      operator: cell('operator'),
      note: cell('note'),
      raw,
    });
  }
  if (out.length + errors.length > MEMBER_HISTORY_MAX_ROWS) {
    return { rows: [], errors: [{ line: 1, message: `一次最多导入 ${MEMBER_HISTORY_MAX_ROWS.toLocaleString('en-US')} 行，请按时间分批导出` }] };
  }
  if (out.length === 0 && errors.length === 0) errors.push({ line: header.line, message: '文件里没有数据行' });
  return { rows: out, errors };
}

/** 预览与导入的结果 */
export interface MemberHistoryReport {
  /** 导入后才有 */
  importId?: number;
  importNo?: string;
  replayed?: boolean;
  fileName: string;
  totalRows: number;
  /** 认出会员、会导入（已导入）的行 */
  matchedRows: number;
  memberCount: number;
  byLegacyNo: number;
  byPhone: number;
  /** 认不出会员的行（不导入）：行号与填的手机号 / 旧卡号，最多列 50 行 */
  unmatched: { count: number; lines: { line: number; phone: string; legacyNo: string; name: string }[] };
  /** 格式不对的行：有一行不对整批不导入 */
  errors: { line: number; message: string }[];
  firstAt: string | null;
  lastAt: string | null;
  byKind: { kind: MemberHistoryKind; count: number; amount: number }[];
  /** 同一份文件已经有一批有效的导入（导入编号） */
  duplicateOf: string | null;
}

export interface MemberHistoryImportSummary {
  id: number;
  importNo: string;
  source: string;
  fileName: string;
  note: string;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  memberCount: number;
  firstAt: string | null;
  lastAt: string | null;
  createdByName: string;
  createdAt: string;
  status: 'active' | 'voided';
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface MemberHistoryEntry {
  id: number;
  occurredAt: string;
  typeLabel: string;
  kind: MemberHistoryKind;
  amount: number;
  bonus: number | null;
  balance: number | null;
  bonusBalance: number | null;
  docNo: string;
  store: string;
  operator: string;
  note: string;
  importNo: string;
  source: string;
}

/** 会员详情「旧系统流水」：这位会员（含合并进来的档案）的旧流水，新的在前 */
export interface MemberHistoryPage {
  total: number;
  entries: MemberHistoryEntry[];
  /** 还有更早的：下一页从这条之前取 */
  nextBefore: number | null;
}

export const describeHistoryAmount = (cents: number) => (cents < 0 ? `−${formatYuan(-cents)}` : formatYuan(cents));
