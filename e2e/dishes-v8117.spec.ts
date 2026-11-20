// 8.1.17 菜品补完浏览器验收（docs/DISHES_V8117.md）：
// ① 会写数据的流程（只在门店电脑这一组执行一次）：
//    菜品编辑里做法分组、必选与加价（BW6）、套餐的一样标「可换」与差价（BW7）→ 排序（BW10）→ 批量下架、上架 → 删除与恢复
//    → 点单页：选规格（BW5）、必选的做法没选不能加、加料；套餐换菜；菜篮写做法与换菜、合计对 → 下单
//    → 退主菜带加料（BW8）→ 厨房屏：套餐里在水吧做的一样单独出一张子项单（开始做、出餐），套餐那一张写着进度。
// ② 各尺寸（合成数据代替接口、只读，门店电脑、平板横屏、手机都跑）：点单弹窗（选规格、分组单选、必选、换菜）、
//    厨房屏的子项单、平板的选做法抽屉（必选、换菜）不横向滚动、按钮在屏幕里。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。
// 菜品不真删：每次用不同的后缀建菜，结束时都下架、删除；专用档口（E2E 菜品 开头）留着下次沿用；餐饮功能的开关恢复成开始时的样子。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { DiningAdmin, DiningMenu, KitchenBoard, KitchenItem, KitchenPartItem, MenuDish } from '../src/shared/dining';
import type { DishRow, DishSaveResult, DishesBoard } from '../src/shared/dishes';
import { DEFAULT_EMENU_PERIODS, type EmenuMenu } from '../src/shared/emenu';
import { expectFits } from './fits';

const PASSWORD = 'yuzu2026';
const HOT = 'E2E 菜品 热菜';
const BAR = 'E2E 菜品 水吧';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const FISH = `水煮鱼 ${RUN}`;
const EGG = `加蛋 ${RUN}`;
const RICE = `米饭 ${RUN}`;
const COLA = `可乐 ${RUN}`;
const JUICE = `橙汁 ${RUN}`;
const SET = `午餐套餐 ${RUN}`;
const FRUIT_A = `果盘甲 ${RUN}`;
const FRUIT_B = `果盘乙 ${RUN}`;

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: /主导航|ERP 导航/ })).toBeVisible({ timeout: 30_000 });
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function send<T = unknown>(page: Page, method: 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const res = await page.request[method](url, data === undefined ? {} : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

const dishes = async (page: Page) => (await getJson<DishesBoard>(page, '/api/dining/dishes?deleted=1')).dishes;
const dishOf = async (page: Page, name: string) => (await dishes(page)).find((d) => d.name === name)!;
const row = (page: Page, name: string) => page.getByTestId(`dish-row-${name}`);

/** 这几个按钮、输入框都在屏幕里（不用横着滚才点得到） */
async function expectOnScreen(page: Page, testIds: string[]) {
  const vw = page.viewportSize()!.width;
  for (const id of testIds) {
    const box = await page.getByTestId(id).first().boundingBox();
    expect(box, `${id} 没显示`).not.toBeNull();
    expect(box!.x, `${id} 在屏幕左边外面`).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width, `${id} 超出屏幕右边`).toBeLessThanOrEqual(vw + 1);
  }
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}

test.describe('8.1.17 菜品补完', () => {
  test('做法分组与加价、可换的套餐 → 排序、批量上下架、删除 → 点单选规格、必选、换菜 → 退主菜带加料 → 厨房屏的子项单', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '会写数据的流程只在门店电脑这一组执行一次');
    test.setTimeout(300_000);
    await login(page, 'linlan');
    const before = (await getJson<DiningAdmin>(page, '/api/admin/dining')).rules;
    let visitId: number | null = null;
    try {
      // ① 准备：开着餐饮、出餐后要点上菜；两个专用档口；菜用接口建（做法分组、可换在页面上设）
      await send(page, 'put', '/api/admin/dining/rules', { enabled: true, trackServed: true });
      let admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
      for (const name of [HOT, BAR]) {
        const old = admin.stations.find((s) => s.name === name);
        if (!old) admin = await send<DiningAdmin>(page, 'post', '/api/admin/dining/stations', { name });
        else if (!old.active) admin = await send<DiningAdmin>(page, 'put', `/api/admin/dining/stations/${old.id}`, { name, sortOrder: old.sortOrder, active: true });
      }
      const hot = admin.stations.find((s) => s.name === HOT)!.id;
      const bar = admin.stations.find((s) => s.name === BAR)!.id;
      const make = async (body: Record<string, unknown>) => (await send<DishSaveResult>(page, 'post', '/api/dining/dishes', { clientKey: randomUUID(), category: 'E2E 菜品', ...body })).dish;
      const egg = await make({ name: EGG, slot: 'restaurant:餐饮', stationId: hot, prices: { standard: 300 } });
      await make({ name: FISH, slot: 'restaurant:餐饮', stationId: hot, prices: { standard: 3800, premium: 4800 }, addons: [egg.id] });
      const rice = await make({ name: RICE, slot: 'restaurant:餐饮', stationId: hot, prices: { standard: 200 } });
      const cola = await make({ name: COLA, slot: 'water:手作饮料', stationId: bar, prices: { standard: 800 } });
      await make({ name: JUICE, slot: 'water:手作饮料', stationId: bar, prices: { standard: 1200 } });
      await make({
        name: SET,
        slot: 'restaurant:餐饮',
        stationId: hot,
        prices: { standard: 4800 },
        combo: [
          { itemId: rice.id, quantity: 1 },
          { itemId: cola.id, quantity: 1 },
        ],
      });
      await make({ name: FRUIT_A, slot: 'fruit', stationId: hot, prices: { standard: 3800 } });
      await make({ name: FRUIT_B, slot: 'fruit', stationId: hot, prices: { standard: 4800 } });

      await page.goto('/dining');
      await page.getByTestId('dining-tab-dishes').click();
      await expect(page.getByTestId('dishes')).toBeVisible();
      await page.getByTestId('dishes-search').fill(RUN);
      await expect(row(page, FISH)).toBeVisible();

      // ② 做法分组（BW6）：辣度一组、必选；微辣、特辣（加 ¥2）在这一组；免葱不分组
      await page.getByTestId(`dish-edit-${FISH}`).click();
      await expect(page.getByTestId('dish-editor')).toBeVisible();
      await page.getByTestId('dish-group-input').fill('辣度');
      await page.getByTestId('dish-group-add').click();
      await page.getByTestId('dish-group-required-辣度').check();
      for (const name of ['微辣', '特辣', '免葱']) {
        await page.getByTestId('dish-method-input').fill(name);
        await page.getByTestId('dish-method-add').click();
      }
      await page.getByTestId('dish-method-group-微辣').selectOption('辣度');
      await page.getByTestId('dish-method-group-特辣').selectOption('辣度');
      await page.getByTestId('dish-method-price-特辣').fill('2');
      await expect(page.getByTestId('dish-method-特辣')).toContainText('+¥2');
      await expectFits(page);
      await page.getByTestId('dish-save').click();
      await expect(page.getByText(`「${FISH}」已保存`)).toBeVisible();
      const fish = await dishOf(page, FISH);
      expect(fish.methodGroups).toEqual([{ name: '辣度', required: true }]);
      expect(fish.methodOptions).toEqual([
        { name: '微辣', group: '辣度', price: 0 },
        { name: '特辣', group: '辣度', price: 200 },
        { name: '免葱', group: '', price: 0 },
      ]);

      // ③ 套餐可换（BW7）：可乐标「可换」、能换成橙汁、每份补 ¥3
      await page.getByTestId(`dish-edit-${SET}`).click();
      await page.getByTestId(`dish-combo-swappable-${COLA}`).check();
      await page.getByTestId(`dish-combo-swap-${COLA}-search`).fill(JUICE);
      await page.getByTestId(`dish-combo-swap-${COLA}-pick-${JUICE}`).click();
      await page.getByTestId(`dish-combo-swap-diff-${COLA}-${JUICE}`).fill('3');
      await expectFits(page);
      await page.getByTestId('dish-save').click();
      await expect(page.getByText(`「${SET}」已保存`)).toBeVisible();
      await expect(page.getByTestId(`dish-combo-${SET}`)).toContainText(`${COLA}×1（可换 ${JUICE} +¥3）`);
      await expect(row(page, JUICE)).toContainText(`套餐「${SET}」里可换成的菜`);

      // ④ 排序（BW10）：果吧这一类里把果盘乙挪到果盘甲前面
      await page.getByTestId('dishes-sort').click();
      await expect(page.getByTestId('dish-sort')).toBeVisible();
      await page.getByTestId('dish-sort-slot').selectOption('fruit');
      await expect(page.getByTestId(`dish-sort-row-${FRUIT_B}`)).toBeVisible();
      // 这一类里可能还有别的菜：一格一格往上挪，挪到果盘甲前面为止
      const order = async () => (await page.locator('[data-sort-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')))).map((id) => id!.replace('dish-sort-row-', ''));
      while ((await order()).indexOf(FRUIT_B) > (await order()).indexOf(FRUIT_A)) await page.getByTestId(`dish-sort-up-${FRUIT_B}`).click();
      await expectFits(page);
      await page.getByTestId('dish-sort-save').click();
      await expect(page.getByText('「果吧」已排好')).toBeVisible();
      const [a, b] = [await dishOf(page, FRUIT_A), await dishOf(page, FRUIT_B)];
      expect(b.sort).not.toBeNull();
      expect(b.sort!).toBeLessThan(a.sort!);

      // ⑤ 批量下架、上架
      await page.getByTestId(`dish-select-${FRUIT_A}`).check();
      await page.getByTestId(`dish-select-${FRUIT_B}`).check();
      await expect(page.getByTestId('dishes-bulk')).toContainText('已选 2 道');
      await expectFits(page);
      await page.getByTestId('dishes-bulk-off').click();
      await expect(page.getByText('已批量下架 2 道')).toBeVisible();
      await expect(row(page, FRUIT_A)).toHaveAttribute('data-active', 'false');
      await expect(row(page, FRUIT_B)).toHaveAttribute('data-active', 'false');
      await page.getByTestId(`dish-select-${FRUIT_A}`).check();
      await page.getByTestId(`dish-select-${FRUIT_B}`).check();
      await page.getByTestId('dishes-bulk-on').click();
      await expect(page.getByText('已批量上架 2 道')).toBeVisible();
      await expect(row(page, FRUIT_A)).toHaveAttribute('data-active', 'true');

      // ⑥ 删除与恢复：删除 = 下架并隐藏；勾「显示已删除」找回来、恢复（还是下架的）
      await page.getByTestId(`dish-edit-${FRUIT_A}`).click();
      await page.getByTestId('dish-delete').click();
      await page.getByTestId('dish-delete-confirm').click();
      await expect(page.getByText(`「${FRUIT_A}」已删除`)).toBeVisible();
      await expect(row(page, FRUIT_A)).toHaveCount(0);
      await page.getByTestId('dishes-show-deleted').locator('input').check();
      await expect(row(page, FRUIT_A)).toContainText('已删除');
      await page.getByTestId(`dish-restore-${FRUIT_A}`).click();
      await expect(page.getByText(`「${FRUIT_A}」已恢复`)).toBeVisible();
      await expect(row(page, FRUIT_A)).toHaveAttribute('data-active', 'false');
      expect((await dishOf(page, FRUIT_A)).deleted).toBe(false);

      // ⑦ 点单：接待一位男宾 → 点水煮鱼：选优选、必选的辣度没选不能加，选特辣（+¥2）、加蛋 → 点套餐：可乐换橙汁（+¥3）→ 下单
      const tags = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags;
      const tag = tags
        .filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit)
        .map((t) => t.code)
        .reverse()[0]!;
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: 'E2E 菜品补完客人' }] });
      visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;
      await page.getByTestId('dining-tab-order').click();
      await page.getByTestId('dining-tag').fill(tag);
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest')).toContainText('E2E 菜品补完客人');
      await page.getByTestId('dining-outlet-restaurant').click();
      await expect(page.getByTestId(`dining-dish-${SET}`)).toContainText('可选换菜');
      await page.getByTestId(`dining-dish-${FISH}`).click();
      const options = page.getByTestId('dish-options');
      await expect(options).toBeVisible();
      await page.getByTestId('dish-options-tier-premium').click();
      await expect(page.getByTestId('dish-options-group-辣度')).toContainText('必选');
      await expect(page.getByTestId('dish-options-problem')).toHaveText('请先选「辣度」');
      await expect(page.getByTestId('dish-options-add')).toBeDisabled();
      await page.getByTestId('dish-options-method-特辣').click();
      await page.getByTestId(`dish-options-addon-add-${EGG}`).click();
      await expect(page.getByTestId('dish-options-preview')).toContainText('特辣 +¥2');
      await expectFits(page);
      await page.getByTestId('dish-options-add').click();
      await expect(options).toHaveCount(0);
      await expect(page.getByTestId('dining-line-0')).toContainText(`${FISH}（优选）`);
      await expect(page.getByTestId('dining-line-options-0')).toHaveText('特辣 +¥2');
      await expect(page.getByTestId('dining-line-options-1')).toHaveText(`配 ${FISH}`);
      await page.getByTestId(`dining-dish-${SET}`).click();
      await expect(page.getByTestId(`dish-options-swap-${COLA}`)).toBeVisible();
      await page.getByTestId(`dish-options-swap-${COLA}-${JUICE}`).click();
      await expect(page.getByTestId('dish-options-combo')).toContainText(`${JUICE}×1（原 ${COLA}）`);
      await expect(page.getByTestId('dish-options-preview')).toContainText(`${COLA}换${JUICE} +¥3`);
      await expectFits(page);
      await page.getByTestId('dish-options-add').click();
      await expect(page.getByTestId('dining-line-options-2')).toHaveText(`${COLA}换${JUICE} +¥3`);
      await expect(page.getByTestId('dining-line-combo-2')).toContainText(`套餐含 ${RICE}×1、${JUICE}×1（原 ${COLA}）`);
      // 合计：水煮鱼优选 48 + 特辣 2 + 加蛋 3 + 套餐 48 + 换橙汁 3 = 104
      await expect(page.getByTestId('dining-cart')).toContainText('104');
      await page.getByTestId('dining-submit').click();
      await expect(page.getByText(`${tag} 已下单`)).toBeVisible();
      const bill = await getJson<{ lines: { id: number; name: string; unitPrice: number; amount: number; status: string; addonOf?: number | null }[] }>(page, `/api/frontdesk/visits/${visitId}`);
      expect(bill.lines.filter((l) => l.status === 'active').map((l) => `${l.name}|${l.unitPrice}`)).toEqual([`${FISH}（优选）|5000`, `${EGG}|300`, `${SET}|5100`]);

      // ⑧ 厨房屏：可乐换成的橙汁在水吧单独出一张子项单；套餐那一张在热菜，写着水吧那一样做到哪了
      const board = await getJson<KitchenBoard>(page, '/api/kitchen');
      const ticket = board.parts!.find((p: KitchenPartItem) => p.comboName === SET)!;
      const combo = board.items.find((k: KitchenItem) => k.visitId === visitId && k.name === SET)!;
      expect(ticket).toMatchObject({ name: JUICE, swappedFrom: COLA, stationName: BAR, status: 'queued' });
      await page.getByTestId('dining-tab-kitchen').click();
      await page.getByTestId(`kds-station-${BAR}`).click();
      const part = page.getByTestId(`kds-part-${ticket.id}`);
      await expect(part).toContainText(`套餐「${SET}」里的（原 ${COLA}）`);
      await expect(page.getByTestId('kds-col-queued').getByTestId(`kds-part-${ticket.id}`)).toBeVisible();
      await expectFits(page);
      await page.getByTestId(`kds-part-start-${ticket.id}`).click();
      await expect(page.getByTestId('kds-col-cooking').getByTestId(`kds-part-${ticket.id}`)).toBeVisible();
      await page.getByTestId(`kds-part-done-${ticket.id}`).click();
      await expect(page.getByTestId('kds-col-done').getByTestId(`kds-part-${ticket.id}`)).toBeVisible();
      await page.getByTestId(`kds-station-${HOT}`).click();
      await expect(page.getByTestId(`kds-part-tickets-${combo.id}`)).toContainText(`${JUICE}×1 · ${BAR} 已出餐`);
      await expect(page.getByTestId(`kds-${combo.id}`)).toContainText(`${RICE}×1、${JUICE}×1（原 ${COLA}）`);

      // ⑨ 退主菜带加料（BW8）：退水煮鱼时问「它的加料一起退吗」，默认勾上，一起退
      await page.getByTestId('dining-tab-order').click();
      await page.getByTestId('dining-tag').fill(tag);
      await page.getByTestId('dining-find').click();
      const pending = page.getByTestId(`dining-pending-${FISH}（优选）`);
      await expect(pending).toBeVisible();
      await pending.getByRole('button', { name: '退菜' }).click();
      await expect(page.getByTestId('dish-void-addons')).toContainText(EGG);
      await expect(page.getByTestId('dish-void-addons-check')).toBeChecked();
      await page.getByTestId('dish-void-reason').fill('客人不要了');
      await page.getByTestId('dish-void-blame-guest').click();
      await expectFits(page);
      await page.getByTestId('dish-void-confirm').click();
      await expect(page.getByTestId(`dining-pending-${FISH}（优选）`)).toHaveCount(0);
      const after = await getJson<{ lines: { name: string; status: string }[] }>(page, `/api/frontdesk/visits/${visitId}`);
      expect(after.lines.map((l) => `${l.name}|${l.status}`)).toEqual([`${FISH}（优选）|voided`, `${EGG}|voided`, `${SET}|active`]);
    } finally {
      // 收尾：退掉点的菜、客人撤销离店（不结账、不碰钱箱）；这一次建的菜都下架、删除；餐饮功能恢复成开始时的样子
      if (visitId !== null) {
        const v = await getJson<{ lines: { id: number; status: string }[] }>(page, `/api/frontdesk/visits/${visitId}`);
        for (const l of v.lines.filter((x) => x.status === 'active')) await page.request.post(`/api/frontdesk/lines/${l.id}/void`, { data: { reason: 'E2E：菜品补完收尾' } });
        await page.request.post(`/api/frontdesk/visits/${visitId}/cancel`, { data: { reason: 'E2E：菜品补完收尾' } });
      }
      for (const d of (await dishes(page)).filter((x: DishRow) => x.name.endsWith(RUN) && !x.deleted)) {
        await page.request.post(`/api/dining/dishes/${d.id}/delete`, { data: { clientKey: randomUUID(), rev: d.rev } });
      }
      const res = await page.request.put('/api/admin/dining/rules', { data: { enabled: before.enabled, trackServed: before.trackServed } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });

  test('各尺寸：点单弹窗（规格、分组、必选、换菜）、厨房屏的子项单、平板的选做法抽屉放得下（合成数据，只读）', async ({ page }, info) => {
    await login(page, 'linlan');
    const before = ((await (await page.request.get('/api/admin/dining')).json()) as { rules: { enabled: boolean } }).rules;
    if (!before.enabled) await send(page, 'put', '/api/admin/dining/rules', { enabled: true });
    try {
      await mockDining(page);
      // 点单弹窗
      await page.goto('/dining/order');
      await page.getByTestId('dining-outlet-restaurant').click();
      await expect(page.getByTestId(`dining-dish-${SYN_SET.name}`)).toContainText('可选换菜');
      await expectFits(page);
      await page.getByTestId(`dining-dish-${SYN_FISH.name}`).click();
      await expect(page.getByTestId('dish-options')).toBeVisible();
      await expect(page.getByTestId('dish-options-add')).toBeDisabled();
      await page.getByTestId('dish-options-tier-premium').click();
      await page.getByTestId('dish-options-method-特辣').click();
      await page.getByTestId('dish-options-method-少冰').click();
      await expect(page.getByTestId('dish-options-add')).toBeEnabled();
      await expectFits(page);
      await expectOnScreen(page, ['dish-options-add', 'dish-options-tier-premium', 'dish-options-method-加芝士', 'dish-options-qty']);
      await page.keyboard.press('Escape');
      await page.getByTestId(`dining-dish-${SYN_SET.name}`).click();
      await page.getByTestId(`dish-options-swap-${SYN_TEA}-合成杨枝甘露`).click();
      await expect(page.getByTestId('dish-options-preview')).toContainText(`${SYN_TEA}换合成杨枝甘露 +¥6`);
      await expectFits(page);
      await expectOnScreen(page, ['dish-options-add', `dish-options-swap-${SYN_TEA}-合成杨枝甘露`]);
      await page.keyboard.press('Escape');
      // 厨房屏：合成的套餐那一张（带别的档口的进度）与一张子项单
      await page.goto('/dining/kitchen');
      await expect(page.getByTestId(`kds-part-${SYN_PART.id}`)).toContainText(`套餐「${SYN_SET.name}」里的（原 ${SYN_TEA}）`);
      await expect(page.getByTestId(`kds-part-tickets-${SYN_COMBO_TICKET.id}`)).toContainText('合成杨枝甘露×2');
      await expectFits(page);
      // 平板：选做法抽屉（必选的组、换菜）；平板点餐页不在手机上用（docs/DEVICES.md），手机这一组不看
      if (info.project.name === '手机') return;
      await mockEmenu(page);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/emenu');
      await page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => k.startsWith('yuzu.emenu.'))
          .forEach((k) => localStorage.removeItem(k)),
      );
      await page.goto('/emenu');
      await page.getByTestId('emenu-start').click();
      for (const d of '8060') await page.getByTestId(`emenu-key-${d}`).click();
      await page.getByTestId('emenu-field-table').click();
      await page.getByTestId('emenu-key-clear').click();
      for (const d of '01') await page.getByTestId(`emenu-key-${d}`).click();
      await page.getByTestId('emenu-field-guests').click();
      await page.getByTestId('emenu-key-2').click();
      await page.getByTestId('emenu-ask-go').click();
      await expect(page.getByTestId('emenu-header')).toBeVisible();
      await page.getByTestId('emenu-add-1').click();
      await expect(page.getByTestId('emenu-options')).toBeVisible();
      await expect(page.getByTestId('emenu-option-required-辣度')).toBeVisible();
      await expect(page.getByTestId('emenu-options-add')).toBeDisabled();
      await page.getByTestId('emenu-option-特辣').click();
      await expect(page.getByTestId('emenu-options-add')).toContainText('44');
      await noScroll(page);
      await page.getByTestId('emenu-options-add').click();
      await page.getByTestId('emenu-add-2').click();
      await expect(page.getByTestId('emenu-swap-合成柠檬茶')).toBeVisible();
      await page.getByTestId('emenu-swap-option-合成柠檬茶-合成杨枝甘露').click();
      await expect(page.getByTestId('emenu-options-note')).toContainText('合成柠檬茶换合成杨枝甘露 +¥6');
      await noScroll(page);
      await page.getByTestId('emenu-options-add').click();
      await expect(page.getByTestId('emenu-order-count')).toHaveText('2');
      await page.getByTestId('emenu-order-open').click();
      await expect(page.getByTestId('emenu-cart-detail-9001:特辣')).toContainText('特辣 +¥2');
      await expect(page.getByTestId('emenu-cart-detail-9002:~9105>9107')).toContainText('合成柠檬茶换合成杨枝甘露 +¥6');
      await noScroll(page);
    } finally {
      if (!before.enabled) await send(page, 'put', '/api/admin/dining/rules', { enabled: false });
    }
  });
});

// ───────────── 合成数据（只读用例用，代替接口） ─────────────

const SYN_TEA = '合成柠檬茶（大杯）';
const dish = (id: number, name: string, price: number, extra: Partial<MenuDish> = {}): MenuDish => ({
  id,
  name,
  category: '餐饮',
  price,
  stationId: 997_100,
  stationName: '合成热菜',
  remaining: null,
  outlet: 'restaurant',
  group: '餐饮',
  ...extra,
});
const SYN_FISH = dish(997_001, '合成招牌秘制酸菜水煮鱼（大份）', 3800, {
  prices: [
    { tier: 'standard', price: 3800 },
    { tier: 'premium', price: 5800 },
  ],
  methods: ['微辣', '中辣', '特辣', '少冰', '去冰', '免葱', '加芝士'],
  methodOptions: [
    { name: '微辣', group: '辣度', price: 0 },
    { name: '中辣', group: '辣度', price: 0 },
    { name: '特辣', group: '辣度', price: 200 },
    { name: '少冰', group: '冰量', price: 0 },
    { name: '去冰', group: '冰量', price: 0 },
    { name: '免葱', group: '', price: 0 },
    { name: '加芝士', group: '', price: 500 },
  ],
  methodGroups: [
    { name: '辣度', required: true },
    { name: '冰量', required: false },
  ],
  addons: [{ id: 997_003, name: '合成加蛋', price: 300 }],
});
const SYN_SET = dish(997_002, '合成午餐套餐', 6800, {
  combo: [
    { itemId: 997_004, name: '合成米饭', quantity: 1 },
    {
      itemId: 997_005,
      name: SYN_TEA,
      quantity: 2,
      swaps: [
        { itemId: 997_006, name: '合成柚子气泡水', priceDiff: 0, available: true },
        { itemId: 997_007, name: '合成杨枝甘露', priceDiff: 600, available: true },
      ],
    },
  ],
});
const SYN_DISHES = [SYN_FISH, SYN_SET, dish(997_003, '合成加蛋', 300), dish(997_004, '合成米饭', 200)];
const SYN_NOW = new Date().toISOString();
const SYN_COMBO_TICKET: KitchenItem = {
  id: 997_501,
  orderNo: 'K-SYN-01',
  visitId: null,
  tagCode: 'A8060',
  zone: 'male',
  tableSessionId: null,
  tableName: null,
  guest: '合成客人',
  itemId: SYN_SET.id,
  name: SYN_SET.name,
  quantity: 1,
  note: `${SYN_TEA}换合成杨枝甘露 +¥6`,
  deliverTo: '',
  parts: [
    { name: '合成米饭', quantity: 1 },
    { name: '合成杨枝甘露', quantity: 2, from: SYN_TEA },
  ],
  status: 'queued',
  stationId: 997_100,
  stationName: '合成热菜',
  rushCount: 0,
  createdAt: SYN_NOW,
  startedAt: null,
  doneAt: null,
  servedAt: null,
  postedByName: '林岚',
  visitClosed: false,
  orderNote: '',
  deliverRoom: '',
  partTickets: [{ id: 997_601, name: '合成杨枝甘露', quantity: 2, stationId: 997_101, stationName: '合成水吧', status: 'cooking' }],
};
const SYN_PART: KitchenPartItem = {
  id: 997_601,
  kitchenItemId: SYN_COMBO_TICKET.id,
  orderNo: 'K-SYN-01',
  comboName: SYN_SET.name,
  name: '合成杨枝甘露',
  swappedFrom: SYN_TEA,
  quantity: 2,
  stationId: 997_101,
  stationName: '合成水吧',
  status: 'cooking',
  tagCode: 'A8060',
  tableName: null,
  guest: '合成客人',
  note: `${SYN_TEA}换合成杨枝甘露 +¥6`,
  orderNote: '',
  createdAt: SYN_NOW,
  startedAt: SYN_NOW,
  doneAt: null,
  visitClosed: false,
};

/** 点单页的菜单换成合成的；厨房屏取真的，再加一张合成的套餐与它的子项单（只读，写请求不改） */
async function mockDining(page: Page) {
  await page.route('**/api/dining/menu', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...((await res.json()) as DiningMenu), dishes: SYN_DISHES } });
  });
  await page.route('**/api/kitchen', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const real = (await res.json()) as KitchenBoard;
    await route.fulfill({ response: res, json: { ...real, items: [SYN_COMBO_TICKET, ...real.items], parts: [SYN_PART, ...(real.parts ?? [])] } });
  });
}

/** 平板：合成的菜单（一页两道：要选做法的水煮鱼、可换菜的套餐），按手牌找客人、核对桌号；写请求一律掐掉 */
async function mockEmenu(page: Page) {
  const spec = (itemId: number, price: number, options: NonNullable<EmenuMenu['categories'][number]['pages'][number]['dishes'][number]>['specs'][number]['options']) => ({
    itemId,
    label: '',
    labelEn: '',
    price,
    state: 'ok' as const,
    remaining: null,
    options,
  });
  const view = (id: number, name: string, specs: ReturnType<typeof spec>[]) => ({
    id,
    name,
    nameEn: '',
    tagline: '',
    description: '',
    attrs: [],
    unit: '份',
    taglineEn: '',
    descriptionEn: '',
    attrsEn: [],
    unitEn: '',
    imageUrl: null,
    detailUrl: null,
    specs,
  });
  const menu: EmenuMenu = {
    serverTime: new Date().toISOString(),
    businessDate: '2026-11-20',
    enabled: true,
    rules: {
      footerText: 'COPYRIGHT©2026 汤崎 ALL RIGHTS RESERVED',
      avoidOptions: ['不加香菜'],
      serveOptions: ['即起'],
      idleMinutes: 0,
      offHours: 'hide',
      langSwitch: true,
      optionsEn: {},
      motion: true,
      requirePin: true,
      textSize: 'design',
      periods: [...DEFAULT_EMENU_PERIODS],
      coverUrl: null,
    },
    period: { ...DEFAULT_EMENU_PERIODS[1]!, end: DEFAULT_EMENU_PERIODS[2]!.start },
    nextChangeAt: null,
    categories: [
      {
        id: 1,
        name: '午餐',
        nameEn: 'LUNCH',
        periods: [],
        window: null,
        open: true,
        pages: [
          {
            layout: 'duo_row',
            title: '',
            titleEn: '',
            dishes: [
              view(1, '合成水煮鱼', [
                spec(9001, 4200, {
                  methods: [
                    { name: '微辣', group: '辣度', price: 0 },
                    { name: '特辣', group: '辣度', price: 200 },
                    { name: '免葱', group: '', price: 0 },
                  ],
                  groups: [{ name: '辣度', required: true }],
                  addons: [{ itemId: 9003, name: '合成加蛋', price: 300, state: 'ok', remaining: null }],
                }),
              ]),
              view(2, '合成午餐套餐', [
                spec(9002, 6800, {
                  methods: [],
                  groups: [],
                  addons: [],
                  swaps: [
                    {
                      itemId: 9105,
                      name: '合成柠檬茶',
                      quantity: 1,
                      state: 'ok',
                      choices: [
                        { itemId: 9106, name: '合成柚子水', priceDiff: 0, state: 'ok' },
                        { itemId: 9107, name: '合成杨枝甘露', priceDiff: 600, state: 'ok' },
                      ],
                    },
                  ],
                }),
              ]),
            ],
          },
        ],
      },
    ],
    later: [],
    tables: [],
  };
  await page.route('**/api/emenu/**', (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') return route.abort();
    if (url.pathname === '/api/emenu/menu') return route.fulfill({ json: menu });
    if (url.pathname === '/api/emenu/guest') return route.fulfill({ json: { visitId: 1, tagCode: 'A8060', ordered: [], orderedTotal: 0 } });
    if (url.pathname === '/api/emenu/table') return route.fulfill({ json: { tableName: 'A01' } });
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '没有' } } });
  });
}

/** 平板页整页不出滚动条（舞台按 1024×768 等比缩放） */
const noScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
