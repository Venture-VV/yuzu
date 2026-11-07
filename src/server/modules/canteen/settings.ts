// 员工食堂 · 柚子饭堂（docs/CANTEEN.md）：设置（settings 的 canteen 一项）——食堂部门、开饭时间、员工入口地址。

import { z } from 'zod';
import {
  DEFAULT_CANTEEN_SETTINGS,
  isLanHost,
  MEAL_LABELS,
  MEALS,
  mealWindowsOverlap,
  validMealWindow,
  type CanteenSettings,
  type MealWindow,
} from '@shared/canteen';
import { HHMM } from '@shared/business-date';
import type { Db, Sql } from '../../db';
import type { OpContext } from '../../lib/context';
import { badRequest, unprocessable } from '../../lib/errors';
import { saveRuleSetting, lockSettings } from '../../lib/rule-settings';
import { parse } from '../../lib/validate';
import { writeAudit } from '../../lib/audit';

/** 读设置：没存过、存的不完整时按默认补齐（不认识的键忽略） */
export async function loadCanteenSettings(db: Db): Promise<CanteenSettings> {
  const [row] = await db<{ value: Partial<CanteenSettings> | null }[]>`SELECT value FROM settings WHERE key = 'canteen'`;
  const v = row?.value ?? {};
  const meals: MealWindow[] = MEALS.map((meal) => {
    const saved = Array.isArray(v.meals) ? v.meals.find((m) => m?.meal === meal) : undefined;
    const dflt = DEFAULT_CANTEEN_SETTINGS.meals.find((m) => m.meal === meal)!;
    return saved && typeof saved.enabled === 'boolean' && validMealWindow(saved as MealWindow)
      ? { meal, enabled: saved.enabled, start: saved.start, end: saved.end }
      : { ...dflt };
  });
  return {
    departmentId: typeof v.departmentId === 'number' ? v.departmentId : null,
    meals,
    portalUrl: typeof v.portalUrl === 'string' ? v.portalUrl : '',
  };
}

/**
 * 员工入口地址：https 的网址；店里局域网的地址（K18：192.168.x.x、10.x.x.x 等，见 isLanHost）可以用 http，
 * 公网地址不能用 http（登录与饭卡码钥匙会明文过公网）；不带路径之外的东西
 */
const PortalUrl = z
  .string()
  .trim()
  .max(200, '地址太长了')
  .refine((s) => {
    if (!s) return true;
    try {
      const u = new URL(s);
      return (u.protocol === 'https:' || (u.protocol === 'http:' && isLanHost(u.hostname))) && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, '员工入口地址要以 https:// 开头，例如 https://staff.example.com；店里局域网的地址可以用 http://，例如 http://192.168.1.20:8090')
  .transform((s) => s.replace(/\/+$/, ''));

const SettingsInput = z.object({
  departmentId: z.number().int().positive('部门不正确').nullable(),
  meals: z
    .array(
      z.object({
        meal: z.enum(MEALS, '餐次不正确'),
        enabled: z.boolean(),
        start: z.string().regex(HHMM, '开饭时间写成 HH:MM'),
        end: z.string().regex(HHMM, '开饭时间写成 HH:MM'),
      }),
    )
    .length(MEALS.length, '四个餐次都要给'),
  portalUrl: PortalUrl,
});

/** 保存设置：开饭时间不能重叠；换食堂部门时，原部门里的厨师、负责人要先调过去或改成员工 */
export async function saveCanteenSettings(sql: Sql, raw: unknown, ctx: OpContext): Promise<CanteenSettings> {
  const input = parse(SettingsInput, raw);
  const meals = MEALS.map((meal) => {
    const m = input.meals.find((x) => x.meal === meal);
    if (!m) throw badRequest(`缺少${MEAL_LABELS[meal]}的开饭时间`);
    if (m.start === m.end) throw badRequest(`${MEAL_LABELS[meal]}的开始和结束不能一样`);
    return { meal, enabled: m.enabled, start: m.start, end: m.end };
  });
  const on = meals.filter((m) => m.enabled);
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      if (mealWindowsOverlap(on[i]!, on[j]!)) throw badRequest(`${MEAL_LABELS[on[i]!.meal]}和${MEAL_LABELS[on[j]!.meal]}的时间重叠了，一个时刻只能对上一餐`);
    }
  }
  return saveRuleSetting(
    sql,
    'canteen',
    loadCanteenSettings,
    async (before, tx) => {
      if (input.departmentId !== null) {
        const [d] = await tx<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${input.departmentId}`;
        if (!d) throw badRequest('没有这个部门');
        if (!d.active) throw unprocessable('DEPARTMENT_INACTIVE', '这个部门已停用，请先在库存「部门」里启用，或选别的部门');
      }
      if (input.departmentId !== before.departmentId) {
        // 厨师、负责人必须在食堂部门（K10）：换部门前要把他们调过去或改成员工
        const stuck = await tx<{ name: string }[]>`
          SELECT name FROM canteen_employees
          WHERE active AND role IN ('cook', 'manager') AND department_id IS DISTINCT FROM ${input.departmentId}
          ORDER BY id LIMIT 5`;
        if (stuck.length) {
          throw unprocessable('CANTEEN_STAFF_ELSEWHERE', `${stuck.map((s) => s.name).join('、')} 是厨师或负责人、不在新选的部门里：先把他们调到新部门或改成员工，再换食堂部门`);
        }
      }
      return { departmentId: input.departmentId, meals, portalUrl: input.portalUrl };
    },
    ctx,
  );
}

/** 一键新建食堂部门（已有同名的就用那个），并设成食堂部门 */
export async function createCanteenDepartment(sql: Sql, rawName: unknown, ctx: OpContext): Promise<CanteenSettings> {
  const name = parse(z.string().trim().min(1, '请写部门名称').max(16, '部门名称最多 16 个字'), rawName ?? '员工食堂');
  let saved!: CanteenSettings;
  await sql.begin(async (tx) => {
    await lockSettings(tx);
    const before = await loadCanteenSettings(tx);
    const [existing] = await tx<{ id: number; active: boolean }[]>`SELECT id, active FROM departments WHERE name = ${name}`;
    if (existing && !existing.active) throw unprocessable('DEPARTMENT_INACTIVE', `部门「${name}」已停用，请先在库存「部门」里启用`);
    const id = existing?.id ?? (await tx<{ id: number }[]>`INSERT INTO departments (name) VALUES (${name}) RETURNING id`)[0]!.id;
    if (before.departmentId !== id) {
      const [stuck] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM canteen_employees WHERE active AND role IN ('cook', 'manager') AND department_id IS DISTINCT FROM ${id}`;
      if (stuck!.n > 0) throw unprocessable('CANTEEN_STAFF_ELSEWHERE', '已经有厨师或负责人在别的部门：先把他们调过来或改成员工，再换食堂部门');
    }
    saved = { ...before, departmentId: id };
    await tx`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('canteen', ${tx.json(saved as never)}, now(), ${ctx.actor.id})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'settings_updated',
      targetType: 'settings',
      detail: { key: 'canteen', before, after: saved, departmentCreated: !existing },
      ip: ctx.ip,
    });
  });
  return saved;
}

/** 食堂部门的名字（没设时为 null） */
export async function canteenDepartmentName(db: Db, settings: CanteenSettings): Promise<string | null> {
  if (settings.departmentId === null) return null;
  const [d] = await db<{ name: string }[]>`SELECT name FROM departments WHERE id = ${settings.departmentId}`;
  return d?.name ?? null;
}
