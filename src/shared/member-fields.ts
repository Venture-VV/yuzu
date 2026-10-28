// 会员自定义字段（店主 2026-10-27 #12）：姓名、手机号、性别、生日、备注是固定字段，其余字段由店主在「管理 → 经营规则」配置。
//   · 字段保存后类型不能改、不能删除，只能停用：停用的字段不再显示和要求填写，已填的内容保留；
//   · 值存在会员档案的 custom_fields（键为字段编号）；文字最多 100 字，数字最多两位小数，日期为 YYYY-MM-DD，选项须在可选值之内。

export const MEMBER_FIELD_TYPES = ['text', 'number', 'date', 'select'] as const;
export type MemberFieldType = (typeof MEMBER_FIELD_TYPES)[number];

export const MEMBER_FIELD_TYPE_LABELS: Record<MemberFieldType, string> = {
  text: '文字',
  number: '数字',
  date: '日期',
  select: '单选',
};

export interface MemberFieldDef {
  /** 字段编号，例如 f1；保存后不变，会员档案按它存值 */
  key: string;
  /** 显示名称，例如「车牌号」「了解渠道」 */
  label: string;
  type: MemberFieldType;
  /** 单选的可选值；其他类型为空 */
  options: string[];
  required: boolean;
  active: boolean;
}

export type MemberFieldValue = string | number;
export type MemberCustomValues = Record<string, MemberFieldValue>;

export const MAX_MEMBER_FIELDS = 20;
export const MEMBER_FIELD_KEY = /^f\d{1,4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRealDate = (s: string) => {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** 规范化一个字段的值：空值返回 undefined；不合格时返回错误提示 */
export function normalizeFieldValue(def: MemberFieldDef, raw: unknown): { value?: MemberFieldValue; error?: string } {
  if (isEmpty(raw)) return {};
  switch (def.type) {
    case 'text': {
      const v = String(raw).trim();
      return v.length > 100 ? { error: `「${def.label}」最多 100 个字` } : { value: v };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      // 浮点误差内按两位小数取整（1.1 × 100 = 110.00000000000001）
      if (!Number.isFinite(n) || Math.abs(n) >= 1e9 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
        return { error: `「${def.label}」请填写数字（最多两位小数）` };
      }
      return { value: Math.round(n * 100) / 100 };
    }
    case 'date': {
      const v = String(raw).trim();
      return isRealDate(v) ? { value: v } : { error: `「${def.label}」日期格式应为 YYYY-MM-DD` };
    }
    case 'select': {
      const v = String(raw).trim();
      return def.options.includes(v) ? { value: v } : { error: `「${def.label}」请从可选值中选择` };
    }
  }
}

/**
 * 按字段定义核对一组值。
 *   · 只核对启用的字段：必填的不能为空；未知字段编号拒绝；
 *   · previous 是档案里原来的值：停用字段的值原样保留（页面不再显示这些字段）。
 * 返回要保存的完整值，或第一条错误。
 */
export function checkCustomValues(
  defs: readonly MemberFieldDef[],
  input: Record<string, unknown>,
  previous: MemberCustomValues = {},
  options: { enforceRequired?: boolean } = {},
): { ok: true; values: MemberCustomValues } | { ok: false; message: string; field?: string } {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const key of Object.keys(input)) {
    const def = byKey.get(key);
    if (!def) return { ok: false, message: '有未知的会员字段，请刷新页面后重试' };
    if (!def.active && !isEmpty(input[key]) && input[key] !== previous[key]) {
      return { ok: false, message: `「${def.label}」已停用，不能再修改`, field: key };
    }
  }
  const values: MemberCustomValues = {};
  for (const def of defs) {
    if (!def.active) {
      if (previous[def.key] !== undefined) values[def.key] = previous[def.key]!;
      continue;
    }
    const { value, error } = normalizeFieldValue(def, input[def.key]);
    if (error) return { ok: false, message: error, field: def.key };
    if (value === undefined) {
      if (def.required && options.enforceRequired !== false) return { ok: false, message: `请填写「${def.label}」`, field: def.key };
      continue;
    }
    values[def.key] = value;
  }
  return { ok: true, values };
}

/** 显示用：数字按原样，日期与文字原样，空值为 null */
export function displayFieldValue(value: MemberFieldValue | undefined): string | null {
  if (value === undefined || value === '') return null;
  return typeof value === 'number' ? String(value) : value;
}
