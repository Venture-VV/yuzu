// v0.7.10 浏览器验收（8–10 月旧账只读对照，见 docs/LEGACY_LEDGER.md）：
//   旧账合成样例（seed-legacy-demo）导入后，ERP「费用与备用金 → 旧账对照」常显「不进正式账」；核验的数与
//   src/server/demo/legacy-expected.json 一致；点开第 3 条里不平的日子跳到付款台账并高亮那一行；已下单物料显示原图；
//   品牌清单的链接只放行 http(s)（超链接或格里写的网址；只写了名称的算没有链接）。另：班次从前一个营业日开到现在时，交班页与前台提醒先交班（接口返回模拟的跨日班次）。
// 依赖五套演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。数据流程只在门店电脑尺寸执行。
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const expected = JSON.parse(readFileSync(new URL('../src/server/demo/legacy-expected.json', import.meta.url), 'utf8')) as {
  rules: Record<string, number | null>;
  daily: { unbalanced: number; tail: number; diffs: Record<string, number> };
  ledger: { rows: number };
};

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

test.describe('旧账对照（8–10 月）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '核对流程只在门店电脑尺寸执行一次');

  test('核验与固定预期一致；点开不平的日子跳到付款台账；已下单物料显示原图；只读不进正式账', async ({ page }) => {
    await login(page, 'linlan');
    const audit = (await (await page.request.get('/api/erp/legacy/audit')).json()) as { imported: string[] };
    test.skip(audit.imported.length === 0, '这个演示库没有执行 seed-legacy-demo');

    await page.goto('/erp/expenses');
    await page.getByTestId('legacy-link').click();
    await expect(page).toHaveURL(/\/erp\/legacy$/);
    const root = page.getByTestId('legacy-page');
    await expect(root).toContainText('不进正式账');
    await expect(page.getByTestId('legacy-daily')).toContainText(`${expected.daily.unbalanced} 天不平`);
    for (const [date, diff] of Object.entries(expected.daily.diffs)) {
      const day = page.getByTestId(`legacy-day-${date}`);
      await expect(day).toBeVisible();
      if (diff === 0) await expect(day).toContainText('平');
    }
    for (const [no, count] of Object.entries(expected.rules)) {
      await expect(page.getByTestId(`legacy-rule-${no}`)).toContainText(count === null ? '无法核对' : count === 0 ? '没有问题' : `${count} 条`);
    }

    // 第 3 条点开：差额最大的那天（2026-09-02，+¥100.00）→ 付款台账里高亮那一行
    await page.getByTestId('legacy-rule-row-3').getByRole('button').first().click();
    await page.getByRole('button', { name: /2026-09-02：差额 \+¥100\.00/ }).click();
    await expect(page).toHaveURL(/tab=payments&row=Sheet2%3A4|tab=payments&row=Sheet2:4/);
    await expect(page.getByTestId('legacy-payments')).toContainText('表里自带的合计');
    await expect(page.getByTestId('legacy-row-r-Sheet2:4')).toHaveClass(/bg-yuzu-soft/);

    // 采购台账：推定的打款、合并的金额格；看原表
    await page.getByTestId('legacy-tab-ledger').click();
    const ledger = page.getByTestId('legacy-ledger');
    await expect(ledger.locator('li[data-testid^="legacy-row-"]')).toHaveCount(expected.ledger.rows + 1);
    await expect(page.getByTestId('legacy-row-r-Sheet1:9')).toContainText('金额与第 8 行合并');
    await page.getByTestId('legacy-row-r-Sheet1:15').getByRole('button', { name: '看原表' }).click();
    await expect(page.getByTestId('legacy-row-r-Sheet1:15')).toContainText('=-1500-500');
    // 没存结果的公式按精确的十进制算：=64.005-18.51 是 ¥45.50（不是 ¥45.49）
    await expect(page.getByTestId('legacy-row-r-Sheet1:7')).toContainText('¥45.50');

    // 已下单物料：原图能打开
    await page.getByTestId('legacy-tab-ordered').click();
    const img = page.getByTestId('legacy-ordered').getByRole('img').first();
    await expect(img).toBeVisible();
    // 图片可能还在加载：等到加载完再看尺寸
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);

    // 品牌清单：链接只放行 http(s)，新窗口打开
    await page.getByTestId('legacy-tab-brand').click();
    const link = page.getByTestId('legacy-brand').getByRole('link').first();
    await expect(link).toHaveAttribute('href', /^https:\/\/example\.com\/sample\//);
    await expect(link).toHaveAttribute('rel', /noopener/);
    // 网址写在分享文字里也能点开；只写了店铺名称的标「没有链接」
    await expect(page.getByTestId('legacy-row-r-工作表1:5').getByRole('link')).toHaveAttribute('href', 'https://example.com/sample/3');
    await expect(page.getByTestId('legacy-row-r-工作表1:6')).toContainText('没有链接');
    await expect(page.getByTestId('legacy-row-r-工作表1:6').getByRole('link')).toHaveCount(0);

    // 只读：没有任何改动旧账的接口；正式的采购台账里没有旧账的单
    expect((await page.request.post('/api/erp/legacy/imports', { data: {} })).status()).toBe(404);
    const ledgerApi = (await (await page.request.get('/api/erp/ledger?from=2026-08-01&to=2026-10-31')).json()) as { days: { entries: { description: string }[] }[] };
    expect(ledgerApi.days.flatMap((d) => d.entries).some((e) => e.description.startsWith('样例-'))).toBe(false);
  });

  test('点核验里的行：原表还在加载时也能跳到那一行（Codex PR #26）', async ({ page }) => {
    await login(page, 'linlan');
    const audit = (await (await page.request.get('/api/erp/legacy/audit')).json()) as { imported: string[] };
    test.skip(audit.imported.length === 0, '这个演示库没有执行 seed-legacy-demo');
    // 矮一点的窗口：第 15 行在第一屏之外；原表接口慢一点：点开时那一行还没画出来
    await page.setViewportSize({ width: 1440, height: 520 });
    await page.route('**/api/erp/legacy/rows/purchase_ledger', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });
    // 直接打开核验里点出来的链接（刷新页面、转发链接同样）：原表接口返回之前那一行还不存在
    await page.goto('/erp/legacy?tab=ledger&row=Sheet1%3A15');
    const row = page.getByTestId('legacy-row-r-Sheet1:15');
    await expect(row).toHaveClass(/bg-yuzu-soft/);
    await expect(row).toBeInViewport();
  });

  test('班次从前一个营业日开到现在：交班页与前台提醒先交班（只提醒、不拦截）', async ({ page }) => {
    await login(page, 'linlan');
    const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string; staff: { id: number; displayName: string } };
    const yesterday = new Date(Date.parse(`${me.today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const shift = {
      id: 999_001, shiftNo: 'BC-E2E-0001', staffId: me.staff.id, staffName: me.staff.displayName, status: 'open', businessDate: yesterday,
      startedAt: `${yesterday}T10:00:00.000Z`, openingCash: 50_000, endedAt: null, expectedCash: null, countedCash: null, note: '',
      handedToName: null, closedByName: null,
      summary: { byMethod: [], checkouts: 0, checkoutTotal: 0, recharges: 0, rechargePaid: 0, refunds: [], expectedCash: 50_000, deposits: [] },
    };
    await page.route('**/api/shifts/current', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shift }) }));
    const [, m, d] = yesterday.split('-');
    const title = `这个班次从 ${Number(m)} 月 ${Number(d)} 日开到现在，请先交班`;
    await page.goto('/frontdesk');
    await expect(page.getByTestId('shift-cross-day')).toContainText(title);
    await page.unroute('**/api/shifts/current');

    // 当天开的班不提醒
    await page.route('**/api/shifts/current', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shift: { ...shift, businessDate: me.today } }) }),
    );
    await page.goto('/frontdesk');
    await expect(page.getByRole('heading', { name: /前台/ })).toBeVisible();
    await expect(page.getByTestId('shift-cross-day')).toHaveCount(0);
    await page.unroute('**/api/shifts/current');

    // 页面一直开着、过了营业日切换时间：登录时记下的营业日过时了，按当班接口（每 30 秒轮询）带回的营业日提醒
    const tomorrow = new Date(Date.parse(`${me.today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await page.route('**/api/shifts/current', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shift: { ...shift, businessDate: me.today }, today: tomorrow }) }),
    );
    const [, tm, td] = me.today.split('-');
    await page.goto('/frontdesk');
    await expect(page.getByTestId('shift-cross-day')).toContainText(`这个班次从 ${Number(tm)} 月 ${Number(td)} 日开到现在，请先交班`);
    await expect(page.getByTestId('shift-cross-day')).toContainText(`今天是 ${tomorrow}`);
    await page.unroute('**/api/shifts/current');
  });
});
