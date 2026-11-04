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
import { quantityText } from '@shared/benefits';
import { DEDUCTION_RULE_LABELS, ENTRY_TYPE_LABELS } from '@shared/labels';
import { TIER_LABELS } from '@shared/membership';
import {
  MP_CODE,
  MP_CODE_SECONDS,
  MP_OPENID,
  MP_OPENID_HEADER,
  type MpBindAbandonResult,
  type MpBindingRow,
  type MpBenefits,
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
import { memberBenefits } from '../benefits';
import { expireMemberBonus } from '../bonus';
import { memberCoupons } from '../coupons';
import { listLedger } from '../ledger';
import { loadMembershipRules, memberGradeInfo } from '../membership';
import { loadSettings } from '../settings';
import { activePay } from './pay';
import { mpToday } from './public';
import { couponCenterOpen } from './coupon-center';
import { bookingOpenOf, foodOpenOf, loadInviteRules, loadRechargeRules } from './rules';

/** 网关验证过的小程序用户 */
export function openidOf(req: FastifyRequest): string {
  const v = req.headers[MP_OPENID_HEADER];
  if (typeof v !== 'string' || !MP_OPENID.test(v)) throw new AppError(400, 'MP_OPENID_REQUIRED', '请先在小程序里登录');
  return v;
}

const BindInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  phone: z.string().regex(/^1\d{10}$/, '手机号不正确'),
  /** 点绑定时小程序看到的绑定状态版本号（MpMe.bindVersion） */
  bindVersion: z.number('请刷新小程序后再绑定').int('请刷新小程序后再绑定').min(0, '请刷新小程序后再绑定'),
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

/**
 * 这个微信现在的有效绑定与绑定状态版本号，用一条语句读（同一个快照：不会把绑定前的「没绑定」和绑定后的版本号拼在一起，
 * 小程序线测试预检 3ab3ab5 的 P1）。版本号是绑定记录的条数加上已解绑的条数：绑定记录只追加、解绑只能填一次
 * （迁移 043 的触发器），所以每次绑定、解绑都加一、不会回到以前的数。
 */
export async function bindingStateOf(db: Db, openid: string): Promise<{ binding: { id: number; memberId: number } | null; version: number }> {
  const [row] = await db<{ id: number | null; memberId: number | null; version: number }[]>`
    SELECT b.id, b.member_id, v.version
    FROM (SELECT (count(*) + count(unbound_at))::int AS version FROM mp_bindings WHERE openid = ${openid}) v
    LEFT JOIN mp_bindings b ON b.openid = ${openid} AND b.unbound_at IS NULL`;
  return { binding: row?.id ? { id: Number(row.id), memberId: Number(row.memberId) } : null, version: row?.version ?? 0 };
}

/** 绑定、解绑、确认作废都先取这个微信的这把咨询锁：同一个微信的绑定状态（与版本号）在这把锁里只有一个在改 */
export const lockOpenid = (tx: Db, openid: string) => tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_bind:${openid}`}))`;
/**
 * 同一把锁的共享模式：线上充值建单读这个微信的有效绑定、写单子时拿着，解绑（排他）插不进来——
 * 解绑之后再扫这条绑定没付的单去关，不会漏掉刚好同时建的那一张（小程序线测试 866ccfa 的 P1）
 */
export const lockOpenidShared = (tx: Db, openid: string) => tx`SELECT pg_advisory_xact_lock_shared(hashtext(${`mp_bind:${openid}`}))`;

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
      await lockOpenid(tx, openid);
      // 这个编号已经确认作废（结果不确定时小程序请门店系统作废的）：晚到的原请求不再生效
      const [fenced] = await tx`SELECT 1 FROM mp_op_fences WHERE key = ${input.clientKey} AND op_type = 'mp_bind' AND openid = ${openid}`;
      if (fenced) throw conflict('OP_ABANDONED', '这次绑定已经放弃，请重新绑定');
      // 同一个操作编号重提：内容一样返回原来那次的结果
      const [prev] = await tx<{ openid: string; phone: string; memberId: number }[]>`
        SELECT openid, phone, member_id FROM mp_bindings WHERE client_key = ${input.clientKey}`;
      if (prev) {
        if (prev.openid !== openid || prev.phone !== input.phone) throw conflict('CLIENT_KEY_REUSED', '这次绑定的编号已经用过，请重新绑定');
        return { status: 'bound' as const, member: await memberBrief(tx, prev.memberId), replayed: true };
      }
      // 点绑定之后这个微信绑过或解绑过（版本号变了）：这是之前的请求，不再生效。例如手机上读不出来的旧编号，
      // 在换绑、解绑之后才晚到（小程序线测试预检 #44 的 P1）。绑定与员工解绑都在这个微信的咨询锁里改绑定记录，
      // 这里读到的绑定与版本号到写入、提交之前都不会变（3ab3ab5 的 P1：原来解绑不取这把锁，能插在比对与写入之间）
      const state = await bindingStateOf(tx, openid);
      if (state.version !== input.bindVersion) throw conflict('BIND_STALE', '绑定状态刚刚变过，请刷新后再绑定');
      const [m] = await tx<{ id: number; memberNo: string; name: string; status: string }[]>`
        SELECT id, member_no, name, status FROM members WHERE phone = ${input.phone} FOR SHARE`;
      const current = state.binding;
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

const AbandonInput = z.object({ clientKey: z.uuid('操作编号不正确') });

/**
 * 绑定结果不确定时确认作废这个编号（小程序线，迁移 044）：与绑定取同一把咨询锁（这个微信），二者不交错。
 * 已经绑上了只返回查回的结果；还没有就登记作废，之后原请求即使到达也不会绑定（OP_ABANDONED）。
 */
export async function abandonBind(deps: Deps, openid: string, raw: unknown): Promise<MpBindAbandonResult> {
  const { clientKey } = parse(AbandonInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpenid(tx, openid);
    const [prev] = await tx<{ openid: string; memberId: number }[]>`SELECT openid, member_id FROM mp_bindings WHERE client_key = ${clientKey}`;
    if (prev) {
      if (prev.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这次绑定的编号已经用过，请重新绑定');
      return { status: 'bound' as const, member: await memberBrief(tx, prev.memberId), replayed: true };
    }
    await tx`
      INSERT INTO mp_op_fences (key, op_type, openid) VALUES (${clientKey}, 'mp_bind', ${openid})
      ON CONFLICT (key, op_type) DO NOTHING`;
    const [fence] = await tx<{ openid: string }[]>`SELECT openid FROM mp_op_fences WHERE key = ${clientKey} AND op_type = 'mp_bind'`;
    if (fence?.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这次绑定的编号已经用过，请重新绑定');
    return { status: 'abandoned' as const };
  });
}

export async function getMe(deps: Deps, openid: string): Promise<MpMe> {
  const { binding: b, version: bindVersion } = await bindingStateOf(deps.sql, openid);
  if (!b) return { bound: false, bindVersion, member: null };
  // 与员工打开会员详情一样：先作废这位会员到期的赠金，看到的余额才是可用余额
  await expireMemberBonus(deps, b.memberId);
  const today = await mpToday(deps.sql, deps.config.timezone);
  const [m] = await deps.sql<{ memberNo: string; name: string; status: string; principalBalance: number; bonusBalance: number; mergedIntoId: number | null }[]>`
    SELECT member_no, name, status, principal_balance, bonus_balance, merged_into_id FROM members WHERE id = ${b.memberId}`;
  if (!m) throw notFound('会员不存在');
  const [info, rules, coupons, settings, rechargeRules, couponOpen, inviteRules, foodOpen, bookingOpen] = await Promise.all([
    memberGradeInfo(deps.sql, b.memberId, today),
    loadMembershipRules(deps.sql),
    memberCoupons(deps.sql, b.memberId, today),
    loadSettings(deps.sql),
    loadRechargeRules(deps.sql),
    couponCenterOpen(deps.sql),
    loadInviteRules(deps.sql),
    foodOpenOf(deps.sql),
    bookingOpenOf(deps.sql),
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
    ladder: rules.grades.map((r) => r.name),
  };
  return {
    bound: true,
    bindVersion,
    member: {
      ...brief(m),
      principalBalance: m.principalBalance,
      bonusBalance: m.bonusBalance,
      deductionRule: DEDUCTION_RULE_LABELS[settings.deductionRule].title,
      grade: g,
      availableCoupons: coupons.counts.available ?? 0,
      // 线上充值（第二期 2a）开着、门店系统的微信支付配好了：「我的」页显示「充值」
      rechargeOpen: rechargeRules.enabled && activePay() !== null,
      // 合并掉的会员卡（主线 v0.7.26）：只说已合并、请到前台换绑，不给目标会员的信息（MP25）
      merged: m.mergedIntoId !== null,
      // 领券中心（第二期 2c）开着、有可领的券：「我的」页显示「领券中心」
      couponCenterOpen: couponOpen,
      // 邀请好友（第三期 3b）开着：「我的」页显示「邀请好友」（能不能邀请到邀请页再看）
      inviteOpen: inviteRules.enabled,
      // 扫码点餐（第三期 3c）开着：「我的」页显示「点餐」「我的账单」（能不能点到点餐页再看：要有在店手牌）
      foodOpen,
      // 小程序预约（第三期 3d）开着、有可约的：「我的」页显示「预约」
      bookingOpen,
    },
  };
}

const LedgerQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

export async function getLedger(deps: Deps, openid: string, query: unknown): Promise<MpLedgerRow[]> {
  const memberId = await boundMemberId(deps.sql, openid);
  const { limit } = parse(LedgerQuery, query);
  // 与会员卡一样先作废到期的赠金，流水里才有这笔过期、结尾余额与会员卡对得上（Codex 审查 PR #42）。
  // 小程序同时取会员卡和流水时两边都会作废：先到的锁住会员一行作废，后到的等它提交后再查、已经没有要作废的，
  // 所以流水总在作废提交之后才读
  await expireMemberBonus(deps, memberId);
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

// ── 本月可享 ──

/** 本月可享：主线的 memberBenefits（与员工打开会员详情看到的「本月可享」同一套），只给顾客该看的字段 */
export async function getBenefits(deps: Deps, openid: string): Promise<MpBenefits> {
  const memberId = await boundMemberId(deps.sql, openid);
  const today = await mpToday(deps.sql, deps.config.timezone);
  const b = await memberBenefits(deps.sql, memberId, today);
  return {
    month: b.month,
    label: b.state.label,
    items: b.items.map((i) => ({
      code: i.code,
      name: i.name,
      category: i.category,
      period: i.period,
      allowance: i.category === 'discount' || i.category === 'info' ? '' : quantityText(i.category, i.period, i.quantity),
      content: i.content,
      conditions: i.conditions,
      used: i.category === 'service' ? i.used : null,
      limit: i.category === 'service' ? i.quantity : null,
      available: i.available,
    })),
    upcoming: b.upcoming.map((u) => ({ name: u.name, startLabel: u.startLabel })),
  };
}

// ── 会员码 ──

const codeWindow = (at = Date.now()) => Math.floor(at / (MP_CODE_SECONDS * 1000));
// 签名连同绑定记录的编号：解绑后再绑到别的微信，旧微信上一分钟内的码也认不出（Codex 审查 PR #42）
const codeMac = (secret: string, memberId: number, bindingId: number, window: number) =>
  String(createHmac('sha256', secret).update(`mpcode:v2:${memberId}:${bindingId}:${window}`).digest().readUInt32BE(0) % 1_000_000).padStart(6, '0');
const memberPart = (memberId: number) => (memberId <= 999_999 ? `8${String(memberId).padStart(6, '0')}` : `9${String(memberId).padStart(9, '0')}`);

/**
 * 会员码：8 + 会员编号（6 位）或 9 + 会员编号（9 位），再接时间窗的后 3 位与 6 位签名；不会与 11 位手机号混淆。
 * 签名里有这位会员当前有效的绑定记录编号（码里不带），校验时按当前有效的绑定算。
 */
export function makeMemberCode(secret: string, memberId: number, bindingId: number, at = Date.now()): string {
  const w = codeWindow(at);
  return `${memberPart(memberId)}${String(w % 1000).padStart(3, '0')}${codeMac(secret, memberId, bindingId, w)}`;
}

export async function issueMemberCode(deps: Deps, openid: string): Promise<MpMemberCode> {
  const secret = deps.config.mp.codeSecret;
  if (!secret) throw new AppError(503, 'MP_CODE_UNAVAILABLE', '会员码暂时用不了，请到前台报手机号');
  const binding = await activeBinding(deps.sql, openid);
  if (!binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
  const m = await memberBrief(deps.sql, binding.memberId);
  if (m.frozen) throw new AppError(403, 'MEMBER_FROZEN', '会员已冻结，会员码用不了，请到前台咨询');
  const now = Date.now();
  return {
    code: makeMemberCode(secret, binding.memberId, binding.id, now),
    expiresAt: new Date((codeWindow(now) + 1) * MP_CODE_SECONDS * 1000).toISOString(),
    refreshSeconds: MP_CODE_SECONDS,
  };
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
  // 按这位会员当前有效的绑定校验签名：解绑了认不出；换绑到别的微信后，旧微信的码也认不出
  const [m] = await deps.sql<{ id: number; memberNo: string; name: string; status: string; bindingId: number }[]>`
    SELECT m.id, m.member_no, m.name, m.status, b.id AS binding_id
    FROM members m JOIN mp_bindings b ON b.member_id = m.id AND b.unbound_at IS NULL
    WHERE m.id = ${memberId}`;
  const ok = !!m && window !== undefined && timingSafeEqual(Buffer.from(codeMac(secret, memberId, m.bindingId, window)), Buffer.from(mac));
  if (!ok) throw new AppError(410, 'CODE_EXPIRED', '会员码过期或不对（或微信已解绑），请让客人刷新后再扫');
  if (m!.status === 'frozen') throw new AppError(403, 'MEMBER_FROZEN', '这位会员已冻结');
  return { memberId: m!.id, memberNo: m!.memberNo, name: m!.name };
}

// ── 前台：绑定记录与解绑 ──

export async function memberBindings(db: Db, memberId: number): Promise<MpBindingRow[]> {
  return db<MpBindingRow[]>`
    SELECT b.id, right(b.openid, 6) AS openid_tail, b.phone, b.mock, b.bound_at, b.unbound_at, s.display_name AS unbound_by_name, b.unbind_reason,
           b.purged_at
    FROM mp_bindings b LEFT JOIN staff s ON s.id = b.unbound_by
    WHERE b.member_id = ${memberId} ORDER BY b.id DESC`;
}

const UnbindInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  reason: z.string().trim().min(1, '请写解绑原因').max(200, '原因最多 200 字'),
});

/** 解绑（MP6）：先取这个微信的咨询锁、再锁绑定记录一行；同一个操作编号重提返回原来那次的结果 */
export async function unbindMember(deps: Deps, bindingId: number, raw: unknown, ctx: OpContext): Promise<MpBindingRow> {
  const input = parse(UnbindInput, raw);
  const memberId = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 先取这个微信的咨询锁（与绑定、确认作废同一把），再锁绑定记录一行：解绑不会插在绑定比对版本号与写入之间
    // （小程序线测试预检 3ab3ab5 的 P1）。绑定记录的 openid 不能改（迁移 043 的触发器），先不加锁读出来没关系
    const [who] = await tx<{ openid: string }[]>`SELECT openid FROM mp_bindings WHERE id = ${bindingId}`;
    if (!who) throw notFound('绑定记录不存在');
    await lockOpenid(tx, who.openid);
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
