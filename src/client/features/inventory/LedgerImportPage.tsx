// 出入库台账（8.1.20，docs/ERP_V8120.md，PENDING_DECISIONS「8.1.20」LD1–LD10）：「库管入库」页右上角的
// 「导入出入库台账」「导出台账」「下载模板」，以及导入页（/inventory/direct/import，代替 8.1.9 的「导入入库台账」）。
// 模板照门店的《仓库出入库记录》：一种物料一行，入库（日期、数量）、出库（日期、数量、领料人及部门）。
// 选 Excel 或 CSV → 预览（逐行核对，有问题的行标红、写明为什么；上期库存量、库存量对不上只提醒）→ 导入：入库生成库管入库、
// 出库生成部门领料，都马上生效。同一份文件只能导入一次；导出的台账只用来对账，不能再导入。
// 导入带操作编号（业务类型 ledger_import）：结果不明时记在本机，页面上方查回、按原内容重新提交或作废（AGENTS.md）；
// 8.1.9 旧模板的导入（receipt_import）结果待确认的也在这里查回。

import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { ArrowLeft, CircleCheck, Download, FileDown, FileSearch, FileUp } from 'lucide-react';
import { LEDGER_LINES_PER_DOC, LEDGER_MAX_ROWS, type LedgerImportPreview, type LedgerImportResult, type LedgerImportRow } from '@shared/ledger-import';
import { formatAmount } from '@shared/money';
import { formatQty } from '@shared/quantity';
import { ApiError, api, errorMessage, UncertainError } from '../../lib/api';
import { ErpPendingStoreError, sendErpOp, useErpPending } from '../../lib/erpPending';
import { loadTableFile, type LoadedTable } from '../../lib/import-file';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { DataTable } from '../../components/DataTable';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useToast } from '../../components/Toast';
import { Button, Notice } from '../../components/ui';
import { useInvalidateInventory, useInvSettings } from './queries';

import { LEDGER_TEMPLATE_URL as TEMPLATE_URL, ledgerExportUrl as exportUrl } from './LedgerActions';

const qty = (milli: number, unit: string) => `${formatQty(milli)}${unit}`;

function flows(r: LedgerImportRow) {
  const unit = r.material?.inventoryUnit ?? '';
  return [
    ...r.ins.map((e) => `入 ${e.date ?? '?'} ${e.qtyMilli !== null ? qty(e.qtyMilli, unit) : '?'}`),
    ...r.outs.map(
      (e) =>
        `出 ${e.date ?? '?'} ${e.qtyMilli !== null ? qty(e.qtyMilli, unit) : '?'} → ${e.department ? `${e.department.name}${e.receiver && e.receiver !== e.department.name ? ` ${e.receiver}` : ''}` : e.who || '?'}`,
    ),
  ];
}

export function LedgerImportPage() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateInventory();
  const settings = useInvSettings(can('inventory.operate'));
  const pending = useErpPending(['ledger_import', 'receipt_import']);
  const [file, setFile] = useState<LoadedTable | null>(null);
  const [preview, setPreview] = useState<LedgerImportPreview | null>(null);
  const [result, setResult] = useState<LedgerImportResult | null>(null);
  const [month, setMonth] = useState(session.calendarToday.slice(0, 7));
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
      const r = await api.post<LedgerImportPreview>('/api/inventory/ledger/import/preview', body());
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
      const r = await sendErpOp<LedgerImportResult>({
        key: clientKey,
        type: 'ledger_import',
        url: '/api/inventory/ledger/import',
        body: { ...body(), clientKey, previewDigest: preview.digest },
        summary: `出入库台账导入 · ${file.fileName} · ${preview.rows.length} 行`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      setResult(r);
      toast({
        tone: 'success',
        title: r.replayed ? '这次导入之前已经办好了' : `已导入 ${r.import.rowCount} 行`,
        body: `生成 ${r.import.receiptCount} 张库管入库、${r.import.issueCount} 张部门领料，都已生效`,
      });
      reset();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '导入结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，不要改了文件再导入。' });
        reset();
      } else if (e instanceof ErpPendingStoreError) setError(`${e.message} 文件较大时也可以拆成几份分批导入。`);
      else if (e instanceof ApiError && (e.code === 'IMPORT_REPEAT' || e.code === 'IMPORT_STALE')) {
        setError(e.message);
        void runPreview();
      } else setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const off = settings.data?.directReceipt === false;
  const blocked = off || !preview || preview.issueCount > 0 || !!preview.previous || preview.docs.length === 0 || pending.length > 0;
  const receipts = preview?.docs.filter((d) => d.kind === 'receipt').length ?? 0;
  const issues = (preview?.docs.length ?? 0) - receipts;
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/inventory/direct/new" className="tap relative -ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回库管入库">
              <ArrowLeft className="size-[18px]" />
            </Link>
            导入出入库台账
          </span>
        }
        subtitle="按门店的出入库记录版式一次登记：入库生成库管入库、出库生成部门领料，导入即生效"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="month"
              value={month}
              max={session.calendarToday.slice(0, 7)}
              onChange={(e) => setMonth(e.target.value)}
              aria-label="导出哪个月"
              className="h-9 rounded-md border border-line-strong bg-card px-2 text-[13px] outline-none focus:border-pine"
              data-testid="ledger-export-month"
            />
            <a
              href={/^\d{4}-\d{2}$/.test(month) ? exportUrl(month) : undefined}
              download
              className="tap relative flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3 hover:text-ink"
              data-testid="ledger-export"
            >
              <FileDown className="size-4" />
              导出台账
            </a>
            <a
              href={TEMPLATE_URL}
              download
              className="tap relative flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3 hover:text-ink"
              data-testid="ledger-template"
            >
              <Download className="size-4" />
              下载模板
            </a>
          </div>
        }
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-4 py-5 md:px-7" data-testid="ledger-import">
          <ErpPendingPanel types={['ledger_import', 'receipt_import']} className="space-y-2" onFound={() => void invalidate()} />
          {off && (
            <Notice tone="warning" title="库管入库已在库存设置里关掉">
              要用的话请店主在「ERP 设置 → 库存与审批开关」里打开。
            </Notice>
          )}
          <section className="space-y-3 rounded-lg border border-line bg-card p-5 shadow-card">
            <p className="text-[12.5px] text-ink-3">
              用右上角「下载模板」的出入库台账（一种物料一行；表头两行，入库每组写日期、数量，出库每组写日期、数量、领料人及部门）。有入库的行要写供应商；单价按每采购单位，空着取物料档案的参考价。
              一份最多 {LEDGER_MAX_ROWS} 行，同一天同一供应商的入库合成一张库管入库、同一天同一部门同一领料人的出库合成一张部门领料，一张最多 {LEDGER_LINES_PER_DOC} 行。同一份文件只能导入一次。
            </p>
            <label className="flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-dashed border-line-strong px-4 py-3 text-[13px] hover:border-ink-3">
              <FileUp className="size-5 text-ink-3" />
              <span className="min-w-0 font-semibold break-all">{file ? `${file.fileName}（${file.encoding}）` : '选择 Excel 或 CSV 文件'}</span>
              <input
                type="file"
                accept=".xlsx,.csv,text/csv"
                className="sr-only"
                aria-label="选择出入库台账"
                disabled={busy === 'preview' || busy === 'apply'}
                onChange={(e) => void choose(e.target.files?.[0])}
                data-testid="ledger-import-file"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                icon={<FileSearch className="size-4" />}
                disabled={!file || busy !== null}
                loading={busy === 'preview'}
                onClick={() => void runPreview()}
                data-testid="ledger-import-preview"
              >
                预览
              </Button>
              <Button
                variant="primary"
                icon={<CircleCheck className="size-4" />}
                disabled={blocked || busy !== null}
                loading={busy === 'apply'}
                onClick={() => void apply()}
                data-testid="ledger-import-apply"
              >
                {preview && preview.issueCount === 0 && preview.docs.length ? `导入（${receipts} 张入库、${issues} 张领料）` : '导入'}
              </Button>
            </div>
            {error && <Notice tone="error" title={error} />}
          </section>

          {preview && (
            <section className="space-y-3 rounded-lg border border-line bg-card p-5 shadow-card" data-testid="ledger-import-preview-result">
              {preview.previous ? (
                <Notice tone="error" title={`这份文件 ${formatDateTime(preview.previous.createdAt)} ${preview.previous.createdByName} 已经导入过`}>
                  上次生成了 {preview.previous.receiptCount} 张库管入库、{preview.previous.issueCount} 张部门领料。同一份文件不能再导入（重复记账会多出、多扣库存）；新发生的出入库请另做一份台账。
                </Notice>
              ) : preview.issueCount > 0 ? (
                <Notice tone="error" title={`有 ${preview.issueCount} 行要先改好`}>
                  标红的行在最后一列写着哪一列、为什么；有一行有问题整份都不导入。在 Excel 里改好后重新选择文件、再预览。
                </Notice>
              ) : preview.docs.length === 0 ? (
                <Notice tone="warning" title="这份台账里没有入库也没有出库，没有要导入的" />
              ) : (
                <Notice tone="success" title={`${preview.rows.length} 行都能导入：${receipts} 张库管入库（合计 ¥${formatAmount(preview.amountCents)}）、${issues} 张部门领料`}>
                  {preview.docs.map((d, i) => (
                    <span key={i} className="mr-3 inline-block">
                      {d.docDate} · {d.kind === 'receipt' ? '入库' : '领料'} · {d.party}
                      {d.kind === 'issue' && d.receiver && d.receiver !== d.party ? ` ${d.receiver}` : ''} · {d.lines} 行{d.kind === 'receipt' ? ` · ¥${formatAmount(d.amountCents)}` : ''}
                    </span>
                  ))}
                </Notice>
              )}
              {preview.warningCount > 0 && !preview.previous && (
                <Notice tone="warning" title={`${preview.warningCount} 行有提醒（黄色），不挡导入`}>
                  上期库存量、库存量与系统对不上的写在「提醒」一列，导入前请核对一下。
                </Notice>
              )}
              <DataTable
                variant="plain"
                tableClassName="min-w-[1040px]"
                rows={preview.rows}
                rowKey={(r) => r.row}
                rowClassName={(r) => cn('align-top', r.issues.length > 0 ? 'bg-clay-soft/40' : r.warnings.length > 0 && 'bg-yuzu-soft/40')}
                rowTestId={(r) => `ledger-import-row-${r.row}`}
                columns={[
                  { key: 'row', header: '行', cellClassName: 'num text-ink-3', cell: (r) => r.row },
                  {
                    key: 'material',
                    header: '物料',
                    cell: (r) => (
                      <>
                        {r.material ? r.material.name : '—'}
                        {r.material && <span className="num ml-1 text-[12px] text-ink-3">{r.material.code}</span>}
                        {r.location && (
                          <span className="block text-[12px] text-ink-3">
                            库位 {r.location}
                            {r.locationBefore !== r.location ? `（档案里${r.locationBefore ? `是 ${r.locationBefore}` : '没填'}，会改）` : ''}
                          </span>
                        )}
                      </>
                    ),
                  },
                  { key: 'supplier', header: '供应商', cellClassName: 'whitespace-nowrap', cell: (r) => r.supplier?.name ?? (r.ins.length ? '—' : '') },
                  {
                    key: 'flows',
                    header: '出入库',
                    cellClassName: 'text-[12.5px]',
                    cell: (r) => (
                      <ul className="space-y-0.5">
                        {flows(r).map((t, i) => (
                          <li key={i} className="num whitespace-nowrap">
                            {t}
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                  {
                    key: 'price',
                    header: '单价',
                    numeric: true,
                    cellClassName: 'whitespace-nowrap',
                    cell: (r) =>
                      r.ins.length ? (
                        <>
                          {r.priceCents !== null ? `¥${formatAmount(r.priceCents)}` : '—'}
                          {r.material && <span className="text-[12px] text-ink-3">/{r.material.purchaseUnit}</span>}
                          {r.priceFromRef && <span className="block text-[12px] text-ink-3">参考价</span>}
                        </>
                      ) : (
                        ''
                      ),
                  },
                  {
                    key: 'issues',
                    header: '问题 / 提醒',
                    headerClassName: 'w-[34%]',
                    cellClassName: 'text-[12.5px]',
                    cell: (r) => (
                      <>
                        {r.issues.length > 0 && <p className="font-semibold text-clay">{r.issues.join('；')}</p>}
                        {r.warnings.length > 0 && <p className="text-yuzu-deep">{r.warnings.join('；')}</p>}
                      </>
                    ),
                  },
                ]}
              />
            </section>
          )}

          {result && (
            <section className="space-y-2 rounded-lg border border-pine/30 bg-pine-tint/40 p-5" data-testid="ledger-import-done">
              <p className="text-[14px] font-bold">
                已导入 {result.import.rowCount} 行：{result.import.receiptCount} 张库管入库（合计 ¥{formatAmount(result.import.amountCents)}）、{result.import.issueCount} 张部门领料，都已生效
              </p>
              <ul className="flex flex-wrap gap-2">
                {result.docs.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/inventory/docs?doc=${d.id}`)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-1 text-[13px] font-semibold hover:border-line-strong"
                    >
                      <span className="num">{d.docNo}</span> · {d.docType === 'receipt' ? '入库' : '领料'} · {d.party} · {d.lineCount} 行
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
