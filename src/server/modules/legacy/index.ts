// 8–10 月旧账只读对照（v0.7.10，飞书需求 RQ-005 收尾，见 docs/LEGACY_LEDGER.md）：导入、读取、作废与只读接口。
// 旧账只在这几张只读表里，不进正式账；任何正式的报表、台账、平账、账目自检、check 都不读这些表。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LEGACY_SOURCES,
  type LegacyBrandLine,
  type LegacyImport,
  type LegacyLedgerLine,
  type LegacyMaterialLine,
  type LegacyOrderedLine,
  type LegacyPaymentDay,
  type LegacySource,
} from '@shared/legacy';
import { readSnapshot, type Db, type Sql } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import type { InvoiceTypeDef } from '@shared/expenses';
import { loadExpenseRules } from '../expenses';
import { legacyAudit, type LegacyData } from './audit';
import { parseLegacyWorkbook, type ParsedLegacy } from './parse';

export { parseLegacyWorkbook, LegacyParseError } from './parse';

// ───────────────────────── 读取 ─────────────────────────

async function activeImports(db: Db): Promise<LegacyImport[]> {
  return db<LegacyImport[]>`
    SELECT i.id, i.source, i.file_name, i.sha256, i.status, i.sheets, i.file_totals, ib.display_name AS imported_by_name, i.imported_at,
           vb.display_name AS voided_by_name, i.voided_at, i.void_reason
    FROM legacy_imports i JOIN staff ib ON ib.id = i.imported_by LEFT JOIN staff vb ON vb.id = i.voided_by
    WHERE i.status = 'active' ORDER BY i.id`;
}

export async function listLegacyImports(db: Db): Promise<LegacyImport[]> {
  return db<LegacyImport[]>`
    SELECT i.id, i.source, i.file_name, i.sha256, i.status, i.sheets, i.file_totals, ib.display_name AS imported_by_name, i.imported_at,
           vb.display_name AS voided_by_name, i.voided_at, i.void_reason
    FROM legacy_imports i JOIN staff ib ON ib.id = i.imported_by LEFT JOIN staff vb ON vb.id = i.voided_by
    ORDER BY i.id DESC`;
}

const LEDGER_SQL = (db: Db, importId: number) => db<LegacyLedgerLine[]>`
  SELECT row_no, seq, entry_date AS date, date_text, item, qty_text, amount_cents, amount_formula, merchant, purpose, invoice, note,
         merged_into, pre_header, raw
  FROM legacy_ledger_lines WHERE import_id = ${importId} ORDER BY row_no`;
const PAYMENT_SQL = (db: Db, importId: number) => db<LegacyPaymentDay[]>`
  SELECT row_no, pay_date AS date, date_text, advance_cents, advance_formula, should_return_cents, should_return_formula,
         returned_cents, returned_formula, note, raw
  FROM legacy_payment_days WHERE import_id = ${importId} ORDER BY row_no`;
const MATERIAL_SQL = (db: Db, importId: number) => db<LegacyMaterialLine[]>`
  SELECT sheet, row_no, seq, buy_date AS date, date_text, item, purpose, amount_cents, amount_formula, bought_text, bought_milli,
         received_text, received_milli, department, invoice, tax_text, tax_rate_bp, category, merged_into, raw
  FROM legacy_material_lines WHERE import_id = ${importId}`;
const ORDERED_SQL = (db: Db, importId: number) => db<LegacyOrderedLine[]>`
  SELECT sheet, row_no, order_date AS date, date_text, product, image_id, image_shared, variant, department, orderer, qty_text, qty_milli,
         amount_cents, amount_formula, note, merged_into, raw
  FROM legacy_ordered_lines WHERE import_id = ${importId}`;
const BRAND_SQL = (db: Db, importId: number) => db<LegacyBrandLine[]>`
  SELECT row_no, seq, ordered, received, returned, product, purpose, qty_text, qty_milli, note, details, link_text, link_url, raw
  FROM legacy_brand_requests WHERE import_id = ${importId} ORDER BY row_no`;

/** 按工作表在文件里的先后排（sheets 记着顺序），同一张表按行号 */
function bySheetOrder<T extends { sheet: string; rowNo: number }>(rows: T[], sheets: { name: string }[]): T[] {
  const order = new Map(sheets.map((s, i) => [s.name, i]));
  return [...rows].sort((a, b) => (order.get(a.sheet) ?? 0) - (order.get(b.sheet) ?? 0) || a.rowNo - b.rowNo);
}

export interface LegacyBook {
  imports: LegacyImport[];
  ledger: LegacyLedgerLine[];
  payments: LegacyPaymentDay[];
  materials: LegacyMaterialLine[];
  ordered: LegacyOrderedLine[];
  brand: LegacyBrandLine[];
  /** 新账的发票字典（核验第 5 条按它核对） */
  invoiceTypes: InvoiceTypeDef[];
}

export async function loadLegacyBook(db: Db): Promise<LegacyBook> {
  const imports = await activeImports(db);
  const of = (s: LegacySource) => imports.find((i) => i.source === s);
  const { invoiceTypes } = await loadExpenseRules(db);
  const book: LegacyBook = { imports, ledger: [], payments: [], materials: [], ordered: [], brand: [], invoiceTypes };
  const pl = of('purchase_ledger');
  if (pl) {
    book.ledger = await LEDGER_SQL(db, pl.id);
    book.payments = await PAYMENT_SQL(db, pl.id);
  }
  const md = of('material_detail');
  if (md) book.materials = bySheetOrder(await MATERIAL_SQL(db, md.id), md.sheets);
  const om = of('ordered_materials');
  if (om) book.ordered = bySheetOrder(await ORDERED_SQL(db, om.id), om.sheets);
  const br = of('brand_requests');
  if (br) book.brand = await BRAND_SQL(db, br.id);
  return book;
}

function dataOf(book: LegacyBook): LegacyData {
  const of = (s: LegacySource) => book.imports.find((i) => i.source === s);
  const pl = of('purchase_ledger');
  const md = of('material_detail');
  const br = of('brand_requests');
  const brSheet = br?.sheets[0];
  return {
    imported: book.imports.map((i) => i.source),
    ledger: book.ledger,
    ledgerSheet: pl?.sheets[0]?.name ?? '',
    payments: book.payments,
    paymentSheet: pl?.sheets[1]?.name ?? '',
    materials: book.materials,
    materialSheets: md?.sheets.map((s) => ({ name: s.name, rows: s.rows })) ?? [],
    ordered: book.ordered.map(({ imageId, raw: _, ...o }) => ({ ...o, hasImage: imageId !== null })),
    brand: book.brand,
    brandSheet: brSheet?.name ?? '',
    brandTableRows: brSheet ? brSheet.rowElements - brSheet.headerRow : null,
    invoiceTypes: book.invoiceTypes,
  };
}

export async function legacyAuditOf(db: Db) {
  return legacyAudit(dataOf(await loadLegacyBook(db)));
}

// ───────────────────────── 导入 ─────────────────────────

export interface LegacyFileMeta {
  fileName: string;
  sha256: string;
  bytes: number;
}

export const fileMeta = (fileName: string, buf: Buffer): LegacyFileMeta => ({
  fileName: fileName.slice(-200),
  sha256: createHash('sha256').update(buf).digest('hex'),
  bytes: buf.length,
});

/** 预览：数据库里其他几份有效的旧账 + 这份文件，一起算核验（这份表替换数据库里同一份表的旧导入） */
export async function previewLegacyImport(db: Db, parsed: ParsedLegacy, meta: LegacyFileMeta) {
  const book = await loadLegacyBook(db);
  const sheets = parsed.sheets;
  const fake: LegacyImport = {
    id: 0,
    source: parsed.source,
    fileName: meta.fileName,
    sha256: meta.sha256,
    status: 'active',
    sheets,
    fileTotals: parsed.fileTotals,
    importedByName: '',
    importedAt: new Date().toISOString(),
    voidedByName: null,
    voidedAt: null,
    voidReason: null,
  };
  const existing = book.imports.find((i) => i.source === parsed.source) ?? null;
  book.imports = [...book.imports.filter((i) => i.source !== parsed.source), fake];
  if (parsed.source === 'purchase_ledger') {
    book.ledger = parsed.ledger;
    book.payments = parsed.payments;
  } else if (parsed.source === 'material_detail') book.materials = parsed.materials;
  else if (parsed.source === 'ordered_materials') book.ordered = parsed.ordered.map(({ imageKey, ...o }) => ({ ...o, imageId: imageKey ? 1 : null }));
  else book.brand = parsed.brand;
  return { audit: legacyAudit(dataOf(book)), existing };
}

const CHUNK = 400;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InsertRow = Record<string, any>;
async function insertChunks(tx: Db, table: string, rows: InsertRow[], columns: string[]) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await tx`INSERT INTO ${tx(table)} ${tx(part, columns)}`;
  }
}

/**
 * 写入只读表。同一份文件（内容摘要相同）已是有效导入时直接返回原来那次；
 * 这份表已有别的有效导入时，要给替换原因（旧的作废，留原因与经办人），否则拒绝。
 */
export async function applyLegacyImport(sql: Sql, parsed: ParsedLegacy, meta: LegacyFileMeta, opts: { operatorId: number; replaceReason?: string | null }) {
  return sql.begin(async (tx) => {
    // 同一份表的导入排队（并发导入时后一次看得到前一次）
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy_import:${parsed.source}`}, 0))`;
    const [current] = await tx<{ id: number; sha256: string }[]>`
      SELECT id, sha256 FROM legacy_imports WHERE source = ${parsed.source} AND status = 'active'`;
    if (current && current.sha256 === meta.sha256) return { importId: Number(current.id), replayed: true, voidedId: null as number | null };
    let voidedId: number | null = null;
    if (current) {
      const reason = opts.replaceReason?.trim() ?? '';
      if (reason.length < 2) throw conflict('LEGACY_IMPORT_EXISTS', `这份表已经导入过（第 ${current.id} 次导入）。要换成这个文件，请写替换原因（--replace "原因"），旧的会作废`);
      await tx`UPDATE legacy_imports SET status = 'voided', voided_by = ${opts.operatorId}, voided_at = now(), void_reason = ${reason.slice(0, 200)} WHERE id = ${current.id}`;
      voidedId = Number(current.id);
    }
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO legacy_imports (source, file_name, sha256, file_bytes, sheets, file_totals, warnings, imported_by)
      VALUES (${parsed.source}, ${meta.fileName}, ${meta.sha256}, ${meta.bytes}, ${tx.json(parsed.sheets as never)},
              ${tx.json(parsed.fileTotals as never)}, ${tx.json(parsed.warnings as never)}, ${opts.operatorId})
      RETURNING id`;
    const id = Number(row!.id);
    const json = (v: unknown) => tx.json(v as never);
    if (parsed.source === 'purchase_ledger') {
      await insertChunks(
        tx,
        'legacy_ledger_lines',
        parsed.ledger.map((l) => ({
          import_id: id, row_no: l.rowNo, seq: l.seq, entry_date: l.date, date_text: l.dateText, item: l.item, qty_text: l.qtyText,
          amount_cents: l.amountCents, amount_formula: l.amountFormula, merchant: l.merchant, purpose: l.purpose, invoice: l.invoice,
          note: l.note, merged_into: l.mergedInto, pre_header: l.preHeader, raw: json(l.raw),
        })),
        ['import_id', 'row_no', 'seq', 'entry_date', 'date_text', 'item', 'qty_text', 'amount_cents', 'amount_formula', 'merchant', 'purpose', 'invoice', 'note', 'merged_into', 'pre_header', 'raw'],
      );
      await insertChunks(
        tx,
        'legacy_payment_days',
        parsed.payments.map((p) => ({
          import_id: id, row_no: p.rowNo, pay_date: p.date, date_text: p.dateText, advance_cents: p.advanceCents, advance_formula: p.advanceFormula,
          should_return_cents: p.shouldReturnCents, should_return_formula: p.shouldReturnFormula, returned_cents: p.returnedCents,
          returned_formula: p.returnedFormula, note: p.note, raw: json(p.raw),
        })),
        ['import_id', 'row_no', 'pay_date', 'date_text', 'advance_cents', 'advance_formula', 'should_return_cents', 'should_return_formula', 'returned_cents', 'returned_formula', 'note', 'raw'],
      );
    } else if (parsed.source === 'material_detail') {
      await insertChunks(
        tx,
        'legacy_material_lines',
        parsed.materials.map((m) => ({
          import_id: id, sheet: m.sheet, row_no: m.rowNo, seq: m.seq, buy_date: m.date, date_text: m.dateText, item: m.item, purpose: m.purpose,
          amount_cents: m.amountCents, amount_formula: m.amountFormula, bought_text: m.boughtText, bought_milli: m.boughtMilli,
          received_text: m.receivedText, received_milli: m.receivedMilli, department: m.department, invoice: m.invoice, tax_text: m.taxText,
          tax_rate_bp: m.taxRateBp, category: m.category, merged_into: m.mergedInto, raw: json(m.raw),
        })),
        ['import_id', 'sheet', 'row_no', 'seq', 'buy_date', 'date_text', 'item', 'purpose', 'amount_cents', 'amount_formula', 'bought_text', 'bought_milli', 'received_text', 'received_milli', 'department', 'invoice', 'tax_text', 'tax_rate_bp', 'category', 'merged_into', 'raw'],
      );
    } else if (parsed.source === 'ordered_materials') {
      const imageIds = new Map<string, number>();
      for (const [key, img] of parsed.images) {
        if (img.data.length > 5 * 1024 * 1024) throw unprocessable('LEGACY_IMAGE_TOO_LARGE', `图片「${key}」超过 5 MB`);
        const [r] = await tx<{ id: number }[]>`
          INSERT INTO legacy_images (import_id, image_key, mime, data, size_bytes) VALUES (${id}, ${key}, ${img.mime}, ${img.data}, ${img.data.length}) RETURNING id`;
        imageIds.set(key, Number(r!.id));
      }
      await insertChunks(
        tx,
        'legacy_ordered_lines',
        parsed.ordered.map((o) => ({
          import_id: id, sheet: o.sheet, row_no: o.rowNo, order_date: o.date, date_text: o.dateText, product: o.product,
          image_id: o.imageKey ? (imageIds.get(o.imageKey) ?? null) : null, image_shared: o.imageShared, variant: o.variant,
          department: o.department, orderer: o.orderer, qty_text: o.qtyText, qty_milli: o.qtyMilli, amount_cents: o.amountCents,
          amount_formula: o.amountFormula, note: o.note, merged_into: o.mergedInto, raw: json(o.raw),
        })),
        ['import_id', 'sheet', 'row_no', 'order_date', 'date_text', 'product', 'image_id', 'image_shared', 'variant', 'department', 'orderer', 'qty_text', 'qty_milli', 'amount_cents', 'amount_formula', 'note', 'merged_into', 'raw'],
      );
    } else {
      await insertChunks(
        tx,
        'legacy_brand_requests',
        parsed.brand.map((b) => ({
          import_id: id, row_no: b.rowNo, seq: b.seq, ordered: b.ordered, received: b.received, returned: b.returned, product: b.product,
          purpose: b.purpose, qty_text: b.qtyText, qty_milli: b.qtyMilli, note: b.note, details: b.details, link_text: b.linkText,
          link_url: b.linkUrl, raw: json(b.raw),
        })),
        ['import_id', 'row_no', 'seq', 'ordered', 'received', 'returned', 'product', 'purpose', 'qty_text', 'qty_milli', 'note', 'details', 'link_text', 'link_url', 'raw'],
      );
    }
    await writeAudit(tx, {
      staffId: opts.operatorId,
      action: 'legacy_imported',
      targetType: 'legacy_import',
      targetId: id,
      detail: { source: parsed.source, fileName: meta.fileName, sha256: meta.sha256, sheets: parsed.sheets, replaced: voidedId },
    });
    return { importId: id, replayed: false, voidedId };
  });
}

export async function voidLegacyImport(sql: Sql, importId: number, reason: string, operatorId: number) {
  const text = reason.trim();
  if (text.length < 2) throw unprocessable('REASON_REQUIRED', '请写作废原因（至少 2 个字）');
  return sql.begin(async (tx) => {
    const [row] = await tx<{ status: string }[]>`SELECT status FROM legacy_imports WHERE id = ${importId} FOR UPDATE`;
    if (!row) throw notFound('没有这次导入');
    if (row.status !== 'active') throw conflict('LEGACY_IMPORT_VOIDED', '这次导入已经作废');
    await tx`UPDATE legacy_imports SET status = 'voided', voided_by = ${operatorId}, voided_at = now(), void_reason = ${text.slice(0, 200)} WHERE id = ${importId}`;
    await writeAudit(tx, { staffId: operatorId, action: 'legacy_import_voided', targetType: 'legacy_import', targetId: importId, detail: { reason: text } });
  });
}

/** 自检：每次有效导入写进去的行数与导入时记的一致（只读表没被动过） */
export async function legacyChecks(db: Db) {
  const imports = await activeImports(db);
  const bad: string[] = [];
  for (const i of imports) {
    const expected = i.sheets.reduce((s, x) => s + x.rows, 0);
    const [n] = await db<{ count: number }[]>`
      SELECT (SELECT count(*) FROM legacy_ledger_lines WHERE import_id = ${i.id}) + (SELECT count(*) FROM legacy_payment_days WHERE import_id = ${i.id})
           + (SELECT count(*) FROM legacy_material_lines WHERE import_id = ${i.id}) + (SELECT count(*) FROM legacy_ordered_lines WHERE import_id = ${i.id})
           + (SELECT count(*) FROM legacy_brand_requests WHERE import_id = ${i.id}) AS count`;
    if (Number(n!.count) !== expected) bad.push(`第 ${i.id} 次导入（${i.fileName}）记 ${expected} 行，表里 ${n!.count} 行`);
  }
  return {
    key: 'legacy_ledger',
    label: '旧账只读表与导入记录一致',
    ok: bad.length === 0,
    detail: bad.length ? bad.join('；') : `有效导入 ${imports.length} 份：${imports.map((i) => `${i.fileName} ${i.sheets.reduce((s, x) => s + x.rows, 0)} 行`).join('、') || '还没有导入'}；旧账不进正式账`,
  };
}

// ───────────────────────── 接口（只读） ─────────────────────────

const SourceParam = z.object({ source: z.enum(LEGACY_SOURCES) });

export function registerLegacyRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const read = { preHandler: guard('expense.read') };

  app.get('/api/erp/legacy/audit', read, async () => readSnapshot(sql, (tx) => legacyAuditOf(tx)));
  app.get('/api/erp/legacy/imports', read, async () => listLegacyImports(sql));
  app.get('/api/erp/legacy/rows/:source', read, async (req) => {
    const { source } = parse(SourceParam, req.params);
    const book = await readSnapshot(sql, (tx) => loadLegacyBook(tx));
    const imp = book.imports.find((i) => i.source === source) ?? null;
    if (source === 'purchase_ledger') return { import: imp, ledger: book.ledger, payments: book.payments };
    if (source === 'material_detail') return { import: imp, materials: book.materials };
    if (source === 'ordered_materials') return { import: imp, ordered: book.ordered };
    return { import: imp, brand: book.brand };
  });
  app.get('/api/erp/legacy/images/:id', read, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const [img] = await sql<{ mime: string; data: Buffer }[]>`
      SELECT g.mime, g.data FROM legacy_images g JOIN legacy_imports i ON i.id = g.import_id WHERE g.id = ${id} AND i.status = 'active'`;
    if (!img) throw notFound('图片不存在');
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(img.data);
  });
}
