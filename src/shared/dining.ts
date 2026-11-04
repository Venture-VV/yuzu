// 餐饮（S5 第一步）：出品档口、点单（挂在客人的手牌账单上）、厨房出品屏（KDS）与估清。
// 桌台与不洗浴客人的独立结账在第二步（ROADMAP 第 10 节）。
//
// 规则先按汤泉、洗浴中心餐厅的常见做法设默认值，标「待确认」，店主在后台「餐饮」里改：
//   · 菜品挂在出品档口（热菜、凉菜、主食、水吧……）上，下单后到那个档口的厨房屏；没挂档口的项目照常挂账、不进厨房；
//   · 出品：待做 → 制作中 → 已出餐 → 已上菜（服务员送到客人手上后点「上菜」；规则可改成出餐即算上菜）；
//   · 估清：厨房按营业日设某道菜还剩几份，0 为估清（卖完），点单超过剩余份数拒绝；退菜按原份数加回；
//   · 退菜就是作废这条明细（前台、点单页都可以），厨房屏上显示「已退」；
//   · 下单多少分钟还没出餐标红提醒（默认 15 分钟）。

export interface DiningRules {
  /** 餐饮功能：关闭时前台挂账与升级前完全一样，主导航没有「餐饮」（默认关闭） */
  enabled: boolean;
  /** 出餐后还要服务员点「上菜」（默认是）；关闭后出餐即算上菜 */
  trackServed: boolean;
  /** 下单多少分钟还没出餐标红提醒（默认 15） */
  warnMinutes: number;
}

export const DEFAULT_DINING_RULES: DiningRules = {
  enabled: false,
  trackServed: true,
  warnMinutes: 15,
};

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
}

export interface DiningMenu {
  rules: DiningRules;
  businessDate: string;
  dishes: MenuDish[];
}

/** 点单页按手牌找在店客人（服务员不一定有前台权限，只给点单需要的信息） */
export interface DiningGuest {
  visitId: number;
  tagCode: string;
  zone: 'male' | 'female';
  guest: string;
  /** 这位客人点过、还没上的菜（可以催单、上菜、退菜） */
  pending: PendingDish[];
}

/** 点过、还没上的菜（出品单）：点单页、桌台详情上可以催单、上菜、退菜 */
export interface PendingDish {
  id: number;
  billLineId: number;
  name: string;
  quantity: number;
  note: string;
  status: KitchenStatus;
  rushCount: number;
  createdAt: string;
}

export interface DiningAdmin {
  rules: DiningRules;
  rulesUpdatedAt: string | null;
  rulesUpdatedBy: string | null;
  stations: KitchenStation[];
  /** 全部在售项目与所在档口（档口为 null 的不进厨房；需要技师的项目不进厨房） */
  items: { id: number; name: string; category: string; price: number; stationId: number | null; technicianRequired: boolean }[];
}

export const kitchenElapsed = (from: string, now: number) => Math.max(0, Math.floor((now - new Date(from).getTime()) / 60_000));

// ───────────── 第二步：桌台、开台与桌台结账（不洗浴的客人） ─────────────
//   · 桌台在后台「餐饮」里建（大厅 A1、包间 1……），停用不删除；
//   · 开台：不洗浴的客人在一张桌台上用餐，一桌一张账单，可登记人数、称呼与会员（会员可用储值结账）；
//   · 点单到桌台（只能点进厨房的菜），厨房屏显示桌号；转台要写原因；没有有效明细时可以撤台；
//   · 结账：收银在餐饮页结账，收款方式、储值、团购券、优惠授权、班次与前台结账相同；反结账在前台「结账记录」里，与手牌相同。

export const MAX_TABLE_NAME = 12;
export const MAX_TABLE_AREA = 12;
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
  members: { id: number; name: string; memberNo: string; status: 'active' | 'frozen'; principalBalance: number; bonusBalance: number }[];
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
