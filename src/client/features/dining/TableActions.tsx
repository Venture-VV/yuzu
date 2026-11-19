// 8.1.15《浴族系统需求汇总》块 B1 · 桌台动作（docs/DINING_V8115.md 第 2、5 节）：
//   · TableStateLine：没在用餐的桌在格子上写状态——空闲、待清台、维修中（颜色加文字加图标）；用餐中的写并台（并入某桌、并着几桌）；
//   · TableStateDialog：点没在用餐的桌——清台、维修、恢复、看历史、开台；
//   · MergeDialog：选几桌并进来（都在用餐中），拆台在桌台详情里；
//   · TableHistoryDialog：桌台历史（动作与开台、换台、撤台、结账、反结账排在一起，最近的在前）；
//   · useTableAction：提交带操作编号；结果不确定时同一笔沿用原编号原样重提（服务端只记一次、返回第一次那条），明确拒绝了的换新编号。

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Brush, CircleCheck, History, Link2, Wrench } from 'lucide-react';
import type { TablesBoard } from '@shared/dining';
import { MAX_TABLE_ACTION_REASON, TABLE_HISTORY_LABELS, TABLE_STATE_LABELS, type TableActionResult, type TableHistory, type TableStateInfo } from '@shared/dining-v8115';
import { api, errorMessage, isRejected, notSentAsRejection } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Skeleton } from '../../components/ui';

type Tile = TablesBoard['tables'][number];

/** 维修的常用原因，点一下填进原因框 */
const MAINTENANCE_REASONS = ['桌椅损坏', '桌面破损', '漏水', '电路故障', '深度清洁'];

/** 桌台动作的提交：结果不确定时同一笔沿用原编号（服务端只记一次），明确拒绝了的换新编号 */
export function useTableAction() {
  const qc = useQueryClient();
  const toast = useToast();
  const last = useRef<{ sig: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<string | null>(null);
  const run = async (url: string, body: Record<string, unknown>, ok: string): Promise<boolean> => {
    const sig = JSON.stringify([url, body]);
    const retry = last.current?.sig === sig;
    const key = retry ? last.current!.key : uuid();
    last.current = { sig, key };
    setBusy(true);
    try {
      await api.post<TableActionResult>(url, { clientKey: key, ...body });
      last.current = null;
      setUncertain(null);
      toast({ tone: 'success', title: ok });
      return true;
    } catch (raw) {
      // 第一次被「连不上、没发出去」挡下算明确没处理；重提时照旧不确定
      const error = retry ? raw : notSentAsRejection(raw);
      if (isRejected(error)) {
        last.current = null;
        setUncertain(null);
        toast({ tone: 'error', title: errorMessage(error) });
      } else {
        setUncertain(`${errorMessage(error)}，这一下是否已经生效暂不确定。请再点一次同样的按钮核对：已经生效的直接完成，不会重复`);
      }
      return false;
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['dining'] });
    }
  };
  return { run, busy, uncertain };
}

/** 格子上的状态：空闲 / 待清台 / 维修中（没在用餐时）；用餐中的另写并台 */
export function TableStateLine({ t, mainName, subCount }: { t: TableStateInfo & { name: string }; mainName?: string | null; subCount?: number }) {
  if (mainName) {
    return (
      <span className="flex items-center gap-1 text-[13px] font-bold text-lake" data-testid={`table-merged-${t.name}`}>
        <Link2 className="size-3.5" /> 并入桌 {mainName}
      </span>
    );
  }
  if (subCount) {
    return (
      <span className="flex items-center gap-1 text-[13px] font-bold text-lake" data-testid={`table-merged-${t.name}`}>
        <Link2 className="size-3.5" /> 并着 {subCount} 桌
      </span>
    );
  }
  if (t.state === 'dirty') {
    return (
      <span className="mt-auto flex items-center gap-1 pt-1.5 text-[16px] font-bold text-yuzu-deep">
        <Brush className="size-4" /> {TABLE_STATE_LABELS.dirty}
      </span>
    );
  }
  if (t.state === 'maintenance') {
    return (
      <span className="mt-auto block w-full pt-1.5">
        <span className="flex items-center gap-1 text-[16px] font-bold text-clay">
          <Wrench className="size-4" /> {TABLE_STATE_LABELS.maintenance}
        </span>
        <span className="block truncate text-[12px] text-ink-3">
          {t.maintenanceReason}
          {t.maintenanceUntil && ` · 预计 ${formatDateTime(t.maintenanceUntil)}`}
        </span>
      </span>
    );
  }
  return null;
}

/**
 * 点没在用餐的桌：写明现在的状态；待清台的「清台」、可用的「维修」（与开台）、维修中的「恢复」，都能看历史。
 * onOpen：开台（可用、有开台权限时才给）
 */
export function TableStateDialog({ table, onClose, onOpen }: { table: Tile; onClose: () => void; onOpen: (() => void) | null }) {
  const can = useCan();
  const action = useTableAction();
  const [maintaining, setMaintaining] = useState(false);
  const [history, setHistory] = useState(false);
  const canAct = can('dining.order') && can('frontdesk.operate');
  const url = (what: string) => `/api/dining/tables/${table.id}/${what}`;
  const done = (ok: boolean) => ok && onClose();
  return (
    <Dialog
      open
      onClose={action.busy ? () => {} : onClose}
      title={`桌 ${table.name}`}
      description={`${table.area ? `${table.area} · ` : ''}${table.seats} 座${table.stateSince ? ` · ${formatDateTime(table.stateSince)} 起${TABLE_STATE_LABELS[table.state]}` : ''}`}
      footer={
        <>
          <Button variant="ghost" icon={<History className="size-4" />} onClick={() => setHistory(true)} data-testid="table-history-open">
            历史
          </Button>
          {canAct && table.state !== 'maintenance' && (
            <Button variant="secondary" size="lg" icon={<Wrench className="size-4" />} onClick={() => setMaintaining(true)} data-testid="table-maintenance-open">
              维修
            </Button>
          )}
          {canAct && table.state === 'dirty' && (
            <Button
              variant="primary"
              size="lg"
              icon={<Brush className="size-4" />}
              loading={action.busy}
              onClick={() => void action.run(url('clear'), {}, `桌 ${table.name} 已清台`).then(done)}
              data-testid="table-clear"
            >
              清台
            </Button>
          )}
          {canAct && table.state === 'maintenance' && (
            <Button
              variant="primary"
              size="lg"
              icon={<CircleCheck className="size-4" />}
              loading={action.busy}
              onClick={() => void action.run(url('restore'), {}, `桌 ${table.name} 已恢复可用`).then(done)}
              data-testid="table-restore"
            >
              恢复
            </Button>
          )}
          {onOpen && table.state === 'available' && (
            <Button variant="primary" size="lg" onClick={onOpen} data-testid="table-state-open">
              开台
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3" data-testid="table-state">
        <p className="flex items-center gap-2">
          <span className="text-[13px] text-ink-3">现在</span>
          <StateBadge table={table} />
        </p>
        {table.state === 'maintenance' && (
          <Notice tone="warning" title={`维修：${table.maintenanceReason ?? ''}`}>
            预计 {table.maintenanceUntil ? formatDateTime(table.maintenanceUntil) : '—'} 恢复。维修中不能开台、不能换到这桌，修好了点「恢复」。
          </Notice>
        )}
        {table.state === 'dirty' && <p className="text-[13.5px] text-ink-2">上一桌结完账还没收拾：收拾好点「清台」回到可用，之前不能开台、不能换到这桌。</p>}
        {action.uncertain && <Notice tone="warning" title={action.uncertain} />}
        {!canAct && <p className="text-[12.5px] text-ink-3">清台、维修、恢复要有「餐饮点单」与「前台挂账」权限。</p>}
      </div>
      {maintaining && <MaintenanceDialog table={table} onClose={() => setMaintaining(false)} onDone={onClose} />}
      <TableHistoryDialog tableId={history ? table.id : null} onClose={() => setHistory(false)} />
    </Dialog>
  );
}

/** 状态的小章：颜色加文字加图标 */
function StateBadge({ table }: { table: TableStateInfo }) {
  if (table.state === 'dirty') {
    return (
      <Badge tone="yuzu" icon={<Brush className="size-3" />}>
        {TABLE_STATE_LABELS.dirty}
      </Badge>
    );
  }
  if (table.state === 'maintenance') {
    return (
      <Badge tone="clay" icon={<Wrench className="size-3" />}>
        {TABLE_STATE_LABELS.maintenance}
      </Badge>
    );
  }
  return (
    <Badge tone="pine" icon={<CircleCheck className="size-3" />}>
      {TABLE_STATE_LABELS.available}
    </Badge>
  );
}

/** 「YYYY-MM-DDTHH:mm」（datetime-local 的值）：现在往后几小时 */
const localInput = (hours: number) => {
  const d = new Date(Date.now() + hours * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 维修：原因与预计恢复时间都要填 */
function MaintenanceDialog({ table, onClose, onDone }: { table: Tile; onClose: () => void; onDone: () => void }) {
  const action = useTableAction();
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState(() => localInput(2));
  const at = new Date(until);
  const problem = reason.trim().length < 2 ? '请填写维修原因（至少 2 个字）' : Number.isNaN(at.getTime()) ? '请填写预计恢复时间' : at.getTime() <= Date.now() ? '预计恢复时间要晚于现在' : null;
  const submit = async () => {
    if (problem) return;
    const ok = await action.run(`/api/dining/tables/${table.id}/maintenance`, { reason: reason.trim(), expectedBackAt: at.toISOString() }, `桌 ${table.name} 已设为维修中`);
    if (ok) {
      onClose();
      onDone();
    }
  };
  return (
    <Dialog
      open
      onClose={action.busy ? () => {} : onClose}
      title={`维修 · 桌 ${table.name}`}
      description="维修中的桌不能开台、不能换过来；修好了点「恢复」。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={action.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!!problem} loading={action.busy} onClick={() => void submit()} data-testid="table-maintenance-confirm">
            设为维修中
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="table-maintenance">
        <Field label="原因" htmlFor="table-maintenance-reason">
          <Input
            id="table-maintenance-reason"
            value={reason}
            maxLength={MAX_TABLE_ACTION_REASON}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例如：桌腿松了"
            data-autofocus
            data-testid="table-maintenance-reason"
          />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {MAINTENANCE_REASONS.map((r) => (
            <button key={r} type="button" className="h-11 rounded-full bg-paper-2 px-3.5 text-[13px] font-semibold text-ink-2 hover:text-ink" onClick={() => setReason(r)}>
              {r}
            </button>
          ))}
        </div>
        <Field label="预计恢复时间" htmlFor="table-maintenance-until">
          <Input id="table-maintenance-until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} className="w-60" data-testid="table-maintenance-until" />
        </Field>
        {problem && reason.length > 0 && <p className="text-[12.5px] font-semibold text-clay">{problem}</p>}
        {action.uncertain && <Notice tone="warning" title={action.uncertain} />}
      </div>
    </Dialog>
  );
}

/** 并台：从用餐中、没并着别的桌的桌里选几桌并到这一桌（主台）；结账时主台带着附台一起结 */
export function MergeDialog({ mainId, mainName, board, onClose }: { mainId: number; mainName: string; board: TablesBoard; onClose: () => void }) {
  const action = useTableAction();
  const [picked, setPicked] = useState<number[]>([]);
  const subsOf = (sessionId: number) => board.tables.filter((t) => t.session?.mergedInto === sessionId).length;
  const choices = board.tables.filter((t) => t.session && t.session.id !== mainId && t.session.mergedInto === null && subsOf(t.session.id) === 0);
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const names = choices.filter((t) => picked.includes(t.session!.id)).map((t) => t.name);
  const submit = async () => {
    if (!picked.length) return;
    const ok = await action.run(`/api/dining/tables/sessions/${mainId}/merge`, { subSessionIds: [...picked].sort((a, b) => a - b) }, `桌 ${names.join('、')} 已并入桌 ${mainName}`);
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      onClose={action.busy ? () => {} : onClose}
      title={`并台 · 主台 桌 ${mainName}`}
      description="选要并进来的桌（都在用餐中）。账单不搬动，明细还在各自的桌上；结账时在主台一起结，附台不能单独结。拆台以后各结各的。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={action.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!picked.length} loading={action.busy} onClick={() => void submit()} data-testid="table-merge-confirm">
            {picked.length ? `并入 ${picked.length} 桌` : '并台'}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="table-merge-dialog">
        {choices.length === 0 ? (
          <EmptyState art="calm" title="没有能并进来的桌" description="只有用餐中、没有并着别的桌的桌能并进来。" />
        ) : (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="要并进来的桌">
            {choices.map((t) => {
              const on = picked.includes(t.session!.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(t.session!.id)}
                  className={cn(
                    'flex h-11 items-center gap-1.5 rounded-full border px-3.5 text-[14px] font-bold',
                    on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                  )}
                  data-testid={`table-merge-pick-${t.name}`}
                >
                  {on && <CircleCheck className="size-4" />}
                  <span className="num">桌 {t.name}</span>
                  <span className="text-[12px] font-semibold opacity-80">{t.session!.guests} 人</span>
                </button>
              );
            })}
          </div>
        )}
        {action.uncertain && <Notice tone="warning" title={action.uncertain} />}
      </div>
    </Dialog>
  );
}

/** 桌台历史：最近的在前，最多 200 条 */
export function TableHistoryDialog({ tableId, onClose }: { tableId: number | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['dining', 'tables', 'history', tableId],
    queryFn: () => api.get<TableHistory>(`/api/dining/tables/${tableId}/history`),
    enabled: tableId !== null,
  });
  const h = q.data;
  return (
    <Dialog
      open={tableId !== null}
      onClose={onClose}
      title={h ? `桌 ${h.tableName} 的历史` : '桌台历史'}
      description="开台、换台、并台、拆台、撤台、结账、反结账、清台、维修与恢复，最近的在前"
      width="max-w-xl"
    >
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.isError && !h ? (
        <LoadFailed title="桌台历史加载失败" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="table-history-error">
          {errorMessage(q.error)}
        </LoadFailed>
      ) : h && h.entries.length === 0 ? (
        <EmptyState art="calm" title="这张桌还没有记录" description="开台、结账、清台、维修以后这里一条条列出来。" />
      ) : h ? (
        <div data-testid="table-history">
          <ol className="divide-y divide-line/70">
            {h.entries.map((e, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2" data-testid={`table-history-${e.kind}`}>
                <span className="num w-28 shrink-0 text-[12.5px] text-ink-3">{formatDateTime(e.at)}</span>
                <span className="w-16 shrink-0 text-[14px] font-bold">{TABLE_HISTORY_LABELS[e.kind]}</span>
                <span className="min-w-0 flex-1 basis-40 text-[13.5px] text-ink-2">
                  {e.text}
                  {e.sessionNo && <span className="num ml-1.5 text-[12px] text-ink-4">{e.sessionNo}</span>}
                </span>
                <span className="text-[12.5px] text-ink-3">{e.operatorName}</span>
              </li>
            ))}
          </ol>
          {h.truncated && <p className="mt-2 text-[12px] text-ink-3">只列最近 {h.limit} 条。</p>}
        </div>
      ) : null}
    </Dialog>
  );
}
