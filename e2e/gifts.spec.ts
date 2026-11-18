// 8.1.9 全局签赠（docs/GIFTS_V819.md）的浏览器验收：
//   ① 店主在后台「签赠 → 知识库」新建一个签赠券类型（代金券 ¥20，板块、权益内容）；
//   ② 店主在管家部的「签赠台账」点「签赠发放」：找会员、选券种、授权人选张经理（值班经理）、渠道默认管家部、写事由；
//   ③ 前台结账时「券抵扣」的列表上这张券标着「签赠」、授权人与渠道，选它抵扣、结清；
//   ④ 客户部的「签赠台账」里这张是「已使用」，按授权人里张经理用了一张。
// 依赖演示数据（seed-demo、seed-frontdesk-demo：店主 linlan、收银 xiaozhou、值班经理 zhangjl，密码 yuzu2026）。会登记单据，只在门店电脑尺寸执行；
// 每次用新的名称，不改演示数据里已有的档案。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航|后台导航/ }).first()).toBeVisible({ timeout: 30_000 });
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

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number; memberId: number | null } | null;
}

const freeTags = async (page: Page, zone: BoardTag['zone']) =>
  (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags
    .filter((t) => t.zone === zone && t.kind === 'normal' && t.active && !t.locked && !t.visit)
    .map((t) => t.code)
    .reverse();

async function openShiftIfNeeded(page: Page) {
  const res = await page.request.post('/api/shifts', { data: { openingCash: 0 } });
  expect([200, 409], await res.text()).toContain(res.status());
  return res.status() === 200;
}

async function closeMyShift(page: Page, note: string) {
  const { shift } = await getJson<{ shift: { id: number; summary: { cash: { expected: number } } } | null }>(page, '/api/shifts/current');
  if (!shift) return;
  const expected = shift.summary.cash.expected;
  const res = await page.request.post(`/api/shifts/${shift.id}/close`, { data: { countedCash: expected, expectedCash: expected, note } });
  expect(res.ok(), await res.text()).toBe(true);
}

test.describe('8.1.9 签赠', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('后台建签赠券类型 → 管家部发放（选授权人）→ 前台结账选这张签赠券 → 客户部台账里是已使用', async ({ page }) => {
    test.setTimeout(180_000);
    const name = `E2E 签赠 ${String(Date.now()).slice(-6)}`;
    // ① 店主：后台「签赠 → 知识库」新建
    await login(page, 'linlan');
    await page.goto('/admin/gifts/types');
    await expect(page.getByTestId('gift-types')).toBeVisible();
    await page.getByTestId('gift-type-new').click();
    const typeDialog = page.getByTestId('gift-type-dialog');
    await typeDialog.getByTestId('gift-type-name').fill(name);
    await typeDialog.getByRole('radio', { name: /代金券/ }).click();
    await typeDialog.getByTestId('gift-type-face').fill('20');
    await typeDialog.getByTestId('gift-type-content').fill('抵 20 元消费（E2E）');
    await typeDialog.getByTestId('gift-type-rules').fill('值班经理以上授权');
    await page.getByTestId('gift-type-save').click();
    await expect(page.getByText(`已新建「${name}」`)).toBeVisible();
    const types = await getJson<{ id: number; name: string; giftSegment: string }[]>(page, '/api/gifts/types');
    const type = types.find((t) => t.name === name)!;
    expect(type).toBeTruthy();
    await expect(page.getByTestId(`gift-type-${type.id}`)).toContainText('代金券 ¥20.00');

    // ② 店主在管家部发放：找一位不在店的演示会员
    const board = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags;
    const inStore = new Set(board.map((t) => t.visit?.memberId).filter((id): id is number => !!id));
    const members = await getJson<{ id: number; name: string; phone: string; status: string; gender: 'male' | 'female' | null }[]>(page, '/api/members?q=19900001&limit=50');
    const member = members.filter((m) => m.status === 'active' && !inStore.has(m.id)).at(0);
    expect(member, '演示会员（seed-demo）里没有不在店的').toBeTruthy();
    await page.goto('/concierge/gifts');
    await expect(page.getByTestId('concierge-gift-ledger')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('gift-issue').click();
    const issue = page.getByTestId('gift-issue-dialog');
    await issue.getByTestId('gift-member-search').fill(member!.phone);
    await issue.getByTestId(`gift-member-${member!.id}`).click();
    await expect(issue.getByTestId('gift-member-picked')).toContainText(member!.name);
    await issue.getByTestId('gift-type').selectOption(String(type.id));
    await expect(issue.getByTestId('gift-type-info')).toContainText('值班经理以上授权');
    await issue.getByTestId('gift-authorizer').selectOption({ label: '张经理' });
    await expect(issue.getByTestId('gift-channel')).toHaveValue('管家部');
    await issue.getByTestId('gift-reason').fill('E2E：老客户回馈');
    await page.getByTestId('gift-issue-save').click();
    await expect(page.getByText(`已发给 ${member!.name}`)).toBeVisible();
    const today = (await getJson<{ today: string }>(page, '/api/auth/me')).today;
    const ledger = await getJson<{ rows: { couponId: number; code: string; status: string; authorizer: { name: string } }[] }>(
      page,
      `/api/gifts/ledger?from=${today}&to=${today}&templateId=${type.id}`,
    );
    const coupon = ledger.rows[0]!;
    expect(coupon).toMatchObject({ status: 'available', authorizer: { name: '张经理' } });
    await expect(page.getByTestId('concierge-gift-ledger').getByTestId(`gift-row-${coupon.couponId}`)).toContainText('张经理');
    await page.request.post('/api/auth/logout');

    // ③ 前台：接待这位会员，结账时选这张签赠券
    await login(page, 'xiaozhou');
    const opened = await openShiftIfNeeded(page);
    let visitId: number | null = null;
    try {
      const zone = member!.gender ?? 'male';
      const tag = (await freeTags(page, zone))[4]!;
      const checkin = await postJson<{ visits: { id: number }[] }>(page, '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone, memberId: member!.id }] });
      visitId = checkin.visits[0]!.id;
      await page.goto(`/frontdesk?v=${visitId}`);
      const bill = page.getByTestId('bill-panel');
      await expect(bill.getByTestId('bill-tag')).toHaveText(tag);
      await bill.getByTestId('action-checkout').click();
      await expect(page.getByTestId('checkout-total')).toBeVisible();
      await page.getByTestId('pay-add-store_coupon').click();
      const option = page.getByTestId('store-coupon-options').getByTestId(`store-coupon-${coupon.code}`);
      await expect(option).toContainText('签赠');
      await expect(option).toContainText('授权 张经理 · 管家部');
      await option.click();
      await expect(page.getByTestId('store-coupon-picked')).toContainText('抵 ¥20.00');
      await expect(page.getByTestId('store-coupon-gift')).toContainText('授权 张经理 · 管家部');
      await page.getByTestId('pay-add-cash').click();
      await page.getByTestId('checkout-submit').click();
      await expect(page.getByText(/已结清 · /)).toBeVisible();
      await page.getByTestId('checkout-finish').click();
      visitId = null;
    } finally {
      if (visitId) await page.request.post(`/api/frontdesk/visits/${visitId}/cancel`, { data: { reason: 'E2E：收尾' } });
      if (opened) await closeMyShift(page, 'E2E：签赠临时开的班');
    }
    await page.request.post('/api/auth/logout');

    // ④ 店主看客户部的签赠台账：已使用、核销的结账单、按授权人
    await login(page, 'linlan');
    await page.goto('/customer?tab=gifts');
    const panel = page.getByTestId('customer-gift-ledger');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const row = panel.getByTestId(`gift-row-${coupon.couponId}`);
    await expect(row).toContainText('已使用');
    await expect(row).toContainText('结账单');
    await expect(panel.getByTestId('gift-by-authorizer')).toContainText('张经理');
    await expect(panel.getByTestId('gift-share-segment')).toContainText(type.giftSegment);
  });
});
