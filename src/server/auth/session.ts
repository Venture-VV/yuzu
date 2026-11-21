import { createHash, randomBytes } from 'node:crypto';
import { permissionsOf, type Duty, type Role } from '@shared/permissions';
import type { Db } from '../db';
import type { Actor } from '../lib/context';
import { DEFAULT_STORE_ID } from '../lib/store-context';
import { knownPermissions, overridesOf, positionFrom, sanitizeAdjust } from './role-permissions';

export const SESSION_COOKIE = 'yuzu_sid';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
/** 会话令牌的摘要（换门店时按它找会话） */
export const hashSessionToken = hashToken;

export async function createSession(db: Db, staffId: number, ttlHours: number, meta: { ip?: string; userAgent?: string }): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db`
    INSERT INTO sessions (token_hash, staff_id, expires_at, ip, user_agent)
    VALUES (${hashToken(token)}, ${staffId}, now() + make_interval(hours => ${ttlHours}),
            ${meta.ip ?? null}, ${meta.userAgent?.slice(0, 200) ?? null})`;
  return token;
}

/** 校验会话；有效时顺延过期时间（滑动过期，最多每分钟写一次）。 */
export async function resolveSession(db: Db, token: string, ttlHours: number): Promise<Actor | null> {
  const rows = await db<
    (Actor & {
      active: boolean;
      tokenHash: string;
      stale: boolean;
      overrides: unknown;
      positionOverrides: unknown;
      suggested: string[] | null;
      inCatalog: boolean;
      permissionAdjust: unknown;
      financeHides: unknown;
      sessionStoreId: number | null;
      storeIds: number[];
    })[]
  >`
    SELECT s.token_hash, st.id, st.username, st.display_name, st.role, st.duties, st.must_change_password, st.active,
           st.position, st.permission_adjust, st.needs_position,
           s.last_seen_at < now() - interval '1 minute' AS stale,
           (SELECT value FROM settings WHERE key = 'role_permissions') AS overrides,
           (SELECT value FROM settings WHERE key = 'position_permissions') AS position_overrides,
           (SELECT array_agg(ps.permission) FROM position_suggestions ps WHERE ps.position_key = st.position) AS suggested,
           EXISTS (SELECT 1 FROM position_catalog pc WHERE pc.key = st.position AND NOT pc.all_permissions) AS in_catalog,
           (SELECT value FROM settings WHERE key = 'finance_hides_marketing_cost') AS finance_hides,
           s.store_id AS session_store_id,
           ${storeIdsOf(db)} AS store_ids
    FROM sessions s JOIN staff st ON st.id = s.staff_id
    WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()`;
  const row = rows[0];
  if (!row || !row.active) return null;
  if (row.stale) {
    await db`
      UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(hours => ${ttlHours})
      WHERE token_hash = ${row.tokenHash}`;
  }
  const role = row.role as Role;
  const duties = (row.duties ?? []) as Duty[];
  const position = positionFrom(row.position);
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role,
    duties,
    mustChangePassword: row.mustChangePassword,
    position,
    needsPosition: row.needsPosition === true,
    // 按店主在后台调整后的岗位权限（每次请求重新计算，改完立即生效）
    // 「有财务职责的账号看不到营销成本」（HY14）没设过的按默认（是）
    permissions: permissionsOf(
      { role, duties, position, adjust: sanitizeAdjust(row.permissionAdjust) },
      overridesOf(row.overrides, row.positionOverrides, position && row.inCatalog ? { [position]: knownPermissions(row.suggested ?? []) } : undefined),
      {
        financeExclusion: row.financeHides !== false,
      },
    ),
    storeId: effectiveStore(row.sessionStoreId, (row.storeIds ?? []).map(Number)),
  };
}

/**
 * 员工能进的门店（8.0.22，docs/MULTISTORE_V8022.md 第 2 节），按「最近用过的在前、再按排序」：
 * 店主是全部启用的门店；别人是挂着的、启用的门店；没挂任何门店的按本店算。
 */
export function storeIdsOf(db: Db) {
  return db`(
    CASE WHEN st.role = 'owner' THEN
      (SELECT coalesce(array_agg(x.id ORDER BY ss2.last_used_at DESC NULLS LAST, x.sort_order, x.id), '{}')
       FROM stores x LEFT JOIN staff_stores ss2 ON ss2.store_id = x.id AND ss2.staff_id = st.id WHERE x.active)
    ELSE
      coalesce(
        (SELECT array_agg(x.id ORDER BY ss.last_used_at DESC NULLS LAST, x.sort_order, x.id)
         FROM staff_stores ss JOIN stores x ON x.id = ss.store_id AND x.active WHERE ss.staff_id = st.id),
        CASE WHEN EXISTS (SELECT 1 FROM staff_stores ss WHERE ss.staff_id = st.id) THEN '{}'::bigint[] ELSE ARRAY[${DEFAULT_STORE_ID}]::bigint[] END)
    END)`;
}

/** 会话里选的门店还能进就用它；不然用能进的第一家（最近用过的）；一家都进不了的落在本店（页面上照样只能看到本店的） */
export function effectiveStore(sessionStoreId: number | null, storeIds: number[]): number {
  if (sessionStoreId != null && storeIds.includes(Number(sessionStoreId))) return Number(sessionStoreId);
  return storeIds[0] ?? DEFAULT_STORE_ID;
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
}

export async function destroyStaffSessions(db: Db, staffId: number, exceptToken?: string): Promise<void> {
  if (exceptToken) {
    await db`DELETE FROM sessions WHERE staff_id = ${staffId} AND token_hash <> ${hashToken(exceptToken)}`;
  } else {
    await db`DELETE FROM sessions WHERE staff_id = ${staffId}`;
  }
}

export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db`DELETE FROM sessions WHERE expires_at < now() - interval '1 day'`;
}
