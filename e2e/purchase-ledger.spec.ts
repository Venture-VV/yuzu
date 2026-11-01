// v0.7.9 浏览器验收（飞书需求 RQ-005 第三步，见 docs/LEDGER.md）：
//   店主登记一笔打款与一笔用备用金的按次报销、一张带规格与图片的采购单 →
//   采购台账当天逐笔看到打款与支出，导出 CSV；账目自检第 2 条列出这笔没有采购单的报销，点开能跳到报销单；
//   下单物料看到规格与缩略图，导出的 Excel 里嵌着图片。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。只在门店电脑尺寸执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
// 1×1 的 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

test.describe('采购台账、账目自检、下单物料', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('台账逐笔、导出；自检列出没有采购单的备用金报销；下单物料导出带图片的 Excel', async ({ page }) => {
    await login(page, 'linlan');
    const me = (await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string; staff: { id: number } };
    const today = me.calendarToday;
    let depts = (await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[];
    if (depts.length === 0) {
      await page.request.post('/api/inventory/departments', { data: { name: '采购部' } });
      depts = (await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[];
    }
    const dept = depts[0]!;
    const tag = String(Date.now()).slice(-6);

    // 打款与用这笔钱的按次报销（没有采购单）
    const adv = (await (
      await page.request.post('/api/erp/petty/advances', {
        data: { clientKey: randomUUID(), departmentId: dept.id, handlerId: me.staff.id, advanceDate: today, amountCents: 30_000, method: 'wechat', evidence: `E2E 台账 ${tag}` },
      })
    ).json()) as { advance: { id: number; docNo: string } };
    const claim = (await (
      await page.request.post('/api/erp/expenses', {
        data: {
          clientKey: randomUUID(), expenseDate: today, departmentId: dept.id, handlerId: me.staff.id, purpose: '办公', paySource: 'petty', advanceId: adv.advance.id,
          invoiceType: 'none', taxRateBp: 0, lines: [{ name: `E2E 台账物品${tag}`, category: 'office', unit: '包', boughtMilli: 2000, receivedMilli: 2000, amountCents: 5_000 }],
        },
      })
    ).json()) as { claim: { id: number; docNo: string } };

    // 带规格与图片的采购单（提交并确认）
    const img = (await (await page.request.post('/api/erp/images', { data: { mime: 'image/png', data: PNG.toString('base64') } })).json()) as { id: number };
    const sups = (await (await page.request.get('/api/inventory/suppliers')).json()) as { id: number }[];
    const mats = (await (await page.request.get('/api/inventory/materials')).json()) as { id: number; code: string; tracked: boolean; active: boolean }[];
    const mat = mats.find((m) => m.code === 'M016') ?? mats.find((m) => m.tracked && m.active)!;
    const po = (await (
      await page.request.post('/api/purchase-orders', {
        data: { clientKey: randomUUID(), supplierId: sups[0]!.id, orderDate: today, approveNow: true, lines: [{ materialId: mat.id, purchaseQtyMilli: 1000, priceCents: 100, spec: `E2E 规格${tag}`, imageIds: [img.id] }] },
      })
    ).json()) as { po: { id: number; docNo: string; status: string } };
    if (po.po.status === 'submitted') await page.request.post(`/api/purchase-orders/${po.po.id}/approve`, { data: {} });

    // 采购台账：当天逐笔看到打款与支出；导出 CSV
    await page.goto('/erp/ledger');
    const day = page.getByTestId(`ledger-day-${today}`);
    await expect(day).toContainText(adv.advance.docNo);
    await expect(day).toContainText(`E2E 台账物品${tag}`);
    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ledger-export').click()]);
    const csvText = (await import('node:fs')).readFileSync((await csv.path())!, 'utf8');
    expect(csvText).toContain(claim.claim.docNo);
    // 需求单也能在台账页导出（对账付款、成本核算、负责人进不了需求单页）
    const [reqCsv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ledger-requests-export').click()]);
    expect((await import('node:fs')).readFileSync((await reqCsv.path())!, 'utf8')).toContain('需求单号');

    // 账目自检：第 2 条列出这笔报销，点开能跳到报销单
    await page.goto('/erp/audit');
    const rule2 = page.getByTestId('audit-rule-2');
    await expect(rule2).toContainText('条');
    await rule2.getByRole('button').click();
    await rule2.getByRole('link', { name: new RegExp(claim.claim.docNo) }).click();
    await expect(page).toHaveURL(new RegExp(`/erp/expenses\\?claim=${claim.claim.id}`));
    await expect(page.getByTestId('claim-sheet')).toContainText(`E2E 台账物品${tag}`);

    // 下单物料：规格与缩略图；导出的 Excel 里嵌着图片
    await page.goto('/purchasing');
    await page.getByTestId('ordered-link').click();
    await expect(page.getByTestId('ordered-page')).toContainText(`E2E 规格${tag}`);
    const [xlsx] = await Promise.all([page.waitForEvent('download'), page.getByTestId('ordered-export-xlsx').click()]);
    const buf = (await import('node:fs')).readFileSync((await xlsx.path())!);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(buf.includes(Buffer.from('xl/media/image'))).toBe(true);
    expect(buf.includes(PNG)).toBe(true);
  });
});
