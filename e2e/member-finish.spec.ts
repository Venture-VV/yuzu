// 会员体系收尾（v0.7.26，docs/MEMBERSHIP_FINISH.md）浏览器验收：
//   ① 退储值：店员在会员详情「储值与账户」发起，按原收款方式（现金从自己的钱箱）退；值班经理不能授权，店主当场授权后退回，
//     列在「储值与账户」，本金余额减少；
//   ② 停用 / 启用：店主写原因，标「已停用」，再启用；记录列在「储值与账户」；
//   ③ 换手机号：店员改手机号要写原因、值班经理当场授权，换号记录写明授权人；
//   ④ 合并：店主把一份档案并进另一位（先核对两位的余额与档阶，确认不能撤销），被并的标「已合并」、目标会员记「合并转入」；
//   ⑤ 同行优惠（QY-041）：L3 会员带一位不是会员的同行，结账对话框的会员折扣写明「同行的门票」与同行的手牌；按会员折扣结清，
//     收款明细写明同行的手牌。用例里临时配成同行的门票 8 折、发布，结束时暂缓。
// 只在门店电脑尺寸执行一次；每次新建会员、挑空闲手牌，可重复执行。

import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.context().clearCookies();
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

let phoneSeq = 0;
/** 每次执行都不一样的手机号（同一毫秒里建几位也不重复） */
const uniquePhone = (prefix: string) => {
  phoneSeq += 1;
  return `${prefix}${String(Date.now()).slice(-6)}${String(phoneSeq % 100).padStart(2, '0')}`;
};

/** 新会员，按给定方式充值（赠金按档自动算：先按 0 提交，服务端回 BONUS_CHANGED 时按它给的赠金重提） */
async function memberWith(page: Page, name: string, paid: number, paymentMethod: 'cash' | 'wechat' = 'wechat') {
  const phone = uniquePhone('193');
  const m = await postJson<{ id: number }>(page, '/api/members', { name, phone });
  if (paid > 0) {
    const body = { idempotencyKey: randomUUID(), memberId: m.id, planId: null, paidAmount: paid, bonusAmount: 0, bonusMode: 'auto', paymentMethod, paymentConfirmed: true };
    let r = await page.request.post('/api/recharges', { data: body });
    if (r.status() === 409) {
      const err = (await r.json()) as { error: { code: string; details?: { bonusCents?: number } } };
      expect(err.error.code).toBe('BONUS_CHANGED');
      r = await page.request.post('/api/recharges', { data: { ...body, idempotencyKey: randomUUID(), bonusAmount: err.error.details!.bonusCents } });
    }
    expect(r.ok(), await r.text()).toBe(true);
  }
  return { id: m.id, phone };
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}

/** 两张空闲的男宾普通手牌（挑靠后的，避开别的用例常用的前几张） */
const freeTags = async (page: Page) =>
  (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags
    .filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)
    .slice(-4, -2)
    .map((t) => t.code);

/** 当场授权对话框：先用不够格的账号（看到拒绝原因），再用够格的 */
async function authorize(page: Page, tries: { username: string; rejected?: RegExp }[]) {
  // 按对话框标题找（编辑会员资料的提示里也有「当场授权」几个字）
  const dialog = page.getByRole('dialog', { name: /^当场授权/ });
  await expect(dialog).toBeVisible();
  for (const t of tries) {
    await dialog.getByLabel('授权人账号').fill(t.username);
    await dialog.getByLabel('授权人密码').fill(PASSWORD);
    await dialog.getByTestId('authorize-submit').click();
    if (t.rejected) await expect(dialog).toContainText(t.rejected);
  }
  await expect(dialog).toBeHidden();
}

test.describe('会员体系收尾', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(120_000);

  test('退储值：店员发起、按原收款方式（现金从自己的钱箱）退；值班经理不能授权，店主授权后退回；列在「储值与账户」', async ({ page }) => {
    await login(page, 'xiaozhou');
    await ensureShift(page);
    const m = await memberWith(page, 'E2E 退储值会员', 6_000_00, 'cash');
    const before = await getJson<{ principalBalance: number; bonusBalance: number }>(page, `/api/members/${m.id}`);
    expect(before.principalBalance).toBe(6_000_00);

    await page.goto(`/?m=${m.id}`);
    const card = page.getByTestId('member-account');
    await expect(card).toContainText('没有退过储值');
    await card.getByTestId('member-refund-open').click();
    const dialog = page.getByRole('dialog').filter({ hasText: '退储值' });
    await dialog.getByTestId('member-refund-amount').fill('1000');
    // 最近的充值先退：只有一笔现金充值，退 1,000 元都从它退，现金从自己的钱箱退（默认选中）
    const line = dialog.getByTestId('member-refund-line-0');
    await expect(line).toContainText('原收款方式 现金');
    await expect(line).toContainText('1,000.00');
    await expect(dialog.getByTestId('member-refund-drawer')).not.toHaveValue('');
    await expect(dialog.getByTestId('member-refund-submit')).toBeDisabled();
    await dialog.getByTestId('member-refund-reason').fill('E2E：客人不常来了，退一部分');
    await dialog.getByTestId('member-refund-submit').click();
    await authorize(page, [{ username: 'zhangjl', rejected: /不能授权退储值/ }, { username: 'linlan' }]);
    await expect(page.getByText('已退储值')).toBeVisible();

    const list = card.getByTestId('member-refund-list');
    await expect(list).toContainText('退本金');
    await expect(list).toContainText('1,000.00');
    await expect(list).toContainText('林岚授权');
    const after = await getJson<{ principalBalance: number; bonusBalance: number }>(page, `/api/members/${m.id}`);
    expect(after.principalBalance).toBe(5_000_00);
    // 赠金按退的本金占本金余额的比例扣回（1/6，四舍五入到分）
    expect(after.bonusBalance).toBe(before.bonusBalance - Math.round(before.bonusBalance / 6));
  });

  test('停用 / 启用、换手机号：店主停用后标「已停用」、再启用；店员改手机号要写原因、值班经理当场授权', async ({ page }) => {
    await login(page, 'xiaozhou');
    const m = await memberWith(page, 'E2E 换号会员', 0);
    const newPhone = uniquePhone('192');

    // 店员改手机号：写原因，保存时请值班经理授权
    await page.goto(`/?m=${m.id}`);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const form = page.getByRole('dialog').filter({ hasText: '编辑会员资料' });
    await form.locator('#m-phone').fill(newPhone);
    await expect(form.getByTestId('member-phone-reason')).toBeVisible();
    await form.getByRole('button', { name: '保存' }).click();
    await expect(form).toContainText('改手机号要写原因');
    await form.getByTestId('member-phone-reason').fill('E2E：原号码不用了');
    await form.getByRole('button', { name: '保存' }).click();
    await authorize(page, [{ username: 'zhangjl' }]);
    await expect(page.getByText('会员资料已更新')).toBeVisible();
    const history = page.getByTestId('member-account-history');
    await expect(history).toContainText('换手机号');
    await expect(history).toContainText('张经理授权');
    expect((await getJson<{ phone: string }>(page, `/api/members/${m.id}`)).phone).toBe(newPhone);

    // 店主停用、再启用
    await login(page, 'linlan');
    await page.goto(`/?m=${m.id}`);
    const card = page.getByTestId('member-account');
    await card.getByTestId('member-status-open').click();
    let dialog = page.getByRole('dialog').filter({ hasText: '停用会员' });
    await expect(dialog.getByTestId('member-status-submit')).toBeDisabled();
    await dialog.getByTestId('member-status-reason').fill('E2E：客人要求暂停');
    await dialog.getByTestId('member-status-submit').click();
    await expect(page.getByText('已停用会员')).toBeVisible();
    await expect(page.locator('h2', { hasText: 'E2E 换号会员' }).locator('..')).toContainText('已停用');
    await expect(card.getByTestId('member-account-history')).toContainText('停用 · E2E：客人要求暂停');

    await card.getByTestId('member-status-open').click();
    dialog = page.getByRole('dialog').filter({ hasText: '启用会员' });
    await dialog.getByTestId('member-status-reason').fill('E2E：客人回来了');
    await dialog.getByTestId('member-status-submit').click();
    await expect(page.getByText('已启用会员')).toBeVisible();
    await expect(page.locator('h2', { hasText: 'E2E 换号会员' }).locator('..')).not.toContainText('已停用');
    await expect(card.getByTestId('member-account-history')).toContainText('启用 · E2E：客人回来了');
  });

  test('合并：店主把一份档案并进另一位（先核对，确认不能撤销）；被并的标「已合并」，目标会员记「合并转入」', async ({ page }) => {
    await login(page, 'linlan');
    const source = await memberWith(page, 'E2E 旧档案', 0);
    const target = await memberWith(page, 'E2E 新档案', 0);

    await page.goto(`/?m=${source.id}`);
    await page.getByTestId('member-account').getByTestId('member-merge-open').click();
    const dialog = page.getByRole('dialog').filter({ hasText: '合并会员' });
    await dialog.getByTestId('member-merge-search').fill(target.phone);
    await dialog.getByTestId('member-merge-candidates').getByRole('button', { name: /E2E 新档案/ }).click();
    const check = dialog.getByTestId('member-merge-check');
    await expect(check).toContainText('这一份（并走）');
    await expect(check).toContainText('E2E 旧档案');
    await expect(check).toContainText('目标会员（留下）');
    await expect(dialog.getByTestId('member-merge-problems')).toHaveCount(0);
    await dialog.getByTestId('member-merge-reason').fill('E2E：同一个人建了两份档案');
    await expect(dialog.getByTestId('member-merge-submit')).toBeDisabled();
    await dialog.getByText('我已与顾客核对').click();
    await dialog.getByTestId('member-merge-submit').click();
    await expect(page.getByText('已合并', { exact: true }).first()).toBeVisible();

    await expect(page.getByTestId('member-merged-into')).toContainText('E2E 新档案');
    // 被并的档案：不能再编辑、退储值、停用或合并
    await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('member-merge-open')).toHaveCount(0);
    await expect(page.getByTestId('member-refund-open')).toBeDisabled();

    await page.goto(`/?m=${target.id}`);
    await expect(page.getByTestId('member-account-history')).toContainText('合并转入');
    await expect(page.getByTestId('member-account-history')).toContainText('E2E 旧档案');
  });

  test('同行优惠：L3 会员带一位不是会员的同行，结账时会员折扣打同行的门票（写明手牌）；按会员折扣结清', async ({ page }) => {
    await login(page, 'linlan');
    await ensureShift(page);
    if (!(await getJson<{ items: { code: string }[] }>(page, '/api/benefits')).items.some((b) => b.code === 'QY-041')) await postJson(page, '/api/benefits/import', {});
    type BenefitRow = { id: number; code: string; status: string; version: number; [k: string]: unknown };
    const benefitOf = async () => (await getJson<{ items: BenefitRow[] }>(page, '/api/benefits')).items.find((b) => b.code === 'QY-041')!;
    // 同行优惠临时配成：同行的门票 8 折，L3·初 起带 1 位；发布，结束时暂缓
    const b = await benefitOf();
    const keys = ['name', 'category', 'startGrade', 'startTier', 'period', 'quantity', 'tierQuantities', 'templateId', 'events', 'festivalDates', 'discountTarget', 'companionCount', 'companionCounts', 'weekdays', 'monthDays', 'content', 'conditions'];
    const editable = Object.fromEntries(Object.entries(b).filter(([k]) => keys.includes(k)));
    const saved = await page.request.put(`/api/benefits/${b.id}`, {
      data: { ...editable, expectedVersion: b.version, discountTarget: 'companion_ticket', quantity: 80, tierQuantities: [], companionCount: 1, companionCounts: [], weekdays: [], monthDays: [] },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const published = await page.request.post(`/api/benefits/${b.id}/status`, { data: { expectedVersion: ((await saved.json()) as BenefitRow).version, status: 'published' } });
    expect(published.ok(), await published.text()).toBe(true);
    const visitIds: number[] = [];
    try {
      // 后台列表写明「同行的门票（带 1 位）」
      await page.goto('/admin/benefits?view=list'); // 8.0.4 起默认「按档阶」看，原来的清单在「按类别」
      await expect(page.getByTestId('benefit-discount-QY-041')).toContainText('同行的门票（带 1 位）');

      const vip = await memberWith(page, 'E2E 同行会员', 30_000_00);
      const [tagA, tagB] = await freeTags(page);
      const checkin = await postJson<{ visits: { id: number; tagCode: string }[] }>(page, '/api/frontdesk/checkins', {
        clientKey: randomUUID(),
        guests: [
          { tagCode: tagA, zone: 'male', memberId: vip.id },
          { tagCode: tagB, zone: 'male', memberId: null },
        ],
      });
      visitIds.push(...checkin.visits.map((v) => v.id));
      const preview = await getJson<{ totalAmount: number; memberDiscounts: { amount: number; rate: number; code: string; target: string; companions: string[] }[] }>(
        page,
        `/api/frontdesk/checkout-preview?ids=${visitIds.join(',')}`,
      );
      const d = preview.memberDiscounts[0]!;
      expect(d).toMatchObject({ code: 'QY-041', rate: 80, target: 'companion_ticket', companions: [tagB] });

      await page.goto(`/frontdesk?v=${visitIds[0]}`);
      await page.getByTestId('bill-panel').getByTestId('action-checkout').click();
      await expect(page.getByTestId('checkout-total')).toBeVisible();
      const row = page.getByTestId('member-discount');
      await expect(row).toContainText('同行的门票');
      await expect(row).toContainText(tagB!);
      await expect(row).toContainText(`−¥${(d.amount / 100).toFixed(2)}`);

      await page.getByTestId('pay-add-cash').click();
      await page.getByTestId('checkout-submit').click();
      await expect(page.getByText(/已结清 · /)).toBeVisible();
      await page.getByTestId('checkout-finish').click();
      visitIds.length = 0;

      const list = await getJson<{ id: number; tagCodes: string[] }[]>(page, '/api/frontdesk/checkouts');
      const done = await getJson<{ payments: { method: string; amount: number; ref: string | null }[] }>(page, `/api/frontdesk/checkouts/${list.find((c) => c.tagCodes.includes(tagA!))!.id}`);
      const md = done.payments.find((p) => p.method === 'member_discount')!;
      expect(md).toMatchObject({ amount: d.amount });
      expect(md.ref).toContain(tagB);
      expect(done.payments.find((p) => p.method === 'cash')!.amount).toBe(preview.totalAmount - d.amount);
    } finally {
      for (const id of visitIds) await page.request.post(`/api/frontdesk/visits/${id}/cancel`, { data: { reason: 'E2E：收尾' } });
      const now = await benefitOf();
      if (now.status === 'published') await page.request.post(`/api/benefits/${now.id}/status`, { data: { expectedVersion: now.version, status: 'paused' } });
    }
  });
});
