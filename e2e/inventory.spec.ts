// 库存与采购浏览器验收：依赖两套合成数据（npm run seed 与 npm run cli seed-inventory-demo，仅独立演示库）。
// v0.7.3 起库存、采购、货款、待办在 ERP 工作区（地址不变，导航在 ERP 里；门店主导航没有这几项）。
// 账号：店主 linlan / 物资经办 lixiao / 采购 zhouyi / 对账付款 qianfen（v0.7.12 分岗不兼任），密码 yuzu2026。
// 业务流程只在门店电脑尺寸跑一遍（会改变演示数据，断言都用相对变化）；平板尺寸检查主要页面布局。
import { expect, request, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string, landing: RegExp | string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: landing })).toBeVisible({ timeout: 30_000 }); // 刚启动的服务第一次登录可能较慢
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'ERP 导航' }).getByRole('link', { name, exact: true });

/** 门店那边的人（店主）从用户菜单进 ERP */
async function enterErp(page: Page) {
  await page.getByTestId('user-menu').click();
  await page.getByTestId('user-menu-erp').click();
  await expect(page.getByTestId('erp-shell')).toBeVisible();
}

async function stockOf(page: Page, code: string): Promise<number> {
  const res = await page.request.get('/api/inventory/materials');
  const m = ((await res.json()) as { code: string; stockMilli: number }[]).find((x) => x.code === code)!;
  return m.stockMilli / 1000;
}

/**
 * 补货：v0.7.11 起收货必须按已确认的采购单、写明一起验收的采购（#17、#19）。
 * 用店主的接口会话建采购单并确认，再按单收货（一起验收的是采购 zhouyi）；不影响页面上登录的账号。
 */
async function topUp(baseURL: string, materialCode: string, supplierCode: string, purchaseQty: number) {
  const api = await request.newContext({ baseURL });
  try {
    expect((await api.post('/api/auth/login', { data: { username: 'linlan', password: PASSWORD } })).ok()).toBe(true);
    const materials = (await (await api.get('/api/inventory/materials')).json()) as { id: number; code: string; refPriceCents: number; purchaseFactorMilli: number }[];
    const suppliers = (await (await api.get('/api/inventory/suppliers')).json()) as { id: number; code: string }[];
    const buyers = (await (await api.get('/api/inventory/co-acceptors')).json()) as { id: number; displayName: string }[];
    const me = await (await api.get('/api/auth/me')).json();
    const m = materials.find((x) => x.code === materialCode)!;
    const supplierId = suppliers.find((x) => x.code === supplierCode)!.id;
    const po = await api.post('/api/purchase-orders', {
      data: {
        clientKey: crypto.randomUUID(),
        supplierId,
        orderDate: me.calendarToday,
        approveNow: true,
        note: 'E2E 补货（合成数据）',
        lines: [{ materialId: m.id, purchaseQtyMilli: purchaseQty * 1000, priceCents: m.refPriceCents }],
      },
    });
    expect(po.status()).toBe(201);
    const order = (await po.json()).po as { id: number; lines: { id: number; baseQtyMilli: number }[] };
    const res = await api.post('/api/inventory/docs', {
      data: {
        clientKey: crypto.randomUUID(),
        docType: 'receipt',
        docDate: me.calendarToday,
        supplierId,
        purchaseOrderId: order.id,
        coAcceptorId: buyers.find((b) => b.displayName.startsWith('周一'))!.id,
        note: 'E2E 补货（合成数据）',
        lines: [{ materialId: m.id, poLineId: order.lines[0]!.id, deliveredMilli: order.lines[0]!.baseQtyMilli, acceptedMilli: order.lines[0]!.baseQtyMilli }],
      },
    });
    expect(res.status()).toBe(201);
  } finally {
    await api.dispose();
  }
}

async function logout(page: Page) {
  await page.request.post('/api/auth/logout');
}

test.describe('库存与采购流程', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('物资经办：登录直接进入 ERP 的库存，没有门店入口与货款；按箱领料、领料退回', async ({ page, baseURL }) => {
    await login(page, 'lixiao', '库存');
    await expect(page.getByTestId('erp-shell')).toBeVisible();
    await expect(nav(page, '库存')).toBeVisible();
    // 门店主导航（会员、日结……）不出现，也没有「返回门店」；没有货款权限就没有「应付货款」
    await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
    await expect(page.getByTestId('erp-exit')).toHaveCount(0);
    await expect(nav(page, '应付货款')).toHaveCount(0);

    // 反复执行会消耗演示库存：不够一箱时先按正式流程（采购单 → 按单收货）补两箱
    if ((await stockOf(page, 'M018')) < 24) await topUp(baseURL!, 'M018', 'S005', 2);
    const before = await stockOf(page, 'M018');
    await page.getByRole('link', { name: '部门领料' }).first().click();
    await page.getByRole('radio', { name: '水吧' }).click();
    await page.fill('#handler', '水吧小吴');
    await page.getByLabel('添加物料').fill('饮用水');
    await page.keyboard.press('Enter');
    await page.keyboard.type('1');
    // 「10 箱」与「10 瓶」一眼可辨：切到箱后按换算显示瓶数
    await page.getByRole('radio', { name: '箱' }).first().click();
    await expect(page.getByText('= 24 瓶')).toBeVisible();
    await page.getByRole('button', { name: /确认领料/ }).click();
    await expect(page.getByText('部门领料已生效')).toBeVisible();
    expect(await stockOf(page, 'M018')).toBe(before - 24);

    // 从单据详情发起领料退回（水吧小仓出、总仓进），最多退回原领料数量
    await page.getByRole('button', { name: '查看单据' }).click();
    await expect(page.getByRole('dialog', { name: '库存单据详情' }).getByText('部门待签收')).toBeVisible();
    await page.getByRole('dialog', { name: '库存单据详情' }).getByRole('button', { name: '领料退回' }).click();
    await expect(page.getByText('原领 24')).toBeVisible();
    // 原领用单下拉框完整可见（曾被并排的搜索框挤成一条细缝）
    expect((await page.getByLabel('选择原单').boundingBox())!.width).toBeGreaterThan(200);
    await page.getByLabel('退回数量（瓶）').fill('30');
    await expect(page.getByText('最多 24 瓶')).toBeVisible();
    await expect(page.getByRole('button', { name: /确认退回/ })).toBeDisabled();
    await page.getByLabel('退回数量（瓶）').fill('4');
    await page.getByRole('button', { name: /确认退回/ }).click();
    await expect(page.getByText('领料退回已生效')).toBeVisible();
    expect(await stockOf(page, 'M018')).toBe(before - 20);
  });

  test('盘点差异先是待核差异，负责人在待办确认后才调整库存', async ({ page }) => {
    await login(page, 'lixiao', '库存');
    const book = await stockOf(page, 'M013');
    await page.goto('/inventory/new/count');
    await page.getByLabel('添加物料').fill('抽纸');
    await page.keyboard.press('Enter');
    await page.keyboard.type(String(book - 2));
    await expect(page.getByText('待核差异').first()).toBeVisible();
    await page.getByRole('button', { name: /提交确认/ }).click();
    await expect(page.getByText('已提交，等待负责人确认')).toBeVisible();
    expect(await stockOf(page, 'M013')).toBe(book);
    await logout(page);

    await login(page, 'linlan', '会员工作台');
    // 门店主导航里没有库存、待办；从用户菜单进 ERP，再点「审批中心」（v0.7.30 起导航是审批中心，旧的审批待办页照常在）
    await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '待办', exact: true })).toHaveCount(0);
    await enterErp(page);
    await nav(page, '审批中心').click();
    await expect(page).toHaveURL(/\/approvals/);
    await page.goto('/todo');
    await page.getByRole('button', { name: /盘点/ }).filter({ hasText: '抽纸' }).first().click();
    await page.getByLabel('抽纸差异原因').selectOption('measurement');
    await page.getByRole('button', { name: '确认盘点调整' }).click();
    await expect(page.getByText('盘点调整已确认').first()).toBeVisible();
    expect(await stockOf(page, 'M013')).toBe(book - 2);
  });

  test('采购 → 负责人确认 → 按单收货（拒收不入库）→ 登记付款', async ({ page }) => {
    await login(page, 'zhouyi', '库存');
    await nav(page, '采购').click();
    await page.getByRole('link', { name: '新建采购单' }).click();
    await page.selectOption('#po-sup', { label: 'S004 · 栖谷护理用品（模拟）' });
    await page.getByLabel('添加物料').fill('护理床单');
    await page.keyboard.press('Enter');
    await page.keyboard.type('2');
    await expect(page.getByText('= 1,000 张')).toBeVisible();
    await expect(page.getByText('持平')).toBeVisible();
    await page.getByRole('button', { name: /提交确认/ }).click();
    await expect(page.getByText('已提交，等待负责人确认')).toBeVisible();
    const poNo = (await page.getByRole('dialog', { name: '采购单详情' }).locator('p.num').first().innerText()).trim();
    await logout(page);

    await login(page, 'linlan', '会员工作台');
    await page.goto('/todo');
    await page.getByRole('button', { name: new RegExp(poNo) }).click();
    await page.getByRole('button', { name: '确认采购' }).click();
    await expect(page.getByText('采购单已确认').first()).toBeVisible();
    await logout(page);

    await login(page, 'lixiao', '库存');
    const before = await stockOf(page, 'M016');
    await page.goto('/purchasing');
    await page.getByRole('button', { name: new RegExp(poNo) }).click();
    await page.getByRole('button', { name: '按单收货' }).click();
    await expect(page.getByText(`按采购单 ${poNo} 收货`)).toBeVisible();
    // 采购和仓库一起验收（#17）：没选一起验收的采购不能提交
    await expect(page.getByRole('button', { name: /确认收货/ })).toBeDisabled();
    await page.selectOption('#coAcceptor', { label: '周一（采购）' });
    // 送达 2 箱，只验收 1 箱
    await page.getByLabel('合格实收（箱）').fill('1');
    await page.getByLabel('拒收原因').fill('一箱受潮');
    await page.getByRole('button', { name: /确认收货/ }).click();
    await expect(page.getByText('收货入库已生效')).toBeVisible();
    expect(await stockOf(page, 'M016')).toBe(before + 500);
    await logout(page);

    // 付款由对账付款登记（#17 分岗不兼任，v0.7.12）
    await login(page, 'qianfen', '库存');
    await page.goto('/payables');
    const balanceRow = page.getByRole('row').filter({ hasText: '栖谷护理用品' });
    await expect(balanceRow).toBeVisible();
    await balanceRow.getByRole('link', { name: '付款' }).click();
    // 「含预付款」也是勾选框（v0.7.12），未结清货款加载出来之前它是页面上唯一的勾选框：按名称找核销行
    const target = page.getByRole('checkbox', { name: /^核销 / }).last();
    await target.check();
    await page.fill('#pay-ev', '流水尾号 1026');
    await page.getByRole('button', { name: '登记付款' }).click();
    await expect(page.getByText('已提交，等待负责人确认')).toBeVisible();
  });
});

test.describe('平板布局', () => {
  test('库存、单据录入、采购与货款页面无横向溢出', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    for (const url of ['/inventory', '/inventory/new/receipt', '/inventory/new/count', '/purchasing', '/payables', '/payables?view=statement&supplier=1', '/todo']) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, url).toBeLessThanOrEqual(1);
    }
    // 并排的搜索框与下拉框：下拉框不能被挤没
    for (const url of ['/inventory/new/issue_return', '/inventory/new/supplier_return']) {
      await page.goto(url);
      const box = await page.getByLabel('选择原单').boundingBox();
      expect(box!.width, url).toBeGreaterThan(150);
    }
  });
});
