// 库管入库的台账模板与一键导入（8.1.9，docs/ERP_V819.md 第 3.2 节，PENDING_DECISIONS KR4、KR5）：库存页「库管入库」旁的
// 「下载模板」「导入台账」。模板三个工作表：入库台账（表头一行，橙色必填、灰色选填，供应商、物品是下拉，点到单元格有提示）、
// 填写说明、选项（下载时的供应商、物料与单位）。上传 Excel 或 CSV → 逐行核对、预览 → 一键生成库管入库单并确认入库
// （与手填的「确认入库」一样进库存、记成本，挂账供应商记应付）。
// 按「入库日期 + 供应商 + 单据分组」合成，一张最多 100 行、超过的按顺序拆开；一份最多 500 行；有一行有问题整份不写；
// 同一份文件（按内容摘要）只能导入一次（重复入库会多出库存）。
// 加锁：操作编号的咨询锁（业务类型 receipt_import，与「确认作废」串行）→ 同一份文件的咨询锁 → 写导入记录 →
//   按日期取好单号（单号计数，与新建单据同一顺序）→ 按 id 升序锁住这次要动的全部物料 → 逐张建单、确认入库（收货单原来的锁）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  RECEIPT_IMPORT_COLUMNS,
  RECEIPT_IMPORT_LINES_PER_DOC,
  RECEIPT_IMPORT_MAX_ROWS,
  RECEIPT_IMPORT_REQUIRED,
  type ReceiptImportGroup,
  type ReceiptImportPreview,
  type ReceiptImportResult,
  type ReceiptImportRow,
} from '@shared/direct-receipts';
import { formatAmount, parseYuan } from '@shared/money';
import { lineAmountCents, toBaseQty } from '@shared/quantity';
import type { Db } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { attachment } from '../../lib/csv';
import { todayIn } from '../../lib/dates';
import { conflict, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { readSheet } from '../../lib/sheet-read';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { buildWorkbook, colName, type WbSheet, type WbValidation } from '../../lib/xlsx';
import { erpOpAbandoned } from '../erp-ops';
import { isoDate } from '../request-import';
import { loadInventorySettings } from './common';
import { createImportedReceipt, nextReceiptNo } from './docs';

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

const DATE_COLUMNS = ['入库日期', '生产日期', '到期日'];
const isHeader = (cells: string[]) => RECEIPT_IMPORT_REQUIRED.every((c) => cells.includes(c));

interface Mat {
  id: number;
  code: string;
  name: string;
  inventoryUnit: string;
  purchaseUnit: string;
  purchaseFactorMilli: number;
  decimals: number;
  expiryTracked: boolean;
  shelfLifeDays: number | null;
}

/** 数量：大于 0、最多 3 位小数（千分之一） */
function qtyOf(text: string): number | null {
  const t = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const v = Math.round(Number(t) * 1000);
  return v > 0 && v <= 1_000_000_000 ? v : null;
}

/** 逐行核对。返回预览（含要合成的单据）；读不了文件、表头不对的直接报错 */
async function plan(db: Db, f: z.infer<typeof PreviewInput>, timezone: string): Promise<ReceiptImportPreview> {
  const sheet = readSheet(f, { dateColumns: DATE_COLUMNS, findHeader: isHeader });
  const col = (name: string) => sheet.header.indexOf(name);
  const missing = RECEIPT_IMPORT_REQUIRED.filter((c) => col(c) < 0);
  if (missing.length) throw unprocessable('IMPORT_COLUMNS', `表头少了：${missing.join('、')}（请用「下载模板」的入库台账：${RECEIPT_IMPORT_COLUMNS.join('、')}）`);
  const cell = (cells: string[], name: string) => {
    const i = col(name);
    return i < 0 ? '' : (cells[i] ?? '').trim();
  };
  const content = RECEIPT_IMPORT_COLUMNS.filter((c) => c !== '序号');
  const rows = sheet.rows.filter((r) => content.some((c) => cell(r.cells, c) !== ''));
  if (rows.length === 0) throw unprocessable('IMPORT_EMPTY', '文件里没有要导入的行');
  if (rows.length > RECEIPT_IMPORT_MAX_ROWS) throw unprocessable('IMPORT_TOO_MANY', `一份文件最多 ${RECEIPT_IMPORT_MAX_ROWS} 行，请分批导入`);

  const today = todayIn(timezone);
  const settings = await loadInventorySettings(db);
  const suppliers = await db<{ id: number; code: string; name: string }[]>`SELECT id, code, name FROM suppliers WHERE active`;
  const supByCode = new Map(suppliers.map((s) => [s.code.trim().toUpperCase(), s]));
  const supByName = new Map<string, (typeof suppliers)[number][]>();
  for (const s of suppliers) supByName.set(s.name.trim(), [...(supByName.get(s.name.trim()) ?? []), s]);
  const mats = await db<Mat[]>`
    SELECT id, code, name, inventory_unit, purchase_unit, purchase_factor_milli, decimals, expiry_tracked, shelf_life_days
    FROM materials WHERE active AND tracked`;
  const matByCode = new Map(mats.map((m) => [m.code.trim().toUpperCase(), m]));
  const matByName = new Map<string, Mat[]>();
  for (const m of mats) matByName.set(m.name.trim(), [...(matByName.get(m.name.trim()) ?? []), m]);

  const out: ReceiptImportRow[] = rows.map((r) => {
    const issues: string[] = [];
    if (!settings.directReceipt) issues.push('库管入库已在库存设置里关掉');
    // 入库日期
    const dateText = cell(r.cells, '入库日期');
    let docDate: string | null = null;
    if (!dateText) issues.push('入库日期：没填');
    else {
      docDate = isoDate(dateText);
      if (!docDate) issues.push(`入库日期：「${dateText}」看不懂（写成 2026-11-18 这样）`);
      else if (docDate > today) issues.push('入库日期：不能晚于今天');
    }
    // 供应商：编号或名称
    const supText = cell(r.cells, '供应商');
    let supplier: (typeof suppliers)[number] | null = null;
    if (!supText) issues.push('供应商：没填');
    else {
      supplier = supByCode.get(supText.toUpperCase()) ?? null;
      if (!supplier) {
        const found = supByName.get(supText) ?? [];
        if (found.length === 1) supplier = found[0]!;
        else if (found.length > 1) issues.push(`供应商：档案里有 ${found.length} 个「${supText}」，请写供应商编号（${found.map((s) => s.code).join('、')}）`);
        else issues.push(`供应商：「${supText}」不在供应商档案里（或已停用）`);
      }
    }
    // 物品：物料编号优先，其次名称
    const name = cell(r.cells, '物品名称');
    const code = cell(r.cells, '物料编号');
    let material: Mat | null = null;
    if (!name && !code) issues.push('物品名称：没填');
    if (code) {
      material = matByCode.get(code.toUpperCase()) ?? null;
      if (!material) issues.push(`物料编号：「${code}」不在物料档案里（或已停用、不是受管物料）`);
      else if (name && name !== material.name.trim()) {
        issues.push(`物料编号：「${code}」是「${material.name}」，与物品名称「${name}」对不上`);
        material = null;
      }
    } else if (name) {
      const found = matByName.get(name) ?? [];
      if (found.length === 0) issues.push(`物品名称：「${name}」不在物料档案里；先在库存「物料」里建档`);
      else if (found.length > 1) issues.push(`物品名称：档案里有 ${found.length} 个「${name}」，请在「物料编号」写是哪一个（${found.map((m) => m.code).join('、')}）`);
      else material = found[0]!;
    }
    // 单位：空着按库存单位；写采购单位的按包装换算
    const unit = cell(r.cells, '单位');
    let pack = false;
    if (material && unit && unit !== material.inventoryUnit) {
      if (unit === material.purchaseUnit) pack = true;
      else issues.push(`单位：「${unit}」不是「${material.name}」的库存单位（${material.inventoryUnit}）或采购单位（${material.purchaseUnit}）`);
    }
    const toBase = (label: string, text: string): number | null => {
      const q = qtyOf(text);
      if (q === null) {
        issues.push(text ? `${label}：「${text}」不对（要大于 0，最多 3 位小数）` : `${label}：没填`);
        return null;
      }
      if (!material) return null;
      const base = pack ? toBaseQty(q, Number(material.purchaseFactorMilli)) : q;
      if (base === null || base % 10 ** (3 - material.decimals) !== 0) {
        issues.push(`${label}：换算后不是整${material.inventoryUnit}（「${material.name}」最多 ${material.decimals} 位小数），请按${material.inventoryUnit}写`);
        return null;
      }
      return base;
    };
    const deliveredText = cell(r.cells, '送达数量');
    const deliveredMilli = toBase('送达数量', deliveredText);
    const acceptedText = cell(r.cells, '合格实收');
    let acceptedMilli = deliveredMilli;
    if (acceptedText) {
      const t = acceptedText.replace(/,/g, '').trim();
      if (t === '0') acceptedMilli = 0;
      else acceptedMilli = toBase('合格实收', acceptedText);
    }
    const rejectReason = cell(r.cells, '拒收原因');
    if (deliveredMilli !== null && acceptedMilli !== null) {
      if (acceptedMilli > deliveredMilli) issues.push('合格实收：不能多于送达数量');
      else if (acceptedMilli < deliveredMilli && !rejectReason) issues.push('拒收原因：合格实收比送达少，请写拒收原因');
    }
    if (rejectReason.length > 100) issues.push('拒收原因：最多 100 个字');
    // 单价：元，每采购单位
    const priceText = cell(r.cells, '单价');
    let priceCents: number | null = null;
    if (!priceText) issues.push('单价：没填');
    else {
      priceCents = parseYuan(priceText);
      if (priceCents === null || priceCents < 0) {
        issues.push(`单价：「${priceText}」不对（写元，最多 2 位小数）`);
        priceCents = null;
      } else if (priceCents > 100_000_000) issues.push('单价：太大了（最多 100 万元）');
    }
    const amountCents = material && priceCents !== null && acceptedMilli !== null ? lineAmountCents(acceptedMilli, priceCents, Number(material.purchaseFactorMilli)) : null;
    // 金额：选填，用来核对
    const amountText = cell(r.cells, '金额');
    if (amountText && amountCents !== null) {
      const given = parseYuan(amountText);
      if (given === null) issues.push(`金额：「${amountText}」不对（写元，最多 2 位小数）`);
      else if (Math.abs(given - amountCents) > 1) {
        issues.push(`金额：写的 ¥${formatAmount(given)} 与合格实收 × 单价算出来的 ¥${formatAmount(amountCents)} 对不上（单价按每${material!.purchaseUnit}）`);
      }
    }
    // 批号与效期
    const batchNo = cell(r.cells, '批号') || null;
    if (batchNo && batchNo.length > 40) issues.push('批号：最多 40 个字');
    const dateOf = (label: string) => {
      const t = cell(r.cells, label);
      if (!t) return null;
      const d = isoDate(t);
      if (!d) issues.push(`${label}：「${t}」看不懂（写成 2026-11-18 这样）`);
      return d;
    };
    const producedOn = dateOf('生产日期');
    const expiresOn = dateOf('到期日');
    if (material?.expiryTracked && !expiresOn && !(producedOn && material.shelfLifeDays)) {
      issues.push(`到期日：「${material.name}」管效期，请写到期日${material.shelfLifeDays ? '（或生产日期）' : ''}`);
    }
    const handler = cell(r.cells, '收货人');
    if (handler.length > 32) issues.push('收货人：最多 32 个字');
    const group = cell(r.cells, '单据分组');
    if (group.length > 40) issues.push('单据分组：最多 40 个字');
    const note = cell(r.cells, '备注');
    if (note.length > 100) issues.push('备注：最多 100 个字');
    return {
      row: r.row,
      seq: cell(r.cells, '序号'),
      docDate,
      supplier: supplier ? { id: Number(supplier.id), code: supplier.code, name: supplier.name } : null,
      material: material ? { id: Number(material.id), code: material.code, name: material.name, inventoryUnit: material.inventoryUnit, purchaseUnit: material.purchaseUnit } : null,
      deliveredMilli,
      acceptedMilli,
      unit,
      priceCents,
      amountCents,
      rejectReason,
      batchNo,
      producedOn,
      expiresOn,
      handler,
      group,
      note,
      issues,
    };
  });
  const [prev] = await db<{ id: number; createdAt: string; createdByName: string; docCount: number }[]>`
    SELECT i.id, i.created_at, s.display_name AS created_by_name, i.doc_count FROM receipt_imports i JOIN staff s ON s.id = i.created_by
    WHERE i.file_sha256 = ${sheet.sha256}`;
  const issueCount = out.filter((r) => r.issues.length).length;
  return {
    fileName: f.fileName,
    sha256: sheet.sha256,
    rows: out,
    groups: issueCount ? [] : chunks(out).map(groupOf),
    issueCount,
    amountCents: out.reduce((t, r) => t + (r.amountCents ?? 0), 0),
    previous: prev ? { id: Number(prev.id), createdAt: prev.createdAt, createdByName: prev.createdByName, docCount: Number(prev.docCount) } : null,
  };
}

const groupOf = (g: ReceiptImportRow[]): ReceiptImportGroup => ({
  docDate: g[0]!.docDate!,
  supplierName: g[0]!.supplier!.name,
  group: g[0]!.group,
  lines: g.length,
  amountCents: g.reduce((t, r) => t + (r.amountCents ?? 0), 0),
});

/** 按「入库日期 + 供应商 + 单据分组」合（按第一次出现的顺序），一张最多 100 行，超过的按顺序拆开 */
function chunks(rows: ReceiptImportRow[]): ReceiptImportRow[][] {
  const groups = new Map<string, ReceiptImportRow[]>();
  for (const r of rows) {
    const key = `${r.docDate}|${r.supplier!.id}|${r.group}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: ReceiptImportRow[][] = [];
  for (const g of groups.values()) for (let i = 0; i < g.length; i += RECEIPT_IMPORT_LINES_PER_DOC) out.push(g.slice(i, i + RECEIPT_IMPORT_LINES_PER_DOC));
  return out;
}

export async function previewReceiptImport(deps: Deps, raw: unknown): Promise<ReceiptImportPreview> {
  return plan(deps.sql, parse(PreviewInput, raw), deps.config.timezone);
}

export async function receiptImportResult(db: Db, importId: number, replayed: boolean): Promise<ReceiptImportResult> {
  const [imp] = await db<ReceiptImportResult['import'][]>`
    SELECT i.id, i.file_name, i.row_count, i.doc_count, i.amount_cents, i.created_at, s.display_name AS created_by_name
    FROM receipt_imports i JOIN staff s ON s.id = i.created_by WHERE i.id = ${importId}`;
  const docs = await db<ReceiptImportResult['docs']>`
    SELECT d.id, d.doc_no, d.doc_date, s.name AS supplier_name, d.amount_cents,
           (SELECT count(*)::int FROM inv_doc_lines l WHERE l.doc_id = d.id) AS line_count
    FROM inv_docs d JOIN suppliers s ON s.id = d.supplier_id WHERE d.import_id = ${importId} ORDER BY d.id`;
  return {
    import: { ...imp!, id: Number(imp!.id), amountCents: Number(imp!.amountCents) },
    docs: docs.map((d) => ({ ...d, id: Number(d.id), amountCents: Number(d.amountCents) })),
    replayed,
  };
}

export async function applyReceiptImport(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<ReceiptImportResult> {
  const f = parse(ApplyInput, raw);
  const requestHash = hashRequest({ ...f, clientKey: undefined });
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockOpKey(tx, f.clientKey);
    const [seen] = await tx<{ opType: string; requestHash: string; refId: number }[]>`
      SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${f.clientKey}`;
    if (seen) {
      if (seen.opType !== 'receipt_import' || seen.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次导入，请刷新页面后重新选择文件');
      return { id: Number(seen.refId), replayed: true };
    }
    await assertNotFenced(tx, f.clientKey, 'receipt_import', erpOpAbandoned);
    const first = readSheet(f, { dateColumns: DATE_COLUMNS, findHeader: isHeader });
    // 同一份文件串行处理：「以前导入过」的核对与写入不会两边都漏看（文件摘要的唯一约束兜底）
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`receipt_import:${first.sha256}`}, 0))`;
    const p = await plan(tx, f, deps.config.timezone);
    if (p.issueCount) {
      const bad = p.rows.filter((x) => x.issues.length);
      throw unprocessable(
        'IMPORT_INVALID',
        `有 ${bad.length} 行要先改好才能导入：${bad
          .slice(0, 3)
          .map((x) => `第 ${x.row} 行 ${x.issues[0]}`)
          .join('；')}`,
        { rows: bad.map((x) => ({ row: x.row, issues: x.issues })) },
      );
    }
    if (p.previous) {
      throw conflict('IMPORT_REPEAT', `这份文件 ${p.previous.createdByName} 已经导入过（生成 ${p.previous.docCount} 张库管入库），同一份文件不能再导入：重复入库会多出库存`, {
        importId: p.previous.id,
      });
    }
    const groups = chunks(p.rows);
    const [imp] = await tx<{ id: number }[]>`
      INSERT INTO receipt_imports (client_key, file_sha256, file_name, row_count, doc_count, amount_cents, created_by)
      VALUES (${f.clientKey}, ${p.sha256}, ${f.fileName}, ${p.rows.length}, ${groups.length}, ${p.amountCents}, ${actor.id})
      RETURNING id`;
    const importId = Number(imp!.id);
    // 先按日期取好单号，再按 id 升序锁住全部物料（与新建单据的顺序一致：单号计数 → 物料；之后每张单再锁同一批物料不会等）
    const order = groups.map((g, i) => ({ g, i })).sort((a, b) => (a.g[0]!.docDate! < b.g[0]!.docDate! ? -1 : a.g[0]!.docDate! > b.g[0]!.docDate! ? 1 : a.i - b.i));
    const docNos = new Map<number, string>();
    for (const { g, i } of order) docNos.set(i, await nextReceiptNo(tx, g[0]!.docDate!));
    const materialIds = [...new Set(p.rows.map((x) => x.material!.id))].sort((a, b) => a - b);
    await tx`SELECT id FROM materials WHERE id IN ${tx(materialIds)} ORDER BY id FOR UPDATE`;
    // 锁住物料以后再算一遍（Codex 审查 785ca18）：上面那一遍读物料时还没上锁，期间有人改了换算、单位或效期设置，
    // 数量与金额就是按旧档案算的，而开单（prepare）按新档案算——两边对不上。锁住以后的这一遍与上一遍逐行比，不一样就整份不导
    const again = await plan(tx, f, deps.config.timezone);
    if (JSON.stringify(again.rows) !== JSON.stringify(p.rows)) {
      throw conflict('IMPORT_STALE', '导入的这一刻有物料的档案（单位换算、效期等）刚被改过，这份台账没有导入；请重新预览、核对后再导入');
    }
    const note = `台账导入：${f.fileName}`.slice(0, 200);
    for (const [i, rows] of groups.entries()) {
      const head = rows[0]!;
      await createImportedReceipt(
        tx,
        deps,
        {
          docType: 'receipt',
          docDate: head.docDate!,
          note: [note, head.group ? `分组 ${head.group}` : ''].filter(Boolean).join(' · ').slice(0, 200),
          supplierId: head.supplier!.id,
          purchaseOrderId: null,
          handler: head.handler,
          direct: true,
          lines: rows.map((l) => ({
            materialId: l.material!.id,
            poLineId: null,
            deliveredMilli: l.deliveredMilli!,
            acceptedMilli: l.acceptedMilli!,
            rejectReason: l.rejectReason,
            priceCents: l.priceCents!,
            batchNo: l.batchNo,
            producedOn: l.producedOn,
            expiresOn: l.expiresOn,
            note: [l.seq ? `序号 ${l.seq}` : '', l.note].filter(Boolean).join(' · ').slice(0, 100),
          })),
        },
        actor,
        { docNo: docNos.get(i)!, importId, note },
      );
    }
    await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${f.clientKey}, 'receipt_import', ${requestHash}, ${importId}, ${actor.id})`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'receipt_import',
      targetType: 'receipt_import',
      targetId: importId,
      detail: { fileName: f.fileName, rows: p.rows.length, docs: groups.length, amountCents: p.amountCents, sha256: p.sha256 },
      ip,
    });
    return { id: importId, replayed: false };
  });
  return receiptImportResult(deps.sql, r.id, r.replayed);
}

// ───────────────────────── 模板 ─────────────────────────

const COLUMN_SPEC: Record<(typeof RECEIPT_IMPORT_COLUMNS)[number], { width: number; how: string; example: string }> = {
  序号: { width: 7, how: '随便填，方便自己对照；记进这一行的备注', example: '1' },
  入库日期: { width: 13, how: '写成 2026-11-18 或 2026/11/18；不能晚于今天', example: '2026-11-18' },
  供应商: { width: 20, how: '从下拉里选供应商档案里的名称（也可以写供应商编号）；网购写对应的网购平台供应商', example: '城东批发' },
  物品名称: { width: 22, how: '从下拉里选物料档案里的物品；不在档案里的先去库存「物料」建档', example: '抽纸' },
  物料编号: { width: 11, how: '选填。档案里有同名的几个物料时写编号（见「选项」表）', example: 'A001' },
  送达数量: { width: 10, how: '大于 0，最多 3 位小数；单位见「单位」一列', example: '10' },
  合格实收: { width: 10, how: '选填，空着 = 全部合格；比送达少要写拒收原因', example: '10' },
  单位: { width: 8, how: '选填，空着按库存单位；写采购单位（如「箱」）时按包装换算', example: '箱' },
  单价: { width: 10, how: '元，每采购单位（与收货页面上的单价一样），最多 2 位小数', example: '35.5' },
  金额: { width: 11, how: '选填，用来核对：与合格实收 × 单价差 1 分以上的会标出来', example: '355' },
  拒收原因: { width: 16, how: '合格实收比送达少时必填，最多 100 个字', example: '破损 1 箱' },
  批号: { width: 12, how: '选填，最多 40 个字', example: 'B20261101' },
  生产日期: { width: 13, how: '选填；管效期的物料可以只写生产日期（按保质期算到期日）', example: '2026-11-01' },
  到期日: { width: 13, how: '管效期的物料必填（或写生产日期）', example: '2027-11-01' },
  收货人: { width: 10, how: '选填，最多 32 个字', example: '李晓' },
  单据分组: { width: 12, how: '选填。同一天同一家供应商想拆成几张单时写不同的分组；空着同一天同一家合成一张', example: '早班' },
  备注: { width: 20, how: '选填，最多 100 个字', example: '' },
};

export async function receiptImportTemplate(db: Db): Promise<Buffer> {
  const suppliers = await db<{ code: string; name: string; settlement: string }[]>`SELECT code, name, settlement FROM suppliers WHERE active ORDER BY name`;
  const mats = await db<{ code: string; name: string; specification: string; inventoryUnit: string; purchaseUnit: string; category: string }[]>`
    SELECT code, name, specification, inventory_unit, purchase_unit, category FROM materials WHERE active AND tracked ORDER BY category, code`;
  const required = new Set<string>(RECEIPT_IMPORT_REQUIRED);
  const last = RECEIPT_IMPORT_MAX_ROWS + 1;
  const range = (name: string) => {
    const c = colName(RECEIPT_IMPORT_COLUMNS.indexOf(name as (typeof RECEIPT_IMPORT_COLUMNS)[number]));
    return `${c}2:${c}${last}`;
  };
  const validations: WbValidation[] = RECEIPT_IMPORT_COLUMNS.map((name) => {
    const v: WbValidation = { sqref: range(name), promptTitle: `${name}（${required.has(name) ? '必填' : '选填'}）`, prompt: COLUMN_SPEC[name].how };
    if (name === '供应商' && suppliers.length) Object.assign(v, { list: { name: 'opt_supplier' }, error: '请从下拉里选供应商档案里的供应商' });
    if (name === '物品名称' && mats.length) Object.assign(v, { list: { name: 'opt_material' }, error: '只能选物料档案里的物品；新物品先去库存「物料」建档' });
    return v;
  });
  const main: WbSheet = {
    name: '入库台账',
    active: true,
    widths: RECEIPT_IMPORT_COLUMNS.map((c) => COLUMN_SPEC[c].width),
    freezeRows: 1,
    rows: [{ height: 24, cells: RECEIPT_IMPORT_COLUMNS.map((c) => ({ v: c, style: required.has(c) ? 'required' : 'optional' })) }],
    validations,
  };
  const guide: WbSheet = {
    name: '填写说明',
    widths: [12, 8, 64, 16],
    freezeRows: 0,
    rows: [
      { height: 26, cells: [{ v: '库管入库台账 · 填写说明', style: 'title' }] },
      { cells: [{ v: '在「入库台账」里一行写一样东西；橙色表头必填、灰色选填；表头的名字不要改（顺序可以换，多出来的列不管）。', style: 'note' }] },
      { height: 22, cells: ['列', '必填', '怎么填', '例子'].map((v) => ({ v, style: 'optional' as const })) },
      ...RECEIPT_IMPORT_COLUMNS.map((c) => ({
        cells: [
          { v: c, style: 'body' as const },
          { v: required.has(c) ? '必填' : '选填', style: 'body' as const },
          { v: COLUMN_SPEC[c].how, style: 'body' as const },
          { v: COLUMN_SPEC[c].example, style: 'body' as const },
        ],
      })),
      { cells: [] },
      { cells: [{ v: `导入：在库存页「库管入库」旁点「导入台账」，选这份文件 →「预览」逐行核对 → 没有问题再「导入」。一份最多 ${RECEIPT_IMPORT_MAX_ROWS} 行。`, style: 'note' }] },
      { cells: [{ v: `按「入库日期 + 供应商 + 单据分组」合成库管入库单，一张最多 ${RECEIPT_IMPORT_LINES_PER_DOC} 行；导入即确认入库（与手填的「确认入库」一样）。`, style: 'note' }] },
      { cells: [{ v: '有问题的行在预览里整行标红、写明哪一列为什么；有一行有问题整份都不导入，改好再选一次文件。', style: 'note' }] },
      { cells: [{ v: '同一份文件只能导入一次（重复入库会多出库存）；导错了在库存单据里逐张冲销。', style: 'note' }] },
    ],
    merges: ['A1:D1', 'A2:D2', ...[0, 1, 2, 3].map((i) => `A${RECEIPT_IMPORT_COLUMNS.length + 5 + i}:D${RECEIPT_IMPORT_COLUMNS.length + 5 + i}`)],
  };
  const optRows = Math.max(suppliers.length, mats.length, 1);
  const options: WbSheet = {
    name: '选项',
    widths: [20, 12, 8, 24, 12, 22, 10, 10, 14],
    freezeRows: 1,
    rows: [
      { cells: ['供应商', '供应商编号', '结算', '物品名称', '物料编号', '规格', '库存单位', '采购单位', '分类'].map((v) => ({ v, style: 'optional' as const })) },
      ...Array.from({ length: optRows }, (_, i) => ({
        cells: [
          suppliers[i]?.name ?? null,
          suppliers[i]?.code ?? null,
          suppliers[i] ? (suppliers[i]!.settlement === 'cash' ? '现付' : '挂账') : null,
          mats[i]?.name ?? null,
          mats[i]?.code ?? null,
          mats[i]?.specification ?? null,
          mats[i]?.inventoryUnit ?? null,
          mats[i]?.purchaseUnit ?? null,
          mats[i]?.category ?? null,
        ],
      })),
    ],
  };
  const names = [
    ...(suppliers.length ? [{ name: 'opt_supplier', sheet: '选项', range: `$A$2:$A$${suppliers.length + 1}` }] : []),
    ...(mats.length ? [{ name: 'opt_material', sheet: '选项', range: `$D$2:$D$${mats.length + 1}` }] : []),
  ];
  return buildWorkbook([main, guide, options], names);
}

export function registerReceiptImportRoutes(app: FastifyInstance, deps: Deps) {
  const bodyLimit = 4_000_000;
  const operate = guard('inventory.operate');
  app.get('/api/inventory/direct-receipts/template', { preHandler: operate }, async (_req, reply) => {
    const buf = await receiptImportTemplate(deps.sql);
    attachment(reply, '库管入库台账模板.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return reply.send(buf);
  });
  app.post('/api/inventory/direct-receipts/import/preview', { preHandler: operate, bodyLimit }, async (req) => previewReceiptImport(deps, req.body));
  app.post('/api/inventory/direct-receipts/import', { preHandler: operate, bodyLimit }, async (req, reply) => {
    const r = await applyReceiptImport(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
  app.get('/api/inventory/direct-receipts/imports/:id', { preHandler: guard('inventory.read') }, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    return receiptImportResult(deps.sql, id, false);
  });
}
