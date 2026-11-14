// v0.7.28 ⑧ 浏览器验收：停车优惠（QY-016）。店主在后台把 QY-016 设成每次免 2 小时并发布（接口准备）→ 会员页「本月可享」登记停车：
// 填车牌、免费几小时 → 今天已登记 → 后台「会员权益」下方的停车登记里看得到。依赖演示数据（仅独立演示库）；账号：店主 linlan。可重复执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const run = Date.now().toString(36).toUpperCase().slice(-5);

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

type Benefit = { id: number; code: string; version: number; status: string; parking: boolean; parkingHours: number | null } & Record<string, unknown>;

test('停车优惠：会员页登记车牌与免费几小时，后台停车登记看得到', async ({ page }, info) => {
  test.skip(info.project.name !== '门店电脑', '写数据的只在门店电脑尺寸执行一次');
  await login(page, 'linlan');
  // 准备：导入本店权益清单（编号已有的跳过），QY-016 设成 L0 起每次免 2 小时并发布
  expect((await page.request.post('/api/benefits/import')).ok()).toBe(true);
  let qy016 = ((await (await page.request.get('/api/benefits')).json()) as { items: Benefit[] }).items.find((b) => b.code === 'QY-016')!;
  expect(qy016.parking).toBe(true);
  if (qy016.status !== 'published' || qy016.parkingHours !== 2) {
    const { id, version, code: _c, status: _s, ...rest } = qy016;
    const keep = ['name', 'category', 'period', 'quantity', 'tierQuantities', 'templateId', 'events', 'festivalDates', 'visitTarget', 'parking', 'parkingHoursByTier', 'content', 'conditions'];
    const body = Object.fromEntries(Object.entries(rest).filter(([k]) => keep.includes(k)));
    const saved = await page.request.put(`/api/benefits/${id}`, { data: { ...body, expectedVersion: version, startGrade: 0, startTier: null, parkingHours: 2 } });
    expect(saved.ok(), await saved.text()).toBe(true);
    qy016 = (await saved.json()) as Benefit;
    if (qy016.status !== 'published') {
      const pub = await page.request.post(`/api/benefits/${id}/status`, { data: { expectedVersion: qy016.version, status: 'published' } });
      expect(pub.ok(), await pub.text()).toBe(true);
    }
  }
  const created = await page.request.post('/api/members', { data: { name: `E2E 停车 ${run}`, phone: `198${String(Date.now()).slice(-8)}` } });
  expect(created.ok(), await created.text()).toBe(true);
  const m = (await created.json()) as { id: number };
  const plate = `粤B${run}`;

  // 会员页「本月可享」：登记停车
  await page.goto(`/?m=${m.id}`);
  const row = page.getByTestId('member-benefit-QY-016');
  await expect(row).toContainText('每次免 2 小时');
  await row.getByTestId('benefit-use-QY-016').click();
  await page.getByTestId('benefit-use-plate').fill(plate.toLowerCase());
  await expect(page.getByTestId('benefit-use-hours')).toHaveValue('2');
  await page.getByTestId('benefit-use-submit').click();
  await expect(page.getByText('已登记使用')).toBeVisible();
  await expect(row).toContainText('今天已登记');
  await expect(row.getByTestId('benefit-use-QY-016')).toBeDisabled();

  // 停车登记：8.0.19 起在门店「会员工作台 → 停车登记」（默认看今天）；后台「会员权益」原处留一条指路
  await page.goto('/');
  await page.getByTestId('workbench-parking-log').click();
  await expect(page).toHaveURL(/\/parking-log$/);
  const log = page.getByTestId('benefit-parking-log');
  await expect(log.getByTestId(`parking-row-${plate}`)).toContainText('2 小时');
  await expect(log.getByTestId(`parking-row-${plate}`)).toContainText(`E2E 停车 ${run}`);
  await page.goto('/admin/benefits');
  await expect(page.getByTestId('benefit-parking-log')).toHaveCount(0);
  await page.getByTestId('benefit-parking-moved').getByRole('link').click();
  await expect(page).toHaveURL(/\/parking-log$/);
});
