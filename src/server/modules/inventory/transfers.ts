// 门店间调拨（8.0.22，docs/MULTISTORE_V8022.md 第 8 节，MD-B）。
//   · 调出：调出仓扣减、记在途（一张已生效的「调拨调出」单据，流水 transfer_out）；
//   · 调入：调入仓按实收入库（「调拨调入」单据，流水 transfer_in），短少、损坏的写原因；差的数量是在途损耗，不再回到哪个仓；
//   · 撤回：在途的整单撤回，原数退回调出仓（也是一张「调拨调入」单据，进调出仓）。
//   · 成本：移动加权平均全公司一个（MD15），调拨按当时的平均成本出入，不改平均成本。
// 锁：新建先取操作编号的咨询锁（与「确认作废」串行）→ 物料（id 升序）→ 两个仓（门店 / 部门一行共享锁）；
//     调入、撤回：调拨单一行 → 物料（id 升序）→ 仓，与别的库存单据同一套（物料行锁串行所有仓的收发）。
// 操作编号：新建记在 idempotency_keys（op_type stock_transfer，ref_id 是那张调拨单），查回、确认作废走全店那一套。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StockTransfer, StockTransferLine } from '@shared/inventory';
import { formatQty } from '@shared/quantity';
import type { Db, Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../../lib/tx';
import { idParam, parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';
import { allowedStores } from '../stores';
import { applyMove, lockDeptWarehouse, lockMaterials, warehouseInfo, type LockedMaterial } from './common';

const LineInput = z.object({ materialId: z.number().int().positive(), qtyMilli: z.number().int().positive().max(1_000_000_000) });
const CreateInput = z.object({
  clientKey: z.uuid('操作编号格式不正确'),
  fromWarehouseId: z.number().int().positive(),
  toWarehouseId: z.number().int().positive(),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
  lines: z.array(LineInput).min(1, '至少调一样物料').max(100, '一张调拨单最多 100 样物料'),
});
const ReceiveInput = z.object({
  expectedVersion: z.number().int().positive(),
  lines: z
    .array(
      z.object({
        materialId: z.number().int().positive(),
        receivedMilli: z.number().int().min(0),
        varianceReason: z.string().trim().max(200, '原因最多 200 字').default(''),
      }),
    )
    .min(1),
});
const CancelInput = z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(2, '撤回原因至少 2 个字').max(200) });
const ListQuery = z.object({ status: z.enum(['in_transit', 'received', 'cancelled']).optional() });

type Row = Omit<StockTransfer, 'lines'>;

async function readTransfers(db: Db, where: { id?: number; status?: string }): Promise<StockTransfer[]> {
  const rows = await db<Row[]>`
    SELECT t.id, t.transfer_no, t.from_warehouse_id, t.to_warehouse_id, t.status, t.note, t.out_doc_id, t.in_doc_id,
           sb.display_name AS sent_by_name, t.sent_at, rb.display_name AS received_by_name, t.received_at,
           cb.display_name AS cancelled_by_name, t.cancelled_at, t.cancel_reason, t.version, '' AS from_name, '' AS to_name
    FROM stock_transfers t JOIN staff sb ON sb.id = t.sent_by LEFT JOIN staff rb ON rb.id = t.received_by LEFT JOIN staff cb ON cb.id = t.cancelled_by
    WHERE ${where.id !== undefined ? db`t.id = ${where.id}` : db`true`} AND ${where.status ? db`t.status = ${where.status}` : db`true`}
    ORDER BY t.id DESC LIMIT 200`;
  if (rows.length === 0) return [];
  const lines = await db<(StockTransferLine & { transferId: number })[]>`
    SELECT l.transfer_id, l.material_id, m.code, m.name, m.inventory_unit, m.decimals, l.qty_milli, l.received_milli, l.variance_reason
    FROM stock_transfer_lines l JOIN materials m ON m.id = l.material_id
    WHERE l.transfer_id IN ${db(rows.map((r) => Number(r.id)))} ORDER BY l.id`;
  const names = new Map<number, string>();
  for (const id of new Set(rows.flatMap((r) => [Number(r.fromWarehouseId), Number(r.toWarehouseId)]))) names.set(id, (await warehouseInfo(db, id))?.name ?? `仓库 ${id}`);
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    fromWarehouseId: Number(r.fromWarehouseId),
    toWarehouseId: Number(r.toWarehouseId),
    fromName: names.get(Number(r.fromWarehouseId))!,
    toName: names.get(Number(r.toWarehouseId))!,
    outDocId: Number(r.outDocId),
    inDocId: r.inDocId === null ? null : Number(r.inDocId),
    sentAt: new Date(r.sentAt).toISOString(),
    receivedAt: r.receivedAt ? new Date(r.receivedAt).toISOString() : null,
    cancelledAt: r.cancelledAt ? new Date(r.cancelledAt).toISOString() : null,
    lines: lines
      .filter((l) => Number(l.transferId) === Number(r.id))
      .map(({ transferId: _t, ...l }) => ({
        ...l,
        materialId: Number(l.materialId),
        qtyMilli: Number(l.qtyMilli),
        receivedMilli: l.receivedMilli === null ? null : Number(l.receivedMilli),
      })),
  }));
}

export async function getTransfer(db: Db, id: number): Promise<StockTransfer> {
  const [t] = await readTransfers(db, { id });
  if (!t) throw notFound('调拨单不存在');
  return t;
}

export const listTransfers = (db: Db, status?: string) => readTransfers(db, { status });

/** 一张已生效的调出 / 调入单据（一建就生效，不走审批），每行按调拨的数量记流水 */
async function postDoc(
  tx: Tx,
  kind: 'transfer_out' | 'transfer_in',
  warehouseId: number,
  date: string,
  note: string,
  lines: { m: LockedMaterial; qtyMilli: number }[],
  actor: Actor,
): Promise<number> {
  const docNo = await nextDocNo(tx, `inv_${kind}`, kind === 'transfer_out' ? 'DC' : 'DR', date);
  const [doc] = await tx<{ id: number }[]>`
    INSERT INTO inv_docs (doc_no, doc_type, status, doc_date, warehouse_id, note, created_by, confirmed_by, confirmed_at)
    VALUES (${docNo}, ${kind}, 'confirmed', ${date}, ${warehouseId}, ${note}, ${actor.id}, ${actor.id}, now())
    RETURNING id`;
  const name = (await warehouseInfo(tx, warehouseId))?.name;
  let no = 0;
  for (const l of lines) {
    if (l.qtyMilli <= 0) continue;
    no += 1;
    const [line] = await tx<{ id: number }[]>`
      INSERT INTO inv_doc_lines (doc_id, line_no, material_id, qty_milli, inventory_unit, purchase_unit, factor_milli)
      VALUES (${doc!.id}, ${no}, ${l.m.id}, ${l.qtyMilli}, ${l.m.inventoryUnit}, ${l.m.inventoryUnit}, 1000)
      RETURNING id`;
    await applyMove(tx, l.m, kind === 'transfer_out' ? -l.qtyMilli : l.qtyMilli, {
      moveType: kind,
      docId: Number(doc!.id),
      lineId: Number(line!.id),
      docDate: date,
      operatorId: actor.id,
      warehouseId,
      warehouseName: name,
    });
  }
  return Number(doc!.id);
}

/** 两个仓按 id 升序加共享锁、确认门店 / 部门都在用 */
async function lockWarehouses(tx: Tx, ids: number[]) {
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) await lockDeptWarehouse(tx, id);
}

export async function createTransfer(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ transfer: StockTransfer; replayed: boolean }> {
  const input = parse(CreateInput, raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  if (input.fromWarehouseId === input.toWarehouseId) throw badRequest('调出仓与调入仓不能是同一个');
  const ids = input.lines.map((l) => l.materialId);
  if (new Set(ids).size !== ids.length) throw badRequest('同一样物料只能写一行');
  const date = todayIn(deps.config.timezone);
  const mine = new Set((await allowedStores(deps.sql, actor)).map((s) => Number(s.id)));
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, input.clientKey);
    const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (seen) {
      if (seen.opType !== 'stock_transfer' || seen.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一张调拨单，请刷新页面后重新填写');
      return { id: Number(seen.refId), replayed: true };
    }
    await assertNotFenced(tx, input.clientKey, 'stock_transfer', erpOpAbandoned);
    const whs = await tx<{ id: number; storeId: number }[]>`SELECT id, store_id FROM warehouses WHERE id IN ${tx([input.fromWarehouseId, input.toWarehouseId])}`;
    const from = whs.find((w) => Number(w.id) === input.fromWarehouseId);
    const to = whs.find((w) => Number(w.id) === input.toWarehouseId);
    if (!from || !to) throw unprocessable('WAREHOUSE_NOT_FOUND', '仓库不存在，请刷新后重试');
    if (Number(from.storeId) === Number(to.storeId)) throw unprocessable('SAME_STORE', '同一家店里的仓之间请用领料、退回；调拨是门店之间的');
    if (!mine.has(Number(from.storeId))) throw unprocessable('STORE_NOT_ALLOWED', '只能从你能进的门店的仓调出');
    const mats = await lockMaterials(tx, ids);
    for (const m of mats.values()) {
      if (!m.active) throw unprocessable('MATERIAL_INACTIVE', `「${m.name}」已停用，不能调拨`);
      if (!m.tracked) throw unprocessable('MATERIAL_UNTRACKED', `「${m.name}」不记库存，不能调拨`);
    }
    await lockWarehouses(tx, [input.fromWarehouseId, input.toWarehouseId]);
    const transferNo = await nextDocNo(tx, 'stock_transfer', 'DB', date);
    const outDocId = await postDoc(tx, 'transfer_out', input.fromWarehouseId, date, `调拨 ${transferNo} 调出${input.note ? `：${input.note}` : ''}`,
      input.lines.map((l) => ({ m: mats.get(l.materialId)!, qtyMilli: l.qtyMilli })), actor);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO stock_transfers (transfer_no, from_warehouse_id, to_warehouse_id, note, out_doc_id, sent_by)
      VALUES (${transferNo}, ${input.fromWarehouseId}, ${input.toWarehouseId}, ${input.note}, ${outDocId}, ${actor.id}) RETURNING id`;
    for (const l of input.lines) {
      await tx`INSERT INTO stock_transfer_lines (transfer_id, material_id, qty_milli) VALUES (${row!.id}, ${l.materialId}, ${l.qtyMilli})`;
    }
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'stock_transfer', ${requestHash}, ${row!.id}, ${actor.id})`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'stock_transfer',
      targetType: 'stock_transfer',
      targetId: Number(row!.id),
      detail: {
        transferNo,
        step: 'send',
        from: input.fromWarehouseId,
        to: input.toWarehouseId,
        lines: input.lines.map((l) => `${mats.get(l.materialId)!.name} ${formatQty(l.qtyMilli)}`),
      },
      ip,
    });
    return { id: Number(row!.id), replayed: false };
  });
  return { transfer: await getTransfer(deps.sql, r.id), replayed: r.replayed };
}

async function lockTransfer(tx: Tx, id: number, expectedVersion: number) {
  const [t] = await tx<{ id: number; transferNo: string; status: string; version: number; fromWarehouseId: number; toWarehouseId: number }[]>`
    SELECT id, transfer_no, status, version, from_warehouse_id, to_warehouse_id FROM stock_transfers WHERE id = ${id} FOR UPDATE`;
  if (!t) throw notFound('调拨单不存在');
  if (t.status !== 'in_transit') throw conflict('TRANSFER_CLOSED', `调拨单 ${t.transferNo} 已${t.status === 'received' ? '调入' : '撤回'}，请刷新`);
  if (t.version !== expectedVersion) throw conflict('TRANSFER_CHANGED', `调拨单 ${t.transferNo} 刚刚被别人处理过，请刷新后再看`);
  const lines = await tx<{ materialId: number; qtyMilli: number }[]>`SELECT material_id, qty_milli FROM stock_transfer_lines WHERE transfer_id = ${id} ORDER BY id`;
  return { ...t, fromWarehouseId: Number(t.fromWarehouseId), toWarehouseId: Number(t.toWarehouseId), lines: lines.map((l) => ({ materialId: Number(l.materialId), qtyMilli: Number(l.qtyMilli) })) };
}

/** 调入：按实收入库；少了的写原因（在途损耗，不回到哪个仓） */
export async function receiveTransfer(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<StockTransfer> {
  const input = parse(ReceiveInput, raw);
  const date = todayIn(deps.config.timezone);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const t = await lockTransfer(tx, id, input.expectedVersion);
    const got = new Map(input.lines.map((l) => [l.materialId, l]));
    if (got.size !== t.lines.length || t.lines.some((l) => !got.has(l.materialId))) throw badRequest('实收要按调拨单上的每一样物料填写');
    for (const l of t.lines) {
      const g = got.get(l.materialId)!;
      if (g.receivedMilli > l.qtyMilli) throw unprocessable('RECEIVED_OVER', '实收不能多于调出的数量；多出来的另开调拨单或盘点');
      if (g.receivedMilli < l.qtyMilli && g.varianceReason.length < 2) throw unprocessable('VARIANCE_REASON', '实收少于调出的，请写原因（短少、损坏……）');
    }
    const mats = await lockMaterials(tx, t.lines.map((l) => l.materialId));
    await lockWarehouses(tx, [t.toWarehouseId]);
    const inDocId = await postDoc(tx, 'transfer_in', t.toWarehouseId, date, `调拨 ${t.transferNo} 调入`,
      t.lines.map((l) => ({ m: mats.get(l.materialId)!, qtyMilli: got.get(l.materialId)!.receivedMilli })), actor);
    for (const l of t.lines) {
      const g = got.get(l.materialId)!;
      await tx`
        UPDATE stock_transfer_lines SET received_milli = ${g.receivedMilli}, variance_reason = ${g.receivedMilli < l.qtyMilli ? g.varianceReason : null}
        WHERE transfer_id = ${id} AND material_id = ${l.materialId}`;
    }
    await tx`
      UPDATE stock_transfers SET status = 'received', in_doc_id = ${inDocId}, received_by = ${actor.id}, received_at = now(), version = version + 1
      WHERE id = ${id}`;
    const short = t.lines.filter((l) => got.get(l.materialId)!.receivedMilli < l.qtyMilli);
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'stock_transfer',
      targetType: 'stock_transfer',
      targetId: id,
      detail: { transferNo: t.transferNo, step: 'receive', short: short.map((l) => `${mats.get(l.materialId)!.name} 少 ${formatQty(l.qtyMilli - got.get(l.materialId)!.receivedMilli)}：${got.get(l.materialId)!.varianceReason}`) },
      ip,
    });
  });
  return getTransfer(deps.sql, id);
}

/** 撤回在途的调拨单：原数退回调出仓 */
export async function cancelTransfer(deps: Deps, id: number, raw: unknown, actor: Actor, ip?: string): Promise<StockTransfer> {
  const input = parse(CancelInput, raw);
  const date = todayIn(deps.config.timezone);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const t = await lockTransfer(tx, id, input.expectedVersion);
    const mats = await lockMaterials(tx, t.lines.map((l) => l.materialId));
    await lockWarehouses(tx, [t.fromWarehouseId]);
    const inDocId = await postDoc(tx, 'transfer_in', t.fromWarehouseId, date, `撤回调拨 ${t.transferNo}：${input.reason}`,
      t.lines.map((l) => ({ m: mats.get(l.materialId)!, qtyMilli: l.qtyMilli })), actor);
    await tx`
      UPDATE stock_transfers SET status = 'cancelled', in_doc_id = ${inDocId}, cancelled_by = ${actor.id}, cancelled_at = now(), cancel_reason = ${input.reason},
             version = version + 1
      WHERE id = ${id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'stock_transfer', targetType: 'stock_transfer', targetId: id, detail: { transferNo: t.transferNo, step: 'cancel', reason: input.reason }, ip });
  });
  return getTransfer(deps.sql, id);
}

export function registerTransferRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/inventory/transfers', { preHandler: guard('inventory.read') }, async (req) => listTransfers(sql, parse(ListQuery, req.query ?? {}).status));
  app.get('/api/inventory/transfers/:id', { preHandler: guard('inventory.read') }, async (req) => getTransfer(sql, parse(idParam, req.params).id));
  app.post('/api/inventory/transfers', { preHandler: guard('inventory.operate') }, async (req, reply) => {
    const r = await createTransfer(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r.transfer;
  });
  app.post('/api/inventory/transfers/:id/receive', { preHandler: guard('inventory.operate') }, async (req) =>
    receiveTransfer(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip),
  );
  app.post('/api/inventory/transfers/:id/cancel', { preHandler: guard('inventory.operate') }, async (req) =>
    cancelTransfer(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip),
  );
}
