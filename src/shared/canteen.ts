// 员工食堂 · 柚子饭堂（docs/CANTEEN.md，店主 2026-11-06）：手机端「柚子饭堂」、管理后台与服务端共用的类型与规则。
//
// 员工账号与系统账号（staff）分开：员工账号只能登录柚子饭堂（员工端口 CANTEEN_PORT），没有任何 ERP 权限。
// 饭卡码在手机上离线生成：登录后拿到自己的码钥匙，每 30 秒按时间段算一次签名；服务端按扫到的时间核对。

import { businessDateOf, HHMM, minuteOfDay } from './business-date';

// ── 角色 ──

export const CANTEEN_ROLES = ['staff', 'cook', 'manager'] as const;
export type CanteenRole = (typeof CANTEEN_ROLES)[number];
export const CANTEEN_ROLE_LABELS: Record<CanteenRole, string> = { staff: '员工', cook: '厨师', manager: '食堂负责人' };
/** 厨师、负责人能编辑、发布菜单 */
export const canEditMenu = (role: CanteenRole) => role === 'cook' || role === 'manager';
/** 只有负责人能扫码打卡、手动登记、撤销 */
export const canScan = (role: CanteenRole) => role === 'manager';

// ── 餐次与开饭时间（K2）──

export const MEALS = ['breakfast', 'lunch', 'dinner', 'supper'] as const;
export type Meal = (typeof MEALS)[number];
export const MEAL_LABELS: Record<Meal, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', supper: '夜宵' };
export const MEAL_EMOJI: Record<Meal, string> = { breakfast: '🥣', lunch: '🍱', dinner: '🍲', supper: '🌙' };

export interface MealWindow {
  meal: Meal;
  enabled: boolean;
  /** 门店时区的 HH:MM；end 不晚于 start 表示到次日 */
  start: string;
  end: string;
}

export const DEFAULT_MEALS: readonly MealWindow[] = [
  { meal: 'breakfast', enabled: true, start: '07:00', end: '10:00' },
  { meal: 'lunch', enabled: true, start: '10:30', end: '14:30' },
  { meal: 'dinner', enabled: true, start: '16:30', end: '20:30' },
  { meal: 'supper', enabled: false, start: '22:00', end: '01:00' },
];

export interface CanteenSettings {
  /** 食堂部门（departments.id）：厨师、负责人必须在这个部门 */
  departmentId: number | null;
  meals: MealWindow[];
  /** 员工入口地址（打印开通卡片的二维码用），例如 https://staff.example.com；没填时卡片上只印开通码 */
  portalUrl: string;
}

export const DEFAULT_CANTEEN_SETTINGS: CanteenSettings = { departmentId: null, meals: DEFAULT_MEALS.map((m) => ({ ...m })), portalUrl: '' };

const toMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export const validMealWindow = (w: MealWindow) => HHMM.test(w.start) && HHMM.test(w.end) && w.start !== w.end;

/** 开饭时间的文字，例如「午餐 10:30–14:30」；跨午夜的写「次日」 */
export const mealWindowText = (w: MealWindow) => `${MEAL_LABELS[w.meal]} ${w.start}–${w.end <= w.start ? '次日 ' : ''}${w.end}`;

/** 前一天（YYYY-MM-DD） */
export function previousDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 这一刻是哪一餐、记在哪天：落在某个开着的开饭时间里（含开始、不含结束）；
 * 跨午夜的餐次（如夜宵 22:00–01:00）过了午夜的部分记在开始那天。不在任何开饭时间里返回 null。
 */
export function mealAt(windows: readonly MealWindow[], at: Date, timeZone: string): { meal: Meal; date: string } | null {
  const minute = minuteOfDay(at, timeZone);
  const today = businessDateOf(at, timeZone, 0);
  for (const w of windows) {
    if (!w.enabled || !validMealWindow(w)) continue;
    const s = toMinute(w.start);
    const e = toMinute(w.end);
    if (s < e) {
      if (minute >= s && minute < e) return { meal: w.meal, date: today };
    } else {
      if (minute >= s) return { meal: w.meal, date: today };
      if (minute < e) return { meal: w.meal, date: previousDate(today) };
    }
  }
  return null;
}

/** 两个开饭时间是否重叠（保存设置时拦下，免得一个时刻对上两餐） */
export function mealWindowsOverlap(a: MealWindow, b: MealWindow): boolean {
  const spans = (w: MealWindow): [number, number][] => {
    const s = toMinute(w.start);
    const e = toMinute(w.end);
    return s < e ? [[s, e]] : [[s, 1440], [0, e]];
  };
  return spans(a).some(([s1, e1]) => spans(b).some(([s2, e2]) => s1 < e2 && s2 < e1));
}

// ── 菜单（K11）──

export const DISH_TAGS = ['spicy', 'veg', 'new', 'star'] as const;
export type DishTag = (typeof DISH_TAGS)[number];
export const DISH_TAG_LABELS: Record<DishTag, string> = { spicy: '辣', veg: '素', new: '新', star: '招牌' };
export const DISH_TAG_EMOJI: Record<DishTag, string> = { spicy: '🌶️', veg: '🥬', new: '✨', star: '⭐' };

export const MENU_LIMITS = { dishes: 30, name: 20, note: 100 } as const;
/** 菜的编号：同一份菜单里唯一，点赞按它记（改菜名不丢赞） */
export const DISH_ID = /^[a-z0-9]{1,12}$/;

export interface Dish {
  id: string;
  name: string;
  /** 一个表情；空串时按菜名自动带出 */
  emoji: string;
  tags: DishTag[];
}

/** 按菜名带出一个表情（厨师可以改）；对不上的用一碗饭 */
const EMOJI_RULES: [RegExp, string][] = [
  [/粥/, '🥣'],
  [/面包/, '🍞'],
  [/(炒饭|米饭|盖饭|拌饭|饭团)/, '🍚'],
  [/(包|饺|馄饨|云吞|烧卖)/, '🥟'],
  [/(面|粉|米线)/, '🍜'],
  [/(糍粑|汤圆|年糕|麻薯|团子)/, '🍡'],
  [/(蛋糕|布丁|甜品|双皮奶|冰|奶茶)/, '🍮'],
  [/饼/, '🫓'],
  [/(汤|煲|羹)/, '🍲'],
  [/(虾)/, '🍤'],
  [/(鱼|蟹|贝|鱿|海鲜)/, '🐟'],
  [/蛋/, '🥚'],
  [/(鸡|鸭|鹅)/, '🍗'],
  [/(牛|羊)/, '🥩'],
  [/(排骨|猪|肉|腊|叉烧|肠)/, '🍖'],
  [/豆/, '🫘'],
  [/(蔬|茄|椒|瓜|菜|笋|菇|蘑|藕|萝卜|土豆|白菜|西兰花|生菜|菠菜|豆角)/, '🥬'],
  [/(水果|苹果|橙|西瓜|香蕉|葡萄)/, '🍉'],
  [/(饭|米)/, '🍚'],
];
export function suggestDishEmoji(name: string): string {
  for (const [re, emoji] of EMOJI_RULES) if (re.test(name)) return emoji;
  return '🍚';
}

export interface CanteenMenu {
  id: number;
  date: string;
  meal: Meal;
  dishes: Dish[];
  note: string;
  published: boolean;
  version: number;
  updatedAt: string;
  updatedByName: string | null;
  /** 每道菜收到几个赞（按菜的编号） */
  likes: Record<string, number>;
  /** 我点过赞的菜（员工端） */
  myLikes: string[];
}

// ── 头像 ──

export const AVATARS = ['🍊', '🍋', '🍑', '🍓', '🍉', '🍇', '🥝', '🍒', '🍍', '🥑', '🐱', '🐶', '🐼', '🐰', '🦊', '🐻', '🐨', '🐯', '🐸', '🐧', '🐥', '🦄', '🌻', '🍀'] as const;
/** 新员工的默认头像：按编号轮着给，饭堂里不会一片都一样 */
export const defaultAvatar = (id: number) => AVATARS[id % 10]!;

// ── 饭卡码（K4）──

export const CODE_STEP_SECONDS = 30;
/** 扫到时往前认 3 个时间段（90 秒）、往后认 1 个（30 秒，手机时钟快一点也认） */
export const CODE_ACCEPT_PAST_STEPS = 3;
export const CODE_ACCEPT_FUTURE_STEPS = 1;
export const CODE_PREFIX = 'YZC1';
export const CODE_MAC_LENGTH = 8;

export const codeStepOf = (ms: number) => Math.floor(ms / (CODE_STEP_SECONDS * 1000));
/** 码钥匙签的内容 */
export const codeMessage = (step: number) => `canteen-code:v1:${step}`;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** 取签名的前几个字节转成 base32（全大写，二维码用字母数字模式，码更小） */
export function base32(bytes: Uint8Array, length: number): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  return out;
}

/** 饭卡码：YZC1:<员工编号>:<时间段>:<签名>，编号与时间段用大写 36 进制 */
export const formatCanteenCode = (employeeId: number, step: number, mac: string) =>
  `${CODE_PREFIX}:${employeeId.toString(36).toUpperCase()}:${step.toString(36).toUpperCase()}:${mac}`;

const CODE_RE = /^YZC1:([0-9A-Z]{1,10}):([0-9A-Z]{1,10}):([A-Z2-7]{8})$/;
export function parseCanteenCode(text: string): { employeeId: number; step: number; mac: string } | null {
  const m = CODE_RE.exec(text.trim().toUpperCase());
  if (!m) return null;
  const employeeId = parseInt(m[1]!, 36);
  const step = parseInt(m[2]!, 36);
  if (!Number.isSafeInteger(employeeId) || employeeId <= 0 || !Number.isSafeInteger(step)) return null;
  return { employeeId, step, mac: m[3]! };
}

// ── 开通码（K6）──

/** 去掉容易认错的 0 O 1 I */
export const ACTIVATION_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ACTIVATION_DAYS = 7;
/** 输入的开通码：去掉空格与短横线、转大写 */
export const normalizeActivationCode = (raw: string) => raw.replace(/[\s-]/g, '').toUpperCase();
export const ACTIVATION_CODE = /^[2-9A-HJ-NP-Z]{8}$/;
/** 卡片上印的样子：ABCD-2345 */
export const displayActivationCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

// ── 工号与密码 ──

/** 工号：大写字母、数字与短横线，1–16 位（保存时转大写） */
export const EMP_NO = /^[A-Z0-9][A-Z0-9-]{0,15}$/;
export const normalizeEmpNo = (raw: string) => raw.trim().toUpperCase();
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 72;

// ── 自己登记（第二期，docs/CANTEEN.md 第 14 节，K12–K14）──

/** admin：管理员在后台加的；self：员工自己在柚子饭堂登记的 */
export type EmployeeSource = 'admin' | 'self';

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 16;
/** 用户名：汉字、字母、数字和 · _ -，2–16 个字 */
const USERNAME_CHARS = /^[\p{Script=Han}A-Za-z0-9·_-]+$/u;
export const normalizeUsername = (raw: string) => raw.trim();
/** 用户名的问题（没问题返回 null）；不能全是数字（免得和手机号、工号弄混） */
export function usernameProblem(name: string): string | null {
  const n = [...name].length;
  if (n < USERNAME_MIN) return `用户名至少 ${USERNAME_MIN} 个字`;
  if (n > USERNAME_MAX) return `用户名最多 ${USERNAME_MAX} 个字`;
  if (!USERNAME_CHARS.test(name)) return '用户名只能用汉字、字母、数字和 · _ -（不能有空格）';
  if (/^[0-9]+$/.test(name)) return '用户名不能全是数字';
  if (/^ZC[0-9]+(-[0-9]+)?$/i.test(name)) return '用户名不能是 ZC 加数字（那是系统给的工号）';
  return null;
}

/** 11 位大陆手机号；输入时去掉空格、短横线和 +86 */
export const PHONE = /^1[3-9][0-9]{9}$/;
export const normalizePhone = (raw: string) => raw.replace(/[\s-]/g, '').replace(/^(\+?86)(?=1[0-9]{10}$)/, '');
/** 名单里给人看的手机号：138 0013 8000 */
export const displayPhone = (phone: string) => `${phone.slice(0, 3)} ${phone.slice(3, 7)} ${phone.slice(7)}`;

/** 注册口令：和开通码同样的 8 位字母数字（去掉容易认错的 0 O 1 I），印在海报上是 ABCD-2345 */
export const REG_CODE = /^[2-9A-HJ-NP-Z]{8}$/;
/** 注册链接：员工入口地址 + #reg=口令（扫海报上的二维码打开） */
export const registrationLink = (portalUrl: string, code: string) => `${portalUrl}/#reg=${code}`;

/** 管理后台看的「注册二维码」 */
export interface CanteenRegistration {
  /** 开着自己登记 */
  enabled: boolean;
  /** 注册口令（还没生成为 null） */
  code: string | null;
  /** 注册链接（没填员工入口地址、没生成口令时为 null） */
  link: string | null;
  /** 自己登记、在用的人数 */
  selfRegistered: number;
  /** 改了几次：开关、换口令都带上看到的这个数，对不上拒绝（REGISTRATION_CHANGED） */
  rev: number;
}

/** 员工端：现在能不能自己登记、带来的口令对不对（没带口令时 codeOk 为 null） */
export interface RegisterInfo {
  open: boolean;
  codeOk: boolean | null;
}

// ── 跟柚子说（第二期，docs/CANTEEN.md 第 16 节，K16）──

export const FEEDBACK_KINDS = ['wish', 'chat'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = { wish: '想要柚子做的', chat: '碎碎念' };
export const FEEDBACK_LIMITS = { content: 500, reply: 300, perDay: 20 } as const;

/** 员工自己说过的 */
export interface MyFeedbackRow {
  id: number;
  kind: FeedbackKind;
  content: string;
  createdAt: string;
  /** 柚子（管理员）看过了 */
  read: boolean;
  reply: string | null;
  repliedAt: string | null;
}

/** 管理后台「柚子信箱」的一条 */
export interface CanteenFeedbackRow {
  id: number;
  employeeId: number;
  name: string;
  empNo: string;
  avatar: string;
  kind: FeedbackKind;
  content: string;
  createdAt: string;
  readAt: string | null;
  readByName: string | null;
  reply: string | null;
  repliedAt: string | null;
  repliedByName: string | null;
}

export interface CanteenFeedbackList {
  rows: CanteenFeedbackRow[];
  /** 按同样筛选的合计 */
  total: number;
  /** 全部还没看的 */
  unread: number;
}

// ── 接口的数据 ──

/** 员工端：我是谁、码钥匙、开饭时间 */
export interface CanteenMe {
  employee: {
    id: number;
    empNo: string;
    name: string;
    department: string;
    role: CanteenRole;
    avatar: string;
    /** 自己登记的用户名（后台加的人没有） */
    username: string | null;
    source: EmployeeSource;
  };
  /** 码钥匙（base64url）：只在这台手机上用来生成饭卡码 */
  codeKey: string;
  codeEpoch: number;
  /** 服务器此刻（手机按它修正时钟） */
  serverTime: string;
  today: string;
  meals: MealWindow[];
  /** 这个月在饭堂吃了几顿 */
  mealsThisMonth: number;
}

export type CheckinStatus = 'ok' | 'already';

export interface CanteenCheckinRow {
  id: number;
  employeeId: number;
  empNo: string;
  name: string;
  department: string;
  avatar: string;
  date: string;
  meal: Meal;
  method: 'scan' | 'manual';
  note: string;
  scannedAt: string;
  recordedAt: string;
  recorderName: string;
  voidedAt: string | null;
  voidReason: string | null;
  voidedByName: string | null;
}

export interface CheckinResult {
  status: CheckinStatus;
  /** ok：这次记下的；already：这一餐之前那一条 */
  checkin: CanteenCheckinRow;
  /** 这一餐（同一天）已经打卡的人数 */
  mealCount: number;
}

/** 管理后台的用餐记录：页面一次最多列 rows 这么多条；total、valid 是按同样筛选的合计（导出表格不截断） */
export interface CanteenCheckinList {
  rows: CanteenCheckinRow[];
  total: number;
  valid: number;
  /** 列不下了（合计比列出来的多） */
  truncated: boolean;
}

export interface CanteenToday {
  today: string;
  /** 现在是哪一餐（不在开饭时间为 null） */
  current: { meal: Meal; date: string } | null;
  meals: MealWindow[];
  counts: Record<Meal, number>;
  recent: CanteenCheckinRow[];
}

export interface CanteenPerson {
  id: number;
  empNo: string;
  name: string;
  department: string;
  avatar: string;
  /** 现在这一餐打过卡没有 */
  checkedIn: boolean;
}

// ── 管理后台 ──

export interface CanteenEmployeeRow {
  id: number;
  empNo: string;
  name: string;
  /** 自己登记的用户名、手机号（后台加的人没有） */
  username: string | null;
  phone: string | null;
  source: EmployeeSource;
  departmentId: number | null;
  department: string;
  role: CanteenRole;
  avatar: string;
  active: boolean;
  /** 设好密码了 */
  activated: boolean;
  activatedAt: string | null;
  /** 有没用掉的开通码（没过期） */
  activationPending: boolean;
  activationExpiresAt: string | null;
  lastSeenAt: string | null;
  version: number;
  createdAt: string;
}

export interface ActivationCard {
  employeeId: number;
  empNo: string;
  name: string;
  department: string;
  avatar: string;
  code: string;
  expiresAt: string;
}

export interface BatchPreviewRow {
  line: number;
  empNo: string;
  name: string;
  department: string;
  departmentId: number | null;
  /** new 新加；same 已经有了、一样（跳过）；error 有问题 */
  status: 'new' | 'same' | 'error';
  message: string;
}

export interface CanteenOverview {
  enabled: boolean;
  settings: CanteenSettings;
  departmentName: string | null;
  today: CanteenToday;
  people: { total: number; active: number; activated: number; pending: number; cooks: number; managers: number };
  /** 最近 14 天每天各餐人数（从早到晚） */
  days: { date: string; counts: Record<Meal, number> }[];
  /** 这周最受欢迎的菜（按赞数） */
  topDishes: { date: string; meal: Meal; name: string; emoji: string; likes: number }[];
  /** 员工端口开着没有（CANTEEN_PORT） */
  portOpen: boolean;
  /** 自己登记（注册二维码） */
  registration: CanteenRegistration;
  /** 柚子信箱里还没看的 */
  feedbackUnread: number;
}
