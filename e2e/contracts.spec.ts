// v0.7.31 合同与法务审查的浏览器验收（docs/CONTRACTS.md）：
//   ① 店主在 ERP「合同」起草一份采购合同（四要素按模板、单价表一行），保存并提交审查；
//   ② 审查链 财务 → 法务 → 负责人：店主在合同详情审第 1 级；法务（新建的「法务」职责账号）在手机尺寸的审批中心按审查清单逐条给结论
//      （不能勾选批量；有「要修改」不能同意，「风险提示」要写意见）；店主审第 3 级，合同「审批通过（待签署）」；
//   ③ 登记签署、用印申请（店主批；回复丢了时页面上方「结果待确认」，查回之前不能另起一条）、上传扫描件、归档，拿到归档号；
//      开一张降价的变更单并提交：合同详情里审查中的变更单展开变更后的内容，总价标「−」；撤回、作废后接着往下；
//   ④ 结束日在 60 天内：台账顶部「到期提醒」、导航「合同」上的数字，点「续签」照原合同预填；
//   ⑤ 采购单选这份合同：逐行显示合同价与剩余量，超价、超量标出来，要写原因；存草稿后详情里看到合同与超出原因。
// 依赖演示数据（只在独立演示库）；账号：店主 linlan，密码 yuzu2026。会登记单据，只在门店电脑尺寸执行。
// 每次用新的供应商、物料编码与员工账号，不改演示数据里已有的档案。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_PAYMENT_TERMS } from '../src/shared/contracts';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

async function logout(page: Page) {
  await page.request.post('/api/auth/logout');
  await page.context().clearCookies();
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface ContractApi {
  id: number;
  contractNo: string;
  status: string;
  version: number;
  archiveNo: string | null;
  seals: { id: number; sealNo: string; status: string }[];
  files: { id: number }[];
  changes: { id: number; changeNo: string; status: string; version: number }[];
}

test.describe('合同与法务审查（v0.7.31）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会登记单据的流程只在门店电脑尺寸执行一次');

  test('起草 → 财务、法务（审查清单）、负责人三级审查 → 签署、用印、扫描件、归档 → 到期提醒与续签 → 采购单挂合同核对', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, 'linlan');
    const me = (await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string };
    const today = me.calendarToday;
    const tag = String(Date.now()).slice(-6);
    // Z 开头：排在演示数据的 S001… 后面，别的用例按顺序取第一家供应商时不会取到这里新建的
    const supCode = `Z${tag}${Math.floor(Math.random() * 90 + 10)}`;
    expect((await page.request.post('/api/inventory/suppliers', { data: { code: supCode, name: `E2E 合同供应商${supCode}` } })).status()).toBe(201);
    const supplier = ((await (await page.request.get('/api/inventory/suppliers')).json()) as { id: number; code: string; name: string }[]).find((s) => s.code === supCode)!;
    const matCode = `ZM${tag}${Math.floor(Math.random() * 90 + 10)}`;
    const mres = await page.request.post('/api/inventory/materials', {
      data: { code: matCode, name: `E2E 合同物料${matCode}`, category: 'E2E', inventoryUnit: '包', purchaseUnit: '箱', purchaseFactorMilli: 10_000, refPriceCents: 5_000 },
    });
    expect(mres.status(), await mres.text()).toBe(201);
    const material = ((await (await page.request.get('/api/inventory/materials?all=1')).json()) as { id: number; code: string; name: string }[]).find((m) => m.code === matCode)!;
    // 法务：新建一个只有「法务」职责的账号（第一次登录先改密码）
    const lawyer = `legal${tag}`;
    const lawyerPassword = `Legal-${tag}x`;
    const staff = await page.request.post('/api/staff', { data: { username: lawyer, displayName: `法务${tag}`, role: 'backoffice', duties: ['legal'], password: lawyerPassword } });
    expect(staff.status(), await staff.text()).toBe(201);

    // ① 起草并提交审查
    await page.goto('/erp/contracts');
    await page.getByTestId('contract-new').click();
    await expect(page).toHaveURL(/\/erp\/contracts\/new$/);
    await page.getByTestId('contract-supplier').selectOption(String(supplier.id));
    const title = `E2E 毛巾采购合同${tag}`;
    await page.getByTestId('contract-title').fill(title);
    await page.getByTestId('contract-start').fill(today);
    await page.getByTestId('contract-end').fill(addDays(today, 30));
    await page.getByTestId('contract-total').fill('1000');
    await expect(page.getByTestId('contract-terms-sum')).toHaveText('合计 100%');
    await page.getByTestId('contract-line-add').click();
    await page.getByTestId('contract-line-material-0').selectOption(String(material.id));
    await page.getByTestId('contract-line-price-0').fill('50');
    await page.getByTestId('contract-line-qty-0').fill('20');
    // 付款节点加起来不是 100% 时只能存草稿
    await page.getByTestId('contract-term-prepay').fill('20');
    await expect(page.getByTestId('contract-form-hint')).toContainText('付款节点加起来是 90%');
    await expect(page.getByTestId('contract-save-submit')).toBeDisabled();
    await page.getByTestId('contract-term-prepay').fill('30');
    await expect(page.getByTestId('contract-save-submit')).toBeEnabled();
    await page.getByTestId('contract-save-submit').click();
    await expect(page.getByText('合同已提交审查').first()).toBeVisible();
    await expect(page).toHaveURL(/\/erp\/contracts\/\d+$/);
    const contractId = Number(/\/contracts\/(\d+)$/.exec(page.url())![1]);
    const get = async () => (await (await page.request.get(`/api/erp/contracts/${contractId}`)).json()) as ContractApi;
    let c = await get();
    expect(c.status).toBe('reviewing');
    await expect(page.getByTestId('approval-level-1')).toContainText('财务');
    await expect(page.getByTestId('approval-level-2')).toContainText('法务');
    await expect(page.getByTestId('approval-level-3')).toContainText('负责人');

    // ② 第 1 级（财务）：店主在合同详情里审
    await page.getByTestId(`review-open-${c.contractNo}`).click();
    await expect(page.getByTestId('legal-checklist')).toHaveCount(0);
    await page.getByTestId('review-approve').click();
    await expect(page.getByText('已同意第 1 级').first()).toBeVisible();

    // 第 2 级（法务）：法务在手机上的审批中心审，按审查清单逐条给结论
    await logout(page);
    expect((await page.request.post('/api/auth/login', { data: { username: lawyer, password: lawyerPassword } })).ok()).toBe(true);
    const changed = await page.request.post('/api/auth/change-password', { data: { currentPassword: lawyerPassword, newPassword: `${lawyerPassword}9` } });
    expect(changed.ok(), await changed.text()).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/approvals');
    const card = page.getByTestId(`approval-card-${c.contractNo}`);
    await expect(card).toContainText('第 2/3 级');
    // 合同要逐张审：不能勾选批量
    await expect(page.getByTestId(`approval-pick-${c.contractNo}`)).toBeDisabled();
    await card.getByRole('button').click();
    await expect(page.getByTestId('legal-checklist')).toBeVisible();
    await expect(page.getByTestId('approval-approve')).toBeDisabled();
    await page.getByTestId('legal-checklist-pass-rest').click();
    await page.getByTestId('legal-liability-revise').click();
    await expect(page.getByTestId('approval-legal-problem')).toContainText('意见');
    await expect(page.getByTestId('approval-approve')).toBeDisabled();
    await page.getByTestId('legal-liability-risk').click();
    await page.getByTestId('legal-liability-note').fill('逾期违约金比例偏低，提醒采购跟进');
    await expect(page.getByTestId('approval-approve')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByTestId('approval-approve').click();
    await expect(page.getByText('已同意第 2 级').first()).toBeVisible();

    // 第 3 级（负责人）：店主审，合同审批通过
    await logout(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, 'linlan');
    await page.goto(`/erp/contracts/${contractId}`);
    // 法务的结论记在这次提交上：风险提示带意见
    await expect(page.getByTestId('contract-reviews').first()).toContainText('逾期违约金比例偏低');
    await page.getByTestId(`review-open-${c.contractNo}`).click();
    await page.getByTestId('review-approve').click();
    await expect(page.getByText('已同意，审批通过').first()).toBeVisible();
    await expect(page.getByTestId('contract-detail')).toContainText('审批通过（待签署）');

    // ③ 签署、用印（店主批）、扫描件、归档
    await page.getByTestId('contract-sign').click();
    await page.getByTestId('sign-ours').fill('林岚');
    await page.getByTestId('sign-theirs').fill('供应商经理');
    await page.getByTestId('sign-confirm').click();
    await expect(page.getByText('已登记签署，合同生效').first()).toBeVisible();
    // 用印申请的回复丢了（服务端已经建好、回 5xx，查回也暂时不通）：页面上方「结果待确认」，
    // 查回、按原内容重提或作废之前，再打开用印申请不能另起一条（Codex 自动审查 315e7f7）
    const sealsUrl = `**/api/erp/contracts/${contractId}/seals`;
    await page.route(sealsUrl, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '模拟：回复丢了' } }) });
    });
    await page.route('**/api/erp/ops/**', (route) => route.abort('internetdisconnected'));
    await page.getByTestId('contract-seal').click();
    await page.getByTestId('seal-confirm').click();
    await expect(page.getByText('用印申请没收到结果').first()).toBeVisible();
    await expect(page.getByTestId('erp-pending')).toContainText('用印申请结果待确认');
    await page.getByTestId('contract-seal').click();
    await expect(page.getByTestId('seal-pending-block')).toBeVisible();
    await expect(page.getByTestId('seal-confirm')).toBeDisabled();
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await page.unroute(sealsUrl);
    await page.unroute('**/api/erp/ops/**');
    await page.getByTestId('erp-pending-check').click();
    await expect(page.getByTestId('erp-pending')).toHaveCount(0);
    c = await get();
    expect(c.seals).toHaveLength(1);
    const seal = c.seals[0]!;
    expect(seal.status).toBe('reviewing');
    await page.getByTestId(`review-open-${seal.sealNo}`).click();
    await page.getByTestId('review-approve').click();
    await expect(page.getByText('已同意，审批通过').first()).toBeVisible();
    await expect(page.getByTestId(`seal-${seal.sealNo}`)).toContainText('已生效');
    // 一次选 21 页：全部逐页上传，不悄悄丢掉第 20 页以后的（Codex 自动审查 d64e3ed）
    const pages = await page.evaluate(() =>
      Array.from({ length: 21 }, (_, i) => {
        const cv = document.createElement('canvas');
        cv.width = 4;
        cv.height = 4;
        const g = cv.getContext('2d')!;
        g.fillStyle = `rgb(${(i * 11) % 256}, ${(255 - i * 7) % 256}, ${(i * 37) % 256})`;
        g.fillRect(0, 0, 4, 4);
        return cv.toDataURL('image/png').split(',')[1]!;
      }),
    );
    await page.getByTestId('contract-file-input').setInputFiles(pages.map((b, i) => ({ name: `page${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(b, 'base64') })));
    await expect(page.getByText('扫描件已上传').first()).toBeVisible();
    await expect(page.getByTestId('contract-files').locator('li')).toHaveCount(21);
    await page.getByTestId('contract-archive').click();
    await page.getByTestId('archive-location').fill('财务室 1 号柜');
    await page.getByTestId('archive-confirm').click();
    await expect(page.getByText('已归档').first()).toBeVisible();
    c = await get();
    expect(c.status).toBe('archived');
    expect(c.archiveNo).toMatch(/^GD\d{8}-\d{4}$/);

    // 降价的变更单（总价 1000 → 900、单价 50 → 45）：审查中的在合同详情里展开变更后的内容，总价标「−¥100.00」（Codex 自动审查 315e7f7）
    await page.getByTestId('contract-change').click();
    await expect(page).toHaveURL(new RegExp(`/erp/contracts/${contractId}/change$`));
    await page.getByTestId('change-kind-price').click();
    await page.getByTestId('change-reason').fill('供应商让利，单价降到 45 元');
    await page.getByTestId('contract-total').fill('900');
    await page.getByTestId('contract-line-price-0').fill('45');
    await page.getByTestId('contract-save-submit').click();
    await expect(page.getByText('变更单已提交审查').first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/erp/contracts/${contractId}$`));
    const change = (await get()).changes[0]!;
    expect(change.status).toBe('reviewing');
    await expect(page.getByTestId(`change-delta-${change.changeNo}`)).toHaveText('（−¥100.00）');
    const draft = page.getByTestId(`change-draft-${change.changeNo}`);
    await expect(draft.getByTestId('contract-lines')).toBeVisible();
    await expect(draft.getByTestId('contract-lines')).toContainText('¥45.00');
    // 撤回、作废这张变更单：后面的续签与采购单核对照第 1 版
    const withdrawn = await page.request.post(`/api/erp/contracts/changes/${change.id}/withdraw`, { data: { version: change.version } });
    expect(withdrawn.ok(), await withdrawn.text()).toBe(true);
    const afterWithdraw = (await get()).changes[0]!;
    const voided = await page.request.post(`/api/erp/contracts/changes/${change.id}/void`, { data: { version: afterWithdraw.version, reason: 'E2E：先不调价' } });
    expect(voided.ok(), await voided.text()).toBe(true);
    // 提交记录里每一次提交都能展开当时的内容与单价表：第 1 次（成为第 1 版）单价 50，变更单那次 45（Codex 自动审查 344f7e8）
    await page.reload();
    const firstRevision = page.getByTestId('revision-content-1');
    await firstRevision.locator('summary').click();
    await expect(firstRevision.getByTestId('contract-lines')).toContainText('¥50.00');
    const changeRevision = page.getByTestId('revision-content-2');
    await changeRevision.locator('summary').click();
    await expect(changeRevision.getByTestId('contract-lines')).toContainText('¥45.00');

    // ④ 到期提醒与续签
    await page.goto('/erp/contracts');
    await expect(page.getByTestId(`contract-expiring-${c.contractNo}`)).toContainText('还有 30 天到期');
    await expect(page.getByTestId('erp-nav-contracts').getByTestId('erp-badge-contracts')).toBeVisible();
    await page.getByTestId(`contract-renew-${c.contractNo}`).click();
    await expect(page).toHaveURL(new RegExp(`/erp/contracts/new\\?renew=${contractId}$`));
    await expect(page.getByTestId('contract-title')).toHaveValue(title);
    await expect(page.getByTestId('contract-start')).toHaveValue(addDays(today, 31));
    await expect(page.getByTestId('contract-supplier')).toHaveValue(String(supplier.id));

    // ⑤ 采购单挂合同：超价、超量标出来，要写原因
    await page.goto('/purchasing/new');
    await page.locator('#po-sup').selectOption(String(supplier.id));
    await page.getByTestId('po-contract').selectOption(String(contractId));
    await page.getByPlaceholder('搜索物料：编码 / 名称 / 规格，回车加入').fill(material.code);
    await page.getByPlaceholder('搜索物料：编码 / 名称 / 规格，回车加入').press('Enter');
    await page.getByLabel('采购数量（箱）').fill('25');
    await page.getByLabel('单价（元/箱）').fill('55');
    const hint = page.getByTestId('po-line-contract');
    await expect(hint).toContainText('合同价 ¥50.00 / 箱');
    await expect(hint).toContainText('超价 ¥5.00 / 箱');
    await expect(hint).toContainText('超量 5 箱');
    await expect(page.getByTestId('po-contract-exceeded')).toBeVisible();
    await page.getByTestId('po-contract-note').fill('旺季临时加量，供应商来函涨价');
    await expect(page.getByTestId('po-contract-exceeded')).toHaveCount(0);
    await page.getByRole('button', { name: '存草稿' }).click();
    await expect(page.getByText('草稿已保存').first()).toBeVisible();
    await expect(page.getByTestId('po-sheet-contract')).toHaveText(c.contractNo);
    await expect(page.getByTestId('po-sheet-contract-exceeded')).toContainText('旺季临时加量');
    // 合同详情里列出挂这份合同的采购单
    await page.goto(`/erp/contracts/${contractId}`);
    await expect(page.getByTestId('contract-pos')).toContainText('旺季临时加量');
    // 用过的员工账号停用（不留在演示库的员工列表里能登录）
    const list = (await (await page.request.get('/api/staff')).json()) as { id: number; username: string; displayName: string; role: string; duties: string[] }[];
    const s = list.find((x) => x.username === lawyer);
    if (s) await page.request.put(`/api/staff/${s.id}`, { data: { displayName: s.displayName, role: s.role, duties: s.duties, active: false } });
  });

  test('修改合同：打开表单以后别人先存了一次，这边再保存提示「刚被别人改过」，不拿后台刷新到的新版本号覆盖别人的修改（Codex 自动审查 d64e3ed）', async ({ page }) => {
    await login(page, 'linlan');
    const me = (await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string };
    const today = me.calendarToday;
    const tag = String(Date.now()).slice(-6);
    const header = { category: 'service', counterparty: `E2E 保洁服务${tag}` };
    const content = {
      title: `E2E 并发修改${tag}`,
      startDate: today,
      endDate: addDays(today, 365),
      totalCents: 100_000,
      taxRateBp: 600,
      freightBearer: 'supplier',
      unloadingBearer: 'supplier',
      paymentTerms: DEFAULT_PAYMENT_TERMS,
      warranty: { basis: 'acceptance', months: 12 },
      acceptance: { method: '按月验收', signer: '前厅经理', penalty: '扣当月服务费' },
      note: '',
      lines: [],
    };
    const created = await page.request.post('/api/erp/contracts', { data: { clientKey: randomUUID(), ...header, content } });
    expect(created.status(), await created.text()).toBe(201);
    const draft = (await created.json()).contract as { id: number; version: number };
    await page.goto(`/erp/contracts/${draft.id}/edit`);
    await expect(page.getByTestId('contract-title')).toHaveValue(content.title);
    // 别人先存了一次
    const theirs = `${content.title}（别人改过）`;
    const other = await page.request.put(`/api/erp/contracts/${draft.id}`, { data: { version: draft.version, ...header, content: { ...content, title: theirs } } });
    expect(other.ok(), await other.text()).toBe(true);
    // 这边的页面回到窗口时在后台刷新，拿到了新的版本号；表单里还是打开时的内容
    await page.waitForTimeout(5_500);
    const refetched = page.waitForResponse((r) => r.url().endsWith(`/api/erp/contracts/${draft.id}`) && r.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await refetched;
    await page.getByTestId('contract-title').fill(`${content.title}（我改的）`);
    await page.getByTestId('contract-save').click();
    await expect(page.getByText('这份合同刚被别人改过').first()).toBeVisible();
    const after = (await (await page.request.get(`/api/erp/contracts/${draft.id}`)).json()) as { title: string; version: number };
    expect(after.title).toBe(theirs);
    // 用完作废，不留在台账里
    const voided = await page.request.post(`/api/erp/contracts/${draft.id}/void`, { data: { version: after.version, reason: 'E2E 用完作废' } });
    expect(voided.ok(), await voided.text()).toBe(true);
  });

  test('审批对话框开着时单据撤回、改了再提交：提示「审批已经变了」、不能同意，关掉重开后按新的提交审（Codex 自动审查 e426148）', async ({ page }) => {
    await login(page, 'linlan');
    const me = (await (await page.request.get('/api/auth/me')).json()) as { calendarToday: string };
    const today = me.calendarToday;
    const tag = String(Date.now()).slice(-6);
    const header = { category: 'service', counterparty: `E2E 绿植租摆${tag}` };
    const content = {
      title: `E2E 审批中重提${tag}`,
      startDate: today,
      endDate: addDays(today, 365),
      totalCents: 100_000,
      taxRateBp: 600,
      freightBearer: 'supplier',
      unloadingBearer: 'supplier',
      paymentTerms: DEFAULT_PAYMENT_TERMS,
      warranty: { basis: 'acceptance', months: 12 },
      acceptance: { method: '按月验收', signer: '前厅经理', penalty: '扣当月服务费' },
      note: '',
      lines: [],
    };
    type Row = { id: number; version: number; contractNo: string; status: string };
    const created = await page.request.post('/api/erp/contracts', { data: { clientKey: randomUUID(), ...header, content } });
    expect(created.status(), await created.text()).toBe(201);
    let c = (await created.json()).contract as Row;
    const get = async () => (await (await page.request.get(`/api/erp/contracts/${c.id}`)).json()) as Row;
    const post = async (action: string, data: Record<string, unknown>) => {
      const r = await page.request.post(`/api/erp/contracts/${c.id}/${action}`, { data });
      expect(r.ok(), await r.text()).toBe(true);
      c = await get();
    };
    await post('submit', { version: c.version });
    await page.goto(`/erp/contracts/${c.id}`);
    await page.getByTestId(`review-open-${c.contractNo}`).click();
    await expect(page.getByTestId('review-approve')).toBeEnabled();
    // 对话框开着，起草的人撤回、改了再提交：新的一次提交又到第 1 级
    await post('withdraw', { version: c.version });
    const edited = await page.request.put(`/api/erp/contracts/${c.id}`, { data: { version: c.version, ...header, content: { ...content, title: `${content.title}（改过）` } } });
    expect(edited.ok(), await edited.text()).toBe(true);
    c = await get();
    await post('submit', { version: c.version });
    // 回到窗口时后台刷新：对话框提示审批变了，不能按刚才打开的那次同意
    await page.waitForTimeout(5_500);
    const refetched = page.waitForResponse((r) => r.url().endsWith(`/api/erp/contracts/${c.id}`) && r.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await refetched;
    await expect(page.getByTestId('review-moved')).toBeVisible();
    await expect(page.getByTestId('review-approve')).toBeDisabled();
    // 关掉重新打开：按新的这次提交审
    await page.keyboard.press('Escape');
    await page.getByTestId(`review-open-${c.contractNo}`).click();
    await expect(page.getByTestId('review-moved')).toHaveCount(0);
    await page.getByTestId('review-approve').click();
    await expect(page.getByText('已同意第 1 级').first()).toBeVisible();
    // 用完撤回、作废，不留在台账里
    c = await get();
    await post('withdraw', { version: c.version });
    await post('void', { version: c.version, reason: 'E2E 用完作废' });
    expect(c.status).toBe('voided');
  });
});
