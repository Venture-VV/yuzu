// 多门店的前台（8.0.22，docs/MULTISTORE_V8022.md 第 5 节）：第二家店的手牌、接待、结账、班次、日结与本店分开；
// 两家店可以有同号的手牌；会员、钱包全公司通用，流水记发生在哪家店。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, login, setup, type TestContext } from './helpers';

let ctx: TestContext;
let ft: number;
let ftClerk: string;

async function newStaff(username: string, role = 'clerk') {
  const created = await api(ctx.app, ctx.owner, 'POST', '/api/staff', { username, displayName: username, role });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const temp = created.body.temporaryPassword as string;
  const first = await login(ctx.app, username, temp);
  expect((await api(ctx.app, first, 'POST', '/api/auth/change-password', { currentPassword: temp, newPassword: `${username}-2026x` })).status).toBe(200);
  return Number(created.body.staff?.id ?? created.body.id);
}

const inStore = async <T>(storeId: number, fn: () => Promise<T>) => {
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId })).status).toBe(200);
  try {
    return await fn();
  } finally {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/auth/store', { storeId: 1 })).status).toBe(200);
  }
};

const checkin = (cookie: string, tagCode: string) => api(ctx.app, cookie, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male' }] });

async function checkout(cookie: string, visitId: number) {
  const preview = (await api(ctx.app, cookie, 'GET', `/api/frontdesk/checkout-preview?ids=${visitId}`)).body;
  const paid = await api(ctx.app, cookie, 'POST', '/api/frontdesk/checkouts', {
    clientKey: randomUUID(),
    visitIds: [visitId],
    expectedTotal: preview.totalAmount,
    payments: [{ method: 'cash', amount: preview.totalAmount }],
  });
  expect([200, 201], JSON.stringify(paid.body)).toContain(paid.status);
  return paid.body;
}

beforeAll(async () => {
  ctx = await setup();
  const entity = await api(ctx.app, ctx.owner, 'POST', '/api/admin/entities', { name: '福田主体' });
  ft = (await api(ctx.app, ctx.owner, 'POST', '/api/admin/stores', { code: 'FT', name: '福田店', entityId: entity.body.id })).body.id;
  const id = await newStaff('ftdesk');
  expect((await api(ctx.app, ctx.owner, 'PUT', `/api/staff/${id}/stores`, { storeIds: [ft] })).status).toBe(200);
  ftClerk = await login(ctx.app, 'ftdesk', 'ftdesk-2026x');
  // 两家店各建一批同号的手牌
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'S', from: 1, to: 3, width: 3, zone: 'male' })).status).toBe(200);
  await inStore(ft, async () => {
    const made = await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'S', from: 1, to: 2, width: 3, zone: 'male' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
  });
}, 90_000);
afterAll(async () => ctx.close());

describe('多门店的前台', () => {
  it('手牌按店：两家店可以有同号的手牌，看板、手牌清单只看自己店的', async () => {
    const rows = await ctx.sql<{ storeId: number; n: number }[]>`SELECT store_id, count(*)::int AS n FROM hand_tags WHERE code LIKE 'S00%' GROUP BY store_id ORDER BY store_id`;
    expect(rows).toEqual([
      { storeId: 1, n: 3 },
      { storeId: ft, n: 2 },
    ]);
    const ftBoard = (await api(ctx.app, ftClerk, 'GET', '/api/frontdesk/board')).body;
    expect(ftBoard.tags.map((t: { code: string }) => t.code).sort()).toEqual(['S001', 'S002']);
    const hqBoard = (await api(ctx.app, ctx.clerk, 'GET', '/api/frontdesk/board')).body;
    expect(hqBoard.tags.filter((t: { code: string }) => t.code.startsWith('S00')).length).toBe(3);
    // 第二家店没有 S003：牌号不存在
    expect((await checkin(ftClerk, 'S003')).body.error.code).toBe('TAG_NOT_FOUND');
  });

  it('接待、结账、班次、日结各算各的', async () => {
    expect((await api(ctx.app, ftClerk, 'POST', '/api/shifts', { openingCash: 0 })).status).toBeLessThan(300);
    const hqShift = await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 });
    expect(hqShift.status === 201 || hqShift.status === 200 || hqShift.body.error?.code === 'SHIFT_ALREADY_OPEN').toBe(true);

    const ftIn = await checkin(ftClerk, 'S001');
    expect(ftIn.status, JSON.stringify(ftIn.body)).toBe(201);
    const hqIn = await checkin(ctx.clerk, 'S001');
    expect(hqIn.status, JSON.stringify(hqIn.body)).toBe(201);
    const [ftVisit] = await ctx.sql<{ storeId: number }[]>`SELECT store_id FROM visits WHERE id = ${ftIn.body.visits[0].id}`;
    expect(ftVisit!.storeId).toBe(ft);
    const [hqVisit] = await ctx.sql<{ storeId: number }[]>`SELECT store_id FROM visits WHERE id = ${hqIn.body.visits[0].id}`;
    expect(hqVisit!.storeId).toBe(1);

    const ftPaid = await checkout(ftClerk, ftIn.body.visits[0].id);
    const [ftCheckout] = await ctx.sql<{ storeId: number; businessDate: string }[]>`SELECT store_id, business_date FROM checkouts WHERE id = ${ftPaid.id}`;
    expect(ftCheckout!.storeId).toBe(ft);
    await checkout(ctx.clerk, hqIn.body.visits[0].id);

    // 结账记录：各看各的
    const today = ftCheckout!.businessDate;
    const ftList = (await api(ctx.app, ftClerk, 'GET', `/api/frontdesk/checkouts?date=${today}`)).body;
    const ftRows = (ftList.items ?? ftList.checkouts ?? ftList) as { storeId?: number; id: number }[];
    const ftIds = new Set(ftRows.map((r) => r.id));
    const all = await ctx.sql<{ id: number; storeId: number }[]>`SELECT id, store_id FROM checkouts WHERE business_date = ${today}`;
    for (const r of all) expect(ftIds.has(r.id), `checkout ${r.id} in store ${r.storeId}`).toBe(r.storeId === ft);

    // 日结：福田店只算福田店的结账；本店不算福田店的
    const ftSettlement = (await inStore(ft, async () => api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`))).body;
    const hqSettlement = (await api(ctx.app, ctx.owner, 'GET', `/api/settlements/${today}`)).body;
    const ftCount = all.filter((r) => r.storeId === ft).length;
    const hqCount = all.filter((r) => r.storeId === 1).length;
    // 两家店各结了一张；不分店的话两边都会是 2 张
    expect(ftCount).toBeGreaterThan(0);
    expect(ftSettlement.business.checkouts.count).toBe(ftCount);
    expect(hqSettlement.business.checkouts.count).toBe(hqCount);
    // 储值、会员余额全公司通用：期初期末两边一样
    expect(ftSettlement.balances).toEqual(hqSettlement.balances);

    // 班次：各店只看到自己店的
    const ftShifts = (await api(ctx.app, ftClerk, 'GET', '/api/shifts/current')).body;
    expect(ftShifts.shift).toBeTruthy();
    const [ftShiftRow] = await ctx.sql<{ storeId: number }[]>`SELECT store_id FROM shifts WHERE id = ${ftShifts.shift.id}`;
    expect(ftShiftRow!.storeId).toBe(ft);
  });
});
