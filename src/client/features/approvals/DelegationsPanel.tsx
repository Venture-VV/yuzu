// 代理人（v0.7.30，A7）：请假时设代理人与起止日期（最多 31 天）；代理期间代理人能审被代理人能审的单，记「某某（代 某某）」；
// 本人给自己设，店主可以给任何人设；随时可以收回。提交人不能借代理审自己提交的单。

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { DELEGATION_MAX_DAYS } from '@shared/approvals';
import { shiftDate } from '@shared/labels';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { useApprovers, useDelegations, useRefreshAfterApproval } from './queries';

export function DelegationsPanel() {
  const can = useCan();
  const session = useSession();
  const manage = can('approval.rules');
  const [all, setAll] = useState(false);
  const list = useDelegations(all && manage);
  const refresh = useRefreshAfterApproval();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const revoke = async (id: number) => {
    setBusy(id);
    try {
      await api.post(`/api/approvals/delegations/${id}/revoke`, {});
      toast({ tone: 'success', title: '代理已收回' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  return (
    <section className="space-y-3" data-testid="approval-delegations">
      <Notice tone="info" title={`请假时设代理人：代理期间（最多 ${DELEGATION_MAX_DAYS} 天）代理人能审你能审的单`}>
        审批记录写「代理人（代 你）」。提交人不能借代理审自己提交的单。随时可以收回。
      </Notice>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)} data-testid="delegation-new">
          设代理人
        </Button>
        {manage && (
          <label className="ml-auto flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={all} onChange={(e) => setAll(e.target.checked)} />
            看所有人的
          </label>
        )}
      </div>
      {list.error ? (
        <Notice tone="error" title={errorMessage(list.error)} />
      ) : !list.data ? (
        <Skeleton className="h-24" />
      ) : list.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong bg-card px-4 py-6 text-center text-[13px] text-ink-3">没有代理设置。</p>
      ) : (
        <ul className="space-y-2">
          {list.data.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-card px-4 py-3 text-[13px]" data-testid={`delegation-${g.id}`}>
              <span className="font-semibold">
                {g.delegateName} 代 {g.staffName}
              </span>
              <span className="num text-ink-2">
                {g.startsOn} 至 {g.endsOn}
              </span>
              {g.reason && <span className="text-ink-3">{g.reason}</span>}
              {g.revokedAt ? (
                <Badge>已收回 · {formatDateTime(g.revokedAt)}</Badge>
              ) : g.active ? (
                <Badge tone="pine">代理中</Badge>
              ) : (
                <Badge tone="neutral">未到或已过</Badge>
              )}
              {!g.revokedAt && (g.staffId === session.staff.id || manage) && (
                <Button size="sm" variant="ghost" className="ml-auto" loading={busy === g.id} onClick={() => void revoke(g.id)}>
                  收回
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <DelegationDialog open={open} onClose={() => setOpen(false)} />
    </section>
  );
}

function DelegationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const can = useCan();
  const session = useSession();
  const manage = can('approval.rules');
  const approvers = useApprovers(open);
  const refresh = useRefreshAfterApproval();
  const toast = useToast();
  const today = session.calendarToday;
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID());
  const [staffId, setStaffId] = useState(session.staff.id);
  const [delegateId, setDelegateId] = useState('');
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState(shiftDate(today, 2));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setClientKey(crypto.randomUUID());
    setStaffId(session.staff.id);
    setDelegateId('');
    setStartsOn(today);
    setEndsOn(shiftDate(today, 2));
    setReason('');
    setError(null);
  });
  const save = async () => {
    if (!delegateId) return setError('请选代理人');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/approvals/delegations', { clientKey, staffId, delegateId: Number(delegateId), startsOn, endsOn, reason: reason.trim() });
      toast({ tone: 'success', title: '代理人已设好' });
      await refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const people = approvers.data ?? [];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="设代理人"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()} data-testid="delegation-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Notice tone="error" title={error} />}
        {manage && (
          <Field label="谁请假（被代理的人）" htmlFor="del-staff">
            <Select id="del-staff" value={staffId} onChange={(e) => setStaffId(Number(e.target.value))}>
              <option value={session.staff.id}>我自己</option>
              {people
                .filter((p) => p.id !== session.staff.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label="代理人" htmlFor="del-delegate" hint="要有审批中心的权限">
          <Select id="del-delegate" value={delegateId} onChange={(e) => setDelegateId(e.target.value)} data-testid="delegation-delegate">
            <option value="">请选择</option>
            {people
              .filter((p) => p.id !== staffId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="开始" htmlFor="del-start">
            <Input id="del-start" type="date" value={startsOn} min={today} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label="结束（含）" htmlFor="del-end">
            <Input id="del-end" type="date" value={endsOn} min={startsOn} max={shiftDate(startsOn, DELEGATION_MAX_DAYS - 1)} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>
        <Field label="原因（选填）" htmlFor="del-reason">
          <Input id="del-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={60} placeholder="例如：年假" />
        </Field>
      </div>
    </Dialog>
  );
}
