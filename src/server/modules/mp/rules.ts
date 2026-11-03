// 小程序的开关与规则（settings 的 mp_rules）：默认关闭，店主在后台「小程序」里开（第 12 节）。

import type { preHandlerAsyncHookHandler } from 'fastify';
import { DEFAULT_MP_RULES, MP_RULES_KEY, type MpRules } from '@shared/mp';
import type { Db } from '../../db';
import { AppError } from '../../lib/errors';

export async function loadMpRules(db: Db): Promise<MpRules> {
  const [row] = await db<{ value: Partial<MpRules> | null }[]>`SELECT value FROM settings WHERE key = ${MP_RULES_KEY}`;
  return { ...DEFAULT_MP_RULES, ...(row?.value ?? {}) };
}

/** 店主在后台「小程序」里开了才对顾客开放（默认关闭）；health 不看开关 */
export const requireMpEnabled = (db: Db): preHandlerAsyncHookHandler => async () => {
  if (!(await loadMpRules(db)).enabled) throw new AppError(403, 'MP_DISABLED', '小程序还没开放，请到前台咨询');
};
