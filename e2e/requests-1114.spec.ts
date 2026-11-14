// 店主 2026-11-14 的七条需求里登记消费（1、4）与预约（2、3、6）这几条的浏览器验收（点单页的 5 在 dining.spec，平板点餐的 7 在 emenu.spec）。
// 都只看页面，不收款、不扣款；预约那一条建一张明天的预约、用完取消。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
import { expect, test, type Page } from '@playwright/test';
import type { BookingBoard } from '../src/shared/bookings';

const PASSWORD = 'yuzu2026';
const ITEM = 'E2E 技师足疗';
const TECH = { techNo: 'E8', name: 'E2E 小林', gender: 'female', grade: 'professional' } as const;

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function send(page: Page, method: 'post' | 'put', url: string, data?: unknown) {
  const res = await page.request[method](url, data === undefined ? {} : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return res;
}

const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

test.describe('店主 2026-11-14 的需求：登记消费与预约', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸执行一次');
  test.setTimeout(150_000);

  test('登记消费：项目取不回来写明加载失败、有重试、填的备注不丢；数量可以直接输（1–99）', async ({ page }) => {
    // 需求 4：项目接口失败原来显示「还没有消费项目」、让店主去添加
    await page.route('**/api/catalog', (route) => route.abort('connectionreset'));
    await login(page, 'xiaozhou');
    await page.goto('/');
    await page.getByLabel('搜索会员').fill('周以安');
    const options = page.getByRole('listbox', { name: '会员列表' }).getByRole('option');
    await options.filter({ hasText: '周以安' }).first().click();
    await expect(page.getByText('可用余额').first()).toBeVisible();
    await page.getByRole('button', { name: /^消费(\s|$)/ }).click();
    const failed = page.getByTestId('consume-catalog-error');
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await expect(failed).toContainText('项目列表加载失败，请检查网络');
    await expect(page.getByText('还没有消费项目')).toHaveCount(0);
    await expect(page.getByText('套餐与项目')).toHaveCount(0);
    await page.locator('#cnote').fill('E2E 备注留着');
    // 网络恢复：点重试，项目出来，备注还在
    await page.unroute('**/api/catalog');
    await page.getByTestId('consume-catalog-error-retry').click();
    const soda = page.getByRole('button', { name: /^柚子气泡水/ });
    await expect(soda).toBeVisible();
    await expect(failed).toHaveCount(0);
    await expect(page.locator('#cnote')).toHaveValue('E2E 备注留着');

    // 需求 1：数量中间是输入框。1 → 4 直接输；加减按钮还在、与输入是同一个数
    await soda.click();
    const qty = page.locator('input[data-testid^="consume-qty-"]');
    await expect(qty).toHaveValue('1');
    await expect(qty).toHaveAttribute('inputmode', 'numeric');
    await qty.fill('4');
    const next = page.getByRole('button', { name: '下一步：核对扣款' });
    const footer = next.locator('xpath=..');
    await expect(footer).toContainText('88.00');
    await page.getByRole('button', { name: /^增加 柚子气泡水/ }).click();
    await expect(qty).toHaveValue('5');
    await page.getByRole('button', { name: /^减少 柚子气泡水/ }).click();
    await expect(qty).toHaveValue('4');
    // 不是数字的进不去；超过 99 按 99 算并提示；输空了、输 0 离开时回到原来的数并提示
    await qty.fill('1a2');
    await expect(qty).toHaveValue('12');
    await qty.fill('150');
    await expect(qty).toHaveValue('99');
    await expect(page.getByTestId('consume-qty-hint')).toContainText('最多 99');
    await qty.fill('0');
    await qty.blur();
    await expect(qty).toHaveValue('99');
    await expect(page.getByTestId('consume-qty-hint')).toContainText('1–99');
    await qty.fill('2');
    await expect(page.getByTestId('consume-qty-hint')).toHaveCount(0);
    await expect(footer).toContainText('44.00');
    // 核对页按输的数量算（不确认扣款）
    await next.click();
    await expect(page.getByText('扣款构成')).toBeVisible();
    await expect(page.getByRole('button', { name: /确认扣款 ¥44\.00/ })).toBeVisible();
  });

  test('预约：能翻到明天、最远到规则里的那一天；新建弹窗写明并能改预约日期；时段取不回来有重试、已填的不丢；项目能搜；看历史的页面照旧只到今天', async ({ page }) => {
    // 准备：需要技师的专用项目与 E8 号技师（与 bookings.spec、clockroom.spec 共用）
    await login(page, 'linlan');
    const itemBody = { name: ITEM, category: 'E2E 技师', prices: { standard: 19800, professional: 23800, premium: 29800 } };
    const catalog = () => getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1');
    let item = (await catalog()).items.find((i) => i.name === ITEM);
    if (!item || !item.active) {
      await (item ? send(page, 'put', `/api/items/${item.id}`, { ...itemBody, active: true }) : send(page, 'post', '/api/items', itemBody));
      item = (await catalog()).items.find((i) => i.name === ITEM)!;
    }
    await send(page, 'put', '/api/admin/technicians/items', { items: [{ id: item.id, required: true }] });
    const roster = (await getJson<{ technicians: { id: number; techNo: string; active: boolean }[] }>(page, '/api/admin/technicians')).technicians;
    if (!roster.some((x) => x.techNo === TECH.techNo)) await send(page, 'post', '/api/admin/technicians', TECH);
    const me = await getJson<{ today: string }>(page, '/api/auth/me');
    // 看历史的页面不放开（店主能翻历史营业日）：流水页今天「后一天」照旧禁用、日期框最晚今天
    await page.goto('/ledger');
    await expect(page.getByLabel('选择营业日')).toHaveAttribute('max', me.today);
    await expect(page.getByRole('button', { name: '后一天' })).toBeDisabled();
    await page.request.post('/api/auth/logout');

    await login(page, 'xiaozhou');
    const board = await getJson<BookingBoard>(page, `/api/bookings?date=${me.today}`);
    const ahead = board.rules.maxDaysAhead;
    expect(ahead).toBeGreaterThanOrEqual(1);
    const tomorrow = shift(me.today, 1);
    const lastDay = shift(me.today, ahead);

    // 需求 2：今天打开预约页，「后一天」能点，切到明天；日期框最远到「今天 + 规则里的天数」；到那一天「后一天」禁用
    await page.goto('/bookings');
    await expect(page.getByTestId('bookings-technician')).toBeVisible();
    const nextDay = page.getByRole('button', { name: '后一天' });
    await expect(nextDay).toBeEnabled();
    await expect(page.getByLabel('选择营业日')).toHaveAttribute('max', lastDay);
    await nextDay.click();
    await expect(page).toHaveURL(new RegExp(`d=${tomorrow}`));
    await page.goto(`/bookings?d=${lastDay}`);
    await expect(page.getByTestId('bookings-technician')).toBeVisible();
    await expect(nextDay).toBeDisabled();

    // 新建弹窗：在「今天」打开，最上面是预约日期（今天），点「明天」时段按明天取
    await page.goto('/bookings');
    await expect(page.getByTestId('bookings-technician')).toBeVisible();
    // 需求 6：项目多的时候有搜索、下拉按分类分组——看板的接口多回几个项目（只为看页面，不提交这些）
    await page.route(/\/api\/bookings\?date=/, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as BookingBoard;
      const extra = ['肩颈按摩', '全身精油', '头疗 60 分钟', '面部护理', '泰式按摩', '足疗 90 分钟', '采耳'].map((name, i) => ({ id: 900_000 + i, name: `E2E 多 ${name}`, minutes: 60, category: i < 4 ? 'E2E 按摩' : 'E2E 其他' }));
      await route.fulfill({ response: res, json: { ...body, items: [...body.items, ...extra] } });
    });
    await page.reload();
    await expect(page.getByTestId('bookings-technician')).toBeVisible();
    // 需求 3：时段接口失败——写明加载失败、有重试，不是一直转
    await page.route('**/api/bookings/slots**', (route) => route.abort('connectionreset'));
    await page.getByTestId('booking-new').click();
    const dialog = page.getByTestId('booking-create');
    const day = dialog.getByTestId('booking-day');
    await expect(day).toHaveValue(me.today);
    await expect(day).toHaveAttribute('min', me.today);
    await expect(day).toHaveAttribute('max', lastDay);
    await dialog.getByTestId('booking-day-1').click();
    await expect(day).toHaveValue(tomorrow);
    await expect(page.getByRole('dialog')).toContainText('明天');
    // 搜「头疗」：下拉里只剩搜到的，并自动选中；搜不到的字提示、列回全部；清掉搜索后选回真正要约的项目
    const search = dialog.getByTestId('booking-item-search');
    await search.fill('头疗');
    await expect(dialog.getByTestId('booking-item-search-result')).toContainText('找到 1 个');
    await expect(dialog.getByTestId('booking-item').locator('option')).toHaveCount(1);
    await expect(dialog.getByTestId('booking-item')).toHaveValue('900002');
    await search.fill('没有这个项目');
    await expect(dialog.getByTestId('booking-item-search-result')).toContainText('没有叫这个的项目');
    await search.fill('E2E 按摩');
    await expect(dialog.getByTestId('booking-item').locator('optgroup')).toHaveCount(1);
    await expect(dialog.getByTestId('booking-item').locator('optgroup')).toHaveAttribute('label', 'E2E 按摩');
    await search.fill('');
    await dialog.getByTestId('booking-item').selectOption(String(item.id));
    await dialog.getByTestId('booking-guest-name').fill('E2E 需求客人');
    await dialog.getByTestId('booking-guest-phone').fill('13900001114');
    await dialog.locator('#booking-note').fill('E2E 备注');
    const failed = dialog.getByTestId('booking-slots-error');
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await expect(failed).toContainText('时段加载失败');
    await expect(dialog.getByTestId('booking-slots-loading')).toHaveCount(0);
    // 先关掉弹窗再打开：已填的会员（客人）、项目、备注、日期都带回来
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByTestId('booking-new').click();
    await expect(dialog.getByTestId('booking-draft-restored')).toBeVisible();
    await expect(day).toHaveValue(tomorrow);
    await expect(dialog.getByTestId('booking-item')).toHaveValue(String(item.id));
    await expect(dialog.getByTestId('booking-guest-name')).toHaveValue('E2E 需求客人');
    await expect(dialog.locator('#booking-note')).toHaveValue('E2E 备注');
    // 网络恢复：点重试出时段，已填的不丢
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await page.unroute('**/api/bookings/slots**');
    const slotsReq = page.waitForRequest((r) => r.url().includes('/api/bookings/slots') && r.url().includes(`date=${tomorrow}`));
    await dialog.getByTestId('booking-slots-error-retry').click();
    await slotsReq;
    const slot = dialog.getByTestId('booking-slots').locator('button:not([disabled])').first();
    await expect(slot).toBeVisible();
    await expect(dialog.getByTestId('booking-guest-name')).toHaveValue('E2E 需求客人');
    // 约成：看板自动切到明天，看得到这张；再打开新建弹窗是空的
    await slot.click();
    const created = page.waitForResponse((r) => r.url().endsWith('/api/bookings') && r.request().method() === 'POST');
    await page.getByTestId('booking-create-submit').click();
    const booking = (await (await created).json()) as { id: number; businessDate: string };
    expect(booking.businessDate).toBe(tomorrow);
    await expect(page).toHaveURL(new RegExp(`d=${tomorrow}`));
    await expect(page.locator(`#booking-${booking.id}`)).toContainText('E2E 需求客人');
    await page.getByTestId('booking-new').click();
    await expect(dialog.getByTestId('booking-draft-restored')).toHaveCount(0);
    await expect(dialog.getByTestId('booking-guest-name')).toHaveValue('');
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    // 收尾：取消这张预约
    await send(page, 'post', `/api/bookings/${booking.id}/change`, { clientKey: crypto.randomUUID(), action: 'cancel', reason: 'E2E：需求用例收尾' });
  });
});
