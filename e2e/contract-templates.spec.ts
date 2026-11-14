// 8.0.21 浏览器验收：合同模板与导出（docs/FINANCE_V8021.md 第 6 节，CW-E）。可重复执行（模板名带这一次的时间）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · ERP → 合同 →「合同模板」新建一份（正文带 {{相对方}}、{{服务区域}}、{{付款节点}}，一个必填字段、一条可选条款）；
//   · 用它起草一份服务合同（接口）→ 编辑页里看得到模板一节、字段值；
//   · 合同详情「打印 / PDF」：正文按模板排好、付款节点是表格；「导出 Word」下载得到 .docx。
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

test.describe('8.0.21 合同模板', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('新建模板 → 用模板起草 → 编辑页看得到模板 → 打印页按模板排版、导出 Word', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    await page.goto('/erp/contracts');
    await page.getByTestId('doc-templates-open').click();
    await page.getByTestId('doc-template-new').click();
    await page.getByTestId('dt-name').fill(`验收保洁模板${stamp}`);
    await page.locator('#dt-cat').selectOption('service');
    await page.getByTestId('dt-body').fill(`# 第一条 服务内容\n\n乙方 {{相对方}} 负责 {{服务区域}} 的日常保洁（验收${stamp}）。\n\n{{付款节点}}`);
    await page.getByRole('button', { name: '加一个' }).click();
    await page.getByLabel('字段 1 名').fill('服务区域');
    await page.getByRole('checkbox', { name: '必填' }).check();
    await page.getByRole('button', { name: '加一条' }).click();
    await page.getByLabel('条款 1 标题').fill('保密');
    await page.getByLabel('条款 1 内容').fill('双方对合同价格保密');
    await page.getByTestId('doc-template-save').click();
    await expect(page.getByText('模板已建好')).toBeVisible();
    await expect(page.getByTestId('doc-templates')).toContainText(`验收保洁模板${stamp}`);
    await page.keyboard.press('Escape');

    const templates = (await (await page.request.get('/api/erp/contracts/doc-templates')).json()) as { id: number; name: string }[];
    const t = templates.find((x) => x.name === `验收保洁模板${stamp}`)!;
    const created = await page.request.post('/api/erp/contracts', {
      data: {
        clientKey: randomUUID(),
        category: 'service',
        supplierId: null,
        counterparty: `验收保洁公司${stamp}`,
        content: {
          title: `保洁服务合同${stamp}`,
          startDate: null,
          endDate: null,
          totalCents: 360_000,
          taxRateBp: 600,
          freightBearer: 'na',
          unloadingBearer: 'na',
          paymentTerms: [
            { stage: 'prepay', percentBp: 0, condition: '' },
            { stage: 'delivery', percentBp: 0, condition: '' },
            { stage: 'acceptance', percentBp: 10000, condition: '每月验收后' },
            { stage: 'warranty', percentBp: 0, condition: '' },
          ],
          warranty: { basis: 'acceptance', months: 0 },
          acceptance: { method: '按月检查', signer: '前厅经理', penalty: '', templateName: '', items: [] },
          note: '',
          lines: [],
          template: { id: t.id, values: { 服务区域: '更衣室与大堂' }, clauses: [] },
        },
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const c = (await created.json()).contract as { id: number; contractNo: string };

    // 编辑页：模板一节选着这份、字段值在
    await page.goto(`/erp/contracts/${c.id}/edit`);
    const section = page.getByTestId('contract-template-section');
    await expect(section.getByTestId('ct-template')).toHaveValue(String(t.id));
    await expect(section.getByTestId('ct-field-服务区域')).toHaveValue('更衣室与大堂');

    // 打印页
    await page.goto(`/print/contract/${c.id}`);
    const doc = page.getByTestId('print-contract');
    await expect(doc).toContainText(`乙方 验收保洁公司${stamp} 负责 更衣室与大堂 的日常保洁（验收${stamp}）`);
    await expect(doc).toContainText(`合同编号 ${c.contractNo} · 草稿`);
    await expect(doc.locator('table')).toContainText('每月验收后');

    // 导出 Word
    await page.goto(`/erp/contracts/${c.id}`);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('contract-export-docx').click()]);
    const file = await readFile((await download.path())!);
    expect(file.subarray(0, 2).toString('latin1')).toBe('PK'); // .docx 是 zip
    // 文件名在响应头里（无头浏览器的 suggestedFilename 不一定认 filename*）
    const head = await page.request.get(`/api/erp/contracts/${c.id}/document.docx`);
    expect(decodeURIComponent(head.headers()['content-disposition'] ?? '')).toContain(`合同-${c.contractNo}-草稿.docx`);
  });
});
