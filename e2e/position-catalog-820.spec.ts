// 8.2.0 P05（docs/YUZU_REQ_V820.md 第 6 节）：后台「岗位权限 → 分部门岗位职权配置」——按部门列岗位、搜索、改建议权限（换岗位前问是否放弃修改）、
// 变更记录、导出 Excel、旧岗位表从这里点进去。依赖演示数据（店主 linlan，密码 yuzu2026）。改了的建议权限最后改回去，可重复执行；只在门店电脑跑。
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|后台/ }).first()).toBeVisible({ timeout: 30_000 });
}

test.describe('8.2.0 分部门岗位职权配置', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸跑');

  test('按部门列岗位、搜索；改康美部员工的建议权限（换岗位先问）、记变更、改回去；导出；旧岗位表点得进去', async ({ page }) => {
    await login(page);
    await page.goto('/admin/permissions?tab=catalog');
    const list = page.getByTestId('catalog-list');
    await expect(list.getByTestId('catalog-dept-front')).toBeVisible();
    await expect(list.getByTestId('catalog-pos-male.staff')).toContainText('男宾部员工');
    // 搜索
    await page.getByTestId('catalog-search').fill('康美');
    await expect(list.getByTestId('catalog-dept-front')).toHaveCount(0);
    await expect(list.getByTestId('catalog-pos-kangmei.staff')).toBeVisible();
    await list.getByTestId('catalog-pos-kangmei.staff').click();
    await expect(page.getByTestId('catalog-title')).toContainText('康美部员工');
    const box = page.getByTestId('catalog-perms-ledger.readHistory');
    const had = await box.isChecked();
    await box.click();
    await expect(page.getByTestId('catalog-perms-off')).toHaveText('1');
    // 换岗位：先问是否放弃修改；继续改
    await list.getByTestId('catalog-pos-kangmei.lead').click();
    await expect(page.getByRole('dialog', { name: '是否放弃当前修改？' })).toBeVisible();
    await page.getByRole('button', { name: '继续改' }).click();
    await expect(page.getByTestId('catalog-title')).toContainText('康美部员工');
    await page.getByTestId('catalog-save').click();
    await expect(page.getByText('「康美部员工」的建议权限已保存')).toBeVisible();
    await expect(page.getByTestId('catalog-log-row').first()).toContainText('康美部员工');
    await expect(page.getByTestId('catalog-log-row').first()).toContainText(had ? '去了：查看历史营业日' : '加了：查看历史营业日');
    // 改回去
    await page.getByTestId('catalog-perms-ledger.readHistory').click();
    await page.getByTestId('catalog-save').click();
    await expect(page.getByTestId('catalog-log-row').first()).toContainText(had ? '加了：查看历史营业日' : '去了：查看历史营业日');
    // 导出
    const res = await page.request.get('/api/admin/position-catalog/export');
    expect(res.status()).toBe(200);
    expect(decodeURIComponent(res.headers()['content-disposition'] ?? '')).toContain('分部门岗位职权配置-');
    // 旧岗位表
    await page.getByTestId('legacy-roles-open').click();
    await expect(page).toHaveURL(/tab=roles/);
    await expect(page.getByTestId('permission-matrix')).toBeVisible();
    await page.getByTestId('legacy-roles-back').click();
    await expect(page.getByTestId('position-catalog')).toBeVisible();
  });

  test('别人先保存过：保存被拒、不给旧草稿换新版本，要放弃修改按最新的重新改（Codex 审查 e770cb9）', async ({ page }) => {
    await login(page);
    await page.goto('/admin/permissions?tab=catalog');
    await page.getByTestId('catalog-list').getByTestId('catalog-pos-kangmei.staff').click();
    const mine = page.getByTestId('catalog-perms-ledger.readHistory');
    await mine.click();
    // 另一个浏览器先把这个岗位的「查看会员」改掉
    type Pos = { key: string; suggested: string[]; version: string };
    const view = async () =>
      ((await (await page.request.get('/api/admin/position-catalog')).json()) as { departments: { positions: Pos[] }[] }).departments
        .flatMap((d) => d.positions)
        .find((p) => p.key === 'kangmei.staff')!;
    const before = await view();
    const other = before.suggested.includes('member.read') ? before.suggested.filter((p) => p !== 'member.read') : [...before.suggested, 'member.read'];
    expect((await page.request.put('/api/admin/position-catalog/kangmei.staff', { data: { permissions: other, version: before.version } })).status()).toBe(200);
    await page.getByTestId('catalog-save').click();
    await expect(page.getByTestId('catalog-stale')).toBeVisible();
    await expect(page.getByTestId('catalog-save')).toBeDisabled();
    // 服务端还是别人改的那一份
    expect((await view()).suggested.includes('member.read')).toBe(other.includes('member.read'));
    await page.getByTestId('catalog-stale-reload').click();
    await expect(page.getByTestId('catalog-stale')).toHaveCount(0);
    await expect(page.getByTestId('catalog-perms-off')).toHaveText('0');
    // 改回去
    const now = await view();
    expect((await page.request.put('/api/admin/position-catalog/kangmei.staff', { data: { permissions: before.suggested, version: now.version } })).status()).toBe(200);
  });
});
