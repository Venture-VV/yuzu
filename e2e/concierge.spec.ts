// Synthetic concierge enrollment only; uses the existing isolated CI demo environment.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { MemberInsights } from '../src/shared/concierge/insights-types';
import type { PraiseCenterData } from '../src/shared/concierge/praise-types';
import { navItem } from './nav';
async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({
    timeout: 30000,
  });
}
async function insights(page: Page, params = ''): Promise<MemberInsights> {
  const response = await page.request.get('/api/concierge/member-insights' + (params ? '?' + params : ''));
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
function calendarDate(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
const moduleNav = (page: Page) => page.getByRole('navigation', { name: '管家业务模块', exact: true });
test('管家部嵌入企业后台并可从手机布局打开', async ({ page }) => {
  await login(page);
  // 管家部在门店主导航里（与前台、预约、会员并列）；Codex 最初放的后台地址跳过来
  await page.goto('/admin/concierge');
  await expect(page).toHaveURL(/\/concierge$/);
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '管家' })).toHaveAttribute('aria-current', 'page');
  await expect(
    // The dashboard heading includes today's date after its title.
    page.getByRole('heading', { level: 1, name: /^今日工作台/ }),
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: '管家业务模块' })).toBeVisible();
  // 独立站留下的品牌字样不再出现；手机上底部的常用入口不盖住左边的主导航（头像那里是改密码、退出）
  await expect(page.getByText('TANGQI CONCIERGE')).toHaveCount(0);
  const bottom = page.getByRole('navigation', { name: '手机常用入口' });
  if (await bottom.isVisible()) {
    const rail = (await page.getByRole('navigation', { name: '主导航' }).boundingBox())!;
    const bar = (await bottom.boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
});
test('前台会员建立服务档案，原生资料实时同步，历史核对只读', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '变更流程只在门店电脑组执行');
  await login(page);
  const stamp = String(Date.now()).slice(-8),
    name = 'E2E服务-' + stamp;
  const made = await page.request.post('/api/members', { data: { name, phone: '199' + stamp } });
  expect(made.status(), await made.text()).toBe(201);
  const native = await made.json();
  await page.goto('/concierge');
  await page.getByRole('button', { name: '建立服务档案', exact: true }).first().click();
  let dialog = page.getByRole('dialog', { name: '建立管家服务档案' });
  await dialog.getByRole('textbox', { name: '选择系统会员 *', exact: true }).fill(name);
  await dialog.locator('.native-member-option').filter({ hasText: name }).click();
  await expect(dialog.locator('input[name="name"]')).toHaveValue(name);
  await expect(dialog.locator('input[name="phone"]')).toHaveValue('199' + stamp);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole('button', { name: new RegExp(name) })
    .first()
    .click();
  const member = page.locator('.member-drawer');
  await expect(member).toContainText(/会员档案 · \d{6}/);
  await expect(member.getByRole('button', { name: '新增人工核对记录', exact: true })).toHaveCount(0);
  await expect(member).toContainText('系统实时余额');
  // A synthetic historical record remains readable; the retired input is absent.
  const lookup = await page.request.get('/api/concierge/native-members?q=' + encodeURIComponent(name));
  const found = (await lookup.json()).members.find((m: any) => m.id === native.id);
  const historical = await page.request.post('/api/concierge/workspace', {
    data: {
      action: 'saveBalance',
      requestId: randomUUID(),
      payload: {
        memberId: found.profiles[0].id,
        amount: '29999.99',
        checkedAt: new Date().toISOString(),
        source: 'CI旧规则历史样例',
        note: '保留依据，不覆盖当前钱包',
        expectedBalanceId: null,
        uploadIds: [],
        receiptIds: [],
      },
    },
  });
  expect(historical.status(), await historical.text()).toBe(200);
  // An already-open drawer changes without page.reload() or pressing Sync.
  const edit = await page.request.put(`/api/members/${native.id}`, { data: { name: name + '新名', phone: '199' + stamp } });
  expect(edit.status(), await edit.text()).toBe(200);
  await expect(member.getByRole('heading', { name: name + '新名', exact: true })).toBeVisible({ timeout: 15000 });
  await member.getByRole('button', { name: '历史核对', exact: true }).click();
  await expect(member).toContainText('29,999.99');
});

// ── 8.0.15（docs/ORDERS_V8015.md 第 1 节）──
// 门店内网用 http://IP 打开时没有 crypto.randomUUID（只在 HTTPS / localhost 下有）；8.0.12 的管家部直接用了它，点「新增会员」没反应。
// 这里把这个接口拿掉来模拟内网 HTTP：点按钮 1 秒内出录入窗，提交后名单与「在册会员」数马上更新，代录预约同样打得开。
// 8.1.21 起管家端没有「拍消费单」（消费由前台收银同步），工作台与档案里都看不到这个入口。
test('内网 HTTP（没有 crypto.randomUUID）：新增会员 1 秒内弹窗、提交后名单与在册数更新；代录预约打得开；没有拍消费单；没有相关报错', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '变更流程只在门店电脑组执行');
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /randomUUID|is not a function/i.test(m.text())) problems.push(m.text());
  });
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true, writable: true });
  });
  await login(page);
  await page.goto('/concierge');
  await expect(page.getByRole('heading', { level: 1, name: /^今日工作台/ })).toBeVisible();
  expect(await page.evaluate(() => typeof (crypto as { randomUUID?: unknown }).randomUUID)).toBe('undefined');
  const enrolledCard = page.locator('.stat-card', { hasText: '服务会员' });
  const enrolled = async () => Number(/(\d+)/.exec(await enrolledCard.locator('.stat-value').innerText())?.[1] ?? NaN);
  const before = await enrolled();
  expect(Number.isInteger(before)).toBe(true);

  // 前台先办理身份，再由管家建服务档案；内网没有randomUUID时仍能打开并保存。
  const name = 'E2E内网会员-' + randomUUID().slice(0, 8);
  const phone = '139' + String(Date.now()).slice(-8);
  const made = await page.request.post('/api/members', { data: { name, phone } });
  expect(made.status(), await made.text()).toBe(201);
  await page.getByRole('button', { name: '建立服务档案', exact: true }).first().click();
  let dialog = page.getByRole('dialog', { name: '建立管家服务档案' });
  await expect(dialog).toBeVisible({ timeout: 1000 });
  await dialog.getByRole('textbox', { name: '选择系统会员 *', exact: true }).fill(name);
  await dialog.locator('.native-member-option').filter({ hasText: name }).click();
  await expect(dialog.locator('input[name="name"]')).toHaveValue(name);
  await expect(dialog.locator('input[name="phone"]')).toHaveValue(phone);
  await dialog.getByRole('textbox', { name: /备注/ }).fill('喜欢靠窗的位置');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  // 「在册会员」数加一；名单里马上有，点开档案里带着备注
  await expect.poll(enrolled).toBe(before + 1);
  await enrolledCard.click();
  await page
    .getByRole('button', { name: new RegExp(name) })
    .first()
    .click();
  const member = page.getByRole('complementary', { name: name + '的会员档案' });
  await expect(member).toContainText(/会员档案 · \d{6}/);
  await member.getByText('基本档案', { exact: true }).click();
  await expect(member).toContainText('喜欢靠窗的位置');
  // 从档案里代录预约：直接关联到这位会员；档案里没有「拍消费单」（8.1.21）
  await expect(member.getByRole('button', { name: /拍消费单/ })).toHaveCount(0);
  await member.getByRole('button', { name: '录预约', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '登记新预约' });
  await expect(dialog).toBeVisible({ timeout: 1000 });
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).not.toBeVisible();

  await page.locator('.drawer-scrim').click({ position: { x: 10, y: 10 } });
  await expect(member).not.toBeVisible();

  // 工作台上的入口：建立服务档案、代录预约、处理待办；没有「拍消费单」（8.1.21）
  await page
    .getByRole('navigation', { name: '管家业务模块' })
    .getByRole('button', { name: /工作台/ })
    .first()
    .click();
  await page
    .locator('.quick-actions')
    .getByRole('button', { name: /代录预约/ })
    .click();
  dialog = page.getByRole('dialog', { name: '登记新预约' });
  await expect(dialog).toBeVisible({ timeout: 1000 });
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(page.locator('.quick-actions').getByRole('button')).toHaveText([/建立服务档案/, /代录预约/, /处理待办/]);
  await expect(page.getByRole('button', { name: /拍消费单|拍摄消费单/ })).toHaveCount(0);
  expect(problems).toEqual([]);
});

// ── 主线整改（docs/HANDOFF_V8012.md）──
test('只有管家职责的后勤账号：登录直接进管家部；手机上的工作台、会员档案、消费凭证历史都没有「拍消费单」（8.1.21）', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行（手机那一段另开手机尺寸的窗口）');
  test.setTimeout(240_000);
  await login(page);
  // 店主建一个后勤 + 管家职责的账号（用户名带这次的时间，跑完停用）
  const stamp = String(Date.now()).slice(-8);
  const made = await page.request.post('/api/staff', { data: { username: `e2egj${stamp}`, displayName: 'E2E 管家', role: 'backoffice', duties: ['concierge'], password: 'E2e-guanjia-2026' } });
  expect(made.status(), await made.text()).toBe(201);
  const staff = (await made.json()) as { id: number; temporaryPassword: string };
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    baseURL: testInfo.project.use.baseURL,
  });
  try {
    const p = await phone.newPage();
    await p.goto('/login');
    await p.fill('#username', `e2egj${stamp}`);
    await p.fill('#password', staff.temporaryPassword);
    await p.getByRole('button', { name: '登录', exact: true }).click();
    // 首次登录先换密码
    await expect(p.getByText('设置你的密码')).toBeVisible();
    const pw = p.locator('input[type=password]');
    await pw.nth(0).fill(staff.temporaryPassword);
    await pw.nth(1).fill('E2e-guanjia-2027');
    await pw.nth(2).fill('E2e-guanjia-2027');
    await p.getByRole('button', { name: '保存新密码' }).click();
    // 直接进管家部（不是会员工作台，也不是餐饮、客房）
    await expect(p).toHaveURL(/\/concierge$/, { timeout: 20_000 });
    await expect(p.getByRole('heading', { level: 1, name: /^今日工作台/ })).toBeVisible();
    // 管家在门店主导航里只看得到自己能用的页面：有「管家」，没有「后台」「会员」「流水」
    const nav = p.getByRole('navigation', { name: '主导航' });
    await expect(nav.getByRole('link', { name: '管家' })).toBeVisible();
    // 不只是折着看不见：这些入口根本不在主导航里
    for (const hidden of ['后台', '会员', '流水', '发卡台', '收银台']) await expect(navItem(p, hidden)).toHaveCount(0);
    // 后台进不去：回到管家部
    await p.goto('/admin');
    await expect(p).toHaveURL(/\/concierge$/);
    // 建一位管家会员（接口），再看工作台、档案、消费凭证历史：都没有「拍消费单」
    const native = await page.request.post('/api/members', { data: { name: `E2E无拍单-${stamp}`, phone: '198' + stamp } });
    expect(native.status(), await native.text()).toBe(201);
    const nativeId = (await native.json()).id;
    const member = await p.request.post('/api/concierge/workspace', {
      data: {
        action: 'createMember',
        requestId: randomUUID(),
        payload: { nativeMemberId: nativeId, name: `E2E无拍单-${stamp}`, phone: '', cardNo: `E2E-NOCAP-${stamp}`, ownerId: '', cardTier: '', preferences: '', source: '', joinedAt: '' },
      },
    });
    expect(member.status(), await member.text()).toBe(200);
    await p.reload();
    await expect(p.getByRole('heading', { level: 1, name: /^今日工作台/ })).toBeVisible();
    await expect(p.locator('.quick-actions').getByRole('button')).toHaveCount(3);
    await expect(p.getByRole('button', { name: /拍消费单|拍摄消费单/ })).toHaveCount(0);
    await p.goto('/concierge/receipts');
    await expect(p.getByRole('heading', { level: 1, name: /消费凭证历史/ })).toBeVisible();
    await expect(p.getByRole('button', { name: /拍消费单|拍摄消费单/ })).toHaveCount(0);
  } finally {
    await phone.close();
    await page.request.put(`/api/staff/${staff.id}`, { data: { displayName: 'E2E 管家', role: 'backoffice', duties: ['concierge'], active: false } });
  }
});

// ── 8.0.19（W11）──
// 8.0.18 合并前 Codex 的 P1：没有「查找与查看会员」权限的管家，名单里还没建档的会员手机号是打码的；
// 页面把打码的号原样交回来，建档被手机号格式拦住。那次只补了接口的用例，这里在页面上走一遍。
test('没有会员查看权限的管家：还没建档的会员手机号打码，照样能在页面上建立服务档案，建好以后看得到完整的号', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  test.setTimeout(120_000);
  await login(page);
  const stamp = String(Date.now()).slice(-8),
    name = 'E2E打码-' + stamp,
    phone = '197' + stamp;
  const native = await page.request.post('/api/members', { data: { name, phone } });
  expect(native.status(), await native.text()).toBe(201);
  const nativeId = (await native.json()).id as number;
  const made = await page.request.post('/api/staff', { data: { username: `e2emask${stamp}`, displayName: 'E2E 打码管家', role: 'backoffice', duties: ['concierge'], password: 'E2e-mask-2026' } });
  expect(made.status(), await made.text()).toBe(201);
  const staff = (await made.json()) as { id: number; temporaryPassword: string };
  const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', baseURL: testInfo.project.use.baseURL });
  try {
    const p = await ctx.newPage();
    await p.goto('/login');
    await p.fill('#username', `e2emask${stamp}`);
    await p.fill('#password', staff.temporaryPassword);
    await p.getByRole('button', { name: '登录', exact: true }).click();
    await expect(p.getByText('设置你的密码')).toBeVisible();
    const pw = p.locator('input[type=password]');
    await pw.nth(0).fill(staff.temporaryPassword);
    await pw.nth(1).fill('E2e-mask-2027');
    await pw.nth(2).fill('E2e-mask-2027');
    await p.getByRole('button', { name: '保存新密码' }).click();
    await expect(p).toHaveURL(/\/concierge$/, { timeout: 20_000 });
    // 这位管家确实没有会员查看权限：会员工作台的查找接口不让用
    expect((await p.request.get('/api/members?q=' + phone)).status()).toBe(403);
    // 管家部的查找照样能按完整手机号找到人，但给回来的号是打码的
    const lookup = await p.request.get('/api/concierge/native-members?q=' + phone);
    expect(lookup.status(), await lookup.text()).toBe(200);
    const masked = ((await lookup.json()) as { members: { id: number; phone: string }[] }).members.find((m) => m.id === nativeId)!.phone;
    expect(masked).not.toBe(phone);
    expect(masked).toContain('*');
    // 页面上建档
    await p.getByRole('button', { name: '建立服务档案', exact: true }).first().click();
    const dialog = p.getByRole('dialog', { name: '建立管家服务档案' });
    await dialog.getByRole('textbox', { name: '选择系统会员 *', exact: true }).fill(phone);
    const option = dialog.locator('.native-member-option').filter({ hasText: name });
    await expect(option).not.toContainText(phone);
    await option.click();
    await expect(dialog.locator('input[name="name"]')).toHaveValue(name);
    await expect(dialog.locator('input[name="phone"]')).toHaveValue(masked);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });
    // 建好了：名单里有这位，打开看得到完整的号（建了服务档案的照旧显示完整的）
    await p
      .getByRole('button', { name: new RegExp(name) })
      .first()
      .click();
    const drawer = p.locator('.member-drawer');
    await expect(drawer).toContainText(/会员档案 · \d{6}/);
    const after = await p.request.get('/api/concierge/native-members?q=' + phone);
    const row = ((await after.json()) as { members: { id: number; phone: string; profiles: { id: number }[] }[] }).members.find((m) => m.id === nativeId)!;
    expect(row.profiles).toHaveLength(1);
    expect(row.phone).toBe(phone);
    // 前台的会员没被改：手机号还是原来那个
    const kept = (await (await page.request.get(`/api/members/${nativeId}`)).json()) as { phone: string; name: string };
    expect(kept.phone).toBe(phone);
    expect(kept.name).toBe(name);
  } finally {
    await ctx.close();
    await page.request.put(`/api/staff/${staff.id}`, { data: { displayName: 'E2E 打码管家', role: 'backoffice', duties: ['concierge'], active: false } });
  }
});

test('两位低余额会员均无人工核对记录时重点跟进不崩溃', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '写入仅在电脑组');
  await login(page);
  const stamp = String(Date.now()).slice(-7);
  for (const [suffix, index] of [
    ['甲', 1],
    ['乙', 2],
  ] as const) {
    const native = await page.request.post('/api/members', { data: { name: `低余额验收${suffix}${stamp}`, phone: `197${index}${stamp}` } });
    expect(native.status(), await native.text()).toBe(201);
    const saved = await page.request.post('/api/concierge/workspace', { data: { action: 'createMember', requestId: randomUUID(), payload: { nativeMemberId: (await native.json()).id } } });
    expect(saved.status(), await saved.text()).toBe(200);
  }
  await page.goto('/concierge');
  await page.getByRole('button', { name: /低余额关注 \d+位/ }).click();
  await expect(page.getByRole('heading', { name: '低余额关注名单', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(`低余额验收甲${stamp}`) })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(`低余额验收乙${stamp}`) })).toBeVisible();
});

test('会员情况仅保留四个未到访分类，无到访会员仍可从全名单查看且不自动建档', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '写入仅在电脑组');
  await login(page);
  const stamp = String(Date.now()).slice(-8),
    name = 'E2E从未到访-' + stamp;
  const made = await page.request.post('/api/members', { data: { name, phone: '196' + stamp } });
  expect(made.status(), await made.text()).toBe(201);
  const native = await made.json();
  await page.goto('/concierge');
  await page.getByRole('button', { name: '会员情况', exact: true }).click();
  await expect(page.getByRole('heading', { name: '会员情况', exact: true })).toBeVisible();
  await expect(page.locator('.dormancy-card')).toHaveCount(4);
  await expect(page.getByRole('combobox', { name: '未到访时间筛选', exact: true }).locator('option[value="never"]')).toHaveCount(0);
  await moduleNav(page).getByRole('button', { name: '会员档案', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索系统会员', exact: true }).fill(name);
  await page.locator('.insights-list .member-cell').filter({ hasText: name }).click();
  const detail = page.getByRole('dialog', { name: '系统会员个人档案', exact: true });
  await expect(detail).toContainText(name);
  await expect(detail).toContainText('暂无到访记录');
  await expect(detail.getByRole('button', { name: '建立服务档案', exact: true })).toBeVisible();
  const lookup = await page.request.get('/api/concierge/native-members?q=' + encodeURIComponent(name));
  expect((await lookup.json()).members.find((m: any) => m.id === native.id).profiles).toEqual([]);
  await detail.getByRole('button', { name: '关闭系统会员详情', exact: true }).click();
  await moduleNav(page).getByRole('button', { name: '会员中心', exact: true }).click();
  await expect(page.locator('.member-grade-card')).toHaveCount(7);
  await expect(page.getByRole('combobox', { name: '会员档阶筛选', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '管家好评中心', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管家好评中心', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '拍摄消费单', exact: true })).toHaveCount(0);
  await expect(page.getByText('上月好评榜', { exact: false }).first()).toBeVisible();
});

test('会员概览总人数、近期到访和沉睡人数均可下钻到实际名单', async ({ page }) => {
  await login(page);
  const recentData = await insights(page, 'bucket=recent');
  // CI动态种子的前台入场记录是真实来源，充值或预约不冒充到访。
  const recent = recentData.members.find((member) => member.profiles.length === 0);
  expect(recent, '隔离CI动态演示库须有近期实际到访且未建管家档案的会员').toBeTruthy();
  await page.goto('/concierge');
  await moduleNav(page).getByRole('button', { name: '会员档案', exact: true }).click();
  for (const label of ['查看全部会员档阶', '查看近1个月到店会员', '查看新增会员趋势', '查看沉睡会员名单']) await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();

  await page.getByRole('button', { name: '查看全部会员档阶', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '会员中心', exact: true })).toBeVisible();
  await expect(page.locator('.member-grade-card')).toHaveCount(7);
  await moduleNav(page).getByRole('button', { name: '会员档案', exact: true }).click();

  await page.getByRole('button', { name: '查看近1个月到店会员', exact: true }).click();
  const recentDialog = page.getByRole('dialog', { name: '近1个月到店会员', exact: true });
  await expect(recentDialog).toBeVisible();
  await recentDialog.getByRole('button').filter({ hasText: recent!.memberNo }).first().click();
  const detail = page.getByRole('dialog', { name: '系统会员个人档案', exact: true });
  await expect(detail).toContainText(recent!.name);
  await expect(detail).toContainText(recent!.memberNo);
  await detail.getByRole('button', { name: '关闭系统会员详情', exact: true }).click();
  if (await recentDialog.isVisible()) await recentDialog.getByRole('button', { name: '关闭', exact: true }).click();

  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/concierge/member-insights' && url.searchParams.get('bucket') === 'dormant';
  });
  await page.getByRole('button', { name: '查看沉睡会员名单', exact: true }).click();
  expect((await filtered).status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: '会员情况', exact: true })).toBeVisible();
  const buckets = page.getByRole('combobox', { name: '未到访时间筛选', exact: true });
  await expect(buckets).toHaveValue('dormant');
  await expect(buckets.locator('option[value="never"]')).toHaveCount(0);
});

test('新增会员趋势按年展示12个月，并按原生创建月份下钻到新会员详情', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '原生会员写入仅在电脑组');
  const stamp = String(Date.now()).slice(-8),
    name = 'E2E趋势原生会员-' + stamp;
  await login(page);
  const made = await page.request.post('/api/members', { data: { name, phone: '195' + stamp } });
  expect(made.status(), await made.text()).toBe(201);
  const native = await made.json();
  const snapshot = await insights(page, 'q=' + encodeURIComponent(name));
  const created = snapshot.members.find((member) => member.id === native.id)!;
  expect(created).toBeTruthy();
  expect(created.profiles).toEqual([]);
  const createdMonth = calendarDate(created.createdAt, snapshot.timezone).slice(0, 7);
  const createdYear = Number(createdMonth.slice(0, 4)),
    monthNumber = Number(createdMonth.slice(5));
  const currentYear = Number(calendarDate(snapshot.serverTime, snapshot.timezone).slice(0, 4));
  const monthly = await insights(page, `q=${encodeURIComponent(name)}&createdMonth=${createdMonth}&trendYear=${createdYear}`);
  expect(monthly.members.map((member) => member.id)).toContain(native.id);
  expect(monthly.growth.months.find((month) => month.month === createdMonth)!.count).toBeGreaterThan(0);

  await page.goto('/concierge');
  await moduleNav(page).getByRole('button', { name: '会员档案', exact: true }).click();
  await page.getByRole('button', { name: '查看新增会员趋势', exact: true }).click();
  const trend = page.getByRole('dialog', { name: '新增会员趋势', exact: true });
  await expect(trend).toBeVisible();
  const monthsIn = (year: number) => trend.getByRole('button', { name: new RegExp(`^${year}年\\d+月，新增\\d+人$`) });
  await expect(monthsIn(currentYear)).toHaveCount(12);
  await trend.getByRole('button', { name: '上一年', exact: true }).click();
  await expect(monthsIn(currentYear - 1)).toHaveCount(12);
  await trend.getByRole('button', { name: '下一年', exact: true }).click();
  await expect(monthsIn(currentYear)).toHaveCount(12);
  let shownYear = currentYear;
  const chooseMonth = async (year: number, month: number) => {
    while (shownYear > year) {
      await trend.getByRole('button', { name: '上一年', exact: true }).click();
      shownYear--;
    }
    while (shownYear < year) {
      await trend.getByRole('button', { name: '下一年', exact: true }).click();
      shownYear++;
    }
    await trend.getByRole('button', { name: new RegExp(`^${year}年${month}月，新增\\d+人$`) }).click();
  };
  const memberList = trend.locator('[aria-label="新增会员名单"]');
  // 不造历史数据；同一个新会员在上个月名单必须不存在，切回其原生创建月才出现。
  const otherYear = monthNumber === 1 ? createdYear - 1 : createdYear,
    otherMonth = monthNumber === 1 ? 12 : monthNumber - 1;
  await chooseMonth(otherYear, otherMonth);
  await expect(memberList.getByRole('heading', { name: `${otherYear}年${otherMonth}月新增会员`, exact: true })).toBeVisible();
  await expect(memberList).not.toContainText(name);
  await chooseMonth(createdYear, monthNumber);
  await expect(memberList).toContainText(name);
  await memberList.getByRole('button').filter({ hasText: name }).first().click();
  const detail = page.getByRole('dialog', { name: '系统会员个人档案', exact: true });
  await expect(detail).toContainText(name);
  await expect(detail).toContainText(created.memberNo);
  const lookup = await page.request.get('/api/concierge/native-members?q=' + encodeURIComponent(name));
  expect((await lookup.json()).members.find((member: any) => member.id === native.id).profiles).toEqual([]);
});

test('本月好评数字打开当月有效名单，记录可进入原图并返回原名单', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '门店电脑', '合成好评与员工写入仅在电脑组');
  await login(page);
  const stamp = String(Date.now()).slice(-8),
    staffName = 'E2E下钻管家-' + stamp;
  const made = await page.request.post('/api/staff', { data: { username: 'e2epraise' + stamp, displayName: staffName, role: 'backoffice', duties: ['concierge'], password: 'E2e-praise-2026' } });
  expect(made.status(), await made.text()).toBe(201);
  const staff = await made.json(),
    recorded: string[] = [];
  const mutate = (action: string, payload: Record<string, unknown>) => page.request.post('/api/concierge/workspace', { data: { action, payload, requestId: randomUUID() } });
  try {
    const centerResponse = await page.request.get('/api/concierge/praise/center');
    expect(centerResponse.status(), await centerResponse.text()).toBe(200);
    const center: PraiseCenterData = await centerResponse.json();
    // 合成色块图片，仅验证私有原图链路；记录标明CI样例，不作为真实客人好评。
    const photo = await page.request.post('/api/concierge/uploads', {
      data: { files: [{ mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGO8sS2YgRTARJJqhlENxAEmItXBwagGYgDJoQQA8i4CAS68pTIAAAAASUVORK5CYII=' }] },
    });
    expect(photo.status(), await photo.text()).toBe(201);
    const uploadId = (await photo.json()).uploads[0].id;
    const payload = (content: string, occurredOn = center.today) => ({
      staffId: String(staff.id),
      occurredOn,
      source: '隔离CI合成凭证',
      guestName: '合成客人' + stamp,
      content,
      uploadIds: [uploadId],
    });
    const activeContent = '本月有效好评-' + stamp,
      voidContent = '本月已撤销好评-' + stamp,
      previousContent = '上月好评不进本月-' + stamp;
    for (const content of [activeContent, voidContent]) {
      const result = await mutate('savePraise', payload(content));
      expect(result.status(), await result.text()).toBe(200);
      recorded.push((await result.json()).id);
    }
    const voided = await mutate('voidPraise', { id: recorded[1], version: 1, reason: '隔离CI撤销样例' });
    expect(voided.status(), await voided.text()).toBe(200);
    const lastMonth = new Date(`${center.month}-01T00:00:00Z`);
    lastMonth.setUTCDate(0);
    const old = await mutate('savePraise', payload(previousContent, lastMonth.toISOString().slice(0, 10)));
    expect(old.status(), await old.text()).toBe(200);
    recorded.push((await old.json()).id);

    await page.goto('/concierge');
    await moduleNav(page).getByRole('button', { name: '管家好评中心', exact: true }).click();
    const monthButton = page.getByRole('button', { name: '查看本月好评明细', exact: true });
    await expect(monthButton).toBeEnabled();
    await monthButton.click();
    const monthDialog = page.getByRole('dialog', { name: '本月好评明细', exact: true });
    await expect(monthDialog).toBeVisible();
    await expect(monthDialog.locator('[aria-label="本月有效好评统计"]')).toContainText(`${Number(center.month.slice(0, 4))}年${Number(center.month.slice(5))}月`);
    await expect(monthDialog).toContainText(activeContent);
    await expect(monthDialog).not.toContainText(voidContent);
    await expect(monthDialog).not.toContainText(previousContent);
    await monthDialog.getByRole('button').filter({ hasText: activeContent }).click();
    const detail = page.getByRole('dialog', { name: '好评详情与原始凭证', exact: true });
    await expect(detail).toContainText(activeContent);
    const image = detail.getByRole('img', { name: '客人原始好评凭证第1页', exact: true });
    await expect(image).toHaveAttribute('src', `/api/concierge/uploads/${uploadId}`);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    const popup = page.waitForEvent('popup');
    await detail.getByRole('link', { name: '打开原图', exact: true }).click();
    const original = await popup;
    try {
      await expect(original).toHaveURL(new RegExp(`/api/concierge/uploads/${uploadId}$`));
      await expect(original.getByRole('img')).toBeVisible();
    } finally {
      await original.close();
    }
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(monthDialog).toBeVisible();
    await expect(monthDialog).toContainText(activeContent);
  } finally {
    // 留可追溯撤销记录，避免后续用例将合成好评当作有效荣誉；不物理删除。
    for (const id of recorded) {
      const response = await page.request.get(`/api/concierge/praise/${id}`);
      expect(response.status(), await response.text()).toBe(200);
      const record = await response.json();
      if (record.status === 'active') {
        const result = await mutate('voidPraise', { id, version: record.version, reason: '隔离CI下钻用例完成' });
        expect(result.status(), await result.text()).toBe(200);
      }
    }
    const stopped = await page.request.put(`/api/staff/${staff.id}`, { data: { displayName: staffName, role: 'backoffice', duties: ['concierge'], active: false } });
    expect(stopped.status(), await stopped.text()).toBe(200);
  }
});

// 8.0.18 整合：哪一页写进地址（与后台的二级页签同一个规矩）
test('管家部的页写进地址：刷新留在原页、浏览器后退回上一页、直接打开某一页的地址', async ({ page }) => {
  await login(page);
  await page.goto('/concierge');
  await expect(page.getByRole('heading', { name: /今日工作台/ })).toBeVisible();
  await moduleNav(page).getByRole('button', { name: '会员中心', exact: true }).click();
  await expect(page).toHaveURL(/\/concierge\/tiers$/);
  await expect(page.getByRole('heading', { name: '会员中心', exact: true })).toBeVisible();
  await moduleNav(page).getByRole('button', { name: '管家好评中心', exact: true }).click();
  await expect(page).toHaveURL(/\/concierge\/praise$/);
  // 刷新不回工作台
  await page.reload();
  await expect(page.getByRole('heading', { name: '管家好评中心', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/concierge\/praise$/);
  // 后退回到会员中心
  await page.goBack();
  await expect(page).toHaveURL(/\/concierge\/tiers$/);
  await expect(page.getByRole('heading', { name: '会员中心', exact: true })).toBeVisible();
  // 直接打开地址；认不得的页回工作台
  await page.goto('/concierge/situation');
  await expect(page.getByRole('heading', { name: '会员情况', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.goto('/concierge/no-such-page');
  await expect(page.getByRole('heading', { name: /今日工作台/ })).toBeVisible({ timeout: 20_000 });
  // 门店主导航里「管家部」在各页都亮着
  await page.goto('/concierge/members');
  await expect(page.getByRole('heading', { name: '会员档案', exact: true })).toBeVisible({ timeout: 20_000 });
});
