// 8.0.9 安保巡场的接口（docs/PATROL_V809.md）：
//   · 后台 /api/erp/patrol/*（主端口，ERP 注册表按模块开关拦截）：今天、巡场记录与导出、作废、场所与二维码、设置；
//   · 员工端 /api/canteen/patrol/*（员工端口，柚子饭堂）：今天 / 某一天、打卡。安保巡场模块关着时回「巡场还没开」。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { guard, guardAny } from '../../auth/guard';
import type { AppConfig } from '../../config';
import type { Sql } from '../../db';
import { ctxOf, type Deps } from '../../lib/context';
import { csvReply } from '../../lib/csv';
import { AppError } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { enabledErpModules } from '../erp';
import type { CanteenSessionEmployee } from '../canteen/portal-auth';
import {
  createPatrolPoint,
  patrolDayAdmin,
  patrolDayPortal,
  patrolPointsAdmin,
  patrolRecords,
  patrolRecordsCsv,
  patrolSettingsAdmin,
  recordPatrolCheckin,
  RecordsQuery,
  rotatePatrolToken,
  savePatrolSettings,
  updatePatrolPoint,
  voidPatrolCheckin,
} from './core';

export function registerPatrolAdminRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const read = guardAny('patrol.read', 'patrol.manage');
  const manage = guard('patrol.manage');

  // 今天（某一天）：每个场所谁几点巡过、还没人巡的
  app.get('/api/erp/patrol/day', { preHandler: read }, async (req) => patrolDayAdmin(sql, config, req.query ?? {}));

  // 巡场记录：按营业日起止、场所、人筛选；导出与页面同一个查询
  app.get('/api/erp/patrol/records', { preHandler: read }, async (req) => patrolRecords(sql, req.query ?? {}));
  app.get('/api/erp/patrol/records/export', { preHandler: read }, async (req, reply) => {
    const q = parse(RecordsQuery, req.query ?? {});
    return csvReply(reply, `巡场记录-${q.from}至${q.to}.csv`, patrolRecordsCsv(await patrolRecords(sql, q), config.timezone));
  });
  app.post('/api/erp/patrol/checkins/:id/void', { preHandler: manage }, async (req) => voidPatrolCheckin(sql, parse(idParam, req.params).id, req.body, ctxOf(req)));

  // 场所与二维码：场所码只有「场所与设置」权限看得到（打印、换码）
  app.get('/api/erp/patrol/points', { preHandler: manage }, async () => patrolPointsAdmin(sql, config));
  app.post('/api/erp/patrol/points', { preHandler: manage }, async (req) => createPatrolPoint(sql, req.body, ctxOf(req)));
  app.put('/api/erp/patrol/points/:id', { preHandler: manage }, async (req) => ({ point: await updatePatrolPoint(sql, parse(idParam, req.params).id, req.body, ctxOf(req)) }));
  app.post('/api/erp/patrol/points/:id/token', { preHandler: manage }, async (req) => ({ point: await rotatePatrolToken(sql, parse(idParam, req.params).id, req.body, ctxOf(req)) }));

  // 设置：巡场部门、手机上能看记录的人
  app.get('/api/erp/patrol/settings', { preHandler: manage }, async () => patrolSettingsAdmin(sql));
  app.put('/api/erp/patrol/settings', { preHandler: manage }, async (req) => {
    await savePatrolSettings(sql, req.body, ctxOf(req));
    return patrolSettingsAdmin(sql);
  });
}

/**
 * 员工端口上的巡场接口（在柚子饭堂的 Fastify 实例里挂）：登录与来源核对、「员工食堂」开没开都由员工端口的钩子先管，
 * 这里另外核对「安保巡场」模块开没开（缓存 3 秒，与员工食堂的开关一样）。
 */
export function registerPatrolPortalRoutes(
  app: FastifyInstance,
  sql: Sql,
  config: AppConfig,
  opts: { who: (req: FastifyRequest) => CanteenSessionEmployee; now: () => number; openCacheMs?: number },
) {
  const cacheMs = opts.openCacheMs ?? 3000;
  let cache: { at: number; open: boolean } | null = null;
  const assertOpen = async () => {
    if (!cache || Date.now() - cache.at >= cacheMs) cache = { at: Date.now(), open: (await enabledErpModules(sql)).has('patrol') };
    if (!cache.open) throw new AppError(503, 'PATROL_CLOSED', '巡场还没开：请管理员在 yuzu 的 ERP「模块设置」里打开「安保巡场」');
  };

  /** 今天（或某一天，后台指定的人才能看以前的） */
  app.get('/api/canteen/patrol/day', async (req) => {
    const me = opts.who(req);
    await assertOpen();
    return patrolDayPortal(sql, config, me, req.query ?? {}, opts.now());
  });

  /** 打卡：扫到的码（整个地址或场所码）、扫到的时间、操作编号 */
  app.post('/api/canteen/patrol/checkins', async (req) => {
    const me = opts.who(req);
    await assertOpen();
    return recordPatrolCheckin({ sql, config }, me, req.body, opts.now());
  });
}
