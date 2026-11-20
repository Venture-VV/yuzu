// 8.1.18 组织架构与岗位（docs/POSITIONS_V8118.md）：后台「添加员工」先选部门、再选岗位，系统按岗位套用管理员级别与权限模板；
// 新账号登录后按岗位的权限（外联部员工进 ERP 的库存）；「岗位权限」第一个页签按岗位逐项开关。
// 老账号第一次登录选岗要改库里的标记，浏览器用例不做，接口与级别封顶见 tests/positions-api.test.ts。

import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test.describe('8.1.18 组织架构与岗位', () => {
  test('添加员工：选外联部 → 员工，套用管理员级别；新账号改完密码直接进 ERP 的库存', async ({ page, browser }, info) => {
    test.skip(info.project.name !== '门店电脑', '后台页面的流程，只跑一次');
    const username = `pos${Date.now().toString(36)}`;
    await login(page, 'linlan');
    await page.goto('/admin/staff');
    await page.getByRole('button', { name: '添加员工', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加员工' });
    await dialog.getByLabel('登录账号').fill(username);
    await dialog.getByLabel('姓名').fill('外联小新');
    await dialog.getByTestId('staff-org-dept').selectOption('outreach');
    await dialog.getByRole('radio', { name: '员工（管理员）' }).click();
    const template = dialog.getByTestId('staff-position-template');
    await expect(template).toContainText('外联部员工');
    await expect(template).toContainText('管理员');
    await expect(template).toContainText('✘ 单据审核 / 审批');
    await dialog.getByRole('button', { name: '保存' }).click();
    const temp = (await page.getByTestId('staff-secret').innerText()).trim();
    await page.getByRole('button', { name: '我已告知' }).click();
    await expect(page.getByTestId(`staff-position-${username}`)).toContainText('外联部员工');

    const ctx = await browser.newContext();
    const staff = await ctx.newPage();
    await login(staff, username, temp);
    await staff.fill('#cur', temp);
    await staff.fill('#new', 'Outreach2026');
    await staff.fill('#confirm', 'Outreach2026');
    await staff.getByRole('button', { name: '保存新密码' }).click();
    // 只用 ERP 的人登录后直接进第一个能用的模块（库存）
    await expect(staff).toHaveURL(/\/inventory/);
    const me = await (await staff.request.get('/api/auth/me')).json();
    expect(me.staff.position).toBe('outreach.staff');
    expect(me.permissions).toContain('purchase.manage');
    expect(me.permissions).not.toContain('inventory.approve');
    await ctx.close();
  });

  test('岗位权限：第一个页签按岗位分组显示表上的八列与建议值（只读）', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '后台页面的流程，只跑一次');
    await login(page, 'linlan');
    await page.goto('/admin/permissions');
    await expect(page.getByTestId('position-permissions')).toBeVisible();
    await page.getByTestId('position-permissions-select').selectOption('finance.lead');
    await expect(page.getByTestId('pos-perm-finance.lead-expense.approve')).toBeChecked();
    await expect(page.getByTestId('pos-perm-finance.lead-staff.dept')).not.toBeChecked();
    await expect(page.getByTestId('pos-perm-finance.lead-settings.manage')).toBeDisabled();
  });
});
