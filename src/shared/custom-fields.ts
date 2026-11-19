// 8.0.21 数据字典与自定义字段（docs/FINANCE_V8021.md 第 1 节，CW-J / CW10–CW12）：前后端共用。

// ───────────────────────── 自定义字段 ─────────────────────────

export const CUSTOM_FIELD_ENTITIES = ['member', 'supplier', 'material', 'contract'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];
export const CUSTOM_FIELD_ENTITY_LABELS: Record<CustomFieldEntity, string> = { member: '会员', supplier: '供应商', material: '物料', contract: '合同' };

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = { text: '文字', number: '数字', date: '日期', select: '选项' };

/** 每类启用的最多几个（CW10）；连停用的在内最多 99 个（编号 f1…f99） */
export const MAX_CUSTOM_FIELDS = 10;
export const MAX_CUSTOM_FIELD_DEFS = 99;
export const MAX_CUSTOM_FIELD_OPTIONS = 20;
export const MAX_CUSTOM_FIELD_LABEL = 12;
export const MAX_CUSTOM_FIELD_OPTION_LENGTH = 20;

export interface CustomFieldDef {
  id: number;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  inList: boolean;
  active: boolean;
  sort: number;
  version: number;
}

/** 按自定义字段查（后台「数据字典与字段」）：哪些对象这一格填的是什么 */
export interface CustomFieldSearchRow {
  entityId: number;
  /** 会员号、供应商编码、物料编码、合同号 */
  code: string;
  name: string;
  value: string;
  /** 停用的会员、供应商、物料，作废、终止的合同 */
  inactive: boolean;
}
export interface CustomFieldSearchResult {
  def: CustomFieldDef;
  rows: CustomFieldSearchRow[];
  /** 超过 500 条只列前 500 条 */
  truncated: boolean;
}

/** 一个对象的自定义字段：启用的定义 + 现在的值（没填的不在 values 里）+ 值的摘要（保存时带上，对不上拒绝） */
export interface CustomFieldSheet {
  defs: CustomFieldDef[];
  values: Record<string, string>;
  hash: string;
}

/**
 * 规范化一个值：空的返回 null（= 清空）；不合格的返回 { error }。
 * 数字：整数或最多两位小数；日期：YYYY-MM-DD 且是真实的日期；选项：必须是定义里的一项；文字：最多 200 个字。
 */
export function normalizeCustomValue(def: Pick<CustomFieldDef, 'type' | 'options' | 'label'>, raw: string | null | undefined): string | null | { error: string } {
  const v = (raw ?? '').trim();
  if (v === '') return null;
  if (def.type === 'number') {
    if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(v)) return { error: `「${def.label}」要填数字（最多两位小数）` };
    return String(Number(v));
  }
  if (def.type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
      return { error: `「${def.label}」要填日期（如 2026-11-14）` };
    }
    return v;
  }
  if (def.type === 'select') {
    if (!def.options.includes(v)) return { error: `「${def.label}」只能选：${def.options.join('、')}` };
    return v;
  }
  if (v.length > 200) return { error: `「${def.label}」最多 200 个字` };
  return v;
}

// ───────────────────────── 数据字典（快捷原因，CW11） ─────────────────────────

export const DICTIONARY_KEYS = [
  'voidReasons',
  'cancelReasons',
  'swapReasons',
  'lockReasons',
  'reversalReasons',
  'moveReasons',
  'refundReasons',
  'damageReasons',
  'bookingCancelReasons',
  'assetScrapReasons',
  // 8.1.15 前台风控（docs/FRONTDESK_RISK_V8115.md）
  'surchargeReasons',
  'blacklistReasons',
  'riskPassReasons',
] as const;
export type DictionaryKey = (typeof DICTIONARY_KEYS)[number];
export type Dictionaries = Record<DictionaryKey, string[]>;

export const DICTIONARY_LABELS: Record<DictionaryKey, { title: string; where: string }> = {
  voidReasons: { title: '作废明细的原因', where: '前台账单上作废一条明细' },
  cancelReasons: { title: '撤销接待的原因', where: '前台撤销一位客人的接待' },
  swapReasons: { title: '换手牌的原因', where: '前台换手牌' },
  lockReasons: { title: '锁牌的原因', where: '前台、后台锁定手牌' },
  reversalReasons: { title: '撤销消费的原因', where: '会员撤销一笔储值消费' },
  moveReasons: { title: '转单的原因', where: '前台把明细转给同行客人' },
  refundReasons: { title: '退款的原因', where: '结账记录上开退款单' },
  damageReasons: { title: '报损的原因', where: 'ERP 库存的报损单' },
  bookingCancelReasons: { title: '取消预约的原因', where: '预约页取消一张预约' },
  assetScrapReasons: { title: '资产报废的原因', where: 'ERP 资产卡片报废' },
  surchargeReasons: { title: '超时加收的原因', where: '发卡台客人卡「异常处置 → 加收」' },
  blacklistReasons: { title: '加入黑名单的原因', where: '会员详情、后台「手牌与前台 → 黑名单」' },
  riskPassReasons: { title: '未结离店放行的原因', where: '接待发牌时请值班经理授权' },
};

/** 默认值：原来写死的照搬；原来是纯手填的给几条常见的（仍然可以手填） */
export const DEFAULT_DICTIONARIES: Dictionaries = {
  voidReasons: ['项目选错', '数量录错', '挂错手牌', '顾客取消', '重复登记'],
  cancelReasons: ['开错手牌', '顾客未入场', '重复开牌'],
  swapReasons: ['手牌丢失', '手牌损坏', '柜锁故障', '顾客要求换柜'],
  lockReasons: ['手牌丢失', '手牌损坏', '柜锁故障', '暂停使用'],
  reversalReasons: ['项目选错', '金额录入错误', '会员选错', '重复登记', '顾客取消消费'],
  moveReasons: ['挂错手牌', '同行客人分开结账', '客人要求转给同行'],
  refundReasons: ['服务不满意', '项目未提供', '收错金额', '顾客取消'],
  damageReasons: ['过期', '破损', '变质', '丢失'],
  bookingCancelReasons: ['客人取消', '客人改期', '重复预约', '联系不上'],
  assetScrapReasons: ['损坏无法修复', '老旧淘汰', '丢失'],
  surchargeReasons: ['超 12 小时加收', '超 24 小时加收', '超 72 小时加收'],
  blacklistReasons: ['多次逃单', '醉酒闹事', '骚扰其他客人或员工', '损坏物品拒不赔偿'],
  riskPassReasons: ['客人答应当场补交', '已补交，待办还没销', '经理同意先接待'],
};

export const MAX_DICTIONARY_ITEMS = 30;
export const MAX_DICTIONARY_ITEM_LENGTH = 20;

/** 读出来的字典：存过的覆盖默认值，没存过的那一份用默认值 */
export function mergeDictionaries(stored: unknown): Dictionaries {
  const out: Dictionaries = { ...DEFAULT_DICTIONARIES };
  if (stored && typeof stored === 'object') {
    for (const k of DICTIONARY_KEYS) {
      const v = (stored as Record<string, unknown>)[k];
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v as string[];
    }
  }
  return out;
}
