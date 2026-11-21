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
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('nav-flyout-members')).toBeHidden();
    // 悬停弹出后，鼠标慢慢走进弹出层（经过中间的空隙）：弹出层留着（Codex 审查 f1e5186 的 P2）
    const toggle = page.getByTestId('nav-domain-finance').locator('[data-nav-toggle]');
    await toggle.hover();
    const flyout = page.getByTestId('nav-flyout-finance');
    await expect(flyout).toBeVisible();
    const t = (await toggle.boundingBox())!;
    const f = (await flyout.boundingBox())!;
    await page.mouse.move(f.x + 30, t.y + t.height / 2, { steps: 12 });
    await page.mouse.move(f.x + 30, f.y + f.height / 2, { steps: 6 });
    await page.waitForTimeout(500);
    await expect(flyout).toBeVisible();
    // 移出这一组：稍等收起
    await page.mouse.move(900, 400);
    await expect(flyout).toBeHidden();
    // 左下角的用户菜单整个看得到（导航不裁掉弹出的菜单，Codex 审查 f1e5186 的 P1）
    await page.getByTestId('user-menu').click();
    const logout = page.getByRole('menuitem', { name: '退出登录' });
    await expect(logout).toBeVisible();
    expect(
      await logout.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return !!hit && (hit === el || el.contains(hit));
      }),
    ).toBe(true);
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
