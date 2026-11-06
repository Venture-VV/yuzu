import type { CanteenCheckin, CanteenMenu, CanteenRosterEmployee, CanteenSyncOutput } from '@shared/canteen';
import { effectiveErpModules } from '@shared/erp';
import type { Db } from '../../db';
import type { Deps } from '../../lib/context';
import { employeeRequest } from './connection';

export async function canteenEnabled(sql: Db) {
  const [row] = await sql<{ value: Record<string, boolean> }[]>`SELECT value FROM settings WHERE key = 'erp_modules'`;
  return effectiveErpModules(row?.value ?? {}).has('canteen');
}

export async function listCanteenEmployees(sql: Db) {
  return sql<(CanteenRosterEmployee & { version: number })[]>`
    SELECT e.id, e.employee_no, e.name, e.department_id, d.name AS department_name,
      e.role, (e.active AND d.active) AS active, e.must_change_password, e.version,
      e.password_hash, e.credential_version
    FROM canteen_employees e JOIN departments d ON d.id = e.department_id ORDER BY e.employee_no`;
}
export const publicEmployee = ({ passwordHash: _p, credentialVersion: _c, ...employee }: CanteenRosterEmployee & { version: number }) => employee;

export async function cacheMenu(sql: Db, menu: CanteenMenu) {
  await sql`INSERT INTO canteen_menus (id, menu_date, payload, updated_at)
    VALUES (${menu.id}, ${menu.date}, ${sql.json(menu as never)}, ${menu.updatedAt})
    ON CONFLICT (id) DO UPDATE SET menu_date = excluded.menu_date, payload = excluded.payload, updated_at = excluded.updated_at
    WHERE (canteen_menus.payload->>'version')::integer <= (excluded.payload->>'version')::integer`;
}
export async function cacheCheckin(sql: Db, c: CanteenCheckin) {
  await sql`INSERT INTO canteen_checkins (id, request_id, employee_id, employee_no, name, department_name, scanner_id, scanner_name, checked_at)
    VALUES (${c.id}, ${c.requestId}, ${c.employeeId}, ${c.employeeNo}, ${c.name}, ${c.departmentName}, ${c.scannerId}, ${c.scannerName}, ${c.checkedAt})
    ON CONFLICT (id) DO NOTHING`;
}

/** 同步仅由内网主动发起；同步失败不推进游标。revision来自非事务序列，响应丢失后不会重用旧revision。 */
export async function syncCanteen({ sql, config }: Deps) {
  if (!config.employeePortal) return { ok: false, reason: 'not_configured' };
  if (!await canteenEnabled(sql)) return { ok: false, reason: 'disabled' };
  try {
    let more = true;
    let batches = 0;
    while (more && batches++ < 20) {
      more = await sql.begin(async tx => {
        await tx`SET LOCAL lock_timeout = '10s'`;
        const [state] = await tx<{ departmentId: number | null; rosterVersion: number; checkinCursor: number }[]>`
          SELECT department_id, roster_version, checkin_cursor FROM canteen_settings WHERE singleton FOR UPDATE`;
        const [revision] = await tx<{ revision: number }[]>`SELECT nextval('canteen_sync_revision') AS revision`;
        const employees = await listCanteenEmployees(tx);
        const result = await employeeRequest<CanteenSyncOutput>(config.employeePortal, '/internal/sync', {
          revision: revision!.revision, canteenDepartmentId: state!.departmentId,
          employees: employees.map(({ version: _v, ...employee }) => employee), afterCheckinId: state!.checkinCursor,
        });
        for (const menu of result.menus) await cacheMenu(tx, menu);
        for (const c of result.checkins) await cacheCheckin(tx, c);
        await tx`UPDATE canteen_settings SET last_success_at = now(), last_error = NULL,
          synced_roster_version = ${state!.rosterVersion}, checkin_cursor = ${result.nextCheckinId} WHERE singleton`;
        return result.hasMore;
      });
    }
    return { ok: true, hasMore: more };
  } catch (error) {
    // 不记录包含凭证的请求或底层连接信息。
    await sql`UPDATE canteen_settings SET last_error = '员工服务同步失败；员工资格可能尚未更新，请重试' WHERE singleton`;
    throw error;
  }
}
