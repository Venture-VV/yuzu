// 三台目标设备（店主 2026-11-18，docs/DEVICES.md，AGENTS.md「目标设备」）：以后所有更新都要适配
//   商米 D3 Pro（台式收银机，15.6 英寸 1920 × 1080；系统缩放 1.5 倍时 1280 × 720）、
//   商米 V3（手持点单机，6.75 英寸 720 × 1600，网页约 360 × 800）、
//   小米平板 6S Pro 12.4（网页 1355 × 903 横屏）。
// 在门店电脑这一组里另开这几个窗口，逐页核对：不横向滚动、没有东西超出屏幕右边（有意左右滑的区域除外）、要点的按钮在屏幕里、
// 菜名不被挤成一列。只读：菜单里的菜、桌台页、桌台详情与点菜单用合成数据代替接口（CI 的浏览器验收各组用的是只灌了五套演示数据的新库，
// 里面没有进厨房的菜）；为了看到餐饮页面临时打开餐饮与桌台点单，结束时恢复原样。
// 依赖四套演示数据（仅独立演示库）；账号店主 linlan。新做的、改过的页面加到下面 PAGES 里。
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { DiningMenu, DiningReceipt, KitchenBoard, MenuDish, PendingDish, TableSessionDetail, TablesBoard } from '../src/shared/dining';
import type { BillLine } from '../src/shared/frontdesk';
import type { DishPriceChange, DishesBoard } from '../src/shared/dishes';
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
  | 'dining-dish-options';

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
    ],
  },
  {
    name: '商米 D3 Pro（系统缩放 1.5 倍）',
    viewport: { width: 1280, height: 720 },
    pages: ['frontdesk', 'cashier', 'dining-order', 'dining-receipt', 'dining-tables', 'dining-ledger', 'pool', 'gift-ledger-concierge', 'requests-stock', 'dining-dishes', 'dining-dish-options'],
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
COMBO_DISH.combo = [
  { name: '宫保鸡丁', quantity: 1 },
  { name: '招牌手打香水柠檬茶（大杯）', quantity: 2 },
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
    combo: (d.combo ?? []).map((c, k) => ({ itemId: MENU_DISHES[k === 0 ? 0 : 5]!.id, name: c.name, quantity: c.quantity, available: k === 0 })),
    usedBy: i === 0 ? ['「小炒黄牛肉」的加料', '套餐「招牌秘制酱香手撕鸡（半只）」'] : [],
    sort: null,
    deleted: false,
    rev: String(1_700_000_000_000_000 + i),
    updatedAt: NOW,
  })),
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
    await route.fulfill({ response: res, json: { ...((await res.json()) as KitchenBoard), dishes: MENU_DISHES } });
  });
  await ctx.route('**/api/dining/tables', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: BOARD }) : route.fallback()));
  await ctx.route(`**/api/dining/tables/sessions/${SID}`, (route) => route.fulfill({ json: DETAIL }));
  await ctx.route('**/api/dining/receipt?*', (route) => route.fulfill({ json: RECEIPT }));
}

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

const PAGES: Record<PageKey, (page: Page) => Promise<void>> = {
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
    }
  });
});
