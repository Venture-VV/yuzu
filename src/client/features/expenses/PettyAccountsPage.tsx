// 部门备用金台账（v0.7.29 ERP 采购五项③，E3，docs/ERP_PURCHASING.md 第 4 节）。
// 看板：每个部门的定额、余额（在手 / 待补付）、待确认的报销、本月支出、没平与超期的笔数、建议补足；
// 台账：选一个部门和日期段，期初余额 + 每一笔（打款 +、支出 −、退回 −、补付 +）+ 每笔之后的余额 + 期末余额，导出 CSV。
// 余额与每日平账同一口径（各笔打款的未退回之和），待确认的报销不算。

import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, Download, HandCoins, Settings2 } from 'lucide-react';
import { CLAIM_STATUS_LABELS, PETTY_JOURNAL_LABELS, type PettyAccountRow, type PettyJournalKind } from '@shared/expenses';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { formatQty } from '@shared/quantity';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { monthRange, search, useHandlers, useInvalidateExpenses, usePettyAccounts, usePettyJournal } from './queries';

const KIND_TONE: Record<PettyJournalKind, string> = { advance: 'text-lake', expense: 'text-clay', return: 'text-ink-2', topup: 'text-pine' };

export function PettyAccountsPage() {
  const can = useCan();
  const accounts = usePettyAccounts();
  const [params, setParams] = useSearchParams();
  const deptId = Number(params.get('dept')) || null;
  const [editing, setEditing] = useState<PettyAccountRow | null>(null);
  const row = accounts.data?.find((a) => a.department.id === deptId) ?? null;

  return (
    <ErpPage
      title={row ? `${row.department.name} · 备用金台账` : '部门备用金台账'}
      description="余额 = 打款 − 已确认的支出 − 退回 + 补付（与每日平账同一口径，待确认的报销不算）。设了定额的部门显示建议补足。"
      actions={
        <div className="flex flex-wrap gap-2">
          {row ? (
            <Button variant="secondary" icon={<ArrowLeft className="size-4" />} onClick={() => setParams({}, { replace: true })} data-testid="petty-accounts-back">
              全部部门
            </Button>
          ) : (
            <Link to="/erp/petty">
              <Button variant="secondary" icon={<HandCoins className="size-4" />}>
                备用金与每日平账
              </Button>
            </Link>
          )}
          {row && can('petty.manage') && (
            <Button variant="secondary" icon={<Settings2 className="size-4" />} onClick={() => setEditing(row)} data-testid="petty-account-edit">
              保管人与定额
            </Button>
          )}
        </div>
      }
    >
      {accounts.isPending ? (
        <Skeleton className="h-64" />
      ) : accounts.error ? (
        <Notice tone="error" title={errorMessage(accounts.error)} />
      ) : row ? (
        <Journal row={row} />
      ) : accounts.data!.length === 0 ? (
        <EmptyState art="calm" title="还没有部门" description="先在库存的档案里建部门，再登记备用金打款。" />
      ) : (
        <Board rows={accounts.data!} onOpen={(id) => setParams({ dept: String(id) }, { replace: true })} onEdit={can('petty.manage') ? setEditing : undefined} />
      )}
      <AccountDialog row={editing} onClose={() => setEditing(null)} />
    </ErpPage>
  );
}

function Board({ rows, onOpen, onEdit }: { rows: PettyAccountRow[]; onOpen: (id: number) => void; onEdit?: (r: PettyAccountRow) => void }) {
  return (
    <Card className="overflow-hidden" data-testid="petty-accounts">
      <div className="hidden grid-cols-[minmax(0,1.2fr)_110px_120px_110px_110px_110px_120px] gap-x-3 border-b border-line px-4 py-2 text-[12px] font-semibold text-ink-3 lg:grid">
        <span>部门 · 保管人</span>
        <span className="text-right">定额</span>
        <span className="text-right">余额</span>
        <span className="text-right">待确认报销</span>
        <span className="text-right">本月支出</span>
        <span className="text-right">没平 / 超期</span>
        <span className="text-right">建议补足</span>
      </div>
      <ul className="divide-y divide-line/70">
        {rows.map((r) => (
          <li key={r.department.id} data-testid={`petty-account-${r.department.id}`}>
            <button
              type="button"
              onClick={() => onOpen(r.department.id)}
              className="grid w-full grid-cols-2 gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-paper-2 lg:grid-cols-[minmax(0,1.2fr)_110px_120px_110px_110px_110px_120px] lg:items-center"
            >
              <span className="col-span-2 min-w-0 lg:col-span-1">
                <span className="block truncate text-[14px] font-bold">
                  {r.department.name}
                  {!r.department.active && <span className="ml-1.5 text-[12px] font-normal text-ink-3">已停用</span>}
                </span>
                <span className="block truncate text-[12px] text-ink-3">
                  保管人 {r.custodian?.name ?? '未设'}
                  {r.lastDate && ` · 最近 ${r.lastDate}`}
                </span>
              </span>
              <span className="text-[12.5px] lg:text-right">
                <span className="text-ink-3 lg:hidden">定额 </span>
                {r.limitCents === null ? <span className="text-ink-3">未设</span> : <Money cents={r.limitCents} />}
              </span>
              <span className="text-[12.5px] lg:text-right">
                <span className="text-ink-3 lg:hidden">余额 </span>
                <Money cents={r.balanceCents} className={cn('font-bold', r.balanceCents < 0 && 'text-ember')} />
                {r.owedCents > 0 && <span className="block text-[11.5px] text-ember">待补付 ¥{formatAmount(r.owedCents)}</span>}
              </span>
              <span className="text-[12.5px] lg:text-right">
                <span className="text-ink-3 lg:hidden">待确认 </span>
                {r.pendingCents > 0 ? <Money cents={r.pendingCents} className="text-yuzu-deep" /> : <span className="text-ink-4">—</span>}
              </span>
              <span className="text-[12.5px] lg:text-right">
                <span className="text-ink-3 lg:hidden">本月支出 </span>
                <Money cents={r.monthSpentCents} />
              </span>
              <span className={cn('text-[12.5px] lg:text-right', r.overdue > 0 ? 'font-semibold text-clay' : 'text-ink-2')}>
                {r.openAdvances} 笔{r.overdue > 0 ? ` / 超期 ${r.overdue}` : ''}
              </span>
              <span className="text-[12.5px] lg:text-right" data-testid={`petty-topup-${r.department.id}`}>
                {r.topUpCents !== null ? <Money cents={r.topUpCents} className="font-bold text-lake" /> : <span className="text-ink-4">—</span>}
              </span>
            </button>
            {onEdit && (
              <div className="flex justify-end px-4 pb-2">
                <Button variant="ghost" size="sm" onClick={() => onEdit(r)} data-testid={`petty-account-edit-${r.department.id}`}>
                  保管人与定额
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Journal({ row }: { row: PettyAccountRow }) {
  const can = useCan();
  const session = useSession();
  const [range, setRange] = useState(() => monthRange(session.calendarToday));
  const journal = usePettyJournal(row.department.id, range.from, range.to);
  const j = journal.data;
  return (
    <div className="space-y-4" data-testid="petty-journal">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="余额（现在）" value={<Money cents={row.balanceCents} className="text-[18px] font-bold" />} />
        <Stat label="定额" value={row.limitCents === null ? '未设' : <Money cents={row.limitCents} className="text-[18px] font-bold" />} />
        <Stat label="建议补足" value={row.topUpCents === null ? '—' : <Money cents={row.topUpCents} className="text-[18px] font-bold text-lake" />} />
        <Stat label="保管人" value={row.custodian?.name ?? '未设'} />
      </div>
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
          从
          <Input type="date" fullWidth={false} value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="h-9 w-40" data-testid="journal-from" />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
          到
          <Input type="date" fullWidth={false} value={range.to} max={session.calendarToday} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="h-9 w-40" />
        </label>
        {j && (
          <p className="text-[13px] text-ink-2" data-testid="journal-summary">
            期初 <Money cents={j.openingCents} className="font-bold" /> · 进 <Money cents={j.inCents} className="font-bold text-lake" /> · 出{' '}
            <Money cents={j.outCents} className="font-bold text-clay" /> · 期末 <Money cents={j.closingCents} className="font-bold" />
          </p>
        )}
        {can('expense.export') && (
          <a className="ml-auto" href={`/api/erp/petty/accounts/${row.department.id}/journal/export?${search(range)}`} download>
            <Button variant="secondary" size="sm" icon={<Download className="size-4" />}>
              导出台账
            </Button>
          </a>
        )}
      </Card>
      {journal.isPending ? (
        <Skeleton className="h-48" />
      ) : journal.error ? (
        <Notice tone="error" title={errorMessage(journal.error)} />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line/70">
            <li className="flex items-center gap-3 bg-paper-2/60 px-4 py-2 text-[12.5px] font-semibold text-ink-2">
              <span className="flex-1">期初余额（{j!.from} 之前）</span>
              <Money cents={j!.openingCents} className="font-bold" />
            </li>
            {j!.entries.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-ink-3">这段时间没有进出</li>}
            {j!.entries.map((e) => (
              <li key={`${e.kind}-${e.refId}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5 md:grid-cols-[96px_minmax(0,1fr)_110px_120px]" data-testid={`journal-${e.docNo}`}>
                <span className="text-[12.5px]">
                  <span className="num block font-semibold">{e.date}</span>
                  <span className={cn('font-bold', KIND_TONE[e.kind])}>{PETTY_JOURNAL_LABELS[e.kind]}</span>
                </span>
                <span className="min-w-0 text-[12.5px]">
                  <span className="block truncate">
                    <Link
                      to={e.kind === 'expense' ? `/erp/expenses?claim=${e.refId}` : `/erp/petty?advance=${e.advanceId}`}
                      className="num font-semibold text-lake hover:underline"
                    >
                      {e.docNo}
                    </Link>
                    <span className="text-ink-3"> · {e.handler.name}</span>
                    {e.description && <span className="text-ink-2"> · {e.description}</span>}
                  </span>
                  {e.items.length > 0 && (
                    <span className="block text-ink-3">
                      {e.items.map((i) => `${i.name} ${formatQty(i.boughtMilli)}${i.unit} ¥${formatAmount(i.amountCents)}`).join('；')}
                    </span>
                  )}
                  {(e.channel || e.poNo) && (
                    <span className="block text-ink-3">
                      {e.channel}
                      {e.channel && e.poNo && ' · '}
                      {e.poNo && `采购单 ${e.poNo}`}
                    </span>
                  )}
                </span>
                <Money cents={e.deltaCents} className={cn('text-right font-bold', e.deltaCents < 0 ? 'text-clay' : 'text-lake')} />
                <span className="text-right text-[12.5px] text-ink-2">
                  余额 <Money cents={e.balanceCents} className="font-semibold" />
                </span>
              </li>
            ))}
            <li className="flex items-center gap-3 bg-paper-2/60 px-4 py-2 text-[12.5px] font-semibold text-ink-2">
              <span className="flex-1">期末余额（{j!.to}）</span>
              <span data-testid="journal-closing">
                <Money cents={j!.closingCents} className="font-bold" />
              </span>
            </li>
          </ul>
          {j!.truncated && <p className="border-t border-line px-4 py-2 text-[12px] text-ink-3">只显示前 3000 笔，期末余额按全部算；要看全部请缩短日期范围或导出</p>}
        </Card>
      )}
      {j && j.pending.length > 0 && (
        <Card className="p-4" data-testid="journal-pending">
          <p className="mb-2 text-[13px] font-bold">
            待确认的报销 <span className="font-normal text-ink-3">（确认后才算支出，不在上面的余额里）</span>
          </p>
          <ul className="space-y-1.5 text-[12.5px]">
            {j.pending.map((c) => (
              <li key={c.id} className="flex items-center gap-3">
                <Link to={`/erp/expenses?claim=${c.id}`} className="num font-semibold text-lake hover:underline">
                  {c.docNo}
                </Link>
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {c.expenseDate} · {c.handler.name} · {c.summary}
                </span>
                <Badge tone="yuzu">{CLAIM_STATUS_LABELS[c.status]}</Badge>
                <Money cents={c.amountCents} className="font-semibold" />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card className="p-3">
      <p className="text-[12px] font-semibold text-ink-3">{label}</p>
      <div className="mt-0.5 text-[15px] font-bold">{value}</div>
    </Card>
  );
}

/** 保管人与定额（petty.manage）：带版本号，别人刚改过的保存被拒，刷新后重填 */
function AccountDialog({ row, onClose }: { row: PettyAccountRow | null; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateExpenses();
  const handlers = useHandlers();
  const [custodianId, setCustodianId] = useState('');
  const [limit, setLimit] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(!!row, () => {
    setCustodianId(row?.custodian ? String(row.custodian.id) : '');
    setLimit(row?.limitCents ? centsToInput(row.limitCents) : '');
    setNote(row?.note ?? '');
    setError(null);
  });
  const limitCents = limit.trim() ? parseYuan(limit) : null;
  const save = async () => {
    if (!row) return;
    if (limit.trim() && (limitCents === null || limitCents <= 0)) return setError('定额要是大于 0 的金额，不设就留空');
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/erp/petty/accounts/${row.department.id}`, { custodianId: custodianId ? Number(custodianId) : null, limitCents, note: note.trim(), version: row.version });
      await invalidate();
      toast({ tone: 'success', title: '已保存', body: `${row.department.name}的保管人与定额` });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!row}
      onClose={busy ? () => {} : onClose}
      title={`${row?.department.name ?? ''} · 保管人与定额`}
      description="定额：这个部门平时手里留多少备用金；设了之后看板显示「建议补足」，打款超过定额时提示（不拦）"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()} data-testid="petty-account-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="保管人" htmlFor="pa-custodian">
          <Select id="pa-custodian" value={custodianId} onChange={(e) => setCustodianId(e.target.value)} data-testid="pa-custodian">
            <option value="">不设</option>
            {handlers.data?.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="定额" htmlFor="pa-limit" hint="留空 = 不设定额">
          <MoneyInput id="pa-limit" value={limit} onChange={(e) => setLimit(e.target.value)} className="h-10" data-testid="pa-limit" />
        </Field>
        <Field label="备注" htmlFor="pa-note" className="sm:col-span-2">
          <Input id="pa-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="可选" className="h-10" />
        </Field>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
