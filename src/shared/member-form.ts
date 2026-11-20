// 会员建档：卡类型、建档表单的字段与实体卡押金（8.1.15，docs/MEMBERS_V8115.md）。
//   · 卡类型：电子卡（凭手机号认人）、实体卡（发一张卡、收押金）、匿名卡（不强制手机号，可以配一张实体卡）；
//   · 表单：姓名、手机号（匿名卡除外）、卡类型、会员等级固定必填；性别、生日、渠道来源、推荐人、偏好项目、会员标签、备注
//     显示不显示、必填不必填由后台「会员体系 → 渠道与标签」按门店配（member_form_rules，第二家店单独设的存 store_settings）；
//   · 实体卡押金：一个金额（默认 20 元，0 = 不收），是负债——不进储值、不算营业额，现金记进班次的应有现金。

import type { PaymentMethod } from './labels';

export const MEMBER_CARD_TYPES = ['ecard', 'physical', 'anonymous'] as const;
export type MemberCardType = (typeof MEMBER_CARD_TYPES)[number];

export const MEMBER_CARD_TYPE_LABELS: Record<MemberCardType, string> = { ecard: '电子卡', physical: '实体卡', anonymous: '匿名卡' };

/** 建档第一步每种卡下面的一行说明 */
export const MEMBER_CARD_TYPE_HINTS: Record<MemberCardType, string> = {
  ecard: '凭手机号认人，不发实体卡；以后要卡可以再发',
  physical: '发一张实体卡，刷卡认人；要登记卡号、收押金',
  anonymous: '不留手机号也能办；可以配一张实体卡刷卡认人',
};

/** 匿名卡没填姓名时页面预填的称呼（可以改） */
export const ANONYMOUS_MEMBER_NAME = '匿名会员';

/** 后台能配显示、必填的字段（姓名、手机号、卡类型、会员等级固定必填，不在这里） */
export const MEMBER_FORM_FIELDS = ['gender', 'birthday', 'channel', 'referrer', 'preferredItems', 'tags', 'note'] as const;
export type MemberFormField = (typeof MEMBER_FORM_FIELDS)[number];

export const MEMBER_FORM_FIELD_LABELS: Record<MemberFormField, string> = {
  gender: '性别',
  birthday: '生日',
  channel: '来源渠道',
  referrer: '推荐人',
  preferredItems: '偏好项目',
  tags: '会员标签',
  note: '备注',
};

export interface MemberFormFieldRule {
  /** 建档、编辑表单里显示不显示；不显示的不能填，已有的值保持原样 */
  show: boolean;
  /** 显示时必填不必填 */
  required: boolean;
}

export interface MemberFormRules {
  /** 实体卡押金（分）；0 = 不收押金 */
  cardDeposit: number;
  fields: Record<MemberFormField, MemberFormFieldRule>;
}

/** 押金上限 1,000 元（防手滑多打几个零） */
export const MAX_CARD_DEPOSIT = 100_000;

/** 默认：选填项都显示、都不必填；实体卡押金 20 元（待确认） */
export const DEFAULT_MEMBER_FORM_RULES: MemberFormRules = {
  cardDeposit: 2000,
  fields: {
    gender: { show: true, required: false },
    birthday: { show: true, required: false },
    channel: { show: true, required: false },
    referrer: { show: true, required: false },
    preferredItems: { show: true, required: false },
    tags: { show: true, required: false },
    note: { show: true, required: false },
  },
};

/** 库里存的值（可能缺项、是旧版本）补齐成完整的规则；不显示的字段不会是必填 */
export function normalizeMemberFormRules(value: unknown): MemberFormRules {
  const v = (value && typeof value === 'object' ? value : {}) as { cardDeposit?: unknown; fields?: Record<string, { show?: unknown; required?: unknown } | undefined> };
  const deposit =
    typeof v.cardDeposit === 'number' && Number.isInteger(v.cardDeposit) && v.cardDeposit >= 0 && v.cardDeposit <= MAX_CARD_DEPOSIT ? v.cardDeposit : DEFAULT_MEMBER_FORM_RULES.cardDeposit;
  const fields = {} as Record<MemberFormField, MemberFormFieldRule>;
  for (const key of MEMBER_FORM_FIELDS) {
    const d = DEFAULT_MEMBER_FORM_RULES.fields[key];
    const f = v.fields?.[key];
    const show = typeof f?.show === 'boolean' ? f.show : d.show;
    fields[key] = { show, required: show && (typeof f?.required === 'boolean' ? f.required : d.required) };
  }
  return { cardDeposit: deposit, fields };
}

/** 偏好项目：最多 10 个，每个最多 12 个字 */
export const MAX_PREFERRED_ITEMS = 10;
export const MAX_PREFERRED_ITEM_LENGTH = 12;

/** 把「足疗、汗蒸 搓背」这样的输入拆成一组（顿号、逗号、分号、空格、换行都算分隔），去重、去空 */
export function splitPreferredItems(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[、，,；;\s]+/)) {
    const s = part.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// ───────────────────────── 实体卡押金 ─────────────────────────

export type CardDepositKind = 'receive' | 'refund';
export const CARD_DEPOSIT_KIND_LABELS: Record<CardDepositKind, string> = { receive: '收押金', refund: '退押金' };

/** 押金台账的一行（只追加） */
export interface CardDepositRow {
  id: number;
  docNo: string;
  kind: CardDepositKind;
  method: PaymentMethod;
  amount: number;
  /** 收款 / 退款备注（「其他」方式收的写明收的是什么；扫码、银行卡退的登记退款单号） */
  ref: string;
  reason: string | null;
  /** 收：发的那张卡；退：退回的那张卡（卡丢了没卡可退的为空） */
  cardNo: string | null;
  operatorName: string;
  businessDate: string;
  createdAt: string;
}

/** 会员详情「会员卡」里的押金：现在押着多少、台账 */
export interface MemberCardDeposits {
  /** 押着的押金 = 收 − 退 */
  held: number;
  rows: CardDepositRow[];
}

/** 按收款方式的小计（交班表、日结用） */
export interface CardDepositMethodTotal {
  method: PaymentMethod;
  count: number;
  amount: number;
}

/** 日结里的会员卡押金：当天收、退（按方式）与当天结束时押着的余额 */
export interface CardDepositDayTotals {
  received: CardDepositMethodTotal[];
  refunded: CardDepositMethodTotal[];
  held: number;
}

export const EMPTY_CARD_DEPOSIT_TOTALS: CardDepositDayTotals = { received: [], refunded: [], held: 0 };
