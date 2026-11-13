// v0.7.0 浏览器验收：技师第一步。店主在后台建技师、开启技师功能、勾选需要技师的项目 → 前台加项目时选技师（点钟），
// 价格按技师等级 → 账单与结账单写明技师 → 结账后「技师业绩」里有这一钟。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
// 只用专门的「E2E 技师足疗」项目，不影响其他流程用到的演示项目；结束时关闭技师功能，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const ITEM = 'E2E 技师足疗';
const TECH_NO = 'E8';

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

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}

test.describe('v0.7.0 技师', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改规则的流程只在门店电脑尺寸执行一次');
  test.setTimeout(150_000);

  test('后台建技师并开启 → 前台挂项目选技师（点钟，按等级取价）→ 账单与结账单写明技师 → 技师业绩', async ({ page }) => {
    await login(page, 'linlan');
    try {
      // ① 专用项目（三档价格）与技师（专业）：没有时建，有时沿用（被停用过的重新启用）
      const itemBody = { name: ITEM, category: 'E2E 技师', prices: { standard: 19800, professional: 23800, premium: 29800 } };
      const catalog = await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1');
      const item = catalog.items.find((i) => i.name === ITEM);
      if (!item || !item.active) {
        const res = item ? await page.request.put(`/api/items/${item.id}`, { data: { ...itemBody, active: true } }) : await page.request.post('/api/items', { data: itemBody });
        expect(res.ok(), await res.text()).toBe(true);
      }
      type Tech = { id: number; techNo: string; name: string; gender: string; grade: string; skills: string[]; active: boolean };
      const old = (await getJson<{ technicians: Tech[] }>(page, '/api/admin/technicians')).technicians.find((t) => t.techNo === TECH_NO);
      if (old && (!old.active || old.grade !== 'professional' || old.skills.length > 0)) {
        const res = await page.request.put(`/api/admin/technicians/${old.id}`, { data: { name: old.name, gender: old.gender, grade: 'professional', skills: [], active: true } });
        expect(res.ok(), await res.text()).toBe(true);
      }

      await page.goto('/admin/technicians');
      await expect(page.getByTestId('technician-rules-card')).toBeVisible();
      await page.getByTestId('subnav-roster').click();
      // 8.0.17：后台「技师」分成三个页签——规则、技师名册、需要技师的项目
      const roster = page.getByTestId('technician-roster');
      if (!(await roster.getByTestId(`technician-${TECH_NO}`).isVisible())) {
        await roster.getByTestId('technician-new').click();
        const dialog = page.getByRole('dialog', { name: '新建技师' });
        await dialog.getByTestId('technician-no').fill(TECH_NO);
        await dialog.getByTestId('technician-name').fill('E2E 小林');
        await dialog.getByRole('radiogroup', { name: '技师等级' }).getByRole('radio', { name: '专业' }).click();
        await dialog.getByTestId('technician-save').click();
        await expect(page.getByText(`已添加技师 ${TECH_NO} 号 E2E 小林`)).toBeVisible();
      }
      await expect(roster.getByTestId(`technician-${TECH_NO}`)).toContainText('专业技师');
      const techName = (await getJson<{ technicians: Tech[] }>(page, '/api/admin/technicians')).technicians.find((t) => t.techNo === TECH_NO)!.name;

      // ② 勾选专用项目需要技师，开启技师功能
      await page.getByTestId('subnav-items').click();
      const items = page.getByTestId('technician-items');
      const box = items.getByLabel(`${ITEM} 需要技师`);
      if (!(await box.isChecked())) {
        await box.check();
        await items.getByTestId('technician-items-save').click();
        await expect(page.getByText('需要技师的项目已保存')).toBeVisible();
      }
      await page.getByTestId('subnav-rules').click();
      const rules = page.getByTestId('technician-rules-card');
      await rules.getByRole('radiogroup', { name: '技师功能' }).getByRole('radio', { name: '开启' }).click();
      if (await rules.getByTestId('technician-rules-save').isEnabled()) {
        await rules.getByTestId('technician-rules-save').click();
        await expect(page.getByText('技师规则已保存')).toBeVisible();
      }
      await page.request.post('/api/auth/logout');

      // ③ 前台：接待一位女宾，加项目 → 选技师（点钟）
      await login(page, 'xiaozhou');
      const board = await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board');
      const tag = board.tags.filter((t) => t.zone === 'female' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse()[0]!;
      const checkin = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'female', guestLabel: 'E2E 技师客人' }] } });
      expect(checkin.ok(), await checkin.text()).toBe(true);
      await page.goto('/frontdesk');
      await page.getByTestId(`tag-${tag}`).click();
      const panel = page.getByTestId('bill-panel');
      await expect(panel.getByTestId('bill-tag')).toHaveText(tag);
      await panel.getByTestId('action-add').click();
      const add = page.getByRole('dialog').filter({ hasText: '加项目' });
      await add.getByRole('button', { name: 'E2E 技师', exact: true }).click();
      await add.getByTestId(`item-${ITEM}-standard`).click();
      const picker = add.getByTestId('technician-picker');
      await expect(picker).toContainText(`为「${ITEM}」选技师`);
      await picker.getByRole('radiogroup', { name: '上钟方式' }).getByRole('radio', { name: '点钟' }).click();
      // 专业技师：按专业档 238
      await expect(picker.getByTestId(`tech-${TECH_NO}`)).toContainText('238');
      await picker.getByTestId(`tech-${TECH_NO}`).click();
      await expect(add.getByLabel('本次挂账')).toContainText(`${TECH_NO} 号 ${techName} · 点钟`);
      await expect(add).toContainText('238.00');
      await add.getByTestId('add-items-submit').click();
      await expect(add).toBeHidden();
      await expect(panel).toContainText(`${TECH_NO} 号 ${techName} · 点钟`);
      await expect(panel).toContainText('技师服务');

      // ④ 结账（现金），结账单写明技师
      const visit = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!;
      const preview = await getJson<{ totalAmount: number }>(page, `/api/frontdesk/checkout-preview?ids=${visit.id}`);
      // 收款前要先开班：本人没有当班班次时临时开一个，结完就按应有现金交掉
      const opened = (await page.request.post('/api/shifts', { data: { openingCash: 0 } })).status() === 200;
      const paid = await page.request.post('/api/frontdesk/checkouts', {
        data: { clientKey: randomUUID(), visitIds: [visit.id], expectedTotal: preview.totalAmount, payments: [{ method: 'cash', amount: preview.totalAmount }] },
      });
      expect(paid.ok(), await paid.text()).toBe(true);
      if (opened) {
        const { shift } = await getJson<{ shift: { id: number; summary: { cash: { expected: number } } } }>(page, '/api/shifts/current');
        const expected = shift.summary.cash.expected;
        const closed = await page.request.post(`/api/shifts/${shift.id}/close`, { data: { countedCash: expected, expectedCash: expected, note: 'E2E：技师流程临时开的班' } });
        expect(closed.ok(), await closed.text()).toBe(true);
      }
      const checkoutId = ((await paid.json()) as { id: number }).id;
      await page.goto(`/print/checkout/${checkoutId}`);
      await expect(page.getByTestId('print-checkout')).toContainText(`技师 ${TECH_NO} 号 ${techName} · 点钟`);
      await page.request.post('/api/auth/logout');

      // ⑤ 店主看技师业绩：今天这位技师至少一个点钟
      await login(page, 'linlan');
      await page.goto('/dashboard/technicians');
      const row = page.getByTestId(`technicians-row-${TECH_NO}`);
      await expect(row).toBeVisible();
      const designated = Number(await row.locator('td').nth(3).innerText());
      expect(designated).toBeGreaterThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    } finally {
      // 关闭技师功能（不影响其他流程）；技师与专用项目留着，下次沿用
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      const res = await page.request.put('/api/admin/technicians/rules', { data: { enabled: false } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });
});
