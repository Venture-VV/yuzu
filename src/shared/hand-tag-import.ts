// 柜号清单导入（店主 2026-10-27 #26：按清单逐个导入，不按号段生成）。前台页面与命令行共用的 CSV 解析。
//
// 格式与 docs/data/hand-tags-2026-10-27.csv 相同：code,gender,kind,area,vip_level
//   · code：牌号，普通柜连区号字母（A8060），VIP 柜为纯数字（9058）；
//   · gender：male / female（也接受 男、女、男宾、女宾）；
//   · kind：normal / vip（也接受 普通、普通柜、VIP、VIP柜）；
//   · area：普通柜的区号，可留空；填写时必须与牌号的字母前缀一致；
//   · vip_level：VIP 柜的等级（1–9），普通柜留空。

import { MAX_VIP_LEVEL, normalizeTagCode, tagArea, TAG_CODE_PATTERN, type TagKind, type Zone } from './frontdesk';
import { readCsvTable, unclosedQuoteMessage } from './csv-read';

export interface HandTagImportRow {
  code: string;
  zone: Zone;
  kind: TagKind;
  vipLevel: number | null;
}

export interface HandTagCsvResult {
  rows: HandTagImportRow[];
  /** 行号从 1 开始（含表头） */
  errors: { line: number; message: string }[];
}

export const HAND_TAG_IMPORT_MAX_ROWS = 2000;

const HEADER_ALIASES: Record<string, string[]> = {
  code: ['code', '牌号', '柜号'],
  gender: ['gender', 'zone', '性别', '分区'],
  kind: ['kind', '柜型', '类型'],
  area: ['area', '区', '区号'],
  vip_level: ['vip_level', 'level', '等级', 'vip等级'],
};

const ZONE_VALUES: Record<string, Zone> = { male: 'male', female: 'female', 男: 'male', 女: 'female', 男宾: 'male', 女宾: 'female' };
const KIND_VALUES: Record<string, TagKind> = { normal: 'normal', vip: 'vip', 普通: 'normal', 普通柜: 'normal', vip柜: 'vip' };

export function parseHandTagCsv(text: string): HandTagCsvResult {
  const table = readCsvTable(text);
  const errors: HandTagCsvResult['errors'] = [];
  const rows: HandTagImportRow[] = [];
  if (table.unclosedQuoteLine !== null) return { rows, errors: [{ line: table.unclosedQuoteLine, message: unclosedQuoteMessage(table.unclosedQuoteLine) }] };
  if (!table.header) return { rows, errors: [{ line: 1, message: '文件是空的' }] };
  const headerLine = table.header.line;
  const header = table.header.cells.map((h) => h.toLowerCase().replace(/\s+/g, ''));
  const col: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = header.findIndex((h) => aliases.includes(h));
    if (i >= 0) col[key] = i;
  }
  for (const required of ['code', 'gender', 'kind'] as const) {
    if (col[required] === undefined) {
      errors.push({ line: headerLine, message: `表头缺少「${HEADER_ALIASES[required]![0]}」列（应为 code,gender,kind,area,vip_level）` });
    }
  }
  if (errors.length) return { rows, errors };

  const seen = new Map<string, number>();
  for (const { line, cells } of table.rows) {
    const cell = (key: string) => (col[key] === undefined ? '' : (cells[col[key]!] ?? ''));
    const code = normalizeTagCode(cell('code'));
    const zone = ZONE_VALUES[cell('gender').toLowerCase()];
    const kind = KIND_VALUES[cell('kind').toLowerCase().replace(/\s+/g, '')];
    const area = cell('area').toUpperCase();
    const levelText = cell('vip_level');
    const problems: string[] = [];
    if (!TAG_CODE_PATTERN.test(code)) problems.push(`牌号「${cell('code')}」格式不正确`);
    if (!zone) problems.push(`性别「${cell('gender')}」应为 male / female`);
    if (!kind) problems.push(`柜型「${cell('kind')}」应为 normal / vip`);
    let vipLevel: number | null = null;
    if (kind === 'vip') {
      vipLevel = Number(levelText);
      if (!/^\d+$/.test(levelText) || vipLevel < 1 || vipLevel > MAX_VIP_LEVEL) problems.push(`VIP 柜 ${code} 的等级应为 1–${MAX_VIP_LEVEL}`);
    } else if (kind === 'normal' && levelText !== '') {
      problems.push(`普通柜 ${code} 不应填写 VIP 等级`);
    }
    if (kind === 'normal' && area && area !== tagArea(code)) problems.push(`普通柜 ${code} 的区号「${area}」与牌号前缀不一致`);
    const dup = seen.get(code);
    if (dup !== undefined) problems.push(`牌号 ${code} 与第 ${dup} 行重复`);
    if (problems.length) {
      errors.push({ line, message: problems.join('；') });
      continue;
    }
    seen.set(code, line);
    rows.push({ code, zone: zone!, kind: kind!, vipLevel });
  }
  if (rows.length === 0 && errors.length === 0) errors.push({ line: headerLine, message: '文件里没有柜号' });
  if (rows.length > HAND_TAG_IMPORT_MAX_ROWS) errors.push({ line: 1, message: `一次最多导入 ${HAND_TAG_IMPORT_MAX_ROWS} 个柜号` });
  return { rows, errors };
}

/** 导入结果（预览与正式导入相同） */
export interface HandTagImportReport {
  dryRun: boolean;
  total: number;
  created: number;
  /** 分区、柜型、等级有变化，或从停用恢复启用 */
  updated: number;
  unchanged: number;
  /** 勾选「停用清单外的手牌」时，被停用的张数 */
  deactivated: number;
  /** 在店手牌不改动（分区、柜型、等级有变化或要停用时） */
  blocked: { code: string; reason: string }[];
  samples: { created: string[]; updated: string[]; deactivated: string[] };
  /** 清单按分区 / 柜型 / 等级 / 区号汇总 */
  groups: { zone: Zone; kind: TagKind; vipLevel: number | null; area: string; count: number }[];
}
