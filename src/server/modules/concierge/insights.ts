import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { businessDateOf } from "@shared/business-date";
import {
  expiryWindowEnd,
  gradeLabel,
  MAX_GRADE,
  type Grade,
  type GradeState,
  type Tier,
} from "@shared/membership";
import {
  INSIGHT_FILTER_BUCKETS,
  type InsightDormancyBucket,
  type InsightMember,
  type MemberInsights,
} from "@shared/concierge/insights-types";
import type { NativeMemberSummary } from "@shared/concierge/types";
import { guard } from "../../auth/guard";
import { readSnapshot, type Db } from "../../db";
import type { Deps } from "../../lib/context";
import { AppError, badRequest, notFound } from "../../lib/errors";
import { idParam, parse } from "../../lib/validate";
import { searchMembers } from "../members";
import { loadMembershipRules, projectedGrade } from "../membership";
import { loadSettings } from "../settings";
import { canonicalMemberIds, maskUnservedPhone } from "./native-links";
import { WorkspaceError } from "./validation";

const PAGE_SIZE = 50;
const optionalFilter = (value: unknown) =>
  value === "" || value === "all" ? undefined : value;
const Query = z.object({
  q: z
    .string()
    .trim()
    .max(60, "查找内容最多60字")
    .refine((q) => !q.includes("\u0000"), "查找内容含无效字符")
    .default(""),
  grade: z.preprocess(
    optionalFilter,
    z.coerce.number().int().min(0).max(MAX_GRADE).optional(),
  ),
  bucket: z.preprocess(
    optionalFilter,
    z.enum(INSIGHT_FILTER_BUCKETS).optional(),
  ),
  createdMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "创建月份应为YYYY-MM")
    .refine(
      (month) => Number(month.slice(0, 4)) >= 1900,
      "创建年份不能早于1900年",
    )
    .optional(),
  trendYear: z
    .string()
    .regex(/^\d{4}$/, "趋势年份应为四位年份YYYY")
    .transform(Number)
    .refine((year) => year >= 1900, "趋势年份不能早于1900年")
    .optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

interface Calendar {
  asOf: string;
  day: string;
  one: string;
  three: string;
  six: string;
  twelve: string;
  monthStart: string;
  previousMonthStart: string;
}

/** PG subtracts calendar months with month-end clamping, in the store's local wall time. */
export async function readInsightCalendar(
  db: Db,
  timezone: string,
  at = new Date(),
): Promise<Calendar> {
  const [clock] = await db<Calendar[]>`WITH clock AS (
    SELECT ${at.toISOString()}::timestamptz AS at,
           ${at.toISOString()}::timestamptz AT TIME ZONE ${timezone} AS local_at
  ) SELECT at AS as_of, local_at::date::text AS day,
    (local_at - interval '1 month') AT TIME ZONE ${timezone} AS one,
    (local_at - interval '3 months') AT TIME ZONE ${timezone} AS three,
    (local_at - interval '6 months') AT TIME ZONE ${timezone} AS six,
    (local_at - interval '12 months') AT TIME ZONE ${timezone} AS twelve,
    date_trunc('month',local_at) AT TIME ZONE ${timezone} AS month_start,
    (date_trunc('month',local_at)-interval '1 month') AT TIME ZONE ${timezone} AS previous_month_start
    FROM clock`;
  return clock!;
}

interface NativeRow {
  id: number;
  memberNo: string;
  name: string;
  phone: string;
  status: string;
  createdAt: string;
  createdMonth: string;
  principalBalance: number;
  bonusBalance: number;
  expiredBonus: number;
  grade: Grade;
  tier: Tier | null;
  cycleStart: string | null;
  cycleEnd: string | null;
  graceUntil: string | null;
  familyIds: number[];
  profiles: NativeMemberSummary["profiles"];
  lastVisitAt: string | null;
  daysSinceLastVisit: number | null;
}

/**
 * Only frontdesk visits establish a visit; cancelled/future rows never do.
 * 整合时改过（8.0.18）：到期没处理的赠金一次取、不逐位会员查；到访先按会员取最后一次、再并到主账号；
 * onlyIds 给了就只取这几位主账号（管家工作区的会员摘要一批取，不再一位一位查）。
 */
async function nativeRows(
  db: Db,
  timezone: string,
  at: Date,
  onlyIds: number[] | null = null,
): Promise<NativeRow[]> {
  if (onlyIds && !onlyIds.length) return [];
  const asOf = at.toISOString();
  const lastVisits = onlyIds
    ? db`SELECT f.canonical_id,max(v.checked_in_at) AS last_visit_at
        FROM family f JOIN visits v ON v.member_id=f.member_id
        WHERE v.status<>'cancelled' AND v.checked_in_at<=${asOf}::timestamptz
        GROUP BY f.canonical_id`
    : db`SELECT f.canonical_id,max(v.last_visit_at) AS last_visit_at
        FROM family f JOIN (
          SELECT member_id,max(checked_in_at) AS last_visit_at FROM visits
          WHERE member_id IS NOT NULL AND status<>'cancelled' AND checked_in_at<=${asOf}::timestamptz
          GROUP BY member_id
        ) v ON v.member_id=f.member_id
        GROUP BY f.canonical_id`;
  return db<NativeRow[]>`WITH RECURSIVE family AS (
    SELECT m.id AS canonical_id,m.id AS member_id FROM members m
    WHERE m.merged_into_id IS NULL ${onlyIds ? db`AND m.id = ANY(${onlyIds}::bigint[])` : db``}
    UNION
    SELECT f.canonical_id,m.id FROM members m JOIN family f ON m.merged_into_id=f.member_id
  ), visits_by_account AS (
    ${lastVisits}
  ), service_profiles AS (
    SELECT f.canonical_id,jsonb_agg(jsonb_build_object('id',c.id::text,
      'code',lpad(c.code::text,6,'0'),'name',coalesce(c.data->>'name','')) ORDER BY c.code) AS profiles
    FROM family f JOIN concierge_members c ON c.native_member_id=f.member_id GROUP BY f.canonical_id
  ), families AS (
    SELECT canonical_id,array_agg(member_id ORDER BY member_id) AS family_ids FROM family GROUP BY canonical_id
  ), expired AS (
    SELECT member_id,sum(remaining) AS expired_bonus FROM bonus_lots
    WHERE remaining>0 AND expires_at IS NOT NULL AND expires_at<=${asOf}::timestamptz
    GROUP BY member_id
  ) SELECT m.id,m.member_no,m.name,m.phone,m.status,m.created_at,
      to_char(m.created_at AT TIME ZONE ${timezone},'YYYY-MM') AS created_month,m.principal_balance,m.bonus_balance,
      m.grade,m.tier,m.cycle_start,m.cycle_end,m.grace_until,f.family_ids,
      coalesce(p.profiles,'[]'::jsonb) AS profiles,v.last_visit_at,
      CASE WHEN v.last_visit_at IS NULL THEN NULL ELSE
        (${asOf}::timestamptz AT TIME ZONE ${timezone})::date-
        (v.last_visit_at AT TIME ZONE ${timezone})::date END AS days_since_last_visit,
      coalesce(e.expired_bonus,0) AS expired_bonus
    FROM members m JOIN families f ON f.canonical_id=m.id
    LEFT JOIN visits_by_account v ON v.canonical_id=m.id LEFT JOIN service_profiles p ON p.canonical_id=m.id
    LEFT JOIN expired e ON e.member_id=m.id
    ORDER BY m.created_at DESC,m.id DESC`;
}

function dormancy(
  last: string | null,
  calendar: Calendar,
): InsightDormancyBucket {
  if (last === null) return "never";
  const time = Date.parse(last);
  if (time > Date.parse(calendar.one)) return "recent";
  if (time > Date.parse(calendar.three)) return "oneToThree";
  if (time > Date.parse(calendar.six)) return "threeToSix";
  if (time > Date.parse(calendar.twelve)) return "sixToTwelve";
  return "twelvePlus";
}

async function statesOf(
  db: Db,
  rows: NativeRow[],
  day: string,
): Promise<Map<number, GradeState>> {
  const states = new Map<number, GradeState>();
  for (const row of rows) {
    let state: GradeState = {
      grade: row.grade,
      tier: row.tier,
      cycleStart: row.cycleStart,
      cycleEnd: row.cycleEnd,
      graceUntil: row.graceUntil,
    };
    const end = expiryWindowEnd(state);
    // Current persisted states need no per-member projection queries. Overdue states use the native rule engine.
    if (state.grade > 0 && state.cycleStart && end && end < day)
      state = (await projectedGrade(db, Number(row.id), day)) ?? state;
    states.set(Number(row.id), state);
  }
  return states;
}

function memberOf(
  row: NativeRow,
  state: GradeState,
  rules: Awaited<ReturnType<typeof loadMembershipRules>>,
  calendar: Calendar,
): InsightMember {
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
    grade: state.grade,
    tier: state.tier,
    gradeLabel: gradeLabel(rules, state.grade, state.tier),
    cycleEnd: state.cycleEnd,
    graceUntil: state.graceUntil,
    principalCents: Number(row.principalBalance),
    bonusCents: bonus,
    totalCents: Number(row.principalBalance) + bonus,
    profiles: row.profiles,
    createdAt: row.createdAt,
    lastVisitAt: row.lastVisitAt,
    daysSinceLastVisit:
      row.daysSinceLastVisit == null ? null : Number(row.daysSinceLastVisit),
    dormancyBucket: dormancy(row.lastVisitAt, calendar),
  };
}

/** The caller supplies one read-only repeatable-read snapshot for stats, filtering, and details. */
export async function loadMemberInsights(
  db: Db,
  timezone: string,
  rawQuery: unknown = {},
  at = new Date(),
): Promise<MemberInsights> {
  const query = parse(Query, rawQuery);
  const calendar = await readInsightCalendar(db, timezone, at);
  const currentMonth = calendar.day.slice(0, 7);
  const currentYear = Number(currentMonth.slice(0, 4));
  if (query.createdMonth !== undefined && query.createdMonth > currentMonth)
    throw badRequest("创建月份不能晚于门店当前月份", { field: "createdMonth" });
  const trendYear = query.trendYear ?? currentYear;
  if (trendYear > currentYear)
    throw badRequest("趋势年份不能晚于门店当前年份", { field: "trendYear" });
  const settings = await loadSettings(db);
  const rules = await loadMembershipRules(db);
  const rows = await nativeRows(db, timezone, at);
  const states = await statesOf(
    db,
    rows,
    businessDateOf(at, timezone, settings.businessDayStartHour),
  );
  const all = rows.map((row) =>
    memberOf(row, states.get(Number(row.id))!, rules, calendar),
  );
  const groups = {
    oneToThree: 0,
    threeToSix: 0,
    sixToTwelve: 0,
    twelvePlus: 0,
    never: 0,
  };
  for (const member of all)
    if (member.dormancyBucket !== "recent") groups[member.dormancyBucket]++;
  const createdBetween = (from: string, to: string) =>
    all.filter(
      (m) =>
        Date.parse(m.createdAt) >= Date.parse(from) &&
        Date.parse(m.createdAt) < Date.parse(to),
    ).length;
  const newThisMonth = createdBetween(
    calendar.monthStart,
    new Date(at.getTime() + 1).toISOString(),
  );
  const newLastMonth = createdBetween(
    calendar.previousMonthStart,
    calendar.monthStart,
  );
  const creationMonths = new Map(
    rows.map((row) => [Number(row.id), row.createdMonth]),
  );
  const monthCounts = new Map<string, number>();
  for (const row of rows) {
    // Do not count a future-dated creation even within the currently available month.
    if (Date.parse(row.createdAt) > at.getTime()) continue;
    monthCounts.set(
      row.createdMonth,
      (monthCounts.get(row.createdMonth) ?? 0) + 1,
    );
  }
  let matchingIds: Set<number> | null = null;
  if (query.q && rows.length) {
    // Reuse the native matcher (formatted phones, member numbers, and active physical cards).
    // Include its complete bounded population before canonical deduplication/pagination.
    const found = await searchMembers(
      db,
      query.q,
      rows.reduce((sum, row) => sum + row.familyIds.length, 0),
    );
    const foundIds = new Set(found.map((m) => Number(m.id)));
    matchingIds = new Set(
      rows
        .filter((row) => row.familyIds.some((id) => foundIds.has(Number(id))))
        .map((row) => Number(row.id)),
    );
  }
  const filtered = all.filter(
    (m) =>
      (!matchingIds || matchingIds.has(m.id)) &&
      (query.grade === undefined || m.grade === query.grade) &&
      (query.bucket === undefined ||
        (query.bucket === "dormant"
          ? ["threeToSix", "sixToTwelve", "twelvePlus"].includes(
              m.dormancyBucket,
            )
          : m.dormancyBucket === query.bucket)) &&
      (query.createdMonth === undefined ||
        (creationMonths.get(m.id) === query.createdMonth &&
          Date.parse(m.createdAt) <= at.getTime())),
  );
  return {
    members: filtered.slice(query.offset, query.offset + PAGE_SIZE),
    stats: {
      totalMembers: all.length,
      visitedLastMonth: all.filter((m) => m.dormancyBucket === "recent").length,
      newThisMonth,
      newLastMonth,
      newDelta: newThisMonth - newLastMonth,
      dormantThreeMonths:
        groups.threeToSix + groups.sixToTwelve + groups.twelvePlus,
      neverVisited: groups.never,
    },
    dormancyGroups: groups,
    tiers: Array.from({ length: MAX_GRADE + 1 }, (_, grade) => ({
      grade,
      label: gradeLabel(rules, grade, null),
      count: all.filter((m) => m.grade === grade).length,
    })),
    growth: {
      year: trendYear,
      months: Array.from({ length: 12 }, (_, index) => {
        const month = `${trendYear}-${String(index + 1).padStart(2, "0")}`;
        const available = month <= currentMonth;
        return {
          month,
          count: available ? (monthCounts.get(month) ?? 0) : 0,
          available,
        };
      }),
    },
    filteredTotal: filtered.length,
    serverTime: at.toISOString(),
    timezone,
    offset: query.offset,
    limit: PAGE_SIZE,
    hasMore: filtered.length > query.offset + PAGE_SIZE,
  };
}

/** 几位会员一批取（给的可以是被合并的旧编号，都落到主账号上）；键是给进来的编号。 */
export async function loadInsightMembersByIds(
  db: Db,
  timezone: string,
  ids: number[],
  at = new Date(),
): Promise<Map<number, InsightMember>> {
  const result = new Map<number, InsightMember>();
  const canonical = await canonicalMemberIds(db, ids);
  const wanted = [...new Set([...canonical.values()])];
  if (!wanted.length) return result;
  const rows = await nativeRows(db, timezone, at, wanted);
  const calendar = await readInsightCalendar(db, timezone, at);
  const rules = await loadMembershipRules(db);
  const settings = await loadSettings(db);
  const states = await statesOf(
    db,
    rows,
    businessDateOf(at, timezone, settings.businessDayStartHour),
  );
  const byCanonical = new Map(
    rows.map((row) => [
      Number(row.id),
      memberOf(row, states.get(Number(row.id))!, rules, calendar),
    ]),
  );
  for (const [id, target] of canonical) {
    const member = byCanonical.get(target);
    if (member) result.set(id, member);
  }
  return result;
}

export async function loadInsightMember(
  db: Db,
  timezone: string,
  id: number,
  at = new Date(),
): Promise<InsightMember> {
  const member = (await loadInsightMembersByIds(db, timezone, [id], at)).get(id);
  if (!member) throw notFound("系统会员不存在");
  return member;
}

async function handle<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof WorkspaceError)
      throw new AppError(error.status, "CONCIERGE_VALIDATION", error.message);
    throw error;
  }
}

export function registerConciergeInsightsRoutes(
  app: FastifyInstance,
  { sql, config }: Deps,
) {
  app.get(
    "/api/concierge/member-insights",
    { preHandler: guard("concierge.read") },
    async (req, reply) =>
      handle(async () => {
        reply.header("Cache-Control", "private, no-store");
        const at = new Date();
        const data = await readSnapshot(sql, (db) =>
          loadMemberInsights(db, config.timezone, req.query ?? {}, at),
        );
        return { ...data, members: data.members.map((m) => maskUnservedPhone(m, req.actor)) };
      }),
  );
  app.get(
    "/api/concierge/member-insights/:id",
    { preHandler: guard("concierge.read") },
    async (req, reply) =>
      handle(async () => {
        reply.header("Cache-Control", "private, no-store");
        const { id } = parse(idParam, req.params);
        const at = new Date();
        return {
          member: maskUnservedPhone(
            await readSnapshot(sql, (db) =>
              loadInsightMember(db, config.timezone, id, at),
            ),
            req.actor,
          ),
        };
      }),
  );
}
