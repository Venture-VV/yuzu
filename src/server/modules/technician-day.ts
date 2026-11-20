// 技师某一天的休假、排班与组别（8.1.15，docs/TECHNICIANS_V8115.md）：钟房看板、排位与技师管理都读这里，只读、不加锁。
// 单独一个文件，不引钟房与技师管理的模块（它们都引它）。

import type { LeaveType, TechShift } from '@shared/technician-admin';
import type { Db } from '../db';
import { currentStoreId } from '../lib/store-context';

export interface ApprovedLeave {
  id: number;
  technicianId: number;
  fromDate: string;
  toDate: string;
  leaveType: LeaveType;
}

/**
 * 这个营业日在已批准的休假里的技师。钟房算排位、派钟、上牌时都按它把人排除（读的时候算，不靠定时任务：
 * 跨了营业日、休假从今天开始的，不用谁去点就已经是休假）。
 */
export async function approvedLeavesOn(db: Db, date: string): Promise<ApprovedLeave[]> {
  return db<ApprovedLeave[]>`
    SELECT id, technician_id, from_date, to_date, leave_type FROM technician_leaves
    WHERE status = 'approved' AND from_date <= ${date} AND to_date >= ${date} AND store_id = ${currentStoreId()}
    ORDER BY id`;
}

export interface DaySchedule {
  rest: boolean;
  shift: Pick<TechShift, 'id' | 'name' | 'startMinute' | 'endMinute'> | null;
}

/** 这一天的排班：技师编号 → 上哪个班 / 排休（没排的不在里面） */
export async function scheduleOn(db: Db, date: string): Promise<Map<number, DaySchedule>> {
  const rows = await db<{ technicianId: number; isRest: boolean; shiftId: number | null; name: string | null; startMinute: number | null; endMinute: number | null }[]>`
    SELECT c.technician_id, c.is_rest, c.shift_id, s.name, s.start_minute, s.end_minute
    FROM technician_schedule c JOIN technicians t ON t.id = c.technician_id LEFT JOIN technician_shifts s ON s.id = c.shift_id
    WHERE c.work_date = ${date} AND (c.is_rest OR c.shift_id IS NOT NULL) AND t.store_id = ${currentStoreId()}`;
  return new Map(rows.map((r) => [r.technicianId, { rest: r.isRest, shift: r.shiftId === null ? null : { id: r.shiftId, name: r.name!, startMinute: r.startMinute!, endMinute: r.endMinute! } }]));
}

/** 组别的名字（在用的）：组别编号 → 名字 */
export async function groupNames(db: Db): Promise<Map<number, string>> {
  const rows = await db<{ id: number; name: string }[]>`SELECT id, name FROM technician_groups WHERE active AND store_id = ${currentStoreId()}`;
  return new Map(rows.map((r) => [r.id, r.name]));
}
