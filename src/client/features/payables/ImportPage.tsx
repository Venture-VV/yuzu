import { useRef, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { ArrowLeft, CircleCheck, Download, FileSearch, FileUp } from 'lucide-react';
import { formatAmount } from '@shared/money';
import {
  ERP_IMPORT_LABELS,
  OPENING_IMPORT_COLUMNS,
  SUPPLIER_IMPORT_COLUMNS,
  type ErpImportKind,
  type ErpImportPreview,
  type ErpImportRecord,
} from '@shared/purchasing';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpPending } from '../../lib/erpPending';
import { readImportFile } from '../../lib/import-file';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Notice, Segmented, Skeleton } from '../../components/ui';
import { useErpImports, useInvalidateAll } from '../purchasing/queries';

// 供应商与期初未付批量导入（#16，v0.7.12）：下载模板 → 选 CSV 或 Excel → 预览（逐行校验）→ 写入；同一个文件只能写入一次

const TEMPLATES: Record<ErpImportKind, { columns: readonly string[]; sample: string[][]; hint: string }> = {
  suppliers: {
    columns: SUPPLIER_IMPORT_COLUMNS,
    sample: [['S101', '示例供应商（请替换）', '张三', '13800000000', '挂账', '']],
    hint: '编码、名称必填；结算方式写「挂账」或「现付」（空着按挂账）；编码已存在的不覆盖，要改请在档案里改。',
  },
  opening_payables: {
    columns: OPENING_IMPORT_COLUMNS,
    sample: [['S101', '1200.00', '2026-10-31', '截至 10 月底对账确认']],
    hint: '供应商要先建好（或先导入供应商）；金额写元；免确认门槛以内的直接确认，超过的等负责人确认（可以一次确认整批）。',
  },
};

type Loaded = { fileName: string; csv?: string; xlsxBase64?: string; encoding: string };

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function downloadTemplate(kind: ErpImportKind) {
  const t = TEMPLATES[kind];
  const csv = '﻿' + [t.columns.join(','), ...t.sample.map((r) => r.join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${ERP_IMPORT_LABELS[kind]}导入模板.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportPage() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const kinds = (['suppliers', 'opening_payables'] as const).filter((k) => (k === 'suppliers' ? can('inventory.master') : can('payable.manage')));
  const [kind, setKind] = useState<ErpImportKind>(kinds[0] ?? 'suppliers');
  const [file, setFile] = useState<Loaded | null>(null);
  const [preview, setPreview] = useState<ErpImportPreview | null>(null);
  // 每换一次文件或导入类型就加一：晚回来的预览、文件读取对不上现在选的文件，丢掉（不能让 A 的预览配着 B 写入）
  const selection = useRef(0);
  const [busy, setBusy] = useState<'read' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 负责人只看导入记录、一次确认整批导入的期初未付（不能导入）
  const canApprove = can('inventory.approve');
  // 结果待确认的导入记在本机（AGENTS.md）：查回、按原内容重新提交或作废之前，不能再写入新的一份
  const pending = useErpPending(['erp_import']);
  const history = useErpImports(kinds.length > 0 || canApprove);
  if (kinds.length === 0 && !canApprove) return <Navigate to="/payables" replace />;

  const reset = () => {
    selection.current += 1;
    setFile(null);
    setPreview(null);
    setError(null);
  };
  const body = () => ({ kind, fileName: file!.fileName, csv: file!.csv, xlsxBase64: file!.xlsxBase64, encoding: file!.encoding });

  const choose = async (f: File | undefined) => {
    reset();
    if (!f) return;
    const ticket = selection.current;
    const current = () => selection.current === ticket;
    setBusy('read');
    try {
      if (/\.xlsx$/i.test(f.name)) {
        const xlsxBase64 = toBase64(await f.arrayBuffer());
        if (current()) setFile({ fileName: f.name, xlsxBase64, encoding: 'Excel' });
      } else if (/\.csv$/i.test(f.name) || f.type === 'text/csv') {
        const loaded = await readImportFile(f);
        if (current()) setFile({ fileName: f.name, csv: loaded.text, encoding: loaded.label.includes('GBK') ? 'GBK' : 'UTF-8' });
      } else setError('只能导入 CSV（.csv）或 Excel（.xlsx）文件；老版本的 .xls 请另存为 .xlsx 或 CSV');
    } catch (e) {
      if (current()) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async () => {
    if (!file) return;
    const ticket = selection.current;
    setBusy('preview');
    setError(null);
    try {
      const result = await api.post<ErpImportPreview>('/api/payables/imports/preview', body());
      if (selection.current === ticket) setPreview(result);
    } catch (e) {
      if (selection.current === ticket) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // 每次写入用新的操作编号：先把编号和原请求（含文件内容）记在本机并读回核对，记不下就不发请求；
  // 结果不明的那一次由页面上方按原编号查回、原样重新提交或作废——不要改了文件再导入（内容一变，同一个文件的查重就认不出来）
  const apply = async () => {
    if (!file) return;
    if (pending.length > 0) return setError('上一次导入结果待确认：请先在页面上方查回、按原内容重新提交或作废');
    const clientKey = uuid();
    setBusy('apply');
    setError(null);
    try {
      const r = await sendErpOp<{ import: ErpImportRecord; replayed: boolean }>({
        key: clientKey,
        type: 'erp_import',
        url: '/api/payables/imports',
        body: { ...body(), clientKey },
        summary: `${ERP_IMPORT_LABELS[kind]} · ${file.fileName}${preview ? ` · ${preview.rowCount} 行` : ''}`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      toast({ tone: 'success', title: r.replayed ? '这个文件之前已经导入过' : `已导入 ${r.import.rowCount} 行${ERP_IMPORT_LABELS[r.import.kind]}`, body: r.import.fileName });
      reset();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '导入结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，不要改了文件再导入。' });
        reset();
      } else if (e instanceof ErpPendingStoreError) setError(`${e.message} 文件较大时也可以拆成几份分批导入。`);
      else setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const t = TEMPLATES[kind];
  const sampleColumns = preview?.sample[0] ? Object.keys(preview.sample[0]) : [];
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/payables" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回货款">
              <ArrowLeft className="size-[18px]" />
            </Link>
            批量导入
          </span>
        }
        subtitle="供应商、期初未付：先预览，有问题的整份不写入；同一个文件只能写入一次。真实数据在门店环境导入前须店主同意"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] space-y-4 px-5 py-5 md:px-7">
          <ErpPendingPanel types={['erp_import']} className="space-y-2" onFound={() => void invalidate()} />
          {kinds.length === 0 ? (
            <Notice tone="info" title="导入由采购（供应商）与对账付款（期初未付）登记">
              导入的期初未付超过免确认门槛时，在下面的导入记录里一次确认整批。
            </Notice>
          ) : (
          <section className="space-y-3 rounded-lg border border-line bg-card p-5 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented<ErpImportKind>
                size="sm"
                value={kind}
                onChange={(k) => {
                  setKind(k);
                  reset();
                }}
                ariaLabel="导入什么"
                options={kinds.map((k) => ({ value: k, label: ERP_IMPORT_LABELS[k], disabled: busy !== null }))}
              />
              <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={() => downloadTemplate(kind)}>
                下载模板
              </Button>
            </div>
            <p className="text-[12.5px] text-ink-3">
              列：{t.columns.join('、')}。{t.hint}
            </p>
            <label className="flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-dashed border-line-strong px-4 py-3 text-[13px] hover:border-ink-3">
              <FileUp className="size-5 text-ink-3" />
              <span className="font-semibold">{file ? `${file.fileName}（${file.encoding}）` : '选择 CSV 或 Excel 文件'}</span>
              <input
                type="file"
                accept=".csv,.xlsx,text/csv"
                className="sr-only"
                aria-label="选择导入文件"
                disabled={busy === 'preview' || busy === 'apply'}
                onChange={(e) => void choose(e.target.files?.[0])}
                data-testid="import-file"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={!file} loading={busy === 'preview'} icon={<FileSearch className="size-4" />} onClick={runPreview}>
                预览
              </Button>
              <Button
                variant="primary"
                disabled={!preview || preview.issues.length > 0 || !!preview.duplicateOf || pending.length > 0}
                loading={busy === 'apply'}
                icon={<CircleCheck className="size-4" />}
                onClick={apply}
                data-testid="import-apply"
              >
                写入
              </Button>
            </div>
            {pending.length > 0 && <Notice tone="warning" title="上一次导入结果待确认：请先在页面上方处理，再写入新的一份" />}
            {error && <Notice tone="error" title={error} />}
          </section>
          )}

          {preview && (
            <section className="space-y-3" data-testid="import-preview">
              <div className="flex flex-wrap items-center gap-3 text-[13px]">
                <span className="font-bold">共 {preview.rowCount} 行</span>
                {preview.kind === 'opening_payables' && (
                  <span>
                    合计 <Money cents={preview.totalCents} className="font-bold" />
                  </span>
                )}
                {preview.issues.length === 0 ? <Badge tone="pine">全部可以导入</Badge> : <Badge tone="clay">{preview.issues.length} 行要先改好</Badge>}
              </div>
              {preview.duplicateOf && (
                <Notice tone="warning" title={`这个文件已经在 ${formatDateTime(preview.duplicateOf.createdAt)} 由 ${preview.duplicateOf.createdByName} 导入过`}>
                  同一个文件只能写入一次。
                </Notice>
              )}
              {preview.issues.length > 0 && (
                <ul className="divide-y divide-line/70 rounded-lg border border-clay/40 bg-clay-soft/30 text-[13px]">
                  {preview.issues.map((i) => (
                    <li key={`${i.row}${i.message}`} className="px-4 py-2">
                      <span className="num font-bold">第 {i.row} 行</span>
                      <span className="ml-2">{i.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              {preview.sample.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-card">
                  <table className="w-full min-w-[640px] text-left text-[13px]">
                    <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                      <tr>
                        {sampleColumns.map((c) => (
                          <th key={c} className="px-3 py-2">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/70">
                      {preview.sample.map((r, i) => (
                        <tr key={i}>
                          {sampleColumns.map((c) => (
                            <td key={c} className="px-3 py-1.5">
                              {r[c]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.rowCount > preview.sample.length && <p className="px-3 py-2 text-[12px] text-ink-3">只显示前 {preview.sample.length} 行。</p>}
                </div>
              )}
            </section>
          )}

          <section>
            <h2 className="mb-2 text-[13px] font-bold text-ink-2">导入记录</h2>
            {history.isPending ? (
              <Skeleton className="h-24" />
            ) : !history.data?.length ? (
              <EmptyState art="calm" title="还没有导入过" className="rounded-lg border border-dashed border-line-strong py-6" />
            ) : (
              <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card shadow-card">
                {history.data.map((h) => (
                  <ImportRow key={h.id} h={h} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function ImportRow({ h }: { h: ErpImportRecord }) {
  const can = useCan();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [busy, setBusy] = useState(false);
  const approveAll = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ approved: number }>(`/api/payables/imports/${h.id}/approve-openings`, {});
      await invalidate();
      toast({ tone: 'success', title: r.approved ? `已确认 ${r.approved} 笔期初未付` : '这一批没有待确认的期初未付' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]')}>
      <Badge tone={h.kind === 'suppliers' ? 'lake' : 'ember'}>{ERP_IMPORT_LABELS[h.kind]}</Badge>
      <span className="font-semibold">{h.fileName}</span>
      <span className="text-ink-3">
        {h.rowCount} 行{h.kind === 'opening_payables' && ` · 合计 ¥${formatAmount(h.totalCents)}`} · {h.createdByName} · {formatDateTime(h.createdAt)}
      </span>
      <span className="flex-1" />
      {h.kind === 'opening_payables' && can('inventory.approve') && (
        <Button size="sm" variant="secondary" loading={busy} onClick={approveAll}>
          确认这一批待确认的
        </Button>
      )}
    </li>
  );
}
