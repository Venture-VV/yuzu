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
}

export const DEFAULT_EMENU_RULES: EmenuRules = {
  enabled: false,
  coverImageId: null,
  footerText: 'COPYRIGHT©2026 汤崎 ALL RIGHTS RESERVED',
  avoidOptions: ['不加香菜', '不加辣椒', '少辣', '不加洋葱', '不加香葱', '重辣'],
  serveOptions: ['即起', '慢起'],
  idleMinutes: 10,
  offHours: 'hide',
  langSwitch: true,
  optionsEn: {},
  motion: true,
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

export const EMENU_LAYOUTS = [
  'cover',
  'list_image',
  'single_wide',
  'single_left',
  'single_right',
  'duo_stagger',
  'duo_row',
  'duo_mixed',
  'trio_row',
  'trio_mixed',
  'list_text',
] as const;
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

export const EMENU_MAX_SLOTS = 10;

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
  /** 今天还剩几份（厨房估清）；null 为不限量 */
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
  window: EmenuWindow | null;
  /** 现在在供应时段里（不在的整类不能点，标「当前时段不可售」） */
  open: boolean;
  pages: EmenuPageView[];
}

export interface EmenuMenu {
  serverTime: string;
  businessDate: string;
  /** 平板点餐与餐饮功能都开着 */
  enabled: boolean;
  rules: Pick<EmenuRules, 'footerText' | 'avoidOptions' | 'serveOptions' | 'idleMinutes' | 'offHours' | 'langSwitch' | 'optionsEn' | 'motion'> & { coverUrl: string | null };
  /** 现在显示的分类（按排序；不在时段的只有设置成「显示」时才在） */
  categories: EmenuCategoryView[];
  /** 不在时段、没显示出来的分类（没有分类可点时告诉客人什么时候供应） */
  later: { name: string; nameEn: string; window: EmenuWindow }[];
  /** 启用的桌台（空 = 店里没建桌台，桌号照输入的记） */
  tables: { name: string; area: string }[];
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

export interface EmenuEnglishParsed {
  rows: EmenuEnglishRow[];
  /** 读不了的地方（整份不能导：没有表头、引号不配对；或某一行不对：编号不是数字、太长），带行号 */
  problems: string[];
}

/**
 * 防表格公式的单引号要能原样还原。导出时 lib/csv 给以 = + @ 或「-」（后面不是数字）开头的格子前面加一个单引号，
 * 免得表格软件把它当公式执行；读回来时要把这个单引号去掉，不然「+ Seasonal special」导出再导入就成了「'+ Seasonal special」。
 * 为了不误伤本来就以单引号开头的内容（「'+1 Combo」），这类格子导出时再多加一个单引号、读回来去掉一个：
 *   原文 +x → 文件里 '+x → 读回 +x；原文 '+x → 文件里 ''+x → 读回 '+x；原文 'hello、-5 度 不加也不去。
 */
const FORMULA_GUARDED = /^'+(?:[=+@]|-(?!\d))/;
/** 导出：本来就是「单引号 + 公式开头」的格子多加一个单引号（单纯公式开头的由 lib/csv 加） */
export const emenuSheetCellOut = (value: string): string => (FORMULA_GUARDED.test(value) ? `'${value}` : value);
/** 读回：去掉导出时加的那一个单引号 */
export const emenuSheetCellIn = (value: string): string => (FORMULA_GUARDED.test(value) ? value.slice(1) : value);

const ENGLISH_LIMITS = { nameEn: 80, taglineEn: 80, descriptionEn: 400, unitEn: 12 } as const;
const ENGLISH_HEADERS: Record<keyof typeof ENGLISH_LIMITS | 'attrsEn', string> = { nameEn: '英文名', taglineEn: '小字的英文', descriptionEn: '英文介绍', attrsEn: '属性行的英文', unitEn: '单位的英文' };
export const EMENU_ATTR_EN_MAX = 48;

/** 读英文对照表（CSV）：按表头找「编号」与各英文列；空行、英文各列都空着的行跳过 */
export function parseEmenuEnglishCsv(text: string): EmenuEnglishParsed {
  const { records, unclosedQuoteLine } = parseCsvRecords(text.replace(/^\uFEFF/, ''));
  if (unclosedQuoteLine !== null) return { rows: [], problems: [unclosedQuoteMessage(unclosedQuoteLine)] };
  const filled = records.filter((r) => r.cells.some((c) => c.trim()));
  const header = filled[0];
  if (!header) return { rows: [], problems: ['文件是空的'] };
  const col = (name: string) => header.cells.findIndex((c) => c.trim() === name);
  const idCol = col('编号');
  if (idCol < 0) return { rows: [], problems: ['第一行要是表头，并且有「编号」这一列（请用「导出英文对照表」导出的文件来填）'] };
  const cols = Object.fromEntries(Object.entries(ENGLISH_HEADERS).map(([k, name]) => [k, col(name)])) as Record<keyof typeof ENGLISH_HEADERS, number>;
  if (Object.values(cols).every((i) => i < 0)) return { rows: [], problems: [`没有找到英文的列（${Object.values(ENGLISH_HEADERS).join('、')}）`] };
  const rows: EmenuEnglishRow[] = [];
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const r of filled.slice(1)) {
    const idText = (r.cells[idCol] ?? '').trim();
    const cell = (k: keyof typeof ENGLISH_HEADERS) => (cols[k] < 0 ? '' : emenuSheetCellIn((r.cells[cols[k]] ?? '').trim()).trim());
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
    if (Object.keys(row).length === 1) continue;
    if (!/^[0-9]{1,12}$/.test(idText) || row.id <= 0) {
      problems.push(`第 ${r.line} 行：编号「${idText}」不是数字（编号请不要改）`);
      continue;
    }
    if (seen.has(row.id)) {
      problems.push(`第 ${r.line} 行：编号 ${row.id} 出现了两次`);
      continue;
    }
    seen.add(row.id);
    if (!bad) rows.push(row);
  }
  if (rows.length > EMENU_ENGLISH_MAX_ROWS) return { rows: [], problems: [`一次最多导入 ${EMENU_ENGLISH_MAX_ROWS} 行`] };
  return { rows, problems };
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
