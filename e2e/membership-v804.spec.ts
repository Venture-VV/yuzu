// 8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）的新页面，浏览器验收（门店电脑尺寸跑一次）：
//   · 会员权益默认「按档阶」看（L0–L6 逐级展开）；VIP 柜在会员权益里，旧入口跳过来；「看使用率」进券的使用率；
//   · 券模板：新建买一赠一券（买的项目、赠品出库）；批量发券：按标签圈人、预览人数、发出去；
//   · 会员详情：充值当日的储值可用额度；充值记录、消费记录默认展开，「查询与导出」里按种类查；
//   · 数据看板「营销成本」：店主看得到；有财务职责的账号（对账付款）看不到，接口 403。

import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' }).or(page.getByRole('navigation', { name: 'ERP 导航' })).first()).toBeVisible({ timeout: 30_000 });
}

async function postJson<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

/** 每次跑都不一样的手机号（不与演示数据、其他用例撞） */
const phone = (n: number) => `196${String(Date.now()).slice(-7)}${n}`;

test.describe('8.0.4 会员体系整改', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('会员权益按档阶看、VIP 柜在会员权益里、看使用率', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/benefits');
    const tiers = page.getByTestId('benefit-tiers');
    await expect(tiers).toBeVisible();
    for (const grade of [0, 1, 2, 3, 4, 5, 6]) await expect(page.getByTestId(`tier-grade-toggle-${grade}`)).toBeVisible();
    // 展开一级只看到这一级的三阶
    await page.getByTestId('tier-grade-toggle-3').click();
    await expect(page.getByTestId('tier-stages-3')).toBeVisible();
    await expect(page.getByTestId('tier-stages-4')).toHaveCount(0);

    // VIP 柜：在会员权益里；旧入口跳过来
    await page.getByRole('radiogroup', { name: '看法' }).getByRole('radio', { name: 'VIP 柜' }).click();
    await expect(page.getByTestId('vip-lockers')).toBeVisible();
    for (const grade of [0, 1, 2, 3, 4, 5, 6]) await expect(page.getByTestId(`vip-level-${grade}`)).toBeVisible();
    await page.goto('/admin/vip-lockers');
    await expect(page).toHaveURL(/\/admin\/benefits\?view=vip/);
    await expect(page.getByTestId('vip-lockers')).toBeVisible();

    // 看使用率
    await page.goto('/admin/benefits');
    await page.getByTestId('benefits-usage-link').click();
    await expect(page).toHaveURL(/\/admin\/coupons\?tab=usage/);
    await expect(page.getByTestId('coupon-usage')).toBeVisible();
    await expect(page.getByTestId('coupon-usage-issued')).toContainText('张');
    await expect(page.getByTestId('coupon-usage-used')).toContainText('核销率');
  });

  test('新建买一赠一券（赠品出库）；按标签批量发券，会员都收到', async ({ page }) => {
    await login(page, 'linlan');
    const run = String(Date.now() % 100000);
    const meta = await getJson<{
      items: { id: number; name: string; active: boolean }[];
      materials: { id: number; name: string; active: boolean }[];
      warehouses: { id: number; active: boolean }[];
    }>(page, '/api/coupons/meta');
    const buy = meta.items.find((i) => i.active)!;
    const material = meta.materials.find((m) => m.active)!;
    const warehouse = meta.warehouses.find((w) => w.active)!;

    // ① 买一赠一券
    await page.goto('/admin/coupons/templates');
    await page.getByTestId('coupon-template-new').click();
    const dialog = page.getByTestId('coupon-template-dialog');
    await dialog.getByTestId('coupon-template-name').fill(`E2E买一赠一${run}`);
    await dialog.getByTestId('coupon-template-kind-bogo').click();
    await dialog.getByTestId('coupon-template-buy-item').selectOption(String(buy.id));
    await dialog.getByTestId('coupon-template-gift-out').check();
    await dialog.getByTestId('coupon-template-gift-material').selectOption(String(material.id));
    await dialog.getByTestId('coupon-template-gift-qty').fill('1');
    await dialog.getByTestId('coupon-template-gift-warehouse').selectOption(String(warehouse.id));
    // 保存在对话框底部（不在 coupon-template-dialog 里面）
    await page.getByTestId('coupon-template-save').click();
    await expect(dialog).toHaveCount(0);
    const row = page.locator('li[data-testid^="coupon-template-"]').filter({ hasText: `E2E买一赠一${run}` });
    await expect(row).toContainText('买一赠一券');
    await expect(row).toContainText(`买 ${buy.name}`);
    await expect(row).toContainText(material.name);

    // ② 批量发券：新标签挂两位新会员，圈这个标签发一张代金券
    const tag = await postJson<{ id: number }>(page, '/api/member-tags', { groupName: '活动', name: `E2E圈选${run}` });
    const members: number[] = [];
    for (const n of [1, 2]) members.push((await postJson<{ id: number }>(page, '/api/members', { name: `E2E圈选${run}-${n}`, phone: phone(n), tagIds: [tag.id] })).id);
    const cash = await postJson<{ id: number }>(page, '/api/coupons/templates', { clientKey: randomUUID(), name: `E2E批量${run}`, kind: 'cash', faceValue: 1000, validity: 'days', validDays: 30 });
    await page.reload();
    await page.getByTestId('coupon-tab-campaigns').click();
    await page.getByTestId('campaign-new').click();
    await page.getByTestId('campaign-template').selectOption(String(cash.id));
    await page.getByTestId(`campaign-tag-${tag.id}`).click();
    await page.getByTestId('campaign-reason').fill('E2E 批量发券');
    // 预览还在路上时改了圈选：旧的结果回来后不显示、不能发（8.0.5，8.0.4 独立验收 P2：原来照样显示旧人数、能点发券，发出去的却是新圈选）
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/coupons/campaigns/preview', async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    await page.getByTestId('campaign-preview').click();
    await page.getByTestId(`campaign-tag-${tag.id}`).click(); // 取消这个标签：圈到的是全部会员了
    release();
    await expect(page.getByTestId('campaign-preview')).toBeEnabled();
    await expect(page.getByTestId('campaign-preview-result')).toHaveCount(0);
    await expect(page.getByTestId('campaign-submit')).toBeDisabled();
    await page.unroute('**/api/coupons/campaigns/preview');
    // 选回这个标签，重新预览：两位
    await page.getByTestId(`campaign-tag-${tag.id}`).click();
    await page.getByTestId('campaign-preview').click();
    await expect(page.getByTestId('campaign-preview-result')).toContainText('2');
    await page.getByTestId('campaign-submit').click();
    await expect(page.getByText('已发给 2 位会员')).toBeVisible();
    for (const id of members) {
      const { coupons } = await getJson<{ coupons: { templateId: number }[] }>(page, `/api/members/${id}/coupons`);
      expect(coupons.filter((c) => c.templateId === cash.id)).toHaveLength(1);
    }
  });

  test('会员详情：充值当日的储值额度；充值、消费记录默认展开，查询与导出', async ({ page }) => {
    await login(page, 'linlan');
    await ensureShift(page); // 下面要充值：自己开班，不靠别的用例留下的班次（单独跑这一条也能过）
    const settings = await getJson<{ rechargeSpendPct: number | null }>(page, '/api/settings');
    const run = String(Date.now() % 100000);
    const member = await postJson<{ id: number }>(page, '/api/members', { name: `E2E额度${run}`, phone: phone(3) });
    try {
      if (settings.rechargeSpendPct !== 70) expect((await page.request.put('/api/settings', { data: { rechargeSpendPct: 70 } })).ok()).toBe(true);
      await postJson(page, '/api/recharges', { idempotencyKey: randomUUID(), memberId: member.id, planId: null, paidAmount: 1_000_000, bonusAmount: 0, paymentMethod: 'wechat', paymentConfirmed: true });
      await page.goto(`/?m=${member.id}`);
      await expect(page.getByTestId('member-spend-quota')).toContainText('今日储值可用 ¥7,000.00');

      // 记录：两块默认展开，看得到刚才的充值；查询与导出收着
      const recharge = page.getByTestId('records-recharge');
      await expect(recharge.getByTestId('records-recharge-toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(recharge.getByTestId('records-recharge-summary')).toContainText('1 笔');
      await expect(page.getByTestId('records-consume').getByTestId('records-consume-toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(recharge.getByTestId('records-recharge-type-recharge')).toHaveCount(0);
      await recharge.getByTestId('records-recharge-filters').click();
      await expect(recharge.getByTestId('records-recharge-type-recharge')).toHaveAttribute('aria-pressed', 'true');
      await expect(recharge.getByTestId('records-recharge-export')).toBeEnabled();
      // 去掉「充值」这一种：查不到、标题写明按条件筛选
      await recharge.getByTestId('records-recharge-type-recharge').click();
      await expect(recharge.getByTestId('records-recharge-summary')).toContainText('0 笔');
      await expect(recharge.getByTestId('records-recharge-summary')).toContainText('已按条件筛选');
      await expect(page.getByTestId('records-ratio')).toBeVisible();
    } finally {
      if (settings.rechargeSpendPct !== 70) await page.request.put('/api/settings', { data: { rechargeSpendPct: settings.rechargeSpendPct } });
    }
  });

  test('数据看板「营销成本」：店主看得到；对账付款（财务职责）看不到', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/dashboard/marketing');
    await expect(page.getByTestId('dashboard-tab-marketing')).toBeVisible();
    await expect(page.getByTestId('dashboard-marketing-cost')).toBeVisible();
    await expect(page.getByTestId('marketing-cost-total')).toBeVisible();
    await expect(page.getByTestId('marketing-cost-service-card')).toBeVisible();

    await page.context().clearCookies();
    await login(page, 'qianfen');
    const res = await page.request.get('/api/marketing-cost?from=2026-11-01&to=2026-11-09');
    expect(res.status()).toBe(403);
    await page.goto('/dashboard/marketing');
    await expect(page.getByTestId('dashboard-marketing-cost')).toHaveCount(0);
  });
});
