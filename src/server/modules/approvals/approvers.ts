// 指定审批人的核对（审批规则的「指定的人」、8.0.1 采购规则里急采分级的审批人共用）：要在用、能用审批中心。

import type { Duty, Role } from '@shared/permissions';
import { permissionsOf } from '@shared/permissions';
import { loadRoleOverrides } from '../../auth/role-permissions';
import type { Db } from '../../db';
import { unprocessable } from '../../lib/errors';
import { hasApprovalAccess } from './engine';

export async function assertApprovers(db: Db, ids: number[]) {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return;
  const rows = await db<{ id: number; displayName: string; role: Role; duties: Duty[] | null; active: boolean }[]>`
    SELECT id, display_name, role, duties, active FROM staff WHERE id IN ${db(uniq)}`;
  const overrides = await loadRoleOverrides(db);
  for (const sid of uniq) {
    const s = rows.find((r) => Number(r.id) === sid);
    if (!s || !s.active) throw unprocessable('APPROVER_INVALID', '指定的人有不存在或已停用的，请重新选择');
    const who = { id: sid, role: s.role, duties: s.duties ?? [], permissions: permissionsOf({ role: s.role, duties: s.duties ?? [] }, overrides) };
    if (!hasApprovalAccess(who)) throw unprocessable('APPROVER_INVALID', `「${s.displayName}」没有审批中心的权限（岗位权限里的「审批中心：审批」），不能指定为审批人`);
  }
}

/** 指定的人里现在还能审的（在用、能用审批中心），按原来的顺序；急采按金额分级（8.0.1）提交时用，停用的人不会让单子卡住 */
export async function usableApprovers(db: Db, ids: number[]): Promise<number[]> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return [];
  const rows = await db<{ id: number; role: Role; duties: Duty[] | null }[]>`
    SELECT id, role, duties FROM staff WHERE id IN ${db(uniq)} AND active`;
  const overrides = await loadRoleOverrides(db);
  const ok = new Set(
    rows
      .filter((r) => hasApprovalAccess({ id: Number(r.id), role: r.role, duties: r.duties ?? [], permissions: permissionsOf({ role: r.role, duties: r.duties ?? [] }, overrides) }))
      .map((r) => Number(r.id)),
  );
  return uniq.filter((id) => ok.has(id));
}
