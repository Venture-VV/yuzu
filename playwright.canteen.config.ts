import { defineConfig, devices } from '@playwright/test';

// 员工食堂 · 柚子饭堂的浏览器流程（e2e-canteen/，docs/CANTEEN.md 第 11 节）：要应用开着员工端口（CANTEEN_PORT），
// E2E_BASE_URL 指员工后台（默认 http://localhost:8080），E2E_CANTEEN_URL 指员工端口（默认 http://localhost:8090）。
// 与平时的浏览器验收（playwright.config.ts、e2e/）分开跑，用例总数不算在那边。CI：「员工食堂：手机端浏览器验收」。
export default defineConfig({
  testDir: 'e2e-canteen',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // canteen-lan.local 指到本机：店里局域网 http 打开的样子（对浏览器是不安全的来源，对员工端口是局域网地址，K18）
    launchOptions: { args: ['--host-resolver-rules=MAP canteen-lan.local 127.0.0.1'], ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}) },
  },
  projects: [{ name: '员工食堂', use: { ...devices['Desktop Chrome'] } }],
});
