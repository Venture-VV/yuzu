// 员工食堂 · 柚子饭堂（docs/CANTEEN.md）的浏览器流程：后台（电脑尺寸）准备名单与开通卡片 →
// 厨师在手机上发布菜单 → 员工开通、点赞、亮饭卡码 → 负责人「从相册选」员工的码打卡、重复扫提示已打卡、
// 断网扫到先记下、联网后自动补登 → 后台看到人数与记录。
// 第二期（第 14–16 节）：新同事扫注册二维码 → 看柚子的开场动画 → 自己登记 → 走新手教程 → 跟柚子说 → 后台柚子信箱回信。
// 前面那几位（开通卡片来的）在手机上先记成「看过开场、走过教程」，只测原来的流程。
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

/** fresh：第一次打开柚子饭堂的手机（放开场动画、走新手教程）；不给时当作已经看过开场、走过教程 */
async function phone(browser: Browser, kind: keyof typeof PHONES, fresh = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...PHONES[kind], locale: 'zh-CN', timezoneId: tz });
  if (!fresh) {
    await ctx.addInitScript(() => {
      localStorage.setItem('yuzu.canteen.intro.v1', 'true');
      localStorage.setItem('yuzu.canteen.tour.v1', 'done');
    });
  }
  return ctx;
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

    // 结果待确认（Codex 审查 9d12ae8）：断网时改菜单，这一笔先存在手机上；刷新以后还在，只能原样重试，确认之前不能存别的
    cook.on('dialog', (d) => void d.accept());
    await ctx.setOffline(true);
    await cook.getByLabel('一句话备注').fill('今天有甜品，还有冰粉');
    await cook.getByRole('button', { name: '更新菜单' }).click();
    await expect(cook.getByTestId('menu-pending')).toBeVisible();
    await expect(cook.getByRole('button', { name: '更新菜单' })).toBeDisabled();
    // 断网时换一天：这一份取不到，不能把上一份的菜存过去
    await cook.getByRole('tab', { name: /明天/ }).click();
    await expect(cook.getByText(/没取到这份菜单/)).toBeVisible();
    await expect(cook.getByRole('button', { name: '发布给大家' })).toBeDisabled();
    await ctx.setOffline(false);
    await cook.reload();
    await expect(cook.getByTestId('menu-pending')).toBeVisible();
    // 原样重试被拒（没权限、饭堂暂时关着）也说明不了原来那次存没存上：这一笔照样留着（Codex 审查 c04f1d9）
    for (const [status, code, message] of [
      [403, 'FORBIDDEN', '只有厨师和食堂负责人能改菜单'],
      [503, 'CANTEEN_CLOSED', '饭堂还没开张'],
    ] as const) {
      await cook.route('**/api/canteen/menus/**', (route) =>
        route.request().method() === 'PUT' ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, message } }) }) : route.continue(),
      );
      await cook.getByTestId('menu-pending').getByRole('button', { name: '原样重试' }).click();
      await expect(cook.getByText(`${message}（上一次保存先留在手机上，之后点「原样重试」）`)).toBeVisible();
      await expect(cook.getByTestId('menu-pending')).toBeVisible();
      await cook.unroute('**/api/canteen/menus/**');
    }
    await cook.getByTestId('menu-pending').getByRole('button', { name: '原样重试' }).click();
    await expect(cook.getByText('发布啦')).toBeVisible();
    await expect(cook.getByTestId('menu-pending')).toHaveCount(0);
    const saved = await (await ctx.request.get(`${CANTEEN}/api/canteen/menus?from=${slot.date}&to=${slot.date}`)).json();
    expect(saved.find((m: { meal: string }) => m.meal === 'lunch').note).toBe('今天有甜品，还有冰粉');

    // 保存还没回来就换到别的日子：回复回来以后只放下这一笔，现在这一份照样能改（不会卡在「正在取菜单…」）（Codex 审查 c04f1d9）
    await cook.getByRole('tab', { name: new RegExp(slot.date === (await today(ctx)) ? '今天' : '昨天') }).click();
    await cook.getByRole('button', { name: /午餐/ }).click();
    await cook.route('**/api/canteen/menus/**', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await cook.getByLabel('一句话备注').fill('今天有甜品，还有冰粉和绿豆汤');
    await cook.getByRole('button', { name: '更新菜单' }).click();
    await cook.getByRole('tab', { name: /明天/ }).click();
    await expect(cook.getByRole('button', { name: /发布给大家|更新菜单/ })).toBeEnabled({ timeout: 10_000 });
    await expect(cook.getByText('正在取菜单…')).toHaveCount(0);
    await expect(cook.getByTestId('menu-pending')).toHaveCount(0);
    await cook.unroute('**/api/canteen/menus/**');
    const later = await (await ctx.request.get(`${CANTEEN}/api/canteen/menus?from=${slot.date}&to=${slot.date}`)).json();
    expect(later.find((m: { meal: string }) => m.meal === 'lunch').note).toBe('今天有甜品，还有冰粉和绿豆汤');

    // 刷新以后原样重试才发现菜单刚被别人改过：「用我的覆盖」存的是这次要存的内容、照原来要的发布（不是刷新后取到的那一份）
    const lunch = async () => (await (await ctx.request.get(`${CANTEEN}/api/canteen/menus?from=${slot.date}&to=${slot.date}`)).json()).find((m: { meal: string }) => m.meal === 'lunch');
    const openSlot = async () => {
      await cook.getByRole('tab', { name: new RegExp(slot.date === (await today(ctx)) ? '今天' : '昨天') }).click();
      await cook.getByRole('button', { name: /午餐/ }).click();
    };
    await openSlot();
    await ctx.setOffline(true);
    await cook.getByLabel('一句话备注').fill('冰粉卖完了，换成双皮奶');
    await cook.getByRole('button', { name: '更新菜单' }).click();
    await expect(cook.getByTestId('menu-pending')).toBeVisible();
    await ctx.setOffline(false);
    const before = await lunch();
    const other = await ctx.request.put(`${CANTEEN}/api/canteen/menus/${slot.date}/lunch`, {
      data: { clientKey: crypto.randomUUID(), version: before.version, dishes: before.dishes, note: '别人改的一句话', published: true },
    });
    expect(other.status()).toBe(200);
    await cook.reload();
    await openSlot();
    await expect(cook.getByLabel('一句话备注')).toHaveValue('别人改的一句话');
    await cook.getByTestId('menu-pending').getByRole('button', { name: '原样重试' }).click();
    const sheet = cook.getByRole('dialog', { name: '菜单刚被别人改过' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: '用我的覆盖（发布）' }).click();
    await expect.poll(async () => (await lunch()).note).toBe('冰粉卖完了，换成双皮奶');
    expect((await lunch()).published).toBe(true);
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

test.describe.serial('第二期：开场动画、新同事登记、新手教程、跟柚子说', () => {
  test('新同事扫注册二维码：开场动画 → 自己登记 → 新手教程 → 跟柚子说；后台回信，员工看得到', async ({ browser }) => {
    // 后台：打开自己登记、拿到注册链接（前面已经开了模块、填了员工入口地址）
    const actx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: tz });
    const admin = await actx.newPage();
    await admin.goto('/login');
    await admin.fill('#username', 'linlan');
    await admin.fill('#password', 'yuzu2026');
    await admin.getByRole('button', { name: '登录' }).click();
    await admin.waitForURL((u) => !u.pathname.startsWith('/login'));
    await admin.goto('/erp/canteen');
    await admin.getByRole('radio', { name: '设置' }).click();
    // 等设置取到了再看要不要打开（isVisible 不会等）；不要注册口令（店主 2026-11-07），链接就是员工入口地址 + #reg
    await expect(admin.getByTestId('canteen-registration')).toBeVisible();
    const open = admin.getByTestId('canteen-reg-open');
    if (await open.isVisible()) await open.click();
    const link = (await admin.getByTestId('canteen-reg-link').innerText()).trim();
    expect(link).toBe(`${CANTEEN}/#reg`);
    await admin.screenshot({ path: `${OUT}/admin-registration.png`, fullPage: true });

    // 新同事的手机：第一次打开，先放开场动画（七段，点一下打完这句、再点下一句）
    const ctx = await phone(browser, 'iphone', true);
    const p = await ctx.newPage();
    await p.goto(link);
    const intro = p.getByTestId('intro');
    await expect(intro).toBeVisible();
    await expect(intro).toContainText('汤崎的小 AI 助理');
    for (let i = 0; i < 7; i++) {
      await expect(intro).toHaveAttribute('data-beat', String(i));
      await p.getByTestId('intro-stage').click();
      if (i === 4) await p.screenshot({ path: `${OUT}/intro-scratch.png` });
      if (i < 6) await p.getByTestId('intro-stage').click();
    }
    await expect(intro).toContainText('我想从我开的这家柚子食堂开始。');
    await p.screenshot({ path: `${OUT}/intro-door.png` });
    await p.getByTestId('intro-enter').click();

    // 新同事登记：填三格就进门，不用口令
    await expect(p.getByTestId('register-page')).toBeVisible();
    await expect(p.getByLabel('注册口令')).toHaveCount(0);
    await noOverflow(p);
    await p.getByLabel('用户名').fill('小雨');
    await p.getByLabel('手机号').fill('139 0000 1234');
    await p.getByLabel('密码', { exact: true }).fill('xiaoyu-2026');
    await p.screenshot({ path: `${OUT}/register.png`, fullPage: true });
    await p.getByTestId('register-submit').click();

    // 新手教程：指着的地方要自己点才往下走
    const tour = p.getByTestId('tour');
    await expect(tour).toHaveAttribute('data-step', 'home');
    await p.screenshot({ path: `${OUT}/tour-home.png` });
    await p.getByTestId('tour-next').click();
    await expect(tour).toHaveAttribute('data-step', 'like');
    await p.getByRole('button', { name: '点赞：番茄炒蛋（示例）' }).click();
    await expect(tour).toHaveAttribute('data-step', 'code');
    // 点别处不算：挡板接住了点击
    await p.mouse.click(20, 200);
    await expect(tour).toHaveAttribute('data-step', 'code');
    await p.getByTestId('tab-code').click();
    await expect(tour).toHaveAttribute('data-step', 'qr');
    await expect(p.getByTestId('meal-code').locator('svg[data-qr]')).toHaveAttribute('data-qr', /^YZC1:/);
    await p.getByTestId('tour-next').click();
    await expect(tour).toHaveAttribute('data-step', 'talk');
    await p.getByTestId('tour-next').click();
    await expect(tour).toHaveAttribute('data-step', 'me');
    await p.getByTestId('tour-next').click();
    await expect(tour).toHaveAttribute('data-step', 'done');
    await p.getByTestId('tour-finish').click();
    await expect(tour).toHaveCount(0);

    // 跟柚子说
    await p.getByTestId('talk-entry').click();
    await expect(p.getByTestId('talk-page')).toBeVisible();
    await p.getByLabel('想跟柚子说的话').fill('想在手机上就能看到排班表！');
    await p.getByTestId('talk-send').click();
    await expect(p.getByText('柚子收到啦')).toBeVisible();
    await expect(p.getByText('柚子还没看').first()).toBeVisible();
    // 结果待确认：发出去没收到回复，这一条留在手机上；确认之前不能发新的（会顶掉它的操作编号），原样再发以后才行
    await p.route('**/api/canteen/feedback', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
    await p.getByLabel('想跟柚子说的话').fill('今天的汤有点咸');
    await p.getByTestId('talk-send').click();
    await expect(p.getByTestId('talk-pending')).toContainText('今天的汤有点咸');
    await p.getByLabel('想跟柚子说的话').fill('再写一条');
    await expect(p.getByTestId('talk-send')).toBeDisabled();
    // 原样再发被拒（饭堂暂时关着）也不能断定之前那次没送到：这一条照样留着
    await p.unroute('**/api/canteen/feedback');
    await p.route('**/api/canteen/feedback', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CANTEEN_CLOSED', message: '饭堂还没开张' } }) })
        : route.continue(),
    );
    await p.getByTestId('talk-pending').getByRole('button', { name: '原样再发' }).click();
    await expect(p.getByText('饭堂还没开张（这一条先存在手机上，之后再发）')).toBeVisible();
    await expect(p.getByTestId('talk-pending')).toContainText('今天的汤有点咸');
    await p.unroute('**/api/canteen/feedback');
    await p.getByTestId('talk-pending').getByRole('button', { name: '原样再发' }).click();
    await expect(p.getByTestId('talk-pending')).toHaveCount(0);
    await expect(p.getByText('今天的汤有点咸')).toBeVisible();
    await expect(p.getByTestId('talk-send')).toBeEnabled();
    await noOverflow(p);
    await p.screenshot({ path: `${OUT}/talk.png`, fullPage: true });

    // 发出去的那次还没回来就离开再回来这一页（新的这一页按原编号重发、送到了），接着又发了一条没送到的；
    // 原来那次的回复这时才回来，也不能把新的这一条从手机上删掉（Codex 审查 da39570）
    let posts = 0;
    let firstDone: Promise<void> = Promise.resolve();
    await p.route('**/api/canteen/feedback', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      if (posts === 1) {
        firstDone = new Promise<void>((resolve) => setTimeout(() => void route.continue().then(resolve, resolve), 2500));
        return firstDone;
      }
      return posts === 2 ? route.continue() : route.abort();
    });
    await p.getByLabel('想跟柚子说的话').fill('第一句：中午的米饭有点硬');
    await p.getByTestId('talk-send').click();
    await p.getByTestId('tab-home').click();
    await p.getByTestId('tab-talk').click();
    await expect(p.getByTestId('talk-page')).toBeVisible();
    await expect(p.getByTestId('talk-pending')).toHaveCount(0);
    await p.getByLabel('想跟柚子说的话').fill('第二句：明天想吃饺子');
    await p.getByTestId('talk-send').click();
    await expect(p.getByTestId('talk-pending')).toContainText('第二句：明天想吃饺子');
    await firstDone;
    await p.waitForTimeout(800);
    await p.reload();
    await expect(p.getByTestId('talk-pending')).toContainText('第二句：明天想吃饺子');
    await p.unroute('**/api/canteen/feedback');
    await p.getByTestId('talk-pending').getByRole('button', { name: '原样再发' }).click();
    await expect(p.getByTestId('talk-pending')).toHaveCount(0);
    await expect(p.getByText('第二句：明天想吃饺子')).toBeVisible();

    // 后台：名单里有自己登记的小雨；柚子信箱里回信
    await admin.getByRole('radio', { name: '员工名单' }).click();
    await expect(admin.getByRole('row', { name: /小雨/ })).toContainText('自己登记');
    await admin.getByRole('radio', { name: /柚子信箱/ }).click();
    // 回信还在路上时关掉对话框、切到别的页签再回来：这一条照样不能再回信（不然又发一句不一样的，
    // 晚到的那次会把它改回去，Codex 审查 616e446）；那一次有了结果才放开
    const soup = admin.getByTestId('canteen-feedback').locator('li', { hasText: '今天的汤有点咸' }).first();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await admin.route('**/api/erp/canteen/feedback/*/reply', async (route) => {
      await held;
      await route.continue();
    });
    await soup.getByRole('button', { name: '回信' }).click();
    await admin.getByRole('textbox', { name: '回信' }).fill('收到，已经跟厨师说少放点盐');
    await admin.getByTestId('feedback-reply-save').click();
    await admin.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await admin.getByRole('radio', { name: '设置' }).click();
    await admin.getByRole('radio', { name: /柚子信箱/ }).click();
    await expect(soup.getByRole('button', { name: '回信' })).toBeDisabled();
    await expect(soup).toContainText('回信发送中');
    release();
    // 发出去了：回信算看过，这一条从「没看过的」里下去
    await expect(soup).toHaveCount(0);
    await admin.unroute('**/api/erp/canteen/feedback/*/reply');
    const item = admin.getByTestId('canteen-feedback').locator('li', { hasText: '想在手机上就能看到排班表' }).first();
    // 回信没收到结果（结果待确认，Codex 审查 3bc51e6）：记录留在这台电脑上，关掉对话框也还在；确认之前这一条不能再回信，
    // 按原内容重新提交（同一个编号）才发出去
    await admin.route('**/api/erp/canteen/feedback/*/reply', (route) => route.abort());
    await item.getByRole('button', { name: '回信' }).click();
    await admin.getByRole('textbox', { name: '回信' }).fill('收到！柚子记下了，排班表排进下一版～');
    await admin.getByTestId('feedback-reply-save').click();
    await expect(admin.getByText('回信：没收到结果')).toBeVisible();
    await expect(admin.getByTestId('erp-pending')).toContainText('回信给 小雨');
    await expect(item.getByRole('button', { name: '回信' })).toBeDisabled();
    await admin.unroute('**/api/erp/canteen/feedback/*/reply');
    await admin.getByTestId('erp-pending-resend').click();
    await expect(admin.getByText('柚子信箱回信已登记')).toBeVisible();
    await expect(admin.getByTestId('erp-pending')).toHaveCount(0);
    // 回信自动算看过：这一条从「没看过的」里下去了，在「回过信的」里
    await admin.getByRole('radio', { name: '回过信的' }).click();
    await expect(admin.getByTestId('canteen-feedback')).toContainText('排班表排进下一版');
    await admin.screenshot({ path: `${OUT}/admin-mailbox.png`, fullPage: true });

    // 员工看得到回信；「我的」里能再看一遍开场
    await p.reload();
    await expect(p.getByTestId('talk-reply').filter({ hasText: '排班表排进下一版' })).toBeVisible();
    await expect(p.getByTestId('talk-reply').filter({ hasText: '少放点盐' })).toBeVisible();
    await p.getByTestId('tab-me').click();
    await p.getByTestId('replay-intro').click();
    await expect(p.getByTestId('intro')).toBeVisible();
    await p.getByTestId('intro-skip').click();
    await expect(p.getByTestId('replay-intro')).toBeVisible();

    // 这台手机亮不了饭卡码（例如不是 HTTPS 打开的）：再走一遍教程，指不到饭卡码的那一步等一会儿照常显示说话框，
    // 能「下一步」、能跳过，不会整屏挡住（Codex 审查 3bc51e6）
    await p.evaluate(() => Object.defineProperty(window.crypto, 'subtle', { configurable: true, get: () => undefined }));
    await p.getByTestId('replay-tour').click();
    await expect(tour).toHaveAttribute('data-step', 'home');
    await p.getByTestId('tour-next').click();
    await p.getByRole('button', { name: '点赞：番茄炒蛋（示例）' }).click();
    await expect(tour).toHaveAttribute('data-step', 'code');
    await p.getByTestId('tab-code').click();
    await expect(tour).toHaveAttribute('data-step', 'qr');
    await expect(p.getByText('这一步要指的地方这会儿没出来')).toBeVisible();
    await expect(p.getByTestId('meal-code')).toHaveCount(0);
    await p.getByTestId('tour-next').click();
    await expect(tour).toHaveAttribute('data-step', 'talk');
    await p.getByTestId('tour-skip').click();
    await expect(tour).toHaveCount(0);

    // 换手机：用用户名或手机号登录（看过开场的手机直接到登录页）
    const other = await phone(browser, 'android');
    const q = await other.newPage();
    await q.goto(CANTEEN);
    await expect(q.getByTestId('login-page')).toBeVisible();
    await q.getByLabel('账号').fill('13900001234');
    await q.getByLabel('密码').fill('xiaoyu-2026');
    await q.getByRole('button', { name: '登录' }).click();
    await expect(q.getByTestId('tab-home')).toBeVisible();
    await other.close();
    await ctx.close();
    await actx.close();
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
