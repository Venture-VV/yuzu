// 员工食堂接上 UI 工作台（8.1.2，docs/WORKBENCH_V811.md 第 8 节）的浏览器验收：
//   店主在工作台把柚子饭堂首页「跟柚子说」挪到最前面、加一行公告，发布 → 员工手机打开柚子饭堂，首页照新的样子排、看得到公告，
//   饭卡码页的码照旧（饭卡码那一块改不了）→ 用完照内置的默认版面再发一版（演示库照旧是原来的样子）。
// 要应用开着员工端口：E2E_BASE_URL（员工后台，默认 http://localhost:8080）、E2E_CANTEEN_URL（员工端口，默认 http://localhost:8090），
// 库里要有演示的店主 linlan（seed-demo）。只在独立演示库上跑：会建一位员工（工号随机）、发两版员工食堂版面。
import { randomUUID } from 'node:crypto';
import { devices, expect, test, type Page } from '@playwright/test';
import { defaultStudioDoc, type StudioDoc, type StudioState } from '../src/shared/studio';

const CANTEEN = process.env.E2E_CANTEEN_URL ?? 'http://localhost:8090';

async function ownerLogin(page: Page) {
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', 'yuzu2026');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

async function publish(page: Page, doc: StudioDoc, note: string) {
  const s = (await (await page.request.get('/api/studio/canteen')).json()) as StudioState;
  const saved = await page.request.put('/api/studio/canteen/draft', { data: { rev: s.draft.rev, doc } });
  expect(saved.status(), await saved.text()).toBe(200);
  const pub = await page.request.post('/api/studio/canteen/publish', { data: { clientKey: randomUUID(), rev: (await saved.json()).rev, note } });
  expect(pub.status(), await pub.text()).toBe(200);
}

test('员工食堂首页改版发布以后，员工手机上照新的样子；饭卡码照旧', async ({ browser }) => {
  test.setTimeout(120_000);
  const stamp = randomUUID().slice(0, 6);
  const notice = `E2E 饭堂公告 ${stamp}：今天加鸡腿`;
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const admin = await adminCtx.newPage();
  await ownerLogin(admin);
  expect((await admin.request.put('/api/erp/modules', { data: { modules: { canteen: true } } })).status()).toBe(200);
  const made = await admin.request.post('/api/erp/canteen/employees', { data: { empNo: `S${stamp.toUpperCase()}`, name: '版面测试', role: 'staff', departmentId: null } });
  expect(made.status(), await made.text()).toBe(200);
  const card = (await (await admin.request.get(`/api/erp/canteen/activation-cards?ids=${(await made.json()).employee.id}`)).json())[0];

  // 店主在工作台改：「跟柚子说」挪到最前面，饭卡码按钮下面加一行公告
  const doc = defaultStudioDoc('canteen');
  const home = doc.screens.home!.nodes;
  const talk = home.splice(home.findIndex((n) => n.type === 'block' && n.block === 'cn.talk'), 1)[0]!;
  home.unshift(talk);
  home.splice(home.findIndex((n) => n.type === 'block' && n.block === 'cn.codeButton') + 1, 0, {
    type: 'text',
    id: 'e2e-notice',
    name: '公告',
    x: 0,
    y: 0,
    w: 343,
    h: 24,
    rotate: 0,
    opacity: 1,
    hidden: false,
    locked: false,
    sizing: { w: 'fill', h: 'hug' },
    text: { zh: notice, en: '' },
    font: 'zh',
    size: 15,
    weight: 700,
    color: '$energy',
    align: 'center',
    valign: 'top',
    lineHeight: 1.4,
    letterSpacing: 0,
    italic: false,
    underline: false,
    fill: null,
  });
  await publish(admin, doc, `E2E 饭堂首页挪「跟柚子说」、加公告 ${stamp}`);

  const phone = await browser.newContext({ ...devices['Pixel 5'], locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await phone.addInitScript(() => {
    localStorage.setItem('yuzu.canteen.intro.v1', 'true');
    localStorage.setItem('yuzu.canteen.tour.v1', 'done');
  });
  try {
    const p = await phone.newPage();
    await p.goto(`${CANTEEN}/#join=${card.code}`);
    await p.getByLabel('新密码', { exact: true }).fill('Fan-tang-2026');
    await p.getByLabel('再输一遍密码').fill('Fan-tang-2026');
    await p.getByRole('button', { name: /开吃/ }).click();
    await expect(p.getByTestId('tab-home')).toBeVisible();
    // 首页：公告看得到；「跟柚子说」排在「亮出饭卡码」前面
    await expect(p.getByText(notice)).toBeVisible();
    const talkTop = (await p.getByTestId('talk-entry').boundingBox())!.y;
    const codeTop = (await p.getByTestId('show-code').boundingBox())!.y;
    expect(talkTop).toBeLessThan(codeTop);
    await p.screenshot({ path: 'test-results/canteen/studio-home.png', fullPage: true });
    // 饭卡码页：码照旧
    await p.getByTestId('show-code').click();
    await expect(p.getByTestId('meal-code').locator('svg[data-qr]')).toBeVisible();
  } finally {
    // 用完：照内置的默认版面再发一版
    await publish(admin, defaultStudioDoc('canteen'), `E2E 用完恢复默认版面 ${stamp}`);
    await phone.close();
    await adminCtx.close();
  }
});
