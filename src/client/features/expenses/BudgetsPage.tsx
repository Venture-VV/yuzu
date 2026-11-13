// 费用预算（8.0.3，docs/BUDGET_INVOICES.md 第 2 节，默认 BI01–BI06 待确认）：按月看「部门 × 费用科目」的额度与已占用；
// 额度从某月起生效、之后每月沿用，直到下一次修改；没设的格子不控制。达到黄灯百分比（默认 80%）黄灯，超过 100% 红灯；
// 登记报销超了的不拦，走审批中心的「超预算报销」（多一级店主）。能「设定费用预算」的人（默认只有店主）在这里改额度。
// 改额度时按点「改额度」那一刻的额度做底（snap）：改的过程中页面刷新不影响，保存时只送改了的格子、带上那一刻的额度核对
// （Codex 自动审查 c2c4a12：原来按刷新后的额度比对、送刷新后的额度，会把别人刚改的格子悄悄改回去）。

import { ExpenseTabs } from './ExpenseTabs';
import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, PencilLine, Save, X } from 'lucide-react';
import { BUDGET_LEVEL_LABELS, type BudgetCell, type BudgetGrid, type BudgetLevel, type BudgetSaveCell } from '@shared/budgets';
import type { ExpenseCategory } from '@shared/expenses';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, MoneyInput, Notice, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { useBudgetGrid, useInvalidateExpenses } from './queries';

const LEVEL_TONE: Record<BudgetLevel, 'neutral' | 'pine' | 'yuzu' | 'clay'> = { none: 'neutral', ok: 'pine', warn: 'yuzu', over: 'clay' };
const BAR: Record<BudgetLevel, string> = { none: 'bg-line', ok: 'bg-pine', warn: 'bg-yuzu', over: 'bg-clay' };
const cellKey = (departmentId: number, category: ExpenseCategory) => `${departmentId}:${category}`;

export function BudgetsPage() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateExpenses();
  const [month, setMonth] = useState(session.calendarToday.slice(0, 7));
  const grid = useBudgetGrid(month);
  const [editing, setEditing] = useState(false);
  // 开始改时的额度：改的过程中按它显示、比对与核对，期间的刷新不影响
  const [snap, setSnap] = useState<BudgetGrid | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = can('budget.manage');

  const startEdit = (g: BudgetGrid) => {
    setSnap(g);
    setDraft(Object.fromEntries(g.rows.flatMap((r) => r.cells.map((c) => [cellKey(r.departmentId, c.category), c.budgetCents === null ? '' : centsToInput(c.budgetCents)]))));
    setError(null);
    setEditing(true);
  };
  const stopEdit = () => {
    setEditing(false);
    setSnap(null);
  };

  /** 改了的格子（空 = 不控制，与开始改时的额度比）；格式不对的返回错误 */
  const changes = (g: BudgetGrid): { cells: BudgetSaveCell[]; problem: string | null } => {
    const cells: BudgetSaveCell[] = [];
    for (const r of g.rows) {
      for (const c of r.cells) {
        const text = (draft[cellKey(r.departmentId, c.category)] ?? '').trim();
        const cents = text ? parseYuan(text) : null;
        if (text && (cents === null || cents < 0)) return { cells: [], problem: `${r.departmentName}的额度格式不对` };
        if (cents !== c.budgetCents) cells.push({ departmentId: r.departmentId, category: c.category, amountCents: cents, seenCents: c.budgetCents });
      }
    }
    return { cells, problem: null };
  };

  const save = async () => {
    if (!snap) return;
    const { cells, problem } = changes(snap);
    if (problem) return setError(problem);
    if (cells.length === 0) return stopEdit();
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ changed: number }>('/api/erp/expenses/budgets', { month: snap.month, cells });
      await invalidate();
      toast({ tone: 'success', title: `已保存 ${r.changed} 格额度`, body: `从 ${snap.month} 起生效，之后的月份没另设的都沿用` });
      stopEdit();
    } catch (e) {
      // 别人刚改过：退出编辑、按最新的额度重新打开再改（不拿刷新后的额度当底，免得把别人的修改改回去）
      if (e instanceof ApiError && e.code === 'BUDGET_CHANGED') {
        setError(`${errorMessage(e)}（页面已刷新）`);
        stopEdit();
        await invalidate();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const shown = editing && snap ? snap : grid.data;

  return (
    <ErpPage
      tabs={<ExpenseTabs active="budgets" />}
      title="费用预算"
      description="部门 × 费用科目的月度额度：从某月起生效、之后每月沿用。已占用 = 待确认、已退回、已确认的报销（撤回、冲销的不算）。超了不拦报销，要多一级店主审批。"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/erp/expenses">
            <Button variant="secondary" icon={<ArrowLeft className="size-4" />}>
              费用报销
            </Button>
          </Link>
          <Input type="month" fullWidth={false} value={month} disabled={editing} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-10 w-40" aria-label="月份" data-testid="budget-month" />
          {canManage && grid.data && !grid.isPlaceholderData && !editing && (
            <Button variant="primary" icon={<PencilLine className="size-4" />} onClick={() => startEdit(grid.data!)} data-testid="budget-edit">
              改额度
            </Button>
          )}
          {editing && snap && (
            <>
              <Button variant="secondary" icon={<X className="size-4" />} disabled={busy} onClick={stopEdit}>
                取消
              </Button>
              <Button variant="primary" icon={<Save className="size-4" />} loading={busy} onClick={() => void save()} data-testid="budget-save">
                保存
              </Button>
            </>
          )}
        </div>
      }
    >
      {grid.isPending ? (
        <Skeleton className="h-64" />
      ) : grid.error ? (
        <Notice tone="error" title={errorMessage(grid.error)} />
      ) : shown!.rows.length === 0 ? (
        <EmptyState art="calm" title="还没有部门" description="先在库存的档案里建部门，再按部门设预算。" />
      ) : (
        <div className="space-y-3" data-testid="budgets-page">
          {editing && (
            <Notice tone="info" title={`改的是从 ${snap?.month ?? month} 起的额度：以后没另设的月份都沿用；清空 = 从这个月起不控制`}>
              <span className="text-[12.5px]">只保存你改了的格子，并核对你点「改额度」时看到的额度：别人刚改过会提示、刷新后请重新改。</span>
            </Notice>
          )}
          {error && <Notice tone="error" title={error} />}
          <Legend warnPercent={shown!.warnPercent} />
          <Card className="overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,1fr)_repeat(4,minmax(0,1.15fr))] gap-x-3 border-b border-line px-4 py-2 text-[12px] font-semibold text-ink-3 lg:grid">
              <span>部门</span>
              {shown!.categories.map((c) => (
                <span key={c.key}>{c.label}</span>
              ))}
            </div>
            <ul className="divide-y divide-line/70">
              {shown!.rows.map((r) => (
                <li key={r.departmentId} className="grid gap-x-3 gap-y-2 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_repeat(4,minmax(0,1.15fr))] lg:items-start" data-testid={`budget-row-${r.departmentId}`}>
                  <span className="text-[14px] font-bold">
                    {r.departmentName}
                    {!r.active && <span className="ml-1.5 text-[12px] font-normal text-ink-3">已停用</span>}
                  </span>
                  {r.cells.map((c) => (
                    <BudgetCellView
                      key={c.category}
                      cell={c}
                      label={shown!.categories.find((x) => x.key === c.category)!.label}
                      month={shown!.month}
                      testId={`budget-cell-${r.departmentId}-${c.category}`}
                      editing={editing}
                      value={draft[cellKey(r.departmentId, c.category)] ?? ''}
                      onChange={(v) => setDraft((d) => ({ ...d, [cellKey(r.departmentId, c.category)]: v }))}
                      disabled={busy}
                    />
                  ))}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </ErpPage>
  );
}

function Legend({ warnPercent }: { warnPercent: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
      <Badge tone="pine">正常</Badge>
      <Badge tone="yuzu">{`快用完（≥ ${warnPercent}%）`}</Badge>
      <Badge tone="clay">超预算</Badge>
      <span>黄灯百分比在费用报销规则里改</span>
    </div>
  );
}

function BudgetCellView({
  cell,
  label,
  month,
  testId,
  editing,
  value,
  onChange,
  disabled,
}: {
  cell: BudgetCell;
  label: string;
  month: string;
  testId: string;
  editing: boolean;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const pct = cell.budgetCents && cell.budgetCents > 0 ? Math.min(100, Math.round((cell.usedCents * 100) / cell.budgetCents)) : cell.budgetCents === 0 && cell.usedCents > 0 ? 100 : 0;
  return (
    <div className="min-w-0 rounded-md border border-line/70 px-3 py-2 lg:border-0 lg:px-0 lg:py-0" data-testid={testId} data-level={cell.level}>
      <div className="flex items-center justify-between gap-2 text-[12px] text-ink-3 lg:hidden">
        <span>{label}</span>
        <Badge tone={LEVEL_TONE[cell.level]}>{BUDGET_LEVEL_LABELS[cell.level]}</Badge>
      </div>
      {editing ? (
        <MoneyInput value={value} onChange={(e) => onChange(e.target.value)} placeholder="不控制" disabled={disabled} className="h-9" aria-label={`${label}额度`} data-testid={`${testId}-input`} />
      ) : (
        <div className="text-[13px]">
          {cell.budgetCents === null ? <span className="text-ink-3">不控制</span> : <Money cents={cell.budgetCents} className="font-bold" />}
          {cell.fromMonth && cell.fromMonth !== month && <span className="ml-1 text-[11.5px] text-ink-4">（{cell.fromMonth} 起）</span>}
        </div>
      )}
      {cell.budgetCents !== null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-paper-2" aria-hidden>
          <div className={cn('h-full rounded-full', BAR[cell.level])} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className={cn('mt-1 text-[12px]', cell.level === 'over' ? 'font-semibold text-clay' : cell.level === 'warn' ? 'text-yuzu-deep' : 'text-ink-3')}>
        已占用 ¥{formatAmount(cell.usedCents)}
        {cell.pendingCents > 0 && <span className="text-ink-4">（审批中 ¥{formatAmount(cell.pendingCents)}）</span>}
        {cell.budgetCents !== null && cell.usedCents > cell.budgetCents && <span className="block">超出 ¥{formatAmount(cell.usedCents - cell.budgetCents)}</span>}
      </div>
    </div>
  );
}
