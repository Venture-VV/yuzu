// 三台目标设备（店主 2026-11-18，docs/DEVICES.md，AGENTS.md「目标设备」）：以后所有更新都要适配
//   商米 D3 Pro（台式收银机，15.6 英寸 1920 × 1080；系统缩放 1.5 倍时 1280 × 720）、
//   商米 V3（手持点单机，6.75 英寸 720 × 1600，网页约 360 × 800）、
//   小米平板 6S Pro 12.4（网页 1355 × 903 横屏）。
// 在门店电脑这一组里另开这几个窗口，逐页核对：不横向滚动、没有东西超出屏幕右边（有意左右滑的区域除外）、要点的按钮在屏幕里、
// 菜名不被挤成一列。只读：菜单里的菜、桌台页、桌台详情与点菜单用合成数据代替接口（CI 的浏览器验收各组用的是只灌了五套演示数据的新库，
// 里面没有进厨房的菜）；为了看到餐饮页面临时打开餐饮与桌台点单，结束时恢复原样。8.1.16 起钟房、技师管理同样用合成的技师（临时打开技师功能），
// 会员详情取真的演示会员、把卡类型与会员卡换成合成的。
// 依赖四套演示数据（仅独立演示库）；账号店主 linlan。新做的、改过的页面加到下面 PAGES 里。
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { DiningMenu, DiningReceipt, KitchenBoard, KitchenItem, KitchenPartItem, MenuDish, PendingDish, TableSessionDetail, TablesBoard } from '../src/shared/dining';
import type { BillLine } from '../src/shared/frontdesk';
import type { DishPriceChange, DishesBoard } from '../src/shared/dishes';
import type { RoomCard, RoomCenterBoard, RoomGuestView, RoomHistory } from '../src/shared/room-center';
import { DEFAULT_CLOCKROOM_RULES, type BoardTechnician, type ClockroomBoard } from '../src/shared/clockroom';
import type { MemberCard } from '../src/shared/member-cards';
import type { MemberCardDeposits } from '../src/shared/member-form';
import type { RosterTechnician, ScheduleView, TechLeave, TechnicianAdminView } from '../src/shared/technician-admin';
import { DEFAULT_TECHNICIAN_RULES } from '../src/shared/technicians';
import { expectFits } from './fits';

const PASSWORD = 'yuzu2026';

interface Device {
  name: string;
  viewport: { width: number; height: number };
  mobile?: boolean;
  /** 这台设备上主要用的页面（docs/DEVICES.md 的「主要用在」） */
  pages: PageKey[];
}

type PageKey =
  | 'frontdesk'
  // 8.1.15：前台拆成发卡台（frontdesk）与收银台
  | 'cashier'
  | 'shift'
  | 'workbench'
  | 'dining-order'
  | 'dining-receipt'
  | 'dining-tables'
  | 'dining-kitchen'
  | 'dining-limits'
  | 'dining-ledger'
  | 'dining-voids'
  | 'admin-dining'
  // 8.1.9：零采备用金、库管入库、签赠（后台知识库、管家部与客户部的签赠台账）
  | 'pool'
  | 'direct-receipt'
  | 'admin-gifts'
  | 'gift-ledger-concierge'
  | 'gift-ledger-customer'
  // 8.1.10：需求单的待核库、核库对话框、替代确认（合成的需求单），急采的待补合同
  | 'requests-stock'
  | 'urgent-contract'
  // 8.1.15 菜品管理：菜品表与新增 / 编辑、改价、导入三个弹窗；点单时选做法与加料的弹窗（合成的菜品）
  | 'dining-dishes'
  | 'dining-dish-options'
  // 8.1.16 房态中心：总览、按房型的页签与各状态的数量、卡片（五种状态都有、客人名有长有短）、房间详情、登记对话框（合成的看板）
  | 'room-center'
  // 8.1.16 技师（块 E）：钟房（播报条、搜索与筛选、按状态排的技师卡片）、技师管理四个页签与它们的弹窗（合成的技师）
  | 'clockroom'
  | 'technician-admin'
  // 8.1.16 会员（块 F）：新建会员两步（先选卡类型）、会员详情（卡类型、推荐人、偏好项目、会员卡与押金、退卡弹窗）
  | 'member-create'
  | 'member-detail';

const DEVICES: Device[] = [
  {
    name: '商米 D3 Pro',
    viewport: { width: 1920, height: 1080 },
    pages: [
      'frontdesk',
      'cashier',
      'shift',
      'workbench',
      'dining-order',
      'dining-receipt',
      'dining-tables',
      'dining-ledger',
      'dining-voids',
      'admin-dining',
      'pool',
      'direct-receipt',
      'admin-gifts',
      'gift-ledger-customer',
      'requests-stock',
      'urgent-contract',
      'dining-dishes',
      'dining-dish-options',
      'room-center',
      'clockroom',
      'technician-admin',
      'member-create',
      'member-detail',
    ],
  },
  {
    name: '商米 D3 Pro（系统缩放 1.5 倍）',
    viewport: { width: 1280, height: 720 },
    pages: [
      'frontdesk',
      'cashier',
      'dining-order',
      'dining-receipt',
      'dining-tables',
      'dining-ledger',
      'pool',
      'gift-ledger-concierge',
      'requests-stock',
      'dining-dishes',
      'dining-dish-options',
      'room-center',
      'clockroom',
      'technician-admin',
      'member-create',
      'member-detail',
    ],
  },
  {
    name: '商米 V3',
    viewport: { width: 360, height: 800 },
    mobile: true,
    pages: [
      'frontdesk',
      'cashier',
      'dining-order',
      'dining-receipt',
      'dining-tables',
      'dining-kitchen',
      'dining-limits',
      'gift-ledger-concierge',
      'gift-ledger-customer',
      'requests-stock',
      'urgent-contract',
      'dining-dishes',
      'dining-dish-options',
      'room-center',
      'clockroom',
      'technician-admin',
      'member-create',
      'member-detail',
    ],
  },
  {
    name: '小米平板 6S Pro 12.4',
    viewport: { width: 1355, height: 903 },
    pages: [
      'frontdesk',
      'cashier',
      'dining-order',
      'dining-receipt',
      'dining-tables',
      'dining-kitchen',
      'direct-receipt',
      'admin-gifts',
      'gift-ledger-concierge',
      'requests-stock',
      'urgent-contract',
      'dining-dishes',
      'dining-dish-options',
      'room-center',
      'clockroom',
      'technician-admin',
      'member-create',
      'member-detail',
    ],
  },
];

// ───────────── 合成数据：一桌用餐中的景观包厢、几张空桌（四个分区都有），点菜单五种状态都有、菜名有长有短 ─────────────

const SID = 990_001;
const NOW = new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
// 8.1.15 块 B1：桌台多了状态（可用 / 待清台 / 维修中）
const STATE = { state: 'available', maintenanceReason: null, maintenanceUntil: null, stateSince: null } as const;
const free = (id: number, name: string, area: string, seats: number) => ({ id, name, area, seats, sortOrder: id, active: true, ...STATE, session: null });
const BOARD: TablesBoard = {
  serverTime: NOW,
  businessDate: NOW.slice(0, 10),
  tables: [
    free(990_101, 'A1', '散桌', 4),
    free(990_102, 'A2', '散桌', 4),
    {
      id: 990_103,
      name: '观澜厅',
      area: '景观包厢',
      seats: 10,
      sortOrder: 990_103,
      active: true,
      ...STATE,
      session: {
        id: SID,
        sessionNo: 'T99000001',
        tableId: 990_103,
        guests: 6,
        guestLabel: '陈先生',
        memberId: null,
        memberName: null,
        openedAt: ago(48),
        openedByName: '前台小周',
        amount: 30_200,
        lineCount: 6,
        pendingDishes: 4,
        mergedInto: null,
      },
    },
    free(990_104, '听松阁', '景观包厢', 8),
    // 8.1.15：一张待清台、一张维修中（格子上颜色加文字加图标，维修写原因与预计时间）
    { ...free(990_105, 'W1', '休闲水吧区', 2), state: 'dirty', stateSince: ago(6) },
    { ...free(990_106, 'F1', '休息果吧区', 4), state: 'maintenance', maintenanceReason: '桌腿松了，等师傅来修', maintenanceUntil: ago(-120), stateSince: ago(30) },
  ],
};

const DISHES: { name: string; qty: number; price: number; kitchen: BillLine['kitchen']; outlet: 'restaurant' | 'water' | 'fruit'; group: string; order: number }[] = [
  { name: '宫保鸡丁', qty: 1, price: 4_800, kitchen: { status: 'served', note: '少辣', orderNo: 'K1' }, outlet: 'restaurant', group: '餐饮', order: 1 },
  { name: '青岛纯生', qty: 4, price: 1_800, kitchen: { status: 'done', note: '', orderNo: 'K1' }, outlet: 'restaurant', group: '酒水', order: 1 },
  { name: '招牌手打香水柠檬茶（大杯）', qty: 2, price: 2_600, kitchen: { status: 'cooking', note: '少冰', orderNo: 'K2' }, outlet: 'water', group: '手作饮料', order: 2 },
  { name: '杨枝甘露', qty: 2, price: 3_200, kitchen: { status: 'queued', note: '', orderNo: 'K2' }, outlet: 'water', group: '糖水', order: 2 },
  { name: '莫吉托', qty: 1, price: 6_800, kitchen: { status: 'cancelled', note: '', orderNo: 'K2' }, outlet: 'water', group: '调酒', order: 2 },
  { name: '鲜切时令果盘', qty: 1, price: 5_800, kitchen: { status: 'queued', note: '', orderNo: 'K3' }, outlet: 'fruit', group: '', order: 3 },
];

const LINES: BillLine[] = DISHES.map((d, i) => ({
  id: 991_000 + i,
  source: 'dining',
  itemId: 992_000 + i,
  tier: null,
  name: d.name,
  unitPrice: d.price,
  quantity: d.qty,
  amount: d.price * d.qty,
  status: d.kitchen?.status === 'cancelled' ? 'voided' : 'active',
  postKey: `k${d.order}`,
  businessDate: BOARD.businessDate,
  postedById: 1,
  postedByName: '前台小周',
  postedAt: ago(48 - d.order * 10),
  voidReason: d.kitchen?.status === 'cancelled' ? '客人不要了' : null,
  voidedByName: d.kitchen?.status === 'cancelled' ? '前台小周' : null,
  voidedAt: d.kitchen?.status === 'cancelled' ? ago(10) : null,
  backfill: null,
  technician: null,
  kitchen: d.kitchen,
  sessionId: null,
}));

const PENDING: PendingDish[] = LINES.filter((l) => l.status === 'active' && l.kitchen && l.kitchen.status !== 'served').map((l, i) => ({
  id: 993_000 + i,
  billLineId: l.id,
  itemId: l.itemId!,
  name: l.name,
  quantity: l.quantity,
  note: l.kitchen!.note,
  status: l.kitchen!.status,
  rushCount: 0,
  createdAt: l.postedAt,
  amount: l.amount,
  postedBy: 1,
  postedAt: l.postedAt,
}));

const DETAIL: TableSessionDetail = {
  id: SID,
  sessionNo: 'T99000001',
  status: 'open',
  tableId: 990_103,
  tableName: '观澜厅',
  area: '景观包厢',
  guests: 6,
  guestLabel: '陈先生',
  member: null,
  openedAt: ago(48),
  openedByName: '前台小周',
  closedAt: null,
  closeReason: null,
  billId: 994_001,
  billNo: 'B99000001',
  amount: LINES.filter((l) => l.status === 'active').reduce((n, l) => n + l.amount, 0),
  lines: LINES,
  pending: PENDING,
  moves: [],
  mergedInto: null,
  merged: [],
};

const RECEIPT: DiningReceipt = (() => {
  const state = (k: BillLine['kitchen']) =>
    k?.status === 'cancelled' ? 'voided' : k?.status === 'served' ? 'served' : k?.status === 'done' ? 'done' : k?.status === 'cooking' ? 'cooking' : 'waiting';
  const orders = [1, 2, 3].map((seq) => ({
    seq,
    orderNo: `K${seq}`,
    postedAt: ago(48 - seq * 10),
    postedByName: '前台小周',
    orderNote: seq === 1 ? '先上凉菜，孩子的不要辣' : '',
    deliverRoom: '',
    lines: DISHES.flatMap((d, i) =>
      d.order === seq
        ? [
            {
              billLineId: LINES[i]!.id,
              name: d.name,
              outlet: d.outlet,
              group: d.group,
              quantity: d.qty,
              unitPrice: d.price,
              amount: d.price * d.qty,
              note: d.kitchen?.note ?? '',
              parts: [],
              kitchenStatus: d.kitchen?.status ?? null,
              state: state(d.kitchen),
            } as DiningReceipt['orders'][number]['lines'][number],
          ]
        : [],
    ),
  }));
  const all = orders.flatMap((o) => o.lines);
  const active = all.filter((l) => l.state !== 'voided');
  const sum = (list: typeof all) => list.reduce((n, l) => n + l.quantity, 0);
  return {
    kind: 'table',
    id: SID,
    title: '观澜厅',
    zone: '景观包厢',
    guest: '陈先生',
    guests: 6,
    openedAt: ago(48),
    closed: false,
    serverTime: NOW,
    trackServed: true,
    orders,
    totals: {
      quantity: sum(active),
      served: sum(active.filter((l) => l.state === 'served')),
      waiting: sum(active.filter((l) => l.state !== 'served')),
      voided: sum(all.filter((l) => l.state === 'voided')),
      amount: active.reduce((n, l) => n + l.amount, 0),
    },
  };
})();

/** 菜单里的菜：三处、每个小分类都有，菜名有长有短，一道沽清、一道限量（规则、营业日照接口返回的） */
const MENU_DISHES: MenuDish[] = (
  [
    ['宫保鸡丁', 4_800, '热菜', 'restaurant', '餐饮', null],
    ['小炒黄牛肉', 6_800, '热菜', 'restaurant', '餐饮', 3],
    ['招牌秘制酱香手撕鸡（半只）', 8_800, '热菜', 'restaurant', '餐饮', null],
    ['青岛纯生', 1_800, '吧台', 'restaurant', '酒水', null],
    ['张裕干红（杯）', 5_800, '吧台', 'restaurant', '酒水', 0],
    ['招牌手打香水柠檬茶（大杯）', 2_600, '水吧', 'water', '手作饮料', null],
    ['柚子气泡水', 2_200, '水吧', 'water', '手作饮料', null],
    ['杨枝甘露', 3_200, '水吧', 'water', '糖水', null],
    ['莫吉托', 6_800, '水吧', 'water', '调酒', null],
    ['鲜切时令果盘', 5_800, '果吧', 'fruit', '', null],
    ['鲜榨西瓜汁', 2_800, '果吧', 'fruit', '', null],
  ] as const
).map(([name, price, station, outlet, group, remaining], i) => ({
  id: 995_001 + i,
  name,
  category: '餐饮',
  price,
  stationId: 996_000 + ['热菜', '吧台', '水吧', '果吧'].indexOf(station),
  stationName: station,
  remaining,
  outlet,
  group,
}));

// 8.1.15 菜品管理：「小炒黄牛肉」有六种做法、两种加料，「招牌秘制酱香手撕鸡（半只）」是套餐（点单时的选项弹窗、菜单上的提示）
const SPICY = MENU_DISHES[1]!;
const COMBO_DISH = MENU_DISHES[2]!;
SPICY.methods = ['微辣', '中辣', '特辣', '免葱', '免蒜', '免香菜'];
// 8.1.17：辣度是必选的一组、特辣加 ¥2（docs/DISHES_V8117.md）
SPICY.methodOptions = SPICY.methods.map((name, i) => ({ name, group: i < 3 ? '辣度' : '', price: name === '特辣' ? 200 : 0 }));
SPICY.methodGroups = [{ name: '辣度', required: true }];
SPICY.addons = [MENU_DISHES[0]!, MENU_DISHES[5]!].map((d) => ({ id: d.id, name: d.name, price: d.price }));
// 8.1.17（BW7）：柠檬茶可以换成柚子气泡水（同价）或杨枝甘露（每份补 ¥6）
COMBO_DISH.combo = [
  { name: '宫保鸡丁', quantity: 1, itemId: MENU_DISHES[0]!.id },
  {
    name: '招牌手打香水柠檬茶（大杯）',
    quantity: 2,
    itemId: MENU_DISHES[5]!.id,
    swaps: [
      { itemId: MENU_DISHES[6]!.id, name: MENU_DISHES[6]!.name, priceDiff: 0, available: true },
      { itemId: MENU_DISHES[7]!.id, name: MENU_DISHES[7]!.name, priceDiff: 600, available: true },
    ],
  },
];

/** 合成的菜品表：三处都有，菜名有长有短；有下架的、沽清的、两档规格的、档口停用的、按默认归的、被别的菜用着的 */
const DISH_BOARD: DishesBoard = {
  businessDate: NOW.slice(0, 10),
  stations: ['热菜', '吧台', '水吧', '果吧'].map((name, i) => ({ id: 996_000 + i, name, active: i !== 1 })),
  categories: ['餐饮', '酒水', '饮品'],
  dishes: MENU_DISHES.map((d, i) => ({
    id: d.id,
    name: d.name,
    category: i % 4 === 3 ? '酒水' : '餐饮',
    outlet: d.outlet,
    group: d.group,
    slotAssigned: i % 3 !== 0,
    stationId: d.stationId,
    stationName: d.stationName,
    stationActive: d.stationName !== '吧台',
    prices:
      i === 2
        ? [
            { tier: 'standard', price: d.price },
            { tier: 'premium', price: d.price + 2_000 },
          ]
        : [{ tier: 'standard', price: d.price }],
    price: d.price,
    active: i !== 6,
    remaining: d.remaining,
    imageId: null,
    imageUrl: null,
    emenuDish: null,
    methods: d.methods ?? [],
    methodOptions: d.methodOptions ?? [],
    methodGroups: d.methodGroups ?? [],
    addons: (d.addons ?? []).map((a) => ({ itemId: a.id, name: a.name, price: a.price, available: true })),
    combo: (d.combo ?? []).map((c, k) => ({ itemId: c.itemId, name: c.name, quantity: c.quantity, available: k === 0, swappable: !!c.swaps, swaps: c.swaps ?? [] })),
    usedBy: i === 0 ? ['「小炒黄牛肉」的加料', '套餐「招牌秘制酱香手撕鸡（半只）」'] : [],
    sort: null,
    deleted: false,
    rev: String(1_700_000_000_000_000 + i),
    updatedAt: NOW,
  })),
};
/** 套餐里可换的那一样；厨房屏上合成的套餐那一张与它在水吧的子项单（8.1.17） */
const TEA_PART = '招牌手打香水柠檬茶（大杯）';
const COMBO_TICKET: KitchenItem = {
  id: 995_901,
  orderNo: 'K-SYN-8117',
  visitId: null,
  tagCode: 'A8060',
  zone: 'male',
  tableSessionId: null,
  tableName: null,
  guest: '合成客人',
  itemId: COMBO_DISH.id,
  name: COMBO_DISH.name,
  quantity: 1,
  note: `${TEA_PART}换杨枝甘露 +¥6`,
  deliverTo: '',
  parts: [
    { name: '宫保鸡丁', quantity: 1 },
    { name: '杨枝甘露', quantity: 2, from: TEA_PART },
  ],
  status: 'queued',
  stationId: 996_000,
  stationName: '热菜',
  rushCount: 0,
  createdAt: NOW,
  startedAt: null,
  doneAt: null,
  servedAt: null,
  postedByName: '林岚',
  visitClosed: false,
  orderNote: '',
  deliverRoom: '',
  partTickets: [{ id: 995_902, name: '杨枝甘露', quantity: 2, stationId: 996_002, stationName: '水吧', status: 'cooking' }],
};
const COMBO_PART: KitchenPartItem = {
  id: 995_902,
  kitchenItemId: COMBO_TICKET.id,
  orderNo: 'K-SYN-8117',
  comboName: COMBO_DISH.name,
  name: '杨枝甘露',
  swappedFrom: TEA_PART,
  quantity: 2,
  stationId: 996_002,
  stationName: '水吧',
  status: 'cooking',
  tagCode: 'A8060',
  tableName: null,
  guest: '合成客人',
  note: `${TEA_PART}换杨枝甘露 +¥6`,
  orderNote: '',
  createdAt: NOW,
  startedAt: NOW,
  doneAt: null,
  visitClosed: false,
};
const PRICE_CHANGES: DishPriceChange[] = [
  { id: 3, itemId: SPICY.id, itemName: SPICY.name, tier: 'standard', oldPrice: 5_800, newPrice: 6_800, reason: '食材涨价', source: 'dishes', staffName: '林岚', createdAt: ago(60) },
  { id: 2, itemId: COMBO_DISH.id, itemName: COMBO_DISH.name, tier: 'premium', oldPrice: null, newPrice: 10_800, reason: '新加一档整只的', source: 'import', staffName: '林岚', createdAt: ago(600) },
  { id: 1, itemId: SPICY.id, itemName: SPICY.name, tier: 'standard', oldPrice: null, newPrice: 5_800, reason: '新建菜品', source: 'dishes', staffName: null, createdAt: ago(6000) },
];

/** 菜单、厨房看板里的菜，桌台看板、这一桌的详情、点菜单换成合成数据（只读，不碰库里的菜与桌台） */
async function mockTables(ctx: BrowserContext) {
  // 菜品管理（8.1.15）：菜品表与改价记录用合成的
  await ctx.route('**/api/dining/dishes', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: DISH_BOARD }) : route.fallback()));
  await ctx.route('**/api/dining/dishes/price-changes*', (route) => route.fulfill({ json: PRICE_CHANGES }));
  // 菜单与厨房看板：取真的（规则、营业日、档口、出品单照旧），只把菜换成合成的
  await ctx.route('**/api/dining/menu', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...((await res.json()) as DiningMenu), dishes: MENU_DISHES } });
  });
  await ctx.route('**/api/kitchen', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const real = (await res.json()) as KitchenBoard;
    // 8.1.17：再加一张合成的套餐（带别的档口的进度）与它在水吧的子项单
    await route.fulfill({ response: res, json: { ...real, dishes: MENU_DISHES, items: [COMBO_TICKET, ...real.items], parts: [COMBO_PART, ...(real.parts ?? [])] } });
  });
  await ctx.route('**/api/dining/tables', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: BOARD }) : route.fallback()));
  await ctx.route(`**/api/dining/tables/sessions/${SID}`, (route) => route.fulfill({ json: DETAIL }));
  await ctx.route('**/api/dining/receipt?*', (route) => route.fulfill({ json: RECEIPT }));
}

// ───────────── 合成的钟房与技师管理（8.1.16 块 E）：八位技师各种状态（名字、花名、组别有长有短），在钟上与待上钟的各一张钟单，
// 叫号记录与主播报终端（就是这台：音量、静音、重播、试音、放下几个按钮都在，最宽的样子）；四个页签的名册、组别、班次与排班、休假单 ─────────────

const TODAY = NOW.slice(0, 10);
const plusDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ANNOUNCER_CLIENT = 'e2e-device-announcer';
const tech = (id: number, techNo: string, name: string, extra: Partial<BoardTechnician> = {}): BoardTechnician => ({
  id,
  techNo,
  name,
  gender: 'female',
  grade: 'standard',
  skills: [],
  active: true,
  sortOrder: id,
  note: '',
  isSynthetic: false,
  suspendedAt: null,
  suspendedReason: null,
  nickname: '',
  kind: '足浴',
  hiredOn: '2025-03-01',
  leftOn: null,
  groupId: null,
  state: 'off',
  position: null,
  busy: null,
  waiting: 0,
  todayClocks: 0,
  rejectStreak: 0,
  groupName: null,
  shiftToday: null,
  restToday: false,
  approvedLeave: null,
  ...extra,
});
const EARLY = { id: 990_401, name: '早班（含午休）', startMinute: 600, endMinute: 1080 };
const LATE = { id: 990_402, name: '晚班', startMinute: 1080, endMinute: 120 };
const TECH_GROUP = '足浴一组（白班）';
const BOARD_TECHS: BoardTechnician[] = [
  tech(990_201, '08', '欧阳晓晓', {
    nickname: '晓晓',
    kind: 'SPA',
    skills: ['足疗', 'SPA 精油', '采耳'],
    state: 'on',
    position: 1,
    busy: { sessionId: 990_301, status: 'serving' },
    todayClocks: 3,
    groupId: 990_451,
    groupName: TECH_GROUP,
    shiftToday: EARLY,
  }),
  tech(990_202, '12', '司马长青', { kind: '按摩', gender: 'male', grade: 'premium', state: 'on', position: 2, busy: { sessionId: 990_302, status: 'waiting' }, rejectStreak: 2, shiftToday: LATE }),
  tech(990_203, '15', '林', { state: 'on', position: 3, todayClocks: 1, groupId: 990_451, groupName: TECH_GROUP }),
  tech(990_204, '21', '张小明', { nickname: '小雅', state: 'rest', todayClocks: 2 }),
  tech(990_205, '23', '上官婉儿', { kind: 'SPA', state: 'leave', approvedLeave: { id: 990_551, fromDate: TODAY, toDate: plusDays(TODAY, 2), leaveType: 'personal' } }),
  tech(990_206, '30', '慕容复', { gender: 'male', suspendedAt: ago(90), suspendedReason: '客诉待处理，等店长复核' }),
  tech(990_207, '31', '王强', { nickname: '阿强', gender: 'male', restToday: true }),
  tech(990_208, 'A12', '诸葛青', { kind: '采耳', skills: ['采耳'] }),
];
type ClockSession = ClockroomBoard['sessions'][number];
const clockSession = (id: number, techIndex: number, over: Partial<ClockSession>): ClockSession => ({
  id,
  sessionNo: `ZS${TODAY.replaceAll('-', '')}-${String(id % 1000).padStart(4, '0')}`,
  technicianId: BOARD_TECHS[techIndex]!.id,
  techNo: BOARD_TECHS[techIndex]!.techNo,
  techName: BOARD_TECHS[techIndex]!.name,
  visitId: 990_501,
  tagCode: 'F018',
  zone: 'female',
  guest: '王女士（会员 L3 · 同行三位）',
  itemId: 990_601,
  itemName: '泰式精油推拿（全身 · 加热石）',
  callType: 'designated',
  clocks: 2,
  minutes: 120,
  status: 'waiting',
  createdAt: ago(40),
  startedAt: null,
  plannedEnd: null,
  space: null,
  spaceVersion: 0,
  ...over,
});
const CLOCK_BOARD: ClockroomBoard = {
  serverTime: NOW,
  businessDate: TODAY,
  rules: DEFAULT_CLOCKROOM_RULES,
  techRules: { ...DEFAULT_TECHNICIAN_RULES, enabled: true },
  technicians: BOARD_TECHS,
  sessions: [
    clockSession(990_301, 0, {
      status: 'serving',
      startedAt: ago(35),
      plannedEnd: new Date(Date.now() + 85 * 60_000).toISOString(),
      space: { id: 990_701, code: 'A201', displayName: '观澜 SPA 双人房' },
      spaceVersion: 1,
    }),
    clockSession(990_302, 1, { callType: 'rotation', clocks: 1, minutes: 60, tagCode: 'M106', zone: 'male', guest: '散客' }),
  ],
  pending: [
    {
      lineId: 990_801,
      visitId: 990_502,
      tagCode: 'F021',
      zone: 'female',
      guest: '李女士',
      itemId: 990_602,
      itemName: '中式足疗（60 分钟）',
      tier: null,
      quantity: 1,
      amount: 19_800,
      postedAt: ago(5),
      postedByName: '小周',
    },
  ],
  today: { clocks: 12, designated: 5, rotation: 7 },
  kinds: ['足浴', '按摩', 'SPA', '采耳', '其他'],
  categories: ['足疗', 'SPA 精油', '采耳', '头疗'],
  calls: [{ id: 990_901, at: ago(3), kind: 'dispatch', technicianId: 990_201, sessionId: 990_301, text: '请 1 号排位，08 号 晓晓，到 A201 观澜 SPA 双人房', staffName: '小周' }],
  announcer: { clientId: ANNOUNCER_CLIENT, label: '前台收银机（主播报）', claimedByName: '林岚', claimedAt: ago(60), seenAt: NOW },
};
const ROSTER: RosterTechnician[] = BOARD_TECHS.map(({ state: _s, position: _p, busy: _b, waiting: _w, todayClocks: _t, rejectStreak: _r, approvedLeave, ...t }) => ({
  ...t,
  leaveToday: approvedLeave,
}));
const TECH_VIEW: TechnicianAdminView = {
  businessDate: TODAY,
  canManage: true,
  kinds: CLOCK_BOARD.kinds,
  categories: CLOCK_BOARD.categories,
  technicians: ROSTER,
  groups: [
    { id: 990_451, name: TECH_GROUP, leaderId: 990_201, sortOrder: 0, active: true, note: '白班主力，带新人', memberIds: [990_201, 990_203] },
    { id: 990_452, name: '按摩组', leaderId: null, sortOrder: 1, active: true, note: '', memberIds: [] },
  ],
  shifts: [
    { ...EARLY, sortOrder: 0, active: true },
    { ...LATE, sortOrder: 1, active: true },
  ],
  pendingLeaves: 1,
};
const LEAVE_PENDING = 990_552;
const techLeave = (id: number, techIndex: number, over: Partial<TechLeave>): TechLeave => ({
  id,
  technicianId: BOARD_TECHS[techIndex]!.id,
  techNo: BOARD_TECHS[techIndex]!.techNo,
  techName: BOARD_TECHS[techIndex]!.name,
  nickname: BOARD_TECHS[techIndex]!.nickname,
  fromDate: TODAY,
  toDate: TODAY,
  days: 1,
  leaveType: 'personal',
  reason: '家里有事',
  status: 'pending',
  appliedByName: '小周',
  appliedAt: ago(120),
  decidedByName: null,
  decidedAt: null,
  decisionNote: '',
  cancelledByName: null,
  cancelledAt: null,
  cancelReason: '',
  ...over,
});
const LEAVES: TechLeave[] = [
  techLeave(LEAVE_PENDING, 3, { fromDate: plusDays(TODAY, 3), toDate: plusDays(TODAY, 9), days: 7, leaveType: 'annual', reason: '回老家参加表姐的婚礼，顺便陪父母住几天' }),
  techLeave(990_551, 4, { toDate: plusDays(TODAY, 2), days: 3, status: 'approved', decidedByName: '林岚', decidedAt: ago(100), decisionNote: '同意，记得交接熟客' }),
  techLeave(990_550, 6, { status: 'rejected', leaveType: 'sick', reason: '感冒', decidedByName: '林岚', decidedAt: ago(500), decisionNote: '那天人手不够，改到下周' }),
];
/** 排班表：从地址里的 from 起 7 天，早班、晚班、排休都有；改动记录两条（对调一条、排班一条） */
function scheduleOf(from: string): ScheduleView {
  const days = Array.from({ length: 7 }, (_, i) => plusDays(from, i));
  return {
    from,
    days: 7,
    today: TODAY,
    cells: days.flatMap((date, i) => [
      { technicianId: 990_201, date, shiftId: i % 3 === 2 ? null : EARLY.id, rest: i % 3 === 2 },
      { technicianId: 990_202, date, shiftId: LATE.id, rest: false },
      { technicianId: 990_203, date, shiftId: i % 2 ? EARLY.id : null, rest: false },
    ]),
    leaves: [{ technicianId: 990_205, fromDate: TODAY, toDate: plusDays(TODAY, 2), status: 'approved' }],
    changes: [
      {
        id: 2,
        at: ago(30),
        kind: 'swap',
        technicianId: 990_202,
        techNo: '12',
        techName: '司马长青',
        date: days[1]!,
        from: '晚班',
        to: '早班（含午休）',
        swapWith: '08 号 欧阳晓晓',
        reason: '两人换班照顾家里',
        staffName: '林岚',
      },
      {
        id: 1,
        at: ago(300),
        kind: 'plan',
        technicianId: 990_201,
        techNo: '08',
        techName: '欧阳晓晓',
        date: days[0]!,
        from: '没排',
        to: '早班（含午休）',
        swapWith: null,
        reason: '',
        staffName: '林岚',
      },
    ],
  };
}

/** 钟房看板（主播报终端的报到、登记也回合成的，免得回来的真看板把它盖掉）与技师管理的几样换成合成数据（只读） */
async function mockTechnicians(ctx: BrowserContext) {
  await ctx.route('**/api/clockroom', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: CLOCK_BOARD }) : route.fallback()));
  await ctx.route('**/api/clockroom/announcer', (route) => route.fulfill({ json: CLOCK_BOARD }));
  await ctx.route('**/api/technician-admin', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: TECH_VIEW }) : route.fallback()));
  await ctx.route('**/api/technician-admin/schedule?*', (route) => route.fulfill({ json: scheduleOf(new URL(route.request().url()).searchParams.get('from') ?? TODAY) }));
  await ctx.route('**/api/technician-admin/leaves*', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: LEAVES }) : route.fallback()));
}

// ───────────── 会员详情（8.1.16 块 F）：取真的演示会员，把卡类型、推荐人、偏好项目、会员卡与押金换成最长的样子（只读） ─────────────

const DETAIL_CARDS = (memberId: number): MemberCard[] => [
  { id: 990_951, cardNo: 'YZC0088123456', memberId, status: 'active', issuedAt: ago(200), issuedByName: '小周', replacesId: 990_950, note: '', endedAt: null, endedByName: null, endReason: null },
  {
    id: 990_950,
    cardNo: 'YZC0088000001',
    memberId,
    status: 'lost',
    issuedAt: ago(900),
    issuedByName: '林岚',
    replacesId: null,
    note: '',
    endedAt: ago(300),
    endedByName: '林岚',
    endReason: '客人说卡丢在停车场了',
  },
];
const DETAIL_DEPOSITS: MemberCardDeposits = {
  held: 2_000,
  rows: [
    {
      id: 990_961,
      docNo: `KY${TODAY.replaceAll('-', '')}-0001`,
      kind: 'receive',
      method: 'cash',
      amount: 2_000,
      ref: '',
      reason: null,
      cardNo: 'YZC0088000001',
      operatorName: '小周',
      businessDate: TODAY,
      createdAt: ago(900),
    },
  ],
};

// ───────────── 合成的需求单（8.1.10）：一张待核库（领用、能换算与换算不了的行、手填新品），一张等部门确认替代 ─────────────

const STOCK_ID = 990_810;
const SUB_ID = 990_811;
const STOCK_NOW = new Date().toISOString();
const reqLine = (id: number, lineNo: number, over: Record<string, unknown>) => ({
  id,
  lineNo,
  materialId: 990_000 + lineNo,
  materialName: '一次性护理床单（加厚加长款）',
  name: '一次性护理床单（加厚加长款）',
  purpose: '客用消耗',
  qtyMilli: 3000,
  unit: '箱',
  link: '',
  details: '',
  refPriceCents: null,
  note: '',
  images: [],
  progress: { po: null, orderedMilli: 0, receivedMilli: 0, returnedMilli: 0, inventoryUnit: null, mergedLines: 0, sourcing: null, state: 'none' },
  applicant: '',
  channel: null,
  supplier: null,
  stock: null,
  centralStock: { stockMilli: 1_250_000, inventoryUnit: '张', purchaseUnit: '箱', factorMilli: 500_000, convertible: true, lineQtyMilli: 2500 },
  ...over,
});
const stockRequest = (id: number, over: Record<string, unknown>) => ({
  id,
  docNo: `XQ20261118-${id}`,
  status: 'submitted',
  deptConfirm: { state: 'none', head: null, confirmedByName: null, confirmedAt: null },
  stockCheck: 'pending',
  stockCheckSince: STOCK_NOW,
  department: { id: 1, name: '客房部（合成）' },
  requester: { id: 1, name: '前厅阿美' },
  needBy: null,
  createdAt: STOCK_NOW,
  priority: 'normal',
  submittedAt: STOCK_NOW,
  approvableOn: null,
  lockedToday: false,
  source: 'form',
  lineCount: 3,
  summary: '一次性护理床单、洗手液、香薰石',
  orderedLines: 0,
  receivedLines: 0,
  canDeptConfirm: false,
  canStockCheck: true,
  canAnswerSubstitute: false,
  stockCheckedByName: null,
  stockCheckedAt: null,
  note: '',
  reviewedByName: null,
  reviewedAt: null,
  reason: null,
  isSynthetic: true,
  approvals: [],
  ...over,
});
const STOCK_REQUEST = stockRequest(STOCK_ID, {
  lines: [
    reqLine(9_908_101, 1, {}),
    reqLine(9_908_102, 2, {
      materialName: '洗手液（大瓶）',
      name: '洗手液（按盒）',
      qtyMilli: 2000,
      unit: '盒',
      centralStock: { stockMilli: 40_000, inventoryUnit: '瓶', purchaseUnit: '瓶', factorMilli: 1000, convertible: false, lineQtyMilli: null },
    }),
    reqLine(9_908_103, 3, { materialId: null, materialName: null, name: '香薰石', qtyMilli: 10_000, unit: '个', link: 'https://example.com/x', centralStock: null }),
  ],
});
const SUB_REQUEST = stockRequest(SUB_ID, {
  stockCheck: 'confirming',
  canStockCheck: false,
  canAnswerSubstitute: true,
  stockCheckedByName: '李晓（物资）',
  stockCheckedAt: STOCK_NOW,
  lineCount: 1,
  lines: [
    reqLine(9_908_111, 1, {
      stock: {
        decision: 'substitute',
        issuedQtyMilli: 0,
        substitute: { materialId: 990_101, materialName: '一次性护理床单（普通款）', qtyMilli: 1_500_000, unit: '张', state: 'pending' },
        issueDoc: null,
        decidedByName: '李晓（物资）',
        decidedAt: STOCK_NOW,
        answeredByName: null,
      },
    }),
  ],
});

async function mockRequests(ctx: BrowserContext) {
  await ctx.route(`**/api/erp/requests/${STOCK_ID}`, (route) => route.fulfill({ json: STOCK_REQUEST }));
  await ctx.route(`**/api/erp/requests/${SUB_ID}`, (route) => route.fulfill({ json: SUB_REQUEST }));
  await ctx.route('**/api/erp/requests/stock-materials', (route) =>
    route.fulfill({
      json: [
        { id: 990_101, code: 'M990101', name: '一次性护理床单（普通款）', specification: '180 × 220 cm', inventoryUnit: '张', decimals: 0, stockMilli: 3_000_000 },
        { id: 990_102, code: 'M990102', name: '洗手液（小瓶）', specification: '', inventoryUnit: '瓶', decimals: 0, stockMilli: 60_000 },
      ],
    }),
  );
}

async function openDevice(browser: Browser, baseURL: string, d: Device) {
  const ctx = await browser.newContext({ baseURL, viewport: d.viewport, hasTouch: true, isMobile: !!d.mobile, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await mockTables(ctx);
  await mockRequests(ctx);
  await mockTechnicians(ctx);
  const page = await ctx.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
  return { ctx, page };
}

/** 这些按钮整个在屏幕里（不用横着滑就点得到） */
async function expectOnScreen(page: Page, testIds: string[]) {
  const vw = page.viewportSize()!.width;
  for (const id of testIds) {
    const box = (await page.getByTestId(id).first().boundingBox())!;
    expect(box, id).not.toBeNull();
    expect(box.x, id).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, id).toBeLessThanOrEqual(vw + 1);
  }
}

/** 点菜单里的菜名不被挤成一列一两个字：每个菜名至少五个字宽 */
async function expectReceiptNamesReadable(page: Page) {
  const widths = await page
    .getByTestId('dining-receipt-paper')
    .locator('li[data-state] p:first-child')
    .evaluateAll((els) => els.map((el) => ({ text: el.textContent ?? '', width: el.getBoundingClientRect().width, size: parseFloat(getComputedStyle(el).fontSize) })));
  expect(widths.length).toBeGreaterThan(0);
  for (const w of widths) expect(w.width, `「${w.text}」的宽度`).toBeGreaterThanOrEqual(Math.min(5, w.text.length) * w.size - 1);
}

// ───────────── 合成数据：房态中心（8.1.16）——SPA 房五种状态各一间（在用那间两位客人、名字长）、派对房一间在用、大厅一间空闲 ─────────────

const RC_CAT = { spa: 'c990001', party: 'c990002', hall: 'c990003' } as const;
const rcGuest = (visitId: number, tagCode: string, guest: string, techNo: string, techName: string): RoomGuestView => ({
  registrationId: visitId,
  visitId,
  tagCode,
  guest,
  memberGradeLabel: 'L3 观澜',
  sellerNo: 'xiaozhou',
  sellerName: '小周',
  note: '客人要靠窗、水温高一点',
  since: ago(35),
  sessions: [
    {
      id: visitId,
      sessionNo: `JZ-${visitId}`,
      visitId,
      technicianId: visitId,
      techNo,
      techName,
      itemId: 1,
      itemName: '足底按摩（经典 90 分钟）',
      callType: 'designated',
      clocks: 2,
      minutes: 180,
      status: 'serving',
      startedAt: ago(35),
      plannedEnd: new Date(Date.now() + 145 * 60_000).toISOString(),
      endedAt: null,
      amount: 39600,
      unitPrice: 19800,
    },
  ],
  amount: 39600,
  billAmount: 52800,
});
const rcRoom = (spaceId: number, code: string, categoryKey: string, kind: RoomCard['kind'], status: RoomCard['status'], extra: Partial<RoomCard> = {}): RoomCard => ({
  key: `s${spaceId}`,
  categoryKey,
  kind,
  spaceId,
  code,
  name: `合成${code}`,
  floor: 'L3',
  businessType: kind === 'service' ? 'SPA' : kind === 'party' ? '派对房' : '休息大厅',
  capacity: 2,
  status,
  version: 1,
  guests: [],
  usage: null,
  usagePriced: kind === 'party',
  hotel: null,
  maintenance: null,
  dirtySince: null,
  dirtyNote: '',
  booking: null,
  merged: [],
  guestText: null,
  techText: null,
  since: null,
  amount: null,
  phase: null,
  plannedEnd: null,
  ...extra,
});
const RC_GUESTS = [rcGuest(990_801, 'A023', '欧阳慕容雪晴（长名字的会员）', '18', '技师小林'), rcGuest(990_802, 'B105', '王先生', '23', '技师阿秀')];
const RC_ROOMS: RoomCard[] = [
  rcRoom(990_701, 'S9901', RC_CAT.spa, 'service', 'free'),
  rcRoom(990_702, 'S9902', RC_CAT.spa, 'service', 'in_use', {
    guests: RC_GUESTS,
    guestText: RC_GUESTS.map((g) => g.guest).join('、'),
    techText: '18 号 技师小林、23 号 技师阿秀',
    since: ago(35),
    amount: 79200,
    phase: 'serving',
    plannedEnd: new Date(Date.now() + 145 * 60_000).toISOString(),
  }),
  rcRoom(990_703, 'S9903', RC_CAT.spa, 'service', 'dirty', { dirtySince: ago(12), dirtyNote: '换房换到 S9902' }),
  rcRoom(990_704, 'S9904', RC_CAT.spa, 'service', 'maintenance', {
    maintenance: { reason: '空调漏水，等配件到了再修', expectedAt: new Date(Date.now() + 26 * 3_600_000).toISOString(), at: ago(60), byName: '后勤小周' },
  }),
  rcRoom(990_705, 'S9905', RC_CAT.spa, 'service', 'booked', {
    booking: {
      id: 990_901,
      bookingNo: 'YY-990901',
      guest: '电话客人',
      guests: 2,
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    },
  }),
  rcRoom(990_706, 'P9901', RC_CAT.party, 'party', 'in_use', { guestText: '手牌 A066 · 8 人', since: ago(80) }),
  rcRoom(990_707, 'H9901', RC_CAT.hall, 'hall', 'free', { capacity: 40 }),
];
const rcCounts = (list: RoomCard[]) => ({
  total: list.length,
  free: list.filter((r) => r.status === 'free').length,
  inUse: list.filter((r) => r.status === 'in_use').length,
  dirty: list.filter((r) => r.status === 'dirty').length,
  maintenance: list.filter((r) => r.status === 'maintenance').length,
  booked: list.filter((r) => r.status === 'booked').length,
});
const RC_BOARD: RoomCenterBoard = {
  serverTime: NOW,
  businessDate: NOW.slice(0, 10),
  categories: [
    { key: RC_CAT.spa, id: 990_001, name: 'SPA 房', source: 'service', counts: rcCounts(RC_ROOMS.filter((r) => r.categoryKey === RC_CAT.spa)), hint: null },
    { key: RC_CAT.party, id: 990_002, name: '派对房', source: 'party', counts: rcCounts(RC_ROOMS.filter((r) => r.categoryKey === RC_CAT.party)), hint: null },
    { key: RC_CAT.hall, id: 990_003, name: '休息大厅', source: 'hall', counts: rcCounts(RC_ROOMS.filter((r) => r.categoryKey === RC_CAT.hall)), hint: null },
  ],
  total: rcCounts(RC_ROOMS),
  rooms: RC_ROOMS,
};
const RC_HISTORY: RoomHistory = {
  spaceId: 990_702,
  code: 'S9902',
  name: '合成S9902',
  rows: [
    { key: 'e1', at: ago(10), label: '换房（换入）', text: '从 S9903 换来 · 手牌 A023 · 单与计时不变 · 空调不凉', staffName: '小周', kind: 'move_in' },
    { key: 'e2', at: ago(35), label: '登记', text: '手牌 A023 · 足底按摩（经典 90 分钟） × 2 · 18 号 技师小林（点钟） · 出单员 xiaozhou 小周 · ¥396.00', staffName: '小周', kind: 'register' },
  ],
};

const PAGES: Record<PageKey, (page: Page) => Promise<void>> = {
  // 8.1.16 房态中心（合成的看板）：总览、SPA 房页签（五种状态的卡片、各状态的数量）、在用房间的详情（两位客人、动作、历史）、空闲房间的登记对话框
  'room-center': async (page) => {
    await page.route('**/api/room-center', (route) => route.fulfill({ json: RC_BOARD }));
    await page.route('**/api/room-center/rooms/*/history', (route) => route.fulfill({ json: RC_HISTORY }));
    try {
      await page.goto('/room-center');
      await expect(page.getByTestId('rc-summary')).toBeVisible();
      await expectFits(page);
      await page.getByTestId(`rc-tab-${RC_CAT.spa}`).click();
      await expect(page.getByTestId('rc-room-S9905')).toHaveAttribute('data-status', 'booked');
      await expectFits(page);
      await expectOnScreen(page, ['rc-count-total', 'rc-count-maintenance', 'rc-open-S9901', 'rc-detail-S9901']);
      await page.getByTestId('rc-detail-S9902').click();
      await expect(page.getByTestId('rc-history')).toBeVisible();
      await expectFits(page);
      await expectOnScreen(page, ['rc-act-checkout', 'rc-act-move', 'rc-act-join']);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('rc-room-dialog')).toHaveCount(0);
      await page.getByTestId('rc-open-S9901').click();
      await expect(page.getByTestId('rc-register').or(page.getByText('技师没取回来'))).toBeVisible();
      await expectFits(page);
      await expectOnScreen(page, ['rc-register-submit']);
      await page.keyboard.press('Escape');
    } finally {
      await page.unroute('**/api/room-center');
      await page.unroute('**/api/room-center/rooms/*/history');
    }
  },
  // 8.1.10 核库：待核库页签；合成的需求单详情与核库对话框（三种行都有，选替代的一行）；等部门确认替代的那张
  'requests-stock': async (page) => {
    await page.goto('/erp/requests?view=stock');
    await expect(page.getByTestId('requests-page')).toBeVisible();
    await expectFits(page);
    await page.goto(`/erp/requests?request=${STOCK_ID}`);
    await expect(page.getByTestId('request-stock-pending')).toBeVisible();
    await expect(page.getByTestId('request-line-central-1')).toContainText('1,250 张');
    await expectFits(page);
    await page.getByTestId('request-stock-check').click();
    const dialog = page.getByTestId('stock-check-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('stock-line-2').getByRole('radio', { name: '替代' }).click();
    await expect(dialog.getByTestId('stock-sub-material-2')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['stock-check-submit', 'stock-qty-1', 'stock-sub-material-2', 'stock-sub-qty-2']);
    await page.keyboard.press('Escape');
    await page.goto(`/erp/requests?request=${SUB_ID}`);
    await expect(page.getByTestId('request-substitute-1')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['request-substitute-yes-1', 'request-substitute-no-1']);
  },
  // 8.1.10 急采：「待补合同」一栏（五个页签在手持机上自己横着滑）
  'urgent-contract': async (page) => {
    await page.goto('/purchasing/urgent?view=contract');
    await expect(page.getByTestId('urgent-contract-due').or(page.getByText('没有要补合同的急采'))).toBeVisible();
    await expectFits(page);
  },
  // 8.1.9 零采备用金（总额没配置时顶上有提示，照样不横向滚动）
  pool: async (page) => {
    await page.goto('/erp/pool');
    await expect(page.getByTestId('pool-page')).toBeVisible();
    await expectFits(page);
  },
  // 8.1.9 库管入库：不选采购单的收货表单
  'direct-receipt': async (page) => {
    await page.goto('/inventory/direct/new');
    await expect(page.getByRole('heading', { name: /库管入库/ })).toBeVisible();
    await expectFits(page);
  },
  // 8.1.9 签赠：后台知识库
  'admin-gifts': async (page) => {
    await page.goto('/admin/gifts/types');
    await expect(page.getByTestId('gift-types')).toBeVisible();
    await expectFits(page);
  },
  // 8.1.9 签赠台账：管家部、客户部（日期两格在手机上各占一行，「签赠发放」在屏幕里）
  'gift-ledger-concierge': async (page) => {
    await page.goto('/concierge/gifts');
    await expect(page.getByTestId('concierge-gift-ledger')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('gift-totals').or(page.getByTestId('gift-ledger-failed'))).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['gift-issue', 'gift-from', 'gift-to']);
  },
  'gift-ledger-customer': async (page) => {
    await page.goto('/customer?tab=gifts');
    await expect(page.getByTestId('customer-gift-ledger')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('gift-totals').or(page.getByTestId('gift-ledger-failed'))).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['gift-issue', 'gift-from', 'gift-to']);
  },
  // 发卡台（8.1.15，原「前台」）：手牌板；点一张在店的手牌，客人卡上的加项目、换牌、去收银台都在屏幕里
  frontdesk: async (page) => {
    await page.goto('/frontdesk');
    await expect(page.getByTestId('tag-board')).toBeVisible();
    await expectFits(page);
    await page.locator('[data-testid^="tag-"][data-state="in_use"]').first().click();
    await expect(page.getByTestId('bill-panel')).toHaveAttribute('data-desk', 'issue');
    await expectFits(page);
    await expectOnScreen(page, ['action-add', 'action-swap', 'go-cashier']);
  },
  // 收银台（8.1.15）：查找框、排序、待结账清单；点第一张手牌，账单上的预结账、结账在屏幕里
  cashier: async (page) => {
    await page.goto('/cashier');
    await expect(page.getByTestId('cashier-queue')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['tag-search', 'queue-sort']);
    await page.getByTestId('cashier-queue').locator('button[data-testid^="queue-"]').first().click();
    await expect(page.getByTestId('bill-panel')).toHaveAttribute('data-desk', 'cashier');
    await expectFits(page);
    await expectOnScreen(page, ['action-preview', 'action-checkout']);
  },
  shift: async (page) => {
    await page.goto('/shift');
    await expect(page.getByRole('heading', { name: '交班', exact: true })).toBeVisible();
    await expectFits(page);
  },
  workbench: async (page) => {
    // 会员工作台是首页
    await page.goto('/');
    await expect(page.getByTestId('workbench-coupon-issue')).toBeVisible();
    await expectFits(page);
  },
  // 点单：三个入口 → 选水吧（小分类一排）→ 换果吧
  'dining-order': async (page) => {
    await page.goto('/dining/order');
    await expect(page.getByTestId('dining-outlets')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['dining-outlet-restaurant', 'dining-outlet-water', 'dining-outlet-fruit']);
    await page.getByTestId('dining-outlet-water').click();
    await expect(page.getByTestId('dining-group-all')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['dining-outlet-restaurant', 'dining-outlet-water', 'dining-outlet-fruit', 'dining-outlet-back']);
    await page.getByTestId('dining-outlet-fruit').click();
    await expect(page.getByTestId('dining-group-all')).toHaveCount(0);
    await expectFits(page);
  },
  // 点菜单：从桌台进点单页，「还没上的菜」旁打开
  'dining-receipt': async (page) => {
    await page.goto(`/dining/order?table=${SID}`);
    await expect(page.getByTestId('dining-table-selected')).toContainText('观澜厅');
    await expectOnScreen(page, ['dining-receipt-open']);
    await page.getByTestId('dining-receipt-open').click();
    await expect(page.getByTestId('dining-receipt-paper')).toBeVisible();
    await expect(page.getByTestId('dining-receipt-title')).toContainText('景观包厢');
    await expectFits(page);
    await expectOnScreen(page, ['dining-receipt-only-waiting', ...RECEIPT.orders.flatMap((o) => o.lines.map((l) => `dining-receipt-state-${l.billLineId}`))]);
    await expectReceiptNamesReadable(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dining-receipt')).toHaveCount(0);
  },
  // 桌台：分区卡片 → 景观包厢的详情 → 这一桌 → 点菜单
  'dining-tables': async (page) => {
    await page.goto('/dining/tables');
    await expect(page.getByTestId('table-zones')).toBeVisible();
    await expectFits(page);
    // 8.1.15：维修中的桌——格子上写维修中，点开看得到「恢复」「历史」
    await expect(page.getByTestId('table-tile-F1')).toContainText('维修中');
    await page.getByTestId('table-tile-F1').click();
    await expect(page.getByTestId('table-state')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['table-restore', 'table-history-open']);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('table-state')).toHaveCount(0);
    await page.getByTestId('table-zone-景观包厢').click();
    await expect(page.getByTestId('table-zone-detail')).toContainText('景观包厢');
    await expectFits(page);
    await expectOnScreen(page, ['table-tile-观澜厅']);
    await page.getByTestId('table-tile-观澜厅').click();
    await expect(page.getByTestId('table-session')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['table-receipt', 'table-order', 'table-checkout']);
    await page.getByTestId('table-receipt').click();
    await expect(page.getByTestId('dining-receipt-paper')).toBeVisible();
    await expectFits(page);
    await expectReceiptNamesReadable(page);
  },
  'dining-kitchen': async (page) => {
    await page.goto('/dining/kitchen');
    await expect(page.getByTestId('kitchen')).toBeVisible();
    // 8.1.17：套餐在水吧做的一样单独一张子项单；套餐那一张写着它做到哪了
    await expect(page.getByTestId(`kds-part-${COMBO_PART.id}`)).toContainText(`套餐「${COMBO_DISH.name}」里的`);
    await expect(page.getByTestId(`kds-part-tickets-${COMBO_TICKET.id}`)).toContainText('杨枝甘露×2');
    await expectFits(page);
  },
  'dining-limits': async (page) => {
    await page.goto('/dining/limits');
    await expect(page.getByTestId('limits-group-餐厅 · 餐饮')).toBeVisible();
    await expectFits(page);
    await page.getByTestId('limits-outlet-water').click();
    await expect(page.getByTestId('limits-group-水吧 · 调酒')).toBeVisible();
    await expectFits(page);
  },
  'dining-ledger': async (page) => {
    await page.goto('/dining/ledger');
    await expect(page.getByTestId('dining-ledger-outlet-all')).toBeVisible();
    await page.getByTestId('dining-ledger-outlet-water').click();
    await expect(page.getByTestId('dining-ledger-group-all')).toBeVisible();
    await expectFits(page);
  },
  // 8.1.15：退菜记录并进台账，旧地址跳到台账的「退菜」
  'dining-voids': async (page) => {
    await page.goto('/dining/voids');
    await expect(page.getByTestId('dining-ledger-outlet-all')).toBeVisible();
    await expect(page.getByTestId('dining-ledger-type')).toBeVisible();
    await page.getByTestId('dining-ledger-outlet-fruit').click();
    await expectFits(page);
  },
  'admin-dining': async (page) => {
    await page.goto('/admin/dining/stations');
    await expect(page.getByTestId('dining-items')).toBeVisible();
    await expectFits(page);
    await page.goto('/admin/dining/tables');
    await expect(page.getByTestId('dining-tables')).toBeVisible();
    await expectFits(page);
  },
  // 8.1.15 菜品管理：菜品表（宽屏一张表、窄屏一道一张卡片），新增 / 编辑、改价（带改价记录）、导入三个弹窗
  'dining-dishes': async (page) => {
    await page.goto('/dining/dishes');
    await expect(page.getByTestId('dishes-list')).toBeVisible();
    await expect(page.getByTestId(`dish-row-${COMBO_DISH.name}`)).toContainText('套餐');
    await expectFits(page);
    await expectOnScreen(page, ['dishes-search', 'dishes-new', 'dishes-import', 'dishes-export', 'dishes-history', `dish-edit-${SPICY.name}`, `dish-price-${SPICY.name}`, `dish-toggle-${SPICY.name}`]);
    await expectOnScreen(page, [`dish-state-${COMBO_DISH.name}`, `dish-limit-${COMBO_DISH.name}`, `dish-price-text-${COMBO_DISH.name}`, `dish-toggle-${COMBO_DISH.name}`]);
    await page.getByTestId(`dish-edit-${SPICY.name}`).click();
    await expect(page.getByTestId('dish-editor')).toBeVisible();
    await expect(page.getByTestId('dish-methods')).toContainText('免香菜');
    await expectFits(page);
    await expectOnScreen(page, ['dish-save', 'dish-name', 'dish-slot', 'dish-station', 'dish-method-add', 'dish-addon-search']);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dish-editor')).toHaveCount(0);
    await page.getByTestId(`dish-price-${SPICY.name}`).click();
    await expect(page.getByTestId('dish-price-dialog')).toBeVisible();
    await expect(page.getByTestId('dish-price-history')).toContainText('食材涨价');
    await expectFits(page);
    await expectOnScreen(page, ['dish-price-save', 'dish-price-new-standard', 'dish-price-new-premium', 'dish-price-reason']);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dish-price-dialog')).toHaveCount(0);
    await page.getByTestId('dishes-import').click();
    await expect(page.getByTestId('dish-import')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['dish-import-preview', 'dish-import-apply']);
    await page.keyboard.press('Escape');
    // 8.1.17：套餐的一样标「可换」、能换成的菜与差价；排序弹窗；勾了几道出来的批量上下架
    await page.getByTestId(`dish-edit-${COMBO_DISH.name}`).click();
    await expect(page.getByTestId(`dish-combo-swaps-${TEA_PART}`)).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, [`dish-combo-swappable-${TEA_PART}`, `dish-combo-swap-diff-${TEA_PART}-杨枝甘露`]);
    await page.keyboard.press('Escape');
    await page.getByTestId('dishes-sort').click();
    await expect(page.getByTestId('dish-sort')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['dish-sort-slot', 'dish-sort-save']);
    await page.keyboard.press('Escape');
    await page.getByTestId(`dish-select-${SPICY.name}`).check();
    await expect(page.getByTestId('dishes-bulk')).toContainText('已选 1 道');
    await expectFits(page);
    await expectOnScreen(page, ['dishes-bulk-on', 'dishes-bulk-off', 'dishes-bulk-clear']);
    await page.getByTestId('dishes-bulk-clear').click();
  },
  // 8.1.15 点单时选做法、加料：菜单上写着「可选做法、加料」「含 …」；点开弹窗，选一种做法、加一种料，「加入已点」在屏幕里
  'dining-dish-options': async (page) => {
    await page.goto('/dining/order');
    await page.getByTestId('dining-outlet-restaurant').click();
    await expect(page.getByTestId(`dining-dish-${SPICY.name}`)).toContainText('可选做法、加料');
    await expect(page.getByTestId(`dining-dish-${COMBO_DISH.name}`)).toContainText('含 宫保鸡丁×1');
    await expectFits(page);
    await page.getByTestId(`dining-dish-${SPICY.name}`).click();
    await expect(page.getByTestId('dish-options')).toBeVisible();
    await page.getByTestId('dish-options-method-微辣').click();
    await page.getByTestId('dish-options-addon-add-宫保鸡丁').click();
    await expectFits(page);
    await expectOnScreen(page, ['dish-options-add', 'dish-options-note', 'dish-options-qty', 'dish-options-method-免香菜', 'dish-options-addon-qty-宫保鸡丁']);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dish-options')).toHaveCount(0);
    // 8.1.17：套餐里可换的一样（柠檬茶换杨枝甘露，每份补 ¥6）
    await page.getByTestId(`dining-dish-${COMBO_DISH.name}`).click();
    await expect(page.getByTestId('dish-options')).toBeVisible();
    await page.getByTestId(`dish-options-swap-${TEA_PART}-杨枝甘露`).click();
    await expectFits(page);
    await expectOnScreen(page, ['dish-options-add', `dish-options-swap-${TEA_PART}-杨枝甘露`, 'dish-options-qty']);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dish-options')).toHaveCount(0);
  },
  // 8.1.16 钟房：轮钟排队、在钟上与待上钟的钟单；展开类型、项目两排筛选；按状态排的技师卡片。
  // 8.2.0 P03：排位播报移到了单独的页面（这台是主播报终端，播报条上按钮最多），最后看那一页
  clockroom: async (page) => {
    await page.evaluate((id) => localStorage.setItem('yuzu.clock.announcer.client', id), ANNOUNCER_CLIENT);
    await page.goto('/clockroom');
    await expect(page.getByTestId('announcer-bar')).toHaveCount(0);
    await expect(page.getByTestId('clock-queue')).toContainText('欧阳晓晓');
    await expectFits(page);
    await expectOnScreen(page, ['clock-dispatch', 'clock-search', 'clock-more-filters', 'clock-call-tech-15']);
    await page.getByTestId('clock-more-filters').click();
    await page.getByTestId('clock-kind-足浴').click();
    await page.getByTestId('clock-category-采耳').click();
    await expect(page.getByTestId('clock-active-filters')).toContainText('项目：采耳');
    await expectFits(page);
    await expectOnScreen(page, ['clock-filters-clear', 'clock-kind-SPA', 'clock-category-头疗']);
    await page.getByTestId('clock-filters-clear').click();
    await page.getByTestId('clock-sort-status').click();
    await expect(page.getByTestId('clock-tech-30')).toHaveAttribute('data-status', 'suspended');
    await expectFits(page);
    await expectOnScreen(page, ['clock-tech-call-15', 'clock-tech-rest-15', 'clock-tech-suspend-15', 'clock-tech-back-21']);
    await page.goto('/announcer');
    await expect(page.getByTestId('announcer-bar')).toHaveAttribute('data-announcer', 'on');
    await expectFits(page);
    await expectOnScreen(page, ['announcer-volume', 'announcer-mute', 'announcer-replay', 'announcer-test', 'announcer-release']);
  },
  // 8.1.16 技师管理：名册（与编辑技师的弹窗）、组别、班次与排班表（排班表在自己的框里左右滑；临时调班的弹窗）、休假（申请的弹窗）
  'technician-admin': async (page) => {
    await page.goto('/technicians/roster');
    await expect(page.getByTestId('tech-roster-08')).toContainText('晓晓');
    await expectFits(page);
    await expectOnScreen(page, ['tech-roster-search', 'tech-roster-new', 'tech-kinds-edit', 'tech-roster-edit-08', 'tech-roster-edit-A12']);
    await page.getByTestId('tech-roster-edit-08').click();
    await expect(page.getByTestId('technician-name')).toHaveValue('欧阳晓晓');
    await expectFits(page);
    await expectOnScreen(page, ['technician-save', 'technician-kind', 'technician-nickname', 'technician-hired']);
    await page.keyboard.press('Escape');
    await page.getByTestId('tech-tab-groups').click();
    await expect(page.getByTestId(`tech-group-${TECH_GROUP}`)).toContainText('组长');
    await expectFits(page);
    await expectOnScreen(page, ['tech-group-new', `tech-group-edit-${TECH_GROUP}`]);
    await page.getByTestId('tech-tab-shifts').click();
    await expect(page.getByTestId('tech-schedule-grid')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['tech-shift-new', 'tech-schedule-adjust', 'tech-schedule-next', 'tech-schedule-copy']);
    await page.getByTestId('tech-schedule-adjust').click();
    await expect(page.getByTestId('tech-cell-reason')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['tech-cell-save', 'tech-cell-tech', 'tech-cell-date', 'tech-cell-reason']);
    await page.keyboard.press('Escape');
    await page.getByTestId('tech-tab-leaves').click();
    await expect(page.getByTestId(`tech-leave-${LEAVE_PENDING}`)).toContainText('表姐的婚礼');
    await expectFits(page);
    await expectOnScreen(page, ['tech-leave-new', `tech-leave-approve-${LEAVE_PENDING}`, `tech-leave-reject-${LEAVE_PENDING}`]);
    await page.getByTestId('tech-leave-new').click();
    await expect(page.getByTestId('tech-leave-reason')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['tech-leave-save', 'tech-leave-tech', 'tech-leave-from', 'tech-leave-to']);
    await page.keyboard.press('Escape');
  },
  // 8.1.16 新建会员：第 1 步三种卡、第 2 步（实体卡：卡号、押金）不横向滚动，「建档」「上一步」在屏幕里（不提交）
  'member-create': async (page) => {
    await page.goto('/');
    await page.getByRole('button', { name: '新建会员' }).first().click();
    const dialog = page.getByRole('dialog').filter({ hasText: '新建会员' });
    await expect(dialog.getByTestId('member-card-type-step')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['card-type-ecard', 'card-type-physical', 'card-type-anonymous']);
    await dialog.getByTestId('card-type-physical').click();
    await expect(dialog.getByTestId('member-card-type-pinned')).toContainText('实体卡');
    await expectFits(page);
    await expectOnScreen(page, ['member-form-submit', 'member-form-back', 'member-card-no', 'member-card-type-change']);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  },
  // 8.1.16 会员详情：卡类型、推荐人、偏好项目一行；会员卡（在用、挂失）、押着的押金与押金记录；退卡的弹窗（不提交）
  'member-detail': async (page) => {
    const [m] = (await (await page.request.get('/api/members?limit=1')).json()) as { id: number }[];
    await page.route(`**/api/members/${m!.id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const res = await route.fetch();
      const real = (await res.json()) as Record<string, unknown>;
      await route.fulfill({
        response: res,
        json: {
          ...real,
          cardType: 'physical',
          referrer: { id: 1, memberNo: 'YZ01001', name: '林小满（老会员介绍来的）' },
          preferredItems: ['足疗', '汗蒸', '泰式精油推拿', '采耳', 'SPA 精油'],
          cardDepositHeld: 2_000,
        },
      });
    });
    await page.route(`**/api/members/${m!.id}/cards`, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: DETAIL_CARDS(m!.id) }) : route.fallback()));
    await page.route(`**/api/members/${m!.id}/card-deposits`, (route) => route.fulfill({ json: DETAIL_DEPOSITS }));
    await page.goto(`/?m=${m!.id}`);
    await expect(page.getByTestId('member-profile-extras')).toContainText('实体卡');
    await expect(page.getByTestId('member-preferred-items')).toContainText('泰式精油推拿');
    await expect(page.getByTestId('member-card-deposit-held')).toContainText('20.00');
    await expectFits(page);
    await expectOnScreen(page, ['member-referrer', 'member-card-YZC0088123456', 'member-card-replace-open', 'member-card-lost-YZC0088123456', 'member-card-return-open']);
    await page.getByTestId('member-card-return-open').click();
    await expect(page.getByTestId('member-card-return-reason')).toBeVisible();
    await expectFits(page);
    await expectOnScreen(page, ['member-card-return-submit', 'member-card-return-reason']);
    await page.keyboard.press('Escape');
  },
};

test.describe('三台目标设备（docs/DEVICES.md）', () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, '在门店电脑这一组里另开三台设备的窗口，只跑一次');
  test.setTimeout(300_000);

  test('商米 D3 Pro、商米 V3、小米平板 6S Pro 12.4：主要页面不横向滚动、按钮在屏幕里、菜名不被挤', async ({ page, browser, baseURL }) => {
    // 为了看到餐饮页面临时打开餐饮与桌台点单（不点单、不写业务数据），结束时恢复原样
    await page.goto('/login');
    await page.fill('#username', 'linlan');
    await page.fill('#password', PASSWORD);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
    const before = ((await (await page.request.get('/api/admin/dining')).json()) as { rules: { enabled: boolean; tablesEnabled: boolean } }).rules;
    const put = async (data: Record<string, boolean>) => expect((await page.request.put('/api/admin/dining/rules', { data })).ok()).toBe(true);
    if (!before.enabled || !before.tablesEnabled) await put({ enabled: true, tablesEnabled: true });
    // 8.1.16：钟房、技师管理要开着技师功能（看板与名册用合成的），结束时恢复
    const techBefore = ((await (await page.request.get('/api/admin/technicians')).json()) as { rules: { enabled: boolean } }).rules.enabled;
    const putTech = async (enabled: boolean) => expect((await page.request.put('/api/admin/technicians/rules', { data: { enabled } })).ok()).toBe(true);
    if (!techBefore) await putTech(true);
    try {
      for (const d of DEVICES) {
        const { ctx, page: p } = await openDevice(browser, baseURL!, d);
        try {
          for (const key of d.pages) await test.step(`${d.name} · ${key}`, () => PAGES[key](p));
        } finally {
          await ctx.close();
        }
      }
    } finally {
      if (!before.enabled || !before.tablesEnabled) await put({ enabled: before.enabled, tablesEnabled: before.tablesEnabled });
      if (!techBefore) await putTech(false);
    }
  });
});
