// 8.0.9 安保巡场（docs/PATROL_V809.md）的浏览器流程：
//   后台（电脑尺寸）：ERP「员工工作台 → 安保巡场」设巡场部门与手机上能看记录的人、新增场所、打印二维码（码里是员工入口地址 + #patrol=场所码）；
//   安保部门的员工（手机）：底部第四个入口是「工作台」，里面有「巡场」；用手机相机直接扫开场所码（打开 #patrol=码）就打卡，
//   巡场页列出今天各场所谁几点巡过、还没人巡的；2 分钟内再扫提示刚打过卡；没登录的先登录、登录好接着打卡；
//   指定能看记录的员工：工作台里有「巡场记录」；别的部门的员工没有工作台、直接扫码提示不在巡场部门；
//   后台「今天」与「巡场记录」看到同样的结果。
// 要应用开着员工端口：E2E_BASE_URL、E2E_CANTEEN_URL（见 playwright.canteen.config.ts），库里要有演示的店主 linlan（seed-demo）。
// 可以重复跑：部门按名字沿用；员工工号、场所名称带这次的时间，场所跑完停用。
// Codex 审查 41a2fbb 的四条也在这里：两个人同时改设置、断网扫的码离开巡场页也补交、手机上换日期没取到、记录筛选里有停用的场所。

import { randomUUID } from 'node:crypto';
import { expect, test, devices, type Browser, type BrowserContext, type APIRequestContext, type Page } from '@playwright/test';

const CANTEEN = process.env.E2E_CANTEEN_URL ?? 'http://localhost:8090';
const tz = 'Asia/Shanghai';
const PASSWORD = 'yuzu2026';
const STAFF_PASSWORD = 'Xun-chang-2026';

async function phone(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...devices['Pixel 5'], locale: 'zh-CN', timezoneId: tz });
  await ctx.addInitScript(() => {
    localStorage.setItem('yuzu.canteen.intro.v1', 'true');
    localStorage.setItem('yuzu.canteen.tour.v1', 'done');
  });
  return ctx;
}

async function ok<T = unknown>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** 加一位员工（工号带这次的时间，可以重复跑），给一张开通码 */
async function hire(api: APIRequestContext, empNo: string, name: string, departmentId: number | null): Promise<{ id: number; code: string; empNo: string }> {
  const made = await ok<{ employee: { id: number } }>(await api.post('/api/erp/canteen/employees', { data: { empNo, name, role: 'staff', departmentId } }));
  const [card] = await ok<{ code: string }[]>(await api.get(`/api/erp/canteen/activation-cards?ids=${made.employee.id}`));
  return { id: made.employee.id, code: card!.code, empNo };
}

/** 扫开通卡片打开（#join=开通码），设密码，进首页 */
async function join(ctx: BrowserContext, code: string): Promise<Page> {
  const p = await ctx.newPage();
  await p.goto(`${CANTEEN}/#join=${code}`);
  await expect(p.getByText(/欢迎你/)).toBeVisible();
  await p.getByLabel('新密码', { exact: true }).fill(STAFF_PASSWORD);
  await p.getByLabel('再输一遍密码').fill(STAFF_PASSWORD);
  await p.getByRole('button', { name: /开吃/ }).click();
  await expect(p.getByTestId('tab-home')).toBeVisible();
  return p;
}

test('安保巡场：后台设部门与场所、打印二维码 → 保安直接扫码打卡、看今天 → 指定的人看记录 → 后台看到清单', async ({ browser, page }) => {
  // ① 后台：店主登录、打开两个模块、员工入口地址
  await page.goto('/login');
  await page.fill('#username', 'linlan');
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  const api = page.request;
  await ok(await api.put('/api/erp/modules', { data: { modules: { canteen: true, patrol: true } } }));
  const canteenSettings = await ok<Record<string, unknown> & { portalUrl: string }>(await api.get('/api/erp/canteen/settings'));
  if (canteenSettings.portalUrl !== CANTEEN) await ok(await api.put('/api/erp/canteen/settings', { data: { ...canteenSettings, portalUrl: CANTEEN } }));
  const deps = await ok<{ id: number; name: string }[]>(await api.get('/api/inventory/departments?all=true'));
  let security = deps.find((d) => d.name === 'E2E安保部');
  if (!security) security = (await ok<{ id: number; name: string }[]>(await api.post('/api/inventory/departments', { data: { name: 'E2E安保部', active: true, sortOrder: 0 } }))).find((d) => d.name === 'E2E安保部');
  const stamp = String(Date.now()).slice(-5);
  const guard = await hire(api, `XG${stamp}`, 'E2E 保安老张', security!.id);
  const viewer = await hire(api, `XV${stamp}`, 'E2E 店总', null);
  const outsider = await hire(api, `XO${stamp}`, 'E2E 后厨', null);

  // ② 后台「安保巡场 → 设置」：勾安保部、勾能看记录的人
  await page.goto('/erp/patrol');
  await expect(page.getByTestId('patrol-admin')).toBeVisible();
  await page.getByRole('radio', { name: '设置' }).click();
  const deptBox = page.getByTestId('patrol-dept-E2E安保部');
  if (!(await deptBox.isChecked())) await deptBox.check();
  const viewerBox = page.getByTestId(`patrol-viewer-${viewer.empNo}`);
  if (!(await viewerBox.isChecked())) await viewerBox.check();
  const save = page.getByTestId('patrol-settings-save');
  if (await save.isEnabled()) {
    await save.click();
    await expect(page.getByText('已保存')).toBeVisible();
  }
  // 两个人同时改设置（Codex 审查 41a2fbb）：这边勾了一下还没保存，别人先保存了；切回这个窗口（页面重新取数）以后再保存，
  // 照样被拒、不盖掉别人刚保存的；点「看最新的」放弃这次的勾选
  const outsiderBox = page.getByTestId(`patrol-viewer-${outsider.empNo}`);
  await outsiderBox.check();
  const latest = await ok<{ departmentIds: number[]; viewerIds: number[]; rev: number }>(await api.get('/api/erp/patrol/settings'));
  await ok(await api.put('/api/erp/patrol/settings', { data: { departmentIds: latest.departmentIds, viewerIds: latest.viewerIds, rev: latest.rev } }));
  await page.waitForTimeout(5_500); // 页面上的数据过 5 秒才算旧：切回窗口时重新取
  const refetched = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/erp/patrol/settings' && r.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await refetched;
  await page.getByTestId('patrol-settings-save').click();
  await expect(page.getByTestId('patrol-settings-stale')).toBeVisible();
  expect((await ok<{ viewerIds: number[] }>(await api.get('/api/erp/patrol/settings'))).viewerIds).not.toContain(outsider.id);
  await page.getByTestId('patrol-settings-reload').click();
  await expect(outsiderBox).not.toBeChecked();
  await expect(page.getByTestId('patrol-settings-stale')).toHaveCount(0);

  // ③ 场所与二维码：新增两个场所（名称带这次的时间），打印页里两个码都在
  const names = [`E2E北门${stamp}`, `E2E屋顶${stamp}`];
  await page.getByRole('radio', { name: '场所与二维码' }).click();
  for (const name of names) {
    await page.getByTestId('patrol-point-new').click();
    await page.getByLabel('场所名称').fill(name);
    await page.getByLabel('位置说明').fill('E2E 位置');
    await page.getByTestId('patrol-point-save').click();
    await expect(page.getByTestId(`patrol-point-${name}`)).toBeVisible();
  }
  const points = (await ok<{ points: { id: number; name: string; token: string }[] }>(await api.get('/api/erp/patrol/points'))).points.filter((p) => names.includes(p.name));
  expect(points).toHaveLength(2);
  const north = points.find((p) => p.name === names[0])!;
  const print = await page.context().newPage();
  await print.goto(`/print/patrol-codes/${points.map((p) => p.id).join(',')}`);
  await expect(print.getByTestId(`patrol-code-${names[0]}`)).toBeVisible();
  await expect(print.getByTestId(`patrol-code-${names[1]}`)).toBeVisible();
  const qr = await print.getByTestId(`patrol-code-${names[0]}`).locator('svg[data-qr]').getAttribute('data-qr');
  expect(qr).toBe(`${CANTEEN}/#patrol=${north.token}`);
  await print.close();
  // 另建两个场所（接口建，不进上面的打印）：侧门给断网补交用；旧仓库建好就停用、今天没人巡，给记录筛选用
  type Made = { id: number; name: string; area: string; token: string; sortOrder: number; version: number };
  const addPoint = async (name: string) => (await ok<{ point: Made }>(await api.post('/api/erp/patrol/points', { data: { clientKey: randomUUID(), name, area: 'E2E 位置' } }))).point;
  const gate = await addPoint(`E2E侧门${stamp}`);
  const old = await addPoint(`E2E旧仓库${stamp}`);
  await ok(await api.put(`/api/erp/patrol/points/${old.id}`, { data: { name: old.name, area: old.area, sortOrder: old.sortOrder, active: false, version: old.version } }));

  try {
    // ④ 保安：工作台里有巡场；直接扫开场所码就打卡
    const guardPhone = await phone(browser);
    const g = await join(guardPhone, guard.code);
    await expect(g.getByTestId('tab-work')).toBeVisible();
    await g.getByTestId('tab-work').click();
    await expect(g.getByTestId('work-patrol')).toBeVisible();
    await g.goto(`${CANTEEN}/#patrol=${north.token}`);
    await expect(g.getByTestId('patrol-result')).toContainText(`✓ ${names[0]}`);
    await expect(g).toHaveURL(/#\/patrol$/);
    await expect(g.getByTestId(`patrol-point-${names[0]}`)).toContainText('E2E 保安老张');
    await expect(g.getByTestId(`patrol-point-${names[1]}`)).toContainText('今天还没人巡');
    // 在线直接扫的这一笔不是补交：补交那一轮不把正在交的这笔再交一次（不出现「刚补交的」）
    await expect(g.getByText('刚补交的')).toHaveCount(0);
    // 2 分钟内再扫：刚打过卡，不重复记
    await g.goto(`${CANTEEN}/#patrol=${north.token}`);
    await expect(g.getByTestId('patrol-result')).toContainText('刚打过卡');
    // 断网扫的码离开巡场页也照样补交（Codex 审查 41a2fbb）：扫侧门时交不上（拦掉打卡请求），记在手机上；
    // 回首页以后联网，柚子饭堂在后台补交、提示补交好了，后台记录里有这一条
    const checkins = (u: URL) => u.pathname === '/api/canteen/patrol/checkins';
    await guardPhone.route(checkins, (r) => r.abort('internetdisconnected'));
    await g.goto(`${CANTEEN}/#patrol=${gate.token}`);
    await expect(g.getByTestId('patrol-result')).toContainText('已记在手机上');
    await expect(g.getByTestId('patrol-queued')).toHaveText('1');
    await g.getByTestId('tab-home').click();
    await expect(g.getByTestId('show-code')).toBeVisible();
    await guardPhone.unroute(checkins);
    await g.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(g.getByText(/巡场打卡补交好了 1 条/)).toBeVisible({ timeout: 20_000 });
    const businessToday = (await ok<{ today: string }>(await api.get('/api/erp/patrol/day'))).today;
    expect((await ok<{ total: number }>(await api.get(`/api/erp/patrol/records?from=${businessToday}&to=${businessToday}&pointId=${gate.id}`))).total).toBe(1);

    // ⑤ 没登录的手机直接扫：先登录，登录好接着打卡（记下的码）
    const fresh = await phone(browser);
    const f = await fresh.newPage();
    await f.goto(`${CANTEEN}/#patrol=${points[1]!.token}`);
    await f.getByLabel('账号').fill(guard.empNo);
    await f.getByLabel('密码', { exact: true }).fill(STAFF_PASSWORD);
    await f.getByRole('button', { name: '登录', exact: true }).click();
    await expect(f.getByTestId('patrol-result')).toContainText(`✓ ${names[1]}`);
    await fresh.close();
    await guardPhone.close();

    // ⑥ 指定能看记录的人：工作台里有巡场记录，看到今天两处都巡过
    const viewerPhone = await phone(browser);
    const v = await join(viewerPhone, viewer.code);
    await v.getByTestId('tab-work').click();
    await v.getByTestId('work-patrolLog').click();
    await expect(v.getByTestId(`patrol-log-point-${names[0]}`)).toContainText('E2E 保安老张');
    await expect(v.getByTestId(`patrol-log-point-${names[1]}`)).toContainText('E2E 保安老张');
    // 换日期没取到（Codex 审查 41a2fbb）：只显示出错，不把今天的数字显示在前一天下面
    const pastDay = (u: URL) => u.pathname === '/api/canteen/patrol/day' && u.searchParams.has('date');
    await viewerPhone.route(pastDay, (r) => r.abort('internetdisconnected'));
    await v.getByTestId('patrol-log-prev').click();
    await expect(v.getByTestId('patrol-log-error')).toBeVisible();
    await expect(v.getByTestId('patrol-log-total')).toHaveCount(0);
    await viewerPhone.unroute(pastDay);
    await viewerPhone.close();

    // ⑦ 别的部门的员工：没有工作台；直接扫码提示不在巡场部门
    const outsiderPhone = await phone(browser);
    const o = await join(outsiderPhone, outsider.code);
    await expect(o.getByTestId('tab-work')).toHaveCount(0);
    await o.goto(`${CANTEEN}/#patrol=${north.token}`);
    await expect(o.getByText('巡场只有巡场部门（安保）的员工能用')).toBeVisible();
    await outsiderPhone.close();

    // ⑧ 后台「今天」「巡场记录」：两处都巡过，记录里有这两条
    await page.getByRole('radio', { name: '今天' }).click();
    await expect(page.getByTestId(`patrol-day-point-${names[0]}`)).toContainText('E2E 保安老张');
    await expect(page.getByTestId(`patrol-day-point-${names[1]}`)).toContainText('1 次');
    await page.getByRole('radio', { name: '巡场记录' }).click();
    // 停用、今天没人巡的场所也能筛（以前的记录照样能单独筛、单独导出；Codex 审查 41a2fbb）
    await expect(page.getByTestId('patrol-records-point').locator('option', { hasText: old.name })).toHaveText(`${old.name}（已停用）`);
    await page.getByTestId('patrol-records-point').selectOption({ label: names[0] });
    await expect(page.getByTestId('patrol-records-total')).toContainText('共 1 次');
  } finally {
    // 跑完停用这次新增的场所（场所不能删）
    const fresh = (await ok<{ points: { id: number; name: string; area: string; sortOrder: number; active: boolean; version: number }[] }>(await api.get('/api/erp/patrol/points'))).points;
    for (const p of fresh.filter((x) => [...names, gate.name].includes(x.name) && x.active)) {
      await api.put(`/api/erp/patrol/points/${p.id}`, { data: { name: p.name, area: p.area, sortOrder: p.sortOrder, active: false, version: p.version } });
    }
  }
});
