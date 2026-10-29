// R1.5 期初导入：中文 Excel / WPS 默认存的 GBK 文件自动识别；填 EBC 控制总数后逐项比对，不一致不能导入。
// 只预览、不导入（演示库里不写期初）。手机号 199000099xx 不与演示会员重复。
import { expect, test, type Page } from '@playwright/test';

// 「姓名,手机号,本金,赠金,累计充值 / 验收甲,19900009901,100,20,1000 / 验收乙,19900009902,50.5,0,500」按 GBK 存
const GBK_CSV = Buffer.from(
  'd0d5c3fb2ccad6bbfabac52cb1bebdf02cd4f9bdf02cc0dbbcc6b3e4d6b50d0ad1e9cad5bcd72c31393930303030393930312c3130302c32302c313030300d0ad1e9cad5d2d22c31393930303030393930322c35302e352c302c3530300d0a',
  'hex',
);

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('期初导入：编码识别与 EBC 控制总数', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '在门店电脑尺寸执行一次');

  test('GBK 文件自动识别；控制总数一致才能导入，不一致时写明差额', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/opening');
    const card = page.getByTestId('opening-import');
    // 控制总数：2 位，本金 150.50，赠金 20，累计充值 1500
    await card.getByTestId('opening-control-count').fill('2');
    await card.getByTestId('opening-control-principal').fill('150.50');
    await card.getByTestId('opening-control-bonus').fill('20');
    await card.getByTestId('opening-control-legacyRecharged').fill('1,500');
    await card.getByTestId('opening-file').setInputFiles({ name: 'ebc-gbk.csv', mimeType: 'text/csv', buffer: GBK_CSV });

    await expect(card.getByText('ebc-gbk.csv（GBK 编码，已自动识别）')).toBeVisible();
    const preview = card.getByTestId('opening-preview');
    await expect(preview).toContainText('验收甲');
    await expect(card.getByTestId('opening-control')).toContainText('四项一致');
    await card.getByText(/我已核对/).click();
    await expect(card.getByTestId('opening-confirm')).toBeEnabled();

    // 本金控制总数改成 150.62：不一致，不能导入
    await card.getByTestId('opening-control-principal').fill('150.62');
    await card.getByTestId('opening-control-principal').blur();
    await expect(card.getByTestId('opening-control')).toContainText('与 EBC 控制总数不一致，不能导入');
    await expect(card.getByTestId('opening-control')).toContainText('本金：导入 ¥150.50，控制总数 ¥150.62，少 ¥0.12');
    await card.getByText(/我已核对/).click();
    await expect(card.getByTestId('opening-confirm')).toBeDisabled();
  });
});
