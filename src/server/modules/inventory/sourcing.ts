// 询价比价与定标（v0.7.29 ERP 采购五项⑤，E5–E8，见 docs/ERP_PURCHASING.md 第 6 节）。
//
// 询价单（物料与数量建好不改）→ 各家报价（每行含税单价、运费、付款条件、交货、有效期）→ 比价（综合到价 = 货款 + 运费）
// → 定标（选一家、写理由；有效报价不够规则要求的家数时标单一来源、由负责人定标）→ 转采购单（生成草稿，采购单记下询价单）。
// 合计到询价门槛的采购单第一次提交时要来自已定标的询价单（purchasing.ts 的 submitLocked 里核对）。
// v0.7.30：询价单可以从需求单发起（采购单表单里「改为询价」）或从补货建议发起；询价单的每一行记下来自哪几行需求，
// 定标转采购单时一起带到采购单行上，需求单的进度照旧由采购单算。一行需求同时只能在一张没撤销的询价单里。
//
// 锁：报价、撤下、定标、撤销定标、撤销询价单都先锁询价单一行；转采购单在新建采购单的事务里锁询价单一行
// （操作编号的咨询锁 → 询价单 → 新采购单 → 需求单）；采购单提交时只读询价单、不加锁。
// 带需求行建询价单：操作编号的咨询锁 → 需求单（id 升序，与转采购单同一把锁）→ 新询价单。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '@shared/permissions';
import type { PriceHistory, PurchaseOrder, SourcingEvent, SourcingLineRequest, SourcingQuote, SourcingStatus, SourcingSummary } from '@shared/purchasing';
import { formatAmount } from '@shared/money';
import { fitsDecimals, lineAmountCents, priceChangePercent, toBaseQty } from '@shared/quantity';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { hashRequest } from '../../lib/idempotency';
import { lockOpKey } from '../../lib/fences';
import { idParam, parse } from '../../lib/validate';
import { shiftDate } from '@shared/labels';
import { docDateSchema, loadInventorySettings, nextDocNo, priceBaseline, setTxTimeouts, todayIn } from './common';
import { loadPurchaseRules } from './purchase-rules';
import { createPo } from './purchasing';

const id = z.number().int().positive();
const Reason = z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200);

// ───────────────────────── 读取 ─────────────────────────

export async function getSourcing(db: Db, eventId: number): Promise<SourcingEvent> {
  const [e] = await db<(Omit<SourcingEvent, 'lines' | 'quotes' | 'lowest' | 'purchaseOrder' | 'minQuotes'>)[]>`
    SELECT e.id, e.doc_no, e.title, e.status, e.need_by, e.note, e.single_source, e.awarded_quote_id, e.award_reason,
           ab.display_name AS awarded_by_name, e.awarded_at, e.cancel_reason, cb.display_name AS created_by_name, e.created_at
    FROM sourcing_events e JOIN staff cb ON cb.id = e.created_by LEFT JOIN staff ab ON ab.id = e.awarded_by
    WHERE e.id = ${eventId}`;
  if (!e) throw notFound('询价单不存在');
  const settings = await loadInventorySettings(db);
  const rawLines = await db<Omit<SourcingEvent['lines'][number], 'baseline' | 'requests'>[]>`
    SELECT l.id, l.line_no, l.material_id, m.code AS material_code, m.name AS material_name, m.specification, l.purchase_unit,
           m.inventory_unit, l.factor_milli, l.purchase_qty_milli, l.base_qty_milli, l.spec
    FROM sourcing_lines l JOIN materials m ON m.id = l.material_id WHERE l.event_id = ${eventId} ORDER BY l.line_no`;
  const links = rawLines.length
    ? await db<(SourcingLineRequest & { sourcingLineId: number })[]>`
        SELECT sr.sourcing_line_id, rl.id AS line_id, r.id AS request_id, r.doc_no AS request_no, d.name AS department_name,
               rl.name, rl.qty_milli, rl.unit
        FROM sourcing_line_requests sr JOIN purchase_request_lines rl ON rl.id = sr.request_line_id
        JOIN purchase_requests r ON r.id = rl.request_id JOIN departments d ON d.id = r.department_id
        WHERE sr.sourcing_line_id IN ${db(rawLines.map((l) => l.id))}
        ORDER BY r.id, rl.line_no`
    : [];
  const lines: SourcingEvent['lines'] = [];
  for (const l of rawLines) {
    const baseline = await priceBaseline(
      db,
      { materialId: Number(l.materialId), purchaseUnit: l.purchaseUnit, factorMilli: Number(l.factorMilli), priceBasis: settings.priceBasis },
      // 收货不能记到以后的日期：最近一次成交价就是全部生效收货里最近的
      { onOrBefore: '9999-12-31' },
    );
    const requests = links
      .filter((x) => Number(x.sourcingLineId) === Number(l.id))
      .map(({ sourcingLineId: _s, ...x }) => ({ ...x, lineId: Number(x.lineId), requestId: Number(x.requestId), qtyMilli: Number(x.qtyMilli) }));
    lines.push({ ...l, id: Number(l.id), materialId: Number(l.materialId), factorMilli: Number(l.factorMilli), purchaseQtyMilli: Number(l.purchaseQtyMilli), baseQtyMilli: Number(l.baseQtyMilli), baseline, requests });
  }
  const quotesRaw = await db<(Omit<SourcingQuote, 'supplier' | 'prices' | 'rank' | 'landedCents'> & { supplierId: number; supplierName: string })[]>`
    SELECT q.id, q.supplier_id, s.name AS supplier_name, q.status, q.goods_cents, q.freight_cents, q.pay_terms, q.credit_days, q.delivery_days,
           q.valid_until, q.note, cb.display_name AS created_by_name, q.created_at, q.withdraw_reason, wb.display_name AS withdrawn_by_name
    FROM sourcing_quotes q JOIN suppliers s ON s.id = q.supplier_id JOIN staff cb ON cb.id = q.created_by LEFT JOIN staff wb ON wb.id = q.withdrawn_by
    WHERE q.event_id = ${eventId} ORDER BY q.id`;
  const prices = quotesRaw.length
    ? await db<{ quoteId: number; lineId: number; priceCents: number; amountCents: number }[]>`
        SELECT quote_id, sourcing_line_id AS line_id, price_cents, amount_cents FROM sourcing_quote_lines
        WHERE quote_id IN ${db(quotesRaw.map((q) => q.id))}`
    : [];
  const quotes: SourcingQuote[] = quotesRaw.map(({ supplierId, supplierName, ...q }) => {
    const goods = Number(q.goodsCents);
    const freight = Number(q.freightCents);
    return {
      ...q,
      id: Number(q.id),
      supplier: { id: Number(supplierId), name: supplierName },
      goodsCents: goods,
      freightCents: freight,
      landedCents: goods + freight,
      prices: lines.map((l) => {
        const p = prices.find((x) => Number(x.quoteId) === Number(q.id) && Number(x.lineId) === l.id);
        const priceCents = Number(p?.priceCents ?? 0);
        return { lineId: l.id, priceCents, amountCents: Number(p?.amountCents ?? 0), changePercent: l.baseline ? priceChangePercent(l.baseline.priceCents, priceCents) : null };
      }),
      rank: null,
    };
  });
  const active = quotes.filter((q) => q.status === 'active').sort((a, b) => a.landedCents - b.landedCents || a.id - b.id);
  active.forEach((q, i) => (q.rank = i + 1));
  const lowest: Record<number, number> = {};
  for (const l of lines) {
    let best: SourcingQuote | null = null;
    for (const q of active) {
      const p = q.prices.find((x) => x.lineId === l.id)!;
      if (!best || p.priceCents < best.prices.find((x) => x.lineId === l.id)!.priceCents) best = q;
    }
    if (best) lowest[l.id] = best.id;
  }
  const [po] = await db<{ id: number; docNo: string; status: PurchaseOrder['status'] }[]>`
    SELECT id, doc_no, status FROM purchase_orders WHERE sourcing_event_id = ${eventId} AND status <> 'cancelled' ORDER BY id DESC LIMIT 1`;
  const rules = await loadPurchaseRules(db);
  return {
    ...e,
    awardedQuoteId: e.awardedQuoteId === null ? null : Number(e.awardedQuoteId),
    lines,
    quotes,
    lowest,
    purchaseOrder: po ? { id: Number(po.id), docNo: po.docNo, status: po.status } : null,
    minQuotes: rules.minQuotes,
  };
}

export async function listSourcing(db: Db, f: { status?: SourcingStatus; q?: string }): Promise<SourcingSummary[]> {
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db<(Omit<SourcingSummary, 'purchaseOrder'> & { poId: number | null; poNo: string | null })[]>`
    SELECT e.id, e.doc_no, e.title, e.status, e.need_by, cb.display_name AS created_by_name, e.created_at,
           (SELECT count(*) FROM sourcing_lines l WHERE l.event_id = e.id)::int AS line_count,
           (SELECT count(*) FROM sourcing_quotes q WHERE q.event_id = e.id AND q.status = 'active')::int AS quote_count,
           coalesce((SELECT string_agg(m.name, '、' ORDER BY l.line_no) FROM sourcing_lines l JOIN materials m ON m.id = l.material_id
                     WHERE l.event_id = e.id AND l.line_no <= 3), '') AS summary,
           (SELECT s.name FROM sourcing_quotes q JOIN suppliers s ON s.id = q.supplier_id WHERE q.id = e.awarded_quote_id) AS awarded_supplier_name,
           (SELECT min(q.goods_cents + q.freight_cents) FROM sourcing_quotes q WHERE q.event_id = e.id AND q.status = 'active')::bigint AS lowest_landed_cents,
           po.id AS po_id, po.doc_no AS po_no
    FROM sourcing_events e JOIN staff cb ON cb.id = e.created_by
    LEFT JOIN purchase_orders po ON po.sourcing_event_id = e.id AND po.status <> 'cancelled'
    WHERE TRUE
      ${f.status ? db`AND e.status = ${f.status}` : db``}
      ${like ? db`AND (e.doc_no ILIKE ${like} OR e.title ILIKE ${like})` : db``}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 200`;
  return rows.map(({ poId, poNo, ...r }) => ({
    ...r,
    lowestLandedCents: r.lowestLandedCents === null ? null : Number(r.lowestLandedCents),
    purchaseOrder: poId ? { id: Number(poId), docNo: poNo! } : null,
  }));
}

// ───────────────────────── 建询价单 ─────────────────────────

const CreateInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  title: z.string().trim().min(1, '请填写询价内容').max(40, '标题最多 40 个字'),
  needBy: docDateSchema.nullable().default(null),
  note: z.string().trim().max(200).default(''),
  lines: z
    .array(
      z.object({
        materialId: id,
        purchaseQtyMilli: z.number('请填写数量').int().positive('数量必须大于 0').max(1_000_000_000_000),
        spec: z.string().trim().max(80, '规格最多 80 个字').optional(),
        /** 来自哪几行需求（v0.7.30，从需求单发起询价时带上） */
        requestLineIds: z.array(id).max(50, '一行最多合并 50 行需求').optional(),
      }),
    )
    .min(1, '请至少添加一项物料')
    .max(30, '一张询价单最多 30 项物料'),
});

/** 同一操作编号重提：内容一样返回原来那一行，不一样拒绝（询价单、报价各自记操作编号与原请求摘要，不用共用的幂等表） */
async function findByKey(db: Db, table: 'sourcing_events' | 'sourcing_quotes', key: string, requestHash: string): Promise<number | null> {
  const [row] = table === 'sourcing_events'
    ? await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM sourcing_events WHERE client_key = ${key}`
    : await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM sourcing_quotes WHERE client_key = ${key}`;
  if (!row) return null;
  if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的登记，请刷新页面后重新填写');
  return Number(row.id);
}

/**
 * 带需求行建询价单（v0.7.30）：需求行要已通过、不在有效采购单里（撤回的不算）、不在别的没撤销的询价单里；
 * 需求行选了物料的，询价单行的物料要一致；同一物料的几行需求可以并成询价单的一行。
 * 锁需求单（id 升序，与转采购单同一把锁）之后再核对，同一行需求不会同时进两张询价单或一张询价单加一张采购单。
 */
async function checkSourcingRequests(tx: Tx, lines: { materialId: number; requestLineIds?: number[] }[], actor: Actor) {
  const all = lines.flatMap((l) => l.requestLineIds ?? []);
  if (all.length === 0) return;
  if (new Set(all).size !== all.length) throw badRequest('同一行需求在一张询价单里只能出现一次');
  if (!can(actor, 'request.review')) throw forbidden('当前账号不能从需求单发起询价');
  await tx`
    SELECT r.id FROM purchase_requests r
    WHERE r.id IN (SELECT request_id FROM purchase_request_lines WHERE id IN ${tx(all)})
    ORDER BY r.id FOR UPDATE`;
  const rows = await tx<{ id: number; name: string; materialId: number | null; status: string; docNo: string; takenBy: string | null; inSourcing: string | null }[]>`
    SELECT l.id, l.name, l.material_id, r.status, r.doc_no,
           (SELECT po.doc_no FROM purchase_order_line_requests x JOIN purchase_order_lines pl ON pl.id = x.po_line_id
              JOIN purchase_orders po ON po.id = pl.po_id
             WHERE x.request_line_id = l.id AND po.status <> 'cancelled' LIMIT 1) AS taken_by,
           (SELECT e.doc_no FROM sourcing_line_requests sr JOIN sourcing_lines sl ON sl.id = sr.sourcing_line_id
              JOIN sourcing_events e ON e.id = sl.event_id
             WHERE sr.request_line_id = l.id AND e.status <> 'cancelled' LIMIT 1) AS in_sourcing
    FROM purchase_request_lines l JOIN purchase_requests r ON r.id = l.request_id
    WHERE l.id IN ${tx(all)}`;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const l of lines) {
    for (const rid of l.requestLineIds ?? []) {
      const r = byId.get(rid);
      if (!r) throw unprocessable('REQUEST_LINE_NOT_FOUND', '需求单的行不存在，请刷新后重试');
      if (r.materialId !== null && Number(r.materialId) !== l.materialId) throw unprocessable('REQUEST_MATERIAL_MISMATCH', `「${r.name}」的物料与需求单不一致`);
      if (r.status !== 'approved') throw conflict('REQUEST_NOT_APPROVED', `需求单 ${r.docNo} 还没通过审核，不能发起询价`);
      if (r.takenBy) throw conflict('REQUEST_LINE_ORDERED', `「${r.name}」已经在采购单 ${r.takenBy} 里`, { docNo: r.takenBy });
      if (r.inSourcing) throw conflict('REQUEST_LINE_IN_SOURCING', `「${r.name}」已经在询价单 ${r.inSourcing} 里`, { docNo: r.inSourcing });
    }
  }
}

export async function createSourcing(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(CreateInput, raw);
  const ids = input.lines.map((l) => l.materialId);
  if (new Set(ids).size !== ids.length) throw badRequest('同一物料在一张询价单里只能出现一次');
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  let eventId: number;
  let replayed = false;
  try {
    const r = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      const existing = await findByKey(tx, 'sourcing_events', input.clientKey, requestHash);
      if (existing) return { id: existing, replayed: true };
      await checkSourcingRequests(tx, input.lines, actor);
      const mats = new Map(
        (
          await tx<{ id: number; name: string; purchaseUnit: string; purchaseFactorMilli: number; inventoryUnit: string; decimals: number; tracked: boolean; active: boolean; specification: string }[]>`
            SELECT id, name, purchase_unit, purchase_factor_milli, inventory_unit, decimals, tracked, active, specification FROM materials WHERE id IN ${tx(ids)}`
        ).map((m) => [Number(m.id), m]),
      );
      const today = todayIn(deps.config.timezone);
      const docNo = await nextDocNo(tx, 'sourcing_event', 'XJ', today);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO sourcing_events (doc_no, title, need_by, note, client_key, request_hash, created_by)
        VALUES (${docNo}, ${input.title}, ${input.needBy}, ${input.note}, ${input.clientKey}, ${requestHash}, ${actor.id}) RETURNING id`;
      let lineNo = 0;
      for (const l of input.lines) {
        const m = mats.get(l.materialId);
        if (!m) throw unprocessable('MATERIAL_NOT_FOUND', '有物料不存在，请刷新后重试');
        if (!m.tracked || !m.active) throw unprocessable('MATERIAL_INACTIVE', `「${m.name}」已停用或不是受管物料`);
        const base = toBaseQty(l.purchaseQtyMilli, Number(m.purchaseFactorMilli));
        if (base === null || !fitsDecimals(base, m.decimals)) throw badRequest(`「${m.name}」的数量换算后不是整${m.inventoryUnit}，请调整数量`);
        lineNo += 1;
        const [sl] = await tx<{ id: number }[]>`
          INSERT INTO sourcing_lines (event_id, line_no, material_id, purchase_qty_milli, purchase_unit, factor_milli, base_qty_milli, spec)
          VALUES (${row!.id}, ${lineNo}, ${m.id}, ${l.purchaseQtyMilli}, ${m.purchaseUnit}, ${m.purchaseFactorMilli}, ${base}, ${(l.spec ?? m.specification).slice(0, 80)})
          RETURNING id`;
        for (const rid of l.requestLineIds ?? []) {
          await tx`INSERT INTO sourcing_line_requests (sourcing_line_id, request_line_id) VALUES (${sl!.id}, ${rid})`;
        }
      }
      const requestLines = input.lines.reduce((n, l) => n + (l.requestLineIds?.length ?? 0), 0);
      await writeAudit(tx, { staffId: actor.id, action: 'sourcing_doc', targetType: 'sourcing_event', targetId: row!.id, detail: { docNo, action: 'create', ...(requestLines ? { requestLines } : {}) }, ip });
      return { id: Number(row!.id), replayed: false };
    });
    eventId = r.id;
    replayed = r.replayed;
  } catch (error) {
    if (isUniqueViolation(error, 'sourcing_events_client_key_key')) {
      const existing = await findByKey(deps.sql, 'sourcing_events', input.clientKey, requestHash);
      if (!existing) throw error;
      eventId = existing;
      replayed = true;
    } else throw error;
  }
  return { event: await getSourcing(deps.sql, eventId), replayed };
}

// ───────────────────────── 报价 ─────────────────────────

const QuoteInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  supplierId: id,
  freightCents: z.number().int().min(0, '运费不能为负').max(100_000_000).default(0),
  payTerms: z.string().trim().min(1, '请写付款条件，例如「月结 30 天」「现付」').max(30, '付款条件最多 30 个字'),
  creditDays: z.number().int().min(0).max(365).default(0),
  deliveryDays: z.number().int().min(0).max(365).nullable().default(null),
  validUntil: docDateSchema.nullable().default(null),
  note: z.string().trim().max(200).default(''),
  prices: z.array(z.object({ lineId: id, priceCents: z.number('请填写单价').int().min(0, '单价不能为负').max(100_000_000) })).min(1).max(30),
});

async function lockEvent(tx: Tx, eventId: number) {
  const [e] = await tx<{ id: number; docNo: string; status: SourcingStatus; awardedQuoteId: number | null }[]>`
    SELECT id, doc_no, status, awarded_quote_id FROM sourcing_events WHERE id = ${eventId} FOR UPDATE`;
  if (!e) throw notFound('询价单不存在');
  return e;
}

export async function addQuote(deps: Deps, eventId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(QuoteInput, raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined, eventId });
  const today = todayIn(deps.config.timezone);
  if (input.validUntil && input.validUntil < today) throw unprocessable('QUOTE_EXPIRED', '报价有效期已经过了，请供应商重新报价');
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      if (await findByKey(tx, 'sourcing_quotes', input.clientKey, requestHash)) return;
      const e = await lockEvent(tx, eventId);
      if (e.status !== 'open') throw conflict('INVALID_STATE', e.status === 'awarded' ? '询价单已定标，要改报价请先撤销定标' : '询价单已撤销');
      const [s] = await tx<{ active: boolean; name: string }[]>`SELECT active, name FROM suppliers WHERE id = ${input.supplierId}`;
      if (!s?.active) throw unprocessable('SUPPLIER_INACTIVE', '供应商不存在或已停用');
      const [dup] = await tx<{ id: number }[]>`SELECT id FROM sourcing_quotes WHERE event_id = ${eventId} AND supplier_id = ${input.supplierId} AND status = 'active'`;
      if (dup) throw conflict('QUOTE_EXISTS', `「${s.name}」已经有一份有效报价；要改请先撤下原来的`);
      const lines = await tx<{ id: number; baseQtyMilli: number; factorMilli: number }[]>`
        SELECT id, base_qty_milli, factor_milli FROM sourcing_lines WHERE event_id = ${eventId} ORDER BY line_no`;
      const given = new Map(input.prices.map((p) => [p.lineId, p.priceCents]));
      if (given.size !== input.prices.length) throw badRequest('同一行只能报一个价');
      if (lines.length !== given.size || lines.some((l) => !given.has(Number(l.id)))) throw unprocessable('QUOTE_LINES', '每份报价要报全部物料的单价');
      const amounts = lines.map((l) => ({ lineId: Number(l.id), priceCents: given.get(Number(l.id))!, amountCents: lineAmountCents(Number(l.baseQtyMilli), given.get(Number(l.id))!, Number(l.factorMilli)) }));
      const goods = amounts.reduce((t, a) => t + a.amountCents, 0);
      const [q] = await tx<{ id: number }[]>`
        INSERT INTO sourcing_quotes (event_id, supplier_id, goods_cents, freight_cents, pay_terms, credit_days, delivery_days, valid_until, note,
                                     client_key, request_hash, created_by)
        VALUES (${eventId}, ${input.supplierId}, ${goods}, ${input.freightCents}, ${input.payTerms}, ${input.creditDays}, ${input.deliveryDays},
                ${input.validUntil}, ${input.note}, ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      for (const a of amounts) {
        await tx`INSERT INTO sourcing_quote_lines (quote_id, sourcing_line_id, price_cents, amount_cents) VALUES (${q!.id}, ${a.lineId}, ${a.priceCents}, ${a.amountCents})`;
      }
      await tx`UPDATE sourcing_events SET updated_at = now() WHERE id = ${eventId}`;
      await writeAudit(tx, { staffId: actor.id, action: 'sourcing_doc', targetType: 'sourcing_quote', targetId: q!.id, detail: { docNo: e.docNo, supplierId: input.supplierId, goodsCents: goods, freightCents: input.freightCents }, ip });
    });
  } catch (error) {
    if (isUniqueViolation(error, 'sourcing_quotes_client_key_key')) {
      if (!(await findByKey(deps.sql, 'sourcing_quotes', input.clientKey, requestHash))) throw error;
    } else if (isUniqueViolation(error, 'sourcing_quotes_one_active')) {
      throw conflict('QUOTE_EXISTS', '这家供应商已经有一份有效报价；要改请先撤下原来的');
    } else throw error;
  }
  return getSourcing(deps.sql, eventId);
}

export async function withdrawQuote(deps: Deps, quoteId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(z.object({ reason: Reason }), raw);
  const [head] = await deps.sql<{ eventId: number }[]>`SELECT event_id FROM sourcing_quotes WHERE id = ${quoteId}`;
  if (!head) throw notFound('报价不存在');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const e = await lockEvent(tx, Number(head.eventId));
    const [q] = await tx<{ status: string }[]>`SELECT status FROM sourcing_quotes WHERE id = ${quoteId}`;
    if (q!.status === 'withdrawn') return;
    if (e.status !== 'open') throw conflict('INVALID_STATE', e.status === 'awarded' ? '询价单已定标，要撤下报价请先撤销定标' : '询价单已撤销');
    await tx`UPDATE sourcing_quotes SET status = 'withdrawn', withdraw_reason = ${reason}, withdrawn_by = ${actor.id}, withdrawn_at = now() WHERE id = ${quoteId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'sourcing_doc', targetType: 'sourcing_quote', targetId: quoteId, detail: { docNo: e.docNo, action: 'withdraw', reason } });
  });
  return getSourcing(deps.sql, Number(head.eventId));
}

// ───────────────────────── 定标、撤销定标、撤销询价单 ─────────────────────────

const AwardInput = z.object({
  quoteId: id,
  reason: Reason,
  /** 有效报价不够规则要求的家数时要标「单一来源」，由负责人定标 */
  singleSource: z.boolean().default(false),
});

export async function awardSourcing(deps: Deps, eventId: number, raw: unknown, actor: Actor) {
  const input = parse(AwardInput, raw);
  const today = todayIn(deps.config.timezone);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const e = await lockEvent(tx, eventId);
    if (e.status === 'awarded' && Number(e.awardedQuoteId) === input.quoteId) return;
    if (e.status !== 'open') throw conflict('INVALID_STATE', e.status === 'awarded' ? '询价单已经定标；要改请先撤销定标' : '询价单已撤销');
    const [q] = await tx<{ eventId: number; status: string; validUntil: string | null }[]>`SELECT event_id, status, valid_until FROM sourcing_quotes WHERE id = ${input.quoteId}`;
    if (!q || Number(q.eventId) !== eventId) throw notFound('报价不存在');
    if (q.status !== 'active') throw conflict('QUOTE_WITHDRAWN', '这份报价已撤下，不能定标');
    if (q.validUntil && q.validUntil < today) throw unprocessable('QUOTE_EXPIRED', '这份报价已过有效期，请供应商重新报价');
    const [cnt] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM sourcing_quotes WHERE event_id = ${eventId} AND status = 'active'`;
    const n = cnt!.n;
    const rules = await loadPurchaseRules(tx);
    let singleSource = false;
    if (n < rules.minQuotes) {
      if (!input.singleSource) throw unprocessable('QUOTES_NOT_ENOUGH', `有效报价只有 ${n} 家，至少要 ${rules.minQuotes} 家；确实只能找这一家的，标「单一来源」并写原因，由负责人定标`);
      if (!can(actor, 'inventory.approve')) throw forbidden('单一来源要由负责人定标');
      if (input.reason.length < 4) throw unprocessable('REASON_TOO_SHORT', '单一来源请写清原因（至少 4 个字），例如「品牌指定，只有一家代理」');
      singleSource = true;
    }
    await tx`
      UPDATE sourcing_events SET status = 'awarded', awarded_quote_id = ${input.quoteId}, award_reason = ${input.reason}, single_source = ${singleSource},
             awarded_by = ${actor.id}, awarded_at = now(), updated_at = now()
      WHERE id = ${eventId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'sourcing_doc', targetType: 'sourcing_event', targetId: eventId, detail: { docNo: e.docNo, action: 'award', quoteId: input.quoteId, singleSource, reason: input.reason } });
  });
  return getSourcing(deps.sql, eventId);
}

async function assertNoOpenPo(tx: Tx, eventId: number, what: string) {
  const [po] = await tx<{ docNo: string }[]>`SELECT doc_no FROM purchase_orders WHERE sourcing_event_id = ${eventId} AND status <> 'cancelled' LIMIT 1`;
  if (po) throw conflict('SOURCING_ORDERED', `已经转成采购单 ${po.docNo}，要${what}请先撤回那张采购单`, { docNo: po.docNo });
}

/** 撤销定标：还没转采购单（或采购单已撤回）时回到询价中，可以改报价、重新定标 */
export async function reopenSourcing(deps: Deps, eventId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(z.object({ reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const e = await lockEvent(tx, eventId);
    if (e.status === 'open') return;
    if (e.status !== 'awarded') throw conflict('INVALID_STATE', '询价单已撤销');
    await assertNoOpenPo(tx, eventId, '撤销定标');
    await tx`
      UPDATE sourcing_events SET status = 'open', awarded_quote_id = NULL, award_reason = NULL, single_source = false, awarded_by = NULL, awarded_at = NULL,
             updated_at = now()
      WHERE id = ${eventId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'sourcing_doc', targetType: 'sourcing_event', targetId: eventId, detail: { docNo: e.docNo, action: 'reopen', reason } });
  });
  return getSourcing(deps.sql, eventId);
}

export async function cancelSourcing(deps: Deps, eventId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(z.object({ reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const e = await lockEvent(tx, eventId);
    if (e.status === 'cancelled') return;
    await assertNoOpenPo(tx, eventId, '撤销询价单');
    await tx`
      UPDATE sourcing_events SET status = 'cancelled', cancel_reason = ${reason}, awarded_quote_id = NULL, award_reason = NULL, single_source = false,
             awarded_by = NULL, awarded_at = NULL, updated_at = now()
      WHERE id = ${eventId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'sourcing_doc', targetType: 'sourcing_event', targetId: eventId, detail: { docNo: e.docNo, action: 'cancel', reason } });
  });
  return getSourcing(deps.sql, eventId);
}

// ───────────────────────── 转采购单 ─────────────────────────

/**
 * 定标后生成采购单草稿：供应商、物料、数量、单价按中标的报价，规格带上，备注写询价单号与运费；从需求单发起的带上需求行。
 * 在新建采购单的事务里锁询价单、核对已定标（purchasing.ts 的 createPo 收到 sourcingEventId 时做），唯一索引兜底同一张询价单只转一张。
 */
export async function orderFromSourcing(deps: Deps, eventId: number, raw: unknown, actor: Actor, ip?: string) {
  const { clientKey } = parse(z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') }), raw);
  const e = await getSourcing(deps.sql, eventId);
  if (e.status !== 'awarded' || !e.awardedQuoteId) throw conflict('NOT_AWARDED', '询价单还没定标，不能转采购单');
  const q = e.quotes.find((x) => x.id === e.awardedQuoteId)!;
  // 物料的包装换算改过了：数量与单价对不上，重新询价
  const mats = await deps.sql<{ id: number; purchaseUnit: string; purchaseFactorMilli: number }[]>`
    SELECT id, purchase_unit, purchase_factor_milli FROM materials WHERE id IN ${deps.sql(e.lines.map((l) => l.materialId))}`;
  for (const l of e.lines) {
    const m = mats.find((x) => Number(x.id) === l.materialId);
    if (!m || m.purchaseUnit !== l.purchaseUnit || Number(m.purchaseFactorMilli) !== l.factorMilli) {
      throw conflict('SOURCING_UNIT_CHANGED', `「${l.materialName}」的采购单位或换算改过了，请重新询价`);
    }
  }
  const today = todayIn(deps.config.timezone);
  const note = `询价单 ${e.docNo}：${e.title}${q.freightCents > 0 ? `；运费 ¥${formatAmount(q.freightCents)} 另计` : ''}`.slice(0, 200);
  return createPo(
    deps,
    {
      clientKey,
      supplierId: q.supplier.id,
      orderDate: today,
      expectedDate: e.needBy && e.needBy >= today ? e.needBy : null,
      note,
      action: 'save',
      lines: e.lines.map((l) => ({
        materialId: l.materialId,
        purchaseQtyMilli: l.purchaseQtyMilli,
        priceCents: q.prices.find((p) => p.lineId === l.id)!.priceCents,
        spec: l.spec,
        // 从需求单发起的询价（v0.7.30）：需求行一起带到采购单行上，需求单的进度由采购单算
        ...(l.requests.length ? { requestLineIds: l.requests.map((r) => r.lineId) } : {}),
      })),
    },
    actor,
    { ip, sourcingEventId: eventId },
  );
}

// ───────────────────────── 价格曲线 ─────────────────────────

export async function priceHistory(db: Db, timezone: string, materialId: number, months = 12): Promise<PriceHistory> {
  const [m] = await db<{ name: string }[]>`SELECT name FROM materials WHERE id = ${materialId}`;
  if (!m) throw notFound('物料不存在');
  const since = shiftDate(todayIn(timezone), -Math.round(months * 30.5));
  const basis = (await loadInventorySettings(db)).priceBasis;
  const points = await db<PriceHistory['points']>`
    SELECT * FROM (
      SELECT d.doc_date::text AS date, 'receipt'::text AS source, d.doc_no, s.name AS supplier_name, l.price_cents, l.purchase_unit, l.qty_milli
      FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id JOIN suppliers s ON s.id = d.supplier_id
      WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND l.material_id = ${materialId} AND l.qty_milli > 0
        AND l.price_cents IS NOT NULL AND d.price_basis = ${basis} AND d.doc_date >= ${since}
      UNION ALL
      SELECT (q.created_at AT TIME ZONE ${timezone})::date::text, 'quote', e.doc_no, s.name, ql.price_cents, sl.purchase_unit, NULL
      FROM sourcing_quote_lines ql JOIN sourcing_quotes q ON q.id = ql.quote_id JOIN sourcing_lines sl ON sl.id = ql.sourcing_line_id
      JOIN sourcing_events e ON e.id = q.event_id JOIN suppliers s ON s.id = q.supplier_id
      WHERE sl.material_id = ${materialId} AND q.status = 'active' AND e.status <> 'cancelled'
        AND (q.created_at AT TIME ZONE ${timezone})::date >= ${since}
    ) t
    ORDER BY t.date, t.doc_no`;
  return {
    materialId,
    materialName: m.name,
    points: points.map((p) => ({ ...p, priceCents: Number(p.priceCents), qtyMilli: p.qtyMilli === null ? null : Number(p.qtyMilli) })),
  };
}

// ───────────────────────── 自检 ─────────────────────────

/**
 * 询价单与采购单的关联一致（v0.7.29）：没撤回的采购单关联的询价单都是已定标；已定标的询价单中标的是自己的、没撤下的报价；
 * 有效报价每行都报了、货款 = 各行金额之和。
 */
export async function sourcingChecks(db: Db): Promise<{ key: string; label: string; ok: boolean; detail: string }[]> {
  const bad = await db<{ docNo: string; why: string }[]>`
    SELECT e.doc_no, '关联的采购单 ' || po.doc_no || ' 没撤回，询价单却不是已定标' AS why
    FROM purchase_orders po JOIN sourcing_events e ON e.id = po.sourcing_event_id
    WHERE po.status <> 'cancelled' AND e.status <> 'awarded'
    UNION ALL
    SELECT e.doc_no, '中标的报价不是这张询价单的有效报价' FROM sourcing_events e LEFT JOIN sourcing_quotes q ON q.id = e.awarded_quote_id
    WHERE e.status = 'awarded' AND (q.id IS NULL OR q.event_id <> e.id OR q.status <> 'active')
    UNION ALL
    SELECT e.doc_no, '报价 #' || q.id || ' 没报全部物料或货款与各行金额之和不一致'
    FROM sourcing_quotes q JOIN sourcing_events e ON e.id = q.event_id
    WHERE q.status = 'active' AND (
      (SELECT count(*) FROM sourcing_quote_lines ql JOIN sourcing_lines sl ON sl.id = ql.sourcing_line_id AND sl.event_id = q.event_id WHERE ql.quote_id = q.id)
        <> (SELECT count(*) FROM sourcing_lines sl WHERE sl.event_id = q.event_id)
      OR q.goods_cents <> coalesce((SELECT sum(ql.amount_cents) FROM sourcing_quote_lines ql WHERE ql.quote_id = q.id), 0))
    UNION ALL
    SELECT min(e.doc_no), '需求行 #' || sr.request_line_id || ' 同时在 ' || count(DISTINCT e.id) || ' 张没撤销的询价单里'
    FROM sourcing_line_requests sr JOIN sourcing_lines sl ON sl.id = sr.sourcing_line_id JOIN sourcing_events e ON e.id = sl.event_id
    WHERE e.status <> 'cancelled'
    GROUP BY sr.request_line_id HAVING count(DISTINCT e.id) > 1
    ORDER BY 1 LIMIT 20`;
  const [n] = await db<{ events: number; linked: number }[]>`
    SELECT (SELECT count(*)::int FROM sourcing_events) AS events,
           (SELECT count(*)::int FROM purchase_orders WHERE sourcing_event_id IS NOT NULL AND status <> 'cancelled') AS linked`;
  return [
    {
      key: 'sourcing_links',
      label: '询价单与采购单的关联一致',
      ok: bad.length === 0,
      detail: bad.length ? bad.map((b) => `${b.docNo}：${b.why}`).join('；') : `${n!.events} 张询价单，${n!.linked} 张采购单来自询价单`,
    },
  ];
}

// ───────────────────────── 路由 ─────────────────────────

const ListQuery = z.object({ status: z.enum(['open', 'awarded', 'cancelled']).optional(), q: z.string().trim().max(32).optional() });

export function registerSourcingRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const eventId = (req: FastifyRequest) => parse(idParam, req.params).id;

  app.get('/api/purchase-sourcing', { preHandler: guard('inventory.read') }, async (req) => readSnapshot(sql, (tx) => listSourcing(tx, parse(ListQuery, req.query))));
  app.get('/api/purchase-sourcing/by-key/:key', { preHandler: guard('inventory.read') }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid() }), req.params);
    const [row] = await sql<{ id: number }[]>`SELECT id FROM sourcing_events WHERE client_key = ${key}`;
    if (row) return { found: true, event: await getSourcing(sql, Number(row.id)) };
    const [quote] = await sql<{ eventId: number }[]>`SELECT event_id FROM sourcing_quotes WHERE client_key = ${key}`;
    return quote ? { found: true, event: await getSourcing(sql, Number(quote.eventId)) } : { found: false };
  });
  app.get('/api/purchase-sourcing/:id', { preHandler: guard('inventory.read') }, async (req) => readSnapshot(sql, (tx) => getSourcing(tx, eventId(req))));
  app.post('/api/purchase-sourcing', { preHandler: guard('purchase.manage') }, async (req, reply) => {
    const r = await createSourcing(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.post('/api/purchase-sourcing/:id/quotes', { preHandler: guard('purchase.manage') }, async (req) => addQuote(deps, eventId(req), req.body, req.actor, req.ip));
  app.post('/api/purchase-sourcing/quotes/:id/withdraw', { preHandler: guard('purchase.manage') }, async (req) => withdrawQuote(deps, eventId(req), req.body, req.actor));
  // 单一来源由负责人定标：负责人没有编制采购单的权限也能定标（普通定标采购、负责人都可以）
  app.post('/api/purchase-sourcing/:id/award', { preHandler: guardAny('purchase.manage', 'inventory.approve') }, async (req) => awardSourcing(deps, eventId(req), req.body, req.actor));
  app.post('/api/purchase-sourcing/:id/reopen', { preHandler: guard('purchase.manage') }, async (req) => reopenSourcing(deps, eventId(req), req.body, req.actor));
  app.post('/api/purchase-sourcing/:id/cancel', { preHandler: guard('purchase.manage') }, async (req) => cancelSourcing(deps, eventId(req), req.body, req.actor));
  app.post('/api/purchase-sourcing/:id/order', { preHandler: guard('purchase.manage') }, async (req, reply) => {
    const r = await orderFromSourcing(deps, eventId(req), req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  app.get('/api/purchase-price-history', { preHandler: guard('inventory.read') }, async (req) => {
    const { materialId, months } = parse(z.object({ materialId: z.coerce.number().int().positive(), months: z.coerce.number().int().min(1).max(24).default(12) }), req.query);
    return readSnapshot(sql, (tx) => priceHistory(tx, config.timezone, materialId, months));
  });
}
