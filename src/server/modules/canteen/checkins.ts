// 员工食堂 · 打卡（docs/CANTEEN.md 第 6 节）：负责人扫码或手动登记、撤销；今天的统计；管理后台的记录与导出。
//
// 每人每餐只记一次（部分唯一索引兜底），同一个操作编号重提返回第一次的结果。断网时负责人手机先记下、之后补交，
// 服务端按扫到的时间（scannedAt，只收 24 小时内）核对饭卡码、定餐次。
// 锁：先对那位员工一行加共享锁（与停用、重新开通串行），再写打卡；撤销只锁那条打卡。

import { z } from 'zod';
import {
  mealAt,
  MEAL_LABELS,
  MEALS,
  mealWindowText,
  parseCanteenCode,
  type CanteenCheckinRow,
  type CanteenPerson,
  type CanteenToday,
  type CheckinResult,
  type Meal,
} from '@shared/canteen';
import { businessDateOf } from '@shared/business-date';
import type { Db, Fragment, Sql } from '../../db';
import type { AppConfig } from '../../config';
import { AppError, badRequest, forbidden, notFound, unprocessable } from '../../lib/errors';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { checkCanteenCode } from './code';
import type { CanteenSessionEmployee } from './portal-auth';
import { loadCanteenSettings } from './settings';

/** 断网补登只收 24 小时内扫到的（K5）；手机时间最多比门店快 2 分钟 */
const MAX_LATE_MS = 24 * 3_600_000;
const MAX_AHEAD_MS = 2 * 60_000;

const ROW = (db: Db) => db`
  SELECT c.id, c.employee_id, c.emp_no, c.employee_name AS name, c.department_name AS department, e.avatar,
         to_char(c.meal_date, 'YYYY-MM-DD') AS date, c.meal, c.method, c.note, c.scanned_at, c.recorded_at, c.recorder_name,
         c.voided_at, c.void_reason, coalesce(ve.name, vs.display_name) AS voided_by_name
  FROM canteen_checkins c
  JOIN canteen_employees e ON e.id = c.employee_id
  LEFT JOIN canteen_employees ve ON ve.id = c.voided_by_employee
  LEFT JOIN staff vs ON vs.id = c.voided_by_staff`;

async function checkinRow(db: Db, where: Fragment): Promise<CanteenCheckinRow | undefined> {
  const [row] = await db<CanteenCheckinRow[]>`${ROW(db)} WHERE ${where}`;
  return row;
}

async function mealCount(db: Db, date: string, meal: Meal): Promise<number> {
  const [r] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_checkins WHERE meal_date = ${date} AND meal = ${meal} AND voided_at IS NULL`;
  return r!.n;
}

const CheckinInput = z
  .object({
    clientKey: z.uuid('操作编号不正确'),
    code: z.string().max(80, '这不是柚子饭堂的饭卡码').optional(),
    employeeId: z.number().int().positive('员工不正确').optional(),
    /** 扫到的时间（断网补登时是手机记下的时间）；不给为此刻 */
    scannedAt: z.iso.datetime({ offset: true, message: '扫码时间不正确' }).optional(),
    note: z.string().trim().max(100, '备注最多 100 字').default(''),
  })
  .refine((x) => (x.code === undefined) !== (x.employeeId === undefined), '扫码和手动登记只能选一种');

/**
 * 负责人登记一笔：扫码（code）或手动（employeeId）。返回 ok（这次记下的）或 already（这一餐已经有了，不再多记）。
 * 码不对、过期、员工停用、不在开饭时间都明确拒绝（4xx，负责人手机不再补交）。
 */
export async function recordCheckin(deps: { sql: Sql; config: AppConfig }, recorder: CanteenSessionEmployee, raw: unknown, nowMs = Date.now()): Promise<CheckinResult> {
  const input = parse(CheckinInput, raw);
  const { sql, config } = deps;
  const secret = config.canteen.codeSecret;
  if (!secret) throw new AppError(503, 'CANTEEN_CODE_UNAVAILABLE', '门店系统没有配饭卡码的密钥，请联系管理员');
  // 同一个操作编号已经记过：原样返回（回复没收到时重提、断网补登重复交）
  const replay = await replayed(sql, input.clientKey);
  if (replay) return replay;

  const atMs = input.scannedAt ? Date.parse(input.scannedAt) : nowMs;
  if (atMs > nowMs + MAX_AHEAD_MS) throw unprocessable('CLOCK_AHEAD', '负责人手机的时间比门店快太多了：请把手机时间设成「自动」再扫');
  if (atMs < nowMs - MAX_LATE_MS) throw unprocessable('SCAN_TOO_OLD', '这一笔是 24 小时以前扫的，太久了，不能补登');
  const settings = await loadCanteenSettings(sql);
  const slot = mealAt(settings.meals, new Date(atMs), config.timezone);
  if (!slot) {
    const open = settings.meals.filter((m) => m.enabled).map(mealWindowText).join('，');
    throw unprocessable('NOT_MEAL_TIME', `现在不是开饭时间（${open || '还没设开饭时间'}）`);
  }

  let employeeId: number;
  let code: ReturnType<typeof parseCanteenCode> = null;
  if (input.code !== undefined) {
    code = parseCanteenCode(input.code);
    if (!code) throw unprocessable('CODE_INVALID', '这不是柚子饭堂的饭卡码');
    employeeId = code.employeeId;
  } else {
    employeeId = input.employeeId!;
  }

  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 与停用、重新开通（对员工一行加排他锁）串行：停用之后不会再记进来
    const [e] = await tx<{ id: number; empNo: string; name: string; active: boolean; codeEpoch: number; department: string }[]>`
      SELECT e.id, e.emp_no, e.name, e.active, e.code_epoch, coalesce(d.name, '') AS department
      FROM canteen_employees e LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ${employeeId} FOR SHARE OF e`;
    if (!e) throw code ? unprocessable('CODE_INVALID', '这不是柚子饭堂的饭卡码') : notFound('没有这位员工');
    if (!e.active) throw unprocessable('EMPLOYEE_INACTIVE', `${e.name}（${e.empNo}）已停用，不能在饭堂打卡`);
    if (code) {
      const check = checkCanteenCode(secret, e.id, e.codeEpoch, code.step, code.mac, atMs);
      if (check === 'invalid') throw unprocessable('CODE_INVALID', '码对不上：请对方打开柚子饭堂、联网刷新一下再扫');
      if (check === 'expired') throw unprocessable('CODE_EXPIRED', '码过期了（截图或停在后台太久）：请对方刷新一下再扫');
    }
    const [inserted] = await tx<{ id: number }[]>`
      INSERT INTO canteen_checkins (employee_id, emp_no, employee_name, department_name, meal_date, meal, method, note,
                                    scanned_at, recorder_id, recorder_name, client_key)
      VALUES (${e.id}, ${e.empNo}, ${e.name}, ${e.department}, ${slot.date}, ${slot.meal}, ${code ? 'scan' : 'manual'}, ${input.note},
              ${new Date(atMs)}, ${recorder.id}, ${recorder.name}, ${input.clientKey})
      ON CONFLICT DO NOTHING RETURNING id`;
    if (inserted) {
      return { status: 'ok' as const, checkin: (await checkinRow(tx, tx`c.id = ${inserted.id}`))!, mealCount: await mealCount(tx, slot.date, slot.meal) };
    }
    // 没插进去：要么同一个操作编号刚被另一个请求记下（并发重提），要么这一餐已经打过卡
    const again = await replayed(tx, input.clientKey);
    if (again) return again;
    const first = await checkinRow(tx, tx`c.employee_id = ${e.id} AND c.meal_date = ${slot.date} AND c.meal = ${slot.meal} AND c.voided_at IS NULL`);
    if (!first) throw new AppError(409, 'BUSY', '刚好有人在改这位员工的打卡，请再扫一次');
    return { status: 'already' as const, checkin: first, mealCount: await mealCount(tx, slot.date, slot.meal) };
  });
}

async function replayed(db: Db, clientKey: string): Promise<CheckinResult | null> {
  const row = await checkinRow(db, db`c.client_key = ${clientKey}`);
  return row ? { status: 'ok', checkin: row, mealCount: await mealCount(db, row.date, row.meal) } : null;
}

const VoidInput = z.object({ reason: z.string('请写撤销原因').trim().min(1, '请写撤销原因').max(100, '原因最多 100 字') });

/**
 * 撤销一笔（只做标记、不删，K9）：负责人只能撤销自己当天（门店日期）登记的；管理员随时可以。已经撤销过的原样返回。
 */
export async function voidCheckin(
  sql: Sql,
  id: number,
  raw: unknown,
  by: { employee: CanteenSessionEmployee } | { staffId: number },
  timeZone: string,
): Promise<CanteenCheckinRow> {
  const { reason } = parse(VoidInput, raw);
  return sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [c] = await tx<{ recorderId: number; voidedAt: string | null; recordedAt: string }[]>`
      SELECT recorder_id, voided_at, recorded_at FROM canteen_checkins WHERE id = ${id} FOR UPDATE`;
    if (!c) throw notFound('没有这条打卡记录');
    if (c.voidedAt) return (await checkinRow(tx, tx`c.id = ${id}`))!;
    if ('employee' in by) {
      if (c.recorderId !== by.employee.id) throw forbidden('只能撤销自己登记的打卡；别人登记的请找管理员在后台撤销');
      if (businessDateOf(new Date(c.recordedAt), timeZone, 0) !== businessDateOf(new Date(), timeZone, 0)) {
        throw forbidden('只能撤销今天登记的；更早的请找管理员在后台撤销');
      }
    }
    await tx`
      UPDATE canteen_checkins SET voided_at = now(), void_reason = ${reason},
             voided_by_employee = ${'employee' in by ? by.employee.id : null}, voided_by_staff = ${'staffId' in by ? by.staffId : null}
      WHERE id = ${id}`;
    return (await checkinRow(tx, tx`c.id = ${id}`))!;
  });
}

/** 饭堂的「今天」：正在开饭的那一餐所在的日子（夜宵过了午夜仍算前一天），不在开饭时间时是门店日期 */
export async function canteenToday(db: Db, config: AppConfig, nowMs = Date.now()): Promise<CanteenToday> {
  const settings = await loadCanteenSettings(db);
  const now = new Date(nowMs);
  const current = mealAt(settings.meals, now, config.timezone);
  const today = current?.date ?? businessDateOf(now, config.timezone, 0);
  const rows = await db<{ meal: Meal; n: number }[]>`
    SELECT meal, count(*)::int AS n FROM canteen_checkins WHERE meal_date = ${today} AND voided_at IS NULL GROUP BY meal`;
  const counts = Object.fromEntries(MEALS.map((m) => [m, rows.find((r) => r.meal === m)?.n ?? 0])) as Record<Meal, number>;
  const recent = await db<CanteenCheckinRow[]>`${ROW(db)} WHERE c.meal_date = ${today} ORDER BY c.recorded_at DESC, c.id DESC LIMIT 30`;
  return { today, current, meals: settings.meals, counts, recent };
}

/** 手动登记时搜人：在用的员工，按工号或姓名；标出现在这一餐打过卡没有 */
export async function searchPeople(db: Db, config: AppConfig, rawQ: unknown, nowMs = Date.now()): Promise<CanteenPerson[]> {
  const q = parse(z.string().trim().max(20).default(''), rawQ ?? '');
  const settings = await loadCanteenSettings(db);
  const slot = mealAt(settings.meals, new Date(nowMs), config.timezone);
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return db<CanteenPerson[]>`
    SELECT e.id, e.emp_no, e.name, coalesce(d.name, '') AS department, e.avatar,
           ${slot ? db`EXISTS (SELECT 1 FROM canteen_checkins c WHERE c.employee_id = e.id AND c.meal_date = ${slot.date}
                                AND c.meal = ${slot.meal} AND c.voided_at IS NULL)` : db`false`} AS checked_in
    FROM canteen_employees e LEFT JOIN departments d ON d.id = e.department_id
    WHERE e.active AND (${q} = '' OR e.emp_no ILIKE ${like} OR e.name ILIKE ${like})
    ORDER BY e.emp_no LIMIT 30`;
}

/** 我在某个月的打卡（员工端「我的」） */
export async function myCheckins(db: Db, employeeId: number, rawMonth: unknown): Promise<CanteenCheckinRow[]> {
  const month = parse(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份写成 YYYY-MM'), rawMonth);
  return db<CanteenCheckinRow[]>`
    ${ROW(db)} WHERE c.employee_id = ${employeeId} AND c.voided_at IS NULL AND to_char(c.meal_date, 'YYYY-MM') = ${month}
    ORDER BY c.meal_date DESC, c.scanned_at DESC LIMIT 200`;
}

/** 这个月吃了几顿（门店日期所在的月） */
export async function mealsThisMonth(db: Db, employeeId: number, today: string): Promise<number> {
  const [r] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM canteen_checkins
    WHERE employee_id = ${employeeId} AND voided_at IS NULL AND to_char(meal_date, 'YYYY-MM') = ${today.slice(0, 7)}`;
  return r!.n;
}

const ListInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD'),
  meal: z.enum(MEALS).optional(),
  q: z.string().trim().max(20).optional(),
  voided: z.enum(['include', 'exclude', 'only']).default('include'),
});

/** 筛选条件（日期区间最多 93 天） */
function checkinFilter(db: Db, raw: unknown): Fragment {
  const f = parse(ListInput, raw);
  if (f.from > f.to) throw badRequest('开始日期不能晚于结束日期');
  if ((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 > 93) throw badRequest('一次最多查 93 天');
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  return db`c.meal_date BETWEEN ${f.from} AND ${f.to}
      ${f.meal ? db`AND c.meal = ${f.meal}` : db``}
      ${like ? db`AND (c.emp_no ILIKE ${like} OR c.employee_name ILIKE ${like})` : db``}
      ${f.voided === 'exclude' ? db`AND c.voided_at IS NULL` : f.voided === 'only' ? db`AND c.voided_at IS NOT NULL` : db``}`;
}

/** 页面上一次最多列这么多条；更多的看合计、导出表格（导出不截断） */
export const CHECKIN_PAGE_LIMIT = 2000;

/** 管理后台的用餐记录：按日期区间、餐次、工号或姓名筛选。limit 为 null 时全部（导出用） */
export async function listCheckins(db: Db, raw: unknown, limit: number | null = CHECKIN_PAGE_LIMIT): Promise<CanteenCheckinRow[]> {
  const where = checkinFilter(db, raw);
  return db<CanteenCheckinRow[]>`
    ${ROW(db)} WHERE ${where}
    ORDER BY c.meal_date DESC, c.scanned_at DESC, c.id DESC ${limit === null ? db`` : db`LIMIT ${limit}`}`;
}

/** 同样的筛选：一共几条、其中没撤销的几条 */
export async function countCheckins(db: Db, raw: unknown): Promise<{ total: number; valid: number }> {
  const where = checkinFilter(db, raw);
  const [r] = await db<{ total: number; valid: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE c.voided_at IS NULL)::int AS valid FROM canteen_checkins c WHERE ${where}`;
  return r!;
}

/** 导出用的表格行（第一行是表头） */
export function checkinCsvRows(rows: CanteenCheckinRow[], timeZone: string): (string | number)[][] {
  const time = (iso: string) =>
    new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return [
    ['日期', '餐次', '工号', '姓名', '部门', '方式', '扫到的时间', '登记人', '备注', '状态', '撤销原因'],
    ...rows.map((r) => [
      r.date,
      MEAL_LABELS[r.meal],
      r.empNo,
      r.name,
      r.department,
      r.method === 'scan' ? '扫码' : '手动',
      time(r.scannedAt),
      r.recorderName,
      r.note,
      r.voidedAt ? '已撤销' : '有效',
      r.voidReason ?? '',
    ]),
  ];
}

/** 最近几天每天各餐人数（管理后台概览） */
export async function dailyCounts(db: Db, from: string, to: string): Promise<{ date: string; counts: Record<Meal, number> }[]> {
  const rows = await db<{ date: string; meal: Meal; n: number }[]>`
    SELECT to_char(meal_date, 'YYYY-MM-DD') AS date, meal, count(*)::int AS n FROM canteen_checkins
    WHERE meal_date BETWEEN ${from} AND ${to} AND voided_at IS NULL GROUP BY meal_date, meal`;
  const out: { date: string; counts: Record<Meal, number> }[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    out.push({ date, counts: Object.fromEntries(MEALS.map((m) => [m, rows.find((r) => r.date === date && r.meal === m)?.n ?? 0])) as Record<Meal, number> });
  }
  return out;
}

