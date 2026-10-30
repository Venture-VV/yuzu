// v0.7.1 浏览器验收：钟房。前台在钟房派点钟并立即上钟 → 倒计时 → 加钟（记为点钟）→ 下钟；
// 派轮钟（不立即上钟）→ 待上钟 → 取消派钟，技师回到原位；钟房日志有记录 → 结账后「技师业绩」有提成、能导出提成明细。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
// 与 technicians.spec 共用「E2E 技师足疗」项目与 E8 号技师（另加 E9 号）；钟房规则先恢复默认；结束时关闭技师功能，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_CLOCKROOM_RULES, DEFAULT_COMMISSION_RULES, type ClockroomBoard, type CommissionSettings } from '../src/shared/clockroom';

const PASSWORD = 'yuzu2026';
const ITEM = 'E2E 技师足疗';
const TECHS = [
  { techNo: 'E8', name: 'E2E 小林', gender: 'female', grade: 'professional' },
  { techNo: 'E9', name: 'E2E 小周', gender: 'female', grade: 'standard' },
] as const;

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

async function send(page: Page, method: 'post' | 'put', url: string, data?: unknown) {
  const res = await page.request[method](url, data === undefined ? {} : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return res;
}

interface BoardTag {
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number } | null;
}
type Tech = { id: number; techNo: string; name: string; gender: string; grade: string; skills: string[]; active: boolean };

test.describe('v0.7.1 钟房', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改规则的流程只在门店电脑尺寸执行一次');
  test.setTimeout(180_000);

  test('派点钟立即上钟 → 加钟 → 下钟；派轮钟 → 取消回原位；钟房日志；结账后有提成与提成明细', async ({ page }) => {
    await login(page, 'linlan');
    try {
      // ① 店主准备：专用项目（三档价格、需要技师）、两位技师、技师功能开启（按等级取价）、钟房规则恢复默认
      const itemBody = { name: ITEM, category: 'E2E 技师', prices: { standard: 19800, professional: 23800, premium: 29800 } };
      let item = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM);
      if (!item || !item.active) {
        await (item ? send(page, 'put', `/api/items/${item.id}`, { ...itemBody, active: true }) : send(page, 'post', '/api/items', itemBody));
        item = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM)!;
      }
      await send(page, 'put', '/api/admin/technicians/items', { items: [{ id: item.id, required: true }] });
      const roster = (await getJson<{ technicians: Tech[] }>(page, '/api/admin/technicians')).technicians;
      for (const t of TECHS) {
        const old = roster.find((x) => x.techNo === t.techNo);
        if (!old) await send(page, 'post', '/api/admin/technicians', t);
        else if (!old.active || old.grade !== t.grade || old.skills.length > 0) await send(page, 'put', `/api/admin/technicians/${old.id}`, { name: old.name, gender: old.gender, grade: t.grade, skills: [], active: true });
      }
      await send(page, 'put', '/api/admin/technicians/rules', { enabled: true, tierByGrade: true });
      const admin = await getJson<{ clockroomRules: typeof DEFAULT_CLOCKROOM_RULES }>(page, '/api/admin/technicians');
      if (JSON.stringify(admin.clockroomRules) !== JSON.stringify({ ...admin.clockroomRules, ...DEFAULT_CLOCKROOM_RULES })) {
        await send(page, 'put', '/api/admin/technicians/clockroom-rules', DEFAULT_CLOCKROOM_RULES);
      }
      const commission = await getJson<CommissionSettings>(page, '/api/admin/technicians/commission');
      // 后台「钟房与轮钟」「技师提成」两张卡片都在
      await page.goto('/admin/technicians');
      await expect(page.getByTestId('clockroom-rules-card')).toContainText('被退钟、取消派钟');
      await expect(page.getByTestId('commission-card')).toContainText('技师提成');
      await expect(page.getByTestId('commission-sample')).toContainText(ITEM);
      await page.request.post('/api/auth/logout');

      // ② 前台：两位 E2E 技师上牌（休息的回牌）；上一轮没走完的钟先了结
      await login(page, 'xiaozhou');
      let board = await getJson<ClockroomBoard>(page, '/api/clockroom');
      const mine = board.technicians.filter((t) => TECHS.some((x) => x.techNo === t.techNo));
      expect(mine).toHaveLength(2);
      for (const s of board.sessions.filter((x) => mine.some((t) => t.id === x.technicianId))) {
        if (s.status === 'serving') await send(page, 'post', `/api/clockroom/sessions/${s.id}/finish`);
        else await send(page, 'post', `/api/clockroom/sessions/${s.id}/void`, { reason: 'E2E：上一轮没走完' });
      }
      for (const t of mine) {
        if (t.state === 'off') await send(page, 'post', `/api/clockroom/technicians/${t.id}/state`, { action: 'sign_in' });
        if (t.state === 'rest') await send(page, 'post', `/api/clockroom/technicians/${t.id}/state`, { action: 'back' });
      }
      const tags = await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board');
      const tag = tags.tags.filter((t) => t.zone === 'female' && t.kind === 'normal' && t.active && !t.locked && !t.visit).map((t) => t.code).reverse()[0]!;
      await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'female', guestLabel: 'E2E 钟房客人' }] });
      const visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;

      // ③ 钟房：派点钟给 E8（专业技师按专业档 238），技师到了立即上钟
      await page.goto('/');
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '钟房' }).click();
      await expect(page.getByTestId('clock-queue')).toContainText('E8');
      await page.getByTestId('clock-dispatch').click();
      const dispatch = page.getByRole('dialog', { name: '派钟' });
      await dispatch.getByTestId('dispatch-tag').fill(tag);
      await dispatch.getByTestId(`dispatch-item-${ITEM}`).click();
      await dispatch.getByRole('radiogroup', { name: '上钟方式' }).getByRole('radio', { name: '点钟' }).click();
      await dispatch.getByTestId('dispatch-tech-E8').click();
      await expect(dispatch).toContainText('238.00');
      await expect(dispatch.getByTestId('dispatch-submit')).toHaveText('派钟并上钟');
      await dispatch.getByTestId('dispatch-submit').click();
      await expect(dispatch).toBeHidden();
      const serving = page.getByTestId(/^clock-serving-/).filter({ hasText: tag });
      await expect(serving).toContainText('E8');
      await expect(serving).toContainText('点钟');
      await expect(serving.getByTestId(/^clock-timer-/)).toHaveText(/^\d{1,2}:\d\d$/);

      // ④ 加钟：原技师继续，记为点钟；钟数与时长累加
      await serving.getByTestId(/^clock-extend-/).click();
      const extend = page.getByRole('dialog', { name: /加钟/ });
      await expect(extend).toContainText('238.00');
      await extend.getByTestId('extend-submit').click();
      await expect(extend).toBeHidden();
      await expect(serving).toContainText(`${ITEM} × 2`);
      await expect(serving).toContainText('120 分钟');
      let lines = (await getJson<{ lines: { status: string; amount: number; technician: { techNo: string; callType: string } | null }[] }>(page, `/api/frontdesk/visits/${visitId}`)).lines;
      const techLines = lines.filter((l) => l.status === 'active' && l.technician?.techNo === 'E8');
      expect(techLines.map((l) => [l.amount, l.technician!.callType])).toEqual([
        [23800, 'designated'],
        [23800, 'designated'],
      ]);

      // ⑤ 下钟：钟卡消失，E8 回到队列（点钟不动牌）
      await serving.getByTestId(/^clock-finish-/).click();
      await expect(serving).toHaveCount(0);
      await expect(page.getByText('E8 号下钟')).toBeVisible();

      // ⑥ 派轮钟（技师还没到，不立即上钟）→ 待上钟 → 取消派钟，技师回到原位
      board = await getJson<ClockroomBoard>(page, '/api/clockroom');
      await page.getByTestId('clock-dispatch').click();
      await dispatch.getByTestId('dispatch-tag').fill(tag);
      await dispatch.getByTestId(`dispatch-item-${ITEM}`).click();
      await dispatch.getByRole('radiogroup', { name: '上钟方式' }).getByRole('radio', { name: '轮钟' }).click();
      // 轮钟列表按排位，第一个就是该派的（默认已选中）
      const first = dispatch.getByTestId('dispatch-techs').getByRole('button').first();
      await expect(first).toContainText(/第 \d+ 位/);
      const firstNo = (await first.getAttribute('data-testid'))!.replace('dispatch-tech-', '');
      const before = board.technicians.find((t) => t.techNo === firstNo)!;
      await dispatch.getByLabel('技师到了，立即上钟').uncheck();
      await expect(dispatch.getByTestId('dispatch-submit')).toHaveText('派钟');
      await dispatch.getByTestId('dispatch-submit').click();
      await expect(dispatch).toBeHidden();
      const waiting = page.getByTestId(/^clock-waiting-/).filter({ hasText: tag });
      await expect(waiting).toContainText(firstNo);
      await expect(waiting).toContainText('轮钟');
      await waiting.getByTestId(/^clock-cancel-/).click();
      await page.getByTestId('reason-input').fill('E2E：客人不做了');
      await page.getByTestId('reason-confirm').click();
      await expect(waiting).toHaveCount(0);
      await expect(page.getByText('已取消派钟')).toBeVisible();
      const after = (await getJson<ClockroomBoard>(page, '/api/clockroom')).technicians.find((t) => t.techNo === firstNo)!;
      expect(after.position).toBe(before.position);
      lines = (await getJson<{ lines: { status: string; amount: number; technician: { techNo: string; callType: string } | null }[] }>(page, `/api/frontdesk/visits/${visitId}`)).lines;
      expect(lines.filter((l) => l.status === 'voided' && l.technician?.techNo === firstNo)).toHaveLength(1);

      // ⑦ 钟房日志：派钟、上钟、加钟、下钟、取消派钟都有记录
      await page.getByTestId('clock-log-open').click();
      const log = page.getByTestId('clock-log');
      for (const kind of ['派钟', '上钟', '加钟', '下钟', '取消派钟']) await expect(log).toContainText(kind);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

      // ⑧ 结账（现金）；收款前没开班时临时开一个，结完按应有现金交掉
      const preview = await getJson<{ totalAmount: number }>(page, `/api/frontdesk/checkout-preview?ids=${visitId}`);
      const opened = (await page.request.post('/api/shifts', { data: { openingCash: 0 } })).status() === 200;
      const paid = await send(page, 'post', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [visitId], expectedTotal: preview.totalAmount, payments: [{ method: 'cash', amount: preview.totalAmount }] });
      const checkoutNo = ((await paid.json()) as { checkoutNo: string }).checkoutNo;
      if (opened) {
        const { shift } = await getJson<{ shift: { id: number; summary: { cash: { expected: number } } } }>(page, '/api/shifts/current');
        const expected = shift.summary.cash.expected;
        await send(page, 'post', `/api/shifts/${shift.id}/close`, { countedCash: expected, expectedCash: expected, note: 'E2E：钟房流程临时开的班' });
      }
      await page.request.post('/api/auth/logout');

      // ⑨ 店主看技师业绩：有提成合计；导出的提成明细里有这张结账单的两钟（默认规则：售价 40% + 点钟每钟 ¥10）
      await login(page, 'linlan');
      await page.goto('/dashboard/technicians');
      await expect(page.getByTestId('technicians-commission')).toBeVisible();
      await expect(page.getByTestId('technicians-row-E8')).toBeVisible();
      const today = (await getJson<{ today: string }>(page, '/api/auth/me')).today;
      const csv = await (await page.request.get(`/api/reports/technicians/commission.csv?from=${today}&to=${today}`)).text();
      const rows = csv.split(/\r?\n/).filter((l) => l.includes(checkoutNo) && l.includes('E8'));
      expect(rows).toHaveLength(2);
      if (JSON.stringify(commission.current.rules) === JSON.stringify(DEFAULT_COMMISSION_RULES)) {
        for (const row of rows) expect(row).toContain('95.20,10.00,105.20');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    } finally {
      // 关闭技师功能（不影响其他流程）；技师与专用项目留着，下次沿用
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      const res = await page.request.put('/api/admin/technicians/rules', { data: { enabled: false } });
      expect(res.ok(), await res.text()).toBe(true);
    }
  });
});
