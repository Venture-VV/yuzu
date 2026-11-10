// 集采导入（8.0.1 采购组整改 06，CG06，docs/PURCHASING_V801.md）：「采购 → 集采导入」。
// 下载标准模板（列与采购组的「集采需求表」一样）→ 选 Excel 或 CSV → 预览（逐行核对）→ 导入；
// 导入出来的需求单按「部门 + 优先级 + 期望到货日期」合成、直接已通过，进「待转采购单」；同一份文件只能导入一次。
// 导入带操作编号：结果不明时记在本机，页面上方查回、按原内容重新提交或作废（AGENTS.md）。

import { useRef, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { ArrowLeft, CircleCheck, Download, FileSearch, FileUp } from 'lucide-react';
import { formatQty } from '@shared/quantity';
import { channelLabel } from '@shared/purchasing';
import { PRIORITY_LABELS, REQUEST_IMPORT_COLUMNS, REQUEST_IMPORT_REQUIRED, type RequestImportPreview, type RequestImportResult } from '@shared/requests';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpPending } from '../../lib/erpPending';
import { bytesToBase64, readImportFile } from '../../lib/import-file';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Badge, Button, Notice } from '../../components/ui';
import { PriorityDot } from '../requests/parts';
import { useInvalidateRequests } from '../requests/queries';

type Loaded = { fileName: string; csv?: string; xlsxBase64?: string; encoding: string };

export function RequestImportPage() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateRequests();
  const pending = useErpPending(['request_import']);
  const [file, setFile] = useState<Loaded | null>(null);
  const [preview, setPreview] = useState<RequestImportPreview | null>(null);
  const [result, setResult] = useState<RequestImportResult | null>(null);
  const selection = useRef(0);
  const [busy, setBusy] = useState<'read' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!can('request.review')) return <Navigate to="/purchasing" replace />;

  const reset = () => {
    selection.current += 1;
    setFile(null);
    setPreview(null);
    setError(null);
  };
  const body = () => ({ fileName: file!.fileName, csv: file!.csv, xlsxBase64: file!.xlsxBase64 });

  const choose = async (f: File | undefined) => {
    reset();
    setResult(null);
    if (!f) return;
    const ticket = selection.current;
    const current = () => selection.current === ticket;
    setBusy('read');
    try {
      if (/\.xlsx$/i.test(f.name)) {
        const xlsxBase64 = bytesToBase64(await f.arrayBuffer());
        if (current()) setFile({ fileName: f.name, xlsxBase64, encoding: 'Excel' });
      } else if (/\.csv$/i.test(f.name) || f.type === 'text/csv') {
        const loaded = await readImportFile(f);
        if (current()) setFile({ fileName: f.name, csv: loaded.text, encoding: loaded.label.includes('GBK') ? 'GBK' : 'UTF-8' });
      } else setError('只能导入 Excel（.xlsx）或 CSV（.csv）文件；老版本的 .xls 请另存为 .xlsx');
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
      const r = await api.post<RequestImportPreview>('/api/erp/requests/import/preview', body());
      if (selection.current === ticket) setPreview(r);
    } catch (e) {
      if (selection.current === ticket) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!file) return;
    if (pending.length > 0) return setError('上一次导入结果待确认：请先在页面上方查回、按原内容重新提交或作废');
    const clientKey = uuid();
    setBusy('apply');
    setError(null);
    try {
      const r = await sendErpOp<RequestImportResult>({
        key: clientKey,
        type: 'request_import',
        url: '/api/erp/requests/import',
        body: { ...body(), clientKey },
        summary: `集采导入 · ${file.fileName}${preview ? ` · ${preview.rows.length} 行` : ''}`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      setResult(r);
      toast({ tone: 'success', title: r.replayed ? '这次导入之前已经办好了' : `已导入 ${r.import.rowCount} 行，合成 ${r.import.requestCount} 张需求单`, body: r.import.fileName });
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

  const blocked = !preview || preview.issueCount > 0 || !!preview.duplicate || pending.length > 0;
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/purchasing" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回采购">
              <ArrowLeft className="size-[18px]" />
            </Link>
            集采导入
          </span>
        }
        subtitle="用标准模板整理好各部门的需求，一次导成「已通过」的需求单，进待转采购单；同一份文件只能导入一次"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-5 py-5 md:px-7" data-testid="request-import">
          <ErpPendingPanel types={['request_import']} className="space-y-2" onFound={() => void invalidate()} />
          <section className="space-y-3 rounded-lg border border-line bg-card p-5 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
              <a href="/api/erp/requests/import/template" download data-testid="request-import-template">
                <Button size="sm" variant="secondary" icon={<Download className="size-4" />}>
                  下载模板（集采需求表）
                </Button>
              </a>
              <span className="text-[12.5px] text-ink-3">
                列：{REQUEST_IMPORT_COLUMNS.join('、')}。{REQUEST_IMPORT_REQUIRED.join('、')}必填；优先级写「紧急」或「普通」（空着按普通）；
                采购途径写网购、自采（现采/零采）或供应商；部门、供应商要与档案里的名称一样；物品名称与物料档案一样的自动带上物料。
              </span>
            </div>
            <label className="flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-dashed border-line-strong px-4 py-3 text-[13px] hover:border-ink-3">
              <FileUp className="size-5 text-ink-3" />
              <span className="font-semibold">{file ? `${file.fileName}（${file.encoding}）` : '选择 Excel 或 CSV 文件'}</span>
              <input
                type="file"
                accept=".xlsx,.csv,text/csv"
                className="sr-only"
                aria-label="选择集采文件"
                disabled={busy === 'preview' || busy === 'apply'}
                onChange={(e) => void choose(e.target.files?.[0])}
                data-testid="request-import-file"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" icon={<FileSearch className="size-4" />} disabled={!file || busy !== null} loading={busy === 'preview'} onClick={() => void runPreview()} data-testid="request-import-preview">
                预览
              </Button>
              <Button variant="primary" icon={<CircleCheck className="size-4" />} disabled={blocked || busy !== null} loading={busy === 'apply'} onClick={() => void apply()} data-testid="request-import-apply">
                {preview && !blocked ? `导入（合成 ${preview.groups.length} 张需求单）` : '导入'}
              </Button>
            </div>
            {error && <Notice tone="error" title={error} />}
          </section>

          {preview && (
            <section className="space-y-3 rounded-lg border border-line bg-card p-5 shadow-card" data-testid="request-import-preview-result">
              {preview.duplicate ? (
                <Notice tone="warning" title="这份文件已经导入过了">同一份文件只能导入一次；要补导请另做一份只含新需求的文件。</Notice>
              ) : preview.issueCount > 0 ? (
                <Notice tone="error" title={`有 ${preview.issueCount} 行要先改好才能导入`}>在 Excel 里改好后重新选择文件、再预览。</Notice>
              ) : (
                <Notice tone="success" title={`${preview.rows.length} 行都能导入，合成 ${preview.groups.length} 张需求单`}>
                  {preview.groups.map((g, i) => (
                    <span key={i} className="mr-3 inline-flex items-center gap-1.5">
                      <PriorityDot priority={g.priority} />
                      {g.department} · {PRIORITY_LABELS[g.priority]}
                      {g.needBy ? ` · 期望 ${g.needBy} 到货` : ''} · {g.lines} 行
                    </span>
                  ))}
                </Notice>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[12px] font-semibold text-ink-3">
                      <th className="py-2 pr-2">行</th>
                      <th className="pr-2">部门</th>
                      <th className="pr-2">申请人</th>
                      <th className="pr-2">物品</th>
                      <th className="pr-2 text-right">数量</th>
                      <th className="pr-2">优先级</th>
                      <th className="pr-2">期望到货</th>
                      <th className="pr-2">途径 · 供应商</th>
                      <th>问题</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.row} className={cn('border-b border-line/60 align-top', r.issues.length > 0 && 'bg-clay-soft/40')} data-testid={`request-import-row-${r.row}`}>
                        <td className="num py-2 pr-2 text-ink-3">{r.row}</td>
                        <td className="pr-2">{r.department?.name ?? r.departmentText}</td>
                        <td className="pr-2">{r.applicant || '—'}</td>
                        <td className="pr-2">
                          {r.name}
                          {r.material ? <span className="ml-1 text-[12px] text-ink-3">物料</span> : r.name && <Badge tone="yuzu" className="ml-1">新产品</Badge>}
                        </td>
                        <td className="num pr-2 text-right">
                          {r.qtyMilli !== null ? formatQty(r.qtyMilli) : '—'} {r.unit}
                        </td>
                        <td className="pr-2">
                          <span className="inline-flex items-center gap-1">
                            <PriorityDot priority={r.priority} />
                            {PRIORITY_LABELS[r.priority]}
                          </span>
                        </td>
                        <td className="num pr-2">{r.needBy ?? '—'}</td>
                        <td className="pr-2">
                          {r.channel ? channelLabel(r.channel) : '—'}
                          {r.supplier && ` · ${r.supplier.name}`}
                        </td>
                        <td className="text-[12.5px] font-semibold text-clay">{r.issues.join('；')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {result && (
            <section className="space-y-2 rounded-lg border border-pine/30 bg-pine-tint/40 p-5" data-testid="request-import-done">
              <p className="text-[14px] font-bold">
                已导入 {result.import.rowCount} 行，合成 {result.import.requestCount} 张需求单（已通过）
              </p>
              <ul className="flex flex-wrap gap-2">
                {result.requests.map((r) => (
                  <li key={r.id}>
                    <Link to={`/erp/requests?request=${r.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-1 text-[13px] font-semibold hover:border-line-strong">
                      <PriorityDot priority={r.priority} />
                      <span className="num">{r.docNo}</span> · {r.department} · {r.lineCount} 行
                    </Link>
                  </li>
                ))}
              </ul>
              <Link to="/erp/requests?view=open" className="text-[13px] font-bold text-lake hover:underline">
                去待转采购单
              </Link>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
