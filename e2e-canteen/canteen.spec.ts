// 员工食堂 · 柚子饭堂（docs/CANTEEN.md）的浏览器流程：后台（电脑尺寸）准备名单与开通卡片 →
// 厨师在手机上发布菜单 → 员工开通、点赞、亮饭卡码 → 负责人「从相册选」员工的码打卡、重复扫提示已打卡、
// 断网扫到先记下、联网后自动补登 → 后台看到人数与记录。
// 要应用开着员工端口：E2E_BASE_URL（员工后台，默认 http://localhost:8080）、E2E_CANTEEN_URL（员工端口，默认 http://localhost:8090），
// 库里要有演示的店主 linlan（seed-demo）。只在独立演示库上跑：会建部门、员工、菜单与打卡。

import { mkdirSync } from 'node:fs';
import { expect, test, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';

const CANTEEN = process.env.E2E_CANTEEN_URL ?? 'http://localhost:8090';
const OUT = 'test-results/canteen';
mkdirSync(OUT, { recursive: true });

const tz = 'Asia/Shanghai';
const hhmm = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));

/** 手机：安卓（Pixel 5）与 iPhone 尺寸（都用 Chromium） */
const PHONES = {
  android: { ...devices['Pixel 5'] },
  iphone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: devices['iPhone 13'].userAgent },
};

async function phone(browser: Browser, kind: keyof typeof PHONES): Promise<BrowserContext> {
  return browser.newContext({ ...PHONES[kind], locale: 'zh-CN', timezoneId: tz });
}

/** 扫开通卡片打开（#join=开通码），设密码，进首页 */
async function join(ctx: BrowserContext, code: string, password: string): Promise<Page> {
  const p = await ctx.newPage();
  await p.goto(`${CANTEEN}/#join=${code}`);
  await expect(p.getByText(/欢迎你/)).toBeVisible();
  await p.getByLabel('新密码', { exact: true }).fill(password);
  await p.getByLabel('再输一遍密码').fill(password);
  await p.getByRole('button', { name: /开吃/ }).click();
  await expect(p.getByTestId('tab-home')).toBeVisible();
  return p;
}

/** 页面没有横向滚动 */
async function noOverflow(p: Page) {
  const [scroll, client] = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, '页面不应横向溢出').toBeLessThanOrEqual(client + 1);
}

test.describe.serial('员工食堂 · 柚子饭堂', () => {
  let admin: Page;
  let slot: { meal: string; date: string };
  const codes: Record<string, string> = {};

  test('后台：开模块、建食堂部门、设开饭时间与员工入口、加人、打印开通卡片', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: tz });
    admin = await ctx.newPage();
    await admin.goto('/login');
    await admin.fill('#username', 'linlan');
    await admin.fill('#password', 'yuzu2026');
    await admin.getByRole('button', { name: '登录' }).click();
    await admin.waitForURL((u) => !u.pathname.startsWith('/login'));
    expect((await ctx.request.put('/api/erp/modules', { data: { modules: { canteen: true } } })).status()).toBe(200);

    await admin.goto('/erp/canteen');
    await expect(admin.getByTestId('canteen-setup')).toBeVisible();
    await admin.getByRole('radio', { name: '设置' }).click();
    await admin.getByTestId('canteen-create-dept').click();
    await expect(admin.getByText('「员工食堂」部门建好了')).toBeVisible();
    await admin.getByLabel('员工入口地址').fill(CANTEEN);
    await admin.getByTestId('canteen-save-settings').click();
    await expect(admin.getByText('设置存好了')).toBeVisible();
    // 开饭时间：只开午餐，前后各两小时（不管几点跑都在开饭时间里）
    const settings = await (await ctx.request.get('/api/erp/canteen/settings')).json();
    const now = Date.now();
    const meals = settings.meals.map((m: { meal: string }) =>
      m.meal === 'lunch' ? { ...m, enabled: true, start: hhmm(now - 2 * 3_600_000), end: hhmm(now + 2 * 3_600_000) } : { ...m, enabled: false },
    );
    expect((await ctx.request.put('/api/erp/canteen/settings', { data: { ...settings, meals } })).status()).toBe(200);

    await admin.getByRole('radio', { name: '员工名单' }).click();
    await admin.getByTestId('canteen-add').click();
    await admin.getByLabel('工号', { exact: true }).fill('m001');
    await admin.getByLabel('姓名', { exact: true }).fill('陈姐');
    await admin.getByRole('radio', { name: '食堂负责人' }).click();
    await admin.getByTestId('canteen-save-employee').click();
    await expect(admin.getByTestId('canteen-new-card')).toBeVisible();
    codes.M001 = (await admin.getByTestId('canteen-activation-code').innerText()).replace('-', '');
    await admin.keyboard.press('Escape');

    await admin.getByTestId('canteen-batch').click();
    await admin.getByLabel('名单').fill('A001 小林\nA002 小周\nbad! 坏工号');
    await admin.getByTestId('canteen-batch-preview').click();
    await expect(admin.getByText('工号只能是字母、数字和短横线')).toBeVisible();
    await expect(admin.getByTestId('canteen-batch-apply')).toBeDisabled();
    await admin.getByLabel('名单').fill('A001 小林\nA002 小周\nM001 陈姐 员工食堂');
    await admin.getByTestId('canteen-batch-preview').click();
    await expect(admin.getByText('已有，跳过')).toBeVisible();
    await admin.getByTestId('canteen-batch-apply').click();
    await expect(admin.getByText('加上了 2 位')).toBeVisible();
    const dept = settings.departmentId ?? (await (await ctx.request.get('/api/erp/canteen/settings')).json()).departmentId;
    expect((await ctx.request.post('/api/erp/canteen/employees', { data: { empNo: 'C001', name: '王师傅', role: 'cook', departmentId: dept } })).status()).toBe(200);
    for (const c of await (await ctx.request.get('/api/erp/canteen/activation-cards')).json()) codes[c.empNo] = c.code;
    expect(Object.keys(codes).sort()).toEqual(['A001', 'A002', 'C001', 'M001']);

    // 开通卡片（A4）：每人一张，带扫码开通的二维码
    const print = await ctx.newPage();
    await print.goto('/print/canteen-cards/all');
    await expect(print.getByTestId('canteen-card')).toHaveCount(4);
    await expect(print.getByTestId('canteen-card').first().locator('svg[data-qr]')).toHaveAttribute('data-qr', new RegExp(`^${CANTEEN.replace(/[.:/]/g, '\\$&')}/#join=`));
    await print.screenshot({ path: `${OUT}/cards.png`, fullPage: true });
    await print.close();
  });

  test('员工端口只有柚子饭堂：主端口没有 /api/canteen，员工端口没有管理接口；页面带安全头', async ({ request }) => {
    expect((await request.get('/api/canteen/ping')).status()).toBe(404);
    expect((await request.get(`${CANTEEN}/api/erp/canteen/overview`)).status()).toBe(404);
    const page = await request.get(`${CANTEEN}/`);
    expect(page.status()).toBe(200);
    expect(page.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers()['x-frame-options']).toBe('DENY');
  });

  test('厨师：手机上发布这一餐的菜单', async ({ browser }) => {
    const ctx = await phone(browser, 'android');
    const cook = await join(ctx, codes.C001!, 'wang-2026');
    slot = await currentSlot(ctx);
    await cook.getByTestId('tab-kitchen').click();
    await cook.getByRole('tab', { name: new RegExp(slot.date === (await today(ctx)) ? '今天' : '昨天') }).click();
    await cook.getByRole('button', { name: /午餐/ }).click();
    for (const [i, name] of ['红烧肉', '清炒时蔬'].entries()) {
      await cook.getByRole('button', { name: '＋ 加一道菜' }).click();
      await cook.getByLabel(`第 ${i + 1} 道菜的名字`).fill(name);
    }
    await cook.getByTestId('dish-editor').first().getByRole('button', { name: /招牌/ }).click();
    await cook.getByLabel('一句话备注').fill('今天有甜品');
    await cook.getByRole('button', { name: '发布给大家' }).click();
    await expect(cook.getByText('发布啦')).toBeVisible();
    await expect(cook.getByText('已发布')).toBeVisible();
    await noOverflow(cook);
    await cook.screenshot({ path: `${OUT}/kitchen.png`, fullPage: true });
    await ctx.close();
  });

  test('员工：看到菜单、点赞、亮出饭卡码（两种手机尺寸）', async ({ browser }) => {
    for (const [kind, empNo, pw] of [
      ['iphone', 'A001', 'lin-2026'],
      ['android', 'A002', 'zhou-2026'],
    ] as const) {
      const ctx = await phone(browser, kind);
      const p = await join(ctx, codes[empNo]!, pw);
      await expect(p.getByTestId('meal-lunch').getByText('红烧肉')).toBeVisible();
      await noOverflow(p);
      if (empNo === 'A001') {
        const heart = p.getByRole('button', { name: '点赞：红烧肉' });
        await heart.click();
        await expect(p.getByRole('button', { name: '取消点赞：红烧肉' })).toHaveAttribute('aria-pressed', 'true');
        await p.screenshot({ path: `${OUT}/home.png`, fullPage: true });
      }
      await p.getByTestId('show-code').click();
      const qr = p.getByTestId('meal-code').locator('svg[data-qr]');
      await expect(qr).toHaveAttribute('data-qr', /^YZC1:/);
      await noOverflow(p);
      await p.getByTestId('meal-code').screenshot({ path: `${OUT}/qr-${empNo}.png` });
      if (empNo === 'A001') await p.screenshot({ path: `${OUT}/code.png` });
      await ctx.close();
    }
  });

  test('负责人：从相册选员工的码打卡；同一餐再扫提示已打卡；断网扫到先记下、联网自动补登', async ({ browser }) => {
    const ctx = await phone(browser, 'android');
    const mgr = await join(ctx, codes.M001!, 'chen-2026');
    await mgr.getByTestId('tab-scan').click();
    await noOverflow(mgr);
    const result = mgr.getByTestId('scan-result');

    await mgr.getByTestId('scan-file').setInputFiles(`${OUT}/qr-A001.png`);
    await expect(result).toHaveAttribute('data-status', 'ok');
    await expect(result).toContainText('小林');
    await expect(result).toContainText('午餐打卡成功');
    await mgr.screenshot({ path: `${OUT}/scan-ok.png` });
    await result.click();

    await mgr.getByTestId('scan-file').setInputFiles(`${OUT}/qr-A001.png`);
    await expect(result).toHaveAttribute('data-status', 'already');
    await expect(result).toContainText('已经打过卡啦');
    await result.click();

    await ctx.setOffline(true);
    await mgr.getByTestId('scan-file').setInputFiles(`${OUT}/qr-A002.png`);
    await expect(result).toHaveAttribute('data-status', 'queued');
    await expect(mgr.getByTestId('queued-count')).toHaveText('1');
    await result.click();
    await ctx.setOffline(false);
    await expect(mgr.getByTestId('settled-item').first()).toContainText('小周', { timeout: 30_000 });
    await expect(mgr.getByTestId('settled-item').first()).toContainText('补登成功');
    await expect(mgr.getByTestId('count-lunch')).toHaveText('2');

    // 手动登记：没带手机的厨师
    await mgr.getByRole('button', { name: /手动登记/ }).click();
    await mgr.getByLabel('搜姓名或工号').fill('王');
    await mgr.getByRole('button', { name: '手机没电' }).click();
    await mgr.getByRole('button', { name: '登记', exact: true }).click();
    await expect(result).toHaveAttribute('data-status', 'ok');
    await expect(result).toContainText('王师傅');
    await mgr.screenshot({ path: `${OUT}/scan-manual.png` });
    await ctx.close();
  });

  test('后台：今天的人数、用餐记录与撤销、菜单的赞数', async () => {
    await admin.goto('/erp/canteen');
    await expect(admin.getByTestId('canteen-count-lunch')).toContainText('3');
    // 用餐记录默认列最近两天（过了零点还在开的那一餐记在前一天）
    await admin.getByRole('radio', { name: '用餐记录' }).click();
    await expect(admin.getByText('有效 3 条')).toBeVisible();
    await admin.getByRole('row', { name: /王师傅/ }).getByRole('button', { name: '撤销' }).click();
    await admin.getByRole('dialog').getByRole('textbox').fill('后台核对：登记错了');
    await admin.getByRole('dialog').getByRole('button', { name: '撤销' }).click();
    await expect(admin.getByText('有效 2 条')).toBeVisible();
    await admin.getByRole('radio', { name: '菜单' }).click();
    await expect(admin.getByTestId('canteen-menus').getByText('❤️1')).toBeVisible();
    await admin.screenshot({ path: `${OUT}/admin.png`, fullPage: true });
  });
});

async function currentSlot(ctx: BrowserContext): Promise<{ meal: string; date: string }> {
  // 员工端口的「今天」只给负责人；厨师这边按开饭时间算：这一餐记在哪天（过了零点的算前一天）
  const me = await (await ctx.request.get(`${CANTEEN}/api/canteen/me`)).json();
  const lunch = me.meals.find((m: { meal: string }) => m.meal === 'lunch');
  const nowMin = Number(hhmm(Date.now()).slice(0, 2)) * 60 + Number(hhmm(Date.now()).slice(3));
  const startMin = Number(lunch.start.slice(0, 2)) * 60 + Number(lunch.start.slice(3));
  const crossed = lunch.end <= lunch.start && nowMin < startMin;
  const d = new Date(`${me.today}T00:00:00Z`);
  if (crossed) d.setUTCDate(d.getUTCDate() - 1);
  return { meal: 'lunch', date: d.toISOString().slice(0, 10) };
}

async function today(ctx: BrowserContext): Promise<string> {
  return (await (await ctx.request.get(`${CANTEEN}/api/canteen/me`)).json()).today;
}
