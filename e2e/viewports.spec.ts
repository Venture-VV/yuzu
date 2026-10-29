// 视口冒烟（R1.6，只读）：除门店电脑 1440×900、平板 1024×768 / 820×1180 外，再看 1280×720 的小屏电脑与手机（393×727）。
// 看板、日结在手机上也要能看（店主用手机查）；前台、交班、会员工作台只在电脑与平板上用。依赖四套演示数据，账号店主 linlan。
// 核对：页面不横向滚动；除了有意横向滚动的区域（表格、标签栏，带 overflow-x-auto），没有横向滚动区，也没有内容超出屏幕右边。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 }); // 刚启动的服务第一次登录可能较慢
}

/** 页面在当前视口内放得下：列出前几处横向滚动或超出屏幕右边的元素 */
async function expectFits(page: Page) {
  // 等弹出、滑入等动画结束再量（循环播放的加载动画除外），量到一半会差一两个像素
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const problems = await page.evaluate(() => {
    const vw = window.innerWidth;
    const scrollsOnPurpose = (el: Element | null) => {
      for (let e = el; e; e = e.parentElement) if (/\boverflow-x-(auto|scroll)\b/.test(e.getAttribute('class') ?? '')) return true;
      return false;
    };
    const name = (el: Element) => {
      const id = el.getAttribute('data-testid');
      return `<${el.tagName.toLowerCase()}${id ? ` data-testid="${id}"` : ''}>「${(el.textContent ?? '').trim().slice(0, 24)}」`;
    };
    const out: string[] = [];
    if (document.documentElement.scrollWidth > vw) out.push(`页面横向滚动：${document.documentElement.scrollWidth} > ${vw}`);
    for (const el of document.querySelectorAll('body *')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const scrollX = (style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
      if (scrollX && !scrollsOnPurpose(el)) out.push(`横向滚动区 ${name(el)}：${el.scrollWidth} > ${el.clientWidth}`);
      else if (r.right > vw + 1 && !scrollsOnPurpose(el.parentElement)) out.push(`超出屏幕右边 ${name(el)}：right ${Math.round(r.right)} > ${vw}`);
    }
    return out.slice(0, 8);
  });
  expect(problems).toEqual([]);
}

test.describe('视口冒烟', () => {
  test('看板：指标卡、近几天营业额、收款构成、当班中', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: '经营看板' })).toBeVisible();
    const board = page.getByTestId('dashboard');
    await expect(board).toContainText('今日营业额');
    await expect(board).toContainText('今日收款构成');
    await expect(board).toContainText('当班中');
    await expectFits(page);
  });

  test('日结：营业口径、余额核对与异常', async ({ page }) => {
    await login(page, 'linlan');
    await page.goto('/settlement');
    await expect(page.getByRole('heading', { name: '日结' })).toBeVisible();
    await expect(page.getByTestId('settlement-business')).toBeVisible();
    await expectFits(page);
  });

  test('前台、交班、会员工作台（电脑与平板）', async ({ page, isMobile }) => {
    test.skip(!!isMobile, '前台、交班、会员工作台只在电脑与平板上用');
    await login(page, 'linlan');
    await expectFits(page);

    await page.goto('/frontdesk');
    await expect(page.getByTestId('tag-board')).toBeVisible();
    await page.getByTestId('tag-A8075').click();
    const panel = page.getByTestId('bill-panel');
    await expect(panel.getByTestId('bill-tag')).toHaveText('A8075');
    // 小票的合计与结账按钮在一屏之内，不用滚动
    const viewport = page.viewportSize()!;
    for (const id of ['bill-total', 'action-checkout']) {
      const box = (await panel.getByTestId(id).boundingBox())!;
      expect(box.x + box.width, id).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height, id).toBeLessThanOrEqual(viewport.height);
    }
    await expectFits(page);

    await page.goto('/shift');
    await expect(page.getByRole('heading', { name: '交班' })).toBeVisible();
    await expectFits(page);
  });
});
