import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DUTIES, ROLES, dutyConflict, type Duty, type Role } from '@shared/permissions';
import type { StaffRecord } from '@shared/types';
import { isForeignKeyViolation, isUniqueViolation, type Db } from '../db';
import { guard } from '../auth/guard';
import { checkPasswordStrength, generateTempPassword, hashPassword } from '../auth/password';
import { destroyStaffSessions } from '../auth/session';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]{2,32}$/, '账号需为 2–32 位小写字母、数字或 _ . -');

const CreateInput = z.object({
  username,
  displayName: z.string().trim().min(1, '请填写姓名').max(32, '姓名最多 32 个字'),
  role: z.enum(ROLES, '请选择岗位'),
  /** 库存与采购职责，可叠加；店主自动拥有全部 */
  duties: z.array(z.enum(DUTIES)).max(DUTIES.length).default([]),
  /** 所属部门（v0.7.8：部门申购只能给自己的部门提需求单） */
  departmentId: z.number().int().positive().nullable().default(null),
  /** 不填则自动生成临时密码；员工首次登录必须修改 */
  password: z.string().optional(),
});

const UpdateInput = z.object({
  displayName: z.string().trim().min(1, '请填写姓名').max(32, '姓名最多 32 个字'),
  role: z.enum(ROLES, '请选择岗位'),
  duties: z.array(z.enum(DUTIES)).max(DUTIES.length).default([]),
  /** 不传保持原样，传 null 清空 */
  departmentId: z.number().int().positive().nullable().optional(),
  active: z.boolean(),
});

export async function listStaff(db: Db): Promise<StaffRecord[]> {
  return db<StaffRecord[]>`
    SELECT s.id, s.username, s.display_name, s.role, s.duties, s.department_id, d.name AS department_name, s.active, s.must_change_password,
           s.last_login_at, s.created_at
    FROM staff s LEFT JOIN departments d ON d.id = s.department_id
    -- 系统账号（小程序线上收款的经办人，v0.7.26）不出现在员工名单里
    WHERE NOT s.system
    ORDER BY s.active DESC, (s.role = 'owner') DESC, s.id`;
}

const uniqueDuties = (duties: Duty[] = []) => [...new Set(duties)].sort();

/** 分岗不兼任（#17，v0.7.12）：仓库、采购、部门、财务（含成本）、负责人五组，职责只能在一组里；店主不受限 */
function assertDutiesCompatible(role: Role, duties: readonly Duty[]) {
  // 他店查询（v0.7.23）只查会员档阶，不带库存与采购职责（带了就会多出 ERP 的权限）
  if (role === 'other_store' && duties.length) throw unprocessable('DUTY_CONFLICT', '「他店查询」只查会员档阶，不能带库存与采购职责', { field: 'duties' });
  const groups = dutyConflict(role, duties);
  if (groups) {
    throw unprocessable('DUTY_CONFLICT', `仓库、采购、部门、财务（含成本）、负责人不兼任：这名员工的职责跨了「${groups}」，请只保留其中一组`, { field: 'duties' });
  }
}

/** 创建员工账号（CLI 与接口共用）。 */
export async function createStaff(
  db: Db,
  input: { username: string; displayName: string; role: Role; duties?: Duty[]; departmentId?: number | null; password: string; mustChangePassword: boolean },
): Promise<number> {
  try {
    const [row] = await db<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, duties, department_id, password_hash, must_change_password)
      VALUES (${input.username}, ${input.displayName}, ${input.role}, ${uniqueDuties(input.duties)}, ${input.departmentId ?? null},
              ${await hashPassword(input.password)}, ${input.mustChangePassword})
      RETURNING id`;
    return row!.id;
  } catch (error) {
    if (isUniqueViolation(error, 'staff_username_key')) throw conflict('USERNAME_EXISTS', '这个账号已存在');
    if (isForeignKeyViolation(error)) throw unprocessable('DEPARTMENT_INVALID', '所属部门不存在');
    throw error;
  }
}

export function registerStaffRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/staff', { preHandler: guard('staff.manage') }, async () => listStaff(sql));

  app.post('/api/staff', { preHandler: guard('staff.manage') }, async (req, reply) => {
    const input = parse(CreateInput, req.body);
    assertDutiesCompatible(input.role, input.duties);
    const password = input.password || generateTempPassword();
    const weak = checkPasswordStrength(password);
    if (weak) throw badRequest(weak, { field: 'password' });
    const id = await createStaff(sql, { ...input, password, mustChangePassword: true });
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'staff_created',
      targetType: 'staff',
      targetId: id,
      detail: { username: input.username, role: input.role, duties: input.duties },
      ip: req.ip,
    });
    reply.code(201);
    return { id, temporaryPassword: password };
  });

  app.put('/api/staff/:id', { preHandler: guard('staff.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(UpdateInput, req.body);
    // 停用的员工不用先改职责（停用后没有任何权限）
    if (input.active) assertDutiesCompatible(input.role, input.duties);
    await sql.begin(async (tx) => {
      // 锁住全部店主行，保证并发修改时仍至少保留一位在职店主
      await tx`SELECT id FROM staff WHERE role = 'owner' FOR UPDATE`;
      const [before] = await tx<{ role: string; duties: string[]; active: boolean; displayName: string; system: boolean }[]>`
        SELECT role, duties, active, display_name, system FROM staff WHERE id = ${id}`;
      if (!before || before.system) throw notFound('员工不存在');
      if (id === req.actor.id && (!input.active || input.role !== 'owner')) {
        throw unprocessable('SELF_LOCKOUT', '不能停用自己或取消自己的店主岗位');
      }
      if (input.departmentId) {
        const [dept] = await tx<{ id: number }[]>`SELECT id FROM departments WHERE id = ${input.departmentId}`;
        if (!dept) throw unprocessable('DEPARTMENT_INVALID', '所属部门不存在');
      }
      await tx`
        UPDATE staff SET display_name = ${input.displayName}, role = ${input.role}, duties = ${uniqueDuties(input.duties)},
               department_id = ${input.departmentId === undefined ? tx`department_id` : input.departmentId},
               active = ${input.active}, updated_at = now()
        WHERE id = ${id}`;
      const [owners] = await tx<{ count: number }[]>`SELECT count(*) AS count FROM staff WHERE role = 'owner' AND active`;
      if (!owners || owners.count < 1) throw unprocessable('LAST_OWNER', '至少需要保留一位在职店主');
      if (!input.active) await destroyStaffSessions(tx, id);
      await writeAudit(tx, {
        staffId: req.actor.id,
        action: 'staff_updated',
        targetType: 'staff',
        targetId: id,
        detail: { before, after: input },
        ip: req.ip,
      });
    });
    return listStaff(sql);
  });

  app.post('/api/staff/:id/reset-password', { preHandler: guard('staff.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const password = generateTempPassword();
    const hash = await hashPassword(password);
    await sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE staff SET password_hash = ${hash}, must_change_password = true, updated_at = now() WHERE id = ${id} AND NOT system RETURNING id`;
      if (rows.length === 0) throw notFound('员工不存在');
      await destroyStaffSessions(tx, id);
      await writeAudit(tx, { staffId: req.actor.id, action: 'staff_password_reset', targetType: 'staff', targetId: id, ip: req.ip });
    });
    return { temporaryPassword: password };
  });
}
