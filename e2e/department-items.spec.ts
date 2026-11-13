// 8.0.15 浏览器验收：后台「数据看板 → 经营总览」的部门项目明细（docs/ORDERS_V8015.md 第 3 节）。
// 只读（导出记一条审计），可重复执行；依赖演示数据（仅独立演示库），账号：店主 linlan，密码 yuzu2026。
//   · 表在「部门（项目分类）构成」下面，时段跟着页面上方的选择；
//   · 每个部门各项相加 = 部门构成；合计 = 应收、净营业额（表尾写明）；
//   · 部门行折叠 / 展开、一键全部折叠；导出的 CSV 与页面同一份数。
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

interface Row {
  category: string;
  name: string;
  quantity: number;
  amount: number;
  discount: number;
  refund: number;
}
interface Report {
  from: string;
  to: string;
  days: number;
  kpis: { receivable: number; net: number };
  departments: Omit<Row, 'name'>[];
  items: Row[];
}

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

const yuan = (c: number) => `${c < 0 ? '-' : ''}${Math.trunc(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

/** 做一个会换时段的动作，拿到页面这一次用的那份数据 */
async function reportAfter(page: Page, action: () => Promise<unknown>): Promise<Report> {
  const [res] = await Promise.all([page.waitForResponse((r) => /\/api\/reports\/executive\?/.test(r.url()) && r.status() === 200), action()]);
  return (await res.json()) as Report;
}

/** 页面上的表与这份数据一致，而且三方对得上 */
async function expectTable(page: Page, r: Report) {
  const card = page.getByTestId('overview-items');
  await expect(card).toContainText(`${r.from} 至 ${r.to}`);
  const categories = [...new Set(r.items.map((i) => i.category))];
  // 每个部门各项相加 = 部门构成
  expect(categories).toEqual(r.departments.map((d) => d.category));
  for (const d of r.departments) {
    const rows = r.items.filter((i) => i.category === d.category);
    expect(rows.reduce((s, i) => s + i.amount, 0), d.category).toBe(d.amount);
    expect(rows.reduce((s, i) => s + i.quantity, 0), d.category).toBe(d.quantity);
  }
  expect(r.items.reduce((s, i) => s + i.amount, 0)).toBe(r.kpis.receivable);
  expect(r.items.reduce((s, i) => s + i.amount - i.discount - i.refund, 0)).toBe(r.kpis.net);
  if (r.items.length === 0) {
    await expect(page.getByTestId('overview-items-empty')).toBeVisible();
    return;
  }
  await expect(card.getByTestId('overview-items-group')).toHaveCount(categories.length);
  await expect(card.getByTestId('overview-items-row')).toHaveCount(r.items.length);
  await expect(card.getByTestId('overview-items-group').first()).toHaveAttribute('data-category', categories[0]!);
  await expect(page.getByTestId('overview-items-recon')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('overview-items-recon')).toContainText('= 应收');
  await expect(page.getByTestId('overview-items-recon')).toContainText('= 净营业额');
}

test.describe('8.0.15 经营总览 · 部门项目明细', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '后台看板的流程只在门店电脑尺寸执行一次');

  test('时段联动、与部门构成和净营业额对得上、折叠 / 展开、导出 CSV', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/admin/dashboard');
    const week = await reportAfter(page, () => page.getByTestId('dashboard-tab-overview').click());
    expect(week.days).toBe(7);
    // 演示库这 7 天里有结账：表里有数
    expect(week.items.length).toBeGreaterThan(0);
    const card = page.getByTestId('overview-items');
    await expect(card).toBeVisible();
    // 在「部门（项目分类）构成」下面
    const above = await page.getByTestId('overview-departments').boundingBox();
    const here = await card.boundingBox();
    expect(here!.y).toBeGreaterThan(above!.y);
    await expectTable(page, week);
    for (const head of ['部门', '项目', '销售数量', '销售金额（应收）', '占该部门金额比', '优惠', '退款', '净额']) {
      await expect(card.getByRole('columnheader', { name: head, exact: true })).toBeVisible();
    }
    // 第一行是第一个部门里销售金额最大的项目，占比 = 它的金额 / 部门金额
    const firstCat = week.items[0]!.category;
    const firstDept = week.departments.find((d) => d.category === firstCat)!;
    const share = `${(Math.round((week.items[0]!.amount / firstDept.amount) * 1000) / 10).toFixed(1)}%`;
    const firstRow = card.getByTestId('overview-items-row').first();
    await expect(firstRow).toContainText(week.items[0]!.name);
    await expect(firstRow).toContainText(share);

    // 折叠第一个部门：它的项目收起来，别的不动；再点展开
    const firstGroup = card.getByTestId('overview-items-group').first();
    const inFirst = week.items.filter((i) => i.category === firstCat).length;
    await firstGroup.getByTestId('overview-items-toggle').click();
    await expect(firstGroup).toHaveAttribute('data-open', 'false');
    await expect(card.getByTestId('overview-items-row')).toHaveCount(week.items.length - inFirst);
    await firstGroup.getByTestId('overview-items-toggle').click();
    await expect(card.getByTestId('overview-items-row')).toHaveCount(week.items.length);
    // 一键全部折叠 / 展开：部门小计还在，合计不变
    await page.getByTestId('overview-items-toggle-all').click();
    await expect(card.getByTestId('overview-items-row')).toHaveCount(0);
    await expect(card.getByTestId('overview-items-group')).toHaveCount(week.departments.length);
    await expect(page.getByTestId('overview-items-toggle-all')).toHaveText('全部展开');
    await expect(page.getByTestId('overview-items-total')).toContainText('合计');
    await page.getByTestId('overview-items-toggle-all').click();
    await expect(card.getByTestId('overview-items-row')).toHaveCount(week.items.length);
    await expect(page.getByTestId('overview-items-toggle-all')).toHaveText('全部折叠');

    // 切时段：表跟着变
    const month = await reportAfter(page, () => page.getByRole('radio', { name: '近 30 天' }).click());
    expect(month.days).toBe(30);
    await expect(page.getByTestId('dashboard-overview')).toContainText('30 个营业日');
    await expectTable(page, month);
    const day = await reportAfter(page, () => page.getByRole('radio', { name: '今天' }).click());
    expect(day.days).toBe(1);
    await expectTable(page, day);

    // 导出：跟着页面现在的时段（今天），内容与页面同一份数
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('overview-items-export').click()]);
    // 文件名（部门项目明细_起_止.csv）在集成用例里按响应头核对；这里核对导出的是页面现在的时段
    expect(download.url()).toContain(`/api/reports/executive/items.csv?from=${day.from}&to=${day.to}`);
    const text = await readFile((await download.path())!, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
    expect(lines[0]).toBe('部门,项目,销售数量,销售金额（应收，元）,占该部门金额比,优惠（元）,退款（元）,净额（元）');
    // 表头 + 每个项目一行 + 每个部门一行小计 + 合计 + 两行对照
    expect(lines).toHaveLength(1 + day.items.length + day.departments.length + 3);
    const total = lines.find((l) => l.startsWith('合计,'))!.split(',');
    expect(total[3]).toBe(yuan(day.kpis.receivable));
    expect(total[7]).toBe(yuan(day.kpis.net));
    for (const i of day.items) expect(text).toContain(`${i.category},${i.name},${i.quantity},${yuan(i.amount)},`);
  });
});
