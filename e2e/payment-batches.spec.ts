// 8.0.21 浏览器验收：批量付款（docs/FINANCE_V8021.md 第 5 节，CW-D）。可重复执行。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · 供应商档案填收款户名、开户行、账号 → 保存以后只看得到后四位，账号输入框空着（不发完整账号到页面）；
//   · 付款 →「批量付款」页签：待付款的申请列表与生成按钮（演示库里没有批了待付的申请时显示空的提示）。
// 生成、导出、导入流水自动记账的整条链在 tests/payments.test.ts「批量付款（8.0.21）」里。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const stamp = String(Date.now()).slice(-6);

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('8.0.21 批量付款', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('供应商收款账户只显示后四位；付款页有「批量付款」页签', async ({ page }) => {
    await login(page);
    const code = `BK${stamp}`;
    const created = await page.request.post('/api/inventory/suppliers', { data: { code, name: `批量付款验收${stamp}` } });
    expect(created.ok(), await created.text()).toBe(true);
    await page.goto('/inventory/master');
    await page.getByRole('radiogroup', { name: '档案' }).getByRole('radio', { name: '供应商' }).click();
    await page.getByRole('button').filter({ hasText: `批量付款验收${stamp}` }).click();
    await page.getByTestId('s-bank-payee').fill(`批量付款验收${stamp}`);
    await page.getByTestId('s-bank-name').fill('建设银行验收支行');
    await page.getByTestId('s-bank-account').fill('6227000011112222');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('供应商已保存')).toBeVisible();
    const list = (await (await page.request.get('/api/inventory/suppliers?all=1')).json()) as { code: string; bankAccountTail: string }[];
    expect(list.find((s) => s.code === code)!.bankAccountTail).toBe('2222');
    expect(JSON.stringify(list)).not.toContain('6227000011112222');
    // 再打开：账号框空着，提示尾号
    await page.getByRole('button').filter({ hasText: `批量付款验收${stamp}` }).click();
    await expect(page.getByTestId('s-bank-account')).toHaveValue('');
    await expect(page.getByText('现在是尾号 2222')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.goto('/erp/payments?tab=batches');
    await expect(page.getByTestId('payments-tab-batches')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('batches-tab')).toBeVisible();
  });
});
