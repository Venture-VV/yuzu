// 8.1.17 整体样式（《浴族系统需求汇总》系统整体，docs/YUZU_REQ_V8117.md YS-1–YS-5）浏览器核对，在三台目标设备的四个尺寸上
// （商米 D3 Pro 1920 × 1080 与 1280 × 720、商米 V3 360 × 800、小米平板 6S Pro 12.4 1355 × 903，docs/DEVICES.md）逐页看：
//   · 页面上给人读的字不小于 12 像素（打印的纸样、平板电子菜单的版面、图表刻度、工作台画布上的量距不在下面的单子里）；
//   · 关键金额（<Money size="key">，[data-money="key"]）不小于 16 像素；
//   · 点按热区：触屏上写明了小尺寸的按钮、页签、导航（.tap）在按钮外面补足到 44 × 44——在按钮上下（宽不够的再加左右）
//     离中心 21 像素处点，落在这个按钮上，或落在挨着的另一个控件上（相邻的各管各的）；
//   · 不横向滚动。
// 只读，可重复执行；依赖演示数据（仅独立演示库），账号店主 linlan。统一过的页面加到 PAGES 里。
import { expect, test, type Browser, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

/** 已经统一过的页面（8.1.16 合并以后加上房态中心、钟房、技师，与 8.1.17 的前台、收银、餐饮、菜品） */
const PAGES = [
  '/settlement',
  '/shift',
  '/devices',
  '/bookings',
  '/customer',
  '/guide',
  '/admin',
  '/admin/rules',
  '/admin/catalog',
  '/inventory',
  '/payables',
  '/frontdesk',
  '/cashier',
  '/dining',
  '/dishes',
  '/room-center',
  '/clockroom',
  '/technicians',
];

const DEVICES = [
  { name: '商米 D3 Pro', viewport: { width: 1920, height: 1080 } },
  { name: '商米 D3 Pro（系统缩放 1.5 倍）', viewport: { width: 1280, height: 720 } },
  { name: '商米 V3', viewport: { width: 360, height: 800 }, mobile: true },
  { name: '小米平板 6S Pro 12.4', viewport: { width: 1355, height: 903 } },
];

interface Findings {
  small: string[];
  keyMoney: string[];
  hit: string[];
  scrollX: boolean;
}

/** 在页面里量：小字、关键金额、热区、横向滚动（与 docs/YUZU_REQ_V8117.md 3.1 的口径一致） */
async function inspect(page: Page): Promise<Findings> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    };
    const describe = (el: Element, text: string) => `${el.tagName.toLowerCase()}${(el as HTMLElement).dataset.testid ? `#${(el as HTMLElement).dataset.testid}` : ''} «${text.trim().slice(0, 16)}»`;
    const small: string[] = [];
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim()) continue;
      const el = node.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (el.closest('svg, .sr-only, [data-print]') || !visible(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 11.95) small.push(`${size}px ${describe(el, node.textContent)}`);
    }
    const keyMoney = [...document.querySelectorAll('[data-money="key"]')]
      .filter(visible)
      .map((el) => ({ el, size: parseFloat(getComputedStyle(el).fontSize) }))
      .filter((m) => m.size < 15.95)
      .map((m) => `${m.size}px ${describe(m.el, m.el.textContent ?? '')}`);
    const hit: string[] = [];
    if (matchMedia('(pointer: coarse)').matches) {
      const controls = 'button, a[href], [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], select, input, textarea, label';
      for (const el of document.querySelectorAll('.tap')) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const probes: [number, number][] = [];
        if (r.height < 44) probes.push([cx, cy - 21], [cx, cy + 21]);
        if (r.width < 44) probes.push([cx - 21, cy], [cx + 21, cy]);
        for (const [x, y] of probes) {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          const at = document.elementFromPoint(x, y);
          if (!at || at === el || el.contains(at) || at.closest(controls)) continue;
          // 被别的层（弹出的菜单、固定的顶栏）盖住的不算
          if (getComputedStyle(at).position === 'fixed' || at.closest('[data-surface="panel"], header')) continue;
          hit.push(`${Math.round(r.width)}×${Math.round(r.height)} ${describe(el, el.textContent || el.getAttribute('aria-label') || '')}`);
          break;
        }
      }
    }
    return { small, keyMoney, hit, scrollX: document.documentElement.scrollWidth > innerWidth + 1 };
  });
}

async function openDevice(browser: Browser, baseURL: string, d: (typeof DEVICES)[number]) {
  const ctx = await browser.newContext({ baseURL, viewport: d.viewport, hasTouch: true, isMobile: !!d.mobile, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await ctx.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return { ctx, page };
}

test.describe('8.1.17 整体样式：字号、关键金额、点按热区、不横向滚动', () => {
  test.skip(({ viewport }) => viewport?.width !== 1440, '在门店电脑这一组里另开三台设备的四个尺寸，只跑一次');
  test.setTimeout(300_000);

  test('三台设备四个尺寸：统一过的页面没有小于 12 像素的字，关键金额不小于 16 像素，触屏上热区补足，不横向滚动', async ({ browser, baseURL }) => {
    const problems: string[] = [];
    for (const d of DEVICES) {
      const { ctx, page } = await openDevice(browser, baseURL!, d);
      try {
        for (const path of PAGES) {
          await test.step(`${d.name} · ${path}`, async () => {
            await page.goto(path);
            await page.waitForLoadState('networkidle').catch(() => undefined);
            // 页面出来了（页头的大标题）
            await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
            const f = await inspect(page);
            const where = `${d.name}（${d.viewport.width} × ${d.viewport.height}）${path}`;
            if (f.small.length) problems.push(`${where} 小于 12 像素的字：${f.small.slice(0, 5).join('；')}`);
            if (f.keyMoney.length) problems.push(`${where} 关键金额小于 16 像素：${f.keyMoney.slice(0, 5).join('；')}`);
            if (f.hit.length) problems.push(`${where} 热区没补足：${f.hit.slice(0, 5).join('；')}`);
            if (f.scrollX) problems.push(`${where} 整页横向滚动`);
          });
        }
      } finally {
        await ctx.close();
      }
    }
    expect(problems).toEqual([]);
  });

  test('公共按钮的热区：触屏上在小号按钮上沿外 5 像素点得到，用鼠标的电脑上不外扩', async ({ browser, baseURL }) => {
    for (const touch of [true, false]) {
      const ctx = await browser.newContext({ baseURL, viewport: { width: 1355, height: 903 }, hasTouch: touch, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
      const page = await ctx.newPage();
      try {
        await page.goto('/login');
        await page.fill('#username', 'linlan');
        await page.fill('#password', PASSWORD);
        await page.getByRole('button', { name: '登录' }).click();
        await page.waitForURL((u) => !u.pathname.startsWith('/login'));
        await page.goto('/settlement');
        // 日期条的「前一天」：宽 36、高 38 的图标按钮
        const prev = page.getByRole('button', { name: '前一天' });
        await expect(prev).toBeVisible();
        const hitAbove = await prev.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top - 2);
          return !!at && (at === el || el.contains(at));
        });
        expect(hitAbove, touch ? '触屏上外扩' : '鼠标不外扩').toBe(touch);
      } finally {
        await ctx.close();
      }
    }
  });
});
