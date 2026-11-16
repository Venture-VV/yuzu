// 8.1.1 UI 工作台的浏览器验收（docs/WORKBENCH_V811.md 第 10 节）：只在「门店电脑」这一组执行。
//   店主建（或重置）设计师账号 e2esheji → 设计师第一次登录先改密码，之后直接到后台的「工作台」→ 打开编辑器（起始页画的就是平板的样子）→
//   拖动字标、撤销重做 → 插入文字、写中英文 → 主题换强调色 → 自动保存 → 检查没有红的 → 发布 → 版本列表里有这一版 →
//   8.1.2：「版式」里挪一块、加圆角、放大一档单独挪一块（卡片模板）→
//   平板的菜单接口带上这一版、预览码打开看得到那行字 →
//   8.1.2 第 4 步：店主也开着编辑器（「谁在改」）、批注来回（留言、回复、标解决）、中英文案改英文并导出、设计包导进来、定时发布再撤销 → 用完照内置的默认版面再发一版（演示库的平板照旧是原来的样子）、停用 e2esheji。
// 只要 seed-demo 的店主 linlan（密码 yuzu2026），不依赖 demo-prepare；演示库的设计师 sheji 留给人手工试，用例不碰它。
// 只在独立演示库。可重复执行（e2esheji 下次启用、重置密码接着用）。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { changedScreens, defaultStudioDoc, type StudioDoc, type StudioState, type StudioVersionView } from '../src/shared/studio';

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
      // 上一次停在中途（没走到「用完」）留下的那一版：先照默认版面发一版，下面「这一版改了哪几块」才对得上
      const before = await getJson<StudioState>(page, '/api/studio/emenu');
      if (before.published) {
        const pub = await getJson<{ doc: StudioDoc }>(page, `/api/studio/emenu/versions/${before.published.version}`);
        if (changedScreens(pub.doc, defaultStudioDoc('emenu')).length) {
          await send(page, 'post', '/api/studio/emenu/publish', { clientKey: randomUUID(), rev: before.draft.rev, note: `E2E 开始前回到默认版面 ${stamp}` });
        }
      }
      await page.getByTestId('studio-open-emenu').click();
      await expect(page.getByTestId('studio-canvas')).toBeVisible();
      await expect(page.getByTestId('studio-save-status')).toHaveAttribute('data-status', 'saved');
      // 「原样 / 放大」按平板现在的设置开（8.1.4：之前开在哪一档看草稿、菜单两个请求谁先回来，PR #119 的 CI）；下面的流程都在「原样」一档里走
      const tablet = await getJson<{ rules: { textSize: string } }>(page, '/api/studio/emenu/menu');
      const textSize = page.getByTestId('studio-text-size');
      await expect(textSize).toHaveText(tablet.rules.textSize === 'design' ? '原样' : '放大');
      if (tablet.rules.textSize !== 'design') await textSize.click();
      await expect(textSize).toHaveText('原样');
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

      // 卡片模板（8.1.2）：「版式」里「单菜 · 左图」的餐品图拖一下、再用数字定到 x = 60，加圆角 16；放大一档单独挪特写图
      await page.getByTestId('studio-tab-templates').click();
      await expect(page.getByTestId('studio-template-canvas')).toBeVisible();
      await page.getByTestId('studio-layout-single_left').click();
      const tpl = (await page.getByTestId('studio-template-layer').boundingBox())!;
      const tk = tpl.width / 1024;
      const grab = { x: tpl.x + (40 + 214) * tk, y: tpl.y + (133.8 + 300) * tk };
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 30 * tk, grab.y + 12 * tk, { steps: 8 });
      await page.mouse.up();
      await expect(page.getByTestId('studio-slot-panel')).toContainText('餐品图');
      expect(Number(await page.getByTestId('studio-slot-x').inputValue())).toBeGreaterThan(40);
      await page.getByTestId('studio-slot-x').fill('60');
      await page.getByTestId('studio-slot-x').press('Enter');
      await page.getByTestId('studio-slot-y').fill('133.8');
      await page.getByTestId('studio-slot-y').press('Enter');
      await page.getByTestId('studio-slot-radius').fill('16');
      await page.getByTestId('studio-slot-radius').press('Enter');
      await expect(page.getByTestId('studio-layout-single_left')).toContainText('改过 1 块');
      await page.getByTestId('studio-slot-item-detail').click();
      await page.getByTestId('studio-slot-mode').click();
      await page.getByTestId('studio-slot-y').fill('150');
      await page.getByTestId('studio-slot-y').press('Enter');
      await expect(page.getByTestId('studio-template-canvas')).toHaveAttribute('data-mode', 'big');
      await page.getByTestId('studio-slot-mode').click();

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
      expect(versions[0]!.screensChanged).toEqual(expect.arrayContaining(['theme', 'start', 'templates']));
      await page.getByTestId('studio-open-versions').click();
      await expect(page.getByTestId(`studio-version-${versions[0]!.version}`)).toContainText('现在用的');
      await page.keyboard.press('Escape');

      // 平板（店主有「打开平板点餐」）：菜单接口带上这一版，取得到版面
      const menu = await getJson<{ studio: unknown }>(pad, '/api/emenu/menu');
      expect(menu.studio).toMatchObject({ id: versions[0]!.id, version: versions[0]!.version });
      const doc = await getJson<{ doc: { theme: { colors: Record<string, string> } } }>(pad, `/api/studio/docs/${versions[0]!.id}`);
      expect(JSON.stringify(doc.doc)).toContain(words);
      expect(doc.doc.theme.colors.tan).toBe('#7a5c3a');
      expect((doc.doc as { templates?: unknown }).templates).toEqual({ single_left: { photo: { design: { x: 60 }, radius: 16 }, detail: { big: { y: 150 } } } });

      // 预览码：平板打开 /emenu?studio=<码>，起始页看得到那行字、顶上写着预览、不能下单
      const code = await send<{ code: string }>(page, 'post', '/api/studio/emenu/preview-code', { doc: doc.doc });
      await pad.goto(`/emenu?studio=${code.code}`);
      await expect(pad.getByTestId('emenu-studio-preview')).toContainText('不能下单');
      await expect(pad.getByTestId('emenu-start')).toContainText(words);

      // 8.1.2 第 4 步 ── 谁在改：店主也打开这个界面的编辑器，设计师这边顶上写着有人也在改
      await pad.goto('/studio/emenu');
      await expect(pad.getByTestId('studio-canvas')).toBeVisible();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByTestId('studio-presence')).toContainText('也在改', { timeout: 15_000 });

      // 批注：设计师在画布上点一下留言 → 店主回复 → 设计师标解决（画布上的圆点不见了）
      const note = `E2E 批注 ${stamp}：字标再往上一点`;
      await page.getByTestId('studio-open-comments').click();
      // 上面停在「版式」：点「加一条批注」自己回到普通的画布（停在菜单页）；回起始页再加
      await page.getByTestId('studio-comment-add').click();
      await expect(page.getByTestId('studio-comment-layer')).toBeVisible();
      await page.getByTestId('studio-screen-start').click();
      await expect(page.getByTestId('studio-comment-layer')).toBeVisible();
      const area = (await page.getByTestId('studio-canvas-layer').boundingBox())!;
      await page.mouse.click(area.x + area.width * 0.3, area.y + area.height * 0.3);
      await page.getByTestId('studio-comment-text').fill(note);
      await page.getByTestId('studio-comment-send').click();
      const comments = await getJson<{ id: number; body: string; parentId: number | null }[]>(page, '/api/studio/emenu/comments');
      const mine = comments.find((c) => c.body === note)!;
      expect(mine).toBeTruthy();
      await expect(page.getByTestId(`studio-comment-pin-${mine.id}`)).toBeVisible();
      await pad.reload();
      await pad.getByTestId('studio-open-comments').click();
      await pad.getByTestId(`studio-comment-reply-${mine.id}`).fill('好的，下午改');
      await pad.getByTestId(`studio-comment-reply-send-${mine.id}`).click();
      await expect(pad.getByTestId(`studio-comment-${mine.id}`)).toContainText('好的，下午改');
      await page.reload();
      await page.getByTestId('studio-open-comments').click();
      await expect(page.getByTestId(`studio-comment-${mine.id}`)).toContainText('好的，下午改');
      await page.getByTestId(`studio-comment-resolve-${mine.id}`).click();
      await expect(page.getByTestId(`studio-comment-pin-${mine.id}`)).toHaveCount(0);
      await pad.goto('/admin/studio');

      // 中英文案：插进来的那段字列在表里，改英文 → 草稿里跟着改；导出的 CSV 里有这段字
      await page.getByTestId('studio-more').click();
      await page.getByTestId('studio-open-copy').click();
      const enCells = page.locator('[data-testid^="studio-copy-en-"]');
      await expect(page.getByTestId('studio-copy')).toContainText(words);
      const row = page.locator('[data-testid^="studio-copy-row-"]', { hasText: words });
      await row.locator('[data-testid^="studio-copy-en-"]').fill(`E2E Winter edited ${stamp}`);
      expect(await enCells.count()).toBeGreaterThan(0);
      const csvDownload = page.waitForEvent('download');
      await page.getByTestId('studio-copy-export').click();
      const csvText = await (await csvDownload).createReadStream().then(async (st) => {
        const parts: Buffer[] = [];
        for await (const c of st) parts.push(c as Buffer);
        return Buffer.concat(parts).toString('utf8');
      });
      expect(csvText).toContain('编号,屏,名字,中文,英文');
      expect(csvText).toContain(`E2E Winter edited ${stamp}`);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('studio-save-status')).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
      expect(JSON.stringify((await getJson<StudioState>(page, '/api/studio/emenu')).draft.doc)).toContain(`E2E Winter edited ${stamp}`);

      // 设计包：导出（接口）→ 改一句再导进来 → 编辑器里换成设计包里的、自动存上
      const pack = await getJson<{ kind: string; doc: unknown; assets: unknown[] }>(page, '/api/studio/emenu/pack');
      expect(pack.kind).toBe('yuzu-studio-pack');
      const packed = JSON.stringify(pack).replace(`E2E Winter edited ${stamp}`, `E2E Winter packed ${stamp}`);
      await page.getByTestId('studio-more').click();
      await page.getByTestId('studio-open-pack').click();
      await page.getByTestId('studio-pack-file').setInputFiles({ name: 'pack.json', mimeType: 'application/json', buffer: Buffer.from(packed) });
      await expect(page.getByText('设计包导进来了')).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('studio-save-status')).toHaveAttribute('data-status', 'saved', { timeout: 15_000 });
      expect(JSON.stringify((await getJson<StudioState>(page, '/api/studio/emenu')).draft.doc)).toContain(`E2E Winter packed ${stamp}`);

      // 定时发布：定在 10 分钟以后 → 版本列表里写着「定在…生效」、平板还用原来那版 → 撤销定时
      const live = (await getJson<StudioState>(page, '/api/studio/emenu')).published!;
      await page.getByTestId('studio-open-publish').click();
      await page.getByTestId('studio-publish-note').fill(`E2E 定时发布 ${stamp}`);
      await page.getByTestId('studio-publish-later').check();
      const later = await page.evaluate(() => {
        const d = new Date(Date.now() + 10 * 60_000);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      });
      await page.getByTestId('studio-publish-at').fill(later);
      await page.getByTestId('studio-publish-go').click();
      await expect(page.getByTestId('studio-scheduled')).toBeVisible({ timeout: 15_000 });
      const sched = (await getJson<StudioState>(page, '/api/studio/emenu')).scheduled;
      expect(sched).toHaveLength(1);
      expect(sched[0]).toMatchObject({ note: `E2E 定时发布 ${stamp}` });
      expect((await getJson<StudioState>(page, '/api/studio/emenu')).published!.version).toBe(live.version);
      const menuNow = await getJson<{ studio: { version: number } | null }>(pad, '/api/emenu/menu');
      expect(menuNow.studio?.version).toBe(live.version);
      await page.getByTestId('studio-open-versions').click();
      await expect(page.getByTestId(`studio-version-pending-${sched[0]!.version}`)).toBeVisible();
      page.once('dialog', (d) => void d.accept());
      await page.getByTestId(`studio-cancel-${sched[0]!.version}`).click();
      await expect(page.getByTestId(`studio-version-${sched[0]!.version}`)).toContainText('撤销了');
      await page.keyboard.press('Escape');
      expect((await getJson<StudioState>(page, '/api/studio/emenu')).scheduled).toHaveLength(0);

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
