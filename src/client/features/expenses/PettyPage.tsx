// 备用金与每日平账（v0.7.7，飞书需求 RQ-005；D14 按部门、经办人留名）。
// 每笔打款单独平账，只算已确认的报销：应退回 = 打款 − 支出；实际退回 = 退回 − 补付；未退回 = 应退回 − 实际退回。
// 每日平账按付款日（打款日期）与部门汇总，当天有一笔没平就整天标出来。

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { BookOpenCheck, CircleAlert, Download, HandCoins, Plus, ReceiptText, Undo2, X } from 'lucide-react';
import {
  CLAIM_STATUS_LABELS,
  SETTLEMENT_KIND_LABELS,
  type PettyAdvance,
  type PettyBalance,
  type SettlementKind,
} from '@shared/expenses';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { PAY_METHOD_LABELS, PAYMENT_METHODS, type PayMethod } from '@shared/purchasing';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { Dialog, Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { useDepartments } from '../inventory/queries';
import { search, useAdvance, useExpenseRules, useHandlers, useInvalidateExpenses, usePettyDaily } from './queries';

export const STATE_LABELS: Record<PettyBalance['state'], string> = { settled: '已平', open: '未退回', overdue: '超期未退', owed: '待补付' };
const STATE_TONE: Record<PettyBalance['state'], 'pine' | 'yuzu' | 'clay' | 'ember'> = { settled: 'pine', open: 'yuzu', overdue: 'clay', owed: 'ember' };

const minusDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export function PettyPage() {
  const can = useCan();
  const session = useSession();
  const rules = useExpenseRules();
  const departments = useDepartments();
  const handlers = useHandlers();
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useState(() => ({ from: minusDays(session.calendarToday, 13), to: session.calendarToday }));
  const [departmentId, setDepartmentId] = useState('');
  const [handlerId, setHandlerId] = useState('');
  const [newAdvance, setNewAdvance] = useState(false);
  const filters = { from: range.from, to: range.to, departmentId: departmentId || undefined, handlerId: handlerId || undefined };
  const daily = usePettyDaily(filters, range.from <= range.to);
  const openId = Number(params.get('advance')) || null;
  const open = (id: number | null) => setParams(id ? { advance: String(id) } : {}, { replace: true });
  const d = daily.data;

  return (
    <ErpPage
      title="备用金与每日平账"
      description={`按部门记账、经办人留名。每笔打款单独平账，只算已确认的报销；从打款日起超过 ${rules.data?.overdueDays ?? 7} 天没平的标红。`}
      actions={
        <div className="flex flex-wrap gap-2">
          <Link to="/erp/expenses">
            <Button variant="secondary" icon={<ReceiptText className="size-4" />}>
              费用报销
            </Button>
          </Link>
          <Link to="/erp/ledger">
            <Button variant="secondary" icon={<BookOpenCheck className="size-4" />}>
              采购台账
            </Button>
          </Link>
          {can('expense.export') && (
            <a href={`/api/erp/petty/daily/export?${search(filters)}`} download>
              <Button variant="secondary" icon={<Download className="size-4" />}>
                导出平账
              </Button>
            </a>
          )}
          {can('petty.manage') && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewAdvance(true)} data-testid="advance-new">
              登记打款
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4" data-testid="petty-page">
        <ErpPendingPanel types={['petty_advance', 'petty_settlement']} onFound={(_, ref) => open(ref.advanceId ?? ref.refId)} />
        {d && d.openByDepartment.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="petty-open">
            {d.openByDepartment.map((o) => (
              <Card key={o.department.id} className={cn('p-4', o.overdue > 0 && 'border-clay/50')}>
                <p className="text-[13px] font-bold">{o.department.name}</p>
                <p className="mt-1 text-[12.5px] text-ink-2">
                  经办人手里未退回 <Money cents={o.outstandingCents} className="font-bold" />
                  {o.owedCents > 0 && (
                    <>
                      {' '}
                      · 待补付 <Money cents={o.owedCents} className="font-bold" />
                    </>
                  )}
                </p>
                <p className={cn('text-[12px]', o.overdue > 0 ? 'font-semibold text-clay' : 'text-ink-3')}>
                  {o.open} 笔没平{o.overdue > 0 ? `，其中 ${o.overdue} 笔超期` : ''}
                </p>
              </Card>
            ))}
          </div>
        )}
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
            付款日 从
            <Input type="date" fullWidth={false} value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="h-9 w-40" />
          </label>
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
            到
            <Input type="date" fullWidth={false} value={range.to} max={session.calendarToday} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="h-9 w-40" />
          </label>
          <Select fullWidth={false} aria-label="部门" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="h-9 w-36">
            <option value="">全部部门</option>
            {departments.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
          <Select fullWidth={false} aria-label="经办人" value={handlerId} onChange={(e) => setHandlerId(e.target.value)} className="h-9 w-36">
            <option value="">全部经办人</option>
            {handlers.data?.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </Select>
        </Card>

        {daily.isPending ? (
          <Skeleton className="h-64" />
        ) : daily.error ? (
          <Notice tone="error" title={errorMessage(daily.error)} />
        ) : d!.rows.length === 0 ? (
          <EmptyState art="calm" title="这段时间没有打款" />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]" data-testid="petty-daily">
              <thead className="bg-paper-2 text-[12px] text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">付款日 / 部门</th>
                  <th className="px-3 py-2 text-left font-semibold">打款单 · 经办人</th>
                  <th className="px-3 py-2 text-right font-semibold">打款</th>
                  <th className="px-3 py-2 text-right font-semibold">支出</th>
                  <th className="px-3 py-2 text-right font-semibold">应退回</th>
                  <th className="px-3 py-2 text-right font-semibold">实际退回</th>
                  <th className="px-3 py-2 text-right font-semibold">未退回</th>
                  <th className="px-3 py-2 text-left font-semibold">状态</th>
                </tr>
              </thead>
              <tbody>
                {d!.rows.map((r) => (
                  <DailyRows key={`${r.date}-${r.department.id}`} row={r} onOpen={open} />
                ))}
              </tbody>
              <tfoot className="border-t-2 border-line bg-paper-2 font-bold">
                <tr>
                  <td className="px-3 py-2" colSpan={2}>
                    合计
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={d!.totals.advanceCents} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={d!.totals.spentCents} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={d!.totals.dueCents} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={d!.totals.settledCents} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={d!.totals.outstandingCents} />
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </Card>
        )}
      </div>
      <AdvanceSheet id={openId} onClose={() => open(null)} />
      <AdvanceDialog open={newAdvance} onClose={() => setNewAdvance(false)} onDone={(id) => open(id)} />
    </ErpPage>
  );
}

function DailyRows({ row, onOpen }: { row: NonNullable<ReturnType<typeof usePettyDaily>['data']>['rows'][number]; onOpen: (id: number) => void }) {
  return (
    <>
      {row.advances.map((a, i) => (
        <tr key={a.id} className="cursor-pointer border-t border-line/70 hover:bg-paper-2" onClick={() => onOpen(a.id)} data-testid={`advance-row-${a.id}`}>
          <td className="px-3 py-2">
            {i === 0 && (
              <>
                <span className="num font-semibold">{row.date}</span>
                <span className="block text-[12px] text-ink-3">{row.department.name}</span>
              </>
            )}
          </td>
          <td className="px-3 py-2">
            <span className="num font-semibold">{a.docNo}</span>
            <span className="block text-[12px] text-ink-3">{a.handler.name}</span>
          </td>
          <td className="px-3 py-2 text-right">
            <Money cents={a.advanceCents} />
          </td>
          <td className="px-3 py-2 text-right">
            <Money cents={a.spentCents} />
            {a.pendingCents > 0 && <span className="block text-[11px] text-yuzu-deep">待确认 ¥{formatAmount(a.pendingCents)}</span>}
          </td>
          <td className="px-3 py-2 text-right">
            <Money cents={a.dueCents} />
          </td>
          <td className="px-3 py-2 text-right">
            <Money cents={a.settledCents} />
          </td>
          <td className={cn('px-3 py-2 text-right font-bold', a.outstandingCents !== 0 && 'text-clay')}>
            <Money cents={a.outstandingCents} />
          </td>
          <td className="px-3 py-2">
            <Badge tone={STATE_TONE[a.state]}>{STATE_LABELS[a.state]}</Badge>
            {a.state === 'overdue' && <span className="block text-[11px] text-clay">{a.ageDays} 天</span>}
          </td>
        </tr>
      ))}
      {row.advances.length > 1 && (
        <tr className="border-t border-line/40 bg-paper-2/60 text-[12.5px]">
          <td className="px-3 py-1.5 text-ink-3" colSpan={2}>
            当日合计
          </td>
          <td className="px-3 py-1.5 text-right">
            <Money cents={row.advanceCents} />
          </td>
          <td className="px-3 py-1.5 text-right">
            <Money cents={row.spentCents} />
          </td>
          <td className="px-3 py-1.5 text-right">
            <Money cents={row.dueCents} />
          </td>
          <td className="px-3 py-1.5 text-right">
            <Money cents={row.settledCents} />
          </td>
          <td className="px-3 py-1.5 text-right font-bold">
            <Money cents={row.outstandingCents} />
          </td>
          <td className="px-3 py-1.5">
            <Badge tone={STATE_TONE[row.state]}>{STATE_LABELS[row.state]}</Badge>
          </td>
        </tr>
      )}
    </>
  );
}

function AdvanceSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const can = useCan();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateExpenses();
  const adv = useAdvance(id);
  const [settleKind, setSettleKind] = useState<SettlementKind | null>(null);
  const [voidTarget, setVoidTarget] = useState<{ kind: 'advance' } | { kind: 'settlement'; id: number; docNo: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = adv.data;

  const doVoid = async (reason: string) => {
    if (!a || !voidTarget) return;
    setBusy(true);
    setError(null);
    try {
      const url = voidTarget.kind === 'advance' ? `/api/erp/petty/advances/${a.id}/void` : `/api/erp/petty/settlements/${voidTarget.id}/void`;
      await api.post<PettyAdvance>(url, { reason });
      await invalidate();
      setVoidTarget(null);
      toast({ tone: 'success', title: '已冲销' });
    } catch (e) {
      setError(errorMessage(e));
      setVoidTarget(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={!!id} onClose={onClose} label="打款与平账" width="w-[min(560px,100vw)]">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex size-8 items-center justify-center rounded-full bg-lake-soft text-lake">
          <HandCoins className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="num text-[16px] font-bold">{a?.docNo ?? '打款'}</p>
          {a && (
            <p className="text-[12.5px] text-ink-3">
              {a.advanceDate} · {a.department.name} · 经办人 {a.handler.name} · {PAY_METHOD_LABELS[a.method]} {a.evidence}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-ink-3 hover:bg-paper-2" aria-label="关闭">
          <X className="size-5" />
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" data-testid="advance-sheet">
        {!a ? (
          adv.error ? <Notice tone="error" title={errorMessage(adv.error)} /> : <Skeleton className="h-64" />
        ) : (
          <>
            {a.status === 'voided' && <Notice tone="error" title={`已冲销：${a.voidReason}（${a.voidedByName}）`} />}
            <div className="grid grid-cols-3 gap-2 text-center" data-testid="advance-balance">
              {[
                ['打款', a.advanceCents],
                ['支出（已确认）', a.spentCents],
                ['应退回', a.dueCents],
                ['实际退回', a.settledCents],
                ['未退回', a.outstandingCents],
              ].map(([label, cents]) => (
                <div key={label as string} className="rounded-lg border border-line bg-card px-2 py-2">
                  <p className="text-[11.5px] text-ink-3">{label}</p>
                  <Money cents={cents as number} className="font-bold" />
                </div>
              ))}
              <div className="flex flex-col items-center justify-center rounded-lg border border-line bg-card px-2 py-2">
                <Badge tone={STATE_TONE[a.state]}>{STATE_LABELS[a.state]}</Badge>
                <p className="mt-0.5 text-[11px] text-ink-3">{a.ageDays} 天</p>
              </div>
            </div>
            {a.pendingCents > 0 && <Notice tone="warning" title={`还有待确认的报销 ¥${formatAmount(a.pendingCents)}，确认后才算进支出`} />}
            <section>
              <h3 className="mb-1.5 text-[13px] font-bold">用这笔钱的报销</h3>
              {a.claims.length === 0 ? (
                <p className="text-[12.5px] text-ink-3">还没有</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {a.claims.map((c) => (
                    <li key={c.id}>
                      <Link to={`/erp/expenses?claim=${c.id}`} className="flex items-center gap-3 px-3 py-2 text-[13px] hover:bg-paper-2">
                        <span className="num font-semibold">{c.docNo}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-2">{c.summary}</span>
                        <span className={cn('text-[12px]', c.status === 'confirmed' ? 'text-pine' : 'text-ink-3')}>{CLAIM_STATUS_LABELS[c.status]}</span>
                        <Money cents={c.amountCents} className="font-bold" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="mb-1.5 text-[13px] font-bold">退回与补付</h3>
              {a.settlements.length === 0 ? (
                <p className="text-[12.5px] text-ink-3">还没有</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {a.settlements.map((s) => (
                    <li key={s.id} className={cn('flex items-center gap-3 px-3 py-2 text-[13px]', s.status === 'voided' && 'opacity-55')}>
                      <span className="num font-semibold">{s.docNo}</span>
                      <span className="min-w-0 flex-1 truncate text-ink-2">
                        {SETTLEMENT_KIND_LABELS[s.kind]} · {s.settleDate} · {PAY_METHOD_LABELS[s.method]} {s.evidence}
                        {s.status === 'voided' && ` · 已冲销：${s.voidReason}`}
                      </span>
                      <Money cents={s.amountCents} className="font-bold" />
                      {s.status === 'active' && can('finance.void') && (
                        <Button variant="ghost" size="sm" icon={<Undo2 className="size-3.5" />} onClick={() => setVoidTarget({ kind: 'settlement', id: s.id, docNo: s.docNo })} aria-label={`冲销 ${s.docNo}`} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p className="text-[12px] text-ink-3">
              登记 {a.createdByName} {formatDateTime(a.createdAt)}
              {a.note && ` · ${a.note}`}
            </p>
            {error && <Notice tone="error" title={error} icon={<CircleAlert className="size-5" />} />}
          </>
        )}
      </div>
      {a && a.status === 'active' && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
          {can('finance.void') && (
            <Button variant="ghost" disabled={busy} onClick={() => setVoidTarget({ kind: 'advance' })}>
              冲销打款
            </Button>
          )}
          {can('expense.manage') && (
            <Button variant="secondary" onClick={() => navigate(`/erp/expenses/new?advance=${a.id}&department=${a.department.id}`)}>
              用这笔钱登记报销
            </Button>
          )}
          {can('petty.manage') && a.outstandingCents < 0 && (
            <Button variant="primary" onClick={() => setSettleKind('topup')} data-testid="advance-topup">
              登记补付
            </Button>
          )}
          {can('petty.manage') && a.outstandingCents > 0 && (
            <Button variant="primary" onClick={() => setSettleKind('return')} data-testid="advance-return">
              登记退回
            </Button>
          )}
        </div>
      )}
      {a && <SettlementDialog advance={a} kind={settleKind} onClose={() => setSettleKind(null)} />}
      <ReasonDialog
        open={voidTarget !== null}
        title={voidTarget?.kind === 'settlement' ? `冲销 ${voidTarget.docNo}` : `冲销打款 ${a?.docNo ?? ''}`}
        description={voidTarget?.kind === 'advance' ? '下面还有有效的报销或退回补付时不能冲销，先撤回或冲销它们。' : '冲销后这笔退回 / 补付不再算进平账。'}
        confirmLabel="冲销"
        danger
        busy={busy}
        onClose={() => setVoidTarget(null)}
        onConfirm={(reason) => void doVoid(reason)}
      />
    </Sheet>
  );
}

/** 登记打款：公司把钱打给某部门的经办人（D14：按部门记账，经办人留名） */
function AdvanceDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: number) => void }) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateExpenses();
  const departments = useDepartments();
  const handlers = useHandlers();
  const [departmentId, setDepartmentId] = useState('');
  const [handlerId, setHandlerId] = useState('');
  const [date, setDate] = useState(session.calendarToday);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PayMethod>('wechat');
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useErpPending(['petty_advance']);
  useResetOnOpen(open, () => {
    setDepartmentId('');
    setHandlerId('');
    setDate(session.calendarToday);
    setAmount('');
    setMethod('wechat');
    setEvidence('');
    setNote('');
    setError(null);
  });
  const cents = amount.trim() ? parseYuan(amount) : null;
  const blocking = pending.length > 0
    ? '上一笔打款结果待确认，请先在页面顶部查回、重新提交或作废'
    : !departmentId ? '请选择部门' : !handlerId ? '请选择经办人' : !cents || cents <= 0 ? '请填写打款金额' : evidence.trim().length < 2 ? '请填写凭据说明' : null;
  const locked = busy;

  // 每次提交用新的操作编号；结果不明的那一笔存在本机，由页面顶部按原编号处理
  const send = async () => {
    if (blocking || cents === null) return;
    const body = { clientKey: uuid(), departmentId: Number(departmentId), handlerId: Number(handlerId), advanceDate: date, amountCents: cents, method, evidence: evidence.trim(), note: note.trim() };
    const deptName = departments.data?.find((d) => d.id === Number(departmentId))?.name ?? '';
    const handlerName = handlers.data?.find((h) => h.id === Number(handlerId))?.name ?? '';
    setBusy(true);
    setError(null);
    try {
      const r = await sendErpOp<{ advance: PettyAdvance }>({
        key: body.clientKey,
        type: 'petty_advance',
        url: '/api/erp/petty/advances',
        body,
        summary: `${deptName} · ${handlerName} · 打款 ¥${formatAmount(cents)}`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      toast({ tone: 'success', title: '打款已登记', body: `${r.advance.docNo} · ¥${formatAmount(r.advance.advanceCents)}` });
      onClose();
      onDone(r.advance.id);
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '打款结果待确认', body: '已记在本机：请在页面顶部查回、按原内容重新提交或作废。' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="登记打款"
      description="公司把备用金打给某个部门的经办人；按部门平账，经办人个人经手的金额可以单独查"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!!blocking || locked}
            loading={busy}
            onClick={() => void send()}
            data-testid="advance-submit"
          >
            登记打款
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="部门" htmlFor="adv-dept">
          <Select id="adv-dept" value={departmentId} disabled={locked} onChange={(e) => setDepartmentId(e.target.value)} data-testid="adv-dept">
            <option value="">选择部门</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="经办人（拿钱去采购的人）" htmlFor="adv-handler">
          <Select id="adv-handler" value={handlerId} disabled={locked} onChange={(e) => setHandlerId(e.target.value)} data-testid="adv-handler">
            <option value="">选择经办人</option>
            {handlers.data?.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="打款日期" htmlFor="adv-date">
          <Input id="adv-date" type="date" value={date} max={session.calendarToday} disabled={locked} onChange={(e) => setDate(e.target.value)} className="h-10" />
        </Field>
        <Field label="金额" htmlFor="adv-amount">
          <MoneyInput id="adv-amount" value={amount} disabled={locked} onChange={(e) => setAmount(e.target.value)} className="h-10" data-testid="adv-amount" />
        </Field>
        <Field label="方式" htmlFor="adv-method">
          <Select id="adv-method" value={method} disabled={locked} onChange={(e) => setMethod(e.target.value as PayMethod)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAY_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="凭据说明" htmlFor="adv-ev" hint="如转账流水号后四位">
          <Input id="adv-ev" value={evidence} maxLength={200} disabled={locked} onChange={(e) => setEvidence(e.target.value)} className="h-10" data-testid="adv-evidence" />
        </Field>
        <Field label="备注" htmlFor="adv-note" className="sm:col-span-2">
          <Input id="adv-note" value={note} maxLength={200} disabled={locked} onChange={(e) => setNote(e.target.value)} placeholder="可选" className="h-10" />
        </Field>
      </div>
      {blocking && !locked && <p className="mt-3 text-[12.5px] font-semibold text-clay">{blocking}</p>}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

/** 登记退回（经办人退给公司）/ 补付（公司补给经办人）：退回不超过未退回，补付不超过待补付 */
function SettlementDialog({ advance, kind, onClose }: { advance: PettyAdvance; kind: SettlementKind | null; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateExpenses();
  const max = kind === 'topup' ? -advance.outstandingCents : advance.outstandingCents;
  const [date, setDate] = useState(session.calendarToday);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PayMethod>('cash');
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useErpPending(['petty_settlement']);
  useResetOnOpen(kind !== null, () => {
    setDate(session.calendarToday);
    setAmount(max > 0 ? centsToInput(max) : '');
    setMethod('cash');
    setEvidence('');
    setNote('');
    setError(null);
  });
  const cents = amount.trim() ? parseYuan(amount) : null;
  const label = kind ? SETTLEMENT_KIND_LABELS[kind] : '';
  const blocking = pending.length > 0
    ? '上一笔退回 / 补付结果待确认，请先在页面顶部查回、重新提交或作废'
    : !cents || cents <= 0 ? '请填写金额' : cents > max ? `最多 ¥${formatAmount(max)}` : evidence.trim().length < 2 ? '请填写凭据说明' : date < advance.advanceDate ? `日期不能早于打款日期 ${advance.advanceDate}` : null;
  const locked = busy;

  // 每次提交用新的操作编号；结果不明的那一笔存在本机，由页面顶部按原编号处理
  const send = async () => {
    if (blocking || cents === null || !kind) return;
    const body = { clientKey: uuid(), advanceId: advance.id, kind, settleDate: date, amountCents: cents, method, evidence: evidence.trim(), note: note.trim() };
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key: body.clientKey,
        type: 'petty_settlement',
        url: '/api/erp/petty/settlements',
        body,
        summary: `${advance.docNo} · ${label} ¥${formatAmount(cents)}`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      toast({ tone: 'success', title: `${label}已登记` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: `${label}结果待确认`, body: '已记在本机：请在页面顶部查回、按原内容重新提交或作废。' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={kind !== null}
      onClose={busy ? () => {} : onClose}
      title={`登记${label} · ${advance.docNo}`}
      description={kind === 'topup' ? `经办人垫了 ¥${formatAmount(max)}，公司补给经办人` : `经办人手里还有 ¥${formatAmount(max)} 没退回`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!!blocking || locked}
            loading={busy}
            onClick={() => void send()}
            data-testid="settle-submit"
          >
            登记{label}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="日期" htmlFor="st-date">
          <Input id="st-date" type="date" value={date} min={advance.advanceDate} max={session.calendarToday} disabled={locked} onChange={(e) => setDate(e.target.value)} className="h-10" />
        </Field>
        <Field label="金额" htmlFor="st-amount">
          <MoneyInput id="st-amount" value={amount} disabled={locked} onChange={(e) => setAmount(e.target.value)} className="h-10" data-testid="settle-amount" />
        </Field>
        <Field label="方式" htmlFor="st-method">
          <Select id="st-method" value={method} disabled={locked} onChange={(e) => setMethod(e.target.value as PayMethod)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAY_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="凭据说明" htmlFor="st-ev" hint="如转账流水号后四位、现金当面点清">
          <Input id="st-ev" value={evidence} maxLength={200} disabled={locked} onChange={(e) => setEvidence(e.target.value)} className="h-10" data-testid="settle-evidence" />
        </Field>
        <Field label="备注" htmlFor="st-note" className="sm:col-span-2">
          <Input id="st-note" value={note} maxLength={200} disabled={locked} onChange={(e) => setNote(e.target.value)} placeholder="可选" className="h-10" />
        </Field>
      </div>
      {blocking && !locked && <p className="mt-3 text-[12.5px] font-semibold text-clay">{blocking}</p>}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
