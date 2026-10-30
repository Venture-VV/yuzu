// 测试服交互层 E2E 报告（PR #15 评论，测的是 v0.4.1）在 v0.6.0 上的回归：
//   · BUG-2：结账时「客人实给」少于现金金额，不能结清，底部写明原因（改成足额后才能结清）；
//   · 响应头带 x-content-type-options: nosniff。
// 会改数据（接待一位散客并结账），只在门店电脑尺寸执行；每次挑一张空闲的男宾普通柜，可重复执行。
// 账号：值班经理 zhangjl，密码 yuzu2026。BUG-1（小屏电脑主导航）与流水页手机宽度在 viewports.spec.ts。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('测试服 E2E 报告的回归', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');

  test('结账：客人实给少于现金时不能结清，底部写明原因；改成足额后结清', async ({ page }) => {
    await login(page, 'zhangjl');
    const cur = (await (await page.request.get('/api/shifts/current')).json()) as { shift: unknown };
    if (!cur.shift) expect((await page.request.post('/api/shifts', { data: { openingCash: 0 } })).ok()).toBe(true);
    type Tag = { code: string; zone: string; kind: string; active: boolean; locked: boolean; visit: unknown };
    const tags = ((await (await page.request.get('/api/frontdesk/board')).json()) as { tags: Tag[] }).tags;
    const tag = [...tags].reverse().find((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)!;
    const checkin = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: tag.code, zone: 'male' }] } });
    expect(checkin.status()).toBe(201);

    await page.goto('/frontdesk');
    await page.getByTestId(`tag-${tag.code}`).click();
    const panel = page.getByTestId('bill-panel');
    await expect(panel.getByTestId('bill-tag')).toHaveText(tag.code);
    await panel.getByTestId('action-checkout').click();
    await page.getByTestId('pay-add-cash').click();
    const submit = page.getByTestId('checkout-submit');
    await expect(submit).toBeEnabled();
    const tendered = page.getByLabel('客人实给现金');
    await tendered.fill('1');
    await expect(submit).toBeDisabled();
    await expect(page.getByTestId('checkout-row-problem')).toContainText('客人实给少于这笔现金');
    await tendered.fill('1000');
    await expect(page.getByTestId('checkout-row-problem')).toHaveCount(0);
    await expect(submit).toBeEnabled();
    await expect(page.getByTestId('pay-row-cash')).toContainText('找零');
    await submit.click();
    await expect(page.getByTestId('checkout-receipt')).toBeVisible();
    await page.getByTestId('checkout-finish').click();
  });

  test('响应头带 x-content-type-options: nosniff', async ({ page }) => {
    for (const url of ['/login', '/api/health', '/api/public/info']) {
      const res = await page.request.get(url);
      expect(res.headers()['x-content-type-options'], url).toBe('nosniff');
    }
  });
});
