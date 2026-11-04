// 小程序端口上的线上充值（小程序线第二期 2a，docs/MP_RECHARGE.md）：
//   · 顾客（网关带 openid，要小程序开着）：可充的项、自定义金额的预估、建单、确认作废、查单、继续支付、取消、模拟支付；
//   · 到账通知（网关原样转来，没有 openid）：不看小程序与线上充值的开关——已经付了的照样入账。成功回 204，其余回错误由网关告诉微信失败、等重发。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MP_RECHARGE_ORDER_NO } from '@shared/mp';
import type { Deps } from '../../lib/context';
import { parse } from '../../lib/validate';
import { openidOf } from './member';
import type { PayRuntime } from './pay';
import {
  abandonRechargeCreate,
  cancelRechargeOrder,
  createRechargeOrder,
  getRechargeOrder,
  handlePayNotify,
  mockPayRechargeOrder,
  payRechargeOrder,
  rechargeOptions,
  rechargePreview,
} from './recharge';
import { requireMpEnabled } from './rules';

const NoParam = z.object({ no: z.string().regex(MP_RECHARGE_ORDER_NO, '充值单号不正确') });
const noOf = (req: FastifyRequest) => parse(NoParam, req.params).no;

export function registerMpRechargeRoutes(app: FastifyInstance, deps: Deps, pay: PayRuntime | null) {
  const enabled = { preHandler: requireMpEnabled(deps.sql) };
  app.get('/api/mp/recharge', enabled, async (req) => rechargeOptions(deps, pay, openidOf(req)));
  app.get('/api/mp/recharge/preview', enabled, async (req) => rechargePreview(deps, openidOf(req), req.query));
  app.post('/api/mp/recharge/orders', enabled, async (req, reply) => {
    const r = await createRechargeOrder(deps, pay, openidOf(req), req.body);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/mp/recharge/abandon', enabled, async (req) => abandonRechargeCreate(deps, openidOf(req), req.body));
  app.get('/api/mp/recharge/orders/:no', enabled, async (req) => getRechargeOrder(deps, pay, openidOf(req), noOf(req)));
  app.post('/api/mp/recharge/orders/:no/pay', enabled, async (req) => payRechargeOrder(deps, pay, openidOf(req), noOf(req)));
  app.post('/api/mp/recharge/orders/:no/cancel', enabled, async (req) => cancelRechargeOrder(deps, pay, openidOf(req), noOf(req)));
  app.post('/api/mp/recharge/orders/:no/mock-pay', enabled, async (req) => mockPayRechargeOrder(deps, pay, openidOf(req), noOf(req)));
  app.post('/api/mp/pay/notify', async (req, reply) => {
    await handlePayNotify(deps, pay, req.body);
    return reply.code(204).send();
  });
}
