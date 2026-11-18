// 餐饮（S5 第一步）：出品档口、点单（挂在客人的手牌账单上）、厨房出品屏（KDS）与估清。
// 桌台与不洗浴客人的独立结账在第二步（ROADMAP 第 10 节）。
//
// 规则先按汤泉、洗浴中心餐厅的常见做法设默认值，标「待确认」，店主在后台「餐饮」里改：
//   · 菜品挂在出品档口（热菜、凉菜、主食、水吧……）上，下单后到那个档口的厨房屏；没挂档口的项目照常挂账、不进厨房；
//   · 出品：待做 → 制作中 → 已出餐 → 已上菜（服务员送到客人手上后点「上菜」；规则可改成出餐即算上菜）；
//   · 估清：厨房按营业日设某道菜还剩几份，0 为估清（卖完），点单超过剩余份数拒绝；退菜按原份数加回；
//   · 退菜就是作废这条明细（前台、点单页都可以），厨房屏上显示「已退」；
//   · 下单多少分钟还没出餐标红提醒（默认 15 分钟）。

import type { CheckoutMember } from './checkout';

export interface DiningRules {
  /** 餐饮功能：关闭时前台挂账与升级前完全一样，主导航没有「餐饮」（默认关闭） */
  enabled: boolean;
  /** 出餐后还要服务员点「上菜」（默认是）；关闭后出餐即算上菜 */
  trackServed: boolean;
  /** 下单多少分钟还没出餐标红提醒（默认 15） */
  warnMinutes: number;
  /**
   * 桌台点单（8.0.8，A05，F10）：默认关——店主「下架」，只能挂手牌点单；已经开着的桌台照常查看、结账、退菜、撤台、转台，
   * 只是不能再开台、加菜。桌台档案照旧（小程序扫码点餐的送餐位置）
   */
  tablesEnabled: boolean;
  /**
   * 小额退菜上限（8.0.8，B02，F11，分）：单条明细金额不超过它的菜，能下单的（「前台挂账」，桌台上的还要「点单」）就能直接退（原因必填，记下来）；
   * 超过的照旧（本人 15 分钟内、经理），或值班经理及以上当场授权。0 为不分级
   */
  voidFreeCents: number;
}

export const DEFAULT_DINING_RULES: DiningRules = {
  // 8.0.20：功能开关都默认开（店主 2026-11-14，docs/PENDING_DECISIONS.md KG1–KG4）；要关在设置页关
  enabled: true,
  trackServed: true,
  warnMinutes: 15,
  tablesEnabled: true,
  voidFreeCents: 5000,
};

/** 小额退菜上限最多 ¥1,000 */
export const MAX_VOID_FREE_CENTS = 100_000;

/** 这道菜能不能直接退（小额，8.0.8 B02）：餐饮明细、金额不超过上限 */
export const isSmallDishVoid = (rules: Pick<DiningRules, 'voidFreeCents'>, line: { source: string; amount: number }) =>
  line.source === 'dining' && rules.voidFreeCents > 0 && line.amount <= rules.voidFreeCents;

export const KITCHEN_STATUSES = ['queued', 'cooking', 'done', 'served', 'cancelled'] as const;
export type KitchenStatus = (typeof KITCHEN_STATUSES)[number];
export const KITCHEN_STATUS_LABELS: Record<KitchenStatus, string> = {
  queued: '待做',
  cooking: '制作中',
  done: '已出餐',
  served: '已上菜',
  cancelled: '已退',
};

/** 口味备注最多 40 字（少辣、不要香菜、走冰……） */
export const MAX_DISH_NOTE = 40;
export const MAX_STATION_NAME = 16;

// ───────────── 8.1.7：点单分类（餐厅 / 水吧 / 果吧，docs/DINING_V817.md 第 1 节） ─────────────
//   · 点单页先选一处（餐厅、水吧、果吧），再按小分类点；沽清列表、台账、退菜记录也按它分；
//   · 单独记在 service_items.dining_outlet / dining_group（迁移 181），不动价目表的分类（价目分类还管着部门营业额、券、会员折扣）；
//   · 后台没设的菜按默认归（diningSlotOf，CF3），页面上标「默认」。

export const DINING_OUTLET_KEYS = ['restaurant', 'water', 'fruit'] as const;
export type DiningOutlet = (typeof DINING_OUTLET_KEYS)[number];

export interface DiningOutletDef {
  key: DiningOutlet;
  label: string;
  /** 小分类；果吧不再细分，为空（CF1） */
  groups: readonly string[];
}

export const DINING_OUTLETS: readonly DiningOutletDef[] = [
  { key: 'restaurant', label: '餐厅', groups: ['餐饮', '酒水'] },
  { key: 'water', label: '水吧', groups: ['手作饮料', '糖水', '调酒'] },
  { key: 'fruit', label: '果吧', groups: [] },
];

export const DINING_OUTLET_LABELS: Record<DiningOutlet, string> = { restaurant: '餐厅', water: '水吧', fruit: '果吧' };

/** 一道菜在点单页的位置：哪一处、哪个小分类（果吧为空） */
export interface DiningSlot {
  outlet: DiningOutlet;
  group: string;
}

export const isDiningOutlet = (v: unknown): v is DiningOutlet => typeof v === 'string' && (DINING_OUTLET_KEYS as readonly string[]).includes(v);

export const outletDef = (key: DiningOutlet): DiningOutletDef => DINING_OUTLETS.find((o) => o.key === key)!;

/** 入口与小分类配得上：果吧的小分类为空，餐厅、水吧必须是自己的小分类之一 */
export const isValidSlot = (s: { outlet: string; group: string }): s is DiningSlot => {
  if (!isDiningOutlet(s.outlet)) return false;
  const def = outletDef(s.outlet);
  return def.groups.length === 0 ? s.group === '' : def.groups.includes(s.group);
};

/** 显示用：「餐厅 · 酒水」「果吧」 */
export const slotLabel = (s: DiningSlot): string => (s.group ? `${DINING_OUTLET_LABELS[s.outlet]} · ${s.group}` : DINING_OUTLET_LABELS[s.outlet]);

/** 下拉、接口用的编码：restaurant:餐饮、fruit */
export const slotKey = (s: DiningSlot): string => (s.group ? `${s.outlet}:${s.group}` : s.outlet);

export const parseSlotKey = (key: string): DiningSlot | null => {
  const i = key.indexOf(':');
  const s = i < 0 ? { outlet: key, group: '' } : { outlet: key.slice(0, i), group: key.slice(i + 1) };
  return isValidSlot(s) ? s : null;
};

/** 全部点单分类（按入口、小分类的顺序），后台下拉用 */
export const ALL_DINING_SLOTS: readonly DiningSlot[] = DINING_OUTLETS.flatMap((o) => (o.groups.length ? o.groups.map((group) => ({ outlet: o.key, group })) : [{ outlet: o.key, group: '' }]));

/** 排序用：入口、小分类在名单里的位置 */
export const slotOrder = (s: DiningSlot): number => {
  const i = ALL_DINING_SLOTS.findIndex((x) => x.outlet === s.outlet && x.group === s.group);
  return i < 0 ? ALL_DINING_SLOTS.length : i;
};

/**
 * 一道菜的点单分类（CF3）：后台设过的照设的（assigned）；没设的按默认归，从上往下第一条对上的——
 *   ① 价目分类正好是酒水、手作饮料、糖水、调酒 → 那一类（「餐饮」是店里菜品的统称，不算）；
 *   ② 价目分类带「果吧」→ 果吧；带「调酒」「鸡尾酒」→ 水吧 · 调酒；带「糖水」→ 水吧 · 糖水；带「酒」→ 餐厅 · 酒水；
 *   ③ 出品档口名带「果吧」→ 果吧；带「水吧」→ 水吧 · 手作饮料；
 *   ④ 价目分类带「饮品」「饮料」（不在水吧做的多是瓶装的）→ 餐厅 · 酒水；
 *   ⑤ 其余 → 餐厅 · 餐饮
 */
export function diningSlotOf(i: { outlet: string | null; group: string | null; category: string | null; stationName?: string | null }): DiningSlot & { assigned: boolean } {
  if (i.outlet && isDiningOutlet(i.outlet)) {
    const s = { outlet: i.outlet, group: i.group ?? '' };
    if (isValidSlot(s)) return { ...s, assigned: true };
    // 存的小分类配不上（以后改了小分类的名单）：归到这一处的第一个小分类
    return { outlet: i.outlet, group: outletDef(i.outlet).groups[0] ?? '', assigned: true };
  }
  const at = (outlet: DiningOutlet, group: string) => ({ outlet, group, assigned: false });
  const cat = (i.category ?? '').trim();
  if (cat !== '餐饮') for (const o of DINING_OUTLETS) if (o.groups.includes(cat)) return at(o.key, cat);
  if (cat.includes('果吧')) return at('fruit', '');
  if (cat.includes('调酒') || cat.includes('鸡尾酒')) return at('water', '调酒');
  if (cat.includes('糖水')) return at('water', '糖水');
  if (cat.includes('酒')) return at('restaurant', '酒水');
  const station = (i.stationName ?? '').trim();
  if (station.includes('果吧')) return at('fruit', '');
  if (station.includes('水吧')) return at('water', '手作饮料');
  if (cat.includes('饮品') || cat.includes('饮料')) return at('restaurant', '酒水');
  return at('restaurant', '餐饮');
}

/** 按入口、小分类筛（台账、退菜记录、沽清列表）：不带入口为全部；带了入口、小分类为空为这一处全部 */
export const slotMatches = (s: DiningSlot, outlet: DiningOutlet | null, groups: readonly string[]): boolean => !outlet || (s.outlet === outlet && (groups.length === 0 || groups.includes(s.group)));

export interface KitchenStation {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  /** 挂在这个档口的在售菜品数 */
  itemCount: number;
}

/** 厨房屏上的一道菜（一条餐饮明细）：手牌客人的（牌号）或桌台的（桌号） */
export interface KitchenItem {
  id: number;
  orderNo: string;
  visitId: number | null;
  tagCode: string | null;
  zone: 'male' | 'female' | null;
  /** 桌台的菜（第二步）：开台与桌号；手牌客人的菜为 null */
  tableSessionId: number | null;
  tableName: string | null;
  guest: string;
  itemId: number;
  name: string;
  quantity: number;
  note: string;
  /** 小程序扫了桌上的码点的菜送到哪张桌（v0.7.28；空为送到客人手里） */
  deliverTo: string;
  status: KitchenStatus;
  stationId: number;
  stationName: string;
  rushCount: number;
  createdAt: string;
  startedAt: string | null;
  doneAt: string | null;
  servedAt: string | null;
  postedByName: string;
  /** 客人已结账离店 / 这桌已结账（还没上的菜请与前台确认后处理） */
  visitClosed: boolean;
}

export interface KitchenBoard {
  serverTime: string;
  businessDate: string;
  rules: DiningRules;
  stations: KitchenStation[];
  /** 今天还没上菜、没退的菜，以及今天上过菜 / 退过的最近一些（按下单时间） */
  items: KitchenItem[];
  /** 进厨房的菜品（含估清状态），厨房屏的「估清」页用 */
  dishes: MenuDish[];
  today: { orders: number; dishes: number; served: number; cancelled: number; avgMinutes: number | null };
}

/** 点单页的一道菜 */
export interface MenuDish {
  id: number;
  name: string;
  category: string;
  /** 默认价格档的单价（分） */
  price: number;
  stationId: number;
  stationName: string;
  /** null 为不限量，0 为估清 */
  remaining: number | null;
  /** 点单分类（8.1.7）：在哪一处、哪个小分类（后台没设的按默认归） */
  outlet: DiningOutlet;
  group: string;
}

export interface DiningMenu {
  rules: DiningRules;
  businessDate: string;
  dishes: MenuDish[];
  /** 自己点的多少分钟内能自己退（前台规则「店员自行更正时限」；8.0.8 退菜弹窗显示属于哪一档用） */
  selfVoidMinutes: number;
}

/** 点单页按手牌找在店客人（服务员不一定有前台权限，只给点单需要的信息） */
export interface DiningGuest {
  visitId: number;
  tagCode: string;
  zone: 'male' | 'female';
  guest: string;
  /** 这位客人点过、还没上的菜（可以催单、上菜、退菜） */
  pending: PendingDish[];
  /** 在住的客房（8.0.20 客房点餐）：有的话可以选「送到客房」，出品单上写房号；没住店是 null */
  roomNo: string | null;
  /** 是按手牌还是按房号找到的（按房号找到的默认送到客房） */
  via?: 'tag' | 'room';
}

/** 点过、还没上的菜（出品单）：点单页、桌台详情上可以催单、上菜、退菜 */
export interface PendingDish {
  id: number;
  billLineId: number;
  /** 菜品（8.0.8 改单时放回购物车用） */
  itemId: number;
  name: string;
  quantity: number;
  note: string;
  status: KitchenStatus;
  rushCount: number;
  createdAt: string;
  /** 这条明细的金额、谁什么时候点的（8.0.8，B02：退菜分级——小额直接退，超过的本人 15 分钟内 / 经理 / 当场授权） */
  amount: number;
  postedBy: number;
  postedAt: string;
}

export interface DiningAdmin {
  rules: DiningRules;
  rulesUpdatedAt: string | null;
  rulesUpdatedBy: string | null;
  stations: KitchenStation[];
  /** 全部在售项目与所在档口（档口为 null 的不进厨房；需要技师的项目不进厨房） */
  items: {
    id: number;
    name: string;
    category: string;
    price: number;
    stationId: number | null;
    technicianRequired: boolean;
    /** 点单分类（8.1.7）：现在算在哪（slot），后台设过没有（slotAssigned：false 为按默认归的） */
    slot: DiningSlot;
    slotAssigned: boolean;
  }[];
}

export const kitchenElapsed = (from: string, now: number) => Math.max(0, Math.floor((now - new Date(from).getTime()) / 60_000));

// ───────────── 第二步：桌台、开台与桌台结账（不洗浴的客人） ─────────────
//   · 桌台在后台「餐饮」里建（大厅 A1、包间 1……），停用不删除；
//   · 开台：不洗浴的客人在一张桌台上用餐，一桌一张账单，可登记人数、称呼与会员（会员可用储值结账）；
//   · 点单到桌台（只能点进厨房的菜），厨房屏显示桌号；转台要写原因；没有有效明细时可以撤台；
//   · 结账：收银在餐饮页结账，收款方式、储值、团购券、优惠授权、班次与前台结账相同；反结账在前台「结账记录」里，与手牌相同。

export const MAX_TABLE_NAME = 12;
export const MAX_TABLE_AREA = 12;
/**
 * 桌台分区（8.1.7，CF5）：存在桌台的「区域」里，后台建桌、改桌时从这四个里选；
 * 原来写了别的区域的照旧（桌台页排在「其他区域」），接口照旧接受 12 个字以内的任何区域
 */
export const TABLE_ZONES = ['散桌', '景观包厢', '休闲水吧区', '休息果吧区'] as const;
/** 一次最多合并结几桌 */
export const MAX_TABLES_PER_CHECKOUT = 10;

export interface DiningTable {
  id: number;
  name: string;
  /** 区域：大厅、包间、露台……（空为不分区） */
  area: string;
  seats: number;
  sortOrder: number;
  active: boolean;
}

/** 桌台看板上的一桌（用餐中的开台） */
export interface TableSessionBrief {
  id: number;
  sessionNo: string;
  tableId: number;
  guests: number;
  guestLabel: string;
  memberId: number | null;
  memberName: string | null;
  openedAt: string;
  openedByName: string;
  /** 有效明细合计（分） */
  amount: number;
  lineCount: number;
  /** 还没上的菜（份） */
  pendingDishes: number;
}

export interface TablesBoard {
  serverTime: string;
  businessDate: string;
  tables: (DiningTable & { session: TableSessionBrief | null })[];
}

export interface TableSessionDetail {
  id: number;
  sessionNo: string;
  status: 'open' | 'settled' | 'cancelled';
  tableId: number;
  tableName: string;
  area: string;
  guests: number;
  guestLabel: string;
  member: { id: number; memberNo: string; name: string } | null;
  openedAt: string;
  openedByName: string;
  closedAt: string | null;
  closeReason: string | null;
  billId: number;
  billNo: string;
  amount: number;
  lines: import('./frontdesk').BillLine[];
  /** 这桌点过、还没上的菜 */
  pending: PendingDish[];
  moves: { fromTable: string; toTable: string; reason: string; operatorName: string; at: string }[];
}

/** 桌台结账前核对（只读） */
export interface TableCheckoutPreview {
  sessions: {
    sessionId: number;
    sessionNo: string;
    billId: number;
    tableName: string;
    guests: number;
    guestLabel: string;
    memberId: number | null;
    memberName: string | null;
    openedAt: string;
    lines: { id: number; name: string; quantity: number; amount: number }[];
    amount: number;
  }[];
  totalAmount: number;
  /** 这几桌登记的会员（可用储值支付），附余额 */
  members: CheckoutMember[];
  /** 这些会员的券（v0.7.20）：能抵多少，不能用的写原因 */
  storeCoupons?: import('./coupons').CheckoutCouponOption[];
  pricedAt: string;
  /** 还没上的菜：结账时只提醒 */
  dishes: { tableName: string; name: string; quantity: number; status: KitchenStatus }[];
}

export interface TablesAdmin {
  tables: (DiningTable & { sessionCount: number })[];
}

/** 小程序扫码点餐（第三期 3c）主线这一端的兜底：一单的份数与金额上限（N1，与 MP33 相同，待确认） */
export const MP_FOOD_ORDER_LIMITS = { maxQuantity: 20, maxTotalCents: 50_000 } as const;

/**
 * 账单一行最多几份（`bill_lines.quantity` 1–99，004 迁移的约束）：点单页、桌台点单、小程序扫码点餐的请求格式都按这个挡；
 * 一单要更多份就分几行（一单一共几份另按设置核对，例如扫码点餐的 N1 上限可调到 200）
 */
export const MAX_BILL_LINE_QUANTITY = 99;

/** 餐饮台账、退菜记录一次最多查几天（8.0.8，F13） */
export const MAX_DINING_LEDGER_DAYS = 92;

/** 餐饮台账的一行（8.0.8，B06）：一条餐饮明细 */
export interface DiningLedgerRow {
  id: number;
  businessDate: string;
  postedAt: string;
  tagCode: string;
  tableName: string;
  name: string;
  /** 价目分类（导出的「价目分类」，与日结的部门对得上） */
  category: string;
  /** 点单分类（8.1.7）：台账的「分类」 */
  outlet: DiningOutlet;
  group: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  status: 'active' | 'voided';
  voidReason: string | null;
  kitchenStatus: KitchenStatus | null;
  postedByName: string;
}

export interface DiningLedger {
  from: string;
  to: string;
  /** 这段时间里出现过的分类（筛选用） */
  categories: string[];
  rows: DiningLedgerRow[];
  /** 合计：份数、金额只算有效的；已退的另列 */
  totals: { lines: number; quantity: number; amount: number; voidedLines: number; voidedAmount: number };
}

/** 退菜记录的一行（8.0.8，B02） */
export interface DishVoidRow {
  id: number;
  name: string;
  quantity: number;
  amount: number;
  voidReason: string | null;
  voidedAt: string;
  voidedByName: string;
  postedByName: string;
  tagCode: string;
  tableName: string;
  /** 怎么批的：小额直接退 / 本人 15 分钟内 / 经理 / 当场授权（授权人） */
  approvalText: string;
  /** 点单分类（8.1.7）：退菜记录的「分类」 */
  outlet: DiningOutlet;
  group: string;
}

// ───────────── 8.1.7：点菜单（小票可视化，docs/DINING_V817.md 第 6 节） ─────────────

/** 点菜单上一道菜的样子：已上、未上（待做）、制作中、已出餐（还没上）、已退 */
export type ReceiptLineState = 'served' | 'waiting' | 'cooking' | 'done' | 'voided';

export const RECEIPT_STATE_LABELS: Record<ReceiptLineState, string> = {
  served: '已上',
  waiting: '未上',
  cooking: '制作中',
  done: '已出餐',
  voided: '已退',
};

/**
 * 一道菜算哪一样（CF9）：明细作废了或出品单退了 → 已退；没有出品单（不进厨房）→ 已上；
 * 已上菜 → 已上；已出餐：要服务员点「上菜」时算已出餐（还没上），不要时算已上；制作中；待做 → 未上
 */
export function receiptLineState(lineStatus: 'active' | 'voided', kitchen: KitchenStatus | null, trackServed: boolean): ReceiptLineState {
  if (lineStatus === 'voided' || kitchen === 'cancelled') return 'voided';
  if (kitchen === null || kitchen === 'served') return 'served';
  if (kitchen === 'done') return trackServed ? 'done' : 'served';
  return kitchen === 'cooking' ? 'cooking' : 'waiting';
}

export interface DiningReceiptLine {
  billLineId: number;
  name: string;
  outlet: DiningOutlet;
  group: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  note: string;
  kitchenStatus: KitchenStatus | null;
  state: ReceiptLineState;
}

/** 一次下单（同一张出品单号；不进厨房的明细按同一次挂账） */
export interface DiningReceiptOrder {
  /** 第几次下单（从 1 起，按下单时间） */
  seq: number;
  orderNo: string | null;
  postedAt: string;
  postedByName: string;
  lines: DiningReceiptLine[];
}

export interface DiningReceipt {
  kind: 'table' | 'tag';
  /** 开台 id（桌台）或来访 id（手牌客人） */
  id: number;
  /** 桌号或手牌号 */
  title: string;
  /** 桌台分区（区域）；手牌客人为空 */
  zone: string;
  guest: string;
  /** 人数（手牌客人为 null） */
  guests: number | null;
  openedAt: string;
  /** 已经结账、撤台或离店（只读） */
  closed: boolean;
  serverTime: string;
  /** 出餐后还要服务员点「上菜」（为 false 时已出餐即算已上） */
  trackServed: boolean;
  orders: DiningReceiptOrder[];
  /** 份数：有效的、已上、还没上（未上 + 制作中 + 已出餐）、已退；金额只算有效的 */
  totals: { quantity: number; served: number; waiting: number; voided: number; amount: number };
}
