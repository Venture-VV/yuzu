// 灌前台、结账演示数据用的「当前时间」（PR #13 Codex 复核 P2-3）。
//
// 结账演示的收银班次在灌数据前 5 小时开班、结账在之后：营业日切换后 5 个半小时内灌数据时，原来班次落在前一个营业日、
// 结账落在当天，日结金额与 billing-expected.json 的固定预期对不上（check 照样通过，不容易察觉）。
// v0.7.25 起结账演示在这个时段把开班到交班这一段按比例压进当天（seed-billing.ts），命令行只作说明；
// 加 --previous-day 时把前台与结账演示整体放到前一个营业日（时间截至切换前 30 分钟），
// 前台演示用的时间记在 settings.demo_seed_anchor，结账演示沿用它，两条命令前后隔多久执行都对得上。
// 只影响合成演示数据（试用 / 正式环境本来就拒绝灌演示数据），不改演示数据的内容与固定预期。

import { businessDateOf, minuteOfDay } from '@shared/business-date';
import type { Db } from '../db';
import { loadSettings } from '../modules/settings';

/** 营业日切换后这么多分钟内灌演示数据会跨营业日（收银班次提前 300 分钟开班，另留 30 分钟余量） */
export const DEMO_SPLIT_MINUTES = 330;
export const DEMO_ANCHOR_KEY = 'demo_seed_anchor';

/** 现在灌演示数据会不会跨营业日；会时给出切换后已过的分钟数，与「整体放到前一个营业日」用的时间（切换前 30 分钟） */
export function demoSeedWindow(now: Date, timeZone: string, startHour: number): { since: number; anchor: Date } | null {
  const since = (minuteOfDay(now, timeZone) - startHour * 60 + 1440) % 1440;
  if (since >= DEMO_SPLIT_MINUTES) return null;
  return { since, anchor: new Date(now.getTime() - (since + 30) * 60_000) };
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export interface DemoSeedTime {
  /** 传给演示数据的时间；undefined 为按实际时间 */
  now?: Date;
  /** 按 --previous-day 放到前一个营业日时为 true（前台演示灌完后要记下 now） */
  anchored: boolean;
  /** 照常执行但要醒目提示的内容 */
  warning?: string;
  /** 一般说明 */
  notice?: string;
}

/**
 * 决定这次灌演示数据用的时间。结账演示：前台演示放到了前一个营业日时沿用同一时间；
 * 没放而这次要求放（--previous-day）时拒绝——结账会早于接待。
 */
export async function demoSeedTime(
  db: Db,
  opts: { timeZone: string; kind: 'frontdesk' | 'billing'; previousDay: boolean; now?: Date },
): Promise<DemoSeedTime> {
  const now = opts.now ?? new Date();
  const { businessDayStartHour } = await loadSettings(db);
  const day = (at: Date) => businessDateOf(at, opts.timeZone, businessDayStartHour);
  if (opts.kind === 'billing') {
    const [row] = await db<{ value: string }[]>`SELECT value FROM settings WHERE key = ${DEMO_ANCHOR_KEY}`;
    if (row) {
      const anchor = new Date(row.value);
      return { now: anchor, anchored: true, notice: `前台演示放在了前一个营业日（${day(anchor)}），结账演示沿用同一时间` };
    }
  }
  const w = demoSeedWindow(now, opts.timeZone, businessDayStartHour);
  if (!w) return { anchored: false };
  const start = businessDayStartHour * 60;
  const safe = hhmm(start + DEMO_SPLIT_MINUTES);
  if (!opts.previousDay) {
    // v0.7.25 起结账演示自己把开班到交班这一段压进当天（seed-billing.ts），单据都落在当天营业日，不再跨营业日
    return {
      anchored: false,
      notice:
        `现在是营业日切换（${hhmm(start)}）后 ${w.since} 分钟：结账演示的收银班次、结账与交班按比例压进当天营业日（先后顺序与金额不变），` +
        `单据都落在当天。要整体放到前一个营业日，两条演示命令（seed-frontdesk-demo、seed-billing-demo）都加 --previous-day（${safe} 之后执行不用加）。`,
    };
  }
  if (opts.kind === 'billing') {
    throw new Error(
      `前台演示不是加 --previous-day 灌的，结账演示不能单独放到前一个营业日（结账会早于接待）。` +
        `请换一个新的演示库，两条命令都加 --previous-day；或在 ${safe} 之后按实际时间执行。`,
    );
  }
  return {
    now: w.anchor,
    anchored: true,
    notice: `前台与结账演示整体放到前一个营业日（${day(w.anchor)}），时间截至 ${hhmm(start + 1440 - 30)}；固定预期按这个营业日核对`,
  };
}

/** 前台演示放到了前一个营业日：记下所用时间，结账演示沿用 */
export async function rememberDemoAnchor(db: Db, at: Date) {
  await db`
    INSERT INTO settings (key, value) VALUES (${DEMO_ANCHOR_KEY}, ${db.json(at.toISOString())})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}
