// v0.7.18 演示数据场景块的浏览器核对（飞书需求 RQ-007，docs/DEMO_DATA.md 第 3 节）：在 demo-prepare 准备好的演示库上，
// 用店主账号只读打开关键页面，看得到场景块的业务——前台在店客人、房态看板、平面图的房态与人员、钟房服务中与待上钟、
// 厨房待出品与估清、旧账对照；v0.7.19 起还有派对房 X201 使用中、对客导览（区域色块与图标）；v0.7.24 起还有会员体系块
// （到期提醒、补充期名单与今天的降档，本月可享的项目券，后台会员权益）。只读，不改数据（跑完 check、demo-check 照样通过）。
// 只在准备好的演示库上跑：playwright.config.ts 默认不收这个文件，要设 E2E_DEMO_SHOWCASE=1（CI「演示数据」job 这样跑），只在门店电脑尺寸跑。
// 账号：店主 linlan，密码 yuzu2026。全部是合成数据。
import { expect, test, type Page } from '@playwright/test';
import type { ClockroomBoard } from '../src/shared/clockroom';
import type { FrontdeskBoard } from '../src/shared/frontdesk';
import expected from '../src/server/demo/showcase-expected.json' with { type: 'json' };

const PASSWORD = 'yuzu2026';

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

test.skip(({ viewport }) => (viewport?.width ?? 0) < 1440, '只在门店电脑尺寸跑：只读核对演示场景在页面上看得到');

test('演示场景：前台、客房与平面图、钟房、厨房、旧账都看得到', async ({ page }) => {
  await login(page, 'linlan');
  const board = await getJson<FrontdeskBoard>(page, '/api/frontdesk/board');
  const tagOf: Record<string, string> = {};
  for (const t of board.tags) if (t.visit && (expected.guests as string[]).includes(t.visit.guestLabel)) tagOf[t.visit.guestLabel] = t.code;
  expect(Object.keys(tagOf).sort()).toEqual([...expected.guests].sort());

  await test.step('前台：四位演示客人的手牌在用', async () => {
    await page.goto('/frontdesk');
    for (const code of Object.values(tagOf)) await expect(page.getByTestId(`tag-${code}`)).toHaveAttribute('data-state', 'in_use');
  });

  await test.step('客房：房态看板', async () => {
    await page.goto('/rooms');
    for (const [room, state] of Object.entries(expected.rooms)) await expect(page.getByTestId(`room-tile-${room}`)).toHaveAttribute('data-state', state);
  });

  await test.step('平面图：房态颜色、房间人数、在场名单', async () => {
    await page.goto('/rooms?view=map');
    await expect(page.getByTestId('floormap')).toBeVisible();
    await expect(page.getByTestId('map-space-W301')).toHaveAttribute('data-state', 'occupied');
    await expect(page.getByTestId('map-space-W302')).toHaveAttribute('data-state', 'dirty');
    await expect(page.getByTestId('map-space-T301')).toHaveAttribute('data-state', 'serving');
    await expect(page.getByTestId('map-space-T302')).toHaveAttribute('data-state', 'waiting');
    // 人员图层：乙与 D01 在 T301、甲在 W301、丙刷卡到了 V312
    await expect(page.getByTestId('map-people-T301')).toHaveAttribute('data-count', '2');
    await expect(page.getByTestId('map-people-W301')).toHaveAttribute('data-count', '1');
    await expect(page.getByTestId('map-people-V312')).toHaveAttribute('data-count', '1');
    const people = page.getByTestId('floormap-people');
    await expect(people.getByTestId('floormap-person-technician-D01')).toContainText('演示技师·林');
    await expect(people.getByTestId(`floormap-person-guest-${tagOf['演示客人丙']}`)).toBeVisible();
    await page.getByTestId('map-space-V312').click();
    await expect(page.getByTestId('floormap-panel-people')).toContainText(`手牌 ${tagOf['演示客人丙']}`);
    // 二层：丁在派对房 X201 开了单（使用中、6 人），丁的位置在 X201
    await page.getByTestId('floormap').getByRole('radiogroup', { name: '楼层' }).getByRole('radio', { name: 'L2 二层平面图' }).click();
    await expect(page.getByTestId('map-space-X201')).toHaveAttribute('data-state', 'in_use');
    await page.getByTestId('map-space-X201').click();
    await expect(page.getByTestId('floormap-usage-info')).toContainText(`手牌 ${tagOf['演示客人丁']}`);
    await expect(page.getByTestId('floormap-usage-info')).toContainText('6 人');
    await expect(page.getByTestId('map-people-X201')).toHaveAttribute('data-count', '1');
  });

  await test.step('对客导览：区域色块（派对区是动区）、设施图标，不显示房号', async () => {
    await page.goto('/guide');
    const l2 = page.getByTestId('guide-map-L2');
    await expect(l2.locator('[data-kind="active"]')).toHaveCount(1);
    for (const k of ['reception', 'entrance', 'elevator']) await expect(l2.getByTestId(`guide-marker-${k}`)).toHaveCount(1);
    await expect(page.getByTestId('guide-legend')).toContainText('样例派对区');
    await expect(page.getByTestId('guide-page')).not.toContainText('X201');
  });

  await test.step('钟房：乙的钟服务中、丙的钟待上钟', async () => {
    const clock = await getJson<ClockroomBoard>(page, '/api/clockroom');
    const serving = clock.sessions.find((s) => s.techNo === 'D01' && s.status === 'serving');
    const waiting = clock.sessions.find((s) => s.techNo === 'D02' && s.status === 'waiting');
    expect(serving?.tagCode).toBe(tagOf['演示客人乙']);
    expect(waiting?.tagCode).toBe(tagOf['演示客人丙']);
    await page.goto('/clockroom');
    await expect(page.getByTestId(`clock-serving-${serving!.sessionNo}`)).toBeVisible();
    await expect(page.getByTestId(`clock-waiting-${waiting!.sessionNo}`)).toBeVisible();
  });

  await test.step('厨房：果汁待出、演示果汁估清', async () => {
    await page.goto('/dining/kitchen');
    await expect(page.getByTestId('kds-col-queued')).toContainText('演示果汁');
    await page.goto('/dining/limits');
    await expect(page.getByTestId('limit-演示果汁')).toContainText('估清');
  });

  await test.step('旧账对照：四份合成样例', async () => {
    await page.goto('/erp/legacy?tab=imports');
    await expect(page.getByTestId('legacy-imports').locator('li')).toHaveCount(4);
  });

  // 会员体系块（v0.7.24）：到期提醒、补充期名单里有演示会员，会员详情「本月可享」有本月的项目券
  await test.step('会员体系：到期提醒与补充期名单、本月可享、后台会员权益', async () => {
    await page.goto('/dashboard/membership');
    await expect(page.getByTestId('membership-retention')).toContainText('演示会员·将到期');
    await page.getByRole('radio', { name: /^补充期/ }).click();
    await expect(page.getByTestId('membership-retention')).toContainText('演示会员·补充期');
    await expect(page.getByTestId('membership-today-events')).toContainText('演示会员·刚降档');
    await expect(page.getByTestId('membership-benefits')).toContainText('按摩/足浴项目券');
    const [member] = await getJson<{ id: number }[]>(page, `/api/members?q=${encodeURIComponent('19900009001')}`);
    await page.goto(`/?m=${member!.id}`);
    await expect(page.getByTestId('member-benefit-QY-040')).toContainText('本月发 1 / 1 张');
    await expect(page.getByTestId('member-benefit-QY-001')).toContainText('本月已用 0 / 4 次');
    await page.goto('/admin/benefits');
    await expect(page.getByTestId('benefit-row-QY-040')).toContainText('已发布');
  });
});
