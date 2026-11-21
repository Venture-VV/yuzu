// 岗位权限的后台调整（v0.6.0）：settings.role_permissions 存旧岗位相对默认规则的增减（见 src/shared/permissions.ts）；
// 8.1.18 起另有 settings.position_permissions 存新岗位相对岗位模板的增减（src/shared/positions.ts，GW8），
// 员工档案里的 staff.permission_adjust 是个人微调。
// 会话每次请求按最新的调整计算权限，所以店主改完立即生效；授权人（当场授权）同样按调整后的权限核对。

import { ALL_PERMISSIONS, EDITABLE_ROLES, LOCKED_PERMISSIONS, permissionsOf, type Duty, type Permission, type PermissionOverrides, type Role, type RoleOverrides } from '@shared/permissions';
import { POSITION_KEYS, isPositionKey, type PermissionAdjust, type PositionKey, type PositionOverrides } from '@shared/positions';
import type { Db } from '../db';

const known = (list: unknown) => (Array.isArray(list) ? list.filter((p): p is Permission => ALL_PERMISSIONS.includes(p as Permission)) : []);

/** 只保留认识的岗位与权限（库里的值来自旧版本或手工改动时也不出错）；店主专属的权限不会被加给其他岗位 */
export function sanitizeOverrides(value: unknown): RoleOverrides {
  const out: RoleOverrides = {};
  if (!value || typeof value !== 'object') return out;
  for (const role of EDITABLE_ROLES) {
    const o = (value as Record<string, { add?: unknown; remove?: unknown } | undefined>)[role];
    if (!o) continue;
    const add = known(o.add).filter((p) => !LOCKED_PERMISSIONS.includes(p));
    const remove = known(o.remove);
    if (add.length || remove.length) out[role] = { add, remove };
  }
  return out;
}

/** 一份增减（个人微调、某个岗位的调整）：只留认识的权限，店主专属的不能加 */
export function sanitizeAdjust(value: unknown): PermissionAdjust | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as { add?: unknown; remove?: unknown };
  const add = known(o.add).filter((p) => !LOCKED_PERMISSIONS.includes(p));
  const remove = known(o.remove);
  return add.length || remove.length ? { add, remove } : null;
}

export function sanitizePositionOverrides(value: unknown): PositionOverrides {
  const out: PositionOverrides = {};
  if (!value || typeof value !== 'object') return out;
  for (const key of POSITION_KEYS) {
    if (key === 'president') continue;
    const a = sanitizeAdjust((value as Record<string, unknown>)[key]);
    if (a) out[key] = a;
  }
  return out;
}

export function overridesOf(roleValue: unknown, positionValue: unknown, suggested?: PermissionOverrides['suggested']): PermissionOverrides {
  return { roles: sanitizeOverrides(roleValue), positions: sanitizePositionOverrides(positionValue), ...(suggested ? { suggested } : {}) };
}

/** 库里一行 position_suggestions 的权限（不认识的扔掉：旧版本留下的、手工改的） */
export const knownPermissions = known;

/**
 * 「分部门岗位职权配置」里各岗位的建议权限（8.2.0 P04）：岗位在库里有（position_catalog）就按库里的，一项都没有也是空的；
 * 库里没有这个岗位的（不该有）不给，按代码里的模板
 */
export async function loadSuggestions(db: Db): Promise<NonNullable<PermissionOverrides['suggested']>> {
  const rows = await db<{ key: string; permissions: string[] | null }[]>`
    SELECT c.key, array_agg(s.permission) FILTER (WHERE s.permission IS NOT NULL) AS permissions
    FROM position_catalog c LEFT JOIN position_suggestions s ON s.position_key = c.key
    WHERE NOT c.all_permissions GROUP BY c.key`;
  const out: NonNullable<PermissionOverrides['suggested']> = {};
  for (const r of rows) if (isPositionKey(r.key)) out[r.key] = known(r.permissions ?? []);
  return out;
}

export async function loadRoleOverrides(db: Db): Promise<PermissionOverrides> {
  const rows = await db<{ key: string; value: unknown }[]>`SELECT key, value FROM settings WHERE key IN ('role_permissions', 'position_permissions')`;
  return overridesOf(rows.find((r) => r.key === 'role_permissions')?.value, rows.find((r) => r.key === 'position_permissions')?.value, await loadSuggestions(db));
}

/** 员工档案里的岗位（库里的值不认识时当作没有） */
export const positionFrom = (value: unknown): PositionKey | null => (isPositionKey(value) ? value : null);

/** 按后台调整后的权限，供 can() 判断（授权人、会话都用它） */
export async function subjectOf(db: Db, staff: { role: Role; duties: Duty[] | null; position: unknown; permissionAdjust: unknown }) {
  const duties = staff.duties ?? [];
  const [f] = await db<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'finance_hides_marketing_cost'`;
  const position = positionFrom(staff.position);
  return {
    role: staff.role,
    duties,
    position,
    permissions: permissionsOf({ role: staff.role, duties, position, adjust: sanitizeAdjust(staff.permissionAdjust) }, await loadRoleOverrides(db), { financeExclusion: f?.value !== false }),
  };
}

/** 员工档案的一行（SELECT 里带上 position、permission_adjust）→ 算权限要的资料 */
export function staffSubject(row: { role: Role; duties: Duty[] | null; position: unknown; permissionAdjust: unknown }) {
  return { role: row.role, duties: row.duties ?? [], position: positionFrom(row.position), adjust: sanitizeAdjust(row.permissionAdjust) };
}
