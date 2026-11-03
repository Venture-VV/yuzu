// 券与会员权益（v0.7.20，飞书 RQ-006 后半；docs/COUPONS.md）浏览器验收：
//   ① 店主在管理后台「券与会员权益」：新建代金券模板、加一条充值赠券规则、生成一批无记名券并导出券码、看统计；
//   ② 会员详情「券」：发两张、作废一张（写原因）；
//   ③ 充值页选套餐时显示「另赠」的券。
// 依赖 seed-demo（仅独立演示库）。账号：店主 linlan，密码 yuzu2026。每次新建自己的模板（名称带时间），结束时停用自己加的规则，可重复执行。
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

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function postJson<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface Template {
  id: number;
  name: string;
  summary: string;
  issued: number;
}
interface Rule {
  id: number;
  kind: string;
  planId: number | null;
  templateId: number;
  active: boolean;
}

test.describe('券与会员权益（v0.7.20）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(120_000);

  test('后台：新建代金券模板、充值赠券规则、无记名券（导出券码）、统计；会员详情发券与作废；充值页显示另赠', async ({ page }) => {
    await login(page, 'linlan');
    const name = `E2E满50减5-${Date.now() % 100000}`;
    const addedRules: number[] = [];
    try {
      // ① 新建代金券模板：面额 5 元、满 50 元，发券后 30 天
      await page.goto('/admin/coupons');
      await expect(page.getByTestId('coupon-admin')).toBeVisible();
      await page.getByTestId('coupon-template-new').click();
      const dialog = page.getByTestId('coupon-template-dialog');
      await dialog.getByTestId('coupon-template-name').fill(name);
      await dialog.getByTestId('coupon-template-kind-cash').click();
      await expect(page.getByTestId('coupon-template-save')).toBeDisabled(); // 没填面额
      await dialog.getByTestId('coupon-template-face').fill('5');
      await dialog.getByTestId('coupon-template-threshold').fill('50');
      await expect(dialog.getByTestId('coupon-template-days')).toHaveValue('30');
      await page.getByTestId('coupon-template-save').click();
      await expect(page.getByText(`已新建券模板「${name}」`)).toBeVisible();
      const template = (await getJson<Template[]>(page, '/api/coupons/templates')).find((t) => t.name === name)!;
      expect(template).toBeTruthy();
      await expect(page.getByTestId(`coupon-template-${template.id}`)).toContainText(name);

      // ② 充值赠券规则：挂在第一个充值套餐上，送 1 张
      const plans = (await getJson<{ plans: { id: number; name: string; active?: boolean }[] }>(page, '/api/catalog')).plans;
      const plan = plans[0]!;
      await page.getByTestId('coupon-tab-rules').click();
      await page.getByTestId('coupon-rule-new').click();
      const ruleDialog = page.getByTestId('coupon-rule-dialog');
      await ruleDialog.getByTestId('coupon-rule-kind-recharge').click();
      await ruleDialog.getByTestId('coupon-rule-plan').selectOption(String(plan.id));
      await ruleDialog.getByTestId('coupon-rule-template').selectOption(String(template.id));
      await page.getByTestId('coupon-rule-save').click();
      await expect(page.getByText(`已加上充值赠券：${name} × 1`)).toBeVisible();
      const rule = (await getJson<Rule[]>(page, '/api/coupons/rules')).find((r) => r.templateId === template.id && r.active)!;
      addedRules.push(rule.id);
      expect(rule).toMatchObject({ kind: 'recharge', planId: plan.id });
      await expect(page.getByTestId(`coupon-rule-${rule.id}`)).toContainText(name);

      // ③ 无记名券：生成 3 张，导出券码清单
      await page.getByTestId('coupon-tab-batches').click();
      await page.getByTestId('coupon-batch-new').click();
      await page.getByTestId('coupon-batch-template').selectOption(String(template.id));
      await page.getByTestId('coupon-batch-quantity').fill('3');
      await page.getByTestId('coupon-batch-submit').click();
      await expect(page.getByText(`已生成 3 张「${name}」`)).toBeVisible();
      const batch = (await getJson<{ id: number; templateId: number; quantity: number }[]>(page, '/api/coupons/batches')).find((b) => b.templateId === template.id)!;
      const exportLink = page.getByTestId(`coupon-batch-export-${batch.id}`);
      await expect(exportLink).toBeVisible();
      const csv = await (await page.request.get((await exportLink.getAttribute('href'))!)).text();
      const codes = csv.split(/\r?\n/).slice(1).filter((l) => /[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/.test(l));
      expect(codes).toHaveLength(3);

      // ④ 会员详情：发两张、作废一张
      const members = await getJson<{ id: number; name: string; phone: string; status: string }[]>(page, '/api/members?q=19900001&limit=50');
      const member = members.find((m) => m.status === 'active')!;
      await page.goto('/');
      await page.getByLabel('搜索会员').fill(member.phone);
      await page.getByRole('option').filter({ hasText: member.name }).first().click(); // 列表里手机号打了码，按姓名点
      const card = page.getByTestId('coupon-member');
      await expect(card).toBeVisible();
      await card.getByTestId('coupon-member-issue').click();
      const issue = page.getByTestId('coupon-issue-dialog');
      await issue.getByTestId('coupon-issue-template').selectOption(String(template.id));
      await issue.getByTestId('coupon-issue-quantity').fill('2');
      await issue.getByTestId('coupon-issue-reason').fill('E2E：老客人回馈');
      await page.getByTestId('coupon-issue-submit').click();
      await expect(issue).toHaveCount(0);
      const mine = async () =>
        (await getJson<{ coupons: { id: number; templateId: number; state: string; voidReason: string | null }[] }>(page, `/api/members/${member.id}/coupons`)).coupons.filter(
          (c) => c.templateId === template.id,
        );
      const issued = await mine();
      expect(issued.map((c) => c.state)).toEqual(['available', 'available']);
      for (const c of issued) await expect(card.getByTestId(`coupon-member-row-${c.id}`)).toContainText(name);
      await card.getByTestId(`coupon-member-void-${issued[0]!.id}`).click();
      await page.getByTestId('coupon-member-void-reason').fill('E2E：发错了');
      await page.getByTestId('coupon-member-void-confirm').click();
      // 列表默认只列可用的：作废的那张移到「已作废」
      await expect(card.getByTestId(`coupon-member-row-${issued[0]!.id}`)).toHaveCount(0);
      await card.getByTestId('coupon-member-filter-voided').click();
      await expect(card.getByTestId(`coupon-member-row-${issued[0]!.id}`)).toContainText('已作废');
      await expect(card.getByTestId(`coupon-member-row-${issued[0]!.id}`)).toContainText('E2E：发错了');
      expect((await mine()).map((c) => [c.state, c.voidReason])).toEqual([
        ['voided', 'E2E：发错了'],
        ['available', null],
      ]);

      // ⑤ 充值页：选挂了券的套餐，显示「另赠」
      await page.getByRole('button', { name: /^充值/ }).click();
      await page.getByRole('button', { name: new RegExp(plan.name) }).first().click();
      await expect(page.getByTestId('coupon-plan-gifts')).toContainText(`另赠：${name} × 1`);
      await page.keyboard.press('Escape');

      // ⑥ 统计：今天这个模板发 5 张（3 张无记名 + 2 张会员）、作废 1 张
      await page.goto('/admin/coupons');
      await page.getByTestId('coupon-tab-stats').click();
      const row = page.getByTestId(`coupon-stats-row-${template.id}`);
      await expect(row).toContainText(name);
      await expect(row.locator('td').nth(1)).toHaveText('5');
      await expect(row.locator('td').nth(5)).toHaveText('1');
    } finally {
      for (const id of addedRules) await page.request.post(`/api/coupons/rules/${id}/deactivate`, { data: {} });
    }
  });

  // Codex 复审 6c3765c：加规则时服务端已提交、回复丢了，刷新后原编号与原请求还在（本机「结果待确认」），
  // 按原内容重新提交只有一条规则，新会员只拿到一张开卡礼；处理完之前不能再加规则
  test('加发券规则：回复丢了刷新页面，「结果待确认」还在，按原内容重新提交只有一条规则、新会员只拿一张开卡礼', async ({ page }) => {
    await login(page, 'linlan');
    const name = `E2E开卡礼-${Date.now() % 100000}`;
    const template = await postJson<Template>(page, '/api/coupons/templates', { clientKey: randomUUID(), name, kind: 'cash', faceValue: 500, validity: 'days', validDays: 7 });
    const rulesOf = async () => (await getJson<Rule[]>(page, '/api/coupons/rules')).filter((r) => r.templateId === template.id && r.active);
    try {
      await page.goto('/admin/coupons');
      await page.getByTestId('coupon-tab-rules').click();
      // 第一次：请求到了服务端（已提交），回复丢了；网络一直不好，页面的查回也发不出去（刷新之后才恢复）
      let dropped = false;
      await page.route('**/api/coupons/rules', async (route) => {
        if (route.request().method() !== 'POST' || dropped) return route.continue();
        dropped = true;
        await route.fetch();
        await route.abort('connectionreset');
      });
      await page.route('**/api/erp/ops/**', (route) => route.abort('connectionreset'));
      await page.getByTestId('coupon-rule-new').click();
      const dialog = page.getByTestId('coupon-rule-dialog');
      await dialog.getByTestId('coupon-rule-kind-open_card').click();
      await dialog.getByTestId('coupon-rule-template').selectOption(String(template.id));
      await page.getByTestId('coupon-rule-save').click();
      await expect(page.getByText('加发券规则：没收到结果')).toBeVisible();
      const pending = page.getByTestId('erp-pending');
      await expect(pending).toContainText('加发券规则结果待确认');
      await expect(pending).toContainText(name);
      expect(await rulesOf()).toHaveLength(1); // 服务端其实已经加上了
      await page.unroute('**/api/coupons/rules');

      // 刷新：原编号与原请求还在本机，处理完之前不能再加规则
      await page.reload();
      await page.getByTestId('coupon-tab-rules').click();
      await expect(page.getByTestId('erp-pending')).toContainText(name);
      await expect(page.getByTestId('coupon-rule-new')).toBeDisabled();
      // 网络恢复后按原内容重新提交：同一编号，服务端返回原来那条
      await page.unroute('**/api/erp/ops/**');
      await page.getByTestId('erp-pending-resend').click();
      await expect(page.getByText('加发券规则已登记')).toBeVisible();
      await expect(page.getByTestId('erp-pending')).toHaveCount(0);
      await expect(page.getByTestId('coupon-rule-new')).toBeEnabled();
      const rules = await rulesOf();
      expect(rules).toHaveLength(1);

      // 新会员只拿到一张这条规则的开卡礼
      // 手机号用 198 开头：不撞演示会员（199 开头）
      const member = await postJson<{ id: number }>(page, '/api/members', { name: 'E2E开卡礼会员', phone: `198${String(Date.now()).slice(-8)}`, gender: 'male' });
      const mine = await getJson<{ coupons: { templateId: number }[] }>(page, `/api/members/${member.id}/coupons`);
      expect(mine.coupons.filter((c) => c.templateId === template.id)).toHaveLength(1);
    } finally {
      for (const r of await rulesOf()) await page.request.post(`/api/coupons/rules/${r.id}/deactivate`, { data: {} });
    }
  });

  test('新建券模板：回复丢了，页面马上查回——已经建好的只有一个，不用重新填写', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/coupons');
    const name = `E2E重提-${Date.now() % 100000}`;
    let dropped = false;
    await page.route('**/api/coupons/templates', async (route) => {
      if (route.request().method() !== 'POST' || dropped) return route.continue();
      dropped = true;
      await route.fetch(); // 服务端已经建好
      await route.abort('connectionreset');
    });
    await page.getByTestId('coupon-template-new').click();
    const dialog = page.getByTestId('coupon-template-dialog');
    await dialog.getByTestId('coupon-template-name').fill(name);
    await dialog.getByTestId('coupon-template-face').fill('3');
    await page.getByTestId('coupon-template-save').click();
    await expect(page.getByText('新建券模板：没收到结果')).toBeVisible();
    // 页面上方的「结果待确认」马上按原编号查回：已经建好的直接移除并提示，不用员工再处理
    await expect(page.getByText('已查回：新建券模板已登记')).toBeVisible();
    await expect(page.getByTestId('erp-pending')).toHaveCount(0);
    await page.unroute('**/api/coupons/templates');
    await page.reload();
    await expect(page.getByTestId('erp-pending')).toHaveCount(0);
    await expect(page.getByTestId('coupon-template-new')).toBeEnabled();
    expect((await getJson<Template[]>(page, '/api/coupons/templates')).filter((t) => t.name === name)).toHaveLength(1);
  });

  test('发券给会员：回复丢了刷新页面，「账户内券」上方的待确认还在，按原内容重新提交只发一次', async ({ page }) => {
    await login(page, 'linlan');
    const template = await postJson<Template>(page, '/api/coupons/templates', {
      clientKey: randomUUID(),
      name: `E2E发券重提-${Date.now() % 100000}`,
      kind: 'cash',
      faceValue: 200,
      validity: 'days',
      validDays: 7,
    });
    const members = await getJson<{ id: number; name: string; phone: string; status: string }[]>(page, '/api/members?q=19900001&limit=50');
    const member = members.filter((m) => m.status === 'active').at(-2)!;
    const mine = async () => (await getJson<{ coupons: { templateId: number }[] }>(page, `/api/members/${member.id}/coupons`)).coupons.filter((c) => c.templateId === template.id);
    const openMember = async () => {
      await page.goto('/');
      await page.getByLabel('搜索会员').fill(member.phone);
      await page.getByRole('option').filter({ hasText: member.name }).first().click();
      await expect(page.getByTestId('coupon-member')).toBeVisible();
    };
    await openMember();
    let dropped = false;
    await page.route(`**/api/members/${member.id}/coupons`, async (route) => {
      if (route.request().method() !== 'POST' || dropped) return route.continue();
      dropped = true;
      await route.fetch(); // 服务端已经发出
      await route.abort('connectionreset');
    });
    await page.route('**/api/erp/ops/**', (route) => route.abort('connectionreset'));
    const card = page.getByTestId('coupon-member');
    await card.getByTestId('coupon-member-issue').click();
    const dialog = page.getByTestId('coupon-issue-dialog');
    await dialog.getByTestId('coupon-issue-template').selectOption(String(template.id));
    await dialog.getByTestId('coupon-issue-reason').fill('E2E：断网重提');
    await page.getByTestId('coupon-issue-submit').click();
    await expect(page.getByText('发券：没收到结果')).toBeVisible();
    await expect(card.getByTestId('erp-pending')).toContainText(template.name);
    expect(await mine()).toHaveLength(1); // 服务端其实已经发出
    await page.unroute(`**/api/members/${member.id}/coupons`);

    // 刷新、重新打开这位会员：待确认还在，处理完之前不能再发
    await page.reload();
    await openMember();
    await expect(card.getByTestId('erp-pending')).toContainText(template.name);
    await expect(card.getByTestId('coupon-member-issue')).toBeDisabled();
    await page.unroute('**/api/erp/ops/**');
    // 网络恢复后页面重新渲染（这里切换券的状态），也不会自己再查回、抢在员工点「重新提交」之前把这一行处理掉（v0.7.22：
    // 原来带 filter 的面板每次渲染都把查回失败的再查一次，CI 上偶发这一行在点击前消失）
    let lookups = 0;
    page.on('request', (r) => {
      if (r.url().includes('/api/erp/ops/')) lookups += 1;
    });
    await card.getByTestId('coupon-member-filter-used').click();
    await card.getByTestId('coupon-member-filter-available').click();
    await page.waitForTimeout(800); // 等一会儿：原来的写法这时已经发出查回
    await expect(card.getByTestId('erp-pending')).toContainText(template.name);
    expect(lookups).toBe(0);
    await card.getByTestId('erp-pending-resend').click();
    await expect(page.getByText('发券给会员已登记')).toBeVisible();
    await expect(card.getByTestId('erp-pending')).toHaveCount(0);
    await expect(card.getByTestId('coupon-member-issue')).toBeEnabled();
    expect(await mine()).toHaveLength(1);
  });
});
