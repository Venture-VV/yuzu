// 后台「门店基本规则」里的交班方式（v0.7.28 ⑨，N11 待确认）：按人交班（默认，现在的做法）或按钱箱交班；钱箱清单。
//   · 切换不用等大家交班：开着的班照旧到交班为止，之后新开的按新做法；
//   · 钱箱编号保存后不变，不能删除，不用时停用（还开着班的钱箱停用后照样能交班，不能再新开）。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { MAX_CASH_DRAWERS, SHIFT_MODE_LABELS, type CashDrawer, type ShiftMode } from '@shared/checkout';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettings } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';

type DraftDrawer = Omit<CashDrawer, 'key'> & { key: string | null };

export function ShiftModeCard() {
  const settings = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<ShiftMode | null>(null);
  const [drawers, setDrawers] = useState<DraftDrawer[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings.data && mode === null) {
    setMode(settings.data.shiftMode);
    setDrawers(settings.data.cashDrawers);
  }
  if (!mode || !drawers) return <Skeleton className="h-40" />;
  const dirty = mode !== settings.data?.shiftMode || JSON.stringify(drawers) !== JSON.stringify(settings.data?.cashDrawers ?? []);
  const set = (i: number, patch: Partial<DraftDrawer>) => setDrawers(drawers.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const problem = drawers.some((d) => !d.label.trim())
    ? '钱箱名称不能为空'
    : new Set(drawers.map((d) => d.label.trim())).size !== drawers.length
      ? '钱箱名称不能重复'
      : mode === 'drawer' && !drawers.some((d) => d.active)
        ? '按钱箱交班至少要有一个启用的钱箱'
        : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<{ shiftMode: ShiftMode; cashDrawers: CashDrawer[] }>('/api/settings', {
        shiftMode: mode,
        cashDrawers: drawers.map((d) => ({ ...d, label: d.label.trim() })),
      });
      setMode(next.shiftMode);
      setDrawers(next.cashDrawers);
      await qc.invalidateQueries({ queryKey: qk.settings });
      await qc.invalidateQueries({ queryKey: qk.session });
      await qc.invalidateQueries({ queryKey: ['shift'] });
      toast({ tone: 'success', title: `交班方式：${SHIFT_MODE_LABELS[next.shiftMode]}`, body: '之后新开的班按这个做法；开着的班照旧到交班为止。' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5" data-testid="shift-mode-card">
      <SectionTitle aside={<PendingBadge title="N11：按钱箱交班是可选的做法，默认仍按人交班（待店主确认）" />}>交班方式</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        按人交班：每人开自己的班、点自己的钱。按钱箱交班：开班时选钱箱，同一个钱箱的人「加入」同一个班次，收款都记进来；可以中途离开钱箱；交班时点这个钱箱的钱，交班表另列各人经办的结账与充值。切换不用等大家交班：开着的班照旧到交班为止，之后新开的按新做法。
      </p>
      <div className="mt-3">
        <Segmented
          ariaLabel="交班方式"
          value={mode}
          onChange={(v) => setMode(v as ShiftMode)}
          options={[
            { value: 'person', label: SHIFT_MODE_LABELS.person },
            { value: 'drawer', label: SHIFT_MODE_LABELS.drawer },
          ]}
        />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <p className="text-[13px] font-bold text-ink-2">钱箱</p>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus className="size-4" />}
          disabled={drawers.length >= MAX_CASH_DRAWERS}
          onClick={() => setDrawers([...drawers, { key: null, label: '', active: true }])}
          data-testid="drawer-add"
        >
          新增钱箱
        </Button>
      </div>
      <ul className="mt-2 divide-y divide-line/70 rounded-lg border border-line">
        {drawers.map((d, i) => (
          <li key={d.key ?? `new-${i}`} className={cn('flex flex-wrap items-center gap-2 px-3 py-2', !d.active && 'bg-paper-2/50')}>
            <span className="num w-8 text-[12px] text-ink-4">{d.key ?? '新'}</span>
            <Input
              value={d.label}
              maxLength={16}
              onChange={(e) => set(i, { label: e.target.value })}
              fullWidth={false}
              className={cn('h-9 w-44', !d.active && 'text-ink-3')}
              aria-label={`钱箱名称 ${i + 1}`}
              placeholder="如：2 号钱箱"
              data-testid={`drawer-label-${i}`}
            />
            <Segmented
              size="sm"
              ariaLabel={`钱箱「${d.label}」`}
              value={d.active ? 'on' : 'off'}
              onChange={(v) => set(i, { active: v === 'on' })}
              options={[
                { value: 'on', label: '启用' },
                { value: 'off', label: '停用' },
              ]}
            />
            {!d.key && <Badge tone="lake">未保存</Badge>}
            <span className="flex-1" />
            {!d.key && (
              <Button size="sm" variant="ghost" onClick={() => setDrawers(drawers.filter((_, j) => j !== i))}>
                移除
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-ink-3">钱箱不能删除，不用时停用；按人交班时用不到这个清单。</p>
      {(problem || error) && <Notice tone="error" title={problem ?? error!} className="mt-3" />}
      <div className="mt-3 flex justify-end">
        <Button variant="primary" loading={saving} disabled={!dirty || !!problem} onClick={() => void save()} data-testid="shift-mode-save">
          保存交班方式
        </Button>
      </div>
    </Card>
  );
}
