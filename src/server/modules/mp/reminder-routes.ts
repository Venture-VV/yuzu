// 小程序端口上的到期提醒（小程序线第三期 3a，docs/MP_PHASE3.md 第 1 节）：
//   · 顾客（网关带 openid，要小程序开着）：能设哪几种提醒、已经设了哪些；设一条提醒（新记 201、同一个编号重提 200）；
//   · 网关（只认网关密钥、不带 openid）：每 30 秒取一批待发的消息、发完回报结果。

import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../lib/context';
import { openidOf } from './member';
import { consentReminder, leaseReminders, reminderOptions, reportReminders } from './reminders';
import { requireMpEnabled } from './rules';

/** clock：网关来取时按什么时间算 10:00–20:00（测试给固定的时间；平时是此刻） */
export function registerMpReminderRoutes(app: FastifyInstance, deps: Deps, clock: () => Date = () => new Date()) {
  const enabled = { preHandler: requireMpEnabled(deps.sql) };
  app.get('/api/mp/reminders', enabled, async (req) => reminderOptions(deps, openidOf(req)));
  app.post('/api/mp/reminders', enabled, async (req, reply) => {
    const r = await consentReminder(deps, openidOf(req), req.body);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/mp/gateway/reminders/lease', async (req) => leaseReminders(deps, req.body ?? {}, clock()));
  app.post('/api/mp/gateway/reminders/report', async (req) => reportReminders(deps, req.body, clock()));
}
