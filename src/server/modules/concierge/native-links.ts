import { businessDateOf } from "@shared/business-date";
import { gradeLabel } from "@shared/membership";
import type {
  NativeMemberSummary,
  NativeResourceOption,
} from "@shared/concierge/types";
import type { Db } from "../../db";
import { searchMembers } from "../members";
import {
  loadMembershipRules,
  memberFamily,
  projectedGrade,
} from "../membership";
import { loadSettings } from "../settings";
import { WorkspaceError } from "./validation";

/** Retain the saved link in history; only this read projection follows merges. */
export async function canonicalMemberId(
  db: Db,
  id: number,
): Promise<number | null> {
  const seen = new Set<number>();
  for (let depth = 0; depth < 30 && !seen.has(id); depth++) {
    seen.add(id);
    const [row] =
      await db`SELECT id,merged_into_id FROM members WHERE id=${id}`;
    if (!row) return null;
    if (row.mergedIntoId == null) return Number(row.id);
    id = Number(row.mergedIntoId);
  }
  throw new WorkspaceError("系统会员合并关系异常，请联系经理核对", 409);
}

export async function nativeMemberSummary(
  db: Db,
  originalId: number,
  timezone: string,
): Promise<NativeMemberSummary | null> {
  const id = await canonicalMemberId(db, originalId);
  if (id == null) return null;
  const [row] =
    await db`SELECT id,member_no,name,phone,status,principal_balance,bonus_balance,
    (SELECT coalesce(sum(remaining),0) FROM bonus_lots WHERE member_id=m.id AND remaining>0 AND expires_at<=now()) AS expired_bonus
    FROM members m WHERE id=${id}`;
  if (!row) return null;
  const settings = await loadSettings(db);
  const day = businessDateOf(
    new Date(),
    timezone,
    settings.businessDayStartHour,
  );
  const state = await projectedGrade(db, id, day);
  if (!state) return null;
  const family = await memberFamily(db, id);
  const profiles =
    await db`SELECT id,code,data->>'name' AS name FROM concierge_members WHERE native_member_id IN ${db(family)} ORDER BY code`;
  const bonus = Math.max(
    0,
    Number(row.bonusBalance) - Number(row.expiredBonus),
  );
  return {
    id: Number(row.id),
    memberNo: row.memberNo,
    name: row.name,
    phone: row.phone,
    status: row.status,
    gradeLabel: gradeLabel(
      await loadMembershipRules(db),
      state.grade,
      state.tier,
    ),
    grade: state.grade,
    tier: state.tier,
    cycleEnd: state.cycleEnd,
    graceUntil: state.graceUntil,
    principalCents: Number(row.principalBalance),
    bonusCents: bonus,
    totalCents: Number(row.principalBalance) + bonus,
    profiles: profiles.map((p) => ({
      id: String(p.id),
      code: String(p.code).padStart(6, "0"),
      name: String(p.name),
    })),
  };
}

/** Same lookup semantics as the member workbench; never return its full DTO. */
export async function searchNativeMembers(db: Db, q: string, timezone: string) {
  const rows = await searchMembers(db, q, 30);
  const seen = new Set<number>();
  const result: NativeMemberSummary[] = [];
  for (const row of rows) {
    const id = await canonicalMemberId(db, Number(row.id));
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    const summary = await nativeMemberSummary(db, id, timezone);
    if (summary) result.push(summary);
  }
  return result;
}

export async function nativeResourceOptions(
  db: Db,
): Promise<NativeResourceOption[]> {
  const spaces =
    await db`SELECT s.id,s.code,s.display_name,s.business_type,s.capacity,s.active,s.sellable,s.verify_status,
    f.name AS floor_name,f.active AS floor_active,z.name AS zone_name,z.active AS zone_active,
    EXISTS(SELECT 1 FROM rooms r WHERE r.space_id=s.id) AS has_room
    FROM spaces s JOIN floors f ON f.id=s.floor_id LEFT JOIN zones z ON z.id=s.zone_id
    ORDER BY f.sort_order,z.sort_order,s.code`;
  const tables =
    await db`SELECT id,name,area,seats,active FROM dining_tables ORDER BY sort_order,id`;
  const rooms =
    await db`SELECT r.id,r.space_id,r.room_no,r.floor,r.active,r.housekeeping,t.name AS type_name,t.active AS type_active,
    s.code,s.display_name,s.capacity,s.active AS space_active,s.sellable,s.verify_status,f.name AS floor_name,f.active AS floor_active,z.name AS zone_name,z.active AS zone_active
    FROM rooms r JOIN room_types t ON t.id=r.room_type_id LEFT JOIN spaces s ON s.id=r.space_id
    LEFT JOIN floors f ON f.id=s.floor_id LEFT JOIN zones z ON z.id=s.zone_id ORDER BY r.sort_order,r.room_no`;
  const result: NativeResourceOption[] = [];
  for (const s of spaces) {
    const group = [
      s.floorName,
      s.zoneName,
      s.capacity == null ? "" : `${s.capacity}人间`,
    ]
      .filter(Boolean)
      .join(" · ");
    const name = `${s.displayName}（${s.code}）`;
    result.push({
      key: `space:${s.id}`,
      kind: "space",
      id: Number(s.id),
      category: `space:${s.businessType}`,
      categoryLabel: s.businessType,
      group,
      name,
      label: [s.businessType, group, name].filter(Boolean).join(" / "),
      capacity: s.capacity,
      active: !!(
        s.active &&
        s.floorActive &&
        s.zoneActive !== false &&
        s.sellable &&
        s.businessType !== "客房" &&
        !s.hasRoom
      ),
      warning: s.hasRoom
        ? "此空间已挂接客房，新安排请从客房选择"
        : s.businessType === "客房"
          ? "请先在客房台账挂接此空间"
          : s.verifyStatus === "confirmed"
            ? ""
            : "空间尚待核对，安排前请与区域确认",
    });
  }
  for (const t of tables) {
    const group = t.area || "未分区";
    const name = `${t.name}（${t.seats}位）`;
    result.push({
      key: `dining_table:${t.id}`,
      kind: "dining_table",
      id: Number(t.id),
      category: "dining",
      categoryLabel: "餐厅",
      group,
      name,
      label: `餐厅 / ${group} / ${name}`,
      capacity: t.seats,
      active: !!t.active,
      warning: "",
    });
  }
  for (const r of rooms) {
    const group = [r.floorName || r.floor, r.zoneName, r.typeName]
      .filter(Boolean)
      .join(" · ");
    const name = r.displayName ? `${r.displayName}（${r.roomNo}）` : r.roomNo;
    result.push({
      key: `room:${r.id}`,
      kind: "room",
      id: Number(r.id),
      category: "guest_room",
      categoryLabel: "客房",
      group,
      name,
      label: `客房 / ${group} / ${name}`,
      capacity: r.capacity ?? null,
      active: !!(
        r.active &&
        r.typeActive &&
        r.spaceActive !== false &&
        r.floorActive !== false &&
        r.zoneActive !== false &&
        r.sellable !== false
      ),
      warning:
        r.housekeeping === "maintenance"
          ? "当前维修中，安排前请与客房确认"
          : r.housekeeping === "dirty"
            ? "当前待打扫，安排前请与客房确认"
            : "",
    });
  }
  return result;
}

/** Only actual resources are exclusive; group/capacity labels are never keys. */
export function resourceColumns(key: string | undefined) {
  const match = /^(space|dining_table|room):([1-9]\d*)$/.exec(key || "");
  if (key && (!match || !Number.isSafeInteger(Number(match[2]))))
    throw new WorkspaceError("系统资源编号不正确");
  return {
    spaceId: match?.[1] === "space" ? Number(match[2]) : null,
    tableId: match?.[1] === "dining_table" ? Number(match[2]) : null,
    roomId: match?.[1] === "room" ? Number(match[2]) : null,
  };
}

/** Bounded read-only fingerprints: linked identities, rule/day and small resource catalogs.
 * No triggers/locks are added to wallet writes. Unrelated staff audit entries do not invalidate it. */
export async function nativeRevision(db: Db, timezone: string) {
  const [row] = await db`WITH RECURSIVE linked AS (
    SELECT m.* FROM members m JOIN concierge_members c ON c.native_member_id=m.id
    UNION SELECT m.* FROM members m JOIN linked l ON l.merged_into_id=m.id
  ) SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(l)::text || ':' ||
      (SELECT coalesce(sum(remaining),0)::text FROM bonus_lots WHERE member_id=l.id AND remaining>0 AND expires_at<=now()),'' ORDER BY l.id),'')) FROM linked l) AS members,
    (SELECT md5(coalesce(string_agg(key || value::text,'' ORDER BY key),'')) FROM settings WHERE key IN ('membership_rules','business_day_start_hour')) AS rules,
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text,'' ORDER BY s.id),'')) FROM spaces s) AS spaces,
    (SELECT md5(coalesce(string_agg(to_jsonb(f)::text,'' ORDER BY f.id),'')) FROM floors f) AS floors,
    (SELECT md5(coalesce(string_agg(to_jsonb(z)::text,'' ORDER BY z.id),'')) FROM zones z) AS zones,
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY t.id),'')) FROM dining_tables t) AS tables,
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text,'' ORDER BY r.id),'')) FROM rooms r) AS rooms,
    (SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY t.id),'')) FROM room_types t) AS room_types`;
  const settings = await loadSettings(db);
  return [
    ...Object.values(row || {}),
    businessDateOf(new Date(), timezone, settings.businessDayStartHour),
  ].join(":");
}
