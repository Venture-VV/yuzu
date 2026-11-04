// 会员体系 v2 第三期（v0.7.25，docs/MEMBERSHIP_P3.md）浏览器验收：
//   ① 会员详情「邀请体验 / 赠送会籍」：L4 会员邀请一位还不是会员的朋友（当场建档），受邀人详情显示「体验中」、前台标「体验」，
//     邀请人本月不能再邀请；店主撤销后受邀人不再体验中；
//   ② 结账时自动算会员折扣：一项 L3 起的折扣类（门票 8 折，用例里临时发布、结束时暂缓）在结账对话框自动带上；
//     选「优惠 / 免单」时会员折扣不用（二选一）；按会员折扣结清，结账单记「会员折扣」。
// 只在门店电脑尺寸执行一次；每次新建会员、挑空闲手牌，可重复执行。E2E 库里的其他会员都在 L3 以下，临时发布的折扣不影响别的用例。

import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ensureShift } from './shift';

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

const uniquePhone = (prefix: string) => `${prefix}${String(Date.now()).slice(-8)}`;

/** 新会员充到给定金额（赠金按档自动算：先按 0 提交，服务端回 BONUS_CHANGED 时按它给的赠金重提） */
async function memberWith(page: Page, name: string, phone: string, paid: number) {
  const m = await postJson<{ id: number }>(page, '/api/members', { name, phone });
  if (paid > 0) {
    const body = { idempotencyKey: randomUUID(), memberId: m.id, planId: null, paidAmount: paid, bonusAmount: 0, bonusMode: 'auto', paymentMethod: 'wechat', paymentConfirmed: true };
    let r = await page.request.post('/api/recharges', { data: body });
    if (r.status() === 409) {
      const err = (await r.json()) as { error: { code: string; details?: { bonusCents?: number } } };
      expect(err.error.code).toBe('BONUS_CHANGED');
      r = await page.request.post('/api/recharges', { data: { ...body, idempotencyKey: randomUUID(), bonusAmount: err.error.details!.bonusCents } });
    }
    expect(r.ok(), await r.text()).toBe(true);
  }
  return m.id;
}

interface BenefitRow {
  id: number;
  code: string;
  status: string;
  version: number;
  [k: string]: unknown;
}

const benefitOf = async (page: Page, code: string) => (await getJson<{ items: BenefitRow[] }>(page, '/api/benefits')).items.find((b) => b.code === code);

/** 本店权益清单还没导入时导入（编号已有的跳过） */
async function ensureCatalog(page: Page) {
  if (!(await benefitOf(page, 'QY-041'))) await postJson(page, '/api/benefits/import', {});
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}

const freeTag = async (page: Page) =>
  (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).at(-2)!.code;

test.describe('会员体系 v2 第三期', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(120_000);

  test('邀请体验：L4 会员邀请还不是会员的朋友（当场建档）；受邀人体验中、前台标「体验」；本月不能再邀请；撤销后不再体验中', async ({ page }) => {
    await login(page, 'linlan');
    await ensureShift(page);
    const inviter = await memberWith(page, 'E2E 邀请人', uniquePhone('196'), 50_000_00);
    const friendPhone = uniquePhone('195');

    await page.goto(`/?m=${inviter}`);
    const card = page.getByTestId('member-trials');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('trial-quota')).toContainText('L4');
    await card.getByTestId('trial-invite-open').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByTestId('trial-phone').fill(friendPhone);
    await expect(dialog.getByTestId('trial-invitee')).toContainText('还不是会员：当场建档');
    await expect(dialog.getByTestId('trial-invitee')).toContainText('L3');
    await expect(dialog.getByTestId('trial-submit')).toBeDisabled();
    await dialog.getByTestId('trial-name').fill('E2E 受邀朋友');
    await dialog.getByTestId('trial-submit').click();
    await expect(page.getByText('已邀请体验')).toBeVisible();
    await expect(card.getByTestId('trial-sent')).toContainText('E2E 受邀朋友');
    await expect(card.getByTestId('trial-sent')).toContainText('体验中');
    // 每月 1 次：本月不能再邀请
    await expect(card.getByTestId('trial-invite-open')).toBeDisabled();

    const found = await getJson<{ id: number; phone: string }[]>(page, `/api/members?q=${friendPhone}&limit=5`);
    const friend = found.find((m) => m.phone === friendPhone)!;
    await page.goto(`/?m=${friend.id}`);
    await expect(page.getByTestId('trial-active')).toContainText('体验中：L3');
    // 本月可享按体验的档阶
    await expect(page.getByTestId('member-benefits')).toContainText('L3');

    // 前台：账单上标「体验」
    const tag = await freeTag(page);
    const checkin = await postJson<{ visits: { id: number }[] }>(page, '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', memberId: friend.id }] });
    const visitId = checkin.visits[0]!.id;
    try {
      await page.goto(`/frontdesk?v=${visitId}`);
      await expect(page.getByTestId('bill-panel').getByTestId('bill-member-trial')).toContainText('体验 L3');
    } finally {
      await page.request.post(`/api/frontdesk/visits/${visitId}/cancel`, { data: { reason: 'E2E：收尾' } });
    }

    // 店主撤销
    await page.goto(`/?m=${friend.id}`);
    const active = page.getByTestId('trial-active');
    await active.getByRole('button', { name: '撤销' }).click();
    await page.getByTestId('trial-cancel-reason').fill('E2E 验收撤销');
    await page.getByTestId('trial-cancel-confirm').click();
    await expect(page.getByTestId('trial-active')).toHaveCount(0);
    await expect(page.getByTestId('trial-received')).toContainText('已撤销');
  });

  test('会员折扣：结账对话框自动带上（门票 8 折），选「优惠 / 免单」时不用；按会员折扣结清，结账单记「会员折扣」', async ({ page }) => {
    await login(page, 'linlan');
    await ensureShift(page);
    await ensureCatalog(page);
    // 同行优惠（QY-041，L3·初 起的折扣类）临时配成门票 8 折、发布；结束时暂缓
    const b = (await benefitOf(page, 'QY-041'))!;
    const { id, version, status: _s, code: _c, ...rest } = b;
    const editable = Object.fromEntries(
      Object.entries(rest).filter(([k]) =>
        ['name', 'category', 'startGrade', 'startTier', 'period', 'quantity', 'tierQuantities', 'templateId', 'events', 'festivalDates', 'discountTarget', 'weekdays', 'monthDays', 'content', 'conditions'].includes(k),
      ),
    );
    const saved = await page.request.put(`/api/benefits/${id}`, {
      data: { ...editable, expectedVersion: version, discountTarget: 'ticket', quantity: 80, tierQuantities: [], weekdays: [], monthDays: [] },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const published = await page.request.post(`/api/benefits/${id}/status`, { data: { expectedVersion: ((await saved.json()) as BenefitRow).version, status: 'published' } });
    expect(published.ok(), await published.text()).toBe(true);
    let visitId: number | null = null;
    try {
      const vip = await memberWith(page, 'E2E 折扣会员', uniquePhone('194'), 30_000_00);
      const tag = await freeTag(page);
      const checkin = await postJson<{ visits: { id: number }[] }>(page, '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', memberId: vip }] });
      visitId = checkin.visits[0]!.id;
      const preview = await getJson<{ totalAmount: number; memberDiscounts: { amount: number; rate: number; code: string }[] }>(page, `/api/frontdesk/checkout-preview?ids=${visitId}`);
      const d = preview.memberDiscounts[0]!;
      expect(d).toMatchObject({ code: 'QY-041', rate: 80 });
      expect(d.amount).toBeGreaterThan(0);

      await page.goto(`/frontdesk?v=${visitId}`);
      await page.getByTestId('bill-panel').getByTestId('action-checkout').click();
      await expect(page.getByTestId('checkout-total')).toBeVisible();
      const row = page.getByTestId('member-discount');
      await expect(row).toContainText('8 折');
      await expect(row).toContainText(`−¥${(d.amount / 100).toFixed(2)}`);
      // 二选一：加「优惠 / 免单」时会员折扣不用，去掉恢复
      await page.getByTestId('pay-add-discount').click();
      await expect(page.getByTestId('member-discount-off')).toContainText('二选一');
      await page.getByTestId('pay-row-discount').getByRole('button', { name: '移除这笔收款' }).click();
      await expect(page.getByTestId('member-discount')).toBeVisible();

      await page.getByTestId('pay-add-cash').click();
      await page.getByTestId('checkout-submit').click();
      await expect(page.getByText(/已结清 · /)).toBeVisible();
      await page.getByTestId('checkout-finish').click();
      visitId = null;

      const list = await getJson<{ id: number; tagCodes: string[] }[]>(page, '/api/frontdesk/checkouts');
      const done = await getJson<{ payments: { method: string; amount: number }[] }>(page, `/api/frontdesk/checkouts/${list.find((c) => c.tagCodes.includes(tag))!.id}`);
      expect(done.payments.find((p) => p.method === 'member_discount')).toMatchObject({ amount: d.amount });
      expect(done.payments.find((p) => p.method === 'cash')!.amount).toBe(preview.totalAmount - d.amount);
    } finally {
      if (visitId) await page.request.post(`/api/frontdesk/visits/${visitId}/cancel`, { data: { reason: 'E2E：收尾' } });
      const now = await benefitOf(page, 'QY-041');
      if (now?.status === 'published') await page.request.post(`/api/benefits/${now.id}/status`, { data: { expectedVersion: now.version, status: 'paused' } });
    }
  });
});
