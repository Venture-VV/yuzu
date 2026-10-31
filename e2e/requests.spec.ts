// v0.7.8 浏览器验收（飞书需求 RQ-005 第二步，见 docs/REQUISITIONS.md）：
//   ① 店主替部门提需求单（新产品带链接与图片 + 已有物料）→ 采购通过 → 待转采购单里勾选 → 转采购单：
//      已有物料直接带入（数量换成采购单位），新产品在采购单里新建物料（名称、规格带过来）→ 提交采购单
//      → 需求单每一行显示「已下单」与采购单号；采购单详情显示对应的需求单；自检全部通过。
//   ② 报销登记断网（v0.7.7 审查修正）：响应丢了 → 进页面自动查回、只登记一次；请求没发出去 → 刷新后仍显示
//      「结果待确认」，按原内容重新提交只登记一次。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。只在门店电脑尺寸执行。
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

async function department(page: Page) {
  let depts = (await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[];
  if (depts.length === 0) {
    await page.request.post('/api/inventory/departments', { data: { name: '采购部' } });
    depts = (await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[];
  }
  return depts[0]!;
}

test.describe('部门采购需求单', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('提需求 → 采购通过 → 勾选转采购单（新产品新建物料）→ 需求单显示已下单', async ({ page }) => {
    await login(page, 'linlan');
    const dept = await department(page);
    const meta = (await (await page.request.get('/api/erp/requests/meta')).json()) as { materials: { id: number; code: string }[]; purposes: string[] };
    const sheetMat = meta.materials.find((m) => m.code === 'M016')!; // 一次性护理床单，1 箱 = 500 张
    const tag = String(Date.now()).slice(-6);
    const newName = `E2E 香薰石${tag}`;

    await page.goto('/erp/requests/new');
    await expect(page.getByTestId('request-form')).toBeVisible();
    await page.getByTestId('rq-dept').selectOption(String(dept.id));
    // 第 1 行：新产品（要链接和图片）
    await page.getByTestId('rq-name-0').fill(newName);
    await page.getByTestId('rq-purpose-0').selectOption('客用消耗');
    await page.getByTestId('rq-qty-0').fill('10');
    await page.getByTestId('rq-unit-0').fill('个');
    await expect(page.getByTestId('rq-submit')).toBeDisabled();
    await page.getByTestId('rq-link-0').fill('https://example.com/e2e-item');
    await page.getByTestId('rq-images-0-input').setInputFiles({ name: 'item.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByLabel('删除图片 1')).toBeVisible();
    // 第 2 行：已有物料，单位默认带采购单位
    await page.getByTestId('rq-add-line').click();
    await page.getByTestId('rq-line-1').getByRole('radio', { name: '已有物料' }).click();
    await page.getByTestId('rq-material-1').selectOption(String(sheetMat.id));
    await expect(page.getByTestId('rq-unit-1')).toHaveValue('箱');
    await page.getByTestId('rq-purpose-1').selectOption('客用消耗');
    await page.getByTestId('rq-qty-1').fill('2');
    await page.getByTestId('rq-submit').click();

    await expect(page).toHaveURL(/\/erp\/requests\?request=\d+/);
    const requestId = Number(new URL(page.url()).searchParams.get('request'));
    const sheet = page.getByTestId('request-sheet');
    await expect(sheet).toContainText('待审核');
    await expect(sheet).toContainText(newName);
    await page.getByTestId('request-approve').click();
    await expect(sheet).toContainText('已通过');

    // 待转采购单：勾选这张需求单的两行
    const request = (await (await page.request.get(`/api/erp/requests/${requestId}`)).json()) as { docNo: string; lines: { id: number }[] };
    await page.goto('/erp/requests?view=open');
    for (const l of request.lines) await page.getByTestId(`open-line-${l.id}`).check();
    await page.getByTestId('open-lines-to-po').click();
    await expect(page).toHaveURL(/\/purchasing\/new\?requestLines=/);
    await expect(page.getByTestId('po-from-requests')).toContainText('来自需求单');

    // 已有物料的行直接带入（2 箱）；新产品先新建物料（名称、单位带过来）
    const newLineId = request.lines[0]!.id;
    await page.getByTestId(`po-unmatched-create-${newLineId}`).click();
    await expect(page.locator('#m-name')).toHaveValue(newName);
    await page.locator('#m-code').fill(`E${tag}`);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByTestId(`po-unmatched-${newLineId}`)).toHaveCount(0);
    await expect(page.getByTestId('po-line-requests')).toHaveCount(2);

    await page.locator('#po-sup').selectOption({ index: 1 });
    await page.getByLabel('单价（元/个）').fill('15');
    const priceBox = page.getByLabel('单价（元/箱）');
    if ((await priceBox.inputValue()) === '') await priceBox.fill('450');
    await page.getByRole('button', { name: /^提交(确认)?$/ }).click();

    await expect(page).toHaveURL(/\/purchasing\?po=\d+/);
    await expect(page.getByText(request.docNo).first()).toBeVisible();

    // 需求单：两行都已下单
    await page.goto(`/erp/requests?request=${requestId}`);
    await expect(page.getByTestId('request-line-1')).toContainText('已下单');
    await expect(page.getByTestId('request-line-2')).toContainText('已下单');

    for (const url of ['/api/erp/requests/checks', '/api/inventory/checks']) {
      const checks = (await (await page.request.get(url)).json()) as { label: string; ok: boolean }[];
      for (const c of checks) expect(c.ok, c.label).toBe(true);
    }
  });

  test('报销登记断网：响应丢了自动查回只登记一次；请求没发出去，刷新后按原内容重新提交只登记一次', async ({ page }) => {
    await login(page, 'linlan');
    const dept = await department(page);
    const { calendarToday } = (await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string };
    const count = async (name: string) => {
      const list = (await (await page.request.get(`/api/erp/expenses?from=${calendarToday}&to=${calendarToday}`)).json()) as { claims: { summary: string }[] };
      return list.claims.filter((c) => c.summary.includes(name)).length;
    };
    const fill = async (name: string) => {
      await page.goto('/erp/expenses/new');
      await expect(page.getByTestId('claim-form')).toBeVisible();
      await page.getByTestId('ex-dept').selectOption(String(dept.id));
      await page.getByTestId('ex-purpose').selectOption('办公');
      await page.getByTestId('ex-invoice').selectOption({ label: '无票' });
      await page.getByTestId('line-name-0').fill(name);
      await page.getByTestId('line-cat-0').selectOption('office');
      await page.getByTestId('line-unit-0').fill('包');
      await page.getByTestId('line-amount-0').fill('12');
    };
    const isPost = (url: URL) => url.pathname === '/api/erp/expenses';

    // ① 服务器已登记、响应丢了：页面记下待确认，马上查回，跳到这张报销单
    const lost = `E2E 响应丢失${String(Date.now()).slice(-5)}`;
    await fill(lost);
    await page.route(isPost, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      await route.abort('internetdisconnected');
    });
    await page.getByTestId('claim-submit').click();
    await expect(page).toHaveURL(/\/erp\/expenses\?claim=\d+/, { timeout: 15_000 });
    await page.unroute(isPost);
    expect(await count(lost)).toBe(1);

    // ② 请求没发出去：刷新后仍显示「结果待确认」，按原内容重新提交只登记一次
    const offline = `E2E 断网${String(Date.now()).slice(-5)}`;
    await fill(offline);
    await page.route(isPost, (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
    await page.getByTestId('claim-submit').click();
    await expect(page.getByTestId('erp-pending')).toContainText('费用报销结果待确认');
    await page.unroute(isPost);
    await page.reload();
    await expect(page.getByTestId('erp-pending')).toContainText(offline);
    await expect(page.getByTestId('claim-submit')).toBeDisabled();
    await page.getByTestId('erp-pending-resend').click();
    await expect(page).toHaveURL(/\/erp\/expenses\?claim=\d+/);
    await expect(page.getByTestId('claim-sheet')).toContainText(offline);
    await expect(page.getByTestId('erp-pending')).toHaveCount(0);
    expect(await count(offline)).toBe(1);
  });
});
