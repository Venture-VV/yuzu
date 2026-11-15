// 8.0.21 浏览器验收：发票识别（docs/FINANCE_V8021.md 第 2 节，CW-A / CW1）。可重复执行（号码带这一次的时间）。
// 依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · ERP → 发票台账 → 登记发票 → 「拍照 / 选文件识别」选一张合成的发票图（左上角是增值税发票的二维码）：
//     号码、开票日、发票类型、价税合计带出来并标「识别」；不勾「已核对」不能登记；勾了登记，台账那一行标「二维码识别」。
// 识别全在浏览器本机做（无头 Chromium 没有 BarcodeDetector，走的是 jsQR）。
import { expect, test, type Page } from '@playwright/test';
import { encode } from 'uqr';

const PASSWORD = 'yuzu2026';
const stamp = String(Date.now()).slice(-8);

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

/** 一张合成的「发票」：白底，左上角一个二维码，旁边几行字（PNG） */
async function invoicePng(page: Page, qrText: string): Promise<Buffer> {
  const qr = encode(qrText, { ecc: 'M', border: 4 });
  const dataUrl = await page.evaluate(
    ({ data }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1400;
      canvas.height = 900;
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      const scale = 5;
      g.fillStyle = '#000';
      data.forEach((row, y) => row.forEach((on, x) => on && g.fillRect(40 + x * scale, 40 + y * scale, scale, scale)));
      g.font = '28px sans-serif';
      g.fillText('增值税普通发票（合成样例）', 500, 80);
      g.fillText('价税合计 ¥ 106.00', 500, 600);
      return canvas.toDataURL('image/png');
    },
    { data: qr.data },
  );
  return Buffer.from(dataUrl.split(',')[1]!, 'base64');
}

test.describe('8.0.21 发票识别', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('拍照 / 选文件识别：二维码带出号码、日期、类型、金额，标「识别」，核对后才能登记，台账标「二维码识别」', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const today = ((await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string }).calendarToday;
    const no = `8${stamp}`.slice(0, 8);
    // 普票（04），不含税 100.00；开票日今天
    const png = await invoicePng(page, `01,04,4400261130,${no},100.00,${today.replace(/-/g, '')},12345678901234567890,A1B2`);

    await page.goto('/erp/invoices');
    await page.getByTestId('invoice-new').click();
    const dialog = page.getByTestId('invoice-create');
    await dialog.getByTestId('invoice-scan-file').setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: png });
    await expect(dialog.getByTestId('inv-no')).toHaveValue(no, { timeout: 30_000 });
    await expect(dialog.getByTestId('inv-date')).toHaveValue(today);
    await expect(dialog.getByTestId('inv-kind')).toHaveValue('vat_normal');
    await expect(dialog.getByTestId('invoice-recognition')).toContainText('二维码识别');
    // 普票有好几档税率：选了 6% 才按不含税金额算出价税合计
    await expect(dialog.getByTestId('inv-total')).toHaveValue('');
    await dialog.getByTestId('inv-rate').selectOption('600');
    await expect(dialog.getByTestId('inv-total')).toHaveValue('106');
    await dialog.getByTestId('inv-issuer').fill(`识别验收${stamp}`);
    // 没勾「已核对」不能登记
    await expect(page.getByTestId('invoice-create-submit')).toBeDisabled();
    await expect(page.getByText('请对照票面核对识别出来的内容并勾选')).toBeVisible();
    await dialog.getByText('已对照票面核对过识别出来的内容').click();
    await page.getByTestId('invoice-create-submit').click();
    await expect(page.getByTestId('invoice-sheet')).toContainText(`识别验收${stamp}`);
    await page.keyboard.press('Escape');
    await page.getByTestId('invoice-search').fill(no);
    await expect(page.getByTestId(`invoice-row-${no}`)).toContainText('二维码识别');
    await expect(page.getByTestId('invoice-recognized-count')).toContainText('张是拍照 / 文件识别登记的');
  });
});
