import { useState } from 'react';
import { useAudit } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { DateNav } from '../../components/DateNav';
import { EmptyState } from '../../components/EmptyState';
import { Badge, Card, Skeleton } from '../../components/ui';

const ACTION_LABELS: Record<string, { label: string; tone: 'neutral' | 'pine' | 'clay' | 'lake' | 'yuzu' | 'ember' }> = {
  login: { label: '登录', tone: 'neutral' },
  login_failed: { label: '登录失败', tone: 'clay' },
  auth_granted: { label: '当场授权', tone: 'ember' },
  auth_failed: { label: '授权失败', tone: 'clay' },
  logout: { label: '退出', tone: 'neutral' },
  password_changed: { label: '修改密码', tone: 'neutral' },
  staff_created: { label: '添加员工', tone: 'pine' },
  staff_updated: { label: '修改员工', tone: 'pine' },
  staff_password_reset: { label: '重置密码', tone: 'ember' },
  member_created: { label: '新建会员', tone: 'lake' },
  member_updated: { label: '修改会员', tone: 'lake' },
  recharge_created: { label: '充值', tone: 'lake' },
  consumption_created: { label: '消费', tone: 'yuzu' },
  consumption_reversed: { label: '撤销', tone: 'clay' },
  consume_rejected: { label: '余额不足', tone: 'yuzu' },
  duplicate_blocked: { label: '重复提交', tone: 'ember' },
  operation_abandoned: { label: '作废待确认记账', tone: 'ember' },
  settlement_closed: { label: '确认日结', tone: 'pine' },
  settings_updated: { label: '修改规则', tone: 'ember' },
  plan_saved: { label: '保存套餐', tone: 'neutral' },
  item_saved: { label: '保存项目', tone: 'neutral' },
  export: { label: '导出', tone: 'neutral' },
  frontdesk_checkin: { label: '接待发牌', tone: 'pine' },
  frontdesk_swap: { label: '换牌', tone: 'lake' },
  frontdesk_group: { label: '同行绑牌', tone: 'lake' },
  frontdesk_cancel: { label: '撤销来访', tone: 'clay' },
  frontdesk_post: { label: '手牌挂账', tone: 'yuzu' },
  frontdesk_void: { label: '作废明细', tone: 'clay' },
  frontdesk_abandon: { label: '作废待确认操作', tone: 'ember' },
  hand_tags_created: { label: '建手牌', tone: 'neutral' },
  hand_tags_imported: { label: '导入柜号清单', tone: 'ember' },
  hand_tag_locked: { label: '锁定手牌', tone: 'ember' },
  hand_tag_unlocked: { label: '解锁手牌', tone: 'neutral' },
  hand_tag_updated: { label: '修改手牌', tone: 'neutral' },
};

function describe(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof detail.docNo === 'string') parts.push(detail.docNo);
  if (typeof detail.visitNo === 'string') parts.push(detail.visitNo);
  if (Array.isArray(detail.tags)) parts.push(`手牌 ${detail.tags.join('、')}`);
  if (typeof detail.from === 'string' && typeof detail.to === 'string') parts.push(`${detail.from} → ${detail.to}`);
  if (typeof detail.code === 'string') parts.push(`手牌 ${detail.code}`);
  if (typeof detail.username === 'string') parts.push(`账号 ${detail.username}`);
  // 当场授权：授权人与授权的柜
  if (typeof detail.approverName === 'string') parts.push(`授权人 ${detail.approverName}`);
  const scope = detail.scope as { tags?: { code: string }[] } | undefined;
  if (Array.isArray(scope?.tags)) parts.push(`VIP 柜 ${scope.tags.map((t) => t.code).join('、')}`);
  const vip = detail.vipOverride as { approverName?: string } | undefined;
  if (vip?.approverName) parts.push(`VIP 柜由${vip.approverName}当场授权`);
  if (typeof detail.lostFee === 'number') parts.push(`丢牌赔偿 ¥${(detail.lostFee / 100).toFixed(2)}`);
  if (typeof detail.total === 'number' && typeof detail.created === 'number') {
    parts.push(`清单 ${detail.total} 个：新建 ${detail.created} · 更新 ${detail.updated ?? 0} · 停用 ${detail.deactivated ?? 0}`);
  }
  if (typeof detail.name === 'string') parts.push(detail.name);
  if (typeof detail.reason === 'string') parts.push(detail.reason);
  if (typeof detail.note === 'string' && detail.note) parts.push(detail.note);
  if (typeof detail.summary === 'string' && detail.summary) parts.push(detail.summary);
  if (detail.via === 'cli') parts.push('命令行');
  return parts.join(' · ');
}

/** 操作审计：按自然日查看登录、余额操作、配置变更 */
export function AuditTab() {
  const session = useSession();
  const [date, setDate] = useState(session.today);
  const audit = useAudit(date);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DateNav value={date} today={session.today} onChange={setDate} />
        <p className="text-[12.5px] text-ink-3">审计记录只追加、不可修改，按自然日显示最近 200 条。</p>
      </div>
      <Card>
        {audit.isPending ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : (audit.data ?? []).length === 0 ? (
          <EmptyState art="calm" title="这一天没有操作记录" />
        ) : (
          <ul className="divide-y divide-line/70">
            {audit.data!.map((a) => {
              const meta = ACTION_LABELS[a.action] ?? { label: a.action, tone: 'neutral' as const };
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                  <span className="num w-24 shrink-0 text-ink-3">{formatDateTime(a.createdAt)}</span>
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <span className="font-semibold">{a.staffName ?? '系统'}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-2">{describe(a.detail)}</span>
                  {a.ip && <span className="num text-[11.5px] text-ink-4">{a.ip}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
