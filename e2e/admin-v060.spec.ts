// v0.6.0 浏览器验收：管理后台（与前台分开）、岗位权限可配置、会员渠道来源与等级、按岗位的数据看板。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、值班经理 zhangjl、前台 xiaozhou，密码 yuzu2026。
// 会改规则的流程只在门店电脑尺寸执行，结束时恢复（渠道停用、岗位权限恢复默认），可重复执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true });

test.describe('v0.6.0 管理后台', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改规则的流程只在门店电脑尺寸执行一次');

  test('店主从「后台」进入：后台首页、规则总表、返回前台；实例标识与版本常显', async ({ page }) => {
    await login(page, 'linlan');
    await nav(page, '后台').click();
    await expect(page.getByTestId('admin-shell')).toBeVisible();
    await expect(page.getByTestId('admin-instance')).toContainText('v');
    await expect(page.getByTestId('admin-home')).toBeVisible();
    await expect(page.getByTestId('admin-rule-status')).toContainText('共');
    await page.getByTestId('admin-nav-settings').click();
    const catalog = page.getByTestId('rule-catalog');
    await expect(catalog).toContainText('本金与赠金的扣款顺序');
    await expect(catalog).toContainText('渠道来源');
    await expect(catalog).toContainText('岗位权限');
    await page.getByTestId('admin-exit').click();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  });

  test('渠道来源：后台新增「E2E 渠道」→ 前台建档选它 → 会员详情显示渠道、会员号与等级；结束时停用', async ({ page }) => {
    await login(page, 'linlan');
    const label = 'E2E 渠道';
    type Channel = { key: string; label: string; active: boolean };
    const channels = async () => ((await (await page.request.get('/api/settings')).json()) as { memberChannels: Channel[] }).memberChannels;
    try {
      const existing = (await channels()).find((c) => c.label === label);
      if (existing) {
        // 再次执行：上次结束时停用了，重新启用
        const list = (await channels()).map((c) => (c.label === label ? { ...c, active: true } : c));
        expect((await page.request.put('/api/settings', { data: { memberChannels: list } })).ok()).toBe(true);
      } else {
        await page.goto('/admin/members');
        const card = page.getByTestId('channels-card');
        await card.getByRole('button', { name: '新增渠道' }).click();
        const count = (await channels()).length;
        await card.getByTestId(`channel-label-${count}`).fill(label);
        await card.getByTestId('channels-save').click();
        await expect(page.getByText('渠道来源已保存')).toBeVisible();
      }
      await page.request.post('/api/auth/logout');

      await login(page, 'xiaozhou');
      await page.goto('/');
      const phone = `198${String(Date.now()).slice(-8)}`;
      await page.getByRole('button', { name: '新建会员' }).click();
      const form = page.getByRole('dialog').filter({ hasText: '新建会员' });
      await form.getByLabel('姓名').fill('渠道演示会员');
      await form.getByLabel('手机号').fill(phone);
      await form.getByTestId('member-channel').selectOption({ label });
      await form.getByRole('button', { name: '建档' }).click();
      await expect(page.getByText(/已为「渠道演示会员」建档/)).toBeVisible();
      await expect(page.getByTestId('member-registered')).toContainText(`渠道 ${label}`);
      await expect(page.getByTestId('member-no')).toContainText('会员号');
      // 会员体系 v2（v0.7.23）的等级卡：新会员 L0，写明再充多少升 L1
      await expect(page.getByTestId('member-grade')).toBeVisible();
      await expect(page.getByTestId('member-grade-label')).toHaveText('L0 青溪');
      await expect(page.getByTestId('member-grade-next')).toContainText('升到「L1 云涧」');
    } finally {
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      const list = (await channels()).map((c) => (c.label === label ? { ...c, active: false } : c));
      expect((await page.request.put('/api/settings', { data: { memberChannels: list } })).ok()).toBe(true);
    }
  });

  test('岗位权限：店主去掉值班经理的「查看历史营业日」→ 值班经理看不到前一天；恢复默认后照常', async ({ page }) => {
    await login(page, 'linlan');
    try {
      await page.goto('/admin/permissions');
      const cell = page.getByTestId('perm-duty_manager-ledger.readHistory');
      await expect(cell).toHaveAttribute('aria-checked', 'true');
      await cell.click();
      await expect(cell).toHaveAttribute('aria-checked', 'false');
      await page.getByTestId('permissions-save').click();
      await expect(page.getByText('岗位权限已保存')).toBeVisible();
      await page.request.post('/api/auth/logout');

      await login(page, 'zhangjl');
      expect((await page.request.get('/api/ledger?date=2020-01-01')).status()).toBe(403);
      await page.goto('/ledger');
      await expect(page.getByRole('heading', { name: '流水' })).toBeVisible();
      await expect(page.getByRole('button', { name: '前一天' })).toHaveCount(0);
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
    } finally {
      const m = (await (await page.request.get('/api/admin/permissions')).json()) as { defaults: Record<string, string[]> };
      const roles = Object.fromEntries(Object.entries(m.defaults).filter(([r]) => r !== 'owner'));
      expect((await page.request.put('/api/admin/permissions', { data: { roles } })).ok()).toBe(true);
    }
    await page.request.post('/api/auth/logout');
    await login(page, 'zhangjl');
    expect((await page.request.get('/api/ledger?date=2020-01-01')).status()).toBe(200);
  });

  test('看板按岗位（2026-11-10 起在后台「数据看板」）：店主有今日、经营总览、会员总览；店员只有今日，进后台只看得到数据看板', async ({ page }) => {
    await login(page, 'linlan');
    await expect(nav(page, '看板')).toHaveCount(0);
    await nav(page, '后台').click();
    await page.getByTestId('admin-nav-dashboard').click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    await page.getByTestId('dashboard-tab-today').click();
    await expect(page.getByTestId('dashboard')).toContainText('今日净营业额');
    await page.getByTestId('dashboard-tab-overview').click();
    await expect(page.getByTestId('overview-net')).toContainText('净营业额');
    await expect(page.getByTestId('period-picker')).toBeVisible();
    await page.getByRole('radio', { name: '近 30 天' }).click();
    await expect(page.getByTestId('dashboard-overview')).toContainText('30 个营业日');
    await page.getByTestId('dashboard-tab-members').click();
    await expect(page.getByTestId('members-total')).toContainText('位');
    await expect(page.getByTestId('members-levels')).toContainText('L0 青溪');
    await page.request.post('/api/auth/logout');

    await login(page, 'xiaozhou');
    await nav(page, '后台').click();
    // 店员没有后台首页：进来直接到数据看板，后台里只有这一个分区
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    await expect(page.getByTestId('dashboard')).toContainText('今日净营业额');
    await expect(page.getByTestId('dashboard-tab-overview')).toHaveCount(0);
    await expect(page.getByTestId('admin-nav-dashboard')).toHaveCount(1);
    await expect(page.getByTestId('admin-nav-settings')).toHaveCount(0);
    await expect(page.getByTestId('admin-nav-home')).toHaveCount(0);
    // 门店的旧地址跳到后台；没权限的页签、别的后台分区都回到数据看板
    await page.goto('/dashboard/overview');
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    await page.goto('/admin/settings');
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    expect((await page.request.get('/api/admin/overview')).status()).toBe(403);
  });
});
