import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HHMM } from '@shared/business-date';
import { CASH_DRAWER_KEY, DEFAULT_CASH_DRAWERS, MAX_CASH_DRAWERS, SHIFT_MODES, type CashDrawer } from '@shared/checkout';
import { DEDUCTION_RULES } from '@shared/deduction';
import { DEFAULT_MEMBER_CHANNELS, MAX_MEMBER_CHANNELS, MEMBER_CHANNEL_KEY, type MemberChannel } from '@shared/members';
import { DEFAULT_MEMBER_FORM_RULES, MAX_CARD_DEPOSIT, MEMBER_FORM_FIELDS, normalizeMemberFormRules } from '@shared/member-form';
import { DEFAULT_TUNABLES, PRINT_MODES, TUNABLE_LIMITS } from '@shared/tunables';
import { MAX_CONSUMPTION_PURPOSES } from '@shared/supply';
import { DEFAULT_DICTIONARIES, DICTIONARY_KEYS, MAX_DICTIONARY_ITEM_LENGTH, MAX_DICTIONARY_ITEMS, mergeDictionaries } from '@shared/custom-fields';
import type { StoreRules } from '@shared/types';
import type { Db } from '../db';
import { writeAudit } from '../lib/audit';
import { currentStoreId, DEFAULT_STORE_ID } from '../lib/store-context';
import { storeOverrides, upsertSetting } from '../lib/store-settings';
import { badRequest } from '../lib/errors';
import type { Deps } from '../lib/context';
import { parse } from '../lib/validate';
import { guard } from '../auth/guard';
import { lockSettings } from '../lib/rule-settings';

export interface StoreSettings extends StoreRules {
  storeName: string;
}

const KEY_MAP = {
  store_name: 'storeName',
  deduction_rule: 'deductionRule',
  business_day_start_hour: 'businessDayStartHour',
  max_recharge_cents: 'maxRechargeCents',
  max_consume_cents: 'maxConsumeCents',
  reversal_window_hours: 'reversalWindowHours',
  business_hours: 'businessHours',
  custom_bonus_valid_days: 'customBonusValidDays',
  require_open_shift: 'requireOpenShift',
  hide_pending_marks: 'hidePendingMarks',
  member_channels: 'memberChannels',
  shift_mode: 'shiftMode',
  cash_drawers: 'cashDrawers',
  recharge_spend_pct: 'rechargeSpendPct',
  count_card_sales: 'countCardSales',
  // 8.0.7 A1：原来写死、标「待确认」的数值（@shared/tunables）
  approval_batch_max_cents: 'approvalBatchMaxCents',
  approval_batch_max: 'approvalBatchMax',
  approval_overdue_hours: 'approvalOverdueHours',
  delegation_max_days: 'delegationMaxDays',
  urgent_escalate_days: 'urgentEscalateDays',
  contract_remind_days: 'contractRemindDays',
  pdf_max_mb: 'pdfMaxMb',
  receipt_attachments_max: 'receiptAttachmentsMax',
  mp_food_max_quantity: 'mpFoodMaxQuantity',
  mp_food_max_total_cents: 'mpFoodMaxTotalCents',
  platform_backfill_days: 'platformBackfillDays',
  print_mode: 'printMode',
  print_wait_minutes: 'printWaitMinutes',
  campaign_max_members: 'campaignMaxMembers',
  campaign_notice_days: 'campaignNoticeDays',
  sms_max_attempts: 'smsMaxAttempts',
  finance_hides_marketing_cost: 'financeHidesMarketingCost',
  // 8.0.7 供应链收尾与应收（docs/ERP_V807.md 第 6 节）
  supplier_approved_only: 'supplierApprovedOnly',
  license_remind_days: 'licenseRemindDays',
  supplier_watch_score: 'supplierWatchScore',
  consumption_purposes: 'consumptionPurposes',
  slow_moving_days: 'slowMovingDays',
  acceptance_holds_payment: 'acceptanceHoldsPayment',
  recon_link_days: 'reconLinkDays',
  ar_overdue_days: 'arOverdueDays',
  expiry_remind_days: 'expiryRemindDays',
  wecom_weekly_push: 'wecomWeeklyPush',
  // 8.0.21 数据字典（快捷原因，docs/FINANCE_V8021.md 第 1 节）
  dictionaries: 'dictionaries',
  // 8.1.15 建档表单的字段显隐、必填与实体卡押金（按门店，docs/MEMBERS_V8115.md）
  member_form_rules: 'memberForm',
} as const satisfies Record<string, keyof StoreSettings>;

/** 设置项在库里的键（规则总表按它找最近修改的时间与人） */
export const SETTINGS_KEYS = KEY_MAP;

// 单笔上限按店主 2026-10-27 答复（#9）默认 50 万元；营业时间默认全天；
// 撤销与反结账时限默认 48 小时、收款前必须先开班（店主 2026-10-29 签认，迁移 017 把仍是「不限」的时限改为 48 小时）
const DEFAULTS: StoreSettings = {
  storeName: '浴族 · 城市汤泉',
  deductionRule: 'principal_first',
  businessDayStartHour: 6,
  maxRechargeCents: 50_000_000,
  maxConsumeCents: 50_000_000,
  reversalWindowHours: 48,
  businessHours: null,
  customBonusValidDays: null,
  requireOpenShift: true,
  hidePendingMarks: false,
  memberChannels: DEFAULT_MEMBER_CHANNELS,
  dictionaries: DEFAULT_DICTIONARIES,
  // 交班方式（v0.7.28 ⑨，N11 待确认）：默认按人交班（现在的做法）；按钱箱交班时开班选钱箱
  shiftMode: 'person',
  cashDrawers: DEFAULT_CASH_DRAWERS,
  // 8.0.4：充值当日的储值消费不超过「充值前余额 + 当天充值 × 70%」（HY01）；次卡停售（HY05，迁移 088 也写入「关」）
  rechargeSpendPct: 70,
  countCardSales: false,
  // 8.0.7 A1：与原来写死的一样（打印方式按店主 2026-11-10：默认本机打印）
  ...DEFAULT_TUNABLES,
  // 8.1.15：建档表单的选填项都显示、都不必填，实体卡押金 20 元（待确认）
  memberForm: DEFAULT_MEMBER_FORM_RULES,
};

export const DEFAULT_SETTINGS: Readonly<StoreSettings> = DEFAULTS;

export async function loadSettings(db: Db): Promise<StoreSettings> {
  const rows = await db<{ key: string; value: unknown }[]>`SELECT key, value FROM settings`;
  const settings: Record<string, unknown> = { ...DEFAULTS };
  for (const row of rows) {
    const prop = KEY_MAP[row.key as keyof typeof KEY_MAP];
    if (prop) settings[prop] = prop === 'dictionaries' ? mergeDictionaries(row.value) : prop === 'memberForm' ? normalizeMemberFormRules(row.value) : row.value;
  }
  // 第二家店（8.0.22，docs/MULTISTORE_V8022.md 第 4 节）：按店的那几项用它单独设的，门店名取门店档案
  if (currentStoreId() !== DEFAULT_STORE_ID) {
    for (const [key, value] of await storeOverrides(db)) {
      const prop = KEY_MAP[key as keyof typeof KEY_MAP];
      if (prop) settings[prop] = prop === 'memberForm' ? normalizeMemberFormRules(value) : value;
    }
    const [store] = await db<{ name: string }[]>`SELECT name FROM stores WHERE id = ${currentStoreId()}`;
    if (store) settings.storeName = store.name;
  }
  return settings as unknown as StoreSettings;
}

/** 可调的整数项（8.0.7 A1）：范围见 TUNABLE_LIMITS */
function tunableInputs() {
  const out: Record<string, z.ZodNumber> = {};
  for (const [key, l] of Object.entries(TUNABLE_LIMITS)) {
    out[key] = z
      .number({ message: `${l.label}要填数字` })
      .int(`${l.label}要是整数`)
      .min(l.min, `${l.label}不能小于 ${l.min}`)
      .max(l.max, `${l.label}不能大于 ${l.max}`);
  }
  return out as { [K in keyof typeof TUNABLE_LIMITS]: z.ZodNumber };
}

const SettingsInput = z
  .object({
    storeName: z.string().trim().min(1, '请填写门店名称').max(32, '门店名称最多 32 个字'),
    deductionRule: z.enum(DEDUCTION_RULES, '扣款规则不正确'),
    businessDayStartHour: z.number().int().min(0, '营业日切换时间需在 0–12 点之间').max(12, '营业日切换时间需在 0–12 点之间'),
    maxRechargeCents: z.number().int().positive('单笔充值上限必须大于 0').max(100_000_000, '单笔充值上限最多 100 万元'),
    maxConsumeCents: z.number().int().positive('单笔消费上限必须大于 0').max(100_000_000, '单笔消费上限最多 100 万元'),
    reversalWindowHours: z
      .number()
      .int('撤销时限按整小时填写')
      .min(1, '撤销时限至少 1 小时')
      .max(24 * 90, '撤销时限最多 90 天')
      .nullable(),
    businessHours: z
      .object({ open: z.string().regex(HHMM, '开门时间格式应为 HH:MM'), close: z.string().regex(HHMM, '打烊时间格式应为 HH:MM') })
      .refine((h) => h.open !== h.close, '开门与打烊时间不能相同；全天营业请选「全天 24 小时」')
      .nullable(),
    customBonusValidDays: z.number().int('赠金有效期按整天填写').min(1, '赠金有效期至少 1 天').max(3650, '赠金有效期最多 3650 天').nullable(),
    requireOpenShift: z.boolean('请选择是否要求先开班'),
    hidePendingMarks: z.boolean('请选择是否隐藏「待确认」标记'),
    memberChannels: z
      .array(
        z.object({
          /** 已有渠道的编号；新渠道不带，由服务端分配 */
          key: z.string().regex(MEMBER_CHANNEL_KEY, '渠道编号不正确').nullable().optional(),
          label: z.string().trim().min(1, '请填写渠道名称').max(12, '渠道名称最多 12 个字'),
          active: z.boolean().default(true),
        }),
      )
      .max(MAX_MEMBER_CHANNELS, `渠道最多 ${MAX_MEMBER_CHANNELS} 个`),
    shiftMode: z.enum(SHIFT_MODES, '交班方式不正确'),
    rechargeSpendPct: z.number('充值当日的消费比例请填整数').int('充值当日的消费比例请填整数').min(1, '比例至少 1%').max(100, '比例最多 100%').nullable(),
    countCardSales: z.boolean('请选择是否售次卡'),
    printMode: z.enum(PRINT_MODES, '打印方式不正确'),
    financeHidesMarketingCost: z.boolean('请选择财务账号能不能看营销成本'),
    supplierApprovedOnly: z.boolean('请选择没准入的供应商能不能下采购单'),
    acceptanceHoldsPayment: z.boolean('请选择验收不合格时挂不挂起付款'),
    wecomWeeklyPush: z.boolean('请选择是否推送到企业微信'),
    consumptionPurposes: z
      .array(z.string().trim().min(1, '耗用用途不能为空').max(12, '每个耗用用途最多 12 个字'), '耗用用途要是一组文字')
      .min(1, '至少要有一个耗用用途')
      .max(MAX_CONSUMPTION_PURPOSES, `耗用用途最多 ${MAX_CONSUMPTION_PURPOSES} 个`)
      .refine((l) => new Set(l).size === l.length, '耗用用途重复了'),
    ...tunableInputs(),
    // 数据字典（8.0.21）：只改提交上来的那几份，没提交的保持原样
    dictionaries: z.partialRecord(
      z.enum(DICTIONARY_KEYS),
      z
        .array(z.string().trim().min(1, '原因不能为空').max(MAX_DICTIONARY_ITEM_LENGTH, `每条原因最多 ${MAX_DICTIONARY_ITEM_LENGTH} 个字`), '原因要是一组文字')
        .max(MAX_DICTIONARY_ITEMS, `每份最多 ${MAX_DICTIONARY_ITEMS} 条`)
        .refine((l) => new Set(l).size === l.length, '原因重复了'),
    ),
    // 建档表单与实体卡押金（8.1.15）：整份提交；不显示的字段不会是必填
    memberForm: z
      .object({
        cardDeposit: z.number('实体卡押金要填数字').int('实体卡押金要精确到分').min(0, '实体卡押金不能为负').max(MAX_CARD_DEPOSIT, `实体卡押金最多 ${MAX_CARD_DEPOSIT / 100} 元`),
        fields: z.object(
          Object.fromEntries(MEMBER_FORM_FIELDS.map((k) => [k, z.object({ show: z.boolean('请选择显示不显示'), required: z.boolean('请选择必填不必填') })])) as Record<
            (typeof MEMBER_FORM_FIELDS)[number],
            z.ZodObject<{ show: z.ZodBoolean; required: z.ZodBoolean }>
          >,
          '建档表单的字段设置不完整，请刷新页面后重试',
        ),
      })
      .transform(normalizeMemberFormRules),
    cashDrawers: z
      .array(
        z.object({
          /** 已有钱箱的编号；新钱箱不带，由服务端分配 */
          key: z.string().regex(CASH_DRAWER_KEY, '钱箱编号不正确').nullable().optional(),
          label: z.string().trim().min(1, '请填写钱箱名称').max(16, '钱箱名称最多 16 个字'),
          active: z.boolean().default(true),
        }),
      )
      .max(MAX_CASH_DRAWERS, `钱箱最多 ${MAX_CASH_DRAWERS} 个`),
  })
  // 只提交要修改的项（各设置卡片分别保存）；没有提交的项保持原值
  .partial();

type ChannelInput = NonNullable<z.infer<typeof SettingsInput>['memberChannels']>[number];

/** 渠道的保存规则：已有渠道不能删除（只能停用），名称不重复；新渠道按顺序分配编号（c1、c2…），保存后不变 */
function normalizeChannels(current: readonly MemberChannel[], input: ChannelInput[]): MemberChannel[] {
  const byKey = new Map(current.map((c) => [c.key, c]));
  const kept = new Set(input.map((c) => c.key).filter(Boolean));
  for (const c of current) {
    if (!kept.has(c.key)) throw badRequest(`渠道「${c.label}」不能删除，只能停用（如果是其他人刚刚改过渠道，请刷新后再改）`);
  }
  let next = Math.max(0, ...current.map((c) => Number(c.key.slice(1))));
  const labels = new Set<string>();
  return input.map((c) => {
    const label = c.label.trim();
    if (labels.has(label)) throw badRequest(`渠道「${label}」重复`);
    labels.add(label);
    if (c.key) {
      if (!byKey.has(c.key)) throw badRequest('有未知的渠道，请刷新页面后重试');
      return { key: c.key, label, active: c.active };
    }
    next += 1;
    return { key: `c${next}`, label, active: c.active };
  });
}

type DrawerInput = NonNullable<z.infer<typeof SettingsInput>['cashDrawers']>[number];

/** 钱箱的保存规则（与渠道相同）：已有钱箱不能删除（只能停用），名称不重复；新钱箱按顺序分配编号（k1、k2…），保存后不变 */
function normalizeDrawers(current: readonly CashDrawer[], input: DrawerInput[]): CashDrawer[] {
  const byKey = new Map(current.map((d) => [d.key, d]));
  const kept = new Set(input.map((d) => d.key).filter(Boolean));
  for (const d of current) {
    if (!kept.has(d.key)) throw badRequest(`钱箱「${d.label}」不能删除，只能停用（如果是其他人刚刚改过钱箱，请刷新后再改）`);
  }
  let next = Math.max(0, ...current.map((d) => Number(d.key.slice(1))));
  const labels = new Set<string>();
  return input.map((d) => {
    const label = d.label.trim();
    if (labels.has(label)) throw badRequest(`钱箱「${label}」重复`);
    labels.add(label);
    if (d.key) {
      if (!byKey.has(d.key)) throw badRequest('有未知的钱箱，请刷新页面后重试');
      return { key: d.key, label, active: d.active };
    }
    next += 1;
    return { key: `k${next}`, label, active: d.active };
  });
}

export function registerSettingsRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/settings', { preHandler: guard('settings.manage') }, async () => loadSettings(sql));

  app.put('/api/settings', { preHandler: guard('settings.manage') }, async (req) => {
    const parsed = parse(SettingsInput, req.body);
    await sql.begin(async (tx) => {
      // 同时保存规则时串行执行，避免新字段编号冲突或互相覆盖
      await lockSettings(tx);
      const before = await loadSettings(tx);
      const input: Partial<StoreSettings> = {
        ...parsed,
        ...(parsed.memberChannels ? { memberChannels: normalizeChannels(before.memberChannels, parsed.memberChannels) } : {}),
        ...(parsed.cashDrawers ? { cashDrawers: normalizeDrawers(before.cashDrawers, parsed.cashDrawers) } : {}),
        ...(parsed.dictionaries ? { dictionaries: { ...before.dictionaries, ...parsed.dictionaries } } : {}),
      } as Partial<StoreSettings>;
      // 按钱箱交班至少要有一个启用的钱箱（切换后新开的班按新做法，开着的班照旧到交班为止，所以切换不用等大家交班）
      const mode = input.shiftMode ?? before.shiftMode;
      const drawers = input.cashDrawers ?? before.cashDrawers;
      if (mode === 'drawer' && !drawers.some((d) => d.active)) throw badRequest('按钱箱交班至少要有一个启用的钱箱');
      const storeId = currentStoreId();
      for (const [key, prop] of Object.entries(KEY_MAP)) {
        if (!(prop in input)) continue;
        const value = input[prop as keyof typeof input];
        // 门店名（8.0.22）：第二家店改的是它的门店档案；本店改设置的同时把门店档案的名称跟上
        if (key === 'store_name') {
          if (storeId !== DEFAULT_STORE_ID) {
            await tx`UPDATE stores SET name = ${String(value)}, version = version + 1, updated_at = now() WHERE id = ${storeId}`;
            continue;
          }
          await tx`UPDATE stores SET name = ${String(value).slice(0, 40)}, updated_at = now() WHERE id = ${DEFAULT_STORE_ID} AND name <> ${String(value).slice(0, 40)}`;
        }
        // 「不限」「全天营业」存为 JSON null（不是 SQL NULL）；按店的那几项在第二家店里存进 store_settings
        await upsertSetting(tx, key, value, req.actor.id);
      }
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'settings_updated',
        targetType: 'settings',
        detail: { before, after: input },
        ip: req.ip,
      });
    });
    return loadSettings(sql);
  });
}
