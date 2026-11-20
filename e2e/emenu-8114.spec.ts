// 8.1.14 品牌部《工作台需求汇总 1.2》的三条（docs/EMENU.md 第 17 节，docs/HANDOFF_V8114.md，PENDING_DECISIONS.md PC1–PC4）的浏览器验收。
// 只在「门店电脑」这一组跑，平板那一段另开小米平板 6S Pro 12.4 大小的窗口（1355 × 903）；菜单、找客人、桌号用合成的（只读）。
//   ① 顶栏分类的英文、菜品的英文名是衬线展示体（8.1.19 起排在最前的是门店授权的品牌英文字体 ABC Arizona Flare，测试环境没放
//      授权文件，画出来的是后面的 Playfair Display，随应用打包）；别处的英文（介绍、价格、手牌）照旧；
//      中文、英文两种语言都看，字体真的下载到、画出来的宽与这款字体量出来的一样（不是落到后面的字体上）；
//   ② 加号与菜名的间距：「大图 + 文字」「文字陈列」2 个加号，其余九种版式 3.5 个（放大一档、原样两种大小都看）；
//   ③ 封面标题右下角是手绘的不规则圆环（矢量图）：颜色 #bf1d25，大小、中文的位置与原来一样；切到英文跟着在标题右下角、
//      在最后一个字母的外面（不压字）；不出左半边、不被裁。
// 只要 seed-demo 的店主 linlan（密码 yuzu2026）。可重复执行。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { DEFAULT_EMENU_PERIODS, EMENU_LAYOUTS, type EmenuLayout, type EmenuMenu } from '../src/shared/emenu';
import { EMENU_PLUS_GAP } from '../src/shared/studio';

const PASSWORD = 'yuzu2026';
/** 小米平板 6S Pro 12.4：HyperOS 默认显示大小下网页看到 1355 × 903 */
const XIAOMI = { width: 1355, height: 903 };
const DOT = 'rgb(191, 29, 37)'; // #bf1d25
/** 按 2 倍算的两种版式；其余九种 3.5 倍 */
const TEXT_GAP_LAYOUTS: EmenuLayout[] = ['list_image', 'list_text'];

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

/**
 * 合成的菜单：11 种版式各一页，多一页封面。菜名都只有两三个字——最窄的那一格（三菜 · 错落的第三道）也放得下
 * 「菜名 + 整段间距 + 加号」，量出来的就是规定的倍数（菜名长、地方不够时间距会往下收，最少 1 倍，那是原来就有的）
 */
function syntheticMenu(textSize: 'large' | 'design'): EmenuMenu {
  const dish = (id: number, name: string, nameEn: string) => ({
    id,
    name,
    nameEn,
    tagline: '',
    description: '黄椒酱的加入不仅增添了鲜辣馥郁的独特风味。',
    attrs: ['产地：中国广东'],
    unit: '份',
    taglineEn: '',
    descriptionEn: 'The yellow pepper sauce adds a fresh, spicy aroma.',
    attrsEn: ['Origin: Guangdong'],
    unitEn: '',
    imageUrl: null,
    detailUrl: null,
    specs: [{ itemId: 9000 + id, label: '', labelEn: '', price: 4200, state: 'ok' as const, remaining: null }],
  });
  const DISHES = [
    dish(1, '牛肉面', 'Beef Noodles'),
    dish(2, '阳春面', 'Plain Noodles'),
    dish(3, '小笼包', 'Soup Dumplings'),
    dish(4, '豆浆', 'Soy Milk'),
    dish(5, '油条', 'Fried Dough'),
    dish(6, '烧卖', 'Shumai'),
    dish(7, '虾饺', 'Har Gow'),
    dish(8, '叉烧', 'Char Siu'),
    dish(9, '肠粉', 'Rice Rolls'),
    dish(10, '蛋挞', 'Egg Tart'),
  ];
  const cat = (id: number, name: string, nameEn: string, pages: [EmenuLayout, number[]][]) => ({
    id,
    name,
    nameEn,
    periods: [],
    window: null,
    open: true,
    pages: pages.map(([layout, ids]) => ({
      layout,
      title: layout.startsWith('list') ? '精品推荐' : '',
      titleEn: layout.startsWith('list') ? 'BEST SELLERS' : '',
      dishes: ids.map((i) => DISHES[i - 1]!),
    })),
  });
  return {
    serverTime: new Date().toISOString(),
    businessDate: '2026-11-19',
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
      textSize,
      periods: [...DEFAULT_EMENU_PERIODS],
      coverUrl: null,
    },
    period: { ...DEFAULT_EMENU_PERIODS[1]!, end: DEFAULT_EMENU_PERIODS[2]!.start },
    nextChangeAt: null,
    categories: [
      cat(1, '中式午餐', 'CHINESE LUNCH', [
        ['cover', [1]],
        ['list_image', [1, 2, 3, 4, 5, 6]],
        ['single_wide', [7]],
        ['single_left', [8]],
        ['single_right', [9]],
      ]),
      cat(2, '酒水', 'BEVERAGE', [['list_text', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]]),
      cat(3, '西式午餐', 'WESTERN LUNCH', [
        ['duo_stagger', [1, 2]],
        ['duo_row', [3, 4]],
        ['duo_mixed', [5, 6]],
      ]),
      cat(4, '中式早餐', 'CHINESE BREAKFAST', [
        ['cover', [10]],
        ['trio_row', [4, 5, 6]],
        ['trio_mixed', [7, 8, 9]],
      ]),
    ],
    later: [],
    tables: [],
  };
}

async function xiaomiPad(browser: Browser, baseURL: string | undefined, textSize: 'large' | 'design') {
  const ctx = await browser.newContext({ baseURL, viewport: XIAOMI, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage();
  await login(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/emenu/**', (route, request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET') return route.abort();
    if (url.pathname === '/api/emenu/menu') return route.fulfill({ json: syntheticMenu(textSize) });
    if (url.pathname === '/api/emenu/guest') return route.fulfill({ json: { visitId: 1, tagCode: 'A8060', ordered: [], orderedTotal: 0 } });
    if (url.pathname === '/api/emenu/table') return route.fulfill({ json: { tableName: 'A01' } });
    if (url.pathname.startsWith('/api/emenu/orders/by-key/')) return route.fulfill({ json: { found: false, abandoned: false } });
    // 授权的品牌英文字体：这里当作门店没放（404）——衬线展示体随应用打包，不靠它
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
  await page.goto('/emenu');
  await page.getByTestId('emenu-start').click();
  for (const d of '8060') await page.getByTestId(`emenu-key-${d}`).click();
  await page.getByTestId('emenu-field-table').click();
  await page.getByTestId('emenu-key-clear').click();
  for (const d of '01') await page.getByTestId(`emenu-key-${d}`).click();
  await page.getByTestId('emenu-field-guests').click();
  await page.getByTestId('emenu-key-2').click();
  await page.getByTestId('emenu-ask-go').click();
  await expect(page.getByTestId('emenu-header')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** 顶栏分类的每一行字：用的字体、是不是英文那一行 */
const headerLines = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid=emenu-header] [data-cat-line]')].map((el) => ({
      text: el.textContent ?? '',
      font: getComputedStyle(el).fontFamily,
      display: el.classList.contains('em-en-display'),
    })),
  );

/** 当前这一页：版式、每道菜的英文名用的字体、加号离菜名几个加号宽、封面标题与圆环 */
const pageFacts = (page: Page, i: number) =>
  page.evaluate((i) => {
    const root = document.querySelector(`[data-page="${i}"]`)!;
    const rect = (e: { getBoundingClientRect(): DOMRect }) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const dishes = [...root.querySelectorAll<HTMLElement>('[data-testid^=emenu-dish-]')].map((d) => {
      const id = d.getAttribute('data-testid')!.replace('emenu-dish-', '');
      const name = d.querySelector<HTMLElement>(`[data-testid="emenu-name-${id}"]`)!;
      const add = d.querySelector<HTMLElement>(`[data-testid="emenu-add-${id}"]`)!;
      const n = name.getBoundingClientRect();
      const a = add.getBoundingClientRect();
      const display = [...d.querySelectorAll<HTMLElement>('.em-en-display')];
      return { id, name: name.textContent ?? '', gap: (a.left - n.right) / a.width, plus: a.width, display: display.map((e) => ({ text: e.textContent ?? '', font: getComputedStyle(e).fontFamily })) };
    });
    const title = root.querySelector<HTMLElement>('[data-testid=emenu-cover-title]');
    const dot = root.querySelector<SVGSVGElement>('[data-testid=emenu-cover-dot]');
    // 标题最后一个字（字母）画在哪
    let last: ReturnType<typeof rect> | null = null;
    const span = title?.firstElementChild;
    const node = span?.firstChild;
    if (node && node.nodeType === Node.TEXT_NODE && node.textContent) {
      const range = document.createRange();
      range.setStart(node, node.textContent.length - 1);
      range.setEnd(node, node.textContent.length);
      last = rect(range);
    }
    const photos = [...root.querySelectorAll('[data-testid^=emenu-photo-]')].map(rect);
    return {
      layout: root.querySelector('[data-layout]')?.getAttribute('data-layout') ?? null,
      dishes,
      title: title && span ? { text: title.textContent ?? '', font: parseFloat(getComputedStyle(title).fontSize), rect: rect(span), family: getComputedStyle(title).fontFamily } : null,
      last,
      dot: dot
        ? {
            tag: dot.tagName.toLowerCase(),
            rect: rect(dot),
            fill: getComputedStyle(dot.querySelector('path')!).fill,
            subpaths: (dot.querySelector('path')!.getAttribute('d')!.match(/M/g) ?? []).length,
            overflow: getComputedStyle(dot).overflow,
          }
        : null,
      photoLeft: photos.length ? Math.min(...photos.filter((p) => p.left > innerWidth / 2).map((p) => p.left)) : null,
    };
  }, i);

/** 页面上一段字用衬线展示体时的宽，与两款字体各自量出来的宽（画布上量，都换算成同一个字号） */
const probeDisplayFont = (page: Page) =>
  page.evaluate(async () => {
    const TEXT = 'Cantonese Pork Trotter Ginger Vinegar Fish Maw';
    await document.fonts.load("40px 'Playfair Display'", TEXT);
    await document.fonts.load("40px 'Average Sans'", TEXT);
    const root = document.querySelector<HTMLElement>('.emenu')!;
    const probe = document.createElement('span');
    probe.className = 'em-en-display';
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;font-size:40px;white-space:nowrap';
    probe.textContent = TEXT;
    root.appendChild(probe);
    const shown = probe.getBoundingClientRect().width / (root.getBoundingClientRect().width / root.offsetWidth || 1);
    const style = getComputedStyle(probe);
    const facts = { family: style.fontFamily, spacing: style.letterSpacing, numeric: style.fontVariantNumeric, width: probe.offsetWidth };
    probe.remove();
    const ctx = document.createElement('canvas').getContext('2d')!;
    const measure = (family: string) => {
      ctx.font = `40px ${family}`;
      return ctx.measureText(TEXT).width;
    };
    return {
      ...facts,
      shown,
      playfair: measure("'Playfair Display'"),
      averageSans: measure("'Average Sans'"),
      loaded: [...document.fonts].filter((f) => f.family.replace(/['"]/g, '') === 'Playfair Display').map((f) => f.status),
    };
  });

test.describe('8.1.14 品牌部：英文衬线展示体、加号间距 2 / 3.5、封面标题右下角的手绘圆环', () => {
  test('小米平板 6S Pro 12.4（放大一档）：11 种版式逐页核对字体与间距，封面的圆环；切到英文再核对一遍（只读）', async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== '门店电脑', '另开小米平板大小的窗口，只跑一次');
    test.setTimeout(150_000);
    const { ctx, page } = await xiaomiPad(browser, baseURL, 'large');
    try {
      await enterMenu(page);
      const pages = Number(await page.getByTestId('emenu-dots').getAttribute('data-pages'));
      expect(pages).toBe(12);

      // ① 衬线展示体真的用上了：这个类画出来的宽 = Playfair Display 量出来的宽，与顶替字体 Average Sans 的不一样
      const probe = await probeDisplayFont(page);
      expect(probe.family).toMatch(/^"Em Box En", "Tangqi Brand En", "Playfair Display"/);
      expect(probe.loaded).toContain('loaded');
      expect(probe.spacing).toBe('normal');
      expect(probe.numeric).toContain('lining-nums');
      // 页面上排版与画布上量的会差千分之几（字偶间距的取整不一样），所以比的是「离哪一款近」：两款字体差着一成
      console.log(`衬线展示体的宽：页面 ${probe.width}，Playfair Display ${probe.playfair.toFixed(1)}，Average Sans ${probe.averageSans.toFixed(1)}`);
      expect(Math.abs(probe.playfair - probe.averageSans)).toBeGreaterThan(probe.playfair * 0.05);
      expect(Math.abs(probe.width - probe.playfair)).toBeLessThan(probe.playfair * 0.01);

      // ① 顶栏：英文那一行是衬线展示体，中文那一行不是
      const zhHead = await headerLines(page);
      expect(zhHead.filter((l) => l.display).map((l) => l.text)).toEqual(['CHINESE LUNCH', 'BEVERAGE', 'WESTERN LUNCH', 'CHINESE BREAKFAST']);
      for (const l of zhHead) {
        if (l.display) expect(l.font, l.text).toMatch(/^"Em Box En", "Tangqi Brand En", "Playfair Display"/);
        else expect(l.font, l.text).not.toContain('Playfair');
      }
      // 别处的英文照旧：手牌号、价格不是衬线展示体
      for (const sel of ['[data-testid=emenu-tag] .em-en', '[data-page="0"] [data-testid^=emenu-dish-] .em-en']) {
        const fonts = await page.locator(sel).evaluateAll((els) => els.map((e) => getComputedStyle(e).fontFamily));
        expect(fonts.length, sel).toBeGreaterThan(0);
        for (const f of fonts) expect(f, sel).not.toContain('Playfair');
      }

      const seen = new Set<string>();
      const covers: NonNullable<Awaited<ReturnType<typeof pageFacts>>['dot']>[] = [];
      for (let i = 0; i < pages; i++) {
        if (i > 0) await page.keyboard.press('ArrowRight');
        await expect(page.getByTestId('emenu-dots')).toHaveAttribute('data-page', String(i));
        const p = await pageFacts(page, i);
        const layout = p.layout as EmenuLayout;
        seen.add(layout);
        expect(p.dishes.length, `第 ${i + 1} 页（${layout}）有菜`).toBeGreaterThan(0);
        // ② 间距：以加号的宽为 1
        const want = TEXT_GAP_LAYOUTS.includes(layout) ? EMENU_PLUS_GAP.text : EMENU_PLUS_GAP.photo;
        for (const d of p.dishes) {
          expect(d.gap, `第 ${i + 1} 页（${layout}）「${d.name}」的加号离菜名几个加号宽`).toBeCloseTo(want, 1);
          // ① 中文时每道菜下面那一行英文名是衬线展示体
          expect(d.display, `第 ${i + 1} 页（${layout}）「${d.name}」的英文名`).toHaveLength(1);
          expect(d.display[0]!.text).toMatch(/^[A-Za-z ]+$/);
          expect(d.display[0]!.font).toMatch(/^"Em Box En", "Tangqi Brand En", "Playfair Display"/);
        }
        // ③ 封面标题右下角的圆环
        if (layout === 'cover') {
          expect(p.dot, `第 ${i + 1} 页封面的圆环`).not.toBeNull();
          const dot = p.dot!;
          covers.push(dot);
          const t = p.title!.rect;
          const em = t.height; // 中文标题的行框正好一个字高
          expect(dot.tag).toBe('svg');
          expect(dot.fill).toBe(DOT);
          expect(dot.subpaths).toBe(2); // 留着缺口的环 + 缺口处的墨点
          expect(dot.overflow).toBe('visible');
          // 大小、位置与原来的小圆圈一样
          expect(dot.rect.width).toBeCloseTo(0.35 * em, 0);
          expect(dot.rect.height).toBeCloseTo(0.35 * em, 0);
          expect(dot.rect.right - t.right).toBeCloseTo(0.12 * em, 0);
          expect(t.bottom - dot.rect.bottom).toBeCloseTo(0.055 * em, 0);
          // 不出左半边、不出屏幕
          expect(dot.rect.right).toBeLessThan(p.photoLeft!);
          expect(dot.rect.bottom).toBeLessThan(XIAOMI.height);
        } else {
          expect(p.dot).toBeNull();
        }
      }
      expect([...seen].sort()).toEqual([...EMENU_LAYOUTS].sort());
      // 两个封面的圆环一样大
      expect(covers).toHaveLength(2);
      expect(covers[1]!.rect.width).toBeCloseTo(covers[0]!.rect.width, 1);

      // 切到英文：顶栏的英文成了主行，照样是衬线展示体；菜名（英文为主）是衬线展示体，下面的中文名不是
      await page.getByTestId('emenu-lang').click();
      for (let i = pages - 1; i > 0; i--) await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('emenu-dots')).toHaveAttribute('data-page', '0');
      const enHead = await headerLines(page);
      expect(enHead.filter((l) => l.display).map((l) => l.text)).toEqual(['CHINESE LUNCH', 'BEVERAGE', 'WESTERN LUNCH', 'CHINESE BREAKFAST']);
      for (const l of enHead.filter((l) => l.display)) expect(l.font).toMatch(/^"Em Box En", "Tangqi Brand En", "Playfair Display"/);
      const en = await pageFacts(page, 0);
      expect(en.title!.text).toBe('CHINESE LUNCH');
      // 封面的大标题不在这次改的范围里：照旧是原来的英文字体
      expect(en.title!.family).not.toContain('Playfair');
      expect(en.dishes[0]!.display.map((d) => d.text)).toEqual(['Beef Noodles']);
      expect(en.dishes[0]!.display[0]!.font).toMatch(/^"Em Box En", "Tangqi Brand En", "Playfair Display"/);
      // ③ 圆环跟着在英文标题的右下角：在最后一个字母的外面（不压字），下沿不低过这一行，不出左半边
      const dot = en.dot!;
      expect(dot.fill).toBe(DOT);
      // 大小照旧是 0.35 个字：英文标题的字号（设计稿像素）× 页面的缩放（中文封面的圆环是 0.35 × 48 设计稿像素，由它算出缩放）
      const scale = covers[0]!.rect.width / (0.35 * 48);
      expect(dot.rect.width).toBeCloseTo(0.35 * en.title!.font * scale, 0);
      expect(en.last, '量得到最后一个字母').not.toBeNull();
      // 最后一个字母的字框：右沿 = 这一行的右沿 − 标题的字距（0.04 个字）。圆环的左沿在它外面
      const em = en.title!.font * scale;
      expect(en.last!.right).toBeCloseTo(en.title!.rect.right, 0);
      expect(dot.rect.left, '圆环的左沿在最后一个字母的字框外面').toBeGreaterThanOrEqual(en.last!.right - 0.04 * em);
      expect(dot.rect.left - en.title!.rect.right).toBeLessThan(0.1 * dot.rect.width);
      expect(dot.rect.bottom).toBeLessThanOrEqual(en.title!.rect.bottom + 0.5);
      expect(dot.rect.top).toBeGreaterThan(en.title!.rect.top);
      expect(dot.rect.right).toBeLessThan(en.photoLeft!);
    } finally {
      await ctx.close();
    }
  });

  test('小米平板 6S Pro 12.4（原样的大小）：加号的间距同样是 2 / 3.5 个加号', async ({ browser, baseURL }, info) => {
    test.skip(info.project.name !== '门店电脑', '另开小米平板大小的窗口，只跑一次');
    test.setTimeout(120_000);
    const { ctx, page } = await xiaomiPad(browser, baseURL, 'design');
    try {
      await enterMenu(page);
      const pages = Number(await page.getByTestId('emenu-dots').getAttribute('data-pages'));
      for (let i = 0; i < pages; i++) {
        if (i > 0) await page.keyboard.press('ArrowRight');
        await expect(page.getByTestId('emenu-dots')).toHaveAttribute('data-page', String(i));
        const p = await pageFacts(page, i);
        const layout = p.layout as EmenuLayout;
        const want = TEXT_GAP_LAYOUTS.includes(layout) ? EMENU_PLUS_GAP.text : EMENU_PLUS_GAP.photo;
        for (const d of p.dishes) expect(d.gap, `第 ${i + 1} 页（${layout}）「${d.name}」`).toBeCloseTo(want, 1);
      }
    } finally {
      await ctx.close();
    }
  });
});
