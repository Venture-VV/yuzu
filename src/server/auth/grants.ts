// 当场授权（店主 ❓2 / ❓4）：授权人在当前弹窗输入自己的账号密码，服务端核对后签发一次性授权。
//
//   · 用途 vip_tag：散客或等级不够的会员使用 VIP 柜（值班经理及以上，经营规则开启后才可用）；
//     用途 over_limit：超过单笔上限的充值 / 消费（店总、店主）；
//     用途 checkout_discount：结账时的「优惠 / 免单」，绑定一起结账的来访与金额（值班经理及以上，R1.2）；
//     用途 ticket_discount：改成更便宜的票种或免票（接待时直接选免票也算），绑定手牌与票种（值班经理及以上，R1.2）；
//     优惠与降档的原因由申请的员工在弹窗里填写，随授权签发，核销后记到单据上；
//     用途 member_refund：退储值（店总、店主，v0.7.26，M69），绑定会员与退的本金；
//     用途 member_phone：店员、客户经理改会员手机号（值班经理及以上，v0.7.26，M77），绑定会员与新号码；
//   · 授权绑定用途、申请的员工和授权对象（哪位客人用哪张柜 / 哪位会员的哪类业务、多少金额），5 分钟内有效，只能用一次；
//   · 业务请求只带授权编号，在同一事务里核销：业务回滚时核销一起回滚，授权仍可在有效期内再用；
//   · 授权人的密码错误与登录共用限流计数；失败返回 403 而不是 401，不会把前台员工自己登出；
//   · 授权人可以就是当班的值班经理本人（再输一次自己的密码确认）；但「优惠 / 免单」不能由收银的本人授权，
//     值班经理、店总自己收银时要另一位值班经理、店总或店主授权，店主本人除外（R1.2-b，店主 2026-10-29 决定）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import {
  GRANT_PURPOSES,
  grantCovers,
  GRANT_TTL_MINUTES,
  sortedVisitIds,
  ticketGrantCovers,
  type DiscountScope,
  type GrantPurpose,
  type MemberPhoneScope,
  type MemberRefundScope,
  type IssuedGrant,
  type OverLimitScope,
  type TicketDiscountScope,
  type TicketGrantItem,
  type VipGrantTag,
  type VipTagScope,
} from '@shared/grants';
import { formatYuan } from '@shared/money';
import { can, type Duty, type Permission, type Role } from '@shared/permissions';
import type { Db, Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { AppError, conflict, forbidden, unprocessable } from '../lib/errors';
import { parse, positiveCents } from '../lib/validate';
import { loadFrontdeskRules } from '../modules/frontdesk/common';
import { loadSettings } from '../modules/settings';
import { guard } from './guard';
import { checkLock, clearFailures, recordFailure } from './lockout';
import { verifyPassword } from './password';
import { subjectOf } from './role-permissions';

const tagCode = z
  .string('请输入牌号')
  .transform(normalizeTagCode)
  .pipe(z.string().regex(TAG_CODE_PATTERN, '牌号格式不正确'));

const Credentials = z.object({
  username: z.string().trim().toLowerCase().min(1, '请输入授权人账号'),
  password: z.string().min(1, '请输入授权人密码'),
  purpose: z.enum(GRANT_PURPOSES, '暂不支持该授权用途'),
});

const VipScope = z.object({
  tags: z
    .array(z.object({ code: tagCode, memberId: z.number().int().positive().nullable() }))
    .min(1, '请说明授权哪张柜')
    .max(12, '一次最多授权 12 张柜'),
});

const OverLimitScopeInput = z.object({
  kind: z.enum(['recharge', 'consume'], '请说明授权哪类业务'),
  memberId: z.number().int().positive('请说明授权哪位会员'),
  amount: positiveCents('授权金额'),
});

const DiscountScopeInput = z
  .object({
    visitIds: z.array(z.number().int().positive(), '请说明授权哪次结账').max(30, '一次最多合并 30 张手牌').default([]),
    /** 桌台结账（餐饮第二步）：一起结账的开台；手牌结账时不带 */
    tableSessionIds: z.array(z.number().int().positive()).max(10, '一次最多合并 10 桌').default([]),
    amount: positiveCents('优惠金额'),
    reason: z.string('请填写优惠原因').trim().min(2, '请填写优惠原因（至少 2 个字）').max(64, '优惠原因最多 64 字'),
  })
  .refine((d) => (d.visitIds.length > 0) !== (d.tableSessionIds.length > 0), '请说明授权哪次结账');

const MemberRefundScopeInput = z.object({
  memberId: z.number().int().positive('请说明授权哪位会员'),
  amount: positiveCents('退的本金'),
});

const MemberPhoneScopeInput = z.object({
  memberId: z.number().int().positive('请说明授权哪位会员'),
  phone: z.string('请填写新手机号').trim().regex(/^1\d{10}$/, '手机号应为 11 位数字'),
});

const TicketScopeInput = z.object({
  items: z
    .array(z.object({ tagCode, ticketTypeId: z.number().int().positive('请选择票种') }), '请说明授权哪张手牌改哪个票种')
    .min(1, '请说明授权哪张手牌改哪个票种')
    .max(12, '一次最多授权 12 张手牌'),
  reason: z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(100, '原因最多 100 字'),
});

/** 各用途：申请人需要的权限、授权人需要的权限，以及授权人岗位不够时的提示 */
const PURPOSE_RULES: Record<GrantPurpose, { approver: Permission; approverText: string }> = {
  vip_tag: { approver: 'auth.vipOverride', approverText: '使用 VIP 柜，请值班经理、店总或店主授权' },
  over_limit: { approver: 'auth.overLimit', approverText: '超过单笔上限，请店总或店主授权' },
  checkout_discount: { approver: 'auth.discount', approverText: '优惠 / 免单，请值班经理、店总或店主授权' },
  ticket_discount: { approver: 'auth.discount', approverText: '降低票种或免票，请值班经理、店总或店主授权' },
  member_refund: { approver: 'auth.memberRefund', approverText: '退储值，请店总或店主授权' },
  member_phone: { approver: 'auth.memberPhone', approverText: '改会员手机号，请值班经理、店总或店主授权' },
};
const KIND_PERMISSION: Record<OverLimitScope['kind'], Permission> = { recharge: 'recharge.create', consume: 'consume.create' };
const KIND_LABEL: Record<OverLimitScope['kind'], string> = { recharge: '充值', consume: '消费' };

const authFailed = () => new AppError(403, 'AUTH_FAILED', '授权人账号或密码不正确');

export function registerGrantRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  app.post('/api/auth/authorize', { preHandler: guard() }, async (req): Promise<IssuedGrant> => {
    const input = parse(Credentials, req.body);
    // 先核对申请人能不能办这项业务、这项授权现在需不需要，再核对授权人的密码
    let scope: VipTagScope | OverLimitScope | DiscountScope | TicketDiscountScope | MemberRefundScope | MemberPhoneScope;
    const rawScope = (req.body as { scope?: unknown }).scope;
    if (input.purpose === 'vip_tag') {
      if (!can(req.actor, 'frontdesk.operate')) throw forbidden();
      scope = { tags: parse(VipScope, rawScope).tags };
      const rules = await loadFrontdeskRules(sql);
      if (!rules.vipOverrideEnabled) {
        throw conflict('VIP_OVERRIDE_DISABLED', '未开启「VIP 柜当场授权」，请店主在「管理 → 手牌」开启后再授权');
      }
    } else if (input.purpose === 'checkout_discount') {
      if (!can(req.actor, 'frontdesk.checkout')) throw forbidden();
      const d = parse(DiscountScopeInput, rawScope);
      scope = d.tableSessionIds.length
        ? { visitIds: [], tableSessionIds: sortedVisitIds(d.tableSessionIds), amount: d.amount, reason: d.reason }
        : { visitIds: sortedVisitIds(d.visitIds), amount: d.amount, reason: d.reason };
    } else if (input.purpose === 'ticket_discount') {
      if (!can(req.actor, 'frontdesk.operate')) throw forbidden();
      scope = parse(TicketScopeInput, rawScope);
    } else if (input.purpose === 'member_refund') {
      if (!can(req.actor, 'member.refund')) throw forbidden();
      scope = parse(MemberRefundScopeInput, rawScope);
    } else if (input.purpose === 'member_phone') {
      if (!can(req.actor, 'member.write')) throw forbidden();
      // 自己能改手机号的不用授权
      if (can(req.actor, 'member.phone')) throw conflict('GRANT_NOT_NEEDED', '你的岗位可以直接改会员手机号，不需要授权');
      scope = parse(MemberPhoneScopeInput, rawScope);
    } else {
      const s = parse(OverLimitScopeInput, rawScope);
      if (!can(req.actor, KIND_PERMISSION[s.kind])) throw forbidden();
      const settings = await loadSettings(sql);
      const limit = s.kind === 'recharge' ? settings.maxRechargeCents : settings.maxConsumeCents;
      if (s.amount <= limit) throw conflict('GRANT_NOT_NEEDED', `金额没有超过单笔${KIND_LABEL[s.kind]}上限 ${formatYuan(limit)}，不需要授权`);
      scope = { kind: s.kind, memberId: s.memberId, amount: s.amount };
    }
    checkLock(input.username);
    const [approver] = await sql<{ id: number; displayName: string; role: Role; duties: Duty[] | null; active: boolean; passwordHash: string }[]>`
      SELECT id, display_name, role, duties, active, password_hash FROM staff WHERE username = ${input.username}`;
    const ok = approver ? await verifyPassword(input.password, approver.passwordHash) : false;
    if (!approver || !ok || !approver.active) {
      recordFailure(input.username);
      await writeAudit(sql, {
        staffId: req.actor.id,
        action: 'auth_failed',
        detail: { purpose: input.purpose, username: input.username, reason: !approver ? 'unknown_user' : !ok ? 'bad_password' : 'inactive' },
        ip: req.ip,
      });
      if (approver && ok && !approver.active) throw new AppError(403, 'AUTH_FAILED', '授权人账号已停用');
      throw authFailed();
    }
    clearFailures(input.username);
    const rule = PURPOSE_RULES[input.purpose];
    if (!can(await subjectOf(sql, approver), rule.approver)) {
      throw new AppError(403, 'AUTH_NOT_ALLOWED', `「${approver.displayName}」的岗位不能授权${rule.approverText}`);
    }
    if (selfDiscount(input.purpose, req.actor.id, approver)) throw selfDiscountError();
    const grant = await sql.begin(async (tx) => {
      const row = await insertGrant(tx, { purpose: input.purpose, requestedBy: req.actor.id, approvedBy: approver.id, scope });
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'auth_granted',
        targetType: 'auth_grant',
        targetId: row.id,
        detail: { purpose: input.purpose, approverId: approver.id, approverName: approver.displayName, scope },
        ip: req.ip,
      });
      return row;
    });
    return { grantId: grant.id, purpose: input.purpose, approverName: approver.displayName, expiresAt: grant.expiresAt, scope } as IssuedGrant;
  });
}

/** 写入一条当场授权（授权人已核对；合成演示数据也用它为演示单据签发授权），有效期 GRANT_TTL_MINUTES 分钟 */
export async function insertGrant(
  db: Db,
  g: { purpose: GrantPurpose; requestedBy: number; approvedBy: number; scope: unknown },
): Promise<{ id: string; expiresAt: string }> {
  const [row] = await db<{ id: string; expiresAt: string }[]>`
    INSERT INTO auth_grants (purpose, requested_by, approved_by, scope, expires_at)
    VALUES (${g.purpose}, ${g.requestedBy}, ${g.approvedBy}, ${db.json(g.scope as never)}, now() + make_interval(mins => ${GRANT_TTL_MINUTES}))
    RETURNING id, expires_at`;
  return row!;
}

interface LockedGrant {
  purpose: string;
  requestedBy: number;
  approvedBy: number;
  scope: unknown;
  usedAt: string | null;
  expired: boolean;
  approverName: string;
  role: Role;
  duties: Duty[] | null;
  active: boolean;
}

/** 优惠 / 免单由收银的本人授权（店主除外）：R1.2-b 不允许 */
const selfDiscount = (purpose: GrantPurpose, requestedBy: number, approver: { id: number; role: Role }) =>
  purpose === 'checkout_discount' && approver.id === requestedBy && approver.role !== 'owner';
const selfDiscountError = () =>
  new AppError(403, 'AUTH_SELF_NOT_ALLOWED', '优惠 / 免单不能由收银的本人授权，请另一位值班经理、店总或店主授权');

/** 锁定授权并做通用核对：存在、用途一致、本人申请、未用过、未过期、授权人仍在职且仍有授权权限 */
async function lockGrant(tx: Tx, grantId: string, purpose: GrantPurpose, actor: Actor): Promise<LockedGrant> {
  const [g] = await tx<LockedGrant[]>`
    SELECT g.purpose, g.requested_by, g.approved_by, g.scope, g.used_at, g.expires_at <= now() AS expired,
           s.display_name AS approver_name, s.role, s.duties, s.active
    FROM auth_grants g JOIN staff s ON s.id = g.approved_by
    WHERE g.id = ${grantId} FOR UPDATE OF g`;
  if (!g || g.purpose !== purpose) throw unprocessable('GRANT_INVALID', '找不到这次授权，请重新授权');
  if (g.requestedBy !== actor.id) throw unprocessable('GRANT_INVALID', '这次授权是给其他员工的，请重新授权');
  if (g.usedAt) throw unprocessable('GRANT_USED', '这次授权已经用过，请重新授权');
  if (g.expired) throw unprocessable('GRANT_EXPIRED', `授权已过期（${GRANT_TTL_MINUTES} 分钟内有效），请重新授权`);
  if (!g.active || !can(await subjectOf(tx, g), PURPOSE_RULES[purpose].approver)) {
    throw unprocessable('GRANT_INVALID', `授权人「${g.approverName}」已停用或已不能授权${PURPOSE_RULES[purpose].approverText.split('，')[0]}，请重新授权`);
  }
  // 升级前签发、还在有效期内的本人授权同样不能用
  if (selfDiscount(purpose, g.requestedBy, { id: g.approvedBy, role: g.role })) {
    throw unprocessable('GRANT_INVALID', '优惠 / 免单不能由收银的本人授权，请另一位值班经理、店总或店主重新授权');
  }
  return g;
}

/**
 * 在充值 / 消费的事务里核销一次超限授权（会员锁之后加锁）。
 * 授权必须覆盖这位会员、这类业务、这个金额（金额改了要重新授权）。
 */
export async function consumeOverLimitGrant(
  tx: Tx,
  opts: { grantId: string; actor: Actor; scope: OverLimitScope; usedRef: string },
): Promise<{ approverId: number; approverName: string }> {
  const g = await lockGrant(tx, opts.grantId, 'over_limit', opts.actor);
  const s = g.scope as OverLimitScope;
  if (s.kind !== opts.scope.kind || s.memberId !== opts.scope.memberId || s.amount !== opts.scope.amount) {
    throw unprocessable(
      'GRANT_SCOPE',
      `授权的是${KIND_LABEL[s.kind]} ${formatYuan(s.amount)}，与这笔${KIND_LABEL[opts.scope.kind]} ${formatYuan(opts.scope.amount)}（或会员）不一致，请按当前内容重新授权`,
    );
  }
  await tx`UPDATE auth_grants SET used_at = now(), used_ref = ${opts.usedRef} WHERE id = ${opts.grantId}`;
  return { approverId: g.approvedBy, approverName: g.approverName };
}

/**
 * 在业务事务里核销一次 VIP 柜授权（最后加锁：只有持有手牌锁的请求才会走到这里）。
 * 授权必须是本人申请、未用过、未过期，授权人仍在职且仍有授权权限，并且覆盖所有需要授权的柜与客人。
 */
export async function consumeVipGrant(
  tx: Tx,
  opts: { grantId: string; actor: Actor; needed: VipGrantTag[]; usedRef: string },
): Promise<{ approverId: number; approverName: string }> {
  const g = await lockGrant(tx, opts.grantId, 'vip_tag', opts.actor);
  if (!grantCovers(g.scope as VipTagScope, opts.needed)) {
    throw unprocessable('GRANT_SCOPE', `授权不包含柜 ${opts.needed.map((n) => n.code).join('、')}（或客人已变更），请按当前内容重新授权`);
  }
  await tx`UPDATE auth_grants SET used_at = now(), used_ref = ${opts.usedRef} WHERE id = ${opts.grantId}`;
  return { approverId: g.approvedBy, approverName: g.approverName };
}

/**
 * 在结账事务里核销一次优惠 / 免单授权（来访、账单锁之后加锁）。
 * 授权必须覆盖同一组来访与同一个优惠金额（客人或金额改了要重新授权）；返回授权人与原因，原因记到收款明细上。
 */
export async function consumeDiscountGrant(
  tx: Tx,
  opts: { grantId: string; actor: Actor; visitIds: number[]; tableSessionIds?: number[]; amount: number; usedRef: string },
): Promise<{ approverId: number; approverName: string; reason: string }> {
  const g = await lockGrant(tx, opts.grantId, 'checkout_discount', opts.actor);
  const s = g.scope as DiscountScope;
  const same = (a: readonly number[], b: readonly number[]) => {
    const x = sortedVisitIds(a);
    const y = sortedVisitIds(b);
    return x.length === y.length && x.every((id, i) => id === y[i]);
  };
  // 手牌结账的授权只能用于这几张手牌，桌台结账的授权只能用于这几桌（升级前签发的授权没有桌台一项，按空处理）
  if (s.amount !== opts.amount || !same(s.visitIds, opts.visitIds) || !same(s.tableSessionIds ?? [], opts.tableSessionIds ?? [])) {
    throw unprocessable(
      'GRANT_SCOPE',
      `授权的是优惠 ${formatYuan(s.amount)}，与这次结账的优惠 ${formatYuan(opts.amount)}（或结账的手牌）不一致，请按当前内容重新授权`,
    );
  }
  await tx`UPDATE auth_grants SET used_at = now(), used_ref = ${opts.usedRef} WHERE id = ${opts.grantId}`;
  return { approverId: g.approvedBy, approverName: g.approverName, reason: s.reason };
}

/**
 * 在业务事务里核销一次降档 / 免票授权（来访或手牌锁之后加锁）。
 * 授权必须覆盖所有需要授权的手牌与票种；返回授权人与原因，记到改票种记录上。
 */
export async function consumeTicketGrant(
  tx: Tx,
  opts: { grantId: string; actor: Actor; needed: TicketGrantItem[]; usedRef: string },
): Promise<{ approverId: number; approverName: string; reason: string }> {
  const g = await lockGrant(tx, opts.grantId, 'ticket_discount', opts.actor);
  const s = g.scope as TicketDiscountScope;
  if (!ticketGrantCovers(s, opts.needed)) {
    throw unprocessable('GRANT_SCOPE', `授权不包含手牌 ${opts.needed.map((n) => n.tagCode).join('、')} 改成的票种（或票种已变更），请按当前内容重新授权`);
  }
  await tx`UPDATE auth_grants SET used_at = now(), used_ref = ${opts.usedRef} WHERE id = ${opts.grantId}`;
  return { approverId: g.approvedBy, approverName: g.approverName, reason: s.reason };
}

/**
 * 在退储值的事务里核销一次授权（会员一行锁住之后）：授权必须覆盖这位会员、这个本金（金额改了要重新授权）。
 * 店主、店总自己办时，授权人可以就是本人（再输一次自己的密码确认）
 */
export async function consumeMemberRefundGrant(
  tx: Tx,
  opts: { grantId: string; actor: Actor; scope: MemberRefundScope; usedRef: string },
): Promise<{ approverId: number; approverName: string }> {
  const g = await lockGrant(tx, opts.grantId, 'member_refund', opts.actor);
  const s = g.scope as MemberRefundScope;
  if (s.memberId !== opts.scope.memberId || s.amount !== opts.scope.amount) {
    throw unprocessable('GRANT_SCOPE', `授权的是退储值 ${formatYuan(s.amount)}，与这次退的 ${formatYuan(opts.scope.amount)}（或会员）不一致，请按当前内容重新授权`);
  }
  await tx`UPDATE auth_grants SET used_at = now(), used_ref = ${opts.usedRef} WHERE id = ${opts.grantId}`;
  return { approverId: g.approvedBy, approverName: g.approverName };
}

/** 在改会员手机号的事务里核销一次授权（会员一行锁住之后）：授权必须覆盖这位会员、这个新号码 */
export async function consumeMemberPhoneGrant(
  tx: Tx,
  opts: { grantId: string; actor: Actor; scope: MemberPhoneScope; usedRef: string },
): Promise<{ approverId: number; approverName: string }> {
  const g = await lockGrant(tx, opts.grantId, 'member_phone', opts.actor);
  const s = g.scope as MemberPhoneScope;
  if (s.memberId !== opts.scope.memberId || s.phone !== opts.scope.phone) {
    throw unprocessable('GRANT_SCOPE', `授权的是改成 ${s.phone}，与这次要改的号码（或会员）不一致，请按当前内容重新授权`);
  }
  await tx`UPDATE auth_grants SET used_at = now(), used_ref = ${opts.usedRef} WHERE id = ${opts.grantId}`;
  return { approverId: g.approvedBy, approverName: g.approverName };
}
