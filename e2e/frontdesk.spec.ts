// S2 前台浏览器验收：依赖 seed-demo 与 seed-frontdesk-demo（仅独立演示库），预期结果见 src/server/demo/frontdesk-expected.json。
// 账号：店主 linlan / 前台 xiaozhou / 值班经理 zhangjl，密码 yuzu2026。手牌池为店主 2026-10-27 的真实柜号清单（747 个）。
// 会改数据的业务流程只在门店电脑尺寸跑（每次自动挑空闲手牌，可重复执行）；三种尺寸都检查双栏布局与金额不截断。
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
}

const nav = (page: Page, name: string) => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true });

interface BoardTag {
  id: number;
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  vipLevel: number | null;
  locked: boolean;
  active: boolean;
  visit: { id: number; amountCents: number } | null;
}

async function boardTags(page: Page) {
  return ((await (await page.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] }).tags;
}

/** 散客可用的空闲普通柜：从清单末尾挑，避开演示数据里的在店手牌 */
async function freeTags(page: Page, zone: BoardTag['zone']): Promise<string[]> {
  return (await boardTags(page)).filter((t) => t.zone === zone && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse();
}

/** 以店主身份调规则（另开会话，不影响页面上的前台登录） */
async function asOwner(playwright: { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } }, baseURL: string | undefined) {
  const ctx = await playwright.request.newContext({ baseURL });
  expect((await ctx.post('/api/auth/login', { data: { username: 'linlan', password: PASSWORD } })).ok()).toBe(true);
  return ctx;
}

async function memberBalance(page: Page, q: string) {
  const list = (await (await page.request.get(`/api/members?q=${encodeURIComponent(q)}`)).json()) as { principalBalance: number; bonusBalance: number }[];
  return { principal: list[0]!.principalBalance, bonus: list[0]!.bonusBalance };
}

test.describe('前台流程', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('接待同行、男女牌防呆、挂账、作废、换牌、预结账，全程不扣会员余额', async ({ page }) => {
    await login(page, 'xiaozhou');
    await nav(page, '前台').click();
    await expect(page.getByRole('heading', { name: '前台 · 在店手牌' })).toBeVisible();
    const balanceBefore = await memberBalance(page, '韩松');
    const [maleTag, maleTag2] = await freeTags(page, 'male');
    const [femaleTag] = await freeTags(page, 'female');

    // F2 接待：第 1 位男宾只输数字（不输区号字母），回车补全
    await page.keyboard.press('F2');
    const dialog = page.getByRole('dialog', { name: '接待发牌' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('第 1 位牌号').fill(maleTag!.replace(/^[A-Z]+0*/, ''));
    await dialog.getByLabel('第 1 位牌号').press('Enter');
    await expect(dialog.getByLabel('第 1 位牌号')).toHaveValue(maleTag!);
    await expect(dialog.getByTestId('guest-row-0')).toContainText('空闲可发');

    // 第 2 位女宾：先错填男宾牌，被拦下且不能提交
    await dialog.getByRole('button', { name: '添加同行客人' }).click();
    await dialog.getByRole('radiogroup', { name: '第 2 位宾客分区' }).getByRole('radio', { name: '女宾' }).click();
    await dialog.getByLabel('第 2 位牌号').fill(maleTag2!);
    await expect(dialog.getByTestId('guest-row-1')).toContainText(`${maleTag2} 是男宾牌，不能发给女宾`);
    await expect(dialog.getByTestId('checkin-submit')).toBeDisabled();
    await dialog.getByLabel('第 2 位牌号').fill(femaleTag!);
    await dialog.getByLabel('第 2 位称呼').fill('E2E 同行');
    await expect(dialog.getByTestId('guest-row-1')).toContainText('空闲可发');
    await dialog.getByTestId('checkin-submit').click();
    await expect(page.getByText(`已发牌 ${maleTag}、${femaleTag}`)).toBeVisible();

    // 右侧小票：新手牌、同行组、未挂账
    const panel = page.getByTestId('bill-panel');
    await expect(panel.getByTestId('bill-tag')).toHaveText(maleTag!);
    await expect(panel.getByTestId('bill-group')).toContainText(femaleTag!);
    await expect(panel.getByTestId('bill-total')).toContainText('0.00');

    // F4 挂账：搓背 + 柚子气泡水
    await page.keyboard.press('F4');
    const add = page.getByRole('dialog').filter({ hasText: '加项目' });
    await add.getByTestId('item-搓背').click();
    await add.getByTestId('item-柚子气泡水').click();
    await add.getByTestId('add-items-submit').click();
    await expect(panel.getByTestId('bill-total')).toContainText('80.00');
    await expect(page.getByTestId(`tag-${maleTag}`)).toContainText('80');

    // 作废本人刚登记的气泡水（必须选原因）
    await panel.getByRole('button', { name: '作废 柚子气泡水' }).click();
    const voidDialog = page.getByRole('dialog').filter({ hasText: '作废「柚子气泡水 × 1」' });
    await expect(voidDialog.getByTestId('reason-confirm')).toBeDisabled();
    await voidDialog.getByRole('button', { name: '项目选错' }).click();
    await voidDialog.getByTestId('reason-confirm').click();
    await expect(panel.getByTestId('bill-total')).toContainText('58.00');
    await expect(panel).toContainText('已作废 1 项');

    // 换牌：手牌损坏，原牌自动勾选锁定；账单跟着客人走
    await panel.getByTestId('action-swap').click();
    const swap = page.getByRole('dialog').filter({ hasText: '换牌 ·' });
    await swap.locator('#swap-code').fill(maleTag2!);
    await swap.getByRole('button', { name: '手牌损坏' }).click();
    await swap.getByTestId('swap-submit').click();
    await expect(panel.getByTestId('bill-tag')).toHaveText(maleTag2!);
    await expect(panel.getByTestId('bill-total')).toContainText('58.00');
    await expect(page.getByTestId(`tag-${maleTag}`)).toHaveAttribute('data-state', 'locked');

    // 预结账：同行两张手牌合并汇总，不收款
    await page.keyboard.press('F8');
    const preview = page.getByTestId('preview');
    await expect(preview).toContainText(femaleTag!);
    await expect(preview.getByTestId('preview-total')).toContainText('58.00');
    await expect(preview).toContainText('这还不是结账单');
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();

    // 盲打牌号：页面任意位置直接敲牌号，回车打开同行的女宾账单
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.type(femaleTag!);
    await expect(page.getByTestId('tag-search')).toHaveValue(femaleTag!);
    await page.keyboard.press('Enter');
    await expect(panel.getByTestId('bill-tag')).toHaveText(femaleTag!);

    // 会员余额完全不变
    expect(await memberBalance(page, '韩松')).toEqual(balanceBefore);
    const checks = (await (await page.request.get('/api/frontdesk/checks')).json()) as { ok: boolean; label: string }[];
    for (const c of checks) expect(c.ok, c.label).toBe(true);
  });

  test('两台前台同时把同一张手牌发给不同客人：只有一台成功', async ({ browser }) => {
    const open = async (b: Browser) => {
      const ctx = await b.newContext();
      const page = await ctx.newPage();
      await login(page, 'xiaozhou');
      await page.goto('/frontdesk');
      return page;
    };
    const [p1, p2] = [await open(browser), await open(browser)];
    const [tag] = await freeTags(p1, 'male');
    for (const p of [p1, p2]) {
      await p.keyboard.press('F2');
      await p.getByRole('dialog', { name: '接待发牌' }).getByLabel('第 1 位牌号').fill(tag!);
      await expect(p.getByTestId('guest-row-0')).toContainText('空闲可发');
    }
    await Promise.all([p1.getByTestId('checkin-submit').click(), p2.getByTestId('checkin-submit').click()]);
    // 每台终端都会得到明确结果：一台「已发牌」，另一台在发牌框里看到「已在店」
    const outcome = async (p: Page) => {
      const done = p.getByText(`已发牌 ${tag}`);
      const busy = p.getByRole('dialog', { name: '接待发牌' }).getByText('已在店');
      await expect(done.or(busy).first()).toBeVisible();
      return (await done.isVisible()) ? 'ok' : 'rejected';
    };
    expect([await outcome(p1), await outcome(p2)].sort()).toEqual(['ok', 'rejected']);
    const board = (await (await p1.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] };
    expect(board.tags.find((t) => t.code === tag)!.visit).toBeTruthy();
  });
});

test.describe('VIP 柜与丢牌', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '流程只在门店电脑尺寸执行一次');

  test('散客不能用 VIP 柜；开启当场授权后由值班经理授权发牌；丢牌换牌挂赔偿 200 元', async ({ page, playwright, baseURL }) => {
    const owner = await asOwner(playwright, baseURL);
    try {
      await login(page, 'xiaozhou');
      await page.goto('/frontdesk');
      const vip = (await boardTags(page)).find((t) => t.zone === 'male' && t.kind === 'vip' && t.vipLevel === 1 && t.active && !t.locked && !t.visit)!;
      const [normal] = await freeTags(page, 'male');

      // 默认关闭当场授权：散客选 VIP 柜被拦下，不能提交
      await page.keyboard.press('F2');
      const dialog = page.getByRole('dialog', { name: '接待发牌' });
      await dialog.getByLabel('第 1 位牌号').fill(vip.code);
      await expect(dialog.getByTestId('vip-short-0')).toContainText('散客不能使用；请换普通柜或等级相符的 VIP 柜');
      await expect(dialog.getByTestId('checkin-submit')).toBeDisabled();
      await dialog.getByRole('button', { name: '取消' }).click();

      // 店主开启当场授权后：前台请值班经理在弹窗里输入账号密码授权
      expect((await owner.put('/api/frontdesk/rules', { data: { vipOverrideEnabled: true } })).ok()).toBe(true);
      await page.reload();
      await page.keyboard.press('F2');
      await dialog.getByLabel('第 1 位牌号').fill(vip.code);
      await expect(dialog.getByTestId('vip-short-0')).toContainText('需值班经理或店总当场授权');
      await expect(dialog.getByTestId('checkin-submit')).toBeDisabled();
      await dialog.getByTestId('request-authorize').click();
      const auth = page.getByRole('dialog').filter({ hasText: '当场授权 · 使用 VIP 柜' });
      await expect(auth).toContainText(`VIP 柜 ${vip.code}（第 1 级）`);
      await auth.getByLabel('授权人账号').fill('zhangjl');
      await auth.getByLabel('授权人密码').fill('wrong-password');
      await auth.getByTestId('authorize-submit').click();
      await expect(auth).toContainText('授权人账号或密码不正确');
      await auth.getByLabel('授权人密码').fill(PASSWORD);
      await auth.getByTestId('authorize-submit').click();
      await expect(auth).toHaveCount(0);
      await expect(dialog).toContainText('已由张经理当场授权');
      // 授权编号进入本机待确认记录，密码不进入
      const stored = await page.evaluate(() => localStorage.getItem('yuzu.frontdeskPending.v1') ?? '');
      expect(stored).not.toContain(PASSWORD);
      await dialog.getByTestId('checkin-submit').click();
      await expect(page.getByText(`已发牌 ${vip.code}`)).toBeVisible();
      const panel = page.getByTestId('bill-panel');
      await expect(panel.getByTestId('bill-tag')).toHaveText(vip.code);
      await expect(panel.getByTestId('bill-vip-override')).toContainText('张经理');

      // 丢牌：选「手牌丢失」自动勾选赔偿与锁定原牌，赔偿挂到账单
      await panel.getByTestId('action-swap').click();
      const swap = page.getByRole('dialog').filter({ hasText: '换牌 ·' });
      await swap.locator('#swap-code').fill(normal!);
      await swap.getByRole('button', { name: '手牌丢失' }).click();
      await expect(swap.getByRole('checkbox', { name: /收取丢牌赔偿 ¥200\.00/ })).toBeChecked();
      await expect(swap.getByRole('checkbox', { name: /同时锁定原手牌/ })).toBeChecked();
      await swap.getByTestId('swap-submit').click();
      await expect(panel.getByTestId('bill-tag')).toHaveText(normal!);
      await expect(panel.getByTestId('bill-total')).toContainText('200.00');
      await expect(panel).toContainText(`手牌丢失赔偿（${vip.code}）`);
      await expect(page.getByTestId(`tag-${vip.code}`)).toHaveAttribute('data-state', 'locked');
      const checks = (await (await page.request.get('/api/frontdesk/checks')).json()) as { ok: boolean; label: string }[];
      for (const c of checks) expect(c.ok, c.label).toBe(true);
    } finally {
      await owner.put('/api/frontdesk/rules', { data: { vipOverrideEnabled: false } });
      await owner.dispose();
    }
  });
});

test.describe('前台布局', () => {
  test('双栏工作台：手牌矩阵 + 小票，金额与按钮不截断、无横向滚动', async ({ page, viewport }) => {
    await login(page, 'linlan');
    await page.goto('/frontdesk');
    await expect(page.getByTestId('tag-board')).toBeVisible();
    // 演示数据：A8062 王先生未结 ¥172；A8090 丢失已锁定；一家三口 A8075 / A6010 / A8076
    await expect(page.getByTestId('tag-A8062')).toContainText('172');
    await expect(page.getByTestId('tag-A8062')).toHaveAttribute('data-state', 'in_use');
    await expect(page.getByTestId('tag-A8090')).toHaveAttribute('data-state', 'locked');
    await expect(page.getByTestId('tag-9058')).toContainText('周董');
    await page.getByTestId('tag-A8075').click();
    const panel = page.getByTestId('bill-panel');
    await expect(panel.getByTestId('bill-tag')).toHaveText('A8075');
    await expect(panel.getByTestId('bill-group')).toContainText('A8076');
    const total = await panel.getByTestId('bill-total').boundingBox();
    const addBtn = await panel.getByTestId('action-add').boundingBox();
    expect(total!.x + total!.width).toBeLessThanOrEqual(viewport!.width);
    expect(addBtn!.y + addBtn!.height).toBeLessThanOrEqual(viewport!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    // 每张在店卡片的金额完整显示（未被卡片裁掉）
    for (const code of ['A8062', '8001', 'A6010', 'A8076', '9058']) {
      const card = page.getByTestId(`tag-${code}`);
      const overflow = await card.evaluate((el) => [...el.querySelectorAll('span')].some((s) => s.getBoundingClientRect().right > el.getBoundingClientRect().right + 0.5));
      expect(overflow, code).toBe(false);
    }
  });

  test('结账对话框：储值只能用本次结账客人里的会员（不再搜索其他会员）；登记现金后无横向滚动', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/frontdesk');
    await expect(page.getByTestId('tag-board')).toBeVisible();
    // A8062 是散客：没有可用的会员储值，提示把同行朋友合并到同一张结账单（只看不提交）
    await page.getByTestId('tag-A8062').click();
    await page.getByTestId('bill-panel').getByTestId('action-checkout').click();
    await expect(page.getByTestId('checkout-review')).toBeVisible();
    await page.getByTestId('pay-add-wallet').click();
    await expect(page.getByTestId('pay-row-wallet')).toContainText('本次结账的客人里没有会员');
    await expect(page.getByTestId('pay-row-wallet')).toContainText('同行朋友请合并到同一张结账单');
    await expect(page.getByLabel('查找付款会员')).toHaveCount(0);
    await page.getByTestId('pay-add-cash').click();
    await page.getByLabel('客人实给现金').fill('1000');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('checkout-submit')).toBeDisabled();
  });
});
