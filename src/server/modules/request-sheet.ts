// 部门提需求支持表格导入（供应链二次整改 02，docs/ERP_ROUND2.md 第 3 节，GY07–GY11）：「提需求」页的「下载模板」「导入表格」。
// 模板三个工作表：需求表（表头一行，橙色必填、灰色选填，部门 / 物品名称 / 用途 / 采购优先级是下拉，点到单元格有填写提示）、
// 填写说明、选项（下载时的部门、用途、物料档案）。上传 Excel 或 CSV → 逐行核对、预览 → 一次生成需求单（待审核，与手填的一样审核、截单）。
// 只收物料档案里已有的物品（新产品要图片与链接，在页面上填）；部门申购只能给自己的所属部门导入，店主、采购可以替任何部门导入。
// 按「部门 + 优先级 + 期望到货日期」合成需求单，一张最多 50 行、超过的按顺序拆开；一份最多 500 行；有一行有问题整份不导入。
// 同一份文件允许再导入（常规补货每周用同一份表），要勾「确认再导入一次」。
// 操作编号的业务类型用「部门需求单」（purchase_request）：查回、作废与手填的需求单一样；编号记的是第一张需求单。
// 加锁：操作编号的咨询锁（与「确认作废」串行）→ 同一份文件的咨询锁（与集采导入同一把）→ 写导入记录、需求单（都是新行，不锁已有的业务行）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseYuan } from '@shared/money';
import { can } from '@shared/permissions';
import {
  DEPT_SHEET_COLUMNS,
  DEPT_SHEET_LINES_PER_REQUEST,
  DEPT_SHEET_MAX_ROWS,
  DEPT_SHEET_REQUIRED,
  type DeptSheetPreview,
  type DeptSheetResult,
  type DeptSheetRow,
} from '@shared/requests';
import type { Db } from '../db';
import { guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { attachment } from '../lib/csv';
import { todayIn } from '../lib/dates';
import { conflict, unprocessable } from '../lib/errors';
import { assertNotFenced, lockOpKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { readSheet } from '../lib/sheet-read';
import { nextDocNo, setTxTimeouts } from '../lib/tx';
import { parse } from '../lib/validate';
import { buildWorkbook, colName, type WbSheet, type WbValidation } from '../lib/xlsx';
import { erpOpAbandoned } from './erp-ops';
import { loadExpenseRules } from './expenses';
import { logApproval } from './inventory/common';
import { isoDate, PRIORITY_NAMES, qtyMilliOf } from './request-import';
import { approvableOnFor } from './requests';

const FileFields = z.object({
  fileName: z.string().trim().min(1, '缺少文件名').max(120, '文件名太长'),
  csv: z.string().max(2_000_000, '文件太大，请分批导入').optional(),
  xlsxBase64: z.string().max(2_800_000, '文件太大，请分批导入').optional(),
});
const oneFile = (f: { csv?: string; xlsxBase64?: string }) => !!f.csv !== !!f.xlsxBase64;
const PreviewInput = FileFields.refine(oneFile, { message: '请选择一个 Excel 或 CSV 文件', path: ['csv'] });
const ApplyInput = FileFields.extend({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  /** 这份文件以前导入过：要确认再导入一次 */
  confirmRepeat: z.boolean().default(false),
}).refine(oneFile, { message: '请选择一个 Excel 或 CSV 文件', path: ['csv'] });

const LINK = /^https?:\/\/\S+$/i;
const isHeader = (cells: string[]) => DEPT_SHEET_REQUIRED.every((c) => cells.includes(c));

async function me(db: Db, actor: Actor) {
  const [row] = await db<{ departmentId: number | null; departmentName: string | null }[]>`
    SELECT s.department_id, d.name AS department_name FROM staff s LEFT JOIN departments d ON d.id = s.department_id WHERE s.id = ${actor.id}`;
  return {
    departmentId: row?.departmentId === null || row?.departmentId === undefined ? null : Number(row.departmentId),
    departmentName: row?.departmentName ?? null,
    /** 店主、采购（审核需求单的）可以替任何部门导入 */
    free: actor.role === 'owner' || can(actor, 'request.review'),
  };
}

/** 逐行核对。返回预览（含要合成的需求单）；读不了文件、表头不对的直接报错 */
async function plan(db: Db, f: z.infer<typeof PreviewInput>, actor: Actor, timezone: string): Promise<DeptSheetPreview> {
  const sheet = readSheet(f, { dateColumns: ['期望到货日期'], findHeader: isHeader });
  const col = (name: string) => sheet.header.indexOf(name);
  const missing = DEPT_SHEET_REQUIRED.filter((c) => col(c) < 0);
  if (missing.length) throw unprocessable('IMPORT_COLUMNS', `表头少了：${missing.join('、')}（请用「下载模板」的需求表：${DEPT_SHEET_COLUMNS.join('、')}）`);
  const cell = (cells: string[], name: string) => {
    const i = col(name);
    return i < 0 ? '' : (cells[i] ?? '').trim();
  };
  const linkAt = (links: (string | null)[], name: string) => {
    const i = col(name);
    return i < 0 ? null : (links[i] ?? null);
  };
  // 只填了序号的空行跳过
  const content = DEPT_SHEET_COLUMNS.filter((c) => c !== '序号');
  const rows = sheet.rows.filter((r) => content.some((c) => cell(r.cells, c) !== ''));
  if (rows.length === 0) throw unprocessable('IMPORT_EMPTY', '文件里没有要导入的行');
  if (rows.length > DEPT_SHEET_MAX_ROWS) throw unprocessable('IMPORT_TOO_MANY', `一份文件最多 ${DEPT_SHEET_MAX_ROWS} 行，请分批导入`);

  const who = await me(db, actor);
  const today = todayIn(timezone);
  const depts = await db<{ id: number; name: string }[]>`SELECT id, name FROM departments WHERE active`;
  const deptByName = new Map(depts.map((d) => [d.name.trim(), { id: Number(d.id), name: d.name }]));
  const deptById = new Map(depts.map((d) => [Number(d.id), { id: Number(d.id), name: d.name }]));
  const mats = await db<{ id: number; code: string; name: string; purchaseUnit: string }[]>`
    SELECT id, code, name, purchase_unit FROM materials WHERE active AND tracked ORDER BY code`;
  const byCode = new Map(mats.map((m) => [m.code.trim().toUpperCase(), m]));
  type Mat = (typeof mats)[number];
  const byName = new Map<string, Mat[]>();
  for (const m of mats) byName.set(m.name.trim(), [...(byName.get(m.name.trim()) ?? []), m]);
  const { purposes } = await loadExpenseRules(db);

  const out: DeptSheetRow[] = rows.map((r) => {
    const issues: string[] = [];
    // 申请部门（GY09）
    const departmentText = cell(r.cells, '申请部门');
    let department: DeptSheetRow['department'] = null;
    if (departmentText) {
      department = deptByName.get(departmentText) ?? null;
      if (!department) issues.push(`申请部门：「${departmentText}」不在部门档案里（或已停用）`);
      else if (!who.free && department.id !== who.departmentId) {
        issues.push(`申请部门：只能给自己的部门${who.departmentName ? `（${who.departmentName}）` : ''}导入，「${departmentText}」不行`);
        department = null;
      }
    } else if (who.departmentId === null) {
      issues.push(who.free ? '申请部门：没填（你的员工档案里没有所属部门，要写是哪个部门的）' : '申请部门：你的员工档案里还没有填所属部门，请店主在后台员工里补上');
    } else {
      department = deptById.get(who.departmentId) ?? null;
      if (!department) issues.push(`申请部门：你的所属部门${who.departmentName ? `「${who.departmentName}」` : ''}已停用`);
    }
    // 物品名称 / 物料编号（GY08）：只收物料档案里的
    const name = cell(r.cells, '物品名称');
    const code = cell(r.cells, '物料编号');
    let material: Mat | null = null;
    if (!name) issues.push('物品名称：没填');
    if (code) {
      material = byCode.get(code.toUpperCase()) ?? null;
      if (!material) issues.push(`物料编号：「${code}」不在物料档案里（或已停用、不是受管物料）`);
      else if (name && name !== material.name.trim()) {
        issues.push(`物料编号：「${code}」是「${material.name}」，与物品名称「${name}」对不上`);
        material = null;
      }
    } else if (name) {
      const found = byName.get(name) ?? [];
      if (found.length === 0) issues.push(`物品名称：「${name}」不在物料档案里；新产品要带参考链接和图片，请在页面上填`);
      else if (found.length > 1) issues.push(`物品名称：档案里有 ${found.length} 个「${name}」，请在「物料编号」写是哪一个（${found.map((m) => m.code).join('、')}）`);
      else material = found[0]!;
    }
    // 用途：费用用途的固定选项
    const purpose = cell(r.cells, '用途');
    if (!purpose) issues.push('用途：没填');
    else if (!purposes.includes(purpose)) issues.push(`用途：「${purpose}」不是固定选项（${purposes.join('、')}）`);
    // 数量
    const qtyText = cell(r.cells, '数量');
    const qtyMilli = qtyMilliOf(qtyText);
    if (qtyMilli === null) issues.push(qtyText ? `数量：「${qtyText}」不对（要大于 0，最多 3 位小数）` : '数量：没填');
    // 单位：空着按物料档案的采购单位
    const unitText = cell(r.cells, '单位');
    const unit = unitText || material?.purchaseUnit || '';
    if (unitText.length > 8) issues.push('单位：最多 8 个字');
    // 采购优先级
    const priorityText = cell(r.cells, '采购优先级');
    const priority = PRIORITY_NAMES[priorityText];
    if (!priority) issues.push(`采购优先级：只能写「紧急」或「普通」（写的是「${priorityText}」）`);
    // 期望到货日期
    const dateText = cell(r.cells, '期望到货日期');
    let needBy: string | null = null;
    if (dateText) {
      needBy = isoDate(dateText);
      if (!needBy) issues.push(`期望到货日期：「${dateText}」看不懂（写成 2026-11-20 这样）`);
      else if (needBy < today) issues.push('期望到货日期：不能早于今天');
    }
    // 参考单价：元，最多 2 位小数
    const priceText = cell(r.cells, '参考单价');
    let refPriceCents: number | null = null;
    if (priceText) {
      refPriceCents = parseYuan(priceText);
      if (refPriceCents === null) issues.push(`参考单价：「${priceText}」不对（写元，最多 2 位小数）`);
      else if (refPriceCents > 100_000_000) issues.push('参考单价：太大了（最多 100 万元）');
    }
    // 参考链接：单元格带超链接的取链接地址
    const linkText = cell(r.cells, '参考链接');
    const link = (linkAt(r.links, '参考链接') ?? linkText).trim();
    if (link) {
      if (link.length > 500) issues.push('参考链接：最多 500 个字');
      else if (!LINK.test(link)) issues.push('参考链接：要以 http 或 https 开头');
    }
    const details = cell(r.cells, '产品详情');
    if (details.length > 200) issues.push('产品详情：最多 200 个字');
    const note = cell(r.cells, '备注');
    if (note.length > 100) issues.push('备注：最多 100 个字');
    return {
      row: r.row,
      seq: cell(r.cells, '序号'),
      department,
      departmentText,
      material: material ? { id: Number(material.id), code: material.code, name: material.name } : null,
      name,
      code,
      purpose,
      qtyMilli,
      unit,
      priority: priority ?? 'normal',
      needBy,
      refPriceCents,
      link,
      details,
      note,
      issues,
    };
  });
  const [prev] = await db<{ id: number; createdAt: string; createdByName: string; requestCount: number }[]>`
    SELECT i.id, i.created_at, s.display_name AS created_by_name, i.request_count FROM purchase_request_imports i JOIN staff s ON s.id = i.created_by
    WHERE i.file_sha256 = ${sheet.sha256} AND i.kind = 'dept' ORDER BY i.id DESC LIMIT 1`;
  const issueCount = out.filter((r) => r.issues.length).length;
  return {
    fileName: f.fileName,
    sha256: sheet.sha256,
    rows: out,
    groups: issueCount ? [] : chunks(out).map((g) => ({ department: g[0]!.department!.name, priority: g[0]!.priority, needBy: g[0]!.needBy, lines: g.length })),
    issueCount,
    previous: prev ? { id: Number(prev.id), createdAt: prev.createdAt, createdByName: prev.createdByName, requestCount: Number(prev.requestCount) } : null,
  };
}

/** 按「部门 + 优先级 + 期望到货日期」合（按第一次出现的顺序），一张最多 50 行，超过的按顺序拆开 */
function chunks(rows: DeptSheetRow[]): DeptSheetRow[][] {
  const groups = new Map<string, DeptSheetRow[]>();
  for (const r of rows) {
    const key = `${r.department!.id}|${r.priority}|${r.needBy ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: DeptSheetRow[][] = [];
  for (const g of groups.values()) for (let i = 0; i < g.length; i += DEPT_SHEET_LINES_PER_REQUEST) out.push(g.slice(i, i + DEPT_SHEET_LINES_PER_REQUEST));
  return out;
}

export async function previewDeptSheet(deps: Deps, raw: unknown, actor: Actor): Promise<DeptSheetPreview> {
  return plan(deps.sql, parse(PreviewInput, raw), actor, deps.config.timezone);
}

async function sheetResult(db: Db, importId: number, replayed: boolean): Promise<DeptSheetResult> {
  const [imp] = await db<DeptSheetResult['import'][]>`
    SELECT i.id, i.file_name, i.row_count, i.request_count, i.created_at, s.display_name AS created_by_name
    FROM purchase_request_imports i JOIN staff s ON s.id = i.created_by WHERE i.id = ${importId}`;
  const requests = await db<DeptSheetResult['requests']>`
    SELECT r.id, r.doc_no, d.name AS department, r.priority, r.need_by,
           (SELECT count(*)::int FROM purchase_request_lines l WHERE l.request_id = r.id) AS line_count
    FROM purchase_requests r JOIN departments d ON d.id = r.department_id
    WHERE r.import_id = ${importId} ORDER BY r.id`;
  const list = requests.map((r) => ({ ...r, id: Number(r.id) }));
  return { import: { ...imp!, id: Number(imp!.id) }, requests: list, request: { id: list[0]!.id, docNo: list[0]!.docNo }, replayed };
}

export async function applyDeptSheet(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<DeptSheetResult> {
  const f = parse(ApplyInput, raw);
  const requestHash = hashRequest({ ...f, clientKey: undefined });
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, f.clientKey);
    const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${f.clientKey}`;
    if (seen) {
      if (seen.opType !== 'purchase_request' || seen.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一张单据或另一次导入，请刷新页面后重新选择文件');
      const [req] = await tx<{ importId: number | null }[]>`SELECT import_id FROM purchase_requests WHERE id = ${seen.refId}`;
      if (!req?.importId) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一张需求单，请刷新页面后重新选择文件');
      return { id: Number(req.importId), replayed: true };
    }
    await assertNotFenced(tx, f.clientKey, 'purchase_request', erpOpAbandoned);
    const first = readSheet(f, { dateColumns: ['期望到货日期'], findHeader: isHeader });
    // 同一份文件串行处理（与集采导入同一把锁）：「以前导入过」的核对与写入不会两边都漏看
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`request_import:${first.sha256}`}, 0))`;
    const p = await plan(tx, f, actor, deps.config.timezone);
    if (p.issueCount) {
      const bad = p.rows.filter((x) => x.issues.length);
      throw unprocessable('IMPORT_INVALID', `有 ${bad.length} 行要先改好才能导入：${bad.slice(0, 3).map((x) => `第 ${x.row} 行 ${x.issues[0]}`).join('；')}`, {
        rows: bad.map((x) => ({ row: x.row, issues: x.issues })),
      });
    }
    if (p.previous && !f.confirmRepeat) {
      throw conflict('IMPORT_REPEAT', `这份文件 ${p.previous.createdByName} 已经导入过（合成 ${p.previous.requestCount} 张需求单）；要再导入一次请勾「确认再导入一次」`, { importId: p.previous.id });
    }
    const groups = chunks(p.rows);
    const [imp] = await tx<{ id: number }[]>`
      INSERT INTO purchase_request_imports (client_key, file_sha256, file_name, row_count, request_count, created_by, kind)
      VALUES (${f.clientKey}, ${p.sha256}, ${f.fileName}, ${p.rows.length}, ${groups.length}, ${actor.id}, 'dept')
      RETURNING id`;
    const importId = Number(imp!.id);
    const today = todayIn(deps.config.timezone);
    // 截单（CG03）：与手填的一样，截单以后提交的最早第二天才能通过
    const approvableOn = await approvableOnFor(tx, deps.config.timezone);
    let firstRequestId = 0;
    for (const rows of groups) {
      const head = rows[0]!;
      const docNo = await nextDocNo(tx, 'purchase_request', 'XQ', today);
      const [req] = await tx<{ id: number }[]>`
        INSERT INTO purchase_requests (doc_no, department_id, requester_id, need_by, note, status, priority, approvable_on, source, import_id)
        VALUES (${docNo}, ${head.department!.id}, ${actor.id}, ${head.needBy}, ${`表格导入：${f.fileName}`.slice(0, 200)}, 'submitted', ${head.priority}, ${approvableOn}, 'sheet', ${importId})
        RETURNING id`;
      const requestId = Number(req!.id);
      if (!firstRequestId) firstRequestId = requestId;
      let lineNo = 0;
      for (const l of rows) {
        lineNo += 1;
        await tx`
          INSERT INTO purchase_request_lines (request_id, line_no, material_id, name, purpose, qty_milli, unit, link, details, ref_price_cents, note)
          VALUES (${requestId}, ${lineNo}, ${l.material!.id}, ${l.material!.name}, ${l.purpose}, ${l.qtyMilli}, ${l.unit}, ${l.link}, ${l.details}, ${l.refPriceCents},
                  ${[l.seq ? `序号 ${l.seq}` : '', l.note].filter(Boolean).join(' · ').slice(0, 100)})`;
      }
      await logApproval(tx, 'purchase_request', requestId, 'create', actor.id, `表格导入：${f.fileName}`.slice(0, 200));
      await logApproval(tx, 'purchase_request', requestId, 'submit', actor.id);
    }
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${f.clientKey}, 'purchase_request', ${requestHash}, ${firstRequestId}, ${actor.id})`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'request_import',
      targetType: 'purchase_request_import',
      targetId: importId,
      detail: { kind: 'dept', fileName: f.fileName, rows: p.rows.length, requests: groups.length, sha256: p.sha256, repeat: !!p.previous },
      ip,
    });
    return { id: importId, replayed: false };
  });
  return sheetResult(deps.sql, r.id, r.replayed);
}

// ───────────────────────── 模板 ─────────────────────────

/** 每一列：宽度、必填、点到单元格时的提示 */
const COLUMN_SPEC: Record<(typeof DEPT_SHEET_COLUMNS)[number], { width: number; how: string; example: string }> = {
  序号: { width: 7, how: '随便填，方便自己对照；不导入', example: '1' },
  申请部门: { width: 14, how: '从下拉里选。部门申购空着按自己的部门（只能导自己部门的）；店主、采购可以替别的部门导入', example: '客房部' },
  物品名称: { width: 24, how: '从下拉里选物料档案里的物品。不在档案里的新产品要带参考链接和图片，请在「提需求」页面上填', example: '抽纸' },
  物料编号: { width: 12, how: '选填。档案里有同名的几个物料时写编号（见「选项」表）', example: 'A001' },
  用途: { width: 14, how: '从下拉里选（与页面上的用途一样）', example: '客用消耗' },
  数量: { width: 10, how: '大于 0，最多 3 位小数', example: '20' },
  单位: { width: 8, how: '选填，空着按物料档案的采购单位；最多 8 个字', example: '箱' },
  采购优先级: { width: 11, how: '从下拉里选紧急或普通，空着按普通', example: '普通' },
  期望到货日期: { width: 14, how: '选填，写成 2026-11-20 或 2026/11/20；不能早于今天', example: '2026-11-20' },
  参考单价: { width: 11, how: '选填，元，最多 2 位小数', example: '35.5' },
  参考链接: { width: 28, how: '选填，http 或 https 开头的网址', example: 'https://…' },
  产品详情: { width: 24, how: '选填，规格、颜色等，最多 200 个字', example: '三层 120 抽' },
  备注: { width: 20, how: '选填，最多 100 个字', example: '月初补货' },
};

export async function deptSheetTemplate(db: Db): Promise<Buffer> {
  const depts = await db<{ name: string }[]>`SELECT name FROM departments WHERE active ORDER BY sort_order, id`;
  const mats = await db<{ code: string; name: string; specification: string; purchaseUnit: string; category: string }[]>`
    SELECT code, name, specification, purchase_unit, category FROM materials WHERE active AND tracked ORDER BY category, code`;
  const { purposes } = await loadExpenseRules(db);
  const required = new Set<string>(DEPT_SHEET_REQUIRED);
  const last = DEPT_SHEET_MAX_ROWS + 1;
  const range = (name: string) => {
    const c = colName(DEPT_SHEET_COLUMNS.indexOf(name as (typeof DEPT_SHEET_COLUMNS)[number]));
    return `${c}2:${c}${last}`;
  };
  const validations: WbValidation[] = DEPT_SHEET_COLUMNS.map((name) => {
    const v: WbValidation = { sqref: range(name), promptTitle: `${name}（${required.has(name) ? '必填' : '选填'}）`, prompt: COLUMN_SPEC[name].how };
    if (name === '申请部门' && depts.length) Object.assign(v, { list: { name: 'opt_dept' }, error: '请从下拉里选部门档案里的部门' });
    if (name === '物品名称' && mats.length) Object.assign(v, { list: { name: 'opt_material' }, error: '只能选物料档案里的物品；新产品请在页面上填' });
    if (name === '用途' && purposes.length) Object.assign(v, { list: { name: 'opt_purpose' }, error: '请从下拉里选用途' });
    if (name === '采购优先级') Object.assign(v, { list: ['紧急', '普通'], error: '只能选紧急或普通' });
    return v;
  });
  const main: WbSheet = {
    name: '需求表',
    active: true,
    widths: DEPT_SHEET_COLUMNS.map((c) => COLUMN_SPEC[c].width),
    freezeRows: 1,
    rows: [{ height: 24, cells: DEPT_SHEET_COLUMNS.map((c) => ({ v: c, style: required.has(c) ? 'required' : 'optional' })) }],
    validations,
  };
  const guide: WbSheet = {
    name: '填写说明',
    widths: [14, 8, 60, 16],
    freezeRows: 0,
    rows: [
      { height: 26, cells: [{ v: '部门需求表 · 填写说明', style: 'title' }] },
      { cells: [{ v: '在「需求表」里一行写一样东西；橙色表头必填、灰色选填；表头的名字不要改（顺序可以换，多出来的列不管）。', style: 'note' }] },
      { height: 22, cells: ['列', '必填', '怎么填', '例子'].map((v) => ({ v, style: 'optional' as const })) },
      ...DEPT_SHEET_COLUMNS.map((c) => ({ cells: [{ v: c, style: 'body' as const }, { v: required.has(c) ? '必填' : '选填', style: 'body' as const }, { v: COLUMN_SPEC[c].how, style: 'body' as const }, { v: COLUMN_SPEC[c].example, style: 'body' as const }] })),
      { cells: [] },
      { cells: [{ v: `导入：在「提需求」页点「导入表格」，选这份文件 →「预览」逐行核对 → 没有问题再「导入」。一份最多 ${DEPT_SHEET_MAX_ROWS} 行。`, style: 'note' }] },
      { cells: [{ v: `按「部门 + 优先级 + 期望到货日期」合成需求单，一张最多 ${DEPT_SHEET_LINES_PER_REQUEST} 行；导入的需求单都是「待审核」，与手填的一样审核、每日截单。`, style: 'note' }] },
      { cells: [{ v: '有问题的行在预览里整行标红、写明哪一列为什么；有一行有问题整份都不导入，改好再选一次文件。', style: 'note' }] },
      { cells: [{ v: '同一份表可以每周再用；再导入时预览会提醒上次谁什么时候导入过，要勾「确认再导入一次」。', style: 'note' }] },
    ],
    merges: ['A1:D1', 'A2:D2', ...[0, 1, 2, 3].map((i) => `A${DEPT_SHEET_COLUMNS.length + 5 + i}:D${DEPT_SHEET_COLUMNS.length + 5 + i}`)],
  };
  const optRows = Math.max(depts.length, purposes.length, mats.length, 1);
  const options: WbSheet = {
    name: '选项',
    widths: [16, 14, 26, 12, 22, 10, 14],
    freezeRows: 1,
    rows: [
      { cells: ['部门', '用途', '物品名称', '物料编号', '规格', '采购单位', '分类'].map((v) => ({ v, style: 'optional' as const })) },
      ...Array.from({ length: optRows }, (_, i) => ({
        cells: [depts[i]?.name ?? null, purposes[i] ?? null, mats[i]?.name ?? null, mats[i]?.code ?? null, mats[i]?.specification ?? null, mats[i]?.purchaseUnit ?? null, mats[i]?.category ?? null],
      })),
    ],
  };
  const names = [
    ...(depts.length ? [{ name: 'opt_dept', sheet: '选项', range: `$A$2:$A$${depts.length + 1}` }] : []),
    ...(purposes.length ? [{ name: 'opt_purpose', sheet: '选项', range: `$B$2:$B$${purposes.length + 1}` }] : []),
    ...(mats.length ? [{ name: 'opt_material', sheet: '选项', range: `$C$2:$C$${mats.length + 1}` }] : []),
  ];
  return buildWorkbook([main, guide, options], names);
}

export function registerRequestSheetRoutes(app: FastifyInstance, deps: Deps) {
  const bodyLimit = 4_000_000;
  // 谁能提需求单谁就能导入（GY07）；部门与物品按导入的人核对
  const create = guardAny('request.create');
  app.get('/api/erp/requests/sheet/template', { preHandler: create }, async (_req, reply) => {
    const buf = await deptSheetTemplate(deps.sql);
    attachment(reply, '部门需求表模板.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return reply.send(buf);
  });
  app.post('/api/erp/requests/sheet/preview', { preHandler: create, bodyLimit }, async (req) => previewDeptSheet(deps, req.body, req.actor));
  app.post('/api/erp/requests/sheet/import', { preHandler: create, bodyLimit }, async (req, reply) => {
    const r = await applyDeptSheet(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
}
