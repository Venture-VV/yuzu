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

/** 一道菜最多 24 种做法（8.1.15 是 12 种，8.1.17 做法能分组以后放宽），每种最多 8 个字（CP2） */
export const MAX_DISH_METHODS = 24;
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

/** 出品单上的套餐内容：下单当时含哪几样（每份套餐的份数）；换过的（8.1.17）记原来是哪一样 */
export interface DishPart {
  name: string;
  quantity: number;
  from?: string;
}

/** 套餐可以换成的一样（8.1.17 BW7）：每份套餐补多少差价（0 为同价）；available 为现在能不能点（在售、档口启用） */
export interface ComboSwapOption {
  itemId: number;
  name: string;
  priceDiff: number;
  available: boolean;
}

/** 点单页、平板菜单里套餐的一样（8.1.17）：可换的带上能换成的几样 */
export interface ComboPartOption extends DishPart {
  itemId: number;
  swaps?: ComboSwapOption[];
}

/** 点单时选的换菜：套餐里的哪一样（价目项目）换成哪一样 */
export interface DishSwapChoice {
  from: number;
  to: number;
}

/** 一个套餐最多几样可换；一样最多能换成几样；差价最多 ¥999 */
export const MAX_COMBO_SWAPS = 8;
export const MAX_COMBO_SWAP_DIFF = 99_900;

/** 换菜写在出品单、账单上的样子：「可乐换橙汁 +¥3」「可乐换雪碧」 */
export const swapText = (fromName: string, toName: string, priceDiff: number): string => `${fromName}换${toName}${priceDiff > 0 ? ` ${plusYuan(priceDiff)}` : ''}`;

/**
 * 点单页选的换菜在这份套餐里是什么样（8.1.17 BW7，与服务端 dish-lines.ts 同样算）：每份补的差价、出品单上的写法、
 * 这一份含的几样（换过的记原来是哪一样）。菜单上已经没有的换法不算（下单时服务端会拒绝）
 */
export function comboChoice(combo: readonly ComboPartOption[], chosen: readonly DishSwapChoice[] = []): { extra: number; texts: string[]; parts: DishPart[] } {
  let extra = 0;
  const texts: string[] = [];
  const parts = combo.map((p): DishPart => {
    const pick = chosen.find((s) => s.from === p.itemId);
    const to = pick && p.swaps?.find((w) => w.itemId === pick.to);
    if (!to) return { name: p.name, quantity: p.quantity };
    extra += to.priceDiff;
    texts.push(swapText(p.name, to.name, to.priceDiff));
    return { name: to.name, quantity: p.quantity, from: p.name };
  });
  return { extra, texts, parts };
}

/** 点单页一道菜的加料：另外的一道菜（在售、能点的才列出来），价格是它自己的默认价 */
export interface DishAddonOption {
  id: number;
  name: string;
  price: number;
}

/** 写在出品单上的样子：「柠檬茶×1、薯条×2」；换过的写「橙汁×1（原 可乐）」 */
export const partsText = (parts: readonly DishPart[]): string => parts.map((p) => `${p.name}×${p.quantity}${p.from ? `（原 ${p.from}）` : ''}`).join('、');

/** 加料那一行的备注：「配 牛肉面」（出品备注最多 40 个字，菜名最多 32 个字，放得下） */
export const addonNote = (dishName: string): string => `配 ${dishName}`.slice(0, MAX_DISH_NOTE);

/** 选的做法与手写的备注拼成出品备注：做法在前、用「，」隔开，手写的接在后面 */
export const composeDishNote = (methods: readonly string[], note: string): string => [...methods, ...(note.trim() ? [note.trim()] : [])].join('，');

/** 拼出来放不放得进出品备注（最多 40 个字）；放不进的不让加进已点 */
export const dishNoteFits = (methods: readonly string[], note: string): boolean => composeDishNote(methods, note).length <= MAX_DISH_NOTE;

// ───────────────────────── 8.1.17：做法分组、加价、必选（BW6，docs/DISHES_V8117.md 第 2 节） ─────────────────────────

/** 一道菜最多分 6 组，组名最多 6 个字；一种做法最多加价 ¥999 */
export const MAX_DISH_METHOD_GROUPS = 6;
export const MAX_DISH_METHOD_GROUP_LENGTH = 6;
export const MAX_DISH_METHOD_PRICE = 99_900;
/** 出品单的口味备注最多 200 字（迁移 196：做法带加价、换菜、平板的整单备注拼在一起；点单页手写的部分照旧 40 字） */
export const MAX_KITCHEN_NOTE = 200;

/** 做法的一组：同一组里只能选一个；必选的组不选一个不能下单 */
export interface DishMethodGroup {
  name: string;
  required: boolean;
}

/** 一种做法：所在的组（'' 为不分组，可以多选）与加价（分，按份加在这一行的单价上；0 为不加钱） */
export interface DishMethodOption {
  name: string;
  group: string;
  price: number;
}

/** 「+¥2」「+¥2.50」 */
export const plusYuan = (cents: number): string => `+¥${cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)}`;

/** 做法写在出品单、账单上的样子：「微辣」「微辣 +¥2」 */
export const methodText = (m: Pick<DishMethodOption, 'name' | 'price'>): string => (m.price > 0 ? `${m.name} ${plusYuan(m.price)}` : m.name);

/** 选了的做法按这道菜维护时的顺序排好（出品单上的顺序不跟着点的先后变）；不认识的名字不在里面 */
export const pickedMethods = (options: readonly DishMethodOption[], chosen: readonly string[]): DishMethodOption[] => options.filter((o) => chosen.includes(o.name));

/** 选了的做法按份加多少钱 */
export const methodsExtra = (options: readonly DishMethodOption[], chosen: readonly string[]): number => pickedMethods(options, chosen).reduce((s, m) => s + m.price, 0);

export type MethodChoiceProblem = { code: 'DISH_METHOD_INVALID' | 'DISH_METHOD_GROUP' | 'DISH_METHOD_REQUIRED'; message: string; group?: string };

/**
 * 核对点一道菜时选的做法（点单页、桌台、平板与服务端用同一个）：不认识的做法、重复的、同一组选了两个、必选的组没选。
 * requireAll 为假时不查必选（前台「加项目」、小程序扫码点餐还选不了做法）；没问题返回 null
 */
export function methodChoiceProblem(
  dishName: string,
  options: readonly DishMethodOption[],
  groups: readonly DishMethodGroup[],
  chosen: readonly string[],
  opts: { requireAll: boolean },
): MethodChoiceProblem | null {
  if (new Set(chosen).size !== chosen.length) return { code: 'DISH_METHOD_INVALID', message: `「${dishName}」的做法重复了，请重新选` };
  const unknown = chosen.find((c) => !options.some((o) => o.name === c));
  if (unknown !== undefined) return { code: 'DISH_METHOD_INVALID', message: `「${dishName}」现在没有「${unknown}」这种做法了，请刷新后重新选` };
  for (const g of groups) {
    const picked = options.filter((o) => o.group === g.name && chosen.includes(o.name));
    if (picked.length > 1) return { code: 'DISH_METHOD_GROUP', message: `「${dishName}」的「${g.name}」只能选一个（选了 ${picked.map((p) => p.name).join('、')}）`, group: g.name };
    if (opts.requireAll && g.required && picked.length === 0 && options.some((o) => o.group === g.name)) {
      return { code: 'DISH_METHOD_REQUIRED', message: `「${dishName}」要先选「${g.name}」`, group: g.name };
    }
  }
  return null;
}

/**
 * 点单一行写在出品单（账单上也看得到）上的备注：加料写「配 主菜」，做法（带加价的写「微辣 +¥2」），换菜（「换 橙汁 +¥3」），
 * 最后是手写的；用「，」隔开
 */
export function composeLineNote(parts: { addonOf?: string | null; methods?: readonly Pick<DishMethodOption, 'name' | 'price'>[]; swaps?: readonly string[]; note?: string }): string {
  return [parts.addonOf ? `配 ${parts.addonOf}` : '', ...(parts.methods ?? []).map(methodText), ...(parts.swaps ?? []), (parts.note ?? '').trim()].filter(Boolean).join('，');
}

/**
 * Excel 里「做法」一格的写法（8.1.17）：分组的写「辣度（必选）：微辣、中辣+2」，不分组的直接列「免葱、加芝士+5」，几段用「；」隔开；
 * 加价写在做法后面「+元」。只写名字的（8.1.15 的导出）照样认：都算不分组、不加钱
 */
export function methodsCellText(options: readonly DishMethodOption[], groups: readonly DishMethodGroup[]): string {
  const item = (m: DishMethodOption) => (m.price > 0 ? `${m.name}+${m.price % 100 === 0 ? String(m.price / 100) : (m.price / 100).toFixed(2)}` : m.name);
  const segments = groups
    .map((g) => ({ g, list: options.filter((o) => o.group === g.name) }))
    .filter((x) => x.list.length > 0)
    .map(({ g, list }) => `${g.name}${g.required ? '（必选）' : ''}：${list.map(item).join('、')}`);
  const loose = options.filter((o) => !o.group || !groups.some((g) => g.name === o.group));
  if (loose.length) segments.push(loose.map(item).join('、'));
  return segments.join('；');
}

/** 读「做法」一格（methodsCellText 的反过来）；写错的给出原因 */
export function parseMethodsCell(text: string): { options: DishMethodOption[]; groups: DishMethodGroup[] } | { error: string } {
  const options: DishMethodOption[] = [];
  const groups: DishMethodGroup[] = [];
  for (const segment of text.split(/[；;\n]+/)) {
    const s = segment.trim();
    if (!s) continue;
    const colon = s.search(/[：:]/);
    let group = '';
    let body = s;
    if (colon >= 0) {
      const head = s.slice(0, colon).trim();
      body = s.slice(colon + 1);
      const required = /[（(［[]必选[）)］\]]$/.test(head);
      group = head.replace(/[（(［[]必选[）)］\]]$/, '').trim();
      if (!group) return { error: `「${s}」：冒号前面要写组名` };
      if (groups.some((g) => g.name === group)) return { error: `做法的组「${group}」写了两次` };
      groups.push({ name: group, required });
    }
    for (const raw of body.split(/[、，,/]+/)) {
      const t = raw.trim();
      if (!t) continue;
      const m = /^(.*?)\s*[+＋]\s*[¥￥]?\s*([0-9]+(?:\.[0-9]{1,2})?)$/.exec(t);
      const name = (m ? m[1]! : t).trim();
      const price = m ? Math.round(Number(m[2]) * 100) : 0;
      if (!name) return { error: `「${t}」：加价前面要写做法的名字` };
      if (options.some((o) => o.name === name)) return { error: `做法「${name}」写了两次` };
      options.push({ name, group, price });
    }
    if (group && !options.some((o) => o.group === group)) return { error: `做法的组「${group}」里还没有做法` };
  }
  return { options, groups };
}

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
  /** 8.1.17（BW7）：能不能换、能换成哪几样（差价） */
  swappable: boolean;
  swaps: ComboSwapOption[];
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
  /** 做法的名字（按维护时的顺序）；分组与加价在 methodOptions、methodGroups（8.1.17） */
  methods: string[];
  methodOptions: DishMethodOption[];
  methodGroups: DishMethodGroup[];
  addons: DishAddonRef[];
  combo: DishComboRef[];
  /** 被哪些菜当加料、在哪些套餐里（下架、改名时提醒） */
  usedBy: string[];
  /** 8.1.17（BW10）：同一个点单小类里的先后（null 为没排过）；删除了（下架并从菜品表默认隐藏，能恢复） */
  sort: number | null;
  deleted: boolean;
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
  /** 8.1.17（BW10）：删除了的也列出来（勾「显示已删除」）；不带是不列 */
  showDeleted?: boolean;
}

type Filterable = Pick<DishRow, 'name' | 'category' | 'outlet' | 'group' | 'stationName' | 'active' | 'remaining' | 'methods'> & { deleted?: boolean };

/** 菜品表的搜索与筛选（页面与导出、接口用同一个） */
export function filterDishes<T extends Filterable>(rows: readonly T[], f: DishFilter): T[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((d) => {
    if (d.deleted && !f.showDeleted) return false;
    if (f.outlet && d.outlet !== f.outlet) return false;
    if (f.status === 'on' && !d.active) return false;
    if (f.status === 'off' && d.active) return false;
    if (f.status === 'soldout' && !(d.active && d.remaining === 0)) return false;
    if (!q) return true;
    return [d.name, d.category, d.stationName, d.group, DINING_OUTLET_LABELS[d.outlet], ...d.methods].some((s) => s.toLowerCase().includes(q));
  });
}

/** 同一个点单小类里的先后存成「小类的位置 × 1000 + 第几个」（8.1.17 BW10）：整张表、点单页按它排时同一个小类挨在一起 */
export const DISH_SORT_SLOT_SPAN = 1000;
/** 一次最多给多少道菜排序、批量上下架 */
export const MAX_DISH_BATCH = 500;

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
  /**
   * 做法：只写名字的（8.1.15 的写法）是不分组、不加钱——编辑已有的菜时同名的做法保留原来的分组与加价；
   * 带分组、加价的写成 DishMethodOption，这时 methodGroups 一起交（8.1.17）
   */
  methods: (string | DishMethodOption)[];
  methodGroups?: DishMethodGroup[];
  addons: number[];
  /** 套餐内容；swappable、swaps 不带的（8.1.15 的页面、导入）保留原来的可换设置（8.1.17） */
  combo: { itemId: number; quantity: number; swappable?: boolean; swaps?: { itemId: number; priceDiff: number }[] }[];
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
