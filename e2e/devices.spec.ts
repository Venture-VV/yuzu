// 硬件连接（飞书需求 RQ-001，v0.7.21，docs/HARDWARE.md）：门店主导航「设备」与后台「设备」。
// 模拟网口打印机与模拟桥在测试进程里开（本机端口），应用连过去：
//   · 测试打印真的到模拟打印机；拔线（关端口）10 秒内页面变离线，插回自动恢复；
//   · 本机终端：连模拟桥，读卡、扫码、模拟键盘输入进记录；选了终端后替桥上报，读卡器在线、拔掉后离线、桥断开离线；
//   · 后台：按采购清单导入、登记、修改、停用。
// 写数据的只在门店电脑尺寸执行；平板尺寸只核对设备页不横向溢出。

import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { startMockBridge } from '../src/server/devices/mock-bridge';
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

async function postJson<T = Record<string, unknown>>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const r = await request.post(url, { data });
  expect(r.ok(), `${url} → ${r.status()} ${await r.text()}`).toBe(true);
  return (await r.json()) as T;
}

/** 停用测试登记的设备：不让应用之后一直去连已经关掉的模拟端口 */
async function disable(request: APIRequestContext, code: string) {
  const list = (await (await request.get('/api/devices')).json()) as { id: number; code: string; version: number; enabled: boolean }[];
  const d = list.find((x) => x.code === code);
  if (d?.enabled) await request.post(`/api/devices/${d.id}/enabled`, { data: { enabled: false, expectedVersion: d.version } });
}

test.describe('设备', () => {
  test('测试打印到模拟打印机；拔线 10 秒内变离线，插回自动恢复', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '写数据的只在门店电脑尺寸执行一次');
    const printer = await startMockPrinter();
    const code = `PRN-E2E-${run}`;
    try {
      await login(page);
      await postJson(page.request, '/api/devices', { clientKey: randomUUID(), code, name: `测试小票机 ${run}`, kind: 'printer', area: '收银', connection: 'network', host: printer.host, port: printer.port });
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '设备', exact: true }).click();
      const row = page.getByTestId(`device-${code}`);
      await expect(row).toHaveAttribute('data-status', 'online', { timeout: 10_000 });

      await row.getByTestId(`device-${code}-test`).click();
      await expect(page.getByText(`测试小票机 ${run}：已打出测试页`)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => printer.texts().some((t) => t.includes('打印测试页') && t.includes(code))).toBe(true);

      // 任务建好之后查结果失败（Codex 自动审查 8a20a54）：断网的接着查、查到照常提示打出；
      // 服务端拒绝了查询的给出任务编号，不说没发出（本机的待确认记录在任务建好时已经删了）
      const pages = () => printer.texts().filter((t) => t.includes('打印测试页')).length;
      await expect(page.getByText(`测试小票机 ${run}：已打出测试页`)).toHaveCount(0, { timeout: 10_000 });
      await page.route('**/api/devices/jobs/*', (route) => route.abort(), { times: 1 });
      await row.getByTestId(`device-${code}-test`).click();
      await expect(page.getByText(`测试小票机 ${run}：已打出测试页`)).toBeVisible({ timeout: 15_000 });
      await expect.poll(pages).toBe(2);
      await page.route('**/api/devices/jobs/*', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '模拟：查询失败' } }) }),
      );
      await row.getByTestId(`device-${code}-test`).click();
      await expect(page.getByText(`测试小票机 ${run}：已提交，查不到结果`)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/打印任务 #\d+（模拟：查询失败）/)).toBeVisible();
      await expect(page.getByText('测试打印没发出')).toHaveCount(0);
      await page.unroute('**/api/devices/jobs/*');
      await expect.poll(pages).toBe(3);

      // 拔线：10 秒内变离线（心跳 2 秒、5 秒没联系上记离线、页面 2 秒刷新）
      await printer.stop();
      const unplugged = Date.now();
      await expect(row).toHaveAttribute('data-status', 'offline', { timeout: 10_000 });
      expect(Date.now() - unplugged).toBeLessThan(10_000);
      await expect(page.getByTestId(`device-${code}-reason`)).toBeVisible();
      // 插回：自动恢复在线
      await printer.start();
      await expect(row).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
    } finally {
      await disable(page.request, code);
      await printer.close();
    }
  });

  test('本机终端：模拟桥读卡、扫码、模拟键盘；选了终端后替桥上报，读卡器拔掉、桥断开都记离线', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '写数据的只在门店电脑尺寸执行一次');
    const terminal = `TRM-E2E-${run}`;
    const other = `TRM-E2E-${run}B`;
    const reader = `RDR-E2E-${run}`;
    // 卡号每次跑都不同：库里留着上一次跑的读卡事件时，按卡号查事件不会混进别的读卡器（main 定时测试 v0.7.29 报的重跑失败）
    const stamp = String(Date.now()).slice(-6);
    const [cardA, cardB, cardC] = [`0012${stamp}`, `0055${stamp}`, `0011${stamp}`];
    const bridge = await startMockBridge({ terminal });
    try {
      await login(page);
      await postJson(page.request, '/api/devices', { clientKey: randomUUID(), code: terminal, name: `测试终端 ${run}`, kind: 'terminal', area: '收银', connection: 'none' });
      await postJson(page.request, '/api/devices', { clientKey: randomUUID(), code: reader, name: `测试读卡器 ${run}`, kind: 'card_reader', area: '收银', connection: 'bridge', hostDeviceCode: terminal, bridgeKey: 'rc300' });
      await page.goto('/devices');
      const panel = page.getByTestId('terminal-panel');
      await panel.getByTestId('terminal-bridge-url').fill(bridge.url);
      await panel.getByTestId('terminal-bridge-connect').click();
      await expect(panel.getByTestId('terminal-bridge-state')).toContainText('设备服务已连上');
      await expect(panel.getByTestId('terminal-device-rc300')).toHaveAttribute('data-status', 'online');
      await panel.getByTestId('terminal-select').selectOption(terminal);

      bridge.sendCard(cardA);
      await expect(panel.getByTestId('terminal-events')).toContainText(cardA);
      bridge.sendScan('6901234567890');
      await expect(panel.getByTestId('terminal-events')).toContainText('6901234567890');
      // 模拟键盘：焦点不在输入框时，很快打完再回车认作一次扫码
      await page.getByRole('heading', { name: '本机终端' }).click();
      await page.keyboard.type('4006001234567', { delay: 5 });
      await page.keyboard.press('Enter');
      await expect(panel.getByTestId('terminal-events')).toContainText('4006001234567');

      // 替桥上报：终端与读卡器在线；读卡事件记到服务端
      await expect(page.getByTestId(`device-${terminal}`)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
      await expect(page.getByTestId(`device-${reader}`)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
      await expect
        .poll(async () => ((await (await page.request.get('/api/devices/events?type=card&limit=50')).json()) as { deviceCode: string; data: { value: string } }[]).some((e) => e.deviceCode === reader && e.data.value === cardA))
        .toBe(true);

      // 读卡器拔掉：离线
      bridge.setDevice('rc300', 'offline', 'DEVICE_OFFLINE');
      await expect(page.getByTestId(`device-${reader}`)).toHaveAttribute('data-status', 'offline', { timeout: 10_000 });
      bridge.setDevice('rc300', 'online');
      await expect(page.getByTestId(`device-${reader}`)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });

      // 同一台电脑开着两个门店页面（Codex 自动审查 8a20a54）：桥把同一次读卡发给两个页面，两个页面都上报，服务端只记一次
      const cardEvents = async (value: string) =>
        ((await (await page.request.get('/api/devices/events?type=card&limit=50')).json()) as { deviceCode: string; data: { value: string } }[]).filter((e) => e.data.value === value);
      const second = await page.context().newPage();
      try {
        await second.goto('/devices');
        const panel2 = second.getByTestId('terminal-panel');
        await expect(panel2.getByTestId('terminal-bridge-state')).toContainText('设备服务已连上');
        await expect.poll(() => bridge.clients()).toBe(2);
        bridge.sendCard(cardB);
        await expect(panel.getByTestId('terminal-events')).toContainText(cardB);
        await expect(panel2.getByTestId('terminal-events')).toContainText(cardB);
        await expect.poll(async () => (await cardEvents(cardB)).length, { timeout: 10_000 }).toBe(1);
        // 两个页面都又报过两轮（每 2 秒一次）：仍然只有一条
        await second.waitForTimeout(4_500);
        expect((await cardEvents(cardB)).map((e) => e.deviceCode)).toEqual([reader]);
      } finally {
        await second.close();
      }

      // 换「这台终端是」：之前收到、还没报出去的读卡不改记到新选的那台（Codex 自动审查 8a20a54）
      await postJson(page.request, '/api/devices', { clientKey: randomUUID(), code: other, name: `测试终端 B ${run}`, kind: 'terminal', area: '收银', connection: 'none' });
      await page.route('**/api/devices/bridge-report', (route) => route.abort());
      bridge.sendCard(cardC);
      await expect(panel.getByTestId('terminal-events')).toContainText(cardC);
      await panel.getByTestId('terminal-select').selectOption(other);
      await page.unroute('**/api/devices/bridge-report');
      await expect(page.getByTestId(`device-${other}`)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });
      expect(await cardEvents(cardC)).toEqual([]);
      await panel.getByTestId('terminal-select').selectOption(terminal);
      await expect(page.getByTestId(`device-${reader}`)).toHaveAttribute('data-status', 'online', { timeout: 10_000 });

      // 设备服务断开：读卡器记离线（终端还开着页面，终端在线）
      await bridge.close();
      await expect(panel.getByTestId('terminal-bridge-state')).toContainText('设备服务没连上');
      await expect(page.getByTestId(`device-${reader}`)).toHaveAttribute('data-status', 'offline', { timeout: 10_000 });
      await expect(page.getByTestId(`device-${reader}-reason`)).toContainText('终端的设备服务没连上');
      await panel.getByTestId('terminal-select').selectOption('');
    } finally {
      await disable(page.request, reader);
      await disable(page.request, terminal);
      await disable(page.request, other);
      await bridge.close().catch(() => {});
    }
  });

  test('后台「设备」：按采购清单导入；登记、修改、停用', async ({ page }, info) => {
    test.skip(info.project.name !== '门店电脑', '写数据的只在门店电脑尺寸执行一次');
    await login(page);
    await page.goto('/admin/devices');
    const importCard = page.getByTestId('device-import');
    await expect(importCard).toBeVisible();
    if (await importCard.getByTestId('device-import-run').isVisible()) {
      await importCard.getByTestId('device-import-run').click();
      await expect(page.getByText(/已按采购清单登记 \d+ 台/)).toBeVisible();
    }
    await expect(importCard).toContainText('清单里的设备都登记了');
    await expect(page.getByTestId('device-row-RDR-JD-01')).toBeVisible();

    const code = `PRN-UI-${run}`;
    await page.getByTestId('device-new').click();
    const dialog = page.getByRole('dialog', { name: '登记设备' });
    await dialog.getByTestId('device-code').fill(code);
    await dialog.getByTestId('device-name').fill(`后台登记 ${run}`);
    await dialog.getByTestId('device-area').selectOption('后厨');
    await dialog.getByTestId('device-host').fill('127.0.0.1');
    await dialog.getByTestId('device-port').fill('9');
    await dialog.getByTestId('device-save').click();
    await expect(page.getByText(`已登记「后台登记 ${run}」（${code}）`)).toBeVisible();
    const row = page.getByTestId(`device-row-${code}`);
    await expect(row).toContainText('后厨');
    await expect(row).toContainText('127.0.0.1:9');

    await row.getByTestId(`device-edit-${code}`).click();
    const edit = page.getByRole('dialog', { name: `修改设备 ${code}` });
    await expect(edit.getByTestId('device-code')).toBeDisabled();
    await edit.getByTestId('device-name').fill(`后台登记 ${run}（改）`);
    await edit.getByTestId('device-save').click();
    await expect(row).toContainText(`后台登记 ${run}（改）`);

    await row.getByTestId(`device-edit-${code}`).click();
    await page.getByRole('dialog', { name: `修改设备 ${code}` }).getByTestId('device-toggle').click();
    await expect(row).toContainText('已停用');
  });

  test('设备页各尺寸不横向溢出', async ({ page }) => {
    await login(page);
    await page.goto('/devices');
    await expect(page.getByTestId('devices-page')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
