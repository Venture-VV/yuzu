// 8.0.21 OTA 渠道订单（docs/INTEGRATIONS_V8021.md 第 4 节，CW-I / CW9；迁移 150）：渠道订单表导入成客房预约。
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectOtaColumns, parseOtaRows } from '../src/shared/ota';
import { COUPON_CODE_PATTERN } from '../src/shared/checkout';
import { hashRequest } from '../src/server/lib/idempotency';
import { otaCouponCode } from '../src/server/modules/ota';
import { shiftDate } from '../src/shared/labels';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
let roomTypeId: number;
let channelId: number;
let today: string;

const header = '订单号,入住人,联系电话,房型,入住日期,离店日期,间数,订单金额,支付方式,订单状态';
const csv = (rows: string[]) => [header, ...rows].join('\r\n');
const importFile = (rows: string[], extra: Record<string, unknown> = {}) =>
  api(ctx.app, ctx.clerk, 'POST', '/api/ota/import', { clientKey: randomUUID(), channelId, fileName: 'orders.csv', csv: csv(rows), ...extra });
const order = async (no: string) => ((await api(ctx.app, ctx.clerk, 'GET', '/api/ota/orders')).body as { orderNo: string }[]).find((o) => o.orderNo === no) as Record<string, any>;

beforeAll(async () => {
  ctx = await setup();
  today = (await api(ctx.app, ctx.owner, 'GET', '/api/auth/me')).body.today;
  expect((await api(ctx.app, ctx.owner, 'PUT', '/api/admin/rooms/rules', { enabled: true, checkoutMinute: 720, lateFullMinute: 1080, hourlyGraceMinutes: 15, defaultDeposit: 0 })).status).toBe(200);
  const rt = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '渠道大床房', kind: 'daily', price: 26800 });
  roomTypeId = rt.body.types.find((t: { name: string }) => t.name === '渠道大床房').id;
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/rooms', { roomNo: 'Q801', floor: '8', roomTypeId, sortOrder: 0, active: true })).status).toBe(200);
}, 60_000);
afterAll(async () => ctx.close());

describe('解析', () => {
  it('认列、日期（几种写法）、晚数推离店、金额、预付 / 现付、取消', () => {
    const h = ['预订号', '客人姓名', '房型名称', '到店日期', '入住晚数', '房间数', '总价', '付款类型', '状态'];
    const map = detectOtaColumns(h);
    expect(map).toMatchObject({ orderNo: '预订号', guestName: '客人姓名', roomType: '房型名称', checkin: '到店日期', nights: '入住晚数', rooms: '房间数', amount: '总价', payMode: '付款类型', status: '状态' });
    const r = parseOtaRows(h, [
      { row: 2, cells: ['A1', '张三', '大床', '2026/12/1', '2', '1', '¥1,234.50', '到店付', '已确认'] },
      { row: 3, cells: ['A2', '李四', '大床', '2026年12月3日', '1', '2', '500', '预付', '已取消'] },
      { row: 4, cells: ['A3', '', '大床', '不是日期', '1', '1', '100', '', ''] },
    ], map);
    expect(r.orders).toMatchObject([
      { orderNo: 'A1', checkin: '2026-12-01', checkout: '2026-12-03', nights: 2, rooms: 1, amountCents: 123_450, payMode: 'pay_at_hotel', channelStatus: 'confirmed' },
      { orderNo: 'A2', checkin: '2026-12-03', checkout: '2026-12-04', rooms: 2, amountCents: 50_000, payMode: 'prepaid', channelStatus: 'cancelled' },
    ]);
    expect(r.problems).toEqual([{ row: 4, message: '订单 A3：入住日读不出来' }]);
    // 券码按「渠道 + 原订单号」认：两个渠道同一个订单号、AB-123 与 AB123 都不撞；同一张每次一样；合团购券码的格式
    const codes = [otaCouponCode(1, 'AB-123'), otaCouponCode(1, 'AB123'), otaCouponCode(2, 'AB123'), otaCouponCode(1, 'ab123'), otaCouponCode(12, '3'), otaCouponCode(1, '23')];
    expect(new Set(codes).size).toBe(codes.length);
    expect(otaCouponCode(1, 'AB-123')).toBe(otaCouponCode(1, 'AB-123'));
    expect(otaCouponCode(1, 'AB-123')).toMatch(/^OTA1AB123[0-9A-F]{8}$/);
    for (const c of [...codes, otaCouponCode(999_999, 'x'.repeat(64))]) expect(c).toMatch(COUPON_CODE_PATTERN);
  });
});

describe('渠道订单', () => {
  it('渠道与房型对照（后台）→ 导入：建预约（来源渠道、几间几张）、对照不上的没建成、过去的跳过；同一份文件导不了第二次', async () => {
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/ota/channels', { name: '携程', commissionBp: 1500, roomMap: {} })).status).toBe(403);
    const made = await api(ctx.app, ctx.owner, 'POST', '/api/ota/channels', { name: '携程', commissionBp: 1500, roomMap: { 豪华大床房: roomTypeId } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    channelId = made.body.find((c: { name: string }) => c.name === '携程').id;
    const d1 = shiftDate(today, 2);
    const rows = [
      `C1001,王五,13800001111,豪华大床房,${d1},${shiftDate(d1, 2)},2,1200.00,预付,已确认`,
      `C1002,赵六,,双床房,${d1},${shiftDate(d1, 1)},1,300,现付,已确认`,
      `C1003,孙七,,豪华大床房,${shiftDate(today, -3)},${shiftDate(today, -2)},1,300,预付,已确认`,
    ];
    const preview = await api(ctx.app, ctx.clerk, 'POST', '/api/ota/import/preview', { channelId, fileName: 'orders.csv', csv: csv(rows) });
    expect(preview.body).toMatchObject({ problem: null, total: 3, unmapped: ['双床房'], duplicate: false });
    const r = await importFile(rows);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ rows: 3, created: 1, failed: 1, skipped: 1 });
    const o1 = await order('C1001');
    expect(o1).toMatchObject({ status: 'booked', rooms: 2, nights: 2, payMode: 'prepaid', roomTypeName: '渠道大床房', overbooked: true });
    expect(o1.bookings).toHaveLength(2);
    const b = (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/${o1.bookings[0].id}`)).body;
    expect(b).toMatchObject({ kind: 'room', source: 'ota', status: 'confirmed', guestName: '王五' });
    expect(b.note).toContain('携程订单 C1001');
    expect((await order('C1002')).failReason).toContain('还没有对照本店房型');
    expect((await order('C1003')).status).toBe('skipped');
    // 同一份文件再导：拦下
    expect((await importFile(rows)).body.error.code).toBe('OTA_FILE_DUP');

    // 补了对照以后重试
    const ch = (await api(ctx.app, ctx.clerk, 'GET', '/api/ota/channels')).body.find((c: { id: number }) => c.id === channelId);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/ota/channels/${channelId}`, { ...ch, roomMap: { ...ch.roomMap, 双床房: roomTypeId } })).status).toBe(200);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/ota/channels/${channelId}`, { ...ch, roomMap: {} })).body.error.code).toBe('OTA_CHANNEL_CHANGED');
    const retried = await api(ctx.app, ctx.clerk, 'POST', `/api/ota/orders/${(await order('C1002')).id}/retry`, {});
    expect(retried.body).toMatchObject({ status: 'booked' });
    expect(retried.body.bookings).toHaveLength(1);
  });

  it('再导一次：改了日期的改时间、减了间数的退一间、取消的取消预约；没变的不动', async () => {
    const d2 = shiftDate(today, 4);
    const r = await importFile([
      `C1001,王五,13800001111,豪华大床房,${d2},${shiftDate(d2, 2)},1,600.00,预付,已确认`,
      `C1002,赵六,,双床房,${shiftDate(today, 2)},${shiftDate(today, 3)},1,300,现付,已取消`,
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ updated: 1, cancelled: 1 });
    const o1 = await order('C1001');
    const live = o1.bookings.filter((b: { status: string }) => b.status === 'confirmed');
    expect(live).toHaveLength(1);
    expect(o1.bookings.filter((b: { status: string }) => b.status === 'cancelled')).toHaveLength(1);
    const b = (await api(ctx.app, ctx.clerk, 'GET', `/api/bookings/${live[0].id}`)).body;
    expect(b.businessDate ?? b.startsAt.slice(0, 10)).toBe(d2);
    const o2 = await order('C1002');
    expect(o2.status).toBe('cancelled');
    expect(o2.bookings.every((x: { status: string }) => x.status === 'cancelled')).toBe(true);
    // 没变的再导一次：不动
    const same = await importFile([`C1001,王五,13800001111,豪华大床房,${d2},${shiftDate(d2, 2)},1,600.00,预付,已确认`, '']);
    expect(same.body).toMatchObject({ unchanged: 1, created: 0, updated: 0 });
  });

  it('导入记下了、逐张处理到一半断了：原样重提接着做完；更晚的一次导入已经改过的那张不拿旧文件盖回去', async () => {
    const d = shiftDate(today, 6);
    const rowsA = [`C2001,周八,,豪华大床房,${d},${shiftDate(d, 1)},1,300,现付,已确认`, `C2002,吴九,,豪华大床房,${d},${shiftDate(d, 1)},1,300,现付,已确认`];
    // 模拟断在导入记录写完、逐张处理之前：只写导入记录（与 importOtaOrders 同样的摘要）
    const keyA = randomUUID();
    const text = csv(rowsA);
    const fileHash = createHash('sha256').update(text).digest('hex');
    const ownerId = Number((await ctx.sql<{ id: number }[]>`SELECT id FROM staff WHERE username = 'owner' LIMIT 1`)[0]?.id ?? (await ctx.sql<{ id: number }[]>`SELECT id FROM staff ORDER BY id LIMIT 1`)[0]!.id);
    await ctx.sql`
      INSERT INTO ota_imports (channel_id, file_name, file_hash, rows, client_key, request_hash, staff_id)
      VALUES (${channelId}, 'orders.csv', ${fileHash}, 2, ${keyA}, ${hashRequest({ channelId, fileHash })}, ${ownerId})`;
    expect(await order('C2001')).toBeUndefined();
    const resumed = await api(ctx.app, ctx.clerk, 'POST', '/api/ota/import', { clientKey: keyA, channelId, fileName: 'orders.csv', csv: text });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body).toMatchObject({ created: 2 });
    expect((await order('C2001')).bookings).toHaveLength(1);
    expect((await order('C2002')).bookings).toHaveLength(1);
    // 再重提一次：都处理过了，什么都不动
    const again = await api(ctx.app, ctx.clerk, 'POST', '/api/ota/import', { clientKey: keyA, channelId, fileName: 'orders.csv', csv: text });
    expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    // 更晚的一次导入把 C2001 改成 2 间；之后再重提最早那次：C2001 不回到 1 间
    const later = await importFile([`C2001,周八,,豪华大床房,${d},${shiftDate(d, 1)},2,600,现付,已确认`]);
    expect(later.body).toMatchObject({ updated: 1 });
    const stale = await api(ctx.app, ctx.clerk, 'POST', '/api/ota/import', { clientKey: keyA, channelId, fileName: 'orders.csv', csv: text });
    expect(stale.body).toMatchObject({ created: 0, updated: 0, cancelled: 0, unchanged: 2 });
    const o = await order('C2001');
    expect(o).toMatchObject({ rooms: 2, amountCents: 60_000 });
    expect(o.bookings.filter((b: { status: string }) => b.status === 'confirmed')).toHaveLength(2);
  });

  it('对账：按入住月份，订单数、间夜、金额、佣金（15%）、净额；导出 CSV', async () => {
    const month = shiftDate(today, 4).slice(0, 7);
    const rows = (await api(ctx.app, ctx.clerk, 'GET', `/api/ota/recon?month=${month}`)).body as { channelName: string; orders: number; roomNights: number; amountCents: number; commissionCents: number; netCents: number }[];
    const ctrip = rows.find((x) => x.channelName === '携程')!;
    expect(ctrip.orders).toBeGreaterThanOrEqual(1);
    expect(ctrip.commissionCents).toBe(Math.round(ctrip.amountCents * 0.15));
    expect(ctrip.netCents).toBe(ctrip.amountCents - ctrip.commissionCents);
    const file = await ctx.app.inject({ method: 'GET', url: `/api/ota/recon.csv?month=${month}`, headers: { cookie: ctx.clerk } });
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('渠道,订单数,间夜');
  });
});
