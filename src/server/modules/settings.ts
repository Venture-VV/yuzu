import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HHMM } from '@shared/business-date';
import { DEDUCTION_RULES, type DeductionRule } from '@shared/deduction';
import { MAX_MEMBER_FIELDS, MEMBER_FIELD_KEY, MEMBER_FIELD_TYPES, type MemberFieldDef } from '@shared/member-fields';
import { DEFAULT_MEMBER_CHANNELS, MAX_MEMBER_CHANNELS, MEMBER_CHANNEL_KEY, type MemberChannel } from '@shared/members';
import type { StoreRules } from '@shared/types';
import type { Db } from '../db';
import { writeAudit } from '../lib/audit';
import { badRequest } from '../lib/errors';
import type { Deps } from '../lib/context';
import { parse } from '../lib/validate';
import { guard } from '../auth/guard';

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
  member_fields: 'memberFields',
  custom_bonus_valid_days: 'customBonusValidDays',
  require_open_shift: 'requireOpenShift',
  hide_pending_marks: 'hidePendingMarks',
  member_channels: 'memberChannels',
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
  memberFields: [],
  customBonusValidDays: null,
  requireOpenShift: true,
  hidePendingMarks: false,
  memberChannels: DEFAULT_MEMBER_CHANNELS,
};

export const DEFAULT_SETTINGS: Readonly<StoreSettings> = DEFAULTS;

export async function loadSettings(db: Db): Promise<StoreSettings> {
  const rows = await db<{ key: string; value: unknown }[]>`SELECT key, value FROM settings`;
  const settings: Record<string, unknown> = { ...DEFAULTS };
  for (const row of rows) {
    const prop = KEY_MAP[row.key as keyof typeof KEY_MAP];
    if (prop) settings[prop] = row.value;
  }
  return settings as unknown as StoreSettings;
}

const SettingsInput = z
  .object({
    storeName: z.string().trim().min(1, '请填写门店名称').max(32, '门店名称最多 32 个字'),
    deductionRule: z.enum(DEDUCTION_RULES, '扣款规则不正确'),
    businessDayStartHour: z.number().int().min(0, '营业日切换时间需在 0–12 点之间').max(12, '营业日切换时间需在 0–12 点之间'),
    maxRechargeCents: z.number().int().positive('单笔充值上限必须大于 0').max(100_000_000, '单笔充值上限最多 100 万元'),
    maxConsumeCents: z.number().int().positive('单笔消费上限必须大于 0').max(100_000_000, '单笔消费上限最多 100 万元'),
    reversalWindowHours: z.number().int('撤销时限按整小时填写').min(1, '撤销时限至少 1 小时').max(24 * 90, '撤销时限最多 90 天').nullable(),
    businessHours: z
      .object({ open: z.string().regex(HHMM, '开门时间格式应为 HH:MM'), close: z.string().regex(HHMM, '打烊时间格式应为 HH:MM') })
      .refine((h) => h.open !== h.close, '开门与打烊时间不能相同；全天营业请选「全天 24 小时」')
      .nullable(),
    memberFields: z
      .array(
        z.object({
          /** 已有字段的编号；新字段不带，由服务端分配 */
          key: z.string().regex(MEMBER_FIELD_KEY, '字段编号不正确').nullable().optional(),
          label: z.string().trim().min(1, '请填写字段名称').max(16, '字段名称最多 16 个字'),
          type: z.enum(MEMBER_FIELD_TYPES, '字段类型不正确'),
          options: z.array(z.string().trim().min(1, '可选值不能为空').max(16, '可选值最多 16 个字')).max(20, '可选值最多 20 个').default([]),
          required: z.boolean().default(false),
          active: z.boolean().default(true),
        }),
      )
      .max(MAX_MEMBER_FIELDS, `会员自定义字段最多 ${MAX_MEMBER_FIELDS} 个`),
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
  })
  // 只提交要修改的项（各设置卡片分别保存）；没有提交的项保持原值
  .partial();

type MemberFieldInput = NonNullable<z.infer<typeof SettingsInput>['memberFields']>[number];
const FIXED_MEMBER_FIELDS = ['姓名', '手机号', '手机', '性别', '生日', '备注', '会员号'];

/**
 * 会员自定义字段的保存规则：已有字段不能删除（只能停用）、不能改类型；名称不重复、不与固定字段重名；
 * 单选至少一个可选值；新字段由服务端按顺序分配编号（f1、f2…），编号保存后不变。
 */
function normalizeMemberFields(current: readonly MemberFieldDef[], input: MemberFieldInput[]): MemberFieldDef[] {
  const byKey = new Map(current.map((d) => [d.key, d]));
  const kept = new Set(input.map((f) => f.key).filter(Boolean));
  for (const d of current) {
    if (!kept.has(d.key)) throw badRequest(`会员字段「${d.label}」不能删除，只能停用（如果是其他人刚刚改过字段，请刷新后再改）`);
  }
  let next = Math.max(0, ...current.map((d) => Number(d.key.slice(1))));
  const labels = new Set<string>();
  return input.map((f) => {
    const label = f.label.trim();
    if (FIXED_MEMBER_FIELDS.includes(label)) throw badRequest(`「${label}」是固定字段，不能再建同名字段`);
    if (labels.has(label)) throw badRequest(`会员字段「${label}」重复`);
    labels.add(label);
    const options = f.type === 'select' ? [...new Set(f.options)] : [];
    if (f.type === 'select' && options.length === 0) throw badRequest(`单选字段「${label}」至少要有一个可选值`);
    if (f.key) {
      const old = byKey.get(f.key);
      if (!old) throw badRequest('有未知的会员字段，请刷新页面后重试');
      if (old.type !== f.type) throw badRequest(`会员字段「${old.label}」保存后不能改类型；需要时请停用后新建一个字段`);
      return { key: f.key, label, type: f.type, options, required: f.required, active: f.active };
    }
    next += 1;
    return { key: `f${next}`, label, type: f.type, options, required: f.required, active: f.active };
  });
}

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

export function registerSettingsRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/settings', { preHandler: guard('settings.manage') }, async () => loadSettings(sql));

  app.put('/api/settings', { preHandler: guard('settings.manage') }, async (req) => {
    const parsed = parse(SettingsInput, req.body);
    await sql.begin(async (tx) => {
      // 同时保存规则时串行执行，避免新字段编号冲突或互相覆盖
      await tx`SELECT pg_advisory_xact_lock(hashtext('settings'))`;
      const before = await loadSettings(tx);
      const input: Partial<StoreSettings> = {
        ...parsed,
        ...(parsed.memberFields ? { memberFields: normalizeMemberFields(before.memberFields, parsed.memberFields) } : {}),
        ...(parsed.memberChannels ? { memberChannels: normalizeChannels(before.memberChannels, parsed.memberChannels) } : {}),
      } as Partial<StoreSettings>;
      for (const [key, prop] of Object.entries(KEY_MAP)) {
        if (!(prop in input)) continue;
        const value = input[prop as keyof typeof input];
        // 「不限」「全天营业」存为 JSON null（不是 SQL NULL）
        await tx`
          INSERT INTO settings (key, value, updated_at, updated_by)
          VALUES (${key}, ${value === null ? tx`'null'::jsonb` : tx.json(value as never)}, now(), ${req.actor.id})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
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

export function isDeductionRule(value: unknown): value is DeductionRule {
  return typeof value === 'string' && (DEDUCTION_RULES as readonly string[]).includes(value);
}
