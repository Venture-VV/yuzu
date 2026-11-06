// 员工食堂 · 自己登记（docs/CANTEEN.md 第 14 节，店主 2026-11-06，K12–K14）：
// 管理员在后台生成注册口令（注册二维码、海报上的链接里就带着），员工在开场引导的最后填用户名、手机号、密码，账号马上开好并登录。
//
// 注册口令存在 settings 的 canteen_registration 一项（开没开、口令）；换口令、开关都取规则锁串行，审计里不记口令本身。
// 登记的锁：同一个手机号的那一行（有的话，FOR UPDATE，与登录同一把）；新建靠用户名、手机号、工号的唯一索引兜底。

import { randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ACTIVATION_ALPHABET,
  defaultAvatar,
  normalizeActivationCode,
  normalizePhone,
  normalizeUsername,
  PHONE,
  REG_CODE,
  registrationLink,
  usernameProblem,
  type CanteenRegistration,
  type RegisterInfo,
} from '@shared/canteen';
import { hashPassword } from '../../auth/password';
import { isUniqueViolation, type Db, type Sql, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { OpContext } from '../../lib/context';
import { AppError, badRequest, conflict, unprocessable } from '../../lib/errors';
import { lockSettings } from '../../lib/rule-settings';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { checkCanteenPassword, createCanteenSession, findLoginRow, verifyLoginRow } from './portal-auth';
import { loadCanteenSettings } from './settings';

const KEY = 'canteen_registration';

interface Stored {
  enabled: boolean;
  code: string | null;
}

/** 读注册设置：没存过时开着、还没有口令（管理员生成注册二维码以后才能登记） */
export async function loadRegistration(db: Db): Promise<Stored> {
  const [row] = await db<{ value: Partial<Stored> | null }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  const v = row?.value ?? {};
  return { enabled: typeof v.enabled === 'boolean' ? v.enabled : true, code: typeof v.code === 'string' && REG_CODE.test(v.code) ? v.code : null };
}

/** 管理后台看的注册二维码：口令、链接（没填员工入口地址时没有链接）、自己登记的人数 */
export async function registrationView(db: Db): Promise<CanteenRegistration> {
  const reg = await loadRegistration(db);
  const settings = await loadCanteenSettings(db);
  const [n] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_employees WHERE source = 'self' AND active`;
  return {
    enabled: reg.enabled,
    code: reg.code,
    link: reg.code && settings.portalUrl ? registrationLink(settings.portalUrl, reg.code) : null,
    selfRegistered: n!.n,
  };
}

const newCode = () => Array.from({ length: 8 }, () => ACTIVATION_ALPHABET[randomInt(ACTIVATION_ALPHABET.length)]).join('');

/** 在规则锁里改注册设置并记审计（审计只记开关与有没有换口令，不记口令） */
async function saveRegistration(sql: Sql, ctx: OpContext, change: (before: Stored) => Stored): Promise<void> {
  await sql.begin(async (tx) => {
    await lockSettings(tx);
    const before = await loadRegistration(tx);
    const after = change(before);
    await tx`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${KEY}, ${tx.json(after as never)}, now(), ${ctx.actor.id})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'settings_updated',
      targetType: 'settings',
      detail: { key: KEY, enabledBefore: before.enabled, enabledAfter: after.enabled, codeChanged: before.code !== after.code },
      ip: ctx.ip,
    });
  });
}

/** 开关自己登记 */
export async function setRegistrationEnabled(sql: Sql, raw: unknown, ctx: OpContext): Promise<CanteenRegistration> {
  const { enabled } = parse(z.object({ enabled: z.boolean('开还是关？') }), raw);
  await saveRegistration(sql, ctx, (before) => ({ ...before, enabled }));
  return registrationView(sql);
}

/** 生成（或换）注册口令：旧的二维码、链接马上作废；生成时顺便打开自己登记 */
export async function rotateRegistrationCode(sql: Sql, ctx: OpContext): Promise<CanteenRegistration> {
  await saveRegistration(sql, ctx, (before) => {
    let code = newCode();
    while (code === before.code) code = newCode();
    return { enabled: before.code === null ? true : before.enabled, code };
  });
  return registrationView(sql);
}

const sameCode = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** 员工端：现在能不能自己登记、带来的口令对不对。口令不对时抛错（调用方按失败限次） */
export async function registerInfo(db: Db, rawCode: unknown): Promise<RegisterInfo> {
  const reg = await loadRegistration(db);
  const open = reg.enabled && reg.code !== null;
  if (rawCode === undefined || rawCode === '') return { open, codeOk: null };
  const code = normalizeActivationCode(parse(z.string().max(20, '注册口令不对'), rawCode));
  if (!open) return { open, codeOk: false };
  if (!sameCode(code, reg.code!)) throw unprocessable('REGISTRATION_CODE_INVALID', '注册口令不对：请扫饭堂里的注册二维码，或问管理员要');
  return { open, codeOk: true };
}

const RegisterInput = z.object({
  code: z.string('请输入注册口令').max(20, '注册口令不对'),
  username: z.string('请写用户名').max(40, '用户名最多 16 个字'),
  phone: z.string('请写手机号').max(20, '手机号写 11 位'),
  password: z.string('请设一个密码').max(200),
});

const maskPhone = (p: string) => `${p.slice(0, 3)}****${p.slice(7)}`;

/** 自己登记的工号：ZC 加编号（ZC0007）；撞了已有的工号就在后面加 -2、-3 */
async function insertSelfEmployee(tx: Tx, input: { username: string; phone: string; passwordHash: string }): Promise<{ id: number; empNo: string }> {
  const [seq] = await tx<{ id: number }[]>`SELECT nextval(pg_get_serial_sequence('canteen_employees', 'id'))::int AS id`;
  const id = seq!.id;
  const base = `ZC${String(id).padStart(4, '0')}`;
  for (let i = 1; ; i++) {
    const empNo = i === 1 ? base : `${base}-${i}`;
    try {
      await tx.savepoint(async (sp) => {
        await sp`
          INSERT INTO canteen_employees (id, emp_no, name, username, phone, source, role, avatar, password_hash, activated_at, last_seen_at)
          VALUES (${id}, ${empNo}, ${input.username}, ${input.username}, ${input.phone}, 'self', 'staff', ${defaultAvatar(id)},
                  ${input.passwordHash}, now(), now())`;
      });
      return { id, empNo };
    } catch (error) {
      if (isUniqueViolation(error, 'canteen_employees_emp_no_key') && i < 9) continue;
      if (isUniqueViolation(error, 'canteen_employees_username_key')) {
        throw conflict('USERNAME_TAKEN', '这个用户名有人用了：换一个，或者加点区别（例如 林小雨2）');
      }
      if (isUniqueViolation(error, 'canteen_employees_phone_key')) throw conflict('PHONE_TAKEN', '这个手机号刚登记过了：直接登录就好');
      throw error;
    }
  }
}

/**
 * 自己登记：口令对、开着自己登记，用户名与手机号都没人用 → 开好账号（普通员工）并登录。
 * 同一个手机号已经有账号时：密码对的当作登录（回复没收到、原样再点不会报错），不对的提示去登录（按登录一样记失败）。
 */
export async function registerEmployee(
  sql: Sql,
  raw: unknown,
  meta: { ip?: string; userAgent?: string },
): Promise<{ token: string; employeeId: number; created: boolean }> {
  const input = parse(RegisterInput, raw);
  const code = normalizeActivationCode(input.code);
  const username = normalizeUsername(input.username);
  const phone = normalizePhone(input.phone);
  const reg = await loadRegistration(sql);
  if (!reg.enabled || !reg.code) throw unprocessable('REGISTRATION_CLOSED', '饭堂现在没开放自己登记：请找管理员');
  if (!sameCode(code, reg.code)) throw unprocessable('REGISTRATION_CODE_INVALID', '注册口令不对：请扫饭堂里的注册二维码，或问管理员要');
  const badName = usernameProblem(username);
  if (badName) throw badRequest(badName);
  if (!PHONE.test(phone)) throw badRequest('手机号写 11 位，例如 13800138000');

  const result = await sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 这个手机号已经登记过：当作登录
    const existing = await findLoginRow(tx, phone);
    if (existing) {
      const checked = await verifyLoginRow(tx, existing, input.password);
      if ('error' in checked) {
        const e = checked.error;
        return {
          error:
            e.code === 'ACCOUNT_LOCKED' || e.code === 'EMPLOYEE_INACTIVE' || e.code === 'NOT_ACTIVATED'
              ? e
              : new AppError(409, 'PHONE_TAKEN', '这个手机号已经登记过了：直接登录就好；忘了密码请找管理员「重新开通」'),
        };
      }
      return { token: await createCanteenSession(tx, existing.id, meta), employeeId: existing.id, created: false };
    }
    const weak = checkCanteenPassword(input.password, username, phone);
    if (weak) throw badRequest(weak);
    // 用户名不能和别人的用户名、工号一样（登录时都认，K13）
    const [taken] = await tx<{ id: number }[]>`
      SELECT id FROM canteen_employees WHERE lower(username) = lower(${username}) OR emp_no = upper(${username}) LIMIT 1`;
    if (taken) throw conflict('USERNAME_TAKEN', '这个用户名有人用了：换一个，或者加点区别（例如 林小雨2）');
    const made = await insertSelfEmployee(tx, { username, phone, passwordHash: await hashPassword(input.password) });
    await writeAudit(tx, {
      staffId: null,
      action: 'canteen_employee',
      targetType: 'canteen_employee',
      targetId: made.id,
      detail: { op: 'self_register', empNo: made.empNo, username, phone: maskPhone(phone) },
      ip: meta.ip,
    });
    return { token: await createCanteenSession(tx, made.id, meta), employeeId: made.id, created: true };
  });
  // 失败计数要提交，所以错误在事务外抛
  if ('error' in result) throw result.error;
  return result;
}
