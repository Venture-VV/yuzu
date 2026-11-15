// 8.0.22 浏览器验收（docs/HANDOFF_V8022.md）。依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · 多门店（MD-A）：后台「门店与主体」新建一家店 → 顶栏换到这家店 → 有几家店时库存多「调拨」页签（MD-B），能打开新建调拨单
//     → 换回本店；用完把这家店停用（不影响别的用例；整条调拨链与按店的数据在 tests/stores-*.test.ts）；
//   · AI 辅助（MD-D）：经营总览顶上「昨日小结」、看板「问数」、后台「对外接口」的 AI 开关。应用带 INTEGRATIONS_MOCK=true 启动时
//     问一次、合同表单上「AI 看一下条款」；没带时核对「还没配置」的样子（CI 的浏览器验收没带）。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

interface StoreRow {
  id: number;
  code: string;
  name: string;
  entityId: number;
  address: string;
  phone: string;
  sortOrder: number;
  active: boolean;
  version: number;
}

test.describe('8.0.22 多门店、调拨与 AI 辅助', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('多门店：后台新建一家店、顶栏换店；有几家店时库存多「调拨」页签；换回本店', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const code = `Y${String(Date.now()).slice(-6)}`;
    await page.goto('/admin/stores');
    await page.getByTestId('store-new').click();
    await page.getByTestId('store-code').fill(code);
    await page.getByTestId('store-name').fill(`验收分店${code.slice(-3)}`);
    await page.getByTestId('store-save').click();
    await expect(page.getByTestId(`store-row-${code}`)).toBeVisible();
    try {
      // 门店的顶栏（左侧导航）换到这家店
      await page.goto('/');
      await page.getByTestId('store-switcher').click();
      await page.getByTestId(`store-pick-${code}`).click();
      await expect(page.getByTestId('store-current')).toHaveText(code);
      // 库存「调拨」页签：新建调拨单的表单能打开（调出 / 调入是各店的主仓与总仓）
      await page.goto('/inventory/transfers');
      await page.getByTestId('transfer-new').click();
      await expect(page.getByTestId('transfer-from')).toBeVisible();
      await expect(page.getByTestId('transfer-to').locator('option')).not.toHaveCount(0);
      await page.keyboard.press('Escape');
      // 换回本店
      await page.goto('/');
      await page.getByTestId('store-switcher').click();
      await page.getByTestId('store-pick-HQ').click();
      await expect(page.getByTestId('store-current')).toHaveText('HQ');
    } finally {
      await page.request.post('/api/auth/store', { data: { storeId: 1 } });
      const list = (await (await page.request.get('/api/admin/stores')).json()) as { stores: StoreRow[] };
      const s = list.stores.find((x) => x.code === code);
      if (s) {
        const off = await page.request.put(`/api/admin/stores/${s.id}`, {
          data: { code: s.code, name: s.name, entityId: s.entityId, address: s.address, phone: s.phone, sortOrder: s.sortOrder, active: false, version: s.version },
        });
        expect(off.ok(), await off.text()).toBe(true);
      }
    }
    // 停用以后只剩一家店：顶栏不再显示换店
    await page.goto('/');
    await expect(page.getByTestId('store-switcher')).toHaveCount(0);
  });

  test('AI 辅助：昨日小结、问数、合同条款提示、后台开关（模拟模式下问一次）', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const status = (await (await page.request.get('/api/ai/status')).json()) as { mode: 'off' | 'mock' | 'live' };

    // 后台「对外接口」：AI 辅助一行与开关
    await page.goto('/admin/integrations');
    await expect(page.getByTestId('integration-kinds')).toContainText('AI 辅助');
    await expect(page.getByTestId('ai-rules')).toBeVisible();
    await expect(page.getByTestId('ai-rule-enabled')).toBeChecked();

    // 经营总览顶上「昨日小结」：应用每分钟的自动任务已经生成了前一天的一份（没配模型时只有数字）
    await page.goto('/admin/dashboard/overview');
    const card = page.getByTestId('ai-summary');
    await expect(card).toBeVisible();
    await expect(card).toContainText(status.mode === 'off' ? '只有数字' : '已生成', { timeout: 20_000 });
    await card.getByTestId('ai-summary-toggle').click();
    await expect(card.getByTestId('ai-summary-facts')).toContainText('净营业额');

    // 问数
    await page.goto('/admin/dashboard/ask');
    if (status.mode === 'off') {
      await expect(page.getByTestId('ai-ask')).toContainText('还没配置模型服务');
      await expect(page.getByTestId('ai-question-input')).toHaveCount(0);
    } else {
      await page.getByTestId('ai-question-input').fill('昨天营收多少？');
      await page.getByTestId('ai-question-send').click();
      await expect(page.getByTestId('ai-answer').first()).toBeVisible({ timeout: 30_000 });
      if (status.mode === 'mock') await expect(page.getByTestId('ai-answer').first()).toContainText('【模拟回答】');
    }

    // 合同表单：没配模型服务时没有「AI 看一下条款」；模拟时按格式交回一条提示
    await page.goto('/erp/contracts/new');
    await expect(page.getByTestId('contract-category')).toBeVisible();
    if (status.mode === 'off') {
      await expect(page.getByTestId('contract-ai-hints')).toHaveCount(0);
    } else {
      await page.getByTestId('contract-ai-hints-run').click();
      await expect(page.getByTestId('contract-ai-hint-list')).toBeVisible({ timeout: 30_000 });
    }
  });
});
