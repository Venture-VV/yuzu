// 8.0.21 浏览器验收：扫码收款（docs/INTEGRATIONS_V8021.md 第 2 节，CW-G）。
// 应用要带 INTEGRATIONS_MOCK=true 启动（只许开发、测试实例）；没带时整组跳过。付款码尾号 8888 直接到账。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · 接待一位客人 → 结账加一笔「微信」→「扫码收款」扫码 → 这一笔锁定为已扫码到账 → 结清，收款参考号是支付方单号；
//   · 收了钱没入账的一笔（接口造）→ 前台顶上提示 → 去处理 → 原路退回 → 提示消失；
//   · 「收了钱没入账」取不回来：前台顶上写明查不到、可以重试（Codex 审查 0edd8df 后补）。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const authCode = () => `1345${String(Date.now()).slice(-10)}8888`;

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function ensureShift(page: Page) {
  const cur = (await (await page.request.get('/api/shifts/current')).json()) as { shift: unknown };
  if (!cur.shift) expect((await page.request.post('/api/shifts', { data: { openingCash: 0 } })).ok()).toBe(true);
}

test.describe('8.0.21 扫码收款', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('结账「扫码收款」：扫码到账、这一笔锁定、结清；收了钱没入账的在前台顶上原路退回', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const status = (await (await page.request.get('/api/pay/terminal/status')).json()) as { mode: string; enabled: boolean };
    test.skip(status.mode !== 'mock', '应用没有带 INTEGRATIONS_MOCK=true 启动（只在开发、测试实例）');
    await ensureShift(page);

    await page.goto('/frontdesk');
    const free = page.locator('[data-testid^="tag-"][data-state="free"]').first();
    const tag = ((await free.getAttribute('data-testid')) ?? '').replace(/^tag-/, '');
    const checkin = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: tag.startsWith('B') ? 'female' : 'male' }] } });
    expect(checkin.status(), await checkin.text()).toBe(201);
    await page.reload();
    await page.getByTestId(`tag-${tag}`).click();
    const panel = page.getByTestId('bill-panel');
    await expect(panel.getByTestId('bill-tag')).toHaveText(tag);
    await panel.getByTestId('action-checkout').click();
    await page.getByTestId('pay-add-wechat').click();
    await page.getByTestId('pay-row-wechat').getByTestId('scan-pay-wechat').click();
    const dialog = page.getByRole('dialog').filter({ hasText: '微信扫码收款' });
    await dialog.getByTestId('scan-pay-code').fill(authCode());
    await dialog.getByTestId('scan-pay-submit').click();
    await expect(page.getByTestId('pay-row-wechat').getByTestId('scan-pay-attached')).toBeVisible();
    await expect(page.getByLabel('微信金额')).toBeDisabled();
    await page.getByTestId('checkout-submit').click();
    await expect(page.getByText(/已结清 · /)).toBeVisible();
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('checkout-print').click()]);
    const id = Number(/\/print\/checkout\/(\d+)/.exec(popup.url())![1]);
    await popup.close().catch(() => {});
    const checkout = (await (await page.request.get(`/api/frontdesk/checkouts/${id}`)).json()) as { payments: { method: string; ref: string }[] };
    expect(checkout.payments[0]).toMatchObject({ method: 'wechat' });
    expect(checkout.payments[0]!.ref).toMatch(/^MOCKYZP/);
    await page.getByTestId('checkout-finish').click();

    // 收了钱没入账的一笔
    const loose = await page.request.post('/api/pay/terminal', { data: { clientKey: randomUUID(), provider: 'alipay', purpose: 'checkout', amountCents: 1_234, authCode: authCode() } });
    expect(loose.status(), await loose.text()).toBe(201);
    const looseId = ((await loose.json()) as { id: number }).id;
    await page.reload();
    await expect(page.getByTestId('unsettled-pay-banner')).toContainText('收了钱没入账');
    await page.getByTestId('unsettled-pay-open').click();
    await page.getByTestId(`pay-refund-${looseId}`).click();
    await page.getByTestId('pay-refund-reason').fill('客人改用现金');
    await page.getByTestId('pay-refund-confirm').click();
    await expect(page.getByText('已提交原路退回')).toBeVisible();
    const tx = (await (await page.request.get(`/api/pay/terminal/${looseId}`)).json()) as { refunds: { status: string }[] };
    expect(tx.refunds[0]!.status).toBe('done');
  });

  test('「收了钱没入账」取不回来：前台顶上写明查不到、可以重试', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const status = (await (await page.request.get('/api/pay/terminal/status')).json()) as { mode: string };
    test.skip(status.mode !== 'mock', '应用没有带 INTEGRATIONS_MOCK=true 启动（只在开发、测试实例）');
    await page.route('**/api/pay/terminal/open', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: '服务暂时不可用' } }) }));
    await page.goto('/frontdesk');
    const failed = page.getByTestId('unsettled-pay-error');
    await expect(failed).toBeVisible({ timeout: 20_000 });
    await expect(failed).toContainText('收了钱没入账的扫码收款查不到');
    await page.unroute('**/api/pay/terminal/open');
    await failed.getByTestId('unsettled-pay-error-retry').click();
    await expect(page.getByTestId('unsettled-pay-error')).toHaveCount(0, { timeout: 20_000 });
  });
});
