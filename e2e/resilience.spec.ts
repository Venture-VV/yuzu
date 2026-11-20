// 8.1.3 网络波动防护（docs/RESILIENCE_V813.md 第 3.2–3.6 节）：断网提示与恢复、断网时提交不发出去、
// 系统忙自动重发、页面代码下载失败自动再试、页面出错不白屏并报给服务器、系统更新提示、「网络与同步」页。
// 依赖演示数据（店主 linlan，密码 yuzu2026）；只在门店电脑这一组跑（只看行为，与尺寸无关）。
import { expect, test, type Page } from '@playwright/test';
import { relaxRechargeMinimum } from './membership';
import { ensureShift } from './shift';
import { clickNav } from './nav';

relaxRechargeMinimum();
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== '门店电脑', '会写数据、只看行为的流程只在门店电脑这一组跑');
});

const PASSWORD = 'yuzu2026';

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '会员工作台' })).toBeVisible({ timeout: 30_000 });
}

const memberOptions = (page: Page) => page.getByRole('listbox', { name: '会员列表' }).getByRole('option');

async function openMember(page: Page, query: string) {
  await page.getByLabel('搜索会员').fill(query);
  await expect(memberOptions(page).first()).toContainText(query);
  await memberOptions(page).filter({ hasText: query }).first().click();
  await expect(page.getByText('可用余额').first()).toBeVisible();
}

async function availableCents(page: Page): Promise<number> {
  const text = await page.locator('main').getByText('可用余额').locator('xpath=following-sibling::*[1]').innerText();
  return Math.round(Number(text.replace(/[^\d.]/g, '')) * 100);
}

const banner = (page: Page, state: 'offline' | 'recovered' | 'updated') => page.locator(`[data-testid="network-banner"][data-state="${state}"]`);

test('断网：顶上提示数据截至几点、提交不会发出去；「网络与同步」看得到；恢复后提示已刷新', async ({ page, context }) => {
  await login(page);
  await context.setOffline(true);
  await expect(banner(page, 'offline')).toBeVisible({ timeout: 15_000 });
  await expect(banner(page, 'offline')).toContainText('页面上的数据截至');
  await expect(banner(page, 'offline')).toContainText('现在提交不会发出去');
  // 断网时在页面里打开「网络与同步」（不重新加载）
  await page.getByTestId('network-open').click();
  await expect(page.getByTestId('network-page')).toBeVisible();
  await expect(page.getByTestId('network-state')).toHaveText('连不上服务器');
  await expect(page.getByTestId('network-problems')).toContainText('连不上服务器');
  await expect(page.getByTestId('network-banner')).toHaveCount(0); // 这一页自己写着，不再盖一条
  await context.setOffline(false);
  await expect(page.getByTestId('network-state')).toHaveText('连接正常', { timeout: 20_000 });
  await expect(page.getByTestId('network-problems')).toContainText('网络恢复了');
  // 回到工作台：恢复的提示几秒后收起
  await page.goBack();
  await expect(page.getByRole('heading', { name: '会员工作台' })).toBeVisible();
  await expect(page.getByTestId('network-banner')).toHaveCount(0, { timeout: 10_000 });
});

test('断网以前发出去的那次检查，断网以后才成功回来：照样很快提示断网（不等 60 秒的心跳）', async ({ page, context }) => {
  await login(page);
  const held: { release?: () => Promise<void> } = {};
  await page.route('**/api/ping', async (route) => {
    if (held.release) return route.continue();
    const res = await route.fetch(); // 服务器回了，先扣在路上
    const body = await res.text();
    held.release = () => route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); // 让页面现在检查一次
  await expect.poll(() => held.release !== undefined).toBe(true);
  await context.setOffline(true);
  await held.release!(); // 断网以前发出去的那一次，这时才成功回来
  await page.unroute('**/api/ping');
  await expect(banner(page, 'offline')).toBeVisible({ timeout: 10_000 });
  await context.setOffline(false);
  await expect(banner(page, 'offline')).toHaveCount(0, { timeout: 20_000 });
});

test('断网时点「确认入账」：这笔没发出去、不进「结果待确认」，填的内容还在；恢复后同一笔照常入账、只入账一次', async ({ page, context }) => {
  await login(page);
  await ensureShift(page);
  await openMember(page, '周以安');
  const before = await availableCents(page);
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/recharges') && r.method() === 'POST') sent.push(r.url());
  });
  await page.getByRole('button', { name: /^充值(\s|$)/ }).click();
  await page.getByRole('button', { name: /轻享 300/ }).click();
  await page.getByRole('button', { name: '现金' }).click();
  await page.getByRole('button', { name: '下一步：核对收款' }).click();
  await page.getByText('我已核实').click();

  await context.setOffline(true);
  await expect(banner(page, 'offline')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /确认入账/ }).click();
  await expect(page.getByText(/这次没有发出去/).first()).toBeVisible();
  expect(sent).toHaveLength(0);
  await expect(page.getByText(/笔操作结果待确认/)).toHaveCount(0);
  await expect(page.getByText('结果待确认')).toHaveCount(0);

  await context.setOffline(false);
  await expect(banner(page, 'offline')).toHaveCount(0, { timeout: 20_000 });
  const res = page.waitForResponse((r) => r.url().endsWith('/api/recharges') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /确认入账/ }).click();
  const bonus = ((await (await res).json()) as { recharge: { bonusAmount: number } }).recharge.bonusAmount;
  await expect(page.getByText('充值已入账')).toBeVisible();
  expect(sent).toHaveLength(1);
  await page.getByRole('button', { name: '完成' }).click();
  await expect.poll(() => availableCents(page)).toBe(before + 30000 + bonus);
});

test('系统忙（等锁超时）：页面原样自动重发，员工不用再点；只入账一次', async ({ page }) => {
  await login(page);
  await ensureShift(page);
  await openMember(page, '陈一禾');
  const before = await availableCents(page);
  const bodies: string[] = [];
  await page.route('**/api/recharges', async (route) => {
    bodies.push(route.request().postData() ?? '');
    if (bodies.length === 1) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BUSY', message: '该会员正在被其他终端操作，本次未生效，请稍后重试' } }) });
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: /^充值(\s|$)/ }).click();
  await page.getByRole('button', { name: /轻享 300/ }).click();
  await page.getByRole('button', { name: '现金' }).click();
  await page.getByRole('button', { name: '下一步：核对收款' }).click();
  await page.getByText('我已核实').click();
  const res = page.waitForResponse((r) => r.url().endsWith('/api/recharges') && r.status() === 200);
  await page.getByRole('button', { name: /确认入账/ }).click();
  const bonus = ((await (await res).json()) as { recharge: { bonusAmount: number } }).recharge.bonusAmount;
  await expect(page.getByText('充值已入账')).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]); // 同一个操作编号、同样的内容
  await page.unroute('**/api/recharges');
  await page.getByRole('button', { name: '完成' }).click();
  await expect.poll(() => availableCents(page)).toBe(before + 30000 + bonus);
  // 「网络与同步」里记着这次自动重发
  await page.getByTestId('user-menu').click();
  await page.getByTestId('user-menu-network').click();
  await expect(page.getByTestId('network-problems')).toContainText('秒后自动重发');
});

test('页面代码第一次没下载下来：再导入一次；浏览器记住了失败就在连得上时重新加载这一页，照常打开', async ({ page }) => {
  await login(page);
  let tries = 0;
  await page.route('**/assets/ClockroomPage-*.js', async (route) => {
    tries += 1;
    if (tries === 1) await route.abort('connectionreset');
    else await route.continue();
  });
  await page.goto('/clockroom');
  await expect(page.getByRole('heading', { name: '钟房' }).first()).toBeVisible({ timeout: 20_000 });
  expect(tries).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('page-load-failed')).toHaveCount(0);
  await expect(page.getByTestId('page-error')).toHaveCount(0);
});

test('页面代码一直下载不下来：只自动重新加载一次，之后给「重新加载」按钮（不一直刷）', async ({ page }) => {
  await login(page);
  let tries = 0;
  let loads = 0; // 钟房这一页的整页加载：打开那一次 + 自动重新加载
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).pathname === '/clockroom') loads += 1;
  });
  await page.route('**/assets/ClockroomPage-*.js', async (route) => {
    tries += 1;
    await route.abort('connectionreset');
  });
  await page.goto('/clockroom');
  await expect(page.getByTestId('page-load-failed')).toBeVisible({ timeout: 20_000 });
  const seen = { tries, loads };
  await page.waitForTimeout(2_500);
  expect(loads).toBe(2); // 打开 + 只自动重新加载一次
  // 每次加载最多下载两次（第一次 + 1 秒后再导入）。浏览器记住失败的下载时，再导入不去取，一共 2 次（Chromium 153）；
  // 不记住的再导入会重新去取，一共 4 次（8.1.4 验收用的 Chromium 156）。两种都对，这里不认死次数。
  expect(tries).toBeGreaterThanOrEqual(2);
  expect(tries).toBeLessThanOrEqual(4);
  expect({ tries, loads }).toEqual(seen); // 给了按钮以后不再下载、不再刷新
  await expect(page.getByTestId('page-load-failed')).toBeVisible();
});

test('页面出错：只换掉这一块（导航还能用）、报给服务器；店主在「网络与同步」里看得到；换一页就好', async ({ page }) => {
  await login(page);
  await page.route('**/assets/ClockroomPage-*.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: "export function ClockroomPage() { throw new Error('e2e：故意让这一页出错'); }" }),
  );
  const reported = page.waitForRequest((r) => r.url().endsWith('/api/client-errors') && r.method() === 'POST');
  await page.goto('/clockroom');
  await expect(page.getByTestId('page-error')).toBeVisible();
  await expect(page.getByTestId('page-error')).toContainText('这一块出了点问题');
  const body = JSON.parse((await reported).postData() ?? '{}') as { kind: string; message: string; path: string };
  expect(body).toMatchObject({ kind: 'render', path: '/clockroom' });
  expect(body.message).toContain('故意让这一页出错');
  // 导航还在，换一页就恢复
  await clickNav(page, '会员');
  await expect(page.getByRole('heading', { name: '会员工作台' })).toBeVisible();
  await expect(page.getByTestId('page-error')).toHaveCount(0);
  await page.goto('/network');
  await expect(page.getByTestId('network-store-errors')).toContainText('故意让这一页出错');
});

test('系统更新了：提示方便时刷新（不自动刷新），可以先「稍后」', async ({ page }) => {
  await login(page);
  await page.route('**/api/ping', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), version: '9.9.9', client: '/assets/index-e2e-new.js' } });
  });
  await page.getByTestId('user-menu').click();
  await page.getByTestId('user-menu-network').click();
  await page.getByTestId('network-check').click();
  await expect(page.getByText('更新前打开的旧页面')).toBeVisible();
  await page.goBack();
  await expect(banner(page, 'updated')).toBeVisible();
  await expect(banner(page, 'updated')).toContainText('9.9.9');
  await banner(page, 'updated').getByRole('button', { name: '稍后' }).click();
  await expect(page.getByTestId('network-banner')).toHaveCount(0);
});
