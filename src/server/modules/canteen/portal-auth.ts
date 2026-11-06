// 员工食堂 · 员工端的开通与登录（docs/CANTEEN.md 第 8 节）：开通码设密码、账号 + 密码登录、30 天会话。
// 账号可以是工号、自己登记的用户名或手机号（第二期，K13）。
//
// 员工端会话与系统账号的会话完全分开（表、Cookie 名、端口都不同）。锁：只锁那位员工一行（失败计数、开通、改密串行）。

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  ACTIVATION_CODE,
  AVATARS,
  normalizeActivationCode,
  normalizeEmpNo,
  normalizePhone,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PHONE,
  type CanteenRole,
} from '@shared/canteen';
import { hashPassword, verifyPassword } from '../../auth/password';
import type { Db, Sql, Tx } from '../../db';
import { AppError, badRequest, unauthorized, unprocessable } from '../../lib/errors';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';

export const CANTEEN_COOKIE = 'yuzu_canteen_sid';
/** 30 天不用重新登录，用着就顺延（K7） */
export const CANTEEN_SESSION_DAYS = 30;
/** 同一工号连续输错 5 次锁 15 分钟（K8） */
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface CanteenSessionEmployee {
  id: number;
  empNo: string;
  name: string;
  role: CanteenRole;
  avatar: string;
  departmentId: number | null;
  codeEpoch: number;
}

/** 同一来源 IP 10 分钟内最多失败 30 次（登录、开通、查开通码一起算；只记失败；进程内计数，K8） */
export class AttemptLimiter {
  private fails = new Map<string, number[]>();
  constructor(
    private max = 30,
    private windowMs = 10 * 60_000,
  ) {}
  private recent(key: string, now: number) {
    return (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }
  /** 失败太多次了就拦下（这一次不再试） */
  check(key: string, now = Date.now()) {
    if (this.recent(key, now).length >= this.max) throw new AppError(429, 'TOO_MANY_ATTEMPTS', '试错太多次了，请过 10 分钟再试');
  }
  fail(key: string, now = Date.now()) {
    this.fails.set(key, [...this.recent(key, now), now]);
    if (this.fails.size > 10_000) {
      for (const [k, v] of this.fails) if (!v.some((t) => now - t < this.windowMs)) this.fails.delete(k);
    }
  }
  /** 先占的一个名额没用上（这次没成）：还回去 */
  release(key: string, at: number) {
    const list = this.fails.get(key);
    const i = list?.lastIndexOf(at) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
  }
}

const TRIVIAL = new Set(['123456', '654321', '000000', '111111', '666666', '888888', '123123', '112233', 'abcdef', 'qwerty', 'password', 'abc123', '123456789', '12345678']);

/** 密码至少 6 位（K7）；太好猜的、和工号（或用户名、手机号）一样的不行 */
export function checkCanteenPassword(password: string, ...names: string[]): string | null {
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (password.length > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 位`;
  if (TRIVIAL.has(password.toLowerCase()) || /^(.)\1+$/.test(password) || names.some((n) => n && password.toUpperCase() === n.toUpperCase())) return '这个密码太好猜了，换一个吧';
  return null;
}

export async function createCanteenSession(db: Db, employeeId: number, meta: { ip?: string; userAgent?: string }): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db`
    INSERT INTO canteen_sessions (token_hash, employee_id, expires_at, ip, user_agent)
    VALUES (${hashToken(token)}, ${employeeId}, now() + make_interval(days => ${CANTEEN_SESSION_DAYS}), ${meta.ip ?? null}, ${meta.userAgent?.slice(0, 200) ?? null})`;
  return token;
}

/**
 * 校验会话：员工停用、会话过期都不认；有效时顺延（每小时最多写一次）。renewed 为 true 时调用方要把浏览器的 Cookie 也顺延，
 * 否则库里顺延了、浏览器还是在登录 30 天后丢掉 Cookie
 */
export async function resolveCanteenSession(db: Db, token: string): Promise<{ me: CanteenSessionEmployee; renewed: boolean } | null> {
  const [row] = await db<(CanteenSessionEmployee & { active: boolean; tokenHash: string; stale: boolean })[]>`
    SELECT s.token_hash, e.id, e.emp_no, e.name, e.role, e.avatar, e.department_id, e.code_epoch, e.active,
           s.last_seen_at < now() - interval '1 hour' AS stale
    FROM canteen_sessions s JOIN canteen_employees e ON e.id = s.employee_id
    WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()`;
  if (!row || !row.active) return null;
  if (row.stale) {
    await db`
      UPDATE canteen_sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => ${CANTEEN_SESSION_DAYS})
      WHERE token_hash = ${row.tokenHash}`;
    await db`UPDATE canteen_employees SET last_seen_at = now() WHERE id = ${row.id}`;
  }
  return {
    me: { id: row.id, empNo: row.empNo, name: row.name, role: row.role, avatar: row.avatar, departmentId: row.departmentId, codeEpoch: row.codeEpoch },
    renewed: row.stale,
  };
}

export async function destroyCanteenSession(db: Db, token: string): Promise<void> {
  await db`DELETE FROM canteen_sessions WHERE token_hash = ${hashToken(token)}`;
}

/** 扫开通卡片后先打个招呼：开通码对、没过期、员工在用，才告诉是谁 */
export async function lookupActivation(db: Db, rawCode: unknown): Promise<{ name: string; empNo: string; avatar: string }> {
  const code = normalizeActivationCode(parse(z.string('请输入开通码').max(20, '开通码不对'), rawCode));
  if (!ACTIVATION_CODE.test(code)) throw unprocessable('ACTIVATION_INVALID', '开通码不对：是卡片上的 8 位字母数字');
  const [e] = await db<{ name: string; empNo: string; avatar: string }[]>`
    SELECT name, emp_no, avatar FROM canteen_employees WHERE activation_code = ${code} AND activation_expires_at > now() AND active`;
  if (!e) throw unprocessable('ACTIVATION_INVALID', '开通码不对或已过期：请找管理员重新开通');
  return e;
}

const JoinInput = z.object({ code: z.string('请输入开通码').max(20), password: z.string('请设一个密码').max(200) });

/** 用开通码设密码：开通码用掉、登录 */
export async function joinWithActivation(sql: Sql, raw: unknown, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; employeeId: number }> {
  const input = parse(JoinInput, raw);
  const code = normalizeActivationCode(input.code);
  if (!ACTIVATION_CODE.test(code)) throw unprocessable('ACTIVATION_INVALID', '开通码不对：是卡片上的 8 位字母数字');
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [e] = await tx<{ id: number; empNo: string; ok: boolean }[]>`
      SELECT id, emp_no, (activation_expires_at > now() AND active) AS ok FROM canteen_employees WHERE activation_code = ${code} FOR UPDATE`;
    if (!e || !e.ok) throw unprocessable('ACTIVATION_INVALID', '开通码不对或已过期：请找管理员重新开通');
    const weak = checkCanteenPassword(input.password, e.empNo);
    if (weak) throw badRequest(weak);
    await tx`
      UPDATE canteen_employees SET password_hash = ${await hashPassword(input.password)}, activation_code = NULL, activation_expires_at = NULL,
             activated_at = now(), failed_logins = 0, locked_until = NULL, last_seen_at = now(), updated_at = now()
      WHERE id = ${e.id}`;
    return { token: await createCanteenSession(tx, e.id, meta), employeeId: e.id };
  });
}

const LoginInput = z
  .object({
    /** 工号、用户名或手机号 */
    account: z.string('请输入账号').max(40).optional(),
    /** 老版本的柚子饭堂只传工号 */
    empNo: z.string('请输入工号').max(40).optional(),
    password: z.string('请输入密码').max(200),
  })
  .refine((x) => (x.account ?? x.empNo ?? '').trim() !== '', '请输入账号');

/** 登录要用的那一行（已加锁） */
export interface LoginRow {
  id: number;
  active: boolean;
  passwordHash: string | null;
  failedLogins: number;
  lockedMinutes: number | null;
}

/**
 * 按账号找人并锁住那一行：像手机号的先按手机号（没有再当工号找，后台可能用了一串数字当工号）；
 * 否则先按用户名（不分大小写）、再按工号。用户名与工号在登记、加人时就不许撞（K13），撞了也是用户名优先。
 */
const LOGIN_COLS = (tx: Tx) => tx`
  id, active, password_hash, failed_logins,
  CASE WHEN locked_until > now() THEN ceil(extract(epoch FROM locked_until - now()) / 60)::int END AS locked_minutes`;

/** 只按手机号找人并锁住那一行（自己登记时核对「这个手机号已经有账号了没有」只看手机号，不当工号找） */
export async function findPhoneRow(tx: Tx, phone: string): Promise<LoginRow | undefined> {
  const [row] = await tx<LoginRow[]>`SELECT ${LOGIN_COLS(tx)} FROM canteen_employees WHERE phone = ${phone} FOR UPDATE`;
  return row;
}

export async function findLoginRow(tx: Tx, rawAccount: string): Promise<LoginRow | undefined> {
  const account = rawAccount.trim();
  const phone = normalizePhone(account);
  if (PHONE.test(phone)) {
    const byPhone = await findPhoneRow(tx, phone);
    if (byPhone) return byPhone;
  }
  const [row] = await tx<LoginRow[]>`
    SELECT ${LOGIN_COLS(tx)} FROM canteen_employees
    WHERE lower(username) = lower(${account}) OR emp_no = ${normalizeEmpNo(account)}
    ORDER BY (lower(username) = lower(${account})) IS TRUE DESC, id
    LIMIT 1 FOR UPDATE`;
  return row;
}

/**
 * 核对密码（调用方已锁住那一行）：输错 5 次锁 15 分钟；还没开通的提示用开通码。
 * 失败计数要提交，所以错误作为返回值交给调用方、在事务外抛。
 */
export async function verifyLoginRow(tx: Tx, e: LoginRow | undefined, password: string): Promise<{ error: AppError } | { ok: true }> {
  if (!e) return { error: unauthorized('账号或密码不对') };
  if (e.lockedMinutes) return { error: new AppError(429, 'ACCOUNT_LOCKED', `密码输错太多次了，请 ${e.lockedMinutes} 分钟后再试`) };
  if (!e.passwordHash) {
    return { error: e.active ? unprocessable('NOT_ACTIVATED', '还没开通：请扫开通卡片上的二维码，或点「我有开通码」') : unauthorized('账号或密码不对') };
  }
  if (!(await verifyPassword(password, e.passwordHash))) {
    const failed = e.failedLogins + 1;
    const lock = failed >= MAX_FAILURES;
    await tx`
      UPDATE canteen_employees SET failed_logins = ${lock ? 0 : failed},
             locked_until = CASE WHEN ${lock} THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE locked_until END
      WHERE id = ${e.id}`;
    return {
      error: lock
        ? new AppError(429, 'ACCOUNT_LOCKED', `密码输错 ${MAX_FAILURES} 次，锁 ${LOCK_MINUTES} 分钟；忘了密码请找管理员重新开通`)
        : unauthorized(`账号或密码不对（再错 ${MAX_FAILURES - failed} 次会锁 ${LOCK_MINUTES} 分钟）`),
    };
  }
  if (!e.active) return { error: new AppError(403, 'EMPLOYEE_INACTIVE', '这个账号已停用，有问题请找管理员') };
  await tx`UPDATE canteen_employees SET failed_logins = 0, locked_until = NULL, last_seen_at = now() WHERE id = ${e.id}`;
  return { ok: true };
}

/** 账号（工号、用户名或手机号）+ 密码登录：输错 5 次锁 15 分钟；还没开通的提示用开通码 */
export async function loginCanteen(sql: Sql, raw: unknown, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; employeeId: number }> {
  const input = parse(LoginInput, raw);
  const result = await sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const e = await findLoginRow(tx, input.account ?? input.empNo ?? '');
    const checked = await verifyLoginRow(tx, e, input.password);
    if ('error' in checked) return checked;
    return { token: await createCanteenSession(tx, e!.id, meta), employeeId: e!.id };
  });
  // 失败计数要提交，所以错误在事务外抛
  if ('error' in result) throw result.error;
  return result;
}

const PasswordInput = z.object({ oldPassword: z.string('请输入原密码').max(200), newPassword: z.string('请输入新密码').max(200) });

/** 改密码：码钥匙换新（旧手机上的饭卡码作废），别的手机上的登录退出，这台继续用 */
export async function changeCanteenPassword(sql: Sql, me: CanteenSessionEmployee, token: string, raw: unknown): Promise<void> {
  const input = parse(PasswordInput, raw);
  await sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [e] = await tx<{ passwordHash: string | null; username: string | null; phone: string | null }[]>`
      SELECT password_hash, username, phone FROM canteen_employees WHERE id = ${me.id} AND active FOR UPDATE`;
    if (!e?.passwordHash || !(await verifyPassword(input.oldPassword, e.passwordHash))) throw unprocessable('WRONG_PASSWORD', '原密码不对');
    const weak = checkCanteenPassword(input.newPassword, me.empNo, e.username ?? '', e.phone ?? '');
    if (weak) throw badRequest(weak);
    await tx`
      UPDATE canteen_employees SET password_hash = ${await hashPassword(input.newPassword)}, code_epoch = code_epoch + 1, updated_at = now()
      WHERE id = ${me.id}`;
    await tx`DELETE FROM canteen_sessions WHERE employee_id = ${me.id} AND token_hash <> ${hashToken(token)}`;
  });
}

/** 换头像（从给定的表情里选） */
export async function setCanteenAvatar(db: Db, me: CanteenSessionEmployee, raw: unknown): Promise<string> {
  const { avatar } = parse(z.object({ avatar: z.enum(AVATARS, '从给的头像里选一个') }), raw);
  await db`UPDATE canteen_employees SET avatar = ${avatar} WHERE id = ${me.id}`;
  return avatar;
}
