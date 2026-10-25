import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES } from '@shared/permissions';
import type { StaffRecord } from '@shared/types';
import { isUniqueViolation, type Db } from '../db';
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
  /** 不填则自动生成临时密码；员工首次登录必须修改 */
  password: z.string().optional(),
});

const UpdateInput = z.object({
  displayName: z.string().trim().min(1, '请填写姓名').max(32, '姓名最多 32 个字'),
  role: z.enum(ROLES, '请选择岗位'),
  active: z.boolean(),
});

export async function listStaff(db: Db): Promise<StaffRecord[]> {
  return db<StaffRecord[]>`
    SELECT id, username, display_name, role, active, must_change_password, last_login_at, created_at
    FROM staff ORDER BY active DESC, role DESC, id`;
}

/** 创建员工账号（CLI 与接口共用）。 */
export async function createStaff(
  db: Db,
  input: { username: string; displayName: string; role: 'owner' | 'clerk'; password: string; mustChangePassword: boolean },
): Promise<number> {
  try {
    const [row] = await db<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash, must_change_password)
      VALUES (${input.username}, ${input.displayName}, ${input.role}, ${await hashPassword(input.password)}, ${input.mustChangePassword})
      RETURNING id`;
    return row!.id;
  } catch (error) {
    if (isUniqueViolation(error, 'staff_username_key')) throw conflict('USERNAME_EXISTS', '这个账号已存在');
    throw error;
  }
}

export function registerStaffRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/staff', { preHandler: guard('staff.manage') }, async () => listStaff(sql));

  app.post('/api/staff', { preHandler: guard('staff.manage') }, async (req, reply) => {
    const input = parse(CreateInput, req.body);
    const password = input.password || generateTempPassword();
    const weak = checkPasswordStrength(password);
    if (weak) throw badRequest(weak, { field: 'password' });
    const id = await createStaff(sql, { ...input, password, mustChangePassword: true });
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'staff_created',
      targetType: 'staff',
      targetId: id,
      detail: { username: input.username, role: input.role },
      ip: req.ip,
    });
    reply.code(201);
    return { id, temporaryPassword: password };
  });

  app.put('/api/staff/:id', { preHandler: guard('staff.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(UpdateInput, req.body);
    await sql.begin(async (tx) => {
      // 锁住全部店主行，保证并发修改时仍至少保留一位在职店主
      await tx`SELECT id FROM staff WHERE role = 'owner' FOR UPDATE`;
      const [before] = await tx<{ role: string; active: boolean; displayName: string }[]>`
        SELECT role, active, display_name FROM staff WHERE id = ${id}`;
      if (!before) throw notFound('员工不存在');
      if (id === req.actor.id && (!input.active || input.role !== 'owner')) {
        throw unprocessable('SELF_LOCKOUT', '不能停用自己或取消自己的店主岗位');
      }
      await tx`
        UPDATE staff SET display_name = ${input.displayName}, role = ${input.role}, active = ${input.active}, updated_at = now()
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
        UPDATE staff SET password_hash = ${hash}, must_change_password = true, updated_at = now() WHERE id = ${id} RETURNING id`;
      if (rows.length === 0) throw notFound('员工不存在');
      await destroyStaffSessions(tx, id);
      await writeAudit(tx, { staffId: req.actor.id, action: 'staff_password_reset', targetType: 'staff', targetId: id, ip: req.ip });
    });
    return { temporaryPassword: password };
  });
}
