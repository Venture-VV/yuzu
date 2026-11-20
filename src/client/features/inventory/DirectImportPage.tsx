// 库管入库台账的一键导入（8.1.9，docs/ERP_V819.md 第 3.2 节，KR4、KR5）：库存页「导入入库台账」。
// 下载模板（入库台账带下拉与提示、填写说明、选项）→ 选 Excel 或 CSV → 预览（逐行核对，有问题的行标红、写明哪一列为什么）→ 导入：
// 按「入库日期 + 供应商 + 单据分组」合成库管入库单、一次确认入库（与手填的「确认入库」一样）。同一份文件只能导入一次。
// 导入带操作编号（业务类型 receipt_import）：结果不明时记在本机，页面上方查回、按原内容重新提交或作废（AGENTS.md）。

import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { ArrowLeft, CircleCheck, Download, FileSearch, FileUp } from 'lucide-react';
import { RECEIPT_IMPORT_LINES_PER_DOC, RECEIPT_IMPORT_MAX_ROWS, RECEIPT_IMPORT_REQUIRED, type ReceiptImportPreview, type ReceiptImportResult } from '@shared/direct-receipts';
import { formatAmount } from '@shared/money';
import { formatQty } from '@shared/quantity';
import { ApiError, api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpPending } from '../../lib/erpPending';
import { loadTableFile, type LoadedTable } from '../../lib/import-file';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Button, Notice } from '../../components/ui';
import { useInvalidateInventory, useInvSettings } from './queries';

export function DirectImportPage() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateInventory();
  const settings = useInvSettings(can('inventory.operate'));
  const pending = useErpPending(['receipt_import']);
  const [file, setFile] = useState<LoadedTable | null>(null);
  const [preview, setPreview] = useState<ReceiptImportPreview | null>(null);
  const [result, setResult] = useState<ReceiptImportResult | null>(null);
  const selection = useRef(0);
  const [busy, setBusy] = useState<'read' | 'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!can('inventory.operate')) return <Navigate to="/inventory" replace />;

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
      const loaded = await loadTableFile(f);
      if (current()) setFile(loaded);
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
      const r = await api.post<ReceiptImportPreview>('/api/inventory/direct-receipts/import/preview', body());
      if (selection.current === ticket) setPreview(r);
    } catch (e) {
      if (selection.current === ticket) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!file || !preview) return;
    if (pending.length > 0) return setError('上一次导入结果待确认：请先在页面上方查回、按原内容重新提交或作废');
    const clientKey = uuid();
    setBusy('apply');
    setError(null);
    try {
      const r = await sendErpOp<ReceiptImportResult>({
        key: clientKey,
        type: 'receipt_import',
        url: '/api/inventory/direct-receipts/import',
        body: { ...body(), clientKey },
        summary: `库管入库台账导入 · ${file.fileName} · ${preview.rows.length} 行`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      setResult(r);
      toast({ tone: 'success', title: r.replayed ? '这次导入之前已经办好了' : `已导入 ${r.import.rowCount} 行，生成 ${r.import.docCount} 张库管入库`, body: '都已确认入库' });
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

  const off = settings.data?.directReceipt === false;
  const blocked = off || !preview || preview.issueCount > 0 || !!preview.previous || pending.length > 0;
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/inventory" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回库存">
              <ArrowLeft className="size-[18px]" />
            </Link>
            导入入库台账
          </span>
        }
        subtitle="按模板一次登记多张库管入库（不选采购单），导入即确认入库"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-4 py-5 md:px-7" data-testid="direct-import">
          <ErpPendingPanel types={['receipt_import']} className="space-y-2" onFound={() => void invalidate()} />
          {off && (
            <Notice tone="warning" title="库管入库已在库存设置里关掉">
              要用的话请店主在「ERP 设置 → 库存与审批开关」里打开。
            </Notice>
          )}
          <section className="space-y-3 rounded-lg border border-line bg-card p-5 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
              <a href="/api/inventory/direct-receipts/template" download data-testid="direct-import-template">
                <Button size="sm" variant="secondary" icon={<Download className="size-4" />}>
                  下载模板（库管入库台账）
                </Button>
              </a>
              <span className="min-w-0 flex-1 basis-64 text-[12.5px] text-ink-3">
                模板里有填写说明和下拉（供应商、物品）；{RECEIPT_IMPORT_REQUIRED.join('、')}必填，单价按每采购单位。一份最多 {RECEIPT_IMPORT_MAX_ROWS} 行，按入库日期 + 供应商 +
                单据分组合成库管入库单，一张最多 {RECEIPT_IMPORT_LINES_PER_DOC} 行。同一份文件只能导入一次。
              </span>
            </div>
            <label className="flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-dashed border-line-strong px-4 py-3 text-[13px] hover:border-ink-3">
              <FileUp className="size-5 text-ink-3" />
              <span className="min-w-0 font-semibold break-all">{file ? `${file.fileName}（${file.encoding}）` : '选择 Excel 或 CSV 文件'}</span>
              <input
                type="file"
                accept=".xlsx,.csv,text/csv"
                className="sr-only"
                aria-label="选择入库台账"
                disabled={busy === 'preview' || busy === 'apply'}
                onChange={(e) => void choose(e.target.files?.[0])}
                data-testid="direct-import-file"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                icon={<FileSearch className="size-4" />}
                disabled={!file || busy !== null}
                loading={busy === 'preview'}
                onClick={() => void runPreview()}
                data-testid="direct-import-preview"
              >
                预览
              </Button>
              <Button
                variant="primary"
                icon={<CircleCheck className="size-4" />}
                disabled={blocked || busy !== null}
                loading={busy === 'apply'}
                onClick={() => void apply()}
                data-testid="direct-import-apply"
              >
                {preview && preview.issueCount === 0 ? `导入并入库（${preview.groups.length} 张）` : '导入并入库'}
              </Button>
            </div>
            {error && <Notice tone="error" title={error} />}
          </section>

          {preview && (
            <section className="space-y-3 rounded-lg border border-line bg-card p-5 shadow-card" data-testid="direct-import-preview-result">
              {preview.previous ? (
                <Notice tone="error" title={`这份文件 ${formatDateTime(preview.previous.createdAt)} ${preview.previous.createdByName} 已经导入过`}>
                  上次生成了 {preview.previous.docCount} 张库管入库。同一份文件不能再导入（重复入库会多出库存）；有新的到货请另做一份台账。
                </Notice>
              ) : preview.issueCount > 0 ? (
                <Notice tone="error" title={`有 ${preview.issueCount} 行要先改好`}>
                  标红的行在最后一列写着哪一列、为什么；有一行有问题整份都不导入。在 Excel 里改好后重新选择文件、再预览。
                </Notice>
              ) : (
                <Notice tone="success" title={`${preview.rows.length} 行都能导入，生成 ${preview.groups.length} 张库管入库，合计 ¥${formatAmount(preview.amountCents)}`}>
                  {preview.groups.map((g, i) => (
                    <span key={i} className="mr-3 inline-block">
                      {g.docDate} · {g.supplierName}
                      {g.group ? ` · ${g.group}` : ''} · {g.lines} 行 · ¥{formatAmount(g.amountCents)}
                    </span>
                  ))}
                </Notice>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[12px] font-semibold whitespace-nowrap text-ink-3">
                      <th className="py-2 pr-2">行</th>
                      <th className="pr-2">入库日期</th>
                      <th className="pr-2">供应商</th>
                      <th className="pr-2">物品</th>
                      <th className="pr-2 text-right">送达 / 合格</th>
                      <th className="pr-2 text-right">单价</th>
                      <th className="pr-2 text-right">金额</th>
                      <th className="pr-2">分组</th>
                      <th className="w-[34%]">问题</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.row} className={cn('border-b border-line/60 align-top', r.issues.length > 0 && 'bg-clay-soft/40')} data-testid={`direct-import-row-${r.row}`}>
                        <td className="num py-2 pr-2 text-ink-3">{r.row}</td>
                        <td className="num pr-2 whitespace-nowrap">{r.docDate ?? '—'}</td>
                        <td className="pr-2 whitespace-nowrap">{r.supplier?.name ?? '—'}</td>
                        <td className="pr-2">
                          {r.material ? r.material.name : '—'}
                          {r.material && <span className="num ml-1 text-[12px] text-ink-3">{r.material.code}</span>}
                        </td>
                        <td className="num pr-2 text-right whitespace-nowrap">
                          {r.deliveredMilli !== null ? formatQty(r.deliveredMilli) : '—'} / {r.acceptedMilli !== null ? formatQty(r.acceptedMilli) : '—'} {r.material?.inventoryUnit ?? ''}
                        </td>
                        <td className="num pr-2 text-right whitespace-nowrap">
                          {r.priceCents !== null ? `¥${formatAmount(r.priceCents)}` : '—'}
                          {r.material && <span className="text-[12px] text-ink-3">/{r.material.purchaseUnit}</span>}
                        </td>
                        <td className="num pr-2 text-right whitespace-nowrap">{r.amountCents !== null ? `¥${formatAmount(r.amountCents)}` : '—'}</td>
                        <td className="pr-2 whitespace-nowrap">{r.group || '—'}</td>
                        <td className="text-[12.5px] font-semibold text-clay">{r.issues.join('；')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {result && (
            <section className="space-y-2 rounded-lg border border-pine/30 bg-pine-tint/40 p-5" data-testid="direct-import-done">
              <p className="text-[14px] font-bold">
                已导入 {result.import.rowCount} 行，生成 {result.import.docCount} 张库管入库（已确认入库），合计 ¥{formatAmount(result.import.amountCents)}
              </p>
              <ul className="flex flex-wrap gap-2">
                {result.docs.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/inventory/docs?doc=${d.id}`)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-1 text-[13px] font-semibold hover:border-line-strong"
                    >
                      <span className="num">{d.docNo}</span> · {d.supplierName} · {d.lineCount} 行 · ¥{formatAmount(d.amountCents)}
                    </button>
                  </li>
                ))}
              </ul>
              <Link to="/inventory/docs" className="text-[13px] font-bold text-lake hover:underline">
                去库存单据
              </Link>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
