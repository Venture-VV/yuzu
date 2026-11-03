// 员工端口上的小程序接口（小程序线）：前台用会员码查会员、看会员的微信绑定记录、解绑。
// 后台「小程序」模块（门店信息、首页轮播、项目介绍、开关）也挂在这里（第 12 节 ②）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../../auth/guard';
import { ctxOf, type Deps } from '../../lib/context';
import { idParam, parse } from '../../lib/validate';
import { getMember } from '../members';
import { memberBindings, resolveMemberCode, unbindMember } from './member';

const CodeParam = z.object({ code: z.string().trim().max(32) });

export function registerMpStaffRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 前台扫码盒扫进会员码：认出会员（只认人，用储值付款时照旧核对）
  app.get('/api/mp-codes/:code', { preHandler: guard('member.read') }, async (req) => resolveMemberCode(deps, parse(CodeParam, req.params).code));
  app.get('/api/admin/mp/members/:id/bindings', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await getMember(sql, id);
    return memberBindings(sql, id);
  });
  app.post('/api/admin/mp/bindings/:id/unbind', { preHandler: guard('mp.unbind') }, async (req) => unbindMember(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
}
