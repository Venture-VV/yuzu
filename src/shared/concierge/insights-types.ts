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

export interface InsightMember extends NativeMemberSummary {
  /** Creation time of the final native account, not the service extension. */
  createdAt: string;
  lastVisitAt: string | null;
  daysSinceLastVisit: number | null;
  dormancyBucket: InsightDormancyBucket;
}

export interface MemberInsights {
  members: InsightMember[];
  /** All final native accounts; unaffected by q, grade, bucket, or pagination. */
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
  serverTime: string;
  timezone: string;
  offset: number;
  limit: number;
  hasMore: boolean;
}
