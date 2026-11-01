// 供应商对账（#23，v0.7.13）：月结的次月初对上个月的账、按批次的每批货到后对账；对完在系统里「登记已对账」。
// 登记带操作编号、提交前存本机（ERP 待确认类型「对账登记」），结果不明时在页面上方查回、重提或作废。

import { useState } from 'react';
import { CalendarCheck, CircleAlert, PackageCheck } from 'lucide-react';
import type { BatchReconItem, MonthlyReconItem, SupplierReconciliation } from '@shared/cycles';
import { formatAmount } from '@shared/money';
import { ApiError, api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Skeleton, Spinner } from '../../components/ui';
import { useInvalidateAll, useStatement } from '../purchasing/queries';
import { useReconciliationPages, useReconReminders } from '../cycles/queries';

/** 某月（YYYY-MM）的最后一天 */
function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
const md = (date: string) => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;
const monthLabel = (ym: string) => `${ym.slice(0, 4)} 年 ${Number(ym.slice(5, 7))} 月`;

type MonthTarget = { supplierId: number; supplierName: string; month: string };
type BatchTarget = { supplierId: number; supplierName: string; docs: BatchReconItem[] };

export function ReconView({ onStatement }: { onStatement: (supplierId: number, from: string, to: string) => void }) {
  const reminders = useReconReminders();
  const records = useReconciliationPages();
  const toast = useToast();
  const [monthTarget, setMonthTarget] = useState<MonthTarget | null>(null);
  const [batchTarget, setBatchTarget] = useState<BatchTarget | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [voiding, setVoiding] = useState<SupplierReconciliation | null>(null);
  // 提醒里「登记后有变动」的那条登记可能不在记录的第一页：按编号取来再撤销（v0.7.14）
  const revoke = async (reconId: number) => {
    try {
      setVoiding(await api.get<SupplierReconciliation>(`/api/payables/reconciliations/${reconId}`));
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };

  if (reminders.isPending) return <Skeleton className="h-64" />;
  if (reminders.error) return <Notice tone="error" title={errorMessage(reminders.error)} />;
  const r = reminders.data!;
  const monthlyItems = r.monthly.active ? r.monthly.items : r.monthly.items.filter((i) => i.state === 'changed');
  const pendingBatch = r.batch.filter((b) => b.state === 'pending');
  const changedBatch = r.batch.filter((b) => b.state === 'changed');
  const bySupplier = new Map<number, BatchReconItem[]>();
  for (const b of pendingBatch) bySupplier.set(b.supplierId, [...(bySupplier.get(b.supplierId) ?? []), b]);
  const toggle = (docId: number) => {
    const next = new Set(picked);
    if (next.has(docId)) next.delete(docId);
    else next.add(docId);
    setPicked(next);
  };

  return (
    <div className="space-y-6" data-testid="recon-view">
      {/* ── 月结 ── */}
      <section>
        <h2 className="mb-1 flex items-center gap-2 text-[15px] font-bold">
          <CalendarCheck className="size-4.5 text-pine" />
          月结：{monthLabel(r.monthly.month)}的账
        </h2>
        <p className="mb-3 text-[12.5px] text-ink-3">
          月结供应商次月初对上个月的账：{md(r.monthly.startDate)}起提醒，{md(r.monthly.dueDate)}起标红。上个月有往来或月底余额不为 0 的都要对；对完点「登记已对账」，系统记下当时对账单的数字。
        </p>
        {!r.monthly.active && monthlyItems.length === 0 ? (
          <Notice tone="info" title={`${md(r.monthly.startDate)}起提醒对 ${monthLabel(r.monthly.month)} 的账`} />
        ) : monthlyItems.length === 0 ? (
          <Notice tone="success" title={`${monthLabel(r.monthly.month)}的月结供应商都登记过对账了`} />
        ) : (
          <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card" data-testid="recon-monthly">
            {monthlyItems.map((i) => (
              <MonthlyRow
                key={i.supplierId}
                item={i}
                overdue={r.monthly.overdue}
                canRegister={r.canMonthly}
                onStatement={() => onStatement(i.supplierId, `${i.month}-01`, monthEnd(i.month))}
                onRegister={() => setMonthTarget({ supplierId: i.supplierId, supplierName: i.supplierName, month: i.month })}
                onRevoke={i.reconciliationId ? () => revoke(i.reconciliationId!) : undefined}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ── 按批次 ── */}
      <section>
        <h2 className="mb-1 flex items-center gap-2 text-[15px] font-bold">
          <PackageCheck className="size-4.5 text-pine" />
          按批次：待对账的收货单
        </h2>
        <p className="mb-3 text-[12.5px] text-ink-3">按批次结算的供应商每批货到后对一次账；收货后过了宽限天数标红。可以勾选同一供应商的几张一起登记。</p>
        {pendingBatch.length === 0 && changedBatch.length === 0 ? (
          <Notice tone="success" title="没有待对账的收货单" />
        ) : (
          <div className="space-y-3" data-testid="recon-batch">
            {[...bySupplier.entries()].map(([supplierId, docs]) => {
              const chosen = docs.filter((d) => picked.has(d.docId));
              return (
                <div key={supplierId} className="rounded-lg border border-line bg-card">
                  <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
                    <span className="font-bold">{docs[0]!.supplierName}</span>
                    <span className="num text-[12px] text-ink-3">{docs.length} 张待对账</span>
                    <span className="flex-1" />
                    {r.canBatch && (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={chosen.length === 0}
                        onClick={() => setBatchTarget({ supplierId, supplierName: docs[0]!.supplierName, docs: chosen })}
                        data-testid="recon-batch-register"
                      >
                        登记已对账{chosen.length ? `（${chosen.length} 张）` : ''}
                      </Button>
                    )}
                  </div>
                  <ul className="divide-y divide-line/70">
                    {docs.map((d) => (
                      <li key={d.docId} className="flex flex-wrap items-center gap-3 px-4 py-2 text-[13px]">
                        {r.canBatch && (
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--color-pine)]"
                            checked={picked.has(d.docId)}
                            onChange={() => toggle(d.docId)}
                            aria-label={`对账 ${d.docNo}`}
                          />
                        )}
                        <span className="num font-semibold">{d.docNo}</span>
                        <span className="num text-ink-3">{d.docDate}</span>
                        {d.overdue && <Badge tone="clay">超过 {md(d.dueDate)}</Badge>}
                        <span className="flex-1" />
                        <Money cents={d.amountCents} className="font-bold" />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {changedBatch.length > 0 && (
              <Notice tone="warning" title="登记对账以后，这些收货单被冲销了" icon={<CircleAlert className="size-5" />}>
                <p>撤销原登记，按现在的单据重新对账：</p>
                <ul className="mt-1 space-y-1" data-testid="recon-batch-changed">
                  {changedBatch.map((d) => (
                    <li key={d.docId} className="flex flex-wrap items-center gap-2">
                      <span>
                        {d.supplierName} {d.docNo}
                      </span>
                      {r.canBatch && d.reconciliationId && (
                        <Button size="sm" variant="ghost" onClick={() => revoke(d.reconciliationId!)}>
                          撤销登记
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>
        )}
      </section>

      {/* ── 对账记录 ── */}
      <section>
        <h2 className="mb-3 text-[15px] font-bold">对账记录</h2>
        {records.isPending ? (
          <Skeleton className="h-32" />
        ) : records.error ? (
          <Notice tone="error" title={errorMessage(records.error)} />
        ) : records.data!.pages.flat().length === 0 ? (
          <EmptyState art="leaf" title="还没有登记过对账" description="对完账后在上面「登记已对账」，这里会留下记录。" className="rounded-lg border border-dashed border-line-strong py-8" />
        ) : (
          <>
            <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card" data-testid="recon-records">
              {records.data!.pages.flat().map((x) => (
                <RecordRow key={x.id} rec={x} canVoid={x.kind === 'month' ? r.canMonthly : r.canBatch} onVoid={() => setVoiding(x)} />
              ))}
            </ul>
            {records.hasNextPage && (
              <div className="mt-2 flex justify-center">
                <Button size="sm" variant="ghost" loading={records.isFetchingNextPage} onClick={() => records.fetchNextPage()}>
                  加载更早的记录
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <MonthDialog target={monthTarget} onClose={() => setMonthTarget(null)} />
      <BatchDialog
        target={batchTarget}
        onClose={(done) => {
          if (done) setPicked(new Set());
          setBatchTarget(null);
        }}
      />
      <VoidDialog rec={voiding} onClose={() => setVoiding(null)} />
    </div>
  );
}

function MonthlyRow({
  item,
  overdue,
  canRegister,
  onStatement,
  onRegister,
  onRevoke,
}: {
  item: MonthlyReconItem;
  overdue: boolean;
  canRegister: boolean;
  onStatement: () => void;
  onRegister: () => void;
  /** 登记后有变动：撤销原登记（按编号取，不依赖记录列表的第一页） */
  onRevoke?: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
      <span className="num text-[12px] font-semibold text-ink-3">{item.supplierCode}</span>
      <span className="font-bold">{item.supplierName}</span>
      {item.state === 'changed' ? <Badge tone="yuzu">登记后有变动</Badge> : overdue ? <Badge tone="clay">已超过宽限</Badge> : <Badge>待对账</Badge>}
      <span className="flex-1" />
      <span className="text-[12px] text-ink-3">
        月底余额 <Money cents={item.endCents} className="font-bold text-ink" />
      </span>
      <Button size="sm" variant="ghost" onClick={onStatement}>
        看对账单
      </Button>
      {canRegister && item.state === 'pending' && (
        <Button size="sm" variant="primary" onClick={onRegister} data-testid={`recon-month-${item.supplierId}`}>
          登记已对账
        </Button>
      )}
      {canRegister && item.state === 'changed' && onRevoke && (
        <Button size="sm" variant="secondary" onClick={onRevoke}>
          撤销登记
        </Button>
      )}
    </li>
  );
}

function RecordRow({ rec, canVoid, onVoid }: { rec: SupplierReconciliation; canVoid: boolean; onVoid: () => void }) {
  return (
    <li className={cn('px-4 py-2.5 text-[13px]', rec.voided && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">{rec.supplierName}</span>
        <span>{rec.kind === 'month' ? `月结 ${monthLabel(rec.month!)}` : `按批次 ${rec.docs.length} 张`}</span>
        {rec.voided ? <Badge>已撤销</Badge> : rec.changed ? <Badge tone="yuzu">登记后有变动</Badge> : <Badge tone="pine">已对账</Badge>}
        <span className="flex-1" />
        <Money cents={rec.totalCents} className="font-bold" />
        {canVoid && !rec.voided && (
          <Button size="sm" variant="ghost" onClick={onVoid}>
            撤销
          </Button>
        )}
      </div>
      <p className="mt-0.5 text-[12px] text-ink-3">
        {rec.createdByName} · {formatDateTime(rec.createdAt)}
        {rec.kind === 'batch' && ` · ${rec.docs.map((d) => `${d.docNo}${d.status === 'voided' ? '（已冲销）' : ''}`).join('、')}`}
        {rec.note && ` · ${rec.note}`}
      </p>
      {rec.kind === 'month' && rec.changed && rec.snapshot && rec.current && (
        <p className="mt-0.5 text-[12px] text-yuzu-deep">
          登记时期末 ¥{formatAmount(rec.snapshot.endCents)}，现在 ¥{formatAmount(rec.current.endCents)}（收货 ¥{formatAmount(rec.snapshot.receivedCents)} → ¥{formatAmount(rec.current.receivedCents)}，付款 ¥
          {formatAmount(rec.snapshot.paidCents)} → ¥{formatAmount(rec.current.paidCents)}）
        </p>
      )}
      {rec.voided && (
        <p className="mt-0.5 text-[12px] text-ink-3">
          {rec.voided.byName} 撤销 · {formatDateTime(rec.voided.at)} · {rec.voided.reason}
        </p>
      )}
    </li>
  );
}

/** 提交对账登记：先存本机并读回核对（记不下就不发请求），结果不明的那一笔由页面上方按原编号处理 */
function useSubmitRecon() {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const pending = useErpPending(['supplier_recon']);
  const submit = async (body: Record<string, unknown> & { clientKey: string }, summary: string): Promise<'ok' | 'uncertain'> => {
    try {
      await sendErpOp({ key: body.clientKey, type: 'supplier_recon', url: '/api/payables/reconciliations', body, summary, staffName: session.staff.displayName });
      await invalidate();
      toast({ tone: 'success', title: '已登记对账', body: summary });
      return 'ok';
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '对账登记结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，不要重新填写。' });
        return 'uncertain';
      }
      throw e;
    }
  };
  return { submit, pending };
}

function MonthDialog({ target, onClose }: { target: MonthTarget | null; onClose: () => void }) {
  const { submit, pending } = useSubmitRecon();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<MonthTarget | null>(null);
  if (target !== last) {
    setLast(target);
    setNote('');
    setError(null);
  }
  const st = useStatement(target?.supplierId ?? null, target ? `${target.month}-01` : '', target ? monthEnd(target.month) : '');
  const save = async () => {
    if (!target) return;
    if (pending.length > 0) return setError('上一笔对账登记结果待确认：请先在页面上方查回、按原内容重新提交或作废');
    setBusy(true);
    setError(null);
    try {
      const body = { clientKey: uuid(), supplierId: target.supplierId, kind: 'month', month: target.month, note: note.trim() };
      await submit(body, `${target.supplierName} ${monthLabel(target.month)} 月结对账`);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!target}
      onClose={busy ? () => {} : onClose}
      title={target ? `登记已对账 · ${target.supplierName} ${monthLabel(target.month)}` : '登记已对账'}
      description="和供应商核对过这个月的对账单后登记；系统记下当时的数字，之后单据有变动会提示。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={pending.length > 0} onClick={save} data-testid="recon-month-submit">
            登记已对账
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {pending.length > 0 && <Notice tone="warning" title="上一笔对账登记结果待确认">请先在页面上方查回、按原内容重新提交或作废。</Notice>}
        {st.isPending ? (
          <Spinner />
        ) : st.data ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-line bg-paper-2/50 p-3 text-[13px] sm:grid-cols-3">
            <Num label="期初余额" cents={st.data.beginCents} />
            <Num label="收货货款" cents={st.data.receivedCents} />
            <Num label="退货扣款" cents={st.data.returnCreditCents} />
            <Num label="付款" cents={st.data.paidCents} />
            <Num label="供应商退款" cents={st.data.refundedCents} />
            <Num label="期末余额" cents={st.data.endCents} strong />
          </dl>
        ) : null}
        <Field label="备注" htmlFor="recon-note" hint="例如「与供应商核对一致」或差异说明">
          <Input id="recon-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function BatchDialog({ target, onClose }: { target: BatchTarget | null; onClose: (done: boolean) => void }) {
  const { submit, pending } = useSubmitRecon();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<BatchTarget | null>(null);
  if (target !== last) {
    setLast(target);
    setNote('');
    setError(null);
  }
  const total = (target?.docs ?? []).reduce((t, d) => t + d.amountCents, 0);
  const save = async () => {
    if (!target) return;
    if (pending.length > 0) return setError('上一笔对账登记结果待确认：请先在页面上方查回、按原内容重新提交或作废');
    setBusy(true);
    setError(null);
    try {
      const body = { clientKey: uuid(), supplierId: target.supplierId, kind: 'batch', docIds: target.docs.map((d) => d.docId), note: note.trim() };
      await submit(body, `${target.supplierName} 按批次对账 ${target.docs.map((d) => d.docNo).join('、')}`);
      onClose(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!target}
      onClose={busy ? () => {} : () => onClose(false)}
      title={target ? `登记已对账 · ${target.supplierName}` : '登记已对账'}
      description="这几张收货单已经和供应商核对过；系统记下每张当时的货款。"
      footer={
        <>
          <span className="mr-auto text-[13px] font-semibold text-ink-2">
            合计 <Money cents={total} className="font-bold" />
          </span>
          <Button variant="secondary" onClick={() => onClose(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={pending.length > 0} onClick={save} data-testid="recon-batch-submit">
            登记已对账
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {pending.length > 0 && <Notice tone="warning" title="上一笔对账登记结果待确认">请先在页面上方查回、按原内容重新提交或作废。</Notice>}
        <ul className="divide-y divide-line/70 rounded-lg border border-line">
          {(target?.docs ?? []).map((d) => (
            <li key={d.docId} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <span className="num font-semibold">{d.docNo}</span>
              <span className="num text-ink-3">{d.docDate}</span>
              <span className="flex-1" />
              <Money cents={d.amountCents} />
            </li>
          ))}
        </ul>
        <Field label="备注" htmlFor="recon-batch-note">
          <Input id="recon-batch-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 撤销对账登记（v0.7.14：与登记一样带操作编号、提交前存本机，结果不明时在页面上方查回、重提或作废） */
function VoidDialog({ rec, onClose }: { rec: SupplierReconciliation | null; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const pending = useErpPending(['supplier_recon_void']);
  const [busy, setBusy] = useState(false);
  return (
    <ReasonDialog
      open={!!rec}
      title={rec ? `撤销对账登记 · ${rec.supplierName}` : '撤销对账登记'}
      description="撤销后这次登记作废（留记录），可以按现在的单据重新登记。"
      confirmLabel="撤销登记"
      danger
      busy={busy}
      extra={pending.length > 0 ? <Notice tone="warning" title="上一笔撤销结果待确认">请先在页面上方查回、按原内容重新提交或作废。</Notice> : undefined}
      onClose={onClose}
      onConfirm={async (reason) => {
        if (!rec) return;
        if (pending.length > 0) {
          toast({ tone: 'error', title: '上一笔撤销结果待确认：请先在页面上方查回、按原内容重新提交或作废' });
          return;
        }
        setBusy(true);
        try {
          const body = { clientKey: uuid(), reason };
          await sendErpOp({
            key: body.clientKey,
            type: 'supplier_recon_void',
            url: `/api/payables/reconciliations/${rec.id}/void`,
            body,
            summary: `撤销 ${rec.supplierName} ${rec.kind === 'month' ? `${monthLabel(rec.month!)}月结对账` : `按批次对账 ${rec.docs.map((d) => d.docNo).join('、')}`}`,
            staffName: session.staff.displayName,
          });
          await invalidate();
          toast({ tone: 'success', title: '已撤销对账登记' });
          onClose();
        } catch (e) {
          if (e instanceof UncertainError) {
            toast({ tone: 'info', title: '撤销结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，不要重新填写。' });
            onClose();
          } else toast({ tone: 'error', title: e instanceof ApiError ? e.message : errorMessage(e) });
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

function Num({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className={cn('num', strong && 'font-bold')}>¥{formatAmount(cents)}</dd>
    </div>
  );
}
