// VIP 柜设置（8.0.4，docs/MEMBERSHIP_V804.md 第 2 节）：各档能用到几级柜、当场授权开关。
// 原来分在「会员规则」（membership_rules.vipLockerLevels）与「手牌与前台」（frontdesk_rules.vipOverrideEnabled）两处，
// 迁移 088 合成一份 vip_locker_rules、归「会员权益」（权限「维护会员权益」）。前台发牌、换牌的核对，会员详情的
// 「能用几级柜」，他店查询都读这里；核对的规则与结果不变。
// 锁：保存走规则锁（saveRuleSetting），整页带打开时读到的值，别人刚改过就拒绝。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_VIP_LEVEL } from '@shared/frontdesk';
import { DEFAULT_VIP_LOCKER_RULES, MAX_GRADE, type VipLockerRules, type VipLockerSettings } from '@shared/membership';
import { guard } from '../auth/guard';
import type { Db } from '../db';
import { ctxOf, type Deps } from '../lib/context';
import { conflict } from '../lib/errors';
import { sameJson, saveRuleSetting } from '../lib/rule-settings';
import { parse } from '../lib/validate';

export const VIP_LOCKER_RULES_KEY = 'vip_locker_rules';

export async function loadVipLockerRules(db: Db): Promise<VipLockerRules> {
  const [row] = await db<{ value: Partial<VipLockerRules> }[]>`SELECT value FROM settings WHERE key = ${VIP_LOCKER_RULES_KEY}`;
  const v = row?.value ?? {};
  return {
    levels: Array.isArray(v.levels) && v.levels.length === MAX_GRADE + 1 ? v.levels.map(Number) : [...DEFAULT_VIP_LOCKER_RULES.levels],
    overrideEnabled: typeof v.overrideEnabled === 'boolean' ? v.overrideEnabled : DEFAULT_VIP_LOCKER_RULES.overrideEnabled,
  };
}

const RulesInput = z
  .object({
    levels: z
      .array(z.number('请填写 VIP 柜等级').int('VIP 柜等级取整数').min(0, 'VIP 柜等级不能为负').max(MAX_VIP_LEVEL, `VIP 柜最多 ${MAX_VIP_LEVEL} 级`))
      .length(MAX_GRADE + 1, '每一档都要填能用几级 VIP 柜'),
    overrideEnabled: z.boolean('请选择是否允许当场授权'),
  })
  .superRefine((r, ctx) => {
    if (r.levels.some((v, i) => i > 0 && v < r.levels[i - 1]!)) ctx.addIssue({ code: 'custom', path: ['levels'], message: '高档能用的 VIP 柜不能比低档少' });
  });

export async function vipLockerSettings(db: Db): Promise<VipLockerSettings> {
  const rules = await loadVipLockerRules(db);
  const [meta] = await db<{ updatedAt: string; updatedByName: string | null }[]>`
    SELECT s.updated_at, st.display_name AS updated_by_name FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = ${VIP_LOCKER_RULES_KEY}`;
  const counts = await db<{ level: number; n: number }[]>`
    SELECT vip_level AS level, count(*)::int AS n FROM hand_tags WHERE kind = 'vip' AND active GROUP BY vip_level ORDER BY vip_level`;
  const lockerCounts: Record<number, number> = {};
  for (let level = 1; level <= MAX_VIP_LEVEL; level++) lockerCounts[level] = 0;
  for (const c of counts) lockerCounts[Number(c.level)] = c.n;
  return { rules, updatedAt: meta?.updatedAt ?? null, updatedByName: meta?.updatedByName ?? null, lockerCounts };
}

export function registerVipLockerRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/vip-lockers', { preHandler: guard('benefit.publish') }, async () => vipLockerSettings(sql));
  // 整页保存：带上打开时读到的设置（based），这期间别人保存过就拒绝，不悄悄改回别人的修改
  app.put('/api/vip-lockers', { preHandler: guard('benefit.publish') }, async (req) => {
    const based = (req.body as { based?: unknown } | null)?.based;
    await saveRuleSetting(
      sql,
      VIP_LOCKER_RULES_KEY,
      loadVipLockerRules,
      (before) => {
        if (based !== undefined && !sameJson(based, before)) {
          throw conflict('RULES_CHANGED', 'VIP 柜设置刚被别人改过，页面已换成最新的设置，请核对后重新修改、保存');
        }
        return parse(RulesInput, { ...before, ...(req.body as object) });
      },
      ctxOf(req),
    );
    return vipLockerSettings(sql);
  });
}
