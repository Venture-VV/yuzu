// 小程序端口上的领券中心（小程序线第二期 2c，docs/MP_COUPONS.md）：顾客（网关带 openid，要小程序开着）看可领的券、领取、确认作废。

import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../lib/context';
import { abandonCouponClaim, claimCoupon, couponCenter } from './coupon-center';
import { openidOf } from './member';
import { requireMpEnabled } from './rules';

export function registerMpCouponRoutes(app: FastifyInstance, deps: Deps) {
  const enabled = { preHandler: requireMpEnabled(deps.sql) };
  app.get('/api/mp/coupon-center', enabled, async (req) => couponCenter(deps, openidOf(req)));
  app.post('/api/mp/coupon-claims', enabled, async (req, reply) => {
    const r = await claimCoupon(deps, openidOf(req), req.body);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/mp/coupon-claims/abandon', enabled, async (req) => abandonCouponClaim(deps, openidOf(req), req.body));
}
