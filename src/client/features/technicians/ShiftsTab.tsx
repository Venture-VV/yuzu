// 技师管理 · 技师班次（8.1.15）：班次的名字与起止时间、一周的排班表、临时调班、改动记录。
//   · 排班表：一位技师一天一格——上哪个班、排休、没排；点格子改。以后的日子直接排；
//     今天已经排了的格子只能走「临时调班」（要写原因），两人对调也算临时调班；过去的不能改。每次改动都另记一条。
//   · 休假单（待审批、已批准）标在格子上：批了休假的那几天不进排位，排了班也不算。
//   · 钟房：技师卡片上写今天的班；今天排休的「全部上牌」跳过。
// 窄屏（商米 V3）上表格在卡片里左右滑，技师那一列固定在左边，页面本身不横向滚动。

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Copy, Plus, Shuffle } from 'lucide-react';
import { describeDate, shiftDate } from '@shared/labels';
import {
  clockText,
  MAX_SHIFT_NAME,
  parseClock,
  SCHEDULE_CHANGE_LABELS,
  shiftTimeText,
  type RosterTechnician,
  type ScheduleCell,
  type ScheduleView,
  type TechnicianAdminView,
  type TechShift,
} from '@shared/technician-admin';
import { api, errorMessage } from '../../lib/api';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { scheduleKey, scheduleUrl, techViewKey, useSchedule, useTechAdminRefresh } from './queries';

const DAYS = 7;

/** 这一天所在那一周的周一 */
function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return shiftDate(date, -((weekday + 6) % 7));
}

type CellValue = Pick<ScheduleCell, 'shiftId' | 'rest'>;
const EMPTY: CellValue = { shiftId: null, rest: false };
const cellKey = (technicianId: number, date: string) => `${technicianId}|${date}`;

export function ShiftsTab({ view }: { view: TechnicianAdminView }) {
  const [editingShift, setEditingShift] = useState<TechShift | 'new' | null>(null);
  const shifts = view.shifts;
  return (
    <div className="space-y-4" data-testid="tech-shifts">
      <Card className="p-5">
        <SectionTitle
          aside={
            view.canManage && (
              <Button size="lg" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditingShift('new')} data-testid="tech-shift-new">
                新建班次
              </Button>
            )
          }
        >
          班次
        </SectionTitle>
        {shifts.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3">
            还没有班次。先建班次（例如早班 10:00–18:00、晚班 18:00–次日 02:00），再排班。
          </p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2" data-testid="tech-shift-list">
            {shifts.map((s) => (
              <li key={s.id} className={cn('flex items-center gap-2 rounded-lg border border-line px-3 py-2', !s.active && 'bg-paper-2/60')} data-testid={`tech-shift-${s.name}`}>
                <span className="text-[14px] font-bold">{s.name}</span>
                <span className="num text-[13px] text-ink-2">{shiftTimeText(s)}</span>
                {!s.active && <Badge tone="clay">已停用</Badge>}
                {view.canManage && (
                  <Button size="sm" variant="ghost" onClick={() => setEditingShift(s)}>
                    编辑
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ScheduleCard view={view} />
      <ShiftDialog target={editingShift} onClose={() => setEditingShift(null)} />
    </div>
  );
}

function ShiftDialog({ target, onClose }: { target: TechShift | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useTechAdminRefresh();
  const existing = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('18:00');
  const [sortOrder, setSortOrder] = useState('0');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(
    !!target,
    () => {
      setName(existing?.name ?? '');
      setStart(existing ? clockText(existing.startMinute) : '10:00');
      setEnd(existing ? clockText(existing.endMinute) : '18:00');
      setSortOrder(String(existing?.sortOrder ?? 0));
      setActive(existing?.active ?? true);
      setError(null);
    },
    [target],
  );
  const startMinute = parseClock(start);
  const endMinute = parseClock(end);
  const problem = !name.trim()
    ? '请填写班次的名字'
    : startMinute === null || endMinute === null
      ? '请填写开始与结束时间'
      : startMinute === endMinute
        ? '开始和结束不能是同一个时间'
        : !/^\d{1,4}$/.test(sortOrder)
          ? '排序请填 0–9999 的整数'
          : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { name: name.trim(), startMinute, endMinute, sortOrder: Number(sortOrder), active };
    try {
      const next = existing ? await api.put<TechnicianAdminView>(`/api/technician-admin/shifts/${existing.id}`, body) : await api.post<TechnicianAdminView>('/api/technician-admin/shifts', body);
      qc.setQueryData(techViewKey, next);
      refresh();
      toast({ tone: 'success', title: `班次「${body.name}」已保存` });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      title={existing ? `编辑班次 · ${existing.name}` : '新建班次'}
      description="结束时间不晚于开始时间，表示做到第二天（例如 18:00–次日 02:00）。"
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={save} data-testid="tech-shift-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
          <Field label="名字" htmlFor="ts-name">
            <Input id="ts-name" value={name} maxLength={MAX_SHIFT_NAME} onChange={(e) => setName(e.target.value)} placeholder="例如：早班" data-autofocus data-testid="tech-shift-name" />
          </Field>
          <Field label="排序" htmlFor="ts-sort" hint="小的在前">
            <Input id="ts-sort" value={sortOrder} inputMode="numeric" maxLength={4} onChange={(e) => setSortOrder(e.target.value)} className="num" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="开始" htmlFor="ts-start">
            <Input id="ts-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} className="num" data-testid="tech-shift-start" />
          </Field>
          <Field label="结束" htmlFor="ts-end" hint={startMinute !== null && endMinute !== null && endMinute < startMinute ? '到第二天' : undefined}>
            <Input id="ts-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="num" data-testid="tech-shift-end" />
          </Field>
        </div>
        {existing && (
          <Field label="状态" hint={active ? undefined : '停用以后不能再排这个班；已经排了的格子照旧显示。'}>
            <Segmented
              ariaLabel="班次状态"
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              className="w-full"
              options={[
                { value: 'on', label: '在用' },
                { value: 'off', label: '停用' },
              ]}
            />
          </Field>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function ScheduleCard({ view }: { view: TechnicianAdminView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useTechAdminRefresh();
  const [offset, setOffset] = useState(0);
  // 点格子：改那一格；点「临时调班」：在对话框里选技师与日期（一定要写原因）
  const [picking, setPicking] = useState<{ technicianId: number; date: string; adjust: boolean } | null>(null);
  const [copying, setCopying] = useState(false);
  const from = shiftDate(mondayOf(view.businessDate), offset * DAYS);
  const schedule = useSchedule(from, DAYS);
  const dates = useMemo(() => Array.from({ length: DAYS }, (_, i) => shiftDate(from, i)), [from]);
  const data = schedule.data;
  const today = data?.today ?? view.businessDate;
  const cells = useMemo(() => new Map((data?.cells ?? []).map((c) => [cellKey(c.technicianId, c.date), c])), [data]);
  const shiftById = useMemo(() => new Map(view.shifts.map((s) => [s.id, s])), [view.shifts]);
  const technicians = view.technicians.filter((t) => t.active);
  const leaveOn = (technicianId: number, date: string) => data?.leaves.find((l) => l.technicianId === technicianId && l.fromDate <= date && l.toDate >= date);
  const apply = (next: ScheduleView) => {
    qc.setQueryData(scheduleKey(from, DAYS), next);
    refresh();
  };

  // 复制上一周：只填这一周里还没排、且不早于今天的格子（已经排了的不动）
  const copyLastWeek = async () => {
    setCopying(true);
    try {
      const last = await api.get<ScheduleView>(scheduleUrl(shiftDate(from, -DAYS), DAYS));
      const active = new Set(technicians.map((t) => t.id));
      const usable = new Set(view.shifts.filter((s) => s.active).map((s) => s.id));
      const wanted = last.cells
        .map((c) => ({ ...c, date: shiftDate(c.date, DAYS) }))
        .filter((c) => c.date >= today && active.has(c.technicianId) && !cells.has(cellKey(c.technicianId, c.date)) && (c.shiftId === null || usable.has(c.shiftId)));
      if (wanted.length === 0) {
        toast({ tone: 'info', title: '没有可以复制的', body: '上一周没排班，或者这一周的格子都已经排了。' });
        return;
      }
      apply(await api.put<ScheduleView>(scheduleUrl(from, DAYS), { cells: wanted.map(({ technicianId, date, shiftId, rest }) => ({ technicianId, date, shiftId, rest })) }));
      toast({ tone: 'success', title: `按上一周排了 ${wanted.length} 格` });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setCopying(false);
    }
  };

  return (
    <Card className="p-5" data-testid="tech-schedule">
      <SectionTitle
        aside={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {view.canManage && technicians.length > 0 && dates.some((d) => d >= today) && (
              <Button
                variant="secondary"
                className="h-11"
                icon={<Shuffle className="size-4" />}
                onClick={() => setPicking({ technicianId: technicians[0]!.id, date: dates.find((d) => d >= today)!, adjust: true })}
                data-testid="tech-schedule-adjust"
              >
                临时调班
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} onClick={() => setOffset(offset - 1)} aria-label="上一周" data-testid="tech-schedule-prev">
              上一周
            </Button>
            <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(0)}>
              本周
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOffset(offset + 1)} aria-label="下一周" data-testid="tech-schedule-next">
              下一周 <ChevronRight className="size-4" />
            </Button>
          </div>
        }
      >
        排班表
        <span className="ml-2 text-[13px] font-normal text-ink-3">
          {describeDate(from).md}–{describeDate(dates[DAYS - 1]!).md}
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        点格子排班。今天已经排了的格子要改，算「临时调班」、要写原因；过去的不能改。批了休假的那几天不进排位（排了班也不算）。
        {view.canManage && (
          <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} loading={copying} onClick={() => void copyLastWeek()} className="ml-1 align-middle" data-testid="tech-schedule-copy">
            按上一周排
          </Button>
        )}
      </p>
      {schedule.isPending ? (
        <Skeleton className="mt-3 h-48" />
      ) : schedule.isError && !data ? (
        <LoadFailed title="排班表没取回来" onRetry={() => void schedule.refetch()} retrying={schedule.isFetching} className="mt-3" />
      ) : technicians.length === 0 ? (
        <EmptyState art="leaf" title="名册里还没有在职的技师" description="先在「技师名册」里录入技师，再排班。" />
      ) : (
        <div className="scroll-thin mt-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] border-separate border-spacing-0 text-[13px]" data-testid="tech-schedule-grid">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 w-28 border-b border-line bg-paper-2 px-2 py-2 text-left text-[12.5px] font-semibold text-ink-3 md:w-44">技师</th>
                {dates.map((d) => {
                  const day = describeDate(d);
                  return (
                    <th key={d} className={cn('border-b border-l border-line px-1 py-2 text-center text-[12.5px] font-semibold', d === today ? 'bg-pine-tint text-pine' : 'bg-paper-2 text-ink-3')}>
                      <span className="num block">{day.md}</span>
                      <span className="block font-normal">
                        {day.weekday}
                        {d === today && ' · 今天'}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {technicians.map((t) => (
                <tr key={t.id}>
                  <th className="sticky left-0 z-10 w-28 border-b border-line bg-card px-2 py-1.5 text-left font-semibold md:w-44">
                    <span className="num">{t.techNo}</span> <span className="break-words">{t.nickname || t.name}</span>
                    {t.groupName && <span className="block text-[12px] font-normal text-ink-3">{t.groupName}</span>}
                  </th>
                  {dates.map((d) => {
                    const cell = cells.get(cellKey(t.id, d)) ?? EMPTY;
                    const shift = cell.shiftId === null ? null : shiftById.get(cell.shiftId);
                    const leave = leaveOn(t.id, d);
                    const past = d < today;
                    return (
                      <td key={d} className="border-b border-l border-line p-1 align-top">
                        <button
                          type="button"
                          disabled={!view.canManage || past}
                          onClick={() => setPicking({ technicianId: t.id, date: d, adjust: false })}
                          className={cn(
                            'flex min-h-11 w-full flex-col items-center justify-center rounded-md px-1 py-1 text-center leading-tight',
                            shift ? 'bg-pine-tint font-semibold text-pine' : cell.rest ? 'bg-paper-2 font-semibold text-ink-2' : 'text-ink-4',
                            view.canManage && !past && 'hover:outline hover:outline-2 hover:outline-pine/40',
                            past && 'opacity-60',
                          )}
                          aria-label={`${t.techNo} 号 ${t.name} ${describeDate(d).md}：${shift ? shift.name : cell.rest ? '排休' : '没排'}${leave ? `，${leave.status === 'approved' ? '已批准休假' : '休假待审批'}` : ''}`}
                          data-testid={`tech-cell-${t.techNo}-${d}`}
                        >
                          <span>{shift ? shift.name : cell.rest ? '排休' : '—'}</span>
                          {leave && (
                            <span className={cn('mt-0.5 rounded px-1 text-[12px] font-semibold', leave.status === 'approved' ? 'bg-clay-soft text-clay' : 'bg-yuzu-soft text-yuzu-deep')}>
                              {leave.status === 'approved' ? '休假' : '休假待批'}
                            </span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.changes.length > 0 && (
        <div className="mt-4" data-testid="tech-schedule-changes">
          <h3 className="text-[13px] font-bold text-ink-2">这一周的改动记录（只追加）</h3>
          <ul className="mt-1.5 divide-y divide-line/70 rounded-lg border border-line">
            {data.changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-[13px]">
                <span className="num text-[12px] text-ink-3">{formatDateTime(c.at)}</span>
                <Badge tone={c.kind === 'plan' ? 'neutral' : c.kind === 'swap' ? 'lake' : 'ember'}>{SCHEDULE_CHANGE_LABELS[c.kind]}</Badge>
                <span className="font-semibold">
                  {c.techNo} 号 {c.techName}
                </span>
                <span className="num text-ink-2">{c.date.slice(5)}</span>
                <span className="text-ink-2">
                  {c.from} → <span className="font-semibold text-ink">{c.to}</span>
                </span>
                {c.swapWith && <span className="text-ink-2">与 {c.swapWith} 对调</span>}
                {c.reason && <span className="min-w-0 flex-1 text-ink-2">原因：{c.reason}</span>}
                <span className="ml-auto text-[12px] text-ink-3">{c.staffName}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {picking && data && (
        <CellDialog
          key={`${cellKey(picking.technicianId, picking.date)}|${picking.adjust}`}
          initial={picking}
          today={today}
          from={from}
          dates={dates.filter((d) => d >= today)}
          cells={cells}
          shifts={view.shifts}
          technicians={technicians}
          onClose={() => setPicking(null)}
          onSaved={(next) => {
            apply(next);
            setPicking(null);
          }}
        />
      )}
    </Card>
  );
}

const describeCell = (cell: CellValue, shifts: Map<number, TechShift>) => (cell.shiftId !== null ? (shifts.get(cell.shiftId)?.name ?? '班次') : cell.rest ? '排休' : '没排');

const choiceOf = (cell: CellValue) => (cell.shiftId !== null ? `s${cell.shiftId}` : cell.rest ? 'rest' : 'none');

/**
 * 改一格：选班次 / 排休 / 不排，或与另一位技师对调这一天。写了原因的记成临时调班；今天已经排了的、对调的必须写。
 * 从「临时调班」按钮打开的（initial.adjust）在这里选技师与日期，一定要写原因。
 */
function CellDialog({
  initial,
  today,
  from,
  dates,
  cells,
  shifts,
  technicians,
  onClose,
  onSaved,
}: {
  initial: { technicianId: number; date: string; adjust: boolean };
  today: string;
  from: string;
  /** 这一周里还能改的日子（不早于今天） */
  dates: string[];
  cells: Map<string, ScheduleCell>;
  shifts: TechShift[];
  /** 在职的技师 */
  technicians: RosterTechnician[];
  onClose: () => void;
  onSaved: (next: ScheduleView) => void;
}) {
  const toast = useToast();
  const [technicianId, setTechnicianId] = useState(initial.technicianId);
  const [date, setDate] = useState(initial.date);
  const cellOf = (id: number, d: string): CellValue => cells.get(cellKey(id, d)) ?? EMPTY;
  const current = cellOf(technicianId, date);
  const technician = technicians.find((t) => t.id === technicianId)!;
  const others = technicians.filter((t) => t.id !== technicianId);
  const [mode, setMode] = useState<'set' | 'swap'>('set');
  const [choice, setChoice] = useState<string>(choiceOf(current));
  const [swapWith, setSwapWith] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 换了技师或日期：选中的班回到那一格现在的样子 */
  const pick = (id: number, d: string) => {
    setTechnicianId(id);
    setDate(d);
    setChoice(choiceOf(cellOf(id, d)));
    setSwapWith('');
    setError(null);
  };
  const shiftMap = new Map(shifts.map((s) => [s.id, s]));
  const hasValue = current.shiftId !== null || current.rest;
  const mustReason = initial.adjust || mode === 'swap' || (date === today && hasValue);
  const trimmed = reason.trim();
  const next: CellValue = choice === 'rest' ? { shiftId: null, rest: true } : choice === 'none' ? EMPTY : { shiftId: Number(choice.slice(1)), rest: false };
  const unchanged = mode === 'set' && next.shiftId === current.shiftId && next.rest === current.rest;
  const problem =
    mode === 'swap' && !swapWith ? '请选择和谁对调' : unchanged ? '没有变化' : mustReason && trimmed.length < 2 ? '请写原因（至少 2 个字）' : trimmed.length === 1 ? '原因至少 2 个字' : null;
  const day = describeDate(date);
  const who = `${technician.techNo} 号 ${technician.name}`;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // 写了原因的（今天已经排了的、对调的一定有）记成临时调班；没写的是排班
      const result =
        mode === 'swap' || trimmed
          ? await api.post<ScheduleView>(`/api/technician-admin/schedule/adjust?from=${from}&days=${DAYS}`, {
              technicianId: technician.id,
              date,
              reason: trimmed,
              ...(mode === 'swap' ? { swapWithId: Number(swapWith) } : next),
            })
          : await api.put<ScheduleView>(scheduleUrl(from, DAYS), { cells: [{ technicianId: technician.id, date, ...next }] });
      toast({ tone: 'success', title: mode === 'swap' ? `${who} ${day.md} 已对调` : `${who} ${day.md}：${describeCell(next, shiftMap)}` });
      onSaved(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${mustReason ? '临时调班' : '排班'} · ${who}`}
      description={`${day.md} ${day.weekday}${date === today ? '（今天）' : ''}，现在：${describeCell(current, shiftMap)}`}
      footer={
        <>
          {problem && problem !== '没有变化' && <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={save} data-testid="tech-cell-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        {initial.adjust && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="技师" htmlFor="tc-tech">
              <Select id="tc-tech" className="h-11" value={technicianId} onChange={(e) => pick(Number(e.target.value), date)} data-testid="tech-cell-tech">
                {technicians.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.techNo} 号 {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="哪一天" htmlFor="tc-date">
              <Select id="tc-date" className="h-11" value={date} onChange={(e) => pick(technicianId, e.target.value)} data-testid="tech-cell-date">
                {dates.map((d) => (
                  <option key={d} value={d}>
                    {describeDate(d).md} {describeDate(d).weekday}
                    {d === today ? '（今天）' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <Segmented
          ariaLabel="怎么改"
          value={mode}
          onChange={setMode}
          className="w-full"
          options={[
            { value: 'set', label: '改这一格' },
            {
              value: 'swap',
              label: (
                <span className="inline-flex items-center gap-1">
                  <Shuffle className="size-3.5" /> 与另一位对调
                </span>
              ),
              disabled: others.length === 0,
            },
          ]}
        />
        {mode === 'set' ? (
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="排哪个班">
            {[
              ...shifts.filter((s) => s.active || s.id === current.shiftId).map((s) => ({ value: `s${s.id}`, label: s.name, hint: shiftTimeText(s) })),
              { value: 'rest', label: '排休', hint: '「全部上牌」跳过' },
              { value: 'none', label: '不排', hint: '清掉这一格' },
            ].map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={choice === o.value}
                onClick={() => setChoice(o.value)}
                className={cn(
                  'flex min-h-12 min-w-[104px] flex-col items-start justify-center rounded-lg border px-3 py-1.5 text-left',
                  choice === o.value ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4',
                )}
                data-testid={`tech-cell-choice-${o.label}`}
              >
                <span className="text-[14px] font-bold">{o.label}</span>
                <span className="num text-[12px] text-ink-3">{o.hint}</span>
              </button>
            ))}
          </div>
        ) : (
          <Field label="和谁对调这一天的班" htmlFor="tc-swap">
            <Select id="tc-swap" className="h-11" value={swapWith} onChange={(e) => setSwapWith(e.target.value)} data-testid="tech-cell-swap">
              <option value="">请选择</option>
              {others.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.techNo} 号 {t.name}（{describeCell(cells.get(cellKey(t.id, date)) ?? EMPTY, shiftMap)}）
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={mustReason ? '原因' : '原因（选填，写了就记成临时调班）'} htmlFor="tc-reason" hint={mustReason ? '至少 2 个字，记进改动记录与审计' : undefined}>
          <Input id="tc-reason" value={reason} maxLength={100} onChange={(e) => setReason(e.target.value)} placeholder="例如：晚班缺人、两人换班" data-testid="tech-cell-reason" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
