// 页面在当前视口内放得下（视口冒烟 R1.6 起用，8.1.7 挪到这里给三台目标设备的用例共用，docs/DEVICES.md）：
// 页面不横向滚动；除了有意横向滚动的区域（表格、标签栏，带 overflow-x-auto / overflow-x-scroll），没有横向滚动区，也没有内容超出屏幕右边。
import { expect, type Page } from '@playwright/test';

/** 列出前几处横向滚动或超出屏幕右边的元素；没有才算过 */
export async function expectFits(page: Page) {
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
