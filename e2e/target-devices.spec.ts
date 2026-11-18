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
import { expectFits } from './fits';

const PASSWORD = 'yuzu2026';

interface Device {
  name: string;
  viewport: { width: number; height: number };
  mobile?: boolean;
  /** 这台设备上主要用的页面（docs/DEVICES.md 的「主要用在」） */
  pages: PageKey[];
}

type PageKey = 'frontdesk' | 'shift' | 'workbench' | 'dining-order' | 'dining-receipt' | 'dining-tables' | 'dining-kitchen' | 'dining-limits' | 'dining-ledger' | 'dining-voids' | 'admin-dining';

const DEVICES: Device[] = [
  {
    name: '商米 D3 Pro',
    viewport: { width: 1920, height: 1080 },
    pages: ['frontdesk', 'shift', 'workbench', 'dining-order', 'dining-receipt', 'dining-tables', 'dining-ledger', 'dining-voids', 'admin-dining'],
  },
  {
    name: '商米 D3 Pro（系统缩放 1.5 倍）',
    viewport: { width: 1280, height: 720 },
    pages: ['frontdesk', 'dining-order', 'dining-receipt', 'dining-tables', 'dining-ledger'],
  },
  {
    name: '商米 V3',
    viewport: { width: 360, height: 800 },
    mobile: true,
    pages: ['dining-order', 'dining-receipt', 'dining-tables', 'dining-kitchen', 'dining-limits'],
  },
  {
    name: '小米平板 6S Pro 12.4',
    viewport: { width: 1355, height: 903 },
    pages: ['frontdesk', 'dining-order', 'dining-receipt', 'dining-tables', 'dining-kitchen'],
  },
];

// ───────────── 合成数据：一桌用餐中的景观包厢、几张空桌（四个分区都有），点菜单五种状态都有、菜名有长有短 ─────────────

const SID = 990_001;
const NOW = new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const free = (id: number, name: string, area: string, seats: number) => ({ id, name, area, seats, sortOrder: id, active: true, session: null });
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
      },
    },
    free(990_104, '听松阁', '景观包厢', 8),
    free(990_105, 'W1', '休闲水吧区', 2),
    free(990_106, 'F1', '休息果吧区', 4),
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
};

const RECEIPT: DiningReceipt = (() => {
  const state = (k: BillLine['kitchen']) =>
    k?.status === 'cancelled' ? 'voided' : k?.status === 'served' ? 'served' : k?.status === 'done' ? 'done' : k?.status === 'cooking' ? 'cooking' : 'waiting';
  const orders = [1, 2, 3].map((seq) => ({
    seq,
    orderNo: `K${seq}`,
    postedAt: ago(48 - seq * 10),
    postedByName: '前台小周',
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

/** 菜单里的菜：三处、每个小分类都有，菜名有长有短，一道估清、一道限量（规则、营业日照接口返回的） */
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

/** 菜单、厨房看板里的菜，桌台看板、这一桌的详情、点菜单换成合成数据（只读，不碰库里的菜与桌台） */
async function mockTables(ctx: BrowserContext) {
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

async function openDevice(browser: Browser, baseURL: string, d: Device) {
  const ctx = await browser.newContext({ baseURL, viewport: d.viewport, hasTouch: true, isMobile: !!d.mobile, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await mockTables(ctx);
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
  frontdesk: async (page) => {
    await page.goto('/frontdesk');
    await expect(page.getByTestId('tag-board')).toBeVisible();
    await expectFits(page);
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
  'dining-voids': async (page) => {
    await page.goto('/dining/voids');
    await expect(page.getByTestId('dining-voids-outlet-all')).toBeVisible();
    await page.getByTestId('dining-voids-outlet-fruit').click();
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
