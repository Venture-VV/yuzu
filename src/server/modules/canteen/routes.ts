import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CANTEEN_MEALS, CANTEEN_ROLES, type CanteenMenu } from '@shared/canteen';
import { guard } from '../../auth/guard';
import { checkPasswordStrength, hashPassword } from '../../auth/password';
import { isUniqueViolation, type Tx } from '../../db';
import type { Deps } from '../../lib/context';
import { writeAudit } from '../../lib/audit';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { hashRequest } from '../../lib/idempotency';
import { parse } from '../../lib/validate';
import { employeeRequest } from './connection';
import { cacheMenu, listCanteenEmployees, publicEmployee, syncCanteen } from './sync';

const uuid = z.string().uuid();
const recordId = z.object({ id: uuid });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => { const d = new Date(`${s}T00:00:00Z`); return !isNaN(d.getTime()) && d.toISOString().startsWith(s); }, '日期不正确');
const mealMenu = z.object({ id: uuid, date, meal: z.enum(CANTEEN_MEALS), title: z.string().trim().min(1).max(80),
  dishes: z.array(z.string().trim().min(1).max(80)).min(1).max(30), notes: z.string().trim().max(500), published: z.boolean(), version: z.number().int().min(0) });
const person = z.object({ name: z.string().trim().min(1).max(40), departmentId: z.number().int().positive(), role: z.enum(CANTEEN_ROLES) });
const createPerson = person.extend({ requestId: uuid, employeeNo: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,32}$/), password: z.string().max(72).optional() });
const updatePerson = person.extend({ active: z.boolean(), version: z.number().int().positive() });
const menuRequest = z.object({ requestId: uuid, menu: mealMenu });
const dateQuery = z.object({ date: date.optional() });
const kinds = z.enum(['employee_create', 'password_reset', 'menu']);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function lockSettings(tx: Tx) {
  const [settings] = await tx<{ departmentId: number | null; version: number }[]>`SELECT department_id, version FROM canteen_settings WHERE singleton FOR UPDATE`;
  return settings!;
}
async function validateDepartment(tx: Tx, input: { departmentId: number; role: string }, canteenDepartmentId: number | null) {
  const [dept] = await tx`SELECT id FROM departments WHERE id = ${input.departmentId} AND active FOR SHARE`;
  if (!dept) throw unprocessable('DEPARTMENT_INVALID', '请选择有效部门');
  if (input.role !== 'employee' && input.departmentId !== canteenDepartmentId) throw unprocessable('CANTEEN_DEPARTMENT', '厨师与负责人必须属于已配置的食堂部门');
}
async function op<T>(tx: Tx, id: string, actor: number, kind: string, body: unknown, fn: () => Promise<T>): Promise<T> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`canteen-op:${id}`}, 0))`;
  const hash = hashRequest(body);
  const [old] = await tx<{ actorId: number; kind: string; requestHash: string; abandoned: boolean; result: T }[]>`SELECT * FROM canteen_operations WHERE id = ${id}`;
  if (old) {
    if (old.actorId !== actor || old.kind !== kind || (!old.abandoned && old.requestHash !== hash)) throw conflict('OP_CONFLICT', '操作编号与原请求不一致');
    if (old.abandoned) throw conflict('OP_ABANDONED', '原请求已确认作废，请重新填写');
    return old.result;
  }
  const result = await fn();
  await tx`INSERT INTO canteen_operations (id, actor_id, kind, request_hash, result)
    VALUES (${id}, ${actor}, ${kind}, ${hash}, ${tx.json(result as never)})`;
  return result;
}

export function registerCanteenRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const options = { preHandler: guard('canteen.manage') };
  const passwordFor = (requestId: string) => {
    if (!config.employeePortal) throw new AppError(503, 'EMPLOYEE_NOT_CONFIGURED', '先配置独立员工服务，再创建或重设员工端账号');
    return `Yz-${createHmac('sha256', config.employeePortal.syncKey).update(`canteen-password:${requestId}`).digest('base64url').slice(0, 18)}7`;
  };
  app.get('/api/erp/canteen/overview', options, async () => {
    const [state] = await sql<{ departmentId: number | null; version: number; lastSuccessAt: string | null; lastError: string | null; rosterVersion: number; syncedRosterVersion: number }[]>`SELECT * FROM canteen_settings WHERE singleton`;
    const departments = await sql`SELECT id, name, active FROM departments ORDER BY name`;
    const menus = await sql<{ payload: CanteenMenu }[]>`SELECT payload FROM canteen_menus ORDER BY menu_date DESC LIMIT 90`;
    return { settings: { departmentId: state!.departmentId, version: state!.version }, departments,
      employees: (await listCanteenEmployees(sql)).map(publicEmployee), menus: menus.map(m => m.payload),
      sync: { configured: !!config.employeePortal, lastSuccessAt: state!.lastSuccessAt, lastError: state!.lastError,
        pending: state!.rosterVersion !== state!.syncedRosterVersion, portalUrl: config.employeePortal?.url ?? null } };
  });
  app.put('/api/erp/canteen/settings', options, async req => {
    const input = parse(z.object({ departmentId: z.number().int().positive(), version: z.number().int().positive() }), req.body);
    return sql.begin(async tx => {
      const before = await lockSettings(tx);
      if (before.version === input.version + 1 && before.departmentId === input.departmentId) return before;
      if (before.version !== input.version) throw conflict('STALE', '食堂设置已变化，请刷新');
      const [dept] = await tx`SELECT id FROM departments WHERE id = ${input.departmentId} AND active FOR SHARE`;
      if (!dept) throw unprocessable('DEPARTMENT_INVALID', '请选择有效部门');
      const [other] = await tx`SELECT id FROM canteen_employees WHERE active AND role <> 'employee' AND department_id <> ${input.departmentId} LIMIT 1`;
      if (other) throw conflict('CANTEEN_ROLE_EXISTS', '请先停用原食堂部门的厨师与负责人账号，再更换食堂部门');
      const [state] = await tx`UPDATE canteen_settings SET department_id = ${input.departmentId}, version = version + 1, roster_version = roster_version + 1 WHERE singleton RETURNING department_id, version`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'canteen_settings', detail: input, ip: req.ip });
      return state;
    });
  });
  app.post('/api/erp/canteen/employees', options, async (req, reply) => {
    const input = parse(createPerson, req.body);
    const password = input.password || passwordFor(input.requestId);
    const weak = checkPasswordStrength(password);
    if (weak) throw badRequest(weak);
    try {
      const result = await sql.begin(tx => op(tx, input.requestId, req.actor.id, 'employee_create', input, async () => {
        const settings = await lockSettings(tx);
        await validateDepartment(tx, input, settings.departmentId);
        const id = randomUUID();
        await tx`INSERT INTO canteen_employees (id, employee_no, name, department_id, role, password_hash, credential_version)
          VALUES (${id}, ${input.employeeNo}, ${input.name}, ${input.departmentId}, ${input.role}, ${await hashPassword(password)}, ${randomUUID()})`;
        await tx`UPDATE canteen_settings SET roster_version = roster_version + 1 WHERE singleton`;
        await writeAudit(tx, { staffId: req.actor.id, action: 'canteen_employee', targetType: 'canteen_employee', targetId: id, detail: { operation: 'create', employeeNo: input.employeeNo, role: input.role }, ip: req.ip });
        const employee = (await listCanteenEmployees(tx)).find(e => e.id === id)!;
        return { employee: publicEmployee(employee) };
      }));
      reply.code(201);
      return { ...result, temporaryPassword: password };
    } catch (e) { if (isUniqueViolation(e)) throw conflict('EMPLOYEE_NO_EXISTS', '该工号已存在'); throw e; }
  });
  app.put('/api/erp/canteen/employees/:id', options, async req => {
    const { id } = parse(recordId, req.params);
    const input = parse(updatePerson, req.body);
    return sql.begin(async tx => {
      const settings = await lockSettings(tx);
      if (input.active) await validateDepartment(tx, input, settings.departmentId);
      const existing = (await listCanteenEmployees(tx)).find(e => e.id === id);
      if (existing?.version === input.version + 1 && existing.name === input.name && existing.departmentId === input.departmentId && existing.role === input.role && existing.active === input.active) return { employee: publicEmployee(existing) };
      const [updated] = await tx`UPDATE canteen_employees SET name = ${input.name}, department_id = ${input.departmentId},
        role = ${input.role}, active = ${input.active}, version = version + 1, updated_at = now()
        WHERE id = ${id} AND version = ${input.version} RETURNING id`;
      if (!updated) throw conflict('STALE', '员工资料已变化或不存在，请刷新');
      await tx`UPDATE canteen_settings SET roster_version = roster_version + 1 WHERE singleton`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'canteen_employee', targetType: 'canteen_employee', targetId: id, detail: { operation: 'update', ...input }, ip: req.ip });
      return { employee: publicEmployee((await listCanteenEmployees(tx)).find(e => e.id === id)!) };
    });
  });
  app.post('/api/erp/canteen/employees/:id/reset-password', options, async req => {
    const { id } = parse(recordId, req.params);
    const { requestId } = parse(z.object({ requestId: uuid }), req.body);
    const password = passwordFor(requestId);
    await sql.begin(tx => op(tx, requestId, req.actor.id, 'password_reset', { id }, async () => {
      await lockSettings(tx);
      const [row] = await tx`UPDATE canteen_employees SET password_hash = ${await hashPassword(password)}, credential_version = ${randomUUID()},
        must_change_password = true, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id`;
      if (!row) throw notFound('员工不存在');
      await tx`UPDATE canteen_settings SET roster_version = roster_version + 1 WHERE singleton`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'canteen_employee', targetType: 'canteen_employee', targetId: id, detail: { operation: 'reset_password' }, ip: req.ip });
      return { id };
    }));
    return { temporaryPassword: password };
  });
  app.post('/api/erp/canteen/sync', options, async () => {
    if (!config.employeePortal) throw new AppError(503, 'EMPLOYEE_NOT_CONFIGURED', '尚未配置独立员工服务连接');
    return syncCanteen(deps);
  });
  app.get('/api/erp/canteen/menus', options, async req => {
    const input = parse(dateQuery, req.query);
    const rows = await sql<{ payload: CanteenMenu }[]>`SELECT payload FROM canteen_menus
      WHERE menu_date = ${input.date ?? today()} ORDER BY payload->>'meal'`;
    return { menus: rows.map(r => r.payload) };
  });
  app.post('/api/erp/canteen/menus', options, async req => {
    const input = parse(menuRequest, req.body);
    // 外部服务持久幂等，同一原请求在回复丢失时可安全原样重提。
    return sql.begin(tx => op(tx, input.requestId, req.actor.id, 'menu', input, async () => {
      const result = await employeeRequest<{ menu: CanteenMenu }>(config.employeePortal, '/internal/menus', { ...input, actor: `yuzu:${req.actor.id}` });
      await cacheMenu(tx, result.menu);
      await writeAudit(tx, { staffId: req.actor.id, action: 'canteen_menu', targetType: 'canteen_menu', targetId: result.menu.id, detail: { published: result.menu.published, version: result.menu.version }, ip: req.ip });
      return result;
    }));
  });
  app.get('/api/erp/canteen/checkins', options, async req => {
    const input = parse(dateQuery, req.query);
    const rows = await sql`SELECT id, request_id, employee_id, employee_no, name, department_name, scanner_id, scanner_name, checked_at
      FROM canteen_checkins WHERE (checked_at AT TIME ZONE 'Asia/Shanghai')::date = ${input.date ?? today()}
      ORDER BY checked_at DESC LIMIT 2000`;
    return { checkins: rows };
  });
  app.post('/api/erp/canteen/operations/:id/abandon', options, async req => {
    const { id } = parse(recordId, req.params);
    const { kind } = parse(z.object({ kind: kinds }), req.body);
    return sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`canteen-op:${id}`}, 0))`;
      const [old] = await tx<{ actorId: number; kind: string; abandoned: boolean; result: unknown }[]>`SELECT * FROM canteen_operations WHERE id = ${id}`;
      if (old && (old.actorId !== req.actor.id || old.kind !== kind)) throw conflict('OP_CONFLICT', '操作编号不属于当前操作');
      if (old && !old.abandoned) return { status: 'completed', result: old.result };
      if (kind === 'menu' && !old) {
        const result = await employeeRequest<{ status: string; result?: { menu: CanteenMenu } }>(config.employeePortal, `/internal/operations/${id}/abandon`, { actor: `yuzu:${req.actor.id}`, kind });
        if (result.status === 'completed') {
          if (result.result?.menu) await cacheMenu(tx, result.result.menu);
          return result;
        }
      }
      await tx`INSERT INTO canteen_operations (id, actor_id, kind, abandoned) VALUES (${id}, ${req.actor.id}, ${kind}, true) ON CONFLICT DO NOTHING`;
      return { status: 'abandoned' };
    });
  });
  let running: Promise<unknown> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const run = () => {
    if (running) return;
    running = syncCanteen(deps).catch(() => app.log.warn('员工服务同步未完成')).finally(() => { running = null; });
  };
  if (config.employeePortal) {
    app.addHook('onReady', async () => { run(); timer = setInterval(run, 30_000); timer.unref(); });
    app.addHook('onClose', async () => { if (timer) clearInterval(timer); await running; });
  }
}
