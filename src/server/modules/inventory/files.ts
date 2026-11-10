// 文件（PDF）的存取（8.0.1 采购组整改，docs/PURCHASING_V801.md）：
//   · 签约供应商的合同 PDF（08，CG08）：供应商档案里上传、下载、撤下（撤下保留记录）；
//   · 收货单的附件（11，CG11）也存在 erp_files 里（scope = receipt），挂接与权限在 attachments.ts。
// 文件存在数据库里（随备份、异地副本与数据指纹走），同一用途下同一份文件（内容摘要相同）只存一份，只追加。
// 加锁：上传先按内容存文件（唯一索引去重，不加锁），再锁供应商一行写挂接；撤下只锁那一条。

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_PDF_BYTES, type SupplierContractFile } from '@shared/inventory';
import type { Db } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import { attachment } from '../../lib/csv';
import type { Actor, Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { pdfMaxBytes } from '@shared/tunables';
import { loadSettings } from '../settings';

export type FileScope = 'supplier_contract' | 'receipt' | 'invoice';

const PdfInput = z.object({
  name: z.string().trim().min(1, '请写文件名').max(80, '文件名最多 80 个字'),
  mime: z.literal('application/pdf', '只能上传 PDF 文件'),
  data: z.string().min(16).max(Math.ceil((MAX_PDF_BYTES * 4) / 3) + 16, '文件不能超过 10 MB'),
});

/** 核对 PDF 的文件头与大小，按内容摘要存一份（已有的直接用），返回文件编号 */
export async function storePdf(db: Db, scope: FileScope, base64: string, actor: Actor): Promise<{ id: number; sizeBytes: number }> {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw unprocessable('FILE_NOT_PDF', '这不是 PDF 文件，请导出成 PDF 再上传');
  // 每份最大（CG08，默认 10 MB，8.0.7 起在「经营规则 → 可调的数值」里往小调）
  const { pdfMaxMb } = await loadSettings(db);
  if (buf.length > Math.min(MAX_PDF_BYTES, pdfMaxBytes({ pdfMaxMb }))) throw unprocessable('FILE_TOO_LARGE', `文件不能超过 ${pdfMaxMb} MB`);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  await db`
    INSERT INTO erp_files (scope, sha256, mime, size_bytes, data, created_by)
    VALUES (${scope}, ${sha256}, 'application/pdf', ${buf.length}, ${buf}, ${actor.id})
    ON CONFLICT (scope, sha256) DO NOTHING`;
  const [row] = await db<{ id: number }[]>`SELECT id FROM erp_files WHERE scope = ${scope} AND sha256 = ${sha256}`;
  return { id: Number(row!.id), sizeBytes: buf.length };
}

export async function readFile(db: Db, fileId: number, scope: FileScope): Promise<{ data: Buffer; mime: string } | null> {
  const [row] = await db<{ data: Buffer; mime: string }[]>`SELECT data, mime FROM erp_files WHERE id = ${fileId} AND scope = ${scope}`;
  return row ?? null;
}

export async function supplierContractFiles(db: Db, supplierId: number): Promise<SupplierContractFile[]> {
  const rows = await db<Omit<SupplierContractFile, 'url'>[]>`
    SELECT f.id, f.name, e.size_bytes, s.display_name AS uploaded_by_name, f.uploaded_at
    FROM supplier_contract_files f JOIN erp_files e ON e.id = f.file_id JOIN staff s ON s.id = f.uploaded_by
    WHERE f.supplier_id = ${supplierId} AND f.removed_at IS NULL
    ORDER BY f.uploaded_at, f.id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), sizeBytes: Number(r.sizeBytes), url: `/api/inventory/supplier-contract-files/${r.id}/download` }));
}

async function uploadContract(deps: Deps, supplierId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(PdfInput, raw);
  const file = await storePdf(deps.sql, 'supplier_contract', input.data, actor);
  await deps.sql.begin(async (tx) => {
    const [s] = await tx<{ contracted: boolean; name: string }[]>`SELECT contracted, name FROM suppliers WHERE id = ${supplierId} FOR UPDATE`;
    if (!s) throw notFound('供应商不存在');
    if (!s.contracted) throw unprocessable('SUPPLIER_NOT_CONTRACTED', `「${s.name}」是未签约的供应商；先在档案里改成「签约」再上传合同`);
    const [dup] = await tx<{ id: number }[]>`
      SELECT id FROM supplier_contract_files WHERE supplier_id = ${supplierId} AND file_id = ${file.id} AND removed_at IS NULL`;
    if (dup) return; // 同一份文件已经挂着
    await tx`INSERT INTO supplier_contract_files (supplier_id, file_id, name, uploaded_by) VALUES (${supplierId}, ${file.id}, ${input.name}, ${actor.id})`;
    await writeAudit(tx, { staffId: actor.id, action: 'supplier_contract_file', targetType: 'supplier', targetId: supplierId, detail: { name: input.name, fileId: file.id, sizeBytes: file.sizeBytes }, ip });
  });
  return supplierContractFiles(deps.sql, supplierId);
}

async function removeContract(deps: Deps, id: number, actor: Actor, ip?: string) {
  let supplierId = 0;
  await deps.sql.begin(async (tx) => {
    const [f] = await tx<{ supplierId: number; name: string; removedAt: string | null }[]>`
      SELECT supplier_id, name, removed_at FROM supplier_contract_files WHERE id = ${id} FOR UPDATE`;
    if (!f) throw notFound('合同文件不存在');
    supplierId = Number(f.supplierId);
    if (f.removedAt) return; // 幂等
    await tx`UPDATE supplier_contract_files SET removed_by = ${actor.id}, removed_at = now() WHERE id = ${id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'supplier_contract_file_removed', targetType: 'supplier', targetId: supplierId, detail: { id, name: f.name }, ip });
  });
  return supplierContractFiles(deps.sql, supplierId);
}

export function registerFileRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const readers = guardAny('inventory.read', 'contract.read');
  app.get('/api/inventory/suppliers/:id/contract-files', { preHandler: readers }, async (req) => {
    const { id } = parse(idParam, req.params);
    const [s] = await sql<{ id: number }[]>`SELECT id FROM suppliers WHERE id = ${id}`;
    if (!s) throw notFound('供应商不存在');
    return supplierContractFiles(sql, id);
  });
  // 10 MB 的 PDF 转成 Base64 约 13.4 MB
  app.post('/api/inventory/suppliers/:id/contract-files', { preHandler: guard('inventory.master'), bodyLimit: 14_500_000 }, async (req, reply) => {
    const files = await uploadContract(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip);
    reply.code(201);
    return files;
  });
  app.post('/api/inventory/supplier-contract-files/:id/remove', { preHandler: guard('inventory.master') }, async (req) =>
    removeContract(deps, parse(idParam, req.params).id, req.actor, req.ip),
  );
  app.get('/api/inventory/supplier-contract-files/:id/download', { preHandler: readers }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const [f] = await sql<{ fileId: number; name: string; removedAt: string | null }[]>`
      SELECT file_id, name, removed_at FROM supplier_contract_files WHERE id = ${id}`;
    if (!f) throw notFound('合同文件不存在');
    if (f.removedAt) throw conflict('FILE_REMOVED', '这份合同已经撤下');
    const file = await readFile(sql, Number(f.fileId), 'supplier_contract');
    if (!file) throw notFound('合同文件不存在');
    const name = f.name.toLowerCase().endsWith('.pdf') ? f.name : `${f.name}.pdf`;
    attachment(reply, name, file.mime);
    return reply.send(file.data);
  });
}
