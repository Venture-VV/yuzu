// 会员体系 v2 第二期（v0.7.24，docs/BENEFITS.md）浏览器验收：
//   · 后台「会员权益」：一键导入本店权益清单（导入为草稿）；编辑服务类「会员专属通道」为每月 2 次、发布；首充礼选券后发布；折扣类不能发布；
//   · 会员详情「本月可享」：首笔充值后收到首充礼；登记使用数次数、到上限不能再登记；登记错的作废后腾出次数；
//   · 登记已经生效、回复却是 500：卡片上方结果待确认、不能另起一笔，查回就是那一次；
//   · 看板「会员体系」的本月会员权益。
// 用例结束时把发布的两项暂缓（每天的自动任务不会给别的会员发；后面的用例不受影响）。

import { expect, test, type Page } from '@playwright/test';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

interface BenefitRow {
  id: number;
  code: string;
  status: string;
  version: number;
}

async function pauseAll(page: Page, codes: string[]) {
  const res = await page.request.get('/api/benefits');
  if (!res.ok()) return;
  const { items } = (await res.json()) as { items: BenefitRow[] };
  for (const b of items.filter((x) => codes.includes(x.code) && x.status === 'published')) {
    await page.request.post(`/api/benefits/${b.id}/status`, { data: { expectedVersion: b.version, status: 'paused' } });
  }
}

test.describe('会员权益', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('导入清单、发布两项；会员首充收到首充礼，服务类登记使用到上限、作废腾出次数；500 之后结果待确认、查回', async ({ page }) => {
    await login(page, 'linlan');
    await ensureShift(page);
    try {
      const tpl = await page.request.post('/api/coupons/templates', {
        data: { clientKey: crypto.randomUUID(), name: 'E2E 首充礼券', kind: 'cash', faceValue: 5000, validity: 'days', validDays: 30 },
      });
      expect(tpl.ok(), await tpl.text()).toBe(true);
      const template = (await tpl.json()) as { id: number };

      await page.goto('/admin/benefits');
      await expect(page.getByTestId('benefits-admin')).toBeVisible();
      const importButton = page.getByTestId('benefits-import');
      if (await importButton.isVisible()) {
        await importButton.click();
        await expect(importButton).toHaveCount(0);
      }
      const channel = page.getByTestId('benefit-row-QY-001');
      await expect(channel).toContainText('会员专属通道');
      await expect(channel).toContainText('L2·初');
      // 折扣类这一期不能发布
      await expect(page.getByTestId('benefit-publish-QY-011')).toBeDisabled();

      // 服务类：每月 2 次，发布
      await page.getByTestId('benefit-edit-QY-001').click();
      await page.getByTestId('benefit-period').selectOption('month');
      await page.getByTestId('benefit-quantity').fill('2');
      await page.getByTestId('benefit-save').click();
      await expect(channel).toContainText('每月 2 次');
      if (await page.getByTestId('benefit-publish-QY-001').isVisible()) await page.getByTestId('benefit-publish-QY-001').click();
      await expect(channel).toContainText('已发布');

      // 首充礼：选券、发布
      const firstGift = page.getByTestId('benefit-row-QY-051');
      await page.getByTestId('benefit-edit-QY-051').click();
      await page.getByTestId('benefit-template').selectOption(String(template.id));
      await page.getByTestId('benefit-save').click();
      await expect(firstGift).toContainText('E2E 首充礼券');
      if (await page.getByTestId('benefit-publish-QY-051').isVisible()) await page.getByTestId('benefit-publish-QY-051').click();
      await expect(firstGift).toContainText('已发布');

      // 新会员：会员详情开着，在页面上首充 1 万（升到 L2，按 5% 赠送）；不刷新页面，「本月可享」随之更新（Codex 自动审查 98806a3）
      const phone = `195${String(Date.now()).slice(-8)}`;
      const created = await page.request.post('/api/members', { data: { name: '权益验收', phone } });
      expect(created.ok()).toBe(true);
      const member = (await created.json()) as { id: number };
      await page.goto(`/?m=${member.id}`);
      const card = page.getByTestId('member-benefits');
      await expect(card).toContainText('L0 青溪');
      await expect(page.getByTestId('member-benefits-upcoming')).toContainText('会员专属通道（L2·初）');
      await expect(page.getByTestId('member-benefit-QY-001')).toHaveCount(0);

      await page.getByRole('button', { name: /^充值/ }).first().click();
      await page.getByText('自定义金额').click();
      await page.fill('#paid', '10000');
      await page.getByRole('button', { name: '现金' }).click();
      await page.getByRole('button', { name: '下一步：核对收款' }).click();
      await page.getByText('我已核实').click();
      await page.getByRole('button', { name: /确认入账/ }).click();
      await expect(page.getByTestId('recharge-result-grade')).toHaveText('L2 潭影 · 初');
      await page.getByRole('button', { name: '完成' }).click();

      await expect(card).toContainText('L2 潭影 · 初');
      await expect(page.getByTestId('member-benefit-QY-051')).toContainText('收到过 1 次');
      const row = page.getByTestId('member-benefit-QY-001');
      await expect(row).toContainText('本月已用 0 / 2 次');

      // 登记两次：到上限后按钮灰掉
      for (const n of [1, 2]) {
        await page.getByTestId('benefit-use-QY-001').click();
        await page.getByTestId('benefit-use-note').fill(`E2E 第 ${n} 次`);
        await page.getByTestId('benefit-use-submit').click();
        await expect(row).toContainText(`本月已用 ${n} / 2 次`);
      }
      await expect(page.getByTestId('benefit-use-QY-001')).toBeDisabled();

      // 作废一次（写原因）：腾出次数
      await card.getByRole('button', { name: /使用登记/ }).click();
      const uses = page.getByTestId('member-benefit-uses');
      await expect(uses).toContainText('E2E 第 2 次');
      await uses.getByRole('button', { name: '作废' }).first().click();
      await page.getByTestId('benefit-use-void-reason').fill('E2E 登记错了');
      await page.getByTestId('benefit-use-void-confirm').click();
      await expect(row).toContainText('本月已用 1 / 2 次');
      await expect(uses).toContainText('已作废：E2E 登记错了');

      // 登记真的到服务端、生效了，回到页面的却是 500；查回暂时也连不上
      const isUse = (url: URL) => url.pathname === `/api/members/${member.id}/benefit-uses`;
      const isLookup = (url: URL) => url.pathname.startsWith('/api/erp/ops/');
      await page.route(isUse, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const res = await route.fetch();
        expect(res.status()).toBe(201);
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '服务器出了点问题' } }) });
      });
      await page.route(isLookup, (route) => route.abort('internetdisconnected'));
      await page.getByTestId('benefit-use-QY-001').click();
      await page.getByTestId('benefit-use-submit').click();
      const pending = page.getByTestId('erp-pending');
      await expect(pending).toContainText('登记权益使用');
      await expect(page.getByTestId('benefit-use-QY-001')).toBeDisabled();
      await page.unroute(isLookup);
      await page.unroute(isUse);
      await page.getByTestId('erp-pending-check').click();
      await expect(pending).toHaveCount(0);
      await expect(row).toContainText('本月已用 2 / 2 次');

      await page.goto('/dashboard/membership');
      const summary = page.getByTestId('membership-benefits');
      await expect(summary).toContainText('本月发券');
      await expect(summary).toContainText('首充礼');
      await expect(summary).toContainText('会员专属通道');
    } finally {
      await pauseAll(page, ['QY-001', 'QY-051']);
    }
  });
});
