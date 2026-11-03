// 后台「微信小程序」（小程序线，docs/MINIPROGRAM.md 第 5 节）浏览器验收：
//   ① 对顾客开放的开关（打开再关上）；② 改宝安店的营业时间；③ 新建一张首页轮播（上传图片）再停用；
//   ④ 给一个价目项目写介绍；⑤ 找会员看微信绑定（演示库里没有绑定，只核对空状态）。
// 依赖 seed-demo（仅独立演示库）。账号：店主 linlan，密码 yuzu2026。每次的标题带时间，结束时把开关关上、轮播停用，可重复执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
// 1×1 的 PNG：页面会压缩成 JPEG 再上传
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('后台「微信小程序」（小程序线）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(120_000);

  test('开关、门店信息、首页轮播（上传图片）、项目介绍、会员的微信', async ({ page }) => {
    await login(page, 'linlan');
    const stamp = String(Date.now() % 100000);
    // 从关着的状态开始（上次中途退出时可能没关上）
    expect((await page.request.put('/api/admin/mp/rules', { data: { enabled: false } })).ok()).toBe(true);
    await page.goto('/admin/mp');
    await expect(page.getByRole('heading', { name: '微信小程序' })).toBeVisible();
    try {
      // ① 开关：打开后提示已开放
      await page.getByRole('radio', { name: '开放' }).click();
      await expect(page.getByText('小程序已对顾客开放')).toBeVisible();
      await expect(page.getByText('已开放：顾客能在小程序里看到门店信息')).toBeVisible();

      // ② 宝安店的营业时间
      const baoan = page.getByTestId('mp-store-baoan');
      await baoan.getByLabel('营业时间').fill(`全天营业（E2E ${stamp}）`);
      await baoan.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText('宝安店的门店信息已保存')).toBeVisible();
      await expect(page.getByTestId('mp-store-baoan').getByLabel('营业时间')).toHaveValue(`全天营业（E2E ${stamp}）`);

      // ③ 新建轮播：上传图片后才能保存
      await page.getByRole('radio', { name: '首页轮播' }).click();
      await page.getByTestId('mp-banner-new').click();
      const dialog = page.getByRole('dialog', { name: '新建轮播' });
      await dialog.getByTestId('mp-banner-title').fill(`E2E 冬日汤泉 ${stamp}`);
      await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();
      await dialog.getByTestId('mp-image-input').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: PNG_1PX });
      await expect(dialog.getByRole('button', { name: '换一张' })).toBeVisible();
      await dialog.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText('轮播已新建')).toBeVisible();
      const row = page.locator('div').filter({ hasText: `E2E 冬日汤泉 ${stamp}` }).filter({ has: page.getByRole('button', { name: '修改' }) }).last();
      await expect(row.getByText('显示中')).toBeVisible();
      // 停用（轮播不能删）
      await row.getByRole('button', { name: '修改' }).click();
      const edit = page.getByRole('dialog', { name: '修改轮播' });
      await edit.getByLabel('显示这张轮播').uncheck();
      await edit.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText('轮播已保存')).toBeVisible();
      await expect(row.getByText('已停用')).toBeVisible();

      // ④ 项目介绍
      await page.getByRole('radio', { name: '项目介绍' }).click();
      await page.getByRole('button', { name: '写介绍' }).first().click();
      const intro = page.getByRole('dialog');
      await intro.getByLabel('介绍').fill(`E2E 介绍 ${stamp}`);
      await intro.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText(/的介绍已保存/)).toBeVisible();
      await expect(page.getByText(`E2E 介绍 ${stamp}`)).toBeVisible();

      // ⑤ 会员的微信：演示库里没有绑定
      await page.getByRole('radio', { name: '会员的微信' }).click();
      await page.getByTestId('mp-bindings-search').fill('沈');
      await page.getByRole('button', { name: '找会员' }).click();
      await page.getByRole('button', { name: /沈/ }).first().click();
      await expect(page.getByText('还没绑定过微信')).toBeVisible();
    } finally {
      // 把开关关上，演示库照旧不对顾客开放
      const res = await page.request.put('/api/admin/mp/rules', { data: { enabled: false } });
      expect(res.ok()).toBe(true);
    }
  });

  test('店员进不了后台「微信小程序」', async ({ page }) => {
    await login(page, 'xiaozhou');
    const res = await page.request.get('/api/admin/mp');
    expect(res.status()).toBe(403);
  });
});
