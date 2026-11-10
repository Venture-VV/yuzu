// 硬件连接（飞书需求 RQ-001，v0.7.21，docs/HARDWARE.md）：设备登记与采购清单、网口打印任务、心跳与状态、终端替桥上报。
//
// · 设备登记：每台一行；修改带版本号，对不上拒绝；不能删除，只能停用。新建带操作编号（「结果待确认」同 ERP 一套）。
// · 打印任务：先锁设备一行（同一台串行）再建任务，发送在事务外、由进程内的按台队列执行；同一操作编号只打一张。
// · 心跳：每 2 秒查一次网口设备（连上发实时状态查询）；最近一次联系上超过 5 秒记离线；终端 5 秒没上报，它与它下面的设备记离线。
// · 终端上报：开着页面的终端用登录身份每 2 秒替桥上报（锁顺序：终端一行 → 它下面的设备 id 升序），读卡、扫码事件按编号去重。
// 状态变化、读卡、扫码记设备事件（只追加）；读到的卡号只在这里，不进会员与手牌。
// v0.7.28 ⑥ 断网打印队列（硬件 v0.2）：业务单据遇到打印机离线、故障，或还没开始发就连不上时进「等打印机恢复」，
// 心跳看到打印机恢复在线后按提交顺序改回排队、自动补打；等太久不再打；排队、等恢复的可以取消。测试页照旧离线直接失败。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_PRINTER_PORT,
  DEVICE_AREAS,
  DEVICE_CONNECTIONS,
  DEVICE_ERROR_LABELS,
  DEVICE_EVENT_TYPES,
  DEVICE_EVENT_VALUE_MAX,
  DEVICE_KIND_CONNECTIONS,
  DEVICE_KINDS,
  DEVICE_QUOTE,
  DEVICE_STATUSES,
  isDeviceErrorCode,
  isDocJobKind,
  NETWORK_CONNECTIONS,
  OFFLINE_AFTER_MS,
  plannedQuoteDevices,
  type Device,
  type DeviceErrorCode,
  type DeviceEvent,
  type DeviceImportPreview,
  type DeviceJob,
  type DeviceJobKind,
  type DeviceKind,
  type DeviceOverview,
  type DeviceStatus,
  type BridgeReportResult,
} from '@shared/devices';
import { INSTANCE_LABELS } from '@shared/instance';
import { isUniqueViolation, type Db, type Sql, type Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { idParam, parse } from '../lib/validate';
import { buildTestLabel, buildTestPage } from '../devices/escpos';
import { finishSlip } from '../devices/slips';
import { probe, sendToPrinter } from '../devices/netprint';
import { erpOpAbandoned } from './erp-ops';
import { loadSettings } from './settings';
import { ctxOf } from '../lib/context';

// ───────────────────────── 读 ─────────────────────────

const AREA_ORDER = new Map<string, number>(DEVICE_AREAS.map((a, i) => [a.name, i]));
const KIND_ORDER = new Map<string, number>(DEVICE_KINDS.map((k, i) => [k, i]));

const deviceColumns = (db: Db) => db`
  d.id, d.code, d.name, d.kind, d.brand, d.model, d.area, d.connection, d.host, d.port, d.host_device_id, h.code AS host_device_code,
  d.bridge_key, d.options, d.enabled, d.status, d.status_code, d.last_seen_at, d.status_changed_at, d.catalog_key, d.note, d.version,
  d.created_at, d.updated_at`;

const sortDevices = (list: Device[]) =>
  list.sort(
    (a, b) =>
      (AREA_ORDER.get(a.area) ?? 99) - (AREA_ORDER.get(b.area) ?? 99) ||
      a.area.localeCompare(b.area, 'zh') ||
      (KIND_ORDER.get(a.kind) ?? 9) - (KIND_ORDER.get(b.kind) ?? 9) ||
      a.code.localeCompare(b.code),
  );

export async function listDevices(db: Db): Promise<Device[]> {
  const rows = await db<Device[]>`SELECT ${deviceColumns(db)} FROM devices d LEFT JOIN devices h ON h.id = d.host_device_id`;
  return sortDevices(rows);
}

export async function getDevice(db: Db, id: number): Promise<Device> {
  const [row] = await db<Device[]>`SELECT ${deviceColumns(db)} FROM devices d LEFT JOIN devices h ON h.id = d.host_device_id WHERE d.id = ${id}`;
  if (!row) throw notFound('设备不存在');
  return row;
}

/** 一屏看全部设备：设备、各状态台数、采购清单对数（采购 / 已登记 / 在线） */
export async function deviceOverview(db: Db): Promise<DeviceOverview> {
  const devices = await listDevices(db);
  const counts = { total: devices.length, disabled: 0, unknown: 0, online: 0, offline: 0, error: 0 };
  for (const d of devices) {
    if (!d.enabled) counts.disabled += 1;
    else counts[d.status] += 1;
  }
  const catalog = DEVICE_QUOTE.map((line) => {
    const mine = devices.filter((d) => d.catalogKey === line.key && d.enabled);
    return {
      key: line.key,
      category: line.category,
      brand: line.brand,
      model: line.model,
      kind: line.kind,
      purchased: line.quantity,
      registered: mine.length,
      online: mine.filter((d) => d.status === 'online').length,
    };
  });
  return { devices, counts, catalog, checkedAt: new Date().toISOString() };
}

const jobColumns = (db: Db) => db`
  j.id, j.device_id, d.code AS device_code, d.name AS device_name, j.kind, j.status, j.attempts, j.error_code, j.error_message,
  j.doc_label, j.first_waited_at, j.wait_code, j.created_by AS created_by_id, s.display_name AS created_by_name, c.display_name AS canceled_by_name,
  j.created_at, j.finished_at`;
const jobFrom = (db: Db) => db`device_jobs j JOIN devices d ON d.id = j.device_id JOIN staff s ON s.id = j.created_by LEFT JOIN staff c ON c.id = j.canceled_by`;

export async function getJob(db: Db, id: number): Promise<DeviceJob> {
  const [row] = await db<DeviceJob[]>`SELECT ${jobColumns(db)} FROM ${jobFrom(db)} WHERE j.id = ${id}`;
  if (!row) throw notFound('打印任务不存在');
  return row;
}

export async function listJobs(db: Db, f: { deviceId?: number; limit?: number; open?: boolean; createdBy?: number }): Promise<DeviceJob[]> {
  return db<DeviceJob[]>`
    SELECT ${jobColumns(db)} FROM ${jobFrom(db)}
    WHERE ${f.deviceId ? db`j.device_id = ${f.deviceId}` : db`true`}
      AND ${f.open ? db`j.status IN ('queued', 'sending', 'waiting')` : db`true`}
      AND ${f.createdBy ? db`j.created_by = ${f.createdBy}` : db`true`}
    ORDER BY j.id DESC LIMIT ${f.limit ?? 50}`;
}

export async function listEvents(db: Db, f: { deviceId?: number; type?: string; limit?: number }): Promise<DeviceEvent[]> {
  return db<DeviceEvent[]>`
    SELECT e.id, e.device_id, d.code AS device_code, e.type, e.data, s.display_name AS staff_name, e.created_at
    FROM device_events e LEFT JOIN devices d ON d.id = e.device_id LEFT JOIN staff s ON s.id = e.staff_id
    WHERE ${f.deviceId ? db`e.device_id = ${f.deviceId}` : db`true`} AND ${f.type ? db`e.type = ${f.type}` : db`true`}
    ORDER BY e.id DESC LIMIT ${f.limit ?? 100}`;
}

// ───────────────────────── 设备登记 ─────────────────────────

const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const DeviceFields = z.object({
  name: z.string('请填写设备名称').trim().min(1, '请填写设备名称').max(40, '名称最多 40 个字'),
  kind: z.enum(DEVICE_KINDS, '请选择设备种类'),
  brand: z.string().trim().max(40, '品牌最多 40 个字').default(''),
  model: z.string().trim().max(60, '型号最多 60 个字').default(''),
  area: z.string('请选择区域').trim().min(1, '请选择区域').max(20, '区域最多 20 个字'),
  connection: z.enum(DEVICE_CONNECTIONS, '请选择接法'),
  host: optionalText(253).refine((v) => v === null || HOST_RE.test(v), 'IP 或主机名只能用字母、数字、「.」「-」「:」'),
  port: z.number('端口必须是整数').int('端口必须是整数').min(1, '端口在 1 到 65535 之间').max(65535, '端口在 1 到 65535 之间').nullish().transform((v) => v ?? null),
  /** 挂在哪台终端或打印服务器下（设备编号） */
  hostDeviceCode: optionalText(32),
  bridgeKey: optionalText(40).refine((v) => v === null || /^[a-z0-9][a-z0-9_-]{0,39}$/.test(v), '设备键用小写字母、数字、「_」「-」'),
  options: z
    .object({
      paperWidth: z.union([z.literal(58), z.literal(80)]).optional(),
      labelLanguage: z.enum(['tspl', 'escpos']).optional(),
      labelWidthMm: z.number().int().min(10).max(120).optional(),
      labelHeightMm: z.number().int().min(10).max(200).optional(),
    })
    .default({}),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
});
const CreateInput = DeviceFields.extend({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  code: z
    .string('请填写设备编号')
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, '编号用大写字母、数字与「-」，2–32 位'),
});
const UpdateInput = DeviceFields.extend({ expectedVersion: z.number().int().positive() });
const EnabledInput = z.object({ expectedVersion: z.number().int().positive(), enabled: z.boolean() });

type Fields = z.infer<typeof DeviceFields>;

/** 按种类与接法整理字段：用不上的清空；接法、所属设备、设备键对得上 */
async function normalizeFields(db: Db, f: Fields, selfId: number | null) {
  if (!DEVICE_KIND_CONNECTIONS[f.kind].includes(f.connection)) {
    throw badRequest(`这种设备不能选「${f.connection}」接法`, { field: 'connection' });
  }
  const network = NETWORK_CONNECTIONS.includes(f.connection);
  const host = network ? f.host : null;
  const port = network ? (f.port ?? (host ? DEFAULT_PRINTER_PORT : null)) : null;
  const bridgeKey = f.connection === 'bridge' ? (f.bridgeKey ?? (f.kind === 'scanner' ? 'scanner' : 'reader')) : null;
  let hostDeviceId: number | null = null;
  const wantsHost = f.connection === 'bridge' || f.connection === 'keyboard' || f.connection === 'print_server';
  if (wantsHost && f.hostDeviceCode) {
    const [h] = await db<{ id: number; kind: DeviceKind }[]>`SELECT id, kind FROM devices WHERE code = ${f.hostDeviceCode.toUpperCase()}`;
    if (!h) throw badRequest(`没有编号为「${f.hostDeviceCode}」的设备`, { field: 'hostDeviceCode' });
    const need: DeviceKind = f.connection === 'print_server' ? 'print_server' : 'terminal';
    if (h.kind !== need) throw badRequest(f.connection === 'print_server' ? '「经打印服务器」要挂在打印服务器下' : '读卡、扫码要挂在终端下', { field: 'hostDeviceCode' });
    if (selfId !== null && h.id === selfId) throw badRequest('不能挂在自己下面', { field: 'hostDeviceCode' });
    hostDeviceId = h.id;
  }
  const options =
    f.kind === 'printer' ? { paperWidth: f.options.paperWidth ?? 80 } : f.kind === 'label_printer' ? { labelLanguage: f.options.labelLanguage ?? 'tspl', labelWidthMm: f.options.labelWidthMm ?? 40, labelHeightMm: f.options.labelHeightMm ?? 30 } : {};
  return { host, port, bridgeKey, hostDeviceId, options };
}

const uniqueToConflict = (error: unknown) => {
  if (isUniqueViolation(error, 'devices_code_key')) return conflict('DEVICE_CODE_TAKEN', '这个设备编号已经有了，请换一个');
  if (isUniqueViolation(error, 'devices_bridge_key_uq')) return conflict('BRIDGE_KEY_TAKEN', '这台终端下已经有同一个设备键，请换一个（如 rc300-2）');
  return null;
};

async function statusEvent(tx: Tx, deviceId: number, data: Record<string, unknown>, staffId: number | null = null) {
  await tx`INSERT INTO device_events (device_id, type, data, staff_id) VALUES (${deviceId}, 'status', ${tx.json(data as never)}, ${staffId})`;
}

export async function createDevice(deps: Deps, raw: unknown, ctx: OpContext): Promise<Device> {
  const input = parse(CreateInput, raw);
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; code: string; kind: string }[]>`SELECT id, code, kind FROM devices WHERE client_key = ${input.clientKey}`;
    if (!p) return null;
    if (p.code !== input.code || p.kind !== input.kind) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于登记另一台设备，请刷新页面后重新填写');
    return Number(p.id);
  };
  const prior = await replay(deps.sql);
  if (prior !== null) return getDevice(deps.sql, prior);
  let id: number;
  try {
    id = await deps.sql.begin(async (tx) => {
      // 与「确认作废」串行：已作废的编号整笔拒绝；同一编号的两次提交排队，后到的返回先到的那台
      await assertNotFenced(tx, input.clientKey, 'device_create', erpOpAbandoned);
      const again = await replay(tx);
      if (again !== null) return again;
      const n = await normalizeFields(tx, input, null);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO devices (code, name, kind, brand, model, area, connection, host, port, host_device_id, bridge_key, options, note, client_key, created_by)
        VALUES (${input.code}, ${input.name}, ${input.kind}, ${input.brand}, ${input.model}, ${input.area}, ${input.connection}, ${n.host}, ${n.port},
                ${n.hostDeviceId}, ${n.bridgeKey}, ${tx.json(n.options as never)}, ${input.note}, ${input.clientKey}, ${ctx.actor.id})
        RETURNING id`;
      const { clientKey: _k, ...created } = input;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'device_created', targetType: 'device', targetId: row!.id, detail: { created }, ip: ctx.ip });
      return Number(row!.id);
    });
  } catch (error) {
    const c = uniqueToConflict(error);
    if (isUniqueViolation(error, 'devices_client_key_key')) {
      const again = await replay(deps.sql);
      if (again !== null) return getDevice(deps.sql, again);
    }
    throw c ?? error;
  }
  return getDevice(deps.sql, id);
}

async function lockDevice(tx: Tx, id: number) {
  const [row] = await tx<{ id: number; code: string; kind: DeviceKind; version: number; enabled: boolean; connection: string; host: string | null; port: number | null }[]>`
    SELECT id, code, kind, version, enabled, connection, host, port FROM devices WHERE id = ${id} FOR UPDATE`;
  if (!row) throw notFound('设备不存在');
  return row;
}

const versionConflict = () => conflict('VERSION_CONFLICT', '这台设备刚被别人改过，请刷新后再改');

export async function updateDevice(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<Device> {
  const input = parse(UpdateInput, raw);
  try {
    await deps.sql.begin(async (tx) => {
      const cur = await lockDevice(tx, id);
      if (cur.version !== input.expectedVersion) throw versionConflict();
      if (cur.kind !== input.kind) throw badRequest('设备种类登记后不能改；登记错了请停用后另登记一台', { field: 'kind' });
      const before = await getDevice(tx, id);
      const n = await normalizeFields(tx, input, id);
      // 接法、地址、所属终端变了：状态回到「未知」，等下一次心跳或上报
      const moved = before.connection !== input.connection || before.host !== n.host || before.port !== n.port || before.hostDeviceId !== n.hostDeviceId || before.bridgeKey !== n.bridgeKey;
      await tx`
        UPDATE devices SET name = ${input.name}, brand = ${input.brand}, model = ${input.model}, area = ${input.area}, connection = ${input.connection},
               host = ${n.host}, port = ${n.port}, host_device_id = ${n.hostDeviceId}, bridge_key = ${n.bridgeKey}, options = ${tx.json(n.options as never)},
               note = ${input.note}, version = version + 1, updated_at = now(),
               status = CASE WHEN ${moved} THEN 'unknown' ELSE status END,
               status_code = CASE WHEN ${moved} THEN NULL ELSE status_code END,
               status_changed_at = CASE WHEN ${moved} THEN now() ELSE status_changed_at END
        WHERE id = ${id}`;
      // 排着还没发的打印任务是按旧设置提交的：记失败、不按新设置改投（已经在发的照常发完）（Codex 预检 3efa3fe）；
      // 等打印机恢复的业务单据（v0.7.28）一样
      await tx`
        UPDATE device_jobs SET status = 'failed', error_code = 'DEVICE_CHANGED', error_message = '设备设置改了，这张排着还没发，没有按新设置发送，请重新提交', finished_at = now()
        WHERE device_id = ${id} AND status IN ('queued', 'waiting')`;
      const { expectedVersion: _v, ...after } = input;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'device_updated',
        targetType: 'device',
        targetId: id,
        detail: { code: cur.code, before: { name: before.name, area: before.area, connection: before.connection, host: before.host, port: before.port, hostDeviceCode: before.hostDeviceCode, bridgeKey: before.bridgeKey, note: before.note }, after },
        ip: ctx.ip,
      });
    });
  } catch (error) {
    throw uniqueToConflict(error) ?? error;
  }
  return getDevice(deps.sql, id);
}

export async function setDeviceEnabled(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<Device> {
  const input = parse(EnabledInput, raw);
  await deps.sql.begin(async (tx) => {
    const cur = await lockDevice(tx, id);
    if (cur.version !== input.expectedVersion) throw versionConflict();
    if (cur.enabled === input.enabled) return;
    await tx`
      UPDATE devices SET enabled = ${input.enabled}, version = version + 1, updated_at = now(),
             status = 'unknown', status_code = NULL, status_changed_at = now()
      WHERE id = ${id}`;
    // 停用：排着还没发的打印任务记失败、不再发（已经在发的照常发完）（Codex 预检 3efa3fe）；等打印机恢复的（v0.7.28）一样
    if (!input.enabled) {
      await tx`
        UPDATE device_jobs SET status = 'failed', error_code = 'DEVICE_DISABLED', error_message = '设备已停用，这张排着还没发，没有发送', finished_at = now()
        WHERE device_id = ${id} AND status IN ('queued', 'waiting')`;
    }
    await statusEvent(tx, id, { enabled: input.enabled }, ctx.actor.id);
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'device_enabled', targetType: 'device', targetId: id, detail: { code: cur.code, enabled: input.enabled }, ip: ctx.ip });
  });
  return getDevice(deps.sql, id);
}

// ───────────────────────── 按采购清单导入 ─────────────────────────

export async function importPreview(db: Db): Promise<DeviceImportPreview> {
  const planned = plannedQuoteDevices();
  const existing = new Set((await db<{ code: string }[]>`SELECT code FROM devices`).map((r) => r.code));
  return {
    create: planned.filter((p) => !existing.has(p.code)).map((p) => ({ code: p.code, name: p.name, kind: p.line.kind, model: p.line.model, area: p.area, catalogKey: p.line.key })),
    skipped: planned.filter((p) => existing.has(p.code)).map((p) => p.code),
    total: planned.length,
  };
}

/**
 * 按采购清单写入设备（编号已有的跳过，所以重复执行、没收到结果再点都只会补上缺的）。IP、端口、所属终端由现场在后台填。
 * 全部导入串行（咨询锁）。
 */
export async function importDevices(db: Sql, actor: { id: number } | null, ip?: string): Promise<{ created: number; skipped: number }> {
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('yuzu.devices.import', 0))`;
    const planned = plannedQuoteDevices();
    let created = 0;
    for (const p of planned) {
      const options = p.line.options ?? {};
      const rows = await tx`
        INSERT INTO devices (code, name, kind, brand, model, area, connection, bridge_key, options, catalog_key, note, created_by)
        VALUES (${p.code}, ${p.name}, ${p.line.kind}, ${p.line.brand}, ${p.line.model}, ${p.area}, ${p.line.connection},
                ${p.line.connection === 'bridge' ? (p.line.bridgeKey ?? 'reader') : null}, ${tx.json(options as never)}, ${p.line.key}, ${p.line.note ?? ''}, ${actor?.id ?? null})
        ON CONFLICT (code) DO NOTHING RETURNING id`;
      created += rows.length;
    }
    await writeAudit(tx, { staffId: actor?.id ?? null, action: 'devices_imported', targetType: 'device', detail: { created, skipped: planned.length - created, source: '采购清单 2025-12-17' }, ip });
    return { created, skipped: planned.length - created };
  }) as Promise<{ created: number; skipped: number }>;
}

// ───────────────────────── 状态 ─────────────────────────

/**
 * 记一次状态（心跳或终端上报）：联系上了（seen）就更新最近联系时间；状态或原因变了记一条设备事件。
 * 只锁这台设备一行，不等业务锁。expectVersion：按探测前读到的设置写回——探测期间设备被修改、停用（版本变了），
 * 这次结果是旧地址、旧设置的，作废不写（Codex 预检 3efa3fe）。
 */
export async function recordStatus(db: Sql, id: number, status: DeviceStatus, code: DeviceErrorCode | null, opts: { seen: boolean; now?: Date; expectVersion?: number }) {
  const now = opts.now ?? new Date();
  await db.begin(async (tx) => {
    const [cur] = await tx<{ status: DeviceStatus; statusCode: string | null; enabled: boolean; version: number }[]>`
      SELECT status, status_code, enabled, version FROM devices WHERE id = ${id} FOR UPDATE`;
    if (!cur || !cur.enabled) return;
    if (opts.expectVersion !== undefined && cur.version !== opts.expectVersion) return;
    const changed = cur.status !== status || (cur.statusCode ?? null) !== code;
    if (!changed && !opts.seen) return;
    await tx`
      UPDATE devices SET status = ${status}, status_code = ${code},
             last_seen_at = CASE WHEN ${opts.seen} THEN ${now} ELSE last_seen_at END,
             status_changed_at = CASE WHEN ${changed} THEN ${now} ELSE status_changed_at END
      WHERE id = ${id}`;
    if (changed) await statusEvent(tx, id, { from: cur.status, to: status, code, reason: code ? DEVICE_ERROR_LABELS[code] : null });
  });
}

/** 正在打印的设备：心跳跳过它（多数打印机网口同时只接一个连接） */
const busy = new Set<number>();
/** 上一次心跳还没回来的设备（与它占着的连接）：不重复发起；打印要等它放开连接再连（Codex 自动审查 9ca8a95） */
const probing = new Map<number, Promise<unknown>>();

/**
 * 心跳一轮：查所有启用的网口设备（连上就在线或故障，连不上且最近一次联系上已超过 5 秒记离线）；
 * 终端与挂在终端下的设备超过 5 秒没上报记离线；没配好（没填 IP、没指定终端）的记「还没配好」。
 */
export async function checkDevicesOnce(deps: Pick<Deps, 'sql'>, now = new Date()): Promise<void> {
  const { sql } = deps;
  const rows = await sql<
    {
      id: number;
      kind: DeviceKind;
      connection: string;
      host: string | null;
      port: number | null;
      hostDeviceId: number | null;
      options: { labelLanguage?: string };
      status: DeviceStatus;
      statusCode: string | null;
      lastSeenAt: string | null;
      version: number;
    }[]
  >`SELECT id, kind, connection, host, port, host_device_id, options, status, status_code, last_seen_at, version FROM devices WHERE enabled`;
  const stale = (seen: string | null) => !seen || now.getTime() - Date.parse(seen) > OFFLINE_AFTER_MS;
  // 本机打印（店主 2026-11-10）：服务器不连网口打印机，也就不探测它们（云上的正式服连不到门店局域网）
  const localPrint = (await loadSettings(sql)).printMode === 'local';
  await Promise.all(
    rows.map(async (d) => {
      if (NETWORK_CONNECTIONS.includes(d.connection as never)) {
        if (localPrint) return;
        if (!d.host || !d.port) {
          if (d.status !== 'unknown' || d.statusCode !== 'DEVICE_NOT_CONFIGURED') await recordStatus(sql, d.id, 'unknown', 'DEVICE_NOT_CONFIGURED', { seen: false, now, expectVersion: d.version });
          return;
        }
        if (busy.has(d.id) || probing.has(d.id)) return;
        const mode = d.kind === 'print_server' ? 'connect' : d.kind === 'label_printer' && d.options.labelLanguage !== 'escpos' ? 'tspl' : 'escpos';
        // 查与登记在同一拍里（中间没有 await）：打印那边看到 busy 或等这个承诺，两边不会同时占连接
        const pending = probe({ host: d.host, port: d.port }, mode);
        probing.set(d.id, pending);
        try {
          const r = await pending;
          if (r.reachable) await recordStatus(sql, d.id, r.code ? 'error' : 'online', r.code, { seen: true, now: new Date(), expectVersion: d.version });
          else if (stale(d.lastSeenAt) && (d.status !== 'offline' || d.statusCode !== (r.code ?? 'DEVICE_OFFLINE'))) {
            await recordStatus(sql, d.id, 'offline', r.code ?? 'DEVICE_OFFLINE', { seen: false, now, expectVersion: d.version });
          }
        } finally {
          probing.delete(d.id);
        }
        return;
      }
      if (d.connection === 'bridge' && d.hostDeviceId === null) {
        if (d.status !== 'unknown' || d.statusCode !== 'DEVICE_NOT_CONFIGURED') await recordStatus(sql, d.id, 'unknown', 'DEVICE_NOT_CONFIGURED', { seen: false, now, expectVersion: d.version });
        return;
      }
      // 终端、挂在终端下的设备：靠开着页面的终端上报；联系过、超过 5 秒没上报记离线（没联系过的保持「未知」）
      if ((d.kind === 'terminal' || d.connection === 'bridge') && d.lastSeenAt && stale(d.lastSeenAt) && d.status !== 'offline') {
        await recordStatus(sql, d.id, 'offline', d.kind === 'terminal' ? 'DEVICE_OFFLINE' : 'BRIDGE_OFFLINE', { seen: false, now, expectVersion: d.version });
      }
    }),
  );
}

// ───────────────────────── 终端替桥上报 ─────────────────────────

const ReportInput = z.object({
  terminal: z.string('缺少终端编号').trim().toUpperCase().min(1).max(32),
  bridge: z.object({ connected: z.boolean(), version: z.string().max(32).optional() }),
  devices: z.array(z.object({ key: z.string().min(1).max(40), status: z.enum(DEVICE_STATUSES), code: z.string().max(40).nullish() })).max(32).default([]),
  events: z
    .array(
      z.object({
        id: z.uuid('事件编号不正确'),
        key: z.string().min(1).max(40),
        type: z.enum(['card', 'scan', 'error']),
        value: z.string().min(1).max(DEVICE_EVENT_VALUE_MAX),
        at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), '时间格式不对'),
      }),
    )
    .max(50)
    .default([]),
});

export async function reportBridge(deps: Deps, raw: unknown, ctx: OpContext): Promise<BridgeReportResult> {
  const input = parse(ReportInput, raw);
  const now = new Date();
  return deps.sql.begin(async (tx) => {
    // 锁顺序：终端一行 → 它下面的设备（id 升序）
    const [terminal] = await tx<{ id: number; code: string; name: string; enabled: boolean; status: DeviceStatus; statusCode: string | null }[]>`
      SELECT id, code, name, enabled, status, status_code FROM devices WHERE code = ${input.terminal} AND kind = 'terminal' FOR UPDATE`;
    if (!terminal) throw notFound(`没有登记编号为「${input.terminal}」的终端`);
    if (!terminal.enabled) throw unprocessable('DEVICE_DISABLED', `终端「${terminal.name}」已停用`);
    const children = await tx<{ id: number; code: string; name: string; bridgeKey: string | null; enabled: boolean; status: DeviceStatus; statusCode: string | null }[]>`
      SELECT id, code, name, bridge_key, enabled, status, status_code FROM devices WHERE host_device_id = ${terminal.id} AND connection = 'bridge' ORDER BY id FOR UPDATE`;
    const setStatus = async (d: { id: number; status: DeviceStatus; statusCode: string | null }, status: DeviceStatus, code: DeviceErrorCode | null, seen: boolean) => {
      const changed = d.status !== status || (d.statusCode ?? null) !== code;
      await tx`
        UPDATE devices SET status = ${status}, status_code = ${code},
               last_seen_at = CASE WHEN ${seen} THEN ${now} ELSE last_seen_at END,
               status_changed_at = CASE WHEN ${changed} THEN ${now} ELSE status_changed_at END
        WHERE id = ${d.id}`;
      if (changed) await statusEvent(tx, d.id, { from: d.status, to: status, code, reason: code ? DEVICE_ERROR_LABELS[code] : null, via: terminal.code }, ctx.actor.id);
    };
    await setStatus(terminal, 'online', null, true);
    const matched: BridgeReportResult['matched'] = [];
    for (const c of children) {
      if (!c.enabled) continue;
      const r = input.devices.find((x) => x.key === c.bridgeKey);
      if (r) matched.push({ key: r.key, code: c.code, name: c.name });
      if (!input.bridge.connected) await setStatus(c, 'offline', 'BRIDGE_OFFLINE', false);
      else if (!r) await setStatus(c, 'offline', 'DEVICE_OFFLINE', false);
      else {
        // 只认协议里的错误码：按对象取值会把 __proto__ 之类继承来的属性也当成有，写进去后设备页渲染出错（Codex 自动审查 9ca8a95）
        const code = isDeviceErrorCode(r.code) ? r.code : null;
        await setStatus(c, r.status, r.status === 'online' ? null : code, r.status === 'online' || r.status === 'error');
      }
    }
    const byKey = new Map(children.map((c) => [c.bridgeKey, c]));
    const unknownKeys = [...new Set(input.devices.map((d) => d.key).filter((k) => !byKey.has(k)))];
    let recorded = 0;
    for (const e of input.events) {
      // 登记里没有这个设备键的（如终端自带的 NFC）记在终端名下
      const target = byKey.get(e.key) ?? terminal;
      const rows = await tx`
        INSERT INTO device_events (device_id, type, data, event_key, staff_id)
        VALUES (${target.id}, ${e.type}, ${tx.json({ key: e.key, value: e.value, at: e.at, terminal: terminal.code } as never)}, ${e.id}, ${ctx.actor.id})
        ON CONFLICT (event_key) DO NOTHING RETURNING id`;
      recorded += rows.length;
    }
    return { terminal: { code: terminal.code, name: terminal.name }, matched, unknownKeys, recorded };
  }) as Promise<BridgeReportResult>;
}

// ───────────────────────── 打印任务 ─────────────────────────

const JobInput = z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'), kind: z.enum(['test_page', 'label_test'], '请选择打印内容') });

const JOB_FOR_KIND: Partial<Record<DeviceKind, DeviceJobKind>> = { printer: 'test_page', label_printer: 'label_test' };

/** 按台排队：同一台一次打一张（进程内的队列；应用只有一个进程） */
const chains = new Map<number, Promise<void>>();

export function enqueueJob(deps: Deps, jobId: number, deviceId: number, log?: (msg: string, err: unknown) => void) {
  const prev = chains.get(deviceId) ?? Promise.resolve();
  const next = prev
    .then(() => runJob(deps, jobId))
    .catch((err) => log?.(`打印任务 ${jobId} 出错`, err))
    .finally(() => {
      if (chains.get(deviceId) === next) chains.delete(deviceId);
    });
  chains.set(deviceId, next);
}

/** 等进程里排着的打印任务都处理完（测试与关闭应用时用） */
export async function waitForDeviceJobs(): Promise<void> {
  while (chains.size > 0) await Promise.all([...chains.values()]);
}

const formatTime = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .format(at)
    .replace(/\//g, '-');

/** 还没开始发就连不上（可以等打印机恢复再发）的错误码 */
const NOT_STARTED_CODES: readonly DeviceErrorCode[] = ['DEVICE_TIMEOUT', 'DEVICE_REFUSED', 'DEVICE_UNREACHABLE'];

/** 业务单据进「等打印机恢复」（只改还在排队的那一张；第一次开始等的时间不改） */
async function toWaiting(db: Db, jobId: number, code: DeviceErrorCode, attempts = 0) {
  await db`
    UPDATE device_jobs SET status = 'waiting', wait_code = ${code}, attempts = attempts + ${attempts}, started_at = NULL,
           first_waited_at = COALESCE(first_waited_at, now())
    WHERE id = ${jobId} AND status IN ('queued', 'sending')`;
}

async function runJob(deps: Deps, jobId: number) {
  const { sql } = deps;
  const [ref] = await sql<{ deviceId: number }[]>`SELECT device_id FROM device_jobs WHERE id = ${jobId} AND status = 'queued'`;
  if (!ref) return;
  // 领取：先锁设备一行（共享锁，与修改、停用的排他锁串行），再领任务。发送用这时读到的设置：领取之后设备被改了地址也不改投；
  // 设备停用了不发（停用、修改时已把排着的记失败，这里再核对一次）（Codex 预检 3efa3fe）
  const claimed = await sql.begin(async (tx) => {
    await tx`SELECT 1 FROM devices WHERE id = ${ref.deviceId} FOR SHARE`;
    const device = await getDevice(tx, ref.deviceId);
    if (!device.enabled) {
      await tx`
        UPDATE device_jobs SET status = 'failed', error_code = 'DEVICE_DISABLED', error_message = '设备已停用，这张排着还没发，没有发送', finished_at = now()
        WHERE id = ${jobId} AND status IN ('queued', 'waiting')`;
      return null;
    }
    const [cur] = await tx<{ kind: DeviceJobKind }[]>`SELECT kind FROM device_jobs WHERE id = ${jobId} AND status = 'queued' FOR UPDATE`;
    if (!cur) return null;
    // 业务单据（v0.7.28）：打印机离线、故障（缺纸、开盖、报错）时不发，等它恢复（心跳看到恢复在线后改回排队）
    if (isDocJobKind(cur.kind) && (device.status === 'offline' || device.status === 'error')) {
      await toWaiting(tx, jobId, device.statusCode ?? (device.status === 'offline' ? 'DEVICE_OFFLINE' : 'DEVICE_FAULT'));
      return null;
    }
    const [job] = await tx<{ id: number; kind: DeviceJobKind; payload: Buffer | null; firstWaitedAt: Date | null }[]>`
      UPDATE device_jobs SET status = 'sending', started_at = now() WHERE id = ${jobId} AND status = 'queued' RETURNING id, kind, payload, first_waited_at`;
    return job ? { job, device } : null;
  });
  if (!claimed) return;
  const { job, device } = claimed;
  // 先挡住之后的心跳，再等正在进行的那次心跳放开连接：多数打印机网口同时只接一个连接，
  // 不回状态的型号一次心跳要占满 1.5 秒，不等的话打印的几次连接都会被拒（Codex 自动审查 9ca8a95）
  busy.add(device.id);
  await probing.get(device.id)?.catch(() => {});
  try {
    await sendJob(deps, jobId, job, device);
  } catch (error) {
    // 拼指令、读设置出错（没开始发）：记失败，不留在「发送中」
    await sql`
      UPDATE device_jobs SET status = 'failed', error_code = 'DEVICE_FAULT', error_message = ${`打印任务出错：${(error as Error).message}`.slice(0, 300)}, finished_at = now()
      WHERE id = ${jobId} AND status = 'sending'`;
    throw error;
  } finally {
    busy.delete(device.id);
  }
}

async function sendJob(deps: Deps, jobId: number, job: { kind: DeviceJobKind; payload: Buffer | null; firstWaitedAt: Date | null }, device: Device) {
  const { sql, config } = deps;
  let data: Buffer;
  if (job.payload) {
    // 业务单据：提交时排好的内容，末尾补上走纸、切纸（等过打印机恢复的注明补打）
    data = finishSlip(Buffer.from(job.payload), { waitedSince: job.firstWaitedAt, now: new Date(), timeZone: config.timezone });
  } else {
    const settings = await loadSettings(sql);
    const info = {
      storeName: settings.storeName,
      instanceLabel: INSTANCE_LABELS[config.instance],
      production: config.instance === 'prod',
      version: config.version,
      device: { code: device.code, name: device.name, area: device.area, model: device.model, host: device.host, port: device.port },
      paperWidth: device.options.paperWidth,
      printedAt: formatTime(new Date(), config.timezone),
      jobId,
    };
    data = job.kind === 'label_test' ? buildTestLabel({ ...info, ...device.options }) : buildTestPage(info);
  }
  const res =
    device.host && device.port
      ? await sendToPrinter({ host: device.host, port: device.port }, data)
      : { ok: false, attempts: 0, errorCode: 'DEVICE_NOT_CONFIGURED' as DeviceErrorCode, errorMessage: DEVICE_ERROR_LABELS.DEVICE_NOT_CONFIGURED };
  // 业务单据还没开始发就连不上：不算失败，等打印机恢复（已经开始发、中途断了的照旧记中断、不自动重打）
  if (!res.ok && job.payload && res.errorCode && NOT_STARTED_CODES.includes(res.errorCode)) {
    await toWaiting(sql, jobId, res.errorCode, res.attempts);
    return;
  }
  await sql`
    UPDATE device_jobs SET status = ${res.ok ? 'done' : 'failed'}, attempts = attempts + ${res.attempts}, error_code = ${res.ok ? null : (res.errorCode ?? 'DEVICE_TIMEOUT')},
           error_message = ${res.ok ? null : (res.errorMessage ?? '').slice(0, 300) || DEVICE_ERROR_LABELS[res.errorCode ?? 'DEVICE_TIMEOUT']}, finished_at = now()
    WHERE id = ${jobId} AND status = 'sending'`;
  // 打成了就是联系上了（打印时心跳跳过这台）；发送期间设备被改了的不记（按领取时的设置）
  if (res.ok) await recordStatus(sql, device.id, 'online', null, { seen: true, expectVersion: device.version });
}

/** 应用启动时：重启前还在发送的记失败（不自动重发，可能已打出一半），还在排队的接着打；等打印机恢复的接着等 */
export async function recoverJobs(deps: Deps, log?: (msg: string, err: unknown) => void) {
  await deps.sql`
    UPDATE device_jobs SET status = 'failed', error_code = 'DEVICE_INTERRUPTED', error_message = '应用重启时这张还在发送，没有自动重发', finished_at = now()
    WHERE status = 'sending'`;
  const queued = await deps.sql<{ id: number; deviceId: number }[]>`SELECT id, device_id FROM device_jobs WHERE status = 'queued' ORDER BY id`;
  for (const j of queued) enqueueJob(deps, j.id, j.deviceId, log);
}

/**
 * 断网打印队列（v0.7.28）：每轮心跳之后调用。
 *   · 等了超过「小票机断网时最多等几分钟」（N7，默认 30 分钟，8.0.7 起可改）的不再打，记失败（DEVICE_WAIT_EXPIRED）；
 *   · 恢复在线的打印机：先锁这台一行（共享锁，与修改、停用串行），把它等恢复的单子按提交顺序改回排队、交给按台的队列补打。
 */
export async function resumeWaitingJobs(deps: Deps, opts: { now?: Date; log?: (msg: string, err: unknown) => void } = {}): Promise<{ resumed: number; expired: number }> {
  const { sql } = deps;
  const now = opts.now ?? new Date();
  const { printWaitMinutes } = await loadSettings(sql);
  const expired = await sql`
    UPDATE device_jobs SET status = 'failed', error_code = 'DEVICE_WAIT_EXPIRED', error_message = ${`等打印机恢复超过 ${printWaitMinutes} 分钟，没有再打`}, finished_at = now()
    WHERE status = 'waiting' AND first_waited_at < ${new Date(now.getTime() - printWaitMinutes * 60_000)}
    RETURNING id`;
  const ready = await sql<{ deviceId: number }[]>`
    SELECT DISTINCT j.device_id FROM device_jobs j JOIN devices d ON d.id = j.device_id
    WHERE j.status = 'waiting' AND d.enabled AND d.status = 'online'`;
  let resumed = 0;
  for (const { deviceId } of ready) {
    const ids = await sql.begin(async (tx) => {
      const [d] = await tx<{ enabled: boolean; status: DeviceStatus }[]>`SELECT enabled, status FROM devices WHERE id = ${deviceId} FOR SHARE`;
      if (!d?.enabled || d.status !== 'online') return [];
      const rows = await tx<{ id: number }[]>`UPDATE device_jobs SET status = 'queued' WHERE device_id = ${deviceId} AND status = 'waiting' RETURNING id`;
      return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    });
    for (const id of ids) enqueueJob(deps, id, deviceId, opts.log);
    resumed += ids.length;
  }
  return { resumed, expired: expired.length };
}

/** 取消排队、等打印机恢复的打印任务（提交人或维护设备的人）；已经在发、已经结束的不能取消。只锁任务一行 */
export async function cancelJob(deps: Deps, id: number, ctx: OpContext, canManage: boolean): Promise<DeviceJob> {
  await deps.sql.begin(async (tx) => {
    const [j] = await tx<{ status: string; createdBy: number; deviceId: number; docLabel: string | null; kind: DeviceJobKind }[]>`
      SELECT status, created_by, device_id, doc_label, kind FROM device_jobs WHERE id = ${id} FOR UPDATE`;
    if (!j) throw notFound('打印任务不存在');
    if (Number(j.createdBy) !== ctx.actor.id && !canManage) throw forbidden('只能取消自己提交的打印任务');
    if (j.status !== 'queued' && j.status !== 'waiting') {
      throw conflict('JOB_NOT_CANCELABLE', j.status === 'sending' ? '这张正在发送，不能取消' : '这张已经结束了，不用取消');
    }
    await tx`UPDATE device_jobs SET status = 'canceled', canceled_by = ${ctx.actor.id}, finished_at = now() WHERE id = ${id}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'device_job_canceled', targetType: 'device', targetId: Number(j.deviceId), detail: { jobId: id, kind: j.kind, doc: j.docLabel, from: j.status }, ip: ctx.ip });
  });
  return getJob(deps.sql, id);
}

/**
 * 建业务单据的打印任务（v0.7.28，调用方已核对能看这张单据、排好了内容）：
 * 操作编号的咨询锁（与「确认作废」串行）→ 打印机一行；打印机离线、故障时也建，进「等打印机恢复」（不像测试页那样直接失败）。
 */
/**
 * 打印方式是「本机打印」（店主 2026-11-10：连接打印机由各自的电脑负责，正式服在云上时用）：服务器不往网口小票机发，
 * 单据请用浏览器打印。原样重提（同一个编号已经建过的任务）照旧返回原来那张，不在这里拦。
 */
async function assertNetworkPrint(db: Db) {
  if ((await loadSettings(db)).printMode === 'local') {
    throw unprocessable('PRINT_MODE_LOCAL', '现在是「本机打印」：请用浏览器打印到这台电脑连的打印机（店主可以在后台「经营规则 → 可调的数值」里改打印方式）');
  }
}

export async function createDocJob(
  deps: Deps,
  input: { clientKey: string; deviceId: number; kind: DeviceJobKind; docRef: string; docLabel: string; payload: Buffer },
  ctx: OpContext,
  log?: (msg: string, err: unknown) => void,
): Promise<DeviceJob> {
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; deviceId: number; kind: string; docRef: string | null }[]>`SELECT id, device_id, kind, doc_ref FROM device_jobs WHERE client_key = ${input.clientKey}`;
    if (!p) return null;
    if (Number(p.deviceId) !== input.deviceId || p.kind !== input.kind || p.docRef !== input.docRef) {
      throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一个打印任务，请刷新页面后重试');
    }
    return Number(p.id);
  };
  const prior = await replay(deps.sql);
  if (prior !== null) return getJob(deps.sql, prior);
  await assertNetworkPrint(deps.sql);
  let created: { id: number; queued: boolean };
  try {
    created = await deps.sql.begin(async (tx) => {
      await assertNotFenced(tx, input.clientKey, 'doc_print', erpOpAbandoned);
      const again = await replay(tx);
      if (again !== null) return { id: again, queued: false };
      const d = await lockDevice(tx, input.deviceId);
      if (!d.enabled) throw unprocessable('DEVICE_DISABLED', DEVICE_ERROR_LABELS.DEVICE_DISABLED);
      if (d.kind !== 'printer') throw unprocessable('DEVICE_UNSUPPORTED', '单据只能打到小票打印机');
      if (!NETWORK_CONNECTIONS.includes(d.connection as never) || !d.host || !d.port) throw unprocessable('DEVICE_NOT_CONFIGURED', DEVICE_ERROR_LABELS.DEVICE_NOT_CONFIGURED);
      const [cur] = await tx<{ status: DeviceStatus; statusCode: DeviceErrorCode | null }[]>`SELECT status, status_code FROM devices WHERE id = ${input.deviceId}`;
      // 打印机离线、故障：直接进「等打印机恢复」，恢复后自动补打
      const waiting = cur!.status === 'offline' || cur!.status === 'error';
      const waitCode: DeviceErrorCode | null = waiting ? (cur!.statusCode ?? (cur!.status === 'offline' ? 'DEVICE_OFFLINE' : 'DEVICE_FAULT')) : null;
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO device_jobs (device_id, kind, status, client_key, created_by, doc_ref, doc_label, payload, first_waited_at, wait_code)
        VALUES (${input.deviceId}, ${input.kind}, ${waiting ? 'waiting' : 'queued'}, ${input.clientKey}, ${ctx.actor.id}, ${input.docRef}, ${input.docLabel}, ${input.payload},
                ${waiting ? tx`now()` : null}, ${waitCode})
        RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'device_job_created',
        targetType: 'device',
        targetId: input.deviceId,
        detail: { code: d.code, kind: input.kind, doc: input.docLabel, jobId: row!.id, waiting },
        ip: ctx.ip,
      });
      return { id: Number(row!.id), queued: !waiting };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'device_jobs_client_key_key')) {
      const again = await replay(deps.sql);
      if (again !== null) return getJob(deps.sql, again);
    }
    throw error;
  }
  return readThenEnqueue(deps, created, input.deviceId, log);
}

/**
 * 新登记的任务先读回、再交给发送队列：返回的是刚登记时的状态（排队中）。先入队再读的话，队列有时抢先领走，
 * 返回的状态时而「排队中」时而「发送中」（main 定时测试 v0.7.29）。读回出错也照样入队（finally），不会排着没人发
 */
async function readThenEnqueue(deps: Deps, created: { id: number; queued: boolean }, deviceId: number, log?: (msg: string, err: unknown) => void): Promise<DeviceJob> {
  try {
    return await getJob(deps.sql, created.id);
  } finally {
    if (created.queued) enqueueJob(deps, created.id, deviceId, log);
  }
}

export async function createJob(deps: Deps, deviceId: number, raw: unknown, ctx: OpContext, log?: (msg: string, err: unknown) => void): Promise<DeviceJob> {
  const input = parse(JobInput, raw);
  const replay = async (db: Db) => {
    const [p] = await db<{ id: number; deviceId: number; kind: string }[]>`SELECT id, device_id, kind FROM device_jobs WHERE client_key = ${input.clientKey}`;
    if (!p) return null;
    if (Number(p.deviceId) !== deviceId || p.kind !== input.kind) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一个打印任务，请刷新页面后重试');
    return Number(p.id);
  };
  const prior = await replay(deps.sql);
  if (prior !== null) return getJob(deps.sql, prior);
  await assertNetworkPrint(deps.sql);
  let created: { id: number; queued: boolean };
  try {
    created = await deps.sql.begin(async (tx) => {
      await assertNotFenced(tx, input.clientKey, 'device_job', erpOpAbandoned);
      const again = await replay(tx);
      if (again !== null) return { id: again, queued: false };
      // 先锁设备一行：同一台的任务串行登记
      const d = await lockDevice(tx, deviceId);
      if (!d.enabled) throw unprocessable('DEVICE_DISABLED', DEVICE_ERROR_LABELS.DEVICE_DISABLED);
      if (JOB_FOR_KIND[d.kind] !== input.kind) throw unprocessable('DEVICE_UNSUPPORTED', DEVICE_ERROR_LABELS.DEVICE_UNSUPPORTED);
      if (!NETWORK_CONNECTIONS.includes(d.connection as never) || !d.host || !d.port) throw unprocessable('DEVICE_NOT_CONFIGURED', DEVICE_ERROR_LABELS.DEVICE_NOT_CONFIGURED);
      const [cur] = await tx<{ status: DeviceStatus }[]>`SELECT status FROM devices WHERE id = ${deviceId}`;
      // 离线时不攒着等它恢复（断网打印队列在 v0.2）：直接记失败
      const offline = cur!.status === 'offline';
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO device_jobs (device_id, kind, status, client_key, created_by, error_code, error_message, finished_at)
        VALUES (${deviceId}, ${input.kind}, ${offline ? 'failed' : 'queued'}, ${input.clientKey}, ${ctx.actor.id},
                ${offline ? 'DEVICE_OFFLINE' : null}, ${offline ? `${DEVICE_ERROR_LABELS.DEVICE_OFFLINE}，没有发送` : null}, ${offline ? tx`now()` : null})
        RETURNING id`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'device_job_created', targetType: 'device', targetId: deviceId, detail: { code: d.code, kind: input.kind, jobId: row!.id, offline }, ip: ctx.ip });
      return { id: Number(row!.id), queued: !offline };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'device_jobs_client_key_key')) {
      const again = await replay(deps.sql);
      if (again !== null) return getJob(deps.sql, again);
    }
    throw error;
  }
  return readThenEnqueue(deps, created, deviceId, log);
}

// ───────────────────────── 接口 ─────────────────────────

const JobsQuery = z.object({ deviceId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
const EventsQuery = JobsQuery.extend({ type: z.enum(DEVICE_EVENT_TYPES).optional() });

export function registerDeviceRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const log = (msg: string, err: unknown) => app.log.error({ err }, msg);

  app.get('/api/devices/overview', { preHandler: guard('device.view') }, async () => deviceOverview(sql));
  app.get('/api/devices', { preHandler: guard('device.manage') }, async () => listDevices(sql));
  app.post('/api/devices', { preHandler: guard('device.manage') }, async (req) => createDevice(deps, req.body, ctxOf(req)));
  app.put('/api/devices/:id', { preHandler: guard('device.manage') }, async (req) => updateDevice(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/devices/:id/enabled', { preHandler: guard('device.manage') }, async (req) => setDeviceEnabled(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.get('/api/devices/import', { preHandler: guard('device.manage') }, async () => importPreview(sql));
  app.post('/api/devices/import', { preHandler: guard('device.manage') }, async (req) => importDevices(sql, req.actor, req.ip));
  app.post('/api/devices/:id/jobs', { preHandler: guard('device.test') }, async (req) => createJob(deps, parse(idParam, req.params).id, req.body, ctxOf(req), log));
  app.get('/api/devices/jobs', { preHandler: guard('device.view') }, async (req) => listJobs(sql, parse(JobsQuery, req.query ?? {})));
  app.get('/api/devices/jobs/:id', { preHandler: guard('device.view') }, async (req) => getJob(sql, parse(idParam, req.params).id));
  app.get('/api/devices/events', { preHandler: guard('device.manage') }, async (req) => listEvents(sql, parse(EventsQuery, req.query ?? {})));
  app.post('/api/devices/bridge-report', { preHandler: guard('device.view') }, async (req) => reportBridge(deps, req.body, ctxOf(req)));
}
