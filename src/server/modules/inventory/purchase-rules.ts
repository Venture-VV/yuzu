// 采购规则（v0.7.29 ERP 采购五项，docs/ERP_PURCHASING.md）：采购途径字典（E1）、询价门槛与最少报价家数（E5、E6）、
// 补货触发与目标天数（E4）。存成一条设置 purchase_rules，ERP「模块设置 → 采购规则」里改；没存的按默认（待确认）。
//
// 采购途径：键固定、名称可改；单据存键与当时的名称、途径说明。明确选了要写说明的途径（批发市场、网购平台……）必须写说明；
// 接口没传、按供应商默认或字典第一项带出的不强制（补单、补货建议生成的草稿、旧的调用）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_PURCHASE_RULES, type PurchaseChannelDef, type PurchaseRules } from '@shared/purchasing';
import type { Db } from '../../db';
import { guard } from '../../auth/guard';
import { ctxOf, type Deps } from '../../lib/context';
import { unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { parse } from '../../lib/validate';

const SETTING_KEY = 'purchase_rules';

export async function loadPurchaseRules(db: Db): Promise<PurchaseRules> {
  const [row] = await db<{ value: Partial<PurchaseRules> }[]>`SELECT value FROM settings WHERE key = ${SETTING_KEY}`;
  return { ...DEFAULT_PURCHASE_RULES, ...(row?.value ?? {}) };
}

export const ChannelKey = z.string().regex(/^[a-z0-9_]{1,32}$/, '采购途径的键只能用小写字母、数字、下划线');
/** 途径说明：档口、平台与店铺、门店名……（最多 60 字） */
export const ChannelNote = z.string().trim().max(60, '途径说明最多 60 个字');

const RulesInput = z
  .object({
    channels: z
      .array(
        z.object({
          key: ChannelKey,
          label: z.string().trim().min(1, '采购途径的名称不能为空').max(20, '采购途径的名称最多 20 个字'),
          needsNote: z.boolean(),
        }),
      )
      .min(1, '至少保留一个采购途径')
      .max(12, '采购途径最多 12 个')
      .refine((a) => new Set(a.map((c) => c.key)).size === a.length, '采购途径的键不能重复')
      .refine((a) => new Set(a.map((c) => c.label)).size === a.length, '采购途径的名称不能重复'),
    quoteThresholdCents: z.number().int().min(0, '询价门槛不能为负').max(100_000_000, '询价门槛不能超过 100 万元'),
    minQuotes: z.number().int().min(1, '至少 1 家').max(5, '最多要求 5 家'),
    reorderDays: z.number().int().min(1, '补货触发天数至少 1 天').max(90, '补货触发天数最多 90 天'),
    targetDays: z.number().int().min(1, '补货目标天数至少 1 天').max(180, '补货目标天数最多 180 天'),
  })
  .refine((r) => r.targetDays > r.reorderDays, { message: '补货目标天数要比触发天数长', path: ['targetDays'] });

/** 单据要写的采购途径三列 */
export interface ChannelColumns {
  channel: string;
  channelLabel: string;
  channelNote: string;
}

/**
 * 定采购途径：明确选了的按选的（要写说明的必须写；选的就是 fallback——供应商档案的默认途径——时说明选填，
 * 供应商档案已经说明在哪买）；没选的按 fallback，fallback 不在字典里时按第一项。
 */
export function resolveChannel(rules: PurchaseRules, input: { channel?: string | null; channelNote?: string | null }, fallback: string | null): ChannelColumns {
  const note = (input.channelNote ?? '').trim();
  const find = (key: string | null | undefined): PurchaseChannelDef | undefined => (key ? rules.channels.find((c) => c.key === key) : undefined);
  if (input.channel) {
    const def = find(input.channel);
    if (!def) throw unprocessable('CHANNEL_INVALID', `采购途径只能从固定选项里选：${rules.channels.map((c) => c.label).join('、')}`);
    if (def.needsNote && note.length < 2 && def.key !== fallback) {
      throw unprocessable('CHANNEL_NOTE_REQUIRED', `采购途径选了「${def.label}」，请写明在哪买的（例如档口、平台与店铺、门店名）`);
    }
    return { channel: def.key, channelLabel: def.label, channelNote: note };
  }
  const def = find(fallback) ?? rules.channels[0]!;
  return { channel: def.key, channelLabel: def.label, channelNote: note };
}

/** 供应商档案里的默认途径要在字典里（空 = 不设） */
export async function assertChannelKey(db: Db, key: string | null | undefined) {
  if (!key) return;
  const rules = await loadPurchaseRules(db);
  if (!rules.channels.some((c) => c.key === key)) {
    throw unprocessable('CHANNEL_INVALID', `默认采购途径只能从固定选项里选：${rules.channels.map((c) => c.label).join('、')}`);
  }
}

export function registerPurchaseRulesRoutes(app: FastifyInstance, { sql }: Deps) {
  // 编制采购单、登记报销都要读途径字典：挂在库存模块的前缀下（费用模块依赖库存，采购模块关着时报销也能读到）
  app.get('/api/inventory/purchase-rules', { preHandler: guard('inventory.read') }, async () => loadPurchaseRules(sql));
  app.put('/api/inventory/purchase-rules', { preHandler: guard('settings.manage') }, async (req) => {
    const rules = parse(RulesInput, req.body);
    return saveRuleSetting(sql, SETTING_KEY, loadPurchaseRules, () => rules, ctxOf(req));
  });
}
