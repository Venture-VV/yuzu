// 员工食堂 · 饭点提醒与网页推送（店主 2026-11-10，docs/CANTEEN.md 第 19 节，K23、K24，迁移 120）。
//   · 推送钥匙（VAPID）：第一次用到时生成、存在 web_push_keys（私钥不进设置、不给页面、不写日志）。
//   · 员工的订阅：一台手机一条（推送地址唯一）；同一台手机换人登录后再打开提醒，改到新的人名下；一个人最多 5 台，多了停用最早的。
//     员工点「关掉提醒」、退出登录、推送服务说没了（404 / 410）时停用，记录留着。只写订阅自己一行，不锁员工（发的时候只发在用的人）。
//   · 员工的选择：哪几顿不要提醒（canteen_push_prefs，只写自己一行）。
//   · 提醒的设置：规则类设置 canteen_reminders（规则锁，带改了几次 rev，对不上拒绝 REMINDERS_CHANGED）。
//   · 每分钟的自动任务：到点（后台设的时间，没设为开饭时）以后 30 分钟之内，每天每顿只发一次——先认领（「哪天哪顿」的唯一约束兜底，
//     几个进程同时跑也只有一个认领到，写 10 分钟租约），事务外发送；每台手机先记一行再发（主键兜底：同一次提醒同一台手机只发一次，
//     中断后接着发的跳过记过的），最后记结果。停用的人、已经打过这一顿卡的、自己关了这一顿的不发。都不等业务锁。
//   · 发一条试试：员工在「我的」里给自己的手机发；后台给某位员工的手机发。不记进每天的提醒，只更新那几台手机的「最近送到 / 没送到」。

import { z } from 'zod';
import { MEAL_LABELS, MEALS, previousDate, type Meal, type MealWindow } from '@shared/canteen';
import { businessDateOf, HHMM, minuteOfDay } from '@shared/business-date';
import {
  defaultReminder,
  fillReminderLine,
  menuText,
  openPageUrl,
  pickReminderLine,
  PUSH_DEVICES_PER_EMPLOYEE,
  REMINDER_GRACE_MINUTES,
  REMINDER_LIMITS,
  REMINDER_OPEN_PAGES,
  REMINDER_TTL_SECONDS,
  reminderProblem,
  reminderTime,
  type MealReminder,
  type PushInfo,
  type PushMessage,
  type PushTestResult,
  type ReminderOverview,
  type ReminderRunView,
  type ReminderSettings,
} from '@shared/canteen-reminders';
import type { AppConfig } from '../../config';
import type { Db, Sql } from '../../db';
import type { OpContext } from '../../lib/context';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { saveRuleSetting } from '../../lib/rule-settings';
import { parse } from '../../lib/validate';
import { generateVapidKeys, pushEndpointProblem, pushKeysProblem, sendWebPush, type PushOutcome, type VapidKeys } from '../../lib/web-push';
import { enabledErpModules } from '../erp';
import { loadCanteenSettings } from './settings';

const toMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const allowLocal = (config: AppConfig) => config.canteen.pushLocalEndpoints === true;
/** 几台手机同时发 */
const CONCURRENCY = 6;
/** 认领后的租约：发得久了每分钟顺延 */
const LEASE_MINUTES = 10;
/** 一个人一天最多新记几个推送地址 */
const PUSH_NEW_DEVICES_PER_DAY = 20;

// ── 推送钥匙 ──

/** 这个实例的推送钥匙：没有就生成一副（几个进程同时生成时只留先写进去的那副） */
export async function vapidKeys(db: Db): Promise<VapidKeys> {
  const read = () => db<VapidKeys[]>`SELECT public_key, private_key FROM web_push_keys WHERE id = 1`;
  const [row] = await read();
  if (row) return row;
  const fresh = generateVapidKeys();
  await db`INSERT INTO web_push_keys (id, public_key, private_key) VALUES (1, ${fresh.publicKey}, ${fresh.privateKey}) ON CONFLICT (id) DO NOTHING`;
  return (await read())[0]!;
}

/** 告诉推送服务这是谁家的（VAPID 的 sub）：.env 设了联系方式用它；否则员工打开柚子饭堂的 https 地址、员工入口地址 */
function pushSubject(config: AppConfig, origin: string | null, portalUrl: string): string {
  if (config.canteen.pushContact) return config.canteen.pushContact;
  if (origin) return origin;
  if (/^https:\/\/[^/\s]+/.test(portalUrl)) return portalUrl;
  return 'mailto:canteen@example.com';
}

// ── 提醒的设置（后台） ──

/** 读设置：没存过、存的不完整或不对时按默认补齐（不认识的键忽略） */
export async function loadReminderSettings(db: Db): Promise<ReminderSettings> {
  const [row] = await db<{ value: { reminders?: unknown; rev?: unknown } | null }[]>`SELECT value FROM settings WHERE key = 'canteen_reminders'`;
  const v = row?.value ?? {};
  const saved = Array.isArray(v.reminders) ? (v.reminders as Partial<MealReminder>[]) : [];
  const reminders = MEALS.map((meal): MealReminder => {
    const d = defaultReminder(meal);
    const s = saved.find((r) => r && typeof r === 'object' && r.meal === meal);
    if (!s) return d;
    const r: MealReminder = {
      meal,
      enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
      time: s.time === null || (typeof s.time === 'string' && HHMM.test(s.time)) ? s.time : d.time,
      title: typeof s.title === 'string' ? s.title : d.title,
      lines: Array.isArray(s.lines) && s.lines.every((l) => typeof l === 'string') ? s.lines : d.lines,
      open: REMINDER_OPEN_PAGES.includes(s.open as never) ? s.open! : d.open,
    };
    return reminderProblem(r) ? d : r;
  });
  return { reminders, rev: typeof v.rev === 'number' && Number.isInteger(v.rev) && v.rev >= 0 ? v.rev : 0 };
}

const ReminderInput = z.object({
  rev: z.number('缺少改了几次（rev）').int().min(0),
  reminders: z
    .array(
      z.object({
        meal: z.enum(MEALS, '餐次不正确'),
        enabled: z.boolean(),
        time: z.string().regex(HHMM, '提醒时间写成 HH:MM').nullable(),
        title: z.string().max(200, `标题最多 ${REMINDER_LIMITS.title} 个字`),
        lines: z.array(z.string().max(400, `每句最多 ${REMINDER_LIMITS.line} 个字`)).max(REMINDER_LIMITS.lines, `柚子说的话最多 ${REMINDER_LIMITS.lines} 句`),
        open: z.enum(REMINDER_OPEN_PAGES, '点通知打开的页面不正确'),
      }),
    )
    .length(MEALS.length, '四顿都要给'),
});

/** 保存提醒的设置：整份保存，带上打开时看到的 rev，对不上拒绝（别人刚改过）；空的句子去掉 */
export async function saveReminderSettings(sql: Sql, raw: unknown, ctx: OpContext): Promise<ReminderSettings> {
  const input = parse(ReminderInput, raw);
  const reminders = MEALS.map((meal): MealReminder => {
    const r = input.reminders.find((x) => x.meal === meal);
    if (!r) throw badRequest(`缺少${MEAL_LABELS[meal]}的提醒`);
    const clean: MealReminder = { meal, enabled: r.enabled, time: r.time, title: r.title.trim(), lines: r.lines.map((l) => l.trim()).filter(Boolean), open: r.open };
    const problem = reminderProblem(clean);
    if (problem) throw badRequest(`${MEAL_LABELS[meal]}的提醒：${problem}`);
    return clean;
  });
  return saveRuleSetting(
    sql,
    'canteen_reminders',
    loadReminderSettings,
    (before) => {
      if (before.rev !== input.rev) throw conflict('REMINDERS_CHANGED', '提醒设置刚被别人改过：刷新一下，看看新的再改');
      return { reminders, rev: before.rev + 1 };
    },
    ctx,
  );
}

// ── 员工端：订阅与选择 ──

/** 这台手机的提醒：推送公钥、后台开着的几顿几点提醒、自己关掉的几顿、开着提醒的手机几台 */
export async function pushInfo(sql: Sql, employeeId: number): Promise<PushInfo> {
  const keys = await vapidKeys(sql);
  const [settings, reminders] = await Promise.all([loadCanteenSettings(sql), loadReminderSettings(sql)]);
  const meals = reminders.reminders
    .filter((r) => r.enabled)
    .map((r) => ({ meal: r.meal, time: reminderTime(r, settings.meals.find((w) => w.meal === r.meal)) }))
    .filter((m): m is { meal: Meal; time: string } => m.time !== null);
  const [pref] = await sql<{ mutedMeals: Meal[] }[]>`SELECT muted_meals FROM canteen_push_prefs WHERE employee_id = ${employeeId}`;
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canteen_push_subscriptions WHERE employee_id = ${employeeId} AND disabled_at IS NULL`;
  return { publicKey: keys.publicKey, meals, muted: MEALS.filter((m) => pref?.mutedMeals.includes(m)), devices: count!.n };
}

const SubscriptionInput = z.object({
  endpoint: z.string('缺少推送地址').max(2048, '推送地址不对'),
  keys: z.object({ p256dh: z.string('缺少推送钥匙').max(200), auth: z.string('缺少推送钥匙').max(100) }, '缺少推送钥匙'),
  platform: z.enum(['ios', 'android', 'other']).optional(),
});

/**
 * 打开提醒（也用于每次打开柚子饭堂时核对一遍）：按推送地址记下或更新（换人登录的改到这个人名下、停用过的重新用上）；
 * origin 是浏览器带来的页面来源（请求来源已经核对过与员工端口一致），https 的才记
 */
export async function savePushSubscription(sql: Sql, config: AppConfig, employeeId: number, raw: unknown, origin: string | undefined): Promise<PushInfo> {
  const input = parse(SubscriptionInput, raw);
  const endpointProblem = pushEndpointProblem(input.endpoint, { allowLocal: allowLocal(config) });
  if (endpointProblem) throw unprocessable('PUSH_ENDPOINT', endpointProblem);
  const keysProblem = pushKeysProblem(input.keys.p256dh, input.keys.auth);
  if (keysProblem) throw unprocessable('PUSH_KEYS', keysProblem);
  const site = origin && /^https:\/\/[^/\s]+$/.test(origin) ? origin : null;
  await sql.begin(async (tx) => {
    // 新的推送地址一个人一天最多记 20 个（正常一台手机一个；挡住不停换地址把表撑大的）
    const [known] = await tx<{ id: number }[]>`SELECT id FROM canteen_push_subscriptions WHERE endpoint = ${input.endpoint}`;
    if (!known) {
      const [today] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM canteen_push_subscriptions WHERE employee_id = ${employeeId} AND created_at > now() - interval '1 day'`;
      if (today!.n >= PUSH_NEW_DEVICES_PER_DAY) throw new AppError(429, 'PUSH_TOO_MANY', '今天打开提醒的手机太多了，明天再试');
    }
    await tx`
      INSERT INTO canteen_push_subscriptions (employee_id, endpoint, p256dh, auth, platform, origin)
      VALUES (${employeeId}, ${input.endpoint}, ${input.keys.p256dh}, ${input.keys.auth}, ${input.platform ?? 'other'}, ${site})
      ON CONFLICT (endpoint) DO UPDATE SET
        employee_id = EXCLUDED.employee_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
        platform = coalesce(${input.platform ?? null}::text, canteen_push_subscriptions.platform),
        origin = coalesce(EXCLUDED.origin, canteen_push_subscriptions.origin), updated_at = now(),
        failures = CASE WHEN canteen_push_subscriptions.disabled_at IS NULL AND canteen_push_subscriptions.employee_id = EXCLUDED.employee_id
                        THEN canteen_push_subscriptions.failures ELSE 0 END,
        disabled_at = NULL, disabled_reason = NULL`;
    // 一个人最多 5 台：多了停用最早的（最近核对过的留着）
    await tx`
      UPDATE canteen_push_subscriptions SET disabled_at = now(), disabled_reason = 'off', updated_at = now()
      WHERE id IN (
        SELECT id FROM canteen_push_subscriptions WHERE employee_id = ${employeeId} AND disabled_at IS NULL
        ORDER BY updated_at DESC, id DESC OFFSET ${PUSH_DEVICES_PER_EMPLOYEE})`;
  });
  return pushInfo(sql, employeeId);
}

const EndpointInput = z.object({ endpoint: z.string('缺少推送地址').max(2048, '推送地址不对') });

/** 关掉这台手机的提醒（off），或退出登录（logout）：只停自己名下的 */
export async function removePushSubscription(sql: Sql, employeeId: number, raw: unknown, reason: 'off' | 'logout'): Promise<PushInfo> {
  const { endpoint } = parse(EndpointInput, raw);
  await sql`
    UPDATE canteen_push_subscriptions SET disabled_at = now(), disabled_reason = ${reason}, updated_at = now()
    WHERE endpoint = ${endpoint} AND employee_id = ${employeeId} AND disabled_at IS NULL`;
  return pushInfo(sql, employeeId);
}

const MutedInput = z.object({ muted: z.array(z.enum(MEALS, '餐次不正确')).max(MEALS.length) });

/** 自己关掉哪几顿的提醒 */
export async function saveMutedMeals(sql: Sql, employeeId: number, raw: unknown): Promise<PushInfo> {
  const { muted } = parse(MutedInput, raw);
  const list = MEALS.filter((m) => muted.includes(m));
  await sql`
    INSERT INTO canteen_push_prefs (employee_id, muted_meals) VALUES (${employeeId}, ${list}::text[])
    ON CONFLICT (employee_id) DO UPDATE SET muted_meals = EXCLUDED.muted_meals, updated_at = now()`;
  return pushInfo(sql, employeeId);
}

// ── 发送 ──

interface Device {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  origin: string | null;
  employeeId: number;
  name: string;
}

/** 记下一台手机这一次的结果：送到了清掉失败次数；订阅没了停用；别的失败记原因 */
async function recordDevice(db: Db, deviceId: number, outcome: PushOutcome) {
  if (outcome.ok) {
    await db`UPDATE canteen_push_subscriptions SET last_success_at = now(), failures = 0, last_error = NULL WHERE id = ${deviceId}`;
  } else if (outcome.gone) {
    await db`
      UPDATE canteen_push_subscriptions SET last_failure_at = now(), failures = failures + 1, last_error = ${outcome.error},
        disabled_at = coalesce(disabled_at, now()), disabled_reason = coalesce(disabled_reason, 'gone'), updated_at = now()
      WHERE id = ${deviceId}`;
  } else {
    await db`UPDATE canteen_push_subscriptions SET last_failure_at = now(), failures = failures + 1, last_error = ${outcome.error} WHERE id = ${deviceId}`;
  }
}

/** 一批一批地发（同时最多 CONCURRENCY 台），每台的错误自己兜住 */
async function eachLimited<T>(items: readonly T[], fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/** 这一顿记在哪天：跨午夜的一顿（例如夜宵 22:00–01:00）过了零点提醒的，记在开始那天（与打卡一样） */
function mealDateFor(window: MealWindow, dueMinute: number, dueDate: string): string {
  const s = toMinute(window.start);
  const e = toMinute(window.end);
  return s > e && dueMinute < e ? previousDate(dueDate) : dueDate;
}

/** 这一顿发布了的菜名 */
async function publishedDishes(db: Db, date: string, meal: Meal): Promise<string[]> {
  const [m] = await db<{ dishes: { name?: unknown }[] }[]>`SELECT dishes FROM canteen_menus WHERE menu_date = ${date} AND meal = ${meal} AND published`;
  return (m?.dishes ?? []).map((d) => (typeof d?.name === 'string' ? d.name : '')).filter(Boolean);
}

export interface ReminderRunResult {
  meal: Meal;
  date: string;
  sent: number;
  failed: number;
  skippedCheckedIn: number;
}

interface RunRow {
  id: number;
  title: string;
  line: string;
  menuText: string;
  openPage: (typeof REMINDER_OPEN_PAGES)[number];
}

/**
 * 每分钟的自动任务：到点以后 30 分钟之内、这一天这一顿还没发过的发一次（员工食堂模块关着时不发）。
 * 返回这一次发了的几顿（没有要发的返回空）。
 */
export async function runCanteenReminders(deps: { sql: Sql; config: AppConfig }, now: Date = new Date()): Promise<ReminderRunResult[]> {
  const { sql, config } = deps;
  if (!(await enabledErpModules(sql)).has('canteen')) return [];
  const [settings, reminders] = await Promise.all([loadCanteenSettings(sql), loadReminderSettings(sql)]);
  const minute = minuteOfDay(now, config.timezone);
  const today = businessDateOf(now, config.timezone, 0);
  const results: ReminderRunResult[] = [];
  for (const r of reminders.reminders) {
    if (!r.enabled) continue;
    const window = settings.meals.find((w) => w.meal === r.meal);
    const time = reminderTime(r, window);
    if (!time || !window) continue;
    const due = toMinute(time);
    const late = (minute - due + 1440) % 1440;
    if (late >= REMINDER_GRACE_MINUTES) continue;
    const dueDate = minute >= due ? today : previousDate(today);
    const mealDate = mealDateFor(window, due, dueDate);
    const dueAt = new Date(now.getTime() - (now.getTime() % 60_000) - late * 60_000);
    const result = await sendReminder(deps, r, mealDate, dueAt, settings.portalUrl);
    if (result) results.push(result);
  }
  return results;
}

/** 认领并发这一天这一顿的提醒；没认领到（发过了、别的进程正在发）返回 null */
async function sendReminder(deps: { sql: Sql; config: AppConfig }, r: MealReminder, mealDate: string, dueAt: Date, portalUrl: string): Promise<ReminderRunResult | null> {
  const { sql, config } = deps;
  // 认领：这一天这一顿第一次到这里的写一行；已经有的，只有正在发、租约过期了（进程中断）才接着发
  const dishes = await publishedDishes(sql, mealDate, r.meal);
  const line = pickReminderLine(r.lines, mealDate, dishes.length > 0);
  if (!line) return null;
  let [run] = await sql<RunRow[]>`
    INSERT INTO canteen_reminder_runs (meal_date, meal, due_at, title, line, menu_text, open_page, lease_until)
    VALUES (${mealDate}, ${r.meal}, ${dueAt}, ${r.title}, ${line}, ${menuText(dishes)}, ${r.open}, now() + make_interval(mins => ${LEASE_MINUTES}))
    ON CONFLICT (meal_date, meal) DO NOTHING
    RETURNING id, title, line, menu_text, open_page`;
  if (!run) {
    [run] = await sql<RunRow[]>`
      UPDATE canteen_reminder_runs SET lease_until = now() + make_interval(mins => ${LEASE_MINUTES})
      WHERE meal_date = ${mealDate} AND meal = ${r.meal} AND status = 'sending' AND lease_until < now()
      RETURNING id, title, line, menu_text, open_page`;
    if (!run) return null;
  }
  const runId = run.id;

  const keys = await vapidKeys(sql);
  // 发给谁：在用的人、开着的手机；自己关了这一顿的、已经打过这一顿卡的不发；这一次已经记过的手机不再发
  const devices = await sql<Device[]>`
    SELECT s.id, s.endpoint, s.p256dh, s.auth, s.origin, e.id AS employee_id, e.name
    FROM canteen_push_subscriptions s JOIN canteen_employees e ON e.id = s.employee_id
    WHERE s.disabled_at IS NULL AND e.active
      AND NOT EXISTS (SELECT 1 FROM canteen_push_prefs p WHERE p.employee_id = e.id AND ${r.meal} = ANY (p.muted_meals))
      AND NOT EXISTS (SELECT 1 FROM canteen_checkins c WHERE c.employee_id = e.id AND c.meal_date = ${mealDate} AND c.meal = ${r.meal} AND c.voided_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM canteen_reminder_deliveries d WHERE d.run_id = ${runId} AND d.subscription_id = s.id)
    ORDER BY s.id`;
  let renewedAt = Date.now();
  await eachLimited(devices, async (d) => {
    const [claimed] = await sql<{ ok: number }[]>`
      INSERT INTO canteen_reminder_deliveries (run_id, subscription_id, employee_id) VALUES (${runId}, ${d.id}, ${d.employeeId})
      ON CONFLICT DO NOTHING RETURNING 1 AS ok`;
    if (!claimed) return;
    const message: PushMessage = {
      v: 1,
      title: run!.title,
      body: fillReminderLine(run!.line, d.name, run!.menuText),
      tag: `meal-${r.meal}`,
      url: openPageUrl(run!.openPage),
      badge: 1,
    };
    let outcome: PushOutcome;
    try {
      outcome = await sendWebPush(d, JSON.stringify(message), keys, pushSubject(config, d.origin, portalUrl), {
        ttl: REMINDER_TTL_SECONDS,
        urgency: 'high',
        topic: `meal-${r.meal}`,
        allowLocal: allowLocal(config),
      });
    } catch {
      outcome = { ok: false, gone: false, status: null, error: '发送时出错' };
    }
    const status = outcome.ok ? 'sent' : outcome.gone ? 'gone' : 'failed';
    await sql`
      UPDATE canteen_reminder_deliveries SET status = ${status}, error = ${outcome.ok ? null : outcome.error}, finished_at = now()
      WHERE run_id = ${runId} AND subscription_id = ${d.id}`;
    await recordDevice(sql, d.id, outcome);
    if (Date.now() - renewedAt > 60_000) {
      renewedAt = Date.now();
      await sql`UPDATE canteen_reminder_runs SET lease_until = now() + make_interval(mins => ${LEASE_MINUTES}) WHERE id = ${runId} AND status = 'sending'`;
    }
  });

  // 收尾：按发送记录合计；已经打过卡、没再提醒的人数（开着提醒、没关这一顿的人里）
  const [done] = await sql<{ sent: number; failed: number; skipped: number }[]>`
    UPDATE canteen_reminder_runs r SET status = 'done', finished_at = now(), lease_until = NULL,
      sent = (SELECT count(*) FROM canteen_reminder_deliveries d WHERE d.run_id = r.id AND d.status = 'sent'),
      failed = (SELECT count(*) FROM canteen_reminder_deliveries d WHERE d.run_id = r.id AND d.status IN ('failed', 'gone')),
      skipped_checked_in = (
        SELECT count(DISTINCT e.id) FROM canteen_employees e
        JOIN canteen_push_subscriptions s ON s.employee_id = e.id AND s.disabled_at IS NULL
        WHERE e.active
          AND NOT EXISTS (SELECT 1 FROM canteen_push_prefs p WHERE p.employee_id = e.id AND ${r.meal} = ANY (p.muted_meals))
          AND EXISTS (SELECT 1 FROM canteen_checkins c WHERE c.employee_id = e.id AND c.meal_date = ${mealDate} AND c.meal = ${r.meal} AND c.voided_at IS NULL))
    WHERE r.id = ${runId}
    RETURNING r.sent, r.failed, r.skipped_checked_in AS skipped`;
  return { meal: r.meal, date: mealDate, sent: done!.sent, failed: done!.failed, skippedCheckedIn: done!.skipped };
}

// ── 发一条试试 ──

/** 同一个人的手机：试发之间至少隔 15 秒（员工连点、后台连点都挡一下） */
const TEST_GAP_MS = 15_000;
const lastTest = new Map<number, number>();
function throttleTest(employeeId: number, nowMs: number) {
  const last = lastTest.get(employeeId);
  if (last !== undefined && nowMs - last < TEST_GAP_MS) throw new AppError(429, 'PUSH_TEST_TOO_SOON', '刚发过一条，过十几秒再试');
  lastTest.set(employeeId, nowMs);
  if (lastTest.size > 5000) for (const [k, t] of lastTest) if (nowMs - t >= TEST_GAP_MS) lastTest.delete(k);
}

/**
 * 给一个人开着提醒的手机都发一条：meal 给了发这一顿今天的提醒（与到点发的一样，标题前加「试发」）；
 * 没给发柚子的一句问候（员工在「我的」里点「发一条试试」）
 */
export async function sendTestPush(sql: Sql, config: AppConfig, employeeId: number, meal: Meal | null, now: Date = new Date()): Promise<PushTestResult> {
  throttleTest(employeeId, now.getTime());
  const devices = await sql<Device[]>`
    SELECT s.id, s.endpoint, s.p256dh, s.auth, s.origin, e.id AS employee_id, e.name
    FROM canteen_push_subscriptions s JOIN canteen_employees e ON e.id = s.employee_id
    WHERE s.employee_id = ${employeeId} AND s.disabled_at IS NULL AND e.active
    ORDER BY s.id`;
  if (!devices.length) {
    lastTest.delete(employeeId);
    throw unprocessable('PUSH_NO_DEVICE', '还没有手机打开饭点提醒：先在柚子饭堂「我的 → 饭点提醒」里打开');
  }
  const settings = await loadCanteenSettings(sql);
  let message: Omit<PushMessage, 'body'> & { line: string; menu: string };
  if (meal) {
    const r = (await loadReminderSettings(sql)).reminders.find((x) => x.meal === meal)!;
    const today = businessDateOf(now, config.timezone, 0);
    const dishes = await publishedDishes(sql, today, meal);
    const line = pickReminderLine(r.lines.length ? r.lines : defaultReminder(meal).lines, today, dishes.length > 0) ?? '';
    message = { v: 1, title: `（试发）${r.title}`, line, menu: menuText(dishes), tag: `test-${meal}`, url: openPageUrl(r.open), badge: 1 };
  } else {
    message = {
      v: 1,
      title: '柚子来试试嗓子 🍊',
      line: '{名字}，饭点提醒打开啦！到了开饭时间，柚子就在这里喊你吃饭～',
      menu: '',
      tag: 'test',
      url: openPageUrl('home'),
      badge: 1,
    };
  }
  const keys = await vapidKeys(sql);
  let sent = 0;
  const errors = new Set<string>();
  await eachLimited(devices, async (d) => {
    const { line, menu, ...rest } = message;
    const payload: PushMessage = { ...rest, body: fillReminderLine(line, d.name, menu) };
    let outcome: PushOutcome;
    try {
      outcome = await sendWebPush(d, JSON.stringify(payload), keys, pushSubject(config, d.origin, settings.portalUrl), {
        ttl: 10 * 60,
        urgency: 'high',
        allowLocal: allowLocal(config),
      });
    } catch {
      outcome = { ok: false, gone: false, status: null, error: '发送时出错' };
    }
    await recordDevice(sql, d.id, outcome);
    if (outcome.ok) sent++;
    else errors.add(outcome.error);
  });
  return { devices: devices.length, sent, errors: [...errors] };
}

const AdminTestInput = z.object({ employeeId: z.number('请选一位员工').int().positive('请选一位员工'), meal: z.enum(MEALS, '餐次不正确').nullable() });

/** 后台：给某位员工的手机发一条（这一顿今天的提醒，或柚子的问候） */
export async function adminTestPush(sql: Sql, config: AppConfig, raw: unknown, now: Date = new Date()): Promise<PushTestResult> {
  const input = parse(AdminTestInput, raw);
  const [e] = await sql<{ active: boolean }[]>`SELECT active FROM canteen_employees WHERE id = ${input.employeeId}`;
  if (!e) throw notFound('没有这位员工');
  if (!e.active) throw unprocessable('EMPLOYEE_INACTIVE', '这位员工停用了');
  return sendTestPush(sql, config, input.employeeId, input.meal, now);
}

// ── 管理后台：提醒的情况 ──

export async function reminderOverview(db: Db, config: AppConfig, now: Date = new Date()): Promise<ReminderOverview> {
  const [settings, reminders] = await Promise.all([loadCanteenSettings(db), loadReminderSettings(db)]);
  const today = businessDateOf(now, config.timezone, 0);
  const minute = minuteOfDay(now, config.timezone);
  const runs: ReminderRunView[] = [];
  for (const r of reminders.reminders) {
    const window = settings.meals.find((w) => w.meal === r.meal);
    const time = r.enabled ? reminderTime(r, window) : null;
    if (!time || !window) {
      runs.push({ meal: r.meal, time, state: 'off', sent: 0, failed: 0, skippedCheckedIn: 0, line: null, finishedAt: null });
      continue;
    }
    const due = toMinute(time);
    const mealDate = mealDateFor(window, due, today);
    const [row] = await db<{ status: 'sending' | 'done'; sent: number; failed: number; skippedCheckedIn: number; line: string; menuText: string; finishedAt: string | null }[]>`
      SELECT status, sent, failed, skipped_checked_in, line, menu_text, finished_at FROM canteen_reminder_runs WHERE meal_date = ${mealDate} AND meal = ${r.meal}`;
    if (row) {
      runs.push({
        meal: r.meal,
        time,
        state: row.status,
        sent: row.sent,
        failed: row.failed,
        skippedCheckedIn: row.skippedCheckedIn,
        line: fillReminderLine(row.line, '{名字}', row.menuText),
        finishedAt: row.finishedAt,
      });
    } else {
      runs.push({ meal: r.meal, time, state: minute < due ? 'waiting' : minute - due < REMINDER_GRACE_MINUTES ? 'waiting' : 'missed', sent: 0, failed: 0, skippedCheckedIn: 0, line: null, finishedAt: null });
    }
  }
  const [devices] = await db<{ people: number; total: number; ios: number; android: number; other: number }[]>`
    SELECT count(DISTINCT s.employee_id)::int AS people, count(*)::int AS total,
           count(*) FILTER (WHERE s.platform = 'ios')::int AS ios, count(*) FILTER (WHERE s.platform = 'android')::int AS android,
           count(*) FILTER (WHERE s.platform = 'other')::int AS other
    FROM canteen_push_subscriptions s JOIN canteen_employees e ON e.id = s.employee_id
    WHERE s.disabled_at IS NULL AND e.active`;
  const recipients = await db<ReminderOverview['recipients']>`
    SELECT e.id, e.emp_no, e.name, e.avatar, count(*)::int AS devices, array_agg(DISTINCT s.platform ORDER BY s.platform) AS platforms,
           coalesce((SELECT p.muted_meals FROM canteen_push_prefs p WHERE p.employee_id = e.id), '{}') AS muted
    FROM canteen_push_subscriptions s JOIN canteen_employees e ON e.id = s.employee_id
    WHERE s.disabled_at IS NULL AND e.active
    GROUP BY e.id ORDER BY e.name, e.id`;
  const failures = await db<ReminderOverview['failures']>`
    SELECT e.name, e.emp_no, s.platform, s.last_error AS error, s.last_failure_at AS at
    FROM canteen_push_subscriptions s JOIN canteen_employees e ON e.id = s.employee_id
    WHERE s.last_failure_at IS NOT NULL AND s.last_error IS NOT NULL AND s.last_failure_at > now() - interval '7 days'
      AND (s.last_success_at IS NULL OR s.last_failure_at > s.last_success_at)
    ORDER BY s.last_failure_at DESC LIMIT 20`;
  return {
    settings: reminders,
    meals: settings.meals,
    today,
    runs,
    people: devices!.people,
    devices: { total: devices!.total, ios: devices!.ios, android: devices!.android, other: devices!.other },
    recipients,
    failures,
  };
}
