import { defineConfig, devices } from '@playwright/test';

// 浏览器端验收：先启动应用并写入演示数据（npm run seed），再执行 npm run e2e。
// E2E_BASE_URL 可指向已部署的环境；PW_CHROMIUM_PATH 可指定本机已有的 Chromium。
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // 与后端测试同时运行或机器较慢时，登录与提交结果可能超过默认 5 秒
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: '门店电脑', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: '平板横屏', use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 }, hasTouch: true } },
    { name: '平板竖屏', use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, hasTouch: true } },
  ],
});
