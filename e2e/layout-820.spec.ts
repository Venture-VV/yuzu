// 8.2.0 P02（回测 2-1，docs/YUZU_REQ_V820.md 第 3 节）：门店页面左侧主导航固定、内容区独立滚动；收起时悬停弹出二级入口；
// 窄屏（1024 以下）展开是盖在内容上的抽屉，点遮罩收回。只读，不写数据。
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('8.2.0 侧边栏固定，内容区独立滚动', () => {
  test('内容区滚动时导航与页头不动，整页不滚；收起时悬停弹出二级入口', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== '门店电脑', '桌面宽度的鼠标操作');
    await page.setViewportSize({ width: 1366, height: 600 });
    await login(page);
    await page.goto('/room-center');
    const rail = page.getByTestId('store-rail');
    await expect(rail).toBeVisible();
    const before = await rail.boundingBox();
    const header = page.locator('header').first();
    const headerBefore = await header.boundingBox();
    await page.mouse.move(800, 400);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(300);
    // 整页（document）不滚：滚的只是内容区
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    expect(await rail.boundingBox()).toEqual(before);
    expect((await header.boundingBox())?.y).toBe(headerBefore?.y);
    // 导航高度撑满一屏
    expect(Math.round(before!.height)).toBe(600);
    // 收起成一列图标时，鼠标停在别的组上弹出二级入口
    if ((await rail.getAttribute('data-mode')) === 'expanded') await page.getByTestId('nav-mode-toggle').click();
    await expect(rail).toHaveAttribute('data-mode', 'collapsed');
    await page.getByTestId('nav-domain-members').locator('[data-nav-toggle]').hover();
    await expect(page.getByTestId('nav-flyout-members')).toBeVisible();
    // 点一下是留住，不是关掉
    await page.getByTestId('nav-domain-members').locator('[data-nav-toggle]').click();
    await expect(page.getByTestId('nav-flyout-members')).toBeVisible();
  });

  test('窄屏：展开是盖在内容上的抽屉，点遮罩收回', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== '门店电脑', '用桌面浏览器缩窄测一次');
    await page.setViewportSize({ width: 900, height: 900 });
    await login(page);
    await page.goto('/room-center');
    const rail = page.getByTestId('store-rail');
    await expect(rail).toHaveAttribute('data-mode', 'collapsed');
    const content = page.getByTestId('app-content');
    const contentBefore = await content.boundingBox();
    await page.getByTestId('nav-mode-toggle').click();
    await expect(rail).toHaveAttribute('data-drawer', 'open');
    await expect(rail).toHaveAttribute('data-mode', 'expanded');
    // 内容不被挤开：抽屉盖在上面
    expect((await content.boundingBox())?.x).toBe(contentBefore?.x);
    await page.getByTestId('nav-drawer-scrim').click({ position: { x: 850, y: 450 } });
    await expect(rail).toHaveAttribute('data-mode', 'collapsed');
    await expect(page.getByTestId('nav-drawer-scrim')).toHaveCount(0);
  });
});
