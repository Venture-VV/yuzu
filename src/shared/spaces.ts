// 空间台账（飞书需求 RQ-004 第一段，v0.7.14，见 docs/SPACES.md）：楼层 → 区域 → 空间（编码图的编码做主键）、
// 别名（品牌名、编码图原始标注、旧名；只追加）、导入（空间清单、区域清单）与导出；客房的房间挂接空间。

export const SPACE_VERIFY_STATUSES = ['confirmed', 'inferred', 'site_check'] as const;
export type SpaceVerifyStatus = (typeof SPACE_VERIFY_STATUSES)[number];
export const SPACE_VERIFY_LABELS: Record<SpaceVerifyStatus, string> = {
  confirmed: '已核对',
  inferred: '推断',
  site_check: '待现场核对',
};

export const SPACE_ALIAS_KINDS = ['brand', 'source', 'legacy', 'other'] as const;
export type SpaceAliasKind = (typeof SPACE_ALIAS_KINDS)[number];
export const SPACE_ALIAS_LABELS: Record<SpaceAliasKind, string> = {
  brand: '品牌名',
  source: '编码图原始标注',
  legacy: '旧名',
  other: '其他',
};

/** 常用业态（台账里可以写新的，最多 8 个字） */
export const SPACE_BUSINESS_TYPES = ['SPA', '按摩', '踩背', '头疗', '足浴', '投影足浴', '客房', '娱乐室', '派对房', '宠物轰趴房'] as const;
/** 客房的房间只能挂这个业态的空间 */
export const ROOM_BUSINESS_TYPE = '客房';

/** 空间编码：区域字母 + 楼层 + 序号（如 S301），大写，最多 8 位（客房挂接后房号就是编码，房号最多 8 位） */
export const SPACE_CODE_RE = /^[A-Z][0-9A-Z]{1,7}$/;
export const FLOOR_CODE_RE = /^[A-Z][0-9A-Z]{0,3}$/;
export const MAX_SPACE_CODE = 8;
export const MAX_FLOOR_NAME = 16;
export const MAX_ZONE_NAME = 24;
export const MAX_NAME_EN = 48;
export const MAX_BUSINESS_TYPE = 8;
export const MAX_DISPLAY_NAME = 24;
export const MAX_SOURCE_LABEL = 60;
export const MAX_ALIAS = 60;
export const MAX_SPACE_NOTE = 200;
export const MAX_CAPACITY = 999;

export interface Floor {
  id: number;
  code: string;
  name: string;
  sortOrder: number;
  active: boolean;
  /** 版本号：修改时原样带回，对不上（刚被改过）就拒绝 */
  version: number;
  zoneCount: number;
  /** 在用的空间数 */
  spaceCount: number;
}

export interface Zone {
  id: number;
  floorId: number;
  name: string;
  nameEn: string;
  note: string;
  sortOrder: number;
  active: boolean;
  version: number;
  /** 在用的空间数 */
  spaceCount: number;
}

export interface SpaceAlias {
  id: number;
  alias: string;
  kind: SpaceAliasKind;
  active: boolean;
  createdAt: string;
  createdByName: string | null;
  retiredAt: string | null;
  retiredByName: string | null;
}

export interface Space {
  id: number;
  code: string;
  floorId: number;
  zoneId: number | null;
  businessType: string;
  capacity: number | null;
  /** 面积 × 100（㎡，两位小数） */
  areaCentiM2: number | null;
  displayName: string;
  nameEn: string;
  sellable: boolean;
  verifyStatus: SpaceVerifyStatus;
  verifiedAt: string | null;
  verifiedByName: string | null;
  verifyNote: string | null;
  /** 编码图原始标注 */
  sourceLabel: string;
  note: string;
  active: boolean;
  importId: number | null;
  /** 版本号：编辑、核对、设区域时原样带回，对不上（刚被改过）就拒绝 */
  version: number;
  createdAt: string;
  updatedAt: string;
  aliases: SpaceAlias[];
  /** 挂在这个空间上的客房房间 */
  room: { id: number; roomNo: string; active: boolean } | null;
}

export interface SpaceLedger {
  floors: Floor[];
  zones: Zone[];
  spaces: Space[];
  /** 台账里用到的业态与常用业态 */
  businessTypes: string[];
  counts: {
    spaces: number;
    active: number;
    /** 在用、还没核对的（推断、待现场核对） */
    unverified: number;
    /** 在用的「客房」空间、已挂客房房间的、还没有品牌名的 */
    roomSpaces: number;
    roomSpacesLinked: number;
    roomSpacesWithoutBrand: number;
  };
}

/** 只读的楼层 → 区域 → 空间树（以后的房态图、对客导览用；只含在用的） */
export interface SpaceTree {
  floors: (Pick<Floor, 'id' | 'code' | 'name'> & {
    zones: (Pick<Zone, 'id' | 'name' | 'nameEn'> & { spaces: SpaceTreeNode[] })[];
    /** 没分区域的空间 */
    spaces: SpaceTreeNode[];
  })[];
}
export type SpaceTreeNode = Pick<Space, 'id' | 'code' | 'businessType' | 'capacity' | 'displayName' | 'nameEn' | 'sellable' | 'verifyStatus'> & {
  aliases: string[];
  roomId: number | null;
};

// ───────────────────────── 导入与导出 ─────────────────────────

export const SPACE_IMPORT_KINDS = ['spaces', 'zones'] as const;
export type SpaceImportKind = (typeof SPACE_IMPORT_KINDS)[number];
export const SPACE_IMPORT_LABELS: Record<SpaceImportKind, string> = { spaces: '空间清单', zones: '区域清单' };

/** 空间清单的列（与 RQ-004 附件草稿一致；「区域」「英文名」「可售」「核对状态」可选） */
export const SPACE_IMPORT_COLUMNS = ['楼层', '区域字母', '编码', '业态', '容量(人)', '建议显示名', '面积', '编码图原始标注', '备注', '区域', '英文名', '可售', '核对状态'] as const;
/** 列名的其他写法（导出的文件改过再导入也认） */
export const SPACE_IMPORT_COLUMN_ALIASES: Record<string, string> = { 容量: '容量(人)', 显示名: '建议显示名', '面积(㎡)': '面积', '面积(m²)': '面积' };
/** 区域清单的列（与附件草稿一致） */
export const ZONE_IMPORT_COLUMNS = ['楼层', '区域名(中文)', '区域名(英文)', '备注'] as const;
/** 导出的列 */
export const SPACE_EXPORT_COLUMNS = ['楼层', '区域', '编码', '业态', '容量(人)', '面积', '建议显示名', '英文名', '编码图原始标注', '别名', '可售', '核对状态', '备注'] as const;

/**
 * 导入时备注里有这些字样的行标为「推断」（附件草稿：F312–F316 写「…推断」，M310–M318 写「近邻标签…」），
 * 有「现场核对」字样的标为「待现场核对」；文件里有「核对状态」列时以它为准。
 */
export const INFERRED_NOTE_WORDS = ['推断', '推测', '近邻标签'] as const;
export const SITE_CHECK_NOTE_WORDS = ['现场核对', '待核对'] as const;

export function verifyStatusFromNote(note: string): SpaceVerifyStatus {
  if (SITE_CHECK_NOTE_WORDS.some((w) => note.includes(w))) return 'site_check';
  if (INFERRED_NOTE_WORDS.some((w) => note.includes(w))) return 'inferred';
  return 'confirmed';
}

/** 「核对状态」列：已核对 / 推断 / 待现场核对（空着按备注判断） */
export function parseVerifyStatus(text: string): SpaceVerifyStatus | null {
  const t = text.trim();
  const hit = SPACE_VERIFY_STATUSES.find((s) => SPACE_VERIFY_LABELS[s] === t || s === t);
  if (hit) return hit;
  if (t === '已确认') return 'confirmed';
  if (t === '待核对') return 'site_check';
  return null;
}

/** 面积：「120m²」「12.5㎡」「95 平方米」「70」→ 分之一平方米；空着 → null；写错 → undefined */
export function parseArea(text: string): number | null | undefined {
  const t = text.trim().replace(/\s+/g, '');
  if (t === '') return null;
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?(?:m²|m2|㎡|平方米|平米|平)?$/i.exec(t);
  if (!m) return undefined;
  const value = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
  return value >= 1 ? value : undefined;
}

/** 分之一平方米 → 「120」「12.5」 */
export function areaText(centi: number | null): string {
  if (centi === null) return '';
  const whole = Math.floor(centi / 100);
  const frac = centi % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** 容量：「2」「2人」→ 2；空着 → null；写错 → undefined */
export function parseCapacity(text: string): number | null | undefined {
  const t = text.trim().replace(/\s+/g, '').replace(/人(间)?$/, '');
  if (t === '') return null;
  if (!/^\d{1,3}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= MAX_CAPACITY ? n : undefined;
}

/** 可售：是 / 否（空着按是） */
export function parseSellable(text: string): boolean | undefined {
  const t = text.trim();
  if (t === '' || t === '是' || t === '可售' || t.toLowerCase() === 'true' || t === '1') return true;
  if (t === '否' || t === '不可售' || t.toLowerCase() === 'false' || t === '0') return false;
  return undefined;
}

export interface SpaceImportIssue {
  row: number;
  message: string;
}

/** 编码（区域名）已在台账里的行：不覆盖，列出与台账不同的字段 */
export interface SpaceImportDiff {
  row: number;
  /** 空间编码，或区域「楼层 · 区域名」 */
  key: string;
  fields: { field: string; ledger: string; file: string }[];
}

export interface SpaceImportPreview {
  kind: SpaceImportKind;
  fileName: string;
  fileSha256: string;
  encoding: string;
  rowCount: number;
  /** 会新建的行数 */
  createCount: number;
  /** 编码（区域名）已在台账里、不覆盖的行数 */
  skipCount: number;
  /** 会标为「推断」「待现场核对」的行数（空间清单） */
  inferredCount: number;
  siteCheckCount: number;
  issues: SpaceImportIssue[];
  diffs: SpaceImportDiff[];
  duplicateOf: { id: number; createdAt: string; createdByName: string } | null;
  sample: Record<string, string>[];
}

export interface SpaceImportRecord {
  id: number;
  kind: SpaceImportKind;
  fileName: string;
  rowCount: number;
  createdCount: number;
  skippedCount: number;
  createdByName: string;
  createdAt: string;
}

/** 选房、房态里区分同名空间（品牌图上 4 间「客房 C5」）：「G305 · 客房 C5」 */
export function spaceLabel(code: string, displayName: string | null | undefined): string {
  return displayName && displayName !== code ? `${code} · ${displayName}` : code;
}
