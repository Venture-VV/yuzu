// v0.7.28 ③ 浏览器验收：预约。前台从门店导航进「预约」，给明天建一个电话预约（技师项目、指定技师、选时段、客人姓名电话）
// → 看板上「已预约」→ 改时间（换一个时段）→ 取消（写原因）→「已取消」；后台「预约」有规则卡片。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
// 与 clockroom.spec 共用「E2E 技师足疗」项目与 E8 号技师（没有就建，做法与它一样），可重复执行。
import { expect, test, type Page } from '@playwright/test';

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

async function relogin(page: Page, username: string) {
  await page.request.post('/api/auth/logout');
  await login(page, username);
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

type Tech = { id: number; techNo: string; name: string; gender: string; grade: string; skills: string[]; active: boolean };

test.describe('v0.7.28 预约', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会建预约的流程只在门店电脑尺寸执行一次');
  test.setTimeout(150_000);

  test('电话预约技师：选时段建预约 → 改时间 → 取消；后台「预约」规则', async ({ page }) => {
    // ① 店主准备：需要技师的专用项目与 E8 号技师（与钟房验收共用）
    await login(page, 'linlan');
    const itemBody = { name: ITEM, category: 'E2E 技师', prices: { standard: 19800, professional: 23800, premium: 29800 } };
    let item = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM);
    if (!item || !item.active) {
      await (item ? send(page, 'put', `/api/items/${item.id}`, { ...itemBody, active: true }) : send(page, 'post', '/api/items', itemBody));
      item = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM)!;
    }
    await send(page, 'put', '/api/admin/technicians/items', { items: [{ id: item.id, required: true }] });
    const roster = (await getJson<{ technicians: Tech[] }>(page, '/api/admin/technicians')).technicians;
    const old = roster.find((x) => x.techNo === TECH.techNo);
    if (!old) await send(page, 'post', '/api/admin/technicians', TECH);
    else if (!old.active || old.grade !== TECH.grade || old.skills.length > 0) await send(page, 'put', `/api/admin/technicians/${old.id}`, { name: old.name, gender: old.gender, grade: TECH.grade, skills: [], active: true });
    const tech = (await getJson<{ technicians: Tech[] }>(page, '/api/admin/technicians')).technicians.find((x) => x.techNo === TECH.techNo)!;

    // 后台「预约」：规则卡片（待确认的默认值）
    await page.goto('/admin/bookings');
    await expect(page.getByTestId('booking-rules')).toContainText('预约规则');
    await expect(page.getByTestId('booking-rule-open')).toHaveValue(/\d{2}:\d{2}/);

    // ② 前台：门店导航进「预约」，翻到明天
    await relogin(page, 'xiaozhou');
    const me = await getJson<{ today: string }>(page, '/api/auth/me');
    const tomorrow = new Date(Date.parse(`${me.today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '预约' }).click();
    await expect(page.getByTestId('bookings')).toBeVisible();
    await page.goto(`/bookings?d=${tomorrow}`);
    await expect(page.getByTestId('bookings-technician')).toBeVisible();

    // ③ 新建：技师 → 项目、E8 → 第一个能约的时段 → 客人姓名、电话
    await page.getByTestId('booking-new').click();
    const dialog = page.getByTestId('booking-create');
    await dialog.getByTestId('booking-item').selectOption(String(item.id));
    await dialog.getByTestId('booking-technician').selectOption(String(tech.id));
    const slots = dialog.getByTestId('booking-slots');
    await expect(slots).toBeVisible();
    const first = slots.locator('button:enabled').first();
    const firstTime = (await first.textContent())!.trim();
    await first.click();
    await dialog.getByTestId('booking-guest-name').fill('E2E 电话客人');
    await dialog.getByTestId('booking-guest-phone').fill('13900001234');
    await page.getByTestId('booking-create-submit').click();
    await expect(page.getByText(/^已预约 YY/)).toBeVisible({ timeout: 15_000 });
    const row = page.getByTestId('bookings-technician').locator('[data-testid^="booking-row-"]').filter({ hasText: 'E2E 电话客人' }).filter({ hasText: '已预约' }).first();
    await expect(row).toContainText(firstTime);
    await expect(row).toContainText(`${TECH.techNo} 号 ${TECH.name}`);
    const bookingNo = (await row.getAttribute('data-testid'))!.replace('booking-row-', '');

    // ④ 改时间：换一个能约的时段
    await page.getByTestId(`booking-reschedule-${bookingNo}`).click();
    const action = page.getByTestId('booking-action');
    const options = action.getByTestId('booking-slots').locator('button:enabled');
    await expect(options.first()).toBeVisible();
    const target = options.nth(2);
    const targetTime = (await target.textContent())!.trim();
    await target.click();
    await page.getByTestId('booking-action-submit').click();
    const moved = page.getByTestId(`booking-row-${bookingNo}`);
    await expect(moved).toContainText(targetTime, { timeout: 15_000 });

    // ⑤ 取消：写原因
    await page.getByTestId(`booking-cancel-${bookingNo}`).click();
    await page.getByTestId('booking-cancel-reason').fill('E2E 客人改天');
    await page.getByTestId('booking-action-submit').click();
    await expect(moved).toContainText('已取消', { timeout: 15_000 });
    await expect(moved).toContainText('E2E 客人改天');
    await expect(page.getByTestId(`booking-reschedule-${bookingNo}`)).toHaveCount(0);
  });
});
