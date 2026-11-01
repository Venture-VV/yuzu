// v0.7.11 两级库存（飞书需求 RQ-002 第一步）浏览器验收：领料进部门小仓、部门签收、部门盘点（差异默认「耗用」）、
// 急采 → 仓库到部门验收 → 部门补采购单、库存按仓查看。依赖 seed-demo 与 seed-inventory-demo（仅独立演示库）。
// 账号：店主 linlan（不限部门，替水吧操作）/ 物资经办 lixiao，密码 yuzu2026。会改演示数据，断言都用相对变化。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string, landing: RegExp | string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: landing })).toBeVisible({ timeout: 30_000 });
}

const logout = (page: Page) => page.request.post('/api/auth/logout');
const getJson = async <T>(page: Page, url: string) => (await (await page.request.get(url)).json()) as T;

interface StockRow {
  code: string;
  stockMilli: number;
}

test.describe('两级库存：总仓 + 部门小仓', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('领料 → 部门签收；部门盘点；急采 → 仓库验收 → 部门补采购单；库存按仓查看', async ({ page }) => {
    // ── 仓库给水吧领 5 双拖鞋（领料页面另有用例，这里用接口登记）──
    await login(page, 'lixiao', '库存');
    const materials = await getJson<{ id: number; code: string }[]>(page, '/api/inventory/materials');
    const slipper = materials.find((m) => m.code === 'M001')!;
    const bar = (await getJson<{ id: number; name: string }[]>(page, '/api/inventory/departments')).find((d) => d.name === '水吧')!;
    const me = await getJson<{ calendarToday: string }>(page, '/api/auth/me');
    const res = await page.request.post('/api/inventory/docs', {
      data: { clientKey: crypto.randomUUID(), docType: 'issue', docDate: me.calendarToday, departmentId: bar.id, handler: 'E2E 水吧', lines: [{ materialId: slipper.id, qtyMilli: 5000 }] },
    });
    expect(res.status()).toBe(201);
    const issued = (await res.json()).doc as { id: number; docNo: string };

    // 库存页按仓查看：水吧小仓里有拖鞋
    await page.goto('/inventory');
    await page.getByTestId('warehouse-select').selectOption({ label: '水吧小仓' });
    await expect(page.getByRole('list', { name: '部门小仓结存' }).getByText('宾客一次性拖鞋')).toBeVisible();
    // 领料单详情：部门待签收
    await page.goto(`/inventory/docs?doc=${issued.id}`);
    await expect(page.getByRole('dialog', { name: '库存单据详情' }).getByText('部门待签收')).toBeVisible();
    await logout(page);

    // ── 店主在「本部门小仓」替水吧签收（店主不限部门）──
    await login(page, 'linlan', '会员工作台');
    await page.goto(`/erp/dept-stock?dept=${bar.id}&view=sign`);
    await expect(page.getByTestId('dept-stock-page')).toBeVisible();
    await page.getByTestId(`dept-doc-${issued.id}`).click();
    await page.getByLabel('签收差异说明').fill('E2E：数量无误');
    await page.getByTestId('dept-sign-submit').click();
    await expect(page.getByText('E2E：数量无误')).toBeVisible();
    await page.keyboard.press('Escape');

    // ── 部门盘点：提交即生效，差异默认「耗用」──
    const stockOf = async (code: string) => ((await getJson<StockRow[]>(page, `/api/erp/dept-stock/${bar.id}/stock`)).find((r) => r.code === code)?.stockMilli ?? 0) / 1000;
    const book = await stockOf('M001');
    expect(book).toBeGreaterThanOrEqual(5);
    await page.goto(`/erp/dept-stock/new/count?dept=${bar.id}`);
    await expect(page.getByText('水吧小仓 · 新建盘点')).toBeVisible();
    await page.getByLabel('添加物料').fill('拖鞋');
    await page.keyboard.press('Enter');
    await page.keyboard.type(String(book - 1));
    await expect(page.getByText('提交即生效，库存立即更新')).toBeVisible();
    await page.getByRole('button', { name: /确认盘点/ }).click();
    await expect(page.getByText('盘点已生效')).toBeVisible();
    expect(await stockOf('M001')).toBe(book - 1);

    // ── 急采：水吧临时买 1 箱饮用水（36 元），等仓库到部门验收 ──
    const meta = await getJson<{ suppliers: { code: string; name: string }[]; urgentCapCents: number }>(page, '/api/erp/dept-stock/meta');
    const s005 = meta.suppliers.find((s) => s.code === 'S005')!;
    const waterBefore = await stockOf('M018');
    await page.goto(`/erp/dept-stock/new/receipt?dept=${bar.id}`);
    await expect(page.getByText(/急采：合计不超过/)).toBeVisible();
    await page.selectOption('#supplier', { label: `${s005.code} · ${s005.name}` });
    await page.getByLabel('添加物料').fill('饮用水');
    await page.keyboard.press('Enter');
    await page.keyboard.type('1');
    await page.getByLabel('单价（元/箱）').fill('36');
    await page.getByRole('button', { name: '提交急采' }).click();
    await expect(page.getByText('已提交，等仓库到部门验收')).toBeVisible();
    const urgent = (await getJson<{ id: number; docNo: string; status: string }[]>(page, `/api/erp/dept-stock/${bar.id}/docs?urgent=1`))[0]!;
    expect(urgent.status).toBe('submitted');
    expect(await stockOf('M018')).toBe(waterBefore);
    await logout(page);

    // ── 仓库到部门验收确认：进水吧小仓 ──
    await login(page, 'lixiao', '库存');
    await page.goto('/inventory/docs?type=receipt&urgent=1&status=submitted');
    await page.getByRole('button', { name: new RegExp(urgent.docNo) }).click();
    await page.getByTestId('verify-urgent').click();
    await expect(page.getByText('急采已验收，进部门小仓')).toBeVisible();
    await logout(page);

    // ── 部门补采购单，由本部门确认 ──
    await login(page, 'linlan', '会员工作台');
    expect(await stockOf('M018')).toBe(waterBefore + 24);
    await page.goto(`/erp/dept-stock?dept=${bar.id}&view=docs`);
    await page.getByRole('radio', { name: '急采待补单' }).click();
    await page.getByTestId(`dept-doc-${urgent.id}`).click();
    await page.getByTestId('dept-backfill').click();
    await expect(page.getByText('已补采购单，并由本部门确认')).toBeVisible();
    await expect(page.getByText('补的采购单')).toBeVisible();

    // 账实自检全 ✓（各仓结存与流水、收货都有采购单）
    const checks = await getJson<{ key: string; ok: boolean; detail: string }[]>(page, '/api/inventory/checks');
    for (const c of checks) expect(c.ok, `${c.key} ${c.detail}`).toBe(true);
  });
});

test.describe('平板布局', () => {
  test('本部门小仓与急采录入页面无横向溢出', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    const bar = (await getJson<{ id: number; name: string }[]>(page, '/api/inventory/departments')).find((d) => d.name === '水吧')!;
    for (const url of [`/erp/dept-stock?dept=${bar.id}`, `/erp/dept-stock?dept=${bar.id}&view=docs`, `/erp/dept-stock/new/receipt?dept=${bar.id}`, `/erp/dept-stock/new/count?dept=${bar.id}`]) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, url).toBeLessThanOrEqual(1);
    }
  });
});
