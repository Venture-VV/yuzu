// 后台「微信小程序」（小程序线，docs/MINIPROGRAM.md 第 5 节）浏览器验收：
//   ① 对顾客开放的开关（打开再关上）；② 改宝安店的营业时间；③ 新建一张首页轮播（上传图片）再停用；
//   ④ 给一个价目项目写介绍；⑤ 找会员看微信绑定（演示库里没有绑定，只核对空状态）；
//   ⑥ 新建轮播结果待确认：回复丢了自动查回、没送到时确认作废或按原内容重新提交（都只建一张）。
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

      // ⑤ 会员的微信：刚准备的演示库里没有绑定；跑过小程序自动化的演示库里有解绑过的记录（自动化跑完都会解绑）
      await page.getByRole('radio', { name: '会员的微信' }).click();
      await page.getByTestId('mp-bindings-search').fill('沈');
      await page.getByRole('button', { name: '找会员' }).click();
      await page.getByRole('button', { name: /沈/ }).first().click();
      await expect(page.getByText('还没绑定过微信').or(page.getByText('已解绑').first())).toBeVisible();
    } finally {
      // 把开关关上，演示库照旧不对顾客开放
      const res = await page.request.put('/api/admin/mp/rules', { data: { enabled: false } });
      expect(res.ok()).toBe(true);
    }
  });

  test('新建轮播结果待确认：回复丢了自动查回；没送到时确认作废、按原内容重新提交（只建一张）', async ({ page }) => {
    await login(page, 'linlan');
    const stamp = String(Date.now() % 100000);
    const titles = (await (await page.request.get('/api/admin/mp')).json()).banners.map((b: { title: string }) => b.title) as string[];
    const count = async (title: string) =>
      ((await (await page.request.get('/api/admin/mp')).json()).banners as { title: string }[]).filter((b) => b.title === title).length;
    await page.goto('/admin/mp');
    await page.getByRole('radio', { name: '首页轮播' }).click();
    const create = async (title: string) => {
      await page.getByTestId('mp-banner-new').click();
      const dialog = page.getByRole('dialog', { name: '新建轮播' });
      await dialog.getByTestId('mp-banner-title').fill(title);
      await dialog.getByTestId('mp-image-input').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: PNG_1PX });
      await expect(dialog.getByRole('button', { name: '换一张' })).toBeVisible();
      await dialog.getByRole('button', { name: '保存' }).click();
    };
    const pending = page.getByTestId('mp-banner-pending');
    try {
      // ① 请求到了门店系统、回复丢了：列表上方显示待确认，进页面查回后自动移除，只建了一张
      const t1 = `E2E 回复丢了 ${stamp}`;
      await page.route('**/api/admin/mp/banners', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        await route.fetch();
        await route.abort('connectionreset');
      });
      await create(t1);
      await expect(page.getByText('新建结果待确认', { exact: true })).toBeVisible();
      await page.unroute('**/api/admin/mp/banners');
      await expect(page.getByText('已查回：轮播已新建')).toBeVisible();
      await expect(pending).toHaveCount(0);
      expect(await count(t1)).toBe(1);

      // ② 没送到：待确认，查回查不到；不能新建；确认作废后才能再建，原请求晚到也不会新建
      const t2 = `E2E 没送到 ${stamp}`;
      await page.route('**/api/admin/mp/banners', async (route) => (route.request().method() === 'POST' ? route.abort('connectionreset') : route.fallback()));
      await create(t2);
      await expect(pending.filter({ hasText: t2 })).toBeVisible();
      await page.unroute('**/api/admin/mp/banners');
      await page.reload();
      await page.getByRole('radio', { name: '首页轮播' }).click();
      await expect(pending.filter({ hasText: t2 })).toBeVisible();
      await expect(page.getByTestId('mp-banner-new')).toBeDisabled();
      await pending.filter({ hasText: t2 }).getByRole('button', { name: '确认作废' }).click();
      await page.getByRole('dialog', { name: '确认作废这次新建' }).getByRole('button', { name: '确认作废' }).click();
      await expect(page.getByText('已作废', { exact: true })).toBeVisible();
      await expect(pending).toHaveCount(0);
      expect(await count(t2)).toBe(0);
      await expect(page.getByTestId('mp-banner-new')).toBeEnabled();

      // ③ 没送到，按原内容重新提交：建上一张，再提交也不多建
      const t3 = `E2E 重新提交 ${stamp}`;
      await page.route('**/api/admin/mp/banners', async (route) => (route.request().method() === 'POST' ? route.abort('connectionreset') : route.fallback()));
      await create(t3);
      await expect(pending.filter({ hasText: t3 })).toBeVisible();
      await page.unroute('**/api/admin/mp/banners');
      await pending.filter({ hasText: t3 }).getByRole('button', { name: '按原内容重新提交' }).click();
      await expect(page.getByText('轮播已新建').first()).toBeVisible();
      await expect(pending).toHaveCount(0);
      expect(await count(t3)).toBe(1);
    } finally {
      // 这几张轮播停用，演示库的小程序首页照旧
      await page.unroute('**/api/admin/mp/banners').catch(() => undefined);
      const data = await (await page.request.get('/api/admin/mp')).json();
      for (const b of data.banners as { id: number; title: string; imageId: number; link: string; startsOn: string | null; endsOn: string | null; sortOrder: number; version: number; active: boolean }[]) {
        if (titles.includes(b.title) || !b.title.includes(stamp) || !b.active) continue;
        await page.request.put(`/api/admin/mp/banners/${b.id}`, {
          data: { version: b.version, title: b.title, imageId: b.imageId, link: b.link, startsOn: b.startsOn, endsOn: b.endsOn, sortOrder: b.sortOrder, active: false },
        });
      }
    }
  });

  test('店员进不了后台「微信小程序」', async ({ page }) => {
    await login(page, 'xiaozhou');
    const res = await page.request.get('/api/admin/mp');
    expect(res.status()).toBe(403);
  });
});
