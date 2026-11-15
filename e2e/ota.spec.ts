// 8.0.21 浏览器验收：OTA 渠道订单（docs/INTEGRATIONS_V8021.md 第 4 节，CW-I）。可重复执行（渠道名、订单号带这一次的时间）。
// 依赖演示数据（仅独立演示库；房型是现造的），账号：店主 linlan，密码 yuzu2026。
//   · 后台「客房 → 渠道」新建渠道、对照一个渠道房型；
//   · 前台「预约 → 渠道订单」选渠道、选订单表（CSV）→ 认出 2 张、1 个房型没对照 → 导入 → 1 张建好预约、1 张没建成 → 对账表里有这个渠道；
//   · 导入的请求没收到结果（拦下来模拟断网）→ 刷新页面「结果待确认」还在 →「按原内容重新提交」→ 订单建好（Codex 审查 e64932b 后补）；
//   · 选好文件以后换渠道：按新渠道重新预览（重复与否、房型对照都按新渠道），导入进的是看过预览的那个渠道（Codex 审查 26fe580 后补）。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const stamp = String(Date.now()).slice(-6);

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

/** 现造一个房型、一个渠道（接口），房型对照「豪华大床」 */
async function makeChannel(page: Page, tag: string) {
  const made = await page.request.post('/api/admin/rooms/types', { data: { name: `渠道房${tag}`, kind: 'daily', price: 26800 } });
  expect(made.ok(), await made.text()).toBe(true);
  const type = ((await made.json()) as { types: { id: number; name: string }[] }).types.find((t) => t.name === `渠道房${tag}`);
  const ch = await page.request.post('/api/ota/channels', { data: { name: `渠道${tag}`, commissionBp: 1200, roomMap: { 豪华大床: type!.id } } });
  expect(ch.ok(), await ch.text()).toBe(true);
  const channel = ((await ch.json()) as { id: number; name: string }[]).find((c) => c.name === `渠道${tag}`);
  return { id: channel!.id, name: channel!.name };
}

test.describe('8.0.21 OTA 渠道订单', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑组执行');
  });

  test('后台建渠道与房型对照 → 前台导入订单表 → 建好客房预约、没对照的没建成 → 渠道对账', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    // 现造一个房型（可重复执行）
    const made = await page.request.post('/api/admin/rooms/types', { data: { name: `渠道房${stamp}`, kind: 'daily', price: 26800 } });
    expect(made.ok(), await made.text()).toBe(true);
    const type = ((await made.json()) as { types: { id: number; name: string }[] }).types.find((t) => t.name === `渠道房${stamp}`);
    const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string };
    const day = (n: number) => new Date(Date.parse(`${me.today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

    // 后台：新建渠道
    const name = `渠道${stamp}`;
    await page.goto('/admin/rooms/channels');
    await page.getByTestId('ota-channel-new').click();
    const form = page.getByTestId('ota-channel-form');
    await form.getByTestId('oc-name').fill(name);
    await form.getByTestId('oc-commission').fill('12');
    await form.getByLabel('渠道房型 1').fill('豪华大床');
    await form.getByLabel('本店房型 1').selectOption(String(type!.id));
    await form.getByTestId('oc-save').click();
    await expect(page.getByText('渠道已保存')).toBeVisible();
    await expect(page.getByTestId('ota-channels')).toContainText(name);

    // 前台：导入
    await page.goto('/bookings?view=ota');
    await page.getByTestId('ota-channel').selectOption({ label: name });
    const csv = [
      '订单号,入住人,联系电话,房型,入住日期,离店日期,间数,订单金额,支付方式,订单状态',
      `E${stamp}01,测试客人,,豪华大床,${day(3)},${day(4)},1,368.00,预付,已确认`,
      `E${stamp}02,测试客人二,,行政套房,${day(3)},${day(5)},1,888.00,现付,已确认`,
    ].join('\r\n');
    await page.getByTestId('ota-file').setInputFiles({ name: 'orders.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await expect(page.getByTestId('ota-preview')).toContainText('认出 2 张订单');
    await expect(page.getByTestId('ota-preview')).toContainText('行政套房');
    await page.getByTestId('ota-import').click();
    await expect(page.getByTestId('ota-result')).toContainText('新建 1');
    const list = page.getByTestId('ota-order-list');
    await expect(list.locator('li').filter({ hasText: `E${stamp}01` })).toContainText('已建预约');
    await expect(list.locator('li').filter({ hasText: `E${stamp}02` })).toContainText('没建成');
    // 对账（入住月份）
    await page.getByLabel('月份').fill(day(3).slice(0, 7));
    await expect(page.getByTestId('ota-recon')).toContainText(name);
  });

  test('导入没收到结果 → 刷新后「结果待确认」还在 → 按原内容重新提交 → 只建一次', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const tag = `${stamp}p`;
    const { id: channelId, name } = await makeChannel(page, tag);
    const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string };
    const day = (n: number) => new Date(Date.parse(`${me.today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

    await page.goto('/bookings?view=ota');
    await page.getByTestId('ota-channel').selectOption({ label: name });
    const csv = ['订单号,入住人,联系电话,房型,入住日期,离店日期,间数,订单金额,支付方式,订单状态', `P${stamp}01,待确认客人,,豪华大床,${day(6)},${day(7)},1,368.00,预付,已确认`].join('\r\n');
    await page.getByTestId('ota-file').setInputFiles({ name: `pending${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
    await expect(page.getByTestId('ota-preview')).toContainText('认出 1 张订单');
    // 导入的请求发出去就断（服务器没收到）：页面记进「结果待确认」
    await page.route('**/api/ota/import', (route) => route.abort('connectionreset'));
    await page.getByTestId('ota-import').click();
    await expect(page.getByText('导入没收到结果').first()).toBeVisible();
    await page.unroute('**/api/ota/import');
    // 刷新页面：还在（进页面先查回一次，服务器上没有这次导入，留着）
    await page.reload();
    const pending = page.getByTestId('erp-pending');
    await expect(pending).toContainText(`导入渠道订单 pending${tag}.csv`);
    await expect(pending).toContainText('渠道订单导入结果待确认');
    await pending.getByTestId('erp-pending-resend').click();
    await expect(page.getByText('渠道订单导入已登记').first()).toBeVisible();
    await expect(pending).toHaveCount(0);
    await page.getByTestId('ota-channel').selectOption({ label: name });
    await expect(page.getByTestId('ota-order-list').locator('li').filter({ hasText: `P${stamp}01` })).toContainText('已建预约');
    // 服务器上这个渠道只有这一张订单、一次导入建的一张预约
    const orders = (await (await page.request.get(`/api/ota/orders?channelId=${channelId}`)).json()) as { orderNo: string; status: string; bookings: unknown[] }[];
    expect(orders.map((o) => [o.orderNo, o.status, o.bookings.length])).toEqual([[`P${stamp}01`, 'booked', 1]]);
  });

  test('选好文件以后换渠道：按新渠道重新预览，导进去的是看过预览的那个渠道', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const a = await makeChannel(page, `${stamp}a`);
    // 渠道乙：没有「豪华大床」的对照
    const madeB = await page.request.post('/api/ota/channels', { data: { name: `渠道${stamp}b`, commissionBp: 800, roomMap: {} } });
    expect(madeB.ok(), await madeB.text()).toBe(true);
    const b = ((await madeB.json()) as { id: number; name: string }[]).find((c) => c.name === `渠道${stamp}b`)!;
    const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string };
    const day = (n: number) => new Date(Date.parse(`${me.today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const file = { name: `switch${stamp}.csv`, mimeType: 'text/csv', buffer: Buffer.from(['订单号,入住人,联系电话,房型,入住日期,离店日期,间数,订单金额,支付方式,订单状态', `S${stamp}01,换渠道客人,,豪华大床,${day(8)},${day(9)},1,368.00,预付,已确认`].join('\r\n'), 'utf8') };

    await page.goto('/bookings?view=ota');
    // 甲导一次
    await page.getByTestId('ota-channel').selectOption({ label: a.name });
    await page.getByTestId('ota-file').setInputFiles(file);
    await expect(page.getByTestId('ota-preview')).toContainText('认出 1 张订单');
    await page.getByTestId('ota-import').click();
    await expect(page.getByTestId('ota-result')).toContainText('新建 1');
    // 同一份文件再选一次：甲已经导过 → 导入按钮点不了
    await page.getByTestId('ota-file').setInputFiles(file);
    await expect(page.getByTestId('ota-preview')).toContainText('这份文件已经导过了');
    await expect(page.getByTestId('ota-import')).toBeDisabled();
    // 换成乙：按乙重新预览——乙没导过，但「豪华大床」在乙没对照
    await page.getByTestId('ota-channel').selectOption({ label: b.name });
    await expect(page.getByTestId('ota-preview')).toContainText('认出 1 张订单');
    await expect(page.getByTestId('ota-preview')).toContainText('还没对照本店房型');
    await expect(page.getByTestId('ota-import')).toBeEnabled();
    await page.getByTestId('ota-import').click();
    await expect(page.getByTestId('ota-result')).toContainText('没建成 1');
    // 导进去的是乙（按乙的对照记「没建成」），甲那一张照旧
    const ordersOf = async (channelId: number) => (await (await page.request.get(`/api/ota/orders?channelId=${channelId}`)).json()) as { orderNo: string; status: string }[];
    expect((await ordersOf(b.id)).map((o) => [o.orderNo, o.status])).toEqual([[`S${stamp}01`, 'failed']]);
    expect((await ordersOf(a.id)).map((o) => [o.orderNo, o.status])).toEqual([[`S${stamp}01`, 'booked']]);
  });
});
