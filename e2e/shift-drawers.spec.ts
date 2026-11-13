// v0.7.28 ⑨ 浏览器验收：按钱箱交班（N11）。后台「经营规则」切到按钱箱交班 → 交班页选钱箱开班 → 别人加入、他的收款记进这个钱箱 →
// 交班表列出当班的人与各人经办 → 交班 → 切回按人交班。依赖演示数据（仅独立演示库）；账号：店主 linlan、店员 ajie，密码 yuzu2026。
// 交班方式是全店的规则：用例结束（含失败）时切回按人交班，之后的用例照旧按人开班（浏览器验收串行执行）。可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { ShiftRecord } from '../src/shared/checkout';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

/**
 * 这个账号此刻在班上（之前的用例或上次中断留下的）：按应有现金交掉（店主可以替别人交，钱箱上别人也一起离开）；
 * leaveOnly 时按钱箱交班的只离开钱箱
 */
async function offShift(req: APIRequestContext, leaveOnly = false) {
  const s = ((await (await req.get('/api/shifts/current')).json()) as { shift: ShiftRecord | null }).shift;
  if (!s) return;
  if (s.drawerName && leaveOnly) {
    expect((await req.post(`/api/shifts/${s.id}/leave`, { data: {} })).ok()).toBe(true);
    return;
  }
  const expected = s.summary.cash.expected;
  const res = await req.post(`/api/shifts/${s.id}/close`, { data: { countedCash: Math.max(0, expected), expectedCash: expected, note: 'E2E：清理未交的班' } });
  expect(res.ok(), await res.text()).toBe(true);
}

test('按钱箱交班：后台切换 → 选钱箱开班 → 别人加入、收款记进来 → 交班 → 切回按人交班', async ({ page, playwright, baseURL }, info) => {
  test.skip(info.project.name !== '门店电脑', '写数据的只在门店电脑尺寸执行一次');
  await login(page, 'linlan');
  const ajie = await playwright.request.newContext({ baseURL });
  expect((await ajie.post('/api/auth/login', { data: { username: 'ajie', password: PASSWORD } })).ok()).toBe(true);
  try {
    await offShift(ajie, true);
    await offShift(page.request);

    // ① 后台「经营规则」：交班方式切到按钱箱交班（用已有的 1 号钱箱，不新增：钱箱不能删）
    // 8.0.17：「交班方式」是门店基本规则的一个页签
    await page.goto('/admin/rules/shift');
    const card = page.getByTestId('shift-mode-card');
    await card.getByRole('radio', { name: '按钱箱交班' }).click();
    if ((await card.getByRole('radio', { name: '启用' }).first().getAttribute('aria-checked')) !== 'true') {
      await card.getByRole('radio', { name: '启用' }).first().click();
    }
    // 上次中断时可能已经是按钱箱交班（没有改动时保存按钮是灰的）
    if (await card.getByTestId('shift-mode-save').isEnabled()) {
      await card.getByTestId('shift-mode-save').click();
      await expect(page.getByText('交班方式：按钱箱交班')).toBeVisible();
    }
    const k1 = ((await (await page.request.get('/api/settings')).json()) as { cashDrawers: { key: string; label: string }[] }).cashDrawers[0]!;
    // 上次中断时 1 号钱箱可能还开着班：店主替交掉
    const board = (await (await page.request.get('/api/shifts/drawers')).json()) as { drawers: { key: string; shift: { id: number } | null }[] };
    const left = board.drawers.find((d) => d.key === k1.key)?.shift;
    if (left) {
      const s = (await (await page.request.get(`/api/shifts/${left.id}`)).json()) as ShiftRecord;
      const e = s.summary.cash.expected;
      expect((await page.request.post(`/api/shifts/${left.id}/close`, { data: { countedCash: Math.max(0, e), expectedCash: e } })).ok()).toBe(true);
    }

    // ② 交班页：选钱箱、登记备用金、开班
    await page.goto('/shift');
    await page.getByTestId('shift-drawer').selectOption(k1.key);
    await page.getByTestId('shift-opening-cash').fill('200');
    await page.getByTestId('shift-start-submit').click();
    const open = page.getByTestId('shift-open');
    await expect(open).toContainText(k1.label);
    await expect(page.getByTestId('shift-members')).toContainText('林岚');

    // ③ 阿杰加入同一个钱箱，他的现金充值记到这个钱箱的班次
    const shift = ((await (await page.request.get('/api/shifts/current')).json()) as { shift: ShiftRecord }).shift;
    expect((await ajie.post(`/api/shifts/${shift.id}/join`, { data: {} })).ok()).toBe(true);
    const phone = `194${String(Date.now()).slice(-8)}`;
    const m = (await (await ajie.post('/api/members', { data: { name: `E2E 钱箱 ${phone.slice(-4)}`, phone } })).json()) as { id: number };
    const body = { idempotencyKey: randomUUID(), memberId: m.id, planId: null, paidAmount: 500000, bonusAmount: 0, bonusMode: 'auto', paymentMethod: 'cash', paymentConfirmed: true };
    let r = await ajie.post('/api/recharges', { data: body });
    if (r.status() === 409) {
      const err = (await r.json()) as { error: { code: string; details?: { bonusCents?: number } } };
      expect(err.error.code).toBe('BONUS_CHANGED');
      r = await ajie.post('/api/recharges', { data: { ...body, idempotencyKey: randomUUID(), bonusAmount: err.error.details!.bonusCents } });
    }
    expect(r.ok(), await r.text()).toBe(true);
    await page.reload();
    await expect(page.getByTestId('shift-members')).toContainText('阿杰');
    await expect(page.getByTestId('shift-operators')).toContainText('阿杰');
    // 阿杰离开钱箱：班次照常开着
    expect((await ajie.post(`/api/shifts/${shift.id}/leave`, { data: {} })).ok()).toBe(true);
    await page.reload();
    await expect(page.getByTestId('shift-members')).toContainText('阿杰');
    await expect(open).toContainText('当班中');

    // ④ 交班：实点 = 应有（备用金 200 + 阿杰收的现金 5,000）
    await page.getByTestId('shift-counted-cash').fill('5200');
    await expect(page.getByTestId('shift-diff')).toContainText('与应有一致');
    await page.getByTestId('shift-close').click();
    await expect(page.getByText(/已交班 BC/)).toBeVisible();
    await expect(page.getByTestId('shift-list')).toContainText(`${k1.label}（林岚、阿杰）`);
  } finally {
    // 交班方式是全店的规则：切回按人交班，之后的用例照旧；中途失败留下的钱箱班次交掉
    await offShift(ajie, true);
    await offShift(page.request);
    expect((await page.request.put('/api/settings', { data: { shiftMode: 'person' } })).ok()).toBe(true);
    await ajie.dispose();
  }
});
