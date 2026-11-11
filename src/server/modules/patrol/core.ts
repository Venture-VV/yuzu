// 8.0.9 安保巡场（docs/PATROL_V809.md）：设置、谁能用、场所与场所码、巡场打卡、每天的清单、记录与导出、作废。
// 8.0.11 巡场轮次（第 11 节）：营业日按巡场间隔分轮，同一个场所每轮只记一次打卡（XC13–XC15）。
//
// 锁（AGENTS.md）：打卡：员工一行（共享锁，与停用、重新开通串行，同食堂打卡）→「场所」的咨询锁（同一个场所的打卡串行，判断这一轮有没有人打过）
// → 场所一行（共享锁，与停用、换码串行）→ 写打卡，同一个操作编号靠唯一约束兜底、同一个场所同一轮靠部分唯一索引兜底；场所：新建先取操作编号的咨询锁（与「确认作废」串行），
// 名称靠部分唯一索引兜底，修改、停用 / 启用、换码只锁场所一行（带版本号）；作废打卡只锁那一条；设置走规则锁（带版本号）。

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { base32 } from '@shared/canteen';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import {
  MAX_PATROL_POINT_AREA,
  MAX_PATROL_POINT_NAME,
  MAX_PATROL_VOID_REASON,
  PATROL_LATE_MINUTES,
  PATROL_MAX_DAYS,
  PATROL_MAX_LATE_HOURS,
  PATROL_ROUND_DEFAULT_MINUTES,
  PATROL_ROUND_MAX_MINUTES,
  PATROL_ROUND_MIN_MINUTES,
  PATROL_ROUND_STEP_MINUTES,
  PATROL_TOKEN_LENGTH,
  PATROL_VIA_LABELS,
  PATROL_VIAS,
  parsePatrolToken,
  patrolRoundAt,
  patrolRoundMinutesOn,
  patrolRoundsOf,
  type PatrolApp,
  type PatrolCheckinResult,
  type PatrolCheckinRow,
  type PatrolDay,
  type PatrolPoint,
  type PatrolPointOption,
  type PatrolPointsAdmin,
  type PatrolPortalDay,
  type PatrolRecords,
  type PatrolRound,
  type PatrolRoundChange,
  type PatrolRoundSpan,
  type PatrolScan,
  type PatrolSettings,
  type PatrolSettingsAdmin,
} from '@shared/patrol';
import { isUniqueViolation, type Db, type Fragment, type Sql } from '../../db';
import type { AppConfig } from '../../config';
import type { OpContext } from '../../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { saveRuleSetting } from '../../lib/rule-settings';
import { writeAudit } from '../../lib/audit';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { daysBetween } from '../../lib/dates';
import { toCsv } from '../../lib/csv';
import { erpOpAbandoned } from '../erp-ops';
import { enabledErpModules } from '../erp';
import { loadSettings } from '../settings';
import { loadCanteenSettings } from '../canteen/settings';
import type { CanteenSessionEmployee } from '../canteen/portal-auth';

const MINUTE = 60_000;

// ───────────────────────── 营业日 ─────────────────────────

/** 某一刻属于哪个营业日（XC4：与营业额同一个切换时间） */
export async function patrolDateOf(db: Db, config: AppConfig, at: Date): Promise<string> {
  const s = await loadSettings(db);
  return businessDateOf(at, config.timezone, s.businessDayStartHour);
}

/** 某个营业日的各轮（按这一天的巡场间隔，XC13） */
async function roundsOn(db: Db, config: AppConfig, date: string, settings?: PatrolSettings): Promise<{ minutes: number; rounds: PatrolRoundSpan[] }> {
  const s = settings ?? (await loadPatrolSettings(db));
  const { businessDayStartHour } = await loadSettings(db);
  const minutes = patrolRoundMinutesOn(s.roundChanges, date);
  return { minutes, rounds: patrolRoundsOf(date, config.timezone, businessDayStartHour, minutes) };
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// ───────────────────────── 设置（XC1、XC2） ─────────────────────────

const idList = (x: unknown) => (Array.isArray(x) ? [...new Set(x.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0))] : []);

const validRoundMinutes = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= PATROL_ROUND_MIN_MINUTES && n <= PATROL_ROUND_MAX_MINUTES && n % PATROL_ROUND_STEP_MINUTES === 0;

const roundChangeList = (x: unknown): PatrolRoundChange[] =>
  (Array.isArray(x) ? x : [])
    .filter((c): c is PatrolRoundChange => !!c && typeof c === 'object' && typeof c.from === 'string' && ISO_DATE.test(c.from) && validRoundMinutes(c.minutes))
    .map((c) => ({ from: c.from, minutes: c.minutes }))
    .sort((a, b) => a.from.localeCompare(b.from));

/** 最多留这么多条巡场间隔的改动（够看一年多以前的） */
const MAX_ROUND_CHANGES = 400;

export async function loadPatrolSettings(db: Db): Promise<PatrolSettings> {
  const [row] = await db<{ value: Record<string, unknown> }[]>`SELECT value FROM settings WHERE key = 'patrol'`;
  const v = row?.value ?? {};
  const roundChanges = roundChangeList(v.roundChanges);
  return {
    departmentIds: idList(v.departmentIds),
    viewerIds: idList(v.viewerIds),
    roundMinutes: roundChanges.at(-1)?.minutes ?? PATROL_ROUND_DEFAULT_MINUTES,
    roundChanges,
    rev: typeof v.rev === 'number' ? v.rev : 0,
  };
}

const SettingsInput = z.object({
  departmentIds: z.array(z.number().int().positive(), '请选巡场部门').max(20, '巡场部门最多 20 个'),
  viewerIds: z.array(z.number().int().positive(), '请选能看记录的人').max(50, '能看记录的人最多 50 位'),
  /** 巡场间隔（分钟，XC13）：不传就不改 */
  roundMinutes: z
    .number('巡场间隔要是数字')
    .int('巡场间隔按半小时调')
    .min(PATROL_ROUND_MIN_MINUTES, `巡场间隔最短 ${PATROL_ROUND_MIN_MINUTES} 分钟`)
    .max(PATROL_ROUND_MAX_MINUTES, '巡场间隔最长 24 小时')
    .refine((n) => n % PATROL_ROUND_STEP_MINUTES === 0, '巡场间隔按半小时调')
    .optional(),
  /** 打开时看到的版本：别人刚改过就拒绝，不把别人的修改盖掉 */
  rev: z.number('缺少版本号，请刷新').int().min(0),
});

/** 保存设置；改了巡场间隔的，从今天（营业日）起按新的间隔分轮，以前的营业日照旧（XC15） */
export async function savePatrolSettings(sql: Sql, config: AppConfig, raw: unknown, ctx: OpContext): Promise<PatrolSettings> {
  const input = parse(SettingsInput, raw);
  const departmentIds = [...new Set(input.departmentIds)];
  const viewerIds = [...new Set(input.viewerIds)];
  return saveRuleSetting(
    sql,
    'patrol',
    loadPatrolSettings,
    async (before, tx) => {
      if (before.rev !== input.rev) throw conflict('PATROL_SETTINGS_CHANGED', '巡场设置刚被别人改过，请刷新看一下最新的再改');
      if (departmentIds.length) {
        const rows = await tx<{ id: number }[]>`SELECT id FROM departments WHERE id IN ${tx(departmentIds)}`;
        if (rows.length !== departmentIds.length) throw badRequest('选的部门有不存在的，请刷新');
      }
      if (viewerIds.length) {
        const rows = await tx<{ id: number }[]>`SELECT id FROM canteen_employees WHERE id IN ${tx(viewerIds)}`;
        if (rows.length !== viewerIds.length) throw badRequest('选的员工有不存在的，请刷新');
      }
      let roundChanges = before.roundChanges;
      if (input.roundMinutes !== undefined && input.roundMinutes !== before.roundMinutes) {
        const today = await patrolDateOf(tx, config, new Date());
        roundChanges = [...before.roundChanges.filter((c) => c.from < today), { from: today, minutes: input.roundMinutes }].slice(-MAX_ROUND_CHANGES);
      }
      return { departmentIds, viewerIds, roundMinutes: roundChanges.at(-1)?.minutes ?? PATROL_ROUND_DEFAULT_MINUTES, roundChanges, rev: before.rev + 1 };
    },
    ctx,
  );
}

export async function patrolSettingsAdmin(db: Db): Promise<PatrolSettingsAdmin> {
  const s = await loadPatrolSettings(db);
  const departments = await db<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM departments ORDER BY active DESC, name, id`;
  const employees = await db<{ id: number; empNo: string; name: string; department: string; active: boolean }[]>`
    SELECT e.id, e.emp_no, e.name, coalesce(d.name, '') AS department, e.active
    FROM canteen_employees e LEFT JOIN departments d ON d.id = e.department_id ORDER BY e.active DESC, e.emp_no, e.id`;
  const [count] = s.departmentIds.length
    ? await db<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_employees WHERE active AND department_id IN ${db(s.departmentIds)}`
    : [{ n: 0 }];
  const [meta] = await db<{ updatedAt: string | null; updatedBy: string | null }[]>`
    SELECT s.updated_at, st.display_name AS updated_by FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = 'patrol'`;
  return { ...s, departments, employees, patrolStaffCount: count!.n, updatedAt: meta?.updatedAt ?? null, updatedBy: meta?.updatedBy ?? null };
}

// ───────────────────────── 谁能用（员工端） ─────────────────────────

export interface PatrolAccess {
  /** 巡场部门的人：扫码打卡、看今天 */
  scan: boolean;
  /** 后台指定的人：看任何一天的记录 */
  view: boolean;
}

/** 这位员工在巡场里能做什么：每个请求当场按名单核对（手机上的入口只是方便，XC1、XC2） */
export async function patrolAccess(db: Db, employeeId: number, settings?: PatrolSettings): Promise<PatrolAccess> {
  const s = settings ?? (await loadPatrolSettings(db));
  const [e] = await db<{ departmentId: number | null; active: boolean }[]>`SELECT department_id, active FROM canteen_employees WHERE id = ${employeeId}`;
  if (!e || !e.active) return { scan: false, view: false };
  return { scan: e.departmentId !== null && s.departmentIds.includes(Number(e.departmentId)), view: s.viewerIds.includes(employeeId) };
}

/** 柚子饭堂「工作台」里巡场相关的应用（安保巡场模块关着时没有） */
export async function patrolAppsFor(db: Db, employeeId: number): Promise<PatrolApp[]> {
  if (!(await enabledErpModules(db)).has('patrol')) return [];
  const a = await patrolAccess(db, employeeId);
  return [...(a.scan ? (['patrol'] as const) : []), ...(a.view ? (['patrolLog'] as const) : [])];
}

// ───────────────────────── 场所与场所码 ─────────────────────────

/** 新的场所码：12 位 base32（60 位随机） */
export const newPatrolToken = () => base32(randomBytes(8), PATROL_TOKEN_LENGTH);

type PointRow = Omit<PatrolPoint, 'todayCount'>;
const POINT_COLUMNS = (db: Db) => db`p.id, p.name, p.area, p.token, p.active, p.sort_order, p.version, p.created_at, p.token_changed_at`;

async function getPoint(db: Db, id: number): Promise<PointRow> {
  const [p] = await db<PointRow[]>`SELECT ${POINT_COLUMNS(db)} FROM patrol_points p WHERE p.id = ${id}`;
  if (!p) throw notFound('没有这个场所');
  return p;
}

export async function patrolPointsAdmin(db: Db, config: AppConfig): Promise<PatrolPointsAdmin> {
  const today = await patrolDateOf(db, config, new Date());
  const points = await db<PatrolPoint[]>`
    SELECT ${POINT_COLUMNS(db)},
           (SELECT count(*)::int FROM patrol_checkins c WHERE c.point_id = p.id AND c.business_date = ${today} AND c.voided_at IS NULL) AS today_count
    FROM patrol_points p ORDER BY p.active DESC, p.sort_order, p.id`;
  const canteen = await loadCanteenSettings(db);
  return { points, portalUrl: canteen.portalUrl, today };
}

/** 巡场记录筛选用的全部场所（含停用的、不含场所码）：停用的场所以前的记录照样能单独筛、单独导出（Codex 审查 41a2fbb） */
export async function patrolPointOptions(db: Db): Promise<PatrolPointOption[]> {
  return db<PatrolPointOption[]>`SELECT p.id, p.name, p.area, p.active FROM patrol_points p ORDER BY p.active DESC, p.sort_order, p.id`;
}

const nameField = z
  .string('请写场所名称')
  .trim()
  .min(1, '请写场所名称')
  .max(MAX_PATROL_POINT_NAME, `场所名称最多 ${MAX_PATROL_POINT_NAME} 个字`);
const areaField = z.string().trim().max(MAX_PATROL_POINT_AREA, `位置说明最多 ${MAX_PATROL_POINT_AREA} 个字`).default('');
const sortField = z.number().int('排序要是整数').min(-9999).max(9999).default(0);

const PointInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  name: nameField,
  area: areaField,
  sortOrder: sortField,
});

const nameTaken = (name: string) => conflict('PATROL_NAME_TAKEN', `已经有叫「${name}」的场所了，换个名字（停用的可以重名）`);

/** 新建场所（带操作编号：回复丢了按原内容重提只建一个，确认作废后原请求不生效） */
export async function createPatrolPoint(sql: Sql, raw: unknown, ctx: OpContext): Promise<{ point: PointRow; replayed: boolean }> {
  const input = parse(PointInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  try {
    return await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, key, 'patrol_point', erpOpAbandoned);
      const [existing] = await tx<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM patrol_points WHERE client_key = ${key}`;
      if (existing) {
        if (existing.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的业务，请刷新页面后重新发起');
        return { point: await getPoint(tx, Number(existing.id)), replayed: true };
      }
      const [dup] = await tx`SELECT 1 FROM patrol_points WHERE lower(name) = lower(${input.name}) AND active`;
      if (dup) throw nameTaken(input.name);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO patrol_points (name, area, token, sort_order, client_key, request_hash, created_by, updated_by)
        VALUES (${input.name}, ${input.area}, ${newPatrolToken()}, ${input.sortOrder}, ${key}, ${requestHash}, ${ctx.actor.id}, ${ctx.actor.id})
        RETURNING id`;
      const id = Number(row!.id);
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'patrol_point', targetType: 'patrol_point', targetId: id, detail: { op: 'create', name: input.name, area: input.area }, ip: ctx.ip });
      return { point: await getPoint(tx, id), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'patrol_points_name_uq')) throw nameTaken(input.name);
    throw error;
  }
}

const PointUpdateInput = z.object({
  name: nameField,
  area: areaField,
  sortOrder: sortField,
  active: z.boolean('请选启用还是停用'),
  /** 打开时看到的版本：别人刚改过（或刚换过码）就拒绝 */
  version: z.number('缺少版本号，请刷新').int().min(1),
});

/** 改名称、位置说明、顺序，停用 / 启用（XC9）：只锁场所一行，带版本号 */
export async function updatePatrolPoint(sql: Sql, id: number, raw: unknown, ctx: OpContext): Promise<PointRow> {
  const input = parse(PointUpdateInput, raw);
  try {
    return await sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [p] = await tx<{ name: string; area: string; sortOrder: number; active: boolean; version: number }[]>`
        SELECT name, area, sort_order, active, version FROM patrol_points WHERE id = ${id} FOR UPDATE`;
      if (!p) throw notFound('没有这个场所');
      if (p.version !== input.version) throw conflict('PATROL_POINT_CHANGED', '这个场所刚被别人改过（或换过码），请刷新看一下最新的再改');
      if (input.active) {
        const [dup] = await tx`SELECT 1 FROM patrol_points WHERE lower(name) = lower(${input.name}) AND active AND id <> ${id}`;
        if (dup) throw nameTaken(input.name);
      }
      await tx`
        UPDATE patrol_points SET name = ${input.name}, area = ${input.area}, sort_order = ${input.sortOrder}, active = ${input.active},
               version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
        WHERE id = ${id}`;
      const op = p.active !== input.active ? (input.active ? 'enable' : 'disable') : 'update';
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'patrol_point',
        targetType: 'patrol_point',
        targetId: id,
        detail: { op, before: { name: p.name, area: p.area, sortOrder: p.sortOrder, active: p.active }, after: { name: input.name, area: input.area, sortOrder: input.sortOrder, active: input.active } },
        ip: ctx.ip,
      });
      return getPoint(tx, id);
    });
  } catch (error) {
    if (isUniqueViolation(error, 'patrol_points_name_uq')) throw nameTaken(input.name);
    throw error;
  }
}

const VersionInput = z.object({ version: z.number('缺少版本号，请刷新').int().min(1) });

/** 换码（XC8）：旧码马上认不出，要重新打印张贴 */
export async function rotatePatrolToken(sql: Sql, id: number, raw: unknown, ctx: OpContext): Promise<PointRow> {
  const input = parse(VersionInput, raw);
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [p] = await tx<{ name: string; version: number }[]>`SELECT name, version FROM patrol_points WHERE id = ${id} FOR UPDATE`;
    if (!p) throw notFound('没有这个场所');
    if (p.version !== input.version) throw conflict('PATROL_POINT_CHANGED', '这个场所刚被别人改过（或换过码），请刷新看一下最新的再换');
    await tx`
      UPDATE patrol_points SET token = ${newPatrolToken()}, token_changed_at = now(), version = version + 1, updated_by = ${ctx.actor.id}, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'patrol_point', targetType: 'patrol_point', targetId: id, detail: { op: 'rotate', name: p.name }, ip: ctx.ip });
    return getPoint(tx, id);
  });
}

// ───────────────────────── 打卡（员工端） ─────────────────────────

const CheckinInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新后再扫'),
  /** 扫码的员工（手机上这笔记在谁名下）：要与登录的员工一致——同一台手机换了人登录，上一位断网扫的不能记到这一位名下（Codex 审查 ae12728） */
  employeeId: z.number('缺少扫码的员工，请刷新后再扫').int().positive('缺少扫码的员工，请刷新后再扫'),
  /** 扫到的文字：整个地址（…#patrol=码）或单独的场所码 */
  code: z.string('请扫场所二维码').trim().min(1, '请扫场所二维码').max(500, '这不是巡场的场所码'),
  /** 扫到的时间（手机按服务器时间差修正过）：断网补交时是手机记下的时间 */
  scannedAt: z.iso.datetime({ offset: true, message: '扫到的时间格式不正确' }).optional(),
  via: z.enum(PATROL_VIAS, '扫码方式不正确').default('scan'),
});

/** 手机时间最多比门店快 2 分钟 */
const MAX_AHEAD_MS = 2 * MINUTE;

interface CheckinFull {
  id: number;
  employeeId: number;
  employeeName: string;
  pointName: string;
  area: string;
  scannedAt: string;
  recordedAt: string;
  businessDate: string;
  pointId: number;
}

async function checkinById(db: Db, where: Fragment): Promise<CheckinFull | null> {
  const [c] = await db<CheckinFull[]>`
    SELECT c.id, c.employee_id, c.employee_name, c.point_name, p.area, c.scanned_at, c.recorded_at, c.business_date, c.point_id
    FROM patrol_checkins c JOIN patrol_points p ON p.id = c.point_id WHERE ${where} ORDER BY c.scanned_at, c.id LIMIT 1`;
  return c ?? null;
}

async function resultOf(db: Db, c: CheckinFull, status: PatrolCheckinResult['status'], viewerId: number, rounds: readonly PatrolRoundSpan[]): Promise<PatrolCheckinResult> {
  const [n] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM patrol_checkins WHERE point_id = ${c.pointId} AND business_date = ${c.businessDate} AND voided_at IS NULL`;
  const late = Date.parse(c.recordedAt) - Date.parse(c.scannedAt) > PATROL_LATE_MINUTES * MINUTE;
  return {
    status,
    checkin: { id: Number(c.id), pointName: c.pointName, area: c.area, at: c.scannedAt, late, employeeName: c.employeeName, mine: Number(c.employeeId) === viewerId },
    round: patrolRoundAt(rounds, c.scannedAt),
    pointCount: n!.n,
  };
}

/**
 * 同一个操作编号已经交过：原样返回第一次的结果（回复没收到时重提、断网补交重复交）；别人的编号拒绝。
 * 记下的那一笔返回「打卡成功」；当时算作这一轮已经打过（「这一轮已打过卡」，8.0.9 是 2 分钟内重复）的，返回指向的那一条——
 * 那一条之后被作废也一样，不会因为重提再记一条新的（Codex 审查 94f53d5，迁移 112）
 */
async function replayedCheckin(db: Db, config: AppConfig, clientKey: string, employeeId: number): Promise<PatrolCheckinResult | null> {
  const c = await checkinById(db, db`c.client_key = ${clientKey}`);
  if (c) {
    if (Number(c.employeeId) !== employeeId) throw conflict('IDEMPOTENCY_CONFLICT', '这一笔的操作编号不对，请刷新后再扫');
    return resultOf(db, c, 'ok', employeeId, (await roundsOn(db, config, c.businessDate)).rounds);
  }
  const [r] = await db<{ checkinId: number; employeeId: number }[]>`SELECT checkin_id, employee_id FROM patrol_checkin_repeats WHERE client_key = ${clientKey}`;
  if (!r) return null;
  if (Number(r.employeeId) !== employeeId) throw conflict('IDEMPOTENCY_CONFLICT', '这一笔的操作编号不对，请刷新后再扫');
  const first = await checkinById(db, db`c.id = ${r.checkinId}`);
  return resultOf(db, first!, 'already', employeeId, (await roundsOn(db, config, first!.businessDate)).rounds);
}

/**
 * 巡场打卡：登录的员工要在巡场部门（XC1）；扫到的码要是启用场所的当前码（换过码的旧码认不出，XC8；停用的提示停用，XC9）；
 * 同一个场所每一轮只记一次打卡（XC14，不论是谁打的；8.0.9 的「同一个人 2 分钟内只记一次」并进这一条）；
 * 扫到的时间不能比门店快 2 分钟以上、不能是 24 小时以前（XC7）。
 */
export async function recordPatrolCheckin(
  deps: { sql: Sql; config: AppConfig },
  employee: CanteenSessionEmployee,
  raw: unknown,
  nowMs = Date.now(),
): Promise<PatrolCheckinResult> {
  const input = parse(CheckinInput, raw);
  const { sql, config } = deps;
  // 这一笔是别的员工扫的（这台手机后来换了人登录）：不记、不算拒绝，手机上留着等那一位登录再交
  if (input.employeeId !== employee.id)
    throw conflict('PATROL_OTHER_EMPLOYEE', '这台手机现在登录的是另一位员工：这一笔是之前那位扫的，留在手机上，等他登录以后再交');
  const replay = await replayedCheckin(sql, config, input.clientKey, employee.id);
  if (replay) return replay;
  const token = parsePatrolToken(input.code);
  if (!token) throw unprocessable('PATROL_CODE_INVALID', '这不是巡场的场所码：请扫贴在场所里的巡场二维码');
  const atMs = input.scannedAt ? Date.parse(input.scannedAt) : nowMs;
  if (atMs > nowMs + MAX_AHEAD_MS) throw unprocessable('CLOCK_AHEAD', '手机的时间比门店快太多了：请把手机时间设成「自动」再扫');
  if (atMs < nowMs - PATROL_MAX_LATE_HOURS * 60 * MINUTE) throw unprocessable('SCAN_TOO_OLD', `这一笔是 ${PATROL_MAX_LATE_HOURS} 小时以前扫的，太久了，不能补交`);
  const settings = await loadPatrolSettings(sql);
  const date = await patrolDateOf(sql, config, new Date(atMs));
  const { minutes, rounds } = await roundsOn(sql, config, date, settings);
  const round = patrolRoundAt(rounds, new Date(atMs));
  if (!round) throw unprocessable('PATROL_ROUND_UNKNOWN', '算不出这一笔在第几轮，请刷新后再扫');

  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 与停用、重新开通（对员工一行加排他锁）串行：停用之后不会再记进来
    const [e] = await tx<{ id: number; empNo: string; name: string; active: boolean; departmentId: number | null; department: string }[]>`
      SELECT e.id, e.emp_no, e.name, e.active, e.department_id, coalesce(d.name, '') AS department
      FROM canteen_employees e LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ${employee.id} FOR SHARE OF e`;
    if (!e || !e.active) throw forbidden('账号已停用，不能巡场打卡');
    if (e.departmentId === null || !settings.departmentIds.includes(Number(e.departmentId))) {
      throw forbidden('只有巡场部门（安保）的员工能巡场打卡；部门不对请找管理员改员工名单');
    }
    const [p] = await tx<{ id: number; name: string; area: string; active: boolean }[]>`SELECT id, name, area, active FROM patrol_points WHERE token = ${token}`;
    if (!p) throw unprocessable('PATROL_CODE_UNKNOWN', '认不出这个码：可能已经换过码了，请找管理员要新打印的码');
    // 同一个场所的打卡排队：判断这一轮有没有人打过时，同时扫的两笔不会都记上（XC14）
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`patrol:point:${p.id}`}, 0))`;
    const [point] = await tx<{ token: string; active: boolean; name: string }[]>`SELECT token, active, name FROM patrol_points WHERE id = ${p.id} FOR SHARE`;
    if (!point || point.token !== token) throw unprocessable('PATROL_CODE_UNKNOWN', '认不出这个码：刚换过码了，请找管理员要新打印的码');
    if (!point.active) throw unprocessable('PATROL_POINT_INACTIVE', `「${point.name}」已停用，不用巡了`);
    // 同一个编号在等锁时被另一个请求记下（并发重提）：原样返回
    const again = await replayedCheckin(tx, config, input.clientKey, e.id);
    if (again) return again;
    // 这一轮（按扫到的时间）这个场所已经有没作废的打卡：不另记（按时间找，巡场间隔当天改过也照样只认一条）
    const dup = await checkinById(
      tx,
      tx`c.point_id = ${p.id} AND c.voided_at IS NULL AND c.scanned_at >= ${new Date(round.start)} AND c.scanned_at < ${new Date(round.end)}`,
    );
    if (dup) {
      // 这一笔也记下操作编号：回复丢了原样重提时返回同样的「这一轮已打过卡」，不看那一条之后有没有被作废
      await tx`INSERT INTO patrol_checkin_repeats (client_key, checkin_id, employee_id) VALUES (${input.clientKey}, ${dup.id}, ${e.id})`;
      return resultOf(tx, dup, 'already', e.id, rounds);
    }
    try {
      await tx.savepoint(async (sp) => {
        await sp`
          INSERT INTO patrol_checkins (point_id, point_name, employee_id, emp_no, employee_name, department_name, business_date, scanned_at, via, client_key, round_start, round_minutes)
          VALUES (${p.id}, ${point.name}, ${e.id}, ${e.empNo}, ${e.name}, ${e.department}, ${date}, ${new Date(atMs)}, ${input.via}, ${input.clientKey},
                  ${new Date(round.start)}, ${minutes})`;
      });
    } catch (error) {
      // 同一轮的判断在锁里，这里只是兜底（巡场间隔刚好在这一刻改了）：请再扫一次，按新的间隔再判断
      if (isUniqueViolation(error, 'patrol_checkins_round_uq')) throw conflict('PATROL_ROUND_TAKEN', '这个场所这一轮刚有人打过卡：请再扫一次看看');
      throw error;
    }
    const c = await checkinById(tx, tx`c.client_key = ${input.clientKey}`);
    return resultOf(tx, c!, 'ok', e.id, rounds);
  });
}

// ───────────────────────── 每天的清单（后台「今天」、手机「巡场记录」） ─────────────────────────

/**
 * 一天的巡场清单：每个场所这一天的打卡，按轮分好（XC13–XC15）。一个场所在某一轮要不要巡：这一轮结束前建好的启用场所要巡；
 * 停用的场所只有这一轮有人巡过才列出来。今天的各轮按 nowMs 分成过去、正在巡、还没到。
 */
export async function patrolDay(db: Db, config: AppConfig, date: string, today: string, nowMs = Date.now()): Promise<PatrolDay> {
  const { minutes, rounds: spans } = await roundsOn(db, config, date);
  const points = await db<{ id: number; name: string; area: string; active: boolean; createdAt: string }[]>`
    SELECT p.id, p.name, p.area, p.active, p.created_at FROM patrol_points p
    WHERE p.active OR EXISTS (SELECT 1 FROM patrol_checkins c WHERE c.point_id = p.id AND c.business_date = ${date} AND c.voided_at IS NULL)
    ORDER BY p.sort_order, p.id`;
  const scans = await db<{ id: number; pointId: number; at: string; recordedAt: string; employeeId: number; name: string; empNo: string; via: PatrolDay['points'][number]['scans'][number]['via'] }[]>`
    SELECT c.id, c.point_id, c.scanned_at AS at, c.recorded_at, c.employee_id, c.employee_name AS name, c.emp_no, c.via
    FROM patrol_checkins c WHERE c.business_date = ${date} AND c.voided_at IS NULL ORDER BY c.scanned_at, c.id`;
  const byPoint = new Map<number, PatrolScan[]>();
  const people = new Map<number, PatrolDay['people'][number]>();
  for (const s of scans) {
    const late = Date.parse(s.recordedAt) - Date.parse(s.at) > PATROL_LATE_MINUTES * MINUTE;
    const list = byPoint.get(Number(s.pointId)) ?? [];
    list.push({ id: Number(s.id), at: s.at, employeeId: Number(s.employeeId), name: s.name, empNo: s.empNo, via: s.via, late });
    byPoint.set(Number(s.pointId), list);
    const p = people.get(Number(s.employeeId)) ?? { employeeId: Number(s.employeeId), name: s.name, empNo: s.empNo, count: 0 };
    p.count += 1;
    people.set(Number(s.employeeId), p);
  }
  const rows = points.map((p) => {
    const list = byPoint.get(Number(p.id)) ?? [];
    const created = Date.parse(p.createdAt);
    const byRound = spans.map((r) => {
      const inRound = list.filter((x) => Date.parse(x.at) >= Date.parse(r.start) && Date.parse(x.at) < Date.parse(r.end));
      if (inRound.length) return inRound;
      return p.active && created < Date.parse(r.end) ? [] : null;
    });
    return { id: Number(p.id), name: p.name, area: p.area, active: p.active, count: list.length, scans: list, byRound };
  });
  const rounds: PatrolRound[] = spans.map((r, i) => {
    const state: PatrolRound['state'] =
      date < today || nowMs >= Date.parse(r.end) ? 'past' : nowMs >= Date.parse(r.start) ? 'current' : 'future';
    const cells = rows.map((p) => p.byRound[i]).filter((x): x is PatrolScan[] => x !== null);
    return { ...r, state, expected: cells.length, done: cells.filter((x) => x.length > 0).length };
  });
  const current = rounds.find((r) => r.state === 'current') ?? null;
  return {
    date,
    today,
    roundMinutes: minutes,
    rounds,
    currentRound: current?.no ?? null,
    points: rows,
    people: [...people.values()].sort((a, b) => b.count - a.count || a.empNo.localeCompare(b.empNo)),
    total: scans.length,
    missed: rounds.filter((r) => r.state === 'past').reduce((n, r) => n + r.expected - r.done, 0),
    currentMissing: current ? current.expected - current.done : null,
  };
}

const DayQuery = z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() });

/** 后台「今天」：默认今天，可以看前几天（最多 92 天前） */
export async function patrolDayAdmin(db: Db, config: AppConfig, raw: unknown): Promise<PatrolDay> {
  const q = parse(DayQuery, raw);
  const today = await patrolDateOf(db, config, new Date());
  const date = q.date ?? today;
  checkDayInRange(date, today);
  return patrolDay(db, config, date, today);
}

function checkDayInRange(date: string, today: string) {
  if (date > today) throw badRequest('还没到这一天');
  if (daysBetween(date, today) > PATROL_MAX_DAYS) throw badRequest(`最多看 ${PATROL_MAX_DAYS} 天以前的`);
}

/** 手机上：巡场部门的人只看今天；后台指定的人看任何一天（XC2）。每次当场核对 */
export async function patrolDayPortal(db: Db, config: AppConfig, employee: CanteenSessionEmployee, raw: unknown, nowMs = Date.now()): Promise<PatrolPortalDay> {
  const q = parse(DayQuery, raw);
  const access = await patrolAccess(db, employee.id);
  if (!access.scan && !access.view) throw forbidden('巡场只有安保部门和管理员指定的人能看');
  const today = await patrolDateOf(db, config, new Date(nowMs));
  const date = q.date ?? today;
  if (date !== today && !access.view) throw forbidden('只能看今天的巡场；要看以前的请找管理员');
  checkDayInRange(date, today);
  const day = await patrolDay(db, config, date, today, nowMs);
  const mine = day.points.reduce((n, p) => n + p.scans.filter((s) => s.employeeId === employee.id).length, 0);
  return { ...day, mine, canViewHistory: access.view };
}

// ───────────────────────── 巡场记录、导出、作废（后台） ─────────────────────────

export const RecordsQuery = z.object({
  from: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
  to: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
  pointId: z.coerce.number().int().positive().optional(),
  employeeId: z.coerce.number().int().positive().optional(),
  /** 列不列作废的（默认列，作废的单独标出来） */
  voided: z.enum(['include', 'exclude']).default('include'),
});
export type PatrolRecordsQuery = z.output<typeof RecordsQuery>;

export async function patrolRecords(db: Db, config: AppConfig, raw: unknown): Promise<PatrolRecords> {
  const q = parse(RecordsQuery, raw);
  if (q.from > q.to) throw badRequest('开始日期不能晚于结束日期');
  if (daysBetween(q.from, q.to) >= PATROL_MAX_DAYS) throw badRequest(`一次最多查 ${PATROL_MAX_DAYS} 天`);
  const rows = await db<Omit<PatrolCheckinRow, 'roundNo'>[]>`
    SELECT c.id, c.point_id, c.point_name, c.employee_id, c.emp_no, c.employee_name AS name, c.department_name AS department,
           c.business_date, c.scanned_at, c.recorded_at, c.via,
           (c.recorded_at - c.scanned_at) > ${`${PATROL_LATE_MINUTES} minutes`}::interval AS late,
           c.voided_at, c.void_reason, s.display_name AS voided_by_name
    FROM patrol_checkins c LEFT JOIN staff s ON s.id = c.voided_by
    WHERE c.business_date BETWEEN ${q.from} AND ${q.to}
      AND ${q.pointId ? db`c.point_id = ${q.pointId}` : db`true`}
      AND ${q.employeeId ? db`c.employee_id = ${q.employeeId}` : db`true`}
      AND ${q.voided === 'exclude' ? db`c.voided_at IS NULL` : db`true`}
    ORDER BY c.scanned_at DESC, c.id DESC`;
  // 每条在那一天的第几轮（按那一天的巡场间隔）
  const settings = await loadPatrolSettings(db);
  const roundsByDate = new Map<string, PatrolRoundSpan[]>();
  for (const date of new Set(rows.map((r) => r.businessDate))) roundsByDate.set(date, (await roundsOn(db, config, date, settings)).rounds);
  const list = rows.map((r) => ({
    ...r,
    id: Number(r.id),
    pointId: Number(r.pointId),
    employeeId: Number(r.employeeId),
    roundNo: patrolRoundAt(roundsByDate.get(r.businessDate) ?? [], r.scannedAt)?.no ?? null,
  }));
  return { rows: list, total: list.filter((r) => !r.voidedAt).length, voided: list.filter((r) => r.voidedAt).length };
}

/** 导出（与页面同一个查询）：最后一行是合计（没作废的条数） */
export function patrolRecordsCsv(r: PatrolRecords, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const time = (iso: string) => fmt.format(new Date(iso)).replace(/\//g, '-');
  const rows: (string | number)[][] = [['营业日', '轮次', '扫到的时间', '入库时间', '场所', '工号', '姓名', '部门', '怎么扫的', '离线补登', '状态', '作废原因', '作废人']];
  for (const x of r.rows) {
    rows.push([
      x.businessDate,
      x.roundNo ? `第 ${x.roundNo} 轮` : '',
      time(x.scannedAt),
      time(x.recordedAt),
      x.pointName,
      x.empNo,
      x.name,
      x.department,
      PATROL_VIA_LABELS[x.via],
      x.late ? '是' : '',
      x.voidedAt ? '已作废' : '有效',
      x.voidReason ?? '',
      x.voidedByName ?? '',
    ]);
  }
  rows.push(['合计', '', `${r.total} 次`, '', '', '', '', '', '', '', r.voided ? `另有作废 ${r.voided} 次` : '', '', '']);
  return toCsv(rows);
}

const VoidInput = z.object({
  reason: z.string('请写作废原因').trim().min(1, '请写作废原因').max(MAX_PATROL_VOID_REASON, `原因最多 ${MAX_PATROL_VOID_REASON} 字`),
});

/** 作废一条打卡（XC10）：只做标记、不删；已经作废的原样返回 */
export async function voidPatrolCheckin(sql: Sql, id: number, raw: unknown, ctx: OpContext): Promise<{ id: number; voidedAt: string }> {
  const input = parse(VoidInput, raw);
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [c] = await tx<{ voidedAt: string | null; pointName: string; employeeName: string; scannedAt: string }[]>`
      SELECT voided_at, point_name, employee_name, scanned_at FROM patrol_checkins WHERE id = ${id} FOR UPDATE`;
    if (!c) throw notFound('没有这条巡场记录');
    if (c.voidedAt) return { id, voidedAt: c.voidedAt };
    const [u] = await tx<{ voidedAt: string }[]>`
      UPDATE patrol_checkins SET voided_at = now(), void_reason = ${input.reason}, voided_by = ${ctx.actor.id} WHERE id = ${id} RETURNING voided_at`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'patrol_checkin_void',
      targetType: 'patrol_checkin',
      targetId: id,
      detail: { point: c.pointName, employee: c.employeeName, scannedAt: c.scannedAt, reason: input.reason },
      ip: ctx.ip,
    });
    return { id, voidedAt: u!.voidedAt };
  });
}

/** 营业日的前一天、后一天（手机上翻日期用） */
export const shiftPatrolDate = addDays;
