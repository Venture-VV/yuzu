// 视口冒烟（R1.6，只读）：除门店电脑 1440×900、平板 1024×768 / 820×1180 外，再看 1280×720 的小屏电脑与手机（393×727）。
// 看板、日结、管理后台在手机上也要能看（店主用手机查）；前台、交班、会员工作台只在电脑与平板上用。依赖四套演示数据，账号店主 linlan。
// 核对：页面不横向滚动；除了有意横向滚动的区域（表格、标签栏，带 overflow-x-auto），没有横向滚动区，也没有内容超出屏幕右边。
import { expect, test, type Locator, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 }); // 刚启动的服务第一次登录可能较慢
}

/** 页面在当前视口内放得下：列出前几处横向滚动或超出屏幕右边的元素 */
const dayBefore = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * 有营业数据（结账、反结账或充值）的营业日：今天，否则前一个营业日；都没有时为今天。
 * 演示数据在营业日切换（06:00）之前灌、用例跑到切换之后时，今天还没有营业数据，日结页不显示营业口径这一块
 * （CI 在 fbb63dc 上跨过 06:00 时「平板横屏」的日结冒烟因此失败）
 */
async function businessDay(page: Page): Promise<{ date: string; today: boolean }> {
  const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string };
  for (const date of [me.today, dayBefore(me.today)]) {
    const s = (await (await page.request.get(`/api/settlements/${date}`)).json()) as {
      business?: { checkouts: { count: number }; voids: { count: number } };
      recharge?: { count: number };
    };
    if ((s.business?.checkouts.count ?? 0) + (s.business?.voids.count ?? 0) + (s.recharge?.count ?? 0) > 0) return { date, today: date === me.today };
  }
  return { date: me.today, today: true };
}

async function expectFits(page: Page) {
  // 等弹出、滑入等动画结束再量（循环播放的加载动画除外），量到一半会差一两个像素
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const problems = await page.evaluate(() => {
    const vw = window.innerWidth;
    const scrollsOnPurpose = (el: Element | null) => {
      for (let e = el; e; e = e.parentElement) if (/\boverflow-x-(auto|scroll)\b/.test(e.getAttribute('class') ?? '')) return true;
      return false;
    };
    const name = (el: Element) => {
      const id = el.getAttribute('data-testid');
      return `<${el.tagName.toLowerCase()}${id ? ` data-testid="${id}"` : ''}>「${(el.textContent ?? '').trim().slice(0, 24)}」`;
    };
    const out: string[] = [];
    if (document.documentElement.scrollWidth > vw) out.push(`页面横向滚动：${document.documentElement.scrollWidth} > ${vw}`);
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const scrollX = (style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
      if (scrollX && !scrollsOnPurpose(el)) out.push(`横向滚动区 ${name(el)}：${el.scrollWidth} > ${el.clientWidth}`);
      else if (r.right > vw + 1 && !scrollsOnPurpose(el.parentElement)) out.push(`超出屏幕右边 ${name(el)}：right ${Math.round(r.right)} > ${vw}`);
    }
    return out.slice(0, 8);
  });
  expect(problems).toEqual([]);
}

/** 主导航最后一个入口「后台」与实例标识之间的余量：标识是一行时要放得下多一行（演示库、测试服是两行），已经是两行时只要不挨着 */
async function expectNavRoomForTwoLineTag(nav: Locator, tag: { y: number }) {
  const twoLines = await nav
    .getByTestId('instance-tag')
    .locator('span')
    .first()
    .evaluate((el) => el.querySelector('br') !== null);
  const last = (await nav.getByRole('link', { name: '后台', exact: true }).boundingBox())!;
  const gap = tag.y - (last.y + last.height);
  expect(gap, twoLines ? '「后台」与两行的实例标识不挨着' : '「后台」与实例标识之间放得下多一行标识').toBeGreaterThanOrEqual(twoLines ? 4 : 16);
}

test.describe('视口冒烟', () => {
  test('看板：指标卡、近几天营业额、收款构成、当班中（2026-11-10 起在后台「数据看板」）', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/dashboard');
    await expect(page.getByRole('heading', { name: '数据看板' })).toBeVisible();
    const board = page.getByTestId('dashboard');
    // R1.2 起指标卡是「今日净营业额（应收 − 优惠）」，v0.7.20 起「…− 券抵扣 − 退款）」，v0.7.25 起「今日净营业额（应收 − 优惠 − 券抵扣 − 会员折扣 − 退款）」
    await expect(board).toContainText('今日净营业额');
    await expect(board).toContainText('今日收款构成');
    await expect(board).toContainText('当班中');
    await expectFits(page);
  });

  test('看板：经营总览与会员总览（v0.6.0）', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/dashboard/overview');
    await expect(page.getByTestId('overview-net')).toBeVisible();
    await expectFits(page);
    await page.goto('/dashboard/members');
    await expect(page.getByTestId('members-total')).toBeVisible();
    await expectFits(page);
  });

  test('管理后台：后台首页与规则总表（v0.6.0，手机上分区横排）', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin');
    await expect(page.getByTestId('admin-home')).toBeVisible();
    await expect(page.getByTestId('admin-instance')).toBeVisible();
    await expectFits(page);
    await page.goto('/admin/settings');
    await expect(page.getByTestId('rule-catalog')).toBeVisible();
    await expectFits(page);
  });

  test('管理后台：空间台账（v0.7.14）的空间、楼层与区域、导入', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/spaces');
    await expect(page.getByTestId('spaces-summary')).toBeVisible();
    await expect(page.getByTestId('spaces-list')).toBeVisible();
    await expectFits(page);
    await page.getByTestId('subnav-zones').click();
    await expect(page.getByTestId('floor-L3')).toBeVisible();
    await expectFits(page);
    await page.getByTestId('subnav-import').click();
    await expect(page.getByTestId('space-import')).toBeVisible();
    await expectFits(page);
    // 底图（v0.7.15）：有批次时连预览一起看
    await page.getByTestId('subnav-plans').click();
    await expect(page.getByTestId('floorplan-upload')).toBeVisible();
    const hasBatch = (await (await page.request.get('/api/admin/floorplans')).json()).batches.length > 0;
    if (hasBatch) await expect(page.getByTestId('floorplan-detail')).toBeVisible();
    await expectFits(page);
  });

  test('技师：后台「技师」与看板「技师业绩」（v0.7.0；技师功能关闭时看板不显示「技师业绩」，v0.7.3）', async ({ page }) => {
    await login(page, 'linlan');
    const tech = (await (await page.request.get('/api/admin/technicians')).json()) as { rules: { enabled: boolean } };
    if (!tech.rules.enabled) {
      // 功能关闭：看板没有「技师业绩」，直接打开回到看板
      await page.goto('/dashboard/technicians');
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByTestId('dashboard-tab-technicians')).toHaveCount(0);
    }
    await page.goto('/admin/technicians');
    await expect(page.getByTestId('technician-rules-card')).toBeVisible();
    await page.getByTestId('subnav-items').click();
    await expect(page.getByTestId('technician-items')).toBeVisible();
    await expectFits(page);
    // 新建技师的对话框（只打开、不保存）
    await page.getByTestId('subnav-roster').click();
    await page.getByTestId('technician-new').click();
    await expect(page.getByRole('dialog', { name: '新建技师' })).toBeVisible();
    await expectFits(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '新建技师' })).toBeHidden();
    // 只临时打开技师功能看「技师业绩」，结束时恢复原样
    if (!tech.rules.enabled) expect((await page.request.put('/api/admin/technicians/rules', { data: { enabled: true } })).ok()).toBe(true);
    try {
      await page.goto('/dashboard/technicians');
      await expect(page.getByTestId('technicians-clocks')).toBeVisible();
      await expectFits(page);
    } finally {
      if (!tech.rules.enabled) expect((await page.request.put('/api/admin/technicians/rules', { data: { enabled: false } })).ok()).toBe(true);
    }
  });

  test('钟房：看板、派钟对话框，开启技师后主导航 8 个入口都看得到（v0.7.1；v0.7.3 起库存等在 ERP）', async ({ page, isMobile }) => {
    await login(page, 'linlan');
    // 只临时打开「技师功能」开关看页面（不派钟、不写业务数据），结束时恢复原样
    const before = (await (await page.request.get('/api/admin/technicians')).json()) as { rules: { enabled: boolean } };
    if (!before.rules.enabled) expect((await page.request.put('/api/admin/technicians/rules', { data: { enabled: true } })).ok()).toBe(true);
    try {
      await page.goto('/clockroom');
      await expect(page.getByTestId('clock-queue')).toBeVisible();
      await expectFits(page);
      if (!isMobile) {
        const nav = page.getByRole('navigation', { name: '主导航' });
        const viewport = page.viewportSize()!;
        const tag = (await nav.getByTestId('instance-tag').boundingBox())!;
        for (const name of ['前台', '钟房', '会员', '流水', '日结', '交班', '后台']) {
          const box = (await nav.getByRole('link', { name, exact: true }).boundingBox())!;
          expect(box.y + box.height, `「${name}」在实例标识之上`).toBeLessThanOrEqual(tag.y + 1);
          expect(box.y + box.height, `「${name}」在屏幕内`).toBeLessThanOrEqual(viewport.height);
        }
      }
      await page.getByTestId('clock-dispatch').click();
      await expect(page.getByRole('dialog', { name: '派钟' })).toBeVisible();
      await expectFits(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: '派钟' })).toBeHidden();
      await page.goto('/admin/technicians');
      await expect(page.getByTestId('clockroom-rules-card')).toBeVisible();
      await expect(page.getByTestId('commission-card')).toBeVisible();
      await expectFits(page);
    } finally {
      if (!before.rules.enabled) expect((await page.request.put('/api/admin/technicians/rules', { data: { enabled: false } })).ok()).toBe(true);
    }
  });

  test('餐饮：点单、桌台、厨房出品、估清与后台「餐饮」，开启技师与餐饮后主导航 9 个入口都看得到（S5）', async ({ page, isMobile }) => {
    await login(page, 'linlan');
    // 只临时打开两个功能开关看页面（不点单、不写业务数据），结束时恢复原样
    const tech = (await (await page.request.get('/api/admin/technicians')).json()) as { rules: { enabled: boolean } };
    const dining = (await (await page.request.get('/api/admin/dining')).json()) as { rules: { enabled: boolean } };
    if (!tech.rules.enabled) expect((await page.request.put('/api/admin/technicians/rules', { data: { enabled: true } })).ok()).toBe(true);
    if (!dining.rules.enabled) expect((await page.request.put('/api/admin/dining/rules', { data: { enabled: true } })).ok()).toBe(true);
    try {
      await page.goto('/dining');
      await expect(page.getByTestId('dining-order')).toBeVisible();
      await expect(page.getByTestId('dining-cart')).toBeVisible();
      await expectFits(page);
      if (!isMobile) {
        const nav = page.getByRole('navigation', { name: '主导航' });
        const viewport = page.viewportSize()!;
        const tag = (await nav.getByTestId('instance-tag').boundingBox())!;
        for (const name of ['前台', '钟房', '餐饮', '会员', '流水', '日结', '交班', '后台']) {
          const box = (await nav.getByRole('link', { name, exact: true }).boundingBox())!;
          expect(box.y + box.height, `「${name}」在实例标识之上`).toBeLessThanOrEqual(tag.y + 1);
          expect(box.y + box.height, `「${name}」在屏幕内`).toBeLessThanOrEqual(viewport.height);
        }
        // 演示库、测试服的实例标识是两行（例如「演示」「不作数」），开发环境是一行：一行时最后一个入口与标识之间要留出多一行（16 像素，Codex 复测 PR #18 P2）；
        // 已经是两行时那一行已经算在标识里，只要求不挨着（4 像素）——原来一律按 16 算，在演示库上量到 12.5 像素就报错，其实没有遮挡（测试会话 YUZU-MAIN-68391-FULL-20261114）
        await expectNavRoomForTwoLineTag(nav, tag);
      }
      await page.getByTestId('dining-tab-kitchen').click();
      await expect(page.getByTestId('kitchen')).toBeVisible();
      await expectFits(page);
      await page.getByTestId('dining-tab-limits').click();
      await expect(page.getByTestId('limits')).toBeVisible();
      await expectFits(page);
      // 第二步：桌台页（桌台格子）
      await page.getByTestId('dining-tab-tables').click();
      await expect(page.getByTestId('dining-tables-board')).toBeVisible();
      await expectFits(page);
      await page.goto('/admin/dining');
      await expect(page.getByTestId('dining-rules-card')).toBeVisible();
      await page.getByTestId('subnav-stations').click();
      await expect(page.getByTestId('dining-items')).toBeVisible();
      await page.getByTestId('subnav-tables').click();
      await expect(page.getByTestId('dining-tables')).toBeVisible();
      await expectFits(page);
    } finally {
      if (!dining.rules.enabled) expect((await page.request.put('/api/admin/dining/rules', { data: { enabled: false } })).ok()).toBe(true);
      if (!tech.rules.enabled) expect((await page.request.put('/api/admin/technicians/rules', { data: { enabled: false } })).ok()).toBe(true);
    }
  });

  test('客房：房态看板、后台「客房」与看板「客房」，技师、餐饮、客房都开启后主导航 10 个入口都看得到（S7）', async ({ page, isMobile }) => {
    await login(page, 'linlan');
    // 只临时打开三个功能开关看页面（不入住、不写业务数据），结束时恢复原样
    const tech = (await (await page.request.get('/api/admin/technicians')).json()) as { rules: { enabled: boolean } };
    const dining = (await (await page.request.get('/api/admin/dining')).json()) as { rules: { enabled: boolean } };
    const rooms = (await (await page.request.get('/api/admin/rooms')).json()) as { rules: { enabled: boolean } & Record<string, unknown> };
    if (!tech.rules.enabled) expect((await page.request.put('/api/admin/technicians/rules', { data: { enabled: true } })).ok()).toBe(true);
    if (!dining.rules.enabled) expect((await page.request.put('/api/admin/dining/rules', { data: { enabled: true } })).ok()).toBe(true);
    if (!rooms.rules.enabled) expect((await page.request.put('/api/admin/rooms/rules', { data: { ...rooms.rules, enabled: true } })).ok()).toBe(true);
    try {
      await page.goto('/rooms');
      await expect(page.getByTestId('rooms-board')).toBeVisible();
      await expectFits(page);
      if (!isMobile) {
        const nav = page.getByRole('navigation', { name: '主导航' });
        const viewport = page.viewportSize()!;
        const tag = (await nav.getByTestId('instance-tag').boundingBox())!;
        for (const name of ['前台', '钟房', '餐饮', '客房', '会员', '流水', '日结', '交班', '后台']) {
          const box = (await nav.getByRole('link', { name, exact: true }).boundingBox())!;
          expect(box.y + box.height, `「${name}」在实例标识之上`).toBeLessThanOrEqual(tag.y + 1);
          expect(box.y + box.height, `「${name}」在屏幕内`).toBeLessThanOrEqual(viewport.height);
        }
        // 演示库、测试服的实例标识是两行（例如「演示」「不作数」），开发环境是一行：一行时最后一个入口与标识之间要留出多一行（16 像素，Codex 复测 PR #18 P2）；
        // 已经是两行时那一行已经算在标识里，只要求不挨着（4 像素）——原来一律按 16 算，在演示库上量到 12.5 像素就报错，其实没有遮挡（测试会话 YUZU-MAIN-68391-FULL-20261114）
        await expectNavRoomForTwoLineTag(nav, tag);
      }
      await page.goto('/admin/rooms');
      await expect(page.getByTestId('rooms-rules-card')).toBeVisible();
      await page.getByTestId('subnav-types').click();
      await expect(page.getByTestId('rooms-types')).toBeVisible();
      await page.getByTestId('subnav-rooms').click();
      await expect(page.getByTestId('rooms-rooms')).toBeVisible();
      await expectFits(page);
      await page.goto('/dashboard/rooms');
      await expect(page.getByTestId('dashboard-rooms')).toBeVisible();
      await expect(page.getByTestId('rooms-now')).toBeVisible();
      await expectFits(page);
    } finally {
      if (!rooms.rules.enabled) expect((await page.request.put('/api/admin/rooms/rules', { data: { ...rooms.rules, enabled: false } })).ok()).toBe(true);
      if (!dining.rules.enabled) expect((await page.request.put('/api/admin/dining/rules', { data: { enabled: false } })).ok()).toBe(true);
      if (!tech.rules.enabled) expect((await page.request.put('/api/admin/technicians/rules', { data: { enabled: false } })).ok()).toBe(true);
    }
  });

  test('流水：手机上不横向滚动（测试服 E2E 报告）', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/ledger');
    await expect(page.getByRole('heading', { name: '流水' })).toBeVisible();
    await expectFits(page);
  });

  test('主导航：小屏电脑上所有入口不用滚动就能看到（测试服 E2E 报告 BUG-1）', async ({ page, isMobile }) => {
    test.skip(!!isMobile, '手机上用不到左侧导航');
    await login(page, 'linlan');
    const nav = page.getByRole('navigation', { name: '主导航' });
    const viewport = page.viewportSize()!;
    const tag = (await nav.getByTestId('instance-tag').boundingBox())!;
    for (const name of ['前台', '会员', '流水', '日结', '交班', '后台']) {
      const box = (await nav.getByRole('link', { name, exact: true }).boundingBox())!;
      expect(box.y + box.height, `「${name}」在实例标识之上`).toBeLessThanOrEqual(tag.y + 1);
      expect(box.y + box.height, `「${name}」在屏幕内`).toBeLessThanOrEqual(viewport.height);
    }
    // v0.7.3：库存、采购、货款、待办在 ERP 工作区，不在主导航；看板 2026-11-10 起在后台「数据看板」
    for (const name of ['库存', '采购', '货款', '待办', '看板']) await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  });

  test('ERP 工作区：首页、库存、采购、应付货款、审批中心、营业数据、模块设置都不横向滚动，实例标识常显（v0.7.3）', async ({ page, isMobile }) => {
    await login(page, 'linlan');
    await page.goto('/erp');
    await expect(page.getByTestId('erp-shell')).toBeVisible();
    await expect(page.getByTestId('erp-instance')).toBeVisible();
    await expect(page.getByTestId('erp-modules')).toBeVisible();
    await expectFits(page);
    const navName = isMobile || (page.viewportSize()?.width ?? 0) < 1024 ? 'ERP 分区' : 'ERP 导航';
    const erpNav = page.getByRole('navigation', { name: navName });
    for (const name of ['ERP 首页', '库存', '采购', '应付货款', '审批中心', 'ERP 设置']) await expect(erpNav.getByRole('link', { name, exact: true })).toHaveCount(1);
    for (const [url, testId] of [
      ['/inventory', null],
      ['/purchasing', null],
      ['/payables', null],
      ['/todo', null],
      // v0.7.30：审批中心（待我审批、审批规则、代理人）
      ['/approvals', 'approvals-page'],
      ['/approvals?tab=rules', 'approval-rules'],
      ['/approvals?tab=delegations', 'approval-delegations'],
      // 8.0.18：模块开关、各模块的规则在「ERP 设置」的页签里（旧地址 /erp/modules 跳过去）
      ['/erp/modules', 'erp-module-switches'],
      ['/erp/settings/purchase', 'purchase-rules'],
      ['/erp/settings/approvals', 'approval-rules'],
      ['/erp/settings/payments', 'payment-rules'],
      ['/erp/settings/tunables', 'tunables-card'],
      // 采购、费用的子页顶上的页签
      ['/purchasing/flow', 'purchasing-tabs'],
      ['/erp/petty', 'subnav'],
      // v0.7.9：采购台账、账目自检、下单物料
      ['/erp/ledger', 'ledger-page'],
      ['/erp/audit', 'audit-page'],
      ['/purchasing/ordered', 'ordered-page'],
      // v0.7.10：旧账对照（核验页与带原图的已下单物料）
      ['/erp/legacy', 'legacy-page'],
      ['/erp/legacy?tab=ordered', 'legacy-page'],
      // v0.7.12：核销与退款、批量导入、付款登记（预付款）
      ['/payables?view=settlements', null],
      ['/payables/import', null],
      ['/payables/pay', null],
      // v0.7.13：供应商对账
      ['/payables?view=recon', null],
    ] as const) {
      await page.goto(url);
      await expect(page.getByTestId('erp-shell')).toBeVisible();
      if (testId) await expect(page.getByTestId(testId)).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectFits(page);
    }
    // 8.0.18：营业数据并进了后台的数据看板（旧地址 /erp/revenue 跳过去，这时在后台的外壳里，不是 ERP 的）
    await page.goto('/erp/revenue');
    await expect(page).toHaveURL(/\/admin\/dashboard\/revenue$/);
    await expect(page.getByTestId('admin-shell')).toBeVisible();
    await expect(page.getByTestId('erp-revenue')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectFits(page);
  });

  test('日结：营业口径、余额核对与异常', async ({ page }) => {
    await login(page, 'linlan');
    const day = await businessDay(page);
    await page.goto(day.today ? '/settlement' : `/settlement/${day.date}`);
    await expect(page.getByRole('heading', { name: '日结' })).toBeVisible();
    await expect(page.getByTestId('settlement-business')).toBeVisible();
    await expectFits(page);
  });

  test('前台、交班、会员工作台（电脑与平板）', async ({ page, isMobile }) => {
    test.skip(!!isMobile, '前台、交班、会员工作台只在电脑与平板上用');
    await login(page, 'linlan');
    await expectFits(page);

    await page.goto('/frontdesk');
    await expect(page.getByTestId('tag-board')).toBeVisible();
    await page.getByTestId('tag-A8075').click();
    const panel = page.getByTestId('bill-panel');
    await expect(panel.getByTestId('bill-tag')).toHaveText('A8075');
    // 小票的合计与结账按钮在一屏之内，不用滚动
    const viewport = page.viewportSize()!;
    for (const id of ['bill-total', 'action-checkout']) {
      const box = (await panel.getByTestId(id).boundingBox())!;
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height, id).toBeLessThanOrEqual(viewport.height);
    }
    await expectFits(page);

    await page.goto('/shift');
    // 精确匹配页面标题：本人有未交班的班次时还有「交班表 · BC…」小标题
    await expect(page.getByRole('heading', { name: '交班', exact: true })).toBeVisible();
    await expectFits(page);
  });
});

// 不认识 dvh 的老浏览器（8.1.4，店主 2026-11-16 报「侧边栏划不动，右边滑着左边超了」）：老浏览器把用到 dvh 的声明整条丢掉，
// 门店、后台、ERP 的整屏版面就没了高度，整页跟着内容滚、侧栏被撑长划不动、右边一滚左边跑出屏幕。打包时给每条 dvh 补了
// 只给老浏览器用的 vh（scripts/dvh-fallback.ts）；这里把样式表里的 dvh 改成不认识的单位来模拟老浏览器。
test.describe('不认识 dvh 的老浏览器', () => {
  test('整屏版面照样一屏高：整页不滚，右边滚了侧栏不跑，后台的侧栏能单独滚', async ({ page }) => {
    const viewport = page.viewportSize()!;
    test.skip(viewport.width < 1024, '后台、ERP 的侧栏只在宽屏显示');
    await page.route(/\/assets\/[^?]*\.css(\?.*)?$/, async (route) => {
      const res = await route.fetch();
      const css = (await res.text()).replace(/(\d)([dsl]v[hw])(?=[\s;),}!])/g, '$1x$2');
      await route.fulfill({ status: res.status(), contentType: 'text/css', body: css });
    });
    await login(page, 'linlan');
    for (const [path, name] of [
      ['/', '主导航'],
      ['/admin', '后台导航'],
      ['/erp', 'ERP 导航'],
    ] as const) {
      await page.goto(path);
      const nav = page.getByRole('navigation', { name });
      await expect(nav).toBeVisible();
      // 版面就是一屏高：整页不滚
      await expect.poll(() => page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight), { message: path }).toBeLessThanOrEqual(1);
      // 右边内容上往下滚：侧栏不跟着跑
      const top = await nav.evaluate((el) => el.getBoundingClientRect().top);
      await page.mouse.move(viewport.width - 120, viewport.height / 2);
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(300);
      expect(await nav.evaluate((el) => el.getBoundingClientRect().top), path).toBe(top);
      expect(await page.evaluate(() => window.scrollY), path).toBe(0);
    }
    // 后台的分区多，侧栏比一屏长：能单独滚
    await page.goto('/admin');
    const side = page.getByRole('navigation', { name: '后台导航' });
    await expect(side).toBeVisible();
    expect(await side.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
    const box = (await side.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => side.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});
