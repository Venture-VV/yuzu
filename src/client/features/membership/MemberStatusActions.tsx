// 会员详情「储值与账户」里的停用 / 启用、合并（会员体系收尾，v0.7.26；docs/MEMBERSHIP_FINISH.md 第 3、4 节）：
//   · 停用 / 启用：店主、店总，写原因；有在店手牌的不能停用；
//   · 合并到…：店主、店总，按手机号、姓名或会员号找目标会员，先核对两位的余额、档阶与不能合并的原因，确认「不能撤销」后合并；
//   · 超时、断网、回复 500 时结果待确认：在「储值与账户」上方查回、按原内容重提或作废，不另起一笔。

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Combine } from 'lucide-react';
import type { MergeCheck } from '@shared/member-admin';
import { formatYuan } from '@shared/money';
import type { MemberDetail, MemberSummary } from '@shared/types';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { formatPhone } from '@shared/labels';
import { uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, ConfirmCheck, Field, Input, Notice, Skeleton, Textarea } from '../../components/ui';

export const statusUrl = (memberId: number) => `/api/members/${memberId}/status`;
export const mergeUrl = (memberId: number) => `/api/members/${memberId}/merge`;

export function MemberStatusActions({ member, onChanged }: { member: MemberDetail; onChanged: () => void }) {
  const can = useCan();
  const [dialog, setDialog] = useState<'status' | 'merge' | null>(null);
  const pending = useErpPending(['member_status', 'member_merge']).filter((op) => op.url === statusUrl(member.id) || op.url === mergeUrl(member.id));
  if (member.mergedIntoId !== null) return null;
  const busy = pending.length > 0 ? '上一次操作结果待确认，请先在上方查回、按原内容重新提交或作废' : undefined;
  return (
    <>
      {can('member.status') && (
        <Button size="sm" variant="ghost" disabled={!!busy} title={busy} onClick={() => setDialog('status')} data-testid="member-status-open">
          {member.status === 'frozen' ? '启用' : '停用'}
        </Button>
      )}
      {can('member.merge') && member.status === 'active' && (
        <Button size="sm" variant="ghost" icon={<Combine className="size-3.5" />} disabled={!!busy} title={busy} onClick={() => setDialog('merge')} data-testid="member-merge-open">
          合并到…
        </Button>
      )}
      {dialog === 'status' && <StatusDialog member={member} onClose={() => setDialog(null)} onDone={onChanged} />}
      {dialog === 'merge' && <MergeDialog member={member} onClose={() => setDialog(null)} onDone={onChanged} />}
    </>
  );
}

function StatusDialog({ member, onClose, onDone }: { member: MemberDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const session = useSession();
  const to = member.status === 'frozen' ? 'active' : 'frozen';
  const verb = to === 'frozen' ? '停用' : '启用';
  const [key] = useState(uuid);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'member_status',
        url: statusUrl(member.id),
        body: { clientKey: key, status: to, reason: reason.trim() },
        summary: `${verb}会员 ${member.name}（${member.memberNo}）`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: `已${verb}会员`, body: member.name });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: `${verb}结果待确认`, body: '已记在本机：请在「储值与账户」上方查回、按原内容重新提交或作废。' });
        onDone();
        onClose();
        return;
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={`${verb}会员：${member.name}`}
      description={
        to === 'frozen'
          ? '停用以后不能充值、储值消费，不享会员折扣、浴票延迟与 VIP 柜（按散客），不发每月的券与事件礼，不能邀请体验。余额与档阶不动，启用以后照常。'
          : '启用以后照常办理：充值、消费、会员折扣与权益都恢复。'
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant={to === 'frozen' ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < 2} onClick={submit} data-testid="member-status-submit">
            {verb}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field label="原因" htmlFor="member-status-reason">
          <Textarea id="member-status-reason" rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus data-testid="member-status-reason" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function MergeDialog({ member, onClose, onDone }: { member: MemberDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const session = useSession();
  const [key] = useState(uuid);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [target, setTarget] = useState<MemberSummary | null>(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(t);
  }, [term]);
  const search = useQuery({
    queryKey: ['member-merge-search', debounced],
    queryFn: () => api.get<MemberSummary[]>(`/api/members?q=${encodeURIComponent(debounced)}&limit=8`),
    enabled: debounced.length >= 2 && !target,
  });
  const check = useQuery({
    queryKey: ['member-merge-check', member.id, target?.id],
    queryFn: () => api.get<MergeCheck>(`/api/members/${member.id}/merge-check?targetId=${target!.id}`),
    enabled: !!target,
  });
  const c = check.data;
  const ready = !!c && c.problems.length === 0 && reason.trim().length >= 2 && confirmed;
  const candidates = (search.data ?? []).filter((m) => m.id !== member.id);

  const submit = async () => {
    if (!c || !target) return;
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'member_merge',
        url: mergeUrl(member.id),
        body: { clientKey: key, targetId: target.id, reason: reason.trim(), expectedPrincipal: c.principal, expectedBonus: c.bonus },
        summary: `${member.name}（${member.memberNo}）合并到 ${target.name}（${target.memberNo}）`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '已合并', body: `${member.name} 的余额与档阶已并进 ${target.name}` });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '合并结果待确认', body: '已记在本机：请在「储值与账户」上方查回、按原内容重新提交或作废，不要另起一笔。' });
        onDone();
        onClose();
        return;
      }
      setError(errorMessage(e));
      setConfirmed(false);
      void check.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={`合并会员：${member.name} 并进另一位`}
      description="同一个人的两份档案：这一份的本金、赠金转到目标会员，目标会员取两位里高的档阶；这一份停用、标「已合并」，历史单据留在原处。合并不能撤销。"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" icon={<Combine className="size-4" />} loading={busy} disabled={!ready || busy} onClick={submit} data-testid="member-merge-submit">
            确认合并
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        {!target ? (
          <Field label="合并到哪位会员" htmlFor="member-merge-search" hint="按手机号、姓名或会员号找">
            <Input id="member-merge-search" value={term} placeholder="至少 2 个字" onChange={(e) => setTerm(e.target.value)} data-autofocus data-testid="member-merge-search" />
          </Field>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-md bg-paper-2 px-3 py-2 text-[13px]">
            <span>
              合并到 <b className="text-ink">{target.name}</b> <span className="num text-ink-3">{target.memberNo} · {formatPhone(target.phone)}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => { setTarget(null); setConfirmed(false); }} disabled={busy}>
              换一位
            </Button>
          </div>
        )}
        {!target && debounced.length >= 2 && (
          <ul className="max-h-56 divide-y divide-line/70 overflow-y-auto rounded-md ring-1 ring-line" data-testid="member-merge-candidates">
            {search.isPending ? (
              <li className="p-3">
                <Skeleton className="h-8" />
              </li>
            ) : candidates.length === 0 ? (
              <li className="p-3 text-[13px] text-ink-3">没有找到别的会员</li>
            ) : (
              candidates.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] hover:bg-paper-2 disabled:opacity-50"
                    disabled={m.mergedIntoId !== null}
                    onClick={() => setTarget(m)}
                  >
                    <span>
                      <b className="text-ink">{m.name}</b> <span className="num text-ink-3">{m.memberNo} · {formatPhone(m.phone)}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      {m.mergedIntoId !== null && <Badge tone="neutral">已合并</Badge>}
                      {m.status === 'frozen' && m.mergedIntoId === null && <Badge tone="clay">已停用</Badge>}
                      <span className="num text-ink-3">{formatYuan(m.principalBalance + m.bonusBalance)}</span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
        {target && check.isPending && <Skeleton className="h-24" />}
        {target && check.error && <Notice tone="error" title={errorMessage(check.error)} />}
        {c && (
          <div className="grid gap-3" data-testid="member-merge-check">
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { title: '这一份（并走）', p: c.source },
                { title: '目标会员（留下）', p: c.target },
              ].map(({ title, p }) => (
                <div key={title} className="rounded-md px-3 py-2 text-[13px] ring-1 ring-line">
                  <p className="text-[12px] font-semibold text-ink-3">{title}</p>
                  <p className="mt-0.5 font-semibold text-ink">
                    {p.name} <span className="num font-normal text-ink-3">{p.memberNo}</span>
                  </p>
                  <p className="text-ink-3">
                    {p.grade} · 本金 {formatYuan(p.principal)} · 赠金 {formatYuan(p.bonus)}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-[13px] text-ink-2">
              转过去：本金 <b>{formatYuan(c.principal)}</b>、赠金 <b>{formatYuan(c.bonus)}</b>（到期的赠金先作废）。合并以后「{c.target.name}」是 <b>{c.gradeAfter}</b>
              {c.gradeChanged ? '（取这一份的档阶）' : '（档阶不变）'}。
            </p>
            {c.problems.length > 0 && (
              <Notice tone="warning" title="现在不能合并" data-testid="member-merge-problems">
                <ul className="list-disc pl-4">
                  {c.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>
        )}
        {c && c.problems.length === 0 && (
          <>
            <Field label="原因" htmlFor="member-merge-reason">
              <Textarea id="member-merge-reason" rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="member-merge-reason" />
            </Field>
            <ConfirmCheck checked={confirmed} onChange={setConfirmed} tone="clay">
              我已与顾客核对：这两份档案是同一个人，合并以后不能撤销
            </ConfirmCheck>
          </>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
