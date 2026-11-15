// S5 餐饮第一步浏览器验收：后台建出品档口、把菜挂到档口、开启餐饮 → 估清页限量 → 点单页按手牌点菜（口味备注）
// → 厨房屏开始做、出餐 → 点单页上菜 → 退菜（限量份数加回）→ 估清后点单页不能点 → 前台账单显示出品状态 → 结账核对列出没上的菜。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
// 专用菜品与档口（E2E 开头）留着下次沿用；结束时关闭餐饮功能、取消估清，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { DiningAdmin, KitchenBoard } from '../src/shared/dining';

const PASSWORD = 'yuzu2026';
const DISHES = [
  { name: 'E2E 宫保鸡丁', category: 'E2E 餐饮', price: 4800, station: 'E2E 热菜' },
  { name: 'E2E 柠檬茶', category: 'E2E 餐饮', price: 1500, station: 'E2E 水吧' },
] as const;
const [HOT, TEA] = DISHES;

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function send(page: Page, method: 'post' | 'put', url: string, data?: unknown) {
  const res = await page.request[method](url, data === undefined ? {} : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return res;
}

const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

type Line = { id: number; name: string; status: string; source: string; kitchen: { status: string; note: string } | null };

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}

/** 店主：专用菜品、档口、菜品的档口都准备好（接口办理），开启餐饮、规则恢复默认 */
async function prepareByApi(page: Page) {
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
    if (!old) admin = (await (await send(page, 'post', '/api/admin/dining/stations', { name })).json()) as DiningAdmin;
    else if (!old.active) admin = (await (await send(page, 'put', `/api/admin/dining/stations/${old.id}`, { name, sortOrder: old.sortOrder, active: true })).json()) as DiningAdmin;
  }
  const items = DISHES.map((d) => ({ id: admin.items.find((i) => i.name === d.name)!.id, stationId: admin.stations.find((s) => s.name === d.station)!.id }));
  await send(page, 'put', '/api/admin/dining/items', { items });
  await send(page, 'put', '/api/admin/dining/rules', { enabled: true, trackServed: true, warnMinutes: 15 });
}

test.describe('S5 餐饮', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改规则的流程只在门店电脑尺寸执行一次');
  test.setTimeout(180_000);

  test('后台建档口、挂菜、开启 → 限量 → 点单 → 厨房出餐 → 上菜 → 退菜 → 估清 → 账单与结账核对', async ({ page }) => {
    await login(page, 'linlan');
    try {
      // ① 店主：专用菜品（没有就建）；后台「餐饮」里建档口、把菜挂到档口、开启餐饮（规则先恢复默认）
      for (const d of DISHES) {
        const items = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items;
        const old = items.find((i) => i.name === d.name);
        const body = { name: d.name, category: d.category, price: d.price };
        if (!old) await send(page, 'post', '/api/items', body);
        else if (!old.active) await send(page, 'put', `/api/items/${old.id}`, { ...body, active: true });
      }
      await send(page, 'put', '/api/admin/dining/rules', { trackServed: true, warnMinutes: 15 });
      await page.goto('/admin');
      await page.getByTestId('admin-nav-dining').click();
      await expect(page.getByTestId('dining-rules-card')).toContainText('餐饮功能');
      await page.getByTestId('subnav-stations').click();
      // 8.0.17：后台「餐饮」分成三个页签——餐饮规则、档口与出品、桌台
      let admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
      for (const name of new Set(DISHES.map((d) => d.station))) {
        const old = admin.stations.find((s) => s.name === name);
        if (!old) {
          await page.getByTestId('dining-station-new').click();
          await page.getByTestId('dining-station-name').fill(name);
          await page.getByTestId('dining-station-save').click();
          await expect(page.getByTestId(`dining-station-${name}`)).toBeVisible();
        } else if (!old.active) {
          await send(page, 'put', `/api/admin/dining/stations/${old.id}`, { name, sortOrder: old.sortOrder, active: true });
        }
      }
      await page.reload();
      admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
      // 菜品列表只列挂了档口的菜；价目里的其他项目收在「从价目里添加菜品」里，需要技师的项目两处都不列出（店主 2026-10-30）
      const other = admin.items.find((i) => i.stationId === null && !i.technicianRequired && !DISHES.some((d) => d.name === i.name));
      const tech = admin.items.find((i) => i.technicianRequired);
      if (other) await expect(page.getByTestId(`dining-item-${other.name}`)).toHaveCount(0);
      await page.getByTestId('dining-items-add').click();
      await expect(page.getByTestId('dining-items-candidates')).toBeVisible();
      if (other) await expect(page.getByTestId(`dining-item-${other.name}`)).toHaveCount(1);
      if (tech) await expect(page.getByTestId(`dining-item-${tech.name}`)).toHaveCount(0);
      let changed = 0;
      for (const d of DISHES) {
        const station = admin.stations.find((s) => s.name === d.station)!;
        if (admin.items.find((i) => i.name === d.name)!.stationId === station.id) continue;
        // 还没挂档口的菜在「从价目里添加菜品」里，选了档口就移到上面的菜品里
        await page.getByTestId(`dining-item-station-${d.name}`).selectOption({ label: d.station });
        changed += 1;
      }
      if (changed) {
        await page.getByTestId('dining-items-save').click();
        await expect(page.getByText('菜品的出品档口已保存')).toBeVisible();
      }
      await page.getByTestId('subnav-rules').click();
      const rules = page.getByTestId('dining-rules-card');
      await rules.getByRole('radiogroup', { name: '餐饮功能' }).getByRole('radio', { name: '开启' }).click();
      const save = page.getByTestId('dining-rules-save');
      if (await save.isEnabled()) {
        await save.click();
        await expect(page.getByText('餐饮规则已保存')).toBeVisible();
      }
      await noHorizontalScroll(page);
      await page.request.post('/api/auth/logout');

      // ② 前台：接待一位男宾；主导航有「餐饮」
      await login(page, 'xiaozhou');
      const board = await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board');
      const tag = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse()[0]!;
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: 'E2E 点单客人' }] });
      const visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;
      await page.goto('/');
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '餐饮' }).click();

      // ③ 估清页：柠檬茶今天限量 2 份（上一轮留下的先取消）
      await page.getByTestId('dining-tab-limits').click();
      const teaLimit = page.getByTestId(`limit-${TEA.name}`);
      if (await teaLimit.getByTestId(`limit-clear-${TEA.name}`).isVisible()) {
        await teaLimit.getByTestId(`limit-clear-${TEA.name}`).click();
        await expect(teaLimit).toContainText('不限量');
      }
      await teaLimit.getByTestId(`limit-set-${TEA.name}`).click();
      await teaLimit.getByTestId(`limit-input-${TEA.name}`).fill('2');
      await teaLimit.getByTestId(`limit-save-${TEA.name}`).click();
      await expect(teaLimit).toContainText('剩 2 份');

      // ④ 点单：按手牌找客人，宫保鸡丁（少辣）+ 柠檬茶，下单就是挂账
      await page.getByTestId('dining-tab-order').click();
      await page.getByTestId('dining-tag').fill(tag);
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest')).toContainText('E2E 点单客人');
      await page.getByTestId(`dining-dish-${HOT.name}`).click();
      await page.getByTestId('dining-line-0').getByRole('button', { name: '少辣' }).click();
      await expect(page.getByTestId('dining-note-0')).toHaveValue('少辣');
      await expect(page.getByTestId(`dining-dish-${TEA.name}`)).toContainText('剩 2');
      await page.getByTestId(`dining-dish-${TEA.name}`).click();
      await expect(page.getByTestId('dining-cart')).toContainText('63.00');
      await page.getByTestId('dining-submit').click();
      await expect(page.getByText(`${tag} 已下单`)).toBeVisible();
      const pending = page.getByTestId('dining-pending');
      await expect(pending.getByTestId(`dining-pending-${HOT.name}`)).toContainText('少辣');
      await expect(pending.getByTestId(`dining-pending-${TEA.name}`)).toContainText('待做');
      await expect(page.getByTestId(`dining-dish-${TEA.name}`)).toContainText('剩 1');
      let lines = (await getJson<{ lines: Line[] }>(page, `/api/frontdesk/visits/${visitId}`)).lines;
      expect(lines.filter((l) => l.source === 'dining').map((l) => [l.name, l.kitchen?.status, l.kitchen?.note])).toEqual([
        [HOT.name, 'queued', '少辣'],
        [TEA.name, 'queued', ''],
      ]);

      // ⑤ 厨房屏：宫保鸡丁开始做 → 出餐（看全部档口，口味备注醒目）
      await page.getByTestId('dining-tab-kitchen').click();
      const all = page.getByTestId('kds-station-全部档口');
      if (await all.isVisible()) await all.click();
      const hot = page.getByTestId('kds-col-queued').getByTestId(/^kds-\d+$/).filter({ hasText: tag }).filter({ hasText: HOT.name });
      await expect(hot).toContainText('少辣');
      const hotId = (await hot.getAttribute('data-testid'))!.replace('kds-', '');
      await page.getByTestId(`kds-start-${hotId}`).click();
      await expect(page.getByTestId('kds-col-cooking').getByTestId(`kds-${hotId}`)).toBeVisible();
      await page.getByTestId(`kds-done-${hotId}`).click();
      await expect(page.getByTestId('kds-col-done').getByTestId(`kds-${hotId}`)).toBeVisible();
      await noHorizontalScroll(page);

      // ⑥ 回到点单页：客人还在；宫保鸡丁已出餐，服务员送到后点「上菜」；柠檬茶退菜，限量份数加回
      await page.getByTestId('dining-tab-order').click();
      await expect(page.getByTestId('dining-guest')).toContainText(tag);
      await expect(pending.getByTestId(`dining-pending-${HOT.name}`)).toContainText('已出餐', { timeout: 20_000 });
      await pending.getByTestId(`dining-serve-${hotId}`).click();
      await expect(pending.getByTestId(`dining-pending-${HOT.name}`)).toHaveCount(0);
      await pending.getByTestId(`dining-pending-${TEA.name}`).getByRole('button', { name: '退菜' }).click();
      await page.getByRole('dialog').locator('#reason-text').fill('E2E：客人不要了');
      await page.getByRole('dialog').getByRole('button', { name: '确认退菜' }).click();
      await expect(page.getByText(`${TEA.name} 已退`)).toBeVisible();
      await expect(pending.getByTestId(`dining-pending-${TEA.name}`)).toHaveCount(0);
      await expect(page.getByTestId(`dining-dish-${TEA.name}`)).toContainText('剩 2');
      const kb = await getJson<KitchenBoard>(page, '/api/kitchen');
      expect(kb.items.filter((k) => k.visitId === visitId).map((k) => [k.name, k.status]).sort()).toEqual([
        [HOT.name, 'served'],
        [TEA.name, 'cancelled'],
      ].sort());

      // ⑦ 估清：柠檬茶卖完了，点单页不能点；取消后恢复
      await page.getByTestId('dining-tab-limits').click();
      await teaLimit.getByTestId(`limit-soldout-${TEA.name}`).click();
      await expect(teaLimit).toContainText('已估清');
      await page.getByTestId('dining-tab-order').click();
      await expect(page.getByTestId(`dining-dish-${TEA.name}`)).toBeDisabled();
      await expect(page.getByTestId(`dining-dish-${TEA.name}`)).toContainText('已估清');
      await page.getByTestId('dining-tab-limits').click();
      await teaLimit.getByTestId(`limit-clear-${TEA.name}`).click();
      await expect(teaLimit).toContainText('不限量');

      // ⑧ 再点一份柠檬茶（不上）；前台账单显示出品状态，结账核对列出还没上的菜
      await page.getByTestId('dining-tab-order').click();
      await expect(page.getByTestId(`dining-dish-${TEA.name}`)).toBeEnabled();
      await page.getByTestId(`dining-dish-${TEA.name}`).click();
      await page.getByTestId('dining-submit').click();
      await expect(pending.getByTestId(`dining-pending-${TEA.name}`)).toContainText('待做');
      await noHorizontalScroll(page);
      await page.goto('/frontdesk');
      await page.getByTestId(`tag-${tag}`).click();
      const panel = page.getByTestId('bill-panel');
      await expect(panel).toContainText('餐饮');
      await expect(panel.getByTestId(/^line-\d+-kitchen$/).filter({ hasText: '少辣' })).toContainText('已上菜');
      await expect(panel.getByTestId(/^line-\d+-kitchen$/).filter({ hasText: '待做' })).toHaveCount(1);
      await panel.getByTestId('action-checkout').click();
      await expect(page.getByTestId('checkout-dishes')).toContainText(`${TEA.name} × 1 · 待做`);
      await page.keyboard.press('Escape');
      lines = (await getJson<{ lines: Line[] }>(page, `/api/frontdesk/visits/${visitId}`)).lines;
      expect(lines.filter((l) => l.source === 'dining').map((l) => [l.name, l.status])).toEqual([
        [HOT.name, 'active'],
        [TEA.name, 'voided'],
        [TEA.name, 'active'],
      ]);
      // 收尾：没上的柠檬茶退掉，客人撤销离店（不结账、不碰钱箱）
      for (const l of lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason: 'E2E：收尾' });
      await send(page, 'post', `/api/frontdesk/visits/${visitId}/cancel`, { reason: 'E2E：餐饮流程收尾' });
    } finally {
      // 关闭餐饮功能（不影响其他流程）；档口与专用菜品留着，下次沿用
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      const res = await page.request.put('/api/admin/dining/rules', { data: { enabled: false } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });

  test('点单响应丢失：刷新后顶部仍提醒待确认，到前台按原内容重新提交只生效一次，页面正常', async ({ page }) => {
    await login(page, 'linlan');
    try {
      await prepareByApi(page);
      await page.request.post('/api/auth/logout');
      await login(page, 'xiaozhou');
      const board = await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board');
      const tag = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse()[0]!;
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male' }] });
      const visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;
      // 下单请求真实到达服务器并入账，但浏览器收不到响应；查回也先连不上
      await page.route('**/api/dining/orders', async (route) => {
        await route.fetch();
        await route.abort('connectionreset');
      }, { times: 1 });
      await page.route('**/api/frontdesk/ops/*', (route) => route.abort('connectionreset'));
      await page.goto('/dining/order');
      await page.getByTestId('dining-tag').fill(tag);
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest')).toBeVisible();
      await page.getByTestId(`dining-dish-${HOT.name}`).click();
      await page.getByTestId('dining-submit').click();
      await expect(page.getByTestId('dining-cart').getByTestId('pending-op')).toContainText(HOT.name);
      await expect(page.getByTestId(`dining-dish-${TEA.name}`)).toBeDisabled();
      // 刷新后顶部提醒仍在 → 去前台处理 → 按原内容重新提交（同一编号，只生效一次）
      await page.reload();
      const banner = page.getByTestId('frontdesk-pending-banner');
      await expect(banner).toContainText(tag);
      await banner.getByRole('button', { name: '去处理' }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: '加项目' });
      await expect(dialog.getByTestId('pending-op')).toContainText(HOT.name);
      await dialog.getByTestId('pending-retry').click();
      await expect(page.getByText(`已挂到 ${tag}`)).toBeVisible();
      await expect(banner).toHaveCount(0);
      await page.unroute('**/api/frontdesk/ops/*');
      const lines = (await getJson<{ lines: Line[] }>(page, `/api/frontdesk/visits/${visitId}`)).lines;
      expect(lines.map((l) => [l.name, l.source, l.status, l.kitchen?.status])).toEqual([[HOT.name, 'dining', 'active', 'queued']]);
      await expect(page.getByTestId('bill-panel')).toContainText(HOT.name);
      // 收尾：退菜、撤销来访
      for (const l of lines) await send(page, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason: 'E2E：收尾' });
      await send(page, 'post', `/api/frontdesk/visits/${visitId}/cancel`, { reason: 'E2E：餐饮流程收尾' });
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      const res = await page.request.put('/api/admin/dining/rules', { data: { enabled: false } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });

  test('换一位时菜篮里还有没下单的菜：先问清空还是保留，保留的在下单处标明记到谁、从谁带来；份数可以直接输；菜单取不回来有重试', async ({ page }) => {
    // 店主 2026-11-14 的需求 5（同类的 1、4 一起核对）：原来点「换一位」菜篮悄悄跟到下一位，下单按钮直接变成另一个手牌。只点菜不下单。
    await login(page, 'linlan');
    const visits: number[] = [];
    try {
      await prepareByApi(page);
      await page.request.post('/api/auth/logout');
      await login(page, 'xiaozhou');
      const free = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse();
      const [a, b] = [free[0]!, free[1]!];
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: a, zone: 'male', guestLabel: 'E2E 甲' }] });
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: b, zone: 'male', guestLabel: 'E2E 乙' }] });
      const after = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags;
      visits.push(after.find((t) => t.code === a)!.visit!.id, after.find((t) => t.code === b)!.visit!.id);

      // 菜单第一次取不回来：写明加载失败、有重试，不说「还没有进厨房的菜」；放开后点重试正常
      await page.route('**/api/dining/menu', (route) => route.abort('connectionreset'));
      await page.goto('/dining/order');
      const failed = page.getByTestId('dining-menu-error');
      await expect(failed).toBeVisible({ timeout: 30_000 });
      await expect(failed).toContainText('菜单加载失败');
      await expect(page.getByTestId('dining-menu')).not.toContainText('还没有进厨房的菜');
      await page.getByTestId('dining-tag').fill(a);
      await page.unroute('**/api/dining/menu');
      await page.getByTestId('dining-menu-error-retry').click();
      await expect(page.getByTestId(`dining-dish-${HOT.name}`)).toBeVisible();
      await expect(page.getByTestId('dining-tag')).toHaveValue(a);

      // 甲：点一份宫保鸡丁；份数直接输成 4（不用点三下加号），输 150 按 99 算并提示，输空了离开回到原来的数
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest')).toContainText(a);
      await page.getByTestId(`dining-dish-${HOT.name}`).click();
      const qty = page.getByTestId('dining-qty-0');
      await expect(qty).toHaveValue('1');
      await qty.fill('4');
      await expect(page.getByTestId('dining-cart')).toContainText('192.00');
      await qty.fill('150');
      await expect(qty).toHaveValue('99');
      await expect(page.getByTestId('dining-qty-hint')).toContainText('最多 99');
      await qty.fill('');
      await qty.blur();
      await expect(qty).toHaveValue('99');
      await expect(page.getByTestId('dining-qty-hint')).toContainText('1–99');
      await qty.fill('1');
      await expect(page.getByTestId('dining-qty-hint')).toHaveCount(0);
      // 下单处最上面：记到谁（手牌号、客人）、几份
      const target = page.getByTestId('dining-target');
      await expect(target).toContainText(a);
      await expect(target).toContainText('E2E 甲');
      await expect(target).toContainText('1 份');

      // 换一位：弹确认，默认聚焦「清空菜篮」；点右上角关闭不换人、菜篮不动
      await page.getByTestId('dining-switch-guest').click();
      const ask = page.getByRole('dialog').filter({ has: page.getByTestId('dining-switch') });
      await expect(ask.getByTestId('dining-switch')).toContainText(`当前有 1 份未下单的菜品（${HOT.name} ×1）`);
      await expect(page.getByTestId('dining-switch-clear')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(ask).toHaveCount(0);
      await expect(page.getByTestId('dining-guest')).toContainText(a);
      await expect(page.getByTestId('dining-line-0')).toContainText(HOT.name);

      // 保留并换人 → 找乙：下单处写明记到乙、这些菜是从甲带过来的；下单按钮是乙
      await page.getByTestId('dining-switch-guest').click();
      await page.getByTestId('dining-switch-keep').click();
      await expect(page.getByTestId('dining-guest')).toHaveCount(0);
      await expect(page.getByTestId('dining-carried')).toContainText(a);
      await page.getByTestId('dining-tag').fill(b);
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest')).toContainText(b);
      await expect(target).toContainText(b);
      await expect(target).toContainText('E2E 乙');
      await expect(target).toContainText('1 份');
      await expect(page.getByTestId('dining-carried')).toContainText(`这些菜是从 ${a} 带过来的`);
      await expect(page.getByTestId('dining-carried')).toContainText(`现在会记到 ${b} 的账上`);
      await expect(page.getByTestId('dining-submit')).toHaveText(`下单 · ${b}`);

      // 已经找到乙、直接输甲的手牌再找：同样先问；这次清空
      await page.getByTestId('dining-tag').fill(a);
      await page.getByTestId('dining-find').click();
      await expect(ask.getByTestId('dining-switch')).toContainText('1 份未下单');
      await page.getByTestId('dining-switch-clear').click();
      await expect(page.getByTestId('dining-guest')).toContainText(a);
      await expect(page.getByTestId('dining-cart')).toContainText('点菜单里的菜加进来');
      await expect(page.getByTestId('dining-carried')).toHaveCount(0);
      await expect(page.getByTestId('dining-target')).toHaveCount(0);
      // 菜篮空着换人不问
      await page.getByTestId('dining-switch-guest').click();
      await expect(ask).toHaveCount(0);
      await expect(page.getByTestId('dining-guest')).toHaveCount(0);
      // 什么都没有下单
      for (const id of visits) expect((await getJson<{ lines: Line[] }>(page, `/api/frontdesk/visits/${id}`)).lines).toEqual([]);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      for (const id of visits) await page.request.post(`/api/frontdesk/visits/${id}/cancel`, { data: { reason: 'E2E：换一位用例收尾' } });
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      const res = await page.request.put('/api/admin/dining/rules', { data: { enabled: false } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });
});
