// 小程序端口上要绑定会员的接口（网关带 openid）：绑定（结果不确定时确认作废）、会员卡与余额、流水、券、会员码、会员端提醒。

import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../lib/context';
import { abandonBind, bindMember, getBenefits, getCoupons, getLedger, getMe, issueMemberCode, openidOf } from './member';
import { getNotices, readNotices } from './notices';
import { requireMpEnabled } from './rules';

export function registerMpMemberRoutes(app: FastifyInstance, deps: Deps) {
  const enabled = requireMpEnabled(deps.sql);
  app.post('/api/mp/bind', { preHandler: enabled }, async (req) => bindMember(deps, openidOf(req), req.body));
  app.post('/api/mp/bind/abandon', { preHandler: enabled }, async (req) => abandonBind(deps, openidOf(req), req.body));
  app.get('/api/mp/me', { preHandler: enabled }, async (req) => getMe(deps, openidOf(req)));
  app.get('/api/mp/ledger', { preHandler: enabled }, async (req) => getLedger(deps, openidOf(req), req.query));
  app.get('/api/mp/coupons', { preHandler: enabled }, async (req) => getCoupons(deps, openidOf(req)));
  app.get('/api/mp/benefits', { preHandler: enabled }, async (req) => getBenefits(deps, openidOf(req)));
  app.post('/api/mp/code', { preHandler: enabled }, async (req) => issueMemberCode(deps, openidOf(req)));
  // 会员端提醒（RQ-014）：首页弹的提醒、看过记已读
  app.get('/api/mp/notices', { preHandler: enabled }, async (req) => getNotices(deps, openidOf(req)));
  app.post('/api/mp/notices/read', { preHandler: enabled }, async (req) => readNotices(deps, openidOf(req), req.body));
}
