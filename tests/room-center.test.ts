// 8.1.15 · 房态中心（《浴族系统需求汇总》房态中心 1–4，docs/ROOM_CENTER_V8115.md）：
// 房型与各状态的数量（没归类的进「其他」）、五种状态的口径与先后、卡片式登记（挂账 + 派钟 + 占房一步做完，缺一样都不生效）、
// 续钟、换房（钟单与计时不变）、退房 → 待清 → 清洁完成、客人结账离店自动腾房、维修（原因 + 预计完成时间，钟房与使用单也拦）、
// 并房、派对房从房态中心开单、客房沿用房态看板、房间历史、权限、操作编号重提、给餐饮的 currentGuestOfSpace。全部是合成数据。

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { categoryProblem, roomKindOf, roomStatusOf, type RoomCard, type RoomCategoriesAdmin, type RoomCenterBoard, type RoomCheckoutPreview, type RoomHistory } from '../src/shared/room-center';
import type { SpaceLedger } from '../src/shared/spaces';
import { currentGuestOfSpace } from '../src/server/modules/room-center';
import { createStaff } from '../src/server/modules/staff';
import { api, createMember, login, PASSWORD, setup, type TestContext } from './helpers';

let ctx: TestContext;
let manager: string; // 客户经理：看不了房态中心
let logistics: string; // 后勤：只有「客房打扫、维修」，能看、能改房态，不能登记
let foot = 0;
const tech: Record<string, number> = {};
const spaceId: Record<string, number> = {};
let tagNo = 0;

const ZONES_CSV = ['楼层,区域名(中文),区域名(英文),备注', 'L3,合成SPA区,Sample SPA,合成样例'].join('\r\n');
const SPACES_CSV = [
  '楼层,区域字母,编码,业态,容量(人),建议显示名,面积,编码图原始标注,备注',
  'L3,S,S301,SPA,1,合成SPA 1人间,,合成 SPA S301,',
  'L3,S,S302,SPA,2,合成SPA 2人间,,合成 SPA S302,',
  'L3,S,S303,SPA,1,合成SPA 三号,,合成 SPA S303,',
  'L3,S,S304,SPA,1,合成SPA 四号,,合成 SPA S304,',
  'L3,S,S305,SPA,1,合成SPA 五号,,合成 SPA S305,',
  'L3,S,S306,SPA,1,合成SPA 六号,,合成 SPA S306,',
  'L3,F,F312,足浴,4,合成足浴 4人间,,合成 F312,',
  'L3,A,A301,按摩,1,合成按摩一号,,合成 A301,',
  'L3,A,A302,按摩,1,合成按摩二号,,合成 A302,',
  'L3,G,G301,客房,2,合成客房,,合成客房 G301,',
  'L2,P,P201,派对房,,合成派对房一号,,合成派对房 P201,',
  'L2,P,P202,派对房,,合成派对房二号,,合成派对房 P202,',
  'L2,H,H201,休息大厅,40,合成休息大厅,,合成大厅 H201,',
  'L2,Z,Z201,茶室,6,合成茶室,,合成茶室 Z201,',
].join('\r\n');

const board = async (cookie = ctx.clerk) => (await api(ctx.app, cookie, 'GET', '/api/room-center')).body as RoomCenterBoard;
const room = async (code: string, cookie = ctx.clerk) => (await board(cookie)).rooms.find((r) => r.code === code)!;
const category = async (name: string) => (await board()).categories.find((c) => c.name === name)!;
/** 接待一位女宾；minutesAgo：按纸质单补录成这么多分钟以前入场的（店主补录），用来测「已经开始了」的补记 */
const enter = async (memberId?: number, minutesAgo?: number) => {
  tagNo += 1;
  const code = `F${String(tagNo).padStart(3, '0')}`;
  const r = await api(ctx.app, minutesAgo ? ctx.owner : ctx.clerk, 'POST', '/api/frontdesk/checkins', {
    clientKey: randomUUID(),
    guests: [{ tagCode: code, zone: 'female', ...(memberId ? { memberId } : {}) }],
    ...(minutesAgo ? { backfill: { slipNo: `P-${tagNo}`, at: new Date(Date.now() - minutesAgo * 60_000).toISOString() } } : {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { visitId: r.body.visits[0].id as number, tagCode: code };
};
const bill = async (visitId: number) =>
  (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${visitId}`)).body as { bill: { amountCents: number }; lines: { status: string; amount: number; sessionId: number | null }[] };
const on = (code: string, action: string) => `/api/room-center/rooms/${spaceId[code]}/${action}`;
const register = (code: string, body: Record<string, unknown>, clientKey = randomUUID(), cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', on(code, 'register'), {
    clientKey,
    itemId: foot,
    tier: 'standard',
    quantity: 1,
    callType: 'designated',
    sellerNo: 'clerk',
    note: '',
    start: 'now',
    expectedTotal: 19800,
    ...body,
  });
const act = async (code: string, action: string, body: Record<string, unknown> = {}, cookie = ctx.clerk) =>
  api(ctx.app, cookie, 'POST', on(code, action), { expectedVersion: (await room(code)).version, ...body });
const finish = (sessionId: number) => api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${sessionId}/finish`);
const preview = async (code: string) => (await api(ctx.app, ctx.clerk, 'GET', on(code, 'checkout-preview'))).body as RoomCheckoutPreview;
/** 退房（先下钟、看预览、确认客人带手牌在店）→ 清洁完成：把房间与技师都腾出来 */
const release = async (code: string) => {
  for (const g of (await room(code)).guests) for (const s of g.sessions) if (s.status === 'serving') expect((await finish(s.id)).status).toBe(200);
  const p = await preview(code);
  expect((await act(code, 'checkout', { seenUnpaid: p.unpaidTotal, inHouse: true })).status).toBe(200);
  expect((await act(code, 'cleaned')).status).toBe(200);
};
const history = async (code: string) => (await api(ctx.app, ctx.clerk, 'GET', on(code, 'history'))).body as RoomHistory;
const pay = async (visitId: number) => {
  const p = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: p.totalAmount,
    payments: [{ method: 'cash', amount: p.totalAmount }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const counts = async () => {
  const [n] = await ctx.sql<{ lines: number; sessions: number; regs: number; events: number }[]>`
    SELECT (SELECT count(*) FROM bill_lines)::int AS lines, (SELECT count(*) FROM technician_sessions)::int AS sessions,
           (SELECT count(*) FROM room_registrations)::int AS regs, (SELECT count(*) FROM space_room_events)::int AS events`;
  return n!;
};

beforeAll(async () => {
  ctx = await setup();
  await createStaff(ctx.sql, { username: 'am', displayName: '客户经理', role: 'account_manager', password: PASSWORD, mustChangePassword: false });
  await createStaff(ctx.sql, { username: 'hk', displayName: '后勤小周', role: 'backoffice', password: PASSWORD, mustChangePassword: false });
  manager = await login(ctx.app, 'am');
  logistics = await login(ctx.app, 'hk');
  for (const [kind, csv] of [
    ['zones', ZONES_CSV],
    ['spaces', SPACES_CSV],
  ] as const) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/spaces/imports', { kind, fileName: `${kind}.csv`, csv, encoding: 'UTF-8', clientKey: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  for (const s of ((await api(ctx.app, ctx.owner, 'GET', '/api/admin/spaces')).body as SpaceLedger).spaces) spaceId[s.code] = s.id;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'F', from: 1, to: 60, width: 3, zone: 'female' })).status).toBe(200);
  const item = await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '足疗', category: '足疗', durationMinutes: 90, technicianRequired: true, price: 19800 });
  expect(item.status, JSON.stringify(item.body)).toBe(200);
  foot = item.body.items.find((i: { name: string }) => i.name === '足疗').id;
  for (const no of ['01', '02', '03', '04', '05', '06']) {
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: no, name: `技师${no}`, gender: 'female', grade: 'standard' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    tech[no] = r.body.technicians.find((t: { techNo: string }) => t.techNo === no).id;
  }
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/technicians/rules', { enabled: true })).status).toBe(200);
  for (const no of Object.keys(tech)) expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/technicians/${tech[no]}/state`, { action: 'sign_in' })).status).toBe(200);
  // 员工名单里的一个工号（出单员可以填它）
  await ctx.sql`INSERT INTO canteen_employees (emp_no, name, avatar) VALUES ('E007', '合成服务员', '柚')`;
});
afterAll(async () => ctx.close());

describe('房型与数量', () => {
  it('状态的先后（纯函数）：维修 > 在用 > 待清 > 已预订 > 空闲；空间按业态算哪一类；房型的来源与业态要对得上', () => {
    const f = { maintenance: false, inUse: false, dirty: false, booked: false };
    expect(roomStatusOf(f)).toBe('free');
    expect(roomStatusOf({ ...f, booked: true })).toBe('booked');
    expect(roomStatusOf({ ...f, booked: true, dirty: true })).toBe('dirty');
    expect(roomStatusOf({ ...f, booked: true, dirty: true, inUse: true })).toBe('in_use');
    expect(roomStatusOf({ maintenance: true, inUse: true, dirty: true, booked: true })).toBe('maintenance');
    expect([roomKindOf('SPA', ['派对房']), roomKindOf('派对房', ['派对房']), roomKindOf('客房', ['派对房']), roomKindOf('茶室', ['派对房'])]).toEqual(['service', 'party', 'hotel', 'hall']);
    expect(categoryProblem('service', ['SPA', '足浴'])).toBeNull();
    expect(categoryProblem('service', ['SPA', '茶室'])).toContain('茶室');
    expect(categoryProblem('hall', ['茶室', 'SPA'])).toContain('SPA');
    expect(categoryProblem('hotel', ['客房'])).toBeNull();
    expect(categoryProblem('hotel', ['客房', '茶室'])).toContain('客房');
    expect(categoryProblem('party', ['客房'])).toContain('客房');
    expect(categoryProblem('hall', [])).toContain('至少');
  });

  it('迁移建好默认的房型；看板按房型分页签、带总数与各状态的数量，没归到房型的空间在「其他」', async () => {
    const b = await board();
    expect(b.categories.map((c) => c.name)).toEqual(['按摩房', '足浴房', 'SPA 房', '休息大厅', '宠物轰趴房', '派对房', '客房', '其他']);
    const of = (name: string) => b.categories.find((c) => c.name === name)!;
    expect(of('SPA 房').counts).toEqual({ total: 6, free: 6, inUse: 0, dirty: 0, maintenance: 0, booked: 0 });
    expect([of('按摩房').counts.total, of('足浴房').counts.total, of('休息大厅').counts.total, of('宠物轰趴房').counts.total, of('派对房').counts.total]).toEqual([2, 1, 1, 0, 2]);
    // 客房功能关着：客房页签在，一间都没有，写明原因；「客房」业态的空间不另出卡片
    expect(of('客房').counts.total).toBe(0);
    expect(of('客房').hint).toContain('客房功能没有开启');
    expect(b.rooms.some((r) => r.code === 'G301')).toBe(false);
    expect(of('其他').counts.total).toBe(1);
    expect(b.rooms.find((r) => r.code === 'Z201')).toMatchObject({ categoryKey: 'other', kind: 'hall', status: 'free' });
    expect(b.total).toEqual({ total: 13, free: 13, inUse: 0, dirty: 0, maintenance: 0, booked: 0 });
    expect(b.rooms.find((r) => r.code === 'S301')).toMatchObject({ kind: 'service', status: 'free', version: 0, guests: [], guestText: null, amount: null });
    expect(b.rooms.find((r) => r.code === 'P201')).toMatchObject({ kind: 'party', status: 'free' });
  });

  it('后台改房型：来源与业态对不上、业态已经归了别的房型、名称重复、版本号对不上都拒绝；归好类的离开「其他」；店员不能改', async () => {
    const admin = async () => (await api(ctx.app, ctx.owner, 'GET', '/api/admin/room-categories')).body as RoomCategoriesAdmin;
    const before = await admin();
    expect(before.unmapped).toEqual(['茶室']);
    expect(before.usageTypes).toContain('派对房');
    expect(before.businessTypes.find((t) => t.type === 'SPA')!.spaces).toBe(6);
    const create = (body: Record<string, unknown>, cookie = ctx.owner) => api(ctx.app, cookie, 'POST', '/api/admin/room-categories', { sortOrder: 80, active: true, ...body });
    expect((await create({ name: '茶室', source: 'hall', businessTypes: ['茶室'] }, ctx.clerk)).status).toBe(403);
    expect((await create({ name: '茶室', source: 'service', businessTypes: ['茶室'] })).body.error.code).toBe('CATEGORY_TYPES');
    expect((await create({ name: '茶室', source: 'hall', businessTypes: ['茶室', 'SPA'] })).body.error.code).toBe('CATEGORY_TYPES');
    expect((await create({ name: '', source: 'hall', businessTypes: ['茶室'] })).status).toBe(400);
    const made = await create({ name: '茶室', source: 'hall', businessTypes: ['茶室'] });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const tea = (made.body as RoomCategoriesAdmin).categories.find((c) => c.name === '茶室')!;
    expect((made.body as RoomCategoriesAdmin).unmapped).toEqual([]);
    expect((await board()).categories.map((c) => c.name)).not.toContain('其他');
    expect((await room('Z201')).categoryKey).toBe(`c${tea.id}`);
    expect((await create({ name: ' 茶室 ', source: 'hall', businessTypes: ['棋牌'] })).body.error.code).toBe('CATEGORY_NAME_TAKEN');
    expect((await create({ name: '另一个茶室', source: 'hall', businessTypes: ['茶室'] })).body.error.code).toBe('CATEGORY_TYPE_TAKEN');
    const put = (body: Record<string, unknown>) =>
      api(ctx.app, ctx.owner, 'PUT', `/api/admin/room-categories/${tea.id}`, { name: '茶室', source: 'hall', businessTypes: ['茶室'], sortOrder: 80, active: true, ...body });
    expect((await put({ version: tea.version + 5 })).body.error.code).toBe('CATEGORY_STALE');
    // 停用以后它管的业态回到「其他」；停用的房型不占着业态
    expect((await put({ version: tea.version, active: false })).status).toBe(200);
    expect((await room('Z201')).categoryKey).toBe('other');
    expect((await create({ name: '另一个茶室', source: 'hall', businessTypes: ['茶室'], active: false })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/room-categories/defaults')).body.error.code).toBe('CATEGORY_EXISTS');
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'room_category'`;
    expect(audit!.n).toBe(3);
  });
});

describe('卡片式登记', () => {
  it('必填的没填、房间不对、客人不在店、出单员查不到、合计对不上：都不挂账、不派钟、不占房', async () => {
    const g = await enter();
    const before = await counts();
    const ok = { tagCode: g.tagCode, technicianId: tech['01'] };
    for (const missing of ['tagCode', 'itemId', 'technicianId', 'callType', 'sellerNo', 'start', 'expectedTotal']) {
      const r = await register('S301', { ...ok, [missing]: undefined });
      expect(r.status, `${missing} ${JSON.stringify(r.body)}`).toBe(400);
    }
    expect((await register('S301', { ...ok, sellerNo: '   ' })).status).toBe(400);
    expect((await register('S301', { ...ok, start: 'at' })).status).toBe(400);
    expect((await register('S301', { ...ok, tagCode: 'F059' })).body.error.code).toBe('TAG_NOT_IN_STORE');
    expect((await register('S301', { ...ok, sellerNo: 'nobody' })).body.error.code).toBe('SELLER_NOT_FOUND');
    expect((await register('S301', { ...ok, expectedTotal: 100 })).body.error.code).toBe('PRICE_CHANGED');
    // 不是技师服务的房间：大厅、派对房、客房业态的空间都不能这样登记
    expect((await register('H201', ok)).body.error.code).toBe('ROOM_NOT_SERVICE');
    expect((await register('P201', ok)).body.error.code).toBe('ROOM_NOT_SERVICE');
    expect((await register('G301', ok)).body.error.code).toBe('ROOM_NOT_SERVICE');
    // 没上牌的技师：钟房原来的核对照样生效，整笔回滚
    const r = await api(ctx.app, ctx.owner, 'POST', '/api/admin/technicians', { techNo: '99', name: '没上牌', gender: 'female', grade: 'standard' });
    const off = r.body.technicians.find((t: { techNo: string }) => t.techNo === '99').id;
    expect((await register('S301', { ...ok, technicianId: off })).body.error.code).toBe('TECHNICIAN_OFF');
    expect(await counts()).toEqual(before);
    expect((await bill(g.visitId)).bill.amountCents).toBe(0);
    expect((await room('S301')).status).toBe('free');
    expect((await room('S301')).version).toBe(0);
  });

  it('登记 = 挂账 + 派钟 + 占房：明细、钟单（上钟中、记着这间房）、登记单、房间事件一步生成；卡片上有客人、会员档阶、技师、计时起点、金额', async () => {
    const m = await createMember(ctx, '合成会员小柚');
    const g = await enter(m.id);
    const r = await register('S301', { tagCode: g.tagCode, technicianId: tech['01'], sellerNo: 'e007', note: '客人要靠窗' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const card = (r.body as RoomCenterBoard).rooms.find((x) => x.code === 'S301')!;
    expect(card).toMatchObject({ status: 'in_use', phase: 'serving', guestText: '合成会员小柚', techText: '01 号 技师01', amount: 19800, version: 1 });
    expect(card.since).toBeTruthy();
    expect(card.plannedEnd).toBeTruthy();
    expect(card.guests).toHaveLength(1);
    expect(card.guests[0]).toMatchObject({ tagCode: g.tagCode, guest: '合成会员小柚', sellerNo: 'E007', sellerName: '合成服务员', note: '客人要靠窗', amount: 19800, billAmount: 19800 });
    expect(card.guests[0]!.registrationId).toBeGreaterThan(0);
    expect(card.guests[0]!.sessions).toHaveLength(1);
    expect(card.guests[0]!.sessions[0]).toMatchObject({ status: 'serving', techNo: '01', itemName: '足疗', clocks: 1, minutes: 90, amount: 19800, unitPrice: 19800 });
    // 账单上多了一条明细，挂着这张钟单；钟单记着这间房
    const b = await bill(g.visitId);
    expect(b.bill.amountCents).toBe(19800);
    expect(b.lines.filter((l) => l.status === 'active')).toHaveLength(1);
    expect(b.lines[0]!.sessionId).toBe(card.guests[0]!.sessions[0]!.id);
    const [s] = await ctx.sql<{ spaceId: number; status: string }[]>`SELECT space_id, status FROM technician_sessions WHERE id = ${card.guests[0]!.sessions[0]!.id}`;
    expect([Number(s!.spaceId), s!.status]).toEqual([spaceId.S301, 'serving']);
    expect((await category('SPA 房')).counts).toMatchObject({ total: 6, free: 5, inUse: 1 });
    // 留痕：房间事件、审计（登记一条、挂账一条）
    const h = await history('S301');
    expect(h.rows[0]).toMatchObject({ label: '登记', kind: 'register', staffName: '测试店员' });
    expect(h.rows[0]!.text).toContain(`手牌 ${g.tagCode}`);
    expect(h.rows[0]!.text).toContain('01 号 技师01（点钟）');
    expect(h.rows[0]!.text).toContain('出单员 E007 合成服务员');
    expect(h.rows[0]!.text).toContain('客人要靠窗');
    // 登记时建的钟单，派钟、上钟已经写在「登记」里，不重复列
    expect(h.rows.map((x) => x.label)).toEqual(['登记']);
    const audits = await ctx.sql<
      { action: string }[]
    >`SELECT action FROM audit_logs WHERE action IN ('room_center_register', 'frontdesk_post') AND target_id IN (${String(spaceId.S301)}, ${String(g.visitId)})`;
    expect(audits.map((a) => a.action).sort()).toEqual(['frontdesk_post', 'room_center_register']);
  });

  it('同一个操作编号原样重提不重复登记，换了内容拒绝；查回按挂账的编号', async () => {
    const g = await enter();
    const key = randomUUID();
    const body = { tagCode: g.tagCode, technicianId: tech['02'] };
    expect((await register('S302', body, key)).status).toBe(200);
    const after = await counts();
    const again = await register('S302', body, key);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await counts()).toEqual(after);
    expect((await bill(g.visitId)).bill.amountCents).toBe(19800);
    expect((await register('S302', { ...body, note: '换了内容' }, key)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const found = await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/ops/${key}?type=bill_post`);
    expect(found.body).toMatchObject({ found: true, type: 'bill_post' });
    expect(found.body.visit.id).toBe(g.visitId);
  });

  it('在用的房间不能再登记；「同房加人」可以；一位客人同时只登记在一间房', async () => {
    const before = await counts();
    const other = await enter();
    expect((await register('S302', { tagCode: other.tagCode, technicianId: tech['03'] })).body.error.code).toBe('ROOM_IN_USE');
    // 已经登记在 S302 的客人不能再登记到别的房间
    const first = (await room('S302')).guests[0]!;
    expect((await register('S303', { tagCode: first.tagCode, technicianId: tech['03'] })).body.error.code).toBe('GUEST_REGISTERED');
    expect(await counts()).toEqual(before);
    expect((await bill(other.visitId)).bill.amountCents).toBe(0);
    const joined = await register('S302', { tagCode: other.tagCode, technicianId: tech['03'], join: true });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    const card = await room('S302');
    expect(card.guests.map((x) => x.tagCode)).toEqual([first.tagCode, other.tagCode]);
    expect(card).toMatchObject({ status: 'in_use', amount: 39600, techText: '02 号 技师02、03 号 技师03' });
    expect((await category('SPA 房')).counts).toMatchObject({ free: 4, inUse: 2 });
  });

  it('开始时间：已经开始了的补记（计时从那时起）、稍后上钟（先占房，待上钟）；比现在晚、太早、比入场早的拒绝', async () => {
    const g = await enter();
    const body = { tagCode: g.tagCode, technicianId: tech['04'] };
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    expect((await register('S303', { ...body, start: 'at', startedAt: ago(-30) })).body.error.code).toBe('START_IN_FUTURE');
    expect((await register('S303', { ...body, start: 'at', startedAt: ago(300) })).body.error.code).toBe('START_TOO_EARLY');
    expect((await register('S303', { ...body, start: 'at', startedAt: ago(20) })).body.error.code).toBe('START_BEFORE_CHECKIN');
    expect((await bill(g.visitId)).bill.amountCents).toBe(0);
    // 半小时前入场的客人（按纸质单补录的接待），补记 20 分钟前开始
    const early = await enter(undefined, 30);
    const at = ago(20);
    const done = await register('S303', { tagCode: early.tagCode, technicianId: tech['04'], start: 'at', startedAt: at });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const card = await room('S303');
    expect(card.phase).toBe('serving');
    expect(Math.abs(new Date(card.since!).getTime() - new Date(at).getTime())).toBeLessThan(1000);
    expect((await history('S303')).rows[0]!.text).toContain('补记');
    // 稍后上钟：房间先占着（在用、待上钟），钟房点上钟以后开始计时
    const later = await enter();
    expect((await register('S304', { tagCode: later.tagCode, technicianId: tech['05'], start: 'later' })).status).toBe(200);
    const waiting = await room('S304');
    expect(waiting).toMatchObject({ status: 'in_use', phase: 'waiting', since: null, amount: 19800 });
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/clockroom/sessions/${waiting.guests[0]!.sessions[0]!.id}/start`)).status).toBe(200);
    expect((await room('S304')).phase).toBe('serving');
    expect((await history('S304')).rows.map((x) => x.label)).toEqual(['上钟', '登记']);
  });
});

describe('续钟、换房', () => {
  it('续钟：就是加钟——按这张钟单的项目与档次加收、钟数与计划时长累加；同一个编号重提不重复；留一条房间事件', async () => {
    const card = await room('S301');
    const s = card.guests[0]!.sessions[0]!;
    const key = randomUUID();
    const body = { clientKey: key, sessionId: s.id, quantity: 1, expectedTotal: 19800 };
    expect((await api(ctx.app, ctx.clerk, 'POST', on('S301', 'extend'), { ...body, expectedTotal: 1 })).body.error.code).toBe('PRICE_CHANGED');
    expect((await api(ctx.app, ctx.clerk, 'POST', on('S302', 'extend'), body)).body.error.code).toBe('SESSION_NOT_IN_ROOM');
    const r = await api(ctx.app, ctx.clerk, 'POST', on('S301', 'extend'), body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (r.body as RoomCenterBoard).rooms.find((x) => x.code === 'S301')!;
    expect(after.guests[0]!.sessions[0]).toMatchObject({ id: s.id, clocks: 2, minutes: 180, amount: 39600, startedAt: s.startedAt });
    expect(after.amount).toBe(39600);
    expect(new Date(after.plannedEnd!).getTime() - new Date(card.plannedEnd!).getTime()).toBe(90 * 60_000);
    const n = await counts();
    expect((await api(ctx.app, ctx.clerk, 'POST', on('S301', 'extend'), body)).status).toBe(200);
    expect(await counts()).toEqual(n);
    expect((await bill(card.guests[0]!.visitId)).bill.amountCents).toBe(39600);
    const h = await history('S301');
    expect(h.rows[0]).toMatchObject({ label: '续钟', kind: 'extend' });
    expect(h.rows[0]!.text).toContain('加 1 钟');
  });

  it('换房：钟单还是那一张、开始时间与金额不变，只是换了房间；原来的房间转待清，两间各记一条；版本号对不上、目标不是空闲的拒绝', async () => {
    const before = await room('S301');
    const s = before.guests[0]!.sessions[0]!;
    const lines = await counts();
    expect((await api(ctx.app, ctx.clerk, 'POST', on('S301', 'move'), { toSpaceId: spaceId.S305, expectedVersion: before.version + 9 })).body.error.code).toBe('ROOM_STATE_MOVED');
    expect((await act('S301', 'move', { toSpaceId: spaceId.S301 })).body.error.code).toBe('MOVE_SAME');
    expect((await act('S301', 'move', { toSpaceId: spaceId.S302 })).body.error.code).toBe('ROOM_IN_USE');
    expect((await act('S301', 'move', { toSpaceId: spaceId.P201 })).body.error.code).toBe('MOVE_NOT_SERVICE');
    expect((await act('S305', 'move', { toSpaceId: spaceId.S306 })).body.error.code).toBe('ROOM_NOT_IN_USE');
    const moved = await act('S301', 'move', { toSpaceId: spaceId.S305, note: '空调不凉' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const to = (moved.body as RoomCenterBoard).rooms.find((x) => x.code === 'S305')!;
    expect(to).toMatchObject({ status: 'in_use', amount: before.amount, since: before.since, plannedEnd: before.plannedEnd });
    expect(to.guests[0]!.registrationId).toBe(before.guests[0]!.registrationId);
    expect(to.guests[0]!.sessions[0]).toMatchObject({ id: s.id, sessionNo: s.sessionNo, startedAt: s.startedAt, clocks: 2, minutes: 180, amount: 39600 });
    // 没有多挂一分钱、没有多一张钟单
    const after = await counts();
    expect([after.lines, after.sessions, after.regs]).toEqual([lines.lines, lines.sessions, lines.regs]);
    const from = (moved.body as RoomCenterBoard).rooms.find((x) => x.code === 'S301')!;
    expect(from).toMatchObject({ status: 'dirty', guests: [], version: before.version + 1 });
    expect(from.dirtyNote).toContain('S305');
    expect((await history('S301')).rows[0]).toMatchObject({ label: '换房（换出）', kind: 'move_out' });
    const hin = (await history('S305')).rows;
    expect(hin.find((x) => x.kind === 'move_in')!.text).toContain('从 S301');
    expect(hin.find((x) => x.kind === 'move_in')!.text).toContain('空调不凉');
    // 待清的房间不能换进来；钟房日志里也有一条换房间
    expect((await act('S305', 'move', { toSpaceId: spaceId.S301 })).body.error.code).toBe('ROOM_DIRTY');
    const log = await api(ctx.app, ctx.clerk, 'GET', '/api/clockroom/events');
    expect((log.body as { kind: string; text: string }[]).some((e) => e.kind === 'room' && e.text.includes('S305'))).toBe(true);
  });
});

describe('退房 → 待清 → 清洁完成', () => {
  it('退房：技师还在钟上的不能退；看过结账预览、账没结的要确认客人带手牌在店；退了转待清，待清不能登记；清洁完成回空闲', async () => {
    const card = await room('S305');
    const g = card.guests[0]!;
    const p = await preview('S305');
    expect(p).toMatchObject({ code: 'S305', version: card.version, unpaidTotal: 39600 });
    expect(p.guests[0]).toMatchObject({ tagCode: g.tagCode, roomAmount: 39600, billAmount: 39600 });
    expect(p.guests[0]!.running).toHaveLength(1);
    expect((await act('S305', 'checkout', { seenUnpaid: 39600, inHouse: true })).body.error.code).toBe('SESSION_RUNNING');
    // 下钟以后客人还在房里：仍是在用（已下钟、待退房），不是待清
    expect((await finish(g.sessions[0]!.id)).status).toBe(200);
    expect(await room('S305')).toMatchObject({ status: 'in_use', phase: 'done', amount: 39600 });
    expect((await act('S305', 'checkout', { seenUnpaid: 100, inHouse: true })).body.error.code).toBe('BILL_CHANGED');
    expect((await act('S305', 'checkout', { seenUnpaid: 39600 })).body.error.code).toBe('UNPAID_CONFIRM');
    expect((await act('S305', 'checkout', { inHouse: true })).status).toBe(400);
    const version = (await room('S305')).version;
    const out = await act('S305', 'checkout', { seenUnpaid: 39600, inHouse: true });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const dirty = (out.body as RoomCenterBoard).rooms.find((x) => x.code === 'S305')!;
    expect(dirty).toMatchObject({ status: 'dirty', guests: [], guestText: null, version: version + 1 });
    expect(dirty.dirtySince).toBeTruthy();
    // 迟到的重发（带着旧版本号）不会再做一遍
    expect((await api(ctx.app, ctx.clerk, 'POST', on('S305', 'checkout'), { expectedVersion: version, seenUnpaid: 39600, inHouse: true })).body.error.code).toBe('ROOM_STATE_MOVED');
    // 客人还在店、账还在手牌上（没有因为退房动一分钱）
    expect((await bill(g.visitId)).bill.amountCents).toBe(39600);
    const [reg] = await ctx.sql<{ status: string; closeKind: string; unpaidCents: number }[]>`SELECT status, close_kind, unpaid_cents FROM room_registrations WHERE id = ${g.registrationId}`;
    expect(reg).toMatchObject({ status: 'closed', closeKind: 'checkout', unpaidCents: 39600 });
    expect((await history('S305')).rows[0]!.text).toContain('客人带手牌继续在店');
    // 待清的房间不能登记，也不挂账
    const next = await enter();
    const n = await counts();
    expect((await register('S305', { tagCode: next.tagCode, technicianId: tech['01'] })).body.error.code).toBe('ROOM_DIRTY');
    expect(await counts()).toEqual(n);
    expect((await bill(next.visitId)).bill.amountCents).toBe(0);
    expect((await category('SPA 房')).counts.dirty).toBe(2);
    // 清洁完成：后勤（只有打扫权限）来点；之后回空闲、能登记
    expect((await act('S305', 'cleaned', {}, logistics)).status).toBe(200);
    expect(await room('S305')).toMatchObject({ status: 'free', dirtySince: null });
    expect((await act('S305', 'cleaned')).body.error.code).toBe('ROOM_NOT_DIRTY');
    expect((await act('S301', 'cleaned')).status).toBe(200);
    expect((await register('S305', { tagCode: next.tagCode, technicianId: tech['01'] })).status).toBe(200);
    expect((await history('S305')).rows.map((x) => x.label).slice(0, 4)).toEqual(['登记', '清洁完成', '退房', '下钟']);
  });

  it('客人在收银台结账离店：登记单跟着结束，房间自己转待清（不用再退房）；反结账也不会让他回到房间里', async () => {
    const card = await room('S305');
    const g = card.guests[0]!;
    await pay(g.visitId);
    const after = await room('S305');
    expect(after).toMatchObject({ status: 'dirty', guests: [] });
    const [reg] = await ctx.sql<{ status: string; closeKind: string; unpaidCents: number }[]>`SELECT status, close_kind, unpaid_cents FROM room_registrations WHERE id = ${g.registrationId}`;
    expect(reg).toMatchObject({ status: 'closed', closeKind: 'settled', unpaidCents: 0 });
    expect((await history('S305')).rows.find((x) => x.kind === 'checkout')!.text).toContain('结账离店');
    expect((await act('S305', 'checkout', { seenUnpaid: 0 })).body.error.code).toBe('NO_REGISTRATION');
    const paid = (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/visits/${g.visitId}`)).body as { checkout: { id: number } };
    const undo = await api(ctx.app, ctx.owner, 'POST', `/api/frontdesk/checkouts/${paid.checkout.id}/void`, { reason: '合成：反结账' });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(await room('S305')).toMatchObject({ status: 'dirty', guests: [] });
    expect((await act('S305', 'cleaned')).status).toBe(200);
  });

  it('钟房直接把钟派进一间房（没经房态中心登记）：在用；下钟以后自己转待清；待清的房间钟房这一版还能派（只拦维修）', async () => {
    const g = await enter();
    const dispatch = (visitId: number, technicianId: number) =>
      api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', {
        clientKey: randomUUID(),
        visitId,
        itemId: foot,
        tier: 'standard',
        quantity: 1,
        technicianId,
        callType: 'designated',
        startNow: true,
        spaceId: spaceId.S306,
        expectedTotal: 19800,
      });
    expect((await dispatch(g.visitId, tech['06']!)).status).toBe(200);
    const card = await room('S306');
    expect(card).toMatchObject({ status: 'in_use', phase: 'serving', amount: 19800, techText: '06 号 技师06' });
    expect(card.guests[0]).toMatchObject({ registrationId: null, tagCode: g.tagCode });
    expect((await act('S306', 'checkout', { seenUnpaid: 19800, inHouse: true })).body.error.code).toBe('NO_REGISTRATION');
    expect((await finish(card.guests[0]!.sessions[0]!.id)).status).toBe(200);
    expect(await room('S306')).toMatchObject({ status: 'dirty', guests: [] });
    const g2 = await enter();
    expect((await dispatch(g2.visitId, tech['06']!)).status).toBe(200);
    const again = await room('S306');
    expect(again.status).toBe('in_use');
    expect((await finish(again.guests[0]!.sessions[0]!.id)).status).toBe(200);
    expect((await act('S306', 'cleaned')).status).toBe(200);
    expect((await history('S306')).rows.map((x) => x.label)).toEqual(['清洁完成', '下钟', '上钟', '派钟', '下钟', '上钟', '派钟']);
  });
});

describe('维修、标待清', () => {
  it('维修要原因与预计完成时间；有人用着的不能设；维修中的房间不能登记、钟房也派不进来；可以改预计完成时间；恢复以后回空闲', async () => {
    const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
    expect((await act('S306', 'maintenance', { expectedAt: soon })).status).toBe(400);
    expect((await act('S306', 'maintenance', { reason: '漏', expectedAt: soon })).status).toBe(400);
    expect((await act('S306', 'maintenance', { reason: '空调漏水' })).status).toBe(400);
    expect((await act('S306', 'maintenance', { reason: '空调漏水', expectedAt: new Date(Date.now() - 60_000).toISOString() })).body.error.code).toBe('MAINTENANCE_PAST');
    expect((await act('S302', 'maintenance', { reason: '空调漏水', expectedAt: soon })).body.error.code).toBe('ROOM_IN_USE');
    expect((await act('S306', 'maintenance', { reason: '空调漏水', expectedAt: soon }, manager)).status).toBe(403);
    const set = await act('S306', 'maintenance', { reason: '空调漏水', expectedAt: soon }, logistics);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const card = await room('S306');
    expect(card.status).toBe('maintenance');
    expect(card.maintenance).toMatchObject({ reason: '空调漏水', expectedAt: soon, byName: '后勤小周' });
    expect((await category('SPA 房')).counts.maintenance).toBe(1);
    const g = await enter();
    const n = await counts();
    expect((await register('S306', { tagCode: g.tagCode, technicianId: tech['06'] })).body.error.code).toBe('ROOM_MAINTENANCE');
    const direct = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', {
      clientKey: randomUUID(),
      visitId: g.visitId,
      itemId: foot,
      tier: 'standard',
      quantity: 1,
      technicianId: tech['06'],
      callType: 'designated',
      startNow: true,
      spaceId: spaceId.S306,
      expectedTotal: 19800,
    });
    expect(direct.body.error.code).toBe('SPACE_MAINTENANCE');
    expect(await counts()).toEqual(n);
    expect((await act('S305', 'move', { toSpaceId: spaceId.S306 })).body.error.code).toBe('ROOM_NOT_IN_USE');
    // 改预计完成时间：再提交一次
    const later = new Date(Date.now() + 26 * 3600_000).toISOString();
    expect((await act('S306', 'maintenance', { reason: '空调漏水，等配件', expectedAt: later })).status).toBe(200);
    expect((await room('S306')).maintenance).toMatchObject({ reason: '空调漏水，等配件', expectedAt: later });
    expect((await act('S305', 'restore')).body.error.code).toBe('NOT_MAINTENANCE');
    expect((await act('S306', 'restore', { note: '修好了' })).status).toBe(200);
    expect(await room('S306')).toMatchObject({ status: 'free', maintenance: null });
    expect((await history('S306')).rows.map((x) => x.label).slice(0, 3)).toEqual(['恢复', '维修', '维修']);
    const [audit] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'room_center_state' AND target_id = ${String(spaceId.S306)}`;
    expect(audit!.n).toBeGreaterThanOrEqual(4);
  });

  it('大厅类没有业务单据：只标待清、清洁完成、维修；空闲的才用得着标待清', async () => {
    expect(await room('H201')).toMatchObject({ kind: 'hall', status: 'free' });
    expect((await act('H201', 'dirty', { note: '客人打翻了茶' }, logistics)).status).toBe(200);
    expect(await room('H201')).toMatchObject({ status: 'dirty', dirtyNote: '客人打翻了茶' });
    expect((await act('H201', 'dirty')).body.error.code).toBe('ROOM_NOT_FREE');
    expect((await act('H201', 'cleaned')).status).toBe(200);
    expect((await room('H201')).status).toBe('free');
    expect((await act('S302', 'dirty')).body.error.code).toBe('ROOM_NOT_FREE');
  });
});

describe('并房', () => {
  it('两间都在用的房间并成一起的（只是显示与历史，账各在各的手牌上）；哪一间退房关系就解除；也可以手动拆并', async () => {
    const a = await enter();
    expect((await register('A301', { tagCode: a.tagCode, technicianId: tech['01'] })).status).toBe(200);
    const b = await enter();
    expect((await act('A301', 'merge', { withSpaceId: spaceId.A302 })).body.error.code).toBe('ROOM_NOT_IN_USE');
    expect((await act('A301', 'merge', { withSpaceId: spaceId.A301 })).body.error.code).toBe('MERGE_SAME');
    expect((await register('A302', { tagCode: b.tagCode, technicianId: tech['06'] })).status).toBe(200);
    const lines = await counts();
    const merged = await act('A301', 'merge', { withSpaceId: spaceId.A302 });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    const cards = (merged.body as RoomCenterBoard).rooms;
    const codes = (c: RoomCard) => c.merged.map((m) => m.code);
    expect(codes(cards.find((x) => x.code === 'A301')!)).toEqual(['A302', 'A301']);
    expect(codes(cards.find((x) => x.code === 'A302')!)).toEqual(['A302', 'A301']);
    // 不动钱：明细、账单都没变
    expect((await counts()).lines).toBe(lines.lines);
    expect([(await bill(a.visitId)).bill.amountCents, (await bill(b.visitId)).bill.amountCents]).toEqual([19800, 19800]);
    expect((await act('A301', 'merge', { withSpaceId: spaceId.A302 })).body.error.code).toBe('MERGE_EXISTS');
    expect((await history('A302')).rows[0]).toMatchObject({ label: '并房', kind: 'merge' });
    // 手动拆并，再并回去；然后其中一间退房，关系自己解除
    expect((await act('A302', 'unmerge')).status).toBe(200);
    expect((await room('A301')).merged).toEqual([]);
    expect((await act('A302', 'unmerge')).body.error.code).toBe('NOT_MERGED');
    expect((await act('A301', 'merge', { withSpaceId: spaceId.A302 })).status).toBe(200);
    await release('A301');
    expect((await room('A302')).merged).toEqual([]);
    expect((await room('A301')).status).toBe('free');
    await release('A302');
  });
});

describe('派对房、已预订、客房', () => {
  it('派对房从房态中心开单（使用单）：在用；结束以后待清，待清、维修的不能开；清洁完成以后再开；今天订了这间的显示已预订', async () => {
    const g = await enter();
    const open = (code: string, tagCode: string, key = randomUUID()) => api(ctx.app, ctx.clerk, 'POST', on(code, 'usage'), { clientKey: key, tagCode, guests: 6, note: '生日' });
    const key = randomUUID();
    const u = await open('P201', g.tagCode, key);
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body).toMatchObject({ spaceCode: 'P201', tagCode: g.tagCode, guests: 6, status: 'open' });
    expect((await open('P201', g.tagCode, key)).body.id).toBe(u.body.id);
    expect(await room('P201')).toMatchObject({ kind: 'party', status: 'in_use', guestText: `手牌 ${g.tagCode} · 6 人` });
    expect((await room('P201')).usage).toMatchObject({ id: u.body.id, usageNo: u.body.usageNo });
    const g2 = await enter();
    expect((await open('P201', g2.tagCode)).body.error.code).toBe('ROOM_IN_USE');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/usages/${u.body.id}/end`, { clientKey: randomUUID() })).status).toBe(200);
    expect((await room('P201')).status).toBe('dirty');
    expect((await open('P201', g2.tagCode)).body.error.code).toBe('ROOM_DIRTY');
    expect((await act('P201', 'cleaned')).status).toBe(200);
    // 维修：房态中心不能开，平面图 / 派对房看板原来的开单接口也拦
    const soon = new Date(Date.now() + 3600_000).toISOString();
    expect((await act('P201', 'maintenance', { reason: '音响坏了', expectedAt: soon })).status).toBe(200);
    expect((await open('P201', g2.tagCode)).body.error.code).toBe('ROOM_MAINTENANCE');
    const old = await api(ctx.app, ctx.clerk, 'POST', '/api/usages', { clientKey: randomUUID(), spaceId: spaceId.P201, tagCode: g2.tagCode, guests: 2, note: '' });
    expect(old.body.error.code).toBe('SPACE_MAINTENANCE');
    expect((await act('P201', 'restore')).status).toBe(200);
    expect((await open('P201', g2.tagCode)).status).toBe(200);
    expect((await history('P201')).rows.map((x) => x.label)).toEqual(['开单', '恢复', '维修', '清洁完成', '结束使用', '开单']);
    // 已预订：今天订了 P202、还没到店（合成的一张预约）
    const today = (await board()).businessDate;
    await ctx.sql`
      INSERT INTO bookings (booking_no, kind, source, status, guest_name, guests, space_id, starts_at, ends_at, business_date, created_by, client_key, request_hash, confirmed_by, confirmed_at)
      VALUES ('YY-SYN-1', 'space', 'phone', 'confirmed', '电话客人', 8, ${spaceId.P202}, now() + interval '1 hour', now() + interval '3 hours', ${today}, ${ctx.clerkId},
              ${randomUUID()}, ${'a'.repeat(64)}, ${ctx.clerkId}, now())`;
    const booked = await room('P202');
    expect(booked.status).toBe('booked');
    expect(booked.booking).toMatchObject({ bookingNo: 'YY-SYN-1', guest: '电话客人', guests: 8 });
    expect((await category('派对房')).counts).toMatchObject({ total: 2, inUse: 1, booked: 1, free: 0 });
    // 待清比已预订靠前；清洁完成以后回到已预订
    expect((await act('P202', 'dirty')).status).toBe(200);
    expect((await room('P202')).status).toBe('dirty');
    expect((await act('P202', 'cleaned')).status).toBe(200);
    expect((await room('P202')).status).toBe('booked');
  });

  it('客房：开了客房功能以后，卡片来自客房的房态看板（入住、退房、打扫照原来的做），状态跟着看板走', async () => {
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
    const type = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '合成大床房', kind: 'daily', price: 30000 });
    expect(type.status, JSON.stringify(type.body)).toBe(200);
    const typeId = type.body.types.find((t: { name: string }) => t.name === '合成大床房').id;
    const linked = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo: '', floor: '3', roomTypeId: typeId, sortOrder: 0, active: true, spaceId: spaceId.G301 });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    // 空间台账有客房以前建的老房间：没挂空间（现在后台不让这样新建，这里直接放一间合成的）
    await ctx.sql`INSERT INTO rooms (room_no, floor, room_type_id) VALUES ('8801', '8', ${typeId})`;
    const b = await board();
    const hotel = b.categories.find((c) => c.name === '客房')!;
    expect(hotel.counts).toMatchObject({ total: 2, free: 2 });
    expect(hotel.hint).toBeNull();
    const card = b.rooms.find((r) => r.code === 'G301')!;
    expect(card).toMatchObject({ kind: 'hotel', status: 'free', spaceId: spaceId.G301 });
    expect(card.hotel).toMatchObject({ roomNo: 'G301', status: 'vacant', typeName: '合成大床房' });
    // 没挂空间的房间也在（卡片来自房间，不是空间）
    expect(b.rooms.find((r) => r.code === '8801')).toMatchObject({ kind: 'hotel', spaceId: null, key: expect.stringMatching(/^r\d+$/) });
    // 入住走客房原来的接口：卡片变在用、带住客与房费
    const g = await enter();
    const stay = await api(ctx.app, ctx.clerk, 'POST', '/api/rooms/checkin', {
      clientKey: randomUUID(),
      roomId: card.hotel!.id,
      tagCode: g.tagCode,
      guestLabel: '王先生',
      guests: 2,
      expectedCheckoutDate: null,
      expectedRate: 30000,
      deposit: null,
    });
    expect(stay.status, JSON.stringify(stay.body)).toBe(200);
    expect(await room('G301')).toMatchObject({ status: 'in_use', guestText: '王先生', amount: 30000 });
    // 房态中心的改房态、登记不管客房
    expect((await api(ctx.app, ctx.clerk, 'POST', on('G301', 'cleaned'), { expectedVersion: 0 })).body.error.code).toBe('ROOM_IS_HOTEL');
    // 客房的预约按房型订、不占具体哪一间：只在页签上提示
    const today = b.businessDate;
    await ctx.sql`
      INSERT INTO bookings (booking_no, kind, source, status, guest_name, guests, room_type_id, starts_at, ends_at, hold_until, business_date, created_by, client_key, request_hash, confirmed_by, confirmed_at)
      VALUES ('YY-SYN-2', 'room', 'phone', 'confirmed', '订房客人', 2, ${typeId}, now() + interval '1 hour', now() + interval '2 hours', now() + interval '5 hours', ${today}, ${ctx.clerkId},
              ${randomUUID()}, ${'b'.repeat(64)}, ${ctx.clerkId}, now())`;
    expect((await category('客房')).hint).toContain('1 张客房预约');
  });
});

describe('权限、看得到什么、给别的模块的入口', () => {
  it('看不了房态的岗位进不来；只管打扫的看得到房态与手牌号、看不到客人姓名，能改房态、不能登记换房退房；店员不能配房型', async () => {
    expect((await api(ctx.app, manager, 'GET', '/api/room-center')).status).toBe(403);
    expect((await api(ctx.app, null, 'GET', '/api/room-center')).status).toBe(401);
    // S302 里有两位客人（见上）；后勤只看得到手牌号
    const mine = await room('S302');
    const theirs = await room('S302', logistics);
    expect(theirs.status).toBe('in_use');
    expect(theirs.guests.map((g) => g.guest)).toEqual(mine.guests.map((g) => `手牌 ${g.tagCode}`));
    expect(theirs.guests.every((g) => g.sellerNo === '' && g.note === '')).toBe(true);
    const g = await enter();
    expect((await register('S306', { tagCode: g.tagCode, technicianId: tech['06'] }, randomUUID(), logistics)).status).toBe(403);
    for (const action of ['move', 'checkout', 'merge', 'unmerge', 'extend', 'usage']) {
      expect((await api(ctx.app, logistics, 'POST', on('S302', action), {})).status, action).toBe(403);
    }
    expect((await api(ctx.app, logistics, 'GET', on('S302', 'checkout-preview'))).status).toBe(403);
    expect((await api(ctx.app, logistics, 'GET', `/api/room-center/guest?tag=${g.tagCode}`)).status).toBe(403);
    expect((await api(ctx.app, logistics, 'GET', on('S302', 'history'))).status).toBe(200);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/admin/room-categories')).status).toBe(403);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/room-center/rooms/999999/history')).status).toBe(404);
  });

  it('登记表单问的两样：手牌上的客人（会员与档阶、已经登记在哪间）、出单员的工号（员工名单或系统账号）', async () => {
    const first = (await room('S302')).guests[0]!;
    const who = await api(ctx.app, ctx.clerk, 'GET', `/api/room-center/guest?tag=${first.tagCode.toLowerCase()}`);
    expect(who.body).toMatchObject({ visitId: first.visitId, tagCode: first.tagCode, guest: '女宾散客', memberGradeLabel: null, billAmount: 19800 });
    expect(who.body.registeredIn).toContain('S302');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/room-center/guest?tag=F060')).body.error.code).toBe('TAG_NOT_IN_STORE');
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/room-center/guest?tag=%E7%89%8C')).status).toBe(400);
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/room-center/seller?no=e007')).body).toEqual({ no: 'E007', name: '合成服务员' });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/room-center/seller?no=CLERK')).body).toEqual({ no: 'clerk', name: '测试店员' });
    expect((await api(ctx.app, ctx.clerk, 'GET', '/api/room-center/seller?no=x9')).body.error.code).toBe('SELLER_NOT_FOUND');
  });

  it('currentGuestOfSpace（餐饮「只填房号」点单用）：登记了的取先登记的那位；钟房直接派进来的取那张钟的客人；空房为空', async () => {
    const first = (await room('S302')).guests[0]!;
    expect(await currentGuestOfSpace(ctx.sql, spaceId.S302!)).toEqual({ visitId: first.visitId, tagNo: first.tagCode, memberId: null });
    expect(await currentGuestOfSpace(ctx.sql, spaceId.S306!)).toBeNull();
    expect(await currentGuestOfSpace(ctx.sql, spaceId.H201!)).toBeNull();
    const g = await enter();
    const direct = await api(ctx.app, ctx.clerk, 'POST', '/api/clockroom/dispatch', {
      clientKey: randomUUID(),
      visitId: g.visitId,
      itemId: foot,
      tier: 'standard',
      quantity: 1,
      technicianId: tech['06'],
      callType: 'designated',
      startNow: true,
      spaceId: spaceId.S306,
      expectedTotal: 19800,
    });
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);
    expect(await currentGuestOfSpace(ctx.sql, spaceId.S306!)).toEqual({ visitId: g.visitId, tagNo: g.tagCode, memberId: null });
    // 事务里也能调
    await ctx.sql.begin(async (tx) => expect(await currentGuestOfSpace(tx, spaceId.S306!)).toMatchObject({ tagNo: g.tagCode }));
  });

  it('两间房一起数：各房型的数量加起来等于总数，五种状态都数得到', async () => {
    const b = await board();
    const sum = (k: keyof RoomCenterBoard['total']) => b.categories.reduce((n, c) => n + c.counts[k], 0);
    for (const k of ['total', 'free', 'inUse', 'dirty', 'maintenance', 'booked'] as const) expect(sum(k), k).toBe(b.total[k]);
    expect(b.total.total).toBe(b.rooms.length);
    for (const c of b.categories) expect(c.counts.free + c.counts.inUse + c.counts.dirty + c.counts.maintenance + c.counts.booked).toBe(c.counts.total);
  });
});
