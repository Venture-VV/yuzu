import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { businessDateOf } from "@shared/business-date";
import {
  expiryWindowEnd,
  expiryStep,
  gradeLabel,
  MAX_GRADE,
  type Grade,
  type GradeState,
  type Tier,
  type MembershipRules,
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
  rules: MembershipRules,
): Promise<Map<number, GradeState>> {
  const states = new Map<number, GradeState>();
  const overdue = rows.filter((row) => {
    const end = expiryWindowEnd(row);
    return row.grade > 0 && row.cycleStart && end && end < day;
  });
  // Preserve the native due projection's completed family consumption and
  // closed business-date intervals, but fetch all selected accounts together.
  type MemberSpend = { root: number; day: string; amount: number };
  const spendRows: MemberSpend[] = overdue.length ? await db<MemberSpend[]>`WITH RECURSIVE family AS (
    SELECT id AS root,id FROM members WHERE id=ANY(${overdue.map((r) => Number(r.id))}::bigint[])
    UNION SELECT f.root,m.id FROM members m JOIN family f ON m.merged_into_id=f.id
  ) SELECT f.root,c.business_date::text AS day,sum(c.total_amount)::bigint AS amount
    FROM family f JOIN consumptions c ON c.member_id=f.id
    WHERE c.status='completed' AND c.business_date>=${overdue.map((r) => r.cycleStart!).sort()[0]!}
    GROUP BY f.root,c.business_date` : [];
  const spendByMember = new Map<number, MemberSpend[]>();
  for (const row of spendRows) {
    const id = Number(row.root), spends = spendByMember.get(id) ?? [];
    spends.push(row);
    spendByMember.set(id, spends);
  }
  for (const row of rows) {
    let state: GradeState = {
      grade: row.grade,
      tier: row.tier,
      cycleStart: row.cycleStart,
      cycleEnd: row.cycleEnd,
      graceUntil: row.graceUntil,
    };
    const spends = spendByMember.get(Number(row.id)) ?? [];
    // Same read-only expiry steps and bound as membership.projectDue.
    for (let i = 0; i < 40; i++) {
      const end = expiryWindowEnd(state);
      if (state.grade === 0 || !state.cycleStart || !end || end >= day) break;
      const from = state.cycleStart;
      const spend = spends.reduce((sum, r) => sum + (r.day >= from && r.day <= end ? Number(r.amount) : 0), 0);
      const step = expiryStep(rules, state, spend, day);
      if (!step) break;
      state = step.next;
    }
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

interface InsightTotals {
  total: number;
  buckets: Partial<Record<InsightDormancyBucket, number>> | null;
  grades: Record<string, number> | null;
  newThis: number;
  newLast: number;
  months: Record<string, number> | null;
  filteredTotal: number;
  pageIds: (number | string)[];
}

/**
 * The caller supplies one read-only repeatable-read snapshot for stats, filtering, and details.
 *
 * 8.0.19（W9）：统计、筛选、翻页都在数据库里做，只把这一页的 50 位取出来。原来每次请求把全部会员读进来、
 * 在这里逐位算（2 万会员约 0.35 秒，还要把 2 万行搬过来）。口径没有变：
 *   · 到访 = 前台有效入场（不含作废、不含 at 之后的），合并的会员并到主账号；四段按门店时区的日历月周年时刻分；
 *   · 档级：会籍到期还没处理的（通常没有，每天的到期处理会清掉）先按会员规则投影，再当作覆盖传进查询；
 *   · 查找沿用会员工作台的查法（手机号各种写法、会员号、实体卡），查到的落到主账号。
 */
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
  const day = businessDateOf(at, timezone, settings.businessDayStartHour);
  const asOf = at.toISOString();
  // 「不算将来的」统一用这个上界（与原来按毫秒比较一致：at 这一毫秒以内建的算）
  const notAfter = new Date(at.getTime() + 1).toISOString();

  // 会籍到期还没处理的主账号：按规则投影出现在的档级，覆盖存着的那个
  const overdue = await db<{ id: number }[]>`SELECT id FROM members
    WHERE merged_into_id IS NULL AND grade > 0 AND cycle_start IS NOT NULL
      AND coalesce(grace_until, cycle_end) < ${day}::date ORDER BY id`;
  const overrideIds: number[] = [];
  const overrideGrades: number[] = [];
  for (const row of overdue) {
    const state = await projectedGrade(db, Number(row.id), day);
    if (!state) continue;
    overrideIds.push(Number(row.id));
    overrideGrades.push(state.grade);
  }

  let matchIds: number[] | null = null;
  if (query.q) {
    // Reuse the native matcher (formatted phones, member numbers, and active physical cards).
    // Include its complete bounded population before canonical deduplication/pagination.
    const [population] = await db<{ total: number }[]>`SELECT count(*)::int AS total FROM members`;
    const found = population!.total ? await searchMembers(db, query.q, population!.total) : [];
    matchIds = [...new Set((await canonicalMemberIds(db, found.map((m) => Number(m.id)))).values())];
  }

  const where = [
    matchIds ? db`AND id = ANY(${matchIds}::bigint[])` : db``,
    query.grade !== undefined ? db`AND grade = ${query.grade}` : db``,
    query.bucket === "dormant"
      ? db`AND bucket IN ('threeToSix','sixToTwelve','twelvePlus')`
      : query.bucket !== undefined
        ? db`AND bucket = ${query.bucket}`
        : db``,
    query.createdMonth !== undefined
      ? db`AND created_month = ${query.createdMonth} AND created_at < ${notAfter}::timestamptz`
      : db``,
  ];
  const [totals] = await db<InsightTotals[]>`WITH RECURSIVE family AS (
      SELECT m.id AS canonical_id,m.id AS member_id FROM members m WHERE m.merged_into_id IS NULL
      UNION
      SELECT f.canonical_id,m.id FROM members m JOIN family f ON m.merged_into_id=f.member_id
    ), last_visit AS (
      SELECT f.canonical_id,max(v.last_visit_at) AS last_visit_at
      FROM family f JOIN (
        SELECT member_id,max(checked_in_at) AS last_visit_at FROM visits
        WHERE member_id IS NOT NULL AND status<>'cancelled' AND checked_in_at<=${asOf}::timestamptz
        GROUP BY member_id
      ) v ON v.member_id=f.member_id
      GROUP BY f.canonical_id
    ), acct AS (
      SELECT m.id,m.created_at,coalesce(o.grade,m.grade)::int AS grade,
        to_char(m.created_at AT TIME ZONE ${timezone},'YYYY-MM') AS created_month,
        CASE WHEN l.last_visit_at IS NULL THEN 'never'
             WHEN l.last_visit_at > ${calendar.one}::timestamptz THEN 'recent'
             WHEN l.last_visit_at > ${calendar.three}::timestamptz THEN 'oneToThree'
             WHEN l.last_visit_at > ${calendar.six}::timestamptz THEN 'threeToSix'
             WHEN l.last_visit_at > ${calendar.twelve}::timestamptz THEN 'sixToTwelve'
             ELSE 'twelvePlus' END AS bucket
      FROM members m LEFT JOIN last_visit l ON l.canonical_id=m.id
      LEFT JOIN unnest(${overrideIds}::bigint[],${overrideGrades}::int[]) AS o(id,grade) ON o.id=m.id
      WHERE m.merged_into_id IS NULL
    ), picked AS (
      SELECT id,created_at FROM acct WHERE true ${where[0]!} ${where[1]!} ${where[2]!} ${where[3]!}
    ) SELECT
      (SELECT count(*)::int FROM acct) AS total,
      (SELECT jsonb_object_agg(bucket,n) FROM (SELECT bucket,count(*)::int AS n FROM acct GROUP BY bucket) b) AS buckets,
      (SELECT jsonb_object_agg(grade::text,n) FROM (SELECT grade,count(*)::int AS n FROM acct GROUP BY grade) g) AS grades,
      (SELECT count(*)::int FROM acct WHERE created_at >= ${calendar.monthStart}::timestamptz AND created_at < ${notAfter}::timestamptz) AS new_this,
      (SELECT count(*)::int FROM acct WHERE created_at >= ${calendar.previousMonthStart}::timestamptz AND created_at < ${calendar.monthStart}::timestamptz) AS new_last,
      (SELECT jsonb_object_agg(created_month,n) FROM (
        SELECT created_month,count(*)::int AS n FROM acct
        WHERE created_at < ${notAfter}::timestamptz AND created_month LIKE ${`${trendYear}-%`} GROUP BY created_month) c) AS months,
      (SELECT count(*)::int FROM picked) AS filtered_total,
      (SELECT coalesce(array_agg(id ORDER BY created_at DESC,id DESC),'{}') FROM (
        SELECT id,created_at FROM picked ORDER BY created_at DESC,id DESC LIMIT ${PAGE_SIZE} OFFSET ${query.offset}) p) AS page_ids`;
  const t = totals!;
  const buckets = t.buckets ?? {};
  const groups = {
    oneToThree: buckets.oneToThree ?? 0,
    threeToSix: buckets.threeToSix ?? 0,
    sixToTwelve: buckets.sixToTwelve ?? 0,
    twelvePlus: buckets.twelvePlus ?? 0,
    never: buckets.never ?? 0,
  };
  const gradeCounts = t.grades ?? {};
  const monthCounts = t.months ?? {};

  // 只取这一页的详情（余额、可用赠金、服务档案、上次到访……）；nativeRows 的顺序与翻页的顺序相同
  const rows = await nativeRows(db, timezone, at, t.pageIds.map(Number));
  const states = await statesOf(db, rows, day, rules);
  const members = rows.map((row) =>
    memberOf(row, states.get(Number(row.id))!, rules, calendar),
  );
  const filteredTotal = Number(t.filteredTotal);
  return {
    members,
    stats: {
      totalMembers: Number(t.total),
      visitedLastMonth: buckets.recent ?? 0,
      newThisMonth: Number(t.newThis),
      newLastMonth: Number(t.newLast),
      newDelta: Number(t.newThis) - Number(t.newLast),
      dormantThreeMonths:
        groups.threeToSix + groups.sixToTwelve + groups.twelvePlus,
      neverVisited: groups.never,
    },
    dormancyGroups: groups,
    tiers: Array.from({ length: MAX_GRADE + 1 }, (_, grade) => ({
      grade,
      label: gradeLabel(rules, grade, null),
      count: gradeCounts[String(grade)] ?? 0,
    })),
    growth: {
      year: trendYear,
      months: Array.from({ length: 12 }, (_, index) => {
        const month = `${trendYear}-${String(index + 1).padStart(2, "0")}`;
        const available = month <= currentMonth;
        return {
          month,
          count: available ? (monthCounts[month] ?? 0) : 0,
          available,
        };
      }),
    },
    filteredTotal,
    serverTime: at.toISOString(),
    timezone,
    offset: query.offset,
    limit: PAGE_SIZE,
    hasMore: filteredTotal > query.offset + PAGE_SIZE,
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
    rules,
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
