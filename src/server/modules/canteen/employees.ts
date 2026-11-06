// 员工食堂 · 员工名单（docs/CANTEEN.md 第 8 节）：管理员在 yuzu 后台维护——单个加、粘贴一批加、修改与停用、
// 重新开通（新开通码、旧手机的登录与饭卡码马上失效）、打印开通卡片。员工自己登记的（第二期）见 registration.ts，
// 在这里一样能改工号、部门、角色或停用（用户名、手机号是员工自己填的，后台只看）。
//
// 写操作都设计成「原样重试不会重复」：新建按工号去重（内容一样的返回原来那位），修改带版本号（内容一样的重提照样成功），
// 重新开通带操作编号（同一编号返回同一张开通码）。锁：只锁那位员工一行（新建靠工号的唯一约束兜底）。

import { randomInt } from 'node:crypto';
import { z } from 'zod';
import {
  ACTIVATION_ALPHABET,
  ACTIVATION_DAYS,
  CANTEEN_ROLE_LABELS,
  CANTEEN_ROLES,
  defaultAvatar,
  EMP_NO,
  normalizeEmpNo,
  type ActivationCard,
  type BatchPreviewRow,
  type CanteenEmployeeRow,
  type CanteenRole,
  type CanteenSettings,
} from '@shared/canteen';
import { isUniqueViolation, type Db, type Sql, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { OpContext } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { lockLoginNames } from './portal-auth';
import { loadCanteenSettings } from './settings';

const EmpNo = z
  .string('请写工号')
  .trim()
  .min(1, '请写工号')
  .transform(normalizeEmpNo)
  .pipe(z.string().regex(EMP_NO, '工号只能是字母、数字和短横线，1–16 位，例如 A012'));
const Name = z.string('请写姓名').trim().min(1, '请写姓名').max(16, '姓名最多 16 个字');

const CreateInput = z.object({
  empNo: EmpNo,
  name: Name,
  departmentId: z.number().int().positive('部门不正确').nullable(),
  role: z.enum(CANTEEN_ROLES, '角色不正确'),
});

const UpdateInput = CreateInput.extend({
  version: z.number().int().positive('版本号不正确'),
  active: z.boolean(),
});

const ActivationInput = z.object({ clientKey: z.uuid('操作编号不正确') });

export const newActivationCode = () => Array.from({ length: 8 }, () => ACTIVATION_ALPHABET[randomInt(ACTIVATION_ALPHABET.length)]).join('');

const ROW_SELECT = (db: Db) => db`
  SELECT e.id, e.emp_no, e.name, e.username, e.phone, e.source, e.department_id, coalesce(d.name, '') AS department, e.role, e.avatar, e.active,
         e.password_hash IS NOT NULL AS activated, e.activated_at,
         (e.activation_code IS NOT NULL AND e.activation_expires_at > now()) AS activation_pending,
         e.activation_expires_at, e.last_seen_at, e.version, e.created_at
  FROM canteen_employees e LEFT JOIN departments d ON d.id = e.department_id`;

export async function listEmployees(db: Db): Promise<CanteenEmployeeRow[]> {
  return db<CanteenEmployeeRow[]>`${ROW_SELECT(db)} ORDER BY e.active DESC, e.emp_no`;
}

export async function employeeRow(db: Db, id: number): Promise<CanteenEmployeeRow> {
  const [row] = await db<CanteenEmployeeRow[]>`${ROW_SELECT(db)} WHERE e.id = ${id}`;
  if (!row) throw notFound('没有这位员工');
  return row;
}

/** 厨师、负责人必须在食堂部门（K10）；部门要存在、在用 */
async function checkDepartment(db: Db, settings: CanteenSettings, role: CanteenRole, departmentId: number | null) {
  if (departmentId !== null) {
    const [d] = await db<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${departmentId}`;
    if (!d) throw badRequest('没有这个部门');
    if (!d.active) throw unprocessable('DEPARTMENT_INACTIVE', '这个部门已停用');
  }
  if (role !== 'staff') {
    if (settings.departmentId === null) throw unprocessable('CANTEEN_DEPARTMENT_UNSET', '先在「设置」里选好食堂部门，再安排厨师和负责人');
    if (departmentId !== settings.departmentId) {
      throw unprocessable('CANTEEN_ROLE_DEPARTMENT', `${CANTEEN_ROLE_LABELS[role]}要在食堂部门里：把部门改成食堂部门再保存`);
    }
  }
}

/** 工号不能和别人自己登记的用户名一样（登录时工号、用户名都认，K13）。调用前先取这个工号的登录名锁（lockLoginNames） */
async function checkEmpNoFree(db: Db, empNo: string, selfId: number | null) {
  const [hit] = await db<{ name: string }[]>`
    SELECT name FROM canteen_employees WHERE lower(username) = lower(${empNo}) AND id IS DISTINCT FROM ${selfId} LIMIT 1`;
  if (hit) throw conflict('EMP_NO_TAKEN', `工号 ${empNo} 和 ${hit.name} 的用户名一样了，换一个工号`);
}

/** 新开通码（与已有的撞了就再换一个） */
async function setNewActivation(tx: Tx, id: number, clientKey: string | null) {
  for (let i = 0; ; i++) {
    const code = newActivationCode();
    try {
      await tx.savepoint(async (sp) => {
        await sp`
          UPDATE canteen_employees SET activation_code = ${code},
                 activation_expires_at = now() + make_interval(days => ${ACTIVATION_DAYS}), activation_key = ${clientKey}
          WHERE id = ${id}`;
      });
      return;
    } catch (error) {
      if (i >= 5 || !isUniqueViolation(error)) throw error;
    }
  }
}

/** 加一位：工号已经有了且姓名、部门、角色都一样时返回原来那位（原样重试不会重复加），不一样的拒绝 */
export async function createEmployee(sql: Sql, raw: unknown, ctx: OpContext): Promise<{ employee: CanteenEmployeeRow; created: boolean }> {
  const input = parse(CreateInput, raw);
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const settings = await loadCanteenSettings(tx);
    await checkDepartment(tx, settings, input.role, input.departmentId);
    await lockLoginNames(tx, [input.empNo]);
    await checkEmpNoFree(tx, input.empNo, null);
    const id = await insertEmployee(tx, input, ctx);
    if (id === null) {
      const [same] = await tx<{ id: number; name: string; departmentId: number | null; role: string }[]>`
        SELECT id, name, department_id, role FROM canteen_employees WHERE emp_no = ${input.empNo}`;
      if (same && same.name === input.name && same.departmentId === input.departmentId && same.role === input.role) {
        return { employee: await employeeRow(tx, same.id), created: false };
      }
      throw conflict('EMP_NO_TAKEN', `工号 ${input.empNo} 已经有了${same ? `（${same.name}）` : ''}`);
    }
    return { employee: await employeeRow(tx, id), created: true };
  });
}

/** 插入一位并发开通码；工号撞了返回 null */
async function insertEmployee(tx: Tx, input: z.infer<typeof CreateInput>, ctx: OpContext): Promise<number | null> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO canteen_employees (emp_no, name, department_id, role, avatar, created_by)
    VALUES (${input.empNo}, ${input.name}, ${input.departmentId}, ${input.role}, '🍊', ${ctx.actor.id})
    ON CONFLICT (emp_no) DO NOTHING RETURNING id`;
  if (!row) return null;
  await tx`UPDATE canteen_employees SET avatar = ${defaultAvatar(row.id)} WHERE id = ${row.id}`;
  await setNewActivation(tx, row.id, null);
  await writeAudit(tx, {
    staffId: ctx.actor.id,
    action: 'canteen_employee',
    targetType: 'canteen_employee',
    targetId: row.id,
    detail: { op: 'create', empNo: input.empNo, name: input.name, role: input.role, departmentId: input.departmentId },
    ip: ctx.ip,
  });
  return row.id;
}

const BatchInput = z.object({
  text: z.string('请粘贴名单').max(20_000, '一次最多粘贴 20,000 个字'),
  apply: z.boolean().default(false),
});

/**
 * 粘贴一批：一行一位「工号 姓名 部门」，用空格、Tab 或逗号隔开，部门可以不写（按名字对上已有的部门）。
 * 都加成普通员工（厨师、负责人单独改）。先预览；apply 时整批一起加（有一行有问题就一行都不加），已经有了、一样的跳过。
 */
export async function batchEmployees(sql: Sql, raw: unknown, ctx: OpContext): Promise<{ rows: BatchPreviewRow[]; created: number }> {
  const input = parse(BatchInput, raw);
  const lines = input.text.split(/\r?\n/).map((l, i) => ({ line: i + 1, text: l.trim() })).filter((l) => l.text && !l.text.startsWith('#'));
  if (!lines.length) throw badRequest('没有读到名单：一行一位，「工号 姓名 部门」');
  if (lines.length > 500) throw badRequest('一次最多 500 位');
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const departments = await tx<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM departments`;
    const existing = new Map(
      (await tx<{ empNo: string; name: string; departmentId: number | null }[]>`SELECT emp_no, name, department_id FROM canteen_employees`).map((e) => [e.empNo, e]),
    );
    const usernames = new Map(
      (await tx<{ username: string; name: string }[]>`SELECT username, name FROM canteen_employees WHERE username IS NOT NULL`).map((e) => [e.username.toUpperCase(), e.name]),
    );
    const seen = new Set<string>();
    const rows: BatchPreviewRow[] = lines.map(({ line, text }) => {
      const parts = text.split(/[\s,，\t]+/).filter(Boolean);
      const empNo = normalizeEmpNo(parts[0] ?? '');
      const name = parts[1] ?? '';
      const deptName = parts.slice(2).join(' ');
      const row: BatchPreviewRow = { line, empNo, name, department: deptName, departmentId: null, status: 'new', message: '' };
      const bad = (message: string): BatchPreviewRow => ({ ...row, status: 'error', message });
      if (!EMP_NO.test(empNo)) return bad('工号只能是字母、数字和短横线，1–16 位');
      if (!name || name.length > 16) return bad('姓名要有，最多 16 个字');
      if (deptName) {
        const d = departments.find((x) => x.name === deptName);
        if (!d) return bad(`没有「${deptName}」这个部门`);
        if (!d.active) return bad(`部门「${deptName}」已停用`);
        row.departmentId = d.id;
      }
      if (seen.has(empNo)) return bad('这一批里工号重复了');
      if (usernames.has(empNo)) return bad(`工号和 ${usernames.get(empNo)} 的用户名一样了`);
      seen.add(empNo);
      const old = existing.get(empNo);
      if (old) {
        return old.name === name && old.departmentId === row.departmentId
          ? { ...row, status: 'same', message: '已经有了，跳过' }
          : bad(`工号已经有了（${old.name}）`);
      }
      return row;
    });
    if (!input.apply) return { rows, created: 0 };
    const errors = rows.filter((r) => r.status === 'error');
    if (errors.length) throw unprocessable('BATCH_HAS_ERRORS', `有 ${errors.length} 行有问题，改好再加（一行都没加）`, { lines: errors.map((r) => r.line) });
    let created = 0;
    const fresh = rows.filter((x) => x.status === 'new');
    // 取好这一批工号的登录名锁以后再核对一次（预览之后有人登记了同名的用户名）
    await lockLoginNames(tx, fresh.map((r) => r.empNo));
    for (const r of fresh) await checkEmpNoFree(tx, r.empNo, null);
    for (const r of fresh) {
      const id = await insertEmployee(tx, { empNo: r.empNo, name: r.name, departmentId: r.departmentId, role: 'staff' }, ctx);
      if (id === null) throw conflict('EMP_NO_TAKEN', `工号 ${r.empNo} 刚被别人加了，请重新预览`);
      created++;
    }
    return { rows, created };
  });
}

/**
 * 修改（含停用、启用）：带打开时的版本号；版本对不上、但内容和现在一样的（原样重试）照样成功。
 * 停用时清掉开通码、码钥匙版本加一、删掉员工端会话：旧手机马上扫不进、也登录不了。
 */
export async function updateEmployee(sql: Sql, id: number, raw: unknown, ctx: OpContext): Promise<CanteenEmployeeRow> {
  const input = parse(UpdateInput, raw);
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [cur] = await tx<{ empNo: string; name: string; departmentId: number | null; role: CanteenRole; active: boolean; version: number }[]>`
      SELECT emp_no, name, department_id, role, active, version FROM canteen_employees WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('没有这位员工');
    const same = cur.empNo === input.empNo && cur.name === input.name && cur.departmentId === input.departmentId && cur.role === input.role && cur.active === input.active;
    if (same) return employeeRow(tx, id);
    if (cur.version !== input.version) throw conflict('VERSION_CHANGED', '这位员工刚被别人改过，刷新后再改');
    if (input.active) await checkDepartment(tx, await loadCanteenSettings(tx), input.role, input.departmentId);
    if (input.empNo !== cur.empNo) {
      await lockLoginNames(tx, [input.empNo]);
      await checkEmpNoFree(tx, input.empNo, id);
    }
    const deactivate = cur.active && !input.active;
    try {
      await tx`
        UPDATE canteen_employees SET
          emp_no = ${input.empNo}, name = ${input.name}, department_id = ${input.departmentId}, role = ${input.role}, active = ${input.active},
          activation_code = CASE WHEN ${deactivate} THEN NULL ELSE activation_code END,
          activation_expires_at = CASE WHEN ${deactivate} THEN NULL ELSE activation_expires_at END,
          code_epoch = code_epoch + CASE WHEN ${deactivate} THEN 1 ELSE 0 END,
          version = version + 1, updated_at = now()
        WHERE id = ${id}`;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('EMP_NO_TAKEN', `工号 ${input.empNo} 已经有别人用了`);
      throw error;
    }
    if (deactivate) await tx`DELETE FROM canteen_sessions WHERE employee_id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'canteen_employee',
      targetType: 'canteen_employee',
      targetId: id,
      detail: { op: deactivate ? 'deactivate' : 'update', before: cur, after: { ...input, version: undefined } },
      ip: ctx.ip,
    });
    return employeeRow(tx, id);
  });
}

/**
 * 重新开通（忘了密码、换手机、开通码过期）：新开通码 7 天有效；清掉密码、码钥匙版本加一、删掉员工端会话。
 * 同一个操作编号重提返回同一张开通码。
 */
export async function reissueActivation(sql: Sql, id: number, raw: unknown, ctx: OpContext): Promise<ActivationCard> {
  const { clientKey } = parse(ActivationInput, raw);
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [cur] = await tx<{ active: boolean; activationKey: string | null; pending: boolean }[]>`
      SELECT active, activation_key, (activation_code IS NOT NULL AND activation_expires_at > now()) AS pending
      FROM canteen_employees WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('没有这位员工');
    if (!cur.active) throw unprocessable('EMPLOYEE_INACTIVE', '这位员工已停用：先启用再开通');
    if (cur.activationKey === clientKey && cur.pending) return (await activationCards(tx, [id]))[0]!;
    await tx`
      UPDATE canteen_employees SET password_hash = NULL, activated_at = NULL, code_epoch = code_epoch + 1,
             failed_logins = 0, locked_until = NULL, version = version + 1, updated_at = now()
      WHERE id = ${id}`;
    await setNewActivation(tx, id, clientKey);
    await tx`DELETE FROM canteen_sessions WHERE employee_id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'canteen_employee', targetType: 'canteen_employee', targetId: id, detail: { op: 'reissue' }, ip: ctx.ip });
    return (await activationCards(tx, [id]))[0]!;
  });
}

/** 开通卡片：给定的几位里，有没用掉、没过期的开通码的（不给编号时为全部） */
export async function activationCards(db: Db, ids: number[] | null): Promise<ActivationCard[]> {
  return db<ActivationCard[]>`
    SELECT e.id AS employee_id, e.emp_no, e.name, coalesce(d.name, '') AS department, e.avatar,
           e.activation_code AS code, e.activation_expires_at AS expires_at
    FROM canteen_employees e LEFT JOIN departments d ON d.id = e.department_id
    WHERE e.active AND e.activation_code IS NOT NULL AND e.activation_expires_at > now()
      ${ids ? db`AND e.id = ANY(${ids})` : db``}
    ORDER BY e.emp_no`;
}
