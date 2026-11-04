// v0.7.28 ⑩ 浏览器验收：旧 EBC 逐笔流水只读导入（N12）。后台「期初导入」选流水文件 → 预览（认出几行、认不出的行）→ 确认导入 →
// 会员详情「旧系统流水」看得到，余额不变。依赖演示数据（仅独立演示库）；账号：店主 linlan。每次用新的会员与文件内容，可重复执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const run = Date.now().toString(36).toUpperCase().slice(-6);

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test('旧系统流水：后台导入 → 会员详情看得到，不进正式账', async ({ page }, info) => {
  test.skip(info.project.name !== '门店电脑', '写数据的只在门店电脑尺寸执行一次');
  await login(page, 'linlan');
  const phone = `195${String(Date.now()).slice(-8)}`;
  const created = await page.request.post('/api/members', { data: { name: `E2E 旧流水 ${run}`, phone } });
  expect(created.ok(), await created.text()).toBe(true);
  const m = (await created.json()) as { id: number; principalBalance: number };

  const csv = [
    '手机号,姓名,时间,类型,金额,余额,单号,备注',
    `${phone},E2E,2026-08-01 10:00,充值,1000,1000,R-${run},`,
    `${phone},E2E,2026-08-02 19:30,消费,-128,872,C-${run},洗浴`,
    `19500000000,不在系统里,2026-08-03,消费,-10,,X-${run},`,
  ].join('\n');
  await page.goto('/admin/opening');
  const card = page.getByTestId('member-history-import');
  await card.getByTestId('member-history-file').setInputFiles({ name: `ebc-${run}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  const preview = card.getByTestId('member-history-preview');
  await expect(preview).toContainText('认出会员 2 行');
  await expect(preview).toContainText('认不出会员 1 行');
  await card.getByTestId('member-history-submit').click();
  await expect(page.getByText('已导入旧系统流水 2 笔')).toBeVisible();

  // 会员详情：旧系统流水，新的在前；余额不变
  await page.goto(`/?m=${m.id}`);
  const box = page.getByTestId('member-legacy-history');
  await expect(box).toContainText('旧系统流水');
  await box.getByTestId('member-legacy-history-toggle').click();
  await expect(box.locator('li').first()).toContainText('消费');
  await expect(box.locator('li').first()).toContainText('洗浴');
  await expect(box.locator('li').nth(1)).toContainText('充值');
  const after = (await (await page.request.get(`/api/members/${m.id}`)).json()) as { principalBalance: number };
  expect(after.principalBalance).toBe(m.principalBalance);
});
