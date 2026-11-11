// 部门提需求的表格导入（供应链二次整改 02，docs/ERP_ROUND2.md 第 3 节）：「提需求」页的「导入表格」。
// 下载模板（需求表带下拉与提示、填写说明、选项）→ 选 Excel 或 CSV → 预览（逐行核对，有问题的行标红、写明哪一列为什么）→ 导入；
// 导入出来的需求单都是「待审核」，与手填的一样审核、截单。同一份文件再导入要勾「确认再导入一次」。
// 导入带操作编号（业务类型与手填的需求单一样）：结果不明时记在本机，页面上方查回、按原内容重新提交或作废（AGENTS.md）。

import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { ArrowLeft, CircleCheck, Download, FileSearch, FileUp } from 'lucide-react';
import { formatAmount } from '@shared/money';
import { formatQty } from '@shared/quantity';
import { DEPT_SHEET_LINES_PER_REQUEST, DEPT_SHEET_MAX_ROWS, DEPT_SHEET_REQUIRED, PRIORITY_LABELS, type DeptSheetPreview, type DeptSheetResult } from '@shared/requests';
import { ApiError, api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpPending } from '../../lib/erpPending';
import { bytesToBase64, readImportFile } from '../../lib/import-file';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Button, ConfirmCheck, Notice } from '../../components/ui';
import { PriorityDot } from './parts';
import { useInvalidateRequests } from './queries';

type Loaded = { fileName: string; csv?: string; xlsxBase64?: string; encoding: string };

export function RequestSheetImportPage() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateRequests();
  const pending = useErpPending(['purchase_request']);
  const [file, setFile] = useState<Loaded | null>(null);
  const [preview, setPreview] = useState<DeptSheetPreview | null>(null);
  const [repeat, setRepeat] = useState(false);
  const [result, setResult] = useState<DeptSheetResult | null>(null);
  const selection = useRef(0);
  const [busy, setBusy] = useState<'read' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!can('request.create')) return <Navigate to="/erp/requests" replace />;

  const reset = () => {
    selection.current += 1;
    setFile(null);
    setPreview(null);
    setRepeat(false);
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
      const r = await api.post<DeptSheetPreview>('/api/erp/requests/sheet/preview', body());
      if (selection.current === ticket) {
        setPreview(r);
        setRepeat(false);
      }
    } catch (e) {
      if (selection.current === ticket) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!file || !preview) return;
    if (pending.length > 0) return setError('上一张需求单（或上一次导入）结果待确认：请先在页面上方查回、按原内容重新提交或作废');
    const clientKey = uuid();
    setBusy('apply');
    setError(null);
    try {
      const r = await sendErpOp<DeptSheetResult>({
        key: clientKey,
        type: 'purchase_request',
        url: '/api/erp/requests/sheet/import',
        body: { ...body(), clientKey, confirmRepeat: repeat },
        summary: `表格导入 · ${file.fileName} · ${preview.rows.length} 行`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      setResult(r);
      toast({ tone: 'success', title: r.replayed ? '这次导入之前已经办好了' : `已导入 ${r.import.rowCount} 行，合成 ${r.import.requestCount} 张需求单`, body: '都是待审核，等采购审核' });
      reset();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '导入结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，不要改了文件再导入。' });
        reset();
      } else if (e instanceof ErpPendingStoreError) setError(`${e.message} 文件较大时也可以拆成几份分批导入。`);
      else if (e instanceof ApiError && e.code === 'IMPORT_REPEAT') {
        // 预览以后别人刚导入过同一份文件：重新预览，显示是谁什么时候导入的
        setError(e.message);
        void runPreview();
      } else setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const blocked = !preview || preview.issueCount > 0 || (!!preview.previous && !repeat) || pending.length > 0;
  const lineCount = preview ? preview.rows.length : 0;
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/erp/requests/new" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回提需求">
              <ArrowLeft className="size-[18px]" />
            </Link>
            导入表格
          </span>
        }
        subtitle="按模板一次填好多行需求，导入后都是待审核的需求单（与手填的一样审核、截单）"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-5 py-5 md:px-7" data-testid="request-sheet">
          <ErpPendingPanel types={['purchase_request']} className="space-y-2" onFound={(_, ref) => navigate(`/erp/requests?request=${ref.refId}`)} />
          <section className="space-y-3 rounded-lg border border-line bg-card p-5 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
              <a href="/api/erp/requests/sheet/template" download data-testid="request-sheet-template">
                <Button size="sm" variant="secondary" icon={<Download className="size-4" />}>
                  下载模板（部门需求表）
                </Button>
              </a>
              <span className="text-[12.5px] text-ink-3">
                模板里有填写说明和下拉（部门、物品、用途、优先级）；{DEPT_SHEET_REQUIRED.join('、')}必填。只收物料档案里已有的物品——新产品要带参考链接和图片，请在「提需求」页面上填。
                一份最多 {DEPT_SHEET_MAX_ROWS} 行，按部门 + 优先级 + 期望到货日期合成需求单，一张最多 {DEPT_SHEET_LINES_PER_REQUEST} 行。
              </span>
            </div>
            <label className="flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-dashed border-line-strong px-4 py-3 text-[13px] hover:border-ink-3">
              <FileUp className="size-5 text-ink-3" />
              <span className="font-semibold">{file ? `${file.fileName}（${file.encoding}）` : '选择 Excel 或 CSV 文件'}</span>
              <input
                type="file"
                accept=".xlsx,.csv,text/csv"
                className="sr-only"
                aria-label="选择需求表"
                disabled={busy === 'preview' || busy === 'apply'}
                onChange={(e) => void choose(e.target.files?.[0])}
                data-testid="request-sheet-file"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" icon={<FileSearch className="size-4" />} disabled={!file || busy !== null} loading={busy === 'preview'} onClick={() => void runPreview()} data-testid="request-sheet-preview">
                预览
              </Button>
              <Button variant="primary" icon={<CircleCheck className="size-4" />} disabled={blocked || busy !== null} loading={busy === 'apply'} onClick={() => void apply()} data-testid="request-sheet-apply">
                {preview && preview.issueCount === 0 ? `导入（合成 ${preview.groups.length} 张需求单）` : '导入'}
              </Button>
            </div>
            {error && <Notice tone="error" title={error} />}
          </section>

          {preview && (
            <section className="space-y-3 rounded-lg border border-line bg-card p-5 shadow-card" data-testid="request-sheet-preview-result">
              {preview.issueCount > 0 ? (
                <Notice tone="error" title={`有 ${preview.issueCount} 行要先改好`}>
                  标红的行在最后一列写着哪一列、为什么；有一行有问题整份都不导入。在 Excel 里改好后重新选择文件、再预览。
                </Notice>
              ) : (
                <Notice tone="success" title={`${lineCount} 行都能导入，合成 ${preview.groups.length} 张需求单`}>
                  {preview.groups.map((g, i) => (
                    <span key={i} className="mr-3 inline-flex items-center gap-1.5">
                      <PriorityDot priority={g.priority} />
                      {g.department} · {PRIORITY_LABELS[g.priority]}
                      {g.needBy ? ` · 期望 ${g.needBy} 到货` : ''} · {g.lines} 行
                    </span>
                  ))}
                </Notice>
              )}
              {preview.previous && (
                <div className="space-y-2" data-testid="request-sheet-previous">
                  <Notice tone="warning" title={`这份文件 ${formatDateTime(preview.previous.createdAt)} ${preview.previous.createdByName} 导入过`}>
                    上次合成了 {preview.previous.requestCount} 张需求单。每周补货用同一份表的可以再导入一次；不是的话请检查是不是选错了文件。
                  </Notice>
                  {preview.issueCount === 0 && (
                    <ConfirmCheck checked={repeat} onChange={setRepeat} tone="clay">
                      <span data-testid="request-sheet-repeat">确认再导入一次</span>
                    </ConfirmCheck>
                  )}
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[12px] font-semibold whitespace-nowrap text-ink-3">
                      <th className="py-2 pr-2">行</th>
                      <th className="pr-2">部门</th>
                      <th className="pr-2">物品</th>
                      <th className="pr-2">用途</th>
                      <th className="pr-2 text-right">数量</th>
                      <th className="pr-2">优先级</th>
                      <th className="pr-2">期望到货</th>
                      <th className="pr-2 text-right">参考单价</th>
                      <th className="w-[36%]">问题</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.row} className={cn('border-b border-line/60 align-top', r.issues.length > 0 && 'bg-clay-soft/40')} data-testid={`request-sheet-row-${r.row}`}>
                        <td className="num py-2 pr-2 text-ink-3">{r.row}</td>
                        <td className="pr-2 whitespace-nowrap">{r.department?.name ?? (r.departmentText || '—')}</td>
                        <td className="pr-2">
                          {r.material ? r.material.name : r.name || '—'}
                          {r.material && <span className="num ml-1 text-[12px] text-ink-3">{r.material.code}</span>}
                        </td>
                        <td className="pr-2 whitespace-nowrap">{r.purpose || '—'}</td>
                        <td className="num pr-2 text-right whitespace-nowrap">
                          {r.qtyMilli !== null ? formatQty(r.qtyMilli) : '—'} {r.unit}
                        </td>
                        <td className="pr-2 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            <PriorityDot priority={r.priority} />
                            {PRIORITY_LABELS[r.priority]}
                          </span>
                        </td>
                        <td className="num pr-2 whitespace-nowrap">{r.needBy ?? '—'}</td>
                        <td className="num pr-2 text-right whitespace-nowrap">{r.refPriceCents !== null ? `¥${formatAmount(r.refPriceCents)}` : '—'}</td>
                        <td className="text-[12.5px] font-semibold text-clay">{r.issues.join('；')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {result && (
            <section className="space-y-2 rounded-lg border border-pine/30 bg-pine-tint/40 p-5" data-testid="request-sheet-done">
              <p className="text-[14px] font-bold">
                已导入 {result.import.rowCount} 行，合成 {result.import.requestCount} 张需求单（待审核）
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
              <Link to="/erp/requests" className="text-[13px] font-bold text-lake hover:underline">
                回采购需求单
              </Link>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
