// 后台「微信小程序」→「邀请好友」（小程序线第三期 3b，docs/MP_PHASE3.md 第 2 节；权限 mp.invite：店主、店总）：
//   · 开关（默认关），带版本号保存，结果待确认照其他开关；
//   · 最近 30 天发起的邀请各状态多少；最近 50 份邀请：谁发的、谁领的、体验到哪天。
// 邀请的规则（谁能邀请、每月几次、好友能体验什么、体验期满怎么办）照会员体系的「邀请体验」，在「会员体系」里看。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MP_INVITE_VALID_DAYS, type MpAdminData, type MpInviteAdminData, type MpInviteState } from '@shared/mp';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Card, Segmented, Skeleton } from '../../components/ui';
import { mpAdminKey, PendingUpdates, updateFailed } from './mpAdminShared';
import { sendUpdate, useMpPending } from './mpPending';

const inviteKey = ['mp', 'invites'] as const;

const STATE: Record<MpInviteState, { label: string; tone: 'neutral' | 'moss' | 'yuzu' | 'lake' }> = {
  open: { label: '待领取', tone: 'lake' },
  used: { label: '已领取', tone: 'moss' },
  revoked: { label: '已收回', tone: 'neutral' },
  expired: { label: '过期了', tone: 'neutral' },
};

export function InviteTab({ data }: { data: MpAdminData }) {
  const q = useQuery({ queryKey: inviteKey, queryFn: () => api.get<MpInviteAdminData>('/api/admin/mp/invites') });
  const pending = useMpPending('invite_rules_update');
  if (!q.data) return <Skeleton className="h-48" />;
  return (
    <div className="space-y-4">
      {pending.length > 0 && <PendingUpdates ops={pending} data={data} />}
      <Switch key={data.inviteRules.version} rules={data.inviteRules} pending={pending.length > 0} />
      <Recent d={q.data} />
    </div>
  );
}

function Switch({ rules, pending }: { rules: MpAdminData['inviteRules']; pending: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [saving, setSaving] = useState(false);
  const save = async (enabled: boolean) => {
    setSaving(true);
    try {
      await sendUpdate({
        type: 'invite_rules_update',
        url: '/api/admin/mp/invites/rules',
        target: 'invite_rules',
        body: { enabled, version: rules.version },
        summary: enabled ? '开通邀请好友' : '关闭邀请好友',
        staffName: session.staff.displayName,
      });
      await Promise.all([qc.invalidateQueries({ queryKey: mpAdminKey }), qc.invalidateQueries({ queryKey: inviteKey })]);
      toast({ tone: 'success', title: enabled ? '邀请好友已开通' : '邀请好友已关闭' });
    } catch (error) {
      updateFailed(toast, error);
      void qc.invalidateQueries({ queryKey: mpAdminKey });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="space-y-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-ink">邀请好友</p>
          <p className="text-[13px] text-ink-3">
            会员在小程序「我的 → 邀请好友」发邀请码、分享给微信好友（{MP_INVITE_VALID_DAYS} 天内有效，只能用一次）；好友打开、用微信手机号快速验证，
            就有「邀请体验」的临时身份，还不是会员的当场建档（渠道「老带新」）。发出去还没人领的占着本月的次数，收回、过期的退回。
          </p>
          {pending && <p className="text-[12.5px] text-ember">设置的修改结果待确认，先在上方处理</p>}
        </div>
        <Segmented
          value={rules.enabled ? 'on' : 'off'}
          ariaLabel="邀请好友开关"
          onChange={(v) => void save(v === 'on')}
          options={[
            { value: 'off', label: '关闭', disabled: pending || saving },
            { value: 'on', label: '开通', disabled: pending || saving },
          ]}
        />
      </div>
    </Card>
  );
}

function Recent({ d }: { d: MpInviteAdminData }) {
  return (
    <Card className="p-0">
      <div className="space-y-1 border-b border-line px-4 py-3">
        <p className="text-[15px] font-semibold text-ink">最近的邀请</p>
        <p className="num text-[13px] text-ink-3">
          最近 30 天：待领取 {d.stats.open} · 已领取 {d.stats.used} · 已收回 {d.stats.revoked} · 过期 {d.stats.expired}
        </p>
      </div>
      {d.recent.length === 0 ? (
        <p className="px-4 py-6 text-center text-[13px] text-ink-3">还没有邀请</p>
      ) : (
        <div className="divide-y divide-line">
          {d.recent.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13.5px]" data-testid="mp-invite">
              <span className="num text-ink-3">{formatDateTime(r.createdAt)}</span>
              <span className="font-semibold text-ink">{r.inviterName}</span>
              <span className="text-ink-3">邀请</span>
              <span>{r.inviteeName ?? '—'}</span>
              <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>
              {r.trial && (
                <span className="num text-ink-3">
                  {r.trial.label}，{r.trial.startsOn} 至 {r.trial.endsOn}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
