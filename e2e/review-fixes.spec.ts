// 首版审查问题的回归验证（依赖演示数据：店主 linlan / 店员 xiaozhou，密码 yuzu2026）。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '会员工作台' })).toBeVisible({ timeout: 30_000 }); // 刚启动的服务第一次登录可能较慢
}

async function openMember(page: Page, name: string) {
  await page.getByLabel('搜索会员').fill(name);
  await expect(page.getByRole('option').first()).toContainText(name);
  await page.getByRole('option').filter({ hasText: name }).first().click();
  await expect(page.locator('main').getByRole('heading', { name })).toBeVisible();
}

/** 通过接口读取会员余额（分） */
async function balance(page: Page, name: string) {
  const res = await page.request.get(`/api/members?q=${encodeURIComponent(name)}`);
  const [m] = (await res.json()) as { principalBalance: number; bonusBalance: number }[];
  return { principal: m!.principalBalance, bonus: m!.bonusBalance };
}

async function rechargeCount(page: Page, name: string) {
  const res = await page.request.get(`/api/ledger?type=recharge&q=${encodeURIComponent(name)}`);
  return ((await res.json()) as unknown[]).length;
}

/** 走到充值核对页并确认收款，但先不点「确认入账」 */
async function prepareRecharge(page: Page, plan: RegExp, method: string) {
  await page.getByRole('button', { name: /^充值/ }).first().click();
  await fillRecharge(page, plan, method);
}

/** 在已打开的充值面板里填写到核对页 */
async function fillRecharge(page: Page, plan: RegExp, method: string) {
  await page.getByRole('button', { name: plan }).click();
  await page.getByRole('button', { name: method }).click();
  await page.getByRole('button', { name: '下一步：核对收款' }).click();
  await page.getByText('我已核实').click();
}

const pendingBanner = (page: Page) => page.getByRole('status').filter({ hasText: '笔操作结果待确认' });

/** 下一次提交被截下：浏览器以为断网，原请求留待 deliver() 时才原样送到服务器（模拟迟到的原请求） */
async function lateRequest(page: Page, pattern: string) {
  let body: { idempotencyKey: string; memberId: number } | null = null;
  let url = '';
  await page.route(
    pattern,
    async (route) => {
      url = route.request().url();
      body = route.request().postDataJSON();
      await route.abort('connectionreset');
    },
    { times: 1 },
  );
  return {
    key: () => body!.idempotencyKey,
    memberId: () => body!.memberId,
    deliver: async () => {
      const res = await page.request.post(url, { data: body });
      return { status: res.status(), code: ((await res.json()) as { error?: { code: string } }).error?.code };
    },
  };
}

async function lookupOp(page: Page, key: string, type: 'recharge' | 'consume' | 'reversal') {
  return (await page.request.get(`/api/operations/${key}?type=${type}`)).json();
}

test.describe('待确认操作在关闭、刷新、重新登录后仍可处理', () => {
  test('入账后响应丢失：关闭面板后自动查回原单，只入账一次', async ({ page }) => {
    await login(page, 'xiaozhou');
    await openMember(page, '唐果');
    const before = await balance(page, '唐果');
    const countBefore = await rechargeCount(page, '唐果');

    // 请求到达服务器并入账，但浏览器收到 503（模拟成功响应在网络中断时丢失）
    await page.route('**/api/recharges', async (route) => {
      await route.fetch();
      await route.fulfill({ status: 503, body: 'Service Unavailable' });
    });
    await prepareRecharge(page, /轻享 300/, '现金');
    await page.getByRole('button', { name: /确认入账/ }).click();
    await expect(page.getByText('结果待确认').first()).toBeVisible();
    await page.unroute('**/api/recharges');

    // 直接关闭面板：页面顶部按原操作编号查回结果
    await page.getByRole('button', { name: '关闭' }).first().click();
    await expect(page.getByText('已查回：唐果 的充值已入账')).toBeVisible();
    await expect(pendingBanner(page)).toHaveCount(0);
    expect(await balance(page, '唐果')).toEqual({ principal: before.principal + 30000, bonus: before.bonus });
    expect(await rechargeCount(page, '唐果')).toBe(countBefore + 1);

    // 之后办理的新一笔是合法的新交易，不应被禁止
    await prepareRecharge(page, /轻享 300/, '现金');
    await page.getByRole('button', { name: /确认入账/ }).click();
    await expect(page.getByText('充值已入账')).toBeVisible();
    expect(await rechargeCount(page, '唐果')).toBe(countBefore + 2);
  });

  test('请求没有到达服务器：刷新后从顶部提醒进入，按原内容重提只入账一次', async ({ page }) => {
    await login(page, 'xiaozhou');
    await openMember(page, '秦朗');
    const before = await balance(page, '秦朗');
    const countBefore = await rechargeCount(page, '秦朗');

    await page.route('**/api/recharges', (route) => route.abort('connectionreset'));
    await prepareRecharge(page, /常泡 500/, '微信');
    await page.getByRole('button', { name: /确认入账/ }).click();
    await expect(page.getByText('结果待确认').first()).toBeVisible();
    await page.unroute('**/api/recharges');

    await page.reload();
    const banner = pendingBanner(page);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('秦朗');
    await banner.getByRole('button', { name: '去处理' }).click();

    await expect(page.getByText('上一笔充值结果待确认')).toBeVisible();
    await expect(page.getByText('暂未查到这笔记录')).toBeVisible();
    await page.getByRole('button', { name: '按原内容重新提交充值' }).click();
    await expect(page.getByText('充值已入账')).toBeVisible();
    await expect(pendingBanner(page)).toHaveCount(0);
    expect(await balance(page, '秦朗')).toEqual({ principal: before.principal + 50000, bonus: before.bonus + 5000 });
    expect(await rechargeCount(page, '秦朗')).toBe(countBefore + 1);
  });

  test('查不到时确认作废：原请求随后才到达也不入账，重新填写只入账一次', async ({ page }) => {
    await login(page, 'xiaozhou');
    await openMember(page, '姜禾');
    const before = await balance(page, '姜禾');
    const countBefore = await rechargeCount(page, '姜禾');

    // 截下原请求、让浏览器以为断网：稍后再把它原样送到服务器，模拟「迟到的原请求」
    const late = await lateRequest(page, '**/api/recharges');
    await prepareRecharge(page, /轻享 300/, '支付宝');
    await page.getByRole('button', { name: /确认入账/ }).click();
    await expect(page.getByText('结果待确认').first()).toBeVisible();
    await page.unroute('**/api/recharges');
    await page.getByRole('button', { name: '关闭' }).first().click();
    await expect(pendingBanner(page)).toBeVisible();

    // 重新打开充值：先进入待确认处理，而不是直接开新单；查不到不等于没有入账
    await page.getByRole('button', { name: /^充值/ }).first().click();
    await expect(page.getByText('暂未查到这笔记录')).toBeVisible();
    await expect(page.getByText('暂时不能断定没有入账')).toBeVisible();
    await page.getByRole('button', { name: '确认作废，重新填写' }).click();
    await expect(page.getByText('已作废这笔充值，没有入账')).toBeVisible();
    await expect(page.getByRole('button', { name: '下一步：核对收款' })).toBeVisible();
    await expect(pendingBanner(page)).toHaveCount(0);

    // 原请求这时才到达：整笔拒绝，余额不变
    const arrived = await late.deliver();
    expect(arrived.status).toBe(409);
    expect(arrived.code).toBe('OP_ABANDONED');
    expect(await balance(page, '姜禾')).toEqual(before);
    expect(await lookupOp(page, late.key(), 'recharge')).toEqual({ found: false, abandoned: true });

    // 在已打开的面板里重新填写：新的一笔正常入账，只有这一笔
    await fillRecharge(page, /轻享 300/, '支付宝');
    await page.getByRole('button', { name: /确认入账/ }).click();
    await expect(page.getByText('充值已入账')).toBeVisible();
    expect(await rechargeCount(page, '姜禾')).toBe(countBefore + 1);
    expect(await balance(page, '姜禾')).toEqual({ principal: before.principal + 30000, bonus: before.bonus });
  });

  test('核对页里直接确认作废；重提被拒绝时也先作废原编号', async ({ page }) => {
    await login(page, 'xiaozhou');
    await openMember(page, '黎明月');
    const before = await balance(page, '黎明月');

    // ① 消费请求没送达：在核对页查询 → 查不到 → 确认作废，原请求随后到达被拒绝
    const late = await lateRequest(page, '**/api/consumptions');
    await page.getByRole('button', { name: /^消费/ }).first().click();
    await page.getByRole('button', { name: /^搓背/ }).click();
    await page.getByRole('button', { name: '下一步：核对扣款' }).click();
    await page.getByRole('button', { name: /确认扣款/ }).click();
    await expect(page.getByText('结果待确认').first()).toBeVisible();
    await page.unroute('**/api/consumptions');
    await page.getByRole('button', { name: '查询这笔操作的结果' }).click();
    await expect(page.getByText('暂未查到这笔记录')).toBeVisible();
    await page.getByRole('button', { name: '确认作废', exact: true }).click();
    await expect(page.getByText('已作废这笔消费，没有入账')).toBeVisible();
    await expect(page.getByRole('button', { name: '返回修改' })).toBeEnabled();
    expect((await late.deliver()).code).toBe('OP_ABANDONED');
    expect(await balance(page, '黎明月')).toEqual(before);

    // ② 再提交一次又断网；其间另一台终端改动了余额，按原内容重提被明确拒绝（余额已变化）。
    //    之前那次请求仍可能随后到达，所以页面先在服务端作废原编号，再回到填写页
    const late2 = await lateRequest(page, '**/api/consumptions');
    await page.getByRole('button', { name: /确认扣款/ }).click();
    await expect(page.getByText('结果待确认').first()).toBeVisible();
    await page.unroute('**/api/consumptions');
    const other = await page.request.post('/api/recharges', {
      data: { idempotencyKey: crypto.randomUUID(), memberId: late2.memberId(), planId: null, paidAmount: 100, bonusAmount: 0, paymentMethod: 'cash', paymentConfirmed: true },
    });
    expect(other.ok()).toBe(true);
    await page.getByRole('button', { name: '查询这笔操作的结果' }).click();
    await page.getByRole('button', { name: '按原内容重新提交' }).click();
    await expect(page.getByText('会员余额刚刚有变化')).toBeVisible();
    expect(await lookupOp(page, late2.key(), 'consume')).toEqual({ found: false, abandoned: true });
    expect((await late2.deliver()).code).toBe('OP_ABANDONED');
    expect(await balance(page, '黎明月')).toEqual({ principal: before.principal + 100, bonus: before.bonus });
    await expect(pendingBanner(page)).toHaveCount(0);
  });

  test('消费响应丢失：退出并重新登录后自动查回，只扣一次', async ({ page }) => {
    await login(page, 'xiaozhou');
    await openMember(page, '黎明月');
    const before = await balance(page, '黎明月');

    await page.route('**/api/consumptions', async (route) => {
      await route.fetch();
      await route.abort('connectionreset');
    });
    await page.getByRole('button', { name: /^消费/ }).first().click();
    await page.getByRole('button', { name: /^搓背/ }).click();
    await page.getByRole('button', { name: '下一步：核对扣款' }).click();
    await page.getByRole('button', { name: /确认扣款/ }).click();
    await expect(page.getByText('结果待确认').first()).toBeVisible();
    await page.unroute('**/api/consumptions');

    // 不处理就离开：登录失效后重新登录（整页重新加载）
    await page.context().clearCookies();
    await page.goto('/login');
    await login(page, 'xiaozhou');
    await expect(page.getByText('已查回：黎明月 的消费已入账')).toBeVisible();
    await expect(pendingBanner(page)).toHaveCount(0);
    const after = await balance(page, '黎明月');
    expect(before.principal + before.bonus - (after.principal + after.bonus)).toBe(5800);
  });
});

test('扣款规则在确认期间被修改：按新构成重新确认后才入账', async ({ page }) => {
  await login(page, 'linlan');
  const settings = await (await page.request.get('/api/settings')).json();
  await page.request.put('/api/settings', { data: { ...settings, deductionRule: 'principal_first' } });
  try {
    await page.reload();
    await openMember(page, '程野');
    const before = await balance(page, '程野');
    await page.getByRole('button', { name: /^消费/ }).first().click();
    await page.getByRole('button', { name: /^山野简餐/ }).click();
    await page.getByRole('button', { name: '下一步：核对扣款' }).click();
    const bonusTile = page.getByText('扣赠金', { exact: true }).locator('xpath=following-sibling::*[1]');
    await expect(bonusTile).toHaveText(/¥\s*0\.00/);

    // 另一位店主把规则改成「先赠金」
    await page.request.put('/api/settings', { data: { ...settings, deductionRule: 'bonus_first' } });
    await page.getByRole('button', { name: /确认扣款/ }).click();
    await expect(page.getByText(/扣款规则刚刚调整为「先赠金，后本金」/)).toBeVisible();
    await expect(bonusTile).toHaveText(/¥\s*48\.00/);
    expect(await balance(page, '程野')).toEqual(before);

    await page.getByRole('button', { name: /确认扣款/ }).click();
    await expect(page.getByText('扣款完成')).toBeVisible();
    expect(await balance(page, '程野')).toEqual({ principal: before.principal, bonus: before.bonus - 4800 });
  } finally {
    await page.request.put('/api/settings', { data: settings });
  }
});

test.describe('1280×720 门店电脑', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('会员余额完整显示，今日概览不被压扁', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== '门店电脑', '只在门店电脑配置下检查一次');
    await login(page, 'linlan');
    await openMember(page, '许嘉木');

    // 余额卡片里每个金额都完整落在卡片内
    const overflow = await page.evaluate(() => {
      const card = document.querySelector('main .paper-grain') as HTMLElement;
      const box = card.getBoundingClientRect();
      return [...card.querySelectorAll('.num')]
        .map((el) => ({ text: (el as HTMLElement).innerText, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5))
        .map(({ text }) => text);
    });
    expect(overflow).toEqual([]);
    await expect(page.locator('main').getByText('累计赠送')).toBeVisible();

    // 今日概览的汇总卡保持完整高度，可以进入日结
    const summary = page.getByRole('region', { name: '今日概览' }).getByText('充值实收').locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
    const height = (await summary.boundingBox())!.height;
    expect(height).toBeGreaterThan(150);
    await page.getByRole('region', { name: '今日概览' }).getByRole('link', { name: /查看日结/ }).click();
    await expect(page.getByRole('heading', { name: '日结' })).toBeVisible();
  });
});
