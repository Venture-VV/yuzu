// 8.1.17 前台、桌台、退菜、本店价、流水（docs/FRONTDESK_V8117.md）的浏览器验收：
//   ① BW-12「流水」的订单详情用结账单的同一个部件：「优惠与赠送」写经办人、券抵到的行标「券」、收银写明；三种屏幕都放得下；
//   ② BW-1 超时加收按小时先填好（前台规则「每超 1 小时」）；到点的「超时提醒」由每分钟的任务记进「异常待办」，经办人「系统」；
//   ③ BW-3 / BW-4 按出品口：临时去掉店员「在水吧下单」「退菜：水吧的菜」，发卡台加项目里水吧的菜标「不能在水吧下单」，
//      点单页水吧的菜没有「改」「退菜」、写明能退哪几处；用完改回去；
//   ④ BW-2 桌台提醒：维修过了预计恢复时间，格子上写「已过预计恢复时间」，「桌台」页签与页顶写待办；后台「餐饮规则」两项；
//   ⑤ 后台「前台规则」的超时加收一项。
// 依赖演示数据（店主 linlan、值班经理 zhangjl、收银 xiaozhou，密码 yuzu2026）。用到的项目、会员、券、桌台每次新建（名字带「E2E8117」），
// 来访做完撤销，规则与岗位权限改了的改回去；不动演示数据里已有的档案。只有 ① 在三种屏幕上跑，别的会登记单据、只在门店电脑跑一次。
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { expectFits } from './fits';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function apiAs(browser: Browser, baseURL: string | undefined, username: string): Promise<APIRequestContext> {
  const ctx = await browser.newContext({ baseURL });
  const res = await ctx.request.post('/api/auth/login', { data: { username, password: PASSWORD } });
  expect(res.ok(), await res.text()).toBe(true);
  return ctx.request;
}

async function getJson<T>(req: APIRequestContext, url: string): Promise<T> {
  const res = await req.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function send<T>(req: APIRequestContext, method: 'post' | 'put', url: string, data: unknown): Promise<T> {
  const res = await req[method](url, { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}
interface Visit {
  id: number;
  status: string;
  lines: { id: number; name: string; status: string }[];
}

/** 三台目标设备的四个尺寸（docs/DEVICES.md）：商米 D3 Pro 1920×1080 与系统缩放 1.5 倍的 1280×720、商米 V3 360×800、小米平板 1355×903 */
const TARGET_SIZES = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 360, height: 800 },
  { width: 1355, height: 903 },
] as const;
/** 门店电脑这一组里把页面换成四个尺寸逐个量（手机那一组只跑指定的几个文件） */
async function fitsOnTargets(page: Page, testInfo: { project: { name: string } }, visible: () => Promise<void>) {
  if (testInfo.project.name !== '门店电脑') return;
  const original = page.viewportSize();
  try {
    for (const size of TARGET_SIZES) {
      await page.setViewportSize(size);
      await visible();
      await expectFits(page);
    }
  } finally {
    if (original) await page.setViewportSize(original);
  }
}

const suffix = () => `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 100)}`;
const freeTags = async (req: APIRequestContext) =>
  (await getJson<{ tags: BoardTag[] }>(req, '/api/frontdesk/board')).tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).reverse();
/** 发一张空闲的牌给这位客人（别的用例同时在发时换下一张） */
async function checkin(req: APIRequestContext, memberId: number | null = null): Promise<{ code: string; visitId: number }> {
  for (const t of await freeTags(req)) {
    const res = await req.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: t.code, zone: 'male', memberId }] } });
    if (res.status() === 201) return { code: t.code, visitId: ((await res.json()) as { visits: { id: number }[] }).visits[0]!.id };
  }
  throw new Error('没有空闲的手牌');
}
/** 按纸质单补录一位 hours 小时前进店的客人（值班经理能补录）：那段时间用过的牌服务端拒绝，换下一张 */
async function checkinAgo(req: APIRequestContext, hours: number): Promise<{ code: string; visitId: number }> {
  for (const t of await freeTags(req)) {
    const res = await req.post('/api/frontdesk/checkins', {
      data: {
        clientKey: randomUUID(),
        guests: [{ tagCode: t.code, zone: 'male' }],
        backfill: { slipNo: `E2E8117-${Date.now()}`, at: new Date(Date.now() - hours * 3_600_000).toISOString() },
      },
    });
    if (res.status() === 201) return { code: t.code, visitId: ((await res.json()) as { visits: { id: number }[] }).visits[0]!.id };
  }
  throw new Error('没有那段时间空着的手牌');
}
/** 撤销一次来访（先把挂着的明细作废），手牌空出来 */
async function cleanup(req: APIRequestContext, visitId: number) {
  const v = await getJson<Visit>(req, `/api/frontdesk/visits/${visitId}`);
  if (v.status !== 'open') return;
  for (const l of v.lines.filter((x) => x.status === 'active')) await send(req, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason: '浏览器用例收尾' });
  await send(req, 'post', `/api/frontdesk/visits/${visitId}/cancel`, { reason: '浏览器用例收尾' });
}
const newItem = async (req: APIRequestContext, name: string, category: string, price: number) =>
  (await send<{ items: { id: number; name: string }[] }>(req, 'post', '/api/items', { name, category, price })).items.find((i) => i.name === name)!.id;

test.describe('8.1.17 前台、桌台、退菜、流水', () => {
  test('「流水」的订单详情与结账单同一写法：优惠与赠送写经办人、券抵到的行标「券」；放得下', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await login(page, 'linlan');
    const req = page.request;
    const s = suffix();
    // 收款前要开班（演示库默认开着这条规则）：店主没开着的先开一个
    const cur = await getJson<{ shift: unknown }>(req, '/api/shifts/current');
    if (!cur.shift) expect((await req.post('/api/shifts', { data: { openingCash: 0 } })).ok()).toBe(true);
    const itemName = `E2E8117足疗${s}`;
    const itemId = await newItem(req, itemName, 'E2E8117部门', 12800);
    const tplName = `E2E8117代金券${s}`;
    const tpl = await send<{ id: number }>(req, 'post', '/api/coupons/templates', { clientKey: randomUUID(), name: tplName, kind: 'cash', faceValue: 2000, validity: 'days', validDays: 30 });
    const member = await send<{ id: number }>(req, 'post', '/api/members', { name: `E2E8117会员${s}`, phone: `139${String(Date.now()).slice(-8)}`, gender: 'male' });
    await send(req, 'post', `/api/members/${member.id}/coupons`, { clientKey: randomUUID(), templateId: tpl.id, quantity: 1, reason: '浏览器用例补偿' });
    const { visitId } = await checkin(req, member.id);
    await send(req, 'post', `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines: [{ itemId, quantity: 1 }], expectedTotal: 12800 });
    const pre = await getJson<{ totalAmount: number; storeCoupons: { code: string; templateName: string }[] }>(req, `/api/frontdesk/checkout-preview?ids=${visitId}`);
    const code = pre.storeCoupons.find((c) => c.templateName === tplName)!.code;
    const done = await send<{ id: number; checkoutNo: string }>(req, 'post', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [visitId],
      expectedTotal: pre.totalAmount,
      payments: [
        { method: 'store_coupon', code, amount: 2000 },
        { method: 'cash', amount: pre.totalAmount - 2000 },
      ],
    });

    await page.goto(`/ledger?tab=orders&oq=${done.checkoutNo}`);
    await page.locator(`[data-testid="order-row-${done.checkoutNo}"]:visible, [data-testid="order-card-${done.checkoutNo}"]:visible`).click();
    const drawer = page.getByTestId('order-drawer');
    const receipt = drawer.getByTestId('checkout-receipt');
    await expect(receipt).toBeVisible();
    await expect(receipt.getByTestId('checkout-receipt-operator')).toContainText('收银');
    const perk = receipt.getByTestId('checkout-perks');
    await expect(perk).toContainText(tplName);
    await expect(perk).toContainText('浏览器用例补偿');
    await expect(perk).toContainText('发券');
    await expect(perk).toContainText('共优惠');
    // 券抵到的行标「券」，另写所属部门
    const line = receipt.getByTestId('receipt-line').filter({ hasText: itemName });
    await expect(line.getByTestId('receipt-line-marks')).toHaveText('券');
    await expect(line).toContainText('E2E8117部门');
    await expect(receipt.getByTestId('checkout-tenders')).toContainText('现金');
    await expect(drawer.getByTestId('order-meta')).toContainText('营业日');
    await expectFits(page);
    // 三台目标设备的四个尺寸：抽屉放得下、行上的标记看得到
    await fitsOnTargets(page, testInfo, () => expect(line.getByTestId('receipt-line-marks')).toBeVisible());
  });
});

test.describe('8.1.17 前台、桌台、退菜（会登记单据）', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== '门店电脑', '会登记单据、改规则，只在门店电脑尺寸执行一次');
  });

  test('超时加收按小时先填好；到点的「超时提醒」进「异常待办」，经办人「系统」', async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const owner = await apiAs(browser, baseURL, 'linlan');
    const rules = await getJson<{ overtimeSurchargeHourlyCents: number }>(owner, '/api/frontdesk/rules');
    await send(owner, 'put', '/api/frontdesk/rules', { overtimeSurchargeHourlyCents: 2000 });
    await login(page, 'zhangjl');
    const { code, visitId } = await checkinAgo(page.request, 14.5);
    try {
      await page.goto(`/frontdesk?v=${visitId}`);
      await expect(page.getByTestId('bill-tag')).toHaveText(code);
      await page.getByTestId('action-incident').click();
      await expect(page.getByRole('heading', { name: `异常处置 · ${code}` })).toBeVisible();
      await page.getByTestId('incident-action-surcharge').click();
      // 14.5 小时：超过 12 小时以后 2.5 小时，不足 1 小时按 1 小时 → 3 小时 × ¥20
      await expect(page.getByTestId('incident-amount')).toHaveValue('60.00');
      await expect(page.getByTestId('incident-note')).toHaveValue('超时 3 小时');
      await expect(page.getByTestId('incident-surcharge-prefill')).toContainText('3');
      await expect(page.getByTestId('incident-surcharge-prefill')).toContainText('¥60.00');
      await expectFits(page);
      await fitsOnTargets(page, testInfo, () => expect(page.getByTestId('incident-surcharge-prefill')).toBeVisible());
      // 照旧要人确认：不点「确认加收」什么都不挂
      await page.keyboard.press('Escape');
      await expect(page.getByRole('heading', { name: `异常处置 · ${code}` })).toHaveCount(0);
      expect((await getJson<Visit>(page.request, `/api/frontdesk/visits/${visitId}`)).lines.filter((l) => l.status === 'active')).toEqual([]);

      // 超时提醒：每分钟的任务记一条（最多等一分多钟）
      await expect
        .poll(
          async () =>
            (await getJson<{ todos: { visitId: number; kind: string; createdByName: string }[] }>(page.request, '/api/frontdesk/incidents/todos')).todos.some(
              (t) => t.visitId === visitId && t.kind === 'overtime' && t.createdByName === '系统',
            ),
          { timeout: 120_000, intervals: [5_000] },
        )
        .toBe(true);
      await page.goto('/frontdesk');
      await page.getByTestId('open-incident-todos').click();
      const todo = page.locator('[data-testid^="todo-"][data-kind="overtime"]').filter({ hasText: code });
      await expect(todo).toHaveCount(1);
      await expect(todo).toContainText('超时提醒');
      await expect(todo).toContainText('系统');
      await expectFits(page);
    } finally {
      await cleanup(page.request, visitId);
      await send(owner, 'put', '/api/frontdesk/rules', { overtimeSurchargeHourlyCents: rules.overtimeSurchargeHourlyCents });
    }
  });

  test('按出品口：去掉店员「在水吧下单」「退菜：水吧的菜」，加项目里水吧的菜不能点，点单页水吧的菜没有退菜；改回去照常', async ({ page, browser, baseURL }) => {
    test.setTimeout(180_000);
    const owner = await apiAs(browser, baseURL, 'linlan');
    const s = suffix();
    const st = await send<{ stations: { id: number; name: string }[] }>(owner, 'post', '/api/admin/dining/stations', { name: `E2E8117水吧${s}` });
    const stationId = st.stations.find((x) => x.name === `E2E8117水吧${s}`)!.id;
    const water = `E2E8117柠檬水${s}`;
    const waterId = await newItem(owner, water, 'E2E8117饮品', 1800);
    await send(owner, 'put', '/api/admin/dining/items', { items: [{ id: waterId, stationId, slot: 'water:手作饮料' }] });
    const { code, visitId } = await checkin(owner);
    await send(owner, 'post', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines: [{ itemId: waterId, quantity: 1 }], expectedTotal: 1800 });
    const matrix = await getJson<{ effective: Record<string, string[]> }>(owner, '/api/admin/permissions');
    const clerk = matrix.effective.clerk!;
    expect(clerk).toEqual(expect.arrayContaining(['dining.orderWater', 'dining.voidWater']));
    await send(owner, 'put', '/api/admin/permissions', { roles: { clerk: clerk.filter((p) => p !== 'dining.orderWater' && p !== 'dining.voidWater') } });
    try {
      await login(page, 'xiaozhou');
      // 发卡台「加项目」：水吧的菜标「不能在水吧下单」、不能点
      await page.goto(`/frontdesk?v=${visitId}`);
      await expect(page.getByTestId('bill-tag')).toHaveText(code);
      await page.getByTestId('action-add').click();
      const card = page.getByTestId(`item-${water}`);
      await expect(card).toContainText('不能在水吧下单');
      await expectFits(page);
      await page.keyboard.press('Escape');
      // 点单页：这道水吧的菜没有「改」「退菜」，写明能退哪几处
      await page.goto('/dining/order');
      await page.getByTestId('dining-tag').fill(code);
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest')).toBeVisible();
      const pending = page.getByTestId(`dining-pending-${water}`);
      await expect(pending).toBeVisible();
      await expect(pending.getByRole('button', { name: '退菜' })).toHaveCount(0);
      await expect(page.getByTestId('dining-void-no-permission')).toContainText('餐厅、果吧');
      // 服务端同样拒绝
      const line = (await getJson<Visit>(owner, `/api/frontdesk/visits/${visitId}`)).lines.find((l) => l.name === water && l.status === 'active')!;
      const denied = await page.request.post(`/api/frontdesk/lines/${line.id}/void`, { data: { reason: '用例试退', blame: 'guest' } });
      expect(denied.status()).toBe(403);
      expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('OUTLET_VOID_FORBIDDEN');
    } finally {
      await send(owner, 'put', '/api/admin/permissions', { roles: { clerk } });
    }
    // 改回去：退菜按钮回来了
    await page.request.post('/api/auth/logout');
    await login(page, 'xiaozhou');
    await page.goto('/dining/order');
    await page.getByTestId('dining-tag').fill(code);
    await page.getByTestId('dining-find').click();
    await expect(page.getByTestId(`dining-pending-${water}`).getByRole('button', { name: '退菜' })).toBeVisible();
    await cleanup(owner, visitId);
  });

  test('桌台提醒：维修过了预计恢复时间，格子上写「已过预计恢复时间」，「桌台」页签与页顶写待办；后台规则两项与前台规则的超时加收', async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(240_000);
    const owner = await apiAs(browser, baseURL, 'linlan');
    // 桌号最多 12 个字
    const name = `E8117-${Math.random().toString(36).slice(2, 6)}`;
    const created = await send<{ tables: { id: number; name: string }[] }>(owner, 'post', '/api/admin/dining/tables', { name, area: '散桌', seats: 2 });
    const tableId = created.tables.find((t) => t.name === name)!.id;
    // 预计 70 秒以后恢复；到点以前不提醒
    await send(owner, 'post', `/api/dining/tables/${tableId}/maintenance`, { clientKey: randomUUID(), reason: '浏览器用例：桌腿松了', expectedBackAt: new Date(Date.now() + 70_000).toISOString() });
    try {
      await login(page, 'linlan');
      await page.goto('/dining/tables');
      const tile = page.getByTestId(`table-tile-${name}`);
      await expect(tile).toHaveAttribute('data-state', 'maintenance');
      await expect(page.getByTestId(`table-reminder-${name}`)).toHaveCount(0);
      // 过了预计恢复时间（看板 10 秒刷一次、页面上的钟 30 秒走一次）
      await expect(page.getByTestId(`table-reminder-${name}`)).toHaveText('已过预计恢复时间', { timeout: 150_000 });
      await expect(tile).toHaveAttribute('data-reminder', 'overdue');
      expect(await page.getByTestId(`table-reminder-${name}`).evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await expect(page.getByTestId('tables-todo')).toContainText('已过预计恢复时间');
      await expect(page.getByTestId('tables-todo-badge')).toContainText('待办');
      await expectFits(page);
      await fitsOnTargets(page, testInfo, () => expect(page.getByTestId(`table-reminder-${name}`)).toBeVisible());
      // 后台「餐饮规则」：到点自动恢复（默认等人恢复）、待清台多久算久了
      await page.goto('/admin/dining');
      const card = page.getByTestId('dining-rules-card');
      await expect(card).toContainText('维修到点自动恢复');
      await expect(card.getByRole('radiogroup', { name: '维修到点自动恢复' })).toBeVisible();
      await expect(page.getByTestId('dining-dirty-alert-minutes')).toHaveValue('15');
      // 后台「前台规则」：超时加收每小时
      await page.goto('/admin/tags/rules');
      await expect(page.getByTestId('rules-overtime-hourly')).toBeVisible();
      await expectFits(page);
    } finally {
      await owner.post(`/api/dining/tables/${tableId}/restore`, { data: { clientKey: randomUUID() } });
    }
  });
});
