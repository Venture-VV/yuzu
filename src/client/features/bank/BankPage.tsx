// ERP「财务 → 银行流水」（8.0.21，docs/FINANCE_V8021.md 第 4 节，CW-C）：本公司的银行账户、导入网银对账单、与付款 / 回款勾对。
// 导入时按同义词认列，认不准的在预览里改；同一份文件只导一次。勾对：导入时自动对上「金额、日期前后 3 天、户名都对得上且只有一个」的，
// 其余在这里挑；对平了才算这条对上。超过 7 天没对上的进待办。

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, FileUp, Link2, Plus } from 'lucide-react';
import {
  BANK_TEMPLATE_LABELS,
  BANK_TEMPLATES,
  MATCH_TARGET_LABELS,
  STATEMENT_FIELD_LABELS,
  STATEMENT_FIELDS,
  type BankAccount,
  type BankImportPreview,
  type BankLine,
  type BankOverview,
  type BankTemplate,
  type ColumnMap,
  type MatchTarget,
} from '@shared/bank';
import { formatAmount } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog, Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';

const KEY = ['bank'] as const;
const VIEWS = [
  { key: 'open', label: '没对上' },
  { key: 'matched', label: '对平了' },
  { key: 'ignored', label: '不用对' },
  { key: 'all', label: '全部' },
] as const;
type View = (typeof VIEWS)[number]['key'];
const yuan = (c: number) => `¥${formatAmount(c)}`;

export function BankPage() {
  const can = useCan();
  const manage = can('payable.manage');
  const [view, setView] = useState<View>('open');
  const [accountId, setAccountId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<BankAccount | 'new' | null>(null);
  const data = useQuery({
    queryKey: [...KEY, view, accountId, q.trim()],
    queryFn: () => api.get<BankOverview>(`/api/erp/bank?status=${view}${accountId ? `&accountId=${accountId}` : ''}&q=${encodeURIComponent(q.trim())}`),
  });
  const d = data.data;
  return (
    <ErpPage
      title="银行流水"
      description="导入网银导出的对账单，与系统里的付款、回款、备用金、平台打款勾对。只记账号后四位；超过 7 天没对上的流水、没对上流水的付款与回款进待办。"
      actions={
        manage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="bank-account-new">
              新增账户
            </Button>
            <Button variant="primary" icon={<FileUp className="size-4" />} disabled={!d?.accounts.some((a) => a.active)} onClick={() => setImporting(true)} data-testid="bank-import">
              导入对账单
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-4" data-testid="bank-page">
        {manage && <ErpPendingPanel types={['bank_import']} />}
        {!d ? (
          data.error ? <Notice tone="error" title={errorMessage(data.error)} /> : <Skeleton className="h-60" />
        ) : (
          <>
            {d.accounts.length === 0 ? (
              <EmptyState art="leaf" title="还没有银行账户" description={manage ? '先「新增账户」：名称、开户行、账号后四位' : '对账付款的同事先建账户'} />
            ) : (
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setAccountId(null)} className={cn('h-9 rounded-full px-3.5 text-[13px] font-semibold', accountId === null ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2')}>
                  全部账户
                </button>
                {d.accounts.map((a) => (
                  <span key={a.id} className={cn('inline-flex h-9 items-center gap-1 rounded-full pl-3.5 pr-1 text-[13px] font-semibold', accountId === a.id ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2', !a.active && 'opacity-60')}>
                    <button type="button" onClick={() => setAccountId(a.id)}>
                      <Building2 className="mr-1 inline size-3.5" />
                      {a.name} · {a.bankName} 尾号 {a.accountTail}
                    </button>
                    {manage && (
                      <button type="button" className="rounded-full px-2 text-[12px] opacity-80 hover:opacity-100" onClick={() => setEditing(a)}>
                        改
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {(d.counts.stale > 0 || d.counts.unmatchedPayments > 0) && (
              <Notice tone="warning" title="有超过 7 天没对上的" data-testid="bank-todo">
                {d.counts.stale > 0 && `${d.counts.stale} 条流水还没对上系统里的记录；`}
                {d.counts.unmatchedPayments > 0 && `${d.counts.unmatchedPayments} 笔付款 / 回款还没对上流水（从有流水那天起算）。`}
              </Notice>
            )}
            <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="流水视图">
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  role="tab"
                  aria-selected={view === v.key}
                  onClick={() => setView(v.key)}
                  className={cn('h-9 rounded-full px-3.5 text-[13px] font-semibold', view === v.key ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2 hover:text-ink')}
                  data-testid={`bank-view-${v.key}`}
                >
                  {v.label}
                  {v.key === 'open' && d.counts.open > 0 && <span className="num ml-1.5">{d.counts.open}</span>}
                </button>
              ))}
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="对方户名、摘要、流水号、金额" fullWidth={false} className="ml-auto h-9 w-60" aria-label="搜索流水" />
            </div>
            {d.lines.length === 0 ? (
              <EmptyState art="search" title="没有流水" description={view === 'open' ? '都对上了，或者还没导入' : '换个视图看看'} />
            ) : (
              <Card className="overflow-hidden">
                <ul className="divide-y divide-line/70" data-testid="bank-lines">
                  {d.lines.map((l) => (
                    <li key={l.id}>
                      <button type="button" onClick={() => setOpenId(l.id)} className="grid w-full grid-cols-[5.5em_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 text-left hover:bg-paper-2/50" data-testid={`bank-line-${l.bankRef || l.id}`}>
                        <span className="num text-[12.5px] text-ink-3">{l.txnDate}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] font-semibold">{l.counterparty || '（没有对方户名）'}</span>
                          <span className="block truncate text-[12px] text-ink-3">
                            {l.summary}
                            {l.bankRef ? ` · ${l.bankRef}` : ''} · {l.accountName}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className={cn('num block text-[14px] font-bold', l.direction === 'in' ? 'text-pine' : 'text-ink')}>
                            {l.direction === 'in' ? '+' : '−'}
                            {yuan(l.amountCents)}
                          </span>
                          <LineStatus l={l} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {d.truncated && <p className="border-t border-line px-4 py-2 text-[12.5px] text-ink-3">只列最近的 500 条，按账户或搜索缩小范围</p>}
              </Card>
            )}
          </>
        )}
      </div>
      <LineSheet id={openId} manage={manage} onClose={() => setOpenId(null)} />
      <ImportDialog open={importing} accounts={d?.accounts.filter((a) => a.active) ?? []} onClose={() => setImporting(false)} />
      <AccountDialog editing={editing} onClose={() => setEditing(null)} />
    </ErpPage>
  );
}

function LineStatus({ l }: { l: BankLine }) {
  if (l.status === 'ignored') return <Badge>不用对</Badge>;
  if (l.status === 'matched') return <Badge tone={l.targetVoided ? 'clay' : 'pine'}>{l.targetVoided ? '对象已作废' : '对平了'}</Badge>;
  return <Badge tone="ember">{l.matchedCents > 0 ? `还差 ${yuan(l.amountCents - l.matchedCents)}` : '没对上'}</Badge>;
}

function LineSheet({ id, manage, onClose }: { id: number | null; manage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const line = useQuery({ queryKey: [...KEY, 'line', id], queryFn: () => api.get<BankLine>(`/api/erp/bank/lines/${id}`), enabled: id !== null });
  const l = line.data;
  const open = !!l && l.status === 'open' && manage;
  const cand = useQuery({
    queryKey: [...KEY, 'cand', id, l?.version],
    queryFn: () => api.get<{ suggested: MatchTarget[]; others: MatchTarget[] }>(`/api/erp/bank/lines/${id}/candidates`),
    enabled: open,
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ignoring, setIgnoring] = useState(false);
  const [unmatching, setUnmatching] = useState<number | null>(null);
  const [lastId, setLastId] = useState<number | null>(null);
  if (id !== lastId) {
    setLastId(id);
    setPicked([]);
    setError(null);
  }
  const all = [...(cand.data?.suggested ?? []), ...(cand.data?.others ?? [])];
  const sum = all.filter((c) => picked.includes(`${c.type}:${c.id}`)).reduce((s, c) => s + c.amountCents, 0);
  const remaining = l ? l.amountCents - l.matchedCents : 0;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: KEY });
    await qc.invalidateQueries({ queryKey: ['erp', 'bank', 'todo'] });
  };
  const post = async (url: string, body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(url, body);
      toast({ tone: 'success', title: ok });
      setPicked([]);
      setIgnoring(false);
      setUnmatching(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const row = (c: MatchTarget) => {
    const k = `${c.type}:${c.id}`;
    return (
      <label key={k} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-paper-2/60">
        <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={picked.includes(k)} onChange={(e) => setPicked(e.target.checked ? [...picked, k] : picked.filter((x) => x !== k))} data-testid={`bank-cand-${c.docNo}`} />
        <span className="num w-[5.5em] text-ink-3">{c.date}</span>
        <span className="min-w-0 flex-1 truncate">
          {MATCH_TARGET_LABELS[c.type]} · <span className="num">{c.docNo}</span> · {c.party}
        </span>
        <span className="num font-semibold">{yuan(c.amountCents)}</span>
      </label>
    );
  };
  return (
    <Sheet open={id !== null} onClose={onClose} label="银行流水" width="w-[min(600px,100vw)]">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex size-8 items-center justify-center rounded-full bg-lake-soft text-lake">
          <Link2 className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="num text-[16px] font-bold">{l ? `${l.direction === 'in' ? '收入' : '付出'} ${yuan(l.amountCents)}` : '流水'}</p>
          {l && (
            <p className="truncate text-[12.5px] text-ink-3">
              {l.txnDate} · {l.counterparty || '（没有对方户名）'} · {l.summary}
            </p>
          )}
        </div>
        {l && <LineStatus l={l} />}
      </div>
      {!l ? (
        <div className="p-5">
          {line.isError ? <LoadFailed title="这条流水取不回来，请检查网络" onRetry={() => void line.refetch()} retrying={line.isFetching} testId="bank-line-error" /> : <Skeleton className="h-40" />}
        </div>
      ) : (
        <div className="space-y-4 p-5" data-testid="bank-line-sheet">
          <p className="text-[12.5px] text-ink-3">
            {l.accountName}
            {l.bankRef ? ` · 流水号 ${l.bankRef}` : ''}
            {l.counterpartyAccount ? ` · 对方账号 ${l.counterpartyAccount}` : ''}
            {l.balanceCents !== null ? ` · 余额 ${yuan(l.balanceCents)}` : ''}
          </p>
          {l.ignoreReason && <Notice tone="info" title={`不用对：${l.ignoreReason}`} />}
          {l.matches.length > 0 && (
            <section>
              <p className="mb-1 text-[13px] font-semibold text-ink-2">已勾对</p>
              <ul className="space-y-1">
                {l.matches.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-[13px]">
                    <span className="min-w-0 flex-1 truncate">
                      {MATCH_TARGET_LABELS[m.target.type]} · <span className="num">{m.target.docNo}</span> · {m.target.party}
                      {m.target.voided && <Badge tone="clay" className="ml-1.5">已作废</Badge>}
                      <span className="ml-1.5 text-[12px] text-ink-3">
                        {m.auto ? '自动' : m.createdByName} · {formatDateTime(m.createdAt)}
                      </span>
                    </span>
                    <span className="num font-semibold">{yuan(m.amountCents)}</span>
                    {manage && (
                      <Button size="sm" variant="ghost" onClick={() => setUnmatching(m.id)}>
                        撤销
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {open && (
            <section>
              <p className="mb-1 text-[13px] font-semibold text-ink-2">
                挑系统里的记录（还差 <span className="num">{yuan(remaining)}</span>）
              </p>
              {!cand.data ? (
                cand.isError ? (
                  <LoadFailed title="能对的记录取不回来，请检查网络" onRetry={() => void cand.refetch()} retrying={cand.isFetching} testId="bank-candidates-error" />
                ) : (
                  <Skeleton className="h-24" />
                )
              ) : all.length === 0 ? (
                <p className="text-[13px] text-ink-3">前后 30 天里没有金额不超过它、还没对上的记录。利息、手续费这类可以标「不用对」。</p>
              ) : (
                <div className="max-h-[42vh] space-y-0.5 overflow-y-auto">
                  {cand.data.suggested.length > 0 && <p className="px-2 text-[12px] font-semibold text-pine">金额相等的</p>}
                  {cand.data.suggested.map(row)}
                  {cand.data.others.length > 0 && <p className="px-2 pt-1 text-[12px] font-semibold text-ink-3">其他</p>}
                  {cand.data.others.map(row)}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className={cn('text-[12.5px]', sum > remaining ? 'font-semibold text-clay' : 'text-ink-3')}>
                  选了 {yuan(sum)}
                  {sum > 0 && sum < remaining ? `，对完还差 ${yuan(remaining - sum)}` : sum > remaining ? '，超过了' : ''}
                </span>
                <span className="flex-1" />
                <Button variant="ghost" onClick={() => setIgnoring(true)} data-testid="bank-ignore">
                  不用对
                </Button>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!picked.length || sum > remaining}
                  onClick={() => void post(`/api/erp/bank/lines/${l.id}/match`, { version: l.version, targets: picked.map((k) => ({ type: k.split(':')[0], id: Number(k.split(':')[1]) })) }, sum === remaining ? '已勾对，这条对平了' : '已勾对')}
                  data-testid="bank-match"
                >
                  勾对
                </Button>
              </div>
            </section>
          )}
          {l.status === 'ignored' && manage && (
            <Button variant="secondary" loading={busy} onClick={() => void post(`/api/erp/bank/lines/${l.id}/reopen`, { version: l.version }, '已改回没对上')}>
              改回没对上
            </Button>
          )}
          {error && <Notice tone="error" title={error} />}
        </div>
      )}
      <ReasonDialog
        open={ignoring}
        title="这条流水不用对"
        description="利息、银行手续费这类系统里没有对应记录的，写清楚是什么。"
        confirmLabel="不用对"
        busy={busy}
        reasons={['存款利息', '银行手续费', '账户管理费', '内部转账']}
        onClose={() => setIgnoring(false)}
        onConfirm={(reason) => l && void post(`/api/erp/bank/lines/${l.id}/ignore`, { version: l.version, reason }, '已标不用对')}
      />
      <ReasonDialog open={unmatching !== null} title="撤销勾对" confirmLabel="撤销" danger busy={busy} onClose={() => setUnmatching(null)} onConfirm={(reason) => void post(`/api/erp/bank/matches/${unmatching}/void`, { reason }, '已撤销勾对')} />
    </Sheet>
  );
}

function fileToPayload(file: File): Promise<{ csv?: string; xlsxBase64?: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const isXlsx = /\.xlsx$/i.test(file.name);
    reader.onerror = () => reject(new Error('文件读不出来'));
    reader.onload = () => {
      if (isXlsx) {
        const s = String(reader.result);
        resolve({ xlsxBase64: s.slice(s.indexOf(',') + 1) });
      } else {
        // 网银导出的 CSV 常是 GBK：先按 UTF-8 读，读出乱码再按 GBK 读
        const buf = reader.result as ArrayBuffer;
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('�')) {
          try {
            text = new TextDecoder('gbk').decode(buf);
          } catch {
            /* 浏览器不认 GBK 就按 UTF-8 */
          }
        }
        resolve({ csv: text });
      }
    };
    if (isXlsx) reader.readAsDataURL(file);
    else reader.readAsArrayBuffer(file);
  });
}

function ImportDialog({ open, accounts, onClose }: { open: boolean; accounts: BankAccount[]; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const pending = useErpPending(['bank_import']);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [file, setFile] = useState<{ name: string; payload: { csv?: string; xlsxBase64?: string } } | null>(null);
  const [map, setMap] = useState<ColumnMap | null>(null);
  // 预览记着是按哪个账户、哪份文件看的（列对照就是它自己的 columnMap）：换账户、换文件作废，改列对照时重新预览、新的回来之前不能导入；
  // 每发一次预览加一，回来晚了的旧预览不再用（Codex 审查 0edd8df 后补：原来旧的回来晚了会盖掉新的，导入时拿当前文件配旧的列对照）
  const [preview, setPreview] = useState<(BankImportPreview & { forAccount: number; forFile: object }) | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    previewSeq.current += 1;
    setAccountId(accounts[0]?.id ?? null);
    setFile(null);
    setMap(null);
    setPreview(null);
    setPreviewing(false);
    setError(null);
  });
  const runPreview = async (f = file, m = map, acc = accountId) => {
    const seq = ++previewSeq.current;
    if (!f || !acc) {
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    setError(null);
    try {
      const p = await api.post<BankImportPreview>('/api/erp/bank/import/preview', { accountId: acc, fileName: f.name, ...f.payload, ...(m ? { columnMap: m } : {}) });
      if (seq !== previewSeq.current) return;
      setPreview({ ...p, forAccount: acc, forFile: f });
      setMap(p.columnMap);
    } catch (e) {
      if (seq !== previewSeq.current) return;
      setError(errorMessage(e));
      setPreview(null);
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  };
  /** 预览是不是就是现在选的账户、文件（而且没有更新的预览在路上） */
  const previewCurrent = !!preview && !previewing && preview.forAccount === accountId && preview.forFile === file;
  const commit = async () => {
    if (!file || !accountId || !preview || !previewCurrent) return;
    setBusy(true);
    setError(null);
    // 交的列对照就是这一份预览用的（服务端认出来的或员工改过的），与看到的预览一致
    const body = { clientKey: uuid(), accountId, fileName: file.name, ...file.payload, columnMap: preview.columnMap };
    try {
      const r = await sendErpOp<{ import: { newCount: number; dupCount: number; autoMatched: number } }>({
        key: body.clientKey,
        type: 'bank_import',
        url: '/api/erp/bank/import',
        body,
        summary: `导入对账单 ${file.name}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: `导入了 ${r.import.newCount} 条流水`, body: `重复的 ${r.import.dupCount} 条没再记；自动对上 ${r.import.autoMatched} 条` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '导入没收到结果', body: '记在页面上方的「结果待确认」里' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: KEY });
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="导入对账单"
      description="网银里导出的交易明细（CSV 或 Excel）。认不准的列在下面改；同一份文件只导一次，已经有的流水不会重复记。"
      width="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy || previewing}
            disabled={!preview || !previewCurrent || !!preview.problem || preview.alreadyImported || preview.lines.length === 0 || pending.length > 0}
            onClick={() => void commit()}
            data-testid="bank-import-confirm"
          >
            导入 {preview ? `${preview.lines.length - preview.duplicates} 条新的` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="bank-import-dialog">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="账户" htmlFor="bi-account">
            <Select
              id="bi-account"
              value={accountId ?? ''}
              disabled={busy}
              onChange={(e) => {
                const v = Number(e.target.value) || null;
                setAccountId(v);
                setMap(null);
                setPreview(null);
                void runPreview(file, null, v);
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · 尾号 {a.accountTail}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="文件" htmlFor="bi-file">
            <input
              id="bi-file"
              type="file"
              accept=".csv,.xlsx,text/csv"
              className="text-[13px]"
              data-testid="bank-import-file"
              disabled={busy}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                previewSeq.current += 1;
                setPreview(null);
                const payload = await fileToPayload(f);
                const next = { name: f.name, payload };
                setFile(next);
                setMap(null);
                await runPreview(next, null);
              }}
            />
          </Field>
        </div>
        {preview && (
          <>
            {preview.alreadyImported && <Notice tone="warning" title="这份文件已经导入过了" />}
            {preview.problem && <Notice tone="error" title={preview.problem} />}
            <div className="grid gap-2 rounded-lg bg-paper-2/50 p-3 sm:grid-cols-3">
              {STATEMENT_FIELDS.map((f) => (
                <label key={f} className="flex items-center gap-2 text-[12.5px]">
                  <span className="w-[7.5em] shrink-0 text-ink-3">{STATEMENT_FIELD_LABELS[f]}</span>
                  <Select
                    value={map?.[f] ?? ''}
                    className="h-8 text-[12.5px]"
                    disabled={busy}
                    onChange={(e) => {
                      const next = { ...(map ?? {}), [f]: e.target.value || undefined };
                      setMap(next);
                      void runPreview(file, next);
                    }}
                    aria-label={STATEMENT_FIELD_LABELS[f]}
                  >
                    <option value="">（没有）</option>
                    {preview.header.filter(Boolean).map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
            <p className="text-[12.5px] text-ink-3">
              认出 {preview.lines.length} 条流水，其中 {preview.duplicates} 条已经在系统里
              {preview.problems.length > 0 && `；${preview.problems.length} 行认不出（${preview.problems.slice(0, 3).map((p) => `第 ${p.row} 行${p.message}`).join('，')}）`}
            </p>
            {preview.lines.length > 0 && (
              <div className="max-h-56 overflow-y-auto rounded-lg border border-line">
                <table className="w-full text-[12.5px]">
                  <tbody className="divide-y divide-line/60">
                    {preview.lines.slice(0, 30).map((l) => (
                      <tr key={l.row}>
                        <td className="num px-2 py-1 text-ink-3">{l.txnDate}</td>
                        <td className="px-2 py-1">{l.counterparty}</td>
                        <td className="px-2 py-1 text-ink-3">{l.summary}</td>
                        <td className={cn('num px-2 py-1 text-right font-semibold', l.direction === 'in' && 'text-pine')}>
                          {l.direction === 'in' ? '+' : '−'}
                          {yuan(l.amountCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {busy && !preview && <Skeleton className="h-24" />}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function AccountDialog({ editing, onClose }: { editing: BankAccount | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const a = editing && editing !== 'new' ? editing : null;
  const [name, setName] = useState('');
  const [bankName, setBankName] = useState('');
  const [tail, setTail] = useState('');
  const [template, setTemplate] = useState<BankTemplate>('generic');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(!!editing, () => {
    setName(a?.name ?? '');
    setBankName(a?.bankName ?? '');
    setTail(a?.accountTail ?? '');
    setTemplate(a?.template ?? 'generic');
    setActive(a?.active ?? true);
    setError(null);
  });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), bankName: bankName.trim(), accountTail: tail.trim(), template };
      if (a) await api.put(`/api/erp/bank/accounts/${a.id}`, { ...body, version: a.version, active });
      else await api.post('/api/erp/bank/accounts', body);
      toast({ tone: 'success', title: '账户已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: KEY });
    }
  };
  return (
    <Dialog
      open={!!editing}
      onClose={busy ? () => {} : onClose}
      title={a ? '修改银行账户' : '新增银行账户'}
      description="完整账号不进系统，只记后四位用来认是哪个账户。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !bankName.trim() || !/^\d{4}$/.test(tail.trim())} onClick={() => void save()} data-testid="bank-account-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="账户名称" htmlFor="ba-name" hint="如「基本户」「收款户」">
          <Input id="ba-name" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} className="h-10" data-testid="ba-name" />
        </Field>
        <Field label="开户行" htmlFor="ba-bank">
          <Input id="ba-bank" value={bankName} maxLength={40} onChange={(e) => setBankName(e.target.value)} className="h-10" data-testid="ba-bank" />
        </Field>
        <Field label="账号后四位" htmlFor="ba-tail">
          <Input id="ba-tail" value={tail} maxLength={4} inputMode="numeric" onChange={(e) => setTail(e.target.value.replace(/\D/g, ''))} className="num h-10" data-testid="ba-tail" />
        </Field>
        <Field label="网银格式" htmlFor="ba-template" hint="批量付款文件按它导出">
          <Select id="ba-template" value={template} onChange={(e) => setTemplate(e.target.value as BankTemplate)}>
            {BANK_TEMPLATES.map((t) => (
              <option key={t} value={t}>
                {BANK_TEMPLATE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        {a && (
          <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
            <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={active} onChange={(e) => setActive(e.target.checked)} />
            启用（停用的不再导入）
          </label>
        )}
        {error && <Notice tone="error" title={error} className="sm:col-span-2" />}
      </div>
    </Dialog>
  );
}
