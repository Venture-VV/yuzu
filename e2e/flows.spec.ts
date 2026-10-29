// 浏览器实操验收：依赖演示数据（店主 linlan / 店员 xiaozhou，密码 yuzu2026）。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '会员工作台' })).toBeVisible({ timeout: 30_000 }); // 刚启动的服务第一次登录可能较慢
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true });

async function openMember(page: Page, query: string) {
  await page.getByLabel('搜索会员').fill(query);
  await expect(page.getByRole('option').first()).toContainText(query);
  await page.getByRole('option').filter({ hasText: query }).first().click();
  await expect(page.getByText('可用余额').first()).toBeVisible();
}

/** 会员详情里的「可用余额」数字（分） */
async function availableCents(page: Page): Promise<number> {
  const text = await page.locator('main').getByText('可用余额').locator('xpath=following-sibling::*[1]').innerText();
  return Math.round(Number(text.replace(/[^\d.]/g, '')) * 100);
}

test('店员：查找会员 → 套餐充值 → 消费扣款，余额变化清楚', async ({ page }) => {
  await login(page, 'xiaozhou');
  await openMember(page, '周以安');
  const before = await availableCents(page);

  await page.getByRole('button', { name: /^充值/ }).click();
  await page.getByRole('button', { name: /常泡 500/ }).click();
  await page.getByRole('button', { name: '支付宝' }).click();
  await page.getByRole('button', { name: '下一步：核对收款' }).click();
  // 未勾选确认收款时不能入账
  await expect(page.getByRole('button', { name: /确认入账/ })).toBeDisabled();
  await page.getByText('我已核实').click();
  await page.getByRole('button', { name: /确认入账/ }).click();
  await expect(page.getByText('充值已入账')).toBeVisible();
  await expect(page.getByText(/单号 CZ\d{8}-\d{4}/)).toBeVisible();

  await page.getByRole('button', { name: '接着登记消费' }).click();
  await page.getByRole('button', { name: /^汤泉入场 · 成人/ }).click();
  await page.getByRole('button', { name: /^柚子气泡水/ }).click();
  await page.getByRole('button', { name: '下一步：核对扣款' }).click();
  await expect(page.getByText('扣款构成')).toBeVisible();
  await page.getByRole('button', { name: /确认扣款 ¥150\.00/ }).click();
  await expect(page.getByText('扣款完成')).toBeVisible();
  await page.getByRole('button', { name: '完成' }).click();

  await expect.poll(() => availableCents(page)).toBe(before + 50000 + 5000 - 15000);
  // 店员看不到撤销按钮
  await expect(page.locator('main').getByRole('button', { name: '撤销' })).toHaveCount(0);
});

test('充值后马上接着消费：会员资料的重新读取还没回来时，核对页也按最新余额，不会被「余额刚刚有变化」拦下', async ({ page }) => {
  await login(page, 'xiaozhou');
  await openMember(page, '顾青山');
  const before = await availableCents(page);
  // 门店电脑或网络较慢：之后会员资料的重新读取 3 秒才返回
  const memberUrl = /\/api\/members\/\d+$/;
  await page.route(memberUrl, async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });

  await page.getByRole('button', { name: /^充值/ }).click();
  await page.getByRole('button', { name: /常泡 500/ }).click();
  await page.getByRole('button', { name: '支付宝' }).click();
  await page.getByRole('button', { name: '下一步：核对收款' }).click();
  await page.getByText('我已核实').click();
  await page.getByRole('button', { name: /确认入账/ }).click();
  await expect(page.getByText('充值已入账')).toBeVisible();

  // 不等重新读取，马上接着登记消费
  await page.getByRole('button', { name: '接着登记消费' }).click();
  await page.getByRole('button', { name: /^柚子气泡水/ }).click();
  await page.getByRole('button', { name: '下一步：核对扣款' }).click();
  await page.getByRole('button', { name: /确认扣款 ¥22\.00/ }).click();
  await expect(page.getByText('扣款完成')).toBeVisible();
  await expect(page.getByText('会员余额刚刚有变化')).toHaveCount(0);
  await page.getByRole('button', { name: '完成' }).click();
  await page.unroute(memberUrl);
  await expect.poll(() => availableCents(page)).toBe(before + 50000 + 5000 - 2200);
});

test('店主：整单撤销后按原构成恢复余额，日结核对一致', async ({ page }) => {
  await login(page, 'linlan');
  await openMember(page, '周以安');
  const before = await availableCents(page);
  const consumeRow = page.locator('main').getByRole('button', { name: '撤销' }).first();
  await consumeRow.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('将恢复本金')).toBeVisible();
  const restoreText = await dialog.locator('text=将恢复本金').locator('xpath=following-sibling::*[1]').innerText();
  const bonusText = await dialog.locator('text=将恢复赠金').locator('xpath=following-sibling::*[1]').innerText();
  const restore = Math.round(Number(restoreText.replace(/[^\d.]/g, '')) * 100) + Math.round(Number(bonusText.replace(/[^\d.]/g, '')) * 100);
  await dialog.getByRole('button', { name: '项目选错' }).click();
  await dialog.getByRole('button', { name: '确认撤销并恢复余额' }).click();
  await expect(dialog.getByText('余额已恢复')).toBeVisible();
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect.poll(() => availableCents(page)).toBe(before + restore);

  await nav(page, '日结').click();
  await expect(page.getByText(/余额与流水核对一致/)).toBeVisible();
  await expect(page.getByText('异常与提醒')).toBeVisible();
});

test('店主：前台结账的储值消费不能在会员这里单独撤销，提示到结账记录反结账', async ({ page }) => {
  // 结账演示（seed-billing-demo）：沈先生用储值支付了结账单的一部分
  await login(page, 'linlan');
  await openMember(page, '沈先生');
  const main = page.locator('main');
  await expect(main.getByText(/^手牌结账 JZ/).first()).toBeVisible();
  await expect(main.getByText('需反结账更正')).toBeVisible();
  await expect(main.getByRole('button', { name: '撤销' })).toHaveCount(0);
  // 流水的单据详情：不提供「撤销这张消费单」，写明对哪张结账单反结账
  await nav(page, '流水').click();
  await expect(page.getByRole('heading', { name: '流水' })).toBeVisible();
  // 只看沈先生的：当天可能还有其他用例（如完整收银）结账后又反结账、储值已撤销的单
  await page.goto(`/ledger?q=${encodeURIComponent('沈先生')}`);
  await expect(page.getByLabel('搜索流水')).toHaveValue('沈先生');
  await page.getByText(/^手牌结账 JZ/).filter({ visible: true }).first().click();
  const drawer = page.getByRole('dialog', { name: '单据详情' });
  await expect(drawer.getByText(/^结账单 JZ\d{8}-\d{4} 的储值支付$/)).toBeVisible();
  await expect(drawer.getByText(/前台 → 结账记录/)).toBeVisible();
  await expect(drawer.getByRole('button', { name: '撤销这张消费单' })).toHaveCount(0);
});

test('请求超时：显示结果待确认，可查回原单且不重复记账', async ({ page }) => {
  await login(page, 'xiaozhou');
  await openMember(page, '陈一禾');
  const before = await availableCents(page);

  // 让请求真正到达服务器并入账，但浏览器收不到响应（模拟网络中断）
  await page.route('**/api/recharges', async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: /^充值/ }).click();
  await page.getByRole('button', { name: /轻享 300/ }).click();
  await page.getByRole('button', { name: '现金' }).click();
  await page.getByRole('button', { name: '下一步：核对收款' }).click();
  await page.getByText('我已核实').click();
  await page.getByRole('button', { name: /确认入账/ }).click();

  await expect(page.getByText('结果待确认')).toBeVisible();
  await expect(page.getByRole('button', { name: /确认入账/ })).toBeDisabled();
  await page.unroute('**/api/recharges');
  await page.getByRole('button', { name: '查询这笔操作的结果' }).click();
  await expect(page.getByText('充值已入账')).toBeVisible();
  await expect(page.getByText('已查回第一次提交的结果，未重复记账')).toBeVisible();
  await page.getByRole('button', { name: '完成' }).click();
  await expect.poll(() => availableCents(page)).toBe(before + 30000);
});

test('权限：店员看不到管理入口，不能查看历史营业日', async ({ page }) => {
  await login(page, 'xiaozhou');
  await expect(nav(page, '管理')).toHaveCount(0);
  await page.goto('/ledger');
  await expect(page.getByRole('button', { name: '前一天' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导出 CSV' })).toHaveCount(0);
  const res = await page.request.get('/api/ledger?date=2020-01-01');
  expect(res.status()).toBe(403);
});

test('外网中断：所有资源来自本机，核心页面照常使用', async ({ page, baseURL }) => {
  const appHost = new URL(baseURL!).host;
  const external: string[] = [];
  await page.route(
    (url) => url.host !== appHost,
    (route) => {
      external.push(route.request().url());
      return route.abort('internetdisconnected');
    },
  );
  await login(page, 'linlan');
  await openMember(page, '林小满');
  await nav(page, '流水').click();
  await expect(page.getByRole('heading', { name: '流水' })).toBeVisible();
  await nav(page, '日结').click();
  await expect(page.getByText('余额核对')).toBeVisible();
  expect(external).toEqual([]);
});

test('键盘：/ 搜索 → 回车选中 → R 打开充值 → Esc 关闭', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '键盘快捷键只在门店电脑上验证');
  await login(page, 'xiaozhou');
  await page.keyboard.press('/');
  await expect(page.getByLabel('搜索会员')).toBeFocused();
  await page.keyboard.type('1003');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('main').getByRole('heading', { name: '陈一禾' })).toBeVisible();
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('r');
  await expect(page.getByRole('heading', { name: '会员充值' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '会员充值' })).toHaveCount(0);
});
