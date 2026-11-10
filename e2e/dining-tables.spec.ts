// S5 餐饮第二步浏览器验收（桌台与不洗浴客人结账）：
//   后台建桌台 → 桌台页开台（登记会员）→ 点单页点到桌台 → 厨房屏显示桌号 → 桌台详情上菜、退菜 → 转台
//   → 合并两桌结账（会员储值 + 现金）→ 结账记录反结账，两桌恢复为用餐中 → 收尾；
//   开台响应丢失：刷新后顶部仍提醒待确认，「去处理」回到那张桌台的开台对话框，查回已生效、只开了一次。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
// 专用菜品、档口、桌台（E2E 开头）留着下次沿用；开始时收掉上次中断留下的开台，结束时关闭餐饮功能，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { DiningAdmin, KitchenBoard, TableSessionDetail, TablesAdmin, TablesBoard } from '../src/shared/dining';
import type { CheckoutDetail } from '../src/shared/checkout';
import type { MemberSummary } from '../src/shared/types';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';
const DISHES = [
  { name: 'E2E 宫保鸡丁', category: 'E2E 餐饮', price: 4800, station: 'E2E 热菜' },
  { name: 'E2E 柠檬茶', category: 'E2E 餐饮', price: 1500, station: 'E2E 水吧' },
] as const;
const [HOT, TEA] = DISHES;
const AREA = 'E2E 大厅';
const TABLES = ['E2E-A1', 'E2E-A2', 'E2E-B1', 'E2E-B2'] as const;
const [A1, A2, B1, B2] = TABLES;
/** 演示会员（seed-frontdesk-demo）：登记到桌上，结账时用储值付一部分 */
const MEMBER_PHONE = '19900008802';
/** 会员码过期时服务端的原话（src/server/modules/mp/member.ts） */
const CODE_EXPIRED = '会员码过期或不对（或微信已解绑），请让客人刷新后再扫';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function relogin(page: Page, username: string) {
  await page.request.post('/api/auth/logout');
  await login(page, username);
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function send<T = unknown>(page: Page, method: 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const res = await page.request[method](url, data === undefined ? {} : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const sessionOf = async (page: Page, name: string) => (await getJson<TablesBoard>(page, '/api/dining/tables')).tables.find((t) => t.name === name)!.session;

/** 店主：专用菜品、档口、菜品的档口、四张桌台（第一张在后台页面上建）都准备好，开启餐饮；收掉上次中断留下的开台 */
async function prepare(page: Page) {
  for (const d of DISHES) {
    const items = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items;
    const old = items.find((i) => i.name === d.name);
    const body = { name: d.name, category: d.category, price: d.price };
    if (!old) await send(page, 'post', '/api/items', body);
    else if (!old.active) await send(page, 'put', `/api/items/${old.id}`, { ...body, active: true });
  }
  let admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
  for (const name of new Set(DISHES.map((d) => d.station))) {
    const old = admin.stations.find((s) => s.name === name);
    if (!old) admin = await send<DiningAdmin>(page, 'post', '/api/admin/dining/stations', { name });
    else if (!old.active) admin = await send<DiningAdmin>(page, 'put', `/api/admin/dining/stations/${old.id}`, { name, sortOrder: old.sortOrder, active: true });
  }
  const items = DISHES.map((d) => ({ id: admin.items.find((i) => i.name === d.name)!.id, stationId: admin.stations.find((s) => s.name === d.station)!.id }));
  await send(page, 'put', '/api/admin/dining/items', { items });
  // 8.0.8（A05）起桌台点单默认下架：这组用例测的是桌台，先打开
  await send(page, 'put', '/api/admin/dining/rules', { enabled: true, trackServed: true, warnMinutes: 15, tablesEnabled: true });

  // 桌台：第一张在后台页面上建（还没有时），其余用接口；停用的重新启用
  let tables = await getJson<TablesAdmin>(page, '/api/admin/dining/tables');
  if (!tables.tables.some((t) => t.name === A1)) {
    await page.goto('/admin/dining');
    await page.getByTestId('dining-table-new').click();
    await page.getByTestId('dining-table-name').fill(A1);
    await page.getByTestId('dining-table-area').fill(AREA);
    await page.getByTestId('dining-table-seats').fill('4');
    await page.getByTestId('dining-table-save').click();
    await expect(page.getByTestId(`dining-table-${A1}`)).toContainText(AREA);
    tables = await getJson<TablesAdmin>(page, '/api/admin/dining/tables');
  }
  for (const [i, name] of TABLES.entries()) {
    const old = tables.tables.find((t) => t.name === name);
    const body = { name, area: AREA, seats: 4, sortOrder: 9000 + i, active: true };
    if (!old) tables = await send<TablesAdmin>(page, 'post', '/api/admin/dining/tables', body);
    else if (!old.active || old.sortOrder !== body.sortOrder) tables = await send<TablesAdmin>(page, 'put', `/api/admin/dining/tables/${old.id}`, body);
  }
  // 上次中断留下的开台：退掉有效明细后撤台（店主可以作废任何明细）
  for (const name of TABLES) {
    const s = await sessionOf(page, name);
    if (!s) continue;
    const d = await getJson<TableSessionDetail>(page, `/api/dining/tables/sessions/${s.id}`);
    for (const l of d.lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/dining/tables/lines/${l.id}/void`, { reason: 'E2E：收掉上次留下的' });
    await send(page, 'post', `/api/dining/tables/sessions/${s.id}/cancel`, { reason: 'E2E：收掉上次留下的' });
  }
}

/** 收尾：两桌的有效明细退掉、撤台（店主）；关闭餐饮功能 */
async function cleanup(page: Page) {
  for (const name of TABLES) {
    const s = await sessionOf(page, name);
    if (!s) continue;
    const d = await getJson<TableSessionDetail>(page, `/api/dining/tables/sessions/${s.id}`);
    for (const l of d.lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/dining/tables/lines/${l.id}/void`, { reason: 'E2E：收尾' });
    await send(page, 'post', `/api/dining/tables/sessions/${s.id}/cancel`, { reason: 'E2E：收尾' });
  }
  const res = await page.request.put('/api/admin/dining/rules', { data: { enabled: false, tablesEnabled: false } });
  expect(res.ok(), await res.text()).toBe(true);
}

test.describe('S5 餐饮第二步 · 桌台', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改规则的流程只在门店电脑尺寸执行一次');
  test.setTimeout(240_000);

  test('开台（会员）→ 点到桌台 → 厨房屏显示桌号 → 上菜、退菜 → 转台 → 合并两桌结账（储值 + 现金）→ 反结账恢复用餐中', async ({ page }) => {
    await login(page, 'linlan');
    try {
      await prepare(page);
      await relogin(page, 'xiaozhou');
      await ensureShift(page);

      // ① 桌台页：A1 空闲 → 开台 3 人，登记会员
      await page.goto('/dining/tables');
      const tileA1 = page.getByTestId(`table-tile-${A1}`);
      await expect(tileA1).toHaveAttribute('data-state', 'free');
      await tileA1.click();
      const openDialog = page.getByRole('dialog').filter({ hasText: `开台 · 桌 ${A1}` });
      await openDialog.getByTestId('table-guests').fill('3');
      await openDialog.getByTestId('table-member-search').fill(MEMBER_PHONE);
      await openDialog.getByRole('button').filter({ hasText: '乔木' }).first().click();
      await expect(openDialog.getByTestId('table-member')).toContainText('乔木');
      await openDialog.getByTestId('table-open-submit').click();
      await expect(page.getByText(`桌 ${A1} 已开台`)).toBeVisible();
      const panel = page.getByTestId('table-session');
      await expect(panel).toBeVisible();

      // ② 点单：从桌台详情进入点单页，已选好这一桌；宫保鸡丁 2 份、柠檬茶 1 杯
      await page.getByTestId('table-order').click();
      await expect(page.getByTestId('dining-table-selected')).toContainText(`桌 ${A1}`);
      await page.getByTestId(`dining-dish-${HOT.name}`).click();
      await page.getByTestId(`dining-dish-${TEA.name}`).click();
      await page.getByTestId(`dining-dish-${HOT.name}`).click();
      await expect(page.getByTestId('dining-line-0')).toContainText('2');
      await page.getByTestId('dining-submit').click();
      await expect(page.getByText(`桌 ${A1} 已下单`)).toBeVisible();
      const a1 = (await sessionOf(page, A1))!;
      expect(a1.amount).toBe(2 * HOT.price + TEA.price);

      // ③ 厨房屏：显示桌号；柠檬茶出餐
      const kitchen = await getJson<KitchenBoard>(page, '/api/kitchen');
      const mine = kitchen.items.filter((k) => k.tableSessionId === a1.id);
      expect(mine.map((k) => [k.name, k.tableName, k.tagCode, k.status]).sort()).toEqual([
        [HOT.name, A1, null, 'queued'],
        [TEA.name, A1, null, 'queued'],
      ]);
      await page.getByTestId('dining-tab-kitchen').click();
      const tea = mine.find((k) => k.name === TEA.name)!;
      await expect(page.getByTestId(`kds-${tea.id}`)).toContainText(`桌 ${A1}`);
      await page.getByTestId(`kds-done-${tea.id}`).click();
      await expect(page.getByTestId(`kds-${tea.id}`)).toContainText('出餐');

      // ④ 桌台详情：柠檬茶上菜；宫保鸡丁退菜（写原因）
      await page.getByTestId('dining-tab-tables').click();
      await page.getByTestId(`table-tile-${A1}`).click();
      await expect(panel).toBeVisible();
      await panel.getByTestId(`table-serve-${tea.id}`).click();
      await expect(page.getByText(`${TEA.name} 已上菜`)).toBeVisible();
      let detail = await getJson<TableSessionDetail>(page, `/api/dining/tables/sessions/${a1.id}`);
      const hotLine = detail.lines.find((l) => l.name === HOT.name)!;
      await panel.getByTestId(`table-void-${hotLine.id}`).click();
      const reason = page.getByRole('dialog').filter({ hasText: `退菜 · ${HOT.name}` });
      await reason.getByRole('textbox').fill('客人不要了');
      await reason.getByRole('button', { name: '确认退菜' }).click();
      await expect(page.getByText(`${HOT.name} 已退`)).toBeVisible();
      detail = await getJson<TableSessionDetail>(page, `/api/dining/tables/sessions/${a1.id}`);
      expect(detail.lines.map((l) => [l.name, l.status, l.kitchen?.status])).toEqual([
        [HOT.name, 'voided', 'cancelled'],
        [TEA.name, 'active', 'served'],
      ]);

      // ⑤ 转台 A1 → A2（写原因）：账单跟着走，A1 空出来
      await panel.getByTestId('table-move').click();
      const move = page.getByRole('dialog').filter({ hasText: `转台 · 桌 ${A1}` });
      await move.getByTestId(`table-move-to-${A2}`).click();
      await move.getByTestId('table-move-reason').fill('客人要靠窗');
      await move.getByTestId('table-move-save').click();
      await expect(page.getByText(`已转到桌 ${A2}`)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(`table-tile-${A1}`)).toHaveAttribute('data-state', 'free');
      await expect(page.getByTestId(`table-tile-${A2}`)).toHaveAttribute('data-state', 'busy');
      expect((await sessionOf(page, A2))!.id).toBe(a1.id);

      // ⑥ 另一桌 B1：2 人散客，点一份宫保鸡丁（接口办理）
      const b1Table = (await getJson<TablesBoard>(page, '/api/dining/tables')).tables.find((t) => t.name === B1)!;
      const b1 = await send<TableSessionDetail>(page, 'post', '/api/dining/tables/open', { clientKey: randomUUID(), tableId: b1Table.id, guests: 2, guestLabel: 'E2E 散客' });
      const menu = await getJson<{ dishes: { id: number; name: string }[] }>(page, '/api/dining/menu');
      await send(page, 'post', `/api/dining/tables/sessions/${b1.id}/orders`, {
        clientKey: randomUUID(),
        lines: [{ itemId: menu.dishes.find((d) => d.name === HOT.name)!.id, quantity: 1 }],
        expectedTotal: HOT.price,
      });

      // ⑦ A2 结账：合并 B1，会员储值付 ¥10，其余现金
      await page.reload();
      await page.getByTestId(`table-tile-${A2}`).click();
      await page.getByTestId('table-checkout').click();
      const checkout = page.getByRole('dialog').filter({ hasText: '桌台结账' });
      await expect(checkout.getByTestId('table-checkout-review')).toContainText(`桌 ${A2}`);
      await checkout.getByTestId('table-checkout-more').click();
      await checkout.getByTestId(`table-checkout-pick-${B1}`).click();
      const total = TEA.price + HOT.price;
      await expect(checkout.getByTestId('table-checkout-total')).toContainText((total / 100).toFixed(2));
      await expect(checkout.getByTestId('checkout-dishes')).toContainText(`桌 ${B1}`);
      await checkout.getByTestId('pay-add-wallet').click();
      await checkout.getByLabel('会员储值金额').fill('10');
      await checkout.getByTestId('pay-add-cash').click();
      // 现金一笔默认填还差的部分（输入框里是元，整数不带小数）
      await expect(checkout.getByTestId('pay-row-cash').getByLabel('现金金额')).toHaveValue(new RegExp(`^${(total - 1000) / 100}(\\.0+)?$`));
      await checkout.getByTestId('checkout-submit').click();
      const receipt = page.getByTestId('checkout-receipt');
      await expect(receipt).toContainText(`桌 ${A2}`);
      await expect(receipt).toContainText(`桌 ${B1}`);
      await expect(receipt).toContainText('3 人');
      await expect(receipt).toContainText('2 人');
      await page.getByTestId('checkout-finish').click();
      await expect(page.getByTestId(`table-tile-${A2}`)).toHaveAttribute('data-state', 'free');
      await expect(page.getByTestId(`table-tile-${B1}`)).toHaveAttribute('data-state', 'free');
      const list = await getJson<{ id: number; checkoutNo: string; tableNames: string[]; totalAmount: number; methods: string[] }[]>(page, '/api/frontdesk/checkouts');
      const done = list.find((c) => c.tableNames.includes(A2))!;
      expect(done.tableNames.sort()).toEqual([A2, B1].sort());
      expect(done.totalAmount).toBe(total);
      const full = await getJson<CheckoutDetail>(page, `/api/frontdesk/checkouts/${done.id}`);
      expect(full.payments.map((p) => [p.method, p.amount]).sort()).toEqual([
        ['cash', total - 1000],
        ['wallet', 1000],
      ]);

      // ⑧ 店主在结账记录里反结账：两桌恢复为用餐中，储值退回
      await relogin(page, 'linlan');
      await page.goto('/dining/tables');
      await page.getByTestId('tables-records').click();
      const records = page.getByRole('dialog').filter({ hasText: '结账记录' });
      await records.getByText(done.checkoutNo).click();
      await records.getByTestId('checkout-void').click();
      await expect(records).toContainText('这几桌恢复为用餐中');
      await records.getByLabel('反结账原因').fill('E2E：收款方式记错');
      await records.getByTestId('checkout-void-confirm').click();
      await expect(page.getByText(`已反结账 ${done.checkoutNo}`)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(`table-tile-${A2}`)).toHaveAttribute('data-state', 'busy');
      await expect(page.getByTestId(`table-tile-${B1}`)).toHaveAttribute('data-state', 'busy');
      const voided = await getJson<CheckoutDetail>(page, `/api/frontdesk/checkouts/${done.id}`);
      expect(voided.status).toBe('voided');
      expect(voided.payments.find((p) => p.method === 'wallet')!.consumption!.status).toBe('reversed');
    } finally {
      await relogin(page, 'linlan');
      await cleanup(page);
    }
  });

  test('开台响应丢失：刷新后顶部仍提醒待确认，「去处理」回到开台对话框，查回已生效、只开了一次', async ({ page }) => {
    await login(page, 'linlan');
    try {
      await prepare(page);
      await relogin(page, 'xiaozhou');
      // 开台请求真实到达服务器并生效，但浏览器收不到响应；查回也先连不上
      await page.route('**/api/dining/tables/open', async (route) => {
        await route.fetch();
        await route.abort('connectionreset');
      }, { times: 1 });
      await page.route('**/api/frontdesk/ops/*', (route) => route.abort('connectionreset'));
      await page.goto('/dining/tables');
      await page.getByTestId(`table-tile-${B2}`).click();
      const openDialog = page.getByRole('dialog').filter({ hasText: `开台 · 桌 ${B2}` });
      await openDialog.getByTestId('table-guests').fill('2');
      await openDialog.getByTestId('table-open-submit').click();
      await expect(openDialog.getByTestId('pending-op')).toContainText(`桌 ${B2}`);
      await expect(openDialog.getByTestId('table-open-submit')).toBeDisabled();
      // 刷新后顶部提醒仍在 → 去处理：回到 B2 的开台对话框
      await page.reload();
      const banner = page.getByTestId('frontdesk-pending-banner');
      await expect(banner).toContainText(`桌 ${B2}`);
      await expect(banner).toContainText('开台');
      await banner.getByRole('button', { name: '去处理' }).click();
      await expect(page).toHaveURL(/\/dining\/tables/);
      const again = page.getByRole('dialog').filter({ hasText: `开台 · 桌 ${B2}` });
      await expect(again.getByTestId('pending-op')).toContainText(`桌 ${B2}`);
      // 网络恢复：查回已生效，只开了一次
      await page.unroute('**/api/frontdesk/ops/*');
      await again.getByTestId('pending-check').click();
      await expect(page.getByText(`桌 ${B2} 已开台`)).toBeVisible();
      await expect(page.getByTestId('table-session')).toBeVisible();
      await expect(banner).toHaveCount(0);
      const board = await getJson<TablesBoard>(page, '/api/dining/tables');
      expect(board.tables.filter((t) => t.name === B2 && t.session).map((t) => t.session!.guests)).toEqual([2]);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await relogin(page, 'linlan');
      await cleanup(page);
    }
  });

  // 测试会话预检 a040d79：同一个会员码先认出过、之后失效（过期、解绑）再扫时，不能拿上一次成功的结果登记会员、清空查找框。
  // 会员码的校验结果用 page.route 模拟（浏览器验收的环境没配会员码）：第一次认出演示会员，之后都是过期
  test('开台对话框扫会员码：同一个码先登记上、「不登记」后失效再扫，写明原因、保留查找框，不登记回上一次的会员；第一次就过期的写明原因', async ({ page }) => {
    await login(page, 'linlan');
    try {
      await prepare(page);
      await relogin(page, 'xiaozhou');
      const [qiao] = await getJson<MemberSummary[]>(page, `/api/members?q=${MEMBER_PHONE}`);
      expect(qiao, `演示会员 ${MEMBER_PHONE}`).toBeTruthy();
      const code = '8000004468135792';
      const expiredFirst = '9000000005357924681';
      const expired = { status: 410, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CODE_EXPIRED', message: CODE_EXPIRED } }) };
      let calls = 0;
      await page.route(`**/api/mp-codes/${code}`, (route) => {
        calls += 1;
        return calls === 1
          ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ memberId: qiao!.id, memberNo: qiao!.memberNo, name: qiao!.name }) })
          : route.fulfill(expired);
      });
      let expiredCalls = 0;
      await page.route(`**/api/mp-codes/${expiredFirst}`, (route) => {
        expiredCalls += 1;
        return route.fulfill(expired);
      });

      await page.goto('/dining/tables');
      await page.getByTestId(`table-tile-${B1}`).click();
      const openDialog = page.getByRole('dialog').filter({ hasText: `开台 · 桌 ${B1}` });
      const search = openDialog.getByTestId('table-member-search');
      // ① 第一次扫：直接登记上乔木
      await search.fill(code);
      await expect(openDialog.getByTestId('table-member')).toContainText('乔木');
      // ② 不登记，再扫同一个码（这次过期）：写明原因、查找框留着码、没有登记会员
      await openDialog.getByTestId('table-member').getByRole('button', { name: '不登记' }).click();
      await expect(openDialog.getByTestId('table-member')).toHaveCount(0);
      await search.fill(code);
      await expect(openDialog.getByTestId('table-member-code-error')).toHaveText(CODE_EXPIRED);
      await expect(search).toHaveValue(code);
      await expect(openDialog.getByTestId('table-member')).toHaveCount(0);
      expect(calls).toBe(2);
      // ③ 对照：第一次就过期的码
      await search.fill(expiredFirst);
      await expect(openDialog.getByTestId('table-member-code-error')).toHaveText(CODE_EXPIRED);
      await expect(search).toHaveValue(expiredFirst);
      await expect(openDialog.getByTestId('table-member')).toHaveCount(0);
      expect(expiredCalls).toBe(1);
      // 没有开台
      await openDialog.getByRole('button', { name: '取消' }).click();
      await expect(openDialog).toHaveCount(0);
      expect(await sessionOf(page, B1)).toBeNull();
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await relogin(page, 'linlan');
      await cleanup(page);
    }
  });
});
