// 8.0.16 浏览器验收：动效套件（docs/UI_V8016.md）。只读（不保存任何东西），可重复执行；
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · 弹窗关掉：页面逻辑马上卸掉（没有 role=dialog 了、后面的页面马上能点），另留一个影子播退场，一会儿自己删掉；
//   · 影子在关着的容器里：按文字、按角色都找不到它（弹窗标题与页面按钮同名时不会变成两个）；
//   · 系统「减少动态效果」：不留影子；
//   · 分段开关的滑块、后台导航里当前分区的底块跟着当前项。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

/** 影子容器上记的数：现在有几个影子、一共留过几个（容器是关着的，里面的东西从外面数不到） */
const ghosts = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-mo-ghosts]');
    return { now: Number(host?.dataset.count ?? 0), total: Number(host?.dataset.total ?? 0) };
  });

test.describe('8.0.16 动效套件', () => {
  test('弹窗关掉：马上卸掉、后面的页面马上能点；影子播完自己删掉，按文字和角色都找不到它', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '后台页面的流程，只跑一次');
    await login(page, 'linlan');
    await page.goto('/admin/staff');
    const open = page.getByRole('button', { name: '添加员工', exact: true });
    await open.click();
    const dialog = page.getByRole('dialog', { name: '添加员工' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('登录账号').fill('motion-probe');
    const before = await ghosts(page);

    // 关掉的那一刻：页面上已经没有弹窗（不等动画），影子多了一个
    await page.keyboard.press('Escape');
    expect(await page.getByRole('dialog').count()).toBe(0);
    await expect.poll(async () => (await ghosts(page)).total).toBe(before.total + 1);
    // 影子认不到：弹窗的标题与页面上的按钮都叫「添加员工」，按文字找仍然只有按钮那一个；刚才填的字、输入框都找不到
    await expect(page.getByText('添加员工', { exact: true })).toHaveCount(1);
    await expect(page.getByLabel('登录账号')).toHaveCount(0);
    await expect(page.locator('input[value="motion-probe"]')).toHaveCount(0);
    // 后面的页面马上能点：不用等退场播完，再点一次就是新的弹窗（空的，不带刚才填的字）
    await open.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('登录账号')).toHaveValue('');
    expect(await page.getByRole('dialog').count()).toBe(1);
    // 影子一会儿自己删掉
    await expect.poll(async () => (await ghosts(page)).now, { timeout: 3000 }).toBe(0);
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await ghosts(page)).total).toBe(before.total + 2);
    await expect.poll(async () => (await ghosts(page)).now, { timeout: 3000 }).toBe(0);
  });

  test('系统「减少动态效果」：关弹窗不留影子，功能照常', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '后台页面的流程，只跑一次');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page, 'linlan');
    await page.goto('/admin/staff');
    await page.getByRole('button', { name: '添加员工', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加员工' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(200);
    expect((await ghosts(page)).total).toBe(0);
  });

  test('滑块跟着当前项：分段开关的白色滑块、后台导航里当前分区的底块', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '后台页面的流程，只跑一次');
    await login(page, 'linlan');
    await page.goto('/admin/emenu');
    await page.getByTestId('subnav-settings').click();
    const group = page.getByTestId('emenu-admin-settings').getByRole('radiogroup', { name: '动效' });
    const thumb = group.locator('.mo-indicator');
    /** 滑块与选中的那一格重合（差不到 1 像素） */
    const covers = async (name: string) => {
      const a = await thumb.boundingBox().catch(() => null);
      const b = await group.getByRole('radio', { name }).boundingBox();
      return !!a && !!b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
    };
    const checked = async () => ((await group.getByRole('radio', { name: '丰富' }).getAttribute('aria-checked')) === 'true' ? '丰富' : '简洁');
    const from = await checked();
    const to = from === '丰富' ? '简洁' : '丰富';
    await expect.poll(() => covers(from)).toBe(true);
    await group.getByRole('radio', { name: to }).click();
    await expect(group.getByRole('radio', { name: to })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => covers(to)).toBe(true);
    // 改回去，不保存
    await group.getByRole('radio', { name: from }).click();
    await expect.poll(() => covers(from)).toBe(true);

    // 后台导航：底块在当前分区上；换分区跟过去
    const nav = page.getByRole('navigation', { name: '后台导航' });
    const pill = nav.locator('.mo-indicator');
    const on = async (testId: string) => {
      // 离得远时底块是重新挂上来的（直接出现在新位置并淡入）：那一瞬间量不到，过一会儿再量
      const a = await pill.boundingBox().catch(() => null);
      const b = await page.getByTestId(testId).boundingBox();
      return !!a && !!b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1;
    };
    await expect.poll(() => on('admin-nav-emenu')).toBe(true);
    await page.getByTestId('admin-nav-rooms').click();
    await expect(page).toHaveURL(/\/admin\/rooms/);
    await expect.poll(() => on('admin-nav-rooms')).toBe(true);
    await page.getByTestId('admin-nav-home').click();
    await expect.poll(() => on('admin-nav-home')).toBe(true);
    // 当前分区的字在底块上面、仍是浅色（看得清）
    await expect(page.getByTestId('admin-nav-home')).toHaveClass(/nav-on/);
  });
});
