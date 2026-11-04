// 第三方平台核销补录（v0.7.28 ⑤，docs/SCHEDULE_FINISH.md 第 6 节，N6 待确认）。
//   · 补登记：已在平台 App 核销、没有经过前台结账的券——不结账、不算营业额、不动会员钱包；同一平台同一券码只能有一笔有效登记，
//     也不能和前台结账里登记的团购券重复（两边都先取「平台 + 券码」的咨询锁再核对两张表）；登记错了作废（值班经理以上，写原因）；
//   · 平台打款：哪个平台、哪段时间的、多少、哪天到账、流水号；作废写原因；
//   · 对账：按平台、按时间段，补登记的应结 + 结账团购券的抵扣 与 打款比对。
// 加锁顺序：补登记：操作编号的咨询锁（与「确认作废」串行）→「平台 + 券码」的咨询锁；作废只锁那一行；打款登记只取操作编号的咨询锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import { COUPON_CODE_PATTERN, COUPON_PLATFORM_LABELS, COUPON_PLATFORMS, normalizeCouponCode, type CouponPlatform } from '@shared/checkout';
import { PLATFORM_BACKFILL_DAYS, type PlatformDayTotals, type PlatformReconcile, type PlatformRedemption, type PlatformSettlement } from '@shared/platform';
import { guard, guardAny } from '../auth/guard';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { cents, idParam, parse } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { loadSettings } from './settings';

/** 「平台 + 券码」的咨询锁：补登记与前台结账登记团购券都先取它，两边不会同时登记同一张券 */
export const lockPlatformCode = (tx: Tx, platform: CouponPlatform, code: string) => lockOpKey(tx, `platform-coupon:${platform}:${code}`);

/** 这张券已经补登记过：返回单号（前台结账登记团购券时核对） */
export async function redemptionOfCode(db: Db, platform: CouponPlatform, code: string): Promise<string | null> {
  const [r] = await db<{ redemptionNo: string }[]>`SELECT redemption_no FROM platform_redemptions WHERE platform = ${platform} AND code = ${code} AND status = 'active'`;
  return r?.redemptionNo ?? null;
}

const CodeInput = z
  .string('请填写完整券码')
  .transform(normalizeCouponCode)
  .pipe(z.string().regex(COUPON_CODE_PATTERN, '请填写完整券码（6–64 位数字或字母）'));

// ───────────────────────── 补登记 ─────────────────────────

const RedemptionSql = (db: Db) => db`
  SELECT r.id, r.redemption_no, r.platform, r.code, r.deal_name, r.face_value, r.settle_amount, r.guests, r.redeemed_at,
         to_char(r.business_date, 'YYYY-MM-DD') AS business_date, r.note, r.status, s.display_name AS registered_by_name, r.registered_at,
         v.display_name AS voided_by_name, r.voided_at, r.void_reason
  FROM platform_redemptions r JOIN staff s ON s.id = r.registered_by LEFT JOIN staff v ON v.id = r.voided_by`;

export async function getRedemption(db: Db, id: number): Promise<PlatformRedemption> {
  const [r] = await db<PlatformRedemption[]>`${RedemptionSql(db)} WHERE r.id = ${id}`;
  if (!r) throw notFound('补登记不存在');
  return r;
}

export async function listRedemptions(db: Db, from: string, to: string): Promise<PlatformRedemption[]> {
  return db<PlatformRedemption[]>`${RedemptionSql(db)} WHERE r.business_date BETWEEN ${from} AND ${to} ORDER BY r.redeemed_at DESC, r.id DESC LIMIT 500`;
}

export const RedemptionInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  platform: z.enum(COUPON_PLATFORMS, '请选择平台'),
  code: CodeInput,
  dealName: z.string().trim().max(48, '项目最多 48 字').default(''),
  faceValue: cents('面值').max(100_000_000, '面值过大'),
  /** 平台应结给门店的（扣佣金后）；不填按面值 */
  settleAmount: cents('应结').nullish(),
  guests: z.number().int().min(1).max(99).default(1),
  /** 在平台 App 核销的时刻 */
  redeemedAt: z.iso.datetime({ offset: true, message: '请填写核销时间' }),
  note: z.string().trim().max(100, '备注最多 100 字').default(''),
});
export type RedemptionInputData = z.input<typeof RedemptionInput>;

export async function registerRedemption(deps: Deps, raw: RedemptionInputData, ctx: OpContext): Promise<{ redemption: PlatformRedemption; replayed: boolean }> {
  const input = parse(RedemptionInput, raw);
  const settle = input.settleAmount ?? input.faceValue;
  if (settle > input.faceValue) throw badRequest('应结不能多于面值');
  const now = ctx.at ?? new Date();
  const redeemedAt = new Date(input.redeemedAt);
  if (redeemedAt.getTime() > now.getTime() + 5 * 60_000) throw unprocessable('PLATFORM_TIME', '核销时间不能晚于现在');
  if (redeemedAt.getTime() < now.getTime() - PLATFORM_BACKFILL_DAYS * 86_400_000) throw unprocessable('PLATFORM_TIME', `只能补登记 ${PLATFORM_BACKFILL_DAYS} 天以内的核销`);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM platform_redemptions WHERE client_key = ${key}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔补登记，请刷新页面后重新填写');
    return Number(p.id);
  };
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, key, 'platform_redemption', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      await lockPlatformCode(tx, input.platform, input.code);
      const label = `${COUPON_PLATFORM_LABELS[input.platform]}券码 ${input.code}`;
      const dup = await redemptionOfCode(tx, input.platform, input.code);
      if (dup) throw conflict('PLATFORM_CODE_USED', `${label} 已经补登记过（${dup}）`);
      const [used] = await tx<{ checkoutNo: string }[]>`
        SELECT c.checkout_no FROM group_buy_coupons g JOIN checkouts c ON c.id = g.checkout_id
        WHERE g.platform = ${input.platform} AND g.code = ${input.code} AND g.status = 'active'`;
      if (used) throw conflict('PLATFORM_CODE_USED', `${label} 已在前台结账时登记过（结账单 ${used.checkoutNo}），不用再补登记`);
      const settings = await loadSettings(tx);
      const date = businessDateOf(redeemedAt, deps.config.timezone, settings.businessDayStartHour);
      const no = await nextDocNo(tx, 'platform_redemption', 'PT', date);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO platform_redemptions (redemption_no, platform, code, deal_name, face_value, settle_amount, guests, redeemed_at, business_date, note,
                                          registered_by, registered_at, client_key, request_hash)
        VALUES (${no}, ${input.platform}, ${input.code}, ${input.dealName}, ${input.faceValue}, ${settle}, ${input.guests}, ${redeemedAt}, ${date}, ${input.note},
                ${ctx.actor.id}, ${now}, ${key}, ${requestHash})
        RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'platform_redemption',
        targetType: 'platform_redemption',
        targetId: row!.id,
        detail: { docNo: no, platform: input.platform, code: input.code, dealName: input.dealName, faceValue: input.faceValue, settleAmount: settle },
        ip: ctx.ip,
        businessDate: date,
      });
      return { id: Number(row!.id), replayed: false };
    });
    return { redemption: await getRedemption(deps.sql, out.id), replayed: out.replayed };
  } catch (error) {
    if (isUniqueViolation(error, 'platform_redemptions_client_key_key')) {
      const id = await replay(deps.sql);
      if (id !== null) return { redemption: await getRedemption(deps.sql, id), replayed: true };
    }
    throw error;
  }
}

const VoidInput = z.object({ reason: z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 字') });

export async function voidRedemption(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<PlatformRedemption> {
  const { reason } = parse(VoidInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [r] = await tx<{ status: string; redemptionNo: string; businessDate: string }[]>`
      SELECT status, redemption_no, to_char(business_date, 'YYYY-MM-DD') AS business_date FROM platform_redemptions WHERE id = ${id} FOR UPDATE`;
    if (!r) throw notFound('补登记不存在');
    if (r.status !== 'active') throw conflict('ALREADY_VOIDED', `补登记 ${r.redemptionNo} 已作废`);
    await tx`UPDATE platform_redemptions SET status = 'voided', voided_by = ${ctx.actor.id}, voided_at = ${ctx.at ?? new Date()}, void_reason = ${reason} WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'platform_redemption_void', targetType: 'platform_redemption', targetId: id, detail: { docNo: r.redemptionNo, reason }, ip: ctx.ip, businessDate: r.businessDate });
  });
  return getRedemption(deps.sql, id);
}

// ───────────────────────── 平台打款 ─────────────────────────

const SettlementSql = (db: Db) => db`
  SELECT p.id, p.settlement_no, p.platform, to_char(p.period_from, 'YYYY-MM-DD') AS period_from, to_char(p.period_to, 'YYYY-MM-DD') AS period_to,
         p.amount, to_char(p.received_on, 'YYYY-MM-DD') AS received_on, p.ref, p.note, p.status, s.display_name AS created_by_name, p.created_at, p.void_reason
  FROM platform_settlements p JOIN staff s ON s.id = p.created_by`;

export async function getSettlement(db: Db, id: number): Promise<PlatformSettlement> {
  const [r] = await db<PlatformSettlement[]>`${SettlementSql(db)} WHERE p.id = ${id}`;
  if (!r) throw notFound('打款登记不存在');
  return r;
}

const DateField = (label: string) => z.string(`请填写${label}`).regex(ISO_DATE, `${label}格式应为 YYYY-MM-DD`);

export const SettlementInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  platform: z.enum(COUPON_PLATFORMS, '请选择平台'),
  periodFrom: DateField('结算期间开始'),
  periodTo: DateField('结算期间结束'),
  amount: cents('到账金额').positive('到账金额要大于 0').max(10_000_000_000, '到账金额过大'),
  receivedOn: DateField('到账日期'),
  ref: z.string().trim().max(64, '流水号最多 64 字').default(''),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
});
export type SettlementInputData = z.input<typeof SettlementInput>;

export async function registerSettlement(deps: Deps, raw: SettlementInputData, ctx: OpContext): Promise<{ settlement: PlatformSettlement; replayed: boolean }> {
  const input = parse(SettlementInput, raw);
  if (input.periodFrom > input.periodTo) throw badRequest('结算期间的开始不能晚于结束');
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM platform_settlements WHERE client_key = ${key}`;
    if (!p) return null;
    if (p.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔打款登记，请刷新页面后重新填写');
    return Number(p.id);
  };
  try {
    const out = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, key, 'platform_settlement', erpOpAbandoned);
      const prior = await replay(tx);
      if (prior !== null) return { id: prior, replayed: true };
      const no = await nextDocNo(tx, 'platform_settlement', 'PD', input.receivedOn);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO platform_settlements (settlement_no, platform, period_from, period_to, amount, received_on, ref, note, created_by, client_key, request_hash)
        VALUES (${no}, ${input.platform}, ${input.periodFrom}, ${input.periodTo}, ${input.amount}, ${input.receivedOn}, ${input.ref}, ${input.note}, ${ctx.actor.id},
                ${key}, ${requestHash})
        RETURNING id`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'platform_settlement', targetType: 'platform_settlement', targetId: row!.id, detail: { docNo: no, ...payload }, ip: ctx.ip });
      return { id: Number(row!.id), replayed: false };
    });
    return { settlement: await getSettlement(deps.sql, out.id), replayed: out.replayed };
  } catch (error) {
    if (isUniqueViolation(error, 'platform_settlements_client_key_key')) {
      const id = await replay(deps.sql);
      if (id !== null) return { settlement: await getSettlement(deps.sql, id), replayed: true };
    }
    throw error;
  }
}

export async function voidSettlement(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<PlatformSettlement> {
  const { reason } = parse(VoidInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [r] = await tx<{ status: string; settlementNo: string }[]>`SELECT status, settlement_no FROM platform_settlements WHERE id = ${id} FOR UPDATE`;
    if (!r) throw notFound('打款登记不存在');
    if (r.status !== 'active') throw conflict('ALREADY_VOIDED', `打款登记 ${r.settlementNo} 已作废`);
    await tx`UPDATE platform_settlements SET status = 'voided', voided_by = ${ctx.actor.id}, voided_at = ${ctx.at ?? new Date()}, void_reason = ${reason} WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'platform_settlement_void', targetType: 'platform_settlement', targetId: id, detail: { docNo: r.settlementNo, reason }, ip: ctx.ip });
  });
  return getSettlement(deps.sql, id);
}

// ───────────────────────── 对账、日结 ─────────────────────────

/** 对账：这段时间里（按营业日）补登记的应结 + 结账团购券的抵扣 与 所属期间在这段时间内的打款 */
export async function reconcilePlatforms(db: Db, from: string, to: string): Promise<PlatformReconcile> {
  const red = await db<{ platform: CouponPlatform; count: number; face: number; settle: number }[]>`
    SELECT platform, count(*)::int AS count, coalesce(sum(face_value), 0)::bigint AS face, coalesce(sum(settle_amount), 0)::bigint AS settle
    FROM platform_redemptions WHERE status = 'active' AND business_date BETWEEN ${from} AND ${to} GROUP BY platform`;
  const cps = await db<{ platform: CouponPlatform; count: number; amount: number }[]>`
    SELECT platform, count(*)::int AS count, coalesce(sum(amount), 0)::bigint AS amount
    FROM group_buy_coupons WHERE status = 'active' AND business_date BETWEEN ${from} AND ${to} GROUP BY platform`;
  const settlements = await db<PlatformSettlement[]>`
    ${SettlementSql(db)} WHERE p.period_from >= ${from} AND p.period_to <= ${to} ORDER BY p.received_on, p.id`;
  const rows = COUPON_PLATFORMS.map((platform) => {
    const r = red.find((x) => x.platform === platform);
    const c = cps.find((x) => x.platform === platform);
    const s = settlements.filter((x) => x.platform === platform && x.status === 'active');
    const redemptions = { count: r?.count ?? 0, face: Number(r?.face ?? 0), settle: Number(r?.settle ?? 0) };
    const checkoutCoupons = { count: c?.count ?? 0, amount: Number(c?.amount ?? 0) };
    const expected = redemptions.settle + checkoutCoupons.amount;
    const paid = s.reduce((t, x) => t + Number(x.amount), 0);
    return { platform, redemptions, checkoutCoupons, expected, settlements: { count: s.length, amount: paid }, diff: paid - expected };
  }).filter((r) => r.redemptions.count || r.checkoutCoupons.count || r.settlements.count);
  return { from, to, rows, settlements };
}

/** 日结的「平台核销补录」：当天（按核销营业日）有效的补登记与作废的张数 */
export async function platformDayTotals(db: Db, date: string): Promise<PlatformDayTotals> {
  const rows = await db<{ platform: CouponPlatform; count: number; face: number; settle: number }[]>`
    SELECT platform, count(*)::int AS count, coalesce(sum(face_value), 0)::bigint AS face, coalesce(sum(settle_amount), 0)::bigint AS settle
    FROM platform_redemptions WHERE status = 'active' AND business_date = ${date} GROUP BY platform ORDER BY platform`;
  const [v] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM platform_redemptions WHERE status = 'voided' AND business_date = ${date}`;
  const byPlatform = rows.map((r) => ({ platform: r.platform, count: r.count, face: Number(r.face), settle: Number(r.settle) }));
  return {
    count: byPlatform.reduce((t, r) => t + r.count, 0),
    face: byPlatform.reduce((t, r) => t + r.face, 0),
    settle: byPlatform.reduce((t, r) => t + r.settle, 0),
    voidCount: v!.n,
    byPlatform,
  };
}

/** 自检：同一平台同一券码不能既补登记、又在结账里登记 */
export async function platformChecks(db: Db) {
  const dup = await db<{ code: string }[]>`
    SELECT r.code FROM platform_redemptions r JOIN group_buy_coupons g ON g.platform = r.platform AND g.code = r.code AND g.status = 'active'
    WHERE r.status = 'active' LIMIT 5`;
  const [n] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM platform_redemptions WHERE status = 'active'`;
  return {
    key: 'platform_redemptions',
    label: '平台核销补录不和结账团购券重复',
    ok: dup.length === 0,
    detail: dup.length ? `重复的券码：${dup.map((d) => d.code).join('、')}` : `有效的补登记 ${n!.n} 笔，没有和结账里的团购券重复`,
  };
}

// ───────────────────────── 路由 ─────────────────────────

const RangeQuery = z.object({ from: DateField('开始日期'), to: DateField('结束日期') });

export function registerPlatformRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/platform/redemptions', { preHandler: guardAny('platform.redeem', 'platform.settle') }, async (req) => {
    const { from, to } = parse(RangeQuery, req.query ?? {});
    return listRedemptions(sql, from, to);
  });
  app.post('/api/platform/redemptions', { preHandler: guard('platform.redeem') }, async (req) => registerRedemption(deps, req.body as RedemptionInputData, ctxOf(req)));
  app.post('/api/platform/redemptions/:id/void', { preHandler: guard('platform.void') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidRedemption(deps, id, req.body, ctxOf(req));
  });
  app.get('/api/platform/reconcile', { preHandler: guard('platform.settle') }, async (req) => {
    const { from, to } = parse(RangeQuery, req.query ?? {});
    if (from > to) throw badRequest('开始日期不能晚于结束日期');
    return reconcilePlatforms(sql, from, to);
  });
  app.post('/api/platform/settlements', { preHandler: guard('platform.settle') }, async (req) => registerSettlement(deps, req.body as SettlementInputData, ctxOf(req)));
  app.post('/api/platform/settlements/:id/void', { preHandler: guard('platform.settle') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return voidSettlement(deps, id, req.body, ctxOf(req));
  });
}

