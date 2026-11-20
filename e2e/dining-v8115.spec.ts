// 8.1.15《浴族系统需求汇总》块 B 浏览器验收（docs/DINING_V8115.md 第 8 节）：
//   桌台：并台 → 附台不显示结账、核对时一组都勾上 → 主台一起结 → 两桌待清台 → 清台；维修（原因、预计时间）→ 历史 → 恢复；
//   台账：点单页退菜选责任岗位 → 旧地址 /dining/voids 跳到台账的「退菜」，写原因、怎么批的、责任岗位、退菜率；
//   康美部（后勤 + 康美部）：点单页只有水吧、果吧；只填房号找到在住的客人，下单后厨房屏写「送到房」与整单备注；没人住的房号写明找不到。
// 只在独立演示库跑（CI 的几套 seed 或 demo-prepare 都行）；账号：店主 linlan、前台 xiaozhou，密码 yuzu2026。
// 只填房号要有在住的客人：自己备一间（没有专用房就建；台账里有客房空间、新建要选空间的库借一间空着的全天房），结束时撤销入住与来访。
// 专用菜品、档口、桌台（E2E 8115 开头）留着下次沿用；开始时把这两张桌收拾成空闲，结束时退菜、撤销来访，可重复执行。
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { DiningAdmin, TableSessionDetail, TablesAdmin, TablesBoard } from '../src/shared/dining';
import type { DishesBoard } from '../src/shared/dishes';
import type { BoardTag } from '../src/shared/frontdesk';
import type { RoomBoard, RoomsAdmin, StayDetail } from '../src/shared/rooms';
import { ensureShift } from './shift';

const PASSWORD = 'yuzu2026';
const DISHES = [
  { name: 'E2E 8115 炒饭', category: 'E2E 8115 餐饮', price: 2800, station: 'E2E 8115 热菜', slot: 'restaurant:餐饮' },
  { name: 'E2E 8115 柠檬茶', category: 'E2E 8115 饮品', price: 1800, station: 'E2E 8115 水吧', slot: 'water:手作饮料' },
  { name: 'E2E 8115 果盘', category: 'E2E 8115 果吧', price: 3800, station: 'E2E 8115 果吧', slot: 'fruit' },
] as const;
const [RICE, TEA, FRUIT] = DISHES;
/** 带做法、加料的水吧菜（8.1.15 菜品管理）：加料一道在果吧、一道在餐厅——康美部只能加果吧那道（ZT26） */
const FIZZ = 'E2E 8115 气泡水';
const MAIN = 'E2E 8115 甲';
const SUB = 'E2E 8115 乙';

async function login(page: Page, username: string, password = PASSWORD) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
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

const tileOf = async (page: Page, name: string) => (await getJson<TablesBoard>(page, '/api/dining/tables')).tables.find((t) => t.name === name)!;

/** 把两张桌收拾成空闲：开着的台退菜、拆台、撤台；待清台的清台；维修中的恢复（店主） */
async function resetTables(page: Page) {
  for (const name of [SUB, MAIN]) {
    const t = await tileOf(page, name);
    if (t.session) {
      const d = await getJson<TableSessionDetail>(page, `/api/dining/tables/sessions/${t.session.id}`);
      if (d.mergedInto) await send(page, 'post', `/api/dining/tables/sessions/${d.id}/split`, { clientKey: randomUUID() });
      for (const m of d.merged) await send(page, 'post', `/api/dining/tables/sessions/${m.sessionId}/split`, { clientKey: randomUUID() });
      for (const l of d.lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/dining/tables/lines/${l.id}/void`, { reason: 'E2E：收掉上次留下的' });
      await send(page, 'post', `/api/dining/tables/sessions/${d.id}/cancel`, { reason: 'E2E：收掉上次留下的' });
    }
  }
  for (const name of [MAIN, SUB]) {
    const t = await tileOf(page, name);
    if (t.state === 'dirty') await send(page, 'post', `/api/dining/tables/${t.id}/clear`, { clientKey: randomUUID() });
    if (t.state === 'maintenance') await send(page, 'post', `/api/dining/tables/${t.id}/restore`, { clientKey: randomUUID() });
  }
}

/** 店主：专用菜品、档口、点单分类、两张桌台；开启餐饮、桌台点单与「结账后先待清台」 */
async function prepare(page: Page) {
  for (const d of DISHES) {
    const items = (await getJson<{ items: { id: number; name: string; active: boolean }[] }>(page, '/api/catalog?all=1')).items;
    const old = items.find((i) => i.name === d.name);
    const body = { name: d.name, category: d.category, price: d.price };
    if (!old) await send(page, 'post', '/api/items', body);
    else if (!old.active) await send(page, 'put', `/api/items/${old.id}`, { ...body, active: true });
  }
  let admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
  for (const name of new Set(DISHES.map((d) => d.station))) {
    const old = admin.stations.find((s) => s.name === name);
    if (!old) admin = await send<DiningAdmin>(page, 'post', '/api/admin/dining/stations', { name });
    else if (!old.active) admin = await send<DiningAdmin>(page, 'put', `/api/admin/dining/stations/${old.id}`, { name, sortOrder: old.sortOrder, active: true });
  }
  const items = DISHES.map((d) => ({ id: admin.items.find((i) => i.name === d.name)!.id, stationId: admin.stations.find((s) => s.name === d.station)!.id, slot: d.slot }));
  await send(page, 'put', '/api/admin/dining/items', { items });
  await send(page, 'put', '/api/admin/dining/rules', { enabled: true, trackServed: true, warnMinutes: 15, tablesEnabled: true, voidFreeCents: 5000, clearAfterCheckout: true });
  let tables = await getJson<TablesAdmin>(page, '/api/admin/dining/tables');
  for (const [i, name] of [MAIN, SUB].entries()) {
    const old = tables.tables.find((x) => x.name === name);
    const body = { name, area: '散桌', seats: 4, sortOrder: 9200 + i, active: true };
    if (!old) tables = await send<TablesAdmin>(page, 'post', '/api/admin/dining/tables', body);
    else if (!old.active || old.area !== '散桌') tables = await send<TablesAdmin>(page, 'put', `/api/admin/dining/tables/${old.id}`, body);
  }
  await resetTables(page);
}

/** 店主：没有就用菜品管理新建「气泡水」（留着下次沿用；下架了的重新上架） */
async function ensureFizz(page: Page) {
  const old = (await getJson<DishesBoard>(page, '/api/dining/dishes')).dishes.find((d) => d.name === FIZZ);
  if (old) {
    if (!old.active) await send(page, 'post', `/api/dining/dishes/${old.id}/active`, { clientKey: randomUUID(), active: true });
    return;
  }
  const admin = await getJson<DiningAdmin>(page, '/api/admin/dining');
  const id = (name: string) => admin.items.find((i) => i.name === name)!.id;
  await send(page, 'post', '/api/dining/dishes', {
    clientKey: randomUUID(),
    name: FIZZ,
    category: TEA.category,
    slot: TEA.slot,
    stationId: admin.stations.find((s) => s.name === TEA.station)!.id,
    prices: { standard: 1200 },
    methods: ['少冰'],
    addons: [id(FRUIT.name), id(RICE.name)],
  });
}

/** 只填房号用的专用客房（8.0.20 客房）：房型与房间都以「E2E 8115」开头 */
const ROOM_TYPE = { name: 'E2E 8115 大床房', kind: 'daily', price: 18800, blockMinutes: null, sortOrder: 9800, active: true } as const;
const ROOM_NO = 'E8115';

/**
 * 店主：备一间在住的客房——前台接待一位客人，入住一间空着、打扫好的全天房。专用房没有就建；台账里有客房空间的库新建要选空间，
 * 这时借一间空着的全天房。客房功能关着的先打开，收尾时关回去
 */
async function stayGuest(page: Page) {
  const admin = await getJson<RoomsAdmin>(page, '/api/admin/rooms');
  const rules = admin.rules.enabled ? null : admin.rules;
  if (rules) await send(page, 'put', '/api/admin/rooms/rules', { ...rules, enabled: true });
  const vacant = async () => (await getJson<RoomBoard>(page, '/api/rooms')).rooms.filter((r) => r.status === 'vacant' && r.kind === 'daily' && !r.stay);
  let room = (await vacant()).find((r) => r.roomNo === ROOM_NO) ?? null;
  if (!room && !admin.rooms.some((r) => r.roomNo === ROOM_NO) && !admin.spaceRequired) {
    let typeId = admin.types.find((t) => t.name === ROOM_TYPE.name)?.id;
    if (!typeId) typeId = (await send<RoomsAdmin>(page, 'post', '/api/admin/rooms/types', ROOM_TYPE)).types.find((t) => t.name === ROOM_TYPE.name)!.id;
    await send(page, 'post', '/api/admin/rooms/rooms', { roomNo: ROOM_NO, floor: 'E2E', roomTypeId: typeId, sortOrder: 9800, active: true });
    room = (await vacant()).find((r) => r.roomNo === ROOM_NO) ?? null;
  }
  room ??= (await vacant())[0] ?? null;
  expect(room, '要一间空着、打扫好的全天房').not.toBeNull();
  const tags = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags;
  const tag = tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit).at(-1)!.code;
  await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: 'E2E 8115 住客' }] });
  await send(page, 'post', '/api/rooms/checkin', { clientKey: randomUUID(), roomId: room!.id, tagCode: tag, guests: 1, expectedRate: room!.price });
  const stay = (await getJson<RoomBoard>(page, '/api/rooms')).rooms.find((r) => r.id === room!.id)!.stay!;
  return { roomId: room!.id, roomNo: room!.roomNo, stayId: stay.id, rules };
}

/** 收尾（店主）：作废这次入住的房费与来访上的明细，撤销入住与来访，房间打扫好；客房功能原来关着的关回去 */
async function clearStay(page: Page, stay: Awaited<ReturnType<typeof stayGuest>>) {
  const reason = 'E2E：收尾';
  const s = await getJson<StayDetail>(page, `/api/rooms/stays/${stay.stayId}`);
  for (const c of s.charges.filter((x) => x.lineStatus === 'active')) await send(page, 'post', `/api/frontdesk/lines/${c.lineId}/void`, { reason });
  await send(page, 'post', `/api/rooms/stays/${s.id}/cancel`, { reason });
  const v = await getJson<{ status: string; lines: { id: number; status: string }[] }>(page, `/api/frontdesk/visits/${s.visitId}`);
  if (v.status === 'open') {
    for (const l of v.lines.filter((x) => x.status === 'active')) await send(page, 'post', `/api/frontdesk/lines/${l.id}/void`, { reason, blame: 'other' });
    await send(page, 'post', `/api/frontdesk/visits/${s.visitId}/cancel`, { reason });
  }
  const t = (await getJson<RoomBoard>(page, '/api/rooms')).rooms.find((r) => r.id === stay.roomId);
  if (t && t.status !== 'vacant') await send(page, 'put', `/api/rooms/${t.id}/housekeeping`, { status: 'clean' });
  if (stay.rules) await send(page, 'put', '/api/admin/rooms/rules', stay.rules);
}

const itemId = async (page: Page, name: string) => (await getJson<DiningAdmin>(page, '/api/admin/dining')).items.find((i) => i.name === name)!.id;

test.describe('8.1.15 餐饮：桌台动作、台账退菜、出品口与房号', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1280, '会改规则、写数据的流程只在门店电脑尺寸执行一次');
  test.setTimeout(240_000);

  test('并台 → 主台一起结 → 待清台 → 清台；维修 → 历史 → 恢复', async ({ page }) => {
    await login(page, 'linlan');
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
    await prepare(page);
    await ensureShift(page);
    try {
      const open = async (name: string) => (await send<TableSessionDetail>(page, 'post', '/api/dining/tables/open', { clientKey: randomUUID(), tableId: (await tileOf(page, name)).id, guests: 2 })).id;
      const main = await open(MAIN);
      const sub = await open(SUB);
      await send(page, 'post', `/api/dining/tables/sessions/${main}/orders`, { clientKey: randomUUID(), lines: [{ itemId: await itemId(page, RICE.name), quantity: 1 }], expectedTotal: RICE.price });
      await send(page, 'post', `/api/dining/tables/sessions/${sub}/orders`, { clientKey: randomUUID(), lines: [{ itemId: await itemId(page, TEA.name), quantity: 1 }], expectedTotal: TEA.price });

      // ① 主台的详情里并台：选乙
      await page.goto('/dining/tables');
      await page.getByTestId(`table-tile-${MAIN}`).click();
      await page.getByTestId('table-merge').click();
      const merge = page.getByTestId('table-merge-dialog');
      await merge.getByTestId(`table-merge-pick-${SUB}`).click();
      await page.getByTestId('table-merge-confirm').click();
      await expect(page.getByText(`桌 ${SUB} 已并入桌 ${MAIN}`)).toBeVisible();
      await expect(page.getByTestId('table-merged-subs')).toContainText(SUB);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(`table-merged-${SUB}`)).toContainText(`并入桌 ${MAIN}`);

      // ② 附台的详情：写明在主台结、没有「结账」
      await page.getByTestId(`table-tile-${SUB}`).click();
      await expect(page.getByTestId('table-merged-into')).toContainText(MAIN);
      await expect(page.getByTestId('table-checkout')).toHaveCount(0);
      await page.keyboard.press('Escape');

      // ③ 主台结账：核对时两桌都勾上，乙写「并入桌 甲」；收款走接口（收款区另有用例）
      await page.getByTestId(`table-tile-${MAIN}`).click();
      await page.getByTestId('table-checkout').click();
      await expect(page.getByTestId(`table-checkout-merged-${SUB}`)).toContainText(MAIN);
      await expect(page.getByTestId('table-checkout-total')).toContainText('46.00');
      await page.getByRole('button', { name: '取消' }).click();
      await page.keyboard.press('Escape');
      await send(page, 'post', '/api/dining/tables/checkout', {
        clientKey: randomUUID(),
        sessionIds: [main, sub],
        expectedTotal: RICE.price + TEA.price,
        payments: [{ method: 'cash', amount: RICE.price + TEA.price }],
      });

      // ④ 两桌都待清台；甲清台回到空闲
      await page.reload();
      await expect(page.getByTestId(`table-tile-${MAIN}`)).toHaveAttribute('data-state', 'dirty');
      await expect(page.getByTestId(`table-tile-${SUB}`)).toHaveAttribute('data-state', 'dirty');
      await expect(page.getByTestId(`table-tile-${MAIN}`)).toContainText('待清台');
      await page.getByTestId(`table-tile-${MAIN}`).click();
      await page.getByTestId('table-clear').click();
      await expect(page.getByTestId(`table-tile-${MAIN}`)).toHaveAttribute('data-state', 'free');

      // ⑤ 乙维修：原因与预计时间，格子上写出来
      await page.getByTestId(`table-tile-${SUB}`).click();
      await page.getByTestId('table-maintenance-open').click();
      await page.getByTestId('table-maintenance-reason').fill('E2E 桌腿松了');
      await page.getByTestId('table-maintenance-confirm').click();
      await expect(page.getByTestId(`table-tile-${SUB}`)).toHaveAttribute('data-state', 'maintenance');
      await expect(page.getByTestId(`table-tile-${SUB}`)).toContainText('E2E 桌腿松了');

      // ⑥ 历史：维修、结账、并台、开台都在；然后恢复
      await page.getByTestId(`table-tile-${SUB}`).click();
      await page.getByTestId('table-history-open').click();
      const history = page.getByTestId('table-history');
      for (const kind of ['maintenance', 'checkout', 'merge', 'open']) await expect(history.getByTestId(`table-history-${kind}`).first()).toBeVisible();
      await expect(history.getByTestId('table-history-merge').first()).toContainText(`并入桌 ${MAIN}`);
      await page.reload();
      await page.getByTestId(`table-tile-${SUB}`).click();
      await page.getByTestId('table-restore').click();
      await expect(page.getByTestId(`table-tile-${SUB}`)).toHaveAttribute('data-state', 'free');
    } finally {
      await resetTables(page);
    }
  });

  test('退菜时选责任岗位；旧地址跳到台账的「退菜」，写原因、怎么批的、责任岗位与退菜率', async ({ page }) => {
    await login(page, 'linlan');
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
    await prepare(page);
    const free = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.filter((t) => t.zone === 'male' && t.kind === 'normal' && t.active && !t.locked && !t.visit);
    const tag = free.at(-1)!.code;
    await send(page, 'post', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male', guestLabel: 'E2E 8115 退菜' }] });
    const visitId = (await getJson<{ tags: BoardTag[] }>(page, '/api/frontdesk/board')).tags.find((t) => t.code === tag)!.visit!.id;
    try {
      await send(page, 'post', '/api/dining/orders', { clientKey: randomUUID(), visitId, lines: [{ itemId: await itemId(page, FRUIT.name), quantity: 1 }], expectedTotal: FRUIT.price });
      await page.goto('/dining/order');
      await page.getByTestId('dining-tag').fill(tag);
      await page.getByTestId('dining-find').click();
      await page.getByTestId('dining-pending').getByTestId(`dining-pending-${FRUIT.name}`).getByRole('button', { name: '退菜' }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: `退菜 · ${FRUIT.name}` });
      await dialog.locator('#reason-text').fill('E2E 果吧缺货');
      // 没选责任岗位不能退
      await expect(dialog.getByTestId('dish-void-confirm')).toBeDisabled();
      await dialog.getByTestId('dish-void-blame-fruit').click();
      await dialog.getByTestId('dish-void-confirm').click();
      await expect(page.getByText(`${FRUIT.name} 已退`)).toBeVisible();

      await page.goto('/dining/voids');
      await expect(page).toHaveURL(/\/dining\/ledger\?type=voided/);
      await expect(page.getByTestId('dining-tab-voids')).toHaveCount(0);
      const row = page.getByTestId('dining-ledger').locator('tbody tr').filter({ hasText: FRUIT.name }).first();
      await expect(row).toContainText('E2E 果吧缺货');
      await expect(row).toContainText('小额直接退');
      await expect(row).toContainText('果吧');
      await expect(row).toHaveAttribute('data-kind', 'voided');
      await expect(page.getByTestId('dining-ledger-void-rate')).toContainText('%');
      // 换到「正常」：退了的不在
      await page.getByTestId('dining-ledger-type').getByRole('radio', { name: '正常' }).click();
      await expect(page).toHaveURL(/type=normal/);
      await expect(page.getByTestId('dining-ledger').locator('tbody tr').filter({ hasText: 'E2E 果吧缺货' })).toHaveCount(0);
    } finally {
      await page.request.post(`/api/frontdesk/visits/${visitId}/cancel`, { data: { reason: 'E2E：收尾' } });
    }
  });

  test('康美部只看得到水吧、果吧，加料在餐厅的标出来、不能选；只填房号找到在住的客人，下单后厨房屏写送到房，整单备注与这一行的备注分开写', async ({ page }) => {
    await login(page, 'linlan');
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
    await prepare(page);
    await ensureFizz(page);
    const stamp = String(Date.now()).slice(-8);
    const username = `e2ekm${stamp}`;
    const made = await page.request.post('/api/staff', { data: { username, displayName: 'E2E 康美', role: 'backoffice', duties: ['kangmei'], password: 'E2e-kangmei-2026' } });
    expect(made.status(), await made.text()).toBe(201);
    const staff = (await made.json()) as { temporaryPassword: string };
    const stay = await stayGuest(page);
    const roomNo = stay.roomNo;
    try {
      await page.request.post('/api/auth/logout');
      await login(page, username, staff.temporaryPassword);
      await expect(page.getByText('设置你的密码')).toBeVisible();
      const pw = page.locator('input[type=password]');
      await pw.nth(0).fill(staff.temporaryPassword);
      await pw.nth(1).fill('E2e-kangmei-2027');
      await pw.nth(2).fill('E2e-kangmei-2027');
      await page.getByRole('button', { name: '保存新密码' }).click();
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
      await page.goto('/dining/order');

      // 只有水吧、果吧
      await expect(page.getByTestId('dining-outlet-water')).toBeVisible();
      await expect(page.getByTestId('dining-outlet-fruit')).toBeVisible();
      await expect(page.getByTestId('dining-outlet-restaurant')).toHaveCount(0);

      // 没人住的房号：写明找不到
      await page.getByTestId('dining-room').fill('ZZ99');
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest-error')).toContainText('房号 ZZ99 现在没有登记的客人');

      // 只填房号：刚入住的客人
      await page.getByTestId('dining-room').fill(roomNo);
      await page.getByTestId('dining-find').click();
      await expect(page.getByTestId('dining-guest')).toContainText(`按房号 ${roomNo} 找到`);
      await page.getByTestId('dining-outlet-water').click();
      // 带加料的菜：加料在餐厅的写明「不能在餐厅下单」、没有「加」；果吧的照常能加（ZT26）
      await page.getByTestId(`dining-dish-${FIZZ}`).click();
      await expect(page.getByTestId('dish-options')).toBeVisible();
      const blocked = page.getByTestId(`dish-options-addon-${RICE.name}`);
      await expect(blocked).toHaveAttribute('data-blocked', 'true');
      await expect(blocked).toContainText('不能在餐厅下单');
      await expect(page.getByTestId(`dish-options-addon-add-${RICE.name}`)).toHaveCount(0);
      await page.getByTestId('dish-options-method-少冰').click();
      await page.getByTestId(`dish-options-addon-add-${FRUIT.name}`).click();
      await page.getByTestId('dish-options-add').click();
      await expect(page.getByTestId('dish-options')).toHaveCount(0);
      await page.getByTestId(`dining-dish-${TEA.name}`).click();
      await page.getByTestId('dining-order-note').fill('E2E 送到房间请敲门');
      await expect(page.getByTestId('dining-target-room')).toContainText(roomNo);
      await page.getByTestId('dining-submit').click();
      await expect(page.getByText(/已下单/)).toBeVisible();

      // 厨房屏：送到房、整单备注
      await page.goto('/dining/kitchen');
      const ticket = page
        .locator(`[data-dish="${TEA.name}"]`)
        .filter({ hasText: `送到房 ${roomNo}` })
        .first();
      await expect(ticket).toContainText(`送到房 ${roomNo}`);
      await expect(ticket).toContainText('整单：E2E 送到房间请敲门');
      // 这一行的备注（做法、「配 某菜」）与整单备注各占一条（ZT28）
      const fizz = page
        .locator(`[data-dish="${FIZZ}"]`)
        .filter({ hasText: `送到房 ${roomNo}` })
        .first();
      await expect(fizz.locator('[data-testid^="kds-note-"]')).toHaveText('少冰');
      await expect(fizz.locator('[data-testid^="kds-order-note-"]')).toHaveText('整单：E2E 送到房间请敲门');
      const addon = page
        .locator(`[data-dish="${FRUIT.name}"]`)
        .filter({ hasText: `送到房 ${roomNo}` })
        .first();
      await expect(addon.locator('[data-testid^="kds-note-"]')).toHaveText(`配 ${FIZZ}`);
      await expect(addon.locator('[data-testid^="kds-order-note-"]')).toHaveText('整单：E2E 送到房间请敲门');
    } finally {
      await page.request.post('/api/auth/logout');
      await login(page, 'linlan');
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({ timeout: 30_000 });
      // 收尾：退掉这一单与房费，撤销入住与来访
      await clearStay(page, stay);
    }
  });
});
