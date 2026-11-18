// 8.1.8 品牌部的五条（docs/EMENU.md 第 16 节，docs/HANDOFF_V818.md，PENDING_DECISIONS.md PB1–PB5）的浏览器验收。
// 只在「门店电脑」这一组跑，平板那一段另开小米平板 6S Pro 12.4 大小的窗口（1355 × 903）：
//   用一份预览码打开「测试服上那一版」的样子——主文字改成了 #be9879、每种版式的照片加了 10 的圆角（预览码只存草稿的样子，不发布、不改草稿）；
//   菜单、找客人、桌号用合成的（只读）。逐页核对：
//   ① 顶栏分类的字完整：字的外面没有裁剪的框，每一行都在自己那一格里（放不下的整行缩小，不显示「…」）；
//   ② 封面大标题右下角有小圆圈（大小、位置、颜色照品牌部的图）；
//   ③ 照片四个角都是直角（版面里存着的圆角不生效）；
//   ④ 字标、选中的分类、页面标题、菜名都是 #4b392a，每一页一样；
//   ⑤ 选中的分类下面没有光晕、细线。
// 工作台（店主打开，只看不改）：主文字只显示、不能改；卡片模板里的照片没有「圆角」这一项。
// 只要 seed-demo 的店主 linlan（密码 yuzu2026）。可重复执行。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { DEFAULT_EMENU_PERIODS, type EmenuLayout, type EmenuMenu } from '../src/shared/emenu';
import { defaultStudioDoc, type StudioDoc } from '../src/shared/studio';

const PASSWORD = 'yuzu2026';
/** 小米平板 6S Pro 12.4：HyperOS 默认显示大小下网页看到 1355 × 903 */
const XIAOMI = { width: 1355, height: 903 };
const BRAND = 'rgb(75, 57, 42)'; // #4b392a
const DOT = 'rgb(191, 29, 37)'; // #bf1d25

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

async function send<T = unknown>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** 合成的菜单：五个分类（最后一个英文名很长，放不下要缩小），几种带照片的版式；不要点单密码 */
function syntheticMenu(): EmenuMenu {
  const dish = (id: number, name: string, nameEn: string) => ({
    id,
    name,
    nameEn,
    tagline: '',
    description: '黄椒酱的加入不仅增添了鲜辣馥郁的独特风味。',
    attrs: [],
    unit: '份',
    taglineEn: '',
    descriptionEn: '',
    attrsEn: [],
    unitEn: '',
    imageUrl: null,
    detailUrl: null,
    specs: [{ itemId: 9000 + id, label: '', labelEn: '', price: 4200, state: 'ok' as const, remaining: null }],
  });
  const cat = (id: number, name: string, nameEn: string, pages: [EmenuLayout, number[]][]) => ({
    id,
    name,
    nameEn,
    periods: [],
    window: null,
    open: true,
    pages: pages.map(([layout, ids]) => ({ layout, title: '', titleEn: '', dishes: ids.map((i) => DISHES[i - 1]!) })),
  });
  const DISHES = [
    dish(1, '温泉蛋黑松露奶油意粉', 'Hot Spring Egg And Black Truffle Cream Spaghetti'),
    dish(2, '和牛牛肉汉堡', 'Wagyu Beef Burger'),
    dish(3, '广式猪脚姜浸花胶', 'Cantonese Pork Trotter Ginger Vinegar Fish Maw'),
    dish(4, '重庆辣子鸡', 'Chongqing Spicy Chicken'),
    dish(5, '龙虾麻婆豆腐', 'Lobster Mapo Tofu'),
    dish(6, '潮式腩肉烩珠瓜', 'Braised Pork With Pearl Gourd'),
    dish(7, '盐烧新疆羊排', 'Salt-baked Lamb Chop'),
    dish(8, '砂锅黄椒酱焗溪鳗', 'Baked Eel With Yellow Pepper Sauce'),
    dish(9, '黄油牛肝菌焗牛小排', 'Butter Boletus Short Ribs'),
    dish(10, '安格斯文火牛肉', 'Angus Beef'),
  ];
  return {
    serverTime: new Date().toISOString(),
    businessDate: '2026-11-18',
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
      textSize: 'large',
      periods: [...DEFAULT_EMENU_PERIODS],
      coverUrl: null,
    },
    period: { ...DEFAULT_EMENU_PERIODS[1]!, end: DEFAULT_EMENU_PERIODS[2]!.start },
    nextChangeAt: null,
    categories: [
      cat(1, '中式午餐', 'CHINESE LUNCH', [
        ['cover', [3]],
        ['duo_row', [1, 2]],
      ]),
      cat(2, '酒水', 'BEVERAGE', [['trio_row', [4, 5, 6]]]),
      cat(3, '西式午餐', 'WESTERN LUNCH', [['single_left', [7]]]),
      cat(4, '中式早餐', 'CHINESE BREAKFAST', [['cover', [8]]]),
      cat(5, '主厨季节限定', 'SIGNATURE SEASONAL TASTING MENU', [['duo_row', [9, 10]]]),
    ],
    later: [],
    tables: [],
  };
}

/** 测试服上那一版的样子：主文字改成 #be9879，用到的几种版式的照片都加了 10 的圆角 */
function testServerDoc(): StudioDoc {
  const doc: StudioDoc = JSON.parse(JSON.stringify(defaultStudioDoc('emenu')));
  doc.theme.colors.ink = '#be9879';
  const r = { radius: 10 };
  doc.templates = {
    cover: { photo: r, detail: r },
    duo_row: { 'a.photo': r, 'b.photo': r },
    trio_row: { 'a.photo': r, 'b.photo': r, 'c.photo': r },
    single_left: { photo: r, detail: r },
  };
  return doc;
}

async function xiaomiPad(browser: Browser, baseURL: string | undefined) {
  const ctx = await browser.newContext({ baseURL, viewport: XIAOMI, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage();
  await login(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/emenu/**', (route, request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET') return route.abort();
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

/** 顶栏：分类的每一行字外面（到顶栏为止）没有裁剪的框、整行（缩放以后）在自己那一格里；选中的深棕、下面没有光晕 */
const headerFacts = (page: Page) =>
  page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('[data-testid=emenu-header]')!;
    const lines = [...header.querySelectorAll<HTMLElement>('[data-cat-line]')].map((el) => {
      const clippers: string[] = [];
      for (let p = el.parentElement; p && p !== header; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') clippers.push(`${p.tagName} ${s.overflowX}/${s.overflowY}`);
      }
      const cell = el.closest('[data-testid^=emenu-cat-]')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { text: el.textContent, clippers, inside: r.left >= cell.left - 0.5 && r.right <= cell.right + 0.5, fit: Number(el.dataset.fit ?? '1') };
    });
    const on = header.querySelector('[data-testid^=emenu-cat-][aria-pressed=true]');
    return {
      lines,
      logo: getComputedStyle(header.querySelector('[data-testid=emenu-logo]')!).color,
      selected: on ? getComputedStyle(on).color : null,
      glow: header.querySelectorAll('.em-cat-glow').length,
      shadows: [...header.querySelectorAll('[data-testid^=emenu-cat-] *, [data-testid^=emenu-cat-]')].filter((e) => {
        const s = getComputedStyle(e);
        return s.boxShadow !== 'none' || s.backgroundImage !== 'none' || s.textShadow !== 'none';
      }).length,
    };
  });

/** 当前这一页（data-page）里的菜名颜色、照片的圆角、封面标题与小圆圈 */
const pageFacts = (page: Page, i: number) =>
  page.evaluate((i) => {
    const root = document.querySelector(`[data-page="${i}"]`)!;
    const layout = root.querySelector('[data-layout]')?.getAttribute('data-layout');
    const names = [...root.querySelectorAll('[data-testid^=emenu-name-]')].map((e) => getComputedStyle(e).color);
    const photos = [...root.querySelectorAll('[data-testid^=emenu-photo-]')].map((e) => {
      const s = getComputedStyle(e);
      return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius].join(' ');
    });
    const title = root.querySelector<HTMLElement>('[data-testid=emenu-cover-title]');
    const dot = root.querySelector<HTMLElement>('[data-testid=emenu-cover-dot]');
    const rect = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    return {
      layout,
      names,
      photos,
      title: title ? { text: title.textContent, color: getComputedStyle(title).color, font: parseFloat(getComputedStyle(title).fontSize), rect: rect(title.firstElementChild ?? title) } : null,
      dot: dot ? { rect: rect(dot), color: getComputedStyle(dot).borderTopColor, radius: getComputedStyle(dot).borderTopLeftRadius } : null,
    };
  }, i);

test.describe('8.1.8 品牌部：顶栏字完整、标题右下角小圆圈、照片直角、品牌字色统一、选中分类没有光晕', () => {
  test('小米平板 6S Pro 12.4：测试服上那一版（主文字改过、照片加了圆角）打开以后，每一页都照品牌部的要求（预览码，只读）', async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== '门店电脑', '另开小米平板大小的窗口，只跑一次');
    test.setTimeout(120_000);
    const { ctx, page } = await xiaomiPad(browser, baseURL);
    try {
      const { code } = await send<{ code: string }>(page, '/api/studio/emenu/preview-code', { doc: testServerDoc() });
      await page.goto(`/emenu?studio=${code}`);
      await expect(page.getByTestId('emenu-studio-preview')).toBeVisible();
      await enterMenu(page);
      const pages = Number(await page.getByTestId('emenu-dots').getAttribute('data-pages'));
      expect(pages).toBe(6);
      let covers = 0;
      for (let i = 0; i < pages; i++) {
        if (i > 0) await page.keyboard.press('ArrowRight');
        await expect(page.getByTestId('emenu-dots')).toHaveAttribute('data-page', String(i));
        // ① ④ ⑤ 顶栏（每一页都看）
        const h = await headerFacts(page);
        expect(h.logo, `第 ${i + 1} 页字标`).toBe(BRAND);
        expect(h.selected, `第 ${i + 1} 页选中的分类`).toBe(BRAND);
        expect(h.glow).toBe(0);
        expect(h.shadows, '分类上没有阴影、光晕、渐变').toBe(0);
        for (const l of h.lines) {
          expect(l.clippers, `「${l.text}」外面不该有裁剪的框`).toEqual([]);
          expect(l.inside, `「${l.text}」整行在自己那一格里`).toBe(true);
        }
        // 很长的英文名整行缩小、不是被裁掉
        const long = h.lines.find((l) => l.text === 'SIGNATURE SEASONAL TASTING MENU')!;
        expect(long.fit).toBeLessThan(1);
        expect(h.lines.filter((l) => l.text === 'CHINESE LUNCH' || l.text === '中式午餐').every((l) => l.fit === 1)).toBe(true);
        // ③ ④ 这一页
        const p = await pageFacts(page, i);
        expect(p.names.length, `第 ${i + 1} 页（${p.layout}）有菜名`).toBeGreaterThan(0);
        for (const c of p.names) expect(c, `第 ${i + 1} 页（${p.layout}）菜名`).toBe(BRAND);
        expect(p.photos.length, `第 ${i + 1} 页（${p.layout}）有照片`).toBeGreaterThan(0);
        for (const r of p.photos) expect(r, `第 ${i + 1} 页（${p.layout}）照片四个角`).toBe('0px 0px 0px 0px');
        // ② 封面：标题深棕，右下角一个红色细线小圆圈（直径 0.35 个字，圆心在最后一个字的右下角）
        if (p.layout === 'cover') {
          covers++;
          expect(p.title!.color).toBe(BRAND);
          expect(p.dot, `第 ${i + 1} 页封面标题的小圆圈`).not.toBeNull();
          const t = p.title!.rect;
          const em = t.height; // 中文标题的行框正好一个字高
          const d = p.dot!.rect;
          expect(p.dot!.color).toBe(DOT);
          expect(p.dot!.radius).toBe('50%');
          expect(d.width).toBeCloseTo(0.35 * em, 0);
          expect(d.height).toBeCloseTo(0.35 * em, 0);
          expect(d.right - t.right).toBeCloseTo(0.12 * em, 0);
          expect(t.bottom - d.bottom).toBeCloseTo(0.055 * em, 0);
        }
      }
      expect(covers).toBe(2);

      // 英文：封面标题换成英文，小圆圈跟着在右下角；颜色照旧
      await page.getByTestId('emenu-lang').click();
      for (let i = pages - 1; i > 0; i--) await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('emenu-dots')).toHaveAttribute('data-page', '0');
      const en = await pageFacts(page, 0);
      expect(en.title!.text).toBe('CHINESE LUNCH');
      expect(en.title!.color).toBe(BRAND);
      expect(en.dot).not.toBeNull();
      expect(en.dot!.rect.left).toBeGreaterThan(en.title!.rect.right - 0.35 * en.title!.font);
      expect(en.dot!.rect.bottom).toBeLessThanOrEqual(en.title!.rect.bottom + 0.5);
      const h = await headerFacts(page);
      expect(h.selected).toBe(BRAND);
      for (const l of h.lines) expect(l.clippers, `英文「${l.text}」`).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  test('工作台：主文字是品牌规定的颜色、只显示不能改；卡片模板里的照片没有「圆角」，写着一律直角（店主打开，只看不改）', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '只跑一次');
    await login(page);
    await page.goto('/studio/emenu');
    await expect(page.getByTestId('studio-canvas')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('studio-tab-theme').click();
    const ink = page.getByTestId('studio-theme-ink');
    await expect(ink).toHaveAttribute('data-locked', '');
    await expect(ink).toContainText('#4b392a');
    await expect(ink.locator('input[type=color]')).toHaveCount(0);
    // 小圆圈的颜色固定、不进主题色（退回 8.1.7 时版面照样读得了，PB2）
    await expect(page.getByTestId('studio-theme-dot')).toHaveCount(0);
    await expect(page.getByTestId('studio-theme-tan').locator('input[type=color]')).toHaveCount(1);
    await page.getByTestId('studio-tab-templates').click();
    await page.getByTestId('studio-layout-single_left').click();
    await expect(page.getByTestId('studio-template-canvas')).toBeVisible();
    await page.getByTestId('studio-slot-item-photo').click();
    await expect(page.getByTestId('studio-slot-square')).toBeVisible();
    await expect(page.getByTestId('studio-slot-radius')).toHaveCount(0);
    // 画布上的照片也是直角
    const corners = await page
      .getByTestId('studio-template-canvas')
      .locator('[data-studio-slot=photo]')
      .first()
      .evaluate((e) => getComputedStyle(e).borderTopLeftRadius);
    expect(corners).toBe('0px');
  });
});
