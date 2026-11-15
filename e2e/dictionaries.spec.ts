// 8.0.21 浏览器验收：数据字典与自定义字段（docs/FINANCE_V8021.md 第 1 节，CW-J）。可重复执行：
// 加的快捷原因、建的字段带这一次的时间，用完把快捷原因恢复、把字段停用（每类启用的最多 10 个，不停用跑几遍就满了）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · 后台 → 数据字典与字段 → 快捷原因：给「锁牌的原因」加一条 → 前台锁牌弹窗里多了这一个快捷原因；
//   · 自定义字段：给会员建一个「列表里显示」的文字字段 → 会员详情「其他信息」填了保存 → 会员列表那一行看得到；
//   · 按字段查：查得到这位会员。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const stamp = String(Date.now()).slice(-6);

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

test.describe('8.0.21 数据字典与自定义字段', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('快捷原因：后台加一条锁牌原因，前台锁牌弹窗里就有这一条', async ({ page }) => {
    await login(page);
    const before = ((await (await page.request.get('/api/settings')).json()) as { dictionaries: Record<string, string[]> }).dictionaries.lockReasons ?? [];
    const reason = `验收${stamp}`;
    try {
      await page.goto('/admin/dictionaries/reasons');
      const card = page.getByTestId('dict-lockReasons');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.getByTestId('dict-lockReasons-add').fill(reason);
      await card.getByTestId('dict-lockReasons-add').press('Enter');
      await card.getByTestId('dict-lockReasons-save').click();
      await expect(page.getByText('锁牌的原因已保存')).toBeVisible();
      // 前台：新会话里带着新的字典
      await page.goto('/frontdesk');
      await page.getByTestId('open-tag-lock').click();
      const dialog = page.getByRole('dialog', { name: '锁牌 / 解锁' });
      // 快捷原因在填了一张空闲的牌以后出现
      const tags = ((await (await page.request.get('/api/frontdesk/board')).json()) as { tags: { code: string; kind: string; active: boolean; locked: boolean; visit: unknown }[] }).tags;
      const free = tags.find((t) => t.kind === 'normal' && t.active && !t.locked && !t.visit)!;
      await dialog.getByTestId('tag-lock-code').fill(free.code);
      await expect(dialog.getByTestId('tag-lock-status')).toContainText('空闲');
      await expect(dialog.getByRole('button', { name: reason })).toBeVisible();
      await expect(dialog.getByRole('button', { name: before[0]! })).toBeVisible();
    } finally {
      const r = await page.request.put('/api/settings', { data: { dictionaries: { lockReasons: before } } });
      expect(r.ok()).toBe(true);
    }
  });

  test('自定义字段：建一个会员字段 → 详情里填了保存 → 列表那一行看得到 → 按字段查得到', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const label = `车牌${stamp}`;
    let fieldId: number | null = null;
    try {
      await page.goto('/admin/dictionaries/fields');
      await page.getByTestId('fields-member-add').click();
      const dialog = page.getByRole('dialog', { name: '新增会员字段' });
      await dialog.getByTestId('field-label').fill(label);
      await dialog.getByRole('radio', { name: '列表里显示' }).click();
      const created = page.waitForResponse((r) => r.url().endsWith('/api/custom-fields/defs') && r.request().method() === 'POST');
      await dialog.getByTestId('field-save').click();
      const def = (await (await created).json()) as { id: number; key: string };
      fieldId = def.id;
      await expect(page.getByTestId('fields-member')).toContainText(label);

      // 会员详情：其他信息
      const members = (await (await page.request.get('/api/members?q=&limit=20')).json()) as { id: number; name: string; status: string }[];
      const member = members.find((m) => m.status === 'active')!;
      await page.goto(`/?m=${member.id}`);
      const card = page.getByTestId('custom-fields');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.getByLabel(label).fill(`粤B${stamp}`);
      await card.getByTestId('cf-save').click();
      await expect(page.getByText('其他信息已保存')).toBeVisible();
      // 列表那一行
      await expect(page.getByTestId(`cf-inline-${member.id}`)).toContainText(`${label}：粤B${stamp}`);

      // 按字段查
      await page.goto('/admin/dictionaries/search');
      await page.locator('#cf-s-entity').selectOption('member');
      await page.getByTestId('cf-search-field').selectOption(String(def.id));
      await page.getByTestId('cf-search-q').fill(stamp);
      await page.getByTestId('cf-search-go').click();
      await expect(page.getByTestId('cf-search-result')).toContainText(member.name);
      await expect(page.getByTestId('cf-search-result')).toContainText(`粤B${stamp}`);

      // 取不回来：写明加载失败、可以重试，不当成「没建字段」整块藏起来（Codex 审查 26fe580 后补）
      const sheetUrl = `**/api/custom-fields/member/${member.id}`;
      await page.route(sheetUrl, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: '服务暂时不可用' } }) }));
      await page.goto(`/?m=${member.id}`);
      const failed = page.getByTestId('custom-fields-error');
      await expect(failed).toBeVisible({ timeout: 20_000 });
      await expect(failed).toContainText('其他信息加载失败');
      await page.unroute(sheetUrl);
      await failed.getByTestId('custom-fields-error-retry').click();
      await expect(page.getByTestId('custom-fields')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('custom-fields').getByLabel(label)).toHaveValue(`粤B${stamp}`);
    } finally {
      if (fieldId !== null) {
        const defs = (await (await page.request.get('/api/custom-fields/defs')).json()) as { id: number; version: number }[];
        const d = defs.find((x) => x.id === fieldId);
        if (d) await page.request.put(`/api/custom-fields/defs/${d.id}`, { data: { expectedVersion: d.version, active: false } });
      }
    }
  });

  test('后台字段、按字段查与「对外接口」页取不回来：写明加载失败、可以重试（主动扫一遍后补）', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const unavailable = JSON.stringify({ error: { code: 'UNAVAILABLE', message: '服务暂时不可用' } });
    const expectFailThenRetry = async (url: string, path: string, testId: string) => {
      await page.route(url, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: unavailable }));
      await page.goto(path);
      const failed = page.getByTestId(testId);
      await expect(failed).toBeVisible({ timeout: 20_000 });
      await page.unroute(url);
      await failed.getByTestId(`${testId}-retry`).click();
      await expect(page.getByTestId(testId)).toHaveCount(0, { timeout: 20_000 });
    };
    await expectFailThenRetry('**/api/custom-fields/defs', '/admin/dictionaries/fields', 'dict-fields-error');
    await expectFailThenRetry('**/api/custom-fields/defs', '/admin/dictionaries/search', 'dict-search-error');
    await expect(page.getByLabel('类别')).toBeVisible();
    await expectFailThenRetry('**/api/admin/integrations', '/admin/integrations', 'integration-kinds-error');
    await expectFailThenRetry('**/api/admin/integrations/calls?*', '/admin/integrations', 'integration-calls-error');
  });
});
