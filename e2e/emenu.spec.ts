// 8.0.10 点餐系统 · 平板电子菜单的浏览器验收（docs/EMENU.md 第 10 节）。
// ① 会写数据的整套流程（只在门店电脑这一组执行一次；平板那一段另开 1024×768 的浏览器窗口）：
//    后台排菜单（分类、版面、菜品图文、设置）→ 员工账号里给服务员生成点单密码、本人在「修改密码」页重新生成
//    →「点餐平板」账号首次登录改密码后直接进点餐页，别的页面与接口进不去 → 输手牌、桌号、人数 → 翻页、加菜、
//    多规格进详情选、搜索 → 未下单里加减、备注 → 旧的点单密码被拒、新的下单成功 → 已下单；
//    前台账单与厨房屏有这一单（经办人是服务员、带桌号与整单备注）；估清后平板标「已售罄」；点手牌结束点餐。
// ② 各尺寸（门店电脑、平板横屏、平板竖屏）：合成菜单代替接口、只读——整页按 1024×768 等比缩放、不出滚动条，
//    1024×768 时几处文字正好在设计稿量的位置上。
// ③ 8.0.13（docs/EMENU.md 第 11 节，合成菜单、只读）：「中 | EN」切换（录了英文的显示英文、没录的显示中文、切回来位置不变、
//    结束点餐回到中文、后台关掉就没有开关）；键盘弹起（正在输入时窗口变矮）页面不缩放、结果列表在键盘上面；
//    拖动翻页与两头的回弹、关掉菜品详情时留一个退场的影子、「减少动态效果」时都没有。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
// 专用的菜品、档口、分类（E2E 开头）与平板账号 e2epad 留着下次沿用；结束时关掉平板点餐与餐饮、停用平板账号，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { DiningAdmin, KitchenBoard } from '../src/shared/dining';
import type { EmenuAdmin, EmenuMenu } from '../src/shared/emenu';
import type { StaffRecord } from '../src/shared/types';

const PASSWORD = 'yuzu2026';
const PAD = { username: 'e2epad', password: 'e2e-pad-2026' };
const CATEGORY = 'E2E 平板点餐';
const STATION = 'E2E 热菜';
const ITEMS = [
  { name: 'E2E 平板砂锅鱼（大份）', price: 8800 },
  { name: 'E2E 平板砂锅鱼（小份）', price: 4200 },
  { name: 'E2E 平板小炒肉', price: 4800 },
  { name: 'E2E 平板柠檬茶', price: 1500 },
] as const;
const FISH = { name: 'E2E 平板砂锅鱼', nameEn: 'E2E Casserole Fish', specs: [ITEMS[0], ITEMS[1]] };
const PORK = { name: 'E2E 平板小炒肉', nameEn: 'E2E Stir Fried Pork', specs: [ITEMS[2]] };
const TEA = { name: 'E2E 平板柠檬茶', nameEn: 'E2E Lemon Tea', specs: [ITEMS[3]] };

async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.getByRole('button', { name: '登录' }).click();
}

async function loginStaff(page: Page, username: string) {
  await login(page, username);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
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

const noScroll = async (page: Page) =>
  expect(await page.evaluate(() => [document.documentElement.scrollWidth - window.innerWidth, document.documentElement.scrollHeight - window.innerHeight])).toEqual([0, 0]);

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}
type Line = { id: number; name: string; quantity: number; status: string; source: string; kitchen: { status: string; note: string } | null };

/** 店主：专用的价目项目、档口、菜品图文、分类（接口办理），餐饮开着；版面与开关留给页面上做。返回菜品与项目的编号 */
async function prepareByApi(page: Page) {
  let catalog = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items;
  for (const it of ITEMS) {
    const old = catalog.find((i) => i.name === it.name);
    const body = { name: it.name, category: 'E2E 平板', price: it.price };
    if (!old) await send(page, 'post', '/api/items', body);
    else if (!old.active) await send(page, 'put', `/api/items/${old.id}`, { ...body, active: true });
  }
  catalog = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items;
  const itemId = (name: string) => catalog.find((i) => i.name === name)!.id;
  let dining = await getJson<DiningAdmin>(page, '/api/admin/dining');
  const station = dining.stations.find((s) => s.name === STATION);
  if (!station) dining = await send<DiningAdmin>(page, 'post', '/api/admin/dining/stations', { name: STATION });
  else if (!station.active) dining = await send<DiningAdmin>(page, 'put', `/api/admin/dining/stations/${station.id}`, { name: STATION, sortOrder: station.sortOrder, active: true });
  const stationId = dining.stations.find((s) => s.name === STATION)!.id;
  await send(page, 'put', '/api/admin/dining/items', { items: ITEMS.map((it) => ({ id: itemId(it.name), stationId })) });
  await send(page, 'put', '/api/admin/dining/rules', { enabled: true, trackServed: true, warnMinutes: 15 });
  // 上一轮留下的估清先取消
  for (const it of ITEMS) await send(page, 'put', `/api/kitchen/limits/${itemId(it.name)}`, { remaining: null });

  let admin = await getJson<EmenuAdmin>(page, '/api/admin/emenu');
  for (const d of [FISH, PORK, TEA]) {
    const specs = d.specs.map((s) => ({ itemId: itemId(s.name), label: d.specs.length > 1 ? (s.name.includes('大份') ? '大份' : '小份') : '' }));
    const body = { name: d.name, nameEn: d.nameEn, tagline: '', description: d === FISH ? 'E2E：砂锅慢焗的鱼。' : '', attrs: [], unit: '份', imageId: null, detailImageId: null, specs };
    const old = admin.dishes.find((x) => x.name === d.name);
    admin = old ? await send<EmenuAdmin>(page, 'put', `/api/admin/emenu/dishes/${old.id}`, { ...body, active: true, version: old.version }) : await send<EmenuAdmin>(page, 'post', '/api/admin/emenu/dishes', body);
  }
  // 分类留着就清空各页（下面在页面上重新排）；设置恢复默认、先关着
  const cat = admin.categories.find((c) => c.name === CATEGORY);
  if (cat) {
    admin = await send<EmenuAdmin>(page, 'put', `/api/admin/emenu/categories/${cat.id}`, { name: CATEGORY, nameEn: 'E2E TABLET', window: null, sortOrder: cat.sortOrder, active: true, version: cat.version });
    const again = admin.categories.find((c) => c.name === CATEGORY)!;
    admin = await send<EmenuAdmin>(page, 'put', `/api/admin/emenu/categories/${again.id}/pages`, { version: again.version, pages: [] });
  }
  admin = await send<EmenuAdmin>(page, 'put', '/api/admin/emenu/rules', {
    rev: admin.rulesRev,
    enabled: false,
    avoidOptions: ['不加香菜', '不加辣椒', '少辣', '不加洋葱', '不加香葱', '重辣'],
    serveOptions: ['即起', '慢起'],
    idleMinutes: 10,
    offHours: 'hide',
    // 这一条走的是「要点单密码」「设计稿原样」的一套（8.0.15 起默认是不要密码、放大）；默认的那一套另有用例
    requirePin: true,
    textSize: 'design',
  });
  const dishId = (name: string) => admin.dishes.find((x) => x.name === name)!.id;
  return { itemId, dishId, hadCategory: !!cat, tables: admin.tables };
}

/** 店主：平板账号 e2epad（没有就建、停用的启用），每次都重置出一个临时密码 */
async function prepareTablet(page: Page): Promise<{ id: number; temporaryPassword: string }> {
  let staff = await getJson<StaffRecord[]>(page, '/api/staff');
  let pad = staff.find((s) => s.username === PAD.username);
  if (!pad) {
    await send(page, 'post', '/api/staff', { username: PAD.username, displayName: 'E2E 点餐平板', role: 'tablet', duties: [] });
    staff = await getJson<StaffRecord[]>(page, '/api/staff');
    pad = staff.find((s) => s.username === PAD.username)!;
  } else if (!pad.active || pad.role !== 'tablet') {
    await send(page, 'put', `/api/staff/${pad.id}`, { displayName: pad.displayName, role: 'tablet', duties: [], active: true });
  }
  const { temporaryPassword } = await send<{ temporaryPassword: string }>(page, 'post', `/api/staff/${pad.id}/reset-password`);
  return { id: pad.id, temporaryPassword };
}

const tabletContext = (browser: Browser, baseURL: string | undefined) =>
  browser.newContext({ baseURL, viewport: { width: 1024, height: 768 }, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });

/** 合成的菜单（只读用例用，代替接口）：两个分类，一页「两菜 · 并排」、一页「分类封面」。默认是「要点单密码」「设计稿原样」，rules 可以改 */
function syntheticMenu(rules: Partial<EmenuMenu['rules']> = {}): EmenuMenu {
  const dish = (id: number, name: string, nameEn: string, price: number) => ({
    id,
    name,
    nameEn,
    tagline: '',
    description: '',
    attrs: [],
    unit: '份',
    taglineEn: '',
    descriptionEn: '',
    attrsEn: [],
    unitEn: '',
    imageUrl: null,
    detailUrl: null,
    specs: [{ itemId: 9000 + id, label: '', labelEn: '', price, state: 'ok' as const, remaining: null }],
  });
  return {
    serverTime: new Date().toISOString(),
    businessDate: '2026-11-11',
    enabled: true,
    rules: { footerText: 'COPYRIGHT©2026 汤崎 ALL RIGHTS RESERVED', avoidOptions: ['不加香菜'], serveOptions: ['即起'], idleMinutes: 0, offHours: 'hide', langSwitch: true, optionsEn: {}, motion: true, requirePin: true, textSize: 'design', coverUrl: null, ...rules },
    categories: [
      { id: 1, name: '西式午餐', nameEn: 'WESTERN LUNCH', window: null, open: true, pages: [{ layout: 'duo_row', title: '', titleEn: '', dishes: [dish(1, '温泉蛋黑松露奶油意粉', 'Hot Spring Egg And Black Truffle Cream Spaghetti', 4200), dish(2, '和牛牛肉汉堡', 'Wagyu Beef Burger', 4200)] }] },
      { id: 2, name: '中式午餐', nameEn: 'CHINESE LUNCH', window: null, open: true, pages: [{ layout: 'cover', title: '', titleEn: '', dishes: [dish(3, '广式猪脚姜浸花胶', 'Cantonese Pork Trotter Ginger Vinegar Fish Maw', 4200)] }] },
    ],
    later: [],
    tables: [],
  };
}

/** 合成的接口（只读用例用）：菜单、按手牌找客人、核对桌号；写请求一律掐掉并记下来 */
async function mockEmenu(page: Page, menu: () => EmenuMenu): Promise<string[]> {
  const writes: string[] = [];
  await page.route('**/api/emenu/**', (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') {
      writes.push(url.pathname);
      return route.abort();
    }
    if (url.pathname === '/api/emenu/menu') return route.fulfill({ json: menu() });
    if (url.pathname === '/api/emenu/guest') return route.fulfill({ json: { visitId: 1, tagCode: 'A8060', ordered: [], orderedTotal: 0 } });
    if (url.pathname === '/api/emenu/table') return route.fulfill({ json: { tableName: 'A01' } });
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '没有' } } });
  });
  return writes;
}

/** 起始页 → 输手牌 8060、桌号 01、2 人 → 进菜单 */
async function enterMenu(page: Page) {
  await page.getByTestId('emenu-start').click();
  for (const d of '8060') await page.getByTestId(`emenu-key-${d}`).click();
  await page.getByTestId('emenu-field-table').click();
  await page.getByTestId('emenu-key-clear').click();
  for (const d of '01') await page.getByTestId(`emenu-key-${d}`).click();
  await page.getByTestId('emenu-field-guests').click();
  await page.getByTestId('emenu-key-2').click();
  await page.getByTestId('emenu-ask-go').click();
  await expect(page.getByTestId('emenu-header')).toBeVisible();
}

/** 清掉这台浏览器里平板点餐页存的东西（这一次点餐、待确认的记录） */
const clearEmenuStorage = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('yuzu.emenu.')).forEach((k) => localStorage.removeItem(k)));

test.describe('8.0.10 点餐系统 · 平板电子菜单', () => {
  test('后台排菜单、发点单密码 → 平板账号登录 → 点餐、备注、服务员确认下单 → 账单与厨房屏 → 估清 → 结束点餐', async ({ page, browser, baseURL }, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑这一组执行一次（平板那一段另开 1024×768 的窗口）');
    test.setTimeout(300_000);
    await loginStaff(page, 'linlan');
    const clerkPage = await (await browser.newContext({ baseURL, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })).newPage();
    const pad = await (await tabletContext(browser, baseURL)).newPage();
    let visitId: number | null = null;
    let padId: number | null = null;
    try {
      const prep = await prepareByApi(page);
      const fishId = prep.dishId(FISH.name);
      const porkId = prep.dishId(PORK.name);
      const teaId = prep.dishId(TEA.name);
      const [fishBig, fishSmall, porkItem, teaItem] = ITEMS.map((it) => prep.itemId(it.name)) as [number, number, number, number];

      // ① 后台「电子菜单」：还没开时列出还差什么；建分类（上一轮留着的沿用）、排两页、保存
      await page.goto('/admin/emenu');
      await expect(page.getByTestId('emenu-admin-status')).toContainText('平板点餐还没开启');
      if (!prep.hadCategory) {
        await page.getByTestId('emenu-admin-category-new').click();
        const dialog = page.getByRole('dialog').filter({ hasText: '新建分类' });
        await dialog.getByLabel('名称', { exact: true }).fill(CATEGORY);
        await dialog.getByLabel('英文名').fill('E2E TABLET');
        await dialog.getByTestId('emenu-admin-category-save').click();
        await expect(page.getByText(`已新建分类「${CATEGORY}」`)).toBeVisible();
      }
      await page.getByTestId(`emenu-admin-category-${CATEGORY}`).click();
      await page.getByTestId('emenu-admin-page-add').click();
      await page.getByTestId('emenu-admin-page-layout-0').selectOption('duo_row');
      await page.getByTestId('emenu-admin-slot-0-0').selectOption(String(porkId));
      // 同一道菜放两次：页面上先说、不能保存
      await page.getByTestId('emenu-admin-slot-0-1').selectOption(String(porkId));
      await expect(page.getByTestId('emenu-admin-page-problem-0')).toContainText('放了两次');
      await expect(page.getByTestId('emenu-admin-pages-save')).toBeDisabled();
      await page.getByTestId('emenu-admin-slot-0-1').selectOption(String(teaId));
      await page.getByTestId('emenu-admin-page-add').click();
      await page.getByTestId('emenu-admin-page-layout-1').selectOption('list_text');
      await page.getByTestId('emenu-admin-page-title-1').fill('招牌');
      await page.getByTestId('emenu-admin-slot-1-0').selectOption(String(fishId));
      // 预览照平板的样子画：第 1 页里有这两道菜
      await expect(page.getByTestId('emenu-admin-page-0').getByTestId('emenu-admin-preview')).toContainText(PORK.name);
      await expect(page.getByTestId('emenu-admin-page-0').getByTestId('emenu-admin-preview')).toContainText(TEA.name);
      await page.getByTestId('emenu-admin-pages-save').click();
      await expect(page.getByText(`「${CATEGORY}」的版面已保存`)).toBeVisible();
      // 菜品图文：改一道菜的小字
      await page.getByTestId('subnav-dishes').click();
      await page.getByTestId(`emenu-admin-dish-${PORK.name}`).click();
      const dishDialog = page.getByRole('dialog').filter({ hasText: '修改菜品' });
      await dishDialog.getByLabel('名称后的小字').fill('例份');
      await dishDialog.getByTestId('emenu-admin-dish-save').click();
      await expect(page.getByText('菜品已保存')).toBeVisible();
      await expect(page.getByTestId(`emenu-admin-dish-${PORK.name}`)).toContainText('例份');
      // 设置：打开平板点餐
      await page.getByTestId('subnav-settings').click();
      await page.getByTestId('emenu-admin-settings').getByRole('radiogroup', { name: '平板点餐' }).getByRole('radio', { name: '开启' }).click();
      await page.getByTestId('emenu-admin-settings-save').click();
      await expect(page.getByText('电子菜单的设置已保存')).toBeVisible();
      // 规则总表里有这一项
      await page.goto('/admin/settings');
      await expect(page.getByText('平板点餐', { exact: true }).first()).toBeVisible();

      // ①′ 8.0.13 英文：在「菜品图文」里给砂锅鱼填英文介绍与规格的英文；用「英文对照表」给小炒肉换一个英文名
      await page.goto('/admin/emenu');
      await page.getByTestId('subnav-dishes').click();
      await page.getByTestId(`emenu-admin-dish-${FISH.name}`).click();
      const enDialog = page.getByRole('dialog').filter({ hasText: '修改菜品' });
      await enDialog.getByLabel('英文介绍').fill('E2E: fish slow-baked in a clay pot.');
      await enDialog.getByTestId('emenu-admin-spec-en-1').fill('Half');
      await enDialog.getByTestId('emenu-admin-dish-save').click();
      await expect(page.getByText('菜品已保存')).toBeVisible();
      await page.getByTestId('emenu-admin-english').click();
      const sheet = page.getByTestId('emenu-admin-english-dialog');
      await expect(sheet.getByTestId('emenu-admin-english-export')).toBeVisible();
      const exported = await page.request.get('/api/admin/emenu/english.csv');
      expect(exported.ok()).toBe(true);
      expect(await exported.text()).toContain(`${fishId},${FISH.name},${FISH.nameEn},`);
      await sheet.getByTestId('emenu-admin-english-file').setInputFiles({ name: '英文对照表.csv', mimeType: 'text/csv', buffer: Buffer.from(`\uFEFF编号,菜名,英文名\r\n${porkId},${PORK.name},E2E Wok Fried Pork\r\n999999999,没有这道菜,Ghost\r\n`, 'utf8') });
      await expect(sheet.getByTestId('emenu-admin-english-preview')).toContainText('读到 2 行');
      await expect(sheet.getByTestId('emenu-admin-english-preview')).toContainText('1 行的编号对不上');
      await page.getByTestId('emenu-admin-english-apply').click();
      await expect(sheet.getByTestId('emenu-admin-english-result')).toContainText('更新了 1 道菜');
      await page.getByRole('button', { name: '关闭' }).last().click();

      // ② 员工账号：给前台小周生成点单密码（只显示一次）；岗位里有「点餐平板」
      const tablet = await prepareTablet(page);
      padId = tablet.id;
      await page.goto('/admin/staff');
      await expect(page.getByText('E2E 点餐平板')).toBeVisible();
      await page.getByTestId('staff-pin-xiaozhou').click();
      await page.getByTestId('staff-pin-make').click();
      const firstPin = (await page.getByTestId('staff-secret').innerText()).trim();
      expect(firstPin).toMatch(/^\d{6}$/);
      await page.getByRole('button', { name: '我已告知' }).click();
      await expect(page.getByTestId('staff-pin-badge-xiaozhou')).toBeVisible();
      // 本人在「修改密码」页重新生成：旧的马上失效
      await loginStaff(clerkPage, 'xiaozhou');
      await clerkPage.goto('/password');
      const card = clerkPage.getByTestId('order-pin-card');
      await expect(card.getByTestId('order-pin-status')).toContainText('已有点单密码');
      await card.getByTestId('order-pin-make').click();
      await card.getByTestId('order-pin-confirm').click();
      const pin = (await card.getByTestId('order-pin-value').innerText()).trim();
      expect(pin).toMatch(/^\d{6}$/);
      expect(pin).not.toBe(firstPin);

      // ③ 接待一位客人（接口办理）
      const board = await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board');
      const tag = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse()[0]!;
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: 'E2E 平板点餐客人' }] });
      visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;
      // 桌号：店里建了桌台的用第一张（平板上只输里面的数字，对得上几张时点选）；没建桌台的照输入的记
      const table = prep.tables.find((t) => /\d/.test(t.name))?.name ?? (prep.tables.length ? prep.tables[0]!.name : 'E2E01');
      const tableTyped = prep.tables.length ? table.replace(/\D/g, '') || table : table;

      // ④ 平板：「点餐平板」账号首次登录先改密码，之后直接进点餐页；别的页面回到点餐页，门店系统别的接口被拒
      await login(pad, PAD.username, tablet.temporaryPassword);
      await expect(pad.getByRole('heading', { name: '设置你的密码' })).toBeVisible({ timeout: 30_000 });
      await pad.fill('#cur', tablet.temporaryPassword);
      await pad.fill('#new', PAD.password);
      await pad.fill('#confirm', PAD.password);
      await pad.getByRole('button', { name: '保存新密码' }).click();
      await expect(pad).toHaveURL(/\/emenu$/, { timeout: 30_000 });
      await expect(pad.getByTestId('emenu-start')).toBeVisible();
      await noScroll(pad);
      await pad.goto('/admin');
      await expect(pad).toHaveURL(/\/emenu$/);
      await pad.goto('/frontdesk');
      await expect(pad).toHaveURL(/\/emenu$/);
      expect((await pad.request.get('/api/members?q=1')).status()).toBe(403);
      expect((await pad.request.get('/api/frontdesk/board')).status()).toBe(403);

      // ⑤ 输入信息：手牌用键盘打（扫码枪也是这样进来的），桌号、人数用弹窗上的数字键盘
      await pad.getByTestId('emenu-start').click();
      await expect(pad.getByTestId('emenu-ask')).toBeVisible();
      await pad.keyboard.type(tag);
      await expect(pad.getByTestId('emenu-field-tag')).toHaveAttribute('data-value', tag);
      await pad.getByTestId('emenu-field-table').click();
      await pad.getByTestId('emenu-key-clear').click();
      await pad.keyboard.type(tableTyped);
      await pad.getByTestId('emenu-field-guests').click();
      await pad.getByTestId('emenu-key-3').click();
      await pad.getByTestId('emenu-ask-go').click();
      const pickTable = pad.getByTestId(`emenu-pick-${table}`);
      await expect(pad.getByTestId('emenu-header').or(pickTable)).toBeVisible();
      if (await pickTable.isVisible()) await pickTable.click();
      await expect(pad.getByTestId('emenu-header')).toBeVisible();
      await expect(pad.getByTestId('emenu-tag')).toContainText(tag);

      // ⑥ 菜单：点分类页签到这一类的第 1 页；单规格的直接加，多规格的进详情选
      const menu = await getJson<EmenuMenu>(page, '/api/emenu/menu');
      const cat = menu.categories.find((c) => c.name === CATEGORY)!;
      expect(cat.pages.map((p) => p.layout)).toEqual(['duo_row', 'list_text']);
      await pad.getByTestId(`emenu-cat-${cat.id}`).click();
      const page1 = pad.locator('[data-layout=duo_row]').filter({ has: pad.getByTestId(`emenu-dish-${porkId}`) });
      await expect(page1.getByTestId(`emenu-dish-${porkId}`)).toContainText(PORK.name);
      await expect(page1.getByTestId(`emenu-dish-${porkId}`)).toContainText('(例份)');
      await expect(page1.getByTestId(`emenu-dish-${porkId}`)).toContainText('48');
      // 8.0.13 点「EN」：后台刚录的英文显示出来（对照表导入的英文名、内置的单位）；再点换回中文接着点
      await pad.getByTestId('emenu-lang').click();
      await expect(page1.getByTestId(`emenu-name-${porkId}`)).toContainText('E2E Wok Fried Pork');
      await expect(page1.getByTestId(`emenu-dish-${porkId}`)).toContainText('/portion');
      await pad.getByTestId('emenu-lang').click();
      await expect(page1.getByTestId(`emenu-name-${porkId}`)).toContainText(PORK.name);
      await page1.getByTestId(`emenu-add-${porkId}`).click();
      await page1.getByTestId(`emenu-add-${porkId}`).click();
      await expect(pad.getByTestId('emenu-order-count')).toHaveText('2');
      // 搜索：跳到那道菜所在的页
      await pad.getByTestId('emenu-search-open').click();
      await pad.getByTestId('emenu-search-input').fill('砂锅鱼');
      await pad.getByTestId(`emenu-search-hit-${fishId}`).click();
      const fishRow = pad.getByTestId(`emenu-dish-${fishId}`);
      await expect(fishRow).toBeInViewport();
      await expect(pad.locator('[data-layout=list_text]').filter({ has: fishRow }).getByTestId('emenu-vtitle')).toHaveText('招牌');
      // 多规格：点加号进详情，选「小份」再加
      await pad.getByTestId(`emenu-add-${fishId}`).click();
      const detail = pad.getByTestId('emenu-detail');
      await expect(detail.getByTestId('emenu-detail-name')).toContainText(FISH.name);
      await expect(detail.getByTestId('emenu-detail-price')).toContainText('88');
      // 详情里切到英文：英文介绍、规格的英文（大份用内置的 Large，小份是后台填的 Half）
      await pad.getByTestId('emenu-lang').click();
      await expect(detail.getByTestId('emenu-detail-desc')).toHaveText('E2E: fish slow-baked in a clay pot.');
      await expect(detail.getByTestId(`emenu-spec-${fishBig}`)).toHaveText('Large');
      await expect(detail.getByTestId(`emenu-spec-${fishSmall}`)).toHaveText('Half');
      await pad.getByTestId('emenu-lang').click();
      await expect(detail.getByTestId(`emenu-spec-${fishSmall}`)).toHaveText('小份');
      await detail.getByTestId(`emenu-spec-${fishSmall}`).click();
      await expect(detail.getByTestId('emenu-detail-price')).toContainText('42');
      await detail.getByTestId('emenu-detail-add').click();
      await detail.getByTestId('emenu-detail-close').click();
      await expect(pad.getByTestId('emenu-order-count')).toHaveText('3');

      // ⑦ 订单抽屉：未下单里加减；备注（忌口多选、起菜方式单选、自己写）
      await pad.getByTestId('emenu-order-open').click();
      const drawer = pad.getByTestId('emenu-drawer');
      await expect(drawer.getByTestId(`emenu-cart-${porkItem}`)).toContainText(PORK.name);
      await expect(drawer.getByTestId(`emenu-cart-${fishSmall}`)).toContainText('小份');
      await drawer.getByTestId(`emenu-minus-${porkItem}`).click();
      await expect(drawer.getByTestId(`emenu-qty-${porkItem}`)).toHaveText('1');
      await drawer.getByTestId(`emenu-plus-${fishSmall}`).click();
      await expect(drawer.getByTestId(`emenu-qty-${fishSmall}`)).toHaveText('2');
      await expect(drawer.getByTestId('emenu-cart-note')).toContainText('¥132');
      await drawer.getByTestId('emenu-remark-open').click();
      const remark = pad.getByTestId('emenu-remark');
      await remark.getByTestId('emenu-remark-不加香菜').click();
      await remark.getByTestId('emenu-remark-少辣').click();
      await remark.getByTestId('emenu-remark-tab-serve').click();
      await remark.getByTestId('emenu-remark-即起').click();
      await remark.getByTestId('emenu-remark-custom-open').click();
      await remark.getByTestId('emenu-remark-custom').fill('鱼要嫩一点');
      await remark.getByTestId('emenu-remark-done').click();
      await expect(pad.getByTestId('emenu-remark-open')).toContainText('不加香菜，少辣，即起，鱼要嫩一点');

      // ⑧ 确认下单：带出手牌、桌号、人数；旧的点单密码被拒；新的下单成功
      await pad.getByTestId('emenu-submit').click();
      const confirm = pad.getByTestId('emenu-confirm');
      await expect(confirm.getByTestId('emenu-field-tag')).toHaveAttribute('data-value', tag);
      await expect(confirm.getByTestId('emenu-field-guests')).toHaveAttribute('data-value', '3');
      const press = async (digits: string) => {
        for (const d of digits) await confirm.getByTestId(`emenu-key-${d}`).click();
      };
      await press(firstPin);
      await expect(confirm.getByTestId('emenu-field-pin')).toHaveAttribute('data-value', '******');
      await confirm.getByTestId('emenu-confirm-go').click();
      await expect(confirm.getByTestId('emenu-error')).toContainText('点单密码不正确');
      await press(pin);
      await confirm.getByTestId('emenu-confirm-go').click();
      await expect(pad.getByTestId('emenu-success')).toBeVisible();
      await expect(pad.getByTestId('emenu-success')).toBeHidden({ timeout: 10_000 });
      // 已下单：这张手牌点过的菜与合计；未下单清空了
      await pad.getByTestId('emenu-order-open').click();
      await pad.getByTestId('emenu-tab-ordered').click();
      await expect(pad.getByTestId('emenu-ordered-total')).toContainText('132');
      await expect(pad.getByTestId('emenu-ordered')).toContainText(PORK.name);
      await pad.getByTestId('emenu-tab-cart').click();
      await expect(pad.getByTestId('emenu-cart')).toContainText('还没有点菜');
      // 点抽屉左边压暗的地方关掉抽屉
      await pad.mouse.click(100, 400);
      await expect(pad.getByTestId('emenu-drawer')).toBeHidden();

      // ⑨ 门店系统这边：账单上有这两道菜（餐饮、带整单备注），厨房屏上写着送到哪张桌、经办人是服务员
      const lines = (await getJson<{ lines: Line[] }>(page, `/api/frontdesk/visits/${visitId}`)).lines.filter((l) => l.status === 'active');
      expect(lines.map((l) => [l.name, l.quantity, l.source, l.kitchen?.note]).sort()).toEqual(
        [
          [ITEMS[2].name, 1, 'dining', '不加香菜，少辣，即起，鱼要嫩一点'],
          [ITEMS[1].name, 2, 'dining', '不加香菜，少辣，即起，鱼要嫩一点'],
        ].sort(),
      );
      const kitchen = (await getJson<KitchenBoard>(page, '/api/kitchen')).items.filter((i) => i.visitId === visitId);
      expect(kitchen).toHaveLength(2);
      const clerk = (await getJson<StaffRecord[]>(page, '/api/staff')).find((s) => s.username === 'xiaozhou')!;
      for (const k of kitchen) {
        expect(k.deliverTo).toBe(table);
        expect(k.postedByName).toBe(clerk.displayName);
        expect(k.tagCode).toBe(tag);
      }
      // 前台账单页也看得到
      await page.goto('/frontdesk');
      await page.getByTestId(`tag-${tag}`).click();
      await expect(page.getByTestId('bill-panel')).toContainText(ITEMS[1].name);
      await expect(page.getByTestId('bill-panel')).toContainText(ITEMS[2].name);

      // ⑩ 估清：厨房把柠檬茶设成估清，平板刷新后标「已售罄」、加号点不了；这一次点餐（手牌、桌号）刷新后还在
      await send(page, 'put', `/api/kitchen/limits/${teaItem}`, { remaining: 0 });
      await pad.reload();
      await expect(pad.getByTestId('emenu-tag')).toContainText(tag);
      await pad.getByTestId(`emenu-cat-${cat.id}`).click();
      const tea = pad.getByTestId(`emenu-dish-${teaId}`);
      await expect(tea).toHaveAttribute('data-block', 'sold_out');
      await expect(tea).toContainText('已售罄');
      await expect(pad.getByTestId(`emenu-add-${teaId}`)).toBeDisabled();
      await send(page, 'put', `/api/kitchen/limits/${teaItem}`, { remaining: null });
      expect(fishBig).toBeGreaterThan(0);

      // ⑪ 点手牌结束点餐：回到起始页
      await pad.getByTestId('emenu-tag').click();
      await pad.getByTestId('emenu-end-ok').click();
      await expect(pad.getByTestId('emenu-start')).toBeVisible();

      // ⑫ 自检全部一致（平板点餐单与餐饮明细）
      const checks = await getJson<{ key: string; ok: boolean }[]>(page, '/api/frontdesk/checks');
      expect(checks.map((c) => c.key)).toContain('emenu_orders');
      expect(checks.filter((c) => !c.ok)).toEqual([]);
    } finally {
      // 收尾：退掉没上的菜、撤销来访；关掉平板点餐与餐饮；停用平板账号（分类、菜品图文、点单密码留着）
      await page.request.post('/api/auth/logout');
      await loginStaff(page, 'linlan');
      if (visitId !== null) {
        const left = (await getJson<{ lines: Line[] }>(page, `/api/frontdesk/visits/${visitId}`)).lines.filter((l) => l.status === 'active');
        for (const l of left) await send(page, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason: 'E2E：收尾' });
        await send(page, 'post', `/api/frontdesk/visits/${visitId}/cancel`, { reason: 'E2E：平板点餐流程收尾' });
      }
      const admin = await getJson<EmenuAdmin>(page, '/api/admin/emenu');
      await send(page, 'put', '/api/admin/emenu/rules', { rev: admin.rulesRev, enabled: false });
      await send(page, 'put', '/api/admin/dining/rules', { enabled: false });
      if (padId !== null) await send(page, 'put', `/api/staff/${padId}`, { displayName: 'E2E 点餐平板', role: 'tablet', duties: [], active: false });
      await clerkPage.context().close();
      await pad.context().close();
    }
  });

  test('各尺寸：整页按 1024×768 等比缩放、不出滚动条；1024×768 时文字在设计稿量的位置上（合成菜单，只读）', async ({ page }, info) => {
    const menu = syntheticMenu();
    const writes: string[] = [];
    await page.route('**/api/emenu/**', (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET') {
        writes.push(url.pathname);
        return route.abort();
      }
      if (url.pathname === '/api/emenu/menu') return route.fulfill({ json: menu });
      if (url.pathname === '/api/emenu/guest') return route.fulfill({ json: { visitId: 1, tagCode: 'A8060', ordered: [], orderedTotal: 0 } });
      if (url.pathname === '/api/emenu/table') return route.fulfill({ json: { tableName: 'A01' } });
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '没有' } } });
    });
    // 弹窗、抽屉的出场动画关掉（页面认「减少动态效果」），量位置时不用等
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginStaff(page, 'linlan');
    // 上一条用例（或上一次没走完）留在这台浏览器里的点餐状态不要
    await clearEmenuStorage(page);
    await page.goto('/emenu');
    await expect(page.getByTestId('emenu-start')).toBeVisible();
    const viewport = page.viewportSize()!;
    const scale = Math.min(viewport.width / 1024, viewport.height / 768);
    // 舞台：1024×768 等比缩放、居中、不出滚动条
    const stage = await page.locator('[data-emenu-stage]').boundingBox();
    expect(stage!.width).toBeCloseTo(1024 * scale, 0);
    expect(stage!.height).toBeCloseTo(768 * scale, 0);
    expect(stage!.x).toBeCloseTo((viewport.width - 1024 * scale) / 2, 0);
    expect(stage!.y).toBeCloseTo((viewport.height - 768 * scale) / 2, 0);
    await noScroll(page);
    /** 元素在设计稿坐标里的位置（把屏幕上的位置换算回 1024×768） */
    const at = async (testId: string) => {
      const b = (await page.getByTestId(testId).first().boundingBox())!;
      return { x: (b.x - stage!.x) / scale, y: (b.y - stage!.y) / scale, w: b.width / scale, h: b.height / scale };
    };
    const near = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} ≈ ${expected}`).toBeLessThanOrEqual(1);

    // 输入信息：弹窗与数字键盘在设计稿的位置（弹窗 297.5, 133.7, 429.1 × 500.6；「1」键 448.2, 262.5）
    await page.getByTestId('emenu-start').click();
    const ask = await at('emenu-ask');
    near(ask.x, 297.5);
    near(ask.y, 133.7);
    near(ask.w, 429.1);
    near(ask.h, 500.6);
    const key1 = await at('emenu-key-1');
    near(key1.x, 448.2);
    near(key1.y, 262.5);
    for (const d of '8060') await page.getByTestId(`emenu-key-${d}`).click();
    await page.getByTestId('emenu-field-table').click();
    await page.getByTestId('emenu-key-clear').click();
    for (const d of '01') await page.getByTestId(`emenu-key-${d}`).click();
    await page.getByTestId('emenu-field-guests').click();
    await page.getByTestId('emenu-key-2').click();
    await page.getByTestId('emenu-ask-go').click();
    await expect(page.getByTestId('emenu-header')).toBeVisible();
    await noScroll(page);

    // 顶栏：手牌的色块（898.2, 44.3，高 22.3）、搜索（795.4, 45.4）
    const tag = await at('emenu-tag');
    near(tag.x, 898.2);
    near(tag.y, 44.3);
    near(tag.h, 22.3);
    const search = await at('emenu-search-open');
    near(search.x, 795.4);
    near(search.y, 45.4);
    // 「两菜 · 并排」：两道菜的文字在 39.7 / 426.2、557.1（设计稿）
    const first = await at('emenu-dish-1');
    near(first.x, 39.7);
    near(first.y, 557.1);
    near((await at('emenu-dish-2')).x, 426.2);
    // 分类封面：大标题 37.4, 218.5、48 号字
    await page.getByTestId('emenu-cat-2').click();
    await expect(page.getByTestId('emenu-cover-title')).toBeInViewport();
    await page.waitForTimeout(600);
    const title = await at('emenu-cover-title');
    near(title.x, 37.4);
    near(title.y, 218.5);
    near(title.h, 48);

    // 加菜、订单抽屉（从 598.3 到右边）、备注；不提交
    await page.getByTestId('emenu-add-3').click();
    await expect(page.getByTestId('emenu-order-count')).toHaveText('1');
    await page.getByTestId('emenu-order-open').click();
    const drawer = await at('emenu-drawer');
    near(drawer.x, 598.3);
    near(drawer.w, 425.7);
    await expect(page.getByTestId('emenu-cart-9003')).toContainText('广式猪脚姜浸花胶');
    await page.getByTestId('emenu-remark-open').click();
    await page.getByTestId('emenu-remark-不加香菜').click();
    await page.getByTestId('emenu-remark-done').click();
    await expect(page.getByTestId('emenu-remark-open')).toContainText('不加香菜');
    await noScroll(page);
    expect(writes).toEqual([]);
    // 不把这一次合成的点餐留在浏览器里
    await clearEmenuStorage(page);
  });

  test('下单的请求还在路上：不自动查回、「下单」不放开、只发一次；没有答复 → 结果待确认；重新提交被拒绝时说清楚没有下成（合成接口，只读）', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '这一条看的是下单的先后，与屏幕尺寸无关，只跑一次');
    const menu = syntheticMenu();
    const guest = { visitId: 1, tagCode: 'A8060', ordered: [], orderedTotal: 0 };
    const seen = { posts: [] as string[], lookups: 0, abandons: 0 };
    let mode: 'slow_ok' | 'drop' | 'reject' = 'slow_ok';
    await page.route('**/api/emenu/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === '/api/emenu/menu') return route.fulfill({ json: menu });
      if (url.pathname === '/api/emenu/guest') return route.fulfill({ json: guest });
      if (url.pathname === '/api/emenu/table') return route.fulfill({ json: { tableName: 'A01' } });
      if (url.pathname === '/api/emenu/orders' && req.method() === 'POST') {
        const body = req.postDataJSON() as { clientKey: string; expectedTotal: number };
        seen.posts.push(body.clientKey);
        if (mode === 'drop') return route.abort('connectionreset');
        if (mode === 'reject') return route.fulfill({ status: 422, json: { error: { code: 'DISH_SOLD_OUT', message: '「广式猪脚姜浸花胶」今天已经估清了' } } });
        // 门店系统要 1.5 秒才答复（排锁、网慢）
        await new Promise((r) => setTimeout(r, 1500));
        return route.fulfill({ json: { orderNo: 'D0001', tableName: 'A01', guests: 2, total: body.expectedTotal, quantity: 1, waiterName: '测试服务员', replayed: false, guest } });
      }
      if (url.pathname.startsWith('/api/emenu/orders/by-key/')) {
        if (req.method() === 'GET') {
          seen.lookups += 1;
          return route.fulfill({ json: { found: false, abandoned: false } });
        }
        seen.abandons += 1;
        return route.fulfill({ json: { found: false, abandoned: true } });
      }
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '没有' } } });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginStaff(page, 'linlan');
    await clearEmenuStorage(page);
    await page.goto('/emenu');
    await page.getByTestId('emenu-start').click();
    for (const d of '8060') await page.getByTestId(`emenu-key-${d}`).click();
    await page.getByTestId('emenu-field-table').click();
    await page.getByTestId('emenu-key-clear').click();
    for (const d of '01') await page.getByTestId(`emenu-key-${d}`).click();
    await page.getByTestId('emenu-field-guests').click();
    await page.getByTestId('emenu-key-2').click();
    await page.getByTestId('emenu-ask-go').click();
    await page.getByTestId('emenu-cat-2').click();
    const toConfirm = async () => {
      await page.getByTestId('emenu-add-3').click();
      await page.getByTestId('emenu-order-open').click();
      await page.getByTestId('emenu-submit').click();
      for (const d of '135790') await page.getByTestId('emenu-confirm').getByTestId(`emenu-key-${d}`).click();
    };

    // ① 答复慢：发出去以后这一单已经记在平板上，但不去查回（查不到会把按钮放开、再点就是第二单）；按钮一直是「正在下单…」
    await toConfirm();
    const go = page.getByTestId('emenu-confirm-go');
    await go.click();
    await expect(go).toBeDisabled();
    await page.waitForTimeout(900);
    await expect(go).toBeDisabled();
    await expect(go).toHaveText('正在下单…');
    expect(seen.lookups).toBe(0);
    await expect(page.getByTestId('emenu-success')).toBeVisible();
    await expect(page.getByTestId('emenu-success')).toBeHidden({ timeout: 10_000 });
    expect(seen.posts).toHaveLength(1);
    expect(seen.lookups).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('yuzu.emenu.pending.v1'))).toBeNull();

    // ② 没有答复：弹出「结果待确认」，记录留在平板上；刷新以后还在、进菜单自动查回一次（只读）
    mode = 'drop';
    await toConfirm();
    await go.click();
    const pendingModal = page.getByTestId('emenu-pending');
    await expect(pendingModal).toBeVisible();
    expect(seen.posts).toHaveLength(2);
    const firstKey = seen.posts[1]!;
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('yuzu.emenu.pending.v1') ?? '{}').key)).toBe(firstKey);
    await page.reload();
    await expect(page.getByTestId('emenu-order-count')).toHaveText('!');
    await expect.poll(() => seen.lookups).toBe(1);
    // 点订单图标：出来的是「结果待确认」，不是未下单——处理完之前这台平板不能下新的一单
    await page.getByTestId('emenu-order-open').click();
    await expect(pendingModal).toBeVisible();

    // ③ 重新提交（同一个编号）被门店系统明确拒绝：先作废编号，再告诉服务员没有下成、为什么；菜还在未下单里
    mode = 'reject';
    for (const d of '135790') await pendingModal.getByTestId(`emenu-key-${d}`).click();
    await pendingModal.getByTestId('emenu-pending-retry').click();
    const notice = page.getByTestId('emenu-notice');
    await expect(notice).toContainText('这一单没有下成');
    await expect(notice).toContainText('今天已经估清了');
    expect(seen.posts).toEqual([seen.posts[0], firstKey, firstKey]);
    expect(seen.abandons).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('yuzu.emenu.pending.v1'))).toBeNull();
    await notice.getByTestId('emenu-notice-ok').click();
    await expect(page.getByTestId('emenu-cart-9003')).toContainText('广式猪脚姜浸花胶');
    await expect(page.getByTestId('emenu-submit')).toBeEnabled();
    await clearEmenuStorage(page);
  });

  test('8.0.13 中 | EN：录了英文的显示英文、没录的显示中文；切回来位置不变；结束点餐回到中文；后台关掉就没有开关（合成菜单，只读）', async ({ page }) => {
    const menu = syntheticMenu();
    // 第 1 道菜录了英文介绍与小字；第 2 道只有英文名；封面那道连英文名都没有
    const [first, second] = menu.categories[0]!.pages[0]!.dishes as [EmenuMenu['categories'][0]['pages'][0]['dishes'][0] & object, EmenuMenu['categories'][0]['pages'][0]['dishes'][0] & object];
    Object.assign(first, { tagline: '例份', taglineEn: 'Regular', description: '温泉蛋与黑松露。', descriptionEn: 'Onsen egg and black truffle.' });
    Object.assign(menu.categories[1]!.pages[0]!.dishes[0]!, { nameEn: '', description: '猪脚姜。' });
    const writes = await mockEmenu(page, () => menu);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginStaff(page, 'linlan');
    await clearEmenuStorage(page);
    await page.goto('/emenu');
    await expect(page.getByTestId('emenu-start')).toBeVisible();
    const viewport = page.viewportSize()!;
    const scale = Math.min(viewport.width / 1024, viewport.height / 768);
    const stage = (await page.locator('[data-emenu-stage]').boundingBox())!;
    const at = async (testId: string) => {
      const b = (await page.getByTestId(testId).first().boundingBox())!;
      return { x: (b.x - stage.x) / scale, y: (b.y - stage.y) / scale };
    };
    const near = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} ≈ ${expected}`).toBeLessThanOrEqual(1);

    // 起始页右上角的开关：默认中文；点一下换成英文，输入信息的弹窗跟着是英文
    const lang = page.getByTestId('emenu-lang');
    await expect(lang).toHaveAttribute('data-lang', 'zh');
    await expect(page.getByTestId('emenu')).toHaveAttribute('data-lang', 'zh');
    near((await at('emenu-lang')).x, 936);
    await lang.click();
    await expect(lang).toHaveAttribute('data-lang', 'en');
    await page.getByTestId('emenu-start').click();
    const ask = page.getByTestId('emenu-ask');
    await expect(ask).toContainText('INPUT INFORMATION');
    await expect(ask.getByTestId('emenu-field-tag')).toContainText('Tag');
    await expect(ask.getByTestId('emenu-ask-go')).toHaveText('Start ordering');
    // 弹窗开着时也能换回中文
    await lang.click();
    await expect(ask.getByTestId('emenu-ask-go')).toHaveText('开始点单');
    await expect(ask.getByTestId('emenu-field-tag')).toContainText('手牌');
    await ask.getByTestId('emenu-ask-cancel').click();
    await enterMenu(page);

    // 中文：与 8.0.12 一样（位置是设计稿量的）；顶栏的开关在搜索左边
    const dish1 = page.getByTestId('emenu-dish-1');
    await expect(page.getByTestId('emenu-name-1')).toContainText('温泉蛋黑松露奶油意粉');
    await expect(dish1).toContainText('/份');
    near((await at('emenu-dish-1')).x, 39.7);
    near((await at('emenu-dish-1')).y, 557.1);
    near((await at('emenu-lang')).x, 726);
    near((await at('emenu-search-open')).x, 795.4);

    // 切到英文：英文名为主、中文名还在（小字）；介绍、小字、单位、手牌、分类页签都是英文
    await page.getByTestId('emenu-lang').click();
    await expect(page.getByTestId('emenu')).toHaveAttribute('data-lang', 'en');
    await expect(page.getByTestId('emenu-name-1')).toContainText('Hot Spring Egg And Black Truffle Cream Spaghetti');
    await expect(page.getByTestId('emenu-name-1')).toContainText('(Regular)');
    await expect(dish1).toContainText('温泉蛋黑松露奶油意粉');
    await expect(dish1).toContainText('/portion');
    await expect(page.getByTestId('emenu-tag')).toHaveText('Tag: A8060');
    await expect(page.getByTestId('emenu-cat-1')).toContainText('WESTERN LUNCH');
    // 第 2 道只录了英文名：名字是英文
    await expect(page.getByTestId('emenu-name-2')).toContainText('Wagyu Beef Burger');
    // 菜品详情：英文介绍
    await page.getByTestId('emenu-photo-1').click();
    await expect(page.getByTestId('emenu-detail-name')).toContainText('Hot Spring Egg');
    await expect(page.getByTestId('emenu-detail-desc')).toHaveText('Onsen egg and black truffle.');
    await page.getByTestId('emenu-detail-close').click();
    // 没录英文名的菜（封面那道）照旧显示中文，不留空白；封面的大标题是分类的英文名
    await page.getByTestId('emenu-cat-2').click();
    await expect(page.getByTestId('emenu-cover-title')).toHaveText('CHINESE LUNCH');
    await expect(page.getByTestId('emenu-name-3')).toHaveText('广式猪脚姜浸花胶');
    await expect(page.getByTestId('emenu-dish-3')).toContainText('猪脚姜。');

    // 加菜、订单抽屉、备注：界面是英文；忌口的选项显示内置的英文，交给门店系统的仍是中文选项（这里不提交）
    await page.getByTestId('emenu-add-3').click();
    await expect(page.getByTestId('emenu-toast')).toContainText('added');
    await page.getByTestId('emenu-order-open').click();
    const drawer = page.getByTestId('emenu-drawer');
    await expect(drawer).toContainText('DISH INFORMATION');
    await expect(drawer.getByTestId('emenu-tab-cart')).toHaveText('Cart');
    await expect(drawer.getByTestId('emenu-submit')).toHaveText('Place order (please call our staff)');
    await drawer.getByTestId('emenu-remark-open').click();
    await expect(page.getByTestId('emenu-remark-不加香菜')).toHaveText('No cilantro');
    await page.getByTestId('emenu-remark-不加香菜').click();
    await page.getByTestId('emenu-remark-done').click();
    await expect(page.getByTestId('emenu-remark-open')).toHaveText('Notes: No cilantro');
    // 换回中文：同一份备注显示中文
    await page.mouse.click(100 * scale + stage.x, 400 * scale + stage.y);
    await expect(page.getByTestId('emenu-drawer')).toBeHidden();
    await page.getByTestId('emenu-lang').click();
    await page.getByTestId('emenu-order-open').click();
    await expect(page.getByTestId('emenu-remark-open')).toHaveText('备注：不加香菜');
    await page.mouse.click(100 * scale + stage.x, 400 * scale + stage.y);

    // 页面被系统刷新：这一次点餐的语言还在；结束点餐回到中文（下一位客人从中文开始）
    await page.getByTestId('emenu-lang').click();
    await page.reload();
    await expect(page.getByTestId('emenu-tag')).toHaveText('Tag: A8060');
    await page.getByTestId('emenu-tag').click();
    await expect(page.getByTestId('emenu-end')).toContainText('FINISH ORDERING');
    await page.getByTestId('emenu-end-ok').click();
    await expect(page.getByTestId('emenu-start')).toBeVisible();
    await expect(page.getByTestId('emenu-lang')).toHaveAttribute('data-lang', 'zh');

    // 后台关掉中英切换：没有开关，顶栏与 8.0.12 一样
    menu.rules.langSwitch = false;
    await page.reload();
    await expect(page.getByTestId('emenu-start')).toBeVisible();
    await expect(page.getByTestId('emenu-lang')).toHaveCount(0);
    await enterMenu(page);
    await expect(page.getByTestId('emenu-lang')).toHaveCount(0);
    await expect(page.getByTestId('emenu-tag')).toContainText('手牌');
    await noScroll(page);
    expect(writes).toEqual([]);
    await clearEmenuStorage(page);
  });

  test('8.0.13 键盘与动效：正在输入时窗口变矮页面不缩放、结果列表在键盘上面；拖动翻页与回弹；关掉详情留一个退场的影子（合成菜单，只读）', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '要改窗口大小、拖动鼠标，只在门店电脑这一组跑一次');
    const menu = syntheticMenu();
    const writes = await mockEmenu(page, () => menu);
    await loginStaff(page, 'linlan');
    await clearEmenuStorage(page);
    await page.goto('/emenu');
    await expect(page.getByTestId('emenu-start')).toBeVisible();
    // 动效开着（没有要求减少动态效果、后台也没设成简洁）
    await expect(page.getByTestId('emenu')).not.toHaveAttribute('data-motion', 'off');
    await enterMenu(page);
    const full = page.viewportSize()!;
    const stageBox = async () => (await page.locator('[data-emenu-stage]').boundingBox())!;
    const before = await stageBox();
    // 进菜单时那一页有轻微放大的入场动画：等它播完再量菜品图的大小
    const photoWidth = async () => (await page.getByTestId('emenu-photo-1').boundingBox())!.width;
    await expect.poll(photoWidth).toBeCloseTo(386.2 * (before.width / 1024), 0);
    const photoBefore = (await page.getByTestId('emenu-photo-1').boundingBox())!;

    // ① 搜索时键盘弹起：部分安卓平板会把网页可用的高度压小——用「正在输入时把窗口压矮」来模拟
    await page.getByTestId('emenu-search-open').click();
    await page.getByTestId('emenu-search-input').fill('a');
    await expect(page.getByTestId('emenu-search-list')).toBeVisible();
    const short = Math.round(full.height * 0.45);
    await page.setViewportSize({ width: full.width, height: short });
    await expect(page.getByTestId('emenu')).toHaveAttribute('data-keyboard', 'true');
    const during = await stageBox();
    // 页面没有缩小、没有挪动（搜索框在最上面）；菜品图一样大
    expect(during.width).toBeCloseTo(before.width, 0);
    expect(during.height).toBeCloseTo(before.height, 0);
    expect(during.x).toBeCloseTo(before.x, 0);
    expect(during.y).toBeCloseTo(before.y, 0);
    const photoDuring = (await page.getByTestId('emenu-photo-1').boundingBox())!;
    expect(photoDuring.width).toBeCloseTo(photoBefore.width, 0);
    expect(photoDuring.height).toBeCloseTo(photoBefore.height, 0);
    // 结果列表整个在键盘上面
    const list = (await page.getByTestId('emenu-search-results').boundingBox())!;
    expect(list.y + list.height).toBeLessThanOrEqual(short);
    // 键盘收起：还是原来的大小
    await page.setViewportSize(full);
    await expect(page.getByTestId('emenu')).not.toHaveAttribute('data-keyboard', 'true');
    expect((await stageBox()).width).toBeCloseTo(before.width, 0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('emenu-search')).toBeHidden();
    // 没在输入时窗口真的变小了（不是键盘）：照常重新缩放
    await expect.poll(async () => page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
    await page.waitForTimeout(1100);
    await page.setViewportSize({ width: full.width, height: short });
    await expect.poll(async () => (await stageBox()).height).toBeLessThan(before.height - 50);
    await page.setViewportSize(full);
    await expect.poll(async () => (await stageBox()).height).toBeGreaterThan(before.height - 2);

    // ② 备注抽屉的自定义备注在屏幕下半部分：键盘盖住时整页往上挪到它露出来，收起后回到原位
    await page.getByTestId('emenu-add-1').click();
    await page.getByTestId('emenu-order-open').click();
    await page.getByTestId('emenu-remark-open').click();
    await page.getByTestId('emenu-remark-custom-open').click();
    const custom = page.getByTestId('emenu-remark-custom');
    await expect(custom).toBeFocused();
    await page.setViewportSize({ width: full.width, height: short });
    await expect.poll(async () => {
      const b = (await custom.boundingBox())!;
      return b.y + b.height;
    }).toBeLessThanOrEqual(short);
    expect((await stageBox()).width).toBeCloseTo(before.width, 0);
    await page.setViewportSize(full);
    await page.getByTestId('emenu-remark-done').click();
    await expect.poll(async () => (await stageBox()).y).toBeCloseTo(before.y, 0);
    await page.mouse.click(before.x + 100 * (before.width / 1024), before.y + 400 * (before.height / 768));
    await expect(page.getByTestId('emenu-drawer')).toBeHidden();

    // ③ 拖动翻页：往左拖过五分之一屏翻到下一页；最后一页再往左拖、第一页往右拖都回弹、不翻页
    const dots = page.getByTestId('emenu-dots');
    const drag = async (fromX: number, toX: number) => {
      const y = before.y + before.height * 0.62;
      await page.mouse.move(before.x + before.width * fromX, y);
      await page.mouse.down();
      const steps = 12;
      for (let i = 1; i <= steps; i++) await page.mouse.move(before.x + before.width * (fromX + ((toX - fromX) * i) / steps), y);
      await page.mouse.up();
    };
    await expect(dots).toHaveAttribute('data-page', '0');
    await drag(0.8, 0.3);
    await expect(dots).toHaveAttribute('data-page', '1');
    await expect(page.getByTestId('emenu-cover-title')).toBeInViewport();
    await drag(0.8, 0.3);
    await expect(dots).toHaveAttribute('data-page', '1');
    await drag(0.3, 0.8);
    await expect(dots).toHaveAttribute('data-page', '0');
    await drag(0.3, 0.8);
    await expect(dots).toHaveAttribute('data-page', '0');
    await expect(page.getByTestId('emenu-dish-1')).toBeInViewport();
    // 拖完松手不会点开手指底下的菜；只拖了一点点不翻页
    await expect(page.getByTestId('emenu-detail')).toHaveCount(0);
    await drag(0.5, 0.45);
    await expect(dots).toHaveAttribute('data-page', '0');

    // ④ 关掉菜品详情：详情马上卸掉（不会有两份能点的），舞台上留一个影子播退场动画，播完自己没有
    const ghosts = page.locator('[data-emenu-ghosts] > .em-ghost');
    await page.getByTestId('emenu-photo-1').click();
    await expect(page.getByTestId('emenu-detail')).toBeVisible();
    await page.getByTestId('emenu-detail-close').click();
    await expect(page.getByTestId('emenu-detail')).toHaveCount(0);
    expect(await ghosts.count()).toBe(1);
    // 影子不带测试标记、读屏不念、不能点
    expect(await ghosts.first().evaluate((el) => [el.querySelectorAll('[data-testid]').length, el.getAttribute('aria-hidden'), getComputedStyle(el).pointerEvents])).toEqual([0, 'true', 'none']);
    await expect(ghosts).toHaveCount(0);

    // ⑤ 系统要求减少动态效果：舞台标 data-motion="off"，关掉详情不留影子
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByTestId('emenu')).toHaveAttribute('data-motion', 'off');
    await page.getByTestId('emenu-photo-1').click();
    await page.getByTestId('emenu-detail-close').click();
    await expect(page.getByTestId('emenu-detail')).toHaveCount(0);
    expect(await ghosts.count()).toBe(0);
    // 后台把动效设成「简洁」也一样
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByTestId('emenu')).not.toHaveAttribute('data-motion', 'off');
    menu.rules.motion = false;
    await page.reload();
    await expect(page.getByTestId('emenu-header')).toBeVisible();
    await expect(page.getByTestId('emenu')).toHaveAttribute('data-motion', 'off');
    await noScroll(page);
    expect(writes).toEqual([]);
    await clearEmenuStorage(page);
  });

  test('8.0.15 默认的一档：字与按钮放大、整页仍不出滚动条；不要点单密码——核对手牌桌号后直接下单，没有答复时重新提交、作废也不要密码（合成菜单，只读）', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '这一条自己把窗口定成 1024×768，与项目的屏幕尺寸无关，只跑一次');
    await page.setViewportSize({ width: 1024, height: 768 });
    // 后台什么都没改过时平板取到的就是这一套：不要密码、放大
    const menu = syntheticMenu({ requirePin: false, textSize: 'large' });
    const guest = { visitId: 1, tagCode: 'A8060', ordered: [], orderedTotal: 0 };
    const seen = { posts: [] as Record<string, unknown>[], abandons: [] as unknown[] };
    let mode: 'ok' | 'drop' = 'ok';
    await page.route('**/api/emenu/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === '/api/emenu/menu') return route.fulfill({ json: menu });
      if (url.pathname === '/api/emenu/guest') return route.fulfill({ json: guest });
      if (url.pathname === '/api/emenu/table') return route.fulfill({ json: { tableName: 'A01' } });
      if (url.pathname === '/api/emenu/orders' && req.method() === 'POST') {
        const body = req.postDataJSON() as { expectedTotal: number };
        seen.posts.push(body);
        if (mode === 'drop') return route.abort('connectionreset');
        return route.fulfill({ json: { orderNo: 'D0001', tableName: 'A01', guests: 2, total: body.expectedTotal, quantity: 1, waiterName: '一号桌平板', replayed: false, guest } });
      }
      if (url.pathname.startsWith('/api/emenu/orders/by-key/')) {
        if (req.method() === 'GET') return route.fulfill({ json: { found: false, abandoned: false } });
        seen.abandons.push(req.postDataJSON());
        return route.fulfill({ json: { found: false, abandoned: true } });
      }
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '没有' } } });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loginStaff(page, 'linlan');
    await clearEmenuStorage(page);
    await page.goto('/emenu');
    await expect(page.getByTestId('emenu')).toHaveAttribute('data-size', 'large');
    const box = async (testId: string) => (await page.getByTestId(testId).boundingBox())!;

    // 输入信息的弹窗：绕屏幕正中放大 1.3 倍（429 × 501 → 558 × 651），整个在屏幕里
    await page.getByTestId('emenu-start').click();
    const ask = await box('emenu-ask');
    expect(ask.width).toBeCloseTo(429.1 * 1.3, 0);
    expect(ask.height).toBeCloseTo(500.6 * 1.3, 0);
    expect(ask.x + ask.width / 2).toBeCloseTo(512, 0);
    expect(ask.y).toBeGreaterThan(40);
    expect(ask.y + ask.height).toBeLessThan(728);
    expect((await box('emenu-key-1')).width).toBeCloseTo(59.5 * 1.3, 0);
    for (const d of '8060') await page.getByTestId(`emenu-key-${d}`).click();
    await page.getByTestId('emenu-field-table').click();
    await page.getByTestId('emenu-key-clear').click();
    for (const d of '01') await page.getByTestId(`emenu-key-${d}`).click();
    await page.getByTestId('emenu-field-guests').click();
    await page.getByTestId('emenu-key-2').click();
    await page.getByTestId('emenu-ask-go').click();
    await expect(page.getByTestId('emenu-header')).toBeVisible();

    // 菜单页：菜名 16 → 22 号、加号 12.6 → 21、手牌色块 22 → 29 高，右边仍贴在 984；整页不出滚动条
    const fontPx = (testId: string) => page.getByTestId(testId).evaluate((el) => (el.getBoundingClientRect().height / (el as HTMLElement).offsetHeight) * parseFloat(getComputedStyle(el).fontSize));
    expect(await fontPx('emenu-name-1')).toBeCloseTo(16 * 1.4, 0);
    const plus = await box('emenu-add-1');
    expect(plus.width).toBeCloseTo(15 * 1.4, 0);
    const tagPill = await box('emenu-tag');
    expect(tagPill.height).toBeCloseTo(22.3 * 1.3, 0);
    expect(tagPill.x + tagPill.width).toBeCloseTo(984, 0);
    const search = await box('emenu-search-open');
    const order = await box('emenu-order-open');
    expect(search.width).toBeCloseTo(20.5 * 1.3, 0);
    // 顶栏右边几样不叠在一起
    const lang = await box('emenu-lang');
    expect(lang.x + lang.width).toBeLessThan(search.x - 8);
    expect(search.x + search.width).toBeLessThan(order.x - 8);
    expect(order.x + order.width).toBeLessThan(tagPill.x - 8);
    // 两道菜的文字都在页面里、互不压着，也不压图
    const d1 = await box('emenu-name-1');
    const d2 = await box('emenu-name-2');
    const photo1 = await box('emenu-photo-1');
    expect(d1.y).toBeGreaterThan(photo1.y + photo1.height);
    expect(d1.x + d1.width).toBeLessThan(d2.x);
    expect(d2.x + d2.width).toBeLessThan(984);
    await noScroll(page);
    // 分类封面：文字的下沿在特写图上面（往上长），上沿在大标题下面
    await page.getByTestId('emenu-cat-2').click();
    const title = await box('emenu-cover-title');
    const name3 = await box('emenu-name-3');
    const add3 = await box('emenu-add-3');
    expect(name3.y).toBeGreaterThan(title.y + title.height);
    expect(add3.y + add3.height).toBeLessThan(485);

    // 菜品详情：卡片 200 高（原来 153）、贴着底边留 40，加号按钮 71 × 27 → 92 × 35
    await page.getByTestId('emenu-photo-3').last().click();
    const card = await box('emenu-detail-card');
    expect(card.height).toBeCloseTo(200, 0);
    expect(card.y + card.height).toBeCloseTo(728, 0);
    const add = await box('emenu-detail-add');
    expect(add.width).toBeCloseTo(70.9 * 1.3, 0);
    expect(add.x + add.width).toBeLessThan(card.x + card.width);
    expect(add.y + add.height).toBeLessThan(card.y + card.height);
    expect((await box('emenu-detail-close')).width).toBeCloseTo(42, 0);
    await page.getByTestId('emenu-detail-add').click();
    await page.getByTestId('emenu-detail-close').click();

    // 搜索：框宽 689 → 896，居中
    await page.getByTestId('emenu-search-open').click();
    const bar = await box('emenu-search');
    expect(bar.width).toBeCloseTo(689 * 1.3, 0);
    // 设计稿里搜索框的中心在 510.9（不是正中的 512），放大以后照旧
    expect(Math.abs(bar.x + bar.width / 2 - 512)).toBeLessThan(2);
    await page.getByTestId('emenu-search-input').fill('汉堡');
    const hit = await box('emenu-search-hit-2');
    expect(hit.height).toBeCloseTo(34.2 * 1.3, 0);
    await page.keyboard.press('Escape');

    // 订单抽屉：宽 426 → 532、右边贴着屏幕边，按钮与下面那行字都在屏幕里；按钮上不写「请呼叫服务员」
    await page.getByTestId('emenu-order-open').click();
    const drawer = await box('emenu-drawer');
    expect(drawer.width).toBeCloseTo(425.7 * 1.25, 0);
    expect(drawer.x + drawer.width).toBeCloseTo(1024, 0);
    const submit = page.getByTestId('emenu-submit');
    await expect(submit).toHaveText('下单');
    const submitBox = (await submit.boundingBox())!;
    expect(submitBox.height).toBeCloseTo(28.3 * 1.25, 0);
    const note = await box('emenu-cart-note');
    expect(note.y + note.height).toBeLessThan(768);
    expect((await box('emenu-plus-9003')).width).toBeCloseTo(18 * 1.25, 0);

    // 确认信息：没有密码那一项；点「下单」直接发出去，请求里的密码是空的
    await submit.click();
    const confirm = page.getByTestId('emenu-confirm');
    await expect(confirm.getByTestId('emenu-field-tag')).toHaveAttribute('data-value', 'A8060');
    await expect(confirm.getByTestId('emenu-field-guests')).toHaveAttribute('data-value', '2');
    await expect(confirm.getByTestId('emenu-field-pin')).toHaveCount(0);
    // 哪一项都没选中：碰到键盘不会把带出来的手牌改掉
    await confirm.getByTestId('emenu-key-7').click();
    await expect(confirm.getByTestId('emenu-field-tag')).toHaveAttribute('data-value', 'A8060');
    await expect(confirm.getByTestId('emenu-field-guests')).toHaveAttribute('data-value', '2');
    await page.getByTestId('emenu-confirm-go').click();
    await expect(page.getByTestId('emenu-success')).toBeVisible();
    expect(seen.posts).toHaveLength(1);
    expect(seen.posts[0]).toMatchObject({ tagCode: 'A8060', tableName: 'A01', guests: 2, pin: '' });
    await expect(page.getByTestId('emenu-success')).toBeHidden({ timeout: 10_000 });

    // 没有答复：「结果待确认」里没有密码、没有数字键盘，三个按钮直接能点；作废的请求里也没有密码
    mode = 'drop';
    await page.getByTestId('emenu-add-3').click();
    await page.getByTestId('emenu-order-open').click();
    await submit.click();
    await page.getByTestId('emenu-confirm-go').click();
    const pendingModal = page.getByTestId('emenu-pending');
    await expect(pendingModal).toBeVisible();
    await expect(pendingModal.getByTestId('emenu-field-pin')).toHaveCount(0);
    await expect(pendingModal.getByTestId('emenu-key-1')).toHaveCount(0);
    await expect(pendingModal.getByTestId('emenu-hint')).toContainText('查回结果');
    await pendingModal.getByTestId('emenu-pending-abandon').click();
    await expect(pendingModal).toBeHidden();
    expect(seen.abandons).toEqual([{ pin: '' }]);
    expect(await page.evaluate(() => localStorage.getItem('yuzu.emenu.pending.v1'))).toBeNull();
    await expect(page.getByTestId('emenu-cart-9003')).toBeVisible();
    await noScroll(page);
    await clearEmenuStorage(page);
  });

  test('8.0.15 后台设置：有「点单密码」（不要 / 要）与「字与按钮的大小」（放大 / 设计稿原样）两行（只读）', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '后台页面，只跑一次');
    await loginStaff(page, 'linlan');
    await page.goto('/admin/emenu');
    await page.getByTestId('subnav-settings').click();
    const settings = page.getByTestId('emenu-admin-settings');
    const pin = settings.getByRole('radiogroup', { name: '点单密码' });
    await expect(pin.getByRole('radio', { name: '不要', exact: true })).toBeVisible();
    await expect(pin.getByRole('radio', { name: '要', exact: true })).toBeVisible();
    const size = settings.getByRole('radiogroup', { name: '字与按钮的大小' });
    await expect(size.getByRole('radio', { name: '放大' })).toBeVisible();
    await expect(size.getByRole('radio', { name: '设计稿原样' })).toBeVisible();
    // 不要密码时的提醒写在这一行
    await expect(settings).toContainText('平板请交给服务员或放在看得到的地方');
  });
});
