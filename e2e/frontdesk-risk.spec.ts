// 8.1.15《浴族系统需求汇总》块 A（docs/FRONTDESK_RISK_V8115.md）的浏览器验收：
//   ① 刷卡发牌：读卡器状态那一行；键盘式读卡器刷到绑了芯片号的牌，牌号带出来、这一行高亮、不提交；同一张再刷提示「本次已刷」；
//      没绑的卡、已在店的牌写明原因；随时能手输；回车才发；
//   ② 断网后自动核对：发牌请求没到服务器、网络断了又恢复，本机按原编号重提一次，牌发出去且只发一次；
//   ③ 黑名单：会员详情里加入 → 接待发牌选这位时写明不能发（服务端也拒绝）→ 后台清单里解除 → 照常发牌；
//   ④ 未结离店：客人卡「异常处置」记一条 → 发卡台顶上的「异常待办」→ 这位会员下次发牌要值班经理当场授权，授权后发出、授权人记在来访上；
//   ⑤ 异常处置：提醒、临时外出 / 返回（手牌卡片上写着外出）、超时加收（店员凭授权；账单上多一条「超时加收」）、上报 → 待办里改派、写处理结果、
//      手牌丢失进换牌（原因与锁牌预先选好）；
//   ⑥ 超时分级：在店超 12 / 24 小时的手牌卡片与收银台清单上有带字的色标；后台手牌池绑 / 解绑芯片号；
//   ⑦ 四种屏幕（1920×1080、1280×720、360×800、1355×903）：接待发牌、异常处置、异常待办都放得下。
// 依赖演示数据（seed-demo、seed-frontdesk-demo：店主 linlan、值班经理 zhangjl、收银 xiaozhou，密码 yuzu2026）。会登记单据，只在门店电脑尺寸执行；
// 用到的手牌、会员每次新挑、新建，做完把来访撤销、芯片号解绑，不改演示数据里已有的档案。
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { expectFits } from './fits';

const PASSWORD = 'yuzu2026';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
}

/** 另一个账号的接口会话（值班经理、店主做页面上那位做不了的事） */
async function apiAs(browser: Browser, baseURL: string | undefined, username: string): Promise<APIRequestContext> {
  const ctx = await browser.newContext({ baseURL });
  const res = await ctx.request.post('/api/auth/login', { data: { username, password: PASSWORD } });
  expect(res.ok(), await res.text()).toBe(true);
  return ctx.request;
}

async function getJson<T>(req: APIRequestContext, url: string): Promise<T> {
  const res = await req.get(url);
  expect(res.ok(), `${url} → ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function send<T>(req: APIRequestContext, method: 'post' | 'put', url: string, data: unknown): Promise<T> {
  const res = await req[method](url, { data });
  expect(res.ok(), `${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface BoardTag {
  id: number;
  code: string;
  zone: 'male' | 'female';
  kind: 'normal' | 'vip';
  active: boolean;
  locked: boolean;
  visit: { id: number; awaySince: string | null; openTodos: number } | null;
}
interface Visit {
  id: number;
  status: string;
  bill: { amountCents: number };
  lines: { id: number; name: string; status: string; amount: number }[];
  riskApproval: { byName: string; reason: string } | null;
  incidents: { id: number; kind: string }[];
}

const board = (req: APIRequestContext) => getJson<{ tags: BoardTag[]; risk: { enabled: boolean; openTodos: number } }>(req, '/api/frontdesk/board');
/** 空闲的男宾普通柜，从后往前挑（不和别的用例抢前面的牌） */
const freeTags = async (req: APIRequestContext) => (await board(req)).tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).reverse();
const visitOn = async (req: APIRequestContext, code: string) => (await board(req)).tags.find((t) => t.code === code)!.visit;
const checkin = async (req: APIRequestContext, code: string, memberId: number | null = null, extra: Record<string, unknown> = {}) =>
  (await send<{ visits: { id: number }[] }>(req, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: code, zone: 'male', memberId }], ...extra })).visits[0]!.id;
/** 撤销一次来访（先把挂着的明细作废），手牌空出来 */
async function cleanup(req: APIRequestContext, visitId: number) {
  const v = await getJson<Visit>(req, `/api/frontdesk/visits/${visitId}`);
  if (v.status !== 'open') return;
  for (const l of v.lines.filter((x) => x.status === 'active')) await send(req, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason: '浏览器用例收尾' });
  await send(req, 'post', `/api/frontdesk/visits/${visitId}/cancel`, { reason: '浏览器用例收尾' });
}
/**
 * 按纸质单补录一位 hours 小时前就进店的客人（值班经理能补录）：挑一张那段时间没人用过的牌——
 * 用过的（以前跑这条用例留下的来访也算）服务端会拒绝，换下一张
 */
async function checkinAgo(req: APIRequestContext, hours: number, skip: string[]): Promise<{ tag: BoardTag; visitId: number }> {
  for (const tag of await freeTags(req)) {
    if (skip.includes(tag.code)) continue;
    const res = await req.post('/api/frontdesk/checkins', {
      data: {
        clientKey: randomUUID(),
        guests: [{ tagCode: tag.code, zone: 'male' }],
        backfill: { slipNo: `E2E-${Date.now()}-${hours}`, at: new Date(Date.now() - hours * 3_600_000).toISOString() },
      },
    });
    if (res.status() === 201) return { tag, visitId: ((await res.json()) as { visits: { id: number }[] }).visits[0]!.id };
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BACKFILL_TAG_BUSY');
  }
  throw new Error('没有那段时间空着的手牌');
}
const newMember = (req: APIRequestContext, name: string) => send<{ id: number }>(req, 'post', '/api/members', { name, phone: `139${String(Date.now()).slice(-8)}`, gender: 'male' });
const cardUid = () => `E2E${randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase()}`;

/**
 * 键盘式读卡器：很快地把卡号一个键一个键打进来、以回车结束（真的读卡器按键间隔一两毫秒，远小于 50 毫秒）。
 * 用例里在页面上一口气派发这一串按键——用 page.keyboard.type 的话，机器忙时两次按键之间会被拉长到几十毫秒，就不像读卡器了。
 * 按键落在现在有光标的地方（牌号框里，或不在任何输入框里）。
 */
async function swipe(page: Page, uid: string) {
  await page.evaluate((code) => {
    const target = document.activeElement ?? document.body;
    for (const key of [...code, 'Enter']) target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }, uid);
}
/** 光标挪出输入框（点一下对话框的标题） */
const blur = (page: Page) => page.getByRole('heading', { name: '接待发牌' }).click();
/** 等状态板出来再按 F2（刚打开页面时直接按键可能落空） */
async function openCheckin(page: Page) {
  await expect(page.getByTestId('tag-board')).toBeVisible();
  await page.keyboard.press('F2');
  await expect(page.getByRole('heading', { name: '接待发牌' })).toBeVisible();
}
/** 在当场授权的弹窗里由值班经理授权 */
async function authorize(page: Page, title: string) {
  const auth = page.getByRole('dialog').filter({ hasText: `当场授权 · ${title}` });
  await auth.getByLabel('授权人账号').fill('zhangjl');
  await auth.getByLabel('授权人密码').fill(PASSWORD);
  await auth.getByTestId('authorize-submit').click();
  await expect(auth).toHaveCount(0);
}

test.describe('发卡台 · NFC 发牌、发牌前风控、异常处置', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== '门店电脑', '会登记单据，只在门店电脑尺寸执行一次');
  });

  test('刷卡发牌：带出牌号不提交、本次已刷、读不出来的原因、回车才发', async ({ page, browser, baseURL }) => {
    await login(page, 'xiaozhou');
    const owner = await apiAs(browser, baseURL, 'linlan');
    const [a, b, c] = await freeTags(page.request);
    const [uidA, uidB, uidC] = [cardUid(), cardUid(), cardUid()];
    await send(owner, 'put', `/api/frontdesk/tags/${a!.id}/card`, { cardUid: uidA });
    await send(owner, 'put', `/api/frontdesk/tags/${b!.id}/card`, { cardUid: uidB });
    await send(owner, 'put', `/api/frontdesk/tags/${c!.id}/card`, { cardUid: uidC });
    // c 这张先发出去：等下刷它要写「已在店」
    const busy = await checkin(page.request, c!.code);
    const created: number[] = [busy];
    try {
      await page.goto('/frontdesk');
      await openCheckin(page);
      // 读卡器状态：浏览器用例里没有本机设备服务，写着没连上、请手输
      await expect(page.getByTestId('reader-status')).toContainText('读卡器没连上');
      await expect(page.getByTestId('reader-line')).toContainText('请手输牌号');
      const code0 = page.getByTestId('guest-row-0').getByLabel('第 1 位牌号');

      // 光标不在输入框里刷一张：牌号带出来、这一行高亮、没有提交
      await blur(page);
      await swipe(page, uidA);
      await expect(code0).toHaveValue(a!.code);
      await expect(page.getByTestId('guest-row-0')).toHaveAttribute('data-flash', 'true');
      await expect(page.getByTestId('reader-message')).toContainText(`已读到 ${a!.code}`);
      await expect(page.getByRole('heading', { name: '接待发牌' })).toBeVisible();
      expect(await visitOn(page.request, a!.code)).toBeNull();

      // 同一张再刷：本次已刷，牌号不变
      await blur(page);
      await swipe(page, uidA);
      await expect(page.getByTestId('reader-message')).toContainText(`本次已刷：${a!.code}`);
      await expect(page.getByTestId('reader-message')).toHaveAttribute('data-tone', 'warn');

      // 加一位同行：光标就在第 2 位的牌号框里，读卡器把卡号打进框里再回车——按芯片号查，框里换成牌号
      await page.getByRole('button', { name: '添加同行客人' }).click();
      const code1 = page.getByTestId('guest-row-1').getByLabel('第 2 位牌号');
      await code1.click();
      await swipe(page, uidB);
      await expect(code1).toHaveValue(b!.code);
      await expect(page.getByRole('heading', { name: '接待发牌' })).toBeVisible();

      // 读不出来写明原因：没绑手牌的卡、已在店的牌；框里原来的牌号不动
      await code1.click();
      await swipe(page, cardUid());
      await expect(page.getByTestId('reader-message')).toContainText('没有绑定的手牌');
      await expect(code1).toHaveValue(b!.code);
      await blur(page);
      await swipe(page, uidC);
      await expect(page.getByTestId('reader-message')).toContainText(`手牌 ${c!.code} 已在店`);
      await expect(page.getByTestId('reader-message')).toHaveAttribute('data-tone', 'error');
      await expect(code0).toHaveValue(a!.code);
      await expect(code1).toHaveValue(b!.code);

      // 称呼框里的回车不发牌（读卡器万一把卡号打进别的框，末尾的回车不能变成确认）
      await page.getByLabel('第 1 位称呼').fill('王先生');
      await page.getByLabel('第 1 位称呼').press('Enter');
      await expect(page.getByRole('heading', { name: '接待发牌' })).toBeVisible();
      expect(await visitOn(page.request, a!.code)).toBeNull();

      // 核对后按回车：发牌
      await blur(page);
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
      await expect(page.getByText(`已发牌 ${a!.code}、${b!.code}`)).toBeVisible();
      const va = await visitOn(page.request, a!.code);
      const vb = await visitOn(page.request, b!.code);
      expect(va && vb).toBeTruthy();
      created.push(va!.id, vb!.id);

      // 手输一直在：再开一次，手敲末位照旧补全
      const [d] = await freeTags(page.request);
      await page.keyboard.press('Escape');
      await openCheckin(page);
      await page.getByTestId('guest-row-0').getByLabel('第 1 位牌号').fill(d!.code);
      await expect(page.getByTestId('guest-row-0')).toContainText('空闲可发');
      await page.getByRole('button', { name: '取消' }).click();
    } finally {
      for (const id of created) await cleanup(page.request, id);
      for (const t of [a, b, c]) await send(owner, 'put', `/api/frontdesk/tags/${t!.id}/card`, { cardUid: null });
    }
  });

  test('断网后自动核对：发牌请求没到服务器，网络恢复后按原编号重提一次，只发一次', async ({ page, context }) => {
    await login(page, 'xiaozhou');
    const [t] = await freeTags(page.request);
    await page.goto('/frontdesk');
    await openCheckin(page);
    await page.getByTestId('guest-row-0').getByLabel('第 1 位牌号').fill(t!.code);
    // 第一次发牌：请求没到服务器、连接断了（结果待确认）
    let sent = 0;
    await page.route('**/api/frontdesk/checkins', async (route) => {
      sent += 1;
      if (sent === 1) await route.abort('connectionreset');
      else await route.continue();
    });
    await page.getByTestId('checkin-submit').click();
    await expect(page.getByTestId('pending-op')).toContainText(t!.code);
    await expect(page.getByText('上一笔接待发牌结果待确认')).toBeVisible();
    expect(await visitOn(page.request, t!.code)).toBeNull();
    // 网络断了，又恢复：本机自动按原编号核对——没生效，原样重提一次
    await context.setOffline(true);
    await expect(page.locator('[data-testid="network-banner"][data-state="offline"]')).toBeVisible({ timeout: 20_000 });
    await context.setOffline(false);
    await expect(page.getByText(`已发牌 ${t!.code}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('pending-op')).toHaveCount(0);
    expect(sent).toBe(2);
    const v = await visitOn(page.request, t!.code);
    expect(v).toBeTruthy();
    // 本机没有留下待确认的记录
    expect(await page.evaluate(() => localStorage.getItem('yuzu.frontdeskPending.v1'))).toBeNull();
    await cleanup(page.request, v!.id);
  });

  test('黑名单：会员详情里加入 → 发牌被拦下 → 后台清单里解除 → 照常发牌', async ({ page, browser, baseURL }) => {
    await login(page, 'zhangjl');
    const clerk = await apiAs(browser, baseURL, 'xiaozhou');
    const name = `黑名单用例${String(Date.now()).slice(-5)}`;
    const m = await newMember(page.request, name);
    // 会员详情里只多了这一处入口
    await page.goto(`/?m=${m.id}`);
    const card = page.getByTestId('member-blacklist');
    await expect(card).toHaveAttribute('data-listed', 'false');
    await card.getByTestId('member-blacklist-add').click();
    await page.getByRole('button', { name: '多次逃单' }).click();
    await page.getByTestId('blacklist-add-confirm').click();
    await expect(card).toHaveAttribute('data-listed', 'true');
    await expect(card).toContainText('在黑名单里：发牌时会被拒绝');
    await expect(card).toContainText('多次逃单');

    // 接待发牌选这位：写明不能发，确认发牌点不了；绕过页面直接调接口也被拒绝
    const [t] = await freeTags(page.request);
    await page.goto('/frontdesk');
    await openCheckin(page);
    await page.getByRole('radio', { name: '会员' }).click();
    await page.getByLabel('查找会员').fill(name);
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await expect(page.getByTestId('risk-blacklist')).toContainText('在黑名单里，不能发牌');
    await expect(page.getByTestId('risk-blacklist')).toContainText('多次逃单');
    await page.getByTestId('guest-row-0').getByLabel('第 1 位牌号').fill(t!.code);
    await expect(page.getByTestId('checkin-submit')).toBeDisabled();
    const refused = await clerk.post('/api/frontdesk/checkins', { data: { clientKey: randomUUID(), guests: [{ tagCode: t!.code, zone: 'male', memberId: m.id }] } });
    expect(refused.status()).toBe(422);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('GUEST_BLACKLISTED');
    await page.getByRole('button', { name: '取消' }).click();

    // 后台「手牌与前台 → 黑名单」：清单里有这一条，解除要写原因
    await page.goto('/admin/tags/blacklist');
    const row = page.getByTestId('blacklist-list').locator('li').filter({ hasText: name });
    await expect(row).toContainText('生效中');
    await expect(row).toContainText('多次逃单');
    await row.getByRole('button', { name: '解除' }).click();
    await page.getByTestId('blacklist-lift-reason').fill('已和客人谈妥');
    await page.getByTestId('blacklist-lift-confirm').click();
    await expect(page.getByText(`已解除「${name}」的黑名单`)).toBeVisible();
    await expect(page.getByTestId('blacklist-pane').locator('li').filter({ hasText: name })).toHaveCount(0);
    // 连已经解除的一起看：留着痕
    await page.getByText('连已经解除的一起看').click();
    await expect(page.getByTestId('blacklist-list').locator('li').filter({ hasText: name })).toContainText('已解除');

    // 解除以后照常发牌
    await page.goto('/frontdesk');
    await openCheckin(page);
    await page.getByRole('radio', { name: '会员' }).click();
    await page.getByLabel('查找会员').fill(name);
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await expect(page.getByTestId('checkin-member')).toContainText(name);
    await expect(page.getByTestId('risk-blacklist')).toHaveCount(0);
    await page.getByTestId('guest-row-0').getByLabel('第 1 位牌号').fill(t!.code);
    await page.getByTestId('checkin-submit').click();
    await expect(page.getByText(`已发牌 ${t!.code}`)).toBeVisible();
    await cleanup(page.request, (await visitOn(page.request, t!.code))!.id);
  });

  test('未结离店：记待办 → 下次发牌要当场授权 → 授权后发出，授权人记在来访上；待办由值班经理写处理结果', async ({ page, browser, baseURL }) => {
    await login(page, 'xiaozhou');
    const duty = await apiAs(browser, baseURL, 'zhangjl');
    const name = `未结用例${String(Date.now()).slice(-5)}`;
    const m = await newMember(page.request, name);
    const [t1, t2] = await freeTags(page.request);
    const first = await checkin(page.request, t1!.code, m.id);
    const todosBefore = (await board(page.request)).risk.openTodos;

    // 客人卡 → 异常处置 → 未结离店
    await page.goto(`/frontdesk?v=${first}`);
    await expect(page.getByTestId('bill-tag')).toHaveText(t1!.code);
    await page.getByTestId('action-incident').click();
    await page.getByTestId('incident-action-unsettled').click();
    await page.getByTestId('incident-amount').fill('88');
    await page.getByTestId('incident-note').fill('客人没结账就走了');
    await page.getByTestId('incident-submit').click();
    await expect(page.getByText(`${t1!.code} 已记：未结离店`)).toBeVisible();
    // 手牌卡片与客人卡上数得出待办；发卡台顶上的「异常待办」写着条数
    await expect(page.getByTestId(`tag-${t1!.code}-todo`)).toContainText('待办');
    await expect(page.getByTestId('bill-todo')).toBeVisible();
    await expect(page.getByTestId('incident-todo-count')).toHaveText(`${todosBefore + 1} 条`);
    await page.getByTestId('open-incident-todos').click();
    const todo = page.getByTestId('todo-list').locator('li').filter({ hasText: name });
    await expect(todo).toContainText('未结离店');
    await expect(todo).toContainText('¥88.00');
    await expect(todo).toContainText('还在店');
    // 未结离店的处理结果店员写不了
    await expect(todo.getByRole('button', { name: '写处理结果' })).toBeDisabled();
    await page.keyboard.press('Escape');

    // 这张牌撤掉以后（客人走了），这位会员再来：发牌要当场授权
    await cleanup(page.request, first);
    await page.goto('/frontdesk');
    await openCheckin(page);
    await page.getByRole('radio', { name: '会员' }).click();
    await page.getByLabel('查找会员').fill(name);
    await page.getByRole('button', { name: new RegExp(name) }).click();
    const unsettled = page.getByTestId('risk-unsettled');
    await expect(unsettled).toContainText('上次未结离店，发牌要当场授权');
    await expect(unsettled).toContainText('¥88.00');
    // 今天来过一次（撤销的不算，所以这里没有「第 2 次到店」）
    await page.getByTestId('guest-row-0').getByLabel('第 1 位牌号').fill(t2!.code);
    await expect(page.getByTestId('checkin-submit')).toBeDisabled();
    await unsettled.getByRole('button', { name: '客人答应当场补交' }).click();
    await page.getByTestId('request-risk-authorize').click();
    await authorize(page, '前台风控');
    await expect(unsettled).toContainText('已由张经理当场授权放行');
    await page.getByTestId('checkin-submit').click();
    await expect(page.getByText(`已发牌 ${t2!.code}`)).toBeVisible();
    // 授权人、原因记在来访上，客人卡上写着
    await expect(page.getByTestId('bill-risk-approval')).toContainText('张经理');
    await expect(page.getByTestId('bill-risk-approval')).toContainText('客人答应当场补交');
    const second = (await visitOn(page.request, t2!.code))!.id;
    expect((await getJson<Visit>(page.request, `/api/frontdesk/visits/${second}`)).riskApproval).toMatchObject({ byName: '张经理', reason: '客人答应当场补交' });

    // 值班经理写处理结果：待办没了，这位会员再发牌不用授权
    const list = await getJson<{ todos: { id: number; memberName: string | null }[] }>(duty, '/api/frontdesk/incidents/todos');
    const mine = list.todos.find((x) => x.memberName === name)!;
    await send(duty, 'post', `/api/frontdesk/incidents/${mine.id}/resolve`, { note: '客人已补交' });
    expect((await board(page.request)).risk.openTodos).toBe(todosBefore);
    await cleanup(page.request, second);
    const risk = await getJson<{ unsettled: unknown[] }>(page.request, `/api/frontdesk/members/${m.id}/risk`);
    expect(risk.unsettled).toEqual([]);
  });

  test('异常处置：提醒、外出与返回、凭授权加收、上报进待办（改派、写处理结果）、手牌丢失进换牌', async ({ page }) => {
    await login(page, 'xiaozhou');
    const [t] = await freeTags(page.request);
    const visitId = await checkin(page.request, t!.code);
    try {
      await page.goto(`/frontdesk?v=${visitId}`);
      await expect(page.getByTestId('bill-tag')).toHaveText(t!.code);
      await expect(page.getByTestId('bill-incidents')).toContainText('没有异常记录');
      const open = async (action: string) => {
        await page.getByTestId('action-incident').click();
        await expect(page.getByRole('heading', { name: `异常处置 · ${t!.code}` })).toBeVisible();
        await page.getByTestId(`incident-action-${action}`).click();
      };

      // 提醒
      await open('remind');
      await page.getByRole('button', { name: '已当面提醒' }).click();
      await page.getByTestId('incident-submit').click();
      await expect(page.getByText(`${t!.code} 已记：已提醒`)).toBeVisible();
      await expect(page.getByTestId('bill-incidents')).toContainText('异常记录 1 条');

      // 临时外出：手牌卡片与客人卡上写着外出；这张牌照旧占着
      await open('away');
      await page.getByTestId('incident-note').fill('出去吃饭');
      await page.getByTestId('incident-submit').click();
      await expect(page.getByText(`${t!.code} 已标外出，手牌仍占用`)).toBeVisible();
      await expect(page.getByTestId(`tag-${t!.code}-away`)).toHaveText('外出');
      await expect(page.getByTestId('bill-away')).toHaveText('外出');
      await expect(page.getByTestId(`tag-${t!.code}`)).toHaveAttribute('data-state', 'in_use');
      // 返回
      await page.getByTestId('action-incident').click();
      await expect(page.getByTestId('incident-action-away')).toContainText('返回');
      await page.getByTestId('incident-action-away').click();
      await page.getByTestId('incident-submit').click();
      await expect(page.getByText(`${t!.code} 已返回`)).toBeVisible();
      await expect(page.getByTestId(`tag-${t!.code}-away`)).toHaveCount(0);

      // 超时加收：店员要值班经理当场授权；账单上多一条「超时加收」
      await open('surcharge');
      await page.getByTestId('incident-amount').fill('50');
      await page.getByRole('button', { name: '超 12 小时加收' }).click();
      await expect(page.getByTestId('incident-submit')).toBeDisabled();
      await page.getByTestId('request-authorize').click();
      await authorize(page, '前台风控');
      await page.getByTestId('incident-submit').click();
      await expect(page.getByText(`已加收 ¥50.00，挂到 ${t!.code}`)).toBeVisible();
      await expect(page.getByTestId('receipt')).toContainText('超时加收');
      await expect(page.getByTestId('bill-total')).toContainText('50.00');

      // 上报：指给一位责任人，进「异常待办」
      await open('report');
      await page.getByTestId('incident-note').fill('客人在大厅睡了一夜，叫不醒');
      await page.getByTestId('incident-assignee').selectOption({ label: '张经理（值班经理）' });
      await page.getByTestId('incident-submit').click();
      await expect(page.getByText(`${t!.code} 已记：上报`)).toBeVisible();
      await expect(page.getByTestId(`tag-${t!.code}-todo`)).toBeVisible();
      await page.getByTestId('open-incident-todos').click();
      const todo = page.getByTestId('todo-list').locator('li').filter({ hasText: '客人在大厅睡了一夜' });
      await expect(todo).toContainText('上报');
      await expect(todo.getByRole('combobox')).toHaveValue(/\d+/);
      // 改派给店主
      await todo.getByRole('combobox').selectOption({ label: '林岚（店主）' });
      await expect(page.getByText('已指给林岚')).toBeVisible();
      // 写处理结果（上报的店员就能写），写完从待办里走了
      await todo.getByRole('button', { name: '写处理结果' }).click();
      await todo.getByLabel('处理结果').fill('已叫醒，客人去结账了');
      await todo.getByRole('button', { name: '确认处理完' }).click();
      await expect(page.getByText(`${t!.code} 的上报已处理`)).toBeVisible();
      await expect(page.getByTestId('todo-list').locator('li').filter({ hasText: '客人在大厅睡了一夜' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(`tag-${t!.code}-todo`)).toHaveCount(0);

      // 这次来访已经记过的：都在「异常处置」里列着，也进了经办记录
      await page.getByTestId('action-incident').click();
      const list = page.getByTestId('incident-list');
      for (const text of ['已提醒', '临时外出', '返回', '超时加收', '上报', '已处理']) await expect(list).toContainText(text);
      await expect(list).toContainText('由张经理当场授权');

      // 手牌丢失：进换牌，原因、锁定原手牌预先选好
      await page.getByTestId('incident-action-lost').click();
      await page.getByTestId('incident-lost-go').click();
      const swap = page.getByRole('dialog').filter({ hasText: `手牌丢失 · 换牌 · ${t!.code}` });
      await expect(swap).toBeVisible();
      await expect(swap.getByPlaceholder('或填写其他原因')).toHaveValue('手牌丢失');
      await expect(swap.getByTestId('reader-status')).toBeVisible();
      await swap.getByRole('button', { name: '取消' }).click();
    } finally {
      await cleanup(page.request, visitId);
    }
  });

  test('超时分级与芯片号：超 12 / 24 小时的手牌卡片、收银台清单带字的色标；后台手牌池绑定、解绑芯片号', async ({ page }) => {
    await login(page, 'zhangjl');
    // 按纸质单补录两位早就进店的客人：一位 13 小时前、一位 25 小时前；再发一位刚进店的
    const { tag: a, visitId: v13 } = await checkinAgo(page.request, 13, []);
    const { tag: b, visitId: v25 } = await checkinAgo(page.request, 25, [a.code]);
    const c = (await freeTags(page.request))[0];
    const fresh = await checkin(page.request, c!.code);
    try {
      await page.goto('/frontdesk');
      await expect(page.getByTestId(`tag-${a!.code}-overstay`)).toHaveText('超 12 小时');
      await expect(page.getByTestId(`tag-${a!.code}-overstay`)).toHaveAttribute('data-tone', 'yuzu');
      await expect(page.getByTestId(`tag-${b!.code}-overstay`)).toHaveText('超 24 小时');
      await expect(page.getByTestId(`tag-${b!.code}-overstay`)).toHaveAttribute('data-tone', 'ember');
      await expect(page.getByTestId(`tag-${c!.code}-overstay`)).toHaveCount(0);
      // 字不小于 16 像素
      expect(await page.getByTestId(`tag-${a!.code}-overstay`).evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await page.getByTestId(`tag-${b!.code}`).click();
      await expect(page.getByTestId('bill-overstay')).toHaveText('超 24 小时');

      // 收银台的待结账清单一样；「超 12 小时」的筛选只留超时的
      await page.goto('/cashier');
      await expect(page.getByTestId(`queue-${a!.code}-overstay`)).toHaveText('超 12 小时');
      await expect(page.getByTestId(`queue-${b!.code}-overstay`)).toHaveText('超 24 小时');
      await page.getByRole('radio', { name: '超 12 小时' }).click();
      await expect(page.getByTestId(`queue-${a!.code}`)).toBeVisible();
      await expect(page.getByTestId(`queue-${c!.code}`)).toHaveCount(0);

      // 后台手牌池：点一张牌绑定芯片号（键盘式读卡器把卡号打进框里），再解绑
      const uid = cardUid();
      await page.goto('/admin/tags/pool');
      await page.getByTestId(`admin-tag-${c!.code}`).click();
      await expect(page.getByTestId('tag-card-none')).toBeVisible();
      await page.getByTestId('tag-card-bind').click();
      await page.getByTestId('tag-card-input').click();
      await page.keyboard.type(uid.toLowerCase(), { delay: 3 });
      await page.getByTestId('tag-card-save').click();
      await expect(page.getByText(`${c!.code} 已绑定芯片号 ${uid}`)).toBeVisible();
      await expect(page.getByTestId(`admin-tag-${c!.code}`)).toHaveAttribute('data-card', uid);
      // 同一张卡不能再绑到别的牌上
      await page.getByTestId(`admin-tag-${a!.code}`).click();
      await page.getByTestId('tag-card-bind').click();
      await page.getByTestId('tag-card-input').fill(uid);
      await page.getByTestId('tag-card-save').click();
      await expect(page.getByTestId('reader-message')).toContainText(`这张卡已经绑在手牌 ${c!.code} 上`);
      await page.keyboard.press('Escape');
      await page.getByTestId(`admin-tag-${c!.code}`).click();
      await expect(page.getByTestId('tag-card-uid')).toHaveText(uid);
      await page.getByTestId('tag-card-unbind').click();
      await expect(page.getByText(`${c!.code} 已解绑芯片号`)).toBeVisible();
      await expect(page.getByTestId(`admin-tag-${c!.code}`)).toHaveAttribute('data-card', '');
    } finally {
      for (const id of [v13, v25, fresh]) await cleanup(page.request, id);
      for (const t of [a, c]) await send(page.request, 'put', `/api/frontdesk/tags/${t!.id}/card`, { cardUid: null });
    }
  });

  // 四种屏幕（docs/DEVICES.md）：商米 D3 Pro 1920×1080 与缩放后的 1280×720、商米 V3 约 360×800、小米平板 1355×903
  for (const d of [
    { name: '1920×1080', viewport: { width: 1920, height: 1080 }, mobile: false },
    { name: '1280×720', viewport: { width: 1280, height: 720 }, mobile: false },
    { name: '360×800', viewport: { width: 360, height: 800 }, mobile: true },
    { name: '1355×903', viewport: { width: 1355, height: 903 }, mobile: false },
  ]) {
    test(`四种屏幕 · ${d.name}：接待发牌、异常处置、异常待办放得下，要点的按钮在屏幕里`, async ({ browser, baseURL }) => {
      const ctx = await browser.newContext({ baseURL, viewport: d.viewport, hasTouch: true, isMobile: d.mobile, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
      const page = await ctx.newPage();
      await login(page, 'linlan');
      const [t, u] = await freeTags(page.request);
      const visitId = await checkin(page.request, t!.code);
      await send(page.request, 'post', `/api/frontdesk/visits/${visitId}/incidents`, { clientKey: randomUUID(), kind: 'report', note: '四种屏幕用例的一条上报' });
      const inView = async (testId: string) => {
        const box = await page.getByTestId(testId).boundingBox();
        expect(box, testId).toBeTruthy();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(d.viewport.width + 1);
        expect(box!.y + box!.height).toBeLessThanOrEqual(d.viewport.height + 1);
      };
      try {
        // 接待发牌：读卡器状态那一行、风控提示都在；确认发牌在屏幕里
        await page.goto('/frontdesk');
        await expect(page.getByTestId('tag-board')).toBeVisible();
        await page.getByTestId('open-checkin').click();
        await expect(page.getByTestId('reader-line')).toBeVisible();
        await page.getByTestId('guest-row-0').getByLabel('第 1 位牌号').fill(u!.code);
        await expectFits(page);
        await inView('checkin-submit');
        expect((await page.getByTestId('checkin-submit').boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await page.getByRole('button', { name: '取消' }).click();

        // 异常待办
        await page.getByTestId('open-incident-todos').click();
        await expect(page.getByTestId('todo-list')).toBeVisible();
        await expectFits(page);
        await page.keyboard.press('Escape');

        // 客人卡 → 异常处置：六个处置方式、提交按钮
        await page.goto(`/frontdesk?v=${visitId}`);
        await expect(page.getByTestId('bill-tag')).toHaveText(t!.code);
        await expectFits(page);
        await page.getByTestId('action-incident').click();
        await page.getByTestId('incident-action-surcharge').click();
        await expectFits(page);
        await inView('incident-submit');
        expect((await page.getByTestId('incident-submit').boundingBox())!.height).toBeGreaterThanOrEqual(44);
        for (const a of ['remind', 'surcharge', 'report', 'away', 'lost', 'unsettled']) await expect(page.getByTestId(`incident-action-${a}`)).toBeVisible();
      } finally {
        const todos = await getJson<{ todos: { id: number; visitId: number }[] }>(page.request, '/api/frontdesk/incidents/todos');
        for (const x of todos.todos.filter((y) => y.visitId === visitId)) await send(page.request, 'post', `/api/frontdesk/incidents/${x.id}/resolve`, { note: '浏览器用例收尾' });
        await cleanup(page.request, visitId);
        await ctx.close();
      }
    });
  }
});
