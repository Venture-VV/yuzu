// R1.2 资金轨浏览器验收（店主 2026-10-29 签认）：依赖 seed-demo、seed-frontdesk-demo、seed-billing-demo（仅独立演示库）。
//   · 收款前必须先开班：结账弹窗里就地开班；
//   · 优惠 / 免单：填原因 → 值班经理在弹窗里输入账号密码授权 → 结清，结账单写明原因与授权人；
//   · 改成免票、接待时直接选免票：要值班经理当场授权并填原因（同一次接待授权一次）。
// 账号：收银员 chenyin（演示里已交班）、值班经理 zhangjl，密码 yuzu2026。会改数据，只在门店电脑尺寸执行；每次自动挑空闲手牌，可重复执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 }); // 刚启动的服务第一次登录可能较慢
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  locked: boolean;
  active: boolean;
  visit: { id: number } | null;
}

/** 接待一位散客（不含餐），返回手牌号；从清单前面挑空闲普通柜，避开演示数据与其他用例 */
async function newGuest(page: Page): Promise<string> {
  const tags = ((await (await page.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] }).tags;
  const code = tags.find((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)!.code;
  const res = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: crypto.randomUUID(), guests: [{ tagCode: code, zone: 'male' }] } });
  expect(res.status()).toBe(201);
  return code;
}

async function openBill(page: Page, code: string) {
  await page.goto('/frontdesk');
  await expect(page.getByTestId('tag-board')).toBeVisible();
  await page.getByTestId(`tag-${code}`).click();
  await expect(page.getByTestId('bill-tag')).toHaveText(code);
}

/** 值班经理在授权弹窗里输入自己的账号密码 */
async function authorize(page: Page) {
  const dialog = page.getByRole('dialog').filter({ has: page.locator('#authorize-username') });
  await dialog.locator('#authorize-username').fill('zhangjl');
  await dialog.locator('#authorize-password').fill(PASSWORD);
  await dialog.getByTestId('authorize-submit').click();
  await expect(page.locator('#authorize-username')).toHaveCount(0);
}

test.describe('R1.2 收银', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');

  test('没有开班时在结账弹窗里就地开班；优惠 / 免单由值班经理当场授权后结清', async ({ page }) => {
    await login(page, 'chenyin');
    // 演示里陈茵已交班；之前执行过本用例留下的班次先交掉，保证从「没有开班」开始
    const cur = (await (await page.request.get('/api/shifts/current')).json()) as { shift: { id: number; summary: { cash: { expected: number } } } | null };
    if (cur.shift) {
      const expected = cur.shift.summary.cash.expected;
      expect((await page.request.post(`/api/shifts/${cur.shift.id}/close`, { data: { countedCash: Math.max(0, expected), expectedCash: expected } })).ok()).toBe(true);
    }
    const code = await newGuest(page);
    await openBill(page, code);
    await page.getByTestId('bill-panel').getByTestId('action-checkout').click();
    await expect(page.getByTestId('checkout-review')).toBeVisible();

    // 先开班：开班提示出现，结清按钮不可用
    const gate = page.getByTestId('shift-gate');
    await expect(gate).toContainText('结账前要先开班');
    await gate.getByLabel('备用金').fill('200');
    await gate.getByTestId('shift-start-submit').click();
    await expect(gate).toHaveCount(0);

    // 优惠 21 元（抹零）：先填原因，再请值班经理授权
    await page.getByTestId('pay-add-discount').click();
    const discount = page.getByTestId('pay-row-discount');
    await discount.getByLabel('优惠 / 免单金额').fill('21');
    await expect(page.getByTestId('discount-authorize')).toBeDisabled();
    await discount.getByLabel('优惠原因').fill('抹零');
    await page.getByTestId('discount-authorize').click();
    await authorize(page);
    await expect(page.getByTestId('discount-granted')).toContainText('张经理已授权');
    // 其余现金：金额默认就是还差的部分
    await page.getByTestId('pay-add-cash').click();
    await expect(page.getByTestId('checkout-submit')).toBeEnabled();
    // 改了优惠金额，授权就不再覆盖，要重新授权
    await discount.getByLabel('优惠 / 免单金额').fill('22');
    await expect(discount).toContainText('请按当前内容重新授权');
    await expect(page.getByTestId('checkout-submit')).toBeDisabled();
    await discount.getByLabel('优惠 / 免单金额').fill('21');
    await expect(page.getByTestId('discount-granted')).toBeVisible();

    await page.getByTestId('checkout-submit').click();
    const receipt = page.getByTestId('checkout-receipt');
    await expect(receipt).toContainText('优惠 / 免单');
    await expect(receipt).toContainText('抹零 · 张经理授权');
    await page.getByTestId('checkout-finish').click();

    // 交班表：优惠单列，不计入应有现金
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '交班', exact: true }).click();
    await expect(page.getByTestId('shift-summary')).toContainText('优惠 / 免单');
    await expect(page.getByTestId('shift-cash-formula')).toContainText('备用金');
  });

  test('改成免票要值班经理当场授权并填原因', async ({ page }) => {
    await login(page, 'chenyin');
    const code = await newGuest(page);
    await openBill(page, code);
    await page.getByTestId('bill-ticket-change').click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('ticket-confirm') });
    await dialog.getByRole('radio', { name: /儿童免票/ }).click();
    await expect(dialog.getByTestId('ticket-grant')).toContainText('是免票');
    await expect(dialog.getByTestId('ticket-confirm')).toBeDisabled();
    await dialog.getByLabel('降档原因').fill('1 米以下儿童');
    await dialog.getByTestId('ticket-authorize').click();
    await authorize(page);
    await expect(dialog.getByTestId('ticket-grant')).toContainText('张经理已授权');
    await dialog.getByTestId('ticket-confirm').click();
    await expect(page.getByTestId('bill-panel')).toContainText('儿童免票');
  });

  test('接待时直接选儿童免票：同一次接待请值班经理授权一次后才能发牌', async ({ page }) => {
    await login(page, 'chenyin');
    const tags = ((await (await page.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] }).tags;
    const code = tags.find((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)!.code;
    const types = (await (await page.request.get('/api/frontdesk/ticket-types')).json()) as { id: number; name: string }[];
    const child = types.find((t) => t.name.startsWith('儿童免票'))!;
    await page.goto('/frontdesk');
    await expect(page.getByTestId('tag-board')).toBeVisible();
    await page.keyboard.press('F2');
    const dialog = page.getByRole('dialog', { name: '接待发牌' });
    await dialog.getByLabel('第 1 位牌号').fill(code);
    await expect(dialog.getByTestId('guest-row-0')).toContainText('空闲可发');
    await dialog.getByTestId('guest-ticket-0').selectOption(String(child.id));
    const grant = dialog.getByTestId('free-ticket-grant');
    await expect(grant).toContainText(`手牌 ${code} 选了免票`);
    await expect(dialog.getByTestId('checkin-submit')).toBeDisabled();
    await grant.getByTestId('request-ticket-authorize').click();
    await authorize(page);
    await expect(dialog).toContainText('免票已由张经理当场授权');
    await dialog.getByTestId('checkin-submit').click();
    await expect(page.getByText(`已发牌 ${code}`)).toBeVisible();
    await expect(page.getByTestId('bill-panel')).toContainText('儿童免票');
  });
});
