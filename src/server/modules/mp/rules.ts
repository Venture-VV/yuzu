// 小程序的开关与规则（settings 的 mp_rules）：默认关闭，店主在后台「小程序」里开（第 12 节）。

import type { preHandlerAsyncHookHandler } from 'fastify';
import {
  DEFAULT_MP_COUPON_RULES,
  DEFAULT_MP_RECHARGE_RULES,
  DEFAULT_MP_RULES,
  MP_COUPON_RULES_KEY,
  MP_RECHARGE_RULES_KEY,
  MP_RULES_KEY,
  type MpCouponRules,
  type MpRechargeRules,
  type MpRules,
} from '@shared/mp';
import type { Db } from '../../db';
import { AppError } from '../../lib/errors';

export async function loadMpRules(db: Db): Promise<MpRules> {
  const [row] = await db<{ value: Partial<MpRules> | null }[]>`SELECT value FROM settings WHERE key = ${MP_RULES_KEY}`;
  return { ...DEFAULT_MP_RULES, ...(row?.value ?? {}) };
}

/** 线上充值的设置（第二期 2a，settings 的 mp_recharge_rules）：默认关 */
export async function loadRechargeRules(db: Db): Promise<MpRechargeRules> {
  const [row] = await db<{ value: Partial<MpRechargeRules> | null }[]>`SELECT value FROM settings WHERE key = ${MP_RECHARGE_RULES_KEY}`;
  return { ...DEFAULT_MP_RECHARGE_RULES, ...(row?.value ?? {}) };
}

/** 领券中心的设置（第二期 2c，settings 的 mp_coupon_rules）：默认关、没有可领的券 */
export async function loadCouponRules(db: Db): Promise<MpCouponRules> {
  const [row] = await db<{ value: Partial<MpCouponRules> | null }[]>`SELECT value FROM settings WHERE key = ${MP_COUPON_RULES_KEY}`;
  return { ...DEFAULT_MP_COUPON_RULES, ...(row?.value ?? {}) };
}

/** 店主在后台「小程序」里开了才对顾客开放（默认关闭）；health 不看开关 */
export const requireMpEnabled = (db: Db): preHandlerAsyncHookHandler => async () => {
  if (!(await loadMpRules(db)).enabled) throw new AppError(403, 'MP_DISABLED', '小程序还没开放，请到前台咨询');
};
