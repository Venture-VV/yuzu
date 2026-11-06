import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CanteenEmployee, CanteenMenu, CanteenMenuInput, CanteenSession, CanteenCheckin } from '../../shared/canteen';
import { CANTEEN_ROLES, CANTEEN_MEALS } from '../../shared/canteen';
import type { Sql, Tx } from '../../server/db';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../../server/auth/password';
import { hashRequest } from '../../server/lib/idempotency';
import { setTxTimeouts } from '../../server/lib/tx';
import { todayIn } from '../../server/lib/dates';
import type { EmployeeConfig } from './config';

export const EMPLOYEE_SESSION_COOKIE = 'yuzu_employee_session';
const CODE_PREFIX = 'yuzu-employee:';
const MAX_MENUS = 5000;
const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const idSchema = z.string().trim().min(1).max(100);
const requestIdSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
  const value = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}, '日期无效');
const menuSchema = z.object({
  id: z.string().uuid(), date: dateSchema, meal: z.enum(CANTEEN_MEALS), title: z.string().trim().min(1).max(80),
  dishes: z.array(z.string().trim().min(1).max(80)).min(1).max(30),
  notes: z.string().trim().max(500), published: z.boolean(), version: z.number().int().min(0).max(2147483646),
}).strict();
const syncSchema = z.object({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  canteenDepartmentId: z.number().int().positive().nullable(), afterCheckinId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  employees: z.array(z.object({
    id: idSchema, employeeNo: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(100),
    departmentId: z.number().int().positive(), departmentName: z.string().trim().min(1).max(100),
    role: z.enum(CANTEEN_ROLES), active: z.boolean(), mustChangePassword: z.boolean(),
    // 限定本项目 scrypt 格式，防止接收无限成本或不兼容的密码参数。
    passwordHash: z.string().regex(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/),
    credentialVersion: z.string().min(1).max(100),
  }).strict()).max(10000),
}).strict();

class EmployeeError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
const fail = (status: number, code: string, message: string): never => { throw new EmployeeError(status, code, message); };
interface RosterRow extends CanteenEmployee { passwordHash: string; credentialVersion: string; authVersion: number }
interface SyncState { revision: number; syncedAt: string | null; canteenDepartmentId: number | null }
interface OperationRow { scope: 'menu' | 'checkin'; actorKey: string; fingerprint: string | null; status: 'completed' | 'abandoned'; result: unknown }
const employeeView = (row: RosterRow): CanteenEmployee => ({
  id: row.id, employeeNo: row.employeeNo, name: row.name, departmentId: row.departmentId,
  departmentName: row.departmentName, role: row.role, active: row.active, mustChangePassword: row.mustChangePassword,
});
const menuView = (row: CanteenMenu): CanteenMenu => ({
  id: row.id, date: row.date, meal: row.meal, title: row.title, dishes: row.dishes,
  notes: row.notes, published: row.published, version: row.version, updatedAt: row.updatedAt, updatedBy: row.updatedBy,
});
const checkinView = (row: CanteenCheckin): CanteenCheckin => ({
  id: row.id, requestId: row.requestId, employeeId: row.employeeId, employeeNo: row.employeeNo,
  name: row.name, departmentName: row.departmentName, scannerId: row.scannerId, scannerName: row.scannerName,
  checkedAt: row.checkedAt,
});

async function syncState(tx: Tx, config: EmployeeConfig, fresh = true): Promise<SyncState> {
  // 所有业务按状态行 → 操作锁 → 员工/凭证行顺序；名单同步独占状态行。
  const [state] = await tx<SyncState[]>`SELECT * FROM employee_sync_state WHERE id = 1 FOR SHARE`;
  if (!state) return fail(503, 'NOT_INITIALIZED', '员工服务尚未初始化');
  if (fresh && (!state.syncedAt || Date.now() - Date.parse(state.syncedAt) > Math.min(config.maxRosterAgeSeconds ?? 300, 300) * 1000)) {
    return fail(503, 'ROSTER_STALE', '员工名单同步已中断，请稍后再试或联系管理员');
  }
  return state;
}
async function authenticated(tx: Tx, request: FastifyRequest): Promise<RosterRow> {
  const token = request.cookies[EMPLOYEE_SESSION_COOKIE];
  if (!token || token.length > 200) return fail(401, 'UNAUTHENTICATED', '请先登录员工账号');
  const [row] = await tx<RosterRow[]>`
    SELECT e.* FROM employee_sessions s JOIN employee_roster e ON e.id = s.employee_id
    WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()
      AND e.active AND s.auth_version = e.auth_version`;
  if (!row) return fail(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
  if (request.headers['x-employee-id'] && request.headers['x-employee-id'] !== row.id) {
    return fail(409, 'ACCOUNT_CHANGED', '账号已在其他页面切换，请刷新后重新操作');
  }
  return row;
}
function checkRole(employee: RosterRow, state: SyncState, kind: 'menu' | 'checkin') {
  const allowed = kind === 'checkin' ? employee.role === 'manager' : ['chef', 'manager'].includes(employee.role);
  if (!allowed || employee.departmentId !== state.canteenDepartmentId) fail(403, 'FORBIDDEN', '没有食堂操作权限');
}
function requireChangedPassword(employee: RosterRow) {
  if (employee.mustChangePassword) fail(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码');
}
async function operationRow(tx: Tx, requestId: string, actorKey: string, kind?: 'menu' | 'checkin') {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${'employee-operation:' + requestId}))`;
  const [row] = await tx<OperationRow[]>`SELECT * FROM employee_requests WHERE request_id = ${requestId}`;
  if (row && (row.actorKey !== actorKey || (kind && row.scope !== kind))) {
    fail(409, 'OPERATION_CONFLICT', '操作编号已用于其他请求');
  }
  return row;
}
async function operation<T>(tx: Tx, requestId: string, actorKey: string, kind: 'menu' | 'checkin', payload: unknown, action: () => Promise<T>) {
  const fingerprint = hashRequest(payload);
  const prior = await operationRow(tx, requestId, actorKey, kind);
  if (prior) {
    if (prior.status === 'abandoned') return fail(409, 'OPERATION_ABANDONED', '此操作编号已确认作废，请重新填写');
    if (prior.fingerprint !== fingerprint) return fail(409, 'OPERATION_CONFLICT', '同一操作编号的内容不能改变');
    return { result: prior.result as T, replayed: true };
  }
  const result = await action();
  await tx`INSERT INTO employee_requests (scope, request_id, actor_key, fingerprint, status, result)
    VALUES (${kind}, ${requestId}, ${actorKey}, ${fingerprint}, 'completed', ${tx.json(result as never)})`;
  return { result, replayed: false };
}
async function abandon(tx: Tx, requestId: string, actorKey: string, kind: 'menu' | 'checkin') {
  const prior = await operationRow(tx, requestId, actorKey, kind);
  if (prior) return { status: prior.status, kind: prior.scope, ...(prior.status === 'completed' ? { result: prior.result } : {}) };
  await tx`INSERT INTO employee_requests (scope, request_id, actor_key, status)
    VALUES (${kind}, ${requestId}, ${actorKey}, 'abandoned')`;
  return { status: 'abandoned', kind };
}
async function saveMenu(tx: Tx, input: CanteenMenuInput, actor: string): Promise<{ menu: CanteenMenu }> {
  // 串行菜单写入，保证 (日期,餐次)、总量上限与乐观版本同时成立。
  await tx`SELECT pg_advisory_xact_lock(hashtext('employee-menus'))`;
  const [old] = await tx<CanteenMenu[]>`SELECT * FROM employee_menus WHERE id = ${input.id} FOR UPDATE`;
  if ((old?.version ?? 0) !== input.version) return fail(409, 'VERSION_CONFLICT', '菜单已变更，请刷新后重新编辑');
  const [other] = await tx`SELECT id FROM employee_menus WHERE date = ${input.date} AND meal = ${input.meal} AND id <> ${input.id}`;
  if (other) return fail(409, 'MENU_EXISTS', '该日期餐次已有菜单，请编辑已有菜单');
  if (!old) {
    const [count] = await tx<{ count: number }[]>`SELECT count(*)::integer AS count FROM employee_menus`;
    if (count!.count >= MAX_MENUS) return fail(409, 'MENU_LIMIT', '菜单总量已达 5000 条，请联系管理员归档');
  }
  const [saved] = await tx<CanteenMenu[]>`
    INSERT INTO employee_menus (id, date, meal, title, dishes, notes, published, version, updated_by)
    VALUES (${input.id}, ${input.date}, ${input.meal}, ${input.title}, ${tx.json(input.dishes)}, ${input.notes}, ${input.published}, 1, ${actor})
    ON CONFLICT (id) DO UPDATE SET date = EXCLUDED.date, meal = EXCLUDED.meal, title = EXCLUDED.title,
      dishes = EXCLUDED.dishes, notes = EXCLUDED.notes, published = EXCLUDED.published,
      version = employee_menus.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
    RETURNING *`;
  return { menu: menuView(saved!) };
}

export async function buildEmployeeApp(sql: Sql, config: EmployeeConfig) {
  if (config.production && (!config.publicOrigin.startsWith('https://') || !config.secureCookie || config.syncKey.length < 32 || new Set(config.syncKey).size < 12)) {
    throw new Error('生产员工服务必须启用 HTTPS、安全 Cookie 与强同步密钥');
  }
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024, trustProxy: config.trustedProxies?.length ? config.trustedProxies : false });
  await app.register(cookie);
  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: config.secureCookie, maxAge: 8 * 3600 };
  const dummyPasswordHash = await hashPassword(randomBytes(32).toString('hex'));
  const loginAttempts = new Map<string, { count: number; expires: number }>();
  function rateLimit(key: string, maximum: number) {
    const now = Date.now();
    if (loginAttempts.size > 10000) for (const [k, v] of loginAttempts) if (v.expires <= now) loginAttempts.delete(k);
    const prior = loginAttempts.get(key);
    if (prior && prior.expires > now && prior.count >= maximum) fail(429, 'LOGIN_RATE_LIMIT', '尝试过于频繁，请 5 分钟后重试');
    if (loginAttempts.size >= 20000 && !prior) fail(429, 'LOGIN_RATE_LIMIT', '请求过于频繁，请稍后重试');
    loginAttempts.set(key, { count: prior && prior.expires > now ? prior.count + 1 : 1, expires: prior && prior.expires > now ? prior.expires : now + 300000 });
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
    const path = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
    if (path.startsWith('/internal/')) {
      const supplied = request.headers['x-employee-sync-key'];
      const expected = Buffer.from(config.syncKey);
      const actual = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
      if (!config.syncKey || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        fail(401, 'SYNC_UNAUTHORIZED', '同步身份验证失败');
      }
      return;
    }
    if (path.startsWith('/api/employee/')) {
      const origin = request.headers.origin;
      if (origin && origin !== config.publicOrigin) fail(403, 'BAD_ORIGIN', '请求来源不正确');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin !== config.publicOrigin) {
        fail(403, 'BAD_ORIGIN', '写操作必须来自员工应用');
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'BAD_ORIGIN', '不接受跨站请求');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof EmployeeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '请求字段或格式不正确' } });
    const e = error as { code?: string; statusCode?: number };
    if (e.code === '23505') return reply.code(409).send({ error: { code: 'CONFLICT', message: '记录已存在，请刷新后重试' } });
    if (e.code === '55P03' || e.code === '57014' || e.code === '40P01') return reply.code(503).send({ error: { code: 'BUSY', message: '服务忙，请保持原操作编号重试' } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: 'INVALID_REQUEST', message: '请求无法处理' } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' } });
  });
  function withAuth<T>(request: FastifyRequest, action: (tx: Tx, employee: RosterRow, state: SyncState) => Promise<T>) {
    return sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const state = await syncState(tx, config);
      const employee = await authenticated(tx, request);
      return action(tx, employee, state);
    }) as Promise<T>;
  }
  function sessionView(employee: RosterRow, state: SyncState): CanteenSession {
    return { employee: employeeView(employee), serverTime: new Date().toISOString(), syncAt: state.syncedAt!, instance: config.instance, version: config.version, commit: config.commit };
  }
  app.get('/api/health', async () => {
    await sql`SELECT 1`;
    return { ok: true, service: 'employee', instance: config.instance, version: config.version, commit: config.commit };
  });
  app.get('/api/employee/session', (request) => withAuth(request, async (_tx, employee, state) => sessionView(employee, state)));
  app.post('/api/employee/login', async (request, reply) => {
    const input = z.object({ employeeNo: z.string().trim().min(1).max(64), password: z.string().min(1).max(72) }).strict().parse(request.body);
    rateLimit(`ip:${request.ip}`, 60);
    rateLimit(`account:${input.employeeNo}`, 12);
    const token = newToken();
    const result = await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const state = await syncState(tx, config);
      const [employee] = await tx<RosterRow[]>`SELECT * FROM employee_roster WHERE employee_no = ${input.employeeNo} FOR UPDATE`;
      const matches = await verifyPassword(input.password, employee?.passwordHash ?? dummyPasswordHash);
      if (!employee || !employee.active || !matches) return fail(401, 'LOGIN_FAILED', '工号或密码不正确，或账号已停用');
      await tx`DELETE FROM employee_sessions WHERE employee_id = ${employee.id} AND expires_at <= now()`;
      await tx`INSERT INTO employee_sessions (token_hash, employee_id, auth_version, expires_at)
        VALUES (${hashToken(token)}, ${employee.id}, ${employee.authVersion}, now() + interval '8 hours')`;
      return sessionView(employee, state);
    });
    loginAttempts.delete(`account:${input.employeeNo}`);
    reply.setCookie(EMPLOYEE_SESSION_COOKIE, token, cookieOptions);
    return result;
  });
  app.post('/api/employee/logout', async (request, reply) => {
    const token = request.cookies[EMPLOYEE_SESSION_COOKIE];
    if (token) await sql`DELETE FROM employee_sessions WHERE token_hash = ${hashToken(token)}`;
    reply.clearCookie(EMPLOYEE_SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });
  app.post('/api/employee/password', async (request, reply) => {
    const input = z.object({ oldPassword: z.string().min(1).max(72), newPassword: z.string().min(1).max(72) }).strict().parse(request.body);
    const weakness = checkPasswordStrength(input.newPassword);
    if (weakness) return fail(400, 'WEAK_PASSWORD', weakness);
    rateLimit(`password:${request.ip}`, 30);
    const token = newToken();
    const result = await withAuth(request, async (tx, employee, state) => {
      const [locked] = await tx<RosterRow[]>`SELECT * FROM employee_roster WHERE id = ${employee.id} FOR UPDATE`;
      if (locked!.authVersion !== employee.authVersion) return fail(401, 'UNAUTHENTICATED', '账号已更新，请重新登录');
      if (!(await verifyPassword(input.oldPassword, locked!.passwordHash))) return fail(400, 'PASSWORD_MISMATCH', '原密码不正确');
      if (input.oldPassword.normalize('NFKC') === input.newPassword.normalize('NFKC')) return fail(400, 'PASSWORD_UNCHANGED', '新密码必须与原密码不同');
      const passwordHash = await hashPassword(input.newPassword);
      const [updated] = await tx<RosterRow[]>`UPDATE employee_roster SET password_hash = ${passwordHash}, must_change_password = false,
        auth_version = auth_version + 1, updated_at = now() WHERE id = ${employee.id} RETURNING *`;
      await tx`DELETE FROM employee_sessions WHERE employee_id = ${employee.id}`;
      await tx`DELETE FROM employee_codes WHERE employee_id = ${employee.id}`;
      await tx`INSERT INTO employee_sessions (token_hash, employee_id, auth_version, expires_at)
        VALUES (${hashToken(token)}, ${employee.id}, ${updated!.authVersion}, now() + interval '8 hours')`;
      return sessionView(updated!, state);
    });
    reply.setCookie(EMPLOYEE_SESSION_COOKIE, token, cookieOptions);
    return result;
  });
  app.get('/api/employee/menus', (request) => withAuth(request, async (tx, employee, state) => {
    const input = z.object({ date: dateSchema.optional() }).strict().parse(request.query);
    const canEdit = ['chef', 'manager'].includes(employee.role) && employee.departmentId === state.canteenDepartmentId;
    const rows = await tx<CanteenMenu[]>`SELECT * FROM employee_menus WHERE date = ${input.date ?? todayIn('Asia/Shanghai')}
      AND (${canEdit} OR published) ORDER BY CASE meal WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END`;
    return { menus: rows.map(menuView) };
  }));
  app.post('/api/employee/menus', (request) => withAuth(request, async (tx, employee, state) => {
    checkRole(employee, state, 'menu'); requireChangedPassword(employee);
    const input = z.object({ requestId: requestIdSchema, menu: menuSchema }).strict().parse(request.body);
    const saved = await operation(tx, input.requestId, `employee:${employee.id}`, 'menu', input.menu, () => saveMenu(tx, input.menu, employee.name));
    return saved.result;
  }));
  app.get('/api/employee/code', (request) => withAuth(request, async (tx, employee) => {
    requireChangedPassword(employee);
    const [locked] = await tx<RosterRow[]>`SELECT * FROM employee_roster WHERE id = ${employee.id} FOR UPDATE`;
    if (locked!.authVersion !== employee.authVersion) return fail(401, 'UNAUTHENTICATED', '账号已更新，请重新登录');
    const token = newToken();
    // 每人只保留一个未使用码，刷新即撤销旧码。
    await tx`DELETE FROM employee_codes WHERE employee_id = ${employee.id}`;
    const [code] = await tx<{ expiresAt: string; serverTime: string }[]>`
      INSERT INTO employee_codes (token_hash, employee_id, auth_version, expires_at)
      VALUES (${hashToken(token)}, ${employee.id}, ${employee.authVersion}, clock_timestamp() + interval '60 seconds')
      RETURNING expires_at, clock_timestamp() AS server_time`;
    return { code: CODE_PREFIX + token, expiresAt: code!.expiresAt, serverTime: code!.serverTime, employeeNo: employee.employeeNo };
  }));
  app.post('/api/employee/checkins', (request) => withAuth(request, async (tx, employee, state) => {
    checkRole(employee, state, 'checkin'); requireChangedPassword(employee);
    const input = z.object({ requestId: requestIdSchema, code: z.string().regex(/^yuzu-employee:[A-Za-z0-9_-]{43}$/) }).strict().parse(request.body);
    const result = await operation(tx, input.requestId, `employee:${employee.id}`, 'checkin', { code: input.code }, async () => {
      const tokenHash = hashToken(input.code.slice(CODE_PREFIX.length));
      const [hint] = await tx<{ employeeId: string }[]>`SELECT employee_id FROM employee_codes WHERE token_hash = ${tokenHash}`;
      if (!hint) return fail(400, 'CODE_INVALID', '员工码无效，请员工刷新后重试');
      // 先锁员工，再锁其码，与换密码/刷新码相同顺序。
      const [target] = await tx<RosterRow[]>`SELECT * FROM employee_roster WHERE id = ${hint.employeeId} FOR SHARE`;
      const [code] = await tx<{ authVersion: number; valid: boolean; consumedAt: string | null }[]>`
        SELECT auth_version, expires_at > clock_timestamp() AS valid, consumed_at FROM employee_codes WHERE token_hash = ${tokenHash} FOR UPDATE`;
      if (!code || !target?.active || target.mustChangePassword || code.authVersion !== target.authVersion) return fail(400, 'CODE_INVALID', '员工码无效，请员工刷新后重试');
      if (code.consumedAt) return fail(409, 'CODE_USED', '该员工码已使用，请勿重复扫码');
      if (!code.valid) return fail(400, 'CODE_EXPIRED', '员工码已过期，请员工刷新后重试');
      const [checkin] = await tx<CanteenCheckin[]>`INSERT INTO employee_checkins
        (request_id, employee_id, employee_no, name, department_name, scanner_id, scanner_name, checked_at)
        VALUES (${input.requestId}, ${target.id}, ${target.employeeNo}, ${target.name}, ${target.departmentName}, ${employee.id}, ${employee.name}, clock_timestamp()) RETURNING *`;
      await tx`UPDATE employee_codes SET consumed_at = clock_timestamp() WHERE token_hash = ${tokenHash}`;
      return { checkin: checkinView(checkin!), replayed: false };
    });
    return { ...result.result, replayed: result.replayed };
  }));
  app.get('/api/employee/checkins', (request) => withAuth(request, async (tx, employee, state) => {
    const input = z.object({ date: dateSchema.optional() }).strict().parse(request.query);
    const all = employee.role === 'manager' && employee.departmentId === state.canteenDepartmentId;
    const rows = await tx<CanteenCheckin[]>`SELECT * FROM employee_checkins
      WHERE (checked_at AT TIME ZONE 'Asia/Shanghai')::date = ${input.date ?? todayIn('Asia/Shanghai')}
      AND (${all} OR employee_id = ${employee.id}) ORDER BY id DESC LIMIT 10000`;
    return { checkins: rows.map(checkinView) };
  }));
  app.get('/api/employee/operations/:id', (request) => withAuth(request, async (tx, employee) => {
    const { id } = z.object({ id: requestIdSchema }).parse(request.params);
    const [prior] = await tx<OperationRow[]>`SELECT * FROM employee_requests WHERE request_id = ${id} AND actor_key = ${`employee:${employee.id}`}`;
    return prior ? { status: prior.status, kind: prior.scope, ...(prior.status === 'completed' ? { result: prior.result } : {}) } : { status: 'unknown', kind: null };
  }));
  app.post('/api/employee/operations/:id/abandon', (request) => withAuth(request, async (tx, employee, state) => {
    const { id } = z.object({ id: requestIdSchema }).parse(request.params);
    const { kind } = z.object({ kind: z.enum(['menu', 'checkin']) }).strict().parse(request.body);
    checkRole(employee, state, kind); requireChangedPassword(employee);
    return abandon(tx, id, `employee:${employee.id}`, kind);
  }));
  app.post('/internal/menus', async (request) => {
    const input = z.object({ requestId: requestIdSchema, actor: z.string().trim().min(1).max(100), menu: menuSchema }).strict().parse(request.body);
    return sql.begin(async (tx) => {
      await setTxTimeouts(tx); await syncState(tx, config, false);
      const result = await operation(tx, input.requestId, `internal:${input.actor}`, 'menu', input.menu, () => saveMenu(tx, input.menu, input.actor));
      return result.result;
    });
  });
  app.post('/internal/operations/:id/abandon', async (request) => {
    const { id } = z.object({ id: requestIdSchema }).parse(request.params);
    const input = z.object({ kind: z.literal('menu'), actor: z.string().trim().min(1).max(100) }).strict().parse(request.body);
    return sql.begin(async (tx) => {
      await setTxTimeouts(tx); await syncState(tx, config, false);
      return abandon(tx, id, `internal:${input.actor}`, input.kind);
    });
  });
  app.post('/internal/sync', async (request) => {
    const input = syncSchema.parse(request.body);
    if (new Set(input.employees.map((e) => e.id)).size !== input.employees.length ||
        new Set(input.employees.map((e) => e.employeeNo)).size !== input.employees.length) return fail(400, 'DUPLICATE_EMPLOYEE', '同步名单存在重复员工或工号');
    return sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [state] = await tx<SyncState[]>`SELECT * FROM employee_sync_state WHERE id = 1 FOR UPDATE`;
      if (!state || input.revision <= state.revision) return fail(409, 'SYNC_REVISION', '同步版本必须递增');
      if (state.canteenDepartmentId !== input.canteenDepartmentId) {
        await tx`UPDATE employee_roster SET auth_version = auth_version + 1`;
        await tx`DELETE FROM employee_sessions`;
        await tx`DELETE FROM employee_codes`;
      }
      for (const person of input.employees) {
        const [old] = await tx<RosterRow[]>`SELECT * FROM employee_roster WHERE id = ${person.id}`;
        const resetCredential = !old || old.credentialVersion !== person.credentialVersion;
        const changed = old && (old.active !== person.active || old.role !== person.role || old.departmentId !== person.departmentId || old.employeeNo !== person.employeeNo || resetCredential);
        await tx`INSERT INTO employee_roster (id, employee_no, name, department_id, department_name, role, active,
          must_change_password, password_hash, credential_version)
          VALUES (${person.id}, ${person.employeeNo}, ${person.name}, ${person.departmentId}, ${person.departmentName}, ${person.role},
            ${person.active}, ${person.mustChangePassword}, ${person.passwordHash}, ${person.credentialVersion})
          ON CONFLICT (id) DO UPDATE SET employee_no = EXCLUDED.employee_no, name = EXCLUDED.name,
            department_id = EXCLUDED.department_id, department_name = EXCLUDED.department_name,
            role = EXCLUDED.role, active = EXCLUDED.active, credential_version = EXCLUDED.credential_version,
            password_hash = ${resetCredential ? person.passwordHash : old!.passwordHash},
            must_change_password = ${resetCredential ? person.mustChangePassword : old!.mustChangePassword},
            auth_version = employee_roster.auth_version + ${changed ? 1 : 0}, updated_at = now()`;
        if (changed || !person.active) {
          await tx`DELETE FROM employee_sessions WHERE employee_id = ${person.id}`;
          await tx`DELETE FROM employee_codes WHERE employee_id = ${person.id}`;
        }
      }
      const ids = input.employees.map((employee) => employee.id);
      await tx`UPDATE employee_roster SET active = false, auth_version = auth_version + 1, updated_at = now()
        WHERE active AND NOT (id = ANY(${tx.array(ids)}::text[]))`;
      await tx`DELETE FROM employee_sessions WHERE employee_id IN (SELECT id FROM employee_roster WHERE NOT active) OR expires_at <= now()`;
      await tx`DELETE FROM employee_codes WHERE employee_id IN (SELECT id FROM employee_roster WHERE NOT active) OR expires_at <= now()`;
      const [updated] = await tx<{ syncedAt: string }[]>`UPDATE employee_sync_state SET revision = ${input.revision},
        synced_at = clock_timestamp(), canteen_department_id = ${input.canteenDepartmentId} WHERE id = 1 RETURNING synced_at`;
      const menus = await tx<CanteenMenu[]>`SELECT * FROM employee_menus ORDER BY date, meal, id`;
      const rows = await tx<CanteenCheckin[]>`SELECT * FROM employee_checkins WHERE id > ${input.afterCheckinId} ORDER BY id LIMIT 501`;
      const hasMore = rows.length > 500;
      const checkins = rows.slice(0, 500).map(checkinView);
      return { rosterSyncedAt: updated!.syncedAt, menus: menus.map(menuView), checkins,
        nextCheckinId: checkins.at(-1)?.id ?? input.afterCheckinId, hasMore };
    });
  });
  if (config.staticRoot && existsSync(config.staticRoot)) {
    await app.register(fastifyStatic, { root: config.staticRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      if (request.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/internal/') && !path.split('/').at(-1)?.includes('.')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有此接口或页面' } });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有此接口或页面' } }));
  }
  return app;
}
