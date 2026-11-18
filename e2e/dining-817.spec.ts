// 8.1.7 餐饮分区与点菜单浏览器验收（docs/DINING_V817.md、docs/HANDOFF_V817.md）：
//   后台给菜选点单分类、建桌选分区 → 桌台页分区卡片与详情 → 从桌台进点单：先弹出餐厅 / 水吧 / 果吧，选了按小分类点，
//   换一处菜篮还在，下单后回到三个入口 → 点菜单（每道菜已上 / 未上 / 制作中 / 已退，只看还没上的）
//   → 沽清列表、台账、退菜记录按果吧 / 水吧筛。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
// 专用菜品、档口、桌台（E2E 817 开头）留着下次沿用；开始时收掉上次中断留下的开台，结束时退菜撤台、关闭餐饮功能，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { DiningAdmin, DiningReceipt, KitchenBoard, TableSessionDetail, TablesAdmin, TablesBoard } from '../src/shared/dining';

const PASSWORD = 'yuzu2026';
const DISHES = [
  { name: 'E2E 817 宫保鸡丁', category: 'E2E 817 餐饮', price: 4800, station: 'E2E 817 热菜', slot: 'restaurant:餐饮' },
  { name: 'E2E 817 青岛啤酒', category: 'E2E 817 餐饮', price: 1800, station: 'E2E 817 吧台', slot: 'restaurant:酒水' },
  { name: 'E2E 817 杨枝甘露', category: 'E2E 817 甜品', price: 3200, station: 'E2E 817 水吧', slot: 'water:糖水' },
  // 莫吉托：准备时清掉分类（按默认归：档口名带「水吧」→ 水吧 · 手作饮料），在后台页面上改成调酒
  { name: 'E2E 817 莫吉托', category: 'E2E 817 餐饮', price: 6800, station: 'E2E 817 水吧', slot: null },
  { name: 'E2E 817 鲜切果盘', category: 'E2E 817 果吧', price: 3800, station: 'E2E 817 果吧', slot: 'fruit' },
] as const;
const [KUNGPAO, BEER, SAGO, MOJITO, FRUIT] = DISHES;
const BOX = 'E2E 817 观澜';
const BAR = 'E2E 817 W1';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function relogin(page: Page, username: string) {
  await page.request.post('/api/auth/logout');
  await login(page, username);
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function send<T = unknown>(page: Page, method: 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const res = await page.request[method](url, data === undefined ? {} : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const sessionOf = async (page: Page, name: string) => (await getJson<TablesBoard>(page, '/api/dining/tables')).tables.find((t) => t.name === name)!.session;

/** 收掉这两张桌上开着的台：退掉有效明细后撤台（店主） */
async function clearTables(page: Page, reason: string) {
  for (const name of [BOX, BAR]) {
    const s = await sessionOf(page, name);
    if (!s) continue;
    const d = await getJson<TableSessionDetail>(page, `/api/dining/tables/sessions/${s.id}`);
    for (const l of d.lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/dining/tables/lines/${l.id}/void`, { reason });
    await send(page, 'post', `/api/dining/tables/sessions/${s.id}/cancel`, { reason });
  }
}

/** 店主：专用菜品、档口、菜品的档口与点单分类、两张桌台（观澜在后台页面上建、选分区）都准备好，开启餐饮与桌台点单 */
async function prepare(page: Page) {
  for (const d of DISHES) {
    const items = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items;
    const old = items.find((i) => i.name === d.name);
    const body = { name: d.name, category: d.category, price: d.price };
    if (!old) await send(page, 'post', '/api/items', body);
    else if (!old.active) await send(page, 'put', `/api/items/${old.id}`, { ...body, active: true });
  }
  let admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
  for (const name of new Set(DISHES.map((d) => d.station))) {
    const old = admin.stations.find((s) => s.name === name);
    if (!old) admin = await send<DiningAdmin>(page, 'post', '/api/admin/dining/stations', { name });
    else if (!old.active) admin = await send<DiningAdmin>(page, 'put', `/api/admin/dining/stations/${old.id}`, { name, sortOrder: old.sortOrder, active: true });
  }
  const items = DISHES.map((d) => ({ id: admin.items.find((i) => i.name === d.name)!.id, stationId: admin.stations.find((s) => s.name === d.station)!.id, slot: d.slot }));
  await send(page, 'put', '/api/admin/dining/items', { items });
  await send(page, 'put', '/api/admin/dining/rules', { enabled: true, trackServed: true, warnMinutes: 15, tablesEnabled: true, voidFreeCents: 5000 });

  // 桌台：观澜在后台页面上建（还没有时），分区从四个里选「景观包厢」；W1 用接口建在「休闲水吧区」
  let tables = await getJson<TablesAdmin>(page, '/api/admin/dining/tables');
  if (!tables.tables.some((t) => t.name === BOX)) {
    await page.goto('/admin/dining/tables');
    await page.getByTestId('dining-table-new').click();
    await page.getByTestId('dining-table-name').fill(BOX);
    await expect(page.getByTestId('dining-table-area').locator('option')).toHaveText(['散桌', '景观包厢', '休闲水吧区', '休息果吧区', '不分区']);
    await page.getByTestId('dining-table-area').selectOption('景观包厢');
    await page.getByTestId('dining-table-seats').fill('10');
    await page.getByTestId('dining-table-save').click();
    await expect(page.getByTestId(`dining-table-${BOX}`)).toContainText('景观包厢');
    tables = await getJson<TablesAdmin>(page, '/api/admin/dining/tables');
  }
  for (const [i, t] of [
    { name: BOX, area: '景观包厢', seats: 10 },
    { name: BAR, area: '休闲水吧区', seats: 2 },
  ].entries()) {
    const old = tables.tables.find((x) => x.name === t.name);
    const body = { ...t, sortOrder: 9100 + i, active: true };
    if (!old) tables = await send<TablesAdmin>(page, 'post', '/api/admin/dining/tables', body);
    else if (!old.active || old.area !== t.area || old.sortOrder !== body.sortOrder) tables = await send<TablesAdmin>(page, 'put', `/api/admin/dining/tables/${old.id}`, body);
  }
  await clearTables(page, 'E2E：收掉上次留下的');
}

test.describe('8.1.7 餐饮分区与点菜单', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改规则、写数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(240_000);

  test('后台选点单分类与分区 → 桌台分区详情 → 先选餐厅 / 水吧 / 果吧再点 → 点菜单标已上未上 → 沽清、台账、退菜记录按分类筛', async ({ page }) => {
    await login(page, 'linlan');
    try {
      await prepare(page);

      // ① 后台「出品档口与菜品」：没设的写着默认归哪；莫吉托改成水吧 · 调酒，保存后标成设过的
      await page.goto('/admin/dining/stations');
      const mojitoSlot = page.getByTestId(`dining-item-slot-${MOJITO.name}`);
      await expect(mojitoSlot).toHaveValue('');
      await expect(mojitoSlot.locator('option').first()).toHaveText('默认（水吧 · 手作饮料）');
      await expect(page.getByTestId(`dining-item-slot-${SAGO.name}`)).toHaveValue('water:糖水');
      await mojitoSlot.selectOption('water:调酒');
      await page.getByTestId('dining-items-save').click();
      await expect(page.getByText('菜品的出品档口与点单分类已保存')).toBeVisible();
      const saved = (await getJson<DiningAdmin>(page, '/api/admin/dining')).items.find((i) => i.name === MOJITO.name)!;
      expect([saved.slot, saved.slotAssigned]).toEqual([{ outlet: 'water', group: '调酒' }, true]);
      await relogin(page, 'xiaozhou');

      // ② 桌台：上面一排分区卡片；点「景观包厢」只看这个区、写出明细，选的区记在地址里
      await page.goto('/dining/tables');
      await expect(page.getByTestId('table-zones')).toBeVisible();
      for (const z of ['全部', '散桌', '景观包厢', '休闲水吧区', '休息果吧区']) await expect(page.getByTestId(`table-zone-${z === '全部' ? 'all' : z}`)).toBeVisible();
      await page.getByTestId('table-zone-景观包厢').click();
      await expect(page).toHaveURL(/zone=/);
      await expect(page.getByTestId('table-zone-detail')).toContainText('景观包厢');
      await expect(page.getByTestId(`table-tile-${BOX}`)).toBeVisible();
      await expect(page.getByTestId(`table-tile-${BAR}`)).toHaveCount(0);
      await page.getByTestId('table-zone-休闲水吧区').click();
      await expect(page.getByTestId(`table-tile-${BAR}`)).toBeVisible();
      await expect(page.getByTestId(`table-tile-${BOX}`)).toHaveCount(0);
      // 刷新以后还在这个区
      await page.reload();
      await expect(page.getByTestId('table-zone-detail')).toContainText('休闲水吧区');
      await page.getByTestId('table-zone-景观包厢').click();

      // ③ 开台 6 人 → 点单：先弹出三个入口，各写着小分类
      await page.getByTestId(`table-tile-${BOX}`).click();
      const openDialog = page.getByRole('dialog').filter({ hasText: `开台 · 桌 ${BOX}` });
      await openDialog.getByTestId('table-guests').fill('6');
      await openDialog.getByTestId('table-open-submit').click();
      await expect(page.getByText(`桌 ${BOX} 已开台`)).toBeVisible();
      await page.getByTestId('table-order').click();
      await expect(page.getByTestId('dining-table-selected')).toContainText(`桌 ${BOX}`);
      const entries = page.getByTestId('dining-outlets');
      await expect(entries).toBeVisible();
      await expect(page.getByTestId('dining-outlet-restaurant')).toContainText('餐饮 · 酒水');
      await expect(page.getByTestId('dining-outlet-water')).toContainText('手作饮料 · 糖水 · 调酒');
      await expect(page.getByTestId('dining-outlet-fruit')).toContainText('不再细分');

      // 餐厅：「全部」按小分类分段；选「酒水」只剩酒水
      await page.getByTestId('dining-outlet-restaurant').click();
      await expect(entries).toHaveCount(0);
      await expect(page.getByTestId('dining-menu-group-餐饮')).toContainText(KUNGPAO.name);
      await expect(page.getByTestId('dining-menu-group-酒水')).toContainText(BEER.name);
      await page.getByTestId('dining-group-酒水').click();
      await expect(page.getByTestId(`dining-dish-${KUNGPAO.name}`)).toHaveCount(0);
      await page.getByTestId(`dining-dish-${BEER.name}`).click();
      await page.getByTestId('dining-group-all').click();
      await page.getByTestId(`dining-dish-${KUNGPAO.name}`).click();
      // 水吧：糖水、调酒；换一处菜篮还在
      await page.getByTestId('dining-outlet-water').click();
      await expect(page.getByTestId(`dining-dish-${BEER.name}`)).toHaveCount(0);
      await page.getByTestId('dining-group-糖水').click();
      await page.getByTestId(`dining-dish-${SAGO.name}`).click();
      await page.getByTestId('dining-group-调酒').click();
      await page.getByTestId(`dining-dish-${MOJITO.name}`).click();
      // 果吧：不分小类
      await page.getByTestId('dining-outlet-fruit').click();
      await expect(page.getByTestId('dining-group-all')).toHaveCount(0);
      await page.getByTestId(`dining-dish-${FRUIT.name}`).click();
      const cart = page.getByTestId('dining-cart');
      for (const d of DISHES) await expect(cart).toContainText(d.name);
      await expect(cart).toContainText('已点 5 份');
      await page.getByTestId('dining-submit').click();
      await expect(page.getByText(`桌 ${BOX} 已下单`)).toBeVisible();
      // 下单成功回到三个入口
      await expect(entries).toBeVisible();

      // ④ 出品：宫保鸡丁上了，啤酒出餐了没上，甘露在做，莫吉托待做；果盘退掉（小额直接退）
      const s = (await sessionOf(page, BOX))!;
      const kitchen = (await getJson<KitchenBoard>(page, '/api/kitchen')).items.filter((k) => k.tableSessionId === s.id);
      const kid = (name: string) => kitchen.find((k) => k.name === name)!.id;
      for (const action of ['start', 'done', 'serve']) await send(page, 'post', `/api/kitchen/items/${kid(KUNGPAO.name)}/${action}`);
      for (const action of ['start', 'done']) await send(page, 'post', `/api/kitchen/items/${kid(BEER.name)}/${action}`);
      await send(page, 'post', `/api/kitchen/items/${kid(SAGO.name)}/start`);
      const detail = await getJson<TableSessionDetail>(page, `/api/dining/tables/sessions/${s.id}`);
      await send(page, 'post', `/api/dining/tables/lines/${detail.lines.find((l) => l.name === FRUIT.name)!.id}/void`, { reason: 'E2E 客人不要了' });

      // ⑤ 点菜单（点单页「还没上的菜」旁）：抬头桌号与分区、人数；每道菜一个章；合计只算有效的
      const r = await getJson<DiningReceipt>(page, `/api/dining/receipt?session=${s.id}`);
      const lineId = (name: string) => r.orders.flatMap((o) => o.lines).find((l) => l.name === name)!.billLineId;
      await page.getByTestId('dining-receipt-open').click();
      const receipt = page.getByTestId('dining-receipt');
      await expect(receipt).toBeVisible();
      await expect(page.getByTestId('dining-receipt-title')).toContainText(BOX);
      await expect(page.getByTestId('dining-receipt-title')).toContainText('景观包厢');
      await expect(receipt).toContainText('6 人');
      const expected: [string, string, string][] = [
        [KUNGPAO.name, 'served', '已上'],
        [BEER.name, 'done', '已出餐'],
        [SAGO.name, 'cooking', '制作中'],
        [MOJITO.name, 'waiting', '未上'],
        [FRUIT.name, 'voided', '已退'],
      ];
      for (const [name, state, label] of expected) {
        await expect(page.getByTestId(`dining-receipt-line-${lineId(name)}`)).toHaveAttribute('data-state', state);
        await expect(page.getByTestId(`dining-receipt-state-${lineId(name)}`)).toHaveText(label);
      }
      await expect(page.getByTestId('dining-receipt-waiting')).toHaveText('3');
      await expect(page.getByTestId('dining-receipt-progress')).toContainText('已上 1 / 共 4 份');
      await expect(page.getByTestId('dining-receipt-amount')).toContainText('166.00');
      // 只看还没上的：已上、已退的收起来
      await page.getByTestId('dining-receipt-only-waiting').check();
      await expect(page.getByTestId(`dining-receipt-line-${lineId(KUNGPAO.name)}`)).toHaveCount(0);
      await expect(page.getByTestId(`dining-receipt-line-${lineId(FRUIT.name)}`)).toHaveCount(0);
      await expect(page.getByTestId(`dining-receipt-line-${lineId(MOJITO.name)}`)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(receipt).toHaveCount(0);

      // 桌台详情里也能看点菜单
      await page.goto('/dining/tables?zone=景观包厢');
      await page.getByTestId(`table-tile-${BOX}`).click();
      await expect(page.getByTestId('table-session')).toBeVisible();
      await page.getByTestId('table-receipt').click();
      await expect(page.getByTestId(`dining-receipt-line-${lineId(SAGO.name)}`)).toHaveAttribute('data-state', 'cooking');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      // ⑥ 沽清列表：只看果吧
      await page.goto('/dining/limits');
      await page.getByTestId('limits-outlet-fruit').click();
      await expect(page.getByTestId('limits-group-果吧')).toContainText(FRUIT.name);
      await expect(page.getByTestId(`limit-${KUNGPAO.name}`)).toHaveCount(0);
      await page.getByTestId('limits-outlet-water').click();
      await expect(page.getByTestId('limits-group-水吧 · 调酒')).toContainText(MOJITO.name);

      // ⑦ 台账：水吧 · 糖水只有甘露；导出带「价目分类」一列
      await page.goto('/dining/ledger');
      const ledger = page.getByTestId('dining-ledger');
      await page.getByTestId('dining-ledger-outlet-water').click();
      await page.getByTestId('dining-ledger-group-糖水').click();
      await expect(ledger.locator('tbody tr').filter({ hasText: SAGO.name }).first()).toContainText('水吧 · 糖水');
      await expect(ledger.locator('tbody tr').filter({ hasText: MOJITO.name })).toHaveCount(0);
      await expect(ledger.locator('tbody tr').filter({ hasText: KUNGPAO.name })).toHaveCount(0);

      // ⑧ 退菜记录：果吧里有退掉的果盘
      await page.goto('/dining/voids');
      await page.getByTestId('dining-voids-outlet-fruit').click();
      const voidRow = page.getByTestId('dining-voids').locator('tr').filter({ hasText: FRUIT.name }).first();
      await expect(voidRow).toContainText('果吧');
      await expect(voidRow).toContainText('E2E 客人不要了');
      await page.getByTestId('dining-voids-outlet-restaurant').click();
      await expect(page.getByTestId('dining-voids').locator('tr').filter({ hasText: FRUIT.name })).toHaveCount(0);
    } finally {
      await relogin(page, 'linlan');
      await clearTables(page, 'E2E：收尾');
      // 莫吉托放回默认，下次照样从页面上改
      const admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
      const mojito = admin.items.find((i) => i.name === MOJITO.name);
      if (mojito) await send(page, 'put', '/api/admin/dining/items', { items: [{ id: mojito.id, slot: null }] });
      const res = await page.request.put('/api/admin/dining/rules', { data: { enabled: false, tablesEnabled: false } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });

  test('手牌客人的点菜单：前台找到客人，点完单在点单页看', async ({ page }) => {
    await login(page, 'linlan');
    let visitId: number | null = null;
    try {
      await prepare(page);
      await relogin(page, 'xiaozhou');
      const board = await getJson<{ tags: { code: string; zone: string; kind: string; active: boolean; locked: boolean; visit: { id: number } | null }[] }>(page, '/api/frontdesk/board');
      const tag = board.tags
        .filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)
        .map((t) => t.code)
        .reverse()[0]!;
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: 'E2E 817 客人' }] });
      visitId = (await getJson<typeof board>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;
      await page.goto('/dining/order');
      await page.getByTestId('dining-tag').fill(tag);
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest')).toContainText('E2E 817 客人');
      await page.getByTestId('dining-outlet-fruit').click();
      await page.getByTestId(`dining-dish-${FRUIT.name}`).click();
      await page.getByTestId('dining-submit').click();
      await expect(page.getByText(`${tag} 已下单`)).toBeVisible();
      await page.getByTestId('dining-receipt-open').click();
      await expect(page.getByTestId('dining-receipt-title')).toContainText(tag);
      await expect(page.getByTestId('dining-receipt-waiting')).toHaveText('1');
      await expect(page.getByTestId('dining-receipt')).toContainText(FRUIT.name);
      await page.keyboard.press('Escape');
    } finally {
      await relogin(page, 'linlan');
      if (visitId !== null) {
        const lines = (await getJson<{ lines: { id: number; status: string }[] }>(page, `/api/frontdesk/visits/${visitId}`)).lines;
        for (const l of lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason: 'E2E：收尾' });
        await send(page, 'post', `/api/frontdesk/visits/${visitId}/cancel`, { reason: 'E2E：点菜单收尾' });
      }
      const res = await page.request.put('/api/admin/dining/rules', { data: { enabled: false, tablesEnabled: false } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });
});
