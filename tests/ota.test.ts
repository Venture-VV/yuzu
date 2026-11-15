// 8.0.21 OTA 渠道订单（docs/INTEGRATIONS_V8021.md 第 4 节，CW-I / CW9；迁移 150）：渠道订单表导入成客房预约。
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectOtaColumns, parseOtaRows } from '../src/shared/ota';
import { COUPON_CODE_PATTERN } from '../src/shared/checkout';
import { hashRequest } from '../src/server/lib/idempotency';
import { markOrderFailed, otaCouponCode, otaPrepaidHints, roomShare } from '../src/server/modules/ota';
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
    for (const c of [...codes, otaCouponCode(999_999, 'x'.repeat(64), 123_456_789)]) expect(c).toMatch(COUPON_CODE_PATTERN);
    // 几间的订单每间一张券：同一订单不同的预约不撞
    expect(otaCouponCode(1, 'AB-123', 7)).not.toBe(otaCouponCode(1, 'AB-123', 8));
    // 订单金额按间数分：分不尽的摊在前面，加起来正好
    expect([0, 1, 2].map((i) => roomShare(100_000, 3, i))).toEqual([33_333, 33_333, 33_334]);
    expect([0, 1].map((i) => roomShare(100_001, 2, i))).toEqual([50_000, 50_001]);
    expect(roomShare(500, 1, 3)).toBe(500);
  });

  it('间数、晚数按数值读：「1.0」是 1 间、「2.0」是 2 晚，带单位、全角也认；「1.5」「1-2」读不出来，不把数字拼在一起（Codex 审查 4d191f4 后补）', () => {
    const h = ['订单号', '房型', '入住日', '晚数', '间数', '金额'];
    const map = detectOtaColumns(h);
    const r = parseOtaRows(h, [
      { row: 2, cells: ['N1', '大床', '2026-12-01', '2.0', '1.0', '300'] },
      { row: 3, cells: ['N2', '大床', '2026-12-01', '３晚', '2 间', '600'] },
      { row: 4, cells: ['N3', '大床', '2026-12-01', '1', '1.5', '100'] },
      { row: 5, cells: ['N4', '大床', '2026-12-01', '1', '1-2', '100'] },
      { row: 6, cells: ['N5', '大床', '2026-12-01', '1.5', '1', '100'] },
      { row: 7, cells: ['N6', '大床', '2026-12-01', '2-3', '1', '100'] },
    ], map);
    // 旧代码把「1.0」间读成 10 间、「2.0」晚读成 20 晚（去掉非数字再拼）
    expect(r.orders).toMatchObject([
      { orderNo: 'N1', checkin: '2026-12-01', checkout: '2026-12-03', nights: 2, rooms: 1 },
      { orderNo: 'N2', checkin: '2026-12-01', checkout: '2026-12-04', nights: 3, rooms: 2 },
    ]);
    expect(r.orders).toHaveLength(2);
    expect(r.problems).toEqual([
      { row: 4, message: '订单 N3：间数要是 1–20' },
      { row: 5, message: '订单 N4：间数要是 1–20' },
      { row: 6, message: '订单 N5：离店日读不出来，或不晚于入住日' },
      { row: 7, message: '订单 N6：离店日读不出来，或不晚于入住日' },
    ]);
  });

  it('「间夜」是间数 × 晚数：按间数折回晚数，除不尽的读不出来；有离店日的以离店日为准', () => {
    const h = ['订单号', '房型', '入住日', '间夜', '间数', '金额'];
    const map = detectOtaColumns(h);
    expect(map.nights).toBe('间夜');
    const r = parseOtaRows(h, [
      { row: 2, cells: ['R1', '大床', '2026-12-01', '6', '2', '1200'] },
      { row: 3, cells: ['R2', '大床', '2026-12-01', '5', '2', '1000'] },
      { row: 4, cells: ['R3', '大床', '2026-12-01', '3', '1', '600'] },
    ], map);
    // 旧代码把两间 6 间夜读成住 6 晚
    expect(r.orders).toMatchObject([
      { orderNo: 'R1', checkout: '2026-12-04', nights: 3, rooms: 2 },
      { orderNo: 'R3', checkout: '2026-12-04', nights: 3, rooms: 1 },
    ]);
    expect(r.problems).toEqual([{ row: 3, message: '订单 R2：离店日读不出来，或不晚于入住日' }]);
    // 晚数一列里写着「6间夜」的同样按间数折
    const h2 = ['订单号', '房型', '入住日', '晚数', '间数', '金额'];
    const r2 = parseOtaRows(h2, [{ row: 2, cells: ['R4', '大床', '2026-12-01', '6间夜', '2', '1200'] }], detectOtaColumns(h2));
    expect(r2.orders).toMatchObject([{ orderNo: 'R4', checkout: '2026-12-04', nights: 3, rooms: 2 }]);
    // 有离店日的以离店日为准（间夜不参与）
    const h3 = ['订单号', '房型', '入住日', '离店日', '间夜', '间数', '金额'];
    const r3 = parseOtaRows(h3, [{ row: 2, cells: ['R5', '大床', '2026-12-01', '2026-12-02', '4', '2', '400'] }], detectOtaColumns(h3));
    expect(r3.orders).toMatchObject([{ orderNo: 'R5', checkout: '2026-12-02', nights: 1, rooms: 2 }]);
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

  it('已有的订单这一次没处理成（新房型停用了）：留下这一次的内容，上一次处理成的照旧；补好以后「重试」按这一次的内容来', async () => {
    const t2 = await api(ctx.app, ctx.owner, 'POST', '/api/admin/rooms/types', { name: '渠道湖景套房', kind: 'daily', price: 58800 });
    const lakeId = t2.body.types.find((t: { name: string }) => t.name === '渠道湖景套房').id as number;
    const ch = (await api(ctx.app, ctx.clerk, 'GET', '/api/ota/channels')).body.find((c: { id: number }) => c.id === channelId);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/ota/channels/${channelId}`, { ...ch, roomMap: { ...ch.roomMap, 湖景套房: lakeId } })).status).toBe(200);
    const d = shiftDate(today, 8);
    expect((await importFile([`C5001,钱一,,豪华大床房,${d},${shiftDate(d, 1)},1,300,现付,已确认`])).body).toMatchObject({ created: 1 });
    // 湖景套房停用以后，渠道把这张改成湖景套房：这一次没处理成
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/rooms/types/${lakeId}`, { name: '渠道湖景套房', kind: 'daily', price: 58800, active: false })).status).toBe(200);
    const failed = await importFile([`C5001,钱一,,湖景套房,${d},${shiftDate(d, 1)},1,588,现付,已确认`]);
    expect(failed.body).toMatchObject({ failed: 1 });
    const o1 = await order('C5001');
    expect(o1).toMatchObject({ status: 'failed', channelRoom: '豪华大床房', roomTypeName: '渠道大床房', amountCents: 30_000 });
    expect(o1.failReason).toContain('停用');
    // 新订单这一次没处理成的也留一行，能重试
    expect((await importFile([`C5002,孙二,,湖景套房,${d},${shiftDate(d, 1)},1,588,现付,已确认`])).body).toMatchObject({ failed: 1 });
    expect(await order('C5002')).toMatchObject({ status: 'failed', channelRoom: '湖景套房' });
    // 把湖景套房启用回来，重试：按这一次（湖景套房、588 元）的内容
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/admin/rooms/types/${lakeId}`, { name: '渠道湖景套房', kind: 'daily', price: 58800, active: true })).status).toBe(200);
    const retried = await api(ctx.app, ctx.clerk, 'POST', `/api/ota/orders/${o1.id}/retry`, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ status: 'booked', channelRoom: '湖景套房', roomTypeName: '渠道湖景套房', amountCents: 58_800 });
    expect(retried.body.bookings.filter((b: { status: string }) => b.status === 'confirmed')).toHaveLength(1);
    const r2 = await api(ctx.app, ctx.clerk, 'POST', `/api/ota/orders/${(await order('C5002')).id}/retry`, {});
    expect(r2.body).toMatchObject({ status: 'booked', roomTypeName: '渠道湖景套房' });
  });

  it('已有的订单改了日期、新的渠道房型又没对照：这一次没处理成，订单上仍是原来的日期；补了对照再重试，预约改到新日期', async () => {
    const d1 = shiftDate(today, 18);
    const d2 = shiftDate(today, 19);
    expect((await importFile([`Z1001,吕一,,豪华大床房,${d1},${shiftDate(d1, 1)},1,300,现付,已确认`])).body).toMatchObject({ created: 1 });
    // 渠道把它改到 d2，房型名也换成了还没对照的「豪华大床新」
    expect((await importFile([`Z1001,吕一,,豪华大床新,${d2},${shiftDate(d2, 1)},1,300,现付,已确认`])).body).toMatchObject({ failed: 1 });
    const o1 = await order('Z1001');
    expect(o1).toMatchObject({ status: 'failed', checkinDate: d1, channelRoom: '豪华大床房', roomTypeName: '渠道大床房' });
    // 补对照（对到原来的本店房型）再重试：预约改到 d2（原来订单上先记了 d2，重试时「日期没变」，预约留在 d1）
    const ch = (await api(ctx.app, ctx.clerk, 'GET', '/api/ota/channels')).body.find((c: { id: number }) => c.id === channelId);
    expect((await api(ctx.app, ctx.owner, 'PUT', `/api/ota/channels/${channelId}`, { ...ch, roomMap: { ...ch.roomMap, 豪华大床新: roomTypeId } })).status).toBe(200);
    const retried = await api(ctx.app, ctx.clerk, 'POST', `/api/ota/orders/${o1.id}/retry`, {});
    expect(retried.body).toMatchObject({ status: 'booked', checkinDate: d2, channelRoom: '豪华大床新' });
    const live = await ctx.sql<{ businessDate: string }[]>`
      SELECT b.business_date::text AS business_date FROM ota_order_bookings ob JOIN bookings b ON b.id = ob.booking_id
      WHERE ob.order_id = ${o1.id} AND b.status IN ('pending', 'confirmed')`;
    expect(live.map((b) => b.businessDate)).toEqual([d2]);
  });

  it('重试：读出内容以后、锁住订单之前被另一次导入处理成了，拒绝，不拿读出来的旧内容去盖；页面上的版本过时了也拒绝', async () => {
    const d = shiftDate(today, 25);
    expect((await importFile([`W1001,魏一,,未对照房型W,${d},${shiftDate(d, 1)},1,300,现付,已确认`])).body).toMatchObject({ failed: 1 });
    const failed = await order('W1001');
    expect(failed).toMatchObject({ status: 'failed' });
    // 测试这一边先锁住订单一行；重试读出内容以后在锁订单那一步等着，这时「另一次导入」把它处理成了（这里直接改那一行模拟）、提交
    const waiting = () => ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM ota_orders WHERE channel_id%FOR UPDATE%'`;
    let retried: Promise<Awaited<ReturnType<typeof api>>> | null = null;
    await ctx.sql.begin(async (tx) => {
      await tx`SELECT id FROM ota_orders WHERE id = ${failed.id} FOR UPDATE`;
      retried = api(ctx.app, ctx.clerk, 'POST', `/api/ota/orders/${failed.id}/retry`, {});
      for (let i = 0; i < 100 && (await waiting())[0]!.n === 0; i += 1) await new Promise((r) => setTimeout(r, 30));
      expect((await waiting())[0]!.n).toBeGreaterThan(0);
      await tx`UPDATE ota_orders SET status = 'booked', amount_cents = 33000, fail_reason = NULL, updated_at = now() WHERE id = ${failed.id}`;
    });
    const r = (await retried!) as { status: number; body: { error?: { code: string } } };
    expect(r.body.error?.code, JSON.stringify(r.body)).toBe('OTA_ORDER_CHANGED');
    expect(await order('W1001')).toMatchObject({ status: 'booked', amountCents: 33000 });
    // 页面上还是「没建成」那一份（旧版本）：拒绝；现在不是「没建成」的也不用重试
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/ota/orders/${failed.id}/retry`, { rev: failed.rev })).body.error.code).toBe('OTA_ORDER_CHANGED');
    expect((await api(ctx.app, ctx.clerk, 'POST', `/api/ota/orders/${failed.id}/retry`, {})).body.error.code).toBe('OTA_ORDER_NOT_FAILED');
  });

  it('渠道把订单改到一天房已经约满的日子：照样改时间、标超订；只改金额不清掉、放得下了才清；订单表大（超过 64 KB）也能导', async () => {
    const d1 = shiftDate(today, 12);
    const d2 = shiftDate(today, 13);
    // 渠道大床房只有一间：X1 占 d1，X2 先在 d2（不超订）
    expect((await importFile([`X1001,冯一,,豪华大床房,${d1},${shiftDate(d1, 1)},1,300,现付,已确认`, `X1002,陈二,,豪华大床房,${d2},${shiftDate(d2, 1)},1,300,现付,已确认`])).body).toMatchObject({ created: 2 });
    expect(await order('X1002')).toMatchObject({ status: 'booked', overbooked: false });
    // X2 改到 d1：那天已经约满 → 照样改、标超订
    const moved = await importFile([`X1002,陈二,,豪华大床房,${d1},${shiftDate(d1, 1)},1,300,现付,已确认`]);
    expect(moved.body).toMatchObject({ updated: 1 });
    expect(await order('X1002')).toMatchObject({ status: 'booked', overbooked: true, checkinDate: d1 });
    expect(await order('X1001')).toMatchObject({ overbooked: false });
    // 只改了金额：还是超订（原来「改过」就把提醒清掉）
    expect((await importFile([`X1002,陈二,,豪华大床房,${d1},${shiftDate(d1, 1)},1,320,现付,已确认`])).body).toMatchObject({ updated: 1 });
    expect(await order('X1002')).toMatchObject({ overbooked: true, amountCents: 32000 });
    // X1 取消了，d1 放得下了：X2 再处理时清掉提醒（按处理完的预约算，不是沿用上一次的）
    expect((await importFile([`X1001,冯一,,豪华大床房,${d1},${shiftDate(d1, 1)},1,300,现付,已取消`, `X1002,陈二,,豪华大床房,${d1},${shiftDate(d1, 1)},1,320,现付,已确认`])).body).toMatchObject({ cancelled: 1 });
    expect(await order('X1002')).toMatchObject({ status: 'booked', overbooked: false });
    // 大文件：预览照常（全局默认的请求体上限是 64 KB）
    const many = Array.from({ length: 1500 }, (_, i) => `BIG${String(i).padStart(5, '0')},客人${i},,豪华大床房,${shiftDate(today, 20)},${shiftDate(today, 21)},1,300,现付,已确认`);
    const big = csv(many);
    expect(big.length).toBeGreaterThan(64 * 1024);
    const preview = await api(ctx.app, ctx.clerk, 'POST', '/api/ota/import/preview', { channelId, fileName: 'big.csv', csv: big });
    expect(preview.status, JSON.stringify(preview.body).slice(0, 200)).toBe(200);
    expect(preview.body.total).toBe(1500);
  });

  it('一次导入没处理成的那张：订单已经被更晚的一次导入处理成了，不把它盖成「没建成」、不换掉内容', async () => {
    const d = shiftDate(today, 15);
    const first = await importFile([`Y1001,褚三,,豪华大床房,${d},${shiftDate(d, 1)},1,300,现付,已确认`]);
    const second = await importFile([`Y1001,褚三,,豪华大床房,${d},${shiftDate(d, 1)},1,330,现付,已确认`]);
    expect(second.body).toMatchObject({ updated: 1 });
    const [row] = await ctx.sql<{ raw: any; lastImportId: number }[]>`SELECT raw, last_import_id FROM ota_orders WHERE channel_id = ${channelId} AND order_no = 'Y1001'`;
    expect(Number(row!.lastImportId)).toBe(second.body.importId);
    const channel = { id: channelId, roomMap: { 豪华大床房: roomTypeId } } as never;
    // 较早那次（first）在 processOrder 里出错、回滚以后，更晚那次（second）已经处理成了：这时才写失败——不写
    const stale = { ...row!.raw, amountCents: 30000 };
    expect(await markOrderFailed(ctx.sql, channel, stale, first.body.importId, '模拟较早那次没处理成')).toBe(false);
    expect(await order('Y1001')).toMatchObject({ status: 'booked', amountCents: 33000, failReason: null });
    const [kept] = await ctx.sql<{ raw: any }[]>`SELECT raw FROM ota_orders WHERE channel_id = ${channelId} AND order_no = 'Y1001'`;
    expect(kept!.raw.amountCents).toBe(33000);
    // 更晚的一次（编号更大）没处理成：照常记「没建成」、留下这一次的内容
    expect(await markOrderFailed(ctx.sql, channel, { ...row!.raw, amountCents: 36000 }, second.body.importId + 1000, '模拟更晚那次没处理成')).toBe(true);
    expect(await order('Y1001')).toMatchObject({ status: 'failed', failReason: '模拟更晚那次没处理成', amountCents: 33000 });
  });

  it('预付的几间订单：到店的每一间各带一行团购券（各自的券码、按间数分的金额），分开结账各用各的；用过的不再带', async () => {
    expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'Q', from: 1, to: 5, width: 3, zone: 'male' })).status).toBe(200);
    await api(ctx.app, ctx.clerk, 'POST', '/api/shifts', { openingCash: 0 });
    const r = await importFile([`C3001,郑十,,豪华大床房,${today},${shiftDate(today, 1)},2,1000.01,预付,已确认`]);
    expect(r.body).toMatchObject({ created: 1 });
    const o = await order('C3001');
    expect(o.bookings).toHaveLength(2);
    const visits: number[] = [];
    for (const [i, b] of (o.bookings as { id: number }[]).entries()) {
      const tag = `Q00${i + 1}`;
      const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male' }] });
      expect(v.status, JSON.stringify(v.body)).toBe(201);
      visits.push(v.body.visits[0].id);
      const arrived = await api(ctx.app, ctx.clerk, 'POST', `/api/bookings/${b.id}/change`, { clientKey: randomUUID(), action: 'arrive', tagCode: tag });
      expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
    }
    const preview = async (vid: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${vid}`)).body as { totalAmount: number; otaPrepaid: { couponCode: string; amountCents: number }[] };
    const p1 = await preview(visits[0]!);
    const p2 = await preview(visits[1]!);
    expect(p1.otaPrepaid).toHaveLength(1);
    expect(p2.otaPrepaid).toHaveLength(1);
    expect(p1.otaPrepaid[0]!.couponCode).not.toBe(p2.otaPrepaid[0]!.couponCode);
    expect(p1.otaPrepaid[0]!.amountCents + p2.otaPrepaid[0]!.amountCents).toBe(100_001);
    // 第一间先结账，用掉自己那一张
    const settle = (vid: number, p: typeof p1) => {
      const coupon = Math.min(p.otaPrepaid[0]!.amountCents, p.totalAmount);
      const pays: Record<string, unknown>[] = [{ method: 'coupon', platform: 'other', code: p.otaPrepaid[0]!.couponCode, amount: coupon, dealName: '携程 · 渠道大床房' }];
      if (p.totalAmount > coupon) pays.push({ method: 'cash', amount: p.totalAmount - coupon });
      return api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [vid], expectedTotal: p.totalAmount, payments: pays });
    };
    const c1 = await settle(visits[0]!, p1);
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    // 第二间分开结账：带的是它自己的那一张，照样能用（原来同一个券码，这里会 COUPON_USED）
    const c2 = await settle(visits[1]!, await preview(visits[1]!));
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);
    // 用过的不再带
    expect(await otaPrepaidHints(ctx.sql, visits)).toEqual([]);
  });

  it('预付按还没用掉的分：一间的订单用掉了预付以后渠道加成两间、总额不变，新加的那一间只带剩下的（用完了就不带）', async () => {
    expect((await importFile([`C3101,钱十一,,豪华大床房,${today},${shiftDate(today, 1)},1,100.00,预付,已确认`])).body).toMatchObject({ created: 1 });
    const arriveAt = async (bookingId: number, tag: string) => {
      const v = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: tag, zone: 'male' }] });
      expect(v.status, JSON.stringify(v.body)).toBe(201);
      const arrived = await api(ctx.app, ctx.clerk, 'POST', `/api/bookings/${bookingId}/change`, { clientKey: randomUUID(), action: 'arrive', tagCode: tag });
      expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
      return v.body.visits[0].id as number;
    };
    const preview = async (vid: number) => (await api(ctx.app, ctx.clerk, 'GET', `/api/frontdesk/checkout-preview?ids=${vid}`)).body as { totalAmount: number; otaPrepaid: { couponCode: string; amountCents: number }[] };
    const first = (await order('C3101')).bookings[0] as { id: number };
    const v1 = await arriveAt(first.id, 'Q003');
    const p1 = await preview(v1);
    expect(p1.otaPrepaid).toEqual([expect.objectContaining({ amountCents: 10_000 })]);
    const used = Math.min(10_000, p1.totalAmount);
    const pays: Record<string, unknown>[] = [{ method: 'coupon', platform: 'other', code: p1.otaPrepaid[0]!.couponCode, amount: used, dealName: '携程 · 渠道大床房' }];
    if (p1.totalAmount > used) pays.push({ method: 'cash', amount: p1.totalAmount - used });
    expect((await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkouts', { clientKey: randomUUID(), visitIds: [v1], expectedTotal: p1.totalAmount, payments: pays })).status).toBe(200);
    // 渠道把这张改成两间、总额还是 100：新加一张预约
    expect((await importFile([`C3101,钱十一,,豪华大床房,${today},${shiftDate(today, 1)},2,100.00,预付,已确认`])).body).toMatchObject({ updated: 1 });
    const second = ((await order('C3101')).bookings as { id: number; status: string }[]).find((b) => b.id !== first.id && b.status !== 'cancelled')!;
    const v2 = await arriveAt(second.id, 'Q004');
    // 只带还没用掉的（原来按 100 ÷ 2 又带 50，合计记成 150）
    const left = 10_000 - used;
    const p2 = await preview(v2);
    if (left === 0) expect(p2.otaPrepaid).toEqual([]);
    else expect(p2.otaPrepaid).toEqual([expect.objectContaining({ amountCents: left })]);
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
