// 员工食堂 · 管理后台接口（ERP「员工食堂」，docs/CANTEEN.md 第 1 节）：只在员工后台的主端口上，前缀 /api/erp/canteen，
// 模块关着时按 ERP 注册表统一拦截（ERP_MODULE_DISABLED）；要有「管理员工食堂」权限（canteen.manage，K1）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CanteenOverview } from '@shared/canteen';
import { businessDateOf } from '@shared/business-date';
import { guard } from '../../auth/guard';
import { readSnapshot } from '../../db';
import type { Deps } from '../../lib/context';
import { ctxOf } from '../../lib/context';
import { csvReply, toCsv } from '../../lib/csv';
import { idParam, parse } from '../../lib/validate';
import { enabledErpModules } from '../erp';
import { canteenToday, checkinCsvRows, dailyCounts, listCheckins, voidCheckin } from './checkins';
import { activationCards, batchEmployees, createEmployee, listEmployees, reissueActivation, updateEmployee } from './employees';
import { listMenus, topDishes } from './menus';
import { canteenPortOpen } from './portal';
import { canteenDepartmentName, createCanteenDepartment, loadCanteenSettings, saveCanteenSettings } from './settings';

const daysAgo = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export function registerCanteenAdminRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const manage = { preHandler: guard('canteen.manage') };

  app.get('/api/erp/canteen/overview', manage, async (): Promise<CanteenOverview> =>
    readSnapshot(sql, async (tx) => {
      const settings = await loadCanteenSettings(tx);
      const today = await canteenToday(tx, config);
      const [people] = await tx<CanteenOverview['people'][]>`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active,
               count(*) FILTER (WHERE active AND password_hash IS NOT NULL)::int AS activated,
               count(*) FILTER (WHERE active AND password_hash IS NULL)::int AS pending,
               count(*) FILTER (WHERE active AND role = 'cook')::int AS cooks,
               count(*) FILTER (WHERE active AND role = 'manager')::int AS managers
        FROM canteen_employees`;
      const date = businessDateOf(new Date(), config.timezone, 0);
      return {
        enabled: (await enabledErpModules(tx)).has('canteen'),
        settings,
        departmentName: await canteenDepartmentName(tx, settings),
        today,
        people: people!,
        days: await dailyCounts(tx, daysAgo(date, 13), date),
        topDishes: await topDishes(tx, daysAgo(date, 6), date),
        portOpen: canteenPortOpen(config),
      };
    }),
  );

  // ── 设置 ──
  app.get('/api/erp/canteen/settings', manage, async () => loadCanteenSettings(sql));
  app.put('/api/erp/canteen/settings', manage, async (req) => saveCanteenSettings(sql, req.body, ctxOf(req)));
  /** 一键新建食堂部门（已有同名的就用那个） */
  app.post('/api/erp/canteen/department', manage, async (req) => createCanteenDepartment(sql, (req.body as { name?: unknown } | null)?.name, ctxOf(req)));
  /** 选部门用：在用的部门 */
  app.get('/api/erp/canteen/departments', manage, async () =>
    sql<{ id: number; name: string }[]>`SELECT id, name FROM departments WHERE active ORDER BY sort_order, id`);

  // ── 员工名单 ──
  app.get('/api/erp/canteen/employees', manage, async () => listEmployees(sql));
  app.post('/api/erp/canteen/employees', manage, async (req) => createEmployee(sql, req.body, ctxOf(req)));
  app.post('/api/erp/canteen/employees/batch', manage, async (req) => batchEmployees(sql, req.body, ctxOf(req)));
  app.put('/api/erp/canteen/employees/:id', manage, async (req) => {
    const { id } = parse(idParam, req.params);
    return updateEmployee(sql, id, req.body, ctxOf(req));
  });
  app.post('/api/erp/canteen/employees/:id/activation', manage, async (req) => {
    const { id } = parse(idParam, req.params);
    return reissueActivation(sql, id, req.body, ctxOf(req));
  });
  /** 开通卡片：ids=1,2,3（不给为全部还没开通、开通码没过期的） */
  app.get('/api/erp/canteen/activation-cards', manage, async (req) => {
    const raw = (req.query as { ids?: string }).ids;
    const ids = raw ? parse(z.array(z.coerce.number().int().positive()).max(500), raw.split(',')) : null;
    return activationCards(sql, ids);
  });

  // ── 菜单（只看） ──
  app.get('/api/erp/canteen/menus', manage, async (req) => {
    const q = req.query as { from?: string; to?: string };
    return listMenus(sql, q.from, q.to, { drafts: true });
  });

  // ── 用餐记录 ──
  app.get('/api/erp/canteen/checkins', manage, async (req) => listCheckins(sql, req.query));
  app.get('/api/erp/canteen/checkins.csv', manage, async (req, reply) => {
    const q = req.query as { from?: string; to?: string };
    const rows = await listCheckins(sql, req.query);
    return csvReply(reply, `饭堂用餐记录-${q.from}-${q.to}.csv`, toCsv(checkinCsvRows(rows, config.timezone)));
  });
  app.post('/api/erp/canteen/checkins/:id/void', manage, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidCheckin(sql, id, req.body, { staffId: req.actor.id }, config.timezone);
  });
}
