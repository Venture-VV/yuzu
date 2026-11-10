// 岗位权限的后台调整（v0.6.0）：settings.role_permissions 存相对默认规则的增减（见 src/shared/permissions.ts）。
// 会话每次请求按最新的调整计算权限，所以店主改完立即生效；授权人（当场授权）同样按调整后的权限核对。

import { ALL_PERMISSIONS, EDITABLE_ROLES, LOCKED_PERMISSIONS, permissionsOf, type Duty, type Permission, type Role, type RoleOverrides } from '@shared/permissions';
import type { Db } from '../db';

/** 只保留认识的岗位与权限（库里的值来自旧版本或手工改动时也不出错）；店主专属的权限不会被加给其他岗位 */
export function sanitizeOverrides(value: unknown): RoleOverrides {
  const out: RoleOverrides = {};
  if (!value || typeof value !== 'object') return out;
  const known = (list: unknown) => (Array.isArray(list) ? list.filter((p): p is Permission => ALL_PERMISSIONS.includes(p as Permission)) : []);
  for (const role of EDITABLE_ROLES) {
    const o = (value as Record<string, { add?: unknown; remove?: unknown } | undefined>)[role];
    if (!o) continue;
    const add = known(o.add).filter((p) => !LOCKED_PERMISSIONS.includes(p));
    const remove = known(o.remove);
    if (add.length || remove.length) out[role] = { add, remove };
  }
  return out;
}

export async function loadRoleOverrides(db: Db): Promise<RoleOverrides> {
  const [row] = await db<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'role_permissions'`;
  return sanitizeOverrides(row?.value);
}

/** 按后台调整后的权限，供 can() 判断（授权人、会话都用它） */
export async function subjectOf(db: Db, staff: { role: Role; duties: Duty[] | null }) {
  const duties = staff.duties ?? [];
  const [f] = await db<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'finance_hides_marketing_cost'`;
  return { role: staff.role, duties, permissions: permissionsOf({ role: staff.role, duties }, await loadRoleOverrides(db), { financeExclusion: f?.value !== false }) };
}
