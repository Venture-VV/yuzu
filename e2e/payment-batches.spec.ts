// 8.0.21 浏览器验收：批量付款（docs/FINANCE_V8021.md 第 5 节，CW-D）。可重复执行。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · 供应商档案的「收款账户」（应付岗单独改，CW28）：填户名、开户行、账号 → 只看得到后四位，账号输入框空着（不发完整账号到页面）；
//     店主改的直接「已复核」；对账付款（qianfen）改的「待复核」、本人看不到复核按钮，店主复核；
//   · 付款 →「批量付款」页签：待付款的申请列表与生成按钮（演示库里没有批了待付的申请时显示空的提示）；
//   · 付款账户取不回来：写明加载失败、可以重试，不说「先建一个银行账户」（Codex 审查 76d9c72 后补）。
// 生成、导出、导入流水自动记账的整条链在 tests/payments.test.ts「批量付款（8.0.21）」里。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const stamp = String(Date.now()).slice(-6);

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  // 店主落在门店（主导航），后勤岗位（对账付款）落在 ERP（ERP 导航）
  await expect(page.getByRole('navigation', { name: /^(主导航|ERP 导航)$/ })).toBeVisible({ timeout: 30_000 });
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
    const bank = page.getByTestId('supplier-bank');
    await expect(bank.getByTestId('supplier-bank-status')).toHaveText('没有收款账户');
    await bank.getByTestId('supplier-bank-edit').click();
    await page.getByTestId('s-bank-payee').fill(`批量付款验收${stamp}`);
    await page.getByTestId('s-bank-name').fill('建设银行验收支行');
    await page.getByTestId('s-bank-account').fill('6227000011112222');
    await page.getByTestId('supplier-bank-save').click();
    await expect(page.getByText('收款账户已保存').first()).toBeVisible();
    // 店主改的直接算复核过
    await expect(bank.getByTestId('supplier-bank-status')).toHaveText('已复核');
    await expect(bank.getByText('尾号 2222')).toBeVisible();
    const list = (await (await page.request.get('/api/inventory/suppliers?all=1')).json()) as { code: string; bankAccountTail: string; bankStatus: string }[];
    expect(list.find((s) => s.code === code)).toMatchObject({ bankAccountTail: '2222', bankStatus: 'verified' });
    expect(JSON.stringify(list)).not.toContain('6227000011112222');
    // 再打开修改：账号框空着，提示尾号
    await bank.getByTestId('supplier-bank-edit').click();
    await expect(page.getByTestId('s-bank-account')).toHaveValue('');
    await expect(page.getByText('现在是尾号 2222')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // 对账付款（不是店主）改的：待复核，改的本人看不到「复核」；店主复核
    const sid = (list as unknown as { id: number; code: string }[]).find((s) => s.code === code)!.id;
    const payer = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL });
    const payerPage = await payer.newPage();
    await login(payerPage, 'qianfen');
    const changed = await payerPage.request.put(`/api/inventory/suppliers/${sid}/bank`, { data: { bankPayee: `批量付款验收${stamp}`, bankName: '建设银行验收支行', bankAccount: '6227000033334444' } });
    expect(changed.ok(), await changed.text()).toBe(true);
    await payerPage.goto('/inventory/master');
    await payerPage.getByRole('radiogroup', { name: '档案' }).getByRole('radio', { name: '供应商' }).click();
    await payerPage.getByRole('button').filter({ hasText: `批量付款验收${stamp}` }).click();
    await expect(payerPage.getByTestId('supplier-bank-status')).toHaveText('待复核');
    await expect(payerPage.getByTestId('supplier-bank-verify')).toHaveCount(0);
    await expect(payerPage.getByText('改的人自己不能复核')).toBeVisible();
    await payer.close();
    await page.reload();
    await page.getByRole('radiogroup', { name: '档案' }).getByRole('radio', { name: '供应商' }).click();
    await page.getByRole('button').filter({ hasText: `批量付款验收${stamp}` }).click();
    await expect(bank.getByTestId('supplier-bank-status')).toHaveText('待复核');
    await bank.getByTestId('supplier-bank-verify').click();
    await expect(page.getByText('收款账户已复核').first()).toBeVisible();
    await expect(bank.getByTestId('supplier-bank-status')).toHaveText('已复核');
    await page.keyboard.press('Escape');

    await page.goto('/erp/payments?tab=batches');
    await expect(page.getByTestId('payments-tab-batches')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('batches-tab')).toBeVisible();
  });

  test('批量付款的付款账户取不回来：写明加载失败、可以重试，不说「先建一个银行账户」', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    await page.route('**/api/erp/bank?status=open', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: '服务暂时不可用' } }) }));
    await page.goto('/erp/payments?tab=batches');
    await expect(page.getByTestId('batches-tab')).toBeVisible();
    const failed = page.getByTestId('batch-accounts-error');
    await expect(failed).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('batches-tab')).not.toContainText('先建一个银行账户');
    await page.unroute('**/api/erp/bank?status=open');
    await failed.getByTestId('batch-accounts-error-retry').click();
    await expect(page.getByTestId('batch-accounts-error')).toHaveCount(0, { timeout: 20_000 });
  });
});
