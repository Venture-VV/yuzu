// v0.7.28 ④ 浏览器验收：次卡。8.0.4 起「价目与套餐」取消了次卡、默认停售（需求表 03）：后台没有次卡页签，会员页没有「售次卡」；
// 已售的次卡照常结账核销。这里临时打开售卡（接口）售一张，再关上，验证已售的卡照常用：前台结账时「用次卡」抵一次、其余现金 →
// 卡上剩的次数减一，结账单的收款里有「次卡」。依赖四套演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';
const ITEM = 'E2E 次卡足疗';
const TYPE = 'E2E 足疗 3 次卡';

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

async function postJson<T>(page: Page, url: string, data: unknown): Promise<T> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

type CardType = { id: number; name: string; active: boolean };
type Card = { id: number; cardNo: string; name: string; remaining: number; totalUses: number; status: string };

test.describe('v0.7.28 次卡', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会收款的流程只在门店电脑尺寸执行一次');
  test.setTimeout(180_000);

  test('价目与套餐没有次卡、停售时没有售卡入口；已售的次卡结账照常抵一次、其余现金 → 剩的次数减一', async ({ page }) => {
    await login(page, 'linlan');
    await ensureShift(page);
    // ① 专用项目（没有就建）
    type Item = { id: number; name: string; active: boolean };
    let item = (await getJson<{ items: Item[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM);
    if (!item || !item.active) {
      const body = { name: ITEM, category: 'E2E 次卡', price: 19800 };
      await (item ? page.request.put(`/api/items/${item.id}`, { data: { ...body, active: true } }) : page.request.post('/api/items', { data: body }));
      item = (await getJson<{ items: Item[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM)!;
    }

    // ② 后台「价目与套餐」不再有次卡（8.0.4）；卡种用接口建（上一次留下的就不再建）
    await page.goto('/admin/catalog');
    await expect(page.getByRole('heading', { name: '价目与套餐' })).toBeVisible();
    await expect(page.getByTestId('count-card-types')).toHaveCount(0);
    if (!(await getJson<CardType[]>(page, '/api/count-card-types')).some((t) => t.name === TYPE && t.active)) {
      await postJson(page, '/api/admin/count-card-types', { name: TYPE, itemIds: [item.id], uses: 3, price: 45000 });
    }
    const type = (await getJson<CardType[]>(page, '/api/count-card-types')).find((t) => t.name === TYPE && t.active)!;

    // ③ 停售时：没有卡的会员，会员页不显示次卡，也没有「售次卡」；接口拒绝
    const phone = `194${String(Date.now()).slice(-8)}`;
    const m = await postJson<{ id: number }>(page, '/api/members', { name: 'E2E 次卡会员', phone });
    await page.goto(`/?m=${m.id}`);
    await expect(page.getByTestId('member-registered')).toBeVisible();
    await expect(page.getByTestId('member-count-cards')).toHaveCount(0);
    await expect(page.getByTestId('count-card-sell-open')).toHaveCount(0);
    // 已售的卡：临时打开售卡、在会员页售一张（现金 ¥450），再关上
    expect((await page.request.put('/api/settings', { data: { countCardSales: true } })).ok()).toBe(true);
    try {
      await page.reload();
      const open = page.getByTestId('member-count-cards');
      await open.getByTestId('count-card-sell-open').click();
      await page.getByTestId('count-card-type').selectOption(String(type.id));
      await page.getByTestId('count-card-sell-submit').click();
      await expect(open).toContainText('剩 3 / 3 次');
    } finally {
      expect((await page.request.put('/api/settings', { data: { countCardSales: false } })).ok()).toBe(true);
    }
    const [card] = await getJson<Card[]>(page, `/api/members/${m.id}/count-cards`);
    expect(card).toMatchObject({ name: TYPE, remaining: 3, status: 'active' });
    // 停售以后：卡照常列出，没有「售次卡」
    await page.reload();
    const box = page.getByTestId('member-count-cards');
    await expect(box).toContainText('剩 3 / 3 次');
    await expect(box.getByTestId('count-card-sell-open')).toHaveCount(0);

    // ④ 接待这位会员、挂一份足疗，前台结账「用次卡」抵一次，其余现金
    const board = await getJson<{ tags: { code: string; zone: string; kind: string; active: boolean; locked: boolean; visit: unknown }[] }>(page, '/api/frontdesk/board');
    const tag = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).at(-5)!.code;
    const checkin = await postJson<{ visits: { id: number }[] }>(page, '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', memberId: m.id }] });
    const visitId = checkin.visits[0]!.id;
    await postJson(page, `/api/frontdesk/visits/${visitId}/charges`, { clientKey: randomUUID(), lines: [{ itemId: item.id, quantity: 1 }], expectedTotal: 19800 });
    await page.goto(`/frontdesk?v=${visitId}`);
    await page.getByTestId('bill-panel').getByTestId('action-checkout').click();
    await expect(page.getByTestId('checkout-total')).toBeVisible();
    const panel = page.getByTestId('checkout-count-cards');
    await expect(panel).toContainText(TYPE);
    await panel.getByTestId(`checkout-count-card-add-${card!.cardNo}`).click();
    await expect(panel.getByTestId(`checkout-count-card-uses-${card!.cardNo}`)).toHaveText('1');
    await expect(panel).toContainText('¥198.00');
    await page.getByTestId('pay-add-cash').click();
    await page.getByTestId('checkout-submit').click();
    await expect(page.getByText(/已结清 · /)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('checkout-finish').click();

    // ⑤ 卡上剩 2 次；结账单的收款里有「次卡」¥198
    const [after] = await getJson<Card[]>(page, `/api/members/${m.id}/count-cards`);
    expect(after).toMatchObject({ remaining: 2, status: 'active' });
    const list = await getJson<{ id: number; tagCodes: string[] }[]>(page, '/api/frontdesk/checkouts');
    const done = await getJson<{ payments: { method: string; amount: number }[] }>(page, `/api/frontdesk/checkouts/${list.find((c) => c.tagCodes.includes(tag))!.id}`);
    expect(done.payments.find((p) => p.method === 'count_card')).toMatchObject({ amount: 19800 });
  });
});
