// 集采导入（8.0.1 采购组整改 06，CG06，docs/PURCHASING_V801.md）：「采购 → 集采导入」。
// 供应链二次整改 01（docs/ERP_ROUND2.md 第 4 节）：模板就是采购组的最终版「品牌新增寻款采购清单」，按它填的表原样导入；
// 最终版没有「申请部门」——页面上选这份清单记在哪个部门；是否下单 / 到货 / 退货标了「是」的默认不导入（可以勾「线下已下单的也导入」）。
// 下载模板 → 选部门 → 选 Excel 或 CSV → 预览（逐行核对）→ 导入；
// 导入出来的需求单按「部门 + 优先级 + 期望到货日期」合成、直接已通过，进「待转采购单」；同一份文件只能导入一次。
// 导入带操作编号：结果不明时记在本机，页面上方查回、按原内容重新提交或作废（AGENTS.md）。

import { PurchasingTabs } from './PurchasingTabs';
import { useRef, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { ArrowLeft, CircleCheck, Download, FileSearch, FileUp } from 'lucide-react';
import { formatQty } from '@shared/quantity';
import { channelLabel } from '@shared/purchasing';
import { PRIORITY_LABELS, REQUEST_IMPORT_REQUIRED, REQUEST_IMPORT_TITLE, type RequestImportPreview, type RequestImportResult } from '@shared/requests';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpPending } from '../../lib/erpPending';
import { bytesToBase64, readImportFile } from '../../lib/import-file';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Badge, Button, ConfirmCheck, Field, Notice, Select } from '../../components/ui';
import { PriorityDot } from '../requests/parts';
import { useInvalidateRequests, useRequestMeta } from '../requests/queries';

type Loaded = { fileName: string; csv?: string; xlsxBase64?: string; encoding: string };

export function RequestImportPage() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateRequests();
  const pending = useErpPending(['request_import']);
  const meta = useRequestMeta();
  // 这份清单记在哪个部门（最终版没有「申请部门」列；表里有这一列的按表里的）
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  // 线下已下单 / 到货 / 退货的也导入（默认不导入，免得进待转采购单再下一次单）
  const [includeOffline, setIncludeOffline] = useState(false);
  const [file, setFile] = useState<Loaded | null>(null);
  const [preview, setPreview] = useState<RequestImportPreview | null>(null);
  const [result, setResult] = useState<RequestImportResult | null>(null);
  const selection = useRef(0);
  const previewRun = useRef(0);
  const [busy, setBusy] = useState<'read' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!can('request.review')) return <Navigate to="/purchasing" replace />;

  const reset = () => {
    selection.current += 1;
    setFile(null);
    setPreview(null);
    setError(null);
  };
  const body = () => ({ fileName: file!.fileName, csv: file!.csv, xlsxBase64: file!.xlsxBase64, departmentId, includeOffline });

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

  const runPreview = async (over: { departmentId?: number | null; includeOffline?: boolean } = {}) => {
    if (!file) return;
    const ticket = selection.current;
    // 换部门、勾选时会再预览：只认最后一次
    const run = ++previewRun.current;
    const latest = () => selection.current === ticket && previewRun.current === run;
    setBusy('preview');
    setError(null);
    try {
      const r = await api.post<RequestImportPreview>('/api/erp/requests/import/preview', { ...body(), ...over });
      if (latest()) setPreview(r);
    } catch (e) {
      if (latest()) setError(errorMessage(e));
    } finally {
      if (previewRun.current === run) setBusy(null);
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
        summary: `集采导入 · ${file.fileName}${preview ? ` · ${preview.rows.length - preview.skippedCount} 行` : ''}`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      setResult(r);
      toast({
        tone: 'success',
        title: r.replayed ? '这次导入之前已经办好了' : `已导入 ${r.import.rowCount} 行，合成 ${r.import.requestCount} 张需求单`,
        body: r.import.skippedCount ? `${r.import.fileName} · 线下已下单的 ${r.import.skippedCount} 行没导入` : r.import.fileName,
      });
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

  const importing = preview ? preview.rows.length - preview.skippedCount : 0;
  const blocked = !preview || preview.issueCount > 0 || !!preview.duplicate || importing === 0 || pending.length > 0;
  // 换了部门或勾选：已经预览过的按新的条件再预览一次
  const changeDept = (id: number | null) => {
    setDepartmentId(id);
    if (preview) void runPreview({ departmentId: id });
  };
  const changeOffline = (v: boolean) => {
    setIncludeOffline(v);
    if (preview) void runPreview({ includeOffline: v });
  };
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
        subtitle={`用采购组的「${REQUEST_IMPORT_TITLE}」整理好需求，一次导成「已通过」的需求单，进待转采购单；同一份文件只能导入一次`}
      />
      <PurchasingTabs active="import" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-5 py-5 md:px-7" data-testid="request-import">
          <ErpPendingPanel types={['request_import']} className="space-y-2" onFound={() => void invalidate()} />
          <section className="space-y-3 rounded-lg border border-line bg-card p-5 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
              <a href="/api/erp/requests/import/template" download data-testid="request-import-template">
                <Button size="sm" variant="secondary" icon={<Download className="size-4" />}>
                  下载模板（{REQUEST_IMPORT_TITLE}）
                </Button>
              </a>
              <span className="text-[12.5px] text-ink-3">
                就是采购组的最终版收集表，表头名字与顺序不要改；{REQUEST_IMPORT_REQUIRED.join('、')}必填，数量可以带单位（如「19个」，不带的按「个」）；
                参考链接渠道贴商品链接或写渠道（网购、自采、供应商）；产品名称与物料档案一样的自动带上物料。表里贴的图片不导入。8.0.1 的旧模板照样能导。
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,320px)_1fr] md:items-end">
              <Field label="这份清单记在哪个部门" htmlFor="request-import-dept" hint="表里有「申请部门」列的按表里的">
                <Select id="request-import-dept" value={departmentId ?? ''} disabled={busy === 'apply'} onChange={(e) => changeDept(Number(e.target.value) || null)} data-testid="request-import-dept">
                  <option value="">请选择部门</option>
                  {(meta.data?.departments ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <ConfirmCheck checked={includeOffline} onChange={changeOffline}>
                <span data-testid="request-import-offline">线下已下单的也导入（是否下单 / 到货 / 退货标了「是」的行，默认不导入）</span>
              </ConfirmCheck>
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
                <Notice tone="error" title={`有 ${preview.issueCount} 行要先改好才能导入`}>在 Excel 里改好（或在上面选好部门）后重新预览。</Notice>
              ) : importing === 0 ? (
                <Notice tone="warning" title="没有要导入的行">表里的行都标了线下已下单、到货或退货；要导入请勾「线下已下单的也导入」。</Notice>
              ) : (
                <Notice tone="success" title={`${importing} 行都能导入，合成 ${preview.groups.length} 张需求单${preview.skippedCount ? `（线下已下单的 ${preview.skippedCount} 行不导入）` : ''}`}>
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
                      <th className="pr-2">产品</th>
                      <th className="pr-2">用途</th>
                      <th className="pr-2 text-right">数量</th>
                      <th className="pr-2">优先级</th>
                      <th className="pr-2">期望到货</th>
                      <th className="pr-2">链接 · 途径</th>
                      <th>问题</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr
                        key={r.row}
                        className={cn('border-b border-line/60 align-top', r.skipped ? 'text-ink-4' : r.issues.length > 0 && 'bg-clay-soft/40')}
                        data-testid={`request-import-row-${r.row}`}
                        data-skipped={r.skipped || undefined}
                      >
                        <td className="num py-2 pr-2 text-ink-3">{r.row}</td>
                        <td className="pr-2">{r.department?.name ?? (r.departmentText || '—')}</td>
                        <td className="pr-2">
                          {r.name}
                          {r.material ? <span className="ml-1 text-[12px] text-ink-3">物料</span> : r.name && <Badge tone="yuzu" className="ml-1">新产品</Badge>}
                          {r.skipped && <Badge className="ml-1">不导入 · 线下{r.offline.map((c) => c.replace('是否', '已')).join('、')}</Badge>}
                          {r.applicant && <span className="block text-[12px] text-ink-3">申请人 {r.applicant}</span>}
                          {r.details && <span className="block text-[12px] text-ink-3">{r.details}</span>}
                        </td>
                        <td className="pr-2">{r.purpose}</td>
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
                        <td className="max-w-[220px] pr-2">
                          {r.link ? (
                            <a href={r.link} target="_blank" rel="noreferrer" className="block truncate text-lake hover:underline" title={r.link}>
                              {r.link.replace(/^https?:\/\//, '')}
                            </a>
                          ) : null}
                          {r.channel ? channelLabel(r.channel) : !r.link && '—'}
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
                {result.import.skippedCount > 0 && `；线下已下单的 ${result.import.skippedCount} 行没导入`}
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
