// 8.1.6 平板电子菜单与工作台的二次整改（docs/EMENU.md 第 15 节，docs/HANDOFF_V816.md）的浏览器验收。只在「门店电脑」这一组跑，
// 平板那一段另开小米平板 6S Pro 12.4 大小的窗口（1355 × 903，3:2，HyperOS 默认显示大小）：
//   ① 铺满屏幕（出血）：起始页的底、压暗层、抽屉、菜品大图铺到屏幕边，点两边与点压暗层一样；菜单页左右不露出相邻的页；
//      大图开着时右上角四样照常能点、能切语言（合成菜单，只读）；
//   ② 英文补齐：服务员那一步英文在上、中文在下；门店系统的拒绝按拒绝码给英文（合成接口，写请求不到门店系统）；
//   ③ 菜品大图单独一层：设计师在菜单页上加的装饰压不到大图上（预览码打开草稿，只读）；
//   ④ 工作台编辑顶栏：拖着一块时标出与左右两块的间距、在「间距」里改一条只动那一条；预览码打开平板，顶栏照改过的画；
//      用完把草稿放回内置的默认版面（会写草稿，不发布）。
// 只要 seed-demo 的店主 linlan（密码 yuzu2026）。可重复执行。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { DEFAULT_EMENU_PERIODS, type EmenuMenu } from '../src/shared/emenu';
import { defaultStudioDoc, DocSchema, type StudioDoc, type StudioState } from '../src/shared/studio';

const PASSWORD = 'yuzu2026';
/** 小米平板 6S Pro 12.4：屏幕 3048 × 2032，HyperOS 默认显示大小下网页看到 1355 × 903 */
const XIAOMI = { width: 1355, height: 903 };
const SCALE = Math.min(XIAOMI.width / 1024, XIAOMI.height / 768);
const LEFT = (XIAOMI.width - 1024 * SCALE) / 2;

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
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

/** 合成的菜单：两个分类（一页「两菜 · 并排」、一页「分类封面」），不要点单密码、字照设计稿原样 */
function syntheticMenu(): EmenuMenu {
  const dish = (id: number, name: string, nameEn: string, description = '', descriptionEn = '') => ({
    id,
    name,
    nameEn,
    tagline: '',
    description,
    attrs: [],
    unit: '份',
    taglineEn: '',
    descriptionEn,
    attrsEn: [],
    unitEn: '',
    imageUrl: null,
    detailUrl: null,
    specs: [{ itemId: 9000 + id, label: '', labelEn: '', price: 4200, state: 'ok' as const, remaining: null }],
  });
  return {
    serverTime: new Date().toISOString(),
    businessDate: '2026-11-17',
    enabled: true,
    rules: {
      footerText: 'COPYRIGHT©2026 汤崎 ALL RIGHTS RESERVED',
      avoidOptions: ['不加香菜'],
      serveOptions: ['即起'],
      idleMinutes: 0,
      offHours: 'hide',
      langSwitch: true,
      optionsEn: {},
      motion: false,
      requirePin: false,
      textSize: 'design',
      periods: [...DEFAULT_EMENU_PERIODS],
      coverUrl: null,
    },
    period: { ...DEFAULT_EMENU_PERIODS[1]!, end: DEFAULT_EMENU_PERIODS[2]!.start },
    nextChangeAt: null,
    categories: [
      {
        id: 1,
        name: '西式午餐',
        nameEn: 'WESTERN LUNCH',
        periods: [],
        window: null,
        open: true,
        pages: [
          {
            layout: 'duo_row',
            title: '',
            titleEn: '',
            dishes: [dish(1, '温泉蛋黑松露奶油意粉', 'Hot Spring Egg And Black Truffle Cream Spaghetti', '慢火熬煮。', 'Slow cooked.'), dish(2, '和牛牛肉汉堡', 'Wagyu Beef Burger')],
          },
        ],
      },
      {
        id: 2,
        name: '中式午餐',
        nameEn: 'CHINESE LUNCH',
        periods: [],
        window: null,
        open: true,
        pages: [{ layout: 'cover', title: '', titleEn: '', dishes: [dish(3, '广式猪脚姜浸花胶', 'Cantonese Pork Trotter')] }],
      },
    ],
    later: [],
    tables: [],
  };
}

/** 小米平板大小的窗口，用店主登录（店主有「打开平板点餐」）；菜单、找客人、桌号用合成的，写请求交给 onWrite（不给就掐掉） */
async function xiaomiPad(browser: Browser, baseURL: string | undefined, onWrite?: Parameters<Page['route']>[1]) {
  const ctx = await browser.newContext({ baseURL, viewport: XIAOMI, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage();
  await login(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/emenu/**', (route, request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET') return onWrite ? onWrite(route, request) : route.abort();
    if (url.pathname === '/api/emenu/menu') return route.fulfill({ json: syntheticMenu() });
    if (url.pathname === '/api/emenu/guest') return route.fulfill({ json: { visitId: 1, tagCode: 'A8060', ordered: [], orderedTotal: 0 } });
    if (url.pathname === '/api/emenu/table') return route.fulfill({ json: { tableName: 'A01' } });
    if (url.pathname.startsWith('/api/emenu/orders/by-key/')) return route.fulfill({ json: { found: false, abandoned: false } });
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '没有' } } });
  });
  await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('yuzu.emenu.'))
      .forEach((k) => localStorage.removeItem(k)),
  );
  return { ctx, page };
}

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

/** 屏幕上这一点最上面是哪一块（往上找第一个带 data-testid 的） */
const topAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      let el: Element | null = document.elementFromPoint(px!, py!);
      while (el && !el.getAttribute('data-testid')) el = el.parentElement;
      return el?.getAttribute('data-testid') ?? null;
    },
    [x, y],
  );
const within = (page: Page, x: number, y: number, testId: string) =>
  page.evaluate(([px, py, id]) => !!document.elementFromPoint(px as number, py as number)?.closest(`[data-testid="${id}"]`), [x, y, testId] as const);

/** 把工作台的草稿放回内置的默认版面 */
async function resetDraft(page: Page) {
  const s = await getJson<StudioState>(page, '/api/studio/emenu');
  await send(page, 'put', '/api/studio/emenu/draft', { rev: s.draft.rev, doc: defaultStudioDoc('emenu') });
}

test.describe('8.1.6 平板电子菜单与工作台的二次整改', () => {
  test('小米平板 6S Pro 12.4：底色、压暗层、抽屉、大图铺到屏幕边，两边不露相邻的页；大图开着时右上角四样照常能点、能切语言（合成菜单，只读）', async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== '门店电脑', '另开小米平板大小的窗口，只跑一次');
    const { ctx, page } = await xiaomiPad(browser, baseURL);
    try {
      await page.goto('/emenu');
      await expect(page.getByTestId('emenu-start')).toBeVisible();
      // 舞台照旧是 1024 × 768 等比放大、居中；左右各多出约 64 设计像素（出血）
      const stage = (await page.locator('[data-emenu-stage]').boundingBox())!;
      expect(stage.x).toBeCloseTo(LEFT, 0);
      expect(stage.width).toBeCloseTo(1024 * SCALE, 0);
      expect(Number(await page.locator('[data-emenu-stage]').getAttribute('data-bleed-x'))).toBeCloseTo(LEFT / SCALE, 0);
      // 起始页：点两边空出来的地方与点中间一样，开始点餐
      expect(await within(page, 8, 450, 'emenu-start')).toBe(true);
      await enterMenu(page);

      // 菜单页：两边是底色，不露出相邻的页
      expect(await page.evaluate(() => !!document.elementFromPoint(8, 450)?.closest('[data-page]'))).toBe(false);
      expect(await page.evaluate(([w]) => !!document.elementFromPoint(w! - 8, 450)?.closest('[data-page]'), [XIAOMI.width])).toBe(false);

      // 搜索：压暗层铺到屏幕边；点左边空出来的地方关掉
      await page.getByTestId('emenu-search-open').click();
      const fill = (await page.getByTestId('emenu-backdrop-fill').boundingBox())!;
      expect(fill.x).toBeLessThanOrEqual(0.5);
      expect(fill.x + fill.width).toBeGreaterThanOrEqual(XIAOMI.width - 0.5);
      await page.mouse.click(20, 600);
      await expect(page.getByTestId('emenu-backdrop-fill')).toHaveCount(0);

      // 订单抽屉：底铺到屏幕右边
      await page.getByTestId('emenu-order-open').click();
      await expect(page.getByTestId('emenu-drawer')).toBeVisible();
      expect(await within(page, XIAOMI.width - 4, 450, 'emenu-drawer')).toBe(true);
      await page.mouse.click(20, 600);
      await expect(page.getByTestId('emenu-drawer')).toHaveCount(0);

      // 菜品大图：铺到屏幕边；顶栏的中英切换、搜索照常能点
      await page.getByTestId('emenu-photo-1').click();
      const photo = (await page.getByTestId('emenu-detail-photo').boundingBox())!;
      expect(photo.x).toBeLessThanOrEqual(0.5);
      expect(photo.x + photo.width).toBeGreaterThanOrEqual(XIAOMI.width - 0.5);
      await expect(page.getByTestId('emenu-detail-name')).toHaveText('温泉蛋黑松露奶油意粉');
      await page.getByTestId('emenu-lang').click();
      await expect(page.getByTestId('emenu-detail-name')).toHaveText('Hot Spring Egg And Black Truffle Cream Spaghetti');
      await expect(page.getByTestId('emenu-detail-desc')).toHaveText('Slow cooked.');
      for (const id of ['emenu-lang', 'emenu-search-open', 'emenu-order-open', 'emenu-tag']) {
        const b = (await page.getByTestId(id).boundingBox())!;
        expect(await topAt(page, b.x + b.width / 2, b.y + b.height / 2), id).toBe(id);
      }
      await page.getByTestId('emenu-search-open').click();
      await expect(page.getByTestId('emenu-backdrop-fill')).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test('英文：服务员那一步英文在上、中文在下；门店系统的拒绝按拒绝码给英文（合成接口，写请求不到门店系统）', async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== '门店电脑', '另开小米平板大小的窗口，只跑一次');
    let posts = 0;
    const { ctx, page } = await xiaomiPad(browser, baseURL, (route, request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/emenu/orders') {
        posts += 1;
        // 第一次：服务器出错（结果不明 → 结果待确认）；重新提交：估清（明确拒绝 → 先作废编号再说没有下成）
        if (posts === 1) return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: '服务器内部错误' } } });
        return route.fulfill({ status: 409, json: { error: { code: 'DISH_SOLD_OUT', message: '「和牛牛肉汉堡」今天已估清（卖完了），请换一道菜' } } });
      }
      if (path.endsWith('/abandon')) return route.fulfill({ json: { found: false, abandoned: true } });
      return route.abort();
    });
    try {
      await page.goto('/emenu');
      await page.getByTestId('emenu-lang').click();
      await enterMenu(page);
      await page.getByTestId('emenu-add-2').click();
      await page.getByTestId('emenu-order-open').click();
      await page.getByTestId('emenu-submit').click();
      await expect(page.getByTestId('emenu-confirm')).toContainText('CONFIRM INFORMATION');
      await page.getByTestId('emenu-confirm-go').click();

      // 结果待确认：按钮是英文；说明英文在上、门店系统的中文在下一行
      const pending = page.getByTestId('emenu-pending');
      await expect(pending).toContainText('ORDER NOT CONFIRMED YET');
      await expect(pending.getByTestId('emenu-pending-check')).toHaveText('Check result');
      await expect(pending.getByTestId('emenu-error')).toContainText('The store system ran into a problem');
      await expect(pending.getByTestId('emenu-error').getByTestId('emenu-zh-line')).toHaveText('门店系统出了点问题，这一单有没有下成暂时不确定');
      await pending.getByTestId('emenu-pending-check').click();
      await expect(pending.getByTestId('emenu-hint')).toContainText('No placed order found yet');
      await expect(pending.getByTestId('emenu-hint').getByTestId('emenu-zh-line')).toContainText('暂时没有查到已经下单');

      // 重新提交被拒（估清）：先作废编号，再说没有下成——英文按拒绝码，下面是门店系统原来的中文
      await pending.getByTestId('emenu-pending-retry').click();
      const notice = page.getByTestId('emenu-notice');
      await expect(notice).toContainText('This order was not placed: A dish has just sold out');
      await expect(notice.getByTestId('emenu-zh-line')).toContainText('「和牛牛肉汉堡」今天已估清');
      await expect(notice.getByTestId('emenu-notice-ok')).toHaveText('OK');
      // 弹窗没有超出屏幕、提示没有压到按钮
      const box = (await notice.boundingBox())!;
      const ok = (await notice.getByTestId('emenu-notice-ok').boundingBox())!;
      const zh = (await notice.getByTestId('emenu-zh-line').boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(XIAOMI.height);
      expect(zh.y + zh.height).toBeLessThanOrEqual(ok.y);
      expect(posts).toBe(2);
    } finally {
      await ctx.close();
    }
  });

  test('菜品大图单独一层：设计师在菜单页上加的装饰压不到大图上（预览码打开草稿，只读）', async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== '门店电脑', '另开小米平板大小的窗口，只跑一次');
    const { ctx, page } = await xiaomiPad(browser, baseURL);
    try {
      // 菜单页上加一行字（压在菜单页中间），做成预览码
      const doc: StudioDoc = JSON.parse(JSON.stringify(defaultStudioDoc('emenu')));
      const deco = DocSchema.shape.screens.parse({ s: { nodes: [{ type: 'text', id: 't-e2e-deco', x: 300, y: 330, w: 420, h: 60, text: { zh: 'E2E 装饰' } }] } }).s!.nodes[0]!;
      doc.screens.menu!.nodes.push(deco);
      const { code } = await send<{ code: string }>(page, 'post', '/api/studio/emenu/preview-code', { doc });
      await page.goto(`/emenu?studio=${code}`);
      await expect(page.getByTestId('emenu-studio-preview')).toBeVisible();
      await enterMenu(page);
      // 装饰本来不接点按（点下去落到下面的菜上）；量叠放的先后时只让这一行字接点按
      const decoText = page.getByText('E2E 装饰', { exact: true });
      await expect(decoText).toBeVisible();
      await decoText.evaluate((el) => ((el as HTMLElement).style.pointerEvents = 'auto'));
      const d = (await decoText.boundingBox())!;
      const at = { x: d.x + d.width / 2, y: d.y + d.height / 2 };
      // 没开大图时装饰在最上面
      expect(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.textContent === 'E2E 装饰', [at.x, at.y])).toBe(true);
      // 开着大图：同一点上是大图，装饰被盖住
      await page.getByTestId('emenu-photo-1').click();
      await expect(page.getByTestId('emenu-detail')).toBeVisible();
      expect(await within(page, at.x, at.y, 'emenu-detail')).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('工作台编辑顶栏：拖着时标出与左右两块的间距、改一条间距只动那一条；预览码打开平板，顶栏照改过的画；用完草稿放回默认（会写草稿，不发布）', async ({ page, browser, baseURL }, info) => {
    test.skip(info.project.name !== '门店电脑', '整套流程只跑一次');
    test.setTimeout(120_000);
    await login(page);
    await resetDraft(page);
    try {
      await page.goto('/studio/emenu');
      await expect(page.getByTestId('studio-canvas')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('studio-tab-templates').click();
      await page.getByTestId('studio-layout-header').click();
      await expect(page.getByTestId('studio-template-canvas')).toBeVisible();
      for (const k of ['logo', 'cats', 'lang', 'search', 'order', 'tag']) await expect(page.getByTestId(`studio-slot-${k}`)).toBeVisible();
      // 没选中时右边就列出间距：左页边 40、字标 ↔ 分类……
      const gaps = page.getByTestId('studio-head-gaps');
      await expect(gaps).toBeVisible();
      await expect(page.getByTestId('studio-head-gap-0')).toHaveValue('40');
      const before = async () => Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => page.getByTestId(`studio-head-gap-${i}`).inputValue()));
      const start = await before();

      // 拖着搜索往右挪一点：左右两边的间距线标着数，随手指变
      const s = (await page.getByTestId('studio-slot-search').boundingBox())!;
      await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
      await page.mouse.down();
      await page.mouse.move(s.x + s.width / 2 + 3, s.y + s.height / 2, { steps: 3 });
      await expect(page.getByTestId('studio-gap-left')).toBeVisible();
      await expect(page.getByTestId('studio-gap-right')).toBeVisible();
      const l1 = Number(await page.getByTestId('studio-gap-left').getAttribute('data-gap'));
      await page.mouse.move(s.x + s.width / 2 + 6, s.y + s.height / 2, { steps: 3 });
      await expect.poll(async () => Number(await page.getByTestId('studio-gap-left').getAttribute('data-gap'))).toBeGreaterThan(l1);
      await page.mouse.up();
      await expect.poll(async () => Number(await page.getByTestId('studio-head-gap-3').inputValue())).toBeGreaterThan(Number(start[3]));
      const moved = await before();
      expect(Number(moved[4])).toBeLessThan(Number(start[4]));

      // 「间距」里把「订单 ↔ 手牌」改成 30：只动这一条（右边一组靠右贴住，左边几块一起挪、分类收放）
      await page.getByTestId('studio-head-gap-5').fill('30');
      await page.getByTestId('studio-head-gap-5').press('Enter');
      await expect(page.getByTestId('studio-head-gap-5')).toHaveValue('30');
      const after = await before();
      for (const i of [0, 1, 2, 3, 4, 6]) expect(Math.abs(Number(after[i]) - Number(moved[i])), `第 ${i} 条间距`).toBeLessThanOrEqual(0.1);

      // 自动保存以后：预览码打开平板，顶栏的搜索照改过的位置画
      await expect.poll(async () => (await getJson<StudioState>(page, '/api/studio/emenu')).draft.doc.templates?.header?.search ?? null, { timeout: 15_000 }).not.toBeNull();
      const draft = (await getJson<StudioState>(page, '/api/studio/emenu')).draft.doc;
      const searchX = draft.templates!.header!.search!.design!.x!;
      const { code } = await send<{ code: string }>(page, 'post', '/api/studio/emenu/preview-code', { doc: draft });
      const pad = await xiaomiPad(browser, baseURL);
      try {
        await pad.page.goto(`/emenu?studio=${code}`);
        await enterMenu(pad.page);
        const b = (await pad.page.getByTestId('emenu-search-open').boundingBox())!;
        expect(b.x).toBeCloseTo(LEFT + searchX * SCALE, 0);
        expect(searchX).not.toBe(795.4);
      } finally {
        await pad.ctx.close();
      }
    } finally {
      // 先离开编辑器（不再自动保存），再把草稿放回默认
      await page.goto('about:blank');
      await page.waitForTimeout(1500);
      await login(page);
      await resetDraft(page);
    }
  });
});
