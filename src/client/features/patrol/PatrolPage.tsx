// ERP「员工工作台 → 安保巡场」（8.0.9，docs/PATROL_V809.md 第 4 节）：
//   · 今天：每个场所今天（营业日）谁几点巡过，还没人巡的排在前面；可以换日期看前几天；
//   · 巡场记录：按营业日起止、场所、巡场的人筛选，导出与页面同一个查询；测试或扫错的可以作废（写原因）；
//   · 场所与二维码：新增（带操作编号，回复丢了在页面上方「结果待确认」里处理）、改名称与位置、停用 / 启用、换码、打印二维码；
//   · 设置：巡场部门、手机上能看巡场记录的人。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import {
  MAX_PATROL_POINT_AREA,
  MAX_PATROL_POINT_NAME,
  PATROL_MAX_DAYS,
  PATROL_VIA_LABELS,
  type PatrolDay,
  type PatrolPoint,
  type PatrolPointsAdmin,
  type PatrolRecords,
  type PatrolSettingsAdmin,
} from '@shared/patrol';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, downloadUrl, formatDateTime, formatTime, uuid } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { PrintButton } from '../print/PrintButton';

type Tab = 'day' | 'records' | 'points' | 'settings';
const KEY = ['patrol'] as const;

export function PatrolPage() {
  const can = useCan();
  const manage = can('patrol.manage');
  const [tab, setTab] = useState<Tab>('day');
  return (
    <ErpPage
      title="安保巡场"
      description="安保部门在柚子饭堂「工作台 → 巡场」扫场所二维码打卡。这里看每天的巡场清单（还没人巡的场所排在前面）、巡场记录与导出；管场所与二维码、巡场部门、手机上能看记录的人。"
    >
      <div className="space-y-5" data-testid="patrol-admin">
        {manage && <ErpPendingPanel types={['patrol_point']} />}
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          ariaLabel="安保巡场"
          options={[
            { value: 'day', label: '今天' },
            { value: 'records', label: '巡场记录' },
            ...(manage
              ? [
                  { value: 'points' as const, label: '场所与二维码' },
                  { value: 'settings' as const, label: '设置' },
                ]
              : []),
          ]}
        />
        {tab === 'day' && <DayTab />}
        {tab === 'records' && <RecordsTab manage={manage} />}
        {tab === 'points' && manage && <PointsTab />}
        {tab === 'settings' && manage && <SettingsTab />}
      </div>
    </ErpPage>
  );
}

// ───────────────────────── 今天 ─────────────────────────

function DayTab() {
  const [date, setDate] = useState<string | null>(null);
  const day = useQuery({
    queryKey: [...KEY, 'day', date],
    queryFn: () => api.get<PatrolDay>(`/api/erp/patrol/day${date ? `?date=${date}` : ''}`),
    refetchInterval: 60_000,
  });
  const d = day.data;
  const points = useMemo(() => (d ? [...d.points].sort((a, b) => Number(a.count > 0 || !a.active) - Number(b.count > 0 || !b.active)) : []), [d]);
  return (
    <div className="space-y-4" data-testid="patrol-day">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="营业日" htmlFor="patrol-day-date">
          <Input id="patrol-day-date" type="date" value={date ?? d?.today ?? ''} max={d?.today} onChange={(e) => setDate(e.target.value || null)} className="w-44" />
        </Field>
        {date && date !== d?.today && (
          <Button variant="ghost" onClick={() => setDate(null)}>
            回到今天
          </Button>
        )}
      </div>
      {day.error && <Notice tone="error" title={errorMessage(day.error)} />}
      {!d && day.isPending && <Skeleton className="h-40" />}
      {d && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Card className="p-4">
              <p className="text-[12.5px] text-ink-3">巡场次数</p>
              <p className="num text-[24px] font-bold" data-testid="patrol-day-total">
                {d.total}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-[12.5px] text-ink-3">还没人巡的场所</p>
              <p className={cn('num text-[24px] font-bold', d.missing > 0 && 'text-clay')} data-testid="patrol-day-missing">
                {d.missing}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-[12.5px] text-ink-3">巡场的人</p>
              <p className="num text-[24px] font-bold">{d.people.length}</p>
              <p className="mt-0.5 truncate text-[12px] text-ink-3">{d.people.map((p) => `${p.name} ${p.count} 次`).join('、')}</p>
            </Card>
          </div>
          <Card className="p-0">
            {points.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-ink-3">还没有场所：在「场所与二维码」里新增</p>
            ) : (
              <ul className="divide-y divide-line/70">
                {points.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3" data-testid={`patrol-day-point-${p.name}`}>
                    <span className="min-w-0 flex-1 basis-56">
                      <span className="text-[14px] font-semibold">{p.name}</span>
                      {p.area && <span className="ml-2 text-[12px] text-ink-3">{p.area}</span>}
                      {!p.active && (
                        <Badge tone="neutral" className="ml-2">
                          已停用
                        </Badge>
                      )}
                      <span className="mt-1 block text-[12.5px] text-ink-2">
                        {p.count > 0 ? (
                          p.scans.map((s) => (
                            <span key={s.id} className="mr-3 inline-block">
                              {formatTime(s.at)} {s.name}
                              {s.late && <span className="ml-1 text-[11.5px] text-clay">离线补登</span>}
                            </span>
                          ))
                        ) : (
                          <span className="font-semibold text-clay">{d.date === d.today ? '今天还没人巡' : '这一天没人巡'}</span>
                        )}
                      </span>
                    </span>
                    <span className="num text-[14px] font-bold">{p.count} 次</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ───────────────────────── 巡场记录 ─────────────────────────

function RecordsTab({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  // 营业日（与巡场记的营业日同一个口径，XC4）
  const today = session.today;
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [pointId, setPointId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [voiding, setVoiding] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const day = useQuery({ queryKey: [...KEY, 'day', null], queryFn: () => api.get<PatrolDay>('/api/erp/patrol/day') });
  const base = new URLSearchParams({ from, to, ...(pointId ? { pointId } : {}) });
  const records = useQuery({
    queryKey: [...KEY, 'records', from, to, pointId],
    queryFn: () => api.get<PatrolRecords>(`/api/erp/patrol/records?${base}`),
    enabled: !!from && !!to && from <= to,
  });
  const people = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of records.data?.rows ?? []) m.set(r.employeeId, `${r.name}（${r.empNo}）`);
    return [...m.entries()];
  }, [records.data]);
  const rows = (records.data?.rows ?? []).filter((r) => !employeeId || r.employeeId === Number(employeeId));
  const total = rows.filter((r) => !r.voidedAt).length;
  const tooLong = from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 >= PATROL_MAX_DAYS;
  const exportQuery = new URLSearchParams({ from, to, ...(pointId ? { pointId } : {}), ...(employeeId ? { employeeId } : {}) });

  const doVoid = async (reason: string) => {
    if (voiding === null) return;
    setBusy(true);
    try {
      await api.post(`/api/erp/patrol/checkins/${voiding}/void`, { reason });
      toast({ tone: 'success', title: '已作废这条巡场记录' });
      setVoiding(null);
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: KEY });
    }
  };

  return (
    <div className="space-y-4" data-testid="patrol-records">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="从" htmlFor="patrol-from">
          <Input id="patrol-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </Field>
        <Field label="到" htmlFor="patrol-to">
          <Input id="patrol-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </Field>
        <Field label="场所" htmlFor="patrol-point">
          <Select id="patrol-point" value={pointId} onChange={(e) => setPointId(e.target.value)} fullWidth={false} className="w-44" data-testid="patrol-records-point">
            <option value="">全部场所</option>
            {(day.data?.points ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="巡场的人" htmlFor="patrol-person">
          <Select id="patrol-person" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} fullWidth={false} className="w-44" data-testid="patrol-records-person">
            <option value="">全部</option>
            {people.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" disabled={!!tooLong || !rows.length} onClick={() => downloadUrl(`/api/erp/patrol/records/export?${exportQuery}`)} data-testid="patrol-records-export">
          导出
        </Button>
      </div>
      {tooLong && <Notice tone="warning" title={`一次最多查 ${PATROL_MAX_DAYS} 天`} />}
      {records.error && <Notice tone="error" title={errorMessage(records.error)} />}
      <p className="text-[13px] text-ink-3" data-testid="patrol-records-total">
        共 {total} 次{rows.length > total ? `，另有作废 ${rows.length - total} 次` : ''}
      </p>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead className="bg-paper-2 text-left text-[12px] text-ink-3">
            <tr>
              <th className="px-3 py-2 font-semibold">营业日</th>
              <th className="px-3 py-2 font-semibold">时间</th>
              <th className="px-3 py-2 font-semibold">场所</th>
              <th className="px-3 py-2 font-semibold">巡场的人</th>
              <th className="px-3 py-2 font-semibold">怎么扫的</th>
              <th className="px-3 py-2 font-semibold">状态</th>
              {manage && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {rows.length === 0 && (
              <tr>
                <td colSpan={manage ? 7 : 6} className="px-3 py-8 text-center text-ink-3">
                  {records.isPending ? '正在取…' : '这段时间没有巡场记录'}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className={cn(r.voidedAt && 'text-ink-4 line-through')} data-testid={`patrol-record-${r.id}`}>
                <td className="num px-3 py-2">{r.businessDate}</td>
                <td className="num px-3 py-2">
                  {formatTime(r.scannedAt)}
                  {r.late && <span className="ml-1 text-[11.5px] text-clay no-underline">离线补登</span>}
                </td>
                <td className="px-3 py-2">{r.pointName}</td>
                <td className="px-3 py-2">
                  {r.name} <span className="text-ink-3">{r.empNo}</span>
                </td>
                <td className="px-3 py-2">{PATROL_VIA_LABELS[r.via]}</td>
                <td className="px-3 py-2">{r.voidedAt ? `已作废：${r.voidReason}（${r.voidedByName ?? ''}）` : '有效'}</td>
                {manage && (
                  <td className="px-3 py-2 text-right">
                    {!r.voidedAt && (
                      <Button size="sm" variant="ghost" onClick={() => setVoiding(r.id)} data-testid={`patrol-void-${r.id}`}>
                        作废
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <ReasonDialog
        open={voiding !== null}
        title="作废这条巡场记录"
        description="测试或扫错的作废掉，不删，作废的不算数。原因记在记录里。"
        confirmLabel="作废"
        danger
        busy={busy}
        testId="patrol-void"
        onClose={() => setVoiding(null)}
        onConfirm={(reason) => void doVoid(reason)}
      />
    </div>
  );
}

// ───────────────────────── 场所与二维码 ─────────────────────────

function PointsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: [...KEY, 'points'], queryFn: () => api.get<PatrolPointsAdmin>('/api/erp/patrol/points') });
  const [editing, setEditing] = useState<PatrolPoint | 'new' | null>(null);
  const [rotating, setRotating] = useState<PatrolPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const data = list.data;
  const active = (data?.points ?? []).filter((p) => p.active);

  const rotate = async () => {
    if (!rotating) return;
    setBusy(true);
    try {
      await api.post(`/api/erp/patrol/points/${rotating.id}/token`, { version: rotating.version });
      toast({ tone: 'success', title: `「${rotating.name}」已换码`, body: '旧码马上作废，请打印新码贴上' });
      setRotating(null);
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: KEY });
    }
  };
  const togglePick = (id: number) => setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  return (
    <div className="space-y-4" data-testid="patrol-points">
      {data && !data.portalUrl && (
        <Notice tone="warning" title="还没填员工入口地址">
          二维码里是「员工入口地址 + 场所码」：先在「员工食堂 → 设置」里填员工入口地址，再打印。
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="patrol-point-new">
          新增场所
        </Button>
        {active.length > 0 && data?.portalUrl && (
          <PrintButton path={`/print/patrol-codes/${picked.length ? picked.join(',') : 'all'}`} paper="a4" testId="patrol-print">
            {picked.length ? `打印选中的 ${picked.length} 个` : `打印全部 ${active.length} 个二维码`}
          </PrintButton>
        )}
      </div>
      {list.error && <Notice tone="error" title={errorMessage(list.error)} />}
      {!data && list.isPending && <Skeleton className="h-32" />}
      {data && (
        <Card className="p-0">
          {data.points.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-ink-3">还没有场所。点「新增场所」，一个场所一个码，名称自己写（例如「北门停车场」）</p>
          ) : (
            <ul className="divide-y divide-line/70">
              {data.points.map((p) => (
                <li key={p.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3', !p.active && 'opacity-60')} data-testid={`patrol-point-${p.name}`}>
                  {p.active && <input type="checkbox" aria-label={`选中 ${p.name}`} checked={picked.includes(p.id)} onChange={() => togglePick(p.id)} className="size-4" />}
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="text-[14px] font-semibold">{p.name}</span>
                    {!p.active && (
                      <Badge tone="neutral" className="ml-2">
                        已停用
                      </Badge>
                    )}
                    <span className="block text-[12px] text-ink-3">
                      {p.area || '没写位置说明'} · 今天巡了 {p.todayCount} 次{p.tokenChangedAt ? ` · ${formatDateTime(p.tokenChangedAt)} 换过码` : ''}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)} data-testid={`patrol-point-edit-${p.name}`}>
                      编辑
                    </Button>
                    {p.active && (
                      <>
                        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => setRotating(p)} data-testid={`patrol-point-rotate-${p.name}`}>
                          换码
                        </Button>
                        {data.portalUrl && (
                          <PrintButton path={`/print/patrol-codes/${p.id}`} paper="a4" size="sm" testId={`patrol-print-${p.name}`}>
                            打印
                          </PrintButton>
                        )}
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <PointDialog editing={editing} onClose={() => setEditing(null)} onSaved={() => void qc.invalidateQueries({ queryKey: KEY })} />
      <Dialog
        open={!!rotating}
        onClose={busy ? () => {} : () => setRotating(null)}
        title={`换码 · ${rotating?.name ?? ''}`}
        description="码丢了、被拍走了、怀疑被复制时换码：旧码马上作废（扫了提示认不出），要重新打印这个场所的二维码贴上。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRotating(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void rotate()} data-testid="patrol-rotate-confirm">
              换码
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">已经打过的卡照样保留。</p>
      </Dialog>
    </div>
  );
}

function PointDialog({ editing, onClose, onSaved }: { editing: PatrolPoint | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const toast = useToast();
  const pending = useErpPending(['patrol_point']);
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [sort, setSort] = useState('0');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNew = editing === 'new';
  useResetOnOpen(!!editing, () => {
    const p = editing && editing !== 'new' ? editing : null;
    setName(p?.name ?? '');
    setArea(p?.area ?? '');
    setSort(String(p?.sortOrder ?? 0));
    setActive(p?.active ?? true);
    setError(null);
  });
  const sortOrder = Number(sort);
  const problem =
    isNew && pending.length > 0
      ? '上一次新增场所结果待确认，请先在页面上方处理'
      : !name.trim()
        ? '请写场所名称'
        : !Number.isInteger(sortOrder)
          ? '排序要是整数'
          : null;
  const save = async () => {
    if (problem || !editing) return;
    setBusy(true);
    setError(null);
    try {
      if (editing === 'new') {
        const body = { clientKey: uuid(), name: name.trim(), area: area.trim(), sortOrder };
        await sendErpOp({ key: body.clientKey, type: 'patrol_point', url: '/api/erp/patrol/points', body, summary: `新增巡场场所 ${body.name}`, staffName: session.staff.displayName });
        toast({ tone: 'success', title: `已新增「${body.name}」`, body: '打印二维码贴到这个场所' });
      } else {
        await api.put(`/api/erp/patrol/points/${editing.id}`, { name: name.trim(), area: area.trim(), sortOrder, active, version: editing.version });
        toast({ tone: 'success', title: '已保存' });
      }
      onClose();
    } catch (e) {
      if (e instanceof UncertainError && editing === 'new') {
        toast({ tone: 'error', title: '新增场所没收到结果', body: '记在页面上方的「结果待确认」里，查回或按原内容重新提交' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
      onSaved();
    }
  };
  return (
    <Dialog
      open={!!editing}
      onClose={busy ? () => {} : onClose}
      title={isNew ? '新增场所' : `编辑 · ${editing ? editing.name : ''}`}
      description={isNew ? '一个场所一个码。名称会大字印在二维码下面，保安扫完看到的也是它。' : '改名称不换码，贴着的码照样能扫；要换码点列表里的「换码」。'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!problem} loading={busy} onClick={() => void save()} data-testid="patrol-point-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="场所名称" htmlFor="patrol-point-name" hint={`最多 ${MAX_PATROL_POINT_NAME} 个字，启用的场所不重名`}>
          <Input id="patrol-point-name" value={name} maxLength={MAX_PATROL_POINT_NAME} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Field label="位置说明" htmlFor="patrol-point-area" hint={`选填，最多 ${MAX_PATROL_POINT_AREA} 个字，例如「负一层出口旁」`}>
          <Input id="patrol-point-area" value={area} maxLength={MAX_PATROL_POINT_AREA} onChange={(e) => setArea(e.target.value)} />
        </Field>
        <Field label="排序" htmlFor="patrol-point-sort" hint="数字越小越靠前（按巡场路线排）">
          <Input id="patrol-point-sort" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value.replace(/[^\d-]/g, ''))} className="w-28" />
        </Field>
        {!isNew && (
          <Field label="状态">
            <Segmented<'on' | 'off'>
              value={active ? 'on' : 'off'}
              onChange={(v) => setActive(v === 'on')}
              ariaLabel="状态"
              options={[
                { value: 'on', label: '启用' },
                { value: 'off', label: '停用' },
              ]}
            />
          </Field>
        )}
        {(problem || error) && <Notice tone={error ? 'error' : 'warning'} title={error ?? problem!} />}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 设置 ─────────────────────────

function SettingsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const s = useQuery({ queryKey: [...KEY, 'settings'], queryFn: () => api.get<PatrolSettingsAdmin>('/api/erp/patrol/settings') });
  const [deps, setDeps] = useState<number[] | null>(null);
  const [viewers, setViewers] = useState<number[] | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const data = s.data;
  const depIds = deps ?? data?.departmentIds ?? [];
  const viewerIds = viewers ?? data?.viewerIds ?? [];
  const dirty = deps !== null || viewers !== null;
  const toggle = (list: number[], id: number) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const shownEmployees = (data?.employees ?? []).filter((e) => e.active || viewerIds.includes(e.id)).filter((e) => !search.trim() || `${e.name}${e.empNo}${e.department}`.includes(search.trim()));

  const save = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const next = await api.put<PatrolSettingsAdmin>('/api/erp/patrol/settings', { departmentIds: depIds, viewerIds, rev: data.rev });
      qc.setQueryData([...KEY, 'settings'], next);
      setDeps(null);
      setViewers(null);
      toast({ tone: 'success', title: '已保存', body: `巡场部门里现在有 ${next.patrolStaffCount} 位员工` });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  if (s.error) return <Notice tone="error" title={errorMessage(s.error)} />;
  if (!data) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-5" data-testid="patrol-settings">
      <Card className="p-5">
        <SectionTitle>巡场部门</SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">员工名单（「员工食堂 → 员工名单」）里部门是这几个的员工，柚子饭堂里才有「巡场」、才能扫码打卡。一般选「安保部」；没有的话先在库存「部门」里加。</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {data.departments.length === 0 && <p className="text-[13px] text-ink-3">还没有部门</p>}
          {data.departments.map((d) => (
            <label key={d.id} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px]', depIds.includes(d.id) ? 'border-pine bg-pine/10' : 'border-line')}>
              <input type="checkbox" checked={depIds.includes(d.id)} onChange={() => setDeps(toggle(depIds, d.id))} data-testid={`patrol-dept-${d.name}`} />
              {d.name}
              {!d.active && <span className="text-ink-4">（已停用）</span>}
            </label>
          ))}
        </div>
        <p className="mt-2 text-[12.5px] text-ink-3">保存后巡场部门里有 {data.patrolStaffCount} 位启用的员工。</p>
      </Card>
      <Card className="p-5">
        <SectionTitle>手机上能看巡场记录的人</SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">从员工名单里挑（例如店总、安保主管），他们在柚子饭堂「工作台 → 巡场记录」里看任何一天的巡场清单（最多 {PATROL_MAX_DAYS} 天前）。巡场部门的人在手机上只看今天的。</p>
        <Input placeholder="搜姓名、工号、部门" value={search} onChange={(e) => setSearch(e.target.value)} className="mt-3 w-64" />
        <div className="mt-3 grid max-h-72 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
          {shownEmployees.map((e) => (
            <label key={e.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[13px] hover:bg-paper-2">
              <input type="checkbox" checked={viewerIds.includes(e.id)} onChange={() => setViewers(toggle(viewerIds, e.id))} data-testid={`patrol-viewer-${e.empNo}`} />
              {e.name} <span className="text-ink-3">{e.empNo}</span>
              {e.department && <span className="text-ink-4">· {e.department}</span>}
            </label>
          ))}
        </div>
      </Card>
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={!dirty} loading={busy} onClick={() => void save()} data-testid="patrol-settings-save">
          保存
        </Button>
        {data.updatedAt && (
          <span className="text-[12.5px] text-ink-3">
            上次 {formatDateTime(data.updatedAt)} 由 {data.updatedBy ?? '—'} 保存
          </span>
        )}
      </div>
    </div>
  );
}
