// 小程序端口上的邀请好友（小程序线第三期 3b，docs/MP_PHASE3.md 第 2 节）：顾客（网关带 openid，要小程序开着）。
//   · 邀请人：能不能邀请、发出去的邀请；发一个邀请码（新发 201、同一个编号重提 200）；收回；
//   · 好友：看邀请；领取（网关先用手机号快速验证换来手机号；新领 201、同一个编号重提 200）；结果不确定时确认作废。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context';
import { parse } from '../../lib/validate';
import { abandonInviteClaim, claimInvite, createInvite, inviteHome, inviteView, revokeInvite } from './invites';
import { openidOf } from './member';
import { requireMpEnabled } from './rules';

const CodeParam = z.object({ code: z.string().max(16) });

export function registerMpInviteRoutes(app: FastifyInstance, deps: Deps) {
  const enabled = { preHandler: requireMpEnabled(deps.sql) };
  app.get('/api/mp/invites', enabled, async (req) => inviteHome(deps, openidOf(req)));
  app.post('/api/mp/invites', enabled, async (req, reply) => {
    const r = await createInvite(deps, openidOf(req), req.body);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/mp/invites/claim/abandon', enabled, async (req) => abandonInviteClaim(deps, openidOf(req), req.body));
  app.get('/api/mp/invites/:code', enabled, async (req) => inviteView(deps, openidOf(req), parse(CodeParam, req.params).code));
  app.post('/api/mp/invites/:code/revoke', enabled, async (req) => revokeInvite(deps, openidOf(req), parse(CodeParam, req.params).code));
  app.post('/api/mp/invites/:code/claim', enabled, async (req, reply) => {
    const r = await claimInvite(deps, openidOf(req), parse(CodeParam, req.params).code, req.body);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
}
