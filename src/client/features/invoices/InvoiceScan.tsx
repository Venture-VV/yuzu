// 8.0.21 发票识别（docs/FINANCE_V8021.md 第 2 节，CW-A / CW1）：登记发票的几个表单共用的「拍照 / 选文件识别」。
// 识别在浏览器本机做（features/invoices/invoice-scan），结果填进表单、每一格标「识别」；
// 识别过的表单要勾「已对照票面核对」才能提交，提交时带上登记方式（qr / ocr），只为统计。

import { useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';
import type { InvoiceEntryMethod, RecognizedInvoice } from '@shared/invoice-recognize';
import { INVOICE_ENTRY_LABELS } from '@shared/invoice-recognize';
import { Badge, Button, ConfirmCheck } from '../../components/ui';

/** 识别的状态：哪几格是识别填的、核对过没有 */
export function useInvoiceRecognition() {
  const [method, setMethod] = useState<'qr' | 'ocr' | null>(null);
  const [fields, setFields] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState(false);
  return {
    method,
    /** 提交给服务端的登记方式 */
    entryMethod: (method ?? 'manual') as InvoiceEntryMethod,
    checked,
    setChecked,
    /** 识别过、还没勾核对：表单不能提交 */
    needsCheck: method !== null && !checked,
    isRecognized: (field: string) => fields.has(field),
    apply(result: RecognizedInvoice, filled: string[]) {
      setMethod(result.method);
      setFields(new Set(filled));
      setChecked(false);
    },
    reset() {
      setMethod(null);
      setFields(new Set());
      setChecked(false);
    },
  };
}
export type InvoiceRecognition = ReturnType<typeof useInvoiceRecognition>;

/** 字段名旁边的「识别」小标 */
export function RecognizedMark({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <Badge tone="lake" className="ml-1.5 align-middle">
      识别
    </Badge>
  );
}

export function InvoiceScanButton({ onResult, disabled }: { onResult: (r: RecognizedInvoice) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy('正在识别');
    try {
      const { recognizeInvoiceFile } = await import('./invoice-scan');
      const r = await recognizeInvoiceFile(file, (m) => setBusy(m));
      onResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : '识别没成功，请手填');
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="invoice-scan">
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} data-testid="invoice-scan-file" />
      <Button size="sm" variant="secondary" icon={<ScanLine className="size-4" />} loading={!!busy} disabled={disabled} onClick={() => input.current?.click()}>
        拍照 / 选文件识别
      </Button>
      <span className="text-[12.5px] text-ink-3">{busy ?? '二维码优先，读不到再识别文字；只在这台设备上识别，不传给别人'}</span>
      {error && (
        <span className="w-full text-[12.5px] font-semibold text-clay" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** 识别过的表单底下：提示怎么来的、要勾核对 */
export function RecognitionCheck({ rec, hint }: { rec: InvoiceRecognition; hint?: string }) {
  if (!rec.method) return null;
  return (
    <div className="rounded-lg border border-lake/30 bg-lake-soft/40 px-3 py-2.5" data-testid="invoice-recognition">
      <p className="text-[12.5px] text-ink-2">
        {INVOICE_ENTRY_LABELS[rec.method]}带出了标「识别」的几格{hint ? `；${hint}` : ''}。请对照票面逐格核对，改错的直接改。
      </p>
      <div className="mt-2">
        <ConfirmCheck checked={rec.checked} onChange={rec.setChecked}>
          已对照票面核对过识别出来的内容
        </ConfirmCheck>
      </div>
    </div>
  );
}

/** 按票种提示挑发票类型：认得出专票 / 普票时选台账里对应的那一类 */
export function kindFromHint(kinds: { key: string; label: string }[], hint: RecognizedInvoice['kindHint']): string | null {
  if (!hint) return null;
  const want = hint === 'special' ? /专用/ : /普通/;
  return kinds.find((k) => want.test(k.label))?.key ?? null;
}
