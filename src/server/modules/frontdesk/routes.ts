import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { COUPON_PLATFORMS } from '@shared/checkout';
import { ISO_DATE } from '@shared/business-date';
import { MAX_VIP_LEVEL, VIP_LEVEL_BASES } from '@shared/frontdesk';
import { guard } from '../../auth/guard';
import { readSnapshot } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { checkBackfillAt } from './backfill';
import { postCharges, voidLine, type PostInputData } from './bills';
import { resolveReadableDate } from '../ledger';
import { checkout, findCoupon, getCheckout, listCheckouts, previewCheckout, voidCheckout, type CheckoutInputData } from './checkout';
import { listTicketTypes, saveTicketType, setVisitTicket, type TicketTypeInputData } from './tickets';
import { frontdeskChecks } from './checks';
import { businessDate, FRONTDESK_OPS, loadFrontdeskRules } from './common';
import { batchCreate, importHandTags, listTags, lockHandTag, unlockHandTag, updateHandTag, type ImportInputData } from './tags';
import { memberLevels } from './vip';
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
  lostTagFeeCents: z.number().int().min(0, '赔偿金额不能为负').max(10_000_00, '赔偿金额最多 10,000 元'),
  vipLevelBasis: z.enum(VIP_LEVEL_BASES, '请选择等级口径'),
  vipLevelThresholds: z
    .array(z.number().int().min(0, '门槛不能为负').max(1_000_000_000_00, '门槛过大'))
    .min(1, '至少设置第 1 级')
    .max(MAX_VIP_LEVEL, `最多 ${MAX_VIP_LEVEL} 级`)
    .refine((t) => t.every((v, i) => i === 0 || v > t[i - 1]!), '各级门槛必须逐级递增'),
  vipOverrideEnabled: z.boolean(),
  overtimeGraceMinutes: z.number().int().min(0, '宽限分钟数不能为负').max(120, '宽限最多 120 分钟'),
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

  // 结果待确认时：GET 只查回；POST abandon 作废这笔（之后原请求即使到达也不会生效）。type 为页面记录的原业务类型
  const OpKey = z.object({ key: z.uuid('操作编号格式不正确') });
  app.get('/api/frontdesk/ops/:key', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { key } = parse(OpKey, req.params);
    const { type } = parse(z.object({ type: z.enum(FRONTDESK_OPS).optional() }), req.query ?? {});
    return lookupFrontdeskOp(sql, key, type);
  });

  app.post('/api/frontdesk/ops/:key/abandon', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { key } = parse(OpKey, req.params);
    const { type } = parse(z.object({ type: z.enum(FRONTDESK_OPS, '缺少原操作的业务类型') }), req.body ?? {});
    return abandonFrontdeskOp(deps, key, type, ctxOf(req));
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

  // ── 票种与门票 ──
  app.get('/api/frontdesk/ticket-types', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { all } = parse(z.object({ all: z.string().optional() }), req.query ?? {});
    return listTicketTypes(sql, all === '1');
  });

  app.post('/api/frontdesk/ticket-types', { preHandler: guard('catalog.manage') }, async (req) =>
    saveTicketType(sql, null, req.body as TicketTypeInputData, ctxOf(req)),
  );

  app.put('/api/frontdesk/ticket-types/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return saveTicketType(sql, id, req.body as TicketTypeInputData, ctxOf(req));
  });

  app.post('/api/frontdesk/visits/:id/ticket', { preHandler: guard('frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await setVisitTicket(deps, id, req.body, ctxOf(req));
    return getVisit(sql, id);
  });

  // ── 结账 ──
  const VisitIds = z.object({
    ids: z
      .string('请选择手牌')
      .transform((s) => s.split(',').map(Number))
      .pipe(z.array(z.number().int().positive('手牌编号不正确')).min(1).max(30, '一次最多合并 30 张手牌')),
  });
  // at：补录纸质单时按实际离店时间计价（需要补录权限，时间范围与补录相同）
  app.get('/api/frontdesk/checkout-preview', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { ids, at } = parse(VisitIds.extend({ at: z.iso.datetime({ offset: true, message: '实际时间格式不正确' }).optional() }), req.query);
    return previewCheckout(deps, ids, at ? checkBackfillAt(new Date(at), req.actor) : undefined);
  });

  app.post('/api/frontdesk/checkouts', { preHandler: guard('frontdesk.checkout') }, async (req) =>
    checkout(deps, req.body as CheckoutInputData, ctxOf(req)),
  );

  // 结账记录可以切换营业日（过了营业日切换点仍能找到前一晚的单来反结账）；查看之前的营业日需要历史营业日权限
  app.get('/api/frontdesk/checkouts', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { date } = parse(z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() }), req.query ?? {});
    return listCheckouts(sql, await resolveReadableDate(deps, req, date));
  });

  app.get('/api/frontdesk/checkouts/:id', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getCheckout(sql, id);
  });

  app.post('/api/frontdesk/checkouts/:id/void', { preHandler: guard('frontdesk.checkoutVoid') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidCheckout(deps, id, req.body, ctxOf(req));
  });

  // 按完整券码核对一张团购券有没有登记过
  app.get('/api/frontdesk/coupons', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { platform, code } = parse(z.object({ platform: z.enum(COUPON_PLATFORMS), code: z.string().trim().min(1).max(80) }), req.query ?? {});
    return findCoupon(sql, platform, code);
  });

  // 会员按当前规则口径的等级（发牌时核对 VIP 柜）
  app.get('/api/frontdesk/members/:id/level', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const level = (await memberLevels(sql, [id], await loadFrontdeskRules(sql))).get(id);
    if (!level) throw notFound('会员不存在');
    return level;
  });

  // ── 手牌池 ──
  app.get('/api/frontdesk/tags', { preHandler: guard('frontdesk.read') }, async () => listTags(sql));

  app.post('/api/frontdesk/tags/import', { preHandler: guard('frontdesk.tags') }, async (req) =>
    importHandTags(sql, req.body as ImportInputData, { staffId: req.actor.id, ip: req.ip, via: 'web' }),
  );

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

  // 只改提交的字段，其余沿用当前规则；合并后整体校验
  app.put('/api/frontdesk/rules', { preHandler: guard('settings.manage') }, async (req) => {
    const before = await loadFrontdeskRules(sql);
    const input = parse(RulesInput, { ...before, ...parse(RulesInput.partial(), req.body) });
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
