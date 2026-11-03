// 会员体系 v2 第一期（v0.7.23，docs/MEMBERSHIP.md）浏览器验收：
//   · 充值页：输入金额就显示充完的档阶、按档赠金、首充最低；入账后会员详情的等级卡按新的档阶；
//   · 看板「会员体系」、后台「会员规则」（保存前列出会影响哪些以后的判断）；
//   · 「他店查询」账号只进会员查询页：遮姓名与手机号、看不到余额，也打不开会员接口。

import { expect, test, type Page } from '@playwright/test';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('会员体系 v2', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('新会员首充：不到最低被拦；充 1 万升到 L2、按 5% 赠送；等级卡、看板随之更新', async ({ page }) => {
    await login(page, 'linlan');
    await ensureShift(page);
    const phone = `197${String(Date.now()).slice(-8)}`;
    const created = await page.request.post('/api/members', { data: { name: '会员体系验收', phone } });
    expect(created.ok()).toBe(true);
    const member = (await created.json()) as { id: number };
    await page.goto(`/?m=${member.id}`);
    await expect(page.getByTestId('member-grade-label')).toHaveText('L0 青溪');

    await page.getByRole('button', { name: /^充值/ }).first().click();
    await page.getByText('自定义金额').click();
    await page.fill('#paid', '1000');
    const preview = page.getByTestId('recharge-grade-preview');
    await expect(preview).toContainText('首充最低 ¥5,000.00');
    await expect(preview).toContainText('这笔不到首充最低');
    await page.getByRole('button', { name: '现金' }).click();
    await page.getByRole('button', { name: '下一步：核对收款' }).click();
    await expect(page.getByText('首充单笔最低 ¥5,000.00')).toBeVisible();

    await page.fill('#paid', '10000');
    await expect(preview).toContainText('充完是「L2 潭影 · 初」（升档），按 5% 赠 ¥500.00');
    await expect(page.getByTestId('recharge-grade-next')).toContainText('升到「L3 观澜」');
    await page.getByRole('button', { name: '下一步：核对收款' }).click();
    await expect(page.getByTestId('recharge-confirm-grade')).toContainText('L2 潭影 · 初');
    await page.getByText('我已核实').click();
    await page.getByRole('button', { name: /确认入账/ }).click();
    await expect(page.getByText('充值已入账')).toBeVisible();
    await expect(page.getByTestId('recharge-result-grade')).toHaveText('L2 潭影 · 初');
    await page.getByRole('button', { name: '完成' }).click();

    await expect(page.getByTestId('member-grade-label')).toHaveText('L2 潭影 · 初');
    await expect(page.getByTestId('member-grade-spend-next')).toContainText('升享阶');
    await expect(page.getByTestId('member-grade-events')).toContainText('充值升档：L0 青溪 → L2 潭影 · 初');
    await expect(page.getByTestId('grade-badge').first()).toContainText('L2 潭影 · 初');

    await page.goto('/dashboard/membership');
    await expect(page.getByTestId('membership-states')).toContainText('L2 潭影');
    await expect(page.getByTestId('membership-today-events')).toContainText('会员体系验收');
  });

  test('后台「会员规则」：改续充最低时列出影响；不保存就放弃', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/membership');
    await expect(page.getByTestId('membership-rules')).toBeVisible();
    await expect(page.getByTestId('rule-grade-name-3')).toHaveValue('观澜');
    await page.getByTestId('rule-topup-min').fill('1000');
    await expect(page.getByTestId('membership-rules-effects')).toContainText('续充 ¥1,000.00：下一笔充值起生效');
    await expect(page.getByTestId('membership-rules-save')).toBeEnabled();
    await page.getByRole('button', { name: '放弃修改' }).click();
    await expect(page.getByTestId('membership-rules-save')).toBeDisabled();
  });

  test('手动调整已经生效、回复却是 500：等级卡上方结果待确认、不能另起一笔；查回就是那一次（Codex 自动审查 43d53e9）', async ({ page }) => {
    await login(page, 'linlan');
    const phone = `196${String(Date.now()).slice(-8)}`;
    const created = await page.request.post('/api/members', { data: { name: '调整待确认验收', phone } });
    expect(created.ok()).toBe(true);
    const member = (await created.json()) as { id: number };
    await page.goto(`/?m=${member.id}`);
    await expect(page.getByTestId('member-grade-label')).toHaveText('L0 青溪');

    // 请求真的到服务端、调整成功，回到页面的却是 500；查回暂时也连不上
    const isAdjust = (url: URL) => url.pathname === `/api/members/${member.id}/grade`;
    const isLookup = (url: URL) => url.pathname.startsWith('/api/erp/ops/');
    await page.route(isAdjust, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const res = await route.fetch();
      expect(res.status()).toBe(200);
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '服务器出了点问题' } }) });
    });
    await page.route(isLookup, (route) => route.abort('internetdisconnected'));
    await page.getByTestId('grade-adjust-open').click();
    await page.getByTestId('grade-adjust-grade').selectOption('3');
    await page.getByTestId('grade-adjust-reason').fill('E2E 回复丢了');
    await page.getByTestId('grade-adjust-submit').click();
    const pending = page.getByTestId('erp-pending');
    await expect(pending).toContainText('手动调整会员档阶');
    await expect(page.getByTestId('grade-adjust-open')).toBeDisabled();

    await page.unroute(isLookup);
    await page.unroute(isAdjust);
    await page.getByTestId('erp-pending-check').click();
    await expect(pending).toHaveCount(0);
    await expect(page.getByTestId('member-grade-label')).toHaveText('L3 观澜 · 初');
    await expect(page.getByTestId('grade-adjust-open')).toBeEnabled();
    const info = (await (await page.request.get(`/api/members/${member.id}/grade`)).json()) as { events: { kind: string }[] };
    expect(info.events.filter((e) => e.kind === 'manual')).toHaveLength(1);
  });

  test('他店查询：只进会员查询页，遮姓名与手机号、不含余额；会员接口 403', async ({ page }) => {
    await login(page, 'linlan');
    const username = `fukuda${String(Date.now()).slice(-6)}`;
    const password = 'Fukuda-2026x';
    const staff = await page.request.post('/api/staff', { data: { username, displayName: '福田前台', role: 'other_store', password } });
    expect(staff.status(), await staff.text()).toBe(201);
    await page.request.post('/api/auth/logout');

    // 新账号第一次登录先改密码（接口登录与浏览器同一会话）
    expect((await page.request.post('/api/auth/login', { data: { username, password } })).ok()).toBe(true);
    const changed = await page.request.post('/api/auth/change-password', { data: { currentPassword: password, newPassword: `${password}9` } });
    expect(changed.ok(), await changed.text()).toBe(true);
    await page.goto('/');
    await expect(page).toHaveURL(/\/lookup$/);
    await page.getByTestId('member-lookup-input').fill('199 0000 8803');
    await page.getByTestId('member-lookup-submit').click();
    const result = page.getByTestId('member-lookup-result');
    await expect(result).toContainText('199****8803');
    await expect(page.getByTestId('member-lookup-grade')).toContainText('L5 山海');
    await expect(result).not.toContainText('¥');
    expect((await page.request.get('/api/members?q=8803')).status()).toBe(403);
    await page.getByTestId('member-lookup-input').fill('19900000000');
    await page.getByTestId('member-lookup-submit').click();
    await expect(page.getByText('没有找到「19900000000」')).toBeVisible();
  });
});
