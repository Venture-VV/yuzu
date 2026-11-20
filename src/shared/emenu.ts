// 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）。前后端共用。
//
// 放在餐桌上的平板：客人翻菜单、把菜加进「未下单」，服务员过来输点单密码确认，菜挂到客人的手牌上、送进厨房。
// 下单走的是点单页同一条挂账路径（frontdesk/bills.ts 的 postChargesTx），这里只管菜单怎么排、怎么显示，以及点餐单这张记录。
// 没定的规则按默认（PENDING_DECISIONS.md「8.0.10」DC1–DC18，待确认），能调的在后台「电子菜单 → 设置」里改。

import { parseCsvRecords, unclosedQuoteMessage } from './csv-read';
import { normalizeTagCode, tagDigits } from './frontdesk';

// ───────────────────────── 设置 ─────────────────────────

export interface EmenuRules {
  /** 平板点餐：关闭时 /emenu 提示没有开启，其余与升级前一样（默认关） */
  enabled: boolean;
  /** 起始页的氛围大图（没传时是设计稿的浅灰底） */
  coverImageId: number | null;
  /** 起始页底部的版权行 */
  footerText: string;
  /** 忌口（多选） */
  avoidOptions: string[];
  /** 起菜方式（单选，可以不选） */
  serveOptions: string[];
  /** 多少分钟没人动回到起始页、清掉没下单的菜；0 为不自动回（DC12） */
  idleMinutes: number;
  /** 不在供应时段的分类：hide 不显示（默认），show 显示但不能点（DC9） */
  offHours: 'hide' | 'show';
  /** 中英切换（8.0.13，EN9）：开着时起始页与顶栏有「中 | EN」开关（默认开）；关掉后页面只有中文 */
  langSwitch: boolean;
  /** 忌口、起菜方式各选项的英文（键是中文选项）。没填的用内置的常见译法，内置也没有就显示中文（EN5） */
  optionsEn: Record<string, string>;
  /** 动效（EN12）：true 丰富（默认），false 简洁（老平板卡的时候用）；系统「减少动态效果」时总是简洁 */
  motion: boolean;
  /**
   * 点单密码（8.0.15，EM1）：true 下单、重新提交、作废都要服务员输 6 位点单密码，经办人记这位服务员；
   * false（默认）不要密码，核对手牌与桌号后直接下单，经办人记这台平板登录的账号。
   */
  requirePin: boolean;
  /**
   * 平板上的字与按钮（8.0.15，EM3）：large 放大（默认，字、加号、顶栏、抽屉、弹窗都大一档，位置重新排过）；
   * design 设计稿原样（设计师量的像素，字小）。
   */
  textSize: EmenuTextSize;
  /**
   * 早、中、晚三个时段（8.1.5，PP1）：开始时间与名称。三段首尾相接、盖满一天，一段的结束就是下一段的开始；
   * 分类勾了在哪几段供应的，只在那几段显示（没勾的是全天）。
   */
  periods: EmenuPeriod[];
}

export type EmenuTextSize = 'large' | 'design';

// ───────────────────────── 早、中、晚三个时段（8.1.5，docs/EMENU.md 第 14.1 节） ─────────────────────────

export const EMENU_PERIODS = ['breakfast', 'lunch', 'dinner'] as const;
export type EmenuPeriodKey = (typeof EMENU_PERIODS)[number];
/** 后台勾选时的简称 */
export const EMENU_PERIOD_SHORT: Record<EmenuPeriodKey, string> = { breakfast: '早', lunch: '中', dinner: '晚' };
export const EMENU_MAX_PERIOD_NAME = 8;
export const EMENU_MAX_PERIOD_NAME_EN = 24;

/** 一个时段：从 start 开始，到下一段的 start 结束 */
export interface EmenuPeriod {
  key: EmenuPeriodKey;
  name: string;
  nameEn: string;
  /** 一天里的第几分钟开始（0–1439） */
  start: number;
}

export const DEFAULT_EMENU_PERIODS: readonly EmenuPeriod[] = [
  { key: 'breakfast', name: '早餐', nameEn: 'Breakfast', start: 6 * 60 },
  { key: 'lunch', name: '午餐', nameEn: 'Lunch', start: 11 * 60 },
  { key: 'dinner', name: '晚餐', nameEn: 'Dinner', start: 17 * 60 },
];

export const DEFAULT_EMENU_RULES: EmenuRules = {
  // 8.0.20：功能开关都默认开（店主 2026-11-14，docs/PENDING_DECISIONS.md KG1–KG4）；要关在设置页关
  enabled: true,
  coverImageId: null,
  footerText: 'COPYRIGHT©2026 汤崎 ALL RIGHTS RESERVED',
  avoidOptions: ['不加香菜', '不加辣椒', '少辣', '不加洋葱', '不加香葱', '重辣'],
  serveOptions: ['即起', '慢起'],
  idleMinutes: 10,
  offHours: 'hide',
  langSwitch: true,
  optionsEn: {},
  motion: true,
  requirePin: false,
  textSize: 'large',
  periods: DEFAULT_EMENU_PERIODS.map((p) => ({ ...p })),
};

/** 点单密码：6 位数字（设计稿「密码 ******」） */
export const EMENU_PIN_LENGTH = 6;
/** 自定义备注最多 30 个字（DC7） */
export const EMENU_MAX_CUSTOM_NOTE = 30;
/** 拼好的整单备注最多 100 个字（出品单的口味备注，迁移 121 放宽到 100） */
export const EMENU_MAX_NOTE = 100;
/** 一单最多 30 行（与点单页相同，DC18） */
export const EMENU_MAX_LINES = 30;
export const EMENU_MAX_AVOID_OPTIONS = 12;
export const EMENU_MAX_SERVE_OPTIONS = 4;
/** 忌口、起菜方式的一个选项最多 6 个字 */
export const EMENU_MAX_OPTION_LENGTH = 6;
export const EMENU_MAX_FOOTER = 60;
export const EMENU_MAX_IDLE_MINUTES = 120;
/** 一个分类最多 60 页 */
export const EMENU_MAX_PAGES = 60;
export const EMENU_MAX_GUESTS = 99;
/** 忌口、起菜方式一个选项的英文最多 24 个字符 */
export const EMENU_MAX_OPTION_EN = 24;

// ───────────────────────── 中 / EN（8.0.13，docs/EMENU.md 第 11.1 节） ─────────────────────────

export type EmenuLang = 'zh' | 'en';

/** 单位常见的英文（后台没填「单位的英文」时用；这里也没有就显示中文） */
export const EMENU_UNIT_EN: Readonly<Record<string, string>> = {
  份: 'portion',
  例: 'serving',
  客: 'serving',
  位: 'person',
  人: 'person',
  只: 'pc',
  个: 'pc',
  件: 'pc',
  块: 'pc',
  条: 'pc',
  颗: 'pc',
  粒: 'pc',
  片: 'slice',
  串: 'skewer',
  瓶: 'bottle',
  支: 'bottle',
  杯: 'glass',
  壶: 'pot',
  扎: 'jug',
  听: 'can',
  罐: 'can',
  碗: 'bowl',
  盅: 'cup',
  盘: 'plate',
  碟: 'plate',
  锅: 'pot',
  煲: 'pot',
  笼: 'basket',
  桶: 'bucket',
  盒: 'box',
  包: 'pack',
  套: 'set',
  打: 'dozen',
  半打: 'half dozen',
  斤: '500g',
  两: '50g',
  克: 'g',
};

/** 规格常见的英文（后台没填「规格的英文」时用） */
export const EMENU_SPEC_EN: Readonly<Record<string, string>> = {
  大份: 'Large',
  中份: 'Medium',
  小份: 'Small',
  例份: 'Regular',
  标准: 'Regular',
  加大: 'Extra large',
  半份: 'Half',
  整份: 'Full',
  大: 'Large',
  中: 'Medium',
  小: 'Small',
  整只: 'Whole',
  半只: 'Half',
  整条: 'Whole',
  半条: 'Half',
  单人: 'For 1',
  双人: 'For 2',
  大杯: 'Large',
  中杯: 'Medium',
  小杯: 'Small',
  大瓶: 'Large bottle',
  小瓶: 'Small bottle',
  整瓶: 'Bottle',
  单杯: 'Glass',
  一打: 'Dozen',
  半打: 'Half dozen',
  冷: 'Iced',
  冰: 'Iced',
  热: 'Hot',
  常温: 'Room temp',
};

/** 忌口、起菜方式常见选项的英文（后台「设置」里没填时用） */
export const EMENU_OPTION_EN: Readonly<Record<string, string>> = {
  不加香菜: 'No cilantro',
  不加辣椒: 'No chili',
  不加洋葱: 'No onion',
  不加香葱: 'No scallion',
  不加葱: 'No scallion',
  不加蒜: 'No garlic',
  不加姜: 'No ginger',
  不加花生: 'No peanuts',
  不加味精: 'No MSG',
  不加糖: 'No sugar',
  不加冰: 'No ice',
  免葱: 'No scallion',
  免蒜: 'No garlic',
  免辣: 'Not spicy',
  去冰: 'No ice',
  少冰: 'Less ice',
  少盐: 'Less salt',
  少油: 'Less oil',
  少糖: 'Less sugar',
  不辣: 'Not spicy',
  微辣: 'Mild',
  少辣: 'Mild',
  中辣: 'Medium spicy',
  重辣: 'Extra spicy',
  特辣: 'Extra spicy',
  素食: 'Vegetarian',
  即起: 'Serve now',
  慢起: 'Serve later',
  叫起: 'Serve on call',
};

/** 单位的英文：后台填的 → 内置的 → 中文 */
export const emenuUnitEn = (unit: string, unitEn: string): string => unitEn.trim() || EMENU_UNIT_EN[unit.trim()] || unit;
/** 规格名的英文：后台填的 → 内置的 → 中文 */
export const emenuSpecLabelEn = (label: string, labelEn: string): string => labelEn.trim() || EMENU_SPEC_EN[label.trim()] || label;
/** 忌口、起菜方式一个选项的英文：设置里填的 → 内置的 → 中文 */
export const emenuOptionEn = (option: string, optionsEn: Readonly<Record<string, string>>): string => optionsEn[option]?.trim() || EMENU_OPTION_EN[option] || option;

/** 这道菜切到英文时还缺什么：没有英文名，或有中文介绍、没有英文介绍（后台打「缺英文」标记用） */
export function dishMissingEnglish(d: { nameEn: string; description: string; descriptionEn: string }): boolean {
  return !d.nameEn.trim() || (!!d.description.trim() && !d.descriptionEn.trim());
}

/**
 * 平板切到英文时还缺英文的地方（8.1.6，docs/EMENU.md 第 15.6 节，QZ6）：后台「电子菜单」顶上列出、点一处跳到那里补。
 * 只算客人看得到的：启用的分类（英文名、填了小标题的页的英文小标题）、排进了启用的分类的启用的菜（英文名；有中文介绍的英文介绍）、
 * 忌口与起菜方式的选项（后台填的或系统自带的英文都没有）、早中晚三段的英文名。门店没录英文的地方平板上照旧显示中文（不机翻）
 */
export type EmenuEnglishGap =
  | { kind: 'category'; categoryId: number; label: string }
  | { kind: 'pageTitle'; categoryId: number; page: number; label: string }
  | { kind: 'dishName'; dishId: number; label: string }
  | { kind: 'dishIntro'; dishId: number; label: string }
  | { kind: 'option'; group: 'avoid' | 'serve'; label: string }
  | { kind: 'period'; key: EmenuPeriodKey; label: string };

export function emenuEnglishGaps(data: {
  categories: readonly EmenuCategoryAdmin[];
  dishes: readonly EmenuDishAdmin[];
  rules: Pick<EmenuRules, 'avoidOptions' | 'serveOptions' | 'optionsEn' | 'periods'>;
}): EmenuEnglishGap[] {
  // 中文那一项本来就没有汉字（如「BBQ」）：切到英文时显示的就是它，不算缺
  const zh = (text: string) => /[\u3400-\u9fff]/.test(text);
  const out: EmenuEnglishGap[] = [];
  const shown = new Set<number>();
  for (const c of data.categories) {
    if (!c.active) continue;
    if (!c.nameEn.trim() && zh(c.name)) out.push({ kind: 'category', categoryId: c.id, label: c.name });
    c.pages.forEach((p, i) => {
      if (EMENU_LAYOUT_INFO[p.layout]?.titled && p.title.trim() && !p.titleEn.trim() && zh(p.title))
        out.push({ kind: 'pageTitle', categoryId: c.id, page: i, label: `${c.name} · 第 ${i + 1} 页「${p.title}」` });
      for (const id of p.dishIds) if (id !== null) shown.add(id);
    });
  }
  for (const d of data.dishes) {
    if (!d.active || !shown.has(d.id)) continue;
    if (!d.nameEn.trim() && zh(d.name)) out.push({ kind: 'dishName', dishId: d.id, label: d.name });
    if (d.description.trim() && !d.descriptionEn.trim() && zh(d.description)) out.push({ kind: 'dishIntro', dishId: d.id, label: d.name });
  }
  for (const [group, list] of [
    ['avoid', data.rules.avoidOptions],
    ['serve', data.rules.serveOptions],
  ] as const) {
    for (const o of list) if (emenuOptionEn(o, data.rules.optionsEn) === o && zh(o)) out.push({ kind: 'option', group, label: o });
  }
  for (const p of data.rules.periods) if (!p.nameEn.trim() && zh(p.name)) out.push({ kind: 'period', key: p.key, label: p.name });
  return out;
}

/** 整单备注拼成一句：忌口、起菜方式、自定义，用「，」隔开（写到这一单每道菜的口味备注上） */
export function composeEmenuNote(avoid: readonly string[], serve: string | null, custom: string): string {
  return [...avoid, ...(serve ? [serve] : []), ...(custom.trim() ? [custom.trim()] : [])].join('，');
}

/** 选项全选上、再写满自定义备注时拼出来有多长（保存设置时核对放得进口味备注） */
export function emenuNoteWorstCase(avoidOptions: readonly string[], serveOptions: readonly string[]): number {
  const longestServe = serveOptions.reduce((m, s) => Math.max(m, s.length), 0);
  const parts = avoidOptions.length + (longestServe ? 1 : 0) + 1;
  return avoidOptions.reduce((s, o) => s + o.length, 0) + longestServe + EMENU_MAX_CUSTOM_NOTE + Math.max(0, parts - 1);
}

// ───────────────────────── 版面 ─────────────────────────

export const EMENU_LAYOUTS = ['cover', 'list_image', 'single_wide', 'single_left', 'single_right', 'duo_stagger', 'duo_row', 'duo_mixed', 'trio_row', 'trio_mixed', 'list_text'] as const;
export type EmenuLayout = (typeof EMENU_LAYOUTS)[number];

export interface EmenuLayoutInfo {
  label: string;
  /** 设计稿里叫什么 */
  design: string;
  /** 这一页最多放几道菜 */
  slots: number;
  /** 有竖排小标题（精品推荐 BEST SELLERS / 酒水 BEVERAGE） */
  titled: boolean;
  hint: string;
}

export const EMENU_LAYOUT_INFO: Record<EmenuLayout, EmenuLayoutInfo> = {
  cover: { label: '分类封面', design: '分类启始页', slots: 1, titled: false, hint: '分类大标题 + 一道主推菜的文字、特写图、大图' },
  list_image: { label: '大图 + 文字', design: '部分菜不展示图', slots: 6, titled: true, hint: '左边是第一道菜的大图，右边竖排小标题与两列菜名' },
  single_wide: { label: '单菜 · 横幅', design: '单个菜——大图', slots: 1, titled: false, hint: '横幅大图，下面左菜名、右介绍' },
  single_left: { label: '单菜 · 左图', design: '单个菜——大图加特写', slots: 1, titled: false, hint: '大图在左，特写在右上，文字在右' },
  single_right: { label: '单菜 · 右图', design: '单个菜——大图加特写', slots: 1, titled: false, hint: '文字在左，特写在左下，大图在右' },
  duo_stagger: { label: '两菜 · 错落', design: '两个菜', slots: 2, titled: false, hint: '左：图在上、文字在下；右：文字在上、图在下' },
  duo_row: { label: '两菜 · 并排', design: '两个菜', slots: 2, titled: false, hint: '两张图并排（一窄一宽），文字在下' },
  duo_mixed: { label: '两菜 · 一大一小', design: '两个菜', slots: 2, titled: false, hint: '左：文字在上、大图在下；右：小图在上、文字在下' },
  trio_row: { label: '三菜 · 等宽', design: '三个菜', slots: 3, titled: false, hint: '三张竖图等宽，文字在下' },
  trio_mixed: { label: '三菜 · 错落', design: '三个菜', slots: 3, titled: false, hint: '三张图大小不一，文字在下' },
  list_text: { label: '文字陈列', design: '无图——文字陈列', slots: 10, titled: true, hint: '竖排小标题，两列各 5 行：名称、英文名、属性行、价格' },
};

// ───────────────────────── 供应时段 ─────────────────────────

/** 一天里的第几分钟（0–1439）；start > end 为跨零点 */
export interface EmenuWindow {
  start: number;
  end: number;
}

/** 这个时刻在门店时区是一天里的第几分钟 */
export function minuteOfDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (n('hour') % 24) * 60 + n('minute');
}

/** 现在在不在供应时段里（没设时段 = 全天） */
export function windowOpen(window: EmenuWindow | null, minute: number): boolean {
  if (!window) return true;
  return window.start < window.end ? minute >= window.start && minute < window.end : minute >= window.start || minute < window.end;
}

export const formatMinute = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const formatWindow = (w: EmenuWindow | null) => (w ? `${formatMinute(w.start)}–${formatMinute(w.end)}` : '全天');

/** "11:00" → 660；格式不对返回 null */
export function parseMinute(text: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 三段的开始时间是不是早 < 午 < 晚（都在 0–1439 里） */
export function periodsValid(list: readonly Pick<EmenuPeriod, 'start'>[]): boolean {
  return list.length === EMENU_PERIODS.length && list.every((p, i) => Number.isInteger(p.start) && p.start >= 0 && p.start < 1440 && (i === 0 || p.start > list[i - 1]!.start));
}

/**
 * 设置里存的三段（保存时核对过）：按早、中、晚排，缺的项用默认补上；开始时间对不上「早 < 午 < 晚」的旧数据整套用默认。
 * 名称空着的用默认的名称。
 */
export function normalizePeriods(list: readonly Partial<EmenuPeriod>[] | null | undefined): EmenuPeriod[] {
  const merged = DEFAULT_EMENU_PERIODS.map((d) => {
    const got = (list ?? []).find((p) => p?.key === d.key);
    return {
      key: d.key,
      name: typeof got?.name === 'string' && got.name.trim() ? got.name.trim() : d.name,
      nameEn: typeof got?.nameEn === 'string' && got.nameEn.trim() ? got.nameEn.trim() : d.nameEn,
      start: typeof got?.start === 'number' ? got.start : d.start,
    };
  });
  return periodsValid(merged) ? merged : merged.map((p, i) => ({ ...p, start: DEFAULT_EMENU_PERIODS[i]!.start }));
}

/** 这个时刻在哪一段：开始时间不晚于它的最后一段；比早餐还早的算前一天的晚餐 */
export function periodAt(periods: readonly EmenuPeriod[], minute: number): EmenuPeriod {
  let at = periods[periods.length - 1]!;
  for (const p of periods) if (p.start <= minute) at = p;
  return at;
}

/** 一段的起止：结束是下一段的开始（晚餐的结束是第二天早餐的开始） */
export function periodWindow(periods: readonly EmenuPeriod[], key: EmenuPeriodKey): EmenuWindow {
  const i = periods.findIndex((p) => p.key === key);
  return { start: periods[i]!.start, end: periods[(i + 1) % periods.length]!.start };
}

/** 分类在不在这一段供应：没勾的是全天 */
export const periodsCover = (categoryPeriods: readonly string[], key: EmenuPeriodKey) => categoryPeriods.length === 0 || categoryPeriods.includes(key);

/** 分类现在供不供应：在现在这一段（或全天），并且在另外限定的时间里 */
export function categoryOpenAt(category: { periods: readonly string[]; window: EmenuWindow | null }, periods: readonly EmenuPeriod[], minute: number): boolean {
  return periodsCover(category.periods, periodAt(periods, minute).key) && windowOpen(category.window, minute);
}

/** 从这一分钟起，再过几分钟（1–1440）可能有分类开、关：时段交界与各分类另外限定时间的起止里最近的一个 */
export function minutesToNextChange(minute: number, periods: readonly EmenuPeriod[], windows: readonly (EmenuWindow | null)[]): number {
  const marks = [...periods.map((p) => p.start), ...windows.flatMap((w) => (w ? [w.start, w.end] : []))];
  return Math.min(...marks.map((m) => ((m - minute + 1439) % 1440) + 1));
}

/** 分类勾的几段按早中晚排好、去掉重复与认不出的 */
export const sortPeriods = (list: readonly string[]): EmenuPeriodKey[] => EMENU_PERIODS.filter((k) => list.includes(k));

/** 后台、提示里的写法：早餐 06:00–11:00 */
export function formatPeriod(periods: readonly EmenuPeriod[], key: EmenuPeriodKey): string {
  const p = periods.find((x) => x.key === key)!;
  return `${p.name} ${formatWindow(periodWindow(periods, key))}`;
}

/** 分类什么时候供应（后台列表用）：全天 / 早餐、午餐；另外限定时间的写在后面 */
export function describeCategoryHours(category: { periods: readonly string[]; window: EmenuWindow | null }, periods: readonly EmenuPeriod[]): string {
  const keys = sortPeriods(category.periods);
  const base = keys.length === 0 || keys.length === EMENU_PERIODS.length ? '全天' : keys.map((k) => periods.find((p) => p.key === k)!.name).join('、');
  return category.window ? `${base} · 限 ${formatWindow(category.window)}` : base;
}

// ───────────────────────── 平板上看到的菜单 ─────────────────────────

/** 一个规格现在能不能点 */
export type EmenuSpecState = 'ok' | 'sold_out' | 'off';

export interface EmenuSpecView {
  /** 价目表里的项目（下单用它） */
  itemId: number;
  /** 规格名（大份、小份）；只有一个规格的为空 */
  label: string;
  /** 规格名的英文（后台填的；空着时页面用内置的常见译法） */
  labelEn: string;
  /** 默认价格档的单价（分） */
  price: number;
  state: EmenuSpecState;
  /** 今天还剩几份（厨房沽清）；null 为不限量 */
  remaining: number | null;
}

export interface EmenuDishView {
  id: number;
  name: string;
  nameEn: string;
  tagline: string;
  description: string;
  attrs: string[];
  unit: string;
  /** 英文（8.0.13）：没填的为空，页面上显示中文 */
  taglineEn: string;
  descriptionEn: string;
  attrsEn: string[];
  unitEn: string;
  imageUrl: string | null;
  detailUrl: string | null;
  specs: EmenuSpecView[];
}

export interface EmenuPageView {
  /** 这一页放的菜（按位置；空位为 null） */
  layout: EmenuLayout;
  title: string;
  titleEn: string;
  dishes: (EmenuDishView | null)[];
}

export interface EmenuCategoryView {
  id: number;
  name: string;
  nameEn: string;
  /** 在哪几段供应（8.1.5；空的是全天） */
  periods: EmenuPeriodKey[];
  /** 另外限定的时间（8.0.10 的「指定时段」）；null 为不限 */
  window: EmenuWindow | null;
  /** 现在在供应时段里（不在的整类不能点，标「当前时段不可售」） */
  open: boolean;
  pages: EmenuPageView[];
}

/** 收起来的分类里的一道菜（8.1.5）：「未下单」那一行要的几样——菜名、小字、各规格的名称、价格与状态 */
export interface EmenuLaterDish {
  id: number;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  specs: Pick<EmenuSpecView, 'itemId' | 'label' | 'labelEn' | 'price' | 'state'>[];
}

export interface EmenuMenu {
  serverTime: string;
  businessDate: string;
  /** 平板点餐与餐饮功能都开着 */
  enabled: boolean;
  rules: Pick<EmenuRules, 'footerText' | 'avoidOptions' | 'serveOptions' | 'idleMinutes' | 'offHours' | 'langSwitch' | 'optionsEn' | 'motion' | 'requirePin' | 'textSize' | 'periods'> & {
    coverUrl: string | null;
  };
  /** 现在是哪一段（8.1.5）：工作台按某一段看时是那一段，看「全部」时为 null */
  period: (EmenuPeriod & { end: number }) | null;
  /** 下一次可能有分类开、关的时刻（时段交界、分类另外限定时间的起止）：平板到点马上重新取菜单；工作台按某一段看时为 null */
  nextChangeAt: string | null;
  /** 现在显示的分类（按排序；不在时段的只有设置成「显示」时才在） */
  categories: EmenuCategoryView[];
  /**
   * 不在时段、没显示出来的分类（没有分类可点时告诉客人什么时候供应）。dishes 是排在这一类里的菜（8.1.5）：
   * 「未下单」里还有这些菜时照旧显示菜名、规格与价格，标「当前时段不可售」，不当成已不在菜单上（页面刷新以后也一样）
   */
  later: { name: string; nameEn: string; periods: EmenuPeriodKey[]; window: EmenuWindow | null; dishes: EmenuLaterDish[] }[];
  /** 启用的桌台（空 = 店里没建桌台，桌号照输入的记） */
  tables: { name: string; area: string }[];
  /** UI 工作台（8.1.1）：这家店现在用哪一版版面（没发布过为空，用内置的默认版面）；inherited = 用的是本店的 */
  studio?: { id: number; version: number; inherited: boolean } | null;
}

/** 一道菜整体的状态：有一个规格能点就算能点；都不能点时，全是下架算下架，否则算售罄 */
export function dishState(dish: Pick<EmenuDishView, 'specs'>): EmenuSpecState {
  if (dish.specs.some((s) => s.state === 'ok')) return 'ok';
  return dish.specs.every((s) => s.state === 'off') ? 'off' : 'sold_out';
}

export type EmenuBlock = 'closed' | 'off' | 'sold_out';

/** 这道菜在这个分类里为什么不能点（能点返回 null）：分类不在时段 → 下架 → 售罄 */
export function dishBlock(dish: Pick<EmenuDishView, 'specs'>, categoryOpen: boolean): EmenuBlock | null {
  const state = dishState(dish);
  if (state === 'off') return 'off';
  if (!categoryOpen) return 'closed';
  return state === 'sold_out' ? 'sold_out' : null;
}

export const EMENU_BLOCK_LABELS: Record<EmenuBlock, { zh: string; en: string }> = {
  off: { zh: '已下架', en: 'Discontinued' },
  closed: { zh: '当前时段不可售', en: 'Not Available Now' },
  sold_out: { zh: '已售罄', en: 'Sold Out' },
};

// ───────────────────────── 手牌、桌号的输入 ─────────────────────────

/**
 * 键盘只有数字（DC4）：输入与牌号完全相同算对上；输入全是数字时，数字部分相同也算（8060 → A8060）。
 * 返回对上的那几个（调用方：一个直接用，几个让客人点选）
 */
export function matchByDigits<T extends { code: string }>(candidates: readonly T[], input: string): T[] {
  const q = normalizeTagCode(input);
  if (!q) return [];
  const exact = candidates.filter((c) => normalizeTagCode(c.code) === q);
  if (exact.length) return exact;
  if (!/^[0-9]+$/.test(q)) return [];
  return candidates.filter((c) => tagDigits(normalizeTagCode(c.code)) === q);
}

/** 桌号（DC5）：与桌台名称相同（不分大小写、不看空格），或输入全是数字时与名称里的数字相同（去掉前面的 0：1 = 01 = A01） */
export function matchTable<T extends { name: string }>(tables: readonly T[], input: string): T[] {
  const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
  const q = norm(input);
  if (!q) return [];
  const exact = tables.filter((t) => norm(t.name) === q);
  if (exact.length) return exact;
  if (!/^[0-9]+$/.test(q)) return [];
  const digits = (s: string) => s.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  return tables.filter((t) => digits(t.name) !== '' && digits(t.name) === digits(q));
}

// ───────────────────────── 客人（手牌）与已下单 ─────────────────────────

export interface EmenuOrderedLine {
  lineId: number;
  itemId: number | null;
  name: string;
  nameEn: string;
  quantity: number;
  amount: number;
}

/** 按手牌找到的在店客人：只给点餐要的（不含会员姓名、手机号、余额与别的消费） */
export interface EmenuGuest {
  visitId: number;
  tagCode: string;
  /** 这张手牌这次来访全部有效的餐饮明细（别的渠道点的也在，DC11） */
  ordered: EmenuOrderedLine[];
  /** 餐饮明细的合计（分） */
  orderedTotal: number;
}

// ───────────────────────── 下单 ─────────────────────────

export interface EmenuOrderLineInput {
  itemId: number;
  quantity: number;
}

/** 下单的内容（不含点单密码）：结果待确认时本机保存的就是这一份，重提时原样再发 */
export interface EmenuOrderBody {
  clientKey: string;
  visitId: number;
  /** 页面上显示的手牌号：锁住来访后核对还是这张牌 */
  tagCode: string;
  tableName: string;
  guests: number;
  lines: EmenuOrderLineInput[];
  avoid: string[];
  serve: string | null;
  customNote: string;
  /** 页面上看到的合计（分）：与门店系统按现在的价格算的不一样时拒绝 */
  expectedTotal: number;
}

export interface EmenuOrderResult {
  orderNo: string | null;
  tableName: string;
  guests: number;
  total: number;
  quantity: number;
  waiterName: string;
  /** 同一个操作编号已经下过：这是第一次的结果 */
  replayed: boolean;
  guest: EmenuGuest;
}

/** 结果待确认时按操作编号查回 / 确认作废的答复 */
export type EmenuOpLookup = { found: true; order: EmenuOrderResult } | { found: false; abandoned: boolean };

// ───────────────────────── 后台 ─────────────────────────

/** 能放进电子菜单的价目项目：在售、挂在启用的出品档口上、不需要技师 */
export interface EmenuItemOption {
  id: number;
  name: string;
  category: string;
  price: number;
  stationName: string;
  /** 已经放进哪道菜（一个项目只能在一道菜里） */
  dishId: number | null;
}

export interface EmenuDishAdmin {
  id: number;
  name: string;
  nameEn: string;
  tagline: string;
  description: string;
  attrs: string[];
  unit: string;
  taglineEn: string;
  descriptionEn: string;
  attrsEn: string[];
  unitEn: string;
  imageId: number | null;
  detailImageId: number | null;
  active: boolean;
  version: number;
  specs: { itemId: number; label: string; labelEn: string; itemName: string; price: number; orderable: boolean }[];
  /** 放在哪几个分类里（提示用） */
  usedIn: string[];
}

export interface EmenuPageAdmin {
  layout: EmenuLayout;
  title: string;
  titleEn: string;
  /** 每个位置放哪道菜（没放为 null；长度不超过这种版面的位置数） */
  dishIds: (number | null)[];
}

export interface EmenuCategoryAdmin {
  id: number;
  name: string;
  nameEn: string;
  /** 在哪几段供应（8.1.5；空的是全天） */
  periods: EmenuPeriodKey[];
  /** 另外限定的时间；null 为不限 */
  window: EmenuWindow | null;
  sortOrder: number;
  active: boolean;
  version: number;
  pages: EmenuPageAdmin[];
}

export interface EmenuAdmin {
  rules: EmenuRules;
  /** 设置的版本（保存时带回，别人先改过会被拒绝） */
  rulesRev: string;
  rulesUpdatedAt: string | null;
  rulesUpdatedBy: string | null;
  /** 餐饮功能开没开（没开时平板点餐开了也用不了） */
  diningEnabled: boolean;
  categories: EmenuCategoryAdmin[];
  dishes: EmenuDishAdmin[];
  items: EmenuItemOption[];
  tables: { name: string; area: string }[];
  /** 有「点餐平板」岗位的在职账号数、已有点单密码的在职员工数（提示用） */
  tabletAccounts: number;
  pinHolders: number;
  /** 卡片模板（8.1.2）：现在发布的版面里改过的那几块（版面预览照它画；没发布过、没改过为空） */
  templates?: import('./studio').StudioDoc['templates'] | null;
  /** 菜的几种样子（8.1.2 变体）：现在发布的版面里改过的 */
  dishStates?: import('./studio').StudioDoc['dishStates'] | null;
}

/** 图片地址（要登录、要能打开平板点餐或维护电子菜单） */
export const emenuImageUrl = (id: number | null | undefined) => (id ? `/api/emenu/images/${id}` : null);

/** 员工的点单密码状态（不含密码本身） */
export interface OrderPinStatus {
  has: boolean;
  setAt: string | null;
}

// ───────────────────────── 英文对照表（8.0.13，后台「菜品图文」导出 / 导入） ─────────────────────────

/** 导出的列（导入时按表头的名字找列，列的先后、多出来的列都不要紧） */
export const EMENU_ENGLISH_COLUMNS = ['编号', '菜名', '英文名', '名称后的小字', '小字的英文', '介绍', '英文介绍', '属性行', '属性行的英文', '单位', '单位的英文'] as const;
/** 属性行在一个格子里用竖线隔开：产地：法国 | 年份：NV */
export const EMENU_ATTR_SEPARATOR = ' | ';
export const EMENU_ENGLISH_MAX_ROWS = 3000;

/** 一道菜要改的英文：没给的项不动（空着的格子不会把原来的英文清掉） */
export interface EmenuEnglishRow {
  id: number;
  nameEn?: string;
  taglineEn?: string;
  descriptionEn?: string;
  attrsEn?: string[];
  unitEn?: string;
}

/** 一道菜现在的英文各项（读对照表时用来判断哪些格子改过、开头的单引号是谁加的） */
export type EmenuEnglishCurrent = Required<Omit<EmenuEnglishRow, 'id'>>;

export interface EmenuEnglishParsed {
  /** 要导入的行；给了「现在的值」时只含改过的格子（没改过的格子、整行都没改的行不在里面） */
  rows: EmenuEnglishRow[];
  /** 给了「现在的值」时：填了英文、但与现在一样的行数（不用导入） */
  unchanged: number;
  /** 读不了的地方（整份不能导：没有表头、引号不配对；或某一行不对：编号不是数字、太长），带行号 */
  problems: string[];
  /**
   * 改过、而且开头的单引号被当作防公式的去掉了的格子（8.0.17）：这一格原来带着系统加的防公式单引号，改完以后文件里
   * 分不出开头那个单引号是系统的还是填的人想留着的——按系统的去掉，但在导入前列出来「会保存成什么」，不悄悄改。
   */
  guarded: EmenuEnglishGuarded[];
}

export interface EmenuEnglishGuarded {
  /** 文件里的行号 */
  line: number;
  id: number;
  /** 哪一列（表头的名字） */
  column: string;
  /** 会保存成的值（已经去掉开头那个单引号） */
  value: string;
}

/**
 * 防表格公式的单引号要能原样还原。导出时 lib/csv 给以 = + @ 或「-」（后面不是数字）开头的格子前面加一个单引号，
 * 免得表格软件把它当公式执行；读回来时要把这个单引号去掉，不然「+ Seasonal special」导出再导入就成了「'+ Seasonal special」。
 * 为了不误伤本来就以单引号开头的内容（「'+1 Combo」），这类格子导出时再多加一个单引号、读回来去掉一个：
 *   原文 +x → 文件里 '+x → 读回 +x；原文 '+x → 文件里 ''+x → 读回 '+x；原文 'hello、-5 度 不加也不去。
 *
 * 文件里一个以「单引号 + 公式开头」开头的格子，可能是导出时加的防公式单引号，也可能是有人在空格子里自己填的、单引号就是内容。
 * 光看文件分不出来，所以读的时候对照这一格**现在的值**（readSheetCell）：
 *   · 与现在的值导出来的样子一模一样：没改过，不导入；
 *   · 改过，而且现在的值导出时带着防公式的单引号（那一格里本来就有一个系统加的）：开头的单引号当作那一个，去掉
 *     （填的人想把单引号留作内容时文件里分不出来：parseEmenuEnglishCsv 把这样的格子记进 guarded，导入前列给人看）；
 *   · 改过，现在的值导出时不带（空格子、普通的字）：系统没加过，开头的单引号是填的人自己写的，照字面保存。
 * 不知道现在的值时（没给，或编号对不上）当作导出的文件处理：去掉一个。
 */
const FORMULA_GUARDED = /^'+(?:[=+@]|-(?!\d))/;
/** lib/csv 的 escapeCell 给哪些格子加单引号（两边要一致，tests/emenu-english.test.ts 里对过） */
const FORMULA_START = (value: string) => /^[=+@]/.test(value) || (value.startsWith('-') && !/^-\d/.test(value));
/** 导出：本来就是「单引号 + 公式开头」的格子多加一个单引号（单纯公式开头的由 lib/csv 加） */
export const emenuSheetCellOut = (value: string): string => (FORMULA_GUARDED.test(value) ? `'${value}` : value);
/** 读回：去掉导出时加的那一个单引号 */
export const emenuSheetCellIn = (value: string): string => (FORMULA_GUARDED.test(value) ? value.slice(1) : value);
/** 一个值导出到对照表里是什么样子（emenuSheetCellOut 加上 lib/csv 的防公式单引号） */
export function emenuSheetGuard(value: string): string {
  const out = emenuSheetCellOut(value);
  return FORMULA_START(out) ? `'${out}` : out;
}

/**
 * 读对照表里的一格。now 是这一格现在的值（不知道为 undefined）。
 * 返回 null：这一格没改过（与现在的值导出来的样子一样），不用导入。
 */
export function readSheetCell(cell: string, now: string | undefined): string | null {
  const text = cell.trim();
  if (now === undefined) return emenuSheetCellIn(text).trim();
  const exported = emenuSheetGuard(now);
  if (text === exported) return null;
  return (exported !== now ? emenuSheetCellIn(text) : text).trim();
}

const ENGLISH_LIMITS = { nameEn: 80, taglineEn: 80, descriptionEn: 400, unitEn: 12 } as const;
const ENGLISH_HEADERS: Record<keyof typeof ENGLISH_LIMITS | 'attrsEn', string> = {
  nameEn: '英文名',
  taglineEn: '小字的英文',
  descriptionEn: '英文介绍',
  attrsEn: '属性行的英文',
  unitEn: '单位的英文',
};
export const EMENU_ATTR_EN_MAX = 48;

/**
 * 读英文对照表（CSV）：按表头找「编号」与各英文列；空行、英文各列都空着的行跳过。
 * current：各道菜现在的英文（按编号）。给了的话，没改过的格子不导入，开头的单引号是不是内容也按现在的值判断（见 readSheetCell）；
 * 不给时每个填了的格子都当作要导入的、按导出的文件去掉防公式的单引号。
 */
export function parseEmenuEnglishCsv(text: string, current?: ReadonlyMap<number, EmenuEnglishCurrent>): EmenuEnglishParsed {
  const fail = (problem: string): EmenuEnglishParsed => ({ rows: [], unchanged: 0, problems: [problem], guarded: [] });
  const { records, unclosedQuoteLine } = parseCsvRecords(text.replace(/^\uFEFF/, ''));
  if (unclosedQuoteLine !== null) return fail(unclosedQuoteMessage(unclosedQuoteLine));
  const filled = records.filter((r) => r.cells.some((c) => c.trim()));
  const header = filled[0];
  if (!header) return fail('文件是空的');
  const col = (name: string) => header.cells.findIndex((c) => c.trim() === name);
  const idCol = col('编号');
  if (idCol < 0) return fail('第一行要是表头，并且有「编号」这一列（请用「导出英文对照表」导出的文件来填）');
  const cols = Object.fromEntries(Object.entries(ENGLISH_HEADERS).map(([k, name]) => [k, col(name)])) as Record<keyof typeof ENGLISH_HEADERS, number>;
  if (Object.values(cols).every((i) => i < 0)) return fail(`没有找到英文的列（${Object.values(ENGLISH_HEADERS).join('、')}）`);
  const rows: EmenuEnglishRow[] = [];
  const problems: string[] = [];
  const seen = new Set<number>();
  const guarded: EmenuEnglishGuarded[] = [];
  let unchanged = 0;
  for (const r of filled.slice(1)) {
    const idText = (r.cells[idCol] ?? '').trim();
    const now = current?.get(Number(idText));
    let same = 0;
    const stripped: EmenuEnglishGuarded[] = [];
    // 一格的内容：空着的、没改过的都返回空字（不导入）；没改过的另记一笔
    const cell = (k: keyof typeof ENGLISH_HEADERS) => {
      const raw = cols[k] < 0 ? '' : (r.cells[cols[k]] ?? '').trim();
      if (!raw) return '';
      const value = readSheetCell(raw, now === undefined ? undefined : k === 'attrsEn' ? now.attrsEn.join(EMENU_ATTR_SEPARATOR) : now[k]);
      if (value === null) same += 1;
      // 对照着现在的值读、改过、开头少了一个单引号：按防公式的去掉的，记下来
      else if (now !== undefined && value !== raw) stripped.push({ line: r.line, id: Number(idText), column: ENGLISH_HEADERS[k], value });
      return value ?? '';
    };
    const row: EmenuEnglishRow = { id: Number(idText) };
    let bad = false;
    for (const k of Object.keys(ENGLISH_LIMITS) as (keyof typeof ENGLISH_LIMITS)[]) {
      const v = cell(k);
      if (!v) continue;
      if (v.length > ENGLISH_LIMITS[k]) {
        problems.push(`第 ${r.line} 行：「${ENGLISH_HEADERS[k]}」最多 ${ENGLISH_LIMITS[k]} 个字符（现在 ${v.length}）`);
        bad = true;
      }
      row[k] = v;
    }
    const attrs = cell('attrsEn')
      .split(/[|｜\n]/)
      .map((a) => a.trim())
      .filter(Boolean);
    if (attrs.length) {
      if (attrs.length > 3 || attrs.some((a) => a.length > EMENU_ATTR_EN_MAX)) {
        problems.push(`第 ${r.line} 行：「属性行的英文」最多 3 条、每条 ${EMENU_ATTR_EN_MAX} 个字符，用竖线 | 隔开`);
        bad = true;
      }
      row.attrsEn = attrs;
    }
    if (Object.keys(row).length === 1) {
      if (same > 0) unchanged += 1;
      continue;
    }
    if (!/^[0-9]{1,12}$/.test(idText) || row.id <= 0) {
      problems.push(`第 ${r.line} 行：编号「${idText}」不是数字（编号请不要改）`);
      continue;
    }
    if (seen.has(row.id)) {
      problems.push(`第 ${r.line} 行：编号 ${row.id} 出现了两次`);
      continue;
    }
    seen.add(row.id);
    if (!bad) {
      rows.push(row);
      guarded.push(...stripped);
    }
  }
  if (rows.length > EMENU_ENGLISH_MAX_ROWS) return fail(`一次最多导入 ${EMENU_ENGLISH_MAX_ROWS} 行`);
  return { rows, unchanged, problems, guarded };
}

/** 导入的结果 */
export interface EmenuEnglishResult {
  /** 改了几道菜 */
  updated: number;
  /** 内容与现在一样、没有动的 */
  unchanged: number;
  /** 编号对不上的（菜品不存在） */
  missing: number[];
}
