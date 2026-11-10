// 员工食堂 · 饭点提醒（店主 2026-11-10，docs/CANTEEN.md 第 19 节，K23、K24）：到点柚子给打开了提醒的员工手机发一条通知，
// 桌面上的柚子图标出现小红点。后台「员工食堂 → 饭点提醒」设哪几顿提醒、几点、柚子说什么；员工在柚子饭堂「我的 → 饭点提醒」里打开、选哪几顿。
// 服务端、后台的预览、员工手机共用这里的默认话术与规则。

import { MEALS, type Meal, type MealWindow } from './canteen';
import { HHMM } from './business-date';

// ── 提醒的设置（后台） ──

/** 点通知以后打开哪一页 */
export const REMINDER_OPEN_PAGES = ['code', 'menu', 'home'] as const;
export type ReminderOpenPage = (typeof REMINDER_OPEN_PAGES)[number];
export const REMINDER_OPEN_LABELS: Record<ReminderOpenPage, string> = { code: '饭卡码', menu: '菜单', home: '首页' };

export const REMINDER_LIMITS = { title: 30, line: 80, lines: 8 } as const;
/** 到点以后多久之内还发：应用停过、过了这么久不再补发（饭都快吃完了） */
export const REMINDER_GRACE_MINUTES = 30;
/** 推送服务替这条通知等多久（秒）：手机关机、没网，过了就不送了 */
export const REMINDER_TTL_SECONDS = 30 * 60;

/** 话术里会换掉的两个词 */
export const NAME_TAG = '{名字}';
export const MENU_TAG = '{菜单}';

export interface MealReminder {
  meal: Meal;
  enabled: boolean;
  /** 门店时区的 HH:MM；null = 开饭时（跟着开饭时间走） */
  time: string | null;
  /** 通知的标题 */
  title: string;
  /** 柚子说的话：每天轮着说一句（今天第 1 句、明天第 2 句……） */
  lines: string[];
  /** 点通知打开哪一页 */
  open: ReminderOpenPage;
}

export interface ReminderSettings {
  /** 早餐、午餐、晚餐、夜宵各一条（按 MEALS 的顺序） */
  reminders: MealReminder[];
  /** 改了几次：保存时带上打开时看到的这个数，对不上拒绝（REMINDERS_CHANGED），免得两个人同时改互相覆盖 */
  rev: number;
}

/** 默认话术（K23，柚子的口吻）：午餐、晚餐开饭时提醒；早餐、夜宵默认不提醒 */
export const DEFAULT_REMINDERS: readonly MealReminder[] = [
  {
    meal: 'breakfast',
    enabled: false,
    time: null,
    title: '柚子喊你吃早饭啦 🥣',
    lines: ['早上好呀！饭堂的早饭热乎乎的，吃了才有元气哦～', '{名字}早呀～今天早上有{菜单}，快来！', '一日之计在于早饭！柚子在饭堂等你～'],
    open: 'code',
  },
  {
    meal: 'lunch',
    enabled: true,
    time: null,
    title: '柚子喊你吃午饭啦 🍱',
    lines: [
      '午饭时间到！饭堂开饭啦，柚子已经闻到饭香了～记得亮饭卡码哦',
      '叮咚～今天中午有{菜单}，快来尝尝！',
      '{名字}，肚子咕咕叫了吧？柚子在饭堂等你～',
      '忙了一上午辛苦啦！先好好吃饭，下午才有力气 💪',
    ],
    open: 'code',
  },
  {
    meal: 'dinner',
    enabled: true,
    time: null,
    title: '柚子喊你吃晚饭啦 🍲',
    lines: [
      '晚饭时间到！辛苦一天啦，来饭堂补充能量吧～',
      '叮咚～今晚有{菜单}，柚子给你留着热乎的！',
      '{名字}，别光顾着忙，先来吃饭呀～柚子在饭堂等你',
      '晚饭开饭啦 🌙 吃饱饱，晚上的班才不累！',
    ],
    open: 'code',
  },
  {
    meal: 'supper',
    enabled: false,
    time: null,
    title: '柚子喊你吃夜宵啦 🌙',
    lines: ['夜宵开饭啦！上夜班辛苦了，来饭堂暖暖胃吧～', '{名字}，夜里饿了吧？今晚夜宵有{菜单}～'],
    open: 'code',
  },
];

export const defaultReminder = (meal: Meal): MealReminder => {
  const d = DEFAULT_REMINDERS.find((r) => r.meal === meal)!;
  return { ...d, lines: [...d.lines] };
};

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { reminders: MEALS.map(defaultReminder), rev: 0 };

/** 一条提醒的问题（没问题返回 null）：开着的要有标题、至少一句话；时间写成 HH:MM */
export function reminderProblem(r: MealReminder): string | null {
  if (r.time !== null && !HHMM.test(r.time)) return '提醒时间写成 HH:MM';
  const title = r.title.trim();
  if ([...title].length > REMINDER_LIMITS.title) return `标题最多 ${REMINDER_LIMITS.title} 个字`;
  if (r.lines.length > REMINDER_LIMITS.lines) return `柚子说的话最多 ${REMINDER_LIMITS.lines} 句`;
  if (r.lines.some((l) => [...l.trim()].length > REMINDER_LIMITS.line)) return `每句最多 ${REMINDER_LIMITS.line} 个字`;
  if (r.enabled && !title) return '要写通知的标题';
  if (r.enabled && !r.lines.some((l) => l.trim())) return '至少写一句柚子说的话';
  return null;
}

/** 几点提醒：设了时间用设的，没设为开饭时；这一顿没开饭返回 null */
export function reminderTime(r: MealReminder, window: MealWindow | undefined): string | null {
  if (!window?.enabled) return null;
  return r.time ?? window.start;
}

// ── 话术 ──

/** 这一顿发布了的菜写成一句：三道以内都写，多了写「红烧肉、番茄炒蛋、清炒时蔬等 6 道菜」 */
export function menuText(dishes: readonly string[]): string {
  const names = dishes.map((d) => d.trim()).filter(Boolean);
  if (names.length <= 3) return names.join('、');
  return `${names.slice(0, 3).join('、')}等 ${names.length} 道菜`;
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/**
 * 这一天轮到哪一句：带 {菜单} 的句子只在这一顿发布了菜单时用；按日子轮着用（同一天大家收到的是同一句）。
 * 每句都带 {菜单}、这一顿又没发布菜单时，照样轮着用，{菜单} 换成「好吃的」。没有话返回 null。
 */
export function pickReminderLine(lines: readonly string[], date: string, hasMenu: boolean): string | null {
  const all = lines.map((l) => l.trim()).filter(Boolean);
  if (!all.length) return null;
  const usable = hasMenu ? all : all.filter((l) => !l.includes(MENU_TAG));
  const pool = usable.length ? usable : all;
  const n = dayNumber(date);
  return pool[((n % pool.length) + pool.length) % pool.length]!;
}

/** 把 {名字}、{菜单} 换成真的（没发布菜单时 {菜单} 换成「好吃的」） */
export function fillReminderLine(line: string, name: string, menu: string): string {
  return line.split(NAME_TAG).join(name).split(MENU_TAG).join(menu || '好吃的');
}

// ── 推送的内容（服务端加密后发给手机，手机上的 sw.js 读） ──

export interface PushMessage {
  v: 1;
  title: string;
  body: string;
  /** 同一个 tag 的通知新的替换旧的 */
  tag: string;
  /** 点通知打开的地址（柚子饭堂的页面，例如 /#/code） */
  url: string;
  /** 桌面图标上的数字（小红点） */
  badge: number;
}

export const openPageUrl = (page: ReminderOpenPage) => `/#/${page}`;

// ── 员工端（柚子饭堂） ──

/** 这台手机能不能收提醒、打开了没有（「我的 → 饭点提醒」） */
export interface PushInfo {
  /** 门店系统的推送公钥（手机订阅时交给浏览器） */
  publicKey: string;
  /** 后台打开了提醒、这一顿也开饭的几顿：几点提醒 */
  meals: { meal: Meal; time: string }[];
  /** 自己关掉的几顿 */
  muted: Meal[];
  /** 开着提醒的手机有几台（这个人名下） */
  devices: number;
}

/** 员工交上来的订阅（浏览器 PushSubscription.toJSON() 加上是哪种手机） */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  platform?: 'ios' | 'android' | 'other';
}

/** 发一条试试的结果 */
export interface PushTestResult {
  /** 一共几台手机、送到几台 */
  devices: number;
  sent: number;
  /** 没送到的原因（同样的合在一起） */
  errors: string[];
}

/** 一个人名下开着提醒的手机最多几台：多了停用最早的 */
export const PUSH_DEVICES_PER_EMPLOYEE = 5;

// ── 管理后台 ──

export interface ReminderRunView {
  meal: Meal;
  /** 几点提醒（门店时区 HH:MM；这一顿没开、提醒关着为 null） */
  time: string | null;
  /** waiting 还没到点；sending 正在发；done 发完了；missed 过了到点 30 分钟还没发（应用停着）；off 没开 */
  state: 'waiting' | 'sending' | 'done' | 'missed' | 'off';
  sent: number;
  failed: number;
  /** 已经打过这一顿卡、没再提醒的人 */
  skippedCheckedIn: number;
  line: string | null;
  finishedAt: string | null;
}

export interface ReminderRecipient {
  id: number;
  empNo: string;
  name: string;
  avatar: string;
  devices: number;
  platforms: string[];
  muted: Meal[];
}

export interface ReminderOverview {
  settings: ReminderSettings;
  meals: MealWindow[];
  today: string;
  runs: ReminderRunView[];
  /** 开着提醒的人与手机 */
  people: number;
  devices: { total: number; ios: number; android: number; other: number };
  recipients: ReminderRecipient[];
  /** 最近没送到的（每台手机最近一次的原因） */
  failures: { name: string; empNo: string; platform: string; error: string; at: string }[];
}
