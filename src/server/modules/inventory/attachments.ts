// 收货单的附件（8.0.1 采购组整改 11，CG11，docs/PURCHASING_V801.md）：货物、送货单、小票的照片（≤ 1 MB）与 PDF（≤ 10 MB）。
// 收货单（按采购单收货、急采）登记后挂，生效以后还能补传，不能删；每张最多 9 份。现付供应商的采购单收货生效以后，
// 财务「待报销」里看得到收货单与附件数，转报销时报销单上看得到附件（expenses.ts）。
// 加锁：先按内容存图片 / PDF（唯一索引去重，不加锁），再锁收货单一行（FOR NO KEY UPDATE，与收货单自己的修改串行）核对份数、写挂接。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ReceiptAttachment } from '@shared/inventory';
import type { Db } from '../../db';
import { guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import { attachment } from '../../lib/csv';
import type { Actor, Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { saveImage } from '../requests';
import { readFile, storePdf } from './files';
import { loadSettings } from '../settings';

const AttachmentInput = z.object({
  name: z.string().trim().max(80, '名称最多 80 个字').default(''),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], '只能上传照片（JPEG、PNG、WebP）或 PDF'),
  data: z.string().min(16),
});

/** 几张收货单的附件（按上传先后） */
export async function receiptAttachments(db: Db, docIds: number[]): Promise<Map<number, ReceiptAttachment[]>> {
  const out = new Map<number, ReceiptAttachment[]>();
  if (docIds.length === 0) return out;
  const rows = await db<{ id: number; docId: number; imageId: number | null; fileId: number | null; name: string; sizeBytes: number; uploadedByName: string; uploadedAt: string }[]>`
    SELECT a.id, a.doc_id, a.image_id, a.file_id, a.name, coalesce(i.size_bytes, f.size_bytes) AS size_bytes,
           s.display_name AS uploaded_by_name, a.uploaded_at
    FROM inv_doc_attachments a JOIN staff s ON s.id = a.uploaded_by
    LEFT JOIN erp_images i ON i.id = a.image_id LEFT JOIN erp_files f ON f.id = a.file_id
    WHERE a.doc_id IN ${db(docIds)} ORDER BY a.uploaded_at, a.id`;
  for (const r of rows) {
    const docId = Number(r.docId);
    const list = out.get(docId) ?? [];
    list.push({
      id: Number(r.id),
      kind: r.imageId ? 'image' : 'pdf',
      name: r.name,
      url: r.imageId ? `/api/erp/images/${r.imageId}` : `/api/inventory/receipt-attachments/${r.id}/download`,
      sizeBytes: Number(r.sizeBytes),
      uploadedByName: r.uploadedByName,
      uploadedAt: r.uploadedAt,
    });
    out.set(docId, list);
  }
  return out;
}

export async function addReceiptAttachment(deps: Deps, docId: number, raw: unknown, actor: Actor, ip?: string): Promise<ReceiptAttachment[]> {
  const input = parse(AttachmentInput, raw);
  const [doc] = await deps.sql<{ docType: string; status: string }[]>`SELECT doc_type, status FROM inv_docs WHERE id = ${docId}`;
  if (!doc) throw notFound('单据不存在');
  if (doc.docType !== 'receipt') throw unprocessable('ATTACHMENT_NOT_RECEIPT', '只有收货单可以挂附件');
  // 先存内容（同一份只存一份）
  const stored =
    input.mime === 'application/pdf'
      ? { fileId: (await storePdf(deps.sql, 'receipt', input.data, actor)).id, imageId: null }
      : { imageId: (await saveImage(deps.sql, { mime: input.mime, data: input.data }, actor)).id, fileId: null };
  await deps.sql.begin(async (tx) => {
    const [d] = await tx<{ status: string; docNo: string }[]>`SELECT status, doc_no FROM inv_docs WHERE id = ${docId} FOR NO KEY UPDATE`;
    if (!d) throw notFound('单据不存在');
    if (d.status === 'cancelled' || d.status === 'voided') throw conflict('INVALID_STATE', '撤回、冲销了的收货单不能再挂附件');
    const [dup] = await tx<{ id: number }[]>`
      SELECT id FROM inv_doc_attachments
      WHERE doc_id = ${docId} AND (image_id = ${stored.imageId} OR file_id = ${stored.fileId})`;
    if (dup) return; // 同一份已经挂着
    const [n] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM inv_doc_attachments WHERE doc_id = ${docId}`;
    // 每张最多几份（CG11，8.0.7 起在「门店基本规则 → 可调的数值」里改）
    const { receiptAttachmentsMax } = await loadSettings(tx);
    if (n!.n >= receiptAttachmentsMax) throw conflict('ATTACHMENT_LIMIT', `每张收货单最多 ${receiptAttachmentsMax} 份附件`);
    const name = input.name || (stored.fileId ? 'PDF' : '照片');
    await tx`
      INSERT INTO inv_doc_attachments (doc_id, image_id, file_id, name, uploaded_by)
      VALUES (${docId}, ${stored.imageId}, ${stored.fileId}, ${name}, ${actor.id})`;
    await writeAudit(tx, { staffId: actor.id, action: 'receipt_attachment', targetType: 'inv_doc', targetId: docId, detail: { docNo: d.docNo, name, imageId: stored.imageId, fileId: stored.fileId }, ip });
  });
  return (await receiptAttachments(deps.sql, [docId])).get(docId) ?? [];
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const readers = guardAny('inventory.read', 'expense.read');
  app.get('/api/inventory/docs/:id/attachments', { preHandler: readers }, async (req) => {
    const { id } = parse(idParam, req.params);
    return (await receiptAttachments(sql, [id])).get(id) ?? [];
  });
  // 收货的仓库、采购（一起验收、急采登记）都能挂；10 MB 的 PDF 转成 Base64 约 13.4 MB
  app.post('/api/inventory/docs/:id/attachments', { preHandler: guardAny('inventory.operate', 'purchase.manage'), bodyLimit: 14_500_000 }, async (req, reply) => {
    const list = await addReceiptAttachment(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip);
    reply.code(201);
    return list;
  });
  app.get('/api/inventory/receipt-attachments/:id/download', { preHandler: readers }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const [a] = await sql<{ fileId: number | null; name: string }[]>`SELECT file_id, name FROM inv_doc_attachments WHERE id = ${id}`;
    if (!a || !a.fileId) throw notFound('附件不存在');
    const file = await readFile(sql, Number(a.fileId), 'receipt');
    if (!file) throw notFound('附件不存在');
    attachment(reply, a.name.toLowerCase().endsWith('.pdf') ? a.name : `${a.name}.pdf`, file.mime);
    return reply.send(file.data);
  });
}
