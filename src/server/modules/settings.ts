import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HHMM } from '@shared/business-date';
import { DEDUCTION_RULES, type DeductionRule } from '@shared/deduction';
import type { StoreRules } from '@shared/types';
import type { Db } from '../db';
import { writeAudit } from '../lib/audit';
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
} as const satisfies Record<string, keyof StoreSettings>;

// 单笔上限按店主 2026-10-27 答复（#9）默认 50 万元；撤销时限、营业时间默认与之前一致（不限、全天），待确认
const DEFAULTS: StoreSettings = {
  storeName: '浴族 · 城市汤泉',
  deductionRule: 'principal_first',
  businessDayStartHour: 6,
  maxRechargeCents: 50_000_000,
  maxConsumeCents: 50_000_000,
  reversalWindowHours: null,
  businessHours: null,
};

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
  })
  // 只提交要修改的项（各设置卡片分别保存）；没有提交的项保持原值
  .partial();

export function registerSettingsRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/settings', { preHandler: guard('settings.manage') }, async () => loadSettings(sql));

  app.put('/api/settings', { preHandler: guard('settings.manage') }, async (req) => {
    const input = parse(SettingsInput, req.body);
    const before = await loadSettings(sql);
    await sql.begin(async (tx) => {
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
