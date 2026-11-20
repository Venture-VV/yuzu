// 技师管理（8.1.15，docs/TECHNICIANS_V8115.md；《浴族系统需求汇总》技师 3）：门店页面「技师管理」的四个页签。
//   · 名册：花名、类型、入职日期在 technicians.ts 的名册接口里（与后台的名册卡片同一组接口）；这里只管类型的清单。
//   · 组别：分组与组长，一位技师一个组。
//   · 班次：班次的名字与起止时间、排班表（一位技师一天一格）、临时调班（改当天已经排了的格子、两人对调，要写原因）。
//     排班的每一次改动都另记一条（technician_schedule_changes，只追加）。
//   · 休假：申请（钟房的岗位替技师提）→ 批准 / 驳回（维护技师名册的岗位）；批了的在那几天不进排位——钟房读的时候按休假单算
//     （technician-day.ts 的 approvedLeavesOn），不靠定时任务；批准、销假时休假含今天的，同一个事务里把今天的上牌状态也改了。
//
// 加锁（docs/LOCKING.md 第 1 节）：
//   · 组别、班次、排班：先取「技师管理」咨询锁（这几样之间串行）→ 组别 / 班次一行 → 技师（id 升序，FOR NO KEY UPDATE）→ 排班格；
//   · 休假申请：技师一行（FOR UPDATE，同一位技师的休假单串行）→ 写休假单；
//   · 休假的批准、驳回、撤回、销假：技师队列 → 技师一行（FOR UPDATE）→ 休假单一行 → 技师状态（与钟房的休假、停牌同一个顺序）。
// 这里不取技师队列之后再取「技师管理」咨询锁，反过来也不取，两组不会互相等。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { shiftDate } from '@shared/labels';
import { can } from '@shared/permissions';
import {
  LEAVE_AHEAD_DAYS,
  LEAVE_MAX_DAYS,
  LEAVE_STATUS_LABELS,
  LEAVE_STATUSES,
  LEAVE_TYPE_LABELS,
  LEAVE_TYPES,
  leaveRangeText,
  MAX_GROUP_NAME,
  MAX_SHIFT_NAME,
  MAX_TECH_KIND,
  MAX_TECH_KINDS,
  SCHEDULE_AHEAD_DAYS,
  SCHEDULE_MAX_DAYS,
  shiftTimeText,
  type LeaveStatus,
  type LeaveType,
  type RosterTechnician,
  type ScheduleCell,
  type ScheduleChange,
  type ScheduleChangeKind,
  type ScheduleView,
  type TechGroup,
  type TechLeave,
  type TechnicianAdminView,
  type TechShift,
} from '@shared/technician-admin';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { ctxOf } from '../lib/context';
import { daysBetween } from '../lib/dates';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { saveRuleSetting } from '../lib/rule-settings';
import { currentStoreId, DEFAULT_STORE_ID } from '../lib/store-context';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { lockQueue, syncLeaveToday } from './clockroom';
import { businessDate } from './frontdesk/common';
import { approvedLeavesOn, groupNames, scheduleOn } from './technician-day';
import { loadTechnicianKinds, loadTechnicians } from './technicians';

/** 组别、班次、排班的保存之间串行（都是管理动作，不频繁）；按门店各一把 */
const lockTechAdmin = (tx: Tx) => tx`SELECT pg_advisory_xact_lock(hashtext(${currentStoreId() === DEFAULT_STORE_ID ? 'technician_admin' : `technician_admin:${currentStoreId()}`}))`;

const todayOf = (db: Db, deps: Deps) => businessDate(db, deps, new Date());
const dateInput = (label: string) => z.string(`请填写${label}`).regex(ISO_DATE, `${label}格式应为 YYYY-MM-DD`);
const unique = (ids: number[]) => [...new Set(ids)];

// ───────────────────────── 总览、类型清单 ─────────────────────────

async function loadGroups(db: Db): Promise<TechGroup[]> {
  const rows = await db<Omit<TechGroup, 'memberIds'>[]>`
    SELECT id, name, leader_id, sort_order, active, note FROM technician_groups WHERE store_id = ${currentStoreId()} ORDER BY active DESC, sort_order, id`;
  const members = await db<{ id: number; groupId: number }[]>`SELECT id, group_id FROM technicians WHERE group_id IS NOT NULL AND store_id = ${currentStoreId()} ORDER BY id`;
  return rows.map((g) => ({ ...g, memberIds: members.filter((m) => m.groupId === g.id).map((m) => m.id) }));
}

const loadShifts = (db: Db) =>
  db<TechShift[]>`
    SELECT id, name, start_minute, end_minute, sort_order, active FROM technician_shifts WHERE store_id = ${currentStoreId()} ORDER BY active DESC, sort_order, start_minute, id`;

async function adminView(db: Db, deps: Deps, canManage: boolean): Promise<TechnicianAdminView> {
  const today = await todayOf(db, deps);
  const names = await groupNames(db);
  const schedule = await scheduleOn(db, today);
  const leaves = new Map((await approvedLeavesOn(db, today)).map((l) => [l.technicianId, l]));
  const technicians: RosterTechnician[] = [...(await loadTechnicians(db)).values()].map((t) => {
    const leave = leaves.get(t.id);
    return {
      ...t,
      groupName: t.groupId === null ? null : (names.get(t.groupId) ?? null),
      shiftToday: schedule.get(t.id)?.shift ?? null,
      restToday: schedule.get(t.id)?.rest ?? false,
      leaveToday: leave ? { id: leave.id, fromDate: leave.fromDate, toDate: leave.toDate, leaveType: leave.leaveType } : null,
    };
  });
  const categories = await db<{ category: string }[]>`
    SELECT coalesce(nullif(category, ''), '其他') AS category FROM service_items GROUP BY 1 ORDER BY min(sort_order), min(id)`;
  const [pending] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM technician_leaves WHERE status = 'pending' AND store_id = ${currentStoreId()}`;
  return {
    businessDate: today,
    canManage,
    kinds: await loadTechnicianKinds(db),
    categories: categories.map((c) => c.category),
    technicians,
    groups: await loadGroups(db),
    shifts: await loadShifts(db),
    pendingLeaves: pending!.n,
  };
}

const KindsInput = z.object({
  kinds: z
    .array(z.string().trim().min(1, '类型不能为空').max(MAX_TECH_KIND, `类型最多 ${MAX_TECH_KIND} 个字`))
    .min(1, '至少留一个类型')
    .max(MAX_TECH_KINDS, `类型最多 ${MAX_TECH_KINDS} 个`)
    .refine((list) => new Set(list).size === list.length, '类型不能重复'),
});

// ───────────────────────── 组别 ─────────────────────────

const GroupInput = z.object({
  name: z.string().trim().min(1, '请填写组名').max(MAX_GROUP_NAME, `组名最多 ${MAX_GROUP_NAME} 个字`),
  leaderId: z.number().int().positive().nullable().default(null),
  memberIds: z.array(z.number().int().positive()).max(300, '一个组最多 300 人').default([]).transform(unique),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  note: z.string().trim().max(100, '备注最多 100 字').default(''),
  active: z.boolean().default(true),
});

/**
 * 新建、修改组别。组员整份提交：名单里的技师归到这个组（原来在别的组的挪过来，他原来是那个组的组长的，那个组没有组长了），
 * 不在名单里、原来在这个组的退出；组长算组员。停用的组不留组员与组长。
 */
async function saveGroup(deps: Deps, id: number | null, raw: unknown, ctx: OpContext): Promise<void> {
  const g = parse(GroupInput, raw);
  const leaderId = g.active ? g.leaderId : null;
  const memberIds = g.active ? unique([...g.memberIds, ...(leaderId ? [leaderId] : [])]).sort((a, b) => a - b) : [];
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockTechAdmin(tx);
      let groupId = id;
      let before: { name: string; leaderId: number | null; active: boolean } | undefined;
      if (groupId === null) {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO technician_groups (name, sort_order, active, note, created_by) VALUES (${g.name}, ${g.sortOrder}, ${g.active}, ${g.note}, ${ctx.actor.id}) RETURNING id`;
        groupId = row!.id;
      } else {
        [before] = await tx<{ name: string; leaderId: number | null; active: boolean }[]>`
          SELECT name, leader_id, active FROM technician_groups WHERE id = ${groupId} AND store_id = ${currentStoreId()} FOR NO KEY UPDATE`;
        if (!before) throw notFound('组别不存在，请刷新');
      }
      // 这次要动的技师：名单里的，加上原来在这个组的（id 升序加锁）
      const rows = await tx<{ id: number; techNo: string; name: string; active: boolean; groupId: number | null }[]>`
        SELECT id, tech_no, name, active, group_id FROM technicians
        WHERE store_id = ${currentStoreId()} AND (group_id = ${groupId} ${memberIds.length ? tx`OR id IN ${tx(memberIds)}` : tx``})
        ORDER BY id FOR NO KEY UPDATE`;
      const members = rows.filter((r) => memberIds.includes(r.id));
      if (members.length !== memberIds.length || members.some((m) => !m.active)) throw unprocessable('GROUP_MEMBER_INVALID', '名单里有技师不存在或已停用，请刷新后重新选');
      const leaving = rows.filter((r) => r.groupId === groupId && !memberIds.includes(r.id)).map((r) => r.id);
      if (leaving.length) await tx`UPDATE technicians SET group_id = NULL, updated_at = now() WHERE id IN ${tx(leaving)}`;
      const joining = members.filter((m) => m.groupId !== groupId);
      if (joining.length) {
        const ids = joining.map((m) => m.id);
        await tx`UPDATE technician_groups SET leader_id = NULL, updated_at = now() WHERE leader_id IN ${tx(ids)} AND id <> ${groupId}`;
        await tx`UPDATE technicians SET group_id = ${groupId}, updated_at = now() WHERE id IN ${tx(ids)}`;
      }
      await tx`
        UPDATE technician_groups SET name = ${g.name}, leader_id = ${leaderId}, sort_order = ${g.sortOrder}, active = ${g.active}, note = ${g.note}, updated_at = now()
        WHERE id = ${groupId}`;
      const leader = members.find((m) => m.id === leaderId);
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'technician_group',
        targetType: 'technician_group',
        targetId: groupId,
        detail: {
          name: g.name,
          before: before ?? null,
          after: { ...g, leaderId, memberIds },
          summary: `${id === null ? '新建' : '修改'}技师组别「${g.name}」：${g.active ? `${memberIds.length} 人${leader ? `，组长 ${leader.techNo} 号 ${leader.name}` : '，没有组长'}` : '已停用'}`,
        },
        ip: ctx.ip,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'technician_groups_name_uq')) throw conflict('GROUP_NAME_TAKEN', `已经有叫「${g.name}」的组别（停用的也算），请换一个名字`);
    throw error;
  }
}

// ───────────────────────── 班次 ─────────────────────────

const minute = (label: string) => z.number(`请填写${label}`).int().min(0, `${label}不正确`).max(1439, `${label}不正确`);

const ShiftInput = z
  .object({
    name: z.string().trim().min(1, '请填写班次的名字').max(MAX_SHIFT_NAME, `班次的名字最多 ${MAX_SHIFT_NAME} 个字`),
    startMinute: minute('开始时间'),
    endMinute: minute('结束时间'),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    active: z.boolean().default(true),
  })
  .refine((s) => s.startMinute !== s.endMinute, '开始和结束不能是同一个时间');

async function saveShift(deps: Deps, id: number | null, raw: unknown, ctx: OpContext): Promise<void> {
  const s = parse(ShiftInput, raw);
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockTechAdmin(tx);
      let shiftId = id;
      let before: TechShift | undefined;
      if (shiftId === null) {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO technician_shifts (name, start_minute, end_minute, sort_order, active, created_by)
          VALUES (${s.name}, ${s.startMinute}, ${s.endMinute}, ${s.sortOrder}, ${s.active}, ${ctx.actor.id}) RETURNING id`;
        shiftId = row!.id;
      } else {
        [before] = await tx<TechShift[]>`
          SELECT id, name, start_minute, end_minute, sort_order, active FROM technician_shifts WHERE id = ${shiftId} AND store_id = ${currentStoreId()} FOR NO KEY UPDATE`;
        if (!before) throw notFound('班次不存在，请刷新');
        await tx`
          UPDATE technician_shifts SET name = ${s.name}, start_minute = ${s.startMinute}, end_minute = ${s.endMinute}, sort_order = ${s.sortOrder}, active = ${s.active},
                 updated_at = now()
          WHERE id = ${shiftId}`;
      }
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'technician_shift',
        targetType: 'technician_shift',
        targetId: shiftId,
        detail: { name: s.name, before: before ?? null, after: s, summary: `${id === null ? '新建' : '修改'}技师班次「${s.name}」${shiftTimeText(s)}${s.active ? '' : '（已停用）'}` },
        ip: ctx.ip,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'technician_shifts_name_uq')) throw conflict('SHIFT_NAME_TAKEN', `已经有叫「${s.name}」的班次（停用的也算），请换一个名字`);
    throw error;
  }
}

// ───────────────────────── 排班表、临时调班 ─────────────────────────

const cellsBetween = (db: Db, from: string, to: string) =>
  db<ScheduleCell[]>`
    SELECT c.technician_id, c.work_date AS "date", c.shift_id, c.is_rest AS rest
    FROM technician_schedule c JOIN technicians t ON t.id = c.technician_id
    WHERE c.work_date BETWEEN ${from} AND ${to} AND t.store_id = ${currentStoreId()} ORDER BY c.work_date, c.technician_id`;

async function scheduleView(db: Db, deps: Deps, from: string, days: number): Promise<ScheduleView> {
  const to = shiftDate(from, days - 1);
  const cells = (await cellsBetween(db, from, to)).filter((c) => c.rest || c.shiftId !== null);
  const leaves = await db<ScheduleView['leaves']>`
    SELECT technician_id, from_date, to_date, status FROM technician_leaves
    WHERE status IN ('pending', 'approved') AND from_date <= ${to} AND to_date >= ${from} AND store_id = ${currentStoreId()} ORDER BY id`;
  const changes = await db<(Omit<ScheduleChange, 'from' | 'to'> & { fromShift: string | null; fromRest: boolean; toShift: string | null; toRest: boolean })[]>`
    SELECT c.id, c.created_at AS "at", c.kind, c.technician_id, t.tech_no, t.name AS tech_name, c.work_date AS "date",
           fs.name AS from_shift, c.from_rest, ts.name AS to_shift, c.to_rest,
           (SELECT w.tech_no || ' 号 ' || w.name FROM technicians w WHERE w.id = c.swap_with) AS swap_with, c.reason, st.display_name AS staff_name
    FROM technician_schedule_changes c JOIN technicians t ON t.id = c.technician_id JOIN staff st ON st.id = c.staff_id
    LEFT JOIN technician_shifts fs ON fs.id = c.from_shift_id LEFT JOIN technician_shifts ts ON ts.id = c.to_shift_id
    WHERE c.work_date BETWEEN ${from} AND ${to} AND t.store_id = ${currentStoreId()} ORDER BY c.id DESC LIMIT 50`;
  const cellText = (shift: string | null, rest: boolean) => shift ?? (rest ? '排休' : '没排');
  return {
    from,
    days,
    today: await todayOf(db, deps),
    cells,
    leaves,
    changes: changes.map(({ fromShift, fromRest, toShift, toRest, ...c }) => ({ ...c, from: cellText(fromShift, fromRest), to: cellText(toShift, toRest) })),
  };
}

const CellInput = z
  .object({
    technicianId: z.number().int().positive(),
    date: dateInput('日期'),
    /** 上哪个班；null 配 rest=true 是排休，配 rest=false 是清掉（没排） */
    shiftId: z.number().int().positive().nullable(),
    rest: z.boolean().default(false),
  })
  .refine((c) => !(c.rest && c.shiftId !== null), '排休的格子不能再选班次');

const PlanInput = z.object({ cells: z.array(CellInput).min(1, '没有要排的格子').max(1000, '一次最多排 1000 格') });

const AdjustInput = z.object({
  technicianId: z.number().int().positive(),
  date: dateInput('日期'),
  /** 与这位技师对调这一天的班；带了它就不看 shiftId、rest */
  swapWithId: z.number().int().positive().nullish(),
  shiftId: z.number().int().positive().nullable().default(null),
  rest: z.boolean().default(false),
  reason: z.string().trim().min(2, '临时调班请写原因（至少 2 个字）').max(100, '原因最多 100 字'),
});

const sameCell = (a: { shiftId: number | null; rest: boolean }, b: { shiftId: number | null; rest: boolean }) => a.shiftId === b.shiftId && a.rest === b.rest;
const EMPTY_CELL = { shiftId: null, rest: false } as const;

/** 核对要排的技师（在职、是这家店的）与班次（在用），返回班次的名字 */
async function checkScheduleTargets(tx: Tx, technicianIds: number[], shiftIds: number[]) {
  const techs = await tx<{ id: number; techNo: string; name: string }[]>`
    SELECT id, tech_no, name FROM technicians WHERE id IN ${tx(technicianIds)} AND active AND store_id = ${currentStoreId()}`;
  if (techs.length !== technicianIds.length) throw unprocessable('SCHEDULE_TECH_INVALID', '有技师不存在或已停用，请刷新后重试');
  const shifts = shiftIds.length ? await tx<{ id: number; name: string }[]>`SELECT id, name FROM technician_shifts WHERE id IN ${tx(shiftIds)} AND active AND store_id = ${currentStoreId()}` : [];
  if (shifts.length !== shiftIds.length) throw unprocessable('SCHEDULE_SHIFT_INVALID', '有班次不存在或已停用，请刷新后重试');
  return { techs: new Map(techs.map((t) => [t.id, t])), shifts: new Map(shifts.map((s) => [s.id, s.name])) };
}

async function writeCell(tx: Tx, c: ScheduleCell, before: { shiftId: number | null; rest: boolean }, kind: ScheduleChangeKind, extra: { reason?: string; swapWith?: number }, staffId: number) {
  await tx`
    INSERT INTO technician_schedule (technician_id, work_date, shift_id, is_rest, updated_by, updated_at)
    VALUES (${c.technicianId}, ${c.date}, ${c.shiftId}, ${c.rest}, ${staffId}, now())
    ON CONFLICT (technician_id, work_date) DO UPDATE SET shift_id = EXCLUDED.shift_id, is_rest = EXCLUDED.is_rest, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  await tx`
    INSERT INTO technician_schedule_changes (technician_id, work_date, kind, from_shift_id, from_rest, to_shift_id, to_rest, swap_with, reason, staff_id)
    VALUES (${c.technicianId}, ${c.date}, ${kind}, ${before.shiftId}, ${before.rest}, ${c.shiftId}, ${c.rest}, ${extra.swapWith ?? null}, ${extra.reason ?? ''}, ${staffId})`;
}

/** 日期在能排的范围里：不能是过去，最远排到今天之后 SCHEDULE_AHEAD_DAYS 天 */
function assertSchedulable(date: string, today: string) {
  if (date < today) throw unprocessable('SCHEDULE_PAST', `${date} 已经过了，不能再改排班`);
  if (daysBetween(today, date) > SCHEDULE_AHEAD_DAYS) throw unprocessable('SCHEDULE_TOO_FAR', `最远排到 ${SCHEDULE_AHEAD_DAYS} 天以后`);
}

/**
 * 排班：整批提交格子，没变的跳过。今天已经排了的格子不能在这里改（走临时调班，要写原因）；过去的不能改。
 * 一位技师一天提交了两次的拒绝。
 */
async function planSchedule(deps: Deps, raw: unknown, ctx: OpContext): Promise<void> {
  const { cells } = parse(PlanInput, raw);
  const keys = new Set(cells.map((c) => `${c.technicianId}|${c.date}`));
  if (keys.size !== cells.length) throw badRequest('同一位技师同一天提交了两次');
  let changed = 0;
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockTechAdmin(tx);
    const today = await todayOf(tx, deps);
    for (const c of cells) assertSchedulable(c.date, today);
    const dates = cells.map((c) => c.date).sort();
    const { techs } = await checkScheduleTargets(tx, unique(cells.map((c) => c.technicianId)), unique(cells.flatMap((c) => (c.shiftId === null ? [] : [c.shiftId]))));
    const current = new Map((await cellsBetween(tx, dates[0]!, dates.at(-1)!)).map((c) => [`${c.technicianId}|${c.date}`, c]));
    for (const c of cells) {
      const before = current.get(`${c.technicianId}|${c.date}`) ?? EMPTY_CELL;
      if (sameCell(before, c)) continue;
      if (c.date === today && !sameCell(before, EMPTY_CELL)) {
        const t = techs.get(c.technicianId)!;
        throw unprocessable('SCHEDULE_TODAY_NEEDS_REASON', `${t.techNo} 号 ${t.name}今天已经排了班，要改请用「临时调班」（要写原因）`);
      }
      await writeCell(tx, c, before, 'plan', {}, ctx.actor.id);
      changed += 1;
    }
    if (changed === 0) return;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'technician_schedule',
      targetType: 'technician_schedule',
      detail: { kind: 'plan', from: dates[0], to: dates.at(-1), changed, summary: `技师排班：${dates[0] === dates.at(-1) ? dates[0] : `${dates[0]} 至 ${dates.at(-1)}`}，改了 ${changed} 格` },
      ip: ctx.ip,
    });
  });
}

/** 临时调班：改一位技师某一天的班（当天已经排了的也能改），或与另一位技师对调这一天的班；必须写原因，逐条留痕 */
async function adjustSchedule(deps: Deps, raw: unknown, ctx: OpContext): Promise<void> {
  const a = parse(AdjustInput, raw);
  const swapWithId = a.swapWithId ?? null;
  if (swapWithId === a.technicianId) throw badRequest('不能和自己对调');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockTechAdmin(tx);
    assertSchedulable(a.date, await todayOf(tx, deps));
    const ids = swapWithId === null ? [a.technicianId] : [a.technicianId, swapWithId];
    const { techs, shifts } = await checkScheduleTargets(tx, ids, swapWithId === null && a.shiftId !== null ? [a.shiftId] : []);
    const current = new Map((await cellsBetween(tx, a.date, a.date)).map((c) => [c.technicianId, c]));
    const mine = current.get(a.technicianId) ?? EMPTY_CELL;
    const who = (id: number) => `${techs.get(id)!.techNo} 号 ${techs.get(id)!.name}`;
    let summary: string;
    if (swapWithId !== null) {
      const theirs = current.get(swapWithId) ?? EMPTY_CELL;
      if (sameCell(mine, theirs)) throw conflict('SCHEDULE_NO_CHANGE', `${who(a.technicianId)}与${who(swapWithId)}这一天排的一样，不用对调`);
      await writeCell(tx, { technicianId: a.technicianId, date: a.date, shiftId: theirs.shiftId, rest: theirs.rest }, mine, 'swap', { reason: a.reason, swapWith: swapWithId }, ctx.actor.id);
      await writeCell(tx, { technicianId: swapWithId, date: a.date, shiftId: mine.shiftId, rest: mine.rest }, theirs, 'swap', { reason: a.reason, swapWith: a.technicianId }, ctx.actor.id);
      summary = `临时调班 ${a.date}：${who(a.technicianId)}与${who(swapWithId)}对调（${a.reason}）`;
    } else {
      const next = { shiftId: a.rest ? null : a.shiftId, rest: a.rest };
      if (sameCell(mine, next)) throw conflict('SCHEDULE_NO_CHANGE', `${who(a.technicianId)}这一天本来就是这样排的`);
      await writeCell(tx, { technicianId: a.technicianId, date: a.date, ...next }, mine, 'adjust', { reason: a.reason }, ctx.actor.id);
      summary = `临时调班 ${a.date}：${who(a.technicianId)}改成${next.rest ? '排休' : next.shiftId === null ? '没排' : `「${shifts.get(next.shiftId)}」`}（${a.reason}）`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'technician_schedule',
      targetType: 'technician_schedule',
      targetId: a.technicianId,
      detail: { kind: swapWithId === null ? 'adjust' : 'swap', date: a.date, swapWithId, reason: a.reason, summary },
      ip: ctx.ip,
    });
  });
}

// ───────────────────────── 休假 ─────────────────────────

const LEAVE_COLUMNS = (db: Db) => db`
  l.id, l.technician_id, t.tech_no, t.name AS tech_name, t.nickname, l.from_date, l.to_date, (l.to_date - l.from_date + 1)::int AS days, l.leave_type, l.reason, l.status,
  ap.display_name AS applied_by_name, l.applied_at, de.display_name AS decided_by_name, l.decided_at, l.decision_note,
  ca.display_name AS cancelled_by_name, l.cancelled_at, l.cancel_reason`;
const LEAVE_FROM = (db: Db) => db`
  technician_leaves l JOIN technicians t ON t.id = l.technician_id JOIN staff ap ON ap.id = l.applied_by
  LEFT JOIN staff de ON de.id = l.decided_by LEFT JOIN staff ca ON ca.id = l.cancelled_by`;

async function leaveById(db: Db, id: number): Promise<TechLeave> {
  const [row] = await db<TechLeave[]>`SELECT ${LEAVE_COLUMNS(db)} FROM ${LEAVE_FROM(db)} WHERE l.id = ${id} AND l.store_id = ${currentStoreId()}`;
  if (!row) throw notFound('休假单不存在');
  return row;
}

/** 休假单清单：待审批的在前，其余新的在前；最多 300 张 */
const listLeaves = (db: Db, status: LeaveStatus | null) =>
  db<TechLeave[]>`
    SELECT ${LEAVE_COLUMNS(db)} FROM ${LEAVE_FROM(db)}
    WHERE l.store_id = ${currentStoreId()} ${status ? db`AND l.status = ${status}` : db``}
    ORDER BY (l.status = 'pending') DESC, l.id DESC LIMIT 300`;

const LeaveInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  technicianId: z.number().int().positive('请选择技师'),
  fromDate: dateInput('开始日期'),
  toDate: dateInput('结束日期'),
  leaveType: z.enum(LEAVE_TYPES, '请选择休假类型'),
  reason: z.string().trim().min(2, '请写休假原因（至少 2 个字）').max(100, '原因最多 100 字'),
});

const lockTechnician = async (tx: Tx, id: number) =>
  (await tx<{ id: number; techNo: string; name: string; active: boolean }[]>`SELECT id, tech_no, name, active FROM technicians WHERE id = ${id} AND store_id = ${currentStoreId()} FOR UPDATE`)[0];

/**
 * 申请休假（替技师提）。同一个操作编号重提返回第一次建的那一张；这位技师这几天已经有待审批、已批准的休假单的拒绝。
 * 开始日期不能早于今天，一张最多 LEAVE_MAX_DAYS 天。
 */
async function applyLeave(deps: Deps, raw: unknown, ctx: OpContext): Promise<TechLeave> {
  const a = parse(LeaveInput, raw);
  if (a.toDate < a.fromDate) throw badRequest('结束日期不能早于开始日期');
  if (daysBetween(a.fromDate, a.toDate) + 1 > LEAVE_MAX_DAYS) throw badRequest(`一张休假单最多请 ${LEAVE_MAX_DAYS} 天，更长的请分开申请`);
  const existing = async (db: Db) =>
    (await db<{ id: number; technicianId: number; fromDate: string; toDate: string }[]>`SELECT id, technician_id, from_date, to_date FROM technician_leaves WHERE client_key = ${a.clientKey}`)[0];
  const replay = (row: { id: number; technicianId: number; fromDate: string; toDate: string }) => {
    if (row.technicianId !== a.technicianId || row.fromDate !== a.fromDate || row.toDate !== a.toDate) throw conflict('KEY_REUSED', '这个操作编号已经用在另一张休假单上，请刷新页面后重试');
    return row.id;
  };
  let id: number;
  try {
    id = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const t = await lockTechnician(tx, a.technicianId);
      if (!t) throw notFound('技师不存在，请刷新后重新选');
      const dup = await existing(tx);
      if (dup) return replay(dup);
      if (!t.active) throw unprocessable('TECHNICIAN_INACTIVE', `${t.techNo} 号 ${t.name}已停用，不能申请休假`);
      const today = await todayOf(tx, deps);
      if (a.fromDate < today) throw unprocessable('LEAVE_PAST', `开始日期不能早于今天（${today}）`);
      if (daysBetween(today, a.fromDate) > LEAVE_AHEAD_DAYS) throw unprocessable('LEAVE_TOO_FAR', `最远申请 ${LEAVE_AHEAD_DAYS} 天以后开始的休假`);
      const [overlap] = await tx<{ id: number; fromDate: string; toDate: string; status: LeaveStatus }[]>`
        SELECT id, from_date, to_date, status FROM technician_leaves
        WHERE technician_id = ${t.id} AND status IN ('pending', 'approved') AND from_date <= ${a.toDate} AND to_date >= ${a.fromDate} ORDER BY id LIMIT 1`;
      if (overlap) {
        throw conflict('LEAVE_OVERLAP', `${t.techNo} 号 ${t.name}在 ${leaveRangeText(overlap)} 已经有一张${LEAVE_STATUS_LABELS[overlap.status]}的休假单，日期重叠了`);
      }
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO technician_leaves (technician_id, from_date, to_date, leave_type, reason, client_key, applied_by)
        VALUES (${t.id}, ${a.fromDate}, ${a.toDate}, ${a.leaveType}, ${a.reason}, ${a.clientKey}, ${ctx.actor.id}) RETURNING id`;
      await auditLeave(tx, ctx, row!.id, 'apply', `${t.techNo} 号 ${t.name}申请${LEAVE_TYPE_LABELS[a.leaveType]} ${leaveRangeText(a)}：${a.reason}`);
      return row!.id;
    });
  } catch (error) {
    // 同一个编号两次同时到：后到的撞上唯一索引，返回先到的那一张
    if (!isUniqueViolation(error)) throw error;
    const dup = await existing(deps.sql);
    if (!dup) throw error;
    id = replay(dup);
  }
  return leaveById(deps.sql, id);
}

const auditLeave = (tx: Tx, ctx: OpContext, leaveId: number, action: string, summary: string, extra: Record<string, unknown> = {}) =>
  writeAudit(tx, { staffId: ctx.actor.id, action: 'technician_leave', targetType: 'technician_leave', targetId: leaveId, detail: { action, ...extra, summary }, ip: ctx.ip });

interface LockedLeave {
  id: number;
  technicianId: number;
  fromDate: string;
  toDate: string;
  leaveType: LeaveType;
  status: LeaveStatus;
}

/**
 * 休假单的批准、驳回、撤回、销假都走这里：技师队列 → 技师一行 → 休假单一行，再由 change 核对状态、改单、同步今天的上牌状态。
 * 先不加锁读一下是哪位技师（休假单的技师不会变），锁好以后按锁住的那一行核对。
 */
async function changeLeave(deps: Deps, id: number, ctx: OpContext, change: (tx: Tx, l: LockedLeave, t: { id: number; label: string }, today: string, at: Date) => Promise<void>) {
  const [peek] = await deps.sql<{ technicianId: number }[]>`SELECT technician_id FROM technician_leaves WHERE id = ${id} AND store_id = ${currentStoreId()}`;
  if (!peek) throw notFound('休假单不存在');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    await lockQueue(tx);
    const t = await lockTechnician(tx, peek.technicianId);
    const [l] = await tx<LockedLeave[]>`SELECT id, technician_id, from_date, to_date, leave_type, status FROM technician_leaves WHERE id = ${id} FOR UPDATE`;
    await change(tx, l!, { id: t!.id, label: `${t!.techNo} 号 ${t!.name}` }, await businessDate(tx, deps, at), at);
  });
  return leaveById(deps.sql, id);
}

const DecideInput = z.object({
  action: z.enum(['approve', 'reject'], '操作不正确'),
  note: z.string().trim().max(100, '说明最多 100 字').default(''),
});

/** 批准 / 驳回。已经是这个结果的原样返回（重提不重复记）；批准含今天的休假时这位技师不能在钟上 */
function decideLeave(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const d = parse(DecideInput, raw);
  if (d.action === 'reject' && d.note.length < 2) throw badRequest('驳回请写原因（至少 2 个字）');
  const target = d.action === 'approve' ? 'approved' : 'rejected';
  return changeLeave(deps, id, ctx, async (tx, l, t, today, at) => {
    if (l.status === target) return;
    if (l.status !== 'pending') throw conflict('LEAVE_DECIDED', `这张休假单${LEAVE_STATUS_LABELS[l.status]}了，请刷新`);
    if (d.action === 'approve') {
      if (l.toDate < today) throw unprocessable('LEAVE_PAST', `休假的日子（${leaveRangeText(l)}）已经过了，不能再批准；请驳回`);
      if (l.fromDate <= today) await syncLeaveToday(tx, deps, t, 'on', l.id, ctx, at);
    }
    await tx`UPDATE technician_leaves SET status = ${target}, decided_by = ${ctx.actor.id}, decided_at = ${at}, decision_note = ${d.note} WHERE id = ${l.id}`;
    await auditLeave(tx, ctx, l.id, d.action, `${d.action === 'approve' ? '批准' : '驳回'} ${t.label}的${LEAVE_TYPE_LABELS[l.leaveType]} ${leaveRangeText(l)}${d.note ? `：${d.note}` : ''}`);
  });
}

const CancelInput = z.object({ reason: z.string().trim().max(100, '原因最多 100 字').default('') });

/**
 * 取消休假单：待审批的是撤回（钟房的岗位就能撤）；已批准的是销假（要「维护技师名册」权限、写原因），
 * 休假含今天的同一个事务里把今天的状态改回未上牌，之后照常上牌。已经休完的不能销。
 */
function cancelLeave(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const { reason } = parse(CancelInput, raw);
  return changeLeave(deps, id, ctx, async (tx, l, t, today, at) => {
    if (l.status === 'cancelled') return;
    if (l.status === 'rejected') throw conflict('LEAVE_DECIDED', '这张休假单已驳回，不用再取消');
    if (l.status === 'approved') {
      if (!can(ctx.actor, 'technician.manage')) throw forbidden('已批准的休假要有「维护技师名册」权限的人来销假');
      if (reason.length < 2) throw badRequest('销假请写原因（至少 2 个字）');
      if (l.toDate < today) throw unprocessable('LEAVE_PAST', `这张休假单（${leaveRangeText(l)}）已经休完，不能再销假`);
      if (l.fromDate <= today) await syncLeaveToday(tx, deps, t, 'off', l.id, ctx, at);
    }
    await tx`UPDATE technician_leaves SET status = 'cancelled', cancelled_by = ${ctx.actor.id}, cancelled_at = ${at}, cancel_reason = ${reason} WHERE id = ${l.id}`;
    await auditLeave(
      tx,
      ctx,
      l.id,
      l.status === 'approved' ? 'revoke' : 'withdraw',
      `${l.status === 'approved' ? '销假' : '撤回'}：${t.label}的${LEAVE_TYPE_LABELS[l.leaveType]} ${leaveRangeText(l)}${reason ? `（${reason}）` : ''}`,
      {
        was: l.status,
      },
    );
  });
}

// ───────────────────────── 路由 ─────────────────────────

export function registerTechnicianAdminRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 看：维护技师名册的、钟房的岗位都能看；改名册、组别、班次、排班与审批休假要「维护技师名册」；申请、撤回休假钟房的岗位就能做
  const read = { preHandler: guardAny('technician.manage', 'technician.dispatch') };
  const manage = { preHandler: guard('technician.manage') };
  const view = (req: { actor: OpContext['actor'] }) => adminView(sql, deps, can(req.actor, 'technician.manage'));

  app.get('/api/technician-admin', read, async (req) => view(req));

  app.put('/api/technician-admin/kinds', manage, async (req) => {
    await saveRuleSetting(sql, 'technician_kinds', loadTechnicianKinds, () => parse(KindsInput, req.body).kinds, ctxOf(req));
    return view(req);
  });

  app.post('/api/technician-admin/groups', manage, async (req) => {
    await saveGroup(deps, null, req.body, ctxOf(req));
    return view(req);
  });
  app.put('/api/technician-admin/groups/:id', manage, async (req) => {
    await saveGroup(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return view(req);
  });

  app.post('/api/technician-admin/shifts', manage, async (req) => {
    await saveShift(deps, null, req.body, ctxOf(req));
    return view(req);
  });
  app.put('/api/technician-admin/shifts/:id', manage, async (req) => {
    await saveShift(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return view(req);
  });

  const ScheduleQuery = z.object({ from: dateInput('开始日期'), days: z.coerce.number().int().min(1).max(SCHEDULE_MAX_DAYS, `一次最多看 ${SCHEDULE_MAX_DAYS} 天`).default(7) });
  app.get('/api/technician-admin/schedule', read, async (req) => {
    const q = parse(ScheduleQuery, req.query ?? {});
    return scheduleView(sql, deps, q.from, q.days);
  });
  // 排班、临时调班保存以后按页面正在看的那几天（地址里的 from、days，先核对再保存）返回最新的排班表
  app.put('/api/technician-admin/schedule', manage, async (req) => {
    const q = parse(ScheduleQuery, req.query ?? {});
    await planSchedule(deps, req.body, ctxOf(req));
    return scheduleView(sql, deps, q.from, q.days);
  });
  app.post('/api/technician-admin/schedule/adjust', manage, async (req) => {
    const q = parse(ScheduleQuery, req.query ?? {});
    await adjustSchedule(deps, req.body, ctxOf(req));
    return scheduleView(sql, deps, q.from, q.days);
  });

  app.get('/api/technician-admin/leaves', read, async (req) => {
    const { status } = parse(z.object({ status: z.enum(LEAVE_STATUSES, '状态不正确').optional() }), req.query ?? {});
    return listLeaves(sql, status ?? null);
  });
  app.post('/api/technician-admin/leaves', read, async (req) => applyLeave(deps, req.body, ctxOf(req)));
  app.post('/api/technician-admin/leaves/:id/decide', manage, async (req) => decideLeave(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/technician-admin/leaves/:id/cancel', read, async (req) => cancelLeave(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
}
