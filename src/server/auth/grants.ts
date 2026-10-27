// 当场授权（店主 ❓2 / ❓4）：授权人在当前弹窗输入自己的账号密码，服务端核对后签发一次性授权。
//
//   · 授权绑定用途、申请的员工和授权对象（哪位客人用哪张柜），5 分钟内有效，只能用一次；
//   · 业务请求只带授权编号，在同一事务里核销：业务回滚时核销一起回滚，授权仍可在有效期内再用；
//   · 授权人的密码错误与登录共用限流计数；失败返回 403 而不是 401，不会把前台员工自己登出；
//   · 授权人可以就是当班的值班经理本人（再输一次自己的密码确认）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { grantCovers, GRANT_TTL_MINUTES, type IssuedGrant, type VipGrantTag, type VipTagScope } from '@shared/grants';
import { can, type Duty, type Role } from '@shared/permissions';
import type { Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { AppError, conflict, unprocessable } from '../lib/errors';
import { parse } from '../lib/validate';
import { loadFrontdeskRules } from '../modules/frontdesk/common';
import { guard } from './guard';
import { checkLock, clearFailures, recordFailure } from './lockout';
import { verifyPassword } from './password';

const tagCode = z
  .string('请输入牌号')
  .transform(normalizeTagCode)
  .pipe(z.string().regex(TAG_CODE_PATTERN, '牌号格式不正确'));

const AuthorizeInput = z.object({
  username: z.string().trim().toLowerCase().min(1, '请输入授权人账号'),
  password: z.string().min(1, '请输入授权人密码'),
  purpose: z.literal('vip_tag', '暂不支持该授权用途'),
  scope: z.object({
    tags: z
      .array(z.object({ code: tagCode, memberId: z.number().int().positive().nullable() }))
      .min(1, '请说明授权哪张柜')
      .max(12, '一次最多授权 12 张柜'),
  }),
});

const authFailed = () => new AppError(403, 'AUTH_FAILED', '授权人账号或密码不正确');

export function registerGrantRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  app.post('/api/auth/authorize', { preHandler: guard('frontdesk.operate') }, async (req): Promise<IssuedGrant> => {
    const input = parse(AuthorizeInput, req.body);
    const rules = await loadFrontdeskRules(sql);
    if (!rules.vipOverrideEnabled) {
      throw conflict('VIP_OVERRIDE_DISABLED', '未开启「VIP 柜当场授权」，请店主在「管理 → 手牌」开启后再授权');
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
    if (!can({ role: approver.role, duties: approver.duties ?? [] }, 'auth.vipOverride')) {
      throw new AppError(403, 'AUTH_NOT_ALLOWED', `「${approver.displayName}」的岗位不能授权使用 VIP 柜，请值班经理、店总或店主授权`);
    }
    const scope: VipTagScope = { tags: input.scope.tags };
    const [grant] = await sql.begin(async (tx) => {
      const rows = await tx<{ id: string; expiresAt: string }[]>`
        INSERT INTO auth_grants (purpose, requested_by, approved_by, scope, expires_at)
        VALUES (${input.purpose}, ${req.actor.id}, ${approver.id}, ${tx.json(scope as never)}, now() + make_interval(mins => ${GRANT_TTL_MINUTES}))
        RETURNING id, expires_at`;
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'auth_granted',
        targetType: 'auth_grant',
        targetId: rows[0]!.id,
        detail: { purpose: input.purpose, approverId: approver.id, approverName: approver.displayName, scope },
        ip: req.ip,
      });
      return rows;
    });
    return { grantId: grant!.id, purpose: input.purpose, approverName: approver.displayName, expiresAt: grant!.expiresAt, scope };
  });
}

/**
 * 在业务事务里核销一次 VIP 柜授权（最后加锁：只有持有手牌锁的请求才会走到这里）。
 * 授权必须是本人申请、未用过、未过期，授权人仍在职且仍有授权权限，并且覆盖所有需要授权的柜与客人。
 */
export async function consumeVipGrant(
  tx: Tx,
  opts: { grantId: string; actor: Actor; needed: VipGrantTag[]; usedRef: string },
): Promise<{ approverId: number; approverName: string }> {
  const [g] = await tx<{
    purpose: string; requestedBy: number; approvedBy: number; scope: VipTagScope; usedAt: string | null; expired: boolean;
    approverName: string; role: Role; duties: Duty[] | null; active: boolean;
  }[]>`
    SELECT g.purpose, g.requested_by, g.approved_by, g.scope, g.used_at, g.expires_at <= now() AS expired,
           s.display_name AS approver_name, s.role, s.duties, s.active
    FROM auth_grants g JOIN staff s ON s.id = g.approved_by
    WHERE g.id = ${opts.grantId} FOR UPDATE OF g`;
  if (!g || g.purpose !== 'vip_tag') throw unprocessable('GRANT_INVALID', '找不到这次授权，请重新授权');
  if (g.requestedBy !== opts.actor.id) throw unprocessable('GRANT_INVALID', '这次授权是给其他员工的，请重新授权');
  if (g.usedAt) throw unprocessable('GRANT_USED', '这次授权已经用过，请重新授权');
  if (g.expired) throw unprocessable('GRANT_EXPIRED', `授权已过期（${GRANT_TTL_MINUTES} 分钟内有效），请重新授权`);
  if (!g.active || !can({ role: g.role, duties: g.duties ?? [] }, 'auth.vipOverride')) {
    throw unprocessable('GRANT_INVALID', `授权人「${g.approverName}」已停用或已不能授权 VIP 柜，请重新授权`);
  }
  if (!grantCovers(g.scope, opts.needed)) {
    throw unprocessable('GRANT_SCOPE', `授权不包含柜 ${opts.needed.map((n) => n.code).join('、')}（或客人已变更），请按当前内容重新授权`);
  }
  await tx`UPDATE auth_grants SET used_at = now(), used_ref = ${opts.usedRef} WHERE id = ${opts.grantId}`;
  return { approverId: g.approvedBy, approverName: g.approverName };
}
