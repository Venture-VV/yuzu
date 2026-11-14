// 后台「渠道与标签」：会员标签（8.0.4 起替代原来的会员资料字段）、渠道来源。会员等级 v0.7.23 起归后台「会员规则」（会员体系 v2 的档级、阶位与会籍）。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { MAX_MEMBER_CHANNELS, type MemberChannel } from '@shared/members';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettings } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, IconButton, Input, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { MemberTagsCard } from './MemberTagsCard';

/** 「会员体系 → 渠道与标签」页签的内容（8.0.19 起三个分区合成一个，外框在 MembershipSection） */
export function MembersBody() {
  return (
    <div className="max-w-[1024px] space-y-5">
      <p className="text-[13px] text-ink-3">会员标签（客群分层）与渠道来源。改动只影响之后的建档与显示；档级、赠送比例与会籍在「会员规则」页签。</p>
      <ChannelsCard />
      <MemberTagsCard />
    </div>
  );
}

type DraftChannel = Omit<MemberChannel, 'key'> & { key: string | null };

/** 渠道来源：改名不影响已登记的会员；不能删除，不用时停用 */
function ChannelsCard() {
  const settings = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<DraftChannel[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings.data && !draft) setDraft(settings.data.memberChannels);
  if (!draft) return <Skeleton className="h-40" />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.data?.memberChannels ?? []);
  const set = (i: number, patch: Partial<DraftChannel>) => setDraft(draft.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...draft];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setDraft(next);
  };
  const problem = draft.some((c) => !c.label.trim())
    ? '渠道名称不能为空'
    : new Set(draft.map((c) => c.label.trim())).size !== draft.length
      ? '渠道名称不能重复'
      : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<{ memberChannels: MemberChannel[] }>('/api/settings', { memberChannels: draft.map((c) => ({ ...c, label: c.label.trim() })) });
      setDraft(next.memberChannels);
      await qc.invalidateQueries({ queryKey: qk.settings });
      await qc.invalidateQueries({ queryKey: qk.session });
      toast({ tone: 'success', title: '渠道来源已保存', body: '新建和编辑会员时按新的渠道选择。' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5" data-testid="channels-card">
      <SectionTitle
        aside={
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={draft.length >= MAX_MEMBER_CHANNELS} onClick={() => setDraft([...draft, { key: null, label: '', active: true }])}>
            新增渠道
          </Button>
        }
      >
        <span className="inline-flex items-center gap-2">
          渠道来源 <PendingBadge title="默认渠道是汤泉常见的获客来源，按门店实际改名、停用或新增" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">建档时选择会员从哪里来，会员总览按渠道统计新增。改名不影响已登记的会员；渠道不能删除，不用时停用（已登记的照常显示）。</p>
      <ul className="mt-4 divide-y divide-line/70 rounded-lg border border-line">
        {draft.map((c, i) => (
          <li key={c.key ?? `new-${i}`} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', !c.active && 'bg-paper-2/50')}>
            <span className="num w-8 text-[12px] text-ink-4">{c.key ?? '新'}</span>
            <Input
              value={c.label}
              maxLength={12}
              onChange={(e) => set(i, { label: e.target.value })}
              fullWidth={false}
              className={cn('h-9 w-44', !c.active && 'text-ink-3')}
              aria-label={`渠道名称 ${i + 1}`}
              placeholder="渠道名称"
              data-testid={`channel-label-${i}`}
            />
            <Segmented
              size="sm"
              ariaLabel={`渠道「${c.label}」`}
              value={c.active ? 'on' : 'off'}
              onChange={(v) => set(i, { active: v === 'on' })}
              options={[
                { value: 'on', label: '启用' },
                { value: 'off', label: '停用' },
              ]}
            />
            {!c.key && <Badge tone="lake">未保存</Badge>}
            <span className="flex-1" />
            <IconButton label="上移" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp className="size-4" />
            </IconButton>
            <IconButton label="下移" disabled={i === draft.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown className="size-4" />
            </IconButton>
            {!c.key && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
                移除
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {problem && <span className="text-[13px] text-clay">{problem}</span>}
        {dirty && !problem && <span className="text-[12.5px] text-ink-3">有未保存的修改</span>}
        <Button variant="primary" loading={saving} disabled={!dirty || !!problem} onClick={save} data-testid="channels-save">
          保存渠道
        </Button>
      </div>
    </Card>
  );
}
