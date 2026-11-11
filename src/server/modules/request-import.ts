// 集采模板与一键导入（8.0.1 采购组整改 06，CG06，docs/PURCHASING_V801.md）：「采购 → 集采导入」。
// 供应链二次整改 01（docs/ERP_ROUND2.md 第 4 节，GY12–GY18）：模板就是采购组的最终版收集表「品牌新增寻款采购清单」
// （第 1 行标题、第 2 行表头：序号、是否下单、是否到货、是否退货、产品名称、用途、采购数量、备注、产品详情、参考链接渠道），
// 按最终版填的表原样导入：表头在前 10 行里自动找，列按名字认（8.0.1 旧模板的列照旧认）；
// 最终版没有「申请部门」——在导入页上选记在哪个部门（表里有这一列的按表里的）；没有「单位」——「19个」这样的数量里拆，都没有按「个」；
// 用途原样记；参考链接渠道带超链接的取链接地址，不是网址的当作采购途径或写进产品详情；是否下单 / 到货 / 退货标了「是」的默认不导入。
// 导入出来的需求单按「部门 + 优先级 + 期望到货日期」合成，直接是「已通过」（导入的就是供应链），进「待转采购单」；
// 物品名称与物料档案一样的带上物料，不一样的按新产品（导入的不要求链接和图片）。
// 同一份文件（按内容摘要）只能导入一次；写入在一个事务里，有一行有问题整份不写。
// 加锁：操作编号的咨询锁（与「确认作废」串行）→ 同一份文件的咨询锁 → 写导入记录、需求单（都是新行，不锁已有的业务行）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  REQUEST_IMPORT_COLUMNS,
  REQUEST_IMPORT_MAX_ROWS,
  REQUEST_IMPORT_OFFLINE_COLUMNS,
  REQUEST_IMPORT_REQUIRED,
  REQUEST_IMPORT_TITLE,
  type RequestImportPreview,
  type RequestImportResult,
  type RequestImportRow,
  type RequestPriority,
} from '@shared/requests';
import type { Db } from '../db';
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
import { buildWorkbook, type WbSheet, type WbValidation } from '../lib/xlsx';
import { erpOpAbandoned } from './erp-ops';
import { logApproval } from './inventory/common';

const FileFields = z.object({
  fileName: z.string().trim().min(1, '缺少文件名').max(120, '文件名太长'),
  csv: z.string().max(2_000_000, '文件太大，请分批导入').optional(),
  xlsxBase64: z.string().max(2_800_000, '文件太大，请分批导入').optional(),
  /** 这份清单记在哪个部门（最终版没有「申请部门」列；表里有这一列的按表里的） */
  departmentId: z.number().int().positive().nullable().default(null),
  /** 是否下单 / 到货 / 退货标了「是」的也导入（GY15，默认不导入） */
  includeOffline: z.boolean().default(false),
});
const oneFile = (f: { csv?: string; xlsxBase64?: string }) => !!f.csv !== !!f.xlsxBase64;
const PreviewInput = FileFields.refine(oneFile, { message: '请选择一个 Excel 或 CSV 文件', path: ['csv'] });
const ApplyInput = FileFields.extend({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试') }).refine(oneFile, {
  message: '请选择一个 Excel 或 CSV 文件',
  path: ['csv'],
});

export const PRIORITY_NAMES: Record<string, RequestPriority> = { '': 'normal', 普通: 'normal', 一般: 'normal', 紧急: 'urgent', 急: 'urgent', 加急: 'urgent' };
/** 采购途径：固定三类（CG08），认常见写法 */
function channelOf(text: string): RequestImportRow['channel'] | undefined {
  const t = text.replace(/\s|（|）|\(|\)|\//g, '');
  if (t === '') return null;
  if (t === '网购' || t === '网上' || t === '线上') return 'online';
  if (t.startsWith('自采') || t === '现采' || t === '零采' || t === '现采零采') return 'self';
  if (t === '供应商') return 'supplier';
  return undefined;
}
/** 渠道写法更宽一些（参考链接渠道里写的）：淘宝、天猫、京东、拼多多、1688 都算网购 */
function looseChannelOf(text: string): RequestImportRow['channel'] | undefined {
  const exact = channelOf(text);
  if (exact !== undefined) return exact;
  const t = text.replace(/\s/g, '');
  if (/^(淘宝|天猫|京东|拼多多|1688|阿里巴巴|抖音|小红书)(网|商城|店铺)?$/i.test(t)) return 'online';
  return undefined;
}
/** 2026/1/5、2026-01-05、2026.1.5、2026年1月5日 → 2026-01-05 */
export function isoDate(text: string): string | null {
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
/** 数量：最多 3 位小数、大于 0 */
export function qtyMilliOf(text: string): number | null {
  const t = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const v = Math.round(Number(t) * 1000);
  return v > 0 && v <= 1_000_000_000 ? v : null;
}
/** 「19个」「2 箱」「1.5kg」：数量与单位拆开；纯数字的单位为空；拆不开的返回 null */
export function splitQty(text: string): { qtyMilli: number; unit: string } | null {
  const m = /^([\d,]+(?:\.\d+)?)\s*([^\d\s,.][^\d]{0,7})?$/.exec(text.trim());
  if (!m) return null;
  const qtyMilli = qtyMilliOf(m[1]!);
  return qtyMilli === null ? null : { qtyMilli, unit: (m[2] ?? '').trim() };
}

/** 表头在哪一行：前 10 行里第一行同时有「产品名称」（或「物品名称」）与「采购数量」（或「数量」）的 */
const NAME_COLS = ['产品名称', '物品名称'];
const QTY_COLS = ['采购数量', '数量'];
const isHeader = (cells: string[]) => NAME_COLS.some((c) => cells.includes(c)) && QTY_COLS.some((c) => cells.includes(c));
const readImportSheet = (f: { csv?: string; xlsxBase64?: string }) => readSheet(f, { dateColumns: ['期望到货日期'], findHeader: isHeader });
const LINK = /^https?:\/\/\S+$/i;
/** 默认单位（GY14） */
const DEFAULT_UNIT = '个';
/** 用途空着记「其他」（GY16） */
const DEFAULT_PURPOSE = '其他';

async function plan(db: Db, f: z.infer<typeof PreviewInput>, timezone: string): Promise<RequestImportPreview> {
  const sheet = readImportSheet(f);
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = sheet.header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  if (col(...NAME_COLS) < 0 || col(...QTY_COLS) < 0) {
    const missing = [col(...NAME_COLS) < 0 ? '产品名称' : '', col(...QTY_COLS) < 0 ? '采购数量' : ''].filter(Boolean);
    throw unprocessable('IMPORT_COLUMNS', `表头少了：${missing.join('、')}（请用「下载模板」的${REQUEST_IMPORT_TITLE}：${REQUEST_IMPORT_COLUMNS.join('、')}）`);
  }
  const cell = (cells: string[], ...names: string[]) => {
    const i = col(...names);
    return i < 0 ? '' : (cells[i] ?? '').trim();
  };
  const linkAt = (links: (string | null)[], name: string) => {
    const i = col(name);
    return i < 0 ? null : (links[i] ?? null);
  };
  // 只看要导入的列：全空的行（例如只填了序号、只选了是否下单的空行）跳过
  const contentCols = [['申请部门'], NAME_COLS, ['用途'], QTY_COLS, ['单位'], ['备注'], ['产品详情'], ['参考链接渠道']];
  const rows = sheet.rows.filter((r) => contentCols.some((names) => cell(r.cells, ...names) !== ''));
  if (rows.length === 0) throw unprocessable('IMPORT_EMPTY', '文件里没有要导入的行');
  if (rows.length > REQUEST_IMPORT_MAX_ROWS) throw unprocessable('IMPORT_TOO_MANY', `一份文件最多 ${REQUEST_IMPORT_MAX_ROWS} 行，请分批导入`);
  const today = todayIn(timezone);
  const depts = await db<{ id: number; name: string }[]>`SELECT id, name FROM departments WHERE active`;
  const sups = await db<{ id: number; name: string }[]>`SELECT id, name FROM suppliers WHERE active`;
  const mats = await db<{ id: number; name: string }[]>`SELECT id, name FROM materials WHERE active AND tracked`;
  const deptByName = new Map(depts.map((d) => [d.name.trim(), { id: Number(d.id), name: d.name }]));
  const pageDept = f.departmentId === null ? null : (depts.find((d) => Number(d.id) === f.departmentId) ?? null);
  if (f.departmentId !== null && !pageDept) throw unprocessable('DEPARTMENT_INVALID', '选的部门不存在或已停用');
  const supByName = new Map(sups.map((s) => [s.name.trim(), { id: Number(s.id), name: s.name }]));
  // 物料名称重复的不自动带（按新产品）
  const matCount = new Map<string, number>();
  for (const m of mats) matCount.set(m.name.trim(), (matCount.get(m.name.trim()) ?? 0) + 1);
  const matByName = new Map(mats.filter((m) => matCount.get(m.name.trim()) === 1).map((m) => [m.name.trim(), { id: Number(m.id), name: m.name }]));

  const out: RequestImportRow[] = rows.map((r) => {
    const issues: string[] = [];
    // 申请部门：表里有的按表里的，空着按页面上选的（GY13）
    const departmentText = cell(r.cells, '申请部门');
    let department: RequestImportRow['department'] = null;
    if (departmentText) {
      department = deptByName.get(departmentText) ?? null;
      if (!department) issues.push(`部门「${departmentText}」不在部门档案里（或已停用）`);
    } else if (pageDept) department = { id: Number(pageDept.id), name: pageDept.name };
    else issues.push('没选部门：在页面上选这份清单记在哪个部门');
    const applicant = cell(r.cells, '申请人');
    if (applicant.length > 20) issues.push('申请人最多 20 个字');
    const name = cell(r.cells, ...NAME_COLS);
    if (!name) issues.push('没填产品名称');
    else if (name.length > 40) issues.push('产品名称最多 40 个字');
    const purposeText = cell(r.cells, '用途');
    const purpose = purposeText || DEFAULT_PURPOSE;
    if (purposeText.length > 20) issues.push('用途最多 20 个字');
    // 采购数量：「19个」这样带单位的拆开（GY14）
    const qtyText = cell(r.cells, ...QTY_COLS);
    const split = qtyText ? splitQty(qtyText) : null;
    if (!split) issues.push(qtyText ? `采购数量「${qtyText}」不对（要大于 0，最多 3 位小数，可以带单位，如「19个」）` : '没填采购数量');
    const unitCol = cell(r.cells, '单位');
    const unit = split?.unit || unitCol || DEFAULT_UNIT;
    if (unit.length > 8) issues.push('单位最多 8 个字');
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
    let details = cell(r.cells, '产品详情');
    // 参考链接渠道（GY17）：带超链接的取链接地址；文字是网址的取文字；不是网址的当渠道
    const refText = cell(r.cells, '参考链接渠道');
    const refLink = (linkAt(r.links, '参考链接渠道') ?? '').trim();
    let link = '';
    let refChannel: RequestImportRow['channel'] = null;
    if (refLink && LINK.test(refLink)) link = refLink;
    else if (LINK.test(refText)) link = refText;
    else if (refText) {
      const c = looseChannelOf(refText);
      if (c) refChannel = c;
      else details = details ? `${details}；渠道：${refText}` : `渠道：${refText}`;
    }
    if (link.length > 500) issues.push('参考链接超过 500 个字（请换成短一点的商品链接）');
    if (details.length > 200) issues.push(refText && !link && !refChannel ? '产品详情加上渠道超过 200 个字' : '产品详情最多 200 个字');
    // 采购途径：旧模板的「采购途径」列优先，没有的按参考链接渠道里认出来的
    const channelText = cell(r.cells, '采购途径');
    const channelCol = channelOf(channelText);
    if (channelCol === undefined) issues.push(`采购途径只能写网购、自采（现采/零采）或供应商（写的是「${channelText}」）`);
    const channel = channelCol ?? refChannel;
    const supplierText = cell(r.cells, '供应商名称');
    const supplier = supplierText ? (supByName.get(supplierText) ?? null) : null;
    if (supplierText && !supplier) issues.push(`供应商「${supplierText}」不在供应商档案里（或已停用）`);
    const note = cell(r.cells, '备注');
    if (note.length > 100) issues.push('备注最多 100 个字');
    // 是否下单 / 到货 / 退货（GY15）：只能是、否或空着；标了「是」的默认不导入
    const offline: string[] = [];
    for (const c of REQUEST_IMPORT_OFFLINE_COLUMNS) {
      const v = cell(r.cells, c);
      if (v === '是') offline.push(c);
      else if (v !== '' && v !== '否') issues.push(`「${c}」只能填是、否或空着（写的是「${v}」）`);
    }
    return {
      row: r.row,
      seq: cell(r.cells, '序号'),
      department,
      departmentText,
      applicant,
      name,
      purpose,
      unit,
      qtyMilli: split?.qtyMilli ?? null,
      priority: priority ?? 'normal',
      needBy,
      channel: channel ?? null,
      supplier,
      note,
      details,
      link,
      material: matByName.get(name) ?? null,
      offline,
      skipped: offline.length > 0 && !f.includeOffline,
      issues,
    };
  });
  const groups = new Map<string, RequestImportPreview['groups'][number]>();
  for (const r of out) {
    if (r.skipped || r.issues.length || !r.department) continue;
    const key = `${r.department.id}|${r.priority}|${r.needBy ?? ''}`;
    const g = groups.get(key) ?? { department: r.department.name, priority: r.priority, needBy: r.needBy, lines: 0 };
    g.lines += 1;
    groups.set(key, g);
  }
  const [dup] = await db<{ id: number; createdAt: string; createdByName: string }[]>`
    SELECT i.id, i.created_at, s.display_name AS created_by_name FROM purchase_request_imports i JOIN staff s ON s.id = i.created_by
    WHERE i.file_sha256 = ${sheet.sha256} AND i.kind = 'bulk'`;
  return {
    fileName: f.fileName,
    sha256: sheet.sha256,
    rows: out,
    groups: [...groups.values()],
    // 不导入的行有问题也不挡（GY15）
    issueCount: out.filter((r) => !r.skipped && r.issues.length).length,
    skippedCount: out.filter((r) => r.skipped).length,
    duplicate: dup ? { id: Number(dup.id), createdAt: dup.createdAt, createdByName: dup.createdByName } : null,
  };
}

export async function previewRequestImport(deps: Deps, raw: unknown): Promise<RequestImportPreview> {
  return plan(deps.sql, parse(PreviewInput, raw), deps.config.timezone);
}

async function importResult(db: Db, importId: number, replayed: boolean): Promise<RequestImportResult> {
  const [imp] = await db<RequestImportResult['import'][]>`
    SELECT i.id, i.file_name, i.row_count, i.request_count, i.skipped_count, i.created_at, s.display_name AS created_by_name
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
    const first = readImportSheet(f);
    // 同一份文件串行处理；导入过的直接拒绝（不当作重提：是另一次操作）
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`request_import:${first.sha256}`}, 0))`;
    const [dup] = await tx<{ id: number }[]>`SELECT id FROM purchase_request_imports WHERE file_sha256 = ${first.sha256} AND kind = 'bulk'`;
    if (dup) throw conflict('IMPORT_DUPLICATE', '这份文件已经导入过了（同一份文件只能导入一次）', { importId: Number(dup.id) });
    const p = await plan(tx, f, deps.config.timezone);
    if (p.issueCount) {
      const bad = p.rows.filter((x) => !x.skipped && x.issues.length);
      throw unprocessable('IMPORT_INVALID', `有 ${bad.length} 行要先改好才能导入：${bad.slice(0, 3).map((x) => `第 ${x.row} 行 ${x.issues[0]}`).join('；')}`, {
        rows: bad.map((x) => ({ row: x.row, issues: x.issues })),
      });
    }
    const todo = p.rows.filter((x) => !x.skipped);
    if (todo.length === 0) throw unprocessable('IMPORT_EMPTY', '没有要导入的行：表里的行都标了线下已下单、到货或退货（要导入请勾「线下已下单的也导入」）');
    const groups = new Map<string, RequestImportRow[]>();
    for (const row of todo) {
      const key = `${row.department!.id}|${row.priority}|${row.needBy ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const [imp] = await tx<{ id: number }[]>`
      INSERT INTO purchase_request_imports (client_key, file_sha256, file_name, row_count, request_count, created_by, kind, skipped_count)
      VALUES (${f.clientKey}, ${p.sha256}, ${f.fileName}, ${todo.length}, ${groups.size}, ${actor.id}, 'bulk', ${p.skippedCount})
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
          INSERT INTO purchase_request_lines (request_id, line_no, material_id, name, purpose, qty_milli, unit, link, details, note, applicant, channel, supplier_id)
          VALUES (${requestId}, ${lineNo}, ${l.material?.id ?? null}, ${l.name}, ${l.purpose}, ${l.qtyMilli}, ${l.unit}, ${l.link}, ${l.details},
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
      detail: { kind: 'bulk', fileName: f.fileName, rows: todo.length, skipped: p.skippedCount, requests: groups.size, sha256: p.sha256 },
      ip,
    });
    return { id: importId, replayed: false };
  });
  return importResult(deps.sql, r.id, r.replayed);
}

// ───────────────────────── 模板：采购组的最终版（GY12） ─────────────────────────

/** 每一列：宽度（与最终版一样）、点到单元格时的提示、填写说明里的例子 */
const COLUMN_SPEC: Record<(typeof REQUEST_IMPORT_COLUMNS)[number], { width: number; how: string; example: string }> = {
  序号: { width: 10.79, how: '随便填，方便对照；导入后记在需求行的备注里', example: '1' },
  是否下单: { width: 13.35, how: '下拉选是或否（线下跟踪用）。标了「是」的行默认不导入，免得再下一次单', example: '否' },
  是否到货: { width: 13.35, how: '下拉选是或否（线下跟踪用）。标了「是」的行默认不导入', example: '否' },
  是否退货: { width: 13.35, how: '下拉选是或否（线下跟踪用）。标了「是」的行默认不导入', example: '否' },
  产品名称: { width: 20.23, how: '必填，最多 40 个字；与物料档案名称一样的自动带上物料，不一样的按新产品', example: '玻璃杯' },
  用途: { width: 18.08, how: '自由填写，最多 20 个字（如「客房漱口」）；空着记「其他」', example: '客房漱口' },
  采购数量: { width: 18.08, how: '必填，大于 0，最多 3 位小数；可以带单位，如「19个」「2箱」（不带单位的按「个」）', example: '19个' },
  备注: { width: 14.83, how: '选填，最多 100 个字', example: '大货，样品有1' },
  产品详情: { width: 38.44, how: '选填，规格、颜色等，最多 200 个字', example: '水波杯【300ml】' },
  参考链接渠道: { width: 20.9, how: '选填。贴商品链接（带超链接的取链接地址），或写渠道：网购、自采、供应商', example: 'https://…' },
};

export function requestImportTemplate(): Buffer {
  const required = new Set<string>(REQUEST_IMPORT_REQUIRED);
  const n = REQUEST_IMPORT_COLUMNS.length;
  const last = REQUEST_IMPORT_MAX_ROWS + 2;
  const letter = (name: string) => String.fromCharCode(65 + REQUEST_IMPORT_COLUMNS.indexOf(name as (typeof REQUEST_IMPORT_COLUMNS)[number]));
  const validations: WbValidation[] = REQUEST_IMPORT_COLUMNS.map((name) => {
    const v: WbValidation = { sqref: `${letter(name)}3:${letter(name)}${last}`, promptTitle: `${name}（${required.has(name) ? '必填' : '选填'}）`, prompt: COLUMN_SPEC[name].how };
    if ((REQUEST_IMPORT_OFFLINE_COLUMNS as readonly string[]).includes(name)) Object.assign(v, { list: ['是', '否'], error: '只能选是或否（不用的空着）' });
    return v;
  });
  const main: WbSheet = {
    name: '工作表1',
    active: true,
    widths: REQUEST_IMPORT_COLUMNS.map((c) => COLUMN_SPEC[c].width),
    freezeRows: 2,
    merges: [`A1:${String.fromCharCode(64 + n)}1`],
    rows: [
      { height: 45, cells: [{ v: REQUEST_IMPORT_TITLE, style: 'title' }] },
      { height: 30, cells: REQUEST_IMPORT_COLUMNS.map((c) => ({ v: c, style: required.has(c) ? 'required' : 'optional' })) },
    ],
    validations,
  };
  const guide: WbSheet = {
    name: '填写说明',
    widths: [14, 8, 64, 18],
    rows: [
      { height: 26, cells: [{ v: `${REQUEST_IMPORT_TITLE} · 填写说明`, style: 'title' }] },
      { cells: [{ v: '第 1 行标题、第 2 行表头不要改；从第 3 行起一行写一样东西。橙色表头必填、灰色选填。', style: 'note' }] },
      { height: 22, cells: ['列', '必填', '怎么填', '例子'].map((v) => ({ v, style: 'optional' as const })) },
      ...REQUEST_IMPORT_COLUMNS.map((c) => ({ cells: [{ v: c, style: 'body' as const }, { v: required.has(c) ? '必填' : '选填', style: 'body' as const }, { v: COLUMN_SPEC[c].how, style: 'body' as const }, { v: COLUMN_SPEC[c].example, style: 'body' as const }] })),
      { cells: [] },
      { cells: [{ v: '导入：「采购 → 集采导入」选这份清单记在哪个部门 → 选文件 →「预览」→ 没有问题再「导入」。一份最多 500 行，同一份文件只能导入一次。', style: 'note' }] },
      { cells: [{ v: '导入的需求单直接是「已通过」，进「待转采购单」。表里贴的图片不导入；系统里的下单、到货、退货按采购单与收货单自动回写。', style: 'note' }] },
    ],
    merges: ['A1:D1', 'A2:D2', `A${n + 5}:D${n + 5}`, `A${n + 6}:D${n + 6}`],
  };
  return buildWorkbook([main, guide]);
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
