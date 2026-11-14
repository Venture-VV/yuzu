// 8.0.20 布草洗涤（docs/ERP_V8020.md 第 4 节，JX-E；迁移 138）：布草品类，送洗 / 收回 / 新增 / 报废四种单据，洗涤费对账表。
//
// 单据只增不改，作废留原因并把数量冲回。洗涤费这一版只出对账表，不记应付货款（JX11）。
//
// 锁与幂等：
// · 开单先取操作编号的咨询锁（同一个编号串行）→ 查这个编号开过没有（开过原样返回，内容不同拒绝）→ 布草品类按 id 升序 FOR UPDATE
//   → 写单据与明细、改品类的数量；作废：单据一行 FOR UPDATE → 品类按 id 升序 FOR UPDATE → 冲回数量。
// · 品类的修改只锁品类一行、带版本号；在用的品类不重名靠部分唯一索引。数量不能为负、在洗不超过总数由约束兜底。
// · 读洗涤厂（供应商档案）不加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can } from '@shared/permissions';
import { LINEN_DOC_LABELS, LINEN_DOC_PREFIX, type LinenDoc, type LinenDocKind, type LinenItem, type LinenOutstanding, type LinenOverview, type LinenStatement } from '@shared/linen';
import { guard } from '../auth/guard';
import { readSnapshot, type Db, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Actor, type Deps, type OpContext } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { assertNotFuture, docDateSchema, todayIn } from './inventory/common';

const id = z.number().int().positive();
const qty = z.number().int().min(0).max(100_000);

const ItemInput = z.object({
  name: z.string('请填写品类名称').trim().min(1, '请填写品类名称').max(24, '品类名称最多 24 个字'),
  washPriceCents: z.number().int().min(0).max(1_000_000).default(0),
});
const ItemUpdate = ItemInput.extend({ active: z.boolean(), expectedVersion: z.number().int().positive() });

const DocInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  kind: z.enum(['add', 'send', 'return', 'scrap'], '请选择单据类型'),
  supplierId: id.nullable().default(null),
  docDate: docDateSchema,
  note: z.string().trim().max(200, '备注最多 200 个字').default(''),
  lines: z
    .array(z.object({ itemId: id, qty: qty.default(0), damagedQty: qty.default(0), lostQty: qty.default(0) }))
    .min(1, '请至少填一行')
    .max(50, '一张单最多 50 行'),
});
const VoidInput = z.object({ reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200) });

const toItem = (r: { id: number; name: string; totalQty: number; atLaundryQty: number; washPriceCents: number; active: boolean; version: number }): LinenItem => ({
  id: Number(r.id),
  name: r.name,
  totalQty: r.totalQty,
  atLaundryQty: r.atLaundryQty,
  inHouseQty: r.totalQty - r.atLaundryQty,
  washPriceCents: r.washPriceCents,
  active: r.active,
  version: r.version,
});

async function listItems(db: Db): Promise<LinenItem[]> {
  const rows = await db<Parameters<typeof toItem>[0][]>`
    SELECT id, name, total_qty, at_laundry_qty, wash_price_cents, active, version FROM linen_items ORDER BY active DESC, id`;
  return rows.map(toItem);
}

async function loadDocs(db: Db, where: ReturnType<Db>, limit: number): Promise<LinenDoc[]> {
  const docs = await db<Record<string, unknown>[]>`
    SELECT d.id, d.doc_no, d.kind, d.supplier_id, s.name AS supplier_name, d.doc_date::text AS doc_date, d.note, d.amount_cents, d.status,
           st.display_name AS created_by_name, d.created_at, d.void_reason
    FROM linen_docs d LEFT JOIN suppliers s ON s.id = d.supplier_id JOIN staff st ON st.id = d.created_by
    WHERE ${where} ORDER BY d.id DESC LIMIT ${limit}`;
  if (docs.length === 0) return [];
  const lines = await db<{ docId: number; itemId: number; itemName: string; qty: number; damagedQty: number; lostQty: number; priceCents: number; amountCents: number }[]>`
    SELECT l.doc_id, l.item_id, i.name AS item_name, l.qty, l.damaged_qty, l.lost_qty, l.price_cents, l.amount_cents
    FROM linen_doc_lines l JOIN linen_items i ON i.id = l.item_id WHERE l.doc_id IN ${db(docs.map((d) => Number(d.id)))} ORDER BY l.id`;
  return docs.map((d) => ({
    id: Number(d.id),
    docNo: String(d.docNo),
    kind: d.kind as LinenDocKind,
    supplier: d.supplierId === null ? null : { id: Number(d.supplierId), name: String(d.supplierName) },
    docDate: String(d.docDate),
    note: String(d.note),
    amountCents: Number(d.amountCents),
    status: d.status as LinenDoc['status'],
    createdByName: String(d.createdByName),
    createdAt: new Date(d.createdAt as string).toISOString(),
    voidReason: (d.voidReason as string | null) ?? null,
    lines: lines
      .filter((l) => Number(l.docId) === Number(d.id))
      .map((l) => ({ itemId: Number(l.itemId), itemName: l.itemName, qty: l.qty, damagedQty: l.damagedQty, lostQty: l.lostQty, priceCents: l.priceCents, amountCents: Number(l.amountCents) })),
  }));
}

export async function linenOverview(db: Db, actor: Actor): Promise<LinenOverview> {
  const outstanding = await db<{ supplierId: number; supplierName: string; itemId: number; itemName: string; qty: number }[]>`
    SELECT d.supplier_id, s.name AS supplier_name, l.item_id, i.name AS item_name,
           sum(CASE WHEN d.kind = 'send' THEN l.qty ELSE -(l.qty + l.damaged_qty + l.lost_qty) END)::int AS qty
    FROM linen_docs d JOIN linen_doc_lines l ON l.doc_id = d.id JOIN linen_items i ON i.id = l.item_id JOIN suppliers s ON s.id = d.supplier_id
    WHERE d.status = 'confirmed' AND d.kind IN ('send', 'return')
    GROUP BY d.supplier_id, s.name, l.item_id, i.name
    HAVING sum(CASE WHEN d.kind = 'send' THEN l.qty ELSE -(l.qty + l.damaged_qty + l.lost_qty) END) <> 0
    ORDER BY s.name, l.item_id`;
  return {
    items: await listItems(db),
    outstanding: outstanding.map((o): LinenOutstanding => ({ supplierId: Number(o.supplierId), supplierName: o.supplierName, itemId: Number(o.itemId), itemName: o.itemName, qty: o.qty })),
    docs: await loadDocs(db, db`true`, 60),
    canManage: can(actor, 'linen.manage'),
  };
}

export async function createLinenItem(deps: Deps, raw: unknown, ctx: OpContext): Promise<LinenItem> {
  const input = parse(ItemInput, raw);
  try {
    return await deps.sql.begin(async (tx) => {
      const [row] = await tx<Parameters<typeof toItem>[0][]>`
        INSERT INTO linen_items (name, wash_price_cents, created_by) VALUES (${input.name}, ${input.washPriceCents}, ${ctx.actor.id})
        RETURNING id, name, total_qty, at_laundry_qty, wash_price_cents, active, version`;
      await writeAudit(tx, { staffId: ctx.actor.id, action: 'linen_item', targetType: 'linen_item', targetId: row!.id, detail: { created: input }, ip: ctx.ip });
      return toItem(row!);
    });
  } catch (e) {
    if ((e as { constraint_name?: string }).constraint_name === 'linen_items_name_uq') throw conflict('LINEN_NAME_TAKEN', `已经有「${input.name}」这个品类了`);
    throw e;
  }
}

export async function updateLinenItem(deps: Deps, itemId: number, raw: unknown, ctx: OpContext): Promise<LinenItem> {
  const input = parse(ItemUpdate, raw);
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [cur] = await tx<{ version: number; name: string; washPriceCents: number; active: boolean; atLaundryQty: number }[]>`
        SELECT version, name, wash_price_cents, active, at_laundry_qty FROM linen_items WHERE id = ${itemId} FOR UPDATE`;
      if (!cur) throw notFound('布草品类不存在');
      if (cur.version !== input.expectedVersion) throw conflict('LINEN_ITEM_CHANGED', '这个品类刚刚被别人改过，请刷新后再改');
      if (!input.active && cur.atLaundryQty > 0) throw unprocessable('LINEN_AT_LAUNDRY', `「${cur.name}」还有 ${cur.atLaundryQty} 件在洗，收回以后才能停用`);
      const [row] = await tx<Parameters<typeof toItem>[0][]>`
        UPDATE linen_items SET name = ${input.name}, wash_price_cents = ${input.washPriceCents}, active = ${input.active}, version = version + 1, updated_at = now()
        WHERE id = ${itemId} RETURNING id, name, total_qty, at_laundry_qty, wash_price_cents, active, version`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'linen_item',
        targetType: 'linen_item',
        targetId: itemId,
        detail: { before: { name: cur.name, washPriceCents: cur.washPriceCents, active: cur.active }, after: { name: input.name, washPriceCents: input.washPriceCents, active: input.active } },
        ip: ctx.ip,
      });
      return toItem(row!);
    });
  } catch (e) {
    if ((e as { constraint_name?: string }).constraint_name === 'linen_items_name_uq') throw conflict('LINEN_NAME_TAKEN', `已经有「${input.name}」这个品类了`);
    throw e;
  }
}

/** 一行对「总数、在洗」的影响（作废时取反） */
function effect(kind: LinenDocKind, l: { qty: number; damagedQty: number; lostQty: number }): { total: number; atLaundry: number } {
  if (kind === 'add') return { total: l.qty, atLaundry: 0 };
  if (kind === 'scrap') return { total: -l.qty, atLaundry: 0 };
  if (kind === 'send') return { total: 0, atLaundry: l.qty };
  return { total: -(l.damagedQty + l.lostQty), atLaundry: -(l.qty + l.damagedQty + l.lostQty) };
}

async function lockItems(tx: Tx, ids: number[]) {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const rows = await tx<{ id: number; name: string; totalQty: number; atLaundryQty: number; washPriceCents: number; active: boolean }[]>`
    SELECT id, name, total_qty, at_laundry_qty, wash_price_cents, active FROM linen_items WHERE id IN ${tx(unique)} ORDER BY id FOR UPDATE`;
  if (rows.length !== unique.length) throw unprocessable('LINEN_ITEM_NOT_FOUND', '有布草品类不存在，请刷新后重试');
  return new Map(rows.map((r) => [Number(r.id), r]));
}

export async function createLinenDoc(deps: Deps, raw: unknown, ctx: OpContext): Promise<{ doc: LinenDoc; replayed: boolean }> {
  const input = parse(DocInput, raw);
  assertNotFuture(input.docDate, deps.config.timezone);
  const needsSupplier = input.kind === 'send' || input.kind === 'return';
  if (needsSupplier && input.supplierId === null) throw badRequest('请选择洗涤厂');
  if (!needsSupplier && input.supplierId !== null) throw badRequest(`${LINEN_DOC_LABELS[input.kind]}单不用选洗涤厂`);
  const ids = input.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw badRequest('同一个品类在一张单里只能出现一次');
  for (const l of input.lines) {
    if (input.kind !== 'return' && (l.damagedQty > 0 || l.lostQty > 0)) throw badRequest('只有收回单才填破损、丢失');
    if (l.qty + l.damagedQty + l.lostQty <= 0) throw badRequest('数量要大于 0');
  }
  const { clientKey, ...body } = input;
  const requestHash = hashRequest(body);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${clientKey}, 0))`;
    const [done] = await tx<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM linen_docs WHERE client_key = ${clientKey}`;
    if (done) {
      if (done.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已经用在另一张布草单上了，请刷新页面后重新填写');
      return { doc: (await loadDocs(tx, tx`d.id = ${done.id}`, 1))[0]!, replayed: true };
    }
    if (input.supplierId !== null) {
      const [s] = await tx<{ active: boolean; name: string }[]>`SELECT active, name FROM suppliers WHERE id = ${input.supplierId}`;
      if (!s) throw unprocessable('SUPPLIER_NOT_FOUND', '洗涤厂不存在，请刷新后重试');
      if (!s.active) throw unprocessable('SUPPLIER_INACTIVE', `「${s.name}」已停用`);
    }
    const items = await lockItems(tx, ids);
    let amount = 0;
    const lines = input.lines.map((l) => {
      const item = items.get(l.itemId)!;
      if (!item.active) throw unprocessable('LINEN_ITEM_INACTIVE', `「${item.name}」已停用`);
      const e = effect(input.kind, l);
      const total = item.totalQty + e.total;
      const atLaundry = item.atLaundryQty + e.atLaundry;
      if (input.kind === 'send' && l.qty > item.totalQty - item.atLaundryQty) {
        throw unprocessable('LINEN_NOT_ENOUGH', `「${item.name}」在店只有 ${item.totalQty - item.atLaundryQty} 件，送不了 ${l.qty} 件`);
      }
      if (input.kind === 'scrap' && l.qty > item.totalQty - item.atLaundryQty) {
        throw unprocessable('LINEN_NOT_ENOUGH', `「${item.name}」在店只有 ${item.totalQty - item.atLaundryQty} 件，报废不了 ${l.qty} 件`);
      }
      if (atLaundry < 0) throw unprocessable('LINEN_NOT_AT_LAUNDRY', `「${item.name}」在洗只有 ${item.atLaundryQty} 件，收不回 ${l.qty + l.damagedQty + l.lostQty} 件`);
      // 洗涤费：完好的与破损的都洗过，丢失的不算
      const price = input.kind === 'return' ? item.washPriceCents : 0;
      const lineAmount = input.kind === 'return' ? (l.qty + l.damagedQty) * price : 0;
      amount += lineAmount;
      item.totalQty = total;
      item.atLaundryQty = atLaundry;
      return { ...l, price, lineAmount, total, atLaundry };
    });
    const docNo = await nextDocNo(tx, `linen_${input.kind}`, LINEN_DOC_PREFIX[input.kind], input.docDate);
    const [doc] = await tx<{ id: number }[]>`
      INSERT INTO linen_docs (doc_no, kind, supplier_id, doc_date, note, amount_cents, client_key, request_hash, created_by)
      VALUES (${docNo}, ${input.kind}, ${input.supplierId}, ${input.docDate}, ${input.note}, ${amount}, ${clientKey}, ${requestHash}, ${ctx.actor.id}) RETURNING id`;
    for (const l of lines) {
      await tx`
        INSERT INTO linen_doc_lines (doc_id, item_id, qty, damaged_qty, lost_qty, price_cents, amount_cents)
        VALUES (${doc!.id}, ${l.itemId}, ${l.qty}, ${l.damagedQty}, ${l.lostQty}, ${l.price}, ${l.lineAmount})`;
      await tx`UPDATE linen_items SET total_qty = ${l.total}, at_laundry_qty = ${l.atLaundry}, updated_at = now() WHERE id = ${l.itemId}`;
    }
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'linen_doc', targetType: 'linen_doc', targetId: doc!.id, detail: { docNo, kind: input.kind, amountCents: amount, lines: input.lines }, ip: ctx.ip });
    return { doc: (await loadDocs(tx, tx`d.id = ${doc!.id}`, 1))[0]!, replayed: false };
  });
}

export async function voidLinenDoc(deps: Deps, docId: number, raw: unknown, ctx: OpContext): Promise<LinenDoc> {
  const { reason } = parse(VoidInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [doc] = await tx<{ id: number; kind: LinenDocKind; status: string; docNo: string }[]>`SELECT id, kind, status, doc_no FROM linen_docs WHERE id = ${docId} FOR UPDATE`;
    if (!doc) throw notFound('布草单据不存在');
    if (doc.status === 'voided') throw conflict('LINEN_DOC_VOIDED', '这张单已经作废了');
    const lines = await tx<{ itemId: number; qty: number; damagedQty: number; lostQty: number }[]>`SELECT item_id, qty, damaged_qty, lost_qty FROM linen_doc_lines WHERE doc_id = ${docId}`;
    const items = await lockItems(tx, lines.map((l) => Number(l.itemId)));
    for (const l of lines) {
      const item = items.get(Number(l.itemId))!;
      const e = effect(doc.kind, l);
      const total = item.totalQty - e.total;
      const atLaundry = item.atLaundryQty - e.atLaundry;
      // 冲回以后数量要说得通：送洗的已经收回了、新增的已经送洗或报废了，这张单就不能直接作废
      if (total < 0 || atLaundry < 0 || atLaundry > total) {
        throw unprocessable('LINEN_VOID_BLOCKED', `作废「${doc.docNo}」以后「${item.name}」的数量对不上（这张单之后又有送洗、收回或报废），请先处理后面的单`);
      }
      await tx`UPDATE linen_items SET total_qty = ${total}, at_laundry_qty = ${atLaundry}, updated_at = now() WHERE id = ${item.id}`;
    }
    await tx`UPDATE linen_docs SET status = 'voided', voided_by = ${ctx.actor.id}, voided_at = now(), void_reason = ${reason} WHERE id = ${docId}`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'linen_doc_void', targetType: 'linen_doc', targetId: docId, detail: { docNo: doc.docNo, reason }, ip: ctx.ip });
    return (await loadDocs(tx, tx`d.id = ${docId}`, 1))[0]!;
  });
}

export async function linenStatement(db: Db, timezone: string, raw: unknown): Promise<LinenStatement> {
  const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份写成 2026-11 这样').optional() }), raw ?? {});
  const m = month ?? todayIn(timezone).slice(0, 7);
  const rows = await db<{ supplierId: number; supplierName: string; docs: number; washed: number; damaged: number; lost: number; amount: number }[]>`
    SELECT d.supplier_id, s.name AS supplier_name, count(DISTINCT d.id)::int AS docs, COALESCE(sum(l.qty), 0)::int AS washed,
           COALESCE(sum(l.damaged_qty), 0)::int AS damaged, COALESCE(sum(l.lost_qty), 0)::int AS lost, COALESCE(sum(l.amount_cents), 0)::bigint AS amount
    FROM linen_docs d JOIN linen_doc_lines l ON l.doc_id = d.id JOIN suppliers s ON s.id = d.supplier_id
    WHERE d.kind = 'return' AND d.status = 'confirmed' AND to_char(d.doc_date, 'YYYY-MM') = ${m}
    GROUP BY d.supplier_id, s.name ORDER BY s.name`;
  const out = rows.map((r) => ({ supplierId: Number(r.supplierId), supplierName: r.supplierName, docs: r.docs, washedQty: r.washed, damagedQty: r.damaged, lostQty: r.lost, amountCents: Number(r.amount) }));
  return { month: m, rows: out, totalCents: out.reduce((a, r) => a + r.amountCents, 0) };
}

export function registerLinenRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  app.get('/api/erp/linen', { preHandler: guard('linen.read') }, async (req) => readSnapshot(sql, (tx) => linenOverview(tx, req.actor)));
  app.post('/api/erp/linen/items', { preHandler: guard('linen.manage') }, async (req, reply) => {
    reply.code(201);
    return createLinenItem(deps, req.body, ctxOf(req));
  });
  app.put('/api/erp/linen/items/:id', { preHandler: guard('linen.manage') }, async (req) => updateLinenItem(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/erp/linen/docs', { preHandler: guard('linen.manage') }, async (req, reply) => {
    const r = await createLinenDoc(deps, req.body, ctxOf(req));
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/erp/linen/docs/:id/void', { preHandler: guard('linen.manage') }, async (req) => voidLinenDoc(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.get('/api/erp/linen/statement', { preHandler: guard('linen.read') }, async (req) => readSnapshot(sql, (tx) => linenStatement(tx, config.timezone, req.query)));
  app.get('/api/erp/linen/statement/export', { preHandler: guard('linen.read') }, async (req, reply) => {
    const s = await readSnapshot(sql, (tx) => linenStatement(tx, config.timezone, req.query));
    const yuan = (c: number) => (c / 100).toFixed(2);
    return csvReply(
      reply,
      `洗涤费对账_${s.month}.csv`,
      toCsv([
        ['洗涤厂', '收回单数', '完好件数', '破损件数', '丢失件数', '洗涤费（元）'],
        ...s.rows.map((r) => [r.supplierName, r.docs, r.washedQty, r.damagedQty, r.lostQty, yuan(r.amountCents)]),
        ['合计', '', '', '', '', yuan(s.totalCents)],
      ]),
    );
  });
}
