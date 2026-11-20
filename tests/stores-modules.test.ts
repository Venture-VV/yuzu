// 多门店的各块（8.0.22，docs/MULTISTORE_V8022.md 第 5、7、11 节）：设备、客房、技师、桌台按店分开（同号各一份，
// 别家店的与不存在一样）；看板按店看、店主可以合并看；同一位会员两家店都能用储值，门店之间的储值结算表对得上。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createMember, login, rechargeBody, setup, type TestContext } from './helpers';

let ctx: TestContext;
let ft: number;
let ftDesk: string;

const inStore = async <T>(storeId: number, fn: () => Promise<T>) => {
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId })).status).toBe(200);
  try {
    return await fn();
  } finally {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: 1 })).status).toBe(200);
  }
};

beforeAll(async () => {
  ctx = await setup();
  const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '福田主体' });
  ft = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'FT', name: '福田店', entityId: entity.body.id })).body.id;
  const created = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username: 'ftmgr', displayName: '福田店总', role: 'store_manager' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const temp = created.body.temporaryPassword as string;
  const first = await login(ctx.app, 'ftmgr', temp);
  expect((await api(ctx.app, first, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: 'ftmgr-2026x' })).status).toBe(200);
  expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${created.body.staff?.id ?? created.body.id}/stores`, { storeIds: [ft] })).status).toBe(200);
  ftDesk = await login(ctx.app, 'ftmgr', 'ftmgr-2026x');
}, 90_000);
afterAll(async () => ctx.close());

describe('多门店的各块', () => {
  it('设备：两家店可以有同样编号的设备，清单只看自己店的，改不到别家店的', async () => {
    const body = (code: string) => ({ clientKey: randomUUID(), code, name: '收银小票机', kind: 'printer', area: '收银', connection: 'network', host: '127.0.0.1', port: 9100 });
    const hq = await api(ctx.app, ctx.owner, 'POST', '/api/devices', body('PRN-SY-01'));
    expect(hq.status, JSON.stringify(hq.body)).toBe(200);
    const fd = await api(ctx.app, ftDesk, 'POST', '/api/devices', body('PRN-SY-01'));
    expect(fd.status, JSON.stringify(fd.body)).toBe(200);
    expect(fd.body.id).not.toBe(hq.body.id);
    const ftList = (await api(ctx.app, ftDesk, 'GET', '/api/devices')).body as { id: number }[];
    expect(ftList.map((d) => d.id)).toEqual([fd.body.id]);
    const hqList = (await api(ctx.app, ctx.owner, 'GET', '/api/devices')).body as { id: number }[];
    expect(hqList.map((d) => d.id)).not.toContain(fd.body.id);
    // 福田店的人改本店的设备：与不存在一样
    const { clientKey: _k, code: _c, ...fields } = body('PRN-SY-01');
    const edit = await api(ctx.app, ftDesk, 'PUT', `/api/devices/${hq.body.id}`, { ...fields, expectedVersion: hq.body.version });
    expect(edit.status).toBe(404);
  });

  it('客房、技师、桌台：同名同号各店一份，清单只看自己店的', async () => {
    // 客房开关、餐饮开关是按店的设置：福田店自己打开
    await api(ctx.app, ftDesk, 'PUT', '/api/admin/rooms/rules', { enabled: true });
    for (const cookie of [ctx.owner, ftDesk]) {
      const rt = await api(ctx.app, cookie, 'POST', '/api/admin/rooms/types', { name: '大床房', kind: 'daily', price: 26800 });
      expect(rt.status, JSON.stringify(rt.body)).toBeLessThan(300);
      const typeId = (await api(ctx.app, cookie, 'GET', '/api/admin/rooms')).body.types.find((t: { name: string }) => t.name === '大床房').id;
      const room = await api(ctx.app, cookie, 'POST', '/api/admin/rooms/rooms', { roomNo: '801', floor: '8', roomTypeId: typeId, sortOrder: 0, active: true });
      expect(room.status, JSON.stringify(room.body)).toBeLessThan(300);
      const tech = await api(ctx.app, cookie, 'POST', '/api/admin/technicians', { techNo: '01', name: '一号', gender: 'female', grade: 'standard' });
      expect(tech.status, JSON.stringify(tech.body)).toBeLessThan(300);
      const table = await api(ctx.app, cookie, 'POST', '/api/admin/dining/tables', { name: 'A1', area: '大厅', seats: 4 });
      expect(table.status, JSON.stringify(table.body)).toBeLessThan(300);
    }
    const count = async (sql: string) => (await ctx.sql.unsafe<{ storeId: number; n: number }[]>(sql)).map((r) => [Number(r.storeId), Number(r.n)]);
    expect(await count(`SELECT store_id, count(*)::int AS n FROM rooms WHERE room_no = '801' GROUP BY 1 ORDER BY 1`)).toEqual([
      [1, 1],
      [ft, 1],
    ]);
    expect(await count(`SELECT store_id, count(*)::int AS n FROM technicians WHERE tech_no = '01' GROUP BY 1 ORDER BY 1`)).toEqual([
      [1, 1],
      [ft, 1],
    ]);
    expect(await count(`SELECT store_id, count(*)::int AS n FROM dining_tables WHERE name = 'A1' GROUP BY 1 ORDER BY 1`)).toEqual([
      [1, 1],
      [ft, 1],
    ]);
    const ftRooms = (await api(ctx.app, ftDesk, 'GET', '/api/admin/rooms')).body;
    expect(ftRooms.rooms.map((r: { roomNo: string }) => r.roomNo)).toEqual(['801']);
    const ftTechs = (await api(ctx.app, ftDesk, 'GET', '/api/admin/technicians')).body.technicians as { techNo: string }[];
    expect(ftTechs.map((t) => t.techNo)).toEqual(['01']);
    const ftTables = (await api(ctx.app, ftDesk, 'GET', '/api/admin/dining/tables')).body.tables as { name: string }[];
    expect(ftTables.map((t) => t.name)).toEqual(['A1']);
    // 本店的房型在福田店改不到
    const hqType = (await api(ctx.app, ctx.owner, 'GET', '/api/admin/rooms')).body.types[0];
    expect((await api(ctx.app, ftDesk, 'PUT', `/api/admin/rooms/types/${hqType.id}`, { name: '本店的房型', kind: 'daily', price: 1 })).status).toBe(404);
  });

  it('储值全公司通用：本店充值、福田店用储值结账；看板按店看与合并看；门店之间的储值结算表', async () => {
    const m = await createMember(ctx, '跨店会员');
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/recharges', rechargeBody(m.id, 100000))).status).toBeLessThan(300);
    // 两家店都开班
    await api(ctx.app, ftDesk, 'POST', '/api/shifts', { openingCash: 0 });
    // 福田店手牌、接待会员、用储值结账
    expect((await api(ctx.app, ftDesk, 'POST', '/api/frontdesk/tags/batch', { prefix: 'F', from: 1, to: 2, width: 3, zone: 'male' })).status).toBe(200);
    const vin = await api(ctx.app, ftDesk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'F001', zone: 'male', memberId: m.id }] });
    expect(vin.status, JSON.stringify(vin.body)).toBe(201);
    const visitId = vin.body.visits[0].id as number;
    const preview = (await api(ctx.app, ftDesk, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
    const total = preview.totalAmount as number;
    expect(total).toBeGreaterThan(0);
    const paid = await api(ctx.app, ftDesk, 'POST', '/api/frontdesk/checkouts', {
      clientKey: randomUUID(),
      visitIds: [visitId],
      expectedTotal: total,
      payments: [{ method: 'wallet', memberId: m.id, amount: total, expectedSplit: { principal: total, bonus: 0 } }],
    });
    expect([200, 201], JSON.stringify(paid.body)).toContain(paid.status);
    // 消费记在福田店
    const [c] = await ctx.sql<{ storeId: number }[]>`SELECT store_id FROM consumptions WHERE member_id = ${m.id}`;
    expect(Number(c!.storeId)).toBe(ft);

    // 看板：福田店只看到福田店的充值（0）与结账；店主合并看两家店的都算
    const ftDash = (await api(ctx.app, ftDesk, 'GET', '/api/dashboard')).body;
    expect(ftDash.todayStats.rechargePaid).toBe(0);
    expect(ftDash.todayStats.checkouts).toBe(1);
    const hqDash = (await api(ctx.app, ctx.owner, 'GET', '/api/dashboard')).body;
    expect(hqDash.todayStats.rechargePaid).toBe(100000);
    const merged = (await api(ctx.app, ctx.owner, 'GET', '/api/dashboard?scope=all')).body;
    expect(merged.todayStats.rechargePaid).toBe(100000);
    expect(merged.todayStats.checkouts).toBe(hqDash.todayStats.checkouts + 1);
    // 只能进一家店的人加 scope=all 也只看自己店的
    expect((await api(ctx.app, ftDesk, 'GET', '/api/dashboard?scope=all')).body.todayStats.rechargePaid).toBe(0);

    // 门店之间的储值结算：会员在本店开卡、在福田店用了 total 的本金 → 本店应付福田店 total
    const today = ftDash.today as string;
    const settle = (await api(ctx.app, ctx.owner, 'GET', `/api/reports/store-settlement?from=${today}&to=${today}`)).body;
    expect(settle.pairs).toEqual([{ homeStoreId: 1, spendStoreId: ft, count: 1, principal: total, bonus: 0 }]);
    expect(settle.net).toEqual([{ fromStoreId: 1, toStoreId: ft, principal: total }]);
  });

  it('本店价：福田店给一个项目单独定价，福田店挂账按本店价；本店照旧按全公司的价', async () => {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/items', { name: '本店价测试的毛巾', category: '零售', price: 1500 })).status).toBeLessThan(300);
    const catalog = (await api(ctx.app, ctx.owner, 'GET', '/api/catalog')).body as { items: { id: number; name: string; technicianRequired: boolean; prices: { tier: string; price: number }[] }[] };
    const item = catalog.items.find((i) => i.name === '本店价测试的毛巾')!;
    const tier = item.prices[0]!.tier;
    const base = item.prices[0]!.price;
    // 本店里设本店价：拒绝
    expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/catalog/store-prices', { itemId: item.id, tier, price: base + 100 })).status).toBe(400);
    // 8.1.17（BW-11）起改本店价要写原因
    const set = await api(ctx.app, ftDesk, 'PUT', '/api/admin/catalog/store-prices', { itemId: item.id, tier, price: base + 1000, reason: '福田店单独定价' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const ftItem = ((await api(ctx.app, ftDesk, 'GET', '/api/catalog')).body.items as typeof catalog.items).find((i) => i.id === item.id)!;
    expect(ftItem.prices.find((p) => p.tier === tier)!.price).toBe(base + 1000);
    // 后台维护价目（?all=1）看到的是全公司的价
    const adminItem = ((await api(ctx.app, ftDesk, 'GET', '/api/catalog?all=1')).body.items as typeof catalog.items).find((i) => i.id === item.id)!;
    expect(adminItem.prices.find((p) => p.tier === tier)!.price).toBe(base);
    const hqItem = ((await api(ctx.app, ctx.owner, 'GET', '/api/catalog')).body.items as typeof catalog.items).find((i) => i.id === item.id)!;
    expect(hqItem.prices.find((p) => p.tier === tier)!.price).toBe(base);
    // 福田店挂账按本店价
    const vin = await api(ctx.app, ftDesk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'F002', zone: 'male' }] });
    expect(vin.status, JSON.stringify(vin.body)).toBe(201);
    const post = await api(ctx.app, ftDesk, 'POST', `/api/frontdesk/visits/${vin.body.visits[0].id}/charges`, {
      clientKey: randomUUID(),
      lines: [{ itemId: item.id, quantity: 1, tier }],
      expectedTotal: base + 1000,
    });
    expect(post.status, JSON.stringify(post.body)).toBeLessThan(300);
    // 取消本店价：按全公司的
    expect((await api(ctx.app, ftDesk, 'PUT', '/api/admin/catalog/store-prices', { itemId: item.id, tier, price: null, reason: '回到全公司的价' })).status).toBe(200);
    const back = ((await api(ctx.app, ftDesk, 'GET', '/api/catalog')).body.items as typeof catalog.items).find((i) => i.id === item.id)!;
    expect(back.prices.find((p) => p.tier === tier)!.price).toBe(base);
  });

  it('审计按店记、按店看', async () => {
    const [row] = await ctx.sql<{ storeId: number }[]>`SELECT store_id FROM audit_logs WHERE action = 'device_created' ORDER BY id DESC LIMIT 1`;
    expect(Number(row!.storeId)).toBe(ft);
    const ftAudit = await inStore(ft, async () => (await api(ctx.app, ctx.owner, 'GET', '/api/audit?limit=200')).body as { action: string; id: number }[]);
    const hqAudit = (await api(ctx.app, ctx.owner, 'GET', '/api/audit?limit=200')).body as { action: string; id: number }[];
    const ids = new Set(hqAudit.map((a) => a.id));
    expect(ftAudit.some((a) => ids.has(a.id))).toBe(false);
  });
});
