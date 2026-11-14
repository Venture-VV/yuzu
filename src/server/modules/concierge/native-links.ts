import { businessDateOf } from "@shared/business-date";
import type {
  NativeMemberSummary,
  NativeResourceOption,
} from "@shared/concierge/types";
import type { InsightMember } from "@shared/concierge/insights-types";
import { maskPhone } from "@shared/labels";
import { can } from "@shared/permissions";
import type { Db } from "../../db";
import type { Actor } from "../../lib/context";
import { searchMembers } from "../members";
import { loadSettings } from "../settings";
import { loadInsightMembersByIds } from "./insights";
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

/**
 * 没有「查找与查看会员」权限的人看会员名单时，还没建管家服务档案的会员手机号打码（8.0.18 整合）：
 * 看全体会员的档阶、余额、到访是店主定的（GJ13、GJ18、GJ26），手机号不在那几项里；
 * 已经建了服务档案的是服务要用的，照旧显示。
 */
export function maskUnservedPhone<T extends { phone: string; profiles: unknown[] }>(
  member: T,
  actor: Actor,
): T {
  if (can(actor, "member.read") || member.profiles.length || !member.phone) return member;
  return { ...member, phone: maskPhone(member.phone) };
}

/** 一批编号各自落到哪位主账号（沿「合并到」走到头）；不存在的不在结果里。 */
export async function canonicalMemberIds(
  db: Db,
  ids: number[],
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  const wanted = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!wanted.length) return result;
  const rows = await db<{ origin: number; id: number; depth: number }[]>`WITH RECURSIVE chain AS (
      SELECT m.id AS origin,m.id,m.merged_into_id,0 AS depth FROM members m WHERE m.id = ANY(${wanted}::bigint[])
      UNION ALL
      SELECT c.origin,m.id,m.merged_into_id,c.depth+1 FROM chain c JOIN members m ON m.id=c.merged_into_id
      WHERE c.depth < 30
    ) SELECT origin,id,depth FROM chain WHERE merged_into_id IS NULL`;
  for (const row of rows) result.set(Number(row.origin), Number(row.id));
  return result;
}

const summaryOf = (m: InsightMember): NativeMemberSummary => ({
  id: m.id,
  memberNo: m.memberNo,
  name: m.name,
  phone: m.phone,
  status: m.status,
  gradeLabel: m.gradeLabel,
  grade: m.grade,
  tier: m.tier,
  cycleEnd: m.cycleEnd,
  graceUntil: m.graceUntil,
  principalCents: m.principalCents,
  bonusCents: m.bonusCents,
  totalCents: m.totalCents,
  profiles: m.profiles,
});

/**
 * 几位会员的摘要一批取（8.0.18 整合时改：原来一位 8 条以上查询，工作区有多少服务档案就乘多少）。
 * 键是给进来的编号（可以是被合并的旧编号）。
 */
export async function nativeMemberSummaries(
  db: Db,
  ids: number[],
  timezone: string,
): Promise<Map<number, NativeMemberSummary>> {
  const members = await loadInsightMembersByIds(db, timezone, ids);
  return new Map([...members].map(([id, m]) => [id, summaryOf(m)]));
}

export async function nativeMemberSummary(
  db: Db,
  originalId: number,
  timezone: string,
): Promise<NativeMemberSummary | null> {
  return (await nativeMemberSummaries(db, [originalId], timezone)).get(originalId) ?? null;
}

/** Same lookup semantics as the member workbench; never return its full DTO. */
export async function searchNativeMembers(db: Db, q: string, timezone: string) {
  const rows = await searchMembers(db, q, 30);
  const ids = rows.map((row) => Number(row.id));
  const summaries = await nativeMemberSummaries(db, ids, timezone);
  const seen = new Set<number>();
  const result: NativeMemberSummary[] = [];
  for (const id of ids) {
    const summary = summaries.get(id);
    if (!summary || seen.has(summary.id)) continue;
    seen.add(summary.id);
    result.push(summary);
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
 * No triggers/locks are added to wallet writes. Unrelated staff audit entries do not invalidate it.
 * 8.0.18 整合时改：从已关联的会员出发、逐位走主键（原来每 3 秒把 members 整表扫两遍）；
 * OFFSET 0 是有意的——不让规划器把它摊平成对 members 的整表连接。 */
export async function nativeRevision(db: Db, timezone: string) {
  const [row] = await db`WITH RECURSIVE linked AS (
    SELECT m.* FROM (SELECT DISTINCT native_member_id FROM concierge_members WHERE native_member_id IS NOT NULL) c
      CROSS JOIN LATERAL (SELECT * FROM members WHERE id=c.native_member_id OFFSET 0) m
    UNION
    SELECT m.* FROM linked l
      CROSS JOIN LATERAL (SELECT * FROM members WHERE id=l.merged_into_id OFFSET 0) m
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
