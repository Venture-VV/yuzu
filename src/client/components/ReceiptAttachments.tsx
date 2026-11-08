// 收货单的附件（8.0.1 采购组整改 11，CG11）：照片缩略图 + PDF 链接；收货单详情里可以补传（不能删）。
// 财务的待报销、转报销页与报销单上用同一个只读列表看。

import { useRef, useState } from 'react';
import { FileText, Paperclip, Upload } from 'lucide-react';
import type { PoReceiptRef } from '@shared/expenses';
import { MAX_PDF_BYTES, MAX_RECEIPT_ATTACHMENTS, type ReceiptAttachment } from '@shared/inventory';
import { api, errorMessage } from '../lib/api';
import { cn } from '../lib/utils';
import { ImageThumbs, imagePayload } from './Images';
import { Button, Notice } from './ui';

/** 只读：照片缩略图（点开看大图）、PDF 链接（下载） */
export function AttachmentList({ items, size = 44, className }: { items: ReceiptAttachment[]; size?: number; className?: string }) {
  if (items.length === 0) return null;
  const images = items.filter((a) => a.kind === 'image').map((a) => ({ id: a.id, url: a.url }));
  const pdfs = items.filter((a) => a.kind === 'pdf');
  return (
    <span className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <ImageThumbs images={images} size={size} />
      {pdfs.map((p) => (
        <a
          key={p.id}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-line bg-card px-2 py-1 text-[12.5px] font-semibold text-lake hover:border-line-strong"
        >
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate">{p.name.toLowerCase().endsWith('.pdf') ? p.name : `${p.name}.pdf`}</span>
        </a>
      ))}
    </span>
  );
}

/** 采购单的收货单与附件（转报销页、报销单上看） */
export function PoReceiptsList({ receipts }: { receipts: PoReceiptRef[] }) {
  if (receipts.length === 0) return null;
  return (
    <ul className="space-y-1.5" data-testid="po-receipts">
      {receipts.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
          <Paperclip className="size-3.5 text-ink-3" />
          <span className="num font-semibold">{r.docNo}</span>
          <span className="text-ink-3">收货 {r.docDate}</span>
          {r.attachments.length === 0 ? <span className="text-ink-3">· 没有附件</span> : <AttachmentList items={r.attachments} size={36} />}
        </li>
      ))}
    </ul>
  );
}

const toBase64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('读不了这个文件'));
    r.readAsDataURL(file);
  });

/**
 * 收货单详情里的附件：列表 + 补传（照片压缩到 1 MB 以内；PDF ≤ 10 MB）；最多 9 份，不能删。
 * 8.0.3 起进项发票的照片也用它（uploadUrl、标题、份数上限另给）。
 */
export function ReceiptAttachmentsPanel({
  docId,
  items,
  canUpload,
  onChanged,
  uploadUrl,
  title = '附件（照片、送货单、小票）',
  note = '生效以后还能补传，不能删',
  max = MAX_RECEIPT_ATTACHMENTS,
  testId = 'receipt-attachments',
}: {
  docId: number;
  items: ReceiptAttachment[];
  canUpload: boolean;
  onChanged: () => unknown;
  uploadUrl?: string;
  title?: string;
  note?: string;
  max?: number;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = items.length >= max;
  const url = uploadUrl ?? `/api/inventory/docs/${docId}/attachments`;
  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of [...files].slice(0, max - items.length)) {
        const name = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
        if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
          if (file.size > MAX_PDF_BYTES) throw new Error(`「${file.name}」超过 10 MB`);
          await api.post(url, { name, mime: 'application/pdf', data: await toBase64(file) }, { timeoutMs: 60_000 });
        } else {
          const { mime, data } = await imagePayload(file);
          await api.post(url, { name, mime, data }, { timeoutMs: 30_000 });
        }
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
      await onChanged();
    }
  };
  return (
    <section data-testid={testId}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-bold text-ink-2">{title}</h3>
        <span className="text-[12px] text-ink-3">
          {items.length}/{max} 份 · {note}
        </span>
        {canUpload && !full && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
              className="hidden"
              onChange={(e) => void upload(e.target.files)}
              data-testid={testId === 'receipt-attachments' ? 'receipt-attachment-file' : `${testId}-file`}
            />
            <Button size="sm" variant="secondary" className="ml-auto" icon={<Upload className="size-4" />} loading={busy} onClick={() => input.current?.click()}>
              上传附件
            </Button>
          </>
        )}
      </div>
      {items.length === 0 ? <p className="text-[12.5px] text-ink-3">还没有附件</p> : <AttachmentList items={items} />}
      {error && <Notice tone="error" title={error} className="mt-2" />}
    </section>
  );
}
