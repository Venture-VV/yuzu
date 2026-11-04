// ERP 独立工作区（v0.7.3，店主 2026-10-30 定，见 docs/ERP.md）：
//   · 模块开关：店主在 ERP「模块设置」里开关模块（设置项 erp_modules，只存改过的；没存的按注册表默认）；
//     依赖的模块关着时，这个模块也用不了；
//   · 模块拦截：属于关闭模块的接口一律拒绝（ERP_MODULE_DISABLED），按 @shared/erp 注册表里的接口前缀判断，
//     不用每个接口自己判断；CLI、自检、备份不经过接口，不受影响；
//   · 营业数据（只读）：与经营总览同一口径（结账计正、反结账冲回），另列已确认日结的营业日，不改任何门店数据。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ERP_MODULE_KEYS,
  ERP_MODULES,
  ERP_PERMISSIONS,
  effectiveErpModules,
  erpModuleOfApi,
  type ErpModuleKey,
  type ErpModuleSwitches,
  type ErpModulesInfo,
  type ErpRevenue,
} from '@shared/erp';
import { readSnapshot, type Db } from '../db';
import { guard, guardAny } from '../auth/guard';
import type { Deps } from '../lib/context';
import { ctxOf } from '../lib/context';
import { AppError } from '../lib/errors';
import { routePath } from '../lib/paths';
import { parse } from '../lib/validate';
import { executiveReport, reportClock, reportPeriod } from './reports';
import { saveRuleSetting } from '../lib/rule-settings';

/** 店主保存的模块开关（不认识的键忽略） */
export async function loadErpSwitches(db: Db): Promise<ErpModuleSwitches> {
  const [row] = await db<{ value: Record<string, unknown> }[]>`SELECT value FROM settings WHERE key = 'erp_modules'`;
  const out: ErpModuleSwitches = {};
  for (const key of ERP_MODULE_KEYS) {
    const v = row?.value?.[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/** 实际能用的 ERP 模块（开关与依赖都满足） */
export async function enabledErpModules(db: Db): Promise<Set<ErpModuleKey>> {
  return effectiveErpModules(await loadErpSwitches(db));
}

export async function erpModulesInfo(db: Db): Promise<ErpModulesInfo> {
  const switches = await loadErpSwitches(db);
  const enabled = effectiveErpModules(switches);
  const [meta] = await db<{ updatedAt: string; updatedBy: string | null }[]>`
    SELECT s.updated_at, st.display_name AS updated_by FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = 'erp_modules'`;
  return {
    modules: ERP_MODULE_KEYS.map((key) => {
      const d = ERP_MODULES[key];
      return {
        key,
        label: d.label,
        group: d.group,
        description: d.description,
        switchedOn: switches[key] ?? d.defaultEnabled,
        enabled: enabled.has(key),
        requires: [...d.requires],
      };
    }),
    updatedAt: meta ? new Date(meta.updatedAt).toISOString() : null,
    updatedBy: meta?.updatedBy ?? null,
  };
}

const SwitchesInput = z.object({
  modules: z.partialRecord(z.enum(ERP_MODULE_KEYS, '没有这个 ERP 模块'), z.boolean('模块开关只能是开或关')),
});

/**
 * 模块拦截：属于关闭模块的接口一律拒绝。只拦已登录的请求（没登录的照常由接口自己返回 401，不透露模块设置）。
 * 每次按设置项判断，店主改了开关马上生效。
 */
export function registerErpModuleGate(app: FastifyInstance, deps: Deps) {
  app.addHook('preHandler', async (req) => {
    // 按实际进入的接口认模块（路由按解码后的路径匹配，原始地址可能做了 URL 编码）
    const key = erpModuleOfApi(routePath(req));
    if (!key || !req.hasSession) return;
    if ((await enabledErpModules(deps.sql)).has(key)) return;
    const def = ERP_MODULES[key];
    throw new AppError(403, 'ERP_MODULE_DISABLED', `ERP 的「${def.label}」模块没有开启（或它依赖的模块没有开启），请店主在 ERP「模块设置」里开启`, { module: key });
  });
}

export function registerErpRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  // 模块列表与开关：能进 ERP 的人都能看（导航按它显示）；只有店主能改
  app.get('/api/erp/modules', { preHandler: guardAny(...ERP_PERMISSIONS) }, async () => erpModulesInfo(sql));

  app.put('/api/erp/modules', { preHandler: guard('settings.manage') }, async (req) => {
    const { modules } = parse(SwitchesInput, req.body);
    await saveRuleSetting(sql, 'erp_modules', loadErpSwitches, (before): ErpModuleSwitches => ({ ...before, ...modules }), ctxOf(req));
    return erpModulesInfo(sql);
  });

  // 营业数据（只读）：与经营总览同一口径；另列这段时间里已确认日结的营业日
  app.get('/api/erp/revenue', { preHandler: guard('erp.revenue') }, async (req): Promise<ErpRevenue> => {
    const { c, today } = await reportClock(deps);
    const { from, to } = reportPeriod(req.query, today);
    return readSnapshot(sql, async (tx) => {
      const r = await executiveReport(tx, from, to, c);
      const settlements = await tx<ErpRevenue['settlements']>`
        SELECT to_char(d.business_date, 'YYYY-MM-DD') AS date, d.closed_at, s.display_name AS closed_by_name
        FROM daily_settlements d JOIN staff s ON s.id = d.closed_by
        WHERE d.business_date BETWEEN ${from} AND ${to} ORDER BY d.business_date`;
      const k = r.kpis;
      return {
        from: r.from,
        to: r.to,
        days: r.days,
        kpis: { receivable: k.receivable, discount: k.discount, coupon: k.coupon, memberDiscount: k.memberDiscount, refund: k.refund, net: k.net, guests: k.guests, checkouts: k.checkouts, perGuest: k.perGuest, rechargePaid: k.rechargePaid, memberRefund: k.memberRefund },
        trend: r.trend,
        byMethod: r.byMethod,
        departments: r.departments,
        settlements: settlements.map((x) => ({ ...x, closedAt: new Date(x.closedAt).toISOString() })),
      };
    });
  });
}
