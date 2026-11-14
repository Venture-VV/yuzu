// 8.0.21 银行账户与网银流水（docs/FINANCE_V8021.md 第 4 节，CW-C）：前后端共用。
// 网银导出的对账单各家表头不一样：按同义词认列（工商、建设、招商常见的写法 + 通用），认不出的在页面上手动对，按账户记住。

import { yuanTextToCents } from './invoice-recognize';

export const BANK_TEMPLATES = ['icbc', 'ccb', 'cmb', 'generic'] as const;
export type BankTemplate = (typeof BANK_TEMPLATES)[number];
export const BANK_TEMPLATE_LABELS: Record<BankTemplate, string> = { icbc: '工商银行', ccb: '建设银行', cmb: '招商银行', generic: '通用' };

/** 流水里要的几列 */
export const STATEMENT_FIELDS = ['date', 'in', 'out', 'amount', 'dc', 'balance', 'counterparty', 'counterpartyAccount', 'summary', 'ref'] as const;
export type StatementField = (typeof STATEMENT_FIELDS)[number];
export const STATEMENT_FIELD_LABELS: Record<StatementField, string> = {
  date: '日期',
  in: '收入金额',
  out: '支出金额',
  amount: '交易金额（带借贷标志时）',
  dc: '借贷标志',
  balance: '余额',
  counterparty: '对方户名',
  counterpartyAccount: '对方账号',
  summary: '摘要',
  ref: '流水号',
};
export type ColumnMap = Partial<Record<StatementField, string>>;

/** 同义词（去掉空白、括号以后比；先精确、再包含） */
const SYNONYMS: Record<StatementField, string[]> = {
  date: ['交易日期', '记账日期', '交易时间', '入账日期', '日期', '交易日'],
  in: ['收入金额', '贷方发生额', '贷方金额', '收入', '存入金额', '贷方'],
  out: ['支出金额', '借方发生额', '借方金额', '支出', '取出金额', '借方'],
  amount: ['交易金额', '发生额', '金额'],
  dc: ['借贷标志', '借贷方向', '收支方向', '借贷'],
  balance: ['余额', '账户余额', '当前余额', '联机余额'],
  counterparty: ['对方户名', '对方单位名称', '对方账户名称', '对方名称', '收付方名称', '对方单位', '对方户名称'],
  counterpartyAccount: ['对方账号', '对方账户', '收付方账号', '对方卡号'],
  summary: ['摘要', '用途', '附言', '交易摘要', '备注', '交易用途'],
  ref: ['交易流水号', '流水号', '银行流水号', '业务参考号', '凭证号', '交易参考号', '柜员流水号'],
};

const norm = (s: string) => s.replace(/[\s()（）:：/]/g, '').toLowerCase();

/** 按表头认列：返回认出来的，认不出的不填 */
export function detectColumns(header: string[]): ColumnMap {
  const h = header.map((c) => ({ raw: c, n: norm(c) }));
  const used = new Set<string>();
  const out: ColumnMap = {};
  // 先精确、再包含；「借方」「贷方」这种短词放最后，免得把「借方发生额」以外的列抢走
  for (const pass of ['exact', 'contains'] as const) {
    for (const f of STATEMENT_FIELDS) {
      if (out[f]) continue;
      for (const syn of SYNONYMS[f]) {
        const s = norm(syn);
        const hit = h.find((c) => !used.has(c.raw) && (pass === 'exact' ? c.n === s : c.n.includes(s)));
        if (hit) {
          out[f] = hit.raw;
          used.add(hit.raw);
          break;
        }
      }
    }
  }
  // 有了收入、支出两列，就不用「交易金额 + 借贷标志」
  if (out.in && out.out) {
    delete out.amount;
    delete out.dc;
  }
  return out;
}

/** 认出来的够不够用：日期 +（收入、支出）或（金额 + 借贷标志） */
export function columnMapProblem(map: ColumnMap): string | null {
  if (!map.date) return '没认出「日期」列';
  if (!((map.in && map.out) || (map.amount && map.dc) || map.amount)) return '没认出金额列：要「收入、支出」两列，或「交易金额」（带借贷标志，或者支出写成负数）';
  return null;
}

export interface ParsedStatementLine {
  row: number;
  txnDate: string;
  direction: 'in' | 'out';
  amountCents: number;
  balanceCents: number | null;
  counterparty: string;
  counterpartyAccount: string;
  summary: string;
  bankRef: string;
  dedupeKey: string;
}

function parseDate(raw: string): string | null {
  const s = raw.trim();
  const m = /^(\d{4})[-/.年]?(\d{1,2})[-/.月]?(\d{1,2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 金额：去掉千分位、货币符号；负数返回负的分 */
function parseMoney(raw: string): number | null {
  const s = raw.trim().replace(/[¥￥,，\s]/g, '');
  if (s === '' || s === '-' || s === '--') return null;
  const neg = s.startsWith('-') || (s.startsWith('(') && s.endsWith(')'));
  const body = s.replace(/^[-+(]|\)$/g, '');
  const c = yuanTextToCents(body);
  return c === null ? null : neg ? -c : c;
}

const OUT_FLAGS = /^(借|支|支出|付|d|debit|-)$/i;
const IN_FLAGS = /^(贷|收|收入|存|c|credit|\+)$/i;

/** 按列对出来的映射解析每一行；解析不了的行记在 problems 里（不进库） */
export function parseStatementRows(
  header: string[],
  rows: { row: number; cells: string[] }[],
  map: ColumnMap,
): { lines: ParsedStatementLine[]; problems: { row: number; message: string }[] } {
  const idx = (f: StatementField) => (map[f] ? header.indexOf(map[f]!) : -1);
  const cell = (r: { cells: string[] }, f: StatementField) => {
    const i = idx(f);
    return i >= 0 ? (r.cells[i] ?? '').trim() : '';
  };
  const lines: ParsedStatementLine[] = [];
  const problems: { row: number; message: string }[] = [];
  for (const r of rows) {
    const dateRaw = cell(r, 'date');
    // 合计行、空行：没有日期的跳过
    if (!dateRaw || /合计|总计|小计/.test(r.cells.join(''))) continue;
    const txnDate = parseDate(dateRaw);
    if (!txnDate) {
      problems.push({ row: r.row, message: `日期「${dateRaw}」认不出` });
      continue;
    }
    let direction: 'in' | 'out' | null = null;
    let cents: number | null = null;
    if (map.in || map.out) {
      const i = parseMoney(cell(r, 'in'));
      const o = parseMoney(cell(r, 'out'));
      if (i && i !== 0) (direction = i > 0 ? 'in' : 'out'), (cents = Math.abs(i));
      else if (o && o !== 0) (direction = o > 0 ? 'out' : 'in'), (cents = Math.abs(o));
    }
    if (direction === null && map.amount) {
      const a = parseMoney(cell(r, 'amount'));
      const flag = cell(r, 'dc');
      if (a !== null && a !== 0) {
        cents = Math.abs(a);
        direction = flag && OUT_FLAGS.test(flag) ? 'out' : flag && IN_FLAGS.test(flag) ? 'in' : a < 0 ? 'out' : 'in';
      }
    }
    if (direction === null || cents === null || cents <= 0) {
      problems.push({ row: r.row, message: '没有金额' });
      continue;
    }
    const balance = map.balance ? parseMoney(cell(r, 'balance')) : null;
    const counterparty = cell(r, 'counterparty').slice(0, 100);
    const counterpartyAccount = cell(r, 'counterpartyAccount').replace(/\s/g, '').slice(0, 40);
    const summary = cell(r, 'summary').slice(0, 200);
    const bankRef = cell(r, 'ref').slice(0, 64);
    const dedupeKey = bankRef ? `ref:${bankRef}` : `row:${txnDate}|${direction}|${cents}|${counterparty}|${balance ?? ''}|${summary}`.slice(0, 400);
    lines.push({ row: r.row, txnDate, direction, amountCents: cents, balanceCents: balance, counterparty, counterpartyAccount, summary, bankRef, dedupeKey });
  }
  return { lines, problems };
}

// ───────────────────────── 页面要的类型 ─────────────────────────

export interface BankAccount {
  id: number;
  name: string;
  bankName: string;
  accountTail: string;
  template: BankTemplate;
  columnMap: ColumnMap;
  active: boolean;
  version: number;
}

export const MATCH_TARGET_TYPES = ['payment', 'contract_payout', 'petty_advance', 'petty_topup', 'petty_return', 'ar_collection', 'platform_settlement', 'batch_item'] as const;
export type MatchTargetType = (typeof MATCH_TARGET_TYPES)[number];
export const MATCH_TARGET_LABELS: Record<MatchTargetType, string> = {
  payment: '供应商付款',
  contract_payout: '合同付款',
  petty_advance: '备用金打款',
  petty_topup: '备用金补付',
  petty_return: '备用金退回',
  ar_collection: '协议单位回款',
  platform_settlement: '平台打款',
  batch_item: '批量付款',
};
/** 付出的流水对哪几种、收入的对哪几种 */
export const OUT_TARGETS: MatchTargetType[] = ['payment', 'contract_payout', 'petty_advance', 'petty_topup', 'batch_item'];
export const IN_TARGETS: MatchTargetType[] = ['ar_collection', 'platform_settlement', 'petty_return'];

export interface MatchTarget {
  type: MatchTargetType;
  id: number;
  docNo: string;
  date: string;
  amountCents: number;
  party: string;
  voided: boolean;
}

export interface BankMatch {
  id: number;
  target: MatchTarget;
  amountCents: number;
  auto: boolean;
  createdByName: string;
  createdAt: string;
}

export interface BankLine {
  id: number;
  accountId: number;
  accountName: string;
  txnDate: string;
  direction: 'in' | 'out';
  amountCents: number;
  balanceCents: number | null;
  counterparty: string;
  counterpartyAccount: string;
  summary: string;
  bankRef: string;
  status: 'open' | 'matched' | 'ignored';
  ignoreReason: string | null;
  version: number;
  matchedCents: number;
  matches: BankMatch[];
  /** 勾对的对象后来作废了 */
  targetVoided: boolean;
}

export interface BankOverview {
  accounts: BankAccount[];
  lines: BankLine[];
  truncated: boolean;
  counts: { open: number; stale: number; unmatchedPayments: number };
}

export interface BankImportPreview {
  sha256: string;
  header: string[];
  columnMap: ColumnMap;
  problem: string | null;
  lines: ParsedStatementLine[];
  problems: { row: number; message: string }[];
  /** 已经在库里的（按去重键） */
  duplicates: number;
  alreadyImported: boolean;
}
