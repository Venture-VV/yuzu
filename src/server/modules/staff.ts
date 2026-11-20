import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALL_PERMISSIONS, DUTIES, LOCKED_PERMISSIONS, ROLES, can, dutyConflict, type Duty, type Permission, type Role } from '@shared/permissions';
import { POSITION_KEYS, positionOf, type PositionKey } from '@shared/positions';
import type { StaffRecord } from '@shared/types';
import { isForeignKeyViolation, isUniqueViolation, type Db } from '../db';
import { guardAny } from '../auth/guard';
import { positionFrom, sanitizeAdjust } from '../auth/role-permissions';
import { checkPasswordStrength, generateTempPassword, hashPassword } from '../auth/password';
import { destroyStaffSessions } from '../auth/session';
import { writeAudit } from '../lib/audit';
import { currentStoreId, DEFAULT_STORE_ID } from '../lib/store-context';
import { allowedStores } from './stores';
import type { Deps } from '../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import type { Actor } from '../lib/context';
import { idParam, parse } from '../lib/validate';

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]{2,32}$/, '账号需为 2–32 位小写字母、数字或 _ . -');

/** 专用账号：后台把老账号改成专用账号时也不用再选岗（Codex 审查 4e118c1） */
const isSpecialRole = (role: Role) => role === 'tablet' || role === 'other_store' || role === 'designer';
const EMPTY_ADJUST = { add: [] as Permission[], remove: [] as Permission[] };

// 专用账号（8.1.18，GW3）：点餐平板、他店查询、设计师不是组织里的岗位，照旧按旧岗位建。
// 组织里的账号一律「部门 → 岗位」（position）；旧岗位（role + duties）只留给脚本与测试用（后台页面不再提供）。
const permissionList = z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]], '有不认识的权限，请刷新页面后重试')).max(ALL_PERMISSIONS.length);
const AdjustInput = z.object({ add: permissionList.default([]), remove: permissionList.default([]) });
const positionInput = z.enum(POSITION_KEYS as [PositionKey, ...PositionKey[]], '请选择岗位');

const CreateInput = z.object({
  username,
  displayName: z.string().trim().min(1, '请填写姓名').max(32, '姓名最多 32 个字'),
  /** 新岗位（8.1.18）：先选部门、再选负责人 / 员工，系统按岗位套用管理员级别与权限模板 */
  position: positionInput.optional(),
  /** 专用账号（或脚本、测试按旧岗位建）；有 position 时不看 */
  role: z.enum(ROLES, '请选择岗位').optional(),
  /** 库存与采购职责（旧岗位）；有 position 时按岗位自动填 */
  duties: z.array(z.enum(DUTIES)).max(DUTIES.length).default([]),
  /** 个人微调（只有超级管理员能给，GW8） */
  permissionAdjust: AdjustInput.optional(),
  /** 所属部门（v0.7.8：部门申购只能给自己的部门提需求单） */
  departmentId: z.number().int().positive().nullable().default(null),
  /** 不填则自动生成临时密码；员工首次登录必须修改 */
  password: z.string().optional(),
});

const UpdateInput = z.object({
  displayName: z.string().trim().min(1, '请填写姓名').max(32, '姓名最多 32 个字'),
  position: positionInput.nullable().optional(),
  role: z.enum(ROLES, '请选择岗位').optional(),
  duties: z.array(z.enum(DUTIES)).max(DUTIES.length).default([]),
  /** 不传保持原样 */
  permissionAdjust: AdjustInput.optional(),
  /** 不传保持原样，传 null 清空 */
  departmentId: z.number().int().positive().nullable().optional(),
  active: z.boolean(),
});

export async function listStaff(db: Db): Promise<StaffRecord[]> {
  const rows = await db<(StaffRecord & { permissionAdjust: unknown })[]>`
    SELECT s.id, s.username, s.display_name, s.role, s.duties, s.department_id, d.name AS department_name, s.active, s.must_change_password,
           s.position, s.permission_adjust, s.needs_position, s.position_chosen_at,
           s.last_login_at, s.created_at,
           -- 点单密码（8.0.10）：只给有没有、哪天生成的，不含密码
           (SELECT p.set_at FROM staff_order_pins p WHERE p.staff_id = s.id) AS order_pin_set_at
    FROM staff s LEFT JOIN departments d ON d.id = s.department_id
    -- 系统账号（小程序线上收款的经办人，v0.7.26）不出现在员工名单里
    WHERE NOT s.system
    ORDER BY s.active DESC, (s.role = 'owner') DESC, s.id`;
  return rows.map((r) => ({ ...r, position: positionFrom(r.position), permissionAdjust: sanitizeAdjust(r.permissionAdjust) ?? { add: [], remove: [] } }));
}

/**
 * 能管哪些员工账号（8.1.18，GW6）：有「管理员工账号」的（总裁）管全部；有「管理本部门员工账号」的负责人只管本部门的「员工」岗位，
 * 能建、改姓名与领料小仓、停用、重置密码，不能改岗位权限、不能给个人微调。
 */
type StaffScope = { all: true } | { all: false; position: PositionKey; stores: number[]; departmentId: number | null };
/**
 * 多门店（Codex 安全审查 49a64d0）：负责人只管挂的门店都在自己能进的门店里的员工——
 * 不然登录店 A 的负责人能重置只挂店 B 的同部门员工的密码，再拿这个账号进店 B。没挂门店的员工按本店算。
 */
async function staffScope(db: Db, actor: Actor): Promise<StaffScope> {
  if (can(actor, 'staff.manage')) return { all: true };
  if (can(actor, 'staff.dept') && actor.position && actor.position !== 'president' && actor.position !== 'gmo') {
    const dept = positionOf(actor.position).department;
    const stores = (await allowedStores(db, actor)).map((x) => Number(x.id));
    // 领料小仓（Codex 安全审查 4e118c1）：负责人只能给员工配自己档案里的那个小仓（或不配），别的部门的小仓只有总裁能配
    const [me] = await db<{ departmentId: number | null }[]>`SELECT department_id FROM staff WHERE id = ${actor.id}`;
    return { all: false, position: `${dept}.staff` as PositionKey, stores, departmentId: me?.departmentId == null ? null : Number(me.departmentId) };
  }
  throw forbidden('只能管理本部门员工的账号；您还没有部门岗位，请联系总裁');
}
const inScope = (scope: StaffScope, position: PositionKey | null | undefined) => scope.all || position === scope.position;

/** 负责人给员工配的领料小仓：只能是自己的那个或不配 */
function assertDeptStock(scope: StaffScope, departmentId: number | null | undefined) {
  if (scope.all || departmentId === undefined || departmentId === null) return;
  if (departmentId !== scope.departmentId) throw forbidden('负责人只能给员工配本部门的领料小仓；别的部门的小仓请总裁配');
}

/** 负责人范围内的员工（本部门员工岗位、挂的门店都在负责人能进的门店里、没有总裁给的个人加权与别的部门小仓）的条件；s 是 staff 表 */
function scopeCond(db: Db, scope: StaffScope) {
  if (scope.all) return db`true`;
  // 总裁单独加过权限、或配了别的部门小仓的员工也不归负责人管：不然负责人重置密码就能用上总裁给的例外（Codex 安全审查 6dfff92）
  return db`(s.position = ${scope.position}
    AND coalesce(jsonb_array_length(s.permission_adjust->'add'), 0) = 0
    AND (s.department_id IS NULL OR s.department_id = ${scope.departmentId}::bigint)
    AND NOT EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = s.id AND NOT (x.store_id = ANY(${scope.stores}::bigint[])))
    AND (EXISTS (SELECT 1 FROM staff_stores x WHERE x.staff_id = s.id) OR ${DEFAULT_STORE_ID}::bigint = ANY(${scope.stores}::bigint[])))`;
}
async function scopedIds(db: Db, scope: StaffScope): Promise<Set<number>> {
  const rows = await db<{ id: number }[]>`SELECT s.id FROM staff s WHERE NOT s.system AND ${scopeCond(db, scope)}`;
  return new Set(rows.map((r) => Number(r.id)));
}
async function scopedList(db: Db, scope: StaffScope) {
  const list = await listStaff(db);
  if (scope.all) return list;
  const ids = await scopedIds(db, scope);
  return list.filter((x) => ids.has(Number(x.id)));
}

/** 按岗位定旧岗位与职责（只给按旧岗位判断的几处用）；没有岗位的专用账号与旧岗位照原样 */
function resolveRole(input: { position?: PositionKey | null; role?: Role; duties?: Duty[] }): { position: PositionKey | null; role: Role; duties: Duty[] } {
  if (input.position) {
    const def = positionOf(input.position);
    return { position: input.position, role: def.legacyRole, duties: [...def.duties] };
  }
  if (!input.role) throw badRequest('请选择部门与岗位', { field: 'position' });
  return { position: null, role: input.role, duties: input.duties ?? [] };
}

/** 个人微调：只留认识的权限；总裁专属的不能加 */
function cleanAdjust(adjust: { add: Permission[]; remove: Permission[] } | undefined) {
  if (!adjust) return undefined;
  const locked = adjust.add.find((p) => LOCKED_PERMISSIONS.includes(p));
  if (locked) throw badRequest('「管理员工账号」「修改经营规则设置」「导入旧系统会员余额」只属于总裁，不能单独给', { field: 'permissionAdjust' });
  return { add: [...new Set(adjust.add)].sort(), remove: [...new Set(adjust.remove)].sort() };
}

const uniqueDuties = (duties: Duty[] = []) => [...new Set(duties)].sort();

/** 分岗不兼任（#17，v0.7.12）：仓库、采购、部门、财务（含成本）、负责人五组，职责只能在一组里；店主不受限 */
function assertDutiesCompatible(role: Role, duties: readonly Duty[]) {
  // 他店查询（v0.7.23）只查会员档阶，不带库存与采购职责（带了就会多出 ERP 的权限）
  if (role === 'other_store' && duties.length) throw unprocessable('DUTY_CONFLICT', '「他店查询」只查会员档阶，不能带库存与采购职责', { field: 'duties' });
  // 点餐平板（8.0.10）是放在餐桌上的设备账号，只能打开点餐页，不带职责（带了就会多出 ERP 的权限）
  if (role === 'tablet' && duties.length) throw unprocessable('DUTY_CONFLICT', '「点餐平板」只用来打开点餐页，不能带库存与采购职责', { field: 'duties' });
  // 设计师（8.1.1）只进工作台，不带职责（带了就会多出 ERP 的权限）
  if (role === 'designer' && duties.length) throw unprocessable('DUTY_CONFLICT', '「设计师」只进工作台改版面，不能带库存与采购职责', { field: 'duties' });
  const groups = dutyConflict(role, duties);
  if (groups) {
    throw unprocessable('DUTY_CONFLICT', `仓库、采购、部门、财务（含成本）、负责人不兼任：这名员工的职责跨了「${groups}」，请只保留其中一组`, { field: 'duties' });
  }
}

/** 创建员工账号（CLI 与接口共用）。 */
export async function createStaff(
  db: Db,
  input: {
    username: string;
    displayName: string;
    role: Role;
    duties?: Duty[];
    departmentId?: number | null;
    password: string;
    mustChangePassword: boolean;
    /** 新岗位（8.1.18）；给了就按岗位定 role 与 duties */
    position?: PositionKey | null;
    permissionAdjust?: { add: Permission[]; remove: Permission[] };
  },
): Promise<number> {
  const r = input.position ? resolveRole({ position: input.position }) : { position: null, role: input.role, duties: input.duties ?? [] };
  try {
    const [row] = await db<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, duties, department_id, password_hash, must_change_password, position, permission_adjust)
      VALUES (${input.username}, ${input.displayName}, ${r.role}, ${uniqueDuties(r.duties)}, ${input.departmentId ?? null},
              ${await hashPassword(input.password)}, ${input.mustChangePassword}, ${r.position}, ${db.json((input.permissionAdjust ?? {}) as never)})
      RETURNING id`;
    return row!.id;
  } catch (error) {
    if (isUniqueViolation(error, 'staff_username_key')) throw conflict('USERNAME_EXISTS', '这个账号已存在');
    if (isForeignKeyViolation(error)) throw unprocessable('DEPARTMENT_INVALID', '所属部门不存在');
    throw error;
  }
}

export function registerStaffRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/staff', { preHandler: guardAny('staff.manage', 'staff.dept') }, async (req) => {
    return scopedList(sql, await staffScope(sql, req.actor));
  });

  app.post('/api/staff', { preHandler: guardAny('staff.manage', 'staff.dept') }, async (req, reply) => {
    const input = parse(CreateInput, req.body);
    const scope = await staffScope(sql, req.actor);
    const resolved = resolveRole(input);
    if (!scope.all && (resolved.position !== scope.position || input.permissionAdjust)) throw forbidden('负责人只能给本部门建「员工」岗位的账号，不能单独调权限');
    assertDeptStock(scope, input.departmentId);
    // 组织里的岗位（GW1）：后台页面只给「部门 → 岗位」与专用账号；旧岗位只留给脚本与测试
    if (!resolved.position) assertDutiesCompatible(resolved.role, resolved.duties);
    const permissionAdjust = cleanAdjust(input.permissionAdjust);
    const password = input.password || generateTempPassword();
    const weak = checkPasswordStrength(password);
    if (weak) throw badRequest(weak, { field: 'password' });
    const id = await createStaff(sql, { ...input, ...resolved, permissionAdjust: isSpecialRole(resolved.role) ? EMPTY_ADJUST : permissionAdjust, password, mustChangePassword: true });
    // 新员工挂在建他的那家门店（8.0.22，docs/MULTISTORE_V8022.md 第 1 节；员工档案里可以再改成几家）
    await sql`INSERT INTO staff_stores (staff_id, store_id) VALUES (${id}, ${currentStoreId()}) ON CONFLICT DO NOTHING`;
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'staff_created',
      targetType: 'staff',
      targetId: id,
      detail: { username: input.username, position: resolved.position, role: resolved.role, duties: resolved.duties, permissionAdjust },
      ip: req.ip,
    });
    reply.code(201);
    return { id, temporaryPassword: password };
  });

  app.put('/api/staff/:id', { preHandler: guardAny('staff.manage', 'staff.dept') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(UpdateInput, req.body);
    const scope = await staffScope(sql, req.actor);
    const permissionAdjust = cleanAdjust(input.permissionAdjust);
    if (!scope.all && permissionAdjust) throw forbidden('只有总裁能单独调某个人的权限');
    assertDeptStock(scope, input.departmentId);
    await sql.begin(async (tx) => {
      // 锁住全部店主行，保证并发修改时仍至少保留一位在职店主。
      // FOR NO KEY UPDATE（8.0.19，原来是 FOR UPDATE）：改员工的事务之间照旧互相串行，但不再挡住引用店主的写入——
      // 审计、设备事件等记经办人的外键检查要对店主行加 KEY SHARE，FOR UPDATE 会让全店所有店主经手的写入等这个事务提交
      await tx`SELECT id FROM staff WHERE role = 'owner' FOR NO KEY UPDATE`;
      const [before] = await tx<{ role: Role; duties: Duty[]; active: boolean; displayName: string; system: boolean; position: string | null; permissionAdjust: unknown }[]>`
        SELECT role, duties, active, display_name, system, position, permission_adjust FROM staff WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!before || before.system) throw notFound('员工不存在');
      const beforePosition = positionFrom(before.position);
      // 不传岗位与旧岗位：岗位不变（负责人改本部门员工的姓名、停用时）
      const resolved =
        input.position === undefined && input.role === undefined
          ? { position: beforePosition, role: before.role, duties: before.duties ?? [] }
          : resolveRole({ position: input.position, role: input.role, duties: input.duties });
      if (!scope.all && (!inScope(scope, beforePosition) || !inScope(scope, resolved.position) || !(await scopedIds(tx, scope)).has(id))) {
        throw forbidden('负责人只能管理本部门「员工」岗位、本门店的账号');
      }
      // 停用的员工不用先改职责（停用后没有任何权限）
      if (input.active && !resolved.position) assertDutiesCompatible(resolved.role, resolved.duties);
      if (id === req.actor.id && (!input.active || resolved.role !== 'owner')) {
        throw unprocessable('SELF_LOCKOUT', '不能停用自己或取消自己的总裁（店主）岗位');
      }
      const positionChanged = resolved.position !== beforePosition;
      if (input.departmentId) {
        const [dept] = await tx<{ id: number }[]>`SELECT id FROM departments WHERE id = ${input.departmentId}`;
        if (!dept) throw unprocessable('DEPARTMENT_INVALID', '所属部门不存在');
      }
      await tx`
        UPDATE staff SET display_name = ${input.displayName}, role = ${resolved.role}, duties = ${uniqueDuties(resolved.duties)},
               department_id = ${input.departmentId === undefined ? tx`department_id` : input.departmentId},
               position = ${resolved.position},
               -- 改成专用账号（点餐平板、他店查询、设计师）清掉个人微调：专用账号的编辑框不显示微调，留着就是看不见的加权（Codex 审查 072a6e3）
               permission_adjust = ${isSpecialRole(resolved.role) ? tx.json(EMPTY_ADJUST as never) : permissionAdjust ? tx.json(permissionAdjust as never) : tx`permission_adjust`},
               -- 后台给了岗位就不用自己再选（GW7）；改过岗位的不再标「自选岗位」
               needs_position = ${resolved.position || isSpecialRole(resolved.role) ? false : tx`needs_position`},
               position_chosen_at = ${positionChanged ? null : tx`position_chosen_at`},
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
        detail: { before, after: { ...input, ...resolved, permissionAdjust } },
        ip: req.ip,
      });
    });
    // 负责人只拿得到本部门、本门店员工的名单（与 GET 同一个范围）
    return scopedList(sql, scope);
  });

  app.post('/api/staff/:id/reset-password', { preHandler: guardAny('staff.manage', 'staff.dept') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const scope = await staffScope(sql, req.actor);
    if (!scope.all) {
      const [row] = await sql<{ position: string | null }[]>`SELECT position FROM staff WHERE id = ${id} AND NOT system`;
      if (!row) throw notFound('员工不存在');
      if (!inScope(scope, positionFrom(row.position)) || !(await scopedIds(sql, scope)).has(id)) throw forbidden('负责人只能管理本部门「员工」岗位、本门店的账号');
    }
    const password = generateTempPassword();
    const hash = await hashPassword(password);
    await sql.begin(async (tx) => {
      // 先锁住这位员工（与调店 PUT /api/staff/:id/stores、改员工串行），再用新的语句核对范围并写入：
      // 范围写进 UPDATE（上面的核对在事务外、又隔着算密码摘要），这期间总裁改了岗位或调了店，负责人这一次就不生效（Codex 审查 4e118c1）
      await tx`SELECT id FROM staff WHERE id = ${id} FOR NO KEY UPDATE`;
      const rows = await tx`
        UPDATE staff s SET password_hash = ${hash}, must_change_password = true, updated_at = now()
        WHERE s.id = ${id} AND NOT s.system AND ${scopeCond(tx, scope)} RETURNING s.id`;
      if (rows.length === 0) throw scope.all ? notFound('员工不存在') : forbidden('负责人只能管理本部门「员工」岗位、本门店的账号');
      await destroyStaffSessions(tx, id);
      await writeAudit(tx, { staffId: req.actor.id, action: 'staff_password_reset', targetType: 'staff', targetId: id, ip: req.ip });
    });
    return { temporaryPassword: password };
  });
}
