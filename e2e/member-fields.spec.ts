// Batch 2.4b 浏览器验收（门店电脑尺寸）：店主配置会员自定义字段 → 店员建档时按字段填写（必填项没填时拦下）→ 会员详情显示。
// 只在独立演示库执行；结束时停用这两个字段（字段不能删除），再次执行时重新启用。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

interface FieldDef {
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  active: boolean;
}

const LABELS = ['车牌号', '了解渠道'];

test.describe('会员自定义字段', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('店主新增「车牌号」「了解渠道（必填）」→ 店员建档按字段填写 → 会员详情显示', async ({ page }) => {
    await login(page, 'linlan');
    const existing = ((await (await page.request.get('/api/settings')).json()) as { memberFields: FieldDef[] }).memberFields;
    try {
      if (existing.some((f) => LABELS.includes(f.label))) {
        // 再次执行：字段已建过（上次结束时停用），重新启用
        const next = existing.map((f) => (LABELS.includes(f.label) ? { ...f, active: true } : f));
        expect((await page.request.put('/api/settings', { data: { memberFields: next } })).status()).toBe(200);
      } else {
        await page.goto('/admin/rules');
        const card = page.getByTestId('member-fields-card');
        await card.getByRole('button', { name: '新增字段' }).click();
        let dialog = page.getByRole('dialog').filter({ hasText: '新增会员字段' });
        await dialog.getByLabel('字段名称').fill('车牌号');
        await dialog.getByTestId('member-field-done').click();
        await card.getByRole('button', { name: '新增字段' }).click();
        dialog = page.getByRole('dialog').filter({ hasText: '新增会员字段' });
        await dialog.getByLabel('字段名称').fill('了解渠道');
        await dialog.getByLabel('类型').selectOption('select');
        await dialog.getByLabel('可选值').fill('朋友推荐\n大众点评\n路过');
        await dialog.getByText('必填（新建和编辑会员时必须填写）').click();
        await dialog.getByTestId('member-field-done').click();
        await expect(card).toContainText('未保存');
        await card.getByTestId('member-fields-save').click();
        await expect(page.getByText('会员字段已保存')).toBeVisible();
        await expect(card).not.toContainText('未保存');
        await expect(card).toContainText('必填');
      }
      await page.request.post('/api/auth/logout');

      // 店员建档
      await login(page, 'xiaozhou');
      await page.goto('/');
      const phone = `199${String(Date.now()).slice(-8)}`;
      await page.getByRole('button', { name: '新建会员' }).click();
      const form = page.getByRole('dialog').filter({ hasText: '新建会员' });
      await form.getByLabel('姓名').fill('字段演示会员');
      await form.getByLabel('手机号').fill(phone);
      await form.getByLabel('车牌号').fill('沪A·12345');
      await form.getByRole('button', { name: '建档' }).click();
      // 必填的「了解渠道」没选：页面拦下，不提交
      await expect(form.getByText('请填写「了解渠道」')).toBeVisible();
      await form.getByLabel('了解渠道').selectOption('大众点评');
      await form.getByRole('button', { name: '建档' }).click();
      await expect(page.getByText(/已为「字段演示会员」建档/)).toBeVisible();
      const fields = page.getByTestId('member-custom-fields');
      await expect(fields).toContainText('车牌号');
      await expect(fields).toContainText('沪A·12345');
      await expect(fields).toContainText('大众点评');

      // 编辑时带出原值
      await page.locator('main').getByRole('button', { name: '编辑' }).click();
      const edit = page.getByRole('dialog').filter({ hasText: '编辑会员资料' });
      await expect(edit.getByLabel('车牌号')).toHaveValue('沪A·12345');
      await expect(edit.getByLabel('了解渠道')).toHaveValue('大众点评');
      await edit.getByRole('button', { name: '取消' }).click();
    } finally {
      // 停用这两个字段，避免影响其他浏览器用例的建档
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      const now = ((await (await page.request.get('/api/settings')).json()) as { memberFields: FieldDef[] }).memberFields;
      await page.request.put('/api/settings', { data: { memberFields: now.map((f) => (LABELS.includes(f.label) ? { ...f, active: false } : f)) } });
    }
  });
});
