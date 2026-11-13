// 采购规则（v0.7.29 ERP 采购五项起，docs/ERP_PURCHASING.md；8.0.1 采购组整改，docs/PURCHASING_V801.md）：
// 存成一条设置 purchase_rules，在「采购 → 采购规则」里改（8.0.1 起从 ERP「模块设置」挪过来，CG01）；没存的按默认（待确认）。
//   · 采购途径固定三类（08，CG08）：网购、自采（现采 / 零采）、供应商，改不了、加不了；
//   · 询价门槛与最少报价家数（E5、E6）、补货触发与目标天数（E4）、下单后几天没到货算超期（从费用报销规则挪过来）；
//   · 每日截单（03，CG03）、需求单转的采购单免二次审批（04，CG04）、急采分级审批（05，CG05）；
//   · 采购流程图里一个环节等了几天标红（8.0.17，LC4）；哪些需求单要部门主管先确认（8.0.17，LC1、LC11）。
// 改采购规则要「维护采购规则」（默认只有店主，可在岗位权限里下放）；有查看库存的都能看。
//
// 采购途径：单据存键与当时的名称、途径说明。明确选了要写说明的途径（网购、自采）必须写说明；
// 接口没传、按供应商默认或「供应商」带出的不强制（补单、补货建议生成的草稿、旧的调用）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  channelCategory,
  DEFAULT_CHANNEL_KEY,
  DEFAULT_PURCHASE_RULES,
  DEPT_CONFIRM_RULES,
  PURCHASE_CHANNELS,
  URGENT_TIERS_MAX,
  type PurchaseChannelDef,
  type PurchaseRules,
} from '@shared/purchasing';
import { APPROVAL_MAX_STAFF } from '@shared/approvals';
import type { Db } from '../../db';
import { guard } from '../../auth/guard';
import { ctxOf, type Deps } from '../../lib/context';
import { unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { parse } from '../../lib/validate';
import { assertApprovers } from '../approvals/approvers';

const SETTING_KEY = 'purchase_rules';

export async function loadPurchaseRules(db: Db): Promise<PurchaseRules> {
  const rows = await db<{ key: string; value: Record<string, unknown> }[]>`SELECT key, value FROM settings WHERE key IN (${SETTING_KEY}, 'expense_rules')`;
  const stored = (rows.find((r) => r.key === SETTING_KEY)?.value ?? {}) as Partial<PurchaseRules>;
  // 旧版本存的途径字典不再用（固定三类，CG08）
  const { channels: _old, ...rest } = stored;
  // 「下单后几天没到货算超期」8.0.1 从费用报销规则挪过来（CG01）：采购规则里还没存过的，沿用原来费用报销规则里的值
  const legacyArrival = rows.find((r) => r.key === 'expense_rules')?.value?.arrivalOverdueDays;
  const arrival = rest.arrivalOverdueDays ?? (typeof legacyArrival === 'number' ? legacyArrival : undefined);
  const rules: PurchaseRules = { ...DEFAULT_PURCHASE_RULES, ...rest, ...(arrival !== undefined ? { arrivalOverdueDays: arrival } : {}), channels: PURCHASE_CHANNELS };
  return { ...rules, urgentTiers: [...rules.urgentTiers].sort((a, b) => a.maxCents - b.maxCents) };
}

/** 格式核对；是不是三类之一在 resolveChannel / assertChannelKey 里核对（报 CHANNEL_INVALID，列出能选的） */
export const ChannelKey = z.string().regex(/^[a-z0-9_]{1,32}$/, '采购途径的键只能用小写字母、数字、下划线');
/** 途径说明：平台与店铺、市场或门店名……（最多 60 字） */
export const ChannelNote = z.string().trim().max(60, '途径说明最多 60 个字');

const RulesInput = z
  .object({
    quoteThresholdCents: z.number().int().min(0, '询价门槛不能为负').max(100_000_000, '询价门槛不能超过 100 万元'),
    minQuotes: z.number().int().min(1, '至少 1 家').max(5, '最多要求 5 家'),
    reorderDays: z.number().int().min(1, '补货触发天数至少 1 天').max(90, '补货触发天数最多 90 天'),
    targetDays: z.number().int().min(1, '补货目标天数至少 1 天').max(180, '补货目标天数最多 180 天'),
    arrivalOverdueDays: z.number().int().min(1, '到货超期天数至少 1 天').max(90, '到货超期天数最多 90 天'),
    cutoffEnabled: z.boolean(),
    cutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '截单时间要写成 17:00 这样（24 小时制）'),
    requestPoDirect: z.boolean(),
    flowStallDays: z.number().int().min(0, '环节超期天数不能为负').max(30, '环节超期天数最多 30 天'),
    deptConfirm: z.enum(DEPT_CONFIRM_RULES, '部门主管确认只能选：不要、估价达到询价门槛的、全部'),
    urgentTiers: z
      .array(
        z.object({
          maxCents: z.number().int().min(100, '每一档至少 ¥1').max(100_000_000, '每一档最多 100 万元'),
          approverIds: z.array(z.number().int().positive()).max(APPROVAL_MAX_STAFF, `每一档最多指定 ${APPROVAL_MAX_STAFF} 个人`),
        }),
      )
      .min(1, '急采至少要有一档')
      .max(URGENT_TIERS_MAX, `急采最多分 ${URGENT_TIERS_MAX} 档`)
      .refine((t) => t.every((x, i) => i === 0 || x.maxCents > t[i - 1]!.maxCents), '急采分级的金额要一档比一档高')
      .refine((t) => t.every((x) => new Set(x.approverIds).size === x.approverIds.length), '同一档里指定的人重复了'),
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
 * 供应商档案已经说明在哪买）；没选的按 fallback，fallback 不在三类里时按「供应商」。
 */
export function resolveChannel(_rules: PurchaseRules, input: { channel?: string | null; channelNote?: string | null }, fallback: string | null): ChannelColumns {
  const note = (input.channelNote ?? '').trim();
  const find = (key: string | null | undefined): PurchaseChannelDef | undefined => (key ? PURCHASE_CHANNELS.find((c) => c.key === key) : undefined);
  if (input.channel) {
    const def = find(input.channel);
    if (!def) throw unprocessable('CHANNEL_INVALID', `采购途径只能选：${PURCHASE_CHANNELS.map((c) => c.label).join('、')}`);
    if (def.needsNote && note.length < 2 && def.key !== channelCategory(fallback)) {
      throw unprocessable('CHANNEL_NOTE_REQUIRED', `采购途径选了「${def.label}」，请写明在哪买的（例如平台与店铺、市场或门店名）`);
    }
    return { channel: def.key, channelLabel: def.label, channelNote: note };
  }
  // 供应商档案里还是旧的途径键时按三类算（CG08）
  const def = find(channelCategory(fallback)) ?? find(DEFAULT_CHANNEL_KEY)!;
  return { channel: def.key, channelLabel: def.label, channelNote: note };
}

/** 供应商档案里的默认途径要是三类之一（空 = 不设） */
export async function assertChannelKey(_db: Db, key: string | null | undefined) {
  if (!key) return;
  if (!PURCHASE_CHANNELS.some((c) => c.key === key)) {
    throw unprocessable('CHANNEL_INVALID', `默认采购途径只能选：${PURCHASE_CHANNELS.map((c) => c.label).join('、')}`);
  }
}

export function registerPurchaseRulesRoutes(app: FastifyInstance, { sql }: Deps) {
  // 编制采购单、登记报销都要读途径：挂在库存模块的前缀下（费用模块依赖库存，采购模块关着时报销也能读到）
  app.get('/api/inventory/purchase-rules', { preHandler: guard('inventory.read') }, async () => loadPurchaseRules(sql));
  // 只改提交的字段：在规则锁里读出当前规则再合并（与前台规则一样），旧页面没带的新字段不会被冲掉
  app.put('/api/inventory/purchase-rules', { preHandler: guard('purchase.rules') }, async (req) =>
    saveRuleSetting(
      sql,
      SETTING_KEY,
      loadPurchaseRules,
      async (before, tx) => {
        const { channels: _ignored, ...current } = before;
        const raw = (req.body ?? {}) as Record<string, unknown>;
        const { channels: _sent, ...patch } = raw;
        const rules = parse(RulesInput, { ...current, ...patch });
        await assertApprovers(tx, rules.urgentTiers.flatMap((t) => t.approverIds));
        return { ...rules, channels: PURCHASE_CHANNELS };
      },
      ctxOf(req),
    ),
  );
}
