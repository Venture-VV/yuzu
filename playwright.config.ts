import { defineConfig, devices } from '@playwright/test';

// 浏览器端验收：先启动应用并写入演示数据（npm run seed），再执行 npm run e2e。
// E2E_BASE_URL 可指向已部署的环境；PW_CHROMIUM_PATH 可指定本机已有的 Chromium。
// 演示数据场景块的核对（v0.7.18）只在 demo-prepare 准备好的演示库上跑：设了 E2E_DEMO_SHOWCASE 才收这个文件（CI「演示数据」job），
// 平时的浏览器验收（只灌五块演示数据）不收，用例总数也不算它
const DEMO_SHOWCASE = 'demo-showcase.spec.ts';
// 退储值「门店系统原路退回」（v0.7.29）要应用开着小程序端口与模拟微信支付（MP_PORT、MP_GATEWAY_KEY、MP_PAY_MOCK=true）：
// 设了 E2E_MP_PORT、E2E_MP_GATEWAY_KEY（与应用的相同）才收这个文件，平时的浏览器验收不收、用例总数也不算它
const MP_REFUND_ONLINE = 'member-refund-online.spec.ts';
const testIgnore = [
  ...(process.env.E2E_DEMO_SHOWCASE ? [] : [`**/${DEMO_SHOWCASE}`]),
  ...(process.env.E2E_MP_PORT && process.env.E2E_MP_GATEWAY_KEY ? [] : [`**/${MP_REFUND_ONLINE}`]),
];

export default defineConfig({
  testDir: 'e2e',
  testIgnore,
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
    // 小屏电脑与手机只跑只读的视口冒烟（会改数据的流程按宽度 ≥ 1280 判断，不在这两个尺寸重复执行）；
    // 房态图（v0.7.16）、对客导览（v0.7.19）的各尺寸用例用合成数据代替接口、只读，也在这两个尺寸跑（写数据的那一条只在门店电脑跑）
    // 管家部（8.0.12）在五个尺寸检查布局，建档与余额写入只在门店电脑组执行。
    { name: '小屏电脑', testMatch: ['viewports.spec.ts', 'floormap.spec.ts', 'locations.spec.ts', 'guide.spec.ts', 'concierge.spec.ts'], use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
    { name: '手机', testMatch: ['viewports.spec.ts', 'floormap.spec.ts', 'locations.spec.ts', 'guide.spec.ts', 'concierge.spec.ts'], use: { ...devices['Pixel 5'] } },
  ],
});
