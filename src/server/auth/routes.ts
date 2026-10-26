import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import { permissionsOf, type Duty, type Role } from '@shared/permissions';
import type { SessionInfo } from '@shared/types';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { AppError, badRequest, unauthorized } from '../lib/errors';
import { parse } from '../lib/validate';
import { loadSettings } from '../modules/settings';
import { sessionOnly } from './guard';
import { checkPasswordStrength, hashPassword, verifyPassword } from './password';
import { SESSION_COOKIE, createSession, destroySession, destroyStaffSessions } from './session';

const LoginInput = z.object({
  username: z.string().trim().toLowerCase().min(1, '请输入账号'),
  password: z.string().min(1, '请输入密码'),
});

const ChangePasswordInput = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string(),
});

// 简单的登录失败限流：同一账号 15 分钟内失败 5 次，锁定 5 分钟。
const MAX_FAILURES = 5;
const failures = new Map<string, { count: number; first: number; lockedUntil: number }>();

function checkLock(username: string) {
  const f = failures.get(username);
  if (f && f.lockedUntil > Date.now()) {
    const minutes = Math.ceil((f.lockedUntil - Date.now()) / 60_000);
    throw new AppError(429, 'LOGIN_LOCKED', `密码错误次数过多，请 ${minutes} 分钟后再试或联系店主重置密码`);
  }
}

function recordFailure(username: string) {
  const now = Date.now();
  const f = failures.get(username);
  if (!f || now - f.first > 15 * 60_000) {
    failures.set(username, { count: 1, first: now, lockedUntil: 0 });
    return;
  }
  f.count += 1;
  if (f.count >= MAX_FAILURES) f.lockedUntil = now + 5 * 60_000;
}

export async function buildSessionInfo({ sql, config }: Deps, actor: Actor): Promise<SessionInfo> {
  const settings = await loadSettings(sql);
  const [synthetic] = await sql<{ exists: boolean }[]>`SELECT (EXISTS (SELECT 1 FROM members WHERE is_synthetic) OR EXISTS (SELECT 1 FROM materials WHERE is_synthetic)) AS exists`;
  const { storeName, ...rules } = settings;
  return {
    staff: actor,
    permissions: permissionsOf(actor),
    storeName,
    rules,
    today: businessDateOf(new Date(), config.timezone, settings.businessDayStartHour),
    calendarToday: businessDateOf(new Date(), config.timezone, 0),
    timezone: config.timezone,
    env: config.env,
    version: config.version,
    hasSyntheticData: synthetic?.exists ?? false,
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;

  const setCookie = (reply: import('fastify').FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: config.sessionTtlHours * 3600 * 4,
    });

  // 登录页使用：门店名称；非正式环境且存在演示数据时提示演示账号
  app.get('/api/public/info', async () => {
    const settings = await loadSettings(sql);
    const [synthetic] = await sql<{ exists: boolean }[]>`SELECT (EXISTS (SELECT 1 FROM members WHERE is_synthetic) OR EXISTS (SELECT 1 FROM materials WHERE is_synthetic)) AS exists`;
    return {
      storeName: settings.storeName,
      env: config.env,
      version: config.version,
      demoHint: config.env !== 'production' && (synthetic?.exists ?? false),
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = parse(LoginInput, req.body);
    checkLock(username);
    const rows = await sql<(Actor & { passwordHash: string; active: boolean })[]>`
      SELECT id, username, display_name, role, duties, must_change_password, password_hash, active
      FROM staff WHERE username = ${username}`;
    const staff = rows[0];
    const ok = staff ? await verifyPassword(password, staff.passwordHash) : false;
    if (!staff || !ok || !staff.active) {
      recordFailure(username);
      await writeAudit(sql, {
        staffId: staff?.id ?? null,
        action: 'login_failed',
        detail: { username, reason: !staff ? 'unknown_user' : !ok ? 'bad_password' : 'inactive' },
        ip: req.ip,
      });
      if (staff && ok && !staff.active) throw unauthorized('该账号已停用，请联系店主');
      throw unauthorized('账号或密码不正确');
    }
    failures.delete(username);
    const token = await createSession(sql, staff.id, config.sessionTtlHours, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    await sql`UPDATE staff SET last_login_at = now() WHERE id = ${staff.id}`;
    await writeAudit(sql, { staffId: staff.id, action: 'login', ip: req.ip });
    setCookie(reply, token);
    const actor: Actor = {
      id: staff.id,
      username: staff.username,
      displayName: staff.displayName,
      role: staff.role as Role,
      duties: (staff.duties ?? []) as Duty[],
      mustChangePassword: staff.mustChangePassword,
    };
    return buildSessionInfo(deps, actor);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await destroySession(sql, token);
    if (req.hasSession) await writeAudit(sql, { staffId: req.actor.id, action: 'logout', ip: req.ip });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: sessionOnly }, async (req) => buildSessionInfo(deps, req.actor));

  app.post('/api/auth/change-password', { preHandler: sessionOnly }, async (req) => {
    const { currentPassword, newPassword } = parse(ChangePasswordInput, req.body);
    const weak = checkPasswordStrength(newPassword);
    if (weak) throw badRequest(weak, { field: 'newPassword' });
    if (newPassword === currentPassword) throw badRequest('新密码不能与当前密码相同', { field: 'newPassword' });
    const [row] = await sql<{ passwordHash: string }[]>`SELECT password_hash FROM staff WHERE id = ${req.actor.id}`;
    if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
      throw badRequest('当前密码不正确', { field: 'currentPassword' });
    }
    const hash = await hashPassword(newPassword);
    await sql.begin(async (tx) => {
      await tx`UPDATE staff SET password_hash = ${hash}, must_change_password = false, updated_at = now() WHERE id = ${req.actor.id}`;
      await destroyStaffSessions(tx, req.actor.id, req.cookies[SESSION_COOKIE]);
      await writeAudit(tx, { staffId: req.actor.id, action: 'password_changed', ip: req.ip });
    });
    return buildSessionInfo(deps, { ...req.actor, mustChangePassword: false });
  });
}
