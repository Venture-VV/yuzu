// 8.0.18 浏览器验收：ERP 的信息架构（docs/IA_V8017.md 第 3.3 节）。只读（不保存任何东西），可重复执行；
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · ERP 导航：审批单列、应付货款归财务、合同一组，「ERP 设置」在最后；
//   · 「ERP 设置」的页签写进地址，各页签里是原来那张规则卡片；规则的旧地址都跳到对应的页签；
//   · 采购、费用与备用金的子页顶上是同一排页签，地址没变；
//   · 员工食堂、安保巡场在后台「人员与行政」，营业数据在数据看板；旧地址跳过去；
//   · 规则总表里 ERP 的规则「去 ERP 设置」直达页签。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test.describe('8.0.18 ERP 的信息架构', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '宽屏的侧栏与页签，只在门店电脑尺寸跑一次');

  test('ERP 导航：审批、供应链、财务、合同各一组，应付货款在财务里；「ERP 设置」在最后', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/erp');
    const nav = page.getByRole('navigation', { name: 'ERP 导航' });
    await expect(page.getByTestId('erp-nav-settings')).toBeVisible();
    // 关着的模块（员工食堂、安保巡场默认关）不显示，所以「已挪到后台」这一组可能只有营业数据
    await expect.poll(async () => (await nav.locator('p').allTextContents()).filter((t) => t !== '已挪到后台')).toEqual(['概览', '审批', '供应链', '财务', '合同', '设置']);
    const group = (title: string) => nav.locator('div', { has: page.locator('p', { hasText: new RegExp(`^${title}$`) }) }).getByRole('link');
    // 链接里可能带着待办的数字
    await expect(group('审批')).toHaveText([/^审批中心/]);
    await expect(group('供应链')).toHaveText([/^库存/, /^采购(\d|$)/, /^采购需求单/, /^本部门小仓/, /^资产与易耗/]);
    await expect(group('财务')).toHaveText([/^付款/, /应付货款/, /费用与备用金/, /发票台账/, /应收与挂账/]);
    await expect(group('合同')).toHaveText([/合同/]);
    await expect(page.getByTestId('erp-nav-settings')).toHaveText('ERP 设置');
    // 设置是最后一组
    await expect(nav.getByRole('link').last()).toHaveText('ERP 设置');
  });

  test('「ERP 设置」：七个页签写进地址、刷新还在；每个页签里是原来那张卡片；旧地址跳到对应的页签', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/erp/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'ERP 设置' })).toBeVisible();
    await expect(page.getByTestId('subnav').getByRole('link')).toHaveText(['模块开关', '采购规则', '库存与审批开关', '审批规则与代理人', '付款规则', '报销与备用金', '其他数值']);
    await expect(page.getByTestId('erp-module-switches')).toBeVisible();
    await expect(page.getByTestId('erp-nav-settings')).toHaveClass(/nav-on/);

    await page.getByTestId('subnav-purchase').click();
    await expect(page).toHaveURL(/\/erp\/settings\/purchase$/);
    await expect(page.getByTestId('purchase-rules')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('purchase-rules')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('subnav-purchase')).toHaveAttribute('aria-current', 'page');

    await page.getByTestId('subnav-approvals').click();
    await expect(page.getByTestId('approval-rules')).toBeVisible();
    await expect(page.getByTestId('approval-delegations')).toBeVisible();
    await page.getByTestId('subnav-payments').click();
    await expect(page.getByTestId('payment-rules')).toBeVisible();
    await page.getByTestId('subnav-expenses').click();
    await expect(page.getByTestId('erp-settings-petty')).toBeVisible();
    await expect(page.getByTestId('erp-settings-budgets')).toBeVisible();
    await page.getByTestId('subnav-inventory').click();
    await expect(page.getByLabel('每月盘点日')).toBeVisible();
    await page.getByTestId('subnav-tunables').click();
    await expect(page.getByTestId('tun-approvalOverdueHours')).toBeVisible();
    await expect(page.getByTestId('tun-slowMovingDays')).toBeVisible();
    // 门店的数值不在这里
    await expect(page.getByTestId('tun-campaignMaxMembers')).toHaveCount(0);
    await expect(page.getByTestId('tun-countCardSales')).toHaveCount(0);

    // 旧地址
    for (const [from, to, testId] of [
      ['/erp/modules', /\/erp\/settings\/modules$/, 'erp-module-switches'],
      ['/purchasing/rules', /\/erp\/settings\/purchase$/, 'purchase-rules'],
      ['/approvals?tab=rules', /\/erp\/settings\/approvals$/, 'approval-rules'],
      ['/erp/payments?tab=rules', /\/erp\/settings\/payments$/, 'payment-rules'],
      ['/admin/rules/inventory', /\/erp\/settings\/inventory$/, 'erp-settings'],
    ] as const) {
      await page.goto(from);
      await expect(page, from).toHaveURL(to);
      await expect(page.getByTestId(testId), from).toBeVisible({ timeout: 20_000 });
    }
    // 认不得的页签回到第一个
    await page.goto('/erp/settings/no-such-tab');
    await expect(page).toHaveURL(/\/erp\/settings$/);
  });

  test('后台「可调的数值」只留门店的，底下有去 ERP 设置的链接；审批中心、付款、采购页里的规则入口指到 ERP 设置', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/rules/tunables');
    await expect(page.getByTestId('tun-campaignMaxMembers')).toBeVisible();
    await expect(page.getByTestId('tun-slowMovingDays')).toHaveCount(0);
    await page.getByTestId('tunables-erp-link').getByRole('link').click();
    await expect(page).toHaveURL(/\/erp\/settings\/tunables$/);

    await page.goto('/approvals');
    await page.getByTestId('approval-rules-link').click();
    await expect(page).toHaveURL(/\/erp\/settings\/approvals$/);
    await page.goto('/erp/payments');
    await page.getByTestId('payments-tab-rules').click();
    await expect(page).toHaveURL(/\/erp\/settings\/payments$/);
    await page.goto('/purchasing');
    await page.getByTestId('purchase-rules-page-link').click();
    await expect(page).toHaveURL(/\/erp\/settings\/purchase$/);
  });

  test('采购、费用与备用金：子页顶上同一排页签，点了换页、地址没变、当前页签标出来', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/purchasing');
    const tabs = page.getByTestId('purchasing-tabs').getByRole('link');
    await expect(tabs).toHaveText([/^采购单$/, /^流程进度$/, /^询价比价$/, /^补货建议/, /^下单物料$/, /^急采$/, /^供应商比价$/, /^供应商评分$/, /^集采导入$/]);
    await expect(page.getByTestId('purchasing-tab-orders')).toHaveAttribute('aria-current', 'page');
    for (const [testId, url] of [
      ['flow-link', /\/purchasing\/flow$/],
      ['sourcing-link', /\/purchasing\/sourcing$/],
      ['suggestions-link', /\/purchasing\/suggestions$/],
      ['ordered-link', /\/purchasing\/ordered$/],
      ['urgent-link', /\/purchasing\/urgent$/],
      ['compare-link', /\/purchasing\/compare$/],
      ['scores-link', /\/purchasing\/scores$/],
      ['request-import-link', /\/purchasing\/import$/],
    ] as const) {
      await page.getByTestId(testId).click();
      await expect(page, testId).toHaveURL(url);
      await expect(page.getByTestId(testId), testId).toHaveAttribute('aria-current', 'page');
      // 每个子页都还有这一排（不用点「返回」）
      await expect(page.getByTestId('purchasing-tabs').getByRole('link')).toHaveCount(9);
    }
    await page.getByTestId('purchasing-tab-orders').click();
    await expect(page).toHaveURL(/\/purchasing$/);

    await page.goto('/erp/expenses');
    await expect(page.getByTestId('subnav').getByRole('link')).toHaveText(['报销', '备用金与每日平账', '费用预算', '采购台账', '账目自检', '旧账对照']);
    for (const [testId, url] of [
      ['petty-link', /\/erp\/petty$/],
      ['budgets-link', /\/erp\/expenses\/budgets$/],
      ['ledger-link', /\/erp\/ledger$/],
      ['audit-link', /\/erp\/audit$/],
      ['legacy-link', /\/erp\/legacy$/],
      ['expenses-tab-claims', /\/erp\/expenses$/],
    ] as const) {
      await page.getByTestId(testId).click();
      await expect(page, testId).toHaveURL(url);
      await expect(page.getByTestId(testId), testId).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('subnav').getByRole('link')).toHaveCount(6);
    }
  });

  test('员工食堂、安保巡场在后台「人员与行政」（模块关着时提示去哪开），营业数据在数据看板；旧地址跳过去', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin');
    await expect(page.getByTestId('admin-nav-canteen')).toHaveText('员工食堂');
    await expect(page.getByTestId('admin-nav-patrol')).toHaveText('安保巡场');
    const modules = ((await (await page.request.get('/api/auth/me')).json()) as { erpModules: string[] }).erpModules;
    for (const [key, testId] of [
      ['canteen', 'canteen-page'],
      ['patrol', 'patrol-admin'],
    ] as const) {
      // 旧地址（ERP 里的）跳到后台
      await page.goto(`/erp/${key}`);
      if (modules.includes(key)) {
        await expect(page).toHaveURL(new RegExp(`/admin/${key}$`));
        await expect(page.getByTestId(testId)).toBeVisible({ timeout: 20_000 });
      }
      await page.goto(`/admin/${key}`);
      await expect(page.getByTestId('admin-shell')).toBeVisible();
      await expect(page.getByTestId(`admin-nav-${key}`)).toHaveClass(/nav-on/);
      if (modules.includes(key)) await expect(page.getByTestId(testId)).toBeVisible({ timeout: 20_000 });
      else {
        // 关着：不画页面，提示去 ERP 设置开
        await expect(page.getByTestId('admin-module-off')).toBeVisible();
        await expect(page.getByTestId(testId)).toHaveCount(0);
        await page.getByTestId('admin-module-off').getByRole('link').click();
        await expect(page).toHaveURL(/\/erp\/settings$/);
        await expect(page.getByTestId(`erp-switch-${key}`)).toBeVisible();
      }
    }
    // 营业数据
    await page.goto('/erp/revenue');
    await expect(page).toHaveURL(/\/admin\/dashboard\/revenue$/);
    await expect(page.getByTestId('dashboard-tab-revenue')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('erp-revenue')).toBeVisible();
    await expect(page.getByTestId('erp-revenue-net')).toBeVisible();
  });

  test('规则总表：ERP 的规则「去 ERP 设置」直达页签；补上了固定付款日、部门主管确认、开饭时间、巡场间隔', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/settings');
    await expect(page.getByTestId('rule-catalog')).toBeVisible({ timeout: 20_000 });
    for (const key of ['purchase_rules.deptConfirm', 'purchase_rules.flowStall', 'payment_rules.payDays', 'payment_rules.threeWay', 'expense_rules.threshold', 'canteen.meals', 'patrol.round']) {
      await expect(page.getByTestId(`rule-${key}`), key).toBeVisible();
    }
    await expect(page.getByTestId('rule-payment_rules.payDays')).toContainText(/每月 \d+|没有固定付款日/);
    await page.getByTestId('rule-go-payment_rules.payDays').click();
    await expect(page).toHaveURL(/\/erp\/settings\/payments$/);
    await expect(page.getByTestId('pay-rules-days')).toBeVisible();
    await page.goto('/admin/settings');
    await page.getByTestId('rule-go-inventory_cycle_rules.stocktake').click();
    await expect(page).toHaveURL(/\/erp\/settings\/inventory$/);
    await expect(page.getByLabel('每月盘点日')).toBeVisible();
  });
});
