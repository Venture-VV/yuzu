// v0.7.29 ERP 采购五项的浏览器验收（docs/ERP_PURCHASING.md）：
//   ① 采购途径：编制采购单选途径，要写说明的没写拦下；采购单详情显示途径；
//   ② 采购单一键转报销：现付采购单出现在「待报销」，点转报销打开带好的登记页，提交后采购单上看得到报销单；
//   ③ 部门备用金台账：设定额，看板显示建议补足，点开部门看到逐笔与期末余额；
//   ④ 补货建议：低于提醒数量的物料按供应商分组，一键生成采购单草稿；
//   ⑤ 询价比价：新建询价单、两家报价、定标、转采购单；
//   v0.7.30：需求单转采购单到了询价门槛「改为询价」带上需求单，补货建议「发起询价」。
// 依赖演示数据（只在独立演示库）；账号：店主 linlan，密码 yuzu2026。会登记单据，只在门店电脑尺寸执行。
// 每次用新的供应商、物料编码，不改演示数据里已有的档案。
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

interface Me {
  calendarToday: string;
  staff: { id: number };
}

async function setup(page: Page) {
  await login(page, 'linlan');
  const me = (await (await page.request.get('/api/auth/me')).json()) as Me;
  const tag = String(Date.now()).slice(-6);
  return { me, today: me.calendarToday, tag };
}

async function newSupplier(page: Page, tag: string, body: Record<string, unknown> = {}) {
  // Z 开头：排在演示数据的 S001… 后面，别的用例按顺序取第一家供应商时不会取到这里新建的
  const code = `Z${tag}${Math.floor(Math.random() * 90 + 10)}`;
  const res = await page.request.post('/api/inventory/suppliers', { data: { code, name: `E2E 供应商${code}`, ...body } });
  expect(res.status(), await res.text()).toBe(201);
  const list = (await (await page.request.get('/api/inventory/suppliers')).json()) as { id: number; code: string; name: string }[];
  return list.find((s) => s.code === code)!;
}

async function newMaterial(page: Page, tag: string, body: Record<string, unknown> = {}) {
  const code = `ZM${tag}${Math.floor(Math.random() * 90 + 10)}`;
  const res = await page.request.post('/api/inventory/materials', {
    data: { code, name: `E2E 物料${code}`, category: 'E2E', inventoryUnit: '包', purchaseUnit: '箱', purchaseFactorMilli: 10_000, refPriceCents: 3_000, ...body },
  });
  expect(res.status(), await res.text()).toBe(201);
  const list = (await (await page.request.get('/api/inventory/materials?all=1')).json()) as { id: number; code: string; name: string }[];
  return list.find((m) => m.code === code)!;
}

async function firstDepartment(page: Page) {
  let depts = (await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[];
  if (depts.length === 0) {
    await page.request.post('/api/inventory/departments', { data: { name: '采购部' } });
    depts = (await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[];
  }
  return depts[0]!;
}

test.describe('ERP 采购五项（v0.7.29）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('① 采购途径（8.0.1 起固定三类：网购、自采、供应商）：编制采购单时选途径，网购没写店铺被拦；详情显示途径', async ({ page }) => {
    const { today, tag } = await setup(page);
    const sup = await newSupplier(page, tag, { defaultChannel: 'self' });
    const mat = await newMaterial(page, tag);

    await page.goto('/purchasing/new');
    await page.locator('#po-sup').selectOption(String(sup.id));
    // 按供应商的默认途径带出；选的是这家供应商的默认途径，说明选填
    await expect(page.getByTestId('po-channel')).toHaveValue('self');
    await expect(page.getByText('采购途径选了「自采（现采/零采）」，请写明在哪买的')).toHaveCount(0);
    // 只有三类可选
    await expect(page.getByTestId('po-channel').locator('option')).toHaveText(['网购', '自采（现采/零采）', '供应商']);
    await page.getByTestId('po-channel').selectOption('online');
    await expect(page.getByText('采购途径选了「网购」，请写明在哪买的')).toBeVisible();
    await page.getByTestId('po-channel-note').fill('某平台某某旗舰店');
    await expect(page.getByText('采购途径选了「网购」，请写明在哪买的')).toHaveCount(0);

    // 接口建一张带途径的采购单，详情里看得到
    const po = (await (
      await page.request.post('/api/purchase-orders', {
        data: { clientKey: randomUUID(), supplierId: sup.id, orderDate: today, approveNow: true, channel: 'self', channelNote: `E2E 门店${tag}`, lines: [{ materialId: mat.id, purchaseQtyMilli: 1000, priceCents: 3_000 }] },
      })
    ).json()) as { po: { id: number } };
    await page.goto(`/purchasing?po=${po.po.id}`);
    await expect(page.getByTestId('po-sheet-channel')).toHaveText(`自采（现采/零采） · E2E 门店${tag}`);
  });

  test('② 现付采购单一键转报销：待报销 → 带好的登记页 → 提交，采购单上看到报销单', async ({ page }) => {
    const { me, today, tag } = await setup(page);
    const sup = await newSupplier(page, tag, { settlement: 'cash' });
    const mat = await newMaterial(page, tag);
    const po = (await (
      await page.request.post('/api/purchase-orders', {
        data: { clientKey: randomUUID(), supplierId: sup.id, orderDate: today, approveNow: true, channel: 'online', channelNote: `E2E 网店${tag}`, lines: [{ materialId: mat.id, purchaseQtyMilli: 2000, priceCents: 3_000 }] },
      })
    ).json()) as { po: { id: number; docNo: string; status: string } };
    expect(po.po.status).toBe('approved');

    await page.goto('/erp/expenses');
    await expect(page.getByTestId(`to-claim-${po.po.id}`)).toContainText(po.po.docNo);
    await page.getByTestId(`to-claim-go-${po.po.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/erp/expenses/new\\?po=${po.po.id}`));
    // 带好的：经办人 = 采购单的编制人，采购途径照采购单
    await expect(page.getByTestId('claim-prefill-note')).toBeVisible();
    await expect(page.getByTestId('ex-handler')).toHaveValue(String(me.staff.id));
    await expect(page.getByTestId('ex-po-channel')).toHaveText(`网购 · E2E 网店${tag}`);
    if ((await page.getByTestId('ex-dept').inputValue()) === '') {
      const dept = await firstDepartment(page);
      await page.getByTestId('ex-dept').selectOption(String(dept.id));
    }
    if ((await page.getByTestId('ex-purpose').inputValue()) === '') await page.getByTestId('ex-purpose').selectOption('办公');
    if ((await page.getByTestId('ex-invoice').inputValue()) === '') await page.getByTestId('ex-invoice').selectOption('none');
    // 科目按这个物料上次报销的带出，没有的默认低值易耗
    await expect(page.getByRole('combobox', { name: `${mat.name} 费用科目` })).toHaveValue('low_value');
    await page.getByRole('textbox', { name: `${mat.name} 差异原因` }).fill('货还在路上');
    await page.getByTestId('claim-submit').click();
    await expect(page).toHaveURL(/\/erp\/expenses\?claim=\d+/);

    const after = (await (await page.request.get(`/api/purchase-orders/${po.po.id}`)).json()) as { reimbursement: { unclaimedLines: number; claims: { docNo: string }[] } };
    expect(after.reimbursement.unclaimedLines).toBe(0);
    await page.goto(`/purchasing?po=${po.po.id}`);
    await expect(page.getByTestId('po-reimbursement')).toContainText(after.reimbursement.claims[0]!.docNo);
  });

  test('③ 部门备用金台账：设定额，看板显示建议补足；点开部门看到逐笔与期末余额', async ({ page }) => {
    const { me, today, tag } = await setup(page);
    const name = `E2E部门${tag}`.slice(0, 16);
    expect((await page.request.post('/api/inventory/departments', { data: { name } })).ok()).toBe(true);
    const dept = ((await (await page.request.get('/api/inventory/departments')).json()) as { id: number; name: string }[]).find((d) => d.name === name)!;
    const adv = await page.request.post('/api/erp/petty/advances', {
      data: { clientKey: randomUUID(), departmentId: dept.id, handlerId: me.staff.id, advanceDate: today, amountCents: 50_000, method: 'wechat', evidence: `E2E 定额 ${tag}` },
    });
    expect(adv.status()).toBe(201);

    await page.goto('/erp/petty/accounts');
    await expect(page.getByTestId(`petty-account-${dept.id}`)).toBeVisible();
    await page.getByTestId(`petty-account-edit-${dept.id}`).click();
    await page.getByTestId('pa-limit').fill('2000');
    await page.getByTestId('petty-account-save').click();
    // 定额 ¥2,000 − 余额 ¥500 = 建议补足 ¥1,500
    await expect(page.getByTestId(`petty-topup-${dept.id}`)).toContainText('1,500');

    await page.getByTestId(`petty-account-${dept.id}`).getByRole('button').first().click();
    await expect(page.getByTestId('petty-journal')).toBeVisible();
    await expect(page.getByTestId('journal-closing')).toContainText('500');
    await expect(page.getByTestId('journal-summary')).toContainText('500');
  });

  test('④ 补货建议：低于提醒数量的物料按供应商分组，一键生成采购单草稿', async ({ page }) => {
    const { tag } = await setup(page);
    const sup = await newSupplier(page, tag);
    // 结存 0、提醒数量 25 包、每箱 10 包 → 建议 3 箱
    const mat = await newMaterial(page, tag, { defaultSupplierId: sup.id, lowStockMilli: 25_000 });

    await page.goto('/purchasing/suggestions');
    const group = page.getByTestId(`suggest-group-${sup.id}`);
    await expect(group).toBeVisible();
    await expect(group.getByTestId(`suggest-qty-${mat.id}`)).toHaveValue('3');
    await group.getByTestId('suggest-create').click();
    await expect(page).toHaveURL(/\/purchasing\/\d+\/edit/);
    const poId = Number(/\/purchasing\/(\d+)\/edit/.exec(page.url())![1]);
    const po = (await (await page.request.get(`/api/purchase-orders/${poId}`)).json()) as { status: string; note: string; supplier: { id: number }; lines: { materialId: number; purchaseQtyMilli: number }[] };
    expect(po).toMatchObject({ status: 'draft', note: '补货建议生成', supplier: { id: sup.id } });
    expect(po.lines).toEqual([expect.objectContaining({ materialId: mat.id, purchaseQtyMilli: 3000 })]);
    // 草稿算在途：这个物料不再建议
    await page.goto('/purchasing/suggestions');
    await expect(page.getByTestId('suggestions-page')).toBeVisible();
    await expect(page.getByTestId(`suggest-line-${mat.id}`)).toHaveCount(0);
  });

  test('⑤ 询价比价：新建询价单、两家报价、定标、转采购单', async ({ page }) => {
    const { tag } = await setup(page);
    const a = await newSupplier(page, tag);
    const b = await newSupplier(page, `${tag}b`);
    const mat = await newMaterial(page, tag);

    await page.goto('/purchasing/sourcing');
    await page.getByTestId('sourcing-new').click();
    await page.getByTestId('sc-title').fill(`E2E 询价 ${tag}`);
    await page.getByPlaceholder('搜索物料：编码 / 名称，回车加入').fill(mat.code);
    await page.getByPlaceholder('搜索物料：编码 / 名称，回车加入').press('Enter');
    await page.getByTestId('sc-qty-0').fill('20');
    await page.getByTestId('sourcing-create').click();
    await expect(page).toHaveURL(/\/purchasing\/sourcing\/\d+$/);
    const eventId = Number(/\/sourcing\/(\d+)$/.exec(page.url())![1]);
    const ev = (await (await page.request.get(`/api/purchase-sourcing/${eventId}`)).json()) as { lines: { id: number }[] };
    const lineId = ev.lines[0]!.id;

    const quote = async (supplierId: number, price: string, terms: string) => {
      await page.getByTestId('quote-new').click();
      await page.getByTestId('qt-supplier').selectOption(String(supplierId));
      await page.getByTestId(`qt-price-${lineId}`).fill(price);
      await page.getByTestId('qt-terms').fill(terms);
      await page.getByTestId('quote-save').click();
      await expect(page.getByTestId('quote-save')).toHaveCount(0);
    };
    await quote(a.id, '29', '月结 30 天');
    await quote(b.id, '31', '现付');
    // 比价表：两家，甲综合到价更低
    const compare = page.getByTestId('sourcing-compare');
    await expect(compare).toContainText(a.name);
    await expect(compare).toContainText(b.name);

    await page.getByTestId('award-open').click();
    await page.getByTestId('award-reason').fill('综合到价最低，月结');
    await page.getByTestId('award-save').click();
    await expect(page.getByTestId('sourcing-awarded')).toContainText(a.name);
    await page.getByTestId('sourcing-order').click();
    await expect(page).toHaveURL(/\/purchasing\/\d+\/edit/);
    const poId = Number(/\/purchasing\/(\d+)\/edit/.exec(page.url())![1]);
    const po = (await (await page.request.get(`/api/purchase-orders/${poId}`)).json()) as { status: string; supplier: { id: number }; sourcing: { id: number } | null; totalCents: number };
    expect(po).toMatchObject({ status: 'draft', supplier: { id: a.id }, sourcing: { id: eventId }, totalCents: 58_000 });
  });
});

// v0.7.30：询价接上需求单与补货建议（v0.7.29 的已知问题）
test.describe('询价接上需求单与补货建议（v0.7.30）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('需求单转采购单到了询价门槛：「改为询价」带上需求单；询价单上看得到来自哪张需求单，需求单显示询价中', async ({ page }) => {
    const { tag } = await setup(page);
    const dept = await firstDepartment(page);
    const mat = await newMaterial(page, tag); // 参考价 ¥30/箱
    const rules = (await (await page.request.get('/api/inventory/purchase-rules')).json()) as { quoteThresholdCents: number };
    const boxes = Math.max(2, Math.ceil(rules.quoteThresholdCents / 3_000) + 1);
    const made = await page.request.post('/api/erp/requests', {
      data: { clientKey: randomUUID(), departmentId: dept.id, lines: [{ materialId: mat.id, name: mat.name, purpose: '客用消耗', qtyMilli: boxes * 1000, unit: '箱' }] },
    });
    expect(made.status(), await made.text()).toBe(201);
    const request = (await made.json()).request as { id: number; docNo: string; lines: { id: number }[] };
    expect((await page.request.post(`/api/erp/requests/${request.id}/approve`, { data: {} })).ok()).toBe(true);

    await page.goto(`/purchasing/new?requestLines=${request.lines[0]!.id}`);
    await expect(page.getByTestId('po-from-requests')).toContainText('来自需求单');
    if (rules.quoteThresholdCents > 0) await expect(page.getByTestId('po-over-quote')).toBeVisible();
    await page.getByTestId('po-to-sourcing').click();
    await expect(page.getByTestId('sc-title')).toHaveValue(mat.name);
    await expect(page.getByText(`来自需求单 ${request.docNo}`)).toBeVisible();
    await page.getByTestId('sourcing-create').click();
    await expect(page).toHaveURL(/\/purchasing\/sourcing\/\d+$/);
    await expect(page.getByTestId('sourcing-line-requests-1')).toContainText(request.docNo);
    const eventId = Number(/\/sourcing\/(\d+)$/.exec(page.url())![1]);
    const detail = (await (await page.request.get(`/api/erp/requests/${request.id}`)).json()) as { lines: { progress: { state: string; sourcing: { id: number } | null } }[] };
    expect(detail.lines[0]!.progress).toMatchObject({ state: 'sourcing', sourcing: { id: eventId } });
  });

  test('补货建议「发起询价」：建好的询价单算在途，这个物料不再建议', async ({ page }) => {
    const { tag } = await setup(page);
    const sup = await newSupplier(page, tag);
    const mat = await newMaterial(page, tag, { defaultSupplierId: sup.id, lowStockMilli: 25_000 });

    await page.goto('/purchasing/suggestions');
    const group = page.getByTestId(`suggest-group-${sup.id}`);
    await expect(group.getByTestId(`suggest-qty-${mat.id}`)).toHaveValue('3');
    await group.getByTestId('suggest-sourcing').click();
    await expect(page.getByTestId('sc-qty-0')).toHaveValue('3');
    await page.getByTestId('sourcing-create').click();
    await expect(page).toHaveURL(/\/purchasing\/sourcing\/\d+$/);
    await page.goto('/purchasing/suggestions');
    await expect(page.getByTestId('suggestions-page')).toBeVisible();
    await expect(page.getByTestId(`suggest-line-${mat.id}`)).toHaveCount(0);
  });
});

// 补货方式（店主 2026-11-14，迁移 161，docs/ERP_PURCHASING.md 第 5.1 节）：手机这类不是消耗品的不提补货
test.describe('补货方式（迁移 161）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改物料档案的流程只在门店电脑尺寸执行一次');

  const materialOf = async (page: Page, id: number) =>
    (await (await page.request.get(`/api/inventory/materials/${id}`)).json()) as { replenishMode: string; isLow: boolean };

  test('建议行点「不用备货」→ 进「没提补货的」并写着原因；改回自动识别又回来；物料档案里能直接定', async ({ page }) => {
    const { tag } = await setup(page);
    const sup = await newSupplier(page, tag);
    // 结存 0、提醒数量 25 包：设了提醒数量的算常备，会提
    const mat = await newMaterial(page, tag, { defaultSupplierId: sup.id, lowStockMilli: 25_000 });
    expect(await materialOf(page, mat.id)).toMatchObject({ replenishMode: 'auto', isLow: true });

    await page.goto('/purchasing/suggestions');
    const group = page.getByTestId(`suggest-group-${sup.id}`);
    await expect(group.getByTestId(`suggest-line-${mat.id}`)).toBeVisible();
    await group.getByTestId(`suggest-off-${mat.id}`).click();
    // 不再建议，列到「没提补货的」里，原因写清楚；低库存提醒也不标了
    await expect(page.getByTestId(`suggest-line-${mat.id}`)).toHaveCount(0);
    const skipped = page.getByTestId('suggest-skipped');
    await skipped.getByTestId('suggest-skipped-toggle').click();
    await expect(skipped.getByTestId(`suggest-skip-${mat.id}`)).toContainText('定了按需采购');
    expect(await materialOf(page, mat.id)).toMatchObject({ replenishMode: 'on_demand', isLow: false });

    // 改回自动识别：又提了
    await skipped.getByTestId(`suggest-skip-auto-${mat.id}`).click();
    await expect(page.getByTestId(`suggest-line-${mat.id}`)).toBeVisible();
    expect(await materialOf(page, mat.id)).toMatchObject({ replenishMode: 'auto', isLow: true });

    // 物料档案里直接定：选「按需采购」，两个提醒不能填
    await page.goto('/inventory/master');
    await page.getByLabel('搜索物料档案').fill(mat.code);
    await page.getByRole('cell', { name: mat.code, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: new RegExp(`编辑物料 · ${mat.name}`) });
    const modes = dialog.getByRole('radiogroup', { name: '补货方式' });
    await expect(modes.getByRole('radio', { name: '自动识别' })).toBeChecked();
    await modes.getByRole('radio', { name: '按需采购' }).click();
    await expect(dialog.locator('#m-low')).toBeDisabled();
    await expect(dialog.locator('#m-cover')).toBeDisabled();
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();
    expect(await materialOf(page, mat.id)).toMatchObject({ replenishMode: 'on_demand', isLow: false });
    await expect(page.getByRole('row', { name: new RegExp(mat.code) })).toContainText('按需采购');
    await page.goto('/purchasing/suggestions');
    await expect(page.getByTestId('suggestions-page')).toBeVisible();
    await expect(page.getByTestId(`suggest-line-${mat.id}`)).toHaveCount(0);
  });

  test('点一行的「不用备货」不冲掉同组别的行改好的数量和去掉的勾；断网时留「结果待确认」、只能原样再试（合并前 Codex 审查 e3cfbd0）', async ({ page }) => {
    const { tag } = await setup(page);
    const sup = await newSupplier(page, tag);
    // 同一家供应商下三样：都低于提醒数量（建议各 3 箱）
    const a = await newMaterial(page, tag, { defaultSupplierId: sup.id, lowStockMilli: 25_000 });
    const b = await newMaterial(page, tag, { defaultSupplierId: sup.id, lowStockMilli: 25_000 });
    const c = await newMaterial(page, tag, { defaultSupplierId: sup.id, lowStockMilli: 25_000 });

    await page.goto('/purchasing/suggestions');
    const group = page.getByTestId(`suggest-group-${sup.id}`);
    await expect(group.getByTestId(`suggest-qty-${a.id}`)).toHaveValue('3');
    // 采购把 A 改成 5 箱、把 B 的勾去掉
    await group.getByTestId(`suggest-qty-${a.id}`).fill('5');
    await group.getByRole('checkbox', { name: `补 ${b.name}` }).uncheck();

    // 第一次点 C 的「不用备货」时断网：不知道改没改成，留一条「结果待确认」，别的先不能改
    let dropped = 0;
    await page.route('**/api/inventory/materials/*/replenish-mode', async (route) => {
      if (dropped++ === 0) await route.abort('connectionfailed');
      else await route.continue();
    });
    await group.getByTestId(`suggest-off-${c.id}`).click();
    const pending = page.getByTestId('mode-pending');
    await expect(pending).toContainText(c.name);
    await expect(pending).toContainText('按需采购');
    await expect(group.getByTestId(`suggest-off-${a.id}`)).toBeDisabled();
    expect(await materialOf(page, c.id)).toMatchObject({ replenishMode: 'auto' });
    // 这一条存在本机：没有结论之前一直在（这里不刷新页面，下一条用例核对刷新以后还在）
    expect(await page.evaluate(() => localStorage.getItem('yuzu.replenishModePending.v1'))).toContain(`"materialId":${c.id}`);
    // 再试一次：按原样重提，改成了
    await page.getByTestId('mode-pending-retry').click();
    await expect(pending).toHaveCount(0);
    await expect(page.getByTestId(`suggest-line-${c.id}`)).toHaveCount(0);
    expect(await materialOf(page, c.id)).toMatchObject({ replenishMode: 'on_demand' });
    expect(await page.evaluate(() => localStorage.getItem('yuzu.replenishModePending.v1'))).toBeNull();

    // 建议刷新以后：A 还是 5 箱，B 还是没勾
    await expect(group.getByTestId(`suggest-qty-${a.id}`)).toHaveValue('5');
    await expect(group.getByRole('checkbox', { name: `补 ${b.name}` })).not.toBeChecked();
    await expect(group.getByTestId(`suggest-off-${a.id}`)).toBeEnabled();
    // 生成的草稿只有 A 的 5 箱
    await group.getByTestId('suggest-create').click();
    await expect(page).toHaveURL(/\/purchasing\/\d+\/edit/);
    const poId = Number(/\/purchasing\/(\d+)\/edit/.exec(page.url())![1]);
    const po = (await (await page.request.get(`/api/purchase-orders/${poId}`)).json()) as { lines: { materialId: number; purchaseQtyMilli: number }[] };
    expect(po.lines).toEqual([expect.objectContaining({ materialId: a.id, purchaseQtyMilli: 5000 })]);
  });

  test('结果待确认刷新以后还在；这之后补货方式改走又改回，旧请求晚到也不会生效（测试会话在 44ddeb5 上复验的边界）', async ({ page }) => {
    const { tag } = await setup(page);
    const sup = await newSupplier(page, tag);
    const mat = await newMaterial(page, tag, { defaultSupplierId: sup.id, lowStockMilli: 25_000 });
    const full = { code: mat.code, name: mat.name, category: 'E2E', inventoryUnit: '包', purchaseUnit: '箱', purchaseFactorMilli: 10_000, refPriceCents: 3_000, defaultSupplierId: sup.id, lowStockMilli: 25_000 };

    await page.goto('/purchasing/suggestions');
    const group = page.getByTestId(`suggest-group-${sup.id}`);
    await expect(group.getByTestId(`suggest-line-${mat.id}`)).toBeVisible();
    // 点「不用备货」时网关回 504：请求体记下来，当它还在路上
    let captured: string | null = null;
    await page.route('**/api/inventory/materials/*/replenish-mode', async (route) => {
      captured = route.request().postData();
      await route.fulfill({ status: 504, contentType: 'text/plain', body: 'gateway timeout' });
    });
    await group.getByTestId(`suggest-off-${mat.id}`).click();
    const pending = page.getByTestId('mode-pending');
    await expect(pending).toContainText(mat.name);
    expect(JSON.parse(captured!)).toEqual({ mode: 'on_demand', expectedRev: 0 });
    await page.unroute('**/api/inventory/materials/*/replenish-mode');

    // 刷新页面：这一条还在，补货方式还是不能改
    await page.reload();
    await expect(pending).toContainText(mat.name);
    await expect(page.getByTestId(`suggest-off-${mat.id}`)).toBeDisabled();

    // 这期间在物料档案里把补货方式改成常备、又改回自动识别（值和当时看到的一样，版本号变了）
    for (const replenishMode of ['stock', 'auto']) {
      const r = await page.request.put(`/api/inventory/materials/${mat.id}`, { data: { ...full, replenishMode } });
      expect(r.status(), await r.text()).toBe(200);
    }
    // 回到补货建议：读回来版本号变了 → 有结论了（那次修改不会再生效），待确认消失，可以再改
    await page.reload();
    await expect(pending).toHaveCount(0);
    await expect(page.getByTestId(`suggest-off-${mat.id}`)).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('yuzu.replenishModePending.v1'))).toBeNull();
    // 旧请求这时才到：被拒绝，还是自动识别
    const late = await page.request.put(`/api/inventory/materials/${mat.id}/replenish-mode`, { data: JSON.parse(captured!) });
    expect(late.status()).toBe(409);
    expect((await late.json()).error.code).toBe('REPLENISH_MODE_CHANGED');
    expect(await materialOf(page, mat.id)).toMatchObject({ replenishMode: 'auto' });
  });
});
