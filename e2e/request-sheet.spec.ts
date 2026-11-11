// 供应链二次整改 02、01 浏览器验收（docs/ERP_ROUND2.md 第 3、4 节）：
//   02 部门表格导入：「提需求」页点「导入表格」→ 下载模板 → 选一份有错行的表 → 预览：错行整行标红、写明哪一列为什么，导入按钮不能点
//      → 换成改好的表 → 预览 → 导入 → 合成待审核的需求单 → 同一份表再导入要勾「确认再导入一次」。
//   01 集采导入按最终版：选部门 → 选按「品牌新增寻款采购清单」填的表（标题行、表头、是否下单）→ 预览：标了「是」的行不导入
//      → 导入 → 已通过的需求单进待转采购单。
// 依赖演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。只在门店电脑尺寸执行。
import { expect, test, type Page } from '@playwright/test';
import { buildWorkbook } from '../src/server/lib/xlsx';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

const getJson = async <T,>(page: Page, url: string) => (await (await page.request.get(url)).json()) as T;
const COLUMNS = ['序号', '申请部门', '物品名称', '物料编号', '用途', '数量', '单位', '采购优先级', '期望到货日期', '参考单价', '参考链接', '产品详情', '备注'];

test.describe('需求单表格导入', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('部门表格导入：模板、错行标红、改好后导入成待审核的需求单、同一份表再导入要确认', async ({ page }) => {
    await login(page, 'linlan');
    const meta = await getJson<{ departments: { id: number; name: string }[]; materials: { id: number; code: string; name: string }[]; purposes: string[] }>(page, '/api/erp/requests/meta');
    const dept = meta.departments[0]!;
    const [m1, m2] = meta.materials;
    const purpose = meta.purposes[0]!;
    const tag = String(Date.now()).slice(-6);
    const row = (o: Record<string, string | number>) => COLUMNS.map((c) => o[c] ?? '').join(',');
    const good = [row({ 序号: 1, 申请部门: dept.name, 物品名称: m1!.name, 物料编号: m1!.code, 用途: purpose, 数量: 3, 备注: `E2E 表格${tag}` }), row({ 序号: 2, 申请部门: dept.name, 物品名称: m2!.name, 物料编号: m2!.code, 用途: purpose, 数量: 1.5, 采购优先级: '紧急' })];
    const bad = row({ 序号: 3, 申请部门: dept.name, 物品名称: `E2E 没有的东西${tag}`, 用途: purpose, 数量: 1 });

    await page.goto('/erp/requests/new');
    await expect(page.getByTestId('request-form')).toBeVisible();
    // 模板能下载
    expect((await page.request.get('/api/erp/requests/sheet/template')).status()).toBe(200);
    await expect(page.getByTestId('rq-sheet-template')).toBeVisible();
    await page.getByTestId('rq-sheet-import').click();
    await expect(page.getByTestId('request-sheet')).toBeVisible();

    // 有错行：整行标红、写明哪一列为什么，不能导入
    await page.getByTestId('request-sheet-file').setInputFiles({ name: `补货-${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from([COLUMNS.join(','), ...good, bad].join('\n'), 'utf8') });
    await page.getByTestId('request-sheet-preview').click();
    await expect(page.getByTestId('request-sheet-preview-result')).toContainText('有 1 行要先改好');
    await expect(page.getByTestId('request-sheet-row-4')).toContainText(`物品名称：「E2E 没有的东西${tag}」不在物料档案里`);
    await expect(page.getByTestId('request-sheet-apply')).toBeDisabled();

    // 改好的表：两行（普通、紧急）合成两张待审核的需求单
    const csv = [COLUMNS.join(','), ...good].join('\n');
    await page.getByTestId('request-sheet-file').setInputFiles({ name: `补货-${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await page.getByTestId('request-sheet-preview').click();
    await expect(page.getByTestId('request-sheet-preview-result')).toContainText('2 行都能导入，合成 2 张需求单');
    await page.getByTestId('request-sheet-apply').click();
    const done = page.getByTestId('request-sheet-done');
    await expect(done).toContainText('已导入 2 行，合成 2 张需求单（待审核）');
    await done.getByRole('link').first().click();
    await expect(page.getByText(`E2E 表格${tag}`).first()).toBeVisible();

    // 同一份表再导入：提醒导入过，要勾「确认再导入一次」才能导入
    await page.goto('/erp/requests/import');
    await page.getByTestId('request-sheet-file').setInputFiles({ name: `补货-${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await page.getByTestId('request-sheet-preview').click();
    await expect(page.getByTestId('request-sheet-previous')).toContainText('导入过');
    await expect(page.getByTestId('request-sheet-apply')).toBeDisabled();
    await page.getByTestId('request-sheet-repeat').click();
    await expect(page.getByTestId('request-sheet-apply')).toBeEnabled();
  });

  test('集采导入按最终版：选部门、标了「是否下单」的行不导入，其余导成已通过的需求单', async ({ page }) => {
    await login(page, 'linlan');
    const depts = await getJson<{ id: number; name: string }[]>(page, '/api/inventory/departments');
    const dept = depts[0]!;
    const tag = String(Date.now()).slice(-6);
    const header = ['序号', '是否下单', '是否到货', '是否退货', '产品名称', '用途', '采购数量', '备注', '产品详情', '参考链接渠道'];
    const xlsx = buildWorkbook([
      {
        name: '工作表1',
        widths: [],
        merges: ['A1:J1'],
        rows: [
          { cells: ['品牌新增寻款采购清单'] },
          { cells: header },
          { cells: [1, '是', '是', null, `E2E 已下单杯${tag}`, '客房漱口', 19, '大货', '水波杯', { v: '某宝商品页', link: 'https://item.example.com/1' }] },
          { cells: [2, null, null, null, `E2E 寻款托盘${tag}`, '客房桌面放置', '9个', '样品', '炭烧黑', { v: 'https://item.example.com/2', link: 'https://item.example.com/2' }] },
        ],
      },
    ]);
    await page.goto('/purchasing');
    await page.getByTestId('request-import-link').click();
    await expect(page.getByTestId('request-import')).toBeVisible();
    await page.getByTestId('request-import-file').setInputFiles({ name: `寻款-${tag}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx });
    await page.getByTestId('request-import-preview').click();
    // 没选部门：先选
    await expect(page.getByTestId('request-import-preview-result')).toContainText('有 1 行要先改好才能导入');
    await page.getByTestId('request-import-dept').selectOption(String(dept.id));
    await expect(page.getByTestId('request-import-preview-result')).toContainText('1 行都能导入，合成 1 张需求单（线下已下单的 1 行不导入）');
    await expect(page.getByTestId('request-import-row-3')).toContainText('不导入');
    await page.getByTestId('request-import-apply').click();
    const done = page.getByTestId('request-import-done');
    await expect(done).toContainText('已导入 1 行，合成 1 张需求单（已通过）；线下已下单的 1 行没导入');
    await done.getByRole('link', { name: '去待转采购单' }).click();
    await expect(page.getByText(`E2E 寻款托盘${tag}`)).toBeVisible();
    await expect(page.getByText(`E2E 已下单杯${tag}`)).toHaveCount(0);
  });
});
