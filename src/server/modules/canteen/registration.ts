// 员工食堂 · 自己登记（docs/CANTEEN.md 第 14 节，店主 2026-11-06 / 11-07，K12–K14）：
// 员工打开柚子饭堂（扫后台的注册二维码、海报，或点员工群里的链接），看完柚子的开场，在「新同事登记」填用户名、手机号、密码，
// 账号马上开好（普通员工）并登录。店主 2026-11-07 定：不要注册口令；有人离职在名单里停用他就行。
//
// 开关存在 settings 的 canteen_registration 一项（开没开、改了几次 rev）：没存过时关着，管理员在后台打开才能登记；
// 开关取规则锁串行、带上页面看到的 rev（与「修改带版本号、对不上拒绝」一样），回复没收到时再点一次、或者晚到的那一下，都不会把开关改回去。
// 登记的锁：同一个手机号的那一行（有的话，FOR UPDATE，与登录同一把）；新建前取登录名的咨询锁再核对不撞，最后靠用户名、手机号、工号的唯一索引兜底。

import { z } from 'zod';
import {
  defaultAvatar,
  normalizePhone,
  normalizeUsername,
  PHONE,
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
import { checkCanteenPassword, createCanteenSession, findPhoneRow, lockLoginNames, verifyLoginRow } from './portal-auth';
import { loadCanteenSettings } from './settings';

const KEY = 'canteen_registration';

interface Stored {
  enabled: boolean;
  /** 改了几次（开关一次加一）；没存过的算 0 */
  rev: number;
}

/** 读自己登记的开关：没存过时关着。第二期里存过的口令不再用（店主 2026-11-07 不要注册口令），下次保存时去掉 */
export async function loadRegistration(db: Db): Promise<Stored> {
  const [row] = await db<{ value: Partial<Stored> | null }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  const v = row?.value ?? {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : false,
    rev: Number.isInteger(v.rev) && (v.rev as number) >= 0 ? (v.rev as number) : 0,
  };
}

const registrationChanged = () => conflict('REGISTRATION_CHANGED', '自己登记的开关刚改过（可能是刚才那一下已经办好了）：看看现在的再说');

/** 管理后台看的注册二维码：开没开、链接（没填员工入口地址时没有链接）、自己登记的人数 */
export async function registrationView(db: Db): Promise<CanteenRegistration> {
  const reg = await loadRegistration(db);
  const settings = await loadCanteenSettings(db);
  const [n] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_employees WHERE source = 'self' AND active`;
  return {
    enabled: reg.enabled,
    link: settings.portalUrl ? registrationLink(settings.portalUrl) : null,
    selfRegistered: n!.n,
    rev: reg.rev,
  };
}

/** 在规则锁里改开关并记审计；change 返回 null 表示不用改 */
async function saveRegistration(sql: Sql, ctx: OpContext, change: (before: Stored) => Stored | null): Promise<void> {
  await sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockSettings(tx);
    const before = await loadRegistration(tx);
    const after = change(before);
    if (!after) return;
    await tx`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${KEY}, ${tx.json(after as never)}, now(), ${ctx.actor.id})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'settings_updated',
      targetType: 'settings',
      detail: { key: KEY, enabledBefore: before.enabled, enabledAfter: after.enabled },
      ip: ctx.ip,
    });
  });
}

const Rev = z.number('页面上的注册设置太旧了：刷新再改').int().min(0);

/** 开关自己登记：已经是要的样子就不用改；不然要带上看到的 rev，对不上拒绝（晚到的那一下不会把开关改回去） */
export async function setRegistrationEnabled(sql: Sql, raw: unknown, ctx: OpContext): Promise<CanteenRegistration> {
  const { enabled, rev } = parse(z.object({ enabled: z.boolean('开还是关？'), rev: Rev }), raw);
  await saveRegistration(sql, ctx, (before) => {
    if (before.enabled === enabled) return null;
    if (before.rev !== rev) throw registrationChanged();
    return { enabled, rev: before.rev + 1 };
  });
  return registrationView(sql);
}

/** 员工端：现在能不能自己登记 */
export async function registerInfo(db: Db): Promise<RegisterInfo> {
  return { open: (await loadRegistration(db)).enabled };
}

// 不要注册口令（店主 2026-11-07）：以前的页面多带的 code 不再看（zod 默认去掉没写的字段）
const RegisterInput = z.object({
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
 * 自己登记：开着自己登记，用户名与手机号都没人用 → 开好账号（普通员工）并登录。
 * 同一个手机号已经有账号时：密码对的当作登录（回复没收到、原样再点不会报错），不对的提示去登录（按登录一样记失败）。
 */
export async function registerEmployee(
  sql: Sql,
  raw: unknown,
  meta: { ip?: string; userAgent?: string },
  /** false：这个来源 IP 一小时的名额用完了——只认「同一个手机号再登记、密码对」（当作登录），不开新账号 */
  opts: { allowCreate: boolean } = { allowCreate: true },
): Promise<{ token: string; employeeId: number; created: boolean }> {
  const input = parse(RegisterInput, raw);
  const username = normalizeUsername(input.username);
  const phone = normalizePhone(input.phone);
  if (!(await loadRegistration(sql)).enabled) throw unprocessable('REGISTRATION_CLOSED', '饭堂现在没开放自己登记：请找管理员');
  const badName = usernameProblem(username);
  if (badName) throw badRequest(badName);
  if (!PHONE.test(phone)) throw badRequest('手机号写 11 位，例如 13800138000');

  const result = await sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 这个手机号已经登记过：当作登录（只按手机号找：后台有人用一串数字当工号，也不会被当成这个手机号）
    const existing = await findPhoneRow(tx, phone);
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
    if (!opts.allowCreate) throw new AppError(429, 'TOO_MANY_REGISTRATIONS', '这一会儿登记的人太多了，请过一会儿再试，或者找管理员');
    const weak = checkCanteenPassword(input.password, username, phone);
    if (weak) throw badRequest(weak);
    // 用户名不能和别人的用户名、工号一样（登录时都认，K13）：先取登录名锁，与后台加人、改工号串行
    await lockLoginNames(tx, [username]);
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
