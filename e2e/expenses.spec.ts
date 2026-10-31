// v0.7.7 费用报销与备用金浏览器验收（飞书需求 RQ-005 第一步，见 docs/EXPENSES.md）：
//   店主在 ERP「费用与备用金」登记打款 → 从打款「用这笔钱登记报销」（按次、无票）→ 报销登记即确认
//   → 回到打款登记退回（金额默认是未退回）→ 这笔打款已平，每日平账里也是已平；自检全部通过。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。只在门店电脑尺寸执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

test.describe('费用与备用金', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('登记打款 → 用这笔钱报销 → 登记退回，打款已平', async ({ page }) => {
    await login(page, 'linlan');
    // 部门档案：没有就建一个
    let depts = (await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[];
    if (depts.length === 0) {
      await page.request.post('/api/inventory/departments', { data: { name: '采购部' } });
      depts = (await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[];
    }
    const dept = depts[0]!;

    await page.goto('/erp/petty');
    await expect(page.getByTestId('petty-page')).toBeVisible();
    await page.getByTestId('advance-new').click();
    await page.getByTestId('adv-dept').selectOption(String(dept.id));
    await page.getByTestId('adv-handler').selectOption({ label: '林岚' });
    await page.getByTestId('adv-amount').fill('500');
    await page.getByTestId('adv-evidence').fill('微信转账尾号 E2E1');
    await page.getByTestId('advance-submit').click();

    const sheet = page.getByTestId('advance-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('advance-balance')).toContainText('500.00');
    const advanceId = Number(new URL(page.url()).searchParams.get('advance'));
    expect(advanceId).toBeGreaterThan(0);

    // 用这笔钱登记报销：部门、打款带过来；无票的税点只有 0，自动选上
    await page.getByRole('button', { name: '用这笔钱登记报销' }).click();
    await expect(page.getByTestId('claim-form')).toBeVisible();
    await expect(page.getByTestId('ex-advance')).toHaveValue(String(advanceId));
    await page.getByTestId('ex-purpose').selectOption('办公');
    await page.getByTestId('ex-invoice').selectOption({ label: '无票' });
    await expect(page.getByTestId('ex-tax')).toHaveValue('0');
    await page.getByTestId('line-name-0').fill('打印纸');
    await page.getByTestId('line-cat-0').selectOption('office');
    await page.getByTestId('line-unit-0').fill('包');
    await page.getByTestId('line-amount-0').fill('120');
    await expect(page.getByTestId('claim-approval-hint')).toHaveText('不超过门槛，登记即确认');
    await page.getByTestId('claim-submit').click();

    await expect(page).toHaveURL(/\/erp\/expenses\?claim=\d+/);
    const claimSheet = page.getByTestId('claim-sheet');
    await expect(claimSheet).toContainText('已确认');
    await expect(claimSheet).toContainText('打印纸');

    // 回到打款：未退回 380，登记退回（金额默认就是未退回）
    await page.goto(`/erp/petty?advance=${advanceId}`);
    await expect(page.getByTestId('advance-balance')).toContainText('380.00');
    await page.getByTestId('advance-return').click();
    await expect(page.getByTestId('settle-amount')).toHaveValue('380');
    await page.getByTestId('settle-evidence').fill('现金当面点清');
    await page.getByTestId('settle-submit').click();
    await expect(page.getByTestId('advance-balance')).toContainText('已平');

    // 每日平账：这一行已平
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(`advance-row-${advanceId}`)).toContainText('已平');

    const checks = (await (await page.request.get('/api/erp/expenses/checks')).json()) as { label: string; ok: boolean }[];
    for (const c of checks) expect(c.ok, c.label).toBe(true);
  });
});
