// 8.0.20 浏览器验收：进销存做深 + 客房（docs/ERP_V8020.md，交接 docs/HANDOFF_V8020.md）。可重复执行；
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。物料、项目、品类的名字都带这一次的时间，跑几遍不撞。
//   · 库存 → 用料与扣料：给一道菜设用料 → 出品完成 → 待扣料里看得到 → 「现在扣一次」开出耗用单；库存 → 成本看得到金额与理论毛利；
//   · 采购 → 补货建议：顶上的自动补货一条，「现在跑一次」；
//   · ERP → 布草洗涤：加品类 → 新增 → 送洗 → 收回（破损）→ 对账表有洗涤费；
//   · 后台 → 客房 → 房型：填会员价、保存后还在；点餐页的找客人写着「手牌号或房号」。
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const stamp = String(Date.now()).slice(-7);

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}
async function send<T = Record<string, unknown>>(request: APIRequestContext, method: 'post' | 'put', url: string, data: unknown): Promise<T> {
  const r = await request[method](url, { data });
  expect(r.ok(), `${url} → ${r.status()} ${await r.text()}`).toBe(true);
  return (await r.json()) as T;
}
const get = async <T>(request: APIRequestContext, url: string) => (await (await request.get(url)).json()) as T;

test.describe('8.0.20 进销存做深与客房', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('用料与扣料：设用料 → 出品完成 → 现在扣一次开出耗用单；成本页看得到库存金额与理论毛利', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    const today = (await get<{ calendarToday: string }>(page.request, '/api/auth/me')).calendarToday;
    // 准备：一样物料（期初 5 千克，参考价 240 元 / 箱 24 千克 = 10 元 / 千克）、一道进厨房的菜
    const code = `E2E-M${stamp}`;
    const material = await send<{ id: number }>(page.request, 'post', '/api/inventory/materials', { code, name: `验收鸡肉${stamp}`, inventoryUnit: '千克', decimals: 3, purchaseUnit: '箱', purchaseFactorMilli: 24_000, refPriceCents: 24_000 });
    await send(page.request, 'post', '/api/inventory/docs', { clientKey: randomUUID(), docDate: today, docType: 'opening', approveNow: true, lines: [{ materialId: material.id, qtyMilli: 5_000 }] });
    const dish = `验收炒鸡${stamp}`;
    const items = await send<{ items: { id: number; name: string }[] }>(page.request, 'post', '/api/items', { name: dish, category: '热菜', price: 4800 });
    const itemId = items.items.find((i) => i.name === dish)!.id;
    const stations = await get<{ stations: { id: number; name: string; active: boolean }[] }>(page.request, '/api/admin/dining');
    let stationId = stations.stations.find((s) => s.active)?.id;
    if (!stationId) {
      const made = await send<{ stations: { id: number; name: string }[] }>(page.request, 'post', '/api/admin/dining/stations', { name: `验收档口${stamp}` });
      stationId = made.stations.find((s) => s.name === `验收档口${stamp}`)!.id;
    }
    await send(page.request, 'put', '/api/admin/dining/items', { items: [{ id: itemId, stationId }] });
    await send(page.request, 'put', '/api/admin/dining/rules', { enabled: true });
    await send(page.request, 'put', '/api/inventory/usage/rules', { enabled: true });

    // 页面上设用料：0.2 千克、损耗 5%
    await page.goto('/inventory/usage');
    await expect(page.getByTestId('usage-tab')).toBeVisible();
    await page.getByTestId('usage-search').fill(dish);
    const row = page.getByTestId(`usage-item-${itemId}`);
    await expect(row).toContainText('没设用料');
    await page.getByTestId(`usage-edit-${itemId}`).click();
    const dialog = page.getByTestId('recipe-dialog');
    await dialog.getByTestId('recipe-material-0').selectOption(String(material.id));
    await dialog.getByTestId('recipe-qty-0').fill('0.2');
    await dialog.getByTestId('recipe-loss-0').fill('5');
    await page.getByTestId('recipe-save').click();
    await expect(page.getByText('用料已保存')).toBeVisible();
    await expect(row).toContainText('出品时扣');
    await expect(row).toContainText('损耗 5%');
    // 一份成本 = 0.21 千克 × 10 元 = 2.10 元
    await expect(row).toContainText('¥2.10');

    // 接待一位客人、点 2 份、出品完成
    const board = await get<{ tags: { code: string; zone: string; kind: string; active: boolean; locked: boolean; visit: { id: number } | null }[] }>(page.request, '/api/frontdesk/board');
    const tag = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse()[0]!;
    const checked = await send<{ visits: { id: number }[] }>(page.request, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: 'E2E 扣料' }] });
    const visitId = checked.visits[0]!.id;
    await send(page.request, 'post', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines: [{ itemId, quantity: 2 }], expectedTotal: 9600 });
    const kitchen = await get<{ items: { id: number; visitId: number; name: string }[] }>(page.request, '/api/kitchen');
    const ticket = kitchen.items.find((k) => k.visitId === visitId && k.name === dish)!;
    await send(page.request, 'post', `/api/kitchen/items/${ticket.id}/done`, {});

    // 待扣料：0.42 千克；现在扣一次 → 开出耗用单
    await page.reload();
    const pending = page.getByTestId(`usage-pending-${code}`);
    await expect(pending).toContainText('该扣 0.42 千克');
    await expect(pending).toContainText('配方耗用');
    await page.getByTestId('usage-run').click();
    await expect(page.getByText(/开了 \d+ 张耗用单/)).toBeVisible();
    await expect(page.getByTestId(`usage-pending-${code}`)).toHaveCount(0);
    await expect(page.getByTestId('usage-batches')).toContainText('配方耗用');
    const mat = await get<{ stockMilli: number }>(page.request, `/api/inventory/materials/${material.id}`);
    expect(mat.stockMilli).toBe(5_000 - 420);

    // 成本页：库存金额里有这样物料（4.58 千克 × 10 元 = 45.80），耗用成本里有「配方耗用」
    await page.goto('/inventory/cost');
    await expect(page.getByTestId('cost-tab')).toBeVisible();
    const stockRow = page.getByTestId('cost-stock').locator('tr', { hasText: code });
    await expect(stockRow).toContainText('4.58 千克');
    await expect(stockRow).toContainText('¥45.80');
    await expect(page.getByTestId('cost-usage')).toContainText('配方耗用');
    await expect(page.getByTestId('cost-export')).toHaveAttribute('href', /\/api\/inventory\/cost\/export\?from=/);
    // 撤销这位客人的来访（不留在店里）
    await page.request.post(`/api/frontdesk/visits/${visitId}/cancel`, { data: { clientKey: randomUUID(), reason: 'E2E 结束' } });
  });

  test('自动补货：补货建议页顶上有一条，能「现在跑一次」', async ({ page }) => {
    await login(page);
    await page.goto('/purchasing/suggestions');
    const card = page.getByTestId('auto-replenish');
    await expect(card).toBeVisible();
    await expect(card).toContainText('自动补货');
    await expect(card).toContainText(/每天 \d{2}:\d{2} 以后|关着/);
    await page.getByTestId('auto-replenish-run').click();
    await expect(page.getByText(/今天一共建了 \d+ 张草稿|没跑完/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('auto-replenish-today')).toContainText(/今天建了 \d+ 张采购单草稿|今天没有自动建草稿/);
    // 规则都收在「ERP 设置」：自动补货在「采购规则」、按用料扣库存在「库存与审批开关」，与各自页面顶上是同一张卡片
    await page.goto('/erp/settings/purchase');
    await expect(page.getByTestId('auto-replenish')).toContainText('自动补货');
    await page.goto('/erp/settings/inventory');
    await expect(page.getByTestId('usage-rules')).toContainText('按用料扣库存');
  });

  test('布草洗涤：加品类 → 新增 → 送洗 → 收回（破损）→ 对账表有洗涤费', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    const suppliers = await send<{ id: number; code: string; name: string }[]>(page.request, 'post', '/api/inventory/suppliers', { code: `E2EXD${stamp}`, name: `验收洗涤厂${stamp}` });
    const laundry = suppliers.find((s) => s.code === `E2EXD${stamp}`)!;
    await page.goto('/erp/linen');
    await expect(page.getByTestId('linen-page')).toBeVisible();
    const name = `验收浴巾${stamp}`;
    await page.getByTestId('linen-item-new').click();
    await page.locator('#linen-name').fill(name);
    await page.locator('#linen-price').fill('1.5');
    await page.getByTestId('linen-item-save').click();
    await expect(page.getByText('已添加')).toBeVisible();
    const row = page.getByTestId('linen-items').locator('tr', { hasText: name });
    await expect(row).toBeVisible();

    const openDoc = async (kind: 'add' | 'send' | 'return', fill: () => Promise<void>) => {
      await page.getByTestId(`linen-new-${kind}`).click();
      const dialog = page.getByTestId('linen-doc-dialog');
      if (kind !== 'add') await dialog.getByTestId('linen-doc-supplier').selectOption(String(laundry.id));
      await dialog.getByTestId('linen-doc-item-0').selectOption({ label: name });
      await fill();
      await page.getByTestId('linen-doc-save').click();
      await expect(dialog).toBeHidden();
    };
    await openDoc('add', async () => page.getByTestId('linen-doc-qty-0').fill('50'));
    await expect(row.locator('td').nth(1)).toHaveText('50');
    await openDoc('send', async () => page.getByTestId('linen-doc-qty-0').fill('30'));
    await expect(row.locator('td').nth(2)).toHaveText('20');
    await expect(row.locator('td').nth(3)).toHaveText('30');
    await expect(page.getByTestId('linen-outstanding')).toContainText(`${name} 30 件`);
    await openDoc('return', async () => {
      await page.getByTestId('linen-doc-qty-0').fill('27');
      await page.getByTestId('linen-doc-damaged-0').fill('2');
      await page.getByTestId('linen-doc-lost-0').fill('1');
    });
    // 总数 50 − 破损 2 − 丢失 1 = 47；在洗 0；在店 47
    await expect(row.locator('td').nth(1)).toHaveText('47');
    await expect(row.locator('td').nth(2)).toHaveText('47');
    await expect(row.locator('td').nth(3)).toHaveText('0');
    // 洗涤费 =（27 + 2）× 1.50 = 43.50
    const statement = page.getByTestId('linen-statement').locator('tr', { hasText: laundry.name });
    await expect(statement).toContainText('¥43.50');
    await expect(page.getByTestId('linen-docs')).toContainText('破损 2');
  });

  test('会员房价与客房点餐的入口：房型里填会员价、保存后还在；点餐页写着「手牌号或房号」', async ({ page }) => {
    await login(page);
    const typeName = `验收房型${stamp}`.slice(0, 12);
    const made = await send<{ types: { id: number; name: string }[] }>(page.request, 'post', '/api/admin/rooms/types', { name: typeName, kind: 'daily', price: 30000 });
    const typeId = made.types.find((t) => t.name === typeName)!.id;
    await page.goto('/admin/rooms/types');
    const typeRow = page.getByTestId(`rooms-type-${typeName}`);
    await typeRow.getByRole('button').first().click();
    const prices = page.getByTestId('rooms-type-member-prices');
    await expect(prices).toBeVisible();
    await page.getByTestId('rooms-type-member-3').fill('260');
    await page.getByTestId('rooms-type-member-5').fill('200');
    await page.getByTestId('rooms-type-save').click();
    await expect(page.getByText('房型已保存')).toBeVisible();
    const admin = await get<{ types: { id: number; memberPrices: { grade: number; price: number }[] }[] }>(page.request, '/api/admin/rooms');
    expect(admin.types.find((t) => t.id === typeId)!.memberPrices).toEqual([
      { grade: 3, price: 26000 },
      { grade: 5, price: 20000 },
    ]);
    // 会员价不低于门市价：保存按钮点不了
    await typeRow.getByRole('button').first().click();
    await page.getByTestId('rooms-type-member-1').fill('300');
    await expect(page.getByTestId('rooms-type-save')).toBeDisabled();
    await page.keyboard.press('Escape');
    // 停用这个验收房型（不留在房型清单里碍事）
    await send(page.request, 'put', `/api/admin/rooms/types/${typeId}`, { name: typeName, kind: 'daily', price: 30000, active: false });
    // 点餐页
    await page.goto('/dining');
    await expect(page.getByLabel('手牌号或房号')).toBeVisible();
  });
});
