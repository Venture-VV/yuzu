import { test, expect, chromium, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';

const EMPLOYEE = 'http://127.0.0.1:18962';
const ERP = 'http://127.0.0.1:18961';
const INITIAL = 'Initial-test-2026';
const PASSWORD = 'Browser-test-2026';

async function employeeLogin(page: Page, employeeNo: string) {
  await page.goto(EMPLOYEE);
  await page.getByLabel('工号', { exact: true }).fill(employeeNo);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  const response = page.waitForResponse(r => r.url().endsWith('/api/employee/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '登录员工食堂' }).click();
  if ((await response).status() === 401) {
    await page.getByLabel('密码', { exact: true }).fill(INITIAL);
    await page.getByRole('button', { name: '登录员工食堂' }).click();
  }
  await expect(page.getByRole('heading', { name: '先设置你的密码' }).or(page.getByRole('navigation', { name: '员工导航' }))).toBeVisible();
  if (await page.getByRole('heading', { name: '先设置你的密码' }).isVisible()) {
    await page.getByLabel('临时密码', { exact: true }).fill(INITIAL);
    await page.getByLabel('新密码', { exact: true }).fill(PASSWORD);
    await page.getByLabel('确认新密码', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: '保存新密码' }).click();
  }
  await expect(page.getByRole('navigation', { name: '员工导航' })).toBeVisible();
  await page.getByRole('button', { name: '今日菜单', exact: true }).click();
}
async function managerScanner(page: Page) {
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: /负责人扫码/ }).click();
  await expect(page.getByRole('heading', { name: '扫码打卡', exact: true })).toBeVisible();
}
async function adminLogin(page: Page) {
  await page.goto(ERP + '/erp/canteen');
  await page.getByLabel('账号', { exact: true }).fill('canteen_owner');
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  const response = page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  if ((await response).status() === 401) {
    await page.getByLabel('密码', { exact: true }).fill(INITIAL);
    await page.getByRole('button', { name: '登录', exact: true }).click();
  }
  await expect(page.getByLabel('临时密码', { exact: true }).or(page.getByRole('navigation', { name: '主导航' }))).toBeVisible();
  if (await page.getByLabel('临时密码', { exact: true }).isVisible()) {
    await page.getByLabel('临时密码', { exact: true }).fill(INITIAL);
    await page.getByLabel('新密码', { exact: true }).fill(PASSWORD);
    await page.getByLabel('再次输入新密码', { exact: true }).fill(PASSWORD);
    const changed = page.waitForResponse(r => r.url().includes('/api/auth/') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '保存新密码' }).click();
    await changed;
    await page.goto(ERP + '/erp/canteen');
  }
  await page.goto(ERP + '/erp/canteen');
  await expect(page.getByTestId('canteen-page')).toBeVisible();
}

// 真正的二维码像素进入 Chromium 虚拟摄像头，再由浏览器 ZXing 识别；不替换解码API。
async function qrVideo(code: string, file: string) {
  const qr = QRCode.create(code, { errorCorrectionLevel: 'M' });
  const width = 640, height = 480, scale = 8, size = qr.modules.size;
  const y = Buffer.alloc(width * height, 235), uv = Buffer.alloc(width * height / 2, 128);
  const ox = Math.floor((width - size * scale) / 2), oy = Math.floor((height - size * scale) / 2);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    if (!qr.modules.get(row, col)) continue;
    for (let dy = 0; dy < scale; dy++) y.fill(16, (oy + row * scale + dy) * width + ox + col * scale, (oy + row * scale + dy) * width + ox + (col + 1) * scale);
  }
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv]);
  await writeFile(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`), ...Array.from({ length: 60 }, () => frame)]));
}

test('后台管理、厨师发布、响应丢失恢复、员工出码、图片及摄像头核验、打卡回传', async ({ browser }, info) => {
  const contexts = await Promise.all([
    browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 } }),
    browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }),
    browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }),
    browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }),
  ]);
  const [admin, chef, employee, manager] = await Promise.all(contexts.map(c => c.newPage())) as [Page,Page,Page,Page];
  const errors: string[] = [];
  for (const page of [admin,chef,employee,manager]) page.on('pageerror', e => errors.push(e.message));
  try {
    const health = await employee.request.get(EMPLOYEE + '/api/health');
    expect(await health.json()).toMatchObject({ service: 'employee', instance: 'demo' });
    await adminLogin(admin);
    await expect(admin.getByTestId('canteen-employee-EMP001')).toBeVisible();
    await admin.getByRole('radio', { name: '每日菜单', exact: true }).click();
    await admin.getByTestId('canteen-edit-lunch').click();
    await admin.getByTestId('canteen-menu-title').fill('测试厨房 · 今日午餐');
    await admin.getByTestId('canteen-menu-dishes').fill('番茄炒蛋\n清炒时蔬\n冬瓜排骨汤');
    await admin.getByTestId('canteen-menu-notes').fill('合成菜单；供餐 11:30–13:00');
    await admin.getByTestId('canteen-menu-published').check();
    await admin.getByTestId('canteen-save-menu').click();
    await expect(admin.getByTestId('canteen-menu-lunch')).toContainText('测试厨房 · 今日午餐');
    await employeeLogin(chef, 'CHEF001');
    await chef.getByRole('button', { name: '我的', exact: true }).click();
    await chef.getByRole('button', { name: /菜单管理/ }).click();
    await chef.getByRole('region', { name: '午餐', exact: true }).getByRole('button', { name: '编辑菜单' }).click();
    await chef.getByLabel('菜单标题', { exact: true }).fill('主厨推荐 · 暖心午餐');
    // 服务端已提交，但浏览器拿不到回包；刷新后从同一requestId找回，不重复发布。
    await chef.route('**/api/employee/menus', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    }, { times: 1 });
    await chef.getByRole('button', { name: '保存并发布菜单' }).click();
    await expect(chef.getByRole('region', { name: '结果待确认' })).toBeVisible();
    await chef.reload();
    await chef.getByRole('button', { name: '我的', exact: true }).click();
    await chef.getByRole('button', { name: /菜单管理/ }).click();
    await chef.getByRole('button', { name: '核对结果', exact: true }).click();
    await expect(chef.getByRole('region', { name: '结果待确认' })).toHaveCount(0);
    await expect(chef.getByRole('heading', { name: '主厨推荐 · 暖心午餐' })).toBeVisible();
    await employeeLogin(employee, 'EMP001');
    await expect(employee.getByRole('heading', { name: '主厨推荐 · 暖心午餐' })).toBeVisible();
    await employee.screenshot({ path: info.outputPath('employee-menu-mobile.png'), fullPage: true });
    for (const width of [375, 390, 412, 768]) {
      await employee.setViewportSize({ width, height: 844 });
      expect(await employee.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    }
    await employee.setViewportSize({ width: 390, height: 844 });
    await employeeLogin(manager, 'MGR001');
    await managerScanner(manager);
    await employee.getByRole('button', { name: '员工码', exact: true }).click();
    const qr = employee.getByTestId('employee-qr');
    await expect(qr).toBeVisible();
    const src = await qr.getAttribute('src');
    await manager.getByLabel('选择员工码图片').setInputFiles({ name: 'employee.png', mimeType: 'image/png', buffer: Buffer.from(src!.split(',')[1]!, 'base64') });
    await expect(manager.getByTestId('checkin-success')).toContainText('EMP001');
    await manager.screenshot({ path: info.outputPath('manager-checkin-mobile.png'), fullPage: true });
    const code = await employee.evaluate(async () => (await (await fetch('/api/employee/code')).json()).code as string);
    const video = info.outputPath('employee-code.y4m');
    await qrVideo(code, video);
    const cameraBrowser = await chromium.launch({
      ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
    });
    try {
      const cameraContext = await cameraBrowser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', storageState: await contexts[3]!.storageState(), permissions: ['camera'], viewport: { width: 412, height: 915 } });
      const cameraPage = await cameraContext.newPage();
      await cameraPage.goto(EMPLOYEE);
      await managerScanner(cameraPage);
      await cameraPage.getByRole('button', { name: '打开摄像头', exact: true }).click();
      await expect(cameraPage.getByTestId('checkin-success')).toContainText('EMP001');
      await cameraPage.screenshot({ path: info.outputPath('manager-camera-checkin.png'), fullPage: true });
    } finally { await cameraBrowser.close(); }
    await admin.getByTestId('canteen-sync').click();
    await admin.getByRole('radio', { name: '打卡记录', exact: true }).click();
    await expect(admin.getByTestId('canteen-checkins')).toContainText('EMP001');
    expect(await admin.getByTestId('canteen-checkins').locator('tbody tr').count()).toBeGreaterThanOrEqual(2);
    await admin.screenshot({ path: info.outputPath('canteen-admin-records.png'), fullPage: true });
    await employee.getByRole('button', { name: '我的', exact: true }).click();
    await expect(employee.getByRole('button', { name: /负责人扫码/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});
