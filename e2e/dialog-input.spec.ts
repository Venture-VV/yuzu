// 对话框打开后马上输入（手快、扫码枪）：刚输入的内容不会被打开窗口时的清空盖掉
// （Codex 复测 PR #18 的 P2 是派钟窗口；店主 2026-10-30 定所有对话框一起改，见 src/client/lib/useResetOnOpen.ts）。
// 在同一段脚本里点开对话框、等这次点击渲染出来（微任务）后立即输入，不让出给之后的任务，再等 300ms 读回。只打开、不提交。
// 依赖四套演示数据（仅独立演示库）；账号：店员 xiaozhou，密码 yuzu2026。
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

/** 点开对话框（opener：按钮的 CSS 选择器，或「text=按钮文字」）后马上在 input 里输入 value，300ms 后读回 */
async function typeRightAfterOpen(page: Page, opener: string, input: string, value: string) {
  return page.evaluate(
    async ([openerSel, inputSel, text]) => {
      const button = openerSel.startsWith('text=')
        ? [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === openerSel.slice(5))
        : document.querySelector<HTMLElement>(openerSel);
      if (!button) return { error: `找不到 ${openerSel}` };
      button.click();
      for (let k = 0; k < 10 && !document.querySelector(inputSel); k++) await Promise.resolve();
      const field = document.querySelector<HTMLInputElement>(inputSel);
      if (!field) return { error: `点开后没有 ${inputSel}` };
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { value: document.querySelector<HTMLInputElement>(inputSel)?.value ?? null };
    },
    [opener, input, value] as const,
  );
}

test.describe('对话框打开后马上输入', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '只在门店电脑尺寸执行一次');

  test('新建会员、前台接待：点开后马上输入的姓名、牌号都还在', async ({ page }) => {
    await login(page, 'xiaozhou');

    // 会员工作台「新建会员」：姓名
    await page.goto('/');
    await expect(page.getByRole('button', { name: '新建会员' }).first()).toBeVisible();
    for (let i = 0; i < 5; i++) {
      const r = await typeRightAfterOpen(page, 'text=新建会员', '#m-name', '快速输入');
      expect(r, `新建会员第 ${i + 1} 次`).toEqual({ value: '快速输入' });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }

    // 前台：点空闲手牌打开接待，牌号预先填好；马上改成别的牌号，不会被打开时的预填盖回去
    await page.goto('/frontdesk');
    await expect(page.getByTestId('tag-board')).toBeVisible();
    for (let i = 0; i < 5; i++) {
      const r = await typeRightAfterOpen(page, '[data-testid^="tag-"][data-state="free"]', '[aria-label="第 1 位牌号"]', 'ZZ999');
      expect(r, `接待第 ${i + 1} 次`).toEqual({ value: 'ZZ999' });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });
});
