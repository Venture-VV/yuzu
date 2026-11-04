// 小程序端口上的预约（小程序线第三期 3d，docs/MP_PHASE3.md 第 4 节）：顾客（网关带 openid，要小程序开着）。
//   · 预约页与「我的预约」：能不能约、可约的项目与房间、能约哪几天、自己的预约；可约时段；
//   · 预约（新约 201、同一个编号重提 200）、自己取消；结果不确定时确认作废。

import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../lib/context';
import { idParam, parse } from '../../lib/validate';
import { abandonBookingOp, bookingHome, bookingSlotsMp, cancelBookingMp, createBookingMp } from './bookings';
import { openidOf } from './member';
import { requireMpEnabled } from './rules';

export function registerMpBookingRoutes(app: FastifyInstance, deps: Deps) {
  const enabled = { preHandler: requireMpEnabled(deps.sql) };
  app.get('/api/mp/bookings', enabled, async (req) => bookingHome(deps, openidOf(req)));
  app.get('/api/mp/bookings/slots', enabled, async (req) => bookingSlotsMp(deps, req.query));
  app.post('/api/mp/bookings', enabled, async (req, reply) => {
    const r = await createBookingMp(deps, openidOf(req), req.body);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/mp/bookings/abandon', enabled, async (req) => abandonBookingOp(deps, openidOf(req), req.body));
  app.post('/api/mp/bookings/:id/cancel', enabled, async (req) => cancelBookingMp(deps, openidOf(req), parse(idParam, req.params).id, req.body));
}
