// 业务单据打到小票机与断网打印队列（v0.7.28 ⑥，docs/SCHEDULE_FINISH.md 第 7 节）。
// 模拟网口打印机在测试进程里开（本机端口），应用连过去（与 e2e/devices.spec.ts 一样）：
//   · 日结页「打到小票机」：选打印机（本机记住）、打印，提示已打出，模拟打印机收到日结单；
//   · 拔线（关端口）后再打：提示已排队；设备页的打印队列里看得到；插回后心跳恢复在线、自动补打（单子末尾注明补打），队列清空。
// 写数据的只在门店电脑尺寸执行。

import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { startMockPrinter } from '../src/server/devices/mock-printer';

const PASSWORD = 'yuzu2026';
const run = Date.now().toString(36).toUpperCase().slice(-5);

async function login(page: Page, username = 'linlan') {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

/** 打印方式（8.0.7，店主 2026-11-10 默认「本机打印」）：测网口小票机前改成「服务器直连网口小票机」，测完改回 */
async function setPrintMode(request: APIRequestContext, printMode: 'local' | 'network') {
  const r = await request.put('/api/settings', { data: { printMode } });
  expect(r.ok(), `打印方式 → ${r.status()} ${await r.text()}`).toBe(true);
}

/** 停用测试登记的设备：不让应用之后一直去连已经关掉的模拟端口 */
async function disable(request: APIRequestContext, code: string) {
  const list = (await (await request.get('/api/devices')).json()) as { id: number; code: string; version: number; enabled: boolean }[];
  const d = list.find((x) => x.code === code);
  if (d?.enabled) await request.post(`/api/devices/${d.id}/enabled`, { data: { enabled: false, expectedVersion: d.version } });
}

test('日结单打到小票机；拔线时排队，插回后自动补打', async ({ page }, info) => {
  test.skip(info.project.name !== '门店电脑', '写数据的只在门店电脑尺寸执行一次');
  test.setTimeout(90_000);
  const printer = await startMockPrinter();
  const code = `PRN-NP-${run}`;
  const name = `网口小票机 ${run}`;
  try {
    await login(page);
    await setPrintMode(page.request, 'network');
    // 打印方式随会话下发（session.rules）：登录时读到的还是「本机打印」，重新载入页面才拿到新的，「打到小票机」才显示
    await page.reload();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
    const created = await page.request.post('/api/devices', { data: { clientKey: randomUUID(), code, name, kind: 'printer', area: '收银', connection: 'network', host: printer.host, port: printer.port } });
    expect(created.ok(), await created.text()).toBe(true);
    const status = async () => ((await (await page.request.get('/api/print/printers')).json()) as { code: string; status: string }[]).find((p) => p.code === code)?.status;
    await expect.poll(status, { timeout: 10_000 }).toBe('online');

    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '日结', exact: true }).click();
    await page.getByTestId('settlement-netprint').click();
    await expect(page.getByTestId('netprint-dialog')).toBeVisible();
    await page.getByTestId(`netprint-printer-${code}`).click();
    await page.getByTestId('netprint-submit').click();
    await expect(page.getByText(`${name}：已打出日结单（80mm 汇总）`)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => printer.texts().some((t) => t.includes('日 结 单') && t.includes('营业口径'))).toBe(true);

    // 拔线：心跳 5 秒没联系上记离线；再打先排队
    await printer.stop();
    await expect.poll(status, { timeout: 12_000 }).toBe('offline');
    await page.getByTestId('settlement-netprint').click();
    // 本机记住了上次选的打印机：不用再选
    await expect(page.getByTestId(`netprint-printer-${code}`)).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('netprint-wait-hint')).toBeVisible();
    await page.getByTestId('netprint-submit').click();
    await expect(page.getByText(/日结单（80mm 汇总）已排队/)).toBeVisible({ timeout: 15_000 });

    // 设备页的打印队列；插回后自动补打、队列清空
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '设备', exact: true }).click();
    const queue = page.getByTestId('print-queue');
    await expect(queue).toContainText('日结单');
    await expect(queue).toContainText('等打印机恢复');
    const printed = printer.texts().length;
    await printer.start();
    await expect(queue).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => printer.texts().length).toBe(printed + 1);
    expect(printer.texts().at(-1)).toContain('打印机恢复后补打');
  } finally {
    await disable(page.request, code);
    await setPrintMode(page.request, 'local');
    await printer.close();
  }
});
