// v0.5.0 浏览器验收：依赖 seed-demo、seed-frontdesk-demo、seed-billing-demo（仅独立演示库）。
//   · 按实际时间补录纸质单（R1.9）：值班经理打开「补录纸质单」，填单号与实际时间，接待 → 加项目 → 结账各按纸质单上的时间办理，
//     补录的结账没有储值；结账单、手牌账单标「补录」，日结异常清单列出；
//   · 前台按姓名或手机尾号找在店客人；值班经理在前台锁牌 / 解锁；看板在店未结含门票估算。
// 账号：值班经理 zhangjl、店主 linlan，密码 yuzu2026。会改数据，只在门店电脑尺寸执行；每次自动挑没用过的空闲手牌，可重复执行。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';
const H = 3_600_000;

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  locked: boolean;
  active: boolean;
  visit: { id: number; memberName: string | null; memberPhoneTail: string | null } | null;
}

const board = async (page: Page) => ((await (await page.request.get('/api/frontdesk/board')).json()) as { tags: BoardTag[] }).tags;
const dayBefore = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** 最近三个营业日没有结过账的空闲普通柜（从清单末尾挑，避开演示数据与其他用例）：补录的时段不会与别的客人重叠 */
async function unusedFreeTag(page: Page) {
  const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string };
  const used = new Set<string>();
  for (const date of [me.today, dayBefore(me.today, 1), dayBefore(me.today, 2)]) {
    const list = (await (await page.request.get(`/api/frontdesk/checkouts?date=${date}`)).json()) as { tagCodes: string[] }[];
    for (const c of list) for (const code of c.tagCodes ?? []) used.add(code);
  }
  const tag = (await board(page)).reverse().find((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit && !used.has(t.code));
  expect(tag, '找不到可用于补录的空闲手牌').toBeTruthy();
  return tag!.code;
}

/** datetime-local 输入框的值：浏览器按 playwright.config 的时区（Asia/Shanghai）解释，不能用执行用例的机器的本地时间 */
const local = (d: Date) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

test.describe('v0.5.0 前台', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');

  test('补录纸质单：接待、加项目、结账按纸质单上的实际时间，单据与日结标「补录」', async ({ page }) => {
    await login(page, 'zhangjl');
    // 补录的结账同样要先开班
    const cur = (await (await page.request.get('/api/shifts/current')).json()) as { shift: unknown };
    if (!cur.shift) expect((await page.request.post('/api/shifts', { data: { openingCash: 0 } })).ok()).toBe(true);
    const code = await unusedFreeTag(page);
    const slip = `E2E-${Date.now().toString(36).toUpperCase()}`;
    const base = Date.now();

    await page.goto('/frontdesk');
    await expect(page.getByTestId('tag-board')).toBeVisible();
    await page.getByTestId('backfill-toggle').click();
    const bar = page.getByTestId('backfill-bar');
    await expect(bar).toContainText('请填写纸质单号');
    await bar.getByTestId('backfill-slip').fill(slip);
    await bar.getByTestId('backfill-at').fill(local(new Date(base - 3 * H)));
    await expect(bar).toContainText('接待、加项目、结账都按这个时间办理');

    // ① 接待：点空闲手牌发牌，对话框写明按纸质单补录
    await page.getByTestId(`tag-${code}`).click();
    const checkin = page.getByRole('dialog', { name: '接待发牌' });
    await expect(checkin).toContainText(`补录纸质单 ${slip}`);
    await checkin.getByTestId('checkin-submit').click();
    const panel = page.getByTestId('bill-panel');
    await expect(panel.getByTestId('bill-tag')).toHaveText(code);
    await expect(panel.getByTestId('bill-backfill')).toContainText(`纸质单 ${slip}`);

    // ② 加项目：换成纸质单上挂账的时间
    await bar.getByTestId('backfill-at').fill(local(new Date(base - 2 * H)));
    await page.keyboard.press('F4');
    const add = page.getByRole('dialog').filter({ hasText: '加项目' });
    await expect(add).toContainText(`补录纸质单 ${slip}`);
    await add.getByTestId('item-搓背').click();
    await add.getByTestId('add-items-submit').click();
    await expect(panel.getByTestId('bill-total')).toContainText('58.00');
    await expect(panel).toContainText(`补录 纸质单 ${slip}`);

    // ③ 结账：按实际离店时间计价（在店 2 小时，12 小时档 499 + 搓背 58），没有储值
    await bar.getByTestId('backfill-at').fill(local(new Date(base - H)));
    await panel.getByTestId('action-checkout').click();
    const dialog = page.getByTestId('checkout');
    await expect(dialog).toContainText(`补录纸质单 ${slip}`);
    await expect(page.getByTestId('pay-add-wallet')).toHaveCount(0);
    await expect(page.getByTestId('checkout-submit')).toContainText('557.00');
    await page.getByTestId('pay-add-cash').click();
    await page.getByTestId('checkout-submit').click();
    const receipt = page.getByTestId('checkout-receipt');
    await expect(receipt.getByTestId('checkout-backfill')).toContainText(slip);
    await expect(receipt).toContainText('在店 2 时');
    await page.getByTestId('checkout-finish').click();

    // ④ 退出补录；日结异常清单列出三步补录（营业日按实际时间：在营业日切换后不久执行时，接待可能落在前一个营业日）
    await bar.getByTestId('backfill-exit').click();
    await expect(page.getByTestId('backfill-bar')).toHaveCount(0);
    const me = (await (await page.request.get('/api/auth/me')).json()) as { today: string };
    let found = 0;
    let checkoutDate = '';
    for (const date of [me.today, dayBefore(me.today, 1)]) {
      const res = await page.request.get(`/api/settlements/${date}`);
      if (!res.ok()) continue;
      const s = (await res.json()) as { anomalies: { kind: string; description: string }[] };
      const mine = s.anomalies.filter((a) => a.kind === 'backfill' && a.description.includes(slip));
      found += mine.length;
      if (mine.some((a) => a.description.startsWith('补录结账'))) checkoutDate = date;
    }
    expect(found).toBe(3);
    await page.goto(`/settlement/${checkoutDate}`);
    await expect(page.getByText(new RegExp(`补录结账.*纸质单 ${slip}`)).first()).toBeVisible();
  });

  test('找客人：按会员姓名或手机尾号找到在店客人，点一下打开账单', async ({ page }) => {
    await login(page, 'zhangjl');
    const tag = (await board(page)).find((t) => t.visit?.memberPhoneTail && t.visit.memberName);
    test.skip(!tag, '演示库里没有在店会员');
    await page.goto('/frontdesk');
    await page.getByTestId('open-find-guest').click();
    const input = page.getByTestId('find-guest-input');
    await input.fill(tag!.visit!.memberPhoneTail!);
    await expect(page.getByTestId(`find-guest-${tag!.code}`)).toBeVisible();
    await input.fill(tag!.visit!.memberName!);
    await page.getByTestId(`find-guest-${tag!.code}`).click();
    await expect(page.getByTestId('bill-panel').getByTestId('bill-tag')).toHaveText(tag!.code);
  });

  test('值班经理在前台锁牌、点锁定的牌解锁', async ({ page }) => {
    await login(page, 'zhangjl');
    const code = (await board(page)).find((t) => t.zone === 'female' && t.kind === 'normal' && t.active && !t.locked && !t.visit)!.code;
    await page.goto('/frontdesk');
    await page.getByTestId('open-tag-lock').click();
    const dialog = page.getByRole('dialog', { name: '锁牌 / 解锁' });
    await dialog.getByTestId('tag-lock-code').fill(code);
    await expect(dialog.getByTestId('tag-lock-status')).toContainText('空闲');
    await expect(dialog.getByTestId('tag-lock')).toBeDisabled();
    await dialog.getByRole('button', { name: '柜锁故障' }).click();
    await dialog.getByTestId('tag-lock').click();
    await expect(page.getByText(`手牌 ${code} 已锁定`)).toBeVisible();

    // 状态板刷新为锁定后，值班经理点这张牌直接进入解锁
    await expect(page.getByTestId(`tag-${code}`)).toHaveAttribute('data-state', 'locked');
    await page.getByTestId(`tag-${code}`).click();
    await expect(dialog.getByTestId('tag-lock-status')).toContainText('已锁定：柜锁故障');
    await dialog.getByTestId('tag-unlock').click();
    await expect(page.getByText(`手牌 ${code} 已解锁`)).toBeVisible();
    const after = (await board(page)).find((t) => t.code === code)!;
    expect(after.locked).toBe(false);
  });

  test('看板：在店未结含门票估算', async ({ page }) => {
    await login(page, 'linlan');
    const d = (await (await page.request.get('/api/dashboard')).json()) as { inStore: { count: number; unsettled: number; ticketEstimate: number } };
    test.skip(d.inStore.count === 0, '演示库里没有在店客人');
    expect(d.inStore.ticketEstimate).toBeGreaterThan(0);
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-instore-estimate')).toContainText('门票估算');
  });
});
