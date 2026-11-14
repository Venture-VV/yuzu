// 8.0.19 浏览器验收：门店的日常入口（docs/IA_V8017.md 第 3.4 节，IA4）。解绑那一段的接口是拦下来模拟的；本机终端那一条登记一台测试终端、用完停用。可重复执行；
// 依赖演示数据（仅独立演示库），账号：店主 linlan、店员 xiaozhou，密码 yuzu2026。
//   · 发券：会员工作台右上角「发券」→ 批量发券、无记名券两个页签；后台「券」只剩规则、模板、统计、使用率，旧地址跳过来；
//   · 停车登记：会员工作台右上角「停车登记」；后台「会员权益」原处留指路；
//   · 会员详情「微信小程序」一行：没绑的写没有绑定；绑了的有解绑权限的人可以解绑（写原因），店员看不到解绑；
//   · 用户菜单「本机终端」：到「设备」页并定位到那一块。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function firstMember(page: Page): Promise<{ id: number; name: string }> {
  const list = (await (await page.request.get('/api/members?q=&limit=20')).json()) as { id: number; name: string; status: string }[];
  return list.find((m) => m.status === 'active')!;
}

const BINDING = { id: 770019, openidTail: 'a1b2c3', phone: '13800001111', mock: true, boundAt: '2026-11-02T03:00:00.000Z', unboundAt: null, unboundByName: null, unbindReason: null, purgedAt: null };

test.describe('8.0.19 门店的日常入口', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸跑一次');

  test('发券：从会员工作台进，两个页签写进地址；后台「券」只留规则、模板、统计、使用率，旧地址跳过来', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/');
    await page.getByTestId('workbench-coupon-issue').click();
    await expect(page).toHaveURL(/\/coupon-issue$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('发券');
    await expect(page.getByTestId('subnav').getByRole('link')).toHaveText(['批量发券', '无记名券']);
    await expect(page.getByTestId('campaign-new')).toBeVisible();
    await page.getByTestId('coupon-tab-batches').click();
    await expect(page).toHaveURL(/\/coupon-issue\/batches$/);
    await expect(page.getByTestId('coupon-batch-new')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('coupon-batch-new')).toBeVisible({ timeout: 20_000 });

    // 后台「券」
    await page.getByTestId('coupon-issue-admin-link').click();
    await expect(page).toHaveURL(/\/admin\/coupons$/);
    await expect(page.getByTestId('subnav').getByRole('link')).toHaveText(['发券规则', '券模板', '统计', '使用率']);
    await page.getByTestId('coupon-issue-link').click();
    await expect(page).toHaveURL(/\/coupon-issue$/);
    for (const [from, to] of [
      ['/admin/coupons/campaigns', /\/coupon-issue$/],
      ['/admin/coupons/batches', /\/coupon-issue\/batches$/],
      ['/admin/coupons?tab=campaigns', /\/coupon-issue$/],
      ['/admin/coupons?tab=batches', /\/coupon-issue\/batches$/],
      // 没挪的旧地址照旧
      ['/admin/coupons?tab=usage', /\/admin\/coupons\/usage$/],
    ] as const) {
      await page.goto(from);
      await expect(page, from).toHaveURL(to);
    }
  });

  test('店员（不能维护券）：工作台没有「发券」，直接打开地址回工作台；有「停车登记」，打得开', async ({ page }) => {
    await login(page, 'xiaozhou');
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: '会员工作台' })).toBeVisible();
    await expect(page.getByTestId('workbench-coupon-issue')).toHaveCount(0);
    await page.goto('/coupon-issue');
    await expect(page).toHaveURL(/\/$/);
    await page.getByTestId('workbench-parking-log').click();
    await expect(page).toHaveURL(/\/parking-log$/);
    await expect(page.getByTestId('benefit-parking-log')).toBeVisible();
    // 默认看今天
    const today = ((await (await page.request.get('/api/auth/me')).json()) as { today: string }).today;
    await expect(page.locator('#parking-from')).toHaveValue(today);
    await expect(page.locator('#parking-to')).toHaveValue(today);
  });

  test('会员详情「微信小程序」：没绑的写没有绑定；绑了的店主可以解绑（写原因、带操作编号），店员看不到解绑', async ({ page, browser }) => {
    await login(page, 'linlan');
    const member = await firstMember(page);
    // 真的接口：演示会员没有绑过
    await page.goto(`/?m=${member.id}`);
    await expect(page.getByTestId('member-wechat')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('member-wechat-none')).toContainText('没有绑定');

    // 绑了的：把读绑定、解绑两个接口拦下来模拟（真的绑定要走小程序，演示库里没有）
    let unbound = false;
    const posted: { clientKey?: string; reason?: string }[] = [];
    await page.route(`**/api/admin/mp/members/${member.id}/bindings`, (route) =>
      route.fulfill({ json: [unbound ? { ...BINDING, unboundAt: '2026-11-14T04:00:00.000Z', unboundByName: '林岚', unbindReason: '换手机号' } : BINDING] }),
    );
    await page.route(`**/api/admin/mp/bindings/${BINDING.id}/unbind`, async (route) => {
      posted.push(route.request().postDataJSON());
      unbound = true;
      await route.fulfill({ json: { ...BINDING, unboundAt: '2026-11-14T04:00:00.000Z', unboundByName: '林岚', unbindReason: '换手机号' } });
    });
    await page.reload();
    const row = page.getByTestId(`member-wechat-binding-${BINDING.id}`);
    await expect(row).toContainText('已绑定');
    await expect(row).toContainText('…a1b2c3');
    await page.getByTestId('member-wechat-unbind').click();
    // 没写原因不能解绑
    await expect(page.getByTestId('member-wechat-unbind-submit')).toBeDisabled();
    await page.getByTestId('member-wechat-unbind-reason').fill('换手机号');
    await page.getByTestId('member-wechat-unbind-submit').click();
    await expect(page.getByText('已解绑').first()).toBeVisible();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.reason).toBe('换手机号');
    expect(posted[0]!.clientKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(page.getByTestId('member-wechat-none')).toContainText('以前绑过 1 次');
    await expect(page.getByTestId('member-wechat-pending')).toHaveCount(0);

    // 店员：看得到绑定，没有解绑
    const ctx = await browser.newContext();
    const clerk = await ctx.newPage();
    try {
      await login(clerk, 'xiaozhou');
      await clerk.route(`**/api/admin/mp/members/${member.id}/bindings`, (route) => route.fulfill({ json: [BINDING] }));
      await clerk.goto(`/?m=${member.id}`);
      await expect(clerk.getByTestId(`member-wechat-binding-${BINDING.id}`)).toContainText('已绑定');
      await expect(clerk.getByTestId('member-wechat-unbind')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('解绑没收到结果：记在本机、这一行提示去后台处理，期间不能另起一笔', async ({ page }) => {
    await login(page, 'linlan');
    const member = await firstMember(page);
    await page.route(`**/api/admin/mp/members/${member.id}/bindings`, (route) => route.fulfill({ json: [BINDING] }));
    // 请求发出去了、回复丢了
    await page.route(`**/api/admin/mp/bindings/${BINDING.id}/unbind`, (route) => route.abort('connectionreset'));
    await page.goto(`/?m=${member.id}`);
    await page.getByTestId('member-wechat-unbind').click();
    await page.getByTestId('member-wechat-unbind-reason').fill('换微信');
    await page.getByTestId('member-wechat-unbind-submit').click();
    await expect(page.getByText('解绑结果待确认').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('member-wechat-pending')).toBeVisible();
    await expect(page.getByTestId('member-wechat-unbind')).toBeDisabled();
    // 刷新以后还在
    await page.reload();
    await expect(page.getByTestId('member-wechat-pending')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('member-wechat-unbind')).toBeDisabled();
    // 收尾：这是模拟的一笔，把本机的记录清掉（真的要到后台「微信小程序 → 绑定」处理）
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.includes('mp') && (localStorage.getItem(k) ?? '').includes('"unbind"')) localStorage.removeItem(k);
    });
    await page.reload();
    await expect(page.getByTestId('member-wechat')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('member-wechat-pending')).toHaveCount(0);
  });

  test('用户菜单「本机终端」：写着这台电脑设成了哪台，点了到「设备」页并定位到那一块', async ({ page }) => {
    await login(page, 'linlan');
    // 要有一台启用的终端，「设备」页才有「本机终端」那一块：登记一台测试终端，用完停用
    const code = `E2E-T19-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const created = await page.request.post('/api/devices', { data: { clientKey: randomUUID(), code, name: `测试终端 ${code}`, kind: 'terminal', area: '收银', connection: 'none' } });
    expect(created.ok(), await created.text()).toBe(true);
    try {
      await page.goto('/ledger');
      await page.getByTestId('user-menu').click();
      await expect(page.getByTestId('user-menu-terminal')).toContainText('本机终端');
      await expect(page.getByTestId('user-menu-terminal-current')).toHaveText('未设置');
      await page.getByTestId('user-menu-terminal').click();
      await expect(page).toHaveURL(/\/devices#terminal$/);
      const panel = page.getByTestId('terminal-panel');
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await expect(panel).toBeInViewport();
      await expect(panel).toHaveAttribute('data-focused', 'true');
      // 选上这台：用户菜单里跟着写出来；改回「不是终端」免得这个浏览器一直替它上报
      await page.getByTestId('terminal-select').selectOption(code);
      await page.getByTestId('user-menu').click();
      await expect(page.getByTestId('user-menu-terminal-current')).toHaveText(code);
      await page.keyboard.press('Escape');
      await page.getByTestId('terminal-select').selectOption('');
    } finally {
      const list = ((await (await page.request.get('/api/devices/overview')).json()) as { devices: { id: number; code: string; enabled: boolean; version: number }[] }).devices;
      const d = list.find((x) => x.code === code);
      if (d?.enabled) await page.request.post(`/api/devices/${d.id}/enabled`, { data: { enabled: false, expectedVersion: d.version } });
    }
  });
});
