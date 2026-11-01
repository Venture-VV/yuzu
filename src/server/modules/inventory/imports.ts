// 供应商与期初未付批量导入（#16，v0.7.12，见 docs/SUPPLIER_SETTLEMENT.md 第 6 节）。
//
// 文件：CSV（浏览器按 UTF-8 / GBK 识别后提交文字）或 Excel（.xlsx，提交原文件，读第一个工作表）。第一行是表头，按列名找。
// 先预览：逐行校验，有任何一行有问题整份不能写入；写入在一个事务里，整份要么全写、要么不写。
// 同一个文件（按内容摘要）只能写入一次：重复提交得到原来那次的结果。供应商编码已存在的不覆盖。
// 期初未付写入后按「期初」规则走确认（免确认门槛以内的直接确认，超过的进负责人待办，可以一次确认整批）。
// 真实业务数据：门店环境须店主同意才执行（同其他导入，AGENTS.md）。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ERP_IMPORT_LABELS,
  OPENING_IMPORT_COLUMNS,
  SUPPLIER_IMPORT_COLUMNS,
  type ErpImportKind,
  type ErpImportPreview,
  type ErpImportRecord,
  type ErpImportRowIssue,
} from '@shared/purchasing';
import { parseYuan } from '@shared/money';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { badRequest, conflict, forbidden, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { idParam, parse } from '../../lib/validate';
import { readXlsx, serialToDate, XlsxReadError } from '../../lib/xlsx-read';
import { loadInventorySettings, logApproval, nextDocNo, overThreshold, setTxTimeouts, todayIn } from './common';
import { erpOpAbandoned } from '../erp-ops';
import { actOnOpening, confirmOpening, lockSupplier } from './payables';

const hashRequest = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

/** 一份文件最多多少行 */
export const IMPORT_MAX_ROWS = 2000;

const FileFields = z.object({
  kind: z.enum(['suppliers', 'opening_payables']),
  fileName: z.string().trim().min(1, '缺少文件名').max(200, '文件名太长'),
  /** CSV 的文字（浏览器已识别 UTF-8 / GBK） */
  csv: z.string().max(2_000_000, '文件太大，请分批导入').optional(),
  /** Excel 原文件（base64） */
  xlsxBase64: z.string().max(2_800_000, '文件太大，请分批导入').optional(),
  encoding: z.string().max(16).default(''),
});
const oneFile = (f: { csv?: string; xlsxBase64?: string }) => !!f.csv !== !!f.xlsxBase64;
const FileInput = FileFields.refine(oneFile, { message: '请选择一个 CSV 或 Excel 文件', path: ['csv'] });
/** 写入带操作编号：页面先把编号和原请求存在本机，断网后按编号查回或确认作废（AGENTS.md） */
const ApplyInput = FileFields.extend({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') }).refine(oneFile, {
  message: '请选择一个 CSV 或 Excel 文件',
  path: ['csv'],
});
type FileInputData = z.infer<typeof FileInput>;

interface Sheet {
  sha256: string;
  header: string[];
  /** 文件行号（表头是第 1 行）→ 单元格 */
  rows: { row: number; cells: string[] }[];
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function readSheet(f: FileInputData, dateColumns: string[]): Sheet {
  if (f.csv !== undefined) {
    const lines = f.csv.replace(/^﻿/, '').split(/\r?\n/);
    const headerAt = lines.findIndex((l) => l.trim() !== '');
    if (headerAt < 0) throw unprocessable('IMPORT_EMPTY', '文件是空的');
    const header = splitCsvLine(lines[headerAt]!);
    const rows: Sheet['rows'] = [];
    for (let i = headerAt + 1; i < lines.length; i++) {
      if (lines[i]!.trim() === '') continue;
      rows.push({ row: i + 1, cells: splitCsvLine(lines[i]!) });
    }
    return { sha256: createHash('sha256').update(f.csv, 'utf8').digest('hex'), header, rows };
  }
  const buf = Buffer.from(f.xlsxBase64!, 'base64');
  let book;
  try {
    book = readXlsx(buf);
  } catch (error) {
    if (error instanceof XlsxReadError) throw unprocessable('IMPORT_FILE_INVALID', error.message);
    throw error;
  }
  const sheet = book.sheets[0];
  if (!sheet) throw unprocessable('IMPORT_EMPTY', 'Excel 文件里没有工作表');
  const rowNos = [...sheet.rows.keys()].sort((a, b) => a - b);
  const textAt = (r: number, c: number) => {
    const cell = sheet.rows.get(r)?.get(c);
    return (cell?.value ?? '').trim();
  };
  const headerRow = rowNos.find((r) => [...(sheet.rows.get(r)?.values() ?? [])].some((c) => (c.value ?? '').trim() !== ''));
  if (headerRow === undefined) throw unprocessable('IMPORT_EMPTY', '文件是空的');
  const width = Math.max(...[...sheet.rows.get(headerRow)!.keys()]) + 1;
  const header = Array.from({ length: width }, (_, c) => textAt(headerRow, c));
  const dateCols = new Set(dateColumns.map((name) => header.indexOf(name)).filter((i) => i >= 0));
  const rows: Sheet['rows'] = [];
  for (const r of rowNos) {
    if (r <= headerRow) continue;
    const cells = Array.from({ length: width }, (_, c) => {
      const cell = sheet.rows.get(r)?.get(c);
      const text = (cell?.value ?? '').trim();
      // Excel 的日期存成序号
      if (dateCols.has(c) && cell?.type === 'number' && /^\d+(\.\d+)?$/.test(text)) return serialToDate(Number(text)) ?? text;
      return text;
    });
    if (cells.every((c) => c === '')) continue;
    rows.push({ row: r, cells });
  }
  return { sha256: createHash('sha256').update(buf).digest('hex'), header, rows };
}

const SETTLEMENT_NAMES: Record<string, 'credit' | 'cash'> = { '': 'credit', 挂账: 'credit', 月结: 'credit', 现付: 'cash', 现结: 'cash' };

/** 2026/1/5、2026-01-05、2026.1.5 → 2026-01-05 */
function isoDate(text: string): string | null {
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

interface SupplierRow {
  row: number;
  code: string;
  name: string;
  contact: string;
  phone: string;
  settlement: 'credit' | 'cash';
  note: string;
}
interface OpeningRow {
  row: number;
  supplierCode: string;
  supplierId: number | null;
  amountCents: number;
  asOfDate: string;
  note: string;
}

interface Plan {
  sheet: Sheet;
  issues: ErpImportRowIssue[];
  suppliers: SupplierRow[];
  openings: OpeningRow[];
  totalCents: number;
}

/** 解析并逐行校验（预览与写入用同一套；写入时在事务里再查一次编码与供应商） */
async function plan(db: Db, f: FileInputData, timeZone: string): Promise<Plan> {
  const columns: readonly string[] = f.kind === 'suppliers' ? SUPPLIER_IMPORT_COLUMNS : OPENING_IMPORT_COLUMNS;
  const sheet = readSheet(f, f.kind === 'opening_payables' ? ['截至日期'] : []);
  const issues: ErpImportRowIssue[] = [];
  const required = f.kind === 'suppliers' ? ['编码', '名称'] : ['供应商编码', '金额', '截至日期'];
  const col = new Map(columns.map((c) => [c, sheet.header.indexOf(c)]));
  const missing = required.filter((c) => col.get(c)! < 0);
  if (missing.length) {
    return { sheet, issues: [{ row: 1, message: `表头缺少「${missing.join('」「')}」列（模板的列：${columns.join('、')}）` }], suppliers: [], openings: [], totalCents: 0 };
  }
  if (sheet.rows.length === 0) issues.push({ row: 1, message: '文件里只有表头，没有要导入的行' });
  if (sheet.rows.length > IMPORT_MAX_ROWS) issues.push({ row: 1, message: `一份文件最多 ${IMPORT_MAX_ROWS} 行，请分批导入` });
  const cell = (r: Sheet['rows'][number], name: string) => {
    const i = col.get(name) ?? -1;
    return i >= 0 ? (r.cells[i] ?? '').trim() : '';
  };

  if (f.kind === 'suppliers') {
    const existing = new Set((await db<{ code: string }[]>`SELECT code FROM suppliers`).map((s) => s.code));
    const seen = new Map<string, number>();
    const suppliers: SupplierRow[] = [];
    for (const r of sheet.rows) {
      const p: string[] = [];
      const code = cell(r, '编码');
      const name = cell(r, '名称');
      const settlementText = cell(r, '结算方式');
      if (!code) p.push('编码为空');
      else if (code.length > 16) p.push('编码超过 16 个字');
      else if (existing.has(code)) p.push(`编码 ${code} 已有供应商（导入不覆盖，要改请在档案里改）`);
      else if (seen.has(code)) p.push(`编码 ${code} 与第 ${seen.get(code)} 行重复`);
      if (!name) p.push('名称为空');
      else if (name.length > 40) p.push('名称超过 40 个字');
      if (cell(r, '联系人').length > 40) p.push('联系人超过 40 个字');
      if (cell(r, '电话').length > 32) p.push('电话超过 32 个字');
      if (cell(r, '备注').length > 200) p.push('备注超过 200 个字');
      const settlement = SETTLEMENT_NAMES[settlementText];
      if (!settlement) p.push(`结算方式「${settlementText}」只能写挂账或现付（空着按挂账）`);
      if (code) seen.set(code, r.row);
      if (p.length) issues.push({ row: r.row, message: p.join('；') });
      else suppliers.push({ row: r.row, code, name, contact: cell(r, '联系人'), phone: cell(r, '电话'), settlement: settlement!, note: cell(r, '备注') });
    }
    return { sheet, issues, suppliers, openings: [], totalCents: 0 };
  }

  const today = todayIn(timeZone);
  const supplierByCode = new Map((await db<{ id: number; code: string; active: boolean }[]>`SELECT id, code, active FROM suppliers`).map((s) => [s.code, s]));
  const openings: OpeningRow[] = [];
  let totalCents = 0;
  for (const r of sheet.rows) {
    const p: string[] = [];
    const code = cell(r, '供应商编码');
    const s = supplierByCode.get(code);
    if (!code) p.push('供应商编码为空');
    else if (!s) p.push(`没有编码为 ${code} 的供应商（先导入或建好供应商）`);
    else if (!s.active) p.push(`供应商 ${code} 已停用`);
    const amountText = cell(r, '金额').replace(/[¥￥元]/g, '');
    const amount = parseYuan(amountText);
    if (amount === null || amount <= 0) p.push(`金额「${cell(r, '金额')}」要是大于 0 的金额（最多两位小数）`);
    else if (amount > 100_000_000_00) p.push('金额太大（单笔不超过 1 亿元）');
    const asOf = isoDate(cell(r, '截至日期'));
    if (!asOf) p.push(`截至日期「${cell(r, '截至日期')}」不是有效日期（如 2026-10-31）`);
    else if (asOf > today) p.push('截至日期不能晚于今天');
    if (cell(r, '备注').length > 200) p.push('备注超过 200 个字');
    if (p.length) issues.push({ row: r.row, message: p.join('；') });
    else {
      openings.push({ row: r.row, supplierCode: code, supplierId: s!.id, amountCents: amount!, asOfDate: asOf!, note: cell(r, '备注') });
      totalCents += amount!;
    }
  }
  return { sheet, issues, suppliers: [], openings, totalCents };
}

async function duplicateOf(db: Db, kind: ErpImportKind, sha256: string): Promise<ErpImportPreview['duplicateOf']> {
  const [row] = await db<NonNullable<ErpImportPreview['duplicateOf']>[]>`
    SELECT i.id, i.created_at, s.display_name AS created_by_name FROM erp_imports i JOIN staff s ON s.id = i.created_by
    WHERE i.kind = ${kind} AND i.file_sha256 = ${sha256}`;
  return row ?? null;
}

function assertKindPermission(actor: Actor, kind: ErpImportKind) {
  if (kind === 'suppliers' && !can(actor, 'inventory.master')) throw forbidden('导入供应商要有「维护物料、供应商、部门档案」');
  if (kind === 'opening_payables' && !can(actor, 'payable.manage')) throw forbidden('导入期初未付要有「登记期初未付、付款、核销与供应商退款」');
}

export async function previewImport(deps: Deps, raw: unknown, actor: Actor): Promise<ErpImportPreview> {
  const f = parse(FileInput, raw);
  assertKindPermission(actor, f.kind);
  const p = await plan(deps.sql, f, deps.config.timezone);
  const header = p.sheet.header;
  return {
    kind: f.kind,
    fileName: f.fileName,
    fileSha256: p.sheet.sha256,
    encoding: f.xlsxBase64 ? 'Excel' : f.encoding || 'UTF-8',
    rowCount: p.sheet.rows.length,
    totalCents: p.totalCents,
    issues: p.issues,
    duplicateOf: await duplicateOf(deps.sql, f.kind, p.sheet.sha256),
    sample: p.sheet.rows.slice(0, 20).map((r) => Object.fromEntries(header.map((h, i) => [h || `第 ${i + 1} 列`, r.cells[i] ?? '']))),
  };
}

export async function getImport(db: Db, importId: number): Promise<ErpImportRecord> {
  const [row] = await db<ErpImportRecord[]>`
    SELECT i.id, i.kind, i.file_name, i.row_count, i.total_cents, s.display_name AS created_by_name, i.created_at
    FROM erp_imports i JOIN staff s ON s.id = i.created_by WHERE i.id = ${importId}`;
  if (!row) throw unprocessable('IMPORT_NOT_FOUND', '导入记录不存在');
  return row;
}

/** 写入：整份在一个事务里；同一个文件只写一次（重复提交得到原来那次的结果） */
export async function applyImport(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ import: ErpImportRecord; replayed: boolean }> {
  const f = parse(ApplyInput, raw);
  assertKindPermission(actor, f.kind);
  const requestHash = hashRequest({ ...f, clientKey: undefined });
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    // 同一个操作编号排队：重提得到原来那次的结果；页面上确认作废过的编号晚到也不写入
    await lockOpKey(tx, f.clientKey);
    const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${f.clientKey}`;
    if (seen) {
      if (seen.opType !== 'erp_import' || seen.requestHash !== requestHash) {
        throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次导入，请刷新页面后重新选择文件');
      }
      return { id: Number(seen.refId), replayed: true };
    }
    await assertNotFenced(tx, f.clientKey, 'erp_import', erpOpAbandoned);
    const first = readSheet(f, f.kind === 'opening_payables' ? ['截至日期'] : []);
    // 同一个文件串行处理
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`erp_import:${f.kind}:${first.sha256}`}, 0))`;
    const keep = (importId: number) =>
      tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${f.clientKey}, 'erp_import', ${requestHash}, ${importId}, ${actor.id})`;
    const dup = await duplicateOf(tx, f.kind, first.sha256);
    if (dup) {
      await keep(dup.id);
      return { id: dup.id, replayed: true };
    }
    // 供应商编码唯一：导入供应商时与新建供应商串行
    if (f.kind === 'suppliers') await tx`LOCK TABLE suppliers IN SHARE ROW EXCLUSIVE MODE`;
    const p = await plan(tx, f, deps.config.timezone);
    if (p.issues.length) {
      throw unprocessable('IMPORT_INVALID', `有 ${p.issues.length} 行要先改好才能导入：${p.issues.slice(0, 3).map((i) => `第 ${i.row} 行 ${i.message}`).join('；')}`, {
        issues: p.issues,
      });
    }
    const [imp] = await tx<{ id: number }[]>`
      INSERT INTO erp_imports (kind, file_name, file_sha256, row_count, total_cents, created_by)
      VALUES (${f.kind}, ${f.fileName}, ${p.sheet.sha256}, ${p.sheet.rows.length}, ${p.totalCents}, ${actor.id})
      RETURNING id`;
    const importId = imp!.id;
    await keep(importId);
    if (f.kind === 'suppliers') {
      for (const s of p.suppliers) {
        await tx`
          INSERT INTO suppliers (code, name, contact, phone, note, settlement, import_id)
          VALUES (${s.code}, ${s.name}, ${s.contact}, ${s.phone}, ${s.note}, ${s.settlement}, ${importId})`;
      }
    } else {
      await importOpenings(tx, p.openings, importId, actor);
    }
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'erp_import',
      targetType: 'erp_import',
      targetId: importId,
      detail: { kind: f.kind, fileName: f.fileName, rows: p.sheet.rows.length, totalCents: p.totalCents, sha256: p.sheet.sha256 },
      ip,
    });
    return { id: importId, replayed: false };
  });
  return { import: await getImport(deps.sql, r.id), replayed: r.replayed };
}

/** 期初未付：逐笔登记（同逐条登记的规则），免确认门槛以内的直接确认；按供应商 id 升序锁供应商 */
async function importOpenings(tx: Tx, rows: OpeningRow[], importId: number, actor: Actor) {
  const settings = await loadInventorySettings(tx);
  for (const supplierId of [...new Set(rows.map((r) => r.supplierId!))].sort((a, b) => a - b)) await lockSupplier(tx, supplierId);
  for (const o of rows) {
    const docNo = await nextDocNo(tx, 'opening_payable', 'QF', o.asOfDate);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO opening_payables (doc_no, supplier_id, amount_cents, as_of_date, note, status, created_by, import_id)
      VALUES (${docNo}, ${o.supplierId}, ${o.amountCents}, ${o.asOfDate}, ${o.note || `批量导入第 ${o.row} 行`}, 'submitted', ${actor.id}, ${importId})
      RETURNING id`;
    await logApproval(tx, 'opening_payable', row!.id, 'create', actor.id);
    await logApproval(tx, 'opening_payable', row!.id, 'submit', actor.id);
    if (!(settings.approvalRules.opening && overThreshold(settings, o.amountCents))) {
      await confirmOpening(tx, { id: row!.id, supplierId: o.supplierId!, amountCents: o.amountCents, asOfDate: o.asOfDate }, actor);
    }
  }
}

export async function listImports(db: Db): Promise<ErpImportRecord[]> {
  return db<ErpImportRecord[]>`
    SELECT i.id, i.kind, i.file_name, i.row_count, i.total_cents, s.display_name AS created_by_name, i.created_at
    FROM erp_imports i JOIN staff s ON s.id = i.created_by ORDER BY i.id DESC LIMIT 100`;
}

export function registerImportRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const bodyLimit = 4 * 1024 * 1024;
  const anyImport = guardAny('inventory.master', 'payable.manage');
  // 导入记录：负责人也能看（导入的期初未付超过门槛时在这里一次确认整批），只读
  app.get('/api/payables/imports', { preHandler: guardAny('inventory.master', 'payable.manage', 'inventory.approve') }, async () => listImports(sql));
  app.post('/api/payables/imports/preview', { preHandler: anyImport, bodyLimit }, async (req) => previewImport(deps, req.body, req.actor));
  app.post('/api/payables/imports', { preHandler: anyImport, bodyLimit }, async (req, reply) => {
    const r = await applyImport(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  // 导入的期初未付超过门槛的要负责人确认：可以一次确认整批（逐笔走原来的确认）
  app.post('/api/payables/imports/:id/approve-openings', { preHandler: guard('inventory.approve') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const imp = await getImport(sql, id);
    if (imp.kind !== 'opening_payables') throw badRequest(`这份是${ERP_IMPORT_LABELS[imp.kind]}导入，没有要确认的期初未付`);
    const pending = await sql<{ id: number }[]>`SELECT id FROM opening_payables WHERE import_id = ${id} AND status = 'submitted' ORDER BY id`;
    for (const o of pending) await actOnOpening(deps, o.id, 'approve', {}, req.actor);
    return { approved: pending.length };
  });
}
