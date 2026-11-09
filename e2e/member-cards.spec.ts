// v0.7.28 ⑦ 浏览器验收：会员实体卡。会员页「会员卡」发卡（读卡器按模拟键盘把卡号打进输入框、回车）→ 查找框刷卡找到这位会员 →
// 挂失 → 再刷这张卡：提醒已挂失、卡主是谁 → 补卡发新卡。依赖演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。可重复执行。
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

test('发卡 → 刷卡找会员 → 挂失后刷卡提醒 → 补卡', async ({ page }, info) => {
  test.skip(info.project.name !== '门店电脑', '写数据的只在门店电脑尺寸执行一次');
  await login(page, 'linlan');
  const phone = `199${String(Date.now()).slice(-8)}`;
  const created = await page.request.post('/api/members', { data: { name: `E2E 持卡 ${run}`, phone } });
  expect(created.ok(), await created.text()).toBe(true);
  const m = (await created.json()) as { id: number };
  const first = `C${run}01`;
  const second = `C${run}02`;

  // ① 发卡：读卡器按模拟键盘把卡号打进输入框、跟一个回车
  await page.goto(`/?m=${m.id}`);
  const box = page.getByTestId('member-cards');
  await expect(box).toContainText('还没有发实体卡');
  await box.getByTestId('member-card-issue-open').click();
  await page.getByTestId('member-card-no').pressSequentially(first.toLowerCase());
  await page.getByTestId('member-card-no').press('Enter');
  await expect(page.getByText('已发卡')).toBeVisible();
  await expect(box.getByTestId(`member-card-${first}`)).toHaveAttribute('data-status', 'active');

  // ② 查找框刷卡：找到这位会员
  const search = page.getByRole('searchbox', { name: '搜索会员' }).or(page.getByLabel('搜索会员'));
  // 限定在会员列表里：8.0.4 起列表上方「按标签筛选」下拉框的选项也是 option
  const results = page.getByRole('listbox', { name: '会员列表' }).getByRole('option');
  await search.first().fill(first);
  await expect(results.first()).toContainText(`E2E 持卡 ${run}`);
  await search.first().fill('');

  // ③ 挂失：写原因；之后刷这张卡查不到人，提醒已挂失与卡主
  await box.getByTestId(`member-card-lost-${first}`).click();
  await page.getByTestId('member-card-lost-reason').fill('客人来电说卡丢了');
  await page.getByTestId('member-card-lost-submit').click();
  await expect(box.getByTestId(`member-card-${first}`)).toHaveAttribute('data-status', 'lost');
  await search.first().fill(first);
  await expect(page.getByTestId('member-card-alert')).toContainText(`这张卡已挂失（卡主 E2E 持卡 ${run}`);
  await search.first().fill('');

  // ④ 补卡：发一张新卡；新卡刷卡找到这位会员
  await box.getByTestId('member-card-issue-open').click();
  await expect(page.getByRole('dialog')).toContainText('原卡已挂失');
  await page.getByTestId('member-card-no').fill(second);
  await page.getByTestId('member-card-issue-submit').click();
  await expect(page.getByText('已补卡')).toBeVisible();
  await expect(box.getByTestId(`member-card-${second}`)).toHaveAttribute('data-status', 'active');
  await search.first().fill(second);
  await expect(results.first()).toContainText(`E2E 持卡 ${run}`);
});
