// Batch 2.3 浏览器验收（门店电脑尺寸）：店主导入汤崎价目表（先预览再导入）→ 前台按「专业」档挂账、仅女宾项目对男宾不可选 →
// 会员按档位消费。依赖 seed-demo 与 seed-frontdesk-demo（仅独立演示库）；可重复执行（再次导入时全部「未变」）。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 }); // 刚启动的服务第一次登录可能较慢
}

test.describe('汤崎价目表与多档价格', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('导入价目表 → 前台挂「专业」档 → 仅女宾项目对男宾不可选 → 会员按档消费', async ({ page }) => {
    // ① 店主预览并导入
    await login(page, 'linlan');
    await page.goto('/admin/catalog');
    const card = page.getByTestId('price-list-import');
    await card.getByTestId('price-list-builtin').click();
    const preview = card.getByTestId('price-list-preview');
    await expect(preview).toContainText('价目表共 29 个项目');
    await expect(preview).toContainText('全身按摩 · 基础系列');
    await card.getByTestId('price-list-confirm').click();
    await expect(page.getByText('已导入 29 个项目')).toBeVisible();
    const items = page.getByTestId('catalog-items');
    await expect(items.getByRole('button', { name: /日式指压/ })).toContainText('专业');
    await page.request.post('/api/auth/logout');

    // ② 前台：新开一张男宾普通柜，挂「泰式经典按摩 · 专业」
    await login(page, 'xiaozhou');
    const board = (await (await page.request.get('/api/frontdesk/board')).json()) as {
      tags: { code: string; zone: string; kind: string; active: boolean; locked: boolean; visit: unknown }[];
    };
    const code = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).reverse()[3]!.code;
    expect((await page.request.post('/api/frontdesk/checkins', { data: { clientKey: crypto.randomUUID(), guests: [{ tagCode: code, zone: 'male' }] } })).status()).toBe(201);
    await page.goto('/frontdesk');
    await page.getByTestId(`tag-${code}`).click();
    await expect(page.getByTestId('bill-tag')).toHaveText(code);
    await page.keyboard.press('F4');
    const add = page.getByRole('dialog').filter({ hasText: '加项目' });
    await add.getByRole('button', { name: '全身按摩 · 基础系列' }).click();
    await add.getByTestId('item-泰式经典按摩-professional').click();
    const cart = add.getByRole('complementary', { name: '本次挂账' });
    await expect(cart.getByTitle('泰式经典按摩（专业）')).toContainText('专业档');
    // 仅女宾的私汤木桶浴：男宾不可选
    await add.getByRole('button', { name: '沐浴项目' }).click();
    await expect(add.getByTestId('item-私汤木桶浴')).toBeDisabled();
    await expect(add.getByTestId('item-私汤木桶浴')).toContainText('仅限女宾');
    await add.getByTestId('add-items-submit').click();
    const panel = page.getByTestId('bill-panel');
    await expect(panel).toContainText('泰式经典按摩（专业）');
    await expect(panel.getByTestId('bill-total')).toContainText('489.00');

    // ③ 会员消费：日式指压选「专业」档（先充值 500 元，保证可重复执行时余额足够）
    const name = '沈知夏';
    const [member] = (await (await page.request.get(`/api/members?q=${encodeURIComponent(name)}`)).json()) as { id: number }[];
    const topUp = await page.request.post('/api/recharges', {
      data: { idempotencyKey: crypto.randomUUID(), memberId: member!.id, planId: null, paidAmount: 50000, bonusAmount: 0, paymentMethod: 'wechat', paymentConfirmed: true },
    });
    expect(topUp.status()).toBe(200);
    await page.goto('/');
    await page.getByLabel('搜索会员').fill(name);
    await page.getByRole('option').filter({ hasText: name }).first().click();
    await page.getByRole('button', { name: /^消费/ }).first().click();
    await page.getByTestId('item-日式指压-professional').click();
    await page.getByRole('button', { name: '下一步：核对扣款' }).click();
    // 门店电脑尺寸下，消费流程在右侧「操作面板」里
    const flow = page.getByRole('region', { name: '操作面板' });
    await expect(flow.getByText('日式指压（专业）')).toBeVisible();
    await page.getByRole('button', { name: /确认扣款 ¥489\.00/ }).click();
    await expect(page.getByText('扣款完成')).toBeVisible();
    await expect(flow.getByText('日式指压（专业）')).toBeVisible();

    const checks = (await (await page.request.get('/api/frontdesk/checks')).json()) as { ok: boolean; label: string }[];
    for (const c of checks) expect(c.ok, c.label).toBe(true);
  });
});
