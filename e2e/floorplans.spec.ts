// v0.7.15 底图转换浏览器验收（飞书需求 RQ-004 第二段）：后台「空间台账 → 底图」上传合成样例图纸 → 转换完成后看每层底图与房间轮廓、
// 例外清单、与台账的比对 → 启用 → 上传第二版 → 与在用那一批比对出编码变更、房间减少 → 同一份图纸重传回到原来那一批。
// v0.7.19 图纸治理：入库登记（来源必选、版本或说明）→ 启用第二版写换下原因 → 档案里打开已换下的第一版（只读）→ 写原因换回 →
// 在用历史；例外 W306 在底图上点出轮廓补画、作废补画。
// 图纸是合成样例（src/server/demo/floorplan-sample.ts），每次在开头加一行带时间戳的注释，文件摘要不同、可重复执行。
// 依赖演示数据（仅独立演示库），账号店主 linlan，密码 yuzu2026。
import { expect, test, type Page } from '@playwright/test';
import type { SpaceLedger } from '../src/shared/spaces';
import expected from '../src/server/demo/floorplan-expected.json' with { type: 'json' };
import { floorplanSampleDxf, floorplanSamplePdf } from '../src/server/demo/floorplan-sample';

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
    await page.getByTestId('subnav-plans').click();
    await expect(page.getByTestId('floorplan-upload')).toBeVisible();

    // 第一版：选文件 → 上传 → 转换中 → 待启用
    await choose(page, `样例图纸-${stamp}.dxf`, dxf(1, stamp));
    await expect(page.getByTestId('floorplan-file-name')).toContainText(`样例图纸-${stamp}.dxf`);
    // 入库登记（v0.7.19）：来源必选（选了才能上传），版本或说明、收图日期（默认今天）
    await expect(page.getByTestId('floorplan-upload-submit')).toBeDisabled();
    await page.getByTestId('floorplan-intake').getByRole('radio', { name: '设计方' }).click();
    await page.getByTestId('floorplan-source-note').fill(`E2E 第一版 ${stamp}`);
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

    // ── v0.7.19 图纸治理 ──
    const v2 = Number((await page.getByTestId('floorplan-detail-title').textContent())!.match(/#(\d+)/)![1]);
    expect(v2).not.toBe(v1);
    // 启用第二版，写第一版换下的原因
    await page.getByTestId('floorplan-activate').click();
    await page.getByTestId('floorplan-switch-reason').fill(`E2E 第二版 ${stamp}`);
    await page.getByTestId('floorplan-activate-confirm').click();
    await expect(page.getByText(`批次 #${v2} 已启用`)).toBeVisible();
    // 档案：第一版已换下，照样能打开（只读），写着入库登记与换下的原因；换回要写原因
    await page.getByTestId(`floorplan-batch-${v1}`).click();
    await expect(detail).toContainText('已换下的批次只读');
    await expect(detail).toContainText(`E2E 第二版 ${stamp}`);
    await expect(page.getByTestId('floorplan-registration')).toContainText('设计方');
    await expect(page.getByTestId('floorplan-registration')).toContainText(`E2E 第一版 ${stamp}`);
    await expect(page.getByTestId('floorplan-exceptions')).toContainText('例外 3 个');
    await expect(page.getByTestId('floorplan-draw-W306')).toHaveCount(0);
    await page.getByTestId('floorplan-restore').click();
    await expect(page.getByTestId('floorplan-activate-confirm')).toBeDisabled();
    await page.getByTestId('floorplan-switch-reason').fill('E2E 第二版有误，换回第一版');
    await page.getByTestId('floorplan-activate-confirm').click();
    await expect(page.getByText(`批次 #${v1} 已换回`)).toBeVisible();
    await expect(detail.getByText('在用', { exact: true })).toBeVisible();
    const history = page.getByTestId('floorplan-history');
    await expect(history).toContainText('换回');
    await expect(history).toContainText('E2E 第二版有误，换回第一版');
    await expect(page.getByTestId('floorplan-batch-history')).toContainText('换回');

    // 例外 W306（连到走廊）补画轮廓：在底图上围着它点四个点 → 保存 → 已补画（虚线轮廓）→ 作废补画
    await page.getByTestId('floorplan-draw-W306').click();
    await expect(page.getByTestId('floorplan-outline-editor')).toContainText('补画 W306');
    // 例外清单在底图下面：先把 W306 滚到看得见的地方再点
    await page.getByTestId('floorplan-room-W306').scrollIntoViewIfNeeded();
    const label = (await page.getByTestId('floorplan-room-W306').boundingBox())!;
    const [cx, cy] = [label.x + label.width / 2, label.y + label.height / 2];
    const corners: [number, number][] = [
      [-30, -20],
      [30, -20],
      [30, 20],
      [-30, 20],
    ];
    for (const [dx, dy] of corners) await page.mouse.click(cx + dx, cy + dy);
    await expect(page.getByTestId('floorplan-outline-editor')).toContainText('已点 4 个');
    await page.getByTestId('floorplan-outline-save').click();
    await expect(page.getByText('W306 已补画轮廓')).toBeVisible();
    await expect(page.getByTestId('floorplan-exception-W306')).toContainText('已补画');
    await expect(page.getByTestId('floorplan-room-W306')).toHaveAttribute('data-drawn', 'true');
    await page.getByTestId('floorplan-undraw-W306').click();
    await expect(page.getByText('W306 的补画已作废')).toBeVisible();
    await expect(page.getByTestId('floorplan-exception-W306')).not.toContainText('已补画');
  });

  test('PDF 底图（测试报告建议补的浏览器用例）：页面上的比例文字自动认出；没有比例文字的不填比例转换失败，填上比例重传能转换', async ({ page }) => {
    const stamp = String(Date.now());
    // 文件末尾加一行注释：每次跑内容都不同，不会命中「这份图纸已经转换过」
    const pdf = (kind: 'standard' | 'no-scale') => Buffer.concat([Buffer.from(floorplanSamplePdf(kind)), Buffer.from(`\n% e2e ${stamp}\n`)]);
    const choosePdf = (name: string, buffer: Buffer) => page.getByTestId('floorplan-file').setInputFiles({ name, mimeType: 'application/pdf', buffer });
    await login(page, 'linlan');
    await page.goto('/admin/spaces');
    await page.getByTestId('subnav-plans').click();
    const detail = page.getByTestId('floorplan-detail');

    // 页面上写了 1:100：不填比例也能转换，入库登记里不记填的比例
    await choosePdf(`样例PDF-${stamp}.pdf`, pdf('standard'));
    await expect(page.getByTestId('floorplan-pdf-scale')).toBeVisible();
    await page.getByTestId('floorplan-intake').getByRole('radio', { name: '设计方' }).click();
    await page.getByTestId('floorplan-upload-submit').click();
    await expect(detail).toContainText(`样例PDF-${stamp}.pdf`);
    await expect(detail).toContainText('待启用', { timeout: 30_000 });
    await expect(detail).toContainText('PDF');
    await expect(page.getByTestId('floorplan-registration')).not.toContainText('PDF 比例');

    // 页面上没有比例文字、也没填：转换失败，提示要填比例
    const noScale = pdf('no-scale');
    await choosePdf(`无比例PDF-${stamp}.pdf`, noScale);
    await page.getByTestId('floorplan-intake').getByRole('radio', { name: '设计方' }).click();
    await page.getByTestId('floorplan-upload-submit').click();
    await expect(detail).toContainText(`无比例PDF-${stamp}.pdf`);
    await expect(detail).toContainText('没有认出图纸比例', { timeout: 30_000 });

    // 填上 1:100 重传同一份：按填的比例转换（比例不同算另一批，不会回到失败的那一批）
    await choosePdf(`无比例PDF-${stamp}.pdf`, noScale);
    await page.getByTestId('floorplan-intake').getByRole('radio', { name: '设计方' }).click();
    await page.getByTestId('floorplan-pdf-scale').fill('100');
    await page.getByTestId('floorplan-upload-submit').click();
    await expect(page.getByTestId('floorplan-registration')).toContainText('PDF 比例 1:100', { timeout: 30_000 });
    await expect(detail).toContainText('待启用', { timeout: 30_000 });
  });
});
