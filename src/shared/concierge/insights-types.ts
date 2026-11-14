import type { NativeMemberSummary } from "./types";

/** Calendar-month anniversaries in the store timezone, rather than 30/90-day approximations. */
export const INSIGHT_BUCKETS = [
  "recent",
  "oneToThree",
  "threeToSix",
  "sixToTwelve",
  "twelvePlus",
  "never",
] as const;
export type InsightDormancyBucket = (typeof INSIGHT_BUCKETS)[number];
/** A combined filter only; each member keeps its exclusive dormancy classification. */
export const INSIGHT_FILTER_BUCKETS = [...INSIGHT_BUCKETS, "dormant"] as const;
export type InsightBucketFilter = (typeof INSIGHT_FILTER_BUCKETS)[number];

export interface InsightMember extends NativeMemberSummary {
  /** Creation time of the final native account, not the service extension. */
  createdAt: string;
  lastVisitAt: string | null;
  daysSinceLastVisit: number | null;
  dormancyBucket: InsightDormancyBucket;
}

export interface MemberInsights {
  members: InsightMember[];
  /** All final native accounts; unaffected by any list filters or pagination. */
  stats: {
    totalMembers: number;
    visitedLastMonth: number;
    newThisMonth: number;
    newLastMonth: number;
    /** Current month minus last month; a count, not a percentage. */
    newDelta: number;
    dormantThreeMonths: number;
    neverVisited: number;
  };
  dormancyGroups: {
    oneToThree: number;
    threeToSix: number;
    sixToTwelve: number;
    twelvePlus: number;
    never: number;
  };
  /** Seven native grades, including zero counts; tier remains on each member. */
  tiers: Array<{ grade: number; label: string; count: number }>;
  /** Native account creation in local calendar months; unaffected by list filters. */
  growth: {
    year: number;
    months: Array<{ month: string; count: number; available: boolean }>;
  };
  /** Number matching q, grade, bucket and createdMonth, before the 50-row page. */
  filteredTotal: number;
  serverTime: string;
  timezone: string;
  offset: number;
  limit: number;
  hasMore: boolean;
}
