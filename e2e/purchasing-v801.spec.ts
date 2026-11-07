// 8.0.1 采购组整改的新页面（docs/HANDOFF_V801.md）：采购规则（截单、急采分级）、集采导入（模板 → 预览 → 导入）、供应商比价、
// 赠品台账（登记、作废）、签约供应商的合同 PDF。急采的整条流程在 warehouses.spec.ts。
// 依赖 seed-demo 与 seed-inventory-demo（仅独立演示库）。账号：店主 linlan，密码 yuzu2026。会改演示数据，断言都用相对变化。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string, landing: RegExp | string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: landing })).toBeVisible({ timeout: 30_000 });
}
const getJson = async <T>(page: Page, url: string) => (await (await page.request.get(url)).json()) as T;

test.describe('8.0.1 采购组整改的新页面', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('采购规则：店主打开截单、改截单时间与急采分级，保存后生效；采购途径固定三类', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    await page.goto('/purchasing');
    await page.getByTestId('purchase-rules-page-link').click();
    const card = page.getByTestId('purchase-rules');
    await expect(card.getByTestId('pr-channels')).toContainText('网购');
    await expect(card.getByTestId('pr-channels')).toContainText('自采（现采/零采）');
    await expect(card.getByTestId('pr-channels')).toContainText('供应商');
    await card.getByTestId('pr-cutoff').check();
    await card.getByTestId('pr-cutoff-time').fill('23:58');
    await card.getByTestId('pr-tier-max-0').fill('4000');
    await card.getByTestId('purchase-rules-save').click();
    await expect(page.getByText('采购规则已保存')).toBeVisible();
    const rules = await getJson<{ cutoffEnabled: boolean; cutoffTime: string; urgentTiers: { maxCents: number }[] }>(page, '/api/inventory/purchase-rules');
    expect(rules).toMatchObject({ cutoffEnabled: true, cutoffTime: '23:58' });
    expect(rules.urgentTiers[0]!.maxCents).toBe(400_000);
    // 改回默认（别的用例按默认走）
    await card.getByTestId('pr-cutoff').uncheck();
    await card.getByTestId('pr-tier-max-0').fill('5000');
    await card.getByTestId('purchase-rules-save').click();
    await expect.poll(async () => (await getJson<{ cutoffEnabled: boolean }>(page, '/api/inventory/purchase-rules')).cutoffEnabled).toBe(false);
    // 「模块设置」里换成了链接
    await page.goto('/erp/modules');
    await expect(page.getByTestId('purchase-rules-link')).toBeVisible();
    await expect(page.getByTestId('purchase-rules')).toHaveCount(0);
  });

  test('集采导入：下载模板、选文件、预览、导入，合成已通过的需求单，进待转采购单', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    const depts = await getJson<{ name: string }[]>(page, '/api/inventory/departments');
    const dept = depts.find((d) => d.name === '水吧') ?? depts[0]!;
    const tag = Date.now().toString(36);
    const csv = [
      '序号,申请部门,申请人,物品名称,单位,数量,采购优先级,期望到货日期,采购途径,供应商名称,备注',
      `1,${dept.name},E2E 小李,E2E 集采纸巾${tag},包,6,紧急,,网购,,`,
      `2,${dept.name},E2E 小王,E2E 集采抹布${tag},条,10,普通,,自采（现采/零采）,,`,
    ].join('\n');
    await page.goto('/purchasing');
    await page.getByTestId('request-import-link').click();
    const tpl = await page.request.get('/api/erp/requests/import/template');
    expect(tpl.status()).toBe(200);
    await page.getByTestId('request-import-file').setInputFiles({ name: `集采-${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await page.getByTestId('request-import-preview').click();
    await expect(page.getByTestId('request-import-preview-result')).toContainText('2 行都能导入，合成 2 张需求单');
    await page.getByTestId('request-import-apply').click();
    const done = page.getByTestId('request-import-done');
    await expect(done).toContainText('已导入 2 行，合成 2 张需求单');
    await done.getByRole('link', { name: '去待转采购单' }).click();
    await expect(page.getByText(`E2E 集采纸巾${tag}`)).toBeVisible();
    await expect(page.getByText(`E2E 集采抹布${tag}`)).toBeVisible();
  });

  test('供应商比价能打开；赠品台账登记与作废', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    await page.goto('/purchasing');
    await page.getByTestId('compare-link').click();
    await expect(page.getByTestId('compare-page')).toBeVisible();

    const tag = Date.now().toString(36);
    await page.goto('/inventory/gifts');
    await page.getByTestId('gift-new').click();
    await page.getByTestId('gift-name').fill(`E2E 赠品围裙${tag}`);
    await page.getByTestId('gift-qty').fill('3');
    await page.getByTestId('gift-unit').fill('条');
    await page.getByTestId('gift-save').click();
    await expect(page.getByText('赠品已登记')).toBeVisible();
    const row = page.getByTestId('gifts-list').locator('li', { hasText: `E2E 赠品围裙${tag}` });
    await expect(row).toContainText('3 条');
    await row.getByRole('button', { name: '作废' }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('E2E：登记重复');
    await page.getByRole('dialog').getByRole('button', { name: '作废' }).click();
    await expect(row).toContainText('已作废：E2E：登记重复');
  });

  test('签约供应商在档案里上传合同 PDF（未签约的不能传由集成测试核对）', async ({ page }) => {
    await login(page, 'linlan', '会员工作台');
    const sups = await getJson<{ id: number; code: string; name: string; contact: string; phone: string; note: string; settlement: string; reconcileCycle: string; defaultChannel: string | null; active: boolean }[]>(page, '/api/inventory/suppliers?all=1');
    const s = sups.find((x) => x.code === 'S003') ?? sups[0]!;
    const save = await page.request.put(`/api/inventory/suppliers/${s.id}`, {
      data: { code: s.code, name: s.name, contact: s.contact, phone: s.phone, note: s.note, settlement: s.settlement, reconcileCycle: s.reconcileCycle, defaultChannel: s.defaultChannel, active: s.active, contracted: true },
    });
    expect(save.status(), await save.text()).toBe(200);
    await page.goto('/inventory/master');
    await page.getByRole('radio', { name: '供应商' }).click();
    await page.getByRole('button', { name: new RegExp(s.name) }).first().click();
    const box = page.getByTestId('supplier-contracts');
    const tag = Date.now().toString(36);
    await box.getByTestId('supplier-contract-file').setInputFiles({ name: `E2E 合同${tag}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n% e2e ${tag}\n%%EOF\n`) });
    await expect(box).toContainText(`E2E 合同${tag}.pdf`);
  });
});
