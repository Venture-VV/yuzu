// OTA 渠道订单（8.0.21，docs/INTEGRATIONS_V8021.md 第 4 节，CW-I / CW9；迁移 150）：渠道后台导出的订单表导入成客房预约。
//   · 渠道（携程、美团酒店、飞猪……）：佣金比例、渠道房型 → 本店房型的对照、导入用的列对照（后台「客房 → 渠道」）；
//   · 导入（前台「预约 → 渠道订单」）：新订单按对照的房型建客房预约（来源「渠道」，备注写渠道与订单号），几间就几张；
//     房量不够照样建、标超订提醒；对照不上的记「没建成」，补了对照以后重试；入住日已经过了的跳过。
//     再导一次：渠道取消的 → 没到店的预约取消；日期变了 → 没到店的改时间；间数变了 → 多退少补；已经到店的只提醒。
//   · 钱：预付的订单，结账时收款区默认带一行团购券（平台「其他」、券码 = 订单号、金额 = 订单金额）；渠道打款照旧在平台打款登记。
//   · 渠道对账：按渠道、按月（入住日）：订单数、间夜、订单金额、佣金（按比例）、应收净额，可导出。
// 锁：导入先取操作编号的咨询锁（`ota_import`，与「确认作废」串行）→「渠道 + 文件摘要」的咨询锁 → 写导入记录（同一份文件靠唯一约束兜底）；
// 之后每张订单在自己的事务里：订单一行（渠道 + 订单号的唯一约束兜底）→ 预约走预约原来的锁（预约一行 → 房型一行 `FOR NO KEY UPDATE`）。
// 渠道的修改只锁渠道一行（带版本号）。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, businessDayStart } from '@shared/business-date';
import { detectOtaColumns, OTA_FIELDS, otaColumnProblem, parseOtaRows, type OtaChannel, type OtaColumnMap, type OtaImportResult, type OtaOrderView, type OtaPrepaidHint, type OtaReconRow, type ParsedOtaOrder } from '@shared/ota';
import { isUniqueViolation, type Db, type Fragment } from '../db';
import { guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { csvReply } from '../lib/csv';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { readSheet } from '../lib/sheet-read';
import { changeOtaBookingTx, createOtaBookingTx } from './bookings';
import { loadSettings } from './settings';

/** 渠道订单的预计到店：入住日下午两点（当天已经过了的按现在） */
const CHECKIN_HOUR = 14;

// ───────────────────────── 渠道 ─────────────────────────

export async function listChannels(db: Db): Promise<OtaChannel[]> {
  const rows = await db<OtaChannel[]>`SELECT id, name, commission_bp, room_map, column_map, active, version FROM ota_channels ORDER BY active DESC, id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), roomMap: Object.fromEntries(Object.entries(r.roomMap ?? {}).map(([k, v]) => [k, Number(v)])) }));
}

const ChannelInput = z.object({
  name: z.string('请写渠道名称').trim().min(1, '请写渠道名称').max(20, '渠道名称最多 20 个字'),
  commissionBp: z.number().int().min(0, '佣金比例不对').max(10000, '佣金比例不对'),
  roomMap: z.record(z.string().trim().min(1).max(60), z.number().int().positive()).refine((m) => Object.keys(m).length <= 50, '对照最多 50 条'),
  columnMap: z.partialRecord(z.enum(OTA_FIELDS), z.string().max(60)).default({}),
  active: z.boolean().default(true),
});

async function assertRoomTypes(db: Db, ids: number[]) {
  if (!ids.length) return;
  const rows = await db<{ id: number }[]>`SELECT id FROM room_types WHERE id IN ${db([...new Set(ids)])}`;
  if (rows.length !== new Set(ids).size) throw unprocessable('ROOM_TYPE_NOT_FOUND', '有对照的房型不存在，请刷新');
}

export async function createChannel(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(ChannelInput, raw);
  await assertRoomTypes(deps.sql, Object.values(input.roomMap));
  try {
    const [row] = await deps.sql<{ id: number }[]>`
      INSERT INTO ota_channels (name, commission_bp, room_map, column_map, active, created_by)
      VALUES (${input.name}, ${input.commissionBp}, ${deps.sql.json(input.roomMap)}, ${deps.sql.json(input.columnMap as never)}, ${input.active}, ${actor.id})
      RETURNING id`;
    await writeAudit(deps.sql, { staffId: actor.id, action: 'ota_channel', targetType: 'ota_channel', targetId: Number(row!.id), detail: { op: 'create', ...input }, ip });
  } catch (e) {
    if (isUniqueViolation(e, 'ota_channels_name_key')) throw conflict('OTA_CHANNEL_EXISTS', `已经有叫「${input.name}」的渠道`);
    throw e;
  }
  return listChannels(deps.sql);
}

export async function updateChannel(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(ChannelInput.extend({ version: z.number().int().positive() }), raw);
  await assertRoomTypes(deps.sql, Object.values(input.roomMap));
  await deps.sql.begin(async (tx) => {
    const [c] = await tx<{ version: number }[]>`SELECT version FROM ota_channels WHERE id = ${id} FOR UPDATE`;
    if (!c) throw notFound('渠道不存在');
    if (c.version !== input.version) throw conflict('OTA_CHANNEL_CHANGED', '这个渠道刚被别人改过，请刷新后再改');
    try {
      await tx`
        UPDATE ota_channels SET name = ${input.name}, commission_bp = ${input.commissionBp}, room_map = ${tx.json(input.roomMap)}, column_map = ${tx.json(input.columnMap as never)},
               active = ${input.active}, version = version + 1, updated_at = now()
        WHERE id = ${id}`;
    } catch (e) {
      if (isUniqueViolation(e, 'ota_channels_name_key')) throw conflict('OTA_CHANNEL_EXISTS', `已经有叫「${input.name}」的渠道`);
      throw e;
    }
    await writeAudit(tx, { staffId: actor.id, action: 'ota_channel', targetType: 'ota_channel', targetId: id, detail: { op: 'update', ...input }, ip });
  });
  return listChannels(deps.sql);
}

async function channelOf(db: Db, id: number): Promise<OtaChannel> {
  const c = (await listChannels(db)).find((x) => x.id === id);
  if (!c) throw notFound('渠道不存在');
  return c;
}

// ───────────────────────── 订单 ─────────────────────────

async function orderViews(db: Db, where: Fragment): Promise<OtaOrderView[]> {
  const rows = await db<(Omit<OtaOrderView, 'bookings' | 'nights'> & { nights: number })[]>`
    SELECT o.id, o.channel_id, c.name AS channel_name, o.order_no, o.guest_name, o.guest_phone, o.channel_room, rt.name AS room_type_name,
           to_char(o.checkin_date, 'YYYY-MM-DD') AS checkin_date, to_char(o.checkout_date, 'YYYY-MM-DD') AS checkout_date,
           (o.checkout_date - o.checkin_date) AS nights, o.rooms, o.amount_cents, o.pay_mode, o.channel_status, o.status, o.fail_reason, o.overbooked, o.notice, o.updated_at
    FROM ota_orders o JOIN ota_channels c ON c.id = o.channel_id LEFT JOIN room_types rt ON rt.id = o.room_type_id
    WHERE ${where} ORDER BY o.checkin_date DESC, o.id DESC LIMIT 300`;
  const ids = rows.map((r) => Number(r.id));
  const links = ids.length
    ? await db<{ orderId: number; id: number; bookingNo: string; status: string }[]>`
        SELECT ob.order_id, b.id, b.booking_no, b.status FROM ota_order_bookings ob JOIN bookings b ON b.id = ob.booking_id WHERE ob.order_id IN ${db(ids)} ORDER BY b.id`
    : [];
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    channelId: Number(r.channelId),
    nights: Number(r.nights),
    amountCents: Number(r.amountCents),
    bookings: links.filter((l) => Number(l.orderId) === Number(r.id)).map((l) => ({ id: Number(l.id), bookingNo: l.bookingNo, status: l.status })),
  }));
}

type Outcome = 'created' | 'updated' | 'cancelled' | 'failed' | 'skipped' | 'unchanged';

/** 一张订单一个事务：订单一行 → 预约（预约一行 → 房型一行） */
async function processOrder(deps: Deps, channel: OtaChannel, o: ParsedOtaOrder, importId: number | null, actor: Actor, ip?: string): Promise<Outcome> {
  const settings = await loadSettings(deps.sql);
  const tz = deps.config.timezone;
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const roomTypeId = channel.roomMap[o.roomType] ?? null;
    const inserted = await tx<{ id: number }[]>`
      INSERT INTO ota_orders (channel_id, order_no, guest_name, guest_phone, channel_room, room_type_id, checkin_date, checkout_date, rooms, amount_cents, pay_mode,
                              channel_status, raw, last_import_id)
      VALUES (${channel.id}, ${o.orderNo}, ${o.guestName}, ${o.guestPhone}, ${o.roomType}, ${roomTypeId}, ${o.checkin}, ${o.checkout}, ${o.rooms}, ${o.amountCents}, ${o.payMode},
              ${o.channelStatus}, ${tx.json(o as never)}, ${importId})
      ON CONFLICT (channel_id, order_no) DO NOTHING RETURNING id`;
    const isNew = inserted.length > 0;
    const [ord] = await tx<{ id: number; status: string; checkinDate: string; rooms: number; roomTypeId: number | null; channelStatus: string; overbooked: boolean; amountCents: number; lastImportId: number | null }[]>`
      SELECT id, status, to_char(checkin_date, 'YYYY-MM-DD') AS checkin_date, rooms, room_type_id, channel_status, overbooked, amount_cents, last_import_id
      FROM ota_orders WHERE channel_id = ${channel.id} AND order_no = ${o.orderNo} FOR UPDATE`;
    const id = Number(ord!.id);
    // 这次导入（原样重提续做时）或更晚的一次导入已经处理过这张：不再处理（不拿旧文件盖掉新的）
    if (!isNew && importId !== null && ord!.lastImportId !== null && Number(ord!.lastImportId) >= importId) return 'unchanged';
    const before = { status: ord!.status, checkin: ord!.checkinDate, rooms: Number(ord!.rooms), roomTypeId: ord!.roomTypeId === null ? null : Number(ord!.roomTypeId), channelStatus: ord!.channelStatus, amount: Number(ord!.amountCents) };
    await tx`
      UPDATE ota_orders SET guest_name = ${o.guestName}, guest_phone = ${o.guestPhone}, channel_room = ${o.roomType}, room_type_id = ${roomTypeId},
             checkin_date = ${o.checkin}, checkout_date = ${o.checkout}, rooms = ${o.rooms}, amount_cents = ${o.amountCents}, pay_mode = ${o.payMode},
             channel_status = ${o.channelStatus}, raw = ${tx.json(o as never)}, last_import_id = coalesce(${importId}, last_import_id), updated_at = now()
      WHERE id = ${id}`;
    const linked = await tx<{ id: number; status: string; version: number; startsAt: Date; roomTypeId: number }[]>`
      SELECT b.id, b.status, b.version, b.starts_at, b.room_type_id FROM ota_order_bookings ob JOIN bookings b ON b.id = ob.booking_id
      WHERE ob.order_id = ${id} ORDER BY b.id`;
    let open = linked.filter((b) => b.status === 'pending' || b.status === 'confirmed');
    const arrived = linked.filter((b) => b.status === 'arrived');
    const ctx = { actor, at: new Date(), ip };
    const reason = `${channel.name}订单 ${o.orderNo}`;
    const setStatus = (status: string, extra: { failReason?: string | null; notice?: string | null; overbooked?: boolean } = {}) =>
      tx`UPDATE ota_orders SET status = ${status}, fail_reason = ${extra.failReason ?? null}, notice = ${extra.notice ?? null},
                overbooked = ${extra.overbooked ?? false}, updated_at = now() WHERE id = ${id}`;

    if (o.channelStatus === 'cancelled') {
      for (const b of open) await changeOtaBookingTx(tx, deps, Number(b.id), { action: 'cancel', reason: `渠道取消（${reason}）` }, ctx);
      await setStatus('cancelled', { notice: arrived.length ? `渠道取消了，但 ${arrived.length} 间的客人已经到店，请和渠道核对` : null });
      if (open.length || before.status !== 'cancelled') await writeAudit(tx, { staffId: actor.id, action: 'ota_order', targetType: 'ota_order', targetId: id, detail: { op: 'cancel', orderNo: o.orderNo, bookings: open.length }, ip });
      return before.status === 'cancelled' && !open.length ? 'unchanged' : 'cancelled';
    }
    if (!roomTypeId) {
      await setStatus('failed', { failReason: `渠道房型「${o.roomType}」还没有对照本店房型（后台「客房 → 渠道」里加上以后重试）` });
      return before.status === 'failed' && !isNew ? 'unchanged' : 'failed';
    }
    const today = businessDateOf(new Date(), tz, settings.businessDayStartHour);
    if (o.checkin < today && !linked.length) {
      await setStatus('skipped', { failReason: '入住日已经过了，没有建预约' });
      return before.status === 'skipped' && !isNew ? 'unchanged' : 'skipped';
    }
    let changed = isNew || before.status !== 'booked' || before.amount !== o.amountCents;
    const startOf = () => {
      const s = businessDayStart(o.checkin, tz, CHECKIN_HOUR);
      return s.getTime() < Date.now() ? new Date(Date.now() + 60_000) : s;
    };
    // 房型改了：没到店的取消、按新房型重建
    for (const b of open.filter((x) => Number(x.roomTypeId) !== roomTypeId)) {
      await changeOtaBookingTx(tx, deps, Number(b.id), { action: 'cancel', reason: `渠道改了房型（${reason}）` }, ctx);
      changed = true;
    }
    open = open.filter((x) => Number(x.roomTypeId) === roomTypeId);
    // 日期改了：没到店的改时间
    if (o.checkin !== before.checkin && open.length) {
      const startsAt = startOf();
      for (const b of open) await changeOtaBookingTx(tx, deps, Number(b.id), { action: 'reschedule', startsAt, expectedVersion: Number(b.version) }, ctx);
      changed = true;
    }
    // 间数：多退少补（已经到店的算进去）
    let overbooked = false;
    const have = open.length + arrived.length;
    if (have < o.rooms) {
      for (let i = have; i < o.rooms; i++) {
        const r = await createOtaBookingTx(tx, deps, { roomTypeId, startsAt: startOf(), guestName: o.guestName, guestPhone: o.guestPhone, guests: 1, note: `${reason} · ${o.checkout > o.checkin ? `${Math.round((Date.parse(o.checkout) - Date.parse(o.checkin)) / 86_400_000)} 晚` : ''}${o.payMode === 'prepaid' ? ' · 预付' : ' · 现付'}` }, actor, new Date());
        await tx`INSERT INTO ota_order_bookings (order_id, booking_id) VALUES (${id}, ${r.id})`;
        overbooked ||= r.overbooked;
      }
      changed = true;
    } else if (have > o.rooms) {
      for (const b of open.slice().reverse().slice(0, Math.min(open.length, have - o.rooms))) {
        await changeOtaBookingTx(tx, deps, Number(b.id), { action: 'cancel', reason: `渠道减了间数（${reason}）` }, ctx);
      }
      changed = true;
    }
    const notice = arrived.length && (o.checkin !== before.checkin || o.rooms !== before.rooms) ? `渠道改了订单，但 ${arrived.length} 间的客人已经到店，请和渠道核对` : null;
    await setStatus('booked', { notice, overbooked: overbooked || (ord!.overbooked && !changed) });
    if (changed) await writeAudit(tx, { staffId: actor.id, action: 'ota_order', targetType: 'ota_order', targetId: id, detail: { op: isNew ? 'create' : 'update', orderNo: o.orderNo, rooms: o.rooms, checkin: o.checkin, overbooked }, ip });
    return isNew ? 'created' : changed ? 'updated' : 'unchanged';
  });
}

// ───────────────────────── 导入 ─────────────────────────

const FileInput = z
  .object({
    channelId: z.number().int().positive('请选择渠道'),
    fileName: z.string().trim().min(1, '缺少文件名').max(120, '文件名太长'),
    csv: z.string().max(8_000_000, '文件太大').optional(),
    xlsxBase64: z.string().max(14_000_000, '文件太大').optional(),
    columnMap: z.partialRecord(z.enum(OTA_FIELDS), z.string().max(60)).optional(),
  })
  .refine((v) => (v.csv === undefined) !== (v.xlsxBase64 === undefined), '请选一份 CSV 或 Excel 文件');

function readOrders(f: z.infer<typeof FileInput>, saved: OtaColumnMap) {
  const sheet = readSheet({ csv: f.csv, xlsxBase64: f.xlsxBase64 }, { dateColumns: ['入住日期', '入住日', '离店日期', '离店日', '到店日期'], findHeader: (cells) => !!detectOtaColumns(cells).orderNo, headerScan: 20 });
  const savedFits = Object.keys(saved).length > 0 && Object.values(saved).every((h) => !h || sheet.header.includes(h));
  const map: OtaColumnMap = f.columnMap ?? (savedFits ? saved : detectOtaColumns(sheet.header));
  const problem = otaColumnProblem(map);
  const parsed = problem ? { orders: [], problems: [] } : parseOtaRows(sheet.header, sheet.rows.map((r) => ({ row: r.row, cells: r.cells })), map);
  const hash = createHash('sha256')
    .update(f.csv ?? f.xlsxBase64 ?? '')
    .digest('hex');
  return { sheet, map, problem, hash, ...parsed };
}

export async function previewOtaImport(db: Db, raw: unknown) {
  const f = parse(FileInput, raw);
  const channel = await channelOf(db, f.channelId);
  const r = readOrders(f, channel.columnMap);
  const [dup] = await db<{ id: number }[]>`SELECT id FROM ota_imports WHERE channel_id = ${channel.id} AND file_hash = ${r.hash}`;
  return {
    header: r.sheet.header,
    columnMap: r.map,
    problem: r.problem,
    duplicate: !!dup,
    total: r.orders.length,
    unmapped: [...new Set(r.orders.filter((o) => !channel.roomMap[o.roomType]).map((o) => o.roomType))],
    orders: r.orders.slice(0, 30),
    problems: r.problems.slice(0, 50),
  };
}

const abandoned = () => conflict('OP_ABANDONED', '这次导入已经确认作废；请重新选文件导入');

export async function importOtaOrders(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<OtaImportResult> {
  const input = parse(FileInput.and(z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') })), raw);
  const channel = await channelOf(deps.sql, input.channelId);
  if (!channel.active) throw conflict('OTA_CHANNEL_INACTIVE', '这个渠道已停用');
  const r = readOrders(input, channel.columnMap);
  if (r.problem) throw unprocessable('OTA_COLUMNS', r.problem);
  const requestHash = hashRequest({ channelId: channel.id, fileHash: r.hash });
  const head = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await assertNotFenced(tx, input.clientKey, 'ota_import', abandoned);
    const [prev] = await tx<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM ota_imports WHERE client_key = ${input.clientKey}`;
    if (prev) {
      if (prev.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已经用在另一次导入上，请刷新后重试');
      return { id: Number(prev.id), replayed: true };
    }
    await lockOpKey(tx, `ota-import:${channel.id}:${r.hash}`);
    const [dup] = await tx<{ id: number }[]>`SELECT id FROM ota_imports WHERE channel_id = ${channel.id} AND file_hash = ${r.hash}`;
    if (dup) throw conflict('OTA_FILE_DUP', '这份文件已经导过了；渠道有新的变化请重新导出一份再导');
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO ota_imports (channel_id, file_name, file_hash, rows, client_key, request_hash, staff_id)
      VALUES (${channel.id}, ${input.fileName}, ${r.hash}, ${r.orders.length}, ${input.clientKey}, ${requestHash}, ${actor.id})
      RETURNING id`;
    await writeAudit(tx, { staffId: actor.id, action: 'ota_import', targetType: 'ota_import', targetId: Number(row!.id), detail: { channel: channel.name, fileName: input.fileName, rows: r.orders.length }, ip });
    return { id: Number(row!.id), replayed: false };
  });
  const result: OtaImportResult = { importId: head.id, rows: r.orders.length, created: 0, updated: 0, cancelled: 0, failed: 0, skipped: 0, unchanged: 0, problems: r.problems, orders: [] };
  // 原样重提（上一次导入记下了、逐张处理到一半断了）也逐张走一遍：已经按这次（或更晚的一次）处理过的那几张在
  // processOrder 里认出来、记「没变化」，没处理完的接着做——导入记录与逐张处理分在几个事务里，进度按订单上的 last_import_id 认
  for (const o of r.orders) {
    try {
      result[await processOrder(deps, channel, o, head.id, actor, ip)] += 1;
    } catch (e) {
      // 一张出错不影响别的：记「没建成」、写原因
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      await deps.sql`
        UPDATE ota_orders SET status = 'failed', fail_reason = ${message.slice(0, 200)}, updated_at = now()
        WHERE channel_id = ${channel.id} AND order_no = ${o.orderNo}`.catch(() => undefined);
      result.problems.push({ row: o.row, message: `订单 ${o.orderNo}：${message}` });
    }
  }
  result.orders = await orderViews(deps.sql, deps.sql`o.last_import_id = ${head.id}`);
  return result;
}

/** 补了房型对照以后重试一张（按上一次导入的内容） */
export async function retryOrder(deps: Deps, id: number, actor: Actor, ip?: string): Promise<OtaOrderView> {
  const [o] = await deps.sql<{ channelId: number; raw: ParsedOtaOrder }[]>`SELECT channel_id, raw FROM ota_orders WHERE id = ${id}`;
  if (!o) throw notFound('渠道订单不存在');
  const channel = await channelOf(deps.sql, Number(o.channelId));
  await processOrder(deps, channel, o.raw, null, actor, ip);
  return (await orderViews(deps.sql, deps.sql`o.id = ${id}`))[0]!;
}

// ───────────────────────── 对账、结账提示 ─────────────────────────

export async function otaRecon(db: Db, month: string): Promise<OtaReconRow[]> {
  const from = `${month}-01`;
  const rows = await db<{ channelId: number; channelName: string; commissionBp: number; orders: number; roomNights: number; amountCents: number }[]>`
    SELECT c.id AS channel_id, c.name AS channel_name, c.commission_bp, count(o.id)::int AS orders,
           coalesce(sum((o.checkout_date - o.checkin_date) * o.rooms), 0)::int AS room_nights, coalesce(sum(o.amount_cents), 0)::bigint AS amount_cents
    FROM ota_channels c LEFT JOIN ota_orders o ON o.channel_id = c.id AND o.status = 'booked'
      AND o.checkin_date >= ${from}::date AND o.checkin_date < (${from}::date + interval '1 month')
    GROUP BY c.id ORDER BY c.id`;
  return rows.map((r) => {
    const amount = Number(r.amountCents);
    const commission = Math.round((amount * Number(r.commissionBp)) / 10000);
    return { channelId: Number(r.channelId), channelName: r.channelName, orders: r.orders, roomNights: r.roomNights, amountCents: amount, commissionCents: commission, netCents: amount - commission };
  });
}

/**
 * 预付订单的团购券码：按「渠道 + 原订单号（+ 哪一间的预约）」认一张——两个渠道同一个订单号、AB-123 与 AB123 都不会撞成同一张券
 * （结账按「平台 + 券码」拦重复）。OTA + 渠道编号 + 订单号里的数字字母（大写，最多 40 位，方便收银员对单）+ 摘要前 8 位。
 * 几间的订单每间一张（bookingId 进摘要）：各间的客人分开结账时各用各的（Codex 审查 beabd59 后补）。
 */
export function otaCouponCode(channelId: number, orderNo: string, bookingId?: number): string {
  const digest = createHash('sha256')
    .update(`${channelId}\u0000${orderNo}${bookingId === undefined ? '' : `\u0000${bookingId}`}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
  return `OTA${channelId}${orderNo.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 40)}${digest}`;
}

/** 第 i 间（从 0 起）分到订单金额的多少：按间数均分，分不尽的几分摊在前面几间，加起来正好是订单金额 */
export const roomShare = (amountCents: number, rooms: number, i: number) => {
  const n = Math.max(1, rooms);
  const k = Math.min(Math.max(0, i), n - 1);
  return Math.floor((amountCents * (k + 1)) / n) - Math.floor((amountCents * k) / n);
};

/**
 * 结账时：这几位客人是按预付的渠道订单到店的 → 收款区默认带团购券，到店的每一间一行（各自的券码、订单金额按间数分的那一份）；
 * 那一间的券已经用在别的结账单上（没反结账）的不再带。
 */
export async function otaPrepaidHints(db: Db, visitIds: number[]): Promise<OtaPrepaidHint[]> {
  if (!visitIds.length) return [];
  const rows = await db<{ bookingId: number; channelId: number; orderNo: string; channelName: string; roomTypeName: string | null; amountCents: number; rooms: number; idx: number }[]>`
    SELECT b.id AS booking_id, o.channel_id, o.order_no, c.name AS channel_name, rt.name AS room_type_name, o.amount_cents, o.rooms,
           (SELECT count(*)::int FROM ota_order_bookings ob2 JOIN bookings b2 ON b2.id = ob2.booking_id
            WHERE ob2.order_id = o.id AND b2.status <> 'cancelled' AND b2.id < b.id) AS idx
    FROM bookings b JOIN ota_order_bookings ob ON ob.booking_id = b.id JOIN ota_orders o ON o.id = ob.order_id JOIN ota_channels c ON c.id = o.channel_id
    LEFT JOIN room_types rt ON rt.id = o.room_type_id
    WHERE b.arrival_visit_id IN ${db(visitIds)} AND b.status = 'arrived' AND o.pay_mode = 'prepaid' AND o.status = 'booked'
    ORDER BY o.id, b.id`;
  const hints = rows.map((r) => ({
    orderNo: r.orderNo,
    couponCode: otaCouponCode(Number(r.channelId), r.orderNo, Number(r.bookingId)),
    channelName: r.channelName,
    roomTypeName: r.roomTypeName ?? '',
    amountCents: roomShare(Number(r.amountCents), Number(r.rooms), Number(r.idx)),
  }));
  if (!hints.length) return [];
  const used = new Set(
    (await db<{ code: string }[]>`SELECT code FROM group_buy_coupons WHERE platform = 'other' AND status = 'active' AND code IN ${db(hints.map((h) => h.couponCode))}`).map((r) => r.code),
  );
  return hints.filter((h) => !used.has(h.couponCode) && h.amountCents > 0);
}

// ───────────────────────── 路由 ─────────────────────────

export function registerOtaRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const admin = guardAny('settings.manage', 'catalog.manage');
  const desk = guardAny('booking.manage', 'settings.manage', 'catalog.manage');
  app.get('/api/ota/channels', { preHandler: desk }, async () => listChannels(sql));
  app.post('/api/ota/channels', { preHandler: admin }, async (req, reply) => {
    const r = await createChannel(deps, req.body, req.actor, req.ip);
    reply.code(201);
    return r;
  });
  app.put('/api/ota/channels/:id', { preHandler: admin }, async (req) => updateChannel(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.post('/api/ota/import/preview', { preHandler: guardAny('booking.manage') }, async (req) => previewOtaImport(sql, req.body));
  app.post('/api/ota/import', { preHandler: guardAny('booking.manage') }, async (req) => importOtaOrders(deps, req.body, req.actor, req.ip));
  app.get('/api/ota/orders', { preHandler: desk }, async (req) => {
    const q = parse(z.object({ status: z.enum(['new', 'booked', 'cancelled', 'failed', 'skipped']).optional(), channelId: z.coerce.number().int().positive().optional() }), req.query);
    return orderViews(sql, sql`${q.status ? sql`o.status = ${q.status}` : sql`true`} AND ${q.channelId ? sql`o.channel_id = ${q.channelId}` : sql`true`}`);
  });
  app.post('/api/ota/orders/:id/retry', { preHandler: guardAny('booking.manage') }, async (req) => retryOrder(deps, parse(idParam, req.params).id, req.actor, req.ip));
  const Month = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份不对') });
  app.get('/api/ota/recon', { preHandler: desk }, async (req) => otaRecon(sql, parse(Month, req.query).month));
  app.get('/api/ota/recon.csv', { preHandler: desk }, async (req, reply) => {
    const { month } = parse(Month, req.query);
    const rows = await otaRecon(sql, month);
    const y = (c: number) => (c / 100).toFixed(2);
    const csv = ['渠道,订单数,间夜,订单金额,佣金,应收净额', ...rows.map((r) => [r.channelName, r.orders, r.roomNights, y(r.amountCents), y(r.commissionCents), y(r.netCents)].join(','))].join('\n');
    return csvReply(reply, `渠道对账-${month}.csv`, `﻿${csv}\n`);
  });
}
