// 8.0.21 浏览器验收：平台验券（docs/INTEGRATIONS_V8021.md 第 3 节，CW-H）。
// 应用要带 INTEGRATIONS_MOCK=true 启动（只许开发、测试实例）；没带时整组跳过。模拟的美团券面值 ¥99。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · 接待一位客人 → 结账加一笔团购券，选美团、填券码、点「验券」→ 看到项目与面值 → 确认核销 → 这一行锁定 → 余下现金结清；
//   · 验过没结账的一张（接口造）→ 前台顶上提示 → 撤销核销 → 提示消失；
//   · 平台核销补录页「验券对账」：手动对今天的账，看到对账记录。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const stamp = String(Date.now()).slice(-8);

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('8.0.21 平台验券', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('结账「验券」→ 核销 → 这一行锁定、结清；验过没结账的撤销核销；验券对账', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const status = (await (await page.request.get('/api/platform/verify/status')).json()) as { mode: string };
    test.skip(status.mode !== 'mock', '应用没有带 INTEGRATIONS_MOCK=true 启动（只在开发、测试实例）');
    const cur = (await (await page.request.get('/api/shifts/current')).json()) as { shift: unknown };
    if (!cur.shift) expect((await page.request.post('/api/shifts', { data: { openingCash: 0 } })).ok()).toBe(true);

    await page.goto('/frontdesk');
    const free = page.locator('[data-testid^="tag-"][data-state="free"]').first();
    const tag = ((await free.getAttribute('data-testid')) ?? '').replace(/^tag-/, '');
    const checkin = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: tag.startsWith('B') ? 'female' : 'male' }] } });
    expect(checkin.status(), await checkin.text()).toBe(201);
    await page.reload();
    await page.getByTestId(`tag-${tag}`).click();
    await page.getByTestId('bill-panel').getByTestId('action-checkout').click();
    await page.getByTestId('pay-add-coupon').click();
    await page.getByLabel('团购平台').selectOption('meituan');
    await page.getByTestId('coupon-code').fill(`E2EV${stamp}1001`);
    await page.getByTestId('voucher-verify').click();
    await expect(page.getByTestId('voucher-preview')).toContainText('¥99.00');
    await page.getByTestId('voucher-verify-confirm').click();
    await expect(page.getByTestId('voucher-attached')).toBeVisible();
    await expect(page.getByLabel('团购券金额')).toHaveValue('99');
    await page.getByTestId('pay-add-cash').click(); // 现金默认填剩下的
    await page.getByTestId('checkout-submit').click();
    await expect(page.getByText(/已结清 · /)).toBeVisible();
    await page.getByTestId('checkout-finish').click();

    // 验过没结账的一张
    const code = `E2EV${stamp}2002`;
    const prep = (await (await page.request.post('/api/platform/verify/prepare', { data: { platform: 'meituan', code } })).json()) as { faceCents: number };
    expect((await page.request.post('/api/platform/verify', { data: { clientKey: randomUUID(), platform: 'meituan', code, expectedFaceCents: prep.faceCents } })).status()).toBe(201);
    await page.reload();
    await expect(page.getByTestId('unused-vouchers-banner')).toBeVisible();
    await page.getByTestId('unused-vouchers-open').click();
    const row = page.getByTestId('unused-vouchers-list').locator('li').filter({ hasText: code });
    await row.getByRole('button', { name: '撤销核销' }).click();
    await page.getByTestId('voucher-cancel-reason').fill('客人不用了');
    await page.getByTestId('voucher-cancel-confirm').click();
    await expect(page.getByText('已撤销核销')).toBeVisible();

    // 验券对账
    await page.goto('/platform');
    await page.getByRole('radio', { name: '验券对账' }).click();
    await page.getByTestId('voucher-recon-run').click();
    await expect(page.getByText(/对完了：\d+ 处差异/)).toBeVisible();
    await expect(page.getByTestId('voucher-recon')).toContainText('美团');
  });
});
