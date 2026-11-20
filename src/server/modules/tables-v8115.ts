// 8.1.15《浴族系统需求汇总》块 B1 · 桌台动作（docs/DINING_V8115.md 第 2 节）：
//   · 桌台状态：可用 / 待清台 / 维修中。结账以后先「待清台」（餐饮规则 clearAfterCheckout，默认开），点「清台」回到可用；
//     维修要原因与预计恢复时间，维修中、待清台的桌不能开台、不能换过去；「恢复」回到可用；
//   · 并台：主台与附台都在用餐中，附台的开台指向主台（table_sessions.merged_into），账单不搬动（明细还在各自的账单上）；
//     结账时主台带着附台一起结（现有的多桌一起结），附台不能单独结；拆台解除并台、各结各的；
//   · 每个动作记一条 table_events（只追加；并台、拆台两张桌各记一条），桌台历史把它与开台、换台、撤台、结账、反结账排在一起。
// 加锁：操作编号的咨询锁 → 桌台（id 升序）→ 开台（id 升序），与开台、换台、桌台结账、反结账同一个顺序（桌台 → 开台），没有反过来的路径。
// 操作编号记在 idempotency_keys（table_state：清台、维修、恢复；table_merge：并台、拆台），同一编号重提返回第一次记下的那条。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_TABLES_PER_CHECKOUT } from '@shared/dining';
import {
  MAX_MAINTENANCE_DAYS,
  MAX_TABLE_ACTION_REASON,
  TABLE_HISTORY_LIMIT,
  type TableActionResult,
  type TableEventKind,
  type TableHistory,
  type TableHistoryEntry,
  type TableHistoryKind,
  type TableState,
} from '@shared/dining-v8115';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { abandonedError } from './frontdesk/common';
import { hashRequest } from '../lib/idempotency';
import { currentStoreId } from '../lib/store-context';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { businessDate } from './frontdesk/common';
import { loadDiningRules } from './dining';

// ───────────────────────── 给 tables.ts 用的核对与加锁 ─────────────────────────

/** 开台、换过去之前：维修中、待清台的桌不能用 */
export function assertTableUsable(t: { name: string; state: TableState; maintenanceReason: string | null }, what: '开台' | '换台') {
  if (t.state === 'maintenance') {
    throw conflict('TABLE_MAINTENANCE', `桌台「${t.name}」在维修（${t.maintenanceReason ?? ''}），不能${what}；修好了先点「恢复」`);
  }
  if (t.state === 'dirty') throw conflict('TABLE_DIRTY', `桌台「${t.name}」待清台，请先清台再${what}`);
}

/**
 * 桌台（id 升序）：先不加锁地看这几次开台此刻在哪几张桌上，锁住那几张桌；返回看到的「开台 → 桌台」。
 * 调用方接着锁开台（id 升序），再用 assertSessionsStayed 核对没在这之间被转走
 */
export async function lockTablesOfSessions(tx: Tx, sessionIds: number[]): Promise<Map<number, number>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx<{ id: number; tableId: number }[]>`SELECT id, table_id FROM table_sessions WHERE id IN ${tx(ids)} AND store_id = ${currentStoreId()}`;
  const tableIds = [...new Set(rows.map((r) => r.tableId))].sort((a, b) => a - b);
  if (tableIds.length) await tx`SELECT id FROM dining_tables WHERE id IN ${tx(tableIds)} ORDER BY id FOR UPDATE`;
  return new Map(rows.map((r) => [r.id, r.tableId]));
}

export function assertSessionsStayed(seen: Map<number, number>, locked: Iterable<{ id: number; tableId: number }>) {
  for (const s of locked) if (seen.get(s.id) !== s.tableId) throw conflict('SESSION_CHANGED', '这桌刚刚被其他终端转台了，请刷新后重试');
}

/**
 * 结账的几桌要把并台的一组都带上：附台不能单独结，主台带着附台一起结（调用前已锁好这几次开台）。
 * 主台的附台在锁住主台以后读：并台、拆台都要锁主台，这之后不会再变
 */
export async function assertMergeGroupsComplete(tx: Tx, locked: { id: number; mergedInto: number | null }[]) {
  const ids = new Set(locked.map((s) => s.id));
  for (const s of locked) {
    if (s.mergedInto === null || ids.has(s.mergedInto)) continue;
    const [main] = await tx<{ tableName: string; status: string }[]>`
      SELECT t.name AS table_name, s.status FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id WHERE s.id = ${s.mergedInto}`;
    // 主台已经结束（不该出现）：这桌照常单独结
    if (main?.status === 'open') throw conflict('TABLE_MERGED', `这桌并入了桌 ${main.tableName}，附台不能单独结：请在桌 ${main.tableName} 结账（会一起结），或先拆台`);
  }
  if (ids.size === 0) return;
  const subs = await tx<{ id: number; tableName: string }[]>`
    SELECT s.id, t.name AS table_name FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id
    WHERE s.merged_into IN ${tx([...ids])} AND s.status = 'open' ORDER BY t.name`;
  const missing = subs.filter((x) => !ids.has(x.id));
  if (missing.length) throw conflict('TABLE_MERGED', `主台并着桌 ${missing.map((x) => x.tableName).join('、')}，要一起结：结账时一起勾上，或先拆台`);
}

/** 撤台之前：并着别的桌、并入了别的桌的先拆台（调用前已锁好这次开台） */
export async function assertNotMerged(tx: Tx, s: { id: number; mergedInto: number | null }) {
  if (s.mergedInto !== null) throw conflict('TABLE_MERGED', '这桌并入了别的桌，请先拆台再撤台');
  const [sub] = await tx<{ id: number }[]>`SELECT id FROM table_sessions WHERE merged_into = ${s.id} AND status = 'open' LIMIT 1`;
  if (sub) throw conflict('TABLE_MERGED', '这桌并着别的桌，请先拆台再撤台');
}

/** 结账前核对（只读）：把并台的一组都带上——选了主台带上附台，选了附台带上主台与主台的其他附台 */
export async function withMergeGroups(db: Db, sessionIds: number[]): Promise<number[]> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return ids;
  const mains = await db<{ main: number }[]>`
    SELECT CASE WHEN m.status = 'open' THEN m.id ELSE s.id END AS main
    FROM table_sessions s LEFT JOIN table_sessions m ON m.id = s.merged_into
    WHERE s.id IN ${db(ids)} AND s.store_id = ${currentStoreId()}`;
  const mainIds = [...new Set(mains.map((r) => r.main))];
  if (mainIds.length === 0) return ids;
  const group = await db<{ id: number }[]>`
    SELECT id FROM table_sessions WHERE id IN ${db(mainIds)} OR (merged_into IN ${db(mainIds)} AND status = 'open') ORDER BY id`;
  return [...new Set([...ids, ...group.map((r) => r.id)])];
}

/** 并台信息（桌台详情）：这桌并入了哪桌；并着哪几桌 */
export async function mergeInfoOf(db: Db, sessionId: number, mergedInto: number | null) {
  const [main] =
    mergedInto === null
      ? []
      : await db<{ sessionId: number; tableName: string }[]>`
          SELECT s.id AS session_id, t.name AS table_name FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id
          WHERE s.id = ${mergedInto} AND s.status = 'open'`;
  const merged = await db<{ sessionId: number; tableName: string; amount: number }[]>`
    SELECT s.id AS session_id, t.name AS table_name, b.amount_cents AS amount
    FROM table_sessions s JOIN dining_tables t ON t.id = s.table_id JOIN bills b ON b.id = s.bill_id
    WHERE s.merged_into = ${sessionId} AND s.status = 'open' ORDER BY t.sort_order, t.id`;
  return { mergedInto: main ?? null, merged };
}

/** 结账以后桌台先待清台（餐饮规则 clearAfterCheckout，默认开）：调用前已锁好这几张桌；维修中的不动 */
export async function markTablesDirty(tx: Tx, tableIds: number[], at: Date) {
  if (tableIds.length === 0 || !(await loadDiningRules(tx)).clearAfterCheckout) return;
  await tx`UPDATE dining_tables SET state = 'dirty', state_since = ${at}, updated_at = now() WHERE id IN ${tx(tableIds)} AND state = 'available'`;
}

// ───────────────────────── 操作编号 ─────────────────────────

type TableOp = 'table_state' | 'table_merge';

const replayOf = async (db: Db, key: string, opType: TableOp, requestHash: string): Promise<number | null> => {
  const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${key}`;
  if (!row) return null;
  if (row.opType !== opType || row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的业务，请刷新页面后重新发起');
  return row.refId;
};

/**
 * 桌台动作的幂等外壳：先取操作编号的咨询锁（同一编号的两次提交排队），编号已有结果的照原样返回第一次记下的那条，
 * 否则做这一笔、最后写编号（ref_id 是这一笔记下的第一条 table_events）
 */
async function runTableOp(deps: Deps, ctx: OpContext, opts: { key: string; opType: TableOp; requestHash: string }, body: (tx: Tx, at: Date) => Promise<number>) {
  const at = ctx.at ?? new Date();
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 先取编号的咨询锁并核对没被确认作废（与登记作废串行）：作废过的编号原请求再到也整笔不做（Codex 审查 9ef9424）
      await assertNotFenced(tx, opts.key, opts.opType, abandonedError);
      const seen = await replayOf(tx, opts.key, opts.opType, opts.requestHash);
      if (seen !== null) return { eventId: seen, replayed: true };
      const eventId = await body(tx, at);
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${opts.key}, ${opts.opType}, ${opts.requestHash}, ${eventId}, ${ctx.actor.id})`;
      return { eventId, replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey')) {
      const seen = await replayOf(deps.sql, opts.key, opts.opType, opts.requestHash);
      if (seen !== null) return { eventId: seen, replayed: true };
    }
    throw error;
  }
}

/** 「结果待确认」按编号查回（frontdesk/visits.ts 的 lookupFrontdeskOp）：编号记下的那一条桌台记录 */
export const tableActionOf = (db: Db, eventId: number) => actionResult(db, { eventId, replayed: true });

async function actionResult(db: Db, run: { eventId: number; replayed: boolean }): Promise<TableActionResult> {
  const [e] = await db<{ id: number; tableId: number; kind: TableEventKind; createdAt: string }[]>`SELECT id, table_id, kind, created_at FROM table_events WHERE id = ${run.eventId}`;
  if (!e) throw notFound('这条桌台记录不存在');
  return { eventId: e.id, tableId: e.tableId, kind: e.kind, at: new Date(e.createdAt).toISOString(), replayed: run.replayed };
}

interface EventRow {
  tableId: number;
  kind: TableEventKind;
  sessionId?: number;
  otherTableId?: number;
  otherSessionId?: number;
  role?: 'main' | 'sub';
  reason?: string;
  expectedBackAt?: Date;
}

async function insertEvent(tx: Tx, e: EventRow, meta: { key: string; actorId: number; date: string; at: Date }): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO table_events (table_id, kind, session_id, other_table_id, other_session_id, role, reason, expected_back_at, op_key, operator_id, business_date, created_at)
    VALUES (${e.tableId}, ${e.kind}, ${e.sessionId ?? null}, ${e.otherTableId ?? null}, ${e.otherSessionId ?? null}, ${e.role ?? null}, ${e.reason ?? ''},
            ${e.expectedBackAt ?? null}, ${meta.key}, ${meta.actorId}, ${meta.date}, ${meta.at})
    RETURNING id`;
  return row!.id;
}

// ───────────────────────── 清台、维修、恢复 ─────────────────────────

interface LockedTable {
  id: number;
  name: string;
  active: boolean;
  state: TableState;
  maintenanceUntil: Date | null;
}

async function lockTable(tx: Tx, tableId: number): Promise<LockedTable> {
  const [t] = await tx<LockedTable[]>`SELECT id, name, active, state, maintenance_until FROM dining_tables WHERE id = ${tableId} AND store_id = ${currentStoreId()} FOR UPDATE`;
  if (!t) throw notFound('桌台不存在，请刷新后重试');
  return t;
}

const KeyInput = z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') });

/** 清台：待清台 → 可用 */
export async function clearTable(deps: Deps, tableId: number, raw: unknown, ctx: OpContext): Promise<TableActionResult> {
  const { clientKey: key } = parse(KeyInput, raw);
  const run = await runTableOp(deps, ctx, { key, opType: 'table_state', requestHash: hashRequest({ action: 'clear', tableId }) }, async (tx, at) => {
    const t = await lockTable(tx, tableId);
    if (t.state !== 'dirty') {
      throw conflict('TABLE_NOT_DIRTY', t.state === 'maintenance' ? `桌台「${t.name}」在维修，不用清台；修好了点「恢复」` : `桌台「${t.name}」已经是可用的，不用清台`);
    }
    await tx`UPDATE dining_tables SET state = 'available', state_since = ${at}, updated_at = now() WHERE id = ${t.id}`;
    const date = await businessDate(tx, deps, at);
    const eventId = await insertEvent(tx, { tableId: t.id, kind: 'clear' }, { key, actorId: ctx.actor.id, date, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'table_clear', targetType: 'dining_table', targetId: t.id, detail: { table: t.name }, ip: ctx.ip, businessDate: date });
    return eventId;
  });
  return actionResult(deps.sql, run);
}

const MaintenanceInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  reason: z.string('请填写维修原因').trim().min(2, '请填写维修原因（至少 2 个字）').max(MAX_TABLE_ACTION_REASON, `原因最多 ${MAX_TABLE_ACTION_REASON} 字`),
  expectedBackAt: z.iso.datetime({ offset: true, message: '请填写预计恢复时间' }),
});

/** 维修：要原因与预计恢复时间；用餐中的桌不能维修（结账或换台后再修） */
export async function maintainTable(deps: Deps, tableId: number, raw: unknown, ctx: OpContext): Promise<TableActionResult> {
  const input = parse(MaintenanceInput, raw);
  const until = new Date(input.expectedBackAt);
  const now = ctx.at ?? new Date();
  if (until.getTime() <= now.getTime()) throw unprocessable('MAINTENANCE_UNTIL', '预计恢复时间要晚于现在');
  if (until.getTime() > now.getTime() + MAX_MAINTENANCE_DAYS * 86_400_000) throw unprocessable('MAINTENANCE_UNTIL', `预计恢复时间最远 ${MAX_MAINTENANCE_DAYS} 天以后`);
  const requestHash = hashRequest({ action: 'maintenance', tableId, reason: input.reason, expectedBackAt: until.toISOString() });
  const run = await runTableOp(deps, ctx, { key: input.clientKey, opType: 'table_state', requestHash }, async (tx, at) => {
    const t = await lockTable(tx, tableId);
    if (!t.active) throw conflict('TABLE_INACTIVE', `桌台「${t.name}」已停用，不用维修`);
    if (t.state === 'maintenance') throw conflict('TABLE_MAINTENANCE', `桌台「${t.name}」已经在维修了`);
    const [busy] = await tx<{ sessionNo: string }[]>`SELECT session_no FROM table_sessions WHERE table_id = ${t.id} AND status = 'open'`;
    if (busy) throw conflict('TABLE_IN_USE', `桌台「${t.name}」正在用餐（${busy.sessionNo}），结账或换台后才能维修`);
    await tx`
      UPDATE dining_tables SET state = 'maintenance', maintenance_reason = ${input.reason}, maintenance_until = ${until}, state_since = ${at}, updated_at = now()
      WHERE id = ${t.id}`;
    const date = await businessDate(tx, deps, at);
    const eventId = await insertEvent(tx, { tableId: t.id, kind: 'maintenance', reason: input.reason, expectedBackAt: until }, { key: input.clientKey, actorId: ctx.actor.id, date, at });
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_maintenance',
      targetType: 'dining_table',
      targetId: t.id,
      detail: { table: t.name, from: t.state, reason: input.reason, expectedBackAt: until.toISOString() },
      ip: ctx.ip,
      businessDate: date,
    });
    return eventId;
  });
  return actionResult(deps.sql, run);
}

/**
 * 恢复：维修中 → 可用。到点自动恢复（8.1.17 BW-2，tables-v8117.ts）走的也是这里（同样的锁与记录，经办人是系统账号「系统」），
 * 另带 dueAt：锁住以后核对预计恢复时间确实到了（挑候选到锁住之间有人恢复后又重新报修、改了预计时间的不动，MAINTENANCE_NOT_DUE）
 */
export async function restoreTable(deps: Deps, tableId: number, raw: unknown, ctx: OpContext, opts: { dueAt?: Date } = {}): Promise<TableActionResult> {
  const { clientKey: key } = parse(KeyInput, raw);
  const run = await runTableOp(deps, ctx, { key, opType: 'table_state', requestHash: hashRequest({ action: 'restore', tableId }) }, async (tx, at) => {
    const t = await lockTable(tx, tableId);
    if (t.state !== 'maintenance') throw conflict('TABLE_NOT_MAINTENANCE', `桌台「${t.name}」没有在维修，不用恢复`);
    if (opts.dueAt && (!t.maintenanceUntil || new Date(t.maintenanceUntil).getTime() > opts.dueAt.getTime())) {
      throw conflict('MAINTENANCE_NOT_DUE', `桌台「${t.name}」还没到预计恢复时间`);
    }
    await tx`UPDATE dining_tables SET state = 'available', maintenance_reason = NULL, maintenance_until = NULL, state_since = ${at}, updated_at = now() WHERE id = ${t.id}`;
    const date = await businessDate(tx, deps, at);
    const eventId = await insertEvent(tx, { tableId: t.id, kind: 'restore' }, { key, actorId: ctx.actor.id, date, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'table_restore', targetType: 'dining_table', targetId: t.id, detail: { table: t.name }, ip: ctx.ip, businessDate: date });
    return eventId;
  });
  return actionResult(deps.sql, run);
}

// ───────────────────────── 并台、拆台 ─────────────────────────

interface LockedSessionRow {
  id: number;
  sessionNo: string;
  tableId: number;
  tableName: string;
  status: string;
  mergedInto: number | null;
}

/** 桌台（id 升序）→ 开台（id 升序），锁住以后核对开台没被转到别的桌 */
async function lockGroup(tx: Tx, ids: number[]): Promise<Map<number, LockedSessionRow>> {
  const seen = await lockTablesOfSessions(tx, ids);
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const rows = await tx<LockedSessionRow[]>`
    SELECT s.id, s.session_no, s.table_id, '' AS table_name, s.status, s.merged_into FROM table_sessions s
    WHERE s.id IN ${tx(unique)} AND s.store_id = ${currentStoreId()} ORDER BY s.id FOR UPDATE`;
  if (rows.length !== unique.length) throw notFound('开台记录不存在，请刷新后重试');
  assertSessionsStayed(seen, rows);
  const names = await tx<{ id: number; name: string }[]>`SELECT id, name FROM dining_tables WHERE id IN ${tx([...new Set(rows.map((r) => r.tableId))])}`;
  for (const r of rows) r.tableName = names.find((n) => n.id === r.tableId)?.name ?? '';
  return new Map(rows.map((r) => [r.id, r]));
}

const assertOpen = (s: LockedSessionRow) => {
  if (s.status !== 'open') throw conflict('TABLE_CLOSED', `桌 ${s.tableName} 的这次开台（${s.sessionNo}）已结束，请刷新后重新选择`);
};

const MergeInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  subSessionIds: z
    .array(z.number().int().positive(), '请选择要并进来的桌')
    .min(1, '请选择要并进来的桌')
    .max(MAX_TABLES_PER_CHECKOUT - 1, `一次最多并 ${MAX_TABLES_PER_CHECKOUT - 1} 桌`),
});

/** 并台：把几桌并到主台（都在用餐中），附台的账单不搬动，结账时主台带着附台一起结 */
export async function mergeTables(deps: Deps, mainId: number, raw: unknown, ctx: OpContext): Promise<TableActionResult> {
  const input = parse(MergeInput, raw);
  const subs = [...new Set(input.subSessionIds)].sort((a, b) => a - b);
  if (subs.length !== input.subSessionIds.length) throw badRequest('同一桌不能选两次');
  if (subs.includes(mainId)) throw badRequest('主台不能并进自己');
  const requestHash = hashRequest({ action: 'merge', mainId, subs });
  const run = await runTableOp(deps, ctx, { key: input.clientKey, opType: 'table_merge', requestHash }, async (tx, at) => {
    const locked = await lockGroup(tx, [mainId, ...subs]);
    const main = locked.get(mainId)!;
    for (const s of locked.values()) assertOpen(s);
    if (main.mergedInto !== null) throw conflict('TABLE_MERGED', `桌 ${main.tableName} 已并入别的桌，不能当主台；请先拆台`);
    for (const id of subs) {
      const s = locked.get(id)!;
      if (s.mergedInto === mainId) throw conflict('TABLE_MERGED', `桌 ${s.tableName} 已经并在桌 ${main.tableName} 了`);
      if (s.mergedInto !== null) throw conflict('TABLE_MERGED', `桌 ${s.tableName} 已并入别的桌，请先拆台`);
      if (s.tableId === main.tableId) throw badRequest('同一张桌不能并台');
    }
    // 附台不能再并着别的桌（一组只有一个主台）
    const [chained] = await tx<{ tableName: string }[]>`
      SELECT t.name AS table_name FROM table_sessions s JOIN table_sessions x ON x.id = s.merged_into JOIN dining_tables t ON t.id = x.table_id
      WHERE s.merged_into IN ${tx(subs)} AND s.status = 'open' LIMIT 1`;
    if (chained) throw conflict('TABLE_MERGED', `桌 ${chained.tableName} 并着别的桌，不能再并进来；请先拆台`);
    const [cnt] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM table_sessions WHERE merged_into = ${mainId} AND status = 'open'`;
    const n = cnt!.n;
    if (n + subs.length + 1 > MAX_TABLES_PER_CHECKOUT) {
      throw conflict('TABLE_MERGE_LIMIT', `一组最多 ${MAX_TABLES_PER_CHECKOUT} 桌（一次最多合并结 ${MAX_TABLES_PER_CHECKOUT} 桌），桌 ${main.tableName} 现在已经并着 ${n} 桌`);
    }
    await tx`UPDATE table_sessions SET merged_into = ${mainId} WHERE id IN ${tx(subs)}`;
    const date = await businessDate(tx, deps, at);
    const meta = { key: input.clientKey, actorId: ctx.actor.id, date, at };
    let first: number | null = null;
    for (const id of subs) {
      const s = locked.get(id)!;
      const e = await insertEvent(tx, { tableId: main.tableId, kind: 'merge', sessionId: main.id, otherTableId: s.tableId, otherSessionId: s.id, role: 'main' }, meta);
      await insertEvent(tx, { tableId: s.tableId, kind: 'merge', sessionId: s.id, otherTableId: main.tableId, otherSessionId: main.id, role: 'sub' }, meta);
      first ??= e;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_merge',
      targetType: 'table_session',
      targetId: main.id,
      detail: { main: main.tableName, sessionNo: main.sessionNo, subs: subs.map((id) => locked.get(id)!.tableName) },
      ip: ctx.ip,
      businessDate: date,
    });
    return first!;
  });
  return actionResult(deps.sql, run);
}

/** 拆台：附台不再并入主台，各结各的 */
export async function splitTable(deps: Deps, subId: number, raw: unknown, ctx: OpContext): Promise<TableActionResult> {
  const { clientKey: key } = parse(KeyInput, raw);
  const run = await runTableOp(deps, ctx, { key, opType: 'table_merge', requestHash: hashRequest({ action: 'split', subId }) }, async (tx, at) => {
    const [peek] = await tx<{ mergedInto: number | null }[]>`SELECT merged_into FROM table_sessions WHERE id = ${subId} AND store_id = ${currentStoreId()}`;
    if (!peek) throw notFound('开台记录不存在，请刷新后重试');
    if (peek.mergedInto === null) throw conflict('TABLE_NOT_MERGED', '这桌没有并到别的桌，不用拆台');
    const mainId = peek.mergedInto;
    const locked = await lockGroup(tx, [subId, mainId]);
    const sub = locked.get(subId)!;
    const main = locked.get(mainId)!;
    assertOpen(sub);
    if (sub.mergedInto !== mainId) throw conflict('SESSION_CHANGED', '这桌的并台刚刚有变化，请刷新后重试');
    await tx`UPDATE table_sessions SET merged_into = NULL WHERE id = ${subId}`;
    const date = await businessDate(tx, deps, at);
    const meta = { key, actorId: ctx.actor.id, date, at };
    const e = await insertEvent(tx, { tableId: main.tableId, kind: 'split', sessionId: main.id, otherTableId: sub.tableId, otherSessionId: sub.id, role: 'main' }, meta);
    await insertEvent(tx, { tableId: sub.tableId, kind: 'split', sessionId: sub.id, otherTableId: main.tableId, otherSessionId: main.id, role: 'sub' }, meta);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'table_split',
      targetType: 'table_session',
      targetId: main.id,
      detail: { main: main.tableName, sessionNo: main.sessionNo, sub: sub.tableName },
      ip: ctx.ip,
      businessDate: date,
    });
    return e;
  });
  return actionResult(deps.sql, run);
}

// ───────────────────────── 桌台历史 ─────────────────────────

/**
 * 一张桌的历史（只读）：table_events 与开台、换台（转入、转出）、撤台、结账、反结账，最近的在前，最多 TABLE_HISTORY_LIMIT 条。
 * 一次开台换过台的，按那一刻在哪张桌算（开台在原来的桌、结账在结账那一刻的桌）
 */
export async function tableHistory(db: Db, tableId: number, timeZone: string): Promise<TableHistory> {
  const [t] = await db<{ id: number; name: string }[]>`SELECT id, name FROM dining_tables WHERE id = ${tableId} AND store_id = ${currentStoreId()}`;
  if (!t) throw notFound('桌台不存在');
  const when = (d: string | Date) => new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d));
  const entries: (TableHistoryEntry & { order: number })[] = [];
  const add = (kind: TableHistoryKind, at: string | Date, operatorName: string, text: string, sessionNo: string | null, order: number) =>
    entries.push({ kind, at: new Date(at).toISOString(), operatorName, text, sessionNo, order });

  const events = await db<
    {
      id: number;
      kind: TableEventKind;
      createdAt: string;
      operatorName: string;
      reason: string;
      expectedBackAt: string | null;
      role: 'main' | 'sub' | null;
      otherTable: string | null;
      sessionNo: string | null;
    }[]
  >`
    SELECT e.id, e.kind, e.created_at, st.display_name AS operator_name, e.reason, e.expected_back_at, e.role, ot.name AS other_table, s.session_no
    FROM table_events e JOIN staff st ON st.id = e.operator_id
    LEFT JOIN dining_tables ot ON ot.id = e.other_table_id LEFT JOIN table_sessions s ON s.id = e.session_id
    WHERE e.table_id = ${tableId} ORDER BY e.id DESC LIMIT ${TABLE_HISTORY_LIMIT + 1}`;
  for (const e of events) {
    const text =
      e.kind === 'merge'
        ? e.role === 'main'
          ? `桌 ${e.otherTable} 并入这桌，结账时一起结`
          : `并入桌 ${e.otherTable}，结账时随桌 ${e.otherTable} 一起结`
        : e.kind === 'split'
          ? e.role === 'main'
            ? `桌 ${e.otherTable} 拆出去，各结各的`
            : `从桌 ${e.otherTable} 拆出来，各结各的`
          : e.kind === 'maintenance'
            ? `${e.reason}${e.expectedBackAt ? ` · 预计 ${when(e.expectedBackAt)} 恢复` : ''}`
            : e.kind === 'clear'
              ? '清台，回到可用'
              : '恢复可用';
    add(e.kind, e.createdAt, e.operatorName, text, e.sessionNo, 1);
  }

  // 在这张桌上开过、换来换去经过这张桌的开台（最近的 TABLE_HISTORY_LIMIT 次）
  const sessions = await db<
    {
      id: number;
      sessionNo: string;
      tableId: number;
      guests: number;
      guest: string;
      status: string;
      openedAt: string;
      openedByName: string;
      closedAt: string | null;
      closedByName: string | null;
      closeReason: string | null;
    }[]
  >`
    SELECT s.id, s.session_no, s.table_id, s.guests, coalesce(m.name, nullif(s.guest_label, ''), '散客') AS guest, s.status, s.opened_at,
           os.display_name AS opened_by_name, s.closed_at, cs.display_name AS closed_by_name, s.close_reason
    FROM table_sessions s JOIN staff os ON os.id = s.opened_by LEFT JOIN staff cs ON cs.id = s.closed_by LEFT JOIN members m ON m.id = s.member_id
    WHERE s.store_id = ${currentStoreId()}
      AND (s.table_id = ${tableId} OR s.id IN (SELECT session_id FROM table_session_moves WHERE from_table_id = ${tableId} OR to_table_id = ${tableId}))
    ORDER BY s.opened_at DESC, s.id DESC LIMIT ${TABLE_HISTORY_LIMIT}`;
  const ids = sessions.map((s) => s.id);
  const moves = ids.length
    ? await db<{ sessionId: number; fromTableId: number; toTableId: number; fromName: string; toName: string; reason: string; operatorName: string; createdAt: string }[]>`
        SELECT mv.session_id, mv.from_table_id, mv.to_table_id, ft.name AS from_name, tt.name AS to_name, mv.reason, st.display_name AS operator_name, mv.created_at
        FROM table_session_moves mv JOIN dining_tables ft ON ft.id = mv.from_table_id JOIN dining_tables tt ON tt.id = mv.to_table_id JOIN staff st ON st.id = mv.operator_id
        WHERE mv.session_id IN ${db(ids)} ORDER BY mv.id`
    : [];
  const checkouts = ids.length
    ? await db<{ sessionId: number; checkoutNo: string; createdAt: string; operatorName: string; voidedAt: string | null; voidedByName: string | null; voidReason: string | null }[]>`
        SELECT cb.table_session_id AS session_id, c.checkout_no, c.created_at, op.display_name AS operator_name, c.voided_at, vs.display_name AS voided_by_name, c.void_reason
        FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id JOIN staff op ON op.id = c.operator_id LEFT JOIN staff vs ON vs.id = c.voided_by
        WHERE cb.table_session_id IN ${db(ids)} ORDER BY c.id`
    : [];
  for (const s of sessions) {
    const mine = moves.filter((m) => m.sessionId === s.id);
    const first = mine[0]?.fromTableId ?? s.tableId;
    // 某一刻这次开台在哪张桌：从开台的桌起，按换台记录一步步走到那一刻
    const tableAt = (at: string | Date) => mine.filter((m) => new Date(m.createdAt).getTime() <= new Date(at).getTime()).reduce((_, m) => m.toTableId, first);
    if (first === tableId) add('open', s.openedAt, s.openedByName, `${s.guests} 人 · ${s.guest}`, s.sessionNo, 0);
    for (const m of mine) {
      if (m.fromTableId === tableId) add('move_out', m.createdAt, m.operatorName, `换到桌 ${m.toName}：${m.reason}`, s.sessionNo, 2);
      if (m.toTableId === tableId) add('move_in', m.createdAt, m.operatorName, `从桌 ${m.fromName} 换来：${m.reason}`, s.sessionNo, 3);
    }
    if (s.status === 'cancelled' && s.closedAt && tableAt(s.closedAt) === tableId) add('cancel', s.closedAt, s.closedByName ?? '', `撤台：${s.closeReason ?? ''}`, s.sessionNo, 4);
    for (const c of checkouts.filter((x) => x.sessionId === s.id)) {
      if (tableAt(c.createdAt) === tableId) add('checkout', c.createdAt, c.operatorName, `结账单 ${c.checkoutNo}`, s.sessionNo, 5);
      if (c.voidedAt && tableAt(c.voidedAt) === tableId) add('checkout_void', c.voidedAt, c.voidedByName ?? '', `反结账 ${c.checkoutNo}：${c.voidReason ?? ''}`, s.sessionNo, 6);
    }
  }
  entries.sort((a, b) => b.at.localeCompare(a.at) || b.order - a.order);
  const truncated = entries.length > TABLE_HISTORY_LIMIT || events.length > TABLE_HISTORY_LIMIT || sessions.length >= TABLE_HISTORY_LIMIT;
  return { tableId: t.id, tableName: t.name, entries: entries.slice(0, TABLE_HISTORY_LIMIT).map(({ order: _o, ...e }) => e), limit: TABLE_HISTORY_LIMIT, truncated };
}

// ───────────────────────── 路由 ─────────────────────────

export function registerTablesV8115Routes(app: FastifyInstance, deps: Deps) {
  // 与开台、换台、撤台同一组权限：点单 + 前台挂账（这几样都动桌台、动开台）
  const orderGuard = guard('dining.order', 'frontdesk.operate');
  const id = (req: { params: unknown }) => parse(idParam, req.params).id;
  app.post('/api/dining/tables/:id/clear', { preHandler: orderGuard }, async (req) => clearTable(deps, id(req), req.body, ctxOf(req)));
  app.post('/api/dining/tables/:id/maintenance', { preHandler: orderGuard }, async (req) => maintainTable(deps, id(req), req.body, ctxOf(req)));
  app.post('/api/dining/tables/:id/restore', { preHandler: orderGuard }, async (req) => restoreTable(deps, id(req), req.body, ctxOf(req)));
  app.post('/api/dining/tables/sessions/:id/merge', { preHandler: orderGuard }, async (req) => mergeTables(deps, id(req), req.body, ctxOf(req)));
  app.post('/api/dining/tables/sessions/:id/split', { preHandler: orderGuard }, async (req) => splitTable(deps, id(req), req.body, ctxOf(req)));
  // 桌台历史：看得到桌台详情的就能看（点单的、结账的）
  app.get('/api/dining/tables/:id/history', { preHandler: guardAny('dining.order', 'frontdesk.checkout') }, async (req) => tableHistory(deps.sql, id(req), deps.config.timezone));
}
