// 菜品管理（8.1.15，店主 2026-11-19《浴族系统需求汇总》餐饮第 4 条，docs/DISHES_V8115.md）。前后端共用。
//
// 菜品就是现有的餐饮价目项目（挂了出品档口、不需要技师的那些），不另建「菜品表」。这里在它上面补三样与一份记录：
//   · 做法：这道菜可选的做法，不加钱；点单时选了写进出品单的口味备注（「微辣，去冰」）；
//   · 加料：这道菜可以加的料，是另外的价目项目；点单时另起一行、备注写「配 某菜」，各算各的钱；
//   · 套餐：一个价目项目带「含哪几样」；下单时一行（按套餐自己的价格），出品单上列出含的几样；
//   · 改价记录：改前、改后、谁、几点、原因，只追加；以前的订单照下单时的价（明细上本来就留着当时的单价）。
// 没写细的地方按默认做（docs/PENDING_DECISIONS.md「块 C：菜品管理」CP1–CP12，待确认）。

import { PRICE_TIER_LABELS, PRICE_TIERS, type PriceTier, type TierPrice } from './catalog';
import { DINING_OUTLET_LABELS, isDiningOutlet, MAX_DISH_NOTE, outletDef, type DiningOutlet } from './dining';
import { formatYuan } from './money';
import type { Permission } from './permissions';

// ───────────────────────── 上限 ─────────────────────────

/** 一道菜最多 12 种做法，每种最多 8 个字（CP2） */
export const MAX_DISH_METHODS = 12;
export const MAX_DISH_METHOD_LENGTH = 8;
/** 一道菜最多 12 种加料；一个套餐最多含 12 样 */
export const MAX_DISH_ADDONS = 12;
export const MAX_COMBO_ITEMS = 12;
export const MAX_COMBO_ITEM_QUANTITY = 99;
export const MAX_PRICE_REASON = 100;
export const MAX_DISH_NAME = 32;
export const MAX_DISH_CATEGORY = 16;
/** 一次最多导入 1,000 道 */
export const DISH_IMPORT_MAX_ROWS = 1000;

// ───────────────────────── 权限 ─────────────────────────

/** 维护权限按出品口分三项（CP7）：没有某个出品口权限的看得到、改不了 */
export const DISH_OUTLET_PERMISSIONS = { restaurant: 'dish.restaurant', water: 'dish.water', fruit: 'dish.fruit' } as const satisfies Record<DiningOutlet, Permission>;
/** 改价是单独一项：定价（新建）、改价都要它，并且要有这道菜所在出品口的维护权限（CP6） */
export const DISH_PRICE_PERMISSION = 'dish.price' as const satisfies Permission;
/** 有其中任一项就看得到「菜品管理」 */
export const DISH_PERMISSIONS: readonly Permission[] = [...Object.values(DISH_OUTLET_PERMISSIONS), DISH_PRICE_PERMISSION];

// ───────────────────────── 点单：做法、加料、套餐 ─────────────────────────

/** 出品单上的套餐内容：下单当时含哪几样（每份套餐的份数） */
export interface DishPart {
  name: string;
  quantity: number;
}

/** 点单页一道菜的加料：另外的一道菜（在售、能点的才列出来），价格是它自己的默认价 */
export interface DishAddonOption {
  id: number;
  name: string;
  price: number;
}

/** 写在出品单上的样子：「柠檬茶×1、薯条×2」 */
export const partsText = (parts: readonly DishPart[]): string => parts.map((p) => `${p.name}×${p.quantity}`).join('、');

/** 加料那一行的备注：「配 牛肉面」（出品备注最多 40 个字，菜名最多 32 个字，放得下） */
export const addonNote = (dishName: string): string => `配 ${dishName}`.slice(0, MAX_DISH_NOTE);

/** 选的做法与手写的备注拼成出品备注：做法在前、用「，」隔开，手写的接在后面 */
export const composeDishNote = (methods: readonly string[], note: string): string => [...methods, ...(note.trim() ? [note.trim()] : [])].join('，');

/** 拼出来放不放得进出品备注（最多 40 个字）；放不进的不让加进已点 */
export const dishNoteFits = (methods: readonly string[], note: string): boolean => composeDishNote(methods, note).length <= MAX_DISH_NOTE;

// ───────────────────────── 菜品表 ─────────────────────────

export interface DishAddonRef {
  itemId: number;
  name: string;
  price: number;
  /** 现在能不能点：在售、挂在启用的档口上、不需要技师（不能点的在点单页不列出来） */
  available: boolean;
}

export interface DishComboRef {
  itemId: number;
  name: string;
  quantity: number;
  /** 这一样现在在不在售（不在售的套餐照卖，菜品表上提醒，CP4） */
  available: boolean;
}

export interface DishRow {
  id: number;
  name: string;
  /** 价目分类（管部门营业额、券的适用范围、会员折扣） */
  category: string;
  /** 出品口与小类（点单分类）；slotAssigned 为 false 是后台没设、按默认归的 */
  outlet: DiningOutlet;
  group: string;
  slotAssigned: boolean;
  stationId: number;
  stationName: string;
  stationActive: boolean;
  /** 规格 = 价目里的档；price 是默认档的价（点单页卖的就是它，CP1） */
  prices: TierPrice[];
  price: number;
  /** 上架 / 下架 */
  active: boolean;
  /** 今天的沽清：null 不限量，0 已沽清 */
  remaining: number | null;
  /** 菜品自己的图；imageUrl 是显示用的地址（自己没有图时带出电子菜单里的） */
  imageId: number | null;
  imageUrl: string | null;
  /** 放进了电子菜单的哪道菜（展示名）；没放为 null */
  emenuDish: string | null;
  methods: string[];
  addons: DishAddonRef[];
  combo: DishComboRef[];
  /** 被哪些菜当加料、在哪些套餐里（下架、改名时提醒） */
  usedBy: string[];
  /** 版本：保存时带回来，别人先改过会被拒绝 */
  rev: string;
  updatedAt: string;
}

export interface DishesBoard {
  businessDate: string;
  dishes: DishRow[];
  /** 出品档口（表单的下拉；停用的不能选） */
  stations: { id: number; name: string; active: boolean }[];
  /** 已有的价目分类（表单里的提示） */
  categories: string[];
}

export type DishStatusFilter = 'all' | 'on' | 'off' | 'soldout';
export const DISH_STATUS_LABELS: Record<DishStatusFilter, string> = { all: '全部', on: '上架', off: '下架', soldout: '沽清' };
export const isDishStatusFilter = (v: unknown): v is DishStatusFilter => typeof v === 'string' && v in DISH_STATUS_LABELS;

export interface DishFilter {
  /** 搜名称、分类、档口、做法（不分大小写） */
  q: string;
  outlet: DiningOutlet | null;
  status: DishStatusFilter;
}

type Filterable = Pick<DishRow, 'name' | 'category' | 'outlet' | 'group' | 'stationName' | 'active' | 'remaining' | 'methods'>;

/** 菜品表的搜索与筛选（页面与导出、接口用同一个） */
export function filterDishes<T extends Filterable>(rows: readonly T[], f: DishFilter): T[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((d) => {
    if (f.outlet && d.outlet !== f.outlet) return false;
    if (f.status === 'on' && !d.active) return false;
    if (f.status === 'off' && d.active) return false;
    if (f.status === 'soldout' && !(d.active && d.remaining === 0)) return false;
    if (!q) return true;
    return [d.name, d.category, d.stationName, d.group, DINING_OUTLET_LABELS[d.outlet], ...d.methods].some((s) => s.toLowerCase().includes(q));
  });
}

/** 沽清一格的字 */
export const remainingText = (remaining: number | null): string => (remaining === null ? '不限量' : remaining === 0 ? '已沽清' : `剩 ${remaining} 份`);

/** 规格与价格的字：只有一档写价格，多档写「标准 ¥38.00 / 优选 ¥58.00」 */
export const pricesText = (prices: readonly TierPrice[]): string =>
  prices.length === 1 ? formatYuan(prices[0]!.price) : prices.map((p) => `${PRICE_TIER_LABELS[p.tier]} ${formatYuan(p.price)}`).join(' / ');

// ───────────────────────── 改价记录 ─────────────────────────

export const DISH_PRICE_SOURCES = ['dishes', 'import', 'catalog', 'price_list'] as const;
export type DishPriceSource = (typeof DISH_PRICE_SOURCES)[number];
export const DISH_PRICE_SOURCE_LABELS: Record<DishPriceSource, string> = { dishes: '菜品管理', import: '菜品导入', catalog: '后台价目', price_list: '价目表导入' };

export interface DishPriceChange {
  id: number;
  itemId: number;
  itemName: string;
  tier: PriceTier;
  /** 改前为 null：原来没有这一档（新建菜品的定价）；改后为 null：去掉了这一档 */
  oldPrice: number | null;
  newPrice: number | null;
  reason: string;
  source: DishPriceSource;
  staffName: string | null;
  createdAt: string;
}

/** 两份规格价之间改了哪几档（按标准、专业、优选的顺序）；没改的不出 */
export function priceDiff(before: readonly TierPrice[], after: readonly TierPrice[]): { tier: PriceTier; oldPrice: number | null; newPrice: number | null }[] {
  const at = (list: readonly TierPrice[], tier: PriceTier) => list.find((p) => p.tier === tier)?.price ?? null;
  return PRICE_TIERS.map((tier) => ({ tier, oldPrice: at(before, tier), newPrice: at(after, tier) })).filter((d) => d.oldPrice !== d.newPrice);
}

/** 「标准 ¥38.00 → ¥42.00」「新加 优选 ¥58.00」「去掉 专业（原 ¥48.00）」 */
export function priceChangeText(c: { tier: PriceTier; oldPrice: number | null; newPrice: number | null }): string {
  const tier = PRICE_TIER_LABELS[c.tier];
  if (c.oldPrice === null) return `新加 ${tier} ${formatYuan(c.newPrice!)}`;
  if (c.newPrice === null) return `去掉 ${tier}（原 ${formatYuan(c.oldPrice)}）`;
  return `${tier} ${formatYuan(c.oldPrice)} → ${formatYuan(c.newPrice)}`;
}

// ───────────────────────── 保存 ─────────────────────────

/** 新增、编辑一道菜时交的内容（改价、上下架另有接口） */
export interface DishBody {
  name: string;
  category: string;
  /** 点单分类的编码：restaurant:餐饮、water:调酒、fruit */
  slot: string;
  stationId: number;
  imageId: number | null;
  methods: string[];
  addons: number[];
  combo: { itemId: number; quantity: number }[];
}

export interface DishSaveResult {
  dish: DishRow;
  /** 同一个操作编号已经办过：这是第一次的结果 */
  replayed: boolean;
}

// ───────────────────────── 导入、导出（Excel / CSV） ─────────────────────────

/** 导入认的列（按表头的名字找，先后、多出来的列都不要紧）；导出多三列只读的：今日沽清、图片、电子菜单 */
export const DISH_SHEET_COLUMNS = ['编号', '名称', '分类', '出品口', '小类', '档口', '标准价', '专业价', '优选价', '状态', '做法', '加料', '套餐内容'] as const;
export const DISH_EXPORT_EXTRA_COLUMNS = ['今日沽清', '图片', '电子菜单'] as const;
export const DISH_TIER_COLUMNS: Record<PriceTier, (typeof DISH_SHEET_COLUMNS)[number]> = { standard: '标准价', professional: '专业价', premium: '优选价' };
/** 做法、加料、套餐内容、某一档价格要清掉时写这个字（格子空着是不改） */
export const DISH_SHEET_CLEAR = '无';
export const DISH_SHEET_HINT =
  '名称必填；有「编号」的按编号找菜、没有的按名称找，找不到就新建。已有的菜格子空着是不改；做法、加料、套餐内容、某一档价格要清掉写「无」。' +
  '出品口写餐厅 / 水吧 / 果吧，小类写这一处的小分类（果吧不用写）；价格写元；状态写上架 / 下架；做法、加料用顿号隔开；套餐内容写「菜名×份数」、用顿号隔开。';

export interface DishImportIssue {
  /** 文件里的第几行（表头是第 1 行） */
  row: number;
  message: string;
}

export interface DishImportChange {
  row: number;
  name: string;
  action: 'create' | 'update';
  /** 改了什么：「标准 ¥38.00 → ¥42.00」「做法 微辣 → 微辣、中辣」 */
  fields: string[];
}

export interface DishImportPreview {
  fileName: string;
  rowCount: number;
  createCount: number;
  updateCount: number;
  unchangedCount: number;
  /** 其中要改价的几道（要写改价原因） */
  priceChangeCount: number;
  issues: DishImportIssue[];
  changes: DishImportChange[];
  /** 这份预览的摘要：生效时带回来，和当时算出来的不一样（别人改过菜、换了文件）就拒绝 */
  planHash: string;
}

export interface DishImportResult {
  created: number;
  updated: number;
  unchanged: number;
  priceChanges: number;
  replayed: boolean;
}

/** 做法、加料一格拆成几项：顿号、逗号、分号、斜杠、换行都算分隔；去掉空的与重复的 */
export function splitSheetList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[、，,;；/\n]+/)) {
    const s = part.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 套餐内容的一项：「柠檬茶×2」「柠檬茶 x2」「柠檬茶*2」「柠檬茶」（不写份数是 1）；份数不对返回 null */
export function parseComboPart(text: string): { name: string; quantity: number } | null {
  const m = /^(.*?)[\s]*[×xX*＊][\s]*([0-9]+)$/.exec(text.trim());
  if (!m) return text.trim() ? { name: text.trim(), quantity: 1 } : null;
  const quantity = Number(m[2]);
  const name = m[1]!.trim();
  if (!name || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_COMBO_ITEM_QUANTITY) return null;
  return { name, quantity };
}

/**
 * 表格里的价格（元）→ 分：「38」「38.5」「¥1,280.00」。Excel 存的数有时带一长串小数（38.900000000000006），
 * 离整分不到百万分之一的按整分算；多于两位小数、负数、0、不是数的返回 null
 */
export function parseSheetPrice(text: string): number | null {
  const t = text
    .trim()
    .replace(/[,，\s]/g, '')
    .replace(/^[¥￥]/, '');
  if (!/^[0-9]+(\.[0-9]+)?$/.test(t)) return null;
  const yuan = Number(t);
  const cents = Math.round(yuan * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 1_000_000_000 || Math.abs(yuan * 100 - cents) > 1e-6) return null;
  return cents;
}

/** 「上架」「下架」；空着返回 undefined，认不出返回 null */
export function parseSheetStatus(text: string): boolean | undefined | null {
  const t = text.trim();
  if (!t) return undefined;
  if (['上架', '在售', '启用', '是'].includes(t)) return true;
  if (['下架', '停售', '停用', '否'].includes(t)) return false;
  return null;
}

/** 出品口一格：「餐厅」「水吧」「果吧」；认不出返回 null */
export function parseSheetOutlet(text: string): DiningOutlet | null {
  const t = text.trim();
  if (isDiningOutlet(t)) return t;
  return (Object.keys(DINING_OUTLET_LABELS) as DiningOutlet[]).find((k) => DINING_OUTLET_LABELS[k] === t) ?? null;
}

/** 这一处要不要写小类（果吧不分） */
export const outletNeedsGroup = (outlet: DiningOutlet) => outletDef(outlet).groups.length > 0;
