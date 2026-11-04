// 小程序端口上的扫码点餐（小程序线第三期 3c，docs/MP_PHASE3.md 第 3 节）：顾客（网关带 openid，要小程序开着）。
//   · 点餐页：开没开、能不能点、扫到的桌、可点的菜；
//   · 下单（新下 201、同一个编号重提 200）；结果不确定时确认作废；
//   · 「我的账单」：在店手牌的账单。

import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../lib/context';
import { abandonFoodOrder, foodBill, foodMenu, orderFood } from './food';
import { openidOf } from './member';
import { requireMpEnabled } from './rules';

export function registerMpFoodRoutes(app: FastifyInstance, deps: Deps) {
  const enabled = { preHandler: requireMpEnabled(deps.sql) };
  app.get('/api/mp/food/menu', enabled, async (req) => foodMenu(deps, openidOf(req), req.query));
  app.post('/api/mp/food/orders', enabled, async (req, reply) => {
    const r = await orderFood(deps, openidOf(req), req.body);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/mp/food/orders/abandon', enabled, async (req) => abandonFoodOrder(deps, openidOf(req), req.body));
  app.get('/api/mp/food/bill', enabled, async (req) => foodBill(deps, openidOf(req)));
}
