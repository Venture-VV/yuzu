// 小程序的会员接口（小程序线，docs/MINIPROGRAM.md 第 4、12 节）：绑定、会员卡与余额、流水、券、会员码；
// 前台用会员码查会员、解绑会员的微信。
//
// 绑定：网关先用微信的手机号验证拿到手机号，再带 openid、手机号与操作编号调绑定。手机号等于某位会员的手机号才绑定，
// 对不上的不建会员（MP3）。加锁：这个微信的咨询锁 → 会员一行（共享锁）→ 写绑定记录；不碰钱包、不等前台的锁。
// 同一时刻一个微信、一位会员各只有一条有效绑定，数据库唯一索引兜底；同一个操作编号重提返回原来那次的结果。
// 会员码（MP9）：由 yuzu 签发，密钥只在 yuzu；只用来认人，不代替用储值付款时的核对。

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ENTRY_TYPE_LABELS } from '@shared/labels';
import { TIER_LABELS } from '@shared/membership';
import {
  MP_CODE,
  MP_CODE_SECONDS,
  MP_OPENID,
  MP_OPENID_HEADER,
  type MpBindingRow,
  type MpBindResult,
  type MpCodeLookup,
  type MpCoupon,
  type MpGrade,
  type MpLedgerRow,
  type MpMe,
  type MpMemberBrief,
  type MpMemberCode,
} from '@shared/mp';
import { isUniqueViolation, type Db } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { expireMemberBonus } from '../bonus';
import { memberCoupons } from '../coupons';
import { listLedger } from '../ledger';
import { loadMembershipRules, memberGradeInfo } from '../membership';
import { mpToday } from './public';

/** 网关验证过的小程序用户 */
export function openidOf(req: FastifyRequest): string {
  const v = req.headers[MP_OPENID_HEADER];
  if (typeof v !== 'string' || !MP_OPENID.test(v)) throw new AppError(400, 'MP_OPENID_REQUIRED', '请先在小程序里登录');
  return v;
}

const BindInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  phone: z.string().regex(/^1\d{10}$/, '手机号不正确'),
  /** 模拟微信（假手机号）：只在 development、test 实例允许 */
  mock: z.boolean().default(false),
});

const brief = (m: { memberNo: string; name: string; status: string }): MpMemberBrief => ({ memberNo: m.memberNo, name: m.name, frozen: m.status === 'frozen' });

async function memberBrief(db: Db, memberId: number): Promise<MpMemberBrief> {
  const [m] = await db<{ memberNo: string; name: string; status: string }[]>`SELECT member_no, name, status FROM members WHERE id = ${memberId}`;
  if (!m) throw notFound('会员不存在');
  return brief(m);
}

/** 这个微信当前的有效绑定 */
export async function activeBinding(db: Db, openid: string): Promise<{ id: number; memberId: number } | null> {
  const [row] = await db<{ id: number; memberId: number }[]>`SELECT id, member_id FROM mp_bindings WHERE openid = ${openid} AND unbound_at IS NULL`;
  return row ?? null;
}

async function boundMemberId(db: Db, openid: string): Promise<number> {
  const b = await activeBinding(db, openid);
  if (!b) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
  return b.memberId;
}

export async function bindMember(deps: Deps, openid: string, raw: unknown): Promise<MpBindResult> {
  const input = parse(BindInput, raw);
  if (input.mock && deps.config.env !== 'development' && deps.config.env !== 'test') {
    throw new AppError(403, 'MP_MOCK_REFUSED', '这个门店系统不接受模拟绑定');
  }
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_bind:${openid}`}))`;
      // 同一个操作编号重提：内容一样返回原来那次的结果
      const [prev] = await tx<{ openid: string; phone: string; memberId: number }[]>`
        SELECT openid, phone, member_id FROM mp_bindings WHERE client_key = ${input.clientKey}`;
      if (prev) {
        if (prev.openid !== openid || prev.phone !== input.phone) throw conflict('CLIENT_KEY_REUSED', '这次绑定的编号已经用过，请重新绑定');
        return { status: 'bound' as const, member: await memberBrief(tx, prev.memberId), replayed: true };
      }
      const [m] = await tx<{ id: number; memberNo: string; name: string; status: string }[]>`
        SELECT id, member_no, name, status FROM members WHERE phone = ${input.phone} FOR SHARE`;
      const current = await activeBinding(tx, openid);
      if (current) {
        // 这个微信已经绑定了这位会员：照旧返回；绑定的是别人就要先到前台解绑
        if (m && current.memberId === m.id) return { status: 'bound' as const, member: brief(m), replayed: true };
        throw conflict('OPENID_BOUND', '这个微信已经绑定了另一位会员，要换绑请到前台办理');
      }
      if (!m) throw new AppError(404, 'NOT_MEMBER', '这个手机号还不是会员，请到前台开卡');
      const [other] = await tx`SELECT 1 FROM mp_bindings WHERE member_id = ${m.id} AND unbound_at IS NULL`;
      if (other) throw conflict('MEMBER_BOUND', '这位会员已经绑定了别的微信，要换绑请到前台办理');
      await tx`
        INSERT INTO mp_bindings (openid, member_id, phone, mock, client_key)
        VALUES (${openid}, ${m.id}, ${input.phone}, ${input.mock}, ${input.clientKey})`;
      return { status: 'bound' as const, member: brief(m), replayed: false };
    });
  } catch (error) {
    // 另一个微信同时绑同一位会员：唯一索引兜底
    if (isUniqueViolation(error, 'mp_bindings_member_active_uq')) throw conflict('MEMBER_BOUND', '这位会员已经绑定了别的微信，要换绑请到前台办理');
    if (isUniqueViolation(error, 'mp_bindings_client_key_key')) throw conflict('CLIENT_KEY_REUSED', '这次绑定的编号已经用过，请重新绑定');
    throw error;
  }
}

export async function getMe(deps: Deps, openid: string): Promise<MpMe> {
  const b = await activeBinding(deps.sql, openid);
  if (!b) return { bound: false, member: null };
  // 与员工打开会员详情一样：先作废这位会员到期的赠金，看到的余额才是可用余额
  await expireMemberBonus(deps, b.memberId);
  const today = await mpToday(deps.sql, deps.config.timezone);
  const [m] = await deps.sql<{ memberNo: string; name: string; status: string; principalBalance: number; bonusBalance: number }[]>`
    SELECT member_no, name, status, principal_balance, bonus_balance FROM members WHERE id = ${b.memberId}`;
  if (!m) throw notFound('会员不存在');
  const [info, rules, coupons] = await Promise.all([
    memberGradeInfo(deps.sql, b.memberId, today),
    loadMembershipRules(deps.sql),
    memberCoupons(deps.sql, b.memberId, today),
  ]);
  const { grade, tier, cycleEnd } = info.state;
  const g: MpGrade = {
    label: info.label,
    grade,
    gradeName: rules.grades[grade]?.name ?? '',
    tier,
    tierName: tier === null ? null : (TIER_LABELS[tier as 0 | 1 | 2] ?? null),
    cycleEnd,
    daysLeft: info.daysLeft,
    inGrace: info.inGrace,
    cycleSpendCents: info.cycleSpendCents,
    targets: info.targets,
    next: info.next ? { grade: info.next.grade, name: info.next.name, needCents: info.next.needCents, bonusBp: info.next.bonusBp } : null,
  };
  return {
    bound: true,
    member: { ...brief(m), principalBalance: m.principalBalance, bonusBalance: m.bonusBalance, grade: g, availableCoupons: coupons.counts.available ?? 0 },
  };
}

const LedgerQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

export async function getLedger(deps: Deps, openid: string, query: unknown): Promise<MpLedgerRow[]> {
  const memberId = await boundMemberId(deps.sql, openid);
  const { limit } = parse(LedgerQuery, query);
  const rows = await listLedger(deps.sql, { memberId, limit });
  // 只给顾客看得懂、该看的：不带经办人、单号与内部字段
  return rows.map((r) => ({
    id: r.id,
    kind: r.entryType,
    kindLabel: ENTRY_TYPE_LABELS[r.entryType] ?? r.entryType,
    principalDelta: r.principalDelta,
    bonusDelta: r.bonusDelta,
    principalAfter: r.principalAfter,
    bonusAfter: r.bonusAfter,
    businessDate: r.businessDate,
    createdAt: r.createdAt,
    summary: r.summary,
  }));
}

export async function getCoupons(deps: Deps, openid: string): Promise<MpCoupon[]> {
  const memberId = await boundMemberId(deps.sql, openid);
  const today = await mpToday(deps.sql, deps.config.timezone);
  const { coupons } = await memberCoupons(deps.sql, memberId, today);
  const order: Record<string, number> = { available: 0, pending: 1, expired: 2, used: 3, voided: 4 };
  return coupons
    .map((c) => ({ code: c.code, name: c.templateName, kind: c.kind, summary: c.summary, validFrom: c.validFrom, validTo: c.validTo, state: c.state }))
    .sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
}

// ── 会员码 ──

const codeWindow = (at = Date.now()) => Math.floor(at / (MP_CODE_SECONDS * 1000));
const codeMac = (secret: string, memberId: number, window: number) =>
  String(createHmac('sha256', secret).update(`mpcode:v1:${memberId}:${window}`).digest().readUInt32BE(0) % 1_000_000).padStart(6, '0');
const memberPart = (memberId: number) => (memberId <= 999_999 ? `8${String(memberId).padStart(6, '0')}` : `9${String(memberId).padStart(9, '0')}`);

/** 会员码：8 + 会员编号（6 位）或 9 + 会员编号（9 位），再接时间窗的后 3 位与 6 位签名；不会与 11 位手机号混淆 */
export function makeMemberCode(secret: string, memberId: number, at = Date.now()): string {
  const w = codeWindow(at);
  return `${memberPart(memberId)}${String(w % 1000).padStart(3, '0')}${codeMac(secret, memberId, w)}`;
}

export async function issueMemberCode(deps: Deps, openid: string): Promise<MpMemberCode> {
  const secret = deps.config.mp.codeSecret;
  if (!secret) throw new AppError(503, 'MP_CODE_UNAVAILABLE', '会员码暂时用不了，请到前台报手机号');
  const memberId = await boundMemberId(deps.sql, openid);
  const m = await memberBrief(deps.sql, memberId);
  if (m.frozen) throw new AppError(403, 'MEMBER_FROZEN', '会员已冻结，会员码用不了，请到前台咨询');
  const now = Date.now();
  return { code: makeMemberCode(secret, memberId, now), expiresAt: new Date((codeWindow(now) + 1) * MP_CODE_SECONDS * 1000).toISOString(), refreshSeconds: MP_CODE_SECONDS };
}

/** 前台扫到会员码：签名对、时间窗是这一分钟或上一分钟、会员没冻结、绑定还有效，才认出会员 */
export async function resolveMemberCode(deps: Deps, code: string, at = Date.now()): Promise<MpCodeLookup> {
  const secret = deps.config.mp.codeSecret;
  if (!secret) throw new AppError(503, 'MP_CODE_UNAVAILABLE', '门店系统没有配会员码，请让客人报手机号');
  if (!MP_CODE.test(code)) throw badRequest('这不是会员码');
  const idLen = code[0] === '8' ? 6 : 9;
  const memberId = Number(code.slice(1, 1 + idLen));
  const w3 = Number(code.slice(1 + idLen, 4 + idLen));
  const mac = code.slice(4 + idLen);
  const now = codeWindow(at);
  const window = [now, now - 1].find((w) => w % 1000 === w3);
  const ok = window !== undefined && timingSafeEqual(Buffer.from(codeMac(secret, memberId, window)), Buffer.from(mac));
  if (!ok) throw new AppError(410, 'CODE_EXPIRED', '会员码过期或不对，请让客人刷新后再扫');
  const [m] = await deps.sql<{ id: number; memberNo: string; name: string; status: string }[]>`
    SELECT m.id, m.member_no, m.name, m.status FROM members m
    WHERE m.id = ${memberId} AND EXISTS (SELECT 1 FROM mp_bindings b WHERE b.member_id = m.id AND b.unbound_at IS NULL)`;
  if (!m) throw new AppError(410, 'CODE_EXPIRED', '会员码已失效（微信已解绑），请让客人报手机号');
  if (m.status === 'frozen') throw new AppError(403, 'MEMBER_FROZEN', '这位会员已冻结');
  return { memberId: m.id, memberNo: m.memberNo, name: m.name };
}

// ── 前台：绑定记录与解绑 ──

export async function memberBindings(db: Db, memberId: number): Promise<MpBindingRow[]> {
  return db<MpBindingRow[]>`
    SELECT b.id, right(b.openid, 6) AS openid_tail, b.phone, b.mock, b.bound_at, b.unbound_at, s.display_name AS unbound_by_name, b.unbind_reason
    FROM mp_bindings b LEFT JOIN staff s ON s.id = b.unbound_by
    WHERE b.member_id = ${memberId} ORDER BY b.id DESC`;
}

const UnbindInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  reason: z.string().trim().min(1, '请写解绑原因').max(200, '原因最多 200 字'),
});

/** 解绑（MP6）：只锁绑定记录一行；同一个操作编号重提返回原来那次的结果 */
export async function unbindMember(deps: Deps, bindingId: number, raw: unknown, ctx: OpContext): Promise<MpBindingRow> {
  const input = parse(UnbindInput, raw);
  const memberId = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [b] = await tx<{ memberId: number; unboundAt: string | null; unbindClientKey: string | null }[]>`
      SELECT member_id, unbound_at, unbind_client_key FROM mp_bindings WHERE id = ${bindingId} FOR UPDATE`;
    if (!b) throw notFound('绑定记录不存在');
    if (b.unboundAt) {
      if (b.unbindClientKey === input.clientKey) return b.memberId;
      throw conflict('ALREADY_UNBOUND', '这个微信已经解绑了');
    }
    await tx`
      UPDATE mp_bindings SET unbound_at = now(), unbound_by = ${ctx.actor.id}, unbind_reason = ${input.reason}, unbind_client_key = ${input.clientKey}
      WHERE id = ${bindingId}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'mp_unbind', targetType: 'member', targetId: b.memberId, detail: { bindingId, reason: input.reason }, ip: ctx.ip });
    return b.memberId;
  });
  const row = (await memberBindings(deps.sql, memberId)).find((r) => r.id === bindingId);
  return row!;
}
