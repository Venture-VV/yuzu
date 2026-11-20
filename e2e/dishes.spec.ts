// 8.1.15 菜品管理浏览器验收（docs/DISHES_V8115.md）：
//   餐饮里的「菜品管理」页签 → 新增一道带做法、加料的菜 → 新增一个套餐（含哪几样、每样几份）→ 搜索与按出品口、状态筛
//   → 改价（写原因，改价记录里看得到改前改后）→ 下架、上架（点单页的菜单马上跟上）→ 导出全部（Excel）→ 导入（先预览再生效）
//   → 点单页：点这道菜弹出做法与加料，选好加进已点（加料另起一行、备注「配 某菜」），套餐一行（写着含的几样），下单
//   → 厨房出品屏上写着做法、「配 某菜」、套餐含哪几样。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。
// 菜品不能删：每次用不同的后缀建菜，结束时都下架；专用档口（E2E 菜品 开头）留着下次沿用；餐饮功能的开关恢复成开始时的样子。可重复执行。
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { navItem } from './nav';
import type { DiningAdmin, DiningMenu, KitchenBoard } from '../src/shared/dining';
import type { DishRow, DishSaveResult, DishesBoard } from '../src/shared/dishes';
import { expectFits } from './fits';

const PASSWORD = 'yuzu2026';
const HOT = 'E2E 菜品 热菜';
const BAR = 'E2E 菜品 水吧';
/** 这一次的后缀：菜名不重复，搜它就只看到这一次建的 */
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const NOODLE = `牛肉面 ${RUN}`;
const EGG = `加蛋 ${RUN}`;
const TEA = `柠檬茶 ${RUN}`;
const COMBO = `面茶套餐 ${RUN}`;

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  // 门店账号进主导航，只用 ERP 的账号（后勤）进 ERP
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
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

const dishes = async (page: Page) => (await getJson<DishesBoard>(page, '/api/dining/dishes')).dishes;
const dishOf = async (page: Page, name: string) => (await dishes(page)).find((d) => d.name === name)!;
const row = (page: Page, name: string) => page.getByTestId(`dish-row-${name}`);

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}

test.describe('8.1.15 菜品管理', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改菜品与规则的流程只在门店电脑尺寸执行一次');
  test.setTimeout(240_000);

  test('新增（做法、加料、套餐）→ 筛选 → 改价 → 上下架 → 导出、导入 → 点单选做法与加料、点套餐 → 厨房屏', async ({ page }) => {
    await login(page, 'linlan');
    const before = (await getJson<DiningAdmin>(page, '/api/admin/dining')).rules;
    let visitId: number | null = null;
    try {
      // ① 准备：开着餐饮；两个专用档口；加料「加蛋」、套餐里的「柠檬茶」用接口建（下面在页面上建牛肉面与套餐）
      await send(page, 'put', '/api/admin/dining/rules', { enabled: true, trackServed: true });
      let admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
      for (const name of [HOT, BAR]) {
        const old = admin.stations.find((s) => s.name === name);
        if (!old) admin = await send<DiningAdmin>(page, 'post', '/api/admin/dining/stations', { name });
        else if (!old.active) admin = await send<DiningAdmin>(page, 'put', `/api/admin/dining/stations/${old.id}`, { name, sortOrder: old.sortOrder, active: true });
      }
      const hot = admin.stations.find((s) => s.name === HOT)!.id;
      const bar = admin.stations.find((s) => s.name === BAR)!.id;
      const make = (body: Record<string, unknown>) => send<DishSaveResult>(page, 'post', '/api/dining/dishes', { clientKey: randomUUID(), category: 'E2E 菜品', ...body });
      await make({ name: EGG, slot: 'restaurant:餐饮', stationId: hot, prices: { standard: 300 } });
      await make({ name: TEA, slot: 'water:手作饮料', stationId: bar, prices: { standard: 1500 } });

      // ② 餐饮 → 菜品管理（有菜品权限的才有这个页签）
      await page.goto('/dining');
      await page.getByTestId('dining-tab-dishes').click();
      await expect(page.getByTestId('dishes')).toBeVisible();
      await expect(page.getByTestId('dishes-summary')).toContainText('你能维护餐厅、水吧、果吧的菜');
      await expect(row(page, EGG)).toBeVisible();

      // ③ 新增一道菜：牛肉面，两种做法（一个点常用的、一个手写），加料选「加蛋」
      await page.getByTestId('dishes-new').click();
      const editor = page.getByTestId('dish-editor');
      await expect(editor).toBeVisible();
      await page.getByTestId('dish-name').fill(NOODLE);
      await page.getByTestId('dish-slot').selectOption('restaurant:餐饮');
      await page.getByTestId('dish-station').selectOption({ label: HOT });
      await page.getByTestId('dish-category').fill('E2E 菜品');
      await page.getByTestId('dish-price-input-standard').fill('38');
      await editor.getByRole('button', { name: '+ 微辣' }).click();
      await page.getByTestId('dish-method-input').fill('面硬');
      await page.getByTestId('dish-method-add').click();
      await expect(page.getByTestId('dish-methods')).toContainText('微辣');
      await expect(page.getByTestId('dish-methods')).toContainText('面硬');
      await page.getByTestId('dish-addon-search').fill(EGG);
      await page.getByTestId(`dish-addon-pick-${EGG}`).click();
      await expect(page.getByTestId('dish-addons')).toContainText(EGG);
      await expectFits(page);
      await page.getByTestId('dish-save').click();
      await expect(page.getByText(`已新增「${NOODLE}」`)).toBeVisible();
      await expect(row(page, NOODLE)).toContainText('做法 微辣、面硬');
      await expect(row(page, NOODLE)).toContainText(`加料 ${EGG}`);
      await expect(page.getByTestId(`dish-price-text-${NOODLE}`)).toContainText('38');

      // ④ 新增一个套餐：含牛肉面 ×1、柠檬茶 ×2
      await page.getByTestId('dishes-new').click();
      await page.getByTestId('dish-name').fill(COMBO);
      await page.getByTestId('dish-slot').selectOption('restaurant:餐饮');
      await page.getByTestId('dish-station').selectOption({ label: HOT });
      await page.getByTestId('dish-category').fill('E2E 菜品');
      await page.getByTestId('dish-price-input-standard').fill('48');
      await page.getByTestId('dish-combo-search').fill(NOODLE);
      await page.getByTestId(`dish-combo-pick-${NOODLE}`).click();
      await page.getByTestId('dish-combo-search').fill(TEA);
      await page.getByTestId(`dish-combo-pick-${TEA}`).click();
      await page.getByTestId(`dish-combo-qty-${TEA}`).fill('2');
      await page.getByTestId('dish-save').click();
      await expect(page.getByText(`已新增「${COMBO}」`)).toBeVisible();
      await expect(page.getByTestId(`dish-combo-${COMBO}`)).toContainText(`含 ${NOODLE}×1、${TEA}×2`);
      // 进了套餐的菜不能再做成套餐：编辑牛肉面时套餐内容那一段写明原因
      await page.getByTestId(`dish-edit-${NOODLE}`).click();
      await expect(page.getByTestId('dish-combo-blocked')).toContainText(`套餐「${COMBO}」`);
      await page.keyboard.press('Escape');

      // ⑤ 搜索与筛选：搜这一次的后缀只看到这四道；按水吧只剩柠檬茶；按状态
      await page.getByTestId('dishes-search').fill(RUN);
      await expect(page.locator('[data-testid^="dish-row-"]')).toHaveCount(4);
      await page.getByTestId('dishes-outlet-water').click();
      await expect(page.locator('[data-testid^="dish-row-"]')).toHaveCount(1);
      await expect(row(page, TEA)).toBeVisible();
      await page.getByTestId('dishes-outlet-all').click();
      await page.getByRole('radiogroup', { name: '状态' }).getByRole('radio', { name: '下架' }).click();
      await expect(page.locator('[data-testid^="dish-row-"]')).toHaveCount(0);
      await expect(page.getByText('没有符合条件的菜品')).toBeVisible();
      await page.getByRole('radiogroup', { name: '状态' }).getByRole('radio', { name: '全部' }).click();
      await expect(page.locator('[data-testid^="dish-row-"]')).toHaveCount(4);
      await expectFits(page);

      // ⑥ 改价：38 → 42，写原因；表上的价变了，改价记录里有改前改后
      await page.getByTestId(`dish-price-${NOODLE}`).click();
      await expect(page.getByTestId('dish-price-dialog')).toBeVisible();
      await expect(page.getByTestId('dish-price-save')).toBeDisabled();
      await page.getByTestId('dish-price-new-standard').fill('42');
      await expect(page.getByTestId('dish-price-diff')).toContainText('标准 ¥38.00 → ¥42.00');
      await page.getByTestId('dish-price-reasons').getByRole('button', { name: '食材涨价' }).click();
      await expectFits(page);
      await page.getByTestId('dish-price-save').click();
      await expect(page.getByText(`「${NOODLE}」已改价`)).toBeVisible();
      await expect(page.getByTestId(`dish-price-text-${NOODLE}`)).toContainText('42');
      await page.getByTestId('dishes-history').click();
      const history = page.getByTestId('dish-price-history');
      await expect(history.locator('li').first()).toContainText(NOODLE);
      await expect(history.locator('li').first()).toContainText('标准 ¥38.00 → ¥42.00');
      await expect(history.locator('li').first()).toContainText('食材涨价');
      await page.keyboard.press('Escape');

      // ⑦ 下架、上架：一点就生效，点单页的菜单马上没有 / 又有
      const inMenu = async (name: string) => (await getJson<DiningMenu>(page, '/api/dining/menu')).dishes.some((d) => d.name === name);
      expect(await inMenu(TEA)).toBe(true);
      await page.getByTestId(`dish-toggle-${TEA}`).click();
      await expect(page.getByText(`「${TEA}」已下架`)).toBeVisible();
      await expect(row(page, TEA)).toHaveAttribute('data-active', 'false');
      expect(await inMenu(TEA)).toBe(false);
      await page.getByTestId(`dish-toggle-${TEA}`).click();
      await expect(page.getByText(`「${TEA}」已上架`)).toBeVisible();
      await expect(row(page, TEA)).toHaveAttribute('data-active', 'true');
      expect(await inMenu(TEA)).toBe(true);

      // ⑧ 导出全部：下载一份 Excel
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('dishes-export').click()]);
      expect((await readFile((await download.path())!)).subarray(0, 2).toString('latin1')).toBe('PK'); // .xlsx 是 zip
      // 文件名在响应头里（无头浏览器的 suggestedFilename 不一定认 filename*）
      const head = await page.request.get('/api/dining/dishes/export.xlsx');
      expect(decodeURIComponent(head.headers()['content-disposition'] ?? '')).toMatch(/菜品_\d{4}-\d{2}-\d{2}\.xlsx/);

      // ⑨ 导入：给柠檬茶加两种做法（先预览、再生效）
      await page.getByTestId('dishes-import').click();
      await expect(page.getByTestId('dish-import')).toBeVisible();
      await expect(page.getByTestId('dish-import-apply')).toBeDisabled();
      await page.getByTestId('dish-import-file').setInputFiles({ name: '菜品.csv', mimeType: 'text/csv', buffer: Buffer.from(`名称,做法\r\n${TEA},去冰、少冰\r\n`, 'utf8') });
      await page.getByTestId('dish-import-preview').click();
      await expect(page.getByTestId('dish-import-result')).toContainText('修改 1 道');
      await expect(page.getByTestId('dish-import-changes')).toContainText('做法 （没有） → 去冰、少冰');
      await expectFits(page);
      await page.getByTestId('dish-import-apply').click();
      await expect(page.getByText('已导入：新建 0 道、修改 1 道')).toBeVisible();
      await expect(row(page, TEA)).toContainText('做法 去冰、少冰');

      // ⑩ 点单：接待一位男宾 → 点牛肉面弹出做法与加料 → 选微辣、加蛋 ×2、写备注 → 再点套餐（直接一行）→ 下单
      const tags = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags;
      const tag = tags
        .filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)
        .map((t) => t.code)
        .reverse()[0]!;
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: 'E2E 菜品客人' }] });
      visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;
      await page.getByTestId('dining-tab-order').click();
      await page.getByTestId('dining-tag').fill(tag);
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest')).toContainText('E2E 菜品客人');
      await page.getByTestId('dining-outlet-restaurant').click();
      await expect(page.getByTestId(`dining-dish-${NOODLE}`)).toContainText('可选做法、加料');
      await expect(page.getByTestId(`dining-dish-${COMBO}`)).toContainText(`含 ${NOODLE}×1、${TEA}×2`);
      await page.getByTestId(`dining-dish-${NOODLE}`).click();
      const options = page.getByTestId('dish-options');
      await expect(options).toBeVisible();
      await page.getByTestId('dish-options-method-微辣').click();
      await page.getByTestId(`dish-options-addon-add-${EGG}`).click();
      await page.getByTestId(`dish-options-addon-qty-${EGG}`).fill('2');
      await page.getByTestId('dish-options-note').fill('多放葱');
      await expect(page.getByTestId('dish-options-preview')).toContainText('微辣，多放葱');
      await expectFits(page);
      await page.getByTestId('dish-options-add').click();
      await expect(options).toHaveCount(0);
      await expect(page.getByTestId('dining-note-0')).toHaveValue('微辣，多放葱');
      await expect(page.getByTestId('dining-line-1')).toContainText(EGG);
      await expect(page.getByTestId('dining-note-1')).toHaveValue(`配 ${NOODLE}`);
      await page.getByTestId(`dining-dish-${COMBO}`).click();
      await expect(page.getByTestId('dining-line-combo-2')).toContainText(`套餐含 ${NOODLE}×1、${TEA}×2`);
      // 合计：牛肉面 42 + 加蛋 3×2 + 套餐 48 = 96
      await expect(page.getByTestId('dining-cart')).toContainText('96');
      await page.getByTestId('dining-submit').click();
      await expect(page.getByText(`${tag} 已下单`)).toBeVisible();

      // ⑪ 出品单：做法在备注里，加料写「配 牛肉面」，套餐列出含的几样；账上的金额对
      const mine = (await getJson<KitchenBoard>(page, '/api/kitchen')).items.filter((k) => k.visitId === visitId);
      expect(mine.map((k) => `${k.name}×${k.quantity}|${k.note}|${k.parts.map((p) => `${p.name}×${p.quantity}`).join('、')}`)).toEqual([
        `${NOODLE}×1|微辣，多放葱|`,
        `${EGG}×2|配 ${NOODLE}|`,
        `${COMBO}×1||${NOODLE}×1、${TEA}×2`,
      ]);
      const bill = await getJson<{ lines: { name: string; amount: number; status: string }[] }>(page, `/api/frontdesk/visits/${visitId}`);
      expect(bill.lines.filter((l) => l.status === 'active').reduce((n, l) => n + l.amount, 0)).toBe(4200 + 600 + 4800);
      await page.getByTestId('dining-tab-kitchen').click();
      const comboTicket = page.getByTestId(`kds-${mine[2]!.id}`);
      await expect(comboTicket).toContainText(`含 ${NOODLE}×1、${TEA}×2`);
      await expect(page.getByTestId(`kds-${mine[1]!.id}`)).toContainText(`配 ${NOODLE}`);
      await expect(page.getByTestId(`kds-${mine[0]!.id}`)).toContainText('微辣，多放葱');
      await expectFits(page);
    } finally {
      // 收尾：退掉点的菜、客人撤销离店（不结账、不碰钱箱）；这一次建的菜都下架；餐饮功能恢复成开始时的样子
      if (visitId !== null) {
        const v = await getJson<{ lines: { id: number; status: string }[] }>(page, `/api/frontdesk/visits/${visitId}`);
        for (const l of v.lines.filter((x) => x.status === 'active')) await page.request.post(`/api/frontdesk/lines/${l.id}/void`, { data: { reason: 'E2E：菜品管理收尾' } });
        await page.request.post(`/api/frontdesk/visits/${visitId}/cancel`, { data: { reason: 'E2E：菜品管理收尾' } });
      }
      for (const d of (await dishes(page)).filter((x: DishRow) => x.name.endsWith(RUN) && x.active)) {
        await page.request.post(`/api/dining/dishes/${d.id}/active`, { data: { clientKey: randomUUID(), active: false } });
      }
      const res = await page.request.put('/api/admin/dining/rules', { data: { enabled: before.enabled, trackServed: before.trackServed } });
      expect(res.ok(), await res.text()).toBe(true);
    }
    expect((await dishOf(page, NOODLE)).active).toBe(false);
  });

  test('维护权限按出品口：只有水吧权限的看得到全部、餐厅的改不了；只有菜品权限、进不了餐饮的岗位从主导航的「菜品」进来', async ({ page }) => {
    const HOT_DISH = `权限面 ${RUN}`;
    const BAR_DISH = `权限茶 ${RUN}`;
    await login(page, 'linlan');
    const before = (await getJson<DiningAdmin>(page, '/api/admin/dining')).rules;
    const perms = await getJson<{ effective: Record<string, string[]> }>(page, '/api/admin/permissions');
    const restore = { duty_manager: perms.effective.duty_manager!, backoffice: perms.effective.backoffice! };
    try {
      await send(page, 'put', '/api/admin/dining/rules', { enabled: true });
      let admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
      for (const name of [HOT, BAR]) {
        const old = admin.stations.find((s) => s.name === name);
        if (!old) admin = await send<DiningAdmin>(page, 'post', '/api/admin/dining/stations', { name });
        else if (!old.active) admin = await send<DiningAdmin>(page, 'put', `/api/admin/dining/stations/${old.id}`, { name, sortOrder: old.sortOrder, active: true });
      }
      const make = (body: Record<string, unknown>) => send<DishSaveResult>(page, 'post', '/api/dining/dishes', { clientKey: randomUUID(), category: 'E2E 菜品', prices: { standard: 2000 }, ...body });
      const hot = (await make({ name: HOT_DISH, slot: 'restaurant:餐饮', stationId: admin.stations.find((s) => s.name === HOT)!.id })).dish;
      await make({ name: BAR_DISH, slot: 'water:糖水', stationId: admin.stations.find((s) => s.name === BAR)!.id });
      // 值班经理加「维护水吧的菜品」（没有定价与改价）；后勤去掉「厨房出品屏」、加「维护果吧的菜品」——只剩菜品权限、进不了餐饮
      await send(page, 'put', '/api/admin/permissions', {
        roles: { duty_manager: [...restore.duty_manager, 'dish.water'], backoffice: [...restore.backoffice.filter((p) => p !== 'dining.kitchen'), 'dish.fruit'] },
      });

      // ① 值班经理：餐饮里有「菜品管理」；看得到全部，水吧的能改、能上下架，餐厅的按钮是灰的；不能新增、不能改价
      await relogin(page, 'zhangjl');
      await page.goto('/dining');
      await page.getByTestId('dining-tab-dishes').click();
      await expect(page.getByTestId('dishes-summary')).toContainText('你能维护水吧的菜；餐厅、果吧的看得到、改不了');
      await expect(page.getByTestId('dishes-summary')).toContainText('没有「定价与改价」的权限');
      await expect(page.getByTestId('dishes-new')).toHaveCount(0);
      await page.getByTestId('dishes-search').fill(RUN);
      await expect(row(page, HOT_DISH)).toHaveAttribute('data-editable', 'false');
      await expect(row(page, HOT_DISH)).toContainText('只读');
      await expect(page.getByTestId(`dish-edit-${HOT_DISH}`)).toBeDisabled();
      await expect(page.getByTestId(`dish-toggle-${HOT_DISH}`)).toBeDisabled();
      await expect(page.getByTestId(`dish-price-${HOT_DISH}`)).toBeDisabled();
      await expect(row(page, BAR_DISH)).toHaveAttribute('data-editable', 'true');
      await expect(page.getByTestId(`dish-edit-${BAR_DISH}`)).toBeEnabled();
      await expect(page.getByTestId(`dish-price-${BAR_DISH}`)).toBeDisabled();
      await page.getByTestId(`dish-toggle-${BAR_DISH}`).click();
      await expect(page.getByText(`「${BAR_DISH}」已下架`)).toBeVisible();
      await expect(page.getByTestId(`dish-state-${BAR_DISH}`)).toContainText('下架');
      // 页面上按钮是灰的不算数：直接调接口改餐厅的菜也被拒绝
      const denied = await page.request.post(`/api/dining/dishes/${hot.id}/active`, { data: { clientKey: randomUUID(), active: false } });
      expect(denied.status()).toBe(403);
      expect(((await denied.json()) as { error: { message: string } }).error.message).toContain('没有餐厅的菜品维护权限');
      await expectFits(page);
      // 进得了餐饮的人打开单独的入口，直接到餐饮里的那个页签（不留两个一样的页面）
      await page.goto('/dishes');
      await expect(page).toHaveURL(/\/dining\/dishes$/);
      await expect(page.getByTestId('dishes')).toBeVisible();

      // ② 后勤（只剩菜品权限）：主导航有「菜品」，打开就是菜品表；餐饮进不去
      await relogin(page, 'lixiao');
      await page.goto('/dishes');
      await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '菜品' })).toBeVisible();
      await expect(navItem(page, '餐饮')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '菜品管理' })).toBeVisible();
      await expect(page.getByTestId('dishes-summary')).toContainText('你能维护果吧的菜；餐厅、水吧的看得到、改不了');
      await page.getByTestId('dishes-search').fill(RUN);
      await expect(row(page, HOT_DISH)).toHaveAttribute('data-editable', 'false');
      await page.goto('/dining/dishes');
      await expect(page).not.toHaveURL(/\/dining/);
    } finally {
      await relogin(page, 'linlan');
      expect((await page.request.put('/api/admin/permissions', { data: { roles: restore } })).ok()).toBe(true);
      for (const d of (await dishes(page)).filter((x: DishRow) => x.name.endsWith(RUN) && x.active)) {
        await page.request.post(`/api/dining/dishes/${d.id}/active`, { data: { clientKey: randomUUID(), active: false } });
      }
      const res = await page.request.put('/api/admin/dining/rules', { data: { enabled: before.enabled, trackServed: before.trackServed } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });
});
