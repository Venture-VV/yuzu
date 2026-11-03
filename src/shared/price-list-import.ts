// 价目表导入（店主 2026-10-27 #8）。前台管理页与命令行共用的 CSV 解析。
//
// 列：category,name,duration_minutes,gender,standard,professional,premium,strength,essential_oil,heat_therapy,popular,note
// （也接受中文表头：分类,项目,时长,性别,标准,专业,优选,力道,精油,热疗,超人气,说明）
//   · 价格单位为元；某一档不提供时留空或填「—」；至少要有一档；
//   · gender 留空表示不限，female / 女宾 表示仅女宾；
//   · 力道（轻柔 / 适中 / 强劲）、精油、热疗、超人气是项目属性，不影响计价；留空表示「保持现有设置」，
//     填「无」/「否」才会清除。店主可以在表格里补齐属性后重新导入。

import { parseYuan } from './money';
import { PRICE_TIERS, STRENGTHS, type Strength, type TierPrice } from './catalog';
import { readCsvTable, unclosedQuoteMessage } from './csv-read';

export interface PriceListRow {
  category: string;
  name: string;
  durationMinutes: number | null;
  gender: 'male' | 'female' | null;
  prices: TierPrice[];
  /** 属性：清单里没有这一列或留空时不写（导入时保持现有设置） */
  strength?: Strength | null;
  essentialOil?: boolean;
  heatTherapy?: boolean;
  popular?: boolean;
  note?: string;
}

export interface PriceListCsvResult {
  rows: PriceListRow[];
  /** 行号从 1 开始（含表头） */
  errors: { line: number; message: string }[];
}

export const PRICE_LIST_MAX_ROWS = 500;

const HEADER_ALIASES: Record<string, string[]> = {
  category: ['category', '分类', '类别'],
  name: ['name', '项目', '项目名称', '名称'],
  duration_minutes: ['duration_minutes', 'duration', '时长', '时长（分钟）', '时长(分钟)'],
  gender: ['gender', '性别', '限定'],
  standard: ['standard', '标准'],
  professional: ['professional', '专业'],
  premium: ['premium', '优选'],
  strength: ['strength', '力道'],
  essential_oil: ['essential_oil', '精油'],
  heat_therapy: ['heat_therapy', '热疗'],
  popular: ['popular', '超人气'],
  note: ['note', '说明', '备注'],
};

const GENDERS: Record<string, 'male' | 'female' | null> = {
  '': null,
  不限: null,
  male: 'male',
  男: 'male',
  男宾: 'male',
  仅男宾: 'male',
  female: 'female',
  女: 'female',
  女宾: 'female',
  仅女宾: 'female',
};
const STRENGTH_VALUES: Record<string, Strength | null> = {
  无: null,
  '-': null,
  light: 'light',
  轻柔: 'light',
  medium: 'medium',
  适中: 'medium',
  strong: 'strong',
  强劲: 'strong',
};
const TRUE_VALUES = ['是', 'y', 'yes', 'true', '1', '✓', '√'];
const FALSE_VALUES = ['否', 'n', 'no', 'false', '0', '无', '-'];
const NOT_OFFERED = ['', '—', '-', '–', '无'];

export function parsePriceListCsv(text: string): PriceListCsvResult {
  const table = readCsvTable(text);
  const errors: PriceListCsvResult['errors'] = [];
  const rows: PriceListRow[] = [];
  if (table.unclosedQuoteLine !== null) return { rows, errors: [{ line: table.unclosedQuoteLine, message: unclosedQuoteMessage(table.unclosedQuoteLine) }] };
  if (!table.header) return { rows, errors: [{ line: 1, message: '文件是空的' }] };
  const headerLine = table.header.line;
  const header = table.header.cells.map((h) => h.toLowerCase().replace(/\s+/g, ''));
  const col: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = header.findIndex((h) => aliases.includes(h));
    if (i >= 0) col[key] = i;
  }
  if (col.name === undefined) errors.push({ line: headerLine, message: '表头缺少「name」（项目）列' });
  if (col.standard === undefined && col.professional === undefined && col.premium === undefined) {
    errors.push({ line: headerLine, message: '表头缺少价格列（standard / professional / premium，或 标准 / 专业 / 优选）' });
  }
  if (errors.length) return { rows, errors };

  const seen = new Map<string, number>();
  for (const { line, cells } of table.rows) {
    const has = (key: string) => col[key] !== undefined;
    const cell = (key: string) => (has(key) ? (cells[col[key]!] ?? '') : '');
    const problems: string[] = [];

    const name = cell('name');
    const category = cell('category');
    if (!name) problems.push('项目名称为空');
    else if (name.length > 32) problems.push(`项目「${name}」名称超过 32 字`);
    if (category.length > 16) problems.push(`分类「${category}」超过 16 字`);

    const durationText = cell('duration_minutes').replace(/分钟|min/gi, '').trim();
    let durationMinutes: number | null = null;
    if (durationText) {
      durationMinutes = Number(durationText);
      if (!/^\d+$/.test(durationText) || durationMinutes < 1 || durationMinutes > 1440) problems.push(`时长「${cell('duration_minutes')}」应为 1–1440 分钟`);
    }

    const genderText = cell('gender').toLowerCase();
    const gender = GENDERS[genderText];
    if (gender === undefined) problems.push(`性别「${cell('gender')}」应为留空、male 或 female`);

    const prices: TierPrice[] = [];
    for (const tier of PRICE_TIERS) {
      const text = cell(tier).replace(/[¥￥元,\s]/g, '');
      if (NOT_OFFERED.includes(text)) continue;
      const price = parseYuan(text);
      if (price === null || price <= 0) problems.push(`${tier === 'standard' ? '标准' : tier === 'professional' ? '专业' : '优选'}价「${cell(tier)}」不正确`);
      else prices.push({ tier, price });
    }
    if (prices.length === 0 && !problems.some((p) => p.includes('价'))) problems.push('至少要有一档价格');

    const row: PriceListRow = { category, name, durationMinutes, gender: gender ?? null, prices };
    const strengthText = cell('strength').toLowerCase();
    if (has('strength') && strengthText !== '') {
      const v = STRENGTH_VALUES[strengthText];
      if (v === undefined) problems.push(`力道「${cell('strength')}」应为 轻柔 / 适中 / 强劲`);
      else row.strength = v;
    }
    for (const [key, field] of [
      ['essential_oil', 'essentialOil'],
      ['heat_therapy', 'heatTherapy'],
      ['popular', 'popular'],
    ] as const) {
      const v = cell(key).toLowerCase();
      if (!has(key) || v === '') continue;
      if (TRUE_VALUES.includes(v)) row[field] = true;
      else if (FALSE_VALUES.includes(v)) row[field] = false;
      else problems.push(`「${cell(key)}」应为 是 / 否`);
    }
    if (has('note') && cell('note') !== '') {
      if (cell('note').length > 100) problems.push('说明超过 100 字');
      else row.note = cell('note');
    }

    const dup = seen.get(name);
    if (name && dup !== undefined) problems.push(`项目「${name}」与第 ${dup} 行重复`);
    if (problems.length) {
      errors.push({ line, message: problems.join('；') });
      continue;
    }
    seen.set(name, line);
    rows.push(row);
  }
  if (rows.length === 0 && errors.length === 0) errors.push({ line: headerLine, message: '文件里没有项目' });
  if (rows.length > PRICE_LIST_MAX_ROWS) errors.push({ line: 1, message: `一次最多导入 ${PRICE_LIST_MAX_ROWS} 个项目` });
  return { rows, errors };
}

/** 导入结果（预览与正式导入相同） */
export interface PriceListImportReport {
  dryRun: boolean;
  total: number;
  created: number;
  /** 分类、时长、性别、价格、属性或排序有变化，或从停用恢复启用 */
  updated: number;
  unchanged: number;
  /** 勾选「停用清单外的项目」时被停用的个数 */
  deactivated: number;
  samples: { created: string[]; updated: string[]; deactivated: string[] };
  /** 清单按分类汇总 */
  groups: { category: string; count: number }[];
}

/** 内置价目表（服务端提供 CSV，页面预览后导入） */
export interface BuiltinPriceList {
  key: string;
  title: string;
  csv: string;
}
