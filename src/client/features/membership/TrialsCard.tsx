// 会员详情「邀请体验 / 赠送会籍」（会员体系 v2 第三期，v0.7.25；docs/MEMBERSHIP_P3.md 第 3 节）：
//   · 这位会员生效中的临时身份（体验中的档阶、谁邀请的、到哪天；店主、店总可以撤销）；
//   · 发起：低一档邀请体验（L2 起、每月次数按会员规则）、赠送记名会籍（QY-042）——输入受邀人手机号，已有会员核对能不能接受，
//     还不是会员的当场建档；超时、断网、回复 500 时结果待确认，在卡片上方查回、按原内容重新提交或作废；
//   · 发起过的、收到过的（状态：体验中、体验到期、转正、已撤销）。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, UserPlus } from 'lucide-react';
import {
  GIFT_BENEFIT_CODE,
  TRIAL_KIND_LABELS,
  TRIAL_STATUS_LABELS,
  type MemberTrials,
  type TrialKind,
  type TrialOptions,
  type TrialRow,
} from '@shared/trials';
import type { MemberDetail } from '@shared/types';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending, type ErpPendingOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { benefitKeys, membershipKeys, trialKeys } from './queries';

/** 这位会员发起的临时身份（提交地址带邀请人的会员编号） */
const trialUrl = (memberId: number) => `/api/members/${memberId}/trials`;

const STATUS_TONES = { active: 'yuzu', expired: 'neutral', converted: 'moss', cancelled: 'clay' } as const;

const phoneOk = (s: string) => /^1\d{10}$/.test(s.replace(/[\s-]/g, ''));

export function TrialsCard({ member }: { member: MemberDetail }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const trials = useQuery({ queryKey: trialKeys.member(member.id), queryFn: () => api.get<MemberTrials>(`/api/members/${member.id}/trials`) });
  const canStart = can('benefit.use');
  const options = useQuery({
    queryKey: trialKeys.options(member.id, ''),
    queryFn: () => api.get<TrialOptions>(`/api/members/${member.id}/trial-options`),
    enabled: canStart,
  });
  const [starting, setStarting] = useState<TrialKind | null>(null);
  const [cancelling, setCancelling] = useState<TrialRow | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const ofMember = (op: ErpPendingOp) => op.url === trialUrl(member.id);
  const pending = useErpPending(['member_trial']).filter(ofMember);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['member', member.id] }),
      qc.invalidateQueries({ queryKey: benefitKeys.member(member.id) }),
      qc.invalidateQueries({ queryKey: membershipKeys.overview }),
      qc.invalidateQueries({ queryKey: ['membership', 'trials'] }),
    ]);
  if (trials.isPending) return <Skeleton className="h-32" />;
  if (trials.error || !trials.data) return <Notice tone="error" title={trials.error?.message ?? '邀请体验没有加载出来'} />;
  const d = trials.data;
  const o = options.data;
  const history = d.received.filter((t) => t.id !== d.active?.id);
  const cancel = async (reason: string) => {
    if (!cancelling) return;
    setCancelBusy(true);
    try {
      await api.post(`/api/member-trials/${cancelling.id}/cancel`, { reason });
      toast({
        tone: 'success',
        title: '已撤销',
        body: `${cancelling.memberName}的${TRIAL_KIND_LABELS[cancelling.kind]}${cancelling.kind === 'gift' ? '，那次 QY-042 的使用登记一并作废' : ''}`,
      });
      setCancelling(null);
      await refresh();
      await qc.invalidateQueries({ queryKey: ['member', cancelling.inviterId] });
      await qc.invalidateQueries({ queryKey: ['member', cancelling.memberId] });
    } catch (e) {
      toast({ tone: 'error', title: '没有撤销', body: errorMessage(e) });
    } finally {
      setCancelBusy(false);
    }
  };
  const startButton = (kind: TrialKind) => {
    const opt = o?.[kind];
    const reason = pending.length > 0 ? '上一次发起结果待确认，请先在上方查回、按原内容重新提交或作废' : (opt?.reason ?? undefined);
    return (
      <Button
        size="sm"
        variant="secondary"
        icon={kind === 'invite' ? <UserPlus className="size-3.5" /> : <Gift className="size-3.5" />}
        disabled={!opt?.allowed || pending.length > 0 || member.status !== 'active'}
        title={reason}
        onClick={() => setStarting(kind)}
        data-testid={`trial-${kind}-open`}
      >
        {TRIAL_KIND_LABELS[kind]}
      </Button>
    );
  };
  return (
    <Card className="p-5" data-testid="member-trials">
      <SectionTitle
        aside={
          <span className="flex items-center gap-2">
            <PendingBadge title="M51–M56：L2 起每月邀请 1 位体验低一档 7 天；QY-042 赠送低一档 1 个月；只享服务、折扣与 VIP 柜（待店主确认）" />
            {canStart && startButton('invite')}
            {canStart && startButton('gift')}
          </span>
        }
      >
        <span className="flex items-center gap-2">
          <UserPlus className="size-4 text-yuzu-deep" /> 邀请体验 / 赠送会籍
        </span>
      </SectionTitle>
      {canStart && <ErpPendingPanel types={['member_trial']} filter={ofMember} className="mt-3 space-y-2" onFound={() => void refresh()} />}

      {d.active ? (
        <Notice
          tone="info"
          className="mt-3"
          title={`体验中：${d.active.label}（${d.active.startsOn} 至 ${d.active.endsOn}）`}
          data-testid="trial-active"
        >
          {d.active.inviterName}的{TRIAL_KIND_LABELS[d.active.kind]}。只享服务类、结账会员折扣与 VIP 柜（按体验的与自己的取高的），不发券、不进升档保级；自己充值到 L
          {d.active.grade} 或更高时自动转正。
          {can('benefit.publish') && (
            <Button size="sm" variant="ghost" className="ml-2" onClick={() => setCancelling(d.active)} data-testid={`trial-cancel-${d.active.id}`}>
              撤销
            </Button>
          )}
        </Notice>
      ) : (
        <p className="mt-3 text-[13px] text-ink-3">没有生效中的临时身份。</p>
      )}

      {canStart && o && (
        <p className="mt-2 text-[12.5px] text-ink-3" data-testid="trial-quota">
          自己是「{o.own.label}」：邀请体验本月 {o.invite.used} / {o.invite.limit ?? 0} 次
          {o.invite.allowed ? `（给对方 ${o.invite.label}，到 ${o.invite.endsOn}）` : `（${o.invite.reason}）`}；赠送会籍
          {o.gift.limit === null ? ` 本月 ${o.gift.used} 次` : ` ${o.gift.limitText} ${o.gift.used} / ${o.gift.limit} 次`}
          {o.gift.allowed ? `（给对方 ${o.gift.label}，到 ${o.gift.endsOn}）` : `（${o.gift.reason}）`}
        </p>
      )}

      {d.sent.length > 0 && <TrialList title="发起过的" rows={d.sent} who="member" onCancel={can('benefit.publish') ? setCancelling : undefined} testId="trial-sent" />}
      {history.length > 0 && <TrialList title="收到过的" rows={history} who="inviter" testId="trial-received" />}

      {starting && <TrialDialog member={member} initial={starting} onClose={() => setStarting(null)} onDone={() => void refresh()} />}
      <ReasonDialog
        open={!!cancelling}
        title={cancelling ? `撤销${TRIAL_KIND_LABELS[cancelling.kind]}` : '撤销'}
        description={
          cancelling
            ? `${cancelling.memberName}：${cancelling.label}，${cancelling.startsOn} 至 ${cancelling.endsOn}（${cancelling.inviterName}发起）。${
                cancelling.kind === 'gift' ? `一并作废那次 ${GIFT_BENEFIT_CODE} 的使用登记，次数腾出来。` : '邀请体验的每月次数不退。'
              }撤销的不算「12 个月内一次」。`
            : undefined
        }
        confirmLabel="撤销"
        danger
        busy={cancelBusy}
        testId="trial-cancel"
        onClose={() => setCancelling(null)}
        onConfirm={(reason) => void cancel(reason)}
      />
    </Card>
  );
}

function TrialList({
  title,
  rows,
  who,
  onCancel,
  testId,
}: {
  title: string;
  rows: TrialRow[];
  who: 'member' | 'inviter';
  onCancel?: (t: TrialRow) => void;
  testId: string;
}) {
  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-[12.5px] font-bold text-ink-2">{title}</p>
      <ul className="mt-1.5 space-y-1.5 text-[13px]" data-testid={testId}>
        {rows.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={STATUS_TONES[t.status]}>{TRIAL_STATUS_LABELS[t.status]}</Badge>
            <span className="font-semibold text-ink">{who === 'member' ? `${t.memberName}（${t.memberNo}）` : `${t.inviterName}（${t.inviterNo}）`}</span>
            <span className="text-ink-2">
              {TRIAL_KIND_LABELS[t.kind]} · {t.label}
            </span>
            <span className={cn('num text-ink-3')}>
              {t.startsOn} 至 {t.endsOn}
              {t.endedOn && t.status !== 'active' && ` · ${t.endedOn} 结束`}
            </span>
            {t.endReason && <span className="text-ink-3">· {t.endReason}</span>}
            {onCancel && t.status === 'active' && (
              <Button size="sm" variant="ghost" onClick={() => onCancel(t)} data-testid={`trial-cancel-${t.id}`}>
                撤销
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 发起：先把编号和原请求存在本机（存不了就不发）；超时、断网、回复 500 时结果待确认，在卡片上方查回、重提或作废 */
function TrialDialog({ member, initial, onClose, onDone }: { member: MemberDetail; initial: TrialKind; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const session = useSession();
  const qc = useQueryClient();
  const channels = (session.rules.memberChannels ?? []).filter((c) => c.active);
  const defaultChannel = channels.find((c) => c.label === '老带新')?.key ?? '';
  const [kind, setKind] = useState<TrialKind>(initial);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [channel, setChannel] = useState(defaultChannel);
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(true, () => {
    setKey(uuid());
    setError(null);
  });
  const digits = phone.replace(/[\s-]/g, '');
  const check = useQuery({
    queryKey: trialKeys.options(member.id, digits),
    queryFn: () => api.get<TrialOptions>(`/api/members/${member.id}/trial-options?phone=${digits}`),
    enabled: phoneOk(digits),
  });
  const o = phoneOk(digits) ? check.data : undefined;
  const opt = o?.[kind];
  const invitee = o?.invitee ?? null;
  const problem = invitee ? invitee.problems[kind] : null;
  const needName = invitee !== null && !invitee.exists;
  const ok = !!opt?.allowed && !!invitee && !problem && (!needName || name.trim().length > 0);
  const submit = async () => {
    if (!opt || !invitee) return;
    setBusy(true);
    setError(null);
    const who = invitee.exists ? invitee.name : name.trim();
    try {
      await sendErpOp({
        key,
        type: 'member_trial',
        url: trialUrl(member.id),
        body: { clientKey: key, kind, phone: digits, ...(invitee.exists ? {} : { name: name.trim(), channel: channel || null }) },
        summary: `${member.name}${TRIAL_KIND_LABELS[kind]}给${who}（${opt.label}）`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: `已${TRIAL_KIND_LABELS[kind]}`, body: `${who}：${opt.label}，到 ${opt.endsOn}` });
      await qc.invalidateQueries({ queryKey: ['member'] });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '发起结果待确认', body: '已记在本机：请在「邀请体验 / 赠送会籍」上方查回、按原内容重新提交或作废，不要另起一笔。' });
        onDone();
        onClose();
        return;
      }
      setError(errorMessage(e));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${member.name}：邀请体验 / 赠送会籍`}
      description="给对方「自己的档级 − 1」的初阶，只享服务类、结账会员折扣与 VIP 柜；不发券、不进升档保级。受邀人 12 个月内只能被邀请或赠送一次。"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!ok || busy} data-testid="trial-submit">
            确认{TRIAL_KIND_LABELS[kind]}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <Segmented
          value={kind}
          onChange={setKind}
          ariaLabel="方式"
          options={[
            { value: 'invite', label: TRIAL_KIND_LABELS.invite },
            { value: 'gift', label: `${TRIAL_KIND_LABELS.gift}（${GIFT_BENEFIT_CODE}）` },
          ]}
        />
        <Field label="受邀人手机号" htmlFor="trial-phone" hint="已有会员按手机号找；还不是会员的当场建档">
          <Input id="trial-phone" inputMode="tel" value={phone} maxLength={13} onChange={(e) => setPhone(e.target.value)} data-testid="trial-phone" />
        </Field>
        {phoneOk(digits) && check.isPending && <Skeleton className="h-10" />}
        {check.error && phoneOk(digits) && <Notice tone="error" title={errorMessage(check.error)} />}
        {opt && !opt.allowed && <Notice tone="warning" title={`现在不能${TRIAL_KIND_LABELS[kind]}`}>{opt.reason}</Notice>}
        {opt?.allowed && invitee?.exists && (
          <Notice tone={problem ? 'warning' : 'info'} title={`${invitee.name}（${invitee.memberNo}）· 现在是 ${invitee.label}`} data-testid="trial-invitee">
            {problem ?? `给对方 ${opt.label}，${o!.today} 至 ${opt.endsOn}。`}
          </Notice>
        )}
        {opt?.allowed && needName && (
          <>
            <Notice tone="info" title="还不是会员：当场建档" data-testid="trial-invitee">
              L0、没有余额，只问姓名与手机号（其余资料之后编辑会员时补），与建档页一样发开卡礼。给对方 {opt.label}，{o!.today} 至 {opt.endsOn}。
            </Notice>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="姓名" htmlFor="trial-name">
                <Input id="trial-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} data-testid="trial-name" />
              </Field>
              <Field label="渠道来源" htmlFor="trial-channel">
                <Select id="trial-channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="">不登记</option>
                  {channels.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </>
        )}
        {opt?.allowed && (
          <p className="text-[12.5px] text-ink-3">
            {kind === 'invite'
              ? `本月已邀请 ${opt.used} / ${opt.limit ?? 0} 次（撤销的不退）。`
              : `${GIFT_BENEFIT_CODE} ${opt.limit === null ? `不限次数，本月登记 ${opt.used} 次` : `${opt.limitText}已用 ${opt.used} / ${opt.limit} 次`}：赠送一次登记一次使用，撤销时一并作废。`}
          </p>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
