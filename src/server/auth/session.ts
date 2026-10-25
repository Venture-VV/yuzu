import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@shared/permissions';
import type { Db } from '../db';
import type { Actor } from '../lib/context';

export const SESSION_COOKIE = 'yuzu_sid';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(
  db: Db,
  staffId: number,
  ttlHours: number,
  meta: { ip?: string; userAgent?: string },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db`
    INSERT INTO sessions (token_hash, staff_id, expires_at, ip, user_agent)
    VALUES (${hashToken(token)}, ${staffId}, now() + make_interval(hours => ${ttlHours}),
            ${meta.ip ?? null}, ${meta.userAgent?.slice(0, 200) ?? null})`;
  return token;
}

/** 校验会话；有效时顺延过期时间（滑动过期，最多每分钟写一次）。 */
export async function resolveSession(db: Db, token: string, ttlHours: number): Promise<Actor | null> {
  const rows = await db<(Actor & { active: boolean; tokenHash: string; stale: boolean })[]>`
    SELECT s.token_hash, st.id, st.username, st.display_name, st.role, st.must_change_password, st.active,
           s.last_seen_at < now() - interval '1 minute' AS stale
    FROM sessions s JOIN staff st ON st.id = s.staff_id
    WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now()`;
  const row = rows[0];
  if (!row || !row.active) return null;
  if (row.stale) {
    await db`
      UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(hours => ${ttlHours})
      WHERE token_hash = ${row.tokenHash}`;
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role as Role,
    mustChangePassword: row.mustChangePassword,
  };
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
