// 8.1.16 浏览器验收：技师（《浴族系统需求汇总》技师 1–3，docs/TECHNICIANS_V8115.md）。
//   ① 钟房：搜索（姓名、工号、花名、拼音首字母）、按类型与可做项目叠加筛选（写明现在生效的、能一项项去掉、一键清空）、按状态排；
//   ② 排位播报（8.2.0 起是单独的页面）：另一台终端在播时本机不出声 → 由本机接管 → 音量、试音、静音（静音时写明、没念的条数）、取消静音以后手动叫号照常念、重播 →
//      不由本机播报。语音换成浏览器里记录调用的假实现（不真的出声）；
//   ③ 技师管理四个页签：名册（拼音首字母搜索、按类型看、新建、编辑、类型清单）、组别（新建、组长）、
//      班次（新建班次、下周排班、临时调班要写原因、改动记录）、休假（申请 → 批准含今天的 → 钟房里是休假、不进排位 → 销假回到未上牌）。
// 依赖四套演示数据（仅独立演示库）；账号：店主 linlan，密码 yuzu2026。
// 用自己的三位技师（T1、T2、T3，没有就建、有就照下面的样子改回来）与「E2E 技师足疗」项目；每次新建的组别、班次、技师带这一次的后缀，
// 结束时（含失败）停用；三位技师下牌；技师类型的清单、技师功能的开关、主播报终端都恢复成开始时的样子。可重复执行。
import { expect, test, type Page } from '@playwright/test';
import type { ClockroomBoard } from '../src/shared/clockroom';
import type { TechLeave, TechnicianAdminView } from '../src/shared/technician-admin';
import { clickNav } from './nav';

const PASSWORD = 'yuzu2026';
const ITEM = 'E2E 技师足疗';
const CATEGORY = 'E2E 技师';
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const TECHS = [
  { techNo: 'T1', name: '张小明', nickname: '小雅', kind: '足浴', gender: 'female', grade: 'standard', skills: [CATEGORY] },
  { techNo: 'T2', name: '李芳', nickname: '', kind: '按摩', gender: 'female', grade: 'professional', skills: [] as string[] },
  { techNo: 'T3', name: '王强', nickname: '阿强', kind: '足浴', gender: 'male', grade: 'standard', skills: ['E2E 修脚'] },
] as const;
const MINE = TECHS.map((t) => t.techNo) as string[];

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
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

type AdminTech = { id: number; techNo: string; name: string; active: boolean };
const board = (page: Page) => getJson<ClockroomBoard>(page, '/api/clockroom');
const mine = async (page: Page) => (await board(page)).technicians.filter((t) => MINE.includes(t.techNo));
const stateOf = async (page: Page, techNo: string) => (await board(page)).technicians.find((t) => t.techNo === techNo)!;

/** 朗读换成假的：念了什么（与音量）记在 window.__spoken 里，不真的出声 */
async function fakeSpeech(page: Page) {
  await page.addInitScript(() => {
    const spoken: { text: string; volume: number }[] = [];
    (window as unknown as { __spoken: typeof spoken }).__spoken = spoken;
    class FakeUtterance {
      text: string;
      volume = 1;
      rate = 1;
      lang = '';
      voice: unknown = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    const fake = {
      speaking: false,
      pending: false,
      paused: false,
      getVoices: () => [{ lang: 'zh-CN', name: 'E2E Xiaoxiao', localService: true, default: true, voiceURI: 'e2e' }],
      speak(u: FakeUtterance) {
        spoken.push({ text: u.text, volume: u.volume });
        setTimeout(() => {
          u.onstart?.();
          u.onend?.();
        }, 5);
      },
      cancel() {},
      resume() {},
      pause() {},
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
  });
}
const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: { text: string; volume: number }[] }).__spoken.filter((s) => s.text));

/**
 * 店主准备：专用项目（需要技师、分类「E2E 技师」）、三位技师照 TECHS 的样子；开着技师功能；
 * 三位的状态：T1 在岗（空闲）、T2 休息、T3 未上牌；上一轮没走完的休假单撤掉 / 销掉。返回开始时技师功能开没开、类型清单
 */
async function prepare(page: Page) {
  const before = await getJson<{ rules: { enabled: boolean } }>(page, '/api/admin/technicians');
  const itemBody = { name: ITEM, category: CATEGORY, prices: { standard: 19800, professional: 23800, premium: 29800 } };
  let item = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM);
  if (!item || !item.active) {
    await (item ? send(page, 'put', `/api/items/${item.id}`, { ...itemBody, active: true }) : send(page, 'post', '/api/items', itemBody));
    item = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items.find((i) => i.name === ITEM)!;
  }
  await send(page, 'put', '/api/admin/technicians/items', { items: [{ id: item.id, required: true }] });
  await send(page, 'put', '/api/admin/technicians/rules', { enabled: true });
  const kinds = (await getJson<TechnicianAdminView>(page, '/api/technician-admin')).kinds;
  const roster = (await getJson<{ technicians: AdminTech[] }>(page, '/api/admin/technicians')).technicians;
  for (const t of TECHS) {
    const body = { name: t.name, nickname: t.nickname, kind: t.kind, gender: t.gender, grade: t.grade, skills: [...t.skills], active: true };
    const old = roster.find((x) => x.techNo === t.techNo);
    await (old ? send(page, 'put', `/api/admin/technicians/${old.id}`, body) : send(page, 'post', '/api/admin/technicians', { ...body, techNo: t.techNo }));
  }
  // 上一轮没走完的休假单：待审批的撤回、已批准的销假
  for (const l of await getJson<TechLeave[]>(page, '/api/technician-admin/leaves')) {
    if (!MINE.includes(l.techNo) || (l.status !== 'pending' && l.status !== 'approved')) continue;
    await send(page, 'post', `/api/technician-admin/leaves/${l.id}/cancel`, { reason: 'E2E：上一轮没走完' });
  }
  const act = (id: number, action: string) => send(page, 'post', `/api/clockroom/technicians/${id}/state`, { action });
  for (const t of await mine(page)) {
    if (t.busy) throw new Error(`${t.techNo} 号还有没走完的钟，请先在钟房处理`);
    const want = t.techNo === 'T1' ? 'on' : t.techNo === 'T2' ? 'rest' : 'off';
    if (t.state === 'leave') await act(t.id, 'sign_out');
    const now = (await stateOf(page, t.techNo)).state;
    if (want === 'off' && (now === 'on' || now === 'rest')) await act(t.id, 'sign_out');
    if (want !== 'off' && now === 'off') await act(t.id, 'sign_in');
    if (want === 'on' && now === 'rest') await act(t.id, 'back');
    if (want === 'rest' && (await stateOf(page, t.techNo)).state === 'on') await act(t.id, 'rest');
  }
  expect((await mine(page)).map((t) => `${t.techNo}:${t.state}`).sort()).toEqual(['T1:on', 'T2:rest', 'T3:off']);
  return { enabled: before.rules.enabled, kinds };
}

/** 收尾：自己的三位技师都下牌（不占轮钟排位，不影响别的流程派轮钟） */
async function signOutMine(page: Page) {
  for (const t of await mine(page)) {
    if (!t.busy && (t.state === 'on' || t.state === 'rest' || (t.state === 'leave' && !t.approvedLeave))) {
      await page.request.post(`/api/clockroom/technicians/${t.id}/state`, { data: { action: 'sign_out' } });
    }
  }
}

test.describe('8.1.16 技师：钟房搜索筛选、排位播报、技师管理', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改技师与规则的流程只在门店电脑尺寸执行一次');
  test.setTimeout(240_000);

  test('钟房：搜索与叠加筛选、按状态排；排位播报（接管、音量、试音、静音、手动叫号、重播）', async ({ page }) => {
    await fakeSpeech(page);
    await login(page, 'linlan');
    const before = await prepare(page);
    try {
      // 另一台终端在播：本机不出声
      await send(page, 'post', '/api/clockroom/announcer', { action: 'claim', clientId: 'e2e-other-terminal', label: 'E2E 另一台' });
      await page.goto('/');
      await clickNav(page, '钟房');
      // 8.2.0 P03：钟房里没有播报条了（在「技师 → 排位播报」），只有一条提示
      await expect(page.getByTestId('announcer-bar')).toHaveCount(0);

      // ① 搜索：拼音首字母、花名、工号、姓名；有条件时列技师卡片，写明现在生效的
      const search = page.getByTestId('clock-search');
      const cards = page.getByTestId(/^clock-tech-T\d$/);
      for (const [text, hit] of [
        ['zxm', 'T1'],
        ['小雅', 'T1'],
        ['T3', 'T3'],
        ['aq', 'T3'],
        ['李芳', 'T2'],
      ] as const) {
        await search.fill(text);
        await expect(page.getByTestId('clock-active-text')).toContainText(`搜索「${text}」`);
        await expect(cards).toHaveCount(1);
        await expect(page.getByTestId(`clock-tech-${hit}`)).toBeVisible();
      }
      await search.fill('');
      await expect(page.getByTestId('clockroom')).toBeVisible();

      // 类型、项目叠加：足浴（T1、T3）且能做「E2E 技师」（T1；T3 只做「E2E 修脚」）→ 只剩 T1；去掉类型 → T1、T2（T2 没设可做分类，算全都做）
      await page.getByTestId('clock-more-filters').click();
      await page.getByTestId('clock-kind-足浴').click();
      await expect(page.getByTestId('clock-tech-T1')).toBeVisible();
      await expect(page.getByTestId('clock-tech-T3')).toBeVisible();
      await expect(page.getByTestId('clock-tech-T2')).toHaveCount(0);
      await page.getByTestId(`clock-category-${CATEGORY}`).click();
      const active = page.getByTestId('clock-active-filters');
      await expect(active.getByTestId('clock-active-kind-足浴')).toContainText('类型：足浴');
      await expect(active.getByTestId(`clock-active-category-${CATEGORY}`)).toContainText(`项目：${CATEGORY}`);
      await expect(page.getByTestId('clock-tech-T1')).toBeVisible();
      await expect(page.getByTestId('clock-tech-T3')).toHaveCount(0);
      await active.getByTestId('clock-active-kind-足浴').click();
      await expect(page.getByTestId('clock-tech-T2')).toBeVisible();
      await expect(page.getByTestId('clock-tech-T3')).toHaveCount(0);
      // 再叠一个状态：休息 → 只剩 T2
      await page.getByTestId('clock-filter-rest').click();
      await expect(cards).toHaveCount(1);
      await expect(page.getByTestId('clock-tech-T2')).toHaveAttribute('data-status', 'rest');
      await page.getByTestId('clock-filters-clear').click();
      await expect(page.getByTestId('clock-active-filters')).toHaveCount(0);
      await expect(page.getByTestId('clockroom')).toBeVisible();

      // ② 按状态排：空闲（T1）在休息（T2）前面，休息在未上牌（T3）前面
      await page.getByTestId('clock-sort-status').click();
      await expect(page.getByTestId('clock-active-sort')).toContainText('按状态');
      await expect(page.getByTestId('clock-tech-T3')).toBeVisible();
      const order = (await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.replace('clock-tech-', '')))).filter((no) => MINE.includes(no));
      expect(order).toEqual(['T1', 'T2', 'T3']);
      await expect(page.getByTestId('clock-tech-T1')).toHaveAttribute('data-status', 'idle');
      await expect(page.getByTestId('clock-tech-T3')).toHaveAttribute('data-status', 'off');
      await page.getByTestId('clock-active-sort').click();
      await expect(page.getByTestId('clockroom')).toBeVisible();

      // ③ 排位播报页（8.2.0 P03 起单独一页）：另一台在播时本机不出声；手动叫号记下叫号，本机不出声
      await clickNav(page, '排位播报');
      const bar = page.getByTestId('announcer-bar');
      await expect(bar).toHaveAttribute('data-announcer', 'other');
      await expect(bar.getByTestId('announcer-other')).toContainText('E2E 另一台');
      await page.getByTestId('announcer-call-T1').click();
      await expect(page.getByText('已叫 T1 号')).toBeVisible();
      await expect(bar.getByTestId('announcer-last')).toContainText('T1 号 小雅');
      expect(await spoken(page)).toEqual([]);

      // ④ 由本机接管：念一句「本机开始播报叫号」；音量调到 50，试音按这个音量念
      await bar.getByTestId('announcer-takeover').click();
      await expect(bar).toHaveAttribute('data-announcer', 'on');
      await expect(bar.getByTestId('announcer-state')).toHaveText('本机播报中');
      await expect.poll(async () => (await spoken(page)).map((s) => s.text)).toEqual(['本机开始播报叫号']);
      await bar.getByTestId('announcer-volume').fill('50');
      await bar.getByTestId('announcer-test').click();
      await expect.poll(async () => (await spoken(page)).at(-1)).toEqual({ text: '排位播报试音', volume: 0.5 });

      // ⑤ 静音：整条写明「已静音」，叫号不出声，记着没念的条数
      await bar.getByTestId('announcer-mute').click();
      await expect(bar).toHaveAttribute('data-announcer', 'muted');
      await expect(bar.getByTestId('announcer-muted')).toHaveText('已静音：叫号不会出声');
      const quiet = (await spoken(page)).length;
      await page.getByTestId('announcer-call-T1').click();
      await expect(bar).toContainText('静音期间有 1 次叫号没有念');
      expect(await spoken(page)).toHaveLength(quiet);
      await expect(bar.getByTestId('announcer-replay')).toBeDisabled();

      // ⑥ 取消静音以后，手动叫号照常念（排位号、工号、花名，没有房间念「准备上钟」）；重播再念一次
      await bar.getByTestId('announcer-mute').click();
      await expect(bar).toHaveAttribute('data-announcer', 'on');
      await page.getByTestId('announcer-call-T1').click();
      await expect.poll(async () => (await spoken(page)).at(-1)?.text ?? '').toMatch(/^请 \d+ 号排位，T1 号 小雅，准备上钟$/);
      const said = (await spoken(page)).at(-1)!;
      expect(said.volume).toBe(0.5);
      const count = (await spoken(page)).length;
      await bar.getByTestId('announcer-replay').click();
      await expect.poll(async () => (await spoken(page)).length).toBe(count + 1);
      expect((await spoken(page)).at(-1)!.text).toBe(said.text);
      const calls = (await board(page)).calls.filter((c) => c.text.includes('T1 号 小雅'));
      expect(calls.length).toBeGreaterThanOrEqual(3);
      expect(calls.at(-1)!.kind).toBe('manual');

      // ⑦ 不由本机播报：回到「还没有终端负责播报」
      await bar.getByTestId('announcer-release').click();
      await expect(bar).toHaveAttribute('data-announcer', 'none');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    } finally {
      const claim = (await board(page)).announcer;
      if (claim?.clientId === 'e2e-other-terminal') await page.request.post('/api/clockroom/announcer', { data: { action: 'release', clientId: 'e2e-other-terminal' } });
      await signOutMine(page);
      await page.request.put('/api/admin/technicians/rules', { data: { enabled: before.enabled } });
    }
  });

  test('技师管理：名册、组别、班次（排班、临时调班）、休假（批了当天不进排位，销假回到未上牌）', async ({ page }) => {
    await login(page, 'linlan');
    const before = await prepare(page);
    const NEW_NO = `N${RUN}`;
    const GROUP = `E2E 组 ${RUN}`;
    const SHIFT = `E2E班${RUN}`;
    try {
      await page.goto('/');
      await clickNav(page, '技师管理');
      await expect(page.getByTestId('technician-admin')).toBeVisible();

      // ① 名册：拼音首字母搜索、按类型看；新建一位（花名、类型）；编辑 T1 的入职日期；类型清单加一个
      await page.getByTestId('tech-tab-roster').click();
      await page.getByTestId('tech-roster-search').fill('zxm');
      await expect(page.getByTestId('tech-roster-T1')).toContainText('小雅');
      await expect(page.getByTestId('tech-roster-T2')).toHaveCount(0);
      await page.getByTestId('tech-roster-search').fill('');
      await page.getByRole('group', { name: '按类型看' }).getByRole('button', { name: /^按摩/ }).click();
      await expect(page.getByTestId('tech-roster-T2')).toBeVisible();
      await expect(page.getByTestId('tech-roster-T1')).toHaveCount(0);
      await page.getByRole('group', { name: '按类型看' }).getByRole('button', { name: /^全部/ }).click();
      await page.getByTestId('tech-roster-new').click();
      await page.getByTestId('technician-no').fill(NEW_NO);
      await page.getByTestId('technician-name').fill(`E2E 新技师 ${RUN}`);
      await page.getByTestId('technician-nickname').fill('小新');
      await page.getByTestId('technician-kind').selectOption('SPA');
      await page.getByTestId('technician-save').click();
      await expect(page.getByText(`已添加技师 ${NEW_NO} 号 E2E 新技师 ${RUN}`)).toBeVisible();
      await expect(page.getByTestId(`tech-roster-${NEW_NO}`)).toContainText('SPA');
      await page.getByTestId('tech-roster-edit-T1').click();
      await page.getByTestId('technician-hired').fill('2026-03-01');
      await page.getByTestId('technician-save').click();
      await expect(page.getByTestId('tech-roster-T1')).toContainText('2026-03-01');
      await page.getByTestId('tech-kinds-edit').click();
      await page.getByTestId('tech-kind-new').fill(`修脚${RUN}`);
      await page.getByTestId('tech-kind-add').click();
      await page.getByTestId('tech-kinds-save').click();
      await expect(page.getByText('技师类型的清单已保存')).toBeVisible();
      await expect(page.getByRole('group', { name: '按类型看' })).toContainText(`修脚${RUN}`);

      // ② 组别：新建，组员 T1、T3，组长 T1；名册与钟房跟着显示组别
      await page.getByTestId('tech-tab-groups').click();
      await page.getByTestId('tech-group-new').click();
      await page.getByTestId('tech-group-name').fill(GROUP);
      await page.getByTestId('tech-group-member-T1').click();
      await page.getByTestId('tech-group-member-T3').click();
      const ids = Object.fromEntries((await mine(page)).map((t) => [t.techNo, t.id]));
      await page.getByTestId('tech-group-leader').selectOption(String(ids.T1));
      await page.getByTestId('tech-group-save').click();
      const card = page.getByTestId(`tech-group-${GROUP}`);
      await expect(card).toContainText('2 人');
      await expect(card).toContainText('组长：T1 号 张小明');
      expect((await stateOf(page, 'T3')).groupName).toBe(GROUP);

      // ③ 班次：新建班次 → 下周一给 T1 排上 → 改成排休要写原因（记成临时调班）→ 改动记录里都有
      await page.getByTestId('tech-tab-shifts').click();
      await page.getByTestId('tech-shift-new').click();
      await page.getByTestId('tech-shift-name').fill(SHIFT);
      await page.getByTestId('tech-shift-start').fill('10:00');
      await page.getByTestId('tech-shift-end').fill('18:00');
      await page.getByTestId('tech-shift-save').click();
      await expect(page.getByTestId(`tech-shift-${SHIFT}`)).toContainText('10:00–18:00');
      await page.getByTestId('tech-schedule-next').click();
      const nextMonday = await page
        .getByTestId(/^tech-cell-T1-/)
        .first()
        .evaluate((el) => el.getAttribute('data-testid')!.replace('tech-cell-T1-', ''));
      const cell = page.getByTestId(`tech-cell-T1-${nextMonday}`);
      await cell.click();
      await page.getByTestId(`tech-cell-choice-${SHIFT}`).click();
      await page.getByTestId('tech-cell-save').click();
      await expect(cell).toContainText(SHIFT);
      await cell.click();
      await page.getByTestId('tech-cell-choice-排休').click();
      await page.getByTestId('tech-cell-reason').fill('E2E：临时有事');
      await page.getByTestId('tech-cell-save').click();
      await expect(cell).toContainText('排休');
      const changes = page.getByTestId('tech-schedule-changes');
      await expect(changes).toContainText('临时调班');
      await expect(changes).toContainText(`${SHIFT} → 排休`);
      await expect(changes).toContainText('原因：E2E：临时有事');

      // ④ 休假：替 T2 申请今天一天 → 批准（含今天）→ 钟房里 T2 是休假、不在排位里 → 销假回到未上牌
      await page.getByTestId('tech-tab-leaves').click();
      await page.getByTestId('tech-leave-new').click();
      await page.getByTestId('tech-leave-tech').selectOption(String(ids.T2));
      await page.getByTestId('tech-leave-reason').fill('E2E：家里有事');
      await page.getByTestId('tech-leave-save').click();
      await expect(page.getByText('已替 T2 号申请休假')).toBeVisible();
      const leave = (await getJson<TechLeave[]>(page, '/api/technician-admin/leaves?status=pending')).find((l) => l.techNo === 'T2')!;
      const row = page.getByTestId(`tech-leave-${leave.id}`);
      await expect(row).toHaveAttribute('data-status', 'pending');
      await row.getByTestId(`tech-leave-approve-${leave.id}`).click();
      await expect(page.getByRole('dialog')).toContainText('这张休假含今天');
      await page.getByTestId('tech-leave-action-confirm').click();
      await expect(page.getByTestId(`tech-leave-status-${leave.id}`)).toHaveText('已批准');
      const t2 = await stateOf(page, 'T2');
      expect(t2).toMatchObject({ state: 'leave', position: null });
      expect(t2.approvedLeave?.id).toBe(leave.id);

      await page.goto('/clockroom');
      await expect(page.getByTestId('clock-leave-T2')).toBeVisible();
      await expect(page.getByTestId('clock-leave-approved-T2')).toBeVisible();
      await expect(page.getByTestId('clock-queue-T2')).toHaveCount(0);
      await expect(page.getByTestId('clock-queue-T1')).toBeVisible();
      // 钟房里不能直接给休假单里的人上牌：按状态筛出来的卡片写明去销假
      await page.getByTestId('clock-filter-leave').click();
      await expect(page.getByTestId('clock-tech-leave-T2')).toContainText('到技师管理销假');
      await expect(page.getByTestId('clock-tech-sign_in-T2')).toHaveCount(0);

      await page.goto('/technicians/leaves');
      await page.getByTestId('tech-leaves-filter-all').click();
      await page.getByTestId(`tech-leave-cancel-${leave.id}`).click();
      await page.getByTestId('tech-leave-action-note').fill('E2E：事情办完了');
      await page.getByTestId('tech-leave-action-confirm').click();
      await expect(page.getByTestId(`tech-leave-status-${leave.id}`)).toHaveText('已取消');
      expect((await stateOf(page, 'T2')).state).toBe('off');
      await page.goto('/clockroom');
      await expect(page.getByTestId('clock-sign-in-T2')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    } finally {
      // 收尾：新建的技师、组别、班次停用；类型清单、技师功能的开关恢复
      const view = await getJson<TechnicianAdminView>(page, '/api/technician-admin');
      const made = view.technicians.find((t) => t.techNo === NEW_NO);
      if (made?.active) await page.request.put(`/api/admin/technicians/${made.id}`, { data: { name: made.name, gender: made.gender, grade: made.grade, skills: [], active: false } });
      const group = view.groups.find((g) => g.name === GROUP);
      if (group?.active) await page.request.put(`/api/technician-admin/groups/${group.id}`, { data: { name: group.name, active: false } });
      const shift = view.shifts.find((s) => s.name === SHIFT);
      if (shift?.active) await page.request.put(`/api/technician-admin/shifts/${shift.id}`, { data: { name: shift.name, startMinute: shift.startMinute, endMinute: shift.endMinute, active: false } });
      await page.request.put('/api/technician-admin/kinds', { data: { kinds: before.kinds } });
      await signOutMine(page);
      await page.request.put('/api/admin/technicians/rules', { data: { enabled: before.enabled } });
    }
  });
});
