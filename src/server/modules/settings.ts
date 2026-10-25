import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
} as const satisfies Record<string, keyof StoreSettings>;

const DEFAULTS: StoreSettings = {
  storeName: '浴族 · 城市汤泉',
  deductionRule: 'principal_first',
  businessDayStartHour: 6,
  maxRechargeCents: 5_000_000,
  maxConsumeCents: 2_000_000,
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

const SettingsInput = z.object({
  storeName: z.string().trim().min(1, '请填写门店名称').max(32, '门店名称最多 32 个字'),
  deductionRule: z.enum(DEDUCTION_RULES, '扣款规则不正确'),
  businessDayStartHour: z.number().int().min(0, '营业日切换时间需在 0–12 点之间').max(12, '营业日切换时间需在 0–12 点之间'),
  maxRechargeCents: z.number().int().positive().max(100_000_000, '单笔充值上限过大'),
  maxConsumeCents: z.number().int().positive().max(100_000_000, '单笔消费上限过大'),
});

export function registerSettingsRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/settings', { preHandler: guard('settings.manage') }, async () => loadSettings(sql));

  app.put('/api/settings', { preHandler: guard('settings.manage') }, async (req) => {
    const input = parse(SettingsInput, req.body);
    const before = await loadSettings(sql);
    await sql.begin(async (tx) => {
      for (const [key, prop] of Object.entries(KEY_MAP)) {
        const value = input[prop as keyof typeof input];
        await tx`
          INSERT INTO settings (key, value, updated_at, updated_by)
          VALUES (${key}, ${tx.json(value as never)}, now(), ${req.actor.id})
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
