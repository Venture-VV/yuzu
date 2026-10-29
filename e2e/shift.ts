import type { Page } from '@playwright/test';

/**
 * R1.2 起默认「收款前必须先开班」：已登录的员工还没有当班班次时开一个（备用金 0），已经开班（409 SHIFT_OPEN）时跳过。
 * 只在会收款（充值、结账）的用例里调用；开班本身的页面流程见 r1-funds.spec.ts。
 */
export async function ensureShift(page: Page) {
  const res = await page.request.post('/api/shifts', { data: { openingCash: 0 } });
  if (res.status() !== 200 && res.status() !== 409) throw new Error(`开班失败：${res.status()} ${await res.text()}`);
}
