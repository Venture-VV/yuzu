// 集采模板与一键导入（8.0.1 采购组整改 06，CG06，docs/PURCHASING_V801.md）：「采购 → 集采导入」。
// 下载标准模板（列与采购组的「集采需求表」一样）→ 上传 Excel 或 CSV → 逐行核对、预览 → 确认导入。
// 导入出来的需求单按「部门 + 优先级 + 期望到货日期」合成，直接是「已通过」（导入的就是供应链），进「待转采购单」；
// 申请人、采购途径、供应商记在行上；物品名称与物料档案一样的带上物料，不一样的按新产品（导入的不要求链接和图片）。
// 同一份文件（按内容摘要）只能导入一次；写入在一个事务里，有一行有问题整份不写。
// 加锁：操作编号的咨询锁（与「确认作废」串行）→ 同一份文件的咨询锁 → 写导入记录、需求单（都是新行，不锁已有的业务行）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  REQUEST_IMPORT_COLUMNS,
  REQUEST_IMPORT_MAX_ROWS,
  REQUEST_IMPORT_REQUIRED,
  type RequestImportPreview,
  type RequestImportResult,
  type RequestImportRow,
  type RequestPriority,
} from '@shared/requests';
import type { Db, Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { attachment } from '../lib/csv';
import { todayIn } from '../lib/dates';
import { conflict, unprocessable } from '../lib/errors';
import { assertNotFenced, lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { parse } from '../lib/validate';
import { readSheet } from '../lib/sheet-read';
import { buildXlsx } from '../lib/xlsx';
import { erpOpAbandoned } from './erp-ops';
import { loadExpenseRules } from './expenses';
import { logApproval } from './inventory/common';

const FileFields = z.object({
  fileName: z.string().trim().min(1, '缺少文件名').max(120, '文件名太长'),
  csv: z.string().max(2_000_000, '文件太大，请分批导入').optional(),
  xlsxBase64: z.string().max(2_800_000, '文件太大，请分批导入').optional(),
});
const oneFile = (f: { csv?: string; xlsxBase64?: string }) => !!f.csv !== !!f.xlsxBase64;
const PreviewInput = FileFields.refine(oneFile, { message: '请选择一个 Excel 或 CSV 文件', path: ['csv'] });
const ApplyInput = FileFields.extend({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') }).refine(oneFile, {
  message: '请选择一个 Excel 或 CSV 文件',
  path: ['csv'],
});

const PRIORITY_NAMES: Record<string, RequestPriority> = { '': 'normal', 普通: 'normal', 一般: 'normal', 紧急: 'urgent', 急: 'urgent', 加急: 'urgent' };
/** 采购途径：固定三类（CG08），认常见写法 */
function channelOf(text: string): RequestImportRow['channel'] | undefined {
  const t = text.replace(/\s|（|）|\(|\)|\//g, '');
  if (t === '') return null;
  if (t === '网购' || t === '网上' || t === '线上') return 'online';
  if (t.startsWith('自采') || t === '现采' || t === '零采' || t === '现采零采') return 'self';
  if (t === '供应商') return 'supplier';
  return undefined;
}
/** 2026/1/5、2026-01-05、2026.1.5、2026年1月5日 → 2026-01-05 */
function isoDate(text: string): string | null {
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
/** 数量：最多 3 位小数、大于 0 */
function qtyMilliOf(text: string): number | null {
  const t = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const v = Math.round(Number(t) * 1000);
  return v > 0 && v <= 1_000_000_000 ? v : null;
}

interface Plan {
  preview: RequestImportPreview;
  /** 用途：导入的都记成同一个用途（模板里没有这一列） */
  purpose: string;
}

async function plan(db: Db, f: z.infer<typeof PreviewInput>, timezone: string): Promise<Plan> {
  const sheet = readSheet(f, ['期望到货日期']);
  const col = (name: string) => sheet.header.indexOf(name);
  const missing = REQUEST_IMPORT_REQUIRED.filter((c) => col(c) < 0);
  if (missing.length) throw unprocessable('IMPORT_COLUMNS', `表头少了：${missing.join('、')}（请用「下载模板」的表头：${REQUEST_IMPORT_COLUMNS.join('、')}）`);
  const cell = (cells: string[], name: string) => {
    const i = col(name);
    return i < 0 ? '' : (cells[i] ?? '').trim();
  };
  // 只看要导入的列：全空的行（例如只填了序号的空行）跳过
  const rows = sheet.rows.filter((r) => ['申请部门', '物品名称', '单位', '数量'].some((c) => cell(r.cells, c) !== ''));
  if (rows.length === 0) throw unprocessable('IMPORT_EMPTY', '文件里没有要导入的行');
  if (rows.length > REQUEST_IMPORT_MAX_ROWS) throw unprocessable('IMPORT_TOO_MANY', `一份文件最多 ${REQUEST_IMPORT_MAX_ROWS} 行，请分批导入`);
  const today = todayIn(timezone);
  const depts = await db<{ id: number; name: string }[]>`SELECT id, name FROM departments WHERE active`;
  const sups = await db<{ id: number; name: string }[]>`SELECT id, name FROM suppliers WHERE active`;
  const mats = await db<{ id: number; name: string }[]>`SELECT id, name FROM materials WHERE active AND tracked`;
  const deptByName = new Map(depts.map((d) => [d.name.trim(), { id: Number(d.id), name: d.name }]));
  const supByName = new Map(sups.map((s) => [s.name.trim(), { id: Number(s.id), name: s.name }]));
  // 物料名称重复的不自动带（按新产品）
  const matCount = new Map<string, number>();
  for (const m of mats) matCount.set(m.name.trim(), (matCount.get(m.name.trim()) ?? 0) + 1);
  const matByName = new Map(mats.filter((m) => matCount.get(m.name.trim()) === 1).map((m) => [m.name.trim(), { id: Number(m.id), name: m.name }]));

  const out: RequestImportRow[] = rows.map((r) => {
    const issues: string[] = [];
    const departmentText = cell(r.cells, '申请部门');
    const department = deptByName.get(departmentText) ?? null;
    if (!departmentText) issues.push('没填申请部门');
    else if (!department) issues.push(`部门「${departmentText}」不在部门档案里（或已停用）`);
    const applicant = cell(r.cells, '申请人');
    if (applicant.length > 20) issues.push('申请人最多 20 个字');
    const name = cell(r.cells, '物品名称');
    if (!name) issues.push('没填物品名称');
    else if (name.length > 40) issues.push('物品名称最多 40 个字');
    const unit = cell(r.cells, '单位');
    if (!unit) issues.push('没填单位');
    else if (unit.length > 8) issues.push('单位最多 8 个字');
    const qtyText = cell(r.cells, '数量');
    const qtyMilli = qtyMilliOf(qtyText);
    if (qtyMilli === null) issues.push(qtyText ? `数量「${qtyText}」不对（要大于 0，最多 3 位小数）` : '没填数量');
    const priorityText = cell(r.cells, '采购优先级');
    const priority = PRIORITY_NAMES[priorityText];
    if (!priority) issues.push(`采购优先级只能写「紧急」或「普通」（写的是「${priorityText}」）`);
    const dateText = cell(r.cells, '期望到货日期');
    let needBy: string | null = null;
    if (dateText) {
      needBy = isoDate(dateText);
      if (!needBy) issues.push(`期望到货日期「${dateText}」看不懂（写成 2026-11-20 这样）`);
      else if (needBy < today) issues.push('期望到货日期不能早于今天');
    }
    const channelText = cell(r.cells, '采购途径');
    const channel = channelOf(channelText);
    if (channel === undefined) issues.push(`采购途径只能写网购、自采（现采/零采）或供应商（写的是「${channelText}」）`);
    const supplierText = cell(r.cells, '供应商名称');
    const supplier = supplierText ? (supByName.get(supplierText) ?? null) : null;
    if (supplierText && !supplier) issues.push(`供应商「${supplierText}」不在供应商档案里（或已停用）`);
    const note = cell(r.cells, '备注');
    if (note.length > 100) issues.push('备注最多 100 个字');
    return {
      row: r.row,
      seq: cell(r.cells, '序号'),
      department,
      departmentText,
      applicant,
      name,
      unit,
      qtyMilli,
      priority: priority ?? 'normal',
      needBy,
      channel: channel ?? null,
      supplier,
      note,
      material: matByName.get(name) ?? null,
      issues,
    };
  });
  const groups = new Map<string, RequestImportPreview['groups'][number]>();
  for (const r of out) {
    if (r.issues.length || !r.department) continue;
    const key = `${r.department.id}|${r.priority}|${r.needBy ?? ''}`;
    const g = groups.get(key) ?? { department: r.department.name, priority: r.priority, needBy: r.needBy, lines: 0 };
    g.lines += 1;
    groups.set(key, g);
  }
  const [dup] = await db<{ id: number; createdAt: string; createdByName: string }[]>`
    SELECT i.id, i.created_at, s.display_name AS created_by_name FROM purchase_request_imports i JOIN staff s ON s.id = i.created_by
    WHERE i.file_sha256 = ${sheet.sha256}`;
  const rules = await loadExpenseRules(db);
  const purpose = rules.purposes.includes('其他') ? '其他' : rules.purposes[0]!;
  return {
    preview: {
      fileName: f.fileName,
      sha256: sheet.sha256,
      rows: out,
      groups: [...groups.values()],
      issueCount: out.filter((r) => r.issues.length).length,
      duplicate: dup ? { id: Number(dup.id), createdAt: dup.createdAt, createdByName: dup.createdByName } : null,
    },
    purpose,
  };
}

export async function previewRequestImport(deps: Deps, raw: unknown): Promise<RequestImportPreview> {
  return (await plan(deps.sql, parse(PreviewInput, raw), deps.config.timezone)).preview;
}

async function importResult(db: Db, importId: number, replayed: boolean): Promise<RequestImportResult> {
  const [imp] = await db<RequestImportResult['import'][]>`
    SELECT i.id, i.file_name, i.row_count, i.request_count, i.created_at, s.display_name AS created_by_name
    FROM purchase_request_imports i JOIN staff s ON s.id = i.created_by WHERE i.id = ${importId}`;
  const requests = await db<RequestImportResult['requests']>`
    SELECT r.id, r.doc_no, d.name AS department, r.priority, r.need_by,
           (SELECT count(*)::int FROM purchase_request_lines l WHERE l.request_id = r.id) AS line_count
    FROM purchase_requests r JOIN departments d ON d.id = r.department_id
    WHERE r.import_id = ${importId} ORDER BY r.id`;
  return { import: { ...imp!, id: Number(imp!.id) }, requests: requests.map((r) => ({ ...r, id: Number(r.id) })), replayed };
}

export async function applyRequestImport(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<RequestImportResult> {
  const f = parse(ApplyInput, raw);
  const requestHash = hashRequest({ ...f, clientKey: undefined });
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, f.clientKey);
    const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${f.clientKey}`;
    if (seen) {
      if (seen.opType !== 'request_import' || seen.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次导入，请刷新页面后重新选择文件');
      return { id: Number(seen.refId), replayed: true };
    }
    await assertNotFenced(tx, f.clientKey, 'request_import', erpOpAbandoned);
    const first = readSheet(f, ['期望到货日期']);
    // 同一份文件串行处理；导入过的直接拒绝（不当作重提：是另一次操作）
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`request_import:${first.sha256}`}, 0))`;
    const [dup] = await tx<{ id: number }[]>`SELECT id FROM purchase_request_imports WHERE file_sha256 = ${first.sha256}`;
    if (dup) throw conflict('IMPORT_DUPLICATE', '这份文件已经导入过了（同一份文件只能导入一次）', { importId: Number(dup.id) });
    const p = await plan(tx, f, deps.config.timezone);
    if (p.preview.issueCount) {
      const bad = p.preview.rows.filter((x) => x.issues.length);
      throw unprocessable('IMPORT_INVALID', `有 ${bad.length} 行要先改好才能导入：${bad.slice(0, 3).map((x) => `第 ${x.row} 行 ${x.issues[0]}`).join('；')}`, {
        rows: bad.map((x) => ({ row: x.row, issues: x.issues })),
      });
    }
    const groups = new Map<string, RequestImportRow[]>();
    for (const row of p.preview.rows) {
      const key = `${row.department!.id}|${row.priority}|${row.needBy ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const [imp] = await tx<{ id: number }[]>`
      INSERT INTO purchase_request_imports (client_key, file_sha256, file_name, row_count, request_count, created_by)
      VALUES (${f.clientKey}, ${p.preview.sha256}, ${f.fileName}, ${p.preview.rows.length}, ${groups.size}, ${actor.id})
      RETURNING id`;
    const importId = Number(imp!.id);
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${f.clientKey}, 'request_import', ${requestHash}, ${importId}, ${actor.id})`;
    const today = todayIn(deps.config.timezone);
    for (const rows of groups.values()) {
      const head = rows[0]!;
      const docNo = await nextDocNo(tx, 'purchase_request', 'XQ', today);
      // 先按已提交写单与行（行的守护只允许已提交、退回时写行），再改成已通过（导入的就是供应链审核过的）
      const [req] = await tx<{ id: number }[]>`
        INSERT INTO purchase_requests (doc_no, department_id, requester_id, need_by, note, status, priority, source, import_id)
        VALUES (${docNo}, ${head.department!.id}, ${actor.id}, ${head.needBy}, ${`集采导入：${f.fileName}`.slice(0, 200)}, 'submitted', ${head.priority}, 'import', ${importId})
        RETURNING id`;
      const requestId = Number(req!.id);
      let lineNo = 0;
      for (const l of rows) {
        lineNo += 1;
        await tx`
          INSERT INTO purchase_request_lines (request_id, line_no, material_id, name, purpose, qty_milli, unit, note, applicant, channel, supplier_id)
          VALUES (${requestId}, ${lineNo}, ${l.material?.id ?? null}, ${l.name}, ${p.purpose}, ${l.qtyMilli}, ${l.unit},
                  ${[l.seq ? `序号 ${l.seq}` : '', l.note].filter(Boolean).join(' · ').slice(0, 100)}, ${l.applicant}, ${l.channel}, ${l.supplier?.id ?? null})`;
      }
      await logApproval(tx, 'purchase_request', requestId, 'create', actor.id, `集采导入：${f.fileName}`.slice(0, 200));
      await tx`UPDATE purchase_requests SET status = 'approved', reviewed_by = ${actor.id}, reviewed_at = now(), updated_at = now() WHERE id = ${requestId}`;
      await logApproval(tx, 'purchase_request', requestId, 'approve', actor.id, '集采导入：供应链整理的需求，导入即通过');
    }
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'request_import',
      targetType: 'purchase_request_import',
      targetId: importId,
      detail: { fileName: f.fileName, rows: p.preview.rows.length, requests: groups.size, sha256: p.preview.sha256 },
      ip,
    });
    return { id: importId, replayed: false };
  });
  return importResult(deps.sql, r.id, r.replayed);
}

/** 标准模板（Excel）：只有表头，列与采购组的「集采需求表」一样 */
export function requestImportTemplate(): Buffer {
  const widths: Record<string, number> = { 序号: 8, 申请部门: 14, 申请人: 12, 物品名称: 24, 单位: 8, 数量: 10, 采购优先级: 12, 期望到货日期: 16, 采购途径: 18, 供应商名称: 22, 备注: 30 };
  return buildXlsx({ name: '集采需求表', columns: REQUEST_IMPORT_COLUMNS.map((h) => ({ header: h, width: widths[h] })), rows: [] });
}

export function registerRequestImportRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 审核需求单的（采购）：导入的就是通过的需求单
  const bodyLimit = 4_000_000;
  app.get('/api/erp/requests/import/template', { preHandler: guard('request.review') }, async (_req, reply) => {
    attachment(reply, '集采需求表模板.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return reply.send(requestImportTemplate());
  });
  app.post('/api/erp/requests/import/preview', { preHandler: guard('request.review'), bodyLimit }, async (req) => previewRequestImport(deps, req.body));
  app.post('/api/erp/requests/import', { preHandler: guard('request.review'), bodyLimit }, async (req, reply) => {
    const r = await applyRequestImport(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
  app.get('/api/erp/requests/imports/:id', { preHandler: guard('request.review') }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    return importResult(sql, id, true);
  });
}
