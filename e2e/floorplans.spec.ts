// v0.7.15 底图转换浏览器验收（飞书需求 RQ-004 第二段）：后台「空间台账 → 底图」上传合成样例图纸 → 转换完成后看每层底图与房间轮廓、
// 例外清单、与台账的比对 → 启用 → 上传第二版 → 与在用那一批比对出编码变更、房间减少 → 同一份图纸重传回到原来那一批。
// 图纸是合成样例（src/server/demo/floorplan-sample.ts），每次在开头加一行带时间戳的注释，文件摘要不同、可重复执行。
// 依赖演示数据（仅独立演示库），账号店主 linlan，密码 yuzu2026。
import { expect, test, type Page } from '@playwright/test';
import type { SpaceLedger } from '../src/shared/spaces';
import expected from '../src/server/demo/floorplan-expected.json' with { type: 'json' };
import { floorplanSampleDxf } from '../src/server/demo/floorplan-sample';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

const dxf = (variant: 1 | 2, stamp: string) => Buffer.from(`999\nE2E ${stamp}\n${floorplanSampleDxf(variant)}`, 'utf8');
const choose = (page: Page, name: string, buffer: Buffer) => page.getByTestId('floorplan-file').setInputFiles({ name, mimeType: 'application/dxf', buffer });

test.describe('底图转换（v0.7.15）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会写入底图批次的流程只在门店电脑尺寸执行一次');

  test('上传样例图纸 → 预览底图、轮廓、例外与台账比对 → 启用 → 第二版比对出编码变更 → 重传同一份不重复转换', async ({ page }) => {
    const stamp = String(Date.now());
    await login(page, 'linlan');
    await page.goto('/admin/spaces');
    await expect(page.getByRole('heading', { name: '空间台账' })).toBeVisible();
    await page.getByRole('radio', { name: '底图' }).click();
    await expect(page.getByTestId('floorplan-upload')).toBeVisible();

    // 第一版：选文件 → 上传 → 转换中 → 待启用
    await choose(page, `样例图纸-${stamp}.dxf`, dxf(1, stamp));
    await expect(page.getByTestId('floorplan-file-name')).toContainText(`样例图纸-${stamp}.dxf`);
    await page.getByTestId('floorplan-upload-submit').click();
    await expect(page.getByText(/已上传，正在转换/)).toBeVisible();
    const detail = page.getByTestId('floorplan-detail');
    await expect(detail).toContainText(`样例图纸-${stamp}.dxf`);
    await expect(detail).toContainText('待启用', { timeout: 30_000 });

    // 每层底图（SVG）加载出来；默认看编码最多的 L3：配上轮廓的、连成一片的、连到走廊的
    const viewer = page.getByTestId('floorplan-viewer');
    await expect(viewer.getByRole('radio', { name: 'L3 三层平面图' })).toHaveAttribute('aria-checked', 'true');
    await expect(viewer).toContainText('编码 9 个（配上轮廓 6 个）');
    const href = await viewer.locator('image').getAttribute('href');
    expect((await page.request.get(href!)).headers()['content-type']).toContain('image/svg+xml');
    await expect(page.getByTestId('floorplan-room-T301')).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('floorplan-room-W303')).toHaveAttribute('data-status', 'merged');
    await expect(page.getByTestId('floorplan-room-W306')).toHaveAttribute('data-status', 'leak');
    await page.getByTestId('floorplan-room-T301').click();
    await expect(page.getByTestId('floorplan-focus')).toContainText('T301 · 样例 SPA T301 1人间 · 已配上轮廓 · 约');
    await viewer.getByRole('radio', { name: 'L2 二层平面图' }).click();
    await expect(page.getByTestId('floorplan-room-X201')).toHaveAttribute('data-status', 'ok');

    // 例外清单与处理提示；与台账比对（台账里没有的样例编码按当前台账算：演示库原本没有，导入过样例台账的少几个）
    const exceptions = page.getByTestId('floorplan-exceptions');
    await expect(exceptions).toContainText('例外 3 个');
    await expect(exceptions).toContainText('几个编码连成一片');
    await expect(exceptions).toContainText('连到走廊或图外');
    const ledger = (await (await page.request.get('/api/admin/spaces')).json()) as SpaceLedger;
    const inLedger = new Set(ledger.spaces.filter((x) => x.active).map((x) => x.code));
    const missing = [...expected.v1.ok, ...expected.v1.merged, ...expected.v1.leak].filter((c) => !inLedger.has(c)).length;
    if (missing) await expect(page.getByTestId('floorplan-ledger-diff')).toContainText(`图上有、台账没有 ${missing} 个`);
    else await expect(page.getByTestId('floorplan-ledger-diff')).not.toContainText('图上有、台账没有');
    await page.getByTestId('floorplan-report').locator('summary').click();
    await expect(page.getByTestId('floorplan-report')).toContainText('P-活动家具');

    // 启用（确认框写明有例外；先取消一次，什么都不变）
    await page.getByTestId('floorplan-activate').click();
    await expect(page.getByTestId('floorplan-activate-dialog')).toContainText('有 3 个编码没配上轮廓');
    await expect(page.getByTestId('floorplan-activate-dialog')).toContainText('W303、W305、W306');
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await expect(detail).toContainText('待启用');
    await page.getByTestId('floorplan-activate').click();
    await page.getByTestId('floorplan-activate-confirm').click();
    await expect(page.getByText(/已启用/)).toBeVisible();
    await expect(detail.getByText('在用', { exact: true })).toBeVisible();
    const v1 = Number((await page.getByTestId('floorplan-detail-title').textContent())!.match(/#(\d+)/)![1]);

    // 第二版：T303 改成 T305、X202 拆掉 → 与在用那一批比对
    await choose(page, `样例图纸第二版-${stamp}.dxf`, dxf(2, stamp));
    await page.getByTestId('floorplan-upload-submit').click();
    await expect(detail).toContainText(`样例图纸第二版-${stamp}.dxf`);
    await expect(detail).toContainText('待启用', { timeout: 30_000 });
    const diff = page.getByTestId('floorplan-batch-diff');
    await expect(diff).toContainText(`与在用的那一批（#${v1}）比对`);
    await expect(diff).toContainText('T303 → T305');
    await expect(diff).toContainText('减少 1 个');
    await expect(diff).toContainText('X202');

    // 同一份图纸再传：回到原来那一批
    await choose(page, `再传一次-${stamp}.dxf`, dxf(2, stamp));
    await page.getByTestId('floorplan-upload-submit').click();
    await expect(page.getByText(/这份图纸已经转换过/)).toBeVisible();
    await expect(detail).toContainText(`样例图纸第二版-${stamp}.dxf`);

    // 批次列表：第一版在用、第二版待启用
    await expect(page.getByTestId(`floorplan-batch-${v1}`)).toContainText('在用');
  });
});
