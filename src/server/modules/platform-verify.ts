// 平台验券（8.0.21，docs/INTEGRATIONS_V8021.md 第 3 节，CW-H / CW8；迁移 149）。美团、抖音验券即核销。
//
// 结账：团购券那一行选了美团 / 抖音、输入（或扫）券码后点「验券」→ 先问平台（项目、面值、几份，只读）→ 收银员确认 → 核销：
// 先写「核销中」（提交），事务外调平台，结果回写 → 那一行锁定（项目、金额 = 面值），结账请求里带验券编号；结账事务在「平台 + 券码」
// 咨询锁之后锁验券一行，核对已核销、券码一致、没被用过，团购券记录挂上验券编号。
// 核了没结账：前台提示，可以挂到下一次结账，或撤销核销（调平台撤销；过了平台允许的时间就只能转成「平台核销补录」记一条）。
// 反结账：团购券记录作废（与原来一样），验券回到「没用」。平台不通：照旧手输（不验券），补录照旧。
// 每天对账：设定的时间（默认 06:10）按平台拉前一个营业日的核销明细，与团购券记录、补录对，差异进「平台核销补录 → 验券对账」。
//
// 锁：核销先取操作编号的咨询锁（`platform_verify`，与「确认作废」串行）→「平台 + 券码」咨询锁（与结账、补录同一把）
// → 核对团购券、补录、验券三处都没有这张有效的 → 写「核销中」；结果回写、撤销只锁验券一行；转补录：「平台 + 券码」→ 验券一行 → 写补录；
// 结账用掉在「平台 + 券码」之后锁验券一行；反结账在作废团购券之后解开验券（按 id 升序）。对外调用都在事务外。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import { COUPON_CODE_PATTERN, COUPON_PLATFORM_LABELS, normalizeCouponCode } from '@shared/checkout';
import type { PlatformReconIssue, PlatformReconRun, PayTerminalStatus, VerificationView, VoucherPlatform, VoucherPreview } from '@shared/integrations';
import { VOUCHER_PLATFORMS } from '@shared/integrations';
import { formatYuan } from '@shared/money';
import type { Db, Fragment, Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { modeOf } from '../integrations/config';
import { withCallLog } from '../integrations/calls';
import { platformVoucherAdapter, type PlatformVoucher } from '../integrations/platform-voucher';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, fenceKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { loadIntegrationSwitches } from './pay-terminal';
import { lockPlatformCode, redemptionOfCode } from './platform-redemptions';
import { loadSettings } from './settings';

const Platform = z.enum(['meituan', 'douyin'], '验券只支持美团、抖音');
const Code = z.string('请填写完整券码').transform(normalizeCouponCode).pipe(z.string().regex(COUPON_CODE_PATTERN, '请填写完整券码（6–64 位数字或字母）'));

export async function voucherStatus(deps: Deps): Promise<PayTerminalStatus> {
  return { mode: modeOf(deps.config.integrations, 'platform_voucher'), enabled: (await loadIntegrationSwitches(deps.sql)).platformVoucher };
}

async function adapterOrThrow(deps: Deps): Promise<PlatformVoucher> {
  const a = platformVoucherAdapter(deps.config.integrations);
  if (!a)
    throw conflict(
      'VOUCHER_OFF',
      modeOf(deps.config.integrations, 'platform_voucher') === 'live' ? '平台验券已配置，等联调以后才能用；现在请手输券码，在平台 App 里核销' : '没有配置平台验券；请手输券码，在平台 App 里核销',
    );
  if (!(await loadIntegrationSwitches(deps.sql)).platformVoucher) throw conflict('VOUCHER_OFF', '门店关了平台验券（后台「对外接口」）；请手输券码，在平台 App 里核销');
  return a;
}

// ───────────────────────── 读取 ─────────────────────────

async function views(db: Db, where: Fragment): Promise<VerificationView[]> {
  const rows = await db<(Omit<VerificationView, 'checkout'> & { checkoutId: number | null; checkoutNo: string | null })[]>`
    SELECT v.id, v.platform, v.code, v.deal_name, v.face_cents, v.settle_cents, v.quantity, v.status, v.verify_no, v.fail_reason,
           c.id AS checkout_id, c.checkout_no, r.redemption_no, s.display_name AS staff_name, v.created_at, v.verified_at,
           (v.status = 'verified' AND v.cancelled_by IS NOT NULL) AS cancelling
    FROM platform_verifications v JOIN staff s ON s.id = v.staff_id
    LEFT JOIN group_buy_coupons g ON g.id = v.group_buy_coupon_id LEFT JOIN checkouts c ON c.id = g.checkout_id
    LEFT JOIN platform_redemptions r ON r.id = v.redemption_id
    WHERE ${where} ORDER BY v.id DESC LIMIT 200`;
  return rows.map(({ checkoutId, checkoutNo, ...v }) => ({
    ...v,
    id: Number(v.id),
    faceCents: Number(v.faceCents),
    settleCents: Number(v.settleCents),
    checkout: checkoutId ? { id: Number(checkoutId), checkoutNo: checkoutNo! } : null,
  }));
}

export async function verificationView(db: Db, id: number): Promise<VerificationView> {
  const [v] = await views(db, db`v.id = ${id}`);
  if (!v) throw notFound('验券记录不存在');
  return v;
}

// ───────────────────────── 验券 ─────────────────────────

const PrepareInput = z.object({ platform: Platform, code: Code });

export async function prepareVoucher(deps: Deps, raw: unknown, actor: Actor): Promise<VoucherPreview> {
  const input = parse(PrepareInput, raw);
  const a = await adapterOrThrow(deps);
  const r = await withCallLog(
    deps.sql,
    { kind: 'platform_voucher', provider: input.platform, action: 'prepare', mode: a.mode, request: { code: input.code }, staffId: actor.id },
    () => a.prepare(input),
    (x) => (x.ok ? { ...x.info } : { error: x.error }),
  ).catch((e: unknown) => ({ ok: false as const, error: `平台没有回应：${e instanceof Error ? e.message : String(e)}` }));
  if (!r.ok) throw unprocessable('VOUCHER_INVALID', `${COUPON_PLATFORM_LABELS[input.platform]}：${r.error}`);
  return { platform: input.platform, code: input.code, ...r.info };
}

const VerifyInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  platform: Platform,
  code: Code,
  /** 收银员确认时看到的面值合计；平台此刻说的不一样时拒绝 */
  expectedFaceCents: z.number().int().min(0),
});

const abandoned = () => conflict('OP_ABANDONED', '这次验券已经确认作废，没有核销；请重新验券');

/** 三处（团购券、补录、验券）都没有这张有效的；调用方已取「平台 + 券码」咨询锁 */
async function assertCodeFree(tx: Tx, platform: VoucherPlatform, code: string) {
  const label = `${COUPON_PLATFORM_LABELS[platform]}券码 ${code}`;
  const [used] = await tx<{ checkoutNo: string }[]>`
    SELECT c.checkout_no FROM group_buy_coupons g JOIN checkouts c ON c.id = g.checkout_id
    WHERE g.platform = ${platform} AND g.code = ${code} AND g.status = 'active'`;
  if (used) throw conflict('COUPON_USED', `${label} 已在结账单 ${used.checkoutNo} 用过`);
  const dup = await redemptionOfCode(tx, platform, code);
  if (dup) throw conflict('COUPON_USED', `${label} 已经补登记过（${dup}）`);
  const [live] = await tx<{ id: number }[]>`SELECT id FROM platform_verifications WHERE platform = ${platform} AND code = ${code} AND status IN ('verifying', 'verified')`;
  if (live) throw conflict('COUPON_VERIFIED', `${label} 已经验过券（还没用的在前台「已验券没结账」里，可以直接挂到这次结账）`);
}

export async function verifyVoucher(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ verification: VerificationView; replayed: boolean }> {
  const input = parse(VerifyInput, raw);
  const a = await adapterOrThrow(deps);
  const requestHash = hashRequest({ platform: input.platform, code: input.code, expectedFaceCents: input.expectedFaceCents });
  const [prev0] = await deps.sql<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM platform_verifications WHERE client_key = ${input.clientKey}`;
  if (prev0) {
    if (prev0.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已经用在另一次验券上，请刷新后重新验券');
    // 还停在「核销中」、又过了等结果的时间：去平台查一次补上结果（只查，不再核销）
    await resumeVerification(deps, Number(prev0.id));
    return { verification: await verificationView(deps.sql, Number(prev0.id)), replayed: true };
  }
  // 先看本店有没有登记过（不加锁，只为给个明白的提示；锁里还会再核对一次）
  await deps.sql.begin(async (tx) => assertCodeFree(tx, input.platform, input.code));
  // 核销前再问一次平台（只读）：面值变了的拒绝
  const info = await prepareVoucher(deps, { platform: input.platform, code: input.code }, actor);
  if (info.faceCents !== input.expectedFaceCents)
    throw conflict('VOUCHER_CHANGED', `平台说这张券的面值是 ${formatYuan(info.faceCents)}，和刚才看到的不一样，请重新验券`, { faceCents: info.faceCents });
  const settings = await loadSettings(deps.sql);
  const businessDate = businessDateOf(new Date(), deps.config.timezone, settings.businessDayStartHour);
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await assertNotFenced(tx, input.clientKey, 'platform_verify', abandoned);
    const [prev] = await tx<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM platform_verifications WHERE client_key = ${input.clientKey}`;
    if (prev) {
      if (prev.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已经用在另一次验券上，请刷新后重新验券');
      return { id: Number(prev.id), replayed: true };
    }
    await lockPlatformCode(tx, input.platform, input.code);
    await assertCodeFree(tx, input.platform, input.code);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO platform_verifications (platform, code, deal_name, face_cents, settle_cents, quantity, adapter, business_date, client_key, request_hash, staff_id)
      VALUES (${input.platform}, ${input.code}, ${info.dealName.slice(0, 48)}, ${info.faceCents}, ${info.settleCents}, ${info.quantity}, ${a.mode}, ${businessDate},
              ${input.clientKey}, ${requestHash}, ${actor.id})
      RETURNING id`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'platform_verify',
      targetType: 'platform_verification',
      targetId: Number(row!.id),
      detail: { op: 'verify', platform: input.platform, code: input.code, faceCents: info.faceCents },
      ip,
    });
    return { id: Number(row!.id), replayed: false };
  });
  if (!r.replayed) {
    const result = await withCallLog(
      deps.sql,
      {
        kind: 'platform_voucher',
        provider: input.platform,
        action: 'verify',
        mode: a.mode,
        refType: 'platform_verification',
        refId: r.id,
        request: { code: input.code, quantity: info.quantity },
        staffId: actor.id,
      },
      () => a.verify({ platform: input.platform, code: input.code, quantity: info.quantity, outNo: String(r.id).padStart(8, '0'), businessDate }),
      (x) => (x.status === 'verified' ? { status: x.status, verifyNo: x.verifyNo } : { status: x.status, error: x.error }),
    ).catch((e: unknown) => ({ status: 'unknown' as const, error: `平台没有回应：${e instanceof Error ? e.message : String(e)}` }));
    if (result.status !== 'unknown') {
      await deps.sql.begin(async (tx) => {
        await setTxTimeouts(tx);
        const [cur] = await tx<{ status: string }[]>`SELECT status FROM platform_verifications WHERE id = ${r.id} FOR UPDATE`;
        if (cur?.status !== 'verifying') return;
        if (result.status === 'verified') await tx`UPDATE platform_verifications SET status = 'verified', verify_no = ${result.verifyNo}, verified_at = now(), updated_at = now() WHERE id = ${r.id}`;
        else await tx`UPDATE platform_verifications SET status = 'failed', fail_reason = ${result.error.slice(0, 200)}, updated_at = now() WHERE id = ${r.id}`;
      });
    }
  }
  return { verification: await verificationView(deps.sql, r.id), replayed: r.replayed };
}

// ───────────────────────── 停在「核销中」的补结果 ─────────────────────────

/** 核销请求发出去以后等这么久还没写回结果，才去平台查（比对外调用的超时长，免得和还在路上的那一次抢着写） */
export const VERIFY_RESUME_AFTER_MS = 2 * 60_000;

/**
 * 写了「核销中」、还没写回结果（进程停了、重启了）：按我们的核销编号去平台查（只查，不再核销）——
 * 平台核销了的记「已核销」，平台没有这一次的记「没成功」（券还能再验），查不到结果的留着下次再查。
 * 只处理「核销中」超过 VERIFY_RESUME_AFTER_MS 的；结果回写只锁验券一行。返回是否有了结果。
 */
export async function resumeVerification(deps: Deps, id: number, now = new Date()): Promise<boolean> {
  const a = platformVoucherAdapter(deps.config.integrations);
  if (!a) return false;
  const [v] = await deps.sql<{ status: string; platform: VoucherPlatform; code: string; createdAt: Date }[]>`
    SELECT status, platform, code, created_at FROM platform_verifications WHERE id = ${id}`;
  if (!v || v.status !== 'verifying' || now.getTime() - new Date(v.createdAt).getTime() < VERIFY_RESUME_AFTER_MS) return false;
  const outNo = String(id).padStart(8, '0');
  const r = await withCallLog(
    deps.sql,
    { kind: 'platform_voucher', provider: v.platform, action: 'query', mode: a.mode, refType: 'platform_verification', refId: id, request: { code: v.code, outNo } },
    () => a.query({ platform: v.platform, code: v.code, outNo }),
    (x) => ({ status: x.status, ...(x.status === 'verified' ? { verifyNo: x.verifyNo } : x.status === 'unknown' ? { error: x.error } : {}) }),
  ).catch((e: unknown) => ({ status: 'unknown' as const, error: e instanceof Error ? e.message : String(e) }));
  if (r.status === 'unknown') return false;
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [cur] = await tx<{ status: string }[]>`SELECT status FROM platform_verifications WHERE id = ${id} FOR UPDATE`;
    if (cur?.status !== 'verifying') return false;
    if (r.status === 'verified') await tx`UPDATE platform_verifications SET status = 'verified', verify_no = ${r.verifyNo}, verified_at = now(), updated_at = now() WHERE id = ${id}`;
    else await tx`UPDATE platform_verifications SET status = 'failed', fail_reason = '平台上没有这一次核销（中途断了，没有核销），可以重新验券', updated_at = now() WHERE id = ${id}`;
    return true;
  });
}

/** 每分钟：停在「核销中」超过 2 分钟的去平台查结果（没配置平台验券时什么都不做） */
export async function sweepVerifying(deps: Deps, now = new Date()): Promise<number> {
  if (!platformVoucherAdapter(deps.config.integrations)) return 0;
  const rows = await deps.sql<{ id: number }[]>`
    SELECT id FROM platform_verifications WHERE status = 'verifying' AND created_at < ${new Date(now.getTime() - VERIFY_RESUME_AFTER_MS)} ORDER BY id LIMIT 50`;
  let n = 0;
  for (const r of rows) if (await resumeVerification(deps, Number(r.id), now)) n += 1;
  return n;
}

// ───────────────────────── 结账用掉、反结账解开 ─────────────────────────

/** 结账登记团购券时（调用方已取「平台 + 券码」咨询锁）：锁验券一行，核对已核销、券码一致、没被用过、金额 = 面值；返回项目名 */
export async function lockVerificationForUse(tx: Tx, id: number, expect: { platform: string; code: string; amount: number }): Promise<{ dealName: string }> {
  const [v] = await tx<{ platform: string; code: string; status: string; faceCents: number; dealName: string; couponId: number | null; cancelling: boolean }[]>`
    SELECT platform, code, status, face_cents, deal_name, group_buy_coupon_id AS coupon_id, cancelled_by IS NOT NULL AS cancelling
    FROM platform_verifications WHERE id = ${id} FOR UPDATE`;
  if (!v) throw notFound('验券记录不存在，请刷新后重试');
  if (v.platform !== expect.platform || v.code !== expect.code) throw unprocessable('VERIFICATION_MISMATCH', '验券记录的平台、券码和登记的团购券不一样');
  if (v.status !== 'verified') throw conflict('VERIFICATION_NOT_READY', v.status === 'verifying' ? '这张券还在核销中，等出了结果再结账' : '这张券的核销已经撤销或没成功，不能用');
  if (v.couponId) throw conflict('COUPON_USED', '这次验券已经用在别的结账单上了');
  // 撤销核销已经占住（正在问平台，或上一次平台没回应）：不能用，免得结了账平台那边却撤掉了
  if (v.cancelling) throw conflict('VERIFICATION_CANCELLING', '这张券正在撤销核销，不能用；撤销没成的，再点一次「撤销核销」问清平台以后再用');
  if (Number(v.faceCents) !== expect.amount) throw unprocessable('VERIFICATION_MISMATCH', `验过的券面值是 ${formatYuan(Number(v.faceCents))}，团购券这一行要填一样的金额`);
  return { dealName: v.dealName };
}

export async function markVerificationUsed(tx: Tx, id: number, couponId: number) {
  await tx`UPDATE platform_verifications SET group_buy_coupon_id = ${couponId}, updated_at = now() WHERE id = ${id}`;
}

/** 手输的团购券（没带验券编号）：这张券已经验过的不能再手输（调用方已取「平台 + 券码」咨询锁） */
export async function assertNotVerified(tx: Tx, platform: string, code: string) {
  const [live] = await tx<{ id: number }[]>`SELECT id FROM platform_verifications WHERE platform = ${platform} AND code = ${code} AND status IN ('verifying', 'verified')`;
  if (live) throw conflict('COUPON_VERIFIED', `${COUPON_PLATFORM_LABELS[platform as 'meituan'] ?? platform}券码 ${code} 已经验过券：请在团购券那一行点「验券」挂上验过的那一次，不用手输`);
}

/** 反结账：这张结账单的团购券作废以后，验券回到「没用」（id 升序） */
export async function releaseVerifications(tx: Tx, checkoutId: number) {
  const rows = await tx<{ id: number }[]>`
    SELECT v.id FROM platform_verifications v JOIN group_buy_coupons g ON g.id = v.group_buy_coupon_id
    WHERE g.checkout_id = ${checkoutId} ORDER BY v.id FOR UPDATE OF v`;
  for (const r of rows) await tx`UPDATE platform_verifications SET group_buy_coupon_id = NULL, updated_at = now() WHERE id = ${r.id}`;
}

// ───────────────────────── 撤销核销、转补录 ─────────────────────────

const Reason = z.string('请写原因').trim().min(2, '请写原因（至少 2 个字）').max(200, '原因最多 200 个字');

export async function cancelVerification(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<VerificationView> {
  const { reason } = parse(z.object({ reason: Reason }), raw);
  const a = await adapterOrThrow(deps);
  // 同一次验券同时只有一个撤销在跑：会话级咨询锁（进程停了连接一断就放开），拿不到的直接告诉他别人正在撤
  const conn = await deps.sql.reserve();
  try {
    const lockKey = `platform_verify_cancel:${id}`;
    const [got] = await conn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS ok`;
    if (!got?.ok) throw conflict('CANCEL_IN_PROGRESS', '别人正在撤销这张券的核销，请稍后刷新再看');
    try {
      return await cancelHeld(deps, a, id, reason, actor, ip);
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
    }
  } finally {
    conn.release();
  }
}

/**
 * 撤销核销（已取这一次验券的撤销锁）：
 *   1) 锁住验券一行先「占住」——记下撤销人与原因、还不记撤销时刻（「撤销中」），之后结账用券、转补录看到它都拒绝；已经用在结账单上的不让撤；
 *   2) 事务外问平台；
 *   3) 平台撤了 → 记「已撤销」；平台明确不让撤 → 放开占位（照旧能用、能转补录）；平台没回应 → 留着「撤销中」，再点一次撤销会再问平台。
 */
async function cancelHeld(deps: Deps, a: PlatformVoucher, id: number, reason: string, actor: Actor, ip?: string): Promise<VerificationView> {
  const v = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [cur] = await tx<{ status: string; couponId: number | null; platform: VoucherPlatform; code: string; verifyNo: string }[]>`
      SELECT status, group_buy_coupon_id AS coupon_id, platform, code, verify_no FROM platform_verifications WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('验券记录不存在');
    if (cur.status === 'cancelled') return null;
    if (cur.status !== 'verified') throw conflict('INVALID_STATE', '只有已核销的能撤销');
    if (cur.couponId) throw conflict('COUPON_USED', '这张券已经用在结账单上：要撤先反结账');
    await tx`UPDATE platform_verifications SET cancel_reason = ${reason}, cancelled_by = ${actor.id}, updated_at = now() WHERE id = ${id}`;
    return cur;
  });
  if (!v) return verificationView(deps.sql, id);
  let outcome: { ok: true } | { ok: false; definite: boolean; error: string };
  try {
    const r = await withCallLog(
      deps.sql,
      {
        kind: 'platform_voucher',
        provider: v.platform,
        action: 'cancel',
        mode: a.mode,
        refType: 'platform_verification',
        refId: id,
        request: { code: v.code, verifyNo: v.verifyNo },
        staffId: actor.id,
      },
      () => a.cancel({ platform: v.platform, code: v.code, verifyNo: v.verifyNo }),
      (x) => ({ ok: x.ok, error: x.error ?? null }),
    );
    outcome = r.ok ? { ok: true } : { ok: false, definite: true, error: r.error ?? '' };
  } catch (e) {
    outcome = { ok: false, definite: false, error: `平台没有回应：${e instanceof Error ? e.message : String(e)}` };
  }
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [cur] = await tx<{ status: string }[]>`SELECT status FROM platform_verifications WHERE id = ${id} FOR UPDATE`;
    if (cur!.status !== 'verified') return;
    if (outcome.ok) {
      await tx`UPDATE platform_verifications SET status = 'cancelled', cancel_reason = ${reason}, cancelled_by = ${actor.id}, cancelled_at = now(), updated_at = now() WHERE id = ${id}`;
      await writeAudit(tx, { staffId: actor.id, action: 'platform_verify', targetType: 'platform_verification', targetId: id, detail: { op: 'cancel', code: v.code, reason }, ip });
    } else if (outcome.definite) {
      await tx`UPDATE platform_verifications SET cancel_reason = NULL, cancelled_by = NULL, updated_at = now() WHERE id = ${id}`;
    }
  });
  if (!outcome.ok) {
    if (outcome.definite) throw conflict('CANCEL_FAILED', `平台没让撤销：${outcome.error}。过了平台允许的时间的，点「转补录」记一条平台核销补录`);
    throw conflict('CANCEL_UNKNOWN', `${outcome.error}。不知道平台撤没撤成：这张券先不能用，请稍后再点一次「撤销核销」（会再问平台）`);
  }
  return verificationView(deps.sql, id);
}

/** 平台不让撤了：转成一条平台核销补录（不算营业额，与平台打款对账），验券记「已转补录」 */
export async function recordVerification(deps: Deps, id: number, actor: Actor, ip?: string): Promise<VerificationView> {
  const [peek] = await deps.sql<{ platform: VoucherPlatform; code: string }[]>`SELECT platform, code FROM platform_verifications WHERE id = ${id}`;
  if (!peek) throw notFound('验券记录不存在');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockPlatformCode(tx, peek.platform, peek.code);
    const [v] = await tx<
      { status: string; couponId: number | null; cancelling: boolean; dealName: string; faceCents: number; settleCents: number; quantity: number; verifiedAt: Date; businessDate: string }[]
    >`
      SELECT status, group_buy_coupon_id AS coupon_id, cancelled_by IS NOT NULL AS cancelling, deal_name, face_cents, settle_cents, quantity, verified_at,
             to_char(business_date, 'YYYY-MM-DD') AS business_date
      FROM platform_verifications WHERE id = ${id} FOR UPDATE`;
    if (v!.status === 'recorded') return;
    if (v!.status !== 'verified') throw conflict('INVALID_STATE', '只有已核销、没用的能转补录');
    if (v!.cancelling) throw conflict('VERIFICATION_CANCELLING', '这张券正在撤销核销（或上一次撤销平台没有回应）：请先再点一次「撤销核销」问清平台，平台不让撤再转补录');
    if (v!.couponId) throw conflict('COUPON_USED', '这张券已经用在结账单上了，不用补录');
    const dup = await redemptionOfCode(tx, peek.platform, peek.code);
    if (dup) throw conflict('COUPON_USED', `这张券已经补登记过（${dup}）`);
    const no = await nextDocNo(tx, 'platform_redemption', 'PT', v!.businessDate);
    const key = randomUUID();
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO platform_redemptions (redemption_no, platform, code, deal_name, face_value, settle_amount, guests, redeemed_at, business_date, note,
                                        registered_by, client_key, request_hash)
      VALUES (${no}, ${peek.platform}, ${peek.code}, ${v!.dealName}, ${v!.faceCents}, ${v!.settleCents}, ${v!.quantity}, ${v!.verifiedAt}, ${v!.businessDate},
              ${'验券没结账，平台不让撤了，转补录'}, ${actor.id}, ${key}, ${hashRequest({ verificationId: id })})
      RETURNING id`;
    await tx`UPDATE platform_verifications SET status = 'recorded', redemption_id = ${row!.id}, updated_at = now() WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'platform_verify',
      targetType: 'platform_verification',
      targetId: id,
      detail: { op: 'record', code: peek.code, redemptionNo: no },
      ip,
      businessDate: v!.businessDate,
    });
  });
  return verificationView(deps.sql, id);
}

// ───────────────────────── 每天对账 ─────────────────────────

/** 对一个平台一个营业日：平台核销明细 与 团购券记录 + 补录 比对，记一次对账与差异 */
export async function reconcileDay(deps: Deps, platform: VoucherPlatform, date: string, staffId: number | null): Promise<PlatformReconRun> {
  const a = platformVoucherAdapter(deps.config.integrations);
  if (!a) throw conflict('VOUCHER_OFF', '没有配置平台验券，不能自动对账');
  let lines: { code: string; dealName: string; faceCents: number }[] = [];
  let error: string | null = null;
  try {
    lines = await withCallLog(
      deps.sql,
      { kind: 'platform_voucher', provider: platform, action: 'bill', mode: a.mode, request: { businessDate: date }, staffId },
      () => a.bill({ platform, businessDate: date }),
      (x) => ({ lines: x.length }),
    );
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }
  // 系统一侧：经过「验券」的那张按验券那天算（平台的核销明细就记在那天），没验过的按结账 / 补录那天；
  // 营收照旧按结账日（Codex 审查 92fc629 后补：原来今天验、明天结账的券，两天各对出一处假差异，怎么重跑都消不掉）
  const system = await deps.sql<{ code: string; cents: number; ref: string; dealName: string }[]>`
    SELECT g.code, g.amount AS cents, c.checkout_no AS ref, g.deal_name
    FROM group_buy_coupons g JOIN checkouts c ON c.id = g.checkout_id LEFT JOIN platform_verifications v ON v.id = g.verification_id
    WHERE g.platform = ${platform} AND coalesce(v.business_date, g.business_date) = ${date} AND g.status = 'active'
    UNION ALL
    SELECT r.code, r.face_value AS cents, r.redemption_no AS ref, r.deal_name
    FROM platform_redemptions r LEFT JOIN platform_verifications v ON v.redemption_id = r.id
    WHERE r.platform = ${platform} AND coalesce(v.business_date, r.business_date) = ${date} AND r.status = 'active'`;
  const issues: { kind: 'platform_only' | 'system_only' | 'amount_diff'; code: string; dealName: string; platformCents: number | null; systemCents: number | null; systemRef: string }[] = [];
  if (!error) {
    const sys = new Map(system.map((s) => [s.code, s]));
    for (const l of lines) {
      const s = sys.get(l.code);
      if (!s) issues.push({ kind: 'platform_only', code: l.code, dealName: l.dealName, platformCents: l.faceCents, systemCents: null, systemRef: '' });
      else if (Number(s.cents) !== l.faceCents) issues.push({ kind: 'amount_diff', code: l.code, dealName: l.dealName, platformCents: l.faceCents, systemCents: Number(s.cents), systemRef: s.ref });
    }
    const plat = new Set(lines.map((l) => l.code));
    for (const s of system) if (!plat.has(s.code)) issues.push({ kind: 'system_only', code: s.code, dealName: s.dealName, platformCents: null, systemCents: Number(s.cents), systemRef: s.ref });
  }
  const id = await deps.sql.begin(async (tx) => {
    const [run] = await tx<{ id: number }[]>`
      INSERT INTO platform_recon_runs (platform, business_date, adapter, ok, error, platform_lines, system_lines, issues, staff_id)
      VALUES (${platform}, ${date}, ${a.mode}, ${!error}, ${error}, ${lines.length}, ${system.length}, ${issues.length}, ${staffId})
      RETURNING id`;
    for (const i of issues) {
      await tx`
        INSERT INTO platform_recon_issues (run_id, platform, business_date, kind, code, deal_name, platform_cents, system_cents, system_ref)
        VALUES (${run!.id}, ${platform}, ${date}, ${i.kind}, ${i.code}, ${i.dealName.slice(0, 48)}, ${i.platformCents}, ${i.systemCents}, ${i.systemRef})`;
    }
    return Number(run!.id);
  });
  return (await runs(deps.sql, deps.sql`r.id = ${id}`))[0]!;
}

const localHm = (now: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);

/** 每分钟：过了设定的时间、前一个营业日还没对过账的平台，各对一次 */
export async function runVoucherReconcile(deps: Deps, now = new Date()): Promise<number> {
  if (!platformVoucherAdapter(deps.config.integrations)) return 0;
  const sw = await loadIntegrationSwitches(deps.sql);
  if (!sw.platformVoucher || localHm(now, deps.config.timezone) < sw.voucherReconcileAt) return 0;
  const settings = await loadSettings(deps.sql);
  const today = businessDateOf(now, deps.config.timezone, settings.businessDayStartHour);
  const [y] = await deps.sql<{ d: string }[]>`SELECT to_char(${today}::date - 1, 'YYYY-MM-DD') AS d`;
  let n = 0;
  for (const p of VOUCHER_PLATFORMS) {
    const [done] = await deps.sql<{ id: number }[]>`SELECT id FROM platform_recon_runs WHERE platform = ${p} AND business_date = ${y!.d} AND staff_id IS NULL LIMIT 1`;
    if (done) continue;
    await reconcileDay(deps, p, y!.d, null);
    n += 1;
  }
  return n;
}

async function runs(db: Db, where: Fragment): Promise<PlatformReconRun[]> {
  const rows = await db<PlatformReconRun[]>`
    SELECT r.id, r.platform, to_char(r.business_date, 'YYYY-MM-DD') AS business_date, r.ok, r.error, r.platform_lines, r.system_lines, r.issues,
           s.display_name AS staff_name, r.created_at
    FROM platform_recon_runs r LEFT JOIN staff s ON s.id = r.staff_id WHERE ${where} ORDER BY r.id DESC LIMIT 100`;
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/**
 * 一段时间里每个平台每天最近一次**对成了的**对账的差异。重跑没成功（取不到平台的对账单）只记在对账记录里、不写差异，
 * 不能因此把上一次对出来、还没处理的差异藏起来（Codex 审查 73ae462 后补）
 */
async function reconIssues(db: Db, from: string, to: string): Promise<PlatformReconIssue[]> {
  const rows = await db<PlatformReconIssue[]>`
    SELECT i.id, i.platform, to_char(i.business_date, 'YYYY-MM-DD') AS business_date, i.kind, i.code, i.deal_name, i.platform_cents, i.system_cents, i.system_ref,
           s.display_name AS resolved_by_name, i.resolved_at, i.resolve_note
    FROM platform_recon_issues i LEFT JOIN staff s ON s.id = i.resolved_by
    WHERE i.business_date BETWEEN ${from} AND ${to}
      AND i.run_id = (SELECT max(r.id) FROM platform_recon_runs r WHERE r.platform = i.platform AND r.business_date = i.business_date AND r.ok)
    ORDER BY i.business_date DESC, i.id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), platformCents: r.platformCents === null ? null : Number(r.platformCents), systemCents: r.systemCents === null ? null : Number(r.systemCents) }));
}

// ───────────────────────── 路由 ─────────────────────────

export function registerPlatformVerifyRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const anyone = guardAny('frontdesk.checkout', 'platform.redeem', 'platform.settle');
  app.get('/api/platform/verify/status', { preHandler: anyone }, async () => voucherStatus(deps));
  app.post('/api/platform/verify/prepare', { preHandler: guard('frontdesk.checkout') }, async (req) => prepareVoucher(deps, req.body, req.actor));
  app.post('/api/platform/verify', { preHandler: guard('frontdesk.checkout') }, async (req, reply) => {
    const r = await verifyVoucher(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r.verification;
  });
  /** 已验券没结账、还在核销中的 */
  app.get('/api/platform/verifications/open', { preHandler: anyone }, async () => views(sql, sql`(v.status = 'verified' AND v.group_buy_coupon_id IS NULL) OR v.status = 'verifying'`));
  app.get('/api/platform/verifications', { preHandler: guardAny('platform.redeem', 'platform.settle') }, async (req) => {
    const { from, to } = parse(z.object({ from: z.string().regex(ISO_DATE), to: z.string().regex(ISO_DATE) }), req.query);
    return views(sql, sql`v.business_date BETWEEN ${from} AND ${to}`);
  });
  const KeyParam = z.object({ key: z.uuid('操作编号格式不正确') });
  app.get('/api/platform/verifications/by-key/:key', { preHandler: guard('frontdesk.checkout') }, async (req) => {
    const { key } = parse(KeyParam, req.params);
    const [v] = await sql<{ id: number }[]>`SELECT id FROM platform_verifications WHERE client_key = ${key}`;
    if (!v) throw new AppError(404, 'NOT_FOUND', '没有查到这次验券（请求可能没到服务器）');
    return verificationView(sql, Number(v.id));
  });
  app.post('/api/platform/verifications/by-key/:key/abandon', { preHandler: guard('frontdesk.checkout') }, async (req) => {
    const { key } = parse(KeyParam, req.params);
    const r = await sql.begin(async (tx) => fenceKey(tx, key, 'platform_verify', req.actor.id));
    if ('existingOpType' in r) {
      const [v] = await sql<{ id: number }[]>`SELECT id FROM platform_verifications WHERE client_key = ${key}`;
      return { abandoned: false, verification: v ? await verificationView(sql, Number(v.id)) : null };
    }
    return { abandoned: true, verification: null };
  });
  app.post('/api/platform/verifications/:id/cancel', { preHandler: guard('platform.void') }, async (req) => cancelVerification(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.post('/api/platform/verifications/:id/record', { preHandler: guard('platform.void') }, async (req) => recordVerification(deps, parse(idParam, req.params).id, req.actor, req.ip));

  // 每天对账
  app.get('/api/platform/recon', { preHandler: guard('platform.settle') }, async (req) => {
    const { from, to } = parse(z.object({ from: z.string().regex(ISO_DATE), to: z.string().regex(ISO_DATE) }), req.query);
    return { runs: await runs(sql, sql`r.business_date BETWEEN ${from} AND ${to}`), issues: await reconIssues(sql, from, to) };
  });
  app.post('/api/platform/recon/run', { preHandler: guard('platform.settle') }, async (req) => {
    const { platform, date } = parse(z.object({ platform: Platform, date: z.string().regex(ISO_DATE, '日期不对') }), req.body);
    return reconcileDay(deps, platform, date, req.actor.id);
  });
  app.post('/api/platform/recon/issues/:id/resolve', { preHandler: guard('platform.settle') }, async (req) => {
    const { note } = parse(z.object({ note: Reason }), req.body);
    const id = parse(idParam, req.params).id;
    await sql.begin(async (tx) => {
      const [i] = await tx<{ resolvedAt: string | null }[]>`SELECT resolved_at FROM platform_recon_issues WHERE id = ${id} FOR UPDATE`;
      if (!i) throw notFound('对账差异不存在');
      if (i.resolvedAt) return;
      await tx`UPDATE platform_recon_issues SET resolved_by = ${req.actor.id}, resolved_at = now(), resolve_note = ${note} WHERE id = ${id}`;
    });
    return { ok: true };
  });
}
