import { defineConfig } from '@playwright/test';

// 只对 scripts/canteen-demo.ts 创建的本机合成实例运行，不接受公网目标。
export default defineConfig({
  testDir: 'employee-e2e', workers: 1, fullyParallel: false, timeout: 120_000,
  expect: { timeout: 12_000 }, reporter: [['list']],
  use: {
    actionTimeout: 15_000, baseURL: 'http://127.0.0.1:18962', locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
});
