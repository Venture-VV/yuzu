// Batch 2.4a 浏览器验收（门店电脑尺寸）：单笔超过 50 万的充值需店主或店总当场授权；撤销时限超过后值班经理不能撤销、店主可以。
// 依赖 seed-demo 与 seed-frontdesk-demo（值班经理 zhangjl）；只在独立演示库执行，可重复执行（规则改动在结束时恢复）。
import { expect, test, type Page } from '@playwright/test';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 }); // 刚启动的服务第一次登录可能较慢
  await ensureShift(page); // 收款前必须先开班（R1.2）
}

async function openMember(page: Page, query: string) {
  await page.goto('/');
  await page.getByLabel('搜索会员').fill(query);
  await page.getByRole('option').filter({ hasText: query }).first().click();
  await expect(page.getByText('可用余额').first()).toBeVisible();
}

const shiftDate = (iso: string, days: number) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

test.describe('单笔上限与撤销时限', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('充值 60 万超过单笔上限：值班经理不能授权，店主当场授权后入账，单据记下授权人', async ({ page }) => {
    await login(page, 'xiaozhou');
    await openMember(page, '周以安');
    await page.getByRole('button', { name: /^充值/ }).first().click();
    await page.getByRole('button', { name: /自定义金额/ }).click();
    await page.getByLabel('实收金额').fill('600000');
    await page.getByRole('button', { name: '微信' }).click();
    await page.getByRole('button', { name: '下一步：核对收款' }).click();

    const card = page.getByTestId('over-limit-card');
    await expect(card).toContainText('超过单笔充值上限');
    await expect(card).toContainText('500,000.00');
    await page.getByText('我已核实').click();
    // 没有授权时不能入账
    await expect(page.getByRole('button', { name: /确认入账/ })).toBeDisabled();

    await card.getByTestId('over-limit-authorize').click();
    const dialog = page.getByRole('dialog').filter({ hasText: '当场授权' });
    await expect(dialog).toContainText('超过单笔上限');
    await expect(dialog).toContainText('充值实收 ¥600,000.00');
    await dialog.getByLabel('授权人账号').fill('zhangjl');
    await dialog.getByLabel('授权人密码').fill(PASSWORD);
    await dialog.getByTestId('authorize-submit').click();
    await expect(dialog).toContainText('不能授权超过单笔上限');
    await dialog.getByLabel('授权人账号').fill('linlan');
    await dialog.getByLabel('授权人密码').fill(PASSWORD);
    await dialog.getByTestId('authorize-submit').click();
    await expect(dialog).toBeHidden();
    await expect(card).toContainText('已由 林岚 当场授权');

    await page.getByRole('button', { name: /确认入账 ¥600,000\.00/ }).click();
    await expect(page.getByText('充值已入账')).toBeVisible();
    const flow = page.getByRole('region', { name: '操作面板' });
    await expect(flow.getByText('超限授权')).toBeVisible();
    await expect(flow).toContainText('林岚');

    const checks = (await (await page.request.get('/api/frontdesk/checks')).json()) as { ok: boolean; label: string }[];
    for (const c of checks) expect(c.ok, c.label).toBe(true);
  });

  test('撤销时限设为 2 小时：昨天的消费值班经理不能撤销，店主看到提示仍可办理', async ({ page }) => {
    await login(page, 'linlan');
    const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string };
    const rows = (await (await page.request.get(`/api/ledger?date=${shiftDate(me.today, -1)}&type=consume`)).json()) as {
      docNo: string;
      consumptionStatus: string;
      checkoutNo: string | null;
    }[];
    // 前台结账的储值支付只能反结账、没有「撤销这张消费单」：按 --previous-day 灌的数据里，昨天也有这种单（测试会话复测 v0.7.3）
    const target = rows.find((r) => r.consumptionStatus === 'completed' && !r.checkoutNo);
    expect(target, '演示数据昨天应有未撤销的消费').toBeTruthy();
    // 记下原来的撤销时限，结束后恢复（R1.2 起默认 48 小时，不是「不限」）
    const previous = ((await (await page.request.get('/api/settings')).json()) as { reversalWindowHours: number | null }).reversalWindowHours;
    expect((await page.request.put('/api/settings', { data: { reversalWindowHours: 2 } })).status()).toBe(200);
    try {
      const openReversal = async () => {
        await page.goto('/ledger');
        await page.getByRole('button', { name: '前一天' }).click();
        await page.getByText(target!.docNo).first().click();
        await page.getByRole('button', { name: '撤销这张消费单' }).click();
        return page.getByRole('dialog').filter({ hasText: '撤销消费（整单）' });
      };

      await page.request.post('/api/auth/logout');
      await login(page, 'zhangjl');
      let dialog = await openReversal();
      await expect(dialog).toContainText('已超过撤销时限（消费后 2 小时内）');
      await expect(dialog).toContainText('只有店主可以办理');
      await expect(dialog.getByRole('button', { name: '确认撤销并恢复余额' })).toBeDisabled();
      await dialog.getByRole('button', { name: '取消', exact: true }).click();

      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      dialog = await openReversal();
      await expect(dialog).toContainText('店主可以继续撤销');
      await dialog.getByRole('button', { name: '项目选错' }).click();
      await expect(dialog.getByRole('button', { name: '确认撤销并恢复余额' })).toBeEnabled();
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
    } finally {
      // 最后登录的是店主，可以改回经营规则
      await page.request.put('/api/settings', { data: { reversalWindowHours: previous } });
    }
  });
});
