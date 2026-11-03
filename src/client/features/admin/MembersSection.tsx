// 后台「会员与渠道」：会员资料字段、渠道来源、会员等级（口径、门槛、名称）。

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { levelOf, MAX_VIP_LEVEL, VIP_LEVEL_BASES, VIP_LEVEL_BASIS_LABELS, type FrontdeskRules, type VipLevelBasis } from '@shared/frontdesk';
import { LEVEL_VALIDITY, levelName, MAX_LEVEL_NAME_LENGTH, MAX_MEMBER_CHANNELS, type MemberChannel } from '@shared/members';
import { formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettings } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, IconButton, Input, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { AdminPage } from './AdminShell';
import { MemberFieldsCard } from './MemberFieldsCard';

export function MembersSection() {
  return (
    <AdminPage section="members" description="会员资料要登记哪些内容、从哪些渠道来、按什么口径分等级。改动只影响之后的建档与显示。">
      <div className="space-y-5">
        <ChannelsCard />
        <LevelsCard />
        <MemberFieldsCard />
      </div>
    </AdminPage>
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

const yuan = (cents: number) => String(cents / 100);

/** 会员等级：口径、各级门槛与名称（VIP 柜也按它核对） */
function LevelsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['frontdesk', 'rules'], queryFn: () => api.get<FrontdeskRules>('/api/frontdesk/rules') });
  const [basis, setBasis] = useState<VipLevelBasis>('recharge');
  const [levels, setLevels] = useState<{ threshold: string; name: string }[]>([]);
  const [sample, setSample] = useState('20000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!rules.data) return;
    setBasis(rules.data.vipLevelBasis);
    setLevels(rules.data.vipLevelThresholds.map((t, i) => ({ threshold: yuan(t), name: rules.data!.vipLevelNames[i] ?? '' })));
  }, [rules.data]);
  if (!rules.data) return <Skeleton className="h-56" />;

  // 金额按整数分解析（不用浮点数，v0.7.22）；填得不对的为 null
  const parsed = levels.map((l) => parseYuan(l.threshold));
  const cents = parsed.map((c) => c ?? 0);
  const names = levels.map((l) => l.name.trim());
  const problem = parsed.some((c) => c === null)
    ? '各级门槛请填金额（元）'
    : cents.some((c, i) => i > 0 && c <= cents[i - 1]!)
      ? '各级门槛必须逐级递增'
      : names.some((n) => n.length > MAX_LEVEL_NAME_LENGTH)
        ? `等级名称最多 ${MAX_LEVEL_NAME_LENGTH} 个字`
        : new Set(names.filter(Boolean)).size !== names.filter(Boolean).length
          ? '各级名称不能重复'
          : null;
  const dirty =
    basis !== rules.data.vipLevelBasis ||
    JSON.stringify(cents) !== JSON.stringify(rules.data.vipLevelThresholds) ||
    JSON.stringify(names) !== JSON.stringify(rules.data.vipLevelThresholds.map((_, i) => (rules.data!.vipLevelNames[i] ?? '').trim()));
  const sampleCents = parseYuan(sample);
  const sampleLevel = !problem && sampleCents !== null ? levelOf(sampleCents, cents) : null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/frontdesk/rules', { vipLevelBasis: basis, vipLevelThresholds: cents, vipLevelNames: names });
      await qc.invalidateQueries({ queryKey: ['frontdesk', 'rules'] });
      toast({ tone: 'success', title: '会员等级已保存', body: '会员详情、会员总览与 VIP 柜核对都按新的等级。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5" data-testid="levels-card">
      <SectionTitle aside={<PendingBadge title="等级口径、各级门槛与名称是默认做法，待店主确认" />}>会员等级</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        会员详情显示当前等级、升级时间与「再充多少到下一级」；VIP 柜按同一等级核对（会员等级不低于柜子等级才能使用）。散客为 0 级。
      </p>
      <Field label="等级口径" className="mt-4" hint={LEVEL_VALIDITY[basis]}>
        <Segmented ariaLabel="等级口径" value={basis} onChange={setBasis} options={VIP_LEVEL_BASES.map((b) => ({ value: b, label: VIP_LEVEL_BASIS_LABELS[b] }))} />
      </Field>
      <div className="mt-4 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[480px] text-[13px]">
          <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
            <tr>
              <th className="w-20 px-3 py-2 text-left">级别</th>
              <th className="px-3 py-2 text-left">门槛（{basis === 'recharge' ? '累计充值' : '余额'}达到，元）</th>
              <th className="px-3 py-2 text-left">名称</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {levels.map((l, i) => (
              <tr key={i}>
                <td className="px-3 py-2 font-semibold">第 {i + 1} 级</td>
                <td className="px-3 py-1.5">
                  <Input
                    value={l.threshold}
                    inputMode="decimal"
                    className="num h-9"
                    aria-label={`第 ${i + 1} 级门槛`}
                    onChange={(e) => setLevels(levels.map((x, j) => (j === i ? { ...x, threshold: e.target.value } : x)))}
                  />
                </td>
                <td className="px-3 py-1.5">
                  <Input
                    value={l.name}
                    maxLength={MAX_LEVEL_NAME_LENGTH}
                    placeholder={`第 ${i + 1} 级`}
                    className="h-9"
                    aria-label={`第 ${i + 1} 级名称`}
                    data-testid={`level-name-${i}`}
                    onChange={(e) => setLevels(levels.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" disabled={levels.length >= MAX_VIP_LEVEL} onClick={() => setLevels([...levels, { threshold: '', name: '' }])}>
          加一级
        </Button>
        <Button size="sm" variant="ghost" disabled={levels.length <= 1} onClick={() => setLevels(levels.slice(0, -1))}>
          减一级
        </Button>
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-[12.5px] text-ink-3">
          试算：{basis === 'recharge' ? '累计充值' : '余额'}
          <Input value={sample} onChange={(e) => setSample(e.target.value)} inputMode="decimal" fullWidth={false} className="num h-8 w-28" aria-label="试算金额" />
          元 →
          <b className="text-ink">{sampleLevel === null ? '—' : `${levelName(sampleLevel, names)}${sampleLevel ? `（第 ${sampleLevel} 级）` : ''}`}</b>
        </label>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {problem && <span className="text-[13px] text-clay">{problem}</span>}
        {!problem && (
          <span className="text-[12.5px] text-ink-3">
            {cents.length} 级，第 1 级 ≥ {formatYuan(cents[0] ?? 0)}
          </span>
        )}
        <Button variant="primary" loading={busy} disabled={!dirty || !!problem} onClick={save} data-testid="levels-save">
          保存会员等级
        </Button>
      </div>
    </Card>
  );
}
