// 8.1.13 ERP 采购（原排 8.1.10，docs/ERP_V8110.md）的浏览器验收：
//   ① 采购规则里有四项新设置（提需核库、核库时限、急采补合同金额、补合同期限）；
//   ② 核库转领用：店主替一个部门提需求单（两样总仓有货的物料）→「需求单 → 待核库」里点开 →「核库」：第 1 行只领一部分，
//      第 2 行提议替代品 → 等部门确认替代 → 同意替代 → 进采购审核、通过 → 待转采购单里第 1 行写着已领多少、还要买多少；
//      总仓少了领走的那些；
//   ③ 急采「待补合同」一栏打得开。
// 依赖演示数据（seed-demo 与 seed-inventory-demo：店主 linlan，密码 yuzu2026）。会登记单据（新建两样物料并建期初，物料编号带时间），
// 只在门店电脑尺寸执行；提需核库默认开着，这里照样确认一次是开的（不关）。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

async function json<T>(page: Page, method: 'get' | 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const res = await page.request[method](url, data === undefined ? undefined : { data });
  expect(res.ok(), `${method.toUpperCase()} ${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test.describe('8.1.13 ERP 采购', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('采购规则有四项新设置；急采「待补合同」一栏打得开', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/erp/settings/purchase');
    const box = page.getByTestId('pr-8110');
    await expect(box).toBeVisible();
    for (const id of ['pr-stock-check', 'pr-stock-hours', 'pr-urgent-contract', 'pr-contract-days']) await expect(box.getByTestId(id)).toBeVisible();
    const rules = await json<{ stockCheckHours: number; urgentContractMinCents: number; contractDueDays: number }>(page, 'get', '/api/inventory/purchase-rules');
    expect(rules.stockCheckHours).toBeGreaterThanOrEqual(1);
    expect(rules.contractDueDays).toBeGreaterThanOrEqual(1);
    await page.goto('/purchasing/urgent?view=contract');
    await expect(page.getByTestId('urgent-contract-due').or(page.getByText('没有要补合同的急采'))).toBeVisible();
  });

  test('核库转领用：部分领用、提议替代、部门同意替代、采购通过，转采购单只买剩下的', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page, 'linlan');
    await json(page, 'put', '/api/inventory/purchase-rules', { stockCheckEnabled: true });
    const tag = String(Date.now()).slice(-7);
    const today = (await json<{ calendarToday: string }>(page, 'get', '/api/auth/me')).calendarToday;
    const material = async (code: string, name: string, inventoryUnit: string, purchaseUnit: string, factorMilli: number, stockMilli: number) => {
      const m = await json<{ id: number }>(page, 'post', '/api/inventory/materials', { code, name, inventoryUnit, purchaseUnit, purchaseFactorMilli: factorMilli });
      const d = await json<{ doc: { status: string } }>(page, 'post', '/api/inventory/docs', {
        clientKey: randomUUID(),
        docType: 'opening',
        docDate: today,
        approveNow: true,
        lines: [{ materialId: m.id, qtyMilli: stockMilli }],
      });
      expect(d.doc.status).toBe('confirmed');
      return m.id;
    };
    const tissue = await material(`E2E8110A${tag}`, `E2E 核库纸巾${tag}`, '包', '箱', 20_000, 100_000); // 1 箱 = 20 包，总仓 100 包 = 5 箱
    const soap = await material(`E2E8110B${tag}`, `E2E 核库洗手液${tag}`, '瓶', '瓶', 1000, 10_000);
    const spare = await material(`E2E8110S${tag}`, `E2E 核库替代洗手液${tag}`, '瓶', '瓶', 1000, 30_000);
    const dept = (await json<{ id: number; name: string }[]>(page, 'get', '/api/inventory/departments'))[0]!;
    const made = await json<{ request: { id: number; docNo: string; stockCheck: string; lines: { id: number }[] } }>(page, 'post', '/api/erp/requests', {
      clientKey: randomUUID(),
      departmentId: dept.id,
      lines: [
        { materialId: tissue, name: `E2E 核库纸巾${tag}`, purpose: '客用消耗', qtyMilli: 3000, unit: '箱' },
        { materialId: soap, name: `E2E 核库洗手液${tag}`, purpose: '客用消耗', qtyMilli: 2000, unit: '瓶' },
      ],
    });
    const r = made.request;
    expect(r.stockCheck).toBe('pending');

    // 待核库：列表里点开，详情写着总仓有多少
    await page.goto('/erp/requests?view=stock');
    await page.getByTestId(`stock-row-${r.id}`).click();
    const sheet = page.getByTestId('request-sheet');
    await expect(page.getByTestId('request-sheet-status')).toHaveText('待核库');
    await expect(sheet.getByTestId('request-line-central-1')).toContainText('100 包');
    await expect(sheet.getByTestId('request-line-central-1')).toContainText('约 5 箱');
    await expect(page.getByTestId('request-approve')).toBeDisabled();

    // 核库：第 1 行默认领 3 箱，改成 2 箱；第 2 行提议用替代品 5 瓶
    await page.getByTestId('request-stock-check').click();
    const dialog = page.getByTestId('stock-check-dialog');
    await expect(dialog.getByTestId('stock-qty-1')).toHaveValue('3');
    await dialog.getByTestId('stock-qty-1').fill('2');
    await dialog.getByTestId('stock-line-2').getByRole('radio', { name: '替代' }).click();
    await dialog.getByTestId('stock-sub-material-2').selectOption(String(spare));
    await dialog.getByTestId('stock-sub-qty-2').fill('5');
    await page.getByTestId('stock-check-submit').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('request-sheet-status')).toHaveText('待部门确认替代');
    await expect(sheet.getByTestId('request-line-stock-1')).toContainText('已领 2 箱');

    // 部门确认替代（店主也能答复）：同意以后进采购审核
    await expect(sheet.getByTestId('request-substitute-2')).toContainText(`E2E 核库替代洗手液${tag}`);
    await sheet.getByTestId('request-substitute-yes-2').click();
    await expect(page.getByTestId('request-sheet-status')).toHaveText('待审核');
    await expect(sheet.getByTestId('request-line-stock-2')).toContainText('用替代品');
    await expect(sheet).toContainText('核库：');
    await page.getByTestId('request-approve').click();
    await expect(page.getByTestId('request-sheet-status')).toHaveText('已通过');

    // 总仓：纸巾少了 40 包，替代洗手液少了 5 瓶，原来的洗手液没动
    const mats = await json<{ id: number; stockMilli: number }[]>(page, 'get', '/api/inventory/materials?all=1');
    expect(mats.find((m) => m.id === tissue)!.stockMilli).toBe(60_000);
    expect(mats.find((m) => m.id === spare)!.stockMilli).toBe(25_000);
    expect(mats.find((m) => m.id === soap)!.stockMilli).toBe(10_000);

    // 待转采购单：纸巾那一行写着已领 2、还要买 1 箱；洗手液整行领用了（用替代品），不在里面
    await page.goto('/erp/requests?view=open');
    await expect(page.getByTestId(`open-line-issued-${r.lines[0]!.id}`)).toContainText('还要买 1');
    await expect(page.getByTestId(`open-line-${r.lines[1]!.id}`)).toHaveCount(0);
  });
});
