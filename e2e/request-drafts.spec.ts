// 供应链二次整改 03 浏览器验收（docs/ERP_ROUND2.md）：需求单草稿箱。
//   填到一半（提交不了）→ 过 30 秒自动存成草稿（不弹提示，页脚小字写保存时间，地址栏带上草稿编号）
//   → 切走时马上再存一次 → 刷新页面，填过的内容和图片都在
//   → 点返回离开：提示「已保存草稿」，「采购需求单」页的草稿箱有 1 份，能查看
//   → 再进「提需求」：顶部问「有未完成的草稿，是否继续填写」→ 继续填写 → 填完提交 → 草稿自动清掉
//   → 修改需求单改到一半离开，再进来先问要不要继续 → 继续填写，内容还在
//   → 草稿箱里删除一份草稿。
// 依赖演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。只在门店电脑尺寸执行；结束时把自己建的草稿与需求单清掉。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
// 1×1 的 PNG：浏览器上传前会压缩成 JPEG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

type Draft = { key: string; title: string; lineCount: number; request: { id: number } | null };
const drafts = async (page: Page) => ((await (await page.request.get('/api/erp/requests/drafts')).json()) as { drafts: Draft[] }).drafts;
async function clearDrafts(page: Page) {
  for (const d of await drafts(page)) await page.request.post(`/api/erp/requests/drafts/${d.key}/delete`, { data: {} });
}

test.describe('需求单草稿箱', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('自动保存、刷新后恢复（含图片）、离开时提示、继续填写、提交后清掉、修改草稿、删除', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page, 'linlan');
    await clearDrafts(page);
    const depts = (await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[];
    if (depts.length === 0) await page.request.post('/api/inventory/departments', { data: { name: '采购部' } });
    const dept = ((await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[])[0]!;
    const tag = String(Date.now()).slice(-6);
    const name = `E2E 草稿杯${tag}`;
    let requestId = 0;

    try {
      // 时间可以快进：自动保存每 30 秒一次
      await page.clock.install();
      await page.goto('/erp/requests/new');
      await expect(page.getByTestId('request-form')).toBeVisible();
      await expect(page.getByTestId('rq-draft-banner')).toHaveCount(0);
      await expect(page.getByTestId('rq-draft-status')).toHaveAttribute('data-state', 'idle');
      // 空白的单过了 30 秒也不存
      await page.clock.fastForward(31_000);
      expect(await drafts(page)).toHaveLength(0);

      // 填到一半：没选用途、没填单位和链接，提交不了
      await page.getByTestId('rq-dept').selectOption(String(dept.id));
      await page.getByTestId('rq-name-0').fill(name);
      await page.getByTestId('rq-qty-0').fill('19');
      await page.getByTestId('rq-images-0-input').setInputFiles({ name: 'cup.png', mimeType: 'image/png', buffer: PNG });
      await expect(page.getByLabel('删除图片 1')).toBeVisible();
      await expect(page.getByTestId('rq-submit')).toBeDisabled();

      // 过 30 秒：自动存成草稿，不弹提示，页脚小字写保存时间，地址栏带上草稿编号
      await page.clock.fastForward(31_000);
      await expect(page.getByTestId('rq-draft-status')).toHaveAttribute('data-state', 'saved');
      await expect(page.getByTestId('rq-draft-status')).toContainText('草稿已自动保存');
      await expect(page.getByText('已保存草稿', { exact: true })).toHaveCount(0);
      await expect(page).toHaveURL(/\/erp\/requests\/new\?draft=[0-9a-f-]{36}$/);
      const key = new URL(page.url()).searchParams.get('draft')!;
      let mine = await drafts(page);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ key, title: name, lineCount: 1, request: null });

      // 又填了一点，没等到 30 秒就切走（最小化、切到别的标签页、关页面）：马上再存一次
      await page.getByTestId('rq-unit-0').fill('个');
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect
        .poll(async () => ((await (await page.request.get(`/api/erp/requests/drafts/${key}`)).json()) as { body: { lines: { unit: string }[] } }).body.lines[0]!.unit)
        .toBe('个');

      // 刷新：填过的内容和图片都在
      await page.reload();
      await expect(page.getByTestId('rq-draft-resumed')).toBeVisible();
      await expect(page.getByTestId('rq-dept')).toHaveValue(String(dept.id));
      await expect(page.getByTestId('rq-name-0')).toHaveValue(name);
      await expect(page.getByTestId('rq-qty-0')).toHaveValue('19');
      await expect(page.getByTestId('rq-unit-0')).toHaveValue('个');
      await expect(page.getByLabel('删除图片 1')).toBeVisible();
      await expect(page.getByTestId('rq-line-0').locator('img').first()).toHaveJSProperty('complete', true);
      expect(await page.getByTestId('rq-line-0').locator('img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

      // 改了数量，点返回离开：马上存一次，提示「已保存草稿」
      await page.getByTestId('rq-qty-0').fill('25');
      await page.getByRole('link', { name: '返回需求单' }).click();
      await expect(page.getByText('已保存草稿', { exact: true })).toBeVisible();
      await expect(page.getByTestId('requests-page')).toBeVisible();
      await expect(page.getByTestId('requests-draft-box')).toContainText('草稿箱（1）');

      // 草稿箱：查看内容
      await page.getByTestId('requests-draft-box').click();
      const box = page.getByTestId('draft-box');
      await expect(box.getByTestId(`draft-${key}`)).toContainText(name);
      await expect(box.getByTestId(`draft-${key}`)).toContainText(dept.name);
      await box.getByTestId(`draft-view-${key}`).click();
      await expect(box.getByTestId(`draft-detail-${key}`)).toContainText('25 个');
      await expect(box.getByTestId(`draft-detail-${key}`).getByLabel('查看图片 1')).toBeVisible();
      await page.keyboard.press('Escape');

      // 再进「提需求」：顶部问要不要继续填
      await page.getByTestId('request-new').click();
      const banner = page.getByTestId('rq-draft-banner');
      await expect(banner).toContainText('有未完成的草稿，是否继续填写？');
      await expect(banner).toContainText(name);
      await expect(page.getByTestId('rq-name-0')).toHaveValue('');
      await page.getByTestId('rq-draft-banner-resume').click();
      await expect(page).toHaveURL(new RegExp(`draft=${key}$`));
      await expect(page.getByTestId('rq-name-0')).toHaveValue(name);
      await expect(page.getByTestId('rq-qty-0')).toHaveValue('25');
      await expect(page.getByLabel('删除图片 1')).toBeVisible();

      // 填完提交：草稿自动清掉，不提示「已保存草稿」
      await page.getByTestId('rq-purpose-0').selectOption({ index: 1 });
      await page.getByTestId('rq-link-0').fill('https://example.com/e2e-draft-cup');
      await page.getByTestId('rq-submit').click();
      await expect(page).toHaveURL(/\/erp\/requests\?request=\d+/);
      requestId = Number(new URL(page.url()).searchParams.get('request'));
      await expect(page.getByTestId('request-sheet')).toContainText(name);
      expect(await drafts(page)).toHaveLength(0);
      await expect(page.getByTestId('requests-draft-box')).toHaveText('草稿箱');
      await expect(page.getByText('已保存草稿', { exact: true })).toHaveCount(0);
      // 提交过的草稿编号不能再打开
      await page.goto(`/erp/requests/new?draft=${key}`);
      await expect(page.getByTestId('rq-draft-gone')).toContainText('这份草稿已经不在了');

      // 修改需求单改到一半离开：再进来先问要不要继续
      await page.goto(`/erp/requests/${requestId}/edit`);
      await expect(page.getByTestId('request-form')).toBeVisible();
      await expect(page.getByTestId('rq-qty-0')).toHaveValue('25');
      // 没改过的不存草稿
      await page.clock.fastForward(31_000);
      expect(await drafts(page)).toHaveLength(0);
      await page.getByTestId('rq-qty-0').fill('40');
      await page.clock.fastForward(31_000);
      await expect(page.getByTestId('rq-draft-status')).toHaveAttribute('data-state', 'saved');
      mine = await drafts(page);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.request?.id).toBe(requestId);
      await page.goto(`/erp/requests/${requestId}/edit`);
      await expect(page.getByTestId('rq-draft-choice')).toContainText('有未完成的草稿，是否继续填写？');
      await page.getByTestId('rq-draft-continue').click();
      await expect(page.getByTestId('rq-qty-0')).toHaveValue('40');
      await expect(page.getByLabel('删除图片 1')).toBeVisible();
      // 需求单本身还没变（草稿不是提交）
      const current = (await (await page.request.get(`/api/erp/requests/${requestId}`)).json()) as { lines: { qtyMilli: number }[] };
      expect(current.lines[0]!.qtyMilli).toBe(25_000);

      // 草稿箱里删除：另存一份新需求的草稿，在草稿箱里删掉
      const extra = randomUUID();
      const put = await page.request.put(`/api/erp/requests/drafts/${extra}`, {
        data: { rev: 0, saveId: randomUUID(), requestId: null, body: { departmentId: dept.id, needBy: '', priority: 'normal', note: '', lines: [{ kind: 'new', materialId: null, name: `E2E 要删的草稿${tag}`, purpose: '', qty: '1', unit: '', refPrice: '', link: '', details: '', note: '', imageIds: [] }] } },
      });
      expect(put.ok()).toBe(true);
      await page.goto('/erp/requests');
      await expect(page.getByTestId('requests-draft-box')).toContainText('草稿箱（2）');
      await page.getByTestId('requests-draft-box').click();
      await page.getByTestId(`draft-delete-${extra}`).click();
      await page.getByTestId('draft-delete-confirm').click();
      await expect(page.getByTestId(`draft-${extra}`)).toHaveCount(0);
      await expect(page.getByTestId('requests-draft-box')).toContainText('草稿箱（1）');
    } finally {
      // 清掉自己建的：草稿，与那张待审核的需求单（撤回）
      await clearDrafts(page);
      if (requestId) await page.request.post(`/api/erp/requests/${requestId}/cancel`, { data: { reason: 'E2E 草稿箱用例结束' } });
    }
  });
});
