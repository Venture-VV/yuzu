// 技师管理 · 休假名册（8.1.15）：申请 → 批准 / 驳回；待审批的可以撤回，批了的可以销假。
//   · 申请：钟房的岗位替技师提（技师自己不登录系统）；批准、驳回、销假要「维护技师名册」权限。
//   · 批了的休假，那几天这位技师自动不进排位、不能派钟，钟房里显示「休假」，要上牌先在这里销假。
//   · 申请带操作编号：没收到结果时在同一个对话框里再点一次，不会建出两张。

import { useState } from 'react';
import { CalendarPlus, Check, Undo2, X } from 'lucide-react';
import { shiftDate } from '@shared/labels';
import {
  LEAVE_MAX_DAYS,
  LEAVE_STATUS_LABELS,
  LEAVE_TYPE_LABELS,
  LEAVE_TYPES,
  leaveRangeText,
  type LeaveStatus,
  type LeaveType,
  type TechLeave,
  type TechnicianAdminView,
} from '@shared/technician-admin';
import { api, errorMessage } from '../../lib/api';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { useLeaves, useTechAdminRefresh } from './queries';

type StatusFilter = LeaveStatus | 'all';
const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'pending', label: '待审批' },
  { value: 'approved', label: '已批准' },
  { value: 'all', label: '全部' },
];

const STATUS_STYLE: Record<LeaveStatus, string> = { pending: 'text-ember-deep', approved: 'text-pine', rejected: 'text-clay', cancelled: 'text-ink-3' };

type Action = { leave: TechLeave; kind: 'approve' | 'reject' | 'cancel' };

export function LeavesTab({ view }: { view: TechnicianAdminView }) {
  const [status, setStatus] = useState<StatusFilter>(view.pendingLeaves > 0 ? 'pending' : 'all');
  const [applying, setApplying] = useState(false);
  const [acting, setActing] = useState<Action | null>(null);
  const leaves = useLeaves(status);
  const today = view.businessDate;
  const list = leaves.data ?? [];

  return (
    <div className="space-y-4" data-testid="tech-leaves">
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented
          ariaLabel="看哪些休假单"
          value={status}
          onChange={setStatus}
          options={FILTERS.map((f) => ({
            value: f.value,
            label: (
              <span data-testid={`tech-leaves-filter-${f.value}`}>
                {f.label}
                {f.value === 'pending' && view.pendingLeaves > 0 ? ` ${view.pendingLeaves}` : ''}
              </span>
            ),
          }))}
        />
        <p className="min-w-0 flex-1 basis-52 text-[13px] text-ink-2">批了的休假，那几天自动不进排位；要上牌先销假。</p>
        <Button size="lg" variant="primary" icon={<CalendarPlus className="size-4" />} onClick={() => setApplying(true)} data-testid="tech-leave-new">
          申请休假
        </Button>
      </div>
      {leaves.isPending ? (
        <Skeleton className="h-40" />
      ) : leaves.isError && !leaves.data ? (
        <LoadFailed title="休假单没取回来" onRetry={() => void leaves.refetch()} retrying={leaves.isFetching} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState art="calm" title={status === 'pending' ? '没有待审批的休假' : status === 'approved' ? '没有已批准的休假' : '还没有休假单'} description="点「申请休假」替技师提一张。" />
        </Card>
      ) : (
        <ul className="space-y-2.5" data-testid="tech-leave-list">
          {list.map((l) => {
            const current = l.status === 'approved' && l.fromDate <= today && l.toDate >= today;
            const over = l.toDate < today;
            return (
              <li key={l.id}>
                <Card className={cn('flex flex-wrap items-start gap-x-4 gap-y-2 p-4', current && 'border-pine/50')} data-testid={`tech-leave-${l.id}`} data-status={l.status}>
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="num text-[18px] font-bold">{l.techNo}</span>
                      <span className="text-[15px] font-bold">
                        {l.techName}
                        {l.nickname && <span className="ml-1 text-[13px] font-semibold text-ink-3">「{l.nickname}」</span>}
                      </span>
                      <Badge tone="lake">{LEAVE_TYPE_LABELS[l.leaveType]}</Badge>
                      {current && <Badge tone="pine">今天在休</Badge>}
                    </p>
                    <p className="mt-1 text-[14px] font-semibold text-ink">
                      <span className="num">{leaveRangeText(l)}</span>
                      <span className="ml-2 font-normal text-ink-2">共 {l.days} 天</span>
                    </p>
                    <p className="mt-0.5 text-[13px] text-ink-2">原因：{l.reason}</p>
                    <p className="mt-1 text-[12.5px] text-ink-3">
                      {l.appliedByName} {formatDateTime(l.appliedAt)} 申请
                      {l.decidedAt && ` · ${l.decidedByName ?? ''} ${formatDateTime(l.decidedAt)} ${l.status === 'rejected' ? '驳回' : '批准'}${l.decisionNote ? `（${l.decisionNote}）` : ''}`}
                      {l.cancelledAt && ` · ${l.cancelledByName ?? ''} ${formatDateTime(l.cancelledAt)} ${l.decidedAt ? '销假' : '撤回'}${l.cancelReason ? `（${l.cancelReason}）` : ''}`}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <span className={cn('text-[16px] font-bold', STATUS_STYLE[l.status])} data-testid={`tech-leave-status-${l.id}`}>
                      {LEAVE_STATUS_LABELS[l.status]}
                    </span>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {l.status === 'pending' && view.canManage && (
                        <>
                          <Button
                            variant="primary"
                            className="h-11"
                            icon={<Check className="size-4" />}
                            onClick={() => setActing({ leave: l, kind: 'approve' })}
                            data-testid={`tech-leave-approve-${l.id}`}
                          >
                            批准
                          </Button>
                          <Button
                            variant="secondary"
                            className="h-11"
                            icon={<X className="size-4" />}
                            onClick={() => setActing({ leave: l, kind: 'reject' })}
                            data-testid={`tech-leave-reject-${l.id}`}
                          >
                            驳回
                          </Button>
                        </>
                      )}
                      {l.status === 'pending' && (
                        <Button variant="ghost" className="h-11" icon={<Undo2 className="size-4" />} onClick={() => setActing({ leave: l, kind: 'cancel' })} data-testid={`tech-leave-cancel-${l.id}`}>
                          撤回
                        </Button>
                      )}
                      {l.status === 'approved' && !over && view.canManage && (
                        <Button
                          variant="secondary"
                          className="h-11"
                          icon={<Undo2 className="size-4" />}
                          onClick={() => setActing({ leave: l, kind: 'cancel' })}
                          data-testid={`tech-leave-cancel-${l.id}`}
                        >
                          销假
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <ApplyDialog open={applying} view={view} onClose={() => setApplying(false)} />
      <ActionDialog action={acting} today={today} onClose={() => setActing(null)} />
    </div>
  );
}

function ApplyDialog({ open, view, onClose }: { open: boolean; view: TechnicianAdminView; onClose: () => void }) {
  const toast = useToast();
  const refresh = useTechAdminRefresh();
  const today = view.businessDate;
  const [clientKey, setClientKey] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [leaveType, setLeaveType] = useState<LeaveType>('personal');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    // 操作编号在打开对话框时定下：没收到结果时再点一次还是这个编号，不会建出两张
    setClientKey(uuid());
    setTechnicianId('');
    setFromDate(today);
    setToDate(today);
    setLeaveType('personal');
    setReason('');
    setError(null);
  });
  const technicians = view.technicians.filter((t) => t.active);
  const days = fromDate && toDate && toDate >= fromDate ? Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000) + 1 : 0;
  const problem = !technicianId
    ? '请选择技师'
    : !fromDate || !toDate
      ? '请填写开始与结束日期'
      : fromDate < today
        ? '开始日期不能早于今天'
        : toDate < fromDate
          ? '结束日期不能早于开始日期'
          : days > LEAVE_MAX_DAYS
            ? `一张最多请 ${LEAVE_MAX_DAYS} 天`
            : reason.trim().length < 2
              ? '请写原因（至少 2 个字）'
              : null;
  const picked = technicians.find((t) => String(t.id) === technicianId);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post<TechLeave>('/api/technician-admin/leaves', { clientKey, technicianId: Number(technicianId), fromDate, toDate, leaveType, reason: reason.trim() });
      refresh();
      toast({ tone: 'success', title: `已替 ${picked?.techNo ?? ''} 号申请休假`, body: view.canManage ? '在「待审批」里批准。' : '等有权限的同事批准。' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="申请休假"
      description="替技师提休假单，批准以后那几天自动不进排位。当天临时休假也可以在钟房直接点「休假」（只管当天）。"
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[13px] text-clay">{problem}</span>}
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="lg" loading={saving} disabled={!!problem} onClick={save} data-testid="tech-leave-save">
            提交申请
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label="技师" htmlFor="tl-tech">
          <Select id="tl-tech" className="h-11" value={technicianId} onChange={(e) => setTechnicianId(e.target.value)} data-testid="tech-leave-tech">
            <option value="">请选择</option>
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.techNo} 号 {t.name}
                {t.nickname ? `「${t.nickname}」` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="开始" htmlFor="tl-from">
            <Input
              id="tl-from"
              type="date"
              min={today}
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                if (e.target.value && toDate < e.target.value) setToDate(e.target.value);
              }}
              data-testid="tech-leave-from"
            />
          </Field>
          <Field label="结束" htmlFor="tl-to" hint={days > 0 ? `共 ${days} 天` : undefined}>
            <Input
              id="tl-to"
              type="date"
              min={fromDate || today}
              max={fromDate ? shiftDate(fromDate, LEAVE_MAX_DAYS - 1) : undefined}
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              data-testid="tech-leave-to"
            />
          </Field>
        </div>
        <Field label="类型">
          <Segmented ariaLabel="休假类型" value={leaveType} onChange={setLeaveType} className="w-full" options={LEAVE_TYPES.map((t) => ({ value: t, label: LEAVE_TYPE_LABELS[t] }))} />
        </Field>
        <Field label="原因" htmlFor="tl-reason">
          <Input id="tl-reason" value={reason} maxLength={100} onChange={(e) => setReason(e.target.value)} placeholder="例如：家里有事、看病" data-testid="tech-leave-reason" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

const ACTION_TEXT = {
  approve: { title: '批准休假', confirm: '批准', note: '说明（选填）', done: '已批准' },
  reject: { title: '驳回休假', confirm: '驳回', note: '驳回的原因', done: '已驳回' },
  cancel: { title: '撤回休假单', confirm: '撤回', note: '原因（选填）', done: '已撤回' },
  revoke: { title: '销假', confirm: '销假', note: '销假的原因', done: '已销假' },
} as const;

/** 批准、驳回、撤回（待审批的）、销假（已批准的）：驳回与销假必须写原因 */
function ActionDialog({ action, today, onClose }: { action: Action | null; today: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useTechAdminRefresh();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(
    !!action,
    () => {
      setNote('');
      setError(null);
    },
    [action],
  );
  if (!action) return null;
  const { leave, kind } = action;
  const mode = kind === 'cancel' && leave.status === 'approved' ? 'revoke' : kind;
  const t = ACTION_TEXT[mode];
  const required = mode === 'reject' || mode === 'revoke';
  const trimmed = note.trim();
  const who = `${leave.techNo} 号 ${leave.techName}`;
  const coversToday = leave.fromDate <= today && leave.toDate >= today;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (kind === 'cancel') await api.post<TechLeave>(`/api/technician-admin/leaves/${leave.id}/cancel`, { reason: trimmed });
      else await api.post<TechLeave>(`/api/technician-admin/leaves/${leave.id}/decide`, { action: kind, note: trimmed });
      refresh();
      toast({ tone: 'success', title: `${who}的休假${t.done}` });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      // 被拒绝多半是别人刚处理过：把清单刷新一下
      refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${t.title} · ${who}`}
      description={`${LEAVE_TYPE_LABELS[leave.leaveType]} ${leaveRangeText(leave)}（共 ${leave.days} 天）：${leave.reason}`}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose}>
            取消
          </Button>
          <Button variant={mode === 'approve' ? 'primary' : 'danger'} size="lg" loading={saving} disabled={required && trimmed.length < 2} onClick={submit} data-testid="tech-leave-action-confirm">
            {t.confirm}
          </Button>
        </>
      }
    >
      {coversToday && mode === 'approve' && (
        <Notice tone="warning" title="这张休假含今天" className="mb-4">
          批准以后{who}马上从排位里拿掉、钟房里显示「休假」；正在钟上的要先下钟或转钟才能批。
        </Notice>
      )}
      {coversToday && mode === 'revoke' && (
        <Notice tone="info" title="这张休假含今天" className="mb-4">
          销假以后{who}回到「未上牌」，在钟房点上牌就能排钟。
        </Notice>
      )}
      <Field label={t.note} htmlFor="tl-note" hint={required ? '至少 2 个字' : undefined}>
        <Input id="tl-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} data-autofocus data-testid="tech-leave-action-note" />
      </Field>
      {error && <Notice tone="error" title={error} className="mt-4" />}
    </Dialog>
  );
}
