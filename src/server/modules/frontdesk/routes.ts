import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guard } from '../../auth/guard';
import { readSnapshot } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { idParam, parse } from '../../lib/validate';
import { postCharges, voidLine, type PostInputData } from './bills';
import { frontdeskChecks } from './checks';
import { loadFrontdeskRules } from './common';
import { batchCreate, listTags, lockHandTag, unlockHandTag, updateHandTag } from './tags';
import {
  abandonFrontdeskOp,
  cancelVisit,
  changeGroup,
  checkin,
  getBoard,
  getVisit,
  lookupFrontdeskOp,
  previewBills,
  swapTag,
  type CheckinInputData,
  type GroupInputData,
  type SwapInputData,
} from './visits';

const ctxOf = (req: FastifyRequest): OpContext => ({ actor: req.actor, ip: req.ip });

const RulesInput = z.object({
  selfVoidMinutes: z.number().int().min(0, '分钟数不能为负').max(120, '最多 120 分钟'),
});

export function registerFrontdeskRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  // ── 状态板与手牌账单 ──
  app.get('/api/frontdesk/board', { preHandler: guard('frontdesk.read') }, async () => readSnapshot(sql, getBoard));

  app.get('/api/frontdesk/visits/:id', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return readSnapshot(sql, (tx) => getVisit(tx, id));
  });

  app.get('/api/frontdesk/preview', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { ids } = parse(
      z.object({
        ids: z
          .string('请选择手牌')
          .transform((s) => s.split(',').map(Number))
          .pipe(z.array(z.number().int().positive('手牌编号不正确')).min(1).max(30, '一次最多合并 30 张手牌')),
      }),
      req.query,
    );
    return readSnapshot(sql, (tx) => previewBills(tx, ids));
  });

  // 结果待确认时：GET 只查回；POST abandon 作废这笔（之后原请求即使到达也不会生效）
  app.get('/api/frontdesk/ops/:key', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid('操作编号格式不正确') }), req.params);
    return lookupFrontdeskOp(sql, key);
  });

  app.post('/api/frontdesk/ops/:key/abandon', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid('操作编号格式不正确') }), req.params);
    return abandonFrontdeskOp(deps, key, ctxOf(req));
  });

  // ── 接待、换牌、同行、撤销 ──
  app.post('/api/frontdesk/checkins', { preHandler: guard('frontdesk.operate') }, async (req, reply) => {
    const result = await checkin(deps, req.body as CheckinInputData, ctxOf(req));
    reply.status(result.replayed ? 200 : 201);
    return result;
  });

  app.post('/api/frontdesk/visits/:id/swap', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return swapTag(deps, id, req.body as SwapInputData, ctxOf(req));
  });

  app.post('/api/frontdesk/visits/:id/group', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return changeGroup(deps, id, req.body as GroupInputData, ctxOf(req));
  });

  app.post('/api/frontdesk/visits/:id/cancel', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return cancelVisit(deps, id, req.body, ctxOf(req));
  });

  // ── 挂账与更正 ──
  app.post('/api/frontdesk/visits/:id/charges', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return postCharges(deps, id, req.body as PostInputData, ctxOf(req));
  });

  app.post('/api/frontdesk/lines/:id/void', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidLine(deps, id, req.body, ctxOf(req));
  });

  // ── 手牌池 ──
  app.get('/api/frontdesk/tags', { preHandler: guard('frontdesk.read') }, async () => listTags(sql));

  app.post('/api/frontdesk/tags/batch', { preHandler: guard('frontdesk.tags') }, async (req) => batchCreate(deps, req.body, ctxOf(req)));

  app.post('/api/frontdesk/tags/:id/lock', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await lockHandTag(deps, id, req.body, ctxOf(req));
    return { ok: true };
  });

  app.post('/api/frontdesk/tags/:id/unlock', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await unlockHandTag(deps, id, ctxOf(req));
    return { ok: true };
  });

  app.put('/api/frontdesk/tags/:id', { preHandler: guard('frontdesk.tags') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await updateHandTag(deps, id, req.body, ctxOf(req));
    return { ok: true };
  });

  // ── 规则与自检 ──
  app.get('/api/frontdesk/rules', { preHandler: guard('frontdesk.read') }, async () => loadFrontdeskRules(sql));

  app.put('/api/frontdesk/rules', { preHandler: guard('settings.manage') }, async (req) => {
    const input = parse(RulesInput, req.body);
    const before = await loadFrontdeskRules(sql);
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('frontdesk_rules', ${tx.json(input)}, now(), ${req.actor.id})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'settings_updated', targetType: 'settings', detail: { key: 'frontdesk_rules', before, after: input }, ip: req.ip });
    });
    return loadFrontdeskRules(sql);
  });

  app.get('/api/frontdesk/checks', { preHandler: guard('frontdesk.read') }, async () => readSnapshot(sql, frontdeskChecks));
}
