// G2 第 2 轮复测意见 1 的回归（门店电脑尺寸）：本机存储「读正常、写失败」时，待确认记录保存不了，
// 页面必须拦下这笔、不发请求；否则响应一旦丢失，关闭或刷新后找不到原编号，就会重复充值 / 重复挂账。
// 依赖 seed-demo 与 seed-frontdesk-demo（仅独立演示库）；可重复执行。
import { expect, test, type Page } from '@playwright/test';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';
const WALLET_KEY = 'yuzu.pendingOps.v1';
const FRONTDESK_KEY = 'yuzu.frontdeskPending.v1';

/** 只让待确认记录的 setItem 抛出「存储已满」，读取照常；window.__failPendingWrites = false 可恢复 */
async function failPendingWrites(page: Page) {
  await page.addInitScript((keys) => {
    const w = window as unknown as { __failPendingWrites: boolean };
    w.__failPendingWrites = true;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (w.__failPendingWrites && keys.includes(key)) throw new DOMException('模拟存储已满', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  }, [WALLET_KEY, FRONTDESK_KEY]);
}

/** 请求若真发出，会在服务端生效后丢弃响应（复测时的故障）；这里只用来数有没有发出 */
async function countLostRequests(page: Page, pattern: string) {
  const counter = { n: 0 };
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    counter.n += 1;
    await route.fetch();
    await route.abort('connectionreset');
  });
  return counter;
}

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'xiaozhou');
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 }); // 刚启动的服务第一次登录可能较慢
  await ensureShift(page); // 收款前必须先开班（R1.2）
}

test.describe('本机存储写入失败时不提交', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('会员充值：保存不了待确认记录就不发请求；关闭重开、刷新后都不会多出一笔', async ({ page }) => {
    await failPendingWrites(page);
    await login(page);
    const name = '沈知夏';
    const balance = async () => {
      const [m] = (await (await page.request.get(`/api/members?q=${encodeURIComponent(name)}`)).json()) as { principalBalance: number; bonusBalance: number }[];
      return { principal: m!.principalBalance, bonus: m!.bonusBalance };
    };
    const recharges = async () => ((await (await page.request.get(`/api/ledger?type=recharge&q=${encodeURIComponent(name)}`)).json()) as unknown[]).length;
    const before = await balance();
    const countBefore = await recharges();
    const sent = await countLostRequests(page, '**/api/recharges');

    await page.goto('/');
    await page.getByLabel('搜索会员').fill(name);
    await page.getByRole('option').filter({ hasText: name }).first().click();
    const recharge = async () => {
      await page.getByRole('button', { name: /^充值/ }).first().click();
      await page.getByRole('button', { name: /轻享 300/ }).click();
      await page.getByRole('button', { name: '现金' }).click();
      await page.getByRole('button', { name: '下一步：核对收款' }).click();
      await page.getByText('我已核实').click();
      await page.getByRole('button', { name: /确认入账/ }).click();
    };
    await recharge();
    await expect(page.getByText('本机浏览器无法保存「结果待确认」记录')).toBeVisible();
    expect(sent.n).toBe(0);

    // 关闭重开、刷新：没有残留的待确认，也没有任何一笔入账
    await page.getByRole('button', { name: '关闭' }).first().click();
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: '笔操作结果待确认' })).toHaveCount(0);
    expect(sent.n).toBe(0);
    expect(await balance()).toEqual(before);
    expect(await recharges()).toBe(countBefore);

    // 存储恢复后正常办理，只入账一次
    await page.unroute('**/api/recharges');
    await page.evaluate(() => ((window as unknown as { __failPendingWrites: boolean }).__failPendingWrites = false));
    await page.getByLabel('搜索会员').fill(name);
    await page.getByRole('option').filter({ hasText: name }).first().click();
    await recharge();
    await expect(page.getByText('充值已入账')).toBeVisible();
    expect(await recharges()).toBe(countBefore + 1);
  });

  test('前台挂账：保存不了待确认记录就不发请求；关闭重开、刷新后账单不会多出明细', async ({ page }) => {
    await failPendingWrites(page);
    await login(page);
    // 先开一张新牌（直接调接口，不经过本机待确认记录）
    const tags = ((await (await page.request.get('/api/frontdesk/board')).json()) as { tags: { code: string; zone: string; kind: string; active: boolean; locked: boolean; visit: unknown }[] }).tags;
    const code = tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).reverse()[2]!.code;
    expect((await page.request.post('/api/frontdesk/checkins', { data: { clientKey: crypto.randomUUID(), guests: [{ tagCode: code, zone: 'male' }] } })).status()).toBe(201);
    const bill = async () => {
      const t = ((await (await page.request.get('/api/frontdesk/board')).json()) as { tags: { code: string; visit: { id: number } | null }[] }).tags.find((x) => x.code === code)!;
      const v = (await (await page.request.get(`/api/frontdesk/visits/${t.visit!.id}`)).json()) as { bill: { amountCents: number }; lines: unknown[] };
      return { amountCents: v.bill.amountCents, lines: v.lines.length };
    };
    const sent = await countLostRequests(page, '**/api/frontdesk/visits/*/charges');

    await page.goto('/frontdesk');
    await page.getByTestId(`tag-${code}`).click();
    await expect(page.getByTestId('bill-tag')).toHaveText(code);
    await page.keyboard.press('F4');
    const add = page.getByRole('dialog').filter({ hasText: '加项目' });
    await add.getByTestId('item-搓背').click();
    await add.getByTestId('add-items-submit').click();
    await expect(add).toContainText('本机浏览器无法保存「结果待确认」记录');
    expect(sent.n).toBe(0);

    await add.getByRole('button', { name: '取消' }).click();
    await page.reload();
    await expect(page.getByTestId('frontdesk-pending-banner')).toHaveCount(0);
    expect(sent.n).toBe(0);
    expect(await bill()).toEqual({ amountCents: 0, lines: 0 });
  });
});
