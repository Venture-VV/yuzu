// G2 复审回归（门店电脑尺寸）：前台操作响应丢失后的待确认处理，以及末位输入对上多张牌时必须明确选择。
// 依赖 seed-demo 与 seed-frontdesk-demo（仅独立演示库）；每次自动挑空闲手牌，可重复执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'xiaozhou');
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

interface BoardTag {
  id: number;
  code: string;
  zone: 'male' | 'female' | 'child';
  locked: boolean;
  active: boolean;
  visit: { id: number } | null;
}

async function board(page: Page) {
  return ((await (await page.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] }).tags;
}

/** 开一张新牌并打开它的小票 */
async function openFreshVisit(page: Page): Promise<string> {
  const free = (await board(page)).filter((t) => t.zone === 'male' && t.active && !t.locked && !t.visit).reverse();
  const code = free[0]!.code;
  const res = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: crypto.randomUUID(), guests: [{ tagCode: code, zone: 'male' }] } });
  expect(res.status()).toBe(201);
  await page.goto('/frontdesk');
  await page.getByTestId(`tag-${code}`).click();
  await expect(page.getByTestId('bill-tag')).toHaveText(code);
  return code;
}

async function linesOf(page: Page, code: string) {
  const tag = (await board(page)).find((t) => t.code === code)!;
  const v = (await (await page.request.get(`/api/frontdesk/visits/${tag.visit!.id}`)).json()) as { lines: { name: string; status: string }[]; bill: { amountCents: number } };
  return { active: v.lines.filter((l) => l.status === 'active').map((l) => l.name), amount: v.bill.amountCents };
}

/** 挂账请求真实到达服务器并入账，但浏览器收不到响应 */
async function loseNextChargeResponse(page: Page) {
  await page.route('**/api/frontdesk/visits/*/charges', async (route) => {
    await route.fetch();
    await route.abort('connectionreset');
  }, { times: 1 });
}

async function addScrub(page: Page) {
  await page.keyboard.press('F4');
  const add = page.getByRole('dialog').filter({ hasText: '加项目' });
  await add.getByTestId('item-搓背').click();
  await add.getByTestId('add-items-submit').click();
  return add;
}

test.describe('前台待确认操作与明确选牌', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('挂账响应丢失后关闭对话框：重开仍提示待确认，不能另起一笔；查回后只有一笔', async ({ page }) => {
    await login(page);
    const code = await openFreshVisit(page);
    await loseNextChargeResponse(page);
    // 顶部提醒会自动查回并确认已生效的操作；这里先让查回连不上，验证「仍待确认」时的锁定
    await page.route('**/api/frontdesk/ops/*', (route) => route.abort('connectionreset'));
    const add = await addScrub(page);
    await expect(add.getByTestId('pending-op')).toContainText('搓背 ×1');
    // 关闭再打开：原操作仍在，表单锁定
    await add.getByRole('button', { name: '取消' }).click();
    await expect(page.getByTestId('bill-pending-resolve')).toBeVisible();
    await page.keyboard.press('F4');
    const again = page.getByRole('dialog').filter({ hasText: '加项目' });
    await expect(again.getByTestId('pending-op')).toContainText('搓背 ×1');
    await expect(again.getByTestId('item-搓背')).toBeDisabled();
    await expect(again.getByTestId('add-items-submit')).toBeDisabled();
    await page.unroute('**/api/frontdesk/ops/*');
    await again.getByTestId('pending-check').click();
    await expect(page.getByText(`已挂到 ${code}`)).toBeVisible();
    expect(await linesOf(page, code)).toEqual({ active: ['搓背'], amount: 5800 });
  });

  test('刷新页面后：顶部提醒仍在，按原内容重新提交也只生效一次', async ({ page }) => {
    await login(page);
    const code = await openFreshVisit(page);
    await loseNextChargeResponse(page);
    // 刷新后的自动查回会直接确认已生效的操作；这里让查回连不上，验证提醒仍在、可原样重提
    await page.route('**/api/frontdesk/ops/*', (route) => route.abort('connectionreset'));
    await addScrub(page);
    await expect(page.getByRole('dialog').getByTestId('pending-op')).toBeVisible();
    await page.reload();
    const banner = page.getByTestId('frontdesk-pending-banner');
    await expect(banner).toContainText(code);
    await banner.getByRole('button', { name: '去处理' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: '加项目' });
    await dialog.getByTestId('pending-retry').click();
    await expect(page.getByText(`已挂到 ${code}`)).toBeVisible();
    await expect(banner).toHaveCount(0);
    expect(await linesOf(page, code)).toEqual({ active: ['搓背'], amount: 5800 });
  });

  test('请求没到服务器：查不到时不断言「没生效」；确认作废后才能重新填写，最终只有一笔', async ({ page }) => {
    await login(page);
    const code = await openFreshVisit(page);
    await page.route('**/api/frontdesk/visits/*/charges', (route) => route.abort('connectionreset'), { times: 1 });
    const add = await addScrub(page);
    await add.getByTestId('pending-check').click();
    await expect(add.getByTestId('pending-op').locator('..')).toContainText('暂未查到已生效的结果');
    await expect(add.getByTestId('add-items-submit')).toBeDisabled();
    await add.getByTestId('pending-abandon').click();
    await expect(add.getByTestId('pending-op')).toHaveCount(0);
    // 作废后原内容保留在表单里，确认后作为新的一笔提交
    await add.getByTestId('add-items-submit').click();
    await expect(page.getByText(`已挂到 ${code}`)).toBeVisible();
    expect(await linesOf(page, code)).toEqual({ active: ['搓背'], amount: 5800 });
  });

  test('接待响应丢失后重新登录：提醒仍在，查回后只开了一张牌', async ({ page }) => {
    await login(page);
    await page.goto('/frontdesk');
    const code = (await board(page)).filter((t) => t.zone === 'female' && t.active && !t.locked && !t.visit).reverse()[0]!.code;
    await page.route('**/api/frontdesk/checkins', async (route) => {
      await route.fetch();
      await route.abort('connectionreset');
    }, { times: 1 });
    await page.route('**/api/frontdesk/ops/*', (route) => route.abort('connectionreset'));
    await page.keyboard.press('F2');
    const dialog = page.getByRole('dialog', { name: '接待发牌' });
    await dialog.getByRole('radiogroup', { name: '第 1 位宾客分区' }).getByRole('radio', { name: '女宾' }).click();
    await dialog.getByLabel('第 1 位牌号').fill(code);
    await dialog.getByTestId('checkin-submit').click();
    await expect(dialog.getByTestId('pending-op')).toContainText(code);
    // 退出再登录：本机记录仍在，重新打开接待时先处理原操作
    await page.request.post('/api/auth/logout');
    await login(page);
    await page.goto('/frontdesk');
    await expect(page.getByTestId('frontdesk-pending-banner')).toContainText(code);
    await page.keyboard.press('F2');
    await expect(dialog.getByTestId('pending-op')).toContainText(code);
    await expect(dialog.getByTestId('checkin-submit')).toBeDisabled();
    await page.unroute('**/api/frontdesk/ops/*');
    await dialog.getByTestId('pending-check').click();
    // 查回的是原来那一次接待：提示「已发过牌」
    await expect(page.getByText(new RegExp(`已发过?牌 ${code}`))).toBeVisible();
    await expect(page.getByTestId('bill-tag')).toHaveText(code);
    const tag = (await board(page)).find((t) => t.code === code)!;
    expect(tag.visit).toBeTruthy();
  });

  test('按原内容重提被明确拒绝（牌已被其他终端发出）：先作废原编号，原请求随后到达也不生效', async ({ page }) => {
    await login(page);
    await page.goto('/frontdesk');
    const code = (await board(page)).filter((t) => t.zone === 'male' && t.active && !t.locked && !t.visit).reverse()[1]!.code;
    // 截下原请求、让浏览器以为断网，留着稍后原样送到服务器
    let original: { clientKey: string } | null = null;
    await page.route(
      '**/api/frontdesk/checkins',
      async (route) => {
        original = route.request().postDataJSON();
        await route.abort('connectionreset');
      },
      { times: 1 },
    );
    await page.keyboard.press('F2');
    const dialog = page.getByRole('dialog', { name: '接待发牌' });
    await dialog.getByLabel('第 1 位牌号').fill(code);
    await dialog.getByTestId('checkin-submit').click();
    await expect(dialog.getByTestId('pending-op')).toContainText(code);
    await expect(dialog.getByTestId('pending-op').locator('..')).toContainText('暂未查到已生效的结果');

    // 另一台终端把这张牌发给了别的客人；按原内容重提被拒绝
    const other = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: crypto.randomUUID(), guests: [{ tagCode: code, zone: 'male' }] } });
    expect(other.status()).toBe(201);
    await dialog.getByTestId('pending-retry').click();
    // 拒绝原因照常显示；页面先在服务端作废原编号，确认后才移除待确认记录
    await expect(dialog).toContainText(`手牌 ${code} 已在店`);
    await expect(dialog.getByTestId('pending-op')).toHaveCount(0);
    expect(await (await page.request.get(`/api/frontdesk/ops/${original!.clientKey}`)).json()).toEqual({ found: false, abandoned: true });
    // 原请求这时才到达：不会再开一张牌
    const late = await page.request.post('/api/frontdesk/checkins', { data: original });
    expect(late.status()).toBe(409);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe('OP_ABANDONED');
    const visits = (await board(page)).filter((t) => t.code === code && t.visit);
    expect(visits).toHaveLength(1);
  });

  test('末位对上多张空闲牌：不自动取第一张，必须点选', async ({ page }) => {
    await login(page);
    await page.goto('/frontdesk');
    const free = (await board(page)).filter((t) => t.zone === 'male' && t.active && !t.locked && !t.visit).map((t) => t.code);
    // 找一个末位数字对上至少两张空闲男宾牌、且没有数字完全相同空闲牌的输入
    const digit = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].find((d) => {
      const hits = free.filter((c) => c.endsWith(d));
      return hits.length >= 2 && !free.some((c) => Number(c.replace(/\D/g, '')) === Number(d));
    });
    test.skip(!digit, '演示库中没有合适的多候选尾号');
    const hits = free.filter((c) => c.endsWith(digit!));
    await page.keyboard.press('F2');
    const dialog = page.getByRole('dialog', { name: '接待发牌' });
    await dialog.getByLabel('第 1 位牌号').fill(digit!);
    await dialog.getByLabel('第 1 位牌号').press('Tab');
    await expect(dialog.getByLabel('第 1 位牌号')).toHaveValue(digit!);
    await expect(dialog.getByTestId('guest-row-0')).toContainText('请点选实际拿到的');
    await expect(dialog.getByTestId('checkin-submit')).toBeDisabled();
    const chosen = hits[1]!;
    await dialog.getByTestId('guest-row-0').getByRole('button', { name: chosen, exact: true }).click();
    await expect(dialog.getByLabel('第 1 位牌号')).toHaveValue(chosen);
    await expect(dialog.getByTestId('checkin-submit')).toBeEnabled();
    await dialog.getByRole('button', { name: '取消' }).click();

    // 状态板盲打同样不会替员工选：多张候选时回车只提示
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.type(digit!);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('search-hint')).toContainText('请用方向键选中后回车');
    await expect(page.getByRole('dialog', { name: '接待发牌' })).toHaveCount(0);
  });
});
