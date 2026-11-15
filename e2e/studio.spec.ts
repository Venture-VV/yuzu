// 8.1.1 UI 工作台的浏览器验收（docs/WORKBENCH_V811.md 第 10 节）：只在「门店电脑」这一组执行。
//   店主建（或重置）设计师账号 e2esheji → 设计师第一次登录先改密码，之后直接到后台的「工作台」→ 打开编辑器（起始页画的就是平板的样子）→
//   拖动字标、撤销重做 → 插入文字、写中英文 → 主题换强调色 → 自动保存 → 检查没有红的 → 发布 → 版本列表里有这一版 →
//   平板的菜单接口带上这一版、预览码打开看得到那行字 → 用完照内置的默认版面再发一版（演示库的平板照旧是原来的样子）、停用 e2esheji。
// 只要 seed-demo 的店主 linlan（密码 yuzu2026），不依赖 demo-prepare；演示库的设计师 sheji 留给人手工试，用例不碰它。
// 只在独立演示库。可重复执行（e2esheji 下次启用、重置密码接着用）。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { defaultStudioDoc, type StudioState, type StudioVersionView } from '../src/shared/studio';

const PASSWORD = 'yuzu2026';
const DESIGNER = { username: 'e2esheji', displayName: 'E2E 设计师', password: 'E2e-sheji-2026' };

interface StaffRecord {
  id: number;
  username: string;
  displayName: string;
  role: string;
  active: boolean;
}

async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.getByRole('button', { name: '登录' }).click();
}

async function getJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function send<T = unknown>(page: Page, method: 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const res = await page.request[method](url, data === undefined ? {} : { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** 店主：设计师账号 e2esheji（没有就建，停用的、岗位不对的改回来），每次都重置出一个临时密码 */
async function prepareDesigner(owner: Page): Promise<{ id: number; temporaryPassword: string }> {
  let found = (await getJson<StaffRecord[]>(owner, '/api/staff')).find((s) => s.username === DESIGNER.username);
  if (!found) {
    await send(owner, 'post', '/api/staff', { username: DESIGNER.username, displayName: DESIGNER.displayName, role: 'designer', duties: [] });
    found = (await getJson<StaffRecord[]>(owner, '/api/staff')).find((s) => s.username === DESIGNER.username)!;
  } else if (!found.active || found.role !== 'designer') {
    await send(owner, 'put', `/api/staff/${found.id}`, { displayName: DESIGNER.displayName, role: 'designer', duties: [], active: true });
  }
  const { temporaryPassword } = await send<{ temporaryPassword: string }>(owner, 'post', `/api/staff/${found.id}/reset-password`);
  return { id: found.id, temporaryPassword };
}

/** 把草稿放回内置的默认版面（上一次没走完、或别的用例改过的不要） */
async function resetDraft(page: Page) {
  const s = await getJson<StudioState>(page, '/api/studio/emenu');
  await send(page, 'put', '/api/studio/emenu/draft', { rev: s.draft.rev, doc: defaultStudioDoc('emenu') });
}

test.describe('8.1.1 UI 工作台', () => {
  test('设计师改起始页、换主题色、发布；平板的菜单带上这一版、预览码看得到；用完回到默认版面', async ({ page, browser, baseURL }, info) => {
    test.skip(info.project.name !== '门店电脑', '整套流程只在门店电脑这一组跑一次');
    test.setTimeout(180_000);
    const stamp = randomUUID().slice(0, 6);
    const words = `E2E 冬日限定 ${stamp}`;

    // 店主（平板那一段也用这个窗口）：准备设计师账号
    const owner = await browser.newContext({ baseURL, viewport: { width: 1024, height: 768 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const pad = await owner.newPage();
    await login(pad, 'linlan');
    await expect(pad.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
    const designer = await prepareDesigner(pad);
    try {
      // 设计师第一次登录先改密码，之后直接到后台的「工作台」，侧栏只有这一个分区
      await login(page, DESIGNER.username, designer.temporaryPassword);
      await expect(page.getByRole('heading', { name: '设置你的密码' })).toBeVisible({ timeout: 30_000 });
      await page.fill('#cur', designer.temporaryPassword);
      await page.fill('#new', DESIGNER.password);
      await page.fill('#confirm', DESIGNER.password);
      await page.getByRole('button', { name: '保存新密码' }).click();
      await expect(page).toHaveURL(/\/admin\/studio$/, { timeout: 30_000 });
      await expect(page.getByTestId('studio-section')).toBeVisible();
      await expect(page.getByRole('link', { name: '电子菜单' })).toHaveCount(0);
      // 别的页面、接口进不去
      expect((await page.request.get('/api/members?q=1')).status()).toBe(403);
      expect((await page.request.get('/api/emenu/guest?tag=1')).status()).toBe(403);

      await resetDraft(page);
      await page.getByTestId('studio-open-emenu').click();
      await expect(page.getByTestId('studio-canvas')).toBeVisible();
      await expect(page.getByTestId('studio-save-status')).toHaveAttribute('data-status', 'saved');
      // 起始页的图层：默认版面的五块
      await expect(page.getByTestId('studio-layer-start-logo')).toBeVisible();
      await expect(page.getByTestId('studio-layer-start-footer')).toContainText('必需');

      // 拖动字标：画布上按住字标往左上拖
      const layer = (await page.getByTestId('studio-canvas-layer').boundingBox())!;
      const k = layer.width / 1024;
      const from = { x: layer.x + (472.6 + 39) * k, y: layer.y + (342.8 + 38) * k };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x - 160 * k, from.y - 120 * k, { steps: 10 });
      await page.mouse.up();
      await expect(page.getByTestId('studio-selected-start-logo')).toBeVisible();
      const x = Number(await page.getByTestId('studio-prop-x').inputValue());
      expect(x).toBeLessThan(400);
      // 撤销一步回到原位、重做再回来
      await page.getByTestId('studio-undo').click();
      await expect(page.getByTestId('studio-prop-x')).toHaveValue('472.6');
      await page.getByTestId('studio-redo').click();
      await expect(page.getByTestId('studio-prop-x')).toHaveValue(String(x));

      // 插入文字、写中英文
      await page.getByTestId('studio-tab-insert').click();
      await page.getByTestId('studio-insert-text').click();
      await page.getByTestId('studio-text-zh').fill(words);
      await page.getByTestId('studio-text-en').fill(`E2E Winter ${stamp}`);
      await expect(page.locator('[data-testid="studio-canvas"] [data-studio-text]', { hasText: words })).toBeVisible();

      // 主题：强调色
      await page.getByTestId('studio-tab-theme').click();
      await page.getByTestId('studio-theme-tan').locator('input[type=color]').fill('#7a5c3a');
      await expect(page.getByTestId('studio-theme-tan')).toContainText('#7a5c3a');

      // 自动保存、检查没有红的
      await expect(page.getByTestId('studio-save-status')).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
      await page.getByTestId('studio-open-checks').click();
      await expect(page.getByTestId('studio-checks')).not.toContainText('缺了');

      // 发布
      await page.getByTestId('studio-open-publish').click();
      await page.getByTestId('studio-publish-note').fill(`E2E 起始页加字、换强调色 ${stamp}`);
      await page.getByTestId('studio-publish-go').click();
      await expect(page.getByText(/已发布第 \d+ 版/)).toBeVisible({ timeout: 15_000 });
      const versions = await getJson<StudioVersionView[]>(page, '/api/studio/emenu/versions');
      expect(versions[0]).toMatchObject({ kind: 'publish', note: `E2E 起始页加字、换强调色 ${stamp}`, publishedBy: DESIGNER.displayName });
      expect(versions[0]!.screensChanged).toEqual(expect.arrayContaining(['theme', 'start']));
      await page.getByTestId('studio-open-versions').click();
      await expect(page.getByTestId(`studio-version-${versions[0]!.version}`)).toContainText('平板现在用的');
      await page.keyboard.press('Escape');

      // 平板（店主有「打开平板点餐」）：菜单接口带上这一版，取得到版面
      const menu = await getJson<{ studio: unknown }>(pad, '/api/emenu/menu');
      expect(menu.studio).toMatchObject({ id: versions[0]!.id, version: versions[0]!.version });
      const doc = await getJson<{ doc: { theme: { colors: Record<string, string> } } }>(pad, `/api/studio/docs/${versions[0]!.id}`);
      expect(JSON.stringify(doc.doc)).toContain(words);
      expect(doc.doc.theme.colors.tan).toBe('#7a5c3a');

      // 预览码：平板打开 /emenu?studio=<码>，起始页看得到那行字、顶上写着预览、不能下单
      const code = await send<{ code: string }>(page, 'post', '/api/studio/emenu/preview-code', { doc: doc.doc });
      await pad.goto(`/emenu?studio=${code.code}`);
      await expect(pad.getByTestId('emenu-studio-preview')).toContainText('不能下单');
      await expect(pad.getByTestId('emenu-start')).toContainText(words);

      // 用完：照内置的默认版面再发一版（演示库的平板照旧是原来的样子）
      await resetDraft(page);
      const s = await getJson<StudioState>(page, '/api/studio/emenu');
      await send(page, 'post', '/api/studio/emenu/publish', { clientKey: randomUUID(), rev: s.draft.rev, note: `E2E 用完恢复默认版面 ${stamp}` });
    } finally {
      // 停用设计师账号（下次启用、重置密码接着用）
      await send(pad, 'put', `/api/staff/${designer.id}`, { displayName: DESIGNER.displayName, role: 'designer', duties: [], active: false });
      await owner.close();
    }
  });
});
