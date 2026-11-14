// 8.0.21 浏览器验收：银行流水（docs/FINANCE_V8021.md 第 4 节，CW-C）。可重复执行（账户名、流水号带这一次的时间）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · ERP → 银行流水：新增账户（只填后四位）→ 导入一份工商格式的 CSV（自动认列、预览）→ 两条流水出现在「没对上」；
//   · 打开结息那条 →「不用对」点快捷原因 → 到「不用对」里；同一份文件再导，预览提示已经导入过。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const stamp = String(Date.now()).slice(-7);

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('8.0.21 银行流水', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('新增账户 → 导入对账单（自动认列）→ 结息标「不用对」→ 同一份文件再导被拦', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const today = ((await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string }).calendarToday;
    await page.goto('/erp/bank');
    await page.getByTestId('bank-account-new').click();
    await page.getByTestId('ba-name').fill(`验收户${stamp}`);
    await page.getByTestId('ba-bank').fill('工商银行验收支行');
    await page.getByTestId('ba-tail').fill('8866');
    await page.getByTestId('bank-account-save').click();
    await expect(page.getByText('账户已保存')).toBeVisible();

    const csv = [
      '交易日期,摘要,借方发生额,贷方发生额,余额,对方户名,对方账号,交易流水号',
      `${today},结息,,1.23,100001.23,,,E2E${stamp}A`,
      `${today},货款,4321.00,,95680.23,验收供应商${stamp},6222000000000000,E2E${stamp}B`,
    ].join('\n');
    await page.getByTestId('bank-import').click();
    const dialog = page.getByTestId('bank-import-dialog');
    await dialog.locator('#bi-account').selectOption({ label: `验收户${stamp} · 尾号 8866` });
    await dialog.getByTestId('bank-import-file').setInputFiles({ name: `icbc-${stamp}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await expect(dialog).toContainText('认出 2 条流水');
    await expect(dialog.getByLabel('日期')).toHaveValue('交易日期');
    await page.getByTestId('bank-import-confirm').click();
    await expect(page.getByText('导入了 2 条流水')).toBeVisible();

    const interest = page.getByTestId(`bank-line-E2E${stamp}A`);
    await expect(interest).toContainText('没对上');
    await interest.click();
    const sheet = page.getByTestId('bank-line-sheet');
    await sheet.getByTestId('bank-ignore').click();
    await page.getByRole('dialog', { name: '这条流水不用对' }).getByRole('button', { name: '存款利息' }).click();
    await page.getByRole('dialog', { name: '这条流水不用对' }).getByRole('button', { name: '不用对' }).click();
    await expect(page.getByText('已标不用对')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('bank-view-ignored').click();
    await expect(page.getByTestId(`bank-line-E2E${stamp}A`)).toContainText('不用对');

    // 同一份文件再导：预览提示已经导入过，导入按钮点不了
    await page.getByTestId('bank-import').click();
    await dialog.locator('#bi-account').selectOption({ label: `验收户${stamp} · 尾号 8866` });
    await dialog.getByTestId('bank-import-file').setInputFiles({ name: `icbc-${stamp}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await expect(dialog).toContainText('这份文件已经导入过了');
    await expect(page.getByTestId('bank-import-confirm')).toBeDisabled();
  });
});
