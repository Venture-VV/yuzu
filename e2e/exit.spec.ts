// 8.1.15 追加：平板电子菜单与设计师工作台的退出（docs/EMENU.md 第 18 节，PENDING_DECISIONS「8.1.15 追加」TC1–TC10）。
//   ① 平板电子菜单：左下角有带字的退出键；点开「退出界面」；员工的键点一下只提示「请按住」，按住约 1.5 秒才离开，
//      店主的账号回门店系统的首页；
//   ② 设计师工作台：顶栏最左边有带字的「退出」，点了回后台的「工作台」；草稿没存上时先存，存不上停下来问
//      （继续编辑 / 再存一次 / 不保存直接退出）。
// 平板的两条自己定后台的「点单密码」（关着走一遍、开着走一遍），用完放回原样：同一组里排在前面的 e2e/emenu.spec.ts 会把它打开、不关。
// 依赖演示数据（seed-demo：店主 linlan，密码 yuzu2026）。会改工作台的草稿（用完放回默认版面），只在门店电脑尺寸执行。
import { expect, test, type Page } from '@playwright/test';
import type { EmenuAdmin } from '../src/shared/emenu';
import { defaultStudioDoc, type StudioState } from '../src/shared/studio';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}

/**
 * 平板点餐的「点单密码」设成 on，返回原来的值（用完放回）。按住走满以后：开着的要一位点单的同事先输密码（TC5），关着的直接走。
 * 同一组里排在前面的 e2e/emenu.spec.ts 会把它打开、不关（那一条走的是要密码的一套），所以这里自己定，不靠演示库的默认。
 */
async function setRequirePin(page: Page, on: boolean): Promise<boolean> {
  const res = await page.request.get('/api/admin/emenu');
  expect(res.ok(), `GET /api/admin/emenu → ${res.status()}`).toBe(true);
  const admin = (await res.json()) as EmenuAdmin;
  const before = admin.rules.requirePin;
  if (before !== on) {
    const put = await page.request.put('/api/admin/emenu/rules', { data: { rev: admin.rulesRev, requirePin: on } });
    expect(put.ok(), `PUT /api/admin/emenu/rules → ${put.status()} ${await put.text()}`).toBe(true);
  }
  return before;
}

async function resetDraft(page: Page) {
  const res = await page.request.get('/api/studio/emenu');
  expect(res.ok()).toBe(true);
  const s = (await res.json()) as StudioState;
  expect((await page.request.put('/api/studio/emenu/draft', { data: { rev: s.draft.rev, doc: defaultStudioDoc('emenu') } })).ok()).toBe(true);
}

test.describe('8.1.15 平板电子菜单与工作台的退出', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸执行一次');

  test('平板电子菜单：左下角的退出键 → 退出界面 → 点一下只提示、按住才离开，回门店系统的首页', async ({ page }) => {
    await login(page, 'linlan');
    // 这一条走「不要点单密码」的一套（8.0.15 起的默认）；开着密码的那一套在下一条
    const pinBefore = await setRequirePin(page, false);
    await page.goto('/emenu');
    // 起始页、「平板点餐没有开启」「菜单取不回来」这几屏都有这个键
    const key = page.getByTestId('emenu-leave-key');
    await expect(key).toBeVisible({ timeout: 30_000 });
    await expect(key).toContainText('退出');
    await key.click();
    const sheet = page.getByTestId('emenu-leave');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('emenu-leave-who')).toContainText('现在登录的是');
    // 店主的账号有主系统：两个员工的键
    const home = sheet.getByTestId('emenu-leave-home');
    await expect(home).toContainText('返回工作台');
    await expect(sheet.getByTestId('emenu-leave-signout')).toContainText('退出登录');
    // 点一下（没按住）不离开，只提示
    await home.click();
    await expect(sheet.getByTestId('emenu-leave-hint')).toContainText('按住约 1.5 秒');
    await expect(page).toHaveURL(/\/emenu/);
    // 「留在这里」收起来，键还在
    await sheet.getByTestId('emenu-leave-stay').click();
    await expect(sheet).toHaveCount(0);
    await key.click();
    // 按住到一半松手：取消（界面是从左下角长出来的，hover 会等它停稳再把指针移上去）
    await home.hover();
    await page.mouse.down();
    await expect(home).toHaveAttribute('data-holding', '');
    await page.waitForTimeout(500);
    await page.mouse.up();
    await expect(home).not.toHaveAttribute('data-holding', '');
    await expect(page).toHaveURL(/\/emenu/);
    // 按住走满：回门店系统的首页（店主是会员工作台）
    await page.mouse.down();
    await page.waitForURL((u) => u.pathname === '/', { timeout: 15_000 });
    await page.mouse.up();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
    await setRequirePin(page, pinBefore);
  });

  test('平板电子菜单：后台开着「点单密码」时，按住走满先要一位点单的同事输密码；取消就留在菜单', async ({ page }) => {
    await login(page, 'linlan');
    const pinBefore = await setRequirePin(page, true);
    await page.goto('/emenu');
    const key = page.getByTestId('emenu-leave-key');
    await expect(key).toBeVisible({ timeout: 30_000 });
    await key.click();
    const home = page.getByTestId('emenu-leave').getByTestId('emenu-leave-home');
    await expect(home).toBeVisible();
    await home.hover();
    await page.mouse.down();
    const check = page.getByRole('dialog', { name: '员工确认' });
    await expect(check).toBeVisible({ timeout: 10_000 });
    await page.mouse.up();
    await expect(check).toContainText('点单密码');
    await expect(page).toHaveURL(/\/emenu/);
    await check.getByRole('button', { name: '取消' }).click();
    await expect(check).toHaveCount(0);
    await expect(page).toHaveURL(/\/emenu/);
    await setRequirePin(page, pinBefore);
  });

  test('设计师工作台：带字的「退出」回后台的工作台；草稿没存上时先存，存不上停下来问', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, 'linlan');
    await resetDraft(page);
    try {
      await page.goto('/studio/emenu');
      const exit = page.getByTestId('studio-exit');
      await expect(exit).toBeVisible({ timeout: 30_000 });
      await expect(exit).toHaveText('退出');
      await expect(page.getByTestId('studio-save-status')).toHaveAttribute('data-status', 'saved');
      // 没有改动：直接回后台的「工作台」
      await exit.click();
      await expect(page).toHaveURL(/\/admin\/studio$/);

      // 有改动、存不上：拦下来问
      await page.goto('/studio/emenu');
      await expect(page.getByTestId('studio-canvas')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('studio-save-status')).toHaveAttribute('data-status', 'saved');
      await page.getByTestId('studio-screen-start').click();
      await page.route('**/api/studio/emenu/draft', (route) => route.abort('failed'));
      // 画布上把字标往左上拖一下
      const layer = (await page.getByTestId('studio-canvas-layer').boundingBox())!;
      const k = layer.width / 1024;
      const from = { x: layer.x + (472.6 + 39) * k, y: layer.y + (342.8 + 38) * k };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x - 120 * k, from.y - 90 * k, { steps: 8 });
      await page.mouse.up();
      await expect(page.getByTestId('studio-save-status')).not.toHaveAttribute('data-status', 'saved');
      await exit.click();
      const dialog = page.getByTestId('studio-exit-dialog');
      await expect(dialog).toHaveAttribute('data-step', 'failed', { timeout: 30_000 });
      await expect(page).toHaveURL(/\/studio\/emenu/);
      // 继续编辑：留在这里
      await page.getByTestId('studio-exit-stay').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('studio-canvas')).toBeVisible();
      // 网络好了：再点退出，先存好再走
      await page.unroute('**/api/studio/emenu/draft');
      await exit.click();
      await expect(page).toHaveURL(/\/admin\/studio$/, { timeout: 30_000 });
      // 改动存进去了：草稿里字标不在原位
      const s = (await (await page.request.get('/api/studio/emenu')).json()) as StudioState;
      const logo = s.draft.doc.screens.start!.nodes.find((n) => n.id === 'start-logo')!;
      expect(logo.x).toBeLessThan(472);
    } finally {
      await page.unroute('**/api/studio/emenu/draft').catch(() => {});
      await resetDraft(page);
    }
  });
});
