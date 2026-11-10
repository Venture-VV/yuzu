// 赠品入库台账（8.0.1 采购组整改 09，CG09，docs/PURCHASING_V801.md）：「库存 → 赠品台账」。
// 登记赠品名称（可以从物料里选）、数量与单位、哪家供应商、随哪张收货单（选填）、日期、备注；可以作废（写原因），可以导出 CSV。
// 只记台账，不进库存结存、不记成本（要不要进库存以后再定）。仓库（物资经办）、采购登记；有查看库存的人都能看。
// 加锁：登记先取操作编号的咨询锁（与「确认作废」串行），写新行（不锁物料、供应商、收货单）；作废只锁那一条。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GiftReceipt } from '@shared/inventory';
import { formatQty } from '@shared/quantity';
import type { Db } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { csvReply, toCsv } from '../../lib/csv';
import { checkDateRange, todayIn } from '../../lib/dates';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../../lib/tx';
import { dateSchema, idParam, parse } from '../../lib/validate';
import { erpOpAbandoned } from '../erp-ops';

const id = z.number().int().positive();
const GiftInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  receivedOn: dateSchema('收到日期'),
  materialId: id.nullable().default(null),
  name: z.string().trim().min(1, '请写赠品名称').max(40, '赠品名称最多 40 个字'),
  qtyMilli: z.number().int().positive('数量要大于 0').max(1_000_000_000),
  unit: z.string().trim().min(1, '请写单位').max(8, '单位最多 8 个字'),
  supplierId: id.nullable().default(null),
  receiptDocId: id.nullable().default(null),
  note: z.string().trim().max(200, '备注最多 200 个字').default(''),
});
const VoidInput = z.object({ reason: z.string().trim().min(2, '请写作废原因（至少 2 个字）').max(200) });
const ListQuery = z.object({ from: dateSchema('开始日期').optional(), to: dateSchema('结束日期').optional(), q: z.string().trim().max(40).optional() });

const SELECT = (db: Db) => db`
  SELECT g.id, g.doc_no, g.received_on, g.name, g.qty_milli, g.unit, g.note, g.status, g.created_at, g.void_reason, g.voided_at,
         cb.display_name AS created_by_name, vb.display_name AS voided_by_name,
         CASE WHEN m.id IS NULL THEN NULL ELSE json_build_object('id', m.id, 'code', m.code, 'name', m.name) END AS material,
         CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('id', s.id, 'name', s.name) END AS supplier,
         CASE WHEN d.id IS NULL THEN NULL ELSE json_build_object('id', d.id, 'docNo', d.doc_no) END AS receipt
  FROM gift_receipts g JOIN staff cb ON cb.id = g.created_by LEFT JOIN staff vb ON vb.id = g.voided_by
  LEFT JOIN materials m ON m.id = g.material_id LEFT JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN inv_docs d ON d.id = g.receipt_doc_id`;

const toGift = (r: GiftReceipt): GiftReceipt => ({ ...r, id: Number(r.id), qtyMilli: Number(r.qtyMilli) });

export async function listGifts(db: Db, timezone: string, raw: unknown): Promise<GiftReceipt[]> {
  const f = parse(ListQuery, raw);
  if (f.from && f.to) checkDateRange(f.from, f.to);
  const like = f.q ? `%${f.q}%` : null;
  const rows = await db<GiftReceipt[]>`
    ${SELECT(db)}
    WHERE TRUE
      ${f.from ? db`AND g.received_on >= ${f.from}` : db``}
      ${f.to ? db`AND g.received_on <= ${f.to}` : db``}
      ${like ? db`AND (g.name ILIKE ${like} OR g.doc_no ILIKE ${like} OR s.name ILIKE ${like})` : db``}
    ORDER BY g.received_on DESC, g.id DESC LIMIT 1000`;
  void timezone;
  return rows.map(toGift);
}

async function getGift(db: Db, giftId: number): Promise<GiftReceipt> {
  const [row] = await db<GiftReceipt[]>`${SELECT(db)} WHERE g.id = ${giftId}`;
  if (!row) throw notFound('赠品登记不存在');
  return toGift(row);
}

export async function createGift(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ gift: GiftReceipt; replayed: boolean }> {
  const input = parse(GiftInput, raw);
  if (input.receivedOn > todayIn(deps.config.timezone)) throw unprocessable('DATE_IN_FUTURE', '收到日期不能晚于今天');
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, input.clientKey);
    const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (seen) {
      if (seen.opType !== 'gift_receipt' || seen.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔登记，请刷新页面后重新填写');
      return { id: Number(seen.refId), replayed: true };
    }
    await assertNotFenced(tx, input.clientKey, 'gift_receipt', erpOpAbandoned);
    if (input.materialId) {
      const [m] = await tx<{ active: boolean }[]>`SELECT active FROM materials WHERE id = ${input.materialId}`;
      if (!m?.active) throw unprocessable('MATERIAL_INACTIVE', '选的物料不存在或已停用');
    }
    if (input.supplierId) {
      const [s] = await tx<{ id: number }[]>`SELECT id FROM suppliers WHERE id = ${input.supplierId}`;
      if (!s) throw unprocessable('SUPPLIER_INVALID', '供应商不存在');
    }
    if (input.receiptDocId) {
      const [d] = await tx<{ docType: string; supplierId: number | null }[]>`SELECT doc_type, supplier_id FROM inv_docs WHERE id = ${input.receiptDocId}`;
      if (!d || d.docType !== 'receipt') throw unprocessable('RECEIPT_INVALID', '随附的收货单不存在');
      if (input.supplierId && d.supplierId !== null && Number(d.supplierId) !== input.supplierId) throw unprocessable('RECEIPT_SUPPLIER_MISMATCH', '收货单的供应商与填的不一样');
    }
    const docNo = await nextDocNo(tx, 'gift_receipt', 'ZP', input.receivedOn);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO gift_receipts (doc_no, received_on, material_id, name, qty_milli, unit, supplier_id, receipt_doc_id, note, created_by)
      VALUES (${docNo}, ${input.receivedOn}, ${input.materialId}, ${input.name}, ${input.qtyMilli}, ${input.unit}, ${input.supplierId}, ${input.receiptDocId},
              ${input.note}, ${actor.id})
      RETURNING id`;
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'gift_receipt', ${requestHash}, ${row!.id}, ${actor.id})`;
    await writeAudit(tx, { staffId: actor.id, action: 'gift_receipt', targetType: 'gift_receipt', targetId: Number(row!.id), detail: { docNo, name: input.name, qtyMilli: input.qtyMilli, unit: input.unit }, ip });
    return { id: Number(row!.id), replayed: false };
  });
  return { gift: await getGift(deps.sql, r.id), replayed: r.replayed };
}

export async function voidGift(deps: Deps, giftId: number, raw: unknown, actor: Actor, ip?: string): Promise<GiftReceipt> {
  const { reason } = parse(VoidInput, raw);
  await deps.sql.begin(async (tx) => {
    const [g] = await tx<{ status: string; docNo: string }[]>`SELECT status, doc_no FROM gift_receipts WHERE id = ${giftId} FOR UPDATE`;
    if (!g) throw notFound('赠品登记不存在');
    if (g.status === 'voided') return;
    await tx`UPDATE gift_receipts SET status = 'voided', void_reason = ${reason}, voided_by = ${actor.id}, voided_at = now() WHERE id = ${giftId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'gift_receipt', targetType: 'gift_receipt', targetId: giftId, detail: { docNo: g.docNo, void: reason }, ip });
  });
  return getGift(deps.sql, giftId);
}

export function registerGiftRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const writers = guardAny('inventory.operate', 'purchase.manage');
  app.get('/api/inventory/gifts', { preHandler: guard('inventory.read') }, async (req) => listGifts(sql, config.timezone, req.query));
  app.get('/api/inventory/gifts/export', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const f = parse(ListQuery.extend({ from: dateSchema('开始日期'), to: dateSchema('结束日期') }), req.query);
    checkDateRange(f.from, f.to);
    const rows = await listGifts(sql, config.timezone, f);
    const csv = toCsv([
      ['单号', '收到日期', '赠品名称', '物料编码', '数量', '单位', '供应商', '随附收货单', '备注', '登记人', '状态', '作废原因'],
      ...rows.map((g) => [g.docNo, g.receivedOn, g.name, g.material?.code ?? '', formatQty(g.qtyMilli), g.unit, g.supplier?.name ?? '', g.receipt?.docNo ?? '', g.note, g.createdByName, g.status === 'voided' ? '已作废' : '有效', g.voidReason ?? '']),
    ]);
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'gift_receipts', detail: f, ip: req.ip });
    return csvReply(reply, `赠品台账_${f.from}_${f.to}.csv`, csv);
  });
  app.get('/api/inventory/gifts/by-key/:key', { preHandler: guard('inventory.read') }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid() }), req.params);
    const [row] = await sql<{ refId: number }[]>`SELECT ref_id FROM idempotency_keys WHERE key = ${key} AND op_type = 'gift_receipt'`;
    if (!row) throw notFound('没有找到这次登记');
    return getGift(sql, Number(row.refId));
  });
  app.post('/api/inventory/gifts', { preHandler: writers }, async (req, reply) => {
    const r = await createGift(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/inventory/gifts/:id/void', { preHandler: writers }, async (req) => voidGift(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
}
