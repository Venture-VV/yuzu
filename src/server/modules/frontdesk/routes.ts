import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COUPON_PLATFORMS } from '@shared/checkout';
import { ISO_DATE } from '@shared/business-date';
import { can } from '@shared/permissions';
import { guard } from '../../auth/guard';
import { readSnapshot } from '../../db';
import type { Deps } from '../../lib/context';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { checkBackfillAt } from './backfill';
import { moveLines, postCharges, voidLine, type PostInputData } from './bills';
import { resolveReadableDate } from '../ledger';
import { refundShiftOptions } from '../shifts';
import { checkout, findCoupon, getCheckout, listCheckouts, previewCheckout, voidCheckout, type CheckoutInputData } from './checkout';
import { createRefund, getRefund, listRefunds, refundOptions, voidRefund, type RefundInputData } from './refunds';
import { couponByCode, couponLines, withTicketLines } from '../coupon-checkout';
import { previewTableCheckout } from '../tables';
import { listTicketTypes, saveTicketType, setVisitTicket, type TicketTypeInputData } from './tickets';
import { frontdeskChecks } from './checks';
import { businessDate, FRONTDESK_OP_PERMISSIONS, FRONTDESK_OPS, loadFrontdeskRules } from './common';
import { batchCreate, importHandTags, listTags, lockHandTag, unlockHandTag, updateHandTag, type ImportInputData } from './tags';
import { memberLockerGrades } from './vip';
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
import { ctxOf } from '../../lib/context';
import { saveRuleSetting } from '../../lib/rule-settings';

// 会员等级的口径、门槛与名称 v0.7.23 起归「会员规则」（membership.ts）；旧页面带来的这几项不再保存（zod 去掉多余的字段）
const RulesInput = z.object({
  selfVoidMinutes: z.number().int().min(0, '分钟数不能为负').max(120, '最多 120 分钟'),
  lostTagFeeCents: z.number().int().min(0, '赔偿金额不能为负').max(10_000_00, '赔偿金额最多 10,000 元'),
  vipOverrideEnabled: z.boolean(),
  overtimeGraceMinutes: z.number().int().min(0, '宽限分钟数不能为负').max(120, '宽限最多 120 分钟'),
});

export function registerFrontdeskRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  // ── 状态板与手牌账单 ──
  app.get('/api/frontdesk/board', { preHandler: guard('frontdesk.read') }, async () => readSnapshot(sql, getBoard));

  app.get('/api/frontdesk/visits/:id', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return readSnapshot(sql, (tx) => getVisit(tx, id, deps.config.timezone));
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
    return lookupFrontdeskOp(sql, key, deps.config.timezone, type);
  });

  // 作废要有原业务本身的权限（与原接口一致），例如没有结账收款权限的人不能作废别人正在进行的结账
  app.post('/api/frontdesk/ops/:key/abandon', { preHandler: guard() }, async (req) => {
    const { key } = parse(OpKey, req.params);
    const { type } = parse(z.object({ type: z.enum(FRONTDESK_OPS, '缺少原操作的业务类型') }), req.body ?? {});
    if (!FRONTDESK_OP_PERMISSIONS[type].every((p) => can(req.actor, p))) throw forbidden('作废这笔要有原业务的权限，请由有权限的员工处理');
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

  // 转单（v0.7.6）：挂错手牌的明细转到另一位在店客人的手牌上（操作编号；权限与作废明细相同）
  app.post('/api/frontdesk/lines/move', { preHandler: guard('frontdesk.operate') }, async (req) => moveLines(deps, req.body, ctxOf(req)));

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
    return getVisit(sql, id, deps.config.timezone);
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

  // 结账时输入券码核对（v0.7.20）：手牌结账按所选手牌（含此刻的门票），桌台结账按所选的桌；能不能用、能抵多少
  app.post('/api/frontdesk/checkout-coupon', { preHandler: guard('frontdesk.checkout') }, async (req) => {
    const input = parse(
      z.object({
        visitIds: z.array(z.number().int().positive()).max(30).default([]),
        tableSessionIds: z.array(z.number().int().positive()).max(30).default([]),
        code: z.string('请填写券码').max(40, '券码不正确'),
      }),
      req.body ?? {},
    );
    if ((input.visitIds.length > 0) === (input.tableSessionIds.length > 0)) throw badRequest('请选择要结账的手牌或桌台');
    const at = new Date();
    let billIds: number[];
    let memberIds: number[];
    let lines;
    if (input.visitIds.length) {
      const pre = await previewCheckout(deps, input.visitIds, at);
      billIds = pre.visits.map((v) => v.billId);
      memberIds = pre.members.map((m) => m.id);
      lines = withTicketLines(
        await couponLines(sql, billIds),
        pre.visits.flatMap((v) => (v.ticket ? [{ visitId: v.visitId, typeId: v.ticket.typeId, name: v.ticket.name, amount: v.ticket.amount }] : [])),
      );
    } else {
      const pre = await previewTableCheckout(deps, input.tableSessionIds, at);
      billIds = pre.sessions.map((x) => x.billId);
      memberIds = pre.members.map((m) => m.id);
      lines = await couponLines(sql, billIds);
    }
    const option = await couponByCode(sql, input.code, memberIds, lines, await businessDate(sql, deps, at));
    return option ? { found: true, option } : { found: false };
  });

  // 结账记录可以切换营业日（过了营业日切换点仍能找到前一晚的单来反结账）；查看之前的营业日需要历史营业日权限
  app.get('/api/frontdesk/checkouts', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { date } = parse(z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() }), req.query ?? {});
    return listCheckouts(sql, await resolveReadableDate(deps, req, date));
  });

  app.get('/api/frontdesk/checkouts/:id', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getCheckout(sql, id);
  });

  // 反结账退现金可以选的钱箱（跨钱箱退款，v0.7.1）：此刻当班的班次与建议的默认
  app.get('/api/frontdesk/checkouts/:id/refund-shifts', { preHandler: guard('frontdesk.checkoutVoid') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return refundShiftOptions(sql, id, req.actor.id);
  });

  app.post('/api/frontdesk/checkouts/:id/void', { preHandler: guard('frontdesk.checkoutVoid') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidCheckout(deps, id, req.body, ctxOf(req));
  });

  // ── 退款单（v0.7.20，离店后部分退款）──
  // 开退款单前的核对：每项、每种方式还能退多少，退现金可以选的钱箱
  app.get('/api/frontdesk/checkouts/:id/refund-options', { preHandler: guard('frontdesk.refund') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const options = await readSnapshot(sql, (tx) => refundOptions(tx, id, req.actor));
    return { ...options, drawers: await refundShiftOptions(sql, id, req.actor.id) };
  });

  app.post('/api/frontdesk/checkouts/:id/refunds', { preHandler: guard('frontdesk.refund') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const refund = await createRefund(deps, id, req.body as RefundInputData, ctxOf(req));
    reply.status(201);
    return refund;
  });

  // 某个营业日开的退款单（结账记录页），查看之前的营业日需要历史营业日权限
  app.get('/api/frontdesk/refunds', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { date } = parse(z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() }), req.query ?? {});
    return listRefunds(sql, await resolveReadableDate(deps, req, date));
  });

  app.get('/api/frontdesk/refunds/:id', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getRefund(sql, id);
  });

  app.post('/api/frontdesk/refunds/:id/void', { preHandler: guard('frontdesk.refund') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidRefund(deps, id, req.body, ctxOf(req));
  });

  // 按完整券码核对一张团购券有没有登记过
  app.get('/api/frontdesk/coupons', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { platform, code } = parse(z.object({ platform: z.enum(COUPON_PLATFORMS), code: z.string().trim().min(1).max(80) }), req.query ?? {});
    return findCoupon(sql, platform, code);
  });

  // 会员的档阶与能用几级 VIP 柜（发牌时核对 VIP 柜）
  app.get('/api/frontdesk/members/:id/grade', { preHandler: guard('frontdesk.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const grade = (await memberLockerGrades(sql, [id], await businessDate(sql, deps, new Date()))).get(id);
    if (!grade) throw notFound('会员不存在');
    return grade;
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

  // 只改提交的字段，其余沿用当前规则；合并后整体校验（v0.7.22：在锁里读当前规则再合并，两人同时改不同字段不会互相覆盖）
  app.put('/api/frontdesk/rules', { preHandler: guard('settings.manage') }, async (req) => {
    await saveRuleSetting(sql, 'frontdesk_rules', loadFrontdeskRules, (before) => parse(RulesInput, { ...before, ...parse(RulesInput.partial(), req.body) }), ctxOf(req));
    return loadFrontdeskRules(sql);
  });

  app.get('/api/frontdesk/checks', { preHandler: guard('frontdesk.read') }, async () => readSnapshot(sql, frontdeskChecks));
}
