// 收银完善第一步（v0.7.6）浏览器验收：挂错手牌的明细在账单「更多 → 明细转到别的手牌」里转过去；
// 原手牌上的明细作废并写明转到哪张手牌，目标手牌上新增同样的明细。依赖 seed-demo 与 seed-frontdesk-demo（仅独立演示库）。
// 账号：前台 xiaozhou，密码 yuzu2026。每次挑两张空闲手牌，结束时作废这两位客人的明细并撤销来访，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

interface Line {
  id: number;
  name: string;
  status: 'active' | 'voided';
  amount: number;
  voidReason: string | null;
}

async function visitLines(page: Page, id: number) {
  const r = await page.request.get(`/api/frontdesk/visits/${id}`);
  expect(r.ok()).toBe(true);
  return ((await r.json()) as { lines: Line[] }).lines;
}

/** 收尾：作废还有效的明细、撤销来访（店员自己刚挂的明细可以作废） */
async function clear(page: Page, id: number) {
  const r = await page.request.get(`/api/frontdesk/visits/${id}`);
  if (!r.ok()) return;
  const v = (await r.json()) as { status: string; lines: Line[] };
  if (v.status !== 'open') return;
  for (const l of v.lines.filter((x) => x.status === 'active')) await page.request.post(`/api/frontdesk/lines/${l.id}/void`, { data: { reason: 'E2E：收尾' } });
  await page.request.post(`/api/frontdesk/visits/${id}/cancel`, { data: { reason: 'E2E：收尾' } });
}

test.describe('转单（v0.7.6）', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改数据的流程只在门店电脑尺寸执行一次');

  test('挂错手牌：勾选明细、填目标手牌与原因，转过去后原手牌作废并写明去向，目标手牌多一项', async ({ page }) => {
    await login(page, 'xiaozhou');
    const board = (await (await page.request.get('/api/frontdesk/board')).json()) as {
      tags: { code: string; zone: string; kind: string; active: boolean; locked: boolean; visit: unknown }[];
    };
    const [a, b] = board.tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse();
    const ids: number[] = [];
    try {
      for (const code of [a!, b!]) {
        const r = await page.request.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male' }] } });
        expect(r.ok(), await r.text()).toBe(true);
        ids.push(((await r.json()) as { visits: { id: number }[] }).visits[0]!.id);
      }
      const [va, vb] = ids as [number, number];
      const posted = await page.request.post(`/api/frontdesk/visits/${va}/charges`, {
        data: { clientKey: randomUUID(), lines: [], customLines: [{ name: 'E2E 转单测试', amount: 3800 }], expectedTotal: 3800 },
      });
      expect(posted.ok(), await posted.text()).toBe(true);
      const line = ((await posted.json()) as { lines: Line[] }).lines.find((l) => l.name === 'E2E 转单测试')!;

      await page.goto(`/frontdesk?v=${va}`);
      await expect(page.getByTestId('bill-tag')).toHaveText(a!);
      await page.getByTestId('action-more').click();
      await page.getByRole('menuitem', { name: '明细转到别的手牌' }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: `明细转到别的手牌 · ${a}` });
      await expect(dialog.getByTestId('move-submit')).toBeDisabled();
      await dialog.getByTestId(`move-line-${line.id}`).check();
      await dialog.getByTestId('move-to-tag').fill(b!.toLowerCase());
      await expect(dialog.getByTestId('move-target')).toContainText('在店');
      await dialog.getByRole('button', { name: '挂错手牌', exact: true }).click();
      await expect(dialog.getByTestId('move-summary')).toContainText('转 1 项');
      await expect(dialog.getByTestId('move-summary')).toContainText('¥38.00');
      await dialog.getByTestId('move-submit').click();
      await expect(page.getByText('明细已转到别的手牌')).toBeVisible();
      await expect(dialog).toHaveCount(0);

      expect((await visitLines(page, va)).find((l) => l.id === line.id)).toMatchObject({ status: 'voided', voidReason: `转到手牌 ${b}：挂错手牌` });
      expect((await visitLines(page, vb)).filter((l) => l.status === 'active').map((l) => [l.name, l.amount])).toEqual([['E2E 转单测试', 3800]]);
      await page.goto(`/frontdesk?v=${vb}`);
      await expect(page.getByTestId('bill-tag')).toHaveText(b!);
      await expect(page.getByTestId('bill-panel')).toContainText('E2E 转单测试');
    } finally {
      for (const id of ids) await clear(page, id);
    }
  });
});
