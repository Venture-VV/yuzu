// 付款 →「批量付款」（8.0.21，docs/FINANCE_V8021.md 第 5 节，CW-D）：勾选已审批、没付清的付款申请生成一批 → 导出网银模板 →
// 在网银里上传付款 → 回来导入银行流水自动对上记账；对不上的手工「标记已付 / 失败」。导出以后不能改，只能作废重开。

import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Layers } from 'lucide-react';
import { BANK_TEMPLATE_LABELS, type BankOverview } from '@shared/bank';
import { formatAmount } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, downloadUrl, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, Notice, Select, Skeleton } from '../../components/ui';

interface Candidate {
  requestId: number;
  requestNo: string;
  payee: string;
  supplierName: string | null;
  leftCents: number;
  expectedDate: string;
  bankPayee: string;
  bankName: string;
  bankAccountTail: string;
  bankOk: boolean;
  bankUnverified: boolean;
}
interface Item {
  id: number;
  lineNo: number;
  requestNo: string;
  amountCents: number;
  payeeName: string;
  payeeBank: string;
  payeeAccountMasked: string;
  status: 'pending' | 'paid' | 'failed' | 'removed';
  paidOn: string | null;
  bankRef: string;
  failReason: string | null;
  matched: boolean;
}
interface Batch {
  id: number;
  batchNo: string;
  accountName: string;
  template: keyof typeof BANK_TEMPLATE_LABELS;
  status: 'draft' | 'exported' | 'done' | 'voided';
  totalCents: number;
  itemCount: number;
  version: number;
  createdByName: string;
  voidReason: string | null;
  items: Item[];
}
const KEY = ['payments', 'batches'] as const;
const STATUS: Record<Batch['status'], { label: string; tone: 'lake' | 'ember' | 'pine' | 'neutral' }> = {
  draft: { label: '待导出', tone: 'lake' },
  exported: { label: '已导出，等结果', tone: 'ember' },
  done: { label: '已完成', tone: 'pine' },
  voided: { label: '已作废', tone: 'neutral' },
};
const ITEM_STATUS: Record<Item['status'], string> = { pending: '等结果', paid: '已付', failed: '失败', removed: '已移出' };
const yuan = (c: number) => `¥${formatAmount(c)}`;

export function BatchesTab() {
  const can = useCan();
  const manage = can('payable.manage');
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: KEY, queryFn: () => api.get<{ batches: Batch[]; candidates: Candidate[] }>('/api/erp/payments/batches') });
  const accounts = useQuery({ queryKey: ['bank', 'accounts-for-batch'], queryFn: () => api.get<BankOverview>('/api/erp/bank?status=open'), enabled: manage });
  const pending = useErpPending(['payment_batch']);
  const [picked, setPicked] = useState<number[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<Batch | null>(null);
  const [confirmNotPaid, setConfirmNotPaid] = useState(false);
  const [paying, setPaying] = useState<Item | null>(null);
  const [failing, setFailing] = useState<Item | null>(null);
  const d = data.data;
  const activeAccounts = accounts.data?.accounts.filter((a) => a.active) ?? [];
  const acc = accountId ?? activeAccounts[0]?.id ?? null;
  const pickedRows = (d?.candidates ?? []).filter((c) => picked.includes(c.requestId));
  const total = pickedRows.reduce((s, c) => s + c.leftCents, 0);
  const refresh = () => qc.invalidateQueries({ queryKey: ['payments'] });
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      toast({ tone: 'success', title: ok });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  const create = async () => {
    if (!acc) return;
    const body = { clientKey: uuid(), accountId: acc, requestIds: picked };
    setBusy('create');
    setError(null);
    try {
      await sendErpOp({
        key: body.clientKey,
        type: 'payment_batch',
        url: '/api/erp/payments/batches',
        body,
        summary: `批量付款 ${picked.length} 笔 ${yuan(total)}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '已生成这一批', body: '下一步：导出网银模板，到网银里上传付款' });
      setPicked([]);
    } catch (e) {
      if (e instanceof UncertainError) toast({ tone: 'error', title: '生成没收到结果', body: '记在上方的「结果待确认」里' });
      else setError(errorMessage(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  // 取不回来（也没有上一次的）写明加载失败、可以重试（AGENTS.md「列表取不回来用 LoadFailed」）
  if (!d)
    return data.isError ? (
      <LoadFailed title="批量付款加载失败，请检查网络" onRetry={() => void data.refetch()} retrying={data.isFetching} testId="batches-error">
        {errorMessage(data.error)}
      </LoadFailed>
    ) : (
      <Skeleton className="h-60" />
    );
  return (
    <div className="space-y-5" data-testid="batches-tab">
      {manage && <ErpPendingPanel types={['payment_batch']} />}
      {manage && (
        <Card className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <h3 className="mr-auto text-[14px] font-bold">待付款的申请（{d.candidates.length}）</h3>
            {/* 付款账户取不回来不当成「没有账户」（Codex 审查 76d9c72 后补）：写明加载失败、可以重试；还在取时占个位 */}
            {!accounts.data ? (
              accounts.isError ? (
                <LoadFailed title="付款账户取不回来，请检查网络" onRetry={() => void accounts.refetch()} retrying={accounts.isFetching} testId="batch-accounts-error" />
              ) : (
                <Skeleton className="h-10 w-60" />
              )
            ) : activeAccounts.length === 0 ? (
              <Notice tone="info" title="先建一个银行账户">
                在{' '}
                <Link to="/erp/bank" className="font-semibold text-pine hover:underline">
                  银行流水
                </Link>{' '}
                里新增付款用的账户（只记后四位），网银模板按它的格式导出。
              </Notice>
            ) : (
              <>
                <Field label="付款账户" htmlFor="batch-account">
                  <Select id="batch-account" fullWidth={false} className="w-60" value={acc ?? ''} onChange={(e) => setAccountId(Number(e.target.value) || null)}>
                    {activeAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · 尾号 {a.accountTail}（{BANK_TEMPLATE_LABELS[a.template]}格式）
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  variant="primary"
                  icon={<Layers className="size-4" />}
                  loading={busy === 'create'}
                  disabled={!picked.length || !acc || pending.length > 0}
                  onClick={() => void create()}
                  data-testid="batch-create"
                >
                  生成一批（{picked.length} 笔 {yuan(total)}）
                </Button>
              </>
            )}
          </div>
          {d.candidates.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-3">没有批了待付款、还不在批次里的申请。</p>
          ) : (
            <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
              {d.candidates.map((c) => (
                <li key={c.requestId}>
                  <label className={cn('flex items-center gap-3 px-3 py-2 text-[13px]', c.bankOk ? 'cursor-pointer hover:bg-paper-2/50' : 'opacity-70')}>
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--color-pine)]"
                      disabled={!c.bankOk}
                      checked={picked.includes(c.requestId)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, c.requestId] : picked.filter((x) => x !== c.requestId))}
                      data-testid={`batch-pick-${c.requestNo}`}
                    />
                    <span className="num w-[9em] shrink-0 font-semibold">{c.requestNo}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {c.supplierName ?? c.payee}
                      <span className="ml-2 text-[12px] text-ink-3">
                        {c.bankOk
                          ? `${c.bankPayee} · ${c.bankName} · 尾号 ${c.bankAccountTail}`
                          : c.bankUnverified
                            ? `收款账户（尾号 ${c.bankAccountTail}）改过以后还没复核：到供应商档案的「收款账户」里由另一位应付或店主复核`
                            : '收款账户没登记全：到供应商档案的「收款账户」里补户名、开户行、账号'}
                      </span>
                    </span>
                    <span className="num text-ink-3">{c.expectedDate}</span>
                    <span className="num w-[7em] text-right font-bold">{yuan(c.leftCents)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {error && <Notice tone="error" title={error} />}
      {d.batches.length === 0 ? (
        <EmptyState art="leaf" title="还没有批量付款" description="勾选上面待付款的申请生成一批，导出网银模板上传付款。" />
      ) : (
        d.batches.map((b) => (
          <Card key={b.id} className="p-4" data-testid={`batch-${b.batchNo}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="num text-[15px] font-bold">{b.batchNo}</span>
              <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge>
              <span className="text-[12.5px] text-ink-3">
                {b.accountName} · {BANK_TEMPLATE_LABELS[b.template]}格式 · {b.itemCount} 笔 · {b.createdByName}
              </span>
              <span className="num ml-auto text-[15px] font-bold">{yuan(b.totalCents)}</span>
            </div>
            {b.voidReason && <p className="mt-1 text-[12.5px] text-ink-3">作废：{b.voidReason}</p>}
            <ul className="mt-2 space-y-1 text-[13px]">
              {b.items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2 rounded-md bg-paper-2/40 px-3 py-1.5">
                  <span className="num text-ink-3">{i.lineNo}</span>
                  <span className="num font-semibold">{i.requestNo}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {i.payeeName} · {i.payeeBank} · {i.payeeAccountMasked}
                  </span>
                  <span className="num font-bold">{yuan(i.amountCents)}</span>
                  <Badge tone={i.status === 'paid' ? 'pine' : i.status === 'failed' ? 'clay' : 'neutral'}>
                    {ITEM_STATUS[i.status]}
                    {i.matched ? ' · 已对上流水' : ''}
                  </Badge>
                  {i.failReason && i.status !== 'removed' && <span className="text-[12px] text-clay">{i.failReason}</span>}
                  {manage && b.status === 'exported' && i.status === 'pending' && (
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setPaying(i)} data-testid={`batch-item-paid-${i.id}`}>
                        标记已付
                      </Button>
                      <Button size="sm" variant="ghost" className="text-clay" onClick={() => setFailing(i)}>
                        失败
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {manage && (b.status === 'draft' || b.status === 'exported') && (
              <div className="mt-3 flex flex-wrap gap-2">
                {b.status === 'draft' && (
                  <Button
                    variant="primary"
                    icon={<Download className="size-4" />}
                    loading={busy === `export-${b.id}`}
                    onClick={() =>
                      void run(
                        `export-${b.id}`,
                        async () => {
                          await api.post(`/api/erp/payments/batches/${b.id}/export`, { version: b.version });
                          downloadUrl(`/api/erp/payments/batches/${b.id}/file`);
                        },
                        '已导出，到网银里上传这个文件',
                      )
                    }
                    data-testid={`batch-export-${b.batchNo}`}
                  >
                    导出网银模板
                  </Button>
                )}
                {b.status === 'exported' && (
                  <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/erp/payments/batches/${b.id}/file`)}>
                    再下载一次
                  </Button>
                )}
                <Button variant="ghost" className="text-clay" onClick={() => (setVoiding(b), setConfirmNotPaid(false))}>
                  作废这一批
                </Button>
                {b.status === 'exported' && <span className="self-center text-[12.5px] text-ink-3">付完以后到「银行流水」导入对账单，金额与收款户名对上的会自动记账。</span>}
              </div>
            )}
          </Card>
        ))
      )}
      <ReasonDialog
        open={!!voiding}
        title={`作废 ${voiding?.batchNo ?? ''}`}
        description="作废以后这几张申请可以重新生成一批。已经在网银里付了的不能作废。"
        confirmLabel="作废"
        danger
        busy={busy === 'void'}
        extra={
          <div className="mt-3">
            <ConfirmCheck checked={confirmNotPaid} onChange={setConfirmNotPaid} tone="clay">
              我确认这一批没有在网银里付款
            </ConfirmCheck>
          </div>
        }
        onClose={() => setVoiding(null)}
        onConfirm={(reason) =>
          voiding &&
          void run('void', () => api.post(`/api/erp/payments/batches/${voiding.id}/void`, { version: voiding.version, reason, confirmNotPaid: confirmNotPaid || undefined }), '已作废').then(
            (ok) => ok && setVoiding(null),
          )
        }
      />
      <PaidDialog item={paying} onClose={() => setPaying(null)} onDone={refresh} />
      <ReasonDialog
        open={!!failing}
        title="这一笔没付成"
        description="网银退回、户名不符等。标了失败以后这张申请回到待付款，可以重新生成一批或单独登记。"
        confirmLabel="标记失败"
        danger
        busy={busy === 'fail'}
        onClose={() => setFailing(null)}
        onConfirm={(reason) => failing && void run('fail', () => api.post(`/api/erp/payments/batch-items/${failing.id}/failed`, { reason }), '已标记失败').then((ok) => ok && setFailing(null))}
      />
    </div>
  );
}

function PaidDialog({ item, onClose, onDone }: { item: Item | null; onClose: () => void; onDone: () => Promise<unknown> }) {
  const session = useSession();
  const toast = useToast();
  const [date, setDate] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<number | null>(null);
  if ((item?.id ?? null) !== last) {
    setLast(item?.id ?? null);
    setDate(session.calendarToday);
    setRef('');
    setError(null);
  }
  const save = async () => {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/erp/payments/batch-items/${item.id}/paid`, { payDate: date, bankRef: ref.trim() });
      toast({ tone: 'success', title: '已记已付', body: '照「按申请登记付款」记了账' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  return (
    <Dialog
      open={!!item}
      onClose={busy ? () => {} : onClose}
      title="标记已付"
      description="网银里看到这一笔付成功了、但流水还没导进来时用。会照「按申请登记付款」记账；之后导入的流水可以再勾对。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!date || date > session.calendarToday} onClick={() => void save()} data-testid="batch-paid-confirm">
            记已付
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="付款日" htmlFor="bp-date">
          <Input id="bp-date" type="date" value={date} max={session.calendarToday} onChange={(e) => setDate(e.target.value)} className="h-10" />
        </Field>
        <Field label="银行流水号（可选）" htmlFor="bp-ref">
          <Input id="bp-ref" value={ref} maxLength={64} onChange={(e) => setRef(e.target.value)} className="num h-10" />
        </Field>
        {error && <Notice tone="error" title={error} className="sm:col-span-2" />}
      </div>
    </Dialog>
  );
}
